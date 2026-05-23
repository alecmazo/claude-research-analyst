"""DGA HiTech Podcast — engine.

v0 scope (this file): script generation only.
  • generate_script(ticker, grok_md, claude_md) → validated JSON
  • Strict structure (cold open → company-in-60 → opening pitches →
    4 rounds incl steelman → verdict)
  • Word budget ~1400–1800 for an 8–10 min episode
  • Cursing whitelist + per-episode cap (≤5)
  • Per-turn `intensity` ∈ {calm, normal, heated} → maps to TTS speed in v1

Cast / voice map (locked):
    Alec   (host)            → OpenAI 'fable'
    Rock   (Grok analyst)    → OpenAI 'onyx'
    Claude (analyst)         → OpenAI 'echo'

Audio + RSS land in v1/v2 — this module returns only structured dialogue.
"""
from __future__ import annotations

import json
import re
from typing import Any

# ── Cast & voice mapping ────────────────────────────────────────────────
VOICE_MAP: dict[str, str] = {
    "alec":   "fable",   # host
    "rock":   "onyx",    # Grok-powered analyst
    "claude": "echo",    # Claude-powered analyst
}

# Whitelisted curse words. Anything outside this set in the LLM output
# gets flagged in validation (and the generator can be re-rolled).
CURSE_WHITELIST = {
    "damn", "damned", "hell", "shit", "shitty", "fuck", "fucking",
    "bullshit", "fucked",
}
MAX_CURSES_PER_EPISODE = 5

# Intensity → playback speed (used by v1 TTS layer)
INTENSITY_SPEED = {"calm": 0.95, "normal": 1.0, "heated": 1.10}

VALID_SPEAKERS = {"alec", "rock", "claude"}
VALID_INTENSITY = set(INTENSITY_SPEED)

# Section ids the LLM MUST produce in order.
REQUIRED_SECTIONS = [
    "cold_open",            # Alec, ~15s
    "company_in_60",        # Alec, ~60s
    "opening_pitch_rock",   # Rock, ~60s
    "opening_pitch_claude", # Claude, ~60s
    "round_thesis",         # debate, ~90s
    "round_valuation",      # debate, ~90s
    "round_catalysts",      # debate, ~90s
    "round_steelman",       # each defends the OTHER's case, ~60s
    "verdict",              # Alec names a winner, ~45s
]


# ════════════════════════════════════════════════════════════════════════
# Prompting
# ════════════════════════════════════════════════════════════════════════

