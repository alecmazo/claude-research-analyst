/**
 * PaperTrackerScreen — Paper Portfolios + Live Benchmark
 *
 * Shows the live benchmark card (expandable → YTD detail + email) and the
 * list of Intelligence-brief paper portfolios tracked vs SPY and the live
 * portfolio. YTD upload / attribution is handled in Fund → My Portfolio.
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import { Skeleton, useTheme } from '../design';

export default function PaperTrackerScreen({ navigation }) {
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [portfolios,   setPortfolios]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [refreshing,   setRefreshing]   = useState(false);
  const [expandedId,   setExpandedId]   = useState(null);
  const [detailCache,  setDetailCache]  = useState({});

  // Live benchmark + YTD detail expansion
  const [live,         setLive]         = useState(null);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [liveDetail,   setLiveDetail]   = useState(null);
  const [liveLoading,  setLiveLoading]  = useState(false);

  // Email report (inside live detail expansion)
  const [emailAddr,    setEmailAddr]    = useState('');
  const [emailStatus,  setEmailStatus]  = useState(null);
  const [emailSending, setEmailSending] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = async () => {
    try {
      const [data, liveData] = await Promise.all([
        api.listTrackers(),
        api.getLiveBenchmark().catch(() => ({})),
      ]);
      setPortfolios(data.portfolios || []);
      setLive(liveData?.live_portfolio || null);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Formatters ────────────────────────────────────────────────────────────
  const fmtPct   = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const pctColor = (x) => x == null ? t.textSecondary : x > 0 ? '#16A34A' : x < 0 ? '#DC2626' : t.textSecondary;

  // ── Paper portfolio handlers ───────────────────────────────────────────────
  const openDetail = async (p) => {
    if (expandedId === p.id) { setExpandedId(null); return; }
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

  const handleClose = (p) => {
    Alert.alert(
      'Stop tracking?',
      `${p.name} will stop receiving daily snapshots. History is preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Stop', style: 'destructive', onPress: async () => {
          await api.closeTracker(p.id); load();
        }},
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
          await api.deleteTracker(p.id); setExpandedId(null); load();
        }},
      ]
    );
  };

  // ── Live benchmark detail ──────────────────────────────────────────────────
  const loadLiveDetail = async () => {
    setLiveLoading(true);
    setEmailStatus(null);
    try {
      const d = await api.getLiveBenchmarkDetail(null); // latest snapshot
      if (d?.ok) { setLiveDetail(d); }
      else        { Alert.alert('Could not load', d?.error || 'Live YTD detail unavailable.'); }
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLiveLoading(false);
    }
  };

  const toggleLiveDetail = async () => {
    const willExpand = !liveExpanded;
    setLiveExpanded(willExpand);
    if (willExpand && !liveDetail) await loadLiveDetail();
  };

  // ── Email ─────────────────────────────────────────────────────────────────
  const sendEmail = async () => {
    const e = (emailAddr || '').trim();
    if (!e || !e.includes('@')) {
      setEmailStatus({ kind: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setEmailSending(true);
    setEmailStatus({ kind: 'pending', text: 'Sending…' });
    try {
      const r = await api.emailYtdReport(e, null); // always email latest run
      setEmailStatus({ kind: 'ok', text: `✓ Sent to ${r.sent_to || e}.` });
    } catch (err) {
      setEmailStatus({ kind: 'error', text: `Error: ${err.message}` });
    } finally {
      setEmailSending(false);
    }
  };

  // ── Render: header ────────────────────────────────────────────────────────
  const renderHeader = () => (
    <View style={s.header}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
        <Ionicons name="arrow-back" size={22} color={t.onChrome} />
      </TouchableOpacity>
      <Text style={s.headerTitle}>Paper Portfolios</Text>
      <View style={{ width: 38 }} />
    </View>
  );

  // ── Render: live benchmark card ────────────────────────────────────────────
  const renderLiveCard = () => {
    if (!live) {
      return (
        <View style={s.card}>
          <Text style={s.cardLabel}>LIVE BENCHMARK</Text>
          <Text style={s.emptyHint}>
            No live portfolio yet. Upload Fidelity CSVs in{'\n'}
            <Text style={{ fontWeight: '800' }}>Fund → My Portfolio</Text> to set the benchmark.
          </Text>
        </View>
      );
    }
    const sorted = (live.holdings || []).slice().sort((a, b) => b.weight - a.weight);

    return (
      <View style={s.card}>
        <TouchableOpacity onPress={toggleLiveDetail} activeOpacity={0.85}>
          <View style={s.liveHeaderRow}>
            <Text style={s.cardLabel}>LIVE BENCHMARK</Text>
            <View style={s.liveDrillHint}>
              <Text style={s.liveDrillHintText}>
                {liveExpanded ? 'HIDE YTD' : 'YTD DETAIL →'}
              </Text>
            </View>
          </View>
          <View style={s.liveLine}>
            <Text style={s.liveKey}>ANCHOR DATE</Text>
            <Text style={s.liveVal}>{live.anchor_date || '—'}</Text>
          </View>
          <View style={s.liveLine}>
            <Text style={s.liveKey}>HOLDINGS</Text>
            <Text style={s.liveVal}>{sorted.length} positions</Text>
          </View>
          <View style={s.liveChipsWrap}>
            {sorted.map(h => (
              <View key={h.ticker} style={s.liveChip}>
                <Text style={s.liveChipTicker}>{h.ticker}</Text>
                <Text style={s.liveChipWeight}>{(h.weight * 100).toFixed(1)}%</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>

        {liveExpanded && (
          <View style={s.liveDetailWrap}>
            {liveLoading || !liveDetail ? (
              <ActivityIndicator color={t.primary} style={{ marginVertical: 16 }} />
            ) : (
              <>
                <View style={s.liveYtdMetrics}>
                  <View style={s.metric}>
                    <Text style={s.metricKey}>YTD RETURN</Text>
                    <Text style={[s.metricVal, { color: pctColor(liveDetail.current_return_pct) }]}>
                      {fmtPct(liveDetail.current_return_pct)}
                    </Text>
                  </View>
                  <View style={s.metric}>
                    <Text style={s.metricKey}>SPY YTD</Text>
                    <Text style={[s.metricVal, { color: pctColor(liveDetail.spy_return_pct) }]}>
                      {fmtPct(liveDetail.spy_return_pct)}
                    </Text>
                  </View>
                  <View style={s.metric}>
                    <Text style={s.metricKey}>VS SPY</Text>
                    <Text style={[s.metricVal, { color: pctColor(liveDetail.vs_spy_pct) }]}>
                      {fmtPct(liveDetail.vs_spy_pct)}
                    </Text>
                  </View>
                  <View style={s.metric}>
                    <Text style={s.metricKey}>MAX DD</Text>
                    <Text style={[s.metricVal, { color: t.textSecondary }]}>
                      -{(liveDetail.max_drawdown_pct || 0).toFixed(1)}%
                    </Text>
                  </View>
                </View>

                <Text style={s.liveYtdSub}>
                  Year-start baseline: {liveDetail.year_start_date} · Day {liveDetail.days_tracked}
                </Text>

                <AttributionView
                  holdings={liveDetail.holdings || []}
                  portfolioReturn={liveDetail.weighted_avg_return || 0}
                />

                <Text style={[s.detailLabel, { marginTop: 14 }]}>
                  HOLDINGS · sorted by contribution
                </Text>
                <View style={s.tableHeader}>
                  <Text style={[s.thCell, { flex: 1.2, textAlign: 'left' }]}>Ticker</Text>
                  <Text style={s.thCell}>Wt</Text>
                  <Text style={s.thCell}>Ret</Text>
                  <Text style={s.thCell}>Contrib</Text>
                </View>
                {(liveDetail.holdings || []).map((h, i, arr) => (
                  <HoldingRow t={t} s={s} key={h.ticker} h={h} idx={i} arr={arr} />
                ))}

                <View style={s.emailBox}>
                  <Text style={s.emailBoxTitle}>EMAIL THIS REPORT</Text>
                  <TextInput
                    style={s.formInput}
                    value={emailAddr}
                    onChangeText={setEmailAddr}
                    placeholder="you@example.com"
                    placeholderTextColor={t.textDim}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    style={[s.btnPrimary, emailSending && { opacity: 0.6 }]}
                    onPress={sendEmail}
                    disabled={emailSending}
                  >
                    {emailSending
                      ? <ActivityIndicator color={t.chromeNavy} />
                      : <Text style={s.btnPrimaryText}>Send Report</Text>}
                  </TouchableOpacity>
                  {emailStatus && (
                    <Text style={[
                      s.emailStatus,
                      emailStatus.kind === 'ok'      && { color: '#16A34A' },
                      emailStatus.kind === 'error'   && { color: t.red },
                      emailStatus.kind === 'pending' && { color: t.textSecondary, fontStyle: 'italic' },
                    ]}>
                      {emailStatus.text}
                    </Text>
                  )}
                </View>
              </>
            )}
          </View>
        )}
      </View>
    );
  };

  // ── Render: paper portfolio row ────────────────────────────────────────────
  const renderRow = (p) => {
    const isOpen = expandedId === p.id;
    const detail = detailCache[p.id];
    const m = p.milestones || {};

    return (
      <View key={p.id} style={[s.row, p.status === 'closed' && { opacity: 0.6 }]}>
        <TouchableOpacity onPress={() => openDetail(p)} activeOpacity={0.85}>
          <View style={s.rowTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowName}>{p.name}</Text>
              <Text style={s.rowSub}>
                {p.n_tickers} tickers · Day {p.days_tracked} · Locked {p.entry_date}
              </Text>
            </View>
            <View style={[s.statusPill, p.status === 'closed' && s.statusPillClosed]}>
              <Text style={[s.statusPillText, p.status === 'closed' && { color: t.textSecondary }]}>
                {(p.status || 'tracking').toUpperCase()}
              </Text>
            </View>
          </View>

          {(p.holdings_summary || []).length > 0 && (
            <View style={s.rowTickers}>
              {(p.holdings_summary || []).map(h => (
                <View key={h.ticker} style={s.rowTickerChip}>
                  <Text style={s.rowTickerSym}>{h.ticker}</Text>
                  <Text style={s.rowTickerWt}>{(h.weight * 100).toFixed(1)}%</Text>
                </View>
              ))}
            </View>
          )}

          <View style={s.metricsRow}>
            <Metric t={t} s={s} label="RETURN"  value={fmtPct(p.current_return_pct)}  color={pctColor(p.current_return_pct)} />
            <Metric t={t} s={s} label="VS SPY"  value={fmtPct(p.vs_spy_pct)}          color={pctColor(p.vs_spy_pct)} />
            <Metric t={t} s={s} label="VS LIVE" value={fmtPct(p.vs_live_pct)}         color={pctColor(p.vs_live_pct)} />
            <Metric t={t} s={s} label="MAX DD"  value={`-${(p.max_drawdown_pct || 0).toFixed(1)}%`} color={t.textSecondary} />
          </View>

          <View style={s.milestones}>
            <Milestone t={t} s={s} label="30D" reached={m.d30} />
            <Milestone t={t} s={s} label="60D" reached={m.d60} />
            <Milestone t={t} s={s} label="90D" reached={m.d90} />
            <Ionicons
              name={isOpen ? 'chevron-up' : 'chevron-down'}
              size={16} color={t.textSecondary}
              style={{ marginLeft: 'auto' }}
            />
          </View>
        </TouchableOpacity>

        {isOpen && (
          <View style={s.detail}>
            {!detail ? (
              <ActivityIndicator color={t.primary} style={{ marginVertical: 16 }} />
            ) : (
              <>
                <AttributionView
                  holdings={detail.holdings || []}
                  portfolioReturn={detail.weighted_avg_return || 0}
                />
                <Text style={[s.detailLabel, { marginTop: 14 }]}>
                  HOLDINGS · sorted by contribution
                </Text>
                <View style={s.tableHeader}>
                  <Text style={[s.thCell, { flex: 1.2, textAlign: 'left' }]}>Ticker</Text>
                  <Text style={s.thCell}>Wt</Text>
                  <Text style={s.thCell}>Ret</Text>
                  <Text style={s.thCell}>Contrib</Text>
                </View>
                {(detail.holdings || []).map((h, i, arr) => (
                  <HoldingRow t={t} s={s} key={h.ticker} h={h} idx={i} arr={arr} />
                ))}
                {p.status === 'tracking' && (
                  <View style={s.actionRow}>
                    <TouchableOpacity style={s.btnSecondary} onPress={() => handleClose(p)}>
                      <Text style={s.btnSecondaryText}>Stop Tracking</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.btnDanger} onPress={() => handleDelete(p)}>
                      <Text style={s.btnDangerText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {p.status === 'closed' && (
                  <View style={s.actionRow}>
                    <TouchableOpacity style={[s.btnDanger, { flex: 1 }]} onPress={() => handleDelete(p)}>
                      <Text style={s.btnDangerText}>Delete Portfolio</Text>
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

  // ── Root render ────────────────────────────────────────────────────────────
  return (
    <View style={s.wrapper}>
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
        >
          {renderLiveCard()}

          <View style={[s.card, { paddingTop: 14 }]}>
            <Text style={s.cardLabel}>PAPER PORTFOLIOS</Text>
            <Text style={s.hintText}>
              Intelligence brief baskets tracked vs SPY and your live portfolio from the day they were locked in.
            </Text>
            {loading ? (
              <View style={{ gap: 10, paddingVertical: 6 }}>
                {[0, 1, 2].map(i => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Skeleton width={'60%'} height={14} radius={3} />
                      <View style={{ height: 6 }} />
                      <Skeleton width={'30%'} height={11} radius={3} />
                    </View>
                    <Skeleton width={64} height={20} radius={4} />
                  </View>
                ))}
              </View>
            ) : error ? (
              <Text style={s.errorText}>{error}</Text>
            ) : portfolios.length === 0 ? (
              <Text style={s.emptyHint}>
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

// ── Sub-components ───────────────────────────────────────────────────────────
function Metric({ t, s, label, value, color }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricKey}>{label}</Text>
      <Text style={[s.metricVal, { color }]}>{value}</Text>
    </View>
  );
}

function Milestone({ t, s, label, reached }) {
  return (
    <View style={[s.ms, reached && s.msReached]}>
      <Text style={[s.msText, reached && s.msTextReached]}>{label}</Text>
    </View>
  );
}

function HoldingRow({ t, s, h, idx, arr }) {
  const ret     = h.return_pct;
  const contrib = h.contribution_pct;
  const cRet    = ret     == null ? t.textSecondary : ret     > 0 ? '#16A34A' : ret     < 0 ? '#DC2626' : t.textSecondary;
  const cCon    = contrib == null ? t.textSecondary : contrib > 0 ? '#16A34A' : contrib < 0 ? '#DC2626' : t.textSecondary;
  const sorted  = [...(arr || [])].sort((a, b) => (b.contribution_pct ?? -1e9) - (a.contribution_pct ?? -1e9));
  const top3    = sorted.filter(x => (x.contribution_pct ?? 0) > 0).slice(0, 3).map(x => x.ticker);
  const bot3    = sorted.slice().reverse().filter(x => (x.contribution_pct ?? 0) < 0).slice(0, 3).map(x => x.ticker);
  const tag     = top3.includes(h.ticker) ? '★ ' : bot3.includes(h.ticker) ? '▼ ' : '';
  const tagC    = top3.includes(h.ticker) ? t.primary : bot3.includes(h.ticker) ? '#DC2626' : t.textSecondary;
  return (
    <View style={s.tableRow}>
      <Text style={[s.tdCell, { flex: 1.2, textAlign: 'left' }]}>
        <Text style={{ color: tagC, fontSize: 10 }}>{tag}</Text>
        <Text style={{ fontWeight: '800', color: t.textPrimary }}>{h.ticker}</Text>
      </Text>
      <Text style={s.tdCell}>{(h.weight * 100).toFixed(1)}%</Text>
      <Text style={[s.tdCell, { color: cRet, fontWeight: '700' }]}>
        {ret == null ? '—' : `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`}
      </Text>
      <Text style={[s.tdCell, { color: cCon, fontWeight: '700' }]}>
        {contrib == null ? '—' : `${contrib >= 0 ? '+' : ''}${contrib.toFixed(2)}%`}
      </Text>
    </View>
  );
}

function AttributionView({ t, s, holdings, portfolioReturn }) {
  if (!holdings.length) return null;
  const haveContrib = holdings.some(h => h.contribution_pct != null);
  if (!haveContrib) return null;
  const maxAbs = Math.max(...holdings.map(h => Math.abs(h.contribution_pct ?? 0)), 0.01);
  return (
    <View>
      <View style={s.attrSummary}>
        <View style={[
          s.attrTotalPill,
          { backgroundColor: portfolioReturn >= 0 ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)' },
        ]}>
          <Text style={[s.attrTotalText, { color: portfolioReturn >= 0 ? '#16A34A' : '#DC2626' }]}>
            Portfolio: {portfolioReturn >= 0 ? '+' : ''}{portfolioReturn.toFixed(2)}%
          </Text>
        </View>
        <Text style={s.attrHint}>Where the alpha is coming from</Text>
      </View>
      <View style={s.attrBars}>
        {holdings.map(h => {
          const v = h.contribution_pct ?? 0;
          const isPos = v >= 0;
          const widthPct = Math.abs(v) / maxAbs * 50;
          const ret = h.return_pct;
          return (
            <View key={h.ticker} style={s.attrRow}>
              <Text style={s.attrTicker} numberOfLines={1}>{h.ticker}</Text>
              <View style={s.attrBarTrack}>
                <View style={s.attrAxis} />
                {isPos
                  ? <View style={[s.attrBarPos, { width: `${widthPct}%` }]} />
                  : <View style={[s.attrBarNeg, { width: `${widthPct}%`, right: '50%' }]} />}
              </View>
              <View style={s.attrValBlock}>
                <Text style={[s.attrVal, { color: isPos ? '#16A34A' : '#DC2626' }]}>
                  {isPos ? '+' : ''}{v.toFixed(2)}%
                </Text>
                {ret != null && (
                  <Text style={s.attrRet}>ret {ret >= 0 ? '+' : ''}{ret.toFixed(1)}%</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
function makeStyles(t) {
  return StyleSheet.create({
  wrapper:     { flex: 1, backgroundColor: t.bg },
  header: {
    backgroundColor: t.chromeNavy,
    paddingTop: 60, paddingBottom: 16, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 8,
    backgroundColor: '#1e293b',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: t.onChrome, fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  card: {
    backgroundColor: t.surface, borderRadius: 12, padding: 14, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  cardLabel: {
    fontSize: 11, fontWeight: '700', color: t.textSecondary,
    letterSpacing: 1.5, marginBottom: 10,
  },
  hintText:  { fontSize: 12, color: t.textSecondary, lineHeight: 17, marginBottom: 12 },
  emptyHint: { color: t.textSecondary, fontSize: 13, fontStyle: 'italic', paddingVertical: 12, lineHeight: 19 },
  errorText: { color: t.red, fontSize: 13, paddingVertical: 12 },

  // Live benchmark
  liveHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  liveDrillHint: { backgroundColor: 'rgba(91,184,212,0.12)', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  liveDrillHintText: { color: t.primary, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  liveLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: t.border },
  liveKey:  { fontSize: 11, fontWeight: '700', color: t.textSecondary, letterSpacing: 0.5 },
  liveVal:  { fontSize: 13, fontWeight: '700', color: t.textPrimary },
  liveChipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.border },
  liveChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3, gap: 4 },
  liveChipTicker: { fontFamily: 'Courier New', fontWeight: '800', fontSize: 11, color: t.textPrimary, letterSpacing: 0.4 },
  liveChipWeight: { fontFamily: 'Courier New', fontWeight: '600', fontSize: 11, color: t.textSecondary },
  liveDetailWrap: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: t.border },
  liveYtdMetrics: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  liveYtdSub: { fontSize: 10, color: t.textSecondary, fontStyle: 'italic', marginBottom: 12 },

  // Email
  emailBox: { marginTop: 18, padding: 14, borderRadius: 8, backgroundColor: 'rgba(91,184,212,0.05)', borderWidth: 1, borderColor: 'rgba(91,184,212,0.15)' },
  emailBoxTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 1, color: t.primary, marginBottom: 8 },
  emailStatus: { fontSize: 12, marginTop: 8, fontWeight: '600' },
  formInput: { backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: t.textPrimary, fontFamily: 'Courier New' },
  btnPrimary: { backgroundColor: t.primary, paddingVertical: 12, borderRadius: 6, alignItems: 'center', marginTop: 10 },
  btnPrimaryText: { color: t.chromeNavy, fontSize: 13, fontWeight: '800', letterSpacing: 0.4 },

  // Metrics / milestones
  metricsRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  metric: { flex: 1, backgroundColor: t.surface, borderRadius: 6, padding: 7, borderWidth: 1, borderColor: t.border },
  metricKey: { fontSize: 9, fontWeight: '700', color: t.textSecondary, letterSpacing: 0.4 },
  metricVal: { fontSize: 12, fontWeight: '800', fontFamily: 'Courier New', marginTop: 1 },
  milestones: { flexDirection: 'row', gap: 5, marginTop: 10, alignItems: 'center' },
  ms: { backgroundColor: t.surfaceAlt, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  msReached: { backgroundColor: t.primary },
  msText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7, color: t.textSecondary },
  msTextReached: { color: t.chromeNavy },

  // Portfolio row
  row: { backgroundColor: t.surfaceAlt, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: t.border },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  rowName: { fontSize: 14, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.3 },
  rowSub: { fontSize: 11, color: t.textSecondary, marginTop: 2 },
  statusPill: { backgroundColor: 'rgba(34,197,94,0.15)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  statusPillClosed: { backgroundColor: t.surfaceAlt },
  statusPillText: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#16A34A' },
  rowTickers: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 10, padding: 7, backgroundColor: t.surface, borderRadius: 6, borderWidth: 1, borderColor: t.border },
  rowTickerChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: t.surfaceAlt, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  rowTickerSym: { fontFamily: 'Courier New', fontWeight: '800', fontSize: 10, color: t.textPrimary, letterSpacing: 0.3 },
  rowTickerWt:  { fontFamily: 'Courier New', fontWeight: '600', fontSize: 10, color: t.textSecondary },

  // Detail
  detail: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.border },
  detailLabel: { fontSize: 10, fontWeight: '700', color: t.textSecondary, letterSpacing: 1.2, marginBottom: 6 },
  tableHeader: { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: t.border },
  tableRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.borderSubtle },
  thCell: { flex: 1, fontSize: 10, fontWeight: '700', color: t.textSecondary, letterSpacing: 0.5, textAlign: 'right' },
  tdCell: { flex: 1, fontSize: 12, color: t.textPrimary, fontFamily: 'Courier New', textAlign: 'right' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btnSecondary: { flex: 1, paddingVertical: 9, borderRadius: 6, borderWidth: 1, borderColor: t.border, alignItems: 'center' },
  btnSecondaryText: { fontSize: 12, fontWeight: '700', color: t.textPrimary, letterSpacing: 0.4 },
  btnDanger: { flex: 1, paddingVertical: 9, borderRadius: 6, backgroundColor: 'rgba(239,68,68,0.10)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center' },
  btnDangerText: { fontSize: 12, fontWeight: '700', color: t.red, letterSpacing: 0.4 },

  // Attribution tornado
  attrSummary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  attrTotalPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5 },
  attrTotalText: { fontFamily: 'Courier New', fontSize: 12, fontWeight: '800' },
  attrHint: { fontSize: 10, color: t.textSecondary, fontStyle: 'italic', flexShrink: 1, marginLeft: 8, textAlign: 'right' },
  attrBars: { paddingVertical: 4 },
  attrRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 6 },
  attrTicker: { width: 50, fontFamily: 'Courier New', fontSize: 11, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.3 },
  attrBarTrack: { flex: 1, height: 14, position: 'relative', justifyContent: 'center' },
  attrAxis: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, backgroundColor: t.surfaceAlt },
  attrBarPos: { position: 'absolute', left: '50%', height: 12, backgroundColor: 'rgba(22,163,74,0.85)', borderRadius: 2 },
  attrBarNeg: { position: 'absolute', height: 12, backgroundColor: 'rgba(220,38,38,0.85)', borderRadius: 2 },
  attrValBlock: { width: 64, alignItems: 'flex-end' },
  attrVal: { fontFamily: 'Courier New', fontSize: 11, fontWeight: '800' },
  attrRet: { fontFamily: 'Courier New', fontSize: 9, color: t.textSecondary, marginTop: 1 },
});
}
