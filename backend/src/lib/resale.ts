import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { makeTicketRef } from "../domain/ticketRef.js";
import { refundOrder } from "./refund.js";
import { grantCredit } from "./credit.js";
import { platformTerms } from "./settings.js";
import { recordResaleFee } from "./settle.js";
import { splitResale } from "../domain/commission.js";
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

  /*
   * No bank details needed to list.
   *
   * This used to refuse outright: a resale payout is money the platform
   * holds, it left as a bank transfer, and without an account number there
   * was a queue of refunds an admin could see, name and total, and not pay.
   * So the seller was stopped at the one moment they were present and able
   * to fix it.
   *
   * A signed-in seller is now paid in STORE CREDIT instead (see
   * completeResale), which lands the moment the seat sells and needs no
   * account anywhere. The guard it replaced was protecting a payment path
   * that customers no longer use, and it was blocking the sale to do it.
   *
   * A guest seller still has nowhere to put credit, so their payout stays a
   * bank reversal and is chased by email, as it always was.
   */

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

  /*
   * Pay the seller their face value.
   *
   * refundOrder records the amount and voids what needs voiding, but it
   * cannot move money -- CMI has no refund API, and a resale payout is money
   * the PLATFORM holds, so it used to leave as a bank transfer that somebody
   * had to make by hand. That is why listing demanded a RIB.
   *
   * A signed-in seller is now credited instead: the balance lands here, in
   * this call, and is spendable immediately. No account number, no queue, no
   * back office. A guest seller has no balance to credit, so theirs stays a
   * bank reversal and keeps appearing in the pending-refunds queue -- which
   * is now the only thing that queue is for.
   *
   * After the transaction: the buyer owns a working ticket either way, and a
   * payout failure must be visible rather than rolling back a completed sale.
   */
  /*
   * The platform's cut, taken from the SELLER's share.
   *
   * The buyer paid the listed price and that is the end of their side of it.
   * The fee comes out of what goes back to the seller, so a buyer quoted 300
   * is charged 300 -- the listing price stays the one number that means what
   * it says.
   *
   * Read at settlement, not at listing. The rate is a platform term, and the
   * figure that matters is the one in force when the money actually moved.
   * It is then recorded on the order, so a later rate change cannot re-price
   * a sale that already happened.
   */
  const { resaleFeeBps } = await platformTerms();
  const { feeCents, sellerCents } = splitResale(listing.priceCents, resaleFeeBps);

  /*
   * Recorded on the BUYER's order, which is the row that represents this
   * transaction. Written here rather than by the caller so both settlement
   * paths — mock and the CMI callback — get the same figure from the same
   * computation, instead of each deciding for itself.
   */
  await recordResaleFee(prisma, buyerOrderId, feeCents);

  try {
    /*
     * The seller is refunded their NET, not the full face value.
     *
     * refundOrder is what records the amount against their original order,
     * and that record is what the books read -- so the fee has to come off
     * here rather than afterwards, or the order says the seller got 300 while
     * their balance says 294.
     */
    await refundOrder(listing.ticket.orderId, sellerCents);
    if (listing.sellerId) {
      await grantCredit({
        userId: listing.sellerId,
        amountCents: sellerCents,
        reason: "ORDER_REFUND",
        label: `Revente — ${listing.ticket.order.event.titleFr}`,
        orderId: listing.ticket.orderId,
      });
      logger.info(
        {
          listingId,
          priceCents: listing.priceCents,
          feeCents,
          creditedCents: sellerCents,
          sellerId: listing.sellerId,
        },
        "resale complete, seller paid in store credit less the platform fee",
      );
    } else {
      logger.info(
        { listingId, priceCents: listing.priceCents, feeCents, refunded: sellerCents },
        "resale complete, guest seller owed a bank reversal less the platform fee",
      );
    }
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
