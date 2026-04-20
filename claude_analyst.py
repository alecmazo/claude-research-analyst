#!/usr/bin/env python3
"""
DGA Capital Research Analyst — Claude Edition
----------------------------------------------

Terminal entry-point that:
  1. Prompts for a single ticker or a portfolio CSV/XLSX file.
  2. Asks whether to generate Gamma.app presentations (credits guard).
  3. Pulls authoritative financial data from SEC EDGAR XBRL (companyfacts).
  4. Sends the DGA_SYSTEM_PROMPT + verified data to xAI Grok for analysis.
  5. Renders Grok's markdown into a bordered-table Word report.
  6. Optionally creates Gamma presentations for each stock.
  7. For portfolios: builds a roll-up Word summary + Gamma deck that ranks
     what to trim/sell vs add/buy based on valuations.

Data source: SEC EDGAR XBRL only (free, authoritative).

Usage:
    python3 claude_analyst.py
    python3 claude_analyst.py AAPL
    python3 claude_analyst.py --portfolio /path/to/portfolio.csv
    python3 claude_analyst.py --portfolio /path/to/portfolio.xlsx --no-gamma
    python3 claude_analyst.py --portfolio portfolio_watchlist.xlsx --strategy pro
    python3 claude_analyst.py --portfolio portfolio_watchlist.xlsx --strategy concentrated --reuse

Portfolio file schema (CSV or XLSX) — exactly three columns, first row headers:
    Ticker | Weight | Optimized
The "Optimized" column is intentionally IGNORED when loaded, so the output of
one run (DGA-portfolio.xlsx) can be fed back in as the input for the next run.
Weights can be expressed either as decimals (0.05) or whole-number percents (5).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import smtplib
import ssl
import sys
import time
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import pandas as pd
import requests

import sec_edgar_xbrl as edgar  # legacy companyfacts fallback
import excel_financials as xlsx_edgar  # primary: filing-accurate XBRL via edgartools
import pull_sec_financials  # downloader (edgartools-backed)
from word_report import render_report

# ============================================================================
# CONFIG — everything sensitive lives in .env (or real environment variables)
# ============================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
STOCKS_FOLDER = SCRIPT_DIR / "stocks"
STOCKS_FOLDER.mkdir(parents=True, exist_ok=True)

# Default recipient for portfolio-analysis emails (override via PORTFOLIO_EMAIL_TO env var).
DEFAULT_PORTFOLIO_EMAIL_TO = "alecmazo1@gmail.com"


def _load_dotenv() -> None:
    """Load a .env file sitting next to this script, if present.

    Uses python-dotenv when installed, otherwise falls back to a tiny parser
    so the script still runs on a minimal install.
    """
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv(env_path)
        return
    except Exception:
        pass
    # Minimal fallback parser: KEY=VALUE, ignores blanks and '#' comments.
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        # Strip matching surrounding quotes.
        if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
            v = v[1:-1]
        # Don't overwrite anything the shell has already set.
        os.environ.setdefault(k, v)


_load_dotenv()


def _require_env(name: str, *, hint: str = "") -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        msg = (
            f"❌ Missing required environment variable: {name}\n"
            f"   Set it in your shell or in {SCRIPT_DIR / '.env'}"
        )
        if hint:
            msg += f"\n   Hint: {hint}"
        raise SystemExit(msg)
    return val


def _optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip() or default


# xAI API (Grok) — required at call time (not at import; keeps unit-testability)
GROK_MODEL = _optional_env("GROK_MODEL", "grok-4.20-reasoning")

# Gamma.app folder ID is optional; API key is only required if Gamma generation
# is actually requested at runtime.
GAMMA_FOLDER_ID = _optional_env("GAMMA_FOLDER_ID", "")


def get_sec_user_agent() -> str:
    """Resolved on demand so a missing UA fails cleanly when we actually need it."""
    return _require_env(
        "SEC_USER_AGENT",
        hint="Format: 'Your Name your.email@example.com'. SEC blocks anonymous scrapers.",
    )


def get_grok_api_key() -> str:
    return _require_env("XAI_API_KEY", hint="Get yours at https://console.x.ai/")


def get_gamma_api_key() -> str:
    return _require_env("GAMMA_API_KEY", hint="Get yours at https://gamma.app/account")


# ============================================================================
# Portfolio-analysis email notification
# ----------------------------------------------------------------------------
# Triggered ONLY for multi-ticker (portfolio) runs. Single-ticker runs do not
# send mail. Configure via .env:
#   PORTFOLIO_EMAIL_TO=alecmazo1@gmail.com   (override default recipient)
#   GMAIL_USER=you@gmail.com                  (Gmail address to send from)
#   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx    (Gmail App Password — NOT your
#                                              normal Google password. Create at
#                                              https://myaccount.google.com/apppasswords
#                                              with 2FA enabled.)
# If credentials are missing, the function still composes the email body and
# writes it to disk under stocks/Portfolio_Email.eml so nothing is lost.
# ============================================================================

def _ranked_table_text(rows: list[dict] | None, limit: int = 25) -> str:
    if not rows:
        return "(ranked table unavailable)"
    headers = ["Ticker", "Rating", "Price", "12M Target", "Upside %", "Sector"]
    lines = [" | ".join(headers), " | ".join("---" for _ in headers)]
    for r in rows[:limit]:
        price = r.get("price") or r.get("current_price") or ""
        target = r.get("price_target") or r.get("target_price") or ""
        upside = r.get("upside_pct") or ""
        try:
            upside_str = f"{float(upside):.1f}%"
        except Exception:
            upside_str = str(upside) or ""
        lines.append(" | ".join([
            str(r.get("ticker", ""))[:6],
            str(r.get("rating", ""))[:12],
            f"${price}" if price else "",
            f"${target}" if target else "",
            upside_str,
            str(r.get("sector", ""))[:24],
        ]))
    return "\n".join(lines)


def _strategy_weights_text(strategy_results: dict[str, dict] | None) -> str:
    if not strategy_results:
        return "(no strategy weights computed)"
    blocks: list[str] = []
    for skey, res in strategy_results.items():
        weights = res.get("weights", {}) or {}
        held = {t: w for t, w in weights.items() if w and w > 0}
        if not held:
            blocks.append(f"[{skey}] (no positions held)")
            continue
        rows = sorted(held.items(), key=lambda kv: kv[1], reverse=True)
        body = "\n".join(f"  {t:<6} {w*100:6.2f}%" for t, w in rows)
        blocks.append(f"[{skey}]  ({len(rows)} positions)\n{body}")
    return "\n\n".join(blocks)


def _rating_color(rating: str) -> str:
    r = (rating or "").lower()
    if "strong buy" in r:  return "#1a7a3c"
    if "buy" in r:         return "#2e9e54"
    if "hold" in r:        return "#b07d00"
    if "sell" in r:        return "#c0392b"
    return "#555555"


def _upside_color(upside: Any) -> str:
    try:
        v = float(str(upside).replace("%", ""))
        if v >= 30:   return "#1a7a3c"
        if v >= 10:   return "#2e9e54"
        if v >= 0:    return "#b07d00"
        return "#c0392b"
    except Exception:
        return "#555555"


def _md_to_html(md: str) -> str:
    """Convert the most common markdown patterns to HTML for email display."""
    import re
    # Escape HTML special chars first
    md = md.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Bold + italic
    md = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", md)
    md = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", md)
    md = re.sub(r"\*(.+?)\*", r"<em>\1</em>", md)
    # Headers
    md = re.sub(r"^### (.+)$", r"<h4 style='margin:16px 0 6px;color:#0A1628'>\1</h4>", md, flags=re.MULTILINE)
    md = re.sub(r"^## (.+)$",  r"<h3 style='margin:18px 0 8px;color:#0A1628'>\1</h3>", md, flags=re.MULTILINE)
    md = re.sub(r"^# (.+)$",   r"<h2 style='margin:20px 0 10px;color:#0A1628'>\1</h2>", md, flags=re.MULTILINE)
    # Pipe tables → HTML tables
    def _pipe_table(m: re.Match) -> str:
        lines = [l.strip() for l in m.group(0).strip().splitlines() if l.strip()]
        rows = [[c.strip() for c in l.strip("|").split("|")] for l in lines]
        # Second row is separator (---)
        header, body_rows = rows[0], rows[2:]
        th = "".join(f"<th style='padding:6px 10px;background:#0A1628;color:#fff;text-align:left;font-size:12px'>{c}</th>" for c in header)
        trs = ""
        for i, row in enumerate(body_rows):
            bg = "#f8f9fb" if i % 2 == 0 else "#fff"
            tds = "".join(f"<td style='padding:5px 10px;border-bottom:1px solid #e8eaed;font-size:12px'>{c}</td>" for c in row)
            trs += f"<tr style='background:{bg}'>{tds}</tr>"
        return (
            "<table style='border-collapse:collapse;width:100%;margin:10px 0'>"
            f"<thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>"
        )
    md = re.sub(r"(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)", _pipe_table, md)
    # Bullet lists
    md = re.sub(r"^[-*] (.+)$", r"<li style='margin:3px 0'>\1</li>", md, flags=re.MULTILINE)
    md = re.sub(r"(<li.*</li>\n?)+", lambda m: f"<ul style='margin:8px 0 8px 20px;padding:0'>{m.group(0)}</ul>", md)
    # Newlines → paragraphs (two newlines = paragraph break)
    paragraphs = re.split(r"\n{2,}", md)
    parts = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if p.startswith("<h") or p.startswith("<table") or p.startswith("<ul"):
            parts.append(p)
        else:
            p = p.replace("\n", "<br>")
            parts.append(f"<p style='margin:6px 0;line-height:1.5'>{p}</p>")
    return "\n".join(parts)


def _html_ranked_table(rows: list[dict] | None) -> str:
    """Render ranked positions table. Rows come from strategy_results[key]['rows']."""
    if not rows:
        return "<p style='color:#888;font-style:italic'>Ranked table unavailable</p>"
    # Sort by upside descending; skip rows with no positive score
    sorted_rows = sorted(
        [r for r in rows if r.get("upside_pct") is not None],
        key=lambda r: -(r.get("upside_pct") or 0),
    ) or rows
    rows_html = ""
    for i, r in enumerate(sorted_rows[:25]):
        rating = str(r.get("rating") or "—")
        # Field names from compute_rebalance: 'price', 'price_target', 'upside_pct', 'sector'
        price = r.get("price") or r.get("current_price")
        target = r.get("price_target") or r.get("target_price")
        upside = r.get("upside_pct")
        sector = r.get("sector") or "—"
        try:
            price_str = f"${float(price):,.2f}" if price else "—"
        except Exception:
            price_str = f"${price}" if price else "—"
        try:
            target_str = f"${float(target):,.2f}" if target else "—"
        except Exception:
            target_str = f"${target}" if target else "—"
        try:
            upside_str = f"{float(upside):.1f}%"
        except Exception:
            upside_str = str(upside) if upside is not None else "—"
        bg = "#f8f9fb" if i % 2 == 0 else "#fff"
        rows_html += (
            f"<tr style='background:{bg}'>"
            f"<td style='padding:7px 10px;font-weight:700;color:#0A1628;border-bottom:1px solid #e8eaed'>{r.get('ticker','')}</td>"
            f"<td style='padding:7px 10px;border-bottom:1px solid #e8eaed;color:{_rating_color(rating)};font-weight:600'>{rating}</td>"
            f"<td style='padding:7px 10px;border-bottom:1px solid #e8eaed;text-align:right;font-family:monospace'>{price_str}</td>"
            f"<td style='padding:7px 10px;border-bottom:1px solid #e8eaed;text-align:right;font-family:monospace'>{target_str}</td>"
            f"<td style='padding:7px 10px;border-bottom:1px solid #e8eaed;text-align:right;color:{_upside_color(upside)};font-weight:700'>{upside_str}</td>"
            f"<td style='padding:7px 10px;border-bottom:1px solid #e8eaed;color:#555;font-size:12px'>{sector}</td>"
            f"</tr>"
        )
    return (
        "<table style='border-collapse:collapse;width:100%'>"
        "<thead><tr>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:left'>Ticker</th>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:left'>Rating</th>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:right'>Price</th>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:right'>12M Target</th>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:right'>Upside</th>"
        "<th style='padding:8px 10px;background:#0A1628;color:#C9A84C;text-align:left'>Sector</th>"
        "</tr></thead>"
        f"<tbody>{rows_html}</tbody></table>"
    )


def _html_strategy_weights(strategy_results: dict[str, dict] | None) -> str:
    if not strategy_results:
        return "<p style='color:#888;font-style:italic'>No strategy weights computed</p>"
    blocks = []
    for skey, res in strategy_results.items():
        weights = {t: w for t, w in (res.get("weights") or {}).items() if w and w > 0}
        if not weights:
            continue
        label = res.get("label") or skey
        sorted_w = sorted(weights.items(), key=lambda kv: kv[1], reverse=True)
        rows_html = ""
        for i, (ticker, w) in enumerate(sorted_w):
            bg = "#f8f9fb" if i % 2 == 0 else "#fff"
            bar_w = int(w * 400)
            rows_html += (
                f"<tr style='background:{bg}'>"
                f"<td style='padding:6px 10px;font-weight:700;color:#0A1628;width:70px'>{ticker}</td>"
                f"<td style='padding:6px 10px'>"
                f"<div style='background:#e8eaed;border-radius:3px;height:10px;width:100%'>"
                f"<div style='background:#C9A84C;border-radius:3px;height:10px;width:{min(bar_w,400)}px'></div></div></td>"
                f"<td style='padding:6px 10px;text-align:right;font-weight:600;color:#0A1628;width:60px'>{w*100:.1f}%</td>"
                f"</tr>"
            )
        blocks.append(
            f"<div style='flex:1;min-width:200px;margin:0 8px 16px'>"
            f"<div style='background:#0A1628;color:#C9A84C;padding:8px 10px;font-weight:700;font-size:13px;border-radius:6px 6px 0 0'>"
            f"{label} &nbsp;<span style='color:#fff;font-weight:400;font-size:11px'>({len(sorted_w)} positions)</span></div>"
            f"<table style='border-collapse:collapse;width:100%;border:1px solid #e8eaed;border-top:none;border-radius:0 0 6px 6px'>"
            f"<tbody>{rows_html}</tbody></table></div>"
        )
    return f"<div style='display:flex;flex-wrap:wrap;margin:0 -8px'>{''.join(blocks)}</div>"


def build_portfolio_email(
    *,
    tickers_ok: list[str],
    tickers_failed: list[str],
    summary_markdown: str,
    ranked_rows: list[dict] | None,
    strategy_results: dict[str, dict] | None,
    output_xlsx: Path | None,
    portfolio_docx: Path | None,
    gamma_url: str | None,
) -> EmailMessage:
    """Compose the EmailMessage for a portfolio-analysis run (HTML + plain text)."""
    import base64 as _b64

    to_addr = _optional_env("PORTFOLIO_EMAIL_TO", DEFAULT_PORTFOLIO_EMAIL_TO)
    from_addr = _optional_env("GMAIL_USER", to_addr)
    today = datetime.now().strftime("%Y-%m-%d")
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")

    subject = f"DGA Portfolio Analysis — {today} — {len(tickers_ok)} positions"

    # Use strategy rows (always complete) for the ranked table, sorted by upside desc.
    primary_strategy = next(iter(strategy_results)) if strategy_results else None
    email_rows = []
    if strategy_results and primary_strategy:
        email_rows = sorted(
            strategy_results[primary_strategy].get("rows", []),
            key=lambda r: -(r.get("upside_pct") or 0),
        )

    # ---- Plain-text fallback ------------------------------------------------
    plain_parts = [
        "DGA Capital — Portfolio Analysis Run",
        f"Generated: {generated}",
        "",
        f"Tickers analyzed: {', '.join(tickers_ok) or '(none)'}",
    ]
    if tickers_failed:
        plain_parts.append(f"Failed: {', '.join(tickers_failed)}")
    if gamma_url:
        plain_parts.append(f"Gamma deck: {gamma_url}")
    plain_parts += ["", "RANKED TABLE", "=" * 60, _ranked_table_text(email_rows),
                    "", "STRATEGY WEIGHTS", "=" * 60, _strategy_weights_text(strategy_results),
                    "", "PORTFOLIO ROLL-UP", "=" * 60,
                    (summary_markdown or "(no roll-up generated)").strip()]
    plain_body = "\n".join(plain_parts)

    # ---- Logo (base64 embedded so it shows in all email clients) ------------
    logo_img_tag = ""
    for logo_name in ("DGAlogo-web184.png", "dga_logo.png", "dga_logo_small.png"):
        logo_path = SCRIPT_DIR / "branding" / logo_name
        if logo_path.exists():
            logo_b64 = _b64.b64encode(logo_path.read_bytes()).decode()
            logo_img_tag = (
                f"<img src='data:image/png;base64,{logo_b64}' "
                f"alt='DGA Capital' style='height:44px;width:auto;display:block'>"
            )
            break

    # ---- HTML body ----------------------------------------------------------
    failed_row = ""
    if tickers_failed:
        failed_row = (
            f"<tr><td style='color:#888;width:130px'>Failed</td>"
            f"<td style='color:#c0392b'>{', '.join(tickers_failed)}</td></tr>"
        )
    gamma_row = ""
    if gamma_url:
        gamma_row = (
            f"<tr><td style='color:#888'>Gamma deck</td>"
            f"<td><a href='{gamma_url}' style='color:#C9A84C'>{gamma_url}</a></td></tr>"
        )
    md_html = _md_to_html((summary_markdown or "").strip()[:60_000]
                          or "<em>No roll-up generated.</em>")

    html_body = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

  <!-- Header -->
  <tr><td style="background:#0A1628;border-radius:10px 10px 0 0;padding:24px 32px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle">{logo_img_tag if logo_img_tag else '<span style="color:#C9A84C;font-size:22px;font-weight:700;letter-spacing:2px">DGA CAPITAL</span>'}</td>
      <td style="vertical-align:middle;padding-left:16px;color:rgba(255,255,255,0.5);font-size:13px;letter-spacing:1px">Portfolio Analysis</td>
    </tr></table>
  </td></tr>

  <!-- Meta -->
  <tr><td style="background:#fff;padding:20px 32px;border-bottom:2px solid #C9A84C">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#333">
      <tr>
        <td style="color:#888;width:130px">Generated</td>
        <td style="font-weight:600">{generated}</td>
      </tr>
      <tr>
        <td style="color:#888;padding-top:4px">Tickers</td>
        <td style="padding-top:4px">{', '.join(tickers_ok) or '(none)'}</td>
      </tr>
      {failed_row}
      {gamma_row}
    </table>
  </td></tr>

  <!-- Ranked Table -->
  <tr><td style="background:#fff;padding:24px 32px">
    <h2 style="margin:0 0 14px;font-size:15px;font-weight:700;color:#0A1628;
               letter-spacing:1px;text-transform:uppercase;border-left:4px solid #C9A84C;padding-left:10px">
      Ranked Positions
    </h2>
    {_html_ranked_table(email_rows)}
  </td></tr>

  <!-- Strategy Weights -->
  <tr><td style="background:#f8f9fb;padding:24px 32px;border-top:1px solid #e8eaed">
    <h2 style="margin:0 0 16px;font-size:15px;font-weight:700;color:#0A1628;
               letter-spacing:1px;text-transform:uppercase;border-left:4px solid #C9A84C;padding-left:10px">
      Strategy Weights
    </h2>
    {_html_strategy_weights(strategy_results)}
  </td></tr>

  <!-- Roll-Up -->
  <tr><td style="background:#fff;padding:24px 32px;border-top:1px solid #e8eaed">
    <h2 style="margin:0 0 14px;font-size:15px;font-weight:700;color:#0A1628;
               letter-spacing:1px;text-transform:uppercase;border-left:4px solid #C9A84C;padding-left:10px">
      Portfolio Roll-Up
    </h2>
    <div style="font-size:13px;color:#333;line-height:1.6">
      {md_html}
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0A1628;border-radius:0 0 10px 10px;padding:16px 32px;text-align:center">
    <span style="color:#888;font-size:11px">DGA Capital · Portfolio Analysis · {today}</span>
    {"&nbsp;·&nbsp;<a href='" + gamma_url + "' style='color:#C9A84C;font-size:11px'>View Gamma Deck</a>" if gamma_url else ""}
  </td></tr>

</table>
</td></tr></table>
</body></html>"""

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.set_content(plain_body)
    msg.add_alternative(html_body, subtype="html")

    # Attach xlsx and Word report.
    for path in (portfolio_docx, output_xlsx):
        if path and Path(path).is_file():
            ctype, _ = mimetypes.guess_type(str(path))
            maintype, subtype = (ctype.split("/", 1) if ctype else ("application", "octet-stream"))
            with open(path, "rb") as fh:
                msg.add_attachment(
                    fh.read(), maintype=maintype, subtype=subtype, filename=Path(path).name,
                )

    return msg


