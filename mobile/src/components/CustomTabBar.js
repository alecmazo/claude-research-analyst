/**
 * CustomTabBar — premium 3D tab bar for DGA Capital
 *
 * Visual language:
 *  • Deep navy base with a two-tone top border (navy → gold hairline)
 *  • Active tab: gold rounded-pill container, icon in navy (sharp contrast)
 *    + a warm gold glow halo underneath (iOS shadow / Android elevation)
 *  • Inactive tabs: mid-gray icons, no background
 *  • All icons from MaterialCommunityIcons — more detailed / volumetric than Ionicons
 */
import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from './theme';
import { haptics } from '../design/haptics';

// ── Icon config per route name ────────────────────────────────────────────────
const TAB_CONFIG = {
  Research: {
    // Filled area stock-chart — looks like a premium financial chart
    inactive: { family: 'mci', name: 'chart-areaspline-variant' },
    active:   { family: 'mci', name: 'chart-areaspline' },
  },
  Intelligence: {
    // Lightbulb — idea generation / market intelligence
    inactive: { family: 'mci', name: 'lightbulb-outline' },
    active:   { family: 'mci', name: 'lightbulb' },
  },
  Scan: {
    // Radar sweep — high-tech, immediately reads as "scanning"
    inactive: { family: 'mci', name: 'radar' },
    active:   { family: 'mci', name: 'radar' },
  },
  Portfolio: {
    // Bank / financial-institution building — premium, not a cheap briefcase
    inactive: { family: 'mci', name: 'bank-outline' },
    active:   { family: 'mci', name: 'bank' },
  },
  Settings: {
    // Three horizontal sliders — modern, more "instrument-panel" than a plain cog.
    // Active uses the filled `tune` glyph for visible state delta.
    inactive: { family: 'mci', name: 'tune-variant' },
    active:   { family: 'mci', name: 'tune' },
  },
};

function TabIcon({ name, size, color }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CustomTabBar({ state, navigation }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {/* Top hairline: navy fades to gold accent */}
      <View style={styles.topBorder} />

      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const cfg = TAB_CONFIG[route.name];
          const iconCfg = focused ? cfg?.active : cfg?.inactive;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              haptics.onPressTab();
              navigation.navigate(route.name);
            }
          };

          return (
            <TouchableOpacity
              key={route.key}
              style={styles.tab}
              onPress={onPress}
              activeOpacity={0.75}
            >
              {/* Gold pill + glow behind the active icon */}
              <View style={[styles.pill, focused && styles.pillActive]}>
                <TabIcon
                  name={iconCfg?.name || 'circle'}
                  size={focused ? 26 : 23}
                  color={focused ? colors.navy : colors.midGray}
                />
              </View>

              <Text style={[styles.label, focused && styles.labelActive]}>
                {route.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.navy,
    // Shadow facing upward — gives a "lifted card" feel on the bottom of the screen
    ...Platform.select({
      ios: {
        shadowColor: colors.gold,
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.18,
        shadowRadius: 10,
      },
      android: {
        elevation: 24,
      },
    }),
  },

  // Two-pixel top border: navy inner, gold outer hairline
  topBorder: {
    height: 1,
    backgroundColor: colors.gold,
    opacity: 0.45,
  },

  row: {
    flexDirection: 'row',
    paddingTop: 8,
  },

  tab: {
    flex: 1,
    alignItems: 'center',
    paddingBottom: 4,
  },

  // ── Inactive pill (just a transparent hit-target) ──
  pill: {
    width: 52,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
  },

  // ── Active pill: gold fill + multi-layer glow ──
  pillActive: {
    backgroundColor: colors.gold,
    // iOS: layered glow
    ...Platform.select({
      ios: {
        shadowColor: colors.gold,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.75,
        shadowRadius: 10,
      },
      android: {
        elevation: 12,
      },
    }),
  },

  // Same fontSize / letterSpacing for active and inactive so activation
  // doesn't shift surrounding tabs by 1px. Color + weight handle the delta.
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.midGray,
    letterSpacing: 0.3,
  },
  labelActive: {
    color: colors.gold,
    fontWeight: '800',
  },
});
