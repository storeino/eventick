import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { summariseRevenue } from "../domain/commission.js";
import { cancelPayout, markPayoutPaid, organiserEarnings, runPayout } from "../lib/payout.js";
import { listAudit } from "../lib/audit.js";
import { AUDIT_ACTIONS, recordAudit } from "../lib/audit.js";
import { sendEmail } from "../lib/email.js";
import { refundSentHtml, refundSentSubject } from "../lib/email-templates.js";
import { logger } from "../lib/logger.js";
import { creditBalance, creditStatement, grantCredit } from "../lib/credit.js";

/**
 * The platform console — what someone running the marketplace needs, as
 * opposed to what an organiser needs.
 *
 * An admin's /pro dashboard was an ORGANISER dashboard with bigger numbers:
 * the same four tiles (encaissé, billets, entrées), summed across everyone
 * because scope.any widens the query. That answers "how are my events
 * doing", which an admin does not have. It does not answer how many
 * organisers exist, whether anyone is waiting for approval, how many of
 * them have never sold anything, or whether refunds are climbing.
 *
 * Gated on scope.any AND finance.view, not users.manage: this is money
 * across every organiser on the platform, so the two capabilities it
 * actually needs are "may act beyond your own rows" and "may see revenue".
 * users.manage is about editing accounts, which is a different question.
 */

export const platformRouter = Router();

platformRouter.use(authenticate, requirePermission("scope.any"), requirePermission("finance.view"));

/** Start of the UTC day, `days` ago. */
function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

platformRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const weekAgo = daysAgo(7);
    const prevWeek = daysAgo(14);

    const [
      usersByRole,
      ordersByStatus,
      eventsByStatus,
      ticketsByStatus,
      paidTotals,
      refundTotals,
      pendingApplications,
      newUsersThisWeek,
      paidThisWeek,
      paidPrevWeek,
    ] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.event.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ["status"], _count: { _all: true } }),
      // Gross counts PAID and REFUNDED alike: a refunded order was still a
      // sale that happened. Netting them into one figure would hide the
      // refund rate, which is the number worth watching.
      prisma.order.aggregate({
        where: { status: { in: ["PAID", "REFUNDED"] } },
        _sum: { totalCents: true },
        _count: { _all: true },
      }),
      prisma.order.aggregate({ _sum: { refundedCents: true } }),
      prisma.organiserApplication.count({ where: { status: "PENDING" } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.order.aggregate({
        where: { status: { in: ["PAID", "REFUNDED"] }, createdAt: { gte: weekAgo } },
        _sum: { totalCents: true },
      }),
      prisma.order.aggregate({
        where: { status: { in: ["PAID", "REFUNDED"] }, createdAt: { gte: prevWeek, lt: weekAgo } },
        _sum: { totalCents: true },
      }),
    ]);

    const countOf = <T extends string>(rows: Array<{ _count: { _all: number } }>, key: T, field: string) =>
      rows.find((r) => (r as unknown as Record<string, unknown>)[field] === key)?._count._all ?? 0;

    const grossCents = paidTotals._sum.totalCents ?? 0;
    const refundedCents = refundTotals._sum.refundedCents ?? 0;
    const thisWeekCents = paidThisWeek._sum.totalCents ?? 0;
    const prevWeekCents = paidPrevWeek._sum.totalCents ?? 0;

    res.json({
      users: {
        total: usersByRole.reduce((sum, r) => sum + r._count._all, 0),
        customers: countOf(usersByRole, "CUSTOMER", "role"),
        organisers: countOf(usersByRole, "ORGANISER", "role"),
        admins: countOf(usersByRole, "ADMIN", "role"),
        newThisWeek: newUsersThisWeek,
      },
      /** Waiting on an admin. The one number that is a to-do, not a metric. */
      pendingApplications,
      events: {
        published: countOf(eventsByStatus, "PUBLISHED", "status"),
        hidden: countOf(eventsByStatus, "HIDDEN", "status"),
        draft: countOf(eventsByStatus, "DRAFT", "status"),
        cancelled: countOf(eventsByStatus, "CANCELLED", "status"),
      },
      orders: {
        paid: countOf(ordersByStatus, "PAID", "status"),
        refunded: countOf(ordersByStatus, "REFUNDED", "status"),
        cancelled: countOf(ordersByStatus, "CANCELLED", "status"),
        pending: countOf(ordersByStatus, "PENDING", "status"),
      },
      tickets: {
        valid: countOf(ticketsByStatus, "VALID", "status"),
        used: countOf(ticketsByStatus, "USED", "status"),
        cancelled: countOf(ticketsByStatus, "CANCELLED", "status"),
        transferred: countOf(ticketsByStatus, "TRANSFERRED", "status"),
      },
      revenue: {
        grossCents,
        refundedCents,
        netCents: grossCents - refundedCents,
        /** Share of gross handed back, in basis points to stay integer. */
        refundRateBp: grossCents > 0 ? Math.round((refundedCents / grossCents) * 10_000) : 0,
        thisWeekCents,
        prevWeekCents,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

/**
 * Everyone who runs events, ranked by what they have actually sold.
 *
 * The number that matters to a marketplace is not how many organisers
 * signed up but how many are selling — so this includes the ones with zero,
 * rather than filtering them out and hiding the problem.
 *
 * Selected by "holds the role OR owns events", not by role alone. The first
 * version filtered on role: "ORGANISER" and reported 3 events while the
 * platform had 17 — the other 14 belong to the admin account, which runs
 * house events and is invisible to a role filter. Anyone selling belongs on
 * a page about who is selling, whatever their role says.
 */
platformRouter.get(
  "/organisers",
  asyncHandler(async (_req, res) => {
    const organisers = await prisma.user.findMany({
      where: { OR: [{ role: "ORGANISER" }, { events: { some: {} } }] },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        events: { select: { id: true } },
        plan: { select: { key: true, label: true, rateBps: true, monthlyCents: true } },
        // Whether a transfer is even possible. runPayout refuses without it,
        // so a row showing money owed and no account is the one an admin has
        // to chase rather than pay.
        bankAccount: { select: { id: true } },
      },
    });

    const defaultPlan = await prisma.plan.findFirst({ where: { isDefault: true } });

    const rows = await Promise.all(
      organisers.map(async (organiser) => {
        const eventIds = organiser.events.map((e) => e.id);
        // Net of refunds, not gross: a leaderboard that ranks by money since
        // returned to buyers flatters whoever refunds the most.
        const orders =
          eventIds.length === 0
            ? []
            : await prisma.order.findMany({
                where: { eventId: { in: eventIds }, status: { in: ["PAID", "REFUNDED"] } },
                select: {
                  totalCents: true,
                  refundedCents: true,
                  feeCents: true,
                  // Comps are PAID at 0 cents and must not count as money owed.
                  paymentRef: true,
                  // Null when the order has never been swept into a payout —
                  // which is exactly what "still owed" means.
                  payoutOrder: { select: { payoutId: true } },
                },
              });
        // An unrecorded fee is priced at THIS organiser's plan, not the
        // platform default: charging a Pro organiser at Starter's rate was
        // the bug, and the row already knows which plan they are on.
        const totals = summariseRevenue(orders, organiser.plan ?? defaultPlan ?? undefined);

        /*
         * What a payout run would transfer right now.
         *
         * An admin had no way to see who was owed anything without opening
         * each organiser in turn, so the page that lists everyone could not
         * answer the question it exists for. Computed through the same
         * summariseRevenue() the payout uses, against the same filter —
         * settled, not a comp, not already in a payout — so this figure and
         * the one on the run match rather than merely resembling each other.
         *
         * It excludes the plan's monthly subscription, which is charged per
         * calendar month at run time and cannot be known from orders alone.
         */
        const owedOrders = orders.filter((o) => !o.payoutOrder && o.paymentRef !== "COMP");
        const owed = summariseRevenue(owedOrders, organiser.plan ?? defaultPlan ?? undefined);

        return {
          id: organiser.id,
          name: organiser.name,
          email: organiser.email,
          // Surfaced because an ADMIN can appear here, and "why is the admin
          // on the organiser leaderboard" is a fair question the row should
          // answer itself.
          role: organiser.role,
          joinedAt: organiser.createdAt.toISOString(),
          events: eventIds.length,
          orders: orders.length,
          grossCents: totals.netRevenueCents,
          feeCents: totals.feeCents,
          plan: organiser.plan?.key ?? null,
          planLabel: organiser.plan?.label ?? null,
          /** Owed right now: what a payout run would transfer today. */
          owedCents: owed.payableCents,
          owedOrders: owedOrders.length,
          /*
           * How much of what they sold came back.
           *
           * In basis points so the API stays integer, like every other rate
           * here. This is the figure that separates "sells a lot" from
           * "sells a lot and keeps it" — a leaderboard ranked on revenue
           * alone flatters whoever refunds the most, which is the bug the
           * net-of-refunds comment above already guards against for the
           * total but could not express per organiser.
           */
          refundRateBp:
            totals.grossCents > 0 ? Math.round((totals.refundedCents / totals.grossCents) * 10_000) : 0,
          refundedCents: totals.refundedCents,
          /** False means a payout would be refused — chase, do not pay. */
          hasBankAccount: Boolean(organiser.bankAccount),
        };
      }),
    );

    rows.sort((a, b) => b.grossCents - a.grossCents || b.events - a.events);
    res.json({ organisers: rows });
  }),
);

// ─── Plans and payouts ───────────────────────────────────────────────────
//
// Commission used to be a browser-side calculation on a plan the organiser
// chose themselves, and "Reversement" named a payout that did not exist.
// These routes are the admin half of making both real.

/** The plans on offer, for the assignment dropdown. */
platformRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({
      plans: plans.map((plan) => ({
        key: plan.key,
        label: plan.label,
        rateBps: plan.rateBps,
        monthlyCents: plan.monthlyCents,
        isDefault: plan.isDefault,
      })),
    });
  }),
);

