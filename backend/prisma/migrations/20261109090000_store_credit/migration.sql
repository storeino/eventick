-- Store credit: an append-only ledger, plus how much of an order it paid for.
--
-- Deliberately no balance column on users. The balance is SUM(amount_cents)
-- over this table: a single mutable total cannot say where credit came from,
-- and two concurrent checkouts reading it can both pass a `balance >= total`
-- check and spend the same credit twice.

CREATE TYPE "CreditReason" AS ENUM (
  'EVENT_CANCELLED',
  'ORDER_REFUND',
  'PURCHASE',
  'PURCHASE_REVERSED',
  'ADJUSTMENT'
);

CREATE TABLE "credit_entries" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "reason"       "CreditReason" NOT NULL,
  "order_id"     TEXT,
  "label"        TEXT NOT NULL,
  "note"         TEXT,
  "actor_id"     TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_entries_pkey" PRIMARY KEY ("id")
);

-- The balance query: every entry for one holder, newest first.
CREATE INDEX "credit_entries_user_id_created_at_idx"
  ON "credit_entries" ("user_id", "created_at");

-- The double-grant guard, in the database rather than in application code.
--
-- cancelEvent converts orders one at a time and may be retried after a
-- partial failure. Without this, a retry would append a SECOND
-- EVENT_CANCELLED entry for an order already converted and double that
-- buyer's credit. A unique index cannot lose a race.
--
-- Postgres treats NULLs as distinct in a unique index, so staff ADJUSTMENT
-- rows (order_id NULL) never collide with each other. That is intended:
-- those are hand-written corrections and there may legitimately be several.
CREATE UNIQUE INDEX "credit_entries_order_id_reason_key"
  ON "credit_entries" ("order_id", "reason");

ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting an actor's account must not erase the
-- ledger rows they created.
ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SetNull again: deleting an order must never silently delete the credit it
-- produced, which would change a buyer's balance to cover up the deletion.
ALTER TABLE "credit_entries"
  ADD CONSTRAINT "credit_entries_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the card was NOT charged. total_cents is what the order cost; the
-- gateway only ever saw total_cents - credit_applied_cents. Without this,
-- settlement cannot tell a 300 MAD order half-paid in credit from a 150 MAD
-- order, and organiser takings are overstated by every dirham of credit spent.
ALTER TABLE "orders"
  ADD COLUMN "credit_applied_cents" INTEGER NOT NULL DEFAULT 0;
