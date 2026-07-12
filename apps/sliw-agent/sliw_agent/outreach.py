"""
Outreach drafting & Edyta call-brief generation.

CRITICAL: drafts only. Never auto-sends. Human approval required.

Sequence rules:
  cold_1  — first touch only (never "closing the loop")
  follow_2 — only after cold was marked contacted
  break_3 — only after follow-up was sent and still no reply
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .crm import BRIEFS_DIR, OUTREACH_DIR, ensure_dirs, update_prospect
from .talent_bible import TALENT

CORPORATE = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
# Existing published packages presentation (Gamma site) — prefer this in body
PACKAGES_DECK = (
    TALENT.get("package_site")
    or "https://edyta-corporate-dance-866y3wq.gamma.site/"
)


def subject_variants(*, company: str, package_name: str = "The Icebreaker") -> list[str]:
    """Short, human subject lines — not campaign slogans."""
    return [
        f"Quick idea for {company}'s next team gathering",
        f"{company} — team experience with Edyta (DWTS)",
        f"Edyta Śliwińska for {company}?",
        f"Something different for your next offsite / all-hands",
    ]


def _first_name(contact_name: str) -> str:
    name = (contact_name or "").strip()
    if not name:
        return ""
    # Skip role-inbox labels
    low = name.lower()
    if any(low.startswith(x) for x in ("people", "events", "hr ", "culture", "team")):
        return ""
    return name.split()[0]


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
    master_deck_url: str | None = None,
) -> dict[str, str]:
    """Warm first-touch email. Never uses 'closing the loop' language."""
    first = _first_name(contact_name)
    greeting = f"Hi {first}," if first else "Hi,"

    # One natural opening — not a feature dump
    if custom_hook and custom_hook.strip() and len(custom_hook.strip()) < 220:
        open_line = custom_hook.strip().rstrip(".") + "."
    elif signals:
        open_line = (
            f"I came across {company} while looking for teams that invest in culture "
            f"(saw notes around {signals[0]}) and thought of Edyta."
        )
    else:
        open_line = (
            f"I've been putting together a short list of Bay Area companies that "
            f"might enjoy something different for a team gathering — {company} made the list."
        )

    # Prefer the published packages Gamma site; never force an attachment
    deck = (master_deck_url or gamma_url or PACKAGES_DECK or CORPORATE).strip()
    if "jk6b492p7fvmjhq" in deck:
        # Old auto-generated deck — replace with the good published one
        deck = PACKAGES_DECK
    one = package_one_liner or "a high-energy, zero-judgment session people actually talk about afterward"

    subject = subject_override or subject_variants(company=company, package_name=package_name)[0]

    # Optional PDF line if provided later via env/meta
    pdf_line = ""
    try:
        from .master_deck import get_pdf_url
        pdf = get_pdf_url()
        if pdf:
            pdf_line = f"\nPDF version (optional): {pdf}\n"
    except Exception:
        pass

    body = f"""{greeting}

{open_line}

I'm writing for Edyta Śliwińska — you may know her from Dancing with the Stars. She now runs corporate experiences for teams (all-hands, offsites, leadership groups, holiday parties). Think less "forced icebreaker," more shared moment that sticks.

For {company}, the fit that stood out was {package_name.lower() if not package_name.startswith("The") else package_name} — {one}.

Here's the full overview of her packages (opens in the browser — no attachment):
{deck}

More about corporate programs:
{CORPORATE}
{pdf_line}
If useful, she's happy to do a quick 15-minute call and see whether there's a natural fit. No pressure either way.

Best,
{TALENT.get('stage_name') or 'Edyta'}'s team
{TALENT['email_public']}
"""
    # Prefer signing as human desk without "Sliw Agent desk" robotic branding
    return {
        "subject": subject,
        "body": body.strip() + "\n",
        "to_name": contact_name,
        "to_title": contact_title,
        "sequence_step": "cold_1",
        "subject_variants": subject_variants(company=company, package_name=package_name),
    }


def draft_followup_email(
    *,
    company: str,
    contact_name: str = "",
    gamma_url: str | None = None,
    master_deck_url: str | None = None,
    days_since: int = 5,
) -> dict[str, str]:
    """Second touch — only after cold was sent. Friendly bump, not a breakup."""
    first = _first_name(contact_name)
    greeting = f"Hi {first}," if first else "Hi,"
    deck = (master_deck_url or gamma_url or PACKAGES_DECK or CORPORATE).strip()
    if "jk6b492p7fvmjhq" in deck:
        deck = PACKAGES_DECK
    subject = f"Re: {company} — following up gently"
    body = f"""{greeting}

