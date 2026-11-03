import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, requirePermission, userHasPermission } from "../middleware/auth.js";
import { organiserScope } from "../domain/auth.js";
import { feeForOrder, normaliseRib, ribOk, summariseRevenue } from "../domain/commission.js";
import { salesWindowOk } from "../domain/inventory.js";
import { organiserEarnings } from "../lib/payout.js";
import { isPeriodKey } from "../domain/period.js";
import { publicEvent, publicOrderWithContext } from "../lib/serialize.js";
import { committedForTier, remainingByTier } from "../lib/availability.js";
import { broadcastRateLimit } from "../middleware/rateLimit.js";
import { sendEmail } from "../lib/email.js";
import { broadcastHtml } from "../lib/email-templates.js";
import { reconcileExternalRefund } from "../lib/refund.js";
import { cancelEvent } from "../lib/event-cancel.js";
import { issueComps, revokeComp } from "../lib/invitations.js";
import { AUDIT_ACTIONS, recordAudit } from "../lib/audit.js";
import { offerFreedSeats } from "../lib/waitlist.js";
import { reissueTicket, renameHolder } from "../lib/ticket-admin.js";

export const organiserRouter = Router();

/**
 * Authentication only. The capability check belongs on each route.
 *
 * This used to be `requirePermission("events.manage")` for the whole router,
 * which made four permissions decorative: finance.view, finance.refund,
 * orders.manage and gate.checkin were all in the vocabulary and all toggleable
 * in the Permissions screen, while nothing read them here. An admin could
 * revoke finance.view and the organiser would keep reading revenue — verified
 * before this was split, with /stats returning the gross after the revoke.
 *
 * It was also too broad in the other direction: someone granted only
 * orders.manage, to work the order desk and nothing else, could not reach the
 * order routes at all because they lacked events.manage.
 *
 * Each route below now names the capability it actually needs. `authenticate`
 * stays here because every one of them needs a user.
 */
organiserRouter.use(authenticate);

/** The catalogue: events and their ticket tiers. */
const canManageEvents = requirePermission("events.manage");
/** The order desk: reading orders, admitting, re-issuing, cancelling. */
const canManageOrders = requirePermission("orders.manage");
/** Revenue, payout and platform-fee figures. */
const canViewFinance = requirePermission("finance.view");
/** Moving money back to a buyer. */
const canRefund = requirePermission("finance.refund");

/**
 * The `?organiserId=` override on the list routes below.
 *
 * Returns the raw value; whether it is HONOURED is decided by
 * organiserScope(), which ignores it unless the caller may act platform-wide.
 * Parsing lives here, once, so there is exactly one place a future change
 * could get the parsing wrong — and exactly one place (organiserScope) that
 * can get the authorisation wrong.
 */
function requestedOrganiserId(req: { query: { organiserId?: unknown } }): string | undefined {
  const value = req.query.organiserId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The scope fragment for a list route, with the capability resolved. */
async function scopeFor(req: Request): Promise<{ organiserId?: string }> {
  const mayActAnywhere = await userHasPermission(req.user, "scope.any");
  return organiserScope(req.user!, mayActAnywhere, requestedOrganiserId(req));
}

/**
 * Who an event BELONGS to — which is a money question, not a permissions one.
 *
 * `event.organiserId` decides three things that all follow the owner and
 * nothing else: who the payout pays, which plan's rate prices the commission,
 * and which bank account the transfer reaches. Creation used to hardcode it to
 * `req.user.id`, so an admin setting an event up on an organiser's behalf
 * silently became its payee — with no field to correct it, because neither the
 * create nor the update schema accepted one. Fifteen of the sixteen seeded
 * events were owned by the admin for exactly this reason.
 *
 * So ownership is now stated, not inferred:
 *
 *   - an organiser may only ever own their own events, and omits the field;
 *   - a caller with `scope.any` MUST name one, because defaulting to
 *     themselves is the mistake this exists to prevent. Silently owning an
 *     event is not discovered until someone is owed money.
 *
 * The target is checked to be a real ORGANISER. Without that the bug simply
 * moves: an id naming a customer would create an event whose earnings nobody
 * can be paid, and an id naming another admin would reinstate the original
 * problem by hand.
 */
async function resolveOwner(req: Request, requested?: string): Promise<string> {
  const mayActAnywhere = await userHasPermission(req.user, "scope.any");

  if (!mayActAnywhere) {
    // An organiser naming someone else is refused outright rather than
    // ignored: quietly creating it under their own name would look like the
    // request succeeded as asked.
    if (requested && requested !== req.user!.id) {
      throw new HttpError(403, "You can only create events for yourself");
    }
    return req.user!.id;
  }

  if (!requested) {
    throw new HttpError(400, "Choose which organiser this event belongs to");
  }

  const target = await prisma.user.findUnique({
    where: { id: requested },
    select: { id: true, role: true },
  });
  if (!target) throw new HttpError(404, "No such organiser");
  if (target.role !== "ORGANISER") {
    throw new HttpError(400, "That account is not an organiser");
  }
  return target.id;
}

organiserRouter.get(
  "/events",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const events = await prisma.event.findMany({
      where: await scopeFor(req),
      include: { tiers: true, lineup: true, organiser: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    /*
     * Who each event belongs to — for a caller who can see across organisers.
     *
     * Attached HERE rather than in publicEvent(), which also serves the public
     * catalogue: an organiser's name and email are not something an anonymous
     * visitor should be handed with every listing.
     *
     * Gated on `scope.any` because that is exactly the caller whose list can
     * contain more than one organiser's events, and therefore the only one for
     * whom the column means anything. An organiser's own list is all theirs,
     * so repeating their name on every card would be noise.
     */
    const mayActAnywhere = await userHasPermission(req.user, "scope.any");
    const shaped = await Promise.all(
      events.map(async (event) => ({
        ...publicEvent(event, await remainingByTier(event.id)),
        ...(mayActAnywhere
          ? {
              organiser: event.organiser
                ? { id: event.organiser.id, name: event.organiser.name, email: event.organiser.email }
                : // organiserId is nullable: the owner's account was deleted.
                  // Sent as null rather than omitted, so the UI can say so
                  // instead of silently showing nothing.
                  null,
            }
          : {}),
      })),
    );
    res.json({ events: shaped });
  }),
);

const tierInput = z.object({
  nameFr: z.string(),
  nameAr: z.string(),
  blurbFr: z.string(),
  blurbAr: z.string(),
  priceCents: z.number().int().min(0),
  capacity: z.number().int().min(1),
  numbered: z.boolean().optional(),
  /** False for a tier that is a duration or a credential, not a place. */
  spatial: z.boolean().optional(),
  /** 0 = nearest the action. Null clears it and falls back to price. */
  planOrder: z.number().int().min(0).max(99).nullable().optional(),
  seatsPerRow: z.number().int().min(1).max(100).optional(),
  perks: z.array(z.string()).optional(),
  /** ISO timestamps. Both omitted means on sale whenever the event is. */
  salesStartAt: z.string().datetime().nullish(),
  salesEndAt: z.string().datetime().nullish(),
  zoneFr: z.string(),
  zoneAr: z.string(),
  gateFr: z.string(),
  gateAr: z.string(),
});

const createEventSchema = z.object({
  slug: z.string().min(3),
  /** Who the event belongs to, and therefore who gets paid for it. Required
   * of an admin, omitted by an organiser creating their own. See
   * resolveOwner() for why it is stated rather than inferred. */
  organiserId: z.string().optional(),
  /** Tickets one buyer may hold for this event, across every order. 0 = no
   * limit. Defaults to the schema's 10 when omitted. */
  maxPerBuyer: z.number().int().min(0).max(100).optional(),
  /** Whether buyers may resell. Off unless the organiser asks for it. */
  allowResale: z.boolean().optional(),
  titleFr: z.string().min(3),
  titleAr: z.string().min(3),
  category: z.string(),
  city: z.string(),
  venueFr: z.string(),
  /** How the site plan is drawn. Defaults to STAGE in the schema. */
  venueKind: z.enum(["STAGE", "HALL", "STADIUM", "COURSE", "EXPO", "OPEN_AIR"]).optional(),
  venueAr: z.string(),
  address: z.string(),
  start: z.string(),
  end: z.string(),
  doors: z.string(),
  image: z.string(),
  blurbFr: z.string(),
  blurbAr: z.string(),
  aboutFr: z.string(),
  aboutAr: z.string(),
  ageFr: z.string(),
  ageAr: z.string(),
  tiers: z.array(tierInput).min(1),
});

/**
 * Tier input -> Prisma data, with the sales window parsed and checked.
 *
 * The window is validated when the organiser SAVES, not when a buyer hits it:
 * an inverted window silently takes the tier off sale forever, and finding
 * that out from an empty sales report is far worse than a validation error.
 */
function toTierData<T extends { salesStartAt?: string | null; salesEndAt?: string | null }>(tier: T) {
  const salesStartAt = tier.salesStartAt ? new Date(tier.salesStartAt) : null;
  const salesEndAt = tier.salesEndAt ? new Date(tier.salesEndAt) : null;
  if (!salesWindowOk({ salesStartAt, salesEndAt })) {
    throw new HttpError(400, "A zone's sales window must open before it closes");
  }
  return { ...tier, salesStartAt, salesEndAt };
}

organiserRouter.post(
  "/events",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const body = createEventSchema.parse(req.body);
    const existing = await prisma.event.findUnique({ where: { slug: body.slug } });
    if (existing) throw new HttpError(409, "An event with this slug already exists");

    // Resolved before the write: an unassignable owner must not leave a
    // half-created event behind.
    const organiserId = await resolveOwner(req, body.organiserId);

    const event = await prisma.event.create({
      data: {
        slug: body.slug,
        organiserId,
        status: "PUBLISHED",
        titleFr: body.titleFr,
        titleAr: body.titleAr,
        category: body.category,
        city: body.city,
        venueFr: body.venueFr,
        venueAr: body.venueAr,
        address: body.address,
        startAt: new Date(body.start),
        endAt: new Date(body.end),
        doorsAt: new Date(body.doors),
        image: body.image,
        blurbFr: body.blurbFr,
        blurbAr: body.blurbAr,
        aboutFr: body.aboutFr,
        aboutAr: body.aboutAr,
        ageFr: body.ageFr,
        ageAr: body.ageAr,
        maxPerBuyer: body.maxPerBuyer,
        allowResale: body.allowResale,
        tiers: { create: body.tiers.map(toTierData) },
      },
      include: { tiers: true, lineup: true },
    });

    /*
     * Only when an admin assigned it to someone else.
     *
     * An organiser creating their own event is ordinary authoring and stays
     * out of the journal, per the rule in lib/audit.ts. Naming a payee other
     * than yourself is the part worth being able to account for.
     */
    if (organiserId !== req.user!.id) {
      recordAudit(req, {
        action: AUDIT_ACTIONS.EVENT_OWNER_ASSIGNED,
        subjectType: "event",
        subjectId: event.id,
        subjectLabel: event.slug,
        details: { organiserId },
      });
    }

    res.status(201).json({ event: publicEvent(event, await remainingByTier(event.id)) });
  }),
);

