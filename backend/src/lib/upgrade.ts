import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { seatFor } from "../domain/inventory.js";
import { logger } from "./logger.js";

/**
 * Moving a ticket into a DEARER zone, which costs the difference.
 *
 * A downgrade is free and immediate (lib/ticket-admin.ts exchangeTicket): the
 * seat moves and the holder forfeits the difference. An upgrade cannot work
 * that way, because money has to arrive first — and CMI is a redirect
 * gateway, so the buyer is away on its hosted page for as long as it takes
 * them to find their card and pass 3-D Secure.
 *
 * That gap is the whole problem this module exists to solve. Three things
 * must hold across it:
 *
 *   1. The target seat must be RESERVED while they are away, or the last
 *      Fosse seat sells meanwhile and we have taken money for a seat that no
 *      longer exists. CMI has no refund API, so that money comes back only if
 *      a person reverses it by hand in the back office.
 *   2. The callback must be able to tell this apart from an ordinary sale.
 *      CMI echoes back only our order reference, so the link has to be a row
 *      it can find from that alone — exactly the problem ResaleListing's
 *      pendingOrderId solves, and this mirrors it.
 *   3. If delivery fails after the money is authorised, the payment must be
 *      REFUSED rather than kept. See routes/webhooks.ts.
 *
 * The reservation is an ordinary OrderLine on the paying order, pointed at
 * the target tier. lib/availability.ts already counts those against capacity
 * for any PENDING order with a live holdUntil, so the seat is held by the
 * same mechanism that holds a normal cart — no second notion of a hold, and
 * the sweeper already cancels it if the buyer never comes back.
 */

/** Money owed to move from one tier to another. Negative means a downgrade. */
export function upgradeDue(fromPriceCents: number, toPriceCents: number): number {
  return toPriceCents - fromPriceCents;
}

/**
 * Seats of a tier already spoken for, optionally ignoring ONE order.
 *
 * The exclusion is what makes an upgrade settle at all. The paying order
 * holds a line for the target tier — that is the reservation — so counting it
 * would make the upgrade's own hold the reason the upgrade is refused: the
 * last seat in a zone would always look taken by the person buying it.
 *
 * Mirrors lib/availability.ts committedForTier. Kept here rather than
 * extending that one with an `exceptOrderId` parameter, because every other
 * caller wants the honest total and an optional "ignore this" argument is the
 * kind of thing that eventually gets passed by accident.
 */
async function committedExcluding(
  tx: Pick<typeof prisma, "ticket" | "orderLine">,
  tierId: string,
  exceptOrderId: string | null,
): Promise<number> {
  const [issued, pending] = await Promise.all([
    tx.ticket.count({ where: { tierId, status: { in: ["VALID", "USED"] } } }),
    tx.orderLine.findMany({
      where: {
        tierId,
        order: { status: "PENDING", holdUntil: { gt: new Date() } },
        ...(exceptOrderId ? { orderId: { not: exceptOrderId } } : {}),
      },
      select: { qty: true },
    }),
  ]);
  return issued + pending.reduce((sum, line) => sum + line.qty, 0);
}

/** The ticket, with everything the rules below need. */
async function loadForUpgrade(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { tier: true, order: { include: { event: true } } },
  });
  if (!ticket) throw new HttpError(404, "Ticket not found");
  return ticket;
}

export interface StartedUpgrade {
  upgradeId: string;
  orderId: string;
  dueCents: number;
  targetTierId: string;
}

/**
 * Begin an upgrade: check it is allowed, reserve the seat, create the order
 * that will pay for it. The caller then sends the buyer to CMI.
 *
 * Everything that could refuse the move is checked HERE, before any money is
 * asked for. Taking payment and then discovering the ticket was already used
 * is the failure that costs a person their money, so the only thing left to
 * go wrong at settlement is the seat selling meanwhile — which is why it is
 * held.
 */
export async function startUpgrade(
  ticketId: string,
  targetTierId: string,
  buyer: { id: string; holderName: string; email: string; phone: string },
): Promise<StartedUpgrade> {
  const ticket = await loadForUpgrade(ticketId);

  if (ticket.status !== "VALID") {
    throw new HttpError(409, "Only a valid ticket can be upgraded");
  }
  // Same rule as exchangeTicket: a comp is a seat the organiser chose to
  // give. Letting the guest buy their way out of it makes them the one
  // deciding what was given away.
  if (ticket.kind === "COMP") {
    throw new HttpError(403, "An invitation cannot be moved to another zone. Ask the organiser.");
  }
  if (targetTierId === ticket.tierId) {
    throw new HttpError(400, "The ticket is already in that zone");
  }
  if (ticket.order.event.startAt.getTime() <= Date.now()) {
    throw new HttpError(409, "This event has already started");
  }

  const target = await prisma.ticketTier.findUnique({ where: { id: targetTierId } });
  if (!target) throw new HttpError(404, "Zone not found");
  if (target.eventId !== ticket.order.eventId) {
    throw new HttpError(400, "That zone belongs to a different event");
  }

  const dueCents = upgradeDue(ticket.tier.priceCents, target.priceCents);
  if (dueCents <= 0) {
    // A downgrade or a sideways move owes nothing, and must not be routed
    // through a payment flow that would charge 0 and still take the buyer to
    // a card page. exchangeTicket handles those directly.
    throw new HttpError(400, "That zone is not an upgrade — it costs no more than your current one");
  }

  // One at a time. Two live upgrades on one ticket would hold two seats for
  // a person who can only sit in one, and the second to settle would find
  // the ticket already moved.
  const existing = await prisma.ticketUpgrade.findFirst({
    where: { ticketId, status: "PENDING", order: { status: "PENDING", holdUntil: { gt: new Date() } } },
  });
  if (existing) {
    throw new HttpError(409, "An upgrade is already in progress for this ticket");
  }

  return prisma.$transaction(async (tx) => {
    // Re-counted inside the transaction, like every other place that claims
    // inventory: the check and the claim have to be one step.
    const committed = await committedExcluding(tx, targetTierId, null);
    if (committed >= target.capacity) throw new HttpError(409, "That zone is sold out");

    const order = await tx.order.create({
      data: {
        customerId: buyer.id,
        eventId: ticket.order.eventId,
        status: "PENDING",
        holderName: buyer.holderName,
        email: buyer.email,
        phone: buyer.phone,
        // The upgrade fee IS the order total. The original order keeps its
        // own figure untouched: rewriting a settled record to make the sum
        // come out right would falsify what was actually charged, and the
        // organiser's payout reads totalCents - refundedCents per order.
        subtotalCents: dueCents,
        discountCents: 0,
        totalCents: dueCents,
        // The reservation. Same hold window as a normal cart, and the
        // sweeper cancels it if the buyer never comes back from CMI.
        holdUntil: new Date(Date.now() + 15 * 60 * 1000),
        lines: { create: [{ tierId: targetTierId, qty: 1 }] },
      },
    });

    const upgrade = await tx.ticketUpgrade.create({
      data: {
        ticketId,
        buyerId: buyer.id,
        targetTierId,
        fromTierId: ticket.tierId,
        dueCents,
        orderId: order.id,
      },
    });

    return { upgradeId: upgrade.id, orderId: order.id, dueCents, targetTierId };
  });
}

