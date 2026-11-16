import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate, prisma } from "./db.js";
import { layout, pageHeader, crumbs, statusPill, emptyState, callout, avatar, authLoginBody, authForgotBody, authResetBody } from "./views.js";
import {
  login,
  logout,
  requireAuth,
  requireApiPerm,
  createPasswordResetToken,
  validatePasswordResetToken,
  consumePasswordResetToken,
  MIN_PASSWORD_LENGTH,
} from "./auth.js";
import { sendPasswordResetEmail } from "./services/emailService.js";
import { can, personPermissionKeys, syncRolePermissions } from "./rbac.js";
import { escapeHtml, formatDay } from "./util.js";
import {
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABEL,
  INITIATIVE_STATUS_TONE,
  normalizeInitiativeStatus,
  type InitiativeStatus,
} from "./initiativeStatus.js";

function initiativeStatusPill(status: InitiativeStatus) {
  return statusPill(INITIATIVE_STATUS_LABEL[status], INITIATIVE_STATUS_TONE[status]);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type RouteFn = (req: express.Request, res: express.Response) => void | Promise<void>;

function route(fn: RouteFn): express.RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res)).catch(next);
  };
}
import { getActivePolicy, createPolicyVersion } from "./services/policyService.js";
import {
  listCycles,
  getCycle,
  subjectEmployments,
  employmentForPerson,
  submitSealedSheet,
  openSheetsForSubject,
  castBallot,
  listBallots,
  publishRatings,
  disinterestedDirectors,
  requiredMajority,
  policyForCycle,
  allSubjectsVoted,
  getMemoForViewer,
  voteFailedCanRescore,
} from "./services/reviewService.js";
import {
  buildDecisionBoard,
  deriveOverallFromDimensions,
} from "./services/deriveScores.js";
import { confirmScheduleA, issueVestingForCycle } from "./services/equityService.js";
import { ensureEvidenceDir, listEvidenceFiles } from "./services/evidenceService.js";
import { listAffiliatesForPerson } from "./services/peopleService.js";
import { registerQuarterExtras } from "./routes/quarterExtras.js";
import {
  CASH_CALL_CURRENCIES,
  closeCompanyAccount,
  commitCashCall,
  commitCloseCompanyAccount,
  commitCompanyAccount,
  createCompanyAccount,
  formatMoney,
  getCashCall,
  issueCashCall,
  listCashCalls,
  listCompanyAccounts,
  outstandingByCurrency,
  parseMoney,
  recordCashCallPayment,
} from "./services/financeService.js";
import {
  HRIS_APPROVAL_ACTIONS,
  submitWorkforceApproval,
  workforceApprovalsEnabled,
} from "./services/workforceApprovals.js";
import {
  WORKFORCE_SSO_NEXT_COOKIE,
  WORKFORCE_SSO_STATE_COOKIE,
  WORKFORCE_TOKEN_COOKIE,
  buildPlatformLoginRedirect,
  canShowApprovalsNav,
  decodeWorkforcePermissions,
  exchangeSsoCode,
  gatewayPublicUrl,
  isWorkforceTokenFresh,
  newSsoState,
  workforceSsoConfigured,
} from "./services/workforceSession.js";
import {
  cycleDeadlines,
  listNotifications,
  markAllRead,
  markNotificationRead,
  syncTaskNotifications,
  unreadCount,
} from "./services/notificationService.js";
import {
  clearScoreDraft,
  getScoreDraft,
  hasSealedSheet,
  parseDraftBody,
  saveScoreDraft,
  type ScoreDraftBody,
} from "./services/scoreDraft.js";
import { PolicyBodySchema } from "./policy.js";
import { SCHEDULE_A, SCHEDULE_A_FIRST_VESTING_DATE, SCHEDULE_A_FOUNDER_OUTSTANDING } from "./scheduleA.js";
import { mintHrisNaiAssertion, naiServiceUrl } from "./nai/mintAssertion.js";
import { registerNaiReadRoutes } from "./nai/reads.js";
import { selectionFromPath } from "./nai/selection.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));
ensureEvidenceDir();

registerNaiReadRoutes(app, route);

async function page(req: express.Request, title: string, body: string) {
  if (!req.person) return layout(null, title, body, req.path);
  const unread = await unreadCount(req.person.id);
  const recent = (await listNotifications(req.person.id, 8)).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    due_on: n.due_on,
    read_at: n.read_at,
  }));
  const workforceToken = req.cookies?.[WORKFORCE_TOKEN_COOKIE] as string | undefined;
  const showApprovals =
    workforceSsoConfigured() ||
    canShowApprovalsNav(decodeWorkforcePermissions(workforceToken));
  const naiAssertion = await mintHrisNaiAssertion({
    personId: req.person.id,
    fullName: req.person.full_name,
  });
  return layout(req.person, title, body, req.path, {
    unreadNotifications: unread,
    recentNotifications: recent,
    showApprovals,
    naiAssertion,
    naiServiceUrl: naiServiceUrl(),
    naiSelection: selectionFromPath(req.path),
  });
}

function beginWorkforceSso(res: express.Response, nextPath: string) {
  const state = newSsoState();
  res.cookie(WORKFORCE_SSO_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax" });
  res.cookie(WORKFORCE_SSO_NEXT_COOKIE, nextPath, { httpOnly: true, sameSite: "lax" });
  res.redirect(buildPlatformLoginRedirect({ state }));
}

app.get("/login", route(async (req, res) => {
  const notice = String(req.query.reset || "") === "1" ? "Password updated. Sign in with your new password." : undefined;
  res.send(layout(null, "Sign In", authLoginBody({ notice }), "/login"));
}));

// ── Password reset ──────────────────────────────────────────────────────────
// Per-email throttle so the form can't be used to spam someone's inbox.
const RESET_REQUEST_COOLDOWN_MS = 60_000;
const lastResetRequest = new Map<string, number>();

function publicBaseUrl(req: express.Request) {
  const configured = process.env.HRIS_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

app.get("/forgot-password", route(async (_req, res) => {
  res.send(layout(null, "Reset password", authForgotBody(), "/forgot-password"));
}));

app.post("/forgot-password", route(async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email) {
    res.status(400).send(layout(null, "Reset password", authForgotBody({ error: "Enter your email." }), "/forgot-password"));
    return;
  }
  const key = email.toLowerCase();
  const now = Date.now();
  const last = lastResetRequest.get(key) ?? 0;
  if (now - last >= RESET_REQUEST_COOLDOWN_MS) {
    lastResetRequest.set(key, now);
    const created = await createPasswordResetToken(email);
    if (created) {
      const resetUrl = `${publicBaseUrl(req)}/reset-password?token=${encodeURIComponent(created.token)}`;
      // Don't await: response time must not reveal whether the account exists.
      void sendPasswordResetEmail(created.person.email, created.person.full_name, resetUrl).catch((err) =>
        console.error("[password-reset] email send failed:", err)
      );
    }
  }
  // Same response whether or not the account exists.
  res.send(layout(null, "Check your email", authForgotBody({ sent: true }), "/forgot-password"));
}));

app.get("/reset-password", route(async (req, res) => {
  const token = String(req.query.token || "");
  const valid = await validatePasswordResetToken(token);
  res.status(valid ? 200 : 400).send(
    layout(null, "Reset password", authResetBody({ token, invalid: !valid, minLength: MIN_PASSWORD_LENGTH }), "/reset-password")
  );
}));

app.post("/reset-password", route(async (req, res) => {
  const token = String(req.body.token || "");
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");
  const fail = (error: string) =>
    res.status(400).send(
      layout(null, "Reset password", authResetBody({ token, error, minLength: MIN_PASSWORD_LENGTH }), "/reset-password")
    );
  if (password.length < MIN_PASSWORD_LENGTH) return void fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password !== confirm) return void fail("Passwords don't match.");
  const ok = await consumePasswordResetToken(token, password);
  if (!ok) {
    res.status(400).send(
      layout(null, "Reset password", authResetBody({ token, invalid: true, minLength: MIN_PASSWORD_LENGTH }), "/reset-password")
    );
    return;
  }
  res.clearCookie("hris_session");
  res.redirect("/login?reset=1");
}));

app.post("/login", route(async (req, res) => {
  const email = String(req.body.email || "");
  const result = await login(email, String(req.body.password || ""));
  if (!result) {
    res.status(401).send(
      layout(
        null,
        "Sign in",
        authLoginBody({ error: "The sign-in information is incorrect.", email }),
        "/login"
      )
    );
    return;
  }
  res.cookie("hris_session", result.token, { httpOnly: true, sameSite: "lax" });
  res.redirect("/");
}));

app.get("/logout", route(async (req, res) => {
  const token = req.cookies?.hris_session as string | undefined;
  if (token) await logout(token);
  res.clearCookie("hris_session");
  res.clearCookie(WORKFORCE_TOKEN_COOKIE);
  res.clearCookie(WORKFORCE_SSO_STATE_COOKIE);
  res.clearCookie(WORKFORCE_SSO_NEXT_COOKIE);
  res.redirect("/login");
}));

app.use(requireAuth);

app.get(
  "/api/nai/assertion",
  route(async (req, res) => {
    if (!req.person) {
      res.status(401).json({ ok: false });
      return;
    }
    const token = await mintHrisNaiAssertion({
      personId: req.person.id,
      fullName: req.person.full_name,
    });
    if (!token) {
      res.status(503).json({ ok: false });
      return;
    }
    res.json({ token, applicationId: "hris" });
  })
);

app.use((req, _res, next) => {
  if (req.person) void syncTaskNotifications(req.person.id).then(() => next()).catch(next);
  else next();
});

app.get("/", route(async (req, res) => {
  const cycles = await listCycles();
  const openCycle = cycles.find((c) => c.status !== "vesting_closed") ?? cycles[0];
  const tasks = await syncTaskNotifications(req.person!.id);
  const openTasks = tasks.filter((t) => !t.done);
  const primary = openTasks[0];
  // One row for all mid-quarter notes instead of one per task.
  const midTasks = tasks.filter((t) => t.kind === "mid_quarter");
  const midOpen = midTasks.filter((t) => !t.done);
  const taskRows: Array<{ title: string; body: string; href: string; dueOn: string; overdue: boolean }> = [];
  let midAdded = false;
  for (const t of openTasks) {
    if (t.kind !== "mid_quarter") {
      taskRows.push(t);
      continue;
    }
    if (midAdded) continue;
    midAdded = true;
    taskRows.push({
      title: "Post mid-quarter status notes",
      body: `${midTasks.length - midOpen.length} of ${midTasks.length} tasks have a status note. Add a one-line note on each.`,
      href: t.href,
      dueOn: t.dueOn,
      overdue: midOpen.some((m) => m.overdue),
    });
  }
  const nextDue = taskRows.map((t) => t.dueOn).filter(Boolean).sort()[0];
  const deadlines = openCycle ? await cycleDeadlines(openCycle) : null;
  const showFinance = await can(req.person!.id, "finance.read");
  const openFinance = showFinance ? await outstandingByCurrency(req.person!.id) : [];
  const financeMeta =
    openFinance.length > 0
      ? `${openFinance.map((row) => formatMoney(row.cents, row.currency)).join(" · ")} open on cash calls`
      : "Cash calls";
  res.send(
    await page(
      req,
      "Home",
      `${pageHeader(
        `Hi, ${req.person!.full_name.split(/\s+/)[0]}`,
        primary
          ? primary.kind === "evidence" || primary.kind === "self_assessment"
            ? "You upload evidence first. Directors score only what you post."
            : "Your open review tasks are below, with due dates."
          : "No open personal tasks. Review calendar and equity are current.",
        primary
          ? `<a class="btn" href="${primary.href}">${escapeHtml(
              primary.kind === "evidence" || primary.kind === "self_assessment" ? "Upload my evidence" : primary.title
            )}</a>`
          : openCycle
            ? `<a class="btn" href="/performance/${openCycle.id}">Open cycle</a>`
            : `<a class="btn" href="/performance">Open Performance</a>`
      )}
      ${
        primary && (primary.kind === "evidence" || primary.kind === "self_assessment")
          ? callout(
              `Action required: go to My evidence, attach links for each initiative, and submit your self-assessment. Due ${formatDay(primary.dueOn)}${
                primary.overdue ? " (overdue)" : ""
              }.`
            )
          : ""
      }
      <div class="row">
        <div class="stat"><div class="label">Open tasks</div><strong>${taskRows.length}</strong></div>
        <div class="stat"><div class="label">Next due</div><strong>${escapeHtml(nextDue ? formatDay(nextDue) : "—")}</strong></div>
      </div>
      <div class="section-label">Your tasks</div>
      ${
        taskRows.length
          ? `<div class="list">${taskRows
              .map(
                (t) => `<a class="list-row" href="${t.href}" style="color:inherit;text-decoration:none">
                  <div>
                    <div class="title">${escapeHtml(t.title)}</div>
                    <div class="meta">${escapeHtml(t.body)}</div>
                  </div>
                  <div class="aside">
                    ${t.overdue ? statusPill("Overdue", "bad") : statusPill("Due", "warn")}
                    <span class="task-due${t.overdue ? " overdue" : ""}">${escapeHtml(formatDay(t.dueOn))}</span>
                  </div>
                </a>`
              )
              .join("")}</div>`
          : emptyState("You’re caught up on personal tasks.")
      }
      ${
        deadlines && openCycle
          ? `<div class="section-label">Cycle deadlines · ${escapeHtml(openCycle.name)}</div>
            <div class="row">
              <div class="stat"><div class="label">Evidence due</div><strong>${escapeHtml(formatDay(deadlines.evidenceDueOn))}</strong></div>
              <div class="stat"><div class="label">Self-assessment due</div><strong>${escapeHtml(formatDay(deadlines.selfAssessmentDueOn))}</strong></div>
              <div class="stat"><div class="label">Scores due</div><strong>${escapeHtml(formatDay(deadlines.scoresDueOn))}</strong></div>
              <div class="stat"><div class="label">Votes due</div><strong>${escapeHtml(formatDay(deadlines.votesDueOn))}</strong></div>
              <div class="stat"><div class="label">Vesting date</div><strong>${escapeHtml(formatDay(deadlines.vestingDate))}</strong></div>
            </div>`
          : ""
      }
      <div class="section-label">Also</div>
      <div class="list">
        <div class="list-row">
          <div><div class="title">Equity ledger</div><div class="meta">Schedule A locked · ${SCHEDULE_A_FOUNDER_OUTSTANDING} founder shares · first service vest ${escapeHtml(formatDay(SCHEDULE_A_FIRST_VESTING_DATE))}</div></div>
          <div class="aside"><a class="btn secondary" href="/equity">Open Equity</a></div>
        </div>
        ${
          showFinance
            ? `<div class="list-row">
                <div><div class="title">Finance</div><div class="meta">${escapeHtml(financeMeta)}</div></div>
                <div class="aside"><a class="btn secondary" href="/finance">Open Finance</a></div>
              </div>`
            : ""
        }
      </div>`
    )
  );
}));

