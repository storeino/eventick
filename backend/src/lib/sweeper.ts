import { prisma } from "./prisma.js";
import { expireStaleOffers, offerFreedSeats } from "./waitlist.js";
import { logger } from "./logger.js";

/**
 * Background sweep for state that goes stale on a clock rather than on a
 * request.
 *
 * Expiry used to be lazy: `expireStaleOffers` only ran when something else
 * happened to free a seat. On a quiet event nothing ever did, so a lapsed
 * offer sat showing as OFFERED on the organiser's dashboard and the person
 * behind it was never moved on — the queue silently stopped advancing.
 *
 * Seat COUNTING was never affected: every availability query filters offers
 * by `claimExpiresAt > now` and holds by `holdUntil > now`, so lapsed ones
 * stop reserving inventory the moment they lapse. This sweep is about the
 * records agreeing with that, and about the next person actually getting
 * their turn.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One pass. Exported so a test can run it directly instead of waiting. */
export async function sweepOnce(): Promise<{ expired: number; reoffered: number }> {
  const expired = await expireStaleOffers();

  // Stale PENDING orders hold nothing (availability ignores a lapsed
  // holdUntil), but leaving them PENDING forever makes the organiser's order
  // list unreadable and hides which carts were genuinely abandoned.
  //
  // Done BEFORE the re-offer below, not after: cancelling these is itself a
  // way seats come back, so offering first would miss them for a whole sweep
  // interval.
  const abandoned = await prisma.order.updateMany({
    where: { status: "PENDING", holdUntil: { lt: new Date() } },
    data: { status: "CANCELLED", holdUntil: null },
  });

  let reoffered = 0;
  /*
   * Re-offer after EITHER a lapsed offer or an abandoned cart.
   *
   * It used to run only when `expired > 0`, which missed the abandoned case
   * entirely — and that is the one a real CMI checkout produces. The offer is
   * marked CLAIMED when the buyer leaves for the gateway (it must not stay
   * claimable while they are there), so a buyer who never pays leaves a seat
   * that is no longer offered to anyone and no longer held by them. Nothing
   * put it back in front of the queue until some unrelated offer happened to
   * lapse on the same event.
   */
  if (expired > 0 || abandoned.count > 0) {
    // Only events that still have somebody waiting — not every event in the
    // database.
    const events = await prisma.waitlistEntry.findMany({
      where: { status: "WAITING" },
      select: { eventId: true },
      distinct: ["eventId"],
    });
    for (const { eventId } of events) {
      const result = await offerFreedSeats(eventId);
      reoffered += result.offered;
    }
  }

  if (expired > 0 || reoffered > 0 || abandoned.count > 0) {
    logger.info({ expired, reoffered, abandoned: abandoned.count }, "sweep complete");
  }
  return { expired, reoffered };
}

export function startSweeper(intervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)): void {
  if (timer) return;

  const tick = async () => {
    // Skip rather than queue: a slow pass must not pile up behind itself.
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      // A failed sweep must never take the process down — the next tick retries.
      logger.warn({ err }, "sweep failed");
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  // Don't hold the event loop open: the process should still exit on SIGTERM.
  timer.unref();
  void tick();
  logger.info({ intervalMs }, "sweeper started");
}

export function stopSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
