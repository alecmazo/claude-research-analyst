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
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
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

  // ── Live benchmark card ────────────────────────────────────────────────────
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
    const top = (live.holdings || [])
      .slice().sort((a, b) => b.weight - a.weight).slice(0, 5)
      .map(h => `${h.ticker} ${(h.weight * 100).toFixed(1)}%`).join(' · ');
    return (
      <View style={styles.card}>
        <Text style={styles.cardLabel}>LIVE BENCHMARK</Text>
        <View style={styles.liveLine}>
          <Text style={styles.liveKey}>ANCHOR DATE</Text>
          <Text style={styles.liveVal}>{live.anchor_date || '—'}</Text>
        </View>
        <View style={styles.liveLine}>
          <Text style={styles.liveKey}>HOLDINGS</Text>
          <Text style={styles.liveVal}>{(live.holdings || []).length} positions</Text>
        </View>
        <Text style={styles.liveTop} numberOfLines={2}>{top}</Text>
      </View>
    );
  };

  // ── Portfolio row ──────────────────────────────────────────────────────────
  const fmtPct = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const pctColor = (x) => x == null ? colors.midGray : x > 0 ? '#16A34A' : x < 0 ? '#DC2626' : colors.midGray;

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
                <Text style={styles.detailLabel}>HOLDINGS</Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.thCell, { flex: 1.2 }]}>Ticker</Text>
                  <Text style={styles.thCell}>Weight</Text>
                  <Text style={styles.thCell}>Entry</Text>
                  <Text style={styles.thCell}>Return</Text>
                </View>
                {(detail.holdings || []).map(h => (
                  <HoldingRow key={h.ticker} h={h} />
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
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
      >
        {renderLiveCard()}

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

function HoldingRow({ h }) {
  const [cur, setCur] = useState(null);
  React.useEffect(() => {
    api.getQuote(h.ticker).then(q => setCur(q?.price ?? null)).catch(() => {});
  }, [h.ticker]);
  const ret = (cur && h.entry_price) ? ((cur / h.entry_price - 1) * 100) : null;
  const color = ret == null ? colors.midGray : ret > 0 ? '#16A34A' : ret < 0 ? '#DC2626' : colors.midGray;
  return (
    <View style={styles.tableRow}>
      <Text style={[styles.tdCell, { flex: 1.2, fontWeight: '800', color: colors.navy }]}>{h.ticker}</Text>
      <Text style={styles.tdCell}>{(h.weight * 100).toFixed(1)}%</Text>
      <Text style={styles.tdCell}>${h.entry_price.toFixed(2)}</Text>
      <Text style={[styles.tdCell, { color, fontWeight: '700' }]}>
        {ret == null ? '—' : `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`}
      </Text>
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
});
