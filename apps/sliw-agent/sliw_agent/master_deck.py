"""
Master corporate packages assets for outreach.

- Gamma site (existing): https://edyta-corporate-dance-866y3wq.gamma.site/
- Corporate page: https://edytasliwinska.com/corporate
- Optional PDF: uploaded via Sliw UI → served at /sliw/media/master-packages.pdf

Links go in the email body (never as cold-email attachments).
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .crm import DATA_DIR, ensure_dirs
from .talent_bible import TALENT

MASTER_META = DATA_DIR / "master_deck.json"
MASTER_PDF_PATH = DATA_DIR / "master_packages.pdf"
MASTER_PDF_PUBLIC_PATH = "/sliw/media/master-packages.pdf"

CORPORATE_PAGE = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
GAMMA_PACKAGES_SITE = (
    (os.environ.get("SLIW_MASTER_DECK_URL") or "").strip()
    or TALENT.get("package_site")
    or "https://edyta-corporate-dance-866y3wq.gamma.site/"
)


def get_master_deck_url() -> str:
    """Primary interactive deck = published Gamma packages site."""
    return GAMMA_PACKAGES_SITE.rstrip("/") + "/"


def get_corporate_page_url() -> str:
    return CORPORATE_PAGE


def master_pdf_exists() -> bool:
    ensure_dirs()
    return MASTER_PDF_PATH.is_file() and MASTER_PDF_PATH.stat().st_size > 0


def public_base_url(request_base: str | None = None) -> str:
    """Absolute site origin for email-safe PDF links."""
    for key in ("PUBLIC_BASE_URL", "SLIW_PUBLIC_BASE_URL", "RAILWAY_STATIC_URL"):
        raw = (os.environ.get(key) or "").strip().rstrip("/")
        if raw:
            if not raw.startswith("http"):
                raw = "https://" + raw
            return raw
    # Railway often sets RAILWAY_PUBLIC_DOMAIN without scheme
    domain = (os.environ.get("RAILWAY_PUBLIC_DOMAIN") or "").strip()
    if domain:
        return "https://" + domain.rstrip("/")
    if request_base:
        return str(request_base).rstrip("/")
    return ""


def get_pdf_url(request_base: str | None = None) -> str:
    """Public URL for the uploaded master PDF, if present."""
    ensure_dirs()
    # Explicit override wins
    env = (os.environ.get("SLIW_MASTER_DECK_PDF_URL") or "").strip()
    if env:
        return env
    if not master_pdf_exists():
        # meta may still have external url
        if MASTER_META.exists():
            try:
                data = json.loads(MASTER_META.read_text(encoding="utf-8"))
                url = (data.get("pdf_url") or "").strip()
                if url and not url.endswith(MASTER_PDF_PUBLIC_PATH):
                    return url
            except Exception:
                pass
        return ""
    base = public_base_url(request_base)
    if base:
        return base + MASTER_PDF_PUBLIC_PATH
    # Relative path works on-site; emails need absolute (set PUBLIC_BASE_URL)
    return MASTER_PDF_PUBLIC_PATH


def get_master_deck_meta(request_base: str | None = None) -> dict[str, Any]:
    ensure_dirs()
    pdf_url = get_pdf_url(request_base) or None
    meta = {
        "status": "published_site",
        "gamma_url": get_master_deck_url(),
        "gamma_site": get_master_deck_url(),
        "corporate_page": get_corporate_page_url(),
        "pdf_url": pdf_url,
        "pdf_uploaded": master_pdf_exists(),
        "pdf_bytes": MASTER_PDF_PATH.stat().st_size if master_pdf_exists() else 0,
        "pdf_public_path": MASTER_PDF_PUBLIC_PATH,
        "pdf_filename": "master_packages.pdf" if master_pdf_exists() else None,
        "note": (
            "Gamma packages site for interactive overview. "
            "Upload a master PDF in Sliw → Materials for a downloadable link in emails."
        ),
        "updated_at": datetime.utcnow().isoformat(),
    }
    try:
        # Preserve uploaded_at if we have a file
        if MASTER_META.exists():
            old = json.loads(MASTER_META.read_text(encoding="utf-8"))
            if old.get("pdf_uploaded_at") and master_pdf_exists():
                meta["pdf_uploaded_at"] = old["pdf_uploaded_at"]
            if old.get("pdf_original_name") and master_pdf_exists():
                meta["pdf_original_name"] = old["pdf_original_name"]
        MASTER_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass
    return meta


def ensure_master_deck(*, live: bool = False) -> dict[str, Any]:
    """No generation — uses published Gamma site + optional uploaded PDF."""
    return get_master_deck_meta()


def save_master_pdf(
    content: bytes,
    *,
    original_name: str = "master_packages.pdf",
    request_base: str | None = None,
) -> dict[str, Any]:
    """Save uploaded PDF to persistent data dir and refresh meta."""
    if not content:
        raise ValueError("Empty PDF upload")
    if not content[:5].startswith(b"%PDF"):
        # Allow if filename says pdf even if magic missing (some browsers)
        if not original_name.lower().endswith(".pdf"):
            raise ValueError("File does not look like a PDF")
    ensure_dirs()
    MASTER_PDF_PATH.write_bytes(content)
    meta = get_master_deck_meta(request_base)
    meta["pdf_uploaded"] = True
    meta["pdf_uploaded_at"] = datetime.utcnow().isoformat()
    meta["pdf_original_name"] = original_name
    meta["pdf_bytes"] = len(content)
    meta["pdf_url"] = get_pdf_url(request_base) or MASTER_PDF_PUBLIC_PATH
    meta["status"] = "published_site_with_pdf"
    MASTER_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def delete_master_pdf() -> dict[str, Any]:
    ensure_dirs()
    if MASTER_PDF_PATH.exists():
        MASTER_PDF_PATH.unlink()
    return get_master_deck_meta()


def email_asset_links(request_base: str | None = None) -> dict[str, str]:
    out = {
        "corporate_page": get_corporate_page_url(),
        "packages_deck": get_master_deck_url(),
    }
    pdf = get_pdf_url(request_base)
    if pdf:
        out["pdf"] = pdf
    return out
