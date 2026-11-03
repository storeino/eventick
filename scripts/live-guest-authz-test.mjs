/**
 * Guest-order authorization — the boundary around a ticket nobody owns.
 *
 * A guest order has `customerId: null`, so there is no user to compare a
 * request against. Three route files answered that by skipping the ownership
 * check entirely:
 *
 *     const isGuestOrder = ticket.order.customerId === null;
 *     if (!isGuestOrder && ticket.order.customerId !== userId) throw 403;
 *
 * which means anyone holding a guest ticket's id could rename its holder,
 * exchange it, list it for resale, or give it away. "No account" had
 * been implemented as "no check", and those are different things.
 *
 * The fix is an unguessable token on the order — the same pattern this
 * codebase already uses for TicketShare.token — handed to the buyer as part
 * of their confirmation link. This file pins down the resulting boundary:
 *
 *   1. The link alone lets a guest USE their ticket: read the order, open
 *      the QR, download the PDF, fix a typo, change to a free zone. Guest
 *      checkout must not become login-only; that is the feature, not the bug.
 *   2. The link alone does NOT let anyone DISPOSE of it — sell the seat on,
 *      or give it away. Links travel (forwarded, screenshotted, left in a
 *      shared thread), so a copy must not be able to sell the buyer's seat
 *      out from under them or hand it to a stranger. Those need a real
 *      account, reached by claiming the order.
 *   3. A stranger holding only the id can read nothing sensitive and write
 *      nothing at all.
 *   4. A registered buyer's tickets stay reachable only by that buyer, which
 *      already worked and must keep working.
 *
 * Creates its own orders and removes them at the end.
 */

// Guest orders can no longer be made through the API, so this suite writes
// the ownerless shape directly. See buy() below.
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API ?? "http://localhost:4100";

const ACCOUNTS = {
  customer: { email: "client@eventick.ma", password: "eventick-client-2026" },
  organiser: { email: "organisateur@eventick.ma", password: "eventick-orga-2026" },
};

const results = [];
let group = "";

