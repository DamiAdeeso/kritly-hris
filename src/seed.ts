import { migrate, prisma } from "./db.js";
import { DEFAULT_POLICY, assertWeights, PolicyBodySchema } from "./policy.js";
import { syncRolePermissions } from "./rbac.js";
import { audit } from "./audit.js";
import { hashPassword, id, nowIso, verifyPassword } from "./util.js";
import { assertScheduleA, scheduleAByEmail, type ScheduleARow } from "./scheduleA.js";
import { notifyCycleOpened } from "./services/notificationService.js";

async function assignRole(personId: string, roleKey: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });
  await prisma.personRole.createMany({
    data: [{ person_id: personId, role_id: role.id }],
    skipDuplicates: true,
  });
}

async function person(fullName: string, email: string, flags: { director?: boolean; founder?: boolean }, defaultPassword: string) {
  const existing = await prisma.person.findUnique({ where: { email }, select: { id: true, password_hash: true } });
  if (existing) {
    // If still on the shared default, migrate to personal default
    if (verifyPassword("kritly2026", existing.password_hash)) {
      await prisma.person.update({ where: { id: existing.id }, data: { password_hash: hashPassword(defaultPassword) } });
    }
    return existing.id;
  }
  const pid = id("p");
  await prisma.person.create({
    data: {
      id: pid,
      full_name: fullName,
      email,
      password_hash: hashPassword(defaultPassword),
      is_director: flags.director ? 1 : 0,
      is_founder: flags.founder ? 1 : 0,
      created_at: nowIso(),
    },
  });
  return pid;
}

async function employment(personId: string, title: string, category: string, reviewed: boolean) {
  const existing = await prisma.employment.findUnique({ where: { person_id: personId }, select: { id: true } });
  if (existing) return existing.id;
  const eid = id("emp");
  await prisma.employment.create({
    data: {
      id: eid,
      person_id: personId,
      company: "Kritly Inc.",
      title,
      category,
      start_date: "2026-08-15",
      qualifying_service: 1,
      subject_to_founder_review: reviewed ? 1 : 0,
    },
  });
  return eid;
}

async function equity(employmentId: string, legends: string[], row: ScheduleARow) {
  const existing = await prisma.equityAccount.findUnique({
    where: { employment_id: employmentId },
    select: { id: true, schedule_a_confirmed: true, vested_shares: true, certificate_or_book_entry: true },
  });
  const legendsText = legends.join("\n\n");
  if (existing) {
    const preserveProgress = existing.vested_shares > row.pastContributionShares;
    if (preserveProgress) {
      await prisma.equityAccount.update({
        where: { id: existing.id },
        data: {
          certificate_or_book_entry: existing.certificate_or_book_entry?.trim()
            ? existing.certificate_or_book_entry
            : row.bookEntry,
          total_shares: row.totalShares,
          past_contribution_shares: row.pastContributionShares,
          service_shares: row.serviceShares,
          schedule_a_confirmed: 1,
          legends: legendsText,
        },
      });
    } else {
      await prisma.equityAccount.update({
        where: { id: existing.id },
        data: {
          certificate_or_book_entry: row.bookEntry,
          total_shares: row.totalShares,
          past_contribution_shares: row.pastContributionShares,
          service_shares: row.serviceShares,
          vested_shares: row.pastContributionShares,
          unvested_shares: row.serviceShares,
          escrow: 1,
          schedule_a_confirmed: 1,
          legends: legendsText,
        },
      });
    }
    return existing.id;
  }
  const eqid = id("eq");
  await prisma.equityAccount.create({
    data: {
      id: eqid,
      employment_id: employmentId,
      certificate_or_book_entry: row.bookEntry,
      total_shares: row.totalShares,
      past_contribution_shares: row.pastContributionShares,
      service_shares: row.serviceShares,
      vested_shares: row.pastContributionShares,
      unvested_shares: row.serviceShares,
      escrow: 1,
      vesting_suspended: 0,
      schedule_a_confirmed: 1,
      legends: legendsText,
    },
  });
  return eqid;
}