async function requireOwnedEvent(user: Express.Request["user"], slug: string) {
  const event = await prisma.event.findUnique({ where: { slug } });
  if (!event) throw new HttpError(404, "Event not found");
  if (event.organiserId !== user!.id && !(await userHasPermission(user, "scope.any"))) {
    throw new HttpError(403, "Not your event");
  }
  return event;
}

organiserRouter.patch(
  "/events/:slug/visibility",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const hidden = Boolean(req.body?.hidden);

    /*
     * A cancelled event cannot be put back on sale from here.
     *
     * Cancelling sets status CANCELLED, refunds every buyer and voids every
     * ticket. This route wrote PUBLISHED unconditionally, so the "restore"
     * eye on the dashboard overwrote that status and the event reappeared in
     * the public catalogue — with its tickets already refunded and voided,
     * and sellable again. Verified: cancel, click restore, and a new order
     * went through end to end.
     *
     * Hiding a cancelled event is still allowed: that only takes it further
     * out of sight, which is never the wrong direction.
     */
    if (!hidden && event.cancelledAt) {
      throw new HttpError(409, "This event was cancelled and cannot be put back on sale");
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { status: hidden ? "HIDDEN" : "PUBLISHED" },
      include: { tiers: true, lineup: true },
    });
    res.json({ event: publicEvent(updated, await remainingByTier(updated.id)) });
  }),
);

organiserRouter.delete(
  "/events/:slug",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);

    // Order -> Event is onDelete Restrict, so an event anyone has ever
    // ordered against cannot be deleted. Checking first turns what was a
    // raw Postgres 23001 and a 500 into an answer the organiser can act on:
    // an event with sales is history, and hiding it is the real intent.
    const orders = await prisma.order.count({ where: { eventId: event.id } });
    if (orders > 0) {
      throw new HttpError(
        409,
        `This event has ${orders} order(s) and cannot be deleted. Hide it instead to take it off sale.`,
      );
    }

    await prisma.event.delete({ where: { id: event.id } });
    res.status(204).end();
  }),
);

/*
 * What may be corrected after an event exists.
 *
 * This used to be title/city/image only, which meant a typo in the VENUE, a
 * wrong street address, or a mistake in the description could never be fixed:
 * there was no route that accepted them, and an event with sales cannot be
 * deleted and rebuilt. Everything below is text a buyer reads and an
 * organiser can get wrong, so all of it is correctable.
 *
 * Still deliberately absent:
 *   - start/end/doors. Moving a date buyers have planned around is not a text
 *     correction; it needs to tell them. Until that exists, no route accepts
 *     a new date (see the note in lib/audit.ts about event.rescheduled).
 *   - maxPerBuyer / allowResale, which have their own /settings route.
 *   - slug, which is the public URL and is already printed on tickets.
 */
