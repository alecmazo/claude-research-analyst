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
def _daily_closes_from_chart(res0: dict) -> list[float]:
    """Non-null daily closes from a v8 chart result, oldest → newest."""
    closes = ((res0.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    out = []
    for c in closes:
        try:
            if c is not None and float(c) == float(c):
                out.append(float(c))
        except (TypeError, ValueError):
            continue
    return out


def _yahoo_chart_quote(symbol: str) -> dict | None:
    """One symbol via Yahoo v8 chart — live price + true prior-session close.

    Yahoo's chart meta often omits previousClose / regularMarketChangePercent
    (2026+). chartPreviousClose is NOT the prior session — it is the close at
    the start of the chart window and inflates day % (e.g. C −4% vs real +0.3%).
    When meta previousClose is missing we use the second-to-last daily bar.
    """
    import requests
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    for host in ("query1", "query2"):
        try:
            r = requests.get(
                f"https://{host}.finance.yahoo.com/v8/finance/chart/{sym}",
                params={"range": "10d", "interval": "1d", "includePrePost": "false"},
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0 DGACapital/1.0"},
            )
            if r.status_code != 200:
                continue
            res0 = (((r.json().get("chart") or {}).get("result")) or [None])[0]
            if not res0:
                continue
            meta = res0.get("meta") or {}
            closes = _daily_closes_from_chart(res0)
            # Live last trade / session price
            px = _f(meta.get("regularMarketPrice")
                    or meta.get("postMarketPrice")
                    or meta.get("preMarketPrice"))
            if px is None and closes:
                px = closes[-1]
            # Official prior-session close only — never chartPreviousClose.
            prev = _f(meta.get("previousClose")
                      or meta.get("regularMarketPreviousClose"))
            if prev is None and len(closes) >= 2:
                prev = closes[-2]
            if px is None:
                continue
            # Prefer Yahoo's own day % when present (authoritative)
            pct = _f(meta.get("regularMarketChangePercent"))
            if pct is None and prev not in (None, 0):
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


def _parse_reported_date(s) -> "object | None":
    """Parse m/d/yyyy or ISO earnings date → date or None."""
    from datetime import datetime
    if s is None:
        return None
    raw = str(s).strip()
    if not raw:
        return None
    # ISO with time
    if "T" in raw or len(raw) >= 10 and raw[4] == "-":
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")[:19]).date()
        except Exception:
            pass
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw[:10] if fmt.startswith("%Y-%m") else raw, fmt).date()
        except Exception:
            continue
    return None


def _beat_from_eps(actual, est) -> str | None:
    if actual is None or est is None:
        return None
    try:
        a, e = float(actual), float(est)
    except (TypeError, ValueError):
        return None
    if a > e:
        return "beat"
    if a < e:
        return "miss"
    return "inline"


def nasdaq_earnings_surprise(symbol: str) -> dict:
    """Historical EPS actual vs consensus from Nasdaq (free).

    Returns {history: [...], latest: {...}|None, source: str} — never raises.
    Nasdaq often lags same-day prints by hours/days; pair with yfinance fallback.
    """
    import time as _time
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"history": [], "latest": None, "source": "nasdaq"}
    hit = _EARNINGS_DETAIL_CACHE.get(("nasdaq", sym))
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
                history.append({
                    "fiscal_quarter": row.get("fiscalQtrEnd") or "",
                    "date_reported": row.get("dateReported") or "",
                    "eps_actual": actual,
                    "eps_estimate": est,
                    "surprise_pct": surprise_pct,
                    "beat": _beat_from_eps(actual, est),
                    "source": "nasdaq",
                })
        else:
            print(f"[market_data] nasdaq surprise {sym} HTTP {r.status_code}", flush=True)
    except Exception as e:
        print(f"[market_data] nasdaq surprise {sym} failed: {e!s:.120}", flush=True)
    out = {
        "history": history,
        "latest": history[0] if history else None,
        "source": "nasdaq",
    }
    _EARNINGS_DETAIL_CACHE[("nasdaq", sym)] = (_time.time(), out)
    return out


