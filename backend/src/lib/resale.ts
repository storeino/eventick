import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { makeTicketRef } from "../domain/ticketRef.js";
import { refundOrder } from "./refund.js";
import { logger } from "./logger.js";

/**
 * Resale — platform-mediated, at face value.
 *
 * The buyer pays Eventick, the seller is refunded what they originally paid,
 * and a fresh ticket is issued to the buyer while the seller's is voided.
 * Nobody hands money to a stranger, and the old QR stops working the moment
 * the sale completes, so a ticket can never be presented twice.
 *
 * Face value is copied onto the listing rather than read live, so an
 * organiser changing a tier price later cannot alter what a listed ticket
 * costs — the buyer pays what the listing showed.
 *
 * "What they originally paid" means exactly that, and it is NOT the tier's
 * current price. The listing used to be created at `tier.priceCents`, so an
 * organiser raising the price after someone bought produced a listing worth
 * more than the seller's order ever took: completeResale then asked
 * refundOrder for more than that order could return, it threw "Refund
 * exceeds the amount still refundable", and the catch below logged it and
 * moved on. The buyer kept a valid ticket, the seller lost both the seat and
 * the money. Seen in real data: a 150 MAD ticket listed at 250.
 *
 * So the price comes from the seller's own order, via sellerFaceValue().
 */

/**
 * What this seat is worth to the seller — what their order can still return.
 *
 * Neither Ticket nor OrderLine stores a unit price (OrderLine has qty and
 * tierId only), so there is no recorded "they paid X for this one". What IS
 * recorded is the order's own money, and that is the number that governs the
 * refund: refundOrder refuses anything above `totalCents - refundedCents`.
 *
 * So the listing is priced at the per-ticket share of what remains
 * refundable on that order. For the ordinary case — one order, one ticket,
 * nothing refunded — that is simply what they paid. For a multi-ticket
 * order it splits what is left evenly, which is the honest reading when the
 * order does not record per-seat prices, and it keeps the invariant that
 * matters: selling every seat on an order never asks for more back than the
 * order took.
 *
 * Deliberately NOT tier.priceCents. That is today's shelf price, which the
 * organiser can change after the sale; using it is what produced listings
 * worth more than the seller's order and a refund that silently failed.
 */
export function sellerFaceValue(
  order: { totalCents: number; refundedCents: number },
  ticketsOnOrder: number,
): number {
  const refundable = order.totalCents - order.refundedCents;
  if (refundable <= 0) return 0;
  // Floor, so the shares of a multi-ticket order can never sum above what is
  // refundable — rounding up would recreate the overdraw this fixes.
  return Math.floor(refundable / Math.max(1, ticketsOnOrder));
}

export async function listTicketForResale(ticketId: string, sellerId: string | null) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      tier: true,
      order: { include: { event: true, _count: { select: { tickets: true } } } },
      resale: true,
    },
  });
  if (!ticket) throw new HttpError(404, "Ticket not found");
  if (ticket.status !== "VALID") throw new HttpError(409, "Only a valid ticket can be resold");
  /*
   * Resale is OPT-IN per event, and off by default.
   *
   * It is a secondary market: genuinely useful when an organiser wants one,
   * but making every event a reseller venue is the organiser's decision, not
   * a platform default. Gated here rather than only in the UI, so the API
   * cannot be used to list against an event that never enabled it.
   *
   * Existing listings are untouched — this gates NEW ones, so nothing in
   * flight breaks when an organiser turns it off.
   */
  if (!ticket.order.event.allowResale) {
    throw new HttpError(409, "The organiser has not enabled resale for this event");
  }
  if (ticket.order.event.startAt.getTime() < Date.now()) {
    throw new HttpError(409, "This event has already started");
  }

  const priceCents = sellerFaceValue(ticket.order, ticket.order._count.tickets);
  /*
   * A comp, or a seat whose order has already been refunded, is worth
   * nothing back. Listing it would promise a buyer a seat and the seller a
   * payout that cannot exist — better to refuse than to sell it and fail
   * the refund afterwards, which is the failure this whole change is about.
   */
  if (priceCents <= 0) {
    throw new HttpError(409, "This ticket has no refundable value to resell");
  }

  // One live listing per ticket. A previous CANCELLED listing may be replaced;
  // the unique constraint is on ticketId, so reuse the row rather than insert.
  if (ticket.resale) {
    if (ticket.resale.status === "LISTED") throw new HttpError(409, "This ticket is already listed");
    if (ticket.resale.status === "SOLD") throw new HttpError(409, "This ticket has already been resold");
    const relisted = await prisma.resaleListing.update({
      where: { id: ticket.resale.id },
      data: {
        status: "LISTED",
        priceCents,
        token: randomBytes(24).toString("base64url"),
        sellerId,
        soldAt: null,
        closedAt: null,
        buyerOrderId: null,
        newTicketId: null,
      },
    });
    return relisted;
  }

  return prisma.resaleListing.create({
    data: {
      ticketId,
      sellerId,
      priceCents,
      token: randomBytes(24).toString("base64url"),
    },
  });
}

export async function cancelListing(listingId: string): Promise<void> {
  const claimed = await prisma.resaleListing.updateMany({
    where: { id: listingId, status: "LISTED" },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
  if (claimed.count === 0) throw new HttpError(409, "This listing is no longer open");
}

/** A listing a buyer can still act on, or null. */
export async function resolveListing(token: string) {
  const listing = await prisma.resaleListing.findUnique({
    where: { token },
    include: { ticket: { include: { tier: true, order: { include: { event: true } } } } },
  });
  if (!listing || listing.status !== "LISTED") return null;
  // A ticket that changed hands or got used since listing is no longer sellable.
  if (listing.ticket.status !== "VALID") return null;
  if (listing.ticket.order.event.startAt.getTime() < Date.now()) return null;
  return listing;
}

/**
 * Complete a resale: void the seller's ticket, issue the buyer's, refund the
 * seller.
 *
 * Called once the buyer's order is PAID. The listing is claimed with a
 * guarded update first, so two simultaneous buyers cannot both complete —
 * the loser is told it has gone.
 */
export async function completeResale(
  listingId: string,
  buyerOrderId: string,
): Promise<{ newTicketId: string; newRef: string }> {
  const claimed = await prisma.resaleListing.updateMany({
    where: { id: listingId, status: "LISTED" },
    data: { status: "SOLD", soldAt: new Date(), buyerOrderId },
  });
  if (claimed.count === 0) throw new HttpError(409, "This listing has already been sold");

  const listing = await prisma.resaleListing.findUniqueOrThrow({
    where: { id: listingId },
    include: { ticket: { include: { tier: true, order: { include: { event: true } } } } },
  });

  const result = await prisma.$transaction(async (tx) => {
    // The seller's ticket stops working.
    await tx.ticket.update({
      where: { id: listing.ticketId },
      data: { status: "TRANSFERRED" },
    });

    const buyerOrder = await tx.order.findUniqueOrThrow({ where: { id: buyerOrderId } });

    // A fresh reference, so the seller's QR cannot admit the new owner's seat.
    const replacement = await tx.ticket.create({
      data: {
        ref: makeTicketRef(listing.ticket.order.event.startAt.getFullYear()),
        orderId: buyerOrderId,
        tierId: listing.ticket.tierId,
        holderName: buyerOrder.holderName,
        seatRow: listing.ticket.seatRow,
        seatNumber: listing.ticket.seatNumber,
        replacesRef: listing.ticket.ref,
      },
    });

    await tx.resaleListing.update({
      where: { id: listingId },
      data: { newTicketId: replacement.id },
    });

    return { newTicketId: replacement.id, newRef: replacement.ref };
  });

  // Refund the seller their face value. After the transaction: the buyer owns
  // a working ticket either way, and a refund failure must be visible rather
  // than rolling back a completed sale.
  try {
    await refundOrder(listing.ticket.orderId, listing.priceCents);
    logger.info({ listingId, refunded: listing.priceCents }, "resale complete, seller refunded");
  } catch (err) {
    /*
     * Still swallowed, because the sale is done and the buyer holds a valid
     * ticket — throwing here would fail their request over the seller's
     * money and tell them a completed purchase had failed.
     *
     * But it now says what is owed to whom. The previous message named only
     * the listing id, so a failure was a line in a log nobody reads and the
     * seller simply never got paid: that is how a 150 MAD ticket listed at
     * 250 went unnoticed. The pending-refunds queue keys on
     * `refundedCents > 0`, which a FAILED refund never sets — so this log is
     * the only trace, and it has to carry enough to act on by hand.
     */
    logger.error(
      {
        err,
        listingId,
        sellerOrderId: listing.ticket.orderId,
        owedCents: listing.priceCents,
        buyerOrderId,
      },
      "RESALE SELLER REFUND FAILED — seller is owed money and is NOT in the pending-refunds queue; pay by hand",
    );
  }

  return result;
}
