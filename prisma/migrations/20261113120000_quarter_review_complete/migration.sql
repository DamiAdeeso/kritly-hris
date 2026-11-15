-- Evidence files
CREATE TABLE "hris"."evidence_files" (
    "id" TEXT NOT NULL,
    "initiative_id" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "stored_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "evidence_files_pkey" PRIMARY KEY ("id")
);

-- Assignment adoption ballots
CREATE TABLE "hris"."assignment_ballots" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "assignment_ballots_pkey" PRIMARY KEY ("id")
);

-- Performance plan escalation fields and related tables
ALTER TABLE "hris"."performance_plans" ADD COLUMN "bad_leaver_open" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "hris"."plan_notes" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "late" INTEGER NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "plan_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."plan_ballots" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "plan_ballots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."bad_leaver_ballots" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "bad_leaver_ballots_pkey" PRIMARY KEY ("id")
);

-- One vesting record per account per cycle
CREATE UNIQUE INDEX "vesting_records_equity_account_id_cycle_id_key" ON "hris"."vesting_records"("equity_account_id", "cycle_id");

CREATE UNIQUE INDEX "assignment_ballots_cycle_id_voter_id_key" ON "hris"."assignment_ballots"("cycle_id", "voter_id");
CREATE UNIQUE INDEX "plan_ballots_plan_id_voter_id_key" ON "hris"."plan_ballots"("plan_id", "voter_id");
CREATE UNIQUE INDEX "bad_leaver_ballots_plan_id_voter_id_key" ON "hris"."bad_leaver_ballots"("plan_id", "voter_id");

ALTER TABLE "hris"."evidence_files" ADD CONSTRAINT "evidence_files_initiative_id_fkey" FOREIGN KEY ("initiative_id") REFERENCES "hris"."initiatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."evidence_files" ADD CONSTRAINT "evidence_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hris"."assignment_ballots" ADD CONSTRAINT "assignment_ballots_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."assignment_ballots" ADD CONSTRAINT "assignment_ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hris"."plan_notes" ADD CONSTRAINT "plan_notes_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "hris"."performance_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."plan_notes" ADD CONSTRAINT "plan_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hris"."plan_ballots" ADD CONSTRAINT "plan_ballots_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "hris"."performance_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."plan_ballots" ADD CONSTRAINT "plan_ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hris"."bad_leaver_ballots" ADD CONSTRAINT "bad_leaver_ballots_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "hris"."performance_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."bad_leaver_ballots" ADD CONSTRAINT "bad_leaver_ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
