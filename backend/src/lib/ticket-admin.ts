import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { makeTicketRef } from "../domain/ticketRef.js";
import { seatFor } from "../domain/inventory.js";
import { offerFreedSeats } from "./waitlist.js";
import { logger } from "./logger.js";

/**
 * Ticket lifecycle operations that sit between "view it" and "scan it":
 * self-cancellation, exchange between zones, reissue, and renaming the holder.
 *
 * Common rules, enforced here rather than repeated per route:
 *  - a USED ticket is history; nothing may change it
 *  - a CANCELLED or TRANSFERRED ticket is no longer the holder's to alter
 *  - NOTHING here returns money. Tickets are final sale; the only refund in
 *    the product is a cancelled event, which runs through event-cancel.ts.
 *    Cancelling or exchanging a seat moves inventory, never the charge.
 */

type TicketWithContext = Awaited<ReturnType<typeof loadTicket>>;

export async function loadTicket(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { tier: true, order: { include: { event: true } } },
  });
  if (!ticket) throw new HttpError(404, "Ticket not found");
  return ticket;
}

/** A ticket can only be altered while it is still a live, unused entitlement. */
function assertAlterable(ticket: TicketWithContext): void {
  if (ticket.status === "USED") throw new HttpError(409, "This ticket has already been used at the gate");
  if (ticket.status === "CANCELLED") throw new HttpError(409, "This ticket is cancelled");
  if (ticket.status === "TRANSFERRED") throw new HttpError(409, "This ticket was transferred to someone else");
}

/** Hours remaining before the event starts. Negative once it has begun. */
function hoursUntilStart(startAt: Date): number {
  return (startAt.getTime() - Date.now()) / 3_600_000;
}

export interface CancelPolicy {
  allowed: boolean;
  cutoffHours: number;
  hoursLeft: number;
  reason?: string;
}

/**
 * Whether the BUYER may cancel this themselves right now.
 *
 * Exposed so the UI can show the deadline and hide the button rather than
 * offering an action that will fail — the organiser can always cancel.
 */
export function cancelPolicy(ticket: TicketWithContext): CancelPolicy {
  const cutoffHours = ticket.order.event.cancelCutoffHours;
  const hoursLeft = hoursUntilStart(ticket.order.event.startAt);

  if (cutoffHours === 0) {
    return { allowed: false, cutoffHours, hoursLeft, reason: "self-cancel-disabled" };
  }
  if (ticket.status !== "VALID") {
    return { allowed: false, cutoffHours, hoursLeft, reason: "not-valid" };
  }
  if (hoursLeft < cutoffHours) {
    return { allowed: false, cutoffHours, hoursLeft, reason: "past-cutoff" };
  }
  return { allowed: true, cutoffHours, hoursLeft };
}

/**
 * Buyer cancels their own ticket and is refunded its face value.
 *
 * Refunds the ticket's price rather than the whole order, because an order
 * can hold several tickets and cancelling one shouldn't void the rest.
 */
export async function selfCancelTicket(ticketId: string): Promise<{ refundedCents: number }> {
  const ticket = await loadTicket(ticketId);
  assertAlterable(ticket);

  const policy = cancelPolicy(ticket);
  if (!policy.allowed) {
    if (policy.reason === "self-cancel-disabled") {
      throw new HttpError(409, "This organiser does not allow self-cancellation — please contact them");
    }
    throw new HttpError(
      409,
      `Cancellation closed ${policy.cutoffHours}h before the event. Please contact the organiser.`,
    );
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });

  /*
   * No money is returned. Tickets are final sale.
   *
   * This used to refund the seat's face value. Refunds now exist for exactly
   * one reason — the EVENT was called off, which is the organiser's doing and
   * not the buyer's. A buyer changing their mind releases the seat but keeps
   * the charge.
   *
   * The cancellation itself is still worth having: it puts the seat back in
   * the pool and in front of the waitlist, which is better for everyone than
   * an empty seat on the night. An organiser who does not want that at all
   * sets cancelCutoffHours = 0, which blocks this route entirely.
   */
  logger.info({ ticketId, orderId: ticket.orderId }, "ticket self-cancelled (no refund — final sale)");

  void offerFreedSeats(ticket.order.eventId);
  return { refundedCents: 0 };
}

