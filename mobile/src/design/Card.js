/**
 * Card — shared white card with shadow chrome.
 *
 * Use for any "section" container on neutral backgrounds. Replaces ~12
 * inline `card:{...}` definitions across screens.
 *
 * Props:
 *   children   — content
 *   style      — passthrough style overrides
 *   variant    — 'standard' (default, white)
 *              | 'navy'     (dark navy with gold border — for hero CTAs)
 *              | 'flat'     (no shadow — for embedded sub-cards)
 *   padding    — internal padding; defaults to 16
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, radius, shadow } from './tokens';

export default function Card({
  children, style, variant = 'standard', padding = 16,
}) {
  const v = VARIANTS[variant] || VARIANTS.standard;
  return (
    <View style={[
      styles.card,
      { backgroundColor: v.bg, padding,
        borderColor: v.border, borderWidth: v.borderWidth || 0 },
      v.shadow,
      style,
    ]}>
      {children}
    </View>
  );
}

const VARIANTS = {
  standard: { bg: colors.white, shadow: shadow.card },
  navy:     { bg: colors.navy,  shadow: shadow.card,
              border: colors.gold, borderWidth: 1.5 },
  flat:     { bg: colors.white, shadow: null },
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
  },
});
