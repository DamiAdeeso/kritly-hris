# Kritly HRIS — Configurability Audit

Enterprise HRIS products separate **policy** (what the company sets) from **engine** (how the product enforces it). Kritly mirrors that split against the Founders' Agreement.

## How configuration works

| Layer | What it is | Who changes it | How the app stores it |
|-------|------------|----------------|------------------------|
| **Locked legal** | Terms that need founder consent or a formal agreement amendment | Counsel + founders | Seeded once; `mutable: false`; edits require explicit override + audit log |
| **Living policy** | Schedules C, D, E, F, H, I style rules | Disinterested directors / Policy Admin role | Versioned `policy_versions` rows; active version pinned to a review cycle |
| **Operational** | Dates, people, initiatives, evidence | Directors / HR / founders per RBAC | Normal transactional tables |
| **RBAC** | Who may do what | System Admin | `roles`, `permissions`, `role_permissions`, `person_roles` |

Every policy change writes an **audit event**: actor, before/after JSON, reason, timestamp.

A **review cycle** always snapshots the active policy version at open time, so mid-cycle edits do not rewrite scores already in flight.

---

## Locked legal (not freely configurable)

From Section 1.5: Schedules A, B (vesting start / overall duration), G (leaver economics), and J need consent or express amendment paths.

| Term | Why locked | App behavior |
|------|------------|--------------|
| Founder ownership % / share counts (Schedule A) | Absolute numbers control economics | Equity account fields; `schedule_a_confirmed` gate before vesting |
| Vesting commencement date | Agreement Effective Date | Default `2026-08-15`; change flagged `requires_affected_founder_consent` |
| Overall vesting duration / installment count | Schedule B | Policy field with consent flag |
| Good / Bad Leaver repurchase economics | Schedule G | Not editable in v1 UI; constant in code + documented |
| Prior IP schedule | Schedule J | Out of scope for performance module |

---

## Living policy (configurable like Schedule C/D/H)

Amendable by majority of Disinterested Directors under the agreement. In the product: **Policy Admin** or directors with `policy.manage`.

### Performance framework (Schedule C)

| Key | Default | Notes |
|-----|---------|-------|
| `rating_scale` | 1–5 with labels Exceptional…Unsatisfactory | Labels editable |
| `dimensions[]` | delivery 35, strategic 15, leadership 15, collaboration 10, reliability 10, values 15 | Weights must sum to 100; disclosed before quarter |
| `initiative_scores` | Done / Partial / Miss / Deferred | Deferred excluded from delivery weight |
| `values_cap_rating` | 2 | Serious Values breach cap |
| `pip_trigger` | rating 1 OR second consecutive ≤2 | Boolean rules |
| `observation_on` | first rating of 2 | |
| `vesting_continues_on` | rating ≥3 OR first 2 | |

### Cadence (Schedule H / C process)

| Key | Default |
|-----|---------|
| `assignment_due_day_of_quarter` | 10 |
| `mid_quarter_status_required` | true for Operators |
| `self_assessment_days_after_period_end` | 7 |
| `memo_delivery_days_after_vote` | 14 |
| `consequence_notice_days_after_vote` | 7 |
| `hide_ratings_until_all_voted` | true (product control for fair process) |

### Escalation (Schedule D)

| Key | Default |
|-----|---------|
| `observation_days_min` / `max` | 15 / 30 |
| `pip_days_default` / `min` | 45 / 45 |
| `pip_extension_max_days` | 45 (one extension) |
| `formal_concern_reply_days` | 7 |
| `pip_pass_fail_vote_days_after_end` | 14 |
| `pip_result_delivery_days` | 3 |
| `bad_leaver_notice_days` | 7 |
| `bad_leaver_vote_threshold` | 0.75 of disinterested |

### Voting / recusal

| Key | Default |
|-----|---------|
| `rating_vote_threshold` | majority of Disinterested Directors |
| `recuse_subject` | true |
| `recuse_affiliates` | true (spouse, parent, sibling, child, household relative) |
| `nominee_not_affiliate_may_vote` | true |

### Fiscal calendar

| Key | Default |
|-----|---------|
| `fiscal_year_type` | calendar |
| `vesting_anchor_date` | 2026-08-15 (locked unless consent) |
| `vesting_interval_months` | 3 |
| `service_installments` | 10 |

### Documents / templates

| Key | Default |
|-----|---------|
| `memo_template` | Exhibit C-1 fields |
| `equity_legends` | Restricted-stock legends text |
| `consequence_notice_templates` | Observation / Formal Concern / PIP |

---

## RBAC model

Permissions are strings (`resource.action`). Roles are bundles. People get one or more roles. **Job title ≠ permission.**

| Role | Typical holders | Capabilities |
|------|-----------------|--------------|
| `system_admin` | Platform operator | All permissions; seed users |
| `policy_admin` | Board / secretary | Create/activate policy versions; view audit |
| `director` | Board members | Vote when disinterested; view assignment records; confirm Schedule A; issue cash calls |
| `founder_operator` | Active founders | Own status, evidence, self-assessment; view own memo after publish; view cash calls and record own payment |
| `hr_admin` | Future HR | People and employment CRUD |
| `equity_admin` | Secretary / CFO | Equity accounts, vesting records, holds |
| `auditor` | Counsel / external | Read-only people, memos, audit, equity |

**Contextual checks** (not only role):

- Cannot score or vote on **self**.
- Cannot vote if marked **affiliate** of the subject.
- Sealed sheets visible only after that subject's deliberation opens (or to equity/policy admin for support, never the subject before vote).
- Ratings hidden from subjects until cycle `ratings_published`.

---

## What stays operational data (not “policy”)

Initiatives, evidence links, mid-quarter notes, sealed score content, votes, memos, PIP instances, vesting events, cash calls and payments — configured per cycle or call, governed by the active policy snapshot where one applies. Cash-call splits follow locked Schedule A share counts.

---

## Workforce approvals (shared with platform admin)

Cash calls and company account create/close submit to the workforce approval plane when both are set:

- `WORKFORCE_API_URL` — gateway base URL
- `WORKFORCE_SERVICE_KEY` — service key for `/api/internal/workforce-approvals`

The requester’s HRIS email must match a platform user. Approvers decide in the admin dashboard Approvals inbox. On approve, the gateway calls `HRIS_INTERNAL_URL` with `HRIS_INTERNAL_KEY` to commit the change. Without those env vars, HRIS keeps the local immediate-write path for solo development.
