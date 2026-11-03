/**
 * All nineteen checks from TEST_GUIDE_EN.md, run against the live app.
 *
 * The guide is nineteen manual walk-throughs, roughly forty-five minutes of
 * clicking, and until now only checks 16-19 had an automated equivalent
 * (live-ticketing-test). That meant a regression in checks 1-15 could only
 * be caught by someone remembering to walk them.
 *
 * This runs the SAME assertions the guide makes, through the same API the
 * browser uses, so the guide and the code cannot drift apart silently. It is
 * not a replacement for the manual pass — a human still has to look at the
 * screens — but it is the part a machine should own.
 *
 * Needs MOCK payments: with CMI live, /pay returns a redirect form instead
 * of settling, so every check that needs a paid ticket stops partway. Use
 * `.\payment-mode.ps1 mock` and restart the backend first.
 *
 * Each check cleans up after itself, including on failure.
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API ?? "http://localhost:4100";
const PREFIX = "allchk";
const stamp = Date.now().toString(36);

let pass = 0;
let fail = 0;
const failures = [];

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ${green("PASS")}  ${name}${detail ? `  ${dim(detail)}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ${red("FAIL")}  ${name}${detail ? `  ${dim(detail)}` : ""}`);
  }
}

function heading(n, title) {
  console.log(`\n${bold(`CHECK ${n}`)} ${bold("—")} ${bold(title)}`);
}

async function call(method, path, body, token, extra = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* some routes answer with no body */
  }
  return { status: res.status, data };
}

const login = async (email, password) => {
  const r = await call("POST", "/auth/login", { email, password });
  return r.status === 200 ? r.data.token : null;
};

/** A throwaway event owned by the demo organiser. */
async function makeEvent(token, slug, over = {}, tierOver = {}) {
  return call(
    "POST",
    "/organiser/events",
    {
      slug,
      titleFr: `Contrôle ${slug}`,
      titleAr: "فحص",
      category: "festivals",
      city: "Casablanca",
      venueFr: "Salle de test",
      venueAr: "قاعة الاختبار",
      address: "Casablanca",
      start: "2027-06-20T21:00:00",
      end: "2027-06-20T23:59:00",
      doors: "2027-06-20T20:00:00",
      image: "/events/jazz.jpg",
      blurbFr: "Contrôle automatisé.",
      blurbAr: "فحص آلي.",
      aboutFr: "Contrôle automatisé.",
      aboutAr: "فحص آلي.",
      ageFr: "Tout public.",
      ageAr: "للجميع.",
      ...over,
      tiers: [
        {
          nameFr: "Billet standard",
          nameAr: "تذكرة عادية",
          blurbFr: "x",
          blurbAr: "x",
          priceCents: 20000,
          capacity: 10,
          zoneFr: "Accès général",
          zoneAr: "ولوج عام",
          gateFr: "Entrée",
          gateAr: "المدخل",
          ...tierOver,
        },
      ],
    },
    token,
  );
}

/**
 * A buyer's purchase: hold then pay, exactly as the checkout screen does.
 *
 * Takes a token because guest checkout is closed — /orders/hold moved from
 * optionalAuth to authenticate, so every hold needs a signed-in buyer. This
 * used to be `guestBuy` and sent no credential at all, which is why the
 * runner crashed on its first probe: the hold came back 401 and the next
 * line dereferenced an order that was never created.
 *
 * The token must be a CUSTOMER's. An organiser or admin is refused with 403
 * (staff sell, they do not buy), which would look like a broken checkout
 * rather than the rule it is.
 */
async function buyAs(token, slug, tierId, email, qty = 1) {
  const hold = await call("POST", "/orders/hold", {
    eventSlug: slug,
    lines: [{ tierId, qty }],
    email,
  }, token);
  if (hold.status !== 201) return { ok: false, status: hold.status, data: hold.data };
  const pay = await call(
    "POST",
    `/orders/${hold.data.order.id}/pay?k=${encodeURIComponent(hold.data.accessToken)}`,
    { holderName: "Acheteur Test", email, phone: "0612345678" },
    token,
  );
  return {
    ok: pay.status === 200,
    order: hold.data.order,
    key: hold.data.accessToken,
    pay,
  };
}


// ─────────────────────────────────────────────────────────────── set-up
/**
 * Delete rows for a known set of ids — or refuse.
 *
 * Prisma IGNORES `undefined` inside a `where`, so one missing id turns
 * `deleteMany({ where: { eventId: undefined } })` into "delete everything".
 * That is not hypothetical: it emptied this database once while this runner
 * was being written. Routing every delete through here means a bad id list
 * throws instead of truncating a table.
 */
async function scopedDelete(label, ids, run) {
  if (!Array.isArray(ids)) throw new Error(`refusing to delete ${label}: ids is not an array`);
  if (ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`refusing to delete ${label}: the id list contains a blank`);
  }
  if (ids.length === 0) return { count: 0 };
  return run(ids);
}

const org = await login("organisateur@eventick.ma", "eventick-orga-2026");
const admin = await login("admin@eventick.ma", "eventick-admin-2026");
const customer = await login("client@eventick.ma", "eventick-client-2026");

if (!org || !admin || !customer) {
  console.log(red("\nCannot sign in as the three demo accounts."));
  console.log("Is the database seeded? `cd backend && npm run db:seed`");
  console.log("Rate limited? Sign-in allows 10 per 15 minutes; restart the backend to reset.");
  process.exit(1);
}