const updateEventSchema = z.object({
  titleFr: z.string().min(3).optional(),
  titleAr: z.string().min(3).optional(),
  category: z.string().min(2).optional(),
  city: z.string().optional(),
  venueFr: z.string().min(2).optional(),
  venueKind: z.enum(["STAGE", "HALL", "STADIUM", "COURSE", "EXPO", "OPEN_AIR"]).optional(),
  venueAr: z.string().min(2).optional(),
  address: z.string().min(3).optional(),
  image: z.string().optional(),
  blurbFr: z.string().min(3).optional(),
  blurbAr: z.string().min(3).optional(),
  aboutFr: z.string().min(3).optional(),
  aboutAr: z.string().min(3).optional(),
  ageFr: z.string().min(1).optional(),
  ageAr: z.string().min(1).optional(),
  /** Hand the event to a different organiser. Admin-only, and refused once
   * the event has settled money — see the route below. */
  organiserId: z.string().optional(),
});

/** Content fields only (title/city) — not the tiers, which carry sold
 * tickets and shouldn't be silently rewritten from here. */
organiserRouter.patch(
  "/events/:slug",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const { organiserId: requestedOwner, ...content } = updateEventSchema.parse(req.body);

    /*
     * Handing the event to a different organiser.
     *
     * Separated from the content fields because it is not an edit to the
     * listing — it changes who is owed the money. Two rules:
     *
     *  1. Only a caller with `scope.any`. resolveOwner() enforces that, and
     *     also that the target is a real ORGANISER rather than a customer
     *     nobody can pay or another admin.
     *
     *  2. Refused once the event has settled orders. The platform fee is
     *     recorded AT SETTLEMENT against the owner's plan and never
     *     recomputed, so moving the event afterwards would leave past payouts
     *     and recorded fees describing an owner the event no longer has —
     *     and the new owner credited for sales they did not make. A genuine
     *     mistake has to be fixed before anything sells.
     */
    // `from` may be null: organiserId is nullable so an event survives its
    // organiser's account being deleted (onDelete: SetNull). Re-homing one of
    // those orphans is the clearest legitimate use of this field.
    let ownerChange: { from: string | null; to: string } | null = null;
    if (requestedOwner !== undefined && requestedOwner !== event.organiserId) {
      const nextOwner = await resolveOwner(req, requestedOwner);
      if (nextOwner !== event.organiserId) {
        const settled = await prisma.order.count({
          where: { eventId: event.id, status: { in: ["PAID", "REFUNDED"] }, NOT: { paymentRef: "COMP" } },
        });
        if (settled > 0) {
          throw new HttpError(
            409,
            `Cannot reassign: ${settled} paid order(s) have already settled to the current organiser`,
          );
        }
        ownerChange = { from: event.organiserId, to: nextOwner };
      }
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: ownerChange ? { ...content, organiserId: ownerChange.to } : content,
      include: { tiers: true, lineup: true },
    });

    if (ownerChange) {
      recordAudit(req, {
        action: AUDIT_ACTIONS.EVENT_OWNER_CHANGED,
        subjectType: "event",
        subjectId: event.id,
        subjectLabel: event.slug,
        details: { from: ownerChange.from, to: ownerChange.to },
      });
    }

    res.json({ event: publicEvent(updated, await remainingByTier(updated.id)) });
  }),
);

/**
 * Resale activity on this organiser's events.
 *
 * An organiser could already switch resale ON per event and had no way to
 * see the result: who is reselling, at what price, what has sold. The
 * setting existed, its consequences did not.
 *
 * Scoped to events the caller owns, except with `scope.any` — the same rule
 * every other list here follows. Buyer identity is deliberately NOT
 * returned: the organiser needs to know a seat changed hands, not who holds
 * it now; the gate reads the ticket, and the holder's name is on it.
 */
organiserRouter.get(
  "/resales",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const mayActAnywhere = await userHasPermission(req.user, "scope.any");
    const slug = typeof req.query.slug === "string" ? req.query.slug : null;

    const listings = await prisma.resaleListing.findMany({
      where: {
        ticket: {
          tier: {
            event: {
              ...(mayActAnywhere ? {} : { organiserId: req.user!.id }),
              ...(slug ? { slug } : {}),
            },
          },
        },
      },
      include: {
        ticket: {
          include: {
            tier: {
              include: {
                // The owner, for the admin-only column below. Selected
                // rather than included whole: this is a staff list, but an
                // organiser's password hash has no business leaving the
                // database to render a name.
                event: { include: { organiser: { select: { id: true, name: true, email: true } } } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      // Capped: this grows with every listing ever made, and a dashboard
      // that fetches all of it gets slower every week.
      take: 200,
    });

    res.json({
      resales: listings.map((l) => ({
        id: l.id,
        status: l.status,
        priceCents: l.priceCents,
        createdAt: l.createdAt.toISOString(),
        soldAt: l.soldAt?.toISOString() ?? null,
        ticketId: l.ticketId,
        ticketRef: l.ticket.ref,
        seatRow: l.ticket.seatRow,
        seatNumber: l.ticket.seatNumber,
        tierNameFr: l.ticket.tier.nameFr,
        tierNameAr: l.ticket.tier.nameAr,
        eventSlug: l.ticket.tier.event.slug,
        eventTitleFr: l.ticket.tier.event.titleFr,
        eventTitleAr: l.ticket.tier.event.titleAr,
        /*
         * Who owns the event, for `scope.any` only — the same rule and the
         * same reason as GET /events above: an admin's list spans several
         * organisers and is unreadable without it, while an organiser's own
         * list is all theirs, so the column would be their own name on every
         * row.
         */
        ...(mayActAnywhere
          ? {
              organiser: l.ticket.tier.event.organiser
                ? {
                    id: l.ticket.tier.event.organiser.id,
                    name: l.ticket.tier.event.organiser.name,
                    email: l.ticket.tier.event.organiser.email,
                  }
                : // organiserId is nullable: the owner's account was deleted.
                  // Null rather than omitted, so the table can say so instead
                  // of rendering a blank cell that reads as a loading bug.
                  null,
            }
          : {}),
      })),
    });
  }),
);

organiserRouter.get(
  "/orders",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: { event: await scopeFor(req) },
      include: { tickets: true, event: { select: { titleFr: true, titleAr: true, slug: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        holderName: order.holderName,
        email: order.email,
        totalCents: order.totalCents,
        createdAt: order.createdAt.toISOString(),
        eventSlug: order.event.slug,
        eventTitleFr: order.event.titleFr,
        ticketCount: order.tickets.length,
      })),
    });
  }),
);

organiserRouter.get(
  "/events/:slug/waitlist",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const entries = await prisma.waitlistEntry.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      entries: entries.map((entry) => ({
        email: entry.email,
        createdAt: entry.createdAt.toISOString(),
        status: entry.status,
        offeredAt: entry.offeredAt?.toISOString() ?? null,
        claimExpiresAt: entry.claimExpiresAt?.toISOString() ?? null,
        // The token is a credential — the organiser's view never needs it.
      })),
    });
  }),
);

/** Richer than GET /orders above: full ticket detail (ref, status, tier,
 * event) so the Pro dashboard's Orders section can search/filter/admit
 * without a second round-trip per order. */
