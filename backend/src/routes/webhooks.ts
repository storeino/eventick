import { Router, urlencoded } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../lib/http.js";
import { cmiConfig, isApproved, orderIdFromOid, verifyCallbackHash } from "../lib/cmi.js";
import { OversoldError, recordCommission, settleOrder } from "../lib/settle.js";
import { completeResale } from "../lib/resale.js";
import { cancelUpgrade, completeUpgrade } from "../lib/upgrade.js";
import { logger } from "../lib/logger.js";

export const webhooksRouter = Router();

/**
 * CMI callback — the ONLY thing that turns a payment into tickets.
 *
 * The buyer's browser is never trusted for this: it can lie, close the tab, or
 * lose its network right after paying. CMI calls this endpoint server to
 * server, and it is also where a payment that succeeded on a closed tab still
 * gets its tickets.
 *
 * The endpoint is necessarily public and unauthenticated — CMI has no bearer
 * token to present — so the signature IS the authentication. A POST with a bad
 * or missing hash is a forgery attempt, not a payment, and is refused before
 * anything is read out of the body. Several CMI integrations in the wild check
 * only ProcReturnCode, which means anyone who guesses an order reference gets
 * free tickets.
 *
 * CMI posts form-encoded, not JSON, and expects a bare text reply:
 * "ACTION=POSTAUTH" to accept the transaction, anything else to refuse it.
 */
