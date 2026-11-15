import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { requirePerm } from "../rbac.js";
import { id, nowIso } from "../util.js";
import { getActivePolicy } from "./policyService.js";
import { getCycle, requiredMajority } from "./reviewService.js";
import { notifyCycleOpened } from "./notificationService.js";

export type OpenCycleInput = {
  actorId: string;
  name: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  evidenceDueOn: string;
  selfAssessmentDueOn: string;
  scoresDueOn: string;
  votesDueOn: string;
  vestingDate: string;
};

export { assertCycleAdopted } from "./cycleGuards.js";

export async function openDraftCycle(input: OpenCycleInput) {
  await requirePerm(input.actorId, "cycle.manage");
  const active = await getActivePolicy();
  const cycleId = id("cyc");
  await prisma.reviewCycle.create({
    data: {
      id: cycleId,
      name: input.name.trim(),
      period_label: input.periodLabel.trim(),
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      review_deadline: input.votesDueOn,
      vesting_date: input.vestingDate,
      policy_version_id: active.id,
      status: "draft",
      ratings_published: 0,
      assignment_adopted_at: null,
      assignment_adoption_method: null,
      evidence_due_on: input.evidenceDueOn,
      self_assessment_due_on: input.selfAssessmentDueOn,
      scores_due_on: input.scoresDueOn,
      votes_due_on: input.votesDueOn,
    },
  });
  await audit({
    actorId: input.actorId,
    action: "cycle.open",
    entityType: "review_cycle",
    entityId: cycleId,
    after: { name: input.name, status: "draft" },
  });
  return cycleId;
}

export async function assertDraftEditable(cycleId: string) {
  const cycle = await getCycle(cycleId);
  if (cycle.assignment_adopted_at) {
    throw Object.assign(new Error("Assignments already adopted"), { status: 400 });
  }
  if (cycle.status !== "draft") {
    throw Object.assign(new Error("Only draft cycles can edit assignments"), { status: 400 });
  }
  return cycle;
}

export async function addInitiative(input: {
  actorId: string;
  cycleId: string;
  employmentId: string;
  title: string;
  companyObjective: string;
  successCriteria: string;
  startDate: string;
  dueDate: string;
  weight?: number;
}) {
  await requirePerm(input.actorId, "cycle.manage");
  const cycle = await assertDraftEditable(input.cycleId);
  const emp = await prisma.employment.findUniqueOrThrow({
    where: { id: input.employmentId },
    select: { subject_to_founder_review: true },
  });
  if (!emp.subject_to_founder_review) {
    throw Object.assign(new Error("Employment is not subject to founder review"), { status: 400 });
  }
  const initiativeId = id("ini");
  await prisma.initiative.create({
    data: {
      id: initiativeId,
      cycle_id: input.cycleId,
      employment_id: input.employmentId,
      title: input.title.trim(),
      company_objective: input.companyObjective.trim(),
      success_criteria: input.successCriteria.trim(),
      start_date: input.startDate || cycle.starts_on,
      due_date: input.dueDate || cycle.evidence_due_on || cycle.ends_on,
      status: "not_started",
      weight: input.weight ?? 1,
    },
  });
  await audit({
    actorId: input.actorId,
    action: "initiative.create",
    entityType: "initiative",
    entityId: initiativeId,
  });
  return initiativeId;
}

export async function updateInitiative(input: {
  actorId: string;
  cycleId: string;
  initiativeId: string;
  title: string;
  companyObjective: string;
  successCriteria: string;
  dueDate: string;
  weight?: number;
}) {
  await requirePerm(input.actorId, "cycle.manage");
  await assertDraftEditable(input.cycleId);
  const row = await prisma.initiative.findFirst({
    where: { id: input.initiativeId, cycle_id: input.cycleId },
    select: { id: true },
  });
  if (!row) throw Object.assign(new Error("Initiative not found"), { status: 404 });
  await prisma.initiative.update({
    where: { id: input.initiativeId },
    data: {
      title: input.title.trim(),
      company_objective: input.companyObjective.trim(),
      success_criteria: input.successCriteria.trim(),
      due_date: input.dueDate,
      weight: input.weight ?? 1,
    },
  });
}

export async function removeInitiative(actorId: string, cycleId: string, initiativeId: string) {
  await requirePerm(actorId, "cycle.manage");
  await assertDraftEditable(cycleId);
  const row = await prisma.initiative.findFirst({
    where: { id: initiativeId, cycle_id: cycleId },
    select: { id: true },
  });
  if (!row) throw Object.assign(new Error("Initiative not found"), { status: 404 });
  await prisma.initiative.delete({ where: { id: initiativeId } });
  await audit({
    actorId,
    action: "initiative.delete",
    entityType: "initiative",
    entityId: initiativeId,
  });
}

export async function listAssignmentBallots(cycleId: string) {
  const rows = await prisma.assignmentBallot.findMany({
    where: { cycle_id: cycleId },
    include: { voter: { select: { id: true, full_name: true } } },
    orderBy: { created_at: "asc" },
  });
  return rows.map((b) => ({
    decision: b.decision,
    voter_id: b.voter_id,
    created_at: b.created_at,
    full_name: b.voter.full_name,
  }));
}

export async function castAssignmentBallot(input: {
  actorId: string;
  cycleId: string;
  decision: "accept" | "decline";
}) {
  await requirePerm(input.actorId, "cycle.manage");
  const cycle = await assertDraftEditable(input.cycleId);
  const directors = await prisma.person.findMany({
    where: { is_director: 1 },
    select: { id: true, full_name: true },
  });
  if (!directors.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("Only directors can adopt assignments"), { status: 403 });
  }
  const prior = await prisma.assignmentBallot.findUnique({
    where: { cycle_id_voter_id: { cycle_id: input.cycleId, voter_id: input.actorId } },
    select: { id: true },
  });
  if (prior) throw Object.assign(new Error("You already voted on this slate"), { status: 400 });

  const initiativeCount = await prisma.initiative.count({ where: { cycle_id: input.cycleId } });
  if (initiativeCount === 0) {
    throw Object.assign(new Error("Add at least one initiative before adopting"), { status: 400 });
  }

  await prisma.assignmentBallot.create({
    data: {
      id: id("aballot"),
      cycle_id: input.cycleId,
      voter_id: input.actorId,
      decision: input.decision,
      created_at: nowIso(),
    },
  });

  const ballots = await listAssignmentBallots(input.cycleId);
  const accepts = ballots.filter((b) => b.decision === "accept");
  const need = requiredMajority(directors.length);
  await audit({
    actorId: input.actorId,
    action: "cycle.assignment_ballot",
    entityType: "review_cycle",
    entityId: input.cycleId,
    after: { decision: input.decision, accepts: accepts.length, need },
  });

  if (accepts.length < need) {
    return { adopted: false as const, accepts: accepts.length, need, declines: ballots.length - accepts.length };
  }

  await prisma.reviewCycle.update({
    where: { id: input.cycleId },
    data: {
      status: "open",
      assignment_adopted_at: nowIso(),
      assignment_adoption_method: "board_majority",
    },
  });
  await audit({
    actorId: input.actorId,
    action: "cycle.adopt_assignments",
    entityType: "review_cycle",
    entityId: input.cycleId,
    after: { accepts: accepts.length, need, method: "board_majority" },
  });
  await notifyCycleOpened(input.cycleId);
  return {
    adopted: true as const,
    accepts: accepts.length,
    need,
    declines: ballots.length - accepts.length,
    cycleName: cycle.name,
  };
}