def send_portfolio_email(msg: EmailMessage) -> dict:
    """Send via Gmail SMTP using GMAIL_USER + GMAIL_APP_PASSWORD.

    Returns {ok, sent_to, fallback_path?, error?}. Always writes a .eml fallback
    next to the stocks folder so the artifact survives even if SMTP is misconfigured.
    """
    fallback = STOCKS_FOLDER / "Portfolio_Email.eml"
    try:
        with open(fallback, "wb") as fh:
            fh.write(bytes(msg))
    except Exception as exc:  # pragma: no cover — disk write should not fail in practice
        print(f"   ⚠️  Could not write fallback .eml: {exc}")

    user = _optional_env("GMAIL_USER", "")
    pwd = _optional_env("GMAIL_APP_PASSWORD", "")
    if not user or not pwd:
        return {
            "ok": False,
            "sent_to": msg["To"],
            "fallback_path": str(fallback),
            "error": (
                "Email NOT sent — set GMAIL_USER and GMAIL_APP_PASSWORD in .env "
                "(create an App Password at https://myaccount.google.com/apppasswords). "
                f"Email body saved to {fallback}."
            ),
        }

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx, timeout=30) as smtp:
            smtp.login(user, pwd)
            smtp.send_message(msg)
        return {"ok": True, "sent_to": msg["To"], "fallback_path": str(fallback)}
    except Exception as exc:
        return {
            "ok": False,
            "sent_to": msg["To"],
            "fallback_path": str(fallback),
            "error": f"SMTP send failed: {exc}. Email body saved to {fallback}.",
        }


# ============================================================================
# DGA_SYSTEM_PROMPT  (reads from /stocks/dga_system_prompt.txt if present, else uses default)
# ============================================================================
_DEFAULT_SYSTEM_PROMPT_PATH = STOCKS_FOLDER / "dga_system_prompt.txt"

