"""
SEC EDGAR XBRL Data Fetcher
----------------------------
Pulls clean, filing-accurate financial data from the SEC EDGAR XBRL
companyfacts + submissions APIs and maps US-GAAP tags to a canonical set
of metrics used by the DGA research report.

Data sources (all free, no API key):
  - https://www.sec.gov/files/company_tickers.json          (ticker -> CIK map)
  - https://data.sec.gov/submissions/CIK{10-digit}.json    (filing history)
  - https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit}.json  (XBRL facts)

Design notes on mapping accuracy:
  * Revenue has several tags. We try them in priority order and keep the one
    that actually has data for the target period.
  * Income-statement facts have a DURATION (start..end). For quarterly
    filings we must pick 3-month durations (~88-95 days) to avoid YTD
    numbers bleeding in. For annuals we pick ~365 day durations flagged
    fp=FY on a 10-K.
  * Balance-sheet facts are INSTANT (end only). We pick the value whose
    `end` date matches the target period-end most closely.
  * We cross-reference `accn` (accession number) with the latest 10-K / 10-Q
    filings from the submissions feed to make sure we are reading the
    number *as reported in that filing*.
"""

from __future__ import annotations

import json
import os
import time
from datetime import date, datetime, timedelta
from typing import Any, Iterable

import requests


# SEC requires an identifying User-Agent for automated access.
# See: https://www.sec.gov/os/accessing-edgar-data
#
# We read it from SEC_USER_AGENT at call time so nothing PII-related is
# hard-coded in source. Callers can also pass `user_agent=...` explicitly.
def _resolve_user_agent(user_agent: str | None) -> str:
    if user_agent:
        return user_agent
    env_val = os.environ.get("SEC_USER_AGENT", "").strip()
    if env_val:
        return env_val
    raise RuntimeError(
        "SEC requires an identifying User-Agent. "
        "Set SEC_USER_AGENT in your environment (or .env), e.g. "
        "SEC_USER_AGENT='Your Name your.email@example.com', "
        "or pass user_agent=... to this function."
    )

BASE_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
BASE_COMPANYFACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"


# ---------------------------------------------------------------------------
# Tag priority lists (higher = preferred). These cover ~95% of US filers.
# ---------------------------------------------------------------------------
TAG_PRIORITIES: dict[str, list[str]] = {
    "Revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet",
    ],
    "CostOfRevenue": [
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
        "CostOfServices",
    ],
    "GrossProfit": [
        "GrossProfit",
    ],
    "OperatingIncome": [
        "OperatingIncomeLoss",
    ],
    "NetIncome": [
        "NetIncomeLoss",
        "ProfitLoss",
        "NetIncomeLossAvailableToCommonStockholdersBasic",
    ],
    "DilutedEPS": [
        "EarningsPerShareDiluted",
        "IncomeLossFromContinuingOperationsPerDilutedShare",
    ],
    "BasicEPS": [
        "EarningsPerShareBasic",
    ],
    "OperatingCashFlow": [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "CapEx": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ],
    "Cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "Cash",
    ],
    "ShortTermInvestments": [
        "ShortTermInvestments",
        "MarketableSecuritiesCurrent",
    ],
    "TotalAssets": [
        "Assets",
    ],
    "TotalLiabilities": [
        "Liabilities",
    ],
    "StockholdersEquity": [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    "LongTermDebt": [
        "LongTermDebtNoncurrent",
        "LongTermDebt",
    ],
    "ShortTermDebt": [
        "ShortTermBorrowings",
        "LongTermDebtCurrent",
        "DebtCurrent",
    ],
    "TotalDebt": [
        # Some filers tag this directly; otherwise we derive it.
        "LongTermDebtAndCapitalLeaseObligations",
        "DebtLongtermAndShorttermCombinedAmount",
    ],
    "DilutedShares": [
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ],
    "SharesOutstanding": [
        "CommonStockSharesOutstanding",
        "EntityCommonStockSharesOutstanding",
    ],
    "Dividends": [
        "PaymentsOfDividendsCommonStock",
        "PaymentsOfDividends",
    ],
    "BuybacksCash": [
        "PaymentsForRepurchaseOfCommonStock",
    ],
    "RnD": [
        "ResearchAndDevelopmentExpense",
    ],
    "DepreciationAmortization": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAndAmortization",
        "Depreciation",
        "DepreciationAmortizationAndAccretionNet",
    ],
}

