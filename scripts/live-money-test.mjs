/**
 * Live test — commission and payouts.
 *
 * Three things on the Finance screen used to be fiction: the organiser picked
 * their own plan from a row of buttons, `planCost()` ran in the browser and
 * stored nothing, and "Reversement" named a payout that did not exist.
 * Revenue was also the sum of PAID orders' totals, which counted refunded
 * money as earnings and charged commission on it.
 *
 * The properties under test are the ones money depends on:
 *
 *   - An organiser cannot set their own commission rate.
 *   - The fee is recorded ON THE ORDER when it settles, so changing a plan
 *     never rewrites what was already owed.
 *   - Revenue and commission both follow refunds down.
 *   - A payout needs bank details, cannot be run twice over the same orders,
 *     and cannot be marked paid twice or without a bank reference.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-money-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const ACCOUNTS = {
  admin: { email: "admin@eventick.ma", password: "admin123" },
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  // Buying requires an account, so the suite needs a real buyer to book as.
  customer: { email: "client@eventick.ma", password: "client123" },
};

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
const mad = (cents) => (cents / 100).toFixed(2);

async function login({ email, password }) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`login ${email}: ${JSON.stringify(data).slice(0, 150)}`);
  return data.token;
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 150);
  }
  return { status: res.status, data };
}

const SUFFIX = Date.now();

/*
 * The payout window the checks below use.
 *
 * It starts a month BEFORE the current month, not at the 1st of it. `owed`
 * (pending.payableCents) is a lifetime figure — every settled order not yet
 * in a payout — so a window of "this month only" compares a lifetime number
 * against a one-month transfer. On any day of the month except while the
 * database holds nothing older, those differ, and the suite reports a product
 * fault that is really a window too narrow to contain what it is measuring.
 *
 * That is what happened on 1 November: the demo data from October fell
 * outside the window, the payout correctly transferred nothing from it, and
 * the assertion read 0.00 where it wanted 11 885.00.
 *
 * Still a tight, realistic window rather than the decade-wide one this
 * replaced — that became misleading once the plan subscription was billed per
 * calendar month.
 */
const now = new Date();
const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
const created = { events: [], orders: [] };

/**
 * Remove everything this suite creates.
 *
 * Matches the slug PREFIX, not just this run's suffix, and runs at the START
 * as well as the end — the old version only ran on the success path, so a
 * failure left a settled order behind and the next run's payout swept it in,
 * shifting the totals and failing for an unrelated reason.
 */
async function teardown() {
  const orga = await prisma.user.findUnique({ where: { email: ACCOUNTS.organiser.email }, select: { id: true } });
  if (orga) {
    // Ordered by dependency: charges and join rows before the payouts they
    // hang off, and the payout before the organiser's plan is cleared.
    await prisma.subscriptionCharge.deleteMany({ where: { organiserId: orga.id } });
    await prisma.payoutOrder.deleteMany({ where: { payout: { organiserId: orga.id } } });
    await prisma.payout.deleteMany({ where: { organiserId: orga.id } });
    await prisma.bankAccount.deleteMany({ where: { userId: orga.id } });
    await prisma.user.update({ where: { id: orga.id }, data: { planId: null } });
  }

  const stale = await prisma.event.findMany({ where: { slug: { startsWith: "money-test-" } }, select: { id: true } });
  for (const { id: eventId } of stale) {
    const tiers = await prisma.ticketTier.findMany({ where: { eventId }, select: { id: true } });
    const tierIds = tiers.map((t) => t.id);
    await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { eventId } });
    // Credit entries FIRST, while they still point at these orders.
    // Cancelling an event grants credit, and the order FK is SetNull — so
    // deleting the orders first would orphan the credit onto the shared
    // demo account instead of removing it.
    await prisma.creditEntry.deleteMany({ where: { order: { eventId } } });
    await prisma.order.deleteMany({ where: { eventId } });
    await prisma.ticketTier.deleteMany({ where: { eventId } });
    await prisma.event.delete({ where: { id: eventId } });
  }
}

