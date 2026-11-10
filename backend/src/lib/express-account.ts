import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { HttpError } from "./http.js";
import { phoneOk } from "./payment-sim.js";
import { logger } from "./logger.js";

/**
 * The account a buyer gets without being asked for one.
 *
 * Requiring a session before checkout was right about the destination and
 * wrong about the moment: it sent a stranger who had just picked a seat to
 * a sign-up form before they had given anything, which is the cheapest
 * possible place to lose a sale.
 *
 * So the account is made here, at payment, out of the name, email and phone
 * any checkout asks for anyway. It is a consequence of the sale rather than
 * a toll before it, and every completed order still has a real owner.
 */

/**
 * The stored hash for an account that has never had a password.
 *
 * NOT a hash of anything. bcrypt.compare returns false for any input when
 * the stored value is not a valid bcrypt string, so this account cannot be
 * signed into at all — which is the point. There is no password to guess,
 * no default to leak, and no window where a predictable one works.
 *
 * The prefix is readable on purpose: someone reading the users table should
 * be able to tell "has not set a password yet" from a corrupted hash.
 */
export const NO_PASSWORD = "!no-password-set";

/** Whether this account still has no usable password. */
export function hasNoPassword(passwordHash: string): boolean {
  return passwordHash === NO_PASSWORD;
}

export interface ExpressBuyer {
  holderName: string;
  email: string;
  phone: string;
  /** Supplied when the email already belongs to an account. */
  password?: string;
}

/**
 * Find or create the account behind a checkout.
 *
 * Three cases, and the middle one is the one that matters:
 *
 *  - no account with that email: create one with no password. They reach
 *    their tickets through the emailed order link, and set a password when
 *    they want to sign in properly.
 *
 *  - an account exists and a password was given: verify it. This is a
 *    sign-in, done without leaving the checkout.
 *
 *  - an account exists and no password was given: refuse with 409 and a
 *    flag the form can act on, so it asks for the password in place rather
 *    than redirecting. Letting the order through would attach a stranger's
 *    purchase to somebody else's account and show them its details.
 */
export async function resolveExpressAccount(
  buyer: ExpressBuyer,
): Promise<{ userId: string; created: boolean }> {
  const email = buyer.email.trim().toLowerCase();
  if (!email.includes("@")) throw new HttpError(400, "A valid email is required");
  if (buyer.holderName.trim().length < 3) throw new HttpError(400, "Buyer name is required");
  if (!phoneOk(buyer.phone)) throw new HttpError(400, "Invalid phone number");

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    /*
     * The ACCOUNT's state decides first, before whether a password was sent.
     *
     * An account made by an earlier express checkout has no password at
     * all, so asking for one is a dead end: there is nothing the buyer
     * could type that would work. Checking `!buyer.password` first sent
     * them exactly there — a password field for a password that does not
     * exist — which is worse than the sign-up form this flow replaced.
     *
     * They are told to use the link in their ticket email instead, which is
     * how they reach that account today.
     */
    if (hasNoPassword(existing.passwordHash)) {
      throw new HttpError(
        409,
        "This email already has an account with no password yet — use the link in your ticket email, or set a password first.",
        { needsPasswordSetup: true },
      );
    }

    if (!buyer.password) {
      /*
       * 409 with `emailTaken`, not 401.
       *
       * The client needs to tell "this email has an account, ask for its
       * password" from "that password was wrong", and a bare 401 reads as
       * the latter. The flag is what lets the checkout grow a password
       * field in place instead of sending the buyer to a login page — the
       * interruption this whole change exists to remove.
       */
      throw new HttpError(409, "This email already has an account — sign in to continue.", {
        emailTaken: true,
      });
    }

    const ok = await bcrypt.compare(buyer.password, existing.passwordHash);
    if (!ok) throw new HttpError(401, "Invalid email or password");
    return { userId: existing.id, created: false };
  }

  const user = await prisma.user.create({
    data: {
      name: buyer.holderName.trim(),
      email,
      phone: buyer.phone.trim(),
      passwordHash: NO_PASSWORD,
      // CUSTOMER explicitly, never inherited from anything in the request:
      // this path is reachable by anyone on the internet.
      role: "CUSTOMER",
    },
  });
  logger.info({ userId: user.id, email }, "account created from checkout");
  return { userId: user.id, created: true };
}
