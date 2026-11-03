-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "refund_paid_at" TIMESTAMP(3),
ADD COLUMN     "refund_paid_ref" TEXT;
