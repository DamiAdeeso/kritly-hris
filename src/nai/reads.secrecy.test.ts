import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("Nai read secrecy", () => {
  it("vote-status handler omits rating and sealed sheet fields in source", () => {
    const src = fs.readFileSync(path.join(here, "reads.ts"), "utf8");
    const voteBlock = src.slice(
      src.indexOf("/api/nai/cycles/:cycleId/subjects/:employmentId/vote-status"),
      src.indexOf("/api/nai/cycles/:cycleId/score-progress")
    );
    assert.match(voteBlock, /canVote/);
    assert.doesNotMatch(voteBlock, /\brating\b/i);
    assert.doesNotMatch(voteBlock, /sealedScoreSheet|body_json/);
  });

  it("cash-call handler filters lines to the viewer", () => {
    const src = fs.readFileSync(path.join(here, "reads.ts"), "utf8");
    const block = src.slice(
      src.indexOf("/api/nai/cash-calls/:id"),
      src.indexOf("/api/nai/accounts")
    );
    assert.match(block, /finance\.manage/);
    assert.match(block, /person_id === personId/);
  });
});
