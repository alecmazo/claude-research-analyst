"""
Gamma.app marketing package generator for corporate prospects.

Reuses the same public API pattern as claude_analyst.py:
  POST https://public-api.gamma.app/v1.0/generations
  GET  https://public-api.gamma.app/v1.0/generations/{id}

Env:
  GAMMA_API_KEY   (required for live generation)
  GAMMA_FOLDER_ID (optional)
  SLIW_GAMMA_FOLDER_ID (optional override for Sliw decks)
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

from .crm import DECKS_DIR, ensure_dirs, update_prospect
from .talent_bible import PACKAGES, TALENT, talent_brief_markdown

try:
    from dotenv import load_dotenv
    # project root .env (two levels up from apps/sliw-agent → monorepo root)
    _root = Path(__file__).resolve().parents[3]
    load_dotenv(_root / ".env")
    load_dotenv()  # also cwd
except ImportError:
    pass


def _gamma_key() -> str:
    """Shared Gamma credits with DGA — same GAMMA_API_KEY is fine."""
    key = (
        os.environ.get("SLIW_GAMMA_API_KEY", "").strip()  # optional override
        or os.environ.get("GAMMA_API_KEY", "").strip()
    )
    if not key:
        raise RuntimeError(
            "GAMMA_API_KEY not set. Add it to the monorepo .env / Railway "
            "(https://gamma.app/account)."
        )
    return key


def _folder_ids() -> list[str] | None:
    fid = (
        os.environ.get("SLIW_GAMMA_FOLDER_ID", "").strip()
        or os.environ.get("GAMMA_FOLDER_ID", "").strip()
    )
    return [fid] if fid else None


def _design_block() -> str:
    return f"""IMPORTANT DESIGN RULES (enforce strictly):
- Branding: EDYTA ŚLIWIŃSKA / Dancing with the Stars pro.
- Aesthetic: premium Hollywood talent booking deck — elegant, high-energy,
  not corporate-generic. Think CAA packaging for experiential talent.
