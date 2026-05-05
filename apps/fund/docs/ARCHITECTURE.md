# Fund Admin — Architecture

The big picture, opinionated.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│  UI (mobile + web)                                                 │
│  - Operator screens: cap table, trade entry, run mgmt fee,         │
│    issue statements                                                │
│  - LP self-serve: read-only statements                             │
└────────────────────────────────────────────────────────────────────┘
                                  ↕ JSON over HTTPS, JWT auth
┌────────────────────────────────────────────────────────────────────┐
│  FastAPI service (apps/fund/api/server.py — TBD in Phase 1)        │
│  - Validation                                                      │
│  - Orchestration (e.g. "post a capital call" → write the call,     │
│    its allocations, and the corresponding transactions in one      │
│    DB transaction)                                                 │
│  - Period-end batch jobs (NAV snapshots, mgmt fee runs)            │
└────────────────────────────────────────────────────────────────────┘
                                  ↕ SQL
┌────────────────────────────────────────────────────────────────────┐
│  Postgres                                                          │
│  - The schema in this directory                                    │
│  - Constraints + triggers enforce invariants the API can't easily  │
│    (double-entry balance, immutable ledger)                        │
└────────────────────────────────────────────────────────────────────┘
                                  ↕ object storage
┌────────────────────────────────────────────────────────────────────┐
│  Dropbox (or S3/R2 later)                                          │
│  - Subscription documents (PDF)                                    │
│  - LP quarterly statements (PDF)                                   │
│  - Accreditation evidence                                          │
└────────────────────────────────────────────────────────────────────┘
```

## Why double-entry?

Single-entry bookkeeping (just a ledger of "+10K from Alec, -5K paid
out, balance=5K") looks simpler but doesn't survive auditor scrutiny.
With double entry every movement has two sides — debit one account,
credit another — and the books always balance. That's how real fund
accounting works and how an auditor expects to see it.

Concrete example: when an LP wires in $100K against a capital call:

```
Transaction: contribution from LP "Acme Trust", call #3
  dr  1010  Cash — Operating               $100,000
      cr  3100-acme  Capital — Acme Trust              $100,000
```

The ledger now shows $100K more cash *and* $100K more LP capital.
The trial balance still nets to zero. There's no way to credit cash
without also crediting an offsetting account.

When the GP collects management fees:

```
Transaction: mgmt fee accrual for Q1 2026
  dr  5100  Mgmt Fee Expense                $50,000
      cr  2100  Accrued Mgmt Fee                       $50,000

(Later, when paid:)
Transaction: mgmt fee payment
  dr  2100  Accrued Mgmt Fee                $50,000
      cr  1010  Cash — Operating                       $50,000
```

The accrual hits the P&L (5100 is an expense). The payment doesn't —
it just zeros out the accrual against cash. This is how the books
distinguish "we owe ourselves $50K" from "the GP has been paid $50K".

See `DOUBLE_ENTRY.md` for worked examples of every transaction type.

## Why immutable?

> "The first rule of accounting: you don't fix mistakes by editing
> history. You post a correcting entry."

An immutable ledger means:

- An auditor can take a snapshot of the database at any point in time
  and reproduce the books exactly as the GP saw them on that day.
- A bug in the application can't silently corrupt a posted transaction.
  Worst case it posts a *new* bad transaction, which a subsequent
  reversal can back out — both visible in the audit trail.
- Restatements are first-class: the schema lets a Q1 statement v2
  coexist with v1 forever.

The schema enforces this by convention, not strict triggers (which
would prevent legitimate corrections during dev). The application is
expected to follow the rule:

```python
# WRONG — never do this
db.execute("UPDATE transactions SET amount = ? WHERE id = ?", (new_amt, txn_id))

# RIGHT
post_reversal_of(txn_id)              # creates a new txn that flips d/c
post_corrected_transaction(...)        # creates the right txn
```

## Why a separate Postgres database?

The Research app stores cached `.md` reports, Gamma URLs, and quote
snapshots in Dropbox JSON files. That's fine — losing it costs you
re-running an analysis. Cheap to recover.

Fund Admin stores LP commitments and the books of a real fund.
Losing it costs you a regulatory headache, restatement, and
reputational damage. Cheap to back up, expensive to lose. Postgres
gets the right tradeoffs:

- ACID transactions
- Foreign keys
- Triggers
- WAL replication for backups
- A real query language for ad-hoc reporting

Railway's Postgres add-on does daily snapshots automatically; we
should also take a logical dump (`pg_dump`) into Dropbox after every
NAV snapshot to have an offsite copy.

## Period-end flow

The hardest moment in the calendar is the end-of-quarter close. The
intended flow:

```
T+0:  Trading day ends. EOD market data lands.
T+1:  Operator runs mark-to-market: post unrealized gain/loss
      transactions for every open position.
T+1:  Run the period mgmt-fee accrual.
T+1:  Compute the period NAV snapshot (status='draft').
T+1:  Run the carry calculation (hurdle + HWM lookback).
T+2:  Operator reviews the draft snapshot; posts any adjustments.
T+2:  Mark the snapshot status='final'.
T+2:  Generate per-LP statements (status='draft').
T+3:  Operator review; flip statements to 'review' then 'sent'.
T+3:  Email statements to each LP via Resend.
```

Each step has its own DB transaction; failures roll back cleanly.

## Auth model (Phase 1)

The Research app uses an HMAC password → token. Fund Admin extends:

- **Operator tokens** (admin / accountant / viewer): full access scoped
  by role.
- **LP tokens** (`role='lp'`): limited to that LP's own rows. Every
  query is filtered by `WHERE lp_id = current_user_lp()`.

The session middleware sets a transaction-local Postgres setting
`app.current_lp_id` and views/policies use that. (Postgres Row-Level
Security is overkill for v1 — application-level filtering is enough
provided every query path goes through the API.)

## Reporting

Read-side queries either:

1. **Live joins** for ad-hoc views (the included `v_lp_balance_today`,
   `v_trial_balance` show the pattern).
2. **Materialized snapshots** for anything period-tied — that's what
   `nav_snapshots` + `nav_snapshot_lp` are for. Built once per period,
   queried fast forever.

Don't try to compute IRR from raw transactions on every page load —
materialize it into the snapshot.
