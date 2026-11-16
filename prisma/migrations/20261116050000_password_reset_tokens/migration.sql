-- Password reset tokens (token column stores a SHA-256 of the emailed token)
CREATE TABLE "hris"."password_reset_tokens" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "used_at" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "hris"."password_reset_tokens"("token");

ALTER TABLE "hris"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
