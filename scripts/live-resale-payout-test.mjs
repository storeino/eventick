/**
 * Live test — a resale seller can see where their money is.
 *
 * The resale money loop has three steps and they happen at different times:
 *
 *   1. The buyer pays. completeResale() voids the seller's ticket, issues a
 *      fresh one to the buyer, and calls refundOrder() on the seller's
 *      original order. That records a DECISION — refundedCents/refundedAt.
 *   2. Nothing moves. CMI has no refund API, so an admin reverses the
 *      transaction by hand in the CMI back office.
 *   3. The admin marks it paid with a bank reference, which is the only
 *      moment the platform can honestly say the money was sent.
 *
 * Between 1 and 3 the seller is owed money and nobody was telling them: the
 * API sent refundedCents/refundedAt to /billets and nothing else, so a seat
 * read "refunded" from the instant it sold. A seller who checked their bank
 * found nothing, and the distinction only existed in the admin console.
 *
 * So this asserts the SELLER'S OWN VIEW at each step, not just the admin's —
 * GET /orders is what /billets renders, and the test fails if it cannot tell
 * step 1 from step 3. The admin-side mechanics (403s, the pending queue, a
 * reference being mandatory) are live-refund-policy-test's job; this is about
 * what reaches the person who is owed.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-resale-payout-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const ACCOUNTS = {
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  // The seller. Buys a seat, lists it, and is owed the face value.
  seller: { email: "client@eventick.ma", password: "client123" },
  // Marking a refund as sent needs finance.refund, which the organiser does
  // not hold — the seller's payout is a platform obligation, not theirs.
  admin: { email: "admin@eventick.ma", password: "admin123" },
};

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
const mad = (cents) => (cents / 100).toFixed(2);
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function call(method, path, { token, orderToken, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orderToken ? { "X-Order-Token": orderToken } : {}),
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
const SLUG_PREFIX = "resale-payout-";

/**
 * Remove everything this suite creates.
 *
 * Matches the slug PREFIX, not this run's suffix, and runs at the start as
 * well as the end: a crashed run otherwise leaves a sold listing and a
 * half-refunded order behind, and the next run's pending-refund queue counts
 * them. Buyer accounts are created per run and deleted here too — the other
 * suites leaving theirs behind is why the platform's organiser list fills up
 * with "Renamed User" rows that never sold anything.
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
  const buyers = await prisma.user.deleteMany({
    where: { email: { startsWith: "resale-payout-buyer-" } },
  });
  return { events: stale.length, buyers: buyers.count };
}

/** A throwaway published event with resale ENABLED — it is opt-in per event. */
async function makeEvent(organiserId, { priceCents = 30000, capacity = 10 } = {}) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  return prisma.event.create({
    data: {
      slug: `${SLUG_PREFIX}${SUFFIX}`,
      organiserId,
      titleFr: "Revente et paiement",
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
      // The gate the whole flow depends on: listTicketForResale refuses with
      // 409 when this is off, so a suite that forgets it tests nothing.
      allowResale: true,
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
  const seller = await login(ACCOUNTS.seller);
  const admin = await login(ACCOUNTS.admin);
  const orgaId = (await call("GET", "/api/auth/me", { token: organiser })).data.user.id;

  const cleanedBefore = await teardown();
  if (cleanedBefore.events || cleanedBefore.buyers) {
    console.log(
      `\x1b[2m(cleared ${cleanedBefore.events} leftover event(s) and ${cleanedBefore.buyers} buyer account(s) from an earlier run)\x1b[0m`,
    );
  }

  const event = await makeEvent(orgaId);
  const tier = event.tiers[0];
  const FACE = tier.priceCents;

  /** The seller's own view — exactly what GET /orders feeds /billets. */
  async function sellerOrder(orderId) {
    const r = await call("GET", "/api/orders", { token: seller });
    if (r.status !== 200) throw new Error(`GET /orders: ${r.status}`);
    return r.data.orders.find((o) => o.id === orderId);
  }

  try {
    // ──────────────────────────────────────────────── seller buys a seat ──
    section("SETUP  the seller buys a seat, then lists it");

    const hold = await call("POST", "/api/orders/hold", {
      token: seller,
      body: { eventSlug: event.slug, lines: [{ tierId: tier.id, qty: 1 }] },
    });
    if (hold.status !== 201) throw new Error(`hold: ${hold.status} ${JSON.stringify(hold.data).slice(0, 140)}`);
    const sellerOrderId = hold.data.order.id;

    const paid = await call("POST", `/api/orders/${sellerOrderId}/pay`, {
      token: seller,
      body: { holderName: "Karim Vendeur", email: ACCOUNTS.seller.email, phone: "0612345678" },
    });
    if (paid.status !== 200) throw new Error(`pay: ${paid.status} — is the backend in MOCK payment mode?`);
    // The pay route answers {mode, settled} — the tickets it minted come
    // back from the order itself, which is also what the confirmation
    // screen reads.
    check("the order settles in mock mode", paid.data?.settled === true, paid.data?.mode);

    const placed = await call("GET", `/api/orders/${sellerOrderId}`, { token: seller });
    check("the seller's order is paid", placed.data?.order?.status === "PAID", placed.data?.order?.status);

    const sellerTicket = placed.data?.order?.tickets?.[0];
    check("the seller holds a valid ticket", sellerTicket?.status === "VALID", sellerTicket?.ref);

    /*
     * Raise the tier price BEFORE listing, which is the regression.
     *
     * The listing used to be priced at the tier's CURRENT price, so a rise
     * after the sale produced a listing worth more than the seller's order
     * had taken: the refund then exceeded what that order could return,
     * threw, and was swallowed — seller out a seat and the money, with
     * nothing in the pending queue. Found in real data at 150 -> 250.
     */
    await prisma.ticketTier.update({
      where: { id: tier.id },
      data: { priceCents: FACE + 10000 },
    });

    const listed = await call("POST", "/api/resale/listings", {
      token: seller,
      body: { ticketId: sellerTicket.id },
    });
    check("the ticket is listed for resale", listed.status === 201, `${listed.status}`);
    check(
      "a tier price rise does not inflate the listing past what the seller paid",
      listed.data?.priceCents === FACE,
      `listed ${mad(listed.data?.priceCents ?? 0)} MAD, tier now ${mad(FACE + 10000)} MAD`,
    );
    const token = listed.data?.token;
    check("the listing carries a buy token", Boolean(token));

    // Before anything sells, the seller is owed nothing and must not be
    // shown a refund line at all.
    const beforeSale = await sellerOrder(sellerOrderId);
    check("before the sale, nothing is owed", beforeSale?.refundedCents === 0, `${beforeSale?.refundedCents}`);
    check("before the sale, no payout is claimed as sent", beforeSale?.refundPaidAt === null);

    // ───────────────────────────────────────────── someone else buys it ──
    section("SALE  a different account buys the listed seat");

    const buyerEmail = `resale-payout-buyer-${SUFFIX}@example.com`;
    const reg = await call("POST", "/api/auth/register", {
      body: { name: "Acheteur Revente", email: buyerEmail, password: "resale-payout-2026" },
    });
    check("a second account exists to buy it", reg.status === 201 || reg.status === 200, `${reg.status}`);
    const buyer = reg.data?.token ?? (await login({ email: buyerEmail, password: "resale-payout-2026" }));

    const buy = await call("POST", `/api/resale/${token}/buy`, {
      token: buyer,
      body: { holderName: "Acheteur Revente", email: buyerEmail, phone: "0698765432" },
    });
    check("the buy completes", buy.status === 200 || buy.status === 201, `${buy.status}`);

    // The seat changed hands: the old QR must be dead and a new one issued.
    const oldTicket = await prisma.ticket.findUnique({ where: { id: sellerTicket.id } });
    check("the seller's ticket is now TRANSFERRED", oldTicket?.status === "TRANSFERRED", oldTicket?.status);

    const listingRow = await prisma.resaleListing.findUnique({
      where: { token },
      select: { status: true, newTicketId: true, priceCents: true },
    });
    check("the listing is SOLD", listingRow?.status === "SOLD", listingRow?.status);

    const newTicket = listingRow?.newTicketId
      ? await prisma.ticket.findUnique({ where: { id: listingRow.newTicketId } })
      : null;
    check("the buyer got a fresh ticket reference", Boolean(newTicket) && newTicket.ref !== sellerTicket.ref, newTicket?.ref);
    check(
      "the new ticket records which one it replaces",
      newTicket?.replacesRef === sellerTicket.ref,
      newTicket?.replacesRef,
    );

    // ──────────────────────────────────────────── what the seller sees ──
    section("SELLER'S VIEW  owed, but not yet paid");

    const owed = await sellerOrder(sellerOrderId);
    check("the seller is owed their face value", owed?.refundedCents === FACE, `${mad(owed?.refundedCents ?? 0)} MAD`);
    check("a refund decision is recorded", Boolean(owed?.refundedAt));

    /*
     * The heart of this suite. refundedAt is set and refundPaidAt is not, and
     * /billets renders those two as different sentences ("en cours" vs
     * "remboursés"). If the API stops sending refundPaidAt, the screen can
     * only ever claim the money arrived — which is what it used to do.
     */
    check(
      "but the API does NOT claim the money was sent",
      owed?.refundPaidAt === null,
      `refundPaidAt=${owed?.refundPaidAt}`,
    );
    check("and no payment reference is shown yet", !owed?.refundPaidRef, `${owed?.refundPaidRef}`);
    check(
      "the seller's own order carries the fields /billets reads",
      "refundPaidAt" in (owed ?? {}) && "refundPaidRef" in (owed ?? {}),
      "refundPaidAt + refundPaidRef present",
    );

    // The admin's queue is the other half: someone has to be told to pay.
    const pending = await call("GET", "/api/platform/refunds/pending", { token: admin });
    check("the payout appears in the admin's pending queue", pending.status === 200);
    const row = pending.data?.refunds?.find((r) => r.orderId === sellerOrderId);
    check("the seller's payout is listed for an admin to action", Boolean(row), row ? `${mad(row.amountCents)} MAD` : "absent");

    // ────────────────────────────────────────────── the admin pays out ──
    section("PAYOUT  an admin reverses it and records the reference");

    const REFERENCE = `CMI-TEST-${SUFFIX}`;
    const mark = await call("POST", `/api/platform/refunds/${sellerOrderId}/paid`, {
      token: admin,
      body: { reference: REFERENCE },
    });
    check("the admin can mark it sent", mark.status === 200, `${mark.status}`);

    const twice = await call("POST", `/api/platform/refunds/${sellerOrderId}/paid`, {
      token: admin,
      body: { reference: "CMI-SECOND-ATTEMPT" },
    });
    check(
      "marking it twice is refused, so the first reference survives",
      twice.status === 409,
      `${twice.status}`,
    );

    // ──────────────────────────────────── what the seller sees, after ──
    section("SELLER'S VIEW  paid, with something to quote");

    const settled = await sellerOrder(sellerOrderId);
    check("the payout now reads as sent", Boolean(settled?.refundPaidAt), `${settled?.refundPaidAt}`);
    check(
      "the seller can see the bank reference to chase",
      settled?.refundPaidRef === REFERENCE,
      settled?.refundPaidRef,
    );
    check(
      "the amount did not change when it was paid",
      settled?.refundedCents === FACE,
      `${mad(settled?.refundedCents ?? 0)} MAD`,
    );

    const afterQueue = await call("GET", "/api/platform/refunds/pending", { token: admin });
    check(
      "and it leaves the admin's pending queue",
      !afterQueue.data?.refunds?.some((r) => r.orderId === sellerOrderId),
    );

    // ───────────────────────────────────────────────────── who sees it ──
    section("ACCESS  a payout is between the seller and the platform");

    const asOrganiser = await call("GET", "/api/platform/refunds/pending", { token: organiser });
    check(
      "an organiser cannot read the platform's refund queue",
      asOrganiser.status === 403,
      `${asOrganiser.status}`,
    );

    const asBuyer = await call("GET", "/api/orders", { token: buyer });
    const leaked = asBuyer.data?.orders?.some((o) => o.id === sellerOrderId);
    check("the buyer cannot see the seller's order or payout", !leaked);
  } finally {
    const cleanedAfter = await teardown();
    section("CLEANUP");
    check("the test event is removed", cleanedAfter.events > 0, `${cleanedAfter.events} event(s)`);
    check(
      "the throwaway buyer account is removed, not left on the platform",
      cleanedAfter.buyers > 0,
      `${cleanedAfter.buyers} account(s)`,
    );
  }

  console.log(
    `\n${"─".repeat(62)}\n` +
      (failures === 0
        ? "\x1b[32m\x1b[1mAll checks passed.\x1b[0m A resale seller can see whether they have been paid."
        : `\x1b[31m\x1b[1m${failures} check(s) failed.\x1b[0m`) +
      `\n${"─".repeat(62)}`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31m", err, "\x1b[0m");
  await teardown().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
