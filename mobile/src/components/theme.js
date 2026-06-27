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

// ─────────────────────────────────────────────────────────────────────────────
// Semantic theme (light + dark) for dark-mode support.
//
// The flat `colors` export above stays LIGHT-only so screens not yet migrated to
// useTheme() keep rendering correctly. Migrated screens read semantic roles from
// makeTheme(mode) via the useTheme() hook. Brand chrome (header / tab bar) keeps
// its navy in both modes by design — only the page/surface/text/border roles flip.
// ─────────────────────────────────────────────────────────────────────────────
const LIGHT = {
  bg:           '#f0f4f8',   // page background
  surface:      '#FFFFFF',   // card surface
  surfaceAlt:   '#f1f5f9',   // bar tracks / subtle fills
  surfaceTint:  '#eef6fb',   // accent-tinted icon wells
  border:       '#e2e8f0',
  borderSubtle: '#eef2f7',
  textPrimary:  '#0A1628',
  textSecondary:'#64748b',
  textDim:      '#94a3b8',
  pillUpBg:     '#dcfce7', pillUpFg:   '#166534',
  pillDownBg:   '#fee2e2', pillDownFg: '#991b1b',
  pillFlatBg:   '#f1f5f9', pillFlatFg: '#64748b',
  ratingBg:     '#dcfce7', ratingFg:   '#166534',
  cardShadowOpacity: 0.06,
};
const DARK = {
  bg:           '#0b1220',
  surface:      '#15203a',
  surfaceAlt:   '#1d2942',
  surfaceTint:  '#16314a',
  border:       '#27324a',
  borderSubtle: '#1c2740',
  textPrimary:  '#e8eef7',
  textSecondary:'#9fb0c8',
  textDim:      '#6b7c96',
  pillUpBg:     '#143524', pillUpFg:   '#4ade80',
  pillDownBg:   '#3a1717', pillDownFg: '#f87171',
  pillFlatBg:   '#1d2942', pillFlatFg: '#9fb0c8',
  ratingBg:     '#143524', ratingFg:   '#4ade80',
  cardShadowOpacity: 0.30,
};

// Shared across modes — brand chrome + accents that read fine on both.
const SHARED = {
  chromeNavy: colors.navy,   // header + tab bar bg (navy in both modes)
  onChrome:   '#FFFFFF',
  primary:    colors.primary,
  gold:       colors.gold,
  green:      colors.green,
  red:        colors.red,
  amber:      colors.amber,
  onAccent:   '#FFFFFF',     // text on a primary/gold filled control
};

export function makeTheme(mode) {
  const isDark = mode === 'dark';
  return { mode, isDark, ...SHARED, ...(isDark ? DARK : LIGHT) };
}

export const THEME_MODES = ['system', 'light', 'dark'];
