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
    existing = {p.get("company", "").lower() for p in crm.list_prospects(book="corporate")}
    pending = sum(1 for r in lib if (r.get("company") or "").lower() not in existing)
    return {
        "total": len(lib),
        "in_crm": len(lib) - pending,
        "pending_import": pending,
        "by_industry": by_industry,
        "by_geo_top": dict(sorted(by_geo.items(), key=lambda x: -x[1])[:15]),
        "path": str(LIBRARY_PATH),
    }


def list_library_with_status() -> list[dict[str, Any]]:
    """Full library with live ICP score + CRM status (qualified view)."""
    lib = load_library()
    crm_by_name = {
        (p.get("company") or "").lower(): p
        for p in crm.list_prospects(book="corporate")
    }
    out = []
    for row in lib:
        name = row.get("company") or ""
        key = name.lower()
        in_crm = crm_by_name.get(key)
        scored = score_prospect(
            company=name,
            industry=row.get("industry", ""),
            geo=row.get("geo", ""),
            employee_range=str(row.get("employee_range") or row.get("employees") or ""),
            signals=row.get("signals") or [],
            notes=row.get("notes", ""),
            website=row.get("website", ""),
        )
        out.append({
            **row,
            "qualification": {
                "score": scored["score"],
                "tier": scored["tier"],
                "primary_package": (scored.get("primary_package") or {}).get("name"),
                "matched_signals": scored.get("matched_signals") or [],
                "agent_note": scored.get("agent_note"),
                "breakdown": scored.get("breakdown"),
            },
            "in_crm": bool(in_crm),
            "prospect_id": in_crm.get("id") if in_crm else None,
            "crm_stage": in_crm.get("stage") if in_crm else None,
            "crm_score": in_crm.get("score") if in_crm else None,
        })
    out.sort(
        key=lambda r: (
            -(r.get("qualification") or {}).get("score") or 0,
            -(int(r.get("priority") or 0)),
            r.get("company") or "",
        )
    )
    return out


def import_all_pending(*, draft_email: bool = False) -> dict[str, Any]:
    """Import every library row not yet in CRM (no artificial batch limit)."""
    return import_from_library(
        limit=10_000,
        min_priority=0,
        draft_email=draft_email,
        generate_gamma_dry=False,
    )


