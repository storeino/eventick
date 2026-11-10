/**
 * Authorization matrix — the safety net for the RBAC migration.
 *
 * Pins down WHO MAY REACH WHAT, so that rewiring routes from requireRole()
 * to requirePermission() cannot silently change who gets in. Written to pass
 * against the pre-migration code and to keep passing after, which is the
 * whole point: if a rewiring mistake widens or narrows access, a test here
 * fails instead of the bug shipping.
 *
 * Three things it checks that the main live-api-test does not:
 *   1. Cross-organiser isolation on every route that touches one organiser's
 *      rows — the failure mode where organiser A reaches organiser B's data.
 *   2. The permission list on /auth/me, so the frontend's can() seam has a
 *      contract rather than silently reading undefined.
 *   3. That permissions are read per-request from the database, not baked
 *      into the 30-day JWT — proved by revoking a grant and watching access
 *      disappear without a re-login.
 *
 * Creates its own second organiser and tears everything down at the end.
 */

const API = process.env.API ?? "http://localhost:4100";

const ACCOUNTS = {
  admin: { email: "admin@eventick.ma", password: "admin123" },
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  customer: { email: "client@eventick.ma", password: "client123" },
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 120);
  }
  return { status: res.status, data };
}

async function expectStatus(label, method, path, expected, opts = {}) {
  const r = await call(method, path, opts);
  const list = Array.isArray(expected) ? expected : [expected];
  const pass = list.includes(r.status);
  record(label, pass, `${r.status}${pass ? "" : ` (want ${list.join("/")})`}`);
  return r;
}

const tokens = {};
for (const [role, creds] of Object.entries(ACCOUNTS)) {
  const r = await call("POST", "/api/auth/login", { body: creds });
  tokens[role] = r.data?.token;
  if (!tokens[role]) {
    console.error(`\nCannot log in as ${role} (${r.status}). Is the backend seeded and running?`);
    process.exit(1);
  }
}

const SUFFIX = Date.now();
const cleanup = { users: [], events: [] };

// ──────────────────────────────────────────── the role → route matrix ──
setGroup("MATRIX  who may reach each staff route");

/**
 * Every staff route, and the expected answer for each caller. This is the
 * table a reviewer should read to know the authorization model — if a route
 * is missing here, it has no isolation coverage.
 *
 * 404 is accepted alongside 200 where the route needs a resource that may
 * not exist in a given run; it still proves the caller got PAST the gate,
 * which is what is being tested.
 */
const MATRIX = [
  // [label, method, path, anonymous, customer, organiser, admin]
  ["GET /organiser/events", "GET", "/api/organiser/events", 401, 403, 200, 200],
  ["GET /organiser/orders", "GET", "/api/organiser/orders", 401, 403, 200, 200],
  ["GET /organiser/orders/detailed", "GET", "/api/organiser/orders/detailed", 401, 403, 200, 200],
  ["GET /organiser/stats", "GET", "/api/organiser/stats", 401, 403, 200, 200],
  ["GET /promo", "GET", "/api/promo", 401, 403, 200, 200],
  ["GET /auth/users  (admin only)", "GET", "/api/auth/users", 401, 403, 403, 200],
];

for (const [label, method, path, anon, cust, org, adm] of MATRIX) {
  await expectStatus(`${label} — anonymous`, method, path, anon);
  await expectStatus(`${label} — CUSTOMER`, method, path, cust, { token: tokens.customer });
  await expectStatus(`${label} — ORGANISER`, method, path, org, { token: tokens.organiser });
  await expectStatus(`${label} — ADMIN`, method, path, adm, { token: tokens.admin });
}

// ────────────────────────────────────── cross-organiser isolation ──
setGroup("ISOLATION  one organiser must not reach another's rows");

// A second organiser, created through the admin API, so "another organiser's
// data" is real rather than simulated.
const otherEmail = `authz-other-${SUFFIX}@example.com`;
const reg = await call("POST", "/api/auth/register", {
  body: { name: "Authz Other Organiser", email: otherEmail, password: "authz-test-pass-2026", phone: "0612345678" },
});
const otherId = reg.data?.user?.id;
const otherToken = reg.data?.token;
record("second organiser account created", Boolean(otherId), reg.status === 201 ? "201" : `${reg.status}`);
if (otherId) {
  cleanup.users.push(otherId);
  const promo = await call("PATCH", `/api/auth/users/${otherId}/role`, {
    token: tokens.admin,
    body: { role: "ORGANISER" },
  });
  record("promoted to ORGANISER by admin", promo.status === 200, `${promo.status}`);
}

// The seeded organiser owns oasis-2026 and dakhla-lagoon (see prisma/seed.ts).
const VICTIM_SLUG = "oasis-2026";

