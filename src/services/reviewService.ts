import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { can, requirePerm } from "../rbac.js";
import { consequenceForRating, type PolicyBody } from "../policy.js";
import { getPolicyById } from "./policyService.js";
import { addDays, id, nowIso } from "../util.js";
import { cycleDeadlines, notifyPerson } from "./notificationService.js";
import { buildDecisionBoard, buildMemoFeedback, type MemoFeedback } from "./deriveScores.js";
import { assertCycleAdopted } from "./cycleGuards.js";

/** Pure rule: all eligible directors voted and accepts are below majority. */
export function voteFailedCanRescore(input: {
  eligibleCount: number;
  ballotCount: number;
  acceptCount: number;
  need: number;
  alreadyAdopted: boolean;
}) {
  if (input.alreadyAdopted) return false;
  if (input.eligibleCount <= 0) return false;
  if (input.ballotCount < input.eligibleCount) return false;
  return input.acceptCount < input.need;
}

export type Cycle = {
  id: string;
  name: string;
  period_label: string;
  starts_on: string;
  ends_on: string;
  review_deadline: string;
  vesting_date: string;
  policy_version_id: string;
  status: string;
  ratings_published: number;
  assignment_adopted_at?: string | null;
  assignment_adoption_method?: string | null;
  evidence_due_on?: string | null;
  self_assessment_due_on?: string | null;
  scores_due_on?: string | null;
  votes_due_on?: string | null;
};

export async function getCycle(cycleId: string): Promise<Cycle> {
  const row = await prisma.reviewCycle.findUnique({ where: { id: cycleId } });
  if (!row) throw Object.assign(new Error("Cycle not found"), { status: 404 });
  return row as Cycle;
}

export async function listCycles() {
  const rows = await prisma.reviewCycle.findMany({ orderBy: { vesting_date: "desc" } });
  return rows as Cycle[];
}

export async function policyForCycle(cycle: Cycle): Promise<PolicyBody> {
  return getPolicyById(cycle.policy_version_id);
}

export async function employmentForPerson(personId: string) {
  return prisma.employment.findUnique({ where: { person_id: personId } });
}

export async function subjectEmployments(cycleId: string) {
  const initiatives = await prisma.initiative.findMany({
    where: { cycle_id: cycleId },
    include: {
      employment: {
        include: { person: { select: { id: true, full_name: true } } },
      },
    },
    orderBy: { employment: { person: { full_name: "asc" } } },
  });
  const seen = new Set<string>();
  const subjects: { id: string; person_id: string; full_name: string; title: string }[] = [];
  for (const i of initiatives) {
    if (seen.has(i.employment_id)) continue;
    seen.add(i.employment_id);
    subjects.push({
      id: i.employment.id,
      person_id: i.employment.person.id,
      full_name: i.employment.person.full_name,
      title: i.employment.title,
    });
  }
  return subjects;
}

export async function isAffiliate(voterPersonId: string, subjectPersonId: string) {
  const row = await prisma.affiliate.findFirst({
    where: {
      OR: [
        { person_id: voterPersonId, related_person_id: subjectPersonId },
        { person_id: subjectPersonId, related_person_id: voterPersonId },
      ],
    },
    select: { person_id: true },
  });
  return Boolean(row);
}

export async function disinterestedDirectors(subjectPersonId: string, policy: PolicyBody) {
  const directors = await prisma.person.findMany({
    where: { is_director: 1 },
    select: { id: true, full_name: true },
  });
  const filtered: { id: string; full_name: string }[] = [];
  for (const d of directors) {
    if (policy.voting.recuse_subject && d.id === subjectPersonId) continue;
    if (policy.voting.recuse_affiliates && (await isAffiliate(d.id, subjectPersonId))) continue;
    filtered.push(d);
  }
  return filtered;
}

export function requiredMajority(disinterestedCount: number) {
  return Math.floor(disinterestedCount / 2) + 1;
}

