"""Financials domain mount — loads store/dashboard body into server namespace.

The implementation lives in ``_financials_body.py`` and is executed inside
``api.server``'s module dict so route decorators and helpers (``_fund_conn``,
``app``, …) resolve the same way they did when the code lived in server.py.
"""
from __future__ import annotations

from pathlib import Path


def mount(mod) -> None:
    """Exec financials body into *mod* (the api.server module object)."""
    body_path = Path(__file__).with_name("_financials_body.py")
    src = body_path.read_text(encoding="utf-8")
    code = compile(src, str(body_path), "exec")
    # Execute in the live server module namespace (not a copy).
    exec(code, mod.__dict__)
    n_routes = sum(
        1 for r in getattr(mod, "app", None).routes or []
        if "financials" in getattr(r, "path", "")
    )
    print(f"[boot] financials domain mounted ({n_routes} /api/financials* routes)", flush=True)
