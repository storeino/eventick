-- Platform settings: one row, id "platform".
--
-- A table rather than env vars because these are business terms an admin
-- changes from the console, not deploy-time config: an env change needs a
-- restart and leaves no record of who changed what.

CREATE TABLE "platform_settings" (
  "id"             TEXT NOT NULL DEFAULT 'platform',
  -- Basis points, exactly like plans.rate_bps (200 = 2%). Integer, because a
  -- float rate reintroduces the rounding drift that storing money in cents
  -- exists to avoid.
  "resale_fee_bps" INTEGER NOT NULL DEFAULT 0,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  "updated_by_id"  TEXT,

  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- Seed the single row at 0 bps: no resale fee, which is exactly the
-- behaviour the product had before this setting existed. Shipping with a
-- rate already set would start charging sellers without anyone choosing to.
--
-- Seeded HERE rather than left to application code, so the first read after
-- deploy finds a row. A findUnique that returns null on a fresh database is
-- how a default silently becomes "whatever the fallback happened to be".
INSERT INTO "platform_settings" ("id", "resale_fee_bps", "updated_at")
VALUES ('platform', 0, CURRENT_TIMESTAMP);
