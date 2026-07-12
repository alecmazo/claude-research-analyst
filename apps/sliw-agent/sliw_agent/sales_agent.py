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
from .outreach import (
    draft_cold_email,
    draft_followup_email,
    draft_breakup_email,
    save_outreach_draft,
    subject_variants,
    write_edyta_brief,
    qualify_reply,
)
from .scoring import score_prospect
from .talent_bible import TALENT, PACKAGES


# Primary public link for outreach (official site — not the Gamma deck URL)
PORTFOLIO_URL = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
CORPORATE_URL = PORTFOLIO_URL
# Optional deeper package deck (only used when we generate a custom Gamma link)
PACKAGE_DECK_URL = TALENT.get("package_site") or ""


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
    build_sequences: bool = True,
    find_people: bool = True,
) -> dict[str, Any]:
    """Automate contact find + marketing package choice + outreach drafts."""
    p = crm.get_prospect(prospect_id)
    if not p:
        raise KeyError(prospect_id)
    book = p.get("book") or "corporate"
    company = p.get("company") or ""

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
            # Merge with any existing
            existing = p.get("contacts") or []
            by_key = {}
            for c in existing + found:
                key = (c.get("email") or c.get("name") or "").lower()
                if key:
                    by_key[key] = {**(by_key.get(key) or {}), **c}
            p = crm.update_prospect(
                prospect_id,
                book=book,
                contacts=list(by_key.values())[:12],
                contact_research=contact_result.get("method_summary"),
                linkedin_targets=contact_result.get("linkedin_targets"),
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

    # 4. Draft outreach (portfolio link always in body)
    pitch_url = gamma_url or PORTFOLIO_URL
    email = draft_agent_pitch(
        company=company,
        contact=primary_contact,
        package_name=primary.get("name") or "The Icebreaker",
        package_one_liner=primary.get("one_liner") or "",
        all_packages=pkgs[:5],
        custom_hook=p.get("notes") or p.get("agent_note") or "",
        signals=p.get("signals") or [],
        pitch_url=pitch_url,
        marketing_mode=mode,
    )
    path = save_outreach_draft(
        prospect_id=prospect_id,
        company=company,
        email=email,
        sequence_step="cold_1",
        contact_email=primary_contact.get("email") or "",
        book=book,
    )

    seq_paths = {"cold_1": str(path)}
    if build_sequences:
        follow = draft_followup_email(
            company=company,
            contact_name=primary_contact.get("name") or "",
            gamma_url=pitch_url,
        )
        brk = draft_breakup_email(
            company=company,
            contact_name=primary_contact.get("name") or "",
        )
        seq_paths["follow_2"] = str(save_outreach_draft(
            prospect_id=prospect_id, company=company, email=follow,
            sequence_step="follow_2", contact_email=primary_contact.get("email") or "", book=book,
        ))
        seq_paths["break_3"] = str(save_outreach_draft(
            prospect_id=prospect_id, company=company, email=brk,
            sequence_step="break_3", contact_email=primary_contact.get("email") or "", book=book,
        ))

    p = crm.update_prospect(
        prospect_id,
        book=book,
        sequence_paths=seq_paths,
        stage="drafted",
        agent_status="ready_to_send",
        sales_agent_ran_at=__import__("datetime").datetime.utcnow().isoformat(),
    )

    return {
        "prospect_id": prospect_id,
        "company": company,
        "tier": tier,
        "score": score,
        "marketing_mode": mode,
        "pitch_url": pitch_url,
        "portfolio_url": PORTFOLIO_URL,
        "contacts": contacts[:5],
        "primary_contact": primary_contact,
        "contact_research": contact_result.get("method_summary") if contact_result else None,
        "linkedin_targets": (contact_result or {}).get("linkedin_targets") or p.get("linkedin_targets"),
        "outreach_path": str(path),
        "sequence_paths": seq_paths,
        "email_preview": email,
        "gamma": gamma_meta,
        "next_human_step": (
            "Review draft, send from Gmail to primary contact (or LinkedIn if no email), "
            "then mark contacted. When they reply, qualify → Edyta pipeline."
        ),
        "prospect": p,
    }


def draft_agent_pitch(
    *,
    company: str,
    contact: dict[str, Any],
    package_name: str,
    package_one_liner: str,
    all_packages: list[dict[str, Any]],
    custom_hook: str,
    signals: list[str],
    pitch_url: str,
    marketing_mode: str,
) -> dict[str, str]:
    """Sales pitch email — portfolio-first, package-led."""
    name = (contact.get("name") or "").strip()
    first = name.split()[0] if name and not name.lower().startswith(("people", "events", "hr ", "culture")) else ""
    greeting = f"Hi {first}," if first else "Hi there,"

    hook = (custom_hook or "").strip().rstrip(".")
    if not hook:
        hook = (
            f"teams at {company} that care about culture still often settle for "
            "icebreakers nobody remembers by Friday"
        )
    else:
        hook = hook[0].lower() + hook[1:] if len(hook) > 1 else hook

    signal_bit = ""
    if signals:
        signal_bit = f" I noticed momentum around {signals[0]} — that's when a shared, high-energy experience lands hardest."

    # Portfolio menu (short)
    menu = ""
    if all_packages and marketing_mode in ("portfolio", "light", "full"):
        lines = []
        for pkg in all_packages[:5]:
            n = pkg.get("name") or ""
            if n:
                lines.append(f"  · {n}")
        if lines:
            menu = "\n\nExperiences teams book most:\n" + "\n".join(lines) + "\n"

    email_line = contact.get("email") or ""
    conf = contact.get("confidence")
    conf_note = ""
    if contact.get("source") == "role_inbox_guess":
        conf_note = (
            "\n\n(If this isn't the right inbox, happy to be pointed to your People / Events lead.)"
        )

    subject = subject_variants(company=company, package_name=package_name)[0]
    body = f"""{greeting}

I'm reaching out on behalf of Edyta Śliwińska — Dancing with the Stars professional and producer of corporate team experiences — because {hook}.{signal_bit}

Rather than another trust-fall module, Edyta runs DWTS-caliber sessions that actually bond teams: zero judgment, 5–500 people, lunch hour through full gala.

**Recommended for {company}:** {package_name}
{package_one_liner}
{menu}
Corporate experiences & packages:
{PORTFOLIO_URL}
{"Custom proposal deck: " + pitch_url if pitch_url and pitch_url.rstrip("/") != PORTFOLIO_URL.rstrip("/") else ""}
{conf_note}

Would you (or the right person on People / Events / L&D) take a complimentary 15-minute discovery call with Edyta?

Warmly,
Sliw Agent desk — for Edyta Śliwińska
{TALENT['email_public']} · {TALENT['phone_primary']}
{CORPORATE_URL}
"""
    return {
        "subject": subject,
        "body": body.strip() + "\n",
        "to_name": contact.get("name") or "",
        "to_title": contact.get("title") or "",
        "to_email": email_line,
        "subject_variants": subject_variants(company=company, package_name=package_name),
        "marketing_mode": marketing_mode,
        "pitch_url": pitch_url,
    }


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
