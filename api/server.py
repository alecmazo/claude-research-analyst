"""
FastAPI backend for the DGA Capital Research Analyst iPhone app.

Exposes the existing Python pipeline (SEC → Grok → Word/PPTX) via REST.

Start (from the project root — either works):
    python api/server.py
    python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import sys
import os
import json
import uuid
import shutil
import tempfile
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

import csv
import io
import time
import hashlib
import hmac

# ── yfinance (optional — for live price fetching) ─────────────────────────────
try:
    import yfinance as yf
    _YFINANCE_OK = True
except ImportError:
    _YFINANCE_OK = False

# ── openpyxl (optional — for XLSX cap-table uploads) ─────────────────────────
try:
    import openpyxl
    _OPENPYXL_OK = True
except ImportError:
    _OPENPYXL_OK = False

# ── Live-price cache  (TTL: 15 min) ──────────────────────────────────────────
_price_cache: dict = {}  # { symbol: (price, fetched_at) }
_PRICE_CACHE_TTL = 900   # seconds

def _fetch_prices(symbols: list) -> dict:
    """Return {symbol: last_price} for the given list, using a 15-min cache.
    Falls back to None for any symbol that can't be priced."""
    if not _YFINANCE_OK or not symbols:
        return {}
    now   = time.time()
    out   = {}
    fetch = []
    for sym in symbols:
        clean = sym.rstrip('*').rstrip('**')
        if clean in _price_cache:
            p, ts = _price_cache[clean]
            if now - ts < _PRICE_CACHE_TTL:
                out[sym] = p
                continue
        fetch.append((sym, clean))

    for sym, clean in fetch:
        # Fidelity money-market funds are always $1 NAV
        if 'SPAXX' in clean or 'FDRXX' in clean or 'SPRXX' in clean:
            _price_cache[clean] = (1.0, now)
            out[sym] = 1.0
            continue
        try:
            t = yf.Ticker(clean)
            p = t.fast_info.last_price
            price = float(p) if p and float(p) > 0 else None
        except Exception:
            price = None
        _price_cache[clean] = (price, now)
        out[sym] = price

    return out


def _fund_market_nav(cur, fid: str) -> float:
    """Return fund NAV = Σ(open_qty × live_price) across all tax_lots.

    Pricing priority:
      1. Live yfinance price (cached 15 min)
      2. Cost-basis fallback when no live price (prevents NAV from going to zero
         on data outages or unlisted securities)

    Money-market positions (asset_class='cash') are priced at $1.00/unit via
    the existing _fetch_prices() logic (SPAXX/FDRXX/SPRXX → 1.0).
    """
    cur.execute("""
        SELECT s.symbol, s.asset_class,
               SUM(tl.quantity)                                       AS total_qty,
               SUM(tl.quantity * tl.cost_basis_per_unit)              AS total_cost,
               SUM(tl.quantity * tl.cost_basis_per_unit)
                 / NULLIF(SUM(tl.quantity), 0)                        AS avg_cost
          FROM tax_lots tl
          JOIN securities s ON s.id = tl.security_id
         WHERE tl.fund_id = %s AND tl.closed_at IS NULL
         GROUP BY s.symbol, s.asset_class
    """, (fid,))
    rows = cur.fetchall()
    if not rows:
        return 0.0

    symbols = [r["symbol"] for r in rows if r["symbol"]]
    prices  = _fetch_prices(symbols)

    total = 0.0
    for r in rows:
        qty      = float(r["total_qty"] or 0)
        avg_cost = float(r["avg_cost"]  or 0)
        sym      = r["symbol"]
        price    = prices.get(sym)
        total   += qty * (price if price is not None else avg_cost)
    return round(total, 2)


# ── Embedded chart-of-accounts rows  (replaces reading the seed .sql file) ───
# Matches apps/fund/db/seed/0001_chart_of_accounts.sql exactly.
_FUND_COA = [
    # code,  name,                                    type
    ('1010', 'Cash — Operating Account',              'asset'),
    ('1020', 'Cash — Brokerage',                      'asset'),
    ('1030', 'Cash — Money Market',                   'asset'),
    ('1100', 'Securities at Cost',                    'asset'),
    ('1110', 'Mark-to-Market Adjustment',             'asset'),
    ('1200', 'Subscriptions Receivable',              'asset'),
    ('1210', 'Dividends Receivable',                  'asset'),
    ('1220', 'Interest Receivable',                   'asset'),
    ('1300', 'Prepaid Expenses',                      'asset'),
    ('2010', 'Trade Settlement Payable',              'liability'),
    ('2100', 'Accrued Management Fee',                'liability'),
    ('2110', 'Accrued Performance Fee (Carry)',       'liability'),
    ('2200', 'Distributions Payable',                 'liability'),
    ('2300', 'Accrued Expenses — Audit',              'liability'),
    ('2310', 'Accrued Expenses — Legal',              'liability'),
    ('2320', 'Accrued Expenses — Fund Admin',         'liability'),
    ('2330', 'Accrued Expenses — Other',              'liability'),
    ('3000', 'Capital — General Partner',             'equity'),
    ('3100', 'Capital — Limited Partners (control)',  'equity'),
    ('3900', 'Retained Earnings',                     'equity'),
    ('4100', 'Realized Gain — Long-Term',             'income'),
    ('4110', 'Realized Gain — Short-Term',            'income'),
    ('4200', 'Unrealized Gain (Mark-to-Market)',      'income'),
    ('4300', 'Dividend Income',                       'income'),
    ('4400', 'Interest Income',                       'income'),
    ('4900', 'Other Income',                          'income'),
    ('5100', 'Management Fee Expense',                'expense'),
    ('5200', 'Audit Fee',                             'expense'),
    ('5210', 'Legal Fees',                            'expense'),
    ('5220', 'Fund Administration Fees',              'expense'),
    ('5230', 'Custody Fees',                          'expense'),
    ('5240', 'Brokerage Commissions',                 'expense'),
    ('5300', 'Realized Loss — Long-Term',             'expense'),
    ('5310', 'Realized Loss — Short-Term',            'expense'),
    ('5400', 'Unrealized Loss (Mark-to-Market)',      'expense'),
    ('5900', 'Other Fund Expenses',                   'expense'),
    ('6100', 'Performance Allocation Expense',        'expense'),
    ('6200', 'Performance Allocation Reversal',       'contra'),
]


def _parse_fidelity_csv(content: str) -> list:
    """Parse a Fidelity Account Positions CSV export.
    Returns a list of position dicts ready for DB import."""
    positions = []
    lines = content.splitlines()
    # Fidelity CSVs have a header row but may have extra blank/disclaimer lines.
    # Find the real header row that contains 'Symbol'.
    header_idx = None
    for i, line in enumerate(lines):
        if 'Symbol' in line and 'Account' in line:
            header_idx = i
            break
    if header_idx is None:
        return []

    reader = csv.DictReader(io.StringIO('\n'.join(lines[header_idx:])))

    def parse_dollar(s: str):
        if not s:
            return None
        s = str(s).replace('$', '').replace(',', '').replace('+', '').strip()
        try:
            return float(s)
        except ValueError:
            return None

    for row in reader:
        sym = (row.get('Symbol') or '').strip()
        if not sym:
            continue
        desc = (row.get('Description') or '').strip()
        # Stop at Fidelity disclaimer lines
        if len(sym) > 12 or (desc and 'Brokerage services' in desc):
            break

        qty_str  = (row.get('Quantity') or '').strip()
        is_mm    = 'SPAXX' in sym or 'FDRXX' in sym or not qty_str

        if is_mm:
            val = parse_dollar(row.get('Current Value'))
            if val:
                positions.append({
                    'symbol':     sym.rstrip('*'),
                    'name':       desc or 'Money Market',
                    'quantity':   val,
                    'avg_cost':   1.0,
                    'cost_basis': val,
                    'last_price': 1.0,
                    'lot_type':   (row.get('Type') or 'Cash').strip(),
                    'is_cash':    True,
                })
            continue

        try:
            qty = float(qty_str.replace(',', ''))
        except ValueError:
            continue

        last_price      = parse_dollar(row.get('Last Price'))
        avg_cost        = parse_dollar(row.get('Average Cost Basis'))
        cost_basis_total= parse_dollar(row.get('Cost Basis Total'))
        if cost_basis_total is None and avg_cost and qty:
            cost_basis_total = avg_cost * qty

        positions.append({
            'symbol':     sym,
            'name':       desc,
            'quantity':   qty,
            'avg_cost':   avg_cost   or 0.0,
            'cost_basis': cost_basis_total or 0.0,
            'last_price': last_price,
            'lot_type':   (row.get('Type') or 'Cash').strip(),
            'is_cash':    False,
        })

    return positions


def _parse_captable(content: bytes, filename: str) -> tuple:
    """Parse a cap-table CSV or XLSX.

    Accepted column layouts (case-insensitive):

    Layout A — named commitment column:
        LP Name | Commitment Amount | Entity Type (opt) | Effective Date (opt)

    Layout B — year columns (waterfall / distribution schedule format):
        LP Name | <Entity Type (opt)> | 2022 | 2023 | 2024 | 2025 | …
        The LP's contribution is taken from the MOST RECENT (rightmost highest)
        year column that contains a non-zero value for that row.  If multiple
        year cells are filled the most-recent non-zero one wins; the "effective
        date" is set to Jan-1 of that year.

    Returns list of dicts:
        {legal_name, entity_type, commitment, effective_date, contribution_year}
    where `contribution_year` is None for Layout A.
    """
    out = []
    fname_lower = (filename or '').lower()

    if fname_lower.endswith('.xlsx') or fname_lower.endswith('.xls'):
        if not _OPENPYXL_OK:
            raise HTTPException(400, "openpyxl not installed — upload a CSV instead")
        wb  = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws  = wb.active
        raw = [[str(c.value if c.value is not None else '').strip() for c in row]
               for row in ws.iter_rows()]
    else:
        text = content.decode('utf-8', errors='replace')
        raw  = [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]

    if not raw:
        return [], {}, None

    import re as _re

    def _parse_money_inner(s):
        try:
            return float(str(s).replace('$', '').replace(',', '').strip())
        except (ValueError, TypeError):
            return None

    # ── Global scan: "Fund Established | year" (any row, any layout) ─────────
    fund_established_year = None
    for _row in raw:
        if len(_row) < 2:
            continue
        _lbl = str(_row[0]).lower().strip()
        if 'fund established' in _lbl or ('established' in _lbl and 'fund' in _lbl):
            try:
                _yr = int(float(str(_row[1]).replace(',', '').strip()))
                if 2000 <= _yr <= 2099:
                    fund_established_year = _yr
                    break
            except (ValueError, TypeError):
                pass

    # ── Layout C: transposed key-value (single LP, labels in col A, values in col B) ──
    # Detects files like:
    #   Row N:   "LP Name"              | "EM"
    #   Row N+1: "initial contribution" | "$1,400,000"
    #   Row N+2: "Economics"            | "0/25, 5% hurdle"
    #   Row N+3: "Fund Established"     | "2016"
    for i, row in enumerate(raw):
        if len(row) < 2:
            continue
        a = str(row[0]).lower().strip()
        b = str(row[1]).strip() if len(row) > 1 else ''
        if a not in ('lp name', 'legal name', 'investor name', 'investor'):
            continue
        # col B must be a real name, not a header keyword
        skip_kws = ('commitment', 'amount', 'date', 'type', 'entity', 'year', 'nav', 'name')
        if not b or any(kw in b.lower() for kw in skip_kws):
            continue
        # Confirm a contribution label appears within the next 10 rows
        contrib_found = False
        for j in range(i + 1, min(i + 10, len(raw))):
            nrow = raw[j]
            if not nrow or not str(nrow[0]).strip():
                continue
            nl = str(nrow[0]).lower().strip()
            if any(kw in nl for kw in ('contribution', 'committed', 'initial', 'capital commit')):
                contrib_found = True
                break
        if not contrib_found:
            continue

        # ── Parse Layout C ────────────────────────────────────────────────────
        # LP names: scan horizontally from col B onwards until an empty cell.
        # "LP Name | partner1 | partner2 | partner3"  → 3 LPs
        lp_names = []
        for ci in range(1, len(row)):
            nm = str(row[ci]).strip()
            if not nm:
                break       # stop at first empty cell
            lp_names.append(nm)

        # Per-LP contributions live in the NEXT KEY-VALUE row whose label
        # contains "contribution"/"committed"/"initial".  If values are in
        # matching columns they map 1:1; a single value applies to all LPs.
        eff_date   = str(datetime.utcnow().date())
        econ_str   = ''
        lp_amts    = {}   # col_index → amount
        for row2 in raw[i + 1:]:
            if not row2 or not str(row2[0]).strip():
                continue
            lbl = str(row2[0]).lower().strip()
            if any(kw in lbl for kw in ('contribution', 'committed', 'initial', 'capital commit')):
                # Collect amounts from each LP column (col 1…len(lp_names))
                for ci, _nm in enumerate(lp_names, 1):
                    raw_val = row2[ci] if ci < len(row2) else ''
                    v = _parse_money_inner(raw_val)
                    if v and v > 0:
                        lp_amts[ci] = v
                # If only one amount found and multiple LPs, apply to LP at col 1
                if not lp_amts:
                    # Try any cell in the row
                    for ci2 in range(1, len(row2)):
                        v = _parse_money_inner(row2[ci2])
                        if v and v > 0:
                            lp_amts[1] = v
                            break
            elif any(kw in lbl for kw in ('economics', 'econ', 'fee structure', 'terms')):
                econ_str = str(row2[1]).strip() if len(row2) > 1 else ''
            elif any(kw in lbl for kw in ('date', 'effective', 'inception')) and len(row2) > 1:
                raw_date = str(row2[1]).strip()
                if raw_date:
                    # Normalize bare year → YYYY-01-01
                    if _re.fullmatch(r'\d{4}', raw_date):
                        raw_date = raw_date + '-01-01'
                    eff_date = raw_date

        lp_rows_c = []
        for ci, nm in enumerate(lp_names, 1):
            amt = lp_amts.get(ci)
            if not amt or amt <= 0:
                continue
            lp_rows_c.append({
                'legal_name':        nm,
                'entity_type':       'individual',
                'commitment':        amt,
                'effective_date':    eff_date,
                'contribution_year': None,
            })

        # Parse economics string: "0/25, 5% hurdle" | "2 & 20, 8% hurdle" | "2/20"
        economics_c = {}
        if econ_str:
            m_slash = _re.match(r'(\d+(?:\.\d+)?)\s*[/&]\s*(\d+(?:\.\d+)?)', econ_str)
            if m_slash:
                economics_c['mgmt_fee_pct'] = round(float(m_slash.group(1)) / 100, 6)
                economics_c['carry_pct']    = round(float(m_slash.group(2)) / 100, 6)
            hm = _re.search(r'(\d+(?:\.\d+)?)\s*%\s*hurdle', econ_str, _re.IGNORECASE)
            if hm:
                economics_c['hurdle_pct'] = round(float(hm.group(1)) / 100, 6)

        return lp_rows_c, economics_c, fund_established_year

    # ── Find header row ───────────────────────────────────────────────────────
    header = []
    data_start = 0
    for i, row in enumerate(raw):
        joined = ' '.join(row).lower()
        if 'lp name' in joined or 'legal name' in joined or 'name' in joined:
            header = [h.lower().strip() for h in row]
            data_start = i + 1
            break

    if not header:
        raise HTTPException(400, "Could not find header row in cap table. "
            "Expected a column containing 'LP Name', 'Legal Name', or 'Name'.")

    # ── Detect year columns (4-digit int, 2000–2099) ─────────────────────────
    import re as _re
    year_cols = []   # list of (col_index, year_int) sorted ascending by year
    for idx, h in enumerate(header):
        m = _re.fullmatch(r'(20\d{2})', h.strip())
        if m:
            year_cols.append((idx, int(m.group(1))))
    year_cols.sort(key=lambda x: x[1])

    # ── Column helpers ────────────────────────────────────────────────────────
    def col_idx(header, *names):
        """Return index of first header that contains any of the given names."""
        for n in names:
            for i, h in enumerate(header):
                if n.lower() in h:
                    return i
        return None

    def col_val(row, *names):
        idx = col_idx(header, *names)
        return row[idx] if idx is not None and idx < len(row) else ''

    name_idx   = col_idx(header, 'lp name', 'legal name', 'name')
    commit_idx = col_idx(header, 'commitment', 'amount', 'capital')  # Layout A
    etype_idx  = col_idx(header, 'entity type', 'type')
    date_idx   = col_idx(header, 'effective date', 'date')

    valid_etypes = ('individual','joint','llc','trust','ira','corp',
                    'partnership','foundation','other')

    def _parse_money(s):
        try:
            return float(str(s).replace('$','').replace(',','').strip())
        except (ValueError, TypeError):
            return None

    for row in raw[data_start:]:
        if not any(row):
            continue
        if name_idx is None or name_idx >= len(row):
            continue
        name = row[name_idx].strip()
        if not name:
            continue

        etype_raw = (row[etype_idx].strip() if etype_idx is not None and etype_idx < len(row) else '')
        etype     = etype_raw.lower() if etype_raw.lower() in valid_etypes else 'individual'

        # ── Layout B: year columns ────────────────────────────────────────────
        if year_cols:
            # Walk year columns newest → oldest; take first non-zero value
            amt          = None
            contrib_year = None
            for col_i, yr in reversed(year_cols):
                v = _parse_money(row[col_i] if col_i < len(row) else '')
                if v and v > 0:
                    amt          = v
                    contrib_year = yr
                    break

            if amt is None:
                # If the row has only zeros in year cols, fall through to Layout A
                if commit_idx is not None and commit_idx < len(row):
                    amt = _parse_money(row[commit_idx])
                    contrib_year = None

            if not amt or amt <= 0:
                continue

            eff_date = f"{contrib_year}-01-01" if contrib_year else str(datetime.utcnow().date())
            if date_idx is not None and date_idx < len(row) and row[date_idx]:
                eff_date = row[date_idx].strip() or eff_date

            out.append({
                'legal_name':       name,
                'entity_type':      etype,
                'commitment':       amt,
                'effective_date':   eff_date,
                'contribution_year': contrib_year,
            })

        # ── Layout A: named commitment column ─────────────────────────────────
        else:
            if commit_idx is None:
                continue
            amt_str = row[commit_idx] if commit_idx < len(row) else ''
            amt = _parse_money(amt_str)
            if not amt or amt <= 0:
                continue

            eff_date = str(datetime.utcnow().date())
            if date_idx is not None and date_idx < len(row) and row[date_idx]:
                eff_date = row[date_idx].strip() or eff_date

            out.append({
                'legal_name':       name,
                'entity_type':      etype,
                'commitment':       amt,
                'effective_date':   eff_date,
                'contribution_year': None,
            })

    # ── Scan remaining rows for economics (col C = index 2) ──────────────────
    # After the last LP data row (data_start + len(out) ish) look for rows
    # where column A/B contains a fee/carry/hurdle label and column C contains
    # a percentage value.  Handles both "20%" and "0.20" formats.
    economics = {}

    def _parse_pct(s):
        """Return a fraction 0–1 from '20%' or '0.20' or '20', or None."""
        s = str(s or '').replace('%', '').replace('$', '').replace(',', '').strip()
        try:
            v = float(s)
        except (ValueError, TypeError):
            return None
        # If value looks like a whole-number percentage (e.g. 20 → 0.20), convert.
        # We treat values > 1 as already-in-percent form.
        return v / 100 if v > 1 else v

    econ_keywords = {
        'mgmt_fee_pct':  ('management fee', 'mgmt fee', 'management', 'mgmt', 'annual fee'),
        'carry_pct':     ('carry', 'carried interest', 'performance fee', 'incentive fee',
                          'performance allocation'),
        'hurdle_pct':    ('hurdle', 'preferred return', 'pref return', 'preferred',
                          'hurdle rate', 'pref'),
    }

    # scan ALL rows — look for any row where col C looks like a pct
    # and the label (col A or B) matches a known keyword
    for row in raw[data_start:]:
        if len(row) < 3:
            continue
        label_text = ' '.join(str(c).lower() for c in row[:3] if c)
        col_c_val  = row[2].strip() if len(row) > 2 else ''

        pct = _parse_pct(col_c_val)
        if pct is None or pct <= 0 or pct >= 1:
            continue  # only accept 0 < pct < 1

        for key, kws in econ_keywords.items():
            if key not in economics:  # first match wins
                if any(kw in label_text for kw in kws):
                    economics[key] = round(pct, 6)
                    break

    return out, economics, fund_established_year

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Make the project root importable when running from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import claude_analyst as analyst

