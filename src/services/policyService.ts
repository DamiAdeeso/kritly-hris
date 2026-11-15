import { prisma } from "../db.js";
import { PolicyBodySchema, type PolicyBody, assertWeights } from "../policy.js";
import { audit } from "../audit.js";
import { id, nowIso } from "../util.js";
import { requirePerm } from "../rbac.js";

export async function getActivePolicy(): Promise<{ id: string; version: number; body: PolicyBody }> {
  const row = await prisma.policyVersion.findFirst({
    where: { active: 1 },
    select: { id: true, version: true, body_json: true },
  });
  if (!row) throw new Error("No active policy");
  return { id: row.id, version: row.version, body: PolicyBodySchema.parse(JSON.parse(row.body_json)) };
}

export async function getPolicyById(policyId: string): Promise<PolicyBody> {
  const row = await prisma.policyVersion.findUniqueOrThrow({
    where: { id: policyId },
    select: { body_json: true },
  });
  return PolicyBodySchema.parse(JSON.parse(row.body_json));
}

export async function createPolicyVersion(actorId: string, label: string, body: PolicyBody, activate: boolean) {
  await requirePerm(actorId, "policy.manage");
  assertWeights(body);
  const parsed = PolicyBodySchema.parse(body);
  if (parsed.fiscal.vesting_anchor_requires_consent_to_change) {
    const active = await getActivePolicy();
    if (active.body.fiscal.vesting_anchor_date !== parsed.fiscal.vesting_anchor_date) {
      throw Object.assign(new Error("Changing vesting_anchor_date requires affected founder consent (locked legal)"), {
        status: 400,
      });
    }
  }
  const agg = await prisma.policyVersion.aggregate({ _max: { version: true } });
  const version = (agg._max.version ?? 0) + 1;
  const pid = id("pol");
  await prisma.$transaction(async (tx) => {
    if (activate) {
      await tx.policyVersion.updateMany({ data: { active: 0 }, where: { active: 1 } });
    }
    await tx.policyVersion.create({
      data: {
        id: pid,
        version,
        label,
        body_json: JSON.stringify(parsed),
        active: activate ? 1 : 0,
        mutable_notes: parsed.locked_notes.join(" | "),
        created_by: actorId,
        created_at: nowIso(),
      },
    });
  });
  await audit({
    actorId,
    action: activate ? "policy.create_activate" : "policy.create",
    entityType: "policy_version",
    entityId: pid,
    after: parsed,
  });
  return { id: pid, version };
}
