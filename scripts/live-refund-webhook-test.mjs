/**
 * Live test — a refund made IN THE CMI BACK OFFICE voids the tickets.
 *
 * The danger this covers: someone gets their money back while their tickets
 * stay VALID, and the gate lets them in. It used to be a webhook that only
 * logged the event; now the risk is sharper, because CMI sends NOTHING when a
 * merchant reverses a transaction there — so the books can drift silently and
 * reconciliation is a manual step.
 *
 * This calls `reconcileExternalRefund` directly: the function the
 * /orders/:id/reconcile-refund route delegates to, which holds all the
 * behaviour under test. What it must prove is that reconciliation voids
 * tickets, returns seats, is idempotent when run more than once, and leaves a
 * PARTIAL refund's tickets usable.
 *
 * Run from the backend directory with tsx, which has Prisma and the env:
 *   cd backend && npx tsx ../scripts/live-refund-webhook-test.mjs
 */

import { prisma } from "../backend/src/lib/prisma.js";
import { reconcileExternalRefund } from "../backend/src/lib/refund.js";
import { makeTicketRef } from "../backend/src/domain/ticketRef.js";

let failures = 0;

function check(label, pass, detail) {
  if (!pass) failures++;
  const mark = pass ? "\x1b[32m PASS\x1b[0m" : "\x1b[31m FAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

const SUFFIX = Date.now();
const created = { events: [], orders: [] };
let seq = 0;

/** A PAID order of `qty` tickets carrying a gateway transaction reference,
 * as a real card payment through CMI would leave it. */
async function paidOrder(qty, totalCents, gatewayRef) {
  const start = new Date(Date.now() + 30 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      slug: `refund-wh-${SUFFIX}-${++seq}`,
      titleFr: "Test remboursement",
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
          priceCents: Math.round(totalCents / qty),
          capacity: 10,
          zoneFr: "A",
          zoneAr: "أ",
          gateFr: "1",
          gateAr: "1",
        },
      },
    },
    include: { tiers: true },
  });
  created.events.push(event.id);
  const tier = event.tiers[0];

  const order = await prisma.order.create({
    data: {
      eventId: event.id,
      status: "PAID",
      holderName: "Client Test",
      email: "client@example.com",
      phone: "0612345678",
      subtotalCents: totalCents,
      totalCents,
      gatewayRef,
      paymentRef: gatewayRef,
      lines: { create: { tierId: tier.id, qty } },
      tickets: {
        create: Array.from({ length: qty }, () => ({
          ref: makeTicketRef(start.getFullYear()),
          tierId: tier.id,
          holderName: "Client Test",
        })),
      },
    },
    include: { tickets: true },
  });
  created.orders.push(order.id);
  return { event, tier, order };
}

async function statuses(orderId) {
  const tickets = await prisma.ticket.findMany({ where: { orderId }, select: { status: true } });
  return tickets.map((t) => t.status);
}

