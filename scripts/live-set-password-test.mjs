/*
 * A buyer whose account has no password can choose one at the checkout.
 *
 * The case: express checkout creates accounts with a NO_PASSWORD sentinel.
 * When that buyer came back, the checkout refused with "use the link in your
 * ticket email, or set a password first" -- advice with nowhere to follow
 * it, because this codebase has no password-reset route and the page had no
 * button. A buyer who had ever used express checkout could never buy again.
 *
 * The risk in fixing it is obvious, so most of what follows is about the
 * boundary rather than the happy path: setting a password must be possible
 * ONLY where there is none to overwrite.
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100/api";
const PREFIX = `setpw-${Date.now()}`;
let pass = 0, fail = 0;

const call = async (method, path, { body, token, orderToken } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(orderToken ? { "x-order-token": orderToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
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

/** A fresh held order, paid as a visitor. */
const hold = async () => {
  const h = await call("POST", "/orders/hold", {
    body: { eventSlug: "mawazine-2027", lines: [{ tierId: tier.id, qty: 1 }] },
  });
  return { id: h.data?.order?.id, key: h.data?.accessToken };
};

const madeEmails = [];

section("A password-less account is created, as before");
const email = `${PREFIX}-buyer@example.com`;
madeEmails.push(email);
{
  const o = await hold();
  const paid = await call("POST", `/orders/${o.id}/pay`, {
    orderToken: o.key,
    body: { holderName: "Acheteur Express", email, phone: "0612345678", locale: "fr" },
  });
  check("the first purchase goes through", paid.status === 200, String(paid.status));
  const u = await prisma.user.findUnique({ where: { email }, select: { passwordHash: true } });
  check("and the account has no password", u?.passwordHash === "!no-password-set", u?.passwordHash);
}

section("Coming back: the dead end is now a way through");
let order2;
{
  order2 = await hold();
  const again = await call("POST", `/orders/${order2.id}/pay`, {
    orderToken: order2.key,
    body: { holderName: "Acheteur Express", email, phone: "0612345678", locale: "fr" },
  });
  check("without a password it still refuses", again.status === 409, String(again.status));
  check("and flags that one must be SET, not entered",
    again.data?.needsPasswordSetup === true, JSON.stringify(again.data?.needsPasswordSetup));
  check("telling the client the minimum length",
    again.data?.minPasswordLength === 8, String(again.data?.minPasswordLength));
  /* The old behaviour: advice pointing at a route that does not exist. */
  check("it no longer sends them to a non-existent reset",
    !/ticket email|set a password first/i.test(again.data?.error ?? ""), again.data?.error);
}

section("A password that is too short is refused");
{
  const short = await call("POST", `/orders/${order2.id}/pay`, {
    orderToken: order2.key,
    body: { holderName: "Acheteur Express", email, phone: "0612345678", locale: "fr", newPassword: "abc" },
  });
  check("a 3-character password is rejected", short.status === 400, String(short.status));
  const u = await prisma.user.findUnique({ where: { email }, select: { passwordHash: true } });
  check("and nothing was written", u?.passwordHash === "!no-password-set", u?.passwordHash);
}

section("Choosing one completes the sale");
const chosen = "chosen-pass-2027";
{
  const ok = await call("POST", `/orders/${order2.id}/pay`, {
    orderToken: order2.key,
    body: { holderName: "Acheteur Express", email, phone: "0612345678", locale: "fr", newPassword: chosen },
  });
  check("the order is paid", ok.status === 200, String(ok.status));
  const u = await prisma.user.findUnique({ where: { email }, select: { passwordHash: true } });
  check("the account now has a real hash", Boolean(u) && u.passwordHash.startsWith("$2"), u?.passwordHash?.slice(0, 7));
  const login = await call("POST", "/auth/login", { body: { email, password: chosen } });
  check("and they can sign in with it", login.status === 200, String(login.status));
}

