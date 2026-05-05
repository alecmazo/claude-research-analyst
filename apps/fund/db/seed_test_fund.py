#!/usr/bin/env python3
"""
seed_test_fund.py — Seeds DGA Capital Fund I with test data.

What this creates:
  • Updates fund economics (0% mgmt fee, 25% carry, 5% hurdle)
  • 3 LP records + 1 GP: EM, DY, VK (LPs), AM (GP)
  • Capital call #1 — $2,000,000 initial contributions (Jan 1 2017)
  • Contribution journal entries: dr Cash / cr LP Capital per LP
  • Accumulated gains entry: 9-year growth from $2M → $3.69M
  • Cash transfer: Operating → Brokerage
  • 18 unique GSE preferred securities
  • 19 trade buy transactions + tax lots
  • Trial balance printed at the end

Prerequisites:
  - apply_schema.py must have been run first
  - pip3 install psycopg2-binary

Usage:
  DATABASE_URL="postgres://..." python3 apps/fund/db/seed_test_fund.py
  DATABASE_URL="postgres://..." python3 apps/fund/db/seed_test_fund.py --reset
"""

from decimal import Decimal
from datetime import date, datetime, timezone
import os, sys, uuid, argparse
import psycopg2
from psycopg2.extras import RealDictCursor

# ===========================================================================
# ── FUND ECONOMICS  (all adjustable) ────────────────────────────────────────
# ===========================================================================
MGMT_FEE_PCT  = Decimal("0.00")    # 0%  management fee
CARRY_PCT     = Decimal("0.25")    # 25% carried interest
HURDLE_PCT    = Decimal("0.05")    # 5%  preferred return before carry
CATCH_UP_PCT  = Decimal("1.00")    # 100% GP catch-up (standard)

# ===========================================================================
# ── LP COMMITMENTS ───────────────────────────────────────────────────────────
# ===========================================================================
LP_DATA = [
    {
        "legal_name":  "EM",
        "code":        "EM",             # used in account codes: 3100-EM
        "commitment":  Decimal("1000000.00"),
        "entity_type": "individual",
        "accred_type": "net_worth",
    },
    {
        "legal_name":  "DY",
        "code":        "DY",
        "commitment":  Decimal("500000.00"),
        "entity_type": "individual",
        "accred_type": "net_worth",
    },
    {
        "legal_name":  "VK",
        "code":        "VK",
        "commitment":  Decimal("500000.00"),
        "entity_type": "individual",
        "accred_type": "net_worth",
    },
]

# General partner — stored in the lps table with entity_type='general_partner'.
# No capital commitment; excluded from capital call allocations and journal entries.
GP_DATA = {
    "legal_name":  "AM",
    "code":        "AM",
    "entity_type": "general_partner",
}

FUND_TOTAL      = Decimal("2000000.00")   # total initial LP contributions
CURRENT_NAV     = Decimal("3689569.10")   # current NAV (contributions + 9-yr growth)
FUND_SHORT_NAME = "DGA-I"
INCEPTION       = date(2017, 1, 1)        # fund inception / capital call date
TRADE_DATE      = date(2017, 1, 15)       # initial portfolio deployment date

# Accumulated gains = growth from initial contributions to current NAV.
# Represents 9 years of GSE preferred income + capital appreciation.
# Posted as a single simplified entry for test purposes.
ACCUMULATED_GAINS = CURRENT_NAV - FUND_TOTAL   # $1,689,569.10

