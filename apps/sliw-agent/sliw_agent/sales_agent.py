"""
Corporate Sales Agent — automates desk work the human should not do manually.

For each prospect:
  1. Score / package match (if needed)
  2. Find buyer contacts (Hunter / scrape / role inboxes)
  3. Choose marketing mode:
       - portfolio: point to master package site (default, cheapest)
       - light: short Gamma personalization (few cards) for strong A-tier
       - full: full custom deck only when worth it
  4. Draft outreach sequence with portfolio link always included
  5. Leave stage at drafted for human-or-agent "send" gate
  6. After interested reply → Edyta pipeline + brief

Human approve-before-send remains the default for compliance.
"""

from __future__ import annotations

from typing import Any

from . import crm
from .contact_finder import find_contacts
from .gamma_packages import generate_marketing_package, build_package_prompt, DECKS_DIR, ensure_dirs
from .master_deck import ensure_master_deck, get_master_deck_url
from .outreach import (
    draft_cold_email,
    draft_followup_email,
    draft_breakup_email,
    save_outreach_draft,
    write_edyta_brief,
    qualify_reply,
)
from .scoring import score_prospect
from .talent_bible import TALENT


# Primary public link for outreach
PORTFOLIO_URL = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
CORPORATE_URL = PORTFOLIO_URL


def choose_marketing_mode(
    *,
    tier: str | None,
    score: float | None,
    signals: list[str] | None = None,
    force: str | None = None,
) -> str:
    """portfolio | light | full"""
    if force in ("portfolio", "light", "full"):
        return force
    signals = signals or []
    sig = " ".join(signals).lower()
    sc = score or 0
    # Full deck: elite score + clear big event signal
    if sc >= 85 and any(k in sig for k in ("gala", "holiday", "offsite", "retreat", "leadership")):
        return "full"
    # Light personalization: solid A-tier
    if (tier == "A" and sc >= 75) or sc >= 82:
        return "light"
    # Everyone else: master portfolio pitch (already on Gamma site)
    return "portfolio"