# Tags that are balance-sheet (instant period) vs income-statement (duration).
BALANCE_SHEET_KEYS = {
    "Cash",
    "ShortTermInvestments",
    "TotalAssets",
    "TotalLiabilities",
    "StockholdersEquity",
    "LongTermDebt",
    "ShortTermDebt",
    "TotalDebt",
    "SharesOutstanding",
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _session(user_agent: str | None = None) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": _resolve_user_agent(user_agent),
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Host": None,  # will be overridden per request
    })
    return s


def _get_json(sess: requests.Session, url: str, *, retries: int = 3) -> dict:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            resp = sess.get(url, timeout=30)
            if resp.status_code == 200:
                result = resp.json()
                if not isinstance(result, dict):
                    raise ValueError(
                        f"SEC API returned {type(result).__name__} instead of dict "
                        f"from {url}: {str(result)[:200]}"
                    )
                return result
            if resp.status_code == 429:
                # SEC is rate-limiting us.
                time.sleep(1.5 * (attempt + 1))
                continue
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"SEC request failed after {retries} retries: {url} ({last_err})")


# ---------------------------------------------------------------------------
# Ticker -> CIK resolver
# ---------------------------------------------------------------------------
_TICKER_CACHE: dict[str, str] = {}


def resolve_cik(ticker: str, user_agent: str | None = None) -> str:
    """Return the 10-digit zero-padded CIK for a ticker (e.g. 'AAPL' -> '0000320193')."""
    t = ticker.strip().upper()
    if t in _TICKER_CACHE:
        return _TICKER_CACHE[t]

    sess = _session(user_agent)
    data = _get_json(sess, TICKER_MAP_URL)
    # data is {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
    for entry in data.values():
        if entry.get("ticker", "").upper() == t:
            cik = f"{int(entry['cik_str']):010d}"
            _TICKER_CACHE[t] = cik
            return cik
    raise ValueError(
        f"Ticker '{ticker}' not found in SEC ticker map. "
        "Foreign issuers (ADRs) may not file XBRL; try the underlying CIK."
    )


# ---------------------------------------------------------------------------
# Pull latest filings & raw company facts
# ---------------------------------------------------------------------------
def fetch_submissions(cik: str, user_agent: str | None = None) -> dict:
    sess = _session(user_agent)
    return _get_json(sess, BASE_SUBMISSIONS.format(cik=cik))


def fetch_company_facts(cik: str, user_agent: str | None = None) -> dict:
    sess = _session(user_agent)
    return _get_json(sess, BASE_COMPANYFACTS.format(cik=cik))


def latest_filings(submissions: dict) -> dict[str, dict]:
    """
    Return the latest 10-K and latest 10-Q filing metadata from submissions.

    Structure returned:
        {
            "10-K": {"accession": "0000320193-24-000123", "filed": "2024-11-01",
                     "reportDate": "2024-09-28", "primaryDocument": "..."},
            "10-Q": {...},
        }
    """
    recent = submissions.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    acc_nos = recent.get("accessionNumber", [])
    filed = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])
    primary_docs = recent.get("primaryDocument", [])

    out: dict[str, dict] = {}
    for i, form in enumerate(forms):
        if form in ("10-K", "10-Q") and form not in out:
            out[form] = {
                "accession": acc_nos[i] if i < len(acc_nos) else "",
                "filed": filed[i] if i < len(filed) else "",
                "reportDate": report_dates[i] if i < len(report_dates) else "",
                "primaryDocument": primary_docs[i] if i < len(primary_docs) else "",
            }
        if "10-K" in out and "10-Q" in out:
            break
    return out


def filing_url(cik: str, accession: str, primary_doc: str = "") -> str:
    acc_nodash = accession.replace("-", "")
    if primary_doc:
        return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_nodash}/{primary_doc}"
    return f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-K&dateb=&owner=include&count=40"


# ---------------------------------------------------------------------------
# Fact extraction
# ---------------------------------------------------------------------------
def _days(start: str, end: str) -> int:
    try:
        s = datetime.strptime(start, "%Y-%m-%d").date()
        e = datetime.strptime(end, "%Y-%m-%d").date()
        return (e - s).days
    except Exception:
        return -1


