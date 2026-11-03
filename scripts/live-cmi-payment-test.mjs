/**
 * Live test — the CMI callback only takes money when it delivers something.
 *
 * CMI is a REDIRECT gateway, and that single fact is what these checks are
 * about. Stripe confirmed a card in-page, in seconds, so the window between
 * "buyer starts paying" and "payment settles" was negligible. A CMI buyer
 * leaves for CMI's own hosted page and takes as long as they take to find
 * their card and pass 3-D Secure — which can comfortably outlast the
 * 15-minute hold. Three things can therefore be true by the time the callback
 * arrives, none of which could happen under Stripe:
 *
 *   1. The hold lapsed but the sweeper has not run (up to 5 min later), so the
 *      order is still PENDING and would settle against seats that availability
 *      already handed to someone else — an oversell.
 *   2. The sweeper ran and CANCELLED the order. Settlement is correctly
 *      refused, but replying ACTION=POSTAUTH anyway charges a buyer who gets
 *      no ticket at all.
 *   3. For a resale, the listing was cancelled or sold to someone else while
 *      the buyer was paying.
 *
 * Only `ACTION=POSTAUTH` captures the money, so the rule under test is: send
 * it if and only if the buyer ends up holding something. A replay must still
 * send it (the money is genuinely owed) without minting a second ticket.
 *
 * Needs CMI configured, because the callback is signature-verified:
 *   cd backend && npx tsx ../scripts/live-cmi-payment-test.mjs
 */

import { createHash } from "node:crypto";
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const STORE_KEY = process.env.CMI_STORE_KEY;
const CLIENT_ID = process.env.CMI_CLIENT_ID;

if (!STORE_KEY || !CLIENT_ID) {
  console.log(
    "\x1b[33mCMI_CLIENT_ID / CMI_STORE_KEY are not set — these checks need the gateway configured.\x1b[0m",
  );
  process.exit(0);
}

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

// ── Signing, mirroring what CMI itself does ──────────────────────────────
const esc = (v) => String(v ?? "").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
function signed(fields) {
  const names = Object.keys(fields)
    .filter((k) => !["hash", "encoding"].includes(k.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  let plain = "";
  for (const n of names) plain += esc(fields[n]) + "|";
  return { ...fields, HASH: createHash("sha512").update(plain + esc(STORE_KEY), "utf8").digest("base64") };
}

/** Post a callback exactly as CMI would, and return its bare-text reply. */
async function callback(oid, amountMad, overrides = {}) {
  const body = signed({
    clientid: CLIENT_ID,
    oid,
    ProcReturnCode: "00",
    Response: "Approved",
    TransId: `LT${Date.now()}${Math.floor(Math.random() * 1000)}`,
    amount: amountMad,
    MaskedPan: "423456******7890",
    CardType: "VISA",
    ...overrides,
  });
  const res = await fetch(`${API}/api/webhooks/cmi`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.text()).trim();
}

const SUFFIX = Date.now();
const created = { events: [] };

/** A published event with one tier of exactly `capacity` seats. */
async function makeEvent(capacity, label) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      slug: `cmi-live-${SUFFIX}-${label}`,
      titleFr: `CMI live ${label}`,
      titleAr: "اختبار",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle", venueAr: "قاعة", address: "1 rue",
      startAt: start, endAt: start, doorsAt: start,
      image: "x.jpg",
      blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ", ageFr: "+18", ageAr: "+18",
      status: "PUBLISHED",
      // 0 = unlimited: this suite buys repeatedly as one email, which the
      // per-buyer limit exists to stop. That limit is covered by
      // live-ticketing-test; here it would only obstruct.
      maxPerBuyer: 0,
      tiers: {
        create: {
          nameFr: "Unique", nameAr: "وحيد", blurbFr: "b", blurbAr: "ب",
          priceCents: 20000, capacity,
          zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج",
        },
      },
    },
    include: { tiers: true },
  });
  created.events.push(event.id);
  return { event, tier: event.tiers[0] };
}

/*
 * The buyer account these holds are placed as.
 *
 * Buying used to be open to anyone, so this suite held seats anonymously.
 * Then an account became required to buy a ticket, and every hold here
 * started coming back 401 -- which surfaced only as `undefined` order ids
 * much further down, not as a failed check. Logging in is now part of
 * setup, and holdToken is asserted before anything uses it.
 */
let holdToken = null;

