import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import {
  betterPlanAt,
  feeAfterRefund,
  monthStart,
  monthsInPeriod,
  summariseRevenue,
  type RevenueLine,
} from "../domain/commission.js";
import { logger } from "./logger.js";
import { bucketsFor, previousWindow, windowFor, type PeriodKey } from "../domain/period.js";

/**
 * Payouts — what the platform owes an organiser, and the record of sending it.
 *
 * Eventick collects the whole ticket price through CMI, so every dirham a
 * buyer pays arrives in the PLATFORM's merchant account, not the organiser's.
 * The organiser's share therefore has to be transferred to them separately,
 * and this is the ledger for that. Before this existed, the dashboard showed a
 * "Reversement" step that computed nothing and recorded nothing.
 *
 * Two rules hold the integrity together:
 *
 *  - An order belongs to at most ONE payout, enforced by a unique index on
 *    PayoutOrder.orderId rather than by a query. Two runs over overlapping
 *    periods therefore cannot pay for the same tickets twice, even if they
 *    race.
 *  - A payout's totals are FROZEN when it is created. They are copied from
 *    the orders, not recomputed on read, so a refund processed next week
 *    cannot change the value of a transfer already made.
 *  - A plan's fixed monthly fee is charged at most ONCE per calendar month,
 *    enforced by a unique index on (organiserId, month) rather than by a
 *    query, so overlapping runs cannot bill the same month twice.
 */

/**
 * The default plan, for organisers nobody has assigned one to.
 *
 * Returns the whole row, not just PlanTerms: callers that describe the plan to
 * the UI need its label too, and narrowing here would lose it.
 */
async function defaultPlan() {
  return (await prisma.plan.findFirst({ where: { isDefault: true } })) ?? undefined;
}

/**
 * Spread a capped subscription total across the months it covers.
 *
 * Each month takes the full monthly fee until the total runs out, so a
 * three-month run that could only afford two shows two months paid and the
 * third at zero — rather than three months each short by a third, which would
 * imply every month was partly settled.
 */
function splitAcrossMonths(months: Date[], total: number, perMonth: number) {
  let left = total;
  return months.map((month) => {
    const amountCents = Math.min(perMonth, Math.max(0, left));
    left -= amountCents;
    return { month, amountCents };
  });
}

/**
 * The plan to price an UNRECORDED fee at.
 *
 * Orders settled before commission existed carry feeCents: null, and pricing
 * them at nothing would overstate what an organiser is owed. The first
 * version priced them at the platform default, which was worse than it
 * sounds: a Pro organiser (3%) had those orders charged at Starter's 5%, so
 * their reported commission went UP at a rate they were never on. Their own
 * plan is the only defensible guess; the default is for organisers who have
 * none.
 */
async function pricingPlanFor(organiserId: string) {
  const organiser = await prisma.user.findUnique({
    where: { id: organiserId },
    select: { plan: true },
  });
  return organiser?.plan ?? (await defaultPlan());
}

/**
 * What an organiser has earned, and what is still unpaid.
 *
 * `payableCents` counts only orders not yet in a payout — it is what the next
 * run would transfer. The lifetime figures are shown beside it so the number
 * can be explained without digging through orders.
 */
/**
 * What one organiser has earned — or, with `null`, the whole platform.
 *
 * `null` is for an admin who has not picked an organiser: the screen's filter
 * says "All organisers", so the figures have to span everyone rather than
 * reporting the admin's own (always empty) books. Scoping is decided by the
 * route, which is the only place that knows whether the caller may see across
 * organisers; this function just honours what it is given.
 */
