/**
 * MoreScreen — secondary hub (Podcast, Settings) + the Appearance control.
 * Theme-aware: reads the active palette via useTheme() and rebuilds its styles
 * when the mode changes.
 */
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AppHeader from '../components/AppHeader';
import { spacing, radius, shadow, fontSize, useTheme } from '../design';

const ITEMS = [
  { route: 'Podcast',  icon: 'microphone', title: 'DGA HiTech Podcast', sub: 'AI-narrated episodes' },
  { route: 'Settings', icon: 'tune',       title: 'Settings',           sub: 'Server, security, automation' },
];
const MODES = [
  { key: 'system', label: 'System', icon: 'cellphone' },
  { key: 'light',  label: 'Light',  icon: 'white-balance-sunny' },
  { key: 'dark',   label: 'Dark',   icon: 'moon-waning-crescent' },
];

export default function MoreScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { theme: t, mode, setMode } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <AppHeader title="More" showLogo />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 28 }}>
        {/* Destinations */}
        <View style={s.card}>
          {ITEMS.map((it, i) => (
            <TouchableOpacity
              key={it.route}
              activeOpacity={0.7}
              onPress={() => navigation.navigate(it.route)}
              style={[s.row, i === ITEMS.length - 1 && { borderBottomWidth: 0 }]}
            >
              <View style={s.iconWrap}>
                <MaterialCommunityIcons name={it.icon} size={20} color={t.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{it.title}</Text>
                <Text style={s.sub}>{it.sub}</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={t.textDim} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Appearance */}
        <Text style={s.sectionLabel}>APPEARANCE</Text>
        <View style={s.segment}>
          {MODES.map((m) => {
            const on = mode === m.key;
            return (
              <TouchableOpacity key={m.key} style={[s.seg, on && s.segOn]} activeOpacity={0.8} onPress={() => setMode(m.key)}>
                <MaterialCommunityIcons name={m.icon} size={16} color={on ? t.onAccent : t.textSecondary} />
                <Text style={[s.segTxt, { color: on ? t.onAccent : t.textSecondary }]}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={s.note}>Dark mode is rolling out — Markets, Financials, and this hub are themed; other screens follow.</Text>

        <Text style={s.footnote}>DGA Capital Research</Text>
      </ScrollView>
    </View>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
    card: {
      backgroundColor: t.surface, borderRadius: radius.xl, paddingHorizontal: spacing.lg,
      borderWidth: 1, borderColor: t.border, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
      shadowOpacity: t.cardShadowOpacity, shadowRadius: 8, elevation: 3,
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.lg,
      borderBottomWidth: 1, borderBottomColor: t.borderSubtle,
    },
    iconWrap: {
      width: 38, height: 38, borderRadius: radius.lg, backgroundColor: t.surfaceTint,
      alignItems: 'center', justifyContent: 'center',
    },
    title: { fontSize: fontSize.bodyLg, fontWeight: '700', color: t.textPrimary },
    sub: { fontSize: fontSize.caption, color: t.textSecondary, marginTop: 1 },

    sectionLabel: { fontSize: fontSize.micro, fontWeight: '800', letterSpacing: 1, color: t.textSecondary, marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: 2 },
    segment: { flexDirection: 'row', backgroundColor: t.surfaceAlt, borderRadius: radius.lg, padding: 3, gap: 3 },
    seg: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: radius.md },
    segOn: { backgroundColor: t.primary },
    segTxt: { fontSize: fontSize.small, fontWeight: '700' },
    note: { fontSize: fontSize.caption, color: t.textDim, marginTop: spacing.sm, lineHeight: 16, marginLeft: 2 },
    footnote: { textAlign: 'center', color: t.textDim, fontSize: fontSize.caption, marginTop: spacing.xl },
  });
}
