-- A phone number on the account.
--
-- It was asked for at every checkout and stored only on the order, so a
-- buyer with six orders typed it six times while the account that owns all
-- of them knew nothing about it.

-- Nullable, deliberately. Accounts created before this column existed have
-- no number, and a required field cannot be applied backwards without
-- inventing data. New sign-ups must supply one; older accounts are asked
-- once more at their next checkout and it is saved from there.
ALTER TABLE "users" ADD COLUMN "phone" TEXT;

-- Backfill from what these buyers already told us.
--
-- The most recent order carries the number they last used, which is the one
-- most likely to still reach them. Without this, every existing account
-- would be asked again for something they have already typed, and the
-- change would look like a regression to the people it is meant to help.
--
-- DISTINCT ON needs the ORDER BY to lead with the same expression, hence
-- customer_id first and created_at second.
UPDATE "users" u
SET "phone" = latest."phone"
FROM (
  SELECT DISTINCT ON ("customer_id") "customer_id", "phone"
  FROM "orders"
  WHERE "customer_id" IS NOT NULL
    AND "phone" <> ''
  ORDER BY "customer_id", "created_at" DESC
) AS latest
WHERE u."id" = latest."customer_id"
  AND u."phone" IS NULL;