app = FastAPI(title="DGA Research Analyst API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Auth — stateless HMAC token (survives restarts, no DB needed)
# ---------------------------------------------------------------------------
_PUBLIC_PATHS = {"/health", "/info", "/api/auth", "/api/build", "/api/diagnostics", "/"}

def _portfolio_password() -> str:
    return os.environ.get("PORTFOLIO_PASSWORD", "dgacapital").strip()

def _token_secret() -> str:
    return os.environ.get("TOKEN_SECRET", "dga-capital-jwt-secret").strip()

def _make_token(password: str) -> str:
    """Derive a deterministic token from password + secret (HMAC-SHA256)."""
    return hmac.new(  # type: ignore[attr-defined]
        _token_secret().encode(), password.encode(), hashlib.sha256
    ).hexdigest()

def _valid_token(token: str) -> bool:
    expected = _make_token(_portfolio_password())
    return hmac.compare_digest(token.strip(), expected)

# Fund-specific auth — second layer on top of main auth.
# FUND_PASSWORD defaults to "dgacapital"; set env var to change it independently.
def _fund_password() -> str:
    return os.environ.get("FUND_PASSWORD", "genesis").strip()

def _make_fund_token() -> str:
    """Deterministic fund token: HMAC of 'fund:<password>' with shared secret."""
    return hmac.new(
        _token_secret().encode(), f"fund:{_fund_password()}".encode(), hashlib.sha256
    ).hexdigest()

def _valid_fund_token(token: str) -> bool:
    return hmac.compare_digest(token.strip(), _make_fund_token())

def _require_fund_token(request: Request) -> None:
    """Raise 403 if x-fund-token header (or fund_token query param) is missing/invalid."""
    token = (request.headers.get("x-fund-token")
             or request.query_params.get("fund_token")
             or "")
    if not _valid_fund_token(token):
        raise HTTPException(status_code=403, detail="Fund access requires fund authentication")

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    # Always allow: public API paths, static assets, the web app shell
    if (path in _PUBLIC_PATHS
            or path.startswith("/app/")
            or path.startswith("/branding/")
            or not path.startswith("/api/")):
        return await call_next(request)
    # Check token from header or query string
    token = (request.headers.get("x-auth-token")
             or request.query_params.get("token")
             or "")
    if not _valid_token(token):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)

# In-memory job store: { job_id: { status, ticker, result, error, created_at } }
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Persistent job-index — survives server restarts on Railway.
# Maps { job_id: { "ticker": str, "type": "analysis"|"portfolio" } }
# Stored next to the stocks folder so it lives on the same volume.
# ---------------------------------------------------------------------------
_JOB_INDEX_PATH = analyst.STOCKS_FOLDER / "_job_index.json"

def _load_job_index() -> dict:
    try:
        if _JOB_INDEX_PATH.exists():
            return json.loads(_JOB_INDEX_PATH.read_text())
    except Exception:
        pass
    return {}

def _save_job_index_entry(job_id: str, entry: dict) -> None:
    """Append / update one entry in the on-disk job index (best-effort)."""
    try:
        idx = _load_job_index()
        idx[job_id] = entry
        _JOB_INDEX_PATH.write_text(json.dumps(idx, indent=2))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class FundAuthRequest(BaseModel):
    password: str

class CreateFundRequest(BaseModel):
    name:           str                 # 'DGA Capital Fund II, LP'
    short_name:     str                 # 'DGA-II'
    inception_date: str                 # 'YYYY-MM-DD'
    fiscal_year_end: str | None = None  # defaults to Dec 31 of inception year
    mgmt_fee_pct:   float = 0.02
    carry_pct:      float = 0.25
    hurdle_pct:     float = 0.08

class AnalyzeRequest(BaseModel):
    ticker: str
    generate_gamma: bool = False


class JobStatus(BaseModel):
    job_id: str
    ticker: str
    status: str           # queued | running | done | failed
    created_at: str
    error: str | None = None
    result: dict | None = None
    # Live progress emitted by analyze_ticker — populated on /status polls
    # while status='running'. Frontend uses this to drive a real progress bar
    # instead of simulated step transitions.
    progress: dict | None = None


class PortfolioJobStatus(BaseModel):
    job_id: str
    status: str           # queued | running | done | failed
    created_at: str
    strategy: str
    n_tickers: int
    error: str | None = None
    result: dict | None = None
    # Live progress emitted by run_portfolio_rebalance — populated on
    # /portfolio/{id} polls while status='running'. Frontend renders a
    # per-ticker counter ("3 / 12 — analyzing AAPL") and progress bar.
    progress: dict | None = None


class IntelligenceRequest(BaseModel):
    sector: str = "Tech"  # sector focus: Tech, Energy, Healthcare, Financials, Consumer, Industrials, Materials, Real Estate, Best Mix


# ---------------------------------------------------------------------------
# Auth route
# ---------------------------------------------------------------------------

class AuthRequest(BaseModel):
    password: str

@app.post("/api/auth")
def auth(req: AuthRequest):
    if hmac.compare_digest(req.password.strip(), _portfolio_password()):
        return {"token": _make_token(req.password.strip())}
    raise HTTPException(status_code=401, detail="Invalid password")

# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

def _run_analysis(job_id: str, ticker: str, generate_gamma: bool) -> None:
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"
        _jobs[job_id]["progress"] = {"step": "queued", "pct": 0.0, "label": "Starting…"}

    # Progress callback — runs on the worker thread, mutates the shared job dict.
    # Wrapped so a slow lock acquisition can't slow down the analysis itself.
    def _record_progress(step: str, pct: float, label: str) -> None:
        with _jobs_lock:
            if job_id in _jobs:
                _jobs[job_id]["progress"] = {
                    "step": step, "pct": pct, "label": label,
                }

    try:
        system_prompt = analyst.load_system_prompt()
        result = analyst.analyze_ticker(
            ticker,
            system_prompt=system_prompt,
            generate_gamma=generate_gamma,
            verbose=False,
            on_progress=_record_progress,
        )
        with _jobs_lock:
            if result.get("ok"):
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["progress"] = {"step": "done", "pct": 1.0, "label": "Report ready"}
                # Trim the report text to avoid sending multi-MB payloads in the
                # status response; the full text is available via /report/{ticker}.
                _jobs[job_id]["result"] = {k: v for k, v in result.items()
                                           if k != "report_text"}
                _jobs[job_id]["result"]["has_report"] = bool(result.get("report_text"))
            else:
                _jobs[job_id]["status"] = "failed"
                _jobs[job_id]["error"] = result.get("error", "Unknown error")
    except BaseException as exc:  # noqa: BLE001  # catches SystemExit from any library
        # Log FULL traceback so we can see where the error actually happened.
        tb_str = traceback.format_exc()
        print(f"\n❌ Single-ticker job {job_id} ({ticker}) CRASHED:\n{tb_str}", flush=True)
        with _jobs_lock:
            _jobs[job_id]["status"] = "failed"
            # Include last line of traceback in error so the UI shows something
            # more useful than just the message.
            tb_tail = tb_str.strip().splitlines()[-3:] if tb_str else []
            _jobs[job_id]["error"] = f"{exc} | {' | '.join(tb_tail)}"


# In-memory portfolio job store.
_pjobs: dict[str, dict[str, Any]] = {}
_pjobs_lock = threading.Lock()

# In-memory scan job store.
_sjobs: dict[str, dict[str, Any]] = {}
_sjobs_lock = threading.Lock()

# In-memory intelligence job store.
_ijobs: dict[str, dict[str, Any]] = {}
_ijobs_lock = threading.Lock()

# In-memory daily-brief job store (Goldman-style PM morning notes).
_bjobs: dict[str, dict[str, Any]] = {}
_bjobs_lock = threading.Lock()


def _run_portfolio(
    job_id: str,
    portfolio_records: list[dict],
    strategy: str,
    generate_gamma: bool,
    reuse_existing: bool,
    xlsx_out_path: str,
) -> None:
    with _pjobs_lock:
        _pjobs[job_id]["status"] = "running"
        _pjobs[job_id]["progress"] = {
            "step": "queued", "pct": 0.0,
            "label": "Starting portfolio run…",
            "ticker_index": 0, "ticker_total": 0,
            "current_ticker": None,
            "ok": [], "failed": [],
        }

    # Progress callback — runs on the worker thread, mutates the shared
    # job dict. The portfolio pipeline emits per-ticker progress so the
    # frontend can render a "3 / 12 — analyzing AAPL" counter.
    def _record_progress(step: str, pct: float, label: str, extra: dict) -> None:
        with _pjobs_lock:
            if job_id in _pjobs:
                _pjobs[job_id]["progress"] = {
                    "step": step,
                    "pct": pct,
                    "label": label,
                    "ticker_index": extra.get("ticker_index", 0),
                    "ticker_total": extra.get("ticker_total", 0),
                    "current_ticker": extra.get("ticker"),
                    "ok": list(extra.get("ok", []) or []),
                    "failed": list(extra.get("failed", []) or []),
                }

    try:
        result = analyst.run_portfolio_rebalance(
            portfolio_records=portfolio_records,
            primary_strategy=strategy,
            generate_gamma=generate_gamma,
            reuse_existing=reuse_existing,
            output_path=xlsx_out_path,
            on_progress=_record_progress,
        )
        with _pjobs_lock:
            _pjobs[job_id]["status"] = "done" if result.get("ok") else "failed"
            _pjobs[job_id]["result"] = result
            if not result.get("ok"):
                _pjobs[job_id]["error"] = "No tickers could be analyzed."
            # Mark progress as done so the UI doesn't keep showing "Analyzing X"
            # after the result lands.
            _pjobs[job_id]["progress"] = {
                **(_pjobs[job_id].get("progress") or {}),
                "step": "done" if result.get("ok") else "failed",
                "pct": 1.0,
                "label": (f"Done — {len(result.get('tickers_ok') or [])} ok, "
                          f"{len(result.get('tickers_failed') or [])} failed")
                          if result.get("ok") else "Failed",
            }
        # Auto-promote the input holdings as the new "live portfolio" benchmark
        # so the Paper Tracker can compare idea baskets against your real book.
        if result.get("ok"):
            try:
                analyst.promote_live_portfolio(portfolio_records)
            except Exception as exc:  # noqa: BLE001
                print(f"⚠️  Live-portfolio promotion failed: {exc}")
    except BaseException as exc:  # noqa: BLE001  # catches SystemExit from any library
        with _pjobs_lock:
            _pjobs[job_id]["status"] = "failed"
            _pjobs[job_id]["error"] = str(exc)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
BRANDING_DIR = Path(__file__).resolve().parent.parent / "branding"


@app.get("/")
def root():
    """Redirect to the web UI."""
    return RedirectResponse(url="/app/")


@app.get("/info")
def info():
    return {"service": "DGA Research Analyst API", "status": "ok"}


# ── Build/version endpoint ────────────────────────────────────────────────────
# The web client polls this to detect deploys and force a hard reload of
# stale iOS PWA / Safari caches. Bumped on every UI deploy.
WEB_BUILD_VERSION = "ui25-20260506"


@app.get("/api/build")
def build_version():
    """Return the current web UI build identifier.

    The web client compares this to its embedded BUILD constant; on mismatch
    it forces a `location.reload(true)` with a cache-bust query param so even
    home-screen PWAs see the latest UI without manual cache clearing.
    """
    return {"build": WEB_BUILD_VERSION}


@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/diagnostics")
def diagnostics():
    """Return non-secret config info so we can verify env vars are set
    without exposing the actual values.  Used to debug Gamma / Dropbox /
    Drive integrations on Railway."""
    def _is_set(name: str) -> bool:
        return bool((os.environ.get(name, "") or "").strip())
    return {
        "gamma_api_key_set":     _is_set("GAMMA_API_KEY"),
        "gamma_folder_id_set":   _is_set("GAMMA_FOLDER_ID"),
        "dropbox_configured":    all(_is_set(k) for k in ("DROPBOX_APP_KEY","DROPBOX_APP_SECRET","DROPBOX_REFRESH_TOKEN")),
        "google_drive_set":      _is_set("GOOGLE_SERVICE_ACCOUNT_JSON") or Path(__file__).resolve().parent.parent.joinpath("dga-service-account.json").exists(),
        "xai_api_key_set":       _is_set("XAI_API_KEY"),
        "build":                 WEB_BUILD_VERSION,
        "stocks_folder":         str(analyst.STOCKS_FOLDER),
        "stocks_pptx_count":     len(list(analyst.STOCKS_FOLDER.glob("*_DGA_Presentation.pptx"))),
        "stocks_docx_count":     len(list(analyst.STOCKS_FOLDER.glob("*_DGA_Report.docx"))),
        "stocks_md_count":       len(list(analyst.STOCKS_FOLDER.glob("*_DGA_Report.md"))),
        "gamma_index_entries":   len(analyst._load_gamma_index()),
    }


