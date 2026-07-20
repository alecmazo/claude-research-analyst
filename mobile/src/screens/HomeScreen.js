import React, { useState, useCallback, useEffect, useMemo } from 'react';
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
  formatTime, formatDateCompact, haptics, SkeletonList, useTheme,
} from '../design';

function _wireRelAge(pubTs) {
  if (pubTs == null) return '';
  const sec = Math.max(0, Date.now() / 1000 - Number(pubTs));
  if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation, route }) {
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
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
  // Market Wire (free macro RSS — same source as desktop Desk)
  const [wireItems, setWireItems]       = useState([]);
  const [wireAsOf, setWireAsOf]         = useState('');
  const [wireLoading, setWireLoading]   = useState(true);
  const [wireError, setWireError]       = useState('');

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

  const loadMarketWire = async () => {
    setWireLoading(true);
    setWireError('');
    try {
      const d = await api.getMarketWire(10);
      // Accept items at top level or nested under market_wire (desk-feeds shape)
      const raw = Array.isArray(d?.items)
        ? d.items
        : (Array.isArray(d?.market_wire?.items) ? d.market_wire.items : []);
      setWireItems(raw);
      setWireAsOf(d?.as_of || d?.market_wire?.as_of || '');
      if (!raw.length) {
        if (d && d.ok === false) {
          setWireError(d.error || d.detail || 'Wire unavailable');
        } else if (Array.isArray(d?.errors) && d.errors.length && !raw.length) {
          setWireError('Feeds unreachable — tap ↻');
        }
      }
    } catch (err) {
      console.warn('getMarketWire:', err.message);
      setWireError(err.message || 'Could not load Market Wire');
      // Keep prior items if refresh fails
    } finally {
      setWireLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkServer();
      loadReports();
      loadMarketWire();
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
    await Promise.all([checkServer(), loadReports(), loadMarketWire()]);
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
    // Multi-select engines: comma-separated (e.g. "grok,claude,deepseek")
    // Kimi is not offered for full equity reports (desktop parity).
    const engines = String(llmProvider || 'grok')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s && s !== 'kimi' && ['grok', 'claude', 'deepseek'].includes(s));
    const list = engines.length ? engines : ['grok'];
    try {
      // First engine navigates to progress; remaining run in background sequentially
      // via chained navigations is awkward — start all sequentially here, navigate to first.
      const first = list[0];
      const job = await api.startAnalysis(t, gammaEnabled && first === 'grok', first);
      setTicker('');
      navigation.navigate('Analysis', { jobId: job.job_id, ticker: t, engine: first });
      // Fire remaining engines (each persists its own Saved Report)
      for (let i = 1; i < list.length; i++) {
        const eng = list[i];
        try {
          await api.startAnalysis(t, false, eng);
        } catch (e) {
          console.warn('extra engine failed', eng, e?.message);
        }
      }
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
            Alert.alert('Scan started',
              'Re-analysis of your saved reports is running in the background. Each report updates as it finishes.');
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
        style={s.reportRow}
        onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
        onLongPress={() => handleRowLongPress(item)}
        delayLongPress={350}
        activeOpacity={0.7}
      >
        <View style={s.tickerCell}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* Status icon — last attempt success (✅) or failed (❌) */}
            {item.last_attempt_status === 'failed' ? (
              <Text style={s.statusIcon}>❌</Text>
            ) : item.generated_at ? (
              <Text style={s.statusIcon}>✅</Text>
            ) : null}
            <Text style={s.reportTicker}>{item.ticker}</Text>
          </View>
          <View style={s.formatRow}>
            {item.has_docx && (
              <View style={s.docPill}>
                <Text style={s.docPillText}>DOC</Text>
              </View>
            )}
            {item.has_pptx && (
              <View style={s.pptPill}>
                <Text style={s.pptPillText}>PPT</Text>
              </View>
            )}
            {/* Tappable LLM provider pills — open that specific report */}
            {(item.providers || []).includes('grok') && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation && e.stopPropagation();
                  navigation.navigate('Report', { ticker: item.ticker, provider: 'grok' });
                }}
                style={[s.llmPill, s.llmPillGrok]}
                activeOpacity={0.7}
              >
                <Text style={s.llmPillText}>GROK</Text>
              </TouchableOpacity>
            )}
            {(item.providers || []).includes('claude') && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation && e.stopPropagation();
                  navigation.navigate('Report', { ticker: item.ticker, provider: 'claude' });
                }}
                style={[s.llmPill, s.llmPillClaude]}
                activeOpacity={0.7}
              >
                <Text style={s.llmPillText}>CLAUDE</Text>
              </TouchableOpacity>
            )}
            <Text style={s.reportDate}>{dateStr}</Text>
          </View>
        </View>

        <View style={s.priceCell}>
          {priceStr ? (
            <>
              <Text style={s.priceText}>{priceStr}</Text>
              {pctStr && (
                <Text style={[s.pctText, isUp ? s.pctUp : s.pctDown]}>
                  {pctStr}
                </Text>
              )}
            </>
          ) : (
            <Text style={s.priceMissing}>—</Text>
          )}
        </View>

        <View style={s.targetCell}>
          {targetStr ? (
            <>
              <Text style={s.targetLabel}>TGT</Text>
              <Text style={s.targetText}>{targetStr}</Text>
              {upsideStr && (
                <Text style={[s.upsideText, targetUp ? s.pctUp : s.pctDown]}>
                  {upsideStr}
                </Text>
              )}
            </>
          ) : (
            <Text style={s.targetMissing}>—</Text>
          )}
        </View>

        <Ionicons name="chevron-forward" size={14} color={t.textSecondary} style={s.chev} />
      </TouchableOpacity>
    );
  };

  const lastLoadedStr = lastLoadedAt ? `Updated ${formatTime(lastLoadedAt)}` : '';

  return (
    <View style={s.container}>
      <AppHeader
        title="Research"
        right={
          <TouchableOpacity
            onPress={handleStatusDotPress}
            activeOpacity={0.6}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <View style={[
              s.statusDot,
              { backgroundColor: serverOk === true ? t.green : serverOk === false ? t.red : t.amber },
            ]} />
          </TouchableOpacity>
        }
      />

      {/* Single scroll surface: Analyze → Market Wire → Saved Reports.
          Wire must live inside FlatList header so it is never clipped by the
          list flex layout on small phones. */}
      <FlatList
        style={{ flex: 1 }}
        data={reports}
        keyExtractor={item => item.ticker}
        renderItem={renderReport}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
        ListHeaderComponent={
          <View>
            {/* Ticker input card */}
            <View style={s.inputSection}>
              <Text style={s.label}>ANALYZE TICKER</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={s.input}
                  placeholder="e.g. AAPL"
                  placeholderTextColor={t.textDim}
                  value={ticker}
                  onChangeText={txt => setTicker(txt.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={handleAnalyze}
                />
                <TouchableOpacity
                  style={[s.analyzeBtn, loading && s.analyzeBtnDisabled]}
                  onPress={handleAnalyze}
                  disabled={loading || !ticker.trim()}
                >
                  {loading ? (
                    <View style={s.analyzeBtnInner}>
                      <ActivityIndicator color={t.chromeNavy} size="small" />
                      {runningTicker ? (
                        <Text style={s.analyzeBtnLoadingText}>{runningTicker}…</Text>
                      ) : null}
                    </View>
                  ) : (
                    <Text style={s.analyzeBtnText}>RUN ▶</Text>
                  )}
                </TouchableOpacity>
              </View>
              <View style={s.optionsRow}>
                <View style={s.llmPicker}>
                  {[
                    { v: 'grok',     label: 'Grok' },
                    { v: 'claude',   label: 'Claude' },
                    { v: 'deepseek', label: 'DeepSeek' },
                  ].map(opt => {
                    // Multi-select: llmProvider may be comma-separated list
                    // (kimi stripped — not available for full reports)
                    const selected = String(llmProvider || 'grok')
                      .split(',')
                      .map(s => s.trim())
                      .filter(s => s && s !== 'kimi');
                    const on = selected.indexOf(opt.v) >= 0;
                    return (
                    <TouchableOpacity
                      key={opt.v}
                      onPress={() => {
                        let next = selected.slice();
                        if (on) {
                          if (next.length <= 1) return; // keep ≥1
                          next = next.filter(x => x !== opt.v);
                        } else {
                          next.push(opt.v);
                        }
                        setLlmProvider(next.join(','));
                      }}
                      style={[
                        s.llmPickerOpt,
                        on && (
                          opt.v === 'claude' ? s.llmPickerOptActiveClaude :
                          opt.v === 'deepseek' ? s.llmPickerOptActiveBoth :
                                                s.llmPickerOptActiveGrok
                        ),
                      ]}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        s.llmPickerOptText,
                        on && s.llmPickerOptTextActive,
                      ]}>{opt.label}</Text>
                    </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={{ flex: 1 }} />
                <Text style={s.gammaLabel}>Presentation</Text>
                <Switch
                  value={gammaEnabled}
                  onValueChange={v => { setGammaEnabled(v); saveGamma(v); }}
                  trackColor={{ false: t.border, true: t.primary }}
                  thumbColor={t.onChrome}
                  style={s.gammaSwitch}
                />
              </View>
              <TouchableOpacity
                style={s.analystRow}
                onPress={() => { haptics.onPressPrimary(); navigation.navigate('Analyst'); }}
                activeOpacity={0.7}
              >
                <Text style={s.analystRowEmoji}>🤖</Text>
                <Text style={s.analystRowText} numberOfLines={1}>
                  <Text style={s.analystRowTitle}>AI Analyst</Text> — ask anything across your coverage
                </Text>
                <Text style={s.analystRowArrow}>›</Text>
              </TouchableOpacity>
            </View>

            {/* Market Wire — always visible under Analyze */}
            <View style={s.wireCard}>
              <View style={s.wireHead}>
                <Text style={s.wireTitle}>📡 MARKET WIRE</Text>
                <Text style={s.wireBadge}>FREE · NO AI</Text>
                <View style={{ flex: 1 }} />
                {wireAsOf ? <Text style={s.wireAsOf}>{wireAsOf}</Text> : null}
                {wireLoading ? (
                  <ActivityIndicator size="small" color={t.primary} style={{ marginLeft: 6 }} />
                ) : (
                  <TouchableOpacity onPress={loadMarketWire} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={s.wireRefresh}>↻</Text>
                  </TouchableOpacity>
                )}
              </View>
              {wireError && wireItems.length === 0 ? (
                <Text style={s.wireEmpty}>Could not load wire: {wireError}</Text>
              ) : wireItems.length === 0 && !wireLoading ? (
                <Text style={s.wireEmpty}>
                  No high-signal macro items right now. Tap ↻ or pull to refresh.
                </Text>
              ) : (
                wireItems.slice(0, 8).map((it, i) => {
                  const age = _wireRelAge(it.pub_ts);
                  const feed = it.feed || it.publisher || 'Wire';
                  return (
                    <TouchableOpacity
                      key={(it.url || it.title || '') + i}
                      style={[s.wireRow, i === 0 && s.wireRowFirst]}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (it.url) {
                          haptics.onPressTab?.();
                          Linking.openURL(it.url).catch(() => {});
                        }
                      }}
                    >
                      <Text style={s.wireRowTitle} numberOfLines={2}>{it.title || '—'}</Text>
                      <View style={s.wireRowMeta}>
                        <Text style={s.wireChip}>{feed}</Text>
                        {age ? <Text style={s.wireAge}>{age} ago</Text> : null}
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
              <Text style={s.wireFoot}>Macro / policy RSS · zero tokens</Text>
            </View>

            {/* Reports section header */}
            <View style={s.listHeaderRow}>
              <Text style={s.sectionTitle}>SAVED REPORTS</Text>
              {reports.length > 0 && (
                <Text style={s.countBadge}>{reports.length}</Text>
              )}
              <View style={{ flex: 1 }} />
              {reports.length > 0 && (
                <TouchableOpacity
                  style={s.reanalyzeAllBtn}
                  onPress={handleReanalyzeAll}
                  disabled={bulkPolling}
                  activeOpacity={0.8}
                >
                  <Text style={s.reanalyzeAllBtnText}>
                    {bulkPolling ? '⏳ Re-analyzing…' : '🔄 Re-analyze All'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={s.scanAllBtn} onPress={handleScanAll} activeOpacity={0.8}>
                <Text style={s.scanAllBtnText}>⚡ Scan All</Text>
              </TouchableOpacity>
            </View>

            {bulkJob && (bulkJob.status === 'running' || bulkJob.status === 'queued' ||
                         bulkJob.status === 'done' || bulkJob.status === 'cancelled') && (
              <View style={s.reanalyzeBanner}>
                <View style={s.reanalyzeBannerRow}>
                  <Text style={s.reanalyzeBannerText}>
                    {bulkJob.status === 'done'
                      ? `✓ Done · ${(bulkJob.completed||[]).length}/${bulkJob.total} succeeded · ${(bulkJob.failed||[]).length} failed`
                      : bulkJob.status === 'cancelled'
                      ? `⊘ Cancelled · ${(bulkJob.completed||[]).length}/${bulkJob.total} done before cancel`
                      : `Re-analyzing ${bulkJob.current_ticker || '…'} (${(bulkJob.current_index||0)+1}/${bulkJob.total})`}
                  </Text>
                  {(bulkJob.status === 'running' || bulkJob.status === 'queued') && (
                    <TouchableOpacity style={s.reanalyzeCancelBtn} onPress={handleCancelReanalyze}>
                      <Text style={s.reanalyzeCancelText}>CANCEL</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={s.reanalyzeBarTrack}>
                  <View style={[s.reanalyzeBarFill,
                                { width: `${Math.min(100, Math.max(0, bulkJob.progress_pct || 0))}%` }]} />
                </View>
              </View>
            )}
            {lastLoadedStr ? (
              <View style={{ marginHorizontal: 16, marginBottom: 4 }}>
                <Text style={s.lastLoadedText}>{lastLoadedStr}</Text>
              </View>
            ) : null}

            {reports.length > 0 ? (
              <View style={[s.colHeader, s.listContent, { marginBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }]}>
                <Text style={[s.colHeaderText, { flex: 1 }]}>TICKER</Text>
                <Text style={[s.colHeaderText, s.colHeaderPrice]}>PRICE</Text>
                <Text style={[s.colHeaderText, s.colHeaderTarget]}>TGT / UPSIDE</Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          initialLoading ? (
            <SkeletonList count={5} />
          ) : (
            <View style={s.emptyWrap}>
              <Ionicons name="documents-outline" size={44} color={t.textDim} />
              <Text style={s.emptyTitle}>No reports yet</Text>
              <Text style={s.emptySubtitle}>
                Type a ticker above and tap RUN ▶ to generate your first institutional analysis.
              </Text>
            </View>
          )
        }
        // Never justifyContent:center here — that vertically centered the
        // ListHeader (Analyze + Market Wire) and made the wire look "gone"
        // on phones with no saved reports.
        contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
      />
    </View>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
  container:  { flex: 1, backgroundColor: t.bg },
  statusDot:  { width: 10, height: 10, borderRadius: 5 },

  // Input card — denser on mobile (smaller paddings / controls)
  inputSection: {
    backgroundColor: t.surface,
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  label:    { fontSize: 9, fontWeight: '700', color: t.textSecondary, letterSpacing: 1.2, marginBottom: 4 },
  inputRow: { flexDirection: 'row', gap: 6 },
  input: {
    flex: 1,
    height: 34,
    borderWidth: 1,
    borderColor: t.border,
    borderRadius: 7,
    paddingHorizontal: 10,
    fontSize: 14,
    fontWeight: '700',
    color: t.textPrimary,
    letterSpacing: 1.2,
    paddingVertical: 0,
  },
  analyzeBtn: {
    backgroundColor: t.primary,
    borderRadius: 7,
    paddingHorizontal: 12,
    minWidth: 64,
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: t.primary,
    borderBottomWidth: 2,
    borderBottomColor: t.primary,
    ...Platform.select({
      ios: {
        shadowColor: t.primary,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.4,
        shadowRadius: 6,
      },
      android: { elevation: 4 },
    }),
  },
  analyzeBtnDisabled: { opacity: 0.5 },
  analyzeBtnInner: { flexDirection: 'row', alignItems: 'center' },
  analyzeBtnText: { color: t.chromeNavy, fontWeight: '800', fontSize: 11, letterSpacing: 0.8 },
  analyzeBtnLoadingText: { color: t.chromeNavy, fontWeight: '800', fontSize: 10, letterSpacing: 0.6, marginLeft: 4 },

  // Slim options row — engine chips left, presentation toggle right
  optionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  gammaLabel: { fontSize: 10, fontWeight: '600', color: t.textSecondary, marginRight: 2 },
  gammaSwitch: { transform: [{ scaleX: 0.68 }, { scaleY: 0.68 }] },
  llmPicker: {
    flexDirection: 'row', backgroundColor: t.surfaceAlt,
    borderRadius: 5, padding: 1.5, gap: 1,
  },
  llmPickerOpt: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 4,
  },
  llmPickerOptActiveGrok:   { backgroundColor: '#0A1628' },
  llmPickerOptActiveClaude: { backgroundColor: '#d97706' },
  llmPickerOptActiveKimi:   { backgroundColor: '#166534' },
  llmPickerOptActiveBoth:   { backgroundColor: '#475569' },
  llmPickerOptText: {
    fontSize: 10, fontWeight: '700', color: t.textPrimary,
  },
  llmPickerOptTextActive: { color: t.onChrome },

  // AI Analyst entry — slim row at the bottom of the input card
  analystRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: t.border,
  },
  analystRowEmoji: { fontSize: 13, marginRight: 6 },
  analystRowText:  { flex: 1, fontSize: 11.5, color: t.textSecondary },
  analystRowTitle: { fontWeight: '800', color: t.textPrimary },
  analystRowArrow: { color: t.gold, fontSize: 18, fontWeight: '300', marginLeft: 6, lineHeight: 20 },

  // Market Wire card (under Analyze)
  wireCard: {
    backgroundColor: t.surface,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
    borderWidth: 1,
    borderColor: t.border,
  },
  wireHead: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6,
  },
  wireTitle: {
    fontSize: 9, fontWeight: '800', color: t.textSecondary, letterSpacing: 1.1,
  },
  wireBadge: {
    fontSize: 8, fontWeight: '800', letterSpacing: 0.4,
    color: '#166534', backgroundColor: '#dcfce7',
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden',
  },
  wireAsOf: { fontSize: 9, color: t.textDim, fontWeight: '600' },
  wireRefresh: { fontSize: 14, color: t.primary, fontWeight: '700', paddingHorizontal: 4 },
  wireEmpty: {
    fontSize: 11, color: t.textDim, lineHeight: 15, paddingVertical: 6,
  },
  wireRow: {
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border,
  },
  wireRowFirst: { borderTopWidth: 0, paddingTop: 2 },
  wireRowTitle: {
    fontSize: 12, fontWeight: '600', color: t.textPrimary, lineHeight: 16,
  },
  wireRowMeta: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3,
  },
  wireChip: {
    fontSize: 9, fontWeight: '700', color: t.primary,
    backgroundColor: t.surfaceAlt || t.bg,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden',
  },
  wireAge: { fontSize: 10, color: t.textDim, fontWeight: '600' },
  wireFoot: {
    fontSize: 9, color: t.textDim, marginTop: 4, paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border,
  },

  // Per-report provider badges (GROK / CLAUDE) — tappable
  llmPill: {
    borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1,
    marginRight: 2,
  },
  llmPillGrok:   { backgroundColor: '#0A1628' },
  llmPillClaude: { backgroundColor: '#d97706' },
  llmPillText:   { fontSize: 9, fontWeight: '800', color: t.onChrome, letterSpacing: 0.4 },

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
  sectionTitle: { fontSize: 11, fontWeight: '700', color: t.textSecondary, letterSpacing: 1.5 },
  countBadge: {
    marginLeft: 8,
    fontSize: 11, fontWeight: '700', color: t.primary,
    backgroundColor: t.chromeNavy,
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10,
    overflow: 'hidden',
  },
  lastLoadedText: { fontSize: 10, fontWeight: '600', color: t.textSecondary, letterSpacing: 0.3 },
  scanAllBtn: {
    backgroundColor: t.primary,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  scanAllBtnText: { color: t.chromeNavy, fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },

  // List container
  listContent: {
    backgroundColor: t.surface,
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
    borderBottomWidth: 1, borderBottomColor: t.border,
  },
  colHeaderText: { fontSize: 9, fontWeight: '800', color: t.textSecondary, letterSpacing: 1.2 },

  reportRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(91,184,212,0.25)',
  },
  sep: { height: 1, backgroundColor: t.border, marginLeft: 14 },
  tickerCell:    { flex: 1 },
  reportTicker:  { fontSize: 15, fontWeight: '800', color: t.textPrimary, letterSpacing: 1.2, lineHeight: 18 },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  docPill: { backgroundColor: t.chromeNavy, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  docPillText: { color: t.onChrome, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  pptPill: { backgroundColor: t.primary, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  pptPillText: { color: t.chromeNavy, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  reportDate: { fontSize: 11, color: t.textSecondary, marginLeft: 3 },

  priceCell: { alignItems: 'flex-end', minWidth: 78, marginRight: 10 },
  priceText: { fontSize: 14, fontWeight: '700', color: t.textPrimary, fontFamily: 'Courier New', lineHeight: 16 },
  pctText: { fontSize: 11, fontWeight: '700', fontFamily: 'Courier New', lineHeight: 13, marginTop: 1 },
  pctUp:   { color: t.green },
  pctDown: { color: t.red },
  priceMissing: { fontSize: 14, color: t.textDim, fontFamily: 'Courier New' },

  targetCell: { alignItems: 'flex-end', minWidth: 70 },
  targetLabel: { fontSize: 7, fontWeight: '800', color: t.primary, letterSpacing: 1.0, lineHeight: 10 },
  targetText: { fontSize: 13, fontWeight: '700', color: t.textPrimary, fontFamily: 'Courier New', lineHeight: 16 },
  upsideText: { fontSize: 11, fontWeight: '700', fontFamily: 'Courier New', lineHeight: 13, marginTop: 1 },
  targetMissing: { fontSize: 13, color: t.textDim, fontFamily: 'Courier New' },

  colHeaderPrice:  { width: 78, marginRight: 10, textAlign: 'right' },
  colHeaderTarget: { width: 70, textAlign: 'right', color: t.primary },
  chev: { marginLeft: 6 },

  emptyContainer: { flexGrow: 1, justifyContent: 'center', backgroundColor: 'transparent' },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 24,
    marginHorizontal: 16,
    backgroundColor: t.surface,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: t.textPrimary, marginTop: 12, letterSpacing: 0.4 },
  emptySubtitle: { fontSize: 13, color: t.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 18 },
});
}
