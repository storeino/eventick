import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, optionalAuth, refuseStaffPurchase } from "../middleware/auth.js";
import { publicTicket } from "../lib/serialize.js";
import { renderTicketsPdf } from "../lib/ticket-pdf.js";
import { committedForTier } from "../lib/availability.js";
import { ticketPayload } from "../lib/ticket-signature.js";
import { exchangeTicket, renameHolder } from "../lib/ticket-admin.js";
import { cancelUpgrade, completeUpgrade, startUpgrade } from "../lib/upgrade.js";
import { buildPaymentRequest, cmiConfig, cmiUrls, isMockPayments } from "../lib/cmi.js";
import { phoneOk, makePaymentRef } from "../lib/payment-sim.js";
import { recordCommission } from "../lib/settle.js";
import { shareTicket } from "../lib/share.js";
import { authoriseOrderOrOrganiser, presentedToken, requireTicketAccess, requireTicketAccessWithSession, tokenMatchesTicket } from "../lib/order-access.js";

export const ticketsRouter = Router();

ticketsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    // This route hands out the SIGNED QR payload — the thing the gate scans.
    // It had no auth at all, so the id alone produced a working entry
    // credential for someone else's seat.
    const ticket = await requireTicketAccess(req, id);
    res.json({
      // Signed QR payload: only the server can produce this, so the client
      // renders the image but cannot forge what it encodes.
      qrPayload: ticketPayload(ticket.ref, ticket.order.event.slug),
      ticket: publicTicket(ticket),
      event: {
        slug: ticket.order.event.slug,
        titleFr: ticket.order.event.titleFr,
        titleAr: ticket.order.event.titleAr,
        venueFr: ticket.order.event.venueFr,
        venueAr: ticket.order.event.venueAr,
        image: ticket.order.event.image,
        start: ticket.order.event.startAt.toISOString(),
      },
      tier: {
        nameFr: ticket.tier.nameFr,
        nameAr: ticket.tier.nameAr,
        zoneFr: ticket.tier.zoneFr,
        zoneAr: ticket.tier.zoneAr,
        gateFr: ticket.tier.gateFr,
        gateAr: ticket.tier.gateAr,
      },
      order: {
        subtotalCents: ticket.order.subtotalCents,
        totalCents: ticket.order.totalCents,
        paymentRef: ticket.order.paymentRef,
        cardBank: ticket.order.cardBank,
        cardLast4: ticket.order.cardLast4,
      },
    });
  }),
);

/**
 * Ticket PDF. Readable by the buyer (session or order token), the event's
 * organiser, or an admin.
 *
 * The old rule ended in `|| isGuestOrder`, which meant a guest ticket's PDF —
 * QR and all — was served to anyone who knew the id.
 */
ticketsRouter.get(
  "/:id/pdf",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { tier: true, order: { include: { event: true } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");

    const order = ticket.order;
    // A per-ticket token (a shared ticket, or a comp emailed to a guest) must
    // open the PDF of THAT ticket. authoriseOrderOrOrganiser only ever checked
    // the ORDER's token, so a guest holding a valid ticket credential could
    // see their pass on screen but got 403 downloading it -- the one format
    // they would actually take to the door.
    const presented = presentedToken(req);
    const holdsThisTicket = Boolean(presented) && tokenMatchesTicket(presented!, ticket.accessToken);
    if (!holdsThisTicket) await authoriseOrderOrOrganiser(req, order);

    const pdf = await renderTicketsPdf([
      {
        ref: ticket.ref,
        holderName: ticket.holderName,
        eventSlug: order.event.slug,
        eventTitle: order.event.titleFr,
        venue: order.event.venueFr,
        city: order.event.city,
        startAt: order.event.startAt,
        tierName: ticket.tier.nameFr,
        zone: ticket.tier.zoneFr,
        gate: ticket.tier.gateFr,
        seatRow: ticket.seatRow,
        seatNumber: ticket.seatNumber,
        priceCents: ticket.tier.priceCents,
        orderId: order.id,
      },
    ]);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${ticket.ref}.pdf"`);
    res.send(pdf);
  }),
);

/**
 * Transfer — kept for older clients, now backed by sharing.
 *
 * It used to mark the ticket TRANSFERRED (a status the gate REFUSES) and
 * issue nothing in its place, so a transfer destroyed the ticket and the
 * recipient got nothing. It now creates a share link the recipient claims,
 * which voids the sender's ticket only once a replacement exists.
 *
 * Renaming the holder on a ticket you keep is a different action —
 * PATCH /tickets/:id/holder.
 */
ticketsRouter.post(
  "/:id/transfer",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const ticket = await prisma.ticket.findUnique({ where: { id }, include: { order: true } });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (ticket.order.customerId !== req.user!.id) throw new HttpError(403, "Not your ticket");

    const share = await shareTicket(id, ticket.order.customerId);
    res.status(201).json({ shareId: share.id, token: share.token });
  }),
);

