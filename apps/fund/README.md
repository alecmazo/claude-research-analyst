# DGA Capital — Fund Admin

The books-of-record for a 3(c)(1) hedge fund. Owns the cap table, LP
capital accounts, mgmt-fee + carry calculations, NAV snapshots, LP
quarterly statements, and the immutable double-entry transaction
ledger.

**Status:** schema-first. The Postgres schema is real and runnable;
the FastAPI service and UI are not yet built. Phase 1 of the suite
migration (see `../../MONOREPO.md`) builds the runtime against this
schema.

---

## Why a separate app?

Research is a *generator* — it produces reports and feeds them to a
cache. Fund Admin is a *system of record* — every cash and security
movement must be traceable, auditable, and immutable. Mixing them in
one codebase would dilute the discipline Fund Admin needs.

Hard rules for Fund Admin (which Research doesn't follow, by design):

1. **Postgres, not Dropbox JSON.** Every transaction goes to a
   relational store with constraints + foreign keys.
2. **Double-entry.** No naked balance updates — every cash or position
   movement creates a transaction with balanced debit/credit lines. A
   deferred trigger in the schema enforces it.
3. **Immutable ledger.** Once a transaction posts, it is never updated
   or deleted. Corrections are made via a reversing transaction that
   references the original.
4. **Versioned LP statements.** Restated quarterly statements coexist
   with the original — both rows survive, the PDF hash is recorded.
5. **Audit log.** Every mutating action records who did it, when, from
   where, and the JSONB before/after of the affected row.

---

## Current contents

```
apps/fund/
├── README.md                                ← this file
├── db/
│   ├── README.md                            ← how to apply migrations
│   ├── migrations/
│   │   └── 0001_initial_schema.sql          ← the schema (real)
│   └── seed/
│       └── 0001_chart_of_accounts.sql       ← standard hedge-fund CoA
└── docs/
    ├── ARCHITECTURE.md                      ← design rationale
    ├── DOUBLE_ENTRY.md                      ← worked examples of every txn
    ├── COMPLIANCE_3C1.md                    ← 3(c)(1) constraints & checks
    └── WATERFALL.md                         ← carry math (hurdle + HWM)
```

The schema can be applied today against any Postgres 14+ instance
(Railway has a one-click Postgres add-on). See `db/README.md` for the
exact commands.

---

## Roadmap

### M1 — Schema + Postgres on Railway *(this PR ships M1)*
- [x] Schema migration `0001_initial_schema.sql`
- [x] Chart-of-accounts seed
- [x] Architecture docs

### M2 — FastAPI service skeleton
- New Railway service `dga-fund-api`.
- Apply the migration on first deploy via `alembic` or raw psql.
- Endpoints: `/lps`, `/commitments`, `/capital-calls`, `/distributions`,
  `/transactions`, `/nav-snapshots`.
- Auth via `@dga/auth` once that lives in `packages/auth/`.

### M3 — Cap table CRUD + LP onboarding
- Web + mobile screens to add LPs, commitments.
- Subscription document upload (Dropbox).
- Auto-creation of per-LP capital accounts in the chart of accounts.

### M4 — Trade entry + position keeping
- Manual trade entry (buy/sell with FIFO cost-basis tracking).
- Optional broker-statement import (Fidelity/IBKR CSV).
- Mark-to-market end-of-day from `/api/quote/{ticker}` (reuse Research).

### M5 — NAV snapshots
- Period-end (monthly/quarterly) snapshot generator.
- Per-LP capital account allocation.
- Posts allocation entries to the ledger.

### M6 — Mgmt fee + carry runs
- Mgmt fee calculator (committed / contributed / NAV bases).
- Carry calculator with hurdle + high-water mark per LP.
- Both produce posted transactions.

### M7 — LP statements (PDF)
- PDF generator with Wall Street formatting (reuse
  `@dga/wall-street-format` once it exists).
- Versioning, SHA-256 of bytes, email send via Resend.
- Restatement workflow.

### M8 — K-1 generation
- Year-end tax forms for each LP.
- This is the hardest math — defer until M3–M7 are stable.

### M9 — LP self-serve portal
- LP users (role='lp') log in and see only their statements + cap activity.
- Read-only.
- Mobile module too.

---

## Key design decisions (already locked in by the schema)

| Decision | Rationale |
|----------|-----------|
| `NUMERIC(20,4)` for money | Float math + accounting = immediate disaster. 4 decimals supports 3-decimal-point pricing of swaps without truncation. |
| `NUMERIC(20,8)` for crypto qty | 8 decimals supports BTC sat precision. |
| UUIDs for primary keys | Distributed-friendly + can be generated client-side without round-trip. Avoids exposing row counts in URLs. |
| Polymorphic `source_kind/source_id` on transactions | Lets a transaction reference any kind of source document (capital_call, distribution, mgmt_fee_run) without N FK columns. Application enforces consistency. |
| JSONB for distribution `class` breakdown | The set of tax classes (`return_of_capital`, `ltcg`, `stcg`, `dividend`, `interest`, `other`) is small but evolves over time. JSONB gives flexibility without migrations every time we add a class. |
| Restated rows kept alongside originals | Investor protection — if you have to issue a Q1 restatement six months later, both versions are preserved with their PDFs. |
| Deferred trigger for double-entry balance | The application can insert all lines in one BEGIN/COMMIT; the trigger fires once at COMMIT. Keeps the API ergonomic without losing safety. |

---

## Things explicitly NOT in this app

- **Research / report generation.** Stays in Research.
- **Trade execution.** This is a fund-admin app, not an OMS. It records
  trades, doesn't place them.
- **Tax filing.** It generates K-1 inputs — your CPA files.
- **Compliance filings (Form D, ADV).** Out of scope.
