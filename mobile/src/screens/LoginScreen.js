/**
 * LoginScreen — DGA Capital v2 email + password login.
 *
 * This is the new entry point for both GP and LP users. On submit we
 * POST /api/auth/v2/login; on success the token is cached in
 * AsyncStorage and we tell the parent (App.js) to re-evaluate the
 * navigator (which branches GP vs LP).
 *
 * Identity mirrors the desktop login: navy #0A1628 screen, the official
 * DGA wordmark (assets/dga_logo_small.png) on a white chip with an
 * ice-blue border, "PORTFOLIO INTELLIGENCE" subtitle, ice-blue CTA.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  ScrollView, Image,
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
  const [code, setCode]         = useState('');     // TOTP / recovery code
  const [mfaStage, setMfaStage] = useState(false);  // true once 2FA is required
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
    if (mfaStage && !code.trim()) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const user = await loginV2(e, p, mfaStage ? code.trim() : undefined);
      await finishLogin(user, e, p);
    } catch (err) {
      if (err?.mfaRequired) {
        setMfaStage(true);
        setError('');
        haptics.onWarn?.();
      } else {
        haptics.onError?.();
        setError(err?.isAuthError
          ? (mfaStage ? 'Invalid authentication code.' : 'Invalid email or password.')
          : (err?.message || 'Login failed.'));
      }
    } finally {
      setBusy(false);
    }
  }, [email, password, code, mfaStage, finishLogin]);

  // Face ID button: authenticate, then re-login with the Keychain-stored creds.
  const handleBiometric = useCallback(async () => {
    setBusy(true);
    setError('');
    let creds = null;
    try {
      const ok = await authenticate(`Unlock with ${bioLabel}`);
      if (!ok) { setBusy(false); return; }
      creds = await getBiometricCredentials();
      if (!creds?.email || !creds?.password) {
        setError(`${bioLabel} sign-in unavailable — please log in with your password.`);
        setBusy(false);
        return;
      }
      const user = await loginV2(creds.email, creds.password);
      haptics.onSuccess?.();
      onLoggedIn?.(user);
    } catch (err) {
      if (err?.mfaRequired) {
        // Session expired and 2FA is on — biometric can't supply the code.
        setEmail(creds?.email || '');
        setMfaStage(true);
        setError('Your session expired — enter your password and 2FA code.');
      } else {
        haptics.onError?.();
        setError(err?.isAuthError ? `Saved ${bioLabel} login is no longer valid — use your password.` : (err?.message || 'Login failed.'));
      }
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
        {/* Official DGA wordmark on a white chip — the ONE brand identity */}
        <View style={styles.logoChip}>
          <Image
            source={require('../../assets/dga_logo_small.png')}
            style={styles.logoImg}
          />
        </View>

        <Text style={styles.subtitle}>PORTFOLIO INTELLIGENCE</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="rgba(255,255,255,0.5)"
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
          placeholderTextColor="rgba(255,255,255,0.5)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={mfaStage ? 'next' : 'go'}
          onSubmitEditing={handleSubmit}
        />

        {mfaStage && (
          <Text style={styles.mfaNote}>
            <Text style={{ fontWeight: '800', color: '#fff' }}>TWO-FACTOR AUTHENTICATION{'\n'}</Text>
            Enter the 6-digit code from your authenticator app
          </Text>
        )}

        {mfaStage && (
          <TextInput
            style={[styles.input, styles.inputPassword]}
            placeholder="6-digit code"
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoFocus
            maxLength={9}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />
        )}

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
            <Text style={styles.btnText}>{mfaStage ? 'VERIFY' : 'CONTINUE'}</Text>
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
              color={colors.goldLight}
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
  flex: { flex: 1, backgroundColor: '#0A1628' },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 60,
    paddingBottom: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // White chip holding the official wordmark — it sits on navy, so it needs
  // its own white background (the PNG is dark-on-transparent).
  logoChip: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderWidth: 2,
    borderColor: 'rgba(91,184,212,0.55)',
    marginBottom: 18,
  },
  logoImg: {
    width: 170,
    height: 34,
    resizeMode: 'contain',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10.5,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 28,
    textAlign: 'center',
  },
  input: {
    width: '100%',
    height: 52,
    backgroundColor: '#132040',
    borderWidth: 1,
    borderColor: 'rgba(91,184,212,0.25)',
    borderRadius: 9,
    color: '#fff',
    fontSize: 15,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  inputPassword: { letterSpacing: 3, textAlign: 'center' },
  mfaNote: {
    color: 'rgba(255,255,255,0.75)', fontSize: 12, textAlign: 'center',
    lineHeight: 18, marginBottom: 10, letterSpacing: 0.5,
  },
  btn: {
    width: '100%',
    height: 54,
    backgroundColor: colors.gold,   // ice-blue #5BB8D4 (legacy token name)
    borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 6,
    marginBottom: 16,
    shadowColor: colors.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  btnDisabled: { opacity: 0.5 },
  btnInner: { flexDirection: 'row', alignItems: 'center' },
  bioBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: 50, borderRadius: 9,
    borderWidth: 1.5, borderColor: 'rgba(91,184,212,0.4)',
    backgroundColor: 'rgba(91,184,212,0.07)',
    marginBottom: 16,
  },
  bioBtnText: {
    color: colors.goldLight,   // #84CCE3
    fontSize: 13, fontWeight: '700',
    letterSpacing: 0.6, marginLeft: 8,
  },
  btnText: {
    color: colors.navy,   // navy #0A1628 on ice-blue — the desktop pattern
    fontSize: 13,
    fontWeight: '700',
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
    color: 'rgba(255,255,255,0.25)',
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 4,
  },
});
