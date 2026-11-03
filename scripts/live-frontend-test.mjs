/**
 * Live frontend test — every API call the UI actually makes, through the proxy.
 *
 * The backend suites talk to :4100 directly. That proves the API works; it
 * does NOT prove the frontend can reach it. Those are different failures: a
 * missing rewrite, a wrong path, a method the screen sends but the route
 * doesn't accept, or a response shape the screen reads a field off that the
 * API never returns. All of those pass a backend test and still show the user
 * an empty page.
 *
 * So everything here goes through http://localhost:3100 — the Next.js host —
 * exactly as the browser does, using the paths grepped out of src/ rather
 * than paths invented for the test. Each check also asserts the FIELDS the
 * screen reads, because a 200 carrying the wrong shape is still a broken page.
 *
 * Needs both servers up:
 *   backend  : cd backend  && npm run dev   (:4100)
 *   frontend : cd frontend && npm run dev   (:3100)
 *
 * Run: node scripts/live-frontend-test.mjs
 */

const PROXY = process.env.PROXY ?? "http://localhost:3100";

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

/** Mirrors frontend/src/api.js: /api prefix, Bearer token, JSON. */
async function api(method, path, { token, orderToken, body } = {}) {
  const res = await fetch(`${PROXY}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // The guest credential api.js sends as X-Order-Token. Kept separate
      // from `token`: a guest has no bearer token at all, and POST /share /
      // POST /resale/listings take the ticket id in the BODY, so api.js
      // cannot resolve this one from the URL the way it does for
      // /orders/:id and /tickets/:id — the call site has to supply it.
      ...(orderToken ? { "X-Order-Token": orderToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 150);
  }
  return { status: res.status, data, contentType: res.headers.get("content-type") ?? "" };
}

/** Asserts the status and, optionally, that the response has the shape the
 * calling screen expects. `shape` returns true when the fields it reads exist. */
async function check(label, method, path, want, { shape, ...options } = {}) {
  const res = await api(method, path, options);
  const wanted = Array.isArray(want) ? want : [want];
  const statusOk = wanted.includes(res.status);
  const shapeOk = !shape || !statusOk ? true : shape(res.data);
  const detail = statusOk
    ? shapeOk
      ? `${res.status}`
      : `${res.status} but the shape the screen reads is missing`
    : `${res.status} (want ${wanted.join("/")})`;
  record(label, statusOk && shapeOk, detail);
  return res;
}

async function login(account) {
  const res = await api("POST", "/auth/login", { body: account });
  if (res.status !== 200) throw new Error(`login failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data.token;
}

const SUFFIX = Date.now();
const slugs = [];

async function makeEvent(orgToken, name, tiers) {
  const slug = `fe-test-${name}-${SUFFIX}`;
  const start = new Date(Date.now() + 30 * 86_400_000);
  const res = await api("POST", "/organiser/events", {
    token: orgToken,
    body: {
      slug,
      titleFr: "Test interface",
      titleAr: "اختبار الواجهة",
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
  slugs.push(slug);
  return { slug, event: res.data.event };
}

const tier = (over = {}) => ({
  nameFr: "Standard",
  nameAr: "عادي",
  blurbFr: "x",
  blurbAr: "x",
  priceCents: 20000,
  capacity: 10,
  zoneFr: "A",
  zoneAr: "أ",
  gateFr: "1",
  gateAr: "1",
  ...over,
});

async function main() {
  // ── The host itself ───────────────────────────────────────────────────
  // Every SPA route is served by one catch-all. A 404 here means the route
  // is unreachable in a fresh tab or on reload, even though in-app
  // navigation would work.
  /*
   * The one piece of pure frontend logic worth asserting here.
   *
   * strategy.js has no React imports, so it loads directly. It earns its
   * place in an HTTP suite because it threw a runtime TypeError on the
   * organiser form: EXAMPLE_BRIEF had `fr` and `ar` but not `en`, so in
   * English the button handed `undefined` to parseBrief and the page crashed.
   * Nothing API-shaped would ever have caught that.
   */
  setGroup("BRIEF PARSER  strategy.js, behind the organiser form's button");
  {
    const { parseBrief, exampleBrief, EXAMPLE_BRIEF } = await import(
      new URL("../frontend/src/strategy.js", import.meta.url)
    );
    for (const loc of ["fr", "en", "ar"]) {
      record(`an example brief exists for ${loc}`, typeof EXAMPLE_BRIEF[loc] === "string" && EXAMPLE_BRIEF[loc].length > 20);
      const brief = parseBrief(exampleBrief(loc), loc);
      record(
        `the ${loc} example parses to the same fields`,
        brief.city === "Casablanca" && brief.capacity === 500 && brief.tiers.length === 2 && brief.discountPct === 15,
        `city=${brief.city} cap=${brief.capacity} tiers=${brief.tiers.length} pct=${brief.discountPct}`,
      );
    }
    // The crash itself: a locale with no example must not reach .trim().
    let threw = null;
    try {
      parseBrief(exampleBrief("de"), "de");
      parseBrief(undefined, "en");
      parseBrief("", "en");
    } catch (err) {
      threw = err.message;
    }
    record("a missing example or empty brief never throws", threw === null, threw ?? "no throw");
  }

  setGroup("SPA ROUTES  served by the Next.js host");
  for (const route of [
    "/",
    "/explorer",
    "/paiement",
    "/billets",
    "/devenir-organisateur",
    "/login",
    "/organiser",
    "/pro",
    "/pro/events",
    "/pro/orders",
    "/pro/gate",
    "/pro/finance",
    "/pro/placements",
    "/pro/offers",
    // Admin-only screens. The guard is client-side, so the HOST must
    // still serve them on a cold load -- a 404 here would mean an admin
    // reloading the page lands on nothing.
    "/pro/users",
    "/pro/platform",
    "/pro/permissions",
    "/aide",
    "/legal",
    // Dynamic routes, hit directly as a deep link or a reload would.
    "/evenements/mawazine-2026",
    "/billet/does-not-exist",
    "/billet-offert/does-not-exist",
    "/confirmation/does-not-exist",
  ]) {
    const res = await fetch(`${PROXY}${route}`);
    record(`GET ${route}`, res.status === 200, `${res.status}`);
  }

  const tokens = {
    admin: await login(ACCOUNTS.admin),
    organiser: await login(ACCOUNTS.organiser),
    customer: await login(ACCOUNTS.customer),
  };

  /*
   * Clear anything an earlier run left behind, before creating this run's.
   *
   * The CLEANUP group at the bottom only runs on the success path, so a
   * failure partway through orphaned its events — and they stay PUBLISHED,
   * which means they appear in the real catalogue carrying a placeholder
   * image. Two fe-test events were found doing exactly that on the demo site.
   *
   * Matches the slug PREFIX rather than this run's suffix, which is what
   * makes this a purge rather than a repeat of the end-of-run delete.
   */
  const stale = await api("GET", "/organiser/events", { token: tokens.admin });
  for (const ev of stale.data?.events ?? []) {
    if (typeof ev.slug === "string" && ev.slug.startsWith("fe-test-")) {
      await api("DELETE", `/organiser/events/${ev.slug}`, { token: tokens.admin });
    }
  }

  // ── Login.jsx / AuthContext.jsx ───────────────────────────────────────
  setGroup("AUTH  Login.jsx, AuthContext.jsx");
  {
    const res = await check("POST /auth/login returns a token and user", "POST", "/auth/login", 200, {
      body: ACCOUNTS.customer,
      // AuthContext reads token + user.role to decide what to render.
      shape: (d) => typeof d?.token === "string" && typeof d?.user?.role === "string",
    });
    record("the role drives the pro-area guard", res.data?.user?.role === "CUSTOMER", res.data?.user?.role);

    await check("POST /auth/login with a wrong password", "POST", "/auth/login", 401, {
      body: { email: ACCOUNTS.customer.email, password: "wrong-password" },
    });

    await check("GET /auth/me hydrates the session", "GET", "/auth/me", 200, {
      token: tokens.customer,
      shape: (d) => typeof d?.user?.email === "string" && typeof d?.user?.role === "string",
    });
    // api.js dispatches eventick:unauthorized on a 401, which signs the user out.
    await check("GET /auth/me without a token signals sign-out", "GET", "/auth/me", 401);

    await check("POST /auth/register creates an account", "POST", "/auth/register", [200, 201], {
      body: { email: `fe-test-${SUFFIX}@example.com`, password: "motdepasse-solide-2026", name: "Nouveau Client" },
      shape: (d) => typeof d?.token === "string",
    });
  }

  // ── Home.jsx / Explorer.jsx / EventDetail.jsx ─────────────────────────
  setGroup("CATALOG  Home.jsx, Explorer.jsx, EventDetail.jsx");
  {
    const list = await check("GET /events fills the home and explorer grids", "GET", "/events", 200, {
      // EventCard reads these per row; a missing tier array breaks "from X MAD".
      shape: (d) => Array.isArray(d?.events) && d.events.length > 0,
    });
    const sample = list.data.events[0];
    record(
      "each event carries what EventCard renders",
      typeof sample?.slug === "string" &&
        typeof sample?.titleFr === "string" &&
        typeof sample?.titleAr === "string" &&
        typeof sample?.city === "string" &&
        Array.isArray(sample?.tiers),
      Object.keys(sample ?? {}).slice(0, 8).join(","),
    );

    const detail = await check("GET /events/:slug fills EventDetail", "GET", `/events/${sample.slug}`, 200, {
      // EventDetail reads remaining per tier to show "n seats left".
      shape: (d) => d?.event?.slug === sample.slug && Array.isArray(d.event.tiers),
    });
    record(
      "tiers carry price and remaining for the seat picker",
      detail.data.event.tiers.every((t) => typeof t.priceCents === "number" && typeof t.remaining === "number"),
      `${detail.data.event.tiers.length} tier(s)`,
    );

    await check("GET an unknown slug shows the not-found state", "GET", "/events/pas-un-evenement", 404);
  }

  // ── EventDetail.jsx → Checkout.jsx: the buying flow ───────────────────
  setGroup("CHECKOUT  EventDetail.jsx, Checkout.jsx, Confirmation.jsx");
  let bought;
  {
    const { slug, event } = await makeEvent(tokens.organiser, "buy", [tier()]);
    const tierId = event.tiers[0].id;

    // The seat is claimed on Book, BEFORE the form — the whole point of the
    // flow. So hold must accept no buyer details at all.
    const hold = await check("POST /orders/hold reserves before the form is filled", "POST", "/orders/hold", 201, {
      token: tokens.customer,
      body: { eventSlug: slug, lines: [{ tierId, qty: 2 }] },
      // Checkout shows a countdown from holdUntil.
      shape: (d) => typeof d?.order?.id === "string" && typeof d?.holdUntil === "string",
    });
    const orderId = hold.data.order.id;

    // Deliberately 200 with a `valid` flag, not an error status: a mistyped
    // promo code is not an exceptional condition, and Checkout.jsx branches
    // on `result.valid` to decide between the error toast and applying it.
    const quote = await check(
      "GET /events/:slug/quote-promo prices the code Checkout typed",
      "GET",
      `/events/${slug}/quote-promo?code=SAFRAN15&subtotalCents=40000`,
      200,
      { shape: (d) => typeof d?.valid === "boolean" && typeof d?.discountCents === "number" },
    );
    record(
      "a valid code returns a discount the form can display",
      quote.data?.valid === true && quote.data.discountCents > 0,
      `valid=${quote.data?.valid} discountCents=${quote.data?.discountCents}`,
    );

    const bad = await check(
      "GET /events/:slug/quote-promo reports a bad code as invalid",
      "GET",
      `/events/${slug}/quote-promo?code=PASVALIDE&subtotalCents=40000`,
      200,
      { shape: (d) => typeof d?.valid === "boolean" },
    );
    record(
      "an unknown code is valid:false with no discount, which drives the error toast",
      bad.data?.valid === false && bad.data.discountCents === 0,
      `valid=${bad.data?.valid} discountCents=${bad.data?.discountCents}`,
    );

    // Checkout collects the details at /pay, not at hold.
    const pay = await check("POST /orders/:id/pay settles the order", "POST", `/orders/${orderId}/pay`, 200, {
      token: tokens.customer,
      body: { holderName: "Client Interface", email: "client@eventick.ma", phone: "0612345678" },
      // Checkout branches on mode: mock settles now, cmi returns a signed
      // form for the browser to POST to the gateway.
      shape: (d) => d?.mode === "mock" || (d?.mode === "cmi" && typeof d?.action === "string"),
    });
    record("mock mode settles without a gateway", pay.data?.settled === true, `mode=${pay.data?.mode}`);

    const order = await check("GET /orders/:id fills Confirmation.jsx", "GET", `/orders/${orderId}`, 200, {
      token: tokens.customer,
      shape: (d) => d?.order?.status === "PAID" && Array.isArray(d.order.tickets) && d.order.tickets.length === 2,
    });
    record(
      "each ticket carries the QR payload TicketPass renders",
      order.data.order.tickets.every((t) => typeof t.qrPayload === "string" && t.qrPayload.startsWith("EVENTICK|")),
      order.data.order.tickets[0]?.qrPayload?.slice(0, 20),
    );
    bought = { slug, tierId, orderId, tickets: order.data.order.tickets };

    // Abandoning a cart: EventDetail releases the hold on pagehide.
    const second = await api("POST", "/orders/hold", {
      token: tokens.customer,
      body: { eventSlug: slug, lines: [{ tierId, qty: 1 }] },
    });
    await check("DELETE /orders/hold/:id releases an abandoned cart", "DELETE", `/orders/hold/${second.data.order.id}`, 204, {
      token: tokens.customer,
    });
  }

  // ── Platform.jsx ──────────────────────────────────────────────────────
  setGroup("PLATFORM  Platform.jsx");
  {
    // An admin's Pilotage was an ORGANISER dashboard with bigger numbers:
    // the same tiles, summed across everyone because scope.any widens the
    // query. It never answered how many organisers exist, who is waiting
    // for approval, or whether refunds are climbing.
    const stats = await check("GET /platform/stats fills the console", "GET", "/platform/stats", 200, {
      token: tokens.admin,
      // Every field the screen reads. A 200 with a missing branch renders
      // "undefined MAD", which is worse than an error.
      shape: (d) =>
        typeof d?.users?.total === "number" &&
        typeof d?.users?.organisers === "number" &&
        typeof d?.pendingApplications === "number" &&
        typeof d?.events?.published === "number" &&
        typeof d?.orders?.paid === "number" &&
        typeof d?.revenue?.grossCents === "number" &&
        typeof d?.revenue?.netCents === "number" &&
        typeof d?.revenue?.refundRateBp === "number" &&
        typeof d?.revenue?.thisWeekCents === "number" &&
        typeof d?.revenue?.prevWeekCents === "number",
    });
    // net = gross - refunded, or the two tiles would contradict each other
    // on screen.
    record(
      "net is gross minus refunds",
      stats.data.revenue.netCents === stats.data.revenue.grossCents - stats.data.revenue.refundedCents,
      `${stats.data.revenue.netCents}`,
    );

    const sellers = await check("GET /platform/organisers ranks who sells", "GET", "/platform/organisers", 200, {
      token: tokens.admin,
      shape: (d) =>
        Array.isArray(d?.organisers) &&
        d.organisers.every(
          (o) => typeof o.grossCents === "number" && typeof o.events === "number" && typeof o.role === "string",
        ),
    });
    // Ranked by volume, so the list is useful without being re-sorted.
    const gross = (sellers.data?.organisers ?? []).map((o) => o.grossCents);
    record(
      "ranked by gross, highest first",
      gross.every((v, i) => i === 0 || gross[i - 1] >= v),
      gross.join(" >= "),
    );
    // Selected by "holds the role OR owns events". Filtering on role alone
    // reported 3 events while the platform had 17 — the rest belong to the
    // admin account, which runs house events.
    const listed = (sellers.data?.organisers ?? []).reduce((sum, o) => sum + o.events, 0);
    const published = stats.data.events.published + stats.data.events.hidden + stats.data.events.draft;
    record("every event has a seller on the list", listed >= published, `${listed} listed / ${published} events`);

    // Platform money across every organiser, so it needs both "may act
    // beyond your own rows" and "may see revenue" — not users.manage,
    // which is about editing accounts.
    await check("an ORGANISER cannot read platform stats", "GET", "/platform/stats", 403, {
      token: tokens.organiser,
    });
    await check("a CUSTOMER cannot either", "GET", "/platform/stats", 403, { token: tokens.customer });
    await check("anonymous is refused", "GET", "/platform/stats", 401);
    await check("the seller list is just as closed", "GET", "/platform/organisers", 403, {
      token: tokens.organiser,
    });
  }

  // ── BecomeOrganiser.jsx / Users.jsx request queue ─────────────────────
  setGroup("BECOME ORGANISER  BecomeOrganiser.jsx, Users.jsx queue");
  {
    // "Créer un événement" — the brand button in the header and the main
    // CTA on Home — used to point at /organiser, which is guarded on
    // events.manage. So the most prominent call to action on the site was a
    // dead end: logged out it bounced to /login with no mention of
    // organisers, and a logged-in customer was redirected to the homepage
    // with no explanation at all.
    const applicant = await api("POST", "/auth/register", {
      body: { name: "Candidat FE", email: `fe-apply-${SUFFIX}@example.com`, password: "fe-apply-2026" },
    });
    const applicantToken = applicant.data?.token;
    record("a new account starts with no permissions", (applicant.data?.user?.permissions ?? []).length === 0);

    await check("the page loads with no application yet", "GET", "/organiser-applications/mine", 200, {
      token: applicantToken,
      // The screen renders the form on null rather than treating it as an
      // error, so null has to come back as a 200.
      shape: (d) => d?.application === null,
    });

    await check("a too-short pitch is refused", "POST", "/organiser-applications", 400, {
      token: applicantToken,
      body: { displayName: "Studio FE", phone: "0612345678", pitch: "trop court" },
    });

    const created = await check("applying creates a PENDING request", "POST", "/organiser-applications", 201, {
      token: applicantToken,
      body: {
        displayName: "Studio FE",
        phone: "0612345678",
        pitch: "Nous organisons des concerts de jazz a Casablanca chaque mois.",
      },
      shape: (d) => d?.application?.status === "PENDING" && typeof d?.application?.id === "string",
    });
    const applicationId = created.data?.application?.id;

    await check("a second request while one is pending is refused", "POST", "/organiser-applications", 409, {
      token: applicantToken,
      body: {
        displayName: "Studio FE",
        phone: "0612345678",
        pitch: "Nous organisons des concerts de jazz a Casablanca chaque mois.",
      },
    });

    // The queue decides who may sell tickets, so it is users.manage only.
    await check("an applicant cannot read the review queue", "GET", "/organiser-applications", 403, {
      token: applicantToken,
    });
    await check("an ORGANISER cannot either", "GET", "/organiser-applications", 403, {
      token: tokens.organiser,
    });
    await check("the admin queue carries what Users.jsx renders", "GET", "/organiser-applications?status=PENDING", 200, {
      token: tokens.admin,
      shape: (d) =>
        Array.isArray(d?.applications) &&
        d.applications.some(
          (a) => a.id === applicationId && typeof a.applicant?.email === "string" && typeof a.pitch === "string",
        ),
    });

    await check("an applicant cannot approve themselves", "POST", `/organiser-applications/${applicationId}/decide`, 403, {
      token: applicantToken,
      body: { approve: true },
    });

    await check("an admin approves it", "POST", `/organiser-applications/${applicationId}/decide`, 200, {
      token: tokens.admin,
      body: { approve: true },
      // Approving promotes in the same transaction, so the response already
      // carries the new role.
      shape: (d) => d?.application?.status === "APPROVED" && d?.application?.applicant?.role === "ORGANISER",
    });
    await check("deciding twice is refused", "POST", `/organiser-applications/${applicationId}/decide`, 409, {
      token: tokens.admin,
      body: { approve: false },
    });

    // Permissions resolve per request, so the promotion reaches the session
    // the applicant already has — no re-login, which is what lets the page
    // offer "open the organiser area" straight after approval.
    await check("their existing session is now an organiser", "GET", "/auth/me", 200, {
      token: applicantToken,
      shape: (d) => d?.user?.role === "ORGANISER" && (d?.user?.permissions ?? []).includes("events.manage"),
    });
    await check("and the dashboard opens", "GET", "/organiser/events", 200, { token: applicantToken });
  }

  // ── Billets.jsx / TicketDetail.jsx ────────────────────────────────────
  setGroup("MY TICKETS  Billets.jsx, TicketDetail.jsx");
  {
    const ticketId = bought.tickets[0].id;

    await check("GET /orders lists the buyer's orders", "GET", "/orders", 200, {
      token: tokens.customer,
      shape: (d) => Array.isArray(d?.orders),
    });
    await check("GET /orders anonymous sends them to login", "GET", "/orders", 401);

    const detail = await check("GET /tickets/:id fills TicketDetail", "GET", `/tickets/${ticketId}`, 200, {
      // The buyer is logged in here, so their session is the credential --
      // a guest reaches the same route with their order access token.
      token: tokens.customer,
      // The page renders the QR from qrPayload and the event context beside it.
      shape: (d) => typeof d?.qrPayload === "string" && typeof d?.ticket?.ref === "string" && !!d?.event,
    });
    record(
      "the ticket carries the status the page branches on",
      ["VALID", "USED", "CANCELLED", "TRANSFERRED"].includes(detail.data.ticket.status),
      detail.data.ticket.status,
    );

    const options = await check("GET /tickets/:id/options drives the manage panel", "GET", `/tickets/${ticketId}/options`, 200, {
      token: tokens.customer,
      // The panel reads cancel.allowed, exchange[], share and shareable.
      shape: (d) =>
        typeof d?.status === "string" &&
        typeof d?.cancel?.allowed === "boolean" &&
        Array.isArray(d?.exchange) &&
        "share" in d &&
        typeof d?.shareable === "boolean",
    });
    record(
      "cancel carries the deadline the panel prints",
      typeof options.data.cancel.cutoffHours === "number" || options.data.cancel.allowed === false,
      `allowed=${options.data.cancel.allowed} cutoff=${options.data.cancel.cutoffHours}`,
    );

    await check("PATCH /tickets/:id/holder corrects the name", "PATCH", `/tickets/${ticketId}/holder`, 200, {
      token: tokens.customer,
      body: { holderName: "Nom Corrigé Interface" },
      shape: (d) => d?.ok === true,
    });

    // The PDF is fetched with the Bearer token via downloadFile(), so it must
    // come back as a PDF through the proxy, not an HTML error page.
    const pdf = await fetch(`${PROXY}/api/tickets/${ticketId}/pdf`, {
      headers: { Authorization: `Bearer ${tokens.customer}` },
    });
    record(
      "GET /tickets/:id/pdf downloads a real PDF",
      pdf.status === 200 && (pdf.headers.get("content-type") ?? "").includes("application/pdf"),
      `${pdf.status} ${pdf.headers.get("content-type")}`,
    );
  }

  // ── TicketDetail.jsx share panel / ClaimShare.jsx ─────────────────────
  setGroup("SHARING  TicketDetail.jsx panel, ClaimShare.jsx");
  {
    /*
     * An order whose only credential is its ACCESS TOKEN, to pin down the
     * line between what a confirmation link alone may do and what needs a
     * session. The backend suites hit :4100 directly and would not catch a
     * frontend that sends the wrong credential (or none), which is how a
     * guest's "Offrir ce billet" button once silently 403'd.
     *
     * It used to be bought with no bearer token at all. Buying needs an
     * account now, so it is bought by a SEPARATE throwaway account and every
     * call below still presents only the order token — never that account's
     * session. The distinction under test is credential-vs-session, and that
     * is preserved; what is gone is the ability to have no account at all.
     */
    const shareBuyer = await api("POST", "/auth/register", {
      body: {
        name: "Invité Partage",
        email: `fe-guest-share-${SUFFIX}@example.com`,
        password: `fe-guest-share-${SUFFIX}`,
      },
    });
    const guestHold = await api("POST", "/orders/hold", {
      token: shareBuyer.data.token,
      body: { eventSlug: bought.slug, lines: [{ tierId: bought.tierId, qty: 1 }] },
    });
    const guestOrderToken = guestHold.data.accessToken;
    await api("POST", `/orders/${guestHold.data.order.id}/pay`, {
      orderToken: guestOrderToken,
      token: shareBuyer.data.token,
      body: { holderName: "Invité Partage", email: `fe-guest-share-${SUFFIX}@example.com`, phone: "0612345678" },
    });
    const guestOrder = await api("GET", `/orders/${guestHold.data.order.id}`, { orderToken: guestOrderToken });
    const guestTicketId = guestOrder.data.order.tickets[0].id;

    // What a guest may do with the link alone: use the ticket, not spend or
    // dispose of it. The link travels (forwarded, screenshotted, left in a
    // shared thread), so a copy of it must not be able to refund the
    // buyer's money or hand their seat to a stranger.
    const guestOpts = await check("the manage panel tells a guest it has no session", "GET", `/tickets/${guestTicketId}/options`, 200, {
      orderToken: guestOrderToken,
      // viaSession drives whether the panel renders the destructive actions
      // or the claim prompt; orderId is what the prompt claims.
      shape: (d) => d?.viaSession === false && typeof d?.orderId === "string",
    });
    await check("a guest can still fix a typo in the holder name", "PATCH", `/tickets/${guestTicketId}/holder`, 200, {
      orderToken: guestOrderToken,
      body: { holderName: "Invité Corrigé" },
    });
    await check("a guest cannot give the ticket away", "POST", "/share", 403, {
      orderToken: guestOrderToken,
      body: { ticketId: guestTicketId },
    });
    await check("a guest cannot cancel for a refund", "POST", `/tickets/${guestTicketId}/cancel`, 403, {
      orderToken: guestOrderToken,
    });
    await check("a guest cannot list it for resale", "POST", "/resale/listings", 403, {
      orderToken: guestOrderToken,
      body: { ticketId: guestTicketId },
    });
    // And with no credential at all, still refused — not silently ignored.
    await check("the id alone is refused outright", "POST", "/share", 403, {
      body: { ticketId: guestTicketId },
    });

    /*
     * Claiming the order is the one step that unlocks the rest. Without it
     * "create an account" would be a dead end: /register makes an account but
     * nothing links the orders bought before it existed.
     *
     * The claimer is the account that BOUGHT the order. It used to be a
     * brand-new one, because the order had no owner and anyone holding the
     * link could take it — which is no longer reachable, since buying creates
     * the owner. Claiming as the owner is idempotent and still returns 200,
     * so every check below still means what it says, and the 409 at the end
     * (a second account cannot claim it) now exercises the real guard rather
     * than a race nobody can reach.
     *
     * This file talks to the SPA proxy and has no database access, so it
     * cannot detach the order the way the backend suites do.
     */
    const claimerToken = shareBuyer.data?.token;
    await check("claiming attaches the guest order to the account", "POST", `/orders/${guestHold.data.order.id}/claim`, 200, {
      token: claimerToken,
      orderToken: guestOrderToken,
    });
    const afterClaim = await api("GET", "/orders", { token: claimerToken });
    record(
      "the order now shows in their ticket list",
      (afterClaim.data?.orders ?? []).some((o) => o.id === guestHold.data.order.id),
      `${(afterClaim.data?.orders ?? []).length} order(s)`,
    );
    await check("and the panel now reports a session", "GET", `/tickets/${guestTicketId}/options`, 200, {
      token: claimerToken,
      shape: (d) => d?.viaSession === true,
    });
    const nowShare = await check("so the ticket can now be given away", "POST", "/share", 201, {
      token: claimerToken,
      body: { ticketId: guestTicketId },
      shape: (d) => typeof d?.token === "string" && typeof d?.id === "string",
    });
    if (nowShare.status === 201) {
      await check("and the link revoked again", "DELETE", `/share/${nowShare.data.id}`, 204, { token: claimerToken });
    }
    // Two people can hold the same link; the first to claim owns it.
    const other = await api("POST", "/auth/register", {
      body: { name: "Autre", email: `fe-other-${SUFFIX}@example.com`, password: "fe-other-pass-2026" },
    });
    await check("a second account cannot claim the same order", "POST", `/orders/${guestHold.data.order.id}/claim`, 409, {
      token: other.data?.token,
      orderToken: guestOrderToken,
    });

    const ticketId = bought.tickets[1].id;

    const share = await check("POST /share creates the link the panel copies", "POST", "/share", 201, {
      token: tokens.customer,
      body: { ticketId, message: "A ce soir" },
      shape: (d) => typeof d?.token === "string" && typeof d?.id === "string",
    });
    const token = share.data.token;

    // ClaimShare.jsx loads this with no account at all.
    const offer = await check("GET /share/:token fills ClaimShare", "GET", `/share/${token}`, 200, {
      // The page prints the sender, the event and the seat.
      shape: (d) =>
        typeof d?.senderName === "string" &&
        typeof d?.eventTitleFr === "string" &&
        typeof d?.eventStart === "string" &&
        typeof d?.tierNameFr === "string",
    });
    record("the optional message reaches the recipient", offer.data.message === "A ce soir", offer.data.message ?? "null");

    const claimed = await check("POST /share/:token/claim issues the new ticket", "POST", `/share/${token}/claim`, 201, {
      body: { holderName: "Destinataire Interface" },
      // The claim screen renders the QR immediately, and hands back a token
      // scoped to this one ticket -- the recipient has no account, and the
      // ticket sits on the SENDER's order, so they get neither a session
      // nor the order credential.
      shape: (d) =>
        typeof d?.ticketId === "string" &&
        typeof d?.qrPayload === "string" &&
        typeof d?.ref === "string" &&
        typeof d?.accessToken === "string",
    });
    // The recipient's token must open the ticket page...
    await check("the claimed ticket opens /billet/:id with its token", "GET", `/tickets/${claimed.data.ticketId}?k=${encodeURIComponent(claimed.data.accessToken)}`, 200, {
      shape: (d) => d?.ticket?.ref === claimed.data.ref,
    });
    // ...and the id on its own must not, or the share link would have
    // handed a working QR to anyone who guessed it.
    await check("the claimed ticket id alone → 403", "GET", `/tickets/${claimed.data.ticketId}`, 403);
    // The narrow token must not reach the sender's OTHER tickets.
    await check(
      "the recipient token does not open the sender's other ticket",
      "GET",
      `/tickets/${bought.tickets[0].id}?k=${encodeURIComponent(claimed.data.accessToken)}`,
      403,
    );
    await check("GET /share/:token after claiming is gone", "GET", `/share/${token}`, 410);

    // Revoking, as the panel's second button does.
    const third = await api("POST", "/orders/hold", {
      token: tokens.customer,
      body: { eventSlug: bought.slug, lines: [{ tierId: bought.tierId, qty: 1 }] },
    });
    await api("POST", `/orders/${third.data.order.id}/pay`, {
      token: tokens.customer,
      body: { holderName: "A Revoquer", email: "client@eventick.ma", phone: "0612345678" },
    });
    const freshOrder = await api("GET", `/orders/${third.data.order.id}`, { token: tokens.customer });
    const freshTicket = freshOrder.data.order.tickets[0];
    const toRevoke = await api("POST", "/share", { token: tokens.customer, body: { ticketId: freshTicket.id } });
    await check("DELETE /share/:id revokes an unclaimed link", "DELETE", `/share/${toRevoke.data.id}`, 204, {
      token: tokens.customer,
    });

    // The legacy transfer button now hands back a share link.
    await check("POST /tickets/:id/transfer returns a share link", "POST", `/tickets/${freshTicket.id}/transfer`, 201, {
      token: tokens.customer,
      shape: (d) => typeof d?.token === "string" && typeof d?.shareId === "string",
    });
  }

  // ── TicketDetail.jsx cancel / exchange ────────────────────────────────
  setGroup("SELF-SERVICE  TicketDetail.jsx cancel and exchange");
  {
    const { slug, event } = await makeEvent(tokens.organiser, "self", [
      tier({ nameFr: "Gradin", priceCents: 20000 }),
      tier({ nameFr: "Balcon", priceCents: 10000, zoneFr: "B" }),
      tier({ nameFr: "Fosse", priceCents: 40000, zoneFr: "F" }),
    ]);
    const byName = Object.fromEntries(event.tiers.map((t) => [t.nameFr, t.id]));

    const hold = await api("POST", "/orders/hold", {
      token: tokens.customer,
      body: { eventSlug: slug, lines: [{ tierId: byName.Gradin, qty: 2 }] },
    });
    await api("POST", `/orders/${hold.data.order.id}/pay`, {
      token: tokens.customer,
      body: { holderName: "Client Self", email: "client@eventick.ma", phone: "0612345678" },
    });
    const order = await api("GET", `/orders/${hold.data.order.id}`, { token: tokens.customer });
    const [a, b] = order.data.order.tickets;

    await check("POST /tickets/:id/exchange moves zone for free", "POST", `/tickets/${a.id}/exchange`, 200, {
      token: tokens.customer,
      body: { tierId: byName.Balcon },
      shape: (d) => typeof d?.ticketId === "string",
    });
    // The panel disables upgrade buttons for exactly this reason.
    await check("POST /tickets/:id/exchange refuses an unpaid upgrade", "POST", `/tickets/${b.id}/exchange`, 402, {
      token: tokens.customer,
      body: { tierId: byName.Fosse },
    });

    await check("POST /tickets/:id/cancel refunds the holder", "POST", `/tickets/${b.id}/cancel`, 200, {
      token: tokens.customer,
      shape: (d) => typeof d?.refundedCents === "number",
    });
  }

  // ── EventDetail.jsx waitlist ──────────────────────────────────────────
  setGroup("WAITLIST  EventDetail.jsx sold-out state");
  {
    const { slug, event } = await makeEvent(tokens.organiser, "wait", [tier({ capacity: 1 })]);
    const tierId = event.tiers[0].id;
    const hold = await api("POST", "/orders/hold", {
      token: tokens.customer,
      body: { eventSlug: slug, lines: [{ tierId, qty: 1 }] },
    });
    await api("POST", `/orders/${hold.data.order.id}/pay`, {
      token: tokens.customer,
      body: { holderName: "Dernier Billet", email: "client@eventick.ma", phone: "0612345678" },
    });

    const sold = await api("GET", `/events/${slug}`);
    record(
      "the sold-out tier reads 0 remaining, so the form switches",
      sold.data.event.tiers[0].remaining === 0,
      `remaining=${sold.data.event.tiers[0].remaining}`,
    );

    await check("POST /events/:slug/waitlist joins the queue", "POST", `/events/${slug}/waitlist`, [200, 201], {
      body: { email: `fe-wait-${SUFFIX}@example.com` },
    });
    await check("joining twice is reported, not duplicated", "POST", `/events/${slug}/waitlist`, [200, 409], {
      body: { email: `fe-wait-${SUFFIX}@example.com` },
    });
  }

  // ── Organiser.jsx + screens/pro/* ─────────────────────────────────────
  setGroup("PRO DASHBOARD  screens/pro/*");
  {
    const { slug } = await makeEvent(tokens.organiser, "pro", [tier()]);

    // Overview.jsx
    await check("GET /organiser/stats fills Overview", "GET", "/organiser/stats", 200, {
      token: tokens.organiser,
      shape: (d) => typeof d === "object" && d !== null,
    });
    // Events.jsx
    const events = await check("GET /organiser/events fills Events", "GET", "/organiser/events", 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.events),
    });
    record(
      "each row carries both titles the edit form now loads",
      events.data.events.every((e) => typeof e.titleFr === "string" && typeof e.titleAr === "string"),
      `${events.data.events.length} event(s)`,
    );

    /*
     * The owning organiser is shown on each card for an admin, and only for
     * an admin: their list is the only one that can hold more than one
     * organiser's events. The field is absent for an organiser rather than
     * null, because the card keys the row off its presence.
     */
    record(
      "an organiser's own rows carry no organiser field",
      events.data.events.every((e) => e.organiser === undefined),
      "their list is all theirs",
    );
    const adminEvents = await check("GET /organiser/events as admin", "GET", "/organiser/events", 200, {
      token: tokens.admin,
      shape: (d) => Array.isArray(d?.events),
    });
    record(
      "an admin's rows name the owning organiser",
      adminEvents.data.events.every((e) => e.organiser === null || typeof e.organiser?.email === "string"),
      adminEvents.data.events[0]?.organiser?.name ?? adminEvents.data.events[0]?.organiser?.email ?? "?",
    );
    const publicCatalogue = await api("GET", "/events");
    record(
      "the public catalogue still exposes no organiser",
      (publicCatalogue.data?.events ?? []).every((e) => e.organiser === undefined),
      "an organiser's email is not public data",
    );
    // Orders.jsx
    await check("GET /organiser/orders fills Orders", "GET", "/organiser/orders", 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.orders),
    });
    await check("GET /organiser/orders/detailed fills the order drawer", "GET", "/organiser/orders/detailed", 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.orders),
    });
    // Placements.jsx
    const tiers = await check("GET /organiser/events/:slug/tiers fills Placements", "GET", `/organiser/events/${slug}/tiers`, 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.tiers),
    });
    record(
      "each tier reports sold and remaining for the zone cards",
      tiers.data.tiers.every((t) => typeof t.sold === "number" && typeof t.remaining === "number"),
      `${tiers.data.tiers.length} tier(s)`,
    );
    const newTier = await check("POST tiers adds a zone from Placements", "POST", `/organiser/events/${slug}/tiers`, 201, {
      token: tokens.organiser,
      body: tier({ nameFr: "Carré Or", priceCents: 50000, zoneFr: "OR" }),
      shape: (d) => typeof d?.tier?.id === "string",
    });
    await check("PATCH tiers/:id saves a zone edit", "PATCH", `/organiser/tiers/${newTier.data.tier.id}`, 200, {
      token: tokens.organiser,
      body: { priceCents: 55000, capacity: 8 },
      shape: (d) => d?.tier?.priceCents === 55000,
    });
    await check("DELETE tiers/:id removes an empty zone", "DELETE", `/organiser/tiers/${newTier.data.tier.id}`, 204, {
      token: tokens.organiser,
    });

    // Events.jsx edit — the FR/AR fix. Writing only French must leave the
    // Arabic title alone, which was the bug.
    const before = await api("GET", `/events/${slug}`);
    await check("PATCH /organiser/events/:slug saves the edit form", "PATCH", `/organiser/events/${slug}`, 200, {
      token: tokens.organiser,
      body: { titleFr: "Titre Modifié", titleAr: before.data.event.titleAr, city: "Rabat" },
    });
    const after = await api("GET", `/events/${slug}`);
    record(
      "editing the French title leaves the Arabic one intact",
      after.data.event.titleFr === "Titre Modifié" && after.data.event.titleAr === before.data.event.titleAr,
      `fr="${after.data.event.titleFr}" ar="${after.data.event.titleAr}"`,
    );

    await check("PATCH visibility hides an event", "PATCH", `/organiser/events/${slug}/visibility`, 200, {
      token: tokens.organiser,
      body: { status: "HIDDEN" },
    });
    await check("PATCH visibility publishes it again", "PATCH", `/organiser/events/${slug}/visibility`, 200, {
      token: tokens.organiser,
      body: { status: "PUBLISHED" },
    });

    // Offers.jsx
    const promos = await check("GET /promo fills Offers", "GET", "/promo", 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.promoCodes) || Array.isArray(d?.promos) || Array.isArray(d?.codes),
    });
    const key = ["promoCodes", "promos", "codes"].find((k) => Array.isArray(promos.data?.[k]));
    record("the promo list is under a key Offers can read", !!key, key ?? JSON.stringify(Object.keys(promos.data ?? {})));

    // Scoped to an event the organiser owns: allowed, and the only kind
    // Offers.jsx lets a non-admin create.
    const promo = await check("POST /promo creates a code on your own event", "POST", "/promo", 201, {
      token: tokens.organiser,
      body: { code: `FETEST${SUFFIX}`.slice(0, 20), kind: "PERCENT", value: 10, maxUses: 5, eventSlug: slug },
      shape: (d) => typeof (d?.promoCode?.id ?? d?.promo?.id ?? d?.id) === "string",
    });
    // Omitting eventSlug asks for a PLATFORM-WIDE code, valid on every
    // event including other organisers'. That is a discount on other
    // people's sales, so it needs scope.any.
    await check("an organiser cannot create a platform-wide code", "POST", "/promo", 403, {
      token: tokens.organiser,
      body: { code: `FEGLOBAL${SUFFIX}`.slice(0, 20), kind: "PERCENT", value: 10, maxUses: 5 },
    });
    const globalPromo = await check("an admin can create a platform-wide code", "POST", "/promo", 201, {
      token: tokens.admin,
      body: { code: `FEADMIN${SUFFIX}`.slice(0, 20), kind: "PERCENT", value: 10, maxUses: 5 },
      shape: (d) => (d?.promo ?? d?.promoCode)?.eventId === null,
    });
    const promoId = promo.data?.promoCode?.id ?? promo.data?.promo?.id ?? promo.data?.id;
    // Offers.jsx's "bump" button raises the usage cap; maxUses is the only
    // field the route accepts, so that is what this must send.
    await check("PATCH /promo/:id raises the usage cap", "PATCH", `/promo/${promoId}`, 200, {
      token: tokens.organiser,
      body: { maxUses: 55 },
      shape: (d) => (d?.promo?.maxUses ?? d?.promoCode?.maxUses) === 55,
    });
    await check("PATCH /promo/:id rejects a field it does not own", "PATCH", `/promo/${promoId}`, 400, {
      token: tokens.organiser,
      body: { value: "not-a-number" },
    });
    await check("DELETE /promo/:id removes it", "DELETE", `/promo/${promoId}`, [200, 204], {
      token: tokens.organiser,
    });

    // PATCH and DELETE had no ownership check at all before 8bac36d: any
    // organiser could bump the cap on, or delete, a platform-wide code.
    const globalId = globalPromo.data?.promo?.id ?? globalPromo.data?.promoCode?.id;
    if (globalId) {
      await check("an organiser cannot bump a platform-wide code", "PATCH", `/promo/${globalId}`, 403, {
        token: tokens.organiser,
        body: { maxUses: 999 },
      });
      await check("an organiser cannot delete a platform-wide code", "DELETE", `/promo/${globalId}`, 403, {
        token: tokens.organiser,
      });
      await check("the admin who made it can delete it", "DELETE", `/promo/${globalId}`, [200, 204], {
        token: tokens.admin,
      });
    }

    // Audience + broadcast (Events.jsx contact modal)
    await check("GET audience fills the contact modal", "GET", `/organiser/events/${slug}/audience`, 200, {
      token: tokens.organiser,
      shape: (d) => typeof d === "object" && d !== null,
    });

    // Every pro screen must refuse a plain customer, or the dashboard leaks.
    await check("a CUSTOMER cannot read /organiser/stats", "GET", "/organiser/stats", 403, { token: tokens.customer });
    await check("a CUSTOMER cannot read /organiser/orders", "GET", "/organiser/orders", 403, { token: tokens.customer });
    await check("anonymous cannot read /organiser/events", "GET", "/organiser/events", 401);
  }

  // ── Users.jsx + Permissions.jsx ───────────────────────────────────────
  setGroup("ADMIN  Users.jsx, Permissions.jsx");
  {
    // Permissions.jsx reads data.permissions[].{key,description,locked} and
    // data.roles[ROLE][] directly, so the shape is the contract.
    await check("GET /auth/permissions fills the matrix", "GET", "/auth/permissions", 200, {
      token: tokens.admin,
      shape: (d) =>
        Array.isArray(d?.permissions) &&
        d.permissions.length > 0 &&
        d.permissions.every((x) => typeof x.key === "string" && typeof x.description === "string" && typeof x.locked === "boolean") &&
        ["CUSTOMER", "ORGANISER", "ADMIN"].every((r) => Array.isArray(d?.roles?.[r])),
    });

    await check("GET /auth/users fills the directory", "GET", "/auth/users", 200, {
      token: tokens.admin,
      shape: (d) =>
        Array.isArray(d?.users) &&
        d.users.every((u) => "role" in u && "eventCount" in u && "orderCount" in u && "createdAt" in u),
    });

    // The create-user form. A fresh address each run so re-runs stay green.
    const email = `fe-admin-${SUFFIX}@eventick.ma`;
    const made = await check("POST /auth/users creates an account with a role", "POST", "/auth/users", 201, {
      token: tokens.admin,
      body: { name: "Frontend Test Organiser", email, password: "fe-test-password-2026", role: "ORGANISER" },
      shape: (d) => d?.user?.role === "ORGANISER" && typeof d?.user?.id === "string",
    });
    await check("a duplicate email is a 422 the form pins on the field", "POST", "/auth/users", 422, {
      token: tokens.admin,
      body: { name: "Dupe", email, password: "fe-test-password-2026", role: "CUSTOMER" },
      shape: (d) => typeof d?.error === "string" && d.error.length > 0,
    });
    await check("a password under 8 characters is refused", "POST", "/auth/users", [400, 422], {
      token: tokens.admin,
      body: { name: "Weak", email: `fe-weak-${SUFFIX}@eventick.ma`, password: "short", role: "CUSTOMER" },
    });

    // The new account must actually work, with exactly the role it was given.
    const fresh = await api("POST", "/auth/login", { body: { email, password: "fe-test-password-2026" } });
    record("the created account can log in", fresh.status === 200, `${fresh.status}`);
    if (fresh.status === 200) {
      await check("it holds events.manage, so canUsePro shows Espace Pro", "GET", "/auth/me", 200, {
        token: fresh.data.token,
        shape: (d) =>
          Array.isArray(d?.user?.permissions) &&
          d.user.permissions.includes("events.manage") &&
          !d.user.permissions.includes("users.manage"),
      });
    }

    // ADMIN is not an assignable role, by creation OR by promotion. The seed
    // stays the only way an admin account comes into being, so one
    // compromised admin cannot mint or appoint more of itself. Enforced by
    // the schema (ADMIN_CREATABLE_ROLES), not by the role picker hiding it.
    await check("an admin cannot CREATE another admin", "POST", "/auth/users", 400, {
      token: tokens.admin,
      body: { name: "Second Admin", email: `fe-admin2-${SUFFIX}@eventick.ma`, password: "fe-test-password-2026", role: "ADMIN" },
    });
    if (made.status === 201) {
      await check("an admin cannot PROMOTE someone to admin either", "PATCH", `/auth/users/${made.data.user.id}/role`, 400, {
        token: tokens.admin,
        body: { role: "ADMIN" },
      });
      // Demotion must still work, or an admin could never be removed.
      await check("but demoting still works", "PATCH", `/auth/users/${made.data.user.id}/role`, 200, {
        token: tokens.admin,
        body: { role: "CUSTOMER" },
        shape: (d) => d?.user?.role === "CUSTOMER",
      });
    }

    // Toggling a grant. CUSTOMER/promo.manage is safe to move: nothing in
    // this suite depends on a customer holding it.
    await check("granting a permission returns the new list", "POST", "/auth/roles/CUSTOMER/permissions", 200, {
      token: tokens.admin,
      body: { permission: "promo.manage" },
      shape: (d) => (d?.permissions ?? []).includes("promo.manage"),
    });
    // Liveness: permissions resolve per request, so the customer's existing
    // token must reflect the change without re-logging in.
    await check("an existing token picks the grant up immediately", "GET", "/auth/me", 200, {
      token: tokens.customer,
      shape: (d) => (d?.user?.permissions ?? []).includes("promo.manage"),
    });
    await check("revoking it returns the trimmed list", "DELETE", "/auth/roles/CUSTOMER/permissions/promo.manage", 200, {
      token: tokens.admin,
      shape: (d) => !(d?.permissions ?? []).includes("promo.manage"),
    });
    await check("and the token loses it again", "GET", "/auth/me", 200, {
      token: tokens.customer,
      shape: (d) => !(d?.user?.permissions ?? []).includes("promo.manage"),
    });

    // The guard Permissions.jsx renders as a disabled, padlocked button.
    await check("ADMIN cannot lose users.manage", "DELETE", "/auth/roles/ADMIN/permissions/users.manage", 422, {
      token: tokens.admin,
    });

    // Both screens must be closed to everyone else. 403, never 401 -- the
    // SPA signs the user out on a 401, so a wrong code here logs an
    // organiser out of the dashboard they are entitled to.
    for (const [who, token] of [["an ORGANISER", tokens.organiser], ["a CUSTOMER", tokens.customer]]) {
      await check(`${who} cannot read the permissions matrix`, "GET", "/auth/permissions", 403, { token });
      await check(`${who} cannot read the user directory`, "GET", "/auth/users", 403, { token });
      await check(`${who} cannot create a user`, "POST", "/auth/users", 403, {
        token,
        // A role the schema ACCEPTS, so this proves the permission gate
        // refused them -- not that the body failed validation first.
        body: { name: "Nope", email: `nope-${SUFFIX}-${who.length}@eventick.ma`, password: "nope-password-2026", role: "ORGANISER" },
      });
      await check(`${who} cannot grant themselves a permission`, "POST", "/auth/roles/ORGANISER/permissions", 403, {
        token,
        body: { permission: "scope.any" },
      });
    }
    await check("anonymous cannot read the permissions matrix", "GET", "/auth/permissions", 401);

    // There is no DELETE /auth/users/:id, so the account this suite creates
    // cannot be removed over the API. Named here rather than left as silent
    // litter in the very directory this screen lists.
    record("the test account is left behind (no delete endpoint)", made.status === 201, made.status === 201 ? email : "not created");
  }

  // ── Gate.jsx + QrScanner.jsx + offlineGate.js ─────────────────────────
  setGroup("GATE  Gate.jsx, QrScanner.jsx, offlineGate.js");
  {
    const { slug, event } = await makeEvent(tokens.organiser, "gate", [tier()]);
    const hold = await api("POST", "/orders/hold", {
      token: tokens.customer,
      body: { eventSlug: slug, lines: [{ tierId: event.tiers[0].id, qty: 2 }] },
    });
    await api("POST", `/orders/${hold.data.order.id}/pay`, {
      token: tokens.customer,
      body: { holderName: "Porte Test", email: "client@eventick.ma", phone: "0612345678" },
    });
    const order = await api("GET", `/orders/${hold.data.order.id}`, { token: tokens.customer });
    const [scanMe, typeMe] = order.data.order.tickets;

    // QrScanner posts the decoded payload with source: camera.
    const ok = await check("POST /gate/check-in admits a scanned QR", "POST", "/gate/check-in", 200, {
      token: tokens.organiser,
      body: { ref: scanMe.qrPayload, source: "camera" },
      // Gate.jsx prints the holder name on the green screen.
      shape: (d) => d?.result === "ok" && typeof d?.ticket?.holderName === "string",
    });
    record("the response says whether the code was signed", typeof ok.data.signed === "boolean", `signed=${ok.data.signed}`);

    await check("scanning the same ticket twice is refused", "POST", "/gate/check-in", 409, {
      token: tokens.organiser,
      body: { ref: scanMe.qrPayload, source: "camera" },
    });

    // A bare printed ref from the camera is a forgery attempt.
    await check("a bare ref from the camera is rejected", "POST", "/gate/check-in", 400, {
      token: tokens.organiser,
      body: { ref: typeMe.ref, source: "camera" },
    });
    // Typed by hand, it is a deliberate staff override.
    await check("the same ref typed by hand is admitted", "POST", "/gate/check-in", 200, {
      token: tokens.organiser,
      body: { ref: typeMe.ref, source: "manual" },
      shape: (d) => d?.result === "ok",
    });

    // offlineGate.js caches this so the door keeps working without network.
    const manifest = await check("GET the gate manifest for offline mode", "GET", `/gate/events/${slug}/manifest`, 200, {
      token: tokens.organiser,
      shape: (d) => Array.isArray(d?.refs ?? d?.tickets ?? d?.manifest),
    });
    const refsKey = ["refs", "tickets", "manifest"].find((k) => Array.isArray(manifest.data?.[k]));
    record("the manifest is a list offlineGate can cache", !!refsKey, refsKey ?? JSON.stringify(Object.keys(manifest.data ?? {})));

    await check("a CUSTOMER cannot check anyone in", "POST", "/gate/check-in", 403, {
      token: tokens.customer,
      body: { ref: typeMe.ref, source: "manual" },
    });
  }

  // ── Orders.jsx actions ────────────────────────────────────────────────
  setGroup("ORDER DESK  Orders.jsx actions");
  {
    const { slug, event } = await makeEvent(tokens.organiser, "desk", [tier()]);
    const tierId = event.tiers[0].id;

    const mk = async (name) => {
      const h = await api("POST", "/orders/hold", {
        token: tokens.customer,
        body: { eventSlug: slug, lines: [{ tierId, qty: 1 }] },
      });
      await api("POST", `/orders/${h.data.order.id}/pay`, {
        token: tokens.customer,
        body: { holderName: name, email: "client@eventick.ma", phone: "0612345678" },
      });
      const o = await api("GET", `/orders/${h.data.order.id}`, { token: tokens.customer });
      return { id: h.data.order.id, ticket: o.data.order.tickets[0] };
    };

    const toAdmit = await mk("A Admettre");
    await check("PATCH ticket status admits from the desk", "PATCH", `/organiser/tickets/${toAdmit.ticket.id}/status`, 200, {
      token: tokens.organiser,
      body: { status: "USED" },
    });
    await check("PATCH ticket status undoes an admission", "PATCH", `/organiser/tickets/${toAdmit.ticket.id}/status`, 200, {
      token: tokens.organiser,
      body: { status: "VALID" },
    });

    /*
     * Orders.jsx no longer has a refund button, and the route behind it is
     * gone: tickets are final sale, and money goes back only when the EVENT
     * is cancelled. These four checks used to drive a full refund, a repeat,
     * a partial and a negative amount from the desk.
     */
    const toRefund = await mk("A Rembourser");
    await check("the desk has no refund route left", "POST", `/organiser/orders/${toRefund.id}/refund`, 404, {
      token: tokens.organiser,
      body: {},
    });

    const toCancel = await mk("A Annuler");
    await check("POST /organiser/orders/:id/cancel voids an order", "POST", `/organiser/orders/${toCancel.id}/cancel`, 200, {
      token: tokens.organiser,
      shape: (d) => d?.ok === true,
    });

    const toDelete = await mk("A Supprimer");
    await check("DELETE /organiser/orders/:id removes a record", "DELETE", `/organiser/orders/${toDelete.id}`, 204, {
      token: tokens.organiser,
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  setGroup("CLEANUP");
  {
    // Orders first: Order -> Event is RESTRICT. Several passes, because a
    // share or resale puts a second order on the same event.
    let orders = 0;
    for (let pass = 0; pass < 4; pass++) {
      const all = await api("GET", "/organiser/orders", { token: tokens.organiser });
      const mine = (all.data?.orders ?? []).filter((o) => slugs.includes(o.eventSlug));
      if (mine.length === 0) break;
      for (const o of mine) {
        const res = await api("DELETE", `/organiser/orders/${o.id}`, { token: tokens.organiser });
        if (res.status === 204) orders++;
      }
    }
    let events = 0;
    const stuck = [];
    for (const slug of slugs) {
      const res = await api("DELETE", `/organiser/events/${slug}`, { token: tokens.organiser });
      if (res.status === 204) events++;
      else stuck.push(`${slug}:${res.status}`);
    }
    record(`removed ${orders} order(s)`, true);
    record("all test events removed", events === slugs.length, stuck.length ? `stuck ${stuck.join(" | ")}` : `${events}/${slugs.length}`);

    const left = await api("GET", "/events");
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
