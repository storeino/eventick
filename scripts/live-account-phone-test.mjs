/**
 * Live test — the account holds the buyer's details, not the checkout form.
 *
 * Buying requires an account, so the server already knows who this is. The
 * name and email are read from the SESSION and the body is ignored: taking
 * them from the request let a signed-in buyer issue a ticket in any name
 * and send the confirmation to an address they do not read.
 *
 * The phone moved onto the account too. It used to live only on the order,
 * so a buyer with six orders typed the same number six times while the
 * account that owns all of them knew nothing about it. Required at sign-up,
 * reused at checkout, and saved from the first checkout for accounts
 * created before the column existed.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-account-phone-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const PREFIX = `acct-phone-${SUFFIX}`;

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
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const orga = await login("organisateur@eventick.ma", "orga1234");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;

const start = new Date(Date.now() + 30 * 86_400_000);
const ev = await prisma.event.create({
  data: {
    slug: PREFIX, organiserId: orgaId,
    titleFr: "Telephone compte", titleAr: "ت", category: "concert", city: "Casablanca",
    venueFr: "S", venueAr: "ق", address: "1", startAt: start, endAt: start, doorsAt: start,
    image: "x.jpg", blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ",
    ageFr: "+18", ageAr: "+18", status: "PUBLISHED", maxPerBuyer: 0,
    tiers: { create: { nameFr: "P", nameAr: "م", blurbFr: "b", blurbAr: "ب",
      priceCents: 5000, capacity: 40, zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج" } },
  },
  include: { tiers: true },
});

async function buy(token, body) {
  const hold = await call("POST", "/api/orders/hold", {
    token, body: { eventSlug: PREFIX, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
  });
  if (hold.status !== 201) throw new Error(`hold ${hold.status}: ${JSON.stringify(hold.data)}`);
  const paid = await call("POST", `/api/orders/${hold.data.order.id}/pay`, { token, body });
  const order = await prisma.order.findUnique({
    where: { id: hold.data.order.id },
    select: { holderName: true, email: true, phone: true },
  });
  return { payStatus: paid.status, order };
}

try {
  section("Sign-up asks for a phone, and keeps it");
  const email = `${PREFIX}@example.com`;
  const noPhone = await call("POST", "/api/auth/register", {
    body: { name: "Phone Tester", email: `no-${email}`, password: "tester12345" },
  });
  check("registering without one is refused", noPhone.status === 400, `${noPhone.status}`);

  const badPhone = await call("POST", "/api/auth/register", {
    body: { name: "Phone Tester", email: `bad-${email}`, password: "tester12345", phone: "123" },
  });
  check("an invalid number is refused", badPhone.status === 400, `${badPhone.status}`);

  const made = await call("POST", "/api/auth/register", {
    body: { name: "Phone Tester", email, password: "tester12345", phone: "0612345678" },
  });
  check("a valid sign-up succeeds", made.status === 201, `${made.status}`);
  const saved = await prisma.user.findUnique({ where: { email }, select: { phone: true } });
  check("the number is stored on the account", saved?.phone === "0612345678", `${saved?.phone}`);

  section("Checkout uses the account, and ignores what the form sends");
  const token = made.data.token;
  /* A name and address the account does not own, posted deliberately. */
  const spoof = await buy(token, {
    holderName: "Nom Invente",
    email: "spoof@example.com",
    phone: "0612345678",
  });
  check("the order goes through", spoof.payStatus === 200, `${spoof.payStatus}`);
  check(
    "the ticket is in the ACCOUNT's name, not the posted one",
    spoof.order.holderName === "Phone Tester",
    spoof.order.holderName,
  );
  check(
    "and addressed to the account's email",
    spoof.order.email === email,
    spoof.order.email,
  );

  section("A buyer is not asked for the phone again");
  /* No phone in the body at all: the account's is used. */
  const reused = await buy(token, {});
  check("the order goes through with no phone posted", reused.payStatus === 200, `${reused.payStatus}`);
  check(
    "and carries the account's number",
    reused.order.phone === "0612345678",
    reused.order.phone,
  );

  section("An older account with no number is asked once, then remembered");
  const legacyEmail = `legacy-${PREFIX}@example.com`;
  const legacy = await call("POST", "/api/auth/register", {
    body: { name: "Legacy Tester", email: legacyEmail, password: "tester12345", phone: "0612345678" },
  });
  // Clear it, to stand in for an account created before the column existed.
  await prisma.user.update({ where: { email: legacyEmail }, data: { phone: null } });
  const before = await prisma.user.findUnique({ where: { email: legacyEmail }, select: { phone: true } });
  check("the account starts with no number", before?.phone === null, `${before?.phone}`);

  const firstBuy = await buy(legacy.data.token, { phone: "0700112233" });
  check("they can still check out by typing one", firstBuy.payStatus === 200, `${firstBuy.payStatus}`);
  const after = await prisma.user.findUnique({ where: { email: legacyEmail }, select: { phone: true } });
  check("and it is saved to the account from there", after?.phone === "0700112233", `${after?.phone}`);

  const second = await buy(legacy.data.token, {});
  check(
    "so the next purchase needs no phone at all",
    second.payStatus === 200 && second.order.phone === "0700112233",
    `${second.payStatus} ${second.order.phone}`,
  );

  section("A one-off number does not overwrite the account's own");
  const oneOff = await buy(legacy.data.token, { phone: "0611999888" });
  check("the order carries the number given", oneOff.order.phone === "0611999888", oneOff.order.phone);
  const unchanged = await prisma.user.findUnique({
    where: { email: legacyEmail }, select: { phone: true },
  });
  check(
    "but the account keeps its own",
    unchanged?.phone === "0700112233",
    `${unchanged?.phone}`,
  );
} finally {
  section("CLEANUP");
  const tierIds = ev.tiers.map((t) => t.id);
  await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
  await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
  await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
  await prisma.order.deleteMany({ where: { eventId: ev.id } });
  await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
  await prisma.event.delete({ where: { id: ev.id } });
  const removed = await prisma.user.deleteMany({
    where: { email: { contains: `acct-phone-${SUFFIX}` } },
  });
  check("test accounts removed", removed.count > 0, `${removed.count}`);
}

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
