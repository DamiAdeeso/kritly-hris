-- Task status moves to four values: not_started, in_progress, blocked, done.

-- Seeded tasks defaulted to in_progress though no founder had reported anything:
-- with no status update on file, they are really not started.
UPDATE "hris"."initiatives" AS i
SET "status" = 'not_started'
WHERE i."status" = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM "hris"."initiative_status_updates" AS u WHERE u."initiative_id" = i."id"
  );

-- Legacy values from the old dropdown.
UPDATE "hris"."initiatives" SET "status" = 'in_progress' WHERE "status" = 'on_track';
UPDATE "hris"."initiatives" SET "status" = 'blocked' WHERE "status" IN ('at_risk', 'off_track');
UPDATE "hris"."initiatives" SET "status" = 'not_started'
WHERE "status" NOT IN ('not_started', 'in_progress', 'blocked', 'done');

UPDATE "hris"."initiative_status_updates" SET "status" = 'in_progress' WHERE "status" = 'on_track';
UPDATE "hris"."initiative_status_updates" SET "status" = 'blocked' WHERE "status" IN ('at_risk', 'off_track');
