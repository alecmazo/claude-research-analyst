"""
market_data.py — Server-grade market data with a Tradier primary + yfinance
fallback, returning NORMALIZED rows the rest of the app (and options_engine)
can consume regardless of source.

Why this exists
---------------
The app runs on a cloud IP that Yahoo rate-limits, so live yfinance scrapes are
slow / hang (the Builder freeze, slow Options sweeps) and yfinance's bid/ask is
delayed and thin on illiquid names. Tradier is a REST API built for servers (no
Yahoo-style IP blocking) and returns real bid/ask + greeks. We prefer Tradier
when a token is configured and fall back to yfinance otherwise, so nothing
breaks when the token is absent.

Config (env):
  TRADIER_TOKEN     — bearer token. Sandbox token works (delayed ~15m but
                      reliable + has greeks); a funded brokerage token is
                      real-time. If unset, everything falls back to yfinance.
  TRADIER_BASE_URL  — default https://api.tradier.com (use
                      https://sandbox.tradier.com for the sandbox token).

Normalized shapes
-----------------
quote:  {symbol, price, prev_close, pct_change, source}
option row: {strike, option_type('call'|'put'), bid, ask, last, iv, delta,
             open_interest, volume, source}
"""

from __future__ import annotations

import os


# ── Tradier transport ────────────────────────────────────────────────────────
def _tradier_cfg():
    token = (os.environ.get("TRADIER_TOKEN", "") or "").strip()
    base = (os.environ.get("TRADIER_BASE_URL", "https://api.tradier.com") or "").rstrip("/")
    return token, base


def tradier_available() -> bool:
    return bool(_tradier_cfg()[0])


def _tradier_get(path: str, params: dict):
    """GET a Tradier endpoint → parsed JSON, or None on any failure / no token."""
    token, base = _tradier_cfg()
    if not token:
        return None
    try:
        import requests
        r = requests.get(base + path, params=params, timeout=15,
                         headers={"Authorization": f"Bearer {token}",
                                  "Accept": "application/json"})
        if r.status_code != 200:
            print(f"[market_data] tradier {path} -> HTTP {r.status_code}", flush=True)
            return None
        return r.json()
    except Exception as e:
        print(f"[market_data] tradier {path} failed: {e!s:.120}", flush=True)
        return None


def _as_list(x):
    """Tradier returns a dict for 1 item, a list for many, None for none."""
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _f(v):
    try:
        v = float(v)
        return v if v == v else None      # NaN (v != v) → None
    except (TypeError, ValueError):
        return None


def _i(v):
    """Safe int: handles NaN/None (e.g. weekend volume/OI). int(NaN or 0) RAISES
    because NaN is truthy — that one error used to wipe an entire chain."""
    try:
        v = float(v)
        return int(v) if v == v else 0
    except (TypeError, ValueError):
        return 0


# ── Tradier: quotes ──────────────────────────────────────────────────────────
def tradier_quotes(symbols: list) -> dict | None:
    """{SYM: {price, prev_close, pct_change, source}} or None if unavailable."""
    if not symbols:
        return {}
    data = _tradier_get("/v1/markets/quotes",
                        {"symbols": ",".join(symbols), "greeks": "false"})
    if data is None:
        return None
    out = {}
    for it in _as_list((data.get("quotes") or {}).get("quote")):
        sym = (it.get("symbol") or "").upper()
        if not sym:
            continue
        out[sym] = {"price": _f(it.get("last")),
                    "prev_close": _f(it.get("prevclose")),
                    "pct_change": _f(it.get("change_percentage")),
                    "source": "tradier"}
    return out


# ── Tradier: option expirations + chains ─────────────────────────────────────
def tradier_expirations(symbol: str) -> list | None:
    data = _tradier_get("/v1/markets/options/expirations",
                        {"symbol": symbol, "includeAllRoots": "true"})
    if data is None:
        return None
    return [str(d) for d in _as_list((data.get("expirations") or {}).get("date"))]


