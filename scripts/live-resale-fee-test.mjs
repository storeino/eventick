/**
 * Live test — the platform's resale fee.
 *
 * A resale moves an existing seat between two customers. The buyer pays the
 * LISTED price, the platform keeps its percentage, and the seller is
 * credited the rest. The organiser is billed nothing: they were already paid
 * when that seat was first sold, and charging their plan again made their
 * reported commission rise after a resale at a rate they were not on.
 *
 * Checked at 0% (the default, and the behaviour before this existed) and at
 * 2%, because a fee system that only works when it is switched on is half a
 * system.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-resale-fee-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const PREFIX = `resale-fee-${SUFFIX}`;

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
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};
const mad = (c) => (c / 100).toFixed(2);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const seller = await login("client@eventick.ma", "client123");
const admin = await login("admin@eventick.ma", "admin123");
const orga = await login("organisateur@eventick.ma", "orga1234");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;
const sellerId = (await call("GET", "/api/auth/me", { token: seller })).data.user.id;

/* Restored at the end: this is a shared dev database and the rate is a
   platform-wide setting, so leaving it changed would silently alter every
   later run and every click in the browser. */
const originalBps = (await call("GET", "/api/platform/settings", { token: admin })).data.resaleFeeBps;
console.log(`\x1b[2m(resale fee starts at ${(originalBps / 100).toFixed(2)}%)\x1b[0m`);

let eventSeq = 0;
async function makeEvent(priceCents) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  return prisma.event.create({
    data: {
      slug: `${PREFIX}-${eventSeq++}`, organiserId: orgaId,
      titleFr: "Frais revente", titleAr: "ت", category: "concert", city: "Casablanca",
      venueFr: "S", venueAr: "ق", address: "1", startAt: start, endAt: start, doorsAt: start,
      image: "x.jpg", blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ",
      ageFr: "+18", ageAr: "+18", status: "PUBLISHED", maxPerBuyer: 0, allowResale: true,
      tiers: { create: { nameFr: "P", nameAr: "م", blurbFr: "b", blurbAr: "ب",
        priceCents, capacity: 20, zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج" } },
    },
    include: { tiers: true },
  });
}

const balance = async () =>
  (await call("GET", "/api/auth/me/credit", { token: seller })).data.balanceCents;

/** Buy a seat as the seller, list it, and have a stranger buy it. */
async function resell(priceCents, buyerToken) {
  const ev = await makeEvent(priceCents);
  const hold = await call("POST", "/api/orders/hold", {
    token: seller, body: { eventSlug: ev.slug, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
  });
  await call("POST", `/api/orders/${hold.data.order.id}/pay`, {
    token: seller,
    body: { holderName: "Karim Client", email: "client@eventick.ma", phone: "0612345678" },
  });
  const ticket = await prisma.ticket.findFirst({
    where: { orderId: hold.data.order.id }, select: { id: true },
  });
  await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: ticket.id } });
  const listing = await prisma.resaleListing.findFirst({
    where: { ticketId: ticket.id, status: "LISTED" }, select: { token: true, priceCents: true },
  });
  const before = await balance();
  const sold = await call("POST", `/api/resale/${listing.token}/buy`, {
    token: buyerToken, body: { phone: "0611111111" },
  });
  const after = await balance();
  const buyerOrder = await prisma.order.findFirst({
    where: { customer: { email: { startsWith: "fee-buyer-" } }, eventId: ev.id },
    orderBy: { createdAt: "desc" },
    select: { totalCents: true, feeCents: true, feePlanKey: true },
  });
  return {
    ev, sold, listing,
    credited: after - before,
    buyerPaid: buyerOrder?.totalCents ?? 0,
    feeCents: buyerOrder?.feeCents ?? null,
    feePlanKey: buyerOrder?.feePlanKey ?? null,
  };
}

const buyerEmail = `fee-buyer-${SUFFIX}@example.com`;
await call("POST", "/api/auth/register", {
  body: { name: "Acheteur Frais", email: buyerEmail, password: "buyer12345", phone: "0612345678" },
});
const buyerToken = await login(buyerEmail, "buyer12345");

