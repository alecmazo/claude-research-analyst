/**
 * MarkdownTOC — table-of-contents drawer for long markdown reports.
 *
 * Parses h1/h2 headings out of markdown, renders them as a tappable list
 * inside a slide-down panel, and scrolls the parent list to the chosen
 * heading.
 *
 * Companion piece: <TOCToggle> — the button you place in the screen
 * header that opens/closes the panel.
 *
 * Usage (inside a screen):
 *
 *   const scrollRef = useRef(null);
 *   const [tocOpen, setTocOpen] = useState(false);
 *
 *   <TOCToggle open={tocOpen} onToggle={() => setTocOpen(o => !o)} />
 *   <MarkdownTOC
 *     markdown={report.report_md}
 *     open={tocOpen}
 *     onClose={() => setTocOpen(false)}
 *     onSelect={(heading) => scrollRef.current?.scrollToHeading(heading)}
 *   />
 *
 * The "scrollToHeading" wiring is screen-specific because mobile RN
 * doesn't give DOM-style anchors — we approximate by computing a y-offset
 * from heading index. A simple heuristic (heading_index × estimated_height)
 * is good enough for the report screens.
 */
import React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, fontSize } from './tokens';
import { haptics } from './haptics';

/**
 * Parse top-level (## h2) headings from markdown. We deliberately ignore
 * h1 because reports use it for the top title only, and skip h3+ to keep
 * the TOC scannable.
 */
export function extractHeadings(md) {
  if (!md) return [];
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip code blocks
    if (/^```/.test(line)) {
      // find next ```
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j])) j++;
      i = j;
      continue;
    }
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const level = m[1].length;
    if (level < 1 || level > 3) continue;
    out.push({
      level,
      text: m[2].trim(),
      // line index in source — used by callers as a coarse y-offset hint
      lineIndex: i,
      // headingIndex within the same level — useful for scroll heuristics
      orderIndex: out.filter(h => h.level === level).length,
    });
  }
  return out;
}

export function TOCToggle({ open, onToggle, disabled = false }) {
  return (
    <TouchableOpacity
      style={[styles.toggle, open && styles.toggleOpen]}
      onPress={() => { haptics.onPressTab(); onToggle?.(); }}
      disabled={disabled}
      activeOpacity={0.6}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Ionicons name="list-outline" size={20}
                color={open ? colors.navy : colors.gold} />
    </TouchableOpacity>
  );
}

export default function MarkdownTOC({
  markdown, open, onClose, onSelect, maxHeight = 320,
}) {
  if (!open) return null;
  const headings = extractHeadings(markdown);
  if (!headings.length) {
    return (
      <View style={[styles.panel, { maxHeight }]}>
        <Text style={styles.empty}>No sections in this document.</Text>
      </View>
    );
  }
  // Filter to h2 (most useful for navigation in reports). H1 is the
  // document title; h3 is too granular for a drawer.
  const items = headings.filter(h => h.level === 2);
  // If there are no h2s, fall back to whatever we have.
  const display = items.length ? items : headings;

  return (
    <View style={[styles.panel, { maxHeight }]}>
      <View style={styles.header}>
        <Text style={styles.title}>SECTIONS · {display.length}</Text>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={18} color={colors.midGray} />
        </TouchableOpacity>
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        {display.map((h, i) => (
          <TouchableOpacity
            key={i}
            style={[styles.item, h.level === 3 && styles.itemNested]}
            onPress={() => {
              haptics.onPressTab();
              onSelect?.(h);
              onClose?.();
            }}
            activeOpacity={0.6}
          >
            <Text style={styles.idx}>{String(i + 1).padStart(2, '0')}</Text>
            <Text style={styles.itemText} numberOfLines={2}>{h.text}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: {
    width: 36, height: 36, borderRadius: radius.lg,
    backgroundColor: colors.navyLight,
    justifyContent: 'center', alignItems: 'center',
  },
  toggleOpen: {
    backgroundColor: colors.gold,
  },
  panel: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.xl - 2,
    marginTop: 6,
    borderRadius: radius.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.10,
    shadowRadius: 10,
    elevation: 5,
    borderWidth: 1,
    borderColor: colors.lightGray,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightGray,
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: fontSize.caption, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    gap: 10,
  },
  itemNested: { paddingLeft: spacing.lg },
  idx: {
    fontSize: 10,
    fontFamily: 'Courier New',
    fontWeight: '700',
    color: colors.gold,
    minWidth: 22,
    paddingTop: 2,
  },
  itemText: {
    flex: 1,
    fontSize: fontSize.body, color: colors.darkGray,
    lineHeight: 18, fontWeight: '600',
  },
  empty: {
    fontSize: fontSize.small, color: colors.midGray,
    textAlign: 'center', paddingVertical: spacing.lg,
    fontStyle: 'italic',
  },
});
