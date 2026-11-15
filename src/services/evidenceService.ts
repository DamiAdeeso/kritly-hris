import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { can } from "../rbac.js";
import { id, nowIso } from "../util.js";
import { isAffiliate } from "./reviewService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = path.join(__dirname, "..", "..", "data", "evidence");

export const EVIDENCE_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
]);

export const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;

export function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

export async function initiativeHasEvidence(initiativeId: string) {
  const row = await prisma.initiative.findUnique({
    where: { id: initiativeId },
    select: { evidence_ref: true },
  });
  if (String(row?.evidence_ref || "").trim()) return true;
  const files = await prisma.evidenceFile.count({ where: { initiative_id: initiativeId } });
  return files > 0;
}

export async function missingEvidenceCount(cycleId: string, employmentId: string) {
  const rows = await prisma.initiative.findMany({
    where: { cycle_id: cycleId, employment_id: employmentId },
    select: { id: true, evidence_ref: true },
  });
  let missing = 0;
  for (const r of rows) {
    if (String(r.evidence_ref || "").trim()) continue;
    const files = await prisma.evidenceFile.count({ where: { initiative_id: r.id } });
    if (files === 0) missing += 1;
  }
  return missing;
}

export async function listEvidenceFiles(initiativeId: string) {
  return prisma.evidenceFile.findMany({
    where: { initiative_id: initiativeId },
    orderBy: { created_at: "asc" },
  });
}

export async function saveEvidenceFile(input: {
  initiativeId: string;
  uploaderId: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  buffer: Buffer;
}) {
  if (!EVIDENCE_ALLOWED_MIME.has(input.mime) && !input.originalName.match(/\.(pdf|png|jpe?g|docx|txt|md)$/i)) {
    throw Object.assign(new Error("File type not allowed"), { status: 400 });
  }
  if (input.sizeBytes > EVIDENCE_MAX_BYTES) {
    throw Object.assign(new Error("File exceeds 15 MB limit"), { status: 400 });
  }
  ensureEvidenceDir();
  const fileId = id("efile");
  const ext = path.extname(input.originalName).slice(0, 12) || ".bin";
  const storedName = `${fileId}${ext}`;
  const dest = path.join(EVIDENCE_DIR, storedName);
  fs.writeFileSync(dest, input.buffer);
  await prisma.evidenceFile.create({
    data: {
      id: fileId,
      initiative_id: input.initiativeId,
      original_name: input.originalName,
      stored_name: storedName,
      mime: input.mime || "application/octet-stream",
      size_bytes: input.sizeBytes,
      uploaded_by: input.uploaderId,
      created_at: nowIso(),
    },
  });
  return fileId;
}

export async function canAccessEvidenceFile(viewerId: string, fileId: string) {
  const file = await prisma.evidenceFile.findUnique({
    where: { id: fileId },
    include: {
      initiative: {
        include: {
          employment: { select: { person_id: true } },
        },
      },
    },
  });
  if (!file) return null;
  const ownerId = file.initiative.employment.person_id;
  if (ownerId === viewerId) return file;
  if (await can(viewerId, "memo.read_all")) return file;
  if (await can(viewerId, "score.seal")) {
    if (viewerId === ownerId) return null;
    if (await isAffiliate(viewerId, ownerId)) return null;
    return file;
  }
  return null;
}

export function absoluteEvidencePath(storedName: string) {
  const base = path.resolve(EVIDENCE_DIR);
  const full = path.resolve(path.join(EVIDENCE_DIR, storedName));
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
  return full;
}
