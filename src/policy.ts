import { z } from "zod";

export const DimensionSchema = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number().min(0).max(100),
  description: z.string(),
});

export const PolicyBodySchema = z.object({
  schema_version: z.literal(1),
  rating_scale: z.array(
    z.object({
      value: z.number().int().min(1).max(5),
      designation: z.string(),
      meaning: z.string(),
    })
  ),
  dimensions: z.array(DimensionSchema),
  initiative_scores: z.array(
    z.object({
      value: z.enum(["Done", "Partial", "Miss", "Deferred"]),
      meaning: z.string(),
      counts_toward_delivery: z.boolean(),
    })
  ),
  values_cap_rating: z.number().int().min(1).max(5),
  pip_trigger: z.object({
    on_rating: z.array(z.number().int()),
    on_second_consecutive_at_or_below: z.number().int(),
  }),
  observation_on_first_rating: z.number().int(),
  vesting_continues_at_or_above: z.number().int(),
  cadence: z.object({
    assignment_due_day_of_quarter: z.number().int(),
    mid_quarter_status_required: z.boolean(),
    self_assessment_days_after_period_end: z.number().int(),
    memo_delivery_days_after_vote: z.number().int(),
    consequence_notice_days_after_vote: z.number().int(),
    hide_ratings_until_all_voted: z.boolean(),
  }),
  escalation: z.object({
    observation_days_min: z.number().int(),
    observation_days_max: z.number().int(),
    pip_days_default: z.number().int(),
    pip_days_min: z.number().int(),
    pip_extension_max_days: z.number().int(),
    formal_concern_reply_days: z.number().int(),
    pip_pass_fail_vote_days_after_end: z.number().int(),
    pip_result_delivery_days: z.number().int(),
    bad_leaver_notice_days: z.number().int(),
    bad_leaver_vote_threshold: z.number().min(0).max(1),
  }),
  voting: z.object({
    rating_requires_majority_of_disinterested: z.boolean(),
    recuse_subject: z.boolean(),
    recuse_affiliates: z.boolean(),
    nominee_not_affiliate_may_vote: z.boolean(),
  }),
  fiscal: z.object({
    fiscal_year_type: z.enum(["calendar", "custom"]),
    vesting_anchor_date: z.string(),
    vesting_interval_months: z.number().int(),
    service_installments: z.number().int(),
    vesting_anchor_requires_consent_to_change: z.boolean(),
  }),
  equity_legends: z.array(z.string()),
  locked_notes: z.array(z.string()),
});

export type PolicyBody = z.infer<typeof PolicyBodySchema>;

