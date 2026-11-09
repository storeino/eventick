/**
 * Live test — an old QR code never admits anyone.
 *
 * The QR encodes EVENTICK|<ref>|<slug>|<hmac>, so a seat moving owner is
 * safe only if the REF changes and the old row stops being VALID. Both
 * halves matter: a new ref on a still-valid old ticket means two working
 * codes for one seat, and a dead row with the same ref means the buyer
 * cannot get in either.
 *
 * Scans go through the real gate route with a real signed payload and
 * source "camera" -- the strict path, where the signature must verify. A
 * typed ref would be a staff override and would not prove the QR is dead.
 *
 * Covered:
 *   A  resell, then scan the seller old QR
 *   B  use at the gate, then try to resell
 *   C  give away, then scan the giver old QR
 *   D  the other orderings: use-then-share, list-then-share,
 *      sold-then-relist
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-ticket-qr-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";
import { ticketPayload } from "../backend/src/lib/ticket-signature.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const SLUG = `qr-probe-${SUFFIX}`;

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

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const seller = await login("client@eventick.ma", "client123");
const orga = await login("organisateur@eventick.ma", "orga1234");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;

/** Scan a ref through the real gate, with a real signed payload. */
async function scan(ref) {
  const r = await call("POST", "/api/gate/check-in", {
    token: orga,
    // source "camera" is the strict path: the signature must verify, exactly
    // as it does for a real scanner. A typed ref would be a staff override
    // and would not prove the QR itself is dead.
    body: { ref: ticketPayload(ref, SLUG), source: "camera" },
  });
  return r;
}

const start = new Date(Date.now() + 30 * 86_400_000);
const ev = await prisma.event.create({
  data: {
    slug: SLUG, organiserId: orgaId,
    titleFr: "QR probe", titleAr: "ت", category: "concert", city: "Casablanca",
    venueFr: "S", venueAr: "ق", address: "1", startAt: start, endAt: start, doorsAt: start,
    image: "x.jpg", blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ",
    ageFr: "+18", ageAr: "+18", status: "PUBLISHED", maxPerBuyer: 0, allowResale: true,
    tiers: { create: { nameFr: "P", nameAr: "م", blurbFr: "b", blurbAr: "ب",
      priceCents: 30000, capacity: 20, zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج" } },
  },
  include: { tiers: true },
});

async function buyTicket() {
  const hold = await call("POST", "/api/orders/hold", {
    token: seller, body: { eventSlug: SLUG, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
  });
  await call("POST", `/api/orders/${hold.data.order.id}/pay`, {
    token: seller,
    body: { holderName: "Karim Client", email: "client@eventick.ma", phone: "0612345678" },
  });
  const t = await prisma.ticket.findFirst({
    where: { orderId: hold.data.order.id }, select: { id: true, ref: true },
  });
  return t;
}

// ─────────────────────────────────────────────── A. resell then scan old ──
section("A.  Resell a ticket, then scan the OLD QR");
const tA = await buyTicket();
console.log(`  seller's ref: ${tA.ref}`);
await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: tA.id } });
const listingA = await prisma.resaleListing.findFirst({
  where: { ticketId: tA.id, status: "LISTED" }, select: { token: true },
});
const buyerEmail = `qr-buyer-${SUFFIX}@example.com`;
await call("POST", "/api/auth/register", {
  body: { name: "Acheteur QR", email: buyerEmail, password: "buyer12345" },
});
const buyerToken = await login(buyerEmail, "buyer12345");
const sold = await call("POST", `/api/resale/${listingA.token}/buy`, {
  token: buyerToken, body: { phone: "0611111111" },
});
check("the resale completes", sold.status === 200, `${sold.status}`);

const newRef = sold.data?.newRef;
console.log(`  buyer's new ref: ${newRef}`);
check("the buyer gets a DIFFERENT reference", newRef && newRef !== tA.ref, `${tA.ref} -> ${newRef}`);

const oldScan = await scan(tA.ref);
check(
  "the seller's old QR does NOT admit",
  oldScan.status !== 200,
  `${oldScan.status} result=${oldScan.data?.result ?? oldScan.data?.error}`,
);
const newScan = await scan(newRef);
check("the buyer's new QR DOES admit", newScan.status === 200, `${newScan.status} ${newScan.data?.result ?? ""}`);

