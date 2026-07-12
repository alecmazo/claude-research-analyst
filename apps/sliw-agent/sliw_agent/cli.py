#!/usr/bin/env python3
"""
Sliw Agent CLI — corporate representation desk for Edyta Śliwińska.

Examples:
  python -m sliw_agent.cli bible
  python -m sliw_agent.cli seed
  python -m sliw_agent.cli pipeline --company "Stripe" --industry "fintech" --geo "San Francisco" --employees "8000" --signals "holiday party,engineering culture"
  python -m sliw_agent.cli pipeline --company "Genentech" --gamma
  python -m sliw_agent.cli pipeline --company "Genentech" --gamma --live   # burns Gamma credits
  python -m sliw_agent.cli list
  python -m sliw_agent.cli show <prospect_id>
  python -m sliw_agent.cli interested --id <prospect_id> --reply "Love this — can we talk next week?"
  python -m sliw_agent.cli leads
  python -m sliw_agent.cli summary
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow `python -m sliw_agent.cli` from apps/sliw-agent
_APP_ROOT = Path(__file__).resolve().parent.parent
if str(_APP_ROOT) not in sys.path:
    sys.path.insert(0, str(_APP_ROOT))

from sliw_agent import crm  # noqa: E402
from sliw_agent.pipeline import batch_score_seed, mark_interested, run_prospect_pipeline  # noqa: E402
from sliw_agent.talent_bible import AGENT_MANDATE, package_catalog_markdown, talent_brief_markdown  # noqa: E402


def cmd_bible(_: argparse.Namespace) -> int:
    print(talent_brief_markdown())
    print("\n--- AGENT MANDATE ---\n")
    print(AGENT_MANDATE)
    return 0


def cmd_packages(_: argparse.Namespace) -> int:
    print(package_catalog_markdown())
    return 0


def cmd_seed(_: argparse.Namespace) -> int:
    results = batch_score_seed()
    print(f"Seeded/scored {len(results)} prospects:\n")
    for r in results:
        s = r["score"]
        print(
            f"  [{s['tier']}] {s['score']:3d}  {r['company']:<28}  "
            f"→ {(s.get('primary_package') or {}).get('name', '—')}"
        )
    print("\nCRM:", crm.CRM_PATH)
    print(json.dumps(crm.pipeline_summary(), indent=2))
    return 0


def cmd_pipeline(args: argparse.Namespace) -> int:
    signals = [s.strip() for s in (args.signals or "").split(",") if s.strip()]
    contacts = []
    if args.contact_name or args.contact_email:
        contacts.append({
            "name": args.contact_name or "",
            "title": args.contact_title or "",
            "email": args.contact_email or "",
            "linkedin": args.contact_linkedin or "",
        })

    result = run_prospect_pipeline(
        company=args.company,
        industry=args.industry or "",
        geo=args.geo or "",
        employee_range=args.employees or "",
        website=args.website or "",
        notes=args.notes or "",
        signals=signals,
        contacts=contacts,
        custom_hook=args.hook or "",
        generate_gamma=bool(args.gamma),
        dry_run_gamma=not bool(args.live),
        draft_email=not bool(args.no_email),
    )

    print("\n══ SLIW AGENT PIPELINE RESULT ══\n")
    print(f"Prospect ID : {result['prospect_id']}")
    print(f"Company     : {result['company']}")
    sc = result["score"]
    print(f"Score       : {sc['score']} (tier {sc['tier']})")
    print(f"Breakdown   : {sc['breakdown']}")
    print(f"Agent note  : {sc['agent_note']}")
    print(f"Packages    :")
    for p in sc.get("recommended_packages") or []:
        print(f"   • {p['name']} ({p['id']}) — match {p['match_score']}")
    print(f"Target titles: {', '.join(sc.get('target_titles') or [])}")

    if result.get("skipped"):
        print(f"\nSkipped: {result['skipped']}")
    if result.get("gamma"):
        g = result["gamma"]
        print(f"\nGamma dry_run : {g.get('dry_run')}")
        print(f"Gamma URL     : {g.get('gamma_url')}")
        print(f"Prompt path   : {g.get('prompt_path')}")
        print(f"PPTX path     : {g.get('pptx_path')}")
    if result.get("outreach_path"):
        print(f"\nOutreach draft: {result['outreach_path']}")
        print("  ⚠️  DRAFT ONLY — human approval required before send.")

    print("\nNext: review draft → approve → send → when they reply, run:")
    print(f"  python -m sliw_agent.cli interested --id {result['prospect_id']} --reply \"...\"")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    rows = crm.list_prospects(stage=args.stage, min_score=args.min_score)
    if not rows:
        print("No prospects. Run: python -m sliw_agent.cli seed")
        return 0
    print(f"{'ID':<40} {'Tier':<4} {'Score':>5}  {'Stage':<16} Company")
    print("-" * 100)
    for p in rows:
        print(
            f"{p['id']:<40} {p.get('tier') or '—':<4} {p.get('score') or 0:5}  "
            f"{p.get('stage', ''):<16} {p.get('company')}"
        )
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    p = crm.get_prospect(args.id)
    if not p:
        print(f"Not found: {args.id}")
        return 1
    print(json.dumps(p, indent=2, ensure_ascii=False))
    return 0


def cmd_interested(args: argparse.Namespace) -> int:
    out = mark_interested(
        args.id,
        reply_text=args.reply or "",
        reply_summary=args.summary or "",
    )
    print(json.dumps(out["qualification"], indent=2))
    if out.get("edyta_brief_path"):
        print(f"\n✅ Edyta brief ready: {out['edyta_brief_path']}")
        print("Hand this to Edyta before the discovery call.")
    else:
        print(f"\nStage → {out['qualification']['recommended_stage']}")
        print(out["qualification"]["agent_action"])
    return 0


def cmd_leads(_: argparse.Namespace) -> int:
    leads = crm.interested_leads()
    if not leads:
        print("No interested leads yet.")
        return 0
    print("══ LEADS FOR EDYTA ══\n")
    for p in leads:
        print(f"• {p['company']}  [{p.get('stage')}]  score={p.get('score')}")
        print(f"  id: {p['id']}")
        if p.get("edyta_brief_path"):
            print(f"  brief: {p['edyta_brief_path']}")
        if p.get("gamma_url"):
            print(f"  deck: {p['gamma_url']}")
        print()
    return 0


def cmd_summary(_: argparse.Namespace) -> int:
    print("Pipeline summary:")
    print(json.dumps(crm.pipeline_summary(), indent=2))
    print(f"\nCRM file: {crm.CRM_PATH}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sliw-agent",
        description="Sliw Agent — Hollywood-style corporate sales desk for Edyta Śliwińska",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("bible", help="Print talent bible + agent mandate").set_defaults(func=cmd_bible)
    sub.add_parser("packages", help="Print package catalog").set_defaults(func=cmd_packages)
    sub.add_parser("seed", help="Load seed prospects and score them").set_defaults(func=cmd_seed)
    sub.add_parser("summary", help="Pipeline stage counts").set_defaults(func=cmd_summary)
    sub.add_parser("leads", help="List leads ready for Edyta").set_defaults(func=cmd_leads)

    lp = sub.add_parser("list", help="List CRM prospects")
    lp.add_argument("--stage", default=None)
    lp.add_argument("--min-score", type=float, default=None)
    lp.set_defaults(func=cmd_list)

    sp = sub.add_parser("show", help="Show one prospect JSON")
    sp.add_argument("id")
    sp.set_defaults(func=cmd_show)

    pp = sub.add_parser("pipeline", help="Score + package + draft for one company")
    pp.add_argument("--company", required=True)
    pp.add_argument("--industry", default="")
    pp.add_argument("--geo", default="")
    pp.add_argument("--employees", default="")
    pp.add_argument("--website", default="")
    pp.add_argument("--notes", default="")
    pp.add_argument("--signals", default="", help="Comma-separated trigger signals")
    pp.add_argument("--hook", default="", help="Custom personalization hook")
    pp.add_argument("--contact-name", default="")
    pp.add_argument("--contact-title", default="")
    pp.add_argument("--contact-email", default="")
    pp.add_argument("--contact-linkedin", default="")
    pp.add_argument("--gamma", action="store_true", help="Build Gamma prompt (dry-run unless --live)")
    pp.add_argument("--live", action="store_true", help="Actually call Gamma API (uses credits)")
    pp.add_argument("--no-email", action="store_true", help="Skip outreach draft")
    pp.set_defaults(func=cmd_pipeline)

    ip = sub.add_parser("interested", help="Qualify a reply and prepare Edyta brief")
    ip.add_argument("--id", required=True, help="Prospect ID")
    ip.add_argument("--reply", default="", help="Raw reply text")
    ip.add_argument("--summary", default="", help="Optional summary")
    ip.set_defaults(func=cmd_interested)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
