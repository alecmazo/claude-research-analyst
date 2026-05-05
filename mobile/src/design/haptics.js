/**
 * Haptic feedback abstraction.
 *
 * Currently backed by React Native's built-in `Vibration` API so we
 * can ship via OTA without a native rebuild. When `expo-haptics` is
 * added in the next TestFlight build (recommended), swap the impls
 * below for `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)`
 * etc. — call sites won't have to change.
 *
 * Use semantic functions, not raw durations:
 *   onPressTab()  — for tab-bar selection
 *   onPressPrimary() — for major actions (RUN, Save, etc.)
 *   onLongPress()  — for long-press menus
 *   onSuccess() / onError() — for completion outcomes
 */
import { Vibration, Platform } from 'react-native';

// iOS vibrations are coarser than Android's — patterns must be tuned
// per-platform. iOS supports a single short tap via Vibration.vibrate(ms);
// Android supports patterns. We keep both light to avoid annoying users.
const LIGHT = Platform.OS === 'ios' ? 10 : 15;
const MED   = Platform.OS === 'ios' ? 20 : 30;
const HEAVY = Platform.OS === 'ios' ? 35 : 50;

function safe(fn) {
  try { fn(); } catch {} // never let haptics crash the app
}

export const haptics = {
  /** Tab-bar selection — extremely subtle. */
  onPressTab: () => safe(() => Vibration.vibrate(LIGHT)),

  /** Primary action button (RUN, Save, etc.). */
  onPressPrimary: () => safe(() => Vibration.vibrate(MED)),

  /** Long-press reveal. */
  onLongPress: () => safe(() => Vibration.vibrate(MED)),

  /** Job/action completed successfully. */
  onSuccess: () => safe(() => Vibration.vibrate([0, 30, 60, 30])),

  /** Job/action failed. */
  onError:   () => safe(() => Vibration.vibrate([0, 50, 80, 50])),

  /** Toggle / switch state change. */
  onToggle:  () => safe(() => Vibration.vibrate(LIGHT)),

  /** Destructive confirm (delete). */
  onWarn:    () => safe(() => Vibration.vibrate(HEAVY)),
};
