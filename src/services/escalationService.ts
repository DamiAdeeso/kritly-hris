import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { requirePerm, can } from "../rbac.js";
import { addDays, id, nowIso } from "../util.js";
import {
  disinterestedDirectors,
  getCycle,
  policyForCycle,
  requiredMajority,
} from "./reviewService.js";
import { notifyPerson } from "./notificationService.js";

function todayUtc() {
  return nowIso().slice(0, 10);
}

export async function getPlan(planId: string) {
  const plan = await prisma.performancePlan.findUnique({
    where: { id: planId },
    include: {
      employment: { include: { person: { select: { id: true, full_name: true } } } },
      cycle: true,
      notes: { include: { author: { select: { full_name: true } } }, orderBy: { created_at: "asc" } },
      ballots: { include: { voter: { select: { id: true, full_name: true } } }, orderBy: { created_at: "asc" } },
      badLeaverBallots: {
        include: { voter: { select: { id: true, full_name: true } } },
        orderBy: { created_at: "asc" },
      },
    },
  });
  if (!plan) throw Object.assign(new Error("Plan not found"), { status: 404 });
  return plan;
}

export async function assertCanViewPlan(viewerId: string, plan: Awaited<ReturnType<typeof getPlan>>) {
  const subjectId = plan.employment.person.id;
  if (subjectId === viewerId) return;
  if (await can(viewerId, "memo.read_all")) return;
  if (await can(viewerId, "review.vote")) return;
  throw Object.assign(new Error("Forbidden"), { status: 403 });
}

export async function addPlanNote(input: {
  actorId: string;
  planId: string;
  kind: "formal_concern_reply" | "check_in";
  body: string;
}) {
  const plan = await getPlan(input.planId);
  const subjectId = plan.employment.person.id;
  if (subjectId !== input.actorId) {
    throw Object.assign(new Error("Only the subject can post plan notes"), { status: 403 });
  }
  if (plan.status !== "open") {
    throw Object.assign(new Error("Plan is closed"), { status: 400 });
  }
  const body = input.body.trim();
  if (!body) throw Object.assign(new Error("Note body required"), { status: 400 });

  const cycle = await getCycle(plan.cycle_id);
  const policy = await policyForCycle(cycle);
  let late = 0;
  if (input.kind === "formal_concern_reply") {
    const deadline = addDays(plan.starts_on, policy.escalation.formal_concern_reply_days);
    if (todayUtc() > deadline) late = 1;
    const existing = await prisma.planNote.findFirst({
      where: { plan_id: plan.id, kind: "formal_concern_reply" },
      select: { id: true },
    });
    if (existing) throw Object.assign(new Error("Formal concern reply already filed"), { status: 400 });
  }

  const noteId = id("pnote");
  await prisma.planNote.create({
    data: {
      id: noteId,
      plan_id: plan.id,
      author_id: input.actorId,
      kind: input.kind,
      body,
      late,
      created_at: nowIso(),
    },
  });
  await audit({
    actorId: input.actorId,
    action: `plan.note_${input.kind}`,
    entityType: "performance_plan",
    entityId: plan.id,
    after: { late },
  });
  return { noteId, late: Boolean(late) };
}

export async function extendPip(input: { actorId: string; planId: string; extraDays: number }) {
  await requirePerm(input.actorId, "review.vote");
  const plan = await getPlan(input.planId);
  if (plan.kind !== "pip") throw Object.assign(new Error("Only PIPs can be extended"), { status: 400 });
  if (plan.status !== "open") throw Object.assign(new Error("Plan is closed"), { status: 400 });
  if (plan.extended_once) throw Object.assign(new Error("PIP already extended once"), { status: 400 });

  const cycle = await getCycle(plan.cycle_id);
  const policy = await policyForCycle(cycle);
  const max = policy.escalation.pip_extension_max_days;
  const days = Math.min(Math.max(1, Math.floor(input.extraDays)), max);
  const subjectId = plan.employment.person.id;
  const eligible = await disinterestedDirectors(subjectId, policy);
  if (!eligible.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("You are not eligible to extend this PIP"), { status: 403 });
  }

  const newEnd = addDays(plan.ends_on, days);
  await prisma.performancePlan.update({
    where: { id: plan.id },
    data: { ends_on: newEnd, extended_once: 1 },
  });
  await audit({
    actorId: input.actorId,
    action: "plan.extend_pip",
    entityType: "performance_plan",
    entityId: plan.id,
    after: { extraDays: days, ends_on: newEnd },
  });
  await notifyPerson({
    personId: subjectId,
    kind: "plan_extended",
    title: "PIP extended",
    body: `Your PIP end date is now ${newEnd} (+${days} days).`,
    href: `/plans/${plan.id}`,
    dueOn: newEnd,
    dedupeKey: `plan_extended:${plan.id}`,
  });
  return { endsOn: newEnd };
}