export async function submitSealedSheet(
  actorId: string,
  cycleId: string,
  subjectEmploymentId: string,
  body: unknown
) {
  await requirePerm(actorId, "score.seal");
  const cycle = await getCycle(cycleId);
  assertCycleAdopted(cycle);
  const subject = await prisma.employment.findUniqueOrThrow({
    where: { id: subjectEmploymentId },
    select: { person_id: true },
  });
  if (subject.person_id === actorId) {
    throw Object.assign(new Error("Cannot score yourself"), { status: 400 });
  }
  const sid = id("score");
  await prisma.sealedScoreSheet.upsert({
    where: {
      cycle_id_subject_employment_id_scorer_person_id: {
        cycle_id: cycleId,
        subject_employment_id: subjectEmploymentId,
        scorer_person_id: actorId,
      },
    },
    create: {
      id: sid,
      cycle_id: cycleId,
      subject_employment_id: subjectEmploymentId,
      scorer_person_id: actorId,
      body_json: JSON.stringify(body),
      sealed: 1,
      created_at: nowIso(),
    },
    update: {
      body_json: JSON.stringify(body),
      created_at: nowIso(),
    },
  });
  await audit({ actorId, action: "score.seal", entityType: "sealed_score_sheet", entityId: subjectEmploymentId });
  const policy = await policyForCycle(cycle);
  const subjectPerson = await prisma.person.findUniqueOrThrow({
    where: { id: subject.person_id },
    select: { full_name: true },
  });
  const deadlines = await cycleDeadlines(cycle);
  const eligible = await disinterestedDirectors(subject.person_id, policy);
  const sheetCount = await prisma.sealedScoreSheet.count({
    where: { cycle_id: cycleId, subject_employment_id: subjectEmploymentId },
  });
  if (sheetCount >= eligible.length && eligible.length > 0) {
    for (const voter of eligible) {
      await notifyPerson({
        personId: voter.id,
        kind: "vote_ready",
        title: `Your vote · ${subjectPerson.full_name}`,
        body: `All scores are in for ${cycle.name}. Accept or decline the average. Due ${deadlines.votesDueOn}.`,
        href: `/performance/${cycleId}/subject/${subjectEmploymentId}/vote`,
        dueOn: deadlines.votesDueOn,
        dedupeKey: `vote_ready:${cycleId}:${subjectEmploymentId}:${voter.id}`,
      });
    }
  }
}

export async function openSheetsForSubject(actorId: string, cycleId: string, subjectEmploymentId: string) {
  await requirePerm(actorId, "review.vote");
  const subject = await prisma.employment.findUniqueOrThrow({
    where: { id: subjectEmploymentId },
    select: { person_id: true },
  });
  const cycle = await getCycle(cycleId);
  const policy = await policyForCycle(cycle);
  if (subject.person_id === actorId) {
    throw Object.assign(new Error("Subject is recused"), { status: 403 });
  }
  if (policy.voting.recuse_affiliates && (await isAffiliate(actorId, subject.person_id))) {
    throw Object.assign(new Error("Affiliate is recused"), { status: 403 });
  }
  const sheets = await prisma.sealedScoreSheet.findMany({
    where: { cycle_id: cycleId, subject_employment_id: subjectEmploymentId },
    include: { scorer: { select: { full_name: true } } },
  });
  return sheets.map((s) => ({
    ...s,
    scorer_name: s.scorer.full_name,
  }));
}

export async function listBallots(cycleId: string, subjectEmploymentId: string) {
  const rows = await prisma.adoptionBallot.findMany({
    where: { cycle_id: cycleId, subject_employment_id: subjectEmploymentId },
    include: { voter: { select: { full_name: true } } },
    orderBy: { created_at: "asc" },
  });
  return rows.map((b) => ({
    decision: b.decision,
    voter_person_id: b.voter_person_id,
    created_at: b.created_at,
    full_name: b.voter.full_name,
  }));
}

