"""Wedding Agent — parallel CAA desk for couples & planners."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from . import crm
from .outreach import save_outreach_draft
from .talent_bible import TALENT
from .wedding_bible import (
    WEDDING_PACKAGES,
    package_to_dict,
    recommend_wedding_package,
    wedding_brief_markdown,
)

LIBRARY_PATH = Path(__file__).resolve().parent.parent / "data" / "wedding_library.json"


def load_wedding_library() -> list[dict[str, Any]]:
    if not LIBRARY_PATH.exists():
        return []
    return json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))


def import_wedding_library(limit: int = 20) -> dict[str, Any]:
    lib = load_wedding_library()
    existing = {p.get("company", "").lower() for p in crm.list_prospects(book="wedding")}
    results = []
    for row in lib:
        if (row.get("company") or "").lower() in existing:
            continue
        if len(results) >= limit:
            break
        r = run_wedding_pipeline(
            name=row["company"],
            industry=row.get("industry", "Wedding"),
            geo=row.get("geo", ""),
            notes=row.get("notes", ""),
            signals=row.get("signals") or [],
            package_hint=row.get("package_hint", ""),
            draft_email=True,
        )
        results.append(r)
    return {"imported": len(results), "results": results}


def run_wedding_pipeline(
    *,
    name: str,
    industry: str = "Wedding couple",
    geo: str = "",
    notes: str = "",
    signals: list[str] | None = None,
    contacts: list[dict[str, str]] | None = None,
    package_hint: str = "",
    custom_hook: str = "",
    draft_email: bool = True,
    generate_gamma: bool = False,
    live_gamma: bool = False,
) -> dict[str, Any]:
    signals = signals or []
    contacts = contacts or []
    pkgs = recommend_wedding_package(signals, notes + " " + package_hint)
    if package_hint:
        # boost hinted package to front
        hinted = [p for p in pkgs if p["id"] == package_hint]
        rest = [p for p in pkgs if p["id"] != package_hint]
        if hinted:
            pkgs = hinted + rest

    p = crm.upsert_prospect(
        company=name,
        industry=industry,
        geo=geo,
        notes=notes,
        signals=signals,
        contacts=contacts,
        book="wedding",
        extra={
            "recommended_packages": pkgs,
            "score": 70 if pkgs else 50,
            "tier": "A" if industry.lower().find("planner") >= 0 or industry.lower().find("venue") >= 0 else "B",
            "agent_note": f"Wedding book — lead with {pkgs[0]['name'] if pkgs else 'consult'}.",
            "stage": "scored",
        },
    )
    pid = p["id"]
    crm.update_prospect(
        pid,
        book="wedding",
        recommended_packages=pkgs,
        score=70,
        tier=p.get("tier") or "B",
        agent_note=p.get("agent_note"),
        stage="scored",
    )

    result: dict[str, Any] = {
        "prospect_id": pid,
        "company": name,
        "book": "wedding",
        "packages": pkgs,
        "gamma": None,
        "outreach_path": None,
    }

    if generate_gamma or live_gamma:
        result["gamma"] = generate_wedding_gamma(
            name=name,
            packages=pkgs[:2],
            custom_hook=custom_hook or notes,
            prospect_id=pid,
            dry_run=not live_gamma,
        )

    if draft_email:
        primary = pkgs[0] if pkgs else package_to_dict(WEDDING_PACKAGES["package_10"])
        contact = contacts[0] if contacts else {}
        email = draft_wedding_email(
            name=name,
            contact_name=contact.get("name", ""),
            package=primary,
            custom_hook=custom_hook or notes,
            is_planner="planner" in industry.lower() or "venue" in industry.lower(),
            gamma_url=(result.get("gamma") or {}).get("gamma_url"),
        )
        path = save_outreach_draft(
            prospect_id=pid,
            company=name,
            email=email,
            contact_email=contact.get("email", ""),
            sequence_step="wedding_cold_1",
            book="wedding",
        )
        result["outreach_path"] = str(path)

    return result


def draft_wedding_email(
    *,
    name: str,
    contact_name: str = "",
    package: dict[str, Any],
    custom_hook: str = "",
    is_planner: bool = False,
    gamma_url: str | None = None,
) -> dict[str, str]:
    first = (contact_name or "there").split()[0]
    greeting = f"Hi {first}" if first.lower() != "there" else "Hi there"
    hook = custom_hook.strip() if custom_hook else (
        "Your first dance should feel like the best scene of the night — polished, personal, and joyfully you."
        if not is_planner else
        "Couples remember the planner who connected them with a DWTS-level first dance experience."
    )
    deck = f"\n\nProposal deck:\n{gamma_url}\n" if gamma_url else "\n"
    if is_planner:
        subject = f"Partnership — Edyta Śliwińska (DWTS) wedding dance for your couples"
        body = f"""{greeting},

