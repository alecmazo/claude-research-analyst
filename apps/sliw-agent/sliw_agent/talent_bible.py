"""
Talent Bible — everything the Sliw Agent must know about Edyta Śliwińska.

Sourced from edytasliwinska.com (Corporate, About, Weddings, Contact)
and her existing Gamma package site:
https://edyta-corporate-dance-866y3wq.gamma.site/

Treat this as the "CAA book" for Edyta. Never invent credentials or
pricing that is not listed here. When uncertain, flag for human review.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# ── Identity ──────────────────────────────────────────────────────────────────

TALENT = {
    "legal_name": "Edyta Śliwińska",
    "stage_name": "Edyta Sliwinska",
    "headline": "Dancing with the Stars pro · Corporate team accelerator · Live stage producer",
    "brand_promise": (
        "Dance isn't just entertainment — it's the ultimate team accelerator. "
        "Star power, zero judgment, measurable connection."
    ),
    "website": "https://edytasliwinska.com",
    "corporate_page": "https://edytasliwinska.com/corporate",
    "package_site": "https://edyta-corporate-dance-866y3wq.gamma.site/",
    "about_page": "https://edytasliwinska.com/about",
    "contact_page": "https://edytasliwinska.com/contact-us",
    "email_public": "admin@edytasliwinska.com",
    "phone_primary": "+1 (218) 304-8372",
    "phone_local": "+1 (415) 891-7943",
    "studio_address": "1133 Francisco Blvd E, San Rafael, California 94901, United States",
    "primary_markets": [
        "San Francisco Bay Area",
        "San Rafael / Marin",
        "Silicon Valley",
        "Los Angeles (tour)",
        "National (travel for premium bookings)",
    ],
    "social": {
        "instagram": "https://www.instagram.com/edytasliwinska",
        "facebook": "https://www.facebook.com/69765313333",
        "x": "https://www.x.com/Edyta_Sliwinska",
        "yelp": "https://www.yelp.com/biz/QyWltKSAvYOCppmLm7dCZw",
    },
}


# ── Positioning (agent voice) ─────────────────────────────────────────────────

POSITIONING = """
Edyta Śliwińska is a world-renowned ballroom dancer, instructor, and fan-favorite
professional from Dancing with the Stars (Seasons 1–10+). For over two decades she
has taught celebrities with zero prior experience, choreographed and produced live
stage shows worldwide, and now channels that same star power into corporate events,
team-building workshops, and wellness programs.

THE HOOK (never lead with "dance class"):
  Corporate L&D, People Ops, and event buyers are drowning in forgettable icebreakers
  and trust falls. Edyta sells a *team accelerator* — 45–60 minutes of science-backed
  movement that spikes endorphins, cuts cortisol, and creates the shared memory
  every culture team wants and almost never gets.

THE PROOF:
  - DWTS pedigree (instant credibility with executives and employees)
  - Taught thousands of "two left feet" participants — zero judgment format
  - Scales 5 → 500, hybrid or in-person
  - Styles: Samba, Swing, Hip-Hop, Salsa, Cha-Cha, ballroom leadership metaphors
  - Live-show producer (Dancing Pros Live, Battle of The Voices, Dance Star, Dance Temptation)

THE ASK:
  Complimentary 15-minute discovery call → custom session proposal.
  Agent books the call; Edyta closes and delivers.
