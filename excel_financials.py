"""
excel_financials.py
-------------------
Read the per-ticker Excel workbooks produced by `pull_sec_financials.py`
and produce the canonical `data` dict consumed by the DGA report
pipeline (format_verified_block + word report rendering).

Why this module exists
----------------------
Earlier versions of the pipeline pulled financials from SEC's
`companyfacts` JSON API. For some filers (notably AYI) that feed has
fiscal-year labels that don't line up with the reported period-end —
which caused the annual table to shift by 2 years and the YTD columns
to duplicate each other.

The Excel workbooks come from edgartools' XBRL statement parser,
which reads the XBRL *instance document* attached to each filing.
The columns therefore reflect the filing's own period contexts:
  * 10-K Income Statement: 3 FY columns (e.g. "2025-08-31 (FY)")
  * 10-K Balance Sheet:    2 FY-end columns (current + prior year end)
  * 10-K Cash Flow:        3 FY columns
  * 10-Q Income Statement: 4 cols  — Q current, Q prior, YTD current, YTD prior
  * 10-Q Balance Sheet:    2 cols  — current quarter end + most-recent FY end
  * 10-Q Cash Flow:        2 cols  — YTD current, YTD prior  (NO 3-mo CF)

Public API
----------
    data = extract_financials(ticker, stock_financials_dir=None)
    text = format_verified_block(data)

Output shape matches sec_edgar_xbrl.extract_financials:
    {
      "ticker": ..., "entity_name": ..., "cik": "",
      "latest_filings": {"10-K": {...}, "10-Q": {...}},
      "latest_filing_type": "10-Q" | "10-K",
      "annuals": [ {"fy": 2025, "end": "2025-08-31", "Revenue": ..., ...}, ...],
      "quarterly": {
          "current":            {"fy":2026,"fp":"Q2","end":"2026-02-28", ...},
          "prior_year_same_q":  {"fy":2025,"fp":"Q2","end":"2025-02-28", ...},
          "current_ytd":        {...},
          "prior_ytd":          {...},
          "meta": {"fy":2026,"fp":"Q2","reportDate":"2026-02-28", ...},
      },
      "errors": [...],
      "source": "excel_xbrl",
    }
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Optional

import pandas as pd


_PROJECT_ROOT = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# Tag priorities (mirrors sec_edgar_xbrl.TAG_PRIORITIES; normalized to the
# "us-gaap_" prefix used in the Excel files' `concept` column).
# ---------------------------------------------------------------------------
def _p(names: list[str]) -> list[str]:
    return [f"us-gaap_{n}" for n in names]


CONCEPT_PRIORITIES: dict[str, list[str]] = {
    "Revenue": _p([
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet",
    ]),
    "CostOfRevenue": _p([
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
        "CostOfServices",
    ]),
    "GrossProfit": _p(["GrossProfit"]),
    "OperatingIncome": _p(["OperatingIncomeLoss"]),
    "NetIncome": _p([
        "NetIncomeLoss",
        "ProfitLoss",
        "NetIncomeLossAvailableToCommonStockholdersBasic",
    ]),
    "DilutedEPS": _p([
        "EarningsPerShareDiluted",
        "IncomeLossFromContinuingOperationsPerDilutedShare",
    ]),
    "BasicEPS": _p(["EarningsPerShareBasic"]),
    "OperatingCashFlow": _p([
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ]),
    "CapEx": _p([
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ]),
    "Cash": _p([
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "Cash",
    ]),
    "ShortTermInvestments": _p([
        "ShortTermInvestments",
        "MarketableSecuritiesCurrent",
    ]),
    "TotalAssets": _p(["Assets"]),
    "TotalLiabilities": _p(["Liabilities"]),
    "StockholdersEquity": _p([
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ]),
    "LongTermDebt": _p([
        "LongTermDebtNoncurrent",
        "LongTermDebt",
    ]),
    "ShortTermDebt": _p([
        "ShortTermBorrowings",
        "LongTermDebtCurrent",
        "DebtCurrent",
    ]),
    "TotalDebt": _p([
        "LongTermDebtAndCapitalLeaseObligations",
        "DebtLongtermAndShorttermCombinedAmount",
    ]),
    "DilutedShares": _p(["WeightedAverageNumberOfDilutedSharesOutstanding"]),
    "SharesOutstanding": _p([
        "CommonStockSharesOutstanding",
        "EntityCommonStockSharesOutstanding",
    ]),
    "Dividends": _p([
        "PaymentsOfDividendsCommonStock",
        "PaymentsOfDividends",
    ]),
    "BuybacksCash": _p(["PaymentsForRepurchaseOfCommonStock"]),
    "RnD": _p(["ResearchAndDevelopmentExpense"]),
}

# Statements where each metric is expected to live.
IS_METRICS = {
    "Revenue", "CostOfRevenue", "GrossProfit", "OperatingIncome",
    "NetIncome", "DilutedEPS", "BasicEPS", "DilutedShares",
    "SharesOutstanding", "RnD",
}
CF_METRICS = {"OperatingCashFlow", "CapEx", "Dividends", "BuybacksCash"}
BS_METRICS = {
    "Cash", "ShortTermInvestments", "TotalAssets", "TotalLiabilities",
    "StockholdersEquity", "LongTermDebt", "ShortTermDebt", "TotalDebt",
}


# ---------------------------------------------------------------------------
# Directory helpers
# ---------------------------------------------------------------------------
def _default_stock_dir() -> Path:
    raw = os.environ.get("STOCK_FINANCIALS_DIR", "").strip() or "stock-financials"
    p = Path(raw)
    if not p.is_absolute():
        p = _PROJECT_ROOT / p
    return p


def _resolve_workbooks(ticker: str, base_dir: Optional[Path]) -> dict[str, Path]:
    """Return {"10-K": path, "10-Q": path} for files that actually exist."""
    base = (base_dir or _default_stock_dir()).resolve()
    tkr = ticker.strip().upper()
    out: dict[str, Path] = {}
    for form, slug in (("10-K", "10K"), ("10-Q", "10Q")):
        candidate = base / tkr / f"{tkr}_{slug}_Financials.xlsx"
        if candidate.exists():
            out[form] = candidate
    return out


# ---------------------------------------------------------------------------
# Column parsing
# ---------------------------------------------------------------------------
_COL_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:\s*\(([^)]+)\))?$")


def _parse_period_column(col: str) -> Optional[dict[str, str]]:
    """
    Parse a header like "2025-08-31 (FY)", "2026-02-28 (Q2)",
    "2026-02-28 (YTD)", or bare "2025-08-31" (balance-sheet instant).
    """
    if not isinstance(col, str):
        return None
    m = _COL_RE.match(col.strip())
    if not m:
        return None
    end, tag = m.group(1), (m.group(2) or "").strip().upper()
    kind = "INSTANT"
    fp = ""
    if tag == "FY":
        kind, fp = "DURATION", "FY"
    elif tag == "YTD":
        kind, fp = "YTD", "YTD"
    elif re.fullmatch(r"Q[1-4]", tag or ""):
        kind, fp = "DURATION", tag
    elif tag == "":
        kind, fp = "INSTANT", ""
    else:
        # unknown tag — still return but flagged
        kind, fp = "OTHER", tag
    return {"end": end, "fp": fp, "kind": kind, "raw": col}


def _period_columns(df: pd.DataFrame) -> list[dict[str, str]]:
    return [p for c in df.columns for p in [_parse_period_column(c)] if p]


# ---------------------------------------------------------------------------
# Value picker
# ---------------------------------------------------------------------------
def _pick_value(
    df: pd.DataFrame,
    concepts: Iterable[str],
    column: str,
) -> Optional[float]:
    """
    Find the value for the first concept (in priority order) that has a
    non-null, non-breakdown, non-abstract row with data in `column`.
    """
    if df is None or df.empty or column not in df.columns:
        return None
    # Vectorized filter: the "total" row for a concept is abstract=False &
    # is_breakdown=False & dimension=False (no segment dim). We also accept
    # dimension=False alone in case is_breakdown is absent.
    mask = pd.Series([True] * len(df))
    for col_name in ("abstract",):
        if col_name in df.columns:
            mask &= (df[col_name] == False)  # noqa: E712
    for col_name in ("is_breakdown",):
        if col_name in df.columns:
            mask &= (df[col_name] == False)  # noqa: E712
    if "dimension" in df.columns:
        mask &= (df["dimension"] == False)  # noqa: E712

    filt = df[mask]

    for concept in concepts:
        matches = filt[filt["concept"] == concept]
        if matches.empty:
            continue
        for val in matches[column].tolist():
            if pd.notna(val):
                try:
                    return float(val)
                except (TypeError, ValueError):
                    continue
    return None


def _pick_value_with_tag(
    df: pd.DataFrame,
    concepts: Iterable[str],
    column: str,
) -> tuple[Optional[float], Optional[str]]:
    """Same as _pick_value but also returns the winning concept tag."""
    if df is None or df.empty or column not in df.columns:
        return None, None
    mask = pd.Series([True] * len(df))
    for col_name in ("abstract",):
        if col_name in df.columns:
            mask &= (df[col_name] == False)  # noqa: E712
    for col_name in ("is_breakdown",):
        if col_name in df.columns:
            mask &= (df[col_name] == False)  # noqa: E712
    if "dimension" in df.columns:
        mask &= (df["dimension"] == False)  # noqa: E712
    filt = df[mask]
    for concept in concepts:
        matches = filt[filt["concept"] == concept]
        if matches.empty:
            continue
        for val in matches[column].tolist():
            if pd.notna(val):
                try:
                    return float(val), concept
                except (TypeError, ValueError):
                    continue
    return None, None


# ---------------------------------------------------------------------------
# Metadata sheet helper
# ---------------------------------------------------------------------------
def _read_metadata(xl_path: Path) -> dict[str, str]:
    try:
        mdf = pd.read_excel(xl_path, sheet_name="Metadata")
    except Exception:
        return {}
    out: dict[str, str] = {}
    if "Field" in mdf.columns and "Value" in mdf.columns:
        for _, row in mdf.iterrows():
            k = str(row["Field"]).strip()
            v = row["Value"]
            if pd.isna(v):
                out[k] = ""
                continue
            # pandas reads date-only columns as Timestamp w/ 00:00:00 suffix.
            if isinstance(v, (pd.Timestamp, datetime)):
                out[k] = v.strftime("%Y-%m-%d")
            elif isinstance(v, date):
                out[k] = v.isoformat()
            else:
                s = str(v).strip()
                # Trim trailing " 00:00:00" from string-form timestamps
                if len(s) == 19 and s.endswith(" 00:00:00"):
                    s = s[:10]
                out[k] = s
    return out


def _read_sheet(xl_path: Path, sheet: str) -> Optional[pd.DataFrame]:
    try:
        return pd.read_excel(xl_path, sheet_name=sheet)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Row builders
# ---------------------------------------------------------------------------
def _derive_fy_from_end(end_iso: str, fy_end_iso: Optional[str]) -> Optional[int]:
    """
    Given a period-end date string and the most-recent FY-end date,
    decide which fiscal year that period belongs to.

    Rule: if `end` falls after the FY anniversary month-day, it's in FY
    (year_of_end + 1); otherwise it's in FY year_of_end.

    Example: FY ends Aug 31. A quarter ending 2026-02-28 (before Aug 31)
    belongs to fiscal year ending 2026-08-31 → FY 2026.
    """
    try:
        end = datetime.strptime(end_iso, "%Y-%m-%d").date()
    except Exception:
        return None
    if not fy_end_iso:
        return end.year
    try:
        fy = datetime.strptime(fy_end_iso, "%Y-%m-%d").date()
    except Exception:
        return end.year
    # The fiscal year label is the calendar year of the FY-end date.
    # Find the FY that contains `end`: roll fy backward in 1-yr steps until
    # fy >= end, then fy.year is the label.
    # Start from the known fy-end year of `end`:
    candidate_year = end.year
    # construct FY-end for candidate_year using fy_end month/day
    try:
        candidate = date(candidate_year, fy.month, fy.day)
    except ValueError:
        candidate = date(candidate_year, fy.month, 28)
    if end > candidate:
        candidate_year += 1
    return candidate_year


def _build_period_row(
    is_df: Optional[pd.DataFrame],
    bs_df: Optional[pd.DataFrame],
    cf_df: Optional[pd.DataFrame],
    *,
    is_col: Optional[str],
    bs_col: Optional[str],
    cf_col: Optional[str],
    end: str,
    fy: Optional[int],
    fp: str,
    ytd: bool = False,
) -> dict[str, Any]:
    """Collect all metrics into one row for a given period context."""
    row: dict[str, Any] = {
        "fy": fy,
        "fp": fp,
        "end": end,
        "ytd": ytd,
    }
    tags: dict[str, str] = {}

    # Income-statement metrics
    if is_df is not None and is_col:
        for metric in IS_METRICS:
            v, tag = _pick_value_with_tag(is_df, CONCEPT_PRIORITIES[metric], is_col)
            if v is not None:
                row[metric] = v
                if tag:
                    tags[metric] = tag

    # Cash-flow metrics
    # edgartools signs outflow concepts as negative. The downstream pipeline
    # expects CapEx / Dividends / Buybacks as *positive magnitudes* (outflow
    # amount), matching the companyfacts convention. Normalize here.
    OUTFLOW_METRICS = {"CapEx", "Dividends", "BuybacksCash"}
    if cf_df is not None and cf_col:
        for metric in CF_METRICS:
            v, tag = _pick_value_with_tag(cf_df, CONCEPT_PRIORITIES[metric], cf_col)
            if v is not None:
                if metric in OUTFLOW_METRICS:
                    v = abs(v)
                row[metric] = v
                if tag:
                    tags[metric] = tag

    # Balance-sheet metrics
    if bs_df is not None and bs_col:
        for metric in BS_METRICS:
            v, tag = _pick_value_with_tag(bs_df, CONCEPT_PRIORITIES[metric], bs_col)
            if v is not None:
                row[metric] = v
                if tag:
                    tags[metric] = tag
        # Derive TotalDebt if absent
        if "TotalDebt" not in row:
            ltd = row.get("LongTermDebt", 0) or 0
            std = row.get("ShortTermDebt", 0) or 0
            if ltd or std:
                row["TotalDebt"] = ltd + std

    # Derive FCF / margins
    if "OperatingCashFlow" in row and "CapEx" in row:
        row["FreeCashFlow"] = row["OperatingCashFlow"] - row["CapEx"]
    if row.get("Revenue") and row.get("OperatingIncome") is not None:
        row["OperatingMargin"] = row["OperatingIncome"] / row["Revenue"]
    if row.get("Revenue") and row.get("NetIncome") is not None:
        row["NetMargin"] = row["NetIncome"] / row["Revenue"]

    if tags:
        row["_tags"] = tags
    return row


# ---------------------------------------------------------------------------
# Main extractor
# ---------------------------------------------------------------------------
def extract_financials(
    ticker: str,
    stock_financials_dir: Optional[Path] = None,
) -> dict[str, Any]:
    tkr = ticker.strip().upper()
    books = _resolve_workbooks(tkr, stock_financials_dir)

    errors: list[str] = []
    if not books:
        raise FileNotFoundError(
            f"No SEC XBRL Excel files found for {tkr}. Expected at "
            f"{(stock_financials_dir or _default_stock_dir()).resolve() / tkr}/. "
            "Run pull_sec_financials.py first."
        )

    latest_filings: dict[str, dict] = {}
    entity_name = tkr

    # ---------- Annuals from 10-K ----------
    annuals: list[dict[str, Any]] = []
    k10_path = books.get("10-K")
    k10_meta: dict[str, str] = {}
    if k10_path:
        k10_meta = _read_metadata(k10_path)
        entity_name = k10_meta.get("Company") or entity_name
        latest_filings["10-K"] = {
            "accession": k10_meta.get("Accession Number", ""),
            "filed": k10_meta.get("Filing Date", ""),
            "reportDate": k10_meta.get("Period Of Report", ""),
            "primaryDocument": "",
        }
        is_df = _read_sheet(k10_path, "Income Statement")
        bs_df = _read_sheet(k10_path, "Balance Sheet")
        cf_df = _read_sheet(k10_path, "Cash Flow Statement")

        # FY columns (duration) across IS/CF
        fy_cols_is = [p for p in _period_columns(is_df if is_df is not None else pd.DataFrame())
                      if p["fp"] == "FY"]
        fy_cols_cf = [p for p in _period_columns(cf_df if cf_df is not None else pd.DataFrame())
                      if p["fp"] == "FY"]
        bs_cols = [p for p in _period_columns(bs_df if bs_df is not None else pd.DataFrame())
                   if p["kind"] == "INSTANT"]

        # Sort descending so the latest FY is first.
        fy_cols_is.sort(key=lambda p: p["end"], reverse=True)
        for fp in fy_cols_is:
            end = fp["end"]
            # Match CF column on exact end; else None
            cf_col = next((c["raw"] for c in fy_cols_cf if c["end"] == end), None)
            # BS: find the instant whose date == this FY end, else nearest <=
            bs_col = None
            if bs_cols:
                exact = [c for c in bs_cols if c["end"] == end]
                if exact:
                    bs_col = exact[0]["raw"]
            fy_year = _derive_fy_from_end(end, end)  # FY label = year of end
            row = _build_period_row(
                is_df, bs_df, cf_df,
                is_col=fp["raw"], bs_col=bs_col, cf_col=cf_col,
                end=end, fy=fy_year, fp="FY", ytd=False,
            )
            row["accession"] = k10_meta.get("Accession Number", "")
            row["filed"] = k10_meta.get("Filing Date", "")
            annuals.append(row)

    # ---------- Quarterly from 10-Q ----------
    quarterly: dict[str, Any] = {}
    q10_path = books.get("10-Q")
    if q10_path:
        q10_meta = _read_metadata(q10_path)
        if not entity_name or entity_name == tkr:
            entity_name = q10_meta.get("Company") or entity_name
        latest_filings["10-Q"] = {
            "accession": q10_meta.get("Accession Number", ""),
            "filed": q10_meta.get("Filing Date", ""),
            "reportDate": q10_meta.get("Period Of Report", ""),
            "primaryDocument": "",
        }
        is_df = _read_sheet(q10_path, "Income Statement")
        bs_df = _read_sheet(q10_path, "Balance Sheet")
        cf_df = _read_sheet(q10_path, "Cash Flow Statement")

        is_cols = _period_columns(is_df if is_df is not None else pd.DataFrame())
        cf_cols = _period_columns(cf_df if cf_df is not None else pd.DataFrame())
        bs_cols = [p for p in _period_columns(bs_df if bs_df is not None else pd.DataFrame())
                   if p["kind"] == "INSTANT"]

        # Quarterly durations (Q1/Q2/Q3/Q4) sorted latest-first
        q_cols = [p for p in is_cols if p["fp"] in ("Q1", "Q2", "Q3", "Q4")]
        q_cols.sort(key=lambda p: p["end"], reverse=True)

        ytd_cols = [p for p in is_cols if p["fp"] == "YTD"]
        ytd_cols.sort(key=lambda p: p["end"], reverse=True)

        fy_end_iso = k10_meta.get("Period Of Report") if k10_meta else None

        if q_cols:
            current_q = q_cols[0]
            prior_q = q_cols[1] if len(q_cols) > 1 else None

            cur_fy = _derive_fy_from_end(current_q["end"], fy_end_iso)
            cur_fp = current_q["fp"]

            # BS column closest to the current Q end
            bs_cur = None
            if bs_cols:
                exact = [c for c in bs_cols if c["end"] == current_q["end"]]
                if exact:
                    bs_cur = exact[0]["raw"]

            # Build current quarter row (3-month; no CF since 10-Q CF is YTD-only)
            quarterly["current"] = _build_period_row(
                is_df, bs_df, cf_df,
                is_col=current_q["raw"], bs_col=bs_cur, cf_col=None,
                end=current_q["end"], fy=cur_fy, fp=cur_fp, ytd=False,
            )
            # Prior-year same quarter (no BS — 10-Q only carries current Q + prior FY end)
            if prior_q:
                prior_fy = cur_fy - 1 if cur_fy else None
                quarterly["prior_year_same_q"] = _build_period_row(
                    is_df, bs_df, cf_df,
                    is_col=prior_q["raw"], bs_col=None, cf_col=None,
                    end=prior_q["end"], fy=prior_fy, fp=cur_fp, ytd=False,
                )

            # YTD rows (IS + CF aligned by end date)
            if ytd_cols:
                cur_ytd = next((c for c in ytd_cols if c["end"] == current_q["end"]), ytd_cols[0])
                prior_ytd = next(
                    (c for c in ytd_cols if prior_q and c["end"] == prior_q["end"]),
                    ytd_cols[1] if len(ytd_cols) > 1 else None,
                )
                cf_ytd_cur = next((c["raw"] for c in cf_cols
                                   if c["fp"] == "YTD" and c["end"] == cur_ytd["end"]), None)
                quarterly["current_ytd"] = _build_period_row(
                    is_df, bs_df, cf_df,
                    is_col=cur_ytd["raw"], bs_col=bs_cur, cf_col=cf_ytd_cur,
                    end=cur_ytd["end"], fy=cur_fy, fp=cur_fp, ytd=True,
                )
                if prior_ytd:
                    cf_ytd_prior = next((c["raw"] for c in cf_cols
                                         if c["fp"] == "YTD" and c["end"] == prior_ytd["end"]),
                                        None)
                    prior_fy = cur_fy - 1 if cur_fy else None
                    quarterly["prior_ytd"] = _build_period_row(
                        is_df, bs_df, cf_df,
                        is_col=prior_ytd["raw"], bs_col=None, cf_col=cf_ytd_prior,
                        end=prior_ytd["end"], fy=prior_fy, fp=cur_fp, ytd=True,
                    )

            quarterly["meta"] = {
                "fy": cur_fy,
                "fp": cur_fp,
                "reportDate": current_q["end"],
                "accession": q10_meta.get("Accession Number", ""),
                "filed": q10_meta.get("Filing Date", ""),
            }
        else:
            errors.append(
                "10-Q income statement did not expose a 3-month quarterly column; "
                "latest quarterly section omitted."
            )

    # ---------- Which filing is latest? ----------
    latest_filing_type = "10-K"
    if "10-Q" in latest_filings and "10-K" in latest_filings:
        q_filed = latest_filings["10-Q"].get("filed", "")
        k_filed = latest_filings["10-K"].get("filed", "")
        if q_filed and k_filed and q_filed > k_filed:
            latest_filing_type = "10-Q"
        elif q_filed and not k_filed:
            latest_filing_type = "10-Q"
    elif "10-Q" in latest_filings:
        latest_filing_type = "10-Q"

    return {
        "ticker": tkr,
        "cik": "",
        "entity_name": entity_name,
        "latest_filings": latest_filings,
        "latest_filing_type": latest_filing_type,
        "annuals": annuals,
        "quarterly": quarterly,
        "errors": errors,
        "source": "excel_xbrl",
    }


# ---------------------------------------------------------------------------
# Verified-data text block (mirrors sec_edgar_xbrl.format_verified_block)
# ---------------------------------------------------------------------------
def _fmt_money(val) -> str:
    if val is None or val == "" or val == "N/A":
        return "N/A"
    try:
        return f"{float(val) / 1_000_000:,.1f}"
    except Exception:
        return str(val)


def _fmt_pct(val) -> str:
    if val is None or val == "":
        return "N/A"
    try:
        return f"{float(val) * 100:.1f}%"
    except Exception:
        return "N/A"


def _fmt_eps(val) -> str:
    if val is None or val == "":
        return "N/A"
    try:
        return f"{float(val):.2f}"
    except Exception:
        return "N/A"


def _filing_url(cik: str, accession: str, primary_doc: str = "") -> str:
    if not accession:
        return ""
    acc_nodash = accession.replace("-", "")
    cik_int = int(cik) if (cik and cik.isdigit()) else 0
    if primary_doc and cik_int:
        return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{primary_doc}"
    if cik_int:
        return f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-K&dateb=&owner=include&count=40"
    return f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&action=getcompany&accession_number={accession}"


def format_verified_block(data: dict) -> str:
    lines: list[str] = []
    lines.append(f"=== VERIFIED FINANCIAL DATA FOR {data['ticker']} ===")
    lines.append(f"Entity: {data.get('entity_name','')} (source: SEC EDGAR XBRL)")
    lines.append(f"LATEST_FILING_TYPE: {data.get('latest_filing_type','')}")

    latest = data.get("latest_filings", {})
    if "10-K" in latest:
        k = latest["10-K"]
        lines.append(
            f"Latest 10-K: filed {k.get('filed','')}, reportDate "
            f"{k.get('reportDate','')}, accession {k.get('accession','')}"
        )
    if "10-Q" in latest:
        q = latest["10-Q"]
        lines.append(
            f"Latest 10-Q: filed {q.get('filed','')}, reportDate "
            f"{q.get('reportDate','')}, accession {q.get('accession','')}"
        )

    lines.append("")
    lines.append("[ANNUAL DATA - from latest 10-K, $ in millions unless noted]")
    header = ["FY", "PeriodEnd", "Revenue", "GrossProfit", "OpInc", "OpMargin%",
              "NetInc", "NetMargin%", "DilEPS", "OCF", "CapEx", "FCF",
              "Cash", "TotalDebt", "TotalAssets", "Equity"]
    lines.append(" | ".join(header))
    for row in data.get("annuals", []):
        lines.append(" | ".join([
            f"FY{row.get('fy','')}",
            str(row.get("end", "")),
            _fmt_money(row.get("Revenue")),
            _fmt_money(row.get("GrossProfit")),
            _fmt_money(row.get("OperatingIncome")),
            _fmt_pct(row.get("OperatingMargin")),
            _fmt_money(row.get("NetIncome")),
            _fmt_pct(row.get("NetMargin")),
            _fmt_eps(row.get("DilutedEPS")),
            _fmt_money(row.get("OperatingCashFlow")),
            _fmt_money(row.get("CapEx")),
            _fmt_money(row.get("FreeCashFlow")),
            _fmt_money(row.get("Cash")),
            _fmt_money(row.get("TotalDebt")),
            _fmt_money(row.get("TotalAssets")),
            _fmt_money(row.get("StockholdersEquity")),
        ]))

    quarterly = data.get("quarterly", {})
    if quarterly.get("current"):
        lines.append("")
        lines.append("[QUARTERLY DATA - from latest 10-Q, $ in millions unless noted]")
        lines.append(
            "Period | FY | FP | PeriodEnd | Revenue | OpInc | OpMargin% | "
            "NetInc | NetMargin% | DilEPS | OCF | FCF"
        )
        labels = [
            ("Latest Quarter (3mo)", quarterly.get("current")),
            ("Same Q Prior Year (3mo)", quarterly.get("prior_year_same_q")),
            ("Current YTD", quarterly.get("current_ytd")),
            ("Prior YTD", quarterly.get("prior_ytd")),
        ]
        for label, q in labels:
            if not q:
                continue
            lines.append(" | ".join([
                label,
                f"FY{q.get('fy','')}",
                q.get("fp", ""),
                str(q.get("end", "")),
                _fmt_money(q.get("Revenue")),
                _fmt_money(q.get("OperatingIncome")),
                _fmt_pct(q.get("OperatingMargin")),
                _fmt_money(q.get("NetIncome")),
                _fmt_pct(q.get("NetMargin")),
                _fmt_eps(q.get("DilutedEPS")),
                _fmt_money(q.get("OperatingCashFlow")),
                _fmt_money(q.get("FreeCashFlow")),
            ]))
        lines.append(
            "Note: 10-Q Cash Flow statements report YTD only (no 3-month breakdown), "
            "so 'Latest Quarter' OCF/FCF may be blank. Use the YTD rows for cash metrics."
        )

    if data.get("errors"):
        lines.append("")
        lines.append("NOTES / CAVEATS:")
        for e in data["errors"]:
            lines.append(f" - {e}")

    lines.append("")
    lines.append(
        "Instruction: use ONLY these numbers for all tables and calculations. "
        "If a cell is 'N/A', write: 'Data not available in verified filing - please "
        "check latest 10-K/10-Q'."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(
        description="Read per-ticker SEC EDGAR Excel workbooks and emit the "
                    "verified-data text block used by the DGA report prompt.",
    )
    ap.add_argument("ticker")
    ap.add_argument("--dir", default=None, help="Override STOCK_FINANCIALS_DIR.")
    ap.add_argument("--json-out", default=None, help="Also write raw dict here.")
    args = ap.parse_args()

    result = extract_financials(
        args.ticker,
        stock_financials_dir=Path(args.dir).resolve() if args.dir else None,
    )
    print(format_verified_block(result))
    if args.json_out:
        def _default(o):
            if isinstance(o, (date, datetime)):
                return o.isoformat()
            return str(o)
        Path(args.json_out).write_text(
            json.dumps(result, indent=2, default=_default),
            encoding="utf-8",
        )
        print(f"\nWrote raw data → {args.json_out}")