# Trades: (symbol, quantity, price_per_share)
# FMCCK appears twice — two separate lots at different prices (intentional).
TRADES = [
    ("FNMAS",  40000,  Decimal("4.74")),
    ("FMCCH",  53301,  Decimal("8.88")),
    ("FMCCK",  27486,  Decimal("7.47")),   # Lot A
    ("FMCKM",  37363,  Decimal("6.94")),
    ("FNMFM",  17805,  Decimal("13.99")),
    ("FMCKP",  12636,  Decimal("6.65")),
    ("FNMAK",   9563,  Decimal("13.60")),
    ("FREJN",   7812,  Decimal("13.00")),
    ("FREGP",   7843,  Decimal("12.75")),
    ("FMCKN",  12009,  Decimal("6.88")),
    ("FNMAO",   6460,  Decimal("12.55")),
    ("FMCCP",   5000,  Decimal("6.69")),
    ("FNMAP",   5469,  Decimal("12.75")),
    ("FNMAN",   2181,  Decimal("13.75")),
    ("FMCCK",   2330,  Decimal("12.90")),  # Lot B — same security, different price
    ("FNMAL",   2307,  Decimal("13.50")),
    ("FREJP",   2307,  Decimal("12.97")),
    ("FNMAM",   1685,  Decimal("14.00")),
    ("FREJO",    100,  Decimal("12.81")),
]

# Cash remaining in brokerage account after all buys
BROKERAGE_CASH = Decimal("342.63")

# Security display names
SECURITY_NAMES = {
    "FNMAS": "Fannie Mae Preferred Series S",
    "FMCCH": "Freddie Mac Preferred Series H",
    "FMCCK": "Freddie Mac Preferred Series K",
    "FMCKM": "Freddie Mac Preferred Series M",
    "FNMFM": "Fannie Mae Preferred Series FM",
    "FMCKP": "Freddie Mac Preferred Series P",
    "FNMAK": "Fannie Mae Preferred Series AK",
    "FREJN": "Freddie Mac Jr. Preferred Series N",
    "FREGP": "Freddie Mac Jr. Preferred Series GP",
    "FMCKN": "Freddie Mac Preferred Series N",
    "FNMAO": "Fannie Mae Preferred Series AO",
    "FMCCP": "Freddie Mac Preferred Series CP",
    "FNMAP": "Fannie Mae Preferred Series AP",
    "FNMAN": "Fannie Mae Preferred Series AN",
    "FNMAL": "Fannie Mae Preferred Series AL",
    "FREJP": "Freddie Mac Jr. Preferred Series JP",
    "FNMAM": "Fannie Mae Preferred Series AM",
    "FREJO": "Freddie Mac Jr. Preferred Series O",
}

# ===========================================================================
# ── HELPERS ─────────────────────────────────────────────────────────────────
# ===========================================================================

def new_id() -> str:
    return str(uuid.uuid4())

def get_account(cur, fund_id: str, code: str) -> str:
    cur.execute("SELECT id FROM accounts WHERE fund_id = %s AND code = %s", (fund_id, code))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"Account '{code}' not found — run apply_schema.py first.")
    return str(row["id"])

def ensure_account(cur, fund_id: str, code: str, name: str, acct_type: str,
                   lp_id=None, security_id=None, parent_id=None) -> str:
    cur.execute("""
        INSERT INTO accounts (id, fund_id, code, name, type, lp_id, security_id, parent_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (fund_id, code) DO NOTHING
    """, (new_id(), fund_id, code, name, acct_type, lp_id, security_id, parent_id))
    return get_account(cur, fund_id, code)

def post_txn(cur, fund_id: str, eff_date, category: str, description: str,
             lines: list, source_kind=None, source_id=None) -> str:
    txn_id = new_id()
    cur.execute(
        """INSERT INTO transactions
               (id, fund_id, effective_date, category, description, source_kind, source_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (txn_id, fund_id, eff_date, category, description, source_kind, source_id),
    )
    for i, ln in enumerate(lines, 1):
        cur.execute(
            """INSERT INTO transaction_lines
                   (transaction_id, line_number, account_id, debit, credit,
                    lp_id, security_id, quantity, description)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (txn_id, i,
             ln["acct"],
             ln.get("dr", Decimal("0")),
             ln.get("cr", Decimal("0")),
             ln.get("lp_id"), ln.get("sec_id"), ln.get("qty"), ln.get("desc")),
        )
    return txn_id

