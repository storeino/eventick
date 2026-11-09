/**
 * Live test — a seller cannot buy their own listing.
 *
 * Reported from the UI, and it was worse than illogical: completeResale
 * CREDITS the seller the face value when the seat sells, so buying your own
 * listing returned the full price to the very balance it came from.
 * Measured before the fix: +300.00 MAD on a 300.00 MAD ticket, with 15.00
 * of commission charged to the organiser for a sale that moved a seat to
 * nobody. Pay with credit and the loop runs free, forever.
 *
 * Also checks the listing preview tells a signed-in seller the listing is
 * theirs, so the screen can refuse before the form rather than after it.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-resale-selfbuy-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const SLUG = `selfbuy-${SUFFIX}`;

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
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data };
}
const login = async (e, p) =>
  (await call("POST", "/api/auth/login", { body: { email: e, password: p } })).data.token;
const mad = (c) => (c / 100).toFixed(2);

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};

const seller = await login("client@eventick.ma", "client123");
const orga = await login("organisateur@eventick.ma", "orga1234");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;
const sellerId = (await call("GET", "/api/auth/me", { token: seller })).data.user.id;

const start = new Date(Date.now() + 30 * 86_400_000);
const ev = await prisma.event.create({
  data: {
    slug: SLUG, organiserId: orgaId,
    titleFr: "Self buy probe", titleAr: "ت", category: "concert", city: "Casablanca",
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
  where: { orderId: hold.data.order.id }, select: { id: true },
});

const balance = async () =>
  (await call("GET", "/api/auth/me/credit", { token: seller })).data.balanceCents;

const listed = await call("POST", "/api/resale/listings", {
  token: seller, body: { ticketId: ticket.id },
});
const listing = await prisma.resaleListing.findFirst({
  where: { ticketId: ticket.id, status: "LISTED" },
  select: { id: true, token: true, priceCents: true },
});
console.log(`\nlisted at ${mad(listing?.priceCents ?? 0)} MAD (status ${listed.status})`);

const before = await balance();
console.log(`balance before buying own listing: ${mad(before)} MAD`);

const selfBuy = await call("POST", `/api/resale/${listing.token}/buy`, {
  token: seller,
  body: { phone: "0612345678" },
});
console.log("");
check(
  "buying your own listing is refused",
  selfBuy.status === 409,
  `${selfBuy.status} ${selfBuy.data?.error ?? ""}`,
);
check(
  "and the refusal says what to do instead",
  /cancel it/i.test(selfBuy.data?.error ?? ""),
  selfBuy.data?.error,
);

const after = await balance();
check("the balance did not move", after === before, `${mad(before)} -> ${mad(after)}`);

const preview = await call("GET", `/api/resale/${listing.token}`, { token: seller });
check("the preview tells the seller the listing is theirs", preview.data?.isOwn === true, `isOwn=${preview.data?.isOwn}`);
const anon = await call("GET", `/api/resale/${listing.token}`);
check("and says nothing of the sort to a visitor", anon.data?.isOwn === false, `isOwn=${anon.data?.isOwn}`);
check("the listing is still on sale for someone else", anon.status === 200, `${anon.status}`);


// cleanup
const tierIds = ev.tiers.map((t) => t.id);
await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.order.deleteMany({ where: { eventId: ev.id } });
await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
await prisma.event.delete({ where: { id: ev.id } });
await prisma.creditEntry.deleteMany({
  where: { userId: sellerId, orderId: null, reason: { not: "ADJUSTMENT" } },
});
console.log("\n(cleaned up)");
await prisma.$disconnect();