DEFAULT_DGA_SYSTEM_PROMPT = """You are DGA Capital Analyst, a senior equity research analyst at Goldman Sachs level. You produce formal, institutional-quality research reports.

You are operating on today's date: Always base every analysis on the most recent market data, earnings, news, filings, and analyst updates available right now.
Use ONLY the price, previous close, and market cap numbers explicitly given in the user message. Never use outdated numbers.

FINANCIAL DATA EXTRACTION RULES - MANDATORY AND NON-NEGOTIABLE FOR ALL STOCK ANALYSIS:

You MUST treat financial numbers as the single most important part of the report. Any error here invalidates the entire analysis.

MANDATORY DATA VERIFICATION STEP (perform this at the VERY START):
1. You are given verified financial data below from official SEC EDGAR XBRL filings (companyfacts + submissions APIs).
2. You MUST use ONLY these exact numbers for ALL tables and calculations.
3. The verified block contains:
   - LATEST_FILING_TYPE (10-K or 10-Q)
   - ANNUAL DATA (last 3 fiscal years) from the latest 10-K
   - QUARTERLY DATA (latest quarter + same quarter prior year + YTD both years) from the latest 10-Q
4. Use the ANNUAL DATA for the main Key Metrics table.
5. If LATEST_FILING_TYPE is 10-Q, also create the Latest Quarterly YoY Analysis table using the QUARTERLY DATA.
6. If LATEST_FILING_TYPE is 10-K, skip the quarterly subsection entirely.
7. If any number is 'N/A', write exactly: "Data not available in verified filing - please check latest 10-K/10-Q".
8. All values in the VERIFIED block are reported in raw $ (or $ per share for EPS). For tables, convert to millions ($M) with one decimal place, unless EPS (two decimals).

TABLE FORMAT REQUIREMENT (use this exact markdown format - no deviations):
| Metric                          | TTM (as of [Date]) | FY[Year] (ended [Date]) | FY[Year-1] (ended [Date]) | FY[Year-2] (ended [Date]) |
|---------------------------------|--------------------|--------------------------|---------------------------|---------------------------|
| Revenue ($M)                    | exact_number      | exact_number            | exact_number             | exact_number             |
| Operating Income ($M)           | exact_number      | exact_number            | exact_number             | exact_number             |
| Operating Margin (%)            | xx.x%             | xx.x%                   | xx.x%                    | xx.x%                    |
| Net Income ($M)                 | exact_number      | exact_number            | exact_number             | exact_number             |
| Net Profit Margin (%)           | xx.x%             | xx.x%                   | xx.x%                    | xx.x%                    |
| Diluted EPS                     | exact_number      | exact_number            | exact_number             | exact_number             |
| Free Cash Flow ($M)             | exact_number      | exact_number            | exact_number             | exact_number             |
| Total Debt ($M)                 | exact_number      | exact_number            | exact_number             | exact_number             |
| Cash & Equivalents ($M)         | exact_number      | exact_number            | exact_number             | exact_number             |
| Net Debt ($M)                   | exact_number      | exact_number            | exact_number             | exact_number             |

At the top of the financial section you MUST write exactly:
"Data Verification: Official company FY[Year] 10-K + 10-Q filings (verified via SEC EDGAR XBRL). Numbers used are exact filing figures only. TTM calculated as sum of last four quarters."

Sources must always be stated at the bottom exactly as:
"Sources: Official [Company Name] FY[Year] 10-K + 10-Q filings (verified via SEC EDGAR XBRL). Data Verification completed."

All other sections of the report (Executive Summary, Valuation, etc.) must be consistent with these verified financial numbers. Never contradict them.

GENERAL RULES:
- Put "DGA Capital Research" as the header and add today's date.

SECTION 1 — Executive Summary:
→ Investment thesis: Why should someone care about this stock right now?
→ Overall rating: Strong Buy / Buy / Hold / Sell
→ 12-month price target with the methodology used to calculate it
→ The single biggest reason to own this stock and the single biggest risk
→ The 30-second elevator pitch: If you had one paragraph to pitch this stock to a portfolio manager, what would you say?

SECTION 2 — Business Overview:
→ What the company does in plain English
→ Revenue breakdown by segment, product, and geography (with percentages)
→ Business model: How they make money and what drives repeat revenue
→ Competitive moat: What makes this company hard to replicate?

SECTION 3 — Financial Deep Dive:
→ Data Verification & Financial Foundation – Always begin with the MANDATORY DATA VERIFICATION STEP and full financial tables from the FINANCIAL DATA EXTRACTION RULES above.
→ Key Metrics: go to FINANCIAL DATA EXTRACTION RULES - MANDATORY FOR ALL STOCK ANALYSIS, and follow every step exactly as written, including table format.
→ Balance sheet health: cash, debt, current ratio, debt-to-equity
→ Cash flow quality: operating cash flow vs. net income ratio (flag if significantly different)
→ Capital allocation: How is management spending money? Buybacks, dividends, M&A, R&D?

→ Latest Quarterly YoY Analysis:
   ONLY include this subsection if the verified block says LATEST_FILING_TYPE: 10-Q.
   If LATEST_FILING_TYPE: 10-K, skip this subsection entirely.
   When included, create a dedicated Quarterly YoY Comparison Table using this exact column order and markdown format.

   TABLE FORMAT REQUIREMENT (use this exact markdown format - no deviations):
   | Metric                          | Latest Quarter (ended [Date]) | Same Quarter Last Year (ended [Date]) | YoY % Change | YTD Current Fiscal (ended [Date]) | Prior YTD | YoY % Change (YTD) |
   |---------------------------------|-------------------------------|---------------------------------------|--------------|-----------------------------------|-----------|--------------------|
   | Revenue ($M)                    | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Operating Income ($M)           | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Operating Margin (%)            | xx.x%                        | xx.x%                                | +xx.xppt    | xx.x%                            | xx.x%        | +xx.xppt          |
   | Net Income ($M)                 | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Net Profit Margin (%)           | xx.x%                        | xx.x%                                | +xx.xppt    | xx.x%                            | xx.x%        | +xx.xppt          |
   | Diluted EPS                     | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |
   | Free Cash Flow ($M)             | exact_number                 | exact_number                         | +xx.x%      | exact_number                     | exact_number | +xx.x%            |

   At the top of this subsection you MUST write exactly:
   "Latest Quarterly YoY Analysis – Official 10-Q filing (verified via SEC EDGAR XBRL). Numbers are exact filing figures only."

   Clearly state the exact quarter end dates (e.g., "Q2 FY2026 ended Feb 28, 2026 vs Q2 FY2025 ended Feb 28, 2025").
   Use ONLY the exact quarterly and YTD numbers from the verified financial data block.
   If the fiscal year is incomplete, the YTD columns must reflect the partial year-to-date results.
   Highlight any material acceleration or deceleration in growth with clear commentary.

SECTION 4 — Growth Analysis:
Financial Modeling & Projections – Build or update a detailed three-statement model; forecast 5–10 years of key metrics with explicit assumptions; calculate TTM and forward estimates.
→ Total addressable market (TAM) with source
→ Current market share and trajectory
→ Key growth drivers for the next 3-5 years
→ Management guidance vs. analyst consensus — who is more bullish?
→ Is growth organic or acquisition-dependent?

SECTION 5 — Valuation:
Multi-Method Valuation – Perform at least two primary methods:
   - Discounted Cash Flow (DCF) with explicit WACC, terminal growth, and sensitivity analysis.
   - Comparable company analysis (multiples: EV/EBITDA, P/E, etc.) and precedent transactions where relevant, minimum 5 peer comps.
   - Cross-check with any other appropriate method (e.g., sum-of-the-parts).
→ Historical valuation range (5-year P/E band)
→ Bull / Base / Bear price targets with assumptions for each
→ Current price vs. each target — upside or downside %

SECTION 6 — Risk Analysis:
→ Latest developments in the headlines: scan X (old Twitter), and summarize anything new announced in the past 30 days like Gov't investigations, lawsuits, executive turmoil, anything coming out of left field that could negatively affect the company.
→ Top 5 material risks ranked by probability and impact
→ For each risk: what would trigger it, how bad it would be, and what to watch for
→ Short interest and insider activity data (cite source)
→ Accounting quality flags (if any)

SECTION 7 — Catalyst Calendar:
→ Next earnings date
→ Upcoming product launches, regulatory decisions, or strategic events
→ Macro events that specifically impact this stock
→ Timeline of potential catalysts over the next 12 months

SECTION 8 — The Verdict:
→ Bull case: Price target and what has to go right (with probability estimate)
→ Base case: Price target and most likely scenario (with probability estimate)
→ Bear case: Price target and what could go wrong (with probability estimate)
→ Expected value calculation: Probability-weighted price target across all three scenarios
→ Final recommendation with conviction level: High / Medium / Low

SECTION 9 — Institutional Activity:
→ Top 5 institutional holders and their position changes last quarter
→ Any notable hedge fund activity (new positions or exits)

End with a sources section listing every data source used in this report.
"""


def load_system_prompt() -> str:
    """Use override file in /stocks/dga_system_prompt.txt if present."""
    if _DEFAULT_SYSTEM_PROMPT_PATH.exists():
        return _DEFAULT_SYSTEM_PROMPT_PATH.read_text()
    return DEFAULT_DGA_SYSTEM_PROMPT


# ============================================================================
# Market price (free, no-key) — use Yahoo via requests-only lightweight call
# ============================================================================
def fetch_market_snapshot(ticker: str) -> dict:
    """Best-effort current price + previous close via Yahoo Finance public endpoint."""
    out = {"price": None, "previous_close": None, "market_cap": None, "source": ""}
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        resp = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=15,
        )
        data = resp.json()
        result = data.get("chart", {}).get("result", [])
        if result:
            meta = result[0].get("meta", {})
            out["price"] = meta.get("regularMarketPrice") or meta.get("previousClose")
            out["previous_close"] = meta.get("previousClose")
            out["source"] = "Yahoo Finance"
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Market snapshot failed: {exc}")
    return out


# ============================================================================
# Grok (xAI) call
# ============================================================================
def _client():
    # Imported lazily so the module can be loaded without the openai package
    # (e.g. for parser/word-render unit tests) — only needed at call time.
    from openai import OpenAI  # type: ignore
    return OpenAI(api_key=get_grok_api_key(), base_url="https://api.x.ai/v1")


def call_grok(system_prompt: str, user_content: str,
              model: str = GROK_MODEL) -> str:
    client = _client()
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return resp.choices[0].message.content or ""


# ============================================================================
# Ratings / price-target extraction for portfolio ranking
# ============================================================================
_RATING_RE = re.compile(
    r"\b(Strong Buy|Buy|Hold|Sell|Strong Sell)\b", re.IGNORECASE
)
_PRICE_TARGET_RE = re.compile(
    r"price target[^\$]{0,60}\$([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]+)?)", re.IGNORECASE,
)
# Stronger anchors that reliably appear in DGA reports.
_PT_STRONG_RE = re.compile(
    r"(?:12-?Month\s+Price\s+Target|Base\s+Case\s+Price\s+Target|"
    r"12-?month\s+target)[^\$]{0,40}\$\s*([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]+)?)",
    re.IGNORECASE,
)
_CURRENT_PRICE_RE = re.compile(
    r"(?:Current\s+Price|CURRENT_PRICE|Current\s+market\s+price)"
    r"[^\$\d-]{0,15}\$?\s*([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]+)?)",
    re.IGNORECASE,
)
_UPSIDE_RE = re.compile(
    r"(?:Implied\s+Return|Upside|Expected\s+Return|Implied\s+Upside)"
    r"[^\d\-\+]{0,15}([+-]?\d+(?:\.\d+)?)\s*%",
    re.IGNORECASE,
)
_RATING_ANCHORED_RE = re.compile(
    r"(?:"
    r"(?:Overall\s+[Rr]ating|Final\s+Recommendation|Recommendation|Conviction\s+Level)"
    r"[:\*\s]{0,8}"
    r"|We\s+rate\s+[A-Z.]+\s+"
    r"|[Rr]ating[:\s]+\**\s*"
    r")\**\s*(Strong Buy|Buy|Hold|Sell|Strong Sell)\**",
    re.IGNORECASE,
)


def extract_summary_from_report(report_text: str) -> dict:
    """Pull rating + 12-month price target + current price + upside + thesis.

    Uses strong anchors when present (the DGA report template is consistent),
    falls back to looser matching for older reports.
    """
    # --- Rating: prefer anchored matches (Overall Rating / We rate XXX BUY).
    rating = None
    m = _RATING_ANCHORED_RE.search(report_text[:6000])
    if m:
        rating = m.group(1).title()
    else:
        m2 = _RATING_RE.search(report_text[:4000])
        if m2:
            rating = m2.group(1).title()

    # --- 12M Price Target.
    price_target = None
    m = _PT_STRONG_RE.search(report_text)
    if not m:
        m = _PRICE_TARGET_RE.search(report_text)
    if m:
        try:
            price_target = float(m.group(1).replace(",", ""))
        except ValueError:
            pass

    # --- Current Price.
    current_price = None
    m = _CURRENT_PRICE_RE.search(report_text)
    if m:
        try:
            current_price = float(m.group(1).replace(",", ""))
        except ValueError:
            pass

    # --- Upside / Implied Return.
    upside_pct = None
    m = _UPSIDE_RE.search(report_text)
    if m:
        try:
            upside_pct = float(m.group(1))
        except ValueError:
            pass
    if upside_pct is None and price_target and current_price:
        try:
            upside_pct = round((price_target - current_price) / current_price * 100, 2)
        except ZeroDivisionError:
            pass

    # Thesis hint.
    thesis = ""
    for line in report_text.split("\n"):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("|") or s.startswith(">"):
            continue
        thesis = s[:400]
        break

    return {
        "rating": rating,
        "price_target": price_target,
        "current_price": current_price,
        "upside_pct": upside_pct,
        "thesis": thesis,
    }