@app.post("/api/analyze", response_model=JobStatus)
def start_analysis(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """Kick off an async analysis for *ticker*. Returns a job_id to poll."""
    ticker = req.ticker.strip().upper()
    if not ticker or not ticker.isalpha() or len(ticker) > 10:
        raise HTTPException(status_code=422, detail="Invalid ticker symbol")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "ticker": ticker,
            "status": "queued",
            "created_at": now,
            "error": None,
            "result": None,
            # Progress reported by the analysis pipeline. {step, pct, label}.
            # `step` is one of: queued | sec_filings | financials | market_data
            #                 | grok | rendering | gamma | upload | done
            "progress": {"step": "queued", "pct": 0.0, "label": "Queued — starting shortly…"},
        }

    # Persist mapping so we can recover after a server restart.
    _save_job_index_entry(job_id, {"ticker": ticker, "type": "analysis", "created_at": now})

    background_tasks.add_task(_run_analysis, job_id, ticker, req.generate_gamma)
    return _jobs[job_id]


@app.get("/api/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    """Poll for the status of a previously submitted job.

    If the job is not in memory (server restarted), we fall back to the
    on-disk job-index: if the report file already exists we return a
    synthetic "done" response so the mobile app can navigate to the report.
    If neither the in-memory job nor the report file exists we return 404.
    """
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job:
        return job

    # --- Recovery path after server restart ---
    idx = _load_job_index()
    entry = idx.get(job_id)
    if entry and entry.get("type") == "analysis":
        ticker = entry.get("ticker", "").upper()
        md_path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
        if md_path.exists():
            # Report was completed before the restart — synthesize a done response.
            has_docx = (analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.docx").exists()
            has_pptx = (analyst.STOCKS_FOLDER / f"{ticker}_DGA_Presentation.pptx").exists()
            recovered = {
                "job_id": job_id,
                "ticker": ticker,
                "status": "done",
                "created_at": entry.get("created_at", ""),
                "error": None,
                "result": {
                    "ok": True,
                    "has_report": True,
                    "has_docx": has_docx,
                    "has_pptx": has_pptx,
                    "gamma_url": None,
                    "gamma_error": None,
                    "recovered": True,   # flag so client knows it was recovered
                },
            }
            # Re-hydrate in memory so subsequent polls are fast.
            with _jobs_lock:
                _jobs[job_id] = recovered
            return recovered
        else:
            # Index entry exists but the report never finished — the job was lost.
            raise HTTPException(
                status_code=404,
                detail=f"Job was lost in a server restart before completing. Please re-run the analysis for {ticker}.",
            )

    raise HTTPException(status_code=404, detail="Job not found")


@app.get("/api/jobs")
def list_jobs():
    """Return all jobs (newest first), without full result payloads."""
    with _jobs_lock:
        jobs = list(_jobs.values())
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return [
        {k: v for k, v in j.items() if k != "result"}
        for j in jobs
    ]


@app.get("/api/report/{ticker}")
def get_report(ticker: str):
    """Return the full markdown report text for the most-recently-analyzed ticker."""
    ticker = ticker.strip().upper()
    md_path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
    if not md_path.exists():
        raise HTTPException(status_code=404, detail=f"No report found for {ticker}")
    folder = analyst.STOCKS_FOLDER
    has_docx = (folder / f"{ticker}_DGA_Report.docx").exists()
    has_pptx = (folder / f"{ticker}_DGA_Presentation.pptx").exists()
    # Look up Gamma URL from the on-disk index so the mobile UI can show
    # the "View Gamma" button even days/weeks after the original run.
    gamma_url = None
    gamma_generated_at = None
    try:
        idx = analyst._load_gamma_index()
        entry = idx.get(ticker)
        if entry:
            gamma_url = entry.get("gamma_url")
            gamma_generated_at = entry.get("generated_at")
    except Exception:
        pass
    return {
        "ticker": ticker,
        "report_md": md_path.read_text(),
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
        "has_docx": has_docx,
        "has_pptx": has_pptx,
        "gamma_url": gamma_url,
        "gamma_generated_at": gamma_generated_at,
    }


@app.get("/api/download/{ticker}/docx")
def download_docx(ticker: str):
    """Download the Word report for *ticker*."""
    ticker = ticker.strip().upper()
    path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.docx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Word report not found")
    return FileResponse(
        path=str(path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=path.name,
    )


@app.get("/api/download/{ticker}/pptx")
def download_pptx(ticker: str):
    """Download the PowerPoint presentation for *ticker*."""
    ticker = ticker.strip().upper()
    path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Presentation.pptx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Presentation not found")
    return FileResponse(
        path=str(path),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=path.name,
    )


@app.get("/api/quote/{ticker}")
def get_quote(ticker: str):
    """Return live market price for *ticker* from Yahoo Finance."""
    ticker = ticker.strip().upper()
    snapshot = analyst.fetch_market_snapshot(ticker)
    return {"ticker": ticker, **snapshot}


@app.delete("/api/cache")
def clear_local_cache():
    """Delete all locally-cached _DGA_Report.md files from /stocks.

    Dropbox / Drive files are NOT touched — only this server instance's
    local copy is cleared. After the user deletes files from Dropbox,
    calling this endpoint ensures the Research tab reflects the true state
    instead of showing stale reports that were hydrated at startup.
    """
    cleared: list[str] = []
    for md in analyst.STOCKS_FOLDER.glob("*_DGA_Report.md"):
        try:
            md.unlink()
            cleared.append(md.name.replace("_DGA_Report.md", ""))
        except OSError:
            pass
    return {"cleared": cleared, "count": len(cleared)}


@app.delete("/api/report/{ticker}")
def delete_report(ticker: str):
    """Delete the locally-cached report files for a single ticker.

    Removes the .md, .docx, and .pptx files from /stocks for *ticker*.
    Dropbox / Drive copies are NOT touched — only this server instance's
    local cache is cleared. The next portfolio or analysis run will
    re-hydrate or regenerate as needed.
    """
    ticker = ticker.strip().upper()
    folder = analyst.STOCKS_FOLDER
    targets = [
        folder / f"{ticker}_DGA_Report.md",
        folder / f"{ticker}_DGA_Report.docx",
        folder / f"{ticker}_DGA_Presentation.pptx",
    ]
    cleared: list[str] = []
    for path in targets:
        if path.exists():
            try:
                path.unlink()
                cleared.append(path.name)
            except OSError:
                pass
    if not cleared:
        raise HTTPException(status_code=404, detail=f"No cached files found for {ticker}")
    return {"ticker": ticker, "cleared": cleared, "count": len(cleared)}


# In-memory summary cache, keyed by md_file.stat().st_mtime_ns. Avoids
# re-parsing the same markdown on every /api/reports call. Capped implicitly
# by the number of tickers a user has cached locally.
_summary_cache: dict[str, dict] = {}


def _extract_summary_cached(md_file: Path) -> dict:
    """Return {rating, price_target, upside_pct} for a saved report.

    Parsing happens once per (ticker, mtime) pair — re-running an analysis
    bumps mtime which invalidates the cache. We only read the first 12KB
    of the file because every field extract_summary_from_report cares about
    is in the report header / summary table.
    """
    try:
        key = f"{md_file.name}:{md_file.stat().st_mtime_ns}"
    except OSError:
        return {}
    cached = _summary_cache.get(key)
    if cached is not None:
        return cached
    try:
        with open(md_file, "rb") as fh:
            head = fh.read(12 * 1024).decode("utf-8", errors="replace")
        full = analyst.extract_summary_from_report(head)
    except Exception:  # noqa: BLE001
        full = {}
    summary = {
        "rating":        full.get("rating"),
        "price_target":  full.get("price_target"),
        "current_price": full.get("current_price"),
        "upside_pct":    full.get("upside_pct"),
    }
    _summary_cache[key] = summary
    return summary


@app.get("/api/reports")
def list_reports():
    """Return all tickers that have saved reports.

    Each entry now includes an extracted summary (`rating`, `price_target`,
    `upside_pct`) so the Research tab can show a target-vs-price chip in
    the saved-reports list without an extra API round-trip per row.
    """
    folder = analyst.STOCKS_FOLDER
    try:
        gamma_idx = analyst._load_gamma_index()
    except Exception:
        gamma_idx = {}
    reports = []
    for md_file in sorted(folder.glob("*_DGA_Report.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        ticker = md_file.name.replace("_DGA_Report.md", "")
        has_docx = (folder / f"{ticker}_DGA_Report.docx").exists()
        has_pptx = (folder / f"{ticker}_DGA_Presentation.pptx").exists()
        gamma_entry = gamma_idx.get(ticker) or {}
        summary = _extract_summary_cached(md_file)
        reports.append({
            "ticker": ticker,
            "generated_at": datetime.utcfromtimestamp(md_file.stat().st_mtime).isoformat(),
            "has_docx": has_docx,
            "has_pptx": has_pptx,
            "gamma_url": gamma_entry.get("gamma_url"),
            # Extracted summary fields (may be None for older reports without
            # the standard header).
            "rating":        summary.get("rating"),
            "price_target":  summary.get("price_target"),
            "current_price": summary.get("current_price"),
            "upside_pct":    summary.get("upside_pct"),
        })
    return reports


# ---------------------------------------------------------------------------
# Portfolio endpoints
# ---------------------------------------------------------------------------
PORTFOLIO_OUT_DIR = Path(__file__).resolve().parent.parent / "portfolio_runs"
PORTFOLIO_OUT_DIR.mkdir(exist_ok=True)


@app.get("/api/strategies")
def list_strategies():
    """Return the three rebalance strategies with metadata for the GUI."""
    return [
        {
            "key": k,
            "label": cfg["label"],
            "description": cfg["description"],
            "min_names": cfg["min_names"],
            "max_names": cfg["max_names"],
            "max_position": cfg["max_position"],
            "max_sector": cfg["max_sector"],
        }
        for k, cfg in analyst.STRATEGIES.items()
    ]


@app.post("/api/portfolio", response_model=PortfolioJobStatus)
async def start_portfolio(
    background_tasks: BackgroundTasks,
    strategy: str = Form("current"),
    generate_gamma: bool = Form(False),
    reuse_existing: bool = Form(True),
    file: UploadFile = File(...),
):
    """Upload a portfolio CSV/XLSX and kick off a rebalance run.

    Accepts multipart/form-data. Returns a job_id to poll.
    """
    if strategy not in analyst.STRATEGIES:
        raise HTTPException(status_code=422, detail=f"Unknown strategy: {strategy}")

    # Persist the upload to a temp file (loader reads from disk).
    suffix = Path(file.filename or "portfolio.xlsx").suffix.lower() or ".xlsx"
    if suffix not in (".csv", ".xlsx", ".xls"):
        raise HTTPException(status_code=422, detail="File must be .csv or .xlsx")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.close()
        try:
            records = analyst.load_portfolio_file(tmp.name)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not parse portfolio: {exc}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if not records:
        raise HTTPException(status_code=422, detail="Portfolio file has no rows")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    date_str = datetime.utcnow().strftime("%Y%m%d")
    xlsx_out = PORTFOLIO_OUT_DIR / f"Rebalance{date_str}.xlsx"

    with _pjobs_lock:
        _pjobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "strategy": strategy,
            "n_tickers": len(records),
            "error": None,
            "result": None,
            # Seeded so a poll right after submit gets a useful payload
            # rather than null. Real values arrive once the worker thread
            # starts firing on_progress.
            "progress": {
                "step": "queued", "pct": 0.0,
                "label": "Queued — analyzing tickers shortly…",
                "ticker_index": 0, "ticker_total": len(records),
                "current_ticker": None, "ok": [], "failed": [],
            },
        }

    # Persist so we can recover the xlsx path after a server restart.
    _save_job_index_entry(job_id, {
        "type": "portfolio",
        "xlsx_path": str(xlsx_out),
        "created_at": now,
    })

    background_tasks.add_task(
        _run_portfolio,
        job_id,
        records,
        strategy,
        generate_gamma,
        reuse_existing,
        str(xlsx_out),
    )
    return _pjobs[job_id]


# ---------------------------------------------------------------------------
# Watchlist endpoints
# ---------------------------------------------------------------------------

class WatchlistUpdate(BaseModel):
    tickers: list[str]


@app.get("/api/watchlist")
def get_watchlist():
    """Return the current watchlist."""
    return {"tickers": analyst.load_watchlist()}


@app.put("/api/watchlist")
def set_watchlist(body: WatchlistUpdate):
    """Replace the entire watchlist."""
    clean = [t.strip().upper() for t in body.tickers if t.strip()]
    analyst.save_watchlist(clean)
    return {"tickers": analyst.load_watchlist()}


@app.post("/api/watchlist/{ticker}")
def add_watchlist_ticker(ticker: str):
    """Add a single ticker to the watchlist."""
    t = ticker.strip().upper()
    if not t or not t.replace(".", "").isalnum() or len(t) > 10:
        raise HTTPException(status_code=422, detail="Invalid ticker")
    tickers = analyst.add_to_watchlist(t)
    return {"tickers": tickers}


@app.delete("/api/watchlist/{ticker}")
def remove_watchlist_ticker(ticker: str):
    """Remove a single ticker from the watchlist."""
    tickers = analyst.remove_from_watchlist(ticker.strip().upper())
    return {"tickers": tickers}


# ---------------------------------------------------------------------------
# Scan job worker
# ---------------------------------------------------------------------------

def _run_scan(job_id: str, tickers: list[str]) -> None:
    with _sjobs_lock:
        _sjobs[job_id]["status"] = "running"

    completed: dict[str, Any] = {}

    def on_progress(ticker: str, result: dict) -> None:
        with _sjobs_lock:
            _sjobs[job_id]["results"][ticker] = result
            _sjobs[job_id]["tickers_done"] = list(_sjobs[job_id]["results"].keys())

    try:
        final = analyst.run_portfolio_scan(tickers, on_progress=on_progress, verbose=True)
        with _sjobs_lock:
            _sjobs[job_id]["status"] = "done"
            _sjobs[job_id]["results"] = final["results"]
            _sjobs[job_id]["scanned_at"] = final["scanned_at"]
            _sjobs[job_id]["tickers_done"] = list(final["results"].keys())
    except BaseException as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(f"\n❌ Scan job {job_id} CRASHED:\n{tb}", flush=True)
        with _sjobs_lock:
            _sjobs[job_id]["status"] = "failed"
            _sjobs[job_id]["error"] = str(exc)


# ---------------------------------------------------------------------------
# Scan endpoints
# ---------------------------------------------------------------------------

@app.post("/api/scan")
def start_scan(background_tasks: BackgroundTasks):
    """Kick off a live-search news scan for all watchlist tickers."""
    tickers = analyst.load_watchlist()
    if not tickers:
        raise HTTPException(status_code=422, detail="Watchlist is empty — add tickers first")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _sjobs_lock:
        _sjobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "tickers": tickers,
            "tickers_done": [],
            "results": {},
            "scanned_at": None,
            "error": None,
        }
    background_tasks.add_task(_run_scan, job_id, tickers)
    return _sjobs[job_id]


@app.get("/api/scan/latest")
def get_latest_scan():
    """Return the most-recently-completed scan (persisted to disk)."""
    path = analyst.SCAN_RESULTS_FILE
    if not path.exists():
        return {"exists": False}
    try:
        data = json.loads(path.read_text())
        data["exists"] = True
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read scan results: {exc}")


@app.get("/api/scan/{job_id}")
def get_scan_status(job_id: str):
    """Poll a running or completed scan job."""
    with _sjobs_lock:
        job = _sjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Scan job not found")
    return job


# ---------------------------------------------------------------------------
# Intelligence — macro → sector → company idea generation
# ---------------------------------------------------------------------------

def _run_intelligence(job_id: str, sector: str) -> None:
    with _ijobs_lock:
        _ijobs[job_id]["status"] = "running"
    try:
        result = analyst.run_market_intelligence(sector)
        with _ijobs_lock:
            _ijobs[job_id]["status"] = "done" if result.get("ok") else "failed"
            _ijobs[job_id]["result"] = result
            if not result.get("ok"):
                _ijobs[job_id]["error"] = result.get("error", "Unknown error")
    except BaseException as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(f"\n❌ Intelligence job {job_id} CRASHED:\n{tb}", flush=True)
        with _ijobs_lock:
            _ijobs[job_id]["status"] = "failed"
            _ijobs[job_id]["error"] = str(exc)


@app.post("/api/intelligence")
def start_intelligence(req: IntelligenceRequest, background_tasks: BackgroundTasks):
    """Start a market intelligence run for the given sector focus."""
    sector = (req.sector or "Tech").strip()
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _ijobs_lock:
        _ijobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "sector": sector,
            "result": None,
            "error": None,
        }
    background_tasks.add_task(_run_intelligence, job_id, sector)
    return _ijobs[job_id]


@app.get("/api/intelligence/latest")
def get_latest_intelligence():
    """Return the most-recently-completed intelligence run (persisted to disk)."""
    path = analyst.INTEL_FILE
    if not path.exists():
        return {"exists": False}
    try:
        data = json.loads(path.read_text())
        data["exists"] = True
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read intelligence: {exc}")


@app.get("/api/intelligence/{job_id}")
def get_intelligence_status(job_id: str):
    """Poll a running or completed intelligence job."""
    with _ijobs_lock:
        job = _ijobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Intelligence job not found")
    return job


# ---------------------------------------------------------------------------
# Daily Brief — Goldman-style PM morning note (Grok 4.x w/ live X + web)
# ---------------------------------------------------------------------------

def _run_daily_brief(job_id: str) -> None:
    with _bjobs_lock:
        _bjobs[job_id]["status"] = "running"
    try:
        result = analyst.run_daily_brief()
        with _bjobs_lock:
            _bjobs[job_id]["status"] = "done" if result.get("ok") else "failed"
            _bjobs[job_id]["result"] = result
            if not result.get("ok"):
                _bjobs[job_id]["error"] = result.get("error", "Unknown error")
    except BaseException as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(f"\n❌ Daily Brief job {job_id} CRASHED:\n{tb}", flush=True)
        with _bjobs_lock:
            _bjobs[job_id]["status"] = "failed"
            _bjobs[job_id]["error"] = str(exc)


@app.post("/api/daily-brief")
def start_daily_brief(background_tasks: BackgroundTasks):
    """Start a Goldman-style PM morning brief (Grok 4.30-beta w/ live search)."""
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _bjobs_lock:
        _bjobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "result": None,
            "error": None,
        }
    background_tasks.add_task(_run_daily_brief, job_id)
    return _bjobs[job_id]


@app.get("/api/daily-brief/latest")
def get_latest_daily_brief():
    """Return the most-recently-completed daily brief (persisted to disk)."""
    path = analyst.DAILY_BRIEF_FILE
    if not path.exists():
        return {"exists": False}
    try:
        data = json.loads(path.read_text())
        data["exists"] = True
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read daily brief: {exc}")


@app.get("/api/daily-brief/{job_id}")
def get_daily_brief_status(job_id: str):
    """Poll a running or completed daily-brief job."""
    with _bjobs_lock:
        job = _bjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Daily brief job not found")
    return job


# ---------------------------------------------------------------------------
# Paper Portfolio Tracker
# ---------------------------------------------------------------------------

class TrackerHolding(BaseModel):
    ticker: str
    weight: float   # 0..1 (or 0..100; coerced server-side)


class TrackerCreateRequest(BaseModel):
    name: str
    holdings: list[TrackerHolding]
    source: dict | None = None


@app.post("/api/track")
def create_tracker(req: TrackerCreateRequest):
    """Lock in a new paper portfolio (idea basket) for forward tracking."""
    try:
        portfolio = analyst.create_idea_portfolio(
            name=req.name,
            holdings_input=[h.model_dump() for h in req.holdings],
            source=req.source or {},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return portfolio


@app.get("/api/track")
def list_trackers():
    """List all paper portfolios with computed performance metrics."""
    return {"portfolios": analyst.list_idea_portfolios()}


@app.get("/api/track/live")
def get_tracker_live():
    """Return the auto-promoted live portfolio (the benchmark)."""
    state = analyst._load_tracker_state()
    return {"live_portfolio": state.get("live_portfolio")}


@app.get("/api/track/live/detail")
def get_tracker_live_detail(snapshot_id: str | None = None):
    """YTD attribution for the live portfolio (year-start baseline + SPY benchmark).

    Per-holding return uses each ticker's first close of the calendar year as
    the entry baseline, so this surfaces who is driving annual outperformance
    versus the SPY YTD constant.

    Optional `snapshot_id` query param — when provided, returns the YTD detail
    using that historical snapshot's holdings and attribution instead of the
    current live state, so the user can re-open any past run.
    """
    return analyst.compute_live_ytd_detail(snapshot_id=snapshot_id)


@app.post("/api/track/live/ytd")
async def compute_live_ytd_unified(
    positions_file:     UploadFile = File(...),
    activity_file:      UploadFile = File(...),
    begin_value:        float | None = Form(None),
    monthly_perf_file:  UploadFile   = File(None),
):
    """Single unified YTD endpoint: Modified Dietz + TWRR + per-stock attribution.

    Multipart inputs:
      - positions_file:    Fidelity Positions CSV
      - activity_file:     Fidelity Activity / History CSV
      - begin_value:       Jan 1 portfolio total ($).  Optional when
                           monthly_perf_file is supplied — the first month's
                           beginning balance is used automatically.
      - monthly_perf_file: (optional) Fidelity monthly performance summary CSV.
                           Provides exact month-end balances + per-component breakdown.
                           When supplied begin_value may be omitted; the YTD-by-month
                           chart uses Fidelity's exact values and TWRR matches exactly.
    """

    try:
        pos_content    = await positions_file.read()
        positions_text = pos_content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read positions file: {exc}")

    try:
        act_content   = await activity_file.read()
        activity_text = act_content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read activity file: {exc}")

    monthly_perf_text: str | None = None
    if monthly_perf_file and monthly_perf_file.filename:
        try:
            mp_content        = await monthly_perf_file.read()
            monthly_perf_text = mp_content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read monthly performance file: {exc}")

    try:
        result = analyst.compute_unified_ytd(
            positions_text, activity_text, begin_value,
            monthly_perf_text=monthly_perf_text,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"compute_unified_ytd raised: {exc}\n\nTraceback:\n{tb}",
        )

    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Unknown error"))
    return result


@app.get("/api/track/live/snapshots")
def list_live_ytd_snapshots():
    """List all stored YTD snapshots (newest first) for the live portfolio."""
    return analyst.list_ytd_snapshots()


@app.get("/api/track/live/snapshots/{snapshot_id}")
def get_live_ytd_snapshot(snapshot_id: str):
    """Get one stored YTD snapshot by id (full attribution + holdings)."""
    result = analyst.get_ytd_snapshot(snapshot_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@app.delete("/api/track/live/snapshots/{snapshot_id}")
def delete_live_ytd_snapshot(snapshot_id: str):
    """Delete a stored YTD snapshot by id."""
    result = analyst.delete_ytd_snapshot(snapshot_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


class EmailYtdRequest(BaseModel):
    email: str
    snapshot_id: str | None = None


@app.post("/api/track/live/ytd/email")
def email_live_ytd_report(body: EmailYtdRequest):
    """Email the YTD report (live benchmark + attribution) to the given address.

    If snapshot_id is omitted, sends the most recent stored snapshot.
    """
    if not body.email or "@" not in body.email:
        raise HTTPException(status_code=422, detail="A valid email address is required.")
    try:
        result = analyst.email_ytd_report(body.email, body.snapshot_id)
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"email_ytd_report raised: {exc}\n\nTraceback:\n{tb}",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Email failed"))
    return result


@app.post("/api/track/live/ytd/set-current/{snapshot_id}")
def set_current_ytd_snapshot(snapshot_id: str):
    """Promote a past snapshot to the current account_history (live benchmark view).

    When the user selects a different run from the Past YTD Runs list, calling
    this makes the Live Benchmark card and YTD detail reflect that run.
    """
    try:
        result = analyst.set_current_ytd_snapshot(snapshot_id)
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"set_current_ytd_snapshot raised: {exc}\n\nTraceback:\n{tb}",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@app.post("/api/track/snapshot")
def trigger_tracker_snapshot():
    """Manually trigger a daily snapshot (admin / debug)."""
    return analyst.take_daily_snapshot(force=True)


@app.get("/api/track/{portfolio_id}")
def get_tracker(portfolio_id: str):
    """Return one portfolio with full daily series + benchmark series for charting."""
    p = analyst.get_idea_portfolio(portfolio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return p


@app.post("/api/track/{portfolio_id}/close")
def close_tracker(portfolio_id: str):
    """Mark a paper portfolio as closed (stops daily snapshotting)."""
    if not analyst.close_idea_portfolio(portfolio_id):
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return {"ok": True}


@app.delete("/api/track/{portfolio_id}")
def delete_tracker(portfolio_id: str):
    """Permanently delete a paper portfolio."""
    if not analyst.delete_idea_portfolio(portfolio_id):
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return {"ok": True}


@app.get("/api/portfolio/last")
def get_last_portfolio():
    """Return metadata about the most recent portfolio run (for the Research page link).

    Looks at the most-recently-modified Portfolio_Summary.md in /stocks as the
    ground truth for "when was a portfolio last run?" — this file is written
    by :func:`run_portfolio_summary` on every successful multi-ticker run and
    survives Railway redeploys via Dropbox hydration.
    """
    md_path = analyst.STOCKS_FOLDER / "Portfolio_Summary.md"
    if not md_path.exists():
        return {"exists": False}
    return {
        "exists": True,
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
        "title": "Portfolio Review",
    }


@app.get("/api/portfolio/summary")
def get_portfolio_summary_md():
    """Return the full markdown of the last Portfolio_Summary.md."""
    md_path = analyst.STOCKS_FOLDER / "Portfolio_Summary.md"
    if not md_path.exists():
        raise HTTPException(status_code=404, detail="No portfolio summary available yet")
    return {
        "summary_md": md_path.read_text(),
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
    }


@app.get("/api/portfolio/{job_id}", response_model=PortfolioJobStatus)
def get_portfolio_status(job_id: str):
    """Poll a portfolio run.  Falls back to the on-disk index after a restart."""
    with _pjobs_lock:
        job = _pjobs.get(job_id)
    if job:
        return job

    # Recovery path after server restart.
    idx = _load_job_index()
    entry = idx.get(job_id)
    if entry and entry.get("type") == "portfolio":
        xlsx_path = entry.get("xlsx_path", "")
        if xlsx_path and Path(xlsx_path).exists():
            recovered = {
                "job_id": job_id,
                "status": "done",
                "created_at": entry.get("created_at", ""),
                "strategy": "current",
                "n_tickers": 0,
                "error": None,
                "result": {
                    "ok": True,
                    "xlsx_path": xlsx_path,
                    "gamma_url": None,
                    "gamma_error": None,
                    "recovered": True,
                },
            }
            with _pjobs_lock:
                _pjobs[job_id] = recovered
            return recovered
        raise HTTPException(
            status_code=404,
            detail="Portfolio job was lost in a server restart. Please re-run.",
        )

    raise HTTPException(status_code=404, detail="Portfolio job not found")


@app.get("/api/portfolio/{job_id}/download")
def download_portfolio_xlsx(job_id: str):
    """Download the DGA-portfolio.xlsx produced by a portfolio run."""
    with _pjobs_lock:
        job = _pjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Portfolio job not found")
    result = job.get("result") or {}
    xlsx_path = result.get("xlsx_path")
    if not xlsx_path or not Path(xlsx_path).exists():
        raise HTTPException(status_code=404, detail="Portfolio xlsx not ready yet")
    return FileResponse(
        path=xlsx_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="DGA-portfolio.xlsx",
    )


# ---------------------------------------------------------------------------
# Dropbox startup hydration — runs once in a background thread so it doesn't
# block the server from accepting requests. Lists every *_DGA_Report.md in the
# Dropbox app folder and downloads any that are missing from the local /stocks
# folder. This repopulates the Saved Reports list after a Railway redeploy.
# ---------------------------------------------------------------------------
def _hydrate_from_dropbox() -> None:
    """Restore all report/analysis files from Dropbox into the container's
    /stocks folder on startup so the app survives Railway redeploys (which
    wipe local files).

    Files are now spread across four Dropbox subfolders:
      <base>/                  → metadata JSON files (tracker, gamma index, etc.)
      <base>/Presentations/    → .pptx PowerPoint files
      <base>/Reports/          → .docx Word reports
      <base>/MD cached/        → .md markdown reports
      <base>/Rebalanced/       → .xlsx portfolio rebalance files
    """
    dbx = analyst._dropbox_client()
    if dbx is None:
        return
    folder = analyst._dropbox_folder()

    def _sub(name: str) -> str:
        return f"{folder}/{name}" if folder else f"/{name}"

    pres_folder      = _sub(analyst.DROPBOX_PRESENTATIONS_SUBFOLDER)
    reports_folder   = _sub(analyst.DROPBOX_REPORTS_SUBFOLDER)
    md_folder        = _sub(analyst.DROPBOX_MD_SUBFOLDER)
    rebalanced_folder = _sub(analyst.DROPBOX_REBALANCED_SUBFOLDER)

    def _list(path: str):
        try:
            result = dbx.files_list_folder(path if path else "")
            ents = list(result.entries)
            while result.has_more:
                result = dbx.files_list_folder_continue(result.cursor)
                ents += result.entries
            return ents
        except Exception:
            return []

    downloaded = 0

    def _hydrate_entries(entries: list, source_folder: str,
                         accept_md: bool = False,
                         accept_docx: bool = False,
                         accept_pptx: bool = False,
                         accept_xlsx: bool = False,
                         accept_special: bool = False) -> int:
        n = 0
        for entry in entries:
            name = getattr(entry, "name", "")
            keep = False
            if accept_md and (name.endswith("_DGA_Report.md")
                              or name in {"Portfolio_Summary.md"}):
                keep = True
            if accept_docx and (name.endswith("_DGA_Report.docx")
                                or name == "Portfolio_Summary.docx"):
                keep = True
            if accept_pptx and (name.endswith("_DGA_Presentation.pptx")
                                or name == "Portfolio_Summary.pptx"):
                keep = True
            if accept_xlsx and name.lower().endswith(".xlsx"):
                keep = True
            if accept_special and name in {
                "tracker.json", "intelligence.json", "daily_brief.json",
                "_gamma_index.json", "_job_index.json",
            }:
                keep = True
            if not keep:
                continue
            local = analyst.STOCKS_FOLDER / name
            if local.exists():
                continue
            try:
                path = f"{source_folder}/{name}" if source_folder else f"/{name}"
                _, resp = dbx.files_download(path)
                local.write_bytes(resp.content)
                n += 1
            except Exception:
                pass
        return n

    # Base folder — metadata JSON + legacy .md/.docx that haven't been moved yet
    base_ents = _list(folder)
    downloaded += _hydrate_entries(base_ents, folder,
                                   accept_special=True,
                                   accept_md=True,    # legacy fallback
                                   accept_docx=True)  # legacy fallback
    # Subfolders — canonical locations after the folder reorganisation
    downloaded += _hydrate_entries(_list(pres_folder),       pres_folder,
                                   accept_pptx=True)
    downloaded += _hydrate_entries(_list(reports_folder),    reports_folder,
                                   accept_docx=True)
    downloaded += _hydrate_entries(_list(md_folder),         md_folder,
                                   accept_md=True)
    downloaded += _hydrate_entries(_list(rebalanced_folder), rebalanced_folder,
                                   accept_xlsx=True)

    if downloaded:
        print(f"☁️  Hydrated {downloaded} file(s) from Dropbox into /stocks "
              f"(base: {folder or '/'}, subfolders: Presentations, Reports, "
              f"MD cached, Rebalanced)")


threading.Thread(target=_hydrate_from_dropbox, daemon=True).start()

# Start the daily snapshot worker (runs once per day after market close)
analyst._start_tracker_snapshot_worker()


# ---------------------------------------------------------------------------
# Fund Admin — read-only endpoints (queries Railway Postgres via psycopg2)
# ---------------------------------------------------------------------------
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor as _RealDictCursor
    _PSYCOPG2_OK = True
except ImportError:
    _PSYCOPG2_OK = False

def _fund_conn():
    if not _PSYCOPG2_OK:
        raise HTTPException(status_code=503, detail="psycopg2 not installed")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise HTTPException(status_code=503, detail="DATABASE_URL not configured")
    try:
        return psycopg2.connect(url)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Fund DB unavailable: {e}")

def _fund_id(cur) -> str:
    fid = os.environ.get("FUND_ID")
    if fid:
        return fid
    cur.execute("SELECT id FROM funds WHERE short_name = 'DGA-I' LIMIT 1")
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Fund not found — run apply_schema.py first")
    return str(row["id"])


def _resolve_fund_id(cur, fund_id: str = None) -> str:
    """Return fund UUID: use caller-supplied fund_id if provided and valid,
    otherwise fall back to the default (env FUND_ID / DGA-I)."""
    if fund_id:
        cur.execute("SELECT id FROM funds WHERE id = %s", (fund_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Fund {fund_id!r} not found")
        return str(row["id"])
    return _fund_id(cur)


@app.get("/api/fund/list")
async def fund_list(request: Request):
    """Return a lightweight summary of every fund in the DB.
    Used by the multi-fund selector UI to show all funds before drilling in."""
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, short_name, inception_date, status,
                       mgmt_fee_pct, carry_pct, hurdle_pct
                  FROM funds
                 ORDER BY inception_date ASC
            """)
            funds = [dict(r) for r in cur.fetchall()]

            result = []
            for f in funds:
                fid = str(f["id"])

                # NAV = live market value of all open positions
                nav = _fund_market_nav(cur, fid)

                # LP count
                cur.execute(
                    "SELECT COUNT(*) AS n FROM lps WHERE fund_id=%s AND status='active'",
                    (fid,))
                lp_count = cur.fetchone()["n"]

                # Total committed capital (from commitments table)
                cur.execute("""
                    SELECT COALESCE(SUM(c.commitment_amount), 0) AS total
                      FROM commitments c JOIN lps l ON l.id = c.lp_id
                     WHERE l.fund_id = %s AND c.superseded_by IS NULL
                """, (fid,))
                contributions = float(cur.fetchone()["total"])

                # Position count (open lots, distinct securities)
                cur.execute("""
                    SELECT COUNT(DISTINCT security_id) AS n
                      FROM tax_lots WHERE fund_id=%s AND closed_at IS NULL
                """, (fid,))
                position_count = cur.fetchone()["n"]

                gain = nav - contributions
                gain_pct = (gain / contributions * 100) if contributions else 0.0

                result.append({
                    "id":             fid,
                    "name":           f["name"],
                    "short_name":     f["short_name"],
                    "inception_date": str(f["inception_date"]),
                    "status":         f["status"],
                    "mgmt_fee_pct":   float(f["mgmt_fee_pct"]),
                    "carry_pct":      float(f["carry_pct"]),
                    "hurdle_pct":     float(f["hurdle_pct"]),
                    "nav":            round(nav, 2),
                    "contributions":  round(contributions, 2),
                    "total_gain":     round(gain, 2),
                    "gain_pct":       round(gain_pct, 2),
                    "lp_count":       lp_count,
                    "position_count": position_count,
                })
            return result
    finally:
        conn.close()