/** One director accepts or declines the derived average. Adoption is written only when accepts reach a majority. */
export async function castBallot(input: {
  actorId: string;
  cycleId: string;
  subjectEmploymentId: string;
  decision: "accept" | "decline";
}) {
  await requirePerm(input.actorId, "review.vote");
  const cycle = await getCycle(input.cycleId);
  assertCycleAdopted(cycle);
  if (cycle.ratings_published) throw Object.assign(new Error("Ratings already published"), { status: 400 });
  const existingOfficial = await prisma.reviewVote.findUnique({
    where: {
      cycle_id_subject_employment_id: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
    },
    select: { id: true },
  });
  if (existingOfficial) throw Object.assign(new Error("Rating already adopted"), { status: 400 });

  const policy = await policyForCycle(cycle);
  const subject = await prisma.employment.findUniqueOrThrow({
    where: { id: input.subjectEmploymentId },
    select: { person_id: true },
  });
  const disinterested = await disinterestedDirectors(subject.person_id, policy);
  if (!disinterested.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("You are not eligible to vote on this person"), { status: 403 });
  }
  const priorBallot = await prisma.adoptionBallot.findUnique({
    where: {
      cycle_id_subject_employment_id_voter_person_id: {
        cycle_id: input.cycleId,
        subject_employment_id: input.subjectEmploymentId,
        voter_person_id: input.actorId,
      },
    },
    select: { id: true },
  });
  if (priorBallot) throw Object.assign(new Error("You already voted"), { status: 400 });

  const sheets = await prisma.sealedScoreSheet.findMany({
    where: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
    include: { scorer: { select: { full_name: true } } },
  });
  const board = buildDecisionBoard({
    policy,
    eligible: disinterested,
    sheets: sheets.map((s) => ({
      scorer_person_id: s.scorer_person_id,
      body_json: s.body_json,
      scorer_name: s.scorer.full_name,
    })),
  });
  if (!board.complete) {
    throw Object.assign(new Error("All sealed scores are required before anyone can accept the average"), { status: 400 });
  }
  if (input.decision === "accept" && board.derivedAverageRating <= 2 && !board.suggestedMissedCriterion) {
    throw Object.assign(
      new Error("Average is 1 or 2 but no missed criterion was named on the score sheets"),
      { status: 400 }
    );
  }

  await prisma.adoptionBallot.create({
    data: {
      id: id("ballot"),
      cycle_id: input.cycleId,
      subject_employment_id: input.subjectEmploymentId,
      voter_person_id: input.actorId,
      decision: input.decision,
      created_at: nowIso(),
    },
  });

  const ballots = await listBallots(input.cycleId, input.subjectEmploymentId);
  const accepts = ballots.filter((b) => b.decision === "accept");
  const need = requiredMajority(disinterested.length);
  await audit({
    actorId: input.actorId,
    action: "review.ballot",
    entityType: "adoption_ballot",
    entityId: input.subjectEmploymentId,
    after: { decision: input.decision, accepts: accepts.length, need },
  });

  if (accepts.length < need) {
    return { adopted: false as const, accepts: accepts.length, declines: ballots.length - accepts.length, need };
  }

  const rating = board.derivedAverageRating;
  const missed = rating <= 2 ? board.suggestedMissedCriterion : undefined;
  const feedback = buildMemoFeedback(board, policy);
  const adoptionNote = `Majority accepted derived average ${rating} (${accepts.length} of ${disinterested.length}; raw mean ${board.averageRaw.toFixed(2)}).`;
  const result = await castVote({
    actorId: input.actorId,
    cycleId: input.cycleId,
    subjectEmploymentId: input.subjectEmploymentId,
    rating,
    missedCriterion: missed || undefined,
    feedback,
    adoptionNote,
    initiativeScores: board.initiativeConsensus.map((i) => ({
      initiativeId: i.initiativeId,
      title: i.title,
      score: i.score,
      evidence: i.evidence,
    })),
    voterIds: accepts.map((a) => a.voter_person_id),
  });
  return { adopted: true as const, accepts: accepts.length, declines: ballots.length - accepts.length, need, ...result };
}