Just bumping this in case it got buried. No worries if the timing isn't right.

Edyta (Dancing with the Stars) hosts team experiences for companies — offsites, all-hands, holiday gatherings.

Packages overview:
{deck}

Site: {CORPORATE}

If you want intros, I can set up 15 minutes. If not, all good.

Best,
{TALENT.get('stage_name') or 'Edyta'}'s team
{TALENT['email_public']}
"""
    return {
        "subject": subject,
        "body": body.strip() + "\n",
        "sequence_step": "follow_2",
    }


def draft_breakup_email(
    *,
    company: str,
    contact_name: str = "",
) -> dict[str, str]:
    """Final touch — only after cold AND follow-up were sent with no reply."""
    first = _first_name(contact_name)
    greeting = f"Hi {first}," if first else "Hi,"
    subject = f"Last note from me — {company}"
    body = f"""{greeting}

I'll leave this here so I'm not filling your inbox.

If a team event, offsite, or holiday gathering comes up later and you want a DWTS-caliber experience, you can always reach us at {TALENT['email_public']}.

All the best to the {company} team.

{TALENT.get('stage_name') or 'Edyta'}'s team
"""
    return {
        "subject": subject,
        "body": body.strip() + "\n",
        "sequence_step": "break_3",
    }


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
        "status": "draft",
        "created_at": datetime.utcnow().isoformat(),
        "email": email,
        "approval_required": True,
        "send_instructions": (
            "HUMAN SEND. Copy into Gmail, send yourself. "
            "Do not send follow_2 until cold_1 is marked contacted. "
            "Do not send break_3 until follow_2 was sent."
        ),
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path = path.with_suffix(".md")
    md_path.write_text(
        f"# {sequence_step} — {company}\n\n"
        f"**To:** {contact_email or '(add contact)'}\n"
        f"**Subject:** {email.get('subject', '')}\n\n"
        f"---\n\n{email.get('body', '')}\n",
        encoding="utf-8",
    )
    # Only cold_1 sets primary outreach_path / drafted stage
    if sequence_step == "cold_1":
        update_prospect(
            prospect_id,
            book=book,
            outreach_path=str(path),
            stage="drafted",
        )
    else:
        update_prospect(prospect_id, book=book, **{f"outreach_{sequence_step}": str(path)})
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
- **Corporate page:** {CORPORATE}
- **Deck / Gamma:** {prospect.get('gamma_url') or prospect.get('master_deck_url') or '—'}

## Their reply / interest signal
{reply_summary or prospect.get('reply_summary') or '(none yet)'}

## Call goal
{call_goal}

## Questions to ask
1. What's the event or team moment (date / window)?
2. Approx headcount and in-person vs hybrid?
3. Who else is in the decision / budget?
4. What would make this a home run?
5. Any constraints (space, accessibility, exec participation)?

## Brand guardrails
- Premium experiential talent, not cheap activity vendor
- Zero judgment, star power, easy next step

---
*Sliw desk · {TALENT['email_public']}*
"""
    path.write_text(md, encoding="utf-8")
    update_prospect(prospect["id"], book=book, edyta_brief_path=str(path))
    return path


def qualify_reply(
    *,
    reply_text: str,
    company: str = "",
) -> dict[str, Any]:
    """Heuristic interest filter."""
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
        stage, label = "lost", "not_interested"
    elif pos_hits:
        stage, label = "interested", "warm_lead"
    elif nur_hits:
        stage, label = "nurture", "nurture"
    elif len(t.strip()) < 5:
        stage, label = "replied", "unclear"
    else:
        stage, label = "replied", "needs_human_read"

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