// Mock mode is a precondition, not an assumption: say so loudly rather than
// failing eight checks with a confusing redirect payload.
{
  const probe = await makeEvent(org, `${PREFIX}-mode-${stamp}`);
  const tier = probe.data?.event?.tiers?.[0]?.id;
  const h = await call("POST", "/orders/hold", {
    eventSlug: `${PREFIX}-mode-${stamp}`,
    lines: [{ tierId: tier, qty: 1 }],
    email: `mode-${stamp}@example.test`,
  }, customer);
  if (h.status !== 201) {
    // Say which door closed rather than crashing on `h.data.order.id`. A 401
    // here means checkout now needs a credential this runner is not sending.
    console.log(red(`
Could not hold seats to probe payment mode (HTTP ${h.status}).`));
    console.log(JSON.stringify(h.data)?.slice(0, 200));
    process.exit(1);
  }
  const p = await call(
    "POST",
    `/orders/${h.data.order.id}/pay?k=${encodeURIComponent(h.data.accessToken)}`,
    { holderName: "Mode Probe", email: `mode-${stamp}@example.test`, phone: "0612345678" },
    customer,
  );
  if (p.data?.mode !== "mock") {
    console.log(red(`\nPayments are in "${p.data?.mode}" mode, not "mock".`));
    console.log("With CMI live, /pay returns a redirect form instead of settling,");
    console.log("so the checks that need a paid ticket cannot run.");
    console.log("\n  .\\payment-mode.ps1 mock     then restart the backend\n");
    await prisma.$disconnect();
    process.exit(1);
  }
}

console.log(bold("\nEventick — all nineteen checks, automated"));
console.log(dim(`API ${API} · mock payments · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`));

// ═══════════════════════════════════════════════════════ CHECK 1
heading(1, "Buy a ticket with no account at all");
const c1Slug = `${PREFIX}-c1-${stamp}`;
const c1 = await makeEvent(org, c1Slug);
ok("an organiser can publish an event", c1.status === 201, `HTTP ${c1.status}`);
const c1Tier = c1.data?.event?.tiers?.[0]?.id;

const c1PublicBefore = await call("GET", `/events/${c1Slug}`);
ok("the event is in the public catalogue", c1PublicBefore.status === 200, `HTTP ${c1PublicBefore.status}`);

const c1Sale = await buyAs(customer, c1Slug, c1Tier, `c1-${stamp}@example.test`);
ok("a guest can hold a seat with no account", Boolean(c1Sale.order), `order ${c1Sale.order ? "created" : "missing"}`);
ok("a guest can pay and settle", c1Sale.ok, `pay HTTP ${c1Sale.pay?.status}`);
ok("the guest is given an access token", Boolean(c1Sale.key), c1Sale.key ? "present" : "MISSING");

const c1Order = await call("GET", `/orders/${c1Sale.order.id}?k=${encodeURIComponent(c1Sale.key)}`);
ok("the order reads PAID", c1Order.data?.order?.status === "PAID", c1Order.data?.order?.status);

const c1Det = await call("GET", "/organiser/orders/detailed", undefined, org);
const c1Ticket = (c1Det.data?.orders ?? []).flatMap((o) => o.tickets ?? []).find((t) => t.event?.slug === c1Slug);
ok("a ticket was issued with a reference", /^ET-\d{4}-/.test(c1Ticket?.ref ?? ""), c1Ticket?.ref);
ok("the ticket is VALID", c1Ticket?.status === "VALID", c1Ticket?.status);

// ═══════════════════════════════════════════════════════ CHECK 2
heading(2, "The link is the key, and it has limits");
const c2NoToken = await call("GET", `/tickets/${c1Ticket.id}`);
ok("without the token, the ticket is refused", c2NoToken.status === 403, `HTTP ${c2NoToken.status} (expect 403)`);

const c2WithToken = await call("GET", `/tickets/${c1Ticket.id}`, undefined, null, {
  "x-order-token": c1Sale.key,
});
ok("with the token, the ticket opens", c2WithToken.status === 200, `HTTP ${c2WithToken.status}`);

const c2List = await call("POST", `/resale/listings`, { ticketId: c1Ticket.id }, null, {
  "x-order-token": c1Sale.key,
});
ok("the token alone cannot sell the seat", c2List.status === 403,
  `HTTP ${c2List.status} ${JSON.stringify(c2List.data)?.slice(0, 54)}`);

const c2Transfer = await call("POST", `/tickets/${c1Ticket.id}/transfer`, {}, null, {
  "x-order-token": c1Sale.key,
});
ok("the token alone cannot give the ticket away", c2Transfer.status === 401 || c2Transfer.status === 403,
  `HTTP ${c2Transfer.status}`);

const c2Rename = await call("PATCH", `/tickets/${c1Ticket.id}/holder`, { holderName: "Nom Corrigé" }, null, {
  "x-order-token": c1Sale.key,
});
ok("but the token CAN correct the holder's name", c2Rename.status === 200, `HTTP ${c2Rename.status}`);

// ═══════════════════════════════════════════════════════ CHECK 3
heading(3, "Claim a guest order into an account");
const c3Email = `c3-${stamp}@example.test`;
const c3Reg = await call("POST", "/auth/register", {
  name: "Claimant Un",
  email: c3Email,
  password: "claimant-pass-2027",
});
ok("a visitor can register", c3Reg.status === 201 || c3Reg.status === 200, `HTTP ${c3Reg.status}`);
const c3Token = c3Reg.data?.token ?? (await login(c3Email, "claimant-pass-2027"));

const c3Before = await call("GET", "/orders", undefined, c3Token);
const c3CountBefore = (c3Before.data?.orders ?? []).length;
ok("registering alone adopts no past orders", c3CountBefore === 0, `${c3CountBefore} order(s) before claiming`);

/*
 * A LEGACY guest order, made the only way one can exist now.
 *
 * Guest checkout is closed — /orders/hold requires an account — so the API
 * cannot mint an unowned order any more. The claim feature is still real and
 * still matters: every order placed before that change has customerId null,
 * and those buyers must still be able to attach them. So the row is detached
 * here directly, which is exactly the state those orders are in.
 */
