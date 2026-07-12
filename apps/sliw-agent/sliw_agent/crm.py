"""
Multi-book CRM for Sliw Agent (corporate + wedding) + partnerships.

Storage under DATA_DIR:
  crm.json           — corporate prospects (backward compatible)
  wedding_crm.json    — wedding book
  partnerships.json   — channel partners
"""

from __future__ import annotations

import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _resolve_data_dir() -> Path:
    import os
    dedicated = (os.environ.get("SLIW_DATA_DIR") or "").strip()
    if dedicated:
        return Path(dedicated)
    stocks = (os.environ.get("STOCKS_FOLDER") or "").strip()
    if stocks:
        return Path(stocks) / "sliw-agent"
    return Path(__file__).resolve().parent.parent / "data"


DATA_DIR = _resolve_data_dir()
CRM_PATH = DATA_DIR / "crm.json"
WEDDING_CRM_PATH = DATA_DIR / "wedding_crm.json"
PARTNERSHIPS_PATH = DATA_DIR / "partnerships.json"
OUTREACH_DIR = DATA_DIR / "outreach"
DECKS_DIR = DATA_DIR / "decks"
BRIEFS_DIR = DATA_DIR / "briefs"
WEDDING_OUTREACH_DIR = DATA_DIR / "wedding_outreach"
WEDDING_DECKS_DIR = DATA_DIR / "wedding_decks"
WEDDING_BRIEFS_DIR = DATA_DIR / "wedding_briefs"

STAGES = [
    "research",
    "scored",
    "packaged",
    "drafted",
    "approved",
    "contacted",
    "replied",
    "interested",
    "discovery_booked",
    "won",
    "lost",
    "nurture",
]

BOOKS = ("corporate", "wedding")

