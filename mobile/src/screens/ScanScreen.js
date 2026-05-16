import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, RefreshControl, Alert,
  LayoutAnimation, UIManager, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import { colors } from '../components/theme';
import AppHeader from '../components/AppHeader';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sentimentColor(s) {
  if (!s) return colors.midGray;
  const u = s.toUpperCase();
  if (u === 'BULLISH') return colors.green;
  if (u === 'BEARISH') return colors.red;
  return colors.amber;
}

function formatPct(pct) {
  if (pct == null) return '';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${Number(pct).toFixed(2)}%`;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Sentiment sort order: BEARISH first (risks), then BULLISH, then NEUTRAL/other
function sentimentOrder(s) {
  const u = (s || '').toUpperCase();
  if (u === 'BEARISH') return 0;
  if (u === 'BULLISH') return 1;
  return 2;
}

// Simple inline markdown: bold **text** and headings ### text
function SimpleMarkdown({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        const headingMatch = line.match(/^(#{1,3})\s+(.*)/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          return (
            <Text key={i} style={[styles.mdHeading, level === 1 && styles.mdH1, level === 2 && styles.mdH2]}>
              {headingMatch[2]}
            </Text>
          );
        }
        const parts = line.split(/\*\*(.+?)\*\*/g);
        return (
          <Text key={i} style={styles.mdBody}>
            {parts.map((part, j) =>
              j % 2 === 1 ? <Text key={j} style={styles.mdBold}>{part}</Text> : part
            )}
          </Text>
        );
      })}
    </View>
  );
}

// ── Expandable pulse card ─────────────────────────────────────────────────────
function PulseCard({ ticker, result }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(v => !v);
  };

  const sentiment = result?.sentiment || 'NEUTRAL';
  const price     = result?.price;
  const pct       = result?.pct_change;
  const markdown  = result?.markdown || '';
  const scannedAt = result?._scanned_at || result?.scanned_at;
  const isUp      = pct != null && pct >= 0;
  const preview   = markdown.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s+/gm, '').slice(0, 120);

  return (
    <View style={styles.pulseCard}>
      <TouchableOpacity style={styles.pulseCardHeader} onPress={toggle} activeOpacity={0.7}>
        <View style={styles.pulseCardLeft}>
          <View style={styles.pulseCardTitleRow}>
            <Text style={styles.pulseTicker}>{ticker}</Text>
            <View style={[styles.sentimentBadge, { backgroundColor: sentimentColor(sentiment) }]}>
              <Text style={styles.sentimentText}>{sentiment}</Text>
            </View>
          </View>
          {price != null && (
            <View style={styles.priceRow}>
              <Text style={styles.pulsePrice}>${Number(price).toFixed(2)}</Text>
              {pct != null && (
                <Text style={[styles.pulsePct, isUp ? styles.pctUp : styles.pctDown]}>
                  {formatPct(pct)}
                </Text>
              )}
            </View>
          )}
          {!expanded && preview ? (
            <Text style={styles.pulsePreview} numberOfLines={2}>{preview}…</Text>
          ) : null}
          {scannedAt && (
            <Text style={styles.pulseTime}>⟳ {relativeTime(scannedAt)}</Text>
          )}
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.midGray}
          style={{ marginLeft: 8 }}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.pulseBody}>
          <SimpleMarkdown text={markdown} />
        </View>
      )}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function ScanScreen({ navigation }) {
  const [marketTickers, setMarketTickers] = useState([]);
  const [addInput, setAddInput]           = useState('');
  const [pulseResults, setPulseResults]   = useState({}); // { TICKER: result }
  const [pulseTimestamp, setPulseTimestamp] = useState(null);
  const [scanning, setScanning]           = useState(false);
  const [scanProgress, setScanProgress]   = useState(''); // "X/N done"
  const [scanDone, setScanDone]           = useState(''); // "✓ Done — X tickers scanned"
  const [refreshing, setRefreshing]       = useState(false);
  const pollRef = useRef(null);

  // ── Load on focus ──────────────────────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      loadMarketTickers();
      loadPulse();
      return () => {
        if (pollRef.current) clearTimeout(pollRef.current);
      };
    }, [])
  );

  const loadMarketTickers = async () => {
    try {
      const data = await api.getMarketScanTickers();
      setMarketTickers(data.tickers || []);
    } catch (err) {
      console.warn('loadMarketTickers:', err.message);
    }
  };

  const loadPulse = async () => {
    try {
      const data = await api.getLatestScan();
      if (data?.results) {
        setPulseResults(data.results);
        setPulseTimestamp(data.scanned_at || null);
      }
    } catch (err) {
      console.warn('loadPulse:', err.message);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadMarketTickers(), loadPulse()]);
    setRefreshing(false);
  };

  // ── Add ticker to market scan list ────────────────────────────────────────
  const handleAdd = async () => {
    const t = addInput.trim().toUpperCase();
    if (!t) return;
    if (marketTickers.includes(t)) { setAddInput(''); return; }
    try {
      const data = await api.addMarketScanTicker(t);
      setMarketTickers(data.tickers || []);
      setAddInput('');
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  // ── Remove ticker ──────────────────────────────────────────────────────────
  const handleRemove = async (t) => {
    try {
      const data = await api.removeMarketScanTicker(t);
      setMarketTickers(data.tickers || []);
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  // ── Scan Now ───────────────────────────────────────────────────────────────
  const handleScanNow = async () => {
    if (marketTickers.length === 0) {
      Alert.alert('No Tickers', 'Add tickers to the market scan list first.');
      return;
    }
    setScanning(true);
    setScanProgress('Starting…');
    setScanDone('');

    try {
      const job = await api.startMarketScan();
      const total = job.tickers?.length || marketTickers.length;
      pollMarketScan(job.job_id, total);
    } catch (err) {
      setScanning(false);
      setScanProgress('');
      Alert.alert('Scan Error', err.message);
    }
  };

  const pollMarketScan = (jobId, total) => {
    let lastDoneCount = 0;
    const tick = async () => {
      try {
        const data = await api.getScanJob(jobId);
        const done = data.tickers_done?.length || 0;

        if (done > lastDoneCount) {
          lastDoneCount = done;
          setScanProgress(`${done}/${total} done`);
          // Refresh pulse list as each ticker completes
          loadPulse();
        }

        if (data.status === 'done' || data.status === 'error') {
          setScanning(false);
          setScanProgress('');
          if (data.status === 'done') {
            setScanDone(`✓ Done — ${done} tickers scanned`);
            loadPulse();
          } else {
            setScanDone(`⚠ Scan error: ${data.error || 'unknown'}`);
          }
          return;
        }

        pollRef.current = setTimeout(tick, 2500);
      } catch (err) {
        console.warn('pollMarketScan:', err.message);
        setScanning(false);
        setScanProgress('');
      }
    };
    pollRef.current = setTimeout(tick, 2500);
  };

  // ── Build sorted pulse list ───────────────────────────────────────────────
  const sortedPulse = Object.entries(pulseResults)
    .map(([t, r]) => ({ ticker: t, result: r }))
    .sort((a, b) => sentimentOrder(a.result?.sentiment) - sentimentOrder(b.result?.sentiment));

  const pulseCount = sortedPulse.length;

  return (
    <View style={styles.container}>
      <AppHeader title="Market Pulse" />

      <FlatList
        data={sortedPulse}
        keyExtractor={item => item.ticker}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            {/* ── Market Scan card ── */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardLabel}>MARKET SCAN</Text>
                <TouchableOpacity
                  style={[styles.scanNowBtn, scanning && styles.scanNowBtnDisabled]}
                  onPress={handleScanNow}
                  disabled={scanning}
                  activeOpacity={0.8}
                >
                  {scanning ? (
                    <View style={styles.scanBtnInner}>
                      <ActivityIndicator size="small" color={colors.navy} style={{ marginRight: 6 }} />
                      <Text style={styles.scanNowBtnText}>
                        {scanProgress || 'Scanning…'}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.scanNowBtnText}>SCAN NOW ⚡</Text>
                  )}
                </TouchableOpacity>
              </View>

              {scanDone ? (
                <Text style={[styles.scanDoneText, scanDone.startsWith('⚠') && { color: colors.amber }]}>
                  {scanDone}
                </Text>
              ) : null}

              {/* Ticker chips */}
              <View style={styles.chipsRow}>
                {marketTickers.length === 0 ? (
                  <Text style={styles.emptyChipText}>Add tickers below…</Text>
                ) : (
                  marketTickers.map(t => (
                    <TouchableOpacity
                      key={t}
                      style={styles.chip}
                      onPress={() => {
                        Alert.alert(`Remove ${t}?`, 'Remove from market scan list?', [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Remove', style: 'destructive', onPress: () => handleRemove(t) },
                        ]);
                      }}
                    >
                      <Text style={styles.chipText}>{t}</Text>
                      <Text style={styles.chipX}>×</Text>
                    </TouchableOpacity>
                  ))
                )}
              </View>

              {/* Add input */}
              <View style={styles.addRow}>
                <TextInput
                  style={styles.addInput}
                  placeholder="Add ticker…"
                  placeholderTextColor={colors.midGray}
                  value={addInput}
                  onChangeText={t => setAddInput(t.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={10}
                  returnKeyType="done"
                  onSubmitEditing={handleAdd}
                />
                <TouchableOpacity style={styles.addBtn} onPress={handleAdd}>
                  <Ionicons name="add" size={22} color={colors.navy} />
                </TouchableOpacity>
              </View>
            </View>

            {/* ── Pulse list header ── */}
            <View style={styles.pulseHeaderRow}>
              <Text style={styles.sectionLabel}>MARKET PULSE</Text>
              {pulseTimestamp && (
                <Text style={styles.pulseTimestamp}>⟳ {relativeTime(pulseTimestamp)}</Text>
              )}
              {pulseCount > 0 && (
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{pulseCount}</Text>
                </View>
              )}
            </View>
          </>
        }
        renderItem={({ item }) => (
          <PulseCard ticker={item.ticker} result={item.result} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          !refreshing ? (
            <View style={styles.emptyState}>
              <Ionicons name="pulse-outline" size={44} color={colors.lightGray} />
              <Text style={styles.emptyTitle}>No scan data yet</Text>
              <Text style={styles.emptySubtitle}>
                Add tickers above and tap SCAN NOW to populate.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  content:   { paddingBottom: 60 },

  // Market Scan card
  card: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 8,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardLabel: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5 },
  scanNowBtn: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 110,
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  scanNowBtnDisabled: { opacity: 0.65 },
  scanNowBtnText: { color: colors.navy, fontWeight: '800', fontSize: 12, letterSpacing: 0.8 },
  scanBtnInner: { flexDirection: 'row', alignItems: 'center' },
  scanDoneText: { fontSize: 12, color: colors.green, fontWeight: '600', marginBottom: 10 },

  // Chips
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  emptyChipText: { fontSize: 13, color: colors.midGray, fontStyle: 'italic' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.navyLight,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: colors.primary, fontWeight: '700', fontSize: 13, letterSpacing: 0.5 },
  chipX:    { color: colors.midGray, fontSize: 14, marginTop: -1 },

  // Add row
  addRow: { flexDirection: 'row', gap: 10 },
  addInput: {
    flex: 1,
    height: 44,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
    fontWeight: '700',
    color: colors.navy,
    letterSpacing: 1.5,
  },
  addBtn: {
    width: 44,
    height: 44,
    backgroundColor: colors.primary,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Pulse list header
  pulseHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5,
  },
  pulseTimestamp: { fontSize: 11, color: colors.midGray, flex: 1 },
  countBadge: {
    backgroundColor: colors.navy,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  countBadgeText: { color: colors.primary, fontSize: 11, fontWeight: '700' },

  // Pulse card
  pulseCard: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  pulseCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 14,
  },
  pulseCardLeft: { flex: 1 },
  pulseCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  pulseTicker: { fontSize: 17, fontWeight: '800', color: colors.navy, letterSpacing: 1 },
  sentimentBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  sentimentText:  { color: colors.white, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  pulsePrice: { fontSize: 13, fontWeight: '700', color: colors.darkGray, fontFamily: 'Courier New' },
  pulsePct:   { fontSize: 12, fontWeight: '700', fontFamily: 'Courier New' },
  pctUp:   { color: colors.green },
  pctDown: { color: colors.red },
  pulsePreview: { fontSize: 12, color: colors.midGray, lineHeight: 17, marginTop: 2 },
  pulseTime:    { fontSize: 10, color: colors.midGray, marginTop: 4 },
  pulseBody: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.lightGray,
    paddingTop: 12,
  },

  // Simple markdown
  mdHeading: { fontSize: 13, fontWeight: '700', color: colors.navy, marginTop: 10, marginBottom: 3 },
  mdH1: { fontSize: 15, fontWeight: '800' },
  mdH2: { fontSize: 14, fontWeight: '800' },
  mdBody: { fontSize: 13, color: colors.darkGray, lineHeight: 20, marginVertical: 1 },
  mdBold: { fontWeight: '800', color: colors.navy },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 32,
    paddingHorizontal: 32,
    paddingBottom: 24,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.darkGray, marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: colors.midGray, textAlign: 'center', marginTop: 6, lineHeight: 18 },
});
