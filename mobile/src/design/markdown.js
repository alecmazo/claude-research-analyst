/**
 * Shared markdown styles for all report/intel/summary screens.
 *
 * Three callers used to define their own copy of this:
 *   ReportScreen, IntelligenceScreen, PortfolioSummaryScreen
 * Each was slightly different — making a 5,000-word report look
 * subtly different depending on where you opened it. Now: one source.
 *
 * Two preset variants:
 *   `mdStyles`        — DGA standard (balanced, used for live briefs)
 *   `mdStylesReport`  — slightly larger headings for long-form reports
 */
import { Platform } from 'react-native';
import { colors } from '../components/theme';

const monoFamily = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

// Shared bits — exported so non-markdown views can match the report look.
export const markdownColors = {
  body:        colors.darkGray,
  heading:     colors.navy,
  emphasis:    colors.navy,
  italic:      colors.midGray,
  divider:     '#E8EDF3',
  quoteBg:     '#F0F4FA',
  quoteAccent: colors.gold,
  codeBg:      colors.lightGray,
  codeFg:      colors.navy,
};

// ── Standard ──────────────────────────────────────────────────────────────────
// Used everywhere markdown renders except long-form reports.
export const mdStyles = {
  body:     { color: markdownColors.body, fontSize: 14, lineHeight: 22 },
  heading1: { color: markdownColors.heading, fontSize: 20, fontWeight: '800', marginTop: 20, marginBottom: 8 },
  heading2: {
    color: markdownColors.heading, fontSize: 17, fontWeight: '700',
    marginTop: 18, marginBottom: 6,
    paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: markdownColors.divider,
  },
  heading3: { color: colors.darkGray, fontSize: 15, fontWeight: '700', marginTop: 14, marginBottom: 4 },
  strong:   { fontWeight: '800', color: markdownColors.emphasis },
  em:       { fontStyle: 'italic', color: markdownColors.italic },
  hr:       { backgroundColor: markdownColors.divider, height: 1, marginVertical: 14 },
  blockquote: {
    backgroundColor: markdownColors.quoteBg,
    borderLeftWidth: 3,
    borderLeftColor: markdownColors.quoteAccent,
    paddingLeft: 12,
    paddingVertical: 6,
    marginVertical: 8,
    borderRadius: 4,
  },
  bullet_list: { marginVertical: 4 },
  list_item:   { marginVertical: 2 },
  code_inline: {
    backgroundColor: markdownColors.codeBg,
    color: markdownColors.codeFg,
    fontFamily: monoFamily,
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  table: { borderWidth: 1, borderColor: colors.lightGray, borderRadius: 4, marginVertical: 12 },
  thead: { backgroundColor: colors.navy },
  th:    { color: colors.white, fontWeight: '700', padding: 8, fontSize: 12 },
  td:    { color: colors.darkGray, padding: 8, fontSize: 12, borderTopWidth: 1, borderColor: colors.lightGray },
};

// ── Report variant ────────────────────────────────────────────────────────────
// Slightly larger headings for long-form reports — gives 30+ page reports
// better hierarchy when scrolling.
export const mdStylesReport = {
  ...mdStyles,
  heading1: { ...mdStyles.heading1, fontSize: 22 },
  heading2: { ...mdStyles.heading2, fontSize: 18 },
  heading3: { ...mdStyles.heading3, fontSize: 16 },
};
