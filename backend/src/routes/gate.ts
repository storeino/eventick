import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, param } from "../lib/http.js";
import { authenticate, requirePermission, userHasPermission } from "../middleware/auth.js";
import { resolveScan } from "../lib/ticket-signature.js";
import { emitToOrganiser } from "../lib/realtime.js";
import { AUDIT_ACTIONS, recordAudit } from "../lib/audit.js";

export const gateRouter = Router();

gateRouter.use(authenticate, requirePermission("gate.checkin"));

const checkInSchema = z.object({
  ref: z.string().min(3),
  /** Where the code came from. A camera scan must carry a valid signature;
   * a typed ref is a deliberate staff override. Defaults to the strict case
   * so an older client can never weaken the rule by omitting it. */
  source: z.enum(["camera", "manual"]).default("camera"),
});

/**
 * Check-in. `ref` is either a scanned QR payload (signed) or a hand-typed
 * reference — the fallback matters when a phone screen won't scan.
 *
 * The admission is a single guarded UPDATE rather than read-then-write: two
 * doors scanning the same ticket at the same instant previously both passed
 * the status check and both admitted. Now exactly one update matches
 * `status: VALID`, and the loser is told the ticket is already used.
 */
gateRouter.post(
  "/check-in",
  asyncHandler(async (req, res) => {
    const body = checkInSchema.parse(req.body);

    const scan = resolveScan(body.ref, body.source);
    // Refuse before querying, so a forged code never becomes a database probe.
    if (!scan.ok) {
      // An unsigned code from a camera is a forgery attempt, not a typo —
      // say so distinctly rather than hiding it behind "invalid".
      const message =
        scan.reason === "unsigned"
          ? "Unsigned QR code — scan the ticket's own code, or enter the reference manually"
          : "Invalid ticket code";
      throw new HttpError(400, message);
    }

    // Ownership BEFORE the write. Previously this route had no ownership
    // check at all — any organiser could burn any other organiser's tickets
    // by reference, and because the update came first, the ticket was
    // already spent by the time its event was known. Looked up first now so
    // a refusal leaves the ticket untouched.
    const target = await prisma.ticket.findUnique({
      where: { ref: scan.ref },
      select: {
        order: { select: { event: { select: { organiserId: true } } } },
        resale: { select: { status: true } },
      },
    });
    if (target && !(await userHasPermission(req.user, "scope.any"))) {
      if (target.order.event.organiserId !== req.user!.id) {
        throw new HttpError(403, "This ticket is for another organiser's event");
      }
    }

    /*
     * A seat that is ON SALE does not open the door.
     *
     * Listing a ticket leaves it VALID -- the seller keeps a usable seat
     * until someone actually buys it, which is right: an unsold listing
     * should not cost them the night. But the gate admitted on status
     * alone, so a seller could list a seat, walk in on it, and leave the
     * listing live for someone else to buy. The buyer pays for a seat that
     * has already gone through the door, and the organiser has sold the
     * same place twice.
     *
     * Checked BEFORE the claiming update, with the ownership check, so a
     * refusal leaves the ticket exactly as it was -- the same reason that
     * check was moved ahead of the write.
     *
     * Only LISTED blocks. SOLD does not reach here (completeResale moves
     * the old ticket to TRANSFERRED and issues a new one), and CANCELLED
     * means the seller took it off the market and wants their seat back.
     *
     * The seller is not stuck: cancelling the listing restores entry
     * immediately, which is why the message says so rather than just
     * refusing.
     */
    if (target?.resale?.status === "LISTED") {
      res.status(409).json({
        result: "listed",
        ticket: { ref: scan.ref },
      });
      return;
    }

    const claimed = await prisma.ticket.updateMany({
      where: { ref: scan.ref, status: "VALID" },
      data: { status: "USED", usedAt: new Date() },
    });

    if (claimed.count === 1) {
      const ticket = await prisma.ticket.findUniqueOrThrow({
        where: { ref: scan.ref },
        include: { order: { include: { event: true } } },
      });
      // Push to the organiser's dashboard so the entry counter moves without
      // a reload, on whatever screen they have open.
      emitToOrganiser(ticket.order.event.organiserId, {
        type: "checkin",
        eventSlug: ticket.order.event.slug,
        ref: ticket.ref,
        holderName: ticket.holderName,
        at: new Date().toISOString(),
      });
      res.json({
        result: "ok",
        signed: scan.signed,
        ticket: { ref: ticket.ref, holderName: ticket.holderName, usedAt: ticket.usedAt },
      });
      return;
    }

    // Nothing was claimed: either the ticket does not exist, or it was not
    // VALID. Read it to say which.
    const ticket = await prisma.ticket.findUnique({ where: { ref: scan.ref } });
    if (!ticket) throw new HttpError(404, "Ticket not found");

    if (ticket.status === "USED") {
      res.status(409).json({ result: "used", ticket: { ref: ticket.ref, usedAt: ticket.usedAt } });
      return;
    }
    if (ticket.status === "CANCELLED") {
      res.status(409).json({ result: "cancelled", ticket: { ref: ticket.ref } });
      return;
    }
    res.status(409).json({ result: "moved", ticket: { ref: ticket.ref, holderName: ticket.holderName } });
  }),
);