app.post("/notifications/read-all", route(async (req, res) => {
  await markAllRead(req.person!.id);
  const back = String(req.get("referer") || "/");
  res.redirect(back.startsWith("http") ? new URL(back).pathname || "/" : back || "/");
}));

app.get("/notifications/:id/open", route(async (req, res) => {
  const row = await prisma.notification.findFirst({
    where: { id: req.params.id, person_id: req.person!.id },
    select: { href: true },
  });
  if (!row) {
    res.status(404).send(await page(req, "Not found", "Notification not found"));
    return;
  }
  await markNotificationRead(req.person!.id, req.params.id);
  res.redirect(row.href);
}));

app.get("/people", route(async (req, res) => {
  if (!(await can(req.person!.id, "people.read"))) {
    res.status(403).send(await page(req, "Forbidden", `<p class="err">Missing people.read</p>`));
    return;
  }
  const canWrite = await can(req.person!.id, "people.write");
  const people = await prisma.person.findMany({
    orderBy: { full_name: "asc" },
    include: {
      employment: true,
      roles: { include: { role: { select: { key: true } } } },
    },
  });
  const rows = people.map((p) => ({
    ...p,
    title: p.employment?.title ?? null,
    category: p.employment?.category ?? null,
    subject_to_founder_review: p.employment?.subject_to_founder_review ?? null,
    roles: p.roles.map((pr) => pr.role.key).join(", "),
  })) as Array<Record<string, unknown>>;
  res.send(
    await page(
      req,
      "People",
      `${pageHeader("People", "Founders, directors, and their employment records.")}
      ${
        canWrite
          ? `<div class="card">
              <div class="card-head"><h2>Add person</h2></div>
              <form method="post" action="/people">
                <div class="field-grid">
                  <div class="field"><label>Full name</label><input name="full_name" required /></div>
                  <div class="field"><label>Email</label><input name="email" type="email" required /></div>
                  <div class="field"><label>Initial password</label><input name="password" type="password" required minlength="8" /></div>
                  <div class="field"><label>Flags</label>
                    <label><input type="checkbox" name="is_director" value="1" /> Director</label>
                    <label><input type="checkbox" name="is_founder" value="1" /> Founder</label>
                  </div>
                </div>
                <div class="form-actions"><button type="submit">Create person</button></div>
              </form>
            </div>`
          : ""
      }
      ${
        rows.length === 0
          ? emptyState("No people yet.")
          : `<div class="list">${rows
              .map((r) => {
                const roles = String(r.roles ?? "")
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean);
                return `<a class="list-row" href="/people/${r.id}" style="color:inherit;text-decoration:none">
                  <div class="person-chip">
                    ${avatar(String(r.full_name))}
                    <div>
                      <div class="title">${escapeHtml(String(r.full_name))}</div>
                      <div class="meta">${escapeHtml(String(r.title ?? "No title"))}${r.category ? ` · ${escapeHtml(String(r.category))}` : ""}</div>
                    </div>
                  </div>
                  <div class="aside">
                    ${r.subject_to_founder_review ? statusPill("In review cycle", "ok") : statusPill("Director", "neutral")}
                    ${roles.slice(0, 2).map((role) => statusPill(role, "neutral")).join("")}
                  </div>
                </a>`;
              })
              .join("")}</div>`
      }`
    )
  );
}));

app.get("/people/:id", route(async (req, res) => {
  if (!(await can(req.person!.id, "people.read"))) {
    res.status(403).send(await page(req, "Forbidden", `<p class="err">Forbidden</p>`));
    return;
  }
  const canWrite = await can(req.person!.id, "people.write");
  const person = await prisma.person.findUnique({ where: { id: req.params.id } });
  if (!person) {
    res.status(404).send(await page(req, "Not found", "Person not found"));
    return;
  }
  const emp = await prisma.employment.findUnique({ where: { person_id: req.params.id } });
  const equity = emp
    ? await prisma.equityAccount.findUnique({ where: { employment_id: emp.id } })
    : undefined;
  const memos = emp
    ? await prisma.reviewMemo.findMany({
        where: { employment_id: emp.id },
        orderBy: { created_at: "desc" },
        select: { id: true, cycle_id: true, delivered_at: true },
      })
    : [];
  const plans = emp
    ? await prisma.performancePlan.findMany({
        where: { employment_id: emp.id },
        orderBy: { starts_on: "desc" },
        select: { id: true, kind: true, status: true, result: true, ends_on: true },
      })
    : [];
  const affiliates = await listAffiliatesForPerson(req.params.id);
  const others = await prisma.person.findMany({
    where: { id: { not: req.params.id } },
    orderBy: { full_name: "asc" },
    select: { id: true, full_name: true },
  });
  res.send(
    await page(
      req,
      String(person.full_name),
      `${crumbs([
        { href: "/people", label: "People" },
        { label: String(person.full_name) },
      ])}
      ${pageHeader(String(person.full_name), String(person.email), `<a class="btn secondary" href="/people">Back</a>`)}
      <div class="card">
        <div class="card-head"><h2>Employment</h2>${emp?.subject_to_founder_review ? statusPill("Reviewed founder", "ok") : statusPill("Not in founder review", "neutral")}</div>
        ${
          canWrite
            ? `<form method="post" action="/people/${person.id}/employment">
                <div class="field-grid">
                  <div class="field"><label>Title</label><input name="title" value="${escapeHtml(emp?.title || "")}" required /></div>
                  <div class="field"><label>Category</label><input name="category" value="${escapeHtml(emp?.category || "Operator")}" required /></div>
                  <div class="field"><label>Start date</label><input name="start_date" type="date" value="${escapeHtml(emp?.start_date || "")}" required /></div>
                  <div class="field"><label>Company</label><input name="company" value="${escapeHtml(emp?.company || "Kritly Inc.")}" /></div>
                  <div class="field"><label><input type="checkbox" name="qualifying_service" value="1" ${emp?.qualifying_service !== 0 ? "checked" : ""} /> Qualifying service</label></div>
                  <div class="field"><label><input type="checkbox" name="subject_to_founder_review" value="1" ${emp?.subject_to_founder_review ? "checked" : ""} /> Subject to founder review</label></div>
                </div>
                <div class="form-actions"><button type="submit">Save employment</button></div>
              </form>`
            : emp
              ? `<dl class="kv">
                <dt>Title</dt><dd>${escapeHtml(String(emp.title))}</dd>
                <dt>Category</dt><dd>${escapeHtml(String(emp.category))}</dd>
                <dt>Qualifying Service</dt><dd>${emp.qualifying_service ? "Yes" : "No"}</dd>
                <dt>Start</dt><dd>${escapeHtml(formatDay(String(emp.start_date)))}</dd>
              </dl>`
              : emptyState("No employment record.")
        }
      </div>
      <div class="card">
        <div class="card-head"><h2>Equity</h2>${equity?.schedule_a_confirmed ? statusPill("Schedule A confirmed", "ok") : statusPill("Needs confirmation", "warn")}</div>
        ${
          equity
            ? `<dl class="kv">
                <dt>Certificate / book-entry</dt><dd>${escapeHtml(String(equity.certificate_or_book_entry ?? "—"))}</dd>
                <dt>Vested</dt><dd>${escapeHtml(String(equity.vested_shares))}</dd>
                <dt>Unvested</dt><dd>${escapeHtml(String(equity.unvested_shares))}</dd>
                <dt>Suspension</dt><dd>${equity.vesting_suspended ? statusPill("Suspended", "bad") : statusPill("Active", "ok")}</dd>
              </dl>
              <div class="form-actions no-print"><a class="btn secondary" href="/equity">Manage equity</a></div>`
            : emptyState("No equity account on this employment.")
        }
      </div>
      <div class="section-label">Affiliates (recusal)</div>
      ${
        affiliates.length
          ? `<div class="list">${affiliates
              .map((a) => {
                const other =
                  a.person_id === person.id
                    ? a.related
                    : a.person;
                const relatedId = a.person_id === person.id ? a.related_person_id : a.person_id;
                return `<div class="list-row">
                  <div><div class="title">${escapeHtml(other.full_name)}</div><div class="meta">${escapeHtml(a.relationship)}</div></div>
                  <div class="aside">${
                    canWrite
                      ? `<form method="post" action="/people/${person.id}/affiliates/${relatedId}/delete"><button class="secondary" type="submit">Remove</button></form>`
                      : ""
                  }</div>
                </div>`;
              })
              .join("")}</div>`
          : emptyState("No affiliate pairs.")
      }
      ${
        canWrite
          ? `<form class="card" method="post" action="/people/${person.id}/affiliates">
              <div class="field-grid">
                <div class="field"><label>Related person</label>
                  <select name="related_person_id" required>
                    ${others.map((o) => `<option value="${o.id}">${escapeHtml(o.full_name)}</option>`).join("")}
                  </select>
                </div>
                <div class="field"><label>Relationship</label><input name="relationship" value="family_member" required /></div>
              </div>
              <div class="form-actions"><button type="submit">Add affiliate</button></div>
            </form>`
          : ""
      }
      <div class="section-label">Plans</div>
      ${
        plans.length
          ? `<div class="list">${plans
              .map(
                (p) => `<a class="list-row" href="/plans/${p.id}" style="color:inherit;text-decoration:none">
                  <div><div class="title">${escapeHtml(p.kind)}</div><div class="meta">Ends ${escapeHtml(p.ends_on)}${p.result ? ` · ${escapeHtml(p.result)}` : ""}</div></div>
                  <div class="aside">${statusPill(p.status, p.status === "open" ? "warn" : "ok")}</div>
                </a>`
              )
              .join("")}</div>`
          : emptyState("No observation or PIP plans.")
      }
      <div class="section-label">Performance memos</div>
      ${
        memos.length
          ? `<div class="list">${memos
              .map(
                (m) => `<a class="list-row" href="/memos/${m.id}" style="color:inherit;text-decoration:none">
                  <div><div class="title">Founder Review Memo</div><div class="meta">${m.delivered_at ? `Delivered ${escapeHtml(m.delivered_at.slice(0, 10))}` : "Pending delivery"}</div></div>
                  <div class="aside">${statusPill(m.delivered_at ? "Delivered" : "Draft", m.delivered_at ? "ok" : "warn")}</div>
                </a>`
              )
              .join("")}</div>`
          : emptyState("No memos yet for this person.")
      }`
    )
  );
}));

app.get("/performance", route(async (req, res) => {
  const cycles = await listCycles();
  const canManage = await can(req.person!.id, "cycle.manage");
  res.send(
    await page(
      req,
      "Performance",
      `${pageHeader(
        "Performance",
        "One cycle at a time: assignments, sealed scores, ratings, then vesting.",
        canManage ? `<a class="btn" href="/performance/new">Open a cycle</a>` : ""
      )}
      ${
        cycles.length === 0
          ? emptyState("No review cycles yet.")
          : `<div class="list">${cycles
              .map((c) => {
                const tone = c.ratings_published
                  ? "ok"
                  : c.status === "draft"
                    ? "neutral"
                    : c.status === "open"
                      ? "warn"
                      : "neutral";
                const href =
                  c.status === "draft" || !c.assignment_adopted_at
                    ? `/performance/${c.id}/assignments`
                    : `/performance/${c.id}`;
                return `<a class="list-row" href="${href}" style="color:inherit;text-decoration:none">
                  <div>
                    <div class="title">${escapeHtml(c.name)}</div>
                    <div class="meta">${escapeHtml(c.period_label)}</div>
                    <div class="meta">Review by ${escapeHtml(c.review_deadline)} · Vesting ${escapeHtml(c.vesting_date)}</div>
                  </div>
                  <div class="aside">
                    ${statusPill(c.ratings_published ? "Published" : c.status, tone)}
                    <span class="btn secondary">Open</span>
                  </div>
                </a>`;
              })
              .join("")}</div>`
      }`
    )
  );
}));

