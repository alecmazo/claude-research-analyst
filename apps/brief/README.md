# Brief (placeholder)

Future home of the **DGA Capital Daily Brief** podcast app. The text
generation logic already exists inside Research at
`claude_analyst.py::run_daily_brief`. This app will:

1. Consume Research's `/api/daily-brief` endpoint (text).
2. Render to MP3 via ElevenLabs TTS.
3. (Later) Render to MP4 via HeyGen avatar.
4. Publish to Cloudflare R2 → RSS feed → Apple Podcasts.

The text brief stays in Research (one brain). This app is purely the
media production + distribution layer.

See `../../MONOREPO.md` Phase 4.
