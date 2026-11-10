import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { seatFor } from "../domain/inventory.js";
import { feeForOrder } from "../domain/commission.js";
import { makeTicketRef } from "../domain/ticketRef.js";
import { sendEmail } from "./email.js";
import { orderConfirmationHtml, orderConfirmationSubject } from "./email-templates.js";
import { renderTicketsPdf } from "./ticket-pdf.js";
import { logger } from "./logger.js";
import { emitToOrganiser } from "./realtime.js";
import type { Event, Order, Ticket, TicketTier } from "@prisma/client";

/**
 * The seats went while the buyer was at the gateway.
 *
 * Its own type because the caller has to tell it apart from an infrastructure
 * failure: this one means "do not take the money", whereas a dropped database
 * connection means "we do not know yet".
 */
export class OversoldError extends Error {
  constructor(
    readonly orderId: string,
    readonly tierId: string,
    readonly wanted: number,
    readonly available: number,
  ) {
    super(`Order ${orderId} wanted ${wanted} seat(s) of tier ${tierId}, only ${available} left`);
    this.name = "OversoldError";
  }
}

/** Prisma client or an open transaction — recordCommission works with either. */
type Db = Pick<typeof prisma, "order" | "user" | "plan">;

/**
 * Write the platform's commission onto an order, from the plan in force NOW.
 *
 * Shared because there are three ways an order becomes PAID — a direct sale
 * through settleOrder, a resale in mock mode, and a resale through the CMI
 * callback — and the first version recorded the fee only in the first. That
 * made every resale commission-free: the platform brokered the sale, moved
 * the seat, refunded the seller and earned nothing. Worse, the null fee was
 * then priced at the DEFAULT plan when Finance summed revenue, so a Pro
 * organiser's reported commission went UP after a resale, at a rate they
 * were not on.
 *
 * Idempotent: an order that already carries a fee is left alone, so a
 * replayed callback cannot re-price a sale against a plan that changed since.
 */
export async function recordCommission(db: Db, orderId: string): Promise<void> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, totalCents: true, feeCents: true, event: { select: { organiserId: true } } },
  });
  if (!order) return;
  // Already priced — see idempotence above.
  if (order.feeCents !== null) return;
  // A platform-owned event has no organiser to charge.
  if (!order.event.organiserId) return;

  const organiser = await db.user.findUnique({
    where: { id: order.event.organiserId },
    select: { plan: true },
  });
  // An organiser with no plan assigned still owes the default rate; "no plan,
  // no fee" would make unassigned organisers free, which is a billing hole
  // rather than a kindness.
  const plan = organiser?.plan ?? (await db.plan.findFirst({ where: { isDefault: true } }));
  if (!plan) return;

  await db.order.update({
    where: { id: order.id },
    data: { feeCents: feeForOrder(order.totalCents, plan), feePlanKey: plan.key },
  });
}

/**
 * Commission on a RESALE, which is a different charge from a first sale.
 *
 * recordCommission prices an order against the ORGANISER's plan, because a
 * first sale is the organiser selling a seat. A resale is not: it moves an
 * existing seat between two customers, and the organiser was already paid
 * when that seat was first sold. Charging their plan again bills them for a
 * transaction they receive nothing from — their reported commission used to
 * rise after a resale, at a rate they were not on.
 *
 * So this uses the PLATFORM's own resale rate, and feePlanKey records
 * "resale" rather than a plan the organiser is not being charged under.
 *
 * Idempotent on feeCents, exactly like recordCommission: a replayed webhook
 * must not re-price a sale against a rate that changed since.
 */
export async function recordResaleFee(
  db: Db,
  orderId: string,
  feeCents: number,
): Promise<void> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, feeCents: true },
  });
  if (!order) return;
  if (order.feeCents !== null) return;
  await db.order.update({
    where: { id: order.id },
    // "resale" rather than a plan key: nothing about an organiser's plan
    // produced this figure, and recording one would make the fee impossible
    // to explain later.
    data: { feeCents, feePlanKey: "resale" },
  });
}

/**
 * Settlement — the one place a successful payment turns into tickets.
 *
 * Both paths funnel through here so they can never drift: the CMI callback
 * (real mode) and the direct confirm (mock mode). IDEMPOTENT by necessity —
 * CMI retries a callback it considers unanswered, so applying the same outcome
 * twice must be a no-op rather than minting a second set of tickets.
 *
 * Returns `settled: false` for BOTH "already settled" and "could not settle".
 * Callers that decide whether to take the buyer's money must therefore look at
 * the order's real state rather than trust this flag — see routes/webhooks.ts.
 */
