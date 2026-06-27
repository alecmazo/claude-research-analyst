/**
 * MoreScreen — secondary hub introduced by the Phase-2 nav consolidation.
 *
 * Keeps the bottom bar to five primary tabs (Markets · Research · Financials ·
 * Positions · Fund) and tucks the lower-traffic destinations (Podcast, Settings)
 * behind a single "More" tab so nothing feels cramped.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AppHeader from '../components/AppHeader';
import { colors, spacing, radius, shadow, fontSize } from '../design';

const ITEMS = [
  { route: 'Podcast',  icon: 'microphone',  title: 'DGA HiTech Podcast', sub: 'AI-narrated episodes' },
  { route: 'Settings', icon: 'tune',        title: 'Settings',           sub: 'Server, security, automation' },
];

export default function MoreScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.offWhite }}>
      <AppHeader title="More" showLogo />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 28 }}>
        <View style={s.card}>
          {ITEMS.map((it, i) => (
            <TouchableOpacity
              key={it.route}
              activeOpacity={0.7}
              onPress={() => navigation.navigate(it.route)}
              style={[s.row, i === ITEMS.length - 1 && { borderBottomWidth: 0 }]}
            >
              <View style={s.iconWrap}>
                <MaterialCommunityIcons name={it.icon} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{it.title}</Text>
                <Text style={s.sub}>{it.sub}</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.dim} />
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.footnote}>DGA Capital Research</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.white, borderRadius: radius.xl, paddingHorizontal: spacing.lg,
    borderWidth: 1, borderColor: colors.lightGray, ...shadow.card,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.lg,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  iconWrap: {
    width: 38, height: 38, borderRadius: radius.lg, backgroundColor: '#eef6fb',
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: fontSize.bodyLg, fontWeight: '700', color: colors.navy },
  sub: { fontSize: fontSize.caption, color: colors.midGray, marginTop: 1 },
  footnote: { textAlign: 'center', color: colors.dim, fontSize: fontSize.caption, marginTop: spacing.xl },
});
