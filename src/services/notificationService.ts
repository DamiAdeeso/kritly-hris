import { prisma } from "../db.js";
import { id, nowIso, addDays } from "../util.js";
import { can } from "../rbac.js";
import {
  disinterestedDirectors,
  employmentForPerson,
  getCycle,
  listCycles,
  policyForCycle,
  subjectEmployments,
  type Cycle,
} from "./reviewService.js";
import { missingEvidenceCount } from "./evidenceService.js";

export type Notification = {
  id: string;
  person_id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  due_on: string | null;
  read_at: string | null;
  created_at: string;
  dedupe_key: string;
};

export type PersonTask = {
  key: string;
  title: string;
  body: string;
  href: string;
  dueOn: string;
  kind: string;
  done: boolean;
  overdue: boolean;
};

export type CycleDeadlines = {
  evidenceDueOn: string;
  selfAssessmentDueOn: string;
  scoresDueOn: string;
  votesDueOn: string;
  vestingDate: string;
  memoDeliveryDays: number;
};

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function earlier(a: string, b: string) {
  return a <= b ? a : b;
}

export async function cycleDeadlines(cycle: Cycle): Promise<CycleDeadlines> {
  const policy = await policyForCycle(cycle);
  const selfDue = addDays(cycle.ends_on, policy.cadence.self_assessment_days_after_period_end);
  return {
    evidenceDueOn: cycle.evidence_due_on || earlier(cycle.ends_on, cycle.review_deadline),
    selfAssessmentDueOn: cycle.self_assessment_due_on || earlier(selfDue, cycle.review_deadline),
    scoresDueOn: cycle.scores_due_on || cycle.review_deadline,
    votesDueOn: cycle.votes_due_on || cycle.review_deadline,
    vestingDate: cycle.vesting_date,
    memoDeliveryDays: policy.cadence.memo_delivery_days_after_vote,
  };
}

export async function upsertNotification(input: {
  personId: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  dueOn?: string | null;
  dedupeKey: string;
}) {
  const existing = await prisma.notification.findUnique({
    where: { dedupe_key: input.dedupeKey },
    select: { id: true, read_at: true },
  });
  if (existing) {
    await prisma.notification.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        body: input.body,
        href: input.href,
        due_on: input.dueOn ?? null,
        kind: input.kind,
      },
    });
    return existing.id;
  }
  const nid = id("ntf");
  await prisma.notification.create({
    data: {
      id: nid,
      person_id: input.personId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      href: input.href,
      due_on: input.dueOn ?? null,
      read_at: null,
      created_at: nowIso(),
      dedupe_key: input.dedupeKey,
    },
  });
  return nid;
}

export async function dismissNotificationByDedupe(dedupeKey: string) {
  const ts = nowIso();
  await prisma.notification.updateMany({
    where: { dedupe_key: dedupeKey, read_at: null },
    data: { read_at: ts },
  });
}

export async function listNotifications(personId: string, limit = 40) {
  const rows = await prisma.notification.findMany({
    where: { person_id: personId },
    orderBy: [{ read_at: { sort: "asc", nulls: "first" } }, { due_on: "asc" }, { created_at: "desc" }],
    take: limit,
  });
  return rows as Notification[];
}

export async function unreadCount(personId: string) {
  return prisma.notification.count({ where: { person_id: personId, read_at: null } });
}

export async function markNotificationRead(personId: string, notificationId: string) {
  await prisma.notification.updateMany({
    where: { id: notificationId, person_id: personId, read_at: null },
    data: { read_at: nowIso() },
  });
}

export async function markAllRead(personId: string) {
  await prisma.notification.updateMany({
    where: { person_id: personId, read_at: null },
    data: { read_at: nowIso() },
  });
}

async function hasSelfAssessment(cycleId: string, employmentId: string) {
  const row = await prisma.selfAssessment.findUnique({
    where: { cycle_id_employment_id: { cycle_id: cycleId, employment_id: employmentId } },
    select: { id: true },
  });
  return Boolean(row);
}

