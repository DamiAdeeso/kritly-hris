import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Load hris/.env (and fall back to kritly/.env) before Prisma boots. */
export function loadEnv() {
  if (process.env.DATABASE_URL?.trim()) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", ".env"),
    path.join(here, "..", "..", "kritly", ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    if (process.env.DATABASE_URL?.trim()) return;
  }
}

loadEnv();
