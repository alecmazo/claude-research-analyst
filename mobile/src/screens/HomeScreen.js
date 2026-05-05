import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, RefreshControl, Alert, Switch, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  api, getGammaEnabled, setGammaEnabled as saveGamma, getBaseUrl,
} from '../api/client';
import AppHeader from '../components/AppHeader';
import {
  colors, formatTime, formatDateCompact, haptics, SkeletonList,
} from '../design';

export default function HomeScreen({ navigation, route }) {
  const [ticker, setTicker]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [runningTicker, setRunningTicker] = useState('');  // ticker shown in RUN button while loading
  const [reports, setReports]     = useState([]);
  const [prices, setPrices]       = useState({});  // { AAPL: { price, pct_change } }
  const [refreshing, setRefreshing] = useState(false);
  const [serverOk, setServerOk]   = useState(null);
  const [serverLatencyMs, setServerLatencyMs] = useState(null);
  const [gammaEnabled, setGammaEnabled] = useState(false);  // default OFF
  const [lastLoadedAt, setLastLoadedAt] = useState(null);   // Date of last successful list load
  const [initialLoading, setInitialLoading] = useState(true); // first-load only — drives skeleton list

  const checkServer = async () => {
    const t0 = Date.now();
    try {
      await api.health();
      setServerOk(true);
      setServerLatencyMs(Date.now() - t0);
    } catch {
      setServerOk(false);
      setServerLatencyMs(null);
    }
  };

  const loadReports = async () => {
    try {
      const data = await api.listReports();
      setReports(data);
      setLastLoadedAt(new Date());
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
    } finally {
      setInitialLoading(false);
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
    haptics.onPressTab();
    await Promise.all([checkServer(), loadReports()]);
    setRefreshing(false);
  };

  const handleAnalyze = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    if (serverOk === false) {
      haptics.onError();
      Alert.alert('Server Offline', 'Cannot reach the API server. Check Settings.');
      return;
    }
    haptics.onPressPrimary();
    setLoading(true);
    setRunningTicker(t);
    try {
      const job = await api.startAnalysis(t, gammaEnabled);
      setTicker('');
      navigation.navigate('Analysis', { jobId: job.job_id, ticker: t });
    } catch (err) {
      haptics.onError();
      if (err?.isAuthError) {
        Alert.alert('Wrong Password', 'Go to Settings → Server Password. The default is "dgacapital".');
      } else {
        Alert.alert('Error', err.message);
      }
    } finally {
      setLoading(false);
      setRunningTicker('');
    }
  };

  // ── Tap status dot → show server URL + latency + state ─────────────────────
  const handleStatusDotPress = async () => {
    const url = await getBaseUrl();
    const stateLabel =
      serverOk === true  ? '✓ Connected'
    : serverOk === false ? '✗ Offline'
    :                      '— Checking…';
    const latency = serverLatencyMs != null ? `${serverLatencyMs} ms` : '—';
    Alert.alert(
      'API Server',
      `${stateLabel}\n\nURL: ${url}\nLatency: ${latency}`,
      [
        { text: 'Re-test', onPress: checkServer },
        { text: 'OK' },
      ]
    );
  };

  // ── Long-press a report row → action sheet ─────────────────────────────────
  const handleRowLongPress = (item) => {
    haptics.onLongPress();
    const downloadAndOpen = async (type) => {
      haptics.onPressPrimary();
      try {
        const url = await api.downloadUrl(item.ticker, type);
        Linking.openURL(url);
      } catch (err) {
        Alert.alert('Error', err.message);
      }
    };
    const confirmDelete = () => {
      haptics.onWarn();
      Alert.alert(
        'Delete Cached Report?',
        `Removes the local .md / .docx / .pptx for ${item.ticker}. The Dropbox copy is NOT touched — the next portfolio run can rehydrate it.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: async () => {
              try {
                await api.deleteReport(item.ticker);
                haptics.onSuccess();
                await loadReports();
              } catch (err) {
                haptics.onError();
                Alert.alert('Could not delete', err.message);
              }
          }},
        ]
      );
    };
    const reanalyze = async () => {
      haptics.onPressPrimary();
      if (serverOk === false) {
        Alert.alert('Server Offline', 'Cannot reach the API server.');
        return;
      }
      try {
        const job = await api.startAnalysis(item.ticker, gammaEnabled);
        navigation.navigate('Analysis', { jobId: job.job_id, ticker: item.ticker });
      } catch (err) {
        Alert.alert('Could not re-run', err.message);
      }
    };

    const buttons = [
      { text: `Re-run ${item.ticker} Analysis`, onPress: reanalyze },
    ];
    if (item.has_docx !== false) {
      buttons.push({ text: 'Open .docx', onPress: () => downloadAndOpen('docx') });
    }
    if (item.has_pptx) {
      buttons.push({ text: 'Open .pptx', onPress: () => downloadAndOpen('pptx') });
    }
    buttons.push({ text: 'Delete from Cache', style: 'destructive', onPress: confirmDelete });
    buttons.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert(item.ticker, 'Choose an action', buttons);
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

    // ── Target price + upside (from saved report) ──
    // Recompute upside live whenever we have both target + current quote price
    // so the % stays in sync with intraday moves. Falls back to the server's
    // stored upside_pct (computed against close-of-day price at report time).
    const target = item.price_target != null ? Number(item.price_target) : null;
    const livePrice = q?.price != null ? Number(q.price) : null;
    let targetUpside = null;
    if (target != null && livePrice != null && livePrice > 0) {
      targetUpside = ((target - livePrice) / livePrice) * 100;
    } else if (item.upside_pct != null) {
      targetUpside = Number(item.upside_pct);
    }
    const targetStr  = target != null ? `$${target.toFixed(0)}` : null;
    const upsideStr  = targetUpside != null
      ? `${targetUpside >= 0 ? '+' : ''}${targetUpside.toFixed(1)}%`
      : null;
    const targetUp   = targetUpside != null && targetUpside >= 0;

    // Compact date "May 4" — year only when not current year
    const dateStr = formatDateCompact(item.generated_at);

    return (
      <TouchableOpacity
        style={styles.reportRow}
        onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
        onLongPress={() => handleRowLongPress(item)}
        delayLongPress={350}
        activeOpacity={0.7}
      >
        {/* Left: ticker + format pills + date */}
        <View style={styles.tickerCell}>
          <Text style={styles.reportTicker}>{item.ticker}</Text>
          <View style={styles.formatRow}>
            {item.has_docx && (
              <View style={styles.docPill}>
                <Text style={styles.docPillText}>DOC</Text>
              </View>
            )}
            {item.has_pptx && (
              <View style={styles.pptPill}>
                <Text style={styles.pptPillText}>PPT</Text>
              </View>
            )}
            <Text style={styles.reportDate}>{dateStr}</Text>
          </View>
        </View>

        {/* Center: live price + today's % change */}
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

        {/* Right: 12M target + upside */}
        <View style={styles.targetCell}>
          {targetStr ? (
            <>
              <Text style={styles.targetLabel}>TGT</Text>
              <Text style={styles.targetText}>{targetStr}</Text>
              {upsideStr && (
                <Text style={[styles.upsideText, targetUp ? styles.pctUp : styles.pctDown]}>
                  {upsideStr}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.targetMissing}>—</Text>
          )}
        </View>

        <Ionicons name="chevron-forward" size={14} color={colors.midGray} style={styles.chev} />
      </TouchableOpacity>
    );
  };

  // ── Last-updated stamp ─────────────────────────────────────────────────────
  const lastLoadedStr = lastLoadedAt ? `Updated ${formatTime(lastLoadedAt)}` : '';

  return (
    <View style={styles.container}>
      {/* Header — status dot is now tappable for server details */}
      <AppHeader
        title="Research"
        right={
          <TouchableOpacity
            onPress={handleStatusDotPress}
            activeOpacity={0.6}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <View style={[
              styles.statusDot,
              { backgroundColor: serverOk === true ? colors.green : serverOk === false ? colors.red : colors.amber },
            ]} />
          </TouchableOpacity>
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
            {loading ? (
              <View style={styles.analyzeBtnInner}>
                <ActivityIndicator color={colors.navy} size="small" />
                {runningTicker ? (
                  <Text style={styles.analyzeBtnLoadingText}>{runningTicker}…</Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.analyzeBtnText}>RUN</Text>
            )}
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
        <View style={{ flex: 1 }} />
        {lastLoadedStr ? (
          <Text style={styles.lastLoadedText}>{lastLoadedStr}</Text>
        ) : null}
      </View>
      {/* Show skeleton on first load before any reports arrive */}
      {initialLoading && reports.length === 0 ? (
        <SkeletonList count={5} />
      ) : (
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
                <Text style={[styles.colHeaderText, styles.colHeaderPrice]}>PRICE</Text>
                <Text style={[styles.colHeaderText, styles.colHeaderTarget]}>TGT / UPSIDE</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="documents-outline" size={44} color={colors.lightGray} />
              <Text style={styles.emptyTitle}>No reports yet</Text>
              <Text style={styles.emptySubtitle}>
                Run your first institutional analysis in three steps:
              </Text>
              <View style={styles.emptySteps}>
                <View style={styles.emptyStep}>
                  <View style={styles.emptyStepNum}><Text style={styles.emptyStepNumText}>1</Text></View>
                  <Text style={styles.emptyStepText}>Type a ticker above (e.g. AAPL)</Text>
                </View>
                <View style={styles.emptyStep}>
                  <View style={styles.emptyStepNum}><Text style={styles.emptyStepNumText}>2</Text></View>
                  <Text style={styles.emptyStepText}>Tap RUN — Grok pulls SEC filings + live news</Text>
                </View>
                <View style={styles.emptyStep}>
                  <View style={styles.emptyStepNum}><Text style={styles.emptyStepNumText}>3</Text></View>
                  <Text style={styles.emptyStepText}>~90 sec later, your Wall Street-format report appears here</Text>
                </View>
              </View>
              <Text style={styles.emptyTip}>
                Tip: long-press any saved report row to re-run, open files, or delete from cache.
              </Text>
            </View>
          }
          contentContainerStyle={
            reports.length > 0 ? styles.listContent : styles.emptyContainer
          }
        />
      )}
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
    minWidth: 90,
    justifyContent: 'center',
    alignItems: 'center',
  },
  analyzeBtnDisabled: { opacity: 0.5 },
  analyzeBtnInner: {
    flexDirection: 'row', alignItems: 'center',
  },
  analyzeBtnText: { color: colors.navy, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  analyzeBtnLoadingText: {
    color: colors.navy, fontWeight: '800', fontSize: 12, letterSpacing: 1,
    marginLeft: 6,
  },
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
  lastLoadedText: {
    fontSize: 10, fontWeight: '600', color: colors.midGray,
    letterSpacing: 0.3,
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

  // Format pills (replaces the old 6×6 colored dots — readable at a glance)
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  docPill: {
    backgroundColor: colors.navy,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  docPillText: {
    color: colors.white,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  pptPill: {
    backgroundColor: colors.gold,
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  pptPillText: {
    color: colors.navy,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  reportDate: { fontSize: 11, color: colors.midGray, marginLeft: 3 },

  priceCell: { alignItems: 'flex-end', minWidth: 78, marginRight: 10 },
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

  // Target column — visually distinct (gold-tinged) so it doesn't compete
  // with the live-price column. Slightly smaller font to keep row density.
  targetCell: { alignItems: 'flex-end', minWidth: 70 },
  targetLabel: {
    fontSize: 7, fontWeight: '800', color: colors.gold,
    letterSpacing: 1.0, lineHeight: 10,
  },
  targetText: {
    fontSize: 13, fontWeight: '700', color: colors.darkGray,
    fontFamily: 'Courier New', lineHeight: 16,
  },
  upsideText: {
    fontSize: 11, fontWeight: '700', fontFamily: 'Courier New',
    lineHeight: 13, marginTop: 1,
  },
  targetMissing: { fontSize: 13, color: colors.lightGray, fontFamily: 'Courier New' },

  // Column-header alignment for the new 3-column layout
  colHeaderPrice:  { width: 78, marginRight: 10, textAlign: 'right' },
  colHeaderTarget: { width: 70, textAlign: 'right', color: colors.gold },

  chev: { marginLeft: 6 },

  emptyContainer: { flexGrow: 1, justifyContent: 'center', backgroundColor: 'transparent' },

  // ── New empty state — illustrated, 3-step walkthrough ─────────────────────
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 24,
    marginHorizontal: 16,
    backgroundColor: colors.white,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  emptyTitle: {
    fontSize: 17, fontWeight: '800', color: colors.navy,
    marginTop: 12, letterSpacing: 0.4,
  },
  emptySubtitle: {
    fontSize: 13, color: colors.midGray,
    textAlign: 'center', marginTop: 6, marginBottom: 18,
    lineHeight: 18,
  },
  emptySteps: { alignSelf: 'stretch', gap: 12 },
  emptyStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  emptyStepNum: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyStepNumText: {
    color: colors.gold, fontSize: 12, fontWeight: '800',
  },
  emptyStepText: {
    flex: 1,
    fontSize: 13, color: colors.darkGray, lineHeight: 18,
  },
  emptyTip: {
    fontSize: 11, color: colors.midGray,
    textAlign: 'center', marginTop: 18,
    fontStyle: 'italic', lineHeight: 16,
  },
});
