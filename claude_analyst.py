#!/usr/bin/env python3
"""
DGA Capital Research Analyst — Claude Edition
----------------------------------------------

Terminal entry-point that:
  1. Prompts for a single ticker or a portfolio CSV/XLSX file.
  2. Asks whether to generate Gamma.app presentations (credits guard).
  3. Pulls authoritative financial data from SEC EDGAR XBRL (companyfacts).
  4. Sends the DGA_SYSTEM_PROMPT + verified data to xAI Grok for analysis.
  5. Renders Grok's markdown into a bordered-table Word report.
  6. Optionally creates Gamma presentations for each stock.
  7. For portfolios: builds a roll-up Word summary + Gamma deck that ranks
     what to trim/sell vs add/buy based on valuations.

Data source: SEC EDGAR XBRL only (free, authoritative).

Usage:
    python3 claude_analyst.py
    python3 claude_analyst.py AAPL
    python3 claude_analyst.py --portfolio /path/to/portfolio.csv
    python3 claude_analyst.py --portfolio /path/to/portfolio.xlsx --no-gamma
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import requests

import sec_edgar_xbrl as edgar  # legacy companyfacts fallback
import excel_financials as xlsx_edgar  # primary: filing-accurate XBRL via edgartools
import pull_sec_financials  # downloader (edgartools-backed)
from word_report import render_report

# ============================================================================
# CONFIG — everything sensitive lives in .env (or real environment variables)
# ============================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
STOCKS_FOLDER = SCRIPT_DIR / "stocks"
STOCKS_FOLDER.mkdir(parents=True, exist_ok=True)


def _load_dotenv() -> None:
    """Load a .env file sitting next to this script, if present.

    Uses python-dotenv when installed, otherwise falls back to a tiny parser
    so the script still runs on a minimal install.
    """
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv(env_path)
        return
    except Exception:
        pass
    # Minimal fallback parser: KEY=VALUE, ignores blanks and '#' comments.
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        # Strip matching surrounding quotes.
        if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
            v = v[1:-1]
        # Don't overwrite anything the shell has already set.
        os.environ.setdefault(k, v)


_load_dotenv()


def _require_env(name: str, *, hint: str = "") -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        msg = (
            f"❌ Missing required environment variable: {name}\n"
            f"   Set it in your shell or in {SCRIPT_DIR / '.env'}"
        )
        if hint:
            msg += f"\n   Hint: {hint}"
        raise SystemExit(msg)
    return val


def _optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip() or default


# xAI API (Grok) — required at call time (not at import; keeps unit-testability)
GROK_MODEL = _optional_env("GROK_MODEL", "grok-4.20-reasoning")

# Gamma.app folder ID is optional; API key is only required if Gamma generation
# is actually requested at runtime.
GAMMA_FOLDER_ID = _optional_env("GAMMA_FOLDER_ID", "")


def get_sec_user_agent() -> str:
    """Resolved on demand so a missing UA fails cleanly when we actually need it."""
    return _require_env(
        "SEC_USER_AGENT",
        hint="Format: 'Your Name your.email@example.com'. SEC blocks anonymous scrapers.",
    )


def get_grok_api_key() -> str:
    return _require_env("XAI_API_KEY", hint="Get yours at https://console.x.ai/")


def get_gamma_api_key() -> str:
    return _require_env("GAMMA_API_KEY", hint="Get yours at https://gamma.app/account")

# ============================================================================
# DGA_SYSTEM_PROMPT  (reads from /stocks/dga_system_prompt.txt if present, else uses default)
# ============================================================================
_DEFAULT_SYSTEM_PROMPT_PATH = STOCKS_FOLDER / "dga_system_prompt.txt"

DEFAULT_DGA_SYSTEM_PROMPT = """You are DGA Capital Analyst, a senior equity research analyst at Goldman Sachs level. You produce formal, institutional-quality research reports.

You are operating on today's date: Always base every analysis on the most recent market data, earnings, news, filings, and analyst updates available right now.
Use ONLY the price, previous close, and market cap numbers explicitly given in the user message. Never use outdated numbers.

FINANCIAL DATA EXTRACTION RULES - MANDATORY AND NON-NEGOTIABLE FOR ALL STOCK ANALYSIS:

You MUST treat financial numbers as the single most important part of the report. Any error here invalidates the entire analysis.

MANDATORY DATA VERIFICATION STEP (perform this at the VERY START):
1. You are given verified financial data below from official SEC EDGAR XBRL filings (companyfacts + submissions APIs).
2. You MUST use ONLY these exact numbers for ALL tables and calculations.
3. The verified block contains:
   - LATEST_FILING_TYPE (10-K or 10-Q)
   - ANNUAL DATA (last 3 fiscal years) from the latest 10-K
   - QUARTERLY DATA (latest quarter + same quarter prior year + YTD both years) from the latest 10-Q
