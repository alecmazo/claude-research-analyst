"""
Corporate Lead Engine — expand pipeline far beyond demo seeds.

- Expanded static library (Bay Area + CA + national premium targets)
- Bulk score/import into CRM
- "This week" desk checklist derived from CRM state + cadence rules
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import crm
from .outreach import (
    draft_cold_email,
    draft_followup_email,
    draft_breakup_email,
    subject_variants,
    save_outreach_draft,
)
from .pipeline import run_prospect_pipeline
from .scoring import score_prospect

LIBRARY_PATH = Path(__file__).resolve().parent.parent / "data" / "prospect_library.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_library() -> list[dict[str, Any]]:
    if not LIBRARY_PATH.exists():
        return []
    data = json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else data.get("prospects", [])


def library_stats() -> dict[str, Any]:
    lib = load_library()
    by_industry: dict[str, int] = {}
    by_geo: dict[str, int] = {}
    for row in lib:
        ind = row.get("industry") or "Other"
        by_industry[ind] = by_industry.get(ind, 0) + 1
        geo = (row.get("geo") or "Unknown").split(",")[0].strip()
        by_geo[geo] = by_geo.get(geo, 0) + 1
    return {
        "total": len(lib),
        "by_industry": by_industry,
        "by_geo_top": dict(sorted(by_geo.items(), key=lambda x: -x[1])[:15]),
        "path": str(LIBRARY_PATH),
    }


def import_from_library(
    *,
    limit: int = 40,
    min_priority: int = 0,
    industries: list[str] | None = None,
    draft_email: bool = False,
    generate_gamma_dry: bool = False,
) -> dict[str, Any]:
    """Score and upsert up to `limit` library rows not already in CRM."""
    lib = load_library()
    existing = {p.get("company", "").lower() for p in crm.list_prospects()}
    industries_l = {i.lower() for i in (industries or []) if i}

    candidates = []
    for row in lib:
        if (row.get("company") or "").lower() in existing:
            continue
        if industries_l and (row.get("industry") or "").lower() not in industries_l:
            # soft match: substring
            if not any(i in (row.get("industry") or "").lower() for i in industries_l):
                continue
        pri = int(row.get("priority") or 5)
        if pri < min_priority:
            continue
        candidates.append(row)

    candidates.sort(key=lambda r: (-int(r.get("priority") or 0), r.get("company") or ""))
    selected = candidates[: max(0, limit)]

    results = []
    for row in selected:
        r = run_prospect_pipeline(
            company=row["company"],
            industry=row.get("industry", ""),
            geo=row.get("geo", ""),
            employee_range=str(row.get("employee_range") or row.get("employees") or ""),
            website=row.get("website", ""),
            notes=row.get("notes", ""),
            signals=row.get("signals") or [],
            contacts=row.get("contacts") or [],
            custom_hook=row.get("custom_hook", ""),
            generate_gamma=generate_gamma_dry,
            dry_run_gamma=True,
            draft_email=draft_email,
            book="corporate",
        )
        results.append({
            "company": row["company"],
            "prospect_id": r.get("prospect_id"),
            "tier": (r.get("score") or {}).get("tier"),
            "score": (r.get("score") or {}).get("score"),
            "package": ((r.get("score") or {}).get("primary_package") or {}).get("name"),
        })

    return {
        "imported": len(results),
        "skipped_existing": len(existing),
        "library_remaining": max(0, len(candidates) - len(selected)),
        "results": results,
        "at": _now(),
    }


def bulk_import_rows(
    rows: list[dict[str, Any]],
    *,
    draft_email: bool = True,
) -> dict[str, Any]:
    """Import arbitrary prospect dicts (CSV/JSON paste)."""
    out = []
    for row in rows:
        company = (row.get("company") or "").strip()
        if not company:
            continue
        signals = row.get("signals") or []
        if isinstance(signals, str):
            signals = [s.strip() for s in signals.split(",") if s.strip()]
        r = run_prospect_pipeline(
            company=company,
            industry=row.get("industry", ""),
            geo=row.get("geo", ""),
            employee_range=str(row.get("employee_range") or row.get("employees") or ""),
            website=row.get("website", ""),
            notes=row.get("notes", ""),
            signals=signals,
            contacts=row.get("contacts") or [],
            custom_hook=row.get("custom_hook", ""),
            generate_gamma=False,
            dry_run_gamma=False,
            draft_email=draft_email,
            book="corporate",
        )
        out.append(r)
    return {"imported": len(out), "results": out}


def build_sequences_for_prospect(prospect_id: str) -> dict[str, Any]:
    """Create cold + follow-up + break-up drafts with A/B subjects."""
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)
    company = p.get("company", "")
    pkgs = p.get("recommended_packages") or []
    primary = pkgs[0] if pkgs else {}
    contact = (p.get("contacts") or [{}])[0]
    variants = subject_variants(
        company=company,
        package_name=primary.get("name") or "The Icebreaker",
    )
    cold = draft_cold_email(
        company=company,
        contact_name=contact.get("name", ""),
        contact_title=contact.get("title", ""),
        package_name=primary.get("name") or "The Icebreaker",
        package_one_liner=primary.get("one_liner", ""),
        custom_hook=p.get("notes") or p.get("agent_note") or "",
        gamma_url=p.get("gamma_url"),
        signals=p.get("signals") or [],
        subject_override=variants[0] if variants else None,
    )
    cold["subject_variants"] = variants
    follow = draft_followup_email(
        company=company,
        contact_name=contact.get("name", ""),
        gamma_url=p.get("gamma_url"),
    )
    brk = draft_breakup_email(
        company=company,
        contact_name=contact.get("name", ""),
    )
    paths = {
        "cold_1": str(save_outreach_draft(
            prospect_id=prospect_id,
            company=company,
            email=cold,
            sequence_step="cold_1",
            contact_email=contact.get("email", ""),
            book="corporate",
        )),
        "follow_2": str(save_outreach_draft(
            prospect_id=prospect_id,
            company=company,
            email=follow,
            sequence_step="follow_2",
            contact_email=contact.get("email", ""),
            book="corporate",
        )),
        "break_3": str(save_outreach_draft(
            prospect_id=prospect_id,
            company=company,
            email=brk,
            sequence_step="break_3",
            contact_email=contact.get("email", ""),
            book="corporate",
        )),
    }
    crm.update_prospect(prospect_id, sequence_paths=paths, stage="drafted")
    return {"prospect_id": prospect_id, "company": company, "paths": paths, "subjects": variants}


def this_week_checklist() -> dict[str, Any]:
    """Derive Mon–Fri desk checklist from live CRM."""
    prospects = crm.list_prospects(book="corporate")
    by_stage: dict[str, list] = {}
    for p in prospects:
        by_stage.setdefault(p.get("stage") or "research", []).append(p)

    tier_ab = [p for p in prospects if p.get("tier") in ("A", "B")]
    need_contact = [
        p for p in tier_ab
        if not any((c.get("email") or c.get("linkedin")) for c in (p.get("contacts") or []))
    ]
    drafted = by_stage.get("drafted") or []
    contacted = by_stage.get("contacted") or []
    interested = (by_stage.get("interested") or []) + (by_stage.get("discovery_booked") or [])
    scored_only = [p for p in tier_ab if p.get("stage") in ("scored", "research", "packaged")]

    tasks = [
        {
            "id": "research",
            "day": "Monday",
            "title": "Expand pipeline (Lead Engine)",
            "target": "Import 25–40 from library or bulk paste",
            "count": len(prospects),
            "action": "import_library",
            "done_hint": len(prospects) >= 40,
        },
        {
            "id": "enrich",
            "day": "Monday–Tue",
            "title": "Enrich A/B contacts",
            "target": "Name + email or LinkedIn on tier A/B",
            "count": len(need_contact),
            "items": [{"id": p["id"], "company": p["company"]} for p in need_contact[:12]],
            "done_hint": len(need_contact) == 0 and len(tier_ab) > 0,
        },
        {
            "id": "decks",
            "day": "Tuesday",
            "title": "Gamma decks for top A-tier",
            "target": "3–5 dry-run or live decks",
            "count": len([p for p in tier_ab if p.get("tier") == "A" and not p.get("gamma_url")]),
            "action": "gamma",
            "done_hint": False,
        },
        {
            "id": "sequences",
            "day": "Tuesday",
            "title": "Build sequences (cold / follow / break)",
            "target": "Sequences for scored A/B without drafts",
            "count": len(scored_only),
            "items": [{"id": p["id"], "company": p["company"], "tier": p.get("tier")} for p in scored_only[:15]],
            "action": "sequences",
            "done_hint": len(scored_only) == 0,
        },
        {
            "id": "approve",
            "day": "Wednesday",
            "title": "Approve & send drafts",
            "target": "8–12 approved sends",
            "count": len(drafted),
            "items": [{"id": p["id"], "company": p["company"]} for p in drafted[:15]],
            "done_hint": len(drafted) == 0,
        },
        {
            "id": "followups",
            "day": "Thursday",
            "title": "Follow-up sequence on contacted",
            "target": "Bump non-replies",
            "count": len(contacted),
            "items": [{"id": p["id"], "company": p["company"]} for p in contacted[:15]],
            "done_hint": False,
        },
        {
            "id": "edyta",
            "day": "Friday",
            "title": "Edyta warm queue",
            "target": "Briefs ready for every interested lead",
            "count": len(interested),
            "items": [
                {
                    "id": p["id"],
                    "company": p["company"],
                    "brief": p.get("edyta_brief_path"),
                    "stage": p.get("stage"),
                }
                for p in interested
            ],
            "done_hint": all(p.get("edyta_brief_path") for p in interested) if interested else True,
        },
    ]

    return {
        "generated_at": _now(),
        "totals": {
            "prospects": len(prospects),
            "tier_ab": len(tier_ab),
            "drafted": len(drafted),
            "interested": len(interested),
        },
        "tasks": tasks,
    }


def edyta_home() -> dict[str, Any]:
    """Talent-facing surface: warm leads + briefs only."""
    leads = crm.interested_leads(book="corporate")
    wedding_leads = []
    try:
        wedding_leads = crm.interested_leads(book="wedding")
    except Exception:
        pass
    return {
        "corporate_leads": leads,
        "wedding_leads": wedding_leads,
        "count": len(leads) + len(wedding_leads),
        "message": (
            "These are the only conversations that should be on your calendar. "
            "Open each brief before the call."
            if (leads or wedding_leads)
            else "No warm leads yet — the desk is still filling the top of funnel."
        ),
    }
