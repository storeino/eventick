import type { Request } from "express";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

/**
 * The audit trail — who did what, to whom, and when.
 *
 * Only for actions where "it just changed" is not an acceptable answer: a role
 * change, a permission grant, a refund, a plan assignment, a payout, an
 * account deletion. Reads and ordinary CRUD stay out deliberately — a log that
 * records everything is one nobody reads, and the value here is that every row
 * is something a person should be able to account for.
 *
 * Recording NEVER fails the action it describes. An admin refunding a buyer
 * must not get a 500 because the log insert failed; the refund already
 * happened, and losing the record is the lesser harm. So every write is
 * fire-and-forget with its own catch, and a failure is logged loudly instead.
 */

/**
 * The action vocabulary.
 *
 * A closed set, not free strings: the journal is filtered and grouped by
 * these, so a typo would silently create a category nobody is looking at.
 * Dotted and past-tense — subject first, so related actions sort together.
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: "user.created",
  USER_ROLE_CHANGED: "user.role.changed",
  USER_DELETED: "user.deleted",
  USER_ANONYMISED: "user.anonymised",
  ROLE_PERMISSION_GRANTED: "role.permission.granted",
  ROLE_PERMISSION_REVOKED: "role.permission.revoked",
  ORGANISER_APPLICATION_DECIDED: "organiser.application.decided",
  ORGANISER_PLAN_ASSIGNED: "organiser.plan.assigned",
  ORDER_REFUNDED: "order.refunded",
  ORDER_REFUND_RECONCILED: "order.refund.reconciled",
  /** Money actually sent back to a buyer, which CMI cannot do for us. */
  ORDER_REFUND_PAID: "order.refund.paid",
  ORDER_CANCELLED: "order.cancelled",
  PAYOUT_CREATED: "payout.created",
  PAYOUT_PAID: "payout.paid",
  PAYOUT_CANCELLED: "payout.cancelled",
  BANK_ACCOUNT_CHANGED: "bank_account.changed",
  EVENT_CANCELLED: "event.cancelled",
  COMPS_ISSUED: "event.comps.issued",
  COMP_REVOKED: "invitation.revoked",
  /*
   * The three below are overrides an organiser may be asked to justify, which
   * is the test for belonging here — not "a row changed".
   *
   * They were missing, and the omission was not a decision: there was simply
   * no action name to record them under, so the most disputable things an
   * organiser can do were the ones with no trail. Re-admitting a spent
   * ticket, and repricing or resizing a zone that has already sold, are all
   * answerable-for; creating a draft event or editing a blurb is not, and
   * stays out.
   *
   * There is deliberately no `event.rescheduled`: an event's dates are fixed
   * at creation and no route accepts a new one, so the action would describe
   * something that cannot happen. Add it with the route, not before.
   */
  TICKET_STATUS_OVERRIDDEN: "ticket.status.overridden",
  TIER_PRICE_CHANGED: "tier.price.changed",
  TIER_CAPACITY_CHANGED: "tier.capacity.changed",
  /* A hard delete: the order row is gone, so this row is the only remaining
   * evidence it ever existed. Its details carry the figures deliberately,
   * because there is nothing left to join to. */
  ORDER_DELETED: "order.deleted",
  /* Who an event belongs to decides who its payout pays, at which plan's
   * rate, into which bank account. An admin naming that on someone's behalf,
   * or moving it later, is a decision about money and not about content. */
  EVENT_OWNER_ASSIGNED: "event.owner.assigned",
  EVENT_OWNER_CHANGED: "event.owner.changed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  action: AuditAction;
  /** What kind of thing was acted on: "user", "order", "payout", "role"… */
  subjectType: string;
  subjectId?: string | null;
  /** Human label, so a row reads without a lookup and still reads once the
   * subject is deleted. */
  subjectLabel?: string | null;
  /** What changed. Shape is per-action; keep it small and literal. */
  details?: Record<string, unknown> | null;
}

/** The actor, as the record will remember them. */
interface Actor {
  id: string | null;
  email: string;
  role: string;
}

function actorFrom(req: Request): Actor {
  const user = req.user;
  if (!user) {
    // Shouldn't happen — every audited route authenticates first — but a
    // missing actor must not throw away the record of what was done.
    return { id: null, email: "unknown", role: "unknown" };
  }
  return { id: user.id, email: user.email, role: String(user.role) };
}

/**
 * Client IP, for the case where an account is shared or compromised.
 *
 * `req.ip` already respects the `trust proxy` setting configured in app.ts,
 * so this does not re-parse X-Forwarded-For — doing that by hand is how a
 * spoofable header ends up in an audit record.
 */
function ipFrom(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * Record an action. Fire-and-forget by design — see the module comment.
 *
 * Returns nothing: a caller that awaited this could be made to fail by a log
 * problem, which is the opposite of what an audit trail is for.
 */
export function recordAudit(req: Request, input: AuditInput): void {
  const actor = actorFrom(req);
  void prisma.auditEvent
    .create({
      data: {
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        subjectLabel: input.subjectLabel ?? null,
        details: (input.details ?? undefined) as never,
        ip: ipFrom(req),
      },
    })
    .catch((err) =>
      // Loud, because a silent gap in an audit trail is worse than a noisy
      // one: someone reading the journal later has no way to tell "nothing
      // happened" from "the record was lost".
      logger.error(
        { err, action: input.action, subjectId: input.subjectId },
        "AUDIT WRITE FAILED — this action is not recorded",
      ),
    );
}

export interface AuditQuery {
  action?: string;
  actorId?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
  before?: Date;
}

/** Read the journal, newest first. */
export async function listAudit(query: AuditQuery) {
  // Capped: the journal grows without bound and a page that fetched all of it
  // would get slower every week.
  const take = Math.min(Math.max(query.limit ?? 50, 1), 200);

  const rows = await prisma.auditEvent.findMany({
    where: {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.before ? { at: { lt: query.before } } : {}),
    },
    orderBy: { at: "desc" },
    take,
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: {
      id: row.actorId,
      email: row.actorEmail,
      role: row.actorRole,
      // True once the account is gone: the row survives, and saying so stops
      // it reading as a live account that cannot be found.
      deleted: row.actorId === null,
    },
    subject: { type: row.subjectType, id: row.subjectId, label: row.subjectLabel },
    details: row.details,
    ip: row.ip,
    at: row.at.toISOString(),
  }));
}