4. Use the ANNUAL DATA for the main Key Metrics table.
5. If LATEST_FILING_TYPE is 10-Q, also create the Latest Quarterly YoY Analysis table using the QUARTERLY DATA.
6. If LATEST_FILING_TYPE is 10-K, skip the quarterly subsection entirely.
7. If any number is 'N/A', write exactly: "Data not available in verified filing - please check latest 10-K/10-Q".
8. All values in the VERIFIED block are reported in raw $ (or $ per share for EPS). For tables, convert to millions ($M) with one decimal place, unless EPS (two decimals).

TABLE FORMAT REQUIREMENT (use this exact markdown format - no deviations):
| Metric                          | TTM (as of [Date]) | FY[Year] (ended [Date]) | FY[Year-1] (ended [Date]) | FY[Year-2] (ended [Date]) |
|---------------------------------|--------------------|--------------------------|---------------------------|---------------------------|
| Revenue ($M)                    | exact_number      | exact_number            | exact_number             | exact_number             |
| Operating Income ($M)           | exact_number      | exact_number            | exact_number             | exact_number             |
| Operating Margin (%)            | xx.x%             | xx.x%                   | xx.x%                    | xx.x%                    |
| Net Income ($M)                 | exact_number      | exact_number            | exact_number             | exact_number             |
| Net Profit Margin (%)           | xx.x%             | xx.x%                   | xx.x%                    | xx.x%                    |
| Diluted EPS                     | exact_number      | exact_number            | exact_number             | exact_number             |
| Free Cash Flow ($M)             | exact_number      | exact_number            | exact_number             | exact_number             |
| Total Debt ($M)                 | exact_number      | exact_number            | exact_number             | exact_number             |
| Cash & Equivalents ($M)         | exact_number      | exact_number            | exact_number             | exact_number             |
| Net Debt ($M)                   | exact_number      | exact_number            | exact_number             | exact_number             |

At the top of the financial section you MUST write exactly:
"Data Verification: Official company FY[Year] 10-K + 10-Q filings (verified via SEC EDGAR XBRL). Numbers used are exact filing figures only. TTM calculated as sum of last four quarters."

Sources must always be stated at the bottom exactly as:
"Sources: Official [Company Name] FY[Year] 10-K + 10-Q filings (verified via SEC EDGAR XBRL). Data Verification completed."

All other sections of the report (Executive Summary, Valuation, etc.) must be consistent with these verified financial numbers. Never contradict them.

GENERAL RULES:
- Put "DGA Capital Research" as the header and add today's date.

SECTION 1 — Executive Summary:
→ Investment thesis: Why should someone care about this stock right now?
→ Overall rating: Strong Buy / Buy / Hold / Sell
→ 12-month price target with the methodology used to calculate it
→ The single biggest reason to own this stock and the single biggest risk
→ The 30-second elevator pitch: If you had one paragraph to pitch this stock to a portfolio manager, what would you say?

SECTION 2 — Business Overview:
→ What the company does in plain English
→ Revenue breakdown by segment, product, and geography (with percentages)
→ Business model: How they make money and what drives repeat revenue
→ Competitive moat: What makes this company hard to replicate?

SECTION 3 — Financial Deep Dive:
→ Data Verification & Financial Foundation – Always begin with the MANDATORY DATA VERIFICATION STEP and full financial tables from the FINANCIAL DATA EXTRACTION RULES above.
→ Key Metrics: go to FINANCIAL DATA EXTRACTION RULES - MANDATORY FOR ALL STOCK ANALYSIS, and follow every step exactly as written, including table format.
→ Balance sheet health: cash, debt, current ratio, debt-to-equity
→ Cash flow quality: operating cash flow vs. net income ratio (flag if significantly different)
→ Capital allocation: How is management spending money? Buybacks, dividends, M&A, R&D?

