import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, RefreshControl, Alert, Switch,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { api, getGammaEnabled, setGammaEnabled as saveGamma } from '../api/client';
import { colors } from '../components/theme';
import AppHeader from '../components/AppHeader';

export default function HomeScreen({ navigation, route }) {
  const [ticker, setTicker]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [reports, setReports]     = useState([]);
  const [prices, setPrices]       = useState({});  // { AAPL: { price, pct_change } }
  const [refreshing, setRefreshing] = useState(false);
  const [serverOk, setServerOk]   = useState(null);
  const [gammaEnabled, setGammaEnabled] = useState(false);  // default OFF

  const checkServer = async () => {
    try {
      await api.health();
      setServerOk(true);
    } catch {
      setServerOk(false);
    }
  };

  const loadReports = async () => {
    try {
      const data = await api.listReports();
      setReports(data);
      // Fetch live prices in parallel (non-blocking — failures silently dropped)
      const map = {};
      await Promise.allSettled(
        data.map(async (r) => {
          try {
            const q = await api.getQuote(r.ticker);
            if (q && q.price != null) map[r.ticker] = q;
          } catch {}
        })
      );
      setPrices(map);
    } catch {
      // server may be offline; fail silently
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkServer();
      loadReports();
      getGammaEnabled().then(setGammaEnabled);
      // Pre-fill ticker if navigated here from Intelligence screen
      const prefill = route?.params?.prefillTicker;
      if (prefill) {
        setTicker(prefill.toUpperCase());
        // Clear the param so it doesn't re-fire on next focus
        navigation.setParams({ prefillTicker: undefined });
      }
    }, [route?.params?.prefillTicker])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([checkServer(), loadReports()]);
    setRefreshing(false);
  };

  const handleAnalyze = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    if (serverOk === false) {
      Alert.alert('Server Offline', 'Cannot reach the API server. Check Settings.');
      return;
    }
    setLoading(true);
    try {
      const job = await api.startAnalysis(t, gammaEnabled);
      setTicker('');
      navigation.navigate('Analysis', { jobId: job.job_id, ticker: t });
    } catch (err) {
      if (err?.isAuthError) {
        Alert.alert('Wrong Password', 'Go to Settings → Server Password. The default is "dgacapital".');
      } else {
        Alert.alert('Error', err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const renderReport = ({ item }) => {
    const q   = prices[item.ticker];
    // pct_change is now returned by the server; fall back to client-side compute
    // if the server is older or previous_close is available but pct_change is not.
    let pct = q?.pct_change ?? null;
    if (pct == null && q?.price != null && q?.previous_close) {
      const p = Number(q.price), pr = Number(q.previous_close);
      if (pr > 0) pct = parseFloat(((p - pr) / pr * 100).toFixed(2));
    }
    const priceStr = q?.price != null ? `$${Number(q.price).toFixed(2)}` : null;
    const pctStr   = pct != null ? `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%` : null;
    const isUp     = pct != null && pct >= 0;

    return (
      <TouchableOpacity
        style={styles.reportCard}
        onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
      >
        <View style={styles.reportCardLeft}>
          <Text style={styles.reportTicker}>{item.ticker}</Text>
          <Text style={styles.reportDate}>
            {new Date(item.generated_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </Text>
        </View>

        <View style={styles.reportCardRight}>
          {/* Live price + pct change */}
          {priceStr && (
            <View style={styles.priceGroup}>
              <Text style={styles.priceText}>{priceStr}</Text>
              {pctStr && (
                <Text style={[styles.pctText, isUp ? styles.pctUp : styles.pctDown]}>
                  {pctStr}
                </Text>
              )}
            </View>
          )}

          {/* Format badges */}
          {item.has_docx && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>DOCX</Text>
            </View>
          )}
          {item.has_pptx && (
            <View style={[styles.badge, styles.badgeGold]}>
              <Text style={styles.badgeText}>PPTX</Text>
            </View>
          )}
          <Ionicons name="chevron-forward" size={18} color={colors.midGray} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <AppHeader
        title="Research"
        right={
          <View style={[
            styles.statusDot,
            { backgroundColor: serverOk === true ? colors.green : serverOk === false ? colors.red : colors.amber },
          ]} />
        }
      />

      {/* Ticker input */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>ANALYZE TICKER</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="e.g. AAPL"
            placeholderTextColor={colors.midGray}
            value={ticker}
            onChangeText={t => setTicker(t.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={handleAnalyze}
          />
          <TouchableOpacity
            style={[styles.analyzeBtn, loading && styles.analyzeBtnDisabled]}
            onPress={handleAnalyze}
            disabled={loading || !ticker.trim()}
          >
            {loading
              ? <ActivityIndicator color={colors.navy} size="small" />
              : <Text style={styles.analyzeBtnText}>RUN</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={styles.gammaRow}>
          <Text style={styles.gammaLabel}>Generate Gamma Presentation</Text>
          <Switch
            value={gammaEnabled}
            onValueChange={v => { setGammaEnabled(v); saveGamma(v); }}
            trackColor={{ false: colors.lightGray, true: colors.gold }}
            thumbColor={colors.white}
          />
        </View>
      </View>

      {/* Reports list */}
      <Text style={styles.sectionTitle}>SAVED REPORTS</Text>
      <FlatList
        data={reports}
        keyExtractor={item => item.ticker}
        renderItem={renderReport}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No reports yet. Run your first analysis above.</Text>
        }
        contentContainerStyle={reports.length === 0 && styles.emptyContainer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.offWhite },
  statusDot:  { width: 10, height: 10, borderRadius: 5 },
  inputSection: {
    backgroundColor: colors.white,
    margin: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label:    { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5, marginBottom: 10 },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1,
    height: 50,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 18,
    fontWeight: '700',
    color: colors.navy,
    letterSpacing: 2,
  },
  analyzeBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingHorizontal: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  analyzeBtnDisabled: { opacity: 0.5 },
  analyzeBtnText: { color: colors.navy, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  gammaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.lightGray,
  },
  gammaLabel:   { fontSize: 14, fontWeight: '600', color: colors.darkGray },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginHorizontal: 16, marginBottom: 8,
  },
  reportCard: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  reportCardLeft:  { flex: 1 },
  reportTicker:    { fontSize: 17, fontWeight: '700', color: colors.navy, letterSpacing: 1 },
  reportDate:      { fontSize: 12, color: colors.midGray, marginTop: 2 },
  reportCardRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Live price / pct
  priceGroup:  { alignItems: 'flex-end', marginRight: 4 },
  priceText:   { fontSize: 13, fontWeight: '700', color: colors.navy, fontFamily: 'Courier New' },
  pctText:     { fontSize: 11, fontWeight: '700', fontFamily: 'Courier New', marginTop: 1 },
  pctUp:       { color: colors.green },
  pctDown:     { color: colors.red },
  // Format badges
  badge:       { backgroundColor: colors.navyLight, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4 },
  badgeGold:   { backgroundColor: colors.gold },
  badgeText:   { color: colors.white, fontSize: 10, fontWeight: '700' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText:      { textAlign: 'center', color: colors.midGray, fontSize: 14, paddingHorizontal: 40 },
});