@app.post("/api/fund/auth")
async def fund_auth_endpoint(body: FundAuthRequest):
    """Exchange the fund password for a fund-specific access token.
    Requires the main app token (handled by middleware) + correct FUND_PASSWORD."""
    if not hmac.compare_digest(body.password.strip(), _fund_password()):
        # Return 403, NOT 401 — 401 triggers the mobile client's main-auth retry loop.
        raise HTTPException(status_code=403, detail="Incorrect fund password")
    return {"fund_token": _make_fund_token()}


@app.get("/api/fund/overview")
async def fund_overview(request: Request, fund_id: str = None):
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)
            cur.execute("""
                SELECT name, short_name, inception_date, status,
                       mgmt_fee_pct, carry_pct, hurdle_pct, catch_up_pct
                  FROM funds WHERE id = %s
            """, (fid,))
            fund = dict(cur.fetchone())

            # NAV = net balance of all asset accounts
            # NAV = live market value of all open positions
            nav = _fund_market_nav(cur, fid)

            # Total LP committed capital
            cur.execute("""
                SELECT COALESCE(SUM(c.commitment_amount), 0) AS total
                  FROM commitments c
                  JOIN lps l ON l.id = c.lp_id
                 WHERE l.fund_id = %s AND c.superseded_by IS NULL
            """, (fid,))
            contributions = float(cur.fetchone()["total"])

            cur.execute("SELECT COUNT(*) AS n FROM lps WHERE fund_id=%s AND status='active'", (fid,))
            lp_count = cur.fetchone()["n"]

            cur.execute("SELECT COUNT(DISTINCT security_id) AS n FROM tax_lots WHERE fund_id=%s AND closed_at IS NULL", (fid,))
            position_count = cur.fetchone()["n"]

            gain = nav - contributions
            gain_pct = (gain / contributions * 100) if contributions else 0

            return {
                "fund_name":      fund["name"],
                "short_name":     fund["short_name"],
                "inception_date": str(fund["inception_date"]),
                "status":         fund["status"],
                "mgmt_fee_pct":   float(fund["mgmt_fee_pct"]),
                "carry_pct":      float(fund["carry_pct"]),
                "hurdle_pct":     float(fund["hurdle_pct"]),
                "catch_up_pct":   float(fund["catch_up_pct"]) if fund["catch_up_pct"] else None,
                "nav":            nav,
                "contributions":  contributions,
                "total_gain":     gain,
                "gain_pct":       gain_pct,
                "lp_count":       lp_count,
                "position_count": position_count,
            }
    finally:
        conn.close()


