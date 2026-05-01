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
import json
import uuid
import shutil
import tempfile
import threading
import traceback
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
    return await call_next(request)

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


class IntelligenceRequest(BaseModel):
    days: int = 30   # lookback window in days: 30 | 60 | 90


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
    except BaseException as exc:  # noqa: BLE001  # catches SystemExit from any library
        # Log FULL traceback so we can see where the error actually happened.
        tb_str = traceback.format_exc()
        print(f"\n❌ Single-ticker job {job_id} ({ticker}) CRASHED:\n{tb_str}", flush=True)
        with _jobs_lock:
            _jobs[job_id]["status"] = "failed"
            # Include last line of traceback in error so the UI shows something
            # more useful than just the message.
            tb_tail = tb_str.strip().splitlines()[-3:] if tb_str else []
            _jobs[job_id]["error"] = f"{exc} | {' | '.join(tb_tail)}"


# In-memory portfolio job store.
_pjobs: dict[str, dict[str, Any]] = {}
_pjobs_lock = threading.Lock()

# In-memory scan job store.
_sjobs: dict[str, dict[str, Any]] = {}
_sjobs_lock = threading.Lock()

# In-memory intelligence job store.
_ijobs: dict[str, dict[str, Any]] = {}
_ijobs_lock = threading.Lock()


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
        # Auto-promote the input holdings as the new "live portfolio" benchmark
        # so the Paper Tracker can compare idea baskets against your real book.
        if result.get("ok"):
            try:
                analyst.promote_live_portfolio(portfolio_records)
            except Exception as exc:  # noqa: BLE001
                print(f"⚠️  Live-portfolio promotion failed: {exc}")
    except BaseException as exc:  # noqa: BLE001  # catches SystemExit from any library
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


@app.delete("/api/cache")
def clear_local_cache():
    """Delete all locally-cached _DGA_Report.md files from /stocks.

    Dropbox / Drive files are NOT touched — only this server instance's
    local copy is cleared. After the user deletes files from Dropbox,
    calling this endpoint ensures the Research tab reflects the true state
    instead of showing stale reports that were hydrated at startup.
    """
    cleared: list[str] = []
    for md in analyst.STOCKS_FOLDER.glob("*_DGA_Report.md"):
        try:
            md.unlink()
            cleared.append(md.name.replace("_DGA_Report.md", ""))
        except OSError:
            pass
    return {"cleared": cleared, "count": len(cleared)}


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
    strategy: str = Form("current"),
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


# ---------------------------------------------------------------------------
# Watchlist endpoints
# ---------------------------------------------------------------------------

class WatchlistUpdate(BaseModel):
    tickers: list[str]


@app.get("/api/watchlist")
def get_watchlist():
    """Return the current watchlist."""
    return {"tickers": analyst.load_watchlist()}


@app.put("/api/watchlist")
def set_watchlist(body: WatchlistUpdate):
    """Replace the entire watchlist."""
    clean = [t.strip().upper() for t in body.tickers if t.strip()]
    analyst.save_watchlist(clean)
    return {"tickers": analyst.load_watchlist()}


@app.post("/api/watchlist/{ticker}")
def add_watchlist_ticker(ticker: str):
    """Add a single ticker to the watchlist."""
    t = ticker.strip().upper()
    if not t or not t.replace(".", "").isalnum() or len(t) > 10:
        raise HTTPException(status_code=422, detail="Invalid ticker")
    tickers = analyst.add_to_watchlist(t)
    return {"tickers": tickers}


@app.delete("/api/watchlist/{ticker}")
def remove_watchlist_ticker(ticker: str):
    """Remove a single ticker from the watchlist."""
    tickers = analyst.remove_from_watchlist(ticker.strip().upper())
    return {"tickers": tickers}


# ---------------------------------------------------------------------------
# Scan job worker
# ---------------------------------------------------------------------------

def _run_scan(job_id: str, tickers: list[str]) -> None:
    with _sjobs_lock:
        _sjobs[job_id]["status"] = "running"

    completed: dict[str, Any] = {}

    def on_progress(ticker: str, result: dict) -> None:
        with _sjobs_lock:
            _sjobs[job_id]["results"][ticker] = result
            _sjobs[job_id]["tickers_done"] = list(_sjobs[job_id]["results"].keys())

    try:
        final = analyst.run_portfolio_scan(tickers, on_progress=on_progress, verbose=True)
        with _sjobs_lock:
            _sjobs[job_id]["status"] = "done"
            _sjobs[job_id]["results"] = final["results"]
            _sjobs[job_id]["scanned_at"] = final["scanned_at"]
            _sjobs[job_id]["tickers_done"] = list(final["results"].keys())
    except BaseException as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(f"\n❌ Scan job {job_id} CRASHED:\n{tb}", flush=True)
        with _sjobs_lock:
            _sjobs[job_id]["status"] = "failed"
            _sjobs[job_id]["error"] = str(exc)


