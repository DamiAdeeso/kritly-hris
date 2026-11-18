/**
 * Remove evidence_files rows whose bytes were on Render's ephemeral disk (storage = 'local')
 * and ask each uploader to re-upload that file.
 *
 *   npm run evidence:clear-lost -- --dry-run
 *   npm run evidence:clear-lost -- --confirm
 *
 * Run against the DB the deployed app reads, and only after the S3-backed build is live,
 * so the re-uploads land somewhere durable. Each removed row is first written to
 * data/backups/ (gitignored) so nothing is lost without a record.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";
import { notifyPerson } from "./services/notificationService.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const confirm = args.includes("--confirm");

async function main() {
  if (!dryRun && !confirm) throw new Error("Pass --dry-run to preview or --confirm to clear.");

  const rows = await prisma.evidenceFile.findMany({
    where: { storage: "local" },
    include: {
      initiative: { select: { id: true, title: true, cycle_id: true } },
      uploader: { select: { full_name: true, email: true } },
    },
    orderBy: { created_at: "asc" },
  });
  const host = (process.env.DATABASE_URL || "").replace(/^.*@([^/?]+).*$/, "$1");
  console.log(`DB ${host}: ${rows.length} evidence file(s) stored on local disk`);
  for (const r of rows) {
    console.log(`  ${r.created_at}  ${r.uploader.full_name}  "${r.original_name}"  → ${r.initiative.title}`);
  }
  if (dryRun || rows.length === 0) return;

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `evidence_files_local_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`Backup: ${backup}`);

  for (const r of rows) {
    await prisma.evidenceFile.delete({ where: { id: r.id } });
    await notifyPerson({
      personId: r.uploaded_by,
      kind: "evidence",
      title: `Please re-upload "${r.original_name}"`,
      body: `A storage problem lost this file for "${r.initiative.title}". Uploads are now stored durably — attach it again under My evidence.`,
      href: `/performance/${r.initiative.cycle_id}/self#ini-${r.initiative.id}`,
      dedupeKey: `evidence_reupload:${r.id}`,
    });
    console.log(`cleared ${r.id} and notified ${r.uploader.email}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
