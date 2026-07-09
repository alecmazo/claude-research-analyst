/**
 * LockScreen — biometric gate shown on cold open when the user has enabled
 * Face ID / Touch ID. The v2 session persists in AsyncStorage, so this screen
 * stands between app launch and revealing any portfolio data.
 *
 * Unlock flow:
 *   1. Native Face ID / Touch ID prompt (auto-fired on mount).
 *   2. On success → try the cached v2 token (whoamiV2); if it's expired, fall
 *      back to a fresh loginV2 with the Keychain-stored credentials.
 *   3. Hand the resolved user (or 'login') back to App.js.
 * "Use password" drops to the normal LoginScreen.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { whoamiV2, loginV2 } from '../api/client';
import { authenticate, getBiometricCredentials, getBiometricLabel } from '../api/biometric';
import { colors, haptics } from '../design';

export default function LockScreen({ onUnlocked, onUsePassword }) {
  const [busy, setBusy]   = useState(true);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('Face ID');
  const attempted = useRef(false);

  const tryUnlock = useCallback(async () => {
    setBusy(true);
    setError('');
    const ok = await authenticate('Unlock DGA Capital');
    if (!ok) {
      haptics.onError?.();
      setError('Authentication failed.');
      setBusy(false);
      return;
    }
    // Biometric passed — resolve a usable session.
    let user = await whoamiV2();                       // cached token still valid?
    if (!user) {
      const creds = await getBiometricCredentials();   // expired → re-login silently
      if (creds?.email && creds?.password) {
        try { user = await loginV2(creds.email, creds.password); } catch {}
      }
    }
    haptics.onSuccess?.();
    onUnlocked?.(user || 'login');
  }, [onUnlocked]);

  useEffect(() => {
    getBiometricLabel().then(setLabel);
    if (!attempted.current) {
      attempted.current = true;
      tryUnlock();
    }
  }, [tryUnlock]);

  const icon = label === 'Touch ID' ? 'finger-print' : 'scan-circle-outline';

  return (
    <View style={styles.flex}>
      <View style={styles.logoWrap}>
        <Image source={require('../../assets/icon.png')} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={styles.title}>DGA Capital</Text>
      <Text style={styles.subtitle}>Locked · {label} required</Text>

      <TouchableOpacity style={styles.bioBtn} onPress={tryUnlock} disabled={busy} activeOpacity={0.85}>
        {busy ? (
          <ActivityIndicator color={colors.gold} size="small" />
        ) : (
          <Ionicons name={icon} size={44} color={colors.gold} />
        )}
      </TouchableOpacity>

      <Text style={styles.bioLabel}>
        {busy ? 'Authenticating…' : `Tap to unlock with ${label}`}
      </Text>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.pwBtn} onPress={onUsePassword} activeOpacity={0.7}>
        <Text style={styles.pwBtnText}>Use password instead</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  logoWrap: {
    width: 96, height: 96, backgroundColor: '#fff', borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginBottom: 22, overflow: 'hidden',
  },
  logo: { width: 76, height: 76 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  subtitle: {
    color: 'rgba(255,255,255,0.55)', fontSize: 10, letterSpacing: 1.8,
    textTransform: 'uppercase', marginTop: 6, marginBottom: 40, textAlign: 'center',
  },
  bioBtn: {
    width: 96, height: 96, borderRadius: 48,
    borderWidth: 1.5, borderColor: 'rgba(91,184,212,0.4)',
    backgroundColor: 'rgba(91,184,212,0.08)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  bioLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  error: { color: '#ff6b6b', fontSize: 13, fontWeight: '600', textAlign: 'center', minHeight: 18, marginBottom: 4 },
  pwBtn: { marginTop: 28, padding: 10 },
  pwBtnText: {
    color: 'rgba(255,255,255,0.45)', fontSize: 12, letterSpacing: 0.8,
    textTransform: 'uppercase', fontWeight: '600',
  },
});
