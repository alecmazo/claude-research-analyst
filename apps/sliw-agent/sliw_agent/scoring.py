"""
ICP scoring & package recommendation for corporate prospects.

Scores 0–100. Heuristic first (no LLM required); optional Grok enrichment
can refine notes and signals later.
"""

from __future__ import annotations

import re
from typing import Any

from .talent_bible import ICP, PACKAGES, Package


# Industry keyword buckets (lowercased match against free text)
_INDUSTRY_KEYWORDS: dict[str, list[str]] = {
    "Technology / SaaS / AI": [
        "software", "saas", "ai", "tech", "cloud", "platform", "cyber",
        "fintech", "devtool", "semiconductor", "chip", "robotics",
    ],
    "Biotech / life sciences (Bay Area)": [
        "biotech", "pharma", "life science", "genomics", "medtech", "therapeutics",
    ],
    "Financial services / fintech": [
        "bank", "finance", "asset management", "insurance", "payments", "venture",
        "private equity", "wealth",
    ],
    "Professional services (law, consulting)": [
        "law firm", "legal", "consulting", "advisory", "accounting", "audit",
    ],
    "Healthcare systems & health-tech": [
        "hospital", "health", "clinic", "care delivery", "payer",
    ],
    "Consumer brands with strong culture teams": [
        "consumer", "retail", "cpg", "brand", "e-commerce", "ecommerce",
    ],
    "Media / entertainment": [
        "media", "entertainment", "studio", "streaming", "gaming", "music",
    ],
    "Nonprofits & foundations running galas": [
        "nonprofit", "foundation", "charity", "ngo", "association",
    ],
}

_GEO_KEYWORDS = {
    "bay": 25,
    "san francisco": 25,
    "sf": 20,
    "silicon valley": 25,
    "palo alto": 22,
    "mountain view": 22,
    "sunnyvale": 20,
    "san jose": 20,
    "oakland": 18,
    "berkeley": 18,
    "marin": 25,
    "san rafael": 25,
    "peninsula": 22,
    "los angeles": 15,
    "la ": 12,
    "california": 12,
    "remote": 8,
    "national": 8,
}


def _blob(*parts: str) -> str:
    return " ".join(p for p in parts if p).lower()


def _score_industry(text: str) -> tuple[int, str | None]:
    best = 0
    matched = None
    for industry, kws in _INDUSTRY_KEYWORDS.items():
        hits = sum(1 for kw in kws if kw in text)
        if hits:
            score = min(25, 10 + hits * 5)
            if score > best:
                best = score
                matched = industry
    return best, matched


def _score_geo(text: str) -> int:
    best = 0
    for kw, pts in _GEO_KEYWORDS.items():
        if kw in text:
            best = max(best, pts)
    return best


def _score_size(employee_range: str) -> int:
    t = (employee_range or "").lower()
    # extract numbers
    nums = [int(x) for x in re.findall(r"\d+", t.replace(",", ""))]
    if not nums:
        if any(x in t for x in ("mid", "enterprise", "smb", "growth")):
            return 12
        return 8  # unknown — mild penalty, not zero
    n = max(nums)
    if 50 <= n <= 5000:
        return 20
    if 20 <= n < 50 or 5000 < n <= 20000:
        return 14
    if n > 20000:
        return 10  # still bookable for galas
    return 4


def _score_signals(signals: list[str], text: str) -> tuple[int, list[str]]:
    """Match timing / package signals from talent bible + free text."""
    all_signal_vocab: list[str] = []
    for pkg in PACKAGES.values():
        all_signal_vocab.extend(pkg.icp_signals)
    all_signal_vocab.extend(s.lower() for s in ICP["timing_triggers"])

    found: list[str] = []
    hay = text + " " + " ".join(s.lower() for s in signals)
    for sig in all_signal_vocab:
        if sig.lower() in hay and sig not in found:
            found.append(sig)
    # also include explicit signals user provided
    for s in signals:
        if s and s not in found:
            found.append(s)

    pts = min(30, len(found) * 6)
    return pts, found


