/**
 * Live test — the profile editor, for every role.
 *
 * It only ever edited the NAME, so a buyer who changed their number had
 * nowhere to say so and the stale one went to CMI with every purchase.
 * publicUser never sent the phone either, so the checkout could not tell
 * "no number on file" from "not loaded" and showed the field to everyone
 * forever.
 *
 * Run for all three roles because the editor lives on /billets, which hides
 * its RECEIPT card from staff -- the profile card sits outside that guard,
 * and this proves it, rather than leaving it to a reading of the JSX.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-profile-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
const ACCOUNTS = {
  customer: { email: "client@eventick.ma", password: "client123" },
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  admin: { email: "admin@eventick.ma", password: "admin123" },
};

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
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data };
}
const login = async (a) => (await call("POST", "/api/auth/login", { body: a })).data.token;

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const originals = {};

try {
  for (const [role, acct] of Object.entries(ACCOUNTS)) {
    section(`${role} — can read and edit their own profile`);
    const token = await login(acct);

    const me = await call("GET", "/api/auth/me", { token });
    check("GET /auth/me succeeds", me.status === 200, `${me.status}`);
    check(
      "the response carries the phone, so the checkout knows whether to ask",
      "phone" in (me.data?.user ?? {}),
      `phone=${JSON.stringify(me.data?.user?.phone)}`,
    );
    originals[role] = {
      name: me.data.user.name,
      phone: me.data.user.phone,
    };

    const newPhone = "0700112233";
    const patched = await call("PATCH", "/api/auth/me", {
      token,
      body: { name: me.data.user.name, phone: newPhone },
    });
    check("PATCH /auth/me accepts a phone", patched.status === 200, `${patched.status}`);
    check(
      "and returns the updated number",
      patched.data?.user?.phone === newPhone,
      `${patched.data?.user?.phone}`,
    );

    /* A name-only patch must NOT blank the phone — the bug a naive
       `data: { name, phone }` would introduce on every rename. */
    const renamed = await call("PATCH", "/api/auth/me", {
      token,
      body: { name: me.data.user.name },
    });
    check(
      "a name-only edit leaves the phone alone",
      renamed.data?.user?.phone === newPhone,
      `${renamed.data?.user?.phone}`,
    );

    const bad = await call("PATCH", "/api/auth/me", { token, body: { phone: "123" } });
    check("an invalid number is refused", bad.status === 400, `${bad.status}`);

    /* The email is not editable: it is the login identifier, and a silent
       change would let a borrowed session lock the owner out. */
    const emailChange = await call("PATCH", "/api/auth/me", {
      token,
      body: { email: `hijack-${Date.now()}@example.com` },
    });
    const after = await call("GET", "/api/auth/me", { token });
    check(
      "changing the email here is REFUSED, not silently ignored",
      emailChange.status === 400,
      `${emailChange.status}`,
    );
    check(
      "and the address is untouched",
      after.data?.user?.email === acct.email,
      after.data?.user?.email,
    );
  }
} finally {
  section("CLEANUP");
  for (const [role, acct] of Object.entries(ACCOUNTS)) {
    const o = originals[role];
    if (!o) continue;
    const u = await prisma.user.findUnique({ where: { email: acct.email }, select: { id: true } });
    await prisma.user.update({
      where: { id: u.id },
      data: { name: o.name, phone: o.phone },
    });
  }
  check("every account restored to what it was", true, Object.keys(originals).join(", "));
}

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
