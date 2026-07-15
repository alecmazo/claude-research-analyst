"""
market_data.py — Free market-data layer for DGA Capital (no Tradier).

Primary sources (no paid brokerage account required):
  • Yahoo Finance v8 chart API — quotes, daily history, intraday (free, no key)
  • yfinance library — option chains / expirations fallback (free, no key)
  • Tiingo (optional) — if TIINGO_API_KEY is set in Railway env

Tradier was removed: free/sandbox accounts are no longer practical. Call sites
that checked tradier_available() still work — it always returns False.

Normalized shapes
-----------------
quote:  {price, prev_close, pct_change, source}
option row: {strike, option_type('call'|'put'), bid, ask, last, iv, delta,
             open_interest, volume, source}
"""

from __future__ import annotations

import os


# ── Legacy Tradier stubs (disabled — always unavailable) ─────────────────────
def _tradier_cfg():
    return "", ""


def tradier_available() -> bool:
    """Always False — Tradier is not used. Kept so older call sites stay safe."""
    return False


def _tradier_get(path: str, params: dict):
    return None


def _as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _f(v):
    try:
        v = float(v)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def _i(v):
    try:
        v = float(v)
        return int(v) if v == v else 0
    except (TypeError, ValueError):
        return 0


def tradier_quotes(symbols: list) -> dict | None:
    """Disabled — use get_quotes()."""
    return None


def tradier_expirations(symbol: str) -> list | None:
    return None


def _norm_tradier_option(o: dict) -> dict:
    return {}


def tradier_chain(symbol: str, expiration: str) -> list | None:
    return None


