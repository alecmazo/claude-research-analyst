"""
snaptrade_client.py — thin wrapper over the SnapTrade SDK for DGA's Fidelity
holdings import. SnapTrade (https://snaptrade.com) connects brokerage accounts —
including Fidelity, which Fidelity stopped supporting via Plaid in Oct 2023.

Environment (set in Railway, backend-only — never shipped to any client):
    SNAPTRADE_CLIENT_ID      your SnapTrade clientId (not secret)
    SNAPTRADE_CONSUMER_KEY   your SnapTrade consumerKey (SECRET)
    SNAPTRADE_REDIRECT_URI   optional — where the connection portal returns the
                             user (defaults to the GP terminal)
    SNAPTRADE_BROKER         optional broker slug to deep-link (e.g. FIDELITY);
                             if unset, the user picks the brokerage in the portal

Read-only access only (connection_type="read") — we pull holdings, never trade.
The SDK + model imports are lazy so this module imports cleanly even where the
SDK isn't installed (e.g. local syntax checks), matching the codebase style.
"""
from __future__ import annotations

import os

CLIENT_NAME = "DGA Capital"
DEFAULT_REDIRECT = "https://portfolio.dgacapital.com/gp"


def available() -> bool:
    """True if the SDK is importable and credentials are configured."""
    try:
        import snaptrade_client  # noqa: F401
    except Exception:
        return False
    return bool(os.environ.get("SNAPTRADE_CLIENT_ID", "").strip()
                and os.environ.get("SNAPTRADE_CONSUMER_KEY", "").strip())


def _client():
    from snaptrade_client import SnapTrade
    cid = os.environ.get("SNAPTRADE_CLIENT_ID", "").strip()
    sec = os.environ.get("SNAPTRADE_CONSUMER_KEY", "").strip()
    if not cid or not sec:
        raise RuntimeError("SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY are not set.")
    return SnapTrade(consumer_key=sec, client_id=cid)


def check_status() -> dict:
    """API reachability check."""
    return _to_dict(_client().api_status.check().body)


def register_user(user_id: str) -> dict:
    """Register a SnapTrade user; returns {userId, userSecret}. The userSecret is
    a per-user credential — caller must encrypt it at rest."""
    r = _client().authentication.register_snap_trade_user(user_id=str(user_id))
    body = r.body
    secret = _pluck(body, "userSecret", "user_secret")
    uid = _pluck(body, "userId", "user_id") or str(user_id)
    return {"userId": uid, "userSecret": secret}


def _pluck(body, *keys):
    """Extract a field from an SDK body whether it's a dict, a schema object, or
    needs coercion."""
    for k in keys:
        try:
            v = body[k]
            if v is not None:
                return v
        except Exception:
            pass
        v = getattr(body, k, None)
        if v is not None:
            return v
    d = _to_dict(body)
    if isinstance(d, dict):
        for k in keys:
            if d.get(k) is not None:
                return d.get(k)
    return None


def delete_user(user_id: str) -> dict:
    return _to_dict(_client().authentication.delete_snap_trade_user(user_id=str(user_id)).body)


def login_url(user_id: str, user_secret: str, custom_redirect: str = "",
              broker: str = "", connection_type: str = "read") -> str:
    """Generate a Connection Portal URL (expires in 5 min). Open it in a new tab;
    the user links their brokerage there and is returned to custom_redirect."""
    kw = {
        "user_id": str(user_id),
        "user_secret": user_secret,
        "connection_type": connection_type or "read",
    }
    if custom_redirect:
        kw["custom_redirect"] = custom_redirect
    if broker:
        kw["broker"] = broker
    body = _client().authentication.login_snap_trade_user(**kw).body
    # body may be a dict {"redirectURI": "..."} or the URL string itself.
    if isinstance(body, dict):
        return body.get("redirectURI") or body.get("redirect_uri") or body.get("redirectUri") or ""
    return str(body)