def yfinance_earnings_surprise(symbol: str) -> dict:
    """Same-shape surprise history via yfinance get_earnings_dates (free).

    Nasdaq surprise table often lags BMO prints until late day / next day;
    yfinance usually has Reported EPS within minutes of the release.
    """
    import time as _time
    from datetime import datetime
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"history": [], "latest": None, "source": "yfinance"}
    hit = _EARNINGS_DETAIL_CACHE.get(("yf", sym))
    # Short TTL — same-day results appear during the session
    if hit and _time.time() - hit[0] < 600:
        return hit[1]
    history: list[dict] = []
    try:
        import yfinance as yf
        t = yf.Ticker(sym)
        df = None
        try:
            df = t.get_earnings_dates(limit=12)
        except Exception:
            df = getattr(t, "earnings_dates", None)
        if df is not None and len(df) > 0:
            # Columns: EPS Estimate, Reported EPS, Surprise(%)
            for idx, row in df.iterrows():
                try:
                    actual = row.get("Reported EPS")
                    est = row.get("EPS Estimate")
                    surp = row.get("Surprise(%)")
                except Exception:
                    actual = est = surp = None
                try:
                    if actual is not None and actual == actual:  # not NaN
                        actual = float(actual)
                    else:
                        actual = None
                except Exception:
                    actual = None
                try:
                    if est is not None and est == est:
                        est = float(est)
                    else:
                        est = None
                except Exception:
                    est = None
                try:
                    if surp is not None and surp == surp:
                        surp = float(surp)
                    else:
                        surp = None
                except Exception:
                    surp = None
                # Skip pure future rows with no actual
                if actual is None and est is None:
                    continue
                # Date from index
                d_iso = ""
                try:
                    if hasattr(idx, "date"):
                        d_iso = idx.date().isoformat()
                    else:
                        d_iso = str(idx)[:10]
                except Exception:
                    d_iso = str(idx)[:10]
                # yfinance Surprise(%) is already percent points (e.g. 9.93)
                history.append({
                    "fiscal_quarter": "",
                    "date_reported": d_iso,
                    "eps_actual": actual,
                    "eps_estimate": est,
                    "surprise_pct": round(surp, 2) if surp is not None else (
                        round((actual - est) / abs(est) * 100, 2)
                        if actual is not None and est not in (None, 0) else None
                    ),
                    "beat": _beat_from_eps(actual, est) if actual is not None else None,
                    "source": "yfinance",
                })
    except Exception as e:
        print(f"[market_data] yfinance earnings {sym} failed: {e!s:.120}", flush=True)
    out = {
        "history": history,
        "latest": next((h for h in history if h.get("eps_actual") is not None),
                       history[0] if history else None),
        "source": "yfinance",
    }
    _EARNINGS_DETAIL_CACHE[("yf", sym)] = (_time.time(), out)
    return out


def _earnings_report_window_passed(event_date_iso: str, session: str) -> bool:
    """True if the expected print window for this event is already over (ET).

    BMO → after 09:30 America/New_York on event day.
    AMC → after 16:00 ET on event day.
    Unknown → after 12:00 ET on event day.
    Past calendar days → always True.
    """
    from datetime import date, datetime, time as dtime
    try:
        from zoneinfo import ZoneInfo
        et = ZoneInfo("America/New_York")
    except Exception:
        et = None
    try:
        ev = date.fromisoformat(str(event_date_iso)[:10])
    except Exception:
        return False
    now = datetime.now(et) if et else datetime.utcnow()
    today = now.date()
    if ev < today:
        return True
    if ev > today:
        return False
    sess = (session or "").upper()
    if sess == "BMO":
        cutoff = dtime(9, 30)
    elif sess == "AMC":
        cutoff = dtime(16, 0)
    else:
        cutoff = dtime(12, 0)
    return now.timetz().replace(tzinfo=None) >= cutoff if hasattr(now, "timetz") else now.time() >= cutoff


