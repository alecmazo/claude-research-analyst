/**
 * LoginScreen — DGA Capital v2 email + password login.
 *
 * This is the new entry point for both GP and LP users. On submit we
 * POST /api/auth/v2/login; on success the token is cached in
 * AsyncStorage and we tell the parent (App.js) to re-evaluate the
 * navigator (which branches GP vs LP).
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  Image, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { loginV2 } from '../api/client';
import {
  isBiometricAvailable, isBiometricEnabled, getBiometricLabel,
  enableBiometric, authenticate, getBiometricCredentials, updateBiometricCredentials,
} from '../api/biometric';
import { colors, haptics } from '../design';

export default function LoginScreen({ onLoggedIn }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  // Biometrics: `bioEnabled` → already enrolled (show the Face ID button);
  // `bioLabel` drives copy ('Face ID' / 'Touch ID').
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioLabel, setBioLabel]     = useState('Face ID');
  const pwRef = useRef(null);

  useEffect(() => {
    (async () => {
      setBioEnabled(await isBiometricEnabled());
      setBioLabel(await getBiometricLabel());
    })();
  }, []);

  // After a successful password login, offer to enable the biometric lock
  // (once), then proceed into the app either way.
  const finishLogin = useCallback(async (user, e, p) => {
    try {
      if (await isBiometricEnabled()) {
        // Already enrolled — silently keep the stored creds fresh so a future
        // token expiry can re-login (covers a Settings token-only enable).
        await updateBiometricCredentials(e, p);
      } else if (await isBiometricAvailable()) {
        const label = await getBiometricLabel();
        await new Promise((resolve) => {
          Alert.alert(
            `Enable ${label}?`,
            `Unlock DGA Capital with ${label} next time instead of typing your password.`,
            [
              { text: 'Not now', style: 'cancel', onPress: resolve },
              { text: `Enable ${label}`, onPress: async () => { await enableBiometric(e, p); resolve(); } },
            ],
            { cancelable: false },
          );
        });
      }
    } catch {}
    haptics.onSuccess?.();
    onLoggedIn?.(user);
  }, [onLoggedIn]);

  const handleSubmit = useCallback(async () => {
    const e = email.trim();
    const p = password;
    if (!e || !p) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const user = await loginV2(e, p);
      await finishLogin(user, e, p);
    } catch (err) {
      haptics.onError?.();
      setError(err?.isAuthError ? 'Invalid email or password.' : (err?.message || 'Login failed.'));
    } finally {
      setBusy(false);
    }
  }, [email, password, finishLogin]);

  // Face ID button: authenticate, then re-login with the Keychain-stored creds.
  const handleBiometric = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const ok = await authenticate(`Unlock with ${bioLabel}`);
      if (!ok) { setBusy(false); return; }
      const creds = await getBiometricCredentials();
      if (!creds?.email || !creds?.password) {
        setError(`${bioLabel} sign-in unavailable — please log in with your password.`);
        setBusy(false);
        return;
      }
      const user = await loginV2(creds.email, creds.password);
      haptics.onSuccess?.();
      onLoggedIn?.(user);
    } catch (err) {
      haptics.onError?.();
      setError(err?.isAuthError ? `Saved ${bioLabel} login is no longer valid — use your password.` : (err?.message || 'Login failed.'));
    } finally {
      setBusy(false);
    }
  }, [bioLabel, onLoggedIn]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        <Text style={styles.subtitle}>Portfolio Access · Authentication Required</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="rgba(255,255,255,0.30)"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          returnKeyType="next"
          onSubmitEditing={() => pwRef.current?.focus()}
        />

        <TextInput
          ref={pwRef}
          style={[styles.input, styles.inputPassword]}
          placeholder="Password"
          placeholderTextColor="rgba(255,255,255,0.30)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />

        <TouchableOpacity
          style={[styles.btn, busy && styles.btnDisabled]}
          onPress={handleSubmit}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <View style={styles.btnInner}>
              <ActivityIndicator color={colors.navy} size="small" />
              <Text style={[styles.btnText, { marginLeft: 8 }]}>SIGNING IN…</Text>
            </View>
          ) : (
            <Text style={styles.btnText}>CONTINUE</Text>
          )}
        </TouchableOpacity>

        {bioEnabled && (
          <TouchableOpacity
            style={styles.bioBtn}
            onPress={handleBiometric}
            disabled={busy}
            activeOpacity={0.8}
          >
            <Ionicons
              name={bioLabel === 'Touch ID' ? 'finger-print' : 'scan-circle-outline'}
              size={20}
              color={colors.gold}
            />
            <Text style={styles.bioBtnText}>Sign in with {bioLabel}</Text>
          </TouchableOpacity>
        )}

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.hint}>GP &amp; LP login · portfolio.dgacapital.com</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.navy },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 60,
    paddingBottom: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: {
    width: 120, height: 120,
    backgroundColor: '#fff',
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 26,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 10,
    overflow: 'hidden',
  },
  logo: { width: 96, height: 96 },
  subtitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    marginBottom: 28,
    textAlign: 'center',
  },
  input: {
    width: '100%',
    height: 52,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 11,
    color: '#fff',
    fontSize: 15,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  inputPassword: { letterSpacing: 3, textAlign: 'center' },
  btn: {
    width: '100%',
    height: 54,
    backgroundColor: colors.primary,
    borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 6,
    marginBottom: 16,
    borderTopWidth: 1, borderTopColor: colors.primaryLight,
    borderBottomWidth: 2, borderBottomColor: colors.primaryDark,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.55,
    shadowRadius: 12,
    elevation: 8,
  },
  btnDisabled: { opacity: 0.5 },
  btnInner: { flexDirection: 'row', alignItems: 'center' },
  bioBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: 50, borderRadius: 11,
    borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.4)',
    backgroundColor: 'rgba(212,175,55,0.07)',
    marginBottom: 16,
  },
  bioBtnText: {
    color: colors.gold, fontSize: 13, fontWeight: '700',
    letterSpacing: 0.6, marginLeft: 8,
  },
  btnText: {
    color: colors.navy,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2.2,
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    minHeight: 18,
    marginBottom: 8,
  },
  hint: {
    color: 'rgba(255,255,255,0.30)',
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 4,
  },
});