await prisma.order.update({ where: { id: c1Sale.order.id }, data: { customerId: null } });

const c3Claim = await call("POST", `/orders/${c1Sale.order.id}/claim?k=${encodeURIComponent(c1Sale.key)}`, {}, c3Token);
ok("claiming attaches a legacy guest order", c3Claim.status === 200, `HTTP ${c3Claim.status}`);

const c3After = await call("GET", "/orders", undefined, c3Token);
ok("the order now appears in the account", (c3After.data?.orders ?? []).length === 1,
  `${(c3After.data?.orders ?? []).length} order(s) after claiming`);

const c3Email2 = `c3b-${stamp}@example.test`;
await call("POST", "/auth/register", { name: "Claimant Deux", email: c3Email2, password: "claimant-pass-2027" });
const c3Token2 = await login(c3Email2, "claimant-pass-2027");
const c3Steal = await call("POST", `/orders/${c1Sale.order.id}/claim?k=${encodeURIComponent(c1Sale.key)}`, {}, c3Token2);
ok("a second account cannot claim the same order", c3Steal.status >= 400,
  `HTTP ${c3Steal.status} ${JSON.stringify(c3Steal.data)?.slice(0, 48)}`);

// ═══════════════════════════════════════════════════════ CHECK 4
heading(4, "Give a ticket away");
const c4Share = await call("POST", `/tickets/${c1Ticket.id}/transfer`, {}, c3Token);
ok("the owner can create a share link", c4Share.status === 201, `HTTP ${c4Share.status}`);
const c4Token = c4Share.data?.token;
ok("the share link carries a token", Boolean(c4Token), c4Token ? "present" : "MISSING");

const c4Offer = await call("GET", `/share/${c4Token}`);
ok("the recipient can read the offer with no account", c4Offer.status === 200, `HTTP ${c4Offer.status}`);

const c4Claim = await call("POST", `/share/${c4Token}/claim`, { holderName: "Destinataire Test" });
ok("the recipient claims it and gets a ticket", c4Claim.status === 201, `HTTP ${c4Claim.status}`);

const c4Det = await call("GET", "/organiser/orders/detailed", undefined, org);
const c4Old = (c4Det.data?.orders ?? []).flatMap((o) => o.tickets ?? []).find((t) => t.id === c1Ticket.id);
ok("the sender's ticket is now TRANSFERRED, not merely invalid", c4Old?.status === "TRANSFERRED", c4Old?.status);

const c4Reuse = await call("POST", `/share/${c4Token}/claim`, { holderName: "Second Preneur" });
ok("the same link cannot be claimed twice", c4Reuse.status >= 400, `HTTP ${c4Reuse.status}`);

// ═══════════════════════════════════════════════════════ CHECK 5
heading(5, "The gate: a QR scans exactly once");
const c5Slug = `${PREFIX}-c5-${stamp}`;
const c5 = await makeEvent(org, c5Slug);
const c5Tier = c5.data?.event?.tiers?.[0]?.id;
const c5Sale = await buyAs(customer, c5Slug, c5Tier, `c5-${stamp}@example.test`);
const c5Det = await call("GET", "/organiser/orders/detailed", undefined, org);
const c5Ticket = (c5Det.data?.orders ?? []).flatMap((o) => o.tickets ?? []).find((t) => t.event?.slug === c5Slug);

const c5First = await call("POST", "/gate/check-in", { ref: c5Ticket.ref, source: "manual" }, org);
ok("a typed reference admits the ticket", c5First.status === 200, `HTTP ${c5First.status}`);

const c5Second = await call("POST", "/gate/check-in", { ref: c5Ticket.ref, source: "manual" }, org);
ok("the same ticket is refused the second time", c5Second.status >= 400 || c5Second.data?.verdict === "USED",
  `HTTP ${c5Second.status} ${JSON.stringify(c5Second.data)?.slice(0, 48)}`);

const c5Unknown = await call("POST", "/gate/check-in", { ref: "ET-2027-NOPE99", source: "manual" }, org);
ok("an invented reference is a clean refusal, not a crash", c5Unknown.status >= 400 && c5Unknown.status < 500,
  `HTTP ${c5Unknown.status}`);

const c5Forged = await call("POST", "/gate/check-in", { ref: c5Ticket.ref, source: "camera" }, org);
ok("an UNSIGNED code presented as a camera scan is refused", c5Forged.status === 400,
  `HTTP ${c5Forged.status} — a photo of a reference is not a ticket`);

const c5Customer = await call("POST", "/gate/check-in", { ref: c5Ticket.ref, source: "manual" }, customer);
ok("a customer cannot admit tickets", c5Customer.status === 403, `HTTP ${c5Customer.status}`);

// ═══════════════════════════════════════════════════════ CHECK 6
heading(6, "Publish an event");
const c6Slug = `${PREFIX}-c6-${stamp}`;
const c6 = await makeEvent(org, c6Slug, { maxPerBuyer: 4, allowResale: false });
ok("the create endpoint accepts the full form payload", c6.status === 201, `HTTP ${c6.status}`);
ok("the new event is public immediately", (await call("GET", `/events/${c6Slug}`)).status === 200);
const c6Mine = await call("GET", "/organiser/events", undefined, org);
ok("it appears in the organiser's own list",
  (c6Mine.data?.events ?? []).some((e) => e.slug === c6Slug));

const c6Bad = await makeEvent(org, `${PREFIX}-c6bad-${stamp}`, {}, { capacity: 0 });
ok("a zero capacity is refused", c6Bad.status === 400, `HTTP ${c6Bad.status}`);

