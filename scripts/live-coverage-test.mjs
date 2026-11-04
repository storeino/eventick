/**
 * Live API test — the routes live-api-test.mjs never reaches.
 *
 * Auditing the 61 mounted routes against the existing suite found 16 with no
 * live coverage at all: the whole resale flow, tier CRUD, organiser-side
 * ticket admin, buyer self-service, and the waitlist claim lookup. Those are
 * exactly the paths that move money or seats, so "it compiles" is not enough.
 *
 * Each route is checked for what it should DO and what it should REFUSE —
 * an endpoint that returns 200 to its owner and 200 to everyone else is
 * broken, so the guards are asserted alongside the happy path.
 *
 * Creates its own event, orders and tickets, and removes them at the end.
 */

const API = process.env.API ?? "http://localhost:4100";

const ACCOUNTS = {
  admin: { email: "admin@eventick.ma", password: "eventick-admin-2026" },
  organiser: { email: "organisateur@eventick.ma", password: "eventick-orga-2026" },
  customer: { email: "client@eventick.ma", password: "eventick-client-2026" },
};

const results = [];
let group = "";

function setGroup(name) {
  group = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function record(label, pass, detail) {
  results.push({ group, label, pass });
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

/** Assert the status, and return the response so the caller can dig in. */
async function expectStatus(label, method, path, want, options) {
  const res = await call(method, path, options);
  const wanted = Array.isArray(want) ? want : [want];
  record(label, wanted.includes(res.status), `${res.status}${wanted.includes(res.status) ? "" : ` (want ${wanted.join("/")})`}`);
  return res;
}

async function login(account) {
  const res = await call("POST", "/api/auth/login", { body: account });
  if (res.status !== 200) throw new Error(`login failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data.token;
}

const tierBody = (over = {}) => ({
  nameFr: "Standard",
  nameAr: "عادي",
  blurbFr: "Place debout",
  blurbAr: "مكان واقف",
  priceCents: 20000,
  capacity: 10,
  zoneFr: "A",
  zoneAr: "أ",
  gateFr: "1",
  gateAr: "1",
  ...over,
});

/** A published event owned by the organiser account. */
async function makeEvent(orgToken, suffix, tiers) {
  const slug = `cov-test-${suffix}`;
  const start = new Date(Date.now() + 30 * 86_400_000);
  const res = await call("POST", "/api/organiser/events", {
    token: orgToken,
    body: {
      slug,
      // maxPerBuyer 0 — see live-api-test: repeated purchases as one email.
      maxPerBuyer: 0,
      // Resale is opt-in per event now, and this suite tests resale — so the
      // event it creates has to enable it, exactly as a real organiser would.
      allowResale: true,
      titleFr: "Couverture API",
      titleAr: "تغطية API",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle test",
      venueAr: "قاعة",
      address: "1 rue du test",
      start: start.toISOString(),
      end: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      doors: new Date(start.getTime() - 3_600_000).toISOString(),
      image: "https://example.com/a.jpg",
      blurbFr: "Test",
      blurbAr: "تجربة",
      aboutFr: "Test",
      aboutAr: "تجربة",
      ageFr: "18+",
      ageAr: "+18",
      tiers,
    },
  });
  if (res.status !== 201) throw new Error(`event create (${res.status}): ${JSON.stringify(res.data)}`);
  return { slug, event: res.data.event };
}

/** A PAID order of `qty` tickets on `tierId`, as the given caller. */
async function buy(token, slug, tierId, qty, name = "Client Test") {
  const hold = await call("POST", "/api/orders/hold", {
    token,
    body: { eventSlug: slug, lines: [{ tierId, qty }] },
  });
  if (hold.status !== 201) throw new Error(`hold (${hold.status}): ${JSON.stringify(hold.data)}`);
  const orderId = hold.data.order.id;
  const pay = await call("POST", `/api/orders/${orderId}/pay`, {
    token,
    body: { holderName: name, email: "client@eventick.ma", phone: "0612345678" },
  });
  if (pay.status !== 200) throw new Error(`pay (${pay.status}): ${JSON.stringify(pay.data)}`);
  const order = await call("GET", `/api/orders/${orderId}`, { token });
  return { orderId, tickets: order.data.order.tickets };
}

async function main() {
  const tokens = {
    admin: await login(ACCOUNTS.admin),
    organiser: await login(ACCOUNTS.organiser),
    customer: await login(ACCOUNTS.customer),
  };
  const slugs = [];

  // ───────────────────────────────────────────── organiser tier CRUD ──
  setGroup("TIERS  /api/organiser/{events/:slug/tiers, tiers/:id}");
  {
    const { slug, event } = await makeEvent(tokens.organiser, `tiers${Date.now()}`, [tierBody()]);
    slugs.push(slug);
    const firstTierId = event.tiers[0].id;

    const list = await expectStatus("GET tiers as owner", "GET", `/api/organiser/events/${slug}/tiers`, 200, {
      token: tokens.organiser,
    });
    record(
      "listed tier reports sold and remaining",
      list.data?.tiers?.[0]?.sold === 0 && list.data.tiers[0].remaining === 10,
      `sold=${list.data?.tiers?.[0]?.sold} remaining=${list.data?.tiers?.[0]?.remaining}`,
    );

    await expectStatus("GET tiers anonymous → 401", "GET", `/api/organiser/events/${slug}/tiers`, 401);
    await expectStatus("GET tiers as CUSTOMER → 403", "GET", `/api/organiser/events/${slug}/tiers`, 403, {
      token: tokens.customer,
    });

    const added = await expectStatus("POST adds a tier", "POST", `/api/organiser/events/${slug}/tiers`, 201, {
      token: tokens.organiser,
      body: tierBody({ nameFr: "VIP", priceCents: 50000, capacity: 4, zoneFr: "VIP" }),
    });
    const vipId = added.data?.tier?.id;

    await expectStatus("POST a tier with no name → 400", "POST", `/api/organiser/events/${slug}/tiers`, 400, {
      token: tokens.organiser,
      body: { priceCents: 1000 },
    });

    const patched = await expectStatus("PATCH renames and reprices a tier", "PATCH", `/api/organiser/tiers/${vipId}`, 200, {
      token: tokens.organiser,
      body: { nameFr: "Carré Or", priceCents: 60000 },
    });
    record(
      "PATCH actually persisted the change",
      patched.data?.tier?.nameFr === "Carré Or" && patched.data.tier.priceCents === 60000,
      `${patched.data?.tier?.nameFr} / ${patched.data?.tier?.priceCents}`,
    );

    await expectStatus("PATCH an unknown tier → 404", "PATCH", "/api/organiser/tiers/nope-xyz", 404, {
      token: tokens.organiser,
      body: { priceCents: 1 },
    });

    // Capacity must not shrink below what is already held.
    const sold = await buy(tokens.customer, slug, firstTierId, 2);
    await expectStatus("PATCH capacity below seats sold → 409", "PATCH", `/api/organiser/tiers/${firstTierId}`, 409, {
      token: tokens.organiser,
      body: { capacity: 1 },
    });
    await expectStatus("PATCH capacity above seats sold is allowed", "PATCH", `/api/organiser/tiers/${firstTierId}`, 200, {
      token: tokens.organiser,
      body: { capacity: 12 },
    });

    await expectStatus("DELETE a tier with tickets sold → 409", "DELETE", `/api/organiser/tiers/${firstTierId}`, 409, {
      token: tokens.organiser,
    });
    await expectStatus("DELETE an empty tier", "DELETE", `/api/organiser/tiers/${vipId}`, 204, {
      token: tokens.organiser,
    });
    await expectStatus("DELETE the last remaining tier → 409", "DELETE", `/api/organiser/tiers/${firstTierId}`, 409, {
      token: tokens.organiser,
    });

    // Keep the sold tickets reachable for the next group.
    globalThis.__soldOrder = sold;
    globalThis.__soldSlug = slug;
  }

  // ──────────────────────────────── organiser-side ticket management ──
  setGroup("ORGANISER TICKETS  /api/organiser/tickets/:id/{reissue, holder}");
  {
    const slug = globalThis.__soldSlug;
    const [ticketA, ticketB] = globalThis.__soldOrder.tickets;

    const reissued = await expectStatus(
      "POST reissue returns a fresh ref",
      "POST",
      `/api/organiser/tickets/${ticketA.id}/reissue`,
      201,
      { token: tokens.organiser },
    );
    record(
      "reissue reports the ref it replaced",
      reissued.data?.ref && reissued.data.previousRef === ticketA.ref && reissued.data.ref !== ticketA.ref,
      `${reissued.data?.previousRef} -> ${reissued.data?.ref}`,
    );

    // The point of a reissue: the old QR must stop admitting.
    const oldScan = await call("POST", "/api/gate/check-in", {
      token: tokens.organiser,
      body: { ref: ticketA.ref, source: "manual" },
    });
    record(
      "the reissued-away ticket no longer admits",
      oldScan.status === 409 && oldScan.data?.result === "cancelled",
      `${oldScan.status} result=${oldScan.data?.result}`,
    );
    const newScan = await call("POST", "/api/gate/check-in", {
      token: tokens.organiser,
      body: { ref: reissued.data?.ref, source: "manual" },
    });
    record(
      "the replacement admits",
      newScan.status === 200 && newScan.data?.result === "ok",
      `${newScan.status} result=${newScan.data?.result}`,
    );

    await expectStatus("reissue as CUSTOMER → 403", "POST", `/api/organiser/tickets/${ticketB.id}/reissue`, 403, {
      token: tokens.customer,
    });
    await expectStatus("reissue an unknown ticket → 404", "POST", "/api/organiser/tickets/nope-xyz/reissue", 404, {
      token: tokens.organiser,
    });

    const renamed = await expectStatus(
      "PATCH holder corrects the name",
      "PATCH",
      `/api/organiser/tickets/${ticketB.id}/holder`,
      200,
      { token: tokens.organiser, body: { holderName: "Nom Corrigé" } },
    );
    record("PATCH holder reports ok", renamed.data?.ok === true, JSON.stringify(renamed.data));
    // Reading a ticket takes proof of purchase, so present the buyer's
    // session: this route serves the signed QR, not just a holder name.
    const after = await call("GET", `/api/tickets/${ticketB.id}`, { token: tokens.customer });
    record(
      "the corrected name is what the ticket now shows",
      after.data?.ticket?.holderName === "Nom Corrigé",
      after.data?.ticket?.holderName,
    );

    await expectStatus("PATCH holder with a 1-char name → 400", "PATCH", `/api/organiser/tickets/${ticketB.id}/holder`, 400, {
      token: tokens.organiser,
      body: { holderName: "x" },
    });
    await expectStatus("PATCH holder as CUSTOMER → 403", "PATCH", `/api/organiser/tickets/${ticketB.id}/holder`, 403, {
      token: tokens.customer,
      body: { holderName: "Pirate Name" },
    });

    void slug;
  }

  // ────────────────────────────────────── buyer-side self-service ──
  setGroup("BUYER TICKETS  /api/tickets/:id/{exchange, holder}");
  {
    const { slug, event } = await makeEvent(tokens.organiser, `buyer${Date.now()}`, [
      tierBody({ nameFr: "Gradin", priceCents: 20000, capacity: 10, zoneFr: "G" }),
      tierBody({ nameFr: "Fosse", priceCents: 40000, capacity: 10, zoneFr: "F" }),
      tierBody({ nameFr: "Balcon", priceCents: 10000, capacity: 10, zoneFr: "B" }),
    ]);
    slugs.push(slug);
    const byName = Object.fromEntries(event.tiers.map((t) => [t.nameFr, t.id]));

    const order = await buy(tokens.customer, slug, byName.Gradin, 3, "Acheteur Test");
    const [t1, t2, t3] = order.tickets;

    // Rename
    const ren = await expectStatus("PATCH own holder name", "PATCH", `/api/tickets/${t1.id}/holder`, 200, {
      token: tokens.customer,
      body: { holderName: "Nouveau Nom" },
    });
    record("rename reports ok", ren.data?.ok === true, JSON.stringify(ren.data));

    // Exchange — downgrade is free, upgrade owes money and must be refused.
    const down = await expectStatus("POST exchange to a cheaper zone", "POST", `/api/tickets/${t1.id}/exchange`, 200, {
      token: tokens.customer,
      body: { tierId: byName.Balcon },
    });
    record("exchange returns the new ticket state", !!down.data, JSON.stringify(down.data).slice(0, 80));

    /*
     * The forfeit the UI warns about has to be real. A downgrade moves the
     * seat and keeps the charge: if the order silently shrank, the dialog
     * telling the holder they lose the difference would be a lie, and the
     * organiser's payout would be short.
     */
    const afterDown = await call("GET", `/api/orders/${order.orderId}`, { token: tokens.customer });
    record(
      "a downgrade refunds nothing — the order still shows what was paid",
      afterDown.data?.order?.totalCents === 3 * 20000 && (afterDown.data?.order?.refundedCents ?? 0) === 0,
      `total=${afterDown.data?.order?.totalCents} refunded=${afterDown.data?.order?.refundedCents ?? 0}`,
    );

    // The amounts the screen prints, next to the zone it would move to.
    const quoted = await call("GET", `/api/tickets/${t2.id}/options`, { token: tokens.customer });
    const zq = Object.fromEntries((quoted.data?.exchange ?? []).map((z) => [z.nameFr, z]));
    record(
      "options quote the exact forfeit and the exact upgrade fee",
      zq.Balcon?.forfeitCents === 10000 && zq.Balcon?.dueCents === 0 &&
        zq.Fosse?.dueCents === 20000 && zq.Fosse?.forfeitCents === 0,
      `Balcon -${zq.Balcon?.forfeitCents} / Fosse +${zq.Fosse?.dueCents}`,
    );

    await expectStatus("POST exchange to a dearer zone → 402", "POST", `/api/tickets/${t2.id}/exchange`, 402, {
      token: tokens.customer,
      body: { tierId: byName.Fosse },
    });
    await expectStatus("POST exchange to an unknown zone → 404", "POST", `/api/tickets/${t2.id}/exchange`, 404, {
      token: tokens.customer,
      body: { tierId: "nope-xyz" },
    });

    /*
     * A FULL zone refuses on capacity.
     *
     * The destination here is deliberately the CHEAPER one. Testing this
     * against a dearer zone proves nothing: 402 (upgrade owes money) fires
     * before the capacity check is ever reached, so a broken sold-out guard
     * would still look like a pass. On a downgrade nothing is owed, which
     * leaves 409 as the only thing that can refuse it.
     */
    const { slug: fullSlug, event: fullEvent } = await makeEvent(tokens.organiser, `exfull${Date.now()}`, [
      tierBody({ nameFr: "Petit", priceCents: 10000, capacity: 1, zoneFr: "P" }),
      tierBody({ nameFr: "Grand", priceCents: 20000, capacity: 5, zoneFr: "R" }),
    ]);
    slugs.push(fullSlug);
    const fullByName = Object.fromEntries(fullEvent.tiers.map((x) => [x.nameFr, x.id]));
    await buy(tokens.customer, fullSlug, fullByName.Petit, 1, "Remplit");   // Petit now 0 left
    const mover = await buy(tokens.customer, fullSlug, fullByName.Grand, 1, "Bouge");
    const moverId = mover.tickets[0].id;

    const fullOpts = await call("GET", `/api/tickets/${moverId}/options`, { token: tokens.customer });
    const petit = (fullOpts.data?.exchange ?? []).find((z) => z.nameFr === "Petit");
    record("options flag the full zone as soldOut", petit?.soldOut === true, `soldOut=${petit?.soldOut}`);
    record("and it is a downgrade, so price cannot be the refusal", petit?.dueCents === 0, `due=${petit?.dueCents}`);

    await expectStatus("POST exchange into a full cheaper zone → 409", "POST", `/api/tickets/${moverId}/exchange`, 409, {
      token: tokens.customer,
      body: { tierId: fullByName.Petit },
    });
    const moverAfter = await call("GET", `/api/tickets/${moverId}`, { token: tokens.customer });
    record("the refused ticket stayed in its own zone", moverAfter.data?.tier?.nameFr === "Grand", `${moverAfter.data?.tier?.nameFr}`);

    // State is checked before price: a used ticket is 409, not 402.
    await call("POST", "/api/gate/check-in", {
      token: tokens.organiser,
      body: { ref: t3.ref, source: "manual" },
    });
    await expectStatus("POST exchange a USED ticket → 409 (state before price)", "POST", `/api/tickets/${t3.id}/exchange`, 409, {
      token: tokens.customer,
      body: { tierId: byName.Fosse },
    });

    // Self-cancellation was REMOVED when tickets became final sale: it
    // would have taken the seat and kept the money. Asserted as absent so
    // a re-introduction fails here rather than quietly costing a buyer.
    await expectStatus("POST own cancel → 404 (route removed)", "POST", `/api/tickets/${t2.id}/cancel`, 404, {
      token: tokens.customer,
    });
    const t2After = await call("GET", `/api/tickets/${t2.id}`, { token: tokens.customer });
    record("the ticket survived the attempt", t2After.data?.ticket?.status === "VALID", `${t2After.data?.ticket?.status}`);

    // Someone else's ticket is not yours to touch.
    await expectStatus("PATCH holder of another account's ticket → 403", "PATCH", `/api/tickets/${t1.id}/holder`, 403, {
      token: tokens.organiser,
      body: { holderName: "Pirate Name" },
    });

  }

  setGroup("VENUE PLAN  the site plan is the event's own");
  {
    /*
     * The plan used to be three hardcoded shapes on every event. It is now
     * drawn from venueKind plus the event's real tiers, so the two things
     * worth asserting are that the field round-trips and that it reaches the
     * public page -- a shape the buyer page cannot read is no plan at all.
     */
    const { slug, event } = await makeEvent(tokens.organiser, `venue${Date.now()}`, [
      tierBody({ nameFr: "Tribune", priceCents: 30000, capacity: 4, zoneFr: "T" }),
      tierBody({ nameFr: "Virage", priceCents: 10000, capacity: 6, zoneFr: "V" }),
    ]);
    slugs.push(slug);

    record("a new event defaults to STAGE", event.venueKind === "STAGE", `${event.venueKind}`);

    const set = await expectStatus("PATCH venueKind", "PATCH", `/api/organiser/events/${slug}`, 200, {
      token: tokens.organiser,
      body: { venueKind: "STADIUM" },
    });
    record("the change is stored", set.data?.event?.venueKind === "STADIUM", `${set.data?.event?.venueKind}`);

    const pub = await call("GET", `/api/events/${slug}`);
    record(
      "the public page is told the shape AND the zones",
      pub.data?.event?.venueKind === "STADIUM" && (pub.data?.event?.tiers ?? []).length === 2,
      `${pub.data?.event?.venueKind} / ${(pub.data?.event?.tiers ?? []).length} tier(s)`,
    );

    await expectStatus("an unknown shape is refused", "PATCH", `/api/organiser/events/${slug}`, 400, {
      token: tokens.organiser,
      body: { venueKind: "CATHEDRAL" },
    });

    /*
     * A tier that is not a PLACE.
     *
     * "Pass 3 jours" and "Pass journée" admit you to the same ground on
     * different days; drawing them as stacked zones said the three-day pass
     * stands nearer the stage. The flag is what lets an organiser say so,
     * and the page reads it to decide between drawing and listing.
     */
    const tier = event.tiers[1];
    record("a tier is a place by default", tier.spatial === true, `${tier.spatial}`);

    const flagged = await expectStatus("PATCH spatial=false", "PATCH", `/api/organiser/tiers/${tier.id}`, 200, {
      token: tokens.organiser,
      body: { spatial: false },
    });
    record("the flag is stored", flagged.status === 200, `${flagged.status}`);

    const after = await call("GET", `/api/events/${slug}`);
    const shaped = (after.data?.event?.tiers ?? []).find((x) => x.id === tier.id);
    record("and the public page can tell the two apart", shaped?.spatial === false, `${shaped?.spatial}`);
    record(
      "while the other tier is still a place",
      (after.data?.event?.tiers ?? []).some((x) => x.id !== tier.id && x.spatial === true),
      "yes",
    );

    /*
     * Position beats price.
     *
     * Price was the only ordering, and it is wrong exactly where it matters:
     * on derby-casa the dear side Loge came out nearer the pitch than the
     * cheaper Tribune Honneur, which is not that stadium. planOrder is how
     * an organiser says what the room is actually like.
     */
    const cheap = event.tiers.find((x) => x.id !== tier.id);
    record("a tier has no position by default", cheap.planOrder === null, `${cheap.planOrder}`);

    await expectStatus("PATCH planOrder", "PATCH", `/api/organiser/tiers/${cheap.id}`, 200, {
      token: tokens.organiser,
      body: { planOrder: 0 },
    });
    const ordered = await call("GET", `/api/events/${slug}`);
    const placed = (ordered.data?.event?.tiers ?? []).find((x) => x.id === cheap.id);
    record("the position reaches the public page", placed?.planOrder === 0, `${placed?.planOrder}`);

    await expectStatus("clearing it is allowed", "PATCH", `/api/organiser/tiers/${cheap.id}`, 200, {
      token: tokens.organiser,
      body: { planOrder: null },
    });
    const cleared = await call("GET", `/api/events/${slug}`);
    record(
      "and null means fall back to price",
      (cleared.data?.event?.tiers ?? []).find((x) => x.id === cheap.id)?.planOrder === null,
      "null",
    );
    await expectStatus("a negative position is refused", "PATCH", `/api/organiser/tiers/${cheap.id}`, 400, {
      token: tokens.organiser,
      body: { planOrder: -1 },
    });

    /*
     * Sold-out shading reads `remaining` straight off the public payload,
     * so what matters is that the figure is there and goes to 0 when the
     * zone fills. A plan that greys the wrong zone is worse than one that
     * greys none.
     */
    const before = (await call("GET", `/api/events/${slug}`)).data?.event?.tiers ?? [];
    const target = before.find((x) => x.id === cheap.id);
    record("the plan is told what is left", typeof target?.remaining === "number", `${target?.remaining}`);

    await buy(tokens.customer, slug, cheap.id, target.remaining, "Vide La Zone");
    const emptied = (await call("GET", `/api/events/${slug}`)).data?.event?.tiers ?? [];
    const gone = emptied.find((x) => x.id === cheap.id);
    record("a filled zone reports 0 left", gone?.remaining === 0, `${gone?.remaining}`);
    record(
      "and the others are untouched",
      emptied.some((x) => x.id !== cheap.id && x.remaining > 0),
      "yes",
    );

    /*
     * Blocks are sized by capacity, so the figure has to be on the public
     * payload for every tier — including one with none left. A zone that
     * sold out must still be DRAWN at its real size, greyed; dropping its
     * capacity would shrink it as it sold, which is not how a venue works.
     */
    record(
      "every zone carries the capacity the drawing is sized from",
      (emptied ?? []).every((x) => typeof x.capacity === "number" && x.capacity > 0),
      `${emptied.length} tier(s)`,
    );
    record(
      "a sold-out zone keeps its capacity",
      gone?.capacity > 0 && gone?.remaining === 0,
      `cap=${gone?.capacity} left=${gone?.remaining}`,
    );
  }
  // ─────────────────────────────────────────────────────────── resale ──
  setGroup("RESALE  /api/resale/*");
  {
    const { slug, event } = await makeEvent(tokens.organiser, `resale${Date.now()}`, [tierBody({ capacity: 5 })]);
    slugs.push(slug);
    const tierId = event.tiers[0].id;

    const seller = await buy(tokens.customer, slug, tierId, 2, "Vendeur Test");
    const [forSale, keep] = seller.tickets;

    const listed = await expectStatus("POST listings puts a ticket up", "POST", "/api/resale/listings", 201, {
      token: tokens.customer,
      body: { ticketId: forSale.id },
    });
    record(
      "listing price is face value, not a parameter",
      listed.data?.priceCents === 20000 && listed.data.status === "LISTED",
      `${listed.data?.priceCents} ${listed.data?.status}`,
    );
    const token = listed.data?.token;

    await expectStatus("listing the same ticket twice → 409", "POST", "/api/resale/listings", 409, {
      token: tokens.customer,
      body: { ticketId: forSale.id },
    });
    await expectStatus("listing someone else's ticket → 403", "POST", "/api/resale/listings", 403, {
      token: tokens.organiser,
      body: { ticketId: keep.id },
    });

    const mine = await expectStatus("GET mine/listings as the seller", "GET", "/api/resale/mine/listings", 200, {
      token: tokens.customer,
    });
    record(
      "the seller's own listing appears",
      (mine.data?.listings ?? []).some((l) => l.token === token),
      `${mine.data?.listings?.length} listing(s)`,
    );
    await expectStatus("GET mine/listings anonymous → 401", "GET", "/api/resale/mine/listings", 401);

    /*
     * Discovery: the two routes that let a stranger FIND a listing rather
     * than be sent its link.
     *
     * Both hide listings whose zone still has seats, which is the whole
     * design: a resale is at face value, so showing one beside inventory the
     * organiser can still sell takes a sale he would have made anyway. This
     * zone has 5 seats and 2 sold, so the listing must NOT appear yet.
     */
    const marketBefore = await expectStatus("GET /events/resales/all is public", "GET", "/api/events/resales/all", 200);
    record(
      "a listing on a zone with seats left is hidden",
      !(marketBefore.data?.resales ?? []).some((r) => r.token === token),
      `${(marketBefore.data?.resales ?? []).length} listing(s) shown`,
    );
    const onEventBefore = await expectStatus("GET /events/:slug/resales is public", "GET", `/api/events/${slug}/resales`, 200);
    record(
      "and the event page hides it too",
      (onEventBefore.data?.resales ?? []).length === 0,
      `${(onEventBefore.data?.resales ?? []).length} shown`,
    );

    // Sell the zone out: 5 capacity, 2 already sold, so 3 more closes it.
    await buy(tokens.customer, slug, tierId, 3, "Remplit La Zone");

    const marketAfter = await expectStatus("the marketplace lists it once the zone sells out", "GET", "/api/events/resales/all", 200);
    const row = (marketAfter.data?.resales ?? []).find((r) => r.token === token);
    record("the listing is now discoverable", Boolean(row), row ? "listed" : "absent");
    record(
      "and carries what the page renders",
      row?.priceCents === 20000 && row?.event?.slug === slug && typeof row?.event?.start === "string",
      `${row?.priceCents} ${row?.event?.slug}`,
    );
    const onEventAfter = await call("GET", `/api/events/${slug}/resales`, {});
    record(
      "the event page shows it too",
      (onEventAfter.data?.resales ?? []).some((r) => r.token === token),
      `${(onEventAfter.data?.resales ?? []).length} shown`,
    );

    /*
     * The organiser's own view of resale activity on their events.
     *
     * Scoped by ownership, like every other list on that router: an
     * organiser who can see another organiser's resales can see which of
     * their shows are being dumped and at what rate.
     */
    const orgView = await expectStatus("GET /organiser/resales as the owner", "GET", "/api/organiser/resales", 200, {
      token: tokens.organiser,
    });
    const orgRow = (orgView.data?.resales ?? []).find((r) => r.eventSlug === slug);
    record("the owner sees the listing on their event", Boolean(orgRow), orgRow ? orgRow.status : "absent");
    record(
      "and it carries what the table renders",
      orgRow?.priceCents === 20000 && typeof orgRow?.ticketRef === "string" && typeof orgRow?.createdAt === "string",
      `${orgRow?.priceCents} ${orgRow?.ticketRef}`,
    );
    record(
      "but never the buyer's identity",
      orgRow !== undefined && !("buyerEmail" in orgRow) && !("buyerName" in orgRow) && !("email" in orgRow),
      Object.keys(orgRow ?? {}).join(","),
    );
    /*
     * The check that actually catches a scope regression.
     *
     * "The owner sees their own" passes just as well with a broken filter,
     * because every seeded event belongs to one organiser -- so a list that
     * returned EVERYTHING would look identical. This builds a SECOND
     * organiser with their own event and listing, and asserts each side of
     * the boundary: the admin sees both, neither organiser sees the other.
     */
    const otherEmail = `cov-org2-${Date.now()}@example.com`;
    const reg = await call("POST", "/api/auth/register", {
      body: { name: "Organiser Two", email: otherEmail, password: "cov-org2-2026" },
    });
    const otherToken = reg.data?.token;
    await call("PATCH", `/api/auth/users/${reg.data?.user?.id}/role`, {
      token: tokens.admin,
      body: { role: "ORGANISER" },
    });

    const { slug: otherSlug, event: otherEvent } = await makeEvent(otherToken, `org2${Date.now()}`, [
      tierBody({ capacity: 2 }),
    ]);
    slugs.push(otherSlug);
    const otherBuy = await buy(tokens.customer, otherSlug, otherEvent.tiers[0].id, 1, "Acheteur Deux");
    const otherListed = await call("POST", "/api/resale/listings", {
      token: tokens.customer,
      body: { ticketId: otherBuy.tickets[0].id },
    });
    record("(setup) the second organiser has a listing too", otherListed.status === 201, `${otherListed.status}`);

    const asOwner = await call("GET", "/api/organiser/resales", { token: tokens.organiser });
    const ownerSlugs = new Set((asOwner.data?.resales ?? []).map((r) => r.eventSlug));
    record(
      "an organiser does NOT see another organiser's resales",
      ownerSlugs.has(slug) && !ownerSlugs.has(otherSlug),
      `own=${ownerSlugs.has(slug)} other=${ownerSlugs.has(otherSlug)}`,
    );

    const asOther = await call("GET", "/api/organiser/resales", { token: otherToken });
    const otherSeen = new Set((asOther.data?.resales ?? []).map((r) => r.eventSlug));
    record(
      "and the boundary holds from the other side",
      otherSeen.has(otherSlug) && !otherSeen.has(slug),
      `own=${otherSeen.has(otherSlug)} other=${otherSeen.has(slug)}`,
    );

    const asAdmin = await call("GET", "/api/organiser/resales", { token: tokens.admin });
    const adminSlugs = new Set((asAdmin.data?.resales ?? []).map((r) => r.eventSlug));
    record(
      "an ADMIN sees both — scope.any is what lifts the filter",
      adminSlugs.has(slug) && adminSlugs.has(otherSlug),
      `${adminSlugs.has(slug)} + ${adminSlugs.has(otherSlug)}`,
    );

    /*
     * Whose event it is, for the admin only.
     *
     * A list spanning several organisers is unreadable without the owner's
     * name; an organiser's own list would carry their own name on every row,
     * which is noise. So the field is present for one and absent for the
     * other, and both halves are asserted — a column that leaked to every
     * caller would still pass a test that only checked the admin.
     */
    const adminRow = (asAdmin.data?.resales ?? []).find((r) => r.eventSlug === otherSlug);
    record(
      "the admin is told whose event it is",
      typeof adminRow?.organiser?.name === "string" && typeof adminRow?.organiser?.email === "string",
      `${adminRow?.organiser?.name ?? "absent"}`,
    );
    const ownRow = (asOwner.data?.resales ?? []).find((r) => r.eventSlug === slug);
    record(
      "an organiser is not — every row would be their own name",
      ownRow !== undefined && ownRow.organiser === undefined,
      ownRow?.organiser === undefined ? "absent" : JSON.stringify(ownRow.organiser),
    );

    await expectStatus("GET /organiser/resales as a CUSTOMER → 403", "GET", "/api/organiser/resales", 403, {
      token: tokens.customer,
    });
    await expectStatus("GET /organiser/resales anonymous → 401", "GET", "/api/organiser/resales", 401);

    /*
     * Staff sell rather than buy.
     *
     * An ORGANISER holding seats on a rival's sold-out show, or an ADMIN
     * who can see every order buying into an event they moderate, is the
     * conflict refuseStaffPurchase exists to stop. It guards the ordinary
     * checkout AND this one -- a rule enforced on one of two doors is not
     * enforced. Untested until now, on either door.
     */
    await expectStatus("an ORGANISER cannot buy a resold seat", "POST", `/api/resale/${token}/buy`, 403, {
      token: tokens.organiser,
      body: { holderName: "Staff Test", email: "organisateur@eventick.ma", phone: "0612345678" },
    });
    await expectStatus("nor an ADMIN", "POST", `/api/resale/${token}/buy`, 403, {
      token: tokens.admin,
      body: { holderName: "Staff Test", email: "admin@eventick.ma", phone: "0612345678" },
    });
    await expectStatus("and the ordinary checkout refuses them too", "POST", "/api/orders/hold", 403, {
      token: tokens.organiser,
      body: { eventSlug: slug, lines: [{ tierId, qty: 1 }] },
    });
    record(
      "the listing survived all three refusals",
      (await call("GET", `/api/resale/${token}`, {})).data?.priceCents === 20000,
      "still on sale",
    );

    const offer = await expectStatus("GET /:token is public", "GET", `/api/resale/${token}`, 200);
    record(
      "the offer names the event and price",
      offer.data?.eventSlug === slug && offer.data.priceCents === 20000,
      `${offer.data?.eventSlug} ${offer.data?.priceCents}`,
    );
    await expectStatus("GET an unknown token → 410", "GET", "/api/resale/nope-xyz", 410);

    await expectStatus("buy with a bad phone → 400", "POST", `/api/resale/${token}/buy`, 400, {
      token: tokens.customer,
      body: { holderName: "Acheteur Resale", email: "buyer@example.com", phone: "123" },
    });

    const bought = await expectStatus("POST /:token/buy completes the sale", "POST", `/api/resale/${token}/buy`, 200, {
      token: tokens.customer,
      body: { holderName: "Acheteur Resale", email: "buyer@example.com", phone: "0612345678" },
    });
    record(
      "the buyer gets a NEW ref, not the seller's",
      bought.data?.newRef && bought.data.newRef !== forSale.ref,
      `${forSale.ref} -> ${bought.data?.newRef}`,
    );

    // The decisive property: one seat, one working QR.
    const sellerScan = await call("POST", "/api/gate/check-in", {
      token: tokens.organiser,
      body: { ref: forSale.ref, source: "manual" },
    });
    record(
      "the seller's QR stops admitting",
      sellerScan.status === 409 && sellerScan.data?.result === "moved",
      `${sellerScan.status} result=${sellerScan.data?.result}`,
    );
    const buyerScan = await call("POST", "/api/gate/check-in", {
      token: tokens.organiser,
      body: { ref: bought.data?.newRef, source: "manual" },
    });
    record(
      "the buyer's QR admits",
      buyerScan.status === 200 && buyerScan.data?.result === "ok",
      `${buyerScan.status} result=${buyerScan.data?.result}`,
    );

    await expectStatus("buying an already-sold listing → 410", "POST", `/api/resale/${token}/buy`, 410, {
      token: tokens.customer,
      body: { holderName: "Trop Tard", email: "late@example.com", phone: "0612345678" },
    });

    /*
     * Resale must not inflate the pool.
     *
     * All 5 seats are sold by now -- 2 to the seller, then 3 more to close
     * the zone for the discovery checks above -- and one of those 5 has
     * changed hands through a resale. The resale moved a seat between owners
     * rather than creating one, so the answer is still 0 left, not 1. This
     * read 3 before the zone was filled; the rule it protects is the same.
     */
    const avail = await call("GET", `/api/orders/availability/${slug}`);
    const remaining = avail.data?.remaining?.[tierId];
    record(
      "a resold seat is still counted once (0 of 5 left)",
      remaining === 0,
      `remaining=${remaining}`,
    );

    // Cancel a listing
    const relist = await call("POST", "/api/resale/listings", {
      token: tokens.customer,
      body: { ticketId: keep.id },
    });
    await expectStatus("DELETE listings/:id cancels it", "DELETE", `/api/resale/listings/${relist.data?.id}`, 204, {
      token: tokens.customer,
    });
    await expectStatus("cancelling it twice → 409", "DELETE", `/api/resale/listings/${relist.data?.id}`, 409, {
      token: tokens.customer,
    });
    await expectStatus("buying a cancelled listing → 410", "POST", `/api/resale/${relist.data?.token}/buy`, 410, {
      token: tokens.customer,
      body: { holderName: "Annulee Test", email: "x@example.com", phone: "0612345678" },
    });
  }

  // ──────────────────────────────── waitlist claim lookup + order cancel ──
  setGroup("CLAIMS & ORDER CANCEL");
  {
    await expectStatus("GET /events/claims/:token unknown → 410", "GET", "/api/events/claims/nope-xyz", 410);

    const { slug, event } = await makeEvent(tokens.organiser, `cancel${Date.now()}`, [tierBody({ capacity: 4 })]);
    slugs.push(slug);
    const tierId = event.tiers[0].id;

    // A sold-out tier plus a waitlist signup, then freeing the seats should
    // produce a real claim token to look up.
    const order = await buy(tokens.customer, slug, tierId, 4, "A Annuler");
    const wl = await call("POST", `/api/events/${slug}/waitlist`, {
      body: { email: `wl-${Date.now()}@example.com`, name: "En Attente" },
    });
    record("waitlist signup on a sold-out tier", wl.status === 201 || wl.status === 200, `${wl.status}`);

    const cancelled = await expectStatus(
      "POST /organiser/orders/:id/cancel",
      "POST",
      `/api/organiser/orders/${order.orderId}/cancel`,
      200,
      { token: tokens.organiser },
    );
    record("cancel reports ok", cancelled.data?.ok === true, JSON.stringify(cancelled.data));

    const after = await call("GET", `/api/orders/${order.orderId}`, { token: tokens.customer });
    record(
      "the order and all its tickets are CANCELLED",
      after.data?.order?.status === "CANCELLED" &&
        after.data.order.tickets.every((t) => t.status === "CANCELLED"),
      `order=${after.data?.order?.status} tickets=${after.data?.order?.tickets?.map((t) => t.status).join(",")}`,
    );

    /*
     * 3, not 4: four seats came back, and one was immediately OFFERED to the
     * person who joined the waitlist above — which the check further down
     * asserts. The public figure has to exclude it, or the catalogue
     * advertises a seat the purchase path will refuse.
     *
     * This expected 4 and passed while availability ignored outstanding
     * offers, so the suite was asserting both "all four are on sale" and "one
     * is reserved for the queue" at once.
     */
    const freed = await call("GET", `/api/orders/availability/${slug}`);
    record(
      "cancelling returned the seats to the pool, less the one offered to the queue",
      freed.data?.remaining?.[tierId] === 3,
      `remaining=${freed.data?.remaining?.[tierId]}`,
    );

    /*
     * Adding seats offers them to the QUEUE before the public.
     *
     * Raising a tier's capacity is the clearest case of seats becoming
     * available, and it was the one path that never told the waitlist: the
     * seats went straight into the catalogue, so anyone refreshing the page
     * bought what the queue had been waiting for.
     */
    {
      const { slug: s2, event: e2 } = await makeEvent(tokens.organiser, `grow${Date.now()}`, [tierBody({ capacity: 1 })]);
      slugs.push(s2);
      const t2 = e2.tiers[0].id;
      await buy(tokens.customer, s2, t2, 1, "Complet");

      const email = `grow-${Date.now()}@example.com`;
      await call("POST", `/api/events/${s2}/waitlist`, { body: { email } });

      const grown = await call("PATCH", `/api/organiser/tiers/${t2}`, {
        token: tokens.organiser,
        body: { capacity: 2 },
      });
      record("adding a seat to a sold-out tier succeeds", grown.status === 200, `${grown.status}`);

      // offerFreedSeats is fire-and-forget; let it land.
      await new Promise((r) => setTimeout(r, 1200));
      const queue = await call("GET", `/api/organiser/events/${s2}/waitlist`, { token: tokens.organiser });
      const mine = (queue.data?.entries ?? []).find((e) => e.email === email);
      record("and the new seat is OFFERED to the person waiting", mine?.status === "OFFERED", `${mine?.status}`);

      /*
       * The stranger is SIGNED IN, on a different account from the person
       * holding the offer. Anonymous would answer 401 for the account
       * requirement and never reach the inventory check — the check would
       * pass while proving nothing about whether the offered seat is held.
       */
      const grabbed = await call("POST", "/api/orders/hold", {
        token: tokens.customer,
        body: { eventSlug: s2, lines: [{ tierId: t2, qty: 1 }], email: `jumper-${Date.now()}@example.com` },
      });
      record("while a stranger still cannot buy it", grabbed.status === 409, `${grabbed.status}`);
    }

    await expectStatus("cancel as CUSTOMER → 403", "POST", `/api/organiser/orders/${order.orderId}/cancel`, 403, {
      token: tokens.customer,
    });
    await expectStatus("cancel an unknown order → 404", "POST", "/api/organiser/orders/nope-xyz/cancel", 404, {
      token: tokens.organiser,
    });

    // Regression: deleting an event that still has orders used to hit the
    // Order -> Event RESTRICT constraint raw and return 500 "Internal server
    // error". It must be a 409 that says what to do instead.
    await expectStatus(
      "DELETE an event that still has orders → 409, not 500",
      "DELETE",
      `/api/organiser/events/${slug}`,
      409,
      { token: tokens.organiser },
    );

    // The waitlist offer that cancellation triggered should resolve by token.
    const entries = await call("GET", `/api/organiser/events/${slug}/waitlist`, { token: tokens.organiser });
    const offered = (entries.data?.entries ?? []).find((e) => e.status === "OFFERED");
    record(
      "freeing seats produced a waitlist OFFER",
      !!offered,
      `statuses=${(entries.data?.entries ?? []).map((e) => e.status).join(",") || "none"}`,
    );
  }

  // ────────────────────────────────────────────────────────── cleanup ──
  setGroup("CLEANUP");
  {
    // Orders first: Order -> Event is onDelete Restrict. The event delete
    // route keys on SLUG, not id.
    // Two passes: a resale or share creates a SECOND order against the same
    // event, so a single sweep can leave one behind and the event then
    // refuses to delete. Loop until a pass removes nothing.
    let orders = 0;
    for (let pass = 0; pass < 3; pass++) {
      // As ADMIN: one of these events belongs to the second organiser the
      // scope test creates, and both the list and the delete are
      // ownership-scoped -- so sweeping as the first organiser silently
      // skipped it, and the event then refused to delete with a 409.
      const all = await call("GET", "/api/organiser/orders", { token: tokens.admin });
      const mine = (all.data?.orders ?? []).filter((order) => slugs.includes(order.eventSlug));
      if (mine.length === 0) break;
      for (const order of mine) {
        const res = await call("DELETE", `/api/organiser/orders/${order.id}`, { token: tokens.admin });
        if (res.status === 204) orders++;
      }
    }

    let events = 0;
    const stuck = [];
    for (const slug of slugs) {
      // As ADMIN, not as the first organiser: the scope test above creates an
      // event owned by a SECOND organiser, and "Not your event" would leave it
      // behind in the public catalogue.
      const res = await call("DELETE", `/api/organiser/events/${slug}`, { token: tokens.admin });
      if (res.status === 204) events++;
      else stuck.push(`${slug}:${res.status} ${JSON.stringify(res.data)}`);
    }
    record(`removed ${orders} order(s)`, true);
    record("all test events removed", events === slugs.length, stuck.length ? `stuck ${stuck.join(" | ")}` : `${events}/${slugs.length}`);

    // Prove it rather than trust the loop: nothing of ours may remain.
    const left = await call("GET", "/api/events");
    const remaining = (left.data?.events ?? []).filter((e) => slugs.includes(e.slug));
    record("no test event is left in the catalog", remaining.length === 0, remaining.map((e) => e.slug).join(",") || "clean");
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "─".repeat(62));
  console.log(`\x1b[1mTOTAL: ${results.length - failed.length}/${results.length} passed\x1b[0m`);
  if (failed.length) {
    console.log("");
    for (const f of failed) console.log(`  \x1b[31m[${f.group}]\x1b[0m ${f.label}`);
  }
  console.log("─".repeat(62));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  process.exit(1);
});