organiserRouter.get(
  "/orders/detailed",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: { event: await scopeFor(req) },
      include: { tickets: { include: { tier: { include: { event: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ orders: orders.map((o) => publicOrderWithContext(o)) });
  }),
);

/**
 * One order, in full — the page an organiser opens when a buyer phones up.
 *
 * Deliberately NOT served by filtering /orders/detailed client-side: that
 * route returns every order on the event, so a support lookup would download
 * the whole book to read one page. It also cannot carry the audit trail,
 * which is the half of this answer that says what was already DONE about the
 * problem (refunded by whom, cancelled when) rather than only the current
 * state.
 */
organiserRouter.get(
  "/orders/:id",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    // Ownership first: the same check every other order route makes, so an
    // organiser cannot read a neighbour's order by guessing an id.
    await requireOwnedOrder(req.user, id);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        tickets: { include: { tier: { include: { event: true } } } },
        event: true,
        promoCode: true,
      },
    });
    if (!order) throw new HttpError(404, "Order not found");

    // The subject id is the order's, so this is every action taken ON this
    // order. Capped: a pathological row count must not turn a support lookup
    // into a slow query.
    const audit = await prisma.auditEvent.findMany({
      where: { subjectType: "order", subjectId: id },
      orderBy: { at: "desc" },
      take: 50,
    });

    res.json({
      order: publicOrderWithContext(order),
      event: {
        slug: order.event.slug,
        titleFr: order.event.titleFr,
        titleAr: order.event.titleAr,
        startAt: order.event.startAt.toISOString(),
        venueFr: order.event.venueFr,
        venueAr: order.event.venueAr,
      },
      promo: order.promoCode ? { code: order.promoCode.code, kind: order.promoCode.kind, value: order.promoCode.value } : null,
      audit: audit.map((row) => ({
        id: row.id,
        action: row.action,
        actorEmail: row.actorEmail,
        actorRole: row.actorRole,
        at: row.at.toISOString(),
        details: row.details,
      })),
    });
  }),
);

async function requireOwnedOrder(user: Express.Request["user"], orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { event: true } });
  if (!order) throw new HttpError(404, "Order not found");
  if (order.event.organiserId !== user!.id && !(await userHasPermission(user, "scope.any"))) {
    throw new HttpError(403, "Not your order");
  }
  return order;
}

/** Cancels every ticket on the order and returns its inventory — mirrors the
 * same "status flip + implicit stock release" pattern remainingByTier()
 * already relies on (only PAID orders with VALID/USED tickets count against
 * capacity, so flipping to CANCELLED here is enough; no separate stock
 * counter to decrement). */
organiserRouter.post(
  "/orders/:id/cancel",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const cancelled = await requireOwnedOrder(req.user, id);
    await prisma.$transaction([
      prisma.order.update({ where: { id }, data: { status: "CANCELLED" } }),
      prisma.ticket.updateMany({ where: { orderId: id }, data: { status: "CANCELLED" } }),
    ]);
    /*
     * `order.cancelled` existed in the vocabulary and nothing recorded it.
     *
     * This voids a buyer's tickets without refunding them, so "who cancelled
     * my order?" is a question support has to be able to answer — and the
     * amount is noted because an unrefunded cancellation of a paid order is
     * the case worth finding later.
     */
    recordAudit(req, {
      action: AUDIT_ACTIONS.ORDER_CANCELLED,
      subjectType: "order",
      subjectId: id,
      subjectLabel: cancelled.email,
      details: {
        wasStatus: cancelled.status,
        totalCents: cancelled.totalCents,
        refundedCents: cancelled.refundedCents,
      },
    });

    // Those seats are free again — offer them to the waitlist.
    void offerFreedSeats(cancelled.eventId);
    res.json({ ok: true });
  }),
);

organiserRouter.delete(
  "/orders/:id",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const doomed = await requireOwnedOrder(req.user, id);

    /*
     * Recorded BEFORE the delete, and with the figures inline.
     *
     * This is the one write with nothing left to look at afterwards: the row
     * goes, and its tickets cascade with it. A row that only held the id
     * would say an order was destroyed without saying whose or for how much,
     * which is no answer at all when someone asks where their ticket went.
     */
    recordAudit(req, {
      action: AUDIT_ACTIONS.ORDER_DELETED,
      subjectType: "order",
      subjectId: id,
      subjectLabel: doomed.email,
      details: {
        wasStatus: doomed.status,
        totalCents: doomed.totalCents,
        refundedCents: doomed.refundedCents,
        eventId: doomed.eventId,
      },
    });

    await prisma.order.delete({ where: { id } });
    res.status(204).end();
  }),
);

const admitSchema = z.object({ status: z.enum(["VALID", "USED"]) });

/** Manual admit/undo toggle for the Orders desk — distinct from the gate's
 * ref-scan check-in (routes/gate.ts), which is the real entry point at the
 * door. This is for an organiser fixing a record after the fact. */
organiserRouter.patch(
  "/tickets/:id/status",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = admitSchema.parse(req.body);
    const ticket = await prisma.ticket.findUnique({ where: { id }, include: { order: { include: { event: true } } } });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.order.event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your ticket");
    }
    const updated = await prisma.ticket.update({
      where: { id },
      data: { status: body.status, usedAt: body.status === "USED" ? new Date() : null },
    });

    /*
     * Re-admitting a spent ticket is the override most worth a trail: it makes
     * a used ticket work again, and "who let this one back in?" has to have an
     * answer. The previous status is recorded because that is the actual
     * question — undoing a check-in and confirming one both land here.
     */
    recordAudit(req, {
      action: AUDIT_ACTIONS.TICKET_STATUS_OVERRIDDEN,
      subjectType: "ticket",
      subjectId: updated.id,
      subjectLabel: ticket.ref,
      details: { from: ticket.status, to: updated.status, eventSlug: ticket.order.event.slug },
    });

    res.json({ ticket: { id: updated.id, status: updated.status } });
  }),
);

const broadcastSchema = z.object({
  subject: z.string().min(3).max(150),
  message: z.string().min(10).max(5000),
});

/** Recipient list for a broadcast: one entry per distinct buyer address on
 * non-cancelled orders for this event. */
async function broadcastRecipients(eventId: string) {
  const orders = await prisma.order.findMany({
    where: { eventId, status: { not: "CANCELLED" } },
    select: { email: true, holderName: true },
  });
  const byEmail = new Map<string, string>();
  for (const order of orders) {
    if (!byEmail.has(order.email)) byEmail.set(order.email, order.holderName);
  }
  return [...byEmail.entries()].map(([email, name]) => ({ email, name }));
}

/** How many people a broadcast would reach — lets the UI show a count before
 * the organiser commits to sending. */
organiserRouter.get(
  "/events/:slug/audience",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const recipients = await broadcastRecipients(event.id);
    res.json({ count: recipients.length });
  }),
);

organiserRouter.post(
  "/events/:slug/broadcast",
  canManageEvents,
  broadcastRateLimit,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const body = broadcastSchema.parse(req.body);

    const recipients = await broadcastRecipients(event.id);
    if (recipients.length === 0) throw new HttpError(422, "No buyers to contact for this event");

    const html = broadcastHtml({
      locale: "fr",
      eventTitle: event.titleFr,
      subject: body.subject,
      message: body.message,
    });

    // Sequential rather than Promise.all: a burst of parallel sends is what
    // trips provider rate limits, and this runs at human scale.
    let sent = 0;
    for (const recipient of recipients) {
      const ok = await sendEmail({ to: recipient.email, subject: body.subject, html });
      if (ok) sent += 1;
    }

    res.json({ recipients: recipients.length, sent });
  }),
);