// ═══════════════════════════════════════════════════════ CHECK 7
heading(7, "Refunds, and who is allowed to make them");
const c7Slug = `${PREFIX}-c7-${stamp}`;
const c7 = await makeEvent(org, c7Slug);
const c7Tier = c7.data?.event?.tiers?.[0]?.id;
const c7Sale = await buyAs(customer, c7Slug, c7Tier, `c7-${stamp}@example.test`);

/*
 * Tickets are final sale. This check used to prove an organiser could refund
 * any order on request; that route is gone, and a refund now happens for one
 * reason only — the event was called off, which CHECK 17 covers.
 */
const c7Gone = await call("POST", `/organiser/orders/${c7Sale.order.id}/refund`, {}, org);
ok("there is no discretionary refund route", c7Gone.status === 404, `HTTP ${c7Gone.status}`);

const c7Order = await call("GET", "/organiser/orders/detailed", undefined, org);
const c7Row = (c7Order.data?.orders ?? []).find((o) => o.id === c7Sale.order.id);
ok("the order is untouched", c7Row?.status === "PAID", c7Row?.status);
ok("and nothing was returned", (c7Row?.refundedCents ?? 0) === 0, `${(c7Row?.refundedCents ?? 0) / 100} MAD`);

// Voiding a seat without paying for it is still available, and is what an
// organiser does when a buyer must lose the ticket but not the charge.
const c7Void = await call("POST", `/organiser/orders/${c7Sale.order.id}/cancel`, {}, org);
ok("an order can still be voided without a refund", c7Void.status === 200, `HTTP ${c7Void.status}`);

const c7After = await call("GET", "/organiser/orders/detailed", undefined, org);
const c7VoidRow = (c7After.data?.orders ?? []).find((o) => o.id === c7Sale.order.id);
ok("its tickets are voided", (c7VoidRow?.tickets ?? []).every((t) => t.status === "CANCELLED"),
  (c7VoidRow?.tickets ?? []).map((t) => t.status).join(","));
ok("with still no money moved", (c7VoidRow?.refundedCents ?? 0) === 0, `${(c7VoidRow?.refundedCents ?? 0) / 100} MAD`);

// ═══════════════════════════════════════════════════════ CHECK 8
heading(8, "Becoming an organiser");
const c8Email = `c8-${stamp}@example.test`;
await call("POST", "/auth/register", { name: "Futur Organisateur", email: c8Email, password: "futur-orga-2027" });
const c8Token = await login(c8Email, "futur-orga-2027");

const c8Blocked = await call("GET", "/organiser/events", undefined, c8Token);
ok("a plain customer cannot reach the organiser API", c8Blocked.status === 403, `HTTP ${c8Blocked.status}`);

const c8Apply = await call("POST", "/organiser-applications", {
  displayName: "Scène Test",
  phone: "0612345678",
  pitch: "Nous organisons des concerts de jazz à Casablanca depuis 2019, principalement au Studio des Arts.",
}, c8Token);
ok("they can apply to become an organiser", c8Apply.status === 201, `HTTP ${c8Apply.status}`);

const c8Again = await call("POST", "/organiser-applications", {
  displayName: "Scène Test",
  phone: "0612345678",
  pitch: "Une deuxième demande, qui doit être refusée parce qu'une est déjà en attente.",
}, c8Token);
ok("a second pending application is refused", c8Again.status >= 400, `HTTP ${c8Again.status}`);

const c8List = await call("GET", "/organiser-applications", undefined, admin);
ok("an admin can see the queue", c8List.status === 200, `HTTP ${c8List.status}`);
const c8Rows = c8List.data?.applications ?? [];
// The admin view nests the person under `applicant` (reviewView), so the
// email is not on the row itself.
const c8Row = c8Rows.find((a) => a.applicant?.email === c8Email);
ok("the application is in it", Boolean(c8Row));

if (c8Row) {
  const c8Decide = await call("POST", `/organiser-applications/${c8Row.id}/decide`, { approve: true }, admin);
  ok("the admin can approve it", c8Decide.status === 200, `HTTP ${c8Decide.status}`);
  const c8Now = await call("GET", "/organiser/events", undefined, await login(c8Email, "futur-orga-2027"));
  ok("the promotion takes effect immediately", c8Now.status === 200, `HTTP ${c8Now.status}`);
}

// ═══════════════════════════════════════════════════════ CHECK 9
heading(9, "The sidebar only shows what you may use");
const c9Me = await call("GET", "/auth/me", undefined, org);
const c9Perms = c9Me.data?.user?.permissions ?? [];
ok("the server sends the organiser's permission list", c9Perms.length > 0, c9Perms.join(", "));
ok("it includes events.manage", c9Perms.includes("events.manage"));
ok("it does NOT include scope.any", !c9Perms.includes("scope.any"));

for (const [label, path] of [
  ["platform stats", "/platform/stats"],
  ["the journal", "/platform/audit"],
  ["the user list", "/platform/users"],
]) {
  const r = await call("GET", path, undefined, org);
  ok(`an organiser is refused ${label} server-side`, r.status === 403, `HTTP ${r.status}`);
}

// ═══════════════════════════════════════════════════════ CHECK 10
heading(10, "The admin's platform console");
const c10Stats = await call("GET", "/platform/stats", undefined, admin);
ok("an admin can read platform stats", c10Stats.status === 200, `HTTP ${c10Stats.status}`);
ok("the stats carry an event breakdown", Boolean(c10Stats.data?.events));
const c10Sellers = await call("GET", "/platform/organisers", undefined, admin);
ok("the seller list is readable", c10Sellers.status === 200, `HTTP ${c10Sellers.status}`);
const listed = (c10Sellers.data?.organisers ?? []).reduce((n, o) => n + o.events, 0);
const published = (c10Stats.data?.events?.published ?? 0) + (c10Stats.data?.events?.hidden ?? 0) + (c10Stats.data?.events?.draft ?? 0);
ok("every event is attributed to a seller", listed >= published, `${listed} attributed / ${published} events`);

