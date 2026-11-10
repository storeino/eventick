-- Password recovery, which did not exist.
--
-- There was no route, no email and no link on the login page. A buyer who
-- forgot their password simply could not buy again, and at the checkout they
-- hit that wall with a seat hold counting down.
--
-- What is stored here is the SHA-256 of the emailed token, never the token
-- itself. The link in the inbox is the only copy. A password hash works this
-- way for the same reason: a leaked database should not hand over working
-- reset links for every account with one outstanding.
CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    -- Set the moment it is spent. Single use: a link that still worked after
    -- the password changed would be a second key left under the mat, and the
    -- inbox holding it may be shared, forwarded or later compromised.
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- Unique so a lookup is one indexed read, and so two requests can never
-- collide on the same secret.
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- Expiry sweeps and "has this account a pending request" both scan by user.
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- Cascade: a deleted account's pending resets are meaningless, and leaving
-- them would keep a live token pointing at a row that no longer exists.
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