def _iter_facts(companyfacts: dict, tag: str, unit_preference: Iterable[str]) -> list[dict]:
    """Return flat list of fact entries for a us-gaap tag, annotated with unit."""
    us_gaap = companyfacts.get("facts", {}).get("us-gaap", {})
    entry = us_gaap.get(tag)
    if not entry:
        return []
    units = entry.get("units", {})
    for u in unit_preference:
        if u in units:
            return [{**row, "_unit": u, "_tag": tag} for row in units[u]]
    # Fallback: return first unit found.
    for u, rows in units.items():
        return [{**row, "_unit": u, "_tag": tag} for row in rows]
    return []


def _pick_annual(facts: list[dict], fy: int) -> dict | None:
    """Pick a FY fact from a 10-K for the given fiscal year, ~365-day duration."""
    candidates: list[dict] = []
    for row in facts:
        if row.get("form") != "10-K":
            continue
        if row.get("fp") != "FY":
            continue
        if row.get("fy") != fy:
            continue
        dur = _days(row.get("start", ""), row.get("end", ""))
        # FY durations are ~360-371 days (leap years / 52/53 week filers).
        if 340 <= dur <= 380 or dur == -1:
            candidates.append(row)
    if not candidates:
        return None
    # Prefer the most recently-filed version (amended 10-Ks).
    candidates.sort(key=lambda r: r.get("filed", ""), reverse=True)
    return candidates[0]


def _pick_annual_instant(facts: list[dict], fy: int) -> dict | None:
    """Pick a balance-sheet instant for the target FY (latest end date in that FY)."""
    candidates = [
        r for r in facts
        if r.get("form") == "10-K" and r.get("fy") == fy and r.get("fp") == "FY"
    ]
    if not candidates:
        # Some filers only tag instants on 10-Qs in a given fiscal year.
        candidates = [
            r for r in facts if r.get("fy") == fy and r.get("fp") == "FY"
        ]
    if not candidates:
        return None
    candidates.sort(key=lambda r: (r.get("end", ""), r.get("filed", "")), reverse=True)
    return candidates[0]


def _pick_quarter_duration(
    facts: list[dict],
    fy: int,
    fp: str,
    *,
    max_duration_days: int = 100,
) -> dict | None:
    """Pick a 3-month duration for a specific quarter from a 10-Q."""
    candidates: list[dict] = []
    for row in facts:
        if row.get("form") != "10-Q":
            continue
        if row.get("fy") != fy or row.get("fp") != fp:
            continue
        dur = _days(row.get("start", ""), row.get("end", ""))
        if 80 <= dur <= max_duration_days:
            candidates.append(row)
    if not candidates:
        # Fallback: accept without form filter (some filers use 10-K/A for Q4).
        for row in facts:
            if row.get("fy") != fy or row.get("fp") != fp:
                continue
            dur = _days(row.get("start", ""), row.get("end", ""))
            if 80 <= dur <= max_duration_days:
                candidates.append(row)
    if not candidates:
        return None
    candidates.sort(key=lambda r: r.get("filed", ""), reverse=True)
    return candidates[0]


def _pick_ytd(facts: list[dict], fy: int, fp: str) -> dict | None:
    """Pick the YTD duration for a given quarter (6mo for Q2, 9mo for Q3, 3mo for Q1)."""
    target_days = {"Q1": 90, "Q2": 180, "Q3": 270}.get(fp, None)
    if target_days is None:
        return None
    best: dict | None = None
    best_delta = 10**9
    for row in facts:
        if row.get("form") != "10-Q":
            continue
        if row.get("fy") != fy or row.get("fp") != fp:
            continue
        dur = _days(row.get("start", ""), row.get("end", ""))
        if dur <= 0:
            continue
        delta = abs(dur - target_days)
        # Accept within ±15 days of target YTD duration.
        if delta <= 15 and delta < best_delta:
            best = row
            best_delta = delta
    return best