// ─── Buyer-side ticket management ────────────────────────────────────────

// Ownership for buyer actions now lives in lib/order-access.ts, shared with
// resale.ts and share.ts. All three had their own copy of a check that read
// "if this is a guest order, allow anyone", which is why a stranger holding a
// ticket id could cancel, rename, exchange, resell or give away a seat they
// had never paid for.

/** What the holder may do with this ticket right now, so the UI shows only
 * the actions that would succeed rather than ones certain to fail. */
ticketsRouter.get(
  "/:id/options",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const ticket = await requireTicketAccess(req, param(req, "id"));

    // Zones they could move to, with the extra due for each.
    const tiers = await prisma.ticketTier.findMany({
      where: { eventId: ticket.order.eventId },
      orderBy: { priceCents: "asc" },
    });
    // A comp has no exchange options at all: exchangeTicket refuses one, so
    // listing zones here would only render buttons certain to 403.
    const exchangeable = ticket.kind === "COMP"
      ? []
      : await Promise.all(
          tiers
            .filter((tier) => tier.id !== ticket.tierId)
            .map(async (tier) => {
              const committed = await committedForTier(tier.id);
              const diff = tier.priceCents - ticket.tier.priceCents;
              return {
                tierId: tier.id,
                nameFr: tier.nameFr,
                nameAr: tier.nameAr,
                priceCents: tier.priceCents,
                dueCents: Math.max(0, diff),
                // What moving DOWN costs the holder. Downgrades refund
                // nothing on purpose (otherwise buying the dearest seat and
                // downgrading becomes a way to extract cash), but the UI
                // showed only "no extra charge" -- true, and read as "free"
                // by someone about to forfeit the difference. Stating the
                // amount is what makes the choice an informed one.
                forfeitCents: Math.max(0, -diff),
                soldOut: committed >= tier.capacity,
              };
            }),
        );

    // An open share link, so the UI shows it back instead of offering a
    // "share" button that would only 409 on one already being out there.
    const openShare = await prisma.ticketShare.findFirst({
      where: { ticketId: ticket.id, status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });

    // Whether this caller reached the ticket with a real account or just the
    // link. The manage panel reads it to decide between showing the
    // money/disposal actions and showing "claim this order" — without it the
    // UI would render buttons that are now certain to 403.
    const ownsIt = Boolean(req.user?.id) && ticket.order.customerId === req.user!.id;

    /*
     * Resale, which is how a holder who cannot attend gets their money back.
     *
     * It matters more since tickets became final sale: cancelling a seat
     * returns nothing, so reselling is the only way to recover the price.
     * The UI cannot work that out for itself — allowResale lives on the
     * event and the live listing on another table — so it is reported here
     * rather than left to the screen to guess and then 409.
     *
     * Price is not a field: a listing is always face value, set server-side.
     */
    const listing = await prisma.resaleListing.findUnique({ where: { ticketId: ticket.id } });
    const liveListing = listing && listing.status === "LISTED" ? listing : null;

    res.json({
      status: ticket.status,
      exchange: exchangeable,
      share: openShare ? { id: openShare.id, token: openShare.token } : null,
      shareable:
        ticket.status === "VALID" && ticket.order.event.startAt.getTime() > Date.now() && !openShare,
      /** A listing already out there, so the UI shows the link back. */
      resale: liveListing
        ? { id: liveListing.id, token: liveListing.token, priceCents: liveListing.priceCents }
        : null,
      /*
       * Whether listing one is possible at all. Mirrors listTicketForResale's
       * own guards so the button is absent rather than present-and-409ing:
       * the organiser must have opted in, the event must not have started,
       * the ticket must be live, and there must be no listing already.
       *
       * `ownsIt` too, because selling needs a real session — a confirmation
       * link is not enough to move money.
       */
      resellable:
        ownsIt &&
        ticket.order.event.allowResale &&
        ticket.status === "VALID" &&
        ticket.order.event.startAt.getTime() > Date.now() &&
        !liveListing &&
        listing?.status !== "SOLD",
      /** So the screen can say what a sale would return, before listing. */
      facePriceCents: ticket.tier.priceCents,
      /** False for a guest holding only their confirmation link. */
      viaSession: ownsIt,
      /** The order to claim, so the UI can offer that in one step. */
      orderId: ticket.orderId,
    });
  }),
);

/*
 * There is no POST /:id/cancel. A buyer cannot cancel their own seat.
 *
 * The route made sense while tickets were refundable. Now that they are final
 * sale it would have given up the seat and kept the charge, which is a worse
 * deal than doing nothing — see lib/ticket-admin.ts. A holder who cannot
 * attend lists the seat for resale instead, which frees it for the waitlist
 * just the same and pays them face value.
 */

const exchangeSchema = z.object({ tierId: z.string() });

