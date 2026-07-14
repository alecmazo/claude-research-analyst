# Support inbox (GP trouble tickets)

Tickets filed from the GP terminal **🛟 Support** button land in Postgres (`support_tickets`) and, when the API process can write the workspace disk, also as markdown packets here.

## Do I need the Grok terminal open to file a ticket?

**No.** Filing works anytime while you are logged into the GP app. Screenshot + description are stored on Railway; auto-diagnosis runs in the background via LLM.

## When is the terminal needed?

**To apply code fixes.** Production (Railway) does not push git commits. A coding agent (Grok Build / Claude Code in this repo) should:

1. Read open tickets: `GET /api/support/agent-inbox` (GP auth) or this folder’s `OPEN.md` / `SUP_*.md` files if present.
2. Inspect screenshot: `GET /api/support/tickets/{id}/screenshot`
3. Implement a minimal fix, commit, push.
4. Close the ticket:
   - `POST /api/support/tickets/{id}/update` with `{ "status": "fixed", "fixed_summary": "…" }`
   - optional trail notes via `POST /api/support/tickets/{id}/trail`

## Settings trail

In the GP app: **Settings → Support tickets & fix trail** shows status, diagnosis, screenshot, and the chronological fix trail for every ticket.
