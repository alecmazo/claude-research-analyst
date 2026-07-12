# Hunter.io for Sliw Agent

## What it is

[Hunter.io](https://hunter.io) finds professional email addresses for people at a company (domain search) and can verify whether an address is deliverable.

## What we need

| API | Need? | Why |
|-----|--------|-----|
| **Domain Search** | **Yes — primary** | Given `airbnb.com`, returns employees + emails + titles; we filter People/Events/L&D |
| **Email Finder** | Optional | If we have a name + domain, get their email |
| **Email Verifier** | Nice to have | Confirms deliverability before send (saves reputation) |
| **Leads / Campaigns** | **No** | We store leads in Sliw CRM; don’t need Hunter’s CRM/campaign product |

Set on Railway:

```
HUNTER_API_KEY=your_key_here
```

## Pricing (as of 2026 — check hunter.io/pricing)

Unified credits (search + verify share one pool):

| Plan | Approx monthly | Credits / mo | Rough fit for Sliw |
|------|----------------|--------------|--------------------|
| Free | $0 | ~50 | Smoke test only |
| Starter | ~$34–49 | ~2,000 | Good start (hundreds of companies) |
| Growth | ~$104–149 | ~10,000 | Scaling outbound |
| Scale | ~$209–299 | ~25,000 | Heavy volume |

**Rule of thumb:** Domain Search costs about **1 credit per email returned**. Verifying is cheaper per credit on the unified model (historically ~0.5 credit).

For Edyta’s desk (dozens of corps/week, not thousands): **Starter annual** is usually enough.

## Without Hunter

Sliw still runs: public page scrape + role inboxes (`people@`, `events@`). Quality is lower — Hunter is the upgrade for real names.
