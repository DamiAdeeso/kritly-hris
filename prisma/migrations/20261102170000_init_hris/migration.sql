CREATE SCHEMA IF NOT EXISTS "hris";

CREATE TABLE "hris"."people" (
    "id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_director" INTEGER NOT NULL DEFAULT 0,
    "is_founder" INTEGER NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "people_email_key" ON "hris"."people"("email");

CREATE TABLE "hris"."roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "roles_key_key" ON "hris"."roles"("key");

CREATE TABLE "hris"."permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permissions_key_key" ON "hris"."permissions"("key");

CREATE TABLE "hris"."role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

CREATE TABLE "hris"."person_roles" (
    "person_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    CONSTRAINT "person_roles_pkey" PRIMARY KEY ("person_id","role_id")
);

CREATE TABLE "hris"."affiliates" (
    "person_id" TEXT NOT NULL,
    "related_person_id" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("person_id","related_person_id")
);

CREATE TABLE "hris"."employments" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "qualifying_service" INTEGER NOT NULL DEFAULT 1,
    "subject_to_founder_review" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "employments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employments_person_id_key" ON "hris"."employments"("person_id");

CREATE TABLE "hris"."equity_accounts" (
    "id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "certificate_or_book_entry" TEXT,
    "total_shares" INTEGER NOT NULL DEFAULT 0,
    "past_contribution_shares" INTEGER NOT NULL DEFAULT 0,
    "service_shares" INTEGER NOT NULL DEFAULT 0,
    "vested_shares" INTEGER NOT NULL DEFAULT 0,
    "unvested_shares" INTEGER NOT NULL DEFAULT 0,
    "escrow" INTEGER NOT NULL DEFAULT 1,
    "vesting_suspended" INTEGER NOT NULL DEFAULT 0,
    "schedule_a_confirmed" INTEGER NOT NULL DEFAULT 0,
    "legends" TEXT NOT NULL,
    CONSTRAINT "equity_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "equity_accounts_employment_id_key" ON "hris"."equity_accounts"("employment_id");

CREATE TABLE "hris"."policy_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 0,
    "mutable_notes" TEXT,
    "created_by" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "policy_versions_version_key" ON "hris"."policy_versions"("version");

CREATE TABLE "hris"."audit_events" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before_json" TEXT,
    "after_json" TEXT,
    "reason" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."sessions" (
    "token" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token")
);

CREATE TABLE "hris"."review_cycles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period_label" TEXT NOT NULL,
    "starts_on" TEXT NOT NULL,
    "ends_on" TEXT NOT NULL,
    "review_deadline" TEXT NOT NULL,
    "vesting_date" TEXT NOT NULL,
    "policy_version_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ratings_published" INTEGER NOT NULL DEFAULT 0,
    "assignment_adopted_at" TEXT,
    "assignment_adoption_method" TEXT,
    "evidence_due_on" TEXT,
    "self_assessment_due_on" TEXT,
    "scores_due_on" TEXT,
    "votes_due_on" TEXT,
    CONSTRAINT "review_cycles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."initiatives" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company_objective" TEXT NOT NULL,
    "success_criteria" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "due_date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence_ref" TEXT,
    "final_score" TEXT,
    "final_evidence" TEXT,
    CONSTRAINT "initiatives_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."initiative_status_updates" (
    "id" TEXT NOT NULL,
    "initiative_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "initiative_status_updates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."self_assessments" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "self_assessments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "self_assessments_cycle_id_employment_id_key" ON "hris"."self_assessments"("cycle_id", "employment_id");

CREATE TABLE "hris"."sealed_score_sheets" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "subject_employment_id" TEXT NOT NULL,
    "scorer_person_id" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "sealed" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "sealed_score_sheets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sealed_score_sheets_cycle_id_subject_employment_id_scorer_person_id_key" ON "hris"."sealed_score_sheets"("cycle_id", "subject_employment_id", "scorer_person_id");

CREATE TABLE "hris"."score_drafts" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "subject_employment_id" TEXT NOT NULL,
    "scorer_person_id" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "score_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "score_drafts_cycle_id_subject_employment_id_scorer_person_id_key" ON "hris"."score_drafts"("cycle_id", "subject_employment_id", "scorer_person_id");

CREATE TABLE "hris"."adoption_ballots" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "subject_employment_id" TEXT NOT NULL,
    "voter_person_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "adoption_ballots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "adoption_ballots_cycle_id_subject_employment_id_voter_person_id_key" ON "hris"."adoption_ballots"("cycle_id", "subject_employment_id", "voter_person_id");

CREATE TABLE "hris"."review_votes" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "subject_employment_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "missed_criterion" TEXT,
    "dimension_notes_json" TEXT NOT NULL,
    "initiative_scores_json" TEXT NOT NULL,
    "voter_ids_json" TEXT NOT NULL,
    "consequence" TEXT NOT NULL,
    "prior_rating" INTEGER,
    "voted_at" TEXT NOT NULL,
    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_votes_cycle_id_subject_employment_id_key" ON "hris"."review_votes"("cycle_id", "subject_employment_id");

CREATE TABLE "hris"."review_memos" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "vote_id" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "delivered_at" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "review_memos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_memos_vote_id_key" ON "hris"."review_memos"("vote_id");
CREATE UNIQUE INDEX "review_memos_cycle_id_employment_id_key" ON "hris"."review_memos"("cycle_id", "employment_id");

CREATE TABLE "hris"."consequence_notices" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "issued_at" TEXT NOT NULL,
    CONSTRAINT "consequence_notices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."performance_plans" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employment_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectives" TEXT NOT NULL,
    "success_metrics" TEXT NOT NULL,
    "support" TEXT,
    "check_in_schedule" TEXT,
    "starts_on" TEXT NOT NULL,
    "ends_on" TEXT NOT NULL,
    "extended_once" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "result" TEXT,
    CONSTRAINT "performance_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."vesting_records" (
    "id" TEXT NOT NULL,
    "equity_account_id" TEXT NOT NULL,
    "cycle_id" TEXT,
    "vesting_date" TEXT NOT NULL,
    "shares_vested" INTEGER NOT NULL,
    "vested_total" INTEGER NOT NULL,
    "unvested_remainder" INTEGER NOT NULL,
    "certificate_or_book_entry" TEXT,
    "legends" TEXT NOT NULL,
    "escrow_note" TEXT,
    "status" TEXT NOT NULL,
    "hold_reason" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "vesting_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."company_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "company_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."cash_calls" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "due_on" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "account_id" TEXT,
    CONSTRAINT "cash_calls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."cash_call_lines" (
    "id" TEXT NOT NULL,
    "cash_call_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    CONSTRAINT "cash_call_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cash_call_lines_cash_call_id_person_id_key" ON "hris"."cash_call_lines"("cash_call_id", "person_id");

CREATE TABLE "hris"."cash_call_payments" (
    "id" TEXT NOT NULL,
    "line_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_on" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "cash_call_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hris"."notifications" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "due_on" TEXT,
    "read_at" TEXT,
    "created_at" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "hris"."notifications"("dedupe_key");

-- Foreign keys
ALTER TABLE "hris"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "hris"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "hris"."permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."person_roles" ADD CONSTRAINT "person_roles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."person_roles" ADD CONSTRAINT "person_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "hris"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."affiliates" ADD CONSTRAINT "affiliates_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."affiliates" ADD CONSTRAINT "affiliates_related_person_id_fkey" FOREIGN KEY ("related_person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."employments" ADD CONSTRAINT "employments_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."equity_accounts" ADD CONSTRAINT "equity_accounts_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."policy_versions" ADD CONSTRAINT "policy_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "hris"."people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hris"."audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "hris"."people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hris"."sessions" ADD CONSTRAINT "sessions_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."review_cycles" ADD CONSTRAINT "review_cycles_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "hris"."policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."initiatives" ADD CONSTRAINT "initiatives_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."initiatives" ADD CONSTRAINT "initiatives_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."initiative_status_updates" ADD CONSTRAINT "initiative_status_updates_initiative_id_fkey" FOREIGN KEY ("initiative_id") REFERENCES "hris"."initiatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."initiative_status_updates" ADD CONSTRAINT "initiative_status_updates_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."self_assessments" ADD CONSTRAINT "self_assessments_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."self_assessments" ADD CONSTRAINT "self_assessments_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."sealed_score_sheets" ADD CONSTRAINT "sealed_score_sheets_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."sealed_score_sheets" ADD CONSTRAINT "sealed_score_sheets_subject_employment_id_fkey" FOREIGN KEY ("subject_employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."sealed_score_sheets" ADD CONSTRAINT "sealed_score_sheets_scorer_person_id_fkey" FOREIGN KEY ("scorer_person_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."score_drafts" ADD CONSTRAINT "score_drafts_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."score_drafts" ADD CONSTRAINT "score_drafts_subject_employment_id_fkey" FOREIGN KEY ("subject_employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."score_drafts" ADD CONSTRAINT "score_drafts_scorer_person_id_fkey" FOREIGN KEY ("scorer_person_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."adoption_ballots" ADD CONSTRAINT "adoption_ballots_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."adoption_ballots" ADD CONSTRAINT "adoption_ballots_subject_employment_id_fkey" FOREIGN KEY ("subject_employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."adoption_ballots" ADD CONSTRAINT "adoption_ballots_voter_person_id_fkey" FOREIGN KEY ("voter_person_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."review_votes" ADD CONSTRAINT "review_votes_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."review_votes" ADD CONSTRAINT "review_votes_subject_employment_id_fkey" FOREIGN KEY ("subject_employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."review_memos" ADD CONSTRAINT "review_memos_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."review_memos" ADD CONSTRAINT "review_memos_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."review_memos" ADD CONSTRAINT "review_memos_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "hris"."review_votes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."consequence_notices" ADD CONSTRAINT "consequence_notices_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."consequence_notices" ADD CONSTRAINT "consequence_notices_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."performance_plans" ADD CONSTRAINT "performance_plans_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."performance_plans" ADD CONSTRAINT "performance_plans_employment_id_fkey" FOREIGN KEY ("employment_id") REFERENCES "hris"."employments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."vesting_records" ADD CONSTRAINT "vesting_records_equity_account_id_fkey" FOREIGN KEY ("equity_account_id") REFERENCES "hris"."equity_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."vesting_records" ADD CONSTRAINT "vesting_records_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "hris"."review_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hris"."company_accounts" ADD CONSTRAINT "company_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_calls" ADD CONSTRAINT "cash_calls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_calls" ADD CONSTRAINT "cash_calls_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "hris"."company_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_call_lines" ADD CONSTRAINT "cash_call_lines_cash_call_id_fkey" FOREIGN KEY ("cash_call_id") REFERENCES "hris"."cash_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_call_lines" ADD CONSTRAINT "cash_call_lines_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_call_payments" ADD CONSTRAINT "cash_call_payments_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "hris"."cash_call_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hris"."cash_call_payments" ADD CONSTRAINT "cash_call_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "hris"."people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hris"."notifications" ADD CONSTRAINT "notifications_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "hris"."people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
