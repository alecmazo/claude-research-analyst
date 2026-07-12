"""
Outreach drafting & Edyta call-brief generation.

CRITICAL: drafts only. Never auto-sends. Human approval required.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .crm import BRIEFS_DIR, OUTREACH_DIR, ensure_dirs, update_prospect
from .talent_bible import TALENT


def subject_variants(*, company: str, package_name: str = "The Icebreaker") -> list[str]:
    """A/B subject lines for corporate cold outreach."""
    return [
        f"{company} × Edyta Śliwińska (DWTS) — team experience worth remembering",
        f"A better all-hands moment for {company} (DWTS pro)",
        f"{package_name} for {company} — 15 minutes with Edyta?",
        f"Not another trust fall — {company} × Edyta Śliwińska",
    ]


def draft_cold_email(
    *,
    company: str,
    contact_name: str = "",
    contact_title: str = "",
    package_name: str = "The Icebreaker",
    package_one_liner: str = "",
    custom_hook: str = "",
    gamma_url: str | None = None,
    signals: list[str] | None = None,
    subject_override: str | None = None,
) -> dict[str, str]:
    """Return subject + body for a short, premium cold email."""
    first = (contact_name or "there").split()[0]
    if first.lower() in ("there", "team", "hi"):
        greeting = "Hi there"
    else:
        greeting = f"Hi {first}"

    if custom_hook and custom_hook.strip():
        hook_para = custom_hook.strip().rstrip(".") + "."
    else:
        hook_para = (
            f"Teams at {company} that invest in culture still often end up with "
            "icebreakers nobody remembers by Friday."
        )
    signal_bit = ""
    if signals:
        signal_bit = (
            f"\n\nI noticed signals around {signals[0]} — that's exactly when a "
            "shared, high-energy experience lands hardest."
        )

    deck_bit = ""
    if gamma_url:
        deck_bit = (
            f"\n\nI put together a short custom proposal for {company} here:\n{gamma_url}\n"
        )

    one_liner = package_one_liner or (
        "a 60–90 minute zero-judgment team bonding experience that actually creates connection"
    )

    subject = subject_override or subject_variants(company=company, package_name=package_name)[0]
    body = f"""{greeting},

I'm reaching out on behalf of Edyta Śliwińska — Dancing with the Stars professional and corporate team-experience producer.

{hook_para}{signal_bit}

Rather than another trust-fall offsite module, Edyta brings a DWTS-caliber session — **{package_name}** ({one_liner}) — designed for teams of 5–500. Lunch hour, retreat kickoff, leadership lab, or full gala: same star power, zero judgment.
{deck_bit}
Would you or the right person on your People / Events team take a complimentary 15-minute discovery call with Edyta to see if there's a fit for an upcoming gathering?

Happy to work around your calendar.

Warmly,
Sliw Agent desk (for Edyta Śliwińska)
{TALENT['email_public']} · {TALENT['phone_primary']}
{TALENT['website']} · Corporate: {TALENT['corporate_page']}
"""
    return {
        "subject": subject,
        "body": body.strip() + "\n",
        "to_name": contact_name,
        "to_title": contact_title,
        "subject_variants": subject_variants(company=company, package_name=package_name),
    }


def draft_followup_email(
    *,
    company: str,
    contact_name: str = "",
    gamma_url: str | None = None,
    days_since: int = 5,
) -> dict[str, str]:
    first = (contact_name or "there").split()[0]
    greeting = f"Hi {first}" if first.lower() != "there" else "Hi there"
    deck = f"\nCustom deck again for convenience: {gamma_url}\n" if gamma_url else "\n"
    subject = f"Re: {company} × Edyta — quick bump"
    body = f"""{greeting},

Floating this back up in case it got buried — happy to make a 15-minute intro with Edyta painless if team connection or a year-end event is on your radar.

Corporate page: {TALENT.get('corporate_page') or 'https://edytasliwinska.com/corporate'}
{deck}
If the timing is off, just say the word and I'll close the loop.

