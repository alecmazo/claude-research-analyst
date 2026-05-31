/**
 * Biometric (Face ID / Touch ID) unlock for DGA Capital.
 *
 * Design — a biometric *lock* over the already-persistent v2 session:
 *   • The v2 token already persists in AsyncStorage, so without this the app
 *     opens straight into the portfolio. Enabling biometrics gates that: on
 *     every cold open we require Face ID before revealing any data.
 *   • On enable we stash the user's email + password in the device Keychain
 *     (expo-secure-store, encrypted, this-device-only). That lets Face ID do a
 *     fresh loginV2 if the cached token has expired — so the user never has to
 *     retype their password once enrolled.
 *
 * This is auth-flow-level, so it covers GP and LP identically (one LoginScreen,
 * role-branched after sign-in).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIO_ENABLED_KEY = '@dga_biometric_enabled';   // AsyncStorage flag ('true'/absent)
const BIO_CRED_KEY    = 'dga_biometric_credentials'; // SecureStore key (no '@' — keychain naming)

/** Hardware present AND a face/finger actually enrolled on the device. */
export async function isBiometricAvailable() {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return false;
    return await LocalAuthentication.isEnrolledAsync();
  } catch {
    return false;
  }
}

/** Human label for the strongest enrolled modality: 'Face ID' | 'Touch ID' |
 *  'Biometrics' (Android/face) — used for button + prompt copy. */
export async function getBiometricLabel() {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const T = LocalAuthentication.AuthenticationType;
    if (types.includes(T.FACIAL_RECOGNITION)) return 'Face ID';
    if (types.includes(T.FINGERPRINT))        return 'Touch ID';
    if (types.includes(T.IRIS))               return 'Iris';
    return 'Biometrics';
  } catch {
    return 'Biometrics';
  }
}

/** Has the user turned the lock ON? */
export async function isBiometricEnabled() {
  try {
    return (await AsyncStorage.getItem(BIO_ENABLED_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Run the native Face ID / Touch ID prompt. Returns true on success. */
export async function authenticate(promptMessage) {
  try {
    const label = await getBiometricLabel();
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: promptMessage || `Unlock with ${label}`,
      cancelLabel: 'Use password',
      disableDeviceFallback: false,   // allow the device passcode as a fallback
      fallbackLabel: 'Enter passcode',
    });
    return !!res.success;
  } catch {
    return false;
  }
}

/** Enable the lock: verify a live biometric scan, then stash credentials in the
 *  Keychain and set the flag. Returns true if enabled. */
export async function enableBiometric(email, password) {
  const ok = await authenticate('Confirm to enable biometric sign-in');
  if (!ok) return false;
  try {
    await SecureStore.setItemAsync(
      BIO_CRED_KEY,
      JSON.stringify({ email: String(email || '').trim(), password: String(password || '') }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    await AsyncStorage.setItem(BIO_ENABLED_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

/** Refresh the Keychain-stored credentials WITHOUT a biometric prompt. Used to
 *  silently keep creds current after a normal password login when the lock is
 *  already enabled (e.g. it was first enabled token-only from Settings). No-op
 *  if the lock isn't enabled. */
export async function updateBiometricCredentials(email, password) {
  try {
    if (!(await isBiometricEnabled())) return;
    if (!email || !password) return;
    await SecureStore.setItemAsync(
      BIO_CRED_KEY,
      JSON.stringify({ email: String(email).trim(), password: String(password) }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  } catch {}
}

/** Turn the lock off and wipe stored credentials. */
export async function disableBiometric() {
  try { await SecureStore.deleteItemAsync(BIO_CRED_KEY); } catch {}
  try { await AsyncStorage.removeItem(BIO_ENABLED_KEY); } catch {}
}

/** Read the Keychain-stored {email, password}, or null. */
export async function getBiometricCredentials() {
  try {
    const raw = await SecureStore.getItemAsync(BIO_CRED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