def _norm_tradier_option(o: dict) -> dict:
    g = o.get("greeks") or {}
    return {
        "strike": _f(o.get("strike")),
        "option_type": o.get("option_type"),          # 'call' | 'put'
        "bid": _f(o.get("bid")) or 0.0,
        "ask": _f(o.get("ask")) or 0.0,
        "last": _f(o.get("last")),
        "iv": _f(g.get("mid_iv")) or _f(g.get("smv_vol")),
        "delta": _f(g.get("delta")),
        "open_interest": _i(o.get("open_interest")),
        "volume": _i(o.get("volume")),
        "source": "tradier",
    }


def tradier_chain(symbol: str, expiration: str) -> list | None:
    """Normalized option rows for one expiration (with greeks), or None."""
    data = _tradier_get("/v1/markets/options/chains",
                        {"symbol": symbol, "expiration": expiration, "greeks": "true"})
    if data is None:
        return None
    rows = [_norm_tradier_option(o)
            for o in _as_list((data.get("options") or {}).get("option"))]
    return [r for r in rows if r["strike"] is not None]


# ── yfinance fallback (normalized to the same shape) ─────────────────────────
def _yf_quotes(symbols: list) -> dict:
    out = {}
    try:
        import yfinance as yf
        data = yf.download(symbols, period="5d", auto_adjust=True,
                           progress=False, group_by="ticker")
        for sym in symbols:
            try:
                closes = (data["Close"].dropna() if len(symbols) == 1
                          else data[(sym, "Close")].dropna())
                if len(closes) >= 2:
                    price, prev = float(closes.iloc[-1]), float(closes.iloc[-2])
                    out[sym] = {"price": price, "prev_close": prev,
                                "pct_change": (price - prev) / prev * 100 if prev else None,
                                "source": "yfinance"}
            except Exception:
                continue
    except Exception as e:
        print(f"[market_data] yfinance quotes failed: {e!s:.120}", flush=True)
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
        "delta": None,                                 # yfinance has no greeks
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


# ── Unified public API (Tradier → yfinance) ──────────────────────────────────
def get_quotes(symbols: list) -> dict:
    """{SYM: quote}. Tradier first; yfinance fills any symbols Tradier missed."""
    symbols = [s.strip().upper() for s in symbols if s and s.strip()]
    if not symbols:
        return {}
    out = {}
    t = tradier_quotes(symbols)
    if t:
        out.update(t)
    missing = [s for s in symbols if s not in out or out[s].get("price") is None]
    if missing:
        out.update(_yf_quotes(missing))
    return out


def get_expirations(symbol: str) -> list:
    return tradier_expirations(symbol) or _yf_expirations(symbol) or []


def get_chain(symbol: str, expiration: str) -> list:
    """Normalized option rows for one expiration. Tradier first, yfinance fallback."""
    rows = tradier_chain(symbol, expiration)
    if rows is None:
        rows = _yf_chain(symbol, expiration)
    return rows or []


def source_label() -> str:
    return "tradier+yfinance" if tradier_available() else "yfinance"


# ── Tradier: historical price bars ───────────────────────────────────────────
def tradier_history(symbol: str, interval: str = "daily",
                    start: str = None, end: str = None) -> list | None:
    """Daily/weekly/monthly OHLC bars from Tradier.
    interval: 'daily' | 'weekly' | 'monthly'. start/end are 'YYYY-MM-DD'.
    Returns [{date, open, high, low, close, volume}] (chronological) or None."""
    params = {"symbol": symbol, "interval": interval}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    data = _tradier_get("/v1/markets/history", params)
    if data is None:
        return None
    days = _as_list((data.get("history") or {}).get("day"))
    out = []
    for d in days:
        c = _f(d.get("close"))
        if c is None:
            continue
        out.append({"date": d.get("date"), "open": _f(d.get("open")),
                    "high": _f(d.get("high")), "low": _f(d.get("low")),
                    "close": c, "volume": _i(d.get("volume"))})
    return out