export async function castPlanBallot(input: {
  actorId: string;
  planId: string;
  decision: string;
}) {
  await requirePerm(input.actorId, "review.vote");
  const plan = await getPlan(input.planId);
  if (plan.status !== "open") throw Object.assign(new Error("Plan is closed"), { status: 400 });
  if (todayUtc() < plan.ends_on) {
    throw Object.assign(new Error("Voting opens after the plan end date"), { status: 400 });
  }

  const cycle = await getCycle(plan.cycle_id);
  const policy = await policyForCycle(cycle);
  const subjectId = plan.employment.person.id;
  const eligible = await disinterestedDirectors(subjectId, policy);
  if (!eligible.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("You are not eligible to vote on this plan"), { status: 403 });
  }

  if (plan.kind === "pip") {
    const voteDeadline = addDays(plan.ends_on, policy.escalation.pip_pass_fail_vote_days_after_end);
    if (todayUtc() > voteDeadline) {
      throw Object.assign(new Error(`PIP pass/fail vote closed after ${voteDeadline}`), { status: 400 });
    }
    if (input.decision !== "pass" && input.decision !== "fail") {
      throw Object.assign(new Error("Choose pass or fail"), { status: 400 });
    }
  } else if (plan.kind === "observation") {
    if (input.decision !== "met" && input.decision !== "not_met") {
      throw Object.assign(new Error("Choose met or not met"), { status: 400 });
    }
  } else {
    throw Object.assign(new Error("Unknown plan kind"), { status: 400 });
  }

  const prior = await prisma.planBallot.findUnique({
    where: { plan_id_voter_id: { plan_id: plan.id, voter_id: input.actorId } },
    select: { id: true },
  });
  if (prior) throw Object.assign(new Error("You already voted"), { status: 400 });

  await prisma.planBallot.create({
    data: {
      id: id("pballot"),
      plan_id: plan.id,
      voter_id: input.actorId,
      decision: input.decision,
      created_at: nowIso(),
    },
  });

  const ballots = await prisma.planBallot.findMany({ where: { plan_id: plan.id } });
  const positiveKey = plan.kind === "pip" ? "pass" : "met";
  const negativeKey = plan.kind === "pip" ? "fail" : "not_met";
  const positives = ballots.filter((b) => b.decision === positiveKey).length;
  const negatives = ballots.filter((b) => b.decision === negativeKey).length;
  const need = requiredMajority(eligible.length);

  if (positives >= need) {
    await prisma.performancePlan.update({
      where: { id: plan.id },
      data: { status: "closed", result: positiveKey },
    });
    if (plan.kind === "pip") {
      await prisma.equityAccount.updateMany({
        where: { employment_id: plan.employment_id },
        data: { vesting_suspended: 0 },
      });
    }
    await audit({
      actorId: input.actorId,
      action: "plan.close",
      entityType: "performance_plan",
      entityId: plan.id,
      after: { result: positiveKey },
    });
    await notifyPerson({
      personId: subjectId,
      kind: "plan_closed",
      title: `${plan.kind === "pip" ? "PIP" : "Observation"} closed · ${positiveKey}`,
      body: `Result: ${positiveKey}.`,
      href: `/plans/${plan.id}`,
      dueOn: addDays(todayUtc(), policy.escalation.pip_result_delivery_days),
      dedupeKey: `plan_closed:${plan.id}`,
    });
    return { closed: true as const, result: positiveKey };
  }

  if (negatives >= need) {
    if (plan.kind === "pip") {
      await prisma.performancePlan.update({
        where: { id: plan.id },
        data: { status: "closed", result: "fail", bad_leaver_open: 1 },
      });
      await audit({
        actorId: input.actorId,
        action: "plan.close",
        entityType: "performance_plan",
        entityId: plan.id,
        after: { result: "fail", bad_leaver_open: true },
      });
      for (const d of eligible) {
        await notifyPerson({
          personId: d.id,
          kind: "bad_leaver_vote",
          title: `Bad-leaver vote · ${plan.employment.person.full_name}`,
          body: `PIP failed. Cast a bad-leaver determination (threshold ${policy.escalation.bad_leaver_vote_threshold}).`,
          href: `/plans/${plan.id}`,
          dueOn: addDays(todayUtc(), policy.escalation.bad_leaver_notice_days),
          dedupeKey: `bad_leaver_vote:${plan.id}:${d.id}`,
        });
      }
      return { closed: true as const, result: "fail", badLeaverOpen: true };
    }
    await prisma.performancePlan.update({
      where: { id: plan.id },
      data: { status: "closed", result: "not_met" },
    });
    await audit({
      actorId: input.actorId,
      action: "plan.close",
      entityType: "performance_plan",
      entityId: plan.id,
      after: { result: "not_met" },
    });
    return { closed: true as const, result: "not_met" };
  }

  return { closed: false as const, positives, negatives, need };
}

