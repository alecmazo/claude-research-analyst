# api/domains/_financials_body.py
# ---------------------------------------------------------------------------
# Financials store, market-data cache, company dashboard, Value Line sheet,
# and price-history. This file is EXEC'd into api.server's module namespace by
# api.domains.financials_api.mount() so it can use server helpers (_fund_conn,
# _claims_or_401, app, …) without circular imports.
#
# Edit freely; keep using the same helper names as server.py.
# Do NOT import this module for side effects — call financials_api.mount(mod).
# ---------------------------------------------------------------------------

# === extracted from server.py lines 23340-25155 ===
# ═══════════════════════════════════════════════════════════════════════
# Structured financial statements (SEC EDGAR XBRL → queryable Postgres store)
# ─────────────────────────────────────────────────────────────────────────
# The analyst report flow already pulls SEC XBRL data, but throws away the
# parsed numbers after rendering them into prose. This store PERSISTS a
# multi-year quarterly + annual history (income statement, balance sheet,
# cash flow, comprehensive income) so it can be screened across companies,
# charted per company, and cited consistently by the AI Analyst.
# ═══════════════════════════════════════════════════════════════════════
_fin_sync_jobs: dict[str, dict] = {}             # financials sync jobs
# Manual/UI job cap. Overnight batch uses FIN_OVERNIGHT_BUDGET (default 400/night)
# and resumes across nights — never loads the full universe into memory at once.
_FIN_SYNC_CAP = 800
_FIN_UNIVERSE_CACHE: dict[str, tuple] = {}        # key → (epoch, rows)
_FIN_UNIVERSE_TTL_S = 24 * 3600
# Overnight: sequential SEC pulls (1 ticker at a time) → same RAM footprint as
# interactive use. No LLM tokens. Postgres growth is slim numerics only
# (~tens of MB at full US-listed scale). Safe on Railway hobby/pro without
# upsizing the service. Kill switch: FIN_OVERNIGHT_SYNC=0 or automation UI.
_FIN_OVERNIGHT_BUDGET = max(50, min(int(os.environ.get("FIN_OVERNIGHT_BUDGET") or "400"), 800))
_FIN_OVERNIGHT_YEARS = max(3, min(int(os.environ.get("FIN_OVERNIGHT_YEARS") or "6"), 12))
# Chunk size for continuous supervisor — short runs survive Railway restarts better
# than one multi-hour thread. Missing-only; never overwrites stored names.
_FIN_CHUNK_SIZE = max(25, min(int(os.environ.get("FIN_CHUNK_SIZE") or "150"), 400))
_FIN_TICKER_TIMEOUT_S = max(30, min(int(os.environ.get("FIN_TICKER_TIMEOUT_S") or "90"), 180))
_DBX_FIN_BACKUP = "/Financials/company_financials.jsonl.gz"
_FIN_WORKER_LOCK = threading.Lock()
_FIN_WORKER_ACTIVE = False

# Extractor metric name (CamelCase) → DB column (snake_case). Insertion order
# defines the column order used when binding values, so keep them in sync.
_FIN_COLMAP = {
    "Revenue": "revenue", "CostOfRevenue": "cost_of_revenue", "GrossProfit": "gross_profit",
    "OperatingIncome": "operating_income", "NetIncome": "net_income",
    "ComprehensiveIncome": "comprehensive_income",
    "OtherComprehensiveIncome": "other_comprehensive_income",
    "RnD": "rnd", "DepreciationAmortization": "dep_amort",
    "OperatingCashFlow": "operating_cash_flow", "CapEx": "capex",
    "FreeCashFlow": "free_cash_flow", "Dividends": "dividends", "BuybacksCash": "buybacks",
    "EBITDA": "ebitda", "DilutedEPS": "diluted_eps", "DilutedShares": "diluted_shares",
    "SharesOutstanding": "shares_outstanding", "Cash": "cash",
    "ShortTermInvestments": "short_term_investments", "TotalAssets": "total_assets",
    "TotalLiabilities": "total_liabilities", "StockholdersEquity": "stockholders_equity",
    "LongTermDebt": "long_term_debt", "ShortTermDebt": "short_term_debt", "TotalDebt": "total_debt",
    "GrossMargin": "gross_margin", "OperatingMargin": "operating_margin",
    "NetMargin": "net_margin", "EBITDAMargin": "ebitda_margin",
}