try {
  // ───────────────────────────────────────────────────────── 0%, default ──
  section("At 0% — the default, and what the product did before this existed");
  await call("PUT", "/api/platform/settings", { token: admin, body: { resaleFeeBps: 0 } });
  const free = await resell(30000, buyerToken);
  check("the resale completes", free.sold.status === 200, `${free.sold.status}`);
  check("the buyer pays the listed price", free.buyerPaid === 30000, `${mad(free.buyerPaid)} MAD`);
  check("the seller keeps all of it", free.credited === 30000, `+${mad(free.credited)} MAD`);
  check("and the recorded fee is zero", free.feeCents === 0, `${free.feeCents}`);

  // ──────────────────────────────────────────────────────────────── 2% ──
  section("At 2% — the fee comes out of the SELLER, not the buyer");
  const put = await call("PUT", "/api/platform/settings", { token: admin, body: { resaleFeeBps: 200 } });
  check("an admin can set the rate", put.status === 200, `${put.status} ${JSON.stringify(put.data)}`);

  const paid = await resell(30000, buyerToken);
  check("the resale completes", paid.sold.status === 200, `${paid.sold.status}`);
  check(
    "the buyer still pays the LISTED price, with nothing added",
    paid.buyerPaid === 30000,
    `${mad(paid.buyerPaid)} MAD`,
  );
  check(
    "the platform keeps 2%",
    paid.feeCents === 600,
    `${mad(paid.feeCents ?? 0)} MAD`,
  );
  check(
    "the seller is credited the rest",
    paid.credited === 29400,
    `+${mad(paid.credited)} MAD`,
  );
  check(
    "fee + seller = the price the buyer paid",
    (paid.feeCents ?? 0) + paid.credited === paid.buyerPaid,
    `${mad(paid.feeCents ?? 0)} + ${mad(paid.credited)} = ${mad(paid.buyerPaid)}`,
  );

  // ──────────────────────────────────────────── not the organiser's plan ──
  section("The organiser is not billed for a seat they were already paid for");
  check(
    "the fee is recorded as a resale fee, not under an organiser plan",
    paid.feePlanKey === "resale",
    `feePlanKey=${paid.feePlanKey}`,
  );
  const plan = await prisma.user.findUnique({
    where: { id: orgaId }, select: { plan: { select: { key: true, rateBps: true } } },
  });
  check(
    "and it is the PLATFORM rate, not the organiser's",
    paid.feeCents === 600 && plan?.plan?.rateBps !== 200,
    `platform 2% vs organiser plan ${plan?.plan?.key ?? "default"} ${(plan?.plan?.rateBps ?? 0) / 100}%`,
  );

  // ──────────────────────────────────────────────────────────── guards ──
  section("The rate is a setting, not a free-for-all");
  const tooHigh = await call("PUT", "/api/platform/settings", {
    token: admin, body: { resaleFeeBps: 10001 },
  });
  check("above 100% is refused", tooHigh.status === 400, `${tooHigh.status}`);
  const negative = await call("PUT", "/api/platform/settings", {
    token: admin, body: { resaleFeeBps: -1 },
  });
  check("a negative rate is refused", negative.status === 400, `${negative.status}`);
  const fractional = await call("PUT", "/api/platform/settings", {
    token: admin, body: { resaleFeeBps: 1.5 },
  });
  check("a fractional basis point is refused", fractional.status === 400, `${fractional.status}`);
  const asCustomer = await call("PUT", "/api/platform/settings", {
    token: seller, body: { resaleFeeBps: 0 },
  });
  check("a customer cannot set the platform's rate", asCustomer.status === 403, `${asCustomer.status}`);
  const readAsCustomer = await call("GET", "/api/platform/settings", { token: seller });
  check("nor read it", readAsCustomer.status === 403, `${readAsCustomer.status}`);

  section("A rate change applies to future resales only");
  /* The fee is recorded on the order when it settles and never recomputed,
     exactly as plan commission is. Lowering the rate must not hand money
     back on a sale that already happened. */
  await call("PUT", "/api/platform/settings", { token: admin, body: { resaleFeeBps: 0 } });
  const stillCharged = await prisma.order.findFirst({
    where: { feePlanKey: "resale", feeCents: 600 },
    orderBy: { createdAt: "desc" },
    select: { feeCents: true },
  });
  check(
    "a settled resale keeps the fee it was charged",
    stillCharged?.feeCents === 600,
    `${mad(stillCharged?.feeCents ?? 0)} MAD`,
  );
} finally {
  section("CLEANUP");
  const restored = await call("PUT", "/api/platform/settings", {
    token: admin, body: { resaleFeeBps: originalBps },
  });
  check(
    "the platform rate is put back where it was",
    restored.data?.resaleFeeBps === originalBps,
    `${(originalBps / 100).toFixed(2)}%`,
  );

  const mine = await prisma.event.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true, tiers: { select: { id: true } } },
  });
  for (const ev of mine) {
    const tierIds = ev.tiers.map((t) => t.id);
    await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
    await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.order.deleteMany({ where: { eventId: ev.id } });
    await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
    await prisma.event.delete({ where: { id: ev.id } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: "fee-buyer-" } } });
  await prisma.creditEntry.deleteMany({
    where: { userId: sellerId, orderId: null, reason: { not: "ADJUSTMENT" } },
  });
  check("test events removed", mine.length > 0, `${mine.length}`);
}

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