def get_account_holdings(user_id: str, user_secret: str, account_id: str):
    """Holdings for ONE account — {positions, total_value}.

    Built from the GRANULAR per-account endpoints. Both the combined
    get_all_user_holdings AND the per-account get_user_holdings now return
    'This endpoint is no longer available for your account' — SnapTrade has
    moved accounts onto get_user_account_positions / get_user_account_balance.
    """
    ai = _client().account_information
    uid, sec, aid = str(user_id), user_secret, str(account_id)

    positions = _to_dict(
        ai.get_user_account_positions(account_id=aid, user_id=uid, user_secret=sec).body
    ) or []
    if isinstance(positions, dict):
        positions = positions.get("positions") or positions.get("data") or []

    # total_value = market value of positions + uninvested cash.
    # NOTE: Fidelity's core sweep (e.g. SPAXX) appears BOTH as a cash_equivalent
    # position AND in the balance `cash` field — adding both double-counts it.
    # So we only fold in balance cash when no cash-equivalent position exists.
    pos_mv = 0.0
    has_cash_position = False
    for p in positions:
        if not isinstance(p, dict):
            continue
        if p.get("cash_equivalent"):
            has_cash_position = True
        units, price = p.get("units"), p.get("price")
        try:
            if units is not None and price is not None:
                pos_mv += float(units) * float(price)
        except Exception:
            pass

    cash = 0.0
    if not has_cash_position:
        try:
            balances = _to_dict(
                ai.get_user_account_balance(account_id=aid, user_id=uid, user_secret=sec).body
            ) or []
            if isinstance(balances, dict):
                balances = balances.get("balances") or balances.get("data") or [balances]
            for b in balances:
                if not isinstance(b, dict):
                    continue
                c = b.get("cash")
                if isinstance(c, dict):
                    c = c.get("amount") or c.get("value")
                if c is not None:
                    cash += float(c)
        except Exception:
            pass

    return {"positions": positions, "total_value": (pos_mv + cash) or None}


def get_option_holdings(user_id: str, user_secret: str, account_id: str):
    """Option positions for ONE account (separate endpoint from equity positions).
    The deprecated combined get_user_holdings used to return these as
    `option_positions`; get_user_account_positions does NOT include them."""
    r = _client().options.list_option_holdings(
        user_id=str(user_id), user_secret=user_secret, account_id=str(account_id))
    return _to_dict(r.body)


def get_balances(user_id: str, user_secret: str, account_id: str):
    """Raw per-currency balances for ONE account."""
    r = _client().account_information.get_user_account_balance(
        account_id=str(account_id), user_id=str(user_id), user_secret=user_secret)
    return _to_dict(r.body)


def get_account_activities(user_id: str, user_secret: str, account_id: str,
                           start_date: str | None = None, end_date: str | None = None):
    """Transaction history for ONE account in [start_date, end_date] (YYYY-MM-DD).

    Returns BUY / SELL / DIVIDEND / CONTRIBUTION / WITHDRAWAL / INTEREST / FEE /
    TRANSFER activities — what the position/balance endpoints do NOT give. This is
    the basis for YTD trade lists and external-cash-flow-aware return math.
    """
    kw = {"user_id": str(user_id), "user_secret": user_secret, "accounts": str(account_id)}
    if start_date:
        kw["start_date"] = start_date
    if end_date:
        kw["end_date"] = end_date
    r = _client().transactions_and_reporting.get_activities(**kw)
    body = _to_dict(r.body)
    if isinstance(body, dict):
        items = body.get("data") or body.get("activities") or []
    else:
        items = body or []
    # Coerce each element to a plain dict — the SDK may hand back schema objects,
    # which would otherwise be silently dropped downstream.
    return [_to_dict(x) for x in items]


def list_accounts(user_id: str, user_secret: str):
    r = _client().account_information.list_user_accounts(
        user_id=str(user_id), user_secret=user_secret)
    return _to_dict(r.body)


def list_connections(user_id: str, user_secret: str):
    r = _client().connections.list_brokerage_authorizations(
        user_id=str(user_id), user_secret=user_secret)
    return _to_dict(r.body)


def remove_connection(user_id: str, user_secret: str, authorization_id: str) -> None:
    _client().connections.remove_brokerage_authorization(
        authorization_id=str(authorization_id), user_id=str(user_id), user_secret=user_secret)


def _to_dict(body):
    """SDK bodies are schema objects; coerce to plain JSON-able structures."""
    if body is None:
        return body
    if isinstance(body, (dict, list, str, int, float, bool)):
        return body
    for attr in ("to_dict", "model_dump"):
        fn = getattr(body, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    # Konfig schema objects are dict-like / iterable
    try:
        return dict(body)
    except Exception:
        try:
            return list(body)
        except Exception:
            return body