registerQuarterExtras(app, { route, page });

app.get("/performance/:cycleId", route(async (req, res) => {
  const cycle = await getCycle(req.params.cycleId);
  if (cycle.status === "draft" || !cycle.assignment_adopted_at) {
    res.redirect(`/performance/${cycle.id}/assignments`);
    return;
  }
  const policy = await policyForCycle(cycle);
  const subjects = await subjectEmployments(cycle.id);
  const votedAll = await allSubjectsVoted(cycle.id);
  const deadlines = await cycleDeadlines(cycle);
  const nextTask = (await syncTaskNotifications(req.person!.id)).find(
    (t) => !t.done && t.href.includes(cycle.id)
  );
  const canRunBoard =
    (await can(req.person!.id, "review.publish")) || (await can(req.person!.id, "equity.manage"));
  const policyRow = await prisma.policyVersion.findUniqueOrThrow({
    where: { id: cycle.policy_version_id },
    select: { version: true },
  });
  const policyVersion = policyRow.version;
  const subjectListHtml = (
    await Promise.all(
      subjects.map(async (s) => {
        const vote = await prisma.reviewVote.findUnique({
          where: {
            cycle_id_subject_employment_id: { cycle_id: cycle.id, subject_employment_id: s.id },
          },
          select: { rating: true, consequence: true },
        });
        const isSelf = s.person_id === req.person!.id;
        const directors = await disinterestedDirectors(s.person_id, policy);
        const sheetCount = await prisma.sealedScoreSheet.count({
          where: { cycle_id: cycle.id, subject_employment_id: s.id },
        });
        const ballots = await listBallots(cycle.id, s.id);
        const mine = ballots.find((b) => b.voter_person_id === req.person!.id);
        const iVote = directors.some((d) => d.id === req.person!.id);
        const ready = directors.length > 0 && sheetCount >= directors.length;
        const allBallotsIn = directors.length > 0 && ballots.length >= directors.length;
        const sealed = iVote && (await hasSealedSheet(cycle.id, s.id, req.person!.id));
        let statusLabel = "In review";
        let tone: "ok" | "warn" | "bad" | "neutral" = "neutral";
        let action = "";
        if (isSelf) {
          if (vote && cycle.ratings_published) {
            statusLabel = `Rating ${vote.rating}`;
            tone = vote.consequence === "pip_trigger" ? "bad" : vote.consequence === "observation" ? "warn" : "ok";
          }
          action = `<a class="btn secondary" href="/performance/${cycle.id}/subject/${s.id}">View</a>`;
        } else if (!iVote) {
          statusLabel = "Recused";
        } else if (vote) {
          statusLabel = cycle.ratings_published ? `Rating ${vote.rating}` : "Adopted";
          tone = vote.consequence === "pip_trigger" ? "bad" : vote.consequence === "observation" ? "warn" : "ok";
          action = `<a class="btn secondary" href="/performance/${cycle.id}/subject/${s.id}/vote">View</a>`;
        } else if (allBallotsIn) {
          statusLabel = "Not adopted";
          tone = "bad";
          action = `<a class="btn secondary" href="/performance/${cycle.id}/subject/${s.id}/vote">View</a>`;
        } else if (mine) {
          statusLabel = "Voted";
          tone = "ok";
          action = `<a class="btn secondary" href="/performance/${cycle.id}/subject/${s.id}/vote">View</a>`;
        } else if (ready) {
          statusLabel = "Your vote";
          tone = "warn";
          action = `<a class="btn" href="/performance/${cycle.id}/subject/${s.id}/vote">Your vote</a>`;
        } else if (!sealed) {
          statusLabel = "Your score";
          tone = "warn";
          action = `<a class="btn" href="/performance/${cycle.id}/subject/${s.id}">Score</a>`;
        } else {
          statusLabel = "Scoring";
          action = `<a class="btn secondary" href="/performance/${cycle.id}/subject/${s.id}">View</a>`;
        }
        return `<div class="list-row">
            <div class="person-chip">
              ${avatar(s.full_name)}
              <div>
                <div class="title">${escapeHtml(s.full_name)}</div>
                <div class="meta">${escapeHtml(s.title)}</div>
              </div>
            </div>
            <div class="aside no-print">
              ${statusPill(statusLabel, tone)}
              ${action}
            </div>
          </div>`;
      })
    )
  ).join("");
  res.send(
    await page(
      req,
      cycle.name,
      `${crumbs([{ href: "/performance", label: "Performance" }, { label: cycle.name }])}
      ${pageHeader(cycle.name, `${cycle.period_label} · vesting ${deadlines.vestingDate}`)}
      ${
        nextTask
          ? `<div class="list" style="margin-bottom:1rem"><a class="list-row" href="${nextTask.href}" style="color:inherit;text-decoration:none">
              <div><div class="title">${escapeHtml(nextTask.title)}</div><div class="meta">${escapeHtml(nextTask.body)}</div></div>
              <div class="aside"><span class="task-due${nextTask.overdue ? " overdue" : ""}">${escapeHtml(nextTask.dueOn)}</span></div>
            </a></div>`
          : ""
      }
      <div class="section-label">Founders under review</div>
      <div class="list">
      ${subjectListHtml}
      </div>
      ${
        canRunBoard
          ? `<details class="details-panel no-print">
              <summary>Cycle details</summary>
              <div class="row" style="margin-top:0.75rem">
                <div class="stat"><div class="label">Evidence</div><strong>${escapeHtml(deadlines.evidenceDueOn)}</strong></div>
                <div class="stat"><div class="label">Self-assessment</div><strong>${escapeHtml(deadlines.selfAssessmentDueOn)}</strong></div>
                <div class="stat"><div class="label">Scores</div><strong>${escapeHtml(deadlines.scoresDueOn)}</strong></div>
                <div class="stat"><div class="label">Votes</div><strong>${escapeHtml(deadlines.votesDueOn)}</strong></div>
                <div class="stat"><div class="label">Vesting</div><strong>${escapeHtml(deadlines.vestingDate)}</strong></div>
              </div>
              <div class="steps">
                <div class="step ${votedAll ? "done" : "current"}"><span class="n">1</span> Score & vote</div>
                <div class="step ${cycle.ratings_published ? "done" : votedAll ? "current" : ""}"><span class="n">2</span> Publish memos</div>
                <div class="step ${cycle.status === "vesting_closed" ? "done" : cycle.ratings_published ? "current" : ""}"><span class="n">3</span> Vesting record</div>
              </div>
              <p class="hint">Policy v${escapeHtml(String(policyVersion))}. Ratings stay hidden until every founder is voted. A values score of 2 or lower caps that sheet at ${policy.values_cap_rating}.</p>
              <div class="page-actions">
                ${(await can(req.person!.id, "review.publish")) ? `<form method="post" action="/performance/${cycle.id}/publish"><button type="submit" ${votedAll ? "" : "disabled title=\"All votes required\""}>Publish ratings & memos</button></form>` : ""}
                ${(await can(req.person!.id, "equity.manage")) ? `<form method="post" action="/performance/${cycle.id}/vest"><button class="secondary" type="submit" ${cycle.ratings_published ? "" : "disabled"}>Issue vesting / holds</button></form>` : ""}
              </div>
            </details>`
          : ""
      }`
    )
  );
}));

function evidenceLinkHtml(ref: string | null | undefined) {
  const raw = String(ref || "").trim();
  if (!raw) return `<span class="muted">—</span>`;
  const safe = escapeHtml(raw);
  if (/^https?:\/\//i.test(raw)) {
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
  }
  return `<code>${safe}</code>`;
}