# ============================================================================
# Gamma.app integration
# ============================================================================
def _gamma_design_block() -> str:
    return """IMPORTANT DESIGN RULES (enforce strictly):
- Branding: DGA CAPITAL. Place a bold "DGA CAPITAL" wordmark in gold
  (#C9A84C) on a deep navy (#0A1628) background on the title card and as
  a small header on every subsequent card. Use "DGA Capital Research" as
  the recurring footer line on every slide.
- Color palette: navy (#0A1628 / #132040), gold (#C9A84C / #D9BE6E),
  off-white (#F5F7FA), dark gray (#3D4A5C). Use gold sparingly as accent.
- Clean, modern corporate-finance theme (Chisel or equivalent).
- ALL TEXT minimum 12pt (titles 28–32pt, headings 20–24pt, body 14–18pt).
- CHARTS: solid fills, bold borders, high contrast, ample white space.
  • Pie / donut charts: show percentage labels ON each segment (e.g. "45%").
  • Legends 12pt+.
- Tables: large numbers, professional black borders.
- Must look like a top-tier Goldman Sachs research deck.
"""


def create_gamma_for_stock(report_text: str, ticker: str, latest_filing_type: str,
                           out_pptx: Path | None = None) -> tuple[str | None, int]:
    print(f"   📤 Gamma: generating presentation for {ticker}…")
    include_qtr = latest_filing_type == "10-Q"
    num_cards = 19 if include_qtr else 18
    qtr_card = (
        "8. Latest Quarterly Financial Deep Dive – latest Q vs prior-year Q (include both the quarterly and YTD comparison tables with YoY % changes)\n"
        if include_qtr
        else ""
    )
    shortened = report_text[:18000]
    title = f"DGA Capital Research — {ticker} | {datetime.now().strftime('%B %d, %Y')}"
    input_text = f"""Create a professional institutional-quality investment research **PRESENTATION** for {ticker}.

Title: "{title}"

{_gamma_design_block()}

Create at least {num_cards} cards structured exactly like this:
1. Title + Key Thesis
2. Executive Summary + Rating + Price Target
3. Bull Case
4. Business Overview
5. Revenue Breakdown (by segment + by geography — use clean donut charts with % labels)
6. Competitive Moat
7. Financial Deep Dive + Key Metrics Table (Annual + TTM)
{qtr_card}8. Income Statement & Margins
9. Balance Sheet & Cash Flow
10. Growth Analysis
11. 5-Year Projections
12. DCF Valuation
13. Comps Valuation
14. Historical Valuation + Bull/Base/Bear Targets
15. Risk Analysis
16. Latest Developments
17. Catalyst Calendar
18. Final Verdict & Recommendation

Use the full report content below. Every chart, legend and table must be large and professional.

{shortened}
"""
    return _gamma_generate(input_text, num_cards=num_cards, out_pptx=out_pptx)


def create_gamma_portfolio_summary(summary_markdown: str, ranked_rows: list[dict],
                                   out_pptx: Path | None = None) -> tuple[str | None, int]:
    print("   📤 Gamma: generating portfolio summary deck…")
    title = f"DGA Capital Research — Portfolio Summary | {datetime.now().strftime('%B %d, %Y')}"
    def _action(r: dict) -> str:
        return str(r.get("action", "")).strip().upper()
    top_trim = [r for r in ranked_rows if _action(r) in ("TRIM", "SELL", "STRONG SELL")]
    top_buy = [r for r in ranked_rows if _action(r) in ("ADD", "BUY", "STRONG BUY")]
    header = (
        f"Portfolio under review: {len(ranked_rows)} positions.\n"
        f"Candidates to TRIM / SELL: {', '.join(r['ticker'] for r in top_trim) or 'None'}\n"
        f"Candidates to ADD / BUY: {', '.join(r['ticker'] for r in top_buy) or 'None'}\n"
    )
    input_text = f"""Create a professional **PORTFOLIO-LEVEL** research deck.

Title: "{title}"

{_gamma_design_block()}

{header}

Include the following cards (in order):
1. Title + portfolio snapshot
2. Summary ranking — all tickers with rating, price target, upside %, action
3. TOP TRIM / SELL candidates — why each, with catalysts
4. TOP ADD / BUY candidates — why each, with catalysts
5. Valuation comparison table across all names (P/E, EV/EBITDA, FCF yield, upside)
6. Sector / concentration risk
7. Rebalancing action plan (concrete recommended moves)
8. Key catalysts to watch across the portfolio (next 12 months)

Use the portfolio write-up below verbatim where applicable.

{summary_markdown}
"""
    return _gamma_generate(input_text, num_cards=8, out_pptx=out_pptx)


def _gamma_generate(input_text: str, num_cards: int,
                    out_pptx: Path | None = None) -> tuple[str | None, int]:
    headers = {"Content-Type": "application/json", "X-API-KEY": get_gamma_api_key()}
    payload = {
        "inputText": input_text,
        "textMode": "generate",
        "format": "presentation",
        "numCards": max(8, num_cards),
        "exportAs": "pptx",
        "folderIds": [GAMMA_FOLDER_ID] if GAMMA_FOLDER_ID else None,
    }
    resp = requests.post(
        "https://public-api.gamma.app/v1.0/generations",
        json=payload,
        headers=headers,
        timeout=60,
    )
    if resp.status_code not in (200, 201):
        print(f"   ❌ Gamma error {resp.status_code}: {resp.text[:300]}")
        return None, 0
    gen_id = resp.json().get("generationId")
    print(f"   ✅ Gamma generation started ({gen_id})")

    for attempt in range(200):
        time.sleep(6)
        status = requests.get(
            f"https://public-api.gamma.app/v1.0/generations/{gen_id}",
            headers=headers,
            timeout=30,
        ).json()
        if status.get("status") == "completed":
            gamma_url = status.get("gammaUrl")
            export_url = status.get("exportUrl")
            credits = status.get("credits", {})
            used = credits.get("deducted", 0)
            remaining = credits.get("remaining", "?")
            print(f"   ✅ PPTX ready: {gamma_url}  (credits used: {used}, remaining: {remaining})")
            if export_url and out_pptx is not None:
                r = requests.get(export_url, stream=True, timeout=60)
                with open(out_pptx, "wb") as fh:
                    for chunk in r.iter_content(8192):
                        fh.write(chunk)
                print(f"   💾 Saved {out_pptx}")
            return gamma_url, used
        if status.get("status") == "failed":
            print("   ❌ Gamma generation failed")
            return None, 0
        if attempt % 10 == 0:
            print(f"   ⏳ Gamma still generating… ({attempt+1}/200)")
    print("   ❌ Gamma timeout")
    return None, 0


# ============================================================================
# Per-ticker analysis pipeline
# ============================================================================
def analyze_ticker(ticker: str, *, system_prompt: str, generate_gamma: bool,
                   verbose: bool = True, reuse_existing: bool = False) -> dict:
    """Analyze a single ticker end-to-end.

    When ``reuse_existing`` is True and a cached markdown report already exists
    in /stocks, we load it instead of re-calling Grok. This is what the
    portfolio-rebalance flow uses by default so we don't burn 20+ API calls
    every time we re-optimize weights.
    """
    ticker = ticker.strip().upper()
    result = {"ticker": ticker, "ok": False}

    # --- Fast path: reuse an existing report if present and requested.
    md_path = STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
    if reuse_existing and md_path.exists():
        print(f"♻️  {ticker}: reusing cached report at {md_path.name}")
        report_text = md_path.read_text()
        mkt = fetch_market_snapshot(ticker)
        audit_path = STOCKS_FOLDER / f"{ticker}_xbrl_extract.json"
        entity_name, latest_filing_type = ticker, "10-K"
        if audit_path.exists():
            try:
                with open(audit_path) as fh:
                    d = json.load(fh)
                entity_name = d.get("entity_name", ticker) or ticker
                latest_filing_type = d.get("latest_filing_type", "10-K") or "10-K"
            except Exception:
                pass
        summary = extract_summary_from_report(report_text)
        market_price = mkt.get("price") or summary.get("current_price")
        return {
            "ok": True,
            "ticker": ticker,
            "entity_name": entity_name,
            "latest_filing_type": latest_filing_type,
            "market_price": market_price,
            "report_text": report_text,
            "docx": str(STOCKS_FOLDER / f"{ticker}_DGA_Report.docx"),
            "md": str(md_path),
            "xbrl_json": str(audit_path) if audit_path.exists() else None,
            "gamma_url": None,
            "gamma_credits": 0,
            "summary": summary,
            "cached": True,
        }

    # --- Step 1: download the latest 10-K and 10-Q into stock-financials/{TICKER}/
    # This parses the actual XBRL instance documents from each filing, so the
    # columns we read later map 1-to-1 onto the filing's own period contexts.
    print(f"\n🚀 {ticker}: downloading latest 10-K + 10-Q Excel workbooks…")
    data: dict | None = None
    try:
        pull_sec_financials.download_financials(ticker)
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Could not download fresh Excel files: {exc}")
        print("   Falling back to existing workbooks (if any) or companyfacts API.")

    # --- Step 2: read the Excel workbooks and build the verified data dict
    try:
        data = xlsx_edgar.extract_financials(ticker)
        verified_block = xlsx_edgar.format_verified_block(data)
        print(f"   ✅ Loaded filing-accurate financials from Excel workbooks.")
    except Exception as exc:  # noqa: BLE001
        print(f"   ⚠️  Excel reader failed: {exc}")
        print(f"   Falling back to SEC companyfacts API…")
        try:
            data = edgar.extract_financials(ticker, user_agent=get_sec_user_agent())
            verified_block = edgar.format_verified_block(data)
        except Exception as exc2:  # noqa: BLE001
            print(f"   ❌ EDGAR fallback also failed: {exc2}")
            result["error"] = str(exc2)
            return result

    # Cache the raw extract for auditing.
    audit_path = STOCKS_FOLDER / f"{ticker}_xbrl_extract.json"
    try:
        with open(audit_path, "w") as f:
            json.dump(data, f, indent=2, default=str)
    except Exception:
        pass

    if verbose:
        print(verified_block)

    # Current price
    mkt = fetch_market_snapshot(ticker)

    # Compose Grok user message
    today = datetime.now().strftime("%Y-%m-%d")
    user_msg = (
        f"DATE: {today}\n"
        f"TICKER: {ticker}\n"
        f"ENTITY: {data.get('entity_name','')}\n"
        f"CURRENT_PRICE: {mkt.get('price')}\n"
        f"PREVIOUS_CLOSE: {mkt.get('previous_close')}\n"
        f"LATEST_FILING_TYPE: {data.get('latest_filing_type')}\n\n"
        f"{verified_block}\n\n"
        f"Generate the full research report for {ticker} following every rule in your system prompt."
    )

    print(f"   🧠 Calling Grok ({GROK_MODEL})…")
    try:
        report_text = call_grok(system_prompt, user_msg)
    except Exception as exc:  # noqa: BLE001
        print(f"   ❌ Grok API error: {exc}")
        result["error"] = f"Grok: {exc}"
        return result

    # Save markdown too, for debugging / iteration.
    md_path = STOCKS_FOLDER / f"{ticker}_DGA_Report.md"
    md_path.write_text(report_text)

    # Render Word
    out_docx = STOCKS_FOLDER / f"{ticker}_DGA_Report.docx"
    summary = extract_summary_from_report(report_text)
    rating_hint = summary.get("rating") or ""
    render_report(
        report_text,
        ticker=ticker,
        entity_name=data.get("entity_name", ticker),
        output_path=str(out_docx),
        price=mkt.get("price"),
        rating_hint=rating_hint,
    )
    print(f"   💾 Word: {out_docx}")

    # Gamma
    gamma_url = None
    gamma_credits = 0
    if generate_gamma:
        out_pptx = STOCKS_FOLDER / f"{ticker}_DGA_Presentation.pptx"
        gamma_url, gamma_credits = create_gamma_for_stock(
            report_text, ticker, data.get("latest_filing_type", "10-K"), out_pptx=out_pptx
        )

    result.update({
        "ok": True,
        "entity_name": data.get("entity_name", ticker),
        "latest_filing_type": data.get("latest_filing_type"),
        "market_price": mkt.get("price"),
        "report_text": report_text,
        "docx": str(out_docx),
        "md": str(md_path),
        "xbrl_json": str(audit_path),
        "gamma_url": gamma_url,
        "gamma_credits": gamma_credits,
        "summary": summary,
    })
    return result