def run_sales_agent(
    prospect_id: str,
    *,
    marketing_mode: str | None = None,
    live_gamma: bool = False,
    build_sequences: bool = False,  # only cold_1 by default — no premature follow/break
    find_people: bool = True,
    ensure_master: bool = True,
) -> dict[str, Any]:
    """Automate contact find + marketing package choice + first-touch draft only."""
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)
    book = p.get("book") or "corporate"
    # Wedding book uses planner/venue partnership agent
    if book == "wedding":
        from .wedding_agent import run_wedding_sales_agent
        return run_wedding_sales_agent(
            prospect_id,
            live_gamma=live_gamma,
            find_people=find_people,
        )
    company = p.get("company") or ""

    # Always use Edyta's published Gamma packages site (not auto-generated decks)
    master_url = get_master_deck_url()
    if ensure_master:
        try:
            meta = ensure_master_deck(live=False)
            master_url = meta.get("gamma_site") or meta.get("gamma_url") or master_url
        except Exception:
            master_url = get_master_deck_url()
    # Never use the old auto-generated gamma.app/docs link
    if "jk6b492p7fvmjhq" in (master_url or ""):
        master_url = TALENT.get("package_site") or "https://edyta-corporate-dance-866y3wq.gamma.site/"

    # 1. Score if missing
    if p.get("score") is None:
        scored = score_prospect(
            company=company,
            industry=p.get("industry", ""),
            geo=p.get("geo", ""),
            employee_range=str(p.get("employee_range") or ""),
            signals=p.get("signals") or [],
            notes=p.get("notes", ""),
            website=p.get("website", ""),
        )
        p = crm.update_prospect(
            prospect_id,
            book=book,
            score=scored["score"],
            tier=scored["tier"],
            recommended_packages=scored["recommended_packages"],
            score_breakdown=scored["breakdown"],
            agent_note=scored["agent_note"],
            stage="scored",
        )

    tier = p.get("tier")
    score = p.get("score") or 0
    pkgs = p.get("recommended_packages") or []
    primary = pkgs[0] if pkgs else {"name": "The Icebreaker", "id": "icebreaker", "one_liner": ""}

    # 2. Find contacts
    contact_result = None
    if find_people:
        contact_result = find_contacts(
            company=company,
            website=p.get("website", ""),
            industry=p.get("industry", ""),
            package_id=primary.get("id") or "",
        )
        found = contact_result.get("contacts") or []
        if found:
            # Prefer Hunter contacts over old role-inbox guesses
            existing = [
                c for c in (p.get("contacts") or [])
                if c.get("source") not in ("role_inbox_guess", "hunter.io_error")
            ]
            by_key = {}
            for c in found + existing:  # found first so Hunter wins
                key = (c.get("email") or c.get("name") or "").lower()
                if key:
                    by_key[key] = {**(by_key.get(key) or {}), **c}
            p = crm.update_prospect(
                prospect_id,
                book=book,
                contacts=list(by_key.values())[:12],
                contact_research=contact_result.get("method_summary"),
                hunter_enabled=contact_result.get("hunter_enabled"),
                hunter_diagnostics=contact_result.get("hunter_diagnostics"),
                linkedin_targets=contact_result.get("linkedin_targets"),
            )
        else:
            crm.update_prospect(
                prospect_id,
                book=book,
                contact_research=contact_result.get("method_summary"),
                hunter_enabled=contact_result.get("hunter_enabled"),
                hunter_diagnostics=contact_result.get("hunter_diagnostics"),
            )

    contacts = p.get("contacts") or []
    primary_contact = next(
        (c for c in contacts if c.get("email") and c.get("source") != "role_inbox_guess"),
        None,
    ) or next((c for c in contacts if c.get("email")), None) or (contacts[0] if contacts else {})

    # 3. Marketing mode
    mode = choose_marketing_mode(
        tier=tier,
        score=float(score),
        signals=p.get("signals") or [],
        force=marketing_mode,
    )
    gamma_url = p.get("gamma_url")
    gamma_meta = None

    if mode == "portfolio":
        gamma_url = PORTFOLIO_URL  # https://edytasliwinska.com/corporate
        crm.update_prospect(
            prospect_id,
            book=book,
            marketing_mode="portfolio",
            gamma_url=gamma_url,
            marketing_note="Official corporate page (edytasliwinska.com/corporate) — no new Gamma credits.",
        )
    elif mode in ("light", "full"):
        # Generate dry-run prompt always; live only if requested
        pkg_ids = [x.get("id") for x in pkgs[: (3 if mode == "portfolio" else 2)] if x.get("id")]
        if mode == "light":
            # Present full portfolio in email + light company-specific deck
            pkg_ids = [primary.get("id") or "icebreaker"]
        try:
            gamma_meta = generate_marketing_package(
                company=company,
                industry=p.get("industry", ""),
                geo=p.get("geo", ""),
                employee_range=str(p.get("employee_range") or ""),
                signals=p.get("signals") or [],
                package_ids=pkg_ids or ["icebreaker"],
                contacts=contacts[:2],
                custom_hook=p.get("notes") or p.get("agent_note") or "",
                notes=(
                    f"Marketing mode: {mode}. "
                    f"Also present the full portfolio at {PORTFOLIO_URL}. "
                    f"Primary package: {primary.get('name')}."
                ),
                prospect_id=prospect_id,
                dry_run=not live_gamma,
                light=(mode == "light"),
            )
            if not gamma_meta.get("dry_run") and gamma_meta.get("gamma_url"):
                # Live custom deck — still keep corporate site as primary public URL in CRM
                gamma_url = gamma_meta["gamma_url"]
            else:
                # Dry-run / no live deck: pitch the official corporate page
                gamma_url = PORTFOLIO_URL
            crm.update_prospect(
                prospect_id,
                book=book,
                marketing_mode=mode,
                gamma_url=gamma_url,
                corporate_url=PORTFOLIO_URL,
                gamma_prompt_path=gamma_meta.get("prompt_path"),
            )
        except Exception as exc:
            gamma_url = PORTFOLIO_URL
            crm.update_prospect(
                prospect_id,
                book=book,
                marketing_mode="portfolio",
                gamma_url=gamma_url,
                marketing_note=f"Gamma fallback to corporate page: {exc}",
            )

    p = crm.get_prospect(prospect_id) or p

    # 4. First-touch draft only (warm human voice)
    # Body link = master deck if ready, else corporate page. Custom Gamma only as extra.
    deck_for_body = master_url
    if mode in ("light", "full") and gamma_url and "gamma.app" in str(gamma_url):
        deck_for_body = gamma_url  # personalized live deck in body
    elif master_url:
        deck_for_body = master_url
    else:
        deck_for_body = PORTFOLIO_URL

    email = draft_cold_email(
        company=company,
        contact_name=primary_contact.get("name") or "",
        contact_title=primary_contact.get("title") or "",
        package_name=primary.get("name") or "The Icebreaker",
        package_one_liner=primary.get("one_liner") or "",
        custom_hook=_human_hook(company, p.get("notes") or "", p.get("signals") or []),
        gamma_url=deck_for_body,
        signals=p.get("signals") or [],
        master_deck_url=deck_for_body,
    )
    email["to_email"] = primary_contact.get("email") or ""
    email["marketing_mode"] = mode
    email["pitch_url"] = deck_for_body

    path = save_outreach_draft(
        prospect_id=prospect_id,
        company=company,
        email=email,
        sequence_step="cold_1",
        contact_email=primary_contact.get("email") or "",
        book=book,
    )

    seq_paths = {"cold_1": str(path)}
    # follow_2 / break_3 are NOT pre-created — only after cold is marked contacted
    if build_sequences:
        # explicit opt-in only (not default)
        follow = draft_followup_email(
            company=company,
            contact_name=primary_contact.get("name") or "",
            master_deck_url=deck_for_body,
        )
        seq_paths["follow_2"] = str(save_outreach_draft(
            prospect_id=prospect_id, company=company, email=follow,
            sequence_step="follow_2", contact_email=primary_contact.get("email") or "", book=book,
        ))

    p = crm.update_prospect(
        prospect_id,
        book=book,
        sequence_paths=seq_paths,
        stage="drafted",
        agent_status="ready_to_send",
        master_deck_url=deck_for_body,
        sales_agent_ran_at=__import__("datetime").datetime.utcnow().isoformat(),
    )

    return {
        "prospect_id": prospect_id,
        "company": company,
        "tier": tier,
        "score": score,
        "marketing_mode": mode,
        "pitch_url": deck_for_body,
        "portfolio_url": PORTFOLIO_URL,
        "master_deck_url": deck_for_body,
        "contacts": contacts[:5],
        "primary_contact": primary_contact,
        "contact_research": contact_result.get("method_summary") if contact_result else None,
        "hunter_enabled": (contact_result or {}).get("hunter_enabled"),
        "hunter_diagnostics": (contact_result or {}).get("hunter_diagnostics") or p.get("hunter_diagnostics"),
        "linkedin_targets": (contact_result or {}).get("linkedin_targets") or p.get("linkedin_targets"),
        "outreach_path": str(path),
        "sequence_paths": seq_paths,
        "email_preview": email,
        "gamma": gamma_meta,
        "next_human_step": (
            "Copy the first-touch email, send from Gmail, then mark contacted. "
            "Only then create a follow-up. Never send a 'closing the loop' note as first touch."
        ),
        "prospect": p,
    }


