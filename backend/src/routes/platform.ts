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
platformRouter.get(
  "/refunds/pending",
  requirePermission("finance.refund"),
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: { refundedCents: { gt: 0 }, refundPaidAt: null },
      select: {
        id: true,
        refundedCents: true,
        refundedAt: true,
        refundRef: true,
        gatewayRef: true,
        holderName: true,
        email: true,
        event: { select: { slug: true, titleFr: true, titleAr: true } },
      },
      orderBy: { refundedAt: "asc" },
    });

    res.json({
      refunds: orders.map((o) => ({
        orderId: o.id,
        amountCents: o.refundedCents,
        refundedAt: o.refundedAt?.toISOString() ?? null,
        refundRef: o.refundRef,
        /** The CMI transaction to reverse. Null on a mock-settled order. */
        gatewayRef: o.gatewayRef,
        buyerName: o.holderName,
        buyerEmail: o.email,
        eventSlug: o.event.slug,
        eventTitleFr: o.event.titleFr,
        eventTitleAr: o.event.titleAr,
      })),
      totalCents: orders.reduce((sum, o) => sum + o.refundedCents, 0),
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
        holderName: true,
        email: true,
        event: { select: { titleFr: true } },
      },
    });
    if (!order) throw new HttpError(404, "Order not found");
    if (order.refundedCents <= 0) throw new HttpError(409, "This order has no refund to pay");
    // Guarded rather than overwritten: marking it twice would hide whichever
    // reference was recorded first, and that is the one someone reconciled.
    if (order.refundPaidAt) throw new HttpError(409, "This refund is already marked as sent");

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