# ============================================================================
# Portfolio roll-up (Grok call over per-stock summaries)
# ============================================================================
PORTFOLIO_SYSTEM_PROMPT = """You are DGA Capital's portfolio strategist. You are given per-stock
analyses already produced by the DGA equity research team. Your job is to:

1) Rank all positions into ACTION buckets:
   - SELL   (overvalued, broken thesis, cut exposure entirely)
   - TRIM   (overvalued vs targets, reduce weight)
   - HOLD   (fairly valued / on-thesis)
   - ADD    (attractive, increase weight)
   - BUY    (high conviction, initiate or materially add)

2) For each name provide: rating, 12-month price target, % upside / downside vs current
   price, and a one-line reason.

3) Produce:
   a. A Summary Ranking Table (markdown) with columns:
      | Ticker | Name | Rating | Current Price | 12M Target | Upside % | Action | One-line Reason |
   b. A Top Trim / Sell write-up section (what to reduce and why)
   c. A Top Add / Buy write-up section (what to increase and why)
   d. A Rebalancing Action Plan section with concrete moves
   e. A portfolio-level Key Catalysts Calendar (next 12 months)

Use ONLY the information you were given. Do not fabricate numbers. Keep the tone
institutional and decision-oriented. Output must be pure markdown, no preamble.
"""


def run_portfolio_summary(ticker_results: list[dict], *, generate_gamma: bool) -> dict:
    """Build the portfolio roll-up after all tickers have been analyzed."""
    usable = [r for r in ticker_results if r.get("ok")]
    if not usable:
        return {"ok": False, "error": "No successful per-stock analyses to summarize."}

    # Summarize each stock's report in ~800-1200 tokens to stay under context limits.
    per_stock_blobs = []
    for r in usable:
        s = r.get("summary", {}) or {}
        rep = r.get("report_text", "") or ""
        # Feed back Grok the Executive Summary + Verdict sections specifically.
        exec_part = _extract_section(rep, r"executive summary", max_chars=3000)
        verdict_part = _extract_section(rep, r"verdict", max_chars=3000)
        per_stock_blobs.append(
            f"### {r['ticker']} — {r.get('entity_name','')}\n"
            f"Rating (extracted): {s.get('rating') or 'N/A'}\n"
            f"12M Price Target (extracted): {s.get('price_target') or 'N/A'}\n"
            f"Current Price: {r.get('market_price')}\n\n"
            f"**Executive Summary excerpt:**\n{exec_part}\n\n"
            f"**Verdict excerpt:**\n{verdict_part}\n"
        )

    today = datetime.now().strftime("%Y-%m-%d")
    user_msg = (
        f"DATE: {today}\n"
        f"PORTFOLIO SIZE: {len(usable)} positions\n\n"
        + "\n\n".join(per_stock_blobs)
    )

    print("\n🧠 Portfolio summary: calling Grok for rebalancing analysis…")
    try:
        summary_md = call_grok(PORTFOLIO_SYSTEM_PROMPT, user_msg)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"Grok portfolio call: {exc}"}

    # Parse the ranking table so we can tell Gamma top buys vs sells.
    ranked_rows = _parse_action_table(summary_md)

    # Save markdown
    md_path = STOCKS_FOLDER / "Portfolio_Summary.md"
    md_path.write_text(summary_md)

    # Word
    out_docx = STOCKS_FOLDER / "Portfolio_Summary.docx"
    render_report(
        summary_md,
        ticker="PORTFOLIO",
        entity_name="Portfolio Review",
        output_path=str(out_docx),
    )
    print(f"💾 Portfolio Word summary: {out_docx}")

    # Gamma
    gamma_url = None
    gamma_credits = 0
    if generate_gamma:
        out_pptx = STOCKS_FOLDER / "Portfolio_Summary.pptx"
        gamma_url, gamma_credits = create_gamma_portfolio_summary(
            summary_md, ranked_rows, out_pptx=out_pptx
        )

    return {
        "ok": True,
        "docx": str(out_docx),
        "md": str(md_path),
        "summary_md": summary_md,
        "gamma_url": gamma_url,
        "gamma_credits": gamma_credits,
        "ranked_rows": ranked_rows,
    }


def _extract_section(markdown_text: str, keyword_regex: str,
                     max_chars: int = 2500) -> str:
    """Rough section extractor: finds a heading matching `keyword_regex` and takes
    text up to the next heading (or max_chars)."""
    lines = markdown_text.split("\n")
    out: list[str] = []
    capturing = False
    heading_re = re.compile(r"^#{1,3}\s+.*(" + keyword_regex + ")", re.IGNORECASE)
    next_heading_re = re.compile(r"^#{1,3}\s+")
    for ln in lines:
        if not capturing:
            if heading_re.search(ln):
                capturing = True
                out.append(ln)
            continue
        if next_heading_re.match(ln) and len("\n".join(out)) > 200:
            break
        out.append(ln)
        if len("\n".join(out)) > max_chars:
            break
    return "\n".join(out).strip() or "(section not found)"


def _parse_action_table(summary_md: str) -> list[dict]:
    """Parse the first markdown table we can find with columns including Ticker + Action."""
    lines = summary_md.split("\n")
    rows: list[dict] = []
    for i, line in enumerate(lines):
        if not line.strip().startswith("|"):
            continue
        if i + 1 >= len(lines):
            continue
        if "---" not in lines[i + 1]:
            continue
        header_cells = [c.strip() for c in line.strip().strip("|").split("|")]
        idx_lookup = {h.lower(): j for j, h in enumerate(header_cells)}
        j = i + 2
        while j < len(lines) and lines[j].strip().startswith("|"):
            cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
            d: dict = {}
            for key_name, canonical in [
                ("ticker", "ticker"),
                ("name", "name"),
                ("rating", "rating"),
                ("current price", "current_price"),
                ("12m target", "price_target"),
                ("target", "price_target"),
                ("upside %", "upside"),
                ("upside", "upside"),
                ("action", "action"),
                ("one-line reason", "reason"),
                ("reason", "reason"),
            ]:
                for h, jdx in idx_lookup.items():
                    if key_name in h and canonical not in d and jdx < len(cells):
                        d[canonical] = cells[jdx]
            if d.get("ticker"):
                rows.append(d)
            j += 1
        if rows:
            break
    return rows


# ============================================================================
# Portfolio file loader
# ============================================================================
def load_portfolio_file(path: str) -> list[dict]:
    """Load a portfolio file.

    Expected schema (new):
        | Ticker | Weight | Optimized |
        |--------|--------|-----------|
        | AAPL   | 0.05   |           |

    - The "Optimized" column is intentionally ignored so the same file can be
      re-used as input on the NEXT run, where the rebalancer will write a
      fresh Optimized column.
    - Weight can be expressed as a decimal (0.05) or a whole-number percent (5).
    - Falls back to legacy two-column (ticker, Allocation) and single-column
      files for backward compatibility.

    Returns a list of dicts: [{"ticker": "AAPL", "weight": 0.05}, ...]
    """
    p = Path(path).expanduser()
    if not p.exists():
        raise FileNotFoundError(path)
    if p.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(p)
    elif p.suffix.lower() in (".csv", ".tsv"):
        sep = "\t" if p.suffix.lower() == ".tsv" else ","
        df = pd.read_csv(p, sep=sep)
    else:
        raise ValueError(f"Unsupported portfolio file: {p.suffix}")

    cols_lower = {str(c).strip().lower(): c for c in df.columns}

    # Ticker column: accept Ticker / ticker / symbol / TICKER
    ticker_col = None
    for key in ("ticker", "tickers", "symbol", "symbols"):
        if key in cols_lower:
            ticker_col = cols_lower[key]
            break
    if ticker_col is None:
        ticker_col = df.columns[0]

    # Weight column: Weight / Allocation / Weight %
    weight_col = None
    for key in ("weight", "weights", "allocation", "alloc", "weight %", "weight (%)",
                "allocation %", "allocation (%)"):
        if key in cols_lower:
            weight_col = cols_lower[key]
            break

    # Optimized column is deliberately ignored (we will OVERWRITE it on the way out).
    records: list[dict] = []
    for _, row in df.iterrows():
        raw_t = row[ticker_col]
        if pd.isna(raw_t):
            continue
        ticker = str(raw_t).strip().upper()
        if not ticker or ticker in ("NAN", "NONE"):
            continue
        # Skip summary/footer rows that DGA-portfolio.xlsx writes at the bottom
        # (so the output file is safe to re-use as input).
        if ticker in ("TOTAL", "TOTALS", "SUBTOTAL", "CASH"):
            continue
        # Tickers are alphanumeric (dots/dashes allowed). Anything else is noise.
        if not all(c.isalnum() or c in (".", "-") for c in ticker):
            continue
        weight: float | None = None
        if weight_col is not None and pd.notna(row[weight_col]):
            try:
                weight = float(row[weight_col])
                # If it looks like a whole-number percent, convert to decimal.
                if weight > 1.5:
                    weight = weight / 100.0
            except (TypeError, ValueError):
                weight = None
        records.append({"ticker": ticker, "weight": weight})

    # If no weights were provided, assign equal-weight across all positions.
    if records and all(r["weight"] is None for r in records):
        n = len(records)
        for r in records:
            r["weight"] = round(1.0 / n, 6)

    return records


def portfolio_tickers(records: list[dict]) -> list[str]:
    return [r["ticker"] for r in records]


# ============================================================================
# Sector lookup (Yahoo Finance quoteSummary, best-effort)
# ============================================================================
_SECTOR_OVERRIDES = {
    # Fall-backs for tickers that Yahoo sometimes misses / labels oddly.
    "FNMA": "Financial Services",
    "IBRX": "Healthcare",
    "MOH":  "Healthcare",
    "HHH":  "Real Estate",
    "SPG":  "Real Estate",
    "ASML": "Technology",
    "TSM":  "Technology",
    "SMCI": "Technology",
    "INTC": "Technology",
    "CSCO": "Technology",
    "PYPL": "Financial Services",
    "C":    "Financial Services",
    "WFC":  "Financial Services",
    "NFLX": "Communication Services",
    "CMCSA": "Communication Services",
    "DIS":  "Communication Services",
    "T":    "Communication Services",
    "TSLA": "Consumer Cyclical",
    "HAL":  "Energy",
    "VALE": "Basic Materials",
}


def fetch_sector(ticker: str) -> str:
    """Best-effort sector lookup via Yahoo Finance. Falls back to overrides above."""
    t = ticker.strip().upper()
    if t in _SECTOR_OVERRIDES:
        return _SECTOR_OVERRIDES[t]
    try:
        url = (
            f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{t}"
            f"?modules=assetProfile,summaryProfile"
        )
        resp = requests.get(
            url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10,
        )
        data = resp.json()
        results = data.get("quoteSummary", {}).get("result", []) or []
        if results:
            profile = results[0].get("assetProfile") or results[0].get("summaryProfile") or {}
            s = profile.get("sector")
            if s:
                return s
    except Exception:
        pass
    return "Unknown"


# ============================================================================
# Rebalancer — 3 strategies
# ============================================================================
STRATEGIES = {
    "pro": {
        "label": "Pro Standard",
        "description": "10–20 positions, max 12% each, min 3% if held, max 25% per sector.",
        "min_names": 10,
        "target_names": 15,
        "max_names": 20,
        "max_position": 0.12,
        "min_position": 0.03,
        "max_sector": 0.25,
        "score_exponent": 1.4,
    },
    "concentrated": {
        "label": "Concentrated High Conviction",
        "description": "8–10 positions, max 20% each, min 5% if held, max 35% per sector.",
        "min_names": 8,
        "target_names": 9,
        "max_names": 10,
        "max_position": 0.20,
        "min_position": 0.05,
        "max_sector": 0.35,
        "score_exponent": 1.8,
    },
    "allin": {
        "label": "All In — Top 3",
        "description": "Only the 3 highest-conviction names, proportional to score up to 40% cap.",
        "min_names": 3,
        "target_names": 3,
        "max_names": 3,
        "max_position": 0.40,
        "min_position": 0.20,
        "max_sector": 1.00,  # effectively unconstrained
        "score_exponent": 2.0,
    },
}