export const DEFAULT_POLICY: PolicyBody = {
  schema_version: 1,
  rating_scale: [
    { value: 5, designation: "Exceptional", meaning: "Exceeds commitments; multiplies team effectiveness; exemplifies the Values" },
    { value: 4, designation: "Strong", meaning: "Meets commitments with strong contribution; adheres to the Values" },
    { value: 3, designation: "Satisfactory", meaning: "Substantially meets commitments; minor gaps with demonstrated recovery; adheres to the Values" },
    { value: 2, designation: "Needs Improvement", meaning: "Material misses or Values concerns requiring Observation" },
    { value: 1, designation: "Unsatisfactory", meaning: "Persistent failure or serious Values breach requiring Formal Concern and a Performance Improvement Plan" },
  ],
  dimensions: [
    { key: "delivery", label: "Delivery against assigned initiatives", weight: 35, description: "Output against agreed success criteria. Hours and effort alone do not count." },
    { key: "strategic_impact", label: "Strategic impact", weight: 15, description: "Moved company priorities forward beyond task completion." },
    { key: "leadership", label: "Leadership and ownership", weight: 15, description: "Owned the work, drove issues to resolution, accepted accountability." },
    { key: "collaboration", label: "Collaboration", weight: 10, description: "Timely handoffs, sharing information, constructive disagreement." },
    { key: "reliability", label: "Reliability and communication", weight: 10, description: "Met timelines, raised risk early, kept status visible." },
    { key: "values", label: "Adherence to Values", weight: 15, description: "Integrity, transparency, accountability, respect, stewardship." },
  ],
  initiative_scores: [
    { value: "Done", meaning: "Success criteria met in substance by the due date.", counts_toward_delivery: true },
    { value: "Partial", meaning: "Material progress but material criteria unmet or late without approved deferral.", counts_toward_delivery: true },
    { value: "Miss", meaning: "Little or no progress, abandonment, or unilateral scope cut.", counts_toward_delivery: true },
    { value: "Deferred", meaning: "Board-approved deferral; neutral; excluded from delivery weight.", counts_toward_delivery: false },
  ],
  values_cap_rating: 2,
  pip_trigger: { on_rating: [1], on_second_consecutive_at_or_below: 2 },
  observation_on_first_rating: 2,
  vesting_continues_at_or_above: 3,
  cadence: {
    assignment_due_day_of_quarter: 10,
    mid_quarter_status_required: true,
    self_assessment_days_after_period_end: 7,
    memo_delivery_days_after_vote: 14,
    consequence_notice_days_after_vote: 7,
    hide_ratings_until_all_voted: true,
  },
  escalation: {
    observation_days_min: 15,
    observation_days_max: 30,
    pip_days_default: 45,
    pip_days_min: 45,
    pip_extension_max_days: 45,
    formal_concern_reply_days: 7,
    pip_pass_fail_vote_days_after_end: 14,
    pip_result_delivery_days: 3,
    bad_leaver_notice_days: 7,
    bad_leaver_vote_threshold: 0.75,
  },
  voting: {
    rating_requires_majority_of_disinterested: true,
    recuse_subject: true,
    recuse_affiliates: true,
    nominee_not_affiliate_may_vote: true,
  },
  fiscal: {
    fiscal_year_type: "calendar",
    vesting_anchor_date: "2026-08-15",
    vesting_interval_months: 3,
    service_installments: 10,
    vesting_anchor_requires_consent_to_change: true,
  },
  equity_legends: [
    "THE SECURITIES REPRESENTED HEREBY HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933, AS AMENDED, OR UNDER THE SECURITIES LAWS OF ANY STATE, AND MAY NOT BE SOLD, PLEDGED, OR OTHERWISE TRANSFERRED EXCEPT PURSUANT TO AN EFFECTIVE REGISTRATION STATEMENT UNDER SAID ACT AND APPLICABLE STATE SECURITIES LAWS OR PURSUANT TO AN APPLICABLE EXEMPTION FROM THE REGISTRATION REQUIREMENTS OF SAID ACT AND SUCH LAWS.",
    "THE SECURITIES REPRESENTED HEREBY ARE SUBJECT TO VESTING CONDITIONS, REPURCHASE RIGHTS, AND RESTRICTIONS ON TRANSFER UNDER A FOUNDER RESTRICTED STOCK PURCHASE AND RESTRICTION AGREEMENT AND A FOUNDERS' AGREEMENT WITH THE ISSUER, COPIES OF WHICH MAY BE OBTAINED AT THE PRINCIPAL OFFICE OF THE ISSUER. SUCH RESTRICTIONS ARE BINDING ON TRANSFEREES OF THESE SECURITIES.",
  ],
  locked_notes: [
    "Schedule A is locked post–Founder Rebalance: 280 / 220 / 200 / 200 (900 founder shares). Absolute numbers control; see scheduleA.ts and governance Schedule A.",
    "Past Contribution Shares (50%) are vested as of Vesting Commencement Date 2026-08-15; Service Vesting Shares (50%) vest in 10 equal quarterly installments.",
    "Vesting commencement and overall duration changes require affected founder consent (Section 1.5).",
    "Good/Bad Leaver economics (Schedule G) are not editable in the performance policy UI.",
  ],
};

export function assertWeights(policy: PolicyBody) {
  const sum = policy.dimensions.reduce((a, d) => a + d.weight, 0);
  if (Math.abs(sum - 100) > 0.001) {
    throw new Error(`Dimension weights must sum to 100 (got ${sum})`);
  }
}

export function consequenceForRating(
  policy: PolicyBody,
  rating: number,
  priorRating: number | null
): "none" | "observation" | "pip_trigger" {
  const secondLow =
    priorRating !== null &&
    rating <= policy.pip_trigger.on_second_consecutive_at_or_below &&
    priorRating <= policy.pip_trigger.on_second_consecutive_at_or_below;
  if (policy.pip_trigger.on_rating.includes(rating) || secondLow) return "pip_trigger";
  if (rating === policy.observation_on_first_rating) return "observation";
  return "none";
}

export function vestingProceeds(policy: PolicyBody, rating: number | null, consequence: string | null, suspended: boolean) {
  if (suspended) return false;
  if (consequence === "pip_trigger") return false;
  if (rating === null) return true; // vesting date without review block unless suspended
  if (rating >= policy.vesting_continues_at_or_above) return true;
  if (rating === policy.observation_on_first_rating && consequence === "observation") return true;
  return false;
}
