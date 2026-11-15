import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { requirePerm } from "../rbac.js";
import { SCHEDULE_A, SCHEDULE_A_FOUNDER_OUTSTANDING } from "../scheduleA.js";
import { notifyPerson } from "./notificationService.js";
import { id, nowIso } from "../util.js";

export type CashCallLine = {
  id: string;
  person_id: string;
  full_name: string;
  email: string;
  shares: number;
  amount_cents: number;
  paid_cents: number;
};

export type CashCallPayment = {
  id: string;
  line_id: string;
  amount_cents: number;
  paid_on: string;
  reference: string;
  recorded_by_name: string;
  created_at: string;
};

export type CompanyAccount = {
  id: string;
  name: string;
  institution: string;
  currency: string;
  reference: string;
  status: string;
};

export type CashCall = {
  id: string;
  title: string;
  purpose: string;
  total_cents: number;
  currency: string;
  due_on: string;
  status: string;
  created_at: string;
  account_id: string | null;
  account_name: string | null;
  account_institution: string | null;
  account_reference: string | null;
  lines: CashCallLine[];
  payments: CashCallPayment[];
};

/** Split a call across Schedule A founder shares. Remainders go to the largest fractional shares. */
export function allocateByScheduleA(totalCents: number) {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error("Cash call amount must be a positive number of cents"), { status: 400 });
  }
  const draft = SCHEDULE_A.map((row) => {
    const exact = (totalCents * row.totalShares) / SCHEDULE_A_FOUNDER_OUTSTANDING;
    const base = Math.floor(exact);
    return { row, cents: base, frac: exact - base };
  });
  let left = totalCents - draft.reduce((sum, row) => sum + row.cents, 0);
  const order = [...draft].sort((a, b) => b.frac - a.frac || b.row.totalShares - a.row.totalShares);
  for (const item of order) {
    if (left <= 0) break;
    item.cents += 1;
    left -= 1;
  }
  const allocated = draft.reduce((sum, row) => sum + row.cents, 0);
  if (allocated !== totalCents) {
    throw new Error(`Allocation ${allocated} does not match ${totalCents}`);
  }
  return draft.map((item) => ({
    email: item.row.email,
    shortName: item.row.shortName,
    shares: item.row.totalShares,
    amountCents: item.cents,
  }));
}

/** Currencies stored as minor units (two decimal places). */
export const CASH_CALL_CURRENCIES = ["USD", "NGN", "GBP", "EUR"] as const;

export function parseMoney(raw: string) {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw Object.assign(new Error("Enter an amount with at most two decimal places"), { status: 400 });
  }
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw Object.assign(new Error("Amount must be greater than zero"), { status: 400 });
  }
  return cents;
}

export function formatMoney(cents: number, currency: string) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${currency} ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

async function paidByLine(callId: string) {
  const lines = await prisma.cashCallLine.findMany({
    where: { cash_call_id: callId },
    include: { payments: { select: { amount_cents: true } } },
  });
  return new Map(
    lines.map((line) => [
      line.id,
      line.payments.reduce((sum, p) => sum + p.amount_cents, 0),
    ])
  );
}

export async function listCashCalls() {
  const calls = await prisma.cashCall.findMany({
    orderBy: [{ due_on: "asc" }, { created_at: "asc" }],
    include: { account: { select: { name: true } } },
  });
  return Promise.all(
    calls.map(async (call) => {
      const paid = [...(await paidByLine(call.id)).values()].reduce((sum, n) => sum + n, 0);
      return {
        id: call.id,
        title: call.title,
        purpose: call.purpose,
        total_cents: call.total_cents,
        currency: call.currency,
        due_on: call.due_on,
        status: call.status,
        created_at: call.created_at,
        account_id: call.account_id,
        account_name: call.account?.name ?? null,
        paid_cents: paid,
        outstanding_cents: call.total_cents - paid,
      };
    })
  );
}

