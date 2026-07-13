# LLM Coordination — DGA Capital monorepo

**Purpose:** Keep Grok, Fable, Claude/Opus, and any other agents working **in concert**, not on top of each other.  
**Owner of this file:** whoever last edited the **Active claims** section (update when you start or finish work).

---

## Sync snapshot (2026-07-13)

| Item | Value |
|------|--------|
| Repo | `https://github.com/alecmazo/claude-research-analyst` |
| Default branch | `main` |
| Last coordination note | 2026-07-13 — Grok high-ROI UX package (Desk/Today/report reader/LP narrative) |
| Do not commit | `.env`, `.claude/`, `.grok/`, generated `stocks/*` reports, runtime CRM under most of `apps/sliw-agent/data/*` (see `.gitignore`) |

If your clone’s `main` is not at this tip (or newer `origin/main`), **pull/rebase first**. Do not force-push `main`.

---

## Surfaces map (who edits what)

| Surface | Paths | Notes |
|---------|--------|--------|
| **Auth gateway** | `web/portfolio.html` | Login at portfolio.dgacapital.com |
| **GP terminal** | `web/portfolio-gp.html` (~21k lines, monolithic) | Full desk: research, builder, ideas, positions, options, fund, lab… |
| **LP portal** | `web/portfolio-lp.html` | Investor performance / docs / reports |
| **Research PWA** | `web/index.html`, `web/app.js`, `web/style.css` | Mobile tabs: Research / Ideas / Tracker / Fund / Settings |
| **API** | `api/server.py`, `auth_v2.py`, root Python pipeline | Shared backend — coordinate before large changes |
| **Fund domain** | `apps/fund/` | Schema, waterfall, double-entry docs |
| **Sliw Agent** | `apps/sliw-agent/` | Edyta corporate desk (separate product surface) |
| **Mobile app** | `mobile/` | RN design tokens in `mobile/src/design/` |
| **Mockups** | `mockups/` | HTML design explorations (safe to extend) |

Brand tokens (shared spirit): navy `#0A1628`, brand blue `#5BB8D4`.

---

## Protocol (mandatory)

1. **Read this file** before non-trivial edits. Update **Active claims** when you start.
2. **One owner per path cluster.** If a path is claimed, do not edit it; work elsewhere or wait / hand off in chat.
3. **Branch for risky work.** Prefer `agent/<name>/<short-topic>` or `fable/<topic>` / `grok/<topic>`. Merge via PR when possible.
4. **Never force-push `main`.** Never `git reset --hard` on shared branches without explicit human approval.
5. **Do not “fix” broken auth, fund math, or production env** with speculative rewrites. Prefer smallest reversible diffs.
6. **When you finish:** clear your claim, note outcome in **Handoff log**, push if the human asked for remote sync.
7. **Working order first.** If local dirty state looks accidental (mass deletes of tracked files), restore from `origin/main` rather than committing the damage.

### Conflict rule

If two agents need the same file:

- Prefer **split ownership** (e.g. Fable owns GP HTML structure; Grok owns mockups + design doc).
- Or **serialize**: second agent only starts after the first’s claim is cleared and `main` is pulled.

---

## Active claims

> Edit this table when you start/stop work. Empty claim = free for others.

| Agent | Claimed paths / scope | Status | Started | Notes |
|-------|----------------------|--------|---------|--------|
| **Grok** | — | free | 2026-07-13 | Shipped Option 4 volume LLM harness + Desk feeds. Paths released. |
| **Fable** | — | free | — | Safe to take next assigned work; pull `main` first. |
| **Claude/Opus** | — | free | — | Historical builder of much of GP/LP/app; treat large existing surfaces as shared heritage. |

---

## Open product thread (Grok, 2026-07-13) — **partially shipped**

Human greenlit high-ROI package: **GP → mobile research → LP**, light terminal default.

### Shipped in this package

| Surface | Change |
|---------|--------|
| **GP** `web/portfolio-gp.html` | **Desk** = former Research shell (pulse, analyst, movers, reports). **Book Snapshot** card on right rail. Nav: Desk · Positions · Ideas · Fund; labs secondary. **Light theme default**. Report modal: hero + TOC + freshness + Compare. (Standalone Desk tab removed 2026-07-13 — duplicated Research.) |
| **Mobile research** `web/index.html`, `app.js`, `style.css` | Home retitled **Today** with desk snapshot (reports / stale / brief), needs-attention list, report **hero + TOC + freshness**. Cache-bust `?v=ui68-today`. |
| **LP** `web/portfolio-lp.html` | **Portfolio narrative** strip under hero (plain-English total, blended YTD, strongest/softest sleeve, as-of chips). |

### Still open (good next steps for Fable / Grok)

1. True shared design-token CSS module (still three parallel stylesheets).
2. Expand ⌘K search into full command palette (actions, not just tickers).
3. Modularize `portfolio-gp.html` after IA settles.
4. Wire Desk book snapshot to richer chart/YTD if positions payload thin.
5. LP documents tab still placeholder.

**Hot paths — coordinate before editing:**

- `web/portfolio-gp.html`, `web/portfolio-lp.html`, `web/app.js`, `api/server.py`, auth, fund NAV/YTD math

---

## Handoff log

| Date | From → To | Summary |
|------|-----------|---------|
| 2026-07-13 | Grok → Fable / all | Verified local worktree ≡ `origin/main` @ `6708074`. Restored accidental local deletions of tracked Sliw data files + `stock-financials/.gitkeep` (not committed as deletes). Added `.grok/` to `.gitignore`. Left design proposals in conversation only; **no portfolio UI code changes**. |
| 2026-07-13 | Grok → Fable / all | **Implemented** high-ROI UX package (no API/fund math changes): GP Desk + light default + report reader; mobile Today + report hero/TOC; LP narrative strip. Claims released. Pull `main` before further web UI work. |

---

## Quick verify (any agent, any machine)

```bash
git fetch origin
git status -sb                    # expect: main...origin/main (clean or only your WIP)
git rev-parse --short HEAD origin/main
# spot-check critical blobs match origin:
git diff --stat origin/main -- web/portfolio-gp.html web/portfolio-lp.html web/app.js api/server.py
```

If `git status` shows mass `D` (deletes) you did not intend:

```bash
git restore .
# then re-apply only intentional WIP
```

---

## Contact / priority for humans

When in doubt: **preserve working production surfaces**, small PRs, document claims here, and ask the human before destructive git or multi-surface rewrites.
