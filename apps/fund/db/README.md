# Fund Admin — Database

PostgreSQL 14+ schema for the books-of-record.

## Files

- `migrations/0001_initial_schema.sql` — full initial schema. Idempotent
  to a clean DB. Adds `pgcrypto` and `citext` extensions.
- `seed/0001_chart_of_accounts.sql` — standard hedge-fund chart of
  accounts. Seeds once per fund. Uses a `:fund_id` placeholder.
- `apply_schema.py` — Python helper that applies migration + seed in one
  shot. No `psql` or Docker required.

---

## Option A — Python helper (recommended, no psql needed)

`psycopg2-binary` must be installed:
```bash
pip3 install psycopg2-binary
```

### Apply to Railway Postgres

1. In Railway, open your project → **Add Plugin → PostgreSQL**.
2. Click the Postgres plugin → **Connect** tab → copy the `DATABASE_URL`.
3. From the repo root:

```bash
cd /path/to/Claude_Research_Analyst
DATABASE_URL="postgres://..." python3 apps/fund/db/apply_schema.py
```

Save the `Fund ID` printed at the end — add it as `FUND_ID` in Railway env vars.

### Apply to local Docker Postgres

```bash
# Start Docker Desktop first, then:
cd /path/to/Claude_Research_Analyst
python3 apps/fund/db/apply_schema.py --local
```

---

## Option B — psql (if you have it)

Install psql on Mac (no Docker required):
```bash
brew install libpq
echo 'export PATH="/usr/local/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Apply to Railway Postgres

```bash
cd /path/to/Claude_Research_Analyst
psql "$DATABASE_URL" -f apps/fund/db/migrations/0001_initial_schema.sql
psql "$DATABASE_URL" <<'SQL'
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
) ON CONFLICT (short_name) DO NOTHING RETURNING id;
SQL

# Seed CoA (replace <FUND_UUID> with the id returned above):
psql "$DATABASE_URL" \
     -v fund_id=<FUND_UUID> \
     -f apps/fund/db/seed/0001_chart_of_accounts.sql
```

### Apply locally with Docker

```bash
# Spin up Postgres:
docker run --name dga-fund-pg -e POSTGRES_PASSWORD=devpw -p 5432:5432 -d postgres:16

# Apply (run from repo root):
psql postgres://postgres:devpw@localhost:5432/postgres -c 'CREATE DATABASE dga_fund_dev;'
psql postgres://postgres:devpw@localhost:5432/dga_fund_dev \
     -f apps/fund/db/migrations/0001_initial_schema.sql
```

---

## Migration tooling — future

Phase 1 switches to **alembic** (Python-native migrations) once the
FastAPI service is running:

```python
# apps/fund/api/db/alembic/env.py — TBD
```

Until then, raw SQL files are the source of truth. Each new migration
gets a numbered file (`0002_…`, `0003_…`).

---

## Verify the schema

After applying, run these checks:

```sql
-- All 19 tables present:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY 1;

-- Trial balance is zero (no transactions yet):
SELECT type, SUM(balance) FROM v_trial_balance GROUP BY type;

-- Double-entry trigger blocks unbalanced transactions:
BEGIN;
INSERT INTO transactions (id, fund_id, effective_date, category, description)
    VALUES (gen_random_uuid(), '<FUND_UUID>', '2026-01-01', 'opening_balance', 'test');
INSERT INTO transaction_lines (transaction_id, line_number, account_id, debit)
    SELECT (SELECT id FROM transactions ORDER BY posted_at DESC LIMIT 1),
           1, (SELECT id FROM accounts WHERE code='1010' LIMIT 1), 1000;
COMMIT;
-- Should ERROR: Transaction <uuid> unbalanced: debit=1000.0000 credit=0.0000
```