/**
 * Move a ticket to another zone of the same event.
 *
 * Upgrades owe the difference, which the caller collects before this runs.
 * Downgrades keep the original value: refunding the difference would let
 * someone buy the dearest seat and downgrade purely to extract a refund.
 */
export async function exchangeTicket(
  ticketId: string,
  targetTierId: string,
): Promise<{ ticketId: string; seatRow: number | null; seatNumber: number | null }> {
  const ticket = await loadTicket(ticketId);
  assertAlterable(ticket);

  // A comp is a seat an organiser CHOSE to give this guest. Letting the guest
  // move it makes them the one deciding what was given away -- and because a
  // comp was never a sale, there is no price paid to measure the change
  // against. Moving it is the organiser's call, through the invitation list.
  if (ticket.kind === "COMP") {
    throw new HttpError(403, "An invitation cannot be moved to another zone. Ask the organiser.");
  }

  if (targetTierId === ticket.tierId) throw new HttpError(400, "The ticket is already in that zone");

  return prisma.$transaction(async (tx) => {
    const target = await tx.ticketTier.findUnique({ where: { id: targetTierId } });
    if (!target) throw new HttpError(404, "Zone not found");
    if (target.eventId !== ticket.order.eventId) {
      throw new HttpError(400, "That zone belongs to a different event");
    }

    // What the target zone already owes — issued tickets plus live holds,
    // matching lib/availability.ts. Counting paid ORDERS would miss a resold
    // seat, whose order is REFUNDED but whose ticket is still valid.
    const issued = await tx.ticket.count({
      where: { tierId: targetTierId, status: { in: ["VALID", "USED"] } },
    });
    const holds = await tx.orderLine.findMany({
      where: { tierId: targetTierId, order: { status: "PENDING", holdUntil: { gt: new Date() } } },
      select: { qty: true },
    });
    const committed = issued + holds.reduce((sum, line) => sum + line.qty, 0);
    if (committed >= target.capacity) throw new HttpError(409, "That zone is sold out");

    // Numbered zones need a seat; take the next one in the row layout.
    let seatRow: number | null = null;
    let seatNumber: number | null = null;
    if (target.numbered) {
      const seat = seatFor(committed + 1, target.seatsPerRow);
      seatRow = seat.row;
      seatNumber = seat.seat;
    }

    await tx.ticket.update({
      where: { id: ticketId },
      data: { tierId: targetTierId, seatRow, seatNumber },
    });

    // Move the order line too, so inventory counts stay honest for both zones.
    const line = await tx.orderLine.findFirst({ where: { orderId: ticket.orderId, tierId: ticket.tierId } });
    if (line) {
      if (line.qty <= 1) {
        await tx.orderLine.update({ where: { id: line.id }, data: { tierId: targetTierId } });
      } else {
        await tx.orderLine.update({ where: { id: line.id }, data: { qty: line.qty - 1 } });
        await tx.orderLine.create({ data: { orderId: ticket.orderId, tierId: targetTierId, qty: 1 } });
      }
    }

    return { ticketId, seatRow, seatNumber };
  });
}

/**
 * Reissue a lost ticket: the old reference and its QR stop working, and a
 * fresh one takes its place.
 *
 * Voiding the old ref is the point — a reissue exists because the original
 * may be in someone else's hands, so leaving it valid would admit two people.
 */
export async function reissueTicket(ticketId: string): Promise<{ id: string; ref: string; previousRef: string }> {
  const ticket = await loadTicket(ticketId);
  assertAlterable(ticket);

  return prisma.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticketId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    const replacement = await tx.ticket.create({
      data: {
        ref: makeTicketRef(ticket.order.event.startAt.getFullYear()),
        orderId: ticket.orderId,
        tierId: ticket.tierId,
        holderName: ticket.holderName,
        seatRow: ticket.seatRow,
        seatNumber: ticket.seatNumber,
        replacesRef: ticket.ref,
      },
    });

    return { id: replacement.id, ref: replacement.ref, previousRef: ticket.ref };
  });
}

/**
 * Correct the holder's name.
 *
 * Distinct from a transfer: a transfer hands the ticket to someone else and
 * marks the original TRANSFERRED, while this just fixes a spelling so the
 * name matches the ID presented at the gate.
 */
export async function renameHolder(ticketId: string, holderName: string): Promise<void> {
  const ticket = await loadTicket(ticketId);
  assertAlterable(ticket);
  await prisma.ticket.update({ where: { id: ticketId }, data: { holderName: holderName.trim() } });
}
