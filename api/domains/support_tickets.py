"""GP Support tickets — domain module extracted from api/server.py."""
from __future__ import annotations

import json
import os
import threading
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response
from fastapi.responses import JSONResponse

router = APIRouter(tags=["support"])


class _Bag:
    """Late-bound symbols from api.server (set in mount())."""
    pass


B = _Bag()


def mount(ns: dict) -> None:
    """Bind server helpers and attach routes to ns["app"]."""
    for key in (
        "app", "_fund_conn", "_RealDictCursor", "_PSYCOPG2_OK", "psycopg2",
        "_claims_or_401", "_request_json_sync", "analyst", "_send_via_gmail",
        "ROOT",
    ):
        if key in ns:
            setattr(B, key, ns[key])
        elif key == "ROOT":
            setattr(B, "ROOT", str(Path(__file__).resolve().parent.parent.parent))
        elif key == "psycopg2":
            try:
                import psycopg2 as _psycopg2
                setattr(B, "psycopg2", _psycopg2)
            except Exception:
                setattr(B, "psycopg2", None)
        elif key == "_PSYCOPG2_OK":
            setattr(B, "_PSYCOPG2_OK", bool(getattr(B, "psycopg2", None)))
    # Prefer explicit
    if "psycopg2" in ns:
        B.psycopg2 = ns["psycopg2"]
    if "_PSYCOPG2_OK" in ns:
        B._PSYCOPG2_OK = ns["_PSYCOPG2_OK"]
    if "ROOT" not in ns:
        B.ROOT = str(Path(__file__).resolve().parent.parent.parent)
    ns["app"].include_router(router)
    # Re-export helpers some code may call
    ns["_ensure_support_tickets_table"] = _ensure_support_tickets_table
    ns["_support_gp_only"] = _support_gp_only
    ns["_support_append_trail"] = _support_append_trail
    ns["_support_trail_event"] = _support_trail_event
    ns["_support_row_public"] = _support_row_public


# ═══════════════════════════════════════════════════════════════════════════
# GP Support tickets — text + page screenshot, auto-diagnose, fix trail
# ═══════════════════════════════════════════════════════════════════════════
# GP-only floating button captures description + viewport snapshot. Tickets
# land in Postgres, get a background LLM diagnosis (no code edit), and show a
# fix trail under Settings. Actual code fixes still need a coding agent
# session (Grok terminal / local workspace) — production cannot safely push
# git from Railway. Open tickets are readable via GET /api/support/agent-inbox.
_SUPPORT_SCREENSHOT_MAX = 900_000  # ~900KB base64 budget