DEFAULT_CRM: dict[str, Any] = {
    "version": 2,
    "book": "corporate",
    "updated_at": None,
    "prospects": {},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    for d in (
        DATA_DIR,
        OUTREACH_DIR,
        DECKS_DIR,
        BRIEFS_DIR,
        WEDDING_OUTREACH_DIR,
        WEDDING_DECKS_DIR,
        WEDDING_BRIEFS_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)


def _crm_path(book: str = "corporate") -> Path:
    if book == "wedding":
        return WEDDING_CRM_PATH
    return CRM_PATH


def _dirs_for_book(book: str = "corporate") -> dict[str, Path]:
    if book == "wedding":
        return {
            "outreach": WEDDING_OUTREACH_DIR,
            "decks": WEDDING_DECKS_DIR,
            "briefs": WEDDING_BRIEFS_DIR,
        }
    return {
        "outreach": OUTREACH_DIR,
        "decks": DECKS_DIR,
        "briefs": BRIEFS_DIR,
    }


def load_crm(book: str = "corporate") -> dict[str, Any]:
    ensure_dirs()
    path = _crm_path(book)
    if not path.exists():
        crm = deepcopy(DEFAULT_CRM)
        crm["book"] = book
        crm["updated_at"] = _now()
        save_crm(crm, book=book)
        return crm
    data = json.loads(path.read_text(encoding="utf-8"))
    # migrate v1 → ensure book field
    if "book" not in data:
        data["book"] = book
    return data


def save_crm(crm: dict[str, Any], book: str = "corporate") -> None:
    ensure_dirs()
    crm["updated_at"] = _now()
    crm["book"] = book
    _crm_path(book).write_text(
        json.dumps(crm, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def new_prospect_id(company: str) -> str:
    slug = "".join(c.lower() if c.isalnum() else "-" for c in company).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)[:48]
    return f"{slug}-{uuid.uuid4().hex[:6]}"


def upsert_prospect(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    employee_range: str = "",
    website: str = "",
    notes: str = "",
    signals: list[str] | None = None,
    contacts: list[dict[str, str]] | None = None,
    prospect_id: str | None = None,
    extra: dict[str, Any] | None = None,
    book: str = "corporate",
) -> dict[str, Any]:
    crm = load_crm(book)
    if prospect_id and prospect_id in crm["prospects"]:
        p = crm["prospects"][prospect_id]
    else:
        existing_id = None
        for pid, rec in crm["prospects"].items():
            if rec.get("company", "").lower() == company.lower():
                existing_id = pid
                break
        if existing_id:
            prospect_id = existing_id
            p = crm["prospects"][prospect_id]
        else:
            prospect_id = new_prospect_id(company)
            p = {
                "id": prospect_id,
                "book": book,
                "company": company,
                "created_at": _now(),
                "stage": "research",
                "score": None,
                "recommended_packages": [],
                "contacts": [],
                "signals": [],
                "gamma_url": None,
                "gamma_pptx": None,
                "outreach_path": None,
                "edyta_brief_path": None,
                "history": [],
            }
            crm["prospects"][prospect_id] = p

    p["company"] = company
    p["book"] = book
    if industry:
        p["industry"] = industry
    if geo:
        p["geo"] = geo
    if employee_range:
        p["employee_range"] = employee_range
    if website:
        p["website"] = website
    if notes:
        p["notes"] = notes
    if signals:
        p["signals"] = list(dict.fromkeys((p.get("signals") or []) + signals))
    if contacts:
        by_email = {
            c.get("email", "").lower(): c
            for c in p.get("contacts") or []
            if c.get("email")
        }
        for c in contacts:
            key = (c.get("email") or "").lower() or c.get("name", "")
            by_email[key] = {**(by_email.get(key) or {}), **c}
        p["contacts"] = list(by_email.values())
    if extra:
        p.update(extra)
    p["updated_at"] = _now()
    save_crm(crm, book=book)
    return p


def set_stage(
    prospect_id: str,
    stage: str,
    note: str = "",
    book: str | None = None,
) -> dict[str, Any]:
    if stage not in STAGES:
        raise ValueError(f"Unknown stage {stage!r}. Valid: {STAGES}")
    # resolve book if needed
    p, book = _find_prospect(prospect_id, book)
    crm = load_crm(book)
    p = crm["prospects"][prospect_id]
    old = p.get("stage")
    p["stage"] = stage
    p["updated_at"] = _now()
    p.setdefault("history", []).append(
        {"at": _now(), "from": old, "to": stage, "note": note}
    )
    save_crm(crm, book=book)
    return p


def update_prospect(
    prospect_id: str,
    book: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    p, book = _find_prospect(prospect_id, book)
    crm = load_crm(book)
    p = crm["prospects"][prospect_id]
    for k, v in fields.items():
        if v is not None:
            p[k] = v
    p["updated_at"] = _now()
    save_crm(crm, book=book)
    return p


def _find_prospect(
    prospect_id: str, book: str | None = None
) -> tuple[dict[str, Any], str]:
    if book:
        p = load_crm(book)["prospects"].get(prospect_id)
        if not p:
            raise KeyError(f"Prospect {prospect_id} not found in {book}")
        return p, book
    for b in BOOKS:
        p = load_crm(b)["prospects"].get(prospect_id)
        if p:
            return p, b
    raise KeyError(f"Prospect {prospect_id} not found")


def get_prospect(prospect_id: str, book: str | None = None) -> dict[str, Any] | None:
    try:
        p, b = _find_prospect(prospect_id, book)
        p = dict(p)
        p["book"] = b
        return p
    except KeyError:
        return None


def list_prospects(
    stage: str | None = None,
    min_score: float | None = None,
    book: str = "corporate",
) -> list[dict[str, Any]]:
    prospects = list(load_crm(book)["prospects"].values())
    for p in prospects:
        p.setdefault("book", book)
    if stage:
        prospects = [p for p in prospects if p.get("stage") == stage]
    if min_score is not None:
        prospects = [p for p in prospects if (p.get("score") or 0) >= min_score]
    return sorted(
        prospects, key=lambda p: (-(p.get("score") or 0), p.get("company", ""))
    )


def pipeline_summary(book: str = "corporate") -> dict[str, int]:
    counts = {s: 0 for s in STAGES}
    for p in load_crm(book)["prospects"].values():
        st = p.get("stage") or "research"
        counts[st] = counts.get(st, 0) + 1
    return counts


def interested_leads(book: str = "corporate") -> list[dict[str, Any]]:
    return list_prospects(stage="interested", book=book) + list_prospects(
        stage="discovery_booked", book=book
    )


# ── Partnerships ──────────────────────────────────────────────────────────────

def load_partnerships() -> list[dict[str, Any]]:
    ensure_dirs()
    if not PARTNERSHIPS_PATH.exists():
        return []
    data = json.loads(PARTNERSHIPS_PATH.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else data.get("partners", [])


def save_partnerships(partners: list[dict[str, Any]]) -> None:
    ensure_dirs()
    PARTNERSHIPS_PATH.write_text(
        json.dumps({"updated_at": _now(), "partners": partners}, indent=2) + "\n",
        encoding="utf-8",
    )


def upsert_partner(partner: dict[str, Any]) -> dict[str, Any]:
    partners = load_partnerships()
    pid = partner.get("id") or f"partner-{uuid.uuid4().hex[:8]}"
    partner["id"] = pid
    partner["updated_at"] = _now()
    found = False
    for i, p in enumerate(partners):
        if p.get("id") == pid or (
            p.get("name", "").lower() == partner.get("name", "").lower()
            and partner.get("name")
        ):
            partners[i] = {**p, **partner}
            partner = partners[i]
            found = True
            break
    if not found:
        partner.setdefault("created_at", _now())
        partners.append(partner)
    save_partnerships(partners)
    return partner
