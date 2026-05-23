"""DGA HiTech Podcast — engine.

v0 scope (this file): script generation only.
  • generate_script(ticker, grok_md, claude_md) → validated JSON
  • Strict structure (cold open → company-in-60 → opening pitches →
    4 rounds incl steelman → verdict)
  • Word budget ~1400–1800 for an 8–10 min episode
  • Cursing whitelist + per-episode cap (≤5)
  • Per-turn `intensity` ∈ {calm, normal, heated} → maps to TTS speed in v1

Cast / voice map (locked):
    Alex   (host)            → OpenAI 'fable'
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
    # Re-cast after user feedback (ui132):
    #   • "alec" → "alex" + female host voice
    #   • Rock=onyx sounded depressed in long-form → switched to echo
    #     (warm, conversational, can carry energy)
    #   • Claude moved to fable (British storyteller — dry-wit measured
    #     analyst voice; better than echo at sounding skeptical)
    "alex":   "shimmer",  # host (female)
    "rock":   "echo",     # Grok analyst
    "claude": "fable",    # Claude analyst
}

# Whitelisted curse words. Anything outside this set in the LLM output
# gets flagged in validation (and the generator can be re-rolled).
CURSE_WHITELIST = {
    "damn", "damned", "hell", "shit", "shitty", "fuck", "fucking",
    "bullshit", "fucked",
}
MAX_CURSES_PER_EPISODE = 10  # ui132: bumped from 5 — user wanted more punch

# Intensity → playback speed (used by v1 TTS layer)
INTENSITY_SPEED = {"calm": 0.95, "normal": 1.0, "heated": 1.10}

VALID_SPEAKERS = {"alex", "rock", "claude"}
VALID_INTENSITY = set(INTENSITY_SPEED)

# Section ids the LLM MUST produce in order.
REQUIRED_SECTIONS = [
    "cold_open",            # Alex, ~15s
    "company_in_60",        # Alex, ~60s
    "opening_pitch_rock",   # Rock, ~60s
    "opening_pitch_claude", # Claude, ~60s
    "round_thesis",         # debate, ~90s
    "round_valuation",      # debate, ~90s
    "round_catalysts",      # debate, ~90s
    "round_steelman",       # each defends the OTHER's case, ~60s
    "verdict",              # Alex names a winner, ~45s
]


# ════════════════════════════════════════════════════════════════════════
# Prompting
# ════════════════════════════════════════════════════════════════════════

def _system_prompt() -> str:
    return """You are the producer-writer for the DGA HiTech Podcast — a fast-paced \
investment debate show in the style of Animal Spirits (banter, interruptions, \
strong opinions). Each episode debates ONE public company.

CAST (the three speakers, never invent a fourth):
  • Alex   — host. FEMALE. Sharp, even-keeled, calls bullshit on either side. \
Sets up the company, runs the rounds, names a winner at the end. \
Does NOT take a side until the verdict.
  • Rock   — analyst. Punchy, contrarian, momentum + narrative lean. \
Higher conviction. Energetic — speeds up when selling upside, gets \
loud when defending. Cusses regularly when something is dumb or \
exciting. Powered by Grok.
  • Claude — analyst. Measured, valuation-disciplined, base-rates guy. \
Drier wit, skeptic tilt. Cusses occasionally for emphasis on real risk. \
Powered by Claude.

TONE & HUMAN FEEL
  • Animal Spirits pacing — vary turn lengths constantly. Some long pitches, \
some 4-word reactions ("That's nuts." / "Show me the cash flow."). \
Mix it up — never two consecutive turns of similar length.
  • Real human filler is encouraged, sparingly — sprinkle in things like \
"um", "uh", "y'know", "I mean", "look,", "honestly,", "right,", "hmm". \
Use these for naturalness, NOT in every turn — maybe 1 in 4. \
Especially good when a speaker is thinking mid-sentence or pivoting.
  • Interruptions render as a single line ending in em-dash: \
"Hold on — that math doesn't —" then the other speaker cuts in on the next turn.
  • Heated mid-episode (valuation + catalysts), calmer at intro + verdict.
  • Cursing is allowed and ENCOURAGED for punch — up to 10 instances per \
