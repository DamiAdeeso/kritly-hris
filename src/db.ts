import "./loadEnv.js";
import { PrismaClient } from "./generated/prisma/index.js";

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error(
    "DATABASE_URL is not set. Copy hris/.env.example to hris/.env (or reuse kritly/.env)."
  );
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.HRIS_PRISMA_LOG === "1" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** @deprecated Use `prisma` — kept temporarily while services finish migrating. */
export const db = prisma;

/** No-op: schema is applied via `prisma migrate` / `db push`. */
export async function migrate() {
  // Connectivity check so boot fails fast if DATABASE_URL is wrong.
  await prisma.$queryRaw`SELECT 1`;
}