const undoSchema = z.object({ ref: z.string().min(3) });

/**
 * Undo the check-in that just happened, by reference.
 *
 * Wrong scans are routine — the wrong person steps forward, a ticket is
 * scanned twice at two doors, a group is admitted and one is turned away.
 * This already existed as `PATCH /organiser/tickets/:id/status`, but that
 * needs the ticket's id and lives on the Orders desk, and the person holding
 * the problem is at the door with only a reference. So the capability was
 * real and unreachable from where it was needed.
 *
 * Deliberately NOT accepting a signed scan payload: undoing is a staff
 * decision about a ticket already in hand, so a bare typed reference is the
 * right input, and requiring a re-scan of a ticket whose holder has walked
 * away would make the feature useless.
 *
 * Takes `gate.checkin` like the rest of this router: whoever may admit may
 * un-admit. It is journalled, because re-admitting a spent ticket is the
 * override most likely to be asked about afterwards.
 */
gateRouter.post(
  "/undo",
  asyncHandler(async (req, res) => {
    const body = undoSchema.parse(req.body);

    /*
     * Accept either form. A typed reference is the expected input, but staff
     * who re-scan the ticket to find it send the signed QR payload, and
     * refusing that would read as "no such ticket" for a ticket in hand.
     * `source: "manual"` because an undo IS a staff override — the signature
     * is welcome, not required.
     */
    const scan = resolveScan(body.ref, "manual");
    if (!scan.ok) throw new HttpError(400, "Invalid ticket code");
    const ref = scan.ref;

    // Ownership before the write, for the same reason check-in does it: a
    // refusal must leave the ticket exactly as it was.
    const ticket = await prisma.ticket.findUnique({
      where: { ref },
      include: { order: { include: { event: true } } },
    });
    if (!ticket) throw new HttpError(404, "Ticket not found");
    if (
      ticket.order.event.organiserId !== req.user!.id &&
      !(await userHasPermission(req.user, "scope.any"))
    ) {
      throw new HttpError(403, "This ticket is for another organiser's event");
    }

    /*
     * Only a USED ticket can be un-used.
     *
     * A guarded update rather than read-then-write, matching check-in: two
     * staff undoing the same scan at once must not both succeed, or the
     * second would resurrect a ticket the first had already restored. A
     * CANCELLED or TRANSFERRED ticket is not a wrong scan to undo — it is a
     * refund or a hand-off, and reviving it here would hand back a seat that
     * has been paid out or given away.
     */
    const restored = await prisma.ticket.updateMany({
      where: { ref, status: "USED" },
      data: { status: "VALID", usedAt: null },
    });
    if (restored.count !== 1) {
      throw new HttpError(409, `This ticket is ${ticket.status.toLowerCase()}, not checked in`);
    }

    recordAudit(req, {
      action: AUDIT_ACTIONS.TICKET_STATUS_OVERRIDDEN,
      subjectType: "ticket",
      subjectId: ticket.id,
      subjectLabel: ticket.ref,
      details: {
        from: "USED",
        to: "VALID",
        via: "gate",
        eventSlug: ticket.order.event.slug,
        admittedAt: ticket.usedAt?.toISOString() ?? null,
      },
    });

    // Move the organiser's entry counter back down, same as check-in moves it up.
    emitToOrganiser(ticket.order.event.organiserId, {
      type: "checkin.undone",
      eventSlug: ticket.order.event.slug,
      ref: ticket.ref,
      holderName: ticket.holderName,
      at: new Date().toISOString(),
    });

    res.json({
      result: "undone",
      ticket: { ref: ticket.ref, holderName: ticket.holderName, status: "VALID" },
    });
  }),
);

/**
 * Offline manifest: every valid ticket reference for one event, so a gate
 * device can keep admitting when the network dies mid-event.
 *
 * Plain refs, not hashes: the device has to compare what it scanned against
 * this list, and it cannot compute a keyed hash without the server secret.
 * Scoped to one event, and these refs are already printed on every attendee's
 * ticket — so a lost phone leaks little that isn't already in circulation.
 * The signature check still runs on every scan, online or off.
 */
gateRouter.get(
  "/events/:slug/manifest",
  asyncHandler(async (req, res) => {
    const slug = param(req, "slug");
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) throw new HttpError(404, "Event not found");
    if (event.organiserId !== req.user!.id && !(await userHasPermission(req.user, "scope.any"))) {
      throw new HttpError(403, "Not your event");
    }

    const tickets = await prisma.ticket.findMany({
      where: { order: { eventId: event.id, status: "PAID" } },
      select: { ref: true, status: true },
    });

    res.json({
      eventSlug: event.slug,
      generatedAt: new Date().toISOString(),
      // Only VALID tickets admit offline. A USED or CANCELLED one is absent,
      // so the device refuses it rather than trusting a stale snapshot.
      refs: tickets.filter((t) => t.status === "VALID").map((t) => t.ref),
    });
  }),
);