@app.get("/api/fund/lps")
async def fund_lps(request: Request, fund_id: str = None):
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            # Market NAV for the fund
            market_nav = _fund_market_nav(cur, fid)

            cur.execute("""
                SELECT l.id, l.legal_name, l.entity_type, l.onboarded_at,
                       COALESCE(c.commitment, 0) AS commitment
                  FROM lps l
                  LEFT JOIN (
                      SELECT lp_id, SUM(commitment_amount) AS commitment
                        FROM commitments WHERE superseded_by IS NULL GROUP BY lp_id
                  ) c ON c.lp_id = l.id
                 WHERE l.fund_id = %s AND l.status = 'active'
                 ORDER BY COALESCE(c.commitment, 0) DESC
            """, (fid,))
            rows = cur.fetchall()

            # Total committed determines each LP's ownership share
            total_committed = sum(float(r["commitment"]) for r in rows) or 0

            result = []
            for r in rows:
                commitment = float(r["commitment"])
                share      = (commitment / total_committed) if total_committed > 0 else 0.0
                cur_val    = round(market_nav * share, 2)
                result.append({
                    "id":           str(r["id"]),
                    "legal_name":   r["legal_name"],
                    "entity_type":  r["entity_type"],
                    "onboarded_at": str(r["onboarded_at"]) if r["onboarded_at"] else None,
                    "commitment":   commitment,
                    "current_value":cur_val,
                    "gain":         round(cur_val - commitment, 2),
                    "share_pct":    round(share * 100, 2),
                })
            return result
    finally:
        conn.close()


@app.get("/api/fund/positions")
async def fund_positions(request: Request, fund_id: str = None):
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)
            cur.execute("""
                SELECT
                    s.symbol, s.name, s.issuer,
                    COUNT(tl.id)                                              AS lot_count,
                    SUM(tl.quantity)                                          AS total_qty,
                    SUM(tl.quantity * tl.cost_basis_per_unit)
                        / SUM(tl.quantity)                                    AS avg_cost,
                    SUM(tl.quantity * tl.cost_basis_per_unit)                 AS total_cost,
                    MIN(tl.acquired_at)                                       AS first_acquired
                  FROM tax_lots tl
                  JOIN securities s ON s.id = tl.security_id
                 WHERE tl.fund_id = %s AND tl.closed_at IS NULL
                 GROUP BY s.id, s.symbol, s.name, s.issuer
                 ORDER BY SUM(tl.quantity * tl.cost_basis_per_unit) DESC
            """, (fid,))
            rows = cur.fetchall()
            total_cost = sum(float(r["total_cost"]) for r in rows) or 1

            # Fetch live prices for all symbols
            symbols = [r["symbol"] for r in rows if r["symbol"]]
            prices  = _fetch_prices(symbols)

            result = []
            total_mkt = 0.0
            for r in rows:
                sym       = r["symbol"]
                qty       = float(r["total_qty"])
                avg_cost  = float(r["avg_cost"])
                tot_cost  = float(r["total_cost"])
                last_p    = prices.get(sym)
                mkt_val   = (qty * last_p) if last_p else None
                if mkt_val:
                    total_mkt += mkt_val
                result.append({
                    "symbol":        sym,
                    "name":          r["name"],
                    "issuer":        r["issuer"],
                    "lot_count":     r["lot_count"],
                    "total_qty":     qty,
                    "avg_cost":      avg_cost,
                    "total_cost":    tot_cost,
                    "last_price":    round(last_p, 4) if last_p else None,
                    "market_value":  round(mkt_val, 2) if mkt_val else None,
                    "unrealized_gain": round(mkt_val - tot_cost, 2) if mkt_val else None,
                    "weight_pct":    tot_cost / total_cost * 100,
                    "first_acquired":str(r["first_acquired"])[:10] if r["first_acquired"] else None,
                })

            # Patch market-based weight_pct if we have prices
            if total_mkt > 0:
                for item in result:
                    if item["market_value"] is not None:
                        item["market_weight_pct"] = round(item["market_value"] / total_mkt * 100, 2)
            return result
    finally:
        conn.close()


@app.get("/api/fund/activity")
async def fund_activity(request: Request, fund_id: str = None):
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)
            cur.execute("""
                SELECT
                    t.id, t.effective_date, t.category, t.description, t.posted_at,
                    COALESCE(SUM(tl.debit),  0) AS total_debit,
                    COALESCE(SUM(tl.credit), 0) AS total_credit
                  FROM transactions t
                  JOIN transaction_lines tl ON tl.transaction_id = t.id
                 WHERE t.fund_id = %s
                 GROUP BY t.id, t.effective_date, t.category, t.description, t.posted_at
                 ORDER BY t.posted_at DESC
                 LIMIT 25
            """, (fid,))
            rows = cur.fetchall()
            return [{
                "id":             str(r["id"]),
                "effective_date": str(r["effective_date"]),
                "category":       r["category"],
                "description":    r["description"],
                "posted_at":      r["posted_at"].isoformat() if r["posted_at"] else None,
                "amount":         max(float(r["total_debit"]), float(r["total_credit"])),
            } for r in rows]
    finally:
        conn.close()


@app.get("/api/fund/waterfall")
async def fund_waterfall(request: Request, fund_id: str = None):
    """GP carry / LP waterfall — high-watermark model.

    Carry model:
      • The hurdle ($100 K/yr fixed) is a per-year GATE: if the year's gross
        profit exceeds the hurdle, the GP is entitled to carry.
      • Carry amount  = (year_end_NAV − high_watermark) × carry_pct (25 %).
      • High-watermark starts at  contributions + hurdle  (inception year),
        then advances to the highest end-NAV ever recorded.
      • HWM only moves up; years where end_NAV < HWM earn zero carry even if
        the year was profitable.
      • All carry is rolled into GP fractional equity (never paid out as cash),
        so the GP's dollar stake = accum_fraction × current_NAV at any moment.

    Data source priority:
      1. fund_annual_snapshots (exact year-by-year actuals — preferred)
      2. Approximation from contribution + current NAV (shows warning)
    """
    _require_fund_token(request)
    from datetime import date as _date
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            cur.execute("""
                SELECT inception_date, carry_pct, hurdle_pct,
                       COALESCE(catch_up_pct, 1.0) AS catch_up_pct
                  FROM funds WHERE id = %s
            """, (fid,))
            fund        = dict(cur.fetchone())
            inception   = fund["inception_date"]
            carry_pct   = float(fund["carry_pct"])
            hurdle_pct  = float(fund["hurdle_pct"])
            catch_up    = float(fund["catch_up_pct"])
            today       = _date.today()

            # ── Check for annual snapshots ────────────────────────────────
            has_snapshots = False
            annual_rows   = []
            try:
                cur.execute("""
                    SELECT year, start_nav, end_nav, contributions,
                           hurdle_amount, gross_profit, carry_earned,
                           carry_paid, carry_rolled, gp_equity_end, notes
                      FROM fund_annual_snapshots
                     WHERE fund_id = %s
                     ORDER BY year ASC
                """, (fid,))
                annual_rows = [dict(r) for r in cur.fetchall()]
                has_snapshots = len(annual_rows) > 0
            except Exception:
                pass  # table doesn't exist yet

            # ── LP commitments ────────────────────────────────────────────
            cur.execute("""
                SELECT COALESCE(SUM(c.commitment_amount), 0) AS total
                  FROM commitments c JOIN lps l ON l.id = c.lp_id
                 WHERE l.fund_id = %s AND c.superseded_by IS NULL
            """, (fid,))
            contributions = float(cur.fetchone()["total"])

            cur.execute("""
                SELECT l.legal_name,
                       COALESCE(SUM(c.commitment_amount), 0) AS commitment
                  FROM lps l
                  LEFT JOIN commitments c ON c.lp_id = l.id AND c.superseded_by IS NULL
                 WHERE l.fund_id = %s AND l.status = 'active'
                 GROUP BY l.id, l.legal_name
                HAVING COALESCE(SUM(c.commitment_amount), 0) > 0
                 ORDER BY COALESCE(SUM(c.commitment_amount), 0) DESC
            """, (fid,))
            lp_rows = cur.fetchall()

            # NAV = live market value of all open positions
            nav = _fund_market_nav(cur, fid)

            if has_snapshots:
                # ── Exact annual calculation from year-by-year snapshots ─────
                #
                # GP equity model: carry is issued as fractional ownership each
                # year carry is earned.  The GP's dollar stake at any date is:
                #   gp_equity = accum_fraction × current_NAV
                # (co-investment: the stake moves with NAV, not a fixed dollar).
                #
                # High-watermark:
                #   HWM_initial = contributions + hurdle_amount  (inception gate)
                #   HWM advances to end_NAV whenever end_NAV > HWM
                #
                annual_hurdle_fixed = float(annual_rows[0]["hurdle_amount"])   # $100 K
                last_row            = annual_rows[-1]
                last_year           = last_row["year"]
                last_end_nav        = float(last_row["end_nav"])
                last_gp_equity      = float(last_row["gp_equity_end"])
                last_accum_frac     = last_gp_equity / last_end_nav if last_end_nav else 0.0

                years_since         = (today - inception).days / 365.25
                total_gain          = nav - contributions

                # ── Reconstruct HWM per row for the year-by-year table ───────
                # HWM_initial = first year start_nav + hurdle  (= 2,000,000 + 100,000 = 2,100,000)
                # Using start_nav (total fund including GP) rather than LP contributions alone.
                hwm = float(annual_rows[0]["start_nav"]) + annual_hurdle_fixed   # inception gate
                snapshot_rows_out = []
                hwm_at_end = hwm  # tracks the running HWM
                for r in annual_rows:
                    end_nav_r  = float(r["end_nav"])
                    gp_eq_r    = float(r["gp_equity_end"])
                    accum_frac_r = gp_eq_r / end_nav_r if end_nav_r else 0.0
                    row_hwm    = hwm  # HWM at start of this year (threshold to exceed)
                    snapshot_rows_out.append({
                        "year":             r["year"],
                        "start_nav":        float(r["start_nav"]),
                        "end_nav":          end_nav_r,
                        "gross_profit":     float(r["gross_profit"]),
                        "hurdle_amount":    float(r["hurdle_amount"]),
                        "carry_earned":     float(r["carry_earned"]),
                        "gp_equity_end":    round(gp_eq_r, 2),
                        "accum_gp_pct":     round(accum_frac_r * 100, 4),
                        "hwm_threshold":    round(row_hwm, 2),
                    })
                    if end_nav_r > hwm:
                        hwm = end_nav_r
                hwm_at_end = hwm   # current HWM after all completed years

                # ── Current year (partial) carry estimate ────────────────────
                # HWM = hwm_at_end (highest end_NAV in recorded history)
                # New carry is earned only if nav > HWM AND gain > pro-rata hurdle
                cur_year_days      = (today - _date(last_year + 1, 1, 1)).days
                cur_year_frac      = max(0.0, cur_year_days / 365.25)
                cur_year_hurdle    = annual_hurdle_fixed * cur_year_frac
                cur_year_gain      = nav - last_end_nav
                cur_year_new_carry = 0.0
                if cur_year_gain > cur_year_hurdle and nav > hwm_at_end:
                    cur_year_new_carry = (nav - hwm_at_end) * carry_pct

                # ── GP equity at current NAV ──────────────────────────────────
                # Base: last accum fraction × current NAV (stake moves with NAV)
                # Plus: any new carry earned in partial current year
                gp_equity_base   = last_accum_frac * nav
                gp_accrued_carry = gp_equity_base + cur_year_new_carry
                gp_equity_pct    = (gp_accrued_carry / nav * 100) if nav else 0.0
                lp_nav_after_carry = nav - gp_accrued_carry

                # ── Carry history summary ─────────────────────────────────────
                total_carry_earned = sum(float(r["carry_earned"]) for r in annual_rows)
                carry_years        = [r["year"] for r in annual_rows if float(r["carry_earned"]) > 0]
                hurdle_cleared     = len(carry_years) > 0

                per_lp = []
                for row in lp_rows:
                    commitment = float(row["commitment"])
                    share      = commitment / contributions if contributions else 0
                    per_lp.append({
                        "legal_name":      row["legal_name"],
                        "commitment":      commitment,
                        "share_pct":       round(share * 100, 4),
                        "carry_charge":    round(gp_accrued_carry * share, 2),
                        "nav_after_carry": round(lp_nav_after_carry * share, 2),
                    })

                return {
                    "as_of":                 today.isoformat(),
                    "inception_date":        str(inception),
                    "data_source":           "annual_snapshots",
                    "years_since_inception": round(years_since, 2),
                    "nav":                   round(nav, 2),
                    "contributions":         round(contributions, 2),
                    "total_gain":            round(total_gain, 2),
                    "hurdle_pct":            hurdle_pct,
                    "carry_pct":             carry_pct,
                    "catch_up_pct":          catch_up,
                    # Waterfall summary
                    "hurdle_cleared":        hurdle_cleared,
                    "carry_years":           carry_years,
                    "high_watermark":        round(hwm_at_end, 2),
                    "total_carry_earned_hist": round(total_carry_earned, 2),
                    "gp_accrued_carry":      round(gp_accrued_carry, 2),
                    "gp_equity_pct":         round(gp_equity_pct, 4),
                    "lp_nav_after_carry":    round(lp_nav_after_carry, 2),
                    # Current-year estimates
                    "cur_year_gain":         round(cur_year_gain, 2),
                    "cur_year_hurdle":       round(cur_year_hurdle, 2),
                    "cur_year_new_carry":    round(cur_year_new_carry, 2),
                    # Year-by-year table
                    "annual_snapshots":      snapshot_rows_out,
                    "per_lp":                per_lp,
                }

            else:
                # ── Approximation (no annual snapshots yet) ───────────────
                # Annual hurdle: each year the fund must return hurdle_pct on
                # starting NAV before carry applies.  Without year-by-year data
                # we approximate using simple annual hurdle on contributions.
                years           = (today - inception).days / 365.25
                total_gain      = nav - contributions
                annual_hurdle_amount = contributions * hurdle_pct
                # Simple sum: hurdle_pct × contributions × years (not compound)
                cumulative_hurdle = annual_hurdle_amount * years
                hurdle_cleared  = total_gain >= cumulative_hurdle
                carry_pool      = max(0.0, total_gain - cumulative_hurdle)
                gp_carry        = carry_pool * carry_pct if hurdle_cleared else 0.0
                lp_net          = total_gain - gp_carry

                per_lp = []
                for row in lp_rows:
                    commitment = float(row["commitment"])
                    share      = commitment / contributions if contributions else 0
                    per_lp.append({
                        "legal_name":      row["legal_name"],
                        "commitment":      commitment,
                        "share_pct":       round(share * 100, 4),
                        "carry_charge":    round(gp_carry * share, 2),
                        "net_gain":        round(lp_net * share, 2),
                        "nav_after_carry": round(commitment + lp_net * share, 2),
                    })

                return {
                    "as_of":                today.isoformat(),
                    "inception_date":       str(inception),
                    "data_source":          "approximation",
                    "data_source_warning":  "Annual snapshots not yet entered. Figures are approximate — provide year-end NAVs for exact calculation.",
                    "years_since_inception":round(years, 2),
                    "nav":                  round(nav, 2),
                    "contributions":        round(contributions, 2),
                    "total_gain":           round(total_gain, 2),
                    "hurdle_pct":           hurdle_pct,
                    "carry_pct":            carry_pct,
                    "annual_hurdle_amount": round(annual_hurdle_amount, 2),
                    "cumulative_hurdle":    round(cumulative_hurdle, 2),
                    "hurdle_cleared":       hurdle_cleared,
                    "carry_pool":           round(carry_pool, 2),
                    "gp_accrued_carry":     round(gp_carry, 2),
                    "lp_net_gain":          round(lp_net, 2),
                    "lp_nav_after_carry":   round(contributions + lp_net, 2),
                    "annual_snapshots":     [],
                    "per_lp":               per_lp,
                }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fund Admin — management endpoints (create, import positions, import cap table)
