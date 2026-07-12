# Sliw ↔ DGA Capital isolation

Sliw Agent is an **optional side product** hosted inside the DGA Railway service.
It must never break research, fund admin, LP dashboards, or auth.

## Hard boundaries

| Concern | Isolation |
|---------|-----------|
| **Kill switch** | `SLIW_ENABLED=0` skips mount entirely; DGA boots as before |
| **Boot safety** | Mount is try/except; import failures log and continue |
| **Python path** | `sys.path.append` only — never `insert(0)` (no module shadowing) |
| **HTTP routes** | Only `/sliw/*` and `/api/sliw/*` — no overrides of `/gp`, `/lp`, `/api/fund`, etc. |
| **Auth** | Reuses DGA login; **only** `alecmazo1@gmail.com` + `edytasliw@gmail.com` (override via `SLIW_ALLOWED_EMAILS`). Other DGA logins: no Sliw nav link, API 403 |
| **Data files** | `$STOCKS_FOLDER/sliw-agent/` or `SLIW_DATA_DIR` — never DGA report/ticker folders |
| **Gamma credits** | Shared `GAMMA_API_KEY` with DGA (intentional — same pool) |
| **Login flow** | `?next=` only accepts `/sliw…` paths; default still `/gp` or `/lp` |
| **GP chrome** | Single optional top-nav link; no tab logic changes |

## What Sliw does *not* touch

- SEC / research pipeline (`claude_analyst.py`)
- Fund DB schema or LP capital accounts
- Portfolio watchlists, podcasts, SnapTrade
- Auth credential seed (except reading existing tokens)
- Background market sync / job janitors

## Operator checklist

```bash
# Disable Sliw without redeploying code (env only)
SLIW_ENABLED=0

# Optional dedicated data volume path
SLIW_DATA_DIR=/data/sliw-agent

# Gamma uses shared GAMMA_API_KEY (already on Railway for DGA research)
# Optional: SLIW_GAMMA_FOLDER_ID to drop decks in a separate Gamma folder
```

## If something looks wrong on DGA after a Sliw deploy

1. Set `SLIW_ENABLED=0` on Railway and redeploy (or restart).
2. Confirm `/gp`, `/lp`, `/health` still work.
3. Inspect logs for `[sliw] mount failed` / `mount aborted` — those lines mean DGA continued without Sliw.
