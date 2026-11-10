import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { userHasPermission } from "../middleware/auth.js";

/**
 * Who may act on an order, and on the tickets inside it.
 *
 * Guest checkout means an order can have no customerId, and three route files
 * each answered that the same way:
 *
 *     const isGuestOrder = ticket.order.customerId === null;
 *     if (!isGuestOrder && ticket.order.customerId !== userId) throw 403;
 *
 * Read it closely and the guest branch does not check anything — it returns
 * the ticket to whoever asked. Anyone holding a guest ticket's id could cancel
 * it, rename its holder, exchange it, list it for resale or give it away.
 * "No account" had been implemented as "no check".
 *
 * The missing piece was never a user, it was proof. A guest has exactly one
 * thing a stranger does not: the link they were given at checkout. So that
 * link carries a secret — Order.accessToken — and it is the guest's
 * credential, playing the same role a session plays for a registered buyer.
 *
 * Three ways to be authorised, in the order they are checked:
 *   1. the order's access token (the buyer's link — works with no account);
 *   2. being the registered customer on the order;
 *   3. holding scope.any, i.e. staff acting on someone else's order.
 */

/** A fresh order credential. 24 bytes, base64url — same shape and generator
 * as TicketShare.token, which solved this problem first. */
export function newAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The token presented with this request, if any.
 *
 * Accepted from `?k=` (so it can live in the confirmation URL the buyer
 * bookmarks or forwards) or from an `X-Order-Token` header, which is what the
 * SPA sends once it has the value, to keep the secret out of referrer headers
 * and server logs on subsequent calls.
 */
export function presentedToken(req: Request): string | null {
  const q = req.query.k;
  if (typeof q === "string" && q.length > 0) return q;
  const h = req.get("x-order-token");
  if (h && h.length > 0) return h;
  return null;
}

/**
 * Does this presented token open THIS ticket?
 *
 * Exported for routes that authorise a single ticket rather than its order —
 * the PDF, which a share recipient or an invited guest reaches with a
 * ticket-scoped token and no claim on the rest of the order.
 */
export function tokenMatchesTicket(presented: string, stored: string | null): boolean {
  return tokenMatches(presented, stored);
}

/** Constant-time compare, so a wrong token cannot be narrowed down by timing
 * one character at a time. */
function tokenMatches(presented: string, stored: string | null): boolean {
  if (!stored) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length — but length is not the secret here, the value is, and an attacker
  // already knows how long our tokens are. Comparing hashes of equal length
  // would hide it, at the cost of making this harder to read for no real gain.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type OrderAuth = {
  /** True when the caller proved they are the buyer (token or ownership), as
   * opposed to staff looking at someone else's order. */
  isBuyer: boolean;
  /** True when the caller may see the buyer's own contact details. */
  maySeeContact: boolean;
  /**
   * True when a real signed-in account proved this, not just a link.
   *
   * A guest's only credential is the URL they were given, and URLs get
   * forwarded, screenshotted and left in shared chat threads. That is an
   * acceptable key for READING a ticket — the holder needs to open it at the
   * gate — but not for refunding money or disposing of the seat. Routes that
   * do either require this flag, so a leaked link cannot spend or destroy
   * what it can show.
   */
  viaSession: boolean;
};

/**
 * Authorise a request against one order. Throws 403 rather than 404: the
 * order's existence is not the secret, and a 404 here would let someone probe
 * which ids are real. Never throws 401 — the SPA signs the user out on a 401,
 * and a guest has no session to lose.
 */
