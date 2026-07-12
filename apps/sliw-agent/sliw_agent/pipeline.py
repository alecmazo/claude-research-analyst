"""
End-to-end Sliw Agent pipeline for one prospect.

  research → score → package (Gamma) → draft outreach → [human approve/send]
  → qualify reply → Edyta brief (if interested)
"""

from __future__ import annotations

from typing import Any

from . import crm
from .gamma_packages import generate_marketing_package
from .outreach import (
    draft_cold_email,
    qualify_reply,
    save_outreach_draft,
    write_edyta_brief,
)
from .scoring import score_prospect


def run_prospect_pipeline(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    employee_range: str = "",
    website: str = "",
    notes: str = "",
    signals: list[str] | None = None,
    contacts: list[dict[str, str]] | None = None,
    custom_hook: str = "",
    generate_gamma: bool = False,
    dry_run_gamma: bool = True,
    draft_email: bool = True,
    book: str = "corporate",
) -> dict[str, Any]:
    """
    Full desk workflow for a single corporation.

    By default Gamma is dry-run (writes prompt only) so we don't burn credits
    until you pass generate_gamma=True and dry_run_gamma=False.
    """
    signals = signals or []
    contacts = contacts or []

    # 1. CRM upsert
    prospect = crm.upsert_prospect(
        company=company,
        industry=industry,
        geo=geo,
        employee_range=employee_range,
        website=website,
        notes=notes,
        signals=signals,
        contacts=contacts,
        book=book,
    )
    pid = prospect["id"]

    # 2. Score + package recommend
    scored = score_prospect(
        company=company,
        industry=industry,
        geo=geo,
        employee_range=employee_range,
        signals=signals,
        notes=notes,
        website=website,
    )
    pkg_ids = [p["id"] for p in scored["recommended_packages"][:2]]
    prospect = crm.update_prospect(
        pid,
        book=book,
        score=scored["score"],
        tier=scored["tier"],
        recommended_packages=scored["recommended_packages"],
        score_breakdown=scored["breakdown"],
        agent_note=scored["agent_note"],
        stage="scored",
    )

    result: dict[str, Any] = {
        "prospect_id": pid,
        "company": company,
        "score": scored,
        "gamma": None,
        "outreach_path": None,
        "edyta_brief_path": None,
    }

    # 3. Skip low-tier auto packaging unless forced
    if scored["tier"] in ("D",) and not generate_gamma:
        result["skipped"] = "tier D — nurture only; no deck/email auto-built"
        crm.set_stage(pid, "nurture", note="Auto-nurture: low ICP score", book=book)
        return result

    # 4. Gamma marketing package
    if generate_gamma or dry_run_gamma:
        gamma = generate_marketing_package(
            company=company,
            industry=industry,
            geo=geo,
            employee_range=employee_range,
            signals=signals or scored.get("matched_signals"),
            package_ids=pkg_ids,
            contacts=contacts,
            custom_hook=custom_hook or notes,
            notes=notes,
            prospect_id=pid,
            dry_run=dry_run_gamma or not generate_gamma,
        )
        result["gamma"] = gamma
        if not gamma.get("dry_run"):
            crm.set_stage(pid, "packaged", note="Gamma deck generated", book=book)

    # 5. Outreach draft
    if draft_email:
        primary = scored["primary_package"] or {}
        contact = contacts[0] if contacts else {}
        email = draft_cold_email(
            company=company,
            contact_name=contact.get("name", ""),
            contact_title=contact.get("title", ""),
            package_name=primary.get("name", "The Icebreaker"),
            package_one_liner=primary.get("one_liner", ""),
            custom_hook=custom_hook or notes,
            gamma_url=(result.get("gamma") or {}).get("gamma_url"),
            signals=scored.get("matched_signals") or signals,
        )
        path = save_outreach_draft(
            prospect_id=pid,
            company=company,
            email=email,
            contact_email=contact.get("email", ""),
            book=book,
        )
        result["outreach_path"] = str(path)

    result["book"] = book
    return result


def mark_interested(
    prospect_id: str,
    *,
    reply_text: str = "",
    reply_summary: str = "",
    book: str | None = None,
) -> dict[str, Any]:
    """Qualify a reply and, if warm, write Edyta's call brief."""
    prospect = crm.get_prospect(prospect_id, book=book)
    if not prospect:
        raise KeyError(prospect_id)
    book = prospect.get("book") or book or "corporate"

    qualification = qualify_reply(
        reply_text=reply_text or reply_summary,
        company=prospect.get("company", ""),
    )
    stage = qualification["recommended_stage"]
    crm.set_stage(prospect_id, stage, note=qualification["label"], book=book)
    crm.update_prospect(
        prospect_id,
        book=book,
        reply_summary=reply_summary or reply_text[:500],
        qualification=qualification,
    )

    brief_path = None
    if qualification["ready_for_edyta"]:
        prospect = crm.get_prospect(prospect_id, book=book) or prospect
        brief_path = write_edyta_brief(
            prospect=prospect,
            reply_summary=reply_summary or reply_text,
            book=book,
        )
        crm.set_stage(prospect_id, "interested", note="Edyta brief ready", book=book)

    return {
        "prospect_id": prospect_id,
        "qualification": qualification,
        "edyta_brief_path": str(brief_path) if brief_path else None,
        "prospect": crm.get_prospect(prospect_id, book=book),
    }


def batch_score_seed(seed_path: str | None = None) -> list[dict[str, Any]]:
    """Load seed prospects JSON and run score-only (no Gamma spend)."""
    import json
    from pathlib import Path

    path = Path(seed_path) if seed_path else (
        Path(__file__).resolve().parent.parent / "data" / "seed_prospects.json"
    )
    if not path.exists():
        raise FileNotFoundError(path)
    rows = json.loads(path.read_text(encoding="utf-8"))
    results = []
    for row in rows:
        r = run_prospect_pipeline(
            company=row["company"],
            industry=row.get("industry", ""),
            geo=row.get("geo", ""),
            employee_range=row.get("employee_range", ""),
            website=row.get("website", ""),
            notes=row.get("notes", ""),
            signals=row.get("signals") or [],
            contacts=row.get("contacts") or [],
            custom_hook=row.get("custom_hook", ""),
            generate_gamma=False,
            dry_run_gamma=False,  # skip gamma entirely in batch score
            draft_email=False,
            book="corporate",
        )
        # dry_run_gamma False + generate_gamma False skips gamma block partially —
        # fix: we still want score. Pipeline with both false skips gamma. Good.
        results.append(r)
    return results
