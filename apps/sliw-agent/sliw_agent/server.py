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

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import crm
from .pipeline import batch_score_seed, mark_interested, run_prospect_pipeline
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
        }

    @r.get("/pipeline/summary")
    def pipeline_summary(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        summary = crm.pipeline_summary()
        prospects = crm.list_prospects()
        leads = crm.interested_leads()
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
            "updated_at": crm.load_crm().get("updated_at"),
            "data_dir": str(crm.DATA_DIR),
        }

    @r.get("/prospects")
    def list_prospects(
        request: Request,
        stage: Optional[str] = None,
        min_score: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.list_prospects(stage=stage, min_score=min_score)

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
    def leads(request: Request) -> list[dict[str, Any]]:
        require_sliw_access(request)
        return crm.interested_leads()

    @r.post("/seed")
    def seed(request: Request) -> dict[str, Any]:
        require_sliw_access(request)
        results = batch_score_seed()
        return {
            "count": len(results),
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
