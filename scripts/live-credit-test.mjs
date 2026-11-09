/**
 * Live test — store credit, end to end.
 *
 * An organiser cancels an event, and every buyer with an ACCOUNT gets the
 * money as spendable credit instead of a promise. That is the point: CMI has
 * no refund API, so a bank reversal waits on somebody working the back
 * office by hand, and until they do the buyer has been emailed
 * "remboursé intégralement" and has nothing. Credit settles instantly.
 *
 * What this pins down, because each one is a way to lose or invent money:
 *
 *   - a cancellation grants exactly what was paid, once;
 *   - cancelling twice cannot double a balance (unique index, not a check);
 *   - credit covering an order settles it with NO gateway round trip;
 *   - partial cover leaves the card exactly the remainder;
 *   - credit is never spent unless the buyer asked;
 *   - the balance is SUM(entries) and the entries explain it;
 *   - a GUEST order has no balance, so it stays in the bank queue;
 *   - staff cannot drive a balance negative, and need a reason;
 *   - a customer cannot top up their own balance.
 *
 * The customer is the shared demo account, so every assertion is a DELTA
 * against the starting balance and the suite restores it at the end.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-credit-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const ACCOUNTS = {
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  customer: { email: "client@eventick.ma", password: "client123" },
  // Reading what is still owed to buyers needs finance.refund, which the
  // organiser deliberately does not hold.
  admin: { email: "admin@eventick.ma", password: "admin123" },
};

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
const mad = (cents) => (cents / 100).toFixed(2);
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

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
    data = text.slice(0, 160);
  }
  return { status: res.status, data };
}

async function login({ email, password }) {
  const r = await call("POST", "/api/auth/login", { body: { email, password } });
  if (!r.data?.token) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data.token;
}

const SUFFIX = Date.now();
const SLUG_PREFIX = "credit-flow-";

/**
 * Remove everything this suite creates.
 *
 * Matches the slug PREFIX rather than this run's suffix, and runs at the
 * start as well as the end: a crashed run otherwise leaves a cancelled event
 * and its refunded orders behind, which shifts the next run's figures.
 */
async function teardown() {
  const stale = await prisma.event.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, tiers: { select: { id: true } } },
  });
  for (const ev of stale) {
    const tierIds = ev.tiers.map((t) => t.id);
    await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticketShare.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { eventId: ev.id } });
    await prisma.order.deleteMany({ where: { eventId: ev.id } });
    await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
    await prisma.event.delete({ where: { id: ev.id } });
  }
  return stale.length;
}

/** A throwaway published event owned by the demo organiser. */
async function makeEvent(name, organiserId, { priceCents = 30000, capacity = 10 } = {}) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  return prisma.event.create({
    data: {
      slug: `${SLUG_PREFIX}${name}-${SUFFIX}`,
      organiserId,
      titleFr: `Politique ${name}`,
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
      // This suite buys repeatedly as one account; the per-buyer cap is
      // covered by live-ticketing-test and would only obstruct here.
      maxPerBuyer: 0,
      tiers: {
        create: {
          nameFr: "Place",
          nameAr: "مقعد",
          blurbFr: "b",
          blurbAr: "ب",
          priceCents,
          capacity,
          zoneFr: "Z",
          zoneAr: "ز",
          gateFr: "G",
          gateAr: "ج",
        },
      },
    },
    include: { tiers: true },
  });
}

