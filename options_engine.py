"""
options_engine.py — Deterministic options-analysis core for the DGA wheel scanner.

This module does the EXACT math; the LLM does the judgment. It fetches option
chains (free, via yfinance — the same dependency `batch_quotes` already uses),
computes Black-Scholes delta (yfinance does not provide greeks), and ranks
covered-call and cash-secured-put candidates across a list of tickers.

Design notes
------------
* No new dependencies: stdlib `math` for Black-Scholes (math.erf for the normal
  CDF), pandas for chain handling (already pulled in by yfinance).
* Assignment probability is proxied by |delta| — the standard trader heuristic
  (a 0.30-delta short option finishes in-the-money roughly 30% of the time).
* "Vol richness" = ATM implied vol / trailing realized (historical) vol. True
  IV-rank needs an accumulated IV history (the future `options_snapshots`
  table); until that fills, IV/HV is an honest day-one richness signal:
  >1.0 means the option is pricing MORE movement than the stock has recently
  realized, i.e. premium is relatively rich and worth selling.

Public entry points
-------------------
    scan_wheel(tickers, delta_max=..., side="both", ...) -> dict
    scan_ticker(ticker, delta_max=..., side="both", ...) -> dict
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import market_data as _market   # Tradier primary + yfinance fallback (normalized rows)

# ── Tunable defaults ─────────────────────────────────────────────────────────
DEFAULT_RISK_FREE = 0.043       # ~13-week T-bill; override per call if desired
DEFAULT_DELTA_MAX = 0.30        # assignment-probability cap (per-scan overridable)
MIN_DTE = 5                     # ignore <5 calendar days (gamma/pin risk, noise)
MAX_DTE = 90                    # ignore far-dated; this is a short-vol harvester
MIN_OPEN_INTEREST = 25          # liquidity floor — skip untradeable strikes
MIN_DELTA = 0.05                # floor: a ~0-delta strike pays no real premium
MAX_PCT_OTM = 0.40              # band: reject far-OTM junk/stale/adjusted strikes
_TRADING_DAYS = 252

# Tenor buckets (contiguous, in calendar days-to-expiry). We surface the single
# best trade in EACH bucket so the user can compare a weekly vs. a monthly vs. a
# quarterly — rather than always defaulting to the shortest expiry (which any
# annualized-yield ranking would otherwise favor). One representative (nearest)
# expiration per bucket is scanned, which bounds the yfinance calls to ≤3/ticker.
TENOR_BUCKETS = [("weekly", MIN_DTE, 14), ("monthly", 15, 45), ("quarterly", 46, MAX_DTE)]


# ── Black-Scholes greeks ─────────────────────────────────────────────────────
def _norm_cdf(x: float) -> float:
    """Standard normal CDF via the error function (no scipy needed)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_delta(S: float, K: float, T: float, sigma: float, r: float,
             kind: str) -> float | None:
    """Black-Scholes delta. `kind` is 'call' or 'put'. Returns None if inputs
    are degenerate (zero time, zero vol). Put delta is returned negative."""
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return None
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    if kind == "call":
        return _norm_cdf(d1)
    return _norm_cdf(d1) - 1.0


# ── Realized (historical) volatility ─────────────────────────────────────────
def realized_vol(closes) -> float | None:
    """Annualized close-to-close realized vol from a price series (pandas/list)."""
    try:
        vals = [float(c) for c in list(closes) if c == c and c is not None and c > 0]
    except Exception:
        return None
    if len(vals) < 20:
        return None
    rets = [math.log(vals[i] / vals[i - 1]) for i in range(1, len(vals))]
    n = len(rets)
    mean = sum(rets) / n
    var = sum((x - mean) ** 2 for x in rets) / (n - 1)
    return math.sqrt(var) * math.sqrt(_TRADING_DAYS)


