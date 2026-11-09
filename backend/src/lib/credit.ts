import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { logger } from "./logger.js";

/**
 * Store credit — money the platform owes a buyer, spendable on tickets.
 *
 * Exists because a cancelled event could only ever promise a bank refund.
 * CMI has no refund API, so somebody had to reverse every charge by hand in
 * the CMI back office; until they did, the buyer had been emailed
 * "remboursé intégralement" and had nothing. Credit settles instantly.
 *
 * THE BALANCE IS DERIVED. There is no balance column: it is
 * SUM(amountCents) over the holder's entries. Every function here either
 * appends an entry or sums them, and nothing updates or deletes one. A
 * mistake is corrected by appending its opposite, so the history shows both
 * the error and the fix.
 */

/** A Prisma client or an interactive transaction — both satisfy these calls. */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * What a holder can spend right now.
 *
 * Takes an optional transaction client so a checkout can read the balance
 * and spend against it inside ONE transaction. Reading it outside and
 * spending inside is the race this whole module is shaped to avoid.
 */
export async function creditBalance(userId: string, db: Db = prisma): Promise<number> {
  const agg = await db.creditEntry.aggregate({
    where: { userId },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** The holder's statement: what they have, and every movement behind it. */
export async function creditStatement(userId: string): Promise<{
  balanceCents: number;
  entries: {
    id: string;
    amountCents: number;
    reason: string;
    label: string;
    orderId: string | null;
    createdAt: string;
  }[];
}> {
  const entries = await prisma.creditEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amountCents: true,
      reason: true,
      label: true,
      orderId: true,
      createdAt: true,
    },
  });
  return {
    // Summed from the rows just read, not a second query: a total that
    // disagrees with the list under it is worse than no total.
    balanceCents: entries.reduce((sum, e) => sum + e.amountCents, 0),
    entries: entries.map((e) => ({
      id: e.id,
      amountCents: e.amountCents,
      reason: e.reason,
      label: e.label,
      orderId: e.orderId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/**
 * Grant credit.
 *
 * Idempotent per (order, reason) by a UNIQUE INDEX, not by a check-then-write:
 * cancelEvent converts orders one at a time and may be retried after a
 * partial failure, and a check-then-write would let a retry append a second
 * grant for an order already converted. Returns null when the grant already
 * existed, so a caller can tell "granted" from "was already granted" without
 * treating the second as an error.
 */
export async function grantCredit(input: {
  userId: string;
  amountCents: number;
  reason: "EVENT_CANCELLED" | "ORDER_REFUND" | "PURCHASE_REVERSED" | "ADJUSTMENT";
  label: string;
  orderId?: string | null;
  note?: string | null;
  actorId?: string | null;
  db?: Db;
}): Promise<{ id: string; amountCents: number } | null> {
  const db = input.db ?? prisma;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new HttpError(400, "A credit grant must be a positive whole number of cents");
  }
  if (!input.label.trim()) {
    // The holder sees this on their balance screen. An unlabelled grant is
    // an amount with no explanation, which is the thing they will ask about.
    throw new HttpError(400, "A credit grant needs a label — the holder reads it");
  }
  try {
    const entry = await db.creditEntry.create({
      data: {
        userId: input.userId,
        amountCents: input.amountCents,
        reason: input.reason,
        label: input.label.trim(),
        orderId: input.orderId ?? null,
        note: input.note?.trim() || null,
        actorId: input.actorId ?? null,
      },
      select: { id: true, amountCents: true },
    });
    return entry;
  } catch (err) {
    // P2002 = the unique index fired, so this exact grant is already on the
    // ledger. Not an error: it is the guard working.
    if (isUniqueViolation(err)) {
      logger.info(
        { userId: input.userId, orderId: input.orderId, reason: input.reason },
        "credit grant already on the ledger, skipping",
      );
      return null;
    }
    throw err;
  }
}

/**
 * Spend credit on an order.
 *
 * MUST be called inside a transaction that also writes the order, and the
 * balance MUST be read with the same client — otherwise two concurrent
 * checkouts can both read the same balance, both pass the check below, and
 * both spend it.
 *
 * Returns how much was actually applied, which is the lesser of the balance
 * and what is owed. Spending more than the balance is refused rather than
 * clamped silently: a checkout that quietly charged a card for the shortfall
 * the buyer thought was covered is worse than an error.
 */
export async function spendCredit(input: {
  userId: string;
  amountCents: number;
  orderId: string;
  label: string;
  db: Db;
}): Promise<number> {
  if (input.amountCents <= 0) return 0;

  const balance = await creditBalance(input.userId, input.db);
  if (balance < input.amountCents) {
    throw new HttpError(409, "Not enough credit for this order");
  }

  await input.db.creditEntry.create({
    data: {
      userId: input.userId,
      // Negative: spending. The sign is the whole mechanism.
      amountCents: -input.amountCents,
      reason: "PURCHASE",
      label: input.label.trim() || "Achat de billets",
      orderId: input.orderId,
    },
  });
  return input.amountCents;
}

/**
 * Give back credit an order consumed, when that order is cancelled.
 *
 * Without this, cancelling a credit-paid order would take the tickets away
 * and keep the credit — the buyer would lose twice. Keyed PURCHASE_REVERSED
 * so it cannot collide with the PURCHASE it reverses, and so the pair reads
 * as a spend and its reversal rather than as a mysterious second grant.
 */
export async function reverseOrderCredit(
  orderId: string,
  db: Db = prisma,
): Promise<number> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, creditAppliedCents: true, event: { select: { titleFr: true } } },
  });
  if (!order || !order.customerId || order.creditAppliedCents <= 0) return 0;

  const entry = await grantCredit({
    userId: order.customerId,
    amountCents: order.creditAppliedCents,
    reason: "PURCHASE_REVERSED",
    label: `Annulation — ${order.event.titleFr}`,
    orderId: order.id,
    db,
  });
  return entry ? entry.amountCents : 0;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002",
  );
}