/**
 * Lightweight dashboard counters, aggregated in SQL.
 *
 * Deliberately NOT /orders/detailed: that hydrates every order with every
 * ticket and each ticket's tier and event, which is fine to render a table
 * once and far too heavy to poll. These are COUNT/SUM over indexed columns.
 */
organiserRouter.get(
  "/stats",
  canViewFinance,
  asyncHandler(async (req, res) => {
    /*
     * `?eventSlug=` narrows the figures to one show.
     *
     * The filter is added INSIDE the ownership scope, never instead of it, so
     * naming someone else's slug returns their event no rows rather than
     * their revenue. An unknown or unowned slug therefore reads as an empty
     * event — which is also the honest answer for an event with no sales.
     *
     * Without this an organiser running two shows saw one combined total and
     * could not tell how either had done.
     */
    const eventSlug = typeof req.query.eventSlug === "string" ? req.query.eventSlug : null;
    const events = await prisma.event.findMany({
      where: { ...(await scopeFor(req)), ...(eventSlug ? { slug: eventSlug } : {}) },
      select: { id: true },
    });
    const eventIds = events.map((event) => event.id);

    if (eventIds.length === 0) {
      res.json({
        gmvCents: 0,
        grossCents: 0,
        refundedCents: 0,
        feeCents: 0,
        payableCents: 0,
        orders: 0,
        tickets: 0,
        inside: 0,
        // Echoed so a caller can tell "this one event sold nothing" from
        // "the filter matched no event I own".
        eventSlug,
        events: 0,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    /*
     * Revenue is counted NET OF REFUNDS.
     *
     * This used to sum `totalCents` of PAID orders only, which got it wrong
     * twice: a fully refunded order flips to REFUNDED and vanished from the
     * figure entirely, while a PARTIALLY refunded one stayed at full value.
     * So the headline revenue was neither gross nor net, and an organiser who
     * refunded half an order still saw all of it as earnings.
     */
    const [settled, tickets, inside, defaultPlan] = await Promise.all([
      prisma.order.findMany({
        // Comps excluded: PAID with totalCents 0, so they move no money — but
        // counting them would put the guest list in the order total.
        where: { eventId: { in: eventIds }, status: { in: ["PAID", "REFUNDED"] }, NOT: { paymentRef: "COMP" } },
        select: {
          totalCents: true,
          refundedCents: true,
          feeCents: true,
          // Needed only to price an UNRECORDED fee — see below.
          event: { select: { organiser: { select: { plan: true } } } },
        },
      }),
      prisma.ticket.count({
        where: { order: { eventId: { in: eventIds } }, status: { not: "CANCELLED" } },
      }),
      prisma.ticket.count({
        where: { order: { eventId: { in: eventIds } }, status: "USED" },
      }),
      prisma.plan.findFirst({ where: { isDefault: true } }),
    ]);

    /*
     * An order with no recorded fee is priced at ITS OWN organiser's plan.
     *
     * This route can span every organiser on the platform (an admin holding
     * scope.any), so one fallback plan for the whole set would charge some of
     * them at a rate they are not on — which is the bug the per-order lookup
     * avoids. Only legacy orders, settled before commission existed, take
     * this path at all.
     */
    const summary = summariseRevenue(
      settled.map((order) => ({
        totalCents: order.totalCents,
        refundedCents: order.refundedCents,
        feeCents:
          order.feeCents ??
          (order.event.organiser?.plan
            ? feeForOrder(order.totalCents, order.event.organiser.plan)
            : defaultPlan
              ? feeForOrder(order.totalCents, defaultPlan)
              : null),
      })),
    );

    res.json({
      // Kept as `gmvCents` so existing callers do not break, but it is now
      // net of refunds rather than a gross figure.
      gmvCents: summary.netRevenueCents,
      grossCents: summary.grossCents,
      refundedCents: summary.refundedCents,
      feeCents: summary.feeCents,
      payableCents: summary.payableCents,
      orders: settled.length,
      tickets,
      inside,
      // Which events these figures cover: the requested slug when one was
      // given, and the count, so a total is never mistaken for a single show.
      eventSlug,
      events: eventIds.length,
      generatedAt: new Date().toISOString(),
    });
  }),
);

/*
 * There is no discretionary refund route any more.
 *
 * POST /orders/:id/refund let an organiser return a buyer's money on any
 * order, for any reason. Tickets are final sale: a refund now happens for
 * exactly one reason, which is that the EVENT was called off — the
 * organiser's doing, not the buyer's — and that path runs through
 * /events/:slug/cancel, which refunds every order at once.
 *
 * What remains for an organiser faced with a buyer who wants their money
 * back:
 *
 *  - say no, which is the policy;
 *  - reverse the charge in the CMI back office and then call
 *    /orders/:id/reconcile-refund below, so the tickets are voided and the
 *    books match what the gateway actually did;
 *  - /orders/:id/cancel, which voids the tickets WITHOUT returning money and
 *    records that plainly.
 *
 * `finance.refund` still gates reconcile-refund, so the permission and
 * everything granted it keep working.
 */

const reconcileSchema = z.object({
  /** The running TOTAL reversed at CMI for this transaction, in cents. */
  amountRefundedCents: z.number().int().positive(),
});

/**
 * Reconcile a refund already made in the CMI back office.
 *
 * CMI sends nothing when a merchant reverses a transaction there, so the
 * books can silently disagree with the gateway — and, worse, the tickets stay
 * VALID, meaning someone who has had their money back still gets in. This is
 * the manual correction for that, and it never moves money.
 */
organiserRouter.post(
  "/orders/:id/reconcile-refund",
  canRefund,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const order = await requireOwnedOrder(req.user, id);
    const body = reconcileSchema.parse(req.body ?? {});
    if (!order.gatewayRef) throw new HttpError(409, "This order has no gateway transaction to reconcile");
    const result = await reconcileExternalRefund(order.gatewayRef, body.amountRefundedCents);
    if (!result) return res.json({ reconciled: false, reason: "Already recorded" });
    recordAudit(req, {
      action: AUDIT_ACTIONS.ORDER_REFUND_RECONCILED,
      subjectType: "order",
      subjectId: id,
      details: { amountRefundedCents: body.amountRefundedCents, full: result.full },
    });
    res.json({ reconciled: true, ...result });
  }),
);

// ─── Placements: tier (zone) management ──────────────────────────────────
//
// Tiers used to be write-once — set at event creation and unchangeable after,
// so a wrong price or a missing zone meant deleting the event and starting
// again. These routes make a published event's seating editable, with the one
// rule that matters: nothing may invalidate a ticket already sold.

const tierPatchSchema = z.object({
  nameFr: z.string().min(1).optional(),
  nameAr: z.string().min(1).optional(),
  blurbFr: z.string().optional(),
  blurbAr: z.string().optional(),
  priceCents: z.number().int().min(0).optional(),
  capacity: z.number().int().min(1).optional(),
  numbered: z.boolean().optional(),
  /** False for a tier that is a duration or a credential, not a place. */
  spatial: z.boolean().optional(),
  /** 0 = nearest the action. Null clears it and falls back to price. */
  planOrder: z.number().int().min(0).max(99).nullable().optional(),
  seatsPerRow: z.number().int().min(1).max(100).optional(),
  perks: z.array(z.string()).optional(),
  salesStartAt: z.string().datetime().nullish(),
  salesEndAt: z.string().datetime().nullish(),
  recommended: z.boolean().optional(),
  zoneFr: z.string().optional(),
  zoneAr: z.string().optional(),
  gateFr: z.string().optional(),
  gateAr: z.string().optional(),
});

/** Seats of a tier someone already holds — the floor for a capacity change. */
const soldForTier = committedForTier;

/** Tiers of one event, each with what's already committed — the figure an
 * organiser needs before changing capacity. */
organiserRouter.get(
  "/events/:slug/tiers",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const tiers = await prisma.ticketTier.findMany({ where: { eventId: event.id }, orderBy: { priceCents: "asc" } });
    const withSold = await Promise.all(
      tiers.map(async (tier) => {
        const sold = await soldForTier(tier.id);
        return { ...tier, sold, remaining: Math.max(0, tier.capacity - sold) };
      }),
    );
    res.json({ tiers: withSold });
  }),
);

