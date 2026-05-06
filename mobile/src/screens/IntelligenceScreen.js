/**
 * IntelligenceScreen — DGA Capital Market Intelligence + Ideas
 *
 * Runs a Grok-powered sector-focused analysis to identify 10–15 companies
 * with the most asymmetric return potential in the selected sector.
 * "Best Mix" finds the best cross-sector opportunities.
 *
 * Flow:
 *  1. On focus: load latest persisted result (if any)
 *  2. User selects sector via pill toggle (Tech, Energy, Healthcare, etc.)
 *  3. Taps "Run Intelligence" → POST /api/intelligence → polls job
 *  4. Results rendered as markdown; **TICKER** tokens become tappable
 *     chips that navigate to the Research tab with the ticker pre-filled
 *  5. "Track Brief" locks tickers into a paper portfolio (visible below)
 *  6. Paper Portfolios section shows all locked briefs → navigate to tracker
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, mdStyles, haptics, formatDate } from '../design';

const SECTOR_OPTIONS = [
  { label: 'Tech',        value: 'Tech' },
  { label: 'Energy',      value: 'Energy' },
  { label: 'Healthcare',  value: 'Healthcare' },
  { label: 'Financials',  value: 'Financials' },
  { label: 'Consumer',    value: 'Consumer' },
  { label: 'Industrials', value: 'Industrials' },
  { label: 'Real Estate', value: 'Real Estate' },
  { label: '✦ Best Mix',  value: 'Best Mix', isBestMix: true },
];

const POLL_INTERVAL_MS = 3000;

export default function IntelligenceScreen({ navigation }) {
  const [sector, setSector]       = useState('Tech');
  const [running, setRunning]     = useState(false);
  const [result, setResult]       = useState(null);   // last completed result
  const [resultKind, setResultKind] = useState(null); // 'intel' | 'brief'
  const [status, setStatus]       = useState('');     // human-readable status line
  const [error, setError]         = useState(null);
  const [briefRunning, setBriefRunning] = useState(false);
  const pollRef                   = useRef(null);

  // ── Load latest persisted result on tab focus ──────────────────────────────
  // Show the freshest of (intelligence brief, daily brief) — daily briefs
  // change every morning so they usually win.
  useFocusEffect(
    useCallback(() => {
      Promise.allSettled([
        api.getLatestIntelligence(),
        api.getLatestDailyBrief(),
      ]).then(([intelRes, briefRes]) => {
        const intel = intelRes.status === 'fulfilled' && intelRes.value?.exists
          ? intelRes.value : null;
        const brief = briefRes.status === 'fulfilled' && briefRes.value?.exists
          ? briefRes.value : null;
        const intelDate = intel ? new Date(intel.generated_at).getTime() : 0;
        const briefDate = brief ? new Date(brief.generated_at).getTime() : 0;
        if (briefDate >= intelDate && brief?.markdown) {
          setResult(brief); setResultKind('brief');
        } else if (intel?.markdown) {
          setResult(intel); setResultKind('intel');
        }
      }).catch(() => {});
    }, [])
  );

  // ── Polling ────────────────────────────────────────────────────────────────
  // kind = 'intel' (long-horizon brief) | 'brief' (daily Goldman-style note)
  const startPolling = (jobId, kind) => {
    clearInterval(pollRef.current);
    const fetcher = kind === 'brief'
      ? api.getDailyBriefJob
      : api.getIntelligenceJob;
    const runningMsg = kind === 'brief'
      ? 'Scanning overnight tape, X, and headlines…'
      : 'Scanning X and web for market signals…';
    const finishedSetters = (running) => {
      if (kind === 'brief') setBriefRunning(running);
      else setRunning(running);
    };
    pollRef.current = setInterval(async () => {
      try {
        const job = await fetcher(jobId);
        if (job.status === 'done') {
          clearInterval(pollRef.current);
          finishedSetters(false);
          setStatus('');
          if (job.result?.ok) {
            haptics.onSuccess();
            setResult(job.result);
            setResultKind(kind);
            setError(null);
          } else {
            haptics.onError();
            setError(job.result?.error || job.error || 'Unknown error');
          }
        } else if (job.status === 'failed') {
          clearInterval(pollRef.current);
          finishedSetters(false);
          setStatus('');
          haptics.onError();
          setError(job.error || 'Run failed');
        } else {
          setStatus(job.status === 'running' ? runningMsg : 'Queued — starting shortly…');
        }
      } catch (err) {
        clearInterval(pollRef.current);
        finishedSetters(false);
        setStatus('');
        setError(err.message);
      }
    }, POLL_INTERVAL_MS);
  };

  // ── Run handler — long-horizon intelligence brief ─────────────────────────
  const handleRun = async () => {
    if (running || briefRunning) return;
    haptics.onPressPrimary();
    setRunning(true);
    setError(null);
    setStatus('Queued — starting shortly…');
    try {
      const job = await api.startIntelligence(sector);
      startPolling(job.job_id, 'intel');
    } catch (err) {
      haptics.onError();
      setRunning(false);
      setStatus('');
      if (err?.isAuthError) {
        Alert.alert('Wrong Password', 'Go to Settings → Server Password.');
      } else {
        setError(err.message);
      }
    }
  };

  // ── Run handler — Goldman-style Daily Brief ───────────────────────────────
  const handleDailyBrief = async () => {
    if (running || briefRunning) return;
    haptics.onPressPrimary();
    setBriefRunning(true);
    setError(null);
    setStatus('Queued — starting shortly…');
    try {
      const job = await api.startDailyBrief();
      startPolling(job.job_id, 'brief');
    } catch (err) {
      haptics.onError();
      setBriefRunning(false);
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
    haptics.onPressTab();
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
    haptics.onPressPrimary();
    const tickers = result.tickers.slice(0, 20);  // clamp at 20
    Alert.alert(
      'Lock in paper portfolio?',
      `Equal-weight ${tickers.length} tickers from this ${result.sector || result.days + 'd' || 'brief'}. Today's closing prices become cost basis. You can adjust weights on the web.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock In', onPress: async () => {
            setTracking(true);
            try {
              const eq = +(1 / tickers.length).toFixed(6);
              const today = new Date().toLocaleDateString('en-US',
                { month: 'short', day: 'numeric' });
              await api.createTracker({
                name: `${result.sector || 'Brief'} — ${today}`,
                holdings: tickers.map(t => ({ ticker: t, weight: eq })),
                source: {
                  sector: result.sector || null,
                  brief_generated_at: result.generated_at,
                },
              });
              haptics.onSuccess();
              Alert.alert(
                'Locked in',
                'Paper portfolio created. View it in Paper Portfolios below.',
                [
                  { text: 'OK' },
                  { text: 'View Now', onPress: () => navigation.navigate('PaperTracker') },
                ]
              );
            } catch (e) {
              haptics.onError();
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

  return (
    <View style={styles.container}>
      <AppHeader title="Intelligence" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Daily Brief card (Grok 4.30-beta — fast, action-oriented) ── */}
        <View style={[styles.card, styles.briefCard]}>
          <View style={styles.briefHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.briefTitle}>📰 Daily Brief</Text>
              <Text style={styles.briefSubtitle}>
                Goldman-style PM morning note — overnight tape, calendar,
                actionable names, X pulse. Live web + X search.
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={[styles.briefBtn,
              (briefRunning || running) && styles.runBtnDisabled]}
            onPress={handleDailyBrief}
            disabled={briefRunning || running}
            activeOpacity={0.8}
          >
            {briefRunning ? (
              <View style={styles.runBtnInner}>
                <ActivityIndicator size="small" color={colors.gold} style={{ marginRight: 8 }} />
                <Text style={styles.briefBtnText}>RUNNING…</Text>
              </View>
            ) : (
              <View style={styles.runBtnInner}>
                <Ionicons name="newspaper" size={16} color={colors.gold} style={{ marginRight: 6 }} />
                <Text style={styles.briefBtnText}>GENERATE DAILY BRIEF</Text>
              </View>
            )}
          </TouchableOpacity>
          {briefRunning && status ? (
            <Text style={styles.statusText}>{status}</Text>
          ) : null}
        </View>

        {/* ── Config card (sector-focused Intelligence brief) ── */}
        <View style={[styles.card, styles.strategicCard]}>
          <Text style={styles.cardLabel}>STRATEGIC LOOKBACK — SECTOR ANALYSIS</Text>
          <Text style={styles.sectorHint}>
            Select a sector for 10–15 companies with the most asymmetric return potential.
          </Text>
          <View style={styles.sectorRow}>
            {SECTOR_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.pill,
                  sector === opt.value && styles.pillActive,
                  opt.isBestMix && styles.pillBestMix,
                  sector === opt.value && opt.isBestMix && styles.pillBestMixActive,
                ]}
                onPress={() => !running && !briefRunning && setSector(opt.value)}
                activeOpacity={0.75}
              >
                <Text style={[
                  styles.pillText,
                  sector === opt.value && styles.pillTextActive,
                  opt.isBestMix && styles.pillBestMixText,
                  sector === opt.value && opt.isBestMix && styles.pillBestMixTextActive,
                ]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.runBtn, (running || briefRunning) && styles.runBtnDisabled]}
            onPress={handleRun}
            disabled={running || briefRunning}
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
          {!(running || briefRunning) && error ? (
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
                <View style={[styles.liveBadge,
                  resultKind === 'brief' && styles.liveBadgeBrief]}>
                  <Text style={[styles.liveBadgeText,
                    resultKind === 'brief' && styles.liveBadgeTextBrief]}>
                    {resultKind === 'brief' ? '📰 DAILY BRIEF' : '⚡ LIVE BRIEF'}
                  </Text>
                </View>
                <Text style={styles.resultDays}>
                  {resultKind === 'brief'
                    ? (result.date_str || 'Today')
                    : (result.sector || (result.days ? `${result.days}d` : 'Strategic'))}
                </Text>
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
        ) : !(running || briefRunning) ? (
          <View style={styles.emptyState}>
            <Ionicons name="newspaper-outline" size={48} color={colors.lightGray} />
            <Text style={styles.emptyTitle}>No brief yet</Text>
            <Text style={styles.emptySubtitle}>
              Tap <Text style={{ fontWeight: '700' }}>Generate Daily Brief</Text> for a Goldman-style PM
              morning note: overnight tape, today's catalysts, actionable
              names.{'\n\n'}
              Or select a sector and tap <Text style={{ fontWeight: '700' }}>Run Intelligence</Text>{' '}
              for 10–15 companies with the most asymmetric return potential.
            </Text>
          </View>
        ) : null}

        {/* ── Paper Portfolios portal ── */}
        <View style={styles.paperPortfolioCard}>
          <Text style={styles.paperPortfolioTitle}>📌 Paper Portfolios</Text>
          <Text style={styles.paperPortfolioDesc}>
            Intelligence brief baskets tracked vs SPY and your live portfolio.
            Lock in any brief with "Track Brief" to start tracking.
          </Text>
          <TouchableOpacity
            style={styles.paperPortfolioBtn}
            onPress={() => navigation.navigate('PaperTracker')}
            activeOpacity={0.8}
          >
            <Ionicons name="trending-up-outline" size={16} color={colors.navy} style={{ marginRight: 8 }} />
            <Text style={styles.paperPortfolioBtnText}>View Paper Portfolios →</Text>
          </TouchableOpacity>
        </View>

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
  // Subtle gold left-accent so the Strategic card visually balances the
  // navy/gold Daily Brief card above it — neither feels demoted.
  strategicCard: {
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.midGray,
    letterSpacing: 1.5,
    marginBottom: 12,
  },

  // ── Sector hint ──
  sectorHint: {
    fontSize: 12,
    color: colors.midGray,
    lineHeight: 17,
    marginBottom: 12,
    marginTop: -4,
  },

  // ── Sector pills (wrap to multiple lines) ──
  sectorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  pill: {
    height: 34,
    paddingHorizontal: 14,
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
    fontSize: 12,
    fontWeight: '600',
    color: colors.midGray,
  },
  pillTextActive: {
    color: colors.navy,
    fontWeight: '800',
  },
  // Best Mix pill stands out
  pillBestMix: {
    backgroundColor: colors.navy,
    borderColor: colors.navy,
  },
  pillBestMixText: {
    color: colors.gold,
    fontWeight: '700',
  },
  pillBestMixActive: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  pillBestMixTextActive: {
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

  // ── Daily Brief card (high-emphasis dark variant) ──
  briefCard: {
    backgroundColor: colors.navy,
    borderWidth: 1.5,
    borderColor: colors.gold,
  },
  briefHeader: { flexDirection: 'row', marginBottom: 14 },
  briefTitle:  {
    color: colors.gold,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  briefSubtitle: {
    color: colors.lightGray,
    fontSize: 12,
    lineHeight: 17,
  },
  briefBtn: {
    backgroundColor: colors.navyLight,
    borderRadius: 8,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.gold,
  },
  briefBtnText: {
    color: colors.gold,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },

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
  liveBadgeBrief:     { backgroundColor: colors.gold },
  liveBadgeText:      { color: colors.gold, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  liveBadgeTextBrief: { color: colors.navy },
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

  // ── Paper Portfolios portal card ──
  paperPortfolioCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderLeftWidth: 3,
    borderLeftColor: colors.navy,
  },
  paperPortfolioTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.navy,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  paperPortfolioDesc: {
    fontSize: 12,
    color: colors.midGray,
    lineHeight: 17,
    marginBottom: 14,
  },
  paperPortfolioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingVertical: 12,
  },
  paperPortfolioBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.navy,
    letterSpacing: 0.5,
  },
});

// (markdown styles moved to ../design/markdown — imported as `mdStyles` above)