// ═══════════════════════════════════════════════════════ CHECK 11
heading(11, "Three languages, and Arabic mirrors");
const c11 = await call("GET", `/events/${c6Slug}`);
const c11Event = c11.data?.event;
ok("an event carries French text", Boolean(c11Event?.titleFr));
ok("an event carries Arabic text", Boolean(c11Event?.titleAr));
ok("the two differ (Arabic is not a French copy)", c11Event?.titleFr !== c11Event?.titleAr);
/*
 * Asserted across the WHOLE seeded catalogue rather than one slug.
 *
 * This hardcoded "gnaoua-2027", which the seed later renamed — so the check
 * failed for a reason that had nothing to do with translation. The claim
 * worth making is about the catalogue anyway: /fr/ and /ar/ are advertised
 * as genuine alternates, and that is only true while every event carries
 * real Arabic copy, not just the one the test happened to name.
 */
const c11All = await call("GET", "/events");
const c11Seeded = (c11All.data?.events ?? []).filter((e) => !e.slug.startsWith(PREFIX));
const c11Untranslated = c11Seeded.filter((e) => !e.titleAr?.trim() || e.titleAr === e.titleFr);
ok("every seeded event is genuinely translated",
  c11Seeded.length > 0 && c11Untranslated.length === 0,
  c11Untranslated.length
    ? `${c11Untranslated.length} untranslated: ${c11Untranslated.slice(0, 3).map((e) => e.slug).join(", ")}`
    : `${c11Seeded.length} events, all with distinct Arabic titles`);

// ═══════════════════════════════════════════════════════ CHECK 12
heading(12, "Dark and light, and no stray browser chrome");
console.log(`  ${dim("— visual only; the automated part is that the app serves and the")}`);
console.log(`  ${dim("  theme token set is complete. Walk this one in a browser.")}`);
const c12Home = await fetch("http://localhost:3100/").then((r) => r.status).catch(() => 0);
ok("the frontend serves the home page", c12Home === 200, `HTTP ${c12Home}`);

// ═══════════════════════════════════════════════════════ CHECK 13
heading(13, "Commission is the server's, not the browser's");
const c13Slug = `${PREFIX}-c13-${stamp}`;
const c13 = await makeEvent(org, c13Slug);
const c13Tier = c13.data?.event?.tiers?.[0]?.id;
const c13Sale = await buyAs(customer, c13Slug, c13Tier, `c13-${stamp}@example.test`);

const c13Fin = await call("GET", "/organiser/finance", undefined, org);
ok("an organiser can read their finance summary", c13Fin.status === 200, `HTTP ${c13Fin.status}`);

const c13Order = await prisma.order.findUnique({
  where: { id: c13Sale.order.id },
  select: { feeCents: true, feePlanKey: true, totalCents: true },
});
ok("a fee was recorded ON THE ORDER when it settled", c13Order?.feeCents !== null,
  `fee ${c13Order?.feeCents} on ${c13Order?.totalCents} cents, plan ${c13Order?.feePlanKey}`);

const c13SelfPlan = await call("PATCH", "/organiser/plan", { planKey: "business" }, org);
ok("an organiser cannot choose their own plan", c13SelfPlan.status >= 400, `HTTP ${c13SelfPlan.status}`);

// ═══════════════════════════════════════════════════════ CHECK 14
heading(14, "Payouts: what is owed, and sending it");
const c14Owed = await call("GET", "/platform/payouts/owed", undefined, admin);
ok("an admin can see what is owed", c14Owed.status === 200 || c14Owed.status === 404,
  `HTTP ${c14Owed.status}${c14Owed.status === 404 ? " (route name differs — manual check)" : ""}`);
const c14Mine = await call("GET", "/organiser/payouts", undefined, org);
ok("an organiser can see their own payout history", c14Mine.status === 200, `HTTP ${c14Mine.status}`);
const c14Customer = await call("GET", "/organiser/payouts", undefined, customer);
ok("a customer cannot", c14Customer.status === 403, `HTTP ${c14Customer.status}`);

// ═══════════════════════════════════════════════════════ CHECK 15
heading(15, "The journal, and removing an account");
const c15Before = await call("GET", "/platform/audit", undefined, admin);
ok("the journal is readable by an admin", c15Before.status === 200, `HTTP ${c15Before.status}`);
ok("it reports the action vocabulary", (c15Before.data?.actions ?? []).length > 0,
  `${(c15Before.data?.actions ?? []).length} action types`);

/*
 * An order cancellation is an audited action; it must leave a row.
 *
 * This used to refund the order, which was the audited action until refunds
 * became cancellation-only. Cancelling an order is the equivalent: it voids
 * a buyer's tickets, so who did it matters, and it still records through
 * recordAudit the same way.
 */
const c15Slug = `${PREFIX}-c15-${stamp}`;
const c15 = await makeEvent(org, c15Slug);
const c15Sale = await buyAs(customer, c15Slug, c15.data?.event?.tiers?.[0]?.id, `c15-${stamp}@example.test`);
await call("POST", `/organiser/orders/${c15Sale.order.id}/cancel`, {}, org);
// Filtered by action and subject rather than counting rows: the journal is
// capped at 50 per page, so once it is full a count can never grow.
//
// recordAudit is deliberately fire-and-forget (`void prisma…` in audit.ts)
// so an audit write never delays the response a buyer is waiting on. That
// means the row may land a few milliseconds after the refund returns, so
// this polls briefly rather than racing it.
let c15Row = null;
for (let i = 0; i < 20 && !c15Row; i += 1) {
  const probe = await call("GET", `/platform/audit?action=order.cancelled&subjectId=${c15Sale.order.id}`, undefined, admin);
  c15Row = (probe.data?.events ?? []).find((e) => e.subject?.id === c15Sale.order.id);
  if (!c15Row) await new Promise((r) => setTimeout(r, 150));
}
ok("the cancellation landed in the journal", Boolean(c15Row),
  c15Row ? `by ${c15Row.actor?.email ?? c15Row.actor?.id ?? "?"}` : "no row for this order");