def _human_hook(company: str, notes: str, signals: list[str]) -> str:
    """One short human opening — not a slogan dump."""
    notes = (notes or "").strip()
    if notes and len(notes) < 180 and "Priority" not in notes and "tier" not in notes.lower():
        return notes
    if signals:
        return (
            f"I was looking at companies that might want something fresher than the usual "
            f"offsite icebreaker — {company} stood out ({signals[0]})."
        )
    return (
        f"I put together a short list of companies that might enjoy a different kind of "
        f"team gathering, and {company} made that list."
    )


def prepare_followup(prospect_id: str) -> dict[str, Any]:
    """Create follow_2 only after cold was sent (stage contacted+)."""
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)
    stage = p.get("stage") or ""
    if stage not in ("contacted", "replied", "nurture"):
        raise ValueError(
            f"Follow-up only after cold is sent (stage is '{stage}'). Mark contacted first."
        )
    contact = (p.get("contacts") or [{}])[0]
    deck = p.get("master_deck_url") or p.get("gamma_url") or get_master_deck_url()
    email = draft_followup_email(
        company=p.get("company") or "",
        contact_name=contact.get("name") or "",
        master_deck_url=deck,
    )
    path = save_outreach_draft(
        prospect_id=prospect_id,
        company=p.get("company") or "",
        email=email,
        sequence_step="follow_2",
        contact_email=contact.get("email") or "",
        book=p.get("book") or "corporate",
    )
    return {"outreach_path": str(path), "email_preview": email, "sequence_step": "follow_2"}