_RATING_SCORE = {
    "strong buy": 5.0,
    "buy": 3.5,
    "hold": 1.0,
    "sell": -1.0,
    "strong sell": -3.0,
}


def _score_ticker(result: dict) -> dict:
    """Composite rebalance score for a single analyzed ticker."""
    s = result.get("summary") or {}
    rating = (s.get("rating") or "Hold").lower()
    rating_score = _RATING_SCORE.get(rating, 1.0)

    price = result.get("market_price")
    pt = s.get("price_target")

    # Prefer a pre-computed upside from the portfolio Grok roll-up if available.
    upside = s.get("upside_pct")
    if upside is None:
        if isinstance(price, (int, float)) and isinstance(pt, (int, float)) and price:
            upside = (pt - price) / price * 100.0
        else:
            upside = 0.0
    # Clip extreme outliers so one +500% fantasy target doesn't dominate.
    upside = max(-60.0, min(120.0, float(upside)))

    # Composite: rating dominates, upside fine-tunes the ranking within a rating.
    composite = rating_score + (upside / 10.0)
    return {
        "ticker": result["ticker"],
        "rating": rating.title(),
        "price": price,
        "price_target": pt,
        "upside_pct": round(upside, 2),
        "score": round(composite, 4),
        "sector": result.get("sector", "Unknown"),
        "action": s.get("action", ""),
    }


def _waterfall_cap(items: list[dict], key: str, cap: float) -> None:
    """Iteratively cap item[key] at `cap` and redistribute excess to uncapped items."""
    for _ in range(60):
        over = [i for i in items if i[key] > cap + 1e-9]
        if not over:
            return
        excess = sum(i[key] - cap for i in over)
        for i in over:
            i[key] = cap
        uncapped = [i for i in items if i[key] < cap - 1e-9]
        pool = sum(i[key] for i in uncapped)
        if pool <= 0:
            # Everyone is at the cap — renormalize and bail.
            total = sum(i[key] for i in items) or 1.0
            for i in items:
                i[key] /= total
            return
        for i in uncapped:
            i[key] += excess * (i[key] / pool)


def _apply_floor(items: list[dict], key: str, floor: float, cap: float) -> None:
    """Bump sub-floor items up to `floor`, take proportionally from items above floor."""
    for _ in range(30):
        below = [i for i in items if i[key] < floor - 1e-9]
        if not below:
            return
        deficit = sum(floor - i[key] for i in below)
        for i in below:
            i[key] = floor
        above = [i for i in items if i[key] > floor + 1e-9]
        pool = sum(i[key] for i in above)
        if pool <= 0:
            return
        for i in above:
            i[key] -= deficit * (i[key] / pool)
        _waterfall_cap(items, key, cap)


def _apply_sector_cap(items: list[dict], key: str, max_sector: float, max_pos: float) -> None:
    """Scale down any sector whose aggregate weight exceeds the cap, redistribute excess."""
    if max_sector >= 1.0:
        return
    for _ in range(10):
        sector_totals: dict[str, float] = {}
        for i in items:
            sector_totals[i["sector"]] = sector_totals.get(i["sector"], 0.0) + i[key]
        violators = [s for s, w in sector_totals.items() if w > max_sector + 1e-9]
        if not violators:
            return
        for sect in violators:
            sw = sector_totals[sect]
            scale = max_sector / sw
            excess = sw - max_sector
            # Scale down over-weight sector
            for i in items:
                if i["sector"] == sect:
                    i[key] *= scale
            # Distribute excess to names in other sectors, proportional to current weight.
            others = [i for i in items if i["sector"] != sect and i[key] > 0]
            pool = sum(i[key] for i in others)
            if pool <= 0:
                continue
            for i in others:
                i[key] += excess * (i[key] / pool)
        _waterfall_cap(items, key, max_pos)


def _merge_ranked_rows(
    ticker_results: list[dict], ranked_rows: list[dict] | None
) -> list[dict]:
    """Attach Grok-synthesized rating/target/upside/action to each ticker result.

    Any field already present on the ticker result is preserved; ranked_rows
    only fills in gaps.
    """
    if not ranked_rows:
        return ticker_results
    rr_by_tkr = {}
    for r in ranked_rows:
        tk = (r.get("ticker") or "").strip().upper()
        if tk:
            rr_by_tkr[tk] = r

    import re as _re
    pct_re = _re.compile(r"(-?\d+(?:\.\d+)?)")

    for tr in ticker_results:
        tk = tr["ticker"]
        rr = rr_by_tkr.get(tk)
        if not rr:
            continue
        s = tr.setdefault("summary", {}) or {}
        # Rating
        if rr.get("rating") and not s.get("rating"):
            s["rating"] = rr["rating"]
        # Price target
        pt_raw = rr.get("price_target")
        if pt_raw and not s.get("price_target"):
            m = pct_re.search(str(pt_raw).replace(",", ""))
            if m:
                try:
                    s["price_target"] = float(m.group(1))
                except ValueError:
                    pass
        # Current price (if Yahoo was unavailable)
        cp_raw = rr.get("current_price")
        if cp_raw and tr.get("market_price") in (None, 0):
            m = pct_re.search(str(cp_raw).replace(",", ""))
            if m:
                try:
                    tr["market_price"] = float(m.group(1))
                except ValueError:
                    pass
        # Upside
        up_raw = rr.get("upside")
        if up_raw:
            m = pct_re.search(str(up_raw).replace(",", ""))
            if m:
                try:
                    s["upside_pct"] = float(m.group(1))
                except ValueError:
                    pass
        # Action (SELL/TRIM/HOLD/ADD/BUY)
        action = (rr.get("action") or "").strip().upper()
        if action:
            s["action"] = action
            # If Grok says SELL/STRONG SELL, fold that into the rating.
            if "STRONG SELL" in action:
                s["rating"] = "Strong Sell"
            elif action == "SELL":
                s["rating"] = "Sell"
    return ticker_results


def compute_rebalance(
    ticker_results: list[dict],
    strategy: str = "pro",
    ranked_rows: list[dict] | None = None,
) -> dict:
    """Produce an optimized weight vector for the given strategy.

    If ``ranked_rows`` (from the portfolio Grok roll-up) is supplied, it is
    used to fill in rating / price / target / upside / action on each ticker
    result before scoring — that signal is strictly better than the quick
    regex scraped from the per-stock report.

    Returns a dict with:
      - strategy: key (e.g. "pro")
      - label / description
      - weights: {ticker: fraction_0_to_1}
      - rows: list of {ticker, score, rating, upside, sector, weight} (all tickers)
    """
    cfg = STRATEGIES.get(strategy) or STRATEGIES["pro"]
    usable = [r for r in ticker_results if r.get("ok")]

    # Hydrate sector for each ticker (cheap, cached if already set).
    for r in usable:
        if not r.get("sector"):
            r["sector"] = fetch_sector(r["ticker"])

    # Enrich with portfolio Grok roll-up if available.
    _merge_ranked_rows(usable, ranked_rows)

    scored = [_score_ticker(r) for r in usable]

    # Drop anything the analyst said SELL / Strong Sell — those are always 0%.
    eligible = [s for s in scored if s["rating"].lower() not in ("sell", "strong sell")]
    # Also drop anything with a non-positive composite score.
    eligible = [s for s in eligible if s["score"] > 0]

    if not eligible:
        return {
            "strategy": strategy,
            "label": cfg["label"],
            "description": cfg["description"],
            "weights": {s["ticker"]: 0.0 for s in scored},
            "rows": [dict(s, weight=0.0, in_portfolio=False) for s in scored],
        }

    # Rank and pick the target number of names.
    eligible.sort(key=lambda x: -x["score"])
    n_target = min(max(cfg["min_names"], cfg["target_names"]), cfg["max_names"], len(eligible))
    selected = [dict(s) for s in eligible[:n_target]]

    # Initial allocation proportional to score^exponent.
    exponent = cfg["score_exponent"]
    total = sum(max(s["score"], 0) ** exponent for s in selected) or 1.0
    for s in selected:
        s["weight"] = (max(s["score"], 0) ** exponent) / total

    # Enforce caps and floors.
    _waterfall_cap(selected, "weight", cfg["max_position"])
    _apply_floor(selected, "weight", cfg["min_position"], cfg["max_position"])
    _apply_sector_cap(selected, "weight", cfg["max_sector"], cfg["max_position"])

    # Final renormalize for rounding drift.
    total = sum(s["weight"] for s in selected) or 1.0
    for s in selected:
        s["weight"] = s["weight"] / total

    # Build final weights dict over ALL analyzed tickers (zero for dropped).
    selected_by_tkr = {s["ticker"]: s for s in selected}
    weights = {}
    rows = []
    for s in scored:
        sel = selected_by_tkr.get(s["ticker"])
        w = round(float(sel["weight"]), 4) if sel else 0.0
        weights[s["ticker"]] = w
        rows.append({**s, "weight": w, "in_portfolio": bool(sel)})

    # Small residual correction so weights sum to exactly 1.0.
    total_w = sum(weights.values())
    if total_w > 0 and abs(total_w - 1.0) > 1e-6:
        scale = 1.0 / total_w
        weights = {k: round(v * scale, 4) for k, v in weights.items()}
        for row in rows:
            row["weight"] = weights[row["ticker"]]

    return {
        "strategy": strategy,
        "label": cfg["label"],
        "description": cfg["description"],
        "weights": weights,
        "rows": rows,
    }


# ============================================================================
# DGA-portfolio.xlsx writer
# ============================================================================
DGA_PORTFOLIO_FILENAME = "DGA-portfolio.xlsx"


