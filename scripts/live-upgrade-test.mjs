/**
 * Paying to move into a dearer zone.
 *
 * A downgrade is free and immediate. An upgrade owes the difference, and
 * because CMI is a redirect gateway the buyer is away on its page while the
 * seat has to stay theirs. The things that can go wrong there are the ones
 * that cost somebody money, so they are what this file checks:
 *
 *   - the seat is RESERVED while they pay, so it cannot be sold from under
 *     them and leave us holding money for a seat that no longer exists;
 *   - the reservation does not block the upgrade it exists to protect (the
 *     last seat of a zone must still be upgradable INTO);
 *   - the original order is never rewritten — the difference is its own
 *     order, so the organiser's payout stays honest;
 *   - a failed or abandoned attempt releases the seat and leaves the
 *     holder's existing ticket untouched;
 *   - only the owner can spend, and only on their own ticket.
 *
 * Runs against the live API in mock-payment mode, where the server settles
 * the order itself instead of handing off to CMI.
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API ?? "http://localhost:4100";
let pass = 0;
let fail = 0;
const failures = [];

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m PASS\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  \x1b[31m FAIL\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  }
}

async function call(method, path, { token, body, orderToken } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orderToken) headers["x-order-token"] = orderToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
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

const login = async (account) => (await call("POST", "/api/auth/login", { body: account })).data?.token;
const mad = (cents) => (cents / 100).toFixed(2);

const PREFIX = "upg-test";
const stamp = Date.now();

const tier = (over = {}) => ({
  nameFr: "Standard",
  nameAr: "عادي",
  blurbFr: "Place",
  blurbAr: "مكان",
  priceCents: 20000,
  capacity: 10,
  zoneFr: "A",
  zoneAr: "أ",
  gateFr: "1",
  gateAr: "1",
  ...over,
});

async function makeEvent(orgToken, suffix, tiers) {
  const slug = `${PREFIX}-${suffix}-${stamp}`;
  const start = new Date(Date.now() + 30 * 86_400_000);
  const res = await call("POST", "/api/organiser/events", {
    token: orgToken,
    body: {
      slug,
      maxPerBuyer: 0,
      allowResale: true,
      titleFr: "Surclassement",
      titleAr: "ترقية",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle",
      venueAr: "قاعة",
      address: "1 rue",
      start: start.toISOString(),
      end: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      doors: new Date(start.getTime() - 3_600_000).toISOString(),
      image: "/events/mawazine.jpg",
      blurbFr: "Test",
      blurbAr: "تجربة",
      aboutFr: "Test",
      aboutAr: "تجربة",
      ageFr: "18+",
      ageAr: "+18",
      tiers,
    },
  });
  if (res.status !== 201) throw new Error(`event create (${res.status}): ${JSON.stringify(res.data)}`);
  return { slug, event: res.data.event };
}

async function buy(token, slug, tierId, qty = 1, name = "Acheteur Surclassement") {
  const hold = await call("POST", "/api/orders/hold", {
    token,
    body: { eventSlug: slug, lines: [{ tierId, qty }] },
  });
  if (hold.status !== 201) throw new Error(`hold (${hold.status}): ${JSON.stringify(hold.data)}`);
  const orderId = hold.data.order.id;
  const pay = await call("POST", `/api/orders/${orderId}/pay`, {
    token,
    body: { holderName: name, email: "client@eventick.ma", phone: "0612345678" },
  });
  if (pay.status !== 200) throw new Error(`pay (${pay.status}): ${JSON.stringify(pay.data)}`);
  const order = await call("GET", `/api/orders/${orderId}`, { token });
  return { orderId, tickets: order.data.order.tickets };
}

const payload = (tierId, over = {}) => ({
  tierId,
  holderName: "Acheteur Surclassement",
  email: "client@eventick.ma",
  phone: "0612345678",
  ...over,
});

async function main() {
  const organiser = await login({ email: "organisateur@eventick.ma", password: "orga1234" });
  const customer = await login({ email: "client@eventick.ma", password: "client123" });
  if (!organiser || !customer) throw new Error("login failed — is the backend seeded?");

  const slugs = [];
  const orderIds = [];

  // ── 1. The happy path, and what it does to the money ────────────────────
  section("1. Paying the difference");
  {
    const { slug, event } = await makeEvent(organiser, "ok", [
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 10, zoneFr: "G" }),
      tier({ nameFr: "Fosse", priceCents: 50000, capacity: 10, zoneFr: "F" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const order = await buy(customer, slug, byName.Gradin);
    orderIds.push(order.orderId);
    const ticketId = order.tickets[0].id;

    /*
     * What TicketDetail.jsx reads to draw the button.
     *
     * The screen decides between "Surclasser" and "Changer de zone" from
     * dueCents, and refuses to offer either without viaSession — so if this
     * shape drifts the button silently disappears or charges nothing.
     */
    const opts = await call("GET", `/api/tickets/${ticketId}/options`, { token: customer });
    const fosse = (opts.data?.exchange ?? []).find((z) => z.nameFr === "Fosse");
    check(
      "the screen is told what the upgrade costs",
      fosse?.dueCents === 30000 && fosse?.forfeitCents === 0 && fosse?.soldOut === false,
      `due=${fosse?.dueCents} forfeit=${fosse?.forfeitCents} soldOut=${fosse?.soldOut}`,
    );
    check("and that this caller may spend", opts.data?.viaSession === true, `viaSession=${opts.data?.viaSession}`);

    const res = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: customer,
      body: payload(byName.Fosse),
    });
    check("an upgrade is accepted", res.status === 200, `${res.status} ${JSON.stringify(res.data).slice(0, 70)}`);
    if (res.data?.orderId) orderIds.push(res.data.orderId);

    const after = await call("GET", `/api/tickets/${ticketId}`, { token: customer });
    check("the ticket moved zone", after.data?.tier?.nameFr === "Fosse", `${after.data?.tier?.nameFr}`);

    // Only the DIFFERENCE is charged — not the new zone's full price.
    const upOrder = await prisma.order.findUnique({
      where: { id: res.data?.orderId ?? "" },
      select: { totalCents: true, status: true, customerId: true },
    });
    check("it charges only the difference", upOrder?.totalCents === 30000, `${mad(upOrder?.totalCents ?? 0)} MAD (500-200)`);
    check("and that order is PAID", upOrder?.status === "PAID", `${upOrder?.status}`);

    // The ORIGINAL order must be untouched: rewriting a settled record to
    // make the sum come out right falsifies what was actually charged.
    const original = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { totalCents: true, status: true, refundedCents: true },
    });
    check(
      "the original order is left exactly as it was",
      original?.totalCents === 20000 && original?.status === "PAID" && (original?.refundedCents ?? 0) === 0,
      `${mad(original?.totalCents ?? 0)} MAD ${original?.status} refunded=${mad(original?.refundedCents ?? 0)}`,
    );

    // The platform earns on the difference, like any other sale.
    const fee = await prisma.order.findUnique({
      where: { id: res.data?.orderId ?? "" },
      select: { feeCents: true },
    });
    check("the platform's commission is recorded", typeof fee?.feeCents === "number", `feeCents=${fee?.feeCents}`);

    // Inventory: the seat left Gradin and landed in Fosse.
    const avail = await call("GET", `/api/orders/availability/${slug}`);
    check(
      "the vacated zone got its seat back",
      avail.data?.remaining?.[byName.Gradin] === 10,
      `Gradin ${avail.data?.remaining?.[byName.Gradin]}/10`,
    );
    check(
      "and the new zone lost one",
      avail.data?.remaining?.[byName.Fosse] === 9,
      `Fosse ${avail.data?.remaining?.[byName.Fosse]}/10`,
    );

    // Exactly one ticket: an upgrade MOVES a seat, it does not issue another.
    const count = await prisma.ticket.count({ where: { orderId: order.orderId, status: "VALID" } });
    check("no second ticket was issued", count === 1, `${count} valid ticket(s) on the original order`);
  }

  // ── 2. The last seat of a zone ──────────────────────────────────────────
  section("2. The reservation must not block the upgrade it protects");
  {
    /*
     * The upgrade order holds a line on the target tier — that IS the
     * reservation. If the capacity check counted it, the last seat of a zone
     * could never be upgraded into: the buyer would pay and then be refused
     * by their own hold. Capacity 1 is the case that catches it.
     */
    const { slug, event } = await makeEvent(organiser, "last", [
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 5, zoneFr: "G" }),
      tier({ nameFr: "Loge", priceCents: 60000, capacity: 1, zoneFr: "L" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const order = await buy(customer, slug, byName.Gradin);
    orderIds.push(order.orderId);

    const res = await call("POST", `/api/tickets/${order.tickets[0].id}/upgrade`, {
      token: customer,
      body: payload(byName.Loge),
    });
    check("the LAST seat of a zone can be upgraded into", res.status === 200, `${res.status} ${JSON.stringify(res.data).slice(0, 70)}`);
    if (res.data?.orderId) orderIds.push(res.data.orderId);

    const after = await call("GET", `/api/tickets/${order.tickets[0].id}`, { token: customer });
    check("and the ticket really moved", after.data?.tier?.nameFr === "Loge", `${after.data?.tier?.nameFr}`);
  }

  // ── 3. A full zone ──────────────────────────────────────────────────────
  section("3. A zone with nothing left");
  {
    const { slug, event } = await makeEvent(organiser, "full", [
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 5, zoneFr: "G" }),
      tier({ nameFr: "Loge", priceCents: 60000, capacity: 1, zoneFr: "L" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const taken = await buy(customer, slug, byName.Loge);     // Loge now full
    orderIds.push(taken.orderId);
    const mine = await buy(customer, slug, byName.Gradin);
    orderIds.push(mine.orderId);

    const res = await call("POST", `/api/tickets/${mine.tickets[0].id}/upgrade`, {
      token: customer,
      body: payload(byName.Loge),
    });
    check("upgrading into a full zone is refused", res.status === 409, `${res.status}`);

    const after = await call("GET", `/api/tickets/${mine.tickets[0].id}`, { token: customer });
    check("the ticket stayed where it was", after.data?.tier?.nameFr === "Gradin", `${after.data?.tier?.nameFr}`);

    /*
     * Nothing may have been charged for a refusal, and no upgrade row may
     * survive holding a seat.
     *
     * Scoped by SLUG, not by `event.id`: the organiser API does not return
     * an id, so `{ eventId: event.id }` passed `undefined` — and Prisma DROPS
     * an undefined key from a where clause rather than matching nothing, so
     * both counts silently covered the entire database and failed against
     * other sections' legitimate upgrades.
     */
    const eventRow = await prisma.event.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const upgrades = await prisma.ticketUpgrade.count({
      where: { ticket: { order: { eventId: eventRow.id } } },
    });
    check("no upgrade record was left behind", upgrades === 0, `${upgrades} upgrade row(s)`);
    const paid = await prisma.order.count({ where: { eventId: eventRow.id, status: "PAID" } });
    check("and nothing beyond the two purchases was charged", paid === 2, `${paid} paid order(s)`);
  }

  // ── 4. What is not an upgrade ───────────────────────────────────────────
  section("4. Only an upgrade belongs on this route");
  {
    const { slug, event } = await makeEvent(organiser, "wrong", [
      tier({ nameFr: "Balcon", priceCents: 10000, capacity: 5, zoneFr: "B" }),
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 5, zoneFr: "G" }),
      tier({ nameFr: "Autre", priceCents: 20000, capacity: 5, zoneFr: "X" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const order = await buy(customer, slug, byName.Gradin);
    orderIds.push(order.orderId);
    const ticketId = order.tickets[0].id;

    const down = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: customer,
      body: payload(byName.Balcon),
    });
    check("a DOWNGRADE is refused here (it is free, and /exchange does it)", down.status === 400, `${down.status}`);

    const same = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: customer,
      body: payload(byName.Autre),
    });
    check("a same-price move is refused too", same.status === 400, `${same.status}`);

    const self = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: customer,
      body: payload(byName.Gradin),
    });
    check("so is moving to the zone it is already in", self.status === 400, `${self.status}`);

    const bogus = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: customer,
      body: payload("no-such-tier"),
    });
    check("an unknown zone is 404", bogus.status === 404, `${bogus.status}`);

    const stillThere = await call("GET", `/api/tickets/${ticketId}`, { token: customer });
    check("none of the refusals moved the ticket", stillThere.data?.tier?.nameFr === "Gradin", `${stillThere.data?.tier?.nameFr}`);
  }

  // ── 5. Whose money, whose ticket ────────────────────────────────────────
  section("5. Only the owner may spend");
  {
    const { slug, event } = await makeEvent(organiser, "authz", [
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 5, zoneFr: "G" }),
      tier({ nameFr: "Fosse", priceCents: 50000, capacity: 5, zoneFr: "F" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const order = await buy(customer, slug, byName.Gradin);
    orderIds.push(order.orderId);
    const ticketId = order.tickets[0].id;

    const anon = await call("POST", `/api/tickets/${ticketId}/upgrade`, { body: payload(byName.Fosse) });
    check("an anonymous stranger cannot upgrade it", anon.status === 401 || anon.status === 403, `${anon.status}`);

    const other = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      token: organiser,
      body: payload(byName.Fosse),
    });
    check("another logged-in user cannot upgrade it", other.status === 403, `${other.status}`);

    // The order link proves someone HOLDS a ticket, not that they may spend
    // on it — the same rule as resale and share.
    const full = await prisma.order.findUnique({ where: { id: order.orderId }, select: { accessToken: true } });
    const viaLink = await call("POST", `/api/tickets/${ticketId}/upgrade`, {
      orderToken: full?.accessToken,
      body: payload(byName.Fosse),
    });
    check("the order link alone cannot upgrade it", viaLink.status === 401 || viaLink.status === 403, `${viaLink.status}`);

    const after = await call("GET", `/api/tickets/${ticketId}`, { token: customer });
    check("the ticket is untouched after all three", after.data?.tier?.nameFr === "Gradin", `${after.data?.tier?.nameFr}`);
  }

  // ── 6. A ticket that cannot move ────────────────────────────────────────
  section("6. State before money");
  {
    const { slug, event } = await makeEvent(organiser, "state", [
      tier({ nameFr: "Gradin", priceCents: 20000, capacity: 5, zoneFr: "G" }),
      tier({ nameFr: "Fosse", priceCents: 50000, capacity: 5, zoneFr: "F" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((x) => [x.nameFr, x.id]));

    const order = await buy(customer, slug, byName.Gradin, 2);
    orderIds.push(order.orderId);
    const [t1, t2] = order.tickets;

    // Admitted at the gate.
    await call("POST", "/api/gate/check-in", {
      token: organiser,
      body: { ref: t1.ref, source: "manual" },
    });
    // Confirmed from the database first: if the scan silently failed, the
    // refusal below would be testing a VALID ticket and prove nothing.
    const scanned = await prisma.ticket.findUnique({ where: { id: t1.id }, select: { status: true } });
    check("(setup) the ticket really was admitted", scanned?.status === "USED", `${scanned?.status}`);

    const used = await call("POST", `/api/tickets/${t1.id}/upgrade`, {
      token: customer,
      body: payload(byName.Fosse),
    });
    check("a USED ticket cannot be upgraded", used.status === 409, `${used.status}`);

    // Two at once would hold two seats for someone who can sit in one.
    // (Mock mode settles immediately, so the first is DONE — the second is
    // then refused on the ticket's new zone rather than on concurrency.)
    const first = await call("POST", `/api/tickets/${t2.id}/upgrade`, {
      token: customer,
      body: payload(byName.Fosse),
    });
    if (first.data?.orderId) orderIds.push(first.data.orderId);
    const second = await call("POST", `/api/tickets/${t2.id}/upgrade`, {
      token: customer,
      body: payload(byName.Fosse),
    });
    check("upgrading to the zone it just moved to is refused", second.status === 400, `${second.status}`);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  section("Cleanup");
  {
    for (const id of orderIds) {
      await call("DELETE", `/api/organiser/orders/${id}`, { token: organiser });
    }
    for (const slug of slugs) {
      const ev = await prisma.event.findUnique({ where: { slug }, select: { id: true } });
      if (!ev) continue;
      const remaining = await prisma.order.findMany({ where: { eventId: ev.id }, select: { id: true } });
      for (const o of remaining) {
        await call("DELETE", `/api/organiser/orders/${o.id}`, { token: organiser });
      }
      await call("DELETE", `/api/organiser/events/${slug}`, { token: organiser });
    }
    const left = await prisma.event.count({ where: { slug: { startsWith: PREFIX } } });
    check("test data removed", left === 0, `${left} event(s) left`);
  }

  console.log(
    `\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass}/${pass + fail} passed\x1b[0m${
      fail ? `\n  failed: ${failures.join(", ")}` : ""
    }\n`,
  );
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await prisma.$disconnect();
  process.exit(1);
});
