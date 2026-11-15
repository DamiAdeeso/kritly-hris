import type { Request, Response, NextFunction } from "express";
import { prisma } from "./db.js";
import { id, nowIso, verifyPassword } from "./util.js";
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