def write_dga_portfolio_xlsx(
    *,
    output_path: Path,
    input_records: list[dict],
    primary_strategy: str,
    strategy_results: dict[str, dict],
) -> Path:
    """Write the DGA-portfolio.xlsx output.

    Layout:
      Columns: Ticker | Weight | Optimized | <other strategy 1> | <other strategy 2>
      - "Weight" is the user's INPUT weight (what they held coming in).
      - "Optimized" is the PRIMARY strategy's new weights — this is the column
        the loader will IGNORE on the next input run, as required.
      - The remaining strategies appear as extra comparison columns so the user
        can see all three side by side.
      - A second sheet "Summary" lists per-ticker rating, price target, upside,
        sector, and the weight under each strategy for auditability.
      - A third sheet "Strategies" documents the constraint definitions.
    """
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    # Column order: primary first, then the other two in a stable order.
    other_order = [s for s in ("pro", "concentrated", "allin") if s != primary_strategy]
    order = [primary_strategy] + other_order

    # Build a ticker list starting with the input file order, then append any
    # extras (shouldn't happen normally, but covers edge cases).
    input_tickers = [r["ticker"] for r in input_records]
    input_weight_lookup = {r["ticker"]: r.get("weight", 0.0) or 0.0 for r in input_records}

    all_tickers_in_play = list(input_tickers)
    for key in order:
        for t in strategy_results[key]["weights"].keys():
            if t not in all_tickers_in_play:
                all_tickers_in_play.append(t)

    wb = openpyxl.Workbook()

    # -----------------------------------------------------------------------
    # Sheet 1: Portfolio (the thing the user cares about)
    # -----------------------------------------------------------------------
    ws = wb.active
    ws.title = "Portfolio"

    # Styling
    navy_fill = PatternFill("solid", fgColor="0A1628")
    gold_fill = PatternFill("solid", fgColor="C9A84C")
    header_font = Font(name="Calibri", size=12, bold=True, color="FFFFFF")
    primary_header_font = Font(name="Calibri", size=12, bold=True, color="0A1628")
    cell_font = Font(name="Calibri", size=11)
    bold_font = Font(name="Calibri", size=11, bold=True)
    thin = Side(border_style="thin", color="3D4A5C")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    # Headers
    primary_label = strategy_results[primary_strategy]["label"]
    headers = ["Ticker", "Weight", "Optimized"]
    for key in other_order:
        headers.append(strategy_results[key]["label"])

    for col_idx, name in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=name)
        cell.font = primary_header_font if col_idx == 3 else header_font
        cell.fill = gold_fill if col_idx == 3 else navy_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border

    # Subheader row showing what strategy each column represents.
    sub_cell = ws.cell(row=2, column=1, value="")
    sub_cell.font = cell_font
    sub_cell.alignment = Alignment(horizontal="center")
    ws.cell(row=2, column=2, value="Previous (input)").font = Font(
        name="Calibri", size=9, italic=True, color="3D4A5C"
    )
    ws.cell(row=2, column=2).alignment = Alignment(horizontal="center")
    ws.cell(row=2, column=3, value=f"[{primary_label}]").font = Font(
        name="Calibri", size=9, italic=True, color="0A1628", bold=True
    )
    ws.cell(row=2, column=3).alignment = Alignment(horizontal="center")
    for i, key in enumerate(other_order, start=4):
        c = ws.cell(row=2, column=i, value=f"[{strategy_results[key]['label']}]")
        c.font = Font(name="Calibri", size=9, italic=True, color="3D4A5C")
        c.alignment = Alignment(horizontal="center")

    # Data rows
    for r_idx, ticker in enumerate(all_tickers_in_play, start=3):
        row_values = [ticker, input_weight_lookup.get(ticker, 0.0)]
        row_values.append(strategy_results[primary_strategy]["weights"].get(ticker, 0.0))
        for key in other_order:
            row_values.append(strategy_results[key]["weights"].get(ticker, 0.0))
        for c_idx, v in enumerate(row_values, start=1):
            cell = ws.cell(row=r_idx, column=c_idx, value=v)
            cell.font = bold_font if c_idx == 1 else cell_font
            if c_idx >= 2:
                cell.number_format = "0.00%"
                cell.alignment = Alignment(horizontal="right")
            else:
                cell.alignment = Alignment(horizontal="center")
            cell.border = border

    # Totals row
    last_row = 3 + len(all_tickers_in_play)
    total_cell = ws.cell(row=last_row, column=1, value="TOTAL")
    total_cell.font = bold_font
    total_cell.alignment = Alignment(horizontal="center")
    total_cell.border = border
    for col_idx in range(2, len(headers) + 1):
        col_letter = get_column_letter(col_idx)
        cell = ws.cell(
            row=last_row,
            column=col_idx,
            value=f"=SUM({col_letter}3:{col_letter}{last_row-1})",
        )
        cell.font = bold_font
        cell.number_format = "0.00%"
        cell.alignment = Alignment(horizontal="right")
        cell.fill = PatternFill("solid", fgColor="F5F7FA")
        cell.border = border

    # Column widths
    ws.column_dimensions["A"].width = 12
    for c_idx in range(2, len(headers) + 1):
        ws.column_dimensions[get_column_letter(c_idx)].width = max(18, len(headers[c_idx-1]) + 6)
    ws.row_dimensions[1].height = 22
    ws.freeze_panes = "A3"

    # -----------------------------------------------------------------------
    # Sheet 2: Summary / Audit
    # -----------------------------------------------------------------------
    ws2 = wb.create_sheet("Summary")
    summary_headers = [
        "Ticker", "Rating", "Current Price", "12M Target", "Upside %", "Sector",
        f"{strategy_results[primary_strategy]['label']} (Primary)",
    ]
    for key in other_order:
        summary_headers.append(strategy_results[key]["label"])
    for col_idx, name in enumerate(summary_headers, start=1):
        c = ws2.cell(row=1, column=col_idx, value=name)
        c.font = header_font
        c.fill = navy_fill
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = border

    # Build a lookup of per-ticker row data from the primary strategy (it has all
    # metadata since every ticker is in `rows`).
    primary_rows_by_tkr = {row["ticker"]: row for row in strategy_results[primary_strategy]["rows"]}
    for r_idx, ticker in enumerate(all_tickers_in_play, start=2):
        meta = primary_rows_by_tkr.get(ticker, {})
        vals = [
            ticker,
            meta.get("rating", "—"),
            meta.get("price"),
            meta.get("price_target"),
            meta.get("upside_pct"),
            meta.get("sector", "Unknown"),
            strategy_results[primary_strategy]["weights"].get(ticker, 0.0),
        ]
        for key in other_order:
            vals.append(strategy_results[key]["weights"].get(ticker, 0.0))
        for c_idx, v in enumerate(vals, start=1):
            cell = ws2.cell(row=r_idx, column=c_idx, value=v)
            cell.font = cell_font
            cell.border = border
            if c_idx == 1:
                cell.font = bold_font
                cell.alignment = Alignment(horizontal="center")
            elif c_idx in (3, 4):  # prices
                cell.number_format = "$#,##0.00"
                cell.alignment = Alignment(horizontal="right")
            elif c_idx == 5:
                cell.number_format = "0.00"
                cell.alignment = Alignment(horizontal="right")
            elif c_idx >= 7:
                cell.number_format = "0.00%"
                cell.alignment = Alignment(horizontal="right")
            else:
                cell.alignment = Alignment(horizontal="left")

    for c_idx, name in enumerate(summary_headers, start=1):
        ws2.column_dimensions[get_column_letter(c_idx)].width = max(14, len(name) + 4)
    ws2.freeze_panes = "B2"

    # -----------------------------------------------------------------------
    # Sheet 3: Strategy definitions
    # -----------------------------------------------------------------------
    ws3 = wb.create_sheet("Strategies")
    cfg_headers = [
        "Strategy", "Label", "Min names", "Target", "Max names",
        "Max per position", "Min per position", "Max per sector", "Description",
    ]
    for col_idx, name in enumerate(cfg_headers, start=1):
        c = ws3.cell(row=1, column=col_idx, value=name)
        c.font = header_font
        c.fill = navy_fill
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = border
    for r_idx, skey in enumerate(order, start=2):
        cfg = STRATEGIES[skey]
        tag = " (PRIMARY)" if skey == primary_strategy else ""
        vals = [
            skey + tag,
            cfg["label"],
            cfg["min_names"],
            cfg["target_names"],
            cfg["max_names"],
            cfg["max_position"],
            cfg["min_position"],
            cfg["max_sector"],
            cfg["description"],
        ]
        for c_idx, v in enumerate(vals, start=1):
            cell = ws3.cell(row=r_idx, column=c_idx, value=v)
            cell.font = bold_font if skey == primary_strategy else cell_font
            cell.border = border
            if c_idx in (6, 7, 8):
                cell.number_format = "0.00%"
    for c_idx, name in enumerate(cfg_headers, start=1):
        ws3.column_dimensions[get_column_letter(c_idx)].width = max(14, len(name) + 4)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    return output_path


# ============================================================================
# Google Drive upload (uses MCP-connected Drive from the cowork session).
# The actual MCP call is performed from the outer agent — this helper just
# builds the payload path and metadata.
# ============================================================================
def _gsheets_upsert_sheet(sh, title: str, rows: list[list]) -> None:
    """Clear and rewrite a worksheet, creating it if it doesn't exist."""
    import gspread
    try:
        ws = sh.worksheet(title)
        ws.clear()
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=title, rows=max(len(rows) + 20, 50), cols=30)
    if rows:
        ws.update(rows)


def _gsheets_append_log(sh, title: str, headers: list, row: list) -> None:
    """Append a row to a log sheet, creating with headers if it doesn't exist."""
    import gspread
    try:
        ws = sh.worksheet(title)
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=title, rows=200, cols=10)
        ws.append_row(headers)
    ws.append_row(row)


def push_to_google_sheets(
    *,
    input_records: list[dict],
    primary_strategy: str,
    strategy_results: dict[str, dict],
    run_timestamp: str,
) -> dict:
    """Push portfolio results to Google Sheets via a service account.

    Required env vars:
      GOOGLE_SERVICE_ACCOUNT_JSON  — path to the service account key JSON file
      GOOGLE_SHEETS_SPREADSHEET_ID — ID from the spreadsheet URL

    Creates / updates three sheets: Portfolio, Summary, Run Log.
    Returns {"ok": True, "url": "..."} or {"ok": False, "error": "..."}.
    """
    creds_path = _optional_env("GOOGLE_SERVICE_ACCOUNT_JSON")
    spreadsheet_id = _optional_env("GOOGLE_SHEETS_SPREADSHEET_ID")

    if not creds_path or not spreadsheet_id:
        return {
            "ok": False,
            "skipped": True,
            "error": "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEETS_SPREADSHEET_ID not configured",
        }

    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        return {"ok": False, "error": "gspread not installed; run: pip install gspread google-auth"}

    try:
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = Credentials.from_service_account_file(creds_path, scopes=scopes)
        gc = gspread.authorize(creds)
        sh = gc.open_by_key(spreadsheet_id)
    except Exception as exc:
        return {"ok": False, "error": f"Auth/open failed: {exc}"}

    try:
        other_order = [s for s in ("pro", "concentrated", "allin") if s != primary_strategy]
        order = [primary_strategy] + other_order

        input_tickers = [r["ticker"] for r in input_records]
        input_weight_lookup = {r["ticker"]: r.get("weight", 0.0) or 0.0 for r in input_records}

        all_tickers: list[str] = list(input_tickers)
        for key in order:
            for t in strategy_results[key]["weights"]:
                if t not in all_tickers:
                    all_tickers.append(t)

        primary_label = strategy_results[primary_strategy]["label"]

        # ---- Sheet: Portfolio ----
        port_headers = ["Ticker", "Weight (Prior)", f"Optimized [{primary_label}]"]
        for key in other_order:
            port_headers.append(strategy_results[key]["label"])

        port_rows: list[list] = [port_headers]
        for ticker in all_tickers:
            row: list = [
                ticker,
                round(input_weight_lookup.get(ticker, 0.0), 4),
                round(strategy_results[primary_strategy]["weights"].get(ticker, 0.0), 4),
            ]
            for key in other_order:
                row.append(round(strategy_results[key]["weights"].get(ticker, 0.0), 4))
            port_rows.append(row)

        total_row: list = ["TOTAL", round(sum(input_weight_lookup.values()), 4)]
        total_row.append(round(sum(strategy_results[primary_strategy]["weights"].get(t, 0.0) for t in all_tickers), 4))
        for key in other_order:
            total_row.append(round(sum(strategy_results[key]["weights"].get(t, 0.0) for t in all_tickers), 4))
        port_rows.append(total_row)

        _gsheets_upsert_sheet(sh, "Portfolio", port_rows)

        # ---- Sheet: Summary ----
        sum_headers = [
            "Ticker", "Rating", "Current Price", "12M Target", "Upside %", "Sector",
            f"{primary_label} (Primary)",
        ]
        for key in other_order:
            sum_headers.append(strategy_results[key]["label"])

        primary_rows_by_tkr = {
            r["ticker"]: r for r in strategy_results[primary_strategy]["rows"]
        }
        sum_rows: list[list] = [sum_headers]
        for ticker in all_tickers:
            meta = primary_rows_by_tkr.get(ticker, {})
            srow: list = [
                ticker,
                meta.get("rating", "—"),
                meta.get("price"),
                meta.get("price_target"),
                meta.get("upside_pct"),
                meta.get("sector", "Unknown"),
                round(strategy_results[primary_strategy]["weights"].get(ticker, 0.0), 4),
            ]
            for key in other_order:
                srow.append(round(strategy_results[key]["weights"].get(ticker, 0.0), 4))
            sum_rows.append(srow)

        _gsheets_upsert_sheet(sh, "Summary", sum_rows)

        # ---- Sheet: Run Log (append-only audit trail) ----
        log_headers = ["Timestamp", "Tickers", "Strategy", "Top Picks", "# Positions"]
        top_picks = sorted(
            strategy_results[primary_strategy]["weights"].items(), key=lambda x: -x[1]
        )[:3]
        log_row = [
            run_timestamp,
            ", ".join(all_tickers),
            primary_label,
            ", ".join(f"{t} {w:.1%}" for t, w in top_picks),
            sum(1 for v in strategy_results[primary_strategy]["weights"].values() if v > 0),
        ]
        _gsheets_append_log(sh, "Run Log", log_headers, log_row)

        url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
        return {"ok": True, "url": url}

    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ============================================================================
