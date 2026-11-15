import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../db.js";
import { can, personPermissionKeys } from "../rbac.js";
import {
  cycleDeadlines,
  listNotifications,
  syncTaskNotifications,
  unreadCount,
} from "../services/notificationService.js";
import { getActivePolicy } from "../services/policyService.js";
import {
  disinterestedDirectors,
  employmentForPerson,
  getCycle,
  isAffiliate,
  listCycles,
  policyForCycle,
  requiredMajority,
  subjectEmployments,
} from "../services/reviewService.js";
import { listAffiliatesForPerson } from "../services/peopleService.js";
import {
  formatMoney,
  getCashCall,
  listCashCalls,
  listCompanyAccounts,
  outstandingByCurrency,
} from "../services/financeService.js";
import { listEvidenceFiles } from "../services/evidenceService.js";
import { getMemoForViewer } from "../services/reviewService.js";
import { assertCanViewPlan, getPlan } from "../services/escalationService.js";

type RouteFn = (req: express.Request, res: express.Response) => void | Promise<void>;

function serviceKeyOk(req: express.Request): boolean {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  const expected =
    process.env.HRIS_INTERNAL_KEY?.trim() ||
    process.env.NAI_SERVICE_KEY?.trim();
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function personIdFrom(req: express.Request): string | null {
  const q = String(req.query.personId || "").trim();
  return q || null;
}

function fail(res: express.Response, status: number) {
  res.status(status).json({ ok: false });
}

/**
 * GET-only Nai read surface. Service-key auth. Person comes from query, not the model.
 */
export function registerNaiReadRoutes(
  app: express.Express,
  route: (fn: RouteFn) => express.RequestHandler
) {
  const gate = (fn: RouteFn): express.RequestHandler =>
    route(async (req, res) => {
      if (!serviceKeyOk(req)) {
        fail(res, 401);
        return;
      }
      const personId = personIdFrom(req);
      if (!personId) {
        fail(res, 400);
        return;
      }
      req.params.personId = personId;
      try {
        await fn(req, res);
      } catch {
        if (!res.headersSent) fail(res, 500);
      }
    });

  app.get(
    "/api/nai/me",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      const person = await prisma.person.findUnique({
        where: { id: personId },
        select: { id: true, full_name: true, email: true },
      });
      if (!person) {
        fail(res, 404);
        return;
      }
      const permissions = [...(await personPermissionKeys(personId))];
      const roles = await prisma.personRole.findMany({
        where: { person_id: personId },
        select: { role: { select: { key: true } } },
      });
      res.json({
        person: {
          id: person.id,
          fullName: person.full_name,
          email: person.email,
        },
        roles: roles.map((r) => r.role.key),
        permissions,
      });
    })
  );

  app.get(
    "/api/nai/home",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      const tasks = await syncTaskNotifications(personId);
      const openTasks = tasks
        .filter((t) => !t.done)
        .map((t) => ({
          title: t.title,
          body: t.body,
          dueOn: t.dueOn,
          overdue: t.overdue,
          href: t.href,
          kind: t.kind,
        }));
      const cycles = await listCycles();
      const openCycle = cycles.find((c) => c.status !== "vesting_closed") ?? cycles[0];
      const deadlines = openCycle ? await cycleDeadlines(openCycle) : null;
      const confirmed = await prisma.equityAccount.count({
        where: { schedule_a_confirmed: 1 },
      });
      const showFinance = await can(personId, "finance.read");
      const openFinance = showFinance ? await outstandingByCurrency(personId) : [];
      res.json({
        openTasks,
        unreadCount: await unreadCount(personId),
        scheduleAConfirmed: confirmed,
        openCycle: openCycle
          ? {
              id: openCycle.id,
              name: openCycle.name,
              deadlines,
            }
          : null,
        openCashCalls: openFinance.map((row) => ({
          currency: row.currency,
          amount: formatMoney(row.cents, row.currency),
        })),
      });
    })
  );

  app.get(
    "/api/nai/policy",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "policy.read"))) {
        fail(res, 403);
        return;
      }
      const active = await getActivePolicy();
      const meta = await prisma.policyVersion.findUnique({
        where: { id: active.id },
        select: { label: true },
      });
      res.json({
        version: active.version,
        label: meta?.label ?? null,
        dimensions: active.body.dimensions,
        cadence: active.body.cadence,
        escalation: active.body.escalation,
        ratingScale: active.body.rating_scale,
        valuesCapRating: active.body.values_cap_rating,
        lockedLegalNote:
          "Schedule A counts, vesting start, and Schedule G repurchase need consent and are not freely editable.",
      });
    })
  );

  app.get(
    "/api/nai/cycles",
    gate(async (_req, res) => {
      const cycles = await listCycles();
      res.json({
        cycles: cycles.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          periodLabel: c.period_label,
          ratingsPublished: Boolean(c.ratings_published),
          assignmentAdopted: Boolean(c.assignment_adopted_at),
          reviewDeadline: c.review_deadline,
          vestingDate: c.vesting_date,
        })),
      });
    })
  );

  app.get(
    "/api/nai/cycles/:cycleId",
    gate(async (req, res) => {
      try {
        const cycle = await getCycle(req.params.cycleId!);
        const policy = await policyForCycle(cycle);
        const policyRow = cycle.policy_version_id
          ? await prisma.policyVersion.findUnique({
              where: { id: cycle.policy_version_id },
              select: { version: true },
            })
          : null;
        res.json({
          id: cycle.id,
          name: cycle.name,
          status: cycle.status,
          periodLabel: cycle.period_label,
          ratingsPublished: Boolean(cycle.ratings_published),
          assignmentAdopted: Boolean(cycle.assignment_adopted_at),
          reviewDeadline: cycle.review_deadline,
          vestingDate: cycle.vesting_date,
          policyVersion: policyRow?.version ?? null,
          hideRatingsUntilAllVoted: policy.cadence.hide_ratings_until_all_voted,
        });
      } catch {
        fail(res, 404);
      }
    })
  );

  app.get(
    "/api/nai/cycles/:cycleId/my-review",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      try {
        const cycle = await getCycle(req.params.cycleId!);
        const employment = await employmentForPerson(personId);
        if (!employment) {
          res.json({ ok: true, employment: null, initiatives: [], evidence: [] });
          return;
        }
        const initiatives = await prisma.initiative.findMany({
          where: { cycle_id: cycle.id, employment_id: employment.id },
          select: {
            id: true,
            title: true,
            evidence_ref: true,
            statusUpdates: {
              orderBy: { created_at: "desc" },
              take: 1,
              select: { note: true },
            },
          },
        });
        const self = await prisma.selfAssessment.findUnique({
          where: {
            cycle_id_employment_id: {
              cycle_id: cycle.id,
              employment_id: employment.id,
            },
          },
          select: { id: true },
        });
        const evidence: { name: string; type: string; href: string }[] = [];
        for (const ini of initiatives) {
          const files = await listEvidenceFiles(ini.id);
          for (const f of files) {
            evidence.push({
              name: f.original_name,
              type: f.mime,
              href: `/performance/${cycle.id}/self`,
            });
          }
          if (ini.evidence_ref?.trim()) {
            evidence.push({
              name: ini.evidence_ref.trim(),
              type: "link",
              href: `/performance/${cycle.id}/self`,
            });
          }
        }
        const deadlines = await cycleDeadlines(cycle);
        res.json({
          employmentId: employment.id,
          hasSelfAssessment: Boolean(self),
          deadlines: {
            evidenceDueOn: deadlines.evidenceDueOn,
            selfAssessmentDueOn: deadlines.selfAssessmentDueOn,
          },
          initiatives: initiatives.map((i) => ({
            id: i.id,
            title: i.title,
            hasStatusNote: Boolean(i.statusUpdates[0]?.note?.trim()),
            hasEvidenceLink: Boolean(i.evidence_ref?.trim()),
          })),
          evidence,
        });
      } catch {
        fail(res, 404);
      }
    })
  );

  app.get(
    "/api/nai/cycles/:cycleId/subjects/:employmentId/vote-status",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "review.vote"))) {
        fail(res, 403);
        return;
      }
      try {
        const cycle = await getCycle(req.params.cycleId!);
        const employmentId = req.params.employmentId!;
        const subjects = await subjectEmployments(cycle.id);
        const subject = subjects.find((s) => s.id === employmentId);
        if (!subject) {
          fail(res, 404);
          return;
        }
        const myEmployment = await employmentForPerson(personId);
        const isSubject = myEmployment?.id === employmentId;
        const affiliate = await isAffiliate(personId, subject.person_id);
        const policy = await policyForCycle(cycle);
        const directors = await disinterestedDirectors(subject.person_id, policy);
        const majority = requiredMajority(directors.length);
        res.json({
          cycleId: cycle.id,
          employmentId,
          subjectName: subject.full_name,
          isSubject,
          isAffiliate: affiliate,
          canVote: !isSubject && !affiliate,
          votingOpen: !cycle.ratings_published,
          majorityRequired: majority,
          disinterestedDirectorCount: directors.length,
        });
      } catch {
        fail(res, 404);
      }
    })
  );

  app.get(
    "/api/nai/cycles/:cycleId/score-progress",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "score.seal"))) {
        fail(res, 403);
        return;
      }
      try {
        const cycle = await getCycle(req.params.cycleId!);
        const myEmployment = await employmentForPerson(personId);
        const subjects = await subjectEmployments(cycle.id);
        const progress = [];
        for (const subject of subjects) {
          if (myEmployment && subject.id === myEmployment.id) continue;
          const sealed = await prisma.sealedScoreSheet.count({
            where: {
              cycle_id: cycle.id,
              subject_employment_id: subject.id,
              sealed: 1,
            },
          });
          progress.push({
            employmentId: subject.id,
            personName: subject.full_name,
            sealedSheetCount: sealed,
          });
        }
        res.json({ cycleId: cycle.id, subjects: progress });
      } catch {
        fail(res, 404);
      }
    })
  );

  app.get(
    "/api/nai/audit",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "audit.read"))) {
        fail(res, 403);
        return;
      }
      const rows = await prisma.auditEvent.findMany({
        orderBy: { created_at: "desc" },
        take: 40,
        select: {
          id: true,
          action: true,
          created_at: true,
          actor_id: true,
          entity_type: true,
        },
      });
      res.json({
        events: rows.map((r) => ({
          id: r.id,
          action: r.action,
          at: r.created_at,
          actorPersonId: r.actor_id,
          entityType: r.entity_type,
        })),
      });
    })
  );

  app.get(
    "/api/nai/people",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "people.read"))) {
        fail(res, 403);
        return;
      }
      const people = await prisma.person.findMany({
        select: { id: true, full_name: true, email: true },
        orderBy: { full_name: "asc" },
      });
      res.json({
        people: people.map((p) => ({
          id: p.id,
          fullName: p.full_name,
          email: p.email,
        })),
      });
    })
  );

  app.get(
    "/api/nai/people/:id",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "people.read"))) {
        fail(res, 403);
        return;
      }
      const target = await prisma.person.findUnique({
        where: { id: req.params.id },
        select: { id: true, full_name: true, email: true },
      });
      if (!target) {
        fail(res, 404);
        return;
      }
      const roles = await prisma.personRole.findMany({
        where: { person_id: target.id },
        select: { role: { select: { key: true } } },
      });
      const employment = await employmentForPerson(target.id);
      const affiliates = await listAffiliatesForPerson(target.id);
      res.json({
        id: target.id,
        fullName: target.full_name,
        email: target.email,
        roles: roles.map((r) => r.role.key),
        employment: employment
          ? {
              id: employment.id,
              title: employment.title,
              company: employment.company,
            }
          : null,
        affiliates: affiliates.map((a) => ({
          personId: a.person_id,
          relatedPersonId: a.related_person_id,
          relationship: a.relationship,
        })),
      });
    })
  );

  app.get(
    "/api/nai/equity",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "equity.read"))) {
        fail(res, 403);
        return;
      }
      const accounts = await prisma.equityAccount.findMany({
        select: {
          id: true,
          employment_id: true,
          total_shares: true,
          vested_shares: true,
          unvested_shares: true,
          schedule_a_confirmed: true,
          vesting_suspended: true,
          employment: {
            select: {
              person_id: true,
              person: { select: { full_name: true } },
            },
          },
        },
      });
      res.json({
        accounts: accounts.map((a) => ({
          id: a.id,
          personId: a.employment.person_id,
          personName: a.employment.person.full_name,
          totalShares: a.total_shares,
          vestedShares: a.vested_shares,
          unvestedShares: a.unvested_shares,
          scheduleAConfirmed: Boolean(a.schedule_a_confirmed),
          vestingSuspended: Boolean(a.vesting_suspended),
        })),
      });
    })
  );

  app.get(
    "/api/nai/cash-calls",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "finance.read"))) {
        fail(res, 403);
        return;
      }
      const calls = await listCashCalls();
      res.json({
        calls: calls.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          currency: c.currency,
          totalCents: c.total_cents,
          dueOn: c.due_on,
          outstandingCents: c.outstanding_cents,
        })),
      });
    })
  );

  app.get(
    "/api/nai/cash-calls/:id",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "finance.read"))) {
        fail(res, 403);
        return;
      }
      try {
        const call = await getCashCall(req.params.id!);
        const manage = await can(personId, "finance.manage");
        const lines = (call.lines ?? [])
          .filter((line) => manage || line.person_id === personId)
          .map((line) => ({
            personId: line.person_id,
            amountCents: line.amount_cents,
            paidCents: line.paid_cents,
            outstandingCents: line.amount_cents - line.paid_cents,
          }));
        res.json({
          id: call.id,
          title: call.title,
          status: call.status,
          currency: call.currency,
          totalCents: call.total_cents,
          dueOn: call.due_on,
          accountName: call.account_name,
          lines,
        });
      } catch {
        fail(res, 404);
      }
    })
  );

  app.get(
    "/api/nai/accounts",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      if (!(await can(personId, "finance.read"))) {
        fail(res, 403);
        return;
      }
      const accounts = await listCompanyAccounts();
      res.json({
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          institution: a.institution,
          currency: a.currency,
          paymentReference: a.reference,
          status: a.status,
        })),
      });
    })
  );

  app.get(
    "/api/nai/notifications",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      const rows = await listNotifications(personId, 20);
      res.json({
        notifications: rows.map((n) => ({
          id: n.id,
          title: n.title,
          dueOn: n.due_on,
          read: Boolean(n.read_at),
          href: n.href,
        })),
      });
    })
  );

  app.get(
    "/api/nai/memos/:id",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      try {
        const memo = await getMemoForViewer(personId, req.params.id!);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(memo.body_json) as Record<string, unknown>;
        } catch {
          body = {};
        }
        res.json({
          id: memo.id,
          deliveredAt: memo.delivered_at,
          period: typeof body.period === "string" ? body.period : null,
          founder: typeof body.founder === "string" ? body.founder : null,
          overallRating:
            body.overall_rating != null ? Number(body.overall_rating) : null,
          automaticConsequence:
            typeof body.automatic_consequence === "string"
              ? body.automatic_consequence
              : null,
        });
      } catch {
        fail(res, 403);
      }
    })
  );

  app.get(
    "/api/nai/plans/:id",
    gate(async (req, res) => {
      const personId = req.params.personId!;
      try {
        const plan = await getPlan(req.params.id!);
        await assertCanViewPlan(personId, plan);
        res.json({
          id: plan.id,
          kind: plan.kind,
          status: plan.status,
          startsOn: plan.starts_on,
          endsOn: plan.ends_on,
          noteCount: plan.notes?.length ?? 0,
        });
      } catch {
        fail(res, 403);
      }
    })
  );

  app.get(
    "/api/nai/approvals",
    gate(async (_req, res) => {
      res.json({ approvals: [] });
    })
  );
}