export async function returnSubjectToScoring(input: {
  actorId: string;
  cycleId: string;
  subjectEmploymentId: string;
}) {
  await requirePerm(input.actorId, "review.vote");
  const cycle = await getCycle(input.cycleId);
  assertCycleAdopted(cycle);
  if (cycle.ratings_published) {
    throw Object.assign(new Error("Ratings already published"), { status: 400 });
  }
  const existingOfficial = await prisma.reviewVote.findUnique({
    where: {
      cycle_id_subject_employment_id: {
        cycle_id: input.cycleId,
        subject_employment_id: input.subjectEmploymentId,
      },
    },
    select: { id: true },
  });
  if (existingOfficial) {
    throw Object.assign(new Error("Rating already adopted"), { status: 400 });
  }
  const policy = await policyForCycle(cycle);
  const subject = await prisma.employment.findUniqueOrThrow({
    where: { id: input.subjectEmploymentId },
    select: { person_id: true },
  });
  const disinterested = await disinterestedDirectors(subject.person_id, policy);
  if (!disinterested.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("You are not eligible to reset this person"), { status: 403 });
  }
  const ballots = await listBallots(input.cycleId, input.subjectEmploymentId);
  const accepts = ballots.filter((b) => b.decision === "accept").length;
  const need = requiredMajority(disinterested.length);
  if (
    !voteFailedCanRescore({
      eligibleCount: disinterested.length,
      ballotCount: ballots.length,
      acceptCount: accepts,
      need,
      alreadyAdopted: false,
    })
  ) {
    throw Object.assign(
      new Error("Return to scoring only after every eligible director voted and the average was not adopted"),
      { status: 400 }
    );
  }

  // The sheets hold directors' written feedback; keep a record before clearing them for a rescore.
  const clearedSheets = await prisma.sealedScoreSheet.findMany({
    where: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
  });
  await prisma.$transaction(async (tx) => {
    await tx.adoptionBallot.deleteMany({
      where: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
    });
    await tx.sealedScoreSheet.deleteMany({
      where: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
    });
    await tx.scoreDraft.deleteMany({
      where: { cycle_id: input.cycleId, subject_employment_id: input.subjectEmploymentId },
    });
  });
  await audit({
    actorId: input.actorId,
    action: "review.return_to_scoring",
    entityType: "employment",
    entityId: input.subjectEmploymentId,
    before: { sealedSheets: clearedSheets },
    after: { cycleId: input.cycleId, ballotsCleared: ballots.length, sheetsCleared: clearedSheets.length },
  });
  return { cleared: true as const };
}