export async function organiserEarnings(organiserId: string | null, period: PeriodKey = "all") {
  // One instant for the whole call: computing "now" per window would let a
  // period and its comparison straddle midnight on a slow request.
  const now = new Date();
  /*
   * The event filter, written out rather than left to an `undefined`.
   *
   * Prisma IGNORES an undefined inside a `where`, so `{ organiserId: scope }`
   * would widen to every event on its own. That is the behaviour wanted here
   * — but it is also the behaviour that emptied this database twice when it
   * happened by accident, so "all organisers" is spelled `{}` where a reader
   * can see the decision instead of inferring it from a null.
   */
  const eventScope = organiserId === null ? {} : { organiserId };

  const orders = await prisma.order.findMany({
    where: {
      event: eventScope,
      status: { in: ["PAID", "REFUNDED"] },
      // A comp is PAID with totalCents 0: it moves no money, but counting it
      // as an order would put the guest list in the sales figures, and
      // sweeping it into a payout would add a zero-value line to every run.
      NOT: { paymentRef: "COMP" },
    },
    select: {
      id: true,
      totalCents: true,
      refundedCents: true,
      feeCents: true,
      createdAt: true,
      payoutOrder: { select: { payoutId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  /*
   * Only ever used to price an order whose fee was never recorded.
   *
   * Platform-wide there is no single organiser whose plan could apply, so the
   * platform default stands in. That affects legacy orders alone — anything
   * settled since commission existed carries its own feeCents, which
   * summariseRevenue prefers over any fallback.
   */
  const fallback = organiserId === null ? await defaultPlan() : await pricingPlanFor(organiserId);
  /*
   * totalCents, deliberately — NOT totalCents minus credit applied.
   *
   * An organiser sold a ticket at face value and is owed that, however the
   * buyer settled it. Paying them less because the buyer spent credit would
   * push the cost of another organiser's cancellation onto them.
   *
   * The consequence is real and belongs to the PLATFORM: a credit-paid order
   * owes the organiser cash that no card ever paid in. Eventick funded it
   * when it granted the credit instead of reversing the original charge —
   * that original charge is money Eventick is still holding, so across the
   * two events the books balance. What does NOT balance is the timing: the
   * cash went out to the second organiser before the first one's payout was
   * reduced, so the float is Eventick's to carry.
   *
   * Visible rather than netted off, because a silent reduction here is how
   * an organiser discovers an unexplained shortfall and nobody can say why.
   */
  const toLine = (o: (typeof orders)[number]): RevenueLine => ({
    totalCents: o.totalCents,
    refundedCents: o.refundedCents,
    feeCents: o.feeCents,
  });

  const lifetime = summariseRevenue(orders.map(toLine), fallback);
  const unpaid = orders.filter((o) => !o.payoutOrder);
  const pending = summariseRevenue(unpaid.map(toLine), fallback);

  /*
   * The same figures, for one period, with the one before it to compare.
   *
   * Filtered in memory rather than re-queried: the full order set is already
   * loaded above for the lifetime and pending figures, and a second and third
   * round trip to the database to re-read rows we are holding would be slower
   * for no benefit at these volumes.
   *
   * `lifetime` and `pending` stay period-INDEPENDENT on purpose. Payouts are
   * settled against everything outstanding, so narrowing "what is owed" to a
   * month would show an organiser a figure that is not what the next transfer
   * will pay them.
   */
  const inWindow = (at: Date, w: { start: Date | null; end: Date | null }) =>
    (!w.start || at >= w.start) && (!w.end || at < w.end);

  const window = windowFor(period, now);
  const previous = previousWindow(period, now);
  const periodOrders = orders.filter((o) => inWindow(o.createdAt, window));
  const current = summariseRevenue(periodOrders.map(toLine), fallback);
  const prior = previous
    ? summariseRevenue(orders.filter((o) => inWindow(o.createdAt, previous)).map(toLine), fallback)
    : null;

  /*
   * Buckets for the bar chart — daily, or weekly past ten weeks.
   *
   * Gross rather than net: the chart answers "when did sales happen", and a
   * refund processed in November against an October sale would otherwise dig
   * a hole in October, which is not when anything went wrong.
   */
  const series = bucketsFor(window, now).map((bucket) => {
    const rows = periodOrders.filter((o) => inWindow(o.createdAt, bucket));
    return {
      start: bucket.start.toISOString(),
      grossCents: rows.reduce((sum, o) => sum + o.totalCents, 0),
      orders: rows.length,
    };
  });

  const [paidOut, organiser] = await Promise.all([
    prisma.payout.aggregate({
      where: { ...(organiserId === null ? {} : { organiserId }), status: "PAID" },
      _sum: { netCents: true },
    }),
    // Platform-wide there is no single plan or bank account to report, so
    // neither is looked up: the response carries the DEFAULT plan and a null
    // account, and the screen renders that honestly.
    organiserId === null
      ? null
      : prisma.user.findUnique({
          where: { id: organiserId },
          select: { plan: true, bankAccount: { select: { holderName: true, rib: true, bank: true } } },
        }),
  ]);

  const plan = organiser?.plan ?? (await defaultPlan()) ?? null;

  /*
   * Every plan, so an organiser can see what else exists.
   *
   * They were shown their own rate and nothing else, which meant someone on
   * Starter's 5% had no way to learn that Pro charges 3% — the cheaper tiers
   * existed, nobody was on one, and there was no moment at which anyone would
   * find out. Changing plan stays an admin action (planNote says so, and the
   * fee is recorded at settlement so a switch must not rewrite past orders);
   * this is the part that lets an organiser know to ask.
   *
   * Rates only. No organiser counts, no revenue — just what each tier costs.
   */
  const catalogue = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });

  /*
   * A plan request still waiting for a decision.
   *
   * Sent so the card can say "requested, pending" rather than offering the
   * button again — asking twice is the obvious thing to do when nothing on
   * screen acknowledges the first attempt.
   *
   * Only for a single organiser: platform-wide there is no one person whose
   * request it would be.
   */
  const openRequest =
    organiserId === null
      ? null
      : await prisma.planRequest.findFirst({
          where: { userId: organiserId, status: "PENDING" },
          select: { id: true, planKey: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        });

  /*
   * Would a different plan have cost less last month?
   *
   * Nobody should be asked to pick a plan before their first sale — the
   * tiers differ only by break-even volume, and a new organiser has no way
   * to know which side of it they are on. So Starter stays the default and
   * this is the prompt that arrives once their own figures answer it.
   *
   * The LAST CLOSED month, not this one: the monthly fee is charged whole
   * whatever the date, so a part-month's sales measured against it would
   * understate every paid plan and the advice would change as the month
   * filled up.
   */
  const lastMonth = windowFor("lastMonth", now);
  const lastMonthGross = orders
    .filter((o) => inWindow(o.createdAt, lastMonth))
    .reduce((sum, o) => sum + o.totalCents - o.refundedCents, 0);

  const currentTerms = plan
    ? { key: plan.key, rateBps: plan.rateBps, monthlyCents: plan.monthlyCents }
    : null;
  const better =
    // Silent platform-wide, and silent while a request is already in flight:
    // the answer to "you should move to Pro" is "we asked, it is pending".
    organiserId === null || !currentTerms || openRequest
      ? null
      : betterPlanAt(
          lastMonthGross,
          currentTerms,
          catalogue.map((row) => ({ key: row.key, rateBps: row.rateBps, monthlyCents: row.monthlyCents })),
        );

  const advice = better
    ? {
        planKey: better.plan.key,
        planLabel: catalogue.find((row) => row.key === better.plan.key)?.label ?? better.plan.key,
        savesCents: better.savesCents,
        /** The volume the advice is based on, so the figure can be shown. */
        basedOnCents: lastMonthGross,
        basedOnMonth: lastMonth.start?.toISOString() ?? null,
      }
    : null;

  // Months already billed, so the UI can say what the subscription has cost
  // rather than leaving the deduction on a payout unexplained.
  const billed = await prisma.subscriptionCharge.aggregate({
    where: organiserId === null ? {} : { organiserId },
    _sum: { amountCents: true },
    _count: { _all: true },
  });

  return {
    plan: plan
      ? {
          key: plan.key,
          label: plan.label,
          rateBps: plan.rateBps,
          monthlyCents: plan.monthlyCents,
          // True when the organiser has no plan of their own and is being
          // charged the default; the UI says so rather than implying a choice.
          assigned: Boolean(organiser?.plan),
        }
      : null,
    /** A request awaiting a decision, so the card does not offer it twice. */
    /**
     * A cheaper plan at this organiser's actual volume, or null.
     *
     * Measured over the last CLOSED month, never the current one: the
     * monthly fee is charged in full whether a month is half over or not, so
     * eight days of sales weighed against a whole month's fee would make
     * every paid plan look worse than it is — and the advice would flip as
     * the month filled up.
     *
     * Works downwards too. An organiser whose volume fell should be told
     * they are paying for a plan they have outgrown in the other direction;
     * advice that only ever sells upgrades is marketing, not advice.
     *
     * Null platform-wide (no single plan to compare) and null while a
     * request is already pending, since the answer is "we are on it".
     */
    planAdvice: advice,
    planRequest: openRequest
      ? { planKey: openRequest.planKey, createdAt: openRequest.createdAt.toISOString() }
      : null,
    /** What every tier costs, so the current one can be compared. */
    plans: catalogue.map((row) => ({
      key: row.key,
      label: row.label,
      rateBps: row.rateBps,
      monthlyCents: row.monthlyCents,
      isDefault: row.isDefault,
      current: row.key === plan?.key,
    })),
    lifetime,
    /**
     * One period's figures, the one before it, and a daily/weekly series.
     *
     * Separate from `lifetime` rather than replacing it, because the two
     * answer different questions and the payout screen needs both: "how did
     * October go" and "what are you owed in total".
     */
    period: {
      key: period,
      start: window.start?.toISOString() ?? null,
      end: window.end?.toISOString() ?? null,
      ...current,
      orders: periodOrders.length,
      // Null for "all time", which has nothing before it to compare against.
      previous: prior ? { ...prior } : null,
      series,
    },
    /** Earned but not yet included in any payout. */
    pending,
    paidOutCents: paidOut._sum.netCents ?? 0,
    unpaidOrders: unpaid.length,
    subscription: {
      /** The plan's fixed monthly part, 0 on Starter. */
      monthlyCents: plan?.monthlyCents ?? 0,
      /** Charged to date, across every payout. */
      billedCents: billed._sum.amountCents ?? 0,
      billedMonths: billed._count._all,
    },
    bankAccount: organiser?.bankAccount
      ? {
          holderName: organiser.bankAccount.holderName,
          // Last four only: the full RIB is a payment credential, and the
          // screen that shows earnings does not need it.
          ribLast4: organiser.bankAccount.rib.slice(-4),
          bank: organiser.bankAccount.bank,
        }
      : null,
  };
}

/**
 * Create a payout for everything an organiser has earned and not been paid.
 *
 * Deliberately NOT period-driven from the caller's dates alone: the orders it
 * picks up are those with no payout yet, within the period. Selecting purely
 * by date would double-pay anything a previous run already covered, and the
 * unique index would then reject the whole run rather than skip the overlap.
 */
export async function runPayout(
  organiserId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{
  payoutId: string;
  netCents: number;
  orders: number;
  subscriptionCents: number;
  months: number;
}> {
  if (periodEnd <= periodStart) throw new HttpError(400, "The period must end after it starts");

  const organiser = await prisma.user.findUnique({
    where: { id: organiserId },
    select: { id: true, role: true, bankAccount: { select: { id: true } } },
  });
  if (!organiser) throw new HttpError(404, "Organiser not found");
  // Refusing without bank details is the point: a PENDING payout nobody can
  // actually send is worse than no payout, because it reads as money on its
  // way.
  if (!organiser.bankAccount) {
    throw new HttpError(409, "This organiser has no bank details on file — add them before running a payout");
  }

  const fallback = await pricingPlanFor(organiserId);

  const payout = await prisma.$transaction(async (tx) => {
    const orders = await tx.order.findMany({
      where: {
        event: { organiserId },
        status: { in: ["PAID", "REFUNDED"] },
        // See the note in organiserEarnings: comps are not sales.
        NOT: { paymentRef: "COMP" },
        createdAt: { gte: periodStart, lt: periodEnd },
        // Only what has never been paid. This, not the dates, is what makes
        // a re-run safe.
        payoutOrder: null,
      },
      select: { id: true, totalCents: true, refundedCents: true, feeCents: true, createdAt: true },
    });

    if (orders.length === 0) throw new HttpError(409, "Nothing to pay out for this period");

    const summary = summariseRevenue(
      orders.map((o) => ({ totalCents: o.totalCents, refundedCents: o.refundedCents, feeCents: o.feeCents })),
      fallback,
    );

    /*
     * The plan's fixed monthly fee, for each calendar month this period covers
     * that has not been billed yet.
     *
     * "Pro · 3% + 499/mo" used to charge only the 3%, which made Pro cheaper
     * than Starter's 5% at every volume — the tiers were backwards. Charging
     * it here rather than inventing a billing cycle means it is withheld from
     * money we already hold, and the organiser sees exactly what was taken.
     *
     * Months already billed are skipped, so two runs covering March bill it
     * once. The unique index on (organiserId, month) is the real guarantee;
     * this query just avoids provoking it.
     */
    const plan = await tx.user
      .findUnique({ where: { id: organiserId }, select: { plan: true } })
      .then((u) => u?.plan ?? null);
    const monthlyCents = plan?.monthlyCents ?? 0;

    let billableMonths: Date[] = [];
    if (monthlyCents > 0) {
      /*
       * Only months the organiser actually SOLD IN are billable.
       *
       * Billing every month the period spans sounds right until someone runs
       * a payout over a wide window to sweep up everything outstanding — the
       * UI's own default was 2020 to today, which is 120 months, or 59 880 MAD
       * of subscription against a few hundred of revenue. The run then refused
       * itself, which is a worse outcome than not charging: the organiser
       * cannot be paid at all.
       *
       * A subscription is for a month the platform carried their sales, so a
       * month with no orders in this payout is not one of them. Dormant months
       * are simply not charged rather than accrued as debt — a debt model is a
       * bigger decision than this run should make.
       */
      const monthsWithSales = new Set(orders.map((o) => monthStart(o.createdAt).getTime()));
      const covered = monthsInPeriod(periodStart, periodEnd).filter((month) =>
        monthsWithSales.has(month.getTime()),
      );
      const already = await tx.subscriptionCharge.findMany({
        where: { organiserId, month: { in: covered } },
        select: { month: true },
      });
      const billed = new Set(already.map((row) => row.month.getTime()));
      billableMonths = covered.filter((month) => !billed.has(month.getTime()));
    }
    const subscriptionCents = monthlyCents * billableMonths.length;

    /*
     * The subscription is capped at what the period can actually pay.
     *
     * Charging the full monthly fee regardless meant a quiet month refused
     * its own payout: 485 MAD of revenue against a 499 MAD subscription
     * produced "nothing to transfer", so the organiser received neither the
     * money nor a record of why. Worse, the shortfall was only 14 MAD.
     *
     * So the fee takes what is there and no more. The uncollected remainder
     * is NOT carried forward — that would be a debt model, which is a bigger
     * decision than a payout run should make on its own, and is called out in
     * the test guide as a deliberate limit.
     */
    const subscriptionCharged = Math.min(subscriptionCents, summary.payableCents);
    const netCents = summary.payableCents - subscriptionCharged;

    // A period of fully refunded orders nets zero. Recording it would create a
    // transfer of 0 MAD that someone has to action.
    if (summary.payableCents <= 0) {
      throw new HttpError(409, "This period nets nothing payable — every order in it was refunded");
    }
    // A period whose entire payable amount goes to the subscription leaves
    // nothing to transfer. The months are still billed, so this is recorded
    // rather than refused — refusing would lose the fact that they were
    // charged, and the next run would bill the same months again.
    if (netCents <= 0 && subscriptionCharged <= 0) {
      throw new HttpError(409, "This period nets nothing payable");
    }

    const created = await tx.payout.create({
      data: {
        organiserId,
        periodStart,
        periodEnd,
        grossCents: summary.netRevenueCents,
        feeCents: summary.feeCents,
        subscriptionCents: subscriptionCharged,
        netCents,
        orders: {
          create: orders.map((o) => ({
            orderId: o.id,
            grossCents: o.totalCents - o.refundedCents,
            feeCents: feeAfterRefund(
              o.totalCents,
              o.refundedCents,
              o.feeCents ?? 0,
            ),
          })),
        },
        subscriptions: {
          /*
           * Records what was ACTUALLY taken, which can be less than the
           * plan's monthly fee when the period could not cover it — see the
           * cap above. Writing the full fee here would make these rows
           * disagree with the payout that withheld them, and a reader
           * reconciling the two would find money that never moved.
           *
           * Spread across the billed months in order, so a multi-month run
           * that runs out mid-way shows which months were paid for.
           */
          create: splitAcrossMonths(billableMonths, subscriptionCharged, monthlyCents).map(({ month, amountCents }) => ({
            organiserId,
            month,
            amountCents,
            // Copied so the charge can still be explained after a rate edit.
            planKey: plan!.key,
          })),
        },
      },
      select: { id: true, netCents: true },
    });

    return {
      payoutId: created.id,
      netCents: created.netCents,
      orders: orders.length,
      subscriptionCents: subscriptionCharged,
      months: billableMonths.length,
    };
  });

  logger.info(
    {
      organiserId,
      payoutId: payout.payoutId,
      netCents: payout.netCents,
      orders: payout.orders,
      subscriptionCents: payout.subscriptionCents,
      months: payout.months,
    },
    "payout created",
  );
  return payout;
}

/**
 * Mark a payout as sent.
 *
 * `reference` is the bank's transfer id, and it is required: a payout marked
 * paid with nothing to trace it by cannot be reconciled against a statement,
 * which is the one thing this record exists for.
 */
export async function markPayoutPaid(payoutId: string, reference: string): Promise<void> {
  if (!reference.trim()) throw new HttpError(400, "A bank transfer reference is required");

  const claimed = await prisma.payout.updateMany({
    where: { id: payoutId, status: "PENDING" },
    data: { status: "PAID", reference: reference.trim(), paidAt: new Date() },
  });
  // Guarded rather than a plain update: marking an already-paid payout again
  // would overwrite the real reference and the date it actually went.
  if (claimed.count === 0) {
    const existing = await prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true } });
    if (!existing) throw new HttpError(404, "Payout not found");
    throw new HttpError(409, `This payout is already ${existing.status.toLowerCase()}`);
  }
  logger.info({ payoutId, reference }, "payout marked paid");
}

/**
 * Abandon a PENDING payout, releasing its orders for a later run.
 *
 * Cancelling deletes the PayoutOrder rows, which is what frees the orders: the
 * unique index would otherwise keep them tied to a payout nobody will send.
 */
export async function cancelPayout(payoutId: string, note: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.payout.updateMany({
      where: { id: payoutId, status: "PENDING" },
      data: { status: "CANCELLED", note: note.trim() || null },
    });
    if (claimed.count === 0) {
      const existing = await tx.payout.findUnique({ where: { id: payoutId }, select: { status: true } });
      if (!existing) throw new HttpError(404, "Payout not found");
      // A sent transfer cannot be un-sent by editing a row.
      throw new HttpError(409, `Only a pending payout can be cancelled — this one is ${existing.status.toLowerCase()}`);
    }
    await tx.payoutOrder.deleteMany({ where: { payoutId } });
    // The subscription months go back too. Leaving them would block those
    // months from ever being billed, because the unique index would still see
    // them as charged by a payout nobody is going to send.
    await tx.subscriptionCharge.deleteMany({ where: { payoutId } });
  });
  logger.info({ payoutId }, "payout cancelled, orders and subscription months released");
}
