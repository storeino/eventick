import { describe, expect, it } from "vitest";

/**
 * Store credit, as pure ledger logic.
 *
 * The real module needs a database, so this models the two properties the
 * design actually rests on:
 *
 *   1. The balance is DERIVED — SUM(amountCents) — never stored. A mutable
 *      total cannot say where credit came from, and two concurrent spends
 *      reading it can both pass a `balance >= total` check.
 *   2. Grants are idempotent per (orderId, reason) by a unique index, so a
 *      cancellation retried after a partial failure cannot double a balance.
 *
 * Both were real risks: the first is the bug refundOrder already had to fix
 * once with a compare-and-swap, and the second is reachable today because
 * cancelEvent converts orders one at a time and keeps going when one fails.
 */
type Reason = "EVENT_CANCELLED" | "ORDER_REFUND" | "PURCHASE" | "PURCHASE_REVERSED" | "ADJUSTMENT";

interface Entry {
  amountCents: number;
  reason: Reason;
  orderId: string | null;
}

/** An append-only ledger with the schema's UNIQUE(orderId, reason). */
function makeLedger() {
  const entries: Entry[] = [];
  const taken = new Set<string>();

  return {
    get entries() {
      return [...entries];
    },
    /** The balance is a sum, every time. Nothing caches it. */
    balance() {
      return entries.reduce((sum, e) => sum + e.amountCents, 0);
    },
    /** Returns false when the unique index would have fired. */
    append(entry: Entry): boolean {
      if (entry.orderId !== null) {
        const key = `${entry.orderId}:${entry.reason}`;
        // Postgres treats NULLs as distinct, so only non-null orderIds collide.
        if (taken.has(key)) return false;
        taken.add(key);
      }
      entries.push(entry);
      return true;
    },
  };
}

describe("credit balance is derived from entries", () => {
  it("sums grants and spends", () => {
    const l = makeLedger();
    l.append({ amountCents: 30000, reason: "EVENT_CANCELLED", orderId: "o1" });
    l.append({ amountCents: -12000, reason: "PURCHASE", orderId: "o2" });
    expect(l.balance()).toBe(18000);
  });

  it("is zero for a holder with no entries", () => {
    expect(makeLedger().balance()).toBe(0);
  });

  it("returns to zero when a spend exactly consumes a grant", () => {
    const l = makeLedger();
    l.append({ amountCents: 15000, reason: "EVENT_CANCELLED", orderId: "o1" });
    l.append({ amountCents: -15000, reason: "PURCHASE", orderId: "o2" });
    expect(l.balance()).toBe(0);
  });

  it("corrects a mistake by appending its opposite, keeping both rows", () => {
    const l = makeLedger();
    l.append({ amountCents: 50000, reason: "ADJUSTMENT", orderId: null });
    l.append({ amountCents: -50000, reason: "ADJUSTMENT", orderId: null });
    expect(l.balance()).toBe(0);
    // The history shows the error AND the fix, which an UPDATE would not.
    expect(l.entries).toHaveLength(2);
  });
});

describe("a cancellation retried cannot double a balance", () => {
  it("refuses a second EVENT_CANCELLED grant for the same order", () => {
    const l = makeLedger();
    const first = l.append({ amountCents: 30000, reason: "EVENT_CANCELLED", orderId: "o1" });
    const second = l.append({ amountCents: 30000, reason: "EVENT_CANCELLED", orderId: "o1" });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The point: a retry of a half-finished mass cancellation leaves the
    // buyer with what they were owed, not twice it.
    expect(l.balance()).toBe(30000);
  });

  it("still allows spending credit on the very order it was granted for", () => {
    const l = makeLedger();
    l.append({ amountCents: 20000, reason: "EVENT_CANCELLED", orderId: "o1" });
    // Different reason, so the unique index does not collide.
    const spent = l.append({ amountCents: -20000, reason: "PURCHASE", orderId: "o1" });
    expect(spent).toBe(true);
    expect(l.balance()).toBe(0);
  });

  it("allows several staff adjustments, which carry no order", () => {
    const l = makeLedger();
    expect(l.append({ amountCents: 1000, reason: "ADJUSTMENT", orderId: null })).toBe(true);
    expect(l.append({ amountCents: 2000, reason: "ADJUSTMENT", orderId: null })).toBe(true);
    expect(l.balance()).toBe(3000);
  });

  it("reverses a credit-paid order without colliding with the spend", () => {
    const l = makeLedger();
    l.append({ amountCents: 25000, reason: "EVENT_CANCELLED", orderId: "o1" });
    l.append({ amountCents: -25000, reason: "PURCHASE", orderId: "o2" });
    // o2 is cancelled: the credit it ate comes back.
    expect(l.append({ amountCents: 25000, reason: "PURCHASE_REVERSED", orderId: "o2" })).toBe(true);
    // Without the reversal the buyer would have lost the tickets AND the
    // credit — losing twice for someone else's cancellation.
    expect(l.balance()).toBe(25000);
  });
});

/**
 * How much credit a checkout applies, and what the card is then charged.
 *
 * Mirrors the `Math.min(balance, totalCents)` in the /pay handler. Partial
 * cover is the normal case, and the arithmetic has to leave the card paying
 * exactly the remainder — a rounding slip here either charges a buyer for
 * credit they spent or hands them free tickets.
 */
function splitPayment(balanceCents: number, totalCents: number) {
  const credit = Math.min(Math.max(balanceCents, 0), totalCents);
  return { creditCents: credit, cardCents: totalCents - credit };
}

describe("credit and card split", () => {
  it("covers an order fully when the balance is larger", () => {
    expect(splitPayment(50000, 30000)).toEqual({ creditCents: 30000, cardCents: 0 });
  });

  it("covers it exactly when they are equal, leaving nothing for the card", () => {
    expect(splitPayment(30000, 30000)).toEqual({ creditCents: 30000, cardCents: 0 });
  });

  it("pays part and leaves the remainder to the card", () => {
    expect(splitPayment(12000, 30000)).toEqual({ creditCents: 12000, cardCents: 18000 });
  });

  it("charges the whole amount to the card on a zero balance", () => {
    expect(splitPayment(0, 30000)).toEqual({ creditCents: 0, cardCents: 30000 });
  });

  it("never applies more credit than the order costs", () => {
    // The overspend that would hand out free money: 900 of credit against a
    // 300 order must apply 300, not 900.
    const { creditCents, cardCents } = splitPayment(90000, 30000);
    expect(creditCents).toBe(30000);
    expect(cardCents).toBe(0);
  });

  it("the two parts always add up to the order total", () => {
    for (const balance of [0, 1, 999, 12000, 30000, 90000]) {
      for (const total of [1, 5000, 30000, 123456]) {
        const { creditCents, cardCents } = splitPayment(balance, total);
        expect(creditCents + cardCents).toBe(total);
        expect(creditCents).toBeGreaterThanOrEqual(0);
        expect(cardCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