"""


# ── Corporate packages (from Gamma site + corporate page) ─────────────────────

@dataclass(frozen=True)
class Package:
    id: str
    name: str
    duration: str
    one_liner: str
    best_for: list[str]
    benefits: list[str]
    icp_signals: list[str]  # company signals that match this package
    typical_buyer_titles: list[str]


PACKAGES: dict[str, Package] = {
    "icebreaker": Package(
        id="icebreaker",
        name="The Icebreaker",
        duration="60–90 minute team bonding mixer",
        one_liner="Ultimate upgrade from a corporate happy hour — high-energy, zero-pressure movement that dissolves hierarchy.",
        best_for=[
            "All-hands meetings and department orientations",
            "Kickoff for company retreats",
            "Post-merger culture integration",
            "Holiday parties and milestone celebrations",
        ],
        benefits=[
            "Eliminates social awkwardness and hierarchical stiffness",
            "Builds immediate trust across departments",
            "Creates memorable shared company lore",
            "Boosts morale visibly and fast",
        ],
        icp_signals=[
            "recent merger or acquisition",
            "new hire cohort / orientation program",
            "all-hands culture",
            "holiday party planning",
            "offsite / retreat announced",
            "employee engagement survey focus",
        ],
        typical_buyer_titles=[
            "Head of People",
            "VP People Ops",
            "Director of Employee Experience",
            "Event Manager",
            "Chief of Staff",
            "Culture Lead",
        ],
    ),
    "leadership_ballroom": Package(
        id="leadership_ballroom",
        name="The Leadership Ballroom",
        duration="Half-day executive seminar",
        one_liner="Ballroom as a leadership lab — non-verbal communication, psychological safety, and pivoting under pressure.",
        best_for=[
            "Management and executive leadership retreats",
            "High-potential accelerator programs",
            "Orgs navigating rapid change or restructuring",
        ],
        benefits=[
            "Enhances non-verbal communication and active listening",
            "Builds cross-functional trust at leadership level",
            "Teaches graceful pivots under pressure",
            "Turns abstract leadership theory into lived experience",
        ],
        icp_signals=[
            "leadership offsite",
            "executive retreat",
            "HiPo / leadership development program",
            "reorg or restructuring",
            "change management initiative",
            "EQ / soft skills training budget",
        ],
        typical_buyer_titles=[
            "CHRO",
            "VP Learning & Development",
            "Head of Talent Development",
            "Chief People Officer",
            "Executive Coach (internal)",
            "CEO / Founder (small-mid)",
        ],
    ),
    "tech_decompress": Package(
        id="tech_decompress",
        name="The Tech-Decompress",
        duration="4-week weekly wellness series (60 min/week)",
        one_liner="Recurring lunchtime movement series that fights burnout in screen-heavy teams — progressive, social, addictive.",
        best_for=[
            "Tech / engineering / product orgs with burnout risk",
            "Wellness benefit programs seeking something employees actually use",
            "Hybrid teams needing recurring culture rituals",
        ],
        benefits=[
            "Combats burnout and screen fatigue",
            "Improves posture and sustainable energy",
            "Becomes a protected calendar ritual people look forward to",
            "Builds progressive competence and belonging",
        ],
        icp_signals=[
            "tech company",
            "engineering-heavy workforce",
            "wellness stipend / mental health focus",
            "burnout / retention crisis",
            "RTO or hybrid culture rebuilding",
            "employee wellness month",
        ],
        typical_buyer_titles=[
            "Wellness Program Manager",
            "Benefits Manager",
            "Head of People",
            "VP Engineering (culture owner)",
            "Employee Experience Lead",
        ],
    ),
    "office_stars": Package(
        id="office_stars",
        name='The "Dancing with the Office Stars"',
        duration="Premium holiday & gala package (+ private exec prep)",
        one_liner="Executives become the stars — private coaching, then a polished gala performance + company-wide interactive flash.",
        best_for=[
            "Annual holiday parties and year-end celebrations",
            "Company milestones and anniversary galas",
            "Charity galas and high-profile fundraisers",
            "Culture content moments worth filming",
        ],
        benefits=[
            "Unbeatable company culture content",
            "Massive employee engagement",
            "Executives model vulnerability and fun",
            "Legendary event employees talk about for years",
        ],
        icp_signals=[
            "holiday party RFP",
            "company anniversary",
            "gala fundraiser",
            "brand content / social-first culture",
            "large annual celebration budget",
        ],
        typical_buyer_titles=[
            "Director of Events",
            "Corporate Event Producer",
            "Chief Marketing Officer (culture content)",
            "Executive Assistant to CEO",
            "Foundation / CSR lead",
        ],
    ),
    "custom_lab": Package(
        id="custom_lab",
        name="The Custom Collaboration Lab",
        duration="Fully bespoke tailored workshop",
        one_liner="Co-designed from discovery — movement curriculum aimed at your specific friction, not a template.",
        best_for=[
            "Structural change or reorganization",
            "Newly formed or cross-functional teams",
            "Unique high-impact experiential asks",
            "DEI / belonging engagement goals",
        ],
        benefits=[
            "Directly addresses org-specific pain points",
            "Every minute strategically relevant",
            "Unmistakably tailored to culture and moment",
        ],
        icp_signals=[
            "post-merger integration",
            "new team formation",
            "cross-functional friction",
            "DEI programming",
            "bespoke experiential request",
            "innovation offsite",
        ],
        typical_buyer_titles=[
            "CHRO",
            "Chief of Staff",
            "Head of DEI",
            "VP People Ops",
            "Org Development lead",
        ],
    ),
}


# ── Ideal Customer Profile ────────────────────────────────────────────────────

ICP = {
    "company_size": {
        "sweet_spot_employees": "50–5,000",
        "also_target": "5,000+ for Icebreaker / Office Stars / multi-session Tech-Decompress",
        "avoid_unless_referral": "Under 20 with no event budget",
    },
    "industries_priority": [
        "Technology / SaaS / AI",
        "Biotech / life sciences (Bay Area)",
        "Financial services / fintech",
        "Professional services (law, consulting)",
        "Healthcare systems & health-tech",
        "Consumer brands with strong culture teams",
        "Media / entertainment",
        "Nonprofits & foundations running galas",
    ],
    "geo_priority": [
        "San Francisco / Peninsula / South Bay",
        "East Bay / Marin / North Bay",
        "LA / SoCal for premium packages",
        "National remote for Leadership Ballroom & Office Stars (travel ok)",
    ],
    "buyer_personas": [
        {
            "name": "People Ops Leader",
            "pain": "Engagement scores flat; offsites feel generic; retention risk",
            "package_fit": ["icebreaker", "tech_decompress", "custom_lab"],
        },
        {
            "name": "L&D / Talent Development",
            "pain": "Leadership programs are lecture-heavy; need experiential EQ",
            "package_fit": ["leadership_ballroom", "custom_lab"],
        },
        {
            "name": "Corporate Events / EA",
            "pain": "Holiday party must be unforgettable; same catering every year",
            "package_fit": ["office_stars", "icebreaker"],
        },
        {
            "name": "Wellness / Benefits",
            "pain": "Wellness perks unused; needs something social and sticky",
            "package_fit": ["tech_decompress"],
        },
        {
            "name": "Founder / CEO (growth stage)",
            "pain": "Culture diluted after hiring spree; wants iconic team moment",
            "package_fit": ["icebreaker", "office_stars", "custom_lab"],
        },
    ],
    "timing_triggers": [
        "Q4 holiday party planning (Aug–Nov)",
        "Q1 culture kickoff / all-hands",
        "Post-funding or post-IPO team growth",
        "Post-merger integration windows",
        "Announced offsites / retreats",
        "Wellness month / Mental Health Awareness (May)",
        "Women's leadership / ERG events",
        "Company anniversary milestones",
    ],
}


# ── Live shows & credentials (for prestige decks) ─────────────────────────────

CREDENTIALS = [
    "Professional on Dancing with the Stars (fan-favorite across first 10 seasons)",
    "20+ years professional ballroom & performance experience",
    "Expert at teaching complete beginners (celebrities → corporate teams)",
    "Executive produced & choreographed: Dancing Pros Live, Battle of The Voices, Dance Star, Dance Temptation",
    "Based in San Rafael, CA — Dance Sport studio; serves Bay Area + national clients",
]


# ── Agent operating principles (CAA / WME style) ──────────────────────────────

AGENT_MANDATE = """
You are the Sliw Agent — Edyta Śliwińska's corporate representation desk.
Think CAA / William Morris for experiential talent: protect the brand, package
the talent for the right rooms, open doors, and only put Edyta on calls that
are real opportunities.

