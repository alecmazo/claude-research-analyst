"""
reset_lps.py — wipe all transactional data for DGA-I and replace LP records
               with anonymized test names (EM, VK, DY).  No transactions are
               created; the fund is left in a clean, empty state ready for real
               data entry.

Usage:
    DATABASE_URL="postgresql://..." python3 apps/fund/db/reset_lps.py
"""

import os
import sys
import uuid
from decimal import Decimal

import psycopg2
from psycopg2.extras import RealDictCursor

LP_DATA = [
    {"legal_name": "EM", "code": "EM", "commitment": Decimal("1000000.00")},
    {"legal_name": "VK", "code": "VK", "commitment": Decimal("500000.00")},
    {"legal_name": "DY", "code": "DY", "commitment": Decimal("500000.00")},
]

def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: set DATABASE_URL before running.", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            # ── locate fund ──────────────────────────────────────────────────
            cur.execute("SELECT id FROM funds WHERE short_name = 'DGA-I' LIMIT 1")
            row = cur.fetchone()
            if not row:
                print("ERROR: fund DGA-I not found — run apply_schema.py first.")
                sys.exit(1)
            fund_id = row["id"]
            print(f"Fund: DGA-I  ({fund_id})")

            # ── wipe all transactional data ──────────────────────────────────
            print("\nClearing transactional data…")

            cur.execute("DELETE FROM tax_lots WHERE fund_id = %s", (fund_id,))
            print("  ✓ tax_lots")

            cur.execute("""DELETE FROM transaction_lines
                            WHERE transaction_id IN
                                  (SELECT id FROM transactions WHERE fund_id = %s)""",
                        (fund_id,))
            cur.execute("DELETE FROM transactions WHERE fund_id = %s", (fund_id,))
            print("  ✓ transactions")

            cur.execute("""DELETE FROM capital_call_allocations
                            WHERE capital_call_id IN
                                  (SELECT id FROM capital_calls WHERE fund_id = %s)""",
                        (fund_id,))
            cur.execute("DELETE FROM capital_calls WHERE fund_id = %s", (fund_id,))
            print("  ✓ capital_calls")

            cur.execute("""DELETE FROM commitments
                            WHERE lp_id IN (SELECT id FROM lps WHERE fund_id = %s)""",
                        (fund_id,))
            print("  ✓ commitments")

            cur.execute("""DELETE FROM accounts
                            WHERE fund_id = %s
                              AND (lp_id IS NOT NULL OR security_id IS NOT NULL)""",
                        (fund_id,))
            print("  ✓ per-LP / per-security accounts")

            cur.execute("DELETE FROM lps WHERE fund_id = %s", (fund_id,))
            print("  ✓ lps (old records removed)")

            # ── insert anonymized LP records ─────────────────────────────────
            print("\nCreating anonymized LP records…")
            for lp in LP_DATA:
                lp_id = str(uuid.uuid4())
                cur.execute("""
                    INSERT INTO lps
                          (id, fund_id, legal_name, code, entity_type,
                           accredited_investor_type, status, created_at)
                    VALUES (%s, %s, %s, %s, 'individual', 'net_worth', 'active', NOW())
                """, (lp_id, fund_id, lp["legal_name"], lp["code"]))
                print(f"  ✓  {lp['legal_name']}")

        conn.commit()
        print("\nDone. Fund DGA-I now has 3 anonymous LPs (EM, VK, DY) and no transactions.")

    except Exception as e:
        conn.rollback()
        print(f"\nERROR — rolled back: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()

if __name__ == "__main__":
    main()
