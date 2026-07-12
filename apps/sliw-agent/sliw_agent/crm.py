"""
Lightweight file-based CRM for Sliw Agent prospects and pipeline stages.

Storage: apps/sliw-agent/data/crm.json
Designed for human + agent collaboration — no external SaaS required.
"""

from __future__ import annotations

import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

def _resolve_data_dir() -> Path:
    """Prefer persistent volume on Railway (STOCKS_FOLDER / SLIW_DATA_DIR)."""
    import os
    for key in ("SLIW_DATA_DIR", "STOCKS_FOLDER"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            base = Path(raw)
            # STOCKS_FOLDER is shared — nest under sliw-agent/
            return base / "sliw-agent" if key == "STOCKS_FOLDER" else base
    return Path(__file__).resolve().parent.parent / "data"


DATA_DIR = _resolve_data_dir()
CRM_PATH = DATA_DIR / "crm.json"
OUTREACH_DIR = DATA_DIR / "outreach"
DECKS_DIR = DATA_DIR / "decks"
BRIEFS_DIR = DATA_DIR / "briefs"

# Pipeline stages (Hollywood desk mental model)
STAGES = [
    "research",          # identified, not yet scored
    "scored",            # ICP fit scored, package recommended
    "packaged",          # Gamma marketing deck created
    "drafted",           # outreach email drafted (awaiting approval)
    "approved",          # human approved send
    "contacted",         # outreach sent
    "replied",           # any reply received
    "interested",        # qualified interest — hand to Edyta
    "discovery_booked",  # call scheduled with Edyta
    "won",               # booked engagement
    "lost",              # passed / no budget / no fit
    "nurture",           # not now — stay warm
]

DEFAULT_CRM: dict[str, Any] = {
    "version": 1,
    "updated_at": None,
    "prospects": {},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTREACH_DIR.mkdir(parents=True, exist_ok=True)
    DECKS_DIR.mkdir(parents=True, exist_ok=True)
    BRIEFS_DIR.mkdir(parents=True, exist_ok=True)


def load_crm() -> dict[str, Any]:
    ensure_dirs()
    if not CRM_PATH.exists():
        crm = deepcopy(DEFAULT_CRM)
        crm["updated_at"] = _now()
        save_crm(crm)
        return crm
    return json.loads(CRM_PATH.read_text(encoding="utf-8"))


def save_crm(crm: dict[str, Any]) -> None:
    ensure_dirs()
    crm["updated_at"] = _now()
    CRM_PATH.write_text(json.dumps(crm, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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
) -> dict[str, Any]:
    """Create or update a prospect. Returns the prospect record."""
    crm = load_crm()
    if prospect_id and prospect_id in crm["prospects"]:
        p = crm["prospects"][prospect_id]
    else:
        # match by company name if present
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
        # merge by email
        by_email = {c.get("email", "").lower(): c for c in p.get("contacts") or [] if c.get("email")}
        for c in contacts:
            key = (c.get("email") or "").lower() or c.get("name", "")
            by_email[key] = {**(by_email.get(key) or {}), **c}
        p["contacts"] = list(by_email.values())
    if extra:
        p.update(extra)
    p["updated_at"] = _now()
    save_crm(crm)
    return p


def set_stage(prospect_id: str, stage: str, note: str = "") -> dict[str, Any]:
    if stage not in STAGES:
        raise ValueError(f"Unknown stage {stage!r}. Valid: {STAGES}")
    crm = load_crm()
    p = crm["prospects"].get(prospect_id)
    if not p:
        raise KeyError(f"Prospect {prospect_id} not found")
    old = p.get("stage")
    p["stage"] = stage
    p["updated_at"] = _now()
    p.setdefault("history", []).append(
        {"at": _now(), "from": old, "to": stage, "note": note}
    )
    save_crm(crm)
    return p


def update_prospect(prospect_id: str, **fields: Any) -> dict[str, Any]:
    crm = load_crm()
    p = crm["prospects"].get(prospect_id)
    if not p:
        raise KeyError(f"Prospect {prospect_id} not found")
    for k, v in fields.items():
        if v is not None:
            p[k] = v
    p["updated_at"] = _now()
    save_crm(crm)
    return p


def get_prospect(prospect_id: str) -> dict[str, Any] | None:
    return load_crm()["prospects"].get(prospect_id)


def list_prospects(stage: str | None = None, min_score: float | None = None) -> list[dict[str, Any]]:
    prospects = list(load_crm()["prospects"].values())
    if stage:
        prospects = [p for p in prospects if p.get("stage") == stage]
    if min_score is not None:
        prospects = [p for p in prospects if (p.get("score") or 0) >= min_score]
    return sorted(prospects, key=lambda p: (-(p.get("score") or 0), p.get("company", "")))


def pipeline_summary() -> dict[str, int]:
    counts = {s: 0 for s in STAGES}
    for p in load_crm()["prospects"].values():
        st = p.get("stage") or "research"
        counts[st] = counts.get(st, 0) + 1
    return counts


def interested_leads() -> list[dict[str, Any]]:
    """Leads ready for Edyta — interested or discovery booked."""
    return list_prospects(stage="interested") + list_prospects(stage="discovery_booked")
