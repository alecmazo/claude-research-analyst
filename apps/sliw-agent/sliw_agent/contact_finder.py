"""
Corporate contact discovery for Sliw Agent.

Order of operations:
  1. Hunter.io domain search (if HUNTER_API_KEY set) — best emails
  2. Clearbit-style free domain guess + role heuristics
  3. Public company page scrape (about/team/leadership/careers people)
  4. Structured "search targets" (LinkedIn query URLs + title map) always

Never invent a person's name as fact without a source. Low-confidence
guesses are labeled so the desk can still act (mailto role inboxes).
"""

from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import quote_plus, urlparse

import requests

# Buyer titles by package / general corporate
TITLE_TARGETS = [
    "Head of People",
    "VP People",
    "Chief People Officer",
    "CHRO",
    "Director of Employee Experience",
    "Head of Employee Experience",
    "Director of Events",
    "Corporate Event Manager",
    "VP Learning and Development",
    "Head of Talent Development",
    "Wellness Program Manager",
    "Chief of Staff",
    "Director of Culture",
]

ROLE_KEYWORDS = [
    "people", "people ops", "people operations", "human resources", "hr ",
    "chro", "talent", "employee experience", "employee engagement",
    "learning", "l&d", "events", "wellness", "culture", "chief of staff",
    "workplace", "internal communications",
]


def _domain_from_website(website: str, company: str = "") -> str:
    if website:
        u = website.strip()
        if not u.startswith("http"):
            u = "https://" + u
        try:
            host = urlparse(u).netloc.lower()
            host = host.removeprefix("www.")
            if host:
                return host
        except Exception:
            pass
    # crude slug
    slug = re.sub(r"[^a-z0-9]+", "", (company or "").lower())
    return f"{slug}.com" if slug else ""


def _hunter_domain_search(domain: str, limit: int = 8) -> list[dict[str, Any]]:
    key = (os.environ.get("HUNTER_API_KEY") or os.environ.get("HUNTERIO_API_KEY") or "").strip()
    if not key or not domain:
        return []
    try:
        r = requests.get(
            "https://api.hunter.io/v2/domain-search",
            params={
                "domain": domain,
                "api_key": key,
                "limit": limit,
                "seniority": "senior,executive",
            },
            timeout=25,
        )
        if r.status_code != 200:
            return []
        emails = (r.json().get("data") or {}).get("emails") or []
        out = []
        for e in emails:
            pos = (e.get("position") or "").lower()
            score = 0
            if any(k in pos for k in ROLE_KEYWORDS):
                score += 5
            if e.get("confidence", 0) >= 70:
                score += 2
            if e.get("type") == "personal":
                score += 1
            out.append({
                "name": f"{e.get('first_name') or ''} {e.get('last_name') or ''}".strip(),
                "title": e.get("position") or "",
                "email": e.get("value") or "",
                "linkedin": e.get("linkedin") or "",
                "source": "hunter.io",
                "confidence": min(95, int(e.get("confidence") or 50) + score * 3),
                "role_fit_score": score,
            })
        out.sort(key=lambda x: (-x.get("role_fit_score", 0), -x.get("confidence", 0)))
        return out
    except Exception:
        return []


def _scrape_team_page(website: str) -> list[dict[str, Any]]:
    """Best-effort scrape of public about/team pages for names + titles."""
    if not website:
        return []
    base = website.strip().rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    paths = [
        "",
        "/about",
        "/about-us",
        "/company",
        "/team",
        "/leadership",
        "/about/leadership",
        "/company/leadership",
        "/people",
    ]
    headers = {
        "User-Agent": "SliwAgent/1.0 (+corporate-events research; admin@edytasliwinska.com)",
        "Accept": "text/html,application/xhtml+xml",
    }
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Title-ish patterns near names in HTML text
    name_title = re.compile(
        r"([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3})\s*[,|\-–—|]\s*"
        r"((?:Head|VP|Vice President|Director|Chief|Manager|Lead|Partner)[^<\n|]{3,60})",
        re.I,
    )

    for path in paths:
        url = base + path
        try:
            r = requests.get(url, headers=headers, timeout=12, allow_redirects=True)
            if r.status_code != 200 or "text/html" not in (r.headers.get("content-type") or ""):
                continue
            text = re.sub(r"<script[\s\S]*?</script>", " ", r.text, flags=re.I)
            text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
            text = re.sub(r"<[^>]+>", " | ", text)
            text = re.sub(r"\s+", " ", text)
            for m in name_title.finditer(text[:200000]):
                name = m.group(1).strip()
                title = m.group(2).strip()
                if len(name) < 5 or len(name) > 50:
                    continue
                key = name.lower()
                if key in seen:
                    continue
                title_l = title.lower()
                if not any(k in title_l for k in ROLE_KEYWORDS):
                    continue
                seen.add(key)
                found.append({
                    "name": name,
                    "title": title[:120],
                    "email": "",
                    "linkedin": f"https://www.linkedin.com/search/results/people/?keywords={quote_plus(name + ' ' + (urlparse(base).netloc or ''))}",
                    "source": f"scrape:{url}",
                    "confidence": 55,
                    "role_fit_score": 4,
                })
            if len(found) >= 6:
                break
        except Exception:
            continue
    return found


