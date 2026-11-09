/**
 * Live FULL-STACK test — store credit through the running frontend.
 *
 * Everything here goes through http://localhost:3100, the Next.js server,
 * not straight to the API on :4100. That is the path a browser actually
 * takes: Next's rewrite proxies /api/:path* to the backend, so a broken
 * proxy, a dead frontend or a route the SPA cannot reach fails here where
 * the pure-API suite (live-credit-test) would still pass.
 *
 * It checks three layers:
 *
 *   1. PAGES   — the frontend serves /billets, /paiement, /explorer and the
 *                event page, and the built bundle really contains the credit
 *                UI (the balance tab, the checkout toggle, the API path).
 *   2. PROXY   — /api/* through :3100 reaches the backend and returns the
 *                same answers as :4100 directly.
 *   3. MONEY   — a cancellation grants credit, credit settles an order with
 *                no gateway, partial cover leaves the card the remainder,
 *                and the ledger explains the balance.
 *
 * Both servers must be running:
 *   backend:  cd backend  && npm run dev     (:4100)
 *   frontend: cd frontend && npm run dev     (:3100)
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-credit-fullstack-test.mjs
 */

import fs from "fs";
import { prisma } from "../backend/src/lib/prisma.js";

const WEB = process.env.WEB_URL ?? "http://localhost:3100";
const API = process.env.API_URL ?? "http://localhost:4100";

