"""Generate audition clips for the DGA HiTech Podcast.

Reads OPENAI_API_KEY from env (or .env) and produces one MP3 per OpenAI
stock voice, all reading the same passage. Drop the MP3s into your
player and pick:
  • Alec  (host)   — neutral, even-keeled, slight gravitas
  • Rock  (Grok)   — punchy, contrarian, willing to swear
  • Claude         — measured, drier wit, occasional bite

Run:
    python podcast/audition_voices.py

Outputs:
    podcast/audio/audition_<voice>.mp3   (one per voice)

Notes
-----
• Uses `gpt-4o-mini-tts` (cheap; ~$0.015/min). For final episodes we'll
  bump to `tts-1-hd` per turn, but for casting these are indistinguishable.
• The passage runs ~35 sec — long enough to judge timbre, pacing, and
  how each voice handles a swear word (only one, mildly placed).
"""
from __future__ import annotations
import os, sys, time
from pathlib import Path

# --- Load .env if present ---
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass

API_KEY = os.environ.get("OPENAI_API_KEY")
if not API_KEY:
    sys.exit(
        "❌ OPENAI_API_KEY not set.\n"
        "   Add it to .env (get one at https://platform.openai.com/api-keys)\n"
        "   then re-run: python podcast/audition_voices.py"
    )

try:
    from openai import OpenAI
except ImportError:
    sys.exit("❌ `openai` package missing. Install: pip install openai>=1.40")

# Same passage for every voice — lets you A/B by ear.
# Hits: a calm opener, a heated jab, a punchy close, one mild swear.
AUDITION_TEXT = (
    "Welcome back to the DGA HiTech Podcast. I'm Alec, and tonight Rock and Claude "
    "are squaring off on Intel — yes, that Intel. Look, the bull case is real: "
    "foundry orders are finally landing, and the margin trough may already be in. "
    "But Claude's going to tell us the valuation is still bullshit, and honestly? "
    "He might be right. Let's get into it."
)

VOICES = [
    ("alloy",   "neutral, balanced — safe default"),
    ("echo",    "warmer male, conversational"),
    ("fable",   "British male, storytelling cadence"),
    ("onyx",    "deep male, gravitas"),
    ("nova",    "bright female, energetic"),
    ("shimmer", "soft female, measured"),
]

OUT_DIR = Path(__file__).resolve().parent / "audio"
OUT_DIR.mkdir(parents=True, exist_ok=True)

client = OpenAI(api_key=API_KEY)

print(f"🎙️  Generating {len(VOICES)} auditions → {OUT_DIR}\n")
for voice, blurb in VOICES:
    out_path = OUT_DIR / f"audition_{voice}.mp3"
    t0 = time.time()
    try:
        # Streaming response — avoids loading whole file into memory.
        with client.audio.speech.with_streaming_response.create(
            model="gpt-4o-mini-tts",
            voice=voice,
            input=AUDITION_TEXT,
            response_format="mp3",
            speed=1.0,
        ) as resp:
            resp.stream_to_file(out_path)
        dt = time.time() - t0
        size_kb = out_path.stat().st_size / 1024
        print(f"  ✅ {voice:8s} ({blurb})  →  {out_path.name}  [{size_kb:.0f}KB, {dt:.1f}s]")
    except Exception as e:
        print(f"  ❌ {voice:8s} failed: {e}")

print(
    "\n✓ Done. Play them in order and tell me which 3 voices to assign to:"
    "\n    • Alec  (host)"
    "\n    • Rock  (Grok analyst, the punchy one)"
    "\n    • Claude (the careful one)"
)
