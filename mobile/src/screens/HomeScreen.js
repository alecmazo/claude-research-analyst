import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, RefreshControl, Alert, Switch,
  Linking, Platform,
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

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation, route }) {
  const [ticker, setTicker]             = useState('');
  const [loading, setLoading]           = useState(false);
  const [runningTicker, setRunningTicker] = useState('');
  const [reports, setReports]           = useState([]);
  const [prices, setPrices]             = useState({});
  const [refreshing, setRefreshing]     = useState(false);
  const [serverOk, setServerOk]         = useState(null);
  const [serverLatencyMs, setServerLatencyMs] = useState(null);
  const [gammaEnabled, setGammaEnabled] = useState(false);
  // LLM engine for analyze: 'grok' (default) | 'claude' | 'both'
  const [llmProvider, setLlmProvider]   = useState('grok');
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  // Bulk re-analyze state (active job tracking + polling)
  const [bulkJob, setBulkJob]           = useState(null);   // {bulk_job_id, total, completed:[], failed:[], status}
  const [bulkPolling, setBulkPolling]   = useState(false);

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
      // Batch quote fetch for all tickers at once
      if (data.length > 0) {
        try {
          const tickers = data.map(r => r.ticker);
          const result = await api.getBatchQuotes(tickers);
          if (result?.quotes) {
            setPrices(result.quotes);
          }
        } catch (err) {
          console.warn('getBatchQuotes:', err.message);
          // Fall back to no prices
          setPrices({});
        }
      }
    } catch (err) {
      console.warn('loadReports:', err.message);
    } finally {
      setInitialLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkServer();
      loadReports();
      getGammaEnabled().then(setGammaEnabled);
      // Pre-fill ticker if navigated here from Intelligence/other screen
      const prefill = route?.params?.prefillTicker || route?.params?.ticker;
      if (prefill) {
        setTicker(prefill.toUpperCase());
        navigation.setParams({ prefillTicker: undefined, ticker: undefined });
      }
    }, [route?.params?.prefillTicker, route?.params?.ticker])
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
      const job = await api.startAnalysis(t, gammaEnabled, llmProvider);
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

  const handleScanAll = async () => {
    if (reports.length === 0) {
      Alert.alert('No Reports', 'Add reports first by running analyses.');
      return;
    }
    // Confirmation prompt with cost estimate — matches web behavior
    const n = reports.length;
    const lo = (n * 0.06).toFixed(2);
    const hi = (n * 0.10).toFixed(2);
    const mins = Math.ceil(n * 7 / 60);
    Alert.alert(
      'Scan all ' + n + ' saved reports?',
      `• Each ticker hits Grok with live web/X search\n• Estimated cost: $${lo}–$${hi}\n• Estimated time: ~${mins} min\n• You can cancel mid-run from the Scan screen`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Proceed', onPress: async () => {
          haptics.onPressPrimary();
          const tickers = reports.map(r => r.ticker);
          try {
            await api.startScan(tickers);
            navigation.getParent()?.navigate('Scan');
          } catch (err) {
            haptics.onError();
            Alert.alert('Scan Error', err.message);
          }
        }},
      ],
    );
  };

  // ── Bulk re-analyze all saved reports ────────────────────────────────────
  const handleReanalyzeAll = async () => {
    if (reports.length === 0) {
      Alert.alert('No Reports', 'Add reports first by running analyses.');
      return;
    }
    const n = reports.length;
    const mins = Math.ceil(n * 2.5);
    Alert.alert(
      'Re-analyze all ' + n + ' saved reports?',
      `• Runs sequentially in the background (~${mins} min total)\n• Existing PowerPoints kept but marked older\n• To refresh a PPT, re-run that ticker individually with the Gamma toggle\n• You can cancel mid-run from the banner`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Proceed', onPress: async () => {
          haptics.onPressPrimary();
          try {
            const job = await api.startReanalyzeAll();
            setBulkJob(job);
            setBulkPolling(true);
            pollBulkJob(job.bulk_job_id);
          } catch (err) {
            haptics.onError();
            Alert.alert('Re-analyze Error', err.message);
          }
        }},
      ],
    );
  };

  const handleCancelReanalyze = async () => {
    if (!bulkJob || !bulkJob.bulk_job_id) return;
    Alert.alert(
      'Cancel bulk re-analyze?',
      'The current ticker will finish, then the job stops.',
      [
        { text: 'Keep Running', style: 'cancel' },
        { text: 'Cancel Job', style: 'destructive', onPress: async () => {
          try { await api.cancelReanalyzeAll(bulkJob.bulk_job_id); } catch (e) {}
        }},
      ],
    );
  };

  // Poll bulk job every 5s; updates banner; refreshes reports list when done
  const pollBulkJob = (bulkId) => {
    const tick = async () => {
      try {
        const j = await api.getReanalyzeAllStatus(bulkId);
        setBulkJob(j);
        if (j.status === 'done' || j.status === 'cancelled' || j.status === 'failed') {
          setBulkPolling(false);
          // Refresh reports so new pptx_stale flags + updated dates appear
          try { const data = await api.listReports(); setReports(data || []); } catch (e) {}
          return;   // stop polling
        }
        setTimeout(tick, 5000);
      } catch (e) {
        setTimeout(tick, 8000);   // backoff on transient errors
      }
    };
    tick();
  };

  // On screen mount: resume bulk polling if a job was already running server-side
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.getActiveReanalyzeAll();
        if (cancelled) return;
        if (d && d.active && (d.active.status === 'running' || d.active.status === 'queued')) {
          setBulkJob(d.active);
          setBulkPolling(true);
          pollBulkJob(d.active.bulk_job_id);
        }
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, []);

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
        'Archive Report?',
        `Archives the report for ${item.ticker}. You can restore it from the web app.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Archive', style: 'destructive', onPress: async () => {
              try {
                await api.deleteReport(item.ticker);
                haptics.onSuccess();
                await loadReports();
              } catch (err) {
                haptics.onError();
                Alert.alert('Could not archive', err.message);
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
    buttons.push({ text: 'Archive from Cache', style: 'destructive', onPress: confirmDelete });
    buttons.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert(item.ticker, 'Choose an action', buttons);
  };

  const renderReport = ({ item }) => {
    const q = prices[item.ticker];
    let pct = q?.pct_change ?? null;
    if (pct == null && q?.price != null && q?.previous_close) {
      const p = Number(q.price), pr = Number(q.previous_close);
      if (pr > 0) pct = parseFloat(((p - pr) / pr * 100).toFixed(2));
    }
    const priceStr = q?.price != null ? `$${Number(q.price).toFixed(2)}` : null;
    const pctStr   = pct != null ? `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%` : null;
    const isUp     = pct != null && pct >= 0;

    const target = item.price_target != null ? Number(item.price_target) : null;
    const livePrice = q?.price != null ? Number(q.price) : null;
    let targetUpside = null;
    if (target != null && livePrice != null && livePrice > 0) {
      targetUpside = ((target - livePrice) / livePrice) * 100;
    } else if (item.upside_pct != null) {
      targetUpside = Number(item.upside_pct);
    }
    const targetStr = target != null ? `$${target.toFixed(0)}` : null;
    const upsideStr = targetUpside != null
      ? `${targetUpside >= 0 ? '+' : ''}${targetUpside.toFixed(1)}%`
      : null;
    const targetUp = targetUpside != null && targetUpside >= 0;

    const dateStr = formatDateCompact(item.generated_at);

    return (
      <TouchableOpacity
        style={styles.reportRow}
        onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
        onLongPress={() => handleRowLongPress(item)}
        delayLongPress={350}
        activeOpacity={0.7}
      >
        <View style={styles.tickerCell}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* Status icon — last attempt success (✅) or failed (❌) */}
            {item.last_attempt_status === 'failed' ? (
              <Text style={styles.statusIcon}>❌</Text>
            ) : item.generated_at ? (
              <Text style={styles.statusIcon}>✅</Text>
            ) : null}
            <Text style={styles.reportTicker}>{item.ticker}</Text>
          </View>
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
            {/* Tappable LLM provider pills — open that specific report */}
            {(item.providers || []).includes('grok') && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation && e.stopPropagation();
                  navigation.navigate('Report', { ticker: item.ticker, provider: 'grok' });
                }}
                style={[styles.llmPill, styles.llmPillGrok]}
                activeOpacity={0.7}
              >
                <Text style={styles.llmPillText}>GROK</Text>
              </TouchableOpacity>
            )}
            {(item.providers || []).includes('claude') && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation && e.stopPropagation();
                  navigation.navigate('Report', { ticker: item.ticker, provider: 'claude' });
                }}
                style={[styles.llmPill, styles.llmPillClaude]}
                activeOpacity={0.7}
              >
                <Text style={styles.llmPillText}>CLAUDE</Text>
              </TouchableOpacity>
            )}
            <Text style={styles.reportDate}>{dateStr}</Text>
          </View>
        </View>

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

  const lastLoadedStr = lastLoadedAt ? `Updated ${formatTime(lastLoadedAt)}` : '';

  return (
    <View style={styles.container}>
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

      {/* Ticker input card */}
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
              <Text style={styles.analyzeBtnText}>RUN ▶</Text>
            )}
          </TouchableOpacity>
        </View>
        <View style={styles.gammaRow}>
          <Text style={styles.gammaLabel}>Generate Presentation</Text>
          <Switch
            value={gammaEnabled}
            onValueChange={v => { setGammaEnabled(v); saveGamma(v); }}
            trackColor={{ false: colors.lightGray, true: colors.primary }}
            thumbColor={colors.white}
          />
        </View>
        {/* LLM engine selector — pick Grok / Claude / Both */}
        <View style={styles.llmRow}>
          <Text style={styles.llmRowLabel}>ENGINE</Text>
          <View style={styles.llmPicker}>
            {[
              { v: 'grok',   label: 'Grok' },
              { v: 'claude', label: 'Claude' },
              { v: 'both',   label: 'Both' },
            ].map(opt => (
              <TouchableOpacity
                key={opt.v}
                onPress={() => setLlmProvider(opt.v)}
                style={[
                  styles.llmPickerOpt,
                  llmProvider === opt.v && (
                    opt.v === 'claude' ? styles.llmPickerOptActiveClaude :
                    opt.v === 'both'   ? styles.llmPickerOptActiveBoth   :
                                          styles.llmPickerOptActiveGrok
                  ),
                ]}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.llmPickerOptText,
                  llmProvider === opt.v && styles.llmPickerOptTextActive,
                ]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* AI Analyst entry — agentic Q&A over platform data */}
      <TouchableOpacity
        style={styles.analystBanner}
        onPress={() => { haptics.onPressPrimary(); navigation.navigate('Analyst'); }}
        activeOpacity={0.85}
      >
        <View style={styles.analystBannerIcon}>
          <Text style={styles.analystBannerEmoji}>🤖</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.analystBannerTitle}>AI Analyst</Text>
          <Text style={styles.analystBannerSub}>
            Ask anything across your coverage — live data, cited & verified
          </Text>
        </View>
        <Text style={styles.analystBannerArrow}>›</Text>
      </TouchableOpacity>

      {/* Reports section header */}
      <View style={styles.listHeaderRow}>
        <Text style={styles.sectionTitle}>SAVED REPORTS</Text>
        {reports.length > 0 && (
          <Text style={styles.countBadge}>{reports.length}</Text>
        )}
        <View style={{ flex: 1 }} />
        {reports.length > 0 && (
          <TouchableOpacity
            style={styles.reanalyzeAllBtn}
            onPress={handleReanalyzeAll}
            disabled={bulkPolling}
            activeOpacity={0.8}
          >
            <Text style={styles.reanalyzeAllBtnText}>
              {bulkPolling ? '⏳ Re-analyzing…' : '🔄 Re-analyze All'}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.scanAllBtn} onPress={handleScanAll} activeOpacity={0.8}>
          <Text style={styles.scanAllBtnText}>⚡ Scan All</Text>
        </TouchableOpacity>
      </View>

      {/* Bulk re-analyze progress banner */}
      {bulkJob && (bulkJob.status === 'running' || bulkJob.status === 'queued' ||
                   bulkJob.status === 'done' || bulkJob.status === 'cancelled') && (
        <View style={styles.reanalyzeBanner}>
          <View style={styles.reanalyzeBannerRow}>
            <Text style={styles.reanalyzeBannerText}>
              {bulkJob.status === 'done'
                ? `✓ Done · ${(bulkJob.completed||[]).length}/${bulkJob.total} succeeded · ${(bulkJob.failed||[]).length} failed`
                : bulkJob.status === 'cancelled'
                ? `⊘ Cancelled · ${(bulkJob.completed||[]).length}/${bulkJob.total} done before cancel`
                : `Re-analyzing ${bulkJob.current_ticker || '…'} (${(bulkJob.current_index||0)+1}/${bulkJob.total})`}
            </Text>
            {(bulkJob.status === 'running' || bulkJob.status === 'queued') && (
              <TouchableOpacity style={styles.reanalyzeCancelBtn} onPress={handleCancelReanalyze}>
                <Text style={styles.reanalyzeCancelText}>CANCEL</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.reanalyzeBarTrack}>
            <View style={[styles.reanalyzeBarFill,
                          { width: `${Math.min(100, Math.max(0, bulkJob.progress_pct || 0))}%` }]} />
          </View>
        </View>
      )}
      {lastLoadedStr ? (
        <View style={{ marginHorizontal: 16, marginBottom: 4 }}>
          <Text style={styles.lastLoadedText}>{lastLoadedStr}</Text>
        </View>
      ) : null}

      {/* Reports list — always a single FlatList for smooth, freeze-free scrolling.
          SkeletonList is shown via ListEmptyComponent during initial load so there
          is never a competing scroll container above the list. */}
      <FlatList
        data={reports}
        keyExtractor={item => item.ticker}
        renderItem={renderReport}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
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
          initialLoading ? (
            <SkeletonList count={5} />
          ) : (
            <View style={styles.emptyWrap}>
              <Ionicons name="documents-outline" size={44} color={colors.lightGray} />
              <Text style={styles.emptyTitle}>No reports yet</Text>
              <Text style={styles.emptySubtitle}>
                Type a ticker above and tap RUN ▶ to generate your first institutional analysis.
              </Text>
            </View>
          )
        }
        contentContainerStyle={
          initialLoading ? undefined :
          reports.length > 0 ? styles.listContent : styles.emptyContainer
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.offWhite },
  statusDot:  { width: 10, height: 10, borderRadius: 5 },

  // Input card
  inputSection: {
    backgroundColor: colors.white,
    margin: 16,
    marginBottom: 8,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label:    { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5, marginBottom: 10 },

  // AI Analyst banner
  analystBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.navy,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3,
  },
  analystBannerIcon: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  analystBannerEmoji: { fontSize: 20 },
  analystBannerTitle: { color: colors.white, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  analystBannerSub:   { color: 'rgba(255,255,255,0.62)', fontSize: 12, marginTop: 2 },
  analystBannerArrow: { color: colors.gold, fontSize: 28, fontWeight: '300', marginLeft: 8 },
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
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: 18,
    minWidth: 90,
    justifyContent: 'center',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.primaryLight,
    borderBottomWidth: 2,
    borderBottomColor: colors.primaryDark,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.55,
        shadowRadius: 10,
      },
      android: { elevation: 8 },
    }),
  },
  analyzeBtnDisabled: { opacity: 0.5 },
  analyzeBtnInner: { flexDirection: 'row', alignItems: 'center' },
  analyzeBtnText: { color: colors.navy, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  analyzeBtnLoadingText: { color: colors.navy, fontWeight: '800', fontSize: 12, letterSpacing: 1, marginLeft: 6 },
  gammaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.lightGray,
  },
  gammaLabel: { fontSize: 14, fontWeight: '600', color: colors.darkGray },

  // LLM engine selector (Grok / Claude / Both)
  llmRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 10,
  },
  llmRowLabel: {
    fontSize: 10, fontWeight: '800', color: colors.midGray, letterSpacing: 1,
  },
  llmPicker: {
    flexDirection: 'row', backgroundColor: colors.lightGray,
    borderRadius: 6, padding: 2, gap: 2,
  },
  llmPickerOpt: {
    paddingVertical: 5, paddingHorizontal: 11, borderRadius: 4,
  },
  llmPickerOptActiveGrok:   { backgroundColor: '#0A1628' },
  llmPickerOptActiveClaude: { backgroundColor: '#d97706' },
  llmPickerOptActiveBoth:   { backgroundColor: '#475569' },
  llmPickerOptText: {
    fontSize: 11, fontWeight: '700', color: colors.darkGray,
  },
  llmPickerOptTextActive: { color: colors.white },

  // Per-report provider badges (GROK / CLAUDE) — tappable
  llmPill: {
    borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1,
    marginRight: 2,
  },
  llmPillGrok:   { backgroundColor: '#0A1628' },
  llmPillClaude: { backgroundColor: '#d97706' },
  llmPillText:   { fontSize: 9, fontWeight: '800', color: colors.white, letterSpacing: 0.4 },

  // Status icon (✅ / ❌) before the ticker
  statusIcon: { fontSize: 13, marginRight: 4 },

  // Bulk re-analyze banner
  reanalyzeBanner: {
    backgroundColor: '#f3e8ff', borderColor: '#e9d5ff', borderWidth: 1,
    borderRadius: 8, padding: 10, marginHorizontal: 16, marginBottom: 8,
  },
  reanalyzeBannerText: {
    fontSize: 11, fontWeight: '600', color: '#6b21a8',
  },
  reanalyzeBarTrack: {
    marginTop: 6, height: 4, backgroundColor: '#ede9fe', borderRadius: 2, overflow: 'hidden',
  },
  reanalyzeBarFill: { height: '100%', backgroundColor: '#9333ea' },
  reanalyzeBannerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  reanalyzeCancelBtn: {
    backgroundColor: 'transparent', borderColor: '#c084fc', borderWidth: 1,
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 3,
  },
  reanalyzeCancelText: {
    fontSize: 9, fontWeight: '800', color: '#7e22ce', letterSpacing: 0.5,
  },
  reanalyzeAllBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
  },
  reanalyzeAllBtnText: {
    fontSize: 10, fontWeight: '800', color: '#9333ea', letterSpacing: 0.5,
  },

  // Reports header row
  listHeaderRow: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 4, marginTop: 8,
  },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5 },
  countBadge: {
    marginLeft: 8,
    fontSize: 11, fontWeight: '700', color: colors.primary,
    backgroundColor: colors.navy,
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
    overflow: 'hidden',
  },
  lastLoadedText: { fontSize: 10, fontWeight: '600', color: colors.midGray, letterSpacing: 0.3 },
  scanAllBtn: {
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  scanAllBtnText: { color: colors.navy, fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },

  // List container
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
  colHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: colors.lightGray,
  },
  colHeaderText: { fontSize: 9, fontWeight: '800', color: colors.midGray, letterSpacing: 1.2 },

  reportRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(91,184,212,0.25)',
  },
  sep: { height: 1, backgroundColor: colors.lightGray, marginLeft: 14 },
  tickerCell:    { flex: 1 },
  reportTicker:  { fontSize: 15, fontWeight: '800', color: colors.navy, letterSpacing: 1.2, lineHeight: 18 },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  docPill: { backgroundColor: colors.navy, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  docPillText: { color: colors.white, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  pptPill: { backgroundColor: colors.primary, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  pptPillText: { color: colors.navy, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  reportDate: { fontSize: 11, color: colors.midGray, marginLeft: 3 },

  priceCell: { alignItems: 'flex-end', minWidth: 78, marginRight: 10 },
  priceText: { fontSize: 14, fontWeight: '700', color: colors.navy, fontFamily: 'Courier New', lineHeight: 16 },
  pctText: { fontSize: 11, fontWeight: '700', fontFamily: 'Courier New', lineHeight: 13, marginTop: 1 },
  pctUp:   { color: colors.green },
  pctDown: { color: colors.red },
  priceMissing: { fontSize: 14, color: colors.lightGray, fontFamily: 'Courier New' },

  targetCell: { alignItems: 'flex-end', minWidth: 70 },
  targetLabel: { fontSize: 7, fontWeight: '800', color: colors.primary, letterSpacing: 1.0, lineHeight: 10 },
  targetText: { fontSize: 13, fontWeight: '700', color: colors.darkGray, fontFamily: 'Courier New', lineHeight: 16 },
  upsideText: { fontSize: 11, fontWeight: '700', fontFamily: 'Courier New', lineHeight: 13, marginTop: 1 },
  targetMissing: { fontSize: 13, color: colors.lightGray, fontFamily: 'Courier New' },

  colHeaderPrice:  { width: 78, marginRight: 10, textAlign: 'right' },
  colHeaderTarget: { width: 70, textAlign: 'right', color: colors.primary },
  chev: { marginLeft: 6 },

  emptyContainer: { flexGrow: 1, justifyContent: 'center', backgroundColor: 'transparent' },
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
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.navy, marginTop: 12, letterSpacing: 0.4 },
  emptySubtitle: { fontSize: 13, color: colors.midGray, textAlign: 'center', marginTop: 6, lineHeight: 18 },
});
