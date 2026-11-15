# Kritly HRIS

Private HRIS for Kritly Inc. People, employment, and equity are the core records. The first working function is Founder Review through the vesting ledger record (no new share issuance).

## Configurability & RBAC

See [CONFIGURABILITY.md](./CONFIGURABILITY.md) for:

- What is locked legal vs living policy vs operational data
- How policy versions are snapshotted onto review cycles
- Role / permission matrix

## Deploy (Render)

Blueprint: [`render.yaml`](./render.yaml). Companion Nai secrets and handbook reindex: `kritly/docs/RENDER_NAI_HRIS.md`.

1. Create the Blueprint from this repo; set `DATABASE_URL` (Neon/other with `?schema=hris`).
2. Copy `NAI_INTERNAL_JWT_SECRET` and `NAI_SERVICE_KEY` from `commerce-automation-nai`; keep `NAI_SERVICE_URL=https://commerce-automation-nai.onrender.com`.
3. On Nai, set `NAI_HRIS_URL` and `NAI_ALLOWED_ORIGINS` to the HRIS public URL, then redeploy Nai if needed.

## Quick start

Needs Postgres (same Kritly `DATABASE_URL`). Schema lives in Postgres schema `hris`.

```bash
cd hris
cp .env.example .env   # set DATABASE_URL
npm install
npm run db:migrate     # or: npm run db:push
npm run seed
npm run dev
```

Open http://localhost:4545

| Email | Password |
|-------|----------|
| dami@kritly.com | kritly2026 |
| salam@kritly.com | kritly2026 |
| fikunmi@kritly.com | kritly2026 |
| ridwan@kritly.com | kritly2026 |
| adegbemisola@kritly.com | kritly2026 |

Adegbemisola is seeded as Dami's affiliate for recusal demos. Clear the `affiliates` row if that is incorrect.

## Schedule A (locked in seed)

Post–Founder Rebalance from the Founders’ Agreement / Schedule A. Seed writes these as `schedule_a_confirmed = 1` on deploy (`npm run seed`). Source: `src/scheduleA.ts` and `kritly/docs/governance/schedules/Schedule-A-Founder-Equity-Table.md`.

| Founder | Total | Past (vested 15 Aug 2026) | Service (unvested) | Quarterly (1/10) |
|---------|------:|--------------------------:|-------------------:|-----------------:|
| Dami | 280 | 140 | 140 | 14 |
| Abdulsalam | 220 | 110 | 110 | 11 |
| Fikunmi | 200 | 100 | 100 | 10 |
| Ridwan | 200 | 100 | 100 | 10 |
| **Total** | **900** | **450** | **450** | |

Authorized 1,000 @ $2.00; 100 reserved pool. First service vesting date: **15 Nov 2026**.

### November 2026 cycle deadlines (staggered)

| Step | Due |
|------|-----|
| Evidence | 6 Nov 2026 |
| Self-assessment | 8 Nov 2026 |
| Seal scores | 11 Nov 2026 |
| Votes | 13 Nov 2026 |
| Vesting | 15 Nov 2026 |

## Flow

1. Equity accounts are Schedule A–confirmed from seed (or confirmed under **Equity**). People with `people.write` can add people, employment, and affiliate pairs under **People**.
2. Open a quarter under **Performance → Open a cycle** (needs `cycle.manage`). Add initiatives on the draft, then directors accept the slate by majority. Seed already opens the November 2026 cycle as adopted.
3. Home shows tasks with due dates; the nav bell shows notifications. Each founder posts under **My evidence**: status, an evidence link and/or file (pdf/png/jpg/docx/txt/md, 15 MB, private download), and a self-assessment. Mid-quarter status notes are tracked when policy requires them.
4. Directors score in steps: packet → initiative outcomes → Delivery → other dimensions → review & seal. When every score is in, each disinterested director accepts or declines the average. A majority of accepts writes the official rating. If everyone votes and the average is not adopted, any eligible director can return that founder to scoring.
5. Publish ratings → memos + Observation/PIP notices and open plans. Founders reply and check in on **/plans/:id**; directors extend a PIP once, then vote met/not-met or pass/fail. A failed PIP opens a bad-leaver vote (threshold from policy). Schedule G repurchase math stays in the agreement.
6. Issue vesting records / holds once per cycle (service installment from Schedule A). A second run is refused.

## Finance

**Finance** opens on a landing page with two items: cash calls and company accounts. An account has a name, institution, currency (USD, NGN, GBP, or EUR), and the reference founders pay to. A cash call is issued into one active account, and the call uses that account's currency. The total is split by Schedule A (280 / 220 / 200 / 200 of 900). Each founder records a payment against their own line; a finance manager can record any line. When every line is paid, the call is settled. A cash call does not issue shares.

## UI

Shell and tokens follow Kritly UI (`@commerce-automation-client/ui`): indigo primary, cool neutrals, sidebar app shell. Styles live in `public/kritly-ui.css` (SSR-safe copy of the design tokens).

## Stack

TypeScript, Express, Prisma + PostgreSQL (`hris` schema), cookie sessions, versioned JSON policy, RBAC.

Workforce approvals (cash calls / accounts) use the shared Kritly gateway when `WORKFORCE_API_URL` and `WORKFORCE_SERVICE_KEY` are set — see CONFIGURABILITY.md.
