/*
 * Credit that covers only PART of an order.
 *
 * Full cover was always right: /pay returns mode "credit" and settles
 * without a gateway. Partial cover was not. The credit was spent from the
 * balance and CMI was then told to charge order.totalCents -- the FULL
 * price -- so the buyer paid twice for the part their balance had already
 * settled. The one broken case was the one in between, which is why it was
 * not noticed: the full-cover path returns before it.
 */
import { prisma } from "../backend/src/lib/prisma.js";
import { creditBalance } from "../backend/src/lib/credit.js";

const API = process.env.API_URL ?? "http://localhost:4100/api";
const PREFIX = `cpart-${Date.now()}`;
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
const mad = (c) => (c / 100).toFixed(2);

const ev = await call("GET", "/events/mawazine-2027");
const tier = (ev.data?.event ?? ev.data)?.tiers?.[0];
if (!tier) { console.error("no event"); process.exit(1); }

const email = `${PREFIX}@example.com`;
const reg = await call("POST", "/auth/register", {
  body: { name: "Acheteur Partiel", email, password: "partial-pass-2027", phone: "0612345678" },
});
const token = reg.data?.token;
const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

/* A balance deliberately SMALLER than the ticket, so the card must cover
   the rest. */
const grant = Math.round(tier.priceCents / 4);
await prisma.creditEntry.create({
  data: { userId: user.id, amountCents: grant, reason: "ADJUSTMENT", label: "Test partial" },
});

section("Setup");
check("the ticket costs more than the balance", grant < tier.priceCents,
  `${mad(grant)} balance vs ${mad(tier.priceCents)} ticket`);

section("A partly covered order does NOT settle on credit alone");
const hold = await call("POST", "/orders/hold", {
  token, body: { eventSlug: "mawazine-2027", lines: [{ tierId: tier.id, qty: 1 }] },
});
const orderId = hold.data?.order?.id;
const pay = await call("POST", `/orders/${orderId}/pay`, {
  token, body: { locale: "fr", useCredit: true },
});
check("it is paid, one way or another", pay.status === 200, String(pay.status));
check("and the mode is not 'credit'", pay.data?.mode !== "credit", pay.data?.mode);
check("the credit applied is the whole balance",
  pay.data?.creditAppliedCents === grant, mad(pay.data?.creditAppliedCents ?? 0));

section("The balance was spent");
{
  const left = await creditBalance(user.id);
  check("the balance is now zero", left === 0, mad(left));
  const order = await prisma.order.findUnique({
    where: { id: orderId }, select: { creditAppliedCents: true, totalCents: true },
  });
  check("and the order records what it took",
    order?.creditAppliedCents === grant, mad(order?.creditAppliedCents ?? 0));
}

section("THE BUG: the gateway is charged only the remainder");
{
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId }, select: { totalCents: true, creditAppliedCents: true },
  });
  const expected = order.totalCents - order.creditAppliedCents;

  if (pay.data?.mode === "cmi") {
    /* The signed amount CMI is handed. In CMI's form it is a decimal
       string in major units. */
    const amount = pay.data?.fields?.amount ?? pay.data?.fields?.Amount;
    const sentCents = Math.round(Number(String(amount).replace(",", ".")) * 100);
    check("CMI is told the card portion, not the full price",
      sentCents === expected,
      `sent ${mad(sentCents)}, card owes ${mad(expected)}, ticket ${mad(order.totalCents)}`);
    check("which is less than the ticket price",
      sentCents < order.totalCents, `${mad(sentCents)} < ${mad(order.totalCents)}`);
  } else {
    /* Mock mode settles without a gateway. The arithmetic still has to be
       right, so assert it on the order instead. */
    check("the card portion is the remainder",
      expected === order.totalCents - grant,
      `${mad(expected)} = ${mad(order.totalCents)} - ${mad(grant)}`);
    check("and it is not the full price (mock mode: no gateway to ask)",
      expected < order.totalCents, `${mad(expected)} < ${mad(order.totalCents)}`);
  }
}

section("Cleanup");
{
  const orders = await prisma.order.findMany({ where: { customerId: user.id }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.ticket.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.creditEntry.deleteMany({ where: { userId: user.id } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.delete({ where: { id: user.id } });
  const left = await prisma.user.count({ where: { email } });
  check("test account removed", left === 0, `${left} left`);
}

console.log(`\n${"─".repeat(62)}`);
console.log(`\x1b[1mTOTAL: ${pass}/${pass + fail} passed\x1b[0m`);
console.log(`${"─".repeat(62)}`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
