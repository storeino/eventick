/**
 * Live test — the audit trail, and removing an account.
 *
 * Fourteen privileged routes could change a role, grant a permission, refund
 * money, assign a commission plan or send a payout, and none of them left any
 * record. "It just changed" is not an answer anyone can act on.
 *
 * The properties under test:
 *
 *   - Privileged actions are recorded, with who did them.
 *   - A record OUTLIVES the account it describes — the whole reason to log a
 *     deletion is to know who performed it.
 *   - Removal has two honest outcomes: delete when nothing depends on the
 *     account, anonymise when money history does. Orders survive either way.
 *   - An admin can remove neither themselves nor another admin, so one
 *     compromised admin account cannot clear out the rest.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-audit-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100";
const ACCOUNTS = {
  admin: { email: "admin@eventick.ma", password: "admin123" },
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
};

let failures = 0;
let checks = 0;
function check(label, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function login({ email, password }) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`login ${email}: ${JSON.stringify(data).slice(0, 150)}`);
  return data.token;
}

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
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 160);
  }
  return { status: res.status, data };
}

const SUFFIX = Date.now();
const madeUsers = [];

/** Rows this run created, so cleanup never touches real history. */
async function teardown() {
  for (const id of madeUsers) {
    await prisma.auditEvent.deleteMany({ where: { subjectId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.auditEvent.deleteMany({ where: { subjectLabel: { contains: `audit-${SUFFIX}` } } });
}

async function main() {
  const admin = await login(ACCOUNTS.admin);
  const orga = await login(ACCOUNTS.organiser);
  const adminId = (await call("GET", "/api/auth/me", { token: admin })).data.user.id;
  const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;

  // ═══ 1. Actions are recorded ══════════════════════════════════════════
  section("1. Privileged actions are recorded");
  let subjectId;
  {
    const created = await call("POST", "/api/auth/users", {
      token: admin,
      body: { name: "Audit Subject", email: `audit-${SUFFIX}@eventick.ma`, password: "audit-probe-pass", role: "CUSTOMER" },
    });
    check("a user can be created", created.status === 201, `${created.status}`);
    subjectId = created.data.user.id;
    madeUsers.push(subjectId);

    await call("PATCH", `/api/auth/users/${subjectId}/role`, { token: admin, body: { role: "ORGANISER" } });
    await call("PATCH", `/api/platform/organisers/${orgaId}/plan`, { token: admin, body: { planKey: "pro" } });
    await call("POST", "/api/auth/roles/CUSTOMER/permissions", { token: admin, body: { permission: "gate.checkin" } });
    await call("DELETE", "/api/auth/roles/CUSTOMER/permissions/gate.checkin", { token: admin });

    const journal = await call("GET", "/api/platform/audit?limit=50", { token: admin });
    check("the journal reads", journal.status === 200 && Array.isArray(journal.data.events), `${journal.status}`);

    const actions = journal.data.events.map((e) => e.action);
    for (const expected of [
      "user.created",
      "user.role.changed",
      "organiser.plan.assigned",
      "role.permission.granted",
      "role.permission.revoked",
    ]) {
      check(`${expected} is recorded`, actions.includes(expected), "");
    }

    const roleRow = journal.data.events.find((e) => e.action === "user.role.changed" && e.subject.id === subjectId);
    check("it records who did it", roleRow?.actor?.email === ACCOUNTS.admin.email, roleRow?.actor?.email);
    // Both ends: "changed to ORGANISER" alone does not say what it replaced.
    check(
      "it records what changed, both ends",
      roleRow?.details?.from === "CUSTOMER" && roleRow?.details?.to === "ORGANISER",
      JSON.stringify(roleRow?.details),
    );
    check("the action vocabulary is published", Array.isArray(journal.data.actions) && journal.data.actions.length > 5, `${journal.data.actions?.length}`);
  }

  // ═══ 2. Who may read it ═══════════════════════════════════════════════
  section("2. Reading the journal");
  {
    const asOrga = await call("GET", "/api/platform/audit", { token: orga });
    // The rows describe money and accounts across every organiser.
    check("an organiser cannot read the journal", asOrga.status === 403, `${asOrga.status}`);

    const anon = await call("GET", "/api/platform/audit");
    check("an anonymous caller cannot read it", anon.status === 401, `${anon.status}`);

    const filtered = await call("GET", "/api/platform/audit?action=user.created&limit=5", { token: admin });
    check(
      "it filters by action",
      filtered.status === 200 && filtered.data.events.every((e) => e.action === "user.created"),
      `${filtered.data.events?.length} row(s)`,
    );

    const bySubject = await call("GET", `/api/platform/audit?subjectId=${subjectId}`, { token: admin });
    check("it filters by subject", bySubject.data.events.every((e) => e.subject.id === subjectId), `${bySubject.data.events?.length} row(s)`);

    const bad = await call("GET", "/api/platform/audit?before=not-a-date", { token: admin });
    check("an unparseable date is refused", bad.status === 400, `${bad.status}`);
  }

  // ═══ 3. Removal guards ════════════════════════════════════════════════
  section("3. Who may be removed");
  {
    const self = await call("DELETE", `/api/auth/users/${adminId}`, { token: admin });
    // As long as an admin cannot remove themselves, the platform can never
    // reach zero admins — the same reasoning as the role route.
    check("an admin cannot remove themselves", self.status === 422, `${self.status}`);

    // A SECOND admin, because the first version of this check hit the same
    // account and got 422 — so the 403 below was never actually exercised.
    const madeAdmin = await call("POST", "/api/auth/users", {
      token: admin,
      body: { name: "Second Admin", email: `audit-${SUFFIX}-admin2@eventick.ma`, password: "second-admin-pass", role: "CUSTOMER" },
    });
    // Promoted by writing the row: ADMIN is deliberately not creatable through
    // the API (ADMIN_CREATABLE_ROLES), which is itself the neighbouring guard.
    const other = await prisma.user.update({ where: { id: madeAdmin.data.user.id }, data: { role: "ADMIN" } });
    madeUsers.push(other.id);
    const otherAdmin = await call("DELETE", `/api/auth/users/${other.id}`, { token: admin });
    check("an admin cannot remove ANOTHER admin", otherAdmin.status === 403, `${otherAdmin.status} ${otherAdmin.data.error ?? ""}`);
    const survived = await prisma.user.findUnique({ where: { id: other.id } });
    check("the other admin survives the attempt", survived !== null);

    const asOrga = await call("DELETE", `/api/auth/users/${subjectId}`, { token: orga });
    check("an organiser cannot remove anyone", asOrga.status === 403, `${asOrga.status}`);

    const missing = await call("DELETE", "/api/auth/users/does-not-exist", { token: admin });
    check("an unknown id is a 404", missing.status === 404, `${missing.status}`);
  }

  // ═══ 4. Hard delete ═══════════════════════════════════════════════════
  section("4. An account nothing depends on is deleted");
  {
    const plan = await call("GET", `/api/auth/users/${subjectId}/removal`, { token: admin });
    check("the plan says 'deleted'", plan.data.mode === "deleted", `${plan.data.mode}`);
    check("and explains why", typeof plan.data.reason === "string" && plan.data.reason.length > 20, "");

    const del = await call("DELETE", `/api/auth/users/${subjectId}`, { token: admin });
    check("the account is removed", del.status === 200 && del.data.mode === "deleted", `${del.status} ${del.data.mode}`);
    const gone = await prisma.user.findUnique({ where: { id: subjectId } });
    check("the row is gone", gone === null);

    /*
     * THE property the whole audit design turns on: actorId is nullable and
     * SET NULL, and the actor's email is copied at write time, so the record
     * survives the account. A cascade here would erase exactly the thing
     * worth keeping.
     */
    const trail = await prisma.auditEvent.findMany({ where: { subjectId }, select: { action: true, subjectLabel: true } });
    check("the journal still describes the deleted account", trail.length >= 3, `${trail.length} row(s)`);
    check("including the deletion itself", trail.some((t) => t.action === "user.deleted"), trail.map((t) => t.action).join(", "));
    check(
      "and still names who it was",
      trail.every((t) => t.subjectLabel?.includes(`audit-${SUFFIX}`)),
      trail[0]?.subjectLabel,
    );
  }

  // ═══ 5. Anonymise ═════════════════════════════════════════════════════
  section("5. An account with money history is anonymised");
  {
    // Build a customer with a real settled order, rather than demoting a
    // demo account the other suites depend on.
    const buyer = await call("POST", "/api/auth/users", {
      token: admin,
      body: { name: "Audit Buyer", email: `audit-${SUFFIX}-buyer@eventick.ma`, password: "audit-buyer-pass", role: "CUSTOMER" },
    });
    const buyerId = buyer.data.user.id;
    madeUsers.push(buyerId);
    const buyerToken = await login({ email: `audit-${SUFFIX}-buyer@eventick.ma`, password: "audit-buyer-pass" });

    const event = await prisma.event.findFirst({
      where: { status: "PUBLISHED", tiers: { some: {} } },
      include: { tiers: { take: 1 } },
    });
    const held = await call("POST", "/api/orders/hold", {
      token: buyerToken,
      body: { eventSlug: event.slug, lines: [{ tierId: event.tiers[0].id, qty: 1 }] },
    });
    await call("POST", `/api/orders/${held.data.order.id}/pay`, {
      token: buyerToken,
      body: { holderName: "Audit Buyer", email: `audit-${SUFFIX}-buyer@eventick.ma`, phone: "0612345678" },
    });
    const orderId = held.data.order.id;

    const plan = await call("GET", `/api/auth/users/${buyerId}/removal`, { token: admin });
    // Erasing the row would break the ticket and rewrite the organiser's
    // revenue, so the honest outcome is anonymisation.
    check("the plan says 'anonymised'", plan.data.mode === "anonymised", `${plan.data.mode}`);
    check("and says how many orders stand in the way", plan.data.blockers?.orders >= 1, JSON.stringify(plan.data.blockers));

    const removed = await call("DELETE", `/api/auth/users/${buyerId}`, { token: admin });
    check("the account is anonymised", removed.status === 200 && removed.data.mode === "anonymised", `${removed.data.mode}`);

    const after = await prisma.user.findUnique({ where: { id: buyerId }, select: { name: true, email: true, role: true, planId: true } });
    check("the personal details are gone", !after.email.includes(`audit-${SUFFIX}`), after.email);
    check("the email is a non-address, not blank", after.email.endsWith("@invalid.eventick"), after.email);
    // Two anonymised accounts would collide on an empty string.
    check("it stays unique", after.email.includes("deleted-"), after.email);
    check("the role is demoted", after.role === "CUSTOMER", after.role);

    const stillThere = await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true, totalCents: true } });
    check("the order survives", stillThere !== null && stillThere.customerId === buyerId, `${stillThere?.totalCents}`);
    const tickets = await prisma.ticket.count({ where: { orderId } });
    check("the tickets survive", tickets === 1, `${tickets}`);

    const oldLogin = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `audit-${SUFFIX}-buyer@eventick.ma`, password: "audit-buyer-pass" }),
    });
    check("the old credentials no longer work", oldLogin.status !== 200, `${oldLogin.status}`);

    const anonRow = await prisma.auditEvent.findFirst({ where: { subjectId: buyerId, action: "user.anonymised" } });
    // "removed" would not distinguish the two outcomes.
    check("the journal records 'anonymised', not 'deleted'", anonRow !== null, anonRow?.action);

    // Clean this order up so no suite inherits it.
    await prisma.ticket.deleteMany({ where: { orderId } });
    await prisma.orderLine.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } });
  }

  // ═══ 6. The record outlives the ACTOR, not just the subject ═══════════
  section("6. A deleted admin's trail survives them");
  {
    /*
     * Sections 4 and 5 delete the SUBJECT of a record. This deletes the
     * ACTOR, which is a different foreign key and the one the design really
     * rests on: actorId is SET NULL and the email is copied at write time, so
     * "who deleted this account" survives the deleter being removed.
     *
     * Added because a mutation flipping actorId to Cascade passed all 39
     * earlier checks — nothing exercised it.
     */
    const helper = await call("POST", "/api/auth/users", {
      token: admin,
      body: { name: "Audit Actor", email: `audit-${SUFFIX}-actor@eventick.ma`, password: "audit-actor-pass", role: "CUSTOMER" },
    });
    const actorId = helper.data.user.id;
    madeUsers.push(actorId);

    // Give them users.manage by promoting the row, then act as them.
    await prisma.user.update({ where: { id: actorId }, data: { role: "ADMIN" } });
    const actorToken = await login({ email: `audit-${SUFFIX}-actor@eventick.ma`, password: "audit-actor-pass" });

    const victim = await call("POST", "/api/auth/users", {
      token: actorToken,
      body: { name: "Audit Victim", email: `audit-${SUFFIX}-victim@eventick.ma`, password: "audit-victim-pass", role: "CUSTOMER" },
    });
    check("the second admin can act", victim.status === 201, `${victim.status}`);
    madeUsers.push(victim.data.user.id);

    const theirRows = await prisma.auditEvent.count({ where: { actorId } });
    check("their actions are recorded against them", theirRows >= 1, `${theirRows} row(s)`);

    // Now remove the actor. Demote first, because an admin cannot be removed.
    await prisma.user.update({ where: { id: actorId }, data: { role: "CUSTOMER" } });
    const removed = await call("DELETE", `/api/auth/users/${actorId}`, { token: admin });
    check("the acting admin is removed", removed.status === 200, `${removed.status} ${removed.data.error ?? ""}`);

    const survived = await prisma.auditEvent.findMany({
      where: { actorEmail: `audit-${SUFFIX}-actor@eventick.ma` },
      select: { action: true, actorId: true, actorEmail: true, actorRole: true },
    });
    // THE check the mutation slipped past.
    check("their trail SURVIVES their deletion", survived.length >= 1, `${survived.length} row(s) — a cascade would leave 0`);
    check("the actor id is detached, not the row", survived.every((r) => r.actorId === null), `${survived[0]?.actorId}`);
    check("but the email and role are still readable", survived.every((r) => r.actorEmail.includes(`audit-${SUFFIX}`) && r.actorRole), survived[0]?.actorEmail);

    const journal = await call("GET", `/api/platform/audit?limit=100`, { token: admin });
    const row = journal.data.events.find((e) => e.actor.email === `audit-${SUFFIX}-actor@eventick.ma`);
    check("the journal flags the actor as deleted", row?.actor?.deleted === true, JSON.stringify(row?.actor));
  }

  // ═══ Cleanup ══════════════════════════════════════════════════════════
  section("Cleanup");
  await prisma.auditEvent.deleteMany({ where: { actorEmail: { contains: `audit-${SUFFIX}` } } });
  await prisma.user.update({ where: { id: orgaId }, data: { planId: null } });
  await teardown();
  const left = await prisma.user.count({ where: { email: { contains: `audit-${SUFFIX}` } } });
  check("test accounts removed", left === 0, `${left} left`);

  console.log(
    failures === 0 ? `\n\x1b[32mAll ${checks} audit & removal checks passed\x1b[0m` : `\n\x1b[31m${failures} of ${checks} FAILED\x1b[0m`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await teardown().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
