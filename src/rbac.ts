import { prisma } from "./db.js";
import { id } from "./util.js";

export const PERMISSIONS = [
  { key: "people.read", description: "View people directory" },
  { key: "people.write", description: "Create and update people and employment" },
  { key: "policy.read", description: "View policy versions" },
  { key: "policy.manage", description: "Create and activate living policy versions" },
  { key: "cycle.manage", description: "Open cycles and adopt assignment records" },
  { key: "initiative.write_own", description: "Update own initiatives, status, evidence, self-assessment" },
  { key: "score.seal", description: "Submit sealed score sheets for others" },
  { key: "review.vote", description: "Vote ratings when disinterested" },
  { key: "review.publish", description: "Publish ratings and deliver memos" },
  { key: "memo.read_own", description: "Read own delivered memo" },
  { key: "memo.read_all", description: "Read all memos" },
  { key: "equity.read", description: "View equity accounts" },
  { key: "equity.manage", description: "Confirm Schedule A and issue vesting records" },
  { key: "finance.read", description: "View founder cash calls" },
  { key: "finance.manage", description: "Issue cash calls and record any payment" },
  { key: "audit.read", description: "Read audit log" },
  { key: "roles.manage", description: "Assign roles" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ROLE_DEFS: { key: string; name: string; description: string; permissions: PermissionKey[] }[] = [
  {
    key: "system_admin",
    name: "System Admin",
    description: "Full platform access",
    permissions: PERMISSIONS.map((p) => p.key),
  },
  {
    key: "policy_admin",
    name: "Policy Admin",
    description: "Living schedules / policy versions",
    permissions: ["people.read", "policy.read", "policy.manage", "audit.read", "cycle.manage"],
  },
  {
    key: "director",
    name: "Director",
    description: "Board director; votes when disinterested",
    permissions: [
      "people.read",
      "policy.read",
      "cycle.manage",
      "score.seal",
      "review.vote",
      "review.publish",
      "memo.read_all",
      "equity.read",
      "equity.manage",
      "finance.read",
      "finance.manage",
    ],
  },
  {
    key: "founder_operator",
    name: "Founder Operator",
    description: "Active founder subject to review",
    permissions: ["people.read", "initiative.write_own", "memo.read_own", "equity.read", "finance.read"],
  },
  {
    key: "hr_admin",
    name: "HR Admin",
    description: "People and employment administration",
    permissions: ["people.read", "people.write", "audit.read"],
  },
  {
    key: "equity_admin",
    name: "Equity Admin",
    description: "Stock ledger and vesting records",
    permissions: ["people.read", "equity.read", "equity.manage", "finance.read", "finance.manage", "memo.read_all", "audit.read"],
  },
  {
    key: "auditor",
    name: "Auditor",
    description: "Read-only governance access",
    permissions: ["people.read", "policy.read", "memo.read_all", "equity.read", "finance.read", "audit.read"],
  },
];

/** Insert any new permissions and refresh each role's bundle. Safe to run on every boot. */
export async function syncRolePermissions() {
  for (const p of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({ where: { key: p.key }, select: { id: true } });
    if (!existing) {
      await prisma.permission.create({
        data: { id: id("perm"), key: p.key, description: p.description },
      });
    }
  }
  for (const role of ROLE_DEFS) {
    let roleRow = await prisma.role.findUnique({ where: { key: role.key }, select: { id: true } });
    if (!roleRow) {
      const rid = id("role");
      await prisma.role.create({
        data: { id: rid, key: role.key, name: role.name, description: role.description },
      });
      roleRow = { id: rid };
    }
    await prisma.rolePermission.deleteMany({ where: { role_id: roleRow.id } });
    for (const pk of role.permissions) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key: pk }, select: { id: true } });
      await prisma.rolePermission.createMany({
        data: [{ role_id: roleRow.id, permission_id: perm.id }],
        skipDuplicates: true,
      });
    }
  }
}

export async function personPermissionKeys(personId: string): Promise<Set<string>> {
  const rows = await prisma.personRole.findMany({
    where: { person_id: personId },
    select: {
      role: {
        select: {
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  });
  const keys = new Set<string>();
  for (const pr of rows) {
    for (const rp of pr.role.permissions) {
      keys.add(rp.permission.key);
    }
  }
  return keys;
}

export async function can(personId: string, permission: PermissionKey): Promise<boolean> {
  return (await personPermissionKeys(personId)).has(permission);
}

export async function requirePerm(personId: string, permission: PermissionKey) {
  if (!(await can(personId, permission))) {
    const err = new Error(`Forbidden: missing ${permission}`);
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}