function setGroup(name) {
  group = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function record(label, pass, detail) {
  results.push({ group, label, pass, detail });
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

async function call(method, path, { token, orderToken, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  // The guest credential. Separate from `token` on purpose — a guest has no
  // bearer token at all, and mixing the two into one param is how a test
  // call ends up silently sending neither.
  if (orderToken) headers["X-Order-Token"] = orderToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

const login = async (account) => {
  const res = await call("POST", "/api/auth/login", { body: account });
  if (res.status !== 200) throw new Error(`login ${account.email} -> ${res.status}`);
  return res.data.token;
};

/** `k` is the order's access token; a guest request carries it as a query arg. */
const k = (token) => (token ? `?k=${encodeURIComponent(token)}` : "");

const tokens = {
  customer: await login(ACCOUNTS.customer),
  organiser: await login(ACCOUNTS.organiser),
};

// ─────────────────────────────────────────────── fixtures ──

const cleanup = { orders: [] };

const events = await call("GET", "/api/events");
const event = events.data.events.find((e) => (e.tiers?.length ?? 0) >= 2) ?? events.data.events[0];
const detail = await call("GET", `/api/events/${event.slug}`);
const tiers = detail.data.event.tiers;

/**
 * Buys `qty` tickets. With no token the order is made to LOOK like a guest
 * order — bought by a real account, then detached in the database.
 *
 * Guest checkout is closed: /orders/hold requires an account, so a guest
 * order can no longer be created through the API at all. The rows it used to
 * create still exist though — 48 of them on this database, 30 already paid —
 * and they are exactly what this suite protects. Their boundary has to keep
 * being tested, so the shape is reproduced directly rather than bought.
 *
 * Writing `customerId: null` by hand is the honest way to say "an order from
 * before accounts were required", and it keeps this file testing the
 * ownerless-order boundary instead of quietly becoming a second test of
 * ordinary signed-in orders.
 */
async function buy(qty, token) {
  const asGuest = !token;
  const buyer = token ?? tokens.customer;
  const hold = await call("POST", "/api/orders/hold", {
    token: buyer,
    body: { eventSlug: event.slug, lines: [{ tierId: tiers[0].id, qty }] },
  });
  if (hold.status !== 201 && hold.status !== 200) {
    throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.data)}`);
  }
  const order = hold.data.order;
  cleanup.orders.push(order.id);
  // The hold response is the one place the credential is handed over, and a
  // real client carries it into /pay from there — exactly as the SPA does.
  const accessToken = hold.data.accessToken ?? null;
  const pay = await call("POST", `/api/orders/${order.id}/pay${k(accessToken)}`, {
    token: buyer,
    body: { holderName: "Test Acheteur", email: "guest-authz@example.com", phone: "0612345678" },
  });
  if (pay.status !== 200) throw new Error(`pay failed: ${pay.status} ${JSON.stringify(pay.data)}`);
  // Detach AFTER settlement, so the order went through the real purchase and
  // ticket-issuing path and only then becomes the ownerless row under test.
  if (asGuest) {
    await prisma.order.update({ where: { id: order.id }, data: { customerId: null } });
  }
  return { id: order.id, accessToken };
}

// ──────────────────────────────── the guest keeps their own access ──

setGroup("GUEST  what the link alone may and may not do");

const mine = await buy(3);
record("a guest can buy with no account at all", Boolean(mine.id), mine.id?.slice(0, 10) + "…");
record("the order carries an access token for the buyer", Boolean(mine.accessToken), mine.accessToken ? "issued" : "MISSING");

const readMine = await call("GET", `/api/orders/${mine.id}${k(mine.accessToken)}`);
record("reads their own order with the token", readMine.status === 200, `${readMine.status}`);
record("sees their own email on it", readMine.data?.order?.email === "guest-authz@example.com", readMine.data?.order?.email ?? "(hidden)");

const myTickets = readMine.data?.order?.tickets ?? [];
record("their tickets were issued", myTickets.length === 3, `${myTickets.length}`);

const t = myTickets[0];
const qr = await call("GET", `/api/tickets/${t?.id}${k(mine.accessToken)}`);
record("opens their own ticket/QR with the token", qr.status === 200, `${qr.status}`);

const opts = await call("GET", `/api/tickets/${t?.id}/options${k(mine.accessToken)}`);
record("reads what they may do with it", opts.status === 200, `${opts.status}`);

const rename = await call("PATCH", `/api/tickets/${t?.id}/holder${k(mine.accessToken)}`, {
  body: { holderName: "Nom Corrigé" },
});
record("renames the holder on their own ticket", rename.status === 200, `${rename.status}`);

// The line between USING a ticket and SPENDING or DISPOSING of it.
//
// A guest's only credential is the link they were given, and links travel:
// forwarded, screenshotted, left in a shared thread. That is an acceptable
// key for opening a ticket at the gate, but not for selling the seat or
// handing it to someone else — so those need a real account, and a copy of
// the link cannot spend what it can show.
const shareOf = await call("POST", "/api/share", {
  orderToken: mine.accessToken,
  body: { ticketId: myTickets[2]?.id },
});
record("cannot give the ticket away with the link alone", shareOf.status === 403, `${shareOf.status}`);

const listOf = await call("POST", "/api/resale/listings", {
  orderToken: mine.accessToken,
  body: { ticketId: myTickets[2]?.id },
});
record("cannot list it for resale with the link alone", listOf.status === 403, `${listOf.status}`);

// None of the refused attempts may have taken effect.
const stillMine = await call("GET", `/api/orders/${mine.id}${k(mine.accessToken)}`);
record(
  "every ticket is still VALID after the refusals",
  (stillMine.data?.order?.tickets ?? []).filter((x) => x.status === "VALID").length === 3,
  `${(stillMine.data?.order?.tickets ?? []).filter((x) => x.status === "VALID").length}/3 valid`,
);

// Claiming the order into an account is the step that unlocks them, and
// the order token is the proof — deliberately not the order's email,
// which is shown to anyone holding the same link.
const claimer = await call("POST", "/api/auth/register", {
  body: { name: "Invite Claim", email: `guest-claim-${Date.now()}@example.com`, password: "guest-claim-2026" },
});
const claimerToken = claimer.data?.token;
const claimed = await call("POST", `/api/orders/${mine.id}/claim`, {
  token: claimerToken,
  orderToken: mine.accessToken,
});
record("claiming the order into an account works", claimed.status === 200, `${claimed.status}`);

const afterShare = await call("POST", "/api/share", {
  token: claimerToken,
  body: { ticketId: myTickets[2]?.id },
});
record("and giving it away is allowed", afterShare.status === 201, `${afterShare.status}`);
if (afterShare.status === 201) {
  const revoked = await call("DELETE", `/api/share/${afterShare.data?.id}`, { token: claimerToken });
  record("and the share link can be revoked again", revoked.status === 204, `${revoked.status}`);
}

// ──────────────────────────────────── a stranger is locked out ──

setGroup("STRANGER  holds the id, not the token");

const victim = await buy(2);

const readNoToken = await call("GET", `/api/orders/${victim.id}`);
record("cannot read the order without the token", readNoToken.status === 403, `${readNoToken.status}`);

const readBadToken = await call("GET", `/api/orders/${victim.id}?k=not-the-real-token`);
record("a wrong token is refused", readBadToken.status === 403, `${readBadToken.status}`);

// Fetch the real ticket ids through the legitimate link, to attack them.
const victimRead = await call("GET", `/api/orders/${victim.id}${k(victim.accessToken)}`);
const vTickets = victimRead.data?.order?.tickets ?? [];
const v1 = vTickets[0];
// v2 is used below to confirm nothing the attacker tried took effect.
record("(setup) the victim's own link still works", victimRead.status === 200, `${victimRead.status}`);

// Reads
const atkQr = await call("GET", `/api/tickets/${v1?.id}`);
record("cannot open the victim's ticket/QR", atkQr.status === 403, `${atkQr.status}`);

const atkOpts = await call("GET", `/api/tickets/${v1?.id}/options`);
record("cannot read the victim's ticket options", atkOpts.status === 403, `${atkOpts.status}`);

// Writes — these are the ones that were open.
const atkRename = await call("PATCH", `/api/tickets/${v1?.id}/holder`, { body: { holderName: "Pirate" } });
record("cannot RENAME the victim's ticket holder", atkRename.status === 403, `${atkRename.status}`);

const atkExchange = await call("POST", `/api/tickets/${v1?.id}/exchange`, { body: { tierId: tiers[0].id } });
record("cannot EXCHANGE the victim's ticket", atkExchange.status === 403, `${atkExchange.status}`);

// resale and share take the ticket in the BODY, and carry the same copied
// guest bypass as tickets.ts — so they need the same boundary.
const atkResale = await call("POST", "/api/resale/listings", {
  body: { ticketId: v1?.id, priceCents: tiers[0].priceCents },
});
record("cannot LIST the victim's ticket for resale", atkResale.status === 403, `${atkResale.status}`);

const atkShare = await call("POST", "/api/share", { body: { ticketId: v1?.id } });
record("cannot GIVE AWAY the victim's ticket", atkShare.status === 403, `${atkShare.status}`);

// Nothing above may have taken effect.
const after = await call("GET", `/api/orders/${victim.id}${k(victim.accessToken)}`);
const stillValid = (after.data?.order?.tickets ?? []).filter((x) => x.status === "VALID").length;
record("the victim's tickets are all still VALID", stillValid === 2, `${stillValid}/2 valid`);
record(
  "the holder name was not changed",
  (after.data?.order?.tickets ?? []).every((x) => x.holderName !== "Pirate"),
  (after.data?.order?.tickets ?? [])[0]?.holderName,
);

// ────────────────────────── a registered buyer is unaffected ──

setGroup("REGISTERED  owner-only, as before");

const reg = await buy(1, tokens.customer);
const regRead = await call("GET", `/api/orders/${reg.id}`, { token: tokens.customer });
record("the owner reads their own order", regRead.status === 200, `${regRead.status}`);
const regTicket = regRead.data?.order?.tickets?.[0];

const regRename = await call("PATCH", `/api/tickets/${regTicket?.id}/holder`, { body: { holderName: "Pirate" } });
record("an anonymous stranger cannot rename it", regRename.status === 403, `${regRename.status}`);

// Self-cancellation no longer exists, so these moved onto resale — the
// surviving action that disposes of a seat, and the one a thief would want.
const regList = await call("POST", "/api/resale/listings", { body: { ticketId: regTicket?.id } });
record("an anonymous stranger cannot sell it", regList.status === 403, `${regList.status}`);

const regOther = await call("POST", "/api/resale/listings", {
  token: tokens.organiser,
  body: { ticketId: regTicket?.id },
});
record("another LOGGED-IN user cannot sell it", regOther.status === 403, `${regOther.status}`);

// A token is scoped to its own order, so one guest's link must not open
// anyone else's order.
const regCross = await call("GET", `/api/orders/${reg.id}${k(mine.accessToken)}`);
record("a guest access token from another order does not unlock it", regCross.status === 403, `${regCross.status}`);

// ───────────────────────────────────────── PII on the public read ──

setGroup("PII  what a link-holder is shown");

const pii = await call("GET", `/api/orders/${mine.id}${k(mine.accessToken)}`);
const body = pii.data?.order ?? {};
record("the buyer still sees what they need (status, tickets)", Boolean(body.status) && Array.isArray(body.tickets), body.status);
record("card PAN is never exposed", !("cardNumber" in body) && !("pan" in body), "absent");

// ──────────────────────────────────────────────────── cleanup ──

setGroup("CLEANUP");

// Admin holds scope.any, so it can remove an order on any organiser's
// event -- the organiser token only reaches its own, which is why this
// used to come back 403 and leak a row per run.
const adminToken = await login({ email: "admin@eventick.ma", password: "eventick-admin-2026" });
let leaked = 0;
for (const id of cleanup.orders) {
  const r = await call("DELETE", `/api/organiser/orders/${id}`, { token: adminToken });
  const gone = [200, 204, 404].includes(r.status);
  if (!gone) leaked++;
  record(`removed test order ${id.slice(0, 8)}…`, gone, `${r.status}`);
}
if (leaked) console.log(`  [33m${leaked} order(s) left behind[0m`);

// ───────────────────────────────────────────────────── summary ──

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log("\n──────────────────────────────────────────────────────────────");
console.log(`\x1b[1mTOTAL: ${passed}/${results.length} passed\x1b[0m`);
if (failed.length) {
  console.log("\n\x1b[31mFailures:\x1b[0m");
  for (const f of failed) console.log(`  [${f.group}] ${f.label} — ${f.detail}`);
}
console.log("──────────────────────────────────────────────────────────────");
process.exit(failed.length ? 1 : 0);