export async function castBadLeaverBallot(input: {
  actorId: string;
  planId: string;
  decision: "yes" | "no";
}) {
  await requirePerm(input.actorId, "review.vote");
  const plan = await getPlan(input.planId);
  if (!plan.bad_leaver_open) {
    throw Object.assign(new Error("Bad-leaver vote is not open"), { status: 400 });
  }
  const cycle = await getCycle(plan.cycle_id);
  const policy = await policyForCycle(cycle);
  const subjectId = plan.employment.person.id;
  const eligible = await disinterestedDirectors(subjectId, policy);
  if (!eligible.some((d) => d.id === input.actorId)) {
    throw Object.assign(new Error("You are not eligible"), { status: 403 });
  }
  const prior = await prisma.badLeaverBallot.findUnique({
    where: { plan_id_voter_id: { plan_id: plan.id, voter_id: input.actorId } },
    select: { id: true },
  });
  if (prior) throw Object.assign(new Error("You already voted"), { status: 400 });

  await prisma.badLeaverBallot.create({
    data: {
      id: id("blballot"),
      plan_id: plan.id,
      voter_id: input.actorId,
      decision: input.decision,
      created_at: nowIso(),
    },
  });

  const ballots = await prisma.badLeaverBallot.findMany({ where: { plan_id: plan.id } });
  const yes = ballots.filter((b) => b.decision === "yes").length;
  const need = Math.ceil(eligible.length * policy.escalation.bad_leaver_vote_threshold);
  const no = ballots.filter((b) => b.decision === "no").length;

  if (yes >= need) {
    await prisma.employment.update({
      where: { id: plan.employment_id },
      data: { qualifying_service: 0 },
    });
    await prisma.equityAccount.updateMany({
      where: { employment_id: plan.employment_id },
      data: { vesting_suspended: 1 },
    });
    await prisma.consequenceNotice.create({
      data: {
        id: id("notice"),
        cycle_id: plan.cycle_id,
        employment_id: plan.employment_id,
        kind: "bad_leaver",
        body: `Bad-leaver determination recorded (${yes} of ${eligible.length}; threshold ${policy.escalation.bad_leaver_vote_threshold}). Qualifying service ended; vesting remains suspended. Schedule G repurchase terms stay in the Founders' Agreement.`,
        issued_at: nowIso(),
      },
    });
    await prisma.performancePlan.update({
      where: { id: plan.id },
      data: { bad_leaver_open: 0, result: "fail_bad_leaver" },
    });
    await audit({
      actorId: input.actorId,
      action: "plan.bad_leaver_yes",
      entityType: "performance_plan",
      entityId: plan.id,
      after: { yes, need },
    });
    await notifyPerson({
      personId: subjectId,
      kind: "bad_leaver_result",
      title: "Bad-leaver determination",
      body: "The Board recorded a bad-leaver determination. Repurchase terms remain in the agreement (Schedule G).",
      href: `/plans/${plan.id}`,
      dueOn: addDays(todayUtc(), policy.escalation.bad_leaver_notice_days),
      dedupeKey: `bad_leaver_result:${plan.id}`,
    });
    return { decided: true as const, result: "yes" as const, yes, need };
  }

  // Enough "no" votes that yes can no longer reach threshold
  if (yes + (eligible.length - ballots.length) < need) {
    await prisma.performancePlan.update({
      where: { id: plan.id },
      data: { bad_leaver_open: 0 },
    });
    await audit({
      actorId: input.actorId,
      action: "plan.bad_leaver_no",
      entityType: "performance_plan",
      entityId: plan.id,
      after: { yes, no, need },
    });
    return { decided: true as const, result: "no" as const, yes, need };
  }

  return { decided: false as const, yes, no, need };
}