organiserRouter.post(
  "/events/:slug/tiers",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    // toTierData, not the raw body: it parses the window and refuses an
    // inverted one. Creating straight from tierInput accepted a zone whose
    // sales close before they open — which is silently never on sale, the
    // exact failure the PATCH below is careful to prevent.
    const body = toTierData(tierInput.parse(req.body));
    const tier = await prisma.ticketTier.create({ data: { ...body, eventId: event.id } });
    res.status(201).json({ tier });
  }),
);

organiserRouter.patch(
  "/tiers/:id",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const tier = await prisma.ticketTier.findUnique({ where: { id }, include: { event: true } });
    if (!tier) throw new HttpError(404, "Tier not found");
    if (tier.event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your event");
    }
    const body = tierPatchSchema.parse(req.body);

    /*
     * How many seats this zone has already committed.
     *
     * Needed for the capacity guard below, and recorded in the audit details
     * for a price change too: repricing a zone nobody has bought is routine,
     * while repricing one that has already sold is the thing an organiser may
     * be asked about. The number is what tells those two apart later.
     */
    const sold = await soldForTier(id);

    // Capacity may grow freely, but shrinking below what's already committed
    // would oversell retroactively — someone holding a valid ticket would
    // have no seat.
    if (body.capacity !== undefined && body.capacity < sold) {
      throw new HttpError(409, `Capacity cannot go below the ${sold} seat(s) already sold or held`);
    }

    /*
     * The window is validated against the MERGED state, not the patch alone.
     *
     * Patching only salesEndAt has to be checked against the start already
     * stored, or an organiser could invert an existing window one field at a
     * time and take the tier off sale without ever seeing an error.
     */
    const merged = {
      salesStartAt:
        body.salesStartAt === undefined ? tier.salesStartAt : body.salesStartAt ? new Date(body.salesStartAt) : null,
      salesEndAt:
        body.salesEndAt === undefined ? tier.salesEndAt : body.salesEndAt ? new Date(body.salesEndAt) : null,
    };
    if (!salesWindowOk(merged)) {
      throw new HttpError(400, "A zone's sales window must open before it closes");
    }

    const updated = await prisma.ticketTier.update({
      where: { id },
      data: { ...body, ...merged },
    });

    /*
     * Price and capacity are journalled; the rest of the patch is not.
     *
     * Renaming a zone or rewording its blurb is ordinary editing. Changing
     * what it costs, or how many seats exist, changes money and obligations
     * that buyers have already acted on — and both used to return a bare 200
     * with nothing recorded, so a tier that had sold at one price could be
     * repriced with no way to see it had happened.
     */
    if (body.priceCents !== undefined && body.priceCents !== tier.priceCents) {
      recordAudit(req, {
        action: AUDIT_ACTIONS.TIER_PRICE_CHANGED,
        subjectType: "tier",
        subjectId: updated.id,
        subjectLabel: `${tier.event.slug} · ${tier.nameFr}`,
        details: { fromCents: tier.priceCents, toCents: updated.priceCents, alreadySold: sold },
      });
    }
    if (body.capacity !== undefined && body.capacity !== tier.capacity) {
      recordAudit(req, {
        action: AUDIT_ACTIONS.TIER_CAPACITY_CHANGED,
        subjectType: "tier",
        subjectId: updated.id,
        subjectLabel: `${tier.event.slug} · ${tier.nameFr}`,
        details: { from: tier.capacity, to: updated.capacity, alreadySold: sold },
      });
    }

    /*
     * New seats go to the QUEUE before they go on sale.
     *
     * Adding capacity to a sold-out event is the clearest case there is of
     * seats becoming available, and it was the one path that did not tell the
     * waitlist. The seats simply appeared in the public catalogue, so anyone
     * refreshing the page bought the seats the people in the queue had been
     * waiting for — which is the opposite of what a queue is for.
     *
     * Only on an INCREASE. A decrease frees nothing, and re-offering on every
     * save would mail the queue each time an organiser corrected a typo in
     * the zone name.
     *
     * Fire-and-forget, like the other callers: the capacity change has already
     * been committed and must not fail because an offer email did not send.
     */
    if (body.capacity !== undefined && body.capacity > tier.capacity) {
      void offerFreedSeats(tier.eventId);
    }

    res.json({ tier: updated });
  }),
);

organiserRouter.delete(
  "/tiers/:id",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const tier = await prisma.ticketTier.findUnique({ where: { id }, include: { event: { include: { tiers: true } } } });
    if (!tier) throw new HttpError(404, "Tier not found");
    if (tier.event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your event");
    }

    // A tier with tickets against it is history, not inventory: deleting it
    // would cascade those tickets away. Set capacity to what's sold instead.
    const sold = await soldForTier(id);
    if (sold > 0) throw new HttpError(409, `This tier has ${sold} ticket(s) sold and cannot be deleted`);
    if (tier.event.tiers.length <= 1) throw new HttpError(409, "An event needs at least one ticket tier");

    await prisma.ticketTier.delete({ where: { id } });
    res.status(204).end();
  }),
);

// ─── Organiser-side ticket management ────────────────────────────────────

/** Reissue a lost ticket: the old ref and its QR stop working, a fresh one
 * replaces it. Voiding the old one is the point — the original may be in
 * someone else's hands, and leaving it valid would admit two people. */
organiserRouter.post(
  "/tickets/:id/reissue",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { order: { include: { event: true } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.order.event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your ticket");
    }
    const result = await reissueTicket(id);
    res.status(201).json(result);
  }),
);

const holderSchema = z.object({ holderName: z.string().min(2).max(80) });

/** Correct a misspelt holder name. Distinct from a transfer: the ticket stays
 * with the same buyer, the name just has to match the ID shown at the gate. */
organiserRouter.patch(
  "/tickets/:id/holder",
  canManageOrders,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const body = holderSchema.parse(req.body);
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { order: { include: { event: true } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.order.event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your ticket");
    }
    await renameHolder(id, body.holderName);
    res.json({ ok: true });
  }),
);