def _system_prompt() -> str:
    return """You are the producer-writer for the DGA HiTech Podcast — a fast-paced \
investment debate show in the style of Animal Spirits (banter, interruptions, \
strong opinions). Each episode debates ONE public company.

CAST (the three speakers, never invent a fourth):
  • Alec   — host. Even-keeled, sharp, calls bullshit on either side. \
Sets up the company, runs the rounds, names a winner at the end. \
Does NOT take a side until the verdict.
  • Rock   — analyst. Punchy, contrarian, momentum + narrative lean. \
Higher conviction. Speeds up when selling upside. Willing to swear \
when something is dumb or exciting. Powered by Grok.
  • Claude — analyst. Measured, valuation-disciplined, base-rates guy. \
Drier wit. Cusses rarely, only for emphasis on a real risk. \
Powered by Claude.

TONE
  • Animal Spirits pacing — short turns, callbacks, occasional interruptions \
("Hold on—") rendered as a single line ending with em-dash.
  • Heated mid-episode (valuation + catalysts), calmer at intro + verdict.
  • Cursing is allowed but RARE — max 5 instances per episode, only from \
{damn, hell, shit, fuck, bullshit, fucking, fucked}. Use only for \
punctuation, never gratuitously. Never use any other profanity, slurs, \
or anything brand-unsafe.

STRUCTURE (you MUST produce these sections in this order, each as a list of turns):
  1. cold_open            — Alec only, 1 turn, ~35–45 words. One-line hook + name ticker.
  2. company_in_60        — Alec only, 1 turn, ~120–150 words. Plain-English: what the company does, why we care today.
  3. opening_pitch_rock   — Rock only, 1 turn, ~140–170 words. Bull/bear stance + specific price target.
  4. opening_pitch_claude — Claude only, 1 turn, ~140–170 words. Bull/bear stance + specific price target.
  5. round_thesis         — 4–6 turns alternating, mostly Rock + Claude, with Alec injecting 1–2 follow-ups.
  6. round_valuation      — 4–6 turns. THIS IS THE HOTTEST ROUND — multiples, comps, peer math, target math. Mark turns intensity=heated.
  7. round_catalysts      — 4–6 turns. Near-term catalysts, risks, what could break the thesis.
  8. round_steelman       — exactly 2 turns: Rock argues Claude's bear case in his own words, then Claude argues Rock's bull case. 60–80 words each.
  9. verdict              — Alec only, 1–2 turns, ~110–140 words. Must explicitly say \
"the more convincing pitch tonight was Rock" or "...was Claude" and give 2 specific reasons \
drawn from THE DEBATE (not from the reports). No ties, no cop-outs.

TOTAL WORD COUNT TARGET: 1,400–1,800 words across all sections combined. \
This produces an 8–10 min episode at conversational TTS pacing. \
If the source reports are thin, CUT length — do not pad with filler.

PER-TURN FIELDS (every turn is an object with exactly these keys):
  • "speaker"   ∈ "alec" | "rock" | "claude"
  • "text"      — the spoken line. Plain prose. No markdown, no asterisks, no bullets. \
Use natural contractions ("it's", "we're"). For an interruption, end the line with " —"
  • "intensity" ∈ "calm" | "normal" | "heated"

OUTPUT FORMAT — return ONLY valid JSON, no preamble, no code fences, matching this shape exactly:

{
  "ticker": "<TICKER>",
  "episode_title": "<TICKER>: Bull vs Bear",
  "winner": "rock" | "claude",
  "sections": [
    {"id": "cold_open",            "turns": [...]},
    {"id": "company_in_60",        "turns": [...]},
    {"id": "opening_pitch_rock",   "turns": [...]},
    {"id": "opening_pitch_claude", "turns": [...]},
    {"id": "round_thesis",         "turns": [...]},
    {"id": "round_valuation",      "turns": [...]},
    {"id": "round_catalysts",      "turns": [...]},
    {"id": "round_steelman",       "turns": [...]},
    {"id": "verdict",              "turns": [...]}
  ]
}

The "winner" field MUST match whoever Alec names in the verdict section.

DO NOT include any text outside the JSON. DO NOT use markdown code fences.
"""


def _user_prompt(ticker: str, grok_md: str, claude_md: str) -> str:
    return f"""Generate the DGA HiTech Podcast episode for ticker {ticker}.

Below are the two source research reports the analysts will debate. \
Pull specific numbers (price targets, multiples, growth rates, margins) \
from these — the debate must feel grounded in real data, not generic.

══════════════════════════════════════════════════════════════════════
ROCK'S REPORT (Grok-powered, the more aggressive analyst):
══════════════════════════════════════════════════════════════════════
{grok_md.strip()}

══════════════════════════════════════════════════════════════════════
CLAUDE'S REPORT (Claude-powered, the more measured analyst):
══════════════════════════════════════════════════════════════════════
{claude_md.strip()}

══════════════════════════════════════════════════════════════════════

Now write the episode. Remember:
  • JSON only, matching the schema in the system prompt exactly
  • 1,400–1,800 total words
  • Max 5 curse words total, only from the whitelist
  • Alec names a winner with 2 specific reasons drawn from THE DEBATE
  • "winner" field at the top must match Alec's verdict
"""


# ════════════════════════════════════════════════════════════════════════
# Validation
# ════════════════════════════════════════════════════════════════════════

def _strip_code_fence(s: str) -> str:
    """LLMs sometimes ignore "no code fence" — strip them if they slip through."""
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    return s.strip()


def _count_curses(text: str) -> int:
    """Count whitelisted curse words (case-insensitive, word-boundary)."""
    n = 0
    for w in CURSE_WHITELIST:
        n += len(re.findall(rf"\b{re.escape(w)}\b", text, flags=re.IGNORECASE))
    return n


def _word_count(text: str) -> int:
    return len(re.findall(r"\b[\w']+\b", text))