webhooksRouter.post(
  "/cmi",
  urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const config = cmiConfig();
    if (!config) {
      // Mock mode: nothing is configured, so there is no key to verify with.
      // Refuse rather than settle — accepting here would make the mock build
      // the easiest way to mint free tickets if it ever faced the internet.
      logger.warn("CMI callback received but CMI is not configured — refused");
      return res.type("text/plain").send("FAILURE");
    }

    const body = (req.body ?? {}) as Record<string, string>;

    if (!verifyCallbackHash(body, config.storeKey)) {
      logger.warn({ oid: body.oid }, "CMI callback REJECTED — hash mismatch (possible forgery)");
      return res.type("text/plain").send("FAILURE");
    }

    // Belt and braces: a hash computed with our key over someone else's
    // clientid should be impossible, but the merchant id is cheap to confirm.
    if (body.clientid && body.clientid !== config.clientId) {
      logger.warn({ clientid: body.clientid }, "CMI callback REJECTED — wrong merchant id");
      return res.type("text/plain").send("FAILURE");
    }

    if (!body.oid) {
      logger.warn("CMI callback REJECTED — no order reference");
      return res.type("text/plain").send("FAILURE");
    }
    // The oid is `<orderId>-<attempt>`: CMI needs a fresh one per attempt or
    // it refuses the retry, so the suffix is stripped to find the order. An
    // oid with no suffix still resolves, for anything in flight from before.
    const reference = orderIdFromOid(body.oid);

    if (!isApproved(body)) {
      // Leave the order PENDING so the buyer can retry while the hold lasts;
      // the hold lapsing is what releases the seats.
      logger.info(
        { reference, code: body.ProcReturnCode, response: body.Response },
        "CMI payment declined",
      );
      return res.type("text/plain").send("FAILURE");
    }

    const order = await prisma.order.findUnique({ where: { id: reference } });
    if (!order) {
      logger.error({ reference }, "CMI approved a payment for an unknown order");
      return res.type("text/plain").send("FAILURE");
    }

    // The signed amount must match what we asked for. CMI should never alter
    // it, but settling on the gateway's number rather than our own is how an
    // underpaid order quietly becomes a valid ticket.
    const expected = (order.totalCents / 100).toFixed(2);
    if (body.amount && Number(body.amount) !== Number(expected)) {
      logger.error(
        { reference, paid: body.amount, expected },
        "CMI callback REJECTED — amount does not match the order",
      );
      return res.type("text/plain").send("FAILURE");
    }

    const gatewayRef = body.TransId ?? `CMI-${reference}`;

    /*
     * Only ACTION=POSTAUTH takes the buyer's money, so it must be sent if and
     * only if they end up with something. That is harder than it looks here,
     * because CMI is a REDIRECT gateway: the buyer is away on CMI's hosted
     * page for as long as it takes them to find their card and pass 3-D
     * Secure, which can outlast the 15-minute hold. By the time this callback
     * arrives the order may already have been cancelled by the sweeper.
     *
     * `settled: false` is ambiguous on its own — it means EITHER "already
     * delivered, this is a retry" (accept the money) OR "cancelled, nothing
     * delivered" (refuse it), which are opposite answers. So the decision is
     * made from the order's actual state afterwards, never from that flag.
     */
    const deliver = async (): Promise<boolean> => {
      /*
       * An upgrade pays the DIFFERENCE to move an existing ticket into a
       * dearer zone. Like a resale it buys no fresh inventory, so it must not
       * go through settleOrder — that would issue a second ticket against
       * tier stock instead of moving the one they already hold.
       */
      const upgrade = await prisma.ticketUpgrade.findUnique({
        where: { orderId: order.id },
        select: { id: true, status: true, ticketId: true },
      });

      if (upgrade) {
        const claimed = await prisma.order.updateMany({
          where: { id: order.id, status: "PENDING" },
          data: { status: "PAID", paymentRef: gatewayRef, gatewayRef },
        });
        if (claimed.count === 0) {
          // Not PENDING any more: either a retry of a move we already made,
          // or an attempt that was cancelled while the buyer was at the
          // gateway. DONE is the only state in which they got what they paid
          // for, so it is the only one that may keep the money.
          const done = await prisma.ticketUpgrade.findUnique({
            where: { id: upgrade.id },
            select: { status: true },
          });
          return done?.status === "DONE";
        }
        try {
          // An upgrade is a sale of the difference, so the platform takes its
          // cut on that amount. This branch sets PAID itself rather than
          // going through settleOrder, so the fee would otherwise be lost.
          await recordCommission(prisma, order.id);
          // Guarded on PENDING inside, so a replay moves the seat once. It
          // throws if the ticket was used or given away, or if the zone
          // filled while this buyer was paying -- none of which may keep
          // their money.
          await completeUpgrade(upgrade.id);
          return true;
        } catch (err) {
          logger.error(
            { err, upgradeId: upgrade.id, orderId: order.id },
            "CMI upgrade could not be completed — refusing the payment",
          );
          /*
           * Undo everything this callback did, so the order does not look
           * paid for a move that never happened: the PAID flip, the gateway
           * reference, and the commission (which would otherwise bill the
           * organiser for a sale that did not occur, and would stop
           * recordCommission re-pricing the order on a retry).
           *
           * The upgrade row is closed too, releasing the seat it was holding
           * — the zone was dear enough that somebody is likely waiting.
           */
          await prisma.order.updateMany({
            where: { id: order.id, gatewayRef },
            data: { status: "PENDING", paymentRef: null, gatewayRef: null, feeCents: null, feePlanKey: null },
          });
          await cancelUpgrade(upgrade.id);
          return false;
        }
      }

      // A resale buys one existing seat rather than fresh tier inventory, so
      // it settles through completeResale, not settleOrder. The listing was
      // linked to this order before the buyer left for the gateway.
      const listing = await prisma.resaleListing.findUnique({
        where: { pendingOrderId: order.id },
        select: { id: true, status: true },
      });

      if (listing) {
        const claimed = await prisma.order.updateMany({
          where: { id: order.id, status: "PENDING" },
          data: { status: "PAID", paymentRef: gatewayRef, gatewayRef },
        });
        if (claimed.count === 0) {
          // Not PENDING any more: either a retry of a sale we completed, or a
          // buyer order that was cancelled while they were at the gateway.
          const seatIsTheirs = (await prisma.ticket.count({ where: { orderId: order.id } })) > 0;
          return seatIsTheirs;
        }
        try {
          // Same as the mock path: a resale is a sale, and this branch sets
          // PAID itself rather than going through settleOrder, so the fee
          // would otherwise never be recorded.
          await recordCommission(prisma, order.id);
          // Guarded on status LISTED inside, so a replay cannot transfer the
          // seat twice — and a listing cancelled or sold to someone else while
          // this buyer was paying throws, which must NOT take their money.
          await completeResale(listing.id, order.id);
          return true;
        } catch (err) {
          logger.error(
            { err, listingId: listing.id, orderId: order.id },
            "CMI resale could not be completed — refusing the payment",
          );
          // Undo the PAID flip: nothing was delivered, so the order must not
          // look paid for a seat the buyer never received. The commission goes
          // back too — leaving it would bill the organiser for a sale that
          // never happened, and would also stop recordCommission re-pricing
          // the order if the buyer retries, since it skips priced orders.
          await prisma.order.updateMany({
            where: { id: order.id, gatewayRef },
            data: { status: "PENDING", paymentRef: null, gatewayRef: null, feeCents: null, feePlanKey: null },
          });
          return false;
        }
      }

      // Normal sale. settleOrder is idempotent and only promotes a PENDING
      // order, so a retry is a no-op rather than a second set of tickets.
      await prisma.order.updateMany({
        where: { id: order.id, status: "PENDING" },
        data: { gatewayRef },
      });
      let result;
      try {
        result = await settleOrder(order.id, {
          paymentRef: gatewayRef,
          cardBrand: body.CardType ?? null,
          cardLast4: last4(body.MaskedPan),
          cardBank: "CMI",
        });
      } catch (err) {
        if (err instanceof OversoldError) {
          // The seats went while they were on CMI's page. Refuse the money;
          // the rolled-back transaction left the order PENDING.
          logger.error({ err: err.message, orderId: order.id }, "CMI payment arrived after the seats were gone");
          return false;
        }
        // Anything else is an infrastructure failure, and we do NOT know
        // whether delivery can succeed. Rethrowing 500s the callback so CMI
        // retries it, which is recoverable — answering FAILURE would void a
        // payment that might well have been deliverable.
        throw err;
      }
      if (result.settled) return true;

      // Did not settle. Tickets existing means this is a retry of a delivered
      // order and the money is genuinely owed; none means the order was
      // cancelled (an expired hold, swept) and charging would be theft.
      return (await prisma.ticket.count({ where: { orderId: order.id } })) > 0;
    };

    const delivered = await deliver();

    if (!delivered) {
      logger.error(
        { orderId: order.id, gatewayRef, status: order.status },
        "CMI payment REFUSED after approval — nothing could be delivered, so the money is not taken",
      );
      return res.type("text/plain").send("FAILURE");
    }

    logger.info({ orderId: order.id, gatewayRef }, "CMI payment settled");

    // Accept the transaction. Anything other than this leaves CMI holding the
    // authorisation, so the buyer would not be charged for tickets we issued.
    res.type("text/plain").send("ACTION=POSTAUTH");
  }),
);

/** CMI sends a masked PAN like "423456******7890"; keep only the last four. */
function last4(maskedPan: string | undefined): string | null {
  if (!maskedPan) return null;
  const digits = maskedPan.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}
