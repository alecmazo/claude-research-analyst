# DGA Capital Research Analyst — Claude Edition

Runs an institutional-quality equity research pipeline end-to-end:
**SEC EDGAR XBRL filing → Excel workbooks → Grok 4.20 reasoning → Word report with bordered tables → optional Gamma.app deck.**

The pipeline downloads the latest 10-K and 10-Q for each ticker, saves each as a per-filing Excel file (Income Statement / Balance Sheet / Cash Flow / Metadata), and reads those workbooks to build the verified numbers block the LLM must use.

---

## Files

| File | Purpose |
|---|---|
| `claude_analyst.py` | Main terminal entry-point. Prompts for ticker or portfolio, runs the pipeline. |
| `pull_sec_financials.py` | Downloads the latest 10-K + 10-Q XBRL financials as Excel workbooks using `edgartools`. CLI and programmatic API. |
| `excel_financials.py` | Reads the Excel workbooks, normalizes US-GAAP concepts, and emits the canonical `data` dict consumed by the report builder. |
| `sec_edgar_xbrl.py` | Legacy companyfacts API fallback (used only if the Excel pipeline fails). |
| `word_report.py` | Renders Grok's markdown into a polished `.docx` with bordered tables. |
| `stock-financials/{TICKER}/` | Per-ticker Excel workbooks: `{TICKER}_10K_Financials.xlsx` and `{TICKER}_10Q_Financials.xlsx`. Folder name is configurable via `STOCK_FINANCIALS_DIR` in `.env`. |
| `stocks/` | All report outputs live here: `{TICKER}_DGA_Report.docx`, `{TICKER}_DGA_Presentation.pptx`, the raw XBRL JSON extract, and — for portfolios — `Portfolio_Summary.docx` + `.pptx`. |
| `stocks/dga_system_prompt.txt` | **Optional override.** If this file exists, its contents are used as the DGA system prompt instead of the built-in default. Drop in your custom prompt here. |

---

## Install (one-time, on your Mac)

```bash
cd "/path/to/Claude Research Analyst"
pip3 install openai python-docx pandas openpyxl requests python-dotenv edgartools
```

(`openai` is only used to talk to xAI — we call it with `base_url=https://api.x.ai/v1`. `python-dotenv` is optional but recommended; if missing, a tiny built-in parser handles `.env` anyway. `edgartools` powers the 10-K / 10-Q Excel download — required unless you want to rely on the companyfacts fallback.)

---

## Configuration — secrets & PII live in `.env`

All API keys and your SEC User-Agent are read from environment variables. A
`.env` file sitting next to `claude_analyst.py` is auto-loaded at startup.

### Set up `.env`

```bash
cp .env.example .env
# then edit .env and paste your real keys
```

`.env` is listed in `.gitignore` so it never gets committed. `.env.example`
is the safe-to-share template.

### Required variables

| Name | Purpose | Where to get one |
|---|---|---|
| `XAI_API_KEY` | xAI / Grok API key | https://console.x.ai/ |
| `GAMMA_API_KEY` | Gamma.app API key | https://gamma.app/account |
| `SEC_USER_AGENT` | Identifying string SEC requires | Self-provided, e.g. `"Your Name your.email@example.com"` |

### Optional variables

| Name | Default | Purpose |
|---|---|---|
| `GROK_MODEL` | `grok-4.20-reasoning` | Override to try newer models |
| `GAMMA_FOLDER_ID` | *(none)* | Target Gamma folder for generated decks |
| `STOCK_FINANCIALS_DIR` | `stock-financials` | Where per-ticker 10-K / 10-Q Excel workbooks are saved & read. Relative paths are resolved against this project root. |

If a required env var is missing, the script exits fast with a clear error
that tells you exactly what to set and where.

**None of these keys are hard-coded in source.** Rotate them by updating
`.env` and nothing else.

---

## Run

### Interactive
```bash
python3 claude_analyst.py
```
You'll be prompted to:
1. Pick single-ticker or portfolio mode
2. Enter the ticker or portfolio file path
3. Decide whether to generate Gamma presentations

### One-shot
```bash
# single ticker
python3 claude_analyst.py AAPL

# portfolio (CSV or XLSX with a "ticker" or "symbol" column)
python3 claude_analyst.py --portfolio ~/Downloads/my_portfolio.xlsx

# skip Gamma (no credits burned)
python3 claude_analyst.py AAPL --no-gamma

# force Gamma on
python3 claude_analyst.py --portfolio ~/Downloads/my_portfolio.csv --gamma
```

---

## How the data flows