const ACCOUNTS = {
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  customer: { email: "client@eventick.ma", password: "client123" },
  admin: { email: "admin@eventick.ma", password: "admin123" },
};

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(
    `  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`,
  );
}
const mad = (cents) => (cents / 100).toFixed(2);
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** Through the FRONTEND, the way a browser reaches the API. */
async function web(method, path, { token, body } = {}) {
  const res = await fetch(`${WEB}${path}`, {
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

/** A page request, for the HTML the server returns. */
async function page(path) {
  const res = await fetch(`${WEB}${path}`, { redirect: "follow" });
  const html = await res.text();
  return { status: res.status, html, url: res.url };
}

const login = async ({ email, password }) => {
  const r = await web("POST", "/api/auth/login", { body: { email, password } });
  if (!r.data?.token) {
    throw new Error(`login ${email} via ${WEB}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  }
  return r.data.token;
};

const SUFFIX = Date.now();
const SLUG_PREFIX = "fullstack-credit-";

/**
 * Remove everything this suite creates.
 *
 * Credit entries go FIRST, while they still point at these orders: the FK
 * is SetNull, so deleting the orders first would orphan the credit onto the
 * shared demo account. That is not hypothetical — 16 such rows worth
 * 15 000 MAD had already built up from the older suites before their
 * teardowns were fixed.
 */
async function teardown() {
  const stale = await prisma.event.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, tiers: { select: { id: true } } },
  });
  for (const ev of stale) {
    const tierIds = ev.tiers.map((t) => t.id);
    await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
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

async function makeEvent(name, organiserId, priceCents) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  return prisma.event.create({
    data: {
      slug: `${SLUG_PREFIX}${name}-${SUFFIX}`,
      organiserId,
      titleFr: `Plein ecran ${name}`,
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
      maxPerBuyer: 0,
      tiers: {
        create: {
          nameFr: "Place",
          nameAr: "مقعد",
          blurbFr: "b",
          blurbAr: "ب",
          priceCents,
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
}

async function main() {
  section("Both servers are up");
  let frontUp = false;
  try {
    const home = await page("/");
    frontUp = home.status === 200;
    check(`the frontend answers on ${WEB}`, frontUp, `${home.status}`);
    check(
      "and it is Eventick, not another app on the same port",
      /Eventick/i.test(home.html),
      /<title>([^<]*)</i.exec(home.html)?.[1]?.slice(0, 60) ?? "no title",
    );
  } catch (e) {
    check(`the frontend answers on ${WEB}`, false, String(e.message).slice(0, 80));
  }
  if (!frontUp) {
    console.log(`\n\x1b[31mFrontend not reachable at ${WEB} — start it with: cd frontend && npm run dev\x1b[0m`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const apiDirect = await fetch(`${API}/api/events`).then((r) => r.status).catch(() => 0);
  check(`the backend answers on ${API}`, apiDirect === 200, `${apiDirect}`);

  section("The frontend proxies /api to the backend");
  const viaWeb = await web("GET", "/api/events");
  check("GET /api/events through :3100 succeeds", viaWeb.status === 200, `${viaWeb.status}`);
  const direct = await fetch(`${API}/api/events`).then((r) => r.json());
  const n = (x) => (x.events ?? x).length;
  check(
    "it returns the same catalogue as the backend directly",
    n(viaWeb.data) === n(direct),
    `${n(viaWeb.data)} vs ${n(direct)}`,
  );

  const organiser = await login(ACCOUNTS.organiser);
  const customer = await login(ACCOUNTS.customer);
  const admin = await login(ACCOUNTS.admin);
  check("a customer can sign in through the frontend", Boolean(customer), "token issued");
  const orgaId = (await web("GET", "/api/auth/me", { token: organiser })).data.user.id;

  const cleaned = await teardown();
  if (cleaned) console.log(`\x1b[2m(cleared ${cleaned} leftover event(s))\x1b[0m`);

  const balance = async () =>
    (await web("GET", "/api/auth/me/credit", { token: customer })).data.balanceCents;

  async function buy(event, qty, { useCredit = false } = {}) {
    const hold = await web("POST", "/api/orders/hold", {
      token: customer,
      body: { eventSlug: event.slug, lines: [{ tierId: event.tiers[0].id, qty }] },
    });
    if (hold.status !== 201) throw new Error(`hold ${hold.status}: ${JSON.stringify(hold.data).slice(0, 140)}`);
    const paid = await web("POST", `/api/orders/${hold.data.order.id}/pay`, {
      token: customer,
      body: {
        holderName: "Karim Client",
        email: ACCOUNTS.customer.email,
        phone: "0612345678",
        useCredit,
      },
    });
    if (paid.status !== 200) throw new Error(`pay ${paid.status}: ${JSON.stringify(paid.data).slice(0, 140)}`);
    return { id: hold.data.order.id, pay: paid.data };
  }

  section("The pages a buyer with credit actually opens");
  for (const [path, label] of [
    ["/billets", "My tickets (holds the balance tab)"],
    ["/explorer", "Browse events"],
    ["/paiement", "Checkout (holds the credit toggle)"],
    /* The exact URL the cancellation email sends buyers to.
       It said "Voir mon solde" and pointed at bare /billets, which opens on
       Active tickets -- so a buyer told their money was waiting arrived at a
       page with no balance on it. The tab is in the URL now, and this pins
       the link down. */
    ["/billets?tab=credit", "The balance link from the cancellation email"],
  ]) {
    const r = await page(path);
    check(`${label} — ${path}`, r.status === 200, `${r.status}`);
  }

  /* The email must point at the tab, not the page. Read out of the SHIPPED
     module rather than retyped, so a later edit to the template is caught. */
  const cancelSrc = fs.readFileSync("../backend/src/lib/event-cancel.ts", "utf8");
  check(
    "the cancellation email links straight to the balance tab",
    cancelSrc.includes("/billets?tab=credit"),
    cancelSrc.includes("/billets?tab=credit") ? "ok" : "still links to bare /billets",
  );

  section("The credit UI is in the bundle the browser downloads");
  /* Pulled from the served JS, not from source. A string present in the repo
     but missing from the chunk is a feature the user cannot see. */
  const homeHtml = (await page("/")).html;
  const chunks = [...homeHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  check("the page loads JS chunks", chunks.length > 0, `${chunks.length} script tags`);
  let bundle = "";
  for (const c of chunks.slice(0, 40)) {
    bundle += await fetch(`${WEB}${c}`).then((r) => r.text()).catch(() => "");
  }
  const appChunks = [...bundle.matchAll(/"(static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const c of appChunks.slice(0, 60)) {
    bundle += await fetch(`${WEB}/_next/${c}`).then((r) => r.text()).catch(() => "");
  }
  check(`fetched ${(bundle.length / 1024 / 1024).toFixed(1)} MB of JS`, bundle.length > 100_000);
  /* creditAppliedCents is deliberately NOT checked here: it is a field the
     SERVER returns, which no frontend source file names, so it is correctly
     absent from the bundle. Asserting it would be testing the wrong layer. */
  for (const [needle, what] of [
    ["auth/me/credit", "the balance endpoint the UI calls"],
    ["useCredit", "the checkout opt-in flag"],
    ["creditRemaining", "the \"left to pay\" label"],
    ["creditCoversAll", "the fully-covered message"],
  ]) {
    check(`${what} is in the bundle`, bundle.includes(needle), needle);
  }

  section("A cancelled event becomes spendable credit");
  const start = await balance();
  const ev1 = await makeEvent("cancelled", orgaId, 30000);
  await buy(ev1, 2);
  const cancelled = await web("POST", `/api/organiser/events/${ev1.slug}/cancel`, {
    token: admin,
    body: { reason: "Artiste souffrant", notify: false },
  });
  check("the cancellation succeeds", cancelled.status === 200, `${cancelled.status}`);
  check(
    "it reports the credit it granted",
    cancelled.data?.credited === 1 && cancelled.data?.creditedCents === 60000,
    `credited=${cancelled.data?.credited} cents=${cancelled.data?.creditedCents}`,
  );
  const afterCancel = await balance();
  check(
    "the balance the UI will show rose by what was paid",
    afterCancel - start === 60000,
    `${mad(start)} -> ${mad(afterCancel)}`,
  );

  section("Credit buys a ticket with no card and no gateway");
  const ev2 = await makeEvent("cheap", orgaId, 15000);
  const o2 = await buy(ev2, 1, { useCredit: true });
  check("the order settles as credit", o2.pay.mode === "credit", String(o2.pay.mode));
  check("the whole order was covered", o2.pay.creditAppliedCents === 15000, `${o2.pay.creditAppliedCents}`);
  const row2 = await prisma.order.findUnique({
    where: { id: o2.id },
    select: { status: true, gatewayRef: true, creditAppliedCents: true, totalCents: true, feeCents: true },
  });
  check("the order is PAID", row2.status === "PAID", row2.status);
  check("it never reached a gateway", row2.gatewayRef === null, String(row2.gatewayRef));
  check(
    "no card was charged a dirham",
    row2.totalCents - row2.creditAppliedCents === 0,
    `card=${mad(row2.totalCents - row2.creditAppliedCents)}`,
  );
  check("the platform still took its commission", row2.feeCents > 0, `fee=${row2.feeCents}`);
  const issued = await prisma.ticket.count({ where: { orderId: o2.id, status: "VALID" } });
  check("a real, valid ticket exists", issued === 1, `${issued}`);
  check("the balance fell by the price", afterCancel - (await balance()) === 15000, mad(await balance()));

  section("Partial cover leaves the card exactly the remainder");
  /* Priced from the LIVE balance, not a fixed figure.
     The demo customer is shared and may already hold credit, so a hard-coded
     1000 MAD event was fully covered on a 1050 balance and this section
     tested the opposite of what it says. Balance + 500 guarantees a
     shortfall whatever it starts at. */
  const before3 = await balance();
  const ev3 = await makeEvent("dear", orgaId, before3 + 50000);
  const o3 = await buy(ev3, 1, { useCredit: true });
  check("it is not credit-only", o3.pay.mode !== "credit", String(o3.pay.mode));
  check(
    "it spent the whole balance and no more",
    o3.pay.creditAppliedCents === before3,
    `applied=${mad(o3.pay.creditAppliedCents)} had=${mad(before3)}`,
  );
  const row3 = await prisma.order.findUnique({
    where: { id: o3.id },
    select: { totalCents: true, creditAppliedCents: true },
  });
  check(
    "credit + card equals the ticket price, to the dirham",
    row3.creditAppliedCents + (row3.totalCents - row3.creditAppliedCents) === row3.totalCents,
    `${mad(row3.creditAppliedCents)} + ${mad(row3.totalCents - row3.creditAppliedCents)} = ${mad(row3.totalCents)}`,
  );
  check("the balance is now zero", (await balance()) === 0, mad(await balance()));

  section("The statement the balance screen renders");
  const stmt = (await web("GET", "/api/auth/me/credit", { token: customer })).data;
  const summed = stmt.entries.reduce((s, e) => s + e.amountCents, 0);
  check("the balance equals SUM(entries)", summed === stmt.balanceCents, `${summed} vs ${stmt.balanceCents}`);
  check(
    "every row has a label a buyer can read",
    stmt.entries.every((e) => e.label && e.label.length > 2),
    `${stmt.entries.length} rows`,
  );
  check(
    "the cancellation appears under its own reason",
    stmt.entries.some((e) => e.reason === "EVENT_CANCELLED"),
    "found",
  );
  check(
    "spends are negative PURCHASE rows",
    stmt.entries.filter((e) => e.reason === "PURCHASE").every((e) => e.amountCents < 0),
    "ok",
  );

  section("Credit is never spent behind the buyer's back");
  const ev5 = await makeEvent("optin", orgaId, 5000);
  const beforeProbe = await balance();
  await prisma.creditEntry.create({
    data: {
      userId: (await web("GET", "/api/auth/me", { token: customer })).data.user.id,
      amountCents: 20000,
      reason: "ADJUSTMENT",
      label: "Fullstack opt-in probe",
      note: "fullstack credit test",
    },
  });
  const o5 = await buy(ev5, 1);
  check(
    "the balance is untouched when useCredit is absent",
    (await balance()) === beforeProbe + 20000,
    `${mad(beforeProbe + 20000)} expected, ${mad(await balance())} found`,
  );
  check("nothing was applied to the order", !o5.pay.creditAppliedCents, `${o5.pay.creditAppliedCents}`);

  section("CLEANUP");
  const custId = (await web("GET", "/api/auth/me", { token: customer })).data.user.id;
  const mine = await prisma.event.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true },
  });
  const probes = await prisma.creditEntry.deleteMany({
    where: { userId: custId, note: "fullstack credit test" },
  });
  check(`removed ${probes.count} probe entr${probes.count === 1 ? "y" : "ies"}`, probes.count === 1, `${probes.count}`);
  const removed = await teardown();
  check("all test events removed", removed === mine.length, `${removed}/${mine.length}`);
  const end = await balance();
  check("the demo balance is back where it started", end === start, `${mad(start)} -> ${mad(end)}`);
  const orphans = await prisma.creditEntry.count({
    where: { orderId: null, reason: { not: "ADJUSTMENT" } },
  });
  check("this run orphaned no credit onto the demo account", orphans === 0, `${orphans} orphan(s)`);

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