def run_sales_agent_batch(
    prospect_ids: list[str] | None = None,
    *,
    limit: int = 5,
    live_gamma: bool = False,
) -> dict[str, Any]:
    """Run sales agent on top A/B prospects missing drafts/contacts."""
    from .lead_engine import top_ready_to_contact

    if not prospect_ids:
        ready = top_ready_to_contact(limit=limit * 2)
        # Prefer those without good contacts or drafts
        prospect_ids = []
        for r in ready:
            p = crm.get_prospect(r["id"])
            if not p:
                continue
            contacts = p.get("contacts") or []
            has_personal = any(
                c.get("email") and c.get("source") != "role_inbox_guess"
                for c in contacts
            )
            if p.get("stage") in ("scored", "research", "packaged") or not has_personal or not p.get("outreach_path"):
                prospect_ids.append(r["id"])
            if len(prospect_ids) >= limit:
                break
        if not prospect_ids:
            prospect_ids = [r["id"] for r in ready[:limit]]

    results = []
    errors = []
    for pid in prospect_ids:
        try:
            results.append(run_sales_agent(pid, live_gamma=live_gamma))
        except Exception as exc:
            errors.append({"prospect_id": pid, "error": str(exc)})
    return {
        "ran": len(results),
        "errors": errors,
        "results": results,
    }


def escalate_to_edyta(
    prospect_id: str,
    *,
    reply_text: str = "",
    reply_summary: str = "",
) -> dict[str, Any]:
    """When interest is clear — qualify and put on Edyta's pipeline with brief."""
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)
    book = p.get("book") or "corporate"
    text = reply_text or reply_summary or p.get("reply_summary") or "Interested — requested discovery call."
    q = qualify_reply(reply_text=text, company=p.get("company", ""))
    # Force interested if agent is escalating
    if not q.get("ready_for_edyta") and reply_text:
        # keep qualify result
        pass
    else:
        q["ready_for_edyta"] = True
        q["recommended_stage"] = "interested"
        q["label"] = q.get("label") or "agent_escalation"

    crm.set_stage(prospect_id, "interested", note=q.get("label") or "edyta_ready", book=book)
    crm.update_prospect(
        prospect_id,
        book=book,
        reply_summary=(reply_summary or reply_text or text)[:800],
        qualification=q,
        agent_status="edyta_pipeline",
    )
    p = crm.get_prospect(prospect_id) or p
    brief = write_edyta_brief(
        prospect=p,
        reply_summary=reply_summary or reply_text or text,
        book=book,
    )
    return {
        "prospect_id": prospect_id,
        "stage": "interested",
        "edyta_brief_path": str(brief),
        "qualification": q,
        "prospect": crm.get_prospect(prospect_id),
    }
