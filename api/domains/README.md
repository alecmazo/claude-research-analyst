# API domain modules

`api/server.py` grew past 30k lines. New work should land here as **domain modules** instead of expanding the monolith.

## Layout

| Module | Role |
|--------|------|
| `support_tickets.py` | GP support tickets (routes + helpers) — mounted at boot |
| `financials_series.py` | Annual/quarter series load + FY de-dupe for charts |
| *(planned)* `financials_store.py` | SEC sync jobs, universes, nightly/monthly schedulers |
| *(planned)* `financials_dashboard.py` | Company dashboard, ranks, Value Line sheet, peers |
| *(planned)* `options.py` | Wheel scanner endpoints |
| *(planned)* `podcast.py` | Podcast / memos routes |
| *(planned)* `snaptrade.py` | Brokerage sync |

## How to add a domain

1. Create `api/domains/<name>.py` with an `APIRouter` and/or pure helpers.
2. Export `mount(ns: dict)` that binds server symbols (`_fund_conn`, auth, …) and calls `ns["app"].include_router(router)`.
3. Call `mount({...})` near the bottom of `server.py` (see support tickets).
4. Prefer **lazy** use of server helpers via a bag object so import order stays safe.

## Frontend split

GP terminal assets live under `web/gp/`:

```
web/gp/css/   gp-legacy.css, gp-design-v2.css, gp-podcast.css, gp-support.css
web/gp/js/    gp-main.js, gp-design-v2.js, gp-support.js
web/portfolio-gp.html   thin shell (~2.5k lines)
```

Served as static files under `/app/gp/...` (existing `StaticFiles` mount on `web/`).
