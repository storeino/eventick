/**
 * Platform commission — what Eventick keeps from a ticket sale.
 *
 * Pure arithmetic, no Prisma, so the rounding rules are testable on their own.
 * The figures these produce are money owed by a real organiser, so two
 * properties matter more than brevity:
 *
 *  - Rates are BASIS POINTS (500 = 5%), never floats. A 5% rate as 0.05 makes
 *    `gross * rate` a float multiplication whose error compounds across a
 *    month of orders — the exact drift that storing money as integer cents
 *    exists to prevent.
 *  - The fee on a REFUND follows the money back. Charging commission on a
 *    ticket the buyer was refunded for means the organiser pays to make a sale
 *    that no longer exists.
 */

/** A plan's charging terms. Mirrors the Plan model, minus the labels. */
export interface PlanTerms {
  key: string;
  rateBps: number;
  monthlyCents: number;
}

/** Basis points in 100%. */
const BPS_DIVISOR = 10_000;

/**
 * Commission on one order's gross.
 *
 * Rounded half-up to the cent, once, at the end — not per ticket. Rounding
 * each ticket and summing would charge a different total for the same basket
 * depending on how it was split across orders.
 */
export function feeForOrder(grossCents: number, plan: PlanTerms): number {
  if (grossCents <= 0) return 0;
  return Math.round((grossCents * plan.rateBps) / BPS_DIVISOR);
}

/**
 * The fee still owed on an order after refunds.
 *
 * Proportional to what the buyer actually kept: refund half an order and half
 * the commission goes with it. Returns 0 rather than a negative number if
 * more was refunded than charged, which a correction can produce.
 */
export function feeAfterRefund(
  grossCents: number,
  refundedCents: number,
  feeCents: number,
): number {
  if (feeCents <= 0 || grossCents <= 0) return 0;
  const kept = grossCents - refundedCents;
  if (kept <= 0) return 0;
  if (kept >= grossCents) return feeCents;
  return Math.round((feeCents * kept) / grossCents);
}

export interface RevenueLine {
  totalCents: number;
  refundedCents: number;
  /** Null for orders settled before commission was recorded. */
  feeCents: number | null;
}

export interface RevenueSummary {
  /** Ticket revenue the buyers actually kept — gross minus refunds. */
  netRevenueCents: number;
  /** Commission on that kept revenue. */
  feeCents: number;
  /** What the organiser is owed: netRevenue - fee. */
  payableCents: number;
  /** Money returned to buyers, for display alongside the above. */
  refundedCents: number;
  /** Gross before refunds, so the two can be shown side by side. */
  grossCents: number;
}

/**
 * Roll a set of settled orders into the four figures the Finance screen shows.
 *
 * Deliberately takes rows rather than querying: the caller decides scope
 * (one organiser, one period, the whole platform) and this stays arithmetic.
 *
 * `fallbackPlan` prices orders that carry no recorded fee — the ones settled
 * before commission existed. Without it their revenue would appear to cost
 * nothing, overstating what is payable.
 */
export function summariseRevenue(lines: RevenueLine[], fallbackPlan?: PlanTerms): RevenueSummary {
  let gross = 0;
  let refunded = 0;
  let fee = 0;

  for (const line of lines) {
    gross += line.totalCents;
    refunded += line.refundedCents;

    const recorded = line.feeCents ?? (fallbackPlan ? feeForOrder(line.totalCents, fallbackPlan) : 0);
    fee += feeAfterRefund(line.totalCents, line.refundedCents, recorded);
  }

  const netRevenue = gross - refunded;
  return {
    grossCents: gross,
    refundedCents: refunded,
    netRevenueCents: netRevenue,
    feeCents: fee,
    // A fully refunded month leaves netRevenue at 0 and nothing payable;
    // clamping stops a rounding artefact showing as money owed.
    payableCents: Math.max(0, netRevenue - fee),
  };
}

/** First instant of the UTC calendar month containing `date`. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Every calendar month a half-open period [start, end) touches.
 *
 * Used to bill a plan's fixed monthly fee from a payout: a run covering March
 * and April owes two months, and one covering a single afternoon owes one.
 *
 * Half-open is what makes this safe to use for consecutive runs — a period
 * ending exactly at a month boundary does NOT include that month, so
 * [Mar 1, Apr 1) and [Apr 1, May 1) bill March and April once each rather
 * than billing April twice.
 */