async function main() {
  await migrate();
  assertScheduleA();
  await syncRolePermissions();
  assertWeights(DEFAULT_POLICY);
  const policyBody = PolicyBodySchema.parse(DEFAULT_POLICY);

  // Migrate old @kritly.com emails to real personal emails if they still exist in DB.
  const emailMigrations: Array<[string, string]> = [
    ["dami@kritly.com", "damilolaadeeso@gmail.com"],
    ["salam@kritly.com", "slammie236@gmail.com"],
    ["fikunmi@kritly.com", "oluwafikunmieshilokun@gmail.com"],
    ["ridwan@kritly.com", "rilexmeshy@gmail.com"],
    ["adegbemisola@kritly.com", "adeesoadegbemisola@gmail.com"],
  ];
  for (const [oldEmail, newEmail] of emailMigrations) {
    const existing = await prisma.person.findUnique({ where: { email: oldEmail }, select: { id: true } });
    if (existing) {
      await prisma.person.update({ where: { id: existing.id }, data: { email: newEmail } });
    }
  }

  const dami    = await person("Oluwadamilola Caleb Adeeso",        "damilolaadeeso@gmail.com",        { director: true,  founder: true  }, "Dami@2026");
  const salam   = await person("Abdul Salam Olamide Ajetunmobi",    "slammie236@gmail.com",            { director: true,  founder: true  }, "Salam@2026");
  const fikunmi = await person("Oluwafikunmi Adegbenga Eshilokun",  "oluwafikunmieshilokun@gmail.com", { director: true,  founder: true  }, "Fikunmi@2026");
  const ridwan  = await person("Ridwan Adekunle Meshinoye",         "rilexmeshy@gmail.com",            { director: true,  founder: true  }, "Ridwan@2026");
  const adegbe  = await person("Adegbemisola Similoluwa Adeeso",    "adeesoadegbemisola@gmail.com",    { director: true,  founder: false }, "Adegbe@2026");
  // Auditor-only for the Nai room walk: audit.read without cycle.manage.
  const auditor = await person("Kritly Auditor", "auditor@kritly.com", { director: false, founder: false }, "Auditor@2026");

  for (const pid of [dami, salam, fikunmi, ridwan]) {
    await assignRole(pid, "director");
    await assignRole(pid, "founder_operator");
  }
  await assignRole(dami, "system_admin");
  await assignRole(dami, "policy_admin");
  await assignRole(adegbe, "director");
  await assignRole(salam, "equity_admin");
  await assignRole(auditor, "auditor");

  const empDami = await employment(dami, "Chief Executive Officer", "Operator", true);
  const empSalam = await employment(salam, "Chief Operating Officer and Secretary", "Operator", true);
  const empFik = await employment(fikunmi, "Chief Financial Officer", "Operator", true);
  const empRid = await employment(ridwan, "Chief Technology Officer", "Operator", true);
  await employment(adegbe, "Director", "Other", false);

  const saDami = scheduleAByEmail("damilolaadeeso@gmail.com")!;
  const saSalam = scheduleAByEmail("slammie236@gmail.com")!;
  const saFik = scheduleAByEmail("oluwafikunmieshilokun@gmail.com")!;
  const saRid = scheduleAByEmail("rilexmeshy@gmail.com")!;
  await equity(empDami, policyBody.equity_legends, saDami);
  await equity(empSalam, policyBody.equity_legends, saSalam);
  await equity(empFik, policyBody.equity_legends, saFik);
  await equity(empRid, policyBody.equity_legends, saRid);

  await prisma.affiliate.createMany({
    data: [{ person_id: adegbe, related_person_id: dami, relationship: "family_member" }],
    skipDuplicates: true,
  });

  const existingPolicy = await prisma.policyVersion.findUnique({ where: { version: 1 }, select: { id: true } });
  let policyId = existingPolicy?.id;
  if (!policyId) {
    policyId = id("pol");
    await prisma.policyVersion.create({
      data: {
        id: policyId,
        version: 1,
        label: "Founders Agreement Schedule C/D/H defaults",
        body_json: JSON.stringify(policyBody),
        active: 1,
        mutable_notes: policyBody.locked_notes.join(" | "),
        created_by: dami,
        created_at: nowIso(),
      },
    });
    await audit({
      actorId: dami,
      action: "policy.create_activate",
      entityType: "policy_version",
      entityId: policyId,
      after: { version: 1 },
    });
  }

  // Week starting Monday 16 Nov 2026 through Saturday vest.
  // starts_on → ends_on midpoint is mid-quarter due (Wed 18).
  const NOV_DEADLINES = {
    periodStart: "2026-11-16",
    evidence: "2026-11-16",
    selfAssessment: "2026-11-17",
    scores: "2026-11-18",
    votes: "2026-11-19",
    periodEnd: "2026-11-20",
    vesting: "2026-11-21",
  } as const;

  const existingCycle = await prisma.reviewCycle.findFirst({
    where: { name: "November 2026 Vesting Review" },
    select: { id: true },
  });
  let cycleId = existingCycle?.id;
  let cycleJustCreated = false;
  if (!cycleId) {
    cycleJustCreated = true;
    cycleId = id("cyc");
    await prisma.reviewCycle.create({
      data: {
        id: cycleId,
        name: "November 2026 Vesting Review",
        period_label: "Pre-vesting review before 21 Nov 2026",
        starts_on: NOV_DEADLINES.periodStart,
        ends_on: NOV_DEADLINES.periodEnd,
        review_deadline: NOV_DEADLINES.votes,
        vesting_date: NOV_DEADLINES.vesting,
        policy_version_id: policyId,
        status: "open",
        ratings_published: 0,
        assignment_adopted_at: nowIso(),
        assignment_adoption_method: "board_majority",
        evidence_due_on: NOV_DEADLINES.evidence,
        self_assessment_due_on: NOV_DEADLINES.selfAssessment,
        scores_due_on: NOV_DEADLINES.scores,
        votes_due_on: NOV_DEADLINES.votes,
      },
    });

    const initiatives: { emp: string; title: string; objective: string }[] = [
      { emp: empDami, title: "Company restructure documents", objective: "Close governance package" },
      { emp: empDami, title: "Merger negotiations and finalization", objective: "Close governance package" },
      { emp: empDami, title: "Improve", objective: "Product quality" },
      { emp: empDami, title: "Bank account", objective: "Treasury readiness" },
      { emp: empDami, title: "Eval bench", objective: "Product quality" },
      { emp: empDami, title: "Chat page improvement", objective: "Product quality" },
      { emp: empDami, title: "Training founders on the existing system", objective: "Operating cadence" },
      { emp: empDami, title: "Participation in the UX audit", objective: "Product quality" },
      { emp: empFik, title: "UI improvements on the current application", objective: "Product quality" },
      { emp: empFik, title: "Paystack account setup", objective: "Payments readiness" },
      { emp: empFik, title: "WooCommerce store setup", objective: "Commerce channels" },
      { emp: empFik, title: "Finance bill collation", objective: "Finance ops" },
      { emp: empFik, title: "Review merger documents", objective: "Close governance package" },
      { emp: empFik, title: "Review company restructure", objective: "Close governance package" },
      { emp: empFik, title: "Participation in the UX audit", objective: "Product quality" },
      { emp: empRid, title: "Flutterwave setup", objective: "Payments readiness" },
      { emp: empRid, title: "UX audit", objective: "Product quality" },
      { emp: empRid, title: "Shopify setup", objective: "Commerce channels" },
      { emp: empRid, title: "Review merger documents", objective: "Close governance package" },
      { emp: empRid, title: "Review company restructure", objective: "Close governance package" },
      { emp: empSalam, title: "Stripe setup", objective: "Payments readiness" },
      { emp: empSalam, title: "Meta account setup", objective: "Channel readiness" },
      { emp: empSalam, title: "Meeting notes", objective: "Operating cadence" },
      { emp: empSalam, title: "Review merger documents", objective: "Close governance package" },
      { emp: empSalam, title: "Review company restructure", objective: "Close governance package" },
      { emp: empSalam, title: "Participation in the UX audit", objective: "Product quality" },
    ];

    for (const item of initiatives) {
      await prisma.initiative.create({
        data: {
          id: id("ini"),
          cycle_id: cycleId,
          employment_id: item.emp,
          title: item.title,
          company_objective: item.objective,
          success_criteria: `Demonstrate completion of: ${item.title}`,
          start_date: NOV_DEADLINES.periodStart,
          due_date: NOV_DEADLINES.evidence,
          status: "in_progress",
          weight: 1,
          evidence_ref: null,
        },
      });
    }
    await audit({ actorId: dami, action: "cycle.open", entityType: "review_cycle", entityId: cycleId });
  }

  await prisma.reviewCycle.update({
    where: { id: cycleId },
    data: {
      period_label: "Pre-vesting review before 21 Nov 2026",
      starts_on: NOV_DEADLINES.periodStart,
      ends_on: NOV_DEADLINES.periodEnd,
      review_deadline: NOV_DEADLINES.votes,
      vesting_date: NOV_DEADLINES.vesting,
      evidence_due_on: NOV_DEADLINES.evidence,
      self_assessment_due_on: NOV_DEADLINES.selfAssessment,
      scores_due_on: NOV_DEADLINES.scores,
      votes_due_on: NOV_DEADLINES.votes,
    },
  });
  await prisma.initiative.updateMany({
    where: { cycle_id: cycleId },
    data: {
      start_date: NOV_DEADLINES.periodStart,
      due_date: NOV_DEADLINES.evidence,
    },
  });

  await notifyCycleOpened(cycleId);
  if (cycleJustCreated) {
    console.log(`Opened cycle ${cycleId}.`);
  }

  console.log("Seed complete.");
  console.log(
    `Deadlines: evidence ${NOV_DEADLINES.evidence} → self ${NOV_DEADLINES.selfAssessment} → scores ${NOV_DEADLINES.scores} → votes ${NOV_DEADLINES.votes} → vest ${NOV_DEADLINES.vesting}`
  );
  console.log(
    "Login emails: damilolaadeeso@gmail.com, slammie236@gmail.com, oluwafikunmieshilokun@gmail.com, rilexmeshy@gmail.com, adeesoadegbemisola@gmail.com, auditor@kritly.com"
  );
  console.log("Passwords: Dami → Dami@2026 · Salam → Salam@2026 · Fikunmi → Fikunmi@2026 · Ridwan → Ridwan@2026 · Adegbe → Adegbe@2026 · Auditor → Auditor@2026");;
  console.log("Schedule A locked (post-rebalance): Dami 280, Salam 220, Fikunmi 200, Ridwan 200 — past vested / service unvested 50/50.");
  console.log("Note: Adegbemisola is seeded as Dami affiliate for recusal; clear in UI/DB if incorrect.");
  console.log("Nai room: founder damilolaadeeso@gmail.com; director recusal adeesoadegbemisola@gmail.com on Dami's vote page; auditor auditor@kritly.com.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