# ===========================================================================
# ── RESET ───────────────────────────────────────────────────────────────────
# ===========================================================================

def reset_fund_data(cur, fund_id: str):
    print("  Clearing tax_lots…")
    cur.execute("DELETE FROM tax_lots WHERE fund_id = %s", (fund_id,))
    print("  Clearing transaction_lines…")
    cur.execute("""DELETE FROM transaction_lines
                    WHERE transaction_id IN
                          (SELECT id FROM transactions WHERE fund_id = %s)""", (fund_id,))
    print("  Clearing transactions…")
    cur.execute("DELETE FROM transactions WHERE fund_id = %s", (fund_id,))
    print("  Clearing capital_call_allocations…")
    cur.execute("""DELETE FROM capital_call_allocations
                    WHERE capital_call_id IN
                          (SELECT id FROM capital_calls WHERE fund_id = %s)""", (fund_id,))
    print("  Clearing capital_calls…")
    cur.execute("DELETE FROM capital_calls WHERE fund_id = %s", (fund_id,))
    print("  Clearing commitments…")
    cur.execute("""DELETE FROM commitments
                    WHERE lp_id IN (SELECT id FROM lps WHERE fund_id = %s)""", (fund_id,))
    print("  Clearing per-LP + per-security accounts…")
    cur.execute("""DELETE FROM accounts
                    WHERE fund_id = %s
                      AND (lp_id IS NOT NULL OR security_id IS NOT NULL)""", (fund_id,))
    print("  Clearing LPs…")
    cur.execute("DELETE FROM lps WHERE fund_id = %s", (fund_id,))
    print("  ✓ Reset complete.")

# ===========================================================================
# ── MAIN ────────────────────────────────────────────────────────────────────
# ===========================================================================

