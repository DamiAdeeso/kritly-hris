import { prisma } from "../db.js";
import { audit } from "../audit.js";
import { requirePerm } from "../rbac.js";
import { hashPassword, id, nowIso } from "../util.js";
import { DEFAULT_POLICY } from "../policy.js";

export async function createPerson(input: {
  actorId: string;
  fullName: string;
  email: string;
  password: string;
  isDirector?: boolean;
  isFounder?: boolean;
}) {
  await requirePerm(input.actorId, "people.write");
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.person.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw Object.assign(new Error("Email already exists"), { status: 400 });
  if (!input.password || input.password.length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
  }
  const personId = id("p");
  await prisma.person.create({
    data: {
      id: personId,
      full_name: input.fullName.trim(),
      email,
      password_hash: hashPassword(input.password),
      is_director: input.isDirector ? 1 : 0,
      is_founder: input.isFounder ? 1 : 0,
      created_at: nowIso(),
    },
  });
  await audit({
    actorId: input.actorId,
    action: "people.create",
    entityType: "person",
    entityId: personId,
    after: { email, full_name: input.fullName },
  });
  return personId;
}

export async function upsertEmployment(input: {
  actorId: string;
  personId: string;
  title: string;
  category: string;
  startDate: string;
  qualifyingService: boolean;
  subjectToFounderReview: boolean;
  company?: string;
}) {
  await requirePerm(input.actorId, "people.write");
  const person = await prisma.person.findUnique({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw Object.assign(new Error("Person not found"), { status: 404 });

  const existing = await prisma.employment.findUnique({ where: { person_id: input.personId } });
  let employmentId = existing?.id;
  if (existing && employmentId) {
    await prisma.employment.update({
      where: { id: employmentId },
      data: {
        title: input.title.trim(),
        category: input.category.trim(),
        start_date: input.startDate,
        qualifying_service: input.qualifyingService ? 1 : 0,
        subject_to_founder_review: input.subjectToFounderReview ? 1 : 0,
        company: input.company?.trim() || existing.company,
      },
    });
  } else {
    employmentId = id("emp");
    await prisma.employment.create({
      data: {
        id: employmentId,
        person_id: input.personId,
        company: input.company?.trim() || "Kritly Inc.",
        title: input.title.trim(),
        category: input.category.trim(),
        start_date: input.startDate,
        qualifying_service: input.qualifyingService ? 1 : 0,
        subject_to_founder_review: input.subjectToFounderReview ? 1 : 0,
      },
    });
  }

  if (input.subjectToFounderReview) {
    const equity = await prisma.equityAccount.findUnique({
      where: { employment_id: employmentId },
      select: { id: true },
    });
    if (!equity) {
      await prisma.equityAccount.create({
        data: {
          id: id("eq"),
          employment_id: employmentId,
          total_shares: 0,
          past_contribution_shares: 0,
          service_shares: 0,
          vested_shares: 0,
          unvested_shares: 0,
          escrow: 1,
          vesting_suspended: 0,
          schedule_a_confirmed: 0,
          legends: DEFAULT_POLICY.equity_legends.join("\n\n"),
        },
      });
    }
  }

  await audit({
    actorId: input.actorId,
    action: "people.employment_upsert",
    entityType: "employment",
    entityId: employmentId,
    after: {
      title: input.title,
      subject_to_founder_review: input.subjectToFounderReview,
    },
  });
  return employmentId;
}

export async function addAffiliate(input: {
  actorId: string;
  personId: string;
  relatedPersonId: string;
  relationship: string;
}) {
  await requirePerm(input.actorId, "people.write");
  if (input.personId === input.relatedPersonId) {
    throw Object.assign(new Error("Cannot affiliate a person to themselves"), { status: 400 });
  }
  await prisma.affiliate.create({
    data: {
      person_id: input.personId,
      related_person_id: input.relatedPersonId,
      relationship: input.relationship.trim() || "affiliate",
    },
  });
  await audit({
    actorId: input.actorId,
    action: "people.affiliate_add",
    entityType: "affiliate",
    entityId: `${input.personId}:${input.relatedPersonId}`,
  });
}

export async function removeAffiliate(actorId: string, personId: string, relatedPersonId: string) {
  await requirePerm(actorId, "people.write");
  await prisma.affiliate.delete({
    where: {
      person_id_related_person_id: { person_id: personId, related_person_id: relatedPersonId },
    },
  });
  await audit({
    actorId,
    action: "people.affiliate_remove",
    entityType: "affiliate",
    entityId: `${personId}:${relatedPersonId}`,
  });
}

export async function listAffiliatesForPerson(personId: string) {
  return prisma.affiliate.findMany({
    where: {
      OR: [{ person_id: personId }, { related_person_id: personId }],
    },
    include: {
      person: { select: { id: true, full_name: true } },
      related: { select: { id: true, full_name: true } },
    },
  });
}