def _role_inbox_fallbacks(domain: str) -> list[dict[str, Any]]:
    """Last resort: role inboxes (not personal — labeled low confidence)."""
    if not domain:
        return []
    boxes = [
        ("People / HR team", "people@" + domain, "People Ops inbox"),
        ("Events team", "events@" + domain, "Corporate events inbox"),
        ("HR team", "hr@" + domain, "HR inbox"),
        ("Culture / internal", "culture@" + domain, "Culture inbox"),
    ]
    return [
        {
            "name": label,
            "title": title,
            "email": email,
            "linkedin": "",
            "source": "role_inbox_guess",
            "confidence": 25,
            "role_fit_score": 1,
            "note": "Role inbox guess — verify before relying; prefer personal contact when found",
        }
        for label, email, title in boxes
    ]


def linkedin_search_targets(company: str) -> list[dict[str, str]]:
    """Always return LinkedIn people searches for target titles."""
    out = []
    for title in TITLE_TARGETS[:8]:
        q = f"{title} {company}"
        out.append({
            "title": title,
            "linkedin_search": f"https://www.linkedin.com/search/results/people/?keywords={quote_plus(q)}",
            "google_search": f"https://www.google.com/search?q={quote_plus(q + ' email OR linkedin')}",
        })
    return out


def find_contacts(
    *,
    company: str,
    website: str = "",
    industry: str = "",
    package_id: str = "",
) -> dict[str, Any]:
    """
    Discover best-effort buyer contacts for a corporation.
    Returns contacts sorted by role fit + confidence.
    """
    domain = _domain_from_website(website, company)
    contacts: list[dict[str, Any]] = []

    hunter = _hunter_domain_search(domain)
    contacts.extend(hunter)

    if len([c for c in contacts if c.get("role_fit_score", 0) >= 4]) < 2:
        contacts.extend(_scrape_team_page(website or f"https://{domain}"))

    # Dedup by email or name
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in contacts:
        key = (c.get("email") or c.get("name") or "").lower().strip()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(c)

    # Prefer people/events/L&D titles first
    def sort_key(c: dict) -> tuple:
        return (-c.get("role_fit_score", 0), -c.get("confidence", 0))

    deduped.sort(key=sort_key)

    # If still weak, add role inboxes as secondary options
    personal = [c for c in deduped if c.get("source") != "role_inbox_guess" and "@" in (c.get("email") or "")]
    if not personal:
        deduped.extend(_role_inbox_fallbacks(domain))

    primary = deduped[0] if deduped else None
    return {
        "company": company,
        "domain": domain,
        "contacts": deduped[:10],
        "primary": primary,
        "linkedin_targets": linkedin_search_targets(company),
        "hunter_enabled": bool(
            (os.environ.get("HUNTER_API_KEY") or os.environ.get("HUNTERIO_API_KEY") or "").strip()
        ),
        "method_summary": _method_summary(deduped),
    }


def _method_summary(contacts: list[dict]) -> str:
    sources = {c.get("source", "") for c in contacts}
    if any(str(s).startswith("hunter") for s in sources):
        return "Found via Hunter.io domain search (role-filtered)."
    if any(str(s).startswith("scrape") for s in sources):
        return "Found names/titles on public company pages; emails may still need verification."
    if any(s == "role_inbox_guess" for s in sources):
        return "No personal emails found — role inboxes suggested. Set HUNTER_API_KEY for better hit rates."
    return "No contacts found."