export async function authoriseOrder(
  req: Request,
  order: { id: string; customerId: string | null; accessToken: string | null },
  opts: { claimableIfOwnerless?: boolean } = {},
): Promise<OrderAuth> {
  // The signed-in owner first. Checked before the token so that a buyer who
  // has claimed their order gets viaSession even when their browser still
  // has the old guest token lying around in local storage.
  const userId = req.user?.id;
  if (userId && order.customerId && order.customerId === userId) {
    return { isBuyer: true, maySeeContact: true, viaSession: true };
  }

  const token = presentedToken(req);
  if (token && tokenMatches(token, order.accessToken)) {
    return { isBuyer: true, maySeeContact: true, viaSession: false };
  }

  // Staff. scope.any is the capability that already means "act beyond your
  // own rows" everywhere else in this codebase, so it means that here too.
  if (await userHasPermission(req.user, "scope.any")) {
    return { isBuyer: false, maySeeContact: true, viaSession: true };
  }

  /*
   * An order that belongs to NOBODY, on a route that is about to give it an
   * owner. Opt-in, and only /pay passes it.
   *
   * Express checkout made ownerless orders reachable again: /hold no longer
   * requires a session, so a visitor's order has customerId null and its
   * only credential is the accessToken handed back once, which the client
   * keeps in localStorage. That store is best-effort -- CartContext and
   * rememberOrderKey both swallow write failures -- so private browsing, a
   * full quota, or a store cleared between picking seats and paying left the
   * buyer holding their OWN order and getting "This order is not yours",
   * with nothing on the page to do about it. The sign-up wall we removed was
   * at least escapable.
   *
   * Safe because an ownerless PENDING order is not an asset: it carries no
   * name, email or phone yet (/hold writes them blank), it reveals nothing
   * about anybody, and the caller cannot read it back through this branch --
   * /pay is a write that immediately stamps the payer as the owner. A
   * stranger guessing the id could at most pay for seats and receive
   * tickets in their own name, which is indistinguishable from buying them.
   *
   * The moment the order HAS an owner this branch stops applying, so it can
   * never be used to reach a real buyer's order: that is the line above.
   *
   * viaSession stays false -- nothing here proved an account. Routes that
   * refund or dispose of a seat demand that flag and are unaffected.
   */
  if (opts.claimableIfOwnerless && !order.customerId) {
    return { isBuyer: true, maySeeContact: true, viaSession: false };
  }

  throw new HttpError(403, "This order is not yours");
}

/**
 * The organiser of the event is allowed to see their own buyers — that is the
 * guest list. Checked separately from authoriseOrder because it needs the
 * event, and because an organiser is not the buyer.
 */
export async function authoriseOrderOrOrganiser(
  req: Request,
  order: { id: string; customerId: string | null; accessToken: string | null; eventId: string },
): Promise<OrderAuth> {
  try {
    return await authoriseOrder(req, order);
  } catch (err) {
    const userId = req.user?.id;
    if (!userId) throw err;
    const event = await prisma.event.findUnique({
      where: { id: order.eventId },
      select: { organiserId: true },
    });
    if (event?.organiserId === userId) return { isBuyer: false, maySeeContact: true, viaSession: true };
    throw err;
  }
}

/**
 * Load a ticket for an action that spends money or disposes of the seat:
 * cancel-for-refund, resale, giving it away.
 *
 * These need a real account, not just the order link. A guest buyer can view
 * their ticket, show its QR and fix a typo with the link alone — but the link
 * travels (forwarded, screenshotted, left in a shared thread), and anyone
 * holding a copy would otherwise be able to refund the buyer's money or hand
 * their seat to a stranger, with no account to recover through afterwards.
 *
 * 403 with a distinct message rather than 401: a 401 makes the SPA sign the
 * user out, and a guest has no session to lose. The frontend matches on this
 * to offer "claim this order" instead of a dead error.
 */
export async function requireTicketAccessWithSession(req: Request, ticketId: string) {
  // Proves the caller may touch this ticket at all — by order token, by
  // ticket token (a share recipient), or by session. Throws first if not.
  const ticket = await requireTicketAccess(req, ticketId);

  // Then the stricter question: was it a SESSION that proved it? Asked
  // directly rather than by re-running authoriseOrder, because a share
  // recipient's ticket-scoped token is not the order's and would fail that
  // with "This order is not yours" — true of the token, misleading to
  // someone who does legitimately hold the ticket.
  const userId = req.user?.id;
  const ownsIt = Boolean(userId) && ticket.order.customerId === userId;
  if (!ownsIt && !(await userHasPermission(req.user, "scope.any"))) {
    throw new HttpError(403, "Create an account to manage this ticket");
  }
  return ticket;
}

/**
 * Load a ticket and authorise the caller against the order it belongs to.
 * This is the single replacement for the three copies of requireOwnTicket.
 */
export async function requireTicketAccess(req: Request, ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { order: { include: { event: true } }, tier: true },
  });
  // A missing ticket is a genuine 404 — there is nothing to protect.
  if (!ticket) throw new HttpError(404, "Ticket not found");

  // A ticket received through a share link has its own token, because it sits
  // on the SENDER's order and the recipient must not be handed the key to the
  // rest of it. Checked first so the narrower credential is enough on its own.
  const presented = presentedToken(req);
  if (presented && ticket.accessToken && tokenMatches(presented, ticket.accessToken)) {
    return ticket;
  }

  await authoriseOrder(req, ticket.order);
  return ticket;
}