def validate_script(script: dict[str, Any]) -> dict[str, Any]:
    """Validate a script dict. Returns {ok, errors, warnings, stats}.

    Errors are blocking (would break audio gen). Warnings are advisory
    (e.g. word count outside target band — still playable but suboptimal).
    """
    errors: list[str] = []
    warnings: list[str] = []

    # Top-level required keys
    for k in ("ticker", "episode_title", "winner", "sections"):
        if k not in script:
            errors.append(f"missing top-level key: {k}")

    winner = (script.get("winner") or "").lower()
    if winner not in ("rock", "claude"):
        errors.append(f"winner must be 'rock' or 'claude', got: {winner!r}")

    sections = script.get("sections") or []
    section_ids = [s.get("id") for s in sections]
    for required in REQUIRED_SECTIONS:
        if required not in section_ids:
            errors.append(f"missing required section: {required}")

    # Per-turn validation + stats
    total_words = 0
    total_curses = 0
    speakers_used: set[str] = set()
    all_text_chunks: list[str] = []

    for sec in sections:
        sec_id = sec.get("id", "?")
        for i, turn in enumerate(sec.get("turns") or []):
            sp = (turn.get("speaker") or "").lower()
            intensity = (turn.get("intensity") or "").lower()
            text = (turn.get("text") or "").strip()
            if sp not in VALID_SPEAKERS:
                errors.append(f"{sec_id}[{i}] invalid speaker: {sp!r}")
            if intensity not in VALID_INTENSITY:
                errors.append(f"{sec_id}[{i}] invalid intensity: {intensity!r}")
            if not text:
                errors.append(f"{sec_id}[{i}] empty text")
            speakers_used.add(sp)
            all_text_chunks.append(text)
            total_words += _word_count(text)

    # Section-specific speaker rules
    for sec in sections:
        sid = sec.get("id")
        turns = sec.get("turns") or []
        if sid in ("cold_open", "company_in_60", "verdict"):
            non_alec = [t for t in turns if (t.get("speaker") or "").lower() != "alec"]
            if non_alec:
                errors.append(f"{sid} should be Alec only — found {len(non_alec)} other speakers")
        if sid == "opening_pitch_rock":
            if not turns or (turns[0].get("speaker") or "").lower() != "rock":
                errors.append("opening_pitch_rock must start with Rock")
        if sid == "opening_pitch_claude":
            if not turns or (turns[0].get("speaker") or "").lower() != "claude":
                errors.append("opening_pitch_claude must start with Claude")
        if sid == "round_steelman":
            if len(turns) != 2:
                warnings.append(f"round_steelman should be exactly 2 turns, got {len(turns)}")

    full_text = " ".join(all_text_chunks)
    total_curses = _count_curses(full_text)
    if total_curses > MAX_CURSES_PER_EPISODE:
        warnings.append(
            f"curse count {total_curses} exceeds cap of {MAX_CURSES_PER_EPISODE} — "
            "consider regenerating or hand-trimming"
        )

    # Word budget
    if total_words < 1200:
        warnings.append(f"word count {total_words} below 1,400–1,800 target — episode may run short of 8 min")
    elif total_words > 2000:
        warnings.append(f"word count {total_words} above 1,400–1,800 target — episode may overshoot 10 min")

    # Verdict must contain winner name
    verdict_text = ""
    for sec in sections:
        if sec.get("id") == "verdict":
            verdict_text = " ".join(t.get("text", "") for t in (sec.get("turns") or []))
            break
    if winner and winner not in verdict_text.lower():
        warnings.append(f"verdict text does not mention the declared winner ({winner!r})")

    return {
        "ok": not errors,
        "errors":   errors,
        "warnings": warnings,
        "stats": {
            "word_count":    total_words,
            "curse_count":   total_curses,
            "section_count": len(sections),
            "turn_count":    sum(len(s.get("turns") or []) for s in sections),
            "approx_minutes": round(total_words / 165, 1),  # ~165 wpm conversational TTS
            "winner":        winner,
        },
    }


# ════════════════════════════════════════════════════════════════════════
# Generation
# ════════════════════════════════════════════════════════════════════════

