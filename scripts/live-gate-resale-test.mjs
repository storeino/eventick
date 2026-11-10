/*
 * A seat that is ON SALE does not open the door.
 *
 * Listing a ticket leaves it VALID -- deliberately, so an unsold listing
 * does not cost the seller their night. But the gate admitted on status
 * alone, so a seller could list a seat, walk in on it, and leave the
 * listing live for someone else to buy: the buyer pays for a seat that has
 * already gone through the door, and the organiser sells the same place
 * twice.
 */
import { prisma } from "../backend/src/lib/prisma.js";

const API = process.env.API_URL ?? "http://localhost:4100/api";
const PREFIX = `gateresale-${Date.now()}`;
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

const staff = await call("POST", "/auth/login", {
  body: { email: "admin@eventick.ma", password: "admin123" },
});
const gate = staff.data?.token;
if (!gate) { console.error("cannot sign in as staff to scan"); process.exit(1); }

const ev = await call("GET", "/events/mawazine-2027");
const tier = (ev.data?.event ?? ev.data)?.tiers?.[0];
const emails = [];

/** A buyer with one paid ticket. */
const buyTicket = async (tag) => {
  const email = `${PREFIX}-${tag}@example.com`;
  emails.push(email);
  const reg = await call("POST", "/auth/register", {
    body: { name: `Porteur ${tag}`, email, password: "holder-pass-2027", phone: "0612345678" },
  });
  const token = reg.data?.token;
  const h = await call("POST", "/orders/hold", {
    token, body: { eventSlug: "mawazine-2027", lines: [{ tierId: tier.id, qty: 1 }] },
  });
  await call("POST", `/orders/${h.data.order.id}/pay`, {
    token, body: { holderName: `Porteur ${tag}`, email, phone: "0612345678", locale: "fr" },
  });
  const ticket = await prisma.ticket.findFirstOrThrow({
    where: { orderId: h.data.order.id }, select: { id: true, ref: true },
  });
  return { email, token, ticket };
};

const scan = (ref) => call("POST", "/gate/check-in", { token: gate, body: { ref, source: "manual" } });

section("An ordinary ticket still gets in");
{
  const { ticket } = await buyTicket("plain");
  const r = await scan(ticket.ref);
  check("a VALID, unlisted ticket is admitted", r.status === 200 && r.data?.result === "ok",
    `${r.status} ${r.data?.result}`);
}

section("A ticket ON SALE is refused");
let listedCase;
{
  listedCase = await buyTicket("listed");
  const listed = await call("POST", "/resale/listings", {
    token: listedCase.token, body: { ticketId: listedCase.ticket.id },
  });
  check("the ticket is listed", listed.status === 201, String(listed.status));

  const before = await prisma.ticket.findUniqueOrThrow({
    where: { id: listedCase.ticket.id }, select: { status: true },
  });
  check("and is still VALID — an unsold listing keeps the seat usable",
    before.status === "VALID", before.status);

  const r = await scan(listedCase.ticket.ref);
  check("the gate refuses it", r.status === 409, String(r.status));
  check("naming the reason, not a generic error",
    r.data?.result === "listed", JSON.stringify(r.data?.result));

  const after = await prisma.ticket.findUniqueOrThrow({
    where: { id: listedCase.ticket.id }, select: { status: true, usedAt: true },
  });
  check("the refusal leaves the ticket untouched",
    after.status === "VALID" && after.usedAt === null, `${after.status}, usedAt=${after.usedAt}`);
  const listing = await prisma.resaleListing.findFirstOrThrow({
    where: { ticketId: listedCase.ticket.id }, select: { status: true },
  });
  check("and the listing is still on sale", listing.status === "LISTED", listing.status);
}

section("Cancelling the listing gives the seat back");
{
  const mine = await call("GET", "/resale/mine/listings", { token: listedCase.token });
  const row = (mine.data?.listings ?? []).find((l) => l.ticketId === listedCase.ticket.id)
    ?? (await prisma.resaleListing.findFirstOrThrow({ where: { ticketId: listedCase.ticket.id }, select: { id: true } }));
  const cancelled = await call("DELETE", `/resale/listings/${row.id}`, { token: listedCase.token });
  check("the seller can cancel", cancelled.status === 200 || cancelled.status === 204, String(cancelled.status));

  const r = await scan(listedCase.ticket.ref);
  check("and the gate admits them again", r.status === 200 && r.data?.result === "ok",
    `${r.status} ${r.data?.result}`);
}

section("A SOLD listing does not block the new holder");
{
  /* completeResale moves the seller's ticket to TRANSFERRED and issues a
     NEW one. The buyer's ticket has no listing of its own, so nothing here
     should stand in their way. */
  const seller = await buyTicket("sold");
  await call("POST", "/resale/listings", { token: seller.token, body: { ticketId: seller.ticket.id } });
  const listing = await prisma.resaleListing.findFirstOrThrow({
    where: { ticketId: seller.ticket.id }, select: { token: true },
  });
  const buyerEmail = `${PREFIX}-buyer@example.com`;
  emails.push(buyerEmail);
  const bought = await call("POST", `/resale/${listing.token}/buy`, {
    body: { holderName: "Acheteur Revente", email: buyerEmail, phone: "0612345678", newPassword: "buyer-pass-2027" },
  });
  check("the resale completes", bought.status === 200, String(bought.status));

  const newTicket = await prisma.ticket.findFirstOrThrow({
    where: { orderId: bought.data?.orderId }, select: { ref: true },
  });
  const r = await scan(newTicket.ref);
  check("the BUYER's new ticket is admitted", r.status === 200 && r.data?.result === "ok",
    `${r.status} ${r.data?.result}`);

  const old = await scan(seller.ticket.ref);
  check("the seller's old ticket is not", old.status === 409, `${old.status} ${old.data?.result}`);
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
