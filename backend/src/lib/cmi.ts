import { createHash, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";

/**
 * CMI (Centre Monétique Interbancaire) — the payment gateway.
 *
 * CMI is a REDIRECT gateway: we hand the browser a signed form, it POSTs to
 * CMI's hosted 3-D Secure page, the buyer types their card there, and CMI
 * reports the outcome to us server-to-server. No card data ever reaches this
 * server.
 *
 * Trust rests on two hashes:
 *  1. The REQUEST hash proves the amount and order reference were set by us,
 *     so a buyer cannot edit the form and pay 1 MAD for an 850 MAD ticket.
 *  2. The CALLBACK hash proves an "approved" message really came from CMI.
 *     The callback endpoint is public, so without this check anyone who
 *     guessed an order id could POST `ProcReturnCode=00` and get free tickets.
 *
 * With no CMI_CLIENT_ID/CMI_STORE_KEY the app runs in MOCK mode (a hold is
 * confirmed straight to PAID). Production refuses to boot that way.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** CMI settles in MAD only; 504 is its numeric currency code. */
export const CMI_CURRENCY = "504";

const TEST_GATEWAY_URL = "https://testpayment.cmi.co.ma/fim/est3Dgate";

/**
 * Reserve the funds; our callback reply decides whether they are taken.
 *
 * With preAuth the card is only authorised, and answering the callback with
 * ACTION=POSTAUTH is what captures it — so the webhook's FAILURE (sold out,
 * hold expired while the buyer was at the gateway) genuinely leaves the money
 * with the buyer. Spelled exactly as the Storeino production gateway
 * (api-payments) sends it.
 */
const TRAN_TYPE = "preAuth";

/** Fixed form fields: hosted 3-D Secure page, ver3 hash, 5s auto-redirect back. */
const STATIC_FIELDS = {
  currency: CMI_CURRENCY,
  TranType: TRAN_TYPE,
  storetype: "3d_pay_hosting",
  hashAlgorithm: "ver3",
  refreshtime: "5",
} as const;

/** Fields CMI leaves out of its own hash, compared case-insensitively. */
const UNHASHED_FIELDS = new Set(["hash", "encoding"]);

/** CMI's "approved" response code. Anything else is a decline or an error. */
const APPROVED_CODE = "00";

/**
 * Locales that have their own URL prefix on the frontend.
 *
 * Filled in by the change that shipped `app/[locale]/`: /fr/ and /ar/ are
 * real routes now, so a buyer who paid in Arabic returns to the Arabic
 * confirmation page instead of the French one.
 *
 * "en" is absent deliberately and must stay absent until an /en/ route
 * exists — this value becomes a redirect target CMI sends the buyer back to,
 * so a prefix with no route behind it is a 404 at the worst possible moment,
 * holding a charged card and no ticket. That is also why this is an
 * allowlist rather than a passthrough of whatever the caller sent.
 */
const LOCALE_PREFIXES = new Set<string>(["fr", "ar"]);

// ─── Configuration ──────────────────────────────────────────────────────────

export interface CmiConfig {
  clientId: string;
  storeKey: string;
  gatewayUrl: string;
}

export function cmiConfig(): CmiConfig | null {
  const clientId = process.env.CMI_CLIENT_ID;
  const storeKey = process.env.CMI_STORE_KEY;
  if (!clientId || !storeKey) return null;
  return {
    clientId,
    storeKey,
    gatewayUrl: process.env.CMI_GATEWAY_URL ?? TEST_GATEWAY_URL,
  };
}

let warnedMock = false;

export function isMockPayments(): boolean {
  const mock = cmiConfig() === null;
  if (mock && !warnedMock) {
    warnedMock = true;
    logger.warn("CMI_CLIENT_ID/CMI_STORE_KEY unset — payments run in MOCK mode (no card is charged)");
  }
  return mock;
}

/** Called at boot: mock payments must never run on a production host. */
export function assertPaymentConfig(): void {
  if (process.env.NODE_ENV === "production" && isMockPayments()) {
    throw new Error(
      "CMI_CLIENT_ID and CMI_STORE_KEY are required in production — refusing to start in mock payment mode",
    );
  }
}

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * Escape one value for the hash string.
 *
 * Backslash FIRST, then pipe — the other order would re-escape the backslash
 * just inserted. Without escaping, a "|" inside a value could shift the field
 * boundaries and make two different payloads hash the same.
 */
function escapeHashValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/** Case-insensitive, numeric-aware: CMI's reference uses PHP's natcasesort. */
function compareFieldNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * CMI's "ver3" hash: field names sorted case-insensitively, their values
 * escaped and joined with "|", the store key appended, then SHA-512 — and the
 * RAW digest bytes base64-encoded, not the hex string.
 */
export function buildHash(params: Record<string, unknown>, storeKey: string): string {
  const plain = Object.keys(params)
    .filter((name) => !UNHASHED_FIELDS.has(name.toLowerCase()))
    .sort(compareFieldNames)
    .map((name) => `${escapeHashValue(params[name])}|`)
    .join("");

  return createHash("sha512").update(plain + escapeHashValue(storeKey), "utf8").digest("base64");
}

/** CMI posts the signature as HASH, and sometimes as hash. */
function presentedHash(body: Record<string, unknown>): string | null {
  for (const value of [body.HASH, body.hash]) {
    if (typeof value === "string") return value;
  }
  return null;
}

/** Timing-safe: a plain === leaks how much matched, enough to forge byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Recompute the hash over everything CMI posted back and compare it to the
 * signature it sent. False on any mismatch, including a missing signature.
 *
 * Every posted field participates, not a fixed list: CMI signs all of what it
 * sends, so hashing only known fields would break the day CMI adds one.
 */
export function verifyCallbackHash(body: Record<string, unknown>, storeKey: string): boolean {
  const presented = presentedHash(body);
  return presented !== null && safeEqual(presented, buildHash(body, storeKey));
}

// ─── Payment request ────────────────────────────────────────────────────────

export interface CmiPaymentRequest {
  /** Where the browser must POST the fields. */
  action: string;
  /** Hidden form fields, signature included. */
  fields: Record<string, string>;
  /** The reference CMI will echo back as `oid`. */
  oid: string;
}

export interface CmiOrderInput {
  /** Becomes CMI's `oid`; what the callback uses to find the order again. */
  reference: string;
  totalCents: number;
  email: string;
  holderName: string;
  phone?: string | null;
  /** Where CMI POSTs the outcome, server-to-server. */
  callbackUrl: string;
  /** Where the buyer's browser lands afterwards. */
  okUrl: string;
  failUrl: string;
  locale?: "fr" | "en" | "ar";
}

/** MAD units with two decimals: CMI expects "850.00"; 85000 would charge 100x. */
function formatAmount(totalCents: number): string {
  return (totalCents / 100).toFixed(2);
}

/**
 * Per-request nonce. CMI rejects a replayed (oid, rnd) pair, and it is part
 * of the hash, so two attempts on the same order sign differently.
 */
function nonce(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/** CMI's page speaks fr and en only; Arabic buyers get the French page. */
function gatewayLang(locale: CmiOrderInput["locale"]): "fr" | "en" {
  return locale === "en" ? "en" : "fr";
}

/**
 * Add the signature and encoding. Both go on AFTER the hash is computed, and
 * buildHash excludes them anyway. Upper-case HASH, as CMI's samples and the
 * Storeino production gateway post it.
 */
function sign(fields: Record<string, string>, storeKey: string): Record<string, string> {
  return { ...fields, HASH: buildHash(fields, storeKey), encoding: "UTF-8" };
}

/** Build the signed form that sends a buyer to CMI. */
export function buildPaymentRequest(input: CmiOrderInput, config: CmiConfig): CmiPaymentRequest {
  const fields: Record<string, string> = {
    ...STATIC_FIELDS,
    clientid: config.clientId,
    oid: input.reference,
    amount: formatAmount(input.totalCents),
    rnd: nonce(),
    lang: gatewayLang(input.locale),
    callbackUrl: input.callbackUrl,
    okUrl: input.okUrl,
    failUrl: input.failUrl,
    BillToName: input.holderName.trim(),
    email: input.email.trim(),
    tel: input.phone?.trim() ?? "",
  };

  return { action: config.gatewayUrl, fields: sign(fields, config.storeKey), oid: input.reference };
}

// ─── Callback ───────────────────────────────────────────────────────────────

export function isApproved(body: Record<string, unknown>): boolean {
  return String(body.ProcReturnCode ?? "") === APPROVED_CODE;
}

/*
 * The `oid` carries the order AND the attempt: `<orderId>-<attempt>`.
 *
 * CMI treats an oid as ONE transaction and refuses a second attempt on it
 * ("There is an ongoing transaction related to the order. (99)"), so with the
 * bare order id a buyer whose card was declined could never retry.
 *
 * cuid() ids contain no hyphen, so splitting on the LAST one is unambiguous,
 * and an oid with no suffix still resolves for payments already in flight.
 */
export function buildOid(orderId: string, attempt: number): string {
  return `${orderId}-${attempt}`;
}

/** Recover the order id from an oid CMI echoed back. */
export function orderIdFromOid(oid: string): string {
  const cut = oid.lastIndexOf("-");
  if (cut <= 0) return oid;
  // Only strip a numeric suffix: anything else is part of the id itself.
  return /^\d+$/.test(oid.slice(cut + 1)) ? oid.slice(0, cut) : oid;
}

// ─── Return URLs ────────────────────────────────────────────────────────────

function baseUrl(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, "");
}

/**
 * Where CMI sends the buyer and the result.
 *
 * All three must be absolute and reachable from outside: CMI redirects a real
 * browser to okUrl/failUrl and calls callbackUrl from its own servers, so a
 * localhost callback never arrives. Use a tunnel (CMI_CALLBACK_URL) locally.
 *
 * The access token rides along so a guest buyer lands on a confirmation page
 * they may read. The locale prefix is allowlisted, never passed through: it
 * reaches CMI and comes back as a redirect target.
 */
export function cmiUrls(
  orderId: string,
  accessToken?: string | null,
  locale?: string | null,
  /*
   * Where to land on success, when a confirmation page is the wrong place.
   *
   * An upgrade's order holds no tickets of its own — it buys a move, not a
   * seat — so /confirmation/:orderId would show the buyer an order with
   * nothing in it. Given as a path, never a full URL: it is joined to our own
   * origin here, so a caller cannot turn the OK redirect into an open one.
   */
  successPath?: string | null,
) {
  const app = baseUrl(process.env.PUBLIC_APP_URL, "http://localhost:3100");
  const api = baseUrl(process.env.PUBLIC_API_URL, "http://localhost:4100");
  const key = accessToken ? `?k=${encodeURIComponent(accessToken)}` : "";
  const prefix = LOCALE_PREFIXES.has(locale ?? "") ? `/${locale}` : "";
  const ok = successPath && successPath.startsWith("/") && !successPath.startsWith("//")
    ? `${app}${prefix}${successPath}`
    : `${app}${prefix}/confirmation/${orderId}${key}`;

  return {
    callbackUrl: process.env.CMI_CALLBACK_URL ?? `${api}/api/webhooks/cmi`,
    okUrl: ok,
    failUrl: `${app}${prefix}/paiement?echec=1&commande=${encodeURIComponent(orderId)}`,
  };
}