const assignPlanSchema = z.object({
  /** Null clears the assignment, putting the organiser back on the default. */
  planKey: z.string().nullable(),
});

/**
 * Put an organiser on a commission plan.
 *
 * Admin-only, by the router's scope.any + finance.view gate. Changing a plan
 * affects only FUTURE orders: the fee on each past order was recorded at
 * settlement and is deliberately not recomputed, so moving someone to a
 * cheaper plan cannot rewrite what they already owed.
 */
platformRouter.patch(
  "/organisers/:id/plan",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = assignPlanSchema.parse(req.body ?? {});

    const organiser = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, planId: true } });
    if (!organiser) throw new HttpError(404, "User not found");

    if (body.planKey !== null) {
      const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
      if (!plan) throw new HttpError(400, "No such plan");
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { planId: body.planKey },
      select: { id: true, name: true, plan: { select: { key: true, label: true } } },
    });

    recordAudit(req, {
      action: AUDIT_ACTIONS.ORGANISER_PLAN_ASSIGNED,
      subjectType: "user",
      subjectId: updated.id,
      subjectLabel: updated.name,
      // Both ends, because "assigned Pro" alone does not say what it replaced.
      details: { from: organiser.planId ?? null, to: body.planKey },
    });

    res.json({
      id: updated.id,
      name: updated.name,
      plan: updated.plan?.key ?? null,
      planLabel: updated.plan?.label ?? null,
      // Says plainly that nothing historical moved, because "changed the
      // plan" invites exactly that assumption.
      note: "Applies to orders settled from now on; past commission is unchanged.",
    });
  }),
);

/**
 * Plan requests waiting for a decision.
 *
 * Organisers can read what each tier costs but cannot switch themselves — the
 * subscription that buys a lower rate is withheld from payouts, so anyone
 * with no payouts would get 2% for nothing. They ask here instead, and this
 * is the queue.
 */
platformRouter.get(
  "/plan-requests",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "PENDING";
    const known = ["PENDING", "APPROVED", "DECLINED", "CANCELLED"];
    const requests = await prisma.planRequest.findMany({
      where: known.includes(status) ? { status: status as never } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        planKey: true,
        fromPlanKey: true,
        note: true,
        createdAt: true,
        reviewedAt: true,
        decisionNote: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // The rates, so a row can be read without a second lookup: "wants Pro"
    // means nothing without knowing Pro is 3% + 499.
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
    const byKey = new Map(plans.map((p) => [p.key, p]));

    res.json({
      requests: requests.map((r) => ({
        id: r.id,
        status: r.status,
        organiser: r.user,
        planKey: r.planKey,
        planLabel: byKey.get(r.planKey)?.label ?? r.planKey,
        rateBps: byKey.get(r.planKey)?.rateBps ?? null,
        monthlyCents: byKey.get(r.planKey)?.monthlyCents ?? null,
        fromPlanKey: r.fromPlanKey,
        fromPlanLabel: r.fromPlanKey ? (byKey.get(r.fromPlanKey)?.label ?? r.fromPlanKey) : null,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
      })),
    });
  }),
);

const decidePlanSchema = z.object({
  approve: z.boolean(),
  /** Shown to the organiser when declined. */
  note: z.string().max(500).optional(),
});

/**
 * Approve or decline one, and on approval move the organiser.
 *
 * Approving does the assignment itself rather than leaving an admin to do it
 * separately afterwards — a queue that only marks things decided, and relies
 * on someone remembering the second step, is how an approved request ends up
 * never taking effect.
 *
 * The plan is re-read at decision time, not taken from the request: a tier
 * retired between asking and deciding must not be assignable.
 */
platformRouter.post(
  "/plan-requests/:id/decide",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = decidePlanSchema.parse(req.body ?? {});

    const request = await prisma.planRequest.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true, planKey: true, fromPlanKey: true },
    });
    if (!request) throw new HttpError(404, "Request not found");
    if (request.status !== "PENDING") throw new HttpError(409, "This request has already been decided");

    if (!body.approve) {
      await prisma.planRequest.update({
        where: { id },
        data: {
          status: "DECLINED",
          reviewedAt: new Date(),
          reviewedById: req.user!.id,
          decisionNote: body.note?.trim() || null,
        },
      });
      res.json({ status: "DECLINED" });
      return;
    }

    const plan = await prisma.plan.findUnique({ where: { key: request.planKey } });
    if (!plan) throw new HttpError(400, "That plan no longer exists");

    const [, organiser] = await prisma.$transaction([
      prisma.planRequest.update({
        where: { id },
        data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: req.user!.id },
      }),
      prisma.user.update({
        where: { id: request.userId },
        data: { planId: plan.key },
        select: { id: true, name: true },
      }),
    ]);

    // The same action an outright assignment records, because the outcome is
    // identical and a journal that split them by route would hide half the
    // plan changes from anyone reading for "who moved onto Pro".
    recordAudit(req, {
      action: AUDIT_ACTIONS.ORGANISER_PLAN_ASSIGNED,
      subjectType: "user",
      subjectId: organiser.id,
      subjectLabel: organiser.name,
      details: { from: request.fromPlanKey ?? null, to: plan.key, viaRequest: request.id },
    });

    res.json({
      status: "APPROVED",
      plan: plan.key,
      // Same caveat the direct assignment gives: nothing historical moves.
      note: "Applies to orders settled from now on; past commission is unchanged.",
    });
  }),
);