def earnings_card(symbol: str, horizon_days: int = 5,
                  include_past_days: int = 1) -> dict:
    """Full earnings card payload for watchlist chip click.

    Combines calendar event + surprise history + beat/miss.
    Free sources: Nasdaq calendar/surprise, yfinance earnings_dates fallback
    when Nasdaq lags same-day BMO/AMC prints. No LLM.
    """
    from datetime import date, datetime, timedelta
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "invalid ticker"}

    upcoming = earnings_upcoming([sym], horizon_days=horizon_days,
                                 include_past_days=include_past_days).get(sym)
    surprise = nasdaq_earnings_surprise(sym)
    history = list(surprise.get("history") or [])
    latest = surprise.get("latest")
    result_source = "nasdaq"

    # Session label from calendar
    session = ""
    if upcoming:
        tlabel = (upcoming.get("time") or "").lower()
        if "pre" in tlabel:
            session = "BMO"
        elif "after" in tlabel or "post" in tlabel:
            session = "AMC"

    def _match_event(row: dict) -> bool:
        if not row:
            return False
        reported_d = _parse_reported_date(row.get("date_reported"))
        if reported_d is None:
            return False
        today = date.today()
        age = (today - reported_d).days
        if age < 0 or age > 14:
            return False
        if upcoming and upcoming.get("date"):
            try:
                ev = date.fromisoformat(str(upcoming["date"])[:10])
                # Same day or within 2 calendar days (Yahoo often stamps
                # BMO prints the evening before ET).
                if abs((reported_d - ev).days) <= 2:
                    return True
            except Exception:
                pass
        return age <= 3 and row.get("eps_actual") is not None

    # Determine if latest surprise is "this" event (reported within window)
    result = None
    status = "scheduled"  # scheduled | reported | pending_update | unknown
    if latest and _match_event(latest):
        result = latest
        status = "reported" if latest.get("eps_actual") is not None else "pending_update"
        result_source = latest.get("source") or "nasdaq"

    # Nasdaq lag: yfinance often has Reported EPS same morning for BMO
    if status != "reported" or (result and result.get("eps_actual") is None):
        yf_s = yfinance_earnings_surprise(sym)
        yf_latest = yf_s.get("latest")
        if yf_latest and yf_latest.get("eps_actual") is not None and _match_event(yf_latest):
            result = dict(yf_latest)
            status = "reported"
            result_source = "yfinance"
            # Prefer Nasdaq calendar consensus for beat/miss when available
            # (Street estimate users expect); keep yfinance actual.
            cal_est = _parse_money_num((upcoming or {}).get("eps_forecast"))
            if cal_est is not None:
                result["eps_estimate"] = cal_est
                result["beat"] = _beat_from_eps(result.get("eps_actual"), cal_est)
                try:
                    a = float(result["eps_actual"])
                    result["surprise_pct"] = round(
                        (a - float(cal_est)) / abs(float(cal_est)) * 100.0, 2)
                except Exception:
                    pass
                result_source = "yfinance+nasdaq"
            if not any(
                h.get("date_reported") == yf_latest.get("date_reported")
                and h.get("eps_actual") == yf_latest.get("eps_actual")
                for h in history
            ):
                history = [result] + history

    # After the expected print window, never keep saying "scheduled / AWAITING"
    if upcoming and status != "reported":
        du = upcoming.get("days_until")
        try:
            du_i = int(du) if du is not None else 0
        except (TypeError, ValueError):
            du_i = 0
        past_window = du_i < 0 or (
            du_i == 0 and _earnings_report_window_passed(
                str(upcoming.get("date") or ""), session)
        )
        if past_window:
            status = "pending_update"
        else:
            status = "scheduled"

    eps_est = None
    if result and result.get("eps_estimate") is not None:
        eps_est = result["eps_estimate"]
    elif upcoming:
        eps_est = _parse_money_num(upcoming.get("eps_forecast"))

    beat = (result or {}).get("beat")
    surprise_pct = (result or {}).get("surprise_pct")
    if (beat is None and result and result.get("eps_actual") is not None
            and eps_est is not None):
        beat = _beat_from_eps(result.get("eps_actual"), eps_est)
    if (surprise_pct is None and result and result.get("eps_actual") is not None
            and eps_est not in (None, 0)):
        try:
            surprise_pct = round(
                (float(result["eps_actual"]) - float(eps_est))
                / abs(float(eps_est)) * 100.0, 2)
        except Exception:
            pass

    # Street range / revenue consensus from Yahoo calendar (free, no LLM)
    street_range: dict = {}
    try:
        street_range = yfinance_earnings_calendar_context(sym) or {}
    except Exception as e:
        print(f"[market_data] calendar context {sym}: {e!s:.100}", flush=True)

    # Actual quarterly revenue (+ EPS fallback) from Yahoo income stmt (free).
    # CRITICAL: never treat a prior filed quarter's statement as "this" print
    # when the calendar event is still in the future (TSLA ticket 68525f84 —
    # card showed $0.13 actual for a Jun/2026 print still days away).
    actuals: dict = {}
    event_still_future = False
    if upcoming:
        try:
            du_chk = int(upcoming.get("days_until")) if upcoming.get("days_until") is not None else None
        except (TypeError, ValueError):
            du_chk = None
        if du_chk is not None and du_chk > 0:
            event_still_future = True
        elif du_chk == 0 and not _earnings_report_window_passed(
                str(upcoming.get("date") or ""), session):
            event_still_future = True

    try:
        fq_hint = (
            (upcoming or {}).get("fiscal_quarter")
            or (result or {}).get("fiscal_quarter")
            or ""
        )
        # Only pull statement actuals when print window is open/past —
        # never for pure future events.
        if not event_still_future:
            actuals = yfinance_quarterly_actuals(sym, fiscal_quarter_hint=fq_hint) or {}
            if actuals and fq_hint and not _fiscal_quarter_labels_match(
                    fq_hint, actuals.get("period_label") or ""):
                actuals = {}
    except Exception as e:
        print(f"[market_data] quarterly actuals {sym}: {e!s:.100}", flush=True)

    # Future print: never show actuals / beat / miss for this event
    if event_still_future:
        result = None
        status = "scheduled"
        beat = None
        surprise_pct = None
        eps_actual_final = None
        rev_actual = None
    else:
        eps_actual_final = (result or {}).get("eps_actual")
        # Statement fill-in only after a real report match or post-window pending
        if (eps_actual_final is None and actuals.get("eps_actual") is not None
                and status in ("reported", "pending_update")):
            eps_actual_final = actuals.get("eps_actual")
            if status == "pending_update":
                status = "reported"
                result_source = (
                    (result_source or "") + "+yf_stmt" if result_source else "yf_stmt"
                )
        rev_actual = actuals.get("revenue_actual")
    rev_estimate = street_range.get("revenue_avg")
    rev_surprise_pct = None
    rev_beat = None
    if rev_actual is not None and rev_estimate not in (None, 0):
        try:
            ra, re_ = float(rev_actual), float(rev_estimate)
            rev_surprise_pct = round((ra - re_) / abs(re_) * 100.0, 2)
            rev_beat = _beat_from_eps(ra, re_)  # same > / < / = logic
        except Exception:
            pass

    # Recompute EPS beat if we filled actual from statement
    if beat is None and eps_actual_final is not None and eps_est is not None:
        beat = _beat_from_eps(eps_actual_final, eps_est)
    if surprise_pct is None and eps_actual_final is not None and eps_est not in (None, 0):
        try:
            surprise_pct = round(
                (float(eps_actual_final) - float(eps_est))
                / abs(float(eps_est)) * 100.0, 2)
        except Exception:
            pass

    notes = build_earnings_notes(
        symbol=sym,
        status=status,
        beat=beat,
        surprise_pct=surprise_pct,
        eps_actual=eps_actual_final,
        eps_estimate=eps_est,
        history=history,
        event={
            "date": (upcoming or {}).get("date") or (result or {}).get("date_reported"),
            "fiscal_quarter": (
                (upcoming or {}).get("fiscal_quarter")
                or (result or {}).get("fiscal_quarter") or ""
            ),
            "session": session,
            "name": (upcoming or {}).get("name") or "",
        },
        street=street_range,
        revenue_actual=rev_actual,
        revenue_estimate=rev_estimate,
        revenue_surprise_pct=rev_surprise_pct,
        revenue_beat=rev_beat,
    )

    return {
        "ok": True,
        "ticker": sym,
        "status": status,  # scheduled | reported | pending_update
        "source": result_source if status == "reported" else "nasdaq",
        "event": {
            "date": (upcoming or {}).get("date") or (result or {}).get("date_reported"),
            "days_until": (upcoming or {}).get("days_until"),
            "session": session,
            "time": (upcoming or {}).get("time") or "",
            "fiscal_quarter": (
                (upcoming or {}).get("fiscal_quarter")
                or (result or {}).get("fiscal_quarter")
                or actuals.get("period_label")
                or ""
            ),
            "name": (upcoming or {}).get("name") or "",
        } if (upcoming or result or actuals) else None,
        "result": {
            "eps_actual": eps_actual_final,
            "eps_estimate": eps_est,
            "surprise_pct": surprise_pct,
            "beat": beat,  # beat | miss | inline | null
            "date_reported": (result or {}).get("date_reported"),
            "fiscal_quarter": (result or {}).get("fiscal_quarter") or actuals.get("period_label"),
            "eps_high": street_range.get("eps_high"),
            "eps_low": street_range.get("eps_low"),
            "eps_avg": street_range.get("eps_avg"),
            # Revenue: actual (Yahoo quarterly stmt) next to consensus (calendar)
            "revenue_actual": rev_actual,
            "revenue_estimate": rev_estimate,
            "revenue_high": street_range.get("revenue_high"),
            "revenue_low": street_range.get("revenue_low"),
            "revenue_surprise_pct": rev_surprise_pct,
            "revenue_beat": rev_beat,
            "period_end": actuals.get("period_end"),
        } if (result or eps_est is not None or street_range or actuals) else None,
        "history": history[:8],
        "notes": notes,
        "cost": "free · no LLM",
    }