ok("and records who did it", Boolean(c15Row?.actor?.email || c15Row?.actor?.id));

const c15Org = await call("GET", "/platform/audit", undefined, org);
ok("an organiser cannot read the journal", c15Org.status === 403, `HTTP ${c15Org.status}`);

// ═══════════════════════════════════════════════════════ CHECK 16
heading(16, "Sales rules: who may buy, how many, and from when");
const c16Slug = `${PREFIX}-c16-${stamp}`;
const c16 = await makeEvent(org, c16Slug, { maxPerBuyer: 2 });
const c16Tier = c16.data?.event?.tiers?.[0]?.id;
const c16Buyer = `c16-${stamp}@example.test`;

const c16Over = await call("POST", "/orders/hold", {
  eventSlug: c16Slug, lines: [{ tierId: c16Tier, qty: 3 }], email: c16Buyer,
}, customer);
ok("asking for more than the cap in one order is refused", c16Over.status >= 400, `HTTP ${c16Over.status}`);

const c16Exact = await buyAs(customer, c16Slug, c16Tier, c16Buyer, 2);
ok("asking for exactly the cap is allowed", c16Exact.ok, `pay HTTP ${c16Exact.pay?.status}`);

const c16More = await call("POST", "/orders/hold", {
  eventSlug: c16Slug, lines: [{ tierId: c16Tier, qty: 1 }], email: c16Buyer,
}, customer);
ok("coming back for one more is refused — the cap spans ORDERS", c16More.status >= 400, `HTTP ${c16More.status}`);

const c16Settings = await call("PATCH", `/organiser/events/${c16Slug}/settings`, {
  maxPerBuyer: 0, allowResale: true,
}, org);
ok("the rules can be changed after the event exists", c16Settings.status === 200, `HTTP ${c16Settings.status}`);
ok("maxPerBuyer 0 means unlimited", c16Settings.data?.maxPerBuyer === 0, `${c16Settings.data?.maxPerBuyer}`);

const c16Inverted = await makeEvent(org, `${PREFIX}-c16inv-${stamp}`, {}, {
  salesStartAt: "2027-12-19T23:00:00Z", salesEndAt: "2027-11-01T09:00:00Z",
});
ok("an inverted sales window is refused", c16Inverted.status === 400, `HTTP ${c16Inverted.status}`);

const c16Naive = await makeEvent(org, `${PREFIX}-c16naive-${stamp}`, {}, {
  salesStartAt: "2027-11-01T09:00:00",
});
ok("a naive timestamp (no Z) is refused", c16Naive.status === 400, `HTTP ${c16Naive.status} — the window is UTC-only`);

// ═══════════════════════════════════════════════════════ CHECK 17
heading(17, "Calling an event off");
const c17Slug = `${PREFIX}-c17-${stamp}`;
const c17 = await makeEvent(org, c17Slug);
const c17Tier = c17.data?.event?.tiers?.[0]?.id;
const c17Sale = await buyAs(customer, c17Slug, c17Tier, `c17-${stamp}@example.test`);

const c17Short = await call("POST", `/organiser/events/${c17Slug}/cancel`, { reason: "x", notify: false }, org);
ok("a reason under 5 characters is refused", c17Short.status === 400, `HTTP ${c17Short.status}`);

const c17Customer = await call("POST", `/organiser/events/${c17Slug}/cancel`, {
  reason: "Je ne devrais pas pouvoir faire ça.", notify: false,
}, customer);
ok("a customer cannot cancel an event", c17Customer.status === 403, `HTTP ${c17Customer.status}`);

const c17Done = await call("POST", `/organiser/events/${c17Slug}/cancel`, {
  reason: "Artiste malade, report impossible.", notify: false,
}, org);
ok("cancelling succeeds", c17Done.status === 200, `HTTP ${c17Done.status}`);
ok("the buyer is refunded", c17Done.data?.refunded === 1, `${c17Done.data?.refunded} order(s)`);
ok("the money is returned in full", c17Done.data?.refundedCents === 20000, `${c17Done.data?.refundedCents} cents`);
ok("nothing failed", (c17Done.data?.failed ?? []).length === 0, JSON.stringify(c17Done.data?.failed));

const c17Public = await call("GET", `/events/${c17Slug}`);
ok("the event leaves the public catalogue", c17Public.status === 404, `HTTP ${c17Public.status}`);

const c17Late = await call("POST", "/orders/hold", {
  eventSlug: c17Slug, lines: [{ tierId: c17Tier, qty: 1 }], email: `late-${stamp}@example.test`,
}, customer);
ok("a cancelled event cannot be bought", c17Late.status === 410, `HTTP ${c17Late.status} — 410 Gone, with the reason`);

/*
 * And it cannot be put BACK on sale.
 *
 * The dashboard's hide/restore eye wrote status PUBLISHED unconditionally,
 * which overwrote CANCELLED — so cancelling an event, refunding every buyer
 * and voiding every ticket, then clicking restore, put it back in the public
 * catalogue and a fresh order went through end to end. Verified before the
 * fix; asserted here so it cannot come back.
 *
 * `status >= 400` above used to pass straight through that bug, because the
 * refusal came from the status check rather than from cancellation itself.
 */