export async function settleOrder(orderId: string, payment: {
  paymentRef: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardBank?: string | null;
}): Promise<{ settled: boolean }> {
  const order = await prisma.$transaction(async (tx) => {
    // Guarded update: only a PENDING order becomes PAID. A replayed webhook
    // finds 0 rows and stops here instead of issuing duplicate tickets.
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "PENDING" },
      data: {
        status: "PAID",
        paymentRef: payment.paymentRef,
        cardBrand: payment.cardBrand ?? null,
        cardLast4: payment.cardLast4 ?? null,
        cardBank: payment.cardBank ?? null,
      },
    });
    if (claimed.count === 0) return null;

    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { include: { tier: true } }, event: true },
    });

    await recordCommission(tx, current.id);

    /*
     * Re-check capacity before issuing, not just at hold time.
     *
     * A hold reserves seats until `holdUntil`, and availability stops counting
     * it the moment that passes — but the order stays PENDING until the
     * sweeper runs, up to five minutes later. With Stripe that gap was
     * unreachable: the card was confirmed in-page, in seconds. CMI sends the
     * buyer away to its own hosted page, where finding a card and passing
     * 3-D Secure can easily outlast the hold, so a payment arriving in that
     * window would issue tickets against seats already resold to someone
     * else. Checking here covers every settlement path at once.
     */
    for (const line of current.lines) {
      const live = await tx.ticket.count({
        where: { tierId: line.tierId, status: { in: ["VALID", "USED"] } },
      });
      const otherHolds = await tx.orderLine.aggregate({
        where: {
          tierId: line.tierId,
          orderId: { not: current.id },
          order: { status: "PENDING", holdUntil: { gt: new Date() } },
        },
        _sum: { qty: true },
      });
      const free = line.tier.capacity - live - (otherHolds._sum.qty ?? 0);
      if (line.qty > free) {
        // Throwing rolls back the PAID flip with it, leaving the order PENDING
        // so the caller can refuse the payment rather than charge for a seat
        // that no longer exists.
        throw new OversoldError(current.id, line.tierId, line.qty, free);
      }
    }

    for (const line of current.lines) {
      // Seat cursor starts after everything already committed for this tier,
      // so numbered seats stay unique across orders.
      const committed = await tx.orderLine.aggregate({
        where: {
          tierId: line.tierId,
          order: { status: "PAID" },
          NOT: { orderId: current.id },
        },
        _sum: { qty: true },
      });
      const cursorStart = committed._sum.qty ?? 0;

      const rows: Prisma.TicketCreateManyInput[] = [];
      for (let i = 0; i < line.qty; i++) {
        const seat = line.tier.numbered ? seatFor(cursorStart + i + 1, line.tier.seatsPerRow) : null;
        rows.push({
          ref: makeTicketRef(current.event.startAt.getFullYear()),
          orderId: current.id,
          tierId: line.tierId,
          holderName: current.holderName,
          seatRow: seat?.row ?? null,
          seatNumber: seat?.seat ?? null,
        });
      }
      // createMany: one round-trip per line instead of one per ticket, which
      // matters for the "ticket within 30s" target on large orders.
      await tx.ticket.createMany({ data: rows });
    }

    if (current.promoCodeId) {
      await tx.promoCode.update({ where: { id: current.promoCodeId }, data: { uses: { increment: 1 } } });
    }

    return tx.order.findUniqueOrThrow({
      where: { id: current.id },
      include: { tickets: { include: { tier: true } }, event: true },
    });
  });

  if (!order) return { settled: false };

  emitToOrganiser(order.event.organiserId, {
    type: "order",
    eventSlug: order.event.slug,
    orderId: order.id,
    totalCents: order.totalCents,
    tickets: order.tickets.length,
    at: new Date().toISOString(),
  });

  void deliverTickets(order).catch((err) => logger.warn({ err }, "ticket delivery failed"));

  return { settled: true };
}

/** Render the PDF and email it. Never throws: the order is already paid, and
 * a mail or render failure must not undo that. */
async function deliverTickets(order: SettledOrder): Promise<void> {
  const input = buildEmailInput(order);
  let attachments;
  try {
    const pdf = await renderTicketsPdf(
      order.tickets.map((ticket) => ({
        ref: ticket.ref,
        holderName: ticket.holderName,
        eventSlug: order.event.slug,
        eventTitle: order.event.titleFr,
        venue: order.event.venueFr,
        city: order.event.city,
        startAt: order.event.startAt,
        tierName: ticket.tier.nameFr,
        zone: ticket.tier.zoneFr,
        gate: ticket.tier.gateFr,
        seatRow: ticket.seatRow,
        seatNumber: ticket.seatNumber,
        priceCents: ticket.tier.priceCents,
        orderId: order.id,
      })),
    );
    attachments = [{ filename: `eventick-${order.id}.pdf`, content: pdf }];
  } catch (err) {
    // Still send the confirmation without the attachment rather than nothing.
    logger.warn({ err, orderId: order.id }, "ticket PDF render failed — sending email without attachment");
  }

  await sendEmail({
    to: order.email,
    subject: orderConfirmationSubject(input),
    html: orderConfirmationHtml(input),
    attachments,
  });
}

type SettledOrder = Order & {
  tickets: (Ticket & { tier: TicketTier })[];
  event: Event;
};

function buildEmailInput(order: SettledOrder) {
  return {
    locale: "fr" as const,
    holderName: order.holderName,
    eventTitle: order.event.titleFr,
    eventCity: order.event.city,
    eventStart: order.event.startAt,
    orderId: order.id,
    totalCents: order.totalCents,
    tickets: order.tickets.map((ticket) => ({
      ref: ticket.ref,
      tierName: ticket.tier.nameFr,
      holderName: ticket.holderName,
      priceCents: ticket.tier.priceCents,
    })),
  };
}