def _fiscal_quarter_labels_match(hint: str, label: str) -> bool:
    """True if calendar fiscal hint (e.g. 'Jun/2026') matches a period label ('Jun 2026')."""
    import re
    h = (hint or "").replace("/", " ").strip().lower()
    lab = (label or "").replace("/", " ").strip().lower()
    if not h or not lab:
        return False
    # Extract month token + 4-digit year from both
    months = ("jan", "feb", "mar", "apr", "may", "jun",
              "jul", "aug", "sep", "oct", "nov", "dec")
    def _parts(s: str):
        m = next((x for x in months if x in s), None)
        ys = re.findall(r"20\d{2}", s)
        y = ys[-1] if ys else None
        return m, y
    hm, hy = _parts(h)
    lm, ly = _parts(lab)
    if hy and ly and hy != ly:
        return False
    if hm and lm and hm != lm:
        return False
    # If both have month+year and they match
    if hm and hy and lm and ly:
        return hm == lm and hy == ly
    # Fallback: year match + month substring
    if hy and hy in lab and (not hm or hm in lab):
        return True
    return False


def yfinance_quarterly_actuals(symbol: str, fiscal_quarter_hint: str = "") -> dict:
    """Actual diluted EPS + total revenue from Yahoo quarterly income statement.

    Free, no LLM. Matches fiscal_quarter_hint (e.g. 'Jun 2026' / 'Jun/2026')
    when possible. If a hint is given and no column matches that quarter,
    returns {} — never a different quarter's actuals (avoids pre-print false MISS).
    Without a hint, returns the most recent quarter with non-null EPS or revenue.
    """
    import time as _time
    from datetime import datetime
    sym = (symbol or "").strip().upper()
    if not sym:
        return {}
    hit = _EARNINGS_DETAIL_CACHE.get(("yf_qact", sym, fiscal_quarter_hint or ""))
    if hit and _time.time() - hit[0] < 900:
        return hit[1]
    out: dict = {}
    try:
        import yfinance as yf
        import math
        t = yf.Ticker(sym)
        df = getattr(t, "quarterly_income_stmt", None)
        if df is None or getattr(df, "empty", True):
            _EARNINGS_DETAIL_CACHE[("yf_qact", sym, fiscal_quarter_hint or "")] = (_time.time(), {})
            return {}

        def _num(v):
            try:
                if v is None:
                    return None
                f = float(v)
                if math.isnan(f) or math.isinf(f):
                    return None
                return f
            except Exception:
                return None

        def _label(col) -> str:
            try:
                if hasattr(col, "to_pydatetime"):
                    d = col.to_pydatetime()
                elif hasattr(col, "month"):
                    d = col
                else:
                    d = datetime.fromisoformat(str(col)[:10])
                return d.strftime("%b %Y")  # e.g. Jun 2026
            except Exception:
                return str(col)[:12]

        def _iso(col) -> str:
            try:
                if hasattr(col, "date"):
                    return col.date().isoformat()
                return str(col)[:10]
            except Exception:
                return ""

        hint = (fiscal_quarter_hint or "").replace("/", " ").strip()
        cols = list(df.columns)
        require_match = bool(hint)

        for col in cols:
            lab = _label(col)
            if require_match and not _fiscal_quarter_labels_match(hint, lab):
                continue
            rev = None
            eps = None
            for rev_key in ("Total Revenue", "Operating Revenue", "TotalRevenue", "Revenue"):
                if rev_key in df.index:
                    rev = _num(df.loc[rev_key, col])
                    if rev is not None:
                        break
            for eps_key in ("Diluted EPS", "Basic EPS", "DilutedEPS", "BasicEPS"):
                if eps_key in df.index:
                    eps = _num(df.loc[eps_key, col])
                    if eps is not None:
                        break
            if rev is None and eps is None:
                continue
            out = {
                "period_end": _iso(col),
                "period_label": lab,
                "revenue_actual": rev,
                "eps_actual": eps,
                "source": "yfinance_quarterly_income",
                "matched_hint": require_match,
            }
            break
        # No matching quarter for a strict hint → empty (do not fall back)
        if require_match and not out:
            out = {}
    except Exception as e:
        print(f"[market_data] yf quarterly actuals {sym}: {e!s:.120}", flush=True)
        out = {}
    _EARNINGS_DETAIL_CACHE[("yf_qact", sym, fiscal_quarter_hint or "")] = (_time.time(), out)
    return out