# ── Data fetch (yfinance) ────────────────────────────────────────────────────
def _fetch(ticker: str):
    """Return (yf.Ticker, spot_price, realized_vol, [expirations]) or raises."""
    import yfinance as yf
    tk = yf.Ticker(ticker)
    hist = tk.history(period="3mo", auto_adjust=True)
    if hist is None or hist.empty:
        raise ValueError(f"{ticker}: no price history")
    spot = float(hist["Close"].dropna().iloc[-1])
    hv = realized_vol(hist["Close"].dropna())
    exps = list(getattr(tk, "options", []) or [])
    return tk, spot, hv, exps


def _dte(exp: str, now: datetime) -> int:
    """Calendar days to an 'YYYY-MM-DD' expiration."""
    d = datetime.strptime(exp, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return (d - now).days


def _sell_premium(row) -> float | None:
    """Premium a SELLER realistically receives.

    During MARKET HOURS this is the BID (Fidelity's 'Sell at X') — what actually
    fills. The bid/ask MIDPOINT overstates it by ~half the spread, so we avoid it.

    When the market is CLOSED (weekends / after-hours) the bid is 0 for the whole
    chain; falling back to the last traded price keeps the scan working (a stale
    estimate, not a live fill) instead of dropping every strike and showing an
    empty wheel. Mark of the estimate: bid==0. Returns None only when there's no
    bid AND no last trade (a truly dead strike)."""
    bid = float(row.get("bid") or 0)
    if bid > 0:
        return bid
    last = float(row.get("last") or row.get("lastPrice") or 0)
    return last if last > 0 else None


# ── Row accessors (work on normalized market_data rows AND raw yfinance rows) ──
def _row_iv(row):
    v = row.get("iv")
    if v is None:
        v = row.get("impliedVolatility")
    try:
        return float(v) or None
    except (TypeError, ValueError):
        return None


def _row_oi(row) -> int:
    return int(row.get("open_interest") or row.get("openInterest") or 0)


def _row_delta(row):
    """Real delta straight from the feed (Tradier provides greeks), or None so
    the caller can fall back to a Black-Scholes estimate."""
    d = row.get("delta")
    try:
        return float(d) if d is not None else None
    except (TypeError, ValueError):
        return None


# ── Per-contract evaluation ──────────────────────────────────────────────────
def _eval_call(row, spot, dte, r):
    """Covered call (sell an OTM call against 100 owned shares)."""
    K = float(row["strike"])
    if K <= spot:                       # only OTM calls (room to run before assigned)
        return None
    prem = _sell_premium(row)
    if not prem:
        return None
    iv = _row_iv(row)
    T = dte / 365.0
    delta = _row_delta(row)                                # prefer the feed's real delta
    if delta is None and iv:
        delta = bs_delta(spot, K, T, iv, r, "call")
    static = prem / spot                                   # kept if not called
    if_called = (prem + (K - spot)) / spot                 # premium + cap gain
    ann = lambda x: x * (365.0 / dte)
    return {
        "strategy": "covered_call",
        "strike": round(K, 2),
        "premium": round(prem, 2),
        "iv": round(iv, 4) if iv else None,
        "assignment_prob": round(delta, 3) if delta is not None else None,
        "static_return": round(static, 4),
        "static_return_annualized": round(ann(static), 4),
        "if_called_return": round(if_called, 4),
        "if_called_return_annualized": round(ann(if_called), 4),
        "breakeven": round(spot - prem, 2),
        "downside_cushion": round(prem / spot, 4),         # static loss buffer
        "pct_otm": round((K - spot) / spot, 4),            # room before assigned
        "open_interest": _row_oi(row),
    }


def _eval_put(row, spot, dte, r):
    """Cash-secured put (sell an OTM put, hold cash to buy if assigned)."""
    K = float(row["strike"])
    if K >= spot:                       # only OTM puts (buy below today)
        return None
    prem = _sell_premium(row)
    if not prem:
        return None
    iv = _row_iv(row)
    T = dte / 365.0
    delta = _row_delta(row)                                # prefer the feed's real delta
    if delta is None and iv:
        delta = bs_delta(spot, K, T, iv, r, "put")
    yield_on_cash = prem / K                                # return on secured cash
    ann = lambda x: x * (365.0 / dte)
    eff_buy = K - prem                                     # net cost if assigned
    return {
        "strategy": "cash_secured_put",
        "strike": round(K, 2),
        "premium": round(prem, 2),
        "iv": round(iv, 4) if iv else None,
        "assignment_prob": round(abs(delta), 3) if delta is not None else None,
        "yield_on_cash": round(yield_on_cash, 4),
        "yield_on_cash_annualized": round(ann(yield_on_cash), 4),
        "effective_buy_price": round(eff_buy, 2),
        "discount_to_spot": round((spot - eff_buy) / spot, 4),
        "pct_otm": round((spot - K) / spot, 4),
        "open_interest": _row_oi(row),
    }


# ── Per-ticker scan ──────────────────────────────────────────────────────────
def _bucket_expiries(exps_dte: list) -> dict:
    """Pick the nearest expiration in each tenor bucket. Input is a list of
    (exp, dte) already filtered to the DTE window. Returns {bucket: (exp, dte)}."""
    chosen: dict = {}
    for name, lo, hi in TENOR_BUCKETS:
        in_b = [(e, d) for (e, d) in exps_dte if lo <= d <= hi]
        if in_b:
            chosen[name] = min(in_b, key=lambda x: x[1])   # nearest within bucket
    return chosen


def _best_in(rows, evalfn, yield_field, spot, dte, exp, delta_max, risk_free, min_oi):
    """Best (highest annualized yield) sellable strike in a list of rows, within
    [MIN_DELTA, delta_max] and the OTM band."""
    best = None
    for row in rows:
        if _row_oi(row) < min_oi:
            continue
        c = evalfn(row, spot, dte, risk_free)
        if (c and c["assignment_prob"] is not None
                and MIN_DELTA <= c["assignment_prob"] <= delta_max
                and c["pct_otm"] <= MAX_PCT_OTM
                and (best is None or c[yield_field] > best[yield_field])):
            c["expiration"], c["dte"] = exp, dte
            best = c
    return best


def _atm_iv(call_rows, spot):
    """IV of the call nearest the money — the vol-richness numerator."""
    best, best_d = None, None
    for row in call_rows:
        try:
            d = abs(float(row["strike"]) - spot)
        except (TypeError, ValueError, KeyError):
            continue
        if best_d is None or d < best_d:
            best_d, best = d, _row_iv(row)
    return best


def _eval_bucket_chains(ticker, spot, hv, bucket_chains, delta_max=DEFAULT_DELTA_MAX,
                        side="both", risk_free=DEFAULT_RISK_FREE,
                        min_oi=MIN_OPEN_INTEREST) -> dict:
    """Source-agnostic core. Evaluate pre-bucketed, pre-fetched chains.
    bucket_chains = {bucket: (exp, dte, [normalized_rows])}."""
    want_calls = side in ("both", "calls")
    want_puts = side in ("both", "puts")
    cc, csp, atm_iv = {}, {}, None
    nearest_exp = (min(bucket_chains.values(), key=lambda v: v[1])[0]
                   if bucket_chains else None)
    for bucket, (exp, dte, rows) in bucket_chains.items():
        calls = [r for r in rows if (r.get("option_type") or "").lower() == "call"]
        puts = [r for r in rows if (r.get("option_type") or "").lower() == "put"]
        if want_calls:
            cc[bucket] = _best_in(calls, _eval_call, "static_return_annualized",
                                  spot, dte, exp, delta_max, risk_free, min_oi)
        if want_puts:
            csp[bucket] = _best_in(puts, _eval_put, "yield_on_cash_annualized",
                                   spot, dte, exp, delta_max, risk_free, min_oi)
        if exp == nearest_exp and atm_iv is None:
            atm_iv = _atm_iv(calls, spot)
    iv_hv = round(atm_iv / hv, 3) if (atm_iv and hv) else None
    out = {"ticker": ticker.strip().upper(), "ok": True,
           "spot": round(spot, 2),
           "realized_vol": round(hv, 4) if hv else None,
           "atm_iv": round(atm_iv, 4) if atm_iv else None,
           "iv_hv_ratio": iv_hv,
           "expirations_scanned": {b: {"expiration": e, "dte": d}
                                   for b, (e, d, _) in bucket_chains.items()}}
    if want_calls:
        out["covered_calls"] = cc
    if want_puts:
        out["cash_secured_puts"] = csp
    return out


def _spot_and_hv(ticker):
    """Spot + trailing realized vol. yfinance history (one light call) gives hv;
    fall back to a market_data quote for spot if history is unavailable."""
    try:
        import yfinance as yf
        closes = yf.Ticker(ticker).history(period="3mo", auto_adjust=True)["Close"].dropna()
        if len(closes):
            return float(closes.iloc[-1]), realized_vol(closes)
    except Exception:
        pass
    q = (_market.get_quotes([ticker]) or {}).get(ticker.upper()) or {}
    if q.get("price") is None:
        raise ValueError(f"{ticker}: no price")
    return float(q["price"]), None


def scan_ticker(ticker: str,
                delta_max: float = DEFAULT_DELTA_MAX,
                side: str = "both",
                risk_free: float = DEFAULT_RISK_FREE,
                min_oi: int = MIN_OPEN_INTEREST) -> dict:
    """Scan one ticker LIVE (Tradier chains → yfinance fallback). For EACH tenor
    bucket returns the best sellable strike within [MIN_DELTA, delta_max]."""
    ticker = ticker.strip().upper()
    out = {"ticker": ticker, "ok": False}
    try:
        spot, hv = _spot_and_hv(ticker)
        exps = _market.get_expirations(ticker)
    except Exception as e:
        out["error"] = str(e)
        return out
    now = datetime.now(timezone.utc)
    exps_dte = [(e, _dte(e, now)) for e in exps]
    exps_dte = [(e, d) for (e, d) in exps_dte if MIN_DTE <= d <= MAX_DTE]
    chosen = _bucket_expiries(exps_dte)
    if not chosen:
        out.update(spot=round(spot, 2), realized_vol=round(hv, 4) if hv else None)
        out["error"] = "no expirations in DTE window"
        return out
    bucket_chains = {}
    for bucket, (exp, dte) in chosen.items():
        bucket_chains[bucket] = (exp, dte, _market.get_chain(ticker, exp) or [])
    return _eval_bucket_chains(ticker, spot, hv, bucket_chains,
                               delta_max, side, risk_free, min_oi)


# ── Portfolio sweep ──────────────────────────────────────────────────────────
def scan_wheel(tickers,
               delta_max: float = DEFAULT_DELTA_MAX,
               side: str = "both",
               risk_free: float = DEFAULT_RISK_FREE,
               min_oi: int = MIN_OPEN_INTEREST) -> dict:
    """Sweep a list of tickers and rank them by vol richness. Returns a dict
    ready to hand to the analyst LLM for narration."""
    if isinstance(tickers, str):
        tickers = [t.strip() for t in tickers.split(",") if t.strip()]
    rows = []
    for t in tickers:
        try:
            rows.append(scan_ticker(t, delta_max=delta_max, side=side,
                                    risk_free=risk_free, min_oi=min_oi))
        except Exception as e:
            rows.append({"ticker": t.upper(), "ok": False, "error": str(e)})
    # Rank by vol richness (rich premium first); names with no signal sink.
    rows.sort(key=lambda r: (r.get("iv_hv_ratio") or 0), reverse=True)
    return {
        "delta_max": delta_max,
        "side": side,
        "count": len(rows),
        "scanned_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "results": rows,
    }


# ── Manual smoke test ────────────────────────────────────────────────────────
if __name__ == "__main__":
    import json
    import sys
    syms = sys.argv[1:] or ["INTC"]
    dmax = DEFAULT_DELTA_MAX
    print(json.dumps(scan_wheel(syms, delta_max=dmax), indent=2, default=str))
