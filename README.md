# Deduction Recovery

An internal tool for the analyst who has been tracking retailer deductions in a spreadsheet. It imports the messy export, shows what was cleaned and what still needs a person, moves each deduction through triage and (when it's worth fighting) a dispute, and reports how much money has actually come back.

- **Backend:** Node + TypeScript, Express 5, SQLite through Node's built-in `node:sqlite` (no native modules to compile), Zod validation. JSON API.
- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4 + shadcn/ui (Radix), TanStack Query, Recharts, dnd-kit.
- **Shared:** `shared/domain.ts` holds the state machines, labels and issue catalogue, so the API and the UI can never disagree about which moves are legal.

## Running it

Requires **Node 22.13 or newer** (for `node:sqlite` and `JSON.parse` source-text access). Tests pass on Node 22.13 and 25.

```bash
npm run setup   # npm install + build the database from data/*.json
npm run dev     # API on :3001, web app on http://localhost:5173
```

Open http://localhost:5173 and click one of the demo accounts (password `recover-2026`):

| Account | Role | Can see |
| --- | --- | --- |
| maya@example.com | Analyst | Cascade Snacks Co. |
| jordan@example.com | Analyst | Northfield Beverage |
| sam@example.com | Senior analyst | Cascade, Northfield, Harbor & Vine (company switcher) |
| avery@example.com | Admin | Every company + the unassigned queue |

Other commands:

```bash
npm test                         # 92 server tests (vitest)
npm run typecheck                # server + web
npm run db:reset                 # rebuild the DB (import + users + simulated history)
npm run db:reset -- --no-demo    # rebuild with the raw export only, no simulated history
npm start                        # production build, UI + API on http://localhost:3001
AS_OF=2026-10-14 npm run db:reset   # pin "today" (future-date checks, aging) for reproducible demos
```

`db:reset` rebuilds the tables in place, so a running `npm run dev` picks up the new data (you'll be asked to sign in again).

### Deploying to Vercel

```bash
vercel deploy --prod     # Vercel runs `npm run build:vercel` (see vercel.json)
```

The hosted version is a **demo sandbox**, because Vercel functions have no persistent disk:

- `npm run build:vercel` writes `.vercel/output` using Vercel's [Build Output API](https://vercel.com/docs/build-output-api): the React app as static files on the CDN, and the Express API bundled into one Node 22 function (`server/src/serverless.ts`) with `data/*.json` next to it.
- Each function instance builds an in-memory copy of the demo when it starts (about 0.3 s locally): import, users, simulated history. Edits last while that instance is warm and reset when it goes idle, and two instances can briefly disagree. The UI shows a "Demo sandbox" badge.
- Sessions are signed cookies rather than database rows, so a sign-in works on any instance. Each deployment gets its own signing key unless `SESSION_SECRET` is set.

For data that persists, swap the data layer for a hosted database: Turso (libSQL) is the smallest change because it speaks SQLite, though the data layer would have to become async.

## What's in the app

| Screen | What it's for |
| --- | --- |
| **Overview** | How recovery is going: recovered vs. approved-but-unpaid vs. in dispute vs. ready to dispute, a funnel from deducted to cash back, the dispute pipeline, monthly deducted vs. recovered, aging, recovery by retailer and by reason. |
| **Deductions** | The work queue. Views for *Ready to dispute* (open, clean, usually-disputable reason, biggest first), *Needs attention* (data problems), *My queue* and *All*. Filters, search, sorting, bulk actions (start review, open disputes, send to ops, accept, assign). |
| **Deduction drawer** | Everything about one deduction: the next legal moves, dispute progress (claimed / approved / recovered / outstanding / written off, payments), inline corrections that show what the export originally said, data issues to fix or sign off, the full audit trail, and the original export row. |
| **Disputes** | A board by stage. Drag a card to move it; each move opens a form for what that stage needs, and illegal moves are rejected with an explanation. |
| **Data quality** | What happened to every row of the export, every issue found (with counts and drill-downs), and how values were normalized (retailer spellings, reasons, statuses, amount and date formats, field-name variants, duplicates). |
| **Unassigned** (admin) | Deductions whose company could not be resolved, waiting for an admin to assign them. |

## The questions in the brief

### 1. Dispute stages, and how an analyst moves between them

Two separate records, each with its own state machine (`shared/domain.ts`, enforced in `server/src/domain/workflow.ts`):

```
Deduction (triage)   New ──► In review ◄──► With ops
                      │          │              │
                      ├──────────┴── Accept as valid ──► Closed (accepted, reopenable)
                      └──────────┴── Open dispute ─────► Disputing ─┐
                                                                    │
Dispute              Preparing ──► Submitted ──► Approved ──(payments)──► Closed
                         ▲                 └───► Denied ──► Closed (denied)
                         └──────── Appeal ◄────────┘
                     (Preparing / Submitted can be withdrawn → Closed)
```

- A deduction is the fact ("Kroger short-paid INV-123 by $X for a shortage"). A dispute is the claim we file about it. Keeping them apart lets a deduction be accepted without a dispute, and lets a dispute carry its own amounts (claim, approval, payments) and dates.
- Every move goes through one function that loads the record through the caller's scope, checks the move is legal from the current state (409 if not), validates what that state needs (400 if missing), and writes the change plus an activity row in a single transaction.
- Each move asks for what that stage needs: opening a dispute sets the claim (full or partial), *Submitted* records the date and the retailer's claim number, the *decision* records approved in full / partially (amount) / denied (reason), *payments* record amount, date, method and reference, *appeal* and *withdraw* require a note. Disputes can't be filed until the data is good enough (known company and retailer, a trustworthy amount).
- Analysts move things from the drawer (buttons only show legal next steps), by dragging cards on the board, or in bulk from the list for triage moves.

### 2. More than one company: what should any one person see?

- People belong to companies (`memberships`). Analysts see only their companies; admins see all companies plus records whose company couldn't be resolved.
- Scoping happens in the API, not the UI. Every query goes through the same scope helper, and a record outside your companies returns **404**, not 403, so the API doesn't even confirm it exists. Asking for a company you don't belong to returns 403. Both are covered by API tests.
- Multi-company users get a company switcher (or a combined view). Amounts are never summed across currencies; Harbor & Vine is CAD.
- 34 active deductions reference `company_id` 0, 3 or null, none of which are in `companies.json`. Rather than guess, they're quarantined in an admin-only queue until someone assigns them.

### 3. What "recovered" means, and how recovery is going

A retailer approving a claim isn't money in the bank, and approvals are often partial. So the app tracks these separately:

| Term | Definition |
| --- | --- |
| Claimed | What we asked for (open and settled disputes, minus withdrawn). |
| Approved | What the retailer agreed to repay. |
| **Recovered** | **Cash actually received**: the sum of recorded payments (check, ACH, credit memo, or repayment on a later remittance). Nothing else counts. |
| Outstanding | Approved but not yet received. |
| Written off | Claimed minus recovered once a dispute is closed. |
| Recovery rate | Recovered ÷ claimed on *settled* disputes, so disputes still in flight don't drag it down. |
| Win rate | Share of retailer decisions that approved at least part of the claim. |

A dispute closes itself once the full approval has been received, with an outcome derived from money received (`recovered`, `partially_recovered`, `written_off`, `denied`, `withdrawn`). The Overview shows the funnel from deducted → usually disputable → claimed → approved → recovered, plus outstanding and written-off amounts, so the analyst can see where money is leaking.

### 4. "The raw data has issues"

Every row is kept, cleaned values sit next to the raw value they came from, and anything that needs a human becomes an issue on that record (blocking / check / FYI). What the importer found in `deductions.json` (counts are active rows unless noted):

| Problem | How it's handled |
| --- | --- |
| 2 rows repeat an id verbatim (1003, 1057) | Dropped on import. |
| 3 deductions re-exported under new ids, two of them a cent apart (2001→1088, 2000→1010, 2002→1140) | Same company + retailer + invoice + date + reason and amount within 1¢ → hidden as duplicates of the lowest id. |
| 2 empty rows (2003, 2004) | Hidden. |
| `is_deleted` as true/false, "true"/"false", 1/0, null | Normalized; 263 soft-deleted rows are hidden but kept. |
| `id` as numbers and strings | Normalized. |
| Field-name variants: `retailer`/`retailer_name`, `total_amount`/`amount`, `deduction_reason`/`reason`, plus `__v`, `notes`, `raw` | Read from whichever is present; tracked on the Data quality page. |
| `company_id` as "1", 0, 3, null (0/3/null aren't real companies) | 34 rows go to the admin-only Unassigned queue. |
| 87 spellings of 14 retailers (`KEHE\t`, `K e H E`, `U.N.F.I.`, `The Kroger Co.`, `Tgt`, `AMZN`, `GFC` …) and placeholders (`-`, `n/a`, `NULL`, blank) | Matched by a normalized key + alias table to `retailers.json`; 44 with no retailer are flagged and can't be disputed until fixed. |
| 36 spellings of reasons (`Frieght`, `Short`, `OS&D`, `Billback`, `Promo` …) and vague ones (`misc`, `???`, `Other`, blank) | Mapped to the 9 reason codes; 107 vague ones are flagged as unclassified. |
| Amounts as numbers, numeric strings, `"$1,234.56"`, `"USD 12.34"`, `"(102.78)"`, `"-$3.28"`, `"1.2E7"`, `"TBD"`, blank, float noise (`6.8199999992`) | Parsed to integer cents; 16 missing amounts are flagged and excluded from totals. |
| Whole-number amounts like `69895` when every other amount has decimals (even `57.0`) | Read as **cents** (the importer keeps the JSON literal text to tell `57` from `57.0`); 53 flagged for a spot check. |
| Negative amounts | Stored as positive deductions; flagged FYI. |
| Implausible amounts (`999999999.99`, `1.2E7`, `-50500000` cents) | Flagged and excluded from totals until confirmed or corrected. |
| 15 date formats: ISO, ISO timestamps, `YYYY/MM/DD hh:mm:ss`, `MM/DD/YYYY`, `DD-MM-YYYY`, `M/D/YY`, `Month D, YYYY`, Unix seconds, placeholders | Slash dates are month-first (91 have a day > 12) and dash dates day-first (45 have a day > 12); 69 missing dates flagged. |
| Dates in the future (31 in 2028; the rest late 2026) | Flagged; excluded from aging. |
| Invoice numbers as `INV-12345`, `inv-12345`, `INV 12345`, `#12345`, bare and zero-padded numbers, `/A` split suffixes, placeholders | Normalized to `INV-12345[/A]`; 58 missing flagged. |
| 11 status spellings (`" In Review "`, `COMPLETE`, `dispute` …) | Mapped onto the workflow. Bare `dispute` → Preparing; `Complete` → closed with *no recorded outcome* (see assumptions). |
| OCR captures (`raw.src = textract`) with low confidence | 17 under 50% flagged to verify against the source document. |

Fixing a value in the drawer (or signing off a warning) resolves the issue, logs who did it, and updates totals immediately.

## Assumptions

- **Whole-number amounts are cents.** The export writes dollars as decimals (`166.9`, `57.0`); a whole number like `69895` only fits the rest of the data as $698.95. Flagged so someone spot-checks it.
- Negative amounts are a sign convention, not credits.
- Anything over $100,000 is a placeholder or unit error until someone confirms it.
- `MM/DD/YYYY` and `M/D/YY` are month-first; `DD-MM-YYYY` is day-first (each is unambiguous somewhere in the file).
- A deduction dated after today is a data error. Today is the real date unless `AS_OF` is set.
- "Complete" in the spreadsheet means *done* but says nothing about outcome or money, so those 96 rows are closed as "legacy, no outcome" and left out of recovery rates rather than guessed at. They can be reopened.
- A bare "dispute" status means the claim isn't filed yet (Preparing). "Dispute - Filed" means Submitted with an unknown filing date.
- "Freight Allowance" maps to FREIGHT, "GFC" to Gordon Food Service (the export also has "Gordon Food Service (GFC)").
- Bare and zero-padded invoice numbers are the same `INV-` series.
- One dispute per deduction; appeals stay on the same dispute. A withdrawn dispute closes the deduction.
- Payments can't exceed the approval, and approvals can't exceed the claim.
- Amounts use the company's currency unless the value states one (`"USD 12.34"`).
- The demo users and their company access are made up; the brief doesn't say who works on what.

## Tradeoffs

- **SQLite via `node:sqlite`.** Zero setup and no native build step, which suits a take-home. It's single-writer and the module is still marked experimental; in production I'd use Postgres with migrations and row-level security as a second line of defence for tenant scoping.
- **Raw SQL instead of an ORM.** The queries (scoping, metrics) are easy to read and test at this size. A larger codebase would want a query builder and generated types.
- **Simulated demo history.** The export has no outcomes or payments, so every recovery chart would be empty. `db:reset` replays about four months of plausible analyst work *through the same workflow functions the API uses* (so it can't create impossible states). Every simulated event is marked and shown with a "Simulated" badge, and `--no-demo` turns it off. Three records (#1734, #1298, #1134) are left exactly as imported, so a live demo always starts from the same examples.
- **Normalization rules live in code** (alias tables, format parsers) with unit tests. That makes them reviewable, but an admin can't add a new retailer spelling without a deploy.
- **Metrics are computed per request.** Fine for ~1,000 rows (API responses take 1–2 ms locally); at scale I'd keep aggregates or materialized views.
- **Import is a full rebuild,** not an incremental sync, so re-importing discards work done in the app.
- **Scoping is per company only.** There are no per-retailer permissions and no approval step for write-offs.
- **Auth is email + password with seeded accounts** (scrypt hashes, signed httpOnly session cookie). Signed cookies work across serverless instances but can't be revoked before they expire (7 days); signing out just clears the cookie. A real deployment would use the company's SSO.
- **The Vercel deployment is a sandbox.** Each function instance keeps its own in-memory database, so edits don't persist or sync between instances. Fine for reviewers clicking around; a hosted database would fix it (see above).

## What I'd improve with more time

1. **Incremental imports.** Upsert by source id so new exports merge with work already done, plus an import history and an in-app upload.
2. **Remittance matching.** Detect repayments on incoming remittances and suggest matching them to approved disputes, instead of relying on manual entry.
3. **Retailer dispute windows.** Per-retailer deadlines, alerts before claims expire, and SLA reminders for disputes sitting in Submitted.
4. **Claim packets.** Attach POD/BOL/pricing backup to disputes and generate the claim document. Integrate with retailer portals where possible.
5. **Admin-editable mappings** for retailer and reason aliases, applied retroactively.
6. **Backfill flow for legacy "Complete" rows** so their outcomes can be recorded and counted.
7. **Roles and approvals:** read-only users, manager sign-off for write-offs above a threshold.
8. **Engineering:** Postgres + migrations, Playwright end-to-end tests, CI, FX conversion for multi-currency reporting, cursor pagination.

## Project layout

```
data/                     the four JSON files from the brief (unchanged)
shared/domain.ts          statuses, stages, legal transitions, issue catalogue (used by API + UI)
shared/api.ts             JSON response types
server/src/import/        normalize.ts (pure parsers) + importer.ts (export → SQLite)
server/src/domain/        workflow.ts (state machines), queries.ts, metrics.ts, dataQuality.ts, auth.ts
server/src/http/app.ts    Express routes; every route resolves the signed-in user's scope first
server/src/serverless.ts  Vercel entry: builds the in-memory sandbox and serves the API
scripts/build-vercel.mjs  writes .vercel/output (static app + bundled API function + routes)
server/src/seed/          demo users + simulated history
server/test/              normalize, importer (real export), workflow, API scoping
web/src/pages/            Overview, Deductions, Disputes, Data quality, Login
web/src/components/       deduction drawer, action dialogs, layout, shadcn/ui
```