ticketsRouter.post(
  "/:id/exchange",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const ticket = await requireTicketAccess(req, param(req, "id"));
    const body = exchangeSchema.parse(req.body);

    // State before price: a used or cancelled ticket can't be exchanged at
    // any price, so quoting an upgrade fee for one is the wrong answer.
    if (ticket.status !== "VALID") {
      throw new HttpError(409, "Only a valid ticket can be exchanged");
    }

    const target = await prisma.ticketTier.findUnique({ where: { id: body.tierId } });
    if (!target) throw new HttpError(404, "Zone not found");

    // An upgrade owes money, which this route cannot collect: it answers
    // immediately, and taking a card payment means sending the buyer to CMI
    // and settling on the callback. POST /:id/upgrade does that. Refusing
    // here rather than moving the seat is the point -- the alternative is
    // giving away the difference.
    const dueCents = target.priceCents - ticket.tier.priceCents;
    if (dueCents > 0) {
      throw new HttpError(402, `An upgrade to this zone costs ${(dueCents / 100).toFixed(2)} MAD more`);
    }

    const result = await exchangeTicket(ticket.id, body.tierId);
    res.json(result);
  }),
);

const upgradeSchema = z.object({
  tierId: z.string(),
  holderName: z.string().min(3),
  email: z.string().email(),
  phone: z.string(),
  /** Which language CMI should render its hosted card page in. */
  locale: z.enum(["fr", "en", "ar"]).optional(),
});

/**
 * Move a ticket into a DEARER zone, paying the difference.
 *
 * The paid sibling of /exchange, which handles every move that owes nothing.
 * Split rather than branching inside one route because the two have
 * different shapes: an exchange answers with the moved ticket, while this
 * answers with a payment form and only moves the seat once the gateway
 * callback confirms the money.
 *
 * Requires a real account, like every other route that takes payment: a
 * confirmation link proves someone holds a ticket, not that they may spend
 * on it.
 */
ticketsRouter.post(
  "/:id/upgrade",
  authenticate,
  refuseStaffPurchase,
  asyncHandler(async (req, res) => {
    const body = upgradeSchema.parse(req.body);
    if (!phoneOk(body.phone)) throw new HttpError(400, "Invalid phone number");

    // Ownership, not just access: the session must own the order. A shared
    // ticket link must not let the recipient spend the holder's money.
    const ticket = await requireTicketAccessWithSession(req, param(req, "id"));

    const started = await startUpgrade(ticket.id, body.tierId, {
      id: req.user!.id,
      holderName: body.holderName.trim(),
      email: body.email.trim(),
      phone: body.phone.trim(),
    });

    if (isMockPayments()) {
      await prisma.order.update({
        where: { id: started.orderId },
        data: { status: "PAID", paymentRef: makePaymentRef(), cardBank: "Démo" },
      });
      // An upgrade is a sale of the difference, so the platform takes its cut
      // on that amount. This path sets PAID directly rather than going
      // through settleOrder, so the fee has to be recorded explicitly.
      await recordCommission(prisma, started.orderId);
      const moved = await completeUpgrade(started.upgradeId);
      return res.json({ mode: "mock", settled: true, orderId: started.orderId, ...moved });
    }

    const config = cmiConfig()!;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: started.orderId } });
    const request = buildPaymentRequest(
      {
        reference: order.id,
        totalCents: order.totalCents,
        email: order.email,
        holderName: order.holderName,
        phone: order.phone,
        locale: body.locale,
        // Back to the ticket they are upgrading, not to a confirmation page
        // for an order that holds no tickets of its own.
        ...cmiUrls(order.id, order.accessToken, body.locale, `/billet/${ticket.id}?surclassement=ok`),
      },
      config,
    );

    res.json({
      mode: "cmi",
      orderId: order.id,
      // So the screen can release the held seat if the buyer backs out
      // instead of leaving it reserved until the sweeper runs.
      upgradeId: started.upgradeId,
      dueCents: started.dueCents,
      action: request.action,
      fields: request.fields,
    });
  }),
);

/** Give up an upgrade the buyer started and did not pay for, so the seat it
 * is holding goes back on sale now rather than when the sweeper runs. */
ticketsRouter.post(
  "/upgrades/:upgradeId/abandon",
  authenticate,
  asyncHandler(async (req, res) => {
    const upgradeId = param(req, "upgradeId");
    const upgrade = await prisma.ticketUpgrade.findUnique({ where: { id: upgradeId } });
    if (!upgrade) throw new HttpError(404, "Upgrade not found");
    if (upgrade.buyerId !== req.user!.id) throw new HttpError(403, "This upgrade is not yours");
    await cancelUpgrade(upgradeId);
    res.status(204).end();
  }),
);

const renameSchema = z.object({ holderName: z.string().min(2).max(80) });

ticketsRouter.patch(
  "/:id/holder",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const ticket = await requireTicketAccess(req, param(req, "id"));
    const body = renameSchema.parse(req.body);
    await renameHolder(ticket.id, body.holderName);
    res.json({ ok: true });
  }),
);
