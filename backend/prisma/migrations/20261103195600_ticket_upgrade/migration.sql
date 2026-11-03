-- CreateEnum
CREATE TYPE "UpgradeStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "ticket_upgrades" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "buyer_id" TEXT,
    "status" "UpgradeStatus" NOT NULL DEFAULT 'PENDING',
    "target_tier_id" TEXT NOT NULL,
    "from_tier_id" TEXT NOT NULL,
    "due_cents" INTEGER NOT NULL,
    "order_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "ticket_upgrades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_upgrades_order_id_key" ON "ticket_upgrades"("order_id");

-- CreateIndex
CREATE INDEX "ticket_upgrades_status_idx" ON "ticket_upgrades"("status");

-- CreateIndex
CREATE INDEX "ticket_upgrades_ticket_id_idx" ON "ticket_upgrades"("ticket_id");

-- AddForeignKey
ALTER TABLE "ticket_upgrades" ADD CONSTRAINT "ticket_upgrades_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_upgrades" ADD CONSTRAINT "ticket_upgrades_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_upgrades" ADD CONSTRAINT "ticket_upgrades_target_tier_id_fkey" FOREIGN KEY ("target_tier_id") REFERENCES "ticket_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
