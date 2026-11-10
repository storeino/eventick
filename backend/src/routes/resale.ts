import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, optionalAuth, refuseStaffPurchase } from "../middleware/auth.js";
import { phoneOk, makePaymentRef } from "../lib/payment-sim.js";
import { buildPaymentRequest, cmiConfig, cmiUrls, isMockPayments } from "../lib/cmi.js";
import { cancelListing, completeResale, listTicketForResale, resolveListing } from "../lib/resale.js";
import { requireTicketAccessWithSession } from "../lib/order-access.js";
import { resolveExpressAccount } from "../lib/express-account.js";

export const resaleRouter = Router();

// Ownership for seller actions lives in lib/order-access.ts. The copy that
// used to be here ended in "if this is a guest order, allow anyone", so a
// stranger holding a ticket id could act on a seat they never bought.

const listSchema = z.object({ ticketId: z.string() });

/** Put a ticket up for resale. Price is always face value — not a parameter. */
resaleRouter.post(
  "/listings",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const body = listSchema.parse(req.body);
    const ticket = await requireTicketAccessWithSession(req, body.ticketId);
    const listing = await listTicketForResale(ticket.id, ticket.order.customerId);
    res.status(201).json({
      id: listing.id,
      token: listing.token,
      priceCents: listing.priceCents,
      status: listing.status,
    });
  }),
);

resaleRouter.delete(
  "/listings/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const listing = await prisma.resaleListing.findUnique({ where: { id }, include: { ticket: true } });
    if (!listing) throw new HttpError(404, "Listing not found");
    await requireTicketAccessWithSession(req, listing.ticketId);
    await cancelListing(id);
    res.status(204).end();
  }),
);