def _pick_instant_near(facts: list[dict], target_end: str) -> dict | None:
    """For balance-sheet items, find the instant whose end date is closest to target."""
    if not facts:
        return None
    try:
        t = datetime.strptime(target_end, "%Y-%m-%d").date()
    except Exception:
        return None
    best: dict | None = None
    best_delta = 10**9
    for row in facts:
        end = row.get("end", "")
        if not end:
            continue
        try:
            e = datetime.strptime(end, "%Y-%m-%d").date()
        except Exception:
            continue
        delta = abs((e - t).days)
        # Latest amendment wins on ties.
        if delta < best_delta or (delta == best_delta and row.get("filed", "") > (best or {}).get("filed", "")):
            best = row
            best_delta = delta
    return best


def _first_hit(
    companyfacts: dict,
    keys: list[str],
    picker,
    unit_pref: Iterable[str] = ("USD",),
) -> tuple[dict | None, str | None]:
    """Try each candidate tag until one yields a fact via `picker`."""
    for tag in keys:
        facts = _iter_facts(companyfacts, tag, unit_pref)
        if not facts:
            continue
        hit = picker(facts)
        if hit is not None:
            return hit, tag
    return None, None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def extract_financials(
    ticker: str,
    user_agent: str | None = None,
) -> dict[str, Any]:
    """
    Main entrypoint. Returns a structured dict used by the report builder:

        {
          "ticker": "AAPL",
          "cik": "0000320193",
          "entity_name": "Apple Inc.",
          "latest_filings": {...},
          "latest_filing_type": "10-Q",
          "annuals": [
              {"fy": 2024, "end": "2024-09-28", "revenue": 391.0e9, ...},
              ...
          ],
          "quarterly": {
              "current":  {"fy":2025,"fp":"Q1","end":"2024-12-28","revenue":..., ...},
              "prior_year_same_q": {...},
              "current_ytd": {...},
              "prior_ytd": {...},
          },
          "errors": [...],
        }
    """
    cik = resolve_cik(ticker, user_agent=user_agent)
    submissions = fetch_submissions(cik, user_agent=user_agent)
    if not isinstance(submissions, dict):
        raise ValueError(
            f"SEC submissions API returned {type(submissions).__name__} for {ticker} "
            f"(CIK {cik}); expected dict."
        )
    facts = fetch_company_facts(cik, user_agent=user_agent)
    if not isinstance(facts, dict):
        raise ValueError(
            f"SEC companyfacts API returned {type(facts).__name__} for {ticker} "
            f"(CIK {cik}); expected dict."
        )
    latest = latest_filings(submissions)

    # Determine most recent filing (by filed date).
    latest_filing_type = "10-K"
    if "10-Q" in latest and "10-K" in latest:
        latest_filing_type = (
            "10-Q" if latest["10-Q"]["filed"] > latest["10-K"]["filed"] else "10-K"
        )
    elif "10-Q" in latest:
        latest_filing_type = "10-Q"

    errors: list[str] = []

    # ---------- Annuals (last 3 FYs from latest 10-K) ----------
    annuals: list[dict[str, Any]] = []
    # Find the set of FYs we have annual Revenue data for.
    rev_facts_all = _iter_facts(facts, TAG_PRIORITIES["Revenue"][0], ("USD",))
    # Combine with every Revenue alt to find all FY years we can cover.
    all_rev_rows: list[dict] = []
    for tag in TAG_PRIORITIES["Revenue"]:
        all_rev_rows.extend(_iter_facts(facts, tag, ("USD",)))
    fys_with_data = sorted(
        {
            r["fy"]
            for r in all_rev_rows
            if r.get("form") == "10-K" and r.get("fp") == "FY" and r.get("fy")
        },
        reverse=True,
    )[:3]

    for fy in fys_with_data:
        row: dict[str, Any] = {"fy": fy}
        # Duration facts
        for metric in (
            "Revenue",
            "CostOfRevenue",
            "GrossProfit",
            "OperatingIncome",
            "NetIncome",
            "OperatingCashFlow",
            "CapEx",
            "Dividends",
            "BuybacksCash",
            "RnD",
            "DepreciationAmortization",
        ):
            hit, tag = _first_hit(
                facts,
                TAG_PRIORITIES[metric],
                lambda f: _pick_annual(f, fy),
            )
            if hit:
                row[metric] = hit["val"]
                row.setdefault("_tags", {})[metric] = tag
                row["end"] = hit.get("end", row.get("end", ""))
                row["start"] = hit.get("start", row.get("start", ""))
                row["accession"] = hit.get("accn", row.get("accession", ""))
                row["filed"] = hit.get("filed", row.get("filed", ""))
        # Derive GrossProfit from Revenue - CostOfRevenue when the tag is absent.
        if "GrossProfit" not in row and row.get("Revenue") and row.get("CostOfRevenue"):
            row["GrossProfit"] = row["Revenue"] - row["CostOfRevenue"]
        # EPS (share units)
        eps_hit, eps_tag = _first_hit(
            facts,
            TAG_PRIORITIES["DilutedEPS"],
            lambda f: _pick_annual(f, fy),
            unit_pref=("USD/shares",),
        )
        if eps_hit:
            row["DilutedEPS"] = eps_hit["val"]
            row.setdefault("_tags", {})["DilutedEPS"] = eps_tag
        # Diluted share count
        ds_hit, _ = _first_hit(
            facts,
            TAG_PRIORITIES["DilutedShares"],
            lambda f: _pick_annual(f, fy),
            unit_pref=("shares",),
        )
        if ds_hit:
            row["DilutedShares"] = ds_hit["val"]
        # Balance-sheet items at fiscal-year end
        target_end = row.get("end", "")
        for metric in (
            "Cash",
            "ShortTermInvestments",
            "TotalAssets",
            "TotalLiabilities",
            "StockholdersEquity",
            "LongTermDebt",
            "ShortTermDebt",
            "TotalDebt",
        ):
            hit, tag = _first_hit(
                facts,
                TAG_PRIORITIES[metric],
                lambda f: _pick_instant_near(f, target_end) if target_end else None,
            )
            if hit:
                row[metric] = hit["val"]
                row.setdefault("_tags", {})[metric] = tag
        # Derive Total Debt if missing.
        if "TotalDebt" not in row:
            ltd = row.get("LongTermDebt", 0) or 0
            std = row.get("ShortTermDebt", 0) or 0
            if ltd or std:
                row["TotalDebt"] = ltd + std
        # FCF = OCF - CapEx
        if "OperatingCashFlow" in row and "CapEx" in row:
            row["FreeCashFlow"] = row["OperatingCashFlow"] - row["CapEx"]
        # Margins
        rev = row.get("Revenue")
        if rev and row.get("GrossProfit") is not None:
            row["GrossMargin"] = row["GrossProfit"] / rev
        if rev and row.get("OperatingIncome") is not None:
            row["OperatingMargin"] = row["OperatingIncome"] / rev
        if rev and row.get("NetIncome") is not None:
            row["NetMargin"] = row["NetIncome"] / rev
        # EBITDA = OperatingIncome + D&A (derived; EBITDA is non-GAAP)
        if row.get("OperatingIncome") is not None and row.get("DepreciationAmortization"):
            row["EBITDA"] = row["OperatingIncome"] + row["DepreciationAmortization"]
            if rev:
                row["EBITDAMargin"] = row["EBITDA"] / rev
        annuals.append(row)

    # ---------- Quarterly (latest 10-Q) ----------
    quarterly: dict[str, Any] = {}
    if latest_filing_type == "10-Q" and "10-Q" in latest:
        # We need to figure out fy/fp of the latest 10-Q. The simplest way:
        # look at Revenue facts filed in this accession.
        latest_q_accn = latest["10-Q"]["accession"]
        latest_q_end = latest["10-Q"]["reportDate"]
        cur_fy: int | None = None
        cur_fp: str | None = None
        for tag in TAG_PRIORITIES["Revenue"]:
            for row in _iter_facts(facts, tag, ("USD",)):
                if row.get("accn") == latest_q_accn and row.get("end") == latest_q_end:
                    dur = _days(row.get("start", ""), row.get("end", ""))
                    if 80 <= dur <= 100:
                        cur_fy = row.get("fy")
                        cur_fp = row.get("fp")
                        break
            if cur_fy and cur_fp:
                break
        if cur_fy and cur_fp:
            quarterly["current"] = _build_quarter_row(facts, cur_fy, cur_fp, is_ytd=False)
            # Prior-year same quarter
            quarterly["prior_year_same_q"] = _build_quarter_row(
                facts, cur_fy - 1, cur_fp, is_ytd=False
            )
            # YTD current + prior (only meaningful for Q2+)
            if cur_fp in ("Q2", "Q3"):
                quarterly["current_ytd"] = _build_quarter_row(
                    facts, cur_fy, cur_fp, is_ytd=True
                )
                quarterly["prior_ytd"] = _build_quarter_row(
                    facts, cur_fy - 1, cur_fp, is_ytd=True
                )
            quarterly["meta"] = {
                "fy": cur_fy,
                "fp": cur_fp,
                "reportDate": latest_q_end,
                "accession": latest_q_accn,
                "filed": latest["10-Q"]["filed"],
            }
        else:
            errors.append(
                "Could not determine fiscal period for latest 10-Q; "
                "quarterly section will be skipped."
            )

    # ---------- Latest price context (filled externally by caller) ----------
    return {
        "ticker": ticker.upper(),
        "cik": cik,
        "entity_name": submissions.get("name", ticker.upper()),
        "latest_filings": latest,
        "latest_filing_type": latest_filing_type,
        "annuals": annuals,
        "quarterly": quarterly,
        "errors": errors,
    }


