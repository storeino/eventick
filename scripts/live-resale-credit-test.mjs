/**
 * Live test — a resale seller is paid in STORE CREDIT, with no bank details.
 *
 * Listing used to refuse outright: "Add your bank details before listing a
 * ticket — that is where the money goes when it sells." That was true when a
 * resale payout left as a bank transfer somebody made by hand. It is not any
 * more: a signed-in seller is credited the moment the seat sells, so the
 * guard was blocking the sale to protect a payment path customers no longer
 * use.
 *
 * What this pins down:
 *   - a seller with NO RIB can list;
 *   - when it sells, their BALANCE rises by the face value;
 *   - they are not ALSO queued for a bank transfer (the double-pay bug, one
 *     feature later: the queue filters on the credit ledger, and a resale
 *     grant uses ORDER_REFUND rather than EVENT_CANCELLED);
 *   - the ledger row says what it was for.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-resale-credit-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const SLUG = `resale-credit-${SUFFIX}`;

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
  try { data = JSON.parse(text); } catch { data = text.slice(0, 220); }
  return { status: res.status, data };
}
const login = async (e, p) =>
  (await call("POST", "/api/auth/login", { body: { email: e, password: p } })).data.token;

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
};
const mad = (c) => (c / 100).toFixed(2);

const seller = await login("client@eventick.ma", "client123");
const orga = await login("organisateur@eventick.ma", "orga1234");
const admin = await login("admin@eventick.ma", "admin123");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;
const sellerId = (await call("GET", "/api/auth/me", { token: seller })).data.user.id;

// The whole point: NO bank account on file.
await prisma.bankAccount.deleteMany({ where: { userId: sellerId } });
const hasBank = await prisma.bankAccount.findUnique({ where: { userId: sellerId } });
console.log(`\nseller bank account: ${hasBank ? "present" : "NONE (as intended)"}`);

const start = new Date(Date.now() + 30 * 86_400_000);
const ev = await prisma.event.create({
  data: {
    slug: SLUG, organiserId: orgaId,
    titleFr: "Revente credit", titleAr: "ت", category: "concert", city: "Casablanca",
    venueFr: "S", venueAr: "ق", address: "1", startAt: start, endAt: start, doorsAt: start,
    image: "x.jpg", blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ",
    ageFr: "+18", ageAr: "+18", status: "PUBLISHED", maxPerBuyer: 0, allowResale: true,
    tiers: { create: { nameFr: "P", nameAr: "م", blurbFr: "b", blurbAr: "ب",
      priceCents: 30000, capacity: 10, zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج" } },
  },
  include: { tiers: true },
});

const hold = await call("POST", "/api/orders/hold", {
  token: seller, body: { eventSlug: SLUG, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
});
await call("POST", `/api/orders/${hold.data.order.id}/pay`, {
  token: seller,
  body: { holderName: "Karim Client", email: "client@eventick.ma", phone: "0612345678" },
});
const ticket = await prisma.ticket.findFirst({
  where: { orderId: hold.data.order.id },
  select: { id: true },
});

const balance = async () =>
  (await call("GET", "/api/auth/me/credit", { token: seller })).data.balanceCents;
const before = await balance();

console.log("\n=== Listing with no bank details ===");
const listed = await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: ticket.id } });
check(
  "a seller with no RIB can list a ticket",
  listed.status === 200 || listed.status === 201,
  `${listed.status} ${typeof listed.data === "string" ? listed.data.slice(0, 60) : JSON.stringify(listed.data).slice(0, 90)}`,
);

if (listed.status === 200 || listed.status === 201) {
  const listing = await prisma.resaleListing.findFirst({
    where: { ticketId: ticket.id, status: "LISTED" },
    select: { id: true, token: true, priceCents: true },
  });
  console.log(`listing: ${listing?.id} at ${mad(listing?.priceCents ?? 0)} MAD`);

  console.log("\n=== A stranger buys it ===");
  /* A real account: buying a resold seat requires one, exactly as
     /orders/hold does -- a rule enforced on only one of two doors is not
     enforced. */
  const buyerEmail = `resale-buyer-${SUFFIX}@example.com`;
  await call("POST", "/api/auth/register", {
    body: { name: "Acheteur Revente", email: buyerEmail, password: "buyer12345", phone: "0612345678" },
  });
  const buyerToken = await login(buyerEmail, "buyer12345");
  const buy = await call("POST", `/api/resale/${listing.token}/buy`, {
    token: buyerToken,
    /* Deliberately a name and address the account does NOT own.
       Buying requires a session, so the server takes the buyer from
       req.user and must ignore these -- otherwise a signed-in buyer could
       put any name on a seat their own account owns, and send the
       confirmation somewhere they never read. */
    body: { holderName: "Nom Invente", email: "spoof@example.com", phone: "0611111111" },
  });
  check("the resale sells", buy.status === 200 || buy.status === 201, `${buy.status}`);

  const buyerOrder = await prisma.order.findFirst({
    where: { customer: { email: buyerEmail } },
    orderBy: { createdAt: "desc" },
    select: { holderName: true, email: true },
  });
  check(
    "the order is in the ACCOUNT's name, not the one that was posted",
    buyerOrder?.email === buyerEmail && buyerOrder?.holderName !== "Nom Invente",
    `${buyerOrder?.holderName} <${buyerOrder?.email}>`,
  );

  const after = await balance();
  /*
   * Net of the platform fee, read LIVE rather than assumed.
   *
   * This asserted the full listed price, which only held while the fee was
   * zero. The fee is a configurable setting now, so an admin changing it in
   * the back office broke this test without breaking anything in the app --
   * the seller was always paid the right amount.
   */
  const settings = await call("GET", "/api/platform/settings", { token: admin });
  const feeBps = settings.data?.resaleFeeBps ?? 0;
  const expectedFee = Math.round((listing.priceCents * feeBps) / 10000);
  const expectedSeller = listing.priceCents - expectedFee;
  check(
    "the seller is paid into their BALANCE, not a bank",
    after - before === expectedSeller,
    `${mad(before)} -> ${mad(after)} (+${mad(after - before)}, fee ${feeBps / 100}% = ${mad(expectedFee)})`,
  );

  const queue = await call("GET", "/api/platform/refunds/pending", { token: admin });
  check(
    "and is NOT also queued for a bank transfer",
    !queue.data.refunds.some((r) => r.orderId === hold.data.order.id),
    "absent from queue",
  );

  const entry = await prisma.creditEntry.findFirst({
    where: { userId: sellerId, orderId: hold.data.order.id, reason: "ORDER_REFUND" },
    select: { label: true, amountCents: true },
  });
  check(
    "the ledger says what it was for",
    Boolean(entry?.label?.includes("Revente")),
    entry ? `${mad(entry.amountCents)} — ${entry.label}` : "no entry",
  );
}

// cleanup
const tierIds = ev.tiers.map((t) => t.id);
await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.order.deleteMany({ where: { eventId: ev.id } });
await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
await prisma.event.delete({ where: { id: ev.id } });
await prisma.creditEntry.deleteMany({ where: { userId: sellerId, orderId: null, reason: { not: "ADJUSTMENT" } } });
await prisma.user.deleteMany({ where: { email: { startsWith: "resale-buyer-" } } });

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