def yfinance_earnings_calendar_context(symbol: str) -> dict:
    """Street range (EPS high/low/avg + revenue band) from yfinance calendar."""
    import time as _time
    sym = (symbol or "").strip().upper()
    if not sym:
        return {}
    hit = _EARNINGS_DETAIL_CACHE.get(("yf_cal", sym))
    if hit and _time.time() - hit[0] < 1800:
        return hit[1]
    out: dict = {}
    try:
        import yfinance as yf
        cal = getattr(yf.Ticker(sym), "calendar", None) or {}
        if isinstance(cal, dict):
            for src, dst in (
                ("Earnings High", "eps_high"),
                ("Earnings Low", "eps_low"),
                ("Earnings Average", "eps_avg"),
                ("Revenue High", "revenue_high"),
                ("Revenue Low", "revenue_low"),
                ("Revenue Average", "revenue_avg"),
            ):
                v = cal.get(src)
                if v is None:
                    continue
                try:
                    out[dst] = float(v)
                except (TypeError, ValueError):
                    pass
            # Next earnings date list if present
            ed = cal.get("Earnings Date")
            if isinstance(ed, (list, tuple)) and ed:
                try:
                    d0 = ed[0]
                    out["next_earnings_date"] = (
                        d0.isoformat() if hasattr(d0, "isoformat") else str(d0)[:10]
                    )
                except Exception:
                    pass
    except Exception as e:
        print(f"[market_data] yf calendar {sym}: {e!s:.100}", flush=True)
    _EARNINGS_DETAIL_CACHE[("yf_cal", sym)] = (_time.time(), out)
    return out