def _ensure_support_tickets_table(conn=None) -> None:
    own = conn is None
    if own:
        if not (B._PSYCOPG2_OK and os.environ.get("DATABASE_URL")):
            return
        conn = B.psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS support_tickets (
                    id                TEXT PRIMARY KEY,
                    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                    created_by        TEXT,
                    created_by_email  TEXT,
                    status            TEXT NOT NULL DEFAULT 'open',
                    priority          TEXT NOT NULL DEFAULT 'normal',
                    description       TEXT NOT NULL,
                    page_url          TEXT,
                    page_path         TEXT,
                    active_tab        TEXT,
                    user_agent        TEXT,
                    viewport_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
                    console_errors    JSONB NOT NULL DEFAULT '[]'::jsonb,
                    context_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
                    screenshot_mime   TEXT,
                    screenshot_b64    TEXT,
                    diagnosis         TEXT,
                    agent_brief       TEXT,
                    fix_trail         JSONB NOT NULL DEFAULT '[]'::jsonb,
                    fixed_at          TIMESTAMPTZ,
                    fixed_summary     TEXT
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS support_tickets_status_idx
                    ON support_tickets (status, created_at DESC)
            """)
        conn.commit()
    finally:
        if own:
            try:
                conn.close()
            except Exception:
                pass


def _support_agent_token_ok(request: Request) -> bool:
    """Allow coding agents to read/update tickets with SUPPORT_AGENT_TOKEN
    (Railway env) — no interactive GP login required for headless fix loops."""
    expected = (os.environ.get("SUPPORT_AGENT_TOKEN") or "").strip()
    if not expected or len(expected) < 16:
        return False
    got = (request.headers.get("x-support-agent-token")
           or request.headers.get("x-agent-token")
           or "").strip()
    if not got:
        auth = (request.headers.get("authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            got = auth[7:].strip()
    return bool(got) and got == expected


def _support_gp_only(request: Request) -> dict:
    """GP/admin JWT, or SUPPORT_AGENT_TOKEN for headless agent sessions."""
    if _support_agent_token_ok(request):
        return {
            "role": "admin",
            "email": "agent@support.local",
            "sub": "support-agent",
            "agent": True,
        }
    claims = B._claims_or_401(request)
    if claims.get("role") not in ("gp", "admin"):
        raise HTTPException(403, "GP only — support tickets are not available to LPs")
    return claims


def _support_iso_utc(v) -> str | None:
    """Serialize datetimes as clean UTC ISO ending in Z (never '+00:00Z')."""
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        try:
            if getattr(v, "tzinfo", None) is not None:
                v = v.astimezone(timezone.utc).replace(tzinfo=None)
            # Drop microseconds noise beyond ms for display stability
            s = v.strftime("%Y-%m-%dT%H:%M:%S")
            if getattr(v, "microsecond", 0):
                s += f".{v.microsecond // 1000:03d}"
            return s + "Z"
        except Exception:
            return str(v)
    s = str(v).strip()
    # Repair common double-suffix from earlier builds
    if s.endswith("+00:00Z"):
        s = s[:-1]
    if s.endswith("+00:00"):
        s = s[:-6] + "Z"
    return s


def _support_trail_event(actor: str, action: str, detail: str = "") -> dict:
    # Stored as UTC; UI converts to America/Los_Angeles (Bay Area) for display.
    return {
        "ts": _support_iso_utc(datetime.utcnow()),
        "actor": (actor or "system")[:80],
        "action": (action or "note")[:80],
        "detail": (detail or "")[:4000],
    }


def _support_row_public(row: dict, *, include_screenshot: bool = False) -> dict:
    if not row:
        return {}
    out = {
        "id": row.get("id"),
        "created_at": _support_iso_utc(row.get("created_at")),
        "updated_at": _support_iso_utc(row.get("updated_at")),
        "created_by": row.get("created_by"),
        "created_by_email": row.get("created_by_email"),
        "status": row.get("status"),
        "priority": row.get("priority"),
        "description": row.get("description"),
        "page_url": row.get("page_url"),
        "page_path": row.get("page_path"),
        "active_tab": row.get("active_tab"),
        "user_agent": row.get("user_agent"),
        "viewport": row.get("viewport_json") or {},
        "console_errors": row.get("console_errors") or [],
        "context": row.get("context_json") or {},
        "has_screenshot": bool(row.get("screenshot_b64")),
        "screenshot_mime": row.get("screenshot_mime"),
        "diagnosis": row.get("diagnosis"),
        "agent_brief": row.get("agent_brief"),
        "fix_trail": row.get("fix_trail") or [],
        "fixed_at": _support_iso_utc(row.get("fixed_at")),
        "fixed_summary": row.get("fixed_summary"),
        "timezone_display": "America/Los_Angeles",
    }
    if include_screenshot and row.get("screenshot_b64"):
        out["screenshot_b64"] = row["screenshot_b64"]
    return out


def _support_append_trail(ticket_id: str, event: dict) -> None:
    try:
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE support_tickets
                   SET fix_trail = COALESCE(fix_trail, '[]'::jsonb) || %s::jsonb,
                       updated_at = now()
                 WHERE id = %s
            """, (json.dumps([event]), ticket_id))
            conn.commit()
    except Exception as e:
        print(f"[support] trail append failed: {e!s:.160}", flush=True)