```
Ticker
  │
  ▼
pull_sec_financials.download_financials(ticker)
  │  uses edgartools to fetch the latest 10-K and 10-Q filings,
  │  parses the XBRL instance documents attached to each filing
  ▼
stock-financials/{TICKER}/
  ├── {TICKER}_10K_Financials.xlsx   # Income Statement | Balance Sheet | Cash Flow | Metadata
  └── {TICKER}_10Q_Financials.xlsx   # Income Statement | Balance Sheet | Cash Flow | Metadata
  │
  ▼
excel_financials.extract_financials(ticker)
  │  reads the two workbooks, maps US-GAAP concepts via priority lists,
  │  parses each column header ("2025-08-31 (FY)", "2026-02-28 (Q2)",
  │  "2026-02-28 (YTD)", "2025-08-31"), filters out segment breakdown
  │  rows, normalizes outflow signs for CapEx / Dividends / Buybacks.
  ▼
Canonical data dict ─►  format_verified_block()  ─►  Grok 4.20 reasoning
                                                           │
                                                           ▼
                       Markdown research report  ─►  Word (bordered tables)
                                                  └─►  Gamma PPTX (optional)
```

### Annual table (from the 10-K)

Three latest FYs are returned. Each row carries: Revenue, Gross Profit,
Operating Income, Net Income, Diluted EPS, OCF, CapEx, FCF, Cash, Total
Debt, Total Assets, Total Liabilities, Stockholders Equity, plus margin
ratios.

Balance-sheet items are only reported for the two most recent FYs in a
10-K (prior years come from earlier filings), so the oldest FY row may
show N/A for BS fields — this is expected.

### Quarterly table (from the 10-Q)

Four rows:

1. **Latest Quarter** — 3-month column from the current 10-Q.
2. **Same Quarter Prior Year** — the prior-year 3-month comparison column
   on the same 10-Q.
3. **Current YTD** — the cumulative 6-month (Q2) or 9-month (Q3) column.
4. **Prior YTD** — the prior-year YTD comparison column.

The fiscal year label is derived from the 10-K's period end: a quarter
ending 2026-02-28 for a company whose FY ends Aug 31 is recorded as
**FY2026 Q2**, not FY2025 Q2.

> **Note:** 10-Q Cash Flow statements only report YTD figures (no 3-month
> breakdown). Free cash flow in the "Latest Quarter" row may be blank;
> use the YTD rows for cash metrics.

### Mapping accuracy

The module maps US-GAAP concepts in priority order (e.g. Revenue =
`RevenueFromContractWithCustomerExcludingAssessedTax` → `Revenues` →
`SalesRevenueNet` …). Columns are matched by their *filing period
context* — not by companyfacts' `fy` / `fp` labels, which can lag or
mis-attribute for 52/53-week and non-calendar fiscal filers.

The `stocks/{TICKER}_xbrl_extract.json` file is your audit trail. Open
it and you'll see exactly which US-GAAP concept was used for each metric
in each period.

### Fallback path

If `edgartools` isn't installed or SEC is unreachable, `claude_analyst.py`
falls back to `sec_edgar_xbrl.py`, which pulls the same metrics from the
SEC **companyfacts** JSON API. This is less accurate for certain filers
(see AYI) but requires zero extra dependencies.

---

## Portfolio mode — the roll-up

When you give it more than one ticker, it:

1. Runs the per-stock pipeline on each ticker.
2. Feeds each stock's Executive Summary + Verdict sections back to Grok with
   a portfolio-strategist system prompt.
3. Grok returns a ranking table (Ticker / Rating / Target / Upside / Action
   / Reason) plus write-ups for what to trim/sell vs add/buy plus a
   rebalancing action plan.
4. That roll-up is rendered into `stocks/Portfolio_Summary.docx` and
   (optionally) a Gamma deck `stocks/Portfolio_Summary.pptx`.

### Portfolio file formats accepted

Any CSV or XLSX with one of these header names:
`ticker`, `Ticker`, `TICKER`, `symbol`, `Symbol`, `SYMBOL`.
Otherwise the first column is used.

---

## GuruFocus (not enabled)

You asked whether GuruFocus is needed — **for US-listed issuers, SEC
EDGAR XBRL is sufficient and authoritative**. GuruFocus aggregates the
same data with additional TTM/ratios but at the cost of a paid API. Only
cases where EDGAR falls short:

- Foreign private issuers who file 20-F (not 10-K) — they still file
  XBRL and the script handles 20-F if you extend the submissions filter.
- Very small filers who use custom extension tags that don't map cleanly
  to US-GAAP.

If you want GuruFocus as a belt-and-suspenders fallback later, we can add
it in about 60 lines — just ask.

---

## Sample output

`stocks/SAMPLE_output_style_AAPL.docx` is a rendered example built from
synthetic data, so you can see the table style, borders, header shading,
and overall layout before running the real pipeline.