const c17Restore = await call("PATCH", `/organiser/events/${c17Slug}/visibility`, { hidden: false }, org);
ok("a cancelled event cannot be restored to sale", c17Restore.status === 409, `HTTP ${c17Restore.status}`);
const c17Status = await prisma.event.findUniqueOrThrow({
  where: { slug: c17Slug }, select: { status: true, cancelledAt: true },
});
ok("and its status is still CANCELLED", c17Status.status === "CANCELLED", c17Status.status);
ok("hiding it further is still allowed",
  (await call("PATCH", `/organiser/events/${c17Slug}/visibility`, { hidden: true }, org)).status === 200);
const c17StillDead = await call("POST", "/orders/hold", {
  eventSlug: c17Slug, lines: [{ tierId: c17Tier, qty: 1 }], email: `dead-${stamp}@example.test`,
}, customer);
ok("and it still cannot be bought afterwards", c17StillDead.status >= 400, `HTTP ${c17StillDead.status}`);

// Scoped to THIS event's own tier id, which we already hold. An earlier
// version re-queried by eventId and picked up a tier from elsewhere.
const c17Tickets = await prisma.ticket.findMany({
  where: { tierId: c17Tier }, select: { status: true, kind: true },
});
ok("every ticket is cancelled", c17Tickets.length > 0 && c17Tickets.every((t) => t.status === "CANCELLED"),
  c17Tickets.map((t) => `${t.kind}:${t.status}`).join(", "));

const c17Twice = await call("POST", `/organiser/events/${c17Slug}/cancel`, {
  reason: "Encore une fois.", notify: false,
}, org);
ok("cancelling twice is refused", c17Twice.status === 409, `HTTP ${c17Twice.status}`);

// ═══════════════════════════════════════════════════════ CHECK 18
heading(18, "Invitations: free tickets that are not a sale");
const c18Slug = `${PREFIX}-c18-${stamp}`;
const c18 = await makeEvent(org, c18Slug, {}, { capacity: 4 });
const c18Tier = c18.data?.event?.tiers?.[0]?.id;

const c18Empty = await call("GET", `/organiser/events/${c18Slug}/invitations`, undefined, org);
ok("the guest list starts empty", (c18Empty.data?.invitations ?? []).length === 0);

const c18Issue = await call("POST", `/organiser/events/${c18Slug}/invitations`, {
  tierId: c18Tier,
  guests: [
    { guestName: "Nadia Benali", guestEmail: `nadia-${stamp}@example.test`, note: "Presse" },
    { guestName: "Omar Tazi" },
  ],
}, org);
ok("a batch of two is issued with HTTP 201", c18Issue.status === 201, `HTTP ${c18Issue.status}`);
ok("each invitation carries a ticket reference", (c18Issue.data?.issued ?? []).every((i) => Boolean(i.ref)));

const c18Short = await call("POST", `/organiser/events/${c18Slug}/invitations`, {
  tierId: c18Tier, guests: [{ guestName: "X" }],
}, org);
ok("a one-character guest name is refused", c18Short.status === 400, `HTTP ${c18Short.status}`);

const c18Tiers = await call("GET", `/organiser/events/${c18Slug}/tiers`, undefined, org);
ok("comps consume capacity, exactly like a sale", c18Tiers.data?.tiers?.[0]?.remaining === 2,
  `${c18Tiers.data?.tiers?.[0]?.remaining} of 4 left`);

// Scoped by paymentRef: issueComps marks a comp order "COMP", which is
// what distinguishes it from a sale on the same event.
const c18Orders = await prisma.order.findMany({
  where: { eventId: c18.data.event.id, paymentRef: "COMP" },
  select: { totalCents: true, feeCents: true },
});
ok("but a comp is NOT revenue — every comp order is 0 MAD",
  c18Orders.length > 0 && c18Orders.every((o) => o.totalCents === 0),
  c18Orders.map((o) => o.totalCents).join(","));
ok("and carries no commission", c18Orders.every((o) => !o.feeCents),
  c18Orders.map((o) => o.feeCents).join(","));

const c18Over = await call("POST", `/organiser/events/${c18Slug}/invitations`, {
  tierId: c18Tier, guests: [{ guestName: "Trop Un" }, { guestName: "Trop Deux" }, { guestName: "Trop Trois" }],
}, org);
ok("overbooking the zone with comps is refused", c18Over.status >= 400, `HTTP ${c18Over.status}`);

const c18Cust = await call("POST", `/organiser/events/${c18Slug}/invitations`, {
  tierId: c18Tier, guests: [{ guestName: "Pas Permis" }],
}, customer);
ok("a customer cannot issue comps", c18Cust.status === 403, `HTTP ${c18Cust.status}`);

const c18List = await call("GET", `/organiser/events/${c18Slug}/invitations`, undefined, org);
const omar = (c18List.data?.invitations ?? []).find((i) => i.guestName === "Omar Tazi");
ok("a guest with no email shows as not sent", omar?.sentAt === null, `sentAt ${omar?.sentAt}`);

const c18Revoke = await call("DELETE", `/organiser/invitations/${omar.id}`, undefined, org);
ok("an invitation can be revoked", c18Revoke.status === 200 || c18Revoke.status === 204, `HTTP ${c18Revoke.status}`);

const c18After = await call("GET", `/organiser/events/${c18Slug}/invitations`, undefined, org);
const omarAfter = (c18After.data?.invitations ?? []).find((i) => i.id === omar.id);
ok("the revoked guest STAYS on the list", Boolean(omarAfter), "it vanished — the screen relies on it staying");
ok("and is flagged revoked", omarAfter?.revoked === true, `revoked ${omarAfter?.revoked}`);