/** Every payout across the platform, newest first. */
platformRouter.get(
  "/payouts",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : null;
    const payouts = await prisma.payout.findMany({
      where: status === "PENDING" || status === "PAID" || status === "CANCELLED" ? { status } : {},
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        grossCents: true,
        feeCents: true,
        subscriptionCents: true,
        netCents: true,
        reference: true,
        createdAt: true,
        paidAt: true,
        organiser: {
          select: {
            id: true,
            name: true,
            email: true,
            bankAccount: { select: { holderName: true, rib: true, bank: true } },
          },
        },
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        status: p.status,
        organiserId: p.organiser.id,
        organiserName: p.organiser.name,
        organiserEmail: p.organiser.email,
        periodStart: p.periodStart.toISOString(),
        periodEnd: p.periodEnd.toISOString(),
        grossCents: p.grossCents,
        feeCents: p.feeCents,
        subscriptionCents: p.subscriptionCents,
        netCents: p.netCents,
        orders: p._count.orders,
        reference: p.reference,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
        // Whoever actions the transfer needs the account. Full RIB here and
        // nowhere else: this route is already behind scope.any + finance.view,
        // and a transfer cannot be made from the last four digits.
        bank: p.organiser.bankAccount
          ? {
              holderName: p.organiser.bankAccount.holderName,
              rib: p.organiser.bankAccount.rib,
              bank: p.organiser.bankAccount.bank,
            }
          : null,
      })),
    });
  }),
);

/** What an organiser is owed right now, before committing to a run. */
platformRouter.get(
  "/organisers/:id/earnings",
  asyncHandler(async (req, res) => {
    res.json(await organiserEarnings(param(req, "id")));
  }),
);

const runPayoutSchema = z.object({
  /** Inclusive start, ISO date or datetime. */
  periodStart: z.string(),
  /** EXCLUSIVE end, so consecutive months do not overlap by a day. */
  periodEnd: z.string(),
});

/**
 * Create a payout for one organiser over one period.
 *
 * Safe to re-run: it only picks up orders that are not already in a payout,
 * so an overlapping period tops up rather than double-paying. The unique
 * index on PayoutOrder.orderId is the backstop if two runs race.
 */
platformRouter.post(
  "/organisers/:id/payouts",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = runPayoutSchema.parse(req.body ?? {});
    const start = new Date(body.periodStart);
    const end = new Date(body.periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new HttpError(400, "periodStart and periodEnd must be valid dates");
    }
    const organiserId = param(req, "id");
    const result = await runPayout(organiserId, start, end);
    recordAudit(req, {
      action: AUDIT_ACTIONS.PAYOUT_CREATED,
      subjectType: "payout",
      subjectId: result.payoutId,
      subjectLabel: `${(result.netCents / 100).toFixed(2)} MAD`,
      details: {
        organiserId,
        netCents: result.netCents,
        orders: result.orders,
        subscriptionCents: result.subscriptionCents,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      },
    });
    res.status(201).json(result);
  }),
);

const markPaidSchema = z.object({
  /** The bank's transfer reference. Required — see markPayoutPaid. */
  reference: z.string().min(1),
});

platformRouter.post(
  "/payouts/:id/paid",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const body = markPaidSchema.parse(req.body ?? {});
    const payoutId = param(req, "id");
    await markPayoutPaid(payoutId, body.reference);
    // Says money left the bank. Nothing in the system verifies that, so the
    // record of who asserted it is the only accountability there is.
    recordAudit(req, {
      action: AUDIT_ACTIONS.PAYOUT_PAID,
      subjectType: "payout",
      subjectId: payoutId,
      details: { reference: body.reference },
    });
    res.json({ ok: true });
  }),
);

platformRouter.post(
  "/payouts/:id/cancel",
  requirePermission("users.manage"),
  asyncHandler(async (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note : "";
    const payoutId = param(req, "id");
    await cancelPayout(payoutId, note);
    recordAudit(req, {
      action: AUDIT_ACTIONS.PAYOUT_CANCELLED,
      subjectType: "payout",
      subjectId: payoutId,
      details: { note: note || null },
    });
    res.json({ ok: true });
  }),
);