Best,
Sliw Agent desk (for Edyta Śliwińska)
{TALENT['email_public']}
"""
    return {"subject": subject, "body": body.strip() + "\n"}


def draft_breakup_email(
    *,
    company: str,
    contact_name: str = "",
) -> dict[str, str]:
    first = (contact_name or "there").split()[0]
    greeting = f"Hi {first}" if first.lower() != "there" else "Hi there"
    subject = f"Closing the loop — {company} × Edyta"
    body = f"""{greeting},

I'll close the loop on my note about bringing Edyta Śliwińska (Dancing with the Stars) in for a team experience at {company}.

If a retreat, all-hands, leadership offsite, or holiday moment comes up later, I'm easy to reach — happy to reopen.

Wishing your team a great quarter.

Best,
Sliw Agent desk (for Edyta Śliwińska)
{TALENT['email_public']}
"""
    return {"subject": subject, "body": body.strip() + "\n"}


def save_outreach_draft(
    *,
    prospect_id: str,
    company: str,
    email: dict[str, str],
    sequence_step: str = "cold_1",
    contact_email: str = "",
    book: str = "corporate",
) -> Path:
    ensure_dirs()
    from .crm import _dirs_for_book
    out_dir = _dirs_for_book(book)["outreach"]
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in company)[:40]
    path = out_dir / f"{safe}_{sequence_step}_{stamp}.json"
    payload = {
        "prospect_id": prospect_id,
        "company": company,
        "sequence_step": sequence_step,
        "contact_email": contact_email,
        "status": "draft",  # draft | approved | sent
        "created_at": datetime.utcnow().isoformat(),
        "email": email,
        "approval_required": True,
        "send_instructions": (
            "HUMAN APPROVAL REQUIRED. Review subject/body, then either: "
            "(1) send manually from Edyta's or the desk Gmail, or "
            "(2) mark approved in CRM and use gmail draft tools if connected. "
            "The agent must never auto-send cold outreach."
        ),
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # also human-readable .md
    md_path = path.with_suffix(".md")
    md_path.write_text(
        f"# Outreach draft — {company}\n\n"
        f"**Status:** DRAFT (approval required)\n"
        f"**To:** {contact_email or '(add contact email)'}\n"
        f"**Subject:** {email.get('subject', '')}\n\n"
        f"---\n\n{email.get('body', '')}\n",
        encoding="utf-8",
    )
    update_prospect(
        prospect_id,
        book=book,
        outreach_path=str(path),
        stage="drafted",
    )
    return path


def write_edyta_brief(
    *,
    prospect: dict[str, Any],
    reply_summary: str = "",
    call_goal: str = "Qualify fit, propose package, lock a date window, agree next step.",
    book: str | None = None,
) -> Path:
    """One-pager Edyta reads before a discovery call."""
    ensure_dirs()
    from .crm import _dirs_for_book
    book = book or prospect.get("book") or "corporate"
    brief_dir = _dirs_for_book(book)["briefs"]
    brief_dir.mkdir(parents=True, exist_ok=True)
    company = prospect.get("company", "Prospect")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in company)[:40]
    prefix = "WEDDING_BRIEF" if book == "wedding" else "EDYTA_BRIEF"
    path = brief_dir / f"{prefix}_{safe}.md"

    pkgs = prospect.get("recommended_packages") or []
    primary = pkgs[0] if pkgs else {}
    contacts = prospect.get("contacts") or []
    contact_lines = []
    for c in contacts:
        contact_lines.append(
            f"- {c.get('name', '?')}"
            + (f" · {c['title']}" if c.get("title") else "")
            + (f" · {c['email']}" if c.get("email") else "")
            + (f" · {c['linkedin']}" if c.get("linkedin") else "")
        )

    md = f"""# Discovery brief for Edyta — {company}

**Stage:** {prospect.get('stage')}
**ICP score:** {prospect.get('score')} (tier {prospect.get('tier', '?')})
**Prepared:** {datetime.now().strftime('%Y-%m-%d %H:%M')}