/**
 * Money has arrived: move the ticket.
 *
 * Guarded on status PENDING inside the transaction, so a replayed callback
 * moves the seat once. Throws if the move is no longer possible — the caller
 * MUST treat that as "refuse the payment", because the alternative is keeping
 * money for a seat nobody received.
 */
export async function completeUpgrade(upgradeId: string): Promise<{ ticketId: string; tierId: string }> {
  return prisma.$transaction(async (tx) => {
    // Claim it first. updateMany rather than update, so a concurrent replay
    // loses the race instead of both proceeding.
    const claimed = await tx.ticketUpgrade.updateMany({
      where: { id: upgradeId, status: "PENDING" },
      data: { status: "DONE", completedAt: new Date() },
    });
    if (claimed.count === 0) throw new HttpError(409, "This upgrade is no longer pending");

    const upgrade = await tx.ticketUpgrade.findUniqueOrThrow({
      where: { id: upgradeId },
      include: { ticket: true, targetTier: true },
    });

    if (upgrade.ticket.status !== "VALID") {
      // Used at the gate, cancelled or given away while the buyer was paying.
      throw new HttpError(409, "This ticket can no longer be moved");
    }

    /*
     * Capacity, ignoring this upgrade's own hold.
     *
     * Without the exclusion the reservation made at startUpgrade would be
     * counted as a rival claim on the very seat it is reserving, so the last
     * seat of a zone could never be upgraded into — the buyer would pay and
     * then be refused by their own hold.
     */
    const committed = await committedExcluding(tx, upgrade.targetTierId, upgrade.orderId);
    if (committed >= upgrade.targetTier.capacity) {
      throw new HttpError(409, "That zone sold out while the payment was in progress");
    }

    let seatRow: number | null = null;
    let seatNumber: number | null = null;
    if (upgrade.targetTier.numbered) {
      const seat = seatFor(committed + 1, upgrade.targetTier.seatsPerRow);
      seatRow = seat.row;
      seatNumber = seat.seat;
    }

    await tx.ticket.update({
      where: { id: upgrade.ticketId },
      data: { tierId: upgrade.targetTierId, seatRow, seatNumber },
    });

    /*
     * The ORIGINAL order's line moves back to the old tier's count being one
     * lower, exactly as a downgrade does — otherwise the vacated seat stays
     * counted against the zone the holder has left.
     *
     * The upgrade order keeps its own line on the target tier. That line is
     * what the seat is now counted by: the order is about to be PAID, and a
     * paid order's line is how availability knows the seat is taken.
     */
    const line = await tx.orderLine.findFirst({
      where: { orderId: upgrade.ticket.orderId, tierId: upgrade.fromTierId },
    });
    if (line) {
      if (line.qty <= 1) {
        await tx.orderLine.delete({ where: { id: line.id } });
      } else {
        await tx.orderLine.update({ where: { id: line.id }, data: { qty: line.qty - 1 } });
      }
    }

    logger.info(
      { upgradeId, ticketId: upgrade.ticketId, from: upgrade.fromTierId, to: upgrade.targetTierId },
      "ticket upgraded",
    );
    return { ticketId: upgrade.ticketId, tierId: upgrade.targetTierId };
  });
}

/** Give up an upgrade: the buyer withdrew, or the payment failed. */
export async function cancelUpgrade(upgradeId: string): Promise<void> {
  const upgrade = await prisma.ticketUpgrade.findUnique({ where: { id: upgradeId } });
  if (!upgrade || upgrade.status !== "PENDING") return;

  await prisma.$transaction(async (tx) => {
    await tx.ticketUpgrade.updateMany({
      where: { id: upgradeId, status: "PENDING" },
      data: { status: "CANCELLED", closedAt: new Date() },
    });
    // Release the held seat immediately rather than waiting for the sweeper:
    // the zone was dear enough that someone is probably waiting for it.
    await tx.order.updateMany({
      where: { id: upgrade.orderId, status: "PENDING" },
      data: { status: "CANCELLED", holdUntil: null },
    });
  });
}

/** The live upgrade attached to a paying order, for the gateway callback. */
export async function upgradeForOrder(orderId: string) {
  return prisma.ticketUpgrade.findUnique({ where: { orderId } });
}
