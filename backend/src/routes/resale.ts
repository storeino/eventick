import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, optionalAuth, refuseStaffPurchase } from "../middleware/auth.js";
import { phoneOk, makePaymentRef } from "../lib/payment-sim.js";
import { recordCommission } from "../lib/settle.js";
import { buildPaymentRequest, cmiConfig, cmiUrls, isMockPayments } from "../lib/cmi.js";
import { cancelListing, completeResale, listTicketForResale, resolveListing } from "../lib/resale.js";
import { requireTicketAccessWithSession } from "../lib/order-access.js";

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
    });
  }),
);

const buySchema = z.object({
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
   * An account is required, exactly as at /orders/hold.
   *
   * Buying a resold seat is still buying, just through a different door --
   * and a rule enforced on only one of two doors is not enforced. Leaving
   * this on optionalAuth would have kept guest checkout alive via any resale
   * link, which is the same orders-with-no-owner this change exists to end.
   */
  authenticate,
  // Same conflict of interest as /orders/hold. Listing a ticket (above) is
  // not guarded: that is selling, and a staff account has no ticket to sell.
  refuseStaffPurchase,
  asyncHandler(async (req, res) => {
    const body = buySchema.parse(req.body);
    if (!phoneOk(body.phone)) throw new HttpError(400, "Invalid phone number");

    const listing = await resolveListing(param(req, "token"));
    if (!listing) throw new HttpError(410, "This listing is no longer available");

    const order = await prisma.order.create({
      data: {
        // `authenticate` above guarantees a user. Asserted rather than
        // defaulted to null, so loosening the middleware cannot silently
        // start minting ownerless orders again.
        customerId: req.user!.id,
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
        holderName: req.user!.name,
        email: req.user!.email,
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
      // A resale is a sale: the platform brokered it and takes its cut. This
      // path sets PAID directly instead of going through settleOrder, so the
      // commission has to be recorded explicitly or the resale is free.
      await recordCommission(prisma, order.id);
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

