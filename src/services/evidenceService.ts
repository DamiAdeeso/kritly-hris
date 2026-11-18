import path from "node:path";
import { prisma } from "../db.js";
import { can } from "../rbac.js";
import { id, nowIso } from "../util.js";
import { isAffiliate } from "./reviewService.js";
import { S3_STORAGE, deleteEvidence, putEvidence } from "./evidenceStorage.js";

export const EVIDENCE_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
]);

export const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;

/** A file counts as evidence only while its bytes are stored; pre-S3 rows were lost. */
export function isEvidenceAvailable(file: { storage: string }) {
  return file.storage === S3_STORAGE;
}

export async function initiativeHasEvidence(initiativeId: string) {
  const row = await prisma.initiative.findUnique({
    where: { id: initiativeId },
    select: { evidence_ref: true },
  });
  if (String(row?.evidence_ref || "").trim()) return true;
  const files = await prisma.evidenceFile.count({ where: { initiative_id: initiativeId, storage: S3_STORAGE } });
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
    const files = await prisma.evidenceFile.count({ where: { initiative_id: r.id, storage: S3_STORAGE } });
    if (files === 0) missing += 1;
  }
  return missing;
}

/**
 * A task's evidence files. A lost file is left out once a stored file with the same
 * name is on the same task: the founder has already uploaded it again.
 */
export async function listEvidenceFiles(initiativeId: string) {
  const files = await prisma.evidenceFile.findMany({
    where: { initiative_id: initiativeId },
    orderBy: { created_at: "asc" },
  });
  const reuploaded = new Set(files.filter(isEvidenceAvailable).map((f) => f.original_name));
  return files.filter((f) => isEvidenceAvailable(f) || !reuploaded.has(f.original_name));
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
  const fileId = id("efile");
  const ext = path.extname(input.originalName).slice(0, 12).replace(/[^.\w-]/g, "") || ".bin";
  const storedName = `${fileId}${ext}`;
  const mime = input.mime || "application/octet-stream";
  // Bytes first, then the row: a row never points at a file that was not stored.
  await putEvidence(storedName, input.buffer, mime);
  try {
    await prisma.evidenceFile.create({
      data: {
        id: fileId,
        initiative_id: input.initiativeId,
        original_name: input.originalName,
        stored_name: storedName,
        storage: S3_STORAGE,
        mime,
        size_bytes: input.sizeBytes,
        uploaded_by: input.uploaderId,
        created_at: nowIso(),
      },
    });
  } catch (err) {
    await deleteEvidence(storedName).catch(() => {});
    throw err;
  }
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
