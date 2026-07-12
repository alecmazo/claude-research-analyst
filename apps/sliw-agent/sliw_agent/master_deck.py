"""
Master corporate packages assets for outreach.

- Gamma site: https://edyta-corporate-dance-866y3wq.gamma.site/
- Corporate page: https://edytasliwinska.com/corporate
- Master PDF: uploaded via Materials → /sliw/media/master-packages.pdf

PDF is written to the persistent data dir (STOCKS_FOLDER/sliw-agent when set)
so it survives redeploys on Railway.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .talent_bible import TALENT

MASTER_PDF_PUBLIC_PATH = "/sliw/media/master-packages.pdf"
CORPORATE_PAGE = TALENT.get("corporate_page") or "https://edytasliwinska.com/corporate"
GAMMA_PACKAGES_SITE = (
    (os.environ.get("SLIW_MASTER_DECK_URL") or "").strip()
    or TALENT.get("package_site")
    or "https://edyta-corporate-dance-866y3wq.gamma.site/"
)


def data_dir() -> Path:
    """Resolve at call time so env vars from Railway are always honored."""
    from .crm import ensure_dirs
    dedicated = (os.environ.get("SLIW_DATA_DIR") or "").strip()
    if dedicated:
        p = Path(dedicated)
    else:
        stocks = (os.environ.get("STOCKS_FOLDER") or "").strip()
        if stocks:
            p = Path(stocks) / "sliw-agent"
        else:
            p = Path(__file__).resolve().parent.parent / "data"
    p.mkdir(parents=True, exist_ok=True)
    ensure_dirs()
    return p


def master_pdf_path() -> Path:
    return data_dir() / "master_packages.pdf"


def master_meta_path() -> Path:
    return data_dir() / "master_deck.json"


# Back-compat aliases used by server mount
@property  # type: ignore
def _legacy():
    pass


def MASTER_PDF_PATH() -> Path:  # noqa: N802 — keep import name stable
    return master_pdf_path()


# Module-level name expected by api.server: MASTER_PDF_PATH as Path-like callable fix
# We export a property-like Path that resolves dynamically via a Path subclass isn't easy.
# api.server imports MASTER_PDF_PATH — update it to call master_pdf_path().


def get_master_deck_url() -> str:
    return GAMMA_PACKAGES_SITE.rstrip("/") + "/"


def get_corporate_page_url() -> str:
    return CORPORATE_PAGE


def master_pdf_exists() -> bool:
    p = master_pdf_path()
    try:
        return p.is_file() and p.stat().st_size > 100
    except OSError:
        return False


def public_base_url(request_base: str | None = None) -> str:
    for key in ("PUBLIC_BASE_URL", "SLIW_PUBLIC_BASE_URL", "RAILWAY_STATIC_URL"):
        raw = (os.environ.get(key) or "").strip().rstrip("/")
        if raw:
            if not raw.startswith("http"):
                raw = "https://" + raw
            return raw
    domain = (os.environ.get("RAILWAY_PUBLIC_DOMAIN") or "").strip()
    if domain:
        return "https://" + domain.rstrip("/")
    if request_base:
        # strip trailing slash; request.base_url may include path
        base = str(request_base).rstrip("/")
        # If base_url is https://host/ something weird, keep origin only
        try:
            from urllib.parse import urlparse
            u = urlparse(base if "://" in base else "https://" + base)
            if u.scheme and u.netloc:
                return f"{u.scheme}://{u.netloc}"
        except Exception:
            pass
        return base
    return ""


def get_pdf_url(request_base: str | None = None) -> str:
    env = (os.environ.get("SLIW_MASTER_DECK_PDF_URL") or "").strip()
    if env:
        return env
    if not master_pdf_exists():
        # external URL only
        try:
            data = json.loads(master_meta_path().read_text(encoding="utf-8"))
            url = (data.get("pdf_url") or "").strip()
            if url and MASTER_PDF_PUBLIC_PATH not in url and url.startswith("http"):
                return url
        except Exception:
            pass
        return ""
    base = public_base_url(request_base)
    if base:
        return base + MASTER_PDF_PUBLIC_PATH
    return MASTER_PDF_PUBLIC_PATH


def get_master_deck_meta(request_base: str | None = None) -> dict[str, Any]:
    exists = master_pdf_exists()
    pdf_path = master_pdf_path()
    pdf_url = get_pdf_url(request_base) if exists else (get_pdf_url(request_base) or None)

    # Re-read preserved fields
    old: dict[str, Any] = {}
    try:
        if master_meta_path().exists():
            old = json.loads(master_meta_path().read_text(encoding="utf-8"))
    except Exception:
        old = {}

    meta: dict[str, Any] = {
        "status": "published_site_with_pdf" if exists else "published_site",
        "gamma_url": get_master_deck_url(),
        "gamma_site": get_master_deck_url(),
        "corporate_page": get_corporate_page_url(),
        "pdf_url": pdf_url if exists or (pdf_url and str(pdf_url).startswith("http")) else (pdf_url if exists else None),
        "pdf_uploaded": exists,
        "pdf_bytes": pdf_path.stat().st_size if exists else 0,
        "pdf_public_path": MASTER_PDF_PUBLIC_PATH,
        "pdf_filename": old.get("pdf_original_name") or ("master_packages.pdf" if exists else None),
        "pdf_original_name": old.get("pdf_original_name") if exists else None,
        "pdf_uploaded_at": old.get("pdf_uploaded_at") if exists else None,
        "pdf_preview_url": (pdf_url or MASTER_PDF_PUBLIC_PATH) if exists else None,
        "data_dir": str(data_dir()),
        "pdf_storage_path": str(pdf_path),
        "note": (
            "Gamma site for interactive packages. Upload master PDF below for a "
            "downloadable link in emails (not attached)."
        ),
        "updated_at": datetime.utcnow().isoformat(),
    }
    if exists and not meta.get("pdf_url"):
        meta["pdf_url"] = MASTER_PDF_PUBLIC_PATH
        meta["pdf_preview_url"] = MASTER_PDF_PUBLIC_PATH

    try:
        master_meta_path().write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass
    return meta


def ensure_master_deck(*, live: bool = False) -> dict[str, Any]:
    return get_master_deck_meta()


def save_master_pdf(
    content: bytes,
    *,
    original_name: str = "master_packages.pdf",
    request_base: str | None = None,
) -> dict[str, Any]:
    if not content or len(content) < 100:
        raise ValueError("Empty or tiny file — expected a real PDF")
    # Soft check: PDF magic or .pdf name
    if not content[:8].startswith(b"%PDF") and not original_name.lower().endswith(".pdf"):
        raise ValueError("File does not look like a PDF")

    path = master_pdf_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)

    # Verify write stuck
    if not path.is_file() or path.stat().st_size < 100:
        raise ValueError(f"Failed to write PDF to {path}")

    uploaded_at = datetime.utcnow().isoformat()
    meta = {
        "status": "published_site_with_pdf",
        "gamma_url": get_master_deck_url(),
        "gamma_site": get_master_deck_url(),
        "corporate_page": get_corporate_page_url(),
        "pdf_url": get_pdf_url(request_base) or MASTER_PDF_PUBLIC_PATH,
        "pdf_preview_url": get_pdf_url(request_base) or MASTER_PDF_PUBLIC_PATH,
        "pdf_uploaded": True,
        "pdf_bytes": path.stat().st_size,
        "pdf_public_path": MASTER_PDF_PUBLIC_PATH,
        "pdf_filename": original_name,
        "pdf_original_name": original_name,
        "pdf_uploaded_at": uploaded_at,
        "data_dir": str(data_dir()),
        "pdf_storage_path": str(path),
        "note": "Master PDF on disk. Linked in new outreach emails.",
        "updated_at": uploaded_at,
    }
    master_meta_path().write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def delete_master_pdf() -> dict[str, Any]:
    p = master_pdf_path()
    if p.exists():
        p.unlink()
    return get_master_deck_meta()


def email_asset_links(request_base: str | None = None) -> dict[str, str]:
    out = {
        "corporate_page": get_corporate_page_url(),
        "packages_deck": get_master_deck_url(),
    }
    pdf = get_pdf_url(request_base)
    if pdf and master_pdf_exists():
        out["pdf"] = pdf
    return out


# Compatibility for `from master_deck import MASTER_PDF_PATH`
class _PdfPathProxy:
    def __fspath__(self) -> str:
        return str(master_pdf_path())

    def __str__(self) -> str:
        return str(master_pdf_path())

    def exists(self) -> bool:
        return master_pdf_exists()

    def is_file(self) -> bool:
        return master_pdf_exists()

    def resolve(self) -> Path:
        return master_pdf_path().resolve()


MASTER_PDF_PATH = _PdfPathProxy()  # type: ignore
