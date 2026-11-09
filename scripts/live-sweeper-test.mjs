/**
 * Live test — the scheduled sweep.
 *
 * Waitlist expiry used to be lazy: `expireStaleOffers` ran only when some
 * other request happened to free a seat. On a quiet event nothing ever did,
 * so a lapsed offer sat showing as OFFERED on the organiser's dashboard and
 * the next person in the queue never got their turn.
 *
 * Run from the backend directory:
 *   cd backend && npx tsx ../scripts/live-sweeper-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";
import { sweepOnce } from "../backend/src/lib/sweeper.js";

const SUFFIX = Date.now();
let failures = 0;

function check(label, pass, detail) {
  if (!pass) failures++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

async function main() {
  const start = new Date(Date.now() + 30 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      slug: `sweep-test-${SUFFIX}`,
      titleFr: "Balayage",
      titleAr: "اختبار",
      category: "concert",
      city: "Casablanca",
      venueFr: "Salle",
      venueAr: "قاعة",
      address: "1 rue test",
      startAt: start,
      endAt: new Date(start.getTime() + 3 * 3_600_000),
      doorsAt: new Date(start.getTime() - 3_600_000),
      image: "https://example.com/a.jpg",
      blurbFr: "x",
      blurbAr: "x",
      aboutFr: "x",
      aboutAr: "x",
      ageFr: "18+",
      ageAr: "+18",
      status: "PUBLISHED",
      // 0 = unlimited: this suite buys repeatedly as one email, which the
      // per-buyer limit exists to stop. That limit is covered by
      // live-ticketing-test; here it would only obstruct.
      maxPerBuyer: 0,
      tiers: {
        create: {
          nameFr: "Standard",
          nameAr: "عادي",
          blurbFr: "x",
          blurbAr: "x",
          priceCents: 10000,
          capacity: 2,
          zoneFr: "A",
          zoneAr: "أ",
          gateFr: "1",
          gateAr: "1",
        },
      },
    },
    include: { tiers: true },
  });
  const tier = event.tiers[0];

  // An offer whose 30-minute window closed ten minutes ago.
  const lapsed = await prisma.waitlistEntry.create({
    data: {
      eventId: event.id,
      email: `sweep-lapsed-${SUFFIX}@example.com`,
      status: "OFFERED",
      claimToken: `tok-${SUFFIX}`,
      claimTierId: tier.id,
      claimExpiresAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  // Someone still waiting behind them, who should get the seat.
  const waiting = await prisma.waitlistEntry.create({
    data: {
      eventId: event.id,
      email: `sweep-next-${SUFFIX}@example.com`,
      status: "WAITING",
    },
  });

  // An abandoned cart whose hold lapsed.
  const stale = await prisma.order.create({
    data: {
      eventId: event.id,
      status: "PENDING",
      holderName: "Panier abandonné",
      email: "a@example.com",
      phone: "0612345678",
      subtotalCents: 10000,
      totalCents: 10000,
      holdUntil: new Date(Date.now() - 60 * 1000),
      lines: { create: { tierId: tier.id, qty: 1 } },
    },
  });

  // A hold still inside its window — must be left alone.
  const live = await prisma.order.create({
    data: {
      eventId: event.id,
      status: "PENDING",
      holderName: "Panier actif",
      email: "b@example.com",
      phone: "0612345678",
      subtotalCents: 10000,
      totalCents: 10000,
      holdUntil: new Date(Date.now() + 10 * 60 * 1000),
      lines: { create: { tierId: tier.id, qty: 1 } },
    },
  });

  console.log("\n\x1b[1mScheduled sweep\x1b[0m");
  const result = await sweepOnce();
  check("the sweep expired the lapsed offer", result.expired === 1, `expired=${result.expired}`);

  const lapsedAfter = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: lapsed.id } });
  check("the lapsed offer is now EXPIRED", lapsedAfter.status === "EXPIRED", lapsedAfter.status);
  check("its claim token was cleared so the link is dead", lapsedAfter.claimToken === null);

  // The queue must advance without waiting for an unrelated request.
  const next = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: waiting.id } });
  check(
    "the next person in the queue was offered the freed seat",
    next.status === "OFFERED" && next.claimToken !== null,
    `${next.status} token=${next.claimToken ? "set" : "null"}`,
  );

  const staleAfter = await prisma.order.findUniqueOrThrow({ where: { id: stale.id } });
  check("the abandoned cart is CANCELLED", staleAfter.status === "CANCELLED", staleAfter.status);

  const liveAfter = await prisma.order.findUniqueOrThrow({ where: { id: live.id } });
  check("a hold still in its window is untouched", liveAfter.status === "PENDING", liveAfter.status);

  // Running on a schedule means running often, so a quiet pass must be cheap
  // and must not churn state.
  const again = await sweepOnce();
  check("a second pass finds nothing to expire", again.expired === 0, `expired=${again.expired}`);

  // Credit entries FIRST, while they still point at these orders.
  // Cancelling an event grants credit, and the order FK is SetNull — so
  // deleting the orders first would orphan the credit onto the shared
  // demo account instead of removing it.
  await prisma.creditEntry.deleteMany({ where: { order: { eventId: event.id } } });
  await prisma.order.deleteMany({ where: { eventId: event.id } });
  await prisma.waitlistEntry.deleteMany({ where: { eventId: event.id } });
  await prisma.event.delete({ where: { id: event.id } });
  const left = await prisma.event.count({ where: { id: event.id } });
  check("test data removed", left === 0);

  console.log(failures === 0 ? "\n\x1b[32mAll sweeper checks passed\x1b[0m" : `\n\x1b[31m${failures} FAILED\x1b[0m`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