export async function castVote(input: {
  actorId: string;
  cycleId: string;
  subjectEmploymentId: string;
  rating: number;
  missedCriterion?: string;
  /** Anonymised director feedback, carried into the founder's memo on publish. */
  feedback: MemoFeedback;
  adoptionNote: string;
  initiativeScores: { initiativeId: string; title?: string; score: string; evidence: string }[];
  voterIds: string[];
}) {
  await requirePerm(input.actorId, "review.vote");
  const cycle = await getCycle(input.cycleId);
  if (cycle.ratings_published) throw Object.assign(new Error("Ratings already published"), { status: 400 });
  const policy = await policyForCycle(cycle);
  const subject = await prisma.employment.findUniqueOrThrow({
    where: { id: input.subjectEmploymentId },
    select: { person_id: true },
  });
  const disinterested = await disinterestedDirectors(subject.person_id, policy);
  const disinterestedIds = new Set(disinterested.map((d) => d.id));
  if (!disinterestedIds.has(input.actorId)) {
    throw Object.assign(new Error("Actor is not disinterested for this subject"), { status: 403 });
  }
  for (const vid of input.voterIds) {
    if (!disinterestedIds.has(vid)) {
      throw Object.assign(new Error(`Voter ${vid} is not disinterested`), { status: 400 });
    }
  }
  const need = requiredMajority(disinterested.length);
  if (input.voterIds.length < need) {
    throw Object.assign(new Error(`Need ${need} of ${disinterested.length} disinterested votes`), { status: 400 });
  }
  if (input.rating <= 2 && !input.missedCriterion) {
    throw Object.assign(new Error("Ratings of 2 or 1 require a named missed criterion"), { status: 400 });
  }

  const prior = await prisma.reviewVote.findFirst({
    where: {
      subject_employment_id: input.subjectEmploymentId,
      cycle: { vesting_date: { lt: cycle.vesting_date } },
    },
    orderBy: { cycle: { vesting_date: "desc" } },
    select: { rating: true },
  });

  const consequence = consequenceForRating(policy, input.rating, prior?.rating ?? null);
  const voteId = id("vote");
  await prisma.$transaction(async (tx) => {
    for (const is of input.initiativeScores) {
      await tx.initiative.updateMany({
        where: { id: is.initiativeId, cycle_id: input.cycleId },
        // The founder's reported status stays as they set it; the score lives in final_score.
        data: {
          final_score: is.score,
          final_evidence: is.evidence,
        },
      });
    }
    await tx.reviewVote.create({
      data: {
        id: voteId,
        cycle_id: input.cycleId,
        subject_employment_id: input.subjectEmploymentId,
        rating: input.rating,
        missed_criterion: input.missedCriterion ?? null,
        dimension_notes_json: JSON.stringify({ feedback: input.feedback, adoption: input.adoptionNote }),
        initiative_scores_json: JSON.stringify(input.initiativeScores),
        voter_ids_json: JSON.stringify(input.voterIds),
        consequence,
        prior_rating: prior?.rating ?? null,
        voted_at: nowIso(),
      },
    });
  });
  await audit({
    actorId: input.actorId,
    action: "review.vote",
    entityType: "review_vote",
    entityId: voteId,
    after: { rating: input.rating, consequence, voters: input.voterIds },
  });
  return { voteId, consequence, required: need, disinterestedCount: disinterested.length };
}

export async function allSubjectsVoted(cycleId: string) {
  const subjects = await subjectEmployments(cycleId);
  const votes = await prisma.reviewVote.findMany({
    where: { cycle_id: cycleId },
    select: { subject_employment_id: true },
  });
  const set = new Set(votes.map((v) => v.subject_employment_id));
  return subjects.every((s) => set.has(s.id));
}

