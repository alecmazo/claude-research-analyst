/**
 * AppHeader — shared navy header with DGA logo + gold ring, matching the web UI.
 *
 * Props:
 *   title       {string}     — screen title shown to the right of the logo
 *   right       {ReactNode}  — optional element anchored to the far right
 *   left        {ReactNode}  — optional element anchored on the far left,
 *                              before the logo. Use `<BackButton />` for
 *                              modal/stacked screens.
 *   subtitle    {string}     — optional small line below the title
 *   showLogo    {boolean}    — set false on stacked screens that already
 *                              have a back button to keep the bar compact
 *
 * The header now uses `useSafeAreaInsets()` so it sits correctly on Dynamic
 * Island, notched, and notch-less devices alike (was hard-coded paddingTop:60
 * which was wrong on three of those four cases).
 */
import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';

let dgaLogo = null;
try { dgaLogo = require('../../assets/dga_logo_small.png'); } catch (e) {}

/**
 * BackButton — convenience component for stacked-screen headers.
 *
 *   <AppHeader left={<BackButton onPress={navigation.goBack} />} title="Report" />
 */
export function BackButton({ onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={styles.backBtn}
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
    >
      <Ionicons name="chevron-back" size={24} color={colors.gold} />
    </TouchableOpacity>
  );
}

export default function AppHeader({
  title, right = null, left = null, subtitle = null, showLogo = true,
}) {
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 14) + 8;

  return (
    <View style={[styles.header, { paddingTop: topPadding }]}>
      <View style={styles.leftWrap}>
        {left}
        {showLogo && dgaLogo && (
          <View style={[styles.logoWrap, !!left && styles.logoWrapAfterBack]}>
            <Image source={dgaLogo} style={styles.logoImg} resizeMode="contain" />
          </View>
        )}
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </View>
      {right && <View style={styles.right}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.navy,
    paddingBottom: 18,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  // White box with gold border ring — mirrors CSS:
  //   background:#fff; border-radius:8px; padding:5px 10px;
  //   box-shadow: 0 0 0 1.5px gold, 0 2px 6px rgba(0,0,0,.25)
  logoWrap: {
    backgroundColor: colors.white,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1.5,
    borderColor: colors.gold,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
    elevation: 4,
  },
  // Tighten gap when a back button is also present to keep the bar compact.
  logoWrapAfterBack: {
    paddingHorizontal: 8,
  },
  logoImg: {
    width: 80,
    height: 28,
  },
  titleBlock: { flex: 1 },
  title: {
    color: colors.gold,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  subtitle: {
    color: colors.midGray,
    fontSize: 11,
    marginTop: 2,
  },
  right: {
    marginLeft: 12,
    alignItems: 'flex-end',
  },
  backBtn: {
    marginRight: -4,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
});