# ---------------------------------------------------------------------------

def _seed_coa_for_fund(cur, fund_id: str) -> None:
    """Insert the standard chart-of-accounts for a new fund (idempotent)."""
    cur.execute("SELECT COUNT(*) AS n FROM accounts WHERE fund_id = %s", (fund_id,))
    if cur.fetchone()["n"] > 0:
        return  # already seeded
    for code, name, atype in _FUND_COA:
        cur.execute("""
            INSERT INTO accounts (fund_id, code, name, type)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (fund_id, code) DO NOTHING
        """, (fund_id, code, name, atype))


@app.post("/api/fund/admin/create")
async def fund_admin_create(request: Request, body: CreateFundRequest):
    """Create a new fund + seed its chart of accounts.
    Idempotent on short_name — re-calling with the same short_name updates
    the fund name but does not touch the CoA."""
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            # Derive fiscal year end from inception year if not supplied
            fy_end = body.fiscal_year_end
            if not fy_end:
                yr = body.inception_date[:4]
                fy_end = f"{yr}-12-31"

            cur.execute("""
                INSERT INTO funds (
                    name, short_name, structure, domicile, base_ccy,
                    inception_date, fiscal_year_end,
                    mgmt_fee_pct, mgmt_fee_basis, mgmt_fee_freq,
                    carry_pct, hurdle_pct, catch_up_pct,
                    max_lps, status
                ) VALUES (
                    %s, %s, '3c1', 'DE', 'USD',
                    %s, %s,
                    %s, 'committed', 'quarterly',
                    %s, %s, 1.00,
                    99, 'open'
                )
                ON CONFLICT (short_name) DO UPDATE
                    SET name = EXCLUDED.name,
                        updated_at = NOW()
                RETURNING id
            """, (body.name, body.short_name, body.inception_date, fy_end,
                  body.mgmt_fee_pct, body.carry_pct, body.hurdle_pct))
            fid = str(cur.fetchone()["id"])
            _seed_coa_for_fund(cur, fid)
        conn.commit()
        return {"fund_id": fid, "name": body.name, "short_name": body.short_name}
    finally:
        conn.close()


@app.post("/api/fund/import-positions")
async def fund_import_positions(
    request: Request,
    fund_id: str = Form(None),
    file: UploadFile = File(...),
):
    """Upload a Fidelity Account Positions CSV (or XLSX) to refresh the
    fund's open tax-lot positions.

    Flow:
     1. Parse CSV → list of {symbol, name, qty, avg_cost, last_price, ...}
     2. Upsert securities records
     3. Close all existing open lots (without a hard delete — immutable ledger)
     4. Create a single 'adjustment' transaction with balanced double-entry:
          Dr. 1100 Securities at Cost  (one line per security)
          Dr. 1030 Cash — Money Market (for MM positions)
          Cr. 3000 Capital — GP        (single balancing credit)
     5. Insert new tax_lots pointing at that transaction
    """
    _require_fund_token(request)
    raw = await file.read()
    # Handle both CSV and XLSX uploads
    if (file.filename or '').lower().endswith(('.xlsx', '.xls')):
        if not _OPENPYXL_OK:
            raise HTTPException(400, "openpyxl not installed — upload a .csv file")
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb.active
        header = [str(c.value or '').strip() for c in next(ws.iter_rows())]
        lines  = [header] + [
            [str(c.value or '').strip() for c in row] for row in ws.iter_rows(min_row=2)
        ]
        content = '\n'.join(','.join(r) for r in lines)
    else:
        content = raw.decode('utf-8', errors='replace')

    positions = _parse_fidelity_csv(content)
    if not positions:
        raise HTTPException(400, "No valid positions found in file. "
            "Expected a Fidelity Account Positions CSV export.")

    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            # ── Fetch CoA accounts ─────────────────────────────────────────
            cur.execute("""
                SELECT code, id FROM accounts
                 WHERE fund_id = %s AND code IN ('1020','1030','1100','3000')
            """, (fid,))
            acct_map = {r["code"]: str(r["id"]) for r in cur.fetchall()}
            sec_acct  = acct_map.get("1100")
            mm_acct   = acct_map.get("1030") or acct_map.get("1020")
            cap_acct  = acct_map.get("3000")
            if not sec_acct or not cap_acct:
                raise HTTPException(500, "Chart of accounts not found — "
                    "run /api/fund/admin/create first")

            # ── Upsert securities ─────────────────────────────────────────
            sec_ids = {}
            for p in positions:
                sym = p["symbol"]
                cur.execute("""
                    INSERT INTO securities (symbol, name, asset_class, is_public)
                    VALUES (%s, %s, %s, TRUE)
                    ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                """, (sym, p["name"] or sym,
                      "cash" if p["is_cash"] else "equity"))
                sec_ids[sym] = str(cur.fetchone()["id"])

            # ── Close all existing open lots ──────────────────────────────
            cur.execute("""
                UPDATE tax_lots SET closed_at = NOW()
                 WHERE fund_id = %s AND closed_at IS NULL
            """, (fid,))

            # ── Create balancing adjustment transaction ────────────────────
            today = datetime.utcnow().date().isoformat()
            cur.execute("""
                INSERT INTO transactions
                    (fund_id, effective_date, category, description)
                VALUES (%s, %s, 'adjustment', 'Position import from Fidelity CSV')
                RETURNING id
            """, (fid, today))
            txn_id = str(cur.fetchone()["id"])

            # Build lines: one Dr per position, one Cr total
            total_cost = 0.0
            line_num   = 1
            for p in positions:
                cost = float(p["cost_basis"])
                if cost <= 0:
                    continue
                total_cost += cost
                acct = mm_acct if p["is_cash"] else sec_acct
                if not acct:
                    continue
                cur.execute("""
                    INSERT INTO transaction_lines
                        (transaction_id, line_number, account_id, debit, security_id)
                    VALUES (%s, %s, %s, %s, %s)
                """, (txn_id, line_num, acct, round(cost, 4),
                      sec_ids.get(p["symbol"])))
                line_num += 1

            # Balancing credit to Capital — GP
            if total_cost > 0:
                cur.execute("""
                    INSERT INTO transaction_lines
                        (transaction_id, line_number, account_id, credit)
                    VALUES (%s, %s, %s, %s)
                """, (txn_id, line_num, cap_acct, round(total_cost, 4)))

            # ── Insert new tax_lots ───────────────────────────────────────
            for p in positions:
                cur.execute("""
                    INSERT INTO tax_lots
                        (fund_id, security_id, acquired_at,
                         quantity, cost_basis_per_unit, open_transaction_id)
                    VALUES (%s, %s, NOW(), %s, %s, %s)
                """, (fid, sec_ids[p["symbol"]],
                      float(p["quantity"]),
                      float(p["avg_cost"]) if p["avg_cost"] else 0.0,
                      txn_id))

        conn.commit()

        # Fetch prices for imported symbols
        symbols = [p["symbol"] for p in positions if not p["is_cash"]]
        prices  = _fetch_prices(symbols)
        market_value = sum(
            float(p["quantity"]) * (prices.get(p["symbol"]) or float(p.get("last_price") or 0))
            for p in positions
        )

        return {
            "fund_id":            fid,
            "imported":           len(positions),
            "positions_imported": len(positions),
            "market_value_total": round(market_value, 2),
            "message": f"Successfully imported {len(positions)} position lots.",
        }
    finally:
        conn.close()


@app.post("/api/fund/import-captable")
async def fund_import_captable(
    request: Request,
    fund_id: str = Form(None),
    file: UploadFile = File(...),
):
    """Upload a cap-table CSV or XLSX to set/update LP records and commitments.

    Expected columns (case-insensitive):
        LP Name, Commitment Amount, Entity Type (opt), Effective Date (opt)

    On re-upload, existing LPs are matched by legal_name (case-insensitive).
    New commitments supersede the previous commitment for each LP.
    """
    _require_fund_token(request)
    raw  = await file.read()
    rows, economics, fund_estab_year = _parse_captable(raw, file.filename or '')
    if not rows:
        raise HTTPException(400, "No valid LP rows found in file. "
            "Expected a column containing 'LP Name' and contribution amounts "
            "(either a 'Commitment Amount' column or year columns like '2024', '2025').")
    # Also parse annual NAV rows from the same file (waterfall data)
    nav_rows = _parse_annual_nav(raw, file.filename or '')

    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            # Look up CoA accounts needed for contribution journal entries
            cur.execute("""
                SELECT code, id FROM accounts
                 WHERE fund_id = %s AND code IN ('1020','1010','3100','3000')
            """, (fid,))
            acct_map = {r["code"]: str(r["id"]) for r in cur.fetchall()}
            cash_acct = acct_map.get("1020") or acct_map.get("1010")
            lp_cap_acct = acct_map.get("3100")  # Capital — LP

            imported = 0
            skipped  = 0
            for row in rows:
                commitment = float(row["commitment"])
                eff_date   = row["effective_date"]

                # ── Get or create LP (idempotent — match by legal_name) ───────
                cur.execute("""
                    SELECT id FROM lps
                     WHERE fund_id = %s
                       AND LOWER(legal_name) = LOWER(%s)
                     LIMIT 1
                """, (fid, row["legal_name"]))
                existing_lp = cur.fetchone()

                if existing_lp:
                    lp_id = str(existing_lp["id"])
                else:
                    cur.execute("""
                        INSERT INTO lps (fund_id, legal_name, entity_type,
                                         accred_type, status)
                        VALUES (%s, %s, %s, 'net_worth', 'active')
                        RETURNING id
                    """, (fid, row["legal_name"], row["entity_type"]))
                    r = cur.fetchone()
                    if not r:
                        continue
                    lp_id = str(r["id"])

                # ── Commitment: skip if same amount already exists ─────────────
                cur.execute("""
                    SELECT id, commitment_amount FROM commitments
                     WHERE lp_id = %s AND fund_id = %s AND superseded_by IS NULL
                     LIMIT 1
                """, (lp_id, fid))
                old = cur.fetchone()

                if old and abs(float(old["commitment_amount"]) - commitment) < 0.01:
                    # Exact same commitment already on record — skip entirely
                    skipped += 1
                    continue

                # Different amount (or no existing commitment) → insert + supersede
                cur.execute("""
                    INSERT INTO commitments
                        (lp_id, fund_id, commitment_amount, effective_date)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                """, (lp_id, fid, commitment, eff_date))
                new_cmt_id = str(cur.fetchone()["id"])

                if old:
                    cur.execute("""
                        UPDATE commitments SET superseded_by = %s WHERE id = %s
                    """, (new_cmt_id, str(old["id"])))

                # ── Capital contribution journal entry ────────────────────────
                # Dr. 1020 Cash — Brokerage (or 1010 Operating)
                # Cr. 3100 Capital — Limited Partners
                # Only if we have both accounts and the LP didn't already have
                # a contribution transaction for the same amount on the same date.
                if cash_acct and lp_cap_acct and commitment > 0:
                    cur.execute("""
                        SELECT COUNT(*) AS n FROM transactions t
                          JOIN transaction_lines tl ON tl.transaction_id = t.id
                         WHERE t.fund_id = %s
                           AND t.category = 'contribution'
                           AND t.effective_date = %s
                           AND tl.account_id = %s
                           AND tl.credit = %s
                    """, (fid, eff_date, lp_cap_acct, round(commitment, 4)))
                    already_exists = cur.fetchone()["n"] > 0

                    if not already_exists:
                        cur.execute("""
                            INSERT INTO transactions
                                (fund_id, effective_date, category, description)
                            VALUES (%s, %s, 'contribution', %s)
                            RETURNING id
                        """, (fid, eff_date,
                              f"Capital contribution — {row['legal_name']}"))
                        txn_id = str(cur.fetchone()["id"])

                        # Debit cash
                        cur.execute("""
                            INSERT INTO transaction_lines
                                (transaction_id, line_number, account_id, debit)
                            VALUES (%s, 1, %s, %s)
                        """, (txn_id, cash_acct, round(commitment, 4)))

                        # Credit LP capital
                        cur.execute("""
                            INSERT INTO transaction_lines
                                (transaction_id, line_number, account_id, credit)
                            VALUES (%s, 2, %s, %s)
                        """, (txn_id, lp_cap_acct, round(commitment, 4)))

                imported += 1

            # ── Apply fund economics + Fund Established date ─────────────────
            econ_applied = {}
            fund_updates = []
            fund_vals    = []
            for col, key in [
                ("mgmt_fee_pct", "mgmt_fee_pct"),
                ("carry_pct",    "carry_pct"),
                ("hurdle_pct",   "hurdle_pct"),
            ]:
                if key in economics:
                    fund_updates.append(f"{col} = %s")
                    fund_vals.append(economics[key])
                    econ_applied[key] = economics[key]
            if fund_estab_year:
                fund_updates.append("inception_date = %s")
                fund_vals.append(f"{fund_estab_year}-01-01")
            if fund_updates:
                fund_vals.append(fid)
                cur.execute(
                    f"UPDATE funds SET {', '.join(fund_updates)} WHERE id = %s",
                    fund_vals,
                )

            # ── Import annual NAV rows (waterfall) ───────────────────────────
            nav_imported = 0
            for r in nav_rows:
                cur.execute("""
                    INSERT INTO fund_annual_snapshots
                        (fund_id, year, start_nav, end_nav, contributions,
                         hurdle_amount, gross_profit, carry_earned,
                         carry_paid, carry_rolled, gp_equity_end)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (fund_id, year) DO UPDATE
                        SET start_nav      = EXCLUDED.start_nav,
                            end_nav        = EXCLUDED.end_nav,
                            contributions  = EXCLUDED.contributions,
                            hurdle_amount  = EXCLUDED.hurdle_amount,
                            gross_profit   = EXCLUDED.gross_profit,
                            carry_earned   = EXCLUDED.carry_earned,
                            carry_paid     = EXCLUDED.carry_paid,
                            carry_rolled   = EXCLUDED.carry_rolled,
                            gp_equity_end  = EXCLUDED.gp_equity_end,
                            updated_at     = NOW()
                """, (fid, r['year'], r['start_nav'], r['end_nav'],
                      r['contributions'], r['hurdle_amount'], r['gross_profit'],
                      r['carry_earned'], r['carry_paid'], r['carry_rolled'],
                      r['gp_equity_end']))
                nav_imported += 1

        conn.commit()
        year_note = ""
        contrib_years = [r["contribution_year"] for r in rows if r.get("contribution_year")]
        if contrib_years:
            year_note = f" (contributions from {min(contrib_years)}–{max(contrib_years)})"
        lp_msg = f"Imported {imported} LP record(s)" if imported else "No new LP records"
        if skipped:
            lp_msg += f" ({skipped} already on file, skipped)"
        resp: dict = {
            "fund_id":          fid,
            "imported":         imported,
            "lps_imported":     imported,
            "lps_skipped":      skipped,
            "nav_rows_imported": nav_imported,
            "message":          f"{lp_msg}{year_note}.",
        }
        if nav_imported:
            resp["message"] += f" {nav_imported} annual NAV rows loaded."
        if fund_estab_year:
            resp["message"] += f" Fund established {fund_estab_year}."
        if econ_applied:
            resp["economics_applied"] = econ_applied
            parts = []
            if "mgmt_fee_pct" in econ_applied:
                parts.append(f"mgmt fee {econ_applied['mgmt_fee_pct']*100:.2f}%")
            if "carry_pct" in econ_applied:
                parts.append(f"carry {econ_applied['carry_pct']*100:.0f}%")
            if "hurdle_pct" in econ_applied:
                parts.append(f"hurdle {econ_applied['hurdle_pct']*100:.0f}%")
            resp["message"] += f" Fund economics updated: {', '.join(parts)}."
        return resp
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Annual NAV import — populates fund_annual_snapshots for waterfall display
# ---------------------------------------------------------------------------

