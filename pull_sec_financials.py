"""
pull_sec_financials.py
----------------------
Download the latest 10-K and 10-Q XBRL financial statements from SEC EDGAR
and save them as two Excel files (one per filing), with a sheet for each
primary financial statement (Income Statement, Balance Sheet, Cash Flow
Statement) plus a Metadata sheet.

Uses the `edgartools` library, which parses the actual XBRL instance
document from the filing itself — so columns reflect the *filing context*
(not the companyfacts JSON, which can lag or relabel fiscal years).

Usage
-----
Command line:
    python3 pull_sec_financials.py AYI
    python3 pull_sec_financials.py AAPL --out-dir stock-financials

Programmatic:
    from pull_sec_financials import download_financials
    paths = download_financials("AYI")
    # paths = {"10-K": Path(...), "10-Q": Path(...)}

Configuration (read from environment; .env in the same directory is
auto-loaded at import time):
    SEC_USER_AGENT          Required. e.g. "Jane Doe jane@example.com"
    STOCK_FINANCIALS_DIR    Optional. Defaults to "stock-financials".
                            Resolved relative to the project root
                            (the directory that contains this file).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd


# ---------------------------------------------------------------------------
# .env loading (optional python-dotenv, else minimal built-in parser)
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    """Load .env sitting next to this file into os.environ (no-overwrite)."""
    env_path = _PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    # Prefer python-dotenv if available.
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv(env_path, override=False)
        return
    except Exception:
        pass
    # Minimal fallback parser: KEY=VALUE per line, ignores comments/blank lines.
    try:
        with env_path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception:
        pass


_load_dotenv()


# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------
def get_sec_user_agent() -> str:
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    if not ua:
        raise RuntimeError(
            "SEC_USER_AGENT is not set. Add it to your .env file or export it. "
            "Format: 'Your Name your.email@example.com'."
        )
    return ua


def get_stock_financials_dir() -> Path:
    """
    Return the directory where per-ticker Excel folders are stored.

    Honors STOCK_FINANCIALS_DIR (relative paths resolved against this file's
    directory). Defaults to `<project_root>/stock-financials`.
    """
    raw = os.environ.get("STOCK_FINANCIALS_DIR", "").strip() or "stock-financials"
    p = Path(raw)
    if not p.is_absolute():
        p = _PROJECT_ROOT / p
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------
# Edgar identity setup (lazy — only when we actually make a request)
# ---------------------------------------------------------------------------
_edgar_ready = False


def _init_edgar() -> None:
    global _edgar_ready
    if _edgar_ready:
        return
    try:
        from edgar import set_identity  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "The 'edgartools' package is required. Install it with:\n"
            "    pip3 install edgartools"
        ) from exc
    set_identity(get_sec_user_agent())
    _edgar_ready = True


# ---------------------------------------------------------------------------
# Core per-filing processor
# ---------------------------------------------------------------------------
def _to_dataframe(statement) -> Optional[pd.DataFrame]:
    """Safely call .to_dataframe() on an edgartools statement object."""
    if statement is None:
        return None
    try:
        return statement.to_dataframe()
    except Exception:
        return None


def _extract_statements(xbrl) -> dict[str, pd.DataFrame]:
    """Return {sheet_name: dataframe} for IS / BS / CF."""
    statements = xbrl.statements
    out: dict[str, pd.DataFrame] = {}

    inc = None
    try:
        inc = statements.income_statement()
    except Exception:
        pass
    df = _to_dataframe(inc)
    if df is not None:
        out["Income Statement"] = df

    bs = None
    try:
        bs = statements.balance_sheet()
    except Exception:
        pass
    df = _to_dataframe(bs)
    if df is not None:
        out["Balance Sheet"] = df

    cf = None
    for attr in ("cashflow_statement", "cash_flow_statement"):
        try:
            cf = getattr(statements, attr)()
            if cf is not None:
                break
        except Exception:
            continue
    df = _to_dataframe(cf)
    if df is not None:
        out["Cash Flow Statement"] = df

    return out


def _process_filing(company, form_type: str, output_path: Path, ticker: str) -> Optional[Path]:
    """Process one filing (10-K or 10-Q) and write its Excel workbook."""
    print(f"  📄 Pulling latest {form_type}...")
    try:
        filings = company.get_filings(form=form_type)
        if not filings:
            print(f"     No {form_type} filings found for {ticker}.")
            return None
        latest = filings.latest()
        print(f"     Filing date: {latest.filing_date} | Accession: "
              f"{getattr(latest, 'accession_number', 'N/A')}")

        xbrl = latest.xbrl()
        if not xbrl:
            print(f"     No XBRL available for this {form_type}.")
            return None

        financial_data = _extract_statements(xbrl)
        if not financial_data:
            print(f"     Could not extract any financial statements from {form_type}.")
            return None

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
            for sheet_name, df in financial_data.items():
                df.to_excel(writer, sheet_name=sheet_name[:31], index=False)
            meta_df = pd.DataFrame({
                "Field": [
                    "Ticker",
                    "Company",
                    "Report Type",
                    "Filing Date",
                    "Accession Number",
                    "Period Of Report",
                    "Generated On",
                ],
                "Value": [
                    ticker,
                    getattr(company, "name", ticker),
                    form_type,
                    str(getattr(latest, "filing_date", "")),
                    getattr(latest, "accession_number", "N/A"),
                    str(getattr(latest, "period_of_report", "")),
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                ],
            })
            meta_df.to_excel(writer, sheet_name="Metadata", index=False)

        print(f"     ✅ Saved {form_type} → {output_path.name} "
              f"({len(financial_data)} statements + Metadata)")
        return output_path

    except Exception as exc:  # noqa: BLE001
        print(f"     ❌ Error processing {form_type}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def download_financials(
    ticker: str,
    out_dir: Optional[Path] = None,
    *,
    forms: tuple[str, ...] = ("10-K", "10-Q"),
) -> dict[str, Path]:
    """
    Download the latest 10-K and/or 10-Q XBRL financials as Excel files.

    Returns a dict mapping form_type ("10-K", "10-Q") to the output Path.
    Forms for which no filing / XBRL could be obtained are omitted.
    """
    _init_edgar()
    from edgar import Company  # type: ignore

    tkr = ticker.strip().upper()
    if not tkr:
        raise ValueError("ticker cannot be empty.")

    base_dir = (out_dir or get_stock_financials_dir()).resolve()
    ticker_dir = base_dir / tkr
    ticker_dir.mkdir(parents=True, exist_ok=True)

    print(f"🔍 Fetching SEC EDGAR XBRL financials for {tkr}...")
    print(f"   Output folder: {ticker_dir}")

    company = Company(tkr)

    results: dict[str, Path] = {}
    for form_type in forms:
        slug = form_type.replace("-", "").replace("/", "")  # 10-K -> 10K
        out_path = ticker_dir / f"{tkr}_{slug}_Financials.xlsx"
        saved = _process_filing(company, form_type, out_path, tkr)
        if saved:
            results[form_type] = saved

    if not results:
        print(f"⚠️  Nothing saved for {tkr}. Check ticker, SEC connectivity, and "
              f"your SEC_USER_AGENT in .env.")
    else:
        print(f"✅ Done. {len(results)} Excel file(s) saved in {ticker_dir}")

    return results


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------
def _parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Download the latest 10-K + 10-Q XBRL financials from "
                    "SEC EDGAR into per-ticker Excel workbooks.",
    )
    ap.add_argument("ticker", help="Company ticker (e.g. AAPL, AYI, TSLA).")
    ap.add_argument(
        "--out-dir",
        default=None,
        help="Base output directory. Overrides STOCK_FINANCIALS_DIR / default.",
    )
    ap.add_argument(
        "--only",
        choices=["10-K", "10-Q", "both"],
        default="both",
        help="Which filing(s) to pull. Defaults to both.",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    out_dir = Path(args.out_dir).resolve() if args.out_dir else None
    forms: tuple[str, ...]
    if args.only == "10-K":
        forms = ("10-K",)
    elif args.only == "10-Q":
        forms = ("10-Q",)
    else:
        forms = ("10-K", "10-Q")

    try:
        results = download_financials(args.ticker, out_dir=out_dir, forms=forms)
    except Exception as exc:  # noqa: BLE001
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