def _build_quarter_row(facts: dict, fy: int, fp: str, *, is_ytd: bool) -> dict[str, Any]:
    row: dict[str, Any] = {"fy": fy, "fp": fp, "ytd": is_ytd}
    picker = (lambda f: _pick_ytd(f, fy, fp)) if is_ytd else (lambda f: _pick_quarter_duration(f, fy, fp))
    for metric in (
        "Revenue",
        "CostOfRevenue",
        "GrossProfit",
        "OperatingIncome",
        "NetIncome",
        "OperatingCashFlow",
        "CapEx",
        "DepreciationAmortization",
    ):
        hit, tag = _first_hit(facts, TAG_PRIORITIES[metric], picker)
        if hit:
            row[metric] = hit["val"]
            row.setdefault("_tags", {})[metric] = tag
            row["end"] = hit.get("end", row.get("end", ""))
            row["start"] = hit.get("start", row.get("start", ""))
    if "GrossProfit" not in row and row.get("Revenue") and row.get("CostOfRevenue"):
        row["GrossProfit"] = row["Revenue"] - row["CostOfRevenue"]
    eps_hit, eps_tag = _first_hit(
        facts, TAG_PRIORITIES["DilutedEPS"], picker, unit_pref=("USD/shares",)
    )
    if eps_hit:
        row["DilutedEPS"] = eps_hit["val"]
    # Balance-sheet at period end (quarter-end)
    if row.get("end"):
        target_end = row["end"]
        for metric in ("Cash", "LongTermDebt", "ShortTermDebt", "TotalDebt",
                       "TotalAssets", "TotalLiabilities", "StockholdersEquity"):
            hit, tag = _first_hit(
                facts,
                TAG_PRIORITIES[metric],
                lambda f: _pick_instant_near(f, target_end),
            )
            if hit:
                row[metric] = hit["val"]
        if "TotalDebt" not in row:
            ltd = row.get("LongTermDebt", 0) or 0
            std = row.get("ShortTermDebt", 0) or 0
            if ltd or std:
                row["TotalDebt"] = ltd + std
    if "OperatingCashFlow" in row and "CapEx" in row:
        row["FreeCashFlow"] = row["OperatingCashFlow"] - row["CapEx"]
    rev = row.get("Revenue")
    if rev and row.get("GrossProfit") is not None:
        row["GrossMargin"] = row["GrossProfit"] / rev
    if rev and row.get("OperatingIncome") is not None:
        row["OperatingMargin"] = row["OperatingIncome"] / rev
    if rev and row.get("NetIncome") is not None:
        row["NetMargin"] = row["NetIncome"] / rev
    if row.get("OperatingIncome") is not None and row.get("DepreciationAmortization"):
        row["EBITDA"] = row["OperatingIncome"] + row["DepreciationAmortization"]
        if rev:
            row["EBITDAMargin"] = row["EBITDA"] / rev
    return row