async function main() {
  const admin = await login(ACCOUNTS.admin);
  const orga = await login(ACCOUNTS.organiser);
  const customer = await login(ACCOUNTS.customer);
  const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;

  // Start clean, whatever an earlier run left behind.
  await teardown();

  // A throwaway event owned by the demo organiser, so the test never depends
  // on seeded revenue and never disturbs it.
  const start = new Date(Date.now() + 30 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      slug: `money-test-${SUFFIX}`,
      organiserId: orgaId,
      titleFr: "Test finance",
      titleAr: "اختبار",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle",
      venueAr: "قاعة",
      address: "1 rue",
      startAt: start,
      endAt: start,
      doorsAt: start,
      image: "x.jpg",
      blurbFr: "b",
      blurbAr: "ب",
      aboutFr: "a",
      aboutAr: "أ",
      ageFr: "+18",
      ageAr: "+18",
      status: "PUBLISHED",
      // 0 = unlimited: this suite buys repeatedly as one email, which the
      // per-buyer limit exists to stop. That limit is covered by
      // live-ticketing-test; here it would only obstruct.
      maxPerBuyer: 0,
      tiers: {
        create: {
          nameFr: "Place",
          nameAr: "مقعد",
          blurbFr: "b",
          blurbAr: "ب",
          priceCents: 50000,
          capacity: 20,
          zoneFr: "Z",
          zoneAr: "ز",
          gateFr: "G",
          gateAr: "ج",
        },
      },
    },
    include: { tiers: true },
  });
  created.events.push(event.id);
  const tier = event.tiers[0];

  /** Buy `qty` seats and settle them (mock mode settles on /pay). */
  async function buy(qty) {
    const hold = await call("POST", "/api/orders/hold", {
      token: customer,
      body: { eventSlug: event.slug, lines: [{ tierId: tier.id, qty }] },
    });
    const id = hold.data.order.id;
    created.orders.push(id);
    await call("POST", `/api/orders/${id}/pay?k=${encodeURIComponent(hold.data.accessToken)}`, {
      body: { holderName: "Money Test", email: `money-${SUFFIX}@eventick.ma`, phone: "0612345678" },
    });
    return id;
  }

  // ── Who may set a commission rate ───────────────────────────────────────
  console.log("\n\x1b[1mOnly an admin sets the plan\x1b[0m");
  {
    const self = await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, {
      token: orga,
      body: { planKey: "business" },
    });
    // The whole point: an organiser choosing their own rate was the bug.
    check("an organiser cannot set their own plan", self.status === 403, `${self.status}`);

    const assigned = await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, {
      token: admin,
      body: { planKey: "pro" },
    });
    check("an admin can assign a plan", assigned.status === 200 && assigned.data.plan === "pro", `${assigned.status} ${assigned.data.plan}`);

    const nonsense = await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, {
      token: admin,
      body: { planKey: "free-lunch" },
    });
    check("an unknown plan is refused", nonsense.status === 400, `${nonsense.status}`);
  }

  // ── The fee is a fact about the sale, not a live calculation ────────────
  console.log("\n\x1b[1mCommission is recorded at settlement\x1b[0m");
  const orderId = await buy(2);
  {
    const row = await prisma.order.findUnique({
      where: { id: orderId },
      select: { totalCents: true, feeCents: true, feePlanKey: true, status: true },
    });
    // pro is 300 bps, so 3% of 1000.00 MAD.
    check("the order settled", row.status === "PAID", row.status);
    check("the fee is stored on the order", row.feeCents === 3000, `${row.feeCents} (expected 3000)`);
    check("the plan that produced it is stored too", row.feePlanKey === "pro", `${row.feePlanKey}`);

    /*
     * THE property that makes the figure trustworthy — asserted twice, and
     * deliberately so.
     *
     * Checking only the stored column passes even if the API ignores it and
     * recomputes the fee from today's plan on every read, which is the same
     * bug seen from the outside: the organiser watches their commission change
     * because someone edited a plan. So the reported figure is checked too,
     * through the route the Finance screen actually calls.
     */
    const reportedOnPro = (await call("GET", "/api/organiser/finance", { token: orga })).data.lifetime.feeCents;

    await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, { token: admin, body: { planKey: "starter" } });
    const after = await prisma.order.findUnique({
      where: { id: orderId },
      select: { feeCents: true, feePlanKey: true },
    });
    check(
      "the stored fee is unchanged by a plan move",
      after.feeCents === 3000 && after.feePlanKey === "pro",
      `${after.feeCents} on ${after.feePlanKey} — starter would recompute to 5000`,
    );

    const reportedOnStarter = (await call("GET", "/api/organiser/finance", { token: orga })).data.lifetime.feeCents;
    // STABILITY is the property, not a particular total: the account may hold
    // other orders. Pinning an absolute figure here made the check fail for
    // the wrong reason once it did.
    check(
      "the REPORTED fee is unchanged too",
      reportedOnStarter === reportedOnPro,
      `pro reported ${mad(reportedOnPro)}, starter reported ${mad(reportedOnStarter)} — must match`,
    );

    await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, { token: admin, body: { planKey: "pro" } });

    /*
     * The organiser can see what the OTHER plans cost.
     *
     * They were shown their own rate and nothing else, so someone on
     * Starter's 5% had no way to learn Pro charges 3% — every organiser sat
     * on the default, and no moment existed at which they would find out.
     * Switching plan stays an admin action; this is what makes it worth
     * asking about. Rates only: no revenue, no organiser counts.
     */
    const onPro = await call("GET", "/api/organiser/finance", { token: orga });
    const tiers = onPro.data.plans ?? [];
    check("finance lists every plan", tiers.length >= 3, `${tiers.length} plan(s)`);

    /*
     * Reporting periods.
     *
     * Every money figure was LIFETIME, which answers "how have we done ever"
     * and leaves "how did October go" unanswerable. `?period=` narrows the
     * revenue block; `lifetime` and `pending` stay whole on purpose, because
     * a payout settles everything outstanding and an organiser shown a
     * month's worth would be reading a number that is not what the next
     * transfer pays them.
     */
    const thisMonth = await call("GET", "/api/organiser/finance?period=month", { token: orga });
    check("a period narrows the revenue block", thisMonth.data.period?.key === "month",
      `${thisMonth.data.period?.key}`);
    check("and carries a window to label it with",
      typeof thisMonth.data.period?.start === "string", `${thisMonth.data.period?.start}`);
    check("the lifetime figures are NOT narrowed by it",
      thisMonth.data.lifetime.grossCents >= thisMonth.data.period.grossCents,
      `lifetime ${mad(thisMonth.data.lifetime.grossCents)} >= period ${mad(thisMonth.data.period.grossCents)}`);
    check("neither is what is payable, which a payout settles in full",
      thisMonth.data.pending.payableCents === (await call("GET", "/api/organiser/finance?period=today", { token: orga }))
        .data.pending.payableCents);

    const lastMonth = await call("GET", "/api/organiser/finance?period=lastMonth", { token: orga });
    check("a closed period has both bounds", Boolean(lastMonth.data.period.start && lastMonth.data.period.end));
    /*
     * Last month must not contain THIS suite's sales, which were made moments
     * ago. It may well contain other sales: seeded and demo orders from
     * previous weeks are real rows on this organiser, and on the 1st of any
     * month they land in "last month".
     *
     * The original assertion was `grossCents === 0`, which only held while the
     * suite happened to run in the same month its data was created. It passed
     * all through October and broke by the calendar on 1 November, with
     * nothing in the product having changed. The window is what is under test
     * here, so compare the windows, not a total that other rows contribute to.
     */
    check("and ends where this month begins, so the two cannot overlap",
      lastMonth.data.period.end === thisMonth.data.period.start,
      `${lastMonth.data.period.end} == ${thisMonth.data.period.start}`);

    const allTime = await call("GET", "/api/organiser/finance?period=all", { token: orga });
    check("all time has no comparison to offer", allTime.data.period.previous === null);
    check("and no chart, having no start to bucket from", allTime.data.period.series.length === 0);
    check("a chart appears for a bounded period", thisMonth.data.period.series.length > 0,
      `${thisMonth.data.period.series.length} bucket(s)`);
    check("the buckets sum to the period's gross",
      thisMonth.data.period.series.reduce((sum, p) => sum + p.grossCents, 0) === thisMonth.data.period.grossCents,
      `${mad(thisMonth.data.period.series.reduce((sum, p) => sum + p.grossCents, 0))}`);

    const nonsense = await call("GET", "/api/organiser/finance?period=decade", { token: orga });
    check("an unknown period falls back to all time rather than erroring",
      nonsense.status === 200 && nonsense.data.period.key === "all", `${nonsense.status}`);

    // The admin comparison columns, on the page that ranks organisers.
    const ranked = await call("GET", "/api/platform/organisers", { token: admin });
    const me = ranked.data.organisers.find((o) => o.id === orgaId);
    check("the organiser list carries a refund rate to compare on",
      typeof me?.refundRateBp === "number", `${(me?.refundRateBp ?? 0) / 100}%`);
    check("and the refunded total behind it", typeof me?.refundedCents === "number", mad(me?.refundedCents ?? 0));

    /*
     * Plan requests: the organiser asks, an admin decides.
     *
     * They could read what each tier costs and had no way to act on it --
     * the card said "get in touch" and offered no means. Switching directly
     * is not an option: the subscription that buys a lower rate is withheld
     * from payouts, so anyone with no payouts would take 2% for nothing.
     */
    await call("DELETE", "/api/organiser/plan-request", { token: orga });
    const onNow = (await call("GET", "/api/organiser/finance", { token: orga })).data.plan.key;
    const target = onNow === "business" ? "pro" : "business";

    const same = await call("POST", "/api/organiser/plan-request", { token: orga, body: { planKey: onNow } });
    check("asking for the plan you are on is refused", same.status === 409, `${same.status}`);

    const asked = await call("POST", "/api/organiser/plan-request", { token: orga, body: { planKey: target } });
    check("an organiser may ASK for a plan", asked.status === 201, `${asked.status}`);
    check("asking does not move them", (await call("GET", "/api/organiser/finance", { token: orga })).data.plan.key === onNow);
    check("a second open request is refused",
      (await call("POST", "/api/organiser/plan-request", { token: orga, body: { planKey: "starter" } })).status === 409);

    const queue = await call("GET", "/api/platform/plan-requests", { token: admin });
    const mine = queue.data.requests.find((r) => r.organiser.id === orgaId);
    check("it reaches the admin queue with its rate", mine?.planKey === target && typeof mine?.rateBps === "number",
      `${mine?.planLabel} ${(mine?.rateBps ?? 0) / 100}%`);
    check("an organiser cannot read that queue",
      (await call("GET", "/api/platform/plan-requests", { token: orga })).status === 403);
    check("nor decide one",
      (await call("POST", `/api/platform/plan-requests/${mine.id}/decide`, { token: orga, body: { approve: true } })).status === 403);

    const approved = await call("POST", `/api/platform/plan-requests/${mine.id}/decide`, { token: admin, body: { approve: true } });
    check("approving moves the organiser", approved.status === 200, `${approved.status}`);
    check("and their screen shows the new plan",
      (await call("GET", "/api/organiser/finance", { token: orga })).data.plan.key === target);
    check("deciding it twice is refused",
      (await call("POST", `/api/platform/plan-requests/${mine.id}/decide`, { token: admin, body: { approve: true } })).status === 409);

    /*
     * The nudge that replaces asking at signup.
     *
     * Nobody should pick a plan before their first sale -- the tiers differ
     * by break-even volume and a new organiser cannot know which side they
     * are on. The advice arrives once their own books answer it, read over
     * the last CLOSED month so a part-month is never weighed against a whole
     * month's fee.
     */
    const withAdvice = await call("GET", "/api/organiser/finance", { token: orga });
    check("advice is absent while a request is pending or volume is low",
      withAdvice.data.planAdvice === null || typeof withAdvice.data.planAdvice?.savesCents === "number",
      JSON.stringify(withAdvice.data.planAdvice));
    check("and it never recommends the plan already held",
      withAdvice.data.planAdvice === null || withAdvice.data.planAdvice.planKey !== withAdvice.data.plan.key,
      `${withAdvice.data.planAdvice?.planKey} vs ${withAdvice.data.plan.key}`);

    // Back to where the suite found them, so later checks price as expected.
    await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, { token: admin, body: { planKey: onNow } });
    check(
      "exactly one is marked as theirs, and it is the one they are on",
      tiers.filter((p) => p.current).length === 1 && tiers.find((p) => p.current)?.key === onPro.data.plan?.key,
      `current=${tiers.find((p) => p.current)?.key} plan=${onPro.data.plan?.key}`,
    );
    check(
      "each carries only a rate and a price",
      tiers.every((p) =>
        Object.keys(p).every((k) => ["key", "label", "rateBps", "monthlyCents", "isDefault", "current"].includes(k))),
      Object.keys(tiers[0] ?? {}).join(", "),
    );
  }

  // ── Refunds take their commission with them ─────────────────────────────
  console.log("\n\x1b[1mRefunds reduce revenue AND commission\x1b[0m");
  {
    const before = await call("GET", "/api/organiser/finance", { token: orga });
    const b = before.data.lifetime;

    /*
     * Through a CANCELLED EVENT, which is the only way money goes back now.
     *
     * This used to call /organiser/orders/:id/refund for a partial 500.00,
     * and that route is gone -- tickets are final sale. The property it was
     * really testing is unchanged and still worth pinning: refunded money
     * must stop earning commission, because the old screen kept charging the
     * full fee on money the organiser had given back.
     *
     * Cancelling refunds the order in FULL, so both figures drop by the
     * whole order rather than half of it.
     */
    const refunding = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalCents: true, feeCents: true, event: { select: { slug: true } } },
    });
    const cancelled = await call("POST", `/api/organiser/events/${refunding.event.slug}/cancel`, {
      token: orga,
      body: { reason: "Test de remboursement" },
    });
    check("cancelling the event refunds its orders", cancelled.status === 200, `${cancelled.status}`);

    const after = await call("GET", "/api/organiser/finance", { token: orga });
    const a = after.data.lifetime;
    check(
      "net revenue drops by the refund",
      a.netRevenueCents === b.netRevenueCents - refunding.totalCents,
      `${mad(b.netRevenueCents)} -> ${mad(a.netRevenueCents)} (less ${mad(refunding.totalCents)})`,
    );
    check(
      "commission goes with it, not charged on money given back",
      a.feeCents === b.feeCents - refunding.feeCents,
      `${mad(b.feeCents)} -> ${mad(a.feeCents)} (less ${mad(refunding.feeCents)})`,
    );
  }

  // ── Bank details gate the payout ────────────────────────────────────────
  console.log("\n\x1b[1mA payout needs somewhere to send it\x1b[0m");
  {
    await prisma.bankAccount.deleteMany({ where: { userId: orgaId } });
    const noBank = await call("POST", `/api/platform/organisers/${orgaId}/payouts`, {
      token: admin,
      body: { periodStart: thisMonthStart, periodEnd: tomorrow },
    });
    // A PENDING payout nobody can send is worse than none: it reads as money
    // already on its way.
    check("a payout without bank details is refused", noBank.status === 409, `${noBank.status}`);

    const shortRib = await call("PUT", "/api/organiser/bank-account", {
      token: orga,
      body: { holderName: "Yasmine Organisatrice", rib: "123" },
    });
    check("a RIB that is not 24 digits is refused", shortRib.status === 400, `${shortRib.status}`);

    const saved = await call("PUT", "/api/organiser/bank-account", {
      token: orga,
      body: { holderName: "Yasmine Organisatrice", rib: "1234 5678 9012 3456 7890 1234", bank: "CIH" },
    });
    check("spacing in a pasted RIB is tolerated", saved.status === 200, `${saved.status}`);
    check("only the last four digits come back", saved.data.ribLast4 === "1234" && !("rib" in saved.data), JSON.stringify(saved.data));
  }

  // ── The run itself ──────────────────────────────────────────────────────
  console.log("\n\x1b[1mRunning a payout\x1b[0m");
  let payoutId;
  {
    const earnings = await call("GET", `/api/platform/organisers/${orgaId}/earnings`, { token: admin });
    const owed = earnings.data.pending.payableCents;

    /*
     * The admin's organiser list must agree with this, to the cent.
     *
     * That page lists everyone who sells, and until now it showed lifetime
     * revenue and nothing about what was OWED — so "who do I pay today" meant
     * opening each organiser in turn. The figure is computed through the same
     * summariseRevenue() against the same filter (settled, not a comp, not
     * already in a payout), and this check is what keeps the two from drifting
     * into merely resembling each other.
     */
    const listed = await call("GET", "/api/platform/organisers", { token: admin });
    const row = (listed.data.organisers ?? []).find((o) => o.id === orgaId);
    check("the organiser list says what is owed", row?.owedCents === owed,
      `list ${mad(row?.owedCents ?? -1)} vs earnings ${mad(owed)}`);
    check("and whether a transfer is even possible", row?.hasBankAccount === true,
      `hasBankAccount=${row?.hasBankAccount}`);

    const run = await call("POST", `/api/platform/organisers/${orgaId}/payouts`, {
      token: admin,
      body: { periodStart: thisMonthStart, periodEnd: tomorrow },
    });
    check("the payout is created", run.status === 201, `${run.status} ${run.data.error ?? ""}`);
    // Ticket revenue minus commission, LESS the plan subscription for the
    // month. `owed` is the pre-subscription figure, so the difference between
    // them must be exactly what was billed — not zero.
    check(
      "it transfers what was owed, less the subscription",
      run.data.netCents === owed - run.data.subscriptionCents,
      `${mad(run.data.netCents)} = ${mad(owed)} - ${mad(run.data.subscriptionCents)}`,
    );
    payoutId = run.data.payoutId;

    // The safeguard that matters: an order belongs to one payout, ever.
    const again = await call("POST", `/api/platform/organisers/${orgaId}/payouts`, {
      token: admin,
      body: { periodStart: thisMonthStart, periodEnd: tomorrow },
    });
    check("re-running the same period pays nothing twice", again.status === 409, `${again.status}`);

    const backwards = await call("POST", `/api/platform/organisers/${orgaId}/payouts`, {
      token: admin,
      body: { periodStart: tomorrow, periodEnd: thisMonthStart },
    });
    check("an inverted period is refused", backwards.status === 400, `${backwards.status}`);
  }

  // ── Marking it sent ─────────────────────────────────────────────────────
  console.log("\n\x1b[1mMarking a payout paid\x1b[0m");
  {
    const noRef = await call("POST", `/api/platform/payouts/${payoutId}/paid`, { token: admin, body: { reference: "" } });
    // Without a reference the row cannot be reconciled against a statement,
    // which is the only reason it exists.
    check("a bank reference is required", noRef.status === 400, `${noRef.status}`);

    const paid = await call("POST", `/api/platform/payouts/${payoutId}/paid`, {
      token: admin,
      body: { reference: `VIR-${SUFFIX}` },
    });
    check("it can be marked paid", paid.status === 200, `${paid.status}`);

    const twice = await call("POST", `/api/platform/payouts/${payoutId}/paid`, {
      token: admin,
      body: { reference: "VIR-OTHER" },
    });
    check("marking it paid twice is refused", twice.status === 409, `${twice.status}`);

    const cancelSent = await call("POST", `/api/platform/payouts/${payoutId}/cancel`, { token: admin, body: {} });
    // A transfer that has gone cannot be un-sent by editing a row.
    check("a sent payout cannot be cancelled", cancelSent.status === 409, `${cancelSent.status}`);

    const frozen = await prisma.payout.findUnique({
      where: { id: payoutId },
      select: { reference: true, netCents: true, paidAt: true },
    });
    check("the real reference survived the second attempt", frozen.reference === `VIR-${SUFFIX}`, frozen.reference);
    check("paidAt is stamped", frozen.paidAt !== null);

    // Totals are copied at creation, so later refunds cannot change what was
    // already paid.
    await call("POST", `/api/organiser/orders/${orderId}/refund`, { token: orga, body: { amountCents: 10000 } });
    const after = await prisma.payout.findUnique({ where: { id: payoutId }, select: { netCents: true } });
    check(
      "a later refund does not change a completed payout",
      after.netCents === frozen.netCents,
      `${mad(frozen.netCents)} -> ${mad(after.netCents)}`,
    );
  }

  // ── Who can see what ────────────────────────────────────────────────────
  console.log("\n\x1b[1mVisibility\x1b[0m");
  {
    const own = await call("GET", "/api/organiser/payouts", { token: orga });
    check("an organiser sees their own payouts", own.status === 200 && own.data.payouts.length > 0, `${own.status} n=${own.data.payouts?.length}`);

    const platform = await call("GET", "/api/platform/payouts", { token: orga });
    check("an organiser cannot list every payout", platform.status === 403, `${platform.status}`);

    const adminList = await call("GET", "/api/platform/payouts", { token: admin });
    const row = adminList.data.payouts?.find((p) => p.id === payoutId);
    // Whoever actions the transfer needs the full RIB; this route is already
    // behind scope.any + finance.view.
    check("an admin sees the RIB to pay from", row?.bank?.rib === "123456789012345678901234", row?.bank?.rib);

    /*
     * An UNFILTERED admin sees the platform, not their own empty books.
     *
     * /organiser/finance and /organiser/payouts fell back to `req.user.id`
     * when no ?organiserId= was given. An admin owns no events, so the screen
     * showed 0.00 revenue, 0.00 payable and "No payouts yet" — above a list
     * of real orders, because /orders/detailed was already platform-wide.
     * The filter on that page says "All organisers", and these two now mean
     * it.
     */
    const adminFinance = await call("GET", "/api/organiser/finance", { token: admin });
    check(
      "an unfiltered admin sees platform revenue, not their own zero",
      adminFinance.data.lifetime.grossCents > 0,
      `${mad(adminFinance.data.lifetime.grossCents)}`,
    );
    check(
      "and the payouts already transferred",
      adminFinance.data.paidOutCents > 0,
      `${mad(adminFinance.data.paidOutCents)}`,
    );

    const adminPayouts = await call("GET", "/api/organiser/payouts", { token: admin });
    check(
      "an unfiltered admin sees every organiser's payouts",
      (adminPayouts.data.payouts ?? []).some((p) => p.id === payoutId),
      `n=${adminPayouts.data.payouts?.length}`,
    );
    check(
      "each row says who was paid, since they are not all the same organiser",
      adminPayouts.data.payouts?.every((p) => typeof p.organiser?.name === "string"),
      adminPayouts.data.payouts?.[0]?.organiser?.name,
    );
    check(
      "an organiser's own list does not repeat their name on every row",
      (own.data.payouts ?? []).every((p) => p.organiser === undefined),
    );

    // Filtering still narrows it, which is what the picker is for.
    const filtered = await call("GET", `/api/organiser/payouts?organiserId=${orgaId}`, { token: admin });
    check(
      "filtering to one organiser narrows the list",
      (filtered.data.payouts ?? []).every((p) => p.organiser?.id === orgaId),
      `n=${filtered.data.payouts?.length}`,
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log("\n\x1b[1mCleanup\x1b[0m");
  await teardown();
  const left = await prisma.event.count({ where: { slug: { startsWith: "money-test-" } } });
  check("test data removed", left === 0, `${left} event(s) left`);

  console.log(
    failures === 0 ? "\n\x1b[32mAll money checks passed\x1b[0m" : `\n\x1b[31m${failures} FAILED\x1b[0m`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  // Tidy up even on the failure path, so one bad run does not poison the next.
  await teardown().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
