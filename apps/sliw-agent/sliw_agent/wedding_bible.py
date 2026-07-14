"""Wedding Agent talent book — parallel product to corporate."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .talent_bible import TALENT


@dataclass(frozen=True)
class WeddingPackage:
    id: str
    name: str
    price_label: str
    one_liner: str
    includes: list[str]
    best_for: list[str]


WEDDING_PACKAGES: dict[str, WeddingPackage] = {
    "single_lesson": WeddingPackage(
        id="single_lesson",
        name="Private wedding lesson ×1",
        price_label="$150",
        one_liner="One focused private session to start your first dance with confidence.",
        includes=[
            "Customized to your skill level",
            "Style exploration (waltz, contemporary, cha-cha, mix)",
            "Personal coaching from a DWTS pro",
        ],
        best_for=["Just engaged — testing the waters", "Refresh before the big day"],
    ),
    "package_10": WeddingPackage(
        id="package_10",
        name="Wedding lesson package ×10",
        price_label="$1,250",
        one_liner="Full prep arc — technique, style, and emotional expression for a polished first dance.",
        includes=[
            "10 private sessions with flexible scheduling",
            "Detailed feedback and refinement",
            "Style exploration or single-style focus",
            "Confidence for performance day",
        ],
        best_for=["Couples who want a show-stopping first dance", "3–6 months to wedding"],
    ),
    "dream": WeddingPackage(
        id="dream",
        name="Dream Wedding Dance",
        price_label="Custom proposal",
        one_liner="Personalized choreography, venue coordination, rehearsal space, and day-of support.",
        includes=[
            "Personalized choreography by Edyta",
            "Private lessons",
            "Venue / floor / lighting / music coordination",
            "Rehearsal space access",
            "Performance day support",
        ],
        best_for=["Full production first dance", "Luxury / destination / large guest lists"],
    ),
}


def package_to_dict(p: WeddingPackage) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "price_label": p.price_label,
        "one_liner": p.one_liner,
        "includes": list(p.includes),
        "best_for": list(p.best_for),
    }


def recommend_wedding_package(signals: list[str] | None = None, notes: str = "") -> list[dict]:
    text = " ".join(signals or []).lower() + " " + (notes or "").lower()
    ranked = []
    for p in WEDDING_PACKAGES.values():
        score = 1.0
        if p.id == "dream" and any(k in text for k in ("venue", "luxury", "gala", "planner", "dream", "partnership")):
            score += 3
        if p.id == "package_10" and any(k in text for k in ("package", "lessons", "first dance", "engaged", "planner")):
            score += 2
        if p.id == "single_lesson" and any(k in text for k in ("trial", "single", "one lesson", "couple")):
            score += 2
        ranked.append((score, p))
    ranked.sort(key=lambda x: -x[0])
    return [package_to_dict(p) for _, p in ranked]


# ICP: planners first (referral volume), then luxury venues, then couples
WEDDING_BAY_AREA_TOKENS = (
    "bay area", "san francisco", "sf", "marin", "oakland", "berkeley",
    "sausalito", "napa", "sonoma", "palo alto", "peninsula", "silicon valley",
    "san rafael", "mill valley", "tiburon", "wine country", "east bay",
    "south bay", "walnut creek", "woodside", "los gatos", "san jose",
    "healdsburg", "st. helena", "yountville", "petaluma", "novato",
)


def score_wedding_lead(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    notes: str = "",
    signals: list[str] | None = None,
    website: str = "",
    priority: int | float | None = None,
    package_hint: str = "",
) -> dict[str, Any]:
    """Score wedding book leads. Planners & Bay Area venues rank highest."""
    signals = signals or []
    text = " ".join(
        [
            company or "",
            industry or "",
            geo or "",
            notes or "",
            package_hint or "",
            " ".join(signals),
        ]
    ).lower()
    ind = (industry or "").lower()
    breakdown: dict[str, float] = {}

    # Channel type (max ~36) — planners are the primary go-to-market
    if "planner" in ind or "planner" in text:
        channel = 36.0
        channel_label = "Wedding planner (referral partner)"
    elif "venue" in ind or "winery" in ind or "hotel" in ind or "estate" in text:
        channel = 28.0
        channel_label = "Venue / property (on-site couples)"
    elif "couple" in ind or "engaged" in text:
        channel = 14.0
        channel_label = "Couple (direct)"
    else:
        channel = 18.0
        channel_label = "Wedding-adjacent"
    breakdown["channel"] = channel

    # Geo fit (max ~22) — Edyta studio is San Rafael
    geo_score = 6.0
    if any(t in text for t in WEDDING_BAY_AREA_TOKENS):
        geo_score = 22.0
    elif any(t in text for t in ("california", "ca ", " norcal", "northern california")):
        geo_score = 14.0
    breakdown["geo"] = geo_score

    # Partnership / first-dance intent (max ~16)
    intent = 4.0
    for token, pts in (
        ("planner partnership", 6),
        ("venue partnership", 5),
        ("first dance", 4),
        ("referral", 4),
        ("luxury", 3),
        ("destination", 2),
        ("engaged", 2),
    ):
        if token in text:
            intent += pts
    intent = min(16.0, intent)
    breakdown["intent"] = intent

    # Website / reachability (max ~8)
    web = 0.0
    if website and ("." in website):
        web = 8.0
    elif website:
        web = 4.0
    breakdown["website"] = web

    # Manual priority 1–10 from library (max ~12 scaled)
    pri_raw = float(priority) if priority is not None else 5.0
    pri_raw = max(0.0, min(10.0, pri_raw))
    pri = round(pri_raw * 1.2, 1)  # 0–12
    breakdown["priority"] = pri

    # Demote obvious placeholders / samples
    penalty = 0.0
    if any(k in text for k in ("sample", "placeholder", "replace", "network — sample", "collective — sample")):
        penalty = 35.0
    breakdown["penalty"] = -penalty

    raw = channel + geo_score + intent + web + pri - penalty
    score = int(max(0, min(99, round(raw))))

    if score >= 80:
        tier = "A"
    elif score >= 65:
        tier = "B"
    elif score >= 48:
        tier = "C"
    else:
        tier = "D"

    pkgs = recommend_wedding_package(signals, notes + " " + package_hint)
    if package_hint:
        hinted = [p for p in pkgs if p["id"] == package_hint]
        rest = [p for p in pkgs if p["id"] != package_hint]
        if hinted:
            pkgs = hinted + rest

    lead_pkg = pkgs[0]["name"] if pkgs else "consult"
    agent_note = (
        f"{channel_label}. Lead with {lead_pkg}. "
        f"{'Bay Area fit — studio proximity.' if geo_score >= 25 else 'Confirm travel / venue.'}"
    )

    return {
        "score": score,
        "tier": tier,
        "breakdown": breakdown,
        "recommended_packages": pkgs,
        "agent_note": agent_note,
        "channel_label": channel_label,
    }


def wedding_brief_markdown() -> str:
    return f"""# Wedding Agent — Edyta Śliwińska

## Talent
- {TALENT['legal_name']} — DWTS pro
- Contact: {TALENT['email_public']} · {TALENT['phone_primary']}
- Studio: {TALENT['studio_address']}
- Weddings page: {TALENT['website']}/weddings

## Packages
""" + "\n".join(
        f"- **{p.name}** ({p.price_label}): {p.one_liner}"
        for p in WEDDING_PACKAGES.values()
    )
