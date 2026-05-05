# Fund Admin — Database

PostgreSQL 14+ schema for the books-of-record.

## Files

- `migrations/0001_initial_schema.sql` — full initial schema. Idempotent
  to a clean DB. Adds `pgcrypto` and `citext` extensions.
- `seed/0001_chart_of_accounts.sql` — standard hedge-fund chart of
  accounts. Seeds once per fund. Uses a `:fund_id` psql variable.

## Apply the schema (local dev)

```bash
# 1. Spin up Postgres locally (Docker is fine):
docker run --name dga-fund-pg -e POSTGRES_PASSWORD=devpw -p 5432:5432 -d postgres:16

# 2. Create the database:
psql postgres://postgres:devpw@localhost:5432/postgres -c 'CREATE DATABASE dga_fund_dev;'

# 3. Apply the schema:
psql postgres://postgres:devpw@localhost:5432/dga_fund_dev \
     -f migrations/0001_initial_schema.sql

# 4. Insert your fund (one-time):
psql postgres://postgres:devpw@localhost:5432/dga_fund_dev <<'SQL'
INSERT INTO funds (
    name, short_name, structure, domicile, base_ccy,
    inception_date, fiscal_year_end,
    mgmt_fee_pct, mgmt_fee_basis, mgmt_fee_freq,
    carry_pct, hurdle_pct, catch_up_pct,
    max_lps, status
) VALUES (
    'DGA Capital Fund I, LP', 'DGA-I', '3c1', 'DE', 'USD',
    '2026-01-01', '2026-12-31',
    0.0200, 'committed', 'quarterly',
    0.20, 0.08, 1.00,
    99, 'open'
);
SELECT id FROM funds WHERE short_name = 'DGA-I';
SQL

# 5. Seed the chart of accounts (replace <FUND_UUID> with the id from step 4):
psql postgres://postgres:devpw@localhost:5432/dga_fund_dev \
     -v fund_id=<FUND_UUID> \
     -f seed/0001_chart_of_accounts.sql
```

## Apply the schema (Railway production)

1. In Railway, add a Postgres plugin to your project.
2. Copy the `DATABASE_URL` Railway gives you.
3. Run the migration locally pointing at Railway:
   ```bash
   psql "$DATABASE_URL" -f migrations/0001_initial_schema.sql
   ```
4. Insert the fund row + seed the CoA the same way.

## Migration tooling — future

Phase 1 of the suite migration will switch to **alembic** (Python-native
migrations) once we have the FastAPI service:

```python
# apps/fund/api/db/alembic/env.py — TBD
```

Until then, raw SQL files are the source of truth. Each new migration
gets a numbered file (`0002_…`, `0003_…`) and is appended to a
`schema_migrations` table.

## Test that the constraints actually work

Quick sanity checks you can run after applying:

```sql
-- 1. Trial balance is zero (no transactions yet → all zeros, balance=0)
SELECT type, SUM(balance) FROM v_trial_balance GROUP BY type;

-- 2. The double-entry trigger blocks unbalanced transactions:
BEGIN;
INSERT INTO transactions (id, fund_id, effective_date, category, description)
    VALUES (gen_random_uuid(), '<FUND_UUID>', '2026-01-01', 'opening_balance', 'test');
-- Insert a debit but no matching credit:
INSERT INTO transaction_lines (transaction_id, line_number, account_id, debit)
    SELECT (SELECT id FROM transactions ORDER BY posted_at DESC LIMIT 1),
           1, (SELECT id FROM accounts WHERE code='1010' LIMIT 1), 1000;
COMMIT;
-- Should ERROR: Transaction <uuid> unbalanced: debit=1000.0000 credit=0.0000
```
