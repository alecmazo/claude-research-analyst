"""
Master corporate packages deck — one reusable Gamma presentation for all outreach.

Link goes in the email body (never as attachment). Stored in data/master_deck.json.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .crm import DATA_DIR, ensure_dirs
from .talent_bible import PACKAGES, TALENT, talent_brief_markdown

MASTER_META = DATA_DIR / "master_deck.json"
CORPORATE = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"


def get_master_deck_url() -> str:
    """Best public link for email body: live Gamma if we have one, else corporate page."""
    ensure_dirs()
    if MASTER_META.exists():
        try:
            data = json.loads(MASTER_META.read_text(encoding="utf-8"))
            url = (data.get("gamma_url") or "").strip()
            if url:
                return url
        except Exception:
            pass
    # Env override if you paste a Gamma share link manually
    env = (os.environ.get("SLIW_MASTER_DECK_URL") or "").strip()
    if env:
        return env
    return CORPORATE


def get_master_deck_meta() -> dict[str, Any]:
    ensure_dirs()
    if MASTER_META.exists():
        try:
            return json.loads(MASTER_META.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "gamma_url": get_master_deck_url(),
        "status": "fallback_corporate_page",
        "note": "No dedicated Gamma master deck yet — using corporate site.",
    }


def build_master_deck_prompt() -> str:
    pkg_blocks = []
    for i, p in enumerate(PACKAGES.values(), 1):
        pkg_blocks.append(
            f"""{i}. {p.name}
Duration: {p.duration}
One-liner: {p.one_liner}
Best for: {'; '.join(p.best_for[:3])}
"""
        )
    return f"""Create a polished, timeless **corporate sales portfolio presentation** for Edyta Śliwińska.

Title: "Edyta Śliwińska — Corporate Team Experiences"

This is the MASTER deck used in cold outreach. It must work for any company.
Do NOT personalize to a single client. Keep it evergreen.

{_design()}

# TALENT
{talent_brief_markdown()}

# ALL PACKAGES (feature every one)
{chr(10).join(pkg_blocks)}

# STRUCTURE (10–12 cards)
1. Cover — Edyta Śliwińska · Dancing with the Stars pro · Corporate experiences
2. The problem with forgettable team events
3. What makes this different — star power + zero judgment + real connection
4. Who Edyta is (short, warm, credible)
5–9. One card per package (Icebreaker, Leadership Ballroom, Tech-Decompress, Office Stars, Custom Lab)
10. How a session works (5–500 people, hybrid/in-person, logistics easy)
11. Next step — 15-minute discovery call
12. Contact: {TALENT['email_public']} · {TALENT['phone_primary']} · {CORPORATE}

Tone: warm, human, premium — CAA packaging, not corporate jargon spam.
No fake testimonials. No invented prices beyond what's public.
"""


def _design() -> str:
    return f"""DESIGN:
- Elegant Hollywood talent look: charcoal, champagne gold, ivory
- Clean cards, large type, minimal bullets
- Footer: {CORPORATE} · {TALENT['email_public']}
"""


def ensure_master_deck(*, live: bool = False) -> dict[str, Any]:
    """
    Create or return the master packages deck.
    live=True burns Gamma credits and stores gammaUrl.
    """
    ensure_dirs()
    existing = get_master_deck_meta()
    if existing.get("gamma_url") and existing.get("status") == "ready" and not live:
        return existing

    prompt = build_master_deck_prompt()
    prompt_path = DATA_DIR / "decks" / "MASTER_corporate_packages_prompt.txt"
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_path.write_text(prompt, encoding="utf-8")

    meta: dict[str, Any] = {
        "updated_at": datetime.utcnow().isoformat(),
        "prompt_path": str(prompt_path),
        "corporate_page": CORPORATE,
        "status": "prompt_only",
        "gamma_url": CORPORATE,
        "note": "Prompt saved. Set live=True or SLIW_MASTER_DECK_URL for a shareable Gamma link.",
    }

    if live:
        from .gamma_packages import _gamma_generate
        pptx = DATA_DIR / "decks" / "MASTER_Edyta_Corporate_Packages.pptx"
        url, credits = _gamma_generate(prompt, num_cards=11, out_pptx=pptx)
        meta.update({
            "status": "ready",
            "gamma_url": url or CORPORATE,
            "pptx_path": str(pptx) if pptx.exists() else None,
            "credits": credits,
            "note": "Master deck ready — use gamma_url in email body (not attachment).",
        })

    MASTER_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta
