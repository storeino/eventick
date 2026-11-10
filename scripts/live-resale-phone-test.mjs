/*
 * The resale page asked for a phone number the account already held.
 *
 * User.phone was added so a buyer types their number once instead of at
 * every checkout. The ordinary checkout was taught to read it; this page
 * was not, so a signed-in buyer with a number on file was asked again on
 * every resale -- the exact re-typing that change set out to end.
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100/api";
const PREFIX = `rphone-${Date.now()}`;
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

const ev = await call("GET", "/events/mawazine-2027");
const tier = (ev.data?.event ?? ev.data)?.tiers?.[0];
if (!tier) { console.error("no event to test against"); process.exit(1); }

const emails = [];

/** A seller with a ticket listed for resale. Returns the listing token. */
const listOne = async (tag) => {
  const email = `${PREFIX}-${tag}@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: `Vendeur ${tag}`, email, password: "seller-pass-2027", phone: "0612345678" },
  });
  const token = reg.data?.token;
  const h = await call("POST", "/orders/hold", {
    token, body: { eventSlug: "mawazine-2027", lines: [{ tierId: tier.id, qty: 1 }] },
  });
  await call("POST", `/orders/${h.data.order.id}/pay`, {
    token, body: { holderName: `Vendeur ${tag}`, email, phone: "0612345678", locale: "fr" },
  });
  const ticket = await prisma.ticket.findFirst({
    where: { orderId: h.data.order.id }, select: { id: true },
  });
  await call("POST", "/resale/listings", { token, body: { ticketId: ticket.id } });
  const listing = await prisma.resaleListing.findFirst({
    where: { ticketId: ticket.id, status: "LISTED" }, select: { token: true },
  });
  return listing?.token;
};

section("A buyer whose account has a number is not asked again");
{
  const email = `${PREFIX}-withphone@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: "Acheteur Connu", email, password: "buyer-pass-2027", phone: "0698765432" },
  });
  const token = reg.data?.token;
  const listingToken = await listOne("s1");

  /* The request the page now sends: no phone at all. */
  const bought = await call("POST", `/resale/${listingToken}/buy`, { token, body: {} });
  check("the purchase succeeds with no phone in the body",
    bought.status === 200, `${bought.status} ${JSON.stringify(bought.data).slice(0, 80)}`);

  const order = await prisma.order.findUnique({
    where: { id: bought.data?.orderId }, select: { phone: true },
  });
  check("and the order carries the account's number",
    order?.phone === "0698765432", order?.phone);
}

section("A one-off number still overrides, for this order only");
{
  const email = `${PREFIX}-override@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: "Acheteur Override", email, password: "buyer-pass-2027", phone: "0611111111" },
  });
  const token = reg.data?.token;
  const listingToken = await listOne("s2");

  const bought = await call("POST", `/resale/${listingToken}/buy`, {
    token, body: { phone: "0622222222" },
  });
  check("a number in the body is used", bought.status === 200, String(bought.status));
  const order = await prisma.order.findUnique({
    where: { id: bought.data?.orderId }, select: { phone: true },
  });
  check("the order gets the typed number", order?.phone === "0622222222", order?.phone);
  const acct = await prisma.user.findUnique({ where: { email }, select: { phone: true } });
  check("but the ACCOUNT keeps its own", acct?.phone === "0611111111", acct?.phone);
}

section("An older account with no number is asked once, then never again");
{
  const email = `${PREFIX}-legacy@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: "Compte Ancien", email, password: "buyer-pass-2027", phone: "0633333333" },
  });
  const token = reg.data?.token;
  /* Simulate an account created before User.phone existed. */
  await prisma.user.update({ where: { email }, data: { phone: null } });

  const listingToken = await listOne("s3");
  const missing = await call("POST", `/resale/${listingToken}/buy`, { token, body: {} });
  check("with no number anywhere it is refused", missing.status === 400, String(missing.status));

  const bought = await call("POST", `/resale/${listingToken}/buy`, {
    token, body: { phone: "0644444444" },
  });
  check("supplying one succeeds", bought.status === 200, String(bought.status));
  const acct = await prisma.user.findUnique({ where: { email }, select: { phone: true } });
  check("and it is saved to the account, so the field does not return",
    acct?.phone === "0644444444", acct?.phone);
}

section("A visitor must still supply one");
{
  /* No account to fall back to, so the form is the only source. */
  const listingToken = await listOne("s4");
  const visitorEmail = `${PREFIX}-visitor@example.com`;
  emails.push(visitorEmail);
  const noPhone = await call("POST", `/resale/${listingToken}/buy`, {
    body: { holderName: "Visiteur Sans Tel", email: visitorEmail, newPassword: "visitor-pass-2027" },
  });
  check("a visitor with no number is refused", noPhone.status === 400, String(noPhone.status));

  const ok = await call("POST", `/resale/${listingToken}/buy`, {
    body: { holderName: "Visiteur Sans Tel", email: visitorEmail, phone: "0655555555", newPassword: "visitor-pass-2027" },
  });
  check("with one, the account is created and the seat sold",
    ok.status === 200, `${ok.status} ${JSON.stringify(ok.data).slice(0, 70)}`);
  const made = await prisma.user.findUnique({ where: { email: visitorEmail }, select: { phone: true } });
  check("and the new account holds the number", made?.phone === "0655555555", made?.phone);
}

section("A malformed number is still rejected");
{
  const email = `${PREFIX}-bad@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: "Acheteur Bad", email, password: "buyer-pass-2027", phone: "0666666666" },
  });
  const listingToken = await listOne("s5");
  const bad = await call("POST", `/resale/${listingToken}/buy`, {
    token: reg.data?.token, body: { phone: "12" },
  });
  check("nonsense in the body is refused", bad.status === 400, String(bad.status));
}

section("Cleanup");
{
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.resaleListing.deleteMany({
    where: { OR: [{ sellerId: { in: ids } }, { ticket: { orderId: { in: orderIds } } }] },
  });
  await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.creditEntry.deleteMany({ where: { userId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  const left = await prisma.user.count({ where: { email: { in: emails } } });
  check("test accounts removed", left === 0, `${left} left`);
}

console.log(`\n${"─".repeat(62)}`);
console.log(`\x1b[1mTOTAL: ${pass}/${pass + fail} passed\x1b[0m`);
console.log(`${"─".repeat(62)}`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
