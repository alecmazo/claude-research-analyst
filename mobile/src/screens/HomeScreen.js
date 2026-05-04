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

    // Compact date "May 4" — year only when not current year
    const dt   = new Date(item.generated_at);
    const yr   = dt.getFullYear();
    const nowY = new Date().getFullYear();
    const dateStr = dt.toLocaleDateString('en-US',
      yr === nowY
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: '2-digit' });

    return (
      <TouchableOpacity
        style={styles.reportRow}
        onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
        activeOpacity={0.7}
      >
        {/* Left: ticker + tiny format dots underneath */}
        <View style={styles.tickerCell}>
          <Text style={styles.reportTicker}>{item.ticker}</Text>
          <View style={styles.formatDotsRow}>
            {item.has_docx && <View style={styles.docxDot} />}
            {item.has_pptx && <View style={styles.pptxDot} />}
            <Text style={styles.reportDate}>{dateStr}</Text>
          </View>
        </View>

        {/* Right: tightly-packed price column */}
        <View style={styles.priceCell}>
          {priceStr ? (
            <>
              <Text style={styles.priceText}>{priceStr}</Text>
              {pctStr && (
                <Text style={[styles.pctText, isUp ? styles.pctUp : styles.pctDown]}>
                  {pctStr}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.priceMissing}>—</Text>
          )}
        </View>

        <Ionicons name="chevron-forward" size={14} color={colors.midGray} style={styles.chev} />
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
      <View style={styles.listHeaderRow}>
        <Text style={styles.sectionTitle}>SAVED REPORTS</Text>
        {reports.length > 0 && (
          <Text style={styles.countBadge}>{reports.length}</Text>
        )}
      </View>
      <FlatList
        data={reports}
        keyExtractor={item => item.ticker}
        renderItem={renderReport}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        ListHeaderComponent={
          reports.length > 0 ? (
            <View style={styles.colHeader}>
              <Text style={[styles.colHeaderText, { flex: 1 }]}>TICKER</Text>
              <Text style={[styles.colHeaderText, { textAlign: 'right' }]}>PRICE / CHG</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>No reports yet. Run your first analysis above.</Text>
        }
        contentContainerStyle={
          reports.length > 0 ? styles.listContent : styles.emptyContainer
        }
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

  // Section header row
  listHeaderRow: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5,
  },
  countBadge: {
    marginLeft: 8,
    fontSize: 11, fontWeight: '700', color: colors.gold,
    backgroundColor: colors.navy,
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
    overflow: 'hidden',
  },

  // List container - one shared card holds all rows for tighter info density
  listContent: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    borderRadius: 10,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },

  // Column header row (TICKER / PRICE)
  colHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: colors.lightGray,
  },
  colHeaderText: {
    fontSize: 9, fontWeight: '800', color: colors.midGray,
    letterSpacing: 1.2,
  },

  // Compact two-line row, ~46px tall vs old ~70px
  reportRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 9,
  },
  sep: { height: 1, backgroundColor: colors.lightGray, marginLeft: 14 },
  tickerCell:    { flex: 1 },
  reportTicker:  {
    fontSize: 15, fontWeight: '800', color: colors.navy,
    letterSpacing: 1.2, lineHeight: 18,
  },
  formatDotsRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  docxDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: colors.navyLight,
  },
  pptxDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: colors.gold,
  },
  reportDate: { fontSize: 11, color: colors.midGray, marginLeft: 2 },

  priceCell: { alignItems: 'flex-end', minWidth: 86 },
  priceText: {
    fontSize: 14, fontWeight: '700', color: colors.navy,
    fontFamily: 'Courier New', lineHeight: 16,
  },
  pctText: {
    fontSize: 11, fontWeight: '700', fontFamily: 'Courier New',
    lineHeight: 13, marginTop: 1,
  },
  pctUp:        { color: colors.green },
  pctDown:      { color: colors.red },
  priceMissing: { fontSize: 14, color: colors.lightGray, fontFamily: 'Courier New' },

  chev: { marginLeft: 6 },

  emptyContainer: { flexGrow: 1, justifyContent: 'center', backgroundColor: 'transparent' },
  emptyText: {
    textAlign: 'center', color: colors.midGray, fontSize: 14,
    paddingHorizontal: 40, paddingVertical: 32,
  },
});