# ---------------------------------------------------------------------------
# Scan endpoints
# ---------------------------------------------------------------------------

@app.post("/api/scan")
def start_scan(background_tasks: BackgroundTasks):
    """Kick off a live-search news scan for all watchlist tickers."""
    tickers = analyst.load_watchlist()
    if not tickers:
        raise HTTPException(status_code=422, detail="Watchlist is empty — add tickers first")

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _sjobs_lock:
        _sjobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "tickers": tickers,
            "tickers_done": [],
            "results": {},
            "scanned_at": None,
            "error": None,
        }
    background_tasks.add_task(_run_scan, job_id, tickers)
    return _sjobs[job_id]


@app.get("/api/scan/latest")
def get_latest_scan():
    """Return the most-recently-completed scan (persisted to disk)."""
    path = analyst.SCAN_RESULTS_FILE
    if not path.exists():
        return {"exists": False}
    try:
        data = json.loads(path.read_text())
        data["exists"] = True
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read scan results: {exc}")


@app.get("/api/scan/{job_id}")
def get_scan_status(job_id: str):
    """Poll a running or completed scan job."""
    with _sjobs_lock:
        job = _sjobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Scan job not found")
    return job


# ---------------------------------------------------------------------------
# Intelligence — macro → sector → company idea generation
# ---------------------------------------------------------------------------

def _run_intelligence(job_id: str, days: int) -> None:
    with _ijobs_lock:
        _ijobs[job_id]["status"] = "running"
    try:
        result = analyst.run_market_intelligence(days)
        with _ijobs_lock:
            _ijobs[job_id]["status"] = "done" if result.get("ok") else "failed"
            _ijobs[job_id]["result"] = result
            if not result.get("ok"):
                _ijobs[job_id]["error"] = result.get("error", "Unknown error")
    except BaseException as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(f"\n❌ Intelligence job {job_id} CRASHED:\n{tb}", flush=True)
        with _ijobs_lock:
            _ijobs[job_id]["status"] = "failed"
            _ijobs[job_id]["error"] = str(exc)


@app.post("/api/intelligence")
def start_intelligence(req: IntelligenceRequest, background_tasks: BackgroundTasks):
    """Start a market intelligence run for the given lookback window (days)."""
    days = max(7, min(90, req.days))
    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _ijobs_lock:
        _ijobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "days": days,
            "result": None,
            "error": None,
        }
    background_tasks.add_task(_run_intelligence, job_id, days)
    return _ijobs[job_id]


@app.get("/api/intelligence/latest")
def get_latest_intelligence():
    """Return the most-recently-completed intelligence run (persisted to disk)."""
    path = analyst.INTEL_FILE
    if not path.exists():
        return {"exists": False}
    try:
        data = json.loads(path.read_text())
        data["exists"] = True
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read intelligence: {exc}")


@app.get("/api/intelligence/{job_id}")
def get_intelligence_status(job_id: str):
    """Poll a running or completed intelligence job."""
    with _ijobs_lock:
        job = _ijobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Intelligence job not found")
    return job


# ---------------------------------------------------------------------------
# Paper Portfolio Tracker
# ---------------------------------------------------------------------------

class TrackerHolding(BaseModel):
    ticker: str
    weight: float   # 0..1 (or 0..100; coerced server-side)


class TrackerCreateRequest(BaseModel):
    name: str
    holdings: list[TrackerHolding]
    source: dict | None = None