# ── Yahoo chart quotes (free primary) ────────────────────────────────────────
def _yahoo_chart_quote(symbol: str) -> dict | None:
    """One symbol via Yahoo v8 chart meta — regularMarketPrice + previousClose."""
    import requests
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    for host in ("query1", "query2"):
        try:
            r = requests.get(
                f"https://{host}.finance.yahoo.com/v8/finance/chart/{sym}",
                params={"range": "5d", "interval": "1d", "includePrePost": "false"},
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0 DGACapital/1.0"},
            )
            if r.status_code != 200:
                continue
            res0 = (((r.json().get("chart") or {}).get("result")) or [None])[0]
            if not res0:
                continue
            meta = res0.get("meta") or {}
            # Live last trade / session price
            px = (meta.get("regularMarketPrice")
                  or meta.get("postMarketPrice")
                  or meta.get("preMarketPrice"))
            # Official prior-session close for day-change. NEVER prefer
            # chartPreviousClose first — it is often an older bar in the
            # chart range and inflates day % (e.g. C at −2.4% vs real −0.2%).
            prev = (meta.get("previousClose")
                    or meta.get("regularMarketPreviousClose")
                    or meta.get("chartPreviousClose"))
            if px is None:
                closes = ((res0.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
                closes = [c for c in closes if c is not None]
                if closes:
                    px = closes[-1]
                    # Only use prior bar if meta did not give an official prev close
                    if prev is None and len(closes) >= 2:
                        prev = closes[-2]
            if px is None:
                continue
            pct = None
            if prev not in (None, 0):
                pct = (float(px) - float(prev)) / float(prev) * 100.0
            return {
                "price": float(px),
                "prev_close": float(prev) if prev is not None else None,
                "pct_change": pct,
                "source": "yahoo-chart",
            }
        except Exception as e:
            print(f"[market_data] yahoo quote {sym} {host}: {e!s:.100}", flush=True)
    return None


def _tiingo_quotes(symbols: list) -> dict:
    """Optional Tiingo IEX batch (free tier with TIINGO_API_KEY)."""
    key = (os.environ.get("TIINGO_API_KEY") or "").strip()
    if not key or not symbols:
        return {}
    out = {}
    try:
        import requests
        # Tiingo allows comma-separated tickers
        r = requests.get(
            "https://api.tiingo.com/iex",
            params={"tickers": ",".join(symbols), "token": key},
            timeout=10,
            headers={"Content-Type": "application/json"},
        )
        if r.status_code != 200:
            return {}
        rows = r.json()
        if isinstance(rows, dict):
            rows = [rows]
        for it in rows or []:
            sym = (it.get("ticker") or "").upper()
            if not sym:
                continue
            px = _f(it.get("tngoLast") or it.get("last") or it.get("close"))
            prev = _f(it.get("prevClose") or it.get("previousClose"))
            pct = None
            if px is not None and prev not in (None, 0):
                pct = (px - prev) / prev * 100.0
            if px is not None:
                out[sym] = {
                    "price": px,
                    "prev_close": prev,
                    "pct_change": pct,
                    "source": "tiingo",
                }
    except Exception as e:
        print(f"[market_data] tiingo quotes failed: {e!s:.120}", flush=True)
    return out


def _yf_quotes(symbols: list) -> dict:
    """Yahoo chart per-symbol (same as primary; kept for get_quotes fill)."""
    out = {}
    for sym in symbols or []:
        q = _yahoo_chart_quote(sym)
        if q:
            out[sym.upper()] = q
    return out


def _norm_yf_option(row, opt_type: str) -> dict:
    g = lambda k: row.get(k) if hasattr(row, "get") else getattr(row, k, None)
    return {
        "strike": _f(g("strike")),
        "option_type": opt_type,
        "bid": _f(g("bid")) or 0.0,
        "ask": _f(g("ask")) or 0.0,
        "last": _f(g("lastPrice")),
        "iv": _f(g("impliedVolatility")),
        "delta": None,
        "open_interest": _i(g("openInterest")),
        "volume": _i(g("volume")),
        "source": "yfinance",
    }


def _yf_chain(symbol: str, expiration: str) -> list | None:
    try:
        import yfinance as yf
        ch = yf.Ticker(symbol).option_chain(expiration)
        rows = []
        for _, r in ch.calls.iterrows():
            rows.append(_norm_yf_option(r, "call"))
        for _, r in ch.puts.iterrows():
            rows.append(_norm_yf_option(r, "put"))
        return rows
    except Exception as e:
        print(f"[market_data] yfinance chain {symbol} {expiration} failed: {e!s:.120}", flush=True)
        return None


def _yf_expirations(symbol: str) -> list:
    try:
        import yfinance as yf
        return list(getattr(yf.Ticker(symbol), "options", []) or [])
    except Exception:
        return []


# ── Unified public API (Yahoo + optional Tiingo; no Tradier) ─────────────────
def get_quotes(symbols: list) -> dict:
    """{SYM: quote}. Yahoo chart first; Tiingo fills gaps when key is set."""
    symbols = [s.strip().upper() for s in symbols if s and s.strip()]
    if not symbols:
        return {}
    out = {}
    # Parallel-friendly sequential Yahoo (reliable, free)
    for sym in symbols:
        q = _yahoo_chart_quote(sym)
        if q:
            out[sym] = q
    missing = [s for s in symbols if s not in out or out[s].get("price") is None]
    if missing:
        tq = _tiingo_quotes(missing)
        out.update(tq)
    return out


def get_expirations(symbol: str) -> list:
    return _yf_expirations(symbol) or []


def get_chain(symbol: str, expiration: str) -> list:
    """Normalized option rows — yfinance only (free)."""
    return _yf_chain(symbol, expiration) or []


def source_label() -> str:
    if (os.environ.get("TIINGO_API_KEY") or "").strip():
        return "yahoo+tiingo"
    return "yahoo"


# ── Yahoo v8 chart API (free, no key) ────────────────────────────────────────
# This is the raw JSON chart endpoint (query1/query2.finance.yahoo.com), NOT the
# crumb-authenticated path the yfinance library uses — it is lighter and far more
# tolerant of cloud IPs, so it sidesteps most of the cloud-IP block. Returns
# split/dividend-adjusted closes when available.
def _yahoo_chart_raw(symbol: str, rng: str, interval: str):
    """→ (timestamps[], closes[], gmtoffset_seconds) or (None, None, 0)."""
    import requests
    for host in ("query1", "query2"):
        try:
            r = requests.get(
                f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}",
                params={"range": rng, "interval": interval, "includePrePost": "false"},
                timeout=15, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                continue
            res = (((r.json().get("chart") or {}).get("result")) or [None])[0]
            if not res:
                continue
            ts = res.get("timestamp") or []
            ind = res.get("indicators") or {}
            adj = ind.get("adjclose")
            closes = ((adj[0].get("adjclose") if adj else None)
                      or (ind.get("quote") or [{}])[0].get("close") or [])
            gmt = ((res.get("meta") or {}).get("gmtoffset")) or 0
            if ts:
                return ts, closes, gmt
        except Exception as e:
            print(f"[market_data] yahoo chart {symbol} {host} failed: {e!s:.120}", flush=True)
    return None, None, 0


def yahoo_history(symbol: str, rng: str = "max") -> list | None:
    """Daily adjusted closes from Yahoo v8 chart. [{date, close}] or None."""
    import datetime as _dt
    ts, closes, _ = _yahoo_chart_raw(symbol, rng, "1d")
    if not ts:
        return None
    out = []
    for t, c in zip(ts, closes):
        c = _f(c)
        if c is None:
            continue
        out.append({"date": _dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"),
                    "close": c})
    return out or None


def yahoo_intraday(symbol: str, rng: str = "5d", interval: str = "15m") -> list | None:
    """Intraday closes from Yahoo v8 chart, in market-local time. [{time, close}]."""
    import datetime as _dt
    ts, closes, gmt = _yahoo_chart_raw(symbol, rng, interval)
    if not ts:
        return None
    out = []
    for t, c in zip(ts, closes):
        c = _f(c)
        if c is None:
            continue
        out.append({"time": _dt.datetime.utcfromtimestamp(t + gmt).strftime("%Y-%m-%d %H:%M"),
                    "close": c})
    return out or None



def _yf_history(symbol: str, period: str = "max",
                interval: str = "1d") -> list | None:
    """yfinance daily bars fallback. [{date, close}] or None."""
    try:
        import yfinance as yf
        df = yf.Ticker(symbol).history(period=period, interval=interval,
                                       auto_adjust=True)
        out = []
        for idx, row in df["Close"].dropna().items():
            out.append({"date": idx.strftime("%Y-%m-%d"), "close": float(row)})
        return out or None
    except Exception as e:
        print(f"[market_data] yf history {symbol} failed: {e!s:.120}", flush=True)
        return None


def _yahoo_range_for(start: str) -> str:
    """Smallest Yahoo range token that still covers `start` → today."""
    if not start:
        return "max"
    try:
        from datetime import date as _date
        y, m, d = map(int, start.split("-"))
        days = (_date.today() - _date(y, m, d)).days
    except Exception:
        return "max"
    for thr, tok in [(7, "1mo"), (35, "3mo"), (95, "6mo"), (370, "1y"),
                     (740, "2y"), (1850, "5y"), (3700, "10y")]:
        if days <= thr:
            return tok
    return "max"


def get_price_history(symbol: str, interval: str = "daily",
                      start: str = None, end: str = None,
                      adjusted: bool = False) -> list:
    """Daily bars via free Yahoo v8 chart → yfinance fallback.

    Prefer adjusted Yahoo closes for return math (split-adjusted).
    """
    rows = yahoo_history(symbol, rng=_yahoo_range_for(start))
    if not rows:
        rows = _yf_history(symbol)
    return rows or []


def get_intraday(symbol: str) -> list:
    """5-day intraday closes (15-min) from free Yahoo v8 chart."""
    return yahoo_intraday(symbol) or []


def _us_equity_session_date():
    """US equity session date (America/New_York calendar date).

    Before ~4am ET we still treat the prior calendar day as the active
    session date (Yahoo day_gainers often freezes on last close overnight).
    After that, today's date — pre-market / RTH / after-hours all count as
    the current session once Yahoo starts publishing it.
    """
    from datetime import datetime, timedelta
    try:
        from zoneinfo import ZoneInfo
        et = ZoneInfo("America/New_York")
    except Exception:
        et = None
    now = datetime.now(et) if et else datetime.utcnow()
    # Yahoo often keeps prior-session screeners until early morning ET.
    # After 04:00 ET we expect "today" (premarket) or last completed session.
    if now.hour < 4:
        return (now.date() - timedelta(days=1)).isoformat()
    return now.date().isoformat()


def yahoo_market_movers(min_price: float = 3.0, min_market_cap: float = 2e9,
                        per_list: int = 30) -> list:
    """Biggest BROAD-MARKET movers from Yahoo's free predefined screeners
    (day_gainers + day_losers + most_actives) — the day's real movers market-wide,
    not just a given universe. No API key; same cloud-tolerant Yahoo host family
    as the price-chart endpoint. Returns [{ticker, price, pct_change, name,
    market_cap, market_time, session_date}], deduped to the largest move.
    Filters out penny stocks (< min_price), micro/small caps (known marketCap
    < min_market_cap, default $2B), and quotes whose regularMarketTime is older
    than the active US session (drops weekend / multi-day-stale names that
    sometimes leak into most_actives)."""
    import requests
    from datetime import datetime, timezone
    try:
        from zoneinfo import ZoneInfo
        _ET = ZoneInfo("America/New_York")
    except Exception:
        _ET = timezone.utc

    session_date = _us_equity_session_date()
    out: dict = {}
    for scr in ("day_gainers", "day_losers", "most_actives"):
        got = False
        for host in ("query1", "query2"):
            try:
                r = requests.get(
                    f"https://{host}.finance.yahoo.com/v1/finance/screener/predefined/saved",
                    params={"scrIds": scr, "count": per_list},
                    timeout=12, headers={"User-Agent": "Mozilla/5.0"})
                if r.status_code != 200:
                    continue
                res = (((r.json().get("finance") or {}).get("result")) or [None])[0]
                if not res:
                    continue
                for q in (res.get("quotes") or []):
                    sym = (q.get("symbol") or "").upper().strip()
                    px  = _f(q.get("regularMarketPrice"))
                    pct = _f(q.get("regularMarketChangePercent"))
                    mc  = _f(q.get("marketCap"))
                    if not sym or px is None or pct is None or px < min_price:
                        continue
                    if mc is not None and mc < min_market_cap:
                        continue   # drop micro / small caps
                    # Skip flat names from most_actives (noise, often multi-day stale)
                    if abs(pct) < 0.05 and scr == "most_actives":
                        continue
                    mkt_ts = q.get("regularMarketTime")
                    mkt_iso = None
                    quote_session = None
                    if mkt_ts:
                        try:
                            dt = datetime.fromtimestamp(int(mkt_ts), tz=timezone.utc)
                            mkt_iso = dt.isoformat()
                            quote_session = dt.astimezone(_ET).date().isoformat()
                        except Exception:
                            quote_session = None
                    # Drop multi-day-stale quotes (e.g. most_actives from last week)
                    if quote_session:
                        try:
                            from datetime import date as _date
                            age = (_date.fromisoformat(session_date)
                                   - _date.fromisoformat(quote_session)).days
                            if age > 1:
                                continue
                        except Exception:
                            pass
                    row = {
                        "ticker": sym,
                        "price": px,
                        "pct_change": round(pct, 4),
                        "market_cap": mc,
                        "name": q.get("shortName") or q.get("longName")
                                or q.get("displayName") or "",
                        "market_time": mkt_iso,
                        "session_date": quote_session or session_date,
                        "screener": scr,
                    }
                    if sym not in out or abs(pct) > abs(out[sym]["pct_change"]):
                        out[sym] = row
                got = True
                break
            except Exception as e:
                print(f"[market_data] yahoo movers {scr} {host} failed: {e!s:.120}", flush=True)
        if not got:
            print(f"[market_data] yahoo movers {scr}: no data", flush=True)
    rows = list(out.values())
    # Keep only the freshest session Yahoo is actually publishing (today once
    # premarket/RTH ticks; otherwise last completed session — not a mix).
    dated = [r.get("session_date") for r in rows if r.get("session_date")]
    if dated:
        newest = max(dated)
        rows = [r for r in rows if (r.get("session_date") or newest) >= newest]
    return rows


# ── Nasdaq earnings calendar (free, no key) ──────────────────────────────────
# Used to flag imminent quarterly results on the GP watchlist.
_EARNINGS_CACHE: dict = {}   # day_iso -> (epoch, rows)
_EARNINGS_TTL_S = 4 * 3600


def nasdaq_earnings_for_day(day_iso: str) -> list[dict]:
    """Earnings scheduled for a calendar day (YYYY-MM-DD) from Nasdaq's free API.

    Returns list of {symbol, name, time, fiscal_quarter, eps_forecast, ...}.
    Empty list on failure — never raises.
    """
    import time as _time
    day_iso = (day_iso or "")[:10]
    if not day_iso:
        return []
    hit = _EARNINGS_CACHE.get(day_iso)
    if hit and _time.time() - hit[0] < _EARNINGS_TTL_S:
        return hit[1]
    rows_out: list[dict] = []
    try:
        import requests
        r = requests.get(
            "https://api.nasdaq.com/api/calendar/earnings",
            params={"date": day_iso},
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; DGA-Capital/1.0)",
                "Accept": "application/json",
            },
            timeout=4,
        )
        if r.status_code == 200:
            data = (r.json() or {}).get("data") or {}
            for row in (data.get("rows") or []):
                sym = (row.get("symbol") or "").strip().upper()
                if not sym:
                    continue
                rows_out.append({
                    "symbol": sym,
                    "name": row.get("name") or "",
                    "time": row.get("time") or "",  # time-pre-market / time-after-hours / …
                    "fiscal_quarter": row.get("fiscalQuarterEnding") or "",
                    "eps_forecast": row.get("epsForecast") or "",
                    "date": day_iso,
                })
        else:
            print(f"[market_data] nasdaq earnings {day_iso} HTTP {r.status_code}", flush=True)
    except Exception as e:
        print(f"[market_data] nasdaq earnings {day_iso} failed: {e!s:.120}", flush=True)
    _EARNINGS_CACHE[day_iso] = (_time.time(), rows_out)
    return rows_out


