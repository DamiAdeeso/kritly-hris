import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY } from "./policy.js";
import { buildDecisionBoard, buildMemoFeedback } from "./services/deriveScores.js";

function sheet(scorerId: string, scorerName: string, score: number, note: string) {
  const dimensionScores: Record<string, number> = {};
  const dimensionNotes: Record<string, string> = {};
  for (const d of DEFAULT_POLICY.dimensions) {
    dimensionScores[d.key] = score;
    dimensionNotes[d.key] = `${note} on ${d.key}`;
  }
  return {
    scorer_person_id: scorerId,
    scorer_name: scorerName,
    body_json: JSON.stringify({ initiatives: [], dimensionScores, dimensionNotes }),
  };
}

const board = buildDecisionBoard({
  policy: DEFAULT_POLICY,
  eligible: [
    { id: "p_ada", full_name: "Ada Lovelace" },
    { id: "p_bob", full_name: "Bob Builder" },
  ],
  sheets: [sheet("p_ada", "Ada Lovelace", 4, "Strong"), sheet("p_bob", "Bob Builder", 2, "Needs work")],
});

describe("buildMemoFeedback", () => {
  it("covers every policy dimension with its readable label and board average", () => {
    const feedback = buildMemoFeedback(board, DEFAULT_POLICY);
    assert.deepEqual(
      feedback.map((d) => d.label),
      DEFAULT_POLICY.dimensions.map((d) => d.label)
    );
    assert.ok(feedback.every((d) => d.average === 3));
  });

  it("never names a director", () => {
    const text = JSON.stringify(buildMemoFeedback(board, DEFAULT_POLICY));
    assert.ok(!text.includes("Ada") && !text.includes("Bob") && !text.includes("p_ada"));
    assert.ok(text.includes("Director A") && text.includes("Director B"));
  });

  it("carries each director's score and written note under one label across dimensions", () => {
    const feedback = buildMemoFeedback(board, DEFAULT_POLICY);
    for (const dim of feedback) {
      const strong = dim.directors.find((d) => d.note.startsWith("Strong"))!;
      assert.equal(strong.score, 4);
      assert.equal(strong.note, `Strong on ${dim.key}`);
      assert.equal(strong.label, feedback[0]!.directors.find((d) => d.note.startsWith("Strong"))!.label);
    }
  });

  it("does not tie labels to name order", () => {
    const first = buildMemoFeedback(board, DEFAULT_POLICY, () => 0.99);
    const second = buildMemoFeedback(board, DEFAULT_POLICY, () => 0);
    const labelOfStrong = (f: typeof first) => f[0]!.directors.find((d) => d.note.startsWith("Strong"))!.label;
    assert.notEqual(labelOfStrong(first), labelOfStrong(second));
  });
});
