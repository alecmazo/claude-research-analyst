# `@dga/dropbox` (placeholder)

Dropbox OAuth + file sync helpers currently live inline in
`claude_analyst.py` (the `_hydrate_from_dropbox`, `fetch_from_dropbox`,
`push_to_google_drive` etc. helpers).

This package will host:
- The OAuth refresh-token dance.
- A folder-routing rule engine (`.docx → Reports/`, `.md → MD cached/`,
  `.xlsx → Rebalanced/`, `.pptx → Presentations/` — the rules that
  already exist in claude_analyst's `_dropbox_dest_for`).
- A simple `pull(folder)`, `push(file, dest)`, `list(folder)` API.

The Fund Admin app uses it for storing signed PDF statements and
subscription docs. Brief uses it for podcast MP3s. Research already
uses it for cached reports.

See `../../MONOREPO.md` Phase 2/3.
