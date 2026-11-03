import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { publicEvent } from "../lib/serialize.js";
import { remainingByTier } from "../lib/availability.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { quotePromo, type PromoCandidate } from "../domain/pricing.js";
import { resolveClaim } from "../lib/waitlist.js";

export const eventsRouter = Router();

const EVENT_INCLUDE = { tiers: true, lineup: true } as const;

eventsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const events = await prisma.event.findMany({
      where: { status: "PUBLISHED" },
      include: EVENT_INCLUDE,
      orderBy: { popularity: "desc" },
    });
    const shaped = await Promise.all(
      events.map(async (event) => publicEvent(event, await remainingByTier(event.id))),
    );
    res.json({ events: shaped });
  }),
);

/**
 * Every seat being resold, across every event — the resale marketplace.
 *
 * The per-event version below answers "is anyone reselling THIS show". This
 * one answers the question a buyer actually arrives with: "the show I want is
 * sold out, is anyone selling". Without it a listing is reachable only by its
 * own link, so a resale works just like a gift — fine for a friend, useless
 * for a stranger, and the seller's seat goes empty.
 *
 * Same sold-out rule as the per-event route, and for the same reason: a
 * resale sits at face value, so surfacing one beside seats the organiser can
 * still sell takes a sale he would have made anyway. Where a zone has sold
 * out it is the opposite — it is the only thing standing between a buyer and
 * a dead end.
 *
 * Public and unauthenticated, like the catalogue. Buying still needs an
 * account; seeing what exists does not.
 */
eventsRouter.get(
  "/resales/all",
  asyncHandler(async (_req, res) => {
    const listings = await prisma.resaleListing.findMany({
      where: {
        status: "LISTED",
        ticket: {
          // A seat can only be resold while it is still a live entitlement.
          status: "VALID",
          tier: {
            event: {
              status: "PUBLISHED",
              // The organiser has to have opted in, and a show that has
              // started cannot be sold into.
              allowResale: true,
              startAt: { gt: new Date() },
            },
          },
        },
      },
      include: { ticket: { include: { tier: { include: { event: true } } } } },
      orderBy: { createdAt: "asc" },
    });

    /*
     * Availability is per EVENT, so it is fetched once per event rather than
     * once per listing — two seats resold on the same show would otherwise
     * recount the whole tier twice.
     */
    const byEvent = new Map();
    for (const listing of listings) {
      const eventId = listing.ticket.tier.eventId;
      if (!byEvent.has(eventId)) byEvent.set(eventId, await remainingByTier(eventId));
    }

    res.json({
      resales: listings
        .filter((l) => (byEvent.get(l.ticket.tier.eventId)?.[l.ticket.tierId] ?? 0) <= 0)
        .map((l) => {
          const event = l.ticket.tier.event;
          return {
            id: l.id,
            token: l.token,
            priceCents: l.priceCents,
            tierNameFr: l.ticket.tier.nameFr,
            tierNameAr: l.ticket.tier.nameAr,
            seatRow: l.ticket.seatRow,
            seatNumber: l.ticket.seatNumber,
            listedAt: l.createdAt.toISOString(),
            event: {
              slug: event.slug,
              titleFr: event.titleFr,
              titleAr: event.titleAr,
              city: event.city,
              venueFr: event.venueFr,
              venueAr: event.venueAr,
              image: event.image,
              category: event.category,
              start: event.startAt.toISOString(),
            },
          };
        }),
    });
  }),
);

/**
 * What a waitlist claim link is offering.
 *
 * Public by design: the token IS the credential, exactly like the guest
 * order links. It returns only what the holder needs to decide — which event,
 * which zone, how long is left.
 */
eventsRouter.get(
  "/claims/:token",
  asyncHandler(async (req, res) => {
    const token = param(req, "token");
    const claim = await resolveClaim(token);
    if (!claim) throw new HttpError(410, "This offer has expired or is no longer valid");

    const tier = claim.claimTierId ? await prisma.ticketTier.findUnique({ where: { id: claim.claimTierId } }) : null;
    res.json({
      entryId: claim.id,
      eventSlug: claim.event.slug,
      eventTitleFr: claim.event.titleFr,
      eventTitleAr: claim.event.titleAr,
      tierId: tier?.id ?? null,
      tierNameFr: tier?.nameFr ?? null,
      tierNameAr: tier?.nameAr ?? null,
      priceCents: tier?.priceCents ?? null,
      expiresAt: claim.claimExpiresAt?.toISOString() ?? null,
    });
  }),
);

eventsRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await prisma.event.findUnique({ where: { slug }, include: EVENT_INCLUDE });
    if (!event || event.status !== "PUBLISHED") throw new HttpError(404, "Event not found");
    res.json({ event: publicEvent(event, await remainingByTier(event.id)) });
  }),
);

/**
 * Seats being resold on this event — but only for tiers that are SOLD OUT.
 *
 * The sold-out condition is the whole design, not a detail. A resale sits at
 * face value, so surfacing one beside a tier still on sale just takes a sale
 * the organiser would have made anyway: the platform would be competing with
 * its own inventory. Where there is nothing left to buy it is the opposite —
 * a sold-out page stops being a dead end, and the waitlist stops being the
 * only answer to "can I still go".
 *
 * Public and unauthenticated, like the catalogue: you have to see that a seat
 * exists before deciding to sign in and buy it.
 *
 * The token IS returned, which deserves saying out loud because elsewhere it
 * is treated as a secret. It is the address of the listing, not a permission:
 * /resale/:token/buy still requires a signed-in account, still takes payment,
 * and still refuses a listing that is sold or withdrawn. A seat whose owner
 * has deliberately put it up for sale on a sold-out event is not a seat whose
 * location needs hiding — and without it there is nothing to link to.
 */
eventsRouter.get(
  "/:slug/resales",
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await prisma.event.findUnique({
      where: { slug },
      select: { id: true, status: true, allowResale: true, startAt: true },
    });
    if (!event || event.status !== "PUBLISHED") throw new HttpError(404, "Event not found");

    // An organiser who never opted in has no secondary market, and an event
    // that has started cannot be sold into.
    if (!event.allowResale || event.startAt.getTime() <= Date.now()) {
      return res.json({ resales: [] });
    }

    const remaining = await remainingByTier(event.id);
    const listings = await prisma.resaleListing.findMany({
      where: { status: "LISTED", ticket: { tier: { eventId: event.id } } },
      include: { ticket: { include: { tier: true } } },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      resales: listings
        // Tier by tier: one zone selling out does not put another zone's
        // resales in front of seats the organiser can still sell himself.
        .filter((l) => (remaining[l.ticket.tierId] ?? 0) <= 0)
        .map((l) => ({
          id: l.id,
          token: l.token,
          priceCents: l.priceCents,
          tierId: l.ticket.tierId,
          tierNameFr: l.ticket.tier.nameFr,
          tierNameAr: l.ticket.tier.nameAr,
          seatRow: l.ticket.seatRow,
          seatNumber: l.ticket.seatNumber,
        })),
    });
  }),
);

const waitlistSchema = z.object({ email: z.string().email() });

eventsRouter.post(
  "/:slug/waitlist",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const body = waitlistSchema.parse(req.body);
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) throw new HttpError(404, "Event not found");

    const existing = await prisma.waitlistEntry.findUnique({
      where: { eventId_email: { eventId: event.id, email: body.email.toLowerCase() } },
    });
    if (existing) throw new HttpError(409, "Already on the waitlist for this event");

    await prisma.waitlistEntry.create({ data: { eventId: event.id, email: body.email.toLowerCase() } });
    res.status(201).json({ ok: true });
  }),
);

/**
 * Read-only preview so Checkout can show "code applied, -X MAD" before the
 * buyer commits. The real checkout re-validates the same code inside the
 * order transaction (routes/orders.ts) — this route never reserves a use or
 * touches inventory, it only answers "would this code currently work".
 */
eventsRouter.get(
  "/:slug/quote-promo",
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const subtotalCents = Number(req.query.subtotalCents ?? 0);

    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) throw new HttpError(404, "Event not found");

    const candidates: PromoCandidate[] = (
      await prisma.promoCode.findMany({ where: { OR: [{ eventId: event.id }, { eventId: null }] } })
    ).map((promo) => ({
      id: promo.id,
      code: promo.code,
      kind: promo.kind,
      value: promo.value,
      eventId: promo.eventId,
      maxUses: promo.maxUses,
      uses: promo.uses,
    }));

    const quote = quotePromo(candidates, code, event.id, subtotalCents);
    if (!quote) {
      res.json({ valid: false, discountCents: 0 });
      return;
    }
    res.json({ valid: true, discountCents: quote.discountCents });
  }),
);