def earnings_upcoming(symbols: list[str] | None = None,
                      horizon_days: int = 5,
                      include_past_days: int = 1) -> dict[str, dict]:
    """Map SYMBOL → next earnings event within the horizon window.

    Window: [today - include_past_days, today + horizon_days] (calendar days).
    When *symbols* is set, only those tickers are returned.
    """
    from datetime import date, timedelta
    want = None
    if symbols is not None:
        want = {str(s).strip().upper() for s in symbols if s}
        if not want:
            return {}
    today = date.today()
    start = today - timedelta(days=max(0, int(include_past_days)))
    end = today + timedelta(days=max(0, int(horizon_days)))
    days: list[str] = []
    d = start
    while d <= end:
        days.append(d.isoformat())
        d += timedelta(days=1)

    # Parallel day fetches — sequential was stacking 4–12s and blocking mobile
    # watchlist price refresh after the earnings feature landed.
    day_rows: list[tuple[str, list]] = []
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=min(6, max(1, len(days)))) as pool:
            futs = {pool.submit(nasdaq_earnings_for_day, day): day for day in days}
            for fut in as_completed(futs, timeout=8):
                day = futs[fut]
                try:
                    day_rows.append((day, fut.result() or []))
                except Exception:
                    day_rows.append((day, []))
    except Exception:
        for day in days:
            try:
                day_rows.append((day, nasdaq_earnings_for_day(day) or []))
            except Exception:
                day_rows.append((day, []))

    best: dict[str, dict] = {}
    for day_iso, rows in day_rows:
        try:
            from datetime import date as _date
            day_d = _date.fromisoformat(day_iso)
        except Exception:
            continue
        for row in rows:
            sym = row["symbol"]
            if want is not None and sym not in want:
                continue
            days_until = (day_d - today).days
            rec = {
                **row,
                "days_until": days_until,
                "imminent": -include_past_days <= days_until <= horizon_days,
            }
            prev = best.get(sym)
            if prev is None:
                best[sym] = rec
            else:
                def _rank(r):
                    du = r["days_until"]
                    return (0 if du >= 0 else 1, abs(du))
                if _rank(rec) < _rank(prev):
                    best[sym] = rec
    return best


