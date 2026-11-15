import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requiredMajority, voteFailedCanRescore } from "./services/reviewService.js";
import { consequenceForRating, vestingProceeds, DEFAULT_POLICY } from "./policy.js";
import { shouldSkipVestingForAccount } from "./services/equityService.js";

describe("requiredMajority", () => {
  it("rounds up to simple majority", () => {
    assert.equal(requiredMajority(4), 3);
    assert.equal(requiredMajority(5), 3);
    assert.equal(requiredMajority(1), 1);
  });
});

describe("consequenceForRating", () => {
  it("returns observation on first rating of 2", () => {
    assert.equal(consequenceForRating(DEFAULT_POLICY, 2, null), "observation");
  });
  it("returns pip_trigger on rating 1", () => {
    assert.equal(consequenceForRating(DEFAULT_POLICY, 1, null), "pip_trigger");
  });
  it("returns pip_trigger on second consecutive ≤2", () => {
    assert.equal(consequenceForRating(DEFAULT_POLICY, 2, 2), "pip_trigger");
  });
  it("returns none for strong ratings", () => {
    assert.equal(consequenceForRating(DEFAULT_POLICY, 4, 3), "none");
  });
});

describe("vestingProceeds", () => {
  it("continues on rating ≥3", () => {
    assert.equal(vestingProceeds(DEFAULT_POLICY, 3, "none", false), true);
  });
  it("continues on first observation", () => {
    assert.equal(vestingProceeds(DEFAULT_POLICY, 2, "observation", false), true);
  });
  it("stops on pip_trigger", () => {
    assert.equal(vestingProceeds(DEFAULT_POLICY, 1, "pip_trigger", false), false);
  });
  it("stops when suspended", () => {
    assert.equal(vestingProceeds(DEFAULT_POLICY, 5, "none", true), false);
  });
});

describe("voteFailedCanRescore", () => {
  it("allows return when all voted and accepts below majority", () => {
    assert.equal(
      voteFailedCanRescore({
        eligibleCount: 4,
        ballotCount: 4,
        acceptCount: 1,
        need: 3,
        alreadyAdopted: false,
      }),
      true
    );
  });
  it("blocks while ballots are incomplete", () => {
    assert.equal(
      voteFailedCanRescore({
        eligibleCount: 4,
        ballotCount: 3,
        acceptCount: 1,
        need: 3,
        alreadyAdopted: false,
      }),
      false
    );
  });
  it("blocks once adopted", () => {
    assert.equal(
      voteFailedCanRescore({
        eligibleCount: 4,
        ballotCount: 4,
        acceptCount: 1,
        need: 3,
        alreadyAdopted: true,
      }),
      false
    );
  });
});

describe("shouldSkipVestingForAccount", () => {
  it("skips when cycle already closed", () => {
    assert.equal(shouldSkipVestingForAccount({ cycleStatus: "vesting_closed", existingRecordForCycle: false }), true);
  });
  it("skips when a record already exists", () => {
    assert.equal(shouldSkipVestingForAccount({ cycleStatus: "rated", existingRecordForCycle: true }), true);
  });
  it("allows first issue", () => {
    assert.equal(shouldSkipVestingForAccount({ cycleStatus: "rated", existingRecordForCycle: false }), false);
  });
});