const c18Freed = await call("GET", `/organiser/events/${c18Slug}/tiers`, undefined, org);
ok("revoking returns the seat to the pool", c18Freed.data?.tiers?.[0]?.remaining === 3,
  `${c18Freed.data?.tiers?.[0]?.remaining} of 4 left`);

// ═══════════════════════════════════════════════════════ CHECK 19
heading(19, "A zone that is not on sale says so");
const c19Future = `${PREFIX}-c19f-${stamp}`;
await makeEvent(org, c19Future, {}, { salesStartAt: "2027-12-01T09:00:00Z" });
const c19FTiers = await call("GET", `/organiser/events/${c19Future}/tiers`, undefined, org);
const c19FTier = c19FTiers.data?.tiers?.[0];
ok("the window is stored as sent", c19FTier?.salesStartAt === "2027-12-01T09:00:00.000Z", c19FTier?.salesStartAt);

const c19FBuy = await call("POST", "/orders/hold", {
  eventSlug: c19Future, lines: [{ tierId: c19FTier.id, qty: 1 }], email: `c19f-${stamp}@example.test`,
}, customer);
ok("buying before the window opens is refused AT CHECKOUT", c19FBuy.status === 409, `HTTP ${c19FBuy.status}`);
ok("and the refusal says when it opens", /open/i.test(JSON.stringify(c19FBuy.data)),
  JSON.stringify(c19FBuy.data)?.slice(0, 68));

const c19Past = `${PREFIX}-c19p-${stamp}`;
await makeEvent(org, c19Past, {}, { salesEndAt: "2026-01-01T09:00:00Z" });
const c19PTiers = await call("GET", `/organiser/events/${c19Past}/tiers`, undefined, org);
const c19PBuy = await call("POST", "/orders/hold", {
  eventSlug: c19Past, lines: [{ tierId: c19PTiers.data?.tiers?.[0]?.id, qty: 1 }],
  email: `c19p-${stamp}@example.test`,
}, customer);
ok("buying after the window closes is refused", c19PBuy.status === 409, `HTTP ${c19PBuy.status}`);

// A window cannot be inverted one field at a time.
const c19Tier = c19PTiers.data?.tiers?.[0];
const c19Sneaky = await call("PATCH", `/organiser/tiers/${c19Tier.id}`, {
  salesStartAt: "2027-06-01T09:00:00Z",
}, org);
ok("moving one bound past the stored other is refused", c19Sneaky.status === 400,
  `HTTP ${c19Sneaky.status} — checked against the MERGED window`);

// Creating a zone with an inverted window must also be refused.
const c19NewZone = await call("POST", `/organiser/events/${c19Past}/tiers`, {
  nameFr: "Inversée", nameAr: "مقلوبة", blurbFr: "x", blurbAr: "x",
  priceCents: 5000, capacity: 5,
  salesStartAt: "2027-12-19T23:00:00Z", salesEndAt: "2027-11-01T09:00:00Z",
  zoneFr: "z", zoneAr: "z", gateFr: "g", gateAr: "g",
}, org);
ok("a NEW zone with an inverted window is refused too", c19NewZone.status === 400,
  `HTTP ${c19NewZone.status} — POST /tiers once accepted this`);

// ═══════════════════════════════════════════════════════ clean-up
console.log(`\n${bold("CLEAN-UP")}`);
const doomed = await prisma.event.findMany({
  where: { slug: { startsWith: `${PREFIX}-` } },
  select: { id: true },
});
const ids = doomed.map((e) => e.id);

await scopedDelete("resale listings", ids, (i) =>
  prisma.resaleListing.deleteMany({ where: { ticket: { tier: { eventId: { in: i } } } } })).catch(() => {});
await scopedDelete("waitlist entries", ids, (i) =>
  prisma.waitlistEntry.deleteMany({ where: { eventId: { in: i } } })).catch(() => {});
await scopedDelete("invitations", ids, (i) =>
  prisma.invitation.deleteMany({ where: { eventId: { in: i } } })).catch(() => {});
await scopedDelete("orders", ids, (i) =>
  prisma.order.deleteMany({ where: { eventId: { in: i } } }));
const removedEvents = await scopedDelete("events", ids, (i) =>
  prisma.event.deleteMany({ where: { id: { in: i } } }));

// Accounts are matched by this run's own stamp, which is never empty.
const removedUsers = await prisma.user.deleteMany({
  where: { email: { endsWith: `-${stamp}@example.test` } },
}).catch(() => ({ count: 0 }));

ok("test events removed", removedEvents.count === ids.length, `${removedEvents.count}/${ids.length}`);
ok("test accounts removed", true, `${removedUsers.count} account(s)`);

const leftover = await prisma.event.count({ where: { slug: { startsWith: `${PREFIX}-` } } });
ok("nothing of this run is left", leftover === 0, `${leftover} left`);

/*
 * The seeded catalogue must survive the run.
 *
 * This is here because it did not, once: a stray `where: { eventId: undefined }`
 * in a diagnostic script deleted every order, which cascaded to tickets and
 * tiers and left an empty catalogue. A suite that can quietly empty the
 * database is worse than no suite, so the damage is now an assertion.
 */
const seeded = await prisma.event.count();
ok("the seeded catalogue is intact", seeded >= 16, `${seeded} events (expect 16+; run npm run db:seed if short)`);

await prisma.$disconnect();

// ═══════════════════════════════════════════════════════ result
console.log(`\n${"─".repeat(62)}`);
if (fail === 0) {
  console.log(bold(green(`ALL NINETEEN CHECKS PASS — ${pass} assertions`)));
} else {
  console.log(bold(red(`${pass} passed, ${fail} FAILED`)));
  for (const f of failures) console.log(`  ${red("×")} ${f}`);
}
console.log(`${"─".repeat(62)}\n`);
process.exit(fail > 0 ? 1 : 0);