def main():
    parser = argparse.ArgumentParser(description="Seed DGA Capital Fund I test data")
    parser.add_argument("--reset", action="store_true",
                        help="Clear existing fund data before seeding")
    args = parser.parse_args()

    # ── Pre-flight checks ────────────────────────────────────────────────
    assert sum(lp["commitment"] for lp in LP_DATA) == FUND_TOTAL, \
        "LP commitments must sum to FUND_TOTAL"

    total_trade_cost = sum(Decimal(str(qty)) * price for _, qty, price in TRADES)
    brokerage_total  = total_trade_cost + BROKERAGE_CASH
    operating_cash   = CURRENT_NAV - brokerage_total
    assert operating_cash >= 0, \
        f"Trades exceed current NAV: {brokerage_total} > {CURRENT_NAV}"

    # ── Connect ──────────────────────────────────────────────────────────
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("ERROR: set DATABASE_URL env var")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:

            # ── Get fund ─────────────────────────────────────────────────
            cur.execute("SELECT id FROM funds WHERE short_name = %s", (FUND_SHORT_NAME,))
            row = cur.fetchone()
            if not row:
                sys.exit(f"ERROR: Fund '{FUND_SHORT_NAME}' not found. Run apply_schema.py first.")
            fund_id = str(row["id"])
            print(f"\nFund: {FUND_SHORT_NAME}  ({fund_id[:8]}…)")

            # ── Reset ────────────────────────────────────────────────────
            if args.reset:
                print("\n── Resetting existing data ───────────────────────────")
                reset_fund_data(cur, fund_id)

            # ─────────────────────────────────────────────────────────────
            # STEP 0 — Update fund economics
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 0/7  Fund economics ───────────────────────────────")
            cur.execute("""
                UPDATE funds SET
                    mgmt_fee_pct   = %s,
                    carry_pct      = %s,
                    hurdle_pct     = %s,
                    catch_up_pct   = %s,
                    inception_date = %s,
                    updated_at     = NOW()
                WHERE id = %s
            """, (MGMT_FEE_PCT, CARRY_PCT, HURDLE_PCT, CATCH_UP_PCT, INCEPTION, fund_id))
            print(f"  ✓ Mgmt fee: {float(MGMT_FEE_PCT)*100:.0f}%  "
                  f"Carry: {float(CARRY_PCT)*100:.0f}%  "
                  f"Hurdle: {float(HURDLE_PCT)*100:.0f}%  "
                  f"Inception: {INCEPTION}")

            # ── Get base CoA account IDs ──────────────────────────────────
            acct_1010 = get_account(cur, fund_id, "1010")   # Cash — Operating
            acct_1020 = get_account(cur, fund_id, "1020")   # Cash — Brokerage
            acct_1100 = get_account(cur, fund_id, "1100")   # Securities (parent)
            acct_3100 = get_account(cur, fund_id, "3100")   # LP Capital (control)
            acct_4100 = get_account(cur, fund_id, "4100")   # Realized Gain — LT

            # ─────────────────────────────────────────────────────────────
            # STEP 1 — LP records
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 1/7  LPs ──────────────────────────────────────────")
            lp_ids = {}
            for lp in LP_DATA:
                cur.execute(
                    "SELECT id FROM lps WHERE fund_id = %s AND legal_name = %s",
                    (fund_id, lp["legal_name"])
                )
                existing = cur.fetchone()
                if existing:
                    lp_ids[lp["code"]] = str(existing["id"])
                    print(f"  (exists)  {lp['legal_name']}")
                    continue
                lp_id = new_id()
                cur.execute("""
                    INSERT INTO lps
                        (id, fund_id, legal_name, entity_type, accred_type,
                         accred_verified_at, accred_evidence_path, status, onboarded_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'active',%s)
                """, (lp_id, fund_id, lp["legal_name"], lp["entity_type"],
                      lp["accred_type"], INCEPTION,
                      "test_data/accred_placeholder.pdf", INCEPTION))
                lp_ids[lp["code"]] = lp_id
                print(f"  ✓  {lp['legal_name']:<22}  ({lp_id[:8]}…)")

            # GP record (no capital commitment, no accred fields)
            cur.execute(
                "SELECT id FROM lps WHERE fund_id = %s AND legal_name = %s",
                (fund_id, GP_DATA["legal_name"])
            )
            if not cur.fetchone():
                gp_id = new_id()
                cur.execute("""
                    INSERT INTO lps
                        (id, fund_id, legal_name, entity_type, accred_type, status, onboarded_at)
                    VALUES (%s,%s,%s,%s,'professional','active',%s)
                """, (gp_id, fund_id, GP_DATA["legal_name"], GP_DATA["entity_type"], INCEPTION))
                print(f"  ✓  {GP_DATA['legal_name']:<22}  (GP)")
            else:
                print(f"  (exists)  {GP_DATA['legal_name']} (GP)")

            # ─────────────────────────────────────────────────────────────
            # STEP 2 — Per-LP capital accounts + commitments
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 2/7  Capital accounts + commitments ──────────────")
            lp_acct_ids = {}
            for lp in LP_DATA:
                code = f"3100-{lp['code']}"
                lp_acct_ids[lp["code"]] = ensure_account(
                    cur, fund_id, code,
                    f"Capital — {lp['legal_name']}",
                    "equity",
                    lp_id=lp_ids[lp["code"]],
                    parent_id=acct_3100,
                )
                cur.execute(
                    "SELECT id FROM commitments WHERE lp_id = %s AND fund_id = %s",
                    (lp_ids[lp["code"]], fund_id)
                )
                if not cur.fetchone():
                    cur.execute("""
                        INSERT INTO commitments
                            (lp_id, fund_id, commitment_amount, effective_date, notes)
                        VALUES (%s,%s,%s,%s,'Initial subscription — DGA Capital Fund I, LP')
                    """, (lp_ids[lp["code"]], fund_id, lp["commitment"], INCEPTION))
                print(f"  ✓  {lp['legal_name']:<22}  commitment ${lp['commitment']:>12,.2f}")

            # ─────────────────────────────────────────────────────────────
            # STEP 3 — Capital call #1
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 3/7  Capital call #1 ──────────────────────────────")
            call_id = new_id()
            cur.execute("""
                INSERT INTO capital_calls
                    (id, fund_id, call_number, notice_date, due_date,
                     total_amount, purpose, status)
                VALUES (%s,%s,1,%s,%s,%s,'investment','funded')
                ON CONFLICT (fund_id, call_number) DO NOTHING
            """, (call_id, fund_id, INCEPTION, INCEPTION, FUND_TOTAL))
            cur.execute(
                "SELECT id FROM capital_calls WHERE fund_id = %s AND call_number = 1",
                (fund_id,)
            )
            call_id = str(cur.fetchone()["id"])

            for lp in LP_DATA:
                cur.execute("""
                    INSERT INTO capital_call_allocations
                        (capital_call_id, lp_id, amount, received_at, receipt_amount)
                    VALUES (%s,%s,%s,NOW(),%s)
                    ON CONFLICT (capital_call_id, lp_id) DO NOTHING
                """, (call_id, lp_ids[lp["code"]], lp["commitment"], lp["commitment"]))
            print(f"  ✓  Call #{call_id[:8]}…  total ${FUND_TOTAL:,.2f}  status=funded")

            # ─────────────────────────────────────────────────────────────
            # STEP 4 — Contribution journal entries (one per LP)
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 4/7  Contributions ────────────────────────────────")
            cur.execute(
                "SELECT COUNT(*) AS n FROM transactions "
                "WHERE fund_id=%s AND category='contribution' AND source_id=%s",
                (fund_id, call_id)
            )
            if cur.fetchone()["n"] > 0:
                print("  (already posted — skipping)")
            else:
                for lp in LP_DATA:
                    post_txn(
                        cur, fund_id, INCEPTION, "contribution",
                        f"Capital Call #1 — {lp['legal_name']}",
                        [
                            {"acct": acct_1010,
                             "dr": lp["commitment"],
                             "lp_id": lp_ids[lp["code"]],
                             "desc": "Wire received"},
                            {"acct": lp_acct_ids[lp["code"]],
                             "cr": lp["commitment"],
                             "lp_id": lp_ids[lp["code"]],
                             "desc": "LP capital account"},
                        ],
                        source_kind="capital_call", source_id=call_id,
                    )
                    print(f"  ✓  {lp['legal_name']:<22}  "
                          f"dr 1010 / cr 3100-{lp['code']}  "
                          f"${lp['commitment']:>12,.2f}")

            # ─────────────────────────────────────────────────────────────
            # STEP 5 — Accumulated gains (9-year growth, simplified)
            # ─────────────────────────────────────────────────────────────
            # The fund grew from $2M (2017) to $3.69M (2026) via GSE preferred
            # stock income and capital appreciation. Posted as a single entry
            # for test purposes; a full implementation would have quarterly
            # income + unrealized gain entries for each period.
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 5/7  Accumulated gains (2017 → 2026) ─────────────")
            acct_3900 = get_account(cur, fund_id, "3900")  # Retained Earnings
            cur.execute(
                "SELECT COUNT(*) AS n FROM transactions "
                "WHERE fund_id=%s AND category='adjustment' AND description LIKE 'Accumulated%%'",
                (fund_id,)
            )
            if cur.fetchone()["n"] > 0:
                print("  (already posted — skipping)")
            else:
                # Split gains proportionally across LP capital accounts
                # Eugene 50%, Dennis 25%, Viktoria 25%
                total_committed = sum(lp["commitment"] for lp in LP_DATA)
                gain_lines = []
                gain_lines.append({
                    "acct": acct_1010,
                    "dr": ACCUMULATED_GAINS,
                    "desc": "Accumulated 9-year income + appreciation",
                })
                for lp in LP_DATA:
                    share = (lp["commitment"] / total_committed * ACCUMULATED_GAINS
                             ).quantize(Decimal("0.01"))
                    gain_lines.append({
                        "acct": lp_acct_ids[lp["code"]],
                        "cr": share,
                        "lp_id": lp_ids[lp["code"]],
                        "desc": f"Allocated gain — {lp['legal_name']}",
                    })
                # Fix rounding on last LP
                posted_cr = sum(ln["cr"] for ln in gain_lines if "cr" in ln)
                if posted_cr != ACCUMULATED_GAINS:
                    gain_lines[-1]["cr"] += ACCUMULATED_GAINS - posted_cr

                post_txn(
                    cur, fund_id, date(2025, 12, 31), "adjustment",
                    "Accumulated income + appreciation 2017–2025 (simplified test entry)",
                    gain_lines,
                )
                # Proportional breakdown for display
                for lp in LP_DATA:
                    share = lp["commitment"] / total_committed * ACCUMULATED_GAINS
                    print(f"  ✓  {lp['legal_name']:<22}  gain share  ${share:>12,.2f}")
                print(f"     {'─'*22}             {'─'*12}")
                print(f"     {'Total':<22}             ${ACCUMULATED_GAINS:>12,.2f}")

            # ─────────────────────────────────────────────────────────────
            # STEP 6 — Transfer Operating → Brokerage
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 6/7  Brokerage transfer ───────────────────────────")
            print(f"  Securities cost:     ${total_trade_cost:>14,.2f}")
            print(f"  Brokerage cash:      ${BROKERAGE_CASH:>14,.2f}")
            print(f"  Transfer total:      ${brokerage_total:>14,.2f}")
            print(f"  Operating cash rem:  ${operating_cash:>14,.2f}")

            cur.execute(
                "SELECT COUNT(*) AS n FROM transactions WHERE fund_id=%s AND category='transfer'",
                (fund_id,)
            )
            if cur.fetchone()["n"] > 0:
                print("  (already posted — skipping)")
            else:
                post_txn(
                    cur, fund_id, TRADE_DATE, "transfer",
                    "Operating → Brokerage: initial portfolio deployment",
                    [
                        {"acct": acct_1020, "dr": brokerage_total,
                         "desc": "Brokerage funding"},
                        {"acct": acct_1010, "cr": brokerage_total,
                         "desc": "From operating account"},
                    ],
                )
                print(f"  ✓  dr 1020 / cr 1010  ${brokerage_total:,.2f}")

            # ─────────────────────────────────────────────────────────────
            # STEP 7 — Securities + trade transactions + tax lots
            # ─────────────────────────────────────────────────────────────
            print("\n── Step 7/7  Securities + trades ──────────────────────────")
            cur.execute(
                "SELECT COUNT(*) AS n FROM transactions "
                "WHERE fund_id=%s AND category='trade_buy'",
                (fund_id,)
            )
            if cur.fetchone()["n"] > 0:
                print("  (already posted — skipping)")
            else:
                # Security master rows
                sec_ids = {}
                unique_symbols = list(dict.fromkeys(t[0] for t in TRADES))
                for symbol in unique_symbols:
                    issuer = (
                        "Federal National Mortgage Association"
                        if symbol.startswith("FNM")
                        else "Federal Home Loan Mortgage Corporation"
                    )
                    cur.execute("""
                        INSERT INTO securities
                            (id, symbol, name, asset_class, issuer, is_public)
                        VALUES (%s,%s,%s,'equity',%s,true)
                        ON CONFLICT (symbol) DO NOTHING
                    """, (new_id(), symbol,
                          SECURITY_NAMES.get(symbol, symbol), issuer))
                    cur.execute("SELECT id FROM securities WHERE symbol=%s", (symbol,))
                    sec_ids[symbol] = str(cur.fetchone()["id"])

                # Per-security sub-accounts (1100-{symbol})
                sec_acct_ids = {}
                for symbol in unique_symbols:
                    sec_acct_ids[symbol] = ensure_account(
                        cur, fund_id,
                        f"1100-{symbol}",
                        f"Securities at Cost — {symbol}",
                        "asset",
                        security_id=sec_ids[symbol],
                        parent_id=acct_1100,
                    )

                # Trade transactions + tax lots
                print(f"  {'Symbol':<7} {'Qty':>8}  {'Price':>7}  {'Cost':>14}")
                print(f"  {'─'*7} {'─'*8}  {'─'*7}  {'─'*14}")
                acq_ts = datetime(TRADE_DATE.year, TRADE_DATE.month, TRADE_DATE.day,
                                  tzinfo=timezone.utc)
                for symbol, qty, price in TRADES:
                    cost = Decimal(str(qty)) * price
                    txn_id = post_txn(
                        cur, fund_id, TRADE_DATE, "trade_buy",
                        f"Buy {qty:,} {symbol} @ ${price}",
                        [
                            {"acct": sec_acct_ids[symbol],
                             "dr": cost,
                             "sec_id": sec_ids[symbol],
                             "qty": Decimal(str(qty)),
                             "desc": f"Cost basis @ ${price}"},
                            {"acct": acct_1020,
                             "cr": cost,
                             "sec_id": sec_ids[symbol],
                             "qty": Decimal(str(qty)),
                             "desc": "Brokerage cash"},
                        ],
                    )
                    cur.execute("""
                        INSERT INTO tax_lots
                            (fund_id, security_id, acquired_at, quantity,
                             cost_basis_per_unit, open_transaction_id)
                        VALUES (%s,%s,%s,%s,%s,%s)
                    """, (fund_id, sec_ids[symbol], acq_ts,
                          Decimal(str(qty)), price, txn_id))
                    print(f"  {symbol:<7} {qty:>8,}  ${price:>6}  ${cost:>14,.2f}")

        # ── Commit ────────────────────────────────────────────────────────
        conn.commit()
        print("\n✓ All data committed.\n")

    except Exception as e:
        conn.rollback()
        print(f"\n✗ ERROR — rolled back.\n  {type(e).__name__}: {e}")
        raise

    # ── Trial balance ─────────────────────────────────────────────────────
    print("━━━ Trial Balance ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  {'Code':<15} {'Name':<36} {'Debit':>14} {'Credit':>14}")
    print(f"  {'─'*15} {'─'*36} {'─'*14} {'─'*14}")
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT code, name, type, total_debit, total_credit, balance
              FROM v_trial_balance
             WHERE fund_id = %s
               AND (total_debit <> 0 OR total_credit <> 0)
             ORDER BY code
        """, (fund_id,))
        rows = cur.fetchall()
        grand_dr = Decimal("0")
        grand_cr = Decimal("0")
        for r in rows:
            d = Decimal(str(r["total_debit"]))
            c = Decimal(str(r["total_credit"]))
            grand_dr += d
            grand_cr += c
            print(f"  {r['code']:<15} {r['name'][:36]:<36} {d:>14,.2f} {c:>14,.2f}")
        print(f"  {'─'*81}")
        print(f"  {'TOTAL':<53} {grand_dr:>14,.2f} {grand_cr:>14,.2f}")
        ok = abs(grand_dr - grand_cr) <= Decimal("0.01")
        print(f"\n  {'✓ Books balance' if ok else '✗ IMBALANCE — investigate!'}")
        print(f"  Current NAV: ${CURRENT_NAV:,.2f}  "
              f"(contributions ${FUND_TOTAL:,.2f} + gains ${ACCUMULATED_GAINS:,.2f})")
    conn.close()

if __name__ == "__main__":
    main()
