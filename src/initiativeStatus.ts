/**
 * Founder-reported progress on a task. Informational only: directors still decide the
 * final Done / Partial / Miss / Deferred score, and nothing else branches on this.
 */
export const INITIATIVE_STATUSES = ["not_started", "in_progress", "blocked", "done"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export const INITIATIVE_STATUS_TONE: Record<InitiativeStatus, "ok" | "warn" | "bad" | "neutral"> = {
  not_started: "neutral",
  in_progress: "warn",
  blocked: "bad",
  done: "ok",
};

/** Values written before the four-status model, mapped onto it. */
const LEGACY: Record<string, InitiativeStatus> = {
  on_track: "in_progress",
  at_risk: "blocked",
  off_track: "blocked",
};

export function isInitiativeStatus(value: unknown): value is InitiativeStatus {
  return typeof value === "string" && (INITIATIVE_STATUSES as readonly string[]).includes(value);
}

/** Read any stored value (including legacy ones) as one of the four statuses. */
export function normalizeInitiativeStatus(value: unknown): InitiativeStatus {
  if (isInitiativeStatus(value)) return value;
  if (typeof value === "string" && value in LEGACY) return LEGACY[value]!;
  return "not_started";
}
