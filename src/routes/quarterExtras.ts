import type express from "express";
import fs from "node:fs";
import { prisma } from "../db.js";
import { can } from "../rbac.js";
import { escapeHtml } from "../util.js";
import { pageHeader, crumbs, statusPill, emptyState, callout } from "../views.js";
import {
  openDraftCycle,
  addInitiative,
  updateInitiative,
  removeInitiative,
  castAssignmentBallot,
  listAssignmentBallots,
} from "../services/cycleService.js";
import {
  getCycle,
  policyForCycle,
  requiredMajority,
  returnSubjectToScoring,
} from "../services/reviewService.js";
import {
  EVIDENCE_MAX_BYTES,
  absoluteEvidencePath,
  canAccessEvidenceFile,
  listEvidenceFiles,
  saveEvidenceFile,
} from "../services/evidenceService.js";
import {
  addAffiliate,
  createPerson,
  listAffiliatesForPerson,
  removeAffiliate,
  upsertEmployment,
} from "../services/peopleService.js";
import {
  addPlanNote,
  assertCanViewPlan,
  castBadLeaverBallot,
  castPlanBallot,
  extendPip,
  getPlan,
} from "../services/escalationService.js";
import { singleFileUpload } from "../multipart.js";
import { isInitiativeStatus } from "../initiativeStatus.js";

type RouteFn = (req: express.Request, res: express.Response) => void | Promise<void>;
type PageFn = (req: express.Request, title: string, body: string) => Promise<string>;