def tradier_timesales(symbol: str, interval: str = "15min",
                      start: str = None, end: str = None) -> list | None:
    """Intraday bars from Tradier. interval: '1min'|'5min'|'15min'.
    start/end are 'YYYY-MM-DD HH:MM'. Returns [{time, close, volume}] or None."""
    params = {"symbol": symbol, "interval": interval, "session_filter": "open"}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    data = _tradier_get("/v1/markets/timesales", params)
    if data is None:
        return None
    pts = _as_list((data.get("series") or {}).get("data"))
    out = []
    for p in pts:
        c = _f(p.get("close")) or _f(p.get("price"))
        if c is None:
            continue
        out.append({"time": p.get("time"), "close": c,
                    "volume": _i(p.get("volume"))})
    return out


def _yf_history(symbol: str, period: str = "max",
                interval: str = "1d") -> list | None:
    """yfinance fallback for daily bars (used only when Tradier is unavailable).
    Returns [{date, close}] or None. Subject to the cloud-IP block — best effort."""
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
    """Daily bars. Tradier (only if a paid token is configured) → free Yahoo v8
    chart → yfinance library fallback. [{date, ...close}] chronological.

    adjusted=True prefers the Yahoo v8 chart (adjclose = SPLIT-ADJUSTED) over
    Tradier, whose bars are raw trade prices. Historical closes used for
    return math (e.g. the Jan-1 rewind in attribution) MUST be adjusted — a
    raw pre-split close doubles the apparent starting value (the BSX −$124K
    incident)."""
    rows = None
    if adjusted:
        rows = yahoo_history(symbol, rng=_yahoo_range_for(start))
    if not rows and tradier_available():
        rows = tradier_history(symbol, interval=interval, start=start, end=end)
    if not rows and not adjusted:
        rows = yahoo_history(symbol, rng=_yahoo_range_for(start))
    if not rows:
        rows = _yf_history(symbol)         # last-ditch: may be cloud-IP blocked
    return rows or []


def get_intraday(symbol: str) -> list:
    """5-day intraday closes (15-min). Tradier if available, else Yahoo v8 chart."""
    if tradier_available():
        from datetime import datetime as _dt2, timedelta as _td2
        t = tradier_timesales(symbol, interval="15min",
                              start=(_dt2.now() - _td2(days=6)).strftime("%Y-%m-%d %H:%M"))
        if t:
            return [{"time": x["time"], "close": x["close"]} for x in t]
    return yahoo_intraday(symbol) or []


def yahoo_market_movers(min_price: float = 3.0, min_market_cap: float = 2e9,
                        per_list: int = 30) -> list:
    """Biggest BROAD-MARKET movers from Yahoo's free predefined screeners
    (day_gainers + day_losers + most_actives) — the day's real movers market-wide,
    not just a given universe. No API key; same cloud-tolerant Yahoo host family
    as the price-chart endpoint. Returns [{ticker, price, pct_change, name,
    market_cap}], deduped to the largest move. Filters out penny stocks
    (< min_price) and micro/small caps (known marketCap < min_market_cap, default
    $2B) so speculative names don't clutter the list."""
    import requests
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
                    if sym not in out or abs(pct) > abs(out[sym]["pct_change"]):
                        out[sym] = {"ticker": sym, "price": px,
                                    "pct_change": round(pct, 4),
                                    "market_cap": mc,
                                    "name": q.get("shortName") or q.get("longName") or ""}
                got = True
                break
            except Exception as e:
                print(f"[market_data] yahoo movers {scr} {host} failed: {e!s:.120}", flush=True)
        if not got:
            print(f"[market_data] yahoo movers {scr}: no data", flush=True)
    return list(out.values())


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
            timeout=12,
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
    best: dict[str, dict] = {}
    d = start
    while d <= end:
        for row in nasdaq_earnings_for_day(d.isoformat()):
            sym = row["symbol"]
            if want is not None and sym not in want:
                continue
            days_until = (d - today).days
            rec = {
                **row,
                "days_until": days_until,
                "imminent": -include_past_days <= days_until <= horizon_days,
            }
            prev = best.get(sym)
            # Prefer the soonest upcoming event; if only past, keep closest past
            if prev is None:
                best[sym] = rec
            else:
                # Prefer non-negative (upcoming/today) over past; then nearer
                def _rank(r):
                    du = r["days_until"]
                    return (0 if du >= 0 else 1, abs(du))
                if _rank(rec) < _rank(prev):
                    best[sym] = rec
        d += timedelta(days=1)
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
