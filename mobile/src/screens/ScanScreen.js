import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, RefreshControl, Alert,
  Animated, LayoutAnimation, UIManager, Platform,
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function sentimentColor(s) {
  if (!s) return colors.midGray;
  const u = s.toUpperCase();
  if (u === 'BULLISH')  return colors.green;
  if (u === 'BEARISH')  return colors.red;
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
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Expandable ticker card ────────────────────────────────────────────────────
function ScanCard({ ticker, result, isLoading }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(v => !v);
  };

  const pct       = result?.pct_change;
  const price     = result?.price;
  const sentiment = result?.sentiment || 'UNKNOWN';
  const markdown  = result?.markdown || '';
  const scannedAt = result?.scanned_at;
  const isUp      = pct != null && pct >= 0;

  return (
    <View style={styles.scanCard}>
      {/* Header row — always visible */}
      <TouchableOpacity style={styles.scanCardHeader} onPress={toggle} activeOpacity={0.7}>
        <View style={styles.scanCardLeft}>
          <Text style={styles.scanTicker}>{ticker}</Text>
          {price != null && (
            <View style={styles.priceRow}>
              <Text style={styles.scanPrice}>${Number(price).toFixed(2)}</Text>
              {pct != null && (
                <Text style={[styles.scanPct, isUp ? styles.pctUp : styles.pctDown]}>
                  {formatPct(pct)}
                </Text>
              )}
            </View>
          )}
          {scannedAt && (
            <Text style={styles.scanTime}>{relativeTime(scannedAt)}</Text>
          )}
        </View>

        <View style={styles.scanCardRight}>
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.gold} />
          ) : result ? (
            <View style={[styles.sentimentBadge, { backgroundColor: sentimentColor(sentiment) }]}>
              <Text style={styles.sentimentText}>{sentiment}</Text>
            </View>
          ) : null}
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.midGray}
            style={{ marginLeft: 8 }}
          />
        </View>
      </TouchableOpacity>

      {/* Expandable body */}
      {expanded && (
        <View style={styles.scanBody}>
          {isLoading ? (
            <View style={styles.scanLoadingRow}>
              <ActivityIndicator color={colors.gold} />
              <Text style={styles.scanLoadingText}>Scanning…</Text>
            </View>
          ) : result?.error ? (
            <Text style={styles.scanError}>{result.error}</Text>
          ) : (
            <Text style={styles.scanMarkdown}>{markdown}</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
function alertError(err, navigation) {
  if (err?.isAuthError) {
    Alert.alert(
      'Authentication Required',
      'Enter your server password in Settings → Auth Token.',
      [
        { text: 'Go to Settings', onPress: () => navigation?.navigate('Settings') },
        { text: 'OK', style: 'cancel' },
      ]
    );
  } else {
    Alert.alert('Error', err?.message || 'Unknown error');
  }
}

export default function ScanScreen({ navigation }) {
  const [watchlist, setWatchlist]   = useState([]);
  const [addInput, setAddInput]     = useState('');
  const [scanResults, setScanResults] = useState({});   // { TICKER: result }
  const [scanning, setScanning]     = useState(false);
  const [lastScanned, setLastScanned] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef(null);

  // ── Load watchlist + latest scan on focus ──────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      loadWatchlist();
      loadLatestScan();
      return () => {
        if (pollRef.current) clearTimeout(pollRef.current);
      };
    }, [])
  );

  const loadWatchlist = async () => {
    try {
      const data = await api.getWatchlist();
      setWatchlist(data.tickers || []);
    } catch {}
  };

  const loadLatestScan = async () => {
    try {
      const data = await api.getLatestScan();
      if (data?.results) {
        setScanResults(data.results);
        setLastScanned(data.scanned_at || null);
      }
    } catch {}
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadWatchlist(), loadLatestScan()]);
    setRefreshing(false);
  };

  // ── Add ticker ─────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    const t = addInput.trim().toUpperCase();
    if (!t) return;
    if (watchlist.includes(t)) { setAddInput(''); return; }
    try {
      const data = await api.addToWatchlist(t);
      setWatchlist(data.tickers || []);
      setAddInput('');
    } catch (err) {
      alertError(err, navigation);
    }
  };

  // ── Remove ticker ──────────────────────────────────────────────────────────
  const handleRemove = async (t) => {
    try {
      const data = await api.removeFromWatchlist(t);
      setWatchlist(data.tickers || []);
    } catch (err) {
      alertError(err, navigation);
    }
  };

  // ── Run scan ───────────────────────────────────────────────────────────────
  const handleScan = async () => {
    if (watchlist.length === 0) {
      Alert.alert('Empty Watchlist', 'Add tickers below before scanning.');
      return;
    }
    setScanning(true);
    // Clear previous results so cards show loading state
    const loading = {};
    watchlist.forEach(t => { loading[t] = null; });
    setScanResults(loading);

    try {
      const job = await api.startScan(watchlist);
      pollScan(job.job_id);
    } catch (err) {
      alertError(err, navigation);
      setScanning(false);
    }
  };

  const pollScan = (jobId) => {
    const tick = async () => {
      try {
        const data = await api.getScanJob(jobId);
        if (data.results) setScanResults(data.results);
        if (data.status === 'done' || data.status === 'error') {
          setScanning(false);
          if (data.scanned_at) setLastScanned(data.scanned_at);
          return;
        }
        pollRef.current = setTimeout(tick, 3000);
      } catch {
        setScanning(false);
      }
    };
    pollRef.current = setTimeout(tick, 2000);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
    >
      {/* Header */}
      <AppHeader
        title="Market Scan"
        subtitle={lastScanned ? `Last scan: ${relativeTime(lastScanned)}` : null}
      />

      {/* Scan button */}
      <TouchableOpacity
        style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
        onPress={handleScan}
        disabled={scanning}
        activeOpacity={0.8}
      >
        {scanning ? (
          <View style={styles.scanBtnInner}>
            <ActivityIndicator color={colors.navy} size="small" />
            <Text style={styles.scanBtnText}>Scanning…</Text>
          </View>
        ) : (
          <View style={styles.scanBtnInner}>
            <Text style={styles.scanBtnIcon}>⚡</Text>
            <Text style={styles.scanBtnText}>Scan Now</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Watchlist card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>WATCHLIST</Text>

        {/* Chips */}
        <View style={styles.chipsRow}>
          {watchlist.length === 0 ? (
            <Text style={styles.emptyChipText}>Add tickers below…</Text>
          ) : (
            watchlist.map(t => (
              <TouchableOpacity
                key={t}
                style={styles.chip}
                onPress={() => {
                  Alert.alert(`Remove ${t}?`, '', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => handleRemove(t) },
                  ]);
                }}
              >
                <Text style={styles.chipText}>{t}</Text>
                <Text style={styles.chipX}>✕</Text>
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

      {/* Per-ticker scan cards */}
      {watchlist.length > 0 && (
        <View>
          <Text style={styles.sectionLabel}>SCAN RESULTS</Text>
          {watchlist.map(t => (
            <ScanCard
              key={t}
              ticker={t}
              result={scanResults[t] || null}
              isLoading={scanning && !scanResults[t]}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  content:   { paddingBottom: 60 },

  // Scan button
  scanBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: colors.gold,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: colors.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  },
  scanBtnDisabled: { opacity: 0.6 },
  scanBtnInner:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scanBtnIcon:     { fontSize: 18 },
  scanBtnText:     { color: colors.navy, fontWeight: '800', fontSize: 15, letterSpacing: 1 },

  // Card
  card: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLabel: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5, marginBottom: 12 },

  // Chips
  chipsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  emptyChipText: { fontSize: 13, color: colors.midGray },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.navyLight,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: colors.gold, fontWeight: '700', fontSize: 13, letterSpacing: 0.5 },
  chipX:    { color: colors.midGray, fontSize: 11, marginTop: 1 },

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
    backgroundColor: colors.gold,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Section label
  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginHorizontal: 16, marginTop: 20, marginBottom: 8,
  },

  // Scan card
  scanCard: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  scanCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  scanCardLeft:  { flex: 1 },
  scanCardRight: { flexDirection: 'row', alignItems: 'center' },
  scanTicker:    { fontSize: 17, fontWeight: '800', color: colors.navy, letterSpacing: 1 },
  priceRow:      { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  scanPrice:     { fontSize: 13, fontWeight: '700', color: colors.darkGray, fontFamily: 'Courier New' },
  scanPct:       { fontSize: 12, fontWeight: '700', fontFamily: 'Courier New' },
  pctUp:         { color: colors.green },
  pctDown:       { color: colors.red },
  scanTime:      { fontSize: 11, color: colors.midGray, marginTop: 3 },

  // Sentiment badge
  sentimentBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sentimentText: { color: colors.white, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  // Body
  scanBody: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.lightGray,
    paddingTop: 12,
  },
  scanLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  scanLoadingText: { color: colors.midGray, fontSize: 13 },
  scanMarkdown:   { fontSize: 13, color: colors.darkGray, lineHeight: 20 },
  scanError:      { fontSize: 13, color: colors.red },
});
