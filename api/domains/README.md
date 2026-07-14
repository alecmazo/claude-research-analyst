# API domain modules

`api/server.py` is the FastAPI app entrypoint. Large feature areas are extracted into this package so the monolith stops growing.

## Layout

| Module | Role | Lines (approx) |
|--------|------|----------------:|
| `support_tickets.py` | GP support tickets (APIRouter + bag) | ~700 |
| `financials_series.py` | Annual/quarter series + FY de-dupe | ~140 |
| `financials_api.py` | Mount hook for financials body | ~30 |
| `_financials_body.py` | SEC store, sync jobs, market quotes cache, company dashboard, ranks, Value Line sheet, price history | ~4,400 |
| *(planned)* `options.py` | Wheel scanner | |
| *(planned)* `podcast.py` | Podcast / memos | |
| *(planned)* `snaptrade.py` | Brokerage sync | |

## How financials_api works

`_financials_body.py` is **executed into `api.server`’s module namespace** at boot:

```python
from api.domains import financials_api
financials_api.mount(sys.modules[__name__])
```

That preserves the original code’s use of `app`, `_fund_conn`, `_claims_or_401`, etc. without a giant rewrite of every helper reference.

**Edit `_financials_body.py` as normal Python.** Do not `import` it for side effects.

## How to add a new domain

### Preferred (self-contained routes)

1. Create `api/domains/<name>.py` with `APIRouter` + `mount(ns)` (see `support_tickets.py`).
2. Call `mount({...})` from the domain boot section at the bottom of `server.py`.

### Large legacy block (many server helpers)

1. Cut the block into `api/domains/_<name>_body.py`.
2. Add a thin `mount(mod)` that `exec`s the body into `mod.__dict__` (see `financials_api.py`).
3. Call mount **after** helpers the body needs (`_fund_conn`, auth, …) exist.

## Frontend split

GP terminal assets:

```
web/gp/css/   gp-legacy.css, gp-design-v2.css, gp-podcast.css, gp-support.css
web/gp/js/    gp-main.js, gp-design-v2.js, gp-support.js
web/portfolio-gp.html   thin shell (~2.5k lines)
```

Served under `/app/gp/...`.
