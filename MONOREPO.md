# DGA Suite — Monorepo Migration Plan

This repo is being reshaped from a single-app codebase (DGA Capital
Research) into a **suite of apps** sharing a design system, an auth
layer, and a few cross-cutting libraries.

The goal is the "app store" pattern: one identity, one launcher, isolated
apps that can each deploy and break independently.

---

## Current state (Phase 0)

```
Claude_Research_Analyst/
├── claude_analyst.py        ← Research backend logic (~9000 lines)
├── api/server.py            ← FastAPI server for Research
├── mobile/                  ← Research mobile app (Expo SDK 54)
├── web/                     ← Research web app (vanilla JS)
├── apps/                    ← NEW (scaffolding only — see below)
│   ├── research/            ← placeholder, points back to root
│   ├── fund/                ← Fund Admin app — schema is real, code TBD
│   └── brief/               ← News + podcast app — placeholder
└── packages/                ← NEW (scaffolding only)
    ├── ui/                  ← future shared design system
    ├── wall-street-format/  ← future shared Goldman/MS templates
    ├── auth/                ← future SSO / token issuance
    ├── api-client/          ← future typed API clients
    └── dropbox/             ← future Dropbox helpers
```

**Nothing has moved.** The Research app still deploys from the root —
Railway picks up `claude_analyst.py` + `api/server.py`, EAS Build picks
up `mobile/`, FastAPI serves `web/` at `/app/`. All existing
functionality is unchanged. The new directories are scaffolding for
future migrations.

---

## Target state

```
dga-suite/
├── apps/
│   ├── research/            ← formerly claude_analyst.py + api/ + mobile/ + web/
│   ├── fund/                ← cap table, mgmt fee, carry, LP statements
│   └── brief/               ← TTS podcast generator
├── packages/
│   ├── ui/                  ← design system (mobile + web)
│   ├── wall-street-format/  ← Goldman/MS/Merrill templates
│   ├── auth/                ← SSO, JWT issuance/validation
│   ├── api-client/          ← typed clients for each app's API
│   └── dropbox/             ← shared Dropbox helpers
├── infra/
│   ├── postgres/            ← Postgres schema migrations
│   └── deploy/              ← Railway service configs per app
└── pnpm-workspace.yaml      ← Turborepo + pnpm workspace
```

Each app is a **separate Railway service** behind its own subdomain:
- `research.dga.app` (formerly the only domain)
- `fund.dga.app`
- `brief.dga.app`

Each app's mobile module is a folder under one Expo binary at
`mobile/src/apps/{research,fund,brief}/`. A single TestFlight install
gets you the whole suite.

---

## Migration phases

### Phase 0 — Scaffolding (now ✓)
- Create `apps/`, `packages/`, `MONOREPO.md`.
- Land the Fund Admin schema (`apps/fund/db/migrations/0001_initial_schema.sql`)
  as the first real deliverable in the new tree.
- **No existing code is moved.** All deployments continue working.

### Phase 1 — Build the Fund Admin app inside the new tree
- Stand up Postgres on Railway (one new service).
- Apply the schema via `psql` or alembic.
- Build a separate FastAPI service at `apps/fund/api/server.py`
  with its own `requirements.txt`, deployed as a new Railway service.
- Build the mobile module at `mobile/src/apps/fund/` — reuses the
  existing Expo binary and the design system at `mobile/src/design/`.
- Build the web module at `apps/fund/web/` — the existing FastAPI
  server gains a `/fund/` mount point, OR the new service serves it
  itself.

This proves the pattern with a real second app while leaving Research
untouched at the root. The "Hub" tile-grid screen is added to mobile
once we have two apps to switch between.

### Phase 2 — Hoist the design system into a real package
- `mobile/src/design/` → `packages/ui/`
- Convert to a real npm workspace package (`@dga/ui`).
- Update mobile imports: `from '../design'` → `from '@dga/ui'`.
- Updates to the design system now propagate to Research and Fund Admin
  with no copy-paste.

