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
        if p.id == "dream" and any(k in text for k in ("venue", "luxury", "gala", "planner", "dream")):
            score += 3
        if p.id == "package_10" and any(k in text for k in ("package", "lessons", "first dance", "engaged")):
            score += 2
        if p.id == "single_lesson" and any(k in text for k in ("trial", "single", "one lesson")):
            score += 2
        ranked.append((score, p))
    ranked.sort(key=lambda x: -x[0])
    return [package_to_dict(p) for _, p in ranked]


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