def _parse_annual_nav(content: bytes, filename: str) -> list:
    """Parse an annual NAV / waterfall spreadsheet.

    Expected columns (detected by header keyword matching):
        Year | Jan 1 NAV | Dec 31 NAV | Contributions | Hurdle Amount |
        Carry Owed | GP Equity Allocated | LP Allocations | … |
        accum GP equity in fund

    Returns list of dicts matching fund_annual_snapshots columns.
    Rows without a valid Dec 31 NAV (e.g. current partial year) are skipped.
    """
    fname_lower = (filename or '').lower()
    if fname_lower.endswith(('.xlsx', '.xls')):
        if not _OPENPYXL_OK:
            raise HTTPException(400, "openpyxl not installed — upload a CSV instead")
        wb  = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws  = wb.active
        raw = [[str(c.value if c.value is not None else '').strip() for c in row]
               for row in ws.iter_rows()]
    else:
        text = content.decode('utf-8', errors='replace')
        raw  = [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]

    if not raw:
        return []

    def _pm(s):
        """Parse money string: '$1,474,741' or '-' → float (dash / blank → 0)."""
        s2 = str(s or '').replace('$', '').replace(',', '').strip()
        if s2 in ('', '-', '—', 'None'):
            return 0.0
        try:
            return float(s2)
        except (ValueError, TypeError):
            return None

    def _pct_val(s):
        """Parse percent string '13.37%' or '0.1337' → fraction 0–1, or None."""
        s2 = str(s or '').strip()
        # Strip everything after a space (e.g. "0.08% EM: 99.02%" → "0.08%")
        s2 = s2.split()[0] if s2 else ''
        s2 = s2.replace('%', '').strip()
        try:
            v = float(s2)
            return v / 100.0 if v > 1 else v   # "13.37" → 0.1337; "0.1337" → 0.001337?
            # Heuristic: values > 1 are already percent form
        except (ValueError, TypeError):
            return None

    # ── Locate the header row (col A = "year") ───────────────────────────────
    header_idx = None
    for i, row in enumerate(raw):
        if row and str(row[0]).strip().lower() == 'year':
            header_idx = i
            break

    if header_idx is None:
        return []

    header = [str(c).lower().strip() for c in raw[header_idx]]

    def _find_col(*kws):
        for kw in kws:
            for j, h in enumerate(header):
                if kw in h:
                    return j
        return None

    c_start  = _find_col('jan 1', 'jan1', 'start nav', 'beginning') or 1
    c_end    = _find_col('dec 31', 'dec31', 'end nav', 'ending')    or 2
    c_contr  = _find_col('contribution')                             or 3
    c_hurdle = _find_col('hurdle amount', 'hurdle')                  or 4
    c_carry  = _find_col('carry owed', 'carry earned', 'carry')      or 5
    c_accum  = _find_col('accum gp', 'accumulated gp', 'accum gp equity')

    # accum GP column is often the last column (J = index 9 in typical layout)
    if c_accum is None:
        c_accum = max(9, len(header) - 1)

    out = []
    for row in raw[header_idx + 1:]:
        if not row or not str(row[0]).strip():
            continue
        try:
            year = int(float(str(row[0]).strip()))
        except (ValueError, TypeError):
            continue
        if year < 2000 or year > 2099:
            continue

        start_nav = _pm(row[c_start]  if c_start  < len(row) else '') or 0.0
        end_nav   = _pm(row[c_end]    if c_end    < len(row) else '')
        contrib   = _pm(row[c_contr]  if c_contr  < len(row) else '') or 0.0
        hurdle    = _pm(row[c_hurdle] if c_hurdle < len(row) else '') or 0.0
        carry     = _pm(row[c_carry]  if c_carry  < len(row) else '') or 0.0
        accum_raw = row[c_accum]      if c_accum  < len(row) else ''

        # Skip partial / current year rows (no Dec 31 NAV yet)
        if end_nav is None or end_nav <= 0:
            continue

        accum_pct    = _pct_val(accum_raw)
        gp_equity_end = round(accum_pct * end_nav, 2) if accum_pct is not None else 0.0
        gross_profit  = round(end_nav - start_nav - contrib, 2)

        out.append({
            'year':          year,
            'start_nav':     round(start_nav, 2),
            'end_nav':       round(end_nav,   2),
            'contributions': round(contrib,   2),
            'hurdle_amount': round(hurdle,    2),
            'gross_profit':  gross_profit,
            'carry_earned':  round(carry,     2),
            'carry_paid':    0.0,
            'carry_rolled':  round(carry,     2),
            'gp_equity_end': gp_equity_end,
        })

    return out


