/**
 * Send welcome emails with a single-use set-password link (24h).
 *
 *   npm run welcome -- --founders [--exclude a@x.com,b@y.com] [--dry-run]
 *   npm run welcome -- someone@x.com other@y.com [--dry-run]
 *
 * Needs DATABASE_URL (the DB the deployed app reads), HRIS_PUBLIC_URL (the deployed
 * app's URL) and SMTP_HOST/USER/PASS. Before sending anything it checks that the
 * deployed app accepts every new link, so a DB/URL mismatch sends nothing.
 */
import { prisma } from "./db.js";
import { createPasswordResetToken, WELCOME_TTL_HOURS } from "./auth.js";
import { sendWelcomeEmail } from "./services/emailService.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const founders = args.includes("--founders");
const excludeArg = args.find((a) => a.startsWith("--exclude="));
const exclude = new Set(
  (excludeArg?.slice("--exclude=".length) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
const explicit = args.filter((a) => !a.startsWith("--"));

async function main() {
  const base = process.env.HRIS_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Set HRIS_PUBLIC_URL to the deployed app URL.");
  if (!dryRun) {
    for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
      if (!process.env[k]) throw new Error(`${k} not set — emails would only be logged.`);
    }
  }
  if (!founders && explicit.length === 0) throw new Error("Pass --founders or one or more emails.");

  const people = await prisma.person.findMany({
    where: founders ? { is_founder: 1 } : { email: { in: explicit } },
    select: { email: true, full_name: true },
    orderBy: { email: "asc" },
  });
  const missing = explicit.filter((e) => !people.some((p) => p.email === e));
  if (missing.length) throw new Error(`No account for: ${missing.join(", ")}`);
  const targets = people.filter((p) => !exclude.has(p.email.toLowerCase()));
  if (targets.length === 0) throw new Error("Nobody to email.");

  console.log(`Welcome emails (${WELCOME_TTL_HOURS}h links) via ${base}:`);
  for (const t of targets) console.log(`  ${t.full_name} <${t.email}>`);
  if (dryRun) return;

  const forgot = await fetch(`${base}/forgot-password`, { redirect: "manual" });
  if (forgot.status !== 200) throw new Error(`${base} isn't serving the reset flow (status ${forgot.status}).`);

  // Create and verify every link first; send only if all are good.
  const links: { email: string; full_name: string; url: string }[] = [];
  for (const t of targets) {
    const created = await createPasswordResetToken(t.email, WELCOME_TTL_HOURS * 60 * 60 * 1000);
    if (!created) throw new Error(`No account for ${t.email}`);
    const url = `${base}/reset-password?token=${created.token}`;
    const check = await fetch(url, { redirect: "manual" });
    if (check.status !== 200) {
      throw new Error(`${base} rejected the new link for ${t.email} (status ${check.status}) — wrong DATABASE_URL? Nothing sent.`);
    }
    links.push({ email: created.person.email, full_name: created.person.full_name, url });
  }

  for (const l of links) {
    await sendWelcomeEmail(l.email, l.full_name, l.url, {
      signInUrl: `${base}/login`,
      expiresInHours: WELCOME_TTL_HOURS,
    });
    console.log(`sent → ${l.email}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