async function signInBuyer() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "client@eventick.ma", password: "eventick-client-2026" }),
  });
  const data = await res.json();
  holdToken = data.token ?? null;
  return holdToken;
}

async function hold(slug, tierId, qty = 1) {
  const res = await fetch(`${API}/api/orders/hold`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(holdToken ? { Authorization: `Bearer ${holdToken}` } : {}),
    },
    body: JSON.stringify({ eventSlug: slug, lines: [{ tierId, qty }] }),
  });
  const data = await res.json();
  return {
    ok: res.status === 201,
    id: data.order?.id,
    // Paying is a write, so it needs the buyer's credential — without this
    // the retry block's /pay calls 403 and collect no oids.
    key: data.accessToken,
    amount: ((data.order?.totalCents ?? 0) / 100).toFixed(2),
  };
}

const ticketsFor = (orderId) => prisma.ticket.count({ where: { orderId } });
const statusOf = async (orderId) =>
  (await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } }))?.status;

/*
 * Clear anything an earlier run left behind.
 *
 * Cleanup runs only at the END and only on the success path, so a crash
 * mid-run orphans PUBLISHED events with no organiser -- which then show in
 * the public catalogue and fail the "every event has a seller" checks in
 * other suites. Purging on the way IN survives a crash; purging on the way
 * out does not.
 */
async function purgeStale() {
  const stale = await prisma.event.findMany({
    where: { slug: { startsWith: "cmi-live-" } },
    select: { id: true },
  });
  for (const { id } of stale) {
    const tiers = await prisma.ticketTier.findMany({ where: { eventId: id }, select: { id: true } });
    const tierIds = tiers.map((t) => t.id);
    await prisma.ticketUpgrade.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticketShare.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.order.deleteMany({ where: { eventId: id } });
    await prisma.ticketTier.deleteMany({ where: { eventId: id } });
    await prisma.event.delete({ where: { id } });
  }
  return stale.length;
}

