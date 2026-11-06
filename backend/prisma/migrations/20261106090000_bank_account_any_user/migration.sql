-- A bank account belongs to any user, not only an organiser.
--
-- Resale pays a CUSTOMER: their money is held by the platform rather than
-- sitting on a card CMI can reverse, so it goes out as a transfer -- and
-- there was nowhere for a customer to record an account to transfer to.
--
-- Rename rather than add-and-backfill: it is the same column holding the
-- same thing, every existing row is already a valid user id, and the
-- foreign key/unique constraint carry over unchanged.
ALTER TABLE "bank_accounts" RENAME COLUMN "organiser_id" TO "user_id";

-- A column rename leaves the index and foreign key under their old names,
-- which Prisma then reports as drift on every later migrate. Rename both to
-- what a fresh `prisma migrate dev` would have called them.
ALTER INDEX "bank_accounts_organiser_id_key" RENAME TO "bank_accounts_user_id_key";
ALTER TABLE "bank_accounts" RENAME CONSTRAINT "bank_accounts_organiser_id_fkey" TO "bank_accounts_user_id_fkey";