// ─── The journal ─────────────────────────────────────────────────────────
//
// Reading it needs the same gate as the rest of this router (scope.any +
// finance.view): the rows describe money moving and accounts changing across
// every organiser, which is precisely what those two capabilities mean.

platformRouter.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const str = (key: string) => (typeof req.query[key] === "string" ? (req.query[key] as string) : undefined);
    const beforeRaw = str("before");
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new HttpError(400, "`before` must be a valid date");

    const events = await listAudit({
      action: str("action"),
      actorId: str("actorId"),
      subjectType: str("subjectType"),
      subjectId: str("subjectId"),
      before,
      limit: Number(str("limit") ?? 50),
    });

    res.json({
      events,
      // The vocabulary, so the filter dropdown does not hardcode a list that
      // drifts from what the server actually records.
      actions: Object.values(AUDIT_ACTIONS),
    });
  }),
);

/*
 * Refunds that have been decided but not yet sent.
 *
 * CMI has no refund API, so refundOrder records the decision, voids the
 * tickets and emails the buyer — and someone still has to reverse the
 * transaction in the CMI back office by hand. Nothing surfaced that anywhere,
 * so a cancelled event left every order reading REFUNDED with no way to tell
 * a buyer who had their money back from one still waiting.
 *
 * It matters most for a resale: the seller's money is held by the platform
 * and the organiser's payout has already been reduced by it, so the seller is
 * owed and nobody was being told.
 */
/**
 * How long a recorded refund may sit unsent before it is a problem.
 *
 * refundOrder() emails the buyer "remboursé intégralement" the moment the
 * organiser clicks cancel, but no money moves there — CMI has no refund API,
 * so somebody has to reverse each charge in the CMI back office by hand. If
 * nobody does, the buyer has been told they were refunded and they were not,
 * and NOTHING in the product noticed. That is the gap this threshold closes.
 *
 * Three days: long enough that a normal back-office run on the next working
 * day is not flagged, short enough that a forgotten cancellation surfaces
 * while the buyer is still merely waiting rather than complaining.
 */
const REFUND_OVERDUE_DAYS = 3;

/** Whole days since a refund was recorded. Null when it has no timestamp. */
function refundAgeDays(refundedAt: Date | null): number | null {
  if (!refundedAt) return null;
  const ms = Date.now() - refundedAt.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

platformRouter.get(
  "/refunds/pending",
  requirePermission("finance.refund"),
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: {
        refundedCents: { gt: 0 },
        refundPaidAt: null,
        /*
         * Not the ones already settled as store credit.
         *
         * A cancellation grants credit AND leaves refundedCents set, because
         * refundOrder is what voids the tickets and records the decision.
         * Without this the same buyer appeared here too, so an admin working
         * the queue would send them the money a SECOND time — once as credit
         * they can already spend, once by bank transfer. Verified: before
         * this filter a credited order showed up with its full amount and
         * isGuest false.
         *
         * Keyed on the ledger rather than on a flag: the credit entry is the
         * fact that the buyer was paid, and a boolean beside it could drift
         * from it. A guest order has no account and so no entry, which is
         * exactly right — it still needs the bank reversal, and still
         * appears here.
         *
         * BOTH reasons, not just cancellation. A resale seller is paid in
         * credit too now, through the same refundOrder call, so filtering
         * on EVENT_CANCELLED alone would have put every credited seller
         * back in this queue and recreated the double-pay bug one feature
         * later.
         */
        creditEntries: { none: { reason: { in: ["EVENT_CANCELLED", "ORDER_REFUND"] } } },
      },
      select: {
        id: true,
        refundedCents: true,
        refundedAt: true,
        refundRef: true,
        gatewayRef: true,
        holderName: true,
        email: true,
        event: { select: { slug: true, titleFr: true, titleAr: true } },
        /*
         * Who to pay, and where.
         *
         * A card refund does not need this -- CMI reverses onto the card it
         * charged. A RESALE does: the platform holds the seller's money, so
         * it goes out as a bank transfer, and without an account on file
         * "Mark as sent" claims a payment nobody could have made.
         *
         * customer is null on a guest order; there is then no account to
         * read and the queue says so rather than showing a blank.
         */
        customer: {
          select: {
            id: true,
            bankAccount: { select: { holderName: true, rib: true, bank: true } },
          },
        },
      },
      orderBy: { refundedAt: "asc" },
    });

    res.json({
      refunds: orders.map((o) => ({
        orderId: o.id,
        amountCents: o.refundedCents,
        refundedAt: o.refundedAt?.toISOString() ?? null,
        /*
         * How long this buyer has been waiting, and whether that is now too
         * long. Computed server-side so every client agrees on the threshold
         * — a UI that decided "overdue" for itself would disagree with the
         * alert, and support would be reading two different answers.
         */
        ageDays: refundAgeDays(o.refundedAt),
        overdue: (refundAgeDays(o.refundedAt) ?? 0) >= REFUND_OVERDUE_DAYS,
        refundRef: o.refundRef,
        /** The CMI transaction to reverse. Null on a mock-settled order. */
        gatewayRef: o.gatewayRef,
        buyerName: o.holderName,
        buyerEmail: o.email,
        eventSlug: o.event.slug,
        eventTitleFr: o.event.titleFr,
        eventTitleAr: o.event.titleAr,
        /*
         * Full RIB, like the payout queue above and for the same reason:
         * this route is behind finance.refund, and a transfer cannot be made
         * from the last four digits. Null means there is nothing on file --
         * the screen has to say so, because that is a refund that cannot be
         * paid yet, not one that is merely waiting.
         */
        bank: o.customer?.bankAccount
          ? {
              holderName: o.customer.bankAccount.holderName,
              rib: o.customer.bankAccount.rib,
              bank: o.customer.bankAccount.bank,
            }
          : null,
        /** A guest order has no account to attach a RIB to at all. */
        isGuest: !o.customer,
      })),
      totalCents: orders.reduce((sum, o) => sum + o.refundedCents, 0),
      /*
       * The alert, as numbers rather than a rendered sentence.
       *
       * overdueCount is what makes a forgotten mass cancellation visible:
       * 400 buyers promised their money and nobody in the back office. It is
       * sent even when zero, so the UI can say "nothing overdue" rather than
       * leaving the reader to infer it from an absence.
       */
      overdueDays: REFUND_OVERDUE_DAYS,
      overdueCount: orders.filter(
        (o) => (refundAgeDays(o.refundedAt) ?? 0) >= REFUND_OVERDUE_DAYS,
      ).length,
      overdueCents: orders
        .filter((o) => (refundAgeDays(o.refundedAt) ?? 0) >= REFUND_OVERDUE_DAYS)
        .reduce((sum, o) => sum + o.refundedCents, 0),
      /** The oldest wait in the queue, which is the number worth escalating on. */
      oldestDays: orders.reduce(
        (max, o) => Math.max(max, refundAgeDays(o.refundedAt) ?? 0),
        0,
      ),
    });
  }),
);

