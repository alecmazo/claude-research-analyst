import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, Switch, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getBaseUrl, setBaseUrl, getGammaEnabled, setGammaEnabled, getToken, setToken } from '../api/client';
import { colors } from '../components/theme';

let dgaLogo = null;
try { dgaLogo = require('../../assets/dga_logo_small.png'); } catch (e) {}

export default function SettingsScreen() {
  const [baseUrl, setBaseUrlState] = useState('');
  const [token, setTokenState]     = useState('');
  const [serverStatus, setServerStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [gammaDefault, setGammaDefault] = useState(false);

  useEffect(() => {
    getBaseUrl().then(setBaseUrlState);
    getGammaEnabled().then(setGammaDefault);
    getToken().then(setTokenState);
  }, []);

  const testConnection = async () => {
    setTesting(true);
    setServerStatus(null);
    try {
      await api.health();
      setServerStatus('ok');
    } catch (err) {
      setServerStatus('error');
      Alert.alert('Connection Failed', err.message);
    } finally {
      setTesting(false);
    }
  };

  const saveUrl = async () => {
    const url = baseUrl.trim();
    if (!url.startsWith('http')) {
      Alert.alert('Invalid URL', 'URL must start with http:// or https://');
      return;
    }
    await setBaseUrl(url);
    Alert.alert('Saved', 'API server URL updated.');
  };

  const saveToken = async () => {
    await setToken(token.trim());
    Alert.alert('Saved', 'Auth token updated.');
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.pageTitle}>Settings</Text>

      {/* API Server */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>API SERVER</Text>
        <Text style={styles.sectionHint}>
          Run the FastAPI server on your local machine or a VPS and enter its address here.
        </Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={setBaseUrlState}
            placeholder="http://192.168.1.10:8000"
            placeholderTextColor={colors.midGray}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.saveBtn} onPress={saveUrl}>
            <Text style={styles.saveBtnText}>Save</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.testBtn, testing && styles.disabledBtn]}
            onPress={testConnection}
            disabled={testing}
          >
            <Ionicons name="wifi-outline" size={16} color={colors.navy} />
            <Text style={styles.testBtnText}>{testing ? 'Testing…' : 'Test'}</Text>
          </TouchableOpacity>
          {serverStatus === 'ok' && (
            <Ionicons name="checkmark-circle" size={22} color={colors.green} />
          )}
          {serverStatus === 'error' && (
            <Ionicons name="close-circle" size={22} color={colors.red} />
          )}
        </View>
      </View>

      {/* Auth Token */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AUTH TOKEN</Text>
        <Text style={styles.sectionHint}>
          Password required to access the server. Matches the APP_PASSWORD set in your .env file.
        </Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setTokenState}
            placeholder="Enter server password"
            placeholderTextColor={colors.midGray}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={true}
          />
        </View>
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.saveBtn} onPress={saveToken}>
            <Text style={styles.saveBtnText}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Server Setup Instructions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>HOW TO START THE SERVER</Text>
        <View style={styles.codeBlock}>
          <Text style={styles.code}># Install dependencies</Text>
          <Text style={styles.code}>pip install fastapi uvicorn</Text>
          <Text style={styles.code}>{' '}</Text>
          <Text style={styles.code}># From the project root:</Text>
          <Text style={styles.code}>uvicorn api.server:app \</Text>
          <Text style={styles.code}>  --host 0.0.0.0 --port 8000</Text>
        </View>
        <Text style={styles.sectionHint}>
          Make sure your .env file has XAI_API_KEY and SEC_USER_AGENT set before starting.
        </Text>
      </View>

      {/* Defaults */}
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

      {/* About */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ABOUT</Text>
        {dgaLogo && <Image source={dgaLogo} style={styles.aboutLogo} resizeMode="contain" />}
        <Text style={styles.aboutText}>DGA Capital Research Analyst v1.0</Text>
        <Text style={styles.aboutText}>Powered by SEC EDGAR + xAI Grok</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: 16, paddingBottom: 60 },
  pageTitle: {
    fontSize: 28, fontWeight: '800', color: colors.navy,
    marginBottom: 20, marginTop: 60,
  },
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
    letterSpacing: 1.5, marginBottom: 10,
  },
  sectionHint: { fontSize: 12, color: colors.midGray, lineHeight: 17, marginBottom: 10 },
  inputRow: { marginBottom: 10 },
  input: {
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.navy,
    fontFamily: 'Courier New',
  },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  saveBtn: {
    backgroundColor: colors.navy,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  saveBtnText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  testBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  disabledBtn: { opacity: 0.5 },
  testBtnText: { color: colors.navy, fontWeight: '700', fontSize: 14 },
  codeBlock: {
    backgroundColor: colors.navy,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  code: { color: '#A8D8A0', fontFamily: 'Courier New', fontSize: 12, lineHeight: 20 },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  switchLabel: { flex: 1, marginRight: 12 },
  switchLabelText: { fontSize: 14, fontWeight: '600', color: colors.darkGray },
  switchLabelHint: { fontSize: 12, color: colors.midGray, marginTop: 2 },
  aboutText: { fontSize: 13, color: colors.darkGray, lineHeight: 22 },
  aboutLogo: { width: 140, height: 56, marginBottom: 10 },
});
