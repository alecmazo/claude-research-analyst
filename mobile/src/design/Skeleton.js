/**
 * Skeleton — animated gray placeholder block.
 *
 * Pure RN Animated (no Reanimated dep) so it ships via OTA without a
 * native rebuild. Pulses the opacity from 0.5 → 1.0 → 0.5 in a 1.2s loop.
 *
 * Use:
 *   <Skeleton width={120} height={14} radius={4} />
 *   <SkeletonRow />            // a pre-shaped report-row skeleton
 *
 * Compose skeletons to mirror the shape of the real content for the
 * least-jarring loading experience.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { colors, radius as rad, spacing } from './tokens';

export function Skeleton({
  width = '100%', height = 14, radius = 4, style,
}) {
  const opacity = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1.0, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.55, duration: 600, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.lightGray, opacity },
        style,
      ]}
    />
  );
}

/**
 * SkeletonReportRow — one row in the saved-reports list.
 * Mirrors the shape of HomeScreen's reportRow so the swap to real
 * content doesn't reflow.
 */
export function SkeletonReportRow() {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Skeleton width={56} height={16} radius={3} />
        <View style={{ flexDirection: 'row', gap: 5, marginTop: 5 }}>
          <Skeleton width={28} height={12} radius={3} />
          <Skeleton width={28} height={12} radius={3} />
          <Skeleton width={42} height={12} radius={3} />
        </View>
      </View>
      <View style={{ alignItems: 'flex-end', minWidth: 86 }}>
        <Skeleton width={64} height={14} radius={3} />
        <View style={{ height: 4 }} />
        <Skeleton width={48} height={12} radius={3} />
      </View>
    </View>
  );
}

/**
 * SkeletonList — N skeleton rows wrapped in the same shared-card chrome
 * that HomeScreen / PaperTracker use.
 */
export function SkeletonList({ count = 5 }) {
  return (
    <View style={styles.listCard}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i}>
          <SkeletonReportRow />
          {i < count - 1 && <View style={styles.sep} />}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 11,
  },
  sep: { height: 1, backgroundColor: colors.lightGray, marginLeft: 14 },
  listCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.xl - 2,    // match HomeScreen 16px margin
    borderRadius: rad.lg + 2,
    paddingVertical: 4,
  },
});
