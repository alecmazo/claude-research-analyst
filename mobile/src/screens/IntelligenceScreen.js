/**
 * IntelligenceScreen — DGA Capital Market Intelligence
 *
 * Runs a Grok-powered macro → sector → company idea generation pass
 * over the past 30, 60, or 90 days of X + web news.
 *
 * Flow:
 *  1. On focus: load latest persisted result (if any)
 *  2. User selects time horizon (30 / 60 / 90 days) via pill toggle
 *  3. Taps "Run Intelligence" → POST /api/intelligence → polls job
 *  4. Results rendered as markdown; **TICKER** tokens become tappable
 *     chips that navigate to the Research tab with the ticker pre-filled
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import { colors } from '../components/theme';
import AppHeader from '../components/AppHeader';

const HORIZON_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '60 days', value: 60 },
  { label: '90 days', value: 90 },
];

const POLL_INTERVAL_MS = 3000;

export default function IntelligenceScreen({ navigation }) {
  const [days, setDays]           = useState(30);
  const [running, setRunning]     = useState(false);
  const [result, setResult]       = useState(null);   // last completed result
  const [status, setStatus]       = useState('');     // human-readable status line
  const [error, setError]         = useState(null);
  const pollRef                   = useRef(null);

  // ── Load latest persisted result on tab focus ──────────────────────────────
  useFocusEffect(
    useCallback(() => {
      api.getLatestIntelligence()
        .then(data => {
          if (data?.exists && data?.markdown) setResult(data);
        })
        .catch(() => {}); // server offline — silent
    }, [])
  );

  // ── Polling ────────────────────────────────────────────────────────────────
  const startPolling = (jobId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await api.getIntelligenceJob(jobId);
        if (job.status === 'done') {
          clearInterval(pollRef.current);
          setRunning(false);
          setStatus('');
          if (job.result?.ok) {
            setResult(job.result);
            setError(null);
          } else {
            setError(job.result?.error || job.error || 'Unknown error');
          }
        } else if (job.status === 'failed') {
          clearInterval(pollRef.current);
          setRunning(false);
          setStatus('');
          setError(job.error || 'Intelligence run failed');
        } else {
          setStatus(job.status === 'running'
            ? 'Scanning X and web for market signals…'
            : 'Queued — starting shortly…');
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setRunning(false);
        setStatus('');
        setError(err.message);
      }
    }, POLL_INTERVAL_MS);
  };

  // ── Run handler ────────────────────────────────────────────────────────────
  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setStatus('Queued — starting shortly…');
    try {
      const job = await api.startIntelligence(days);
      startPolling(job.job_id);
    } catch (err) {
      setRunning(false);
      setStatus('');
      if (err?.isAuthError) {
        Alert.alert('Wrong Password', 'Go to Settings → Server Password.');
      } else {
        setError(err.message);
      }
    }
  };

  // ── Ticker chip navigation ─────────────────────────────────────────────────
  // Tapping a ticker navigates to the Home tab (Research) with ticker pre-filled.
  // We use the parent Tab navigator to switch tabs.
  const openTicker = (ticker) => {
    // Navigate to the Research stack root; HomeScreen will receive the ticker param.
    navigation.getParent()?.navigate('Research', {
      screen: 'Home',
      params: { prefillTicker: ticker },
    });
  };

  // ── Track-this-brief: lock in equal-weight paper portfolio ────────────────
  const [tracking, setTracking] = useState(false);
  const handleTrackBrief = () => {
    if (!result?.tickers?.length) return;
    const tickers = result.tickers.slice(0, 20);  // clamp at 20
    Alert.alert(
      'Lock in paper portfolio?',
      `Equal-weight ${tickers.length} tickers from this ${result.days}-day brief. Today's closing prices become cost basis. You can adjust weights on the web.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock In', onPress: async () => {
            setTracking(true);
            try {
              const eq = +(1 / tickers.length).toFixed(6);
              const today = new Date().toLocaleDateString('en-US',
                { month: 'short', day: 'numeric' });
              await api.createTracker({
                name: `Brief — ${today}, ${result.days}D`,
                holdings: tickers.map(t => ({ ticker: t, weight: eq })),
                source: {
                  lookback_days: result.days,
                  brief_generated_at: result.generated_at,
                },
              });
              Alert.alert(
                'Locked in',
                'Paper portfolio created. View it on Portfolio → Tracker.',
                [
                  { text: 'OK' },
                  { text: 'View Now', onPress: () => {
                      navigation.getParent()?.navigate('Portfolio', {
                        screen: 'PaperTracker',
                      });
                  }},
                ]
              );
            } catch (e) {
              Alert.alert('Could not lock in', e.message);
            } finally {
              setTracking(false);
            }
          }
        },
      ]
    );
  };

  // ── Result sections for tappable tickers ──────────────────────────────────
  // Parse **TICKER** tokens in the markdown and render them as tappable gold chips.
  const renderTickerChips = (tickers) => {
    if (!tickers?.length) return null;
    return (
      <View style={styles.chipsSection}>
        <View style={styles.chipsHeader}>
          <Text style={styles.chipsLabel}>TICKERS IN THIS BRIEF</Text>
          <TouchableOpacity
            style={[styles.trackBtn, tracking && { opacity: 0.5 }]}
            onPress={handleTrackBrief}
            disabled={tracking}
            activeOpacity={0.8}
          >
            {tracking ? (
              <ActivityIndicator size="small" color={colors.gold} />
            ) : (
              <>
                <Ionicons name="bookmark" size={12} color={colors.gold} />
                <Text style={styles.trackBtnText}>Track Brief</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
        <View style={styles.chipsRow}>
          {tickers.map(t => (
            <TouchableOpacity
              key={t}
              style={styles.chip}
              onPress={() => openTicker(t)}
            >
              <Text style={styles.chipText}>{t}</Text>
              <Ionicons name="arrow-forward" size={11} color={colors.navy} style={{ marginLeft: 3 }} />
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  };

  return (
    <View style={styles.container}>
      <AppHeader title="Intelligence" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Config card ── */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LOOKBACK WINDOW</Text>
          <View style={styles.horizonRow}>
            {HORIZON_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[styles.pill, days === opt.value && styles.pillActive]}
                onPress={() => !running && setDays(opt.value)}
                activeOpacity={0.75}
              >
                <Text style={[styles.pillText, days === opt.value && styles.pillTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.runBtn, running && styles.runBtnDisabled]}
            onPress={handleRun}
            disabled={running}
            activeOpacity={0.8}
          >
            {running ? (
              <View style={styles.runBtnInner}>
                <ActivityIndicator size="small" color={colors.navy} style={{ marginRight: 8 }} />
                <Text style={styles.runBtnText}>RUNNING…</Text>
              </View>
            ) : (
              <View style={styles.runBtnInner}>
                <Ionicons name="bulb" size={16} color={colors.navy} style={{ marginRight: 6 }} />
                <Text style={styles.runBtnText}>RUN INTELLIGENCE</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Status line while running */}
          {running && status ? (
            <Text style={styles.statusText}>{status}</Text>
          ) : null}

          {/* Error */}
          {!running && error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </View>

        {/* ── Results ── */}
        {result?.markdown ? (
          <View style={styles.resultCard}>
            {/* Meta bar */}
            <View style={styles.resultMeta}>
              <View style={styles.resultMetaLeft}>
                <View style={styles.liveBadge}>
                  <Text style={styles.liveBadgeText}>⚡ LIVE BRIEF</Text>
                </View>
                <Text style={styles.resultDays}>{result.days}-day lookback</Text>
              </View>
              <Text style={styles.resultDate}>{formatDate(result.generated_at)}</Text>
            </View>

            {/* Tappable ticker chips */}
            {renderTickerChips(result.tickers)}

            {/* Markdown body */}
            <Markdown style={mdStyles}>
              {result.markdown}
            </Markdown>
          </View>
        ) : !running ? (
          <View style={styles.emptyState}>
            <Ionicons name="bulb-outline" size={48} color={colors.lightGray} />
            <Text style={styles.emptyTitle}>No intelligence brief yet</Text>
            <Text style={styles.emptySubtitle}>
              Select a lookback window and tap Run Intelligence.{'\n'}
              Grok will scan the latest X posts and web news to surface macro themes,
              sector rotations, and specific company ideas.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: colors.offWhite },
  scroll:      { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },

  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.midGray,
    letterSpacing: 1.5,
    marginBottom: 12,
  },

  // ── Horizon pills ──
  horizonRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  pill: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.offWhite,
  },
  pillActive: {
    borderColor: colors.gold,
    backgroundColor: colors.gold,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.midGray,
  },
  pillTextActive: {
    color: colors.navy,
    fontWeight: '800',
  },

  // ── Run button ──
  runBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnDisabled: { opacity: 0.55 },
  runBtnInner:    { flexDirection: 'row', alignItems: 'center' },
  runBtnText:     { color: colors.navy, fontWeight: '800', fontSize: 14, letterSpacing: 1 },

  statusText: {
    fontSize: 12,
    color: colors.midGray,
    textAlign: 'center',
    marginTop: 10,
    fontStyle: 'italic',
  },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    padding: 10,
    backgroundColor: 'rgba(239,68,68,0.07)',
    borderRadius: 6,
  },
  errorText: { color: colors.red, fontSize: 13, flex: 1 },

  // ── Result card ──
  resultCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  resultMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightGray,
  },
  resultMetaLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveBadge: {
    backgroundColor: colors.navy,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  liveBadgeText: { color: colors.gold, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  resultDays:  { fontSize: 11, color: colors.midGray, fontWeight: '600' },
  resultDate:  { fontSize: 11, color: colors.midGray },

  // ── Ticker chips ──
  chipsSection: { marginBottom: 14 },
  chipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  chipsLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.midGray,
    letterSpacing: 1.2,
  },
  trackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.navy,
    borderColor: colors.gold,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    minHeight: 26,
  },
  trackBtnText: {
    color: colors.gold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.gold,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    color: colors.navy,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },

  // ── Empty state ──
  emptyState: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.darkGray,
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 13,
    color: colors.midGray,
    textAlign: 'center',
    lineHeight: 20,
  },
});

// ── Markdown styles ───────────────────────────────────────────────────────────
const mdStyles = {
  body:     { color: colors.darkGray, fontSize: 14, lineHeight: 22 },
  heading1: { color: colors.navy, fontSize: 20, fontWeight: '800', marginTop: 20, marginBottom: 8 },
  heading2: {
    color: colors.navy, fontSize: 17, fontWeight: '700',
    marginTop: 18, marginBottom: 6,
    paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#E8EDF3',
  },
  heading3: { color: colors.darkGray, fontSize: 15, fontWeight: '700', marginTop: 14, marginBottom: 4 },
  strong:   { fontWeight: '800', color: colors.navy },
  em:       { fontStyle: 'italic', color: colors.midGray },
  hr:       { backgroundColor: '#E8EDF3', height: 1, marginVertical: 14 },
  blockquote: {
    backgroundColor: '#F0F4FA',
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
    paddingLeft: 12,
    paddingVertical: 6,
    marginVertical: 8,
    borderRadius: 4,
  },
  bullet_list: { marginVertical: 4 },
  list_item:   { marginVertical: 2 },
  code_inline: {
    backgroundColor: colors.lightGray,
    color: colors.navy,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
};