def _support_write_inbox_file(ticket: dict) -> str | None:
    """Write a local agent packet (useful when server runs next to the workspace)."""
    try:
        root = Path(str(B.ROOT)) / "docs" / "support-inbox"
        root.mkdir(parents=True, exist_ok=True)
        tid = ticket.get("id") or "unknown"
        path = root / f"{tid}.md"
        shot_note = "yes" if ticket.get("has_screenshot") or ticket.get("screenshot_b64") else "no"
        body = (
            f"# Support ticket {tid}\n\n"
            f"- **Status:** {ticket.get('status')}\n"
            f"- **Created:** {ticket.get('created_at')}\n"
            f"- **By:** {ticket.get('created_by_email') or ticket.get('created_by')}\n"
            f"- **Page:** {ticket.get('page_url') or ticket.get('page_path')}\n"
            f"- **Tab:** {ticket.get('active_tab')}\n"
            f"- **Screenshot:** {shot_note}\n\n"
            f"## Description\n\n{ticket.get('description') or ''}\n\n"
            f"## Console errors\n\n```json\n"
            f"{json.dumps(ticket.get('console_errors') or [], indent=2)[:4000]}\n```\n\n"
            f"## Diagnosis\n\n{ticket.get('diagnosis') or '_pending_'}\n\n"
            f"## Agent brief\n\n{ticket.get('agent_brief') or '_pending_'}\n\n"
            f"## Fix trail\n\n```json\n"
            f"{json.dumps(ticket.get('fix_trail') or [], indent=2)[:6000]}\n```\n"
        )
        path.write_text(body, encoding="utf-8")
        # Also maintain OPEN.md index
        open_path = root / "OPEN.md"
        try:
            with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, status, created_at, description, page_path, active_tab
                      FROM support_tickets
                     WHERE status IN ('open','diagnosing','diagnosed','in_progress')
                     ORDER BY created_at DESC LIMIT 40
                """)
                rows = cur.fetchall() or []
            lines = ["# Open support tickets\n",
                     "Process with: open Grok in this workspace and ask to fix open support tickets.\n"]
            for r in rows:
                desc = (r.get("description") or "").replace("\n", " ")[:120]
                lines.append(
                    f"- `{r['id']}` · {r.get('status')} · {r.get('page_path') or ''} · {desc}\n")
            open_path.write_text("".join(lines), encoding="utf-8")
        except Exception:
            pass
        return str(path)
    except Exception as e:
        print(f"[support] inbox file write failed: {e!s:.160}", flush=True)
        return None


def _support_auto_diagnose(ticket_id: str) -> None:
    """Background: cheap LLM diagnosis from description + page context.
    Does NOT edit code. Writes diagnosis + agent_brief + trail event."""
    try:
        _ensure_support_tickets_table()
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            cur.execute("SELECT * FROM support_tickets WHERE id=%s", (ticket_id,))
            row = cur.fetchone()
        if not row:
            return
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE support_tickets SET status='diagnosing', updated_at=now()
                 WHERE id=%s AND status IN ('open','diagnosing')
            """, (ticket_id,))
            conn.commit()
        _support_append_trail(ticket_id, _support_trail_event(
            "system", "diagnose_started",
            "Background LLM diagnosis started (no code changes)."))

        desc = (row.get("description") or "")[:3000]
        page = row.get("page_url") or row.get("page_path") or ""
        tab = row.get("active_tab") or ""
        errs = row.get("console_errors") or []
        ctx = row.get("context_json") or {}
        system = (
            "You are the on-call engineer for DGA Capital's GP web terminal "
            "(portfolio-gp.html + FastAPI api/server.py). Diagnose a GP-filed "
            "support ticket. Be concrete: likely root cause, files/functions to "
            "inspect, and a short fix plan. Do NOT invent secrets. If info is "
            "insufficient, say what else is needed. Output markdown with sections: "
            "Summary, Likely cause, Where to look, Fix plan, Risk."
        )
        user = (
            f"Ticket ID: {ticket_id}\n"
            f"Page URL: {page}\n"
            f"Active tab: {tab}\n"
            f"User agent: {(row.get('user_agent') or '')[:200]}\n"
            f"Viewport: {json.dumps(row.get('viewport_json') or {})[:300]}\n"
            f"Console errors (recent):\n{json.dumps(errs)[:2500]}\n"
            f"Extra context:\n{json.dumps(ctx)[:2000]}\n\n"
            f"GP description:\n{desc}\n"
        )
        diagnosis = None
        try:
            diagnosis = B.analyst.call_llm("grok", system, user, live_search=False)
        except Exception as e1:
            try:
                diagnosis = B.analyst.call_llm("claude", system, user)
            except Exception as e2:
                diagnosis = (
                    f"_Auto-diagnosis unavailable_ ({e1!s:.120} / {e2!s:.120}). "
                    f"Ticket is queued for a coding agent session."
                )
        diagnosis = (diagnosis or "").strip()[:12000]
        brief = (
            f"## Support ticket {ticket_id}\n\n"
            f"**Page:** {page}  \n**Tab:** {tab}\n\n"
            f"### User report\n{desc}\n\n"
            f"### Auto-diagnosis\n{diagnosis}\n\n"
            f"### Instructions for coding agent\n"
            f"1. Reproduce on the page/tab above if possible.\n"
            f"2. Inspect screenshot via GET /api/support/tickets/{ticket_id}/screenshot\n"
            f"3. Implement minimal fix; do not rewrite unrelated systems.\n"
            f"4. POST trail events to /api/support/tickets/{ticket_id}/trail "
            f"and mark status fixed with a summary when done.\n"
        )
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE support_tickets
                   SET diagnosis=%s, agent_brief=%s, status='diagnosed',
                       updated_at=now()
                 WHERE id=%s
            """, (diagnosis, brief, ticket_id))
            conn.commit()
        _support_append_trail(ticket_id, _support_trail_event(
            "system", "diagnosed",
            (diagnosis or "")[:500]))
        # Refresh agent packet
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            cur.execute("SELECT * FROM support_tickets WHERE id=%s", (ticket_id,))
            r2 = cur.fetchone()
        if r2:
            pub = _support_row_public(dict(r2))
            _support_write_inbox_file(pub)
        # Optional email ping to GP who filed (or GMAIL_USER)
        try:
            to = (row.get("created_by_email")
                  or os.environ.get("SUPPORT_NOTIFY_EMAIL")
                  or os.environ.get("GMAIL_USER") or "")
            if to and "@" in str(to):
                html = (
                    f"<p>Support ticket <b>{ticket_id}</b> diagnosed.</p>"
                    f"<p><b>Page:</b> {page}<br><b>Tab:</b> {tab}</p>"
                    f"<pre style='white-space:pre-wrap;font-size:12px'>"
                    f"{(diagnosis or '')[:2500]}</pre>"
                    f"<p>Open Settings → Support tickets in the GP terminal for the full trail.</p>"
                )
                B._send_via_gmail(str(to), f"[DGA Support] {ticket_id} diagnosed", html)
        except Exception:
            pass
        print(f"[support] diagnosed {ticket_id}", flush=True)
    except Exception as e:
        print(f"[support] auto-diagnose failed {ticket_id}: {e!s:.200}", flush=True)
        try:
            _support_append_trail(ticket_id, _support_trail_event(
                "system", "diagnose_failed", str(e)[:500]))
            with B._fund_conn() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE support_tickets SET status='open', updated_at=now()
                     WHERE id=%s AND status='diagnosing'
                """, (ticket_id,))
                conn.commit()
        except Exception:
            pass