async function main() {
  const purged = await purgeStale();
  if (purged > 0) console.log(`  [2mcleared ${purged} event(s) from an earlier run[0m`);

  // Holding seats needs an account now. Checked here rather than left to
  // fail as an undefined order id three sections later.
  check("(setup) the buyer signs in", Boolean(await signInBuyer()), holdToken ? "ok" : "no token");

  // ── The ordinary case still works ───────────────────────────────────────
  console.log("\n\x1b[1mA payment that arrives in time\x1b[0m");
  {
    const { event, tier } = await makeEvent(5, "happy");
    const o = await hold(event.slug, tier.id, 2);
    const reply = await callback(o.id, o.amount);
    check("the money is taken", reply === "ACTION=POSTAUTH", reply);
    check("both tickets are issued", (await ticketsFor(o.id)) === 2, `${await ticketsFor(o.id)}`);
    check("the order is PAID", (await statusOf(o.id)) === "PAID");

    // CMI retries anything it considers unanswered.
    const again = await callback(o.id, o.amount);
    check("a replay still accepts the money", again === "ACTION=POSTAUTH", again);
    check("a replay does NOT issue more tickets", (await ticketsFor(o.id)) === 2, `${await ticketsFor(o.id)}`);
  }

  // ── Swept order: charging here would be charging for nothing ────────────
  console.log("\n\x1b[1mPayment arrives after the order was cancelled\x1b[0m");
  {
    const { event, tier } = await makeEvent(5, "swept");
    const o = await hold(event.slug, tier.id);
    // What the sweeper does to a lapsed hold.
    await prisma.order.update({ where: { id: o.id }, data: { status: "CANCELLED", holdUntil: null } });

    const reply = await callback(o.id, o.amount);
    check("the money is REFUSED", reply === "FAILURE", reply);
    check("no ticket is minted", (await ticketsFor(o.id)) === 0);
    check("the order stays CANCELLED", (await statusOf(o.id)) === "CANCELLED");
  }

  // ── The oversell window the redirect flow opens ─────────────────────────
  console.log("\n\x1b[1mLate payment for a seat someone else has taken\x1b[0m");
  {
    const { event, tier } = await makeEvent(1, "oversell");
    const late = await hold(event.slug, tier.id);
    check("buyer A holds the only seat", late.ok);

    // A's hold lapses while they are on CMI's page. The sweeper has NOT run,
    // so A's order is still PENDING — this is the dangerous window.
    await prisma.order.update({ where: { id: late.id }, data: { holdUntil: new Date(Date.now() - 60_000) } });

    const prompt = await hold(event.slug, tier.id);
    check("buyer B can take the freed seat", prompt.ok);
    check("B's payment succeeds", (await callback(prompt.id, prompt.amount)) === "ACTION=POSTAUTH");

    const reply = await callback(late.id, late.amount);
    check("A's late payment is REFUSED", reply === "FAILURE", reply);
    check("A gets no ticket", (await ticketsFor(late.id)) === 0);
    const issued = await prisma.ticket.count({ where: { tierId: tier.id, status: { in: ["VALID", "USED"] } } });
    check("the tier is NOT oversold", issued === 1, `${issued} ticket(s) for capacity 1`);
  }

  // ── Resale: the listing can go while the buyer is paying ────────────────
  console.log("\n\x1b[1mResale whose listing disappeared mid-payment\x1b[0m");
  {
    const { event, tier } = await makeEvent(5, "resale");
    const sellerOrder = await prisma.order.create({
      data: {
        eventId: event.id, status: "PAID", holderName: "Seller",
        email: "seller@eventick.ma", phone: "0612345678",
        subtotalCents: tier.priceCents, totalCents: tier.priceCents, paymentRef: "SEED",
        tickets: { create: { ref: `LT-${SUFFIX}`, tierId: tier.id, holderName: "Seller" } },
      },
      include: { tickets: true },
    });
    const sellerTicket = sellerOrder.tickets[0];
    const listing = await prisma.resaleListing.create({
      data: { ticketId: sellerTicket.id, priceCents: tier.priceCents, token: `lt-${SUFFIX}`, status: "LISTED" },
    });

    // Buying a resold seat needs an account too, for the same reason a
    // normal hold does -- see signInBuyer.
    const res = await fetch(`${API}/api/resale/${listing.token}/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${holdToken}` },
      body: JSON.stringify({ holderName: "Resale Buyer", email: "rb@eventick.ma", phone: "0612345679" }),
    });
    const buy = await res.json();
    check("the resale buyer is sent to CMI", buy.mode === "cmi", buy.mode ?? buy.error);

    // The seller changes their mind while the buyer is on CMI's page.
    await prisma.resaleListing.update({
      where: { id: listing.id },
      data: { status: "CANCELLED", closedAt: new Date() },
    });

    const reply = await callback(buy.orderId, (tier.priceCents / 100).toFixed(2));
    check("the money is REFUSED", reply === "FAILURE", reply);
    check("no replacement ticket is minted", (await ticketsFor(buy.orderId)) === 0);
    check("the buyer's order is not left looking PAID", (await statusOf(buy.orderId)) === "PENDING");
    const seller = await prisma.ticket.findUnique({ where: { id: sellerTicket.id }, select: { status: true } });
    check("the seller keeps their seat", seller.status === "VALID", seller.status);
  }

  // ═══ A buyer whose card was declined can try again ═══════════════════
  console.log("\n\x1b[1mRetrying after a decline\x1b[0m");
  {
    /*
     * CMI treats its `oid` as ONE transaction. The oid was the bare order id,
     * so the second attempt came back as "There is an ongoing transaction
     * related to the order. (99)" and the buyer was stuck until the hold
     * lapsed. Found by paying twice against the real test gateway.
     */
    const { event, tier } = await makeEvent(5, "retry");
    const first = await hold(event.slug, tier.id);

    const oids = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${API}/api/orders/${first.id}/pay?k=${encodeURIComponent(first.key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holderName: "Retry", email: `retry-${SUFFIX}@eventick.ma`, phone: "0612345678" }),
      });
      const d = await r.json();
      if (d.fields?.oid) oids.push(d.fields.oid);
    }
    check("each attempt gets its own oid", new Set(oids).size === 3, oids.join(" "));
    check("every oid resolves to the same order", oids.every((o) => o.startsWith(first.id)), oids[0]);

    // Decline the second, approve the third.
    const declined = await callback(oids[1], first.amount, { ProcReturnCode: "99", Response: "Declined" });
    check("a decline leaves the order payable", declined === "FAILURE", declined);
    const approved = await callback(oids[2], first.amount);
    check("the retry settles", approved === "ACTION=POSTAUTH", approved);
    check("a ticket is issued", (await ticketsFor(first.id)) === 1, `${await ticketsFor(first.id)}`);

    // An oid with no suffix still resolves, for anything in flight.
    const plain = await callback(first.id, first.amount, { ProcReturnCode: "99", Response: "Declined", TransId: `LT${SUFFIX}plain` });
    check("an unsuffixed oid still resolves", plain === "FAILURE", plain);
  }

  // ═══ Upgrading a seat: the money only moves if the seat does ════
  console.log("\n\x1b[1mPaying to move up a zone\x1b[0m");
  {
    /*
     * An upgrade is the third thing that can be bought through CMI, and the
     * only one that moves an EXISTING ticket rather than issuing a new one.
     * Its callback branch therefore has its own way to go wrong: settle
     * through settleOrder and the buyer gets a second ticket instead of a
     * better seat.
     *
     * mock mode cannot exercise any of this -- it settles in-process without
     * a callback at all -- so these are the checks that only exist here.
     */
    const upStart = new Date(Date.now() + 30 * 86_400_000);
    const upEvent = await prisma.event.create({
      data: {
        slug: `cmi-live-${SUFFIX}-upgrade`,
        titleFr: "CMI live upgrade", titleAr: "\u062a\u0631\u0642\u064a\u0629",
        category: "concert", city: "Casablanca",
        venueFr: "Salle", venueAr: "\u0642\u0627\u0639\u0629", address: "1 rue",
        startAt: upStart, endAt: upStart, doorsAt: upStart,
        image: "x.jpg",
        blurbFr: "b", blurbAr: "\u0628", aboutFr: "a", aboutAr: "\u0623", ageFr: "+18", ageAr: "+18",
        status: "PUBLISHED", maxPerBuyer: 0,
        tiers: {
          create: [
            { nameFr: "Gradin", nameAr: "\u0645\u062f\u0631\u062c", blurbFr: "b", blurbAr: "\u0628", priceCents: 20000, capacity: 5, zoneFr: "G", zoneAr: "\u062c", gateFr: "1", gateAr: "1" },
            { nameFr: "Fosse", nameAr: "\u062d\u0644\u0628\u0629", blurbFr: "b", blurbAr: "\u0628", priceCents: 50000, capacity: 2, zoneFr: "F", zoneAr: "\u0641", gateFr: "2", gateAr: "2" },
          ],
        },
      },
      include: { tiers: true },
    });
    created.events.push(upEvent.id);
    const gradin = upEvent.tiers.find((t) => t.nameFr === "Gradin");
    const fosse = upEvent.tiers.find((t) => t.nameFr === "Fosse");

    // Upgrading needs a real session, unlike the resale buy above.
    const auth = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "client@eventick.ma", password: "eventick-client-2026" }),
    });
    const token = (await auth.json()).token;

    /** A paid Gradin ticket owned by that account. */
    async function seatFor(label) {
      const me = await prisma.user.findUniqueOrThrow({
        where: { email: "client@eventick.ma" },
        select: { id: true },
      });
      const order = await prisma.order.create({
        data: {
          eventId: upEvent.id, customerId: me.id, status: "PAID",
          holderName: "Upgrader", email: "client@eventick.ma", phone: "0612345678",
          subtotalCents: gradin.priceCents, totalCents: gradin.priceCents, paymentRef: `SEED-${label}`,
          lines: { create: [{ tierId: gradin.id, qty: 1 }] },
          tickets: { create: { ref: `LU-${SUFFIX}-${label}`, tierId: gradin.id, holderName: "Upgrader" } },
        },
        include: { tickets: true },
      });
      return { order, ticket: order.tickets[0] };
    }

    const beginUpgrade = async (ticketId) => {
      const res = await fetch(`${API}/api/tickets/${ticketId}/upgrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tierId: fosse.id,
          holderName: "Upgrader", email: "client@eventick.ma", phone: "0612345678",
        }),
      });
      return res.json();
    };

    // -- It works, end to end, through the gateway -----------------------
    const a = await seatFor("ok");
    const upA = await beginUpgrade(a.ticket.id);
    check("the upgrade sends the buyer to CMI", upA.mode === "cmi", upA.mode ?? upA.error);
    check("and asks only for the difference", upA.dueCents === 30000, `${upA.dueCents}`);

    // While they are away the seat must be held -- that is the whole reason
    // the order carries a line on the target tier.
    const availDuring = await fetch(`${API}/api/orders/availability/${upEvent.slug}`).then((r) => r.json());
    check(
      "the target seat is RESERVED while they pay",
      availDuring.remaining?.[fosse.id] === 1,
      `Fosse ${availDuring.remaining?.[fosse.id]}/2 left`,
    );

    const replyA = await callback(upA.orderId, "300.00");
    check("the money is taken", replyA === "ACTION=POSTAUTH", replyA);
    const movedA = await prisma.ticket.findUnique({ where: { id: a.ticket.id }, select: { tierId: true } });
    check("the ticket moved to the dearer zone", movedA.tierId === fosse.id, movedA.tierId === gradin.id ? "still Gradin" : "moved");
    check("and NO second ticket was minted", (await ticketsFor(upA.orderId)) === 0, `${await ticketsFor(upA.orderId)} on the upgrade order`);
    check("the upgrade order is PAID", (await statusOf(upA.orderId)) === "PAID");

    // CMI retries anything it thinks went unanswered. The money is genuinely
    // owed, so it must still be taken -- without moving the seat twice.
    const replayA = await callback(upA.orderId, "300.00");
    check("a replay still takes the money", replayA === "ACTION=POSTAUTH", replayA);
    check("and mints nothing on the replay", (await ticketsFor(upA.orderId)) === 0);

    // -- The zone fills while the buyer is on CMI's page -----------------
    /*
     * The failure branch, which mock mode can never reach. Fosse has 2 seats
     * and one is now taken by the upgrade above. This buyer starts an upgrade
     * for the last one, and then it is sold from under them.
     *
     * The rule: refuse the money. Keeping it would mean a buyer charged for a
     * seat they never got, and CMI has no refund API to put that right.
     */
    const b = await seatFor("full");
    const upB = await beginUpgrade(b.ticket.id);
    check("a second upgrade starts on the last seat", upB.mode === "cmi", upB.mode ?? upB.error);

    await prisma.order.create({
      data: {
        eventId: upEvent.id, status: "PAID",
        holderName: "Rival", email: "rival@eventick.ma", phone: "0612345680",
        subtotalCents: fosse.priceCents, totalCents: fosse.priceCents, paymentRef: "SEED-RIVAL",
        tickets: { create: { ref: `LR-${SUFFIX}`, tierId: fosse.id, holderName: "Rival" } },
      },
    });

    const replyB = await callback(upB.orderId, "300.00");
    check("the money is REFUSED when the zone filled", replyB === "FAILURE", replyB);
    const stuckB = await prisma.ticket.findUnique({
      where: { id: b.ticket.id },
      select: { tierId: true, status: true },
    });
    check(
      "the buyer keeps their original seat",
      stuckB.tierId === gradin.id && stuckB.status === "VALID",
      `${stuckB.status} ${stuckB.tierId === gradin.id ? "Gradin" : "moved!"}`,
    );
    /*
     * CANCELLED, not PENDING.
     *
     * The callback reverts the PAID flip to PENDING and then cancels the
     * upgrade, which closes the order to release its hold. Ending at
     * CANCELLED is the right resting place: this upgrade can never succeed
     * now that the zone is full, so leaving it payable would invite a retry
     * that has to fail. What matters is only that it is not PAID.
     */
    const statusB = await statusOf(upB.orderId);
    check("their order is not left looking PAID", statusB === "CANCELLED", statusB);
    const feeB = await prisma.order.findUnique({ where: { id: upB.orderId }, select: { feeCents: true } });
    check("and the organiser is not billed commission for it", feeB.feeCents === null, `feeCents=${feeB.feeCents}`);
    const upRowB = await prisma.ticketUpgrade.findUnique({
      where: { orderId: upB.orderId },
      select: { status: true },
    });
    check("the upgrade is closed, releasing its hold", upRowB.status === "CANCELLED", upRowB.status);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log("\n\x1b[1mCleanup\x1b[0m");
  for (const eventId of created.events) {
    const tiers = await prisma.ticketTier.findMany({ where: { eventId }, select: { id: true } });
    const tierIds = tiers.map((t) => t.id);
    await prisma.ticketUpgrade.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.resaleListing.deleteMany({ where: { ticket: { tierId: { in: tierIds } } } });
    await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
    await prisma.order.deleteMany({ where: { eventId } });
    await prisma.ticketTier.deleteMany({ where: { eventId } });
    await prisma.event.delete({ where: { id: eventId } });
  }
  const left = await prisma.event.count({ where: { slug: { startsWith: `cmi-live-${SUFFIX}` } } });
  check("test data removed", left === 0, `${left} event(s) left`);

  console.log(
    failures === 0
      ? "\n\x1b[32mAll CMI payment checks passed\x1b[0m"
      : `\n\x1b[31m${failures} FAILED\x1b[0m`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await prisma.$disconnect();
  process.exit(1);
});