I'm reaching out on behalf of Edyta Śliwińska — Dancing with the Stars professional based in San Rafael — about a referral partnership for wedding first dances.

{hook}

Edyta offers private lessons and full Dream Wedding Dance packages (choreography, venue coordination, day-of support). Packages start at a single private lesson ({WEDDING_PACKAGES['single_lesson'].price_label}) through a 10-lesson arc ({WEDDING_PACKAGES['package_10'].price_label}).
{deck}
Would you take 15 minutes to explore how we can support your couples?

Warmly,
Sliw Wedding Agent (for Edyta Śliwińska)
{TALENT['email_public']} · {TALENT['phone_primary']}
{TALENT['website']}/weddings
"""
    else:
        subject = f"Your first dance with Edyta Śliwińska (DWTS)"
        body = f"""{greeting},

Congratulations on your wedding. I'm writing on behalf of Edyta Śliwińska — Dancing with the Stars professional — about crafting a first dance you'll both feel proud of.

{hook}

Recommended starting point: **{package.get('name')}** ({package.get('price_label')}) — {package.get('one_liner')}
{deck}
Would you like a short consult with Edyta to design the right package for your timeline?

Warmly,
Sliw Wedding Agent (for Edyta Śliwińska)
{TALENT['email_public']} · {TALENT['phone_primary']}
{TALENT['website']}/weddings
"""
    return {"subject": subject, "body": body.strip() + "\n"}


def generate_wedding_gamma(
    *,
    name: str,
    packages: list[dict[str, Any]],
    custom_hook: str = "",
    prospect_id: str | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    from .crm import WEDDING_DECKS_DIR, ensure_dirs, update_prospect
    ensure_dirs()
    WEDDING_DECKS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:40]
    pkg_text = "\n".join(
        f"- {p['name']} ({p.get('price_label')}): {p.get('one_liner')}" for p in packages
    )
    input_text = f"""Create a premium romantic wedding first-dance proposal presentation.

Title: "Edyta Śliwińska × {name} — Wedding Dance Proposal"

Design: elegant, romantic, champagne gold + soft ivory + charcoal. Hollywood talent packaging for weddings — not corporate.

Talent facts:
{wedding_brief_markdown()}

Client: {name}
Hook: {custom_hook or 'A first dance with star power and zero judgment'}

Packages to feature:
{pkg_text}

Slides (~8-10):
1. Cover — Edyta × couple/venue
2. Why a first dance with a DWTS pro
3. Edyta's teaching philosophy (celebrities → couples)
4. Package deep-dives
5. How lessons work / timeline
6. Day-of support (for Dream package)
7. Studio location San Rafael
8. CTA — book a consult
9. Contact {TALENT['email_public']} · {TALENT['phone_primary']}

Never invent fake couple testimonials or prices not listed.
"""
    prompt_path = WEDDING_DECKS_DIR / f"{safe}_{stamp}_prompt.txt"
    prompt_path.write_text(input_text, encoding="utf-8")
    if dry_run:
        return {"dry_run": True, "prompt_path": str(prompt_path), "gamma_url": None}

    from .gamma_packages import _gamma_generate
    pptx = WEDDING_DECKS_DIR / f"Wedding_{safe}_{stamp}.pptx"
    url, credits = _gamma_generate(input_text, num_cards=9, out_pptx=pptx)
    if prospect_id:
        update_prospect(prospect_id, book="wedding", gamma_url=url, gamma_pptx=str(pptx), stage="packaged")
    return {"dry_run": False, "gamma_url": url, "credits": credits, "pptx_path": str(pptx)}


def seed_default_partnerships() -> dict[str, Any]:
    seed_path = Path(__file__).resolve().parent.parent / "data" / "partnerships_seed.json"
    if not seed_path.exists():
        return {"added": 0}
    rows = json.loads(seed_path.read_text(encoding="utf-8"))
    added = 0
    existing = {p.get("name", "").lower() for p in crm.load_partnerships()}
    for row in rows:
        if (row.get("name") or "").lower() in existing:
            continue
        crm.upsert_partner(row)
        added += 1
    return {"added": added, "total": len(crm.load_partnerships())}