async function hasSealedSheet(cycleId: string, subjectEmploymentId: string, scorerPersonId: string) {
  const row = await prisma.sealedScoreSheet.findUnique({
    where: {
      cycle_id_subject_employment_id_scorer_person_id: {
        cycle_id: cycleId,
        subject_employment_id: subjectEmploymentId,
        scorer_person_id: scorerPersonId,
      },
    },
    select: { id: true },
  });
  return Boolean(row);
}

async function hasOwnBallot(cycleId: string, subjectEmploymentId: string, voterId: string) {
  const row = await prisma.adoptionBallot.findUnique({
    where: {
      cycle_id_subject_employment_id_voter_person_id: {
        cycle_id: cycleId,
        subject_employment_id: subjectEmploymentId,
        voter_person_id: voterId,
      },
    },
    select: { id: true },
  });
  return Boolean(row);
}

async function isAffiliatePair(a: string, b: string) {
  const row = await prisma.affiliate.findFirst({
    where: {
      OR: [
        { person_id: a, related_person_id: b },
        { person_id: b, related_person_id: a },
      ],
    },
    select: { person_id: true },
  });
  return Boolean(row);
}

/** Build actionable tasks for the logged-in person for open cycles. */
export async function tasksForPerson(personId: string): Promise<PersonTask[]> {
  const today = todayUtc();
  const tasks: PersonTask[] = [];
  const emp = await employmentForPerson(personId);
  const cycles = (await listCycles()).filter((c) => c.status !== "vesting_closed");

  for (const cycle of cycles) {
    const d = await cycleDeadlines(cycle);
    const policy = await policyForCycle(cycle);
    const adopted = Boolean(cycle.assignment_adopted_at) && cycle.status !== "draft";

    if (cycle.status === "draft" && (await can(personId, "cycle.manage"))) {
      tasks.push({
        key: `adopt:${cycle.id}`,
        title: `Adopt assignments · ${cycle.name}`,
        body: "Draft cycle: finish initiatives and cast your adoption vote.",
        href: `/performance/${cycle.id}/assignments`,
        dueOn: cycle.starts_on,
        kind: "assignment_adopt",
        done: false,
        overdue: cycle.starts_on < today,
      });
    }

    if (!adopted) continue;

    if (emp?.subject_to_founder_review) {
      const missing = await missingEvidenceCount(cycle.id, emp.id);
      const evidenceDone = missing === 0;
      tasks.push({
        key: `evidence:${cycle.id}:${emp.id}`,
        title: evidenceDone ? "Evidence uploaded" : "Upload your evidence",
        body: evidenceDone
          ? `All initiatives have evidence for ${cycle.name}.`
          : `${missing} initiative(s) still need an evidence link or file. Directors score what you post.`,
        href: `/performance/${cycle.id}/self`,
        dueOn: d.evidenceDueOn,
        kind: "evidence",
        done: evidenceDone,
        overdue: !evidenceDone && d.evidenceDueOn < today,
      });

      const selfDone = await hasSelfAssessment(cycle.id, emp.id);
      tasks.push({
        key: `self:${cycle.id}:${emp.id}`,
        title: selfDone ? "Self-assessment submitted" : "Submit your self-assessment",
        body: selfDone
          ? `Self-assessment is on file for ${cycle.name}.`
          : "Write a short summary for the Board before they seal scores.",
        href: `/performance/${cycle.id}/self`,
        dueOn: d.selfAssessmentDueOn,
        kind: "self_assessment",
        done: selfDone,
        overdue: !selfDone && d.selfAssessmentDueOn < today,
      });

      if (policy.cadence.mid_quarter_status_required) {
        const midDue = midQuarterDue(cycle.starts_on, cycle.ends_on);
        const initiatives = await prisma.initiative.findMany({
          where: { cycle_id: cycle.id, employment_id: emp.id },
          select: { id: true, title: true },
        });
        for (const ini of initiatives) {
          const updates = await prisma.initiativeStatusUpdate.count({
            where: { initiative_id: ini.id },
          });
          const done = updates > 0;
          tasks.push({
            key: `mid:${ini.id}`,
            title: done ? `Mid-quarter noted · ${ini.title}` : `Mid-quarter status · ${ini.title}`,
            body: done
              ? "At least one status note is on file."
              : "Post a mid-quarter status note for this initiative.",
            href: `/performance/${cycle.id}/self`,
            dueOn: midDue,
            kind: "mid_quarter",
            done,
            overdue: !done && midDue < today,
          });
        }
      }
    }

    if (await can(personId, "score.seal")) {
      const subjects = await subjectEmployments(cycle.id);
      for (const subject of subjects.filter((s) => s.person_id !== personId)) {
        const interested = policy.voting.recuse_affiliates && (await isAffiliatePair(personId, subject.person_id));
        if (interested) continue;
        const sealed = await hasSealedSheet(cycle.id, subject.id, personId);
        tasks.push({
          key: `seal:${cycle.id}:${subject.id}:${personId}`,
          title: sealed ? `Scored ${subject.full_name}` : `Seal score sheet · ${subject.full_name}`,
          body: sealed
            ? "Your sealed sheet is in."
            : "Read their evidence packet, then seal dimension scores (1–5).",
          href: `/performance/${cycle.id}/subject/${subject.id}/seal?step=1`,
          dueOn: d.scoresDueOn,
          kind: "score_seal",
          done: sealed,
          overdue: !sealed && d.scoresDueOn < today,
        });
      }
    }

    if (await can(personId, "review.vote")) {
      const subjects = await subjectEmployments(cycle.id);
      for (const subject of subjects) {
        const eligible = (await disinterestedDirectors(subject.person_id, policy)).some((d) => d.id === personId);
        if (!eligible) continue;
        const voted = await hasOwnBallot(cycle.id, subject.id, personId);
        const sheetCount = await prisma.sealedScoreSheet.count({
          where: { cycle_id: cycle.id, subject_employment_id: subject.id },
        });
        const need = (await disinterestedDirectors(subject.person_id, policy)).length;
        const ready = sheetCount >= need && need > 0;
        if (!ready && !voted) continue;
        tasks.push({
          key: `vote:${cycle.id}:${subject.id}:${personId}`,
          title: voted ? `You voted · ${subject.full_name}` : `Accept the average · ${subject.full_name}`,
          body: voted
            ? "Your accept or decline is recorded."
            : "All scores are in. Cast your own vote on the average.",
          href: `/performance/${cycle.id}/subject/${subject.id}/vote`,
          dueOn: d.votesDueOn,
          kind: "vote",
          done: voted,
          overdue: !voted && d.votesDueOn < today,
        });
      }
    }

    if (emp?.subject_to_founder_review && cycle.ratings_published) {
      const memo = await prisma.reviewMemo.findUnique({
        where: { cycle_id_employment_id: { cycle_id: cycle.id, employment_id: emp.id } },
        select: { id: true, delivered_at: true },
      });
      if (memo) {
        tasks.push({
          key: `memo:${memo.id}`,
          title: "Read your Founder Review memo",
          body: `Rating memo for ${cycle.name} is available.`,
          href: `/memos/${memo.id}`,
          dueOn: memo.delivered_at
            ? addDays(memo.delivered_at.slice(0, 10), d.memoDeliveryDays)
            : d.votesDueOn,
          kind: "memo",
          done: false,
          overdue: false,
        });
      }
    }
  }

  const openPlans = await prisma.performancePlan.findMany({
    where: {
      OR: [
        { status: "open", employment: { person_id: personId } },
        { status: "open" },
        { bad_leaver_open: 1 },
      ],
    },
    include: {
      employment: { include: { person: { select: { id: true, full_name: true } } } },
    },
    take: 40,
  });
  for (const plan of openPlans) {
    const subjectId = plan.employment.person.id;
    if (subjectId === personId && plan.status === "open") {
      tasks.push({
        key: `plan:${plan.id}:subject`,
        title: `${plan.kind === "pip" ? "PIP" : "Observation"} · reply / check-in`,
        body: `Ends ${plan.ends_on}.`,
        href: `/plans/${plan.id}`,
        dueOn: plan.ends_on,
        kind: "plan",
        done: false,
        overdue: plan.ends_on < today,
      });
    } else if (
      plan.status === "open" &&
      today >= plan.ends_on &&
      (await can(personId, "review.vote")) &&
      subjectId !== personId
    ) {
      tasks.push({
        key: `plan:${plan.id}:vote`,
        title: `Close ${plan.kind} · ${plan.employment.person.full_name}`,
        body: "Plan end date has passed. Cast your determination.",
        href: `/plans/${plan.id}`,
        dueOn: plan.ends_on,
        kind: "plan_vote",
        done: false,
        overdue: true,
      });
    } else if (plan.bad_leaver_open === 1 && (await can(personId, "review.vote")) && subjectId !== personId) {
      tasks.push({
        key: `plan:${plan.id}:bad_leaver`,
        title: `Bad-leaver vote · ${plan.employment.person.full_name}`,
        body: "PIP failed. Cast a bad-leaver determination.",
        href: `/plans/${plan.id}`,
        dueOn: plan.ends_on,
        kind: "bad_leaver",
        done: false,
        overdue: false,
      });
    }
  }

  return tasks.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return a.dueOn.localeCompare(b.dueOn);
  });
}

