/**
 * Platform Approvals SSO for HRIS-hosted workforce UI.
 * Env: WORKFORCE_API_URL (or PUBLIC_GATEWAY_URL), PLATFORM_LOGIN_URL
 */

import { randomBytes } from "node:crypto";

export const WORKFORCE_TOKEN_COOKIE = "hris_workforce_token";
export const WORKFORCE_SSO_STATE_COOKIE = "hris_workforce_sso_state";
export const WORKFORCE_SSO_NEXT_COOKIE = "hris_workforce_sso_next";

export type WorkforceSession = {
  accessToken: string;
  permissions: string[];
  user: { id: string; email: string; displayName?: string };
};

function gatewayBase(): string {
  return (process.env.WORKFORCE_API_URL || process.env.PUBLIC_GATEWAY_URL || "")
    .trim()
    .replace(/\/$/, "");
}

export function workforceSsoConfigured(): boolean {
  return Boolean(gatewayBase() && platformLoginUrl());
}

export function platformLoginUrl(): string {
  return (
    process.env.PLATFORM_LOGIN_URL?.trim() ||
    process.env.ADMIN_LOGIN_URL?.trim() ||
    "http://localhost:4201/login"
  );
}

export function hrisPublicOrigin(): string {
  return (
    process.env.HRIS_PUBLIC_URL?.trim() ||
    `http://localhost:${process.env.PORT || 4545}`
  ).replace(/\/$/, "");
}

export function approvalsCallbackUrl(): string {
  return `${hrisPublicOrigin()}/approvals/callback`;
}

export function buildPlatformLoginRedirect(input: {
  state: string;
}): string {
  const url = new URL(platformLoginUrl());
  url.searchParams.set("return_uri", approvalsCallbackUrl());
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function newSsoState(): string {
  return randomBytes(24).toString("base64url");
}

export async function exchangeSsoCode(input: {
  code: string;
  state?: string;
}): Promise<WorkforceSession | null> {
  const base = gatewayBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/platform/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        returnUri: approvalsCallbackUrl(),
        state: input.state,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: WorkforceSession;
    };
    if (!res.ok || !body.data?.accessToken) return null;
    return body.data;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): { permissions?: string[]; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(json) as { permissions?: string[]; exp?: number };
  } catch {
    return null;
  }
}

export function decodeWorkforcePermissions(token: string | undefined): string[] {
  if (!token) return [];
  const payload = decodeJwtPayload(token);
  return Array.isArray(payload?.permissions) ? payload.permissions : [];
}

/** True when the cookie JWT is present and not near expiry. */
export function isWorkforceTokenFresh(token: string | undefined): boolean {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 60_000) {
    return false;
  }
  return true;
}

export function canShowApprovalsNav(permissions: string[]): boolean {
  return (
    permissions.includes("platform:approvals:read") ||
    permissions.includes("platform:approvals:decide") ||
    permissions.includes("platform:approvals:manage")
  );
}

export function gatewayPublicUrl(): string {
  return gatewayBase();
}