### Phase 3 — Move Research into `apps/research/`
- This is the biggest single migration. We move only after Phases 1–2
  prove the new structure works on a fresh app.
- Split `claude_analyst.py` (~9000 lines) into modules: data, prompts,
  rendering, gamma, intelligence.
- Move FastAPI server to `apps/research/api/`.
- Move web to `apps/research/web/`.
- Move mobile screens to `mobile/src/apps/research/`.
- Update Railway service to point at the new path.
- Update EAS build paths (no-op if mobile root stays at `/mobile`).
- Update CI / GitHub Actions if any.

### Phase 4 — Build the Brief app
- New Railway service, cron-driven, calls the existing `/api/daily-brief`.
- New mobile module + new web module.
- ElevenLabs (TTS) → Cloudflare R2 → RSS feed → Apple Podcasts.

### Phase 5 — Avatar (later, when value is proven)
- HeyGen / Synthesia integration to produce a video version of the
  morning brief. ~$30/min so reserved for a "premium" tier.

---

## Why this order?

The migration optimizes for **never breaking a deploy**:

1. Phase 0 is additive — strictly new directories.
2. Phase 1 builds a brand-new app at the new path so we can test the
   structure end-to-end (deploy, OTA, SSO) on something that doesn't
   yet have users.
3. Phase 2 hoists the shared package only after the new app proves it
   imports cleanly.
4. Phase 3 moves the production app — but only after the structure
   has been battle-tested. We have a rollback in `git revert`.
5. Phases 4–5 are net-new, no migration cost.

If we did Phase 3 first, a single typo in a path could take down
Research mid-day. Doing Phases 1–2 first means the production app
keeps running while we stress-test the new layout.

---

## What stays single-app

A few things will **not** become per-app, by design:

- **Authentication** — one SSO provider for the whole suite.
  `packages/auth/` issues tokens scoped per app.
- **Design system** — `packages/ui/` enforces visual consistency.
- **Wall Street formatting** — `packages/wall-street-format/` is the
  one place that knows what a Goldman institutional research note looks
  like. Used by Research and Brief.
- **Dropbox / Drive sync** — `packages/dropbox/` is the one client.
  Apps use it via dependency injection.

---

## Tooling decisions (deferred to Phase 1)

- **Workspace manager:** `pnpm` workspaces + `Turborepo`.
- **Per-package versioning:** none — internal-only, all packages stay
  in lockstep. Simpler than semantic versioning for an internal suite.
- **Linting / formatting:** one root `eslint` config, one root `prettier`.
- **Tests:** vitest for JS/TS packages, pytest for Python apps.
- **CI:** GitHub Actions, one matrix per app, only rebuilds what changed
  (Turborepo handles the change detection).

These are documented here as decisions but not implemented in Phase 0.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Moving `claude_analyst.py` breaks Railway | Don't do that until Phase 3. Phases 0–2 leave it untouched. |
| Moving `mobile/` breaks EAS Build | Same. Phase 0 only adds `apps/`, leaves `mobile/` alone. |
| Hoisting the design system breaks mobile imports | Phase 2 happens after Phase 1 proves the new layout. Mobile imports are find/replaced as a single commit. |
| Two apps on one Expo binary risk one-app-crashes-all | Each app folder gets a top-level error boundary. |
| Multiple Railway services balloon costs | Railway's free tier covers ~5 services. Cost ~$5/mo per service after. Manageable. |

---

## Open questions (revisit at Phase 1)

- Do we want a "Hub" launcher screen on mobile, or just route via
  bottom-tab bar with one tab per app?
- Brief app: own Railway service, or a cron module inside Research's
  service? (Both work — own service gives independence.)
- Single Postgres instance shared by Fund Admin + future apps, or
  one per service? (Lean toward one-per-service for isolation.)