function midQuarterDue(startsOn: string, endsOn: string) {
  const a = Date.parse(`${startsOn}T00:00:00.000Z`);
  const b = Date.parse(`${endsOn}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return endsOn;
  const mid = new Date((a + b) / 2);
  return mid.toISOString().slice(0, 10);
}

/** Refresh inbox notifications from open tasks (unread while incomplete). */
export async function syncTaskNotifications(personId: string) {
  const tasks = await tasksForPerson(personId);
  for (const task of tasks) {
    const dedupe = `task:${task.key}`;
    if (task.done) {
      await dismissNotificationByDedupe(dedupe);
      continue;
    }
    await upsertNotification({
      personId,
      kind: task.kind,
      title: task.title,
      body: `${task.body} Due ${task.dueOn}${task.overdue ? " · overdue" : ""}.`,
      href: task.href,
      dueOn: task.dueOn,
      dedupeKey: dedupe,
    });
  }
  return tasks;
}

export async function notifyPerson(input: {
  personId: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  dueOn?: string | null;
  dedupeKey: string;
}) {
  return upsertNotification(input);
}

export async function notifyCycleOpened(cycleId: string) {
  const cycle = await getCycle(cycleId);
  const d = await cycleDeadlines(cycle);
  const founders = await prisma.person.findMany({
    where: { employment: { subject_to_founder_review: 1 } },
    select: { id: true },
  });
  for (const f of founders) {
    await notifyPerson({
      personId: f.id,
      kind: "cycle_open",
      title: `${cycle.name}: upload your evidence`,
      body: `Your evidence and self-assessment are due before directors score. Evidence due ${d.evidenceDueOn}; self-assessment due ${d.selfAssessmentDueOn}.`,
      href: `/performance/${cycle.id}/self`,
      dueOn: d.evidenceDueOn,
      dedupeKey: `cycle_open_evidence:${cycle.id}:${f.id}`,
    });
  }
  const directors = await prisma.person.findMany({ where: { is_director: 1 }, select: { id: true } });
  for (const dir of directors) {
    await notifyPerson({
      personId: dir.id,
      kind: "cycle_open",
      title: `${cycle.name}: review calendar`,
      body: `Seal scores by ${d.scoresDueOn}. Adopt ratings by ${d.votesDueOn}. Vesting date ${d.vestingDate}.`,
      href: `/performance/${cycle.id}`,
      dueOn: d.scoresDueOn,
      dedupeKey: `cycle_open_directors:${cycle.id}:${dir.id}`,
    });
  }
}