def yahoo_earnings_headlines(symbol: str, limit: int = 4) -> list[dict]:
    """Recent free Yahoo headlines mentioning earnings / print (no LLM)."""
    import time as _time
    import re as _re
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    hit = _EARNINGS_DETAIL_CACHE.get(("yf_news", sym))
    if hit and _time.time() - hit[0] < 900:
        return hit[1]
    out: list[dict] = []
    keys = _re.compile(
        r"earn|eps|quarter|guidance|outlook|beat|miss|forecast|results|print|revenue|profit",
        _re.I,
    )
    try:
        import yfinance as yf
        news = getattr(yf.Ticker(sym), "news", None) or []
        for item in news:
            c = item.get("content") if isinstance(item, dict) else None
            if not isinstance(c, dict):
                c = item if isinstance(item, dict) else {}
            title = (c.get("title") or item.get("title") or "").strip()
            if not title or not keys.search(title):
                continue
            pub = ""
            try:
                pub = (
                    (c.get("provider") or {}).get("displayName")
                    or item.get("publisher")
                    or ""
                )
            except Exception:
                pub = item.get("publisher") or ""
            url = ""
            try:
                url = (
                    (c.get("canonicalUrl") or {}).get("url")
                    or (c.get("clickThroughUrl") or {}).get("url")
                    or item.get("link")
                    or ""
                )
            except Exception:
                url = item.get("link") or ""
            out.append({"title": title[:180], "publisher": str(pub)[:60], "url": url})
            if len(out) >= limit:
                break
    except Exception as e:
        print(f"[market_data] yf news {sym}: {e!s:.100}", flush=True)
    _EARNINGS_DETAIL_CACHE[("yf_news", sym)] = (_time.time(), out)
    return out