def append_to_library(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Add new company rows to the persistent library (dedupe by company name)."""
    lib = load_library()
    existing = {(r.get("company") or "").lower() for r in lib}
    added = 0
    for row in rows:
        name = (row.get("company") or "").strip()
        if not name or name.lower() in existing:
            continue
        lib.append(row)
        existing.add(name.lower())
        added += 1
    if added:
        LIBRARY_PATH.parent.mkdir(parents=True, exist_ok=True)
        LIBRARY_PATH.write_text(json.dumps(lib, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"added": added, "total": len(lib)}


# Extra discovery pack — used by "Refresh leads" agent to grow the library
_DISCOVERY_PACK: list[dict[str, Any]] = [
    {"company": "Coinbase", "industry": "Financial services / fintech", "geo": "San Francisco, CA", "employee_range": "4000", "website": "https://www.coinbase.com", "signals": ["engineering culture", "offsite", "employee engagement"], "notes": "Crypto exchange — eng culture + offsights", "priority": 7},
    {"company": "Robinhood", "industry": "Financial services / fintech", "geo": "Menlo Park, CA", "employee_range": "2500", "website": "https://robinhood.com", "signals": ["engineering culture", "all-hands"], "notes": "Consumer fintech eng culture", "priority": 6},
    {"company": "Affirm", "industry": "Financial services / fintech", "geo": "San Francisco, CA", "employee_range": "2500", "website": "https://www.affirm.com", "signals": ["employee experience", "culture"], "notes": "Fintech culture programs", "priority": 6},
    {"company": "Discord", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "600", "website": "https://discord.com", "signals": ["engineering culture", "employee engagement"], "notes": "Community product → team community moment", "priority": 7},
    {"company": "Notion", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "500", "website": "https://www.notion.so", "signals": ["culture", "offsite", "employee experience"], "notes": "Productivity culture brand", "priority": 7},
    {"company": "Figma", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "1000", "website": "https://www.figma.com", "signals": ["creative culture", "employee experience"], "notes": "Design culture experiential fit", "priority": 8},
    {"company": "Airtable", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "800", "website": "https://www.airtable.com", "signals": ["employee experience", "offsite"], "notes": "SF SaaS culture", "priority": 6},
    {"company": "Flexport", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "2000", "website": "https://www.flexport.com", "signals": ["engineering culture", "all-hands"], "notes": "Logistics tech culture", "priority": 5},
    {"company": "Samsara", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "2000", "website": "https://www.samsara.com", "signals": ["engineering culture", "employee engagement"], "notes": "IoT growth culture", "priority": 6},
    {"company": "C3.ai", "industry": "Technology / SaaS / AI", "geo": "Redwood City, CA", "employee_range": "1000", "website": "https://c3.ai", "signals": ["enterprise", "leadership development"], "notes": "Enterprise AI leadership labs", "priority": 5},
    {"company": "UiPath", "industry": "Technology / SaaS / AI", "geo": "Bay Area / NY", "employee_range": "4000", "website": "https://www.uipath.com", "signals": ["employee experience", "offsite"], "notes": "Automation software culture", "priority": 5},
    {"company": "DocuSign", "industry": "Technology / SaaS / AI", "geo": "San Francisco, CA", "employee_range": "7000", "website": "https://www.docusign.com", "signals": ["employee experience", "holiday party"], "notes": "SF enterprise SaaS events", "priority": 6},
    {"company": "Workday", "industry": "Technology / SaaS / AI", "geo": "Pleasanton, CA", "employee_range": "18000", "website": "https://www.workday.com", "signals": ["employee experience", "wellness", "leadership development"], "notes": "HR platform — people-first pitch", "priority": 8},
    {"company": "Intuit", "industry": "Technology / SaaS / AI", "geo": "Mountain View, CA", "employee_range": "17000", "website": "https://www.intuit.com", "signals": ["employee experience", "wellness", "leadership development"], "notes": "Peninsula campus culture", "priority": 7},
    {"company": "Electronic Arts", "industry": "Media / entertainment", "geo": "Redwood City, CA", "employee_range": "13000", "website": "https://www.ea.com", "signals": ["creative culture", "employee engagement", "holiday party"], "notes": "Gaming studio culture energy", "priority": 7},
    {"company": "Zynga", "industry": "Media / entertainment", "geo": "San Francisco, CA", "employee_range": "2000", "website": "https://www.zynga.com", "signals": ["creative culture", "holiday party"], "notes": "SF gaming culture", "priority": 5},
    {"company": "Pixar", "industry": "Media / entertainment", "geo": "Emeryville, CA", "employee_range": "1200", "website": "https://www.pixar.com", "signals": ["creative culture", "employee engagement"], "notes": "East Bay creative campus", "priority": 7},
    {"company": "Lucasfilm", "industry": "Media / entertainment", "geo": "San Francisco, CA", "employee_range": "2000", "website": "https://www.lucasfilm.com", "signals": ["creative culture", "gala"], "notes": "SF entertainment prestige", "priority": 6},
    {"company": "Salesforce.org / Nonprofit Cloud teams", "industry": "Nonprofits & foundations running galas", "geo": "San Francisco, CA", "employee_range": "500", "website": "https://www.salesforce.com", "signals": ["gala", "nonprofit", "employee engagement"], "notes": "Nonprofit-adjacent culture events", "priority": 5},
    {"company": "Morrison Foerster", "industry": "Professional services (law, consulting)", "geo": "San Francisco, CA", "employee_range": "1000", "website": "https://www.mofo.com", "signals": ["holiday party", "associate wellness"], "notes": "Biglaw holiday + wellness", "priority": 7},
    {"company": "Orrick", "industry": "Professional services (law, consulting)", "geo": "San Francisco, CA", "employee_range": "1000", "website": "https://www.orrick.com", "signals": ["holiday party", "professional services culture"], "notes": "SF law firm events", "priority": 6},
    {"company": "Latham & Watkins SF", "industry": "Professional services (law, consulting)", "geo": "San Francisco, CA", "employee_range": "500", "website": "https://www.lw.com", "signals": ["holiday party", "associate wellness"], "notes": "Premium biglaw events", "priority": 6},
    {"company": "Accenture Bay Area", "industry": "Professional services (law, consulting)", "geo": "San Francisco / San Jose", "employee_range": "5000", "website": "https://www.accenture.com", "signals": ["leadership development", "employee engagement"], "notes": "Consulting L&D scale", "priority": 6},
    {"company": "PG&E", "industry": "Healthcare systems & health-tech", "geo": "Oakland, CA", "employee_range": "20000", "website": "https://www.pge.com", "signals": ["employee engagement", "wellness", "leadership development"], "notes": "Large East Bay employer wellness", "priority": 5},
    {"company": "Clorox", "industry": "Consumer brands with strong culture teams", "geo": "Oakland, CA", "employee_range": "8000", "website": "https://www.thecloroxcompany.com", "signals": ["employee experience", "culture"], "notes": "East Bay consumer brand culture", "priority": 5},
]


def refresh_leads_agent(*, auto_import: bool = True, draft_email: bool = False) -> dict[str, Any]:
    """
    Discovery pass: expand library with new suitable companies, re-qualify,
    and immediately import anything not yet in CRM.
    """
    discovery = append_to_library([
        {**row, "custom_hook": row.get("notes", ""), "contacts": []}
        for row in _DISCOVERY_PACK
    ])
    imported = {"imported": 0, "results": []}
    if auto_import:
        imported = import_all_pending(draft_email=draft_email)
    lib_view = list_library_with_status()
    tier_a = [r for r in lib_view if (r.get("qualification") or {}).get("tier") == "A"]
    return {
        "discovery_added": discovery.get("added", 0),
        "library_total": discovery.get("total", 0),
        "imported_to_crm": imported.get("imported", 0),
        "import_detail": imported,
        "qualified_tier_a": len(tier_a),
        "qualified_total": len(lib_view),
        "top_new": [
            {
                "company": r["company"],
                "tier": r["qualification"]["tier"],
                "score": r["qualification"]["score"],
                "package": r["qualification"].get("primary_package"),
                "in_crm": r["in_crm"],
                "prospect_id": r.get("prospect_id"),
            }
            for r in lib_view[:15]
        ],
        "at": _now(),
    }


def workstream_for_prospect(prospect_id: str) -> dict[str, Any]:
    """
    Free-flow step model for ONE client (not day-of-week).

    Steps advance based on CRM fields — operator does next action now.
    """
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)

    contacts = p.get("contacts") or []
    has_contact = any((c.get("email") or c.get("linkedin") or c.get("name")) for c in contacts)
    has_draft = bool(p.get("outreach_path") or p.get("sequence_paths") or p.get("agent_status") == "ready_to_send")
    has_gamma = bool(p.get("gamma_url") or p.get("gamma_pptx") or p.get("marketing_mode"))
    stage = p.get("stage") or "research"
    agent_ran = bool(p.get("sales_agent_ran_at") or p.get("agent_status"))

    steps = [
        {
            "id": "qualify",
            "title": "Qualified",
            "done": p.get("score") is not None,
            "detail": f"Score {p.get('score')} · tier {p.get('tier')} · {(p.get('recommended_packages') or [{}])[0].get('name', '—')}",
        },
        {
            "id": "agent",
            "title": "Sales agent run",
            "done": agent_ran and has_contact and has_draft,
            "detail": "Agent finds buyers, picks portfolio/light/full pitch, drafts outreach",
        },
        {
            "id": "send",
            "title": "Send outreach",
            "done": stage in ("contacted", "replied", "interested", "discovery_booked", "won"),
            "detail": "Copy draft → send from Gmail → mark contacted (agent does not auto-send)",
        },
        {
            "id": "reply",
            "title": "Qualify reply",
            "done": stage in ("interested", "discovery_booked", "won", "nurture", "lost"),
            "detail": "Paste reply — warm leads go to Edyta automatically",
        },
        {
            "id": "edyta",
            "title": "Edyta pipeline",
            "done": bool(p.get("edyta_brief_path")) or stage in ("discovery_booked", "won") or p.get("agent_status") == "edyta_pipeline",
            "detail": "Brief ready — Edyta takes the discovery call",
        },
    ]

    next_step = next((s for s in steps if not s["done"]), None)
    if not next_step:
        next_step = {"id": "done", "title": "Complete / nurture", "done": True, "detail": "Pipeline finished for this lead"}

    actions = []
    nid = next_step["id"]
    if nid == "agent" or nid == "qualify":
        actions = [
            {"id": "run_sales_agent", "label": "▶ Run sales agent (find contacts + pitch + draft)", "type": "button"},
            {"id": "run_sales_agent_live_gamma", "label": "Run agent + live Gamma (credits)", "type": "button"},
        ]
    elif nid == "send":
        actions = [
            {"id": "copy_cold", "label": "Copy first-touch email", "type": "button"},
            {"id": "mark_contacted", "label": "I sent it — mark contacted", "type": "button"},
            {"id": "run_sales_agent", "label": "Re-run sales agent", "type": "button"},
        ]
        # follow-up only after contacted — shown on reply step too
    elif nid == "reply":
        actions = [
            {"id": "copy_cold", "label": "Copy first-touch (resend)", "type": "button"},
            {"id": "prepare_followup", "label": "Create follow-up email", "type": "button"},
            {"id": "qualify_reply", "label": "Qualify reply → Edyta if warm", "type": "form_reply"},
            {"id": "escalate_edyta", "label": "Force to Edyta pipeline", "type": "button"},
        ]
    elif nid == "edyta":
        actions = [
            {"id": "open_brief", "label": "View Edyta brief", "type": "button"},
            {"id": "escalate_edyta", "label": "Refresh Edyta brief", "type": "button"},
        ]

    # Primary contact for UI (name + email always surfaceable)
    primary = next(
        (c for c in contacts if c.get("email") and c.get("source") not in ("role_inbox_guess", "hunter.io_error")),
        None,
    ) or next((c for c in contacts if c.get("email")), None) or (contacts[0] if contacts else {})

    return {
        "prospect": p,
        "primary_contact": primary,
        "contacts": contacts[:8],
        "steps": steps,
        "next_step": next_step,
        "actions": actions,
        "progress": {
            "done": sum(1 for s in steps if s["done"]),
            "total": len(steps),
            "pct": round(100 * sum(1 for s in steps if s["done"]) / max(1, len(steps))),
        },
        "ready_to_contact_now": bool(
            p.get("tier") in ("A", "B") and has_draft and stage in ("drafted", "approved", "scored", "packaged")
        ),
    }


def top_ready_to_contact(limit: int = 5) -> list[dict[str, Any]]:
    """Highest-score prospects the desk can work right now."""
    prospects = crm.list_prospects(book="corporate")
    ranked = [
        p for p in prospects
        if p.get("tier") in ("A", "B")
        and p.get("stage") not in ("won", "lost", "interested", "discovery_booked")
    ]
    ranked.sort(key=lambda p: (-(p.get("score") or 0), p.get("company") or ""))
    out = []
    for p in ranked[:limit]:
        try:
            ws = workstream_for_prospect(p["id"])
        except Exception:
            ws = None
        out.append({
            "id": p["id"],
            "company": p.get("company"),
            "website": p.get("website") or "",
            "score": p.get("score"),
            "tier": p.get("tier"),
            "stage": p.get("stage"),
            "package": (p.get("recommended_packages") or [{}])[0].get("name"),
            "next_step": (ws or {}).get("next_step"),
            "progress": (ws or {}).get("progress"),
        })
    return out


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
    """Create first-touch cold draft only (follow-up is a separate step after send)."""
    from .sales_agent import run_sales_agent
    result = run_sales_agent(prospect_id, build_sequences=False, live_gamma=False)
    return {
        "prospect_id": prospect_id,
        "company": result.get("company"),
        "paths": result.get("sequence_paths"),
        "email_preview": result.get("email_preview"),
        "note": "Only cold_1 created. Follow-up after mark contacted.",
    }


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