// ─── Finance: earnings, commission and bank details ──────────────────────
//
// The Finance screen used to compute all of this in the browser from a plan
// the organiser chose from a <select>, and store none of it. These routes make
// the figures the server's, which is the only way they can mean anything: the
// commission is recorded on each order at settlement, and the plan is set by
// an admin.

const planRequestSchema = z.object({
  planKey: z.string().min(1),
  /** Why they want it. Optional — the request stands on its own. */
  note: z.string().max(500).optional(),
});

/**
 * Ask to move onto a different plan.
 *
 * Note what this does NOT do: it does not change the plan. The organiser
 * could read the rates on their Finance screen and had no way to act on
 * them — the card said "get in touch" and offered no means of doing so — but
 * letting them switch directly would let anyone set themselves to 2% without
 * ever paying the subscription that buys it, since the monthly fee is only
 * withheld from a payout and someone with no payouts would pay nothing.
 *
 * So this records an intent for an admin to decide, exactly as becoming an
 * organiser already works. `finance.view` rather than a new capability: the
 * people who may read what the commission costs are the people who may ask
 * for a different rate.
 */
organiserRouter.post(
  "/plan-request",
  canViewFinance,
  asyncHandler(async (req, res) => {
    const body = planRequestSchema.parse(req.body);

    const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
    if (!plan) throw new HttpError(400, "No such plan");

    const me = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { planId: true },
    });
    /*
     * Compared against the plan they are EFFECTIVELY on.
     *
     * `planId` is null for most organisers — nobody has assigned them one, so
     * they are charged the default. Comparing the raw column let someone on
     * the default request the default: a request that changes nothing, which
     * an admin would then have to read and decline.
     */
    const effective = me.planId ?? (await prisma.plan.findFirst({ where: { isDefault: true } }))?.key ?? null;
    if (effective === plan.key) throw new HttpError(409, "You are already on this plan");

    // One open request at a time: a queue of three from the same organiser
    // is noise, and the admin can only act on the latest anyway.
    const open = await prisma.planRequest.findFirst({
      where: { userId: req.user!.id, status: "PENDING" },
      select: { id: true, planKey: true },
    });
    if (open) {
      throw new HttpError(409, "You already have a plan request waiting for a decision");
    }

    const request = await prisma.planRequest.create({
      data: {
        userId: req.user!.id,
        planKey: plan.key,
        // The plan they are effectively on, so a decision read months later
        // says what it replaced rather than an unexplained null.
        fromPlanKey: effective,
        note: body.note?.trim() || null,
      },
      select: { id: true, planKey: true, status: true, createdAt: true },
    });

    res.status(201).json({ request: { ...request, createdAt: request.createdAt.toISOString() } });
  }),
);

/** Withdraw a request before anyone has decided it. */
organiserRouter.delete(
  "/plan-request",
  canViewFinance,
  asyncHandler(async (req, res) => {
    // Scoped to PENDING and to this user: a decided request is a record, not
    // a draft, and must not be erasable by the person it was decided about.
    const updated = await prisma.planRequest.updateMany({
      where: { userId: req.user!.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    if (updated.count === 0) throw new HttpError(404, "No request is waiting");
    res.status(204).end();
  }),
);

/**
 * What this organiser has earned, what the platform took, and what is owed.
 *
 * Read-only on purpose. The plan comes back with the figures so the UI can
 * explain the fee, but there is no route here to CHANGE it — an organiser
 * picking their own commission rate is the bug this replaces. They may ASK,
 * via /plan-request above, which an admin decides.
 */
organiserRouter.get(
  "/finance",
  canViewFinance,
  asyncHandler(async (req, res) => {
    /*
     * Honours ?organiserId= only for a caller with scope.any, via the same
     * helper the list routes use.
     *
     * An admin who has NOT filtered gets every organiser, because the picker
     * above these figures says "All organisers" and this route has to mean
     * it. It used to fall back to `req.user.id` — the admin's own id — and an
     * admin owns no events, so the screen showed 0.00 revenue and 0.00
     * payable above a list of twenty-three real orders. Every other figure on
     * the page was already platform-wide; only this one disagreed.
     */
    const scope = await scopeFor(req);
    const mayActAnywhere = await userHasPermission(req.user, "scope.any");
    const organiserId = scope.organiserId ?? (mayActAnywhere ? null : req.user!.id);
    // An unknown ?period= falls back to all time rather than erroring: a
    // stale bookmark should show the dashboard, not a 400.
    const period = isPeriodKey(req.query.period) ? req.query.period : "all";
    res.json(await organiserEarnings(organiserId, period));
  }),
);

/** Payouts to this organiser, newest first. */
organiserRouter.get(
  "/payouts",
  canViewFinance,
  asyncHandler(async (req, res) => {
    /*
     * Same rule as /finance above: an admin who has not filtered sees every
     * organiser's payouts, not their own.
     *
     * Falling back to `req.user.id` showed an admin "No payouts yet" on a
     * platform that had already transferred money — because an admin owns no
     * events and therefore no payouts. The figures beside the list were
     * platform-wide, so the two halves of the screen disagreed.
     */
    const scope = await scopeFor(req);
    const mayActAnywhere = await userHasPermission(req.user, "scope.any");
    const organiserId = scope.organiserId ?? (mayActAnywhere ? null : req.user!.id);
    const payouts = await prisma.payout.findMany({
      where: organiserId === null ? {} : { organiserId },
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        grossCents: true,
        feeCents: true,
        subscriptionCents: true,
        netCents: true,
        reference: true,
        note: true,
        createdAt: true,
        paidAt: true,
        _count: { select: { orders: true } },
        subscriptions: { select: { month: true, amountCents: true, planKey: true } },
        // Only meaningful in the unfiltered admin view, where rows from
        // different organisers sit in one list and "4 132,50 MAD" alone does
        // not say who received it.
        organiser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        status: p.status,
        periodStart: p.periodStart.toISOString(),
        periodEnd: p.periodEnd.toISOString(),
        grossCents: p.grossCents,
        feeCents: p.feeCents,
        subscriptionCents: p.subscriptionCents,
        // Which months the subscription covered, so a deduction can be
        // explained rather than just subtracted.
        subscriptionMonths: p.subscriptions.map((sub) => ({
          month: sub.month.toISOString().slice(0, 7),
          amountCents: sub.amountCents,
          plan: sub.planKey,
        })),
        netCents: p.netCents,
        reference: p.reference,
        note: p.note,
        orders: p._count.orders,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
        // Only sent to a caller who can see across organisers; an organiser
        // reading their own list already knows whose payouts these are.
        organiser: mayActAnywhere
          ? { id: p.organiser.id, name: p.organiser.name, email: p.organiser.email }
          : undefined,
      })),
    });
  }),
);

const bankSchema = z.object({
  holderName: z.string().min(3),
  /** Moroccan RIB. Validated below rather than by regex here, so the error
   * names the actual problem instead of "invalid format". */
  rib: z.string(),
  bank: z.string().optional(),
});

/**
 * Set where this organiser's money goes.
 *
 * The organiser owns this, not an admin: it is their bank account, and making
 * an admin type someone else's RIB is both a worse workflow and a worse place
 * for a typo. An admin can still read the last four through the payout screen.
 */
