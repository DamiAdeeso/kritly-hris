import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { prisma } from "./db.js";
import { id, nowIso, verifyPassword, hashPassword } from "./util.js";
import { can, type PermissionKey } from "./rbac.js";

export type Person = {
  id: string;
  full_name: string;
  email: string;
  is_director: number;
  is_founder: number;
};

declare global {
  namespace Express {
    interface Request {
      person?: Person;
    }
  }
}

export async function login(email: string, password: string): Promise<{ token: string; person: Person } | null> {
  const row = await prisma.person.findUnique({ where: { email } });
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const token = id("sess");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  await prisma.session.create({
    data: { token, person_id: row.id, expires_at: expires },
  });
  const person: Person = {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    is_director: row.is_director,
    is_founder: row.is_founder,
  };
  return { token, person };
}

export async function logout(token: string) {
  await prisma.session.deleteMany({ where: { token } });
}

export async function loadSession(token?: string): Promise<Person | null> {
  if (!token) return null;
  const row = await prisma.session.findFirst({
    where: { token, expires_at: { gt: nowIso() } },
    include: { person: true },
  });
  if (!row) return null;
  const p = row.person;
  return {
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    is_director: p.is_director,
    is_founder: p.is_founder,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.hris_session as string | undefined;
  const person = await loadSession(token);
  if (!person) {
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.redirect("/login");
    return;
  }
  req.person = person;
  next();
}

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
export const WELCOME_TTL_HOURS = 24;
export const MIN_PASSWORD_LENGTH = 8;

/** Only a SHA-256 of the token is stored, so a DB read can't be replayed as a reset link. */
function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createPasswordResetToken(
  email: string,
  ttlMs: number = RESET_TTL_MS
): Promise<{ token: string; person: { full_name: string; email: string } } | null> {
  const row = await prisma.person.findUnique({
    where: { email: email.trim() },
    select: { id: true, full_name: true, email: true },
  });
  if (!row) return null;
  // Invalidate any prior unused tokens for this person
  await prisma.passwordResetToken.deleteMany({ where: { person_id: row.id, used_at: null } });
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      id: id("prt"),
      person_id: row.id,
      token: hashResetToken(token),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      created_at: nowIso(),
    },
  });
  return { token, person: { full_name: row.full_name, email: row.email } };
}

export async function validatePasswordResetToken(token: string): Promise<boolean> {
  if (!token) return false;
  const row = await prisma.passwordResetToken.findUnique({
    where: { token: hashResetToken(token) },
    select: { expires_at: true, used_at: true },
  });
  return Boolean(row && !row.used_at && row.expires_at >= nowIso());
}

export async function consumePasswordResetToken(token: string, newPassword: string): Promise<boolean> {
  if (!token) return false;
  const row = await prisma.passwordResetToken.findUnique({
    where: { token: hashResetToken(token) },
    select: { id: true, person_id: true, expires_at: true, used_at: true },
  });
  if (!row || row.used_at || row.expires_at < nowIso()) return false;
  // Conditional claim so two concurrent submits can't both succeed.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, used_at: null },
    data: { used_at: nowIso() },
  });
  if (claimed.count !== 1) return false;
  await prisma.$transaction([
    prisma.person.update({ where: { id: row.person_id }, data: { password_hash: hashPassword(newPassword) } }),
    // Sign out everywhere after a reset.
    prisma.session.deleteMany({ where: { person_id: row.person_id } }),
  ]);
  return true;
}

export function requireApiPerm(permission: PermissionKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.person) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!(await can(req.person.id, permission))) {
      res.status(403).json({ error: `Forbidden: ${permission}` });
      return;
    }
    next();
  };
}
