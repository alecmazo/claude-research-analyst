/**
 * PaperTrackerScreen — Paper Portfolio Tracker
 *
 * Lists all locked-in paper portfolios with their performance vs SPY and
 * vs the user's live (auto-promoted) portfolio. Tap a row to expand inline
 * and see holdings + per-ticker returns.
 *
 * Reached from PortfolioScreen header "📊 Paper Tracker" button.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { api } from '../api/client';
import { colors } from '../components/theme';

export default function PaperTrackerScreen({ navigation }) {
  const [portfolios, setPortfolios]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [expandedId, setExpandedId]   = useState(null);
  const [detailCache, setDetailCache] = useState({});  // {id: full detail}
  const [live, setLive]               = useState(null);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [liveDetail, setLiveDetail]   = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);

  // ── Unified YTD upload (Modified Dietz + per-stock attribution) ─────────
  const [ytdPosFile,       setYtdPosFile]      = useState(null);
  const [ytdActFile,       setYtdActFile]      = useState(null);
  const [ytdBeginValue,    setYtdBeginValue]   = useState('');
  const [ytdSubmitting,    setYtdSubmitting]   = useState(false);
  const [ytdResult,        setYtdResult]       = useState(null);
  const [ytdError,         setYtdError]        = useState(null);

  const load = async () => {
    try {
      const [data, liveData] = await Promise.all([
        api.listTrackers(),
        api.getLiveBenchmark().catch(() => ({})),
      ]);
      setPortfolios(data.portfolios || []);
      const lp = liveData?.live_portfolio || null;
      setLive(lp);
      // Re-hydrate previously stored unified-YTD result so the attribution
      // table is visible without re-uploading.
      const h = lp?.account_history;
      if (h && h.attribution) {
        const totalGain = (h.attribution || []).reduce((s, a) => s + (a.dollar_gain || 0), 0);
        setYtdResult({
          md_return_pct:     h.md_return_pct,
          begin_value:       h.begin_value,
          end_value:         h.end_value,
          emv_source:        h.emv_source || 'positions_csv',
          net_flow:          h.net_flow,
          flow_count:        h.flow_count,
          trade_count:       h.trade_count,
          dividend_count:    h.dividend_count,
          attribution:       h.attribution,
          total_dollar_gain: totalGain,
          explained_pct:     h.begin_value ? totalGain / h.begin_value * 100 : 0,
        });
      }
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Resilient CSV picker (handles both v12 and v14+ shapes) ──────────────
  const pickCsv = async (setter) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // */* is most reliable on iOS — specific MIME types can grey out CSVs
        // from cloud providers.
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result?.canceled) return;
      const asset = result?.assets?.[0] || (result?.uri ? result : null);
      if (!asset?.uri) {
        Alert.alert('No file selected', 'Could not read the selected file. Try again, or pick a file from Files / iCloud Drive.');
        return;
      }
      setter({
        uri:      asset.uri,
        name:     asset.name     || 'file.csv',
        mimeType: asset.mimeType || asset.type || 'text/csv',
        size:     asset.size,
      });
    } catch (err) {
      Alert.alert('Could not pick file', err.message || String(err));
    }
  };

  // ── Single unified handler (replaces the two separate flows) ─────────────
  const submitYtd = async () => {
    if (!ytdPosFile) { Alert.alert('Missing file', 'Pick your Fidelity Positions CSV.');  return; }
    if (!ytdActFile) { Alert.alert('Missing file', 'Pick your Fidelity Activity CSV.');   return; }
    const bv = parseFloat(ytdBeginValue);
    if (!bv || bv <= 0) { Alert.alert('Missing value', 'Enter your Jan 1 portfolio total.'); return; }

    setYtdSubmitting(true); setYtdError(null); setYtdResult(null);
    try {
      const data = await api.computeUnifiedYtd({
        positionsUri:  ytdPosFile.uri,
        positionsName: ytdPosFile.name,
        positionsType: ytdPosFile.mimeType,
        activityUri:   ytdActFile.uri,
        activityName:  ytdActFile.name,
        activityType:  ytdActFile.mimeType,
        beginValue:    bv,
      });
      setYtdResult(data);
    } catch (e) {
      setYtdError(e.message);
      Alert.alert('Calculation failed', e.message);
    } finally {
      setYtdSubmitting(false);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openDetail = async (p) => {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    if (!detailCache[p.id]) {
      try {
        const d = await api.getTracker(p.id);
        setDetailCache(c => ({ ...c, [p.id]: d }));
      } catch (e) {
        Alert.alert('Could not load detail', e.message);
      }
    }
  };

  // ── Shared formatters (used by all card renderers) ───────────────────────
  const fmtPct  = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const pctColor = (x) => x == null ? colors.midGray : x > 0 ? '#16A34A' : x < 0 ? '#DC2626' : colors.midGray;
  const fmtUSD  = (v) => {
    if (v == null) return '—';
    const abs = Math.abs(v);
    return (v < 0 ? '−' : '') + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const handleClose = (p) => {
    Alert.alert(
      'Stop tracking?',
      `${p.name} will stop receiving daily snapshots. History is preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Stop',   style: 'destructive', onPress: async () => {
          await api.closeTracker(p.id);
          load();
        } },
      ]
    );
  };

  const handleDelete = (p) => {
    Alert.alert(
      'Delete portfolio?',
      `${p.name} and all its tracking history will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          await api.deleteTracker(p.id);
          setExpandedId(null);
          load();
        } },
      ]
    );
  };

  // ── Header ─────────────────────────────────────────────────────────────────
  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
        <Ionicons name="arrow-back" size={22} color={colors.white} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Paper Tracker</Text>
      <View style={{ width: 38 }} />
    </View>
  );

  // ── Unified YTD card (Modified Dietz + per-stock attribution) ───────────
  const renderYtdCard = () => {
    if (!live) return null;  // only show once a live portfolio exists
    const md = ytdResult?.md_return_pct;

    return (
      <View style={styles.card}>
        <Text style={styles.cardLabel}>ACCURATE YTD — CASH-FLOW &amp; TRANSACTION ADJUSTED</Text>
        <Text style={styles.formHint}>
          Upload both Fidelity CSVs to compute a Modified Dietz YTD return and a
          per-stock attribution. Today's account value is auto-extracted from the
          Positions CSV (positions × current prices + money market).
        </Text>

        <Text style={styles.formFieldLabel}>Jan 1 Portfolio Value ($)</Text>
        <TextInput
          style={styles.formInput}
          value={ytdBeginValue}
          onChangeText={setYtdBeginValue}
          keyboardType="numeric"
          placeholder="e.g. 3628719"
          placeholderTextColor={colors.midGray}
        />

        <Text style={styles.formFieldLabel}>Positions CSV (current holdings)</Text>
        <TouchableOpacity style={styles.filePicker} onPress={() => pickCsv(setYtdPosFile)}>
          <Ionicons name="document-text-outline" size={16} color={colors.gold} />
          <Text style={styles.filePickerText} numberOfLines={1}>
            {ytdPosFile?.name || 'Tap to choose Positions CSV…'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.formFieldLabel}>Activity CSV (YTD transactions)</Text>
        <TouchableOpacity style={styles.filePicker} onPress={() => pickCsv(setYtdActFile)}>
          <Ionicons name="document-text-outline" size={16} color={colors.gold} />
          <Text style={styles.filePickerText} numberOfLines={1}>
            {ytdActFile?.name || 'Tap to choose Activity CSV…'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.btnPrimary, ytdSubmitting && { opacity: 0.6 }]}
          onPress={submitYtd}
          disabled={ytdSubmitting}
        >
          {ytdSubmitting ? (
            <ActivityIndicator color={colors.navy} />
          ) : (
            <Text style={styles.btnPrimaryText}>Calculate YTD &amp; Attribution</Text>
          )}
        </TouchableOpacity>

        {ytdError && <Text style={styles.errorText}>{ytdError}</Text>}

        {ytdResult && (
          <View style={styles.resultBox}>
            {/* Hero stat: YTD return */}
            <View style={styles.ytdHeroBox}>
              <Text style={styles.ytdHeroLabel}>YTD RETURN</Text>
              <Text style={[styles.ytdHeroVal, { color: pctColor(md) }]}>{fmtPct(md)}</Text>
              <Text style={styles.ytdHeroSub}>cash-flow adjusted (Modified Dietz)</Text>
            </View>

            {/* Stat grid */}
            <View style={styles.ytdStatGrid}>
              <View style={styles.ytdStatCell}>
                <Text style={styles.ytdStatKey}>JAN 1</Text>
                <Text style={styles.ytdStatVal}>{fmtUSD(ytdResult.begin_value)}</Text>
              </View>
              <View style={styles.ytdStatCell}>
                <Text style={styles.ytdStatKey}>TODAY</Text>
                <Text style={styles.ytdStatVal}>{fmtUSD(ytdResult.end_value)}</Text>
                <Text style={styles.ytdStatBadge}>✓ from CSV</Text>
              </View>
              <View style={styles.ytdStatCell}>
                <Text style={styles.ytdStatKey}>NET FLOWS</Text>
                <Text style={[styles.ytdStatVal, { color: pctColor(ytdResult.net_flow) }]}>
                  {fmtUSD(ytdResult.net_flow)}
                </Text>
                <Text style={styles.ytdStatBadge}>{ytdResult.flow_count ?? 0} events</Text>
              </View>
              <View style={styles.ytdStatCell}>
                <Text style={styles.ytdStatKey}>TRADES</Text>
                <Text style={styles.ytdStatVal}>{ytdResult.trade_count ?? 0}</Text>
                <Text style={styles.ytdStatBadge}>{ytdResult.dividend_count ?? 0} divs</Text>
              </View>
            </View>

            <Text style={styles.attrSectionLabel}>PERFORMANCE ATTRIBUTION — by holding</Text>
            {(ytdResult.attribution || []).map(a => <AttributionRow key={a.ticker} a={a} />)}
          </View>
        )}
      </View>
    );
  };

  // ── Live benchmark card — tappable, expands to YTD detail ─────────────────
  const toggleLiveDetail = async () => {
    const willExpand = !liveExpanded;
    setLiveExpanded(willExpand);
    if (willExpand && !liveDetail) {
      setLiveLoading(true);
      try {
        const d = await api.getLiveBenchmarkDetail();
        if (d?.ok) setLiveDetail(d);
        else Alert.alert('Could not load', d?.error || 'Live YTD detail unavailable.');
      } catch (e) {
        Alert.alert('Error', e.message);
      } finally {
        setLiveLoading(false);
      }
    }
  };

  const renderLiveCard = () => {
    if (!live) {
      return (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LIVE BENCHMARK</Text>
          <Text style={styles.emptyHint}>
            No live portfolio yet. Run a portfolio rebalance to set the benchmark.
          </Text>
        </View>
      );
    }
    const sorted = (live.holdings || [])
      .slice().sort((a, b) => b.weight - a.weight);

    return (
      <View style={styles.card}>
        <TouchableOpacity onPress={toggleLiveDetail} activeOpacity={0.85}>
          <View style={styles.liveHeaderRow}>
            <Text style={styles.cardLabel}>LIVE BENCHMARK</Text>
            <View style={styles.liveDrillHint}>
              <Text style={styles.liveDrillHintText}>
                {liveExpanded ? 'HIDE YTD' : 'YTD DETAIL →'}
              </Text>
            </View>
          </View>
          <View style={styles.liveLine}>
            <Text style={styles.liveKey}>ANCHOR DATE</Text>
            <Text style={styles.liveVal}>{live.anchor_date || '—'}</Text>
          </View>
          <View style={styles.liveLine}>
            <Text style={styles.liveKey}>HOLDINGS</Text>
            <Text style={styles.liveVal}>{sorted.length} positions</Text>
          </View>
          <View style={styles.liveChipsWrap}>
            {sorted.map(h => (
              <View key={h.ticker} style={styles.liveChip}>
                <Text style={styles.liveChipTicker}>{h.ticker}</Text>
                <Text style={styles.liveChipWeight}>{(h.weight * 100).toFixed(1)}%</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>

        {liveExpanded && (
          <View style={styles.liveDetailWrap}>
            {liveLoading || !liveDetail ? (
              <ActivityIndicator color={colors.gold} style={{ marginVertical: 16 }} />
            ) : (
              <>
                {/* Top metrics row — YTD vs SPY */}
                <View style={styles.liveYtdMetrics}>
                  <View style={styles.metric}>
                    <Text style={styles.metricKey}>YTD RETURN</Text>
                    <Text style={[styles.metricVal, { color: pctColor(liveDetail.current_return_pct) }]}>
                      {fmtPct(liveDetail.current_return_pct)}
                    </Text>
                  </View>
                  <View style={styles.metric}>
                    <Text style={styles.metricKey}>SPY YTD</Text>
                    <Text style={[styles.metricVal, { color: pctColor(liveDetail.spy_return_pct) }]}>
                      {fmtPct(liveDetail.spy_return_pct)}
                    </Text>
                  </View>
                  <View style={styles.metric}>
                    <Text style={styles.metricKey}>VS SPY</Text>
                    <Text style={[styles.metricVal, { color: pctColor(liveDetail.vs_spy_pct) }]}>
                      {fmtPct(liveDetail.vs_spy_pct)}
                    </Text>
                  </View>
                  <View style={styles.metric}>
                    <Text style={styles.metricKey}>MAX DD</Text>
                    <Text style={[styles.metricVal, { color: colors.midGray }]}>
                      -{(liveDetail.max_drawdown_pct || 0).toFixed(1)}%
                    </Text>
                  </View>
                </View>

                <Text style={styles.liveYtdSub}>
                  Year-start baseline: {liveDetail.year_start_date} · Day {liveDetail.days_tracked}
                </Text>

                {/* Attribution: where the alpha is coming from */}
                <AttributionView
                  holdings={liveDetail.holdings || []}
                  portfolioReturn={liveDetail.weighted_avg_return || 0}
                />

                {/* Holdings table */}
                <Text style={[styles.detailLabel, { marginTop: 14 }]}>
                  HOLDINGS · sorted by contribution
                </Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.thCell, { flex: 1.2, textAlign: 'left' }]}>Ticker</Text>
                  <Text style={styles.thCell}>Wt</Text>
                  <Text style={styles.thCell}>Ret</Text>
                  <Text style={styles.thCell}>Contrib</Text>
                </View>
                {(liveDetail.holdings || []).map((h, i, arr) => (
                  <HoldingRow key={h.ticker} h={h} idx={i} arr={arr} />
                ))}
              </>
            )}
          </View>
        )}
      </View>
    );
  };

  // ── Portfolio row ──────────────────────────────────────────────────────────
  // (fmtPct / pctColor hoisted above for use by all card renderers)
  const renderRow = (p) => {
    const isOpen = expandedId === p.id;
    const detail = detailCache[p.id];
    const m = p.milestones || {};

    return (
      <View key={p.id} style={[styles.row, p.status === 'closed' && { opacity: 0.6 }]}>
        <TouchableOpacity onPress={() => openDetail(p)} activeOpacity={0.85}>
          <View style={styles.rowTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowName}>{p.name}</Text>
              <Text style={styles.rowSub}>
                {p.n_tickers} tickers · Day {p.days_tracked} · Locked {p.entry_date}
              </Text>
            </View>
            <View style={[
              styles.statusPill,
              p.status === 'closed' && styles.statusPillClosed,
            ]}>
              <Text style={[
                styles.statusPillText,
                p.status === 'closed' && { color: colors.midGray },
              ]}>
                {(p.status || 'tracking').toUpperCase()}
              </Text>
            </View>
          </View>

          {/* Ticker chips — see what's actually in the basket at a glance */}
          {(p.holdings_summary || []).length > 0 && (
            <View style={styles.rowTickers}>
              {(p.holdings_summary || []).map(h => (
                <View key={h.ticker} style={styles.rowTickerChip}>
                  <Text style={styles.rowTickerSym}>{h.ticker}</Text>
                  <Text style={styles.rowTickerWt}>{(h.weight * 100).toFixed(1)}%</Text>
                </View>
              ))}
            </View>
          )}

          <View style={styles.metricsRow}>
            <Metric label="RETURN"  value={fmtPct(p.current_return_pct)}  color={pctColor(p.current_return_pct)} />
            <Metric label="VS SPY"  value={fmtPct(p.vs_spy_pct)}          color={pctColor(p.vs_spy_pct)} />
            <Metric label="VS LIVE" value={fmtPct(p.vs_live_pct)}         color={pctColor(p.vs_live_pct)} />
            <Metric label="MAX DD"  value={`-${(p.max_drawdown_pct || 0).toFixed(1)}%`} color={colors.midGray} />
          </View>

          <View style={styles.milestones}>
            <Milestone label="30D" reached={m.d30} />
            <Milestone label="60D" reached={m.d60} />
            <Milestone label="90D" reached={m.d90} />
            <Ionicons
              name={isOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.midGray}
              style={{ marginLeft: 'auto' }}
            />
          </View>
        </TouchableOpacity>

        {isOpen && (
          <View style={styles.detail}>
            {!detail ? (
              <ActivityIndicator color={colors.gold} style={{ marginVertical: 16 }} />
            ) : (
              <>
                {/* Attribution: tornado bars */}
                <AttributionView holdings={detail.holdings || []}
                                 portfolioReturn={detail.weighted_avg_return || 0} />

                {/* Holdings table */}
                <Text style={[styles.detailLabel, { marginTop: 14 }]}>
                  HOLDINGS · sorted by contribution
                </Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.thCell, { flex: 1.2, textAlign: 'left' }]}>Ticker</Text>
                  <Text style={styles.thCell}>Wt</Text>
                  <Text style={styles.thCell}>Ret</Text>
                  <Text style={styles.thCell}>Contrib</Text>
                </View>
                {(detail.holdings || []).map((h, i, arr) => (
                  <HoldingRow key={h.ticker} h={h} idx={i} arr={arr} />
                ))}

                {p.status === 'tracking' && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={styles.btnSecondary} onPress={() => handleClose(p)}>
                      <Text style={styles.btnSecondaryText}>Stop Tracking</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.btnDanger} onPress={() => handleDelete(p)}>
                      <Text style={styles.btnDangerText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {p.status === 'closed' && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={[styles.btnDanger, { flex: 1 }]} onPress={() => handleDelete(p)}>
                      <Text style={styles.btnDangerText}>Delete Portfolio</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.wrapper}>
      {renderHeader()}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        >
          {renderLiveCard()}
          {renderYtdCard()}

          <View style={[styles.card, { paddingTop: 14 }]}>
            <Text style={styles.cardLabel}>PAPER PORTFOLIOS</Text>
            {loading ? (
              <ActivityIndicator color={colors.gold} style={{ marginVertical: 24 }} />
            ) : error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : portfolios.length === 0 ? (
              <Text style={styles.emptyHint}>
                No paper portfolios yet. Generate an Intelligence brief, then tap{' '}
                <Text style={{ fontWeight: '800' }}>📌 Track Brief</Text> to lock in.
              </Text>
            ) : (
              portfolios.map(renderRow)
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────
function Metric({ label, value, color }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricKey}>{label}</Text>
      <Text style={[styles.metricVal, { color }]}>{value}</Text>
    </View>
  );
}

function Milestone({ label, reached }) {
  return (
    <View style={[styles.ms, reached && styles.msReached]}>
      <Text style={[styles.msText, reached && styles.msTextReached]}>{label}</Text>
    </View>
  );
}

function HoldingRow({ h, idx, arr }) {
  // Server-computed return + contribution + vs_avg now arrive in the holding object.
  const ret    = h.return_pct;
  const contrib = h.contribution_pct;
  const colorRet     = ret     == null ? colors.midGray : ret     > 0 ? '#16A34A' : ret     < 0 ? '#DC2626' : colors.midGray;
  const colorContrib = contrib == null ? colors.midGray : contrib > 0 ? '#16A34A' : contrib < 0 ? '#DC2626' : colors.midGray;

  // Mark top 3 contributors and bottom 3 detractors for visual scanning
  const sorted = [...(arr || [])].sort((a, b) => (b.contribution_pct ?? -1e9) - (a.contribution_pct ?? -1e9));
  const top3 = sorted.filter(x => (x.contribution_pct ?? 0) > 0).slice(0, 3).map(x => x.ticker);
  const bot3 = sorted.slice().reverse().filter(x => (x.contribution_pct ?? 0) < 0).slice(0, 3).map(x => x.ticker);
  const tag = top3.includes(h.ticker) ? '★ ' : bot3.includes(h.ticker) ? '▼ ' : '';
  const tagColor = top3.includes(h.ticker) ? colors.gold : bot3.includes(h.ticker) ? '#DC2626' : colors.midGray;

  return (
    <View style={styles.tableRow}>
      <Text style={[styles.tdCell, { flex: 1.2, textAlign: 'left' }]}>
        <Text style={{ color: tagColor, fontSize: 10 }}>{tag}</Text>
        <Text style={{ fontWeight: '800', color: colors.navy }}>{h.ticker}</Text>
      </Text>
      <Text style={styles.tdCell}>{(h.weight * 100).toFixed(1)}%</Text>
      <Text style={[styles.tdCell, { color: colorRet, fontWeight: '700' }]}>
        {ret == null ? '—' : `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`}
      </Text>
      <Text style={[styles.tdCell, { color: colorContrib, fontWeight: '700' }]}>
        {contrib == null ? '—' : `${contrib >= 0 ? '+' : ''}${contrib.toFixed(2)}%`}
      </Text>
    </View>
  );
}

// ── Attribution view: tornado-style bars showing contribution to total return
function AttributionView({ holdings, portfolioReturn }) {
  if (!holdings.length) return null;
  const haveContrib = holdings.some(h => h.contribution_pct != null);
  if (!haveContrib) return null;

  const maxAbs = Math.max(...holdings.map(h => Math.abs(h.contribution_pct ?? 0)), 0.01);

  return (
    <View>
      <View style={styles.attrSummary}>
        <View style={[
          styles.attrTotalPill,
          { backgroundColor: portfolioReturn >= 0 ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)' },
        ]}>
          <Text style={[
            styles.attrTotalText,
            { color: portfolioReturn >= 0 ? '#16A34A' : '#DC2626' },
          ]}>
            Portfolio: {portfolioReturn >= 0 ? '+' : ''}{portfolioReturn.toFixed(2)}%
          </Text>
        </View>
        <Text style={styles.attrHint}>Where the alpha is coming from</Text>
      </View>

      {/* Tornado bars centered on a vertical axis */}
      <View style={styles.attrBars}>
        {holdings.map(h => {
          const v = h.contribution_pct ?? 0;
          const isPos = v >= 0;
          const widthPct = Math.abs(v) / maxAbs * 50; // each side gets up to 50%
          const ret = h.return_pct;
          return (
            <View key={h.ticker} style={styles.attrRow}>
              <Text style={styles.attrTicker} numberOfLines={1}>{h.ticker}</Text>
              <View style={styles.attrBarTrack}>
                <View style={styles.attrAxis} />
                {isPos ? (
                  <View style={[styles.attrBarPos, { width: `${widthPct}%` }]} />
                ) : (
                  <View style={[styles.attrBarNeg, { width: `${widthPct}%`, right: '50%' }]} />
                )}
              </View>
              <View style={styles.attrValBlock}>
                <Text style={[
                  styles.attrVal,
                  { color: isPos ? '#16A34A' : '#DC2626' },
                ]}>
                  {isPos ? '+' : ''}{v.toFixed(2)}%
                </Text>
                {ret != null && (
                  <Text style={styles.attrRet}>
                    ret {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Result key/value row used in history result box ────────────────────────
function ResultRow({ label, value, valueColor, mono }) {
  return (
    <View style={styles.resultRow}>
      {typeof label === 'string'
        ? <Text style={styles.resultKey}>{label}</Text>
        : label}
      <Text style={[
        styles.resultVal,
        mono && { fontFamily: 'Courier New' },
        valueColor && { color: valueColor },
      ]}>
        {value}
      </Text>
    </View>
  );
}

// ── Per-ticker attribution row ──────────────────────────────────────────────
function AttributionRow({ a }) {
  const fmtShares = (n) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtUSD    = (v) => {
    if (v == null) return '—';
    const abs = Math.abs(v);
    return (v < 0 ? '−' : '') + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  };
  const colorPL  = a.dollar_gain >= 0 ? '#16A34A' : '#DC2626';
  const colorCon = a.contribution_pct >= 0 ? '#16A34A' : '#DC2626';

  const chips = [];
  if (a.total_sold_shares > 0) {
    const px = a.total_sold_shares > 0 ? (a.total_sell_proceeds / a.total_sold_shares).toFixed(2) : '—';
    chips.push({ key: 'sell', label: `▼ ${fmtShares(a.total_sold_shares)} @ $${px}`, bg: 'rgba(220,38,38,0.10)', fg: '#DC2626' });
  }
  if (a.total_bought_shares > 0) {
    const px = a.total_bought_shares > 0 ? (a.total_buy_cost / a.total_bought_shares).toFixed(2) : '—';
    chips.push({ key: 'buy', label: `▲ ${fmtShares(a.total_bought_shares)} @ $${px}`, bg: 'rgba(22,163,74,0.10)', fg: '#16A34A' });
  }
  if (a.dividends_cash > 0) {
    chips.push({ key: 'div', label: `÷ ${fmtUSD(a.dividends_cash)}`, bg: 'rgba(201,168,76,0.12)', fg: colors.gold });
  }

  return (
    <View style={styles.attrCard}>
      <View style={styles.attrCardTop}>
        <Text style={styles.attrCardTicker}>{a.ticker}</Text>
        <View style={styles.attrCardTopRight}>
          <Text style={[styles.attrCardPL, { color: colorPL }]}>{fmtUSD(a.dollar_gain)}</Text>
          <Text style={[styles.attrCardCon, { color: colorCon }]}>
            {a.contribution_pct >= 0 ? '+' : ''}{a.contribution_pct.toFixed(2)}%
          </Text>
        </View>
      </View>

      <View style={styles.attrCardLine}>
        <Text style={styles.attrCardKey}>JAN 1</Text>
        <Text style={styles.attrCardVal}>
          {fmtShares(a.start_shares)} sh @ ${a.jan1_price?.toFixed(2) ?? '—'} = {fmtUSD(a.start_value)}
        </Text>
      </View>
      <View style={styles.attrCardLine}>
        <Text style={styles.attrCardKey}>NOW</Text>
        <Text style={styles.attrCardVal}>
          {a.end_shares > 0
            ? `${fmtShares(a.end_shares)} sh @ $${a.end_price?.toFixed(2) ?? '—'} = ${fmtUSD(a.end_value)}`
            : '— fully sold —'}
        </Text>
      </View>

      {chips.length > 0 && (
        <View style={styles.attrChipRow}>
          {chips.map(c => (
            <View key={c.key} style={[styles.attrChipBox, { backgroundColor: c.bg }]}>
              <Text style={[styles.attrChipText, { color: c.fg }]}>{c.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.offWhite },

  header: {
    backgroundColor: colors.navy,
    paddingTop: 60, paddingBottom: 16, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 8,
    backgroundColor: colors.navyLight,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: colors.white, fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },

  card: {
    backgroundColor: colors.white,
    borderRadius: 12, padding: 14, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  cardLabel: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginBottom: 10,
  },
  emptyHint: {
    color: colors.midGray, fontSize: 13, fontStyle: 'italic',
    paddingVertical: 12, lineHeight: 19,
  },
  errorText: { color: '#DC2626', fontSize: 13, paddingVertical: 12 },

  // Live benchmark
  liveLine: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.lightGray,
  },
  liveKey: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 0.5 },
  liveVal: { fontSize: 13, fontWeight: '700', color: colors.navy },
  liveTop: {
    fontSize: 11, color: colors.darkGray, fontFamily: 'Courier New',
    marginTop: 8, lineHeight: 16,
  },

  // ── Live benchmark expansion ──
  liveHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  liveDrillHint: {
    backgroundColor: 'rgba(201,168,76,0.12)',
    borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2,
  },
  liveDrillHintText: {
    color: colors.gold, fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
  },
  liveDetailWrap: {
    marginTop: 14, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: colors.lightGray,
  },
  liveYtdMetrics: {
    flexDirection: 'row', gap: 6, marginBottom: 8,
  },
  liveYtdSub: {
    fontSize: 10, color: colors.midGray, fontStyle: 'italic',
    marginBottom: 12,
  },

  // ── Live benchmark chips (all positions) ──
  liveChipsWrap: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    marginTop: 12, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.lightGray,
  },
  liveChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.offWhite,
    borderWidth: 1, borderColor: colors.lightGray,
    borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3,
    gap: 4,
  },
  liveChipTicker: {
    fontFamily: 'Courier New', fontWeight: '800',
    fontSize: 11, color: colors.navy, letterSpacing: 0.4,
  },
  liveChipWeight: {
    fontFamily: 'Courier New', fontWeight: '600',
    fontSize: 11, color: colors.midGray,
  },

  // ── Tracker row tickers ──
  rowTickers: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    marginTop: 10, padding: 7,
    backgroundColor: colors.white,
    borderRadius: 6, borderWidth: 1, borderColor: colors.lightGray,
  },
  rowTickerChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.offWhite,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4,
  },
  rowTickerSym: {
    fontFamily: 'Courier New', fontWeight: '800',
    fontSize: 10, color: colors.navy, letterSpacing: 0.3,
  },
  rowTickerWt: {
    fontFamily: 'Courier New', fontWeight: '600',
    fontSize: 10, color: colors.midGray,
  },

  // ── Attribution ──
  attrSummary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  attrTotalPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5,
  },
  attrTotalText: {
    fontFamily: 'Courier New', fontSize: 12, fontWeight: '800',
  },
  attrHint: {
    fontSize: 10, color: colors.midGray, fontStyle: 'italic',
    flexShrink: 1, marginLeft: 8, textAlign: 'right',
  },
  attrBars: {
    paddingVertical: 4,
  },
  attrRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 4, gap: 6,
  },
  attrTicker: {
    width: 50,
    fontFamily: 'Courier New', fontSize: 11, fontWeight: '800',
    color: colors.navy, letterSpacing: 0.3,
  },
  attrBarTrack: {
    flex: 1, height: 14,
    position: 'relative',
    justifyContent: 'center',
  },
  attrAxis: {
    position: 'absolute',
    left: '50%',
    top: 0, bottom: 0,
    width: 1, backgroundColor: colors.lightGray,
  },
  attrBarPos: {
    position: 'absolute',
    left: '50%',
    height: 12,
    backgroundColor: 'rgba(22,163,74,0.85)',
    borderRadius: 2,
  },
  attrBarNeg: {
    position: 'absolute',
    height: 12,
    backgroundColor: 'rgba(220,38,38,0.85)',
    borderRadius: 2,
  },
  attrValBlock: {
    width: 64,
    alignItems: 'flex-end',
  },
  attrVal: {
    fontFamily: 'Courier New', fontSize: 11, fontWeight: '800',
  },
  attrRet: {
    fontFamily: 'Courier New', fontSize: 9,
    color: colors.midGray, marginTop: 1,
  },

  // Portfolio row
  row: {
    backgroundColor: colors.offWhite,
    borderRadius: 10, padding: 12,
    marginBottom: 10,
    borderWidth: 1, borderColor: colors.lightGray,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  rowName: { fontSize: 14, fontWeight: '800', color: colors.navy, letterSpacing: 0.3 },
  rowSub: { fontSize: 11, color: colors.midGray, marginTop: 2 },
  statusPill: {
    backgroundColor: 'rgba(34,197,94,0.15)',
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4,
  },
  statusPillClosed: { backgroundColor: colors.lightGray },
  statusPillText: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#16A34A' },

  // Metrics grid
  metricsRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  metric: {
    flex: 1, backgroundColor: colors.white, borderRadius: 6,
    padding: 7, borderWidth: 1, borderColor: colors.lightGray,
  },
  metricKey:  { fontSize: 9, fontWeight: '700', color: colors.midGray, letterSpacing: 0.4 },
  metricVal:  { fontSize: 12, fontWeight: '800', fontFamily: 'Courier New', marginTop: 1 },

  // Milestones
  milestones: { flexDirection: 'row', gap: 5, marginTop: 10, alignItems: 'center' },
  ms: {
    backgroundColor: colors.lightGray, paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 4,
  },
  msReached: { backgroundColor: colors.gold },
  msText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7, color: colors.midGray },
  msTextReached: { color: colors.navy },

  // Detail
  detail: {
    marginTop: 10, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.lightGray,
  },
  detailLabel: {
    fontSize: 10, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.2, marginBottom: 6,
  },
  tableHeader: {
    flexDirection: 'row', paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: colors.lightGray,
  },
  tableRow: {
    flexDirection: 'row', paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#F1F4F8',
  },
  thCell: {
    flex: 1, fontSize: 10, fontWeight: '700',
    color: colors.midGray, letterSpacing: 0.5, textAlign: 'right',
  },
  tdCell: {
    flex: 1, fontSize: 12, color: colors.darkGray,
    fontFamily: 'Courier New', textAlign: 'right',
  },

  // Actions
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btnSecondary: {
    flex: 1, paddingVertical: 9, borderRadius: 6,
    borderWidth: 1, borderColor: colors.midGray,
    alignItems: 'center',
  },
  btnSecondaryText: { fontSize: 12, fontWeight: '700', color: colors.darkGray, letterSpacing: 0.4 },
  btnDanger: {
    flex: 1, paddingVertical: 9, borderRadius: 6,
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)',
    alignItems: 'center',
  },
  btnDangerText: { fontSize: 12, fontWeight: '700', color: '#DC2626', letterSpacing: 0.4 },

  // ── Form fields (history + attribution cards) ─────────────────────────────
  formHint: {
    fontSize: 12, color: colors.midGray, lineHeight: 17,
    marginBottom: 12,
  },
  formFieldLabel: {
    fontSize: 10, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1, textTransform: 'uppercase',
    marginTop: 10, marginBottom: 4,
  },
  formSubHint: {
    fontSize: 10, color: colors.midGray, fontStyle: 'italic',
    marginBottom: 6, lineHeight: 14,
  },
  formInput: {
    backgroundColor: colors.offWhite,
    borderWidth: 1, borderColor: colors.lightGray,
    borderRadius: 6, paddingHorizontal: 10, paddingVertical: 9,
    fontSize: 14, color: colors.navy,
    fontFamily: 'Courier New',
  },
  filePicker: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.offWhite,
    borderWidth: 1, borderColor: colors.lightGray, borderStyle: 'dashed',
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 11,
    marginBottom: 4,
  },
  filePickerText: {
    fontSize: 12, color: colors.darkGray, flex: 1,
  },
  btnPrimary: {
    backgroundColor: colors.gold,
    paddingVertical: 12, borderRadius: 6,
    alignItems: 'center', marginTop: 14,
  },
  btnPrimaryText: {
    color: colors.navy, fontSize: 13, fontWeight: '800', letterSpacing: 0.4,
  },

  // ── Result box (history) ──────────────────────────────────────────────────
  resultBox: {
    marginTop: 14, padding: 12,
    backgroundColor: colors.navy,
    borderRadius: 8,
  },
  resultTitle: {
    fontSize: 9, fontWeight: '800', letterSpacing: 1,
    color: colors.gold, textTransform: 'uppercase',
    marginBottom: 8,
  },
  resultRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  resultKey: {
    fontSize: 11, color: 'rgba(255,255,255,0.55)',
    flexShrink: 1, marginRight: 8,
  },
  resultVal: {
    fontSize: 13, fontWeight: '800', color: colors.white,
  },
  emvBadge: {
    fontSize: 8, fontWeight: '800', letterSpacing: 0.5,
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3,
    overflow: 'hidden',
  },
  emvBadgeExact: { color: '#4ADE80', backgroundColor: 'rgba(74,222,128,0.15)' },
  emvBadgeEst:   { color: '#FBBF24', backgroundColor: 'rgba(251,191,36,0.15)' },

  // ── Unified YTD result ────────────────────────────────────────────────────
  ytdHeroBox: {
    backgroundColor: 'rgba(201,168,76,0.10)',
    borderRadius: 8, padding: 14,
    borderWidth: 1, borderColor: 'rgba(201,168,76,0.20)',
    alignItems: 'center', marginBottom: 12,
  },
  ytdHeroLabel: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1,
    color: 'rgba(255,255,255,0.5)', marginBottom: 4,
  },
  ytdHeroVal: {
    fontSize: 32, fontWeight: '800',
    fontFamily: 'Courier New', color: colors.white,
  },
  ytdHeroSub: {
    fontSize: 10, color: 'rgba(255,255,255,0.5)',
    fontStyle: 'italic', marginTop: 2,
  },
  ytdStatGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    marginBottom: 14,
  },
  ytdStatCell: {
    flexBasis: '48%', flexGrow: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6, padding: 8,
  },
  ytdStatKey: {
    fontSize: 8, fontWeight: '800', color: 'rgba(255,255,255,0.4)',
    letterSpacing: 0.6, marginBottom: 3,
  },
  ytdStatVal: {
    fontSize: 14, fontWeight: '800', color: colors.white,
    fontFamily: 'Courier New',
  },
  ytdStatBadge: {
    fontSize: 9, color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic', marginTop: 2,
  },
  attrSectionLabel: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1,
    color: colors.gold, marginTop: 4, marginBottom: 6,
  },

  // ── Attribution result ────────────────────────────────────────────────────
  attrSummaryGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    marginBottom: 10,
  },
  attrSummaryCell: {
    flexBasis: '48%', flexGrow: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6, padding: 8,
  },
  attrSummaryKey: {
    fontSize: 8, fontWeight: '800', color: 'rgba(255,255,255,0.4)',
    letterSpacing: 0.6, marginBottom: 3,
  },
  attrSummaryVal: {
    fontSize: 16, fontWeight: '800', color: colors.white,
    fontFamily: 'Courier New',
  },
  attrCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6, padding: 10, marginTop: 6,
  },
  attrCardTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6,
  },
  attrCardTicker: {
    fontSize: 14, fontWeight: '800', color: colors.white,
    letterSpacing: 0.5,
  },
  attrCardTopRight: {
    alignItems: 'flex-end',
  },
  attrCardPL: {
    fontSize: 14, fontWeight: '800', fontFamily: 'Courier New',
  },
  attrCardCon: {
    fontSize: 11, fontWeight: '800', fontFamily: 'Courier New',
    marginTop: 1,
  },
  attrCardLine: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 2,
  },
  attrCardKey: {
    fontSize: 9, fontWeight: '800', color: 'rgba(255,255,255,0.4)',
    letterSpacing: 0.6, width: 42,
  },
  attrCardVal: {
    fontSize: 11, color: 'rgba(255,255,255,0.85)',
    fontFamily: 'Courier New', flex: 1,
  },
  attrChipRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    marginTop: 6,
  },
  attrChipBox: {
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
  },
  attrChipText: {
    fontSize: 9, fontWeight: '700', fontFamily: 'Courier New',
  },
});