// ────────────────────────────────────────────── B. use it, then resell ──
section("B.  Use a ticket at the gate, then try to resell it");
const tB = await buyTicket();
const usedScan = await scan(tB.ref);
check("it admits once", usedScan.status === 200, `${usedScan.status}`);
const relist = await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: tB.id } });
check(
  "a USED ticket cannot be listed for resale",
  relist.status !== 200 && relist.status !== 201,
  `${relist.status} ${relist.data?.error ?? ""}`,
);
const twice = await scan(tB.ref);
check("and it cannot admit twice", twice.status !== 200, `${twice.status} result=${twice.data?.result}`);

// ───────────────────────────────────────── C. give away, then scan old ──
section("C.  Give a ticket away, then scan the OLD QR");
const tC = await buyTicket();
console.log(`  giver's ref: ${tC.ref}`);
const share = await call("POST", "/api/share", { token: seller, body: { ticketId: tC.id } });
check("a share link is created", share.status === 200 || share.status === 201, `${share.status}`);
const shareToken = share.data?.token ?? share.data?.share?.token;
if (shareToken) {
  const claimed = await call("POST", `/api/share/${shareToken}/claim`, {
    token: buyerToken,
    body: { holderName: "Acheteur QR" },
  });
  check("the friend claims it", claimed.status === 200 || claimed.status === 201, `${claimed.status} ${JSON.stringify(claimed.data).slice(0, 80)}`);
  const claimedRef = claimed.data?.ref ?? claimed.data?.ticket?.ref;
  console.log(`  friend's ref: ${claimedRef}`);
  check("the friend gets a DIFFERENT reference", claimedRef && claimedRef !== tC.ref, `${tC.ref} -> ${claimedRef}`);
  const oldGiver = await scan(tC.ref);
  check(
    "the giver's old QR does NOT admit",
    oldGiver.status !== 200,
    `${oldGiver.status} result=${oldGiver.data?.result ?? oldGiver.data?.error}`,
  );
  if (claimedRef) {
    const friendScan = await scan(claimedRef);
    check("the friend's new QR DOES admit", friendScan.status === 200, `${friendScan.status}`);
  }
}

// ───────────────────────────────── D. the other orderings of the same ──
section("D.  The same seat cannot be moved twice");

/* Used, then given away. B covered used-then-resold; sharing is a second
   door onto the same seat, and a rule enforced on one door is not enforced. */
const tD = await buyTicket();
await scan(tD.ref);
const shareUsed = await call("POST", "/api/share", { token: seller, body: { ticketId: tD.id } });
check(
  "a USED ticket cannot be given away either",
  shareUsed.status !== 200 && shareUsed.status !== 201,
  `${shareUsed.status} ${shareUsed.data?.error ?? ""}`,
);

/* Listed, then given away: the seat is promised to a buyer already. */
const tE = await buyTicket();
await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: tE.id } });
const shareListed = await call("POST", "/api/share", { token: seller, body: { ticketId: tE.id } });
check(
  "a ticket on sale cannot be given away at the same time",
  shareListed.status !== 200 && shareListed.status !== 201,
  `${shareListed.status} ${shareListed.data?.error ?? ""}`,
);

/* Sold once, then listed again by the old owner. */
const tF = await buyTicket();
await call("POST", "/api/resale/listings", { token: seller, body: { ticketId: tF.id } });
const listingF = await prisma.resaleListing.findFirst({
  where: { ticketId: tF.id, status: "LISTED" }, select: { token: true },
});
await call("POST", `/api/resale/${listingF.token}/buy`, {
  token: buyerToken, body: { phone: "0611111111" },
});
const relistSold = await call("POST", "/api/resale/listings", {
  token: seller, body: { ticketId: tF.id },
});
check(
  "a ticket already sold on cannot be listed again by the old owner",
  relistSold.status !== 200 && relistSold.status !== 201,
  `${relistSold.status} ${relistSold.data?.error ?? ""}`,
);

// cleanup
const tierIds = ev.tiers.map((t) => t.id);
await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
await prisma.ticketShare.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
await prisma.order.deleteMany({ where: { eventId: ev.id } });
await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
await prisma.event.delete({ where: { id: ev.id } });
await prisma.user.deleteMany({ where: { email: { startsWith: "qr-buyer-" } } });
await prisma.creditEntry.deleteMany({
  where: { user: { email: "client@eventick.ma" }, orderId: null, reason: { not: "ADJUSTMENT" } },
});

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
