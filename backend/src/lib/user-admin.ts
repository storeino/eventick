import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";

/**
 * Removing an account.
 *
 * There are two honest outcomes, and which one applies is decided by the data
 * rather than offered as a choice:
 *
 *  - DELETED: the row is gone. Only for an account that leaves nothing behind
 *    that has to stay readable — no payouts, no events with sales.
 *  - ANONYMISED: the row stays, stripped of personal data. For an account
 *    entangled in money history. A buyer's order has to keep existing — the
 *    organiser was paid for it, the ticket may still admit someone, and the
 *    payout that settled it is a financial record — so erasing the row would
 *    either break those or quietly rewrite the books.
 *
 * Offering only a hard delete would mean either refusing most real accounts or
 * deleting financial history to satisfy the request. Anonymising keeps the
 * promise that matters (the person's details are gone) without the collateral.
 */

export type RemovalMode = "deleted" | "anonymised";

export interface RemovalPlan {
  mode: RemovalMode;
  /** Why, in a sentence the caller can show. */
  reason: string;
  /** What is standing in the way of a hard delete. */
  blockers: { payouts: number; eventsWithSales: number; orders: number };
}

/**
 * Decide what removing this account would do, without doing it.
 *
 * Exposed separately so the UI can warn before the click rather than after:
 * "this will anonymise, not delete" is information someone wants in the
 * confirmation dialog.
 */
export async function planRemoval(userId: string): Promise<RemovalPlan> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new HttpError(404, "User not found");

  const [payouts, orders, eventsWithSales] = await Promise.all([
    // Payout.organiserId is onDelete: Restrict, so this is a hard block at
    // the database level, not just a policy here.
    prisma.payout.count({ where: { organiserId: userId } }),
    prisma.order.count({ where: { customerId: userId } }),
    prisma.event.count({ where: { organiserId: userId, orders: { some: { status: { in: ["PAID", "REFUNDED"] } } } } }),
  ]);

  const blockers = { payouts, eventsWithSales, orders };

  if (payouts > 0) {
    return {
      mode: "anonymised",
      reason: `This organiser has ${payouts} payout(s). Financial records must survive, so the account is anonymised rather than deleted.`,
      blockers,
    };
  }
  if (eventsWithSales > 0) {
    return {
      mode: "anonymised",
      reason: `This organiser has ${eventsWithSales} event(s) with sales. Buyers' tickets and the revenue history depend on them, so the account is anonymised rather than deleted.`,
      blockers,
    };
  }
  if (orders > 0) {
    return {
      mode: "anonymised",
      reason: `This customer has ${orders} order(s). The organiser was paid for them and the tickets may still admit someone, so the account is anonymised rather than deleted.`,
      blockers,
    };
  }
  return { mode: "deleted", reason: "This account has no orders, sales or payouts, so it is deleted outright.", blockers };
}

/**
 * Remove an account, the way planRemoval says.
 *
 * Returns the mode actually applied, which the caller records in the audit
 * trail — "deleted" and "anonymised" are different enough that a journal row
 * saying only "removed" would be useless.
 */
export async function removeUser(userId: string): Promise<{ mode: RemovalMode; email: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw new HttpError(404, "User not found");

  const plan = await planRemoval(userId);

  if (plan.mode === "deleted") {
    // Cascades take the application, bank account and any subscription rows;
    // SetNull detaches the events and shares that carry no sales.
    await prisma.user.delete({ where: { id: userId } });
    logger.info({ userId, email: user.email }, "user deleted");
    return { mode: "deleted", email: user.email };
  }

  /*
   * Anonymise in place.
   *
   * The email must stay UNIQUE and must not be reusable as a login, so it
   * becomes an opaque non-address rather than being blanked — two anonymised
   * accounts would otherwise collide on an empty string. The password hash is
   * replaced with random bytes rather than cleared: a null or empty hash is
   * the kind of value a future bcrypt.compare bug could treat as a match.
   */
  const token = randomBytes(8).toString("hex");
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: "Compte supprimé",
        email: `deleted-${token}@invalid.eventick`,
        passwordHash: randomBytes(32).toString("hex"),
        // Demoted so nothing inherits the old capability, whatever the role
        // was: an anonymised organiser must not keep selling.
        role: "CUSTOMER",
        planId: null,
      },
    });
    // The bank account is the one thing with no reason to survive: it is
    // personal, and a payout already made recorded its own copy.
    await tx.bankAccount.deleteMany({ where: { userId } });
  });

  logger.info({ userId, was: user.email }, "user anonymised (financial history retained)");
  return { mode: "anonymised", email: user.email };
}
