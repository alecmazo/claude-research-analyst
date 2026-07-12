"""
Master corporate packages deck for outreach.

Uses Edyta's existing published Gamma presentation (not auto-generated junk):
  https://edyta-corporate-dance-866y3wq.gamma.site/

Also links the official corporate page. Links go in the email body only
(never as attachments — cold recipients ignore unknown attachments).
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

# Official sources of truth
CORPORATE_PAGE = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
# Existing high-quality Gamma package presentation on her site stack
GAMMA_PACKAGES_SITE = (
    (os.environ.get("SLIW_MASTER_DECK_URL") or "").strip()
    or TALENT.get("package_site")
    or "https://edyta-corporate-dance-866y3wq.gamma.site/"
)
# Optional PDF if she uploads one later (env or meta file)
PDF_URL = (os.environ.get("SLIW_MASTER_DECK_PDF_URL") or "").strip()


def get_master_deck_url() -> str:
    """Primary deck link for email body = published Gamma packages site."""
    return GAMMA_PACKAGES_SITE.rstrip("/") + "/"


def get_corporate_page_url() -> str:
    return CORPORATE_PAGE


def get_pdf_url() -> str:
    ensure_dirs()
    if PDF_URL:
        return PDF_URL
    if MASTER_META.exists():
        try:
            data = json.loads(MASTER_META.read_text(encoding="utf-8"))
            return (data.get("pdf_url") or "").strip()
        except Exception:
            pass
    return ""


def get_master_deck_meta() -> dict[str, Any]:
    ensure_dirs()
    meta = {
        "status": "published_site",
        "gamma_url": get_master_deck_url(),
        "gamma_site": get_master_deck_url(),
        "corporate_page": get_corporate_page_url(),
        "pdf_url": get_pdf_url() or None,
        "note": (
            "Uses Edyta's existing Gamma packages presentation. "
            "Put the link in the email body — do not attach files to cold email."
        ),
        "updated_at": datetime.utcnow().isoformat(),
    }
    # Persist so CRM / UI always resolve the same URLs
    try:
        MASTER_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass
    return meta


def ensure_master_deck(*, live: bool = False) -> dict[str, Any]:
    """
    No generation needed — the great deck already lives on Gamma.
    live=True is ignored (we do not regenerate and burn credits).
    """
    meta = get_master_deck_meta()
    if live:
        meta["note"] = (
            meta.get("note", "")
            + " Regeneration skipped — pointing at the existing published Gamma site."
        )
    return meta


def email_asset_links() -> dict[str, str]:
    """Links for email body blocks."""
    out = {
        "corporate_page": get_corporate_page_url(),
        "packages_deck": get_master_deck_url(),
    }
    pdf = get_pdf_url()
    if pdf:
        out["pdf"] = pdf
    return out
