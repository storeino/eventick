// Buyer-field validation. Card validation (Luhn, expiry, formatting) lived
// here when the app collected card numbers itself; CMI's hosted page owns
// that now, so only the contact fields remain.
//
// Must stay in step with backend/src/lib/payment-sim.ts — the server rejects
// what this accepts, so a looser rule here just produces a confusing 400.

function digitsOnly(value) {
  return value.replace(/\D+/g, "");
}

export function phoneOk(value) {
  const d = digitsOnly(value);
  if (d.startsWith("212") && d.length === 12) return /^212[5-7]\d{8}$/.test(d);
  if (d.length === 10) return /^0[5-7]\d{8}$/.test(d);
  return false;
}

export function emailOk(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/*
 * The shortest password a buyer may CHOOSE at checkout, for an account that
 * has none yet.
 *
 * Must stay in step with MIN_PASSWORD_LENGTH in
 * backend/src/lib/express-account.ts, for the reason stated at the top of
 * this file: the server rejects what this accepts, so a looser rule here
 * only turns a clear message into a confusing 400.
 */
export const MIN_PASSWORD = 8;