@router.post("/api/support/tickets")
def support_ticket_create(request: Request, background_tasks: BackgroundTasks):
    """GP-only: file a trouble ticket with optional page screenshot (base64)."""
    claims = _support_gp_only(request)
    try:
        body = B._request_json_sync(request) or {}
    except Exception:
        body = {}
    desc = (body.get("description") or "").strip()
    if len(desc) < 8:
        return JSONResponse({"ok": False, "error": "Please describe the problem (at least a sentence)."},
                            status_code=400)
    if len(desc) > 8000:
        desc = desc[:8000]
    shot = body.get("screenshot_b64") or body.get("screenshot") or ""
    if isinstance(shot, str) and shot.startswith("data:"):
        # data:image/jpeg;base64,....
        try:
            header, b64 = shot.split(",", 1)
            mime = header.split(";")[0].split(":")[1] if ":" in header else "image/jpeg"
            shot = b64
        except Exception:
            mime = "image/jpeg"
            shot = ""
    else:
        mime = (body.get("screenshot_mime") or "image/jpeg").strip() or "image/jpeg"
    if shot and len(shot) > _SUPPORT_SCREENSHOT_MAX:
        # Keep ticket even if shot too large — drop image rather than fail
        print(f"[support] screenshot too large ({len(shot)} chars) — dropping", flush=True)
        shot = ""
        mime = None
    tid = "SUP_" + datetime.utcnow().strftime("%Y%m%d_") + _uuid.uuid4().hex[:8]
    trail0 = [_support_trail_event(
        claims.get("email") or claims.get("sub") or "gp",
        "submitted",
        "Ticket filed from GP terminal with "
        + ("screenshot" if shot else "no screenshot") + ".")]
    _ensure_support_tickets_table()
    try:
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO support_tickets (
                    id, created_by, created_by_email, status, priority,
                    description, page_url, page_path, active_tab, user_agent,
                    viewport_json, console_errors, context_json,
                    screenshot_mime, screenshot_b64, fix_trail
                ) VALUES (
                    %s,%s,%s,'open',%s,
                    %s,%s,%s,%s,%s,
                    %s::jsonb,%s::jsonb,%s::jsonb,
                    %s,%s,%s::jsonb
                )
            """, (
                tid,
                claims.get("sub") or claims.get("lp_id") or claims.get("email"),
                claims.get("email"),
                (body.get("priority") or "normal")[:20],
                desc,
                (body.get("page_url") or "")[:1000],
                (body.get("page_path") or "")[:400],
                (body.get("active_tab") or "")[:80],
                (body.get("user_agent") or request.headers.get("user-agent") or "")[:400],
                json.dumps(body.get("viewport") or {}),
                json.dumps((body.get("console_errors") or [])[:30]),
                json.dumps(body.get("context") or {}),
                mime,
                shot or None,
                json.dumps(trail0),
            ))
            conn.commit()
    except Exception as e:
        print(f"[support] insert failed: {e!s:.200}", flush=True)
        return JSONResponse({"ok": False, "error": f"Could not save ticket: {e!s:.160}"},
                            status_code=500)

    pub = {
        "id": tid, "status": "open", "description": desc,
        "page_url": body.get("page_url"), "page_path": body.get("page_path"),
        "active_tab": body.get("active_tab"),
        "created_by_email": claims.get("email"),
        "created_at": datetime.utcnow().isoformat() + "Z",
        "has_screenshot": bool(shot),
        "console_errors": body.get("console_errors") or [],
        "fix_trail": trail0,
    }
    inbox = _support_write_inbox_file(pub)
    # Auto-diagnose in background (LLM only — no code edit)
    try:
        background_tasks.add_task(_support_auto_diagnose, tid)
    except Exception:
        threading.Thread(target=_support_auto_diagnose, args=(tid,),
                         daemon=True, name=f"support-diag-{tid[-6:]}").start()

    return {
        "ok": True,
        "id": tid,
        "status": "open",
        "has_screenshot": bool(shot),
        "inbox_path": inbox,
        "note": (
            "Ticket saved. Auto-diagnosis runs in the background (LLM). "
            "Code fixes require a coding agent session in the workspace "
            "(you do not need the terminal open just to file the ticket)."
        ),
    }


@router.get("/api/support/tickets")
def support_ticket_list(request: Request, status: str = "", limit: int = 40):
    """GP-only: list tickets (no screenshot payload)."""
    _support_gp_only(request)
    _ensure_support_tickets_table()
    limit = max(1, min(int(limit or 40), 100))
    try:
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            if status and status != "all":
                cur.execute("""
                    SELECT id, created_at, updated_at, created_by, created_by_email,
                           status, priority, description, page_url, page_path,
                           active_tab, user_agent, viewport_json, console_errors,
                           context_json, screenshot_mime,
                           CASE WHEN screenshot_b64 IS NOT NULL AND screenshot_b64 <> ''
                                THEN true ELSE false END AS has_shot,
                           diagnosis, agent_brief, fix_trail, fixed_at, fixed_summary
                      FROM support_tickets
                     WHERE status = %s
                     ORDER BY created_at DESC LIMIT %s
                """, (status, limit))
            else:
                cur.execute("""
                    SELECT id, created_at, updated_at, created_by, created_by_email,
                           status, priority, description, page_url, page_path,
                           active_tab, user_agent, viewport_json, console_errors,
                           context_json, screenshot_mime,
                           CASE WHEN screenshot_b64 IS NOT NULL AND screenshot_b64 <> ''
                                THEN true ELSE false END AS has_shot,
                           diagnosis, agent_brief, fix_trail, fixed_at, fixed_summary
                      FROM support_tickets
                     ORDER BY created_at DESC LIMIT %s
                """, (limit,))
            rows = cur.fetchall() or []
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    out = []
    for r in rows:
        d = dict(r)
        d["screenshot_b64"] = "1" if d.pop("has_shot", False) else None
        # has_shot used above — rebuild public without huge fields
        pub = _support_row_public(d)
        # diagnosis may be long — keep full for settings trail
        out.append(pub)
    open_n = sum(1 for t in out if t.get("status") in
                 ("open", "diagnosing", "diagnosed", "in_progress"))
    return {"ok": True, "tickets": out, "open_count": open_n, "count": len(out)}


@router.get("/api/support/tickets/{ticket_id}")
def support_ticket_get(ticket_id: str, request: Request, screenshot: int = 0):
    _support_gp_only(request)
    _ensure_support_tickets_table()
    try:
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            cur.execute("SELECT * FROM support_tickets WHERE id=%s", (ticket_id,))
            row = cur.fetchone()
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    if not row:
        raise HTTPException(404, "Ticket not found")
    return {"ok": True, "ticket": _support_row_public(dict(row),
                                                      include_screenshot=bool(screenshot))}


@router.get("/api/support/tickets/{ticket_id}/screenshot")
def support_ticket_screenshot(ticket_id: str, request: Request):
    _support_gp_only(request)
    _ensure_support_tickets_table()
    try:
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            cur.execute("""
                SELECT screenshot_b64, screenshot_mime FROM support_tickets WHERE id=%s
            """, (ticket_id,))
            row = cur.fetchone()
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    if not row or not row.get("screenshot_b64"):
        raise HTTPException(404, "No screenshot")
    import base64 as _b64
    try:
        raw = _b64.b64decode(row["screenshot_b64"])
    except Exception:
        raise HTTPException(400, "Corrupt screenshot")
    mime = row.get("screenshot_mime") or "image/jpeg"
    return Response(content=raw, media_type=mime,
                    headers={"Cache-Control": "private, max-age=3600"})


@router.post("/api/support/tickets/{ticket_id}/trail")
def support_ticket_trail(ticket_id: str, request: Request):
    """Append a fix-trail event (GP or agent with GP token)."""
    claims = _support_gp_only(request)
    try:
        body = B._request_json_sync(request) or {}
    except Exception:
        body = {}
    action = (body.get("action") or "note").strip()[:80]
    detail = (body.get("detail") or body.get("note") or "").strip()[:4000]
    actor = (body.get("actor")
             or claims.get("email") or claims.get("sub") or "gp")[:80]
    event = _support_trail_event(actor, action, detail)
    _ensure_support_tickets_table()
    try:
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM support_tickets WHERE id=%s", (ticket_id,))
            if not cur.fetchone():
                raise HTTPException(404, "Ticket not found")
            cur.execute("""
                UPDATE support_tickets
                   SET fix_trail = COALESCE(fix_trail, '[]'::jsonb) || %s::jsonb,
                       updated_at = now()
                 WHERE id = %s
            """, (json.dumps([event]), ticket_id))
            conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {"ok": True, "event": event}


@router.patch("/api/support/tickets/{ticket_id}")
@router.post("/api/support/tickets/{ticket_id}/update")
def support_ticket_update(ticket_id: str, request: Request):
    """Update status / fixed summary / diagnosis (GP)."""
    claims = _support_gp_only(request)
    try:
        body = B._request_json_sync(request) or {}
    except Exception:
        body = {}
    status = (body.get("status") or "").strip().lower()
    allowed = {"open", "diagnosing", "diagnosed", "in_progress", "fixed", "closed", "wontfix"}
    if status and status not in allowed:
        return JSONResponse({"ok": False, "error": f"status must be one of {sorted(allowed)}"},
                            status_code=400)
    _ensure_support_tickets_table()
    sets, params = [], []
    if status:
        sets.append("status=%s")
        params.append(status)
    if "fixed_summary" in body:
        sets.append("fixed_summary=%s")
        params.append((body.get("fixed_summary") or "")[:4000])
    if "diagnosis" in body and body.get("diagnosis"):
        sets.append("diagnosis=%s")
        params.append(str(body.get("diagnosis"))[:12000])
    if status == "fixed":
        sets.append("fixed_at=now()")
    if not sets:
        return JSONResponse({"ok": False, "error": "nothing to update"}, status_code=400)
    sets.append("updated_at=now()")
    params.append(ticket_id)
    try:
        with B._fund_conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE support_tickets SET {', '.join(sets)} WHERE id=%s RETURNING id",
                params)
            if not cur.fetchone():
                raise HTTPException(404, "Ticket not found")
            conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)

    detail = body.get("fixed_summary") or body.get("note") or f"status → {status}"
    _support_append_trail(ticket_id, _support_trail_event(
        claims.get("email") or "gp",
        "status_" + (status or "update"),
        detail[:500]))
    return {"ok": True, "id": ticket_id, "status": status or None}


@router.get("/api/support/agent-inbox")
def support_agent_inbox(request: Request):
    """Structured open tickets for coding agents (GP auth). No screenshots in list."""
    _support_gp_only(request)
    _ensure_support_tickets_table()
    try:
        with B._fund_conn() as conn, conn.cursor(cursor_factory=B._RealDictCursor) as cur:
            cur.execute("""
                SELECT id, created_at, status, description, page_url, page_path,
                       active_tab, diagnosis, agent_brief, fix_trail,
                       CASE WHEN screenshot_b64 IS NOT NULL AND screenshot_b64 <> ''
                            THEN true ELSE false END AS has_screenshot
                  FROM support_tickets
                 WHERE status IN ('open','diagnosing','diagnosed','in_progress')
                 ORDER BY created_at DESC LIMIT 25
            """)
            rows = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    for r in rows:
        if hasattr(r.get("created_at"), "isoformat"):
            r["created_at"] = r["created_at"].isoformat() + "Z"
    return {
        "ok": True,
        "count": len(rows),
        "tickets": rows,
        "how_to_fix": (
            "Open this workspace in Grok/Claude Code and ask: "
            "'Fix open support tickets from /api/support/agent-inbox'. "
            "Filing a ticket does NOT require the terminal; applying code "
            "fixes does (or a future CI agent)."
        ),
    }
