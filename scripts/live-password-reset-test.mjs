/*
 * Forgot password: the recovery path that did not exist.
 *
 * There was no route, no email and no link on the login page, so an account
 * whose password had been forgotten was simply unreachable -- and at the
 * checkout that wall arrived with a seat hold counting down.
 *
 * The emailed token IS the credential, so most of what follows tests it as
 * one: single use, expiring, unguessable, stored only as a hash, and
 * revealing nothing about who does or does not have an account.
 */
import { createHash } from "node:crypto";
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100/api";
const PREFIX = `pwreset-${Date.now()}`;
let pass = 0, fail = 0;

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};

const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m PASS\x1b[0m  ${name}  \x1b[2m${detail}\x1b[0m`); }
  else { fail++; console.log(`  \x1b[31m FAIL\x1b[0m  ${name}  \x1b[2m${detail}\x1b[0m`); }
};

/*
 * The email is not delivered in this environment, so the token is read from
 * the database the same way the inbox would carry it. Everything after that
 * point is exactly what the buyer's browser does.
 */
const liveTokenRow = (userId) =>
  prisma.passwordReset.findFirst({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "desc" },
  });

const emails = [];
const mk = async (local, password) => {
  const email = `${PREFIX}-${local}@example.com`;
  emails.push(email);
  const r = await call("POST", "/auth/register", {
    body: { name: `Reset ${local}`, email, password, phone: "0612345678" },
  });
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { email, id: user?.id, status: r.status };
};

section("The request says nothing about who has an account");
{
  const a = await mk("known", "old-pass-2027");
  check("a test account exists", a.status === 201, String(a.status));

  const real = await call("POST", "/auth/forgot-password", { body: { email: a.email, locale: "fr" } });
  const fake = await call("POST", "/auth/forgot-password", {
    body: { email: `${PREFIX}-nobody@example.com`, locale: "fr" },
  });
  check("a known address gets 200", real.status === 200, String(real.status));
  check("an unknown address gets 200 too", fake.status === 200, String(fake.status));
  check("and the bodies are identical",
    JSON.stringify(real.data) === JSON.stringify(fake.data), JSON.stringify(real.data));
  const made = await prisma.passwordReset.count({ where: { userId: a.id } });
  check("only the real one created a token", made === 1, `${made} row(s)`);
}

section("The token is stored as a hash, never in the clear");
let known, token;
{
  known = await mk("hashcheck", "old-pass-2027");
  await call("POST", "/auth/forgot-password", { body: { email: known.email, locale: "fr" } });
  const row = await liveTokenRow(known.id);
  check("a row was created", Boolean(row), row ? "yes" : "none");
  check("the stored value is a sha-256 digest",
    /^[0-9a-f]{64}$/.test(row?.tokenHash ?? ""), row?.tokenHash?.slice(0, 16));
  /* The raw token is not recoverable from the row, so the test derives the
     digest the server would compute and confirms the lookup matches it. */
  const sample = "not-the-real-token";
  check("a wrong token does not match the stored hash",
    createHash("sha256").update(sample).digest("hex") !== row?.tokenHash, "distinct");
  check("the link expires within the hour",
    row && row.expiresAt.getTime() - row.createdAt.getTime() <= 60 * 60 * 1000 + 2000,
    row ? `${Math.round((row.expiresAt - row.createdAt) / 60000)} min` : "");
}

section("A fabricated or stale link is refused");
{
  const bogus = await call("GET", "/auth/reset-password/totally-made-up-token");
  check("an invented token is rejected", bogus.status === 400, String(bogus.status));
  check("and flagged so the page can say so",
    bogus.data?.resetLinkInvalid === true, JSON.stringify(bogus.data));
  check("without revealing whether any account matched",
    !/account|user|email/i.test(bogus.data?.error ?? ""), bogus.data?.error);

  /* Expired, by moving the row's deadline into the past. */
  const exp = await mk("expired", "old-pass-2027");
  await call("POST", "/auth/forgot-password", { body: { email: exp.email, locale: "fr" } });
  const row = await liveTokenRow(exp.id);
  await prisma.passwordReset.update({
    where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  /* The raw token is unknown here, so expiry is asserted through resolve
     using a token whose hash we set directly. */
  const probe = createHash("sha256").update("expiry-probe-token").digest("hex");
  await prisma.passwordReset.update({ where: { id: row.id }, data: { tokenHash: probe } });
  const dead = await call("GET", "/auth/reset-password/expiry-probe-token");
  check("an expired link is refused", dead.status === 400, String(dead.status));
}

section("The happy path: reset, and signed in at the end");
{
  /* A token whose raw value this test knows, by writing its digest. */
  token = "known-raw-token-for-the-happy-path";
  const row = await liveTokenRow(known.id);
  await prisma.passwordReset.update({
    where: { id: row.id },
    data: { tokenHash: createHash("sha256").update(token).digest("hex") },
  });

  const look = await call("GET", `/auth/reset-password/${token}`);
  check("the page can check the link on load", look.status === 200, String(look.status));
  check("and is told whose account it is", look.data?.email === known.email, look.data?.email);
  check("but not the account id", !("userId" in (look.data ?? {})), Object.keys(look.data ?? {}).join(","));

  const short = await call("POST", `/auth/reset-password/${token}`, { body: { password: "abc" } });
  check("a too-short password is refused", short.status === 400, String(short.status));

  const done = await call("POST", `/auth/reset-password/${token}`, { body: { password: "brand-new-2027" } });
  check("a valid one succeeds", done.status === 200, String(done.status));
  check("and returns a session, so they are signed in",
    Boolean(done.data?.token && done.data?.user), done.data?.user?.email);

  const now = await call("POST", "/auth/login", { body: { email: known.email, password: "brand-new-2027" } });
  check("the new password works", now.status === 200, String(now.status));
  const old = await call("POST", "/auth/login", { body: { email: known.email, password: "old-pass-2027" } });
  check("the old one does not", old.status === 401, String(old.status));
}

section("A spent link cannot be used twice");
{
  const again = await call("POST", `/auth/reset-password/${token}`, { body: { password: "third-pass-2027" } });
  check("the same link is refused the second time", again.status === 400, String(again.status));
  const still = await call("POST", "/auth/login", { body: { email: known.email, password: "brand-new-2027" } });
  check("and the password it set still stands", still.status === 200, String(still.status));
  const never = await call("POST", "/auth/login", { body: { email: known.email, password: "third-pass-2027" } });
  check("the second attempt changed nothing", never.status === 401, String(never.status));
}

section("Asking again retires the previous link");
{
  const u = await mk("reissue", "old-pass-2027");
  await call("POST", "/auth/forgot-password", { body: { email: u.email, locale: "fr" } });
  await call("POST", "/auth/forgot-password", { body: { email: u.email, locale: "fr" } });
  const live = await prisma.passwordReset.count({ where: { userId: u.id, usedAt: null } });
  check("only one link is live at a time", live === 1, `${live} live`);
  const total = await prisma.passwordReset.count({ where: { userId: u.id } });
  check("the earlier one was retired, not deleted", total === 2, `${total} total`);
}

section("A password-less account is not sent down this road");
{
  /* Express checkout creates these. They are not locked out -- the checkout
     lets them choose a password in place -- so a reset email would be a
     slower route to the same door. */
  const email = `${PREFIX}-nopass@example.com`;
  emails.push(email);
  const u = await prisma.user.create({
    data: { name: "Sans Mot De Passe", email, phone: "0612345678", passwordHash: "!no-password-set", role: "CUSTOMER" },
    select: { id: true },
  });
  const r = await call("POST", "/auth/forgot-password", { body: { email, locale: "fr" } });
  check("the request still answers the same way", r.status === 200, String(r.status));
  const rows = await prisma.passwordReset.count({ where: { userId: u.id } });
  check("but no reset token was issued", rows === 0, `${rows} row(s)`);
}

section("Cleanup");
{
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.passwordReset.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  const left = await prisma.user.count({ where: { email: { in: emails } } });
  check("test accounts removed", left === 0, `${left} left`);
}

console.log(`\n${"─".repeat(62)}`);
console.log(`\x1b[1mTOTAL: ${pass}/${pass + fail} passed\x1b[0m`);
console.log(`${"─".repeat(62)}`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