→ Latest Quarterly YoY Analysis:
   ONLY include this subsection if the verified block says LATEST_FILING_TYPE: 10-Q.
   If LATEST_FILING_TYPE: 10-K, skip this subsection entirely.
   When included, create a dedicated Quarterly YoY Comparison Table using this exact column order and markdown format.

   TABLE FORMAT REQUIREMENT (use this exact markdown format - no deviations):
   | Metric                          | Latest Quarter (ended [Date]) | Same Quarter Last Year (ended [Date]) | YoY % Change | YTD Current Fiscal (ended [Date]) | Prior YTD | YoY % Change (YTD) |
   |---------------------------------|-------------------------------|---------------------------------------|--------------|-----------------------------------|-----------|--------------------|
   | Revenue ($M)                    | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Operating Income ($M)           | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Operating Margin (%)            | xx.x%                        | xx.x%                                | +xx.xppt    | xx.x%                            | xx.x%        | +xx.xppt          |
   | Net Income ($M)                 | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Net Profit Margin (%)           | xx.x%                        | xx.x%                                | +xx.xppt    | xx.x%                            | xx.x%        | +xx.xppt          |
   | Diluted EPS                     | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Free Cash Flow ($M)             | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |

   At the top of this subsection you MUST write exactly:
   "Latest Quarterly YoY Analysis – Official 10-Q filing (verified via SEC EDGAR XBRL). Numbers are exact filing figures only."

   Clearly state the exact quarter end dates (e.g., "Q2 FY2026 ended Feb 28, 2026 vs Q2 FY2025 ended Feb 28, 2025").
   Use ONLY the exact quarterly and YTD numbers from the verified financial data block.
   If the fiscal year is incomplete, the YTD columns must reflect the partial year-to-date results.
   Highlight any material acceleration or deceleration in growth with clear commentary.

SECTION 4 — Growth Analysis:
Financial Modeling & Projections – Build or update a detailed three-statement model; forecast 5–10 years of key metrics with explicit assumptions; calculate TTM and forward estimates.
→ Total addressable market (TAM) with source
→ Current market share and trajectory
→ Key growth drivers for the next 3-5 years
→ Management guidance vs. analyst consensus — who is more bullish?
→ Is growth organic or acquisition-dependent?

SECTION 5 — Valuation:
Multi-Method Valuation – Perform at least two primary methods:
   - Discounted Cash Flow (DCF) with explicit WACC, terminal growth, and sensitivity analysis.
   - Comparable company analysis (multiples: EV/EBITDA, P/E, etc.) and precedent transactions where relevant, minimum 5 peer comps.
   - Cross-check with any other appropriate method (e.g., sum-of-the-parts).
→ Historical valuation range (5-year P/E band)
→ Bull / Base / Bear price targets with assumptions for each
→ Current price vs. each target — upside or downside %

SECTION 6 — Risk Analysis:
→ Latest developments in the headlines: scan X (old Twitter), and summarize anything new announced in the past 30 days like Gov't investigations, lawsuits, executive turmoil, anything coming out of left field that could negatively affect the company.
→ Top 5 material risks ranked by probability and impact
→ For each risk: what would trigger it, how bad it would be, and what to watch for
→ Short interest and insider activity data (cite source)
→ Accounting quality flags (if any)

SECTION 7 — Catalyst Calendar:
→ Next earnings date
→ Upcoming product launches, regulatory decisions, or strategic events
→ Macro events that specifically impact this stock
→ Timeline of potential catalysts over the next 12 months

SECTION 8 — The Verdict:
→ Bull case: Price target and what has to go right (with probability estimate)
→ Base case: Price target and most likely scenario (with probability estimate)
→ Bear case: Price target and what could go wrong (with probability estimate)
→ Expected value calculation: Probability-weighted price target across all three scenarios
→ Final recommendation with conviction level: High / Medium / Low

SECTION 9 — Institutional Activity:
→ Top 5 institutional holders and their position changes last quarter
→ Any notable hedge fund activity (new positions or exits)

