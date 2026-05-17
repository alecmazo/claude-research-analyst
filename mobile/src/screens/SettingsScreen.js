import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, ActivityIndicator, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import {
  api, getBaseUrl, setBaseUrl, resetBaseUrlToProd,
  getStoredPassword, login, logoutV2,
} from '../api/client';
import { colors } from '../components/theme';
import AppHeader from '../components/AppHeader';

// Bump on every JS / OTA push so the user can verify what's running.
const APP_BUILD = 'mobile-ui17-20260516';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtNextRun(secs) {
  if (secs == null || secs < 0) return 'Disabled';
  if (secs < 60) return `▶ in <1m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `▶ in ${h}h ${m}m`;
  return `▶ in ${m}m`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ── Automation Row ─────────────────────────────────────────────────────────────
function AutoRow({ icon, label, subtitle, enabled, onToggle, hour, minute, onHourChange, onMinuteChange, nextRunSecs }) {
  return (
    <View style={styles.autoRow}>
      {/* Label + subtitle */}
      <View style={styles.autoRowLeft}>
        <Text style={styles.autoRowLabel}>{icon} {label}</Text>
        <Text style={styles.autoRowSubtitle}>{subtitle}</Text>
        <Text style={[styles.autoNextRun, !enabled && { color: colors.midGray }]}>
          {enabled ? fmtNextRun(nextRunSecs) : 'Disabled'}
        </Text>
      </View>

      {/* Time inputs + switch */}
      <View style={styles.autoRowRight}>
        <View style={styles.timeInputRow}>
          <TextInput
            style={[styles.timeInput, !enabled && styles.timeInputDisabled]}
            value={hour}
            onChangeText={v => onHourChange(v.replace(/\D/g, '').slice(0, 2))}
            keyboardType="number-pad"
            maxLength={2}
            editable={enabled}
            selectTextOnFocus
          />
          <Text style={styles.timeColon}>:</Text>
          <TextInput
            style={[styles.timeInput, !enabled && styles.timeInputDisabled]}
            value={minute}
            onChangeText={v => onMinuteChange(v.replace(/\D/g, '').slice(0, 2))}
            keyboardType="number-pad"
            maxLength={2}
            editable={enabled}
            selectTextOnFocus
          />
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ false: colors.lightGray, true: colors.primary }}
          thumbColor={colors.white}
          style={{ marginTop: 6 }}
        />
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function SettingsScreen({ onLogout, isDemo, onSwitchToLP, onSwitchToAdmin, isLpMode }) {
  const [baseUrl, setBaseUrlState]      = useState('');
  const [password, setPassword]         = useState('');
  const [serverStatus, setServerStatus] = useState(null);
  const [authStatus, setAuthStatus]     = useState(null);
  const [testingConn, setTestingConn]   = useState(false);
  const [savingPw, setSavingPw]         = useState(false);

  // OTA
  const [serverBuild, setServerBuild]       = useState(null);
  const [updateState, setUpdateState]       = useState('idle');
  const [updateMessage, setUpdateMessage]   = useState('');

  // Automation settings
  const [autoLoading, setAutoLoading]       = useState(false);
  const [autoSaving, setAutoSaving]         = useState(false);
  const [autoSaveMsg, setAutoSaveMsg]       = useState('');
  const [briefEnabled, setBriefEnabled]     = useState(false);
  const [briefHour, setBriefHour]           = useState('06');
  const [briefMinute, setBriefMinute]       = useState('00');
  const [briefNextRun, setBriefNextRun]     = useState(null);
  const [pulseEnabled, setPulseEnabled]     = useState(false);
  const [pulseHour, setPulseHour]           = useState('07');
  const [pulseMinute, setPulseMinute]       = useState('00');
  const [pulseNextRun, setPulseNextRun]     = useState(null);

  useEffect(() => {
    getBaseUrl().then(setBaseUrlState);
    getStoredPassword().then(pw => setPassword(pw || ''));
    api.getBuild().then(j => setServerBuild(j?.build || 'unknown')).catch(() => setServerBuild('offline'));
    loadAutomationSettings();
  }, []);

  const loadAutomationSettings = async () => {
    setAutoLoading(true);
    try {
      const data = await api.getAutomationSettings();
      const db = data.daily_brief || {};
      const mp = data.market_pulse || {};
      setBriefEnabled(!!db.enabled);
      setBriefHour(pad2(db.hour ?? 6));
      setBriefMinute(pad2(db.minute ?? 0));
      setBriefNextRun(db.next_run_secs ?? null);
      setPulseEnabled(!!mp.enabled);
      setPulseHour(pad2(mp.hour ?? 7));
      setPulseMinute(pad2(mp.minute ?? 0));
      setPulseNextRun(mp.next_run_secs ?? null);
    } catch (err) {
      console.warn('loadAutomationSettings:', err.message);
    } finally {
      setAutoLoading(false);
    }
  };

  const saveAutomationSettings = async () => {
    // Validate
    const bh = parseInt(briefHour, 10);
    const bm = parseInt(briefMinute, 10);
    const ph = parseInt(pulseHour, 10);
    const pm = parseInt(pulseMinute, 10);
    if (isNaN(bh) || bh < 0 || bh > 23) { Alert.alert('Invalid Time', 'Daily Brief hour must be 0–23.'); return; }
    if (isNaN(bm) || bm < 0 || bm > 59) { Alert.alert('Invalid Time', 'Daily Brief minute must be 0–59.'); return; }
    if (isNaN(ph) || ph < 0 || ph > 23) { Alert.alert('Invalid Time', 'Market Pulse hour must be 0–23.'); return; }
    if (isNaN(pm) || pm < 0 || pm > 59) { Alert.alert('Invalid Time', 'Market Pulse minute must be 0–59.'); return; }

    setAutoSaving(true);
    setAutoSaveMsg('');
    try {
      await api.saveAutomationSettings({
        daily_brief:  { enabled: briefEnabled, hour: bh, minute: bm },
        market_pulse: { enabled: pulseEnabled, hour: ph, minute: pm },
      });
      setAutoSaveMsg('✓ Saved — takes effect on next cycle');
      // Reload to get fresh next_run_secs
      await loadAutomationSettings();
    } catch (err) {
      setAutoSaveMsg(`⚠ ${err.message}`);
    } finally {
      setAutoSaving(false);
    }
  };

  // ── OTA ────────────────────────────────────────────────────────────────────
  const checkForUpdates = async () => {
    setUpdateState('checking');
    setUpdateMessage('');
    try {
      if (__DEV__) {
        setUpdateState('error');
        setUpdateMessage('Updates only work in TestFlight / App Store builds, not Expo Go.');
        return;
      }
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateState('uptodate');
        setUpdateMessage('You\'re on the latest version.');
        return;
      }
      setUpdateState('downloading');
      setUpdateMessage('Update found — downloading…');
      await Updates.fetchUpdateAsync();
      setUpdateState('reloading');
      setUpdateMessage('Restarting to apply update…');
      setTimeout(() => Updates.reloadAsync(), 600);
    } catch (e) {
      setUpdateState('error');
      setUpdateMessage(e?.message || String(e));
    }
  };

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

  const saveUrl = async () => {
    const url = baseUrl.trim();
    if (!url.startsWith('http')) {
      Alert.alert('Invalid URL', 'URL must start with http:// or https://');
      return;
    }
    await setBaseUrl(url);
    Alert.alert('Saved', 'Server URL updated.');
  };

  const resetUrl = async () => {
    const newUrl = await resetBaseUrlToProd();
    setBaseUrlState(newUrl);
    setServerStatus(null);
    try {
      await api.health();
      setServerStatus('ok');
      Alert.alert('Reset complete', `Now using ${newUrl} — connection OK.`);
    } catch (e) {
      setServerStatus('error');
      Alert.alert('Reset complete', `Now using ${newUrl}, but the connection still failed: ${e?.message || e}`);
    }
  };

  const savePassword = async () => {
    const pw = password.trim() || 'dgacapital';
    setSavingPw(true);
    setAuthStatus(null);
    try {
      await login(pw);
      setAuthStatus('ok');
    } catch {
      setAuthStatus('error');
      Alert.alert('Wrong Password', 'The server rejected this password. Check your PORTFOLIO_PASSWORD in .env (default is "dgacapital").');
    } finally {
      setSavingPw(false);
    }
  };

  const isUpdating = updateState === 'checking' || updateState === 'downloading' || updateState === 'reloading';

  return (
    <View style={styles.wrapper}>
      <AppHeader title="Settings" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* ── Demo Mode Banner + View Switch ── */}
        {isDemo && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>🎭 Demo Mode · Read-only · Investor identities anonymised</Text>
            <TouchableOpacity
              style={styles.demoSwitchBtn}
              onPress={isLpMode ? onSwitchToAdmin : onSwitchToLP}
              activeOpacity={0.8}
            >
              <Text style={styles.demoSwitchBtnText}>
                {isLpMode ? '⚙️  Switch to Admin View' : '👁  Switch to LP View'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── API Server ── */}
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

          <TouchableOpacity style={styles.resetBtn} onPress={resetUrl}>
            <Ionicons name="refresh-outline" size={14} color={colors.midGray} />
            <Text style={styles.resetBtnText}>Reset to production server (Railway)</Text>
          </TouchableOpacity>
          <Text style={styles.sectionHint}>
            Tap if "Network request failed" — wipes any stale localhost URL and reconnects to https://dga-portfolio.up.railway.app
          </Text>
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
            secureTextEntry={false}
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

        {/* ── Automation Schedule ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>AUTOMATION SCHEDULE</Text>
          <Text style={styles.sectionHint}>
            Times are Pacific. Changes take effect on the next scheduled cycle.
          </Text>

          {autoLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} />
          ) : (
            <>
              <AutoRow
                icon="📰"
                label="Daily Brief"
                subtitle="Runs at set time, populates Today's Movers"
                enabled={briefEnabled}
                onToggle={setBriefEnabled}
                hour={briefHour}
                minute={briefMinute}
                onHourChange={setBriefHour}
                onMinuteChange={setBriefMinute}
                nextRunSecs={briefNextRun}
              />

              <View style={styles.autoSep} />

              <AutoRow
                icon="⚡"
                label="Market Pulse Scan"
                subtitle="Scans saved reports, merges into Market Pulse"
                enabled={pulseEnabled}
                onToggle={setPulseEnabled}
                hour={pulseHour}
                minute={pulseMinute}
                onHourChange={setPulseHour}
                onMinuteChange={setPulseMinute}
                nextRunSecs={pulseNextRun}
              />

              <TouchableOpacity
                style={[styles.saveBtn, styles.saveBtnGold, styles.autoSaveBtn, autoSaving && styles.disabledBtn]}
                onPress={saveAutomationSettings}
                disabled={autoSaving}
                activeOpacity={0.8}
              >
                {autoSaving
                  ? <ActivityIndicator size="small" color={colors.navy} />
                  : <Text style={styles.saveBtnGoldText}>Save Schedule</Text>
                }
              </TouchableOpacity>

              {autoSaveMsg ? (
                <Text style={[
                  styles.autoSaveMsg,
                  autoSaveMsg.startsWith('✓') && { color: colors.green },
                  autoSaveMsg.startsWith('⚠') && { color: colors.red },
                ]}>
                  {autoSaveMsg}
                </Text>
              ) : null}
            </>
          )}
        </View>

        {/* ── App Updates ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>APP UPDATES</Text>
          <Text style={styles.sectionHint}>
            Tap to pull the latest UI fixes over-the-air. No TestFlight reinstall needed.
          </Text>
          <View style={styles.versionRow}>
            <Text style={styles.versionKey}>App build</Text>
            <Text style={styles.versionVal}>{APP_BUILD}</Text>
          </View>
          <View style={styles.versionRow}>
            <Text style={styles.versionKey}>Server build</Text>
            <Text style={styles.versionVal}>{serverBuild || 'checking…'}</Text>
          </View>
          <View style={styles.versionRow}>
            <Text style={styles.versionKey}>OTA channel</Text>
            <Text style={styles.versionVal}>{Updates.channel || 'embedded'}</Text>
          </View>
          <View style={styles.versionRow}>
            <Text style={styles.versionKey}>Runtime</Text>
            <Text style={styles.versionVal}>{Updates.runtimeVersion || '—'}</Text>
          </View>

          <TouchableOpacity
            style={[styles.saveBtn, styles.saveBtnGold, isUpdating && styles.disabledBtn]}
            onPress={checkForUpdates}
            disabled={isUpdating}
          >
            {isUpdating
              ? <ActivityIndicator size="small" color={colors.navy} />
              : <Ionicons name="refresh" size={16} color={colors.navy} />}
            <Text style={styles.saveBtnGoldText}>
              {updateState === 'checking'    ? 'Checking…'
              : updateState === 'downloading' ? 'Downloading…'
              : updateState === 'reloading'   ? 'Restarting…'
              : 'Check for Updates'}
            </Text>
          </TouchableOpacity>
          {updateMessage ? (
            <Text style={[
              styles.updateStatusText,
              updateState === 'uptodate' && { color: colors.green },
              updateState === 'error'    && { color: colors.red },
            ]}>
              {updateState === 'uptodate' ? '✓ ' : updateState === 'error' ? '⚠ ' : ''}{updateMessage}
            </Text>
          ) : null}
        </View>

        {/* ── About ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ABOUT</Text>
          <Text style={styles.aboutText}>DGA Capital Research Analyst v1.0</Text>
          <Text style={styles.aboutText}>Powered by SEC EDGAR + xAI Grok</Text>
        </View>

        {/* ── Sign Out ── */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() =>
            Alert.alert(
              'Sign Out',
              'You will need to log back in with your email and password.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Sign Out',
                  style: 'destructive',
                  onPress: async () => {
                    await logoutV2();
                    onLogout?.();
                  },
                },
              ]
            )
          }
          activeOpacity={0.75}
        >
          <Ionicons name="log-out-outline" size={18} color="#DC2626" />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

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
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5, marginBottom: 8 },
  sectionHint:  { fontSize: 12, color: colors.midGray, lineHeight: 17, marginBottom: 10 },
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
    backgroundColor: colors.primary,
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
  aboutText:    { fontSize: 13, color: colors.darkGray, lineHeight: 22 },
  versionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  versionKey: { fontSize: 12, color: colors.midGray },
  versionVal: {
    fontSize: 12, color: colors.navy, fontFamily: 'Courier New', fontWeight: '600',
    maxWidth: '60%', textAlign: 'right',
  },
  updateStatusText: { fontSize: 12, color: colors.midGray, marginTop: 8, lineHeight: 16 },
  resetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 8, marginTop: 8,
  },
  resetBtnText: { fontSize: 12, fontWeight: '600', color: colors.midGray, textDecorationLine: 'underline' },

  // ── Sign Out ──
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 32,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  signOutText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#DC2626',
    letterSpacing: 0.3,
  },

  // ── Automation styles ──
  autoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  autoRowLeft: { flex: 1, paddingRight: 12 },
  autoRowLabel: { fontSize: 14, fontWeight: '700', color: colors.navy, marginBottom: 2 },
  autoRowSubtitle: { fontSize: 12, color: colors.midGray, lineHeight: 16 },
  autoNextRun: { fontSize: 11, color: colors.green, fontWeight: '600', marginTop: 4 },
  autoRowRight: { alignItems: 'flex-end' },
  timeInputRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  timeInput: {
    width: 44,
    height: 36,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 6,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: colors.navy,
    fontFamily: 'Courier New',
    backgroundColor: colors.offWhite,
  },
  timeInputDisabled: { color: colors.midGray, backgroundColor: colors.lightGray },
  timeColon: { fontSize: 18, fontWeight: '800', color: colors.navy, paddingHorizontal: 2 },
  autoSep: { height: 1, backgroundColor: colors.lightGray, marginVertical: 4 },
  autoSaveBtn: { marginTop: 16, justifyContent: 'center', height: 46 },
  autoSaveMsg: { fontSize: 12, color: colors.midGray, marginTop: 8, fontWeight: '600' },

  // ── Demo Mode styles ──
  demoBanner: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    gap: 10,
  },
  demoBannerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  demoSwitchBtn: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  demoSwitchBtnText: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