_EARNINGS_DETAIL_CACHE: dict = {}  # symbol -> (epoch, payload)
_EARNINGS_DETAIL_TTL_S = 30 * 60


def _parse_money_num(v):
    """Parse '$5.59' / '5.59' / 5.59 → float or None."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        try:
            f = float(v)
            return f if f == f else None
        except (TypeError, ValueError):
            return None
    s = str(v).strip().replace(",", "").replace("$", "")
    if not s or s in ("—", "-", "N/A", "n/a"):
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def nasdaq_earnings_surprise(symbol: str) -> dict:
    """Historical EPS actual vs consensus from Nasdaq (free).

    Returns {history: [...], latest: {...}|None} — never raises.
    """
    import time as _time
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"history": [], "latest": None}
    hit = _EARNINGS_DETAIL_CACHE.get(sym)
    if hit and _time.time() - hit[0] < _EARNINGS_DETAIL_TTL_S:
        return hit[1]
    history: list[dict] = []
    try:
        import requests
        r = requests.get(
            f"https://api.nasdaq.com/api/company/{sym}/earnings-surprise",
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; DGA-Capital/1.0)",
                "Accept": "application/json",
            },
            timeout=12,
        )
        if r.status_code == 200:
            data = (r.json() or {}).get("data") or {}
            table = (data.get("earningsSurpriseTable") or {})
            for row in (table.get("rows") or []):
                actual = _parse_money_num(row.get("eps"))
                est = _parse_money_num(row.get("consensusForecast"))
                surprise_pct = _parse_money_num(row.get("percentageSurprise"))
                beat = None
                if actual is not None and est is not None:
                    if actual > est:
                        beat = "beat"
                    elif actual < est:
                        beat = "miss"
                    else:
                        beat = "inline"
                history.append({
                    "fiscal_quarter": row.get("fiscalQtrEnd") or "",
                    "date_reported": row.get("dateReported") or "",
                    "eps_actual": actual,
                    "eps_estimate": est,
                    "surprise_pct": surprise_pct,
                    "beat": beat,
                })
        else:
            print(f"[market_data] nasdaq surprise {sym} HTTP {r.status_code}", flush=True)
    except Exception as e:
        print(f"[market_data] nasdaq surprise {sym} failed: {e!s:.120}", flush=True)
    out = {
        "history": history,
        "latest": history[0] if history else None,
    }
    _EARNINGS_DETAIL_CACHE[sym] = (_time.time(), out)
    return out


def earnings_card(symbol: str, horizon_days: int = 5,
                  include_past_days: int = 1) -> dict:
    """Full earnings card payload for watchlist chip click.

    Combines upcoming calendar event (if any) + surprise history + beat/miss.
    Free Nasdaq sources only — no LLM.
    """
    from datetime import date, datetime, timedelta
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "invalid ticker"}

    upcoming = earnings_upcoming([sym], horizon_days=horizon_days,
                                 include_past_days=include_past_days).get(sym)
    surprise = nasdaq_earnings_surprise(sym)
    history = surprise.get("history") or []
    latest = surprise.get("latest")

    # Session label from calendar
    session = ""
    if upcoming:
        tlabel = (upcoming.get("time") or "").lower()
        if "pre" in tlabel:
            session = "BMO"
        elif "after" in tlabel or "post" in tlabel:
            session = "AMC"

    # Determine if latest surprise is "this" event (reported within window)
    result = None
    status = "scheduled"  # scheduled | reported | unknown
    if latest and latest.get("date_reported"):
        # Parse m/d/yyyy
        reported_d = None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
            try:
                reported_d = datetime.strptime(str(latest["date_reported"]).strip(), fmt).date()
                break
            except Exception:
                continue
        today = date.today()
        if reported_d is not None:
            age = (today - reported_d).days
            # Fresh result if reported in last 14 days, or matches upcoming date
            match_upcoming = bool(
                upcoming and upcoming.get("date")
                and reported_d.isoformat() == str(upcoming.get("date"))[:10]
            )
            if age <= 14 or match_upcoming:
                result = latest
                status = "reported"
    if upcoming and status != "reported":
        # Still waiting — show estimate from calendar if present
        status = "scheduled" if (upcoming.get("days_until") or 0) >= 0 else "scheduled"
        if (upcoming.get("days_until") or 0) < 0 and result is None:
            # Past schedule but no matching surprise yet
            status = "pending_update"

    eps_est = None
    if result and result.get("eps_estimate") is not None:
        eps_est = result["eps_estimate"]
    elif upcoming:
        eps_est = _parse_money_num(upcoming.get("eps_forecast"))

    beat = (result or {}).get("beat")
    surprise_pct = (result or {}).get("surprise_pct")

    return {
        "ok": True,
        "ticker": sym,
        "status": status,  # scheduled | reported | pending_update
        "event": {
            "date": (upcoming or {}).get("date") or (result or {}).get("date_reported"),
            "days_until": (upcoming or {}).get("days_until"),
            "session": session,
            "time": (upcoming or {}).get("time") or "",
            "fiscal_quarter": (
                (upcoming or {}).get("fiscal_quarter")
                or (result or {}).get("fiscal_quarter")
                or ""
            ),
            "name": (upcoming or {}).get("name") or "",
        } if (upcoming or result) else None,
        "result": {
            "eps_actual": (result or {}).get("eps_actual"),
            "eps_estimate": eps_est,
            "surprise_pct": surprise_pct,
            "beat": beat,  # beat | miss | inline | null
            "date_reported": (result or {}).get("date_reported"),
            "fiscal_quarter": (result or {}).get("fiscal_quarter"),
        } if (result or eps_est is not None) else None,
        "history": history[:8],
        "source": "nasdaq",
        "cost": "free · no LLM",
    }