episode, only from {damn, damned, hell, shit, shitty, fuck, fucking, \
fucked, bullshit}. Don't be precious about it — when Rock or Claude \
genuinely think something is dumb or risky, let them say so with bite. \
Rock should drop one or two in his opening pitch. Never any other \
profanity, slurs, or brand-unsafe content.
  • DO NOT fall into a metronomic A-B-A-B pattern. Mix it up: sometimes \
Alex chimes in mid-round, sometimes one analyst gets 2 turns in a row \
landing a point, sometimes a single-word reaction breaks the rhythm.

STRUCTURE (you MUST produce these sections in this order, each as a list of turns):
  1. cold_open            — Alex only, 1 turn, ~35–45 words. One-line hook + name ticker.
  2. company_in_60        — Alex only, 1 turn, ~120–150 words. Plain-English: what the company does, why we care today.
  3. opening_pitch_rock   — Rock only, 1 turn, ~140–170 words. Bull/bear stance + specific price target.
  4. opening_pitch_claude — Claude only, 1 turn, ~140–170 words. Bull/bear stance + specific price target.
  5. round_thesis         — 4–6 turns alternating, mostly Rock + Claude, with Alex injecting 1–2 follow-ups.
  6. round_valuation      — 4–6 turns. THIS IS THE HOTTEST ROUND — multiples, comps, peer math, target math. Mark turns intensity=heated.
  7. round_catalysts      — 4–6 turns. Near-term catalysts, risks, what could break the thesis.
  8. round_steelman       — exactly 2 turns: Rock argues Claude's bear case in his own words, then Claude argues Rock's bull case. 60–80 words each.
  9. verdict              — Alex only, 1–2 turns, ~110–140 words. Must explicitly say \
"the more convincing pitch tonight was Rock" or "...was Claude" and give 2 specific reasons \
drawn from THE DEBATE (not from the reports). No ties, no cop-outs.

TOTAL WORD COUNT TARGET: 1,400–1,800 words across all sections combined. \
This produces an 8–10 min episode at conversational TTS pacing. \
If the source reports are thin, CUT length — do not pad with filler.

PER-TURN FIELDS (every turn is an object with exactly these keys):
  • "speaker"   ∈ "alex" | "rock" | "claude"
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

The "winner" field MUST match whoever Alex names in the verdict section.

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
  • Alex names a winner with 2 specific reasons drawn from THE DEBATE
  • "winner" field at the top must match Alex's verdict
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
            non_alec = [t for t in turns if (t.get("speaker") or "").lower() != "alex"]
            if non_alec:
                errors.append(f"{sid} should be Alex only — found {len(non_alec)} other speakers")
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
# v2 stings (Succession-vibe, 5s each). Different filenames so the old
# 3s/2s files don't get re-served from cache after the upgrade.
INTRO_STING_PATH = _STING_DIR / "intro_v2_succession_5s.mp3"
OUTRO_STING_PATH = _STING_DIR / "outro_v2_succession_5s.mp3"


