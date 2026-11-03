import type { Event, LineupItem, Order, Ticket, TicketTier } from "@prisma/client";
import { ticketPayload } from "./ticket-signature.js";

export type EventWithTiers = Event & { tiers: TicketTier[]; lineup: LineupItem[] };

/** Shapes a DB event back into the bilingual catalog JSON the frontend
 * already knows how to render (ported field-for-field from the original
 * EventItem/Tier types in src/lib/catalog.ts). */
export function publicEvent(event: EventWithTiers, remainingByTier: Record<string, number>) {
  return {
    slug: event.slug,
    titleFr: event.titleFr,
    titleAr: event.titleAr,
    category: event.category,
    city: event.city,
    venueFr: event.venueFr,
    // Drives the site plan: the shape of the room, not its name.
    venueKind: event.venueKind,
    venueAr: event.venueAr,
    address: event.address,
    start: event.startAt.toISOString(),
    end: event.endAt.toISOString(),
    doors: event.doorsAt.toISOString(),
    image: event.image,
    badge: event.badge,
    blurbFr: event.blurbFr,
    blurbAr: event.blurbAr,
    aboutFr: event.aboutFr,
    aboutAr: event.aboutAr,
    ageFr: event.ageFr,
    ageAr: event.ageAr,
    popularity: event.popularity,
    instant: event.instant,
    // The sales rules. A buyer screen needs maxPerBuyer to say "4 maximum"
    // before the hold is refused, and allowResale decides whether the resell
    // action exists at all — both were stored but never sent, so the only way
    // to read them back was the organiser's settings endpoint.
    maxPerBuyer: event.maxPerBuyer,
    allowResale: event.allowResale,
    cancelledAt: event.cancelledAt?.toISOString() ?? null,
    cancelReason: event.cancelReason,
    // Whether the public page may carry schema.org Event markup. Sent so the
    // frontend can decide without a second round trip; false for anything
    // seeded, so demo data is never advertised to Google as bookable.
    seoIndexable: event.seoIndexable,
    tiers: event.tiers.map((tier) => ({
      id: tier.id,
      nameFr: tier.nameFr,
      nameAr: tier.nameAr,
      blurbFr: tier.blurbFr,
      blurbAr: tier.blurbAr,
      priceCents: tier.priceCents,
      capacity: tier.capacity,
      remaining: remainingByTier[tier.id] ?? 0,
      numbered: tier.numbered,
      // Whether this tier is a place, and so belongs on the site plan.
      spatial: tier.spatial,
      recommended: tier.recommended,
      saveCents: tier.saveCents,
      perks: tier.perks,
      // Null on either side means unbounded on that side. A buyer screen uses
      // these to say "on sale from 1 November" rather than showing a tier
      // whose only explanation for refusing is an error.
      salesStartAt: tier.salesStartAt?.toISOString() ?? null,
      salesEndAt: tier.salesEndAt?.toISOString() ?? null,
      zoneFr: tier.zoneFr,
      zoneAr: tier.zoneAr,
      gateFr: tier.gateFr,
      gateAr: tier.gateAr,
    })),
    lineup: event.lineup.map((item) => ({
      day: item.day.toISOString(),
      time: item.time,
      name: item.name,
      genreFr: item.genreFr,
      genreAr: item.genreAr,
      image: item.image,
    })),
  };
}

/**
 * `contact: false` withholds the buyer's own name, email and phone.
 *
 * Note what is NOT here: accessToken. The order credential is returned once,
 * by the hold that creates the order, and never again — otherwise being able
 * to read an order would hand over the right to change it, and the whole
 * boundary would be decorative.
 */
export function publicOrder(order: Order & { tickets: Ticket[] }, opts: { contact?: boolean } = {}) {
  const contact = opts.contact !== false;
  return {
    id: order.id,
    status: order.status,
    ...(contact
      ? { holderName: order.holderName, email: order.email, phone: order.phone }
      : {}),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    paymentRef: order.paymentRef,
    cardBrand: order.cardBrand,
    cardLast4: order.cardLast4,
    cardBank: order.cardBank,
    refundedCents: order.refundedCents,
    refundedAt: order.refundedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    tickets: order.tickets.map(publicTicket),
  };
}

export function publicTicket(ticket: Ticket) {
  return {
    id: ticket.id,
    ref: ticket.ref,
    status: ticket.status,
    holderName: ticket.holderName,
    seatRow: ticket.seatRow,
    seatNumber: ticket.seatNumber,
  };
}

type TicketWithContext = Ticket & { tier: TicketTier & { event: Event } };

/** Same ticket shape as publicTicket, plus the event/tier context Billets
 * needs to group active vs past and render without a second round-trip per
 * ticket. The gate and transfer routes don't need this — they stay on the
 * lighter publicTicket. */
export function publicTicketWithContext(ticket: TicketWithContext) {
  return {
    ...publicTicket(ticket),
    qrPayload: ticketPayload(ticket.ref, ticket.tier.event.slug),
    tierId: ticket.tierId,
    tierNameFr: ticket.tier.nameFr,
    tierNameAr: ticket.tier.nameAr,
    priceCents: ticket.tier.priceCents,
    zoneFr: ticket.tier.zoneFr,
    zoneAr: ticket.tier.zoneAr,
    gateFr: ticket.tier.gateFr,
    gateAr: ticket.tier.gateAr,
    event: {
      slug: ticket.tier.event.slug,
      titleFr: ticket.tier.event.titleFr,
      titleAr: ticket.tier.event.titleAr,
      city: ticket.tier.event.city,
      venueFr: ticket.tier.event.venueFr,
      venueAr: ticket.tier.event.venueAr,
      image: ticket.tier.event.image,
      start: ticket.tier.event.startAt.toISOString(),
      end: ticket.tier.event.endAt.toISOString(),
    },
  };
}

export function publicOrderWithContext(
  order: Order & { tickets: TicketWithContext[] },
  opts: { contact?: boolean } = {},
) {
  return {
    ...publicOrder(order, opts),
    tickets: order.tickets.map(publicTicketWithContext),
  };
}
