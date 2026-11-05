/**
 * Live test — ticket sharing.
 *
 * Proves the three properties that actually matter, rather than that the
 * endpoints respond:
 *
 *   1. After a claim, the SENDER's QR is refused at the gate and the
 *      RECIPIENT's is admitted. This is the whole point: the old transfer
 *      voided the ticket and issued nothing, so the recipient had no QR at all.
 *   2. Two people opening the same link at once cannot both get a ticket —
 *      otherwise one seat admits two people.
 *   3. A revoked link cannot be claimed, and a claimed link cannot be reused.
 *
 * Creates its own event, order and tickets, and deletes them at the end.
 */

const API = process.env.API ?? "http://localhost:4100";

const ACCOUNTS = {
  organiser: { email: "organisateur@eventick.ma", password: "orga1234" },
  customer: { email: "client@eventick.ma", password: "client123" },
};

let failures = 0;

function check(label, pass, detail) {
  if (!pass) failures++;
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
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 120);
  }
  return { status: res.status, data };
}

async function login(account) {
  const res = await call("POST", "/api/auth/login", { body: account });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

/** One PAID order with `qty` tickets on a throwaway event. */
async function buyTickets(orgToken, custToken, qty, slugSuffix) {
  const slug = `share-test-${slugSuffix}`;
  const start = new Date(Date.now() + 30 * 86_400_000);
  const created = await call("POST", "/api/organiser/events", {
    token: orgToken,
    body: {
      slug,
      titleFr: "Test partage",
      titleAr: "Test partage",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle test",
      venueAr: "Salle test",
      address: "1 rue du test",
      start: start.toISOString(),
      end: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      doors: new Date(start.getTime() - 3_600_000).toISOString(),
      image: "https://example.com/a.jpg",
      blurbFr: "Test",
      blurbAr: "Test",
      aboutFr: "Test",
      aboutAr: "Test",
      ageFr: "18+",
      ageAr: "18+",
      tiers: [
        {
          nameFr: "Standard",
          nameAr: "Standard",
          blurbFr: "x",
          blurbAr: "x",
          priceCents: 20000,
          capacity: 20,
          zoneFr: "A",
          zoneAr: "A",
          gateFr: "1",
          gateAr: "1",
        },
      ],
    },
  });
  if (created.status !== 201) throw new Error(`event create: ${JSON.stringify(created.data)}`);
  const event = created.data.event;
  const tierId = event.tiers[0].id;

  const hold = await call("POST", "/api/orders/hold", {
    token: custToken,
    body: { eventSlug: slug, lines: [{ tierId, qty }] },
  });
  if (hold.status !== 201) throw new Error(`hold: ${JSON.stringify(hold.data)}`);
  const orderId = hold.data.order.id;

  const pay = await call("POST", `/api/orders/${orderId}/pay`, {
    token: custToken,
    body: { holderName: "Client Test", email: "client@eventick.ma", phone: "0612345678" },
  });
  if (pay.status !== 200) throw new Error(`pay: ${JSON.stringify(pay.data)}`);

  const order = await call("GET", `/api/orders/${orderId}`, { token: custToken });
  return { slug, eventId: event.id, orderId, tickets: order.data.order.tickets };
}

/** Present a ticket at the gate exactly as a camera would: the signed payload
 * the server itself generated, through the strict `camera` source.
 *
 * Reading the ticket takes the HOLDER's credential, not the organiser's:
 * /api/tickets/:id serves the signed QR, so it is gated on proof of purchase
 * rather than on knowing the id. `owner` is either a session token (the
 * buyer) or the ticket's own access token (a guest recipient), which is why
 * both forms are accepted here. */
async function scanSigned(orgToken, ticketId, owner = {}) {
  const query = owner.key ? `?k=${encodeURIComponent(owner.key)}` : "";
  const detail = await call("GET", `/api/tickets/${ticketId}${query}`, { token: owner.token });
  const payload = detail.data.qrPayload;
  if (!payload) throw new Error(`no qrPayload for ticket ${ticketId} (HTTP ${detail.status})`);
  return call("POST", "/api/gate/check-in", {
    token: orgToken,
    body: { ref: payload, source: "camera" },
  });
}

async function main() {
  const orgToken = await login(ACCOUNTS.organiser);
  const custToken = await login(ACCOUNTS.customer);
  const cleanup = [];

  // 1. The decisive property
  console.log("\n\x1b[1mSender's QR dies, recipient's QR admits\x1b[0m");
  {
    const bought = await buyTickets(orgToken, custToken, 1, `a${Date.now()}`);
    cleanup.push(bought.slug);
    const senderTicket = bought.tickets[0];

    const share = await call("POST", "/api/share", {
      token: custToken,
      body: { ticketId: senderTicket.id, message: "A ce soir" },
    });
    check("share link created", share.status === 201 && !!share.data.token, `HTTP ${share.status}`);
    const token = share.data.token;

    const preview = await call("GET", `/api/share/${token}`);
    check(
      "recipient can preview without an account",
      preview.status === 200 && preview.data.eventSlug === bought.slug,
      `HTTP ${preview.status}`,
    );

    // Before the claim the sender's ticket must still work — nothing has moved.
    const beforeOptions = await call("GET", `/api/tickets/${senderTicket.id}/options`, { token: custToken });
    check(
      "ticket still VALID while link is unclaimed",
      beforeOptions.data.status === "VALID" && beforeOptions.data.share?.token === token,
      `status=${beforeOptions.data.status}`,
    );

    const claim = await call("POST", `/api/share/${token}/claim`, {
      body: { holderName: "Amine Recipient" },
    });
    check("recipient claims it", claim.status === 201 && !!claim.data.ref, `HTTP ${claim.status}`);
    const newTicketId = claim.data.ticketId;

    check(
      "replacement has a DIFFERENT ref",
      claim.data.ref !== senderTicket.ref,
      `${senderTicket.ref} -> ${claim.data.ref}`,
    );

    // THE test. Old QR must be refused; new QR must be admitted.
    const oldScan = await scanSigned(orgToken, senderTicket.id, { token: custToken });
    check(
      "sender's QR is REFUSED at the gate (moved)",
      oldScan.status === 409 && oldScan.data.result === "moved",
      `HTTP ${oldScan.status} result=${oldScan.data.result}`,
    );

    const newScan = await scanSigned(orgToken, newTicketId, { key: claim.data.accessToken });
    check(
      "recipient's QR is ADMITTED at the gate",
      newScan.status === 200 && newScan.data.result === "ok",
      `HTTP ${newScan.status} result=${newScan.data.result}`,
    );

    // The link is single-use.
    const reclaim = await call("POST", `/api/share/${token}/claim`, {
      body: { holderName: "Second Taker" },
    });
    check("a claimed link cannot be reused", reclaim.status === 410, `HTTP ${reclaim.status}`);
  }

  // 2. Concurrency: one seat, one winner
  console.log("\n\x1b[1mTwo claimants, one ticket\x1b[0m");
  {
    const bought = await buyTickets(orgToken, custToken, 1, `b${Date.now()}`);
    cleanup.push(bought.slug);
    const share = await call("POST", "/api/share", {
      token: custToken,
      body: { ticketId: bought.tickets[0].id },
    });
    const token = share.data.token;

    const racers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call("POST", `/api/share/${token}/claim`, { body: { holderName: `Racer ${i} Test` } }),
      ),
    );
    const won = racers.filter((r) => r.status === 201);
    check(
      "exactly one claimant wins",
      won.length === 1,
      `${won.length} of 5 succeeded (${racers.map((r) => r.status).join(",")})`,
    );

    // And only one new ticket exists, so the seat is not counted twice.
    const order = await call("GET", `/api/orders/${bought.orderId}`, { token: custToken });
    const valid = order.data.order.tickets.filter((t) => t.status === "VALID");
    check("only one VALID ticket remains on the order", valid.length === 1, `${valid.length} valid`);
  }

  // 3. Revocation and guards
  console.log("\n\x1b[1mRevocation and guards\x1b[0m");
  {
    const bought = await buyTickets(orgToken, custToken, 2, `c${Date.now()}`);
    cleanup.push(bought.slug);
    const [first, second] = bought.tickets;

    const share = await call("POST", "/api/share", { token: custToken, body: { ticketId: first.id } });
    const token = share.data.token;

    const dup = await call("POST", "/api/share", { token: custToken, body: { ticketId: first.id } });
    check("a second open link is refused", dup.status === 409, `HTTP ${dup.status}`);

    const revoke = await call("DELETE", `/api/share/${share.data.id}`, { token: custToken });
    check("sender can revoke", revoke.status === 204, `HTTP ${revoke.status}`);

    const afterRevoke = await call("POST", `/api/share/${token}/claim`, {
      body: { holderName: "Too Late" },
    });
    check("a revoked link cannot be claimed", afterRevoke.status === 410, `HTTP ${afterRevoke.status}`);

    const stillValid = await scanSigned(orgToken, first.id, { token: custToken });
    check(
      "revoking leaves the sender's ticket working",
      stillValid.status === 200 && stillValid.data.result === "ok",
      `result=${stillValid.data.result}`,
    );

    // Someone else's ticket is not yours to share.
    const notYours = await call("POST", "/api/share", { token: orgToken, body: { ticketId: second.id } });
    check("cannot share a ticket you don't hold", notYours.status === 403, `HTTP ${notYours.status}`);

    // A used ticket cannot be given away.
    await scanSigned(orgToken, second.id, { token: custToken });
    const usedShare = await call("POST", "/api/share", { token: custToken, body: { ticketId: second.id } });
    check("cannot share a used ticket", usedShare.status === 409, `HTTP ${usedShare.status}`);
  }

  // Cleanup. Orders go first: Order -> Event is onDelete Restrict, so an
  // event with a paid order against it refuses to delete. The event delete
  // route keys on SLUG, not id.
  const allOrders = await call("GET", "/api/organiser/orders", { token: orgToken });
  for (const order of allOrders.data?.orders ?? []) {
    if (cleanup.includes(order.eventSlug)) {
      await call("DELETE", `/api/organiser/orders/${order.id}`, { token: orgToken });
    }
  }
  let removed = 0;
  for (const slug of cleanup) {
    const del = await call("DELETE", `/api/organiser/events/${slug}`, { token: orgToken });
    if (del.status === 204) removed++;
    else console.log(`  cleanup: ${slug} -> HTTP ${del.status} ${JSON.stringify(del.data)}`);
  }
  check("test data cleaned up", removed === cleanup.length, `${removed}/${cleanup.length} events removed`);

  console.log(failures === 0 ? "\n\x1b[32mAll share checks passed\x1b[0m" : `\n\x1b[31m${failures} FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  process.exit(1);
});
