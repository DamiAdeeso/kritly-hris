-- Where an evidence file's bytes live: 's3' (durable) or 'local' (dev disk; wiped on Render redeploys).
ALTER TABLE "hris"."evidence_files" ADD COLUMN "storage" TEXT NOT NULL DEFAULT 'local';