def generate_script(
    ticker: str,
    grok_md: str,
    claude_md: str,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    """Generate one podcast episode script from both research reports.

    Returns:
        {
            "ticker":       str,
            "script":       dict (the validated JSON),
            "validation":   {ok, errors, warnings, stats},
            "raw_response": str (the LLM's raw output, for debugging),
        }

    On validation failure (errors), `script` is still returned (best-effort)
    so the UI can show what the LLM produced and the user can decide whether
    to regenerate.
    """
    if not (grok_md and grok_md.strip()):
        raise ValueError("grok_md is empty — need both reports to generate a debate")
    if not (claude_md and claude_md.strip()):
        raise ValueError("claude_md is empty — need both reports to generate a debate")

    # Lazy import — avoids pulling claude_analyst at module load
    import claude_analyst as _ca

    # Truncate each report to keep input cost reasonable (~25k char each
    # is plenty — most reports are 15–25k anyway). Claude Opus has 200k
    # context, so this is purely a cost guard.
    MAX_INPUT_CHARS = 35000
    grok_trim   = grok_md[:MAX_INPUT_CHARS]
    claude_trim = claude_md[:MAX_INPUT_CHARS]

    system = _system_prompt()
    user   = _user_prompt(ticker.upper(), grok_trim, claude_trim)

    raw = _ca.call_claude(
        system_prompt=system,
        user_content=user,
        model=model or _ca.CLAUDE_MODEL,
    )

    cleaned = _strip_code_fence(raw)
    try:
        script = json.loads(cleaned)
    except json.JSONDecodeError as e:
        return {
            "ticker": ticker.upper(),
            "script": None,
            "validation": {
                "ok": False,
                "errors":   [f"LLM returned invalid JSON: {e!s:.200}"],
                "warnings": [],
                "stats":    {},
            },
            "raw_response": raw,
        }

    # Force ticker to match request (LLM occasionally lower-cases it)
    script["ticker"] = ticker.upper()
    if "episode_title" not in script:
        script["episode_title"] = f"{ticker.upper()}: Bull vs Bear"

    validation = validate_script(script)
    return {
        "ticker":       ticker.upper(),
        "script":       script,
        "validation":   validation,
        "raw_response": raw,
    }


# ════════════════════════════════════════════════════════════════════════
# Pretty-print helpers (for the UI / CLI)
# ════════════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════════════
# Audio synthesis (v1) — TTS + stitching + music sting
# ════════════════════════════════════════════════════════════════════════
#
# Flow:
#   1. For each turn → call OpenAI TTS (voice from VOICE_MAP, speed from
#      INTENSITY_SPEED). Returns MP3 bytes per turn.
#   2. Decode each MP3 to a pydub AudioSegment.
#   3. Concatenate with small gaps (200ms intra-section, 500ms between
#      sections, 800ms before the verdict for dramatic effect).
#   4. Pre-pend a 3-sec intro sting + append a 2-sec outro sting (both
#      generated procedurally on first use, cached to disk).
#   5. Apply gentle compression + normalize, export as 128k MP3.
#
# Requires:
#   • OPENAI_API_KEY in env
#   • pydub installed (pip)
#   • ffmpeg on PATH (declared in nixpacks.toml for Railway)

import io
from pathlib import Path

TTS_MODEL_DEFAULT = "tts-1-hd"   # higher quality than gpt-4o-mini-tts for final episodes
TTS_FORMAT        = "mp3"

# Pacing (milliseconds)
GAP_INTRA_SECTION = 220
GAP_BETWEEN_SECTIONS = 520
GAP_BEFORE_VERDICT = 850

# Music sting paths (generated on first use, then cached)
_STING_DIR = Path(__file__).parent / "podcast" / "stings"
INTRO_STING_PATH = _STING_DIR / "intro_3s.mp3"
OUTRO_STING_PATH = _STING_DIR / "outro_2s.mp3"


def _ensure_stings() -> tuple[Path, Path]:
    """Generate the brand intro/outro music stings if they don't exist yet.

    Style: minimalist DGA HiTech vibe — a soft rising 3-note arpeggio
    on the intro (E5 → A5 → C#6, ~major chord, warm sine timbre + fade
    in/out), and a single low resolving tone on the outro. We're not
    making a Suno-quality jingle — just a clean, branded "we're starting"
    and "we're done" cue.

    Cached to disk after first generation. Cheap to regenerate if you
    want to tune them: just delete the files.
    """
    _STING_DIR.mkdir(parents=True, exist_ok=True)
    if INTRO_STING_PATH.exists() and OUTRO_STING_PATH.exists():
        return INTRO_STING_PATH, OUTRO_STING_PATH

    from pydub import AudioSegment
    from pydub.generators import Sine

    def _tone(freq: float, ms: int, gain_db: float = -8.0) -> AudioSegment:
        # Two sine layers (fundamental + octave below at lower gain) for warmth
        a = Sine(freq).to_audio_segment(duration=ms).apply_gain(gain_db)
        b = Sine(freq / 2).to_audio_segment(duration=ms).apply_gain(gain_db - 6)
        return a.overlay(b)

    # ── INTRO (3 sec): rising arpeggio E5 → A5 → C#6, overlapping ───
    e5  = _tone(659.25, 1400).fade_in(120).fade_out(900)
    a5  = _tone(880.00, 1400).fade_in(120).fade_out(900)
    cs6 = _tone(1108.73, 1800).fade_in(180).fade_out(1400)
    intro = AudioSegment.silent(duration=3000)
    intro = intro.overlay(e5,  position=0)
    intro = intro.overlay(a5,  position=400)
    intro = intro.overlay(cs6, position=900)
    # gentle low pad underneath (A2 sustained, very quiet) for body
    pad = _tone(110.0, 3000, gain_db=-22).fade_in(300).fade_out(800)
    intro = intro.overlay(pad)
    intro = intro.fade_out(200).normalize(headroom=2.0)
    intro.export(INTRO_STING_PATH, format="mp3", bitrate="128k")

    # ── OUTRO (2 sec): single A4 → A3 resolving tone ────────────────
    a4 = _tone(440.0, 1200).fade_in(60).fade_out(600)
    a3 = _tone(220.0, 2000).fade_in(60).fade_out(1200)
    outro = AudioSegment.silent(duration=2000)
    outro = outro.overlay(a4, position=0)
    outro = outro.overlay(a3, position=300)
    outro = outro.fade_out(400).normalize(headroom=2.0)
    outro.export(OUTRO_STING_PATH, format="mp3", bitrate="128k")

    return INTRO_STING_PATH, OUTRO_STING_PATH


def _tts_turn(client, speaker: str, text: str, intensity: str,
              model: str = TTS_MODEL_DEFAULT) -> bytes:
    """Synthesize one turn via OpenAI TTS. Returns raw MP3 bytes."""
    voice = VOICE_MAP.get(speaker.lower(), "alloy")
    speed = INTENSITY_SPEED.get(intensity.lower(), 1.0)
    # OpenAI speed range is 0.25–4.0; we stay in 0.95–1.10 per our spec.
    resp = client.audio.speech.create(
        model=model,
        voice=voice,
        input=text,
        response_format=TTS_FORMAT,
        speed=speed,
    )
    # Newer openai sdk: resp.read() returns bytes
    if hasattr(resp, "read"):
        return resp.read()
    if hasattr(resp, "content"):
        return resp.content
    return bytes(resp)


def synthesize_episode(
    script: dict[str, Any],
    *,
    out_path: Path,
    tts_model: str = TTS_MODEL_DEFAULT,
    on_progress=None,
) -> dict[str, Any]:
    """Synthesize a full episode from a validated script. Writes MP3 to `out_path`.

    Returns: {ok, duration_sec, turn_count, mp3_bytes, voice_map, model}.

    on_progress: optional callable(stage, current, total, label) — called
    at script start, before each turn, and at the final stitch step. Lets
    the UI render a progress bar without polling.
    """
    import os as _os
    api_key = _os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    try:
        from openai import OpenAI
    except ImportError as e:
        raise RuntimeError("openai package missing") from e
    try:
        from pydub import AudioSegment
    except ImportError as e:
        raise RuntimeError(
            "pydub missing — pip install pydub (and ensure ffmpeg on PATH)"
        ) from e

    client = OpenAI(api_key=api_key)
    sections = script.get("sections") or []

    # Flatten all turns with the section they came from so we can insert
    # the right inter-segment gaps.
    flat: list[tuple[str, dict]] = []
    for sec in sections:
        sid = sec.get("id") or "?"
        for t in (sec.get("turns") or []):
            if (t.get("text") or "").strip():
                flat.append((sid, t))

    total = len(flat)
    if total == 0:
        raise ValueError("Script has no turns to synthesize")

    if on_progress:
        try: on_progress("start", 0, total, "Generating intro music…")
        except Exception: pass

    intro_path, outro_path = _ensure_stings()
    intro = AudioSegment.from_file(intro_path, format="mp3")
    outro = AudioSegment.from_file(outro_path, format="mp3")

    # Synthesize each turn → AudioSegment
    segs: list[AudioSegment] = []
    prev_section: str | None = None
    for i, (sid, turn) in enumerate(flat, start=1):
        sp = (turn.get("speaker") or "alec").lower()
        text = (turn.get("text") or "").strip()
        intensity = (turn.get("intensity") or "normal").lower()
        if on_progress:
            try: on_progress("turn", i, total,
                             f"{sp.upper()} ({intensity}) · {sid} · turn {i}/{total}")
            except Exception: pass
        mp3_bytes = _tts_turn(client, sp, text, intensity, model=tts_model)
        seg = AudioSegment.from_file(io.BytesIO(mp3_bytes), format="mp3")
        # Inter-turn gap depends on whether we're crossing a section boundary
        if prev_section is not None:
            if sid == "verdict" and prev_section != "verdict":
                gap = GAP_BEFORE_VERDICT
            elif sid != prev_section:
                gap = GAP_BETWEEN_SECTIONS
            else:
                gap = GAP_INTRA_SECTION
            segs.append(AudioSegment.silent(duration=gap))
        segs.append(seg)
        prev_section = sid

    if on_progress:
        try: on_progress("stitch", total, total, "Stitching audio + music bumpers…")
        except Exception: pass

    # Build final timeline
    body = sum(segs, AudioSegment.silent(duration=0))
    # Cross-fade body in/out for a smoother transition from intro/outro music
    body = body.fade_in(60)
    full = intro + AudioSegment.silent(duration=350) + body + \
           AudioSegment.silent(duration=400) + outro
    full = full.normalize(headroom=1.5)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    full.export(out_path, format="mp3", bitrate="128k",
                tags={
                    "title":  script.get("episode_title") or script.get("ticker") or "DGA HiTech",
                    "artist": "DGA HiTech Podcast",
                    "album":  "DGA HiTech Podcast",
                    "genre":  "Business",
                })

    duration_sec = len(full) / 1000.0
    return {
        "ok":            True,
        "duration_sec":  round(duration_sec, 1),
        "turn_count":    total,
        "out_path":      str(out_path),
        "bytes":         out_path.stat().st_size,
        "voice_map":     dict(VOICE_MAP),
        "tts_model":     tts_model,
    }


def estimate_tts_cost(script: dict[str, Any], model: str = TTS_MODEL_DEFAULT) -> dict[str, Any]:
    """Estimate OpenAI TTS cost for an episode (so the UI can warn before spend).

    Pricing (May 2026, OpenAI):
      • tts-1       — $15 / 1M chars
      • tts-1-hd    — $30 / 1M chars
      • gpt-4o-mini-tts — $0.60 / 1M chars
    """
    rates_per_million = {
        "tts-1":            15.0,
        "tts-1-hd":         30.0,
        "gpt-4o-mini-tts":   0.60,
    }
    rate = rates_per_million.get(model, 30.0)
    chars = 0
    for sec in script.get("sections") or []:
        for t in sec.get("turns") or []:
            chars += len((t.get("text") or ""))
    cost = (chars / 1_000_000) * rate
    return {"chars": chars, "model": model, "rate_per_million_usd": rate,
            "estimated_usd": round(cost, 4)}


# ════════════════════════════════════════════════════════════════════════
# Pretty-print helpers (for the UI / CLI)
# ════════════════════════════════════════════════════════════════════════

def script_to_transcript(script: dict[str, Any]) -> str:
    """Render a validated script as a plain-text transcript for previewing."""
    out: list[str] = []
    out.append(f"# {script.get('episode_title', script.get('ticker', '?'))}")
    out.append(f"_Winner: **{script.get('winner', '?').upper()}**_\n")
    for sec in script.get("sections") or []:
        sid = sec.get("id", "?").replace("_", " ").title()
        out.append(f"\n## {sid}\n")
        for t in sec.get("turns") or []:
            sp = (t.get("speaker") or "?").upper()
            intensity = t.get("intensity") or "normal"
            tag = "" if intensity == "normal" else f" _({intensity})_"
            out.append(f"**{sp}**{tag}: {t.get('text', '')}\n")
    return "\n".join(out)