app.get("/performance/:cycleId/self", route(async (req, res) => {
  if (!(await can(req.person!.id, "initiative.write_own"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const cycle = await getCycle(req.params.cycleId);
  const emp = await employmentForPerson(req.person!.id);
  if (!emp) {
    res.status(400).send(await page(req, "No employment", "No employment"));
    return;
  }
  const initiatives = (await prisma.initiative.findMany({
    where: { cycle_id: cycle.id, employment_id: emp.id },
  })) as Array<Record<string, unknown>>;
  const selfRow = await prisma.selfAssessment.findUnique({
    where: { cycle_id_employment_id: { cycle_id: cycle.id, employment_id: emp.id } },
    select: { body_json: true, created_at: true },
  });
  let selfBody: { notes?: string; evidence_links?: string[] } = {};
  try {
    if (selfRow) selfBody = JSON.parse(selfRow.body_json) as typeof selfBody;
  } catch {
    /* ignore */
  }
  const selfDeadlines = await cycleDeadlines(cycle);
  const filesByIni = new Map<string, Awaited<ReturnType<typeof listEvidenceFiles>>>();
  for (const i of initiatives) {
    filesByIni.set(String(i.id), await listEvidenceFiles(String(i.id)));
  }
  res.send(
    await page(
      req,
      "My evidence",
      `${crumbs([
        { href: "/performance", label: "Performance" },
        { href: `/performance/${cycle.id}`, label: cycle.name },
        { label: "My evidence" },
      ])}
      ${pageHeader(
        "My evidence",
        `Add evidence for each task, then submit your self-assessment. Evidence due ${formatDay(selfDeadlines.evidenceDueOn)} · self-assessment due ${formatDay(selfDeadlines.selfAssessmentDueOn)}.`,
        `<a class="btn secondary" href="/performance/${cycle.id}">Back to cycle</a>`
      )}
      ${callout("Directors score only what you post here. A link or a file counts as evidence.")}
      ${(() => {
        const withEvidence = initiatives.filter(
          (i) => String(i.evidence_ref ?? "").trim() || (filesByIni.get(String(i.id)) || []).length
        ).length;
        const pct = initiatives.length ? Math.round((withEvidence / initiatives.length) * 100) : 0;
        return `<div class="progress-line">
          <strong>${withEvidence} of ${initiatives.length} tasks have evidence</strong>
          <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${initiatives.length}" aria-valuenow="${withEvidence}"><span style="width:${pct}%"></span></div>
        </div>`;
      })()}
      ${initiatives
        .map((i) => {
          const files = filesByIni.get(String(i.id)) || [];
          const status = normalizeInitiativeStatus(i.status);
          const hasEvidence = Boolean(String(i.evidence_ref ?? "").trim() || files.length);
          const justSaved = String(req.query.saved || "") === String(i.id);
          return `<details class="card task-card" id="ini-${escapeHtml(String(i.id))}"${justSaved ? " open" : ""}>
            <summary>
              <div class="task-summary">
                <h2>${escapeHtml(String(i.title))}</h2>
                <p class="hint">${escapeHtml(String(i.success_criteria))}</p>
                <div class="task-pills">
                  ${initiativeStatusPill(status)}
                  ${hasEvidence ? statusPill("Evidence added", "ok") : statusPill("No evidence yet", "neutral")}
                  ${justSaved ? statusPill("Saved", "ok") : ""}
                </div>
              </div>
            </summary>
            <div class="task-body">
            <form method="post" action="/performance/${cycle.id}/initiative/${i.id}/status" enctype="multipart/form-data">
              ${
                files.length
                  ? `<ul class="hint" style="margin-bottom:0.75rem">${files
                      .map(
                        (f) =>
                          `<li><a href="/evidence/${f.id}" target="_blank" rel="noopener">${escapeHtml(f.original_name)}</a></li>`
                      )
                      .join("")}</ul>`
                  : ""
              }
              <div class="field-grid">
                <div class="field"><label>Status</label>
                  <select name="status">
                    ${INITIATIVE_STATUSES.map(
                      (s) => `<option value="${s}" ${status === s ? "selected" : ""}>${INITIATIVE_STATUS_LABEL[s]}</option>`
                    ).join("")}
                  </select>
                </div>
                <div class="field"><label>Evidence link or path</label><input name="evidence_ref" value="${escapeHtml(String(i.evidence_ref ?? ""))}" placeholder="repo path, doc, or URL" /></div>
                <div class="field span-2"><label>Or upload a file (pdf, png, jpg, docx, txt, md · 15 MB)</label><input type="file" name="evidence_file" /></div>
                <div class="field span-2"><label>One-line note</label><input name="note" required placeholder="What changed and what’s blocked" /></div>
              </div>
              <div class="form-actions"><button type="submit">Save evidence &amp; status</button></div>
            </form>
            </div>
          </details>`;
        })
        .join("")}
      <div class="card">
        <div class="card-head"><h2>Self-assessment</h2>${selfRow ? statusPill("Submitted", "ok") : statusPill("Needed", "warn")}</div>
        <form method="post" action="/performance/${cycle.id}/self">
          <div class="field-grid">
            <div class="field span-2"><label>Summary for directors</label><textarea name="notes" placeholder="What you delivered, what slipped, and why" required>${escapeHtml(selfBody.notes || "")}</textarea></div>
            <div class="field span-2"><label>Evidence links (one per line)</label><textarea name="evidence_links" placeholder="https://...&#10;path/to/doc">${escapeHtml((selfBody.evidence_links || []).join("\n"))}</textarea></div>
          </div>
          <div class="form-actions"><button type="submit">${selfRow ? "Update self-assessment" : "Submit self-assessment"}</button></div>
        </form>
      </div>`
    )
  );
}));

app.post("/performance/:cycleId/self", route(async (req, res) => {
  if (!(await can(req.person!.id, "initiative.write_own"))) {
    res.status(403).send("Forbidden");
    return;
  }
  const emp = await employmentForPerson(req.person!.id);
  if (!emp) {
    res.status(400).send("No employment");
    return;
  }
  const body = {
    notes: String(req.body.notes || ""),
    evidence_links: String(req.body.evidence_links || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  };
  await prisma.selfAssessment.upsert({
    where: { cycle_id_employment_id: { cycle_id: req.params.cycleId, employment_id: emp.id } },
    create: {
      id: `sa_${Date.now()}`,
      cycle_id: req.params.cycleId,
      employment_id: emp.id,
      body_json: JSON.stringify(body),
      created_at: new Date().toISOString(),
    },
    update: { body_json: JSON.stringify(body), created_at: new Date().toISOString() },
  });
  res.redirect(`/performance/${req.params.cycleId}`);
}));

const SEAL_STEPS = [
  { n: 1, key: "packet", label: "Packet" },
  { n: 2, key: "initiatives", label: "Initiatives" },
  { n: 3, key: "delivery", label: "Delivery" },
  { n: 4, key: "dimensions", label: "Dimensions" },
  { n: 5, key: "review", label: "Review" },
] as const;

function wizardChrome(current: number) {
  return `<div class="wizard-steps no-print">${SEAL_STEPS.map((s) => {
    const cls = s.n < current ? "done" : s.n === current ? "current" : "";
    return `<div class="wizard-step ${cls}"><span class="n">${s.n}</span>${escapeHtml(s.label)}</div>`;
  }).join("")}</div>`;
}

async function loadSubjectContext(cycleId: string, employmentId: string) {
  const cycle = await getCycle(cycleId);
  const policy = await policyForCycle(cycle);
  const employment = await prisma.employment.findUniqueOrThrow({
    where: { id: employmentId },
    include: { person: { select: { id: true, full_name: true } } },
  });
  const subject = {
    id: employment.id,
    full_name: employment.person.full_name,
    person_id: employment.person.id,
    title: employment.title,
    category: employment.category,
    qualifying_service: employment.qualifying_service,
    subject_to_founder_review: employment.subject_to_founder_review,
  };
  const initiatives = (await prisma.initiative.findMany({
    where: { cycle_id: cycle.id, employment_id: subject.id },
  })) as Array<
    Record<string, unknown> & {
      id: string;
      title: string;
      company_objective: string;
      success_criteria: string;
      evidence_ref?: string;
    }
  >;
  const selfRow = await prisma.selfAssessment.findUnique({
    where: { cycle_id_employment_id: { cycle_id: cycle.id, employment_id: subject.id } },
    select: { body_json: true, created_at: true },
  });
  let selfBody: { notes?: string; evidence_links?: string[] } = {};
  try {
    if (selfRow) selfBody = JSON.parse(selfRow.body_json) as typeof selfBody;
  } catch {
    /* ignore */
  }
  const updatesByIni = new Map<string, Array<{ status: string; note: string; created_at: string }>>();
  const filesByIni = new Map<string, Awaited<ReturnType<typeof listEvidenceFiles>>>();
  for (const i of initiatives) {
    const rows = await prisma.initiativeStatusUpdate.findMany({
      where: { initiative_id: i.id },
      orderBy: { created_at: "desc" },
      take: 5,
      select: { status: true, note: true, created_at: true },
    });
    updatesByIni.set(i.id, rows);
    filesByIni.set(i.id, await listEvidenceFiles(i.id));
  }
  return { cycle, policy, subject, initiatives, selfRow, selfBody, updatesByIni, filesByIni };
}

function initiativeScoreRadios(name: string, selected?: string) {
  return `<div class="score-choice">${["Done", "Partial", "Miss", "Deferred"]
    .map(
      (s) =>
        `<label><input type="radio" name="${name}" value="${s}" ${selected === s ? "checked" : ""} required /><span>${s}</span></label>`
    )
    .join("")}</div>`;
}

function dimRadios(name: string, selected?: number) {
  return `<div class="dim-scale">${[5, 4, 3, 2, 1]
    .map(
      (n) =>
        `<label><input type="radio" name="${name}" value="${n}" ${selected === n ? "checked" : ""} required /><span>${n}</span></label>`
    )
    .join("")}</div>`;
}

app.get("/performance/:cycleId/subject/:employmentId", route(async (req, res) => {
  const { cycle, policy, subject, initiatives, selfRow, selfBody, updatesByIni } = await loadSubjectContext(
    req.params.cycleId,
    req.params.employmentId
  );
  const canSeal = ((await can(req.person!.id, "score.seal"))) && req.person!.id !== subject.person_id;
  const mayVote =
    (await can(req.person!.id, "review.vote")) &&
    (await disinterestedDirectors(subject.person_id, policy)).some((d) => d.id === req.person!.id);
  const alreadySealed = canSeal && (await hasSealedSheet(cycle.id, subject.id, req.person!.id));
  const draft = canSeal ? await getScoreDraft(cycle.id, subject.id, req.person!.id) : undefined;
  const missingEvidence = initiatives.filter((i) => !String(i.evidence_ref || "").trim());
  res.send(
    await page(
      req,
      subject.full_name,
      `${crumbs([
        { href: "/performance", label: "Performance" },
        { href: `/performance/${cycle.id}`, label: cycle.name },
        { label: subject.full_name },
      ])}
      ${pageHeader(
        subject.full_name,
        "Read the packet, then score in steps: initiatives → delivery → other dimensions → seal. Your accept or decline is a separate vote.",
        `${mayVote ? `<a class="btn" href="/performance/${cycle.id}/subject/${subject.id}/vote">Your vote</a>` : ""}<a class="btn secondary" href="/performance/${cycle.id}">Back</a>`
      )}
      <div class="section-label">Reviewee packet</div>
      ${
        selfRow
          ? `<div class="card">
              <div class="card-head"><h2>Self-assessment</h2><span class="muted">${escapeHtml(selfRow.created_at.slice(0, 10))}</span></div>
              <p>${escapeHtml(selfBody.notes || "").replaceAll("\n", "<br/>")}</p>
              ${
                (selfBody.evidence_links || []).length
                  ? `<div class="section-label" style="margin-top:1rem">Evidence links</div>
                    <ul>${(selfBody.evidence_links || []).map((l) => `<li>${evidenceLinkHtml(l)}</li>`).join("")}</ul>`
                  : `<p class="hint">No extra evidence links on the self-assessment.</p>`
              }
            </div>`
          : callout("No self-assessment yet. Ask the founder to submit one under My evidence before you score.")
      }
      ${missingEvidence.length ? callout(`${missingEvidence.length} initiative(s) still missing evidence from the reviewee.`) : ""}
      <div class="section-label">Initiatives &amp; evidence</div>
      ${initiatives
        .map((i) => {
          const updates = updatesByIni.get(i.id) || [];
          return `<div class="card">
            <div class="card-head"><h2>${escapeHtml(String(i.title))}</h2>${i.final_score ? statusPill(String(i.final_score), String(i.final_score) === "Miss" ? "bad" : "ok") : statusPill("Pending", "neutral")}</div>
            <dl class="kv">
              <dt>Objective</dt><dd>${escapeHtml(String(i.company_objective))}</dd>
              <dt>Success criteria</dt><dd>${escapeHtml(String(i.success_criteria))}</dd>
              <dt>Reported status</dt><dd>${initiativeStatusPill(normalizeInitiativeStatus(i.status))}</dd>
              <dt>Evidence (from reviewee)</dt><dd>${evidenceLinkHtml(i.evidence_ref as string | undefined)}</dd>
            </dl>
            ${
              updates.length
                ? `<div class="section-label" style="margin-top:0.75rem">Recent status notes</div>
                  <ul class="muted">${updates
                    .map(
                      (u) =>
                        `<li>${initiativeStatusPill(normalizeInitiativeStatus(u.status))} ${escapeHtml(u.note)} <span class="muted">(${escapeHtml(u.created_at.slice(0, 10))})</span></li>`
                    )
                    .join("")}</ul>`
                : `<p class="hint">No status updates yet.</p>`
            }
          </div>`;
        })
        .join("")}
      ${
        canSeal
          ? alreadySealed
            ? callout("Your score sheet is already sealed for this person.")
            : `<div class="card">
                <div class="card-head"><h2>Score this founder</h2></div>
                <p class="hint" style="margin-bottom:0.85rem">Guided flow: packet → initiative outcomes → Delivery (from those outcomes) → other dimensions → review &amp; seal.</p>
                <div class="form-actions">
                  <a class="btn" href="/performance/${cycle.id}/subject/${subject.id}/seal?step=${draft?.step && draft.step > 1 ? draft.step : 1}">${
                    draft ? "Continue scoring" : "Start scoring"
                  }</a>
                </div>
              </div>`
          : callout("You cannot seal a score sheet for this person from this account.")
      }`
    )
  );
}));

app.get("/performance/:cycleId/subject/:employmentId/seal", route(async (req, res) => {
  try {
    const step = Math.min(5, Math.max(1, Number(req.query.step || 1) || 1));
    const ctx = await loadSubjectContext(req.params.cycleId, req.params.employmentId);
    const { cycle, policy, subject, initiatives, selfRow, selfBody, updatesByIni, filesByIni } = ctx;
    if (!((await can(req.person!.id, "score.seal"))) || req.person!.id === subject.person_id) {
      res.status(403).send(await page(req, "Forbidden", "You cannot score this person."));
      return;
    }
    if (await hasSealedSheet(cycle.id, subject.id, req.person!.id)) {
      res.redirect(`/performance/${cycle.id}/subject/${subject.id}`);
      return;
    }
    const draftRow = await getScoreDraft(cycle.id, subject.id, req.person!.id);
    const draft = parseDraftBody(draftRow?.body_json);
    const base = `/performance/${cycle.id}/subject/${subject.id}/seal`;
    const subjectBase = `/performance/${cycle.id}/subject/${subject.id}`;

    let bodyHtml = "";
    if (step === 1) {
      const missingEvidence = initiatives.filter(
        (i) => !String(i.evidence_ref || "").trim() && !(filesByIni.get(i.id) || []).length
      );
      bodyHtml = `
        ${callout("Step 1 — Read the packet. You score only against what they posted.")}
        ${
          missingEvidence.length
            ? callout(
                `${missingEvidence.length} initiative(s) have no evidence link or file. You may still score the gap.`
              )
            : ""
        }
        ${
          selfRow
            ? `<div class="card"><div class="card-head"><h2>Self-assessment</h2></div><p>${escapeHtml(selfBody.notes || "").replaceAll("\n", "<br/>")}</p></div>`
            : callout("No self-assessment on file yet.")
        }
        ${initiatives
          .map((i) => {
            const updates = updatesByIni.get(i.id) || [];
            const files = filesByIni.get(i.id) || [];
            return `<div class="card">
              <div class="card-head"><h2>${escapeHtml(i.title)}</h2></div>
              <dl class="kv">
                <dt>Success criteria</dt><dd>${escapeHtml(i.success_criteria)}</dd>
                <dt>Reported status</dt><dd>${initiativeStatusPill(normalizeInitiativeStatus(i.status))}</dd>
                <dt>Evidence</dt><dd>${evidenceLinkHtml(i.evidence_ref)}</dd>
                <dt>Files</dt><dd>${
                  files.length
                    ? files
                        .map((f) => `<a href="/evidence/${f.id}" target="_blank" rel="noopener">${escapeHtml(f.original_name)}</a>`)
                        .join(", ")
                    : "—"
                }</dd>
              </dl>
              ${
                updates[0]
                  ? `<p class="hint" style="margin-top:0.5rem">Latest note: ${escapeHtml(updates[0].note)}</p>`
                  : ""
              }
            </div>`;
          })
          .join("")}
        <form method="post" action="${base}/step/1">
          <div class="form-actions">
            <a class="btn secondary" href="${subjectBase}">Back</a>
            <button type="submit">Continue to initiatives</button>
          </div>
        </form>`;
    } else if (step === 2) {
      bodyHtml = `
        ${callout("Step 2 — Judge each initiative against success criteria and evidence. Delivery (next) is grounded in these outcomes.")}
        <form method="post" action="${base}/step/2">
          ${initiatives
            .map((i) => {
              const prior = draft.initiatives.find((x) => x.initiativeId === i.id);
              return `<div class="card">
                <div class="card-head"><h2>${escapeHtml(i.title)}</h2></div>
                <p class="hint" style="margin-bottom:0.65rem">${escapeHtml(i.success_criteria)}</p>
                <p class="muted" style="margin-bottom:0.75rem">Evidence: ${evidenceLinkHtml(i.evidence_ref)}</p>
                ${initiativeScoreRadios(`score_${i.id}`, prior?.score)}
              </div>`;
            })
            .join("")}
          <div class="form-actions">
            <a class="btn secondary" href="${base}?step=1">Back</a>
            <button type="submit">Continue to Delivery</button>
          </div>
        </form>`;
    } else if (step === 3) {
      const delivery = policy.dimensions.find((d) => d.key === "delivery");
      bodyHtml = `
        ${callout("Step 3 — Delivery is 35% of the overall. Score it from the initiative outcomes you just set — not in isolation.")}
        <div class="card">
          <div class="card-head"><h2>Initiative outcomes</h2></div>
          <ul>${draft.initiatives
            .map((i) => `<li><strong>${escapeHtml(i.title || i.initiativeId)}</strong> · ${escapeHtml(i.score)}</li>`)
            .join("")}</ul>
        </div>
        <form method="post" action="${base}/step/3">
          <div class="card">
            <div class="card-head"><h2>${escapeHtml(delivery?.label || "Delivery")} (${delivery?.weight ?? 35}%)</h2></div>
            <p class="hint" style="margin-bottom:0.75rem">${escapeHtml(delivery?.description || "")}</p>
            ${dimRadios("dim_delivery", draft.dimensionScores.delivery)}
            <div class="field" style="margin-top:0.85rem">
              <label>Note (optional)</label>
              <textarea name="note_delivery" placeholder="How initiative outcomes support this Delivery score">${escapeHtml(
                draft.dimensionNotes.delivery || ""
              )}</textarea>
            </div>
          </div>
          <div class="form-actions">
            <a class="btn secondary" href="${base}?step=2">Back</a>
            <button type="submit">Continue to other dimensions</button>
          </div>
        </form>`;
    } else if (step === 4) {
      const others = policy.dimensions.filter((d) => d.key !== "delivery");
      bodyHtml = `
        ${callout("Step 4 — Score the remaining dimensions. Values is last so the cap is clear.")}
        <form method="post" action="${base}/step/4">
          ${others
            .map(
              (d) => `<div class="card">
                <div class="card-head"><h2>${escapeHtml(d.label)} (${d.weight}%)</h2></div>
                <p class="hint" style="margin-bottom:0.75rem">${escapeHtml(d.description)}</p>
                ${dimRadios(`dim_${d.key}`, draft.dimensionScores[d.key])}
                <div class="field" style="margin-top:0.85rem">
                  <label>Note (optional)</label>
                  <input name="note_${d.key}" value="${escapeHtml(draft.dimensionNotes[d.key] || "")}" placeholder="Optional note" />
                </div>
              </div>`
            )
            .join("")}
          <div class="form-actions">
            <a class="btn secondary" href="${base}?step=3">Back</a>
            <button type="submit">Continue to review</button>
          </div>
        </form>`;
    } else {
      const derived = deriveOverallFromDimensions(draft.dimensionScores, policy);
      bodyHtml = `
        ${callout("Step 5 — Confirm. Overall is derived from weighted dimensions. Sealing locks your sheet until the Board vote.")}
        <div class="derived-preview">
          <div><div class="label muted">Derived overall</div><strong>${derived.rating}</strong></div>
          <div class="muted">Raw ${derived.raw.toFixed(2)}${derived.cappedByValues ? ` · capped by Values at ${policy.values_cap_rating}` : ""}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Initiatives</h2></div>
          <ul>${draft.initiatives
            .map((i) => `<li><strong>${escapeHtml(i.title || "")}</strong> · ${escapeHtml(i.score)}</li>`)
            .join("")}</ul>
        </div>
        <div class="card">
          <div class="card-head"><h2>Dimensions</h2></div>
          <dl class="kv">
            ${policy.dimensions
              .map(
                (d) =>
                  `<dt>${escapeHtml(d.label)}</dt><dd><strong>${draft.dimensionScores[d.key] ?? "—"}</strong>${
                    draft.dimensionNotes[d.key] ? ` · ${escapeHtml(draft.dimensionNotes[d.key])}` : ""
                  }</dd>`
              )
              .join("")}
          </dl>
        </div>
        <form method="post" action="${base}/step/5">
          ${
            derived.rating <= 2
              ? `<div class="card"><div class="field"><label>Missed criterion (required for rating ${derived.rating})</label>
                  <input name="missed_criterion" value="${escapeHtml(draft.missedCriterion)}" required placeholder="Name the gap" /></div></div>`
              : `<input type="hidden" name="missed_criterion" value="${escapeHtml(draft.missedCriterion)}" />`
          }
          <div class="form-actions">
            <a class="btn secondary" href="${base}?step=4">Back</a>
            <button type="submit">Seal score sheet</button>
          </div>
        </form>`;
    }

    res.send(
      await page(
        req,
        `Score · ${subject.full_name}`,
        `${crumbs([
          { href: "/performance", label: "Performance" },
          { href: `/performance/${cycle.id}`, label: cycle.name },
          { href: subjectBase, label: subject.full_name },
          { label: `Step ${step}` },
        ])}
        ${pageHeader(`Score ${subject.full_name}`, `Step ${step} of 5`, `<a class="btn secondary" href="${subjectBase}">Exit</a>`)}
        ${wizardChrome(step)}
        ${bodyHtml}`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/performance/:cycleId/subject/:employmentId/seal/step/:step", route(async (req, res) => {
  try {
    const step = Number(req.params.step);
    const ctx = await loadSubjectContext(req.params.cycleId, req.params.employmentId);
    const { cycle, policy, subject, initiatives } = ctx;
    if (!((await can(req.person!.id, "score.seal"))) || req.person!.id === subject.person_id) {
      res.status(403).send(await page(req, "Forbidden", "Forbidden"));
      return;
    }
    const existing = await getScoreDraft(cycle.id, subject.id, req.person!.id);
    const draft = parseDraftBody(existing?.body_json);
    const base = `/performance/${cycle.id}/subject/${subject.id}/seal`;

    if (step === 1) {
      await saveScoreDraft({
        cycleId: cycle.id,
        subjectEmploymentId: subject.id,
        scorerPersonId: req.person!.id,
        body: draft,
        step: 2,
      });
      res.redirect(`${base}?step=2`);
      return;
    }

    if (step === 2) {
      const next: ScoreDraftBody = {
        ...draft,
        initiatives: initiatives.map((i) => ({
          initiativeId: i.id,
          title: i.title,
          score: String(req.body[`score_${i.id}`] || ""),
          evidence: String(i.evidence_ref || ""),
        })),
      };
      for (const i of next.initiatives) {
        if (!["Done", "Partial", "Miss", "Deferred"].includes(i.score)) {
          throw Object.assign(new Error(`Score required for ${i.title}`), { status: 400 });
        }
      }
      await saveScoreDraft({
        cycleId: cycle.id,
        subjectEmploymentId: subject.id,
        scorerPersonId: req.person!.id,
        body: next,
        step: 3,
      });
      res.redirect(`${base}?step=3`);
      return;
    }

    if (step === 3) {
      const delivery = Number(req.body.dim_delivery);
      if (!Number.isFinite(delivery) || delivery < 1 || delivery > 5) {
        throw Object.assign(new Error("Delivery score 1–5 required"), { status: 400 });
      }
      const next: ScoreDraftBody = {
        ...draft,
        dimensionScores: { ...draft.dimensionScores, delivery },
        dimensionNotes: { ...draft.dimensionNotes, delivery: String(req.body.note_delivery || "") },
      };
      await saveScoreDraft({
        cycleId: cycle.id,
        subjectEmploymentId: subject.id,
        scorerPersonId: req.person!.id,
        body: next,
        step: 4,
      });
      res.redirect(`${base}?step=4`);
      return;
    }

    if (step === 4) {
      const dimensionScores = { ...draft.dimensionScores };
      const dimensionNotes = { ...draft.dimensionNotes };
      for (const dim of policy.dimensions.filter((d) => d.key !== "delivery")) {
        const v = Number(req.body[`dim_${dim.key}`]);
        if (!Number.isFinite(v) || v < 1 || v > 5) {
          throw Object.assign(new Error(`${dim.label} score 1–5 required`), { status: 400 });
        }
        dimensionScores[dim.key] = v;
        dimensionNotes[dim.key] = String(req.body[`note_${dim.key}`] || "");
      }
      await saveScoreDraft({
        cycleId: cycle.id,
        subjectEmploymentId: subject.id,
        scorerPersonId: req.person!.id,
        body: { ...draft, dimensionScores, dimensionNotes },
        step: 5,
      });
      res.redirect(`${base}?step=5`);
      return;
    }

    if (step === 5) {
      const missedCriterion = String(req.body.missed_criterion || "").trim();
      const derived = deriveOverallFromDimensions(draft.dimensionScores, policy);
      if (derived.rating <= 2 && !missedCriterion) {
        throw Object.assign(new Error("Missed criterion required when derived rating is 1 or 2"), { status: 400 });
      }
      for (const dim of policy.dimensions) {
        if (!Number.isFinite(draft.dimensionScores[dim.key])) {
          throw Object.assign(new Error(`Missing dimension score: ${dim.label}`), { status: 400 });
        }
      }
      if (!draft.initiatives.length) {
        throw Object.assign(new Error("Initiative scores missing — go back to step 2"), { status: 400 });
      }
      await submitSealedSheet(req.person!.id, cycle.id, subject.id, {
        initiatives: draft.initiatives,
        dimensionScores: draft.dimensionScores,
        dimensionNotes: draft.dimensionNotes,
        proposedRating: derived.rating,
        missedCriterion,
      });
      await clearScoreDraft(cycle.id, subject.id, req.person!.id);
      res.redirect(`/performance/${cycle.id}/subject/${subject.id}`);
      return;
    }

    res.redirect(`${base}?step=1`);
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/performance/:cycleId/subject/:employmentId/vote", route(async (req, res) => {
  try {
    const cycle = await getCycle(req.params.cycleId);
    const policy = await policyForCycle(cycle);
    const empRow = await prisma.employment.findUniqueOrThrow({
      where: { id: req.params.employmentId },
      include: { person: { select: { id: true, full_name: true } } },
    });
    const subject = {
      id: empRow.id,
      full_name: empRow.person.full_name,
      person_id: empRow.person.id,
    };
    const sheets = await openSheetsForSubject(req.person!.id, cycle.id, subject.id) as Array<{
      scorer_person_id: string;
      scorer_name: string;
      body_json: string;
    }>;
    const disinterested = await disinterestedDirectors(subject.person_id, policy);
    const need = requiredMajority(disinterested.length);
    const board = buildDecisionBoard({
      policy,
      eligible: disinterested,
      sheets,
    });
    const existing = await prisma.reviewVote.findUnique({
      where: {
        cycle_id_subject_employment_id: { cycle_id: cycle.id, subject_employment_id: subject.id },
      },
      select: { rating: true, consequence: true },
    });
    const ballots = await listBallots(cycle.id, subject.id);
    const mine = ballots.find((b) => b.voter_person_id === req.person!.id);
    const acceptCount = ballots.filter((b) => b.decision === "accept").length;
    const eligibleHere = disinterested.some((d) => d.id === req.person!.id);

    res.send(
      await page(
        req,
        `Your vote · ${subject.full_name}`,
        `${crumbs([
          { href: "/performance", label: "Performance" },
          { href: `/performance/${cycle.id}`, label: cycle.name },
          { label: "Your vote" },
        ])}
        ${pageHeader(
          `Your vote · ${subject.full_name}`,
          `Scores are already in. You only say whether you accept the average. It is adopted when ${need} of ${disinterested.length} accept.`,
          `<a class="btn secondary" href="/performance/${cycle.id}">Back to cycle</a>`
        )}
        ${
          existing
            ? callout(`Adopted: rating ${existing.rating} · ${existing.consequence}. ${acceptCount} accepted.`)
            : board.complete
              ? callout(
                  ballots.length >= disinterested.length
                    ? `Everyone has voted. ${acceptCount} accepted and ${ballots.length - acceptCount} declined. The average was not adopted.`
                    : `${acceptCount} of ${need} needed have accepted. ${ballots.length - acceptCount} declined.`
                )
              : callout(`Waiting on sealed scores: ${board.sheetCount} of ${board.eligibleCount}. Voting opens when every score is in.`)
        }
        ${
          !existing &&
          eligibleHere &&
          voteFailedCanRescore({
            eligibleCount: disinterested.length,
            ballotCount: ballots.length,
            acceptCount,
            need,
            alreadyAdopted: false,
          })
            ? `<form class="card no-print" method="post" action="/performance/${cycle.id}/subject/${subject.id}/return-to-scoring">
                ${callout("The average was not adopted. Return this founder to scoring for a fresh seal round.")}
                <div class="form-actions"><button type="submit">Return to scoring</button></div>
              </form>`
            : ""
        }

        <div class="section-label">Decision board</div>
        <div class="card">
          <div class="card-head">
            <h2>Derived average</h2>
            <strong style="font-size:1.5rem">${board.sheetCount ? board.derivedAverageRating : "—"}</strong>
          </div>
          <p class="muted">Raw mean ${board.sheetCount ? board.averageRaw.toFixed(2) : "—"} · rounded ${board.sheetCount ? board.derivedAverageRating : "—"} · values-cap applied if any scorer capped</p>
          ${
            board.perScorer.length
              ? `<div class="table-scroll"><table>
                  <thead><tr><th>Scorer</th><th>Derived</th><th>Raw</th>${policy.dimensions.map((d) => `<th>${escapeHtml(d.label)}</th>`).join("")}<th>Note</th></tr></thead>
                  <tbody>
                    ${board.perScorer
                      .map(
                        (s) => `<tr>
                          <td>${escapeHtml(s.scorerName)}</td>
                          <td><strong>${s.derivedRating}</strong>${s.cappedByValues ? " *" : ""}</td>
                          <td class="muted">${s.derivedRaw.toFixed(2)}</td>
                          ${policy.dimensions.map((d) => `<td>${s.dimensionScores[d.key] ?? "—"}</td>`).join("")}
                          <td class="muted">${escapeHtml(s.missedCriterion || "—")}</td>
                        </tr>`
                      )
                      .join("")}
                    <tr>
                      <td><strong>Board avg</strong></td>
                      <td><strong>${board.derivedAverageRating}</strong></td>
                      <td class="muted">${board.averageRaw.toFixed(2)}</td>
                      ${policy.dimensions.map((d) => `<td>${board.dimensionAverages[d.key] ?? "—"}</td>`).join("")}
                      <td class="muted">${escapeHtml(board.suggestedMissedCriterion || "—")}</td>
                    </tr>
                  </tbody>
                </table></div>
                <p class="hint">* Values score ≤2 capped that scorer’s overall at ${policy.values_cap_rating}.</p>`
              : emptyState("No sealed sheets yet.")
          }
        </div>

        ${
          board.initiativeConsensus.length
            ? `<div class="section-label">Initiative consensus</div>
              <div class="card flush table-scroll">
                <table>
                  <thead><tr><th>Initiative</th><th>Consensus</th><th>Tallies</th></tr></thead>
                  <tbody>
                    ${board.initiativeConsensus
                      .map(
                        (i) => `<tr>
                          <td>${escapeHtml(i.title)}</td>
                          <td>${statusPill(i.score, i.score === "Miss" ? "bad" : i.score === "Done" ? "ok" : "neutral")}</td>
                          <td class="muted">${escapeHtml(
                            Object.entries(i.tallies)
                              .map(([k, v]) => `${k} ${v}`)
                              .join(" · ")
                          )}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : ""
        }

        <div class="section-label">Votes so far</div>
        <div class="card">
          <ul>
            ${disinterested
              .map((d) => {
                const b = ballots.find((x) => x.voter_person_id === d.id);
                const label = !b ? "Not yet" : b.decision === "accept" ? "Accepted" : "Declined";
                return `<li><strong>${escapeHtml(d.full_name)}</strong> · ${label}${d.id === req.person!.id ? " · you" : ""}</li>`;
              })
              .join("")}
          </ul>
        </div>
        ${
          existing || mine || !eligibleHere || !board.complete
            ? mine
              ? callout(`Your vote is recorded: ${mine.decision === "accept" ? "accepted" : "declined"} the average.`)
              : !eligibleHere
                ? callout("You are recused from this vote.")
                : ""
            : `<div class="section-label">Your vote</div>
        <form class="card no-print" method="post" action="/performance/${cycle.id}/subject/${subject.id}/vote">
          <div class="choice">
            <label>
              <input type="radio" name="decision" value="accept" checked required />
              <span>I accept the average · ${board.derivedAverageRating}</span>
            </label>
          </div>
          <div class="choice">
            <label>
              <input type="radio" name="decision" value="decline" required />
              <span>I do not accept the average</span>
            </label>
          </div>
          <div class="form-actions"><button type="submit">Submit my vote</button></div>
        </form>`
        }`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/performance/:cycleId/subject/:employmentId/vote", route(async (req, res) => {
  try {
    const decision = String(req.body.decision || "");
    if (decision !== "accept" && decision !== "decline") {
      throw Object.assign(new Error("Choose accept or decline"), { status: 400 });
    }
    await castBallot({
      actorId: req.person!.id,
      cycleId: req.params.cycleId,
      subjectEmploymentId: req.params.employmentId,
      decision,
    });
    res.redirect(`/performance/${req.params.cycleId}/subject/${req.params.employmentId}/vote`);
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/performance/:cycleId/publish", route(async (req, res) => {
  try {
    await publishRatings(req.person!.id, req.params.cycleId);
    res.redirect(`/performance/${req.params.cycleId}`);
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/performance/:cycleId/vest", route(async (req, res) => {
  try {
    const results = await issueVestingForCycle(req.person!.id, req.params.cycleId);
    const list = results as Array<Record<string, unknown>>;
    res.send(
      await page(
        req,
        "Vesting issued",
        `${pageHeader("Vesting run complete", "Ledger updates or holds for this cycle.", `<a class="btn" href="/equity">Open Equity</a>`)}
        <div class="list">${list
          .map(
            (r) => `<div class="list-row">
              <div>
                <div class="title">${escapeHtml(String(r.person))}</div>
                <div class="meta">${r.status === "issued" ? `+${r.tranche} vested · total ${r.vestedTotal} · unvested ${r.unvestedRemainder}` : escapeHtml(String(r.reason ?? "Hold"))}</div>
              </div>
              <div class="aside">${statusPill(String(r.status), r.status === "issued" ? "ok" : "warn")}</div>
            </div>`
          )
          .join("")}</div>`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/memos/:id", route(async (req, res) => {
  try {
    const memo = await getMemoForViewer(req.person!.id, req.params.id);
    const body = JSON.parse(memo.body_json);
    const consequenceTone =
      body.automatic_consequence === "pip_trigger" ? "bad" : body.automatic_consequence === "observation" ? "warn" : "ok";
    const plan = await prisma.performancePlan.findFirst({
      where: { cycle_id: memo.cycle_id, employment_id: memo.employment_id },
      orderBy: { starts_on: "desc" },
      select: { id: true, kind: true, status: true },
    });
    res.send(
      await page(
        req,
        "Founder Review Memo",
        `${pageHeader(
          "Founder Review Memo",
          body.period,
          `${plan ? `<a class="btn secondary no-print" href="/plans/${plan.id}">Open ${escapeHtml(plan.kind)}</a>` : ""}<button class="btn secondary no-print" onclick="window.print()">Print</button>`
        )}
        <div class="card">
          <dl class="kv">
            <dt>Founder</dt><dd>${escapeHtml(body.founder)}</dd>
            <dt>Review date</dt><dd>${escapeHtml(body.review_date)}</dd>
            <dt>Voters</dt><dd>${escapeHtml((body.disinterested_directors_voting || []).join(", "))}</dd>
            <dt>Overall rating</dt><dd><strong>${escapeHtml(String(body.overall_rating))}</strong></dd>
            <dt>Consequence</dt><dd>${statusPill(String(body.automatic_consequence), consequenceTone)}</dd>
            <dt>Prior rating</dt><dd>${escapeHtml(String(body.prior_quarter_rating ?? "—"))}</dd>
          </dl>
        </div>
        <div class="section-label">Initiatives</div>
        <div class="card flush">
          <table>
            <thead><tr><th>Initiative</th><th>Score</th><th>Evidence</th></tr></thead>
            <tbody>
              ${(body.initiatives || [])
                .map(
                  (i: { initiativeId?: string; title?: string; score?: string; evidence?: string }) =>
                    `<tr><td>${escapeHtml(String(i.title || i.initiativeId || "—"))}</td><td>${statusPill(String(i.score ?? "—"), "neutral")}</td><td class="muted">${escapeHtml(String(i.evidence ?? "—"))}</td></tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="section-label">Dimension notes</div>
        <div class="card">
          <dl class="kv">
            ${Object.entries(body.dimension_notes || {})
              .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
              .join("")}
          </dl>
        </div>`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/equity", route(async (req, res) => {
  if (!(await can(req.person!.id, "equity.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const equityRows = await prisma.equityAccount.findMany({
    include: { employment: { include: { person: { select: { full_name: true } } } } },
    orderBy: { employment: { person: { full_name: "asc" } } },
  });
  const rows = equityRows.map((ea) => ({
    ...ea,
    full_name: ea.employment.person.full_name,
  })) as Array<Record<string, unknown>>;
  const vestingRows = await prisma.vestingRecord.findMany({
    include: {
      equityAccount: { include: { employment: { include: { person: { select: { full_name: true } } } } } },
    },
    orderBy: { created_at: "desc" },
  });
  const records = vestingRows.map((vr) => ({
    ...vr,
    full_name: vr.equityAccount.employment.person.full_name,
  })) as Array<Record<string, unknown>>;
  const canManageEquity = await can(req.person!.id, "equity.manage");
  res.send(
    await page(
      req,
      "Equity",
      `${pageHeader(
        "Equity",
        `Schedule A locked post–Founder Rebalance (${SCHEDULE_A_FOUNDER_OUTSTANDING} founder shares). Past contribution vested 15 Aug 2026; next service installment ${formatDay(SCHEDULE_A_FIRST_VESTING_DATE)}.`
      )}
      ${callout("Seed writes these numbers as confirmed. Past contribution starts vested; service vests in 10 equal quarterly installments. No new shares are issued on a Vesting Date — ledger / escrow only.")}
      <div class="section-label">Schedule A</div>
      <div class="card flush">
        <table>
          <thead><tr><th>Founder</th><th>Total</th><th>Past (vested)</th><th>Service</th><th>Quarterly</th></tr></thead>
          <tbody>
            ${SCHEDULE_A.map(
              (r) => `<tr>
                <td>${escapeHtml(r.shortName)}</td>
                <td><strong>${r.totalShares}</strong></td>
                <td>${r.pastContributionShares}</td>
                <td>${r.serviceShares}</td>
                <td>${r.quarterlyInstallment}</td>
              </tr>`
            ).join("")}
          </tbody>
        </table>
      </div>
      <div class="section-label">Accounts</div>
      ${rows
        .map(
          (r) => `<div class="card">
            <div class="card-head">
              <div class="person-chip">${avatar(String(r.full_name))}<div><h2>${escapeHtml(String(r.full_name))}</h2>
              <div class="meta muted">${escapeHtml(String(r.certificate_or_book_entry ?? "No certificate id yet"))}</div></div></div>
              ${r.schedule_a_confirmed ? statusPill("Schedule A locked", "ok") : statusPill("Needs confirmation", "warn")}
            </div>
            <div class="row">
              <div class="stat"><div class="label">Total</div><strong>${escapeHtml(String(r.total_shares))}</strong></div>
              <div class="stat"><div class="label">Past / Service</div><strong>${escapeHtml(String(r.past_contribution_shares))} / ${escapeHtml(String(r.service_shares))}</strong></div>
              <div class="stat"><div class="label">Vested</div><strong>${escapeHtml(String(r.vested_shares))}</strong></div>
              <div class="stat"><div class="label">Unvested</div><strong>${escapeHtml(String(r.unvested_shares))}</strong></div>
              <div class="stat"><div class="label">Suspension</div><strong>${r.vesting_suspended ? "Yes" : "No"}</strong></div>
            </div>
            ${
              canManageEquity && !r.schedule_a_confirmed
                ? `<form method="post" action="/equity/${r.id}/confirm">
                    <div class="field-grid">
                      <div class="field span-2"><label>Certificate / book-entry</label><input name="certificate" required placeholder="CERT-001 or book-entry id" /></div>
                      <div class="field"><label>Total shares</label><input name="total" type="number" required /></div>
                      <div class="field"><label>Past (already vested)</label><input name="past" type="number" required /></div>
                      <div class="field"><label>Service (still vesting)</label><input name="service" type="number" required /></div>
                    </div>
                    <div class="form-actions"><button type="submit">Confirm Schedule A</button></div>
                  </form>`
                : ""
            }
          </div>`
        )
        .join("")}
      <div class="section-label">Vesting records</div>
      ${
        records.length
          ? `<div class="list">${records
              .map(
                (r) => `<div class="list-row">
                  <div>
                    <div class="title">${escapeHtml(String(r.full_name))}</div>
                    <div class="meta">${escapeHtml(formatDay(String(r.vesting_date)))} · ${
                      r.status === "issued"
                        ? `+${r.shares_vested} → vested ${r.vested_total}, unvested ${r.unvested_remainder}`
                        : escapeHtml(String(r.hold_reason ?? "Hold"))
                    }</div>
                    <div class="meta">${escapeHtml(String(r.escrow_note ?? ""))}</div>
                  </div>
                  <div class="aside">${statusPill(String(r.status), r.status === "issued" ? "ok" : "warn")}</div>
                </div>`
              )
              .join("")}</div>`
          : emptyState("No vesting records yet.")
      }`
    )
  );
}));

app.post("/equity/:id/confirm", route(async (req, res) => {
  try {
    await confirmScheduleA(req.person!.id, req.params.id, {
      certificateOrBookEntry: String(req.body.certificate),
      totalShares: Number(req.body.total),
      pastContributionShares: Number(req.body.past),
      serviceShares: Number(req.body.service),
    });
    res.redirect("/equity");
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/policy", route(async (req, res) => {
  if (!(await can(req.person!.id, "policy.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const active = await getActivePolicy();
  const versions = (await prisma.policyVersion.findMany({
    orderBy: { version: "desc" },
    select: { id: true, version: true, label: true, active: true, created_at: true },
  })) as Array<Record<string, unknown>>;
  const dims = active.body.dimensions;
  res.send(
    await page(
      req,
      "Policy",
      `${pageHeader(
        "Living policy",
        "Weights, cadence, and escalation rules for founder reviews. Locked legal fields still need consent."
      )}
      <div class="row">
        <div class="stat"><div class="label">Active version</div><strong>v${active.version}</strong></div>
        <div class="stat"><div class="label">Values cap</div><strong>${active.body.values_cap_rating}</strong></div>
        <div class="stat"><div class="label">PIP default days</div><strong>${active.body.escalation.pip_days_default}</strong></div>
        <div class="stat"><div class="label">Hide until all voted</div><strong>${active.body.cadence.hide_ratings_until_all_voted ? "Yes" : "No"}</strong></div>
      </div>
      <div class="section-label">Rating dimensions</div>
      <div class="card flush">
        <table>
          <thead><tr><th>Dimension</th><th>Weight</th><th>What it covers</th></tr></thead>
          <tbody>
            ${dims.map((d) => `<tr><td>${escapeHtml(d.label)}</td><td>${d.weight}%</td><td class="muted">${escapeHtml(d.description)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="section-label">Versions</div>
      <div class="list">
        ${versions
          .map(
            (v) => `<div class="list-row">
              <div><div class="title">v${escapeHtml(String(v.version))} · ${escapeHtml(String(v.label))}</div><div class="meta">${escapeHtml(String(v.created_at))}</div></div>
              <div class="aside">${v.active ? statusPill("Active", "ok") : statusPill("Inactive", "neutral")}</div>
            </div>`
          )
          .join("")}
      </div>
      ${
        (await can(req.person!.id, "policy.manage"))
          ? `<div class="section-label">Edit & activate</div>
            <div class="card">
              ${callout("Changing vesting_anchor_date is blocked without founder consent.")}
              <form method="post" action="/policy">
                <div class="field-grid">
                  <div class="field span-2"><label>Version label</label><input name="label" value="Policy update" required /></div>
                  <div class="field span-2"><label>Policy JSON</label><textarea name="body" style="min-height:280px">${escapeHtml(JSON.stringify(active.body, null, 2))}</textarea></div>
                </div>
                <div class="form-actions"><button type="submit">Save & activate</button></div>
              </form>
            </div>`
          : ""
      }
      <details class="details-panel"><summary>Raw active policy JSON</summary><pre>${escapeHtml(JSON.stringify(active.body, null, 2))}</pre></details>`
    )
  );
}));

app.post("/policy", route(async (req, res) => {
  try {
    const body = PolicyBodySchema.parse(JSON.parse(String(req.body.body)));
    await createPolicyVersion(req.person!.id, String(req.body.label || "Policy update"), body, true);
    res.redirect("/policy");
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/audit", route(async (req, res) => {
  if (!(await can(req.person!.id, "audit.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const auditRows = await prisma.auditEvent.findMany({
    orderBy: { created_at: "desc" },
    take: 200,
    include: { actor: { select: { full_name: true } } },
  });
  const rows = auditRows.map((a) => ({
    ...a,
    full_name: a.actor?.full_name ?? null,
  })) as Array<Record<string, unknown>>;
  res.send(
    await page(
      req,
      "Audit",
      `${pageHeader("Audit log", "Who changed policy, ratings, and equity — newest first.")}
      ${
        rows.length === 0
          ? emptyState("No audit events yet.")
          : `<div class="card flush"><table>
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (r) => `<tr>
                      <td class="muted nowrap">${escapeHtml(formatDay(String(r.created_at)))} · ${escapeHtml(String(r.created_at).slice(11, 16))}</td>
                      <td>${escapeHtml(String(r.full_name ?? "system"))}</td>
                      <td><code>${escapeHtml(String(r.action))}</code></td>
                      <td class="muted">${escapeHtml(String(r.entity_type))}${r.entity_id ? ` · ${escapeHtml(String(r.entity_id).slice(0, 18))}` : ""}</td>
                      <td>${escapeHtml(String(r.reason ?? "—"))}</td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table></div>`
      }`
    )
  );
}));

function approvalsPageBody(token: string, permissions: string[], requestId?: string) {
  const gateway = gatewayPublicUrl();
  const reqAttr = requestId ? ` data-request-id="${escapeHtml(requestId)}"` : "";
  return `${crumbs([{ label: "Approvals" }])}
    ${pageHeader("Approvals", "Maker-checker inbox for cash calls, accounts, and other workforce actions.")}
    <div
      id="workforce-approvals-root"
      class="workforce-approvals-host"
      data-gateway-url="${escapeHtml(gateway)}"
      data-access-token="${escapeHtml(token)}"
      data-permissions="${escapeHtml(JSON.stringify(permissions))}"${reqAttr}
    ></div>
    <link rel="stylesheet" href="/workforce/approvals.css" />
    <script src="/workforce/approvals.js" defer></script>`;
}

async function requireWorkforceApprovalsSession(
  req: express.Request,
  res: express.Response,
  nextPath: string
): Promise<{ token: string; permissions: string[] } | null> {
  const token = req.cookies?.[WORKFORCE_TOKEN_COOKIE] as string | undefined;
  if (isWorkforceTokenFresh(token) && canShowApprovalsNav(decodeWorkforcePermissions(token))) {
    return { token: token!, permissions: decodeWorkforcePermissions(token) };
  }
  if (!workforceSsoConfigured()) {
    res.status(503).send(
      await page(
        req,
        "Approvals",
        `${pageHeader("Approvals", "Platform SSO is not configured.")}
        ${callout("Set WORKFORCE_API_URL and PLATFORM_LOGIN_URL on the HRIS process.")}`
      )
    );
    return null;
  }
  beginWorkforceSso(res, nextPath);
  return null;
}

app.get("/approvals/callback", route(async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const expected = req.cookies?.[WORKFORCE_SSO_STATE_COOKIE] as string | undefined;
  const nextPath = (req.cookies?.[WORKFORCE_SSO_NEXT_COOKIE] as string | undefined) || "/approvals";
  res.clearCookie(WORKFORCE_SSO_STATE_COOKIE);
  res.clearCookie(WORKFORCE_SSO_NEXT_COOKIE);
  if (!code || !expected || state !== expected) {
    res.status(400).send(
      await page(
        req,
        "Approvals",
        `${pageHeader("Approvals", "SSO callback failed.")}
        ${callout("Invalid or expired sign-in state. Open Approvals again.")}`
      )
    );
    return;
  }
  const session = await exchangeSsoCode({ code, state });
  if (!session || !canShowApprovalsNav(session.permissions)) {
    res.status(403).send(
      await page(
        req,
        "Approvals",
        `${pageHeader("Approvals", "Access denied.")}
        ${callout("Your platform account needs platform:approvals:read (or decide/manage).")}`
      )
    );
    return;
  }
  res.cookie(WORKFORCE_TOKEN_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: "lax",
  });
  const safeNext =
    nextPath.startsWith("/approvals") && !nextPath.startsWith("//") ? nextPath : "/approvals";
  res.redirect(safeNext);
}));

app.get("/approvals", route(async (req, res) => {
  const session = await requireWorkforceApprovalsSession(req, res, "/approvals");
  if (!session) return;
  res.send(await page(req, "Approvals", approvalsPageBody(session.token, session.permissions)));
}));

app.get("/approvals/:id", route(async (req, res) => {
  const id = String(req.params.id || "");
  if (id === "callback") {
    res.status(404).send(await page(req, "Not found", "Not found"));
    return;
  }
  const session = await requireWorkforceApprovalsSession(req, res, `/approvals/${encodeURIComponent(id)}`);
  if (!session) return;
  res.send(
    await page(req, "Approvals", approvalsPageBody(session.token, session.permissions, id))
  );
}));

app.get("/api/me", route(async (req, res) => {
  res.json({ person: req.person, permissions: [...(await personPermissionKeys(req.person!.id))] });
}));

app.get("/api/policy/active", requireApiPerm("policy.read"), route(async (_req, res) => {
  res.json(await getActivePolicy());
}));

const port = Number(process.env.PORT || 4545);
app.get("/finance", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const openCalls = (await listCashCalls()).filter((call) => call.status === "open").length;
  res.send(
    await page(
      req,
      "Finance",
      `${pageHeader("Finance", "Company money.")}
      <div class="list">
        <a class="list-row" href="/finance/calls" style="color:inherit;text-decoration:none">
          <div>
            <div class="title">Cash calls</div>
            <div class="meta">Founder contributions, split by Schedule A. ${openCalls ? `${openCalls} open` : "None open"}.</div>
          </div>
          <div class="aside"><span class="btn secondary">Open</span></div>
        </a>
        <a class="list-row" href="/finance/accounts" style="color:inherit;text-decoration:none">
          <div>
            <div class="title">Accounts</div>
            <div class="meta">Company accounts that receive cash calls. ${(await listCompanyAccounts()).filter((account) => account.status === "active").length} active.</div>
          </div>
          <div class="aside"><span class="btn secondary">Open</span></div>
        </a>
      </div>`
    )
  );
}));

app.get("/finance/calls", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const calls = await listCashCalls();
  const submitted = typeof req.query.submitted === "string" ? req.query.submitted : "";
  res.send(
    await page(
      req,
      "Cash calls",
      `${crumbs([{ href: "/finance", label: "Finance" }, { label: "Cash calls" }])}
      ${pageHeader(
        "Cash calls",
        "Each call is paid into one company account and split by Schedule A. A payment does not issue shares.",
        `${(await can(req.person!.id, "finance.manage")) ? `<a class="btn" href="/finance/calls/new">Issue cash call</a>` : ""}<a class="btn secondary" href="/finance">Back</a>`
      )}
      ${
        submitted
          ? `<div class="callout">Submitted for approval. <a href="/approvals/${escapeHtml(submitted)}">Open in Approvals</a> so a checker can decide before the call is issued.</div>`
          : ""
      }
      ${
        calls.length
          ? `<div class="list">${calls
              .map(
                (call) => `<a class="list-row" href="/finance/calls/${call.id}" style="color:inherit;text-decoration:none">
                  <div>
                    <div class="title">${escapeHtml(call.title)}</div>
                    <div class="meta">Due ${escapeHtml(formatDay(call.due_on))} · ${escapeHtml(call.account_name || "No account")} · ${formatMoney(call.paid_cents, call.currency)} of ${formatMoney(call.total_cents, call.currency)} received</div>
                  </div>
                  <div class="aside">${statusPill(call.status === "settled" ? "Settled" : "Open", call.status === "settled" ? "ok" : "warn")}</div>
                </a>`
              )
              .join("")}</div>`
          : emptyState("No cash calls yet.")
      }`
    )
  );
}));

app.get("/finance/calls/new", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.manage"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const accounts = (await listCompanyAccounts()).filter((account) => account.status === "active");
  res.send(
    await page(
      req,
      "Issue cash call",
      `${crumbs([{ href: "/finance", label: "Finance" }, { href: "/finance/calls", label: "Cash calls" }, { label: "Issue" }])}
      ${pageHeader("Issue cash call", "The currency is the account's currency.", `<a class="btn secondary" href="/finance/calls">Back</a>`)}
      ${
        accounts.length
          ? `<form class="card" method="post" action="/finance/calls">
              <p class="hint">Split of the 900 founder shares: ${SCHEDULE_A.map((row) => `${escapeHtml(row.shortName)} ${row.totalShares}`).join(" · ")}.</p>
              <div class="field-grid">
                <div class="field span-2"><label>Title</label><input name="title" required placeholder="November runway" /></div>
                <div class="field span-2"><label>Purpose</label><textarea name="purpose" required placeholder="What the company will use the cash for"></textarea></div>
                <div class="field span-2"><label>Pay into</label>
                  <select name="account_id" required>
                    ${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${escapeHtml(account.currency)} · ${escapeHtml(account.institution)}</option>`).join("")}
                  </select>
                </div>
                <div class="field"><label>Total</label><input name="total" required inputmode="decimal" placeholder="10000.00" /></div>
                <div class="field"><label>Due</label><input name="due_on" type="date" required /></div>
              </div>
              <div class="form-actions"><button type="submit">${workforceApprovalsEnabled() ? "Submit for approval" : "Issue cash call"}</button></div>
            </form>`
          : `${callout("Add an active company account before issuing a cash call.")}<p><a class="btn" href="/finance/accounts/new">Add account</a></p>`
      }`
    )
  );
}));

app.post("/finance/calls", route(async (req, res) => {
  try {
    if (!(await can(req.person!.id, "finance.manage"))) {
      res.status(403).send(await page(req, "Forbidden", "Forbidden"));
      return;
    }
    const payload = {
      actorId: req.person!.id,
      title: String(req.body.title || ""),
      purpose: String(req.body.purpose || ""),
      totalCents: parseMoney(String(req.body.total || "")),
      accountId: String(req.body.account_id || ""),
      dueOn: String(req.body.due_on || ""),
    };
    if (workforceApprovalsEnabled()) {
      const account = (await listCompanyAccounts()).find((row) => row.id === payload.accountId);
      const approval = await submitWorkforceApproval({
        actionKey: HRIS_APPROVAL_ACTIONS.CASH_CALL_ISSUE,
        requesterEmail: req.person!.email,
        payload,
        amountCents: payload.totalCents,
        currency: account?.currency,
      });
      res.redirect(`/finance/calls?submitted=${encodeURIComponent(approval.id)}`);
      return;
    }
    const callId = await issueCashCall(payload);
    res.redirect(`/finance/calls/${callId}`);
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/finance/calls/:id", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  try {
    const call = await getCashCall(req.params.id);
    const canRecordAny = await can(req.person!.id, "finance.manage");
    const canRecord = call.lines.some(
      (line) => line.amount_cents > line.paid_cents && (canRecordAny || line.person_id === req.person!.id)
    );
    res.send(
      await page(
        req,
        call.title,
        `${crumbs([{ href: "/finance", label: "Finance" }, { href: "/finance/calls", label: "Cash calls" }, { label: call.title }])}
        ${pageHeader(
          call.title,
          `${call.currency} · due ${formatDay(call.due_on)}`,
          `${canRecord ? `<a class="btn" href="/finance/calls/${call.id}/pay">Record payment</a>` : ""}<a class="btn secondary" href="/finance/calls">Back</a>`
        )}
        ${callout(call.purpose)}
        ${
          call.account_name
            ? `<div class="card"><div class="card-head"><h2>Pay into</h2>${statusPill(call.currency, "neutral")}</div>
                <dl class="kv">
                  <dt>Account</dt><dd>${escapeHtml(call.account_name)}</dd>
                  <dt>Institution</dt><dd>${escapeHtml(call.account_institution || "")}</dd>
                  <dt>Reference</dt><dd><code>${escapeHtml(call.account_reference || "")}</code></dd>
                </dl>
              </div>`
            : callout("This call has no company account on it.")
        }
        <div class="row">
          <div class="stat"><div class="label">Total</div><strong>${formatMoney(call.total_cents, call.currency)}</strong></div>
          <div class="stat"><div class="label">Received</div><strong>${formatMoney(call.lines.reduce((sum, line) => sum + line.paid_cents, 0), call.currency)}</strong></div>
          <div class="stat"><div class="label">Status</div><strong>${escapeHtml(call.status === "settled" ? "Settled" : "Open")}</strong></div>
        </div>
        <div class="section-label">Shares</div>
        <div class="card flush table-scroll">
          <table>
            <thead><tr><th>Founder</th><th>Shares</th><th>Due</th><th>Paid</th><th>Open</th></tr></thead>
            <tbody>
              ${call.lines
                .map((line) => {
                  const open = line.amount_cents - line.paid_cents;
                  const mine = line.person_id === req.person!.id;
                  return `<tr>
                    <td>${escapeHtml(line.full_name)}${mine ? " · you" : ""}</td>
                    <td>${line.shares}</td>
                    <td>${formatMoney(line.amount_cents, call.currency)}</td>
                    <td>${formatMoney(line.paid_cents, call.currency)}</td>
                    <td>${formatMoney(open, call.currency)}</td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        ${
          call.payments.length
            ? `<div class="section-label">Payments</div>
              <div class="card flush table-scroll">
                <table>
                  <thead><tr><th>Date</th><th>Amount</th><th>Reference</th><th>Recorded by</th></tr></thead>
                  <tbody>
                    ${call.payments
                      .map(
                        (payment) => `<tr>
                          <td>${escapeHtml(payment.paid_on)}</td>
                          <td>${formatMoney(payment.amount_cents, call.currency)}</td>
                          <td>${escapeHtml(payment.reference)}</td>
                          <td>${escapeHtml(payment.recorded_by_name)}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>`
            : ""
        }`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/finance/calls/:id/pay", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  try {
    const call = await getCashCall(req.params.id);
    const canRecordAny = await can(req.person!.id, "finance.manage");
    const choices = call.lines.filter(
      (line) => line.amount_cents > line.paid_cents && (canRecordAny || line.person_id === req.person!.id)
    );
    if (!choices.length) {
      res.redirect(`/finance/calls/${call.id}`);
      return;
    }
    res.send(
      await page(
        req,
        "Record payment",
        `${crumbs([{ href: "/finance", label: "Finance" }, { href: "/finance/calls", label: "Cash calls" }, { href: `/finance/calls/${call.id}`, label: call.title }, { label: "Payment" }])}
        ${pageHeader(`Record payment · ${call.title}`, call.currency, `<a class="btn secondary" href="/finance/calls/${call.id}">Back</a>`)}
        <form class="card" method="post" action="/finance/calls/${call.id}/payments">
          <div class="field-grid">
            <div class="field span-2"><label>Founder</label>
              <select name="line_id" required>
                ${choices
                  .map(
                    (line) =>
                      `<option value="${escapeHtml(line.id)}"${line.person_id === req.person!.id ? " selected" : ""}>${escapeHtml(line.full_name)} · open ${formatMoney(line.amount_cents - line.paid_cents, call.currency)}</option>`
                  )
                  .join("")}
              </select>
            </div>
            <div class="field"><label>Amount (${escapeHtml(call.currency)})</label><input name="amount" required inputmode="decimal" placeholder="0.00" /></div>
            <div class="field"><label>Date</label><input name="paid_on" type="date" required /></div>
            <div class="field span-2"><label>Transfer reference</label><input name="reference" required placeholder="Bank reference" /></div>
          </div>
          <div class="form-actions"><button type="submit">Record payment</button></div>
        </form>`
      )
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/finance/calls/:id/payments", route(async (req, res) => {
  try {
    await recordCashCallPayment({
      actorId: req.person!.id,
      callId: req.params.id,
      lineId: String(req.body.line_id || ""),
      amountCents: parseMoney(String(req.body.amount || "")),
      paidOn: String(req.body.paid_on || ""),
      reference: String(req.body.reference || ""),
    });
    res.redirect(`/finance/calls/${req.params.id}`);
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.get("/finance/accounts", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.read"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  const accounts = await listCompanyAccounts();
  const canManage = await can(req.person!.id, "finance.manage");
  const submitted = typeof req.query.submitted === "string" ? req.query.submitted : "";
  res.send(
    await page(
      req,
      "Accounts",
      `${crumbs([{ href: "/finance", label: "Finance" }, { label: "Accounts" }])}
      ${pageHeader(
        "Accounts",
        "Company accounts. A cash call is paid into one of these.",
        `${canManage ? `<a class="btn" href="/finance/accounts/new">Add account</a>` : ""}<a class="btn secondary" href="/finance">Back</a>`
      )}
      ${
        submitted
          ? `<div class="callout">Submitted for approval. <a href="/approvals/${escapeHtml(submitted)}">Open in Approvals</a> so a checker can decide before the account change is applied.</div>`
          : ""
      }
      ${
        accounts.length
          ? `<div class="list">${accounts
              .map(
                (account) => `<div class="list-row">
                  <div>
                    <div class="title">${escapeHtml(account.name)}</div>
                    <div class="meta">${escapeHtml(account.institution)} · ${escapeHtml(account.currency)} · ${escapeHtml(account.reference)}</div>
                  </div>
                  <div class="aside">
                    ${statusPill(account.status === "active" ? "Active" : "Closed", account.status === "active" ? "ok" : "neutral")}
                    ${
                      canManage && account.status === "active"
                        ? `<form method="post" action="/finance/accounts/${account.id}/close"><button class="secondary" type="submit">Close</button></form>`
                        : ""
                    }
                  </div>
                </div>`
              )
              .join("")}</div>`
          : emptyState("No company accounts yet.")
      }`
    )
  );
}));

app.get("/finance/accounts/new", route(async (req, res) => {
  if (!(await can(req.person!.id, "finance.manage"))) {
    res.status(403).send(await page(req, "Forbidden", "Forbidden"));
    return;
  }
  res.send(
    await page(
      req,
      "Add account",
      `${crumbs([{ href: "/finance", label: "Finance" }, { href: "/finance/accounts", label: "Accounts" }, { label: "Add" }])}
      ${pageHeader("Add account", "Founders pay a cash call into this account.", `<a class="btn secondary" href="/finance/accounts">Back</a>`)}
      <form class="card" method="post" action="/finance/accounts">
        <div class="field-grid">
          <div class="field"><label>Name</label><input name="name" required placeholder="Operating" /></div>
          <div class="field"><label>Institution</label><input name="institution" required placeholder="Bank or provider" /></div>
          <div class="field"><label>Currency</label>
            <select name="currency" required>
              ${CASH_CALL_CURRENCIES.map((code) => `<option value="${code}">${code}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Reference</label><input name="reference" required placeholder="Account number or wallet id" /></div>
        </div>
        <div class="form-actions"><button type="submit">${workforceApprovalsEnabled() ? "Submit for approval" : "Save account"}</button></div>
      </form>`
    )
  );
}));

app.post("/finance/accounts", route(async (req, res) => {
  try {
    if (!(await can(req.person!.id, "finance.manage"))) {
      res.status(403).send(await page(req, "Forbidden", "Forbidden"));
      return;
    }
    const payload = {
      actorId: req.person!.id,
      name: String(req.body.name || ""),
      institution: String(req.body.institution || ""),
      currency: String(req.body.currency || ""),
      reference: String(req.body.reference || ""),
    };
    if (workforceApprovalsEnabled()) {
      const approval = await submitWorkforceApproval({
        actionKey: HRIS_APPROVAL_ACTIONS.ACCOUNT_CREATE,
        requesterEmail: req.person!.email,
        payload,
      });
      res.redirect(`/finance/accounts?submitted=${encodeURIComponent(approval.id)}`);
      return;
    }
    await createCompanyAccount(payload);
    res.redirect("/finance/accounts");
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

app.post("/finance/accounts/:id/close", route(async (req, res) => {
  try {
    if (!(await can(req.person!.id, "finance.manage"))) {
      res.status(403).send(await page(req, "Forbidden", "Forbidden"));
      return;
    }
    if (workforceApprovalsEnabled()) {
      const approval = await submitWorkforceApproval({
        actionKey: HRIS_APPROVAL_ACTIONS.ACCOUNT_CLOSE,
        requesterEmail: req.person!.email,
        payload: { actorId: req.person!.id, accountId: req.params.id },
      });
      res.redirect(`/finance/accounts?submitted=${encodeURIComponent(approval.id)}`);
      return;
    }
    await closeCompanyAccount(req.person!.id, req.params.id);
    res.redirect("/finance/accounts");
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).send(await page(req, "Error", `<p class="err">${escapeHtml(err.message)}</p>`));
  }
}));

function assertHrisInternalKey(provided: string | undefined) {
  const configured = process.env.HRIS_INTERNAL_KEY?.trim();
  if (!configured || !provided?.trim()) {
    const err = new Error("Unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  const expected = Buffer.from(configured, "utf8");
  const actual = Buffer.from(provided.trim(), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const err = new Error("Unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
}

app.post("/internal/approvals/execute", express.json(), route(async (req, res) => {
  try {
    assertHrisInternalKey(
      (req.headers["x-hris-internal-key"] as string | undefined) || undefined
    );
    const actionKey = String(req.body?.actionKey || "");
    const payload = (req.body?.payload ?? {}) as Record<string, unknown>;
    let resourceId: string | undefined;
    if (actionKey === HRIS_APPROVAL_ACTIONS.CASH_CALL_ISSUE) {
      resourceId = await commitCashCall({
        actorId: String(payload.actorId || ""),
        title: String(payload.title || ""),
        purpose: String(payload.purpose || ""),
        totalCents: Number(payload.totalCents || 0),
        accountId: String(payload.accountId || ""),
        dueOn: String(payload.dueOn || ""),
      });
    } else if (actionKey === HRIS_APPROVAL_ACTIONS.ACCOUNT_CREATE) {
      resourceId = await commitCompanyAccount({
        actorId: String(payload.actorId || ""),
        name: String(payload.name || ""),
        institution: String(payload.institution || ""),
        currency: String(payload.currency || ""),
        reference: String(payload.reference || ""),
      });
    } else if (actionKey === HRIS_APPROVAL_ACTIONS.ACCOUNT_CLOSE) {
      await commitCloseCompanyAccount(String(payload.actorId || ""), String(payload.accountId || ""));
      resourceId = String(payload.accountId || "");
    } else {
      res.status(400).json({ error: `Unknown action ${actionKey}` });
      return;
    }
    res.json({ resourceId });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).json({ error: err.message });
  }
}));

async function boot() {
  await migrate();
  await syncRolePermissions();
  app.listen(port, () => {
    console.log(`Kritly HRIS listening on http://localhost:${port}`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
