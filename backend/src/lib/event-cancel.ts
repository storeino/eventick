import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { refundOrder } from "./refund.js";
import { grantCredit } from "./credit.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";

/**
 * Calling an event off.
 *
 * `EventStatus.CANCELLED` existed in the schema from the start and NO route
 * ever set it, so an organiser cancelling a festival had to refund buyers one
 * order at a time. That is the most stressful hour in ticketing and the
 * product had no answer for it.
 *
 * The shape of this deliberately mirrors what actually happens on the day:
 *
 *  - Take the event off sale FIRST, in its own write. Everything after this is
 *    slow (refunds, email), and leaving tickets buyable while the refunds run
 *    would sell seats to an event that no longer exists.
 *  - Refund every paid order, one at a time, through the ordinary refundOrder
 *    path. Not a bulk UPDATE: each refund has to void its tickets, record its
 *    own reference and respect the compare-and-swap that stops a buyer being
 *    paid twice — reimplementing that in a loop is how a mass refund becomes a
 *    mass double-refund.
 *  - Keep going when one fails. A single bad order must not leave the other
 *    four hundred buyers unrefunded; the failures are returned so someone can
 *    finish them by hand.
 */

export interface CancelResult {
  eventId: string;
  slug: string;
  /** Orders refunded successfully. */
  refunded: number;
  /** Total returned to buyers, in cents. */
  refundedCents: number;
  /** Orders converted to store credit. */
  credited: number;
  /** Total credit granted, in cents. */
  creditedCents: number;
  /** Paid orders with no account to credit — a guest checkout. These still
   *  need a bank reversal, because there is no balance to put anything on. */
  guestOrders: number;
  /** Orders that could not be refunded, with the reason. */
  failed: { orderId: string; reason: string }[];
  /** Tickets voided, including comps — nobody gets in to a cancelled event. */
  ticketsVoided: number;
  /** Buyers we attempted to notify. */
  notified: number;
}

