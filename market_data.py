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
                      start: str = None, end: str = None) -> list:
    """Daily bars. Tradier (only if a paid token is configured) → free Yahoo v8
    chart → yfinance library fallback. [{date, ...close}] chronological."""
    rows = None
    if tradier_available():
        rows = tradier_history(symbol, interval=interval, start=start, end=end)
    if not rows:
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