if (otherToken) {
  await expectStatus(
    "other organiser reading victim's waitlist → 403",
    "GET",
    `/api/organiser/events/${VICTIM_SLUG}/waitlist`,
    403,
    { token: otherToken },
  );
  await expectStatus(
    "other organiser editing victim's event → 403",
    "PATCH",
    `/api/organiser/events/${VICTIM_SLUG}`,
    403,
    { token: otherToken, body: { city: "Hacked" } },
  );
  await expectStatus(
    "other organiser hiding victim's event → 403",
    "PATCH",
    `/api/organiser/events/${VICTIM_SLUG}/visibility`,
    403,
    { token: otherToken, body: { hidden: true } },
  );
  await expectStatus(
    "other organiser deleting victim's event → 403",
    "DELETE",
    `/api/organiser/events/${VICTIM_SLUG}`,
    403,
    { token: otherToken },
  );
  await expectStatus(
    "other organiser reading victim's audience → 403",
    "GET",
    `/api/organiser/events/${VICTIM_SLUG}/audience`,
    403,
    { token: otherToken },
  );
  await expectStatus(
    "other organiser reading victim's tiers → 403",
    "GET",
    `/api/organiser/events/${VICTIM_SLUG}/tiers`,
    403,
    { token: otherToken },
  );
  await expectStatus(
    "other organiser downloading victim's gate manifest → 403",
    "GET",
    `/api/gate/events/${VICTIM_SLUG}/manifest`,
    403,
    { token: otherToken },
  );
  await expectStatus(
    "other organiser broadcasting to victim's buyers → 403",
    "POST",
    `/api/organiser/events/${VICTIM_SLUG}/broadcast`,
    403,
    { token: otherToken, body: { subject: "authz probe", message: "authz probe message body" } },
  );

  // A fresh organiser must see ONLY their own (zero) events, never the
  // platform's. This is the list-scoping counterpart to the 403s above.
  const theirEvents = await call("GET", "/api/organiser/events", { token: otherToken });
  record(
    "fresh organiser's event list is empty, not the platform's",
    theirEvents.status === 200 && Array.isArray(theirEvents.data?.events) && theirEvents.data.events.length === 0,
    `${theirEvents.status} count=${theirEvents.data?.events?.length ?? "?"}`,
  );

  // ...and must not be able to widen it by passing someone else's id.
  const widened = await call(`GET`, `/api/organiser/events?organiserId=${otherId}`, { token: otherToken });
  const widenedAll = await call(`GET`, `/api/organiser/events?organiserId=`, { token: otherToken });
  record(
    "?organiserId= cannot widen a plain organiser's scope",
    widened.data?.events?.length === 0 && widenedAll.data?.events?.length === 0,
    `${widened.data?.events?.length ?? "?"} / ${widenedAll.data?.events?.length ?? "?"}`,
  );
}

// ────────────────────────────────────────── admin cross-scope ──
setGroup("ADMIN SCOPE  admin may act outside their own rows");

/*
 * An event owned by SOMEONE ELSE is what makes the admin's wider scope
 * observable, so one is created rather than assumed.
 *
 * This used to compare the two counts straight off the seeded catalogue,
 * which worked only because fourteen of the sixteen events were owned by the
 * admin — the very bug that event ownership was later fixed to prevent (an
 * admin cannot own an event at all now). With every seeded event belonging to
 * the demo organiser, both sides returned 16 and the check proved nothing.
 */
const scopeOwner = await call("POST", "/api/auth/register", {
  body: { name: "Scope Organiser", email: `authz-scope-${Date.now()}@example.test`, password: "authz-scope-2027", phone: "0612345678" },
});
const scopeOwnerId = scopeOwner.data?.user?.id;
// Removed in CLEANUP below: leaked ORGANISER accounts accumulate in the
// admin directory and in every organiser picker that reads it.
if (scopeOwnerId) cleanup.users.push(scopeOwnerId);
await call("PATCH", `/api/auth/users/${scopeOwnerId}/role`, { token: tokens.admin, body: { role: "ORGANISER" } });

const scopeSlug = `authz-scope-${Date.now()}`;
const scopeEvent = await call("POST", "/api/organiser/events", {
  token: tokens.admin,
  body: {
    slug: scopeSlug,
    organiserId: scopeOwnerId,
    titleFr: "Événement hors périmètre", titleAr: "حدث خارج النطاق",
    category: "festivals", city: "Oujda",
    venueFr: "Salle", venueAr: "قاعة", address: "Oujda",
    start: "2027-11-05T21:00:00", end: "2027-11-05T23:59:00", doors: "2027-11-05T20:00:00",
    image: "/events/jazz.jpg",
    blurbFr: "Hors périmètre", blurbAr: "خارج النطاق",
    aboutFr: "Hors périmètre", aboutAr: "خارج النطاق",
    ageFr: "Tous publics", ageAr: "للجميع",
    tiers: [{ nameFr: "S", nameAr: "ع", blurbFr: "t", blurbAr: "t", priceCents: 9000, capacity: 5, zoneFr: "A", zoneAr: "A", gateFr: "1", gateAr: "1" }],
  },
});
record("admin creates an event owned by a third organiser", scopeEvent.status === 201, `${scopeEvent.status}`);