# ---------------------------------------------------------------------------
# Human-readable "verified data" block for the LLM system prompt
# ---------------------------------------------------------------------------
def _fmt_money(val) -> str:
    if val is None or val == "" or val == "N/A":
        return "N/A"
    try:
        m = float(val) / 1_000_000
        return f"{m:,.1f}"
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


def format_verified_block(data: dict) -> str:
    """Produce the VERIFIED_FINANCIAL_DATA text block the LLM must use."""
    lines: list[str] = []
    lines.append(f"=== VERIFIED FINANCIAL DATA FOR {data['ticker']} ===")
    lines.append(f"Entity: {data['entity_name']} (CIK {data['cik']})")
    lines.append(f"LATEST_FILING_TYPE: {data['latest_filing_type']}")

    latest = data.get("latest_filings", {})
    if "10-K" in latest:
        k = latest["10-K"]
        lines.append(f"Latest 10-K: filed {k['filed']}, reportDate {k['reportDate']}, accession {k['accession']}")
        lines.append(f"  URL: {filing_url(data['cik'], k['accession'], k.get('primaryDocument',''))}")
    if "10-Q" in latest:
        q = latest["10-Q"]
        lines.append(f"Latest 10-Q: filed {q['filed']}, reportDate {q['reportDate']}, accession {q['accession']}")
        lines.append(f"  URL: {filing_url(data['cik'], q['accession'], q.get('primaryDocument',''))}")

    # Annual table
    lines.append("")
    lines.append("[ANNUAL DATA - from latest 10-K filings, $ in millions unless noted]")
    header = ["FY", "PeriodEnd", "Revenue", "GrossProfit", "GrossMargin%",
              "EBITDA", "EBITDAMargin%", "OpInc", "OpMargin%",
              "NetInc", "NetMargin%", "DilEPS", "OCF", "CapEx", "FCF",
              "Cash", "TotalDebt", "TotalAssets", "Equity"]
    lines.append(" | ".join(header))
    for row in data.get("annuals", []):
        lines.append(" | ".join([
            f"FY{row.get('fy','')}",
            str(row.get("end", "")),
            _fmt_money(row.get("Revenue")),
            _fmt_money(row.get("GrossProfit")),
            _fmt_pct(row.get("GrossMargin")),
            _fmt_money(row.get("EBITDA")),
            _fmt_pct(row.get("EBITDAMargin")),
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

    # Quarterly table
    quarterly = data.get("quarterly", {})
    if quarterly.get("current"):
        lines.append("")
        lines.append("[QUARTERLY DATA - from latest 10-Q, $ in millions unless noted]")
        lines.append("Period | FY | FP | PeriodEnd | Revenue | GrossProfit | GrossMargin% | EBITDA | EBITDAMargin% | OpInc | OpMargin% | NetInc | NetMargin% | DilEPS | OCF | FCF")
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
                _fmt_money(q.get("GrossProfit")),
                _fmt_pct(q.get("GrossMargin")),
                _fmt_money(q.get("EBITDA")),
                _fmt_pct(q.get("EBITDAMargin")),
                _fmt_money(q.get("OperatingIncome")),
                _fmt_pct(q.get("OperatingMargin")),
                _fmt_money(q.get("NetIncome")),
                _fmt_pct(q.get("NetMargin")),
                _fmt_eps(q.get("DilutedEPS")),
                _fmt_money(q.get("OperatingCashFlow")),
                _fmt_money(q.get("FreeCashFlow")),
            ]))

    if data.get("errors"):
        lines.append("")
        lines.append("NOTES / CAVEATS:")
        for e in data["errors"]:
            lines.append(f" - {e}")

    lines.append("")
    lines.append(
        "Instruction: use ONLY these numbers for all tables and calculations. "
        "GrossProfit may be derived (Revenue - CostOfRevenue) if not directly tagged. "
        "EBITDA is always derived (OperatingIncome + D&A) and is non-GAAP. "
        "If a cell is 'N/A', write 'N/A' — do NOT write a long disclaimer phrase."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("ticker")
    ap.add_argument(
        "--ua",
        default=None,
        help="SEC User-Agent override (defaults to SEC_USER_AGENT env var).",
    )
    ap.add_argument("--json-out", help="Write raw extracted dict to this path")
    args = ap.parse_args()

    result = extract_financials(args.ticker, user_agent=args.ua)
    print(format_verified_block(result))
    if args.json_out:
        def _default(o):
            if isinstance(o, (date, datetime)):
                return o.isoformat()
            return str(o)
        with open(args.json_out, "w") as f:
            json.dump(result, f, indent=2, default=_default)
        print(f"\nWrote extracted data to {args.json_out}")