const markRefundPaidSchema = z.object({
  /** The CMI or bank reference for the reversal, so the books can be checked. */
  reference: z.string().trim().min(3).max(120),
});

/**
 * Record that a refund has actually been sent.
 *
 * Does not move money either — nothing here can. It closes the loop on a
 * reversal made by hand elsewhere, which is the only way the platform can
 * know the buyer has been paid.
 *
 * A reference is required rather than optional: "marked as paid" with nothing
 * to check it against is indistinguishable from a mistake, and this is the
 * row someone will be reading months later when a buyer says the money never
 * arrived.
 */
platformRouter.post(
  "/refunds/:id/paid",
  requirePermission("finance.refund"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = markRefundPaidSchema.parse(req.body ?? {});

    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        refundedCents: true,
        refundPaidAt: true,
        /** Present when CMI holds the original charge: reversed onto the card,
         * so no bank account is needed. Absent on a resale payout. */
        gatewayRef: true,
        holderName: true,
        email: true,
        event: { select: { titleFr: true } },
        customer: { select: { bankAccount: { select: { rib: true } } } },
        /** Whether this was already settled as store credit — see below. */
        creditEntries: { where: { reason: { in: ["EVENT_CANCELLED", "ORDER_REFUND"] } }, select: { id: true } },
      },
    });
    if (!order) throw new HttpError(404, "Order not found");
    /*
     * Refuse to record a bank transfer for money already given as credit.
     *
     * The queue filters these out, but a page open since before the
     * cancellation would still show the row, and the click has to be safe —
     * this is the one that would pay the same buyer twice.
     */
    if (order.creditEntries.length > 0) {
      throw new HttpError(
        409,
        "This refund was already settled as store credit — the buyer has the money and can spend it. Nothing is owed by bank transfer.",
      );
    }
    if (order.refundedCents <= 0) throw new HttpError(409, "This order has no refund to pay");
    // Guarded rather than overwritten: marking it twice would hide whichever
    // reference was recorded first, and that is the one someone reconciled.
    if (order.refundPaidAt) throw new HttpError(409, "This refund is already marked as sent");

    /*
     * Refuse to record a transfer to an account that does not exist.
     *
     * This is the whole point of the change. The button said "Mark as sent"
     * and the queue showed a name and an amount and no account number, so
     * the one thing it recorded -- that the seller had been paid -- was the
     * one thing nobody could have done. The seller's Billets page then went
     * green and told them to go and look at a bank account the money was
     * never sent to.
     *
     * A card reversal is exempt: gatewayRef means CMI holds the original
     * charge and reverses it onto the card it came from, which needs no RIB.
     * It is the resale payout -- money the platform holds -- that has
     * nowhere to go without one.
     */
    if (!order.gatewayRef && !order.customer?.bankAccount) {
      throw new HttpError(
        409,
        "No bank account on file for this seller, so there is nowhere to send the money. Ask them to add their RIB in their account first.",
      );
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { refundPaidAt: new Date(), refundPaidRef: body.reference },
      select: { refundPaidAt: true, refundedCents: true },
    });

    recordAudit(req, {
      action: AUDIT_ACTIONS.ORDER_REFUND_PAID,
      subjectType: "order",
      subjectId: id,
      subjectLabel: `${(updated.refundedCents / 100).toFixed(2)} MAD`,
      details: { amountCents: updated.refundedCents, reference: body.reference },
    });

    /*
     * The email that is actually true: the money has now been sent.
     * refundOrder() only promised it was coming — see the note on
     * refundSubject/refundSentSubject. Fire-and-forget, because the payout
     * has already happened and a failed email must not fail the request.
     */
    void sendEmail({
      to: order.email,
      subject: refundSentSubject({
        locale: "fr",
        holderName: order.holderName,
        eventTitle: order.event.titleFr,
        amountCents: updated.refundedCents,
        orderId: order.id,
        reference: body.reference,
      }),
      html: refundSentHtml({
        locale: "fr",
        holderName: order.holderName,
        eventTitle: order.event.titleFr,
        amountCents: updated.refundedCents,
        orderId: order.id,
        reference: body.reference,
      }),
    }).catch((err) => logger.warn({ err, orderId: order.id }, "refund-sent email failed"));

    res.json({ paid: true, paidAt: updated.refundPaidAt?.toISOString() ?? null });
  }),
);

