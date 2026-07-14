"""
Sliw Agent web API.

Modes:
  1) Standalone local desk:
       cd apps/sliw-agent && python -m uvicorn sliw_agent.server:app --port 8787
       Routes at /api/*  (e.g. /api/health)

  2) Mounted into DGA Railway app (api.server):
       app.include_router(create_api_router(), prefix="/api/sliw")
       Routes at /api/sliw/*  (e.g. /api/sliw/health)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import crm
from .pipeline import batch_score_seed, mark_interested, run_prospect_pipeline
from .lead_engine import (
    build_sequences_for_prospect,
    edyta_home,
    import_from_library,
    import_all_pending,
    library_stats,
    list_library_with_status,
    this_week_checklist,
    bulk_import_rows,
    refresh_leads_agent,
    workstream_for_prospect,
    top_ready_to_contact,
)
from .sales_agent import run_sales_agent, run_sales_agent_batch, escalate_to_edyta, prepare_followup
from .contact_finder import find_contacts
from .master_deck import (
    ensure_master_deck,
    get_master_deck_meta,
    get_master_deck_url,
    save_master_pdf,
    delete_master_pdf,
    master_pdf_exists,
    master_pdf_path,
)
from .wedding_agent import (
    import_wedding_library,
    run_wedding_pipeline,
    run_wedding_sales_agent,
    seed_default_partnerships,
    wedding_ready_list,
)
from .wedding_bible import WEDDING_PACKAGES, package_to_dict as wedding_pkg_dict
from .talent_bible import (
    CREDENTIALS,
    ICP,
    PACKAGES,
    POSITIONING,
    TALENT,
    package_to_dict,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


# ── Models ────────────────────────────────────────────────────────────────────

class PipelineRequest(BaseModel):
    company: str
    industry: str = ""
    geo: str = ""
    employee_range: str = ""
    website: str = ""
    notes: str = ""
    signals: list[str] = Field(default_factory=list)
    custom_hook: str = ""
    contact_name: str = ""
    contact_title: str = ""
    contact_email: str = ""
    contact_linkedin: str = ""
    generate_gamma: bool = False
    live_gamma: bool = False
    draft_email: bool = True
    book: str = "corporate"


class LibraryImportRequest(BaseModel):
    limit: int = 10000
    min_priority: int = 0
    draft_email: bool = False


class RefreshLeadsRequest(BaseModel):
    auto_import: bool = True
    draft_email: bool = False


class SalesAgentRequest(BaseModel):
    live_gamma: bool = False
    marketing_mode: str | None = None  # portfolio | light | full
    build_sequences: bool = True


class SalesAgentBatchRequest(BaseModel):
    limit: int = 5
    live_gamma: bool = False
    prospect_ids: list[str] = Field(default_factory=list)


class ContactUpdateRequest(BaseModel):
    name: str = ""
    title: str = ""
    email: str = ""
    linkedin: str = ""


class BulkImportRequest(BaseModel):
    rows: list[dict] = Field(default_factory=list)
    draft_email: bool = True


class WeddingPipelineRequest(BaseModel):
    name: str
    industry: str = "Wedding couple"
    geo: str = ""
    notes: str = ""
    signals: list[str] = Field(default_factory=list)
    package_hint: str = ""
    custom_hook: str = ""
    contact_name: str = ""
    contact_email: str = ""
    draft_email: bool = True
    generate_gamma: bool = False
    live_gamma: bool = False


class PartnerRequest(BaseModel):
    name: str
    type: str = "other"
    geo: str = ""
    notes: str = ""
    contact_email: str = ""
    status: str = "prospect"


class InterestedRequest(BaseModel):
    reply_text: str = ""
    reply_summary: str = ""


class StageRequest(BaseModel):
    stage: str
    note: str = ""


# ── Access control (Railway / shared login) ───────────────────────────────────
# Hard default: ONLY Alec + Edyta. Override with SLIW_ALLOWED_EMAILS if needed.
# Being GP/admin alone is NOT enough — other DGA logins must not use this desk.

_DEFAULT_SLIW_EMAILS = "alecmazo1@gmail.com,edytasliw@gmail.com"


def _allowed_emails() -> set[str]:
    raw = os.environ.get("SLIW_ALLOWED_EMAILS", _DEFAULT_SLIW_EMAILS)
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def require_sliw_access(request: Request) -> dict[str, Any]:
    """Allow only allowlisted emails (default: Alec + Edyta)."""
    claims = getattr(request.state, "auth_claims", None)
    if not claims:
        # Local double-click desk (no DGA auth middleware). Never on Railway.
        if (os.environ.get("SLIW_STANDALONE") or "").strip().lower() in (
            "1", "true", "yes", "on",
        ):
            return {"role": "local", "name": "Local desk", "email": ""}
        raise HTTPException(
            status_code=403,
            detail="Sliw Agent requires a DGA email login (Alec or Edyta only).",
        )

    email = (claims.get("email") or "").lower().strip()
    if email and email in _allowed_emails():
        return claims

    raise HTTPException(
        status_code=403,
        detail="Sliw Agent is only available to authorized desk accounts.",
    )


# ── Router factory ────────────────────────────────────────────────────────────

def create_api_router() -> APIRouter:
    """API routes only — mount at /api (local) or /api/sliw (Railway)."""
    r = APIRouter(tags=["sliw-agent"])

    @r.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "agent": "sliw"}

    @r.get("/me")
    def me(request: Request) -> dict[str, Any]:
        claims = require_sliw_access(request)
        return {
            "ok": True,
            "name": claims.get("name") or claims.get("email") or "Desk",
            "role": claims.get("role"),
            "email": claims.get("email"),
        }

    @r.get("/talent")
    def talent(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return {
            "talent": TALENT,
            "positioning": POSITIONING.strip(),
            "credentials": CREDENTIALS,
            "icp": ICP,
            "packages": [package_to_dict(p) for p in PACKAGES.values()],
            "wedding_packages": [wedding_pkg_dict(p) for p in WEDDING_PACKAGES.values()],
        }

    @r.get("/pipeline/summary")
    def pipeline_summary(request: Request, book: str = "corporate") -> dict[str, Any]:
        require_sliw_access(request)
        summary = crm.pipeline_summary(book=book)
        prospects = crm.list_prospects(book=book)
        leads = crm.interested_leads(book=book)
        scores = [p.get("score") or 0 for p in prospects if p.get("score") is not None]
        avg = round(sum(scores) / len(scores), 1) if scores else 0.0
        tier_counts = {"A": 0, "B": 0, "C": 0, "D": 0}
        for p in prospects:
            t = p.get("tier") or "?"
            if t in tier_counts:
                tier_counts[t] += 1
        return {
            "stages": summary,
            "total": len(prospects),
            "leads": len(leads),
            "avg_score": avg,
            "tiers": tier_counts,
            "updated_at": crm.load_crm(book).get("updated_at"),
            "data_dir": str(crm.DATA_DIR),
            "book": book,
        }

    @r.get("/prospects")
    def list_prospects(
        request: Request,
        stage: Optional[str] = None,
        min_score: Optional[float] = None,
        book: str = "corporate",
    ) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.list_prospects(stage=stage, min_score=min_score, book=book)

    @r.get("/prospects/{prospect_id}")
    def get_prospect(prospect_id: str, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        p = crm.get_prospect(prospect_id)
        if not p:
            raise HTTPException(404, "Prospect not found")
        extras: dict[str, Any] = {}
        op = p.get("outreach_path")
        if op and Path(op).exists():
            try:
                extras["outreach"] = json.loads(Path(op).read_text(encoding="utf-8"))
                md = Path(op).with_suffix(".md")
                if md.exists():
                    extras["outreach_md"] = md.read_text(encoding="utf-8")
            except Exception:
                pass
        bp = p.get("edyta_brief_path")
        if bp and Path(bp).exists():
            try:
                extras["brief_md"] = Path(bp).read_text(encoding="utf-8")
            except Exception:
                pass
        return {**p, **extras}

    @r.post("/prospects/pipeline")
    def run_pipeline(body: PipelineRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        contacts = []
        if body.contact_name or body.contact_email:
            contacts.append({
                "name": body.contact_name,
                "title": body.contact_title,
                "email": body.contact_email,
                "linkedin": body.contact_linkedin,
            })
        try:
            return run_prospect_pipeline(
                company=body.company.strip(),
                industry=body.industry,
                geo=body.geo,
                employee_range=body.employee_range,
                website=body.website,
                notes=body.notes,
                signals=body.signals,
                contacts=contacts,
                custom_hook=body.custom_hook,
                generate_gamma=body.generate_gamma or body.live_gamma,
                dry_run_gamma=not body.live_gamma,
                draft_email=body.draft_email,
                book=getattr(body, "book", None) or "corporate",
            )
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.post("/prospects/{prospect_id}/stage")
    def set_stage(prospect_id: str, body: StageRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return crm.set_stage(prospect_id, body.stage, note=body.note)
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.post("/prospects/{prospect_id}/interested")
    def mark_lead(prospect_id: str, body: InterestedRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return mark_interested(
                prospect_id,
                reply_text=body.reply_text,
                reply_summary=body.reply_summary,
            )
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None

    @r.get("/leads")
    def leads(request: Request, book: str = "corporate") -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.interested_leads(book=book)

    @r.post("/seed")
    def seed(request: Request) -> dict[str, Any]:
        """Legacy small seed + prefer Lead Engine library import."""
        require_sliw_access(request)
        results = batch_score_seed()
        eng = import_all_pending(draft_email=False)
        return {
            "count": len(results) + eng.get("imported", 0),
            "legacy_seed": len(results),
            "library_import": eng,
            "summary": crm.pipeline_summary(),
            "prospects": crm.list_prospects(),
        }

    @r.get("/outreach")
    def list_outreach(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        crm.ensure_dirs()
        items = []
        for path in sorted(crm.OUTREACH_DIR.glob("*.json"), reverse=True):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["_path"] = str(path)
                items.append(data)
            except Exception:
                continue
        return items[:50]

    @r.get("/briefs")
    def list_briefs(request: Request) -> list[dict[str, str]]:
        require_sliw_access(request)
        crm.ensure_dirs()
        items = []
        for path in sorted(crm.BRIEFS_DIR.glob("*.md"), reverse=True):
            items.append({
                "name": path.name,
                "path": str(path),
                "content": path.read_text(encoding="utf-8"),
            })
        return items


    # ── Lead Engine / Phase 1–2 ─────────────────────────────────────────────

    @r.get("/library/stats")
    def lib_stats(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return library_stats()

    @r.get("/library")
    def lib_list(request: Request) -> dict[str, Any]:
        """Full qualified library with scores + CRM status."""
        require_sliw_access(request)
        rows = list_library_with_status()
        return {
            "total": len(rows),
            "in_crm": sum(1 for r in rows if r.get("in_crm")),
            "pending": sum(1 for r in rows if not r.get("in_crm")),
            "tier_a": sum(1 for r in rows if (r.get("qualification") or {}).get("tier") == "A"),
            "rows": rows,
        }

    @r.post("/library/import")
    def lib_import(body: LibraryImportRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        # Default: import everything pending (no linger)
        if body.limit >= 1000:
            return import_all_pending(draft_email=body.draft_email)
        return import_from_library(
            limit=body.limit,
            min_priority=body.min_priority,
            draft_email=body.draft_email,
        )

    @r.post("/library/import-all")
    def lib_import_all(request: Request, draft_email: bool = False) -> dict[str, Any]:
        require_sliw_access(request)
        return import_all_pending(draft_email=draft_email)

    @r.post("/leads/refresh")
    def leads_refresh(body: RefreshLeadsRequest, request: Request) -> dict[str, Any]:
        """Launch discovery agent: find more companies → qualify → import to CRM."""
        require_sliw_access(request)
        return refresh_leads_agent(
            auto_import=body.auto_import,
            draft_email=body.draft_email,
        )

    @r.get("/work/ready")
    def work_ready(request: Request, limit: int = 5) -> dict[str, Any]:
        require_sliw_access(request)
        return {"items": top_ready_to_contact(limit=limit)}

    @r.get("/prospects/{prospect_id}/workstream")
    def workstream(prospect_id: str, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return workstream_for_prospect(prospect_id)
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None

    @r.post("/prospects/{prospect_id}/contact")
    def save_contact(prospect_id: str, body: ContactUpdateRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        p = crm.get_prospect(prospect_id)
        if not p:
            raise HTTPException(404, "Prospect not found")
        contact = {
            "name": body.name,
            "title": body.title,
            "email": body.email,
            "linkedin": body.linkedin,
        }
        crm.update_prospect(
            prospect_id,
            book=p.get("book") or "corporate",
            contacts=[contact],
        )
        return workstream_for_prospect(prospect_id)

    @r.post("/prospects/{prospect_id}/find-contacts")
    def api_find_contacts(prospect_id: str, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        p = crm.get_prospect(prospect_id)
        if not p:
            raise HTTPException(404, "Prospect not found")
        result = find_contacts(
            company=p.get("company") or "",
            website=p.get("website") or "",
            industry=p.get("industry") or "",
        )
        if result.get("contacts"):
            crm.update_prospect(
                prospect_id,
                book=p.get("book") or "corporate",
                contacts=result["contacts"][:12],
                contact_research=result.get("method_summary"),
                linkedin_targets=result.get("linkedin_targets"),
            )
        return result

    @r.post("/prospects/{prospect_id}/sales-agent")
    def api_sales_agent(
        prospect_id: str,
        body: SalesAgentRequest,
        request: Request,
    ) -> dict[str, Any]:
        """Find contacts + choose pitch mode + draft outreach (core automation)."""
        require_sliw_access(request)
        try:
            return run_sales_agent(
                prospect_id,
                marketing_mode=body.marketing_mode,
                live_gamma=body.live_gamma,
                build_sequences=body.build_sequences,
            )
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.post("/sales-agent/batch")
    def api_sales_agent_batch(body: SalesAgentBatchRequest, request: Request) -> dict[str, Any]:
        """Run corporate sales agent on top N ready prospects."""
        require_sliw_access(request)
        return run_sales_agent_batch(
            prospect_ids=body.prospect_ids or None,
            limit=body.limit,
            live_gamma=body.live_gamma,
        )

    @r.post("/prospects/{prospect_id}/escalate-edyta")
    def api_escalate(
        prospect_id: str,
        body: InterestedRequest,
        request: Request,
    ) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return escalate_to_edyta(
                prospect_id,
                reply_text=body.reply_text,
                reply_summary=body.reply_summary,
            )
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None

    @r.post("/prospects/{prospect_id}/followup")
    def api_followup(prospect_id: str, request: Request) -> dict[str, Any]:
        """Second email only after cold was marked contacted."""
        require_sliw_access(request)
        try:
            return prepare_followup(prospect_id)
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.get("/debug/hunter")
    def debug_hunter(request: Request, domain: str = "stripe.com") -> dict[str, Any]:
        """Confirm Hunter key is present (never returns the key) + probe a domain."""
        require_sliw_access(request)
        from .contact_finder import _hunter_api_key, find_contacts
        key = _hunter_api_key()
        out: dict[str, Any] = {
            "hunter_key_present": bool(key),
            "hunter_key_length": len(key) if key else 0,
            "env_names_checked": [
                "HUNTER_API_KEY", "HUNTERIO_API_KEY", "HUNTER_KEY", "HUNTER_API",
            ],
        }
        if key:
            try:
                sample = find_contacts(
                    company=domain.split(".")[0].title(),
                    website=f"https://{domain}",
                )
                out["probe_domain"] = sample.get("domain")
                out["probe_method"] = sample.get("method_summary")
                out["hunter_diagnostics"] = sample.get("hunter_diagnostics")
                out["probe_count_hunter"] = len([
                    c for c in (sample.get("contacts") or [])
                    if c.get("email") and c.get("source") == "hunter.io"
                ])
                out["probe_sample"] = [
                    {
                        "name": c.get("name"),
                        "email": c.get("email"),
                        "title": c.get("title"),
                        "source": c.get("source"),
                    }
                    for c in (sample.get("contacts") or [])[:5]
                    if c.get("email")
                ]
            except Exception as exc:
                out["probe_error"] = str(exc)
        else:
            out["hint"] = (
                "Key not visible in this process. On Railway: Variables → HUNTER_API_KEY → "
                "Redeploy the service (Save alone is not enough)."
            )
        return out

    @r.get("/master-deck")
    def api_master_deck(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        base = str(request.base_url).rstrip("/")
        return get_master_deck_meta(request_base=base)

    @r.post("/master-deck")
    def api_master_deck_build(request: Request, live: bool = False) -> dict[str, Any]:
        """Refresh meta (Gamma site is fixed; no generation)."""
        require_sliw_access(request)
        base = str(request.base_url).rstrip("/")
        return get_master_deck_meta(request_base=base)

    @r.post("/master-deck/pdf")
    async def api_upload_master_pdf(
        request: Request,
        file: UploadFile = File(...),
    ) -> dict[str, Any]:
        """Upload master packages PDF (shown in Materials + linked in emails)."""
        require_sliw_access(request)
        name = file.filename or "master_packages.pdf"
        if not name.lower().endswith(".pdf"):
            raise HTTPException(400, "Please upload a .pdf file")
        content = await file.read()
        if len(content) > 25 * 1024 * 1024:
            raise HTTPException(400, "PDF too large (max 25 MB)")
        if len(content) < 100:
            raise HTTPException(400, "File is empty or too small")
        base = str(request.base_url).rstrip("/")
        try:
            meta = save_master_pdf(
                content,
                original_name=name,
                request_base=base,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {
            "ok": True,
            "message": "Master PDF uploaded",
            **meta,
        }

    @r.delete("/master-deck/pdf")
    def api_delete_master_pdf(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return delete_master_pdf()

    @r.post("/prospects/bulk")
    def bulk_import(body: BulkImportRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return bulk_import_rows(body.rows, draft_email=body.draft_email)

    @r.get("/this-week")
    def this_week(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return this_week_checklist()

    @r.get("/edyta-home")
    def edyta(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return edyta_home()

    @r.post("/prospects/{prospect_id}/sequences")
    def sequences(prospect_id: str, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return build_sequences_for_prospect(prospect_id)
        except KeyError:
            raise HTTPException(404, "Prospect not found") from None

    # ── Partnerships ────────────────────────────────────────────────────────

    @r.get("/partnerships")
    def get_partners(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.load_partnerships()

    @r.post("/partnerships")
    def add_partner(body: PartnerRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return crm.upsert_partner(body.model_dump())

    @r.post("/partnerships/seed")
    def seed_partners(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        return seed_default_partnerships()

    # ── Wedding Agent ───────────────────────────────────────────────────────

    @r.get("/wedding/packages")
    def wedding_packages(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return [wedding_pkg_dict(p) for p in WEDDING_PACKAGES.values()]

    @r.get("/wedding/prospects")
    def wedding_prospects(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.list_prospects(book="wedding")

    @r.get("/wedding/ready")
    def wedding_ready(request: Request, limit: int = 30) -> dict[str, Any]:
        """Scored, ranked wedding leads for the Weddings tab (click → Work)."""
        require_sliw_access(request)
        items = wedding_ready_list(limit=limit)
        prospects = crm.list_prospects(book="wedding")
        return {
            "items": items,
            "total": len(prospects),
            "planners": sum(1 for p in prospects if "planner" in (p.get("industry") or "").lower()),
            "venues": sum(1 for p in prospects if "venue" in (p.get("industry") or "").lower()),
            "tier_a": sum(1 for p in prospects if p.get("tier") == "A"),
            "tier_b": sum(1 for p in prospects if p.get("tier") == "B"),
        }

    @r.get("/wedding/pipeline/summary")
    def wedding_summary(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        prospects = crm.list_prospects(book="wedding")
        return {
            "stages": crm.pipeline_summary(book="wedding"),
            "total": len(prospects),
            "leads": len(crm.interested_leads(book="wedding")),
            "planners": sum(1 for p in prospects if "planner" in (p.get("industry") or "").lower()),
            "tier_a": sum(1 for p in prospects if p.get("tier") == "A"),
        }

    @r.post("/wedding/pipeline")
    def wedding_pipeline(body: WeddingPipelineRequest, request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        contacts = []
        if body.contact_name or body.contact_email:
            contacts.append({"name": body.contact_name, "email": body.contact_email})
        try:
            return run_wedding_pipeline(
                name=body.name.strip(),
                industry=body.industry,
                geo=body.geo,
                notes=body.notes,
                signals=body.signals,
                contacts=contacts,
                package_hint=body.package_hint,
                custom_hook=body.custom_hook,
                draft_email=body.draft_email,
                generate_gamma=body.generate_gamma or body.live_gamma,
                live_gamma=body.live_gamma,
            )
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.post("/wedding/library/import")
    def wedding_lib_import(
        request: Request,
        limit: int = 40,
        rescore: bool = True,
    ) -> dict[str, Any]:
        """Import Bay Area planner/venue seeds, score them, make them Work-ready."""
        require_sliw_access(request)
        return import_wedding_library(
            limit=limit,
            draft_email=False,
            rescore_existing=rescore,
            run_agent=False,
        )

    @r.post("/wedding/prospects/{prospect_id}/sales-agent")
    def wedding_sales_agent(
        prospect_id: str,
        request: Request,
        live_gamma: bool = False,
    ) -> dict[str, Any]:
        require_sliw_access(request)
        try:
            return run_wedding_sales_agent(prospect_id, live_gamma=live_gamma)
        except KeyError:
            raise HTTPException(404, "Wedding prospect not found") from None
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.get("/wedding/leads")
    def wedding_leads(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.interested_leads(book="wedding")

    return r


# ── Standalone app (local) ────────────────────────────────────────────────────
# Frontend uses /api/* when window.SLIW_API_BASE is unset.

app = FastAPI(
    title="Sliw Agent",
    version="0.1.0",
    description="Corporate representation desk for Edyta Śliwińska",
)
app.include_router(create_api_router(), prefix="/api")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


def main() -> None:
    import uvicorn
    uvicorn.run(
        "sliw_agent.server:app",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8787")),
        reload=False,
    )


if __name__ == "__main__":
    main()