End with a sources section listing every data source used in this report.
"""


def load_system_prompt() -> str:
    """Use override file in /stocks/dga_system_prompt.txt if present."""
    if _DEFAULT_SYSTEM_PROMPT_PATH.exists():
        return _DEFAULT_SYSTEM_PROMPT_PATH.read_text()
    return DEFAULT_DGA_SYSTEM_PROMPT


# ============================================================================
# Market price (free, no-key) — use Yahoo via requests-only lightweight call
# ============================================================================
def fetch_market_snapshot(ticker: str) -> dict:
    """Best-effort current price + previous close via Yahoo Finance public endpoint."""
    out = {"price": None, "previous_close": None, "market_cap": None, "source": ""}
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        resp = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=15,
        )
        data = resp.json()
        result = data.get("chart", {}).get("result", [])
        if result:
            meta = result[0].get("meta", {})
            out["price"] = meta.get("regularMarketPrice") or meta.get("previousClose")
            out["previous_close"] = meta.get("previousClose")
            out["source"] = "Yahoo Finance"
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Market snapshot failed: {exc}")
    return out


# ============================================================================
# Grok (xAI) call
# ============================================================================
def _client():
    # Imported lazily so the module can be loaded without the openai package
    # (e.g. for parser/word-render unit tests) — only needed at call time.
    from openai import OpenAI  # type: ignore
    return OpenAI(api_key=get_grok_api_key(), base_url="https://api.x.ai/v1")


def call_grok(system_prompt: str, user_content: str,
              model: str = GROK_MODEL) -> str:
    client = _client()
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return resp.choices[0].message.content or ""


# ============================================================================
# Ratings / price-target extraction for portfolio ranking
# ============================================================================
_RATING_RE = re.compile(
    r"\b(Strong Buy|Buy|Hold|Sell|Strong Sell)\b", re.IGNORECASE
)
_PRICE_TARGET_RE = re.compile(
    r"price target[^\$]{0,60}\$([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]+)?)", re.IGNORECASE,
)


def extract_summary_from_report(report_text: str) -> dict:
    """Pull rating + 12-month price target + headline thesis from the Grok output."""
    rating = None
    for m in _RATING_RE.finditer(report_text[:4000]):
        rating = m.group(1).title()
        break
    price_target = None
    for m in _PRICE_TARGET_RE.finditer(report_text):
        try:
            price_target = float(m.group(1).replace(",", ""))
            break
        except ValueError:
            continue
    # Grab the first non-empty non-heading paragraph as a thesis hint.
    thesis = ""
    for line in report_text.split("\n"):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("|"):
            continue
        thesis = s[:400]
        break
    return {"rating": rating, "price_target": price_target, "thesis": thesis}


# ============================================================================
# Gamma.app integration
# ============================================================================
def _gamma_design_block() -> str:
    return """IMPORTANT DESIGN RULES (enforce strictly):
- Clean, modern corporate-finance theme (Chisel or equivalent).
- ALL TEXT minimum 12pt (titles 28–32pt, headings 20–24pt, body 14–18pt).
- CHARTS: solid fills, bold borders, high contrast, ample white space.
  • Pie / donut charts: show percentage labels ON each segment (e.g. "45%").
  • Legends 12pt+.
- Tables: large numbers, professional black borders.
- Must look like a top-tier Goldman Sachs research deck.
"""


def create_gamma_for_stock(report_text: str, ticker: str, latest_filing_type: str,
                           out_pptx: Path | None = None) -> tuple[str | None, int]:
    print(f"   📤 Gamma: generating presentation for {ticker}…")
    include_qtr = latest_filing_type == "10-Q"
    num_cards = 19 if include_qtr else 18
    qtr_card = (
        "8. Latest Quarterly Financial Deep Dive – latest Q vs prior-year Q (include both the quarterly and YTD comparison tables with YoY % changes)\n"
        if include_qtr
        else ""
    )
    shortened = report_text[:18000]
    title = f"DGA Capital Research — {ticker} | {datetime.now().strftime('%B %d, %Y')}"
    input_text = f"""Create a professional institutional-quality investment research **PRESENTATION** for {ticker}.

Title: "{title}"

{_gamma_design_block()}

Create at least {num_cards} cards structured exactly like this:
1. Title + Key Thesis
2. Executive Summary + Rating + Price Target
3. Bull Case
4. Business Overview
5. Revenue Breakdown (by segment + by geography — use clean donut charts with % labels)
6. Competitive Moat
7. Financial Deep Dive + Key Metrics Table (Annual + TTM)
{qtr_card}8. Income Statement & Margins
9. Balance Sheet & Cash Flow
10. Growth Analysis
11. 5-Year Projections
12. DCF Valuation
13. Comps Valuation
14. Historical Valuation + Bull/Base/Bear Targets
15. Risk Analysis
16. Latest Developments
17. Catalyst Calendar
18. Final Verdict & Recommendation

Use the full report content below. Every chart, legend and table must be large and professional.

{shortened}
"""
    return _gamma_generate(input_text, num_cards=num_cards, out_pptx=out_pptx)


def create_gamma_portfolio_summary(summary_markdown: str, ranked_rows: list[dict],
                                   out_pptx: Path | None = None) -> tuple[str | None, int]:
    print("   📤 Gamma: generating portfolio summary deck…")
    title = f"DGA Capital Research — Portfolio Summary | {datetime.now().strftime('%B %d, %Y')}"
    def _action(r: dict) -> str:
        return str(r.get("action", "")).strip().upper()
    top_trim = [r for r in ranked_rows if _action(r) in ("TRIM", "SELL", "STRONG SELL")]
    top_buy = [r for r in ranked_rows if _action(r) in ("ADD", "BUY", "STRONG BUY")]
    header = (
        f"Portfolio under review: {len(ranked_rows)} positions.\n"
        f"Candidates to TRIM / SELL: {', '.join(r['ticker'] for r in top_trim) or 'None'}\n"
        f"Candidates to ADD / BUY: {', '.join(r['ticker'] for r in top_buy) or 'None'}\n"
    )
    input_text = f"""Create a professional **PORTFOLIO-LEVEL** research deck.

