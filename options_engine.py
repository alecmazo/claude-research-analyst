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
    """Premium a SELLER realistically receives = the BID (Fidelity's 'Sell at X').

    We SELL options in the wheel, so the bid is what actually fills. The bid/ask
    MIDPOINT is a theoretical fair value you rarely capture when selling — using
    it overstates every premium (and yield) by roughly half the spread. That was
    the #1 source of prices reading higher than a real broker chain.

    Returns None when there's no bid: you can't sell into no buyer, and such
    illiquid strikes otherwise fall back to a stale lastPrice that is 'nowhere
    near' a real fill (the IBRX-type discrepancy)."""
    bid = float(row.get("bid") or 0)
    return bid if bid > 0 else None


# ── Per-contract evaluation ──────────────────────────────────────────────────
def _eval_call(row, spot, dte, r):
    """Covered call (sell an OTM call against 100 owned shares)."""
    K = float(row["strike"])
    if K <= spot:                       # only OTM calls (room to run before assigned)
        return None
    prem = _sell_premium(row)
    if not prem:
        return None
    iv = float(row.get("impliedVolatility") or 0) or None
    T = dte / 365.0
    delta = bs_delta(spot, K, T, iv, r, "call") if iv else None
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
        "open_interest": int(row.get("openInterest") or 0),
    }


def _eval_put(row, spot, dte, r):
    """Cash-secured put (sell an OTM put, hold cash to buy if assigned)."""
    K = float(row["strike"])
    if K >= spot:                       # only OTM puts (buy below today)
        return None
    prem = _sell_premium(row)
    if not prem:
        return None
    iv = float(row.get("impliedVolatility") or 0) or None
    T = dte / 365.0
    delta = bs_delta(spot, K, T, iv, r, "put") if iv else None
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
        "open_interest": int(row.get("openInterest") or 0),
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


def scan_ticker(ticker: str,
                delta_max: float = DEFAULT_DELTA_MAX,
                side: str = "both",
                risk_free: float = DEFAULT_RISK_FREE,
                min_oi: int = MIN_OPEN_INTEREST) -> dict:
    """Scan one ticker. For EACH tenor bucket (weekly/monthly/quarterly) and
    each requested side, returns the single best strike (highest annualized
    yield) whose assignment probability sits within [MIN_DELTA, delta_max]."""
    ticker = ticker.strip().upper()
    out: dict = {"ticker": ticker, "ok": False}
    try:
        tk, spot, hv, exps = _fetch(ticker)
    except Exception as e:
        out["error"] = str(e)
        return out

    now = datetime.now(timezone.utc)
    exps_dte = [(e, _dte(e, now)) for e in exps]
    exps_dte = [(e, d) for (e, d) in exps_dte if MIN_DTE <= d <= MAX_DTE]
    chosen = _bucket_expiries(exps_dte)
    out.update(spot=round(spot, 2),
               realized_vol=round(hv, 4) if hv else None,
               expirations_scanned={b: {"expiration": e, "dte": d}
                                    for b, (e, d) in chosen.items()})
    if not chosen:
        out["error"] = "no expirations in DTE window"
        return out

    want_calls = side in ("both", "calls")
    want_puts = side in ("both", "puts")
    cc: dict = {}
    csp: dict = {}
    atm_iv = None
    nearest_exp = min(chosen.values(), key=lambda x: x[1])[0]

    for bucket, (exp, dte) in chosen.items():
        try:
            chain = tk.option_chain(exp)
        except Exception:
            continue
        if want_calls and chain.calls is not None:
            best = None
            for _, row in chain.calls.iterrows():
                if int(row.get("openInterest") or 0) < min_oi:
                    continue
                c = _eval_call(row, spot, dte, risk_free)
                if c and c["assignment_prob"] is not None and \
                        MIN_DELTA <= c["assignment_prob"] <= delta_max and \
                        c["pct_otm"] <= MAX_PCT_OTM and \
                        (best is None or c["static_return_annualized"] >
                         best["static_return_annualized"]):
                    c["expiration"], c["dte"] = exp, dte
                    best = c
            cc[bucket] = best
        if want_puts and chain.puts is not None:
            best = None
            for _, row in chain.puts.iterrows():
                if int(row.get("openInterest") or 0) < min_oi:
                    continue
                p = _eval_put(row, spot, dte, risk_free)
                if p and p["assignment_prob"] is not None and \
                        MIN_DELTA <= p["assignment_prob"] <= delta_max and \
                        p["pct_otm"] <= MAX_PCT_OTM and \
                        (best is None or p["yield_on_cash_annualized"] >
                         best["yield_on_cash_annualized"]):
                    p["expiration"], p["dte"] = exp, dte
                    best = p
            csp[bucket] = best
        # ATM implied vol from the nearest expiry → the vol-richness signal.
        if exp == nearest_exp and atm_iv is None and \
                chain.calls is not None and not chain.calls.empty:
            try:
                calls = chain.calls.copy()
                calls["_d"] = (calls["strike"] - spot).abs()
                atm_iv = float(calls.sort_values("_d").iloc[0]["impliedVolatility"])
            except Exception:
                pass

    # Vol richness: ATM IV vs trailing realized vol (the day-one IV-rank proxy).
    iv_hv_ratio = round(atm_iv / hv, 3) if (atm_iv and hv) else None
    out.update(atm_iv=round(atm_iv, 4) if atm_iv else None,
               iv_hv_ratio=iv_hv_ratio)
    if want_calls:
        out["covered_calls"] = cc          # {weekly/monthly/quarterly: best|None}
    if want_puts:
        out["cash_secured_puts"] = csp
    out["ok"] = True
    return out


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