/** Listings the caller is selling, for the "my tickets" view. */
resaleRouter.get(
  "/mine/listings",
  optionalAuth,
  asyncHandler(async (req, res) => {
    if (!req.user) throw new HttpError(401, "Sign in to see your listings");
    const listings = await prisma.resaleListing.findMany({
      where: { sellerId: req.user.id },
      include: { ticket: { include: { tier: true, order: { include: { event: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      listings: listings.map((listing) => ({
        id: listing.id,
        token: listing.token,
        status: listing.status,
        priceCents: listing.priceCents,
        ticketId: listing.ticketId,
        eventTitleFr: listing.ticket.order.event.titleFr,
        eventTitleAr: listing.ticket.order.event.titleAr,
        tierNameFr: listing.ticket.tier.nameFr,
        tierNameAr: listing.ticket.tier.nameAr,
        createdAt: listing.createdAt.toISOString(),
        soldAt: listing.soldAt?.toISOString() ?? null,
      })),
    });
  }),
);

/** What a shared listing link is offering. Public: the token is the credential. */
resaleRouter.get(
  "/:token",
  /* optionalAuth, so the response can say "this is yours" to a signed-in
     seller. Still public: a visitor with the token sees the listing either
     way, and the flag is simply false for them. */
  optionalAuth,
  asyncHandler(async (req, res) => {
    const listing = await resolveListing(param(req, "token"));
    if (!listing) throw new HttpError(410, "This listing is no longer available");

    res.json({
      token: listing.token,
      priceCents: listing.priceCents,
      eventSlug: listing.ticket.order.event.slug,
      eventTitleFr: listing.ticket.order.event.titleFr,
      eventTitleAr: listing.ticket.order.event.titleAr,
      eventStart: listing.ticket.order.event.startAt.toISOString(),
      eventImage: listing.ticket.order.event.image,
      tierNameFr: listing.ticket.tier.nameFr,
      tierNameAr: listing.ticket.tier.nameAr,
      seatRow: listing.ticket.seatRow,
      seatNumber: listing.ticket.seatNumber,
      /* Whether the viewer is the seller. A boolean, not the seller id: who
         listed a ticket is nobody else business, and the screen only needs
         to know whether to offer a buy button that can only 409. */
      isOwn: Boolean(req.user && listing.sellerId && req.user.id === listing.sellerId),
    });
  }),
);

const buySchema = z.object({
  /*
   * Supplied by a VISITOR, who has no account yet: these become one. A
   * signed-in buyer sends them too and they are ignored — the session is
   * authoritative there, exactly as at /orders/pay.
   */
  password: z.string().optional(),
  /*
   * A password being SET, for an account that has none -- not one being
   * checked. Distinct from `password` above so that a sign-in can never be
   * mistaken for a password reset: see ExpressBuyer in lib/express-account.
   */
  newPassword: z.string().optional(),
  /*
   * Accepted but NOT trusted. The route requires a session, so the account
   * already names the buyer -- taking these from the body let a signed-in
   * buyer put any name on a seat their own account owns, and send the
   * confirmation to an address they do not read. The handler reads req.user
   * instead; these stay optional only so an older client that still sends
   * them is not rejected.
   */
  holderName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string(),
  /** Which language CMI should render its hosted card page in. */
  locale: z.enum(["fr", "en", "ar"]).optional(),
});

/**
 * Buy a listed ticket.
 *
 * Deliberately NOT the normal /orders/hold path: that claims fresh tier
 * inventory, whereas a resale moves one existing seat between owners. The
 * order created here carries no OrderLine, so it never affects the pool.
 */
resaleRouter.post(
  "/:token/buy",
  /*
   * A session is optional, exactly as at /orders/hold.
   *
   * That rule was "an account is required", and the reasoning holds in both
   * directions: buying a resold seat is still buying, through a different
   * door, so a rule enforced on only one of them is not enforced. When the
   * ordinary checkout stopped demanding a sign-up before the sale, leaving
   * this one demanding it would have meant a stranger could buy a ticket
   * but not a RESOLD ticket — same person, same money, different wall.
   *
   * It is still not guest checkout: the account is created from the details
   * typed to pay, below, so every resale order has a real owner.
   */
  optionalAuth,
  // Same conflict of interest as /orders/hold. Listing a ticket (above) is
  // not guarded: that is selling, and a staff account has no ticket to sell.
  refuseStaffPurchase,
  asyncHandler(async (req, res) => {
    const body = buySchema.parse(req.body);
    if (!phoneOk(body.phone)) throw new HttpError(400, "Invalid phone number");

    const listing = await resolveListing(param(req, "token"));
    if (!listing) throw new HttpError(410, "This listing is no longer available");

    /*
     * The buyer's account, created here when there is no session.
     *
     * Same path the ordinary checkout takes: the name, email and phone they
     * type to pay are what an account needs, so it is made from them rather
     * than demanded before they have committed. An existing email is signed
     * in with its password, in place, without leaving the page.
     */
    const buyer = req.user
      ? { id: req.user.id, name: req.user.name, email: req.user.email }
      : await (async () => {
          const resolved = await resolveExpressAccount({
            holderName: body.holderName ?? "",
            email: body.email ?? "",
            phone: body.phone,
            password: body.password,
            newPassword: body.newPassword,
          });
          const user = await prisma.user.findUniqueOrThrow({
            where: { id: resolved.userId },
            select: { id: true, name: true, email: true },
          });
          return user;
        })();

    /*
     * You cannot buy your own seat.
     *
     * Not merely illogical -- it printed money. completeResale CREDITS the
     * seller the face value when the seat sells, so buying your own listing
     * returned the full price to the very balance it was bought from:
     * measured at +300.00 MAD on a 300.00 MAD ticket, with 15.00 of
     * commission charged to the organiser for a sale that moved a seat to
     * nobody. Pay with credit and the loop runs free, forever.
     *
     * Checked AFTER the account is resolved, not before. It used to read
     * req.user directly, which was fine while a session was required and
     * crashed the moment a visitor could reach this route — and a check
     * that only sees sessions would let a seller walk around it by buying
     * through the express path with their own email.
     *
     * Against the LISTING sellerId rather than the ticket order, because
     * that is the account the money goes back to: the one that would be on
     * both sides of the trade. A guest listing has sellerId null and is
     * unaffected, there being no account to match.
     */
    if (listing.sellerId && listing.sellerId === buyer.id) {
      throw new HttpError(
        409,
        "This is your own listing — cancel it instead if you want the ticket back.",
      );
    }

    const order = await prisma.order.create({
      data: {
        customerId: buyer.id,
        eventId: listing.ticket.order.eventId,
        status: "PENDING",
        /*
         * From the SESSION, not the request body.
         *
         * Buying a resold seat requires an account, so the buyer name and
         * address are already known and are not the client to assert. The
         * phone is still taken from the body: it is not on the user record,
         * and CMI wants it with the card payment.
         */
        holderName: buyer.name,
        email: buyer.email,
        phone: body.phone.trim(),
        subtotalCents: listing.priceCents,
        discountCents: 0,
        totalCents: listing.priceCents,
      },
    });

    if (isMockPayments()) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "PAID", paymentRef: makePaymentRef(), cardBank: "Démo" },
      });
      /*
       * NOT recordCommission.
       *
       * That prices an order against the ORGANISER's plan, which is
       * right for a first sale and wrong here: a resale moves an
       * existing seat between two customers, and the organiser was
       * already paid when that seat was first sold. Billing their plan
       * again charged them for a transaction they receive nothing from,
       * and their reported commission rose after a resale at a rate
       * they were not on.
       *
       * completeResale records the PLATFORM's resale fee instead, from
       * the same computation that decides what the seller is paid, so
       * the two can never disagree.
       */
      const result = await completeResale(listing.id, order.id);
      return res.json({ mode: "mock", settled: true, orderId: order.id, ...result });
    }

    // Link the listing to this attempt BEFORE the buyer leaves for CMI. The
    // callback receives only our order reference, so this is the only way it
    // can tell a resold seat from fresh inventory and route the settlement to
    // completeResale instead of issuing a ticket against tier stock.
    await prisma.resaleListing.update({
      where: { id: listing.id },
      data: { pendingOrderId: order.id },
    });

    const config = cmiConfig()!;
    const request = buildPaymentRequest(
      {
        reference: order.id,
        totalCents: order.totalCents,
        email: order.email,
        holderName: order.holderName,
        phone: order.phone,
        locale: body.locale,
        ...cmiUrls(order.id, order.accessToken, body.locale),
      },
      config,
    );

    res.json({ mode: "cmi", orderId: order.id, action: request.action, fields: request.fields });
  }),
);