- Color palette: deep black / charcoal, champagne gold (#C9A84C), soft ivory,
  warm accent blush. High contrast photography-friendly slides.
- Title treatment: bold talent name + client company name on cover.
- ALL TEXT minimum 12pt (titles 28–32pt, headings 20–24pt, body 14–18pt).
- Minimal bullet density; short punchy lines; one big idea per card.
- Include CTA slide: complimentary 15-minute discovery call.
- Footer on each slide: {TALENT['website']} · {TALENT['email_public']} · {TALENT['phone_primary']}
- Never invent client logos or fake testimonials.
- Never invent dollar pricing unless provided in the brief.
"""


def build_package_prompt(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    employee_range: str = "",
    signals: list[str] | None = None,
    package_ids: list[str] | None = None,
    contacts: list[dict[str, str]] | None = None,
    custom_hook: str = "",
    notes: str = "",
    light: bool = False,
) -> tuple[str, int]:
    """Build Gamma inputText + recommended card count.

    light=True → short personalized overlay (few cards) on top of portfolio story.
    full → classic multi-package sales deck.
    """
    signals = signals or []
    package_ids = package_ids or ["icebreaker"]
    pkgs = [PACKAGES[pid] for pid in package_ids if pid in PACKAGES]
    if not pkgs:
        pkgs = [PACKAGES["icebreaker"]]

    primary = pkgs[0]
    pkg_sections = []
    for i, p in enumerate(pkgs, 1):
        pkg_sections.append(
            f"""Package {i}: {p.name}
Duration: {p.duration}
Pitch: {p.one_liner}
Best for: {'; '.join(p.best_for)}
Benefits: {'; '.join(p.benefits)}
"""
        )

    contact_line = ""
    if contacts:
        bits = []
        for c in contacts[:3]:
            bits.append(
                f"{c.get('name', 'Contact')}"
                + (f", {c['title']}" if c.get("title") else "")
            )
        contact_line = "Primary contacts researched: " + "; ".join(bits)

    title = (
        f"Edyta Śliwińska × {company} — Corporate Experience Proposal | "
        f"{datetime.now().strftime('%B %Y')}"
    )

    portfolio_url = TALENT.get("package_site") or "https://edyta-corporate-dance-866y3wq.gamma.site/"

    if light:
        num_cards = 6
        input_text = f"""Create a SHORT premium **personalized sales overlay** (not a 20-slide deck).

Title: "{title}"

{_design_block()}

This deck should feel like a 6-card cover letter ON TOP of the full portfolio at:
{portfolio_url}

# CLIENT
- Company: {company}
- Industry: {industry or 'n/a'}
- Geo: {geo or 'n/a'}
- Size: {employee_range or 'n/a'}
- Signals: {', '.join(signals) if signals else 'culture / team connection'}
- Hook: {custom_hook or notes or 'A team experience they will actually remember'}
- {contact_line}

# TALENT (facts only)
{talent_brief_markdown()}

# PRIMARY PACKAGE
{pkg_sections[0] if pkg_sections else primary.name}

# EXACTLY {num_cards} CARDS
1. Cover — Edyta × {company}
2. Why {company} now (use hook + signals)
3. Recommended package spotlight — {primary.name}
4. Full portfolio menu (name all 5 packages briefly; point to {portfolio_url})
5. How it works (5–500 people, zero judgment, 15-min discovery)
6. CTA + contact {TALENT['email_public']} · {TALENT['phone_primary']}

Tone: CAA packaging — concise, exclusive. Do not invent prices or fake logos.
"""
        return input_text, num_cards

    num_cards = 10 + len(pkgs)

    input_text = f"""Create a premium **corporate sales / talent booking presentation**.

Title: "{title}"

{_design_block()}

Also reference the full portfolio site: {portfolio_url}

# CLIENT
- Company: {company}
- Industry: {industry or 'n/a'}
- Location / geo: {geo or 'n/a'}
- Approx size: {employee_range or 'n/a'}
- Trigger signals: {', '.join(signals) if signals else 'team connection / culture / events'}
- Custom hook (use this as the personalization spine): {custom_hook or notes or 'Elevate team connection with a DWTS-caliber experience'}
- {contact_line}

# TALENT (facts only — do not invent)
{talent_brief_markdown()}

# PACKAGES TO FEATURE (primary first) — present the portfolio, not a single SKU only
{chr(10).join(pkg_sections)}

# SLIDE STRUCTURE (create {num_cards} cards)
1. Cover — Edyta Śliwińska × {company} (premium, cinematic)
2. The opportunity — why {company}'s team needs a moment that actually bonds
3. Who is Edyta — DWTS pro, 20+ years, star power without ego
4. Why dance works at work — science-backed team accelerator
5. Recommended experience for {company} — spotlight {primary.name}
6. Full portfolio menu — all packages at a glance
7. How the session runs — logistics, 5–500 people, hybrid/in-person, zero judgment
8. Package deep-dives — featured packages
9. Credentials & live-show pedigree (brief)
10. Next step — complimentary 15-minute discovery call with Edyta
11. Contact — {TALENT['email_public']} · {TALENT['phone_primary']} · {TALENT['website']}

Tone: warm, confident, exclusive — Hollywood representation energy, not spammy vendor pitch.
Personalize every {company} mention. Reference signals where natural.
"""
    return input_text, num_cards


def generate_marketing_package(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    employee_range: str = "",
    signals: list[str] | None = None,
    package_ids: list[str] | None = None,
    contacts: list[dict[str, str]] | None = None,
    custom_hook: str = "",
    notes: str = "",
    prospect_id: str | None = None,
    dry_run: bool = False,
    light: bool = False,
) -> dict[str, Any]:
    """
    Create a Gamma marketing deck for a prospect.
    Returns {gamma_url, pptx_path, credits, prompt_path, dry_run}.
    light=True → short personalized overlay (preferred for most sales).
    """
    ensure_dirs()
    input_text, num_cards = build_package_prompt(
        company=company,
        industry=industry,
        geo=geo,
        employee_range=employee_range,
        signals=signals,
        package_ids=package_ids,
        contacts=contacts,
        custom_hook=custom_hook,
        notes=notes,
        light=light,
    )

    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in company)[:40]
    stamp = datetime.now().strftime("%Y%m%d")
    prompt_path = DECKS_DIR / f"{safe}_{stamp}_prompt.txt"
    prompt_path.write_text(input_text, encoding="utf-8")

    if dry_run:
        return {
            "dry_run": True,
            "gamma_url": None,
            "pptx_path": None,
            "credits": 0,
            "prompt_path": str(prompt_path),
            "num_cards": num_cards,
            "package_ids": package_ids,
        }

    pptx_path = DECKS_DIR / f"Edyta_x_{safe}_{stamp}.pptx"
    gamma_url, credits = _gamma_generate(input_text, num_cards=num_cards, out_pptx=pptx_path)

    meta = {
        "dry_run": False,
        "company": company,
        "gamma_url": gamma_url,
        "pptx_path": str(pptx_path) if pptx_path.exists() else None,
        "credits": credits,
        "prompt_path": str(prompt_path),
        "num_cards": num_cards,
        "package_ids": package_ids,
        "generated_at": datetime.utcnow().isoformat(),
    }
    meta_path = DECKS_DIR / f"{safe}_{stamp}_meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    if prospect_id:
        update_prospect(
            prospect_id,
            gamma_url=gamma_url,
            gamma_pptx=str(pptx_path) if pptx_path.exists() else None,
            stage="packaged",
        )

    return meta


def _gamma_generate(
    input_text: str,
    num_cards: int,
    out_pptx: Path | None = None,
) -> tuple[str | None, int]:
    headers = {"Content-Type": "application/json", "X-API-KEY": _gamma_key()}
    payload: dict[str, Any] = {
        "inputText": input_text,
        "textMode": "generate",
        "format": "presentation",
        "numCards": max(8, num_cards),
        "exportAs": "pptx",
    }
    folders = _folder_ids()
    if folders:
        payload["folderIds"] = folders

    try:
        resp = requests.post(
            "https://public-api.gamma.app/v1.0/generations",
            json=payload,
            headers=headers,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Gamma POST failed (network): {exc}") from exc

    if resp.status_code not in (200, 201):
        body = (resp.text or "")[:500]
        body_lower = body.lower()
        if resp.status_code == 402 or "credit" in body_lower or "quota" in body_lower:
            raise RuntimeError(
                "Gamma is out of credits. Top up at https://gamma.app/account."
            )
        if resp.status_code in (401, 403):
            raise RuntimeError("Gamma API key rejected. Check GAMMA_API_KEY.")
        raise RuntimeError(f"Gamma API {resp.status_code}: {body}")

    gen_id = resp.json().get("generationId")
    print(f"   ✅ Gamma generation started ({gen_id})")

    for attempt in range(200):
        time.sleep(6)
        try:
            status = requests.get(
                f"https://public-api.gamma.app/v1.0/generations/{gen_id}",
                headers=headers,
                timeout=30,
            ).json()
        except Exception as exc:  # noqa: BLE001
            print(f"   ⚠️  Gamma poll error: {exc}")
            continue
        st = status.get("status")
        if st == "completed":
            gamma_url = status.get("gammaUrl")
            export_url = status.get("exportUrl")
            credits = status.get("credits", {})
            used = credits.get("deducted", 0)
            print(f"   ✅ Deck ready: {gamma_url}  (credits: {used})")
            if export_url and out_pptx is not None:
                try:
                    r = requests.get(export_url, stream=True, timeout=60)
                    with open(out_pptx, "wb") as fh:
                        for chunk in r.iter_content(8192):
                            fh.write(chunk)
                    print(f"   💾 Saved {out_pptx}")
                except Exception as exc:  # noqa: BLE001
                    print(f"   ⚠️  Could not save PPTX: {exc}")
            return gamma_url, used
        if st == "failed":
            err_msg = str(status.get("error") or status.get("message") or "unknown")
            raise RuntimeError(f"Gamma generation failed: {err_msg}")
        if attempt % 10 == 0:
            print(f"   ⏳ Generating… ({attempt + 1}/200) status={st}")

    raise RuntimeError("Gamma generation timeout (>20 min)")
