#!/usr/bin/env python3
"""
apply_schema.py — applies the Fund Admin schema to a Postgres database.

Usage:
    # Option A: pass DATABASE_URL as env var (Railway)
    DATABASE_URL="postgres://user:pw@host/db" python3 apply_schema.py

    # Option B: local Docker (after `docker run` from README)
    python3 apply_schema.py --local

    # Option C: explicit URL
    python3 apply_schema.py --url "postgres://user:pw@host/db"
"""
import os
import sys
import argparse
import pathlib
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

BASE = pathlib.Path(__file__).parent

MIGRATION  = BASE / "migrations" / "0001_initial_schema.sql"
MIGRATION2 = BASE / "migrations" / "0002_annual_snapshots.sql"
SEED_COA  = BASE / "seed"       / "0001_chart_of_accounts.sql"

LOCAL_URL = "postgres://postgres:devpw@localhost:5432/dga_fund_dev"

FUND_INSERT = """
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
)
ON CONFLICT (short_name) DO NOTHING
RETURNING id;
"""

def run_sql_file(conn, path: pathlib.Path, substitutions: dict = None):
    """Execute a .sql file, optionally replacing :var tokens (psql-style)."""
    sql = path.read_text()
    if substitutions:
        for key, val in substitutions.items():
            sql = sql.replace(f":{key}", val)
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    print(f"  ✓ {path.name}")

def ensure_local_db(admin_url: str, db_name: str):
    """Create the local database if it doesn't exist."""
    conn = psycopg2.connect(admin_url)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with conn.cursor() as cur:
        cur.execute(f"SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
        if not cur.fetchone():
            cur.execute(f'CREATE DATABASE "{db_name}"')
            print(f"  ✓ Created database '{db_name}'")
        else:
            print(f"  ✓ Database '{db_name}' already exists")
    conn.close()

def main():
    parser = argparse.ArgumentParser(description="Apply Fund Admin schema")
    parser.add_argument("--local", action="store_true",
                        help="Use local Docker Postgres (localhost:5432)")
    parser.add_argument("--url", help="Explicit DATABASE_URL")
    args = parser.parse_args()

    if args.url:
        db_url = args.url
    elif args.local:
        # Create the local DB first (connecting to default 'postgres' db)
        admin_url = "postgres://postgres:devpw@localhost:5432/postgres"
        print("Creating local database...")
        ensure_local_db(admin_url, "dga_fund_dev")
        db_url = LOCAL_URL
    else:
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            print("ERROR: Set DATABASE_URL env var or pass --url / --local")
            sys.exit(1)

    print(f"\nConnecting to database...")
    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        print(f"ERROR: Could not connect: {e}")
        sys.exit(1)

    print(f"Connected ✓\n")

    # 1. Apply migrations
    print("Step 1/4 — Applying initial schema migration...")
    run_sql_file(conn, MIGRATION)

    print("Step 2/4 — Applying annual snapshot migration (0002)...")
    run_sql_file(conn, MIGRATION2)

    # 3. Insert fund row
    print("\nStep 3/4 — Inserting DGA-I fund row...")
    with conn.cursor() as cur:
        cur.execute(FUND_INSERT)
        row = cur.fetchone()
        if row:
            fund_id = str(row[0])
            print(f"  ✓ Fund inserted: id={fund_id}")
        else:
            cur.execute("SELECT id FROM funds WHERE short_name = 'DGA-I'")
            fund_id = str(cur.fetchone()[0])
            print(f"  ✓ Fund already exists: id={fund_id}")
    conn.commit()

    # 4. Seed chart of accounts
    print(f"\nStep 4/4 — Seeding chart of accounts for fund {fund_id}...")
    # :fund_id is replaced with 'uuid-value' so :fund_id::uuid becomes 'uuid'::uuid
    run_sql_file(conn, SEED_COA, substitutions={"fund_id": f"'{fund_id}'"})

    conn.close()

    print(f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Fund Admin schema applied successfully!
  Fund ID (save this): {fund_id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Add this to your Railway environment variables:
       FUND_ID={fund_id}
  2. Verify schema: connect to the DB and run:
       SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY 1;
""")

if __name__ == "__main__":
    main()
