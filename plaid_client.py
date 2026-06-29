"""
plaid_client.py — thin wrapper over the Plaid SDK for DGA's Fidelity auto-import.

Environment (set in Railway, backend-only — never shipped to any client):
    PLAID_CLIENT_ID     your Plaid client id (shared across environments)
    PLAID_SECRET        the secret for the chosen environment
    PLAID_ENV           "sandbox" (default) | "production"
    PLAID_REDIRECT_URI  optional — required for OAuth institutions (Fidelity) in
                        Production; must be registered in the Plaid dashboard.

Only the `investments` product is requested (holdings + investment transactions)
— data minimisation. The Plaid SDK + model imports are done lazily inside each
function so this module imports cleanly even where plaid-python isn't installed
(e.g. local syntax checks), matching the codebase's optional-dependency style.
"""
from __future__ import annotations

import os

PLAID_ENV = os.environ.get("PLAID_ENV", "sandbox").strip().lower()
CLIENT_NAME = "DGA Capital"


def available() -> bool:
    """True if the SDK is importable and credentials are configured."""
    try:
        import plaid  # noqa: F401
    except Exception:
        return False
    return bool(os.environ.get("PLAID_CLIENT_ID", "").strip()
                and os.environ.get("PLAID_SECRET", "").strip())


def _client():
    import plaid
    from plaid.api import plaid_api
    cid = os.environ.get("PLAID_CLIENT_ID", "").strip()
    sec = os.environ.get("PLAID_SECRET", "").strip()
    if not cid or not sec:
        raise RuntimeError("PLAID_CLIENT_ID / PLAID_SECRET are not set.")
    host = {
        "sandbox":    plaid.Environment.Sandbox,
        "production": plaid.Environment.Production,
    }.get(PLAID_ENV, plaid.Environment.Sandbox)
    cfg = plaid.Configuration(host=host, api_key={"clientId": cid, "secret": sec})
    return plaid_api.PlaidApi(plaid.ApiClient(cfg))


def create_link_token(user_id: str = "dga-gp") -> dict:
    """Create a Link token for the Investments product. Returns {link_token, …}."""
    from plaid.model.link_token_create_request import LinkTokenCreateRequest
    from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
    from plaid.model.products import Products
    from plaid.model.country_code import CountryCode
    kw = dict(
        user=LinkTokenCreateRequestUser(client_user_id=str(user_id)),
        client_name=CLIENT_NAME,
        products=[Products("investments")],
        country_codes=[CountryCode("US")],
        language="en",
    )
    redirect = os.environ.get("PLAID_REDIRECT_URI", "").strip()
    if redirect:
        kw["redirect_uri"] = redirect
    return _client().link_token_create(LinkTokenCreateRequest(**kw)).to_dict()


def exchange_public_token(public_token: str) -> dict:
    """Exchange a public_token for {access_token, item_id, request_id}."""
    from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
    return _client().item_public_token_exchange(
        ItemPublicTokenExchangeRequest(public_token=public_token)).to_dict()


def get_item(access_token: str) -> dict:
    """Item + institution metadata for a connection."""
    from plaid.model.item_get_request import ItemGetRequest
    return _client().item_get(ItemGetRequest(access_token=access_token)).to_dict()


def get_institution(institution_id: str) -> dict:
    from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
    from plaid.model.country_code import CountryCode
    return _client().institutions_get_by_id(
        InstitutionsGetByIdRequest(institution_id=institution_id,
                                   country_codes=[CountryCode("US")])).to_dict()


def get_holdings(access_token: str) -> dict:
    """Investment holdings: {accounts, holdings, securities, item}."""
    from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
    return _client().investments_holdings_get(
        InvestmentsHoldingsGetRequest(access_token=access_token)).to_dict()


def get_investments_transactions(access_token: str, start_date, end_date,
                                 count: int = 500, offset: int = 0) -> dict:
    """Investment transactions over a date window (datetime.date objects)."""
    from plaid.model.investments_transactions_get_request import InvestmentsTransactionsGetRequest
    from plaid.model.investments_transactions_get_request_options import (
        InvestmentsTransactionsGetRequestOptions)
    req = InvestmentsTransactionsGetRequest(
        access_token=access_token, start_date=start_date, end_date=end_date,
        options=InvestmentsTransactionsGetRequestOptions(count=count, offset=offset))
    return _client().investments_transactions_get(req).to_dict()


def remove_item(access_token: str) -> dict:
    """Disconnect an Item at Plaid (invalidates the access_token)."""
    from plaid.model.item_remove_request import ItemRemoveRequest
    return _client().item_remove(ItemRemoveRequest(access_token=access_token)).to_dict()
