import { prisma } from "./db.js";
import { id, nowIso } from "./util.js";

export async function audit(input: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  await prisma.auditEvent.create({
    data: {
      id: id("aud"),
      actor_id: input.actorId ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      before_json: input.before ? JSON.stringify(input.before) : null,
      after_json: input.after ? JSON.stringify(input.after) : null,
      reason: input.reason ?? null,
      created_at: nowIso(),
    },
  });
}
