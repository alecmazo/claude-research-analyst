"""
FastAPI backend for the DGA Capital Research Analyst iPhone app.

Exposes the existing Python pipeline (SEC → Grok → Word/PPTX) via REST.

Start (from the project root — either works):
    python api/server.py
    python -m uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import sys
import os
import uuid
import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

import hashlib
import hmac

from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Make the project root importable when running from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import claude_analyst as analyst

app = FastAPI(title="DGA Research Analyst API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Auth — stateless HMAC token (survives restarts, no DB needed)
# ---------------------------------------------------------------------------
_PUBLIC_PATHS = {"/health", "/info", "/api/auth", "/"}

def _portfolio_password() -> str:
    return os.environ.get("PORTFOLIO_PASSWORD", "dgacapital").strip()

def _token_secret() -> str:
    return os.environ.get("TOKEN_SECRET", "dga-capital-jwt-secret").strip()

def _make_token(password: str) -> str:
    """Derive a deterministic token from password + secret (HMAC-SHA256)."""
    return hmac.new(  # type: ignore[attr-defined]
        _token_secret().encode(), password.encode(), hashlib.sha256
    ).hexdigest()

def _valid_token(token: str) -> bool:
    expected = _make_token(_portfolio_password())
    return hmac.compare_digest(token.strip(), expected)

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    # Always allow: public API paths, static assets, the web app shell
    if (path in _PUBLIC_PATHS
            or path.startswith("/app/")
            or path.startswith("/branding/")
            or not path.startswith("/api/")):
        return await call_next(request)
    # Check token from header or query string
    token = (request.headers.get("x-auth-token")
             or request.query_params.get("token")
             or "")
    if not _valid_token(token):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

# In-memory job store: { job_id: { status, ticker, result, error, created_at } }
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    ticker: str
    generate_gamma: bool = False


class JobStatus(BaseModel):
    job_id: str
    ticker: str
    status: str           # queued | running | done | failed
    created_at: str
    error: str | None = None
    result: dict | None = None


class PortfolioJobStatus(BaseModel):
    job_id: str
    status: str           # queued | running | done | failed
    created_at: str
    strategy: str
    n_tickers: int
    error: str | None = None
    result: dict | None = None


# ---------------------------------------------------------------------------
# Auth route
# ---------------------------------------------------------------------------

class AuthRequest(BaseModel):
    password: str

@app.post("/api/auth")
def auth(req: AuthRequest):
    if hmac.compare_digest(req.password.strip(), _portfolio_password()):
        return {"token": _make_token(req.password.strip())}
    raise HTTPException(status_code=401, detail="Invalid password")

# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

def _run_analysis(job_id: str, ticker: str, generate_gamma: bool) -> None:
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"

    try:
        system_prompt = analyst.load_system_prompt()
        result = analyst.analyze_ticker(
            ticker,
            system_prompt=system_prompt,
            generate_gamma=generate_gamma,
            verbose=False,
        )
        with _jobs_lock:
            if result.get("ok"):
                _jobs[job_id]["status"] = "done"
                # Trim the report text to avoid sending multi-MB payloads in the
                # status response; the full text is available via /report/{ticker}.
                _jobs[job_id]["result"] = {k: v for k, v in result.items()
                                           if k != "report_text"}
                _jobs[job_id]["result"]["has_report"] = bool(result.get("report_text"))
            else:
                _jobs[job_id]["status"] = "failed"
                _jobs[job_id]["error"] = result.get("error", "Unknown error")
    except Exception as exc:  # noqa: BLE001
        with _jobs_lock:
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = str(exc)


# In-memory portfolio job store.
_pjobs: dict[str, dict[str, Any]] = {}
_pjobs_lock = threading.Lock()


def _run_portfolio(
    job_id: str,
    portfolio_records: list[dict],
    strategy: str,
    generate_gamma: bool,
    reuse_existing: bool,
    xlsx_out_path: str,
) -> None:
    with _pjobs_lock:
        _pjobs[job_id]["status"] = "running"

    try:
        result = analyst.run_portfolio_rebalance(
            portfolio_records=portfolio_records,
            primary_strategy=strategy,
            generate_gamma=generate_gamma,
            reuse_existing=reuse_existing,
            output_path=xlsx_out_path,
        )
        with _pjobs_lock:
            _pjobs[job_id]["status"] = "done" if result.get("ok") else "failed"
            _pjobs[job_id]["result"] = result
            if not result.get("ok"):
                _pjobs[job_id]["error"] = "No tickers could be analyzed."
    except Exception as exc:  # noqa: BLE001
        with _pjobs_lock:
            _pjobs[job_id]["status"] = "failed"
            _pjobs[job_id]["error"] = str(exc)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
BRANDING_DIR = Path(__file__).resolve().parent.parent / "branding"


@app.get("/")
def root():
    """Redirect to the web UI."""
    return RedirectResponse(url="/app/")


@app.get("/info")
def info():
    return {"service": "DGA Research Analyst API", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.post("/api/analyze", response_model=JobStatus)
def start_analysis(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    """Kick off an async analysis for *ticker*. Returns a job_id to poll."""
    ticker = req.ticker.strip().upper()
    if not ticker or not ticker.isalpha() or len(ticker) > 10:
        raise HTTPException(status_code=422, detail="Invalid ticker symbol")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "ticker": ticker,
            "status": "queued",
            "created_at": now,
            "error": None,
            "result": None,
        }

    background_tasks.add_task(_run_analysis, job_id, ticker, req.generate_gamma)
    return _jobs[job_id]


@app.get("/api/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    """Poll for the status of a previously submitted job."""
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/jobs")
def list_jobs():
    """Return all jobs (newest first), without full result payloads."""
    with _jobs_lock:
        jobs = list(_jobs.values())
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return [
        {k: v for k, v in j.items() if k != "result"}
        for j in jobs
    ]


@app.get("/api/report/{ticker}")
def get_report(ticker: str):
    """Return the full markdown report text for the most-recently-analyzed ticker."""
    ticker = ticker.strip().upper()
    md_path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
    if not md_path.exists():
        raise HTTPException(status_code=404, detail=f"No report found for {ticker}")
    return {
        "ticker": ticker,
        "report_md": md_path.read_text(),
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
    }


@app.get("/api/download/{ticker}/docx")
def download_docx(ticker: str):
    """Download the Word report for *ticker*."""
    ticker = ticker.strip().upper()
    path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Report.docx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Word report not found")
    return FileResponse(
        path=str(path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=path.name,
    )


@app.get("/api/download/{ticker}/pptx")
def download_pptx(ticker: str):
    """Download the PowerPoint presentation for *ticker*."""
    ticker = ticker.strip().upper()
    path = analyst.STOCKS_FOLDER / f"{ticker}_DGA_Presentation.pptx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Presentation not found")
    return FileResponse(
        path=str(path),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=path.name,
    )


@app.get("/api/quote/{ticker}")
def get_quote(ticker: str):
    """Return live market price for *ticker* from Yahoo Finance."""
    ticker = ticker.strip().upper()
    snapshot = analyst.fetch_market_snapshot(ticker)
    return {"ticker": ticker, **snapshot}


@app.get("/api/reports")
def list_reports():
    """Return all tickers that have saved reports."""
    folder = analyst.STOCKS_FOLDER
    reports = []
    for md_file in sorted(folder.glob("*_DGA_Report.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        ticker = md_file.name.replace("_DGA_Report.md", "")
        has_docx = (folder / f"{ticker}_DGA_Report.docx").exists()
        has_pptx = (folder / f"{ticker}_DGA_Presentation.pptx").exists()
        reports.append({
            "ticker": ticker,
            "generated_at": datetime.utcfromtimestamp(md_file.stat().st_mtime).isoformat(),
            "has_docx": has_docx,
            "has_pptx": has_pptx,
        })
    return reports


# ---------------------------------------------------------------------------
# Portfolio endpoints
# ---------------------------------------------------------------------------
PORTFOLIO_OUT_DIR = Path(__file__).resolve().parent.parent / "portfolio_runs"
PORTFOLIO_OUT_DIR.mkdir(exist_ok=True)


@app.get("/api/strategies")
def list_strategies():
    """Return the three rebalance strategies with metadata for the GUI."""
    return [
        {
            "key": k,
            "label": cfg["label"],
            "description": cfg["description"],
            "min_names": cfg["min_names"],
            "max_names": cfg["max_names"],
            "max_position": cfg["max_position"],
            "max_sector": cfg["max_sector"],
        }
        for k, cfg in analyst.STRATEGIES.items()
    ]


@app.post("/api/portfolio", response_model=PortfolioJobStatus)
async def start_portfolio(
    background_tasks: BackgroundTasks,
    strategy: str = Form("pro"),
    generate_gamma: bool = Form(False),
    reuse_existing: bool = Form(True),
    file: UploadFile = File(...),
):
    """Upload a portfolio CSV/XLSX and kick off a rebalance run.

    Accepts multipart/form-data. Returns a job_id to poll.
    """
    if strategy not in analyst.STRATEGIES:
        raise HTTPException(status_code=422, detail=f"Unknown strategy: {strategy}")

    # Persist the upload to a temp file (loader reads from disk).
    suffix = Path(file.filename or "portfolio.xlsx").suffix.lower() or ".xlsx"
    if suffix not in (".csv", ".xlsx", ".xls"):
        raise HTTPException(status_code=422, detail="File must be .csv or .xlsx")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.close()
        try:
            records = analyst.load_portfolio_file(tmp.name)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not parse portfolio: {exc}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if not records:
        raise HTTPException(status_code=422, detail="Portfolio file has no rows")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    xlsx_out = PORTFOLIO_OUT_DIR / f"{job_id}_{analyst.DGA_PORTFOLIO_FILENAME}"

    with _pjobs_lock:
        _pjobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "strategy": strategy,
            "n_tickers": len(records),
            "error": None,
            "result": None,
        }

    background_tasks.add_task(
        _run_portfolio,
        job_id,
        records,
        strategy,
        generate_gamma,
        reuse_existing,
        str(xlsx_out),
    )
    return _pjobs[job_id]


@app.get("/api/portfolio/{job_id}", response_model=PortfolioJobStatus)
def get_portfolio_status(job_id: str):
    """Poll a portfolio run."""
    with _pjobs_lock:
        job = _pjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Portfolio job not found")
    return job


@app.get("/api/portfolio/{job_id}/download")
def download_portfolio_xlsx(job_id: str):
    """Download the DGA-portfolio.xlsx produced by a portfolio run."""
    with _pjobs_lock:
        job = _pjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Portfolio job not found")
    result = job.get("result") or {}
    xlsx_path = result.get("xlsx_path")
    if not xlsx_path or not Path(xlsx_path).exists():
        raise HTTPException(status_code=404, detail="Portfolio xlsx not ready yet")
    return FileResponse(
        path=xlsx_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="DGA-portfolio.xlsx",
    )


# ---------------------------------------------------------------------------
# Static web UI — mount last so API routes take precedence.
# ---------------------------------------------------------------------------
if BRANDING_DIR.exists():
    app.mount("/branding", StaticFiles(directory=str(BRANDING_DIR)), name="branding")

if WEB_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