@app.post("/api/fund/import-annual-nav")
async def fund_import_annual_nav(
    request: Request,
    fund_id: str = Form(None),
    file: UploadFile = File(...),
):
    """Upload an annual NAV / waterfall spreadsheet to populate
    fund_annual_snapshots and unlock the year-by-year waterfall table.

    Accepted column layout (flexible, header-keyword matched):
        Year | Jan 1 NAV | Dec 31 NAV | Contributions | Hurdle Amount |
        Carry Owed | GP Equity Allocated | LP Allocations | … |
        accum GP equity in fund

    Rows without a Dec 31 NAV are silently skipped (current partial year).
    Existing rows for the same fund+year are overwritten (upsert).
    """
    _require_fund_token(request)
    raw  = await file.read()
    rows = _parse_annual_nav(raw, file.filename or '')
    if not rows:
        raise HTTPException(400,
            "No valid annual NAV rows found. Expected columns: Year, "
            "Jan 1 NAV, Dec 31 NAV, Contributions, Hurdle Amount, Carry Owed, "
            "accum GP equity in fund.")

    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            upserted = 0
            for r in rows:
                cur.execute("""
                    INSERT INTO fund_annual_snapshots
                        (fund_id, year, start_nav, end_nav, contributions,
                         hurdle_amount, gross_profit, carry_earned,
                         carry_paid, carry_rolled, gp_equity_end)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (fund_id, year) DO UPDATE
                        SET start_nav      = EXCLUDED.start_nav,
                            end_nav        = EXCLUDED.end_nav,
                            contributions  = EXCLUDED.contributions,
                            hurdle_amount  = EXCLUDED.hurdle_amount,
                            gross_profit   = EXCLUDED.gross_profit,
                            carry_earned   = EXCLUDED.carry_earned,
                            carry_paid     = EXCLUDED.carry_paid,
                            carry_rolled   = EXCLUDED.carry_rolled,
                            gp_equity_end  = EXCLUDED.gp_equity_end,
                            updated_at     = NOW()
                """, (fid, r['year'], r['start_nav'], r['end_nav'],
                      r['contributions'], r['hurdle_amount'], r['gross_profit'],
                      r['carry_earned'], r['carry_paid'], r['carry_rolled'],
                      r['gp_equity_end']))
                upserted += 1

        conn.commit()
        years = sorted(r['year'] for r in rows)
        return {
            "fund_id":  fid,
            "imported": upserted,
            "years":    years,
            "message":  f"Imported {upserted} annual NAV rows ({min(years)}–{max(years)}).",
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fund administration — delete
# ---------------------------------------------------------------------------

@app.delete("/api/fund/admin/delete")
async def fund_admin_delete(request: Request, fund_id: str):
    """Permanently delete a fund and all its associated data (cascade)."""
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)
            cur.execute("SELECT name FROM funds WHERE id = %s", (fid,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Fund not found")
            name = row["name"]
            cur.execute("DELETE FROM funds WHERE id = %s", (fid,))
        conn.commit()
        return {"deleted": fid, "name": name}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Admin: deduplicate LP rows (one-shot repair)
# ---------------------------------------------------------------------------

@app.post("/api/fund/admin/dedup-lps")
async def fund_admin_dedup_lps(request: Request, fund_id: str = None):
    """Remove duplicate LP rows that share the same (fund_id, legal_name).

    For each group of duplicates the newest row (highest created_at) is kept.
    Commitments, lp_annual_snapshots, and any other FK rows are re-pointed to
    the survivor before the duplicates are deleted.
    """
    _require_fund_token(request)
    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            if fund_id:
                fid = _resolve_fund_id(cur, fund_id)
                cur.execute("""
                    SELECT fund_id, LOWER(legal_name) AS name_key,
                           array_agg(id ORDER BY created_at DESC) AS ids
                      FROM lps
                     WHERE fund_id = %s
                     GROUP BY fund_id, LOWER(legal_name)
                    HAVING COUNT(*) > 1
                """, (fid,))
            else:
                cur.execute("""
                    SELECT fund_id, LOWER(legal_name) AS name_key,
                           array_agg(id ORDER BY created_at DESC) AS ids
                      FROM lps
                     GROUP BY fund_id, LOWER(legal_name)
                    HAVING COUNT(*) > 1
                """)

            groups = cur.fetchall()
            removed = 0
            for g in groups:
                keeper_id  = str(g["ids"][0])          # newest row survives
                dupe_ids   = [str(x) for x in g["ids"][1:]]

                # Re-point commitments
                cur.execute("""
                    UPDATE commitments SET lp_id = %s
                     WHERE lp_id = ANY(%s::uuid[])
                """, (keeper_id, dupe_ids))

                # Re-point lp_annual_snapshots (if table exists)
                cur.execute("""
                    UPDATE lp_annual_snapshots SET lp_id = %s
                     WHERE lp_id = ANY(%s::uuid[])
                """, (keeper_id, dupe_ids))

                # Delete duplicate LP rows
                cur.execute("""
                    DELETE FROM lps WHERE id = ANY(%s::uuid[])
                """, (dupe_ids,))
                removed += len(dupe_ids)

        conn.commit()
        return {"duplicates_removed": removed,
                "message": f"Removed {removed} duplicate LP row(s)."}
    except Exception as e:
        conn.rollback()
        raise HTTPException(500, str(e))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fund export — Excel workbook
# ---------------------------------------------------------------------------

@app.get("/api/fund/export-excel")
async def fund_export_excel(request: Request, fund_id: str = None):
    """Generate a comprehensive Excel workbook for the fund and return it
    as a downloadable .xlsx file.

    Sheets:
      1. Fund Summary    — key metrics & economics overview
      2. Portfolio       — all positions with live prices & P/L
      3. Limited Partners — LP commitments & current values
      4. Annual Waterfall — year-by-year hurdle / carry / GP equity
      5. Transactions    — recent activity log
    """
    _require_fund_token(request)
    if not _OPENPYXL_OK:
        raise HTTPException(400, "openpyxl not installed on this server")

    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    from fastapi.responses import StreamingResponse

    conn = _fund_conn()
    try:
        with conn.cursor(cursor_factory=_RealDictCursor) as cur:
            fid = _resolve_fund_id(cur, fund_id)

            # ── Fund metadata ─────────────────────────────────────────────────
            cur.execute("""
                SELECT name, short_name, inception_date, status,
                       mgmt_fee_pct, carry_pct, hurdle_pct
                  FROM funds WHERE id = %s
            """, (fid,))
            fund = dict(cur.fetchone())

            # ── Market NAV ────────────────────────────────────────────────────
            nav = _fund_market_nav(cur, fid)

            # ── Positions ─────────────────────────────────────────────────────
            cur.execute("""
                SELECT s.symbol, s.name AS sec_name, s.asset_class,
                       SUM(tl.quantity) AS qty,
                       SUM(tl.quantity * tl.cost_basis_per_unit)
                         / NULLIF(SUM(tl.quantity), 0)  AS avg_cost,
                       SUM(tl.quantity * tl.cost_basis_per_unit) AS cost_basis
                  FROM tax_lots tl
                  JOIN securities s ON s.id = tl.security_id
                 WHERE tl.fund_id = %s AND tl.closed_at IS NULL
                 GROUP BY s.symbol, s.name, s.asset_class
                 ORDER BY SUM(tl.quantity * tl.cost_basis_per_unit) DESC
            """, (fid,))
            positions = [dict(r) for r in cur.fetchall()]
            symbols   = [p['symbol'] for p in positions if p['symbol']]
            prices    = _fetch_prices(symbols)

            # ── LPs ───────────────────────────────────────────────────────────
            cur.execute("""
                SELECT l.legal_name, l.entity_type,
                       COALESCE(SUM(c.commitment_amount), 0) AS commitment
                  FROM lps l
                  LEFT JOIN commitments c ON c.lp_id = l.id AND c.superseded_by IS NULL
                 WHERE l.fund_id = %s AND l.status = 'active'
                 GROUP BY l.id, l.legal_name, l.entity_type
                HAVING COALESCE(SUM(c.commitment_amount), 0) > 0
                 ORDER BY commitment DESC
            """, (fid,))
            lps = [dict(r) for r in cur.fetchall()]
            total_committed = sum(float(lp['commitment']) for lp in lps) or 0.0

            # ── Annual snapshots ──────────────────────────────────────────────
            try:
                cur.execute("""
                    SELECT year, start_nav, end_nav, contributions,
                           hurdle_amount, gross_profit, carry_earned,
                           carry_paid, carry_rolled, gp_equity_end
                      FROM fund_annual_snapshots
                     WHERE fund_id = %s ORDER BY year ASC
                """, (fid,))
                snapshots = [dict(r) for r in cur.fetchall()]
            except Exception:
                snapshots = []

            # ── Recent transactions ───────────────────────────────────────────
            cur.execute("""
                SELECT t.effective_date, t.category, t.description,
                       ROUND(SUM(CASE WHEN tl.debit  > 0 THEN tl.debit  ELSE 0 END), 2) AS total_debit,
                       ROUND(SUM(CASE WHEN tl.credit > 0 THEN tl.credit ELSE 0 END), 2) AS total_credit
                  FROM transactions t
                  JOIN transaction_lines tl ON tl.transaction_id = t.id
                 WHERE t.fund_id = %s
                 GROUP BY t.id, t.effective_date, t.category, t.description
                 ORDER BY t.effective_date DESC
                 LIMIT 200
            """, (fid,))
            txns = [dict(r) for r in cur.fetchall()]

    finally:
        conn.close()

    # ── Build workbook ────────────────────────────────────────────────────────
    wb = openpyxl.Workbook()
    wb.remove(wb.active)   # remove default sheet

    # ── Style helpers ─────────────────────────────────────────────────────────
    NAVY  = '0E1D38'
    GOLD  = 'C9A84C'
    LGRAY = 'F4F6F9'
    WHITE = 'FFFFFF'
    DKGRAY= '444444'
    GREEN = '1A7F40'
    RED   = 'CC3333'

    thin = Side(style='thin', color='CCCCCC')
    bdr  = Border(left=thin, right=thin, top=thin, bottom=thin)

    def fill(hex_color):
        return PatternFill('solid', fgColor=hex_color)

    def hdr_font(size=10, color=GOLD):
        return Font(bold=True, color=color, size=size, name='Calibri')

    def body_font(size=10, bold=False, color=DKGRAY):
        return Font(bold=bold, size=size, color=color, name='Calibri')

    def center():
        return Alignment(horizontal='center', vertical='center')

    def right():
        return Alignment(horizontal='right', vertical='center')

    def apply_row(ws, row_idx, values, formats=None, bg=None, bold=False,
                  font_color=DKGRAY):
        for ci, val in enumerate(values, 1):
            cell = ws.cell(row=row_idx, column=ci, value=val)
            cell.font   = Font(bold=bold, size=10, color=font_color, name='Calibri')
            cell.border = bdr
            if bg:
                cell.fill = fill(bg)
            if formats and ci - 1 < len(formats) and formats[ci - 1]:
                cell.number_format = formats[ci - 1]
                cell.alignment = right()
            else:
                cell.alignment = Alignment(vertical='center', wrap_text=False)

    def write_header(ws, row_idx, cols, bg=NAVY):
        for ci, col in enumerate(cols, 1):
            cell = ws.cell(row=row_idx, column=ci, value=col)
            cell.font      = hdr_font()
            cell.fill      = fill(bg)
            cell.border    = bdr
            cell.alignment = center()
        ws.row_dimensions[row_idx].height = 18

    def auto_width(ws, min_w=10, max_w=40):
        for col in ws.columns:
            best = min_w
            for cell in col:
                try:
                    best = max(best, len(str(cell.value or '')) + 2)
                except Exception:
                    pass
            ws.column_dimensions[get_column_letter(col[0].column)].width = min(best, max_w)

    def section_title(ws, row_idx, text, span):
        cell = ws.cell(row=row_idx, column=1, value=text)
        cell.font      = Font(bold=True, size=11, color=NAVY, name='Calibri')
        cell.fill      = fill('E8F0F8')
        cell.border    = bdr
        cell.alignment = Alignment(horizontal='left', vertical='center')
        ws.merge_cells(start_row=row_idx, start_column=1,
                       end_row=row_idx, end_column=span)
        ws.row_dimensions[row_idx].height = 16

    today_str = datetime.utcnow().strftime('%B %d, %Y')
    FMT_USD   = '$#,##0.00'
    FMT_USD0  = '$#,##0'
    FMT_PCT   = '0.00%'
    FMT_PCT1  = '0.0%'
    FMT_NUM   = '#,##0.##'
    FMT_DATE  = 'YYYY-MM-DD'

    # ── Sheet 1: Fund Summary ─────────────────────────────────────────────────
    ws1 = wb.create_sheet('Fund Summary')
    ws1.sheet_view.showGridLines = False

    # Big title
    t = ws1.cell(row=1, column=1, value=fund['name'])
    t.font = Font(bold=True, size=16, color=NAVY, name='Calibri')
    ws1.merge_cells('A1:D1')
    ws1.row_dimensions[1].height = 28

    sub = ws1.cell(row=2, column=1, value=f'DGA Capital — Fund Report  |  As of {today_str}')
    sub.font = Font(size=10, color='888888', name='Calibri')
    ws1.merge_cells('A2:D2')

    # Fund Information section
    r = 4
    section_title(ws1, r, 'FUND INFORMATION', 4); r += 1
    rows_info = [
        ('Fund Name',       fund['name'],          None, None),
        ('Short Name',      fund['short_name'],     None, None),
        ('Inception Date',  str(fund.get('inception_date', '')), None, None),
        ('Status',          fund.get('status', '').title(), None, None),
    ]
    for label, val, _, __ in rows_info:
        apply_row(ws1, r, [label, val, '', ''], bg=WHITE if r % 2 == 0 else LGRAY)
        ws1.cell(row=r, column=1).font = Font(bold=True, size=10, color=DKGRAY, name='Calibri')
        r += 1

    # Performance section
    r += 1
    section_title(ws1, r, 'PERFORMANCE', 4); r += 1
    total_gain = nav - total_committed
    gain_pct   = (total_gain / total_committed) if total_committed else 0.0
    perf_rows = [
        ('Current NAV (Market Value)',  nav,             FMT_USD0),
        ('Total LP Contributions',      total_committed, FMT_USD0),
        ('Total Fund Gain / (Loss)',    total_gain,      FMT_USD0),
        ('Gain % on Contributions',     gain_pct,        FMT_PCT),
    ]
    for i, (label, val, fmt) in enumerate(perf_rows):
        bg = LGRAY if i % 2 == 0 else WHITE
        apply_row(ws1, r, [label, val, '', ''],
                  formats=[None, fmt, None, None], bg=bg)
        ws1.cell(row=r, column=1).font = Font(bold=True, size=10, color=DKGRAY, name='Calibri')
        vcolor = GREEN if (label == 'Total Fund Gain / (Loss)' and total_gain >= 0) else \
                 RED   if (label == 'Total Fund Gain / (Loss)' and total_gain < 0)  else DKGRAY
        ws1.cell(row=r, column=2).font = Font(bold=True, size=10, color=vcolor, name='Calibri')
        r += 1

    # Economics section
    r += 1
    section_title(ws1, r, 'FUND ECONOMICS', 4); r += 1
    econ_rows = [
        ('Management Fee',   float(fund.get('mgmt_fee_pct', 0)), FMT_PCT),
        ('Carried Interest', float(fund.get('carry_pct', 0)),    FMT_PCT),
        ('Hurdle Rate',      float(fund.get('hurdle_pct', 0)),   FMT_PCT),
    ]
    for i, (label, val, fmt) in enumerate(econ_rows):
        bg = LGRAY if i % 2 == 0 else WHITE
        apply_row(ws1, r, [label, val, '', ''],
                  formats=[None, fmt, None, None], bg=bg)
        ws1.cell(row=r, column=1).font = Font(bold=True, size=10, color=DKGRAY, name='Calibri')
        r += 1

    # Overview section
    r += 1
    section_title(ws1, r, 'PORTFOLIO OVERVIEW', 4); r += 1
    total_cost = sum(float(p['cost_basis'] or 0) for p in positions)
    total_mktval = sum(
        float(p['qty'] or 0) * (prices.get(p['symbol']) or float(p['avg_cost'] or 0))
        for p in positions
    )
    ov_rows = [
        ('Number of LPs',           len(lps),           None),
        ('Number of Positions',     len(positions),      None),
        ('Total Cost Basis',        total_cost,          FMT_USD0),
        ('Total Market Value',      total_mktval,        FMT_USD0),
        ('Unrealized P/L',          total_mktval - total_cost, FMT_USD0),
    ]
    for i, (label, val, fmt) in enumerate(ov_rows):
        bg = LGRAY if i % 2 == 0 else WHITE
        fmts = [None, fmt, None, None] if fmt else None
        apply_row(ws1, r, [label, val, '', ''], formats=fmts, bg=bg)
        ws1.cell(row=r, column=1).font = Font(bold=True, size=10, color=DKGRAY, name='Calibri')
        r += 1

    ws1.column_dimensions['A'].width = 28
    ws1.column_dimensions['B'].width = 22
    ws1.column_dimensions['C'].width = 18
    ws1.column_dimensions['D'].width = 18

    # ── Sheet 2: Portfolio Positions ─────────────────────────────────────────
    ws2 = wb.create_sheet('Portfolio Positions')
    ws2.sheet_view.showGridLines = False
    ws2.freeze_panes = 'A2'

    pos_cols = ['Symbol', 'Security Name', 'Asset Class', 'Shares',
                'Avg Cost', 'Cost Basis', 'Last Price', 'Market Value',
                'Unrealized P/L', 'P/L %', 'Weight %']
    write_header(ws2, 1, pos_cols)

    total_mv   = 0.0
    total_cb   = 0.0
    total_unrl = 0.0
    for i, p in enumerate(positions):
        qty      = float(p['qty'] or 0)
        avg_cost = float(p['avg_cost'] or 0)
        cb       = float(p['cost_basis'] or 0)
        last     = prices.get(p['symbol']) or avg_cost
        mv       = qty * last
        unrl     = mv - cb
        pl_pct   = (unrl / cb) if cb else 0.0
        wt_pct   = (mv / nav) if nav else 0.0
        total_mv   += mv
        total_cb   += cb
        total_unrl += unrl
        bg = WHITE if i % 2 == 0 else LGRAY
        vals  = [p['symbol'], p['sec_name'], p['asset_class'],
                 qty, avg_cost, cb, last, mv, unrl, pl_pct, wt_pct]
        fmts  = [None, None, None, FMT_NUM,
                 FMT_USD, FMT_USD0, FMT_USD, FMT_USD0,
                 FMT_USD0, FMT_PCT1, FMT_PCT1]
        apply_row(ws2, i + 2, vals, formats=fmts, bg=bg)
        pl_c = ws2.cell(row=i + 2, column=9)
        pl_c.font = Font(size=10, color=GREEN if unrl >= 0 else RED, name='Calibri')

    # Totals row
    tr = len(positions) + 2
    totals = ['TOTAL', '', '', '', '', total_cb, '', total_mv, total_unrl, '', '']
    apply_row(ws2, tr, totals,
              formats=[None, None, None, None, None, FMT_USD0, None,
                       FMT_USD0, FMT_USD0, None, None],
              bg=NAVY, bold=True, font_color=GOLD)

    auto_width(ws2)
    ws2.column_dimensions['B'].width = 38

    # ── Sheet 3: Limited Partners ─────────────────────────────────────────────
    ws3 = wb.create_sheet('Limited Partners')
    ws3.sheet_view.showGridLines = False
    ws3.freeze_panes = 'A2'

    lp_cols = ['LP Name', 'Entity Type', 'Commitment ($)',
               'Current Value ($)', 'NAV Share %']
    write_header(ws3, 1, lp_cols)

    for i, lp in enumerate(lps):
        cmt   = float(lp['commitment'])
        share = (cmt / total_committed) if total_committed else 0.0
        cur_v = nav * share
        bg = WHITE if i % 2 == 0 else LGRAY
        apply_row(ws3, i + 2,
                  [lp['legal_name'], lp.get('entity_type', '').title(), cmt, cur_v, share],
                  formats=[None, None, FMT_USD0, FMT_USD0, FMT_PCT],
                  bg=bg)

    if lps:
        tr3 = len(lps) + 2
        apply_row(ws3, tr3,
                  ['TOTAL', '', total_committed, nav, 1.0],
                  formats=[None, None, FMT_USD0, FMT_USD0, FMT_PCT],
                  bg=NAVY, bold=True, font_color=GOLD)

    auto_width(ws3)
    ws3.column_dimensions['A'].width = 30

    # ── Sheet 4: Annual Waterfall ─────────────────────────────────────────────
    if snapshots:
        ws4 = wb.create_sheet('Annual Waterfall')
        ws4.sheet_view.showGridLines = False
        ws4.freeze_panes = 'A2'

        wf_cols = ['Year', 'Jan 1 NAV', 'Dec 31 NAV', 'Contributions',
                   'Hurdle Amount', 'Gross Profit', 'Carry Earned',
                   'Carry Rolled', 'GP Equity (Year End)', 'Accum GP %']
        write_header(ws4, 1, wf_cols)

        for i, s in enumerate(snapshots):
            end_nav  = float(s['end_nav'] or 0)
            gp_eq    = float(s['gp_equity_end'] or 0)
            accum_pct = (gp_eq / end_nav) if end_nav else 0.0
            bg = WHITE if i % 2 == 0 else LGRAY
            apply_row(ws4, i + 2,
                      [s['year'],
                       float(s['start_nav']),   float(s['end_nav']),
                       float(s['contributions']), float(s['hurdle_amount']),
                       float(s['gross_profit']),  float(s['carry_earned']),
                       float(s['carry_rolled']),  gp_eq,
                       accum_pct],
                      formats=[None, FMT_USD0, FMT_USD0, FMT_USD0,
                               FMT_USD0, FMT_USD0, FMT_USD0,
                               FMT_USD0, FMT_USD0, FMT_PCT1],
                      bg=bg)
            carry_c = ws4.cell(row=i + 2, column=7)
            carry_c.font = Font(size=10, name='Calibri',
                                color=GREEN if float(s['carry_earned']) > 0 else DKGRAY)

        auto_width(ws4)

    # ── Sheet 5: Transaction History ─────────────────────────────────────────
    ws5 = wb.create_sheet('Transaction History')
    ws5.sheet_view.showGridLines = False
    ws5.freeze_panes = 'A2'

    tx_cols = ['Date', 'Category', 'Description', 'Debit', 'Credit']
    write_header(ws5, 1, tx_cols)

    for i, t in enumerate(txns):
        bg = WHITE if i % 2 == 0 else LGRAY
        apply_row(ws5, i + 2,
                  [str(t['effective_date']),
                   str(t.get('category', '') or '').replace('_', ' ').title(),
                   t.get('description', '') or '',
                   float(t.get('total_debit', 0) or 0),
                   float(t.get('total_credit', 0) or 0)],
                  formats=[None, None, None, FMT_USD0, FMT_USD0],
                  bg=bg)

    auto_width(ws5)
    ws5.column_dimensions['C'].width = 40

    # ── Freeze, set tab colors ────────────────────────────────────────────────
    ws1.sheet_properties.tabColor = GOLD
    for ws in [ws2, ws3, ws5]:
        ws.sheet_properties.tabColor = NAVY

    # ── Output ────────────────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    safe = fund.get('short_name', 'Fund').replace('/', '-').replace('\\', '-')
    fname = f"{safe}_Report_{datetime.utcnow().strftime('%Y%m%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': f'attachment; filename="{fname}"'},
    )


# ---------------------------------------------------------------------------
# Static web UI — mount last so API routes take precedence.
# ---------------------------------------------------------------------------

@app.middleware("http")
async def no_cache_shell_middleware(request: Request, call_next):
    """Force the browser to re-fetch the HTML/CSS/JS shell on every request.

    Railway redeploys don't change the file URL, so default browser caching
    (which can keep static files for hours) would leave users staring at
    the previous build. We want the shell *itself* to refresh so the
    ``?v=`` pins on the CSS/JS tags get honored.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/app/") or path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        # Stop Railway's edge layer / Cloudflare from caching the shell
        response.headers["Surrogate-Control"] = "no-store"
        response.headers["CDN-Cache-Control"] = "no-store"
    return response


if BRANDING_DIR.exists():
    app.mount("/branding", StaticFiles(directory=str(BRANDING_DIR)), name="branding")

if WEB_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
