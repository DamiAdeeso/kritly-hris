import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, PolicyBodySchema, type PolicyBody } from "./policy.js";
import { buildDecisionBoard, sheetsNeededToVote, votingOpens } from "./services/deriveScores.js";

function sheet(scorerId: string, score: number) {
  const dimensionScores: Record<string, number> = {};
  for (const d of DEFAULT_POLICY.dimensions) dimensionScores[d.key] = score;
  return {
    scorer_person_id: scorerId,
    scorer_name: scorerId,
    body_json: JSON.stringify({ initiatives: [], dimensionScores, dimensionNotes: {} }),
  };
}

const eligible = [
  { id: "p_a", full_name: "A" },
  { id: "p_b", full_name: "B" },
  { id: "p_c", full_name: "C" },
];

function withMin(n: number): PolicyBody {
  return { ...DEFAULT_POLICY, voting: { ...DEFAULT_POLICY.voting, min_sealed_sheets_to_vote: n } };
}

describe("accept the average without scoring", () => {
  it("opens voting after one sealed sheet by default", () => {
    assert.equal(sheetsNeededToVote(DEFAULT_POLICY, 3), 1);
    assert.equal(votingOpens(DEFAULT_POLICY, 3, 0), false);
    assert.equal(votingOpens(DEFAULT_POLICY, 3, 1), true);
  });

  it("honours a higher policy minimum, capped at the eligible count", () => {
    assert.equal(votingOpens(withMin(2), 3, 1), false);
    assert.equal(votingOpens(withMin(2), 3, 2), true);
    assert.equal(sheetsNeededToVote(withMin(5), 3), 3);
  });

  it("never opens with no disinterested directors", () => {
    assert.equal(votingOpens(DEFAULT_POLICY, 0, 0), false);
  });

  it("existing stored policies without the field parse to a minimum of 1", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_POLICY));
    delete stored.voting.min_sealed_sheets_to_vote;
    assert.equal(PolicyBodySchema.parse(stored).voting.min_sealed_sheets_to_vote, 1);
  });

  it("ignores sheets from recused directors (affiliates) when averaging", () => {
    const board = buildDecisionBoard({
      policy: DEFAULT_POLICY,
      eligible,
      sheets: [sheet("p_a", 4), sheet("p_affiliate", 1)],
    });
    assert.equal(board.sheetCount, 1);
    assert.equal(board.derivedAverageRating, 4);
    assert.equal(board.votingOpen, true);
  });
});
