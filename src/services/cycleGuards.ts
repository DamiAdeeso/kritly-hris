export function assertCycleAdopted(cycle: { status: string; assignment_adopted_at?: string | null }) {
  if (cycle.status === "draft" || !cycle.assignment_adopted_at) {
    throw Object.assign(new Error("Cycle assignments are not adopted yet"), { status: 400 });
  }
}
