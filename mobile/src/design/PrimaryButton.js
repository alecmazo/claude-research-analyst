/**
 * PrimaryButton — single source of truth for the gold "RUN" button used
 * across HomeScreen, IntelligenceScreen, PortfolioScreen, SettingsScreen.
 *
 * Variants:
 *   primary     (default) — gold fill, navy text. The "RUN" / hero action.
 *   navy        — navy fill, gold text. Secondary CTA inside cards on
 *                 dark backgrounds.
 *   ghost       — transparent fill, navy text + lightGray border. Tertiary.
 *
 * Props:
 *   title       — required, button label (uppercased internally)
 *   onPress     — required
 *   loading     — show spinner instead of label
 *   loadingLabel — optional text after spinner ("AAPL…")
 *   icon        — Ionicons / MaterialCommunityIcons name (Ionicons by default)
 *   iconFamily  — 'ion' (default) | 'mci'
 *   disabled    — also styled when loading
 *   style       — passthrough wrapper style
 *   variant     — 'primary' (default) | 'navy' | 'ghost'
 *   compact     — slimmer height, used inline with inputs
 */
import React from 'react';
import {
  TouchableOpacity, Text, ActivityIndicator, View, StyleSheet,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, radius, fontSize, letterSpacing } from './tokens';

export default function PrimaryButton({
  title,
  onPress,
  loading = false,
  loadingLabel = '',
  icon = null,
  iconFamily = 'ion',
  disabled = false,
  style,
  variant = 'primary',
  compact = false,
}) {
  const isDisabled = disabled || loading;
  const v = VARIANTS[variant] || VARIANTS.primary;

  const handlePress = () => {
    if (isDisabled) return;
    onPress?.();
  };

  const Icon = iconFamily === 'mci' ? MaterialCommunityIcons : Ionicons;

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={[
        styles.btn,
        compact && styles.btnCompact,
        { backgroundColor: v.bg, borderColor: v.border, borderWidth: v.borderWidth || 0 },
        isDisabled && styles.disabled,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator size="small" color={v.fg} />
        ) : icon ? (
          <Icon name={icon} size={16} color={v.fg} style={{ marginRight: 6 }} />
        ) : null}
        <Text style={[styles.label, { color: v.fg }, compact && styles.labelCompact]}>
          {loading && loadingLabel ? loadingLabel : title}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const VARIANTS = {
  primary: { bg: colors.gold,     fg: colors.navy, border: 'transparent' },
  navy:    { bg: colors.navy,     fg: colors.gold, border: colors.gold, borderWidth: 1.5 },
  ghost:   { bg: 'transparent',   fg: colors.navy, border: colors.lightGray, borderWidth: 1.5 },
};

const styles = StyleSheet.create({
  btn: {
    borderRadius: radius.lg,
    minHeight: 50,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCompact: {
    minHeight: 38,
    paddingHorizontal: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  label: {
    fontWeight: '800',
    fontSize: fontSize.bodyLg,
    letterSpacing: letterSpacing.button,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: fontSize.body,
  },
  disabled: { opacity: 0.5 },
});
