CREATE TYPE "DigitalIdStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED');

ALTER TABLE "users"
  ADD COLUMN "digitalIdStatus" "DigitalIdStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "digitalIdVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "digitalIdVerificationMethod" TEXT;

CREATE INDEX IF NOT EXISTS "users_digitalIdStatus_idx"
  ON "users" ("digitalIdStatus");
