import { prisma } from "../db.js";
import { id, nowIso } from "../util.js";
import type { SealedSheetBody } from "./deriveScores.js";

export type ScoreDraftBody = {
  initiatives: SealedSheetBody["initiatives"];
  dimensionScores: Record<string, number>;
  dimensionNotes: Record<string, string>;
  missedCriterion: string;
};

export const EMPTY_DRAFT: ScoreDraftBody = {
  initiatives: [],
  dimensionScores: {},
  dimensionNotes: {},
  missedCriterion: "",
};

export async function getScoreDraft(cycleId: string, subjectEmploymentId: string, scorerPersonId: string) {
  return prisma.scoreDraft.findUnique({
    where: {
      cycle_id_subject_employment_id_scorer_person_id: {
        cycle_id: cycleId,
        subject_employment_id: subjectEmploymentId,
        scorer_person_id: scorerPersonId,
      },
    },
  });
}

export function parseDraftBody(raw: string | null | undefined): ScoreDraftBody {
  if (!raw) return { ...EMPTY_DRAFT, initiatives: [], dimensionScores: {}, dimensionNotes: {} };
  try {
    const parsed = JSON.parse(raw) as ScoreDraftBody;
    return {
      initiatives: parsed.initiatives ?? [],
      dimensionScores: parsed.dimensionScores ?? {},
      dimensionNotes: parsed.dimensionNotes ?? {},
      missedCriterion: parsed.missedCriterion ?? "",
    };
  } catch {
    return { ...EMPTY_DRAFT, initiatives: [], dimensionScores: {}, dimensionNotes: {} };
  }
}

export async function saveScoreDraft(input: {
  cycleId: string;
  subjectEmploymentId: string;
  scorerPersonId: string;
  body: ScoreDraftBody;
  step: number;
}) {
  const existing = await getScoreDraft(input.cycleId, input.subjectEmploymentId, input.scorerPersonId);
  const payload = JSON.stringify(input.body);
  if (existing) {
    await prisma.scoreDraft.update({
      where: { id: existing.id },
      data: { body_json: payload, step: input.step, updated_at: nowIso() },
    });
    return existing.id;
  }
  const did = id("draft");
  await prisma.scoreDraft.create({
    data: {
      id: did,
      cycle_id: input.cycleId,
      subject_employment_id: input.subjectEmploymentId,
      scorer_person_id: input.scorerPersonId,
      body_json: payload,
      step: input.step,
      updated_at: nowIso(),
    },
  });
  return did;
}

export async function clearScoreDraft(cycleId: string, subjectEmploymentId: string, scorerPersonId: string) {
  await prisma.scoreDraft.deleteMany({
    where: {
      cycle_id: cycleId,
      subject_employment_id: subjectEmploymentId,
      scorer_person_id: scorerPersonId,
    },
  });
}

export async function hasSealedSheet(cycleId: string, subjectEmploymentId: string, scorerPersonId: string) {
  const row = await prisma.sealedScoreSheet.findUnique({
    where: {
      cycle_id_subject_employment_id_scorer_person_id: {
        cycle_id: cycleId,
        subject_employment_id: subjectEmploymentId,
        scorer_person_id: scorerPersonId,
      },
    },
    select: { id: true },
  });
  return Boolean(row);
}
