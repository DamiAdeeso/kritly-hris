/**
 * Locked Schedule A — Founders' Agreement (post–Founder Rebalance).
 * Source of truth: kritly/docs/governance/schedules/Schedule-A-Founder-Equity-Table.md
 * Absolute share numbers control. Past = 50% vested at Vesting Commencement Date (2026-08-15).
 * Service = 50% over 10 equal quarterly installments. First Vesting Date: 2026-11-21.
 */
export type ScheduleARow = {
  email: string;
  shortName: string;
  legalName: string;
  totalShares: number;
  pastContributionShares: number;
  serviceShares: number;
  quarterlyInstallment: number;
  bookEntry: string;
  aggregateCostUsd: number;
};

export const SCHEDULE_A_AUTHORIZED = 1000;
export const SCHEDULE_A_FOUNDER_OUTSTANDING = 900;
export const SCHEDULE_A_RESERVED_POOL = 100;
export const SCHEDULE_A_PAR_VALUE_USD = 2;
export const SCHEDULE_A_VESTING_COMMENCEMENT = "2026-08-15";
export const SCHEDULE_A_FIRST_VESTING_DATE = "2026-11-21";
export const SCHEDULE_A_SERVICE_INSTALLMENTS = 10;

/** Post-rebalance Founder Shares. Baseline before rebalance: 302 / 220 / 189 / 189. */
export const SCHEDULE_A: ScheduleARow[] = [
  {
    email: "damilolaadeeso@gmail.com",
    shortName: "Dami",
    legalName: "Oluwadamilola Caleb Adeeso",
    totalShares: 280,
    pastContributionShares: 140,
    serviceShares: 140,
    quarterlyInstallment: 14,
    bookEntry: "Book-entry · Common · Dami · 280 shares",
    aggregateCostUsd: 560,
  },
  {
    email: "slammie236@gmail.com",
    shortName: "Abdulsalam",
    legalName: "Abdul Salam Olamide Ajetunmobi",
    totalShares: 220,
    pastContributionShares: 110,
    serviceShares: 110,
    quarterlyInstallment: 11,
    bookEntry: "Book-entry · Common · Abdulsalam · 220 shares",
    aggregateCostUsd: 440,
  },
  {
    email: "oluwafikunmieshilokun@gmail.com",
    shortName: "Fikunmi",
    legalName: "Oluwafikunmi Adegbenga Eshilokun",
    totalShares: 200,
    pastContributionShares: 100,
    serviceShares: 100,
    quarterlyInstallment: 10,
    bookEntry: "Book-entry · Common · Fikunmi · 200 shares",
    aggregateCostUsd: 400,
  },
  {
    email: "rilexmeshy@gmail.com",
    shortName: "Ridwan",
    legalName: "Ridwan Adekunle Meshinoye",
    totalShares: 200,
    pastContributionShares: 100,
    serviceShares: 100,
    quarterlyInstallment: 10,
    bookEntry: "Book-entry · Common · Ridwan · 200 shares",
    aggregateCostUsd: 400,
  },
];

export function assertScheduleA() {
  const total = SCHEDULE_A.reduce((a, r) => a + r.totalShares, 0);
  if (total !== SCHEDULE_A_FOUNDER_OUTSTANDING) {
    throw new Error(`Schedule A totals ${total}, expected ${SCHEDULE_A_FOUNDER_OUTSTANDING}`);
  }
  for (const row of SCHEDULE_A) {
    if (row.pastContributionShares + row.serviceShares !== row.totalShares) {
      throw new Error(`${row.shortName}: past + service must equal total`);
    }
    if (row.pastContributionShares !== row.serviceShares) {
      throw new Error(`${row.shortName}: expected 50/50 past/service`);
    }
    if (row.serviceShares / SCHEDULE_A_SERVICE_INSTALLMENTS !== row.quarterlyInstallment) {
      throw new Error(`${row.shortName}: quarterly installment mismatch`);
    }
  }
}

export function scheduleAByEmail(email: string) {
  return SCHEDULE_A.find((r) => r.email === email);
}
