/**
 * Live test — buying without signing up first.
 *
 * Requiring an account before checkout was right about the destination and
 * wrong about the moment: a stranger who had just picked a seat was sent to
 * a sign-up form before they had given anything, which is the cheapest
 * possible place to lose a sale.
 *
 * The account is created at /pay instead, from the name, email and phone
 * any checkout asks for anyway. Nothing ends up ownerless: a hold with no
 * session is claimed by that account when it is paid, and an unpaid one is
 * swept like any other.
 *
 * Run from the backend directory, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-express-checkout-test.mjs
 */
import { prisma } from "../backend/src/lib/prisma.js";
import { orderConfirmationHtml } from "../backend/src/lib/email-templates.js";

const API = "http://localhost:4100";
const SUFFIX = Date.now();
const PREFIX = `express-${SUFFIX}`;

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
  try { data = JSON.parse(text); } catch { data = text.slice(0, 220); }
  return { status: res.status, data };
}
const login = async (email, password) =>
  (await call("POST", "/api/auth/login", { body: { email, password } })).data.token;

let fails = 0;
const check = (label, pass, detail) => {
  if (!pass) fails++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : ""));
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const orga = await login("organisateur@eventick.ma", "orga1234");
const orgaId = (await call("GET", "/api/auth/me", { token: orga })).data.user.id;

const start = new Date(Date.now() + 30 * 86_400_000);
const ev = await prisma.event.create({
  data: {
    slug: PREFIX, organiserId: orgaId,
    titleFr: "Achat express", titleAr: "ت", category: "concert", city: "Casablanca",
    venueFr: "S", venueAr: "ق", address: "1", startAt: start, endAt: start, doorsAt: start,
    image: "x.jpg", blurbFr: "b", blurbAr: "ب", aboutFr: "a", aboutAr: "أ",
    ageFr: "+18", ageAr: "+18", status: "PUBLISHED", maxPerBuyer: 0, allowResale: true,
    tiers: { create: { nameFr: "P", nameAr: "م", blurbFr: "b", blurbAr: "ب",
      priceCents: 5000, capacity: 40, zoneFr: "Z", zoneAr: "ز", gateFr: "G", gateAr: "ج" } },
  },
  include: { tiers: true },
});

/** Hold seats with NO session at all, as a visitor would. */
async function holdAsVisitor(qty = 1) {
  const r = await call("POST", "/api/orders/hold", {
    body: { eventSlug: PREFIX, lines: [{ tierId: ev.tiers[0].id, qty }] },
  });
  return r;
}

