import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Switch, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, haptics, formatDate } from '../design';

const LAST_PORTFOLIO_KEY = '@dga_last_portfolio';

// NOTE: Strategy selector was removed from this screen — every run now produces
// all three strategies (Current Portfolio, High Conviction, All-In Top 3)
// side-by-side. The old FALLBACK_STRATEGIES constant has been deleted. If
// you need the strategy descriptions for future tooltips, they live on the
// server at GET /api/strategies.

export default function PortfolioScreen({ navigation }) {
  const [file, setFile]                 = useState(null);
  const [reuseCache, setReuseCache]     = useState(true);
  const [generateGamma, setGenerateGamma] = useState(false);
  const [submitting, setSubmitting]     = useState(false);
  const [job, setJob]                   = useState(null);
  const [error, setError]               = useState(null);
  const [lastRun, setLastRun]           = useState(null);   // persisted last job
  const pollRef = useRef(null);

  useEffect(() => {
    // Load persisted last-run card
    AsyncStorage.getItem(LAST_PORTFOLIO_KEY)
      .then(raw => { if (raw) setLastRun(JSON.parse(raw)); })
      .catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const pickFile = async () => {
    haptics.onPressTab();
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // iOS: */* lets the user choose any file from Files / iCloud / Downloads.
        // Listing specific MIME types here can grey out CSVs from cloud providers.
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      // Handle both old (>=12) and new (>=14) shape gracefully
      if (result?.canceled) return;
      const asset = result?.assets?.[0] || (result?.uri ? result : null);
      if (!asset?.uri) {
        Alert.alert('No file selected', 'Could not read the selected file. Try again, or pick a file from Files or iCloud Drive.');
        return;
      }
      setFile({
        uri:      asset.uri,
        name:     asset.name     || 'portfolio.csv',
        mimeType: asset.mimeType || asset.type || 'application/octet-stream',
        size:     asset.size,
      });
    } catch (err) {
      Alert.alert('Could not pick file', err.message || String(err));
    }
  };

  const startRun = async () => {
    if (!file) {
      haptics.onError();
      Alert.alert('No file selected', 'Please choose a portfolio CSV or XLSX first.');
      return;
    }
    haptics.onPressPrimary();
    setSubmitting(true);
    setError(null);
    setJob(null);
    try {
      const resp = await api.startPortfolio({
        fileUri: file.uri,
        fileName: file.name,
        mimeType: file.mimeType,
        // Strategy selector removed — backend always returns all three.
        // 'current' is the canonical primary; the others are still in the result.
        strategy: 'current',
        reuseExisting: reuseCache,
        generateGamma,
      });
      setJob(resp);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => pollJob(resp.job_id), 4000);
    } catch (err) {
      haptics.onError();
      const msg = err?.message || String(err);
      setError(msg);
      Alert.alert('Rebalance failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const pollJob = async (jobId) => {
    try {
      const j = await api.getPortfolioJob(jobId);
      setJob(j);
      if (j.status === 'done') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        haptics.onSuccess();
        // Persist for "Last Portfolio Run" card
        const payload = {
          job_id: jobId,
          n_tickers: j.n_tickers,
          strategy: j.strategy,
          completed_at: new Date().toISOString(),
          result: j.result,
        };
        AsyncStorage.setItem(LAST_PORTFOLIO_KEY, JSON.stringify(payload)).catch(() => {});
        setLastRun(payload);
      } else if (j.status === 'failed') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        haptics.onError();
      }
    } catch (err) {
      clearInterval(pollRef.current);
      setError(err.message);
    }
  };

  const openDownload = async () => {
    if (!job) return;
    haptics.onPressPrimary();
    const url = await api.portfolioDownloadUrl(job.job_id);
    Linking.openURL(url);
  };

  const openLastDownload = async () => {
    if (!lastRun?.job_id) return;
    haptics.onPressPrimary();
    const url = await api.portfolioDownloadUrl(lastRun.job_id);
    Linking.openURL(url);
  };

  const result = job?.result;
  // (orderedStrategies removed — strategy result blocks no longer rendered
  // on this screen; per-strategy breakdown lives on the PortfolioSummary view.)

  return (
    <View style={styles.wrapper}>
      <AppHeader
        title="Portfolio"
        right={
          <TouchableOpacity
            onPress={() => { haptics.onPressTab(); navigation.navigate('PaperTracker'); }}
            style={styles.trackerHeaderBtn}
            activeOpacity={0.75}
          >
            <Ionicons name="trending-up" size={14} color={colors.navy} />
            <Text style={styles.trackerHeaderBtnText}>Tracker</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* File picker card */}
      <View style={styles.card}>
        <Text style={styles.label}>UPLOAD PORTFOLIO</Text>
        <Text style={styles.hint}>
          CSV or XLSX with columns: Ticker, Weight (%), Optimized. The Optimized column is ignored on input.
        </Text>
        <TouchableOpacity style={styles.fileBtn} onPress={pickFile}>
          <Ionicons name="document-attach-outline" size={20} color={colors.navy} />
          <Text style={styles.fileBtnText}>
            {file ? file.name : 'Choose Portfolio File'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Strategy selector removed — every run produces all three strategies
          (Current Portfolio, High Conviction, All-In Top 3) side-by-side. */}

      {/* Options */}
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Reuse cached reports (faster)</Text>
          <Switch
            value={reuseCache}
            onValueChange={(v) => { haptics.onToggle(); setReuseCache(v); }}
            trackColor={{ false: colors.lightGray, true: colors.gold }}
            thumbColor={colors.white}
          />
        </View>
        <View style={styles.toggleSep} />
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={styles.toggleLabel}>Generate Gamma Presentations</Text>
            <Text style={styles.toggleHint}>
              Will use ~1 Gamma credit per ticker. Check your balance at gamma.app/account.
            </Text>
          </View>
          <Switch
            value={generateGamma}
            onValueChange={(v) => { haptics.onToggle(); setGenerateGamma(v); }}
            trackColor={{ false: colors.lightGray, true: colors.gold }}
            thumbColor={colors.white}
          />
        </View>
        <TouchableOpacity
          style={[styles.runBtn, (!file || submitting || (job && job.status !== 'done' && job.status !== 'failed')) && styles.runBtnDisabled]}
          onPress={startRun}
          disabled={!file || submitting || (job && job.status !== 'done' && job.status !== 'failed')}
        >
          {submitting
            ? <ActivityIndicator color={colors.navy} />
            : <Text style={styles.runBtnText}>RUN REBALANCE</Text>}
        </TouchableOpacity>
      </View>

      {/* Progress / result */}
      {job && (
        <View style={styles.card}>
          <Text style={styles.label}>STATUS</Text>

          {/* Live progress bar + per-ticker counter (running only) */}
          {(job.status === 'queued' || job.status === 'running') && job.progress && (
            <View style={styles.progressWrap}>
              <View style={styles.progressBarTrack}>
                <View
                  style={[
                    styles.progressBarFill,
                    { width: `${Math.round((job.progress.pct ?? 0) * 100)}%` },
                  ]}
                />
              </View>
              <View style={styles.progressMetaRow}>
                <Text style={styles.progressLabelText} numberOfLines={1}>
                  {job.progress.label || (job.status === 'running' ? 'Analyzing…' : 'Queued')}
                </Text>
                {job.progress.ticker_total > 0 && (
                  <Text style={styles.progressCounter}>
                    {job.progress.ticker_index || 0}/{job.progress.ticker_total}
                  </Text>
                )}
              </View>
              {/* Tiny ok / failed mini-counter while running */}
              {(job.progress.ok?.length || job.progress.failed?.length) ? (
                <Text style={styles.progressTallies}>
                  {(job.progress.ok?.length || 0)} ok
                  {(job.progress.failed?.length > 0)
                    ? ` · ${job.progress.failed.length} failed`
                    : ''}
                </Text>
              ) : null}
            </View>
          )}

          {/* Final status line — clean and informative */}
          {job.status === 'done' && (
            <Text style={styles.statusText}>
              ✅ Done — {job.n_tickers} tickers analyzed
            </Text>
          )}
          {job.status === 'failed' && (
            <Text style={styles.statusText}>❌ Failed</Text>
          )}

          {error && <Text style={styles.errorText}>{error}</Text>}
          {job.error && <Text style={styles.errorText}>{job.error}</Text>}

          {/* Strategy result blocks intentionally omitted — the website was
              streamlined to show only status + download/Sheets actions on this
              card. The full per-strategy breakdown is on the Portfolio Summary
              screen ("View Summary" button below). */}

          {job.status === 'done' && (
            <TouchableOpacity style={styles.runBtn} onPress={openDownload}>
              <Ionicons name="document-outline" size={16} color={colors.navy} style={{ marginRight: 6 }} />
              <Text style={styles.runBtnText}>Download DGA-portfolio.xlsx</Text>
            </TouchableOpacity>
          )}
          {job.status === 'done' && result?.gamma_url && (
            <TouchableOpacity
              style={[styles.runBtn, styles.gammaBtn]}
              onPress={() => Linking.openURL(result.gamma_url)}
            >
              <Ionicons name="easel-outline" size={16} color={colors.navy} style={{ marginRight: 6 }} />
              <Text style={styles.runBtnText}>View Gamma Presentation</Text>
              <Ionicons name="open-outline" size={14} color={colors.navy} style={{ marginLeft: 4 }} />
            </TouchableOpacity>
          )}
          {job.status === 'done' && result?.gamma_error && (() => {
            const err = result.gamma_error || '';
            const isCredits = /credit|insufficient|billing/i.test(err);
            return (
              <TouchableOpacity
                style={[styles.gammaErrorBox, isCredits && styles.gammaCreditsBox]}
                onPress={() => Linking.openURL('https://gamma.app/account')}
                activeOpacity={isCredits ? 0.6 : 1}
              >
                <Ionicons
                  name={isCredits ? 'card-outline' : 'warning-outline'}
                  size={15}
                  color="#92400E"
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.gammaErrorText, { fontWeight: '700' }]}>
                    {isCredits ? 'Gamma credits exhausted' : 'Gamma error'}
                  </Text>
                  <Text style={[styles.gammaErrorText, { marginTop: 2 }]}>{err}</Text>
                  {isCredits && (
                    <Text style={[styles.gammaErrorText, { marginTop: 4, fontWeight: '700', textDecorationLine: 'underline' }]}>
                      Tap to open gamma.app/account →
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          })()}
          {job.status === 'done' && result?.gsheets?.ok && (
            <TouchableOpacity
              style={[styles.runBtn, styles.sheetsBtn]}
              onPress={() => Linking.openURL(result.gsheets.url)}
            >
              <Ionicons name="logo-google" size={16} color={colors.white} style={{ marginRight: 6 }} />
              <Text style={[styles.runBtnText, { color: colors.white }]}>Open in Google Sheets</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {/* ── Last Portfolio Run (persisted across launches) ── */}
      {lastRun && !job && (
        <View style={styles.card}>
          <Text style={styles.label}>LAST PORTFOLIO RUN</Text>
          <Text style={styles.lastRunMeta}>
            {formatDate(lastRun.completed_at)}
            {lastRun.n_tickers ? `  ·  ${lastRun.n_tickers} tickers` : ''}
            {lastRun.strategy  ? `  ·  ${lastRun.strategy}` : ''}
          </Text>

          {/* Strategy result blocks intentionally omitted to match the website's
              streamlined Portfolio tab. Tap "View Summary" below for the full
              per-strategy breakdown. */}

          <View style={styles.lastRunActions}>
            <TouchableOpacity
              style={[styles.runBtn, styles.lastRunSummaryBtn]}
              onPress={() => navigation.navigate('PortfolioSummary')}
            >
              <Ionicons name="document-text-outline" size={16} color={colors.navy} style={{ marginRight: 6 }} />
              <Text style={styles.runBtnText}>View Summary</Text>
            </TouchableOpacity>
            {lastRun.job_id && (
              <TouchableOpacity
                style={[styles.runBtn, { flex: 1 }]}
                onPress={openLastDownload}
              >
                <Ionicons name="download-outline" size={16} color={colors.navy} style={{ marginRight: 6 }} />
                <Text style={styles.runBtnText}>Download xlsx</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper:   { flex: 1, backgroundColor: colors.offWhite },
  container: { flex: 1 },
  content: { paddingBottom: 40 },
  trackerHeaderBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.gold,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 6,
  },
  trackerHeaderBtnText: {
    color: colors.navy, fontSize: 11, fontWeight: '800', letterSpacing: 0.5,
  },
  card: {
    backgroundColor: colors.white,
    margin: 16,
    marginBottom: 0,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginBottom: 10,
  },
  hint: { fontSize: 12, color: colors.midGray, lineHeight: 17, marginTop: 8 },
  fileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderStyle: 'dashed',
    borderRadius: 10,
    backgroundColor: colors.offWhite,
  },
  fileBtnText: { fontSize: 14, fontWeight: '600', color: colors.navy, flex: 1 },
  strategyOption: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    padding: 12,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 10,
    marginBottom: 8,
  },
  strategyOptionSelected: {
    borderColor: colors.gold,
    backgroundColor: 'rgba(201, 162, 39, 0.06)',
  },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: colors.midGray,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  radioOuterSelected: { borderColor: colors.gold },
  radioInner: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold,
  },
  strategyBody: { flex: 1 },
  strategyTitle: { fontSize: 15, fontWeight: '700', color: colors.navy, marginBottom: 2 },
  strategyDesc: { fontSize: 12.5, color: colors.darkGray, lineHeight: 17 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleSep: {
    height: 1,
    backgroundColor: colors.lightGray,
    marginVertical: 4,
  },
  toggleLabel: { fontSize: 14, fontWeight: '600', color: colors.darkGray },
  toggleHint:  { fontSize: 11, color: colors.midGray, marginTop: 2, lineHeight: 15 },
  runBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { color: colors.navy, fontWeight: '800', fontSize: 14, letterSpacing: 1 },
  sheetsBtn: { backgroundColor: '#0F9D58', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  gammaBtn: {
    backgroundColor: colors.offWhite,
    borderWidth: 1.5,
    borderColor: colors.gold,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gammaErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#FFFBEB',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  gammaErrorText: { fontSize: 12, color: '#92400E', lineHeight: 16 },
  gammaCreditsBox: {
    backgroundColor: '#FEF3C7',
    borderColor: '#D97706',
    borderWidth: 1.5,
  },
  statusText: { fontSize: 14, fontWeight: '600', color: colors.navy, marginBottom: 6 },
  errorText: { fontSize: 13, color: colors.red, marginTop: 4 },

  // Live progress UI for in-flight portfolio runs.
  progressWrap: {
    marginBottom: 8,
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: colors.lightGray,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.gold,
    borderRadius: 3,
  },
  progressMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  progressLabelText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: colors.navy,
  },
  progressCounter: {
    fontSize: 12,
    color: colors.midGray,
    fontFamily: 'Courier New',
    fontWeight: '700',
  },
  progressTallies: {
    marginTop: 4,
    fontSize: 11,
    color: colors.midGray,
    fontFamily: 'Courier New',
  },
  resultBlock: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.lightGray,
    borderRadius: 10,
    backgroundColor: colors.offWhite,
  },
  resultBlockPrimary: {
    borderColor: colors.gold,
    backgroundColor: 'rgba(201, 162, 39, 0.08)',
  },
  resultHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  resultTitle: { fontSize: 13, fontWeight: '800', color: colors.navy, letterSpacing: 0.5 },
  resultCount: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.lightGray,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillTicker: { fontSize: 12, color: colors.darkGray },
  pillWeight: { fontSize: 12, fontWeight: '700', color: colors.navy },
  emptyPill: { fontSize: 12, color: colors.midGray, fontStyle: 'italic' },

  lastRunMeta: {
    fontSize: 12,
    color: colors.midGray,
    marginBottom: 10,
    lineHeight: 17,
  },
  lastRunActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  lastRunSummaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
  },
});
