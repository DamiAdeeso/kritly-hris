import nodemailer from "nodemailer";
import { escapeHtml } from "../util.js";

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });
}

function firstNameOf(fullName: string) {
  return fullName.split(/\s+/)[0] ?? fullName;
}

const BUTTON_STYLE =
  "display:inline-block;padding:10px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px";
const MUTED_STYLE = "color:#666;font-size:13px";

async function send(to: string, subject: string, text: string, html: string) {
  if (!smtpConfigured()) {
    console.log(`\n[EMAIL — no SMTP configured]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await createTransport().sendMail({
    from: process.env.EMAIL_FROM ?? `Kritly HRIS <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

export async function sendPasswordResetEmail(to: string, fullName: string, resetUrl: string) {
  const firstName = firstNameOf(fullName);
  const subject = "Reset your Kritly HRIS password";
  const text = `Hi ${firstName},\n\nSomeone requested a password reset for your Kritly HRIS account.\n\nClick the link below to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.\n\nKritly`;
  const html = `<p>Hi ${escapeHtml(firstName)},</p>
<p>Someone requested a password reset for your Kritly HRIS account.</p>
<p><a href="${escapeHtml(resetUrl)}" style="${BUTTON_STYLE}">Reset password</a></p>
<p style="${MUTED_STYLE}">Link expires in 1 hour. If you didn't request this, ignore this email.</p>
<p style="${MUTED_STYLE}">Kritly</p>`;
  await send(to, subject, text, html);
}

/** First-access email: same single-use token flow as reset, with a longer window. */
export async function sendWelcomeEmail(
  to: string,
  fullName: string,
  setupUrl: string,
  opts: { signInUrl: string; expiresInHours: number }
) {
  const firstName = firstNameOf(fullName);
  const hours = `${opts.expiresInHours} hour${opts.expiresInHours === 1 ? "" : "s"}`;
  const subject = "Welcome to Kritly HRIS — set your password";
  const text = `Hi ${firstName},

Welcome to Kritly HRIS — where we run founder performance reviews, equity vesting, and company finance.

Your account is ready. Sign-in email: ${to}

Set your password to get started (this link works once and expires in ${hours}):

${setupUrl}

After that, sign in any time at ${opts.signInUrl}

If the link expires, use "Forgot password?" on the sign-in page to get a new one.

Kritly`;
  const html = `<p>Hi ${escapeHtml(firstName)},</p>
<p>Welcome to <strong>Kritly HRIS</strong> — where we run founder performance reviews, equity vesting, and company finance.</p>
<p>Your account is ready. Sign-in email: <strong>${escapeHtml(to)}</strong></p>
<p><a href="${escapeHtml(setupUrl)}" style="${BUTTON_STYLE}">Set your password</a></p>
<p style="${MUTED_STYLE}">This link works once and expires in ${escapeHtml(hours)}. After that, sign in at <a href="${escapeHtml(opts.signInUrl)}">${escapeHtml(opts.signInUrl)}</a>. If the link expires, use “Forgot password?” on the sign-in page.</p>
<p style="${MUTED_STYLE}">Kritly</p>`;
  await send(to, subject, text, html);
}