section("THE BOUNDARY: an existing password is never overwritten");
{
  /* The whole risk of this feature in one test. An account WITH a password
     must fall through to the sign-in path, never the set-password path --
     otherwise newPassword is an unauthenticated account takeover. */
  const o = await hold();
  const attack = await call("POST", `/orders/${o.id}/pay`, {
    orderToken: o.key,
    body: { holderName: "Pirate", email, phone: "0612345678", locale: "fr", newPassword: "attacker-pass-2027" },
  });
  check("newPassword on an account that HAS one does not succeed",
    attack.status !== 200, String(attack.status));
  check("it asks for the existing password instead",
    attack.data?.emailTaken === true, JSON.stringify(attack.data));

  const stillMine = await call("POST", "/auth/login", { body: { email, password: chosen } });
  check("the original password still works", stillMine.status === 200, String(stillMine.status));
  const theirs = await call("POST", "/auth/login", { body: { email, password: "attacker-pass-2027" } });
  check("the attacker's password does not", theirs.status === 401, String(theirs.status));
}

section("The resale door behaves the same way");
{
  /* A seller with a ticket to list. */
  const sellerEmail = `${PREFIX}-seller@example.com`;
  madeEmails.push(sellerEmail);
  const reg = await call("POST", "/auth/register", {
    body: { name: "Vendeur Revente", email: sellerEmail, password: "seller-pass-2027", phone: "0612345678" },
  });
  const sellerToken = reg.data?.token;
  const sh = await call("POST", "/orders/hold", {
    token: sellerToken, body: { eventSlug: "mawazine-2027", lines: [{ tierId: tier.id, qty: 1 }] },
  });
  await call("POST", `/orders/${sh.data.order.id}/pay`, {
    token: sellerToken,
    body: { holderName: "Vendeur Revente", email: sellerEmail, phone: "0612345678", locale: "fr" },
  });
  const ticket = await prisma.ticket.findFirst({
    where: { orderId: sh.data.order.id }, select: { id: true },
  });
  await call("POST", "/api/resale/listings".replace("/api", ""), {
    token: sellerToken, body: { ticketId: ticket.id },
  });
  const listing = await prisma.resaleListing.findFirst({
    where: { ticketId: ticket.id, status: "LISTED" }, select: { token: true },
  });

  /* A password-less buyer, created through the ordinary door. */
  const rEmail = `${PREFIX}-resale@example.com`;
  madeEmails.push(rEmail);
  const o = await hold();
  await call("POST", `/orders/${o.id}/pay`, {
    orderToken: o.key,
    body: { holderName: "Acheteur Revente", email: rEmail, phone: "0612345678", locale: "fr" },
  });

  if (listing?.token) {
    const blocked = await call("POST", `/resale/${listing.token}/buy`, {
      body: { holderName: "Acheteur Revente", email: rEmail, phone: "0612345678" },
    });
    check("resale also asks them to choose one",
      blocked.status === 409 && blocked.data?.needsPasswordSetup === true,
      `${blocked.status} ${JSON.stringify(blocked.data?.needsPasswordSetup)}`);

    const bought = await call("POST", `/resale/${listing.token}/buy`, {
      body: { holderName: "Acheteur Revente", email: rEmail, phone: "0612345678", newPassword: "resale-pass-2027" },
    });
    check("and the resale completes once they do", bought.status === 200,
      `${bought.status} ${JSON.stringify(bought.data).slice(0, 80)}`);
    const login = await call("POST", "/auth/login", { body: { email: rEmail, password: "resale-pass-2027" } });
    check("that password signs them in too", login.status === 200, String(login.status));
  } else {
    check("a listing was created to test against", false, "none");
  }
}

section("Cleanup");
{
  const users = await prisma.user.findMany({
    where: { email: { in: madeEmails } }, select: { id: true },
  });
  const ids = users.map((u) => u.id);
  const orders = await prisma.order.findMany({
    where: { customerId: { in: ids } }, select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await prisma.resaleListing.deleteMany({ where: { OR: [{ sellerId: { in: ids } }, { ticket: { orderId: { in: orderIds } } }] } });
  await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.creditEntry.deleteMany({ where: { userId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  const left = await prisma.user.count({ where: { email: { in: madeEmails } } });
  check("test accounts removed", left === 0, `${left} left`);
}

console.log(`\n${"─".repeat(62)}`);
console.log(`\x1b[1mTOTAL: ${pass}/${pass + fail} passed\x1b[0m`);
console.log(`${"─".repeat(62)}`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