def _ensure_stings() -> tuple[Path, Path]:
    """Generate brand intro/outro music stings (5 sec each).

    v2 style: Succession-inspired — F minor key, piano-like timbre via
    summed harmonics, melancholy-but-elegant tension chord progression.

    INTRO (5s): low Db pad swells → minor piano chord stab → melodic
                motif (Ab→C→Db→C, the Db5 is the tension note) → sustained
                Fm ringout under the host's first words.
    OUTRO (5s): descending walk-down C5→Ab4→F4→C4→F3 over a held F2 pad,
                resolving to silence.

    Cached to disk after first generation. Delete the files to regenerate.
    """
    _STING_DIR.mkdir(parents=True, exist_ok=True)
    if INTRO_STING_PATH.exists() and OUTRO_STING_PATH.exists():
        return INTRO_STING_PATH, OUTRO_STING_PATH

    from pydub import AudioSegment
    from pydub.generators import Sine

    # ── Piano-like timbre via harmonic stacking ──────────────────────
    # Real piano: 1× fundamental + 2× at -7dB + 3× at -14dB + 4× at -20dB
    # gives a tone that the ear reads as "struck string" not "sine beep".
    def _piano(freq: float, ms: int, gain_db: float = -8.0) -> AudioSegment:
        layers = [
            (1.0,  0.0),
            (2.0, -7.0),
            (3.0, -14.0),
            (4.0, -20.0),
            (5.0, -28.0),
        ]
        out = AudioSegment.silent(duration=ms)
        for ratio, db in layers:
            tone = Sine(freq * ratio).to_audio_segment(duration=ms)
            out = out.overlay(tone.apply_gain(db + gain_db))
        # Piano envelope: sharp attack (8ms) + long linear decay
        attack = min(15, ms // 30)
        decay  = max(ms - attack - 5, ms // 2)
        return out.fade_in(attack).fade_out(decay)

    # ── String-like sustained pad (slightly detuned doubled sine) ────
    def _pad(freq: float, ms: int, gain_db: float = -22.0) -> AudioSegment:
        a = Sine(freq).to_audio_segment(duration=ms)
        b = Sine(freq * 1.0035).to_audio_segment(duration=ms)  # chorus detune
        c = Sine(freq * 2).to_audio_segment(duration=ms)
        pad = (a.apply_gain(gain_db)
               .overlay(b.apply_gain(gain_db - 3))
               .overlay(c.apply_gain(gain_db - 10)))
        fade = ms // 3
        return pad.fade_in(fade).fade_out(fade)

    # F minor scale notes (Succession-ish key signature)
    F2, F3, Ab3, C4, Db4, F4, Ab4, C5, Db5 = (
        87.31, 174.61, 207.65, 261.63, 277.18, 349.23, 415.30, 523.25, 554.37
    )

    # ── INTRO (5s): brooding piano + low pad ─────────────────────────
    intro = AudioSegment.silent(duration=5000)
    intro = intro.overlay(_pad(F2, 5000, gain_db=-20))            # held low pad
    intro = intro.overlay(_pad(C4, 4800, gain_db=-30), position=200)  # mid pad
    # Opening Fm chord stab @ 200ms (F-Ab-C minor triad)
    intro = intro.overlay(_piano(F3,  3800, -7),  position=200)
    intro = intro.overlay(_piano(Ab3, 3800, -8),  position=200)
    intro = intro.overlay(_piano(C4,  3800, -9),  position=200)
    # Melodic motif w/ tension — Ab4 → C5 → Db5 (the dread note) → resolve to C5
    intro = intro.overlay(_piano(Ab4,  900, -8),  position=1500)
    intro = intro.overlay(_piano(C5,   900, -8),  position=2200)
    intro = intro.overlay(_piano(Db5,  900, -7),  position=2900)
    intro = intro.overlay(_piano(C5,  2000, -8),  position=3700)
    # Final ringout — Fm chord sustained under host's cold open
    intro = intro.overlay(_piano(F4,  1300, -9),  position=3700)
    intro = intro.overlay(_piano(Ab4, 1300, -10), position=3700)
    intro = intro.fade_out(400).normalize(headroom=1.5)
    intro.export(INTRO_STING_PATH, format="mp3", bitrate="128k")

    # ── OUTRO (5s): descending resolve ───────────────────────────────
    outro = AudioSegment.silent(duration=5000)
    outro = outro.overlay(_pad(F2, 5000, gain_db=-22))
    # Walking descent: C5 → Ab4 → F4 → C4 → F3, slowing as it falls
    outro = outro.overlay(_piano(C5,   800, -7),  position=200)
    outro = outro.overlay(_piano(Ab4,  900, -8),  position=900)
    outro = outro.overlay(_piano(F4,  1100, -9),  position=1700)
    outro = outro.overlay(_piano(C4,  1500, -10), position=2700)
    outro = outro.overlay(_piano(F3,  2000, -10), position=3500)
    # Final low resting tone under the fade
    outro = outro.overlay(_piano(F2, 1500, -12), position=3500)
    outro = outro.fade_out(700).normalize(headroom=1.5)
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
        sp = (turn.get("speaker") or "alex").lower()
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
            # ui132: jitter each gap ±25% so transitions don't feel
            # metronomic. User feedback: "transitions get monotonous".
            import random as _r
            if sid == "verdict" and prev_section != "verdict":
                gap = GAP_BEFORE_VERDICT + _r.randint(-120, 200)
            elif sid != prev_section:
                gap = GAP_BETWEEN_SECTIONS + _r.randint(-110, 180)
            else:
                gap = GAP_INTRA_SECTION + _r.randint(-70, 110)
                # 1-in-6 chance of an extra micro-beat (160ms) for
                # natural mid-section "let that land" feel
                if _r.random() < 0.16:
                    gap += 160
            segs.append(AudioSegment.silent(duration=max(80, gap)))
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