const markRefundsPaidBulkSchema = z.object({
  /** The orders to close out. Named explicitly rather than "everything
   *  pending": the operator reverses a specific batch in the CMI back
   *  office, and a route that marked rows they never saw would record
   *  payments nobody made — the exact bug the single-order guard exists
   *  to prevent. */
  orderIds: z.array(z.string().min(1)).min(1).max(500),
  /** One reference for the batch, e.g. the CMI settlement file name. */
  reference: z.string().trim().min(3).max(120),
});

/**
 * Record a WHOLE BATCH of refunds as sent.
 *
 * A cancelled festival puts every buyer in the queue at once. Closing 400 of
 * them one dialog at a time is not something anyone finishes, so in practice
 * the queue was left half-done — which is worse than either extreme, because
 * the remaining rows look identical to ones nobody has started.
 *
 * Deliberately NOT a bulk UPDATE. Each order goes through the same checks as
 * the single route — already-paid, nothing-to-pay, no-account-on-file — and
 * each gets its own audit entry and its own email. Collapsing that into one
 * updateMany is how a batch silently marks rows that individually would have
 * been refused, and the no-account case is precisely the one that must never
 * be recorded as paid.
 *
 * Partial success is the expected outcome, not an error: the response reports
 * what was closed and what was skipped and why, so the operator can see which
 * rows still need a bank account before they can be paid at all.
 */
platformRouter.post(
  "/refunds/paid-bulk",
  requirePermission("finance.refund"),
  asyncHandler(async (req, res) => {
    const body = markRefundsPaidBulkSchema.parse(req.body ?? {});
    // De-duplicated: the same id twice would attempt the second one against
    // an order this request had just marked, and report its own write as a
    // conflict.
    const ids = [...new Set(body.orderIds)];

    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        refundedCents: true,
        refundPaidAt: true,
        gatewayRef: true,
        holderName: true,
        email: true,
        event: { select: { titleFr: true } },
        customer: { select: { bankAccount: { select: { rib: true } } } },
        /** Already settled as store credit — skipped, never paid again. */
        creditEntries: { where: { reason: { in: ["EVENT_CANCELLED", "ORDER_REFUND"] } }, select: { id: true } },
      },
    });
    const found = new Map(orders.map((o) => [o.id, o]));

    const paid: string[] = [];
    const skipped: { orderId: string; reason: string }[] = [];
    let paidCents = 0;

    for (const id of ids) {
      const order = found.get(id);
      if (!order) {
        skipped.push({ orderId: id, reason: "not_found" });
        continue;
      }
      if (order.refundedCents <= 0) {
        skipped.push({ orderId: id, reason: "nothing_to_pay" });
        continue;
      }
      if (order.refundPaidAt) {
        // Not an error: re-running a batch after a partial failure is the
        // normal way to finish it, and the rows that already went through
        // must be left with their original reference.
        skipped.push({ orderId: id, reason: "already_paid" });
        continue;
      }
      if (order.creditEntries.length > 0) {
        // Settled as store credit. Paying it by bank as well would hand the
        // buyer the same money twice.
        skipped.push({ orderId: id, reason: "settled_as_credit" });
        continue;
      }
      if (!order.gatewayRef && !order.customer?.bankAccount) {
        skipped.push({ orderId: id, reason: "no_bank_account" });
        continue;
      }

      /*
       * Guarded write, not a blind update.
       *
       * `refundPaidAt: null` in the WHERE means two operators working the
       * same queue cannot both close the same row — the loser's update
       * matches nothing and the row keeps the reference that was recorded
       * first, which is the one somebody reconciled against.
       */
      const claimed = await prisma.order.updateMany({
        where: { id: order.id, refundPaidAt: null },
        data: { refundPaidAt: new Date(), refundPaidRef: body.reference },
      });
      if (claimed.count === 0) {
        skipped.push({ orderId: id, reason: "already_paid" });
        continue;
      }

      paid.push(order.id);
      paidCents += order.refundedCents;

      recordAudit(req, {
        action: AUDIT_ACTIONS.ORDER_REFUND_PAID,
        subjectType: "order",
        subjectId: order.id,
        subjectLabel: `${(order.refundedCents / 100).toFixed(2)} MAD`,
        details: {
          amountCents: order.refundedCents,
          reference: body.reference,
          /** So a batch is recognisable as one months later. */
          bulk: true,
          batchSize: ids.length,
        },
      });

      // One email per buyer, same as the single route: this is the message
      // that is actually true, where refundOrder only promised.
      void sendEmail({
        to: order.email,
        subject: refundSentSubject({
          locale: "fr",
          holderName: order.holderName,
          eventTitle: order.event.titleFr,
          amountCents: order.refundedCents,
          orderId: order.id,
          reference: body.reference,
        }),
        html: refundSentHtml({
          locale: "fr",
          holderName: order.holderName,
          eventTitle: order.event.titleFr,
          amountCents: order.refundedCents,
          orderId: order.id,
          reference: body.reference,
        }),
      }).catch((err) => logger.warn({ err, orderId: order.id }, "refund-sent email failed"));
    }

    logger.info(
      { requested: ids.length, paid: paid.length, skipped: skipped.length, paidCents },
      "bulk refund payout recorded",
    );

    res.json({ paid: paid.length, paidCents, skipped });
  }),
);