organiserRouter.put(
  "/bank-account",
  canViewFinance,
  asyncHandler(async (req, res) => {
    const body = bankSchema.parse(req.body);
    const rib = normaliseRib(body.rib);
    if (!ribOk(rib)) throw new HttpError(400, "A Moroccan RIB is exactly 24 digits");

    const saved = await prisma.bankAccount.upsert({
      where: { organiserId: req.user!.id },
      create: {
        organiserId: req.user!.id,
        holderName: body.holderName.trim(),
        rib,
        bank: body.bank?.trim() || null,
      },
      update: {
        holderName: body.holderName.trim(),
        rib,
        bank: body.bank?.trim() || null,
      },
      select: { holderName: true, rib: true, bank: true, updatedAt: true },
    });

    // Where the organiser's money goes. Changing it is the step an attacker
    // would take after compromising an account, so it is recorded — the last
    // four digits only, never the full RIB.
    recordAudit(req, {
      action: AUDIT_ACTIONS.BANK_ACCOUNT_CHANGED,
      subjectType: "user",
      subjectId: req.user!.id,
      subjectLabel: req.user!.email,
      details: { holderName: saved.holderName, ribLast4: saved.rib.slice(-4), bank: saved.bank },
    });

    res.json({
      holderName: saved.holderName,
      // Echo back the last four only. Returning the full RIB would put a
      // payment credential in every response and in the browser's memory for
      // no benefit — the organiser just typed it.
      ribLast4: saved.rib.slice(-4),
      bank: saved.bank,
      updatedAt: saved.updatedAt.toISOString(),
    });
  }),
);

// ─── Calling an event off ────────────────────────────────────────────────

const cancelEventSchema = z.object({
  /** Buyers are told what this says, so it is required, not optional. */
  reason: z.string().min(5),
  /** Set false to skip the emails — for a test, or when the organiser has
   * already told everyone themselves. */
  notify: z.boolean().optional(),
});

/**
 * Cancel an event and refund every buyer.
 *
 * Needs finance.refund, not events.manage: this moves money for every buyer
 * at once, which is a far bigger act than editing a listing. Someone trusted
 * with the catalogue is not automatically trusted to issue four hundred
 * refunds.
 */
organiserRouter.post(
  "/events/:slug/cancel",
  canRefund,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const body = cancelEventSchema.parse(req.body ?? {});

    const result = await cancelEvent(event.id, body.reason, { notify: body.notify });

    recordAudit(req, {
      action: AUDIT_ACTIONS.EVENT_CANCELLED,
      subjectType: "event",
      subjectId: event.id,
      subjectLabel: event.slug,
      details: {
        reason: body.reason,
        refunded: result.refunded,
        refundedCents: result.refundedCents,
        ticketsVoided: result.ticketsVoided,
        failed: result.failed.length,
      },
    });

    res.json(result);
  }),
);

// ─── Invitations (comp tickets) ──────────────────────────────────────────

/** The guest list for an event. */
organiserRouter.get(
  "/events/:slug/invitations",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);

    const invitations = await prisma.invitation.findMany({
      where: { eventId: event.id },
      select: {
        id: true,
        guestName: true,
        guestEmail: true,
        note: true,
        sentAt: true,
        createdAt: true,
        issuedByEmail: true,
        tier: { select: { id: true, nameFr: true, nameAr: true } },
        ticket: { select: { id: true, ref: true, status: true, accessToken: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        guestName: invitation.guestName,
        guestEmail: invitation.guestEmail,
        note: invitation.note,
        tierId: invitation.tier.id,
        tierNameFr: invitation.tier.nameFr,
        tierNameAr: invitation.tier.nameAr,
        ref: invitation.ticket?.ref ?? null,
        ticketId: invitation.ticket?.id ?? null,
        /**
         * The guest's own credential, so the organiser can open EXACTLY the
         * page the guest was emailed — the question behind "they say the link
         * doesn't work" is whether it works, which a different view of the
         * same ticket cannot answer.
         *
         * Safe to return here: this route already requires events.manage on
         * an owned event, and the organiser can read the ticket anyway
         * through authoriseOrderOrOrganiser. It reveals nothing they could
         * not already reach, it just saves reaching for it a longer way.
         */
        accessToken: invitation.ticket?.accessToken ?? null,
        // "issued, then revoked" is information an organiser wants to see, so
        // a cancelled ticket still shows up here rather than vanishing.
        revoked: invitation.ticket?.status === "CANCELLED",
        sentAt: invitation.sentAt?.toISOString() ?? null,
        issuedBy: invitation.issuedByEmail,
        createdAt: invitation.createdAt.toISOString(),
      })),
    });
  }),
);

const inviteSchema = z.object({
  tierId: z.string(),
  guests: z
    .array(
      z.object({
        guestName: z.string().min(2),
        guestEmail: z.string().email().optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Issue comp tickets to a guest list.
 *
 * Deliberately not a 100% promo code, which was the only way to do this
 * before: a promo code is a discount on a SALE, so it lands in revenue,
 * commission and the payout as a zero-value order. A comp was never a sale.
 */
organiserRouter.post(
  "/events/:slug/invitations",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const body = inviteSchema.parse(req.body);

    const issued = await issueComps(req, event.id, body.tierId, body.guests);

    recordAudit(req, {
      action: AUDIT_ACTIONS.COMPS_ISSUED,
      subjectType: "event",
      subjectId: event.id,
      subjectLabel: event.slug,
      // Free seats given away is exactly the kind of thing somebody asks
      // about later.
      details: { count: issued.length, tierId: body.tierId, refs: issued.map((i) => i.ref) },
    });

    res.status(201).json({ issued });
  }),
);

/** Revoke one comp. The guest stays on the list, marked revoked. */
organiserRouter.delete(
  "/invitations/:id",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const invitation = await prisma.invitation.findUnique({
      where: { id },
      select: { id: true, guestName: true, event: { select: { slug: true } } },
    });
    if (!invitation) throw new HttpError(404, "Invitation not found");
    // Ownership is on the EVENT, not the invitation.
    await requireOwnedEvent(req.user, invitation.event.slug);

    await revokeComp(id);

    recordAudit(req, {
      action: AUDIT_ACTIONS.COMP_REVOKED,
      subjectType: "invitation",
      subjectId: id,
      subjectLabel: invitation.guestName,
    });

    res.json({ ok: true });
  }),
);

const eventSettingsSchema = z.object({
  /** 0 = unlimited. */
  maxPerBuyer: z.number().int().min(0).max(100).optional(),
  allowResale: z.boolean().optional(),
});

/**
 * The rules an organiser sets per event, after it exists.
 *
 * Separate from the event PATCH that edits the listing: these change what
 * buyers may DO (how many they may hold, whether they may resell), not what
 * the page says, and they are the settings worth finding in one place.
 */
organiserRouter.patch(
  "/events/:slug/settings",
  canManageEvents,
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await requireOwnedEvent(req.user, slug);
    const body = eventSettingsSchema.parse(req.body ?? {});

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: body,
      select: { maxPerBuyer: true, allowResale: true },
    });

    res.json(updated);
  }),
);
