/**
 * Organiser capability enforcement.
 *
 * The /organiser router was gated on `events.manage` alone, which meant four
 * permissions in the vocabulary were decorative: an admin could toggle
 * finance.view or finance.refund off in the Permissions screen and the
 * organiser would keep reading revenue and issuing refunds. Verified live
 * before this file existed — stats returned 40000 cents with finance.view
 * explicitly revoked.
 *
 * This pins down which capability each route actually requires. For every
 * permission it: revokes it from ORGANISER, asserts the routes that need it
 * now 403, asserts a route that does NOT need it still works (so a revoke
 * cannot quietly take down the whole dashboard), then restores it.
 *
 * Runs against ORGANISER's live grants and puts them back at the end — if it
 * fails midway, re-seed to restore the defaults.
 */

const API = process.env.API ?? "http://localhost:4100";

const ACCOUNTS = {
  admin: { email: "admin@eventick.ma", password: "eventick-admin-2026" },
  organiser: { email: "organisateur@eventick.ma", password: "eventick-orga-2026" },
  // The fixture order below has to be bought by someone, and buying needs an
  // account.
  customer: { email: "client@eventick.ma", password: "eventick-client-2026" },
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

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
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

const login = async (a) => {
  const r = await call("POST", "/api/auth/login", { body: a });
  if (r.status !== 200) throw new Error(`login ${a.email} -> ${r.status}`);
  return r.data.token;
};

const tokens = {
  admin: await login(ACCOUNTS.admin),
  organiser: await login(ACCOUNTS.organiser),
  customer: await login(ACCOUNTS.customer),
};

const grant = (p) =>
  call("POST", "/api/auth/roles/ORGANISER/permissions", { token: tokens.admin, body: { permission: p } });
const revoke = (p) => call("DELETE", `/api/auth/roles/ORGANISER/permissions/${p}`, { token: tokens.admin });

/** ORGANISER's grants as found, so the run can put them back exactly. */
const before = (await call("GET", "/api/auth/permissions", { token: tokens.admin })).data?.roles?.ORGANISER ?? [];

// ── A fixture to act on: one event, one paid order. ──────────────────────
const SUFFIX = Date.now();
const slug = `orgauthz-${SUFFIX}`;
const start = new Date(Date.now() + 30 * 86_400_000);

const made = await call("POST", "/api/organiser/events", {
  token: tokens.organiser,
  body: {
    slug,
    titleFr: "Test autorisation",
    titleAr: "اختبار",
    category: "concert",
    city: "Casablanca",
    venueFr: "Salle test",
    venueAr: "قاعة",
    address: "1 rue du test",
    start: start.toISOString(),
    end: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
    doors: new Date(start.getTime() - 3_600_000).toISOString(),
    image: "https://example.com/a.jpg",
    blurbFr: "Test",
    blurbAr: "تجربة",
    aboutFr: "Test",
    aboutAr: "تجربة",
    ageFr: "18+",
    ageAr: "+18",
    tiers: [
      {
        nameFr: "Standard",
        nameAr: "عادي",
        blurbFr: "x",
        blurbAr: "x",
        priceCents: 20000,
        capacity: 10,
        zoneFr: "A",
        zoneAr: "أ",
        gateFr: "1",
        gateAr: "1",
      },
    ],
  },
});
if (made.status !== 201) throw new Error(`fixture event failed: ${made.status} ${JSON.stringify(made.data)}`);
const tierId = made.data.event.tiers[0].id;

const hold = await call("POST", "/api/orders/hold", {
  token: tokens.customer,
  body: { eventSlug: slug, lines: [{ tierId, qty: 1 }] },
});
const orderKey = hold.data.accessToken;
const orderId = hold.data.order.id;
await call("POST", `/api/orders/${orderId}/pay?k=${encodeURIComponent(orderKey)}`, {
  token: tokens.customer,
  body: { holderName: "Acheteur Authz", email: `orgauthz-${SUFFIX}@example.com`, phone: "0612345678" },
});
const paidOrder = await call("GET", `/api/orders/${orderId}?k=${encodeURIComponent(orderKey)}`);
const ticketId = paidOrder.data?.order?.tickets?.[0]?.id;

/**
 * Revoke `permission`, check each [label, method, path, body] now 403s,
 * check `stillWorks` is untouched, then restore.
 */
async function assertGatedOn(permission, blocked, stillWorks) {
  setGroup(`${permission}  what stops working without it`);
  await revoke(permission);
  try {
    for (const [label, method, path, body] of blocked) {
      const r = await call(method, path, { token: tokens.organiser, body });
      record(`${label} → 403`, r.status === 403, `${r.status}`);
    }
    // A revoke must be surgical: taking one capability away cannot take the
    // whole dashboard with it, or an admin tuning permissions would be
    // locking organisers out by accident.
    for (const [label, method, path, body] of stillWorks) {
      const r = await call(method, path, { token: tokens.organiser, body });
      record(`${label} still works`, r.status < 400, `${r.status}`);
    }
  } finally {
    await grant(permission);
  }
}

await assertGatedOn(
  "finance.view",
  [["reading revenue stats", "GET", "/api/organiser/stats"]],
  [["listing events", "GET", "/api/organiser/events"]],
);

/*
 * finance.refund now guards reconcile-refund, not a discretionary refund:
 * tickets are final sale, and /organiser/orders/:id/refund is gone. The
 * permission still has to gate something, and this is what it gates. The
 * route answers 409 on a mock order (no gateway reference to reconcile) when
 * the permission IS held, which is < 400's inverse but still proves the gate
 * — assertGatedOn only requires 403 while it is revoked.
 */
await assertGatedOn(
  "finance.refund",
  [["reconciling a refund", "POST", `/api/organiser/orders/${orderId}/reconcile-refund`, { amountRefundedCents: 100 }]],
  [
    ["listing events", "GET", "/api/organiser/events"],
    ["reading revenue stats", "GET", "/api/organiser/stats"],
  ],
);

await assertGatedOn(
  "orders.manage",
  [
    ["listing orders", "GET", "/api/organiser/orders"],
    ["listing detailed orders", "GET", "/api/organiser/orders/detailed"],
    ["admitting a ticket", "PATCH", `/api/organiser/tickets/${ticketId}/status`, { status: "USED" }],
  ],
  [["listing events", "GET", "/api/organiser/events"]],
);

await assertGatedOn(
  "events.manage",
  [
    ["listing events", "GET", "/api/organiser/events"],
    ["editing an event", "PATCH", `/api/organiser/events/${slug}`, { city: "Rabat" }],
    ["adding a tier", "POST", `/api/organiser/events/${slug}/tiers`, {}],
  ],
  // orders.manage is a separate capability, so an organiser who may only
  // work the order desk keeps doing that when events.manage goes away.
  [["listing orders", "GET", "/api/organiser/orders"]],
);

// ── The grants must come back exactly as they were found. ────────────────
setGroup("RESTORE  ORGANISER's grants are left as found");
const after = (await call("GET", "/api/auth/permissions", { token: tokens.admin })).data?.roles?.ORGANISER ?? [];
record(
  "every permission restored",
  before.length === after.length && before.every((p) => after.includes(p)),
  `${after.length}/${before.length}`,
);

// ── Cleanup ──────────────────────────────────────────────────────────────
setGroup("CLEANUP");
const delOrder = await call("DELETE", `/api/organiser/orders/${orderId}`, { token: tokens.admin });
record("test order removed", [200, 204, 404].includes(delOrder.status), `${delOrder.status}`);
const delEvent = await call("DELETE", `/api/organiser/events/${slug}`, { token: tokens.admin });
record("test event removed", [200, 204, 404].includes(delEvent.status), `${delEvent.status}`);

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