export async function outstandingByCurrency(personId: string) {
  const lines = await prisma.cashCallLine.findMany({
    where: { person_id: personId, cashCall: { status: "open" } },
    include: {
      cashCall: { select: { currency: true } },
      payments: { select: { amount_cents: true } },
    },
  });
  const totals = new Map<string, number>();
  for (const line of lines) {
    const paid = line.payments.reduce((sum, p) => sum + p.amount_cents, 0);
    const open = line.amount_cents - paid;
    if (open <= 0) continue;
    const currency = line.cashCall.currency;
    totals.set(currency, (totals.get(currency) ?? 0) + open);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

export async function getCashCall(callId: string): Promise<CashCall> {
  const call = await prisma.cashCall.findUnique({
    where: { id: callId },
    include: { account: true },
  });
  if (!call) throw Object.assign(new Error("Cash call not found"), { status: 404 });
  const paid = await paidByLine(callId);
  const lineRows = await prisma.cashCallLine.findMany({
    where: { cash_call_id: callId },
    include: { person: { select: { full_name: true, email: true } } },
    orderBy: [{ shares: "desc" }, { person: { full_name: "asc" } }],
  });
  const lines = lineRows.map((line) => ({
    id: line.id,
    person_id: line.person_id,
    shares: line.shares,
    amount_cents: line.amount_cents,
    full_name: line.person.full_name,
    email: line.person.email,
    paid_cents: paid.get(line.id) ?? 0,
  }));
  const payments = await prisma.cashCallPayment.findMany({
    where: { line: { cash_call_id: callId } },
    include: { recorder: { select: { full_name: true } } },
    orderBy: [{ paid_on: "asc" }, { created_at: "asc" }],
  });
  return {
    id: call.id,
    title: call.title,
    purpose: call.purpose,
    total_cents: call.total_cents,
    currency: call.currency,
    due_on: call.due_on,
    status: call.status,
    created_at: call.created_at,
    account_id: call.account_id,
    account_name: call.account?.name ?? null,
    account_institution: call.account?.institution ?? null,
    account_reference: call.account?.reference ?? null,
    lines,
    payments: payments.map((pay) => ({
      id: pay.id,
      line_id: pay.line_id,
      amount_cents: pay.amount_cents,
      paid_on: pay.paid_on,
      reference: pay.reference,
      recorded_by_name: pay.recorder.full_name,
      created_at: pay.created_at,
    })),
  };
}

export async function listCompanyAccounts() {
  return prisma.companyAccount.findMany({
    orderBy: [{ status: "asc" }, { currency: "asc" }, { name: "asc" }],
    select: { id: true, name: true, institution: true, currency: true, reference: true, status: true },
  });
}

function normalizeAccountInput(input: {
  name: string;
  institution: string;
  currency: string;
  reference: string;
}) {
  const name = input.name.trim();
  const institution = input.institution.trim();
  const reference = input.reference.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!name) throw Object.assign(new Error("Account name is required"), { status: 400 });
  if (!institution) throw Object.assign(new Error("Institution is required"), { status: 400 });
  if (!reference) throw Object.assign(new Error("Account reference is required"), { status: 400 });
  if (!(CASH_CALL_CURRENCIES as readonly string[]).includes(currency)) {
    throw Object.assign(new Error("Choose USD, NGN, GBP, or EUR"), { status: 400 });
  }
  return { name, institution, currency, reference };
}

/** Commit path used after workforce approval (or local bypass). */
export async function commitCompanyAccount(input: {
  actorId: string;
  name: string;
  institution: string;
  currency: string;
  reference: string;
}) {
  const normalized = normalizeAccountInput(input);
  const accountId = id("acct");
  await prisma.companyAccount.create({
    data: {
      id: accountId,
      name: normalized.name,
      institution: normalized.institution,
      currency: normalized.currency,
      reference: normalized.reference,
      status: "active",
      created_by: input.actorId,
      created_at: nowIso(),
    },
  });
  await audit({
    actorId: input.actorId,
    action: "finance.account.create",
    entityType: "company_account",
    entityId: accountId,
    after: normalized,
  });
  return accountId;
}

export async function createCompanyAccount(input: {
  actorId: string;
  name: string;
  institution: string;
  currency: string;
  reference: string;
}) {
  await requirePerm(input.actorId, "finance.manage");
  normalizeAccountInput(input);
  return commitCompanyAccount(input);
}

export async function commitCloseCompanyAccount(actorId: string, accountId: string) {
  const row = await prisma.companyAccount.findUnique({
    where: { id: accountId },
    select: { id: true, status: true },
  });
  if (!row) throw Object.assign(new Error("Account not found"), { status: 404 });
  if (row.status === "closed") throw Object.assign(new Error("Account is already closed"), { status: 400 });
  await prisma.companyAccount.update({ where: { id: accountId }, data: { status: "closed" } });
  await audit({ actorId, action: "finance.account.close", entityType: "company_account", entityId: accountId });
}

export async function closeCompanyAccount(actorId: string, accountId: string) {
  await requirePerm(actorId, "finance.manage");
  await commitCloseCompanyAccount(actorId, accountId);
}

async function validateCashCallInput(input: {
  title: string;
  purpose: string;
  totalCents: number;
  accountId: string;
  dueOn: string;
}) {
  const title = input.title.trim();
  const purpose = input.purpose.trim();
  if (!title) throw Object.assign(new Error("Title is required"), { status: 400 });
  if (!purpose) throw Object.assign(new Error("Purpose is required"), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) throw Object.assign(new Error("Due date is required"), { status: 400 });
  const account = await prisma.companyAccount.findUnique({ where: { id: input.accountId } });
  if (!account || account.status !== "active") {
    throw Object.assign(new Error("Choose an active company account"), { status: 400 });
  }
  return { title, purpose, account };
}

/** Commit path used after workforce approval (or local bypass). */
export async function commitCashCall(input: {
  actorId: string;
  title: string;
  purpose: string;
  totalCents: number;
  accountId: string;
  dueOn: string;
}) {
  const { title, purpose, account } = await validateCashCallInput(input);
  const currency = account.currency;
  const allocation = allocateByScheduleA(input.totalCents);
  const founders = await Promise.all(
    allocation.map(async (row) => {
      const person = await prisma.person.findUnique({
        where: { email: row.email },
        select: { id: true, full_name: true },
      });
      if (!person) throw Object.assign(new Error(`No person for ${row.email}`), { status: 400 });
      return { ...row, personId: person.id, fullName: person.full_name };
    })
  );
  const callId = id("call");
  await prisma.$transaction(async (tx) => {
    await tx.cashCall.create({
      data: {
        id: callId,
        title,
        purpose,
        total_cents: input.totalCents,
        currency,
        due_on: input.dueOn,
        status: "open",
        created_by: input.actorId,
        created_at: nowIso(),
        account_id: account.id,
      },
    });
    for (const row of founders) {
      await tx.cashCallLine.create({
        data: {
          id: id("line"),
          cash_call_id: callId,
          person_id: row.personId,
          shares: row.shares,
          amount_cents: row.amountCents,
        },
      });
    }
  });
  await audit({
    actorId: input.actorId,
    action: "finance.cash_call.issue",
    entityType: "cash_call",
    entityId: callId,
    after: { title, totalCents: input.totalCents, currency, dueOn: input.dueOn, accountId: account.id },
  });
  for (const row of founders) {
    await notifyPerson({
      personId: row.personId,
      kind: "cash_call",
      title: `Cash call · ${title}`,
      body: `Your share is ${formatMoney(row.amountCents, currency)} of ${formatMoney(input.totalCents, currency)}, due ${input.dueOn}. Pay into ${account.name}, ${account.institution}, ${account.reference}. ${purpose}`,
      href: `/finance/calls/${callId}`,
      dueOn: input.dueOn,
      dedupeKey: `cash_call:${callId}:${row.personId}`,
    });
  }
  return callId;
}

export async function issueCashCall(input: {
  actorId: string;
  title: string;
  purpose: string;
  totalCents: number;
  accountId: string;
  dueOn: string;
}) {
  await requirePerm(input.actorId, "finance.manage");
  await validateCashCallInput(input);
  return commitCashCall(input);
}

export async function recordCashCallPayment(input: {
  actorId: string;
  callId: string;
  lineId: string;
  amountCents: number;
  paidOn: string;
  reference: string;
}) {
  const reference = input.reference.trim();
  if (!reference) throw Object.assign(new Error("Payment reference is required"), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw Object.assign(new Error("Payment date is required"), { status: 400 });
  const line = await prisma.cashCallLine.findFirst({
    where: { id: input.lineId, cash_call_id: input.callId },
    include: { cashCall: { select: { status: true, currency: true } } },
  });
  if (!line) throw Object.assign(new Error("That share is not on this cash call"), { status: 404 });
  if (line.cashCall.status === "settled") throw Object.assign(new Error("This cash call is already settled"), { status: 400 });
  const manages = input.actorId !== line.person_id;
  await requirePerm(input.actorId, manages ? "finance.manage" : "finance.read");
  const paidAgg = await prisma.cashCallPayment.aggregate({
    where: { line_id: line.id },
    _sum: { amount_cents: true },
  });
  const paid = paidAgg._sum.amount_cents ?? 0;
  const outstanding = line.amount_cents - paid;
  if (input.amountCents > outstanding) {
    throw Object.assign(
      new Error(`Amount is above the ${formatMoney(outstanding, line.cashCall.currency)} still open on this share`),
      { status: 400 }
    );
  }
  const paymentId = id("pay");
  await prisma.cashCallPayment.create({
    data: {
      id: paymentId,
      line_id: line.id,
      amount_cents: input.amountCents,
      paid_on: input.paidOn,
      reference,
      recorded_by: input.actorId,
      created_at: nowIso(),
    },
  });
  const lines = await prisma.cashCallLine.findMany({
    where: { cash_call_id: input.callId },
    include: { payments: { select: { amount_cents: true } } },
  });
  const stillOpen = lines.filter(
    (l) => l.amount_cents > l.payments.reduce((sum, p) => sum + p.amount_cents, 0)
  );
  if (stillOpen.length === 0) {
    await prisma.cashCall.update({ where: { id: input.callId }, data: { status: "settled" } });
  }
  await audit({
    actorId: input.actorId,
    action: "finance.cash_call.payment",
    entityType: "cash_call",
    entityId: input.callId,
    after: { lineId: line.id, amountCents: input.amountCents, paidOn: input.paidOn, reference },
  });
}