export async function cancelEvent(
  eventId: string,
  reason: string,
  options: { notify?: boolean } = {},
): Promise<CancelResult> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, slug: true, titleFr: true, status: true, cancelledAt: true, startAt: true },
  });
  if (!event) throw new HttpError(404, "Event not found");
  /*
   * Keyed on `cancelledAt`, not on the status.
   *
   * `status === "CANCELLED"` looked equivalent and was not: hiding an
   * already-cancelled event moves its status to HIDDEN, and this guard then
   * let it be cancelled a SECOND time — refunding buyers who had already
   * been refunded once. `cancelledAt` is set once and never cleared, so it
   * is the fact that actually answers "has this been called off".
   *
   * Same mistake as the visibility route, which wrote PUBLISHED over
   * CANCELLED and put a dead event back on sale. Cancellation is a thing
   * that happened, not a display state.
   */
  if (event.cancelledAt) throw new HttpError(409, "This event is already cancelled");
  if (!reason.trim()) {
    // Required, not optional: "why was my festival cancelled" is the first
    // thing every buyer asks, and a status alone cannot answer it.
    throw new HttpError(400, "A reason is required — buyers are told what it says");
  }

  // Off sale first. Everything below is slow, and a buyer must not be able to
  // purchase a seat for an event that is being cancelled around them.
  await prisma.event.update({
    where: { id: event.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() },
  });
  logger.warn({ eventId: event.id, slug: event.slug, reason }, "event cancelled — refunding buyers");

  // Release live holds so nobody is mid-checkout for a dead event.
  await prisma.order.updateMany({
    where: { eventId: event.id, status: "PENDING" },
    data: { status: "CANCELLED", holdUntil: null },
  });

  /*
   * Orders with money to give back.
   *
   * Comps are excluded: an invitation is PAID with totalCents 0, so
   * refundOrder correctly refuses it ("already fully refunded") — and that
   * refusal then landed in the organiser's failure list as if something had
   * gone wrong, on the one screen where a false alarm is least welcome. Their
   * tickets are still voided below, which is what matters.
   */
  const paid = await prisma.order.findMany({
    where: { eventId: event.id, status: "PAID", totalCents: { gt: 0 } },
    select: {
      id: true,
      totalCents: true,
      refundedCents: true,
      email: true,
      holderName: true,
      /* Who to credit. A guest order has no account, so there is no balance
         to put credit on — those fall back to the bank-reversal queue, which
         is the only thing that can reach someone without an account. */
      customerId: true,
    },
  });

  const result: CancelResult = {
    eventId: event.id,
    slug: event.slug,
    refunded: 0,
    refundedCents: 0,
    credited: 0,
    creditedCents: 0,
    guestOrders: 0,
    failed: [],
    ticketsVoided: 0,
    notified: 0,
  };

  for (const order of paid) {
    try {
      // Null = whatever is still outstanding, so a partially refunded order
      // gets the remainder rather than being refunded twice.
      const refund = await refundOrder(order.id, null);
      result.refunded += 1;
      const movedCents = refund.refundedCents - order.refundedCents;
      result.refundedCents += movedCents;

      /*
       * Convert the refund to store credit.
       *
       * refundOrder has recorded the DECISION and voided the tickets, but it
       * cannot move money — CMI has no refund API, so a bank reversal waits
       * on somebody working the back office by hand. Credit does not: it is
       * spendable the moment this row lands, which is the entire reason it
       * exists.
       *
       * The grant is keyed (orderId, EVENT_CANCELLED) by a unique index, so
       * re-running a cancellation that failed halfway cannot double anyone's
       * balance.
       *
       * A guest order has no account and so no balance. Counted rather than
       * failed: the order is still in the bank-reversal queue, which is the
       * only way to reach a buyer with no account, and reporting it as an
       * error on the cancellation screen would be a false alarm.
       */
      if (order.customerId) {
        const granted = await grantCredit({
          userId: order.customerId,
          amountCents: movedCents > 0 ? movedCents : order.totalCents,
          reason: "EVENT_CANCELLED",
          label: `Annulation — ${event.titleFr}`,
          orderId: order.id,
        });
        if (granted) {
          result.credited += 1;
          result.creditedCents += granted.amountCents;
        }
      } else {
        result.guestOrders += 1;
      }
    } catch (err) {
      // One bad order must not strand the rest. Collected so somebody can
      // finish these by hand rather than discovering them from complaints.
      const reasonText = err instanceof Error ? err.message : String(err);
      result.failed.push({ orderId: order.id, reason: reasonText });
      logger.error({ err, orderId: order.id }, "mass refund failed for this order");
    }
  }

  /*
   * Void every remaining ticket, including comps.
   *
   * refundOrder already cancels the tickets on each order it refunds, so this
   * catches what it could not: comp tickets, which were never paid for and so
   * never appear in a refund, and anything on an order whose refund failed.
   * The event is not happening — nobody should be admitted, whatever they
   * paid or did not pay.
   */
  const voided = await prisma.ticket.updateMany({
    where: {
      tier: { eventId: event.id },
      status: { in: ["VALID", "USED"] },
    },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  result.ticketsVoided = voided.count;

  // Close out the waitlist: there is nothing left to offer anyone. EXPIRED
  // rather than a new status — the queue is over, and the enum already has a
  // word for "this entry will not be fulfilled".
  await prisma.waitlistEntry.updateMany({
    where: { eventId: event.id, status: { in: ["WAITING", "OFFERED"] } },
    data: { status: "EXPIRED" },
  });

  if (options.notify !== false) {
    // One address per buyer, not per order: somebody with four orders should
    // get one email, not four.
    const recipients = [...new Map(paid.map((o) => [o.email.toLowerCase(), o])).values()];
    for (const buyer of recipients) {
      // Credited buyers are told their balance is ready NOW; a guest is told
      // the money is coming back, because for them it still is a bank
      // reversal. Sending the credit wording to someone with no account
      // would point them at a balance screen they cannot reach.
      const credited = Boolean(buyer.customerId);
      // Fire-and-forget per buyer. A mail failure must not undo a refund that
      // already happened, and must not stop the next buyer being told.
      void sendEmail({
        to: buyer.email,
        subject: `Annulation — ${event.titleFr}`,
        html: cancelHtml(event.titleFr, buyer.holderName, reason.trim(), credited),
      }).catch((err) => logger.warn({ err, orderId: buyer.id }, "cancellation email failed"));
    }
    result.notified = recipients.length;
  }

  logger.warn(
    {
      eventId: event.id,
      refunded: result.refunded,
      refundedCents: result.refundedCents,
      credited: result.credited,
      creditedCents: result.creditedCents,
      guestOrders: result.guestOrders,
      failed: result.failed.length,
      ticketsVoided: result.ticketsVoided,
    },
    "event cancellation complete",
  );
  return result;
}

/**
 * Plain, short, and true about where the money went.
 *
 * The old wording promised "remboursé intégralement … sous quelques jours
 * ouvrés" to everyone. For a buyer with an account that is now wrong in the
 * buyer's favour: their credit is spendable immediately and no bank is
 * involved. For a guest it is still right, because a bank reversal is the
 * only thing that can reach someone with no balance.
 */
function cancelHtml(
  title: string,
  holderName: string,
  reason: string,
  credited: boolean,
): string {
  const money = credited
    ? `<p>Le montant que vous avez payé a été ajouté à votre <strong>solde Eventick</strong>. Il est disponible immédiatement et s'applique automatiquement à votre prochaine commande.</p>
    <p><a href="${escapeHtml(siteUrl())}/billets" style="color:#0B7A75;font-weight:600">Voir mon solde</a></p>`
    : `<p>Le montant que vous avez payé vous est remboursé intégralement. Selon votre banque, il peut apparaître sur votre compte sous quelques jours ouvrés.</p>`;
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">
    <h2 style="margin:0 0 12px">Annulation de ${escapeHtml(title)}</h2>
    <p>Bonjour ${escapeHtml(holderName)},</p>
    <p><strong>${escapeHtml(title)}</strong> a été annulé. Vos billets ne sont plus valables.</p>
    <p><strong>Motif :</strong> ${escapeHtml(reason)}</p>
    ${money}
    <p style="color:#5f5f6b;font-size:13px">Eventick.ma</p>
  </div>`;
}

/** Where the balance screen lives, for the link in the email. */
function siteUrl(): string {
  return process.env.SITE_URL?.replace(/\/+$/, "") || "https://eventick.ma";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