def build_earnings_notes(
    *,
    symbol: str,
    status: str,
    beat: str | None,
    surprise_pct,
    eps_actual,
    eps_estimate,
    history: list | None,
    event: dict | None,
    street: dict | None,
    revenue_actual=None,
    revenue_estimate=None,
    revenue_surprise_pct=None,
    revenue_beat: str | None = None,
) -> dict:
    """Structured free commentary for the earnings card empty space (no LLM)."""
    bullets: list[str] = []
    vs = ""
    tone = "neutral"
    fq = (event or {}).get("fiscal_quarter") or ""
    name = (event or {}).get("name") or symbol

    def _fmt_eps(v):
        try:
            return f"${float(v):.2f}"
        except Exception:
            return "—"

    def _fmt_rev(v):
        try:
            n = float(v)
            if abs(n) >= 1e9:
                return f"${n/1e9:.2f}B"
            if abs(n) >= 1e6:
                return f"${n/1e6:.1f}M"
            return f"${n:,.0f}"
        except Exception:
            return "—"

    if status == "reported" and eps_actual is not None:
        sp = None
        try:
            sp = float(surprise_pct) if surprise_pct is not None else None
        except Exception:
            sp = None
        if beat == "beat":
            tone = "beat"
            vs = f"Beat Street" + (f" by {sp:+.1f}%" if sp is not None else "")
            bullets.append(
                f"EPS {_fmt_eps(eps_actual)} vs {_fmt_eps(eps_estimate)} consensus"
                + (f" · beat {sp:+.1f}%" if sp is not None else " · beat")
                + (f" · {fq}" if fq else "")
            )
        elif beat == "miss":
            tone = "miss"
            vs = f"Missed Street" + (f" by {sp:.1f}%" if sp is not None else "")
            bullets.append(
                f"EPS {_fmt_eps(eps_actual)} vs {_fmt_eps(eps_estimate)} consensus"
                + (f" · miss {sp:.1f}%" if sp is not None else " · miss")
                + (f" · {fq}" if fq else "")
            )
        elif beat == "inline":
            tone = "inline"
            vs = "In line with Street"
            bullets.append(
                f"EPS {_fmt_eps(eps_actual)} matched {_fmt_eps(eps_estimate)} consensus"
                + (f" · {fq}" if fq else "")
            )
        else:
            bullets.append(
                f"EPS {_fmt_eps(eps_actual)}"
                + (f" vs {_fmt_eps(eps_estimate)} est" if eps_estimate is not None else "")
                + (f" · {fq}" if fq else "")
            )
    elif status == "pending_update":
        tone = "pending"
        vs = "Print window passed · results lagging free feeds"
        if eps_estimate is not None:
            bullets.append(f"Street was at {_fmt_eps(eps_estimate)} EPS — actual not in free sources yet")
        else:
            bullets.append("Awaiting free EPS actual (Yahoo/Nasdaq often lag BMO/AMC by hours)")
    else:
        if eps_estimate is not None:
            bullets.append(
                f"Consensus EPS {_fmt_eps(eps_estimate)}"
                + (f" · {fq}" if fq else "")
                + " — not yet reported"
            )
            vs = "Awaiting print"
        else:
            bullets.append("No Street EPS estimate in free calendar yet")

    st = street or {}
    if st.get("eps_low") is not None and st.get("eps_high") is not None:
        lo, hi = st["eps_low"], st["eps_high"]
        line = f"Street EPS range {_fmt_eps(lo)} – {_fmt_eps(hi)}"
        if eps_actual is not None:
            try:
                a = float(eps_actual)
                if a > float(hi):
                    line += " · print above high end of range"
                elif a < float(lo):
                    line += " · print below low end of range"
                else:
                    mid = (float(lo) + float(hi)) / 2.0
                    side = "upper half" if a >= mid else "lower half"
                    line += f" · print in {side} of range"
            except Exception:
                pass
        bullets.append(line)

    # Revenue actual vs consensus (when either side is known)
    if revenue_actual is not None or revenue_estimate is not None:
        if revenue_actual is not None and revenue_estimate is not None:
            rsp = revenue_surprise_pct
            tag = ""
            if revenue_beat == "beat":
                tag = " · beat" + (f" {rsp:+.1f}%" if rsp is not None else "")
            elif revenue_beat == "miss":
                tag = " · miss" + (f" {rsp:.1f}%" if rsp is not None else "")
            elif revenue_beat == "inline":
                tag = " · in line"
            bullets.append(
                f"Revenue {_fmt_rev(revenue_actual)} vs {_fmt_rev(revenue_estimate)} consensus{tag}"
            )
        elif revenue_actual is not None:
            bullets.append(f"Revenue actual {_fmt_rev(revenue_actual)}")
        else:
            rev_line = f"Street revenue ~{_fmt_rev(revenue_estimate)}"
            st = street or {}
            if st.get("revenue_low") is not None and st.get("revenue_high") is not None:
                rev_line += f" (band {_fmt_rev(st['revenue_low'])}–{_fmt_rev(st['revenue_high'])})"
            bullets.append(rev_line)
    elif (street or {}).get("revenue_avg") is not None:
        st = street or {}
        rev_line = f"Street revenue ~{_fmt_rev(st['revenue_avg'])}"
        if st.get("revenue_low") is not None and st.get("revenue_high") is not None:
            rev_line += f" (band {_fmt_rev(st['revenue_low'])}–{_fmt_rev(st['revenue_high'])})"
        bullets.append(rev_line)

    # Beat/miss streak from history
    hist = list(history or [])
    beats = [h for h in hist[:6] if h.get("beat") in ("beat", "miss", "inline")]
    if beats:
        n_beat = sum(1 for h in beats if h.get("beat") == "beat")
        n_miss = sum(1 for h in beats if h.get("beat") == "miss")
        n = len(beats)
        bullets.append(
            f"Last {n} quarters: {n_beat} beat · {n_miss} miss · {n - n_beat - n_miss} inline"
        )

    # Free headlines (earnings-related)
    headlines = yahoo_earnings_headlines(symbol, limit=3)
    for h in headlines[:3]:
        t = (h.get("title") or "").strip()
        if t:
            bullets.append(t)

    # Cap length for UI
    bullets = bullets[:7]
    return {
        "tone": tone,
        "vs_analysts": vs,
        "headline": (
            f"{name}: {vs}" if vs else f"{name} earnings"
        )[:140],
        "bullets": bullets,
        "headlines": headlines[:3],
        "source": "free · yahoo/nasdaq · no LLM",
    }
