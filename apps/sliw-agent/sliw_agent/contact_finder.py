"""
Corporate contact discovery for Sliw Agent.

1. Hunter.io Domain Search (HUNTER_API_KEY) — primary
2. Public page scrape (names/titles, rarely emails)
3. Role-inbox fallbacks only if Hunter finds nothing

Always returns diagnostics so the UI can show whether the key was seen.
"""

from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import quote_plus, urlparse

import requests

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
    "people", "people ops", "people operations", "human resources", " hr",
    "hr ", "chro", "talent", "employee experience", "employee engagement",
    "learning", "l&d", "l and d", "events", "event ", "wellness", "culture",
    "chief of staff", "workplace", "internal communications", "recruiting",
    "people partner", "hrbp", "benefits",
]


def _hunter_api_key() -> str:
    """Read key from several common Railway/env spellings; strip quotes/whitespace."""
    for name in (
        "HUNTER_API_KEY",
        "HUNTERIO_API_KEY",
        "HUNTER_KEY",
        "HUNTER_API",
    ):
        raw = os.environ.get(name)
        if raw is None:
            continue
        key = str(raw).strip().strip('"').strip("'")
        if key:
            return key
    return ""


def _domain_from_website(website: str, company: str = "") -> str:
    if website:
        u = website.strip()
        if not u.startswith("http"):
            u = "https://" + u
        try:
            host = urlparse(u).netloc.lower().removeprefix("www.")
            # careers.x.com → x.com when possible
            parts = host.split(".")
            if len(parts) > 2 and parts[0] in (
                "careers", "jobs", "about", "www", "ir", "investors", "blog",
            ):
                host = ".".join(parts[1:])
            if host and "." in host:
                return host
        except Exception:
            pass
    # Known overrides for library companies with awkward website fields
    overrides = {
        "stripe": "stripe.com",
        "airbnb": "airbnb.com",
        "salesforce": "salesforce.com",
        "google": "google.com",
        "meta": "meta.com",
        "openai": "openai.com",
        "anthropic": "anthropic.com",
        "notion": "notion.so",
        "figma": "figma.com",
        "block (square)": "block.xyz",
        "block": "block.xyz",
    }
    key = (company or "").strip().lower()
    if key in overrides:
        return overrides[key]
    for k, d in overrides.items():
        if k in key:
            return d
    slug = re.sub(r"[^a-z0-9]+", "", key)
    return f"{slug}.com" if slug else ""


def _parse_hunter_emails(emails: list[dict]) -> list[dict[str, Any]]:
    out = []
    for e in emails:
        pos = (e.get("position") or e.get("position_raw") or "").lower()
        dept = (e.get("department") or "").lower()
        score = 0
        if any(k in pos for k in ROLE_KEYWORDS) or dept in (
            "hr", "management", "executive", "operations", "communication",
        ):
            score += 5
        if e.get("confidence", 0) >= 70:
            score += 2
        if (e.get("type") or "") == "personal":
            score += 1
        if e.get("seniority") in ("senior", "executive"):
            score += 1
        first = (e.get("first_name") or "").strip()
        last = (e.get("last_name") or "").strip()
        name = f"{first} {last}".strip()
        email = (e.get("value") or "").strip()
        if not email:
            continue
        # Skip pure generic inboxes from Hunter if labeled generic (keep as low priority)
        is_generic = (e.get("type") or "") == "generic"
        if is_generic:
            score = max(0, score - 3)
        out.append({
            "name": name or email.split("@")[0].replace(".", " ").title(),
            "title": e.get("position") or e.get("position_raw") or e.get("department") or "",
            "email": email,
            "linkedin": e.get("linkedin") or "",
            "source": "hunter.io",
            "confidence": min(95, int(e.get("confidence") or 50) + score * 3),
            "role_fit_score": score,
            "department": e.get("department") or "",
            "type": e.get("type") or "",
        })
    out.sort(key=lambda x: (-x.get("role_fit_score", 0), -x.get("confidence", 0)))
    return out


