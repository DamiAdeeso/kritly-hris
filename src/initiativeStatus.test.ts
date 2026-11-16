import { test } from "node:test";
import assert from "node:assert/strict";
import { isInitiativeStatus, normalizeInitiativeStatus } from "./initiativeStatus.js";

test("accepts only the four statuses", () => {
  for (const s of ["not_started", "in_progress", "blocked", "done"]) assert.equal(isInitiativeStatus(s), true);
  for (const s of ["on_track", "at_risk", "off_track", "", "DONE", "<script>", null, undefined]) {
    assert.equal(isInitiativeStatus(s), false);
  }
});

test("maps legacy values onto the four statuses", () => {
  assert.equal(normalizeInitiativeStatus("on_track"), "in_progress");
  assert.equal(normalizeInitiativeStatus("at_risk"), "blocked");
  assert.equal(normalizeInitiativeStatus("off_track"), "blocked");
  assert.equal(normalizeInitiativeStatus("done"), "done");
  assert.equal(normalizeInitiativeStatus(null), "not_started");
  assert.equal(normalizeInitiativeStatus("garbage"), "not_started");
});