export async function publishRatings(actorId: string, cycleId: string) {
  await requirePerm(actorId, "review.publish");
  const cycle = await getCycle(cycleId);
  assertCycleAdopted(cycle);
  const policy = await policyForCycle(cycle);
  if (policy.cadence.hide_ratings_until_all_voted && !(await allSubjectsVoted(cycleId))) {
    throw Object.assign(new Error("All subject votes required before publish"), { status: 400 });
  }
  const votes = await prisma.reviewVote.findMany({ where: { cycle_id: cycleId } });

  await prisma.$transaction(async (tx) => {
    await tx.reviewCycle.update({
      where: { id: cycleId },
      data: { ratings_published: 1, status: "rated" },
    });
    for (const vote of votes) {
      const emp = await tx.employment.findUniqueOrThrow({
        where: { id: vote.subject_employment_id },
        include: { person: { select: { full_name: true, id: true } } },
      });
      const voters = JSON.parse(vote.voter_ids_json) as string[];
      const voterPeople = await tx.person.findMany({
        where: { id: { in: voters } },
        select: { id: true, full_name: true },
      });
      const nameById = new Map(voterPeople.map((p) => [p.id, p.full_name]));
      const voterNames = voters.map((vid) => nameById.get(vid) ?? vid);
      const memoBody = {
        founder: emp.person.full_name,
        period: cycle.period_label,
        review_date: vote.voted_at.slice(0, 10),
        disinterested_directors_voting: voterNames,
        initiatives: JSON.parse(vote.initiative_scores_json),
        ...memoFeedbackFields(vote.dimension_notes_json),
        overall_rating: vote.rating,
        automatic_consequence: vote.consequence,
        prior_quarter_rating: vote.prior_rating,
        missed_criterion: vote.missed_criterion,
      };
      const memoId = id("memo");
      const delivered = nowIso();
      await tx.reviewMemo.create({
        data: {
          id: memoId,
          cycle_id: cycleId,
          employment_id: vote.subject_employment_id,
          vote_id: vote.id,
          body_json: JSON.stringify(memoBody),
          delivered_at: delivered,
          created_at: delivered,
        },
      });

      let noticeKind = "none";
      let noticeBody = `Rating ${vote.rating}. Vesting continues in the ordinary course.`;
      const today = nowIso().slice(0, 10);
      if (vote.consequence === "observation") {
        noticeKind = "observation";
        noticeBody = `Observation (${policy.escalation.observation_days_min}-${policy.escalation.observation_days_max} days). Concern: ${vote.missed_criterion}. Vesting continues.`;
        await tx.performancePlan.create({
          data: {
            id: id("plan"),
            cycle_id: cycleId,
            employment_id: vote.subject_employment_id,
            kind: "observation",
            objectives: vote.missed_criterion ?? "Improve performance",
            success_metrics: "Demonstrate recovery on named criterion",
            support: "",
            check_in_schedule: "",
            starts_on: today,
            ends_on: addDays(nowIso(), policy.escalation.observation_days_max),
            status: "open",
          },
        });
      }
      if (vote.consequence === "pip_trigger") {
        noticeKind = "formal_concern_pip";
        noticeBody = `Formal Concern and Performance Improvement Plan (${policy.escalation.pip_days_default} days). Reply within ${policy.escalation.formal_concern_reply_days} days. Vesting suspended. Criterion: ${vote.missed_criterion}.`;
        await tx.equityAccount.updateMany({
          where: { employment_id: vote.subject_employment_id },
          data: { vesting_suspended: 1 },
        });
        await tx.performancePlan.create({
          data: {
            id: id("plan"),
            cycle_id: cycleId,
            employment_id: vote.subject_employment_id,
            kind: "pip",
            objectives: vote.missed_criterion ?? "PIP objectives",
            success_metrics: "Pass/fail against written success metrics",
            support: "As specified by Disinterested Directors",
            check_in_schedule: "Weekly check-ins",
            starts_on: today,
            ends_on: addDays(nowIso(), policy.escalation.pip_days_default),
            status: "open",
          },
        });
      }
      await tx.consequenceNotice.create({
        data: {
          id: id("notice"),
          cycle_id: cycleId,
          employment_id: vote.subject_employment_id,
          kind: noticeKind,
          body: noticeBody,
          issued_at: nowIso(),
        },
      });

      await notifyPerson({
        personId: emp.person.id,
        kind: "memo_ready",
        title: `Your Founder Review memo · rating ${vote.rating}`,
        body: `${noticeBody} Open your Exhibit C-1 memo.`,
        href: `/memos/${memoId}`,
        dueOn: addDays(today, policy.cadence.memo_delivery_days_after_vote),
        dedupeKey: `memo_ready:${memoId}`,
      });
    }
  });
  await audit({ actorId, action: "review.publish", entityType: "review_cycle", entityId: cycleId });
}

export async function getMemoForViewer(viewerId: string, memoId: string) {
  const memo = await prisma.reviewMemo.findUnique({ where: { id: memoId } });
  if (!memo) throw Object.assign(new Error("Memo not found"), { status: 404 });
  const emp = await prisma.employment.findUniqueOrThrow({
    where: { id: memo.employment_id },
    select: { person_id: true },
  });
  if (await can(viewerId, "memo.read_all")) return memo;
  if ((await can(viewerId, "memo.read_own")) && emp.person_id === viewerId && memo.delivered_at) return memo;
  throw Object.assign(new Error("Forbidden"), { status: 403 });
}

/** Memo fields from a vote's stored feedback ({ feedback, adoption }). */
function memoFeedbackFields(raw: string): { feedback: MemoFeedback; adoption_note: string } {
  try {
    const parsed = JSON.parse(raw) as { feedback?: MemoFeedback; adoption?: string };
    return {
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      adoption_note: typeof parsed.adoption === "string" ? parsed.adoption : "",
    };
  } catch {
    return { feedback: [], adoption_note: "" };
  }
}