# High-level orchestration (used by CLI *and* API)
# ============================================================================
def run_portfolio_rebalance(
    portfolio_records: list[dict],
    *,
    primary_strategy: str = "pro",
    generate_gamma: bool = False,
    reuse_existing: bool = True,
    output_path: Path | str | None = None,
    system_prompt: str | None = None,
    verbose: bool = False,
) -> dict:
    """Analyze every ticker in *portfolio_records* and produce DGA-portfolio.xlsx.

    Returns a dict with:
      - ok: bool
      - tickers_ok / tickers_failed
      - strategy_results: { strategy_key: { weights, held, strategy, ... } }
      - xlsx_path: str path to the generated xlsx
      - primary_strategy: key of the primary strategy shown first
      - summary: short roll-up for API responses
    """
    if primary_strategy not in STRATEGIES:
        raise ValueError(f"Unknown strategy: {primary_strategy}")

    if system_prompt is None:
        system_prompt = load_system_prompt()

    tickers = portfolio_tickers(portfolio_records)
    ticker_results: list[dict] = []
    for ticker in tickers:
        try:
            r = analyze_ticker(
                ticker,
                system_prompt=system_prompt,
                generate_gamma=generate_gamma,
                verbose=verbose,
                reuse_existing=reuse_existing,
            )
        except Exception as exc:  # noqa: BLE001
            r = {"ticker": ticker, "ok": False, "error": str(exc)}
        ticker_results.append(r)

    ok_results = [r for r in ticker_results if r.get("ok")]
    failed = [r for r in ticker_results if not r.get("ok")]

    # Run the Grok roll-up (best-effort — gives us ranked rows if reachable).
    ranked_rows = None
    roll = {"ok": False}
    if len(ok_results) > 1:
        try:
            roll = run_portfolio_summary(ok_results, generate_gamma=generate_gamma)
            if roll.get("ok"):
                ranked_rows = roll.get("ranked_rows")
        except Exception:  # noqa: BLE001
            roll = {"ok": False}

    # Always compute ALL three strategies so the xlsx shows comparisons.
    strategy_results: dict[str, dict] = {}
    for skey in STRATEGIES:
        strategy_results[skey] = compute_rebalance(
            ok_results, strategy=skey, ranked_rows=ranked_rows,
        )

    # Choose where to write the xlsx.
    if output_path is None:
        output_path = Path.cwd() / DGA_PORTFOLIO_FILENAME
    else:
        output_path = Path(output_path)

    write_dga_portfolio_xlsx(
        output_path=output_path,
        input_records=portfolio_records,
        primary_strategy=primary_strategy,
        strategy_results=strategy_results,
    )

    # Build a lightweight JSON-safe summary for the API.
    def _slim(res: dict) -> dict:
        w = res.get("weights", {})
        return {
            "strategy": res.get("strategy"),
            "label": res.get("label"),
            "held": sum(1 for v in w.values() if v > 0),
            "weights": {k: round(v, 4) for k, v in w.items() if v > 0},
        }

    run_ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    # Email portfolio results — only fires for multi-ticker (portfolio) runs.
    email_status: dict = {"ok": False, "skipped": True}
    if len(ok_results) > 1:
        try:
            email_msg = build_portfolio_email(
                tickers_ok=[r["ticker"] for r in ok_results],
                tickers_failed=[r["ticker"] for r in failed],
                summary_markdown=(roll.get("summary_md") if roll.get("ok") else "") or "",
                ranked_rows=ranked_rows,
                strategy_results=strategy_results,
                output_xlsx=output_path,
                portfolio_docx=Path(roll["docx"]) if roll.get("ok") and roll.get("docx") else None,
                gamma_url=roll.get("gamma_url") if roll.get("ok") else None,
            )
            email_status = send_portfolio_email(email_msg)
        except Exception as exc:  # noqa: BLE001
            email_status = {"ok": False, "error": str(exc)}

    # Google Sheets push — only fires for multi-ticker runs.
    gsheets_status: dict = {"ok": False, "skipped": True}
    if len(ok_results) > 1:
        try:
            gsheets_status = push_to_google_sheets(
                input_records=portfolio_records,
                primary_strategy=primary_strategy,
                strategy_results=strategy_results,
                run_timestamp=run_ts,
            )
        except Exception as exc:  # noqa: BLE001
            gsheets_status = {"ok": False, "error": str(exc)}

    return {
        "ok": bool(ok_results),
        "primary_strategy": primary_strategy,
        "tickers_ok": [r["ticker"] for r in ok_results],
        "tickers_failed": [{"ticker": r["ticker"], "error": r.get("error")}
                            for r in failed],
        "xlsx_path": str(output_path),
        "portfolio_roll_up_ok": bool(roll.get("ok")),
        "strategies": {k: _slim(v) for k, v in strategy_results.items()},
        "email": email_status,
        "gsheets": gsheets_status,
    }


# ============================================================================
# CLI
# ============================================================================
def _prompt_yes_no(prompt: str, default: bool = False) -> bool:
    default_str = "Y/n" if default else "y/N"
    resp = input(f"{prompt} [{default_str}]: ").strip().lower()
    if not resp:
        return default
    return resp in ("y", "yes")


def main() -> int:
    ap = argparse.ArgumentParser(description="DGA Capital Research — Claude Edition")
    ap.add_argument("ticker", nargs="?", help="Single ticker (e.g. AAPL)")
    ap.add_argument("--portfolio", help="Path to a CSV or XLSX portfolio file "
                                        "(columns: Ticker | Weight | Optimized)")
    ap.add_argument("--gamma", action="store_true", help="Force Gamma deck generation")
    ap.add_argument("--no-gamma", action="store_true", help="Skip Gamma deck generation")
    ap.add_argument("--strategy", choices=list(STRATEGIES.keys()), default="pro",
                    help="Primary rebalance strategy (default: pro)")
    ap.add_argument("--reuse", action="store_true",
                    help="Reuse cached markdown reports from /stocks where present")
    ap.add_argument("--out",
                    help=f"Output xlsx path (defaults to ./{DGA_PORTFOLIO_FILENAME})")
    args = ap.parse_args()

    print("╔══════════════════════════════════════════════════╗")
    print("║  DGA CAPITAL RESEARCH ANALYST — Claude Edition  ║")
    print("╚══════════════════════════════════════════════════╝")

    # Resolve input: CLI takes precedence; else prompt.
    portfolio_records: list[dict] = []
    single_ticker_mode = False
    if args.portfolio:
        portfolio_records = load_portfolio_file(args.portfolio)
    elif args.ticker:
        portfolio_records = [{"ticker": args.ticker.strip().upper(), "weight": None}]
        single_ticker_mode = True
    else:
        print("\nChoose input mode:")
        print("  1) Single ticker")
        print("  2) Portfolio CSV or XLSX (Ticker | Weight | Optimized)")
        mode = input("Select 1 or 2 (or paste a ticker directly): ").strip()
        if mode == "1":
            t = input("Enter ticker (e.g. AAPL): ").strip().upper()
            if t:
                portfolio_records = [{"ticker": t, "weight": None}]
                single_ticker_mode = True
        elif mode == "2":
            pf = input("Path to portfolio file (.csv or .xlsx): ").strip()
            try:
                portfolio_records = load_portfolio_file(pf)
            except Exception as exc:  # noqa: BLE001
                print(f"❌ Could not load portfolio: {exc}")
                return 2
        else:
            if mode:
                portfolio_records = [{"ticker": mode.upper(), "weight": None}]
                single_ticker_mode = True

    if not portfolio_records:
        print("❌ No tickers to analyze.")
        return 2

    tickers = portfolio_tickers(portfolio_records)

    # Gamma decision
    if args.gamma:
        generate_gamma = True
    elif args.no_gamma:
        generate_gamma = False
    else:
        generate_gamma = _prompt_yes_no(
            "Generate Gamma.app presentations as well? (uses Gamma credits)",
            default=False,
        )

    system_prompt = load_system_prompt()

    print(f"\n📋 Tickers to analyze ({len(tickers)}): {', '.join(tickers)}")
    print(f"📁 Output folder: {STOCKS_FOLDER}")
    print(f"🎨 Gamma generation: {'ON' if generate_gamma else 'OFF'}")
    if not single_ticker_mode:
        print(f"⚖️  Primary rebalance strategy: {STRATEGIES[args.strategy]['label']}")
        print(f"♻️  Reuse cached reports: {'ON' if args.reuse else 'OFF'}")

    results: list[dict] = []
    for ticker in tickers:
        try:
            res = analyze_ticker(
                ticker,
                system_prompt=system_prompt,
                generate_gamma=generate_gamma,
                verbose=False,
                reuse_existing=args.reuse,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"❌ {ticker} failed: {exc}")
            res = {"ticker": ticker, "ok": False, "error": str(exc)}
        results.append(res)

    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]

    print("\n==============================================")
    print(f"  SUMMARY: {len(ok)} succeeded, {len(fail)} failed")
    print("==============================================")
    for r in ok:
        tag = " [cached]" if r.get("cached") else ""
        print(f"  ✅ {r['ticker']}{tag}  →  {r.get('docx','')}")
        if r.get("gamma_url"):
            print(f"       📽️   {r['gamma_url']}")
    for r in fail:
        print(f"  ❌ {r['ticker']}  {r.get('error','')}")

    # Portfolio flow (only if we have more than 1 ticker OR a portfolio file).
    if len(ok) > 1 and not single_ticker_mode:
        print("\n==============================================")
        print("  PORTFOLIO ROLL-UP + REBALANCE")
        print("==============================================")
        roll = run_portfolio_summary(ok, generate_gamma=generate_gamma)
        ranked_rows = None
        if roll.get("ok"):
            print(f"  ✅ Portfolio Word: {roll['docx']}")
            if roll.get("gamma_url"):
                print(f"  📽️   {roll['gamma_url']}")
            ranked_rows = roll.get("ranked_rows")
        else:
            print(f"  ⚠️  Portfolio roll-up failed: {roll.get('error')}")

        # Compute all three strategies, using the Grok roll-up's ranked table
        # (rating + upside) to enrich the scoring signal when available.
        strategy_results: dict[str, dict] = {}
        for skey in STRATEGIES:
            strategy_results[skey] = compute_rebalance(
                ok, strategy=skey, ranked_rows=ranked_rows,
            )
            held = sum(1 for w in strategy_results[skey]["weights"].values() if w > 0)
            print(f"  📊 {STRATEGIES[skey]['label']}: {held} positions")

        # Write the xlsx.
        out_path = Path(args.out) if args.out else (SCRIPT_DIR.parent / DGA_PORTFOLIO_FILENAME)
        # If user didn't override --out, default to the working directory the
        # script was launched from (so it lands next to the portfolio file).
        if not args.out:
            out_path = Path.cwd() / DGA_PORTFOLIO_FILENAME

        write_dga_portfolio_xlsx(
            output_path=out_path,
            input_records=portfolio_records,
            primary_strategy=args.strategy,
            strategy_results=strategy_results,
        )
        print(f"  💾 Optimized portfolio: {out_path}")

        # Surface the instructions blob so an orchestrator (or the cowork
        # agent) can push the file to Google Sheets via the Drive MCP.
        instr = google_sheets_upload_instructions(out_path)
        print(f"  ☁️  Google Sheets upload payload: {instr}")

        # Email the results — portfolio runs only (single-ticker analyses
        # never email; that branch never reaches here).
        try:
            email_msg = build_portfolio_email(
                tickers_ok=[r["ticker"] for r in ok],
                tickers_failed=[r["ticker"] for r in fail],
                summary_markdown=(roll.get("summary_md") if roll.get("ok") else "") or "",
                ranked_rows=ranked_rows,
                strategy_results=strategy_results,
                output_xlsx=out_path,
                portfolio_docx=Path(roll["docx"]) if roll.get("ok") and roll.get("docx") else None,
                gamma_url=roll.get("gamma_url") if roll.get("ok") else None,
            )
            email_res = send_portfolio_email(email_msg)
            if email_res.get("ok"):
                print(f"  📧 Emailed portfolio results to {email_res['sent_to']}")
            else:
                print(f"  📧 Email pending — {email_res.get('error', 'unknown error')}")
        except Exception as exc:
            print(f"  ⚠️  Could not send portfolio email: {exc}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