export function monthsInPeriod(start: Date, end: Date): Date[] {
  if (end <= start) return [];
  const months: Date[] = [];
  const cursor = monthStart(start);
  while (cursor < end) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/** Moroccan RIB: exactly 24 digits. */
export function ribOk(value: string): boolean {
  return /^\d{24}$/.test(value.replace(/[\s-]/g, ""));
}

/** Strip the spacing people paste in, so stored RIBs compare equal. */
export function normaliseRib(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/**
 * What a month's volume would have cost on each plan.
 *
 * Plans differ only by break-even volume — Pro's lower rate pays for its
 * monthly fee somewhere around 25 000 MAD a month — and a new organiser has
 * no way to know which side of that line they are on. Nobody should be asked
 * to pick a plan before their first sale; they should be told once their own
 * figures answer it.
 *
 * `grossCents` is ONE month's sales. Comparing on a partial month would
 * promise a saving that has not happened yet: the monthly fee is charged in
 * full whether a month is half over or not, so eight days of volume measured
 * against a whole month's fee makes every plan look worse than it is.
 */
export function monthlyCostOn(grossCents: number, plan: PlanTerms): number {
  if (grossCents <= 0) return plan.monthlyCents;
  return feeForOrder(grossCents, plan) + plan.monthlyCents;
}

/**
 * The cheapest plan at this volume, if it is not the current one.
 *
 * Returns null when the organiser is already on the best plan for what they
 * sell, which is the common case and must not produce a nudge. Also null
 * below a minimum volume: a saving of four dirhams is noise, and prompting on
 * it would train someone to ignore the prompt that matters.
 */
export function betterPlanAt(
  grossCents: number,
  current: PlanTerms,
  candidates: PlanTerms[],
  minimumSavingCents = 10_000,
): { plan: PlanTerms; savesCents: number } | null {
  /*
   * A month with no sales advises nothing.
   *
   * Arithmetically, an organiser on Business who sold nothing "saves" the
   * whole 1 999 by dropping to Starter — true, and a terrible thing to tell
   * someone who has just signed up and not yet launched. It would fire for
   * every new organiser on a paid plan, in the month they are still setting
   * up, which is precisely when the advice is least welcome and least
   * informative.
   *
   * Advice needs evidence. No volume, no evidence.
   */
  if (grossCents <= 0) return null;

  const currentCost = monthlyCostOn(grossCents, current);

  let best: { plan: PlanTerms; savesCents: number } | null = null;
  for (const plan of candidates) {
    if (plan.key === current.key) continue;
    const saving = currentCost - monthlyCostOn(grossCents, plan);
    if (saving < minimumSavingCents) continue;
    if (!best || saving > best.savesCents) best = { plan, savesCents: saving };
  }
  return best;
}

/**
 * How a resale's money divides between the platform and the seller.
 *
 * The buyer pays the LISTED price — the fee comes out of the seller's share,
 * not on top of the buyer's. A buyer quoted 300 and charged 306 at the last
 * step is the surprise this avoids, and the listing price stays the one
 * number that means what it says.
 *
 * Not the organiser's plan rate. A resale moves an existing seat between two
 * customers; the organiser was already paid when that seat was first sold,
 * so charging their plan again bills them for a transaction they receive
 * nothing from.
 *
 * Rounded half-up to the cent ONCE, on the fee, and the seller gets the
 * remainder. Rounding both halves independently is how 300.00 becomes
 * 6.00 + 293.99 and a dirham vanishes from the books.
 */
export function splitResale(
  priceCents: number,
  feeBps: number,
): { feeCents: number; sellerCents: number } {
  // A free or negative listing has nothing to split. Guarded rather than
  // trusted: sellerFaceValue can return 0 for a fully refunded order.
  if (priceCents <= 0) return { feeCents: 0, sellerCents: 0 };
  // Clamped, not trusted. 0 is a real setting (no fee); above 100% would
  // pay the seller a negative amount, which the ledger has no concept of.
  const bps = Math.min(Math.max(feeBps, 0), BPS_DIVISOR);
  const feeCents = Math.round((priceCents * bps) / BPS_DIVISOR);
  return { feeCents, sellerCents: priceCents - feeCents };
}