Title: "{title}"

{_gamma_design_block()}

{header}

Include the following cards (in order):
1. Title + portfolio snapshot
2. Summary ranking — all tickers with rating, price target, upside %, action
3. TOP TRIM / SELL candidates — why each, with catalysts
4. TOP ADD / BUY candidates — why each, with catalysts
5. Valuation comparison table across all names (P/E, EV/EBITDA, FCF yield, upside)
6. Sector / concentration risk
7. Rebalancing action plan (concrete recommended moves)
8. Key catalysts to watch across the portfolio (next 12 months)

Use the portfolio write-up below verbatim where applicable.

{summary_markdown}
"""
    return _gamma_generate(input_text, num_cards=8, out_pptx=out_pptx)


def _gamma_generate(input_text: str, num_cards: int,
                    out_pptx: Path | None = None) -> tuple[str | None, int]:
    headers = {"Content-Type": "application/json", "X-API-KEY": get_gamma_api_key()}
    payload = {
        "inputText": input_text,
        "textMode": "generate",
        "format": "presentation",
        "numCards": max(8, num_cards),
        "exportAs": "pptx",
        "folderIds": [GAMMA_FOLDER_ID] if GAMMA_FOLDER_ID else None,
    }
    resp = requests.post(
        "https://public-api.gamma.app/v1.0/generations",
        json=payload,
        headers=headers,
        timeout=60,
    )
    if resp.status_code not in (200, 201):
        print(f"   ❌ Gamma error {resp.status_code}: {resp.text[:300]}")
        return None, 0
    gen_id = resp.json().get("generationId")
    print(f"   ✅ Gamma generation started ({gen_id})")

    for attempt in range(200):
        time.sleep(6)
        status = requests.get(
            f"https://public-api.gamma.app/v1.0/generations/{gen_id}",
            headers=headers,
            timeout=30,
        ).json()
        if status.get("status") == "completed":
            gamma_url = status.get("gammaUrl")
            export_url = status.get("exportUrl")
            credits = status.get("credits", {})
            used = credits.get("deducted", 0)
            remaining = credits.get("remaining", "?")
            print(f"   ✅ PPTX ready: {gamma_url}  (credits used: {used}, remaining: {remaining})")
            if export_url and out_pptx is not None:
                r = requests.get(export_url, stream=True, timeout=60)
                with open(out_pptx, "wb") as fh:
                    for chunk in r.iter_content(8192):
                        fh.write(chunk)
                print(f"   💾 Saved {out_pptx}")
            return gamma_url, used
        if status.get("status") == "failed":
            print("   ❌ Gamma generation failed")
            return None, 0
        if attempt % 10 == 0:
            print(f"   ⏳ Gamma still generating… ({attempt+1}/200)")
    print("   ❌ Gamma timeout")
    return None, 0


# ============================================================================
# Per-ticker analysis pipeline
# ============================================================================
def analyze_ticker(ticker: str, *, system_prompt: str, generate_gamma: bool,
                   verbose: bool = True) -> dict:
    ticker = ticker.strip().upper()
    result = {"ticker": ticker, "ok": False}

    # --- Step 1: download the latest 10-K and 10-Q into stock-financials/{TICKER}/
    # This parses the actual XBRL instance documents from each filing, so the
    # columns we read later map 1-to-1 onto the filing's own period contexts.
    print(f"\n🚀 {ticker}: downloading latest 10-K + 10-Q Excel workbooks…")
    data: dict | None = None
    try:
        pull_sec_financials.download_financials(ticker)
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Could not download fresh Excel files: {exc}")
        print("   Falling back to existing workbooks (if any) or companyfacts API.")

    # --- Step 2: read the Excel workbooks and build the verified data dict
    try:
        data = xlsx_edgar.extract_financials(ticker)
        verified_block = xlsx_edgar.format_verified_block(data)
        print(f"   ✅ Loaded filing-accurate financials from Excel workbooks.")
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Excel reader failed: {exc}")
        print(f"   Falling back to SEC companyfacts API…")
        try:
            data = edgar.extract_financials(ticker, user_agent=get_sec_user_agent())
            verified_block = edgar.format_verified_block(data)
        except Exception as exc2:  # noqa: BLE001
            print(f"   ❌ EDGAR fallback also failed: {exc2}")
            result["error"] = str(exc2)
            return result

    # Cache the raw extract for auditing.
    audit_path = STOCKS_FOLDER / f"{ticker}_xbrl_extract.json"
    try:
        with open(audit_path, "w") as f:
            json.dump(data, f, indent=2, default=str)
    except Exception:
        pass

    if verbose:
        print(verified_block)

    # Current price
    mkt = fetch_market_snapshot(ticker)

    # Compose Grok user message
    today = datetime.now().strftime("%Y-%m-%d")
    user_msg = (
        f"DATE: {today}\n"
        f"TICKER: {ticker}\n"
        f"ENTITY: {data.get('entity_name','')}\n"
        f"CURRENT_PRICE: {mkt.get('price')}\n"
        f"PREVIOUS_CLOSE: {mkt.get('previous_close')}\n"
        f"LATEST_FILING_TYPE: {data.get('latest_filing_type')}\n\n"
        f"{verified_block}\n\n"
        f"Generate the full research report for {ticker} following every rule in your system prompt."
    )

    print(f"   🧠 Calling Grok ({GROK_MODEL})…")
    try:
        report_text = call_grok(system_prompt, user_msg)
    except Exception as exc:  # noqa: BLE001
        print(f"   ❌ Grok API error: {exc}")
        result["error"] = f"Grok: {exc}"
        return result

    # Save markdown too, for debugging / iteration.
    md_path = STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
    md_path.write_text(report_text)

    # Render Word
    out_docx = STOCKS_FOLDER / f"{ticker}_DGA_Report.docx"
    summary = extract_summary_from_report(report_text)
    rating_hint = summary.get("rating") or ""
    render_report(
        report_text,
        ticker=ticker,
        entity_name=data.get("entity_name", ticker),
        output_path=str(out_docx),
        price=mkt.get("price"),
        rating_hint=rating_hint,
    )
    print(f"   💾 Word: {out_docx}")

    # Gamma
    gamma_url = None
    gamma_credits = 0
    if generate_gamma:
        out_pptx = STOCKS_FOLDER / f"{ticker}_DGA_Presentation.pptx"
        gamma_url, gamma_credits = create_gamma_for_stock(
            report_text, ticker, data.get("latest_filing_type", "10-K"), out_pptx=out_pptx
        )

    result.update({
        "ok": True,
        "entity_name": data.get("entity_name", ticker),
        "latest_filing_type": data.get("latest_filing_type"),
        "market_price": mkt.get("price"),
        "report_text": report_text,
        "docx": str(out_docx),
        "md": str(md_path),
        "xbrl_json": str(audit_path),
        "gamma_url": gamma_url,
        "gamma_credits": gamma_credits,
        "summary": summary,
    })
    return result


# ============================================================================
# Portfolio roll-up (Grok call over per-stock summaries)
# ============================================================================
PORTFOLIO_SYSTEM_PROMPT = """You are DGA Capital's portfolio strategist. You are given per-stock
analyses already produced by the DGA equity research team. Your job is to:

1) Rank all positions into ACTION buckets:
   - SELL   (overvalued, broken thesis, cut exposure entirely)
   - TRIM   (overvalued vs targets, reduce weight)
   - HOLD   (fairly valued / on-thesis)
   - ADD    (attractive, increase weight)
   - BUY    (high conviction, initiate or materially add)

2) For each name provide: rating, 12-month price target, % upside / downside vs current
   price, and a one-line reason.

3) Produce:
   a. A Summary Ranking Table (markdown) with columns:
      | Ticker | Name | Rating | Current Price | 12M Target | Upside % | Action | One-line Reason |
   b. A Top Trim / Sell write-up section (what to reduce and why)
   c. A Top Add / Buy write-up section (what to increase and why)
   d. A Rebalancing Action Plan section with concrete moves
   e. A portfolio-level Key Catalysts Calendar (next 12 months)

Use ONLY the information you were given. Do not fabricate numbers. Keep the tone
institutional and decision-oriented. Output must be pure markdown, no preamble.
"""


def run_portfolio_summary(ticker_results: list[dict], *, generate_gamma: bool) -> dict:
    """Build the portfolio roll-up after all tickers have been analyzed."""
    usable = [r for r in ticker_results if r.get("ok")]
    if not usable:
        return {"ok": False, "error": "No successful per-stock analyses to summarize."}

    # Summarize each stock's report in ~800-1200 tokens to stay under context limits.
    per_stock_blobs = []
    for r in usable:
        s = r.get("summary", {}) or {}
        rep = r.get("report_text", "") or ""
        # Feed back Grok the Executive Summary + Verdict sections specifically.
        exec_part = _extract_section(rep, r"executive summary", max_chars=3000)
        verdict_part = _extract_section(rep, r"verdict", max_chars=3000)
        per_stock_blobs.append(
            f"### {r['ticker']} — {r.get('entity_name','')}\n"
            f"Rating (extracted): {s.get('rating') or 'N/A'}\n"
            f"12M Price Target (extracted): {s.get('price_target') or 'N/A'}\n"
            f"Current Price: {r.get('market_price')}\n\n"
            f"**Executive Summary excerpt:**\n{exec_part}\n\n"
            f"**Verdict excerpt:**\n{verdict_part}\n"
        )

    today = datetime.now().strftime("%Y-%m-%d")
    user_msg = (
        f"DATE: {today}\n"
        f"PORTFOLIO SIZE: {len(usable)} positions\n\n"
        + "\n\n".join(per_stock_blobs)
    )

    print("\n🧠 Portfolio summary: calling Grok for rebalancing analysis…")
    try:
        summary_md = call_grok(PORTFOLIO_SYSTEM_PROMPT, user_msg)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Grok portfolio call: {exc}"}

    # Parse the ranking table so we can tell Gamma top buys vs sells.
    ranked_rows = _parse_action_table(summary_md)

    # Save markdown
    md_path = STOCKS_FOLDER / "Portfolio_Summary.md"
    md_path.write_text(summary_md)

    # Word
    out_docx = STOCKS_FOLDER / "Portfolio_Summary.docx"
    render_report(
        summary_md,
        ticker="PORTFOLIO",
        entity_name="Portfolio Review",
        output_path=str(out_docx),
    )
    print(f"💾 Portfolio Word summary: {out_docx}")

    # Gamma
    gamma_url = None
    gamma_credits = 0
    if generate_gamma:
        out_pptx = STOCKS_FOLDER / "Portfolio_Summary.pptx"
        gamma_url, gamma_credits = create_gamma_portfolio_summary(
            summary_md, ranked_rows, out_pptx=out_pptx
        )

    return {
        "ok": True,
        "docx": str(out_docx),
        "md": str(md_path),
        "gamma_url": gamma_url,
        "gamma_credits": gamma_credits,
        "ranked_rows": ranked_rows,
    }


def _extract_section(markdown_text: str, keyword_regex: str,
                     max_chars: int = 2500) -> str:
    """Rough section extractor: finds a heading matching `keyword_regex` and takes
    text up to the next heading (or max_chars)."""
    lines = markdown_text.split("\n")
    out: list[str] = []
    capturing = False
    heading_re = re.compile(r"^#{1,3}\s+.*(" + keyword_regex + ")", re.IGNORECASE)
    next_heading_re = re.compile(r"^#{1,3}\s+")
    for ln in lines:
        if not capturing:
            if heading_re.search(ln):
                capturing = True
                out.append(ln)
            continue
        if next_heading_re.match(ln) and len("\n".join(out)) > 200:
            break
        out.append(ln)
        if len("\n".join(out)) > max_chars:
            break
    return "\n".join(out).strip() or "(section not found)"


def _parse_action_table(summary_md: str) -> list[dict]:
    """Parse the first markdown table we can find with columns including Ticker + Action."""
    lines = summary_md.split("\n")
    rows: list[dict] = []
    for i, line in enumerate(lines):
        if not line.strip().startswith("|"):
            continue
        if i + 1 >= len(lines):
            continue
        if "---" not in lines[i + 1]:
            continue
        header_cells = [c.strip() for c in line.strip().strip("|").split("|")]
        idx_lookup = {h.lower(): j for j, h in enumerate(header_cells)}
        j = i + 2
        while j < len(lines) and lines[j].strip().startswith("|"):
            cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
            d: dict = {}
            for key_name, canonical in [
                ("ticker", "ticker"),
                ("name", "name"),
                ("rating", "rating"),
                ("current price", "current_price"),
                ("12m target", "price_target"),
                ("target", "price_target"),
                ("upside %", "upside"),
                ("upside", "upside"),
                ("action", "action"),
                ("one-line reason", "reason"),
                ("reason", "reason"),
            ]:
                for h, jdx in idx_lookup.items():
                    if key_name in h and canonical not in d and jdx < len(cells):
                        d[canonical] = cells[jdx]
            if d.get("ticker"):
                rows.append(d)
            j += 1
        if rows:
            break
    return rows


# ============================================================================
# Portfolio file loader
# ============================================================================
def load_portfolio_file(path: str) -> list[str]:
    p = Path(path).expanduser()
    if not p.exists():
        raise FileNotFoundError(path)
    if p.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(p)
    elif p.suffix.lower() in (".csv", ".tsv"):
        sep = "\t" if p.suffix.lower() == ".tsv" else ","
        df = pd.read_csv(p, sep=sep)
    else:
        raise ValueError(f"Unsupported portfolio file: {p.suffix}")

    # Try several reasonable column names.
    for col in ("ticker", "Ticker", "TICKER", "symbol", "Symbol", "SYMBOL"):
        if col in df.columns:
            return [str(x).strip().upper() for x in df[col].dropna().tolist()]
    # Fall back to first column.
    first_col = df.columns[0]
    return [str(x).strip().upper() for x in df[first_col].dropna().tolist()]


# ============================================================================
# CLI
# ============================================================================
def _prompt_yes_no(prompt: str, default: bool = False) -> bool:
    default_str = "Y/n" if default else "y/N"
    resp = input(f"{prompt} [{default_str}]: ").strip().lower()
    if not resp:
        return default
    return resp in ("y", "yes")


def main() -> int:
    ap = argparse.ArgumentParser(description="DGA Capital Research — Claude Edition")
    ap.add_argument("ticker", nargs="?", help="Single ticker (e.g. AAPL)")
    ap.add_argument("--portfolio", help="Path to a CSV or XLSX with a 'ticker' column")
    ap.add_argument("--gamma", action="store_true", help="Force Gamma deck generation")
    ap.add_argument("--no-gamma", action="store_true", help="Skip Gamma deck generation")
    args = ap.parse_args()

    print("╔══════════════════════════════════════════════════╗")
    print("║  DGA CAPITAL RESEARCH ANALYST — Claude Edition  ║")
    print("╚══════════════════════════════════════════════════╝")

    # Resolve input: CLI takes precedence; else prompt.
    tickers: list[str] = []
    if args.portfolio:
        tickers = load_portfolio_file(args.portfolio)
    elif args.ticker:
        tickers = [args.ticker.strip().upper()]
    else:
        print("\nChoose input mode:")
        print("  1) Single ticker")
        print("  2) Portfolio CSV or XLSX")
        mode = input("Select 1 or 2 (or paste a ticker directly): ").strip()
        if mode == "1":
            t = input("Enter ticker (e.g. AAPL): ").strip().upper()
            if t:
                tickers = [t]
        elif mode == "2":
            pf = input("Path to portfolio file (.csv or .xlsx): ").strip()
            try:
                tickers = load_portfolio_file(pf)
            except Exception as exc:  # noqa: BLE001
                print(f"❌ Could not load portfolio: {exc}")
                return 2
        else:
            # Treat any other input as a ticker.
            if mode:
                tickers = [mode.upper()]

    if not tickers:
        print("❌ No tickers to analyze.")
        return 2

    # Gamma decision
    if args.gamma:
        generate_gamma = True
    elif args.no_gamma:
        generate_gamma = False
    else:
        generate_gamma = _prompt_yes_no(
            "Generate Gamma.app presentations as well? (uses Gamma credits)",
            default=False,
        )

    system_prompt = load_system_prompt()

    print(f"\n📋 Tickers to analyze ({len(tickers)}): {', '.join(tickers)}")
    print(f"📁 Output folder: {STOCKS_FOLDER}")
    print(f"🎨 Gamma generation: {'ON' if generate_gamma else 'OFF'}")

    results: list[dict] = []
    for ticker in tickers:
        try:
            res = analyze_ticker(
                ticker,
                system_prompt=system_prompt,
                generate_gamma=generate_gamma,
                verbose=False,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"❌ {ticker} failed: {exc}")
            res = {"ticker": ticker, "ok": False, "error": str(exc)}
        results.append(res)

    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]

    print("\n==============================================")
    print(f"  SUMMARY: {len(ok)} succeeded, {len(fail)} failed")
    print("==============================================")
    for r in ok:
        print(f"  ✅ {r['ticker']}  →  {r['docx']}")
        if r.get("gamma_url"):
            print(f"       📽️   {r['gamma_url']}")
    for r in fail:
        print(f"  ❌ {r['ticker']}  {r.get('error','')}")

    # Portfolio roll-up
    if len(ok) > 1:
        print("\n==============================================")
        print("  PORTFOLIO ROLL-UP")
        print("==============================================")
        roll = run_portfolio_summary(ok, generate_gamma=generate_gamma)
        if roll.get("ok"):
            print(f"  ✅ Portfolio Word: {roll['docx']}")
            if roll.get("gamma_url"):
                print(f"  📽️   {roll['gamma_url']}")
        else:
            print(f"  ❌ Portfolio roll-up failed: {roll.get('error')}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