def recommend_packages(
    *,
    industry: str = "",
    signals: list[str] | None = None,
    notes: str = "",
    employee_range: str = "",
    top_n: int = 2,
) -> list[dict[str, Any]]:
    """Return top packages with rationale scores."""
    signals = signals or []
    text = _blob(industry, notes, " ".join(signals), employee_range)
    ranked: list[tuple[float, Package, list[str]]] = []

    for pkg in PACKAGES.values():
        hits = [sig for sig in pkg.icp_signals if sig.lower() in text]
        # industry soft boosts
        boost = 0.0
        if any(k in text for k in ("tech", "software", "ai", "engineering", "saas")):
            if pkg.id == "tech_decompress":
                boost += 3
            if pkg.id == "icebreaker":
                boost += 1
        if any(k in text for k in ("leader", "executive", "offsite", "retreat", "hipo")):
            if pkg.id == "leadership_ballroom":
                boost += 3
        if any(k in text for k in ("holiday", "gala", "party", "anniversary", "fundrais")):
            if pkg.id == "office_stars":
                boost += 3
        if any(k in text for k in ("merger", "acquisition", "reorg", "dei", "bespoke", "custom")):
            if pkg.id == "custom_lab":
                boost += 3
            if pkg.id == "icebreaker":
                boost += 1

        score = len(hits) * 2 + boost
        # default baseline so every company gets a package
        if score == 0:
            if pkg.id == "icebreaker":
                score = 1.0
        ranked.append((score, pkg, hits))

    ranked.sort(key=lambda x: (-x[0], x[1].name))
    out = []
    for score, pkg, hits in ranked[:top_n]:
        out.append({
            "id": pkg.id,
            "name": pkg.name,
            "duration": pkg.duration,
            "one_liner": pkg.one_liner,
            "match_score": score,
            "matched_signals": hits,
            "buyer_titles": list(pkg.typical_buyer_titles),
        })
    return out


def score_prospect(
    *,
    company: str,
    industry: str = "",
    geo: str = "",
    employee_range: str = "",
    signals: list[str] | None = None,
    notes: str = "",
    website: str = "",
) -> dict[str, Any]:
    """
    Composite ICP score 0–100 with package recommendations.

    Breakdown (max):
      industry 25 | geo 25 | size 20 | signals 30
    """
    signals = signals or []
    text = _blob(company, industry, geo, employee_range, notes, website, " ".join(signals))

    ind_pts, ind_match = _score_industry(text if industry else text)
    # if industry string provided, also try matching it directly
    if industry:
        direct, dm = _score_industry(industry.lower())
        if direct > ind_pts:
            ind_pts, ind_match = direct, dm or industry

    geo_pts = _score_geo(text)
    size_pts = _score_size(employee_range)
    sig_pts, found_signals = _score_signals(signals, text)

    total = min(100, ind_pts + geo_pts + size_pts + sig_pts)
    packages = recommend_packages(
        industry=industry,
        signals=found_signals,
        notes=notes,
        employee_range=employee_range,
    )

    tier = (
        "A" if total >= 70 else
        "B" if total >= 50 else
        "C" if total >= 30 else
        "D"
    )

    return {
        "company": company,
        "score": total,
        "tier": tier,
        "breakdown": {
            "industry": ind_pts,
            "geo": geo_pts,
            "size": size_pts,
            "signals": sig_pts,
        },
        "matched_industry": ind_match,
        "matched_signals": found_signals,
        "recommended_packages": packages,
        "primary_package": packages[0] if packages else None,
        "target_titles": (
            packages[0]["buyer_titles"] if packages else
            ["Head of People", "Director of Events", "VP Learning & Development"]
        ),
        "agent_note": _agent_note(tier, total, packages, found_signals),
    }


def _agent_note(tier: str, score: int, packages: list[dict], signals: list[str]) -> str:
    pkg_name = packages[0]["name"] if packages else "The Icebreaker"
    if tier == "A":
        return (
            f"Priority target (score {score}). Lead with {pkg_name}. "
            f"Build a tailored Gamma deck and draft a senior-tone outreach. "
            f"Signals: {', '.join(signals[:5]) or 'general culture/team-building fit'}."
        )
    if tier == "B":
        return (
            f"Solid fit (score {score}). Recommend {pkg_name}. "
            "Research one company-specific hook before drafting."
        )
    if tier == "C":
        return (
            f"Speculative (score {score}). Only pursue if a warm intro exists "
            f"or a clear trigger appears. Soft package: {pkg_name}."
        )
    return (
        f"Low fit (score {score}). Park in nurture unless new signals emerge."
    )