export function registerQuarterExtras(
  app: express.Express,
  helpers: {
    route: (fn: RouteFn) => express.RequestHandler;
    page: PageFn;
  }
) {
  const { route, page } = helpers;

  app.get(
    "/performance/new",
    route(async (req, res) => {
      if (!(await can(req.person!.id, "cycle.manage"))) {
        res.status(403).send(await page(req, "Forbidden", "Missing cycle.manage"));
        return;
      }
      res.send(
        await page(
          req,
          "Open a cycle",
          `${crumbs([{ href: "/performance", label: "Performance" }, { label: "Open a cycle" }])}
        ${pageHeader("Open a cycle", "Draft against the active policy. Directors adopt the initiative slate before scoring.")}
        <form class="card" method="post" action="/performance/new">
          <div class="field-grid">
            <div class="field span-2"><label>Name</label><input name="name" required placeholder="February 2027 Vesting Review" /></div>
            <div class="field span-2"><label>Period label</label><input name="period_label" required placeholder="Q1 service vesting review" /></div>
            <div class="field"><label>Starts on</label><input name="starts_on" type="date" required /></div>
            <div class="field"><label>Ends on</label><input name="ends_on" type="date" required /></div>
            <div class="field"><label>Evidence due</label><input name="evidence_due_on" type="date" required /></div>
            <div class="field"><label>Self-assessment due</label><input name="self_assessment_due_on" type="date" required /></div>
            <div class="field"><label>Scores due</label><input name="scores_due_on" type="date" required /></div>
            <div class="field"><label>Votes due</label><input name="votes_due_on" type="date" required /></div>
            <div class="field"><label>Vesting date</label><input name="vesting_date" type="date" required /></div>
          </div>
          <div class="form-actions"><button type="submit">Create draft cycle</button></div>
        </form>`
        )
      );
    })
  );

  app.post(
    "/performance/new",
    route(async (req, res) => {
      try {
        const cycleId = await openDraftCycle({
          actorId: req.person!.id,
          name: String(req.body.name || ""),
          periodLabel: String(req.body.period_label || ""),
          startsOn: String(req.body.starts_on || ""),
          endsOn: String(req.body.ends_on || ""),
          evidenceDueOn: String(req.body.evidence_due_on || ""),
          selfAssessmentDueOn: String(req.body.self_assessment_due_on || ""),
          scoresDueOn: String(req.body.scores_due_on || ""),
          votesDueOn: String(req.body.votes_due_on || ""),
          vestingDate: String(req.body.vesting_date || ""),
        });
        res.redirect(`/performance/${cycleId}/assignments`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.get(
    "/performance/:cycleId/assignments",
    route(async (req, res) => {
      if (!(await can(req.person!.id, "cycle.manage"))) {
        res.status(403).send(await page(req, "Forbidden", "Missing cycle.manage"));
        return;
      }
      const cycle = await getCycle(req.params.cycleId);
      const founders = await prisma.employment.findMany({
        where: { subject_to_founder_review: 1 },
        include: { person: { select: { full_name: true } } },
        orderBy: { person: { full_name: "asc" } },
      });
      const initiatives = await prisma.initiative.findMany({
        where: { cycle_id: cycle.id },
        include: { employment: { include: { person: { select: { full_name: true } } } } },
        orderBy: { title: "asc" },
      });
      const directors = await prisma.person.findMany({
        where: { is_director: 1 },
        select: { id: true, full_name: true },
      });
      const ballots = await listAssignmentBallots(cycle.id);
      const need = requiredMajority(directors.length);
      const accepts = ballots.filter((b) => b.decision === "accept").length;
      const mine = ballots.find((b) => b.voter_id === req.person!.id);
      const adopted = Boolean(cycle.assignment_adopted_at);

      res.send(
        await page(
          req,
          `Assignments · ${cycle.name}`,
          `${crumbs([
            { href: "/performance", label: "Performance" },
            { href: `/performance/${cycle.id}`, label: cycle.name },
            { label: "Assignments" },
          ])}
        ${pageHeader(
          cycle.name,
          adopted
            ? `Assignments adopted ${escapeHtml(String(cycle.assignment_adopted_at).slice(0, 10))}.`
            : "Draft: add initiatives, then directors accept the slate.",
          adopted
            ? `<a class="btn" href="/performance/${cycle.id}">Open cycle</a>`
            : ""
        )}
        ${
          adopted
            ? callout("This slate is locked.")
            : callout(`Adoption needs ${need} of ${directors.length} directors. Accepts so far: ${accepts}.`)
        }
        <div class="section-label">Initiatives</div>
        ${
          initiatives.length === 0
            ? emptyState("No initiatives yet.")
            : `<div class="list">${initiatives
                .map(
                  (i) => `<div class="list-row">
                    <div>
                      <div class="title">${escapeHtml(i.title)}</div>
                      <div class="meta">${escapeHtml(i.employment.person.full_name)} · ${escapeHtml(i.company_objective)}</div>
                      <div class="meta">${escapeHtml(i.success_criteria)}</div>
                    </div>
                    <div class="aside">
                      ${
                        adopted
                          ? ""
                          : `<form method="post" action="/performance/${cycle.id}/initiatives/${i.id}/delete"><button class="secondary" type="submit">Remove</button></form>`
                      }
                    </div>
                  </div>`
                )
                .join("")}</div>`
        }
        ${
          adopted
            ? ""
            : `<div class="card">
                <div class="card-head"><h2>Add initiative</h2></div>
                <form method="post" action="/performance/${cycle.id}/initiatives">
                  <div class="field-grid">
                    <div class="field"><label>Founder</label>
                      <select name="employment_id" required>
                        ${founders
                          .map(
                            (f) =>
                              `<option value="${f.id}">${escapeHtml(f.person.full_name)} · ${escapeHtml(f.title)}</option>`
                          )
                          .join("")}
                      </select>
                    </div>
                    <div class="field"><label>Due date</label><input name="due_date" type="date" value="${escapeHtml(cycle.evidence_due_on || cycle.ends_on)}" required /></div>
                    <div class="field span-2"><label>Title</label><input name="title" required /></div>
                    <div class="field span-2"><label>Company objective</label><input name="company_objective" required /></div>
                    <div class="field span-2"><label>Success criteria</label><textarea name="success_criteria" required></textarea></div>
                  </div>
                  <div class="form-actions"><button type="submit">Add initiative</button></div>
                </form>
              </div>
              <div class="section-label">Adoption votes</div>
              <div class="card">
                <ul>
                  ${directors
                    .map((d) => {
                      const b = ballots.find((x) => x.voter_id === d.id);
                      const label = !b ? "Not yet" : b.decision === "accept" ? "Accepted" : "Declined";
                      return `<li><strong>${escapeHtml(d.full_name)}</strong> · ${label}${d.id === req.person!.id ? " · you" : ""}</li>`;
                    })
                    .join("")}
                </ul>
              </div>
              ${
                mine
                  ? callout(`Your vote is recorded: ${mine.decision}.`)
                  : `<form class="card" method="post" action="/performance/${cycle.id}/assignments/vote">
                      <div class="choice"><label><input type="radio" name="decision" value="accept" checked required /><span>I accept this initiative slate</span></label></div>
                      <div class="choice"><label><input type="radio" name="decision" value="decline" required /><span>I decline this slate</span></label></div>
                      <div class="form-actions"><button type="submit">Submit adoption vote</button></div>
                    </form>`
              }`
        }`
        )
      );
    })
  );

  app.post(
    "/performance/:cycleId/initiatives",
    route(async (req, res) => {
      try {
        await addInitiative({
          actorId: req.person!.id,
          cycleId: req.params.cycleId,
          employmentId: String(req.body.employment_id || ""),
          title: String(req.body.title || ""),
          companyObjective: String(req.body.company_objective || ""),
          successCriteria: String(req.body.success_criteria || ""),
          startDate: "",
          dueDate: String(req.body.due_date || ""),
        });
        res.redirect(`/performance/${req.params.cycleId}/assignments`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/performance/:cycleId/initiatives/:initiativeId",
    route(async (req, res) => {
      try {
        await updateInitiative({
          actorId: req.person!.id,
          cycleId: req.params.cycleId,
          initiativeId: req.params.initiativeId,
          title: String(req.body.title || ""),
          companyObjective: String(req.body.company_objective || ""),
          successCriteria: String(req.body.success_criteria || ""),
          dueDate: String(req.body.due_date || ""),
        });
        res.redirect(`/performance/${req.params.cycleId}/assignments`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/performance/:cycleId/initiatives/:initiativeId/delete",
    route(async (req, res) => {
      try {
        await removeInitiative(req.person!.id, req.params.cycleId, req.params.initiativeId);
        res.redirect(`/performance/${req.params.cycleId}/assignments`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/performance/:cycleId/assignments/vote",
    route(async (req, res) => {
      try {
        const decision = String(req.body.decision || "");
        if (decision !== "accept" && decision !== "decline") {
          throw Object.assign(new Error("Choose accept or decline"), { status: 400 });
        }
        await castAssignmentBallot({
          actorId: req.person!.id,
          cycleId: req.params.cycleId,
          decision,
        });
        res.redirect(`/performance/${req.params.cycleId}/assignments`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/performance/:cycleId/subject/:employmentId/return-to-scoring",
    route(async (req, res) => {
      try {
        await returnSubjectToScoring({
          actorId: req.person!.id,
          cycleId: req.params.cycleId,
          subjectEmploymentId: req.params.employmentId,
        });
        res.redirect(`/performance/${req.params.cycleId}/subject/${req.params.employmentId}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.get(
    "/evidence/:fileId",
    route(async (req, res) => {
      const file = await canAccessEvidenceFile(req.person!.id, req.params.fileId);
      if (!file) {
        res.status(403).send(await page(req, "Forbidden", "Forbidden"));
        return;
      }
      const full = absoluteEvidencePath(file.stored_name);
      if (!fs.existsSync(full)) {
        res.status(404).send(await page(req, "Not found", "File missing on disk"));
        return;
      }
      res.setHeader("Content-Type", file.mime);
      res.setHeader("Content-Disposition", `inline; filename="${file.original_name.replace(/"/g, "")}"`);
      fs.createReadStream(full).pipe(res);
    })
  );

  app.post(
    "/people",
    route(async (req, res) => {
      try {
        const personId = await createPerson({
          actorId: req.person!.id,
          fullName: String(req.body.full_name || ""),
          email: String(req.body.email || ""),
          password: String(req.body.password || ""),
          isDirector: String(req.body.is_director || "") === "1",
          isFounder: String(req.body.is_founder || "") === "1",
        });
        res.redirect(`/people/${personId}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/people/:id/employment",
    route(async (req, res) => {
      try {
        await upsertEmployment({
          actorId: req.person!.id,
          personId: req.params.id,
          title: String(req.body.title || ""),
          category: String(req.body.category || ""),
          startDate: String(req.body.start_date || ""),
          qualifyingService: String(req.body.qualifying_service || "") === "1",
          subjectToFounderReview: String(req.body.subject_to_founder_review || "") === "1",
          company: String(req.body.company || "Kritly Inc."),
        });
        res.redirect(`/people/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/people/:id/affiliates",
    route(async (req, res) => {
      try {
        await addAffiliate({
          actorId: req.person!.id,
          personId: req.params.id,
          relatedPersonId: String(req.body.related_person_id || ""),
          relationship: String(req.body.relationship || "affiliate"),
        });
        res.redirect(`/people/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/people/:id/affiliates/:relatedId/delete",
    route(async (req, res) => {
      try {
        await removeAffiliate(req.person!.id, req.params.id, req.params.relatedId);
        res.redirect(`/people/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.get(
    "/plans/:id",
    route(async (req, res) => {
      try {
        const plan = await getPlan(req.params.id);
        await assertCanViewPlan(req.person!.id, plan);
        const subjectId = plan.employment.person.id;
        const isSubject = subjectId === req.person!.id;
        const cycle = await getCycle(plan.cycle_id);
        const policy = await policyForCycle(cycle);
        const canVote = (await can(req.person!.id, "review.vote")) && !isSubject;
        const today = new Date().toISOString().slice(0, 10);
        const votingOpen = plan.status === "open" && today >= plan.ends_on;

        res.send(
          await page(
            req,
            `${plan.kind} · ${plan.employment.person.full_name}`,
            `${crumbs([
              { href: "/performance", label: "Performance" },
              { href: `/performance/${plan.cycle_id}`, label: cycle.name },
              { label: plan.kind },
            ])}
          ${pageHeader(
            `${plan.kind === "pip" ? "Performance Improvement Plan" : "Observation"} · ${plan.employment.person.full_name}`,
            `Status ${plan.status}${plan.result ? ` · ${plan.result}` : ""} · ${plan.starts_on} → ${plan.ends_on}`
          )}
          <div class="card">
            <dl class="kv">
              <dt>Objectives</dt><dd>${escapeHtml(plan.objectives)}</dd>
              <dt>Success metrics</dt><dd>${escapeHtml(plan.success_metrics)}</dd>
              <dt>Support</dt><dd>${escapeHtml(plan.support || "—")}</dd>
            </dl>
          </div>
          <div class="section-label">Notes</div>
          ${
            plan.notes.length
              ? `<div class="list">${plan.notes
                  .map(
                    (n) => `<div class="list-row"><div>
                      <div class="title">${escapeHtml(n.kind)}${n.late ? " · late" : ""}</div>
                      <div class="meta">${escapeHtml(n.author.full_name)} · ${escapeHtml(n.created_at.slice(0, 10))}</div>
                      <div class="meta">${escapeHtml(n.body)}</div>
                    </div></div>`
                  )
                  .join("")}</div>`
              : emptyState("No notes yet.")
          }
          ${
            isSubject && plan.status === "open"
              ? `<div class="card">
                  <div class="card-head"><h2>Post a note</h2></div>
                  <form method="post" action="/plans/${plan.id}/notes">
                    <div class="field"><label>Kind</label>
                      <select name="kind">
                        <option value="formal_concern_reply">Formal concern reply</option>
                        <option value="check_in">Check-in</option>
                      </select>
                    </div>
                    <div class="field"><label>Body</label><textarea name="body" required></textarea></div>
                    <div class="form-actions"><button type="submit">Save note</button></div>
                  </form>
                </div>`
              : ""
          }
          ${
            canVote && plan.kind === "pip" && plan.status === "open" && !plan.extended_once
              ? `<form class="card" method="post" action="/plans/${plan.id}/extend">
                  <div class="card-head"><h2>Extend PIP</h2></div>
                  <p class="hint">One extension, max ${policy.escalation.pip_extension_max_days} days.</p>
                  <div class="field"><label>Extra days</label><input name="extra_days" type="number" min="1" max="${policy.escalation.pip_extension_max_days}" value="${policy.escalation.pip_extension_max_days}" required /></div>
                  <div class="form-actions"><button type="submit">Extend</button></div>
                </form>`
              : ""
          }
          ${
            canVote && votingOpen
              ? `<form class="card" method="post" action="/plans/${plan.id}/vote">
                  <div class="card-head"><h2>Director determination</h2></div>
                  ${
                    plan.kind === "pip"
                      ? `<div class="choice"><label><input type="radio" name="decision" value="pass" checked /><span>Pass</span></label></div>
                         <div class="choice"><label><input type="radio" name="decision" value="fail" /><span>Fail</span></label></div>`
                      : `<div class="choice"><label><input type="radio" name="decision" value="met" checked /><span>Met</span></label></div>
                         <div class="choice"><label><input type="radio" name="decision" value="not_met" /><span>Not met</span></label></div>`
                  }
                  <div class="form-actions"><button type="submit">Submit</button></div>
                </form>`
              : ""
          }
          ${
            plan.ballots.length
              ? `<div class="card"><div class="card-head"><h2>Ballots</h2></div><ul>${plan.ballots
                  .map((b) => `<li>${escapeHtml(b.voter.full_name)} · ${escapeHtml(b.decision)}</li>`)
                  .join("")}</ul></div>`
              : ""
          }
          ${
            plan.bad_leaver_open && canVote
              ? `<form class="card" method="post" action="/plans/${plan.id}/bad-leaver">
                  <div class="card-head"><h2>Bad-leaver vote</h2></div>
                  ${callout("Schedule G repurchase math stays in the agreement. This records the determination only.")}
                  <div class="choice"><label><input type="radio" name="decision" value="yes" /><span>Yes — bad leaver</span></label></div>
                  <div class="choice"><label><input type="radio" name="decision" value="no" checked /><span>No</span></label></div>
                  <div class="form-actions"><button type="submit">Submit</button></div>
                </form>`
              : ""
          }
          ${
            plan.badLeaverBallots.length
              ? `<div class="card"><div class="card-head"><h2>Bad-leaver ballots</h2></div><ul>${plan.badLeaverBallots
                  .map((b) => `<li>${escapeHtml(b.voter.full_name)} · ${escapeHtml(b.decision)}</li>`)
                  .join("")}</ul></div>`
              : ""
          }`
          )
        );
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/plans/:id/notes",
    route(async (req, res) => {
      try {
        const kind = String(req.body.kind || "");
        if (kind !== "formal_concern_reply" && kind !== "check_in") {
          throw Object.assign(new Error("Invalid note kind"), { status: 400 });
        }
        await addPlanNote({
          actorId: req.person!.id,
          planId: req.params.id,
          kind,
          body: String(req.body.body || ""),
        });
        res.redirect(`/plans/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/plans/:id/extend",
    route(async (req, res) => {
      try {
        await extendPip({
          actorId: req.person!.id,
          planId: req.params.id,
          extraDays: Number(req.body.extra_days || 0),
        });
        res.redirect(`/plans/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/plans/:id/vote",
    route(async (req, res) => {
      try {
        await castPlanBallot({
          actorId: req.person!.id,
          planId: req.params.id,
          decision: String(req.body.decision || ""),
        });
        res.redirect(`/plans/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  app.post(
    "/plans/:id/bad-leaver",
    route(async (req, res) => {
      try {
        const decision = String(req.body.decision || "");
        if (decision !== "yes" && decision !== "no") {
          throw Object.assign(new Error("Choose yes or no"), { status: 400 });
        }
        await castBadLeaverBallot({
          actorId: req.person!.id,
          planId: req.params.id,
          decision,
        });
        res.redirect(`/plans/${req.params.id}`);
      } catch (e) {
        const err = e as Error & { status?: number };
        res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
      }
    })
  );

  // Evidence upload uses multipart; registered separately so callers can attach middleware.
  app.post(
    "/performance/:cycleId/initiative/:initiativeId/status",
    singleFileUpload("evidence_file", EVIDENCE_MAX_BYTES),
    route(async (req, res) => {
      if (!(await can(req.person!.id, "initiative.write_own"))) {
        res.status(403).send("Forbidden");
        return;
      }
      const { employmentForPerson } = await import("../services/reviewService.js");
      const emp = await employmentForPerson(req.person!.id);
      const ini = await prisma.initiative.findUniqueOrThrow({
        where: { id: req.params.initiativeId },
        select: { employment_id: true, cycle_id: true },
      });
      if (!emp || ini.employment_id !== emp.id || ini.cycle_id !== req.params.cycleId) {
        res.status(403).send("Forbidden");
        return;
      }
      const status = String(req.body.status || "");
      if (!isInitiativeStatus(status)) {
        res.status(400).send(await page(req, "Error", `<p class="err">Choose a status: Not started, In progress, Blocked or Done.</p>`));
        return;
      }
      const evidenceRef = String(req.body.evidence_ref || "").trim();
      await prisma.initiative.update({
        where: { id: req.params.initiativeId },
        data: {
          evidence_ref: evidenceRef || null,
          status,
        },
      });
      await prisma.initiativeStatusUpdate.create({
        data: {
          id: `stu_${Date.now()}`,
          initiative_id: req.params.initiativeId,
          author_id: req.person!.id,
          status,
          note: String(req.body.note || ""),
          created_at: new Date().toISOString(),
        },
      });
      const file = req.uploadedFile;
      if (file && file.size > 0 && file.originalname) {
        await saveEvidenceFile({
          initiativeId: req.params.initiativeId,
          uploaderId: req.person!.id,
          originalName: file.originalname,
          mime: file.mimetype,
          sizeBytes: file.size,
          buffer: file.buffer,
        });
      }
      res.redirect(
        `/performance/${req.params.cycleId}/self?saved=${encodeURIComponent(req.params.initiativeId)}#ini-${encodeURIComponent(req.params.initiativeId)}`
      );
    })
  );
}