async function main() {
  const organiser = await login(ACCOUNTS.organiser);
  const customer = await login(ACCOUNTS.customer);
  const admin = await login(ACCOUNTS.admin);
  const orgaId = (await call("GET", "/api/auth/me", { token: organiser })).data.user.id;
  const custId = (await call("GET", "/api/auth/me", { token: customer })).data.user.id;

  const cleanedBefore = await teardown();
  if (cleanedBefore) console.log(`\x1b[2m(cleared ${cleanedBefore} leftover event(s))\x1b[0m`);

  const balance = async () =>
    (await call("GET", "/api/auth/me/credit", { token: customer })).data.balanceCents;

  /** Buy `qty` seats, optionally spending credit. */
  async function buy(event, qty = 1, { useCredit = false } = {}) {
    const tier = event.tiers[0];
    const hold = await call("POST", "/api/orders/hold", {
      token: customer,
      body: { eventSlug: event.slug, lines: [{ tierId: tier.id, qty }] },
    });
    if (hold.status !== 201) {
      throw new Error(`hold: ${hold.status} ${JSON.stringify(hold.data).slice(0, 140)}`);
    }
    const id = hold.data.order.id;
    const paid = await call("POST", `/api/orders/${id}/pay`, {
      token: customer,
      body: {
        holderName: "Karim Client",
        email: ACCOUNTS.customer.email,
        phone: "0612345678",
        useCredit,
      },
    });
    if (paid.status !== 200) {
      throw new Error(`pay: ${paid.status} ${JSON.stringify(paid.data).slice(0, 140)} — backend in MOCK mode?`);
    }
    return { id, pay: paid.data };
  }

  /*
   * Every assertion is a DELTA against the starting balance.
   *
   * The customer is the shared demo account, so a previous run (or a human
   * clicking around) may have left credit on it. Asserting absolute figures
   * would make this suite pass or fail depending on what happened before it,
   * which is how a test starts lying.
   */
  const start = await balance();
  console.log(`\x1b[2m(starting balance ${mad(start)} MAD)\x1b[0m`);

  section("A cancelled event turns every buyer's money into credit");
  const ev1 = await makeEvent("cancelled", orgaId, { priceCents: 30000 });
  await buy(ev1, 2);
  const cancelled = await call("POST", `/api/organiser/events/${ev1.slug}/cancel`, {
    token: admin,
    body: { reason: "Artiste souffrant", notify: false },
  });
  check("cancel succeeds", cancelled.status === 200, `${cancelled.status}`);
  check(
    "it reports the credit it granted",
    cancelled.data?.credited === 1 && cancelled.data?.creditedCents === 60000,
    `credited=${cancelled.data?.credited} cents=${cancelled.data?.creditedCents}`,
  );
  const afterCancel = await balance();
  check(
    "the buyer's balance rose by exactly what they paid",
    afterCancel - start === 60000,
    `${mad(start)} -> ${mad(afterCancel)}`,
  );

  section("Cancelling twice cannot double the balance");
  const twice = await call("POST", `/api/organiser/events/${ev1.slug}/cancel`, {
    token: admin,
    body: { reason: "Deuxieme tentative", notify: false },
  });
  check("a second cancel is refused", twice.status === 409, `${twice.status}`);
  check("the refused attempt moved nothing", (await balance()) === afterCancel, mad(afterCancel));

  section("Credit pays for a cheaper order outright, with no gateway");
  const ev2 = await makeEvent("cheap", orgaId, { priceCents: 15000 });
  const o2 = await buy(ev2, 1, { useCredit: true });
  check("settled as credit, not card", o2.pay.mode === "credit", String(o2.pay.mode));
  check("the whole order was covered", o2.pay.creditAppliedCents === 15000, `${o2.pay.creditAppliedCents}`);
  const afterSpend = await balance();
  check(
    "balance fell by exactly the ticket price",
    afterCancel - afterSpend === 15000,
    `${mad(afterCancel)} -> ${mad(afterSpend)}`,
  );
  const o2row = await prisma.order.findUnique({
    where: { id: o2.id },
    select: { status: true, totalCents: true, creditAppliedCents: true, feeCents: true, gatewayRef: true },
  });
  check("the order is PAID", o2row.status === "PAID", o2row.status);
  check(
    "creditAppliedCents equals the total, so no card was charged",
    o2row.creditAppliedCents === o2row.totalCents,
    `${o2row.creditAppliedCents}/${o2row.totalCents}`,
  );
  check("it never reached a gateway", o2row.gatewayRef === null, String(o2row.gatewayRef));
  check(
    "the platform still took commission on the full face value",
    o2row.feeCents !== null && o2row.feeCents > 0,
    `fee=${o2row.feeCents}`,
  );
  const tickets2 = await prisma.ticket.count({ where: { orderId: o2.id, status: "VALID" } });
  check("a real ticket was issued", tickets2 === 1, `${tickets2}`);

  section("Credit covers part of a dearer order, the card pays the rest");
  /* Priced from the LIVE balance, not a fixed figure.
     The demo customer is shared -- a human clicking around leaves credit on
     it too -- so a hard-coded 1000 MAD event was fully covered by an 1300
     balance and this section tested the opposite of its own name. Balance
     plus 500 guarantees a shortfall whatever it starts at. */
  const before3 = await balance();
  const ev3 = await makeEvent("dear", orgaId, { priceCents: before3 + 50000 });
  const o3 = await buy(ev3, 1, { useCredit: true });
  check("it did NOT settle as credit-only", o3.pay.mode !== "credit", String(o3.pay.mode));
  check(
    "it applied the whole remaining balance and no more",
    o3.pay.creditAppliedCents === before3,
    `applied=${o3.pay.creditAppliedCents} had=${before3}`,
  );
  const o3row = await prisma.order.findUnique({
    where: { id: o3.id },
    select: { totalCents: true, creditAppliedCents: true },
  });
  check(
    "the card was left the remainder, exactly",
    o3row.totalCents - o3row.creditAppliedCents === o3row.totalCents - before3,
    `card=${mad(o3row.totalCents - o3row.creditAppliedCents)}`,
  );
  check("the balance is now zero", (await balance()) === 0, mad(await balance()));

  section("A zero balance changes nothing");
  const ev4 = await makeEvent("broke", orgaId, { priceCents: 5000 });
  const o4 = await buy(ev4, 1, { useCredit: true });
  check("the order still goes through on the card", o4.pay.mode !== "credit", String(o4.pay.mode));
  check("nothing was applied", !o4.pay.creditAppliedCents, `${o4.pay.creditAppliedCents}`);

  section("Credit is never spent unless asked for");
  await prisma.creditEntry.create({
    data: {
      userId: custId,
      amountCents: 20000,
      reason: "ADJUSTMENT",
      label: "Test opt-in",
      note: "live credit test",
    },
  });
  const ev5 = await makeEvent("optin", orgaId, { priceCents: 5000 });
  const o5 = await buy(ev5, 1);
  check("the balance is untouched", (await balance()) === 20000, mad(await balance()));
  check(
    "creditAppliedCents stayed zero",
    !o5.pay.creditAppliedCents,
    `${o5.pay.creditAppliedCents}`,
  );

  section("The ledger explains the balance, and the balance is its sum");
  const statement = (await call("GET", "/api/auth/me/credit", { token: customer })).data;
  const summed = statement.entries.reduce((s, e) => s + e.amountCents, 0);
  check(
    "balance equals SUM(entries)",
    summed === statement.balanceCents,
    `${summed} vs ${statement.balanceCents}`,
  );
  check(
    "every entry carries a label the holder can read",
    statement.entries.every((e) => e.label && e.label.length > 2),
    "ok",
  );
  check(
    "the cancellation is on the ledger under its own reason",
    statement.entries.some((e) => e.reason === "EVENT_CANCELLED"),
    "found",
  );
  check(
    "spends are recorded as PURCHASE and are negative",
    statement.entries.filter((e) => e.reason === "PURCHASE").every((e) => e.amountCents < 0),
    "ok",
  );

  section("A guest order has no balance to credit, and says so");
  const ev6 = await makeEvent("guest", orgaId, { priceCents: 8000 });
  const guestOrder = await prisma.order.create({
    data: {
      eventId: ev6.id,
      customerId: null,
      status: "PAID",
      holderName: "Invite",
      email: `credit-guest-${SUFFIX}@example.com`,
      phone: "0600000000",
      subtotalCents: 8000,
      totalCents: 8000,
      accessToken: `tok-credit-${SUFFIX}`,
      paymentRef: "MOCK-GUEST",
    },
  });
  const cancelled6 = await call("POST", `/api/organiser/events/${ev6.slug}/cancel`, {
    token: admin,
    body: { reason: "Annulation invite", notify: false },
  });
  check("cancel succeeds", cancelled6.status === 200, `${cancelled6.status}`);
  check(
    "the guest is counted, not credited, and not reported as a failure",
    cancelled6.data?.guestOrders === 1 &&
      cancelled6.data?.credited === 0 &&
      cancelled6.data?.failed?.length === 0,
    `guests=${cancelled6.data?.guestOrders} credited=${cancelled6.data?.credited} failed=${cancelled6.data?.failed?.length}`,
  );
  const queue = await call("GET", "/api/platform/refunds/pending", { token: admin });
  check(
    "the guest order is still in the bank-reversal queue, which is the only way to reach them",
    queue.data.refunds.some((r) => r.orderId === guestOrder.id),
    "queued",
  );

  section("A credited buyer is never ALSO paid by bank");
  /*
   * The double-pay bug, pinned down.
   *
   * A cancellation grants credit and leaves refundedCents set, because
   * refundOrder is what voids the tickets and records the decision. The
   * bank-reversal queue selected on refundedCents alone, so the same buyer
   * appeared there too — and an admin working that queue would have sent
   * them the money a SECOND time, once as spendable credit and once by
   * transfer. Found by asking what the old path still does, not by any test.
   */
  const bankQueue = await call("GET", "/api/platform/refunds/pending", { token: admin });
  check(
    "a credited order is not in the bank queue",
    !bankQueue.data.refunds.some((r) => r.orderId === o2.id),
    "absent",
  );
  const creditedOrder = await prisma.order.findFirst({
    where: { customerId: custId, creditEntries: { some: { reason: "EVENT_CANCELLED" } } },
    select: { id: true },
  });
  if (creditedOrder) {
    const payAnyway = await call(`POST`, `/api/platform/refunds/${creditedOrder.id}/paid`, {
      token: admin,
      body: { reference: "SHOULD-BE-REFUSED" },
    });
    check(
      "and marking it paid by hand is refused outright",
      payAnyway.status === 409,
      `${payAnyway.status} ${String(payAnyway.data?.error ?? "").slice(0, 50)}`,
    );
    const bulkAnyway = await call("POST", "/api/platform/refunds/paid-bulk", {
      token: admin,
      body: { orderIds: [creditedOrder.id], reference: "SHOULD-BE-SKIPPED" },
    });
    check(
      "a bulk run skips it rather than paying it",
      bulkAnyway.data?.paid === 0 &&
        bulkAnyway.data?.skipped?.[0]?.reason === "settled_as_credit",
      `paid=${bulkAnyway.data?.paid} reason=${bulkAnyway.data?.skipped?.[0]?.reason}`,
    );
  } else {
    check("a credited order exists to test against", false, "none found");
  }

  section("Support can read one holder's statement");
  /* GET /platform/credit/:userId was shipped untested and unused -- no
     screen called it and no suite touched it. Support needs exactly this
     when a buyer disputes a balance, so it is pinned down here. */
  const staffView = await call("GET", `/api/platform/credit/${custId}`, { token: admin });
  check("an admin can read a holder's statement", staffView.status === 200, `${staffView.status}`);
  check(
    "it names who the balance belongs to",
    staffView.data?.user?.email === ACCOUNTS.customer.email,
    staffView.data?.user?.email,
  );
  check(
    "it agrees with what the holder sees",
    staffView.data?.balanceCents === (await balance()),
    `${staffView.data?.balanceCents} vs ${await balance()}`,
  );
  check(
    "and its entries sum to that balance",
    staffView.data.entries.reduce((s2, e) => s2 + e.amountCents, 0) === staffView.data.balanceCents,
    "ok",
  );
  const missing = await call("GET", "/api/platform/credit/does-not-exist", { token: admin });
  check("an unknown user is a 404, not an empty balance", missing.status === 404, `${missing.status}`);
  const nosy = await call("GET", `/api/platform/credit/${custId}`, { token: customer });
  check("a customer cannot read it", nosy.status === 403, `${nosy.status}`);

  section("Staff can correct a balance, but never below zero");
  const tooMuch = await call("POST", `/api/platform/credit/${custId}/adjust`, {
    token: admin,
    body: { amountCents: -999999, label: "Trop", note: "should be refused" },
  });
  check("an overdraft is refused", tooMuch.status === 409, `${tooMuch.status}`);
  const adj = await call("POST", `/api/platform/credit/${custId}/adjust`, {
    token: admin,
    body: { amountCents: 5000, label: "Geste commercial", note: "live credit test adjustment" },
  });
  check("a grant is accepted", adj.status === 200, `${adj.status}`);
  check("it reports the new balance", adj.data?.balanceCents === 25000, `${adj.data?.balanceCents}`);
  const noNote = await call("POST", `/api/platform/credit/${custId}/adjust`, {
    token: admin,
    body: { amountCents: 1000, label: "Sans motif" },
  });
  check("an adjustment with no note is refused", noNote.status === 400, `${noNote.status}`);

  section("A customer cannot adjust their own balance");
  const selfServe = await call("POST", `/api/platform/credit/${custId}/adjust`, {
    token: customer,
    body: { amountCents: 100000, label: "Cadeau", note: "trying it on" },
  });
  check("refused without finance.refund", selfServe.status === 403, `${selfServe.status}`);

  section("CLEANUP");
  /*
   * Credit entries go FIRST, and explicitly.
   *
   * The order FK is SetNull, so deleting the orders would leave the entries
   * behind with a null orderId — orphaning this suite's credit permanently
   * onto the shared demo account and shifting every later run's figures.
   */
  const mine = await prisma.event.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true },
  });
  const myOrders = await prisma.order.findMany({
    where: { eventId: { in: mine.map((e) => e.id) } },
    select: { id: true },
  });
  const delEntries = await prisma.creditEntry.deleteMany({
    where: {
      OR: [
        { orderId: { in: myOrders.map((o) => o.id) } },
        { userId: custId, note: { in: ["live credit test", "live credit test adjustment"] } },
      ],
    },
  });
  check(`removed ${delEntries.count} credit entries`, delEntries.count > 0, `${delEntries.count}`);
  const removed = await teardown();
  check("all test events removed", removed === mine.length, `${removed}/${mine.length}`);
  const endBalance = await balance();
  check(
    "the demo account's balance is back where it started",
    endBalance === start,
    `${mad(start)} -> ${mad(endBalance)}`,
  );

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`\x1b[1mTOTAL: ${failures === 0 ? "all checks passed" : `${failures} FAILURE(S)`}\x1b[0m`);
  console.log("──────────────────────────────────────────────────────────────");
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31m" + (err?.stack || err) + "\x1b[0m");
  await prisma.$disconnect();
  process.exit(1);
});