const adminEvents = await call("GET", "/api/organiser/events", { token: tokens.admin });
const organiserEvents = await call("GET", "/api/organiser/events", { token: tokens.organiser });
record(
  "admin sees more events than one organiser",
  (adminEvents.data?.events?.length ?? 0) > (organiserEvents.data?.events?.length ?? 0),
  `admin=${adminEvents.data?.events?.length ?? "?"} organiser=${organiserEvents.data?.events?.length ?? "?"}`,
);
record(
  "and the organiser cannot see that event at all",
  !(organiserEvents.data?.events ?? []).some((event) => event.slug === scopeSlug),
  scopeSlug,
);

// Deleted as admin: scope.any is what reaches another organiser's event.
await call("DELETE", `/api/organiser/events/${scopeSlug}`, { token: tokens.admin });

const me = await call("GET", "/api/auth/me", { token: tokens.organiser });
const organiserId = me.data?.user?.id;
if (organiserId) {
  const narrowed = await call("GET", `/api/organiser/events?organiserId=${organiserId}`, { token: tokens.admin });
  record(
    "admin narrowed to one organiser matches that organiser's own view",
    narrowed.data?.events?.length === organiserEvents.data?.events?.length,
    `${narrowed.data?.events?.length ?? "?"} vs ${organiserEvents.data?.events?.length ?? "?"}`,
  );
}

await expectStatus("admin may read another organiser's waitlist", "GET", `/api/organiser/events/${VICTIM_SLUG}/waitlist`, 200, {
  token: tokens.admin,
});

// ──────────────────────────────────── permissions on /auth/me ──
setGroup("PERMISSIONS  the contract the frontend's can() reads");

const EXPECTED = {
  customer: [],
  organiser: [
    "events.manage",
    "finance.refund",
    "finance.view",
    "gate.checkin",
    "orders.manage",
    "promo.manage",
    "uploads.create",
  ],
  admin: [
    "events.manage",
    "finance.refund",
    "finance.view",
    "gate.checkin",
    "orders.manage",
    "promo.manage",
    "scope.any",
    "uploads.create",
    "users.manage",
  ],
};

for (const [role, expected] of Object.entries(EXPECTED)) {
  const r = await call("GET", "/api/auth/me", { token: tokens[role] });
  const got = r.data?.user?.permissions;
  const isArray = Array.isArray(got);
  record(`${role}: /auth/me ships a permissions array`, isArray, isArray ? `${got.length} entries` : `got ${typeof got}`);
  if (isArray) {
    const sorted = [...got].sort().join(",");
    record(`${role}: holds exactly the expected permissions`, sorted === expected.join(","), sorted || "(none)");
  }
}

// ───────────────────────────── permissions are live, not in the JWT ──
setGroup("LIVENESS  revoking a grant takes effect without re-login");

// Uses the SAME token throughout: if permissions were baked into the JWT,
// access would survive the revocation for the token's full 30-day life.
const before = await call("GET", "/api/promo", { token: tokens.organiser });
record("organiser can read promos before revocation", before.status === 200, `${before.status}`);

const revoke = await call("DELETE", "/api/auth/roles/ORGANISER/permissions/promo.manage", { token: tokens.admin });
const revokeWorked = revoke.status === 200 || revoke.status === 204;
record("admin revokes promo.manage from ORGANISER", revokeWorked, `${revoke.status}`);

if (revokeWorked) {
  // The permission cache has a short TTL; give it room so this asserts the
  // real behaviour rather than a race.
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  await expectStatus("same token is now refused → 403", "GET", "/api/promo", 403, { token: tokens.organiser });

  const restore = await call("POST", "/api/auth/roles/ORGANISER/permissions", {
    token: tokens.admin,
    body: { permission: "promo.manage" },
  });
  record("admin restores promo.manage", restore.status === 200 || restore.status === 201, `${restore.status}`);
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  await expectStatus("access returns after restore", "GET", "/api/promo", 200, { token: tokens.organiser });
}

// ──────────────────────────────────────────────── lockout guard ──
setGroup("LOCKOUT  the one grant that cannot be revoked");

await expectStatus(
  "admin cannot revoke users.manage from ADMIN",
  "DELETE",
  "/api/auth/roles/ADMIN/permissions/users.manage",
  422,
  { token: tokens.admin },
);

const stillThere = await call("GET", "/api/auth/me", { token: tokens.admin });
record(
  "ADMIN still holds users.manage afterwards",
  (stillThere.data?.user?.permissions ?? []).includes("users.manage"),
  (stillThere.data?.user?.permissions ?? []).includes("users.manage") ? "intact" : "LOST — lockout possible",
);

await expectStatus("admin cannot change their own role", "PATCH", `/api/auth/users/${stillThere.data?.user?.id}/role`, 422, {
  token: tokens.admin,
  body: { role: "CUSTOMER" },
});

// ───────────────────────────────────────────────────── cleanup ──
setGroup("CLEANUP");

for (const id of cleanup.users) {
  const r = await call("DELETE", `/api/auth/users/${id}`, { token: tokens.admin });
  record(`removed test user ${id.slice(0, 8)}…`, [200, 204, 404, 405].includes(r.status), `${r.status}`);
}

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
