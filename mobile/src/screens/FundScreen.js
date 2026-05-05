/**
 * FundScreen — DGA Capital Fund I dashboard
 *
 * Shows live data from Railway Postgres via the Fund Admin API endpoints:
 *   /api/fund/overview  — NAV, economics, gain
 *   /api/fund/lps       — LP capital accounts
 *   /api/fund/positions — portfolio cost basis
 *   /api/fund/activity  — recent journal entries
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, RefreshControl,
  StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import AppHeader from '../components/AppHeader';
import { colors } from '../components/theme';
import { api } from '../api/client';

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt$ = (n) => {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPct = (n, decimals = 1) => {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(decimals) + '%';
};
const fmtCat = (cat) =>
  (cat || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Tabs within the Fund screen
const TABS = ['Overview', 'LPs', 'Positions', 'Activity'];

export default function FundScreen() {
  const [overview,  setOverview]  = useState(null);
  const [lps,       setLps]       = useState([]);
  const [positions, setPositions] = useState([]);
  const [activity,  setActivity]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);
  const [error,     setError]     = useState(null);
  const [activeTab, setActiveTab] = useState('Overview');

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const [ov, lpData, posData, actData] = await Promise.all([
        api.fundOverview(),
        api.fundLps(),
        api.fundPositions(),
        api.fundActivity(),
      ]);
      setOverview(ov);
      setLps(Array.isArray(lpData) ? lpData : []);
      setPositions(Array.isArray(posData) ? posData : []);
      setActivity(Array.isArray(actData) ? actData : []);
    } catch (e) {
      setError(e.message || 'Failed to load fund data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(true); };

  // ── Render helpers ─────────────────────────────────────────────────────────
  function OverviewPanel() {
    if (!overview) return null;
    const gainColor = overview.total_gain >= 0 ? colors.gold : '#e05a4e';
    return (
      <View style={s.overviewWrap}>
        {/* Hero card */}
        <View style={s.heroCard}>
          <Text style={s.heroLabel}>CURRENT NAV</Text>
          <Text style={s.heroValue}>{fmt$(overview.nav)}</Text>
          <Text style={[s.heroGain, { color: gainColor }]}>
            {fmtPct(overview.gain_pct)} since inception ({overview.inception_date?.slice(0,4)})
          </Text>
        </View>

        {/* 3-stat row */}
        <View style={s.statRow}>
          <View style={s.statCard}>
            <Text style={s.statLabel}>CONTRIBUTIONS</Text>
            <Text style={s.statValue}>{fmt$(overview.contributions)}</Text>
            <Text style={s.statSub}>{overview.lp_count} LPs</Text>
          </View>
          <View style={s.statCard}>
            <Text style={s.statLabel}>TOTAL GAIN</Text>
            <Text style={[s.statValue, { color: gainColor }]}>{fmt$(overview.total_gain)}</Text>
            <Text style={s.statSub}>inception to date</Text>
          </View>
          <View style={s.statCard}>
            <Text style={s.statLabel}>POSITIONS</Text>
            <Text style={s.statValue}>{overview.position_count}</Text>
            <Text style={s.statSub}>securities</Text>
          </View>
        </View>

        {/* Economics */}
        <View style={s.econCard}>
          <Text style={s.econTitle}>FUND ECONOMICS</Text>
          <View style={s.econRow}>
            <EconPill label="Mgmt Fee"  value={`${(overview.mgmt_fee_pct * 100).toFixed(0)}%`} />
            <EconPill label="Carry"     value={`${(overview.carry_pct   * 100).toFixed(0)}%`} gold />
            <EconPill label="Hurdle"    value={`${(overview.hurdle_pct  * 100).toFixed(0)}%`} />
            {overview.catch_up_pct != null && (
              <EconPill label="Catch-up" value={`${(overview.catch_up_pct * 100).toFixed(0)}%`} />
            )}
          </View>
        </View>
      </View>
    );
  }

  function EconPill({ label, value, gold }) {
    return (
      <View style={[s.econPill, gold && s.econPillGold]}>
        <Text style={[s.econPillVal, gold && { color: colors.navy }]}>{value}</Text>
        <Text style={[s.econPillLbl, gold && { color: colors.navy + 'cc' }]}>{label}</Text>
      </View>
    );
  }

  function LPsPanel() {
    if (!lps.length) return <Text style={s.emptyText}>No LP records found.</Text>;
    return (
      <View style={s.tableWrap}>
        {/* Header row */}
        <View style={[s.tableRow, s.tableHeader]}>
          <Text style={[s.th, { flex: 2 }]}>LP</Text>
          <Text style={[s.th, s.thRight]}>Committed</Text>
          <Text style={[s.th, s.thRight]}>Gain</Text>
          <Text style={[s.th, s.thRight]}>Value</Text>
          <Text style={[s.th, s.thRight, { flex: 0.7 }]}>%</Text>
        </View>
        {lps.map((lp, i) => (
          <View key={lp.id} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
            <Text style={[s.td, { flex: 2 }]} numberOfLines={1}>{lp.legal_name}</Text>
            <Text style={[s.td, s.tdRight]}>{fmt$(lp.commitment)}</Text>
            <Text style={[s.td, s.tdRight, { color: colors.gold }]}>{fmt$(lp.gain)}</Text>
            <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lp.current_value)}</Text>
            <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.7 }]}>{lp.share_pct.toFixed(0)}%</Text>
          </View>
        ))}
        {/* Totals row */}
        <View style={[s.tableRow, s.totalsRow]}>
          <Text style={[s.td, s.tdBold, { flex: 2 }]}>Total</Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lps.reduce((a,l) => a + l.commitment, 0))}</Text>
          <Text style={[s.td, s.tdRight, { color: colors.gold, fontWeight: '700' }]}>
            {fmt$(lps.reduce((a,l) => a + l.gain, 0))}
          </Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lps.reduce((a,l) => a + l.current_value, 0))}</Text>
          <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.7 }]}>100%</Text>
        </View>
      </View>
    );
  }

  function PositionsPanel() {
    if (!positions.length) return <Text style={s.emptyText}>No open positions.</Text>;
    return (
      <View style={s.tableWrap}>
        <View style={[s.tableRow, s.tableHeader]}>
          <Text style={[s.th, { flex: 0.9 }]}>Symbol</Text>
          <Text style={[s.th, s.thRight]}>Qty</Text>
          <Text style={[s.th, s.thRight]}>Avg $</Text>
          <Text style={[s.th, s.thRight]}>Total Cost</Text>
          <Text style={[s.th, s.thRight, { flex: 0.7 }]}>Wt%</Text>
        </View>
        {positions.map((p, i) => (
          <View key={p.symbol + i} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
            <View style={[{ flex: 0.9 }, s.symbolCell]}>
              <Text style={s.symbolText}>{p.symbol}</Text>
              {p.lot_count > 1 && <Text style={s.lotBadge}>{p.lot_count}L</Text>}
            </View>
            <Text style={[s.td, s.tdRight]}>{Number(p.total_qty).toLocaleString()}</Text>
            <Text style={[s.td, s.tdRight]}>${Number(p.avg_cost).toFixed(2)}</Text>
            <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(p.total_cost)}</Text>
            <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.7 }]}>{p.weight_pct.toFixed(1)}%</Text>
          </View>
        ))}
      </View>
    );
  }

  function ActivityPanel() {
    if (!activity.length) return <Text style={s.emptyText}>No transactions.</Text>;
    return (
      <View style={s.activityWrap}>
        {activity.map((a) => (
          <View key={a.id} style={s.activityRow}>
            <View style={s.activityLeft}>
              <View style={[s.catPill, catPillStyle(a.category)]}>
                <Text style={[s.catPillText, catPillTextStyle(a.category)]}>
                  {fmtCat(a.category)}
                </Text>
              </View>
              <Text style={s.actDesc} numberOfLines={2}>{a.description}</Text>
            </View>
            <View style={s.activityRight}>
              <Text style={s.actAmount}>{fmt$(a.amount)}</Text>
              <Text style={s.actDate}>{a.effective_date}</Text>
            </View>
          </View>
        ))}
      </View>
    );
  }

  function catPillStyle(cat) {
    const map = {
      contribution: { backgroundColor: 'rgba(50,160,80,0.18)' },
      trade_buy:    { backgroundColor: 'rgba(80,120,201,0.18)' },
      trade_sell:   { backgroundColor: 'rgba(220,80,60,0.18)' },
      adjustment:   { backgroundColor: 'rgba(201,168,76,0.18)' },
      transfer:     { backgroundColor: 'rgba(140,80,201,0.18)' },
    };
    return map[cat] || { backgroundColor: 'rgba(255,255,255,0.07)' };
  }
  function catPillTextStyle(cat) {
    const map = {
      contribution: '#4cc870',
      trade_buy:    '#6090e8',
      trade_sell:   '#e06050',
      adjustment:   '#c9a84c',
      transfer:     '#b080e8',
    };
    return { color: map[cat] || '#8090a8' };
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <View style={s.screen}>
      <AppHeader title="Fund Admin" subtitle="DGA Capital Fund I, LP" />

      {/* Sub-tab bar */}
      <View style={s.subTabBar}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[s.subTab, activeTab === tab && s.subTabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[s.subTabText, activeTab === tab && s.subTabTextActive]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && !refreshing ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.gold} size="large" />
          <Text style={s.loadingText}>Loading fund data…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => load()}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
          showsVerticalScrollIndicator={false}
        >
          {activeTab === 'Overview'   && <OverviewPanel />}
          {activeTab === 'LPs'        && <LPsPanel />}
          {activeTab === 'Positions'  && <PositionsPanel />}
          {activeTab === 'Activity'   && <ActivityPanel />}
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: colors.navy },
  scroll:   { flex: 1 },
  scrollContent: { paddingBottom: 40 },

  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { color: colors.midGray, marginTop: 12, fontSize: 13 },
  errorText:   { color: '#e05a4e', textAlign: 'center', marginBottom: 16 },
  retryBtn:    { backgroundColor: 'rgba(201,168,76,0.15)', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8, borderWidth: 1, borderColor: colors.gold },
  retryText:   { color: colors.gold, fontWeight: '700', fontSize: 14 },
  emptyText:   { color: '#3a5070', padding: 24, fontSize: 13 },

  // Sub-tab bar
  subTabBar:   { flexDirection: 'row', backgroundColor: '#0a1628', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  subTab:      { flex: 1, paddingVertical: 10, alignItems: 'center' },
  subTabActive:{ borderBottomWidth: 2, borderBottomColor: colors.gold },
  subTabText:  { fontSize: 12, fontWeight: '600', color: '#4a6080', letterSpacing: 0.3 },
  subTabTextActive: { color: colors.gold },

  // Overview
  overviewWrap: { padding: 14 },
  heroCard:  {
    backgroundColor: '#0e1d38',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.3)',
    marginBottom: 10,
  },
  heroLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.2, color: colors.gold, marginBottom: 4 },
  heroValue: { fontSize: 32, fontWeight: '800', color: '#f0e8d0', letterSpacing: -1 },
  heroGain:  { fontSize: 12, marginTop: 4 },

  statRow:   { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard:  { flex: 1, backgroundColor: '#0e1d38', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: 'rgba(201,168,76,0.12)' },
  statLabel: { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, color: '#c9a84c', marginBottom: 3 },
  statValue: { fontSize: 15, fontWeight: '800', color: '#f0e8d0' },
  statSub:   { fontSize: 10, color: '#4a6080', marginTop: 2 },

  econCard:  { backgroundColor: '#0e1d38', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  econTitle: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#4a6080', marginBottom: 10 },
  econRow:   { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  econPill:  { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12, alignItems: 'center' },
  econPillGold: { backgroundColor: colors.gold },
  econPillVal:  { fontSize: 16, fontWeight: '800', color: '#f0e8d0' },
  econPillLbl:  { fontSize: 9, color: '#6080a0', marginTop: 1, fontWeight: '600' },

  // Tables
  tableWrap:   { padding: 14 },
  tableHeader: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)', paddingBottom: 6, marginBottom: 2 },
  tableRow:    { flexDirection: 'row', paddingVertical: 8, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  tableRowAlt: { backgroundColor: 'rgba(255,255,255,0.02)' },
  totalsRow:   { borderTopWidth: 1, borderTopColor: 'rgba(201,168,76,0.3)', marginTop: 2, paddingTop: 10 },

  th:     { flex: 1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: '#3a5070', textTransform: 'uppercase' },
  thRight:{ textAlign: 'right' },
  td:     { flex: 1, fontSize: 11, color: '#8090a8' },
  tdRight:{ textAlign: 'right' },
  tdBold: { color: '#d8d0c0', fontWeight: '700' },
  tdDim:  { color: '#4a6080' },

  symbolCell:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  symbolText:  { fontSize: 12, fontWeight: '700', color: colors.gold },
  lotBadge:    { fontSize: 8, backgroundColor: 'rgba(201,168,76,0.2)', color: colors.gold, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, fontWeight: '700' },

  // Activity
  activityWrap: { padding: 14 },
  activityRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  activityLeft: { flex: 1, marginRight: 12 },
  activityRight:{ alignItems: 'flex-end' },
  catPill:      { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginBottom: 4 },
  catPillText:  { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  actDesc:      { fontSize: 11, color: '#6080a0', lineHeight: 15 },
  actAmount:    { fontSize: 13, fontWeight: '700', color: '#d8d0c0' },
  actDate:      { fontSize: 10, color: '#3a5070', marginTop: 2 },
});
