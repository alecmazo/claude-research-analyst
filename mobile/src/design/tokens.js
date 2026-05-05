/**
 * Design tokens for DGA Capital apps.
 *
 * Single source of truth for spacing, radius, shadow, type scale.
 * Re-exports color tokens from theme.js so screens only need to import
 * from one place.
 *
 * Usage:
 *   import { colors, spacing, radius, shadow, fontSize } from '../design/tokens';
 */
import { colors, fonts } from '../components/theme';

export { colors, fonts };

// 4-pt spacing scale — matches Wall Street density better than the
// 8-pt scale most consumer apps use.
export const spacing = {
  xs:  4,
  sm:  6,
  md:  10,
  lg:  14,
  xl:  18,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  pill: 999,
};

// Cross-platform shadow blocks. Spread into a style:
//   <View style={[styles.card, shadow.card]} />
export const shadow = {
  // Soft section lift — primary card chrome
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  // Light separator — for inline rows / list containers
  hairline: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  // Strong elevation — for hero / focused content
  hero: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.10,
    shadowRadius: 10,
    elevation: 5,
  },
};

// Type scale — tuned for financial UI density.
export const fontSize = {
  // Section labels / column headers
  micro:   9,
  caption: 11,
  // Inline metadata (relative time, generated-at)
  small:   12,
  // Body text + buttons
  body:    13,
  bodyLg:  14,
  // Emphasis
  lg:      15,
  xl:      17,
  // Display (price targets, hero numbers)
  hero:    20,
  display: 32,
};

export const letterSpacing = {
  label:  1.5,   // ALL-CAPS section labels
  ticker: 1.2,   // ticker glyphs
  button: 1.0,   // ALL-CAPS button text
};

// Status semantic colors — use these instead of raw red/green/amber
// so callers communicate intent, not color.
export const status = {
  ok:      colors.green,
  error:   colors.red,
  warn:    colors.amber,
  pending: colors.midGray,
  info:    colors.blue,
};
