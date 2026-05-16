/**
 * DGA Capital — design tokens (aligned with web portfolio-gp.html)
 *
 * Rule:
 *   gold / goldLight / goldDark  →  header, logo border, tab bar ONLY (dark navy bg)
 *   primary / accentBlue         →  every interactive element in screens (buttons,
 *                                   active chips, links, icons) — matches web --blue
 *
 * All hex values mirror the web CSS :root variables exactly.
 */
export const colors = {
  // ── Dark backgrounds (AppHeader, CustomTabBar) ────────────────────────────
  navy:        '#0A1628',   // --navy       ✓
  navyLight:   '#1e293b',   // --navy-light (was #132040)
  navyCard:    '#0e1e35',   // slightly lighter card on dark screens

  // ── Gold — ONLY for header title, logo border ring, tab bar active pill ──
  gold:        '#c9a84c',
  goldLight:   '#d9bc76',
  goldDark:    '#a88a3a',

  // ── DGA brand blue — PRIMARY interactive accent, matches web --blue ───────
  primary:     '#5BB8D4',   // web: --blue  (was accentBlue)
  accentBlue:  '#5BB8D4',   // alias kept for back-compat
  blueLight:   '#84CCE3',   // web: --blue-light
  blueDark:    '#3E9AB8',   // web: --blue-dark

  // ── Surfaces ──────────────────────────────────────────────────────────────
  white:       '#FFFFFF',   // web: --white / --panel
  offWhite:    '#f0f4f8',   // web: body background (was #F5F7FA)
  panel:       '#FFFFFF',   // white card / panel

  // ── Borders ───────────────────────────────────────────────────────────────
  lightGray:   '#e2e8f0',   // web: --panel-edge (was #E8ECF2)

  // ── Text hierarchy — matches web slate scale exactly ─────────────────────
  darkGray:    '#3D4A5C',   // body text ✓
  midGray:     '#64748b',   // web: --mid  (was #8A95A8)
  dim:         '#94a3b8',   // web: --dim
  dimmer:      '#cbd5e1',   // web: --dimmer

  // ── Status / semantic — matches web :root exactly ─────────────────────────
  green:       '#16a34a',   // web: --green  (was #22C55E — too bright)
  red:         '#dc2626',   // web: --red    (was #EF4444)
  amber:       '#d97706',   // web: --amber  (was #F59E0B)

  // ── Utility ───────────────────────────────────────────────────────────────
  blue:        '#3B82F6',   // generic utility blue (not DGA brand)
};

export const fonts = {
  heading:    { fontWeight: '700' },
  subheading: { fontWeight: '600' },
  body:       { fontWeight: '400' },
  mono:       { fontFamily: 'Courier New' },
};