## Company
- **Name:** {company}
- **Industry:** {prospect.get('industry', '—')}
- **Geo:** {prospect.get('geo', '—')}
- **Size:** {prospect.get('employee_range', '—')}
- **Website:** {prospect.get('website', '—')}
- **Signals:** {', '.join(prospect.get('signals') or []) or '—'}
- **Notes:** {prospect.get('notes', '—')}

## Contacts
{chr(10).join(contact_lines) if contact_lines else '- (add contacts)'}

## Recommended package
- **Primary:** {primary.get('name', 'TBD')} — {primary.get('one_liner', '')}
- **Duration:** {primary.get('duration', '')}
- **Alternates:** {', '.join(p.get('name', '') for p in pkgs[1:]) or '—'}

## Marketing assets
- **Gamma deck:** {prospect.get('gamma_url') or 'not generated yet'}
- **Local PPTX:** {prospect.get('gamma_pptx') or '—'}

## Their reply / interest signal
{reply_summary or prospect.get('reply_summary') or '(none yet — if cold outreach converted, summarize their email here)'}

## Call goal
{call_goal}

## Questions for you to ask
1. What's the event or team moment you're planning (date / window)?
2. Approx headcount and in-person vs hybrid?
3. Who else is involved in the decision / budget?
4. What would make this a home run for your culture team?
5. Any constraints (space, accessibility, executive participation)?

## Your ask
Propose the primary package, offer a custom quote after discovery, and if fit is clear, suggest 2–3 date options for the engagement itself.

## Brand guardrails
- Premium experiential talent, not "cheap team activity vendor"
- Zero judgment, star power, science-backed connection
- CTA remains warm and easy — no hard close pressure

---
*Generated by Sliw Agent · {TALENT['email_public']}*
"""
    path.write_text(md, encoding="utf-8")
    update_prospect(prospect["id"], book=book, edyta_brief_path=str(path))
    return path


def qualify_reply(
    *,
    reply_text: str,
    company: str = "",
) -> dict[str, Any]:
    """
    Heuristic interest filter. Returns stage recommendation + reasons.
    (LLM enrichment can wrap this later.)
    """
    t = (reply_text or "").lower()
    positive = [
        "interested", "love this", "sounds great", "let's talk", "lets talk",
        "book a call", "schedule", "availability", "tell me more", "pricing",
        "budget", "our team would", "perfect timing", "yes", "absolutely",
        "connect you", "forwarding", "calendar", "discovery",
    ]
    negative = [
        "not interested", "no thank", "unsubscribe", "remove me",
        "don't contact", "do not contact", "stop emailing", "no budget",
        "not a fit", "wrong person", "never contact",
    ]
    nurture = [
        "not right now", "maybe next", "q1", "q2", "q3", "q4", "next year",
        "circle back", "keep me in mind", "too busy", "revisit",
    ]

    pos_hits = [p for p in positive if p in t]
    neg_hits = [n for n in negative if n in t]
    nur_hits = [n for n in nurture if n in t]

    if neg_hits and not pos_hits:
        stage = "lost"
        label = "not_interested"
    elif pos_hits:
        stage = "interested"
        label = "warm_lead"
    elif nur_hits:
        stage = "nurture"
        label = "nurture"
    elif len(t.strip()) < 5:
        stage = "replied"
        label = "unclear"
    else:
        stage = "replied"
        label = "needs_human_read"

    ready_for_edyta = stage == "interested"
    return {
        "company": company,
        "label": label,
        "recommended_stage": stage,
        "ready_for_edyta": ready_for_edyta,
        "positive_signals": pos_hits,
        "negative_signals": neg_hits,
        "nurture_signals": nur_hits,
        "agent_action": (
            "Prepare Edyta brief and offer calendar slots."
            if ready_for_edyta else
            "Do not book Edyta yet — handle desk-side or mark lost/nurture."
        ),
    }