def _hunter_domain_search(domain: str, company: str = "", limit: int = 10) -> dict[str, Any]:
    """
    Call Hunter Domain Search. Returns {contacts, diagnostics}.
    Does NOT invent role inboxes here.
    """
    key = _hunter_api_key()
    diag: dict[str, Any] = {
        "hunter_key_present": bool(key),
        "hunter_key_length": len(key),
        "domain": domain,
        "attempts": [],
    }
    if not key:
        diag["error"] = "HUNTER_API_KEY not visible to this process"
        return {"contacts": [], "diagnostics": diag}
    if not domain:
        diag["error"] = "No domain resolved for company"
        return {"contacts": [], "diagnostics": diag}

    # Simple open search first (most reliable). Then optional HR filter.
    # Avoid burning credits on empty department filters before open search.
    attempts = [
        {"domain": domain, "api_key": key, "limit": limit},
        {"domain": domain, "api_key": key, "limit": limit, "department": "hr"},
        {"domain": domain, "api_key": key, "limit": limit, "type": "personal"},
    ]
    # Also try company name if domain might be wrong
    if company:
        attempts.append({"company": company, "api_key": key, "limit": limit})

    all_contacts: list[dict[str, Any]] = []
    for params in attempts:
        label = {k: v for k, v in params.items() if k != "api_key"}
        try:
            r = requests.get(
                "https://api.hunter.io/v2/domain-search",
                params=params,
                timeout=30,
            )
            attempt_info: dict[str, Any] = {
                "params": label,
                "http_status": r.status_code,
            }
            if r.status_code != 200:
                try:
                    body = r.json()
                    attempt_info["error"] = body.get("errors") or body
                except Exception:
                    attempt_info["error"] = (r.text or "")[:180]
                diag["attempts"].append(attempt_info)
                continue
            data = r.json().get("data") or {}
            emails = data.get("emails") or []
            attempt_info["emails_returned"] = len(emails)
            attempt_info["organization"] = (data.get("organization") or "")[:80]
            diag["attempts"].append(attempt_info)
            parsed = _parse_hunter_emails(emails)
            if parsed:
                all_contacts.extend(parsed)
                # Good enough — stop spending more credits
                break
        except Exception as exc:
            diag["attempts"].append({"params": label, "error": str(exc)})

    # Dedup
    seen: set[str] = set()
    deduped = []
    for c in all_contacts:
        em = (c.get("email") or "").lower()
        if not em or em in seen:
            continue
        seen.add(em)
        deduped.append(c)
    deduped.sort(key=lambda x: (-x.get("role_fit_score", 0), -x.get("confidence", 0)))

    # Prefer role-fit; if none, still return real people from Hunter
    role_fit = [c for c in deduped if c.get("role_fit_score", 0) >= 4]
    contacts = (role_fit or deduped)[:10]
    diag["hunter_contacts"] = len(contacts)
    if not contacts:
        diag["error"] = (
            f"Hunter responded but found 0 emails for domain={domain}. "
            "Check domain spelling or Hunter coverage for this company."
        )
    return {"contacts": contacts, "diagnostics": diag}


def _scrape_team_page(website: str) -> list[dict[str, Any]]:
    if not website:
        return []
    base = website.strip().rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    paths = ["/about", "/about-us", "/company", "/team", "/leadership", "/people"]
    headers = {
        "User-Agent": "SliwAgent/1.0 (+corporate research; admin@edytasliwinska.com)",
        "Accept": "text/html",
    }
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    name_title = re.compile(
        r"([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3})\s*[,|\-–—|]\s*"
        r"((?:Head|VP|Vice President|Director|Chief|Manager|Lead)[^<\n|]{3,60})",
        re.I,
    )
    for path in paths:
        url = base + path
        try:
            r = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
            if r.status_code != 200:
                continue
            text = re.sub(r"<script[\s\S]*?</script>", " ", r.text, flags=re.I)
            text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
            text = re.sub(r"<[^>]+>", " | ", text)
            text = re.sub(r"\s+", " ", text)
            for m in name_title.finditer(text[:150000]):
                name, title = m.group(1).strip(), m.group(2).strip()
                if len(name) < 5 or name.lower() in seen:
                    continue
                if not any(k in title.lower() for k in ROLE_KEYWORDS):
                    continue
                seen.add(name.lower())
                found.append({
                    "name": name,
                    "title": title[:120],
                    "email": "",
                    "linkedin": "",
                    "source": f"scrape:{url}",
                    "confidence": 50,
                    "role_fit_score": 4,
                })
            if len(found) >= 5:
                break
        except Exception:
            continue
    return found