try {
  section("A visitor can reserve seats without an account");
  const held = await holdAsVisitor();
  check("POST /orders/hold succeeds with no session", held.status === 201, `${held.status}`);
  check("it hands back an access token", Boolean(held.data?.accessToken), held.data?.accessToken ? "issued" : "MISSING");
  const orderId = held.data?.order?.id;
  const accessToken = held.data?.accessToken;
  const beforePay = await prisma.order.findUnique({
    where: { id: orderId }, select: { customerId: true },
  });
  check("the order starts with no owner", beforePay?.customerId === null, `${beforePay?.customerId}`);

  section("Paying creates the account from what they typed");
  const email = `${PREFIX}@example.com`;
  const paid = await call("POST", `/api/orders/${orderId}/pay?k=${accessToken}`, {
    body: { holderName: "Visiteur Express", email, phone: "0612345678" },
  });
  check("the payment settles", paid.status === 200, `${paid.status} ${JSON.stringify(paid.data).slice(0, 80)}`);

  const made = await prisma.user.findUnique({
    where: { email }, select: { id: true, name: true, phone: true, role: true, passwordHash: true },
  });
  check("an account now exists for that email", Boolean(made), made ? made.id.slice(0, 8) + "…" : "none");
  check("with the name and phone they gave", made?.name === "Visiteur Express" && made?.phone === "0612345678", `${made?.name} / ${made?.phone}`);
  check("as a CUSTOMER, never anything else", made?.role === "CUSTOMER", made?.role);

  const owned = await prisma.order.findUnique({
    where: { id: orderId }, select: { customerId: true, status: true },
  });
  check("the order belongs to it", owned?.customerId === made?.id, `${owned?.customerId === made?.id}`);
  check("and is PAID", owned?.status === "PAID", owned?.status);
  const tickets = await prisma.ticket.count({ where: { orderId, status: "VALID" } });
  check("a real ticket was issued", tickets === 1, `${tickets}`);

  section("The new account cannot be signed into until a password is set");
  const guessed = await call("POST", "/api/auth/login", {
    body: { email, password: "!no-password-set" },
  });
  check("the stored sentinel is not a usable password", guessed.status === 401, `${guessed.status}`);
  for (const attempt of ["", "password", "123456"]) {
    const r = await call("POST", "/api/auth/login", { body: { email, password: attempt } });
    if (r.status === 200) check(`"${attempt}" must not sign in`, false, "SIGNED IN");
  }
  check("no common password signs in either", true, "checked 3");

  section("A second purchase with the same email is not a second account");
  const held2 = await holdAsVisitor();
  const noPassword = await call("POST", `/api/orders/${held2.data.order.id}/pay?k=${held2.data.accessToken}`, {
    body: { holderName: "Visiteur Express", email, phone: "0612345678" },
  });
  /* The email belongs to an account now, so the checkout must ask for its
     password rather than quietly attaching a stranger's order to it. */
  check("it is refused, not silently attached", noPassword.status === 409, `${noPassword.status}`);
  check(
    "and says the account has no password yet, so the form can say what to do",
    noPassword.data?.needsPasswordSetup === true,
    JSON.stringify(noPassword.data).slice(0, 90),
  );
  const count = await prisma.user.count({ where: { email } });
  check("no duplicate account was created", count === 1, `${count}`);

  section("An email with a REAL password is a sign-in, done in place");
  const pwEmail = `${PREFIX}-pw@example.com`;
  await call("POST", "/api/auth/register", {
    body: { name: "Deja Inscrit", email: pwEmail, password: "express-pass-2027", phone: "0612345678" },
  });
  const held3 = await holdAsVisitor();
  const wrong = await call("POST", `/api/orders/${held3.data.order.id}/pay?k=${held3.data.accessToken}`, {
    body: { holderName: "Deja Inscrit", email: pwEmail, phone: "0612345678", password: "wrong-one" },
  });
  check("a wrong password is refused", wrong.status === 401, `${wrong.status}`);
  const noPw = await call("POST", `/api/orders/${held3.data.order.id}/pay?k=${held3.data.accessToken}`, {
    body: { holderName: "Deja Inscrit", email: pwEmail, phone: "0612345678" },
  });
  check("omitting it is refused too", noPw.status === 409, `${noPw.status}`);
  check(
    "with emailTaken, so the form knows to ask rather than redirect",
    noPw.data?.emailTaken === true,
    JSON.stringify(noPw.data).slice(0, 80),
  );
  const right = await call("POST", `/api/orders/${held3.data.order.id}/pay?k=${held3.data.accessToken}`, {
    body: { holderName: "Deja Inscrit", email: pwEmail, phone: "0612345678", password: "express-pass-2027" },
  });
  check("the right password completes the purchase", right.status === 200, `${right.status}`);
  const pwUser = await prisma.user.findUnique({ where: { email: pwEmail }, select: { id: true } });
  const pwOrder = await prisma.order.findUnique({
    where: { id: held3.data.order.id }, select: { customerId: true },
  });
  check("and the order is theirs", pwOrder?.customerId === pwUser?.id, `${pwOrder?.customerId === pwUser?.id}`);

  section("Staff still cannot buy");
  const staffHold = await call("POST", "/api/orders/hold", {
    token: orga, body: { eventSlug: PREFIX, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
  });
  check("an organiser is refused at hold", staffHold.status === 403, `${staffHold.status}`);

  section("A RESOLD seat buys the same way");
  /*
   * Buying a resold seat is still buying, through a different door. Leaving
   * that door demanding a sign-up while the ordinary checkout stopped would
   * mean a stranger could buy a ticket but not a resold one -- same person,
   * same money, different wall.
   */
  {
    /* A seller with a ticket to list. Registered normally: the seller is not
       what is under test here. */
    const sellerEmail = `${PREFIX}-seller@example.com`;
    const sellerReg = await call("POST", "/api/auth/register", {
      body: { name: "Vendeur Express", email: sellerEmail, password: "seller-pass-2027", phone: "0612345678" },
    });
    const sellerToken = sellerReg.data?.token;
    const sellerHold = await call("POST", "/api/orders/hold", {
      token: sellerToken, body: { eventSlug: PREFIX, lines: [{ tierId: ev.tiers[0].id, qty: 1 }] },
    });
    await call("POST", `/api/orders/${sellerHold.data.order.id}/pay`, {
      token: sellerToken,
      body: { holderName: "Vendeur Express", email: sellerEmail, phone: "0612345678" },
    });
    const sellerTicket = await prisma.ticket.findFirst({
      where: { orderId: sellerHold.data.order.id }, select: { id: true },
    });
    await call("POST", "/api/resale/listings", {
      token: sellerToken, body: { ticketId: sellerTicket.id },
    });
    const listing = await prisma.resaleListing.findFirst({
      where: { ticketId: sellerTicket.id, status: "LISTED" }, select: { token: true },
    });

    /* The part under test: a visitor, with no session at all. */
    const visitorEmail = `${PREFIX}-resale-buyer@example.com`;
    const bought = await call("POST", `/api/resale/${listing.token}/buy`, {
      body: { holderName: "Acheteur Visiteur", email: visitorEmail, phone: "0612345678" },
    });
    check("a visitor can buy a resold seat", bought.status === 200, `${bought.status} ${JSON.stringify(bought.data).slice(0, 70)}`);

    const madeUser = await prisma.user.findUnique({
      where: { email: visitorEmail }, select: { id: true, role: true },
    });
    check("an account was created for them", Boolean(madeUser), madeUser ? "yes" : "none");
    check("as a CUSTOMER", madeUser?.role === "CUSTOMER", madeUser?.role);
    const resaleOrder = await prisma.order.findUnique({
      where: { id: bought.data?.orderId }, select: { customerId: true },
    });
    check("and the order is theirs", resaleOrder?.customerId === madeUser?.id, `${resaleOrder?.customerId === madeUser?.id}`);
    check("the buyer gets a new reference", Boolean(bought.data?.newRef), bought.data?.newRef);

    /* The self-buy guard must still hold on the express path, or a seller
       could sign in through it and walk around the check. */
    const ticket2 = await prisma.ticket.findFirst({
      where: { order: { customerId: madeUser?.id } }, select: { id: true },
    });
    if (ticket2) {
      await call("POST", "/api/resale/listings", {
        body: { ticketId: ticket2.id },
      });
    }
    const selfListing = await prisma.resaleListing.findFirst({
      where: { sellerId: madeUser?.id, status: "LISTED" }, select: { token: true },
    });
    if (selfListing) {
      const selfBuy = await call("POST", `/api/resale/${selfListing.token}/buy`, {
        body: { holderName: "Acheteur Visiteur", email: visitorEmail, phone: "0612345678" },
      });
      check(
        "a seller still cannot buy their own listing through this path",
        selfBuy.status === 409,
        `${selfBuy.status}`,
      );
    }
  }

  section("The confirmation email is the way back in");
  /*
   * An account created at checkout has no password, so the emailed link IS
   * how the buyer reaches their tickets. A missing button, or one that
   * leads to a sign-in wall, is the difference between a working purchase
   * and a dead end. Rendered directly rather than sent, so this asserts the
   * template rather than the mail transport.
   */
  const base = {
    locale: "fr",
    holderName: "Visiteur Express",
    eventTitle: "Concert Test",
    eventCity: "Casablanca",
    eventStart: new Date("2027-06-19T19:30:00Z"),
    orderId: "order-abc123",
    totalCents: 85000,
    tickets: [{ ref: "ET-2026-ABCDEF", tierName: "Pass", holderName: "Visiteur Express", priceCents: 85000 }],
  };

  const withToken = orderConfirmationHtml({ ...base, accessToken: "tok-xyz-789" });
  check("the email contains a link", withToken.includes("<a href="), withToken.includes("<a href=") ? "found" : "NONE");
  check(
    "pointing at this order's confirmation page",
    withToken.includes("/confirmation/order-abc123"),
    "path ok",
  );
  check(
    "carrying the access token, which is what authorises reading it",
    withToken.includes("k=tok-xyz-789"),
    "token ok",
  );

  const withoutToken = orderConfirmationHtml({ ...base, accessToken: null });
  check(
    "and NO button when there is no token, rather than one that leads nowhere",
    !withoutToken.includes("<a href="),
    withoutToken.includes("<a href=") ? "button rendered anyway" : "omitted",
  );

  /* The token is user data in a URL: it has to be escaped, or a token with a
     & in it would silently truncate the link. */
  const odd = orderConfirmationHtml({ ...base, accessToken: "a&b=c" });
  check("the token is URL-encoded", odd.includes("k=a%26b%3Dc"), "encoded");

  const ar = orderConfirmationHtml({ ...base, locale: "ar", accessToken: "tok-1" });
  check("the Arabic email has the link too", ar.includes("/confirmation/"), "present");

  console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
  process.exit(fails === 0 ? 0 : 1);

} finally {
  section("CLEANUP");
  const tierIds = ev.tiers.map((t) => t.id);
  await prisma.creditEntry.deleteMany({ where: { order: { eventId: ev.id } } });
  await prisma.ticket.deleteMany({ where: { tierId: { in: tierIds } } });
  await prisma.orderLine.deleteMany({ where: { tierId: { in: tierIds } } });
  await prisma.order.deleteMany({ where: { eventId: ev.id } });
  await prisma.ticketTier.deleteMany({ where: { eventId: ev.id } });
  await prisma.event.delete({ where: { id: ev.id } });
  const removed = await prisma.user.deleteMany({ where: { email: { contains: PREFIX } } });
  check("test accounts removed", removed.count >= 1, `${removed.count}`);
}

console.log(`\n${fails === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${fails} FAILED\x1b[0m`}`);
await prisma.$disconnect();
process.exit(fails === 0 ? 0 : 1);