RULES:
1. NEVER send outreach without human approval (draft → approve → send).
2. NEVER invent pricing, availability, or past client logos not in the bible.
3. ALWAYS personalize: company news + package fit + specific buyer pain.
4. ALWAYS propose a clear next step: 15-min discovery call with Edyta.
5. QUALIFY hard: budget owner? date window? headcount? location? decision process?
6. FILTER: only interested, decision-capable leads reach Edyta's calendar.
7. REPRESENT, don't spam: fewer perfect pitches beat 500 generic emails.
8. PROTECT scarcity: premium packaging, not discount dance instructor framing.
9. LOG everything in the CRM (prospect → package → deck → outreach → reply → stage).
10. When a lead is warm, prepare a one-page brief for Edyta before the call.
"""


def package_catalog_markdown() -> str:
    lines = ["# Edyta Corporate Package Catalog\n"]
    for p in PACKAGES.values():
        lines.append(f"## {p.name} (`{p.id}`)")
        lines.append(f"**Duration:** {p.duration}")
        lines.append(f"**One-liner:** {p.one_liner}")
        lines.append("**Best for:** " + "; ".join(p.best_for))
        lines.append("**Buyer titles:** " + ", ".join(p.typical_buyer_titles))
        lines.append("")
    return "\n".join(lines)


def talent_brief_markdown() -> str:
    """Full brief injected into LLM prompts and Gamma generators."""
    return f"""# Talent Brief — Edyta Śliwińska

## Identity
- Name: {TALENT['legal_name']} ({TALENT['stage_name']})
- Headline: {TALENT['headline']}
- Brand promise: {TALENT['brand_promise']}
- Website: {TALENT['website']}
- Corporate: {TALENT['corporate_page']}
- Package site: {TALENT['package_site']}
- Contact: {TALENT['email_public']} · {TALENT['phone_primary']}
- Studio: {TALENT['studio_address']}
- Markets: {', '.join(TALENT['primary_markets'])}

## Positioning
{POSITIONING.strip()}

## Credentials
{chr(10).join('- ' + c for c in CREDENTIALS)}

## Packages
{package_catalog_markdown()}

## ICP summary
- Size: {ICP['company_size']['sweet_spot_employees']}
- Industries: {', '.join(ICP['industries_priority'])}
- Geo: {', '.join(ICP['geo_priority'])}
- Triggers: {', '.join(ICP['timing_triggers'])}
"""


def package_to_dict(pkg: Package) -> dict[str, Any]:
    return {
        "id": pkg.id,
        "name": pkg.name,
        "duration": pkg.duration,
        "one_liner": pkg.one_liner,
        "best_for": list(pkg.best_for),
        "benefits": list(pkg.benefits),
        "icp_signals": list(pkg.icp_signals),
        "typical_buyer_titles": list(pkg.typical_buyer_titles),
    }
