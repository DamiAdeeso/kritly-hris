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

export async function sendPasswordResetEmail(to: string, fullName: string, resetUrl: string) {
  const firstName = fullName.split(/\s+/)[0];
  const subject = "Reset your Kritly HRIS password";
  const text = `Hi ${firstName},\n\nSomeone requested a password reset for your Kritly HRIS account.\n\nClick the link below to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.\n\nKritly`;
  const html = `<p>Hi ${escapeHtml(firstName)},</p>
<p>Someone requested a password reset for your Kritly HRIS account.</p>
<p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px">Reset password</a></p>
<p style="color:#666;font-size:13px">Link expires in 1 hour. If you didn't request this, ignore this email.</p>
<p style="color:#666;font-size:13px">Kritly</p>`;

  if (!smtpConfigured()) {
    console.log(`\n[EMAIL — no SMTP configured]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }

  const transport = createTransport();
  await transport.sendMail({
    from: process.env.EMAIL_FROM ?? `Kritly HRIS <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  });
}
