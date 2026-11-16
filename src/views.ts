import { escapeHtml } from "./util.js";
import type { Person } from "./auth.js";

function navLink(href: string, label: string, currentPath: string) {
  const active = currentPath === href || (href !== "/" && currentPath.startsWith(href));
  return `<a class="nav-link${active ? " active" : ""}" href="${href}">${escapeHtml(label)}</a>`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export type NavNotification = {
  id: string;
  title: string;
  body: string;
  due_on: string | null;
  read_at: string | null;
};

export function layout(
  person: Person | null,
  title: string,
  body: string,
  currentPath = "/",
  opts?: {
    unreadNotifications?: number;
    recentNotifications?: NavNotification[];
    showApprovals?: boolean;
    naiAssertion?: string | null;
    naiServiceUrl?: string | null;
    naiSelection?: Record<string, string>;
  }
) {
  if (!person) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Kritly HRIS</title>
  <link rel="stylesheet" href="/kritly-ui.css" />
</head>
<body>
  <div class="auth-wrap">${body}</div>
</body>
</html>`;
  }

  const unread = opts?.unreadNotifications ?? 0;
  const recent = opts?.recentNotifications ?? [];
  const notifPanel =
    recent.length === 0
      ? `<div class="notif-empty">No notifications</div>`
      : recent
          .map(
            (n) => `<a class="notif-item${n.read_at ? " read" : ""}" href="/notifications/${n.id}/open">
              <div class="title">${escapeHtml(n.title)}</div>
              <div class="meta">${escapeHtml(n.body)}</div>
              ${n.due_on ? `<div class="meta">Due ${escapeHtml(n.due_on)}</div>` : ""}
            </a>`
          )
          .join("");

  const naiAssertion = opts?.naiAssertion?.trim() || "";
  const naiUrl = opts?.naiServiceUrl?.trim() || "";
  const naiSelection = opts?.naiSelection ?? {};
  const naiIsland =
    naiAssertion && naiUrl
      ? `<div
          id="hris-nai-root"
          class="hris-nai-host no-print"
          data-nai-url="${escapeHtml(naiUrl)}"
          data-assertion="${escapeHtml(naiAssertion)}"
          data-assertion-path="/api/nai/assertion"
          data-route="${escapeHtml(currentPath)}"
          data-selection="${escapeHtml(JSON.stringify(naiSelection))}"
        ></div>
        <link rel="stylesheet" href="/nai/island.css" />
        <script src="/nai/island.js" defer></script>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Kritly HRIS</title>
  <link rel="stylesheet" href="/kritly-ui.css" />
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand"><a href="/"><div class="sidebar-mark">K</div></a><a href="/">Kritly HRIS</a></div>
      <nav class="sidebar-nav">
        <div>
          <div class="nav-group-label">Workspace</div>
          ${navLink("/", "Home", currentPath)}
          ${navLink("/people", "People", currentPath)}
          ${navLink("/performance", "Performance", currentPath)}
          ${navLink("/equity", "Equity", currentPath)}
          ${navLink("/finance", "Finance", currentPath)}
        </div>
        <div>
          <div class="nav-group-label">Governance</div>
          ${navLink("/policy", "Policy", currentPath)}
          ${navLink("/audit", "Audit", currentPath)}
          ${opts?.showApprovals ? navLink("/approvals", "Approvals", currentPath) : ""}
        </div>
      </nav>
      <div class="sidebar-foot">
        <div class="person-chip">
          <div class="avatar">${escapeHtml(initials(person.full_name))}</div>
          <div>
            <div>${escapeHtml(person.full_name)}</div>
            <div><a href="/logout">Log out</a></div>
          </div>
        </div>
      </div>
    </aside>
    <div class="shell-main">
      <header class="topbar no-print">
        <div class="topbar-spacer"></div>
        <details class="notif-menu">
          <summary class="notif-bell" aria-label="Notifications${unread ? ` (${unread} unread)` : ""}">
            <span class="notif-bell-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></span>
            ${unread > 0 ? `<span class="nav-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
          </summary>
          <div class="notif-panel">
            <div class="notif-panel-head">
              <strong>Notifications</strong>
              ${
                unread > 0
                  ? `<form method="post" action="/notifications/read-all"><button class="linkish" type="submit">Mark all read</button></form>`
                  : ""
              }
            </div>
            <div class="notif-list">${notifPanel}</div>
          </div>
        </details>
      </header>
      <main class="content">${body}</main>
    </div>
  </div>
  ${naiIsland}
</body>
</html>`;
}

export function pageHeader(title: string, description?: string, actionsHtml = "") {
  return `<div class="page-header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      ${description ? `<p class="lead">${escapeHtml(description)}</p>` : ""}
    </div>
    ${actionsHtml ? `<div class="page-actions no-print">${actionsHtml}</div>` : ""}
  </div>`;
}

export function crumbs(items: { href?: string; label: string }[]) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items
    .map((item, i) => {
      const part = item.href
        ? `<a href="${item.href}">${escapeHtml(item.label)}</a>`
        : `<span>${escapeHtml(item.label)}</span>`;
      return i === 0 ? part : `<span class="sep">/</span>${part}`;
    })
    .join("")}</nav>`;
}

export function statusPill(label: string, tone: "ok" | "warn" | "bad" | "neutral" | "" = "") {
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

export function emptyState(message: string) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

export function callout(message: string) {
  return `<div class="callout">${escapeHtml(message)}</div>`;
}

export function avatar(name: string) {
  return `<div class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</div>`;
}

/**
 * Public sign-in. Matches Workday / SuccessFactors: company mark, credentials, sign in.
 * No product modules, processes, or account-provisioning details.
 */
function authShell(inner: string) {
  return `<div class="auth-screen">
  <aside class="auth-stage" aria-hidden="true">
    <div class="auth-stage-mark">K</div>
    <p class="auth-stage-word">Kritly</p>
    <p class="auth-stage-line">Human resources</p>
  </aside>
  <main class="auth-panel">
    <div class="auth-panel-card">
      <p class="auth-kicker">Kritly</p>
      ${inner}
    </div>
    <p class="auth-legal">© ${new Date().getFullYear()} Kritly</p>
  </main>
</div>`;
}

function authAlert(message?: string) {
  return message ? `<div class="auth-alert" role="alert">${escapeHtml(message)}</div>` : "";
}

export function authForgotBody(opts?: { error?: string; email?: string; sent?: boolean }) {
  if (opts?.sent) {
    return authShell(`<h1 class="auth-signin-title">Check your email</h1>
      <p class="auth-help">If an account exists for that address, we've sent a link to reset your password. The link expires in 1 hour.</p>
      <p class="auth-forgot"><a href="/login">Back to sign in</a></p>`);
  }
  const email = escapeHtml(opts?.email || "");
  return authShell(`<h1 class="auth-signin-title">Reset password</h1>
      ${authAlert(opts?.error)}
      <p class="auth-help">Enter your account email and we'll send you a reset link.</p>
      <form class="auth-form" method="post" action="/forgot-password">
        <div class="field">
          <label for="forgot-email">Email</label>
          <input id="forgot-email" name="email" type="email" required value="${email}" autocomplete="username" autofocus />
        </div>
        <div class="auth-form-actions">
          <button class="btn block auth-submit" type="submit">Send reset link</button>
        </div>
      </form>
      <p class="auth-forgot"><a href="/login">Back to sign in</a></p>`);
}

export function authResetBody(opts: { token: string; error?: string; invalid?: boolean; minLength: number }) {
  if (opts.invalid) {
    return authShell(`<h1 class="auth-signin-title">Link expired</h1>
      <p class="auth-help">This reset link is invalid, already used, or has expired.</p>
      <p class="auth-forgot"><a href="/forgot-password">Request a new link</a></p>`);
  }
  return authShell(`<h1 class="auth-signin-title">Choose a new password</h1>
      ${authAlert(opts.error)}
      <form class="auth-form" method="post" action="/reset-password">
        <input type="hidden" name="token" value="${escapeHtml(opts.token)}" />
        <div class="field">
          <label for="reset-password">New password</label>
          <input id="reset-password" name="password" type="password" required minlength="${opts.minLength}" autocomplete="new-password" autofocus />
        </div>
        <div class="field">
          <label for="reset-confirm">Confirm password</label>
          <input id="reset-confirm" name="confirm" type="password" required minlength="${opts.minLength}" autocomplete="new-password" />
        </div>
        <div class="auth-form-actions">
          <button class="btn block auth-submit" type="submit">Update password</button>
        </div>
      </form>`);
}

export function authLoginBody(opts?: { error?: string; email?: string; notice?: string }) {
  const email = escapeHtml(opts?.email || "");
  const error = authAlert(opts?.error);
  const notice = opts?.notice ? `<p class="auth-help" role="status">${escapeHtml(opts.notice)}</p>` : "";
  return `<div class="auth-screen">
  <aside class="auth-stage" aria-hidden="true">
    <div class="auth-stage-mark">K</div>
    <p class="auth-stage-word">Kritly</p>
    <p class="auth-stage-line">Human resources</p>
  </aside>
  <main class="auth-panel">
    <div class="auth-panel-card">
      <p class="auth-kicker">Kritly</p>
      <h1 class="auth-signin-title">Sign in</h1>
      ${notice}
      ${error}
      <form class="auth-form" method="post" action="/login" autocomplete="on">
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" required value="${email}" autocomplete="username" autofocus />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" required autocomplete="current-password" />
        </div>
        <div class="auth-form-actions">
          <button class="btn block auth-submit" type="submit">Sign in</button>
        </div>
      </form>
      <p class="auth-forgot"><a href="/forgot-password">Forgot password?</a></p>
    </div>
    <p class="auth-legal">© ${new Date().getFullYear()} Kritly</p>
  </main>
</div>`;
}
