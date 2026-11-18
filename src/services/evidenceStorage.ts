import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Evidence file bytes live in S3 only.
 *
 * Configured by S3_BUCKET + S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY
 * (EVIDENCE_S3_BUCKET / EVIDENCE_S3_REGION override the first two). Objects go under
 * EVIDENCE_S3_PREFIX (default "hris/evidence/") and stay private; downloads are
 * proxied through /evidence/:id so access checks still apply.
 *
 * Without S3 every upload fails, in every environment. There is no disk fallback:
 * Render wipes the disk on each deploy and idle restart, and a file that looks saved
 * but later vanishes is worse than an upload that fails and can be retried.
 *
 * evidence_files.storage records where a row's bytes are. Rows written before S3
 * carry 'local' and their bytes are gone; they read as unavailable.
 */
export const S3_STORAGE = "s3";

let client: S3Client | null | undefined;

function s3Config() {
  const bucket = process.env.EVIDENCE_S3_BUCKET?.trim() || process.env.S3_BUCKET?.trim();
  const region = process.env.EVIDENCE_S3_REGION?.trim() || process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  // Only an HRIS-specific endpoint is honoured (e.g. R2/MinIO). The shared S3_ENDPOINT
  // in kritly/.env points at the wrong region for the bucket and breaks signing.
  const endpoint = process.env.EVIDENCE_S3_ENDPOINT?.trim() || undefined;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return { bucket, region, accessKeyId, secretAccessKey, endpoint };
}

function s3() {
  if (client !== undefined) return client;
  const cfg = s3Config();
  client = cfg
    ? new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: Boolean(cfg.endpoint),
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      })
    : null;
  return client;
}

function prefix() {
  const p = process.env.EVIDENCE_S3_PREFIX?.trim() || "hris/evidence/";
  return p.endsWith("/") ? p : `${p}/`;
}

export function evidenceStorageConfigured() {
  return s3() !== null;
}

export function s3Key(storedName: string) {
  return `${prefix()}${storedName}`;
}

function requireS3() {
  const c = s3();
  const cfg = s3Config();
  if (!c || !cfg) {
    throw Object.assign(
      new Error("File uploads are unavailable right now. Add an evidence link instead, or try again later."),
      { status: 503 }
    );
  }
  return { c, bucket: cfg.bucket };
}

export async function putEvidence(storedName: string, buffer: Buffer, mime: string) {
  const { c, bucket } = requireS3();
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key(storedName),
      Body: buffer,
      ContentType: mime,
      ContentLength: buffer.length,
      ServerSideEncryption: "AES256",
    })
  );
}

export async function deleteEvidence(storedName: string) {
  const { c, bucket } = requireS3();
  await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(storedName) }));
}

/** Returns a readable stream, or null when the bytes are not in S3. */
export async function openEvidence(storage: string, storedName: string): Promise<Readable | null> {
  if (storage !== S3_STORAGE) return null;
  const c = s3();
  const cfg = s3Config();
  if (!c || !cfg) return null;
  try {
    const out = await c.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: s3Key(storedName) }));
    return (out.Body as Readable) ?? null;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Logged at boot so a misconfigured deploy is obvious in the logs. */
export async function checkEvidenceStorage() {
  const cfg = s3Config();
  if (!cfg) {
    console.warn(
      "[evidence] S3 is NOT configured: evidence uploads will fail until S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are set."
    );
    return;
  }
  try {
    await s3()!.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    console.log(`[evidence] storing uploads in s3://${cfg.bucket}/${prefix()} (${cfg.region})`);
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    console.error(`[evidence] S3 bucket check failed (${e.name ?? "error"} ${e.$metadata?.httpStatusCode ?? ""}). Uploads will fail.`);
  }
}
