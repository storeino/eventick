import { describe, expect, it } from "vitest";
import { sellerFaceValue } from "../resale.js";

/**
 * What a resold seat is worth to the seller.
 *
 * The listing used to be priced at `tier.priceCents` — the tier's CURRENT
 * price. An organiser raising it after someone bought produced a listing
 * worth more than the seller's order had ever taken, so completeResale asked
 * refundOrder for more than it could return, refundOrder threw "Refund
 * exceeds the amount still refundable", and the catch logged it and carried
 * on. The buyer kept a working ticket; the seller lost the seat AND the
 * money, with nothing in the pending-refunds queue to show for it.
 *
 * Found in real data: a 150 MAD ticket listed at 250 after a price rise.
 *
 * The invariant these cover: a listing is never worth more than its own
 * order can refund, so completing a resale can never fail that way again.
 */
describe("sellerFaceValue", () => {
  it("is what they paid, for the ordinary one-ticket order", () => {
    expect(sellerFaceValue({ totalCents: 15000, refundedCents: 0 }, 1)).toBe(15000);
  });

  it("ignores a tier price rise — the regression that started this", () => {
    // Paid 150; tier is now 250. The old code listed at 250 and the refund
    // blew up. Nothing here can see the tier at all, which is the point.
    const order = { totalCents: 15000, refundedCents: 0 };
    expect(sellerFaceValue(order, 1)).toBe(15000);
    expect(sellerFaceValue(order, 1)).toBeLessThanOrEqual(order.totalCents);
  });

  it("splits a multi-ticket order evenly", () => {
    expect(sellerFaceValue({ totalCents: 30000, refundedCents: 0 }, 3)).toBe(10000);
  });

  it("never lets the shares of an order sum above what is refundable", () => {
    // 100.00 over 3 seats does not divide evenly; flooring keeps the total
    // under the cap. Rounding up would recreate the overdraw.
    const order = { totalCents: 10000, refundedCents: 0 };
    const share = sellerFaceValue(order, 3);
    expect(share * 3).toBeLessThanOrEqual(order.totalCents);
  });

  it("counts only what is still refundable after a partial refund", () => {
    expect(sellerFaceValue({ totalCents: 20000, refundedCents: 5000 }, 1)).toBe(15000);
  });

  it("is zero for a comp, which was never paid for", () => {
    expect(sellerFaceValue({ totalCents: 0, refundedCents: 0 }, 1)).toBe(0);
  });

  it("is zero once the order has been fully refunded", () => {
    expect(sellerFaceValue({ totalCents: 15000, refundedCents: 15000 }, 1)).toBe(0);
  });

  it("does not go negative if more was somehow refunded than taken", () => {
    expect(sellerFaceValue({ totalCents: 15000, refundedCents: 20000 }, 1)).toBe(0);
  });

  it("treats a zero ticket count as one, rather than dividing by zero", () => {
    expect(sellerFaceValue({ totalCents: 15000, refundedCents: 0 }, 0)).toBe(15000);
  });
});