def _role_inbox_fallbacks(domain: str) -> list[dict[str, Any]]:
    if not domain:
        return []
    boxes = [
        ("People / HR team", "people@" + domain, "People Ops (guess)"),
        ("Events team", "events@" + domain, "Corporate events (guess)"),
        ("HR team", "hr@" + domain, "HR (guess)"),
    ]
    return [
        {
            "name": label,
            "title": title,
            "email": email,
            "linkedin": "",
            "source": "role_inbox_guess",
            "confidence": 20,
            "role_fit_score": 1,
            "note": "Guessed role inbox — not from Hunter",
        }
        for label, email, title in boxes
    ]


def linkedin_search_targets(company: str) -> list[dict[str, str]]:
    out = []
    for title in TITLE_TARGETS[:8]:
        q = f"{title} {company}"
        out.append({
            "title": title,
            "linkedin_search": f"https://www.linkedin.com/search/results/people/?keywords={quote_plus(q)}",
        })
    return out


def find_contacts(
    *,
    company: str,
    website: str = "",
    industry: str = "",
    package_id: str = "",
) -> dict[str, Any]:
    domain = _domain_from_website(website, company)
    hunter_result = _hunter_domain_search(domain, company=company, limit=10)
    hunter_contacts = hunter_result.get("contacts") or []
    diagnostics = hunter_result.get("diagnostics") or {}

    contacts: list[dict[str, Any]] = list(hunter_contacts)

    # Scrape only if Hunter found nothing useful
    if not hunter_contacts:
        contacts.extend(_scrape_team_page(website or (f"https://{domain}" if domain else "")))

    # Dedup
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in contacts:
        key = (c.get("email") or c.get("name") or "").lower().strip()
        if not key or key in seen:
            continue
        # drop empty hunter errors
        if c.get("source") == "hunter.io_error":
            continue
        seen.add(key)
        deduped.append(c)

    deduped.sort(key=lambda x: (-x.get("role_fit_score", 0), -x.get("confidence", 0)))

    hunter_personal = [c for c in deduped if c.get("source") == "hunter.io" and c.get("email")]
    if not hunter_personal:
        # Only then add role inboxes
        for rb in _role_inbox_fallbacks(domain):
            if rb["email"].lower() not in seen:
                deduped.append(rb)

    primary = next(
        (c for c in deduped if c.get("source") == "hunter.io" and c.get("email")),
        None,
    ) or next((c for c in deduped if c.get("email")), None) or (deduped[0] if deduped else {})

    summary = _method_summary(deduped, diagnostics, domain)

    return {
        "company": company,
        "domain": domain,
        "contacts": deduped[:12],
        "primary": primary,
        "linkedin_targets": linkedin_search_targets(company),
        "hunter_enabled": diagnostics.get("hunter_key_present", False),
        "hunter_diagnostics": diagnostics,
        "method_summary": summary,
    }


def _method_summary(
    contacts: list[dict],
    diagnostics: dict[str, Any],
    domain: str,
) -> str:
    key_ok = diagnostics.get("hunter_key_present")
    hunter_n = len([c for c in contacts if c.get("source") == "hunter.io" and c.get("email")])
    if not key_ok:
        return (
            "Hunter key NOT visible to this server process. "
            "On Railway: set HUNTER_API_KEY, then Redeploy (not just save)."
        )
    if hunter_n:
        return f"Hunter ✓ — {hunter_n} email(s) for {domain or 'domain'}."
    # Key present but no hits
    attempts = diagnostics.get("attempts") or []
    statuses = [a.get("http_status") for a in attempts if a.get("http_status")]
    errs = [a.get("error") for a in attempts if a.get("error")]
    if any(s == 401 for s in statuses):
        return "Hunter key rejected (401). Check the key value on Railway."
    if any(s == 429 for s in statuses):
        return "Hunter rate limit / out of credits (429)."
    if errs and not statuses:
        return f"Hunter request failed: {errs[0]}"
    if statuses and all(s == 200 for s in statuses):
        return (
            f"Hunter key is live, but 0 emails for domain “{domain}”. "
            "Try a company with a public domain, or check Hunter’s coverage."
        )
    if diagnostics.get("error"):
        return str(diagnostics["error"])
    return f"Hunter key present; no usable contacts for {domain}."
