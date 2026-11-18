import type { PolicyBody } from "../policy.js";

export type InitiativeScoreValue = "Done" | "Partial" | "Miss" | "Deferred";

export type SealedSheetBody = {
  initiatives: Array<{
    initiativeId: string;
    title?: string;
    score: string;
    evidence?: string;
  }>;
  dimensionScores: Record<string, number>;
  dimensionNotes?: Record<string, string>;
  proposedRating?: number;
  missedCriterion?: string;
};

const INITIATIVE_RANK: Record<string, number> = {
  Done: 3,
  Partial: 2,
  Miss: 1,
};

export function clampRating(n: number) {
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Weighted overall from dimension scores 1–5. Deferred-style N/A dims are omitted. */
export function deriveOverallFromDimensions(
  dimensionScores: Record<string, number>,
  policy: PolicyBody
): { raw: number; rating: number; cappedByValues: boolean } {
  let weighted = 0;
  let weightSum = 0;
  for (const dim of policy.dimensions) {
    const score = Number(dimensionScores[dim.key]);
    if (!Number.isFinite(score) || score < 1 || score > 5) continue;
    weighted += score * dim.weight;
    weightSum += dim.weight;
  }
  const raw = weightSum > 0 ? weighted / weightSum : 3;
  let rating = clampRating(raw);
  const valuesScore = Number(dimensionScores.values);
  const cappedByValues = Number.isFinite(valuesScore) && valuesScore <= 2;
  if (cappedByValues) rating = Math.min(rating, policy.values_cap_rating);
  return { raw, rating, cappedByValues };
}

export function parseSealedBody(raw: string | SealedSheetBody): SealedSheetBody | null {
  try {
    const body = typeof raw === "string" ? (JSON.parse(raw) as SealedSheetBody) : raw;
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

export function normalizeSheet(body: SealedSheetBody, policy: PolicyBody): SealedSheetBody & {
  derivedRating: number;
  derivedRaw: number;
  cappedByValues: boolean;
} {
  const dimensionScores: Record<string, number> = {};
  for (const dim of policy.dimensions) {
    const fromField = Number(body.dimensionScores?.[dim.key]);
    if (Number.isFinite(fromField) && fromField >= 1 && fromField <= 5) {
      dimensionScores[dim.key] = fromField;
      continue;
    }
    // Legacy sheets: fall back to proposedRating for every dimension
    const fallback = Number(body.proposedRating);
    dimensionScores[dim.key] = Number.isFinite(fallback) ? clampRating(fallback) : 3;
  }
  const derived = deriveOverallFromDimensions(dimensionScores, policy);
  return {
    ...body,
    dimensionScores,
    derivedRating: derived.rating,
    derivedRaw: derived.raw,
    cappedByValues: derived.cappedByValues,
  };
}

/** Sealed sheets required before voting opens: the policy minimum, never more than the eligible directors. */
export function sheetsNeededToVote(policy: PolicyBody, eligibleCount: number) {
  return Math.min(Math.max(1, policy.voting.min_sealed_sheets_to_vote), eligibleCount);
}

/** Voting on the average opens once the minimum number of eligible directors have sealed a sheet. */
export function votingOpens(policy: PolicyBody, eligibleCount: number, eligibleSheetCount: number) {
  return eligibleCount > 0 && eligibleSheetCount >= sheetsNeededToVote(policy, eligibleCount);
}

export type DecisionBoard = {
  eligibleCount: number;
  sheetCount: number;
  /** Sealed sheets needed before voting opens (policy minimum, capped at the eligible count). */
  sheetsNeeded: number;
  /** Enough sealed sheets are in for disinterested directors to accept or decline the average. */
  votingOpen: boolean;
  perScorer: Array<{
    scorerId: string;
    scorerName: string;
    derivedRating: number;
    derivedRaw: number;
    cappedByValues: boolean;
    proposedRating: number;
    missedCriterion: string;
    dimensionScores: Record<string, number>;
    dimensionNotes: Record<string, string>;
    initiatives: SealedSheetBody["initiatives"];
  }>;
  averageRaw: number;
  derivedAverageRating: number;
  initiativeConsensus: Array<{
    initiativeId: string;
    title: string;
    score: InitiativeScoreValue;
    evidence: string;
    tallies: Record<string, number>;
  }>;
  dimensionAverages: Record<string, number>;
  suggestedMissedCriterion: string;
};

export function buildDecisionBoard(input: {
  policy: PolicyBody;
  eligible: Array<{ id: string; full_name: string }>;
  sheets: Array<{ scorer_person_id: string; scorer_name: string; body_json: string }>;
}): DecisionBoard {
  const { policy, eligible } = input;
  // Only Disinterested Directors' sheets feed the average (Founders' Agreement §7.4).
  const eligibleIds = new Set(eligible.map((e) => e.id));
  const sheets = input.sheets.filter((s) => eligibleIds.has(s.scorer_person_id));
  const perScorer = sheets.map((s) => {
    const parsed = parseSealedBody(s.body_json) ?? {
      initiatives: [],
      dimensionScores: {},
    };
    const norm = normalizeSheet(parsed, policy);
    return {
      scorerId: s.scorer_person_id,
      scorerName: s.scorer_name,
      derivedRating: norm.derivedRating,
      derivedRaw: norm.derivedRaw,
      cappedByValues: norm.cappedByValues,
      proposedRating: norm.derivedRating,
      missedCriterion: String(norm.missedCriterion ?? ""),
      dimensionScores: norm.dimensionScores,
      dimensionNotes: norm.dimensionNotes ?? {},
      initiatives: norm.initiatives ?? [],
    };
  });

  const averageRaw =
    perScorer.length === 0 ? 0 : perScorer.reduce((a, s) => a + s.derivedRaw, 0) / perScorer.length;
  let derivedAverageRating = 0;
  if (perScorer.length > 0) {
    derivedAverageRating = clampRating(averageRaw);
    if (perScorer.some((s) => s.cappedByValues)) {
      derivedAverageRating = Math.min(derivedAverageRating, policy.values_cap_rating);
    }
  }

  const dimensionAverages: Record<string, number> = {};
  for (const dim of policy.dimensions) {
    const vals = perScorer.map((s) => s.dimensionScores[dim.key]).filter((n) => Number.isFinite(n));
    dimensionAverages[dim.key] =
      vals.length === 0 ? 0 : Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }

  const byInitiative = new Map<
    string,
    { title: string; tallies: Record<string, number>; evidences: string[] }
  >();
  for (const scorer of perScorer) {
    for (const ini of scorer.initiatives) {
      const cur = byInitiative.get(ini.initiativeId) ?? {
        title: ini.title || ini.initiativeId,
        tallies: {},
        evidences: [],
      };
      const score = String(ini.score || "Miss");
      cur.tallies[score] = (cur.tallies[score] || 0) + 1;
      if (ini.evidence) cur.evidences.push(ini.evidence);
      if (ini.title) cur.title = ini.title;
      byInitiative.set(ini.initiativeId, cur);
    }
  }

  const initiativeConsensus = [...byInitiative.entries()].map(([initiativeId, data]) => {
    let best: InitiativeScoreValue = "Miss";
    let bestCount = -1;
    let bestRank = -1;
    for (const [score, count] of Object.entries(data.tallies)) {
      if (score === "Deferred") continue;
      const rank = INITIATIVE_RANK[score] ?? 0;
      if (count > bestCount || (count === bestCount && rank > bestRank)) {
        best = score as InitiativeScoreValue;
        bestCount = count;
        bestRank = rank;
      }
    }
    if (bestCount < 0 && data.tallies.Deferred) best = "Deferred";
    return {
      initiativeId,
      title: data.title,
      score: best,
      evidence: data.evidences[0] || "",
      tallies: data.tallies,
    };
  });

  const low = perScorer.filter((s) => s.derivedRating <= 2 && s.missedCriterion);
  const suggestedMissedCriterion = low[0]?.missedCriterion || "";

  return {
    eligibleCount: eligible.length,
    sheetCount: perScorer.length,
    sheetsNeeded: sheetsNeededToVote(policy, eligible.length),
    votingOpen: votingOpens(policy, eligible.length, perScorer.length),
    perScorer,
    averageRaw,
    derivedAverageRating,
    initiativeConsensus,
    dimensionAverages,
    suggestedMissedCriterion,
  };
}

/** What the founder reads per dimension: the board average and each director's score and note, unnamed. */
export type MemoFeedback = Array<{
  key: string;
  label: string;
  average: number;
  directors: Array<{ label: string; score: number | null; note: string }>;
}>;

/**
 * Director feedback for the founder's memo. Directors are labelled "Director A", "Director B", …
 * in a random order (the same label across every dimension), so the label carries no hint of
 * who wrote what.
 */
export function buildMemoFeedback(
  board: DecisionBoard,
  policy: PolicyBody,
  random: () => number = Math.random
): MemoFeedback {
  const scorers = [...board.perScorer];
  for (let i = scorers.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [scorers[i], scorers[j]] = [scorers[j]!, scorers[i]!];
  }
  const labelled = scorers.map((s, i) => ({ s, label: `Director ${String.fromCharCode(65 + i)}` }));
  return policy.dimensions.map((dim) => ({
    key: dim.key,
    label: dim.label,
    average: board.dimensionAverages[dim.key] ?? 0,
    directors: labelled.map(({ s, label }) => {
      const score = Number(s.dimensionScores[dim.key]);
      return {
        label,
        score: Number.isFinite(score) ? score : null,
        note: String(s.dimensionNotes[dim.key] ?? "").trim(),
      };
    }),
  }));
}
