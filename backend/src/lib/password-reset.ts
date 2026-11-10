import bcrypt from "bcryptjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { logger } from "./logger.js";
import { MIN_PASSWORD_LENGTH, hasNoPassword } from "./express-account.js";

/**
 * Recovering an account whose password has been forgotten.
 *
 * None of this existed. There was no route, no email and no link on the
 * login page, so a buyer who forgot their password could not sign in and
 * could not buy -- at the checkout they met that wall with a seat hold
 * counting down and nothing on the page to click.
 *
 * The emailed token is the credential, so it is treated like one: random,
 * stored only as a hash, single use, and short-lived.
 */

/**
 * How long a link stays good.
 *
 * Short on purpose. A reset link is a password equivalent, and the person
 * who asked for it is reading their email right now -- an hour is generous
 * for that and still narrow enough that a link left in an inbox, or in a
 * forwarded thread, stops working long before anyone stumbles on it.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;

/** Minutes, for the email copy. Derived so the two cannot disagree. */
export const RESET_TTL_MINUTES = RESET_TTL_MS / 60_000;

/**
 * The hash we store for a reset token.
 *
 * SHA-256 and not bcrypt, deliberately. bcrypt is slow BY DESIGN because a
 * password is low-entropy and must survive offline guessing; this token is
 * 32 random bytes, which no amount of guessing reaches. What matters here
 * is only that the stored value cannot be reversed into a working link, and
 * that lookup is a single indexed read rather than a scan that bcrypts
 * every outstanding row.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
function digestMatches(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export interface IssuedReset {
  /** The raw token. Goes in the email and is never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Start a reset for this address, if it belongs to an account.
 *
 * Returns null when it does not, or when the account has no password to
 * reset. The CALLER must answer the same way either way -- see the route.
 */
export async function requestReset(rawEmail: string): Promise<IssuedReset | null> {
  const email = rawEmail.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });
  if (!user) return null;

  /*
   * An account that has never had a password is not "forgotten", it is
   * unset -- and the checkout already lets that buyer choose one in place,
   * with no email round trip. Sending a reset link here would be a slower
   * route to the same destination, and would imply the account is locked
   * when it is not.
   */
  if (hasNoPassword(user.passwordHash)) return null;

  /*
   * Older requests are spent, not left alongside. Someone who clicks
   * "forgot password" three times should not end up with three live keys to
   * the same account, two of them sitting in an inbox after the password
   * has already changed.
   */
  await prisma.passwordReset.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  // 32 bytes, base64url -- the same generator and shape as the order access
  // token and TicketShare.token, which solved this problem first.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await prisma.passwordReset.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
  });
  logger.info({ userId: user.id }, "password reset requested");
  return { token, expiresAt };
}

/** What a valid token opens, for the page that renders the form. */
export interface ResetTarget {
  userId: string;
  email: string;
  name: string;
}

/**
 * The account this token opens, or an error saying why it does not.
 *
 * Shared by the "is this link still good?" check the reset page makes on
 * load and the actual reset below, so the two cannot disagree about what
 * counts as valid.
 */
export async function resolveReset(token: string): Promise<{ id: string; target: ResetTarget }> {
  const presented = hashToken(token);
  const row = await prisma.passwordReset.findUnique({
    where: { tokenHash: presented },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  /*
   * One message for every failure: unknown, already spent, expired.
   *
   * Distinguishing them tells someone holding a stale link whether that
   * address has an account and whether a reset was recently requested for
   * it, which is exactly what the route below refuses to reveal.
   */
  const dead = () =>
    new HttpError(400, "This link is no longer valid — ask for a new one.", {
      resetLinkInvalid: true,
    });

  if (!row) throw dead();
  // Re-checked in constant time even though the lookup was by unique key:
  // the index found it, this proves it, and the cost is a few microseconds.
  if (!digestMatches(row.tokenHash, presented)) throw dead();
  if (row.usedAt) throw dead();
  if (row.expiresAt.getTime() < Date.now()) throw dead();

  return { id: row.id, target: { userId: row.user.id, email: row.user.email, name: row.user.name } };
}

/**
 * Spend the token and set the new password.
 *
 * Returns the account, so the route can sign them in rather than making
 * them type the password they have just chosen a second time.
 */
export async function completeReset(token: string, newPassword: string): Promise<ResetTarget> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, {
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  }
  const { id, target } = await resolveReset(token);
  const passwordHash = await bcrypt.hash(newPassword, 10);

  /*
   * Spend the token in the same transaction that changes the password, and
   * guard the spend on usedAt still being null.
   *
   * Two clicks on the same link, or a double-submitted form, would
   * otherwise both pass resolveReset and both write. Here the second finds
   * count 0 and aborts, so the link is used exactly once no matter how many
   * times it is presented.
   */
  await prisma.$transaction(async (tx) => {
    const spent = await tx.passwordReset.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (spent.count !== 1) {
      throw new HttpError(400, "This link is no longer valid — ask for a new one.", {
        resetLinkInvalid: true,
      });
    }
    await tx.user.update({ where: { id: target.userId }, data: { passwordHash } });
  });

  logger.info({ userId: target.userId }, "password reset completed");
  return target;
}
