import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { requirePerm } from "../rbac.js";
import { vestingProceeds } from "../policy.js";
import { getCycle, policyForCycle } from "./reviewService.js";
import { assertCycleAdopted } from "./cycleGuards.js";
import { id, nowIso } from "../util.js";

export async function confirmScheduleA(
  actorId: string,
  equityAccountId: string,
  input: {
    certificateOrBookEntry: string;
    totalShares: number;
    pastContributionShares: number;
    serviceShares: number;
  }
) {
  await requirePerm(actorId, "equity.manage");
  if (input.pastContributionShares + input.serviceShares !== input.totalShares) {
    throw Object.assign(new Error("past + service must equal total"), { status: 400 });
  }
  const before = await prisma.equityAccount.findUnique({ where: { id: equityAccountId } });
  await prisma.equityAccount.update({
    where: { id: equityAccountId },
    data: {
      certificate_or_book_entry: input.certificateOrBookEntry,
      total_shares: input.totalShares,
      past_contribution_shares: input.pastContributionShares,
      service_shares: input.serviceShares,
      vested_shares: input.pastContributionShares,
      unvested_shares: input.serviceShares,
      schedule_a_confirmed: 1,
    },
  });
  await audit({
    actorId,
    action: "equity.confirm_schedule_a",
    entityType: "equity_account",
    entityId: equityAccountId,
    before,
    after: input,
    reason: "Board-confirmed Schedule A",
  });
}

export function installmentShares(serviceShares: number, installments: number) {
  return Math.floor(serviceShares / installments);
}

/** Pure rule used by issueVestingForCycle and tests. */
export function shouldSkipVestingForAccount(input: {
  cycleStatus: string;
  existingRecordForCycle: boolean;
}) {
  if (input.cycleStatus === "vesting_closed") return true;
  if (input.existingRecordForCycle) return true;
  return false;
}

export async function issueVestingForCycle(actorId: string, cycleId: string) {
  await requirePerm(actorId, "equity.manage");
  const cycle = await getCycle(cycleId);
  assertCycleAdopted(cycle);
  const policy = await policyForCycle(cycle);
  if (!cycle.ratings_published) {
    throw Object.assign(new Error("Publish ratings before issuing vesting records"), { status: 400 });
  }
  if (cycle.status === "vesting_closed") {
    throw Object.assign(new Error("Vesting already issued for this cycle"), { status: 400 });
  }

  const accounts = await prisma.equityAccount.findMany({
    where: { employment: { subject_to_founder_review: 1 } },
    include: {
      employment: {
        select: {
          id: true,
          qualifying_service: true,
          person: { select: { full_name: true } },
        },
      },
    },
  });

  const results: unknown[] = [];
  await prisma.$transaction(async (tx) => {
    for (const account of accounts) {
      const employment_id = account.employment.id;
      const full_name = account.employment.person.full_name;
      const existing = await tx.vestingRecord.findFirst({
        where: { equity_account_id: account.id, cycle_id: cycleId },
        select: { id: true, status: true, hold_reason: true, shares_vested: true },
      });
      if (
        shouldSkipVestingForAccount({
          cycleStatus: cycle.status,
          existingRecordForCycle: Boolean(existing),
        })
      ) {
        results.push({
          person: full_name,
          status: "skipped",
          reason: "Vesting record already exists for this cycle",
        });
        continue;
      }

      const vote = await tx.reviewVote.findUnique({
        where: {
          cycle_id_subject_employment_id: { cycle_id: cycleId, subject_employment_id: employment_id },
        },
        select: { rating: true, consequence: true },
      });

      const proceeds =
        account.employment.qualifying_service === 1 &&
        vestingProceeds(policy, vote?.rating ?? null, vote?.consequence ?? null, account.vesting_suspended === 1);

      const holdRecord = async (holdReason: string) => {
        await tx.vestingRecord.create({
          data: {
            id: id("vest"),
            equity_account_id: account.id,
            cycle_id: cycleId,
            vesting_date: cycle.vesting_date,
            shares_vested: 0,
            vested_total: account.vested_shares,
            unvested_remainder: account.unvested_shares,
            certificate_or_book_entry: account.certificate_or_book_entry,
            legends: account.legends,
            escrow_note: account.schedule_a_confirmed ? "Certificate unchanged; unvested remainder remains in escrow" : "No certificate update",
            status: "hold",
            hold_reason: holdReason,
            created_at: nowIso(),
          },
        });
      };

      if (!account.schedule_a_confirmed) {
        await holdRecord("Schedule A not confirmed");
        results.push({ person: full_name, status: "hold", reason: "Schedule A not confirmed" });
        continue;
      }

      if (!proceeds) {
        const reason =
          account.vesting_suspended || vote?.consequence === "pip_trigger"
            ? "Vesting suspension / PIP trigger"
            : account.employment.qualifying_service !== 1
              ? "Not in Qualifying Service"
              : "Rating blocked vesting";
        await holdRecord(reason);
        results.push({ person: full_name, status: "hold", reason });
        continue;
      }

      const tranche = installmentShares(account.service_shares, policy.fiscal.service_installments);
      const vestedTotal = account.vested_shares + tranche;
      const unvestedRemainder = Math.max(0, account.unvested_shares - tranche);
      await tx.equityAccount.update({
        where: { id: account.id },
        data: { vested_shares: vestedTotal, unvested_shares: unvestedRemainder },
      });
      await tx.vestingRecord.create({
        data: {
          id: id("vest"),
          equity_account_id: account.id,
          cycle_id: cycleId,
          vesting_date: cycle.vesting_date,
          shares_vested: tranche,
          vested_total: vestedTotal,
          unvested_remainder: unvestedRemainder,
          certificate_or_book_entry: account.certificate_or_book_entry,
          legends: account.legends,
          escrow_note:
            "Secretary updates ledger; vested portion released from escrow; unvested remainder remains in escrow. No new shares issued.",
          status: "issued",
          hold_reason: null,
          created_at: nowIso(),
        },
      });
      results.push({ person: full_name, status: "issued", tranche, vestedTotal, unvestedRemainder });
    }
    await tx.reviewCycle.update({
      where: { id: cycleId },
      data: { status: "vesting_closed" },
    });
  });
  await audit({ actorId, action: "equity.issue_vesting_cycle", entityType: "review_cycle", entityId: cycleId, after: results });
  return results;
}
