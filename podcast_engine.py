"""DGA HiTech Podcast — engine.

v0 scope (this file): script generation only.
  • generate_script(ticker, grok_md, claude_md) → validated JSON
  • Strict structure (cold open → company-in-60 → opening pitches →
    4 rounds incl steelman → verdict)
  • Word budget ~1400–1800 for an 8–10 min episode
  • Cursing whitelist + per-episode cap (≤5)
  • Per-turn `intensity` ∈ {calm, normal, heated} → maps to TTS speed in v1

Cast / voice map (locked):
    Opus   (host)            → OpenAI 'fable'
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
    # ui134 cast:
    #   • Opus    — host, male       → onyx  (deep moderator gravitas)
    #   • Rock    — Grok analyst, British male → fable (storyteller cadence,
    #                                            dry wit, can punch up)
    #   • Claudia — Claude analyst, female → nova  (bright, energetic;
    #                                              carries skeptical bite
    #                                              without sounding flat)
    "opus":    "onyx",
    "rock":    "fable",
    "claudia": "nova",
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

# Per-speaker baseline speed offset (multiplied with INTENSITY_SPEED).
# Lets us brighten/calm individual voices without changing intensity logic.
#   • Opus (onyx) skews somber at 1.0× — +6% makes him noticeably more
#     upbeat without rushing the moderator role.
SPEAKER_SPEED_OFFSET = {
    "opus":    1.06,   # bump for energy (onyx can sound flat at 1.0)
    "rock":    1.00,
    "claudia": 1.00,
}
# OpenAI TTS hard limits — clamp so we never send an out-of-range speed.
SPEED_MIN, SPEED_MAX = 0.85, 1.20

# Mutable runtime overrides — populated by load_speed_overrides() right
# before each TTS run from kv_store key 'podcast.speed_config'. UI-editable
# table replaces hard-coded baselines.
_RUNTIME_INTENSITY  = dict(INTENSITY_SPEED)
_RUNTIME_SPEAKER    = dict(SPEAKER_SPEED_OFFSET)
_RUNTIME_VOICE_MAP  = dict(VOICE_MAP)

# Valid OpenAI TTS voices for the tts-1 / tts-1-hd models we use.
# Empirically tested via the API error response — these 8 are what
# tts-1-hd accepts. 'ballad', 'coral', and 'verse' are gpt-4o-mini-tts
# only and return HTTP 400 from tts-1-hd despite what some docs imply.
AVAILABLE_VOICES = ["alloy", "ash", "echo", "fable",
                    "nova", "onyx", "sage", "shimmer"]


def get_speed_config() -> dict:
    """Return the current effective speed config (runtime overrides applied)."""
    return {
        "intensity": dict(_RUNTIME_INTENSITY),
        "speaker":   dict(_RUNTIME_SPEAKER),
        "voices":    dict(_RUNTIME_VOICE_MAP),
        "min":       SPEED_MIN,
        "max":       SPEED_MAX,
    }


def get_voice_config() -> dict:
    """Return the current voice assignments + available voices for the UI."""
    return {
        "voices":    dict(_RUNTIME_VOICE_MAP),
        "available": list(AVAILABLE_VOICES),
    }


def apply_voice_overrides(voices: dict | None = None):
    """Apply user-edited voice picks. Ignores unknown voices AND reverts
    any currently-loaded voice that's no longer in AVAILABLE_VOICES back
    to the engine default (so a previously-saved-but-now-removed voice
    like 'verse' can't crash future TTS calls)."""
    if voices:
        for speaker_key, v in voices.items():
            v = (v or "").lower()
            if speaker_key in _RUNTIME_VOICE_MAP and v in AVAILABLE_VOICES:
                _RUNTIME_VOICE_MAP[speaker_key] = v
    # Sweep: if any runtime voice is now invalid (e.g., we removed it from
    # AVAILABLE_VOICES in a later build), revert to engine default.
    for sp_key, cur in list(_RUNTIME_VOICE_MAP.items()):
        if cur not in AVAILABLE_VOICES:
            _RUNTIME_VOICE_MAP[sp_key] = VOICE_MAP.get(sp_key, "alloy")


def apply_speed_overrides(intensity: dict | None = None, speaker: dict | None = None):
    """Apply user-edited overrides on top of the defaults.

    Anything passed is merged in; anything omitted keeps its current
    runtime value. Out-of-range numbers are clamped.
    """
    if intensity:
        for k, v in intensity.items():
            try:
                vf = float(v)
                if k in _RUNTIME_INTENSITY and SPEED_MIN <= vf <= SPEED_MAX:
                    _RUNTIME_INTENSITY[k] = vf
            except (TypeError, ValueError):
                pass
    if speaker:
        for k, v in speaker.items():
            try:
                vf = float(v)
                if k in _RUNTIME_SPEAKER and SPEED_MIN <= vf <= SPEED_MAX:
                    _RUNTIME_SPEAKER[k] = vf
            except (TypeError, ValueError):
                pass

VALID_SPEAKERS = {"opus", "rock", "claudia"}
VALID_INTENSITY = set(INTENSITY_SPEED)

# Section ids the LLM MUST produce in order.
# ════════════════════════════════════════════════════════════════════════
# Episode FORMATS — orthogonal to episode_mode (which controls TONE/ROLES).
# format controls STRUCTURE: what sections exist, how long, who speaks.
#
# Default format is "debate" (the original Bull vs Bear show). Each other
# format swaps in a different REQUIRED_SECTIONS list + system+user prompt.
# Dynamic role assignment (Bull/Bear seats based on report aggression)
# still applies on top — formats are STRUCTURE, modes are ROLES.
# ════════════════════════════════════════════════════════════════════════

EPISODE_FORMATS = {
    "debate": {
        "label":   "Debate",
        "icon":    "⚔️",
        "tagline": "Bull vs Bear, with a verdict",
        "multi_ticker":     False,
        "word_budget_low":  1400,
        "word_budget_high": 1800,
        "approx_minutes":   "8-10",
        "title_pattern":    "{TICKER}: Bull vs Bear",
    },
    "pre_mortem": {
        "label":   "Pre-Mortem",
        "icon":    "🪦",
        "tagline": "It's 2 years from now. The stock collapsed. What killed it?",
        "multi_ticker":     False,
        "word_budget_low":  1300,
        "word_budget_high": 1700,
        "approx_minutes":   "8-10",
        "title_pattern":    "{TICKER}: The Pre-Mortem",
    },
    "memo": {
        "label":   "Investment Memo",
        "icon":    "📋",
        "tagline": "IC-style walk-through — exec summary, thesis, valuation, risks, rec",
        "multi_ticker":     False,
        "word_budget_low":  1500,
        "word_budget_high": 1900,
        "approx_minutes":   "9-11",
        "title_pattern":    "{TICKER}: Investment Memo",
    },
    "catalysts": {
        "label":   "Catalysts Calendar",
        "icon":    "📅",
        "tagline": "12 months of catalysts ranked + the one trade that matters",
        "multi_ticker":     False,
        "word_budget_low":  1400,
        "word_budget_high": 1800,
        "approx_minutes":   "8-10",
        "title_pattern":    "{TICKER}: 12-Month Catalysts",
    },
    "quick_hit": {
        "label":   "Quick Hit",
        "icon":    "⚡",
        "tagline": "5-min sharp summary — one take from each, then verdict",
        "multi_ticker":     False,
        "word_budget_low":  600,
        "word_budget_high": 900,
        "approx_minutes":   "4-5",
        "title_pattern":    "{TICKER}: Quick Hit",
    },
    "roundup": {
        "label":   "Roundup",
        "icon":    "📰",
        "tagline": "3-4 tickers in one episode — quick takes + cross-name sector wrap",
        "multi_ticker":     True,
        "word_budget_low":  1200,
        "word_budget_high": 1600,
        "approx_minutes":   "7-9",
        "title_pattern":    "Roundup: {TICKERS}",
    },
    "portfolio_roundup": {
        "label":   "Portfolio Roundup",
        "icon":    "🧰",
        "tagline": "PM-style review of your whole book — risks, blind spots, bolt-ons, the one move this week",
        "multi_ticker":     True,
        # Budget below is a FALLBACK only. The generator computes a dynamic
        # budget based on ticker count via _portfolio_roundup_budget() and
        # injects that into the user prompt at generation time.
        "word_budget_low":  1500,
        "word_budget_high": 3500,
        "approx_minutes":   "10-22 (scales with ticker count)",
        "title_pattern":    "Portfolio Roundup · {TICKERS}",
    },
}


def _portfolio_roundup_budget(n_tickers: int) -> dict:
    """Dynamic word + minute budget for Portfolio Roundup.

    Formula: base (1500w) + per-ticker (95w). 95w ≈ 35 sec of dialogue —
    enough for one analyst to land a real point on each name, with bigger
    positions naturally pulling more.

      5 tickers  → ~1,975w  ≈ 12 min
     10 tickers  → ~2,450w  ≈ 15 min
     15 tickers  → ~2,925w  ≈ 18 min
     20 tickers  → ~3,400w  ≈ 20 min
    """
    base, per = 1500, 95
    target = base + n_tickers * per
    lo, hi = int(target * 0.92), int(target * 1.12)
    minutes = round(target / 165, 0)   # ~165 wpm conversational TTS
    return {"low": lo, "high": hi, "target": target, "minutes": minutes}

# Per-format required-sections lists. Validator and renderers consult these.
FORMAT_SECTIONS = {
    "debate": [
        "cold_open", "company_in_60",
        "opening_pitch_rock", "opening_pitch_claudia",
        "round_thesis", "round_valuation", "round_catalysts", "round_steelman",
        "verdict",
    ],
    "pre_mortem": [
        "cold_open",                # Opus: hook — "It's 2027. Stock down 60%."
        "scenario_setup",           # Opus: paints the failed state in detail
        "rock_failure_path",        # Rock: how he sees the collapse happening
        "claudia_failure_path",     # Claudia: her version of the collapse
        "round_root_causes",        # debate: 3-4 root causes argued + ranked
        "round_pattern",            # both: which historical analogue fits (Cisco '00? Teva '17?)
        "underpriced_risk",         # both: which failure path is most under-priced by current bulls
        "verdict",                  # Opus: highest-conviction failure path + what would falsify the bull case
    ],
    "memo": [
        "cold_open",                # Opus: ~30 words, hook + ticker
        "executive_summary",        # Opus: rating, target, 3-sentence thesis
        "business_overview",        # Opus: what the company does, segments, drivers
        "bull_thesis",              # Rock: top 3 bull points (his report)
        "bear_thesis",              # Claudia: top 3 bear points
        "valuation_section",        # mixed: multiples, comps, what's priced in
        "catalysts_and_risks",      # mixed: near-term catalysts + key risks
        "recommendation",           # Opus: action with sizing, time horizon, stop level
    ],
    "catalysts": [
        "cold_open",                # Opus: "Tonight: 12 months of catalysts, ranked"
        "setup_quarter",            # Opus: where we are now
        "catalyst_1",               # debate: nearest event (earnings, product, FDA)
        "catalyst_2",               # debate: ~3 months out
        "catalyst_3",               # debate: ~6 months out
        "catalyst_4",               # debate: ~12 months out
        "wildcard",                 # debate: low probability / high impact
        "ranking",                  # Opus + both: rank by importance × probability
        "verdict",                  # Opus: which catalyst is the actual trade
    ],
    "quick_hit": [
        "cold_open",                # Opus: 1 turn, ~30 words
        "company_one_breath",       # Opus: 1 turn, ~60 words
        "rock_take",                # Rock: 1 turn, ~80 words
        "claudia_take",             # Claudia: 1 turn, ~80 words
        "single_round",             # mixed: 3-4 turn debate
        "verdict",                  # Opus: 1 turn, ~80 words
    ],
    # Roundup sections are generated dynamically based on ticker list
    # (cold_open + per-ticker segments + wrap). Validator handles it
    # via the multi_ticker flag and a relaxed section check.
    "roundup": [
        "cold_open",
        # "ticker_1_intro", "ticker_1_take", "ticker_1_rebuttal", ... (dynamic)
        "wrap",
    ],
    "portfolio_roundup": [
        "cold_open",
        "portfolio_snapshot",
        "macro_setup",
        "position_walk",
        "concentration_risks",
        "wipeout_scenarios",
        "correlation_blind_spots",
        "bolt_ons",
        "cuts",
        "pm_verdict",
    ],
}

# Backward-compat alias for any legacy code still importing REQUIRED_SECTIONS.
REQUIRED_SECTIONS = FORMAT_SECTIONS["debate"]


# ════════════════════════════════════════════════════════════════════════
# Prompting
# ════════════════════════════════════════════════════════════════════════

def _system_prompt(format: str = "debate") -> str:
    """Return the system prompt for the requested format.

    All formats share the CAST + TONE + CURSING + FACTUAL guardrails
    common base, then layer a format-specific STRUCTURE block on top.
    """
    base = _system_prompt_common()
    addendum = _format_addendum(format)
    return base + "\n\n" + addendum


def _system_prompt_common() -> str:
    """Shared base — cast, tone, cursing, factual guardrails, per-turn rules.
    Format-specific STRUCTURE + OUTPUT shape are appended by _format_addendum()."""
    return """You are the producer-writer for the DGA HiTech Podcast — a fast-paced \
investment show. Each episode covers ONE public company unless told otherwise.

CAST (the three speakers, never invent a fourth):
  • Opus    — host. MALE. Sharp, even-keeled, calls bullshit on either side. \
Sets up the company, runs the rounds, names a winner at the end. \
Does NOT take a side until the verdict. Speaks American English. \
IMPORTANT: refer to the host ONLY as "Opus" — never invent a last name. \
He has no surname in the show. "I'm Opus" / "Opus here" / never "Opus [anything]".
  • Rock    — analyst. BRITISH MALE — speaks with light British inflection \
(occasional "right then", "bloody", "look here", "mate", "lot of rubbish", \
"spot on"). Punchy contrarian, momentum + narrative lean. Higher conviction. \
Dry British wit, but can get FIERY when defending the thesis — gets loud, \
swears regularly when something is dumb or exciting. The Britishness is \
flavor, NOT a caricature: a sentence or two per turn, not every line. \
Powered by Grok.
  • Claudia — analyst. FEMALE. Measured, valuation-disciplined, base-rates \
person. Drier wit, skeptic tilt. Confident — not soft-spoken. Cusses \
occasionally for emphasis on real risk. Speaks American English. \
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
fucked, bullshit}. Don't be precious about it — when Rock or Claudia \
genuinely thinks something is dumb or risky, let them say so with bite. \
Rock should drop one or two in his opening pitch. Never any other \
profanity, slurs, or brand-unsafe content.
  • DO NOT fall into a metronomic A-B-A-B pattern. Mix it up: sometimes \
Opus chimes in mid-round, sometimes one analyst gets 2 turns in a row \
landing a point, sometimes a single-word reaction breaks the rhythm.

FACTUAL GUARDRAILS — read this twice. The reports below contain real \
numbers; if you misstate them, the show loses credibility.
  • NEVER conflate a PRICE move with an EARNINGS move with a REVENUE move. \
These are three different things. If a report says "EPS collapsed 90% \
YoY" that is NOT the same as "the stock collapsed 90%". If you say a \
percentage decline, the SENTENCE MUST identify what fell: \
    "the stock is down 35% YTD" \
    "EPS is down 90% YoY" \
    "revenue contracted 8% in Q3" \
  Never just "the price collapsed 90%" when the report only described an \
  earnings collapse — that's a fireable factual error.
  • If a number you want to cite ISN'T in the source reports, DON'T invent \
one. Either pull a different real number, or say it qualitatively \
("the multiple's stretched" instead of "trades at 47x"). \
HALLUCINATED NUMBERS are worse than no numbers.
  • Price targets, ratings, and upside %s come from the reports' headers — \
use those directly (don't round into uglier numbers).
  • If the two reports cite DIFFERENT numbers for the same thing (different \
revenue forecast, different price target), pick the one whose report you're \
representing — Rock cites Rock's number, Claudia cites Claudia's. They can \
explicitly call out the discrepancy ("you've got revenue at $12B, I've got \
$10B — where's the spread coming from?").

COLD OPEN VARIETY — applies to every format
  CRITICAL — vary the SHAPE of the cold open episode-to-episode. DO NOT start
  every episode with "Welcome back to the DGA HiTech Podcast, I'm Opus, and
  tonight..." That pattern gets monotonous instantly. Pick a DIFFERENT structure
  for each episode, rotating freely between forms like:
    • Data shock, Question, News tease, Contrarian, Cold fact, Direct quote,
      Personal beat, Sector frame.
  The host should NAME the ticker, but welcome/show-name boilerplate is OPTIONAL.

PER-TURN FIELDS (every turn is an object with exactly these keys):
  • "speaker"   ∈ "opus" | "rock" | "claudia"
  • "text"      — plain prose. No markdown / asterisks / bullets. Natural
                  contractions. For an interruption, end the line with " —"
  • "intensity" ∈ "calm" | "normal" | "heated"

DO NOT include any text outside the JSON. DO NOT use markdown code fences.
DO NOT invent a fourth speaker.

[FORMAT-SPECIFIC STRUCTURE + OUTPUT SHAPE FOLLOW BELOW]
"""


def _format_addendum(format: str) -> str:
    """Per-format STRUCTURE block + word budget + OUTPUT shape."""
    fmt = EPISODE_FORMATS.get(format)
    if not fmt:
        return _format_addendum("debate")
    sections = FORMAT_SECTIONS.get(format, [])
    wb_lo, wb_hi = fmt["word_budget_low"], fmt["word_budget_high"]
    minutes = fmt["approx_minutes"]

    if format == "debate":
        structure = """STRUCTURE — produce these sections IN ORDER, each as a list of turns:
  1. cold_open            — Opus only, ~35–45 words. ONE-LINE hook + ticker.
  2. company_in_60        — Opus only, ~120–150 words. Plain-English what the company does.
  3. opening_pitch_rock   — Rock only, ~140–170 words. Bull/bear stance + specific price target.
  4. opening_pitch_claudia — Claudia only, ~140–170 words. Bull/bear stance + specific price target.
  5. round_thesis         — 4–6 turns, mostly Rock + Claudia, Opus 1–2 follow-ups.
  6. round_valuation      — 4–6 turns. HOTTEST round — multiples, comps, target math. intensity=heated.
  7. round_catalysts      — 4–6 turns. Near-term catalysts + risks.
  8. round_steelman       — EXACTLY 2 turns: Rock argues Claudia's bear case, then vice versa. 60–80 words each.
  9. verdict              — Opus only, 1–2 turns, ~110–140 words. Must say "the more convincing pitch tonight was Rock" or "...was Claudia" with 2 specific reasons from THE DEBATE. No ties."""
        winner_field = '  "winner": "rock" | "claudia",\n'

    elif format == "pre_mortem":
        structure = """STRUCTURE — Pre-Mortem format. Frame: it's 2 years from now, the stock is down 60%+, you're doing the autopsy.

  1. cold_open            — Opus only, ~35–50 words. Hook MUST establish: "It's [year + 2]. {TICKER} is down [60-80]%. What killed it?"
  2. scenario_setup       — Opus only, ~130–160 words. Paint the failed state in vivid detail: stock price, what the news headlines look like, who got fired, what the bulls now say in hindsight.
  3. rock_failure_path    — Rock only, ~150–180 words. His specific theory of the collapse — must cite REAL risk factors from the source reports + the DA brief if present.
  4. claudia_failure_path — Claudia only, ~150–180 words. Her DIFFERENT theory of the collapse (different root cause, not just more pessimistic).
  5. round_root_causes    — 5–7 turns. Debate which 3 root causes are most LIKELY (not most catastrophic). Both speakers must agree on 1 surprising cause they hadn't considered until this conversation.
  6. round_pattern        — 3–4 turns. Which historical analogue does this most resemble? (Cisco 2000? Teva 2017? Peloton 2022? Valeant 2015? GE 2018?) Argue + pick.
  7. underpriced_risk     — 3–4 turns. Of all the failure paths discussed, which is MOST under-priced by current bulls? Both speakers vote.
  8. verdict              — Opus only, 1–2 turns, ~120–150 words. Names the HIGHEST-CONVICTION failure path + one falsification test ("if X happens within 6 months, the bears are wrong")."""
        winner_field = '  "winner": "rock" | "claudia",  // whoever Opus names as having the most-likely failure thesis\n'

    elif format == "memo":
        structure = """STRUCTURE — Investment Memo Walk-Through. Treat this like a real IC presentation: structured, sober, conclusive.

  1. cold_open            — Opus only, ~30–45 words. Crisp hook + ticker + rating preview.
  2. executive_summary    — Opus only, ~130–160 words. Rating, 12-mo target, 3-sentence thesis, sizing recommendation.
  3. business_overview    — Opus only, ~160–200 words. Segments, key drivers, customer base, geographic mix.
  4. bull_thesis          — Rock only, ~230–280 words. Top 3 bull points with supporting data from his report.
  5. bear_thesis          — Claudia only, ~230–280 words. Top 3 bear points with supporting data from her report.
  6. valuation_section    — 4–6 mixed turns. Multiples, comps, sum-of-parts if relevant, what's priced in / what's not. Cite real numbers.
  7. catalysts_and_risks  — 4–6 mixed turns. Near-term catalysts (next 6 mo) + top 3 risks ranked by likelihood × severity.
  8. recommendation       — Opus only, 1–2 turns, ~140–170 words. Action with: SIZING (% of book), TIME HORIZON, STOP-LOSS or hedge structure. End with "the committee recommends..." or "this analyst recommends..."

This format does NOT use a 'winner' field — it ends with a recommendation, not a debate result."""
        winner_field = '  "winner": "rock" | "claudia",  // for memo format, set to whoever Opus\'s recommendation aligns with directionally\n'

    elif format == "catalysts":
        structure = """STRUCTURE — Catalysts Calendar. Forward-looking 12-month walk through what's actually on the schedule.

  1. cold_open            — Opus only, ~30–45 words. "Tonight: 12 months of catalysts, ranked." + ticker.
  2. setup_quarter        — Opus only, ~80–110 words. Where the stock is now. Recent earnings, momentum, sentiment one-liner.
  3. catalyst_1           — 3–5 mixed turns. NEAREST event (next 30–90 days). Rock + Claudia argue: priced in or not? Long or short into it?
  4. catalyst_2           — 3–5 mixed turns. ~3 months out. Same treatment.
  5. catalyst_3           — 3–5 mixed turns. ~6 months out.
  6. catalyst_4           — 3–5 mixed turns. ~12 months out (annual investor day / refresh / regulatory cycle).
  7. wildcard             — 2–3 mixed turns. Low-probability, high-impact event (M&A, restructure, lawsuit settlement, accounting issue). Both must engage even if they think it's unlikely.
  8. ranking              — 3–5 turns. Both speakers + Opus assemble a ranked list of the 7 events by IMPORTANCE × PROBABILITY. Explicit ranking, no hedging.
  9. verdict              — Opus only, 1–2 turns, ~100–130 words. Which SINGLE catalyst is the actual trade. Specific entry timing.

Use real catalyst dates from the source reports where possible. If a date isn't stated, use "~Q2" / "late spring" — DON'T invent specific dates."""
        winner_field = '  "winner": "rock" | "claudia",  // for catalysts format, set to whoever Opus\'s "the trade" recommendation aligns with\n'

    elif format == "quick_hit":
        structure = """STRUCTURE — Quick Hit. 5-min sharp summary. No round-robin, no steelman. Just: hook → setup → one take each → short debate → verdict.

  1. cold_open            — Opus only, 1 turn, ~25–35 words. ONE punchy hook.
  2. company_one_breath   — Opus only, 1 turn, ~50–70 words. The company explained in 60 sec.
  3. rock_take            — Rock only, 1 turn, ~70–100 words. His ONE sharpest take — bull or bear, with price target.
  4. claudia_take         — Claudia only, 1 turn, ~70–100 words. Her counter-take, with target.
  5. single_round         — 3–5 mixed turns. Brief, punchy back-and-forth on the SINGLE most contested point.
  6. verdict              — Opus only, 1 turn, ~70–100 words. Calls the winner with one tight reason.

Total ~600–900 words. ~5 min episode. DO NOT pad — short is the whole point."""
        winner_field = '  "winner": "rock" | "claudia",\n'

    elif format == "portfolio_roundup":
        structure = """STRUCTURE — Portfolio Roundup. PM-style review of the WHOLE book.
This is NOT a sequence of mini-debates per ticker. This is a senior investment
committee meeting where Opus runs the show as a hands-on PM at DGA Capital.

OPUS PERSONA SHIFT — read carefully:
  For this format ONLY, Opus is NOT a neutral moderator. He's a SENIOR PM at
  DGA Capital who owns the P&L on this book. Directional, opinionated, owns
  the decisions. Use phrases like:
    "We're not comfortable with the X exposure."
    "I've been telling the team to trim Y."
    "The committee voted to add Z last Thursday."
    "What's our plan if rates rip 50bps from here?"
  He still calls a verdict at the end — but it's a PM call, not a debate winner.

ROCK + CLAUDIA in this format:
  • Rock = the analyst pushing for MORE risk / bolder positioning. He sees
    upside others miss. Will push back on Opus when Opus wants to trim.
  • Claudia = the analyst flagging risks / arguing for trims. She sees
    cracks the bulls miss. Will push back when Opus wants to add.
  Both stay in character — Rock British/punchy, Claudia measured/skeptic.

  1. cold_open            — Opus only, ~35–55 words. ONE-LINE hook the book.
        e.g. "We're 73% long tech, sitting on $4M in unrealized gain, and
              I'm starting to lose sleep. Let's go through it."
        Or: "Tonight: the book, top to bottom. What's working, what's not,
             what I'd add this week."
  2. portfolio_snapshot   — Opus only, ~160–200 words. What's in the book in
        plain English: sector mix, top 3 positions by weight, % cash,
        concentration profile. Use the position data provided. NO TICKER LIST
        DUMP — synthesize: "Top three names — NVDA, MSFT, AAPL — are 38% of
        the book. Tech is 73%. Cash is 8%."
  3. macro_setup          — Opus only, ~180–230 words. The world THIS WEEK
        as it relates to THIS book. Use the macro context block provided —
        cite specific headlines + dates. NOT generic — "rates" is bad,
        "the 10yr at 4.62% after Thursday's CPI print" is good.
  4. position_walk        — MUST cover EVERY ticker in the portfolio. This
        is the longest section by far. Average 80-100 words per ticker (a
        few sentences). Bigger positions get longer treatment (4-6 sentences),
        smaller positions get shorter (1-2 sentences) — but NO ticker is
        skipped entirely. Don't dump them ticker-by-ticker like a roll call;
        group naturally by sector / theme / risk-bucket and have Rock and
        Claudia trade takes within each group. Cite specific numbers from the
        source reports (price target, multiples, recent move) where present.
        For a 15-ticker portfolio expect ~18-22 turns in this section alone.
        For a 5-ticker portfolio expect ~8-10 turns.
  5. concentration_risks  — 4–5 turns mixed. Identify where the book is
        over-exposed (sector, factor, single name, theme). Specific numbers
        from the snapshot. Both argue intensity — Rock often defends ("the
        AI capex cycle has 2 more years"), Claudia warns ("you're 60% in
        one trade dressed up as 8 different names").
  6. wipeout_scenarios    — 4–5 turns mixed. Both name 2-3 SPECIFIC scenarios
        that would draw this book down 40%+ and assign probabilities.
        Brutally honest. "A China-Taiwan escalation puts 35% of your book
        at immediate risk." "A regional banking crisis hits BAC + C
        simultaneously." Not abstract — specific.
  7. correlation_blind_spots — 3–4 turns mixed. Where the book LOOKS
        diversified but isn't. e.g. "Your 6 tech names are all the same
        AI capex trade." "You think you have defensives but staples are
        getting margin-compressed too." Calls out the illusion of breadth.
  8. bolt_ons             — 4–6 turns mixed. Walks through the 2-3 SPECIFIC
        BOLT-ON CANDIDATES provided in the user prompt. For each: which
        analyst sponsors it, what role it plays (hedge / complement /
        rotation), where to size it. DO NOT INVENT bolt-on tickers — only
        present the ones provided.
  9. cuts                 — 3–4 turns mixed. Name 1-2 positions that should
        be trimmed/exited. Why. Be specific. Both analysts can disagree on
        a name. Opus has the final word.
 10. pm_verdict           — Opus only, 1–2 turns, ~170–220 words. The PM
        call. Are we positioned to capitalize on volatility AND protect
        downside? What's the ONE specific move this week? Sizing + entry
        + time horizon. End with a specific date for the next review."""
        winner_field = '  "winner": "rock" | "claudia",  // who landed more concrete trade ideas\n'

    elif format == "roundup":
        structure = """STRUCTURE — Roundup. Multi-ticker show covering 3-4 names in one episode.

The user_prompt will give you the list of tickers and each one's report data.
You MUST produce sections in this order (using actual section IDs as listed):

  1. cold_open                — Opus only, ~35–50 words. "Tonight: 3 names — [tickers]. Quick takes, then a wrap."
  2. For EACH ticker in order, produce 3 sections:
     {N}_intro       — Opus only, ~30–50 words. Sets up that ticker's story in one paragraph.
     {N}_take        — One analyst only (pick Rock if more bullish report exists, Claudia if more bearish), ~110–140 words. Punchy take with price target.
     {N}_rebuttal    — Other analyst, ~80–110 words. Concise counter-view.
     Replace {N} with the ticker symbol lowercased — e.g. "nvda_intro", "nvda_take", "nvda_rebuttal".
  3. wrap                    — All three voices, 3–5 turns. Cross-ticker sector takeaway. What ties these names together? What's the actionable read?

No per-ticker verdict; the wrap delivers a synthesized portfolio-level conclusion."""
        winner_field = '  "winner": "rock" | "claudia",  // for roundup, set to whichever analyst had the better overall read across the names\n'

    else:
        # Fallback — should never hit
        return _format_addendum("debate")

    # Common closing for every format
    output_shape = '{\n  "ticker": "<TICKER>",\n  "episode_title": "...",\n' + winner_field + \
        '  "sections": [\n' + \
        '    ' + ',\n    '.join(['{"id": "' + s + '", "turns": [...]}' for s in sections]) + \
        '\n  ]\n}'

    return (
        structure + "\n\n" +
        f"TOTAL WORD COUNT TARGET: {wb_lo:,}–{wb_hi:,} words (≈ {minutes} min episode).\n"
        "If source reports are thin, CUT length — do not pad with filler.\n\n"
        "OUTPUT — return ONLY valid JSON matching this shape exactly:\n\n"
        + output_shape
    )



def _user_prompt(
    ticker: str, grok_md: str, claude_md: str,
    *,
    roles: dict | None = None,
    rock_stance: dict | None = None,
    claude_stance: dict | None = None,
    da_brief: str = "",
    format: str = "debate",
) -> str:
    fmt = EPISODE_FORMATS.get(format) or EPISODE_FORMATS["debate"]
    format_intro = f"\nEPISODE FORMAT: {fmt['icon']} {fmt['label'].upper()} — {fmt['tagline']}\n"
    roles = roles or {"episode_mode": "debate", "bull_speaker": "rock", "bear_speaker": "claudia"}
    rock_stance = rock_stance or {}
    claude_stance = claude_stance or {}

    # Mode-specific framing for the writer
    mode_framing = {
        "debate": (
            "MODE: DEBATE — the reports disagree directionally. Standard format. "
            "Rock argues the bull case, Claudia the bear (or vice-versa per role "
            "assignment). Both stay in character."
        ),
        "stress_test": (
            "MODE: STRESS TEST — BOTH analysts were directionally bullish. The "
            "less-aggressive one is in the BEAR SEAT tonight, briefed with a "
            "Devil's Advocate Brief (below). This is NOT fake disagreement — "
            "they're stress-testing the consensus. The bear-seat speaker opens "
            "with: \"I came in bullish too, but...\" The episode title reflects "
            "that consensus is exactly when paranoia should be highest."
        ),
        "devils_advocate": (
            "MODE: DEVIL'S ADVOCATE — BOTH analysts were directionally bearish. "
            "The less-bearish one is in the BULL SEAT, briefed with a contrarian "
            "long case. The bull-seat speaker opens with: \"Hear me out — I know "
            "we both hated this name on the way in, but...\""
        ),
        "spread": (
            "MODE: THE SPREAD — both directionally aligned, but the magnitudes "
            "differ materially. The debate is about position sizing, time "
            "horizon, and entry — not direction. Treat the magnitude gap AS "
            "the disagreement."
        ),
        "mixed": (
            "MODE: MIXED SIGNALS — both analysts are roughly neutral. The "
            "debate centers on what catalysts would resolve the ambivalence "
            "in either direction. Use the gap_analysis section heavily."
        ),
    }
    framing = mode_framing.get(roles["episode_mode"], mode_framing["debate"])

    bull = roles["bull_speaker"]
    bear = roles["bear_speaker"]

    da_section = ""
    if da_brief and not da_brief.startswith("[DA brief unavailable"):
        da_section = f"""

══════════════════════════════════════════════════════════════════════
DEVIL'S ADVOCATE BRIEF (live bear research, MUST be used by the bear seat):
══════════════════════════════════════════════════════════════════════
{da_brief.strip()}

The bear-seat speaker ({bear.upper()}) MUST naturally weave at least
THREE bullets from this brief into the debate. Phrase them in his own
voice — don't just read the bullets verbatim. Cite numbers and dates
where present. This is what makes the stress test feel real and not
performative.
══════════════════════════════════════════════════════════════════════"""

    return f"""Generate the DGA HiTech Podcast episode for ticker {ticker}.
{format_intro}
══════════════════════════════════════════════════════════════════════
ROLE ASSIGNMENT (data-driven, do not override):
══════════════════════════════════════════════════════════════════════
{framing}

  • BULL SEAT  → {bull.upper()}   (his actual report direction: {rock_stance.get('direction') if bull=='rock' else claude_stance.get('direction')}, upside: {rock_stance.get('upside_pct') if bull=='rock' else claude_stance.get('upside_pct')}%)
  • BEAR SEAT  → {bear.upper()}   (his actual report direction: {rock_stance.get('direction') if bear=='rock' else claude_stance.get('direction')}, upside: {rock_stance.get('upside_pct') if bear=='rock' else claude_stance.get('upside_pct')}%)

Both speakers stay in personality (Rock punchy/British-contrarian, Claudia
measured/skeptic-tilted). But the directional stance each ARGUES is
assigned above. If the assignment goes against an analyst's own report
(e.g. Claudia has the bear seat despite a bullish report), the speaker
acknowledges this naturally: "I came in bullish, but..." / "Look, my
report's positive, but let me stress-test that..."

Below are the source reports. Pull specific numbers (price targets,
multiples, growth rates, margins) from them — the debate must feel
grounded in real data.

══════════════════════════════════════════════════════════════════════
ROCK'S REPORT (Grok-powered):
══════════════════════════════════════════════════════════════════════
{grok_md.strip()}

══════════════════════════════════════════════════════════════════════
CLAUDIA'S REPORT (Claude-powered):
══════════════════════════════════════════════════════════════════════
{claude_md.strip()}{da_section}

══════════════════════════════════════════════════════════════════════

Now write the episode. Remember:
  • JSON only, matching the schema in the system prompt exactly
  • 1,400–1,800 total words
  • Up to 10 curse words from the whitelist (don't be precious)
  • Real human fillers (um/uh/y'know/look/honestly/hmm) ~1 in 4 turns
  • Vary turn lengths constantly — no metronomic A-B-A-B pattern
  • Opus names a winner with 2 specific reasons drawn from THE DEBATE
  • "winner" field at the top must match Opus's verdict
  • Episode title at top of JSON should match the MODE (e.g., for
    stress_test: "{ticker}: The Bull Case Under Pressure")
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
    if winner not in ("rock", "claudia"):
        errors.append(f"winner must be 'rock' or 'claudia', got: {winner!r}")

    sections = script.get("sections") or []
    section_ids = [s.get("id") for s in sections]
    # Format-aware required sections. Falls back to debate format for
    # legacy scripts that don't include a 'format' field.
    fmt_name = (script.get("format") or "debate").lower()
    required_secs = FORMAT_SECTIONS.get(fmt_name, FORMAT_SECTIONS["debate"])
    fmt_meta = EPISODE_FORMATS.get(fmt_name, EPISODE_FORMATS["debate"])
    is_multi_ticker = bool(fmt_meta.get("multi_ticker"))

    if is_multi_ticker:
        # roundup            → cold_open + per-ticker dynamics + wrap
        # portfolio_roundup  → full fixed section list (no per-ticker dynamics)
        if fmt_name == "portfolio_roundup":
            for required in required_secs:
                if required not in section_ids:
                    errors.append(f"missing required section: {required}")
        else:
            for required in ("cold_open", "wrap"):
                if required not in section_ids:
                    errors.append(f"missing required section: {required}")
    else:
        for required in required_secs:
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

    # Per-section speaker rules. Opus-only sections vary by format.
    OPUS_ONLY_BY_FORMAT = {
        "debate":     {"cold_open", "company_in_60", "verdict"},
        "pre_mortem": {"cold_open", "scenario_setup", "verdict"},
        "memo":       {"cold_open", "executive_summary", "business_overview", "recommendation"},
        "catalysts":  {"cold_open", "setup_quarter", "verdict"},
        "quick_hit":  {"cold_open", "company_one_breath", "verdict"},
        "roundup":    {"cold_open"},   # per-ticker intros are dynamic
    }
    opus_only_ids = OPUS_ONLY_BY_FORMAT.get(fmt_name, OPUS_ONLY_BY_FORMAT["debate"])

    for sec in sections:
        sid = sec.get("id")
        turns = sec.get("turns") or []
        if sid in opus_only_ids:
            non_opus = [t for t in turns if (t.get("speaker") or "").lower() != "opus"]
            if non_opus:
                errors.append(f"{sid} should be Opus only — found {len(non_opus)} other speakers")
        if sid == "opening_pitch_rock":
            if not turns or (turns[0].get("speaker") or "").lower() != "rock":
                errors.append("opening_pitch_rock must start with Rock")
        if sid == "opening_pitch_claudia":
            if not turns or (turns[0].get("speaker") or "").lower() != "claudia":
                errors.append("opening_pitch_claudia must start with Claudia")
        if sid == "round_steelman":
            if len(turns) != 2:
                warnings.append(f"round_steelman should be exactly 2 turns, got {len(turns)}")
        if sid == "rock_take" or sid == "rock_failure_path" or sid == "bull_thesis":
            if not turns or (turns[0].get("speaker") or "").lower() != "rock":
                warnings.append(f"{sid} should start with Rock")
        if sid == "claudia_take" or sid == "claudia_failure_path" or sid == "bear_thesis":
            if not turns or (turns[0].get("speaker") or "").lower() != "claudia":
                warnings.append(f"{sid} should start with Claudia")

    full_text = " ".join(all_text_chunks)
    total_curses = _count_curses(full_text)
    if total_curses > MAX_CURSES_PER_EPISODE:
        warnings.append(
            f"curse count {total_curses} exceeds cap of {MAX_CURSES_PER_EPISODE} — "
            "consider regenerating or hand-trimming"
        )

    # Word budget — pull from the format's defined band
    wb_lo = fmt_meta.get("word_budget_low", 1400)
    wb_hi = fmt_meta.get("word_budget_high", 1800)
    if total_words < wb_lo * 0.85:
        warnings.append(f"word count {total_words} below {wb_lo:,}–{wb_hi:,} target — episode may run short")
    elif total_words > wb_hi * 1.15:
        warnings.append(f"word count {total_words} above {wb_lo:,}–{wb_hi:,} target — episode may overshoot")

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
# Alignment detection + dynamic role assignment (ui133)
# ════════════════════════════════════════════════════════════════════════
#
# Problem: when both reports are bullish, a "Bull vs Bear" format becomes
# vigorous-agreement theater. Solution: classify each report's stance,
# then assign Bull/Bear seats DYNAMICALLY based on which analyst is more
# aggressive — and brief the loser-seat with a Devil's Advocate Brief
# (Grok researches the bear case via live search, Claude synthesizes).
#
# Episode modes:
#   debate         — natural disagreement (one bull, one bear)
#   stress_test    — both bullish; less-aggressive analyst plays bear with DA brief
#   devils_advocate — both bearish; less-aggressive analyst plays bull
#   spread         — same direction, big magnitude gap (>15% upside delta)
#   mixed          — both neutral / unclear

def classify_stance(report_md: str) -> dict[str, Any]:
    """Pull direction + magnitude + conviction out of one report's text."""
    import claude_analyst as _ca
    summary = {}
    try:
        summary = _ca.extract_summary_from_report(report_md) or {}
    except Exception:
        summary = {}
    upside  = summary.get("upside_pct")
    rating  = (summary.get("rating") or "").lower()
    pt      = summary.get("price_target")

    if upside is None:
        direction = "neutral"
    elif upside > 5:
        direction = "bull"
    elif upside < -5:
        direction = "bear"
    else:
        direction = "neutral"

    mag = abs(upside or 0)
    if "strong buy" in rating or "high conviction" in rating or mag > 25:
        conviction = "high"
    elif "buy" in rating or "overweight" in rating or mag > 12:
        conviction = "medium"
    elif "sell" in rating or "underweight" in rating:
        conviction = "medium"
    else:
        conviction = "low"

    return {
        "direction":        direction,
        "upside_pct":       upside,
        "price_target":     pt,
        "rating":           rating,
        "conviction":       conviction,
        "aggression_score": (upside or 0.0),  # signed; +25 more bullish than +5
    }


def assign_roles(rock_stance: dict, claude_stance: dict) -> dict[str, Any]:
    """Decide which speaker plays Bull seat vs Bear seat + episode mode.

    Personalities stay constant — Rock is always punchy/contrarian, Claude
    always measured/skeptic-tilted. But the directional stance the
    character is asked to *argue* is data-driven.

    Examples:
      • Rock +28%, Claude +6%  → stress_test mode; Claude in bear seat
        (his lower upside IS the bear case — he stress-tests Rock's exuberance)
      • Rock +25%, Claude -10% → debate mode; Rock bull, Claude bear
      • Rock -5%, Claude +18%  → debate mode; Claude bull, Rock bear
        (yes, this means Rock is asked to argue a bearish case — works
        because the data is the data)
      • Rock +6%, Claude +5%   → mixed mode; very low conviction, gap_analysis
        becomes the centerpiece
    """
    r_dir = rock_stance.get("direction")
    c_dir = claude_stance.get("direction")
    r_agg = rock_stance.get("aggression_score") or 0
    c_agg = claude_stance.get("aggression_score") or 0
    gap = abs(r_agg - c_agg)

    # Natural disagreement — clean bull/bear assignment
    if r_dir == "bull" and c_dir == "bear":
        return {"bull_speaker": "rock", "bear_speaker": "claudia",
                "episode_mode": "debate", "needs_da_brief": False}
    if r_dir == "bear" and c_dir == "bull":
        return {"bull_speaker": "claudia", "bear_speaker": "rock",
                "episode_mode": "debate", "needs_da_brief": False}

    # Both bullish — Stress Test. Less-aggressive plays bear, gets DA brief.
    if r_dir == "bull" and c_dir == "bull":
        if r_agg >= c_agg:
            bull, bear = "rock", "claudia"   # Claude is the lower-conviction bull → bear seat
        else:
            bull, bear = "claudia", "rock"
        return {"bull_speaker": bull, "bear_speaker": bear,
                "episode_mode": "stress_test", "needs_da_brief": True}

    # Both bearish — Devil's Advocate. Less-bearish plays bull.
    if r_dir == "bear" and c_dir == "bear":
        if r_agg <= c_agg:   # r_agg more negative → he stays bear
            bull, bear = "claudia", "rock"
        else:
            bull, bear = "rock", "claudia"
        return {"bull_speaker": bull, "bear_speaker": bear,
                "episode_mode": "devils_advocate", "needs_da_brief": True}

    # One or both neutral — use the aggression score; bigger gap = "spread"
    if r_agg >= c_agg:
        bull, bear = "rock", "claudia"
    else:
        bull, bear = "claudia", "rock"
    mode = "spread" if gap > 15 else "mixed"
    return {"bull_speaker": bull, "bear_speaker": bear,
            "episode_mode": mode, "needs_da_brief": (mode == "spread")}


def generate_devils_advocate_brief(
    ticker: str, grok_md: str, claude_md: str,
    *, on_progress=None,
) -> str:
    """Two-pass DA brief: Grok researches via live search, Claude synthesizes.

    Returns markdown — 5-8 bullets of bear-side ammunition the source
    reports didn't address. Empty string if either pass fails (caller
    should treat that as "no brief, proceed without").
    """
    import claude_analyst as _ca
    if on_progress:
        try: on_progress("da_research", "Grok researching bear case (live web search)…")
        except Exception: pass

    research_prompt = f"""You are a short-seller's research analyst building the bear case
on {ticker}. The buy-side coverage on this name has converged bullish —
your job is to surface the COUNTER-EVIDENCE the bulls likely missed.

Search the live web (use your search tool) for:
  • Recent short-seller reports on {ticker} (Hindenburg, Muddy Waters,
    Kerrisdale, Bonitas, Spruce Point, Citron, Grizzly, etc.)
  • SEC 10-K / 10-Q risk factors materially raised in the last 12 months
  • Recent Form 4 insider transactions — esp. CEO/CFO selling >$5M
  • Peer multiple compression / sector re-rating in the last 90 days
  • Executive departures (CFO, General Counsel, Chief Compliance)
  • Macro/regulatory headwinds (rates, FX, tariffs, antitrust, FDA, etc.)
  • Customer concentration risk
  • Recent negative news (earnings warnings, guidance cuts, lawsuits,
    DOJ inquiries, accounting restatements)
  • Patent/regulatory cliff dates

Dump raw findings with citations. 600-1000 words. Be ruthless. DO NOT
summarize or hedge — give me the source material I can use to argue
the bear case.

Today's date is {_today_str()}."""

    try:
        raw_research = _ca.call_grok(
            system_prompt="You are a bear-side equity research analyst with web access. "
                          "Find the strongest counter-evidence to the bullish consensus.",
            user_content=research_prompt,
            live_search=True,
        )
    except Exception as e:
        return f"[DA brief unavailable — Grok research failed: {e!s:.120}]"

    if not raw_research or len(raw_research.strip()) < 200:
        return ""

    if on_progress:
        try: on_progress("da_synth", "Claude synthesizing DA brief…")
        except Exception: pass

    synth_prompt = f"""You are synthesizing a "Devil's Advocate Brief" for a podcast debate.

Both source reports on {ticker} were directionally bullish. Your job:
read Grok's raw bear research below and distill it into 5-8 punchy
bullets the bear-seat speaker can fire off during the debate.

Each bullet:
  • One sentence, 12-25 words
  • Cite source/date/data point where possible (e.g., "per 9/15 10-K")
  • Focus on what would BREAK the bullish thesis if true — not generic risk
  • Don't repeat anything already covered in the source reports

Source reports (the bullish consensus):
══════════════════════════════════
ROCK'S REPORT:
{grok_md[:8000]}
══════════════════════════════════
CLAUDE'S REPORT:
{claude_md[:8000]}
══════════════════════════════════

Raw bear research from Grok (this is your ammunition):
{raw_research[:18000]}
══════════════════════════════════

OUTPUT: just the bullets, one per line, each starting with "• ".
No preamble, no header, no closing summary. Five to eight bullets only.
"""

    try:
        brief = _ca.call_claude(
            system_prompt="You synthesize bear-case research into punchy podcast-ready bullets.",
            user_content=synth_prompt,
        )
        return (brief or "").strip()
    except Exception as e:
        return f"[DA brief unavailable — Claude synthesis failed: {e!s:.120}]"


def _today_str() -> str:
    from datetime import datetime
    return datetime.now().strftime("%B %d, %Y")


# ════════════════════════════════════════════════════════════════════════
# Generation
# ════════════════════════════════════════════════════════════════════════

def generate_script(
    ticker: str,
    grok_md: str,
    claude_md: str,
    *,
    model: str | None = None,
    on_progress=None,
    format: str = "debate",
) -> dict[str, Any]:
    """Generate one podcast episode script from both research reports.

    v1.2 (ui133): dynamic role assignment + Devil's Advocate Brief.
      1. Classify each report's stance
      2. Assign Bull/Bear seats to Rock and Claude based on aggression
      3. If both agree directionally, run Grok-research → Claude-synthesis
         to build a DA brief that the bear-seat speaker uses as ammo
      4. Pass everything to the dialogue prompt

    Returns:
        {
            "ticker":       str,
            "script":       dict (the validated JSON),
            "validation":   {ok, errors, warnings, stats},
            "alignment":    {rock_stance, claude_stance, roles, da_brief, mode},
            "raw_response": str (the LLM's raw output, for debugging),
        }
    """
    if not (grok_md and grok_md.strip()):
        raise ValueError("grok_md is empty — need both reports to generate a debate")
    if not (claude_md and claude_md.strip()):
        raise ValueError("claude_md is empty — need both reports to generate a debate")

    # Lazy import — avoids pulling claude_analyst at module load
    import claude_analyst as _ca

    import time as _t
    _t0 = _t.time()
    print(f"🎙️ [podcast/script {ticker}] START  grok={len(grok_md):,}ch  claude={len(claude_md):,}ch", flush=True)

    # ── 1. Classify stances + assign roles ──────────────────────────
    if on_progress:
        try: on_progress("classify", "Classifying both reports + assigning Bull/Bear seats…")
        except Exception: pass
    try:
        rock_stance   = classify_stance(grok_md)
        claude_stance = classify_stance(claude_md)
        roles = assign_roles(rock_stance, claude_stance)
        print(f"🎙️ [podcast/script {ticker}] roles={roles['episode_mode']} "
              f"bull={roles['bull_speaker']} bear={roles['bear_speaker']} "
              f"rock_dir={rock_stance['direction']}({rock_stance['upside_pct']}) "
              f"claude_dir={claude_stance['direction']}({claude_stance['upside_pct']}) "
              f"needs_brief={roles['needs_da_brief']}", flush=True)
    except Exception as e:
        print(f"❌ [podcast/script {ticker}] classify/assign failed: {e!s:.300}", flush=True)
        # Fall back to neutral debate so we never block on this step
        rock_stance   = {"direction": "neutral", "upside_pct": 0, "aggression_score": 0}
        claude_stance = {"direction": "neutral", "upside_pct": 0, "aggression_score": 0}
        roles = {"bull_speaker": "rock", "bear_speaker": "claudia",
                 "episode_mode": "debate", "needs_da_brief": False}

    # ── 2. DA brief (best-effort — never blocks script gen) ─────────
    da_brief = ""
    if roles.get("needs_da_brief"):
        _tb = _t.time()
        try:
            print(f"🎙️ [podcast/script {ticker}] DA brief: Grok research…", flush=True)
            da_brief = generate_devils_advocate_brief(
                ticker, grok_md, claude_md, on_progress=on_progress,
            )
            print(f"🎙️ [podcast/script {ticker}] DA brief done ({_t.time()-_tb:.1f}s, {len(da_brief)} chars)", flush=True)
        except Exception as e:
            # DA brief failure must NEVER kill the episode. Drop it + carry on.
            print(f"⚠️  [podcast/script {ticker}] DA brief failed, continuing without it: {e!s:.300}", flush=True)
            da_brief = ""

    # ── 3. Truncate for prompt cost ─────────────────────────────────
    MAX_INPUT_CHARS = 35000
    grok_trim   = grok_md[:MAX_INPUT_CHARS]
    claude_trim = claude_md[:MAX_INPUT_CHARS]

    if on_progress:
        try: on_progress("script_gen",
                         f"Writing script (mode: {roles['episode_mode']}, "
                         f"bull={roles['bull_speaker']}, bear={roles['bear_speaker']})…")
        except Exception: pass

    system = _system_prompt(format=format)
    user   = _user_prompt(
        ticker.upper(), grok_trim, claude_trim,
        format=format,
        roles=roles,
        rock_stance=rock_stance,
        claude_stance=claude_stance,
        da_brief=da_brief,
    )
    print(f"🎙️ [podcast/script {ticker}] calling Claude Opus  sys={len(system):,}ch  user={len(user):,}ch", flush=True)
    _tc = _t.time()
    try:
        raw = _ca.call_claude(
            system_prompt=system,
            user_content=user,
            model=model or _ca.CLAUDE_MODEL,
        )
    except Exception as e:
        print(f"❌ [podcast/script {ticker}] Claude call failed: {e!s:.500}", flush=True)
        raise
    print(f"🎙️ [podcast/script {ticker}] Claude returned {len(raw):,}ch ({_t.time()-_tc:.1f}s)", flush=True)

    cleaned = _strip_code_fence(raw)
    try:
        script = json.loads(cleaned)
    except json.JSONDecodeError as e:
        # Dump the first + last 300 chars so we can see if it was truncated or
        # just had a stray comma. Crucial for diagnosing "No script returned".
        head = cleaned[:300].replace("\n", "\\n")
        tail = cleaned[-300:].replace("\n", "\\n") if len(cleaned) > 300 else ""
        print(f"❌ [podcast/script {ticker}] JSON parse failed at pos {e.pos}: {e!s:.200}", flush=True)
        print(f"❌ [podcast/script {ticker}] HEAD: {head}", flush=True)
        if tail: print(f"❌ [podcast/script {ticker}] TAIL: {tail}", flush=True)
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

    # Force ticker + format onto the script (LLM may lower-case or omit them)
    script["ticker"] = ticker.upper()
    script["format"] = format

    # Title selection: format-specific title pattern wins over mode-based
    # default for non-debate formats. For debate format, mode still drives.
    mode_titles = {
        "debate":          f"{ticker.upper()}: Bull vs Bear",
        "stress_test":     f"{ticker.upper()}: The Bull Case Under Pressure",
        "devils_advocate": f"{ticker.upper()}: The Bear Trap",
        "spread":          f"{ticker.upper()}: The Spread",
        "mixed":           f"{ticker.upper()}: Mixed Signals",
    }
    fmt_meta = EPISODE_FORMATS.get(format, EPISODE_FORMATS["debate"])
    format_title = fmt_meta["title_pattern"].replace("{TICKER}", ticker.upper())

    if format == "debate":
        default_title = mode_titles.get(roles["episode_mode"], format_title)
    else:
        default_title = format_title

    llm_title = (script.get("episode_title") or "").strip()
    # Accept LLM title only if it's not the generic "Bull vs Bear" fallback
    # (or empty). For non-debate formats, also reject if the LLM ignored the
    # format and used the debate title.
    if not llm_title:
        script["episode_title"] = default_title
    elif format != "debate" and "bull vs bear" in llm_title.lower():
        script["episode_title"] = default_title
    elif format == "debate" and roles["episode_mode"] != "debate" and "bull vs bear" in llm_title.lower():
        script["episode_title"] = default_title
    # Stamp the assignment metadata onto the script too — survives DB round-trip
    script["_alignment"] = {
        "episode_mode": roles["episode_mode"],
        "bull_speaker": roles["bull_speaker"],
        "bear_speaker": roles["bear_speaker"],
        "rock_direction":   rock_stance["direction"],
        "rock_upside_pct":  rock_stance["upside_pct"],
        "claude_direction": claude_stance["direction"],
        "claude_upside_pct": claude_stance["upside_pct"],
        "da_brief_used":    bool(da_brief and not da_brief.startswith("[DA brief unavailable")),
    }

    validation = validate_script(script)
    return {
        "ticker":       ticker.upper(),
        "script":       script,
        "validation":   validation,
        "raw_response": raw,
        "alignment": {
            "rock_stance":   rock_stance,
            "claude_stance": claude_stance,
            "roles":         roles,
            "da_brief":      da_brief,
        },
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
# v3 stings (Succession walking-bass, 5s each). Re-generated with a
# different musical idea (driving bass + syncopated right-hand piano
# motif) AND mixed quieter so they sit underneath the speech instead
# of overpowering it.
INTRO_STING_PATH = _STING_DIR / "intro_v3_walkbass_5s.mp3"
OUTRO_STING_PATH = _STING_DIR / "outro_v3_walkbass_5s.mp3"

# Music gain offset applied AFTER normalization, so the stings sit
# perceptually quieter than the dialogue. -7 dB ≈ half the loudness
# of the TTS body.
MUSIC_GAIN_OFFSET_DB = -7.0


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

    # Piano-like timbre — fundamental + harmonics at falling dB
    def _piano(freq: float, ms: int, gain_db: float = -8.0) -> AudioSegment:
        layers = [(1.0, 0.0), (2.0, -7.0), (3.0, -14.0),
                  (4.0, -20.0), (5.0, -28.0), (6.0, -34.0)]
        out = AudioSegment.silent(duration=ms)
        for ratio, db in layers:
            tone = Sine(freq * ratio).to_audio_segment(duration=ms)
            out = out.overlay(tone.apply_gain(db + gain_db))
        attack = min(15, ms // 30)
        return out.fade_in(attack).fade_out(max(ms - attack - 5, ms // 2))

    # Plucked-bass: heavier low-end emphasis, faster decay
    def _bass(freq: float, ms: int, gain_db: float = -10.0) -> AudioSegment:
        layers = [(1.0, 0.0), (2.0, -5.0), (3.0, -12.0), (4.0, -22.0)]
        out = AudioSegment.silent(duration=ms)
        for ratio, db in layers:
            tone = Sine(freq * ratio).to_audio_segment(duration=ms)
            out = out.overlay(tone.apply_gain(db + gain_db))
        return out.fade_in(4).fade_out(ms - 30)

    # F minor notes (Succession-ish)
    F1, C2, Db2, Eb2, F2, F3, Ab3, C4, Db4, Eb4, F4, Ab4, C5 = (
        43.65, 65.41, 69.30, 77.78, 87.31,
        174.61, 207.65, 261.63, 277.18, 311.13, 349.23, 415.30, 523.25
    )

    # ── INTRO (5s): walking bass + syncopated right-hand stabs ───────
    # Quarter-note bass at ~80bpm = 750ms/beat. 4 beats = 3000ms,
    # then a 2s sustained landing chord under the cold open.
    BEAT = 750
    intro = AudioSegment.silent(duration=5000)

    # Walking bass: F → Eb → Db → C → resolve to low F
    for freq, pos in [(F2, 0), (Eb2, BEAT), (Db2, BEAT*2), (C2, BEAT*3)]:
        intro = intro.overlay(_bass(freq, 720, gain_db=-6), position=pos)
    intro = intro.overlay(_bass(F1, 1800, gain_db=-3), position=int(BEAT*3.8))

    # Right-hand: 3 syncopated stabs (on the off-beats), each a small chord
    for pos, chord in [
        (BEAT//2 + 80,        [F4, Ab4, C5]),    # Fm over F bass
        (BEAT + BEAT//2 + 60, [Eb4, F4, Ab4]),   # over Eb
        (BEAT*2 + BEAT//2 + 40,[Db4, F4, Ab4]),  # over Db
    ]:
        for note in chord:
            intro = intro.overlay(_piano(note, 600, -12), position=pos)
    # Landing chord under cold open: sustained Fm
    for note in (F3, Ab3, C4, F4):
        intro = intro.overlay(_piano(note, 1600, -8), position=BEAT*3 + 40)

    intro = intro.fade_out(500).normalize(headroom=2.0)
    intro.export(INTRO_STING_PATH, format="mp3", bitrate="128k")

    # ── OUTRO (5s): mirror — walk down + suspended resolve ──────────
    outro = AudioSegment.silent(duration=5000)
    for freq, pos in [(F2, 0), (Db2, BEAT), (C2, BEAT*2), (Db2, BEAT*3)]:
        outro = outro.overlay(_bass(freq, 700, gain_db=-6), position=pos)
    outro = outro.overlay(_bass(F2, 1500, gain_db=-5), position=int(BEAT*3.9))

    # Right-hand descending motif
    for note, pos in [(C5, 200), (Ab4, BEAT + 100),
                      (F4, BEAT*2 + 60), (Eb4, BEAT*3 + 40)]:
        outro = outro.overlay(_piano(note, 1000, -11), position=pos)
    # Suspended Db-major-over-F = unresolved minor 6th → "to be continued" feel
    for note in (F3, Ab3, Db4):
        outro = outro.overlay(_piano(note, 1500, -10), position=BEAT*3 + 60)

    outro = outro.fade_out(900).normalize(headroom=2.0)
    outro.export(OUTRO_STING_PATH, format="mp3", bitrate="128k")

    return INTRO_STING_PATH, OUTRO_STING_PATH


def _tts_turn(client, speaker: str, text: str, intensity: str,
              model: str = TTS_MODEL_DEFAULT) -> bytes:
    """Synthesize one turn via OpenAI TTS. Returns raw MP3 bytes."""
    sp_l = speaker.lower()
    # Legacy speaker-key aliases — old scripts may have "alec"/"alex"/"claude"
    # before the cast rename to opus / claudia. Map them so they keep working.
    sp_l = {"alec": "opus", "alex": "opus", "claude": "claudia"}.get(sp_l, sp_l)
    # Read voice + speed from the RUNTIME tables so UI edits take effect immediately.
    voice = _RUNTIME_VOICE_MAP.get(sp_l, "alloy")
    # Safety net: if the saved voice was valid earlier but is no longer in
    # AVAILABLE_VOICES (e.g., user previously picked 'verse' before we
    # learned tts-1-hd rejects it), fall back to a sane default for this
    # speaker rather than crashing the whole episode generation.
    if voice not in AVAILABLE_VOICES:
        safe_default = VOICE_MAP.get(sp_l, "alloy")
        print(f"⚠️  [tts] {sp_l!r} had unsupported voice {voice!r}; falling back to {safe_default!r}", flush=True)
        voice = safe_default
    intensity_mult = _RUNTIME_INTENSITY.get(intensity.lower(), 1.0)
    speaker_mult   = _RUNTIME_SPEAKER.get(sp_l, 1.0)
    speed = max(SPEED_MIN, min(SPEED_MAX, intensity_mult * speaker_mult))
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
    # ui135: level-match stings to dialogue. We first equalize the music
    # to the dialogue's perceived loudness (so episodes don't ship with
    # one being noticeably louder than the other), THEN apply a fixed
    # offset to sit the music a bit underneath the voice.
    # The actual body loudness is computed after we build it below.

    # Synthesize each turn → AudioSegment
    segs: list[AudioSegment] = []
    prev_section: str | None = None
    for i, (sid, turn) in enumerate(flat, start=1):
        sp = (turn.get("speaker") or "opus").lower()
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
    body = body.normalize(headroom=1.5)
    body = body.fade_in(60).fade_out(200)

    # Level-match the music to the dialogue body, then drop it MUSIC_GAIN_OFFSET_DB
    # below so it sits perceptually quieter than the speech. dBFS is negative
    # (closer to 0 = louder); we shift the music to match the body's dBFS then
    # apply the offset.
    body_dbfs  = body.dBFS  if body.dBFS  != float("-inf") else -16.0
    intro_dbfs = intro.dBFS if intro.dBFS != float("-inf") else -16.0
    outro_dbfs = outro.dBFS if outro.dBFS != float("-inf") else -16.0
    intro = intro.apply_gain((body_dbfs - intro_dbfs) + MUSIC_GAIN_OFFSET_DB)
    outro = outro.apply_gain((body_dbfs - outro_dbfs) + MUSIC_GAIN_OFFSET_DB)

    full = intro + AudioSegment.silent(duration=350) + body + \
           AudioSegment.silent(duration=400) + outro
    # Final mastering normalize — gentle (headroom 1.0 dB) so the level-match
    # we just did isn't undone by an aggressive normalize on the full mix.
    full = full.normalize(headroom=1.0)

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


def generate_roundup_script(
    tickers: list[str],
    reports_by_ticker: dict[str, dict[str, str]],
    *,
    model: str | None = None,
    on_progress=None,
) -> dict[str, Any]:
    """Roundup format — single episode covering 3-4 tickers.

    Args:
        tickers: ordered list of ticker symbols (3-4 recommended)
        reports_by_ticker: { "NVDA": {"grok": "...", "claude": "..."}, ... }
        model / on_progress: same as generate_script

    Returns the same shape as generate_script: {ticker (synthetic),
    script, validation, alignment, raw_response}. The synthetic ticker
    is "ROUNDUP_<comma-list>" so the DB row key is unique.
    """
    import claude_analyst as _ca
    import time as _t

    if not tickers or len(tickers) < 2:
        raise ValueError("Roundup needs at least 2 tickers")
    tickers = [t.upper() for t in tickers if t and t.strip()][:4]
    missing = [t for t in tickers if not (reports_by_ticker.get(t, {}).get("grok", "").strip()
                                         and reports_by_ticker.get(t, {}).get("claude", "").strip())]
    if missing:
        raise ValueError(f"Missing Grok+Claude reports for: {', '.join(missing)}")

    if on_progress:
        try: on_progress("classify", f"Setting up roundup for {len(tickers)} tickers…")
        except Exception: pass

    # Build dynamic required sections for THIS roundup
    dyn_sections = ["cold_open"]
    for tk in tickers:
        slug = tk.lower()
        dyn_sections.extend([f"{slug}_intro", f"{slug}_take", f"{slug}_rebuttal"])
    dyn_sections.append("wrap")

    # Build the user prompt — pack all reports compactly
    MAX_CHARS_PER_REPORT = 12000   # tighter than single-ticker since we have N
    reports_block = ""
    for tk in tickers:
        rep = reports_by_ticker[tk]
        reports_block += (
            f"\n══════════════════════════════════════════════════════════════\n"
            f"TICKER: {tk}\n"
            f"──────────────────────────────────────────────────────────────\n"
            f"ROCK'S REPORT (Grok):\n{(rep.get('grok','') or '')[:MAX_CHARS_PER_REPORT]}\n"
            f"──────────────────────────────────────────────────────────────\n"
            f"CLAUDIA'S REPORT (Claude):\n{(rep.get('claude','') or '')[:MAX_CHARS_PER_REPORT]}\n"
        )

    fmt_meta = EPISODE_FORMATS["roundup"]
    expected_ids = ", ".join([f'"{s}"' for s in dyn_sections])

    system = _system_prompt(format="roundup")
    user = f"""Generate a DGA HiTech Podcast ROUNDUP episode covering {len(tickers)} tickers.

TICKERS (in order): {', '.join(tickers)}

For EACH ticker, you must produce 3 sections following the naming convention
in the system prompt (use the lowercased symbol — e.g. for NVDA, use
"nvda_intro" / "nvda_take" / "nvda_rebuttal"). Pick whichever analyst's
report is more directionally aggressive to take the lead "take" for that
ticker; the other gets the "rebuttal".

The full ordered section list you MUST produce is:
{expected_ids}

REPORTS:
{reports_block}

══════════════════════════════════════════════════════════════════════
Now write the episode. Remember:
  • JSON only matching the system-prompt shape
  • {fmt_meta['word_budget_low']:,}–{fmt_meta['word_budget_high']:,} total words
  • No per-ticker verdict; wrap delivers the cross-name takeaway
  • "winner" field: pick the analyst whose overall read across these names
    you found more convincing
"""

    print(f"🎙️ [podcast/roundup {tickers}] calling Claude Opus  user={len(user):,}ch", flush=True)
    _tc = _t.time()
    raw = _ca.call_claude(
        system_prompt=system, user_content=user,
        model=model or _ca.CLAUDE_MODEL,
    )
    print(f"🎙️ [podcast/roundup {tickers}] Claude returned {len(raw):,}ch ({_t.time()-_tc:.1f}s)", flush=True)

    cleaned = _strip_code_fence(raw)
    try:
        script = json.loads(cleaned)
    except json.JSONDecodeError as e:
        head = cleaned[:300].replace("\n", "\\n")
        print(f"❌ [podcast/roundup] JSON parse failed at pos {e.pos}: {head}", flush=True)
        return {
            "ticker": "ROUNDUP_" + ",".join(tickers),
            "script": None,
            "validation": {"ok": False, "errors": [f"LLM returned invalid JSON: {e!s:.200}"],
                           "warnings": [], "stats": {}},
            "raw_response": raw,
        }

    synthetic_ticker = "ROUNDUP_" + ",".join(tickers)
    script["ticker"] = synthetic_ticker
    script["format"] = "roundup"
    script["tickers"] = tickers      # explicit list for the UI to render
    if not script.get("episode_title"):
        script["episode_title"] = fmt_meta["title_pattern"].replace("{TICKERS}", " · ".join(tickers))
    script["_alignment"] = {
        "episode_mode": "roundup",
        "bull_speaker": "rock",
        "bear_speaker": "claudia",
        "tickers":      tickers,
        "da_brief_used": False,
    }

    validation = validate_script(script)
    return {
        "ticker":     synthetic_ticker,
        "script":     script,
        "validation": validation,
        "raw_response": raw,
        "alignment":  script["_alignment"],
    }


def fetch_macro_context(*, on_progress=None) -> str:
    """Today's macro headlines that matter for a US equity portfolio.

    Uses Grok with live_search=True for genuinely-fresh data (the whole point
    of the Portfolio Roundup is "how are we positioned for the world right
    now" — stale macro defeats the format).

    Returns: a markdown block of 6-10 bullet points with date-stamped headlines.
    On failure: returns a short '[macro unavailable: …]' string — caller treats
    that as "no macro" and the script still generates (degraded but workable).
    """
    import claude_analyst as _ca
    if on_progress:
        try: on_progress("macro_pull", "Grok pulling today's macro headlines…")
        except Exception: pass
    prompt = f"""Pull the most relevant macro headlines from the LAST 48 HOURS \
that affect a US equity portfolio. Use your web search tool.

Cover these buckets only when there's actual news in each (don't pad):
  • Fed / rates moves (FOMC statements, dot plot, Fed speakers)
  • Major economic releases (jobs, CPI, PCE, GDP, ISM, PMI)
  • Geopolitical events affecting markets (war, sanctions, trade, tariffs)
  • Major FX moves (DXY, USD/JPY, EUR/USD, CNY)
  • Commodity moves > 2% (oil, gold, copper, nat gas)
  • Sector-specific news (semis, banks, energy, healthcare regulation)
  • Big earnings results from BELLWETHER names that move sentiment

OUTPUT FORMAT: 6-10 bullets, one sentence each.
Each bullet MUST include: the actual headline + the date (use real dates,
today is {_today_str()}) + a number or specific entity name.
Bad: "Rates moved on Fed news"
Good: "10-year yield rose to 4.62% Thursday after hot CPI print (+0.3% MoM)"

NO preamble, NO closing summary. Just the bullets, one per line, each
starting with "• "."""
    try:
        raw = _ca.call_grok(
            system_prompt="You are a market macro researcher with web access. "
                          "Pull the freshest macro headlines that affect US equity portfolios.",
            user_content=prompt,
            live_search=True,
        )
    except Exception as e:
        return f"[macro unavailable: {e!s:.120}]"
    return (raw or "").strip()


def screen_bolton_candidates(
    current_positions: list[dict],
    *,
    on_progress=None,
    universe_hint: str = "S&P 500 + the user's watchlist",
) -> list[dict]:
    """Sonnet 4.6 picks 3-5 BOLT-ON tickers for a Portfolio Roundup.

    current_positions: list of {ticker, sector?, weight_pct?, market_cap?, ...}
    universe_hint:     plain-English describes the candidate universe

    Returns: [{ticker, role: 'hedge'|'complement'|'rotation', reason: str,
               size_pct: float, risk_note: str}, ...]
    Empty list if Sonnet rejects or errors.

    Constrained universe (not free-form) — Sonnet only picks from common,
    well-known US-listed names so we don't get hallucinated tickers.
    """
    import claude_analyst as _ca
    import json as _json
    if on_progress:
        try: on_progress("bolton_screen", "Sonnet 4.6 screening bolt-on candidates…")
        except Exception: pass
    if not current_positions:
        return []

    sys_prompt = (
        "You are a senior portfolio manager at a US equity hedge fund. "
        "You're reviewing a colleague's book and suggesting 3-5 BOLT-ON "
        "positions that would IMPROVE the portfolio. Pick from "
        f"{universe_hint}. Stay in well-known US-listed tickers only — "
        "no obscure picks, no foreign listings, no crypto, no SPACs.\n\n"
        "For EACH bolt-on, identify ONE clear role:\n"
        "  • 'hedge'      — explicitly offsets a major risk in the current book\n"
        "  • 'complement' — adds missing exposure / theme not currently held\n"
        "  • 'rotation'   — replaces a current position the PM should trim\n\n"
        "Return STRICT JSON. No prose, no code fences. Schema:\n"
        '{ "bolt_ons": [{"ticker":"X", "role":"hedge|complement|rotation", '
        '"reason":"≤25 words why it fits", "size_pct":1.0-5.0, '
        '"risk_note":"≤15 words the main risk in this name"}] }'
    )
    positions_summary = _json.dumps(current_positions, indent=2, default=str)
    user = (
        f"Today: {_today_str()}\n"
        f"Current positions (with sizing where available):\n\n{positions_summary}\n\n"
        "Pick 3-5 bolt-on suggestions. Be SPECIFIC about role and sizing. "
        "No 'maybe consider' — make the call."
    )

    try:
        raw = _ca.call_claude(
            system_prompt=sys_prompt,
            user_content=user,
            model=_ca.CLAUDE_SCREEN_MODEL,
        )
    except Exception as e:
        print(f"⚠️  [bolton_screen] Sonnet call failed: {e!s:.200}", flush=True)
        return []

    cleaned = _strip_code_fence(raw)
    try:
        parsed = _json.loads(cleaned)
    except _json.JSONDecodeError:
        print(f"⚠️  [bolton_screen] invalid JSON: {cleaned[:200]}", flush=True)
        return []
    return parsed.get("bolt_ons") or []


def generate_portfolio_roundup_script(
    tickers: list[str],
    reports_by_ticker: dict[str, dict[str, str]],
    *,
    positions: list[dict] | None = None,
    model: str | None = None,
    on_progress=None,
) -> dict[str, Any]:
    """Portfolio Roundup — PM-style review of a 10-20 ticker book.

    Args:
        tickers: ordered list of 10-20 ticker symbols (no enforced max here;
                 callers should sanity-cap)
        reports_by_ticker: {ticker: {"grok": "...", "claude": "..."}}.
                          Tickers without reports are OK — the script just
                          can't cite them as deeply.
        positions: optional [{ticker, weight_pct?, market_cap?, sector?,
                              beta?, last_price?}] — feeds the snapshot
                  section with real sizing.
        model / on_progress: standard

    Returns: same shape as generate_script. Synthetic ticker is
    "PORTFOLIO_<n>tickers_<timestamp>" so DB key is unique per run
    (you generate a new one every refresh, vs single-ticker formats
    which keep one row per ticker).
    """
    import claude_analyst as _ca
    import time as _t

    tickers = [t.upper().strip() for t in (tickers or []) if t and t.strip()]
    if len(tickers) < 5:
        raise ValueError("Portfolio Roundup needs at least 5 tickers")

    # 1. Macro context (Grok live search) — best-effort
    macro = fetch_macro_context(on_progress=on_progress)

    # 2. Bolt-on screen via Sonnet 4.6 (constrained to current_positions awareness)
    positions = positions or [{"ticker": t} for t in tickers]
    # Augment positions with sector from existing reports if missing
    bolt_ons = screen_bolton_candidates(positions, on_progress=on_progress)

    # 3. Build the dialogue prompt
    if on_progress:
        try: on_progress("script_gen",
                         f"Writing portfolio script ({len(tickers)} positions)…")
        except Exception: pass

    # Compact reports — at 15 tickers × 2 reports we'd blow the context if we
    # passed full reports. Truncate hard.
    MAX_PER_REPORT = 5500
    reports_block_parts = []
    for tk in tickers:
        rep = reports_by_ticker.get(tk, {})
        grok_md   = (rep.get("grok") or "").strip()
        claude_md = (rep.get("claude") or "").strip()
        if not (grok_md or claude_md):
            continue
        reports_block_parts.append(
            f"\n══ {tk} ══\n"
            f"ROCK:\n{grok_md[:MAX_PER_REPORT]}\n"
            f"CLAUDIA:\n{claude_md[:MAX_PER_REPORT]}\n"
        )
    reports_block = "\n".join(reports_block_parts) if reports_block_parts else \
        "(No saved reports for any of these tickers — write based on the macro context + position sizing.)"

    pos_block = json.dumps(positions, indent=2, default=str)
    bolton_block = json.dumps(bolt_ons, indent=2, default=str) if bolt_ons else "(none)"

    fmt_meta = EPISODE_FORMATS["portfolio_roundup"]
    budget = _portfolio_roundup_budget(len(tickers))
    system = _system_prompt(format="portfolio_roundup")
    user = f"""Generate the DGA HiTech Podcast PORTFOLIO ROUNDUP for this book.

══════════════════════════════════════════════════════════════════════
WORD BUDGET (DYNAMIC — scales with ticker count, overrides any system-prompt budget):
══════════════════════════════════════════════════════════════════════
TARGET: ~{budget['target']:,} words  (acceptable range: {budget['low']:,}–{budget['high']:,})
EXPECTED RUNTIME: ~{int(budget['minutes'])} min at conversational pacing.

This is the MOST IMPORTANT NUMBER in this prompt. The position_walk
section ALONE should be ~{int(len(tickers) * 90):,} words because you have
{len(tickers)} tickers and each one gets ~80-100 words of treatment (some
big positions longer, some small positions shorter, but NONE skipped).
The other sections together add another ~{budget['target'] - int(len(tickers) * 90):,} words.

If you produce a {int(budget['target'] * 0.5):,}-word episode for {len(tickers)} tickers
it will not be acceptable — that's ~{int(budget['target'] * 0.5 / len(tickers)):,} words/ticker
which is not enough for a real PM-style review.

══════════════════════════════════════════════════════════════════════
CURRENT POSITIONS ({len(tickers)} names):
══════════════════════════════════════════════════════════════════════
{pos_block}

══════════════════════════════════════════════════════════════════════
MACRO CONTEXT (today's headlines, via live web search):
══════════════════════════════════════════════════════════════════════
{macro}

══════════════════════════════════════════════════════════════════════
BOLT-ON CANDIDATES (pre-screened by Sonnet 4.6, only present these):
══════════════════════════════════════════════════════════════════════
{bolton_block}

══════════════════════════════════════════════════════════════════════
SOURCE REPORTS (per-ticker Grok + Claudia analyses):
══════════════════════════════════════════════════════════════════════
{reports_block}

══════════════════════════════════════════════════════════════════════
Now write the episode. Reminders:
  • Opus speaks as a SENIOR PM at DGA Capital — directional, owns the P&L.
    NOT a moderator.
  • Use the DYNAMIC word budget above ({budget['target']:,} words target,
    ~{int(budget['minutes'])} min). The default in the system prompt is a
    fallback for missing data — override it with the dynamic budget here.
  • position_walk MUST cover EVERY one of the {len(tickers)} tickers
    (some briefly, some in depth — none skipped entirely).
  • Bolt-on suggestions MUST be from the candidates provided above. DO NOT
    invent any other tickers.
  • Cite specific headlines from the macro block + specific numbers from
    the reports where relevant. Be concrete.
  • End the pm_verdict with a specific date for the next portfolio review
    (e.g., "next committee — Thursday").
"""

    _tc = _t.time()
    print(f"🎙️ [portfolio_roundup] calling Opus  user={len(user):,}ch  reports={len(reports_block_parts)}  bolt_ons={len(bolt_ons)}  budget={budget['target']}w/{int(budget['minutes'])}min", flush=True)
    raw = _ca.call_claude(
        system_prompt=system, user_content=user,
        model=model or _ca.CLAUDE_MODEL,
        # Lift max output tokens for this long-form format. 20-min episodes
        # need ~6-7k output tokens. Cap at 24k to stay safely under Opus 4.1's
        # output limit while leaving headroom.
        max_tokens=24000,
    )
    print(f"🎙️ [portfolio_roundup] Opus returned {len(raw):,}ch ({_t.time()-_tc:.1f}s)", flush=True)

    cleaned = _strip_code_fence(raw)
    try:
        script = json.loads(cleaned)
    except json.JSONDecodeError as e:
        head = cleaned[:300].replace("\n", "\\n")
        print(f"❌ [portfolio_roundup] JSON parse failed at pos {e.pos}: {head}", flush=True)
        return {
            "ticker": "PORTFOLIO_INVALID",
            "script": None,
            "validation": {"ok": False, "errors": [f"LLM returned invalid JSON: {e!s:.200}"],
                           "warnings": [], "stats": {}},
            "raw_response": raw,
        }

    # Synthetic key — unique per run (you'd want fresh ones for re-runs of
    # the same book on different days, so timestamp it).
    synthetic = f"PORTFOLIO_{len(tickers)}TICKERS_{int(_t.time())}"
    script["ticker"] = synthetic
    script["format"] = "portfolio_roundup"
    script["tickers"] = tickers
    if not script.get("episode_title"):
        script["episode_title"] = fmt_meta["title_pattern"].replace("{TICKERS}", f"{len(tickers)} positions · {_today_str()}")
    script["_alignment"] = {
        "episode_mode": "portfolio_roundup",
        "bull_speaker": "rock",
        "bear_speaker": "claudia",
        "tickers":      tickers,
        "da_brief_used": False,
        "macro_used":    not macro.startswith("[macro unavailable"),
        "bolton_count":  len(bolt_ons),
    }

    validation = validate_script(script)
    return {
        "ticker":       synthetic,
        "script":       script,
        "validation":   validation,
        "raw_response": raw,
        "alignment":    script["_alignment"],
        "macro":        macro,
        "bolt_ons":     bolt_ons,
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
