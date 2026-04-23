import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, Switch, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  api, getBaseUrl, setBaseUrl,
  getGammaEnabled, setGammaEnabled,
  getStoredPassword, login,
} from '../api/client';
import { colors } from '../components/theme';
import AppHeader from '../components/AppHeader';

export default function SettingsScreen() {
  const [baseUrl, setBaseUrlState]     = useState('');
  const [password, setPassword]        = useState('');
  const [serverStatus, setServerStatus] = useState(null);   // null | 'ok' | 'error'
  const [authStatus, setAuthStatus]    = useState(null);    // null | 'ok' | 'error'
  const [testingConn, setTestingConn]  = useState(false);
  const [savingPw, setSavingPw]        = useState(false);
  const [gammaDefault, setGammaDefault] = useState(false);

  useEffect(() => {
    getBaseUrl().then(setBaseUrlState);
    getGammaEnabled().then(setGammaDefault);
    getStoredPassword().then(pw => setPassword(pw || ''));
  }, []);

  // ── Test server connection ──────────────────────────────────────────────────
  const testConnection = async () => {
    setTestingConn(true);
    setServerStatus(null);
    try {
      await api.health();
      setServerStatus('ok');
    } catch {
      setServerStatus('error');
    } finally {
      setTestingConn(false);
    }
  };

  // ── Save server URL ─────────────────────────────────────────────────────────
  const saveUrl = async () => {
    const url = baseUrl.trim();
    if (!url.startsWith('http')) {
      Alert.alert('Invalid URL', 'URL must start with http:// or https://');
      return;
    }
    await setBaseUrl(url);
    Alert.alert('Saved', 'Server URL updated.');
  };

  // ── Save password — exchange for HMAC token via /api/auth ──────────────────
  const savePassword = async () => {
    const pw = password.trim() || 'dgacapital';
    setSavingPw(true);
    setAuthStatus(null);
    try {
      await login(pw);           // stores token in AsyncStorage automatically
      setAuthStatus('ok');
    } catch {
      setAuthStatus('error');
      Alert.alert('Wrong Password', 'The server rejected this password. Check your PORTFOLIO_PASSWORD in .env (default is "dgacapital").');
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <View style={styles.wrapper}>
      <AppHeader title="Settings" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* ── Server URL ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>API SERVER</Text>
          <Text style={styles.sectionHint}>
            Your Railway (or local) server URL — e.g. https://your-app.up.railway.app
          </Text>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={setBaseUrlState}
            placeholder="https://your-app.up.railway.app"
            placeholderTextColor={colors.midGray}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.saveBtn} onPress={saveUrl}>
              <Text style={styles.saveBtnText}>Save URL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.testBtn, testingConn && styles.disabledBtn]}
              onPress={testConnection}
              disabled={testingConn}
            >
              {testingConn
                ? <ActivityIndicator size="small" color={colors.navy} />
                : <Ionicons name="wifi-outline" size={16} color={colors.navy} />
              }
              <Text style={styles.testBtnText}>{testingConn ? 'Testing…' : 'Test'}</Text>
            </TouchableOpacity>
            {serverStatus === 'ok'    && <Ionicons name="checkmark-circle" size={22} color={colors.green} />}
            {serverStatus === 'error' && <Ionicons name="close-circle"     size={22} color={colors.red}   />}
          </View>
        </View>

        {/* ── Password ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SERVER PASSWORD</Text>
          <Text style={styles.sectionHint}>
            The password set on your server (PORTFOLIO_PASSWORD in .env).{'\n'}
            <Text style={styles.hint_default}>Default is </Text>
            <Text style={styles.hint_code}>dgacapital</Text>
            <Text style={styles.hint_default}> — leave blank to use the default.</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="dgacapital"
            placeholderTextColor={colors.midGray}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={false}   // plain text so user can see what they typed
          />
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.saveBtn, styles.saveBtnGold, savingPw && styles.disabledBtn]}
              onPress={savePassword}
              disabled={savingPw}
            >
              {savingPw
                ? <ActivityIndicator size="small" color={colors.navy} />
                : <Text style={styles.saveBtnGoldText}>Save &amp; Connect</Text>
              }
            </TouchableOpacity>
            {authStatus === 'ok'    && <Ionicons name="checkmark-circle" size={22} color={colors.green} />}
            {authStatus === 'error' && <Ionicons name="close-circle"     size={22} color={colors.red}   />}
          </View>
          {authStatus === 'ok' && (
            <Text style={styles.authOkText}>✓ Connected — token saved</Text>
          )}
        </View>

        {/* ── Defaults ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>DEFAULTS</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.switchLabelText}>Generate Gamma Presentation</Text>
              <Text style={styles.switchLabelHint}>Requires Gamma API credits</Text>
            </View>
            <Switch
              value={gammaDefault}
              onValueChange={v => { setGammaDefault(v); setGammaEnabled(v); }}
              trackColor={{ false: colors.lightGray, true: colors.gold }}
              thumbColor={colors.white}
            />
          </View>
        </View>

        {/* ── About ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ABOUT</Text>
          <Text style={styles.aboutText}>DGA Capital Research Analyst v1.0</Text>
          <Text style={styles.aboutText}>Powered by SEC EDGAR + xAI Grok</Text>
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper:   { flex: 1, backgroundColor: colors.offWhite },
  container: { flex: 1 },
  content:   { padding: 16, paddingBottom: 60 },
  section: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginBottom: 8,
  },
  sectionHint: { fontSize: 12, color: colors.midGray, lineHeight: 17, marginBottom: 10 },
  hint_default: { fontSize: 12, color: colors.midGray },
  hint_code:    { fontSize: 12, color: colors.navy, fontFamily: 'Courier New', fontWeight: '700' },
  input: {
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.navy,
    fontFamily: 'Courier New',
    marginBottom: 10,
  },
  buttonRow:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  saveBtn: {
    backgroundColor: colors.navy,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveBtnText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  saveBtnGold: {
    backgroundColor: colors.gold,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
  },
  saveBtnGoldText: { color: colors.navy, fontWeight: '800', fontSize: 13 },
  testBtn: {
    backgroundColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  disabledBtn:  { opacity: 0.5 },
  testBtnText:  { color: colors.navy, fontWeight: '700', fontSize: 13 },
  authOkText:   { fontSize: 12, color: colors.green, marginTop: 8, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  switchLabel:     { flex: 1, marginRight: 12 },
  switchLabelText: { fontSize: 14, fontWeight: '600', color: colors.darkGray },
  switchLabelHint: { fontSize: 12, color: colors.midGray, marginTop: 2 },
  aboutText:       { fontSize: 13, color: colors.darkGray, lineHeight: 22 },
});