async function main() {
  // ── A full refund at CMI must void every ticket ───────────────────────
  console.log("\n\x1b[1mFull refund made in the CMI back office\x1b[0m");
  {
    const gatewayRef = `cmi_test_full_${SUFFIX}`;
    const { order, tier, event } = await paidOrder(2, 40000, gatewayRef);

    check("tickets start VALID", (await statuses(order.id)).every((s) => s === "VALID"));

    const result = await reconcileExternalRefund(gatewayRef, 40000);
    check("reconciliation reports a full refund", result?.full === true, JSON.stringify(result));

    const after = await statuses(order.id);
    check("every ticket is now CANCELLED", after.every((s) => s === "CANCELLED"), after.join(","));

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("the order is REFUNDED", reloaded.status === "REFUNDED", reloaded.status);
    check("the ledger records what CMI reversed", reloaded.refundedCents === 40000, `${reloaded.refundedCents}`);
    check("refundedAt is stamped", reloaded.refundedAt !== null);

    // The seats must come back, or the event stays falsely sold out.
    const issued = await prisma.ticket.count({
      where: { tierId: tier.id, status: { in: ["VALID", "USED"] } },
    });
    check("the seats returned to the pool", issued === 0, `${issued} still committed`);
    void event;
  }

  // ── Idempotence: reconciliation may be run more than once ─────────────
  console.log("\n\x1b[1mReconciliation run twice\x1b[0m");
  {
    const gatewayRef = `cmi_test_replay_${SUFFIX}`;
    const { order } = await paidOrder(1, 20000, gatewayRef);

    const first = await reconcileExternalRefund(gatewayRef, 20000);
    const second = await reconcileExternalRefund(gatewayRef, 20000);
    const third = await reconcileExternalRefund(gatewayRef, 20000);

    check("the first delivery reconciles", first?.full === true);
    check("a replay is a no-op, not a second refund", second === null && third === null, `${second} / ${third}`);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("the ledger was not doubled", reloaded.refundedCents === 20000, `${reloaded.refundedCents}`);
  }

  // ── A partial refund must NOT void the tickets ────────────────────────
  console.log("\n\x1b[1mPartial refund\x1b[0m");
  {
    const gatewayRef = `cmi_test_partial_${SUFFIX}`;
    const { order } = await paidOrder(4, 80000, gatewayRef);

    const result = await reconcileExternalRefund(gatewayRef, 20000);
    check("reconciliation reports it is not full", result?.full === false, JSON.stringify(result));

    const after = await statuses(order.id);
    check(
      "refunding one seat of four leaves all four usable",
      after.every((s) => s === "VALID"),
      after.join(","),
    );

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("the order stays PAID", reloaded.status === "PAID", reloaded.status);
    check("the partial amount is recorded", reloaded.refundedCents === 20000, `${reloaded.refundedCents}`);

    // Topping it up to the full amount must then void them.
    const topUp = await reconcileExternalRefund(gatewayRef, 80000);
    check("a later top-up to the full amount is full", topUp?.full === true, JSON.stringify(topUp));
    const final = await statuses(order.id);
    check("now every ticket is CANCELLED", final.every((s) => s === "CANCELLED"), final.join(","));
  }

  // ── Our own refund path must not be undone ────────────────────────────
  console.log("\n\x1b[1mRefund already recorded here\x1b[0m");
  {
    const gatewayRef = `cmi_test_ours_${SUFFIX}`;
    const { order } = await paidOrder(1, 20000, gatewayRef);
    // Simulate refundOrder having already settled it.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "REFUNDED", refundedCents: 20000, refundedAt: new Date(), refundRef: "re_ours" },
    });
    await prisma.ticket.updateMany({ where: { orderId: order.id }, data: { status: "CANCELLED" } });

    const result = await reconcileExternalRefund(gatewayRef, 20000);
    check("a matching reconciliation changes nothing", result === null, JSON.stringify(result));
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("our own refund reference survives", reloaded.refundRef === "re_ours", reloaded.refundRef ?? "null");
  }

  // ── An unknown intent is ignored, not an error ────────────────────────
  console.log("\n\x1b[1mUnknown transaction\x1b[0m");
  {
    const result = await reconcileExternalRefund(`pi_does_not_exist_${SUFFIX}`, 10000);
    check("an unknown transaction reconciles to null", result === null, JSON.stringify(result));
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  // Credit entries FIRST, while they still point at these orders.
  // Cancelling an event grants credit, and the order FK is SetNull — so
  // deleting the orders first would orphan the credit onto the shared
  // demo account instead of removing it.
  await prisma.creditEntry.deleteMany({ where: { orderId: { in: created.orders } } });
  await prisma.order.deleteMany({ where: { id: { in: created.orders } } });
  await prisma.event.deleteMany({ where: { id: { in: created.events } } });
  const leftEvents = await prisma.event.count({ where: { id: { in: created.events } } });
  const leftOrders = await prisma.order.count({ where: { id: { in: created.orders } } });
  check("test data removed", leftEvents === 0 && leftOrders === 0, `${leftEvents} event(s), ${leftOrders} order(s)`);

  console.log(
    failures === 0 ? "\n\x1b[32mAll refund-webhook checks passed\x1b[0m" : `\n\x1b[31m${failures} FAILED\x1b[0m`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\x1b[31mharness error:\x1b[0m", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