@app.post("/api/track")
def create_tracker(req: TrackerCreateRequest):
    """Lock in a new paper portfolio (idea basket) for forward tracking."""
    try:
        portfolio = analyst.create_idea_portfolio(
            name=req.name,
            holdings_input=[h.model_dump() for h in req.holdings],
            source=req.source or {},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return portfolio


@app.get("/api/track")
def list_trackers():
    """List all paper portfolios with computed performance metrics."""
    return {"portfolios": analyst.list_idea_portfolios()}


@app.get("/api/track/live")
def get_tracker_live():
    """Return the auto-promoted live portfolio (the benchmark)."""
    state = analyst._load_tracker_state()
    return {"live_portfolio": state.get("live_portfolio")}


@app.get("/api/track/live/detail")
def get_tracker_live_detail(snapshot_id: str | None = None):
    """YTD attribution for the live portfolio (year-start baseline + SPY benchmark).

    Per-holding return uses each ticker's first close of the calendar year as
    the entry baseline, so this surfaces who is driving annual outperformance
    versus the SPY YTD constant.

    Optional `snapshot_id` query param — when provided, returns the YTD detail
    using that historical snapshot's holdings and attribution instead of the
    current live state, so the user can re-open any past run.
    """
    return analyst.compute_live_ytd_detail(snapshot_id=snapshot_id)


@app.post("/api/track/live/ytd")
async def compute_live_ytd_unified(
    positions_file:     UploadFile = File(...),
    activity_file:      UploadFile = File(...),
    begin_value:        float | None = Form(None),
    monthly_perf_file:  UploadFile   = File(None),
):
    """Single unified YTD endpoint: Modified Dietz + TWRR + per-stock attribution.

    Multipart inputs:
      - positions_file:    Fidelity Positions CSV
      - activity_file:     Fidelity Activity / History CSV
      - begin_value:       Jan 1 portfolio total ($).  Optional when
                           monthly_perf_file is supplied — the first month's
                           beginning balance is used automatically.
      - monthly_perf_file: (optional) Fidelity monthly performance summary CSV.
                           Provides exact month-end balances + per-component breakdown.
                           When supplied begin_value may be omitted; the YTD-by-month
                           chart uses Fidelity's exact values and TWRR matches exactly.
    """

    try:
        pos_content    = await positions_file.read()
        positions_text = pos_content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read positions file: {exc}")

    try:
        act_content   = await activity_file.read()
        activity_text = act_content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read activity file: {exc}")

    monthly_perf_text: str | None = None
    if monthly_perf_file and monthly_perf_file.filename:
        try:
            mp_content        = await monthly_perf_file.read()
            monthly_perf_text = mp_content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read monthly performance file: {exc}")

    try:
        result = analyst.compute_unified_ytd(
            positions_text, activity_text, begin_value,
            monthly_perf_text=monthly_perf_text,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"compute_unified_ytd raised: {exc}\n\nTraceback:\n{tb}",
        )

    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Unknown error"))
    return result


@app.get("/api/track/live/snapshots")
def list_live_ytd_snapshots():
    """List all stored YTD snapshots (newest first) for the live portfolio."""
    return analyst.list_ytd_snapshots()


@app.get("/api/track/live/snapshots/{snapshot_id}")
def get_live_ytd_snapshot(snapshot_id: str):
    """Get one stored YTD snapshot by id (full attribution + holdings)."""
    result = analyst.get_ytd_snapshot(snapshot_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@app.delete("/api/track/live/snapshots/{snapshot_id}")
def delete_live_ytd_snapshot(snapshot_id: str):
    """Delete a stored YTD snapshot by id."""
    result = analyst.delete_ytd_snapshot(snapshot_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


class EmailYtdRequest(BaseModel):
    email: str
    snapshot_id: str | None = None


@app.post("/api/track/live/ytd/email")
def email_live_ytd_report(body: EmailYtdRequest):
    """Email the YTD report (live benchmark + attribution) to the given address.

    If snapshot_id is omitted, sends the most recent stored snapshot.
    """
    if not body.email or "@" not in body.email:
        raise HTTPException(status_code=422, detail="A valid email address is required.")
    try:
        result = analyst.email_ytd_report(body.email, body.snapshot_id)
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"email_ytd_report raised: {exc}\n\nTraceback:\n{tb}",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Email failed"))
    return result


@app.post("/api/track/live/ytd/set-current/{snapshot_id}")
def set_current_ytd_snapshot(snapshot_id: str):
    """Promote a past snapshot to the current account_history (live benchmark view).

    When the user selects a different run from the Past YTD Runs list, calling
    this makes the Live Benchmark card and YTD detail reflect that run.
    """
    try:
        result = analyst.set_current_ytd_snapshot(snapshot_id)
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"set_current_ytd_snapshot raised: {exc}\n\nTraceback:\n{tb}",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error"))
    return result


@app.post("/api/track/snapshot")
def trigger_tracker_snapshot():
    """Manually trigger a daily snapshot (admin / debug)."""
    return analyst.take_daily_snapshot(force=True)


@app.get("/api/track/{portfolio_id}")
def get_tracker(portfolio_id: str):
    """Return one portfolio with full daily series + benchmark series for charting."""
    p = analyst.get_idea_portfolio(portfolio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return p


@app.post("/api/track/{portfolio_id}/close")
def close_tracker(portfolio_id: str):
    """Mark a paper portfolio as closed (stops daily snapshotting)."""
    if not analyst.close_idea_portfolio(portfolio_id):
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return {"ok": True}


@app.delete("/api/track/{portfolio_id}")
def delete_tracker(portfolio_id: str):
    """Permanently delete a paper portfolio."""
    if not analyst.delete_idea_portfolio(portfolio_id):
        raise HTTPException(status_code=404, detail="Paper portfolio not found")
    return {"ok": True}


@app.get("/api/portfolio/last")
def get_last_portfolio():
    """Return metadata about the most recent portfolio run (for the Research page link).

    Looks at the most-recently-modified Portfolio_Summary.md in /stocks as the
    ground truth for "when was a portfolio last run?" — this file is written
    by :func:`run_portfolio_summary` on every successful multi-ticker run and
    survives Railway redeploys via Dropbox hydration.
    """
    md_path = analyst.STOCKS_FOLDER / "Portfolio_Summary.md"
    if not md_path.exists():
        return {"exists": False}
    return {
        "exists": True,
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
        "title": "Portfolio Review",
    }


@app.get("/api/portfolio/summary")
def get_portfolio_summary_md():
    """Return the full markdown of the last Portfolio_Summary.md."""
    md_path = analyst.STOCKS_FOLDER / "Portfolio_Summary.md"
    if not md_path.exists():
        raise HTTPException(status_code=404, detail="No portfolio summary available yet")
    return {
        "summary_md": md_path.read_text(),
        "generated_at": datetime.utcfromtimestamp(md_path.stat().st_mtime).isoformat(),
    }


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
# Dropbox startup hydration — runs once in a background thread so it doesn't
# block the server from accepting requests. Lists every *_DGA_Report.md in the
# Dropbox app folder and downloads any that are missing from the local /stocks
# folder. This repopulates the Saved Reports list after a Railway redeploy.
# ---------------------------------------------------------------------------
def _hydrate_from_dropbox() -> None:
    dbx = analyst._dropbox_client()
    if dbx is None:
        return
    folder = analyst._dropbox_folder()
    try:
        result = dbx.files_list_folder(folder if folder else "")
        entries = result.entries
        while result.has_more:
            result = dbx.files_list_folder_continue(result.cursor)
            entries += result.entries
    except Exception:
        return

    downloaded = 0
    for entry in entries:
        name = getattr(entry, "name", "")
        # Hydrate per-ticker reports AND the last Portfolio_Summary so the
        # Research page's "Last Portfolio Summary" card survives redeploys.
        # Also hydrate tracker.json so paper portfolios + snapshots survive.
        if not (name.endswith("_DGA_Report.md")
                or name == "Portfolio_Summary.md"
                or name == "tracker.json"
                or name == "intelligence.json"):
            continue
        local = analyst.STOCKS_FOLDER / name
        if local.exists():
            continue
        try:
            import dropbox as _dbx_mod  # noqa: PLC0415
            _, resp = dbx.files_download(
                f"{folder}/{name}" if folder else f"/{name}"
            )
            local.write_bytes(resp.content)
            downloaded += 1
        except Exception:
            pass
    if downloaded:
        print(f"☁️  Hydrated {downloaded} file(s) from Dropbox into /stocks")


threading.Thread(target=_hydrate_from_dropbox, daemon=True).start()

# Start the daily snapshot worker (runs once per day after market close)
analyst._start_tracker_snapshot_worker()


# ---------------------------------------------------------------------------
# Static web UI — mount last so API routes take precedence.
# ---------------------------------------------------------------------------

@app.middleware("http")
async def no_cache_shell_middleware(request: Request, call_next):
    """Force the browser to re-fetch the HTML/CSS/JS shell on every request.

    Railway redeploys don't change the file URL, so default browser caching
    (which can keep static files for hours) would leave users staring at
    the previous build. We want the shell *itself* to refresh so the
    ``?v=`` pins on the CSS/JS tags get honored.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/app/") or path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if BRANDING_DIR.exists():
    app.mount("/branding", StaticFiles(directory=str(BRANDING_DIR)), name="branding")

if WEB_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
