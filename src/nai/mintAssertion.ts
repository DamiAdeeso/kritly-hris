import { createHmac } from "node:crypto";
import { personPermissionKeys } from "../rbac.js";

const NAI_SERVICE_AUDIENCE = "nai-service";
const TTL_SECONDS = 60;

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

/**
 * Mint a short-lived nai-service assertion for the signed-in HRIS person.
 * Matches the claim shape in @commerce-automation/nai-contracts mintNaiAssertion.
 */
export async function mintHrisNaiAssertion(input: {
  personId: string;
  fullName: string;
  roleKey?: string;
}): Promise<string | null> {
  const secret =
    process.env.NAI_INTERNAL_JWT_SECRET?.trim() ||
    process.env.NAI_SERVICE_KEY?.trim();
  if (!secret) return null;

  const basePerms = await personPermissionKeys(input.personId);
  const permissions = [...new Set([...basePerms, "nai:use", "nai:search"])];
  const now = Math.floor(Date.now() / 1000);
  const tenantId = process.env.HRIS_NAI_TENANT_ID?.trim() || "kritly";
  const claims = {
    iss: "hris",
    aud: NAI_SERVICE_AUDIENCE,
    iat: now,
    exp: now + TTL_SECONDS,
    tenantId,
    applicationId: "hris",
    principal: {
      keyId: input.personId,
      label: input.fullName,
      role: input.roleKey || "founder_operator",
      tenantId,
      scopes: ["nai:use", "nai:search"],
      permissions,
    },
    scopes: ["nai:use", "nai:search"],
    permissions,
    readOnly: true,
  };
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

export function naiServiceUrl(): string {
  return (process.env.NAI_SERVICE_URL ?? "http://127.0.0.1:3101").replace(/\/$/, "");
}