// ─── Store credit ────────────────────────────────────────────────────────

/**
 * GET /platform/credit/:userId — one holder's balance and statement.
 *
 * Behind finance.view: a balance is money owed, and support answering "where
 * did my credit go" needs the same statement the holder sees.
 */
platformRouter.get(
  "/credit/:userId",
  requirePermission("finance.view"),
  asyncHandler(async (req, res) => {
    const userId = param(req, "userId");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new HttpError(404, "User not found");
    const statement = await creditStatement(userId);
    res.json({ user, ...statement });
  }),
);

const creditAdjustSchema = z.object({
  /** Signed. Positive grants, negative takes away. */
  amountCents: z.number().int().refine((n) => n !== 0, "Amount cannot be zero"),
  /** What the holder sees on their balance screen. */
  label: z.string().trim().min(3).max(120),
  /** Why, for staff. Required — see below. */
  note: z.string().trim().min(5).max(500),
});

/**
 * POST /platform/credit/:userId/adjust — correct a balance by hand.
 *
 * finance.refund, not finance.view: this creates money a buyer can spend.
 *
 * A note is REQUIRED. An adjustment is the one entry on the ledger that no
 * system action explains, so without a reason it is an unexplained movement
 * of money in someone's account — and that is the row an auditor stops on.
 *
 * A negative adjustment is allowed but cannot take a balance below zero: a
 * negative balance is a debt the product has no concept of, and a checkout
 * reading one would refuse every purchase with no way for the buyer to fix
 * it.
 */
platformRouter.post(
  "/credit/:userId/adjust",
  requirePermission("finance.refund"),
  asyncHandler(async (req, res) => {
    const userId = param(req, "userId");
    const body = creditAdjustSchema.parse(req.body ?? {});

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new HttpError(404, "User not found");

    if (body.amountCents > 0) {
      await grantCredit({
        userId,
        amountCents: body.amountCents,
        reason: "ADJUSTMENT",
        label: body.label,
        note: body.note,
        actorId: req.user!.id,
      });
    } else {
      /*
       * Taking credit away. Read-then-write inside one transaction, because
       * the balance is what bounds it: outside a transaction, a concurrent
       * purchase could spend the credit between the check and the write and
       * leave the holder negative.
       */
      await prisma.$transaction(async (tx) => {
        const balance = await creditBalance(userId, tx);
        if (balance + body.amountCents < 0) {
          throw new HttpError(
            409,
            `That would take the balance below zero — only ${(balance / 100).toFixed(2)} MAD is available`,
          );
        }
        await tx.creditEntry.create({
          data: {
            userId,
            amountCents: body.amountCents,
            reason: "ADJUSTMENT",
            label: body.label,
            note: body.note,
            actorId: req.user!.id,
          },
        });
      });
    }

    recordAudit(req, {
      action: AUDIT_ACTIONS.CREDIT_ADJUSTED,
      subjectType: "user",
      subjectId: userId,
      subjectLabel: `${(body.amountCents / 100).toFixed(2)} MAD`,
      details: { amountCents: body.amountCents, label: body.label, note: body.note },
    });

    res.json({ balanceCents: await creditBalance(userId) });
  }),
);