def _http_get_text(url: str, timeout: float = 25.0) -> str:
    """Free HTTP GET with a real User-Agent. Falls back to an unverified SSL
    context when the local cert store is broken (common on some macOS Python
    installs); Railway/production normally uses the verified path."""
    import urllib.request
    req = urllib.request.Request(
        url, headers={"User-Agent": "DGACapitalResearch/1.0 (financials-universe; contact@dgacapital.com)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except Exception:
        import ssl
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read().decode("utf-8", "replace")


def _fin_universe_sp500() -> list[dict]:
    """S&P 500 constituents from the free datasets/s-and-p-500-companies CSV
    (GitHub). Includes GICS sector + sub-industry for comps. Cached 24h."""
    cached = _FIN_UNIVERSE_CACHE.get("sp500")
    if cached and (time.time() - cached[0]) < _FIN_UNIVERSE_TTL_S:
        return list(cached[1])
    url = ("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/"
           "master/data/constituents.csv")
    text = _http_get_text(url)
    import csv, io
    rows = []
    rdr = csv.DictReader(io.StringIO(text))
    for r in rdr:
        # Source uses BRK.B / BF.B style — keep as-is (matches SEC / our store).
        sym = (r.get("Symbol") or r.get("symbol") or "").strip().upper()
        sym = sym.replace("-", ".")
        if not sym or not re.match(r"^[A-Z][A-Z0-9.]{0,6}$", sym):
            continue
        rows.append({
            "ticker": sym,
            "name": (r.get("Security") or r.get("Name") or "").strip() or None,
            "sector": (r.get("GICS Sector") or r.get("Sector") or "").strip() or None,
            "industry": (r.get("GICS Sub-Industry") or r.get("Industry") or "").strip() or None,
            "source": "sp500",
        })
    if len(rows) < 400:
        raise RuntimeError(f"S&P 500 list too short ({len(rows)}) — source may have moved")
    _FIN_UNIVERSE_CACHE["sp500"] = (time.time(), rows)
    return list(rows)


def _fin_universe_nasdaq100() -> list[dict]:
    """Nasdaq-100 from Wikipedia (free). Sector column when present. Cached 24h."""
    cached = _FIN_UNIVERSE_CACHE.get("nasdaq100")
    if cached and (time.time() - cached[0]) < _FIN_UNIVERSE_TTL_S:
        return list(cached[1])
    # Wikipedia free page (full Nasdaq Composite listing is ~3–4k names — not
    # offered as a one-click job). Prefer the wikitable whose header has Ticker.
    rows = []
    try:
        html = _http_get_text("https://en.wikipedia.org/wiki/Nasdaq-100")
        tables = re.findall(
            r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?</table>',
            html, re.I)
        body = ""
        for t in tables:
            if re.search(r'Ticker|Symbol', t, re.I):
                body = t
                break
        body = body or (tables[0] if tables else "")
        for tr in re.findall(r'<tr[\s\S]*?</tr>', body, re.I):
            tds = re.findall(r'<td[^>]*>([\s\S]*?)</td>', tr, re.I)
            if not tds:
                continue
            raw = re.sub(r'<[^>]+>', '', tds[0]).strip().upper()
            raw = raw.replace("&amp;", "&").split()[0] if raw else ""
            if not re.match(r"^[A-Z][A-Z0-9.\-]{0,6}$", raw):
                continue
            name = re.sub(r'<[^>]+>', '', tds[1]).strip() if len(tds) > 1 else None
            sector = re.sub(r'<[^>]+>', '', tds[2]).strip() if len(tds) > 2 else None
            rows.append({
                "ticker": raw.replace("-", "."),
                "name": name or None,
                "sector": sector or None,
                "industry": None,
                "source": "nasdaq100",
            })
    except Exception as e:
        print(f"[fin-universe] nasdaq100 wiki failed: {e!s:.140}", flush=True)
        rows = []
    # Dedupe
    seen, out = set(), []
    for r in rows:
        if r["ticker"] in seen:
            continue
        seen.add(r["ticker"])
        out.append(r)
    if len(out) < 80:
        raise RuntimeError(f"Nasdaq-100 list too short ({len(out)}) — source may have moved")
    _FIN_UNIVERSE_CACHE["nasdaq100"] = (time.time(), out)
    return list(out)


def _fin_universe_nasdaq_listed() -> list[dict]:
    """Full Nasdaq-listed common stocks from the free nasdaqtrader.com symbol
    directory (not ETFs, not test issues). ~4k names. Cached 24h."""
    cached = _FIN_UNIVERSE_CACHE.get("nasdaq_listed")
    if cached and (time.time() - cached[0]) < _FIN_UNIVERSE_TTL_S:
        return list(cached[1])
    text = _http_get_text("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt")
    rows = []
    for line in text.splitlines()[1:]:
        if not line or line.startswith("File Creation"):
            continue
        p = line.split("|")
        if len(p) < 8:
            continue
        # Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot|ETF|NextShares
        sym, name, _mkt, test, _fs, _lot, etf = p[0], p[1], p[2], p[3], p[4], p[5], p[6]
        if test == "Y" or etf == "Y":
            continue
        sym = (sym or "").strip().upper()
        if not re.match(r"^[A-Z][A-Z0-9.]{0,6}$", sym):
            continue
        # Skip warrants / units / rights noise when obvious from name
        nl = (name or "").lower()
        if any(x in nl for x in (" warrant", " right", " unit", " preferred")):
            continue
        rows.append({"ticker": sym, "name": (name or "").strip() or None,
                     "sector": None, "industry": None, "source": "nasdaq_listed"})
    if len(rows) < 1000:
        raise RuntimeError(f"Nasdaq listed list too short ({len(rows)})")
    _FIN_UNIVERSE_CACHE["nasdaq_listed"] = (time.time(), rows)
    return list(rows)


def _fin_universe_nyse_listed() -> list[dict]:
    """NYSE / NYSE American / etc. common stocks from free nasdaqtrader
    otherlisted.txt. Covers most of Russell 1000 (large/mid US). Cached 24h."""
    cached = _FIN_UNIVERSE_CACHE.get("nyse_listed")
    if cached and (time.time() - cached[0]) < _FIN_UNIVERSE_TTL_S:
        return list(cached[1])
    text = _http_get_text("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt")
    rows = []
    for line in text.splitlines()[1:]:
        if not line or line.startswith("File Creation"):
            continue
        p = line.split("|")
        if len(p) < 8:
            continue
        # ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot|Test Issue|NASDAQ Symbol
        sym, name, _ex, _cqs, etf, _lot, test = p[0], p[1], p[2], p[3], p[4], p[5], p[6]
        if test == "Y" or etf == "Y":
            continue
        sym = (sym or "").strip().upper()
        # CQS uses dots/spaces; normalize
        sym = sym.replace(" ", "").replace("-", ".")
        if not re.match(r"^[A-Z][A-Z0-9.]{0,6}$", sym):
            continue
        nl = (name or "").lower()
        if any(x in nl for x in (" warrant", " right", " unit", " preferred")):
            continue
        rows.append({"ticker": sym, "name": (name or "").strip() or None,
                     "sector": None, "industry": None, "source": "nyse_listed"})
    if len(rows) < 500:
        raise RuntimeError(f"NYSE/other listed list too short ({len(rows)})")
    _FIN_UNIVERSE_CACHE["nyse_listed"] = (time.time(), rows)
    return list(rows)


def _fin_universe_us_listed() -> list[dict]:
    """Full free US equity directory: Nasdaq + NYSE/AMEX common stocks.
    Supersets full Nasdaq + Russell 1000 for comps (R1000 is not redistributed
    as a free official CSV). Deduped. Cached 24h."""
    cached = _FIN_UNIVERSE_CACHE.get("us_listed")
    if cached and (time.time() - cached[0]) < _FIN_UNIVERSE_TTL_S:
        return list(cached[1])
    by = {}
    for r in _fin_universe_nasdaq_listed() + _fin_universe_nyse_listed():
        t = r["ticker"]
        if t not in by:
            by[t] = r
        else:
            # Prefer keeping a name if the other is blank
            if not by[t].get("name") and r.get("name"):
                by[t]["name"] = r["name"]
    rows = list(by.values())
    _FIN_UNIVERSE_CACHE["us_listed"] = (time.time(), rows)
    return list(rows)


def _fin_universe_rows(universe: str) -> list[dict]:
    """Resolve a named free universe into [{ticker, name, sector, industry}]."""
    u = (universe or "reports").strip().lower()
    if u in ("sp500", "s&p500", "s&p 500"):
        return _fin_universe_sp500()
    if u in ("nasdaq100", "ndx", "nasdaq-100"):
        return _fin_universe_nasdaq100()
    if u in ("sp500_nasdaq100", "sp500+nasdaq100", "broad", "indices"):
        by = {}
        for r in _fin_universe_sp500() + _fin_universe_nasdaq100():
            by[r["ticker"]] = {**by.get(r["ticker"], {}), **{k: v for k, v in r.items() if v}}
            by[r["ticker"]]["ticker"] = r["ticker"]
        return list(by.values())
    if u in ("nasdaq_listed", "nasdaq", "nasdaq_all", "nasdaq_composite"):
        return _fin_universe_nasdaq_listed()
    if u in ("nyse_listed", "nyse", "russell1000", "r1000"):
        # Russell 1000 is not free as an official list; NYSE+AMEX common stocks
        # plus SP500 is the free proxy. True R1000 lives mostly on NYSE/Nasdaq.
        # For "russell1000" we return us_listed (covers it) via alias below.
        if u in ("russell1000", "r1000"):
            return _fin_universe_us_listed()
        return _fin_universe_nyse_listed()
    if u in ("us_listed", "full", "overnight", "nasdaq_russell"):
        return _fin_universe_us_listed()
    return []


def _fin_persist_universe_meta(rows: list[dict]) -> int:
    """Upsert GICS/wiki sector+industry into security_meta so peer comps work
    without a separate market sync. Free data only."""
    if not rows or not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return 0
    n = 0
    try:
        _ensure_market_tables()
        with _fund_conn() as conn, conn.cursor() as cur:
            for r in rows:
                tk = (r.get("ticker") or "").upper()
                if not tk:
                    continue
                if not (r.get("sector") or r.get("industry") or r.get("name")):
                    continue
                _store_meta(cur, tk, {
                    "sector": r.get("sector"),
                    "industry": r.get("industry"),
                    "name": r.get("name"),
                    "source": r.get("source") or "fin-universe",
                })
                n += 1
            conn.commit()
    except Exception as e:
        print(f"[fin-universe] meta persist failed: {e!s:.140}", flush=True)
    return n


def _fin_nightly_enabled() -> bool:
    """Nightly refresh for followed names (reports + watchlist)."""
    env = (os.environ.get("FIN_NIGHTLY") or os.environ.get("FIN_OVERNIGHT_SYNC") or "").strip().lower()
    if env in ("0", "false", "off", "no"):
        return False
    if env in ("1", "true", "on", "yes"):
        return True
    try:
        raw = _kv_get("automation.settings") or {}
        s = _get_automation_settings()
        if "fin_nightly" in raw:
            return bool(s.get("fin_nightly", {}).get("enabled", True))
        # Fall back to legacy fin_overnight key if never migrated
        if "fin_overnight" in raw:
            return bool(s.get("fin_overnight", {}).get("enabled", True))
        return bool(s.get("fin_nightly", {}).get("enabled", True))
    except Exception:
        return True


def _fin_monthly_enabled() -> bool:
    env = (os.environ.get("FIN_MONTHLY") or "").strip().lower()
    if env in ("0", "false", "off", "no"):
        return False
    if env in ("1", "true", "on", "yes"):
        return True
    try:
        return bool(_get_automation_settings().get("fin_monthly", {}).get("enabled", True))
    except Exception:
        return True


def _fin_us_backfill_enabled() -> bool:
    """Continuous full-US chunk supervisor — OFF by default (keeps Railway quiet)."""
    env = (os.environ.get("FIN_US_BACKFILL") or "").strip().lower()
    if env in ("0", "false", "off", "no"):
        return False
    if env in ("1", "true", "on", "yes"):
        return True
    try:
        return bool(_get_automation_settings().get("fin_us_backfill", {}).get("enabled", False))
    except Exception:
        return False


def _fin_overnight_enabled() -> bool:
    """Backward-compat alias → nightly followed refresh."""
    return _fin_nightly_enabled()


def _fin_followed_tickers() -> list[str]:
    """Tickers the GP actually follows: saved reports ∪ all watchlists.
    Small set — safe for nightly SEC refresh without taxing Railway."""
    out: set[str] = set()
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return []
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            try:
                cur.execute("""SELECT DISTINCT UPPER(ticker) FROM analyst_reports
                                WHERE archived IS NOT TRUE AND ticker IS NOT NULL""")
                for (t,) in (cur.fetchall() or []):
                    if t and re.match(r"^[A-Z][A-Z0-9.]{0,6}$", str(t)):
                        out.add(str(t))
            except Exception as e:
                print(f"[fin] followed reports: {e!s:.100}", flush=True)
            try:
                cur.execute("""SELECT DISTINCT UPPER(ticker) FROM watchlists
                                WHERE ticker IS NOT NULL""")
                for (t,) in (cur.fetchall() or []):
                    if t and re.match(r"^[A-Z][A-Z0-9.]{0,6}$", str(t)):
                        out.add(str(t))
            except Exception as e:
                print(f"[fin] followed watchlist: {e!s:.100}", flush=True)
    except Exception as e:
        print(f"[fin] followed tickers failed: {e!s:.120}", flush=True)
    return sorted(out)


def _fin_store_oldest_tickers(limit: int = 200, exclude: set[str] | None = None) -> list[str]:
    """Oldest-updated names already in company_financials (for monthly refresh)."""
    exclude = exclude or set()
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT ticker FROM company_financials
                 GROUP BY ticker
                 ORDER BY MAX(updated_at) ASC NULLS FIRST
                 LIMIT %s
            """, (max(1, min(int(limit), 500)),))
            return [str(r[0]).upper() for r in (cur.fetchall() or [])
                    if r and r[0] and str(r[0]).upper() not in exclude]
    except Exception as e:
        print(f"[fin] oldest tickers failed: {e!s:.120}", flush=True)
        return []


def _run_fin_nightly_followed(job_id: str | None = None) -> dict:
    """Nightly: refresh SEC for followed names only. Insert new periods; never
    overwrite existing period rows. Tiny universe → low Railway cost."""
    years = _FIN_OVERNIGHT_YEARS
    tickers = _fin_followed_tickers()
    jid = job_id or ("FINNIGHT_" + datetime.utcnow().strftime("%Y%m%d"))
    _fin_job_set(jid, stage="queued", status="running",
                 label=f"Nightly my-universe refresh ({len(tickers)} names)…",
                 started_at=time.time(), total=len(tickers), done=0, stored=0,
                 universe="followed")
    if not tickers:
        _fin_job_set(jid, stage="done", status="done",
                     label="✓ Nightly: no saved reports or watchlist tickers",
                     result={"periods_stored": 0, "names": 0})
        return _fin_sync_jobs[jid]
    # skip_if_stored=False → re-hit SEC so NEW quarter/FY period_end can insert
    _run_financials_sync(jid, tickers, years, skip_if_stored=False)
    try:
        _kv_put("fin_nightly.last", {
            "ts": datetime.utcnow().isoformat() + "Z",
            "count": len(tickers),
            "job_id": jid,
            "label": (_fin_sync_jobs.get(jid) or {}).get("label"),
        })
    except Exception:
        pass
    return _fin_sync_jobs.get(jid) or {}


def _run_fin_monthly_store(job_id: str | None = None) -> dict:
    """Monthly: light refresh of the rest of the store (oldest first, exclude
    followed names already covered nightly). Insert-only new periods."""
    years = _FIN_OVERNIGHT_YEARS
    followed = set(_fin_followed_tickers())
    tickers = _fin_store_oldest_tickers(limit=200, exclude=followed)
    jid = job_id or ("FINMONTH_" + datetime.utcnow().strftime("%Y%m"))
    _fin_job_set(jid, stage="queued", status="running",
                 label=f"Monthly store refresh ({len(tickers)} oldest non-followed)…",
                 started_at=time.time(), total=len(tickers), done=0, stored=0,
                 universe="store_monthly")
    if not tickers:
        _fin_job_set(jid, stage="done", status="done",
                     label="✓ Monthly: nothing to refresh",
                     result={"periods_stored": 0, "names": 0})
        return _fin_sync_jobs[jid]
    _run_financials_sync(jid, tickers, years, skip_if_stored=False)
    try:
        ok, info = _dropbox_backup_financials()
        note = f" · ☁️ {info}" if ok else f" · backup skipped ({str(info)[:60]})"
        job = _fin_sync_jobs.get(jid) or {}
        _fin_job_set(jid, label=(job.get("label") or "Monthly done") + note)
        _kv_put("fin_monthly.last", {
            "ts": datetime.utcnow().isoformat() + "Z",
            "count": len(tickers),
            "job_id": jid,
        })
    except Exception:
        pass
    return _fin_sync_jobs.get(jid) or {}


def _fin_pick_overnight_batch(budget: int) -> list[str]:
    """Pick up to `budget` tickers for tonight: never-synced first, then
    oldest updated_at. Pure free universe + DB — no LLM."""
    budget = max(1, min(int(budget or _FIN_OVERNIGHT_BUDGET), 800))
    try:
        universe = [r["ticker"] for r in _fin_universe_us_listed()]
    except Exception as e:
        print(f"[fin-overnight] universe failed, falling back to sp500+ndx: {e!s:.120}", flush=True)
        try:
            universe = [r["ticker"] for r in _fin_universe_rows("sp500_nasdaq100")]
        except Exception:
            universe = []
    if not universe:
        return []
    have: dict[str, object] = {}
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT ticker, MAX(updated_at) AS u
                  FROM company_financials
                 GROUP BY ticker
            """)
            for tk, u in (cur.fetchall() or []):
                if tk:
                    have[str(tk).upper()] = u
    except Exception as e:
        print(f"[fin-overnight] coverage lookup failed: {e!s:.120}", flush=True)
    missing = [t for t in universe if t not in have]
    stale = sorted(
        (t for t in universe if t in have),
        key=lambda t: have.get(t) or datetime.min,
    )
    ordered = missing + stale
    return ordered[:budget]


def _dropbox_backup_financials() -> tuple:
    """Gzip JSONL dump of company_financials → Dropbox Financials folder.
    Slim columns only (no metrics_json). Returns (ok, path_or_error)."""
    try:
        dbx = analyst._dropbox_client()
    except Exception as e:
        return False, f"dropbox client error: {e!s:.100}"
    if not dbx:
        return False, "Dropbox not configured"
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return False, "no database"
    try:
        import gzip, io as _io, dropbox as _dx
        cols = ["ticker", "cik", "entity_name", "period_type", "fy", "fp",
                "period_end", "period_start", "filed", "accession", "derived"] + list(_FIN_COLMAP.values())
        buf = _io.BytesIO()
        n = 0
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            # Stream in chunks so we never hold the full table in RAM
            cur.execute(
                f"SELECT {', '.join(cols)} FROM company_financials ORDER BY ticker, period_end")
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                meta = {"exported_at": datetime.utcnow().isoformat() + "Z",
                        "columns": cols, "note": "DGA company_financials slim backup"}
                gz.write((json.dumps({"_meta": meta}) + "\n").encode("utf-8"))
                while True:
                    batch = cur.fetchmany(500)
                    if not batch:
                        break
                    for r in batch:
                        rec = {}
                        for k in cols:
                            v = r.get(k)
                            if hasattr(v, "isoformat"):
                                v = v.isoformat()
                            elif isinstance(v, (int, float)) or v is None or isinstance(v, bool):
                                pass
                            else:
                                try:
                                    v = float(v)
                                except Exception:
                                    v = str(v) if v is not None else None
                            rec[k] = v
                        gz.write((json.dumps(rec, default=str) + "\n").encode("utf-8"))
                        n += 1
        data = buf.getvalue()
        folder = analyst._dropbox_folder() or ""
        path = folder + _DBX_FIN_BACKUP
        # Ensure parent folder exists (idempotent)
        try:
            parent = path.rsplit("/", 1)[0]
            if parent:
                try:
                    dbx.files_create_folder_v2(parent)
                except Exception:
                    pass
        except Exception:
            pass
        dbx.files_upload(data, path, mode=_dx.files.WriteMode.overwrite)
        return True, f"{path} ({len(data) // 1024} KB, {n} rows)"
    except Exception as e:
        return False, f"upload failed: {e!s:.160}"


def _run_fin_overnight(job_id: str | None = None) -> dict:
    """One overnight batch: pull SEC for budget tickers, then Dropbox backup.
    Sequential, slim, free — designed for Railway without memory upsizing.

    If true gaps remain → missing-only fill (skip stored).
    If coverage is full → light refresh of oldest names so NEW quarter/FY
    period_end rows can insert (existing periods still not overwritten)."""
    budget = _FIN_OVERNIGHT_BUDGET
    years = _FIN_OVERNIGHT_YEARS
    tickers = _fin_pick_overnight_batch(budget)
    # Are we still filling gaps, or maintenance-refreshing known names?
    try:
        still_missing, _, _ = _fin_missing_tickers()
        refresh_mode = len(still_missing) == 0
    except Exception:
        refresh_mode = False
    jid = job_id or ("FINOVER_" + datetime.utcnow().strftime("%Y%m%d") + "_" + str(int(time.time()) % 100000))
    _fin_sync_jobs[jid] = {
        "stage": "queued", "status": "running",
        "label": (f"Overnight refresh ({len(tickers)} oldest)…" if refresh_mode
                  else f"Overnight fill ({len(tickers)} missing)…"),
        "started_at": time.time(), "updated_at": time.time(),
        "total": len(tickers), "done": 0, "stored": 0, "universe": "us_listed_overnight",
    }
    if not tickers:
        _fin_sync_jobs[jid].update(stage="done", status="done",
                                   label="✓ Overnight: nothing to pull (universe empty or all fresh)",
                                   result={"periods_stored": 0, "names": 0, "backup": None})
        return _fin_sync_jobs[jid]
    # Seed names into security_meta when we have them (nasdaq/nyse lists)
    try:
        meta = {r["ticker"]: r for r in _fin_universe_us_listed()}
        _fin_persist_universe_meta([meta[t] for t in tickers if t in meta])
    except Exception:
        pass
    # refresh_mode must re-hit SEC so new period_end rows can insert
    _run_financials_sync(jid, tickers, years, skip_if_stored=not refresh_mode)
    # Dropbox backup after the batch (best-effort)
    backup_note = ""
    try:
        _fin_sync_jobs[jid] = {**(_fin_sync_jobs.get(jid) or {}),
                               "stage": "backup", "label": "☁️ Backing up financials to Dropbox…",
                               "updated_at": time.time()}
        ok, info = _dropbox_backup_financials()
        backup_note = f" · ☁️ {info}" if ok else f" · backup skipped ({str(info)[:80]})"
        print(f"[fin-overnight] dropbox backup: ok={ok} {info}", flush=True)
    except Exception as e:
        backup_note = f" · backup error ({e!s:.60})"
    job = _fin_sync_jobs.get(jid) or {}
    label = (job.get("label") or "Overnight done") + backup_note
    result = dict(job.get("result") or {})
    result["backup"] = backup_note
    result["tickers_attempted"] = len(tickers)
    _fin_sync_jobs[jid] = {**job, "label": label, "result": result,
                           "stage": "done", "status": job.get("status") or "done",
                           "updated_at": time.time()}
    return _fin_sync_jobs[jid]


@_ddl_once
def _ensure_financials_table() -> None:
    """Create the company_financials store. Idempotent. PK is (ticker,
    period_type, period_end) — robust to non-calendar filers whose fiscal-year
    end coincides with a calendar-quarter end (the annual and the Q row share an
    end date but differ in period_type)."""
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return
    num_cols = ",\n                    ".join(f"{c} NUMERIC" for c in _FIN_COLMAP.values())
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS company_financials (
                    ticker        TEXT NOT NULL,
                    cik           TEXT,
                    entity_name   TEXT,
                    period_type   TEXT NOT NULL,
                    fy            INTEGER NOT NULL,
                    fp            TEXT NOT NULL,
                    period_end    DATE NOT NULL,
                    period_start  DATE,
                    filed         DATE,
                    accession     TEXT,
                    derived       BOOLEAN DEFAULT FALSE,
                    {num_cols},
                    metrics_json  JSONB,
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (ticker, period_type, period_end)
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS company_fin_ticker_idx ON company_financials(ticker, period_end DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS company_fin_period_idx ON company_financials(period_type, period_end DESC)")
            conn.commit()
    except Exception as e:
        print(f"❌ _ensure_financials_table failed: {e!s:.300}", flush=True)


def _store_financials_rows(ticker: str, cik, entity_name, rows: list,
                           overwrite: bool = False) -> int:
    """Insert financials rows for one ticker. Returns count of NEW rows written.

    Default is insert-only (ON CONFLICT DO NOTHING) so a resume/retry never
    clobbers periods we already stored. Pass overwrite=True only for an
    explicit re-sync of a single name."""
    if not rows:
        return 0
    meta_cols = ["ticker", "cik", "entity_name", "period_type", "fy", "fp",
                 "period_end", "period_start", "filed", "accession", "derived"]
    num_cols = list(_FIN_COLMAP.values())
    all_cols = meta_cols + num_cols + ["metrics_json"]
    ph = ",".join(["%s"] * len(all_cols))
    if overwrite:
        upd = [c for c in all_cols if c not in ("ticker", "period_type", "period_end")]
        set_clause = ",".join(f"{c}=EXCLUDED.{c}" for c in upd) + ", updated_at=now()"
        conflict = f"ON CONFLICT (ticker, period_type, period_end) DO UPDATE SET {set_clause}"
    else:
        conflict = "ON CONFLICT (ticker, period_type, period_end) DO NOTHING"
    sql = (f"INSERT INTO company_financials ({','.join(all_cols)}) VALUES ({ph}) "
           f"{conflict}")
    def _num(v):
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    n = 0
    with _fund_conn() as conn, conn.cursor() as cur:
        for r in rows:
            end = r.get("end")
            if not end or r.get("fy") is None:
                continue
            vals = [ticker.upper(), (cik or None), (entity_name or None),
                    r.get("period_type"), int(r.get("fy")), r.get("fp"), end,
                    (r.get("start") or None), (r.get("filed") or None),
                    (r.get("accession") or None), bool(r.get("derived"))]
            vals += [_num(r.get(metric)) for metric in _FIN_COLMAP]
            # metrics_json is unused by the dashboard/comps path and roughly
            # doubles row size — keep NULL to stay lean at S&P-scale coverage.
            vals.append(None)
            cur.execute(sql, vals)
            n += max(0, cur.rowcount or 0)
        conn.commit()
    return n


def _fin_ticker_already_stored(ticker: str) -> bool:
    """True if we already have any company_financials rows for this ticker."""
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM company_financials WHERE ticker=%s LIMIT 1",
                (ticker.upper(),))
            return cur.fetchone() is not None
    except Exception:
        return False


def _ensure_fin_skip_table() -> None:
    """Tickers we tried and got no usable XBRL — so the supervisor does not
    retry them forever (would burn Railway CPU for no gain)."""
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS company_financials_skip (
                    ticker     TEXT PRIMARY KEY,
                    reason     TEXT,
                    attempts   INTEGER DEFAULT 1,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            conn.commit()
    except Exception as e:
        print(f"[fin] skip table ensure failed: {e!s:.120}", flush=True)


def _fin_mark_no_data(ticker: str, reason: str = "no usable SEC XBRL") -> None:
    """Record that this ticker was attempted and produced nothing — stop retrying."""
    if not ticker:
        return
    try:
        _ensure_fin_skip_table()
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO company_financials_skip (ticker, reason, attempts, updated_at)
                VALUES (%s, %s, 1, now())
                ON CONFLICT (ticker) DO UPDATE SET
                  reason=EXCLUDED.reason,
                  attempts=company_financials_skip.attempts + 1,
                  updated_at=now()
            """, (ticker.upper(), (reason or "")[:200]))
            conn.commit()
    except Exception as e:
        print(f"[fin] mark no-data {ticker}: {e!s:.100}", flush=True)


def _fin_skip_set() -> set[str]:
    try:
        _ensure_fin_skip_table()
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT ticker FROM company_financials_skip")
            return {str(r[0]).upper() for r in (cur.fetchall() or []) if r and r[0]}
    except Exception:
        return set()


def _fin_is_rate_limit_error(msg: str) -> bool:
    m = (msg or "").lower()
    return any(x in m for x in ("429", "rate limit", "rate-limit", "too many requests",
                                "throttle", "slow down"))


def _sync_one_ticker_financials(ticker: str, years_back: int = 10,
                                max_rate_retries: int = 3,
                                skip_if_stored: bool = True) -> dict:
    """Pull SEC XBRL history for one ticker and persist it. Returns
    {stored, periods, entity, errors, rate_limited?, skipped?}.

    skip_if_stored=True (default): if any rows already exist for this ticker,
    do nothing — resume never re-hits or overwrites completed names.

    Hard timeout per ticker (default 90s) so a hung SEC call cannot stall the
    whole batch. Rate-limit waits capped at 2 min so progress keeps moving."""
    if skip_if_stored and _fin_ticker_already_stored(ticker):
        return {"stored": 0, "periods": 0, "skipped": True, "errors": []}
    import sec_edgar_xbrl as _edgar
    try:
        ua = analyst.get_sec_user_agent()
    except Exception as e:
        return {"stored": 0, "periods": 0, "errors": [f"SEC_USER_AGENT not set: {e!s:.80}"]}
    waits = (30, 60, 120)   # keep bulk jobs moving — 10m freezes looked "stalled"
    last_err = None
    for attempt in range(max(1, max_rate_retries)):
        try:
            # requests timeouts inside sec_edgar_xbrl bound each HTTP call; keep
            # outer retries short so a bad ticker cannot stall the chunk forever.
            res = _edgar.extract_financials_history(
                ticker, years_back=years_back, user_agent=ua)
            rows = res.get("rows") or []
            try:
                # Insert-only — never clobber periods already in the store
                stored = _store_financials_rows(
                    ticker, res.get("cik"), res.get("entity_name"), rows,
                    overwrite=False)
            except Exception as e:
                return {"stored": 0, "periods": len(rows),
                        "errors": [f"{ticker} store failed: {e!s:.120}"]}
            return {"stored": stored, "periods": len(rows),
                    "entity": res.get("entity_name"),
                    "errors": res.get("errors") or []}
        except Exception as e:
            last_err = e
            msg = str(e)
            if _fin_is_rate_limit_error(msg) and attempt < max_rate_retries - 1:
                wait = waits[min(attempt, len(waits) - 1)]
                print(f"[fin sync] rate limited on {ticker} — waiting {wait}s "
                      f"(retry {attempt+1}/{max_rate_retries})", flush=True)
                time.sleep(wait)
                continue
            return {"stored": 0, "periods": 0,
                    "errors": [f"{ticker}: {msg[:140]}"],
                    "rate_limited": _fin_is_rate_limit_error(msg)}
    return {"stored": 0, "periods": 0,
            "errors": [f"{ticker}: {str(last_err)[:140]}"], "rate_limited": True}


def _fin_job_set(job_id: str, **kw) -> None:
    """Update in-memory job + durable kv checkpoint so restarts can resume."""
    prev = _fin_sync_jobs.get(job_id) or {}
    rec = {**prev, **kw, "updated_at": time.time(), "job_id": job_id}
    _fin_sync_jobs[job_id] = rec
    # Checkpoint every update for full pulls (cheap kv write) so client timeouts
    # / deploys don't lose the "still running" signal.
    try:
        if str(job_id).startswith(("FINFULL", "FINCHUNK")) or rec.get("universe") in (
                "us_listed_full", "us_listed_overnight"):
            _kv_put("fin_full_pull.checkpoint", {
                "job_id": job_id,
                "status": rec.get("status"),
                "stage": rec.get("stage"),
                "label": (rec.get("label") or "")[:240],
                "done": rec.get("done"),
                "total": rec.get("total"),
                "stored": rec.get("stored"),
                "names_ok": rec.get("names_ok"),
                "ts": datetime.utcnow().isoformat() + "Z",
            })
            # Keep durable lease alive while running so supervisor doesn't
            # double-launch — and so a dead process's lease expires in ~3 min.
            if (rec.get("status") or "").lower() in (
                    "running", "syncing", "preparing", "queued", "backup"):
                _fin_lease_heartbeat(job_id)
            elif (rec.get("status") or "").lower() in ("done", "error"):
                _fin_lease_clear(job_id)
    except Exception:
        pass


def _run_financials_sync(job_id: str, tickers: list, years_back: int,
                         skip_if_stored: bool = True) -> None:
    """Background worker: build/refresh the structured financials store.
    Polite to SEC; pauses longer after rate-limit hits then continues.
    Never depends on the browser staying open — progress is server-side.

    skip_if_stored=True  → initial fill / resume (don't re-touch completed names)
    skip_if_stored=False → maintenance refresh (re-hit SEC; insert-only still
                           means existing periods are not overwritten, but NEW
                           quarter/FY period_end rows can land)
    """
    def _set(**kw):
        _fin_job_set(job_id, **kw)
    # Preserve total if caller already set it; do NOT flash a dead "Queued…" label
    # for minutes while the first SEC XBRL extract runs (can take 15–60s).
    existing = _fin_sync_jobs.get(job_id) or {}
    _set(stage="syncing", status="running",
         label=existing.get("label") or f"Starting ({len(tickers)} names)…",
         started_at=existing.get("started_at") or time.time(),
         total=existing.get("total") or len(tickers),
         done=existing.get("done") or 0,
         stored=existing.get("stored") or 0)
    try:
        _ensure_financials_table()
        total_stored = int(existing.get("stored") or 0)
        names_ok = int(existing.get("names_ok") or 0)
        names_fail = int(existing.get("names_fail") or 0)
        names_skip = int(existing.get("names_skip") or 0)
        all_errors = []
        consecutive_rl = 0
        # Support resume: skip tickers already done this run if checkpoint has cursor
        start_i = int(existing.get("done") or 0)
        if start_i < 0 or start_i > len(tickers):
            start_i = 0
        for i in range(start_i, len(tickers)):
            tk = tickers[i]
            # Update BEFORE the SEC call so UI never sits on 0/N with "Queued"
            _set(stage="syncing", status="running",
                 label=f"📊 Pulling {tk} ({i+1}/{len(tickers)}) · "
                       f"+{names_ok} new names this chunk…",
                 done=i, current=tk, names_ok=names_ok,
                 names_fail=names_fail, names_skip=names_skip)
            advance_cursor = True  # set False only if we want to hard-retry same tk
            try:
                r = _sync_one_ticker_financials(tk, years_back=years_back,
                                                skip_if_stored=skip_if_stored)
                if r.get("skipped"):
                    names_skip += 1
                    consecutive_rl = 0
                    _set(stored=total_stored, done=i + 1, names_ok=names_ok,
                         names_skip=names_skip, names_fail=names_fail,
                         label=f"↷ Skip {tk} (already stored) ({i+1}/{len(tickers)}) "
                               f"· +{names_ok} new")
                    _fin_advance_cursor(tk)
                    continue
                periods = int(r.get("stored") or 0)
                total_stored += periods
                # A name "lands" if we wrote ≥1 period OR SEC returned periods
                # that were already present (DO NOTHING) but ticker is now known.
                if periods > 0 or (r.get("periods") and not r.get("errors")):
                    if periods > 0:
                        names_ok += 1
                    elif r.get("periods"):
                        names_ok += 1
                    consecutive_rl = 0
                elif r.get("rate_limited"):
                    names_fail += 1
                    # Still advance cursor so a deploy doesn't replay the same
                    # rate-limited head forever; supervisor will come back around.
                elif r.get("timed_out"):
                    names_fail += 1
                elif r.get("errors"):
                    names_fail += 1
                    err0 = " ".join(r.get("errors") or [])
                    if any(x in err0.lower() for x in (
                            "no xbrl", "no periods", "not found", "no companyfacts",
                            "unknown cik", "no data", "0 periods")):
                        _fin_mark_no_data(tk, err0[:180])
                    elif not r.get("periods"):
                        _fin_mark_no_data(tk, err0[:180] or "empty SEC result")
                else:
                    names_fail += 1
                    _fin_mark_no_data(tk, "no usable periods in SEC extract")
                for e in (r.get("errors") or [])[:1]:
                    all_errors.append(f"{tk}: {e}")
                if r.get("timed_out"):
                    consecutive_rl = 0
                    time.sleep(0.2)
                elif r.get("rate_limited"):
                    consecutive_rl += 1
                    cool = min(120, 20 * consecutive_rl)
                    _set(label=f"⏳ Rate limited after {tk} — waiting {cool}s "
                               f"({i+1}/{len(tickers)}) · +{names_ok} new…")
                    print(f"[fin sync] cool-down {cool}s after rate limit "
                          f"(streak={consecutive_rl})", flush=True)
                    time.sleep(cool)
                else:
                    time.sleep(0.35)
            except Exception as e:
                names_fail += 1
                all_errors.append(f"{tk}: {e!s:.100}")
                print(f"⚠️ [fin sync {tk}] {e!s:.150}", flush=True)
                time.sleep(0.5)
            if advance_cursor:
                _fin_advance_cursor(tk)
            _set(stored=total_stored, done=i + 1, names_ok=names_ok,
                 names_fail=names_fail, names_skip=names_skip,
                 label=f"📊 {tk} done ({i+1}/{len(tickers)}) · "
                       f"+{names_ok} new · {names_fail} no-data/err")
        if names_ok > 0 or total_stored > 0:
            label = (f"✓ +{names_ok} names / {total_stored} new periods "
                     f"({names_fail} no-data, {names_skip} skipped)")
        else:
            label = (f"⚠ 0 new names this chunk — "
                     f"{(all_errors[0] if all_errors else 'SEC returned no usable data')[:150]}")
        _set(stage="done", status="done", done=len(tickers), label=label,
             names_ok=names_ok, names_fail=names_fail, names_skip=names_skip,
             result={"periods_stored": total_stored, "names": names_ok,
                     "names_fail": names_fail, "names_skip": names_skip,
                     "errors": all_errors[:20]})
    except Exception as e:
        print(f"❌ [fin sync {job_id}] {e!s:.300}", flush=True)
        _set(stage="error", status="error", label=f"❌ {e!s:.200}", error=str(e))


def _fin_missing_tickers() -> tuple[list[str], int, int]:
    """Return (missing_tickers, have_count, universe_count).

    Missing = on free US list AND not in company_financials AND not on the
    no-data skip list. Already-stored names are never re-queued. Tickers we
    already tried with zero usable XBRL are skipped so the supervisor can
    actually finish and stop burning Railway CPU."""
    universe = [r["ticker"] for r in _fin_universe_us_listed()]
    have: set[str] = set()
    with _fund_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT ticker FROM company_financials")
        have = {str(r[0]).upper() for r in (cur.fetchall() or []) if r and r[0]}
    skip = _fin_skip_set()
    missing = [t for t in universe if t not in have and t not in skip]
    return missing, len(have), len(universe)


def _fin_get_cursor() -> str | None:
    """Durable resume cursor: last ticker we finished processing (any outcome
    except mid-rate-limit). Survives Railway deploys so we don't re-start the
    same head-of-queue chunk after every push."""
    try:
        rec = _kv_get("fin_full_pull.cursor") or {}
        t = (rec.get("after_ticker") or "").strip().upper()
        return t or None
    except Exception:
        return None


def _fin_advance_cursor(ticker: str) -> None:
    if not ticker:
        return
    try:
        _kv_put("fin_full_pull.cursor", {
            "after_ticker": ticker.upper(),
            "ts": datetime.utcnow().isoformat() + "Z",
        })
    except Exception:
        pass


def _fin_chunk_from_missing(missing: list[str], max_names: int) -> list[str]:
    """Take the next `max_names` from missing, starting AFTER the durable cursor.
    Wraps to the start of the list when the cursor is past the end — so deploys
    continue forward instead of replaying the same first 150 forever."""
    if not missing or max_names <= 0:
        return []
    n = len(missing)
    cap = min(int(max_names), n)
    cursor = _fin_get_cursor()
    start = 0
    if cursor:
        # Prefer exact position; else first ticker strictly after cursor in list order
        try:
            start = missing.index(cursor) + 1
        except ValueError:
            start = 0
            for i, t in enumerate(missing):
                if t > cursor:
                    start = i
                    break
            else:
                start = 0  # wrap
    if start >= n:
        start = 0
    chunk = missing[start: start + cap]
    if len(chunk) < cap and start > 0:
        chunk = chunk + missing[: cap - len(chunk)]
    return chunk


def _fin_pull_seems_stalled(max_idle_min: float = 5.0) -> bool:
    """True if a full-pull checkpoint looks abandoned (no update for max_idle_min)
    while coverage is still incomplete. Used to auto-resume after Railway
    restarts or hung workers."""
    try:
        missing, have_n, uni_n = _fin_missing_tickers()
        if not missing:
            return False
        # Live in-memory job with a fresh heartbeat → not stalled
        now = time.time()
        for jid, j in list(_fin_sync_jobs.items()):
            if not str(jid).startswith(("FINFULL", "FINCHUNK")):
                continue
            if (j.get("status") == "running"
                    and now - float(j.get("updated_at") or 0) < max_idle_min * 60):
                return False
        cp = _kv_get("fin_full_pull.checkpoint") or {}
        ts = cp.get("ts")
        if not ts:
            return have_n > 0   # progress made, gaps remain, no live checkpoint
        from datetime import datetime as _dt
        age_min = (_dt.utcnow() - _dt.fromisoformat(
            str(ts).replace("Z", "")).replace(tzinfo=None)).total_seconds() / 60.0
        status = (cp.get("status") or "").lower()
        if status == "done" and missing:
            return True
        if age_min >= max_idle_min:
            return True
        return False
    except Exception as e:
        print(f"[fin] stall check failed: {e!s:.120}", flush=True)
        return False


def _run_fin_full_pull(job_id: str | None = None, years_back: int | None = None,
                       max_names: int | None = None) -> dict:
    """Pull never-synced US-listed names (missing-only), then optional backup.

    max_names: if set, only process that many missing tickers this run (chunk).
    Supervisor chains chunks until the store is full. Already-stored names are
    never re-fetched or overwritten (insert-only + skip_if_stored)."""
    global _FIN_WORKER_ACTIVE
    years = years_back if years_back is not None else _FIN_OVERNIGHT_YEARS
    chunk_cap = max_names  # None = all missing
    jid = job_id or ("FINFULL_" + datetime.utcnow().strftime("%Y%m%d_%H%M%S"))
    _fin_job_set(jid, stage="preparing", status="running",
                 label="📋 Building missing-only list (will not touch stored names)…",
                 started_at=time.time(), total=0, done=0, stored=0,
                 universe="us_listed_full")
    tickers: list[str] = []
    have_n = uni_n = total_missing = 0
    try:
        _fin_job_set(jid, label="📋 Resolving missing list (cursor-aware)…")
        missing_all, have_n, uni_n = _fin_missing_tickers()
        total_missing = len(missing_all)
        if chunk_cap is not None and chunk_cap > 0:
            # CRITICAL: do NOT always take missing[:150] — that restarts the
            # same head after every Railway deploy. Advance via durable cursor.
            tickers = _fin_chunk_from_missing(missing_all, int(chunk_cap))
        else:
            tickers = missing_all
        cur = _fin_get_cursor() or "—"
        _fin_job_set(
            jid,
            label=f"📋 Store {have_n:,} · chunk {len(tickers):,} of "
                  f"{total_missing:,} missing · after {cur}")
    except Exception as e:
        print(f"[fin-full] missing-list failed: {e!s:.160}", flush=True)
        tickers, have_n, uni_n = [], 0, 0
        try:
            missing_all, have_n, uni_n = _fin_missing_tickers()
            total_missing = len(missing_all)
            tickers = (_fin_chunk_from_missing(missing_all, int(chunk_cap))
                       if chunk_cap else missing_all)
        except Exception:
            pass

    _fin_job_set(jid, total=len(tickers), done=0,
                 label=f"🚀 Chunk — {len(tickers):,} missing "
                       f"(keeping {have_n:,} stored · cursor {_fin_get_cursor() or 'start'})…")
    if not tickers:
        _fin_job_set(jid, stage="done", status="done",
                     label=f"✓ Store complete ({have_n:,} names) — nothing missing",
                     result={"periods_stored": 0, "names": 0, "have": have_n})
        return _fin_sync_jobs[jid]

    print(f"[fin-full] RESUME chunk: have={have_n} missing_total={total_missing} "
          f"chunk={len(tickers)} first={tickers[0]} last={tickers[-1]} "
          f"cursor={_fin_get_cursor()} years={years} job={jid}", flush=True)
    try:
        _run_financials_sync(jid, tickers, years)
    except Exception as e:
        print(f"[fin-full] sync crashed: {e!s:.200}", flush=True)
        _fin_job_set(jid, stage="error", status="error",
                     label=f"❌ chunk error: {e!s:.160}", error=str(e)[:200])

    # Backup only when remaining missing is small — avoids Dropbox spam every chunk.
    backup_note = ""
    remaining: list[str] = []
    have_now = have_n
    try:
        remaining, have_now, _ = _fin_missing_tickers()
        do_backup = (chunk_cap is None) or (len(remaining) == 0) or (len(remaining) < 50)
        if do_backup:
            _fin_job_set(jid, stage="backup",
                         label="☁️ Backing up financials to Dropbox…")
            ok, info = _dropbox_backup_financials()
            backup_note = f" · ☁️ {info}" if ok else f" · backup skipped ({str(info)[:80]})"
        else:
            backup_note = f" · {len(remaining):,} still missing (next chunk will continue)"
    except Exception as e:
        backup_note = f" · post-chunk error ({e!s:.60})"

    job = _fin_sync_jobs.get(jid) or {}
    label = (job.get("label") or "Chunk done") + backup_note
    result = dict(job.get("result") or {})
    result["backup"] = backup_note
    result["tickers_attempted"] = len(tickers)
    result["have_after"] = have_now
    result["missing_after"] = len(remaining)
    _fin_job_set(jid, label=label, result=result, stage="done",
                 status="done" if job.get("status") != "error" else "error")
    try:
        _kv_put("fin_full_pull.last", {
            "ts": datetime.utcnow().isoformat() + "Z",
            "tickers": len(tickers),
            "label": label[:300],
            "job_id": jid,
            "have": result.get("have_after"),
            "missing": result.get("missing_after"),
        })
    except Exception:
        pass
    return _fin_sync_jobs[jid]


def _fin_lease_age_s() -> float | None:
    """Seconds since durable worker lease was last heartbeated. None if no lease."""
    try:
        lease = _kv_get("fin_full_pull.lease") or {}
        ts = lease.get("ts")
        if not ts:
            return None
        from datetime import datetime as _dt
        return (_dt.utcnow() - _dt.fromisoformat(
            str(ts).replace("Z", "")).replace(tzinfo=None)).total_seconds()
    except Exception:
        return None


def _fin_lease_is_live(max_age_s: float = 180.0) -> bool:
    """True if another worker heartbeated the lease within max_age_s.
    After a deploy the old process is dead — lease goes stale in ≤3 min and
    a new chunk is allowed. Prevents stuck _FIN_WORKER_ACTIVE forever."""
    age = _fin_lease_age_s()
    if age is None:
        return False
    return age < max_age_s


def _fin_lease_heartbeat(job_id: str) -> None:
    try:
        _kv_put("fin_full_pull.lease", {
            "job_id": job_id,
            "ts": datetime.utcnow().isoformat() + "Z",
            "pid": os.getpid(),
        })
    except Exception:
        pass


def _fin_lease_clear(job_id: str | None = None) -> None:
    try:
        lease = _kv_get("fin_full_pull.lease") or {}
        if job_id and lease.get("job_id") and lease.get("job_id") != job_id:
            return
        _kv_put("fin_full_pull.lease", {"job_id": None, "ts": None})
    except Exception:
        pass


def _fin_start_chunk_async(years: int | None = None, max_names: int | None = None,
                           reason: str = "manual") -> str | None:
    """Start one missing-only chunk in a daemon thread if none is live.

    Durable lease + cursor: survives deploys, never replays the same head
    forever, and cannot wedge on a dead in-memory lock after a hung SEC call."""
    global _FIN_WORKER_ACTIVE
    force = reason in ("manual", "manual-resume", "stall-resume", "force")

    if not _FIN_WORKER_LOCK.acquire(blocking=False):
        return None
    try:
        now = time.time()
        # In-process live job with recent heartbeat
        for jid, j in list(_fin_sync_jobs.items()):
            if (str(jid).startswith(("FINFULL", "FINCHUNK"))
                    and j.get("status") == "running"
                    and now - float(j.get("updated_at") or 0) < 120):
                if not force:
                    return None
        # Durable lease from this or a previous process
        if _fin_lease_is_live(180) and not force:
            print(f"[fin-supervisor] skip launch ({reason}) — lease still live",
                  flush=True)
            return None
        # Force path: steal stale lease
        if force and _fin_lease_is_live(180):
            # Only steal if lease older than 90s (avoid double manual clicks)
            age = _fin_lease_age_s() or 999
            if age < 90:
                print(f"[fin-supervisor] skip force ({reason}) — lease age {age:.0f}s",
                      flush=True)
                return None
        _FIN_WORKER_ACTIVE = True
    finally:
        _FIN_WORKER_LOCK.release()

    import uuid as _uuid
    job_id = "FINCHUNK_" + _uuid.uuid4().hex[:10]
    yrs = years if years is not None else _FIN_OVERNIGHT_YEARS
    cap = max_names if max_names is not None else _FIN_CHUNK_SIZE
    _fin_lease_heartbeat(job_id)

    def _runner():
        global _FIN_WORKER_ACTIVE
        try:
            print(f"[fin-supervisor] starting chunk job={job_id} cap={cap} "
                  f"reason={reason} cursor={_fin_get_cursor()}", flush=True)
            _run_fin_full_pull(job_id, yrs, max_names=cap)
        except Exception as e:
            print(f"[fin-supervisor] chunk failed: {e!s:.200}", flush=True)
        finally:
            _fin_lease_clear(job_id)
            with _FIN_WORKER_LOCK:
                _FIN_WORKER_ACTIVE = False

    cur = _fin_get_cursor() or "start"
    _fin_job_set(job_id, stage="queued", status="running",
                 label=f"Queued chunk ({cap}) after {cur} · {reason}…",
                 started_at=time.time(), total=0, done=0, stored=0,
                 universe="us_listed_full")
    threading.Thread(target=_runner, daemon=True,
                     name=f"fin-chunk-{job_id[-8:]}").start()
    return job_id


def _auto_fin_supervisor_worker() -> None:
    """Optional full-US backfill (OFF by default). Only runs when
    fin_us_backfill is enabled — otherwise sleeps and costs nothing."""
    import time as _time
    _time.sleep(90)
    print("[fin-supervisor] online (US backfill opt-in only)", flush=True)
    while True:
        try:
            if not _fin_us_backfill_enabled():
                _time.sleep(600)  # check toggle every 10 min
                continue
            if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
                _time.sleep(300)
                continue
            try:
                if not analyst.get_sec_user_agent():
                    _time.sleep(600)
                    continue
            except Exception:
                _time.sleep(600)
                continue
            try:
                missing, have_n, uni_n = _fin_missing_tickers()
            except Exception as e:
                print(f"[fin-supervisor] missing list error: {e!s:.120}", flush=True)
                _time.sleep(180)
                continue
            if not missing:
                print(f"[fin-supervisor] US backfill complete have={have_n}/{uni_n}",
                      flush=True)
                _time.sleep(12 * 3600)
                continue
            if _fin_lease_is_live(150):
                _time.sleep(60)
                continue
            jid = _fin_start_chunk_async(max_names=_FIN_CHUNK_SIZE, reason="continue")
            print(f"[fin-supervisor] chunk={jid} have={have_n} missing={len(missing)}",
                  flush=True)
            _time.sleep(90 if jid else 45)
        except Exception as e:
            print(f"[fin-supervisor] loop error: {e!s:.200}", flush=True)
            _time.sleep(120)


# Opt-in US backfill supervisor (disabled by default via fin_us_backfill)
threading.Thread(target=_auto_fin_supervisor_worker, daemon=True,
                 name="fin-supervisor").start()


# Series helpers live in api.domains.financials_series (configure immediately —
# fin schedulers already started above may load series soon after boot).
from api.domains import financials_series as _fin_series
try:
    _fin_series.configure(
        fund_conn=_fund_conn,
        RealDictCursor=globals().get("_RealDictCursor"),
    )
except Exception as _fs_early:
    print(f"[boot] financials_series early configure: {_fs_early!s:.160}", flush=True)


def _fin_rows_for_ticker(ticker: str, period_type: str = "all") -> list:
    """Time series for one ticker, newest first (annual FY de-duped)."""
    return _fin_series._fin_rows_for_ticker(ticker, period_type)


def _fin_dedupe_annual_rows(rows: list) -> list:
    """One annual row per fiscal year — see financials_series module."""
    return _fin_series._fin_dedupe_annual_rows(rows)


@app.get("/api/financials/universes")
def financials_universes(request: Request):
    """Universe counts + low-cost automation status for the Financials store UI.
    Does not hit SEC."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    followed = _fin_followed_tickers()
    out = {
        "followed": {
            "label": "My companies",
            "count": len(followed),
            "note": "Saved reports ∪ watchlist — nightly auto target",
            "sample": followed[:12],
        },
        "reports": {"label": "Saved reports only", "note": "Analyzed names only"},
        "sp500": {"label": "S&P 500", "count": None, "note": "Free GICS list (~503)"},
        "nasdaq100": {"label": "Nasdaq-100", "count": None, "note": "Free Wikipedia list (~100)"},
        "sp500_nasdaq100": {"label": "S&P 500 + Nasdaq-100", "count": None,
                            "note": "Optional comps set (~550) — manual only"},
        "us_listed": {"label": "Full US listed", "count": None,
                      "note": "Opt-in backfill only (fin_us_backfill) — not default"},
        "custom": {"label": "Custom tickers", "note": "Enter symbols in the ticker field"},
        "cap": _FIN_SYNC_CAP,
        "nightly": {
            "enabled": _fin_nightly_enabled(),
            "years_back": _FIN_OVERNIGHT_YEARS,
            "note": "Nightly SEC refresh of followed names only. Insert new periods; never overwrite.",
            "last": _kv_get("fin_nightly.last") or _kv_get("automation.last_run.fin_nightly"),
        },
        "monthly": {
            "enabled": _fin_monthly_enabled(),
            "note": "Once a month: oldest non-followed store names. Insert-only.",
            "last": _kv_get("fin_monthly.last") or _kv_get("automation.last_run.fin_monthly"),
        },
        "us_backfill": {
            "enabled": _fin_us_backfill_enabled(),
            "note": "Continuous full-US gap fill — OFF by default (saves Railway CPU).",
        },
        # Legacy alias for older UI bits
        "overnight": {
            "enabled": _fin_nightly_enabled(),
            "budget_per_night": None,
            "years_back": _FIN_OVERNIGHT_YEARS,
            "note": "Alias of nightly followed refresh (not full US).",
            "last_run": _kv_get("automation.last_run.fin_nightly")
                        or _kv_get("automation.last_run.fin_overnight"),
        },
        "storage": {
            "primary": "Postgres company_financials (queryable, slim numerics)",
            "files": "stock-financials/{TICKER}/ Excel (report pipeline, optional)",
            "dropbox_backup": f"App folder{_DBX_FIN_BACKUP} (gzip JSONL after monthly)",
        },
    }
    for key in ("sp500", "nasdaq100", "sp500_nasdaq100", "us_listed"):
        try:
            out[key]["count"] = len(_fin_universe_rows(key))
        except Exception as e:
            out[key]["error"] = str(e)[:120]
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(DISTINCT ticker) FROM company_financials")
            out["stored_tickers"] = int((cur.fetchone() or [0])[0] or 0)
            cur.execute("SELECT pg_total_relation_size('company_financials')")
            out["stored_bytes"] = int((cur.fetchone() or [0])[0] or 0)
            try:
                cur.execute("SELECT COUNT(DISTINCT ticker) FROM analyst_reports "
                            "WHERE archived IS NOT TRUE AND ticker IS NOT NULL")
                out["reports"]["count"] = int((cur.fetchone() or [0])[0] or 0)
            except Exception:
                pass
    except Exception:
        pass
    return {"ok": True, **out}


@app.post("/api/financials/sync")
def financials_sync(req: Request, background_tasks: BackgroundTasks):
    """Build/refresh the structured financials store from SEC EDGAR XBRL.

    Body: {
      tickers?: string[],          # optional extras / custom list
      years_back?: int,            # default 10 (use 5–7 for bulk index jobs)
      universe?: "reports" | "sp500" | "nasdaq100" | "sp500_nasdaq100" | "custom"
    }

    Storage note: rows land in Postgres `company_financials` (source of truth
    for the dashboard/comps). Dropbox is NOT used as the warehouse — keep it
    for research docs; Postgres is ~tens of MB even at S&P scale and supports
    SQL peer comps. Free index lists also seed security_meta (GICS sector)."""
    claims = _claims_or_401(req)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    try:
        if not analyst.get_sec_user_agent():
            raise ValueError("no UA")
    except Exception:
        return JSONResponse({"ok": False, "error": "SEC_USER_AGENT not configured on server."}, status_code=400)
    try:
        body = _request_json_sync(req)
    except Exception:
        body = {}
    years_back = max(1, min(int((body or {}).get("years_back") or 7), 20))
    universe = str((body or {}).get("universe") or "followed").strip().lower()
    extras = [t.upper().strip() for t in ((body or {}).get("tickers") or []) if t and str(t).strip()]
    # refresh=True (default for manual Sync): re-hit SEC so new quarters insert
    refresh = bool((body or {}).get("refresh", True))
    tickers: list[str] = []
    meta_rows: list[dict] = []
    try:
        if universe in ("custom", "one", "ticker"):
            tickers = list(extras)
            if not tickers:
                return JSONResponse(
                    {"ok": False, "error": "Enter at least one ticker for Custom."},
                    status_code=400)
        elif universe in ("followed", "mine", "my", "watchlist_reports"):
            tickers = _fin_followed_tickers()
            for t in extras:
                if t not in tickers:
                    tickers.append(t)
        elif universe in ("reports", "saved"):
            try:
                with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
                    cur.execute("SELECT ticker FROM analyst_reports WHERE archived IS NOT TRUE ORDER BY ticker")
                    tickers = [r["ticker"].upper() for r in (cur.fetchall() or []) if r.get("ticker")]
            except Exception:
                tickers = []
            for t in extras:
                if t not in tickers:
                    tickers.append(t)
        elif universe in ("sp500", "nasdaq100", "sp500_nasdaq100", "us_listed"):
            meta_rows = _fin_universe_rows(universe)
            base = [r["ticker"] for r in meta_rows]
            for t in extras:
                if t not in base:
                    base.append(t)
            tickers = base
        else:
            tickers = _fin_followed_tickers()
            for t in extras:
                if t not in tickers:
                    tickers.append(t)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Universe resolve failed: {e!s:.160}"}, status_code=400)

    if meta_rows:
        try:
            _fin_persist_universe_meta(meta_rows)
        except Exception as e:
            print(f"[fin sync] meta seed failed: {e!s:.120}", flush=True)

    tickers = [t for t in tickers if t][:_FIN_SYNC_CAP]
    if not tickers:
        return JSONResponse(
            {"ok": False,
             "error": "No tickers to sync. Use My companies (reports+watchlist), "
                      "or Custom with a ticker symbol."},
            status_code=400)
    import uuid as _uuid
    job_id = "FINSYNC_" + _uuid.uuid4().hex[:12]
    _fin_job_set(job_id, stage="queued", status="running",
                 label=f"Sync {universe}: {len(tickers)} names…",
                 started_at=time.time(), total=len(tickers), done=0, stored=0,
                 universe=universe)
    # Manual Sync always refresh-mode so new filings can insert for known names
    threading.Thread(
        target=_run_financials_sync,
        args=(job_id, tickers, years_back),
        kwargs={"skip_if_stored": not refresh},
        daemon=True, name=f"fin-sync-{job_id[-8:]}",
    ).start()
    print(f"📊 [fin sync] {job_id} universe={universe} n={len(tickers)} "
          f"yrs={years_back} refresh={refresh}", flush=True)
    return {"ok": True, "job_id": job_id, "tickers": tickers, "universe": universe,
            "count": len(tickers), "cap": _FIN_SYNC_CAP, "refresh": refresh}


@app.get("/api/financials/sync/{job_id}")
def financials_sync_status(job_id: str, request: Request):
    """Poll a financials sync job. Falls back to durable checkpoint if the
    in-memory job was lost (deploy) so the UI can still show progress / resume."""
    _claims_or_401(request)
    job = _fin_sync_jobs.get(job_id)
    if job:
        return {"ok": True, **job}
    # Durable checkpoint from a full pull (may be this job or a successor)
    try:
        cp = _kv_get("fin_full_pull.checkpoint") or {}
        if cp and (cp.get("job_id") == job_id or str(job_id).startswith("FINFULL")):
            return {"ok": True, "from_checkpoint": True,
                    "status": cp.get("status") or "running",
                    "stage": cp.get("stage") or "syncing",
                    "label": cp.get("label") or "Resuming from checkpoint…",
                    "done": cp.get("done"), "total": cp.get("total"),
                    "stored": cp.get("stored"), "job_id": cp.get("job_id") or job_id}
    except Exception:
        pass
    return JSONResponse({"ok": False, "stage": "idle", "error": "no such job",
                         "resumable": True}, status_code=404)


@app.post("/api/financials/overnight")
def financials_overnight_now(request: Request, background_tasks: BackgroundTasks):
    """Manual financials jobs (GP only). Free SEC — no LLM.

    Body: { mode?: "nightly"|"monthly"|"us_chunk", years_back?: int }
      nightly  (default) — refresh followed names (reports + watchlist)
      monthly            — light refresh of oldest non-followed store names
      us_chunk           — one optional full-US missing chunk (opt-in backfill)
    """
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    try:
        if not analyst.get_sec_user_agent():
            raise ValueError("no UA")
    except Exception:
        return JSONResponse({"ok": False, "error": "SEC_USER_AGENT not configured."}, status_code=400)
    try:
        body = _request_json_sync(request) or {}
    except Exception:
        body = {}
    # Back-compat: full=true → us_chunk
    if body.get("full") is True and not body.get("mode"):
        mode = "us_chunk"
    else:
        mode = str(body.get("mode") or "nightly").strip().lower()
    years = body.get("years_back")
    years = int(years) if years is not None else _FIN_OVERNIGHT_YEARS
    years = max(3, min(years, 12))
    import uuid as _uuid

    if mode in ("nightly", "followed", "mine"):
        job_id = "FINNIGHT_M_" + _uuid.uuid4().hex[:8]
        threading.Thread(target=_run_fin_nightly_followed, args=(job_id,),
                         daemon=True, name=f"fin-night-{job_id[-6:]}").start()
        n = len(_fin_followed_tickers())
        return {"ok": True, "job_id": job_id, "mode": "nightly", "count": n,
                "note": f"Refreshing {n} followed names (reports+watchlist). "
                        f"Insert-only new periods — no overwrite."}

    if mode in ("monthly", "store"):
        job_id = "FINMONTH_M_" + _uuid.uuid4().hex[:8]
        threading.Thread(target=_run_fin_monthly_store, args=(job_id,),
                         daemon=True, name=f"fin-month-{job_id[-6:]}").start()
        return {"ok": True, "job_id": job_id, "mode": "monthly",
                "note": "Monthly store refresh (oldest non-followed). Insert-only."}

    # Optional US backfill chunk
    have_n = miss_n = uni_n = 0
    try:
        miss, have_n, uni_n = _fin_missing_tickers()
        miss_n = len(miss)
    except Exception:
        pass
    job_id = _fin_start_chunk_async(years=years, max_names=_FIN_CHUNK_SIZE, reason="force")
    if not job_id:
        return {"ok": True, "job_id": None, "mode": "us_chunk",
                "have": have_n, "missing": miss_n,
                "note": "US backfill worker busy — try again in a few minutes."}
    return {"ok": True, "job_id": job_id, "mode": "us_chunk", "chunk": _FIN_CHUNK_SIZE,
            "have": have_n, "missing": miss_n, "universe": uni_n,
            "note": f"One US-listed missing chunk ({_FIN_CHUNK_SIZE}). "
                    f"Enable fin_us_backfill for continuous fill. No overwrite."}


@app.get("/api/financials/settings")
def financials_settings_get(request: Request):
    """Nightly / monthly / US-backfill toggles for the Financials store UI."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    s = _get_automation_settings()
    followed = _fin_followed_tickers()
    return {
        "ok": True,
        "followed_count": len(followed),
        "followed_sample": followed[:12],
        "fin_nightly": {
            "enabled": _fin_nightly_enabled(),
            "hour": s.get("fin_nightly", {}).get("hour", 2),
            "minute": s.get("fin_nightly", {}).get("minute", 30),
            "last": _kv_get("fin_nightly.last"),
        },
        "fin_monthly": {
            "enabled": _fin_monthly_enabled(),
            "hour": s.get("fin_monthly", {}).get("hour", 3),
            "minute": s.get("fin_monthly", {}).get("minute", 15),
            "day": s.get("fin_monthly", {}).get("day", 1),
            "last": _kv_get("fin_monthly.last"),
        },
        "fin_us_backfill": {
            "enabled": _fin_us_backfill_enabled(),
            "note": "Off by default. Continuous full-US gap fill — higher CPU.",
        },
    }


@app.post("/api/financials/settings")
def financials_settings_post(request: Request):
    """Update fin_nightly / fin_monthly / fin_us_backfill toggles (GP only)."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    try:
        body = _request_json_sync(request) or {}
    except Exception:
        body = {}
    current = _kv_get("automation.settings") or {}
    for key in ("fin_nightly", "fin_monthly", "fin_us_backfill", "fin_overnight"):
        if key in body and isinstance(body[key], dict):
            prev = dict(current.get(key) or {})
            prev.update({k: body[key][k] for k in body[key]
                         if k in ("enabled", "hour", "minute", "day")})
            if "enabled" in body[key]:
                prev["enabled"] = bool(body[key]["enabled"])
            current[key] = prev
            # Keep legacy fin_overnight in sync with fin_nightly
            if key == "fin_nightly":
                lo = dict(current.get("fin_overnight") or {})
                lo["enabled"] = bool(prev.get("enabled", True))
                if "hour" in prev:
                    lo["hour"] = prev["hour"]
                if "minute" in prev:
                    lo["minute"] = prev["minute"]
                current["fin_overnight"] = lo
    _kv_put("automation.settings", current)
    return financials_settings_get(request)


@app.post("/api/financials/backup")
def financials_backup_now(request: Request):
    """Push a slim gzip JSONL of company_financials to Dropbox now. GP only."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    ok, info = _dropbox_backup_financials()
    if not ok:
        return JSONResponse({"ok": False, "error": info}, status_code=400)
    return {"ok": True, "path": info}


# ── Low-cost financials schedulers (followed nightly + store monthly) ────────
def _auto_fin_nightly_worker() -> None:
    """Daemon: each night refresh SEC filings for FOLLOWED names only
    (saved reports ∪ watchlist). Insert new periods; never overwrite.

    Tiny universe → negligible Railway cost. Viewing dashboards stays free/DB.
    Kill: FIN_NIGHTLY=0 or automation.fin_nightly.enabled=false.
    """
    import time as _time
    _time.sleep(75)  # let DB pool / hydrate finish
    print("[fin-nightly] scheduler online (followed names only)", flush=True)
    while True:
        try:
            if not _fin_nightly_enabled():
                print("[fin-nightly] disabled — sleeping 1h", flush=True)
                _time.sleep(3600)
                continue
            cfg = _get_automation_settings().get(
                "fin_nightly", _DEFAULT_AUTOMATION["fin_nightly"])
            h, m = int(cfg.get("hour", 2)), int(cfg.get("minute", 30))
            wait_secs = _secs_until(h, m)
            print(f"[fin-nightly] next at {h:02d}:{m:02d} PT — "
                  f"sleep {wait_secs/3600:.1f}h", flush=True)
            _time.sleep(wait_secs)
            if not _fin_nightly_enabled():
                continue
            if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
                print("[fin-nightly] no database — skip", flush=True)
                _time.sleep(3600)
                continue
            try:
                if not analyst.get_sec_user_agent():
                    print("[fin-nightly] SEC_USER_AGENT missing — skip", flush=True)
                    _time.sleep(3600)
                    continue
            except Exception:
                print("[fin-nightly] SEC_USER_AGENT missing — skip", flush=True)
                _time.sleep(3600)
                continue
            n = len(_fin_followed_tickers())
            print(f"[fin-nightly] starting followed refresh n={n}", flush=True)
            job = _run_fin_nightly_followed()
            detail = (job.get("label") or "ok")[:400]
            ok = job.get("status") == "done"
            _automation_record_run("fin_nightly", ok, detail)
            # Keep legacy key for older health UIs
            try:
                _automation_record_run("fin_overnight", ok, detail)
            except Exception:
                pass
            print(f"[fin-nightly] finished: {detail}", flush=True)
            _time.sleep(60)
        except Exception as _e:
            print(f"[fin-nightly] error (retry 1h): {_e!s:.200}", flush=True)
            try:
                _automation_record_run("fin_nightly", False, str(_e)[:400])
            except Exception:
                pass
            _time.sleep(3600)


def _auto_fin_monthly_worker() -> None:
    """Daemon: once a month, light refresh of oldest non-followed store names.
    Insert-only new periods. Keeps the warehouse from going fully stale without
    continuous full-US backfill."""
    import time as _time
    _time.sleep(120)
    print("[fin-monthly] scheduler online (oldest non-followed)", flush=True)
    while True:
        try:
            if not _fin_monthly_enabled():
                print("[fin-monthly] disabled — sleeping 6h", flush=True)
                _time.sleep(6 * 3600)
                continue
            cfg = _get_automation_settings().get(
                "fin_monthly", _DEFAULT_AUTOMATION["fin_monthly"])
            day = int(cfg.get("day", 1))
            h, m = int(cfg.get("hour", 3)), int(cfg.get("minute", 15))
            wait_secs = _secs_until_dom(day, h, m)
            print(f"[fin-monthly] next day={day} at {h:02d}:{m:02d} PT — "
                  f"sleep {wait_secs/3600:.1f}h", flush=True)
            _time.sleep(max(60.0, wait_secs))
            if not _fin_monthly_enabled():
                continue
            if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
                _time.sleep(6 * 3600)
                continue
            try:
                if not analyst.get_sec_user_agent():
                    _time.sleep(6 * 3600)
                    continue
            except Exception:
                _time.sleep(6 * 3600)
                continue
            print("[fin-monthly] starting store refresh", flush=True)
            job = _run_fin_monthly_store()
            detail = (job.get("label") or "ok")[:400]
            _automation_record_run("fin_monthly", job.get("status") == "done", detail)
            print(f"[fin-monthly] finished: {detail}", flush=True)
            # Avoid double-fire same calendar day if clock skew / quick restart
            _time.sleep(3600)
        except Exception as _e:
            print(f"[fin-monthly] error (retry 6h): {_e!s:.200}", flush=True)
            try:
                _automation_record_run("fin_monthly", False, str(_e)[:400])
            except Exception:
                pass
            _time.sleep(6 * 3600)


threading.Thread(target=_auto_fin_nightly_worker, daemon=True,
                 name="fin-nightly-scheduler").start()
threading.Thread(target=_auto_fin_monthly_worker, daemon=True,
                 name="fin-monthly-scheduler").start()


# === extracted from server.py lines 25427-27955 ===
# ════════════════════════ Persistent market-data store ════════════════════════
# Quotes + security meta + option chains persisted to Postgres so user-facing
# reads are instant DB lookups, decoupled from the slow/rate-limited live calls
# (the cloud-IP yfinance problem). Source is Yahoo chart → yfinance via market_data.py (free).
# Every reader falls back to a live call when a row is missing, so this is safe
# to deploy before the first sync and degrades gracefully per-symbol.
_market_sync_jobs: dict[str, dict] = {}


@_ddl_once
def _ensure_market_tables():
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return
    with _fund_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS market_quotes (
                symbol        TEXT PRIMARY KEY,
                price         DOUBLE PRECISION,
                prev_close    DOUBLE PRECISION,
                pct_change    DOUBLE PRECISION,
                realized_vol  DOUBLE PRECISION,
                source        TEXT,
                updated_at    TIMESTAMPTZ DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS security_meta (
                symbol         TEXT PRIMARY KEY,
                sector         TEXT,
                industry       TEXT,
                name           TEXT,
                analyst_target DOUBLE PRECISION,
                source         TEXT,
                updated_at     TIMESTAMPTZ DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS option_quotes (
                symbol        TEXT,
                expiration    DATE,
                strike        DOUBLE PRECISION,
                opt_type      TEXT,
                bid           DOUBLE PRECISION,
                ask           DOUBLE PRECISION,
                last          DOUBLE PRECISION,
                iv            DOUBLE PRECISION,
                delta         DOUBLE PRECISION,
                open_interest INTEGER,
                volume        INTEGER,
                source        TEXT,
                updated_at    TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (symbol, expiration, strike, opt_type)
            );
            CREATE INDEX IF NOT EXISTS idx_option_quotes_symbol ON option_quotes(symbol);
            CREATE TABLE IF NOT EXISTS price_history (
                symbol      TEXT,
                d           DATE,
                close       DOUBLE PRECISION,
                source      TEXT,
                updated_at  TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (symbol, d)
            );
            CREATE INDEX IF NOT EXISTS idx_price_history_symbol ON price_history(symbol);
        """)
        conn.commit()


def _store_quote(cur, sym, q, realized_vol=None):
    cur.execute("""INSERT INTO market_quotes
                     (symbol, price, prev_close, pct_change, realized_vol, source, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s, now())
                   ON CONFLICT (symbol) DO UPDATE SET
                     price=EXCLUDED.price, prev_close=EXCLUDED.prev_close,
                     pct_change=EXCLUDED.pct_change,
                     realized_vol=COALESCE(EXCLUDED.realized_vol, market_quotes.realized_vol),
                     source=EXCLUDED.source, updated_at=now()""",
                (sym, q.get("price"), q.get("prev_close"), q.get("pct_change"),
                 realized_vol, q.get("source")))


def _store_meta(cur, sym, m):
    cur.execute("""INSERT INTO security_meta
                     (symbol, sector, industry, name, analyst_target, source, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s, now())
                   ON CONFLICT (symbol) DO UPDATE SET
                     sector=COALESCE(EXCLUDED.sector, security_meta.sector),
                     industry=COALESCE(EXCLUDED.industry, security_meta.industry),
                     name=COALESCE(EXCLUDED.name, security_meta.name),
                     analyst_target=COALESCE(EXCLUDED.analyst_target, security_meta.analyst_target),
                     source=EXCLUDED.source, updated_at=now()""",
                (sym, m.get("sector"), m.get("industry"), m.get("name"),
                 m.get("analyst_target"), m.get("source")))


def _db_quotes(symbols, max_age_s=None) -> dict:
    """{SYM: {price, pct_change}} from market_quotes. If max_age_s is given, only
    rows refreshed within that window are returned (freshness gate for the
    watchlist, which must never show stale prices)."""
    syms = [s.strip().upper() for s in (symbols or []) if s and str(s).strip()]
    if not syms or not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return {}
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            if max_age_s is not None:
                cur.execute("""SELECT symbol, price, pct_change, updated_at FROM market_quotes
                                WHERE symbol = ANY(%s)
                                  AND updated_at > now() - (%s || ' seconds')::interval""",
                            (syms, str(int(max_age_s))))
            else:
                cur.execute("SELECT symbol, price, pct_change, updated_at FROM market_quotes "
                            "WHERE symbol = ANY(%s)", (syms,))
            return {r["symbol"]: {"price": r["price"], "pct_change": r["pct_change"],
                                  "as_of": r["updated_at"].isoformat() if r.get("updated_at") else None}
                    for r in (cur.fetchall() or []) if r.get("price") is not None}
    except Exception as e:
        print(f"[market] db_quotes failed: {e!s:.120}", flush=True)
        return {}


def _quote_one_yahoo_chart(sym: str) -> dict | None:
    """Direct Yahoo chart API (no yfinance). Free, last-resort live price."""
    try:
        import urllib.request
        ysym = _resolve_ticker_alias(sym)
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}"
               f"?range=10d&interval=1d")
        req = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0 DGACapital/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        result = ((data.get("chart") or {}).get("result") or [None])[0]
        if not result:
            return None
        meta = result.get("meta") or {}
        closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
        closes = [float(c) for c in closes if c is not None]
        px = meta.get("regularMarketPrice") or meta.get("postMarketPrice")
        if px is None and closes:
            px = closes[-1]
        # Never chartPreviousClose — range-start close (IBM −29% phantom).
        prev = meta.get("previousClose") or meta.get("regularMarketPreviousClose")
        if prev is None and len(closes) >= 2:
            prev = closes[-2]
        if px is None:
            return None
        pct = meta.get("regularMarketChangePercent")
        if pct is None and prev not in (None, 0):
            pct = (float(px) - float(prev)) / float(prev) * 100.0
        return {"price": float(px), "pct_change": pct, "source": "yahoo-chart"}
    except Exception as e:
        print(f"[fin-comps] yahoo-chart {sym}: {e!s:.100}", flush=True)
        return None


def _quote_one_yfinance_fast(sym: str) -> dict | None:
    """Per-ticker yfinance fast_info / info — when batch download misses."""
    if not _YFINANCE_OK:
        return None
    try:
        import yfinance as yf
        ysym = _resolve_ticker_alias(sym)
        t = yf.Ticker(ysym)
        px = prev = None
        try:
            fi = t.fast_info
            px = getattr(fi, "last_price", None) or getattr(fi, "regular_market_price", None)
            prev = getattr(fi, "previous_close", None)
        except Exception:
            pass
        if px is None:
            try:
                info = t.info or {}
                px = info.get("regularMarketPrice") or info.get("currentPrice") or info.get("previousClose")
                prev = info.get("previousClose") or prev
            except Exception:
                pass
        if px is None:
            return None
        pct = None
        if prev not in (None, 0):
            pct = (float(px) - float(prev)) / float(prev) * 100.0
        return {"price": float(px), "pct_change": pct, "source": "yfinance-fast"}
    except Exception as e:
        print(f"[fin-comps] yf-fast {sym}: {e!s:.100}", flush=True)
        return None


def _warm_quotes_for_comps(symbols: list, cap: int = 16) -> dict:
    """Fill missing prices for comps using multiple free sources.

    Cascade (stop on first hit per ticker):
      1. market_quotes store (any age)
      2. batch_quotes (Yahoo download + Tiingo + store)
      3. market_data.get_quotes (Yahoo chart → optional Tiingo)
      4. yfinance Ticker.fast_info / .info per symbol
      5. Yahoo chart HTTP API

    Never treat a miss as success — keep trying sources. Persist hits so the
    next dashboard load is free. No LLM.
    """
    syms = []
    seen = set()
    for s in (symbols or []):
        t = (s or "").strip().upper()
        if t and t not in seen:
            seen.add(t)
            syms.append(t)
    if not syms:
        return {}
    have = _db_quotes(syms)
    miss = [t for t in syms if t not in have or have[t].get("price") is None]
    miss = miss[: max(1, min(int(cap), 24))]
    if not miss:
        return have

    # 1) batch_quotes — Yahoo batch + Tiingo + any-age store (existing cascade)
    try:
        raw = batch_quotes(",".join(miss)) or {}
        for sym in list(miss):
            q = raw.get(sym) or {}
            if q.get("price") is not None:
                have[sym] = {
                    "price": float(q["price"]),
                    "pct_change": q.get("pct_change"),
                    "source": q.get("source") or "batch_quotes",
                }
        miss = [t for t in miss if t not in have or have[t].get("price") is None]
    except Exception as e:
        print(f"[fin-comps] batch_quotes warm failed: {e!s:.140}", flush=True)

    # 2) market_data (Yahoo chart + optional Tiingo)
    if miss:
        try:
            import market_data as _md
            mdq = _md.get_quotes(miss) or {}
            for sym in list(miss):
                q = mdq.get(sym) or {}
                px = q.get("price") or q.get("last") or q.get("close")
                if px is None:
                    continue
                prev = q.get("prev_close") or q.get("previous_close")
                pct = q.get("pct_change")
                if pct is None and prev not in (None, 0):
                    pct = (float(px) - float(prev)) / float(prev) * 100.0
                have[sym] = {
                    "price": float(px),
                    "pct_change": pct,
                    "source": q.get("source") or "market_data",
                }
            miss = [t for t in miss if t not in have or have[t].get("price") is None]
            if have:
                print(f"[fin-comps] market_data filled {[s for s in have if s in mdq]}", flush=True)
        except Exception as e:
            print(f"[fin-comps] market_data warm failed: {e!s:.140}", flush=True)

    # 3) Per-ticker yfinance fast_info
    if miss:
        for sym in list(miss):
            q = _quote_one_yfinance_fast(sym)
            if q and q.get("price") is not None:
                have[sym] = q
        miss = [t for t in miss if t not in have or have[t].get("price") is None]

    # 4) Yahoo chart HTTP API (works when yfinance packaging fails)
    if miss:
        for sym in list(miss):
            q = _quote_one_yahoo_chart(sym)
            if q and q.get("price") is not None:
                have[sym] = q
        miss = [t for t in miss if t not in have or have[t].get("price") is None]

    if miss:
        print(f"[fin-comps] still no price after all sources: {miss}", flush=True)

    # Persist successful warms for next free load
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            for sym, q in have.items():
                if q.get("price") is None:
                    continue
                if q.get("source") in (None, "store"):
                    continue  # already from DB
                _store_quote(cur, sym, {
                    "price": float(q["price"]),
                    "prev_close": None,
                    "pct_change": q.get("pct_change"),
                    "source": (q.get("source") or "comps-warm")[:40],
                })
            conn.commit()
    except Exception as e:
        print(f"[fin-comps] quote persist failed: {e!s:.140}", flush=True)

    return have


def _db_meta(symbols) -> dict:
    """{SYM: {sector, industry, name, analyst_target}} from security_meta."""
    syms = [s.strip().upper() for s in (symbols or []) if s and str(s).strip()]
    if not syms or not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return {}
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute("""SELECT symbol, sector, industry, name, analyst_target
                             FROM security_meta WHERE symbol = ANY(%s)""", (syms,))
            return {r["symbol"]: {"sector": r.get("sector"), "industry": r.get("industry"),
                                  "name": r.get("name"), "analyst_target": r.get("analyst_target")}
                    for r in (cur.fetchall() or [])}
    except Exception as e:
        print(f"[market] db_meta failed: {e!s:.120}", flush=True)
        return {}


def _run_market_sync(job_id: str, universe: list) -> None:
    """Background worker: refresh QUOTES + SECTORS (+ analyst targets) into the
    persistent store. Sectors come from the SEC SIC code (EDGAR — un-throttled,
    works when Yahoo is slow); quotes from Yahoo chart. Option
    chains and realized-vol are NOT synced — the Options wheel scans those live."""
    import market_data as _md

    def _set(**kw):
        _market_sync_jobs[job_id] = {**(_market_sync_jobs.get(job_id) or {}), **kw,
                                     "updated_at": time.time()}
    total = len(universe)
    _set(stage="syncing", status="running", label="Starting…", total=total, done=0)
    try:
        _ensure_market_tables()
        # 1. Batch quotes for the whole universe (one call).
        # Fetch with provider-format symbols (BRKB→BRK-B), store under the
        # originals — the store previously held wrong-instrument prices for
        # alias symbols, which the any-age quote fallback then served.
        _alias_of = {s: _resolve_ticker_alias(s) for s in universe}
        _q_raw = _builder_call_timeout(
            lambda: _md.get_quotes(list(_alias_of.values())), 25.0, {}) or {}
        quotes = {}
        for _orig, _al in _alias_of.items():
            _qv = _q_raw.get(_al) or _q_raw.get(_al.upper()) or _q_raw.get(_orig)
            if _qv:
                quotes[_orig] = _qv
        with _fund_conn() as conn, conn.cursor() as cur:
            for sym, q in quotes.items():
                _store_quote(cur, sym, q)
            conn.commit()
        # 2. Per-name: sector (EDGAR SIC, reliable) + analyst target (best-effort).
        # Only for names whose stored meta is stale (>24h) — sectors/targets
        # change daily at most, but this loop used to refetch yf .info for the
        # WHOLE universe on every 10-minute market-hours autosync run.
        stale = list(universe)
        try:
            with _fund_conn() as conn, conn.cursor() as cur:
                cur.execute("SELECT symbol FROM security_meta "
                            "WHERE symbol = ANY(%s) AND updated_at > now() - interval '24 hours'",
                            (list(universe),))
                _fresh = {r[0] for r in cur.fetchall()}
            stale = [s for s in universe if s not in _fresh]
        except Exception:
            pass
        sectors_n = 0
        meta_conn = _fund_conn()
        meta_conn.autocommit = True
        meta_cur = meta_conn.cursor()
        try:
            for i, sym in enumerate(stale):
                _set(label=f"⚙ {sym} ({i+1}/{len(stale)})…", done=i)
                sec, ind = _builder_call_timeout(
                    lambda: _builder_resolve_sector_live(sym), 5.0, (None, None))
                target = None
                if _YFINANCE_OK:
                    info = _builder_call_timeout(lambda: (yf.Ticker(sym).info or {}), 6.0, {}) or {}
                    t = info.get("targetMeanPrice") or info.get("targetMedianPrice")
                    try:
                        if t and float(t) > 0:
                            target = float(t)
                    except Exception:
                        pass
                if sec or target:
                    _store_meta(meta_cur, sym, {"sector": sec, "industry": ind, "name": None,
                                                "analyst_target": target, "source": "edgar+yf"})
                    if sec:
                        sectors_n += 1
        finally:
            try:
                meta_cur.close()
                meta_conn.close()
            except Exception:
                pass
        _set(stage="done", status="done", done=total,
             label=f"✓ Synced {len(quotes)} quotes · {sectors_n}/{len(stale) or 1} sectors refreshed ({len(universe)-len(stale)} fresh)",
             result={"quotes": len(quotes), "names": total, "sectors": sectors_n,
                     "source": _md.source_label(),
                     "synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    except Exception as e:
        print(f"❌ [market sync {job_id}] {e!s:.300}", flush=True)
        _set(stage="error", status="error", label=f"❌ {e!s:.200}", error=str(e))


@app.post("/api/market/sync")
def market_sync(req: Request, background_tasks: BackgroundTasks):
    """Refresh the persistent market-data store (quotes + sectors + targets).
    Body: {tickers?}. With no tickers, syncs holdings + watchlist + saved
    reports (capped)."""
    claims = _claims_or_401(req)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    try:
        body = _request_json_sync(req)
    except Exception:
        body = {}
    body = body or {}
    explicit = [str(t).upper().strip() for t in (body.get("tickers") or [])
                if t and str(t).strip()]
    if explicit:
        universe = _filter_scan_tickers(explicit)[:_OPTIONS_SCAN_CAP]
    else:
        universe = _market_universe()
    if not universe:
        return JSONResponse({"ok": False, "error": "No tickers to sync."}, status_code=400)
    import uuid as _uuid
    job_id = "MKTSYNC_" + _uuid.uuid4().hex[:12]
    _market_sync_jobs[job_id] = {"stage": "queued", "status": "running", "label": "Queued…",
                                 "started_at": time.time(), "updated_at": time.time(),
                                 "total": len(universe), "done": 0}
    background_tasks.add_task(_run_market_sync, job_id, universe)
    import market_data as _md
    print(f"⚙ [market sync] queued {job_id} universe={len(universe)} "
          f"src={_md.source_label()}", flush=True)
    return {"ok": True, "job_id": job_id, "universe": universe, "source": _md.source_label()}


@app.get("/api/market/sync/{job_id}")
def market_sync_status(job_id: str, request: Request):
    """Poll a market-data sync job."""
    _claims_or_401(request)
    job = _market_sync_jobs.get(job_id)
    if not job:
        return JSONResponse({"ok": False, "stage": "idle", "error": "no such job"}, status_code=404)
    return {"ok": True, **job}


@app.get("/api/market/coverage")
def market_coverage(request: Request):
    """Freshness summary of the persisted store (counts + most-recent update)."""
    _claims_or_401(request)
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return {"ok": False, "error": "DB unavailable"}
    try:
        out = {}
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            for tbl in ("market_quotes", "security_meta", "option_quotes"):
                cur.execute(f"SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM {tbl}")
                row = cur.fetchone() or {}
                out[tbl] = {"rows": row.get("n") or 0,
                            "latest": row["latest"].isoformat() if row.get("latest") else None}
        return {"ok": True, "autosync": _market_autosync_state, **out}
    except Exception as e:
        return {"ok": False, "error": f"{e!s:.150}"}


# ──────────────────── Automatic market-data refresh (free) ────────────────────
# Runs inside this web process (a daemon thread) — no extra container/cost. Keeps
# the persisted store fresh (quotes + sectors + targets) so the watchlist + the
# Builder candidate pool read current data without anyone clicking Refresh.
# Bootstraps on startup, then every 10 min during US market hours. Toggle off with
# MARKET_AUTOSYNC=0.
_market_autosync_state = {"last_sync": 0.0, "last_run": None, "runs": 0, "source": None}
_MARKET_SYNC_EVERY = 600        # 10 min


def _market_universe() -> list:
    """Default sync/scan universe: holdings + watchlist + saved reports (held
    first so they're never pushed out of the cap), deduped and capped."""
    held = _filter_scan_tickers(_held_tickers())
    watch = _filter_scan_tickers(_all_watchlist_tickers())
    reports = _filter_scan_tickers(_saved_report_tickers())
    seen, uni = set(), []
    for src in (held, watch, reports):
        for t in src:
            if t not in seen:
                seen.add(t)
                uni.append(t)
    return uni[:_OPTIONS_SCAN_CAP]


def _is_market_hours() -> bool:
    """Roughly US equity regular hours: Mon–Fri 09:30–16:00 America/New_York.
    Ignores market holidays (an extra free sync on a holiday is harmless)."""
    try:
        from zoneinfo import ZoneInfo
        et = datetime.now(ZoneInfo("America/New_York"))
    except Exception:
        return True   # if tz data is unavailable, don't block the refresh
    if et.weekday() >= 5:
        return False
    mins = et.hour * 60 + et.minute
    return (9 * 60 + 30) <= mins <= (16 * 60)


def _autosync_run(now: float):
    import market_data as _md
    universe = _market_universe()
    if not universe:
        return
    import uuid as _uuid
    job_id = "AUTOSYNC_" + _uuid.uuid4().hex[:8]
    _run_market_sync(job_id, universe)
    st = _market_autosync_state
    st["last_sync"] = now
    st["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    st["runs"] += 1
    st["source"] = _md.source_label()


def _market_autosync_loop():
    """Daemon loop. Bootstraps once on startup so the store is populated, then
    refreshes every _MARKET_SYNC_EVERY during market hours."""
    bootstrapped = False
    while True:
        try:
            time.sleep(60)
            if os.environ.get("MARKET_AUTOSYNC", "1") == "0":
                continue
            if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
                continue
            # Idle gate: when nobody's used the app recently, do nothing — no
            # universe pull, no yfinance churn, no memory growth. The
            # bootstrap is deferred to the first activity too, so a deployed-but-
            # unopened instance stays at near-zero. Resumes within ≤60s of use.
            if not _app_active():
                continue
            now = time.time()
            if not bootstrapped:
                bootstrapped = True
                _autosync_run(now)   # populate on first use
                continue
            if not _is_market_hours():
                continue
            if (now - _market_autosync_state["last_sync"]) >= _MARKET_SYNC_EVERY:
                _autosync_run(now)
        except Exception as e:
            print(f"[market autosync] loop error: {e!s:.150}", flush=True)


if os.environ.get("MARKET_AUTOSYNC", "1") != "0":
    try:
        threading.Thread(target=_market_autosync_loop, daemon=True,
                         name="market-autosync").start()
        print("⚙ [market autosync] background refresher started", flush=True)
    except Exception as _e:
        print(f"[market autosync] failed to start: {_e!s:.150}", flush=True)


@app.get("/api/financials/coverage")
def financials_coverage(request: Request):
    """What's in the store: per-ticker period counts and date range."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    _ensure_financials_table()
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute("""
                SELECT ticker, max(entity_name) AS entity_name,
                       count(*) FILTER (WHERE period_type='quarter') AS quarters,
                       count(*) FILTER (WHERE period_type='annual')  AS annuals,
                       max(period_end) AS latest, min(period_end) AS earliest
                  FROM company_financials GROUP BY ticker ORDER BY ticker
            """)
            rows = cur.fetchall() or []
        return {"ok": True, "coverage": [{
            "ticker": r["ticker"], "entity_name": r.get("entity_name"),
            "quarters": int(r["quarters"] or 0), "annuals": int(r["annuals"] or 0),
            "latest": r["latest"].isoformat() if r.get("latest") else None,
            "earliest": r["earliest"].isoformat() if r.get("earliest") else None,
        } for r in rows]}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/api/financials/sheet-links")
def financials_sheet_links(request: Request, limit: int = 40):
    """Tickers with stored financials for the Value Line sheet link strip.
    Prefer followed (reports+watchlist), then rest of store. DB only.
    Registered before /api/financials/{ticker} so 'sheet-links' is not a ticker."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    limit = max(5, min(int(limit or 40), 80))
    followed = set(_fin_followed_tickers())
    out = []
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute("""
                SELECT ticker,
                       MAX(entity_name) AS entity_name,
                       MAX(period_end)  AS latest,
                       COUNT(*) FILTER (WHERE period_type='annual')  AS annuals,
                       COUNT(*) FILTER (WHERE period_type='quarter') AS quarters
                  FROM company_financials
                 GROUP BY ticker
            """)
            rows = cur.fetchall() or []
        def sort_key(r):
            t = (r.get("ticker") or "").upper()
            return (0 if t in followed else 1, t)
        for r in sorted(rows, key=sort_key)[:limit]:
            t = (r.get("ticker") or "").upper()
            out.append({
                "ticker": t,
                "name": r.get("entity_name") or t,
                "followed": t in followed,
                "annuals": int(r.get("annuals") or 0),
                "quarters": int(r.get("quarters") or 0),
                "latest": (r["latest"].isoformat() if hasattr(r.get("latest"), "isoformat")
                           else r.get("latest")),
            })
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {
        "ok": True,
        "links": out,
        "followed_count": sum(1 for x in out if x.get("followed")),
        "note": "Links open Value Line–style sheets from the free store. No LLM.",
    }


@app.get("/api/financials/screen")
def financials_screen(request: Request, period_type: str = "quarter",
                      metric: str = "", op: str = "", value: float = None,
                      order: str = "revenue", desc: bool = True, limit: int = 200):
    """Cross-company snapshot: the latest period per ticker (one row each),
    optionally filtered by a metric threshold and sorted. Use period_type=
    'quarter' (default) or 'annual'. Screening is limited to the metrics in this
    store — price-based ratios (P/E etc.) need the live market snapshot."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    _ensure_financials_table()
    pt = period_type if period_type in ("quarter", "annual") else "quarter"
    valid_cols = set(_FIN_COLMAP.values())
    order_col = order if order in valid_cols else "revenue"
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute(f"""
                SELECT DISTINCT ON (ticker) *
                  FROM company_financials WHERE period_type=%s
              ORDER BY ticker, period_end DESC
            """, [pt])
            rows = cur.fetchall() or []
        # Optional metric filter (applied in Python; the set is small — one row/name).
        if metric in valid_cols and op in ("gt", "lt", "gte", "lte") and value is not None:
            def keep(r):
                v = r.get(metric)
                if v is None:
                    return False
                v = float(v)
                return {"gt": v > value, "lt": v < value,
                        "gte": v >= value, "lte": v <= value}[op]
            rows = [r for r in rows if keep(r)]
        rows.sort(key=lambda r: (r.get(order_col) is not None, float(r.get(order_col) or 0)),
                  reverse=bool(desc))
        return {"ok": True, "period_type": pt, "count": len(rows[:limit]),
                "rows": rows[:max(1, min(int(limit or 200), 500))]}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/api/financials/{ticker}")
def financials_ticker(ticker: str, request: Request, period_type: str = "all"):
    """Per-company financial history (time series), newest period first."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    _ensure_financials_table()
    try:
        rows = _fin_rows_for_ticker(ticker, period_type)
        return {"ok": True, "ticker": ticker.upper(),
                "entity_name": (rows[0].get("entity_name") if rows else None),
                "rows": rows}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


# ── Company dashboard (GuruFocus-style) — 100% persisted data, ZERO LLM ───────
# Everything below is arithmetic over company_financials (SEC XBRL), the
# market_quotes store (price), and analyst_reports (saved Grok/Claude targets).
# Rendering this page never spends a token; targets only change when the user
# re-runs a report through the normal Analyze flow.

_DASH_COE      = 0.09    # est. cost of equity (rf ~4.3% + ~4.7% ERP, no beta)
_DASH_COD_AT   = 0.043   # est. after-tax cost of debt (~5.5% × (1 − 21%))
_DASH_TAX      = 0.21    # corporate tax for NOPAT
_DASH_DISCOUNT = 0.10    # DCF discount rate
_DASH_TERM_G   = 0.03    # DCF terminal growth


def _dash_f(v):
    """NUMERIC/None → float/None."""
    try:
        return float(v) if v is not None else None
    except Exception:
        return None


def _dash_cagr(first, last, years):
    if not first or not last or first <= 0 or last <= 0 or years <= 0:
        return None
    try:
        return (last / first) ** (1.0 / years) - 1.0
    except Exception:
        return None


def _dash_clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


def _dash_lin(v, zero_at, full_at):
    """Linear 0→100 score: v ≤ zero_at → 0, v ≥ full_at → 100."""
    if v is None:
        return None
    if full_at == zero_at:
        return None
    return _dash_clamp((v - zero_at) / (full_at - zero_at) * 100.0)


# ── Ranking cards (Financial Strength / Profitability / Value) ──────────────
# Two bar columns, both comparative — never absolute "good/ok/poor" guesses:
#   Rating      = own-history percentile (where today sits vs this co's ≤12 FYs)
#   Vs Industry = peer percentile among industry (else sector) store peers
# Industry bar is BLANK unless ≥3 peers have a real value for that metric.
# No fabricated industry medians. Pure SEC store + market_quotes + security_meta.

def _rk_pct_color(pct):
    """0–100 percentile → green / amber / red."""
    if pct is None:
        return None
    return "#16a34a" if pct >= 66 else "#eab308" if pct >= 33 else "#dc2626"


def _rk_percentile(current, vals, higher_better, min_n=3):
    """Percentile of `current` within `vals` (0–100). None if < min_n samples.
    higher_better=True → larger value ranks higher (margins, yields).
    higher_better=False → smaller is better (PE, leverage)."""
    nums = [x for x in (vals or []) if x is not None and isinstance(x, (int, float))]
    if current is None or not isinstance(current, (int, float)) or len(nums) < min_n:
        return None
    eps = max(1e-9, abs(current) * 1e-6)
    worse = tie = 0
    for x in nums:
        if abs(x - current) <= eps:
            tie += 1
        elif (x < current) if higher_better else (x > current):
            worse += 1
    pct = (worse + 0.5 * tie) / len(nums) * 100.0
    return round(pct)


def _rk_abs_strength_quality(name: str, value) -> float | None:
    """Absolute 0–1 quality floors for fortress balance sheets.

    Own-history percentiles alone punish mega-caps that moved from ~zero debt
    to modest leverage (META Cash-To-Debt hist 5% → Financial Strength 0/10)
    even when absolute leverage is still excellent. Used only for the /10
    rank; Rating bars stay pure history.
    """
    if value is None or not isinstance(value, (int, float)):
        return None
    v = float(value)
    n = (name or "").lower()
    # Higher-is-better
    if "cash-to-debt" in n or "cash_to_debt" in n:
        if v >= 5:   return 0.95
        if v >= 2:   return 0.88
        if v >= 1:   return 0.80
        if v >= 0.5: return 0.65
        if v >= 0.25: return 0.45
        return 0.20
    if "equity-to-asset" in n or "equity_to_asset" in n:
        if v >= 0.60: return 0.92
        if v >= 0.45: return 0.80
        if v >= 0.30: return 0.60
        if v >= 0.20: return 0.40
        return 0.20
    if "wacc vs roic" in n or "spread" in n:
        # ROIC − WACC (pp). Positive spread = value creation.
        if v >= 15:  return 0.95
        if v >= 8:   return 0.88
        if v >= 3:   return 0.75
        if v >= 0:   return 0.55
        if v >= -3:  return 0.35
        return 0.15
    # Lower-is-better leverage
    if "debt-to-equity" in n or "debt_to_equity" in n:
        if v <= 0.05: return 0.95
        if v <= 0.15: return 0.90
        if v <= 0.30: return 0.85
        if v <= 0.50: return 0.72
        if v <= 1.0:  return 0.55
        if v <= 1.5:  return 0.40
        if v <= 2.5:  return 0.25
        return 0.10
    if "debt-to-ebitda" in n or "debt_to_ebitda" in n:
        if v <= 0.25: return 0.95
        if v <= 0.75: return 0.88
        if v <= 1.5:  return 0.78
        if v <= 2.5:  return 0.60
        if v <= 3.5:  return 0.45
        if v <= 5.0:  return 0.30
        return 0.12
    return None


def _rk_row(name, value, fmt, higher_better, series=None, peer_vals=None, note=None,
            strength_blend: bool = False):
    """Build one metric row.
    hist_pct → Rating bar (own history only — blank if no multi-year series).
    ind_pct  → Vs Industry bar (peers only — blank if &lt;3 peers).
    quality  → 0–1 for card /10: prefer history, else industry (score only).
    strength_blend → for Financial Strength: quality = max(hist, industry,
      absolute fortress floor) so modest leverage after zero-debt years
      cannot zero the whole card.
    Never copy industry into hist_pct — that made Rating and Vs Industry identical.
    """
    hist_vals = [x for x in (series or []) if x is not None]
    # Own history: need ≥3 observations including current era
    hp = _rk_percentile(value, hist_vals, higher_better, min_n=3)
    # Industry: peers only, never invent a number
    ip = _rk_percentile(value, peer_vals, higher_better, min_n=3)
    # Card /10 may use industry when history missing (value multiples with only
    # current price). UI Rating bar uses hist_pct alone so bars never twin.
    if strength_blend:
        qs = []
        if hp is not None:
            qs.append(hp / 100.0)
        if ip is not None:
            qs.append(ip / 100.0)
        aq = _rk_abs_strength_quality(name, value)
        if aq is not None:
            qs.append(aq)
        q = max(qs) if qs else None
    else:
        q = (hp / 100.0) if hp is not None else ((ip / 100.0) if ip is not None else None)
    return {
        "name": name,
        "value": (round(value, 4) if isinstance(value, (int, float)) else value),
        "fmt": fmt,
        # Rating column = company history comparison ONLY
        "hist_pct": hp, "hist_color": _rk_pct_color(hp),
        # Vs Industry column (blank when no peer sample)
        "ind_pct": ip, "ind_color": _rk_pct_color(ip),
        # quality drives card rank /10 (may be industry when hist blank)
        "quality": q,
        "rating": _rk_pct_color(hp) or "#cbd5e1",
        "note": note,
        "higher_better": higher_better,
    }


def _rk_fin_snapshot(row, price=None):
    """Compute comparable metric dict from one annual financials row + optional price.
    Keys are stable so peer/subject can be compared field-for-field."""
    f = _dash_f
    if not row:
        return {}
    rev = f(row.get("revenue")); ni = f(row.get("net_income"))
    ebitda = f(row.get("ebitda")); opin = f(row.get("operating_income"))
    ocf = f(row.get("operating_cash_flow")); fcf = f(row.get("free_cash_flow"))
    gp = f(row.get("gross_profit"))
    eq = f(row.get("stockholders_equity")); ta = f(row.get("total_assets"))
    debt = _dash_debt_of(row)
    cash = _dash_cash_of(row)
    cash_n = cash if cash is not None else 0.0
    shares = f(row.get("shares_outstanding")) or f(row.get("diluted_shares"))
    eps = f(row.get("diluted_eps"))
    if eps is None and ni is not None and shares:
        eps = ni / shares
    def mgn(num, den):
        return (num / den * 100.0) if (num is not None and den not in (None, 0)) else None
    def ratio(a, b):
        return (a / b) if (a is not None and b not in (None, 0)) else None
    def margin_pct(stored, num, den):
        """Prefer num/den; else stored fraction (0.15) or already-percent (>2)."""
        m = mgn(num, den)
        if m is not None:
            return m
        if stored is None:
            return None
        return stored * 100.0 if abs(stored) <= 2 else stored
    # ROIC
    roic = None
    if opin is not None and eq is not None:
        inv = (debt or 0.0) + eq - cash_n
        if inv > 0:
            roic = opin * (1 - _DASH_TAX) / inv * 100.0
    roce = None
    den = (eq or 0.0) + (debt or 0.0)
    if opin is not None and den > 0:
        roce = opin / den * 100.0
    # cash-to-debt: only when debt is known
    c2d = None
    if debt is not None:
        c2d = 10.0 if (debt == 0 and cash_n > 0) else ratio(cash_n, debt)
    mktcap = (price * shares) if (price and shares) else None
    ev = (mktcap + (debt or 0.0) - cash_n) if mktcap is not None else None
    pe = ratio(price, eps) if (price and eps and eps > 0) else None
    bvps = ratio(eq, shares)
    pb = ratio(price, bvps) if (price and bvps and bvps > 0) else None
    return {
        "cash_to_debt": c2d,
        "equity_to_asset": ratio(eq, ta),
        "debt_to_equity": ratio(debt, eq),
        "debt_to_ebitda": ratio(debt, ebitda),
        "gross_margin": margin_pct(f(row.get("gross_margin")), gp, rev),
        "operating_margin": mgn(opin, rev),
        "net_margin": mgn(ni, rev),
        "ebitda_margin": mgn(ebitda, rev),
        "fcf_margin": mgn(fcf, rev),
        "ocf_margin": mgn(ocf, rev),
        "roe": mgn(ni, eq),
        "roa": mgn(ni, ta),
        "roic": roic,
        "roce": roce,
        "pe": pe if (pe is not None and pe > 0) else None,
        "pb": pb if (pb is not None and pb > 0) else None,
        "ps": ratio(mktcap, rev) if (mktcap and rev and rev > 0) else None,
        "p_fcf": ratio(mktcap, fcf) if (mktcap and fcf and fcf > 0) else None,
        "p_ocf": ratio(mktcap, ocf) if (mktcap and ocf and ocf > 0) else None,
        "ev_ebit": ratio(ev, opin) if (ev is not None and opin and opin > 0) else None,
        "ev_ebitda": ratio(ev, ebitda) if (ev is not None and ebitda and ebitda > 0) else None,
        "ev_rev": ratio(ev, rev) if (ev is not None and rev and rev > 0) else None,
        "ev_fcf": ratio(ev, fcf) if (ev is not None and fcf and fcf > 0) else None,
        "earnings_yield": (opin / ev * 100.0) if (opin is not None and ev and ev > 0) else None,
        "fcf_yield": (fcf / mktcap * 100.0) if (fcf is not None and mktcap and mktcap > 0) else None,
    }


def _rk_margin_series(annuals, num_k, den_k):
    f = _dash_f
    out = []
    for r in annuals:
        num, den = f(r.get(num_k)), f(r.get(den_k))
        out.append((num / den * 100.0) if (num is not None and den not in (None, 0)) else None)
    return out


def _industry_peer_snapshots(tk: str, limit: int = 40) -> tuple[list, str | None]:
    """Latest-FY metric snapshots for sell-side-style industry peers in the store.

    Uses peer_comps (industry group + size) so rank cards are not polluted by
    unrelated same-sector names. Returns (snapshots, scope_label)."""
    try:
        meta = _db_meta([tk]).get(tk) or {}
        industry = (meta.get("industry") or "").strip() or None
        sector = (meta.get("sector") or "").strip() or None
        if not industry and not sector:
            return [], None

        # Subject market cap for size banding
        subj_mcap = None
        try:
            with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
                cur.execute("""
                    SELECT DISTINCT ON (ticker)
                           shares_outstanding, diluted_shares
                      FROM company_financials
                     WHERE ticker=%s AND period_type='annual'
                     ORDER BY ticker, period_end DESC
                """, (tk,))
                fr = cur.fetchone() or {}
            px = _dash_f((_db_quotes([tk]).get(tk) or {}).get("price"))
            sh = _dash_f(fr.get("shares_outstanding")) or _dash_f(fr.get("diluted_shares"))
            if px and sh:
                subj_mcap = px * sh
        except Exception:
            pass

        # Pull a wide candidate pool from store (industry + sector), then rank
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cand_rows = []
            if industry:
                cur.execute("""SELECT symbol, name, sector, industry FROM security_meta
                                WHERE industry=%s AND symbol<>%s LIMIT 80""",
                            (industry, tk))
                cand_rows.extend(cur.fetchall() or [])
            if sector:
                cur.execute("""SELECT symbol, name, sector, industry FROM security_meta
                                WHERE sector=%s AND symbol<>%s LIMIT 120""",
                            (sector, tk))
                seen = {r["symbol"].upper() for r in cand_rows if r.get("symbol")}
                for r in (cur.fetchall() or []):
                    s = (r.get("symbol") or "").upper()
                    if s and s not in seen:
                        cand_rows.append(r)
                        seen.add(s)

            # Market caps for candidates from latest financials + quotes
            cand_syms = list({(r.get("symbol") or "").upper()
                              for r in cand_rows if r.get("symbol")})
            # Always include curated peer_comps names so sell-side groups win
            try:
                from peer_comps import resolve_peer_tickers
                seed = resolve_peer_tickers(
                    tk, sector=sector, industry=industry,
                    subject_mcap=subj_mcap, limit=20,
                )
                for p in (seed.get("peers") or []):
                    if p not in cand_syms:
                        cand_syms.append(p)
            except Exception:
                pass

            if not cand_syms:
                return [], None

            cur.execute("""
                SELECT DISTINCT ON (ticker)
                       ticker, shares_outstanding, diluted_shares, revenue,
                       net_income, ebitda, operating_income, free_cash_flow,
                       diluted_eps, total_debt, long_term_debt, short_term_debt,
                       cash, short_term_investments, stockholders_equity,
                       total_assets, gross_profit, gross_margin, net_margin,
                       operating_cash_flow, period_end, entity_name
                  FROM company_financials
                 WHERE ticker = ANY(%s) AND period_type='annual'
                 ORDER BY ticker, period_end DESC
            """, (cand_syms,))
            fins = {r["ticker"].upper(): r for r in (cur.fetchall() or [])}

        quotes = _warm_quotes_for_comps(list(fins.keys()) + [tk], cap=24)
        # Build candidate_meta with mcaps for scoring
        cand_meta = []
        for r in cand_rows:
            s = (r.get("symbol") or "").upper()
            fin = fins.get(s) or {}
            px = _dash_f((quotes.get(s) or {}).get("price"))
            sh = _dash_f(fin.get("shares_outstanding")) or _dash_f(fin.get("diluted_shares"))
            mcap = (px * sh) if (px and sh) else None
            cand_meta.append({
                "symbol": s, "sector": r.get("sector"), "industry": r.get("industry"),
                "market_cap": mcap,
            })
        # Also attach mcaps for curated-only names
        have = {c["symbol"] for c in cand_meta}
        for s in cand_syms:
            if s in have:
                continue
            fin = fins.get(s) or {}
            px = _dash_f((quotes.get(s) or {}).get("price"))
            sh = _dash_f(fin.get("shares_outstanding")) or _dash_f(fin.get("diluted_shares"))
            mcap = (px * sh) if (px and sh) else None
            # Prefer industry of subject for curated inserts
            cand_meta.append({
                "symbol": s, "sector": sector, "industry": industry,
                "market_cap": mcap,
            })

        try:
            from peer_comps import resolve_peer_tickers
            resolved = resolve_peer_tickers(
                tk, sector=sector, industry=industry,
                subject_mcap=subj_mcap, candidate_meta=cand_meta,
                limit=min(limit, 24),
            )
            peers = list(resolved.get("peers") or [])
            scope = "industry" if resolved.get("method") in (
                "industry_group", "industry_store") else "sector"
        except Exception:
            peers = [c["symbol"] for c in cand_meta if c.get("industry") == industry][:limit]
            scope = "industry" if peers else "sector"

        snaps = []
        for t in peers:
            fin = fins.get(t)
            if not fin:
                continue
            px = _dash_f((quotes.get(t) or {}).get("price"))
            snaps.append(_rk_fin_snapshot(fin, px))
        return snaps, scope
    except Exception as e:
        print(f"[fin-dash] industry peer snaps failed {tk}: {e!s:.140}", flush=True)
        return [], None


def _build_rank_cards(annuals, price, anchor_map, growth_pct, ticker=None):
    """Three ranking cards from ≤12 FY annual history + current store price.
    Rating bar = own-history percentile. Vs Industry = peer percentile (≥3 peers).
    Card rank /10 = mean of available Rating percentiles (history first)."""
    if not annuals:
        return None
    f = _dash_f
    L = annuals[-1]
    peer_snaps, peer_scope = _industry_peer_snapshots(ticker) if ticker else ([], None)

    def peers_of(key):
        return [s.get(key) for s in peer_snaps if s.get(key) is not None]

    def g(r, k):
        return f(r.get(k))

    def ratio(a, b):
        return (a / b) if (a is not None and b not in (None, 0)) else None

    def pv(x):
        return x if (x is not None and x > 0) else None

    def debt_of(r):
        return _dash_debt_of(r)

    def cash_of(r):
        return _dash_cash_of(r)

    def roic_of(r):
        op = g(r, "operating_income"); e = g(r, "stockholders_equity")
        c = cash_of(r) or 0.0
        d = debt_of(r) or 0.0
        inv = d + (e or 0.0) - c
        if op is None or e is None or inv <= 0:
            return None
        return op * (1 - _DASH_TAX) / inv * 100.0

    def roce_of(r):
        op = g(r, "operating_income")
        den = (g(r, "stockholders_equity") or 0.0) + (debt_of(r) or 0.0)
        return (op / den * 100.0) if (op is not None and den > 0) else None

    rev = g(L, "revenue"); ni = g(L, "net_income"); ebitda = g(L, "ebitda")
    opin = g(L, "operating_income")
    ocf = g(L, "operating_cash_flow"); fcf = g(L, "free_cash_flow")
    cash = cash_of(L); cash_n = cash if cash is not None else 0.0
    debt = debt_of(L)
    eq = g(L, "stockholders_equity"); ta = g(L, "total_assets")
    shares = g(L, "shares_outstanding") or g(L, "diluted_shares")
    eps = g(L, "diluted_eps")
    if eps is None and ni is not None and shares:
        eps = ni / shares
    bvps = (eq / shares) if (eq is not None and shares) else None
    mktcap = (price * shares) if (price and shares) else None
    ev = (mktcap + (debt or 0.0) - cash_n) if mktcap is not None else None

    roic_series = [roic_of(r) for r in annuals]
    roic_latest = roic_series[-1] if roic_series else None
    wacc_latest = None
    if eq and eq > 0:
        d = max(debt or 0.0, 0.0)
        wacc_latest = (eq * _DASH_COE + d * _DASH_COD_AT) / (eq + d) * 100.0

    # ── Financial Strength ──
    c2d = None
    if debt is not None:
        c2d = 10.0 if (debt == 0 and cash_n > 0) else ratio(cash_n, debt)
    cash_series = []
    for r in annuals:
        d = debt_of(r); c = cash_of(r)
        if d is None:
            cash_series.append(None)
        elif d == 0:
            # Skip zero-debt years in history — a synthetic 10x cap made later
            # modest leverage look like a 5th-percentile collapse (META bug).
            cash_series.append(None)
        else:
            cash_series.append(((c or 0.0) / d))
    e2a_series = [ratio(g(r, "stockholders_equity"), g(r, "total_assets")) for r in annuals]
    d2e_series = [ratio(debt_of(r), g(r, "stockholders_equity")) for r in annuals]
    d2eb_series = [ratio(debt_of(r), g(r, "ebitda")) for r in annuals]
    spread = (roic_latest - wacc_latest) if (roic_latest is not None and wacc_latest is not None) else None
    # WACC–ROIC spread has no clean industry peer field; history only if we can.
    # strength_blend: /10 uses max(history, industry, absolute fortress floor).
    fs = [
        _rk_row("Cash-To-Debt", c2d, "x", True, cash_series, peers_of("cash_to_debt"),
                strength_blend=True),
        _rk_row("Equity-to-Asset", ratio(eq, ta), "x", True, e2a_series, peers_of("equity_to_asset"),
                strength_blend=True),
        _rk_row("Debt-to-Equity", ratio(debt, eq), "x", False, d2e_series, peers_of("debt_to_equity"),
                strength_blend=True),
        _rk_row("Debt-to-EBITDA", ratio(debt, ebitda), "x", False, d2eb_series, peers_of("debt_to_ebitda"),
                strength_blend=True),
        _rk_row("WACC vs ROIC", spread, "spread", True, None, None,
                (f"ROIC {roic_latest:.1f}% − WACC {wacc_latest:.1f}% (est.)"
                 if spread is not None else None),
                strength_blend=True),
    ]

    # ── Profitability Rank ──
    ni_hist = [x for x in [g(r, "net_income") for r in annuals][-10:] if x is not None]
    yrs_prof = sum(1 for x in ni_hist if x > 0) if ni_hist else None
    yrs_tot = len(ni_hist)
    roiic = None
    if len(annuals) >= 4:
        def nopat(r):
            op = g(r, "operating_income")
            return op * (1 - _DASH_TAX) if op is not None else None
        def invested(r):
            e = g(r, "stockholders_equity")
            c = cash_of(r) or 0.0
            return ((debt_of(r) or 0.0) + (e or 0.0) - c) if e is not None else None
        n2, n1 = nopat(L), nopat(annuals[-4])
        i2, i1 = invested(L), invested(annuals[-4])
        if None not in (n1, n2, i1, i2) and (i2 - i1) != 0:
            roiic = (n2 - n1) / (i2 - i1) * 100.0
    gm_series = _rk_margin_series(annuals, "gross_profit", "revenue")
    # fill from stored gross_margin fraction if gross_profit missing
    for i, r in enumerate(annuals):
        if gm_series[i] is None:
            gm = g(r, "gross_margin")
            if gm is not None:
                gm_series[i] = gm * 100.0 if abs(gm) <= 2 else gm
    om_series = _rk_margin_series(annuals, "operating_income", "revenue")
    nm_series = _rk_margin_series(annuals, "net_income", "revenue")
    em_series = _rk_margin_series(annuals, "ebitda", "revenue")
    fm_series = _rk_margin_series(annuals, "free_cash_flow", "revenue")
    ocm_series = _rk_margin_series(annuals, "operating_cash_flow", "revenue")
    roe_series = _rk_margin_series(annuals, "net_income", "stockholders_equity")
    roa_series = _rk_margin_series(annuals, "net_income", "total_assets")
    roce_series = [roce_of(r) for r in annuals]
    moat = None
    rv = [x for x in roic_series if x is not None]
    if rv:
        moat = round(min(10.0, 6 * (sum(1 for x in rv if x > 12) / len(rv))
                         + 4 * min(1.0, (gm_series[-1] or 0) / 60)))
    prof = [
        _rk_row("Gross Margin %", gm_series[-1] if gm_series else None, "pct", True,
                gm_series, peers_of("gross_margin")),
        _rk_row("Operating Margin %", om_series[-1] if om_series else None, "pct", True,
                om_series, peers_of("operating_margin")),
        _rk_row("Net Margin %", nm_series[-1] if nm_series else None, "pct", True,
                nm_series, peers_of("net_margin")),
        _rk_row("EBITDA Margin %", em_series[-1] if em_series else None, "pct", True,
                em_series, peers_of("ebitda_margin")),
        _rk_row("FCF Margin %", fm_series[-1] if fm_series else None, "pct", True,
                fm_series, peers_of("fcf_margin")),
        _rk_row("OCF Margin %", ocm_series[-1] if ocm_series else None, "pct", True,
                ocm_series, peers_of("ocf_margin")),
        _rk_row("ROE %", roe_series[-1] if roe_series else None, "pct", True,
                roe_series, peers_of("roe")),
        _rk_row("ROA %", roa_series[-1] if roa_series else None, "pct", True,
                roa_series, peers_of("roa")),
        _rk_row("ROIC %", roic_latest, "pct", True, roic_series, peers_of("roic")),
        _rk_row("3-Year ROIIC %", roiic, "pct", True, None, None,
                "Incremental NOPAT / incremental invested capital, 3-yr — no peer series"),
        _rk_row("ROCE %", roce_of(L), "pct", True, roce_series, peers_of("roce")),
        _rk_row("Years of Profitability (10y)",
                (float(yrs_prof) if yrs_prof is not None else None), "int", True, None, None,
                (f"{yrs_prof}/{yrs_tot} years positive NI — company-only metric"
                 if yrs_prof is not None else None)),
        _rk_row("Moat Score", (float(moat) if moat is not None else None), "score10", True,
                None, None, "0–10 DGA proxy (ROIC durability + GM) — company-only"),
    ]

    # ── DGA Value Rank ── lower multiple = better, higher yield = better
    # History for trading multiples needs multi-year prices — we only have the
    # current store price, so Rating (history) stays blank for most multiples.
    # Vs Industry uses peer multiples when ≥3 peers have prices + financials.
    am = anchor_map or {}
    pe = pv(ratio(price, eps))
    eps_hist = [x for x in [g(r, "diluted_eps") for r in annuals][-10:] if x is not None and x > 0]
    shiller = pv(ratio(price, (sum(eps_hist) / len(eps_hist)) if eps_hist else None))
    peg = pv(ratio(pe, growth_pct)) if (pe and growth_pct and growth_pct > 0) else None
    da = g(L, "dep_amort"); capex_raw = g(L, "capex")
    owner_earn = None
    if ni is not None and capex_raw is not None:
        owner_earn = ni + (da or 0.0) - abs(capex_raw)
    val = [
        _rk_row("PE Ratio", pe, "x", False, None, peers_of("pe"),
                "Price / diluted EPS — Rating blank (no multi-year price history)"),
        _rk_row("Shiller PE", shiller, "x", False, None, None,
                "Price / 10y avg positive EPS — company-only construct"),
        _rk_row("Price-to-Owner-Earnings", pv(ratio(mktcap, owner_earn)), "x", False, None, None,
                "Mkt cap / (NI + D&A − CapEx)"),
        _rk_row("PEG Ratio", peg, "x", False, None, None,
                "PE / rev (or NI) CAGR % — company-only"),
        _rk_row("PS Ratio", pv(ratio(mktcap, rev)), "x", False, None, peers_of("ps")),
        _rk_row("PB Ratio", pv(ratio(price, bvps)), "x", False, None, peers_of("pb")),
        _rk_row("Price-to-Free-Cash-Flow", pv(ratio(mktcap, fcf)), "x", False, None, peers_of("p_fcf")),
        _rk_row("Price-to-Operating-Cash-Flow", pv(ratio(mktcap, ocf)), "x", False, None, peers_of("p_ocf")),
        _rk_row("EV-to-EBIT", pv(ratio(ev, opin)), "x", False, None, peers_of("ev_ebit")),
        _rk_row("EV-to-EBITDA", pv(ratio(ev, ebitda)), "x", False, None, peers_of("ev_ebitda")),
        _rk_row("EV-to-Revenue", pv(ratio(ev, rev)), "x", False, None, peers_of("ev_rev")),
        _rk_row("EV-to-FCF", pv(ratio(ev, fcf)), "x", False, None, peers_of("ev_fcf")),
        _rk_row("Price-to-DGA-Value",
                pv(ratio(price, am.get("DGA Value (mean of targets)"))), "x", False, None, None),
        _rk_row("Price-to-DCF (Earnings)",
                pv(ratio(price, am.get("Earnings Power Value"))), "x", False, None, None),
        _rk_row("Price-to-DCF (FCF)",
                pv(ratio(price, am.get("DCF (FCF, 10% disc.)"))), "x", False, None, None),
        _rk_row("Price-to-Peter-Lynch-Value",
                pv(ratio(price, am.get("Peter Lynch Value"))), "x", False, None, None),
        _rk_row("Price-to-Graham-Number",
                pv(ratio(price, am.get("Graham Number"))), "x", False, None, None),
        _rk_row("Earnings Yield (Greenblatt) %",
                (opin / ev * 100.0) if (opin is not None and ev and ev > 0) else None,
                "pct", True, None, peers_of("earnings_yield")),
        _rk_row("FCF Yield %",
                (fcf / mktcap * 100.0) if (fcf is not None and mktcap and mktcap > 0) else None,
                "pct", True, None, peers_of("fcf_yield")),
    ]

    def card(title, rows):
        rows = [r for r in rows if r["value"] is not None]
        # Prefer history-based quality for the /10; fall back to industry scores
        qs = [r["quality"] for r in rows if r.get("quality") is not None]
        rank = round(10 * sum(qs) / len(qs)) if qs else None
        return {"title": title, "rank": rank, "metrics": rows,
                "peer_scope": peer_scope,
                "peer_count": len(peer_snaps)}

    return {"financial_strength": card("Financial Strength", fs),
            "profitability":      card("Profitability Rank", prof),
            "value":              card("DGA Value Rank", val),
            "peer_scope": peer_scope,
            "peer_count": len(peer_snaps)}


def _dash_debt_of(r) -> float | None:
    """Total debt if any debt field is present; None when debt is unreported
    (do NOT coerce missing → 0 — that flattens cash/debt charts to fake zeros)."""
    td = _dash_f((r or {}).get("total_debt"))
    if td is not None:
        return td
    ltd = _dash_f((r or {}).get("long_term_debt"))
    std = _dash_f((r or {}).get("short_term_debt"))
    if ltd is None and std is None:
        return None
    return (ltd or 0.0) + (std or 0.0)


def _dash_cash_of(r) -> float | None:
    c = _dash_f((r or {}).get("cash"))
    sti = _dash_f((r or {}).get("short_term_investments"))
    if c is None and sti is None:
        return None
    return (c or 0.0) + (sti or 0.0)


def _dash_ttm_from_quarters(quarters: list) -> dict:
    """Sum last ≤4 discrete quarters into a TTM block. Pure arithmetic."""
    qs = [q for q in (quarters or []) if q][-4:]
    if len(qs) < 2:
        return {}
    def s(k):
        vals = [_dash_f(q.get(k)) for q in qs]
        nums = [v for v in vals if v is not None]
        return sum(nums) if nums else None
    rev, ni, fcf, ocf, ebitda, opin = (s("revenue"), s("net_income"), s("free_cash_flow"),
                                       s("operating_cash_flow"), s("ebitda"), s("operating_income"))
    # Prefer sum of quarterly diluted EPS; else NI / latest shares.
    eps_parts = [_dash_f(q.get("diluted_eps")) for q in qs]
    eps_nums = [v for v in eps_parts if v is not None]
    shares = (_dash_f(qs[-1].get("shares_outstanding"))
              or _dash_f(qs[-1].get("diluted_shares")))
    eps = sum(eps_nums) if eps_nums else ((ni / shares) if (ni is not None and shares) else None)
    return {
        "periods": len(qs),
        "revenue": rev, "net_income": ni, "free_cash_flow": fcf,
        "operating_cash_flow": ocf, "ebitda": ebitda, "operating_income": opin,
        "eps": eps, "shares": shares,
        "net_margin": (ni / rev) if (ni is not None and rev not in (None, 0)) else None,
        "fcf_margin": (fcf / rev) if (fcf is not None and rev not in (None, 0)) else None,
        "period_end": (qs[-1]["period_end"].isoformat()
                       if qs[-1].get("period_end") else None),
    }


def _build_peer_comps(tk: str, subject_metrics: dict, limit: int = 8) -> dict:
    """Sell-side-style peers: GICS industry group + market-cap band.

    Morgan Stanley / Goldman / BofA desks pick business-model peers of
    similar scale — not alphabetically-first names in the whole sector.
    Data still comes from free store only (security_meta + company_financials
    + market_quotes). No network, no LLM on the request path.

    Returns {sector, industry, peers:[…], source, method, group_id, note}."""
    out = {
        "sector": None, "industry": None, "peers": [], "source": "store",
        "method": None, "group_id": None, "note": None,
    }
    try:
        meta = _db_meta([tk]).get(tk) or {}
        sector = (meta.get("sector") or "").strip() or None
        industry = (meta.get("industry") or "").strip() or None
        out["sector"] = sector
        out["industry"] = industry
        if not sector and not industry:
            if subject_metrics:
                out["peers"] = [{**subject_metrics, "ticker": tk, "is_subject": True}]
            return out

        sub_mkt = subject_metrics.get("market_cap") if subject_metrics else None

        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            # Wide candidate pool (industry + sector); ranking is sell-side style
            peers_meta = []
            if industry:
                cur.execute("""SELECT symbol, name, sector, industry FROM security_meta
                                WHERE industry=%s AND symbol<>%s LIMIT 80""",
                            (industry, tk))
                peers_meta.extend(cur.fetchall() or [])
            if sector:
                cur.execute("""SELECT symbol, name, sector, industry FROM security_meta
                                WHERE sector=%s AND symbol<>%s LIMIT 120""",
                            (sector, tk))
                seen = {(p.get("symbol") or "").upper() for p in peers_meta}
                for r in (cur.fetchall() or []):
                    s = (r.get("symbol") or "").upper()
                    if s and s not in seen:
                        peers_meta.append(r)
                        seen.add(s)

            cand = list({(p.get("symbol") or "").upper()
                         for p in peers_meta if p.get("symbol")})
            # Seed curated industry-group names so comps work even if the store
            # only has the subject (common right after a custom ticker pull).
            try:
                from peer_comps import resolve_peer_tickers
                seed = resolve_peer_tickers(
                    tk, sector=sector, industry=industry,
                    subject_mcap=sub_mkt, limit=16,
                )
                for p in (seed.get("peers") or []):
                    if p not in cand:
                        cand.append(p)
            except Exception:
                pass

            fin_map: dict = {}
            prior_map: dict = {}
            if cand:
                cur.execute("""
                    SELECT DISTINCT ON (ticker)
                           ticker, entity_name, revenue, net_income, ebitda,
                           operating_income, free_cash_flow, diluted_eps,
                           diluted_shares, shares_outstanding, total_debt,
                           long_term_debt, short_term_debt, cash,
                           short_term_investments, stockholders_equity,
                           net_margin, period_end, fy
                      FROM company_financials
                     WHERE ticker = ANY(%s) AND period_type='annual'
                     ORDER BY ticker, period_end DESC
                """, (cand,))
                for r in (cur.fetchall() or []):
                    fin_map[r["ticker"].upper()] = r
                cur.execute("""
                    SELECT ticker, revenue, period_end FROM company_financials
                     WHERE ticker = ANY(%s) AND period_type='annual'
                     ORDER BY ticker, period_end DESC
                """, (list(fin_map.keys()) or cand,))
                seen_n: dict = {}
                for r in (cur.fetchall() or []):
                    t = r["ticker"].upper()
                    seen_n[t] = seen_n.get(t, 0) + 1
                    if seen_n[t] == 2:
                        prior_map[t] = _dash_f(r.get("revenue"))

        # Warm free prices for peers that have SEC financials but no market_quotes
        # row — otherwise PE / EV / mkt cap render blank (MSFT ticket).
        quote_syms = list({*(fin_map.keys()), tk, *cand[:16]})
        quotes = _warm_quotes_for_comps(quote_syms, cap=16)
        name_by = {(p.get("symbol") or "").upper(): (p.get("name") or p.get("industry"))
                   for p in peers_meta}

        def row_metrics(tkr, fin, name=None, is_subject=False):
            price = _dash_f((quotes.get(tkr) or {}).get("price"))
            shares = (_dash_f((fin or {}).get("shares_outstanding"))
                      or _dash_f((fin or {}).get("diluted_shares")))
            eps = _dash_f((fin or {}).get("diluted_eps"))
            ni = _dash_f((fin or {}).get("net_income"))
            if eps is None and ni is not None and shares:
                eps = ni / shares
            rev = _dash_f((fin or {}).get("revenue"))
            ebitda = _dash_f((fin or {}).get("ebitda"))
            debt = _dash_debt_of(fin or {})
            cash = _dash_cash_of(fin or {}) or 0.0
            mkt = (price * shares) if (price and shares) else None
            ev = (mkt + (debt or 0.0) - cash) if mkt is not None else None
            pe = (price / eps) if (price and eps and eps > 0) else None
            # Negative / zero EPS → PE not meaningful (e.g. SNOW) — not a quote failure
            pe_nm = bool(eps is not None and eps <= 0 and price is not None)
            ev_eb = (ev / ebitda) if (ev is not None and ebitda and ebitda > 0) else None
            nm = _dash_f((fin or {}).get("net_margin"))
            if nm is not None and abs(nm) <= 2:
                nm_pct = nm * 100.0
            elif nm is not None:
                nm_pct = nm
            elif ni is not None and rev not in (None, 0):
                nm_pct = ni / rev * 100.0
            else:
                nm_pct = None
            prior = prior_map.get(tkr) if not is_subject else subject_metrics.get("_prior_rev")
            yoy = ((rev / prior - 1.0) * 100.0) if (rev and prior and prior > 0) else None
            return {
                "ticker": tkr,
                "name": name or (fin or {}).get("entity_name") or tkr,
                "is_subject": is_subject,
                "price": round(price, 2) if price is not None else None,
                "market_cap": round(mkt) if mkt is not None else None,
                "pe": round(pe, 2) if pe is not None else None,
                "pe_nm": pe_nm,  # True → show n/m (loss-making), not blank failure
                "ev_ebitda": round(ev_eb, 2) if ev_eb is not None else None,
                "net_margin_pct": round(nm_pct, 2) if nm_pct is not None else None,
                "rev_yoy_pct": round(yoy, 2) if yoy is not None else None,
                "revenue": rev,
            }

        # Build candidate_meta with mcaps for peer_comps scoring
        cand_meta = []
        for s in cand:
            fin = fin_map.get(s)
            # Allow curated names not yet in financials store — they'll be
            # dropped from the table rows but still influence ranking order
            # once their financials exist.
            if not fin:
                cand_meta.append({
                    "symbol": s, "sector": sector, "industry": industry,
                    "market_cap": None,
                })
                continue
            m = row_metrics(s, fin, name=name_by.get(s) or fin.get("entity_name"))
            cand_meta.append({
                "symbol": s,
                "sector": sector,
                "industry": industry if any(
                    (p.get("symbol") or "").upper() == s and p.get("industry") == industry
                    for p in peers_meta) else (meta.get("industry") if s == tk else None),
                "market_cap": m.get("market_cap"),
            })
            # Prefer actual meta industry when known
            for p in peers_meta:
                if (p.get("symbol") or "").upper() == s:
                    cand_meta[-1]["industry"] = p.get("industry")
                    cand_meta[-1]["sector"] = p.get("sector") or sector
                    break

        try:
            from peer_comps import resolve_peer_tickers, format_peer_rationale
            resolved = resolve_peer_tickers(
                tk, sector=sector, industry=industry,
                subject_mcap=sub_mkt, candidate_meta=cand_meta,
                limit=max(limit * 2, 12),
            )
            ordered = list(resolved.get("peers") or [])
            out["method"] = resolved.get("method")
            out["group_id"] = resolved.get("group_id")
            out["note"] = format_peer_rationale(resolved)
            out["source"] = (
                "industry" if resolved.get("method") in ("industry_group", "industry_store")
                else "sector"
            )
        except Exception as e:
            print(f"[fin-dash] peer_comps resolve failed: {e!s:.120}", flush=True)
            ordered = [c["symbol"] for c in cand_meta]
            out["source"] = "sector"
            out["note"] = "Fallback alphabetical/size sort"

        rows_out = []
        if subject_metrics:
            rows_out.append({
                **{k: v for k, v in subject_metrics.items() if not k.startswith("_")},
                "ticker": tk, "is_subject": True,
            })
        peer_rows = []
        # Preserve sell-side order from resolve_peer_tickers (industry first).
        # Do NOT re-sort purely by mkt-cap — that promoted Consumer Cyclical
        # mega-caps (AMZN/HD/SBUX) over true auto peers (F/GM) for TSLA.
        rank_pos = {t: i for i, t in enumerate(ordered)}
        for t in ordered:
            fin = fin_map.get(t)
            if not fin:
                continue
            peer_rows.append(row_metrics(
                t, fin, name=name_by.get(t) or fin.get("entity_name")))
        peer_rows.sort(key=lambda r: rank_pos.get(r.get("ticker") or "", 999))
        rows_out.extend(peer_rows[: max(0, limit)])
        out["peers"] = rows_out
        return out
    except Exception as e:
        print(f"[fin-dash] peer comps failed {tk}: {e!s:.160}", flush=True)
        if subject_metrics:
            out["peers"] = [{
                **{k: v for k, v in subject_metrics.items() if not k.startswith("_")},
                "ticker": tk, "is_subject": True,
            }]
        return out


@app.get("/api/financials/{ticker}/dashboard")
def financials_dashboard(ticker: str, request: Request, period_type: str = "annual"):
    """Chart-ready company dashboard: fundamentals series, ROIC/WACC, DGA Score,
    DGA Value (mean of saved Grok/Claude targets), valuation anchors, TTM block,
    and sector peer comps. Pure DB — no LLM tokens, no live network on the
    request path (price history has its own free market-data endpoint)."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    _ensure_financials_table()
    tk = ticker.upper().strip()
    pt = period_type if period_type in ("annual", "quarter") else "annual"

    rows = [r for r in _fin_rows_for_ticker(tk, pt)]
    rows.reverse()                                   # chronological, oldest first
    rows = rows[-(12 if pt == "annual" else 16):]    # last 12 FYs / 16 quarters
    annuals_all = [r for r in _fin_rows_for_ticker(tk, "annual")][::-1]  # oldest→newest
    annuals = annuals_all[-12:]
    quarters_all = [r for r in _fin_rows_for_ticker(tk, "quarter")][::-1]
    if not rows:
        return {"ok": False, "error": f"No financials stored for {tk} — run "
                                      f"'Sync from SEC' on the Financials tab first."}

    # ── Price (store) + saved targets ─────────────────────────────────
    price = None
    q = _db_quotes([tk])
    if q.get(tk):
        price = _dash_f(q[tk].get("price"))
    pt_grok = pt_claude = None
    targets_asof = None
    rating = None
    try:
        with _fund_conn() as conn, conn.cursor(cursor_factory=_RealDictCursor) as cur:
            cur.execute("""SELECT price_target, claude_price_target, rating,
                                  claude_rating, generated_at
                             FROM analyst_reports
                            WHERE ticker=%s AND archived IS NOT TRUE
                            LIMIT 1""", (tk,))
            r = cur.fetchone()
            if r:
                pt_grok   = _dash_f(r.get("price_target"))
                pt_claude = _dash_f(r.get("claude_price_target"))
                rating    = r.get("rating") or r.get("claude_rating")
                targets_asof = (r["generated_at"].isoformat()
                                if r.get("generated_at") else None)
    except Exception as _e:
        print(f"[fin-dash] targets lookup failed {tk}: {_e!s:.120}", flush=True)
    _tgts = [t for t in (pt_grok, pt_claude) if t and t > 0]
    dga_value = round(sum(_tgts) / len(_tgts), 2) if _tgts else None

    # ── Per-period series with computed ROIC / WACC / share Δ ───
    series = []
    prev_shares = None
    for r in rows:
        fy, fp = r.get("fy"), (r.get("fp") or "")
        label = (f"FY{fy}" if pt == "annual" else f"{fp}'{str(fy)[-2:]}")
        rev   = _dash_f(r.get("revenue"));            ni   = _dash_f(r.get("net_income"))
        ebitda = _dash_f(r.get("ebitda"));            opin = _dash_f(r.get("operating_income"))
        cash  = _dash_cash_of(r)
        debt  = _dash_debt_of(r)
        ocf = _dash_f(r.get("operating_cash_flow")); fcf = _dash_f(r.get("free_cash_flow"))
        div = _dash_f(r.get("dividends"));           bb  = _dash_f(r.get("buybacks"))
        # Buybacks stored as positive outflow magnitude — chart as positive spend.
        if bb is not None:
            bb = abs(bb)
        if div is not None:
            div = abs(div)
        sbc = None   # not extracted in the store (yet)
        shares = _dash_f(r.get("shares_outstanding")) or _dash_f(r.get("diluted_shares"))
        eq  = _dash_f(r.get("stockholders_equity")); ta = _dash_f(r.get("total_assets"))
        gm = _dash_f(r.get("gross_margin")); om = _dash_f(r.get("operating_margin"))
        nm = _dash_f(r.get("net_margin"))
        # Margins stored as fractions (0.15) → percent points for charts.
        def _m_pct(m, num, den):
            if m is not None:
                return (m * 100.0) if abs(m) <= 2 else m
            if num is not None and den not in (None, 0):
                return num / den * 100.0
            return None
        gp = _dash_f(r.get("gross_profit"))

        # ROIC: NOPAT / (debt + equity − cash). Quarterly NOPAT annualized ×4.
        roic = None
        cash_for_roic = cash or 0.0
        if opin is not None and eq is not None:
            invested = (debt or 0.0) + eq - cash_for_roic
            if invested and invested > 0:
                nopat = opin * (1 - _DASH_TAX) * (4.0 if pt == "quarter" else 1.0)
                roic = nopat / invested * 100.0
        # WACC est. — book-equity-weighted blend of est. CoE and after-tax CoD.
        wacc = None
        if eq is not None and eq > 0:
            d = max(debt or 0.0, 0.0)
            wacc = (eq * _DASH_COE + d * _DASH_COD_AT) / (eq + d) * 100.0
        # Share-count change vs prior period in this series: shrink (+) / dilute (−).
        # Annual view ≈ YoY; quarterly view ≈ sequential (QoQ) — UI labels accordingly.
        bb_ratio = None
        if shares and prev_shares and prev_shares > 0:
            bb_ratio = (prev_shares - shares) / prev_shares * 100.0
        prev_shares = shares if shares else prev_shares

        series.append({
            "label": label, "period_end": (r["period_end"].isoformat()
                                           if r.get("period_end") else None),
            "revenue": rev, "net_income": ni, "ebitda": ebitda,
            "cash": cash, "debt": debt,
            "ocf": ocf, "fcf": fcf, "dividends": div, "buybacks": bb, "sbc": sbc,
            "shares": shares, "buyback_ratio_pct": (round(bb_ratio, 3)
                                                    if bb_ratio is not None else None),
            "equity": eq, "assets": ta,
            "gross_margin_pct": _m_pct(gm, gp, rev),
            "operating_margin_pct": _m_pct(om, opin, rev),
            "net_margin_pct": _m_pct(nm, ni, rev),
            "roic_pct": round(roic, 2) if roic is not None else None,
            "wacc_pct": round(wacc, 2) if wacc is not None else None,
        })

    # ── DGA Score (0-100) from ANNUAL history ──────────────────────────
    def _col(rs, k):
        return [_dash_f(x.get(k)) for x in rs]
    a_rev = _col(annuals, "revenue"); a_ni = _col(annuals, "net_income")
    a_fcf = _col(annuals, "free_cash_flow")
    last = annuals[-1] if annuals else {}
    l_nm   = _dash_f(last.get("net_margin"))
    # net_margin is a fraction (0.15); if missing, derive from NI/rev.
    if l_nm is None:
        _lr = _dash_f(last.get("revenue")); _ln = _dash_f(last.get("net_income"))
        if _lr not in (None, 0) and _ln is not None:
            l_nm = _ln / _lr
    # Guard: if a bad row stored pct points (e.g. 15), normalize to fraction.
    if l_nm is not None and abs(l_nm) > 2:
        l_nm = l_nm / 100.0
    l_eq   = _dash_f(last.get("stockholders_equity"))
    l_ni   = _dash_f(last.get("net_income"))
    l_opin = _dash_f(last.get("operating_income"))
    l_cash = _dash_cash_of(last) or 0.0
    l_debt = _dash_debt_of(last)
    l_debt_for_score = l_debt if l_debt is not None else 0.0
    l_fcf  = _dash_f(last.get("free_cash_flow"))
    l_ebitda = _dash_f(last.get("ebitda"))
    l_rev = _dash_f(last.get("revenue"))

    # Profitability: net margin + ROIC + ROE
    l_roic = None
    if l_opin is not None and l_eq and (l_debt_for_score + l_eq - l_cash) > 0:
        l_roic = l_opin * (1 - _DASH_TAX) / (l_debt_for_score + l_eq - l_cash) * 100
    l_roe = (l_ni / l_eq * 100) if (l_ni is not None and l_eq and l_eq > 0) else None
    p_parts = [s for s in (_dash_lin(l_nm, 0, 0.20), _dash_lin(l_roic, 0, 18),
                           _dash_lin(l_roe, 0, 22)) if s is not None]
    profitability = round(sum(p_parts) / len(p_parts)) if p_parts else None

    # Growth: 5y revenue + FCF (fallback NI) CAGRs
    def _cagr5(vals):
        vv = [v for v in vals if v is not None]
        if len(vv) < 3:
            return None
        n = min(6, len(vv))            # up to 5 intervals
        return _dash_cagr(vv[-n], vv[-1], n - 1)
    g_rev = _cagr5(a_rev)
    g_ni  = _cagr5(a_ni)
    g_cf  = _cagr5(a_fcf) if any(v for v in a_fcf if v and v > 0) else g_ni
    g_parts = [s for s in (_dash_lin(g_rev, 0, 0.15), _dash_lin(g_cf, 0, 0.15))
               if s is not None]
    growth = round(sum(g_parts) / len(g_parts)) if g_parts else None

    # Financial strength: cash/debt, debt/equity (inverted), FCF coverage
    fs_parts = []
    if l_debt is None:
        pass   # no debt disclosure — don't invent a perfect score
    elif l_debt_for_score == 0:
        fs_parts.append(100.0)
    else:
        fs_parts.append(_dash_lin(l_cash / l_debt_for_score, 0, 1.0) or 0)
        if l_eq and l_eq > 0:
            fs_parts.append(_dash_lin(2.0 - (l_debt_for_score / l_eq), 0, 2.0) or 0)
        if l_fcf is not None:
            fs_parts.append(_dash_lin(l_fcf / l_debt_for_score, 0, 0.5) or 0)
    financial_strength = round(sum(fs_parts) / len(fs_parts)) if fs_parts else None

    # Predictability: positive-NI years + revenue-up years over last ≤10 FYs
    ni_hist  = [v for v in a_ni if v is not None][-10:]
    rev_hist = [v for v in a_rev if v is not None][-10:]
    pred_parts = []
    if len(ni_hist) >= 3:
        pred_parts.append(sum(1 for v in ni_hist if v > 0) / len(ni_hist) * 100)
    if len(rev_hist) >= 4:
        ups = sum(1 for i in range(1, len(rev_hist)) if rev_hist[i] >= rev_hist[i - 1])
        pred_parts.append(ups / (len(rev_hist) - 1) * 100)
    predictability = round(sum(pred_parts) / len(pred_parts)) if pred_parts else None

    # Value: upside of DGA Value vs store price (50 = fairly valued)
    value_score = None
    if dga_value and price and price > 0:
        upside = dga_value / price - 1.0
        value_score = round(_dash_clamp(50 + upside * 100, 0, 100))

    comps = {"profitability": profitability, "growth": growth,
             "financial_strength": financial_strength,
             "predictability": predictability, "value": value_score}
    weights = {"profitability": 0.30, "growth": 0.25, "financial_strength": 0.20,
               "predictability": 0.15, "value": 0.10}
    avail = {k: v for k, v in comps.items() if v is not None}
    dga_score = (round(sum(v * weights[k] for k, v in avail.items())
                       / sum(weights[k] for k in avail)) if avail else None)

    # ── TTM from last 4 quarters (preferred for trading multiples) ─────
    ttm = _dash_ttm_from_quarters(quarters_all)

    # ── Valuation anchors (per share) — prefer TTM EPS for earnings models ──
    valuation = []
    shares_l = (_dash_f(last.get("shares_outstanding"))
                or _dash_f(last.get("diluted_shares"))
                or ttm.get("shares"))
    eps_fy = _dash_f(last.get("diluted_eps"))
    if eps_fy is None and l_ni is not None and shares_l:
        eps_fy = l_ni / shares_l
    eps_ttm = ttm.get("eps") if ttm else None
    # Trading PE: TTM first; model anchors: TTM if available else FY.
    eps = eps_ttm if (eps_ttm is not None and eps_ttm > 0) else eps_fy
    bvps = (l_eq / shares_l) if (l_eq is not None and shares_l) else None

    mktcap = (price * shares_l) if (price and shares_l) else None
    pe_ratio = (price / eps) if (price and eps and eps > 0) else None
    pe_fy = (price / eps_fy) if (price and eps_fy and eps_fy > 0) else None
    pb_ratio = (price / bvps) if (price and bvps and bvps > 0) else None
    ev = (mktcap + (l_debt_for_score or 0) - (l_cash or 0)) if mktcap is not None else None
    fcf_for_mult = ttm.get("free_cash_flow") if (ttm and ttm.get("free_cash_flow") is not None) else l_fcf
    ebitda_for_mult = ttm.get("ebitda") if (ttm and ttm.get("ebitda") is not None) else l_ebitda
    rev_for_mult = ttm.get("revenue") if (ttm and ttm.get("revenue") is not None) else l_rev
    ev_ebitda = (ev / ebitda_for_mult) if (ev is not None and ebitda_for_mult and ebitda_for_mult > 0) else None
    fcf_yield = (fcf_for_mult / mktcap * 100.0) if (fcf_for_mult is not None and mktcap and mktcap > 0) else None
    # YoY growth (latest FY vs prior FY)
    prior = annuals[-2] if len(annuals) >= 2 else None
    rev_yoy = None
    if prior and l_rev and _dash_f(prior.get("revenue")) not in (None, 0):
        rev_yoy = (l_rev / _dash_f(prior.get("revenue")) - 1.0) * 100.0
    ni_yoy = None
    if prior and l_ni is not None and _dash_f(prior.get("net_income")) not in (None, 0):
        pni = _dash_f(prior.get("net_income"))
        if pni:
            ni_yoy = (l_ni / pni - 1.0) * 100.0

    key_metrics = {
        "pe":               round(pe_ratio, 2) if pe_ratio is not None else None,
        "pe_fy":            round(pe_fy, 2) if pe_fy is not None else None,
        "pe_basis":         ("TTM" if (eps_ttm is not None and eps_ttm > 0) else "FY"),
        "pb":               round(pb_ratio, 2) if pb_ratio is not None else None,
        "market_cap":       round(mktcap)      if mktcap   is not None else None,
        "enterprise_value": round(ev)          if ev       is not None else None,
        "ev_ebitda":        round(ev_ebitda, 2) if ev_ebitda is not None else None,
        "fcf_yield_pct":    round(fcf_yield, 2) if fcf_yield is not None else None,
        "eps":              round(eps, 2)      if eps      is not None else None,
        "eps_fy":           round(eps_fy, 2)   if eps_fy   is not None else None,
        "rev_yoy_pct":      round(rev_yoy, 2)  if rev_yoy  is not None else None,
        "ni_yoy_pct":       round(ni_yoy, 2)   if ni_yoy   is not None else None,
        "net_margin_pct":   round(l_nm * 100, 2) if l_nm is not None else None,
        "roic_pct":         round(l_roic, 2) if l_roic is not None else None,
    }

    def _anchor(label, v, kind="model"):
        if v is not None and not (v != v):     # NaN guard
            valuation.append({"label": label, "value": round(v, 2), "kind": kind})
    _anchor("DGA Value (mean of targets)", dga_value, "dga")
    _anchor("Grok target", pt_grok, "target")
    _anchor("Claude target", pt_claude, "target")
    if eps and eps > 0 and bvps and bvps > 0:
        _anchor("Graham Number", (22.5 * eps * bvps) ** 0.5)
    if eps and eps > 0:
        _anchor("Earnings Power Value", eps / _DASH_COE)
        # Lynch: fair value ≈ EPS × earnings-growth rate (use rev CAGR as proxy).
        g_lynch = g_rev if g_rev is not None else g_ni
        if g_lynch is not None:
            _anchor("Peter Lynch Value", eps * _dash_clamp((g_lynch * 100), 5, 25))
    _anchor("Book Value / share", bvps)
    if shares_l:
        _anchor("Net Cash / share", (l_cash - l_debt_for_score) / shares_l)
    if l_fcf and l_fcf > 0 and shares_l:
        # Simple 2-stage DCF on FCF/share: 5y at clamped hist growth, 3% terminal.
        g = _dash_clamp(g_cf if g_cf is not None else 0.05, 0.0, 0.15)
        f = l_fcf / shares_l
        pv = 0.0
        for yr in range(1, 6):
            f *= (1 + g)
            pv += f / ((1 + _DASH_DISCOUNT) ** yr)
        term = f * (1 + _DASH_TERM_G) / (_DASH_DISCOUNT - _DASH_TERM_G)
        pv += term / ((1 + _DASH_DISCOUNT) ** 5)
        _anchor("DCF (FCF, 10% disc.)", pv)

    # Verdict vs DGA Value
    verdict = None
    if dga_value and price and price > 0:
        prem = price / dga_value - 1.0
        verdict = ("Significantly Undervalued" if prem <= -0.30 else
                   "Undervalued"               if prem <= -0.10 else
                   "Fairly Valued"             if prem <  0.10  else
                   "Overvalued"                if prem <  0.30  else
                   "Significantly Overvalued")

    # ── Ranking cards — PEG uses rev (or NI) CAGR, NOT FCF growth ──
    anchor_map = {a["label"]: a["value"] for a in valuation}
    g_for_peg = g_rev if g_rev is not None else g_ni
    growth_pct = (g_for_peg * 100) if g_for_peg is not None else None
    # Prefer TTM EPS for value-rank PE when available.
    rank_price = price
    if annuals and eps_ttm is not None and eps_ttm > 0:
        # Patch latest annual diluted_eps for rank-card PE only (copy, don't mutate store).
        annuals_for_rank = [dict(a) for a in annuals]
        annuals_for_rank[-1] = dict(annuals_for_rank[-1])
        annuals_for_rank[-1]["diluted_eps"] = eps_ttm
    else:
        annuals_for_rank = annuals
    rank_cards = _build_rank_cards(annuals_for_rank, rank_price, anchor_map, growth_pct,
                                   ticker=tk)

    # ── Peer comps (sector/industry from security_meta + SEC store) ──
    subject_for_peers = {
        "name": rows[-1].get("entity_name") or tk,
        "price": round(price, 2) if price is not None else None,
        "market_cap": key_metrics.get("market_cap"),
        "pe": key_metrics.get("pe"),
        "ev_ebitda": key_metrics.get("ev_ebitda"),
        "net_margin_pct": key_metrics.get("net_margin_pct"),
        "rev_yoy_pct": key_metrics.get("rev_yoy_pct"),
        "revenue": rev_for_mult or l_rev,
        "_prior_rev": _dash_f(prior.get("revenue")) if prior else None,
    }
    peers = _build_peer_comps(tk, subject_for_peers, limit=8)

    meta = (_db_meta([tk]).get(tk) or {})

    return {"ok": True, "ticker": tk,
            "entity_name": rows[-1].get("entity_name") or tk,
            "sector": meta.get("sector") or peers.get("sector"),
            "industry": meta.get("industry") or peers.get("industry"),
            "period_type": pt, "series": series,
            "price": price, "rating": rating,
            "dga_value": dga_value, "verdict": verdict,
            "targets": {"grok": pt_grok, "claude": pt_claude, "as_of": targets_asof},
            "key_metrics": key_metrics,
            "ttm": ttm,
            "peers": peers,
            "rank_cards": rank_cards,
            "dga_score": {"total": dga_score, "components": comps,
                          "weights": weights},
            "valuation": valuation,
            "notes": {
                "wacc": "WACC est.: 9% CoE / 4.3% after-tax CoD, book-equity weighted (no beta).",
                "roic": "NOPAT (21% tax) / (debt + equity − cash). Quarterly NOPAT ×4.",
                "pe": "Prefers TTM diluted EPS (sum of last ≤4 quarters) over last FY.",
                "share_delta": ("YoY share change" if pt == "annual"
                                else "Sequential (QoQ) share change — not annualized."),
                "peers": "Sell-side style: industry group + market-cap band (not whole-sector dump).",
                "tokens": "Dashboard is pure DB arithmetic — zero LLM tokens.",
            }}


# ── Value Line–style financial sheet (pure store, zero LLM, zero continuous cost) ─
# Renders all pulled SEC numbers as a printable statistical array (years × metrics).
# View path = Postgres only. PDF is generated only when the user clicks Download
# (on-demand CPU) — never on a schedule, never touches SEC/LLM.

_VL_TAX = 0.21


def _vl_f(v):
    try:
        if v is None:
            return None
        x = float(v)
        if x != x:  # NaN
            return None
        return x
    except (TypeError, ValueError):
        return None


def _vl_pct(num, den):
    n, d = _vl_f(num), _vl_f(den)
    if n is None or d in (None, 0):
        return None
    return n / d * 100.0


def _vl_ratio(num, den):
    n, d = _vl_f(num), _vl_f(den)
    if n is None or d in (None, 0):
        return None
    return n / d


def _vl_debt(r) -> float | None:
    return _dash_debt_of(r)


def _vl_cash(r) -> float | None:
    return _dash_cash_of(r)


def _vl_series_from_annuals(annuals: list) -> dict:
    """Build Value Line–style row series (oldest → newest) from annual store rows."""
    labels = []
    for r in annuals:
        fy = r.get("fy")
        pe = r.get("period_end")
        if fy:
            labels.append(f"FY{fy}")
        elif pe is not None:
            labels.append(str(pe)[:4])
        else:
            labels.append("—")

    def col(key):
        return [_vl_f(r.get(key)) for r in annuals]

    rev = col("revenue")
    cogs = col("cost_of_revenue")
    gp = col("gross_profit")
    opin = col("operating_income")
    ni = col("net_income")
    ebitda = col("ebitda")
    ocf = col("operating_cash_flow")
    fcf = col("free_cash_flow")
    capex = col("capex")
    div = col("dividends")
    bb = col("buybacks")
    eps = col("diluted_eps")
    shares = []
    for r in annuals:
        sh = _vl_f(r.get("shares_outstanding")) or _vl_f(r.get("diluted_shares"))
        shares.append(sh)
    # Fill EPS from NI/shares when missing
    for i, e in enumerate(eps):
        if e is None and ni[i] is not None and shares[i]:
            eps[i] = ni[i] / shares[i]
    cash = [_vl_cash(r) for r in annuals]
    debt = [_vl_debt(r) for r in annuals]
    equity = col("stockholders_equity")
    assets = col("total_assets")
    liab = col("total_liabilities")
    ltd = col("long_term_debt")
    rnd = col("rnd")

    # Margins (prefer stored fraction, else compute)
    def margin_series(stored_key, num_series):
        out = []
        for i, r in enumerate(annuals):
            m = _vl_f(r.get(stored_key))
            if m is not None:
                out.append(m * 100.0 if abs(m) <= 2 else m)
            else:
                out.append(_vl_pct(num_series[i], rev[i]))
        return out

    gm = margin_series("gross_margin", gp)
    om = margin_series("operating_margin", opin)
    nm = margin_series("net_margin", ni)
    em = margin_series("ebitda_margin", ebitda)
    fcfm = [_vl_pct(fcf[i], rev[i]) for i in range(len(annuals))]
    ocfm = [_vl_pct(ocf[i], rev[i]) for i in range(len(annuals))]

    roe = [_vl_pct(ni[i], equity[i]) for i in range(len(annuals))]
    roa = [_vl_pct(ni[i], assets[i]) for i in range(len(annuals))]
    # ROIC ≈ NOPAT / (debt + equity − cash)
    roic = []
    for i, r in enumerate(annuals):
        op = opin[i]
        if op is None:
            roic.append(None)
            continue
        nopat = op * (1 - _VL_TAX)
        c = cash[i] or 0.0
        d = debt[i] or 0.0
        e = equity[i]
        if e is None:
            roic.append(None)
            continue
        inv = d + e - c
        roic.append((nopat / inv * 100.0) if inv > 0 else None)

    bvps = []
    dps = []  # dividends per share
    for i in range(len(annuals)):
        sh = shares[i]
        bvps.append((equity[i] / sh) if (equity[i] is not None and sh) else None)
        # Dividends stored as cash outflow (often total); per-share if we have shares
        if div[i] is not None and sh and sh > 0:
            dps.append(abs(div[i]) / sh)
        else:
            dps.append(None)

    # YoY growth %
    def yoy(series):
        out = [None]
        for i in range(1, len(series)):
            a, b = series[i - 1], series[i]
            if a and a != 0 and b is not None:
                out.append((b / a - 1.0) * 100.0)
            else:
                out.append(None)
        return out

    de = [_vl_ratio(debt[i], equity[i]) for i in range(len(annuals))]
    c2d = []
    for i in range(len(annuals)):
        d = debt[i]
        c = cash[i]
        if d is None:
            c2d.append(None)
        elif d == 0:
            c2d.append(10.0 if (c or 0) > 0 else None)
        else:
            c2d.append((c or 0.0) / d)

    rows = [
        {"id": "revenue", "label": "Revenues", "unit": "$", "values": rev},
        {"id": "cogs", "label": "Cost of Revenue", "unit": "$", "values": cogs},
        {"id": "gross_profit", "label": "Gross Profit", "unit": "$", "values": gp},
        {"id": "rnd", "label": "R&D", "unit": "$", "values": rnd},
        {"id": "operating_income", "label": "Operating Income", "unit": "$", "values": opin},
        {"id": "ebitda", "label": "EBITDA", "unit": "$", "values": ebitda},
        {"id": "net_income", "label": "Net Income", "unit": "$", "values": ni},
        {"id": "diluted_eps", "label": "Diluted EPS", "unit": "$/sh", "values": eps},
        {"id": "dps", "label": "Dividends / sh", "unit": "$/sh", "values": dps},
        {"id": "ocf", "label": "Operating Cash Flow", "unit": "$", "values": ocf},
        {"id": "capex", "label": "Capital Spending", "unit": "$", "values": [abs(x) if x is not None else None for x in capex]},
        {"id": "fcf", "label": "Free Cash Flow", "unit": "$", "values": fcf},
        {"id": "buybacks", "label": "Share Buybacks (cash)", "unit": "$", "values": [abs(x) if x is not None else None for x in bb]},
        {"id": "cash", "label": "Cash & ST Investments", "unit": "$", "values": cash},
        {"id": "total_debt", "label": "Total Debt", "unit": "$", "values": debt},
        {"id": "long_term_debt", "label": "Long-Term Debt", "unit": "$", "values": ltd},
        {"id": "equity", "label": "Shareholders' Equity", "unit": "$", "values": equity},
        {"id": "assets", "label": "Total Assets", "unit": "$", "values": assets},
        {"id": "liabilities", "label": "Total Liabilities", "unit": "$", "values": liab},
        {"id": "shares", "label": "Shares Outstanding", "unit": "sh", "values": shares},
        {"id": "bvps", "label": "Book Value / sh", "unit": "$/sh", "values": bvps},
        {"id": "section_ratios", "label": "— Rates & margins —", "unit": "section", "values": [None] * len(annuals)},
        {"id": "gross_margin", "label": "Gross Margin", "unit": "%", "values": gm},
        {"id": "op_margin", "label": "Operating Margin", "unit": "%", "values": om},
        {"id": "ebitda_margin", "label": "EBITDA Margin", "unit": "%", "values": em},
        {"id": "net_margin", "label": "Net Profit Margin", "unit": "%", "values": nm},
        {"id": "ocf_margin", "label": "OCF Margin", "unit": "%", "values": ocfm},
        {"id": "fcf_margin", "label": "FCF Margin", "unit": "%", "values": fcfm},
        {"id": "roe", "label": "Return on Equity", "unit": "%", "values": roe},
        {"id": "roa", "label": "Return on Assets", "unit": "%", "values": roa},
        {"id": "roic", "label": "ROIC (NOPAT)", "unit": "%", "values": roic},
        {"id": "debt_equity", "label": "Debt / Equity", "unit": "x", "values": de},
        {"id": "cash_debt", "label": "Cash / Debt", "unit": "x", "values": c2d},
        {"id": "section_growth", "label": "— Growth (YoY) —", "unit": "section", "values": [None] * len(annuals)},
        {"id": "rev_yoy", "label": "Revenue Growth", "unit": "%", "values": yoy(rev)},
        {"id": "eps_yoy", "label": "EPS Growth", "unit": "%", "values": yoy(eps)},
        {"id": "ni_yoy", "label": "Net Income Growth", "unit": "%", "values": yoy(ni)},
        {"id": "fcf_yoy", "label": "FCF Growth", "unit": "%", "values": yoy(fcf)},
    ]
    return {"labels": labels, "rows": rows, "n_years": len(annuals)}


def _build_fin_sheet(ticker: str) -> dict:
    """Value Line–style sheet payload from company_financials + quotes + meta.
    Pure DB — no SEC, no LLM, no peer scans."""
    tk = (ticker or "").strip().upper()
    if not tk:
        return {"ok": False, "error": "ticker required"}
    _ensure_financials_table()
    annuals = [r for r in _fin_rows_for_ticker(tk, "annual")][::-1]  # oldest→newest
    annuals = annuals[-12:]  # last 12 FYs like Value Line statistical array
    quarters = [r for r in _fin_rows_for_ticker(tk, "quarter")][::-1]
    quarters = quarters[-12:]
    if not annuals and not quarters:
        return {"ok": False, "error": f"No financials stored for {tk}. Pull SEC data first."}

    meta = _db_meta([tk]).get(tk) or {}
    # Prefer store, then multi-source warm (same cascade as comps)
    q = _db_quotes([tk]).get(tk) or {}
    price = _vl_f(q.get("price"))
    if price is None:
        warmed = _warm_quotes_for_comps([tk], cap=1)
        q = warmed.get(tk) or q
        price = _vl_f(q.get("price"))
    entity = None
    if annuals:
        entity = annuals[-1].get("entity_name")
    if not entity and quarters:
        entity = quarters[-1].get("entity_name")
    entity = entity or meta.get("name") or tk

    # Capital structure snapshot from latest annual + price
    L = annuals[-1] if annuals else (quarters[-1] if quarters else {})
    shares = _vl_f(L.get("shares_outstanding")) or _vl_f(L.get("diluted_shares"))
    cash = _vl_cash(L) or 0.0
    debt = _vl_debt(L)
    equity = _vl_f(L.get("stockholders_equity"))
    mktcap = (price * shares) if (price and shares) else None
    ev = (mktcap + (debt or 0.0) - cash) if mktcap is not None else None
    eps = _vl_f(L.get("diluted_eps"))
    ni = _vl_f(L.get("net_income"))
    if eps is None and ni is not None and shares:
        eps = ni / shares
    pe = (price / eps) if (price and eps and eps > 0) else None
    bvps = (equity / shares) if (equity is not None and shares) else None
    pb = (price / bvps) if (price and bvps and bvps > 0) else None
    rev = _vl_f(L.get("revenue"))
    ebitda = _vl_f(L.get("ebitda"))
    fcf = _vl_f(L.get("free_cash_flow"))
    ev_eb = (ev / ebitda) if (ev is not None and ebitda and ebitda > 0) else None
    fcf_y = (fcf / mktcap * 100.0) if (fcf is not None and mktcap and mktcap > 0) else None

    annual_block = _vl_series_from_annuals(annuals) if annuals else {"labels": [], "rows": [], "n_years": 0}

    # Quarterly compact block (last 8)
    q_labels, q_rev, q_ni, q_eps, q_fcf, q_om = [], [], [], [], [], []
    for r in quarters[-8:]:
        pe = r.get("period_end")
        fp = r.get("fp") or ""
        fy = r.get("fy")
        lab = f"{fp}'{str(fy)[-2:]}" if (fp and fy) else (str(pe)[:10] if pe else "—")
        q_labels.append(lab)
        q_rev.append(_vl_f(r.get("revenue")))
        q_ni.append(_vl_f(r.get("net_income")))
        e = _vl_f(r.get("diluted_eps"))
        sh = _vl_f(r.get("shares_outstanding")) or _vl_f(r.get("diluted_shares"))
        niq = _vl_f(r.get("net_income"))
        if e is None and niq is not None and sh:
            e = niq / sh
        q_eps.append(e)
        q_fcf.append(_vl_f(r.get("free_cash_flow")))
        q_om.append(_vl_pct(r.get("operating_income"), r.get("revenue")))

    quarterly = {
        "labels": q_labels,
        "rows": [
            {"id": "q_rev", "label": "Revenue", "unit": "$", "values": q_rev},
            {"id": "q_ni", "label": "Net Income", "unit": "$", "values": q_ni},
            {"id": "q_eps", "label": "Diluted EPS", "unit": "$/sh", "values": q_eps},
            {"id": "q_fcf", "label": "Free Cash Flow", "unit": "$", "values": q_fcf},
            {"id": "q_om", "label": "Op. Margin", "unit": "%", "values": q_om},
        ],
    }

    return {
        "ok": True,
        "ticker": tk,
        "entity_name": entity,
        "sector": meta.get("sector"),
        "industry": meta.get("industry"),
        "price": price,
        "as_of_quote": q.get("as_of") or q.get("updated_at"),
        "capital": {
            "market_cap": mktcap,
            "enterprise_value": ev,
            "price": price,
            "pe": pe,
            "pb": pb,
            "ev_ebitda": ev_eb,
            "fcf_yield_pct": fcf_y,
            "cash": cash if cash else _vl_cash(L),
            "total_debt": debt,
            "equity": equity,
            "shares": shares,
            "book_value_ps": bvps,
            "revenue_ltm_or_fy": rev,
            "net_income_fy": ni,
            "fcf_fy": fcf,
            "period_end": (L.get("period_end").isoformat()
                           if hasattr(L.get("period_end"), "isoformat") else L.get("period_end")),
            "fy": L.get("fy"),
        },
        "annual": annual_block,
        "quarterly": quarterly,
        "source": "Postgres company_financials + market_quotes (SEC XBRL pull)",
        "cost": "DB read only · zero LLM · zero SEC on view",
    }


def _fin_sheet_pdf_bytes(sheet: dict) -> bytes:
    """Render a compact Value Line–style PDF from a sheet payload (reportlab)."""
    if not _REPORTLAB_OK:
        raise RuntimeError("reportlab not installed")
    from io import BytesIO
    from reportlab.lib.pagesizes import letter, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(letter),
        leftMargin=0.4 * inch, rightMargin=0.4 * inch,
        topMargin=0.35 * inch, bottomMargin=0.35 * inch,
    )
    styles = getSampleStyleSheet()
    title_s = ParagraphStyle(
        "vl_title", parent=styles["Heading1"], fontSize=14, leading=16,
        spaceAfter=2, textColor=colors.HexColor("#0A1628"))
    sub_s = ParagraphStyle(
        "vl_sub", parent=styles["Normal"], fontSize=8, leading=10,
        textColor=colors.HexColor("#475569"))
    cell_s = ParagraphStyle(
        "vl_cell", parent=styles["Normal"], fontSize=6.5, leading=8,
        alignment=TA_RIGHT)
    lab_s = ParagraphStyle(
        "vl_lab", parent=styles["Normal"], fontSize=6.5, leading=8,
        alignment=TA_LEFT, textColor=colors.HexColor("#0f172a"))
    sec_s = ParagraphStyle(
        "vl_sec", parent=styles["Normal"], fontSize=7, leading=9,
        textColor=colors.HexColor("#0369a1"), fontName="Helvetica-Bold")

    def money(v, unit="$"):
        if v is None:
            return "—"
        try:
            x = float(v)
        except (TypeError, ValueError):
            return "—"
        if unit == "%":
            return f"{x:.1f}%"
        if unit == "x":
            return f"{x:.2f}×"
        if unit == "$/sh":
            return f"${x:,.2f}"
        if unit == "sh":
            if abs(x) >= 1e9:
                return f"{x/1e9:.2f}B"
            if abs(x) >= 1e6:
                return f"{x/1e6:.1f}M"
            return f"{x:,.0f}"
        # $ absolute
        ax = abs(x)
        sign = "-" if x < 0 else ""
        if ax >= 1e12:
            return f"{sign}${ax/1e12:.2f}T"
        if ax >= 1e9:
            return f"{sign}${ax/1e9:.2f}B"
        if ax >= 1e6:
            return f"{sign}${ax/1e6:.1f}M"
        if ax >= 1e3:
            return f"{sign}${ax/1e3:.0f}K"
        return f"{sign}${ax:,.0f}"

    story = []
    tk = sheet.get("ticker") or ""
    name = sheet.get("entity_name") or tk
    px = sheet.get("price")
    px_s = f"${px:,.2f}" if px is not None else "—"
    story.append(Paragraph(
        f"{name} <font color='#64748b'>({tk})</font>  ·  Recent price {px_s}",
        title_s))
    ind = " · ".join(x for x in [sheet.get("industry"), sheet.get("sector")] if x)
    cap = sheet.get("capital") or {}
    story.append(Paragraph(
        f"{ind or '—'}  ·  Mkt cap {money(cap.get('market_cap'))}  ·  "
        f"EV {money(cap.get('enterprise_value'))}  ·  P/E {money(cap.get('pe'), 'x')}  ·  "
        f"EV/EBITDA {money(cap.get('ev_ebitda'), 'x')}  ·  Cash {money(cap.get('cash'))}  ·  "
        f"Debt {money(cap.get('total_debt'))}  ·  SEC store (no LLM)",
        sub_s))
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#94a3b8")))
    story.append(Spacer(1, 4))

    annual = sheet.get("annual") or {}
    labels = annual.get("labels") or []
    rows = annual.get("rows") or []
    if labels and rows:
        header = [Paragraph("<b>Annual statistical array</b>", lab_s)] + [
            Paragraph(f"<b>{l}</b>", cell_s) for l in labels]
        data = [header]
        for r in rows:
            unit = r.get("unit") or "$"
            if unit == "section":
                data.append([Paragraph(r.get("label") or "", sec_s)] +
                            [""] * len(labels))
                continue
            data.append(
                [Paragraph(r.get("label") or "", lab_s)] +
                [Paragraph(money(v, unit), cell_s) for v in (r.get("values") or [])]
            )
        ncols = 1 + len(labels)
        label_w = 1.55 * inch
        rest = max(0.45 * inch, (10.2 * inch - label_w) / max(len(labels), 1))
        col_w = [label_w] + [rest] * len(labels)
        t = Table(data, colWidths=col_w, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0A1628")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 6.5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f8fafc")]),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(t)

    qtr = sheet.get("quarterly") or {}
    ql, qr = qtr.get("labels") or [], qtr.get("rows") or []
    if ql and qr:
        story.append(Spacer(1, 10))
        story.append(Paragraph("Recent quarters", sec_s))
        story.append(Spacer(1, 3))
        header = [Paragraph("<b>Quarterly</b>", lab_s)] + [
            Paragraph(f"<b>{l}</b>", cell_s) for l in ql]
        data = [header]
        for r in qr:
            unit = r.get("unit") or "$"
            data.append(
                [Paragraph(r.get("label") or "", lab_s)] +
                [Paragraph(money(v, unit), cell_s) for v in (r.get("values") or [])]
            )
        label_w = 1.4 * inch
        rest = max(0.55 * inch, (10.2 * inch - label_w) / max(len(ql), 1))
        t2 = Table(data, colWidths=[label_w] + [rest] * len(ql))
        t2.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e3a5f")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f1f5f9")]),
            ("FONTSIZE", (0, 0), (-1, -1), 6.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(t2)

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "DGA Capital · Value Line–style sheet from SEC EDGAR XBRL store · "
        "Insert-only warehouse · Not investment advice · Generated on demand",
        sub_s))
    doc.build(story)
    return buf.getvalue()


@app.get("/api/financials/{ticker}/sheet")
def financials_valueline_sheet(ticker: str, request: Request):
    """Value Line–style financial sheet (JSON). Pure DB — free, no LLM, no SEC."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    sheet = _build_fin_sheet(ticker)
    if not sheet.get("ok"):
        return JSONResponse(sheet, status_code=404 if "No financials" in (sheet.get("error") or "") else 400)
    return sheet


@app.get("/api/financials/{ticker}/sheet.pdf")
def financials_valueline_pdf(ticker: str, request: Request):
    """On-demand PDF of the Value Line sheet. CPU only when clicked — not scheduled."""
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    if not _REPORTLAB_OK:
        raise HTTPException(400, "PDF engine (reportlab) not installed on this server")
    sheet = _build_fin_sheet(ticker)
    if not sheet.get("ok"):
        raise HTTPException(404, sheet.get("error") or "not found")
    try:
        pdf = _fin_sheet_pdf_bytes(sheet)
    except Exception as e:
        raise HTTPException(500, f"PDF render failed: {e!s:.160}")
    tk = sheet.get("ticker") or ticker.upper()
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{tk}_DGA_Financials_Sheet.pdf"',
            "Cache-Control": "private, max-age=120",
        },
    )


# ── Interactive price chart (GuruFocus-style) — Yahoo history, durable cache ─
# Daily bars persist in price_history so range clicks are instant DB reads.
# Intraday (5D) is fetched live with a short in-memory TTL (not worth persisting
# at minute granularity). All pure market data — ZERO LLM tokens.
_PRICE_SYNC_TS: dict[str, float] = {}     # symbol -> last daily-sync epoch (throttle)
_INTRADAY_CACHE: dict[str, tuple] = {}    # symbol -> (epoch, [points])
_PRICE_SYNC_MIN_S = 3 * 3600              # re-sync a symbol's daily tail at most every 3h
_INTRADAY_TTL_S = 120                     # 5D intraday cache lifetime


def _sync_price_history(tk: str) -> None:
    """Fetch the missing daily-bar tail for tk from Yahoo/free sources and upsert it.
    Throttled per-symbol; first call backfills ~11 years. Best-effort: any
    failure leaves whatever is already stored intact (still served below)."""
    from datetime import date as _date, timedelta as _td
    if not (_PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
        return
    now = time.time()
    if now - _PRICE_SYNC_TS.get(tk, 0) < _PRICE_SYNC_MIN_S:
        return                                   # synced recently — serve from DB
    _PRICE_SYNC_TS[tk] = now                      # set before the call (avoid stampede)
    try:
        import market_data as _md
        _ensure_market_tables()
        with _fund_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT max(d) FROM price_history WHERE symbol=%s", (tk,))
            last_d = cur.fetchone()[0]
        today = _date.today()
        if last_d is None:
            start = (today - _td(days=3700)).isoformat()      # ~11y backfill
        elif last_d >= today - _td(days=1):
            return                                            # already current
        else:
            start = last_d.isoformat()                        # tail only
        bars = _md.get_price_history(_resolve_ticker_alias(tk), interval="daily",
                                     start=start, end=today.isoformat())
        if not bars:
            return
        src = "yahoo"
        with _fund_conn() as conn, conn.cursor() as cur:
            for b in bars:
                if not b.get("date") or b.get("close") is None:
                    continue
                cur.execute("""INSERT INTO price_history (symbol, d, close, source, updated_at)
                               VALUES (%s,%s,%s,%s, now())
                               ON CONFLICT (symbol, d) DO UPDATE SET
                                 close=EXCLUDED.close, source=EXCLUDED.source,
                                 updated_at=now()""",
                            (tk, b["date"], b["close"], src))
            conn.commit()
    except Exception as e:
        print(f"[price-hist] sync {tk} failed: {e!s:.160}", flush=True)


def _price_stats(pts: list, range_label: str) -> dict:
    """Window change + above-low / below-high, from a [{t,c}] series."""
    closes = [p["c"] for p in pts if p.get("c") is not None]
    if len(closes) < 2:
        return {}
    first, last = closes[0], closes[-1]
    lo, hi = min(closes), max(closes)
    pct = lambda a, b: ((b - a) / a * 100.0) if a else None
    return {
        "last": round(last, 2),
        "range_low": round(lo, 2), "range_high": round(hi, 2),
        "change_pct": (round(pct(first, last), 2) if pct(first, last) is not None else None),
        "change_label": range_label,
        "above_low_pct": (round(pct(lo, last), 2) if pct(lo, last) is not None else None),
        "below_high_pct": (round(pct(hi, last), 2) if pct(hi, last) is not None else None),
    }


@app.get("/api/financials/{ticker}/price-history")
def financials_price_history(ticker: str, request: Request, range: str = "YTD"):
    """Interactive-chart price series for one ticker. Daily bars from the durable
    price_history store (Yahoo-synced); 5D from live intraday. Pure market
    data — no LLM. Returns {ok, ticker, range, points:[{t,c}], stats{...}}."""
    from datetime import date as _date, timedelta as _td, datetime as _dt
    claims = _claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only")
    tk = ticker.upper().strip()
    rng = (range or "YTD").upper()

    # ── 5D → live intraday (15-min bars), short TTL cache ─────────────────
    if rng == "5D":
        cached = _INTRADAY_CACHE.get(tk)
        if cached and (time.time() - cached[0]) < _INTRADAY_TTL_S:
            pts = cached[1]
        else:
            pts = []
            try:
                import market_data as _md
                bars = _md.get_intraday(tk)            # Yahoo v8 chart (free)
                pts = [{"t": b["time"], "c": b["close"]}
                       for b in (bars or []) if b.get("close") is not None]
                _INTRADAY_CACHE[tk] = (time.time(), pts)
            except Exception as e:
                print(f"[price-hist] intraday {tk} failed: {e!s:.140}", flush=True)
        if not pts:
            # Intraday unavailable (e.g. weekend / unsupported) → fall back to the
            # last ~7 daily closes from the store so the 5D button still plots.
            _sync_price_history(tk)
            try:
                with _fund_conn() as conn, conn.cursor() as cur:
                    cur.execute("SELECT d, close FROM price_history WHERE symbol=%s "
                                "ORDER BY d DESC LIMIT 7", (tk,))
                    daily = [{"t": d.isoformat(), "c": float(c)}
                             for d, c in cur.fetchall()][::-1]
                if len(daily) >= 2:
                    return {"ok": True, "ticker": tk, "range": "5D", "points": daily,
                            "stats": _price_stats(daily, "5D"), "intraday": False}
            except Exception as e:
                print(f"[price-hist] 5D daily-fallback {tk} failed: {e!s:.140}", flush=True)
            return {"ok": False, "error": f"No intraday data for {tk} "
                                          f"(market may be closed or symbol unsupported)."}
        return {"ok": True, "ticker": tk, "range": "5D", "points": pts,
                "stats": _price_stats(pts, "5D"), "intraday": True}

    # ── Daily ranges → durable store (sync tail, then slice) ──────────────
    _sync_price_history(tk)
    today = _date.today()
    if rng == "YTD":
        start_d = _date(today.year, 1, 1)
    elif rng == "ALL":
        start_d = None
    else:
        _days = {"1M": 31, "3M": 92, "1Y": 366, "3Y": 1096,
                 "5Y": 1827, "10Y": 3653}.get(rng, 366)
        start_d = today - _td(days=_days)

    pts = []
    try:
        with _fund_conn() as conn, conn.cursor() as cur:
            if start_d is None:
                cur.execute("SELECT d, close FROM price_history WHERE symbol=%s "
                            "ORDER BY d ASC", (tk,))
            else:
                cur.execute("SELECT d, close FROM price_history WHERE symbol=%s "
                            "AND d >= %s ORDER BY d ASC", (tk, start_d.isoformat()))
            for d, c in cur.fetchall():
                pts.append({"t": d.isoformat(), "c": float(c)})
    except Exception as e:
        print(f"[price-hist] read {tk} failed: {e!s:.140}", flush=True)

    if not pts:
        return {"ok": False, "error": f"No price history stored for {tk} yet — "
                                      f"Yahoo/history unavailable or the symbol is unsupported."}
    return {"ok": True, "ticker": tk, "range": rng, "points": pts,
            "stats": _price_stats(pts, rng)}

