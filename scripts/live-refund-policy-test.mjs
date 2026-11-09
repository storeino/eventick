/**
 * Live test — refunds happen for one reason only.
 *
 * The policy: tickets are FINAL SALE. A buyer who changes their mind keeps
 * the charge. Money goes back when the ORGANISER cancels the event, because
 * then there is nothing to attend — no event, no tickets, money returned.
 *
 * Two discretionary paths used to exist and were removed, so this file exists
 * to stop them coming back:
 *
 *   - POST /organiser/orders/:id/refund — an organiser returning money on any
 *     order, for any reason.
 *   - POST /tickets/:id/cancel — a buyer cancelling their own seat. First its
 *     refund was removed, then the route itself: a cancel that paid nothing
 *     handed the seat back to the organiser and kept the buyer's money.
 *
 * What is deliberately NOT removed, and is checked here so a future cleanup
 * does not take it out by association:
 *
 *   - event cancellation, which is the whole point;
 *   - the resale seller payout — removing it would take the seller's money
 *     AND their seat while the platform kept both payments for one seat;
 *   - reconcile-refund, which is not a refund but a record of one already
 *     made in the CMI back office, so the tickets get voided and the books
 *     agree with the gateway.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-refund-policy-test.mjs
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
const SLUG_PREFIX = "refund-policy-";

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
    // Credit entries FIRST, while they still point at these orders.
    // Cancelling an event grants credit, and the order FK is SetNull — so
    // deleting the orders first would orphan the credit onto the shared
    // demo account instead of removing it.
    await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
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

  const cleanedBefore = await teardown();
  if (cleanedBefore) console.log(`\x1b[2m(cleared ${cleanedBefore} leftover event(s) from an earlier run)\x1b[0m`);

  /** Buy `qty` seats on `event` as the customer, settled (mock mode). */
  async function buy(event, qty = 1) {
    const tier = event.tiers[0];
    const hold = await call("POST", "/api/orders/hold", {
      token: customer,
      body: { eventSlug: event.slug, lines: [{ tierId: tier.id, qty }] },
    });
    if (hold.status !== 201) throw new Error(`hold: ${hold.status} ${JSON.stringify(hold.data).slice(0, 120)}`);
    const id = hold.data.order.id;
    const paid = await call("POST", `/api/orders/${id}/pay`, {
      token: customer,
      body: { holderName: "Karim Client", email: ACCOUNTS.customer.email, phone: "0612345678" },
    });
    if (paid.status !== 200) throw new Error(`pay: ${paid.status} — is the backend in MOCK payment mode?`);
    return id;
  }

  const refundedOn = async (orderId) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { refundedCents: true } })).refundedCents;

  // ── 1. The organiser cannot refund on request ───────────────────────────
  section("1. A buyer who changes their mind keeps the charge");
  {
    const event = await makeEvent("keep", orgaId);
    const orderId = await buy(event, 2);

    const gone = await call("POST", `/api/organiser/orders/${orderId}/refund`, {
      token: organiser,
      body: {},
    });
    check(
      "the discretionary refund route no longer exists",
      gone.status === 404,
      `${gone.status}${gone.status === 404 ? "" : " — the route is back"}`,
    );
    check("and nothing was returned", (await refundedOn(orderId)) === 0, `${mad(await refundedOn(orderId))} MAD`);

    /*
     * The buyer cancelling their own seat: the route is GONE.
     *
     * It survived the first pass of this policy as "allowed, but pays
     * nothing", which was worse than removing it — the seat went back to
     * the organiser to resell while the buyer kept the whole charge. The
     * only honest exit for someone who cannot attend is resale, which
     * frees the seat exactly the same way and pays them face value.
     */
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { tickets: { select: { id: true, status: true } } },
    });
    const ticketId = order.tickets[0].id;
    const selfCancel = await call("POST", `/api/tickets/${ticketId}/cancel`, { token: customer, body: {} });
    check(
      "a buyer cannot cancel their own seat at all",
      selfCancel.status === 404,
      `${selfCancel.status}${selfCancel.status === 404 ? "" : " — the route is back"}`,
    );
    check("and nothing was refunded", (await refundedOn(orderId)) === 0, `${mad(await refundedOn(orderId))} MAD`);

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { status: true } });
    check("the seat is still the buyer's", after.status === "VALID", after.status);

    // And the seat was never released to the organiser — 2 of 10 sold.
    const avail = await call("GET", `/api/orders/availability/${event.slug}`);
    check(
      "the seat did not go back on sale",
      avail.data?.remaining?.[event.tiers[0].id] === 8,
      `remaining=${avail.data?.remaining?.[event.tiers[0].id]} (10 capacity, 2 sold)`,
    );
  }

  // ── 2. Cancelling the event refunds everyone ────────────────────────────
  section("2. No event, no tickets, money back");
  {
    const event = await makeEvent("cancel", orgaId);
    const first = await buy(event, 2);
    const second = await buy(event, 1);
    const expected = 2 * 30000 + 1 * 30000;

    const cancelled = await call("POST", `/api/organiser/events/${event.slug}/cancel`, {
      token: organiser,
      body: { reason: "Artiste malade" },
    });
    check("the organiser can call the event off", cancelled.status === 200, `${cancelled.status}`);
    check(
      "every paid order is refunded in that one action",
      cancelled.data?.refunded === 2,
      `${cancelled.data?.refunded} order(s)`,
    );
    check(
      "for the full amount taken",
      cancelled.data?.refundedCents === expected,
      `${mad(cancelled.data?.refundedCents ?? 0)} of ${mad(expected)} MAD`,
    );

    for (const [label, id] of [["first", first], ["second", second]]) {
      const o = await prisma.order.findUniqueOrThrow({
        where: { id },
        include: { tickets: { select: { status: true } } },
      });
      check(
        `the ${label} buyer's order reads REFUNDED`,
        o.status === "REFUNDED" && o.refundedCents === o.totalCents,
        `${o.status} ${mad(o.refundedCents)}/${mad(o.totalCents)} MAD`,
      );
      check(
        `and their tickets are void, so nobody turns up to nothing`,
        o.tickets.every((t) => t.status === "CANCELLED"),
        o.tickets.map((t) => t.status).join(","),
      );
    }

    // Twice would pay twice. The guard matters more than the message.
    const again = await call("POST", `/api/organiser/events/${event.slug}/cancel`, {
      token: organiser,
      body: { reason: "Encore" },
    });
    check("cancelling twice is refused", again.status === 409, `${again.status}`);
  }

  // ── 3. The paths that must survive ──────────────────────────────────────
  section("3. What a cleanup must not take with it");
  {
    const event = await makeEvent("keepers", orgaId);
    const orderId = await buy(event, 1);

    /*
     * reconcile-refund is NOT a refund: it records a reversal already made in
     * the CMI back office so the tickets are voided and the books match the
     * gateway. Without it a buyer who has had their money back keeps a valid
     * ticket. 409 here (no gatewayRef on a mock-settled order) proves the
     * route is still mounted — a 404 would mean it had been removed.
     */
    const reconcile = await call("POST", `/api/organiser/orders/${orderId}/reconcile-refund`, {
      token: organiser,
      body: { amountRefundedCents: 100 },
    });
    check(
      "reconcile-refund is still reachable",
      reconcile.status !== 404,
      `${reconcile.status} (409 expected on a mock order with no gateway reference)`,
    );

    /*
     * /cancel voids tickets WITHOUT returning money, and is what an organiser
     * uses when a buyer must lose the seat but not be paid out.
     */
    const voided = await call("POST", `/api/organiser/orders/${orderId}/cancel`, { token: organiser, body: {} });
    check("an order can still be voided without paying anyone", voided.status === 200, `${voided.status}`);
    check("and that really moves no money", (await refundedOn(orderId)) === 0, `${mad(await refundedOn(orderId))} MAD`);
  }

  // ── 4. A refund that was decided but not yet sent ────────────────
  section("4. Money owed to a buyer is visible until it is sent");
  {
    /*
     * CMI has no refund API. Cancelling an event voids the tickets, records
     * the amount and emails the buyer -- a PERSON then reverses each
     * transaction in the back office. Nothing listed what was outstanding,
     * so a buyer owed money depended on somebody remembering.
     */
    /*
     * A GUEST order, deliberately.
     *
     * A registered buyer is now settled as STORE CREDIT when an event is
     * cancelled -- spendable immediately, no bank involved -- so their order
     * is excluded from this queue on purpose. Paying them here as well would
     * hand them the same money twice.
     *
     * A guest has no account and so no balance, which leaves the bank
     * reversal as the only way to reach them. That is what this queue is for
     * now, and what this section must therefore test.
     */
    const event = await makeEvent("owed", orgaId);
    const guest = await prisma.order.create({
      data: {
        eventId: event.id,
        customerId: null,
        status: "PAID",
        holderName: "Invite Rembourse",
        email: `refund-policy-guest-${SUFFIX}@example.com`,
        phone: "0600000000",
        subtotalCents: 60000,
        totalCents: 60000,
        accessToken: `tok-refund-policy-${SUFFIX}`,
        paymentRef: "MOCK-GUEST",
        /* A gateway reference, as a real card order carries.
           Without one the mark-as-paid route refuses: with no CMI charge to
           reverse and no RIB on file there is nowhere for the money to go,
           which is the guard that stops "paid" being recorded for a payment
           nobody could make. A guest who paid by card has this. */
        gatewayRef: `CMI-GUEST-${SUFFIX}`,
      },
    });
    const orderId = guest.id;
    await call("POST", `/api/organiser/events/${event.slug}/cancel`, {
      token: organiser,
      body: { reason: "Test remboursement" },
    });

    const pending = await call("GET", "/api/platform/refunds/pending", { token: admin });
    const mine = (pending.data?.refunds ?? []).find((r) => r.orderId === orderId);
    check("a refunded order appears as owed", Boolean(mine), mine ? `${mad(mine.amountCents)} MAD` : "absent");
    check(
      "and carries what the back office needs",
      typeof mine?.buyerEmail === "string" && typeof mine?.amountCents === "number",
      `${mine?.buyerEmail}`,
    );

    const noRef = await call("POST", `/api/platform/refunds/${orderId}/paid`, { token: admin, body: { reference: "x" } });
    check("marking it paid without a real reference is refused", noRef.status === 400, `${noRef.status}`);

    const marked = await call("POST", `/api/platform/refunds/${orderId}/paid`, {
      token: admin,
      body: { reference: "CMI-REVERSAL-TEST-001" },
    });
    check("marking it paid works", marked.status === 200, `${marked.status}`);

    const after = await call("GET", "/api/platform/refunds/pending", { token: admin });
    check(
      "and it leaves the owed list",
      !(after.data?.refunds ?? []).some((r) => r.orderId === orderId),
      `${(after.data?.refunds ?? []).length} still owed`,
    );

    const twice = await call("POST", `/api/platform/refunds/${orderId}/paid`, {
      token: admin,
      body: { reference: "CMI-REVERSAL-TEST-002" },
    });
    check("marking it twice is refused", twice.status === 409, `${twice.status}`);

    const asOrganiser = await call("GET", "/api/platform/refunds/pending", { token: organiser });
    check("an organiser cannot read the owed list", asOrganiser.status === 403, `${asOrganiser.status}`);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  section("Cleanup");
  await teardown();
  const left = await prisma.event.count({ where: { slug: { startsWith: SLUG_PREFIX } } });
  check("test data removed", left === 0, `${left} event(s) left`);

  console.log(
    failures === 0
      ? "\n\x1b[32mRefund policy holds: cancelled events only\x1b[0m"
      : `\n\x1b[31m${failures} FAILED\x1b[0m`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await teardown().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
