import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectionFromPath } from "./selection.js";

describe("selectionFromPath", () => {
  it("reads cycle and employment from a vote route", () => {
    assert.deepEqual(
      selectionFromPath("/performance/cyc_1/subject/emp_2/vote"),
      { cycleId: "cyc_1", employmentId: "emp_2" }
    );
  });

  it("reads cash call id", () => {
    assert.deepEqual(selectionFromPath("/finance/calls/call_9"), {
      cashCallId: "call_9",
    });
  });
});
