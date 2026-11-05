/**
 * Walk the waitlist end to end, narrating each step.
 *
 * The cycle is hard to see by hand: it needs a SOLD-OUT event, and the
 * interesting part only fires when a seat frees up — a refund, a cancelled
 * ticket, an abandoned checkout. This creates that situation on a throwaway
 * event, so nothing in the real catalogue is touched, and prints what the
 * organiser would see on /pro/offers at each stage.
 *
 * Needs mock payments: a sale has to settle before it can be refunded.
 *
 *   cd backend && npx tsx ../scripts/demo-waitlist.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";
import { sweepOnce } from "../backend/src/lib/sweeper.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const SLUG = `waitlist-demo-${Date.now().toString(36)}`;

const call = async (method, path, body, token) => {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 204 */ }
  return { status: res.status, data };
};

/*
 * Buying requires an account, so each demo buyer gets a throwaway one. They
 * are registered per run; the demo deletes its event at the end, and these
 * accounts hold nothing once it is gone.
 */
const RUN = Date.now();
const asBuyer = async (label) => {
  const email = `wl-${RUN}-${label}@example.ma`;
  const r = await call("POST", "/auth/register", { name: `Demo ${label}`, email, password: `wl-${RUN}-pw` });
  if (!r.data?.token) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.data).slice(0, 110)}`);
  return { email, token: r.data.token };
};

const step = (n, title) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const say = (text) => console.log(`   ${text}`);

/** The waitlist as /pro/offers renders it. */
async function board(eventId) {
  const rows = await prisma.waitlistEntry.findMany({
    where: { eventId },
    orderBy: { createdAt: "asc" },
    select: { email: true, status: true, claimExpiresAt: true },
  });
  const label = { WAITING: "Waiting", OFFERED: "Seat reserved", CLAIMED: "Claimed", EXPIRED: "Window lapsed" };
  for (const row of rows) {
    const until = row.claimExpiresAt
      ? ` (expires ${row.claimExpiresAt.toISOString().slice(11, 16)})`
      : "";
    say(`${row.email.padEnd(26)} ${label[row.status]}${until}`);
  }
  if (!rows.length) say("(nobody on the waitlist)");
}

let eventId = null;

try {
  const mode = await call("GET", "/health");
  if (mode.status !== 200) throw new Error(`backend not reachable at ${API}`);

  const admin = (await call("POST", "/auth/login", {
    email: "admin@eventick.ma", password: "admin123",
  })).data?.token;
  const org = (await call("POST", "/auth/login", {
    email: "organisateur@eventick.ma", password: "orga1234",
  })).data?.token;
  if (!admin || !org) throw new Error("could not sign in — run `npm run db:seed` first");

  const organiser = await prisma.user.findUniqueOrThrow({
    where: { email: "organisateur@eventick.ma" }, select: { id: true },
  });

  // ────────────────────────────────────────────────────────────────────────
  step(1, "A tiny event with exactly TWO seats");
  const txt = "texte de remplissage suffisamment long";
  const created = await call("POST", "/organiser/events", {
    slug: SLUG, organiserId: organiser.id,
    titleFr: "Démo liste d'attente", titleAr: "عرض قائمة الانتظار",
    category: "festivals", city: "Casablanca",
    venueFr: "Petite salle", venueAr: "قاعة صغيرة", address: "Casablanca",
    start: "2027-11-20T21:00:00", end: "2027-11-20T23:59:00", doors: "2027-11-20T20:00:00",
    image: "/events/jazz.jpg", blurbFr: txt, blurbAr: txt, aboutFr: txt, aboutAr: txt,
    ageFr: "12 ans", ageAr: "12 سنة",
    tiers: [{
      nameFr: "Place", nameAr: "مقعد", blurbFr: txt, blurbAr: txt,
      priceCents: 20000, capacity: 2, zoneFr: "z", zoneAr: "م", gateFr: "p", gateAr: "ب",
    }],
  }, admin);
  if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.data)}`);
  eventId = (await prisma.event.findUniqueOrThrow({ where: { slug: SLUG }, select: { id: true } })).id;
  const tierId = created.data.event.tiers[0].id;
  say(`"${created.data.event.titleFr}" — 2 seats at 200,00 MAD`);
  say(`public page: ${API.replace(":4100", ":3100")}/evenements/${SLUG}`);

  // ────────────────────────────────────────────────────────────────────────
  step(2, "Two buyers take both seats — it is now SOLD OUT");
  const buyers = [];
  for (const [name, label] of [["Salma Idrissi", "salma"], ["Youssef Benali", "youssef"]]) {
    const who = await asBuyer(label);
    const email = who.email;
    const hold = await call("POST", "/orders/hold", { eventSlug: SLUG, lines: [{ tierId, qty: 1 }], email }, who.token);
    if (hold.status !== 201) throw new Error(`hold: ${hold.status} ${JSON.stringify(hold.data)}`);
    const paid = await call("POST", `/orders/${hold.data.order.id}/pay?k=${encodeURIComponent(hold.data.accessToken)}`,
      { holderName: name, email, phone: "0612345678" }, who.token);
    if (paid.status >= 300) throw new Error(`pay: ${paid.status} — are payments in MOCK mode?`);
    buyers.push({ name, email, orderId: hold.data.order.id });
    say(`${name} bought 1 seat`);
  }
  const soldOut = await call("GET", `/events/${SLUG}`);
  say(`seats left: ${soldOut.data.event.tiers[0].remaining} — the buy button is gone, the page offers the waitlist`);

  // ────────────────────────────────────────────────────────────────────────
  step(3, "Three people join the waitlist, in order");
  const queue = ["amine.demo@example.ma", "nadia.demo@example.ma", "karim.demo@example.ma"];
  for (const email of queue) {
    const joined = await call("POST", `/events/${SLUG}/waitlist`, { email });
    say(`${email.padEnd(26)} ${joined.status === 201 ? "joined" : `refused (${joined.status})`}`);
  }
  const again = await call("POST", `/events/${SLUG}/waitlist`, { email: queue[0] });
  say(`the same address twice -> ${again.status} ${JSON.stringify(again.data)}`);
  say("");
  say("what /pro/offers shows now:");
  await board(eventId);

  // ────────────────────────────────────────────────────────────────────────
  step(4, "A buyer is refunded — one seat comes free");
  const refunded = await call("POST", `/organiser/orders/${buyers[0].orderId}/refund`, {}, org);
  say(`${buyers[0].name} refunded in full (HTTP ${refunded.status})`);
  // offerFreedSeats is fire-and-forget; give it a moment to land.
  await new Promise((r) => setTimeout(r, 1200));
  say("");
  say("the seat was offered automatically — nobody pressed anything:");
  await board(eventId);

  const offered = await prisma.waitlistEntry.findFirst({
    where: { eventId, status: "OFFERED" },
    select: { email: true, claimToken: true, claimExpiresAt: true },
  });
  if (offered) {
    const minutes = Math.round((offered.claimExpiresAt.getTime() - Date.now()) / 60000);
    say("");
    say(`${offered.email} has ${minutes} minutes to buy it.`);
    say("They were emailed a private link that works without an account:");
    say(`  ${API.replace(":4100", ":3100")}/evenements/${SLUG}?claim=${offered.claimToken}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  step(5, "The held seat is NOT on sale to anyone else");
  const avail = await call("GET", `/events/${SLUG}`);
  say(`public seats left: ${avail.data.event.tiers[0].remaining} — the freed seat is reserved, not back on the market`);
  // Signed in, on their own account: anonymous would be turned away for not
  // having one, which proves nothing about whether the seat is held.
  const jump = await asBuyer("jumper");
  const jumper = await call("POST", "/orders/hold", {
    eventSlug: SLUG, lines: [{ tierId, qty: 1 }], email: jump.email,
  }, jump.token);
  say(`someone else trying to buy it -> ${jumper.status} ${JSON.stringify(jumper.data).slice(0, 70)}`);

  // ────────────────────────────────────────────────────────────────────────
  step(6, "If they do not buy in time, it passes to the next person");
  say("Rather than wait 30 minutes, the offer is backdated so it has lapsed:");
  await prisma.waitlistEntry.updateMany({
    where: { eventId, status: "OFFERED" },
    data: { claimExpiresAt: new Date(Date.now() - 60_000) },
  });
  // The server sweeps every five minutes on a timer; called directly here so
  // the demo does not sit waiting for the next tick.
  const swept = await sweepOnce();
  say(`swept: ${swept.expired} offer(s) expired, ${swept.reoffered} seat(s) re-offered`);
  await new Promise((r) => setTimeout(r, 1200));
  say("");
  await board(eventId);
  say("");
  say("the first person lapsed; the seat moved to the next in line, automatically.");

  console.log("\n\x1b[1mTo watch this in the browser\x1b[0m");
  say(`1. open  ${API.replace(":4100", ":3100")}/evenements/${SLUG}  (sold out, shows the waitlist form)`);
  say("2. open  /pro/offers  as the organiser to see the queue and its statuses");
  say("3. refund another order from /pro/orders and refresh — the next seat is offered");
} catch (err) {
  console.log(`\n\x1b[31mstopped:\x1b[0m ${String(err.message).split("\n")[0]}`);
} finally {
  if (eventId) {
    console.log("\n\x1b[2mcleaning up the demo event…\x1b[0m");
    await prisma.waitlistEntry.deleteMany({ where: { eventId } });
    await prisma.order.deleteMany({ where: { eventId } });
    await prisma.event.deleteMany({ where: { id: eventId } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: ".demo@example.ma" } } }).catch(() => {});
  await prisma.$disconnect();
}
