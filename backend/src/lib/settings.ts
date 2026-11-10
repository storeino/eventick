import { prisma } from "./prisma.js";

/**
 * Platform settings — the business terms an admin sets from the console.
 *
 * One row, id "platform", seeded by the migration so a read on a fresh
 * database finds it. The fallback below is for the case that row is missing
 * anyway (a hand-restored dump, a half-applied migration): it returns the
 * same defaults the migration seeds, so a missing row behaves like an
 * unconfigured one rather than throwing in the middle of a sale.
 */

export const SETTINGS_ID = "platform";

export interface PlatformTerms {
  /** Platform cut of a resale, in basis points. 200 = 2%. */
  resaleFeeBps: number;
}

const DEFAULTS: PlatformTerms = {
  // 0 = no fee, which is what the product did before this setting existed.
  resaleFeeBps: 0,
};

/** The current terms. Never throws; an unreadable row means the defaults. */
export async function platformTerms(): Promise<PlatformTerms> {
  const row = await prisma.platformSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { resaleFeeBps: true },
  });
  if (!row) return DEFAULTS;
  return { resaleFeeBps: row.resaleFeeBps };
}

/**
 * Write the terms, creating the row if it is somehow absent.
 *
 * upsert rather than update: an update against a missing row throws, and the
 * one moment an admin is trying to set a rate is the worst time to discover
 * the seed never ran.
 */
export async function setPlatformTerms(
  patch: Partial<PlatformTerms>,
  actorId: string,
): Promise<PlatformTerms> {
  const row = await prisma.platformSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...DEFAULTS, ...patch, updatedById: actorId },
    update: { ...patch, updatedById: actorId },
    select: { resaleFeeBps: true },
  });
  return { resaleFeeBps: row.resaleFeeBps };
}
