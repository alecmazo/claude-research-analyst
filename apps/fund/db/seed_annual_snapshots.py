#!/usr/bin/env python3
"""
seed_annual_snapshots.py — seeds fund_annual_snapshots from year_end_NAV.xlsx

Usage:
    DATABASE_URL="postgres://..." python3 seed_annual_snapshots.py
    python3 seed_annual_snapshots.py --url "postgres://..."

Data source: Dropbox/Apps/year_end_NAV.xlsx
  • 2016–2025 rows inserted (2026 has no end NAV — skipped)
  • Fund inception_date updated to 2016-01-01
  • gp_equity_end = accum_gp_fraction × end_nav  (dollar stake at year end)
"""
import os
import sys
import argparse
import psycopg2

# ── Annual NAV data (parsed from year_end_NAV.xlsx) ──────────────────────────
#
# Columns: year, start_nav, end_nav, contributions, hurdle_amount,
#          carry_earned, carry_paid, accum_gp_fraction
#
# Notes:
#   • carry_paid = 0 for all years (carry rolled into GP equity, never paid out)
#   • carry_rolled = carry_earned (no cash distributions)
#   • gp_equity_end = accum_gp_fraction × end_nav
#   • 2026 omitted — year in progress, no end_nav yet

ANNUAL_DATA = [
    # year,  start_nav,    end_nav,   contrib,  hurdle,   carry_earned, accum_gp_frac
    (2016,  2_000_000.00,  3_782_004.00,  0,  100_000,    420_501.00,  0.11118470525150158),
    (2017,  3_738_004.00,  3_032_136.00,  0,  100_000,          0.00,  0.11120000000000000),
    (2018,  3_032_136.00,  1_712_407.00,  0,  100_000,          0.00,  0.11120000000000000),
    (2019,  1_712_407.00,  3_916_125.00,  0,  100_000,     33_530.25,  0.11974680426519496),
    (2020,  3_916_125.00,  3_085_258.00,  0,  100_000,          0.00,  0.11970000000000000),
    (2021,  3_085_258.00,    908_156.80,  0,  100_000,          0.00,  0.11970000000000000),
    (2022,    908_156.80,    586_739.50,  0,  100_000,          0.00,  0.11970000000000000),
    (2023,    586_739.50,    937_964.45,  0,  100_000,          0.00,  0.11970000000000000),
    (2024,    937_964.45,  3_842_741.00,  0,  100_000,          0.00,  0.11970000000000000),
    (2025,  3_842_741.00,  4_958_543.00,  0,  100_000,    260_604.50,  0.17225666836004044),
]

UPSERT_SQL = """
INSERT INTO fund_annual_snapshots (
    fund_id, year,
    start_nav, end_nav, contributions,
    hurdle_amount, gross_profit,
    carry_earned, carry_paid, carry_rolled,
    gp_equity_end
) VALUES (
    %(fund_id)s, %(year)s,
    %(start_nav)s, %(end_nav)s, %(contributions)s,
    %(hurdle_amount)s, %(gross_profit)s,
    %(carry_earned)s, %(carry_paid)s, %(carry_rolled)s,
    %(gp_equity_end)s
)
ON CONFLICT (fund_id, year) DO UPDATE SET
    start_nav       = EXCLUDED.start_nav,
    end_nav         = EXCLUDED.end_nav,
    contributions   = EXCLUDED.contributions,
    hurdle_amount   = EXCLUDED.hurdle_amount,
    gross_profit    = EXCLUDED.gross_profit,
    carry_earned    = EXCLUDED.carry_earned,
    carry_paid      = EXCLUDED.carry_paid,
    carry_rolled    = EXCLUDED.carry_rolled,
    gp_equity_end   = EXCLUDED.gp_equity_end,
    updated_at      = NOW();
"""

UPDATE_INCEPTION = """
UPDATE funds SET inception_date = '2016-01-01'
WHERE short_name = 'DGA-I'
RETURNING id, name, inception_date;
"""


def main():
    parser = argparse.ArgumentParser(description="Seed fund_annual_snapshots")
    parser.add_argument("--url", help="Explicit DATABASE_URL")
    args = parser.parse_args()

    db_url = args.url or os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: Set DATABASE_URL env var or pass --url")
        sys.exit(1)

    print("Connecting to database…")
    conn = psycopg2.connect(db_url)
    cur  = conn.cursor()

    # 1. Get fund_id
    cur.execute("SELECT id FROM funds WHERE short_name = 'DGA-I'")
    row = cur.fetchone()
    if not row:
        print("ERROR: Fund DGA-I not found. Run apply_schema.py first.")
        conn.close(); sys.exit(1)
    fund_id = str(row[0])
    print(f"  ✓ Fund DGA-I  id={fund_id}")

    # 2. Update inception_date to 2016-01-01
    cur.execute(UPDATE_INCEPTION)
    inc_row = cur.fetchone()
    if inc_row:
        print(f"  ✓ inception_date → {inc_row[2]}")
    conn.commit()

    # 3. Upsert annual snapshots
    print(f"\nInserting {len(ANNUAL_DATA)} annual snapshots…\n")
    print(f"  {'Year':>4}  {'Start NAV':>13}  {'End NAV':>13}  {'Gross Profit':>13}  "
          f"{'Hurdle':>9}  {'Carry Earned':>13}  {'GP Equity $':>13}")
    print(f"  {'─'*4}  {'─'*13}  {'─'*13}  {'─'*13}  {'─'*9}  {'─'*13}  {'─'*13}")

    for year, start, end, contrib, hurdle, carry_earned, accum_frac in ANNUAL_DATA:
        gross_profit  = end - start - contrib
        carry_paid    = 0.00
        carry_rolled  = carry_earned
        gp_equity_end = round(accum_frac * end, 2)

        params = dict(
            fund_id      = fund_id,
            year         = year,
            start_nav    = start,
            end_nav      = end,
            contributions= contrib,
            hurdle_amount= hurdle,
            gross_profit = gross_profit,
            carry_earned = carry_earned,
            carry_paid   = carry_paid,
            carry_rolled = carry_rolled,
            gp_equity_end= gp_equity_end,
        )
        cur.execute(UPSERT_SQL, params)

        profit_sign = '+' if gross_profit >= 0 else ''
        print(f"  {year}  {start:>13,.0f}  {end:>13,.0f}  "
              f"{profit_sign}{gross_profit:>12,.0f}  {hurdle:>9,.0f}  "
              f"{carry_earned:>13,.2f}  {gp_equity_end:>13,.2f}")

    conn.commit()
    conn.close()

    print(f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Annual snapshots seeded successfully!
  Years covered: 2016–2025  (2026 in progress)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The waterfall endpoint will now return
data_source: "annual_snapshots" and display
the year-by-year table on web and mobile.
""")


if __name__ == "__main__":
    main()
