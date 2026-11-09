/**
 * Live test — a stuck refund is settled as store credit, not a transfer.
 *
 * Customers are paid in credit now, so a REGISTERED buyer should never be
 * waiting on a bank transfer. Two ways they still can be: the refund was
 * decided before credit existed, or refundOrder recorded the amount and the
 * grant that should have followed it failed. Both leave a row an admin can
 * see, name and total, and not pay -- three of them were found in dev,
 * each reading "No RIB on file - nowhere to transfer".
 *
 * The queue flags those rows `creditable`, and this route settles them.
 * Guests are excluded: they have no balance, and the bank reversal is the
 * only thing that reaches them.
 *
 * This suite needs a creditable row to exist. It passes trivially when the
 * queue is clean, which is the normal state -- it is a regression guard for
 * the route and its refusals, not a fixture.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-refund-credit-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = "http://localhost:4100";
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
const login = async (e, p) =>
  (await call("POST", "/api/auth/login", { body: { email: e, password: p } })).data.token;

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};
const mad = (c) => (c / 100).toFixed(2);

const admin = await login("admin@eventick.ma", "admin123");
const customer = await login("client@eventick.ma", "client123");
const balance = async () =>
  (await call("GET", "/api/auth/me/credit", { token: customer })).data.balanceCents;

const q0 = await call("GET", "/api/platform/refunds/pending", { token: admin });
console.log(`\nqueue holds ${q0.data.refunds.length} row(s), ${mad(q0.data.totalCents)} MAD`);
for (const r of q0.data.refunds) {
  console.log(`  ${mad(r.amountCents).padStart(9)} MAD  creditable=${r.creditable}  guest=${r.isGuest}  ${r.buyerEmail}`);
}

const target = q0.data.refunds.find((r) => r.creditable);
if (!target) {
  console.log("  (no creditable row in the queue — nothing to settle, which is the healthy state)");
}

if (target) {
  const before = await balance();
  const credited = await call("POST", `/api/platform/refunds/${target.orderId}/credit`, {
    token: admin, body: {},
  });
  check("settling it as credit succeeds", credited.status === 200, `${credited.status} ${JSON.stringify(credited.data).slice(0, 70)}`);

  const after = await balance();
  check(
    "the customer's balance rose by the refund amount",
    after - before === target.amountCents,
    `${mad(before)} -> ${mad(after)} (+${mad(after - before)})`,
  );

  const q1 = await call("GET", "/api/platform/refunds/pending", { token: admin });
  check(
    "and the row leaves the bank queue",
    !q1.data.refunds.some((r) => r.orderId === target.orderId),
    `${q1.data.refunds.length} row(s) left`,
  );

  const twice = await call("POST", `/api/platform/refunds/${target.orderId}/credit`, {
    token: admin, body: {},
  });
  check("crediting it twice is refused", twice.status === 409, `${twice.status}`);

  const alsoPay = await call("POST", `/api/platform/refunds/${target.orderId}/paid`, {
    token: admin, body: { reference: "SHOULD-BE-REFUSED" },
  });
  check("and it can no longer be marked paid by bank", alsoPay.status === 409, `${alsoPay.status}`);

  const asCustomer = await call("POST", `/api/platform/refunds/${target.orderId}/credit`, {
    token: customer, body: {},
  });
  check("a customer cannot credit themselves", asCustomer.status === 403, `${asCustomer.status}`);
}

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
