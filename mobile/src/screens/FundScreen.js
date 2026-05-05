/**
 * FundScreen — DGA Capital Fund I dashboard
 *
 * Auth flow:
 *   1. On focus: check AsyncStorage for @dga_fund_token
 *   2. If absent → show lock screen (password entry)
 *   3. On correct password → call /api/fund/auth → store fund token → load data
 *   4. If any fund endpoint returns 403 → clear token, show lock screen again
 *
 * Sub-tabs: Overview | LPs | Positions | Activity | Waterfall
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TextInput,
  StyleSheet, ActivityIndicator, TouchableOpacity, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import AppHeader from '../components/AppHeader';
import { colors } from '../components/theme';
import { api, getFundToken, setFundToken, clearFundToken } from '../api/client';

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

const TABS = ['Overview', 'LPs', 'Positions', 'Activity', 'Waterfall'];

export default function FundScreen() {
  const [locked,     setLocked]    = useState(true);   // start locked; check token on focus
  const [password,   setPassword]  = useState('');
  const [authError,  setAuthError] = useState(false);
  const [authBusy,   setAuthBusy]  = useState(false);

  const [overview,   setOverview]  = useState(null);
  const [lps,        setLps]       = useState([]);
  const [positions,  setPositions] = useState([]);
  const [activity,   setActivity]  = useState([]);
  const [waterfall,  setWaterfall] = useState(null);

  const [loading,    setLoading]   = useState(false);
  const [refreshing, setRefreshing]= useState(false);
  const [error,      setError]     = useState(null);
  const [activeTab,  setActiveTab] = useState('Overview');

  const pwRef = useRef(null);

  // ── Auth ────────────────────────────────────────────────────────────────────
  const checkLock = useCallback(async () => {
    const token = await getFundToken();
    if (token) {
      setLocked(false);
      load();
    } else {
      setLocked(true);
    }
  }, []); // eslint-disable-line

  useFocusEffect(useCallback(() => { checkLock(); }, [checkLock]));

  const submitPassword = async () => {
    if (!password.trim()) return;
    setAuthBusy(true);
    setAuthError(false);
    try {
      const { fund_token } = await api.fundAuth(password.trim());
      await setFundToken(fund_token);
      setPassword('');
      setLocked(false);
      load();
    } catch {
      setAuthError(true);
      setPassword('');
    } finally {
      setAuthBusy(false);
    }
  };

  // ── Data loading ─────────────────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const [ov, lpData, posData, actData, wfall] = await Promise.all([
        api.fundOverview(),
        api.fundLps(),
        api.fundPositions(),
        api.fundActivity(),
        api.fundWaterfall(),
      ]);
      setOverview(ov);
      setLps(Array.isArray(lpData) ? lpData : []);
      setPositions(Array.isArray(posData) ? posData : []);
      setActivity(Array.isArray(actData) ? actData : []);
      setWaterfall(wfall);
    } catch (e) {
      if (e.message?.includes('403')) {
        // Fund token revoked — clear and re-lock
        await clearFundToken();
        setLocked(true);
        return;
      }
      setError(e.message || 'Failed to load fund data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const onRefresh = () => { setRefreshing(true); load(true); };

  // ── Lock screen ─────────────────────────────────────────────────────────────
  if (locked) {
    return (
      <View style={s.screen}>
        <AppHeader title="Fund Admin" subtitle="DGA Capital Fund I, LP" />
        <KeyboardAvoidingView
          style={s.lockOuter}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={s.lockCard}>
            <Text style={s.lockIcon}>🔒</Text>
            <Text style={s.lockTitle}>Fund Access</Text>
            <Text style={s.lockHint}>Enter the fund password to continue.</Text>
            <TextInput
              ref={pwRef}
              style={[s.lockInput, authError && s.lockInputError]}
              value={password}
              onChangeText={setPassword}
              placeholder="Fund password"
              placeholderTextColor="#3a5070"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submitPassword}
              returnKeyType="go"
            />
            {authError && <Text style={s.lockErrText}>Incorrect password</Text>}
            <TouchableOpacity
              style={[s.lockBtn, authBusy && { opacity: 0.6 }]}
              onPress={submitPassword}
              disabled={authBusy}
            >
              <Text style={s.lockBtnText}>{authBusy ? 'Checking…' : 'Unlock'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── Panel components ────────────────────────────────────────────────────────
  function OverviewPanel() {
    if (!overview) return null;
    const gainColor = overview.total_gain >= 0 ? colors.gold : '#e05a4e';
    return (
      <View style={s.overviewWrap}>
        <View style={s.heroCard}>
          <Text style={s.heroLabel}>CURRENT NAV</Text>
          <Text style={s.heroValue}>{fmt$(overview.nav)}</Text>
          <Text style={[s.heroGain, { color: gainColor }]}>
            {fmtPct(overview.gain_pct)} since inception ({overview.inception_date?.slice(0,4)})
          </Text>
        </View>
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
        <View style={s.econCard}>
          <Text style={s.econTitle}>FUND ECONOMICS</Text>
          <View style={s.econRow}>
            <EconPill label="Mgmt Fee" value={`${(overview.mgmt_fee_pct * 100).toFixed(0)}%`} />
            <EconPill label="Carry"    value={`${(overview.carry_pct   * 100).toFixed(0)}%`} gold />
            <EconPill label="Hurdle"   value={`${(overview.hurdle_pct  * 100).toFixed(0)}%`} />
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
    const lpOnlys = lps.filter(l => l.commitment > 0);
    return (
      <View style={s.tableWrap}>
        <View style={[s.tableRow, s.tableHeader]}>
          <Text style={[s.th, { flex: 1.4 }]}>LP</Text>
          <Text style={[s.th, s.thRight]}>Committed</Text>
          <Text style={[s.th, s.thRight]}>Gain</Text>
          <Text style={[s.th, s.thRight]}>Value</Text>
          <Text style={[s.th, s.thRight, { flex: 0.6 }]}>%</Text>
        </View>
        {lpOnlys.map((lp, i) => (
          <View key={lp.id} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
            <Text style={[s.td, { flex: 1.4 }]} numberOfLines={1}>{lp.legal_name}</Text>
            <Text style={[s.td, s.tdRight]}>{fmt$(lp.commitment)}</Text>
            <Text style={[s.td, s.tdRight, { color: colors.gold }]}>{fmt$(lp.gain)}</Text>
            <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lp.current_value)}</Text>
            <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.6 }]}>{lp.share_pct.toFixed(0)}%</Text>
          </View>
        ))}
        <View style={[s.tableRow, s.totalsRow]}>
          <Text style={[s.td, s.tdBold, { flex: 1.4 }]}>Total</Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lpOnlys.reduce((a,l) => a + l.commitment, 0))}</Text>
          <Text style={[s.td, s.tdRight, { color: colors.gold, fontWeight: '700' }]}>
            {fmt$(lpOnlys.reduce((a,l) => a + l.gain, 0))}
          </Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lpOnlys.reduce((a,l) => a + l.current_value, 0))}</Text>
          <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.6 }]}>100%</Text>
        </View>
      </View>
    );
  }

  function PositionsPanel() {
    if (!positions.length) return <Text style={s.emptyText}>No open positions.</Text>;
    return (
      <View style={s.tableWrap}>
        <View style={[s.tableRow, s.tableHeader]}>
          <Text style={[s.th, { flex: 1 }]}>Symbol</Text>
          <Text style={[s.th, s.thRight]}>Qty</Text>
          <Text style={[s.th, s.thRight]}>Avg $</Text>
          <Text style={[s.th, s.thRight]}>Cost</Text>
          <Text style={[s.th, s.thRight, { flex: 0.6 }]}>Wt%</Text>
        </View>
        {positions.map((p, i) => (
          <View key={p.symbol + i} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
            <View style={[{ flex: 1 }, s.symbolCell]}>
              <Text style={s.symbolText}>{p.symbol}</Text>
              {p.lot_count > 1 && <Text style={s.lotBadge}>{p.lot_count}L</Text>}
            </View>
            <Text style={[s.td, s.tdRight]}>{Number(p.total_qty).toLocaleString()}</Text>
            <Text style={[s.td, s.tdRight]}>${Number(p.avg_cost).toFixed(2)}</Text>
            <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(p.total_cost)}</Text>
            <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.6 }]}>{p.weight_pct.toFixed(1)}%</Text>
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

  function WaterfallPanel() {
    if (!waterfall) return <Text style={s.emptyText}>No waterfall data.</Text>;
    const w = waterfall;
    const hurdlePct = (w.hurdle_pct * 100).toFixed(0);
    const carryPct  = (w.carry_pct  * 100).toFixed(0);
    return (
      <View style={s.wfallWrap}>
        {/* Summary block */}
        <View style={s.wfallCard}>
          <WRow label="Structure"
            value={`${hurdlePct}% hurdle · ${carryPct}% carry · 100% catch-up`} />
          <WRow label="Years since inception"
            value={`${w.years_since_inception} yrs`} />
          <WRow label={`Preferred return (${hurdlePct}% compound)`}
            value={fmt$(w.preferred_return)} />
          <WRow label="Total gain"
            value={fmt$(w.total_gain)} />
          <WRow label="Hurdle status"
            value={w.hurdle_cleared ? '✓ Cleared' : '⏳ Not yet met'}
            valueColor={w.hurdle_cleared ? '#60d060' : '#e0a030'} />
          <WRow label="Carry pool (above hurdle)"
            value={fmt$(w.carry_pool)} />
          <WRow label={`GP accrued carry (${carryPct}%)`}
            value={fmt$(w.gp_accrued_carry)}
            valueColor="#e8a060"
            highlight />
          <WRow label="LP net value (after carry)"
            value={fmt$(w.lp_nav_after_carry)}
            valueColor={colors.gold}
            highlight
            last />
        </View>

        {/* Per-LP breakdown */}
        <Text style={s.wfallSubhead}>PER-LP BREAKDOWN</Text>
        <View style={s.tableWrap}>
          <View style={[s.tableRow, s.tableHeader]}>
            <Text style={[s.th, { flex: 0.8 }]}>LP</Text>
            <Text style={[s.th, s.thRight]}>Pref. Ret.</Text>
            <Text style={[s.th, s.thRight]}>Carry −</Text>
            <Text style={[s.th, s.thRight]}>Net Value</Text>
          </View>
          {(w.per_lp || []).map((lp, i) => (
            <View key={lp.legal_name} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
              <Text style={[s.td, { flex: 0.8 }]}>{lp.legal_name}</Text>
              <Text style={[s.td, s.tdRight]}>{fmt$(lp.preferred_return)}</Text>
              <Text style={[s.td, s.tdRight, { color: '#e06050' }]}>−{fmt$(lp.carry_charge)}</Text>
              <Text style={[s.td, s.tdRight, s.tdBold, { color: colors.gold }]}>{fmt$(lp.nav_after_carry)}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  function WRow({ label, value, valueColor, highlight, last }) {
    return (
      <View style={[s.wRow, highlight && s.wRowHighlight, last && s.wRowLast]}>
        <Text style={s.wLabel}>{label}</Text>
        <Text style={[s.wValue, valueColor && { color: valueColor }]}>{value}</Text>
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
      contribution: '#4cc870', trade_buy: '#6090e8',
      trade_sell: '#e06050',   adjustment: '#c9a84c', transfer: '#b080e8',
    };
    return { color: map[cat] || '#8090a8' };
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <View style={s.screen}>
      <AppHeader title="Fund Admin" subtitle="DGA Capital Fund I, LP" />

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
          {activeTab === 'Overview'  && <OverviewPanel />}
          {activeTab === 'LPs'       && <LPsPanel />}
          {activeTab === 'Positions' && <PositionsPanel />}
          {activeTab === 'Activity'  && <ActivityPanel />}
          {activeTab === 'Waterfall' && <WaterfallPanel />}
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
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

  // Lock screen
  lockOuter:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  lockCard:      { backgroundColor: '#0d1f38', borderRadius: 16, padding: 32, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)' },
  lockIcon:      { fontSize: 36, marginBottom: 12 },
  lockTitle:     { fontSize: 18, fontWeight: '800', color: '#f0e8d0', marginBottom: 6 },
  lockHint:      { fontSize: 12, color: '#4a6080', marginBottom: 20, textAlign: 'center' },
  lockInput:     { width: '100%', backgroundColor: '#081526', borderWidth: 1, borderColor: '#1e3a5a', borderRadius: 8, color: '#f0e8d0', fontSize: 15, padding: 12, marginBottom: 8 },
  lockInputError:{ borderColor: '#e05a5a' },
  lockErrText:   { color: '#e05a5a', fontSize: 12, marginBottom: 8 },
  lockBtn:       { width: '100%', backgroundColor: colors.gold, borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  lockBtnText:   { color: colors.navy, fontWeight: '800', fontSize: 15, letterSpacing: 0.4 },

  // Sub-tab bar
  subTabBar:        { flexDirection: 'row', backgroundColor: '#0a1628', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  subTab:           { flex: 1, paddingVertical: 10, alignItems: 'center' },
  subTabActive:     { borderBottomWidth: 2, borderBottomColor: colors.gold },
  subTabText:       { fontSize: 11, fontWeight: '600', color: '#4a6080', letterSpacing: 0.2 },
  subTabTextActive: { color: colors.gold },

  // Overview
  overviewWrap: { padding: 14 },
  heroCard:  { backgroundColor: '#0e1d38', borderRadius: 12, padding: 18, borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)', marginBottom: 10 },
  heroLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.2, color: colors.gold, marginBottom: 4 },
  heroValue: { fontSize: 32, fontWeight: '800', color: '#f0e8d0', letterSpacing: -1 },
  heroGain:  { fontSize: 12, marginTop: 4 },

  statRow:   { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard:  { flex: 1, backgroundColor: '#0e1d38', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: 'rgba(201,168,76,0.12)' },
  statLabel: { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, color: '#c9a84c', marginBottom: 3 },
  statValue: { fontSize: 15, fontWeight: '800', color: '#f0e8d0' },
  statSub:   { fontSize: 10, color: '#4a6080', marginTop: 2 },

  econCard:     { backgroundColor: '#0e1d38', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  econTitle:    { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#4a6080', marginBottom: 10 },
  econRow:      { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  econPill:     { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12, alignItems: 'center' },
  econPillGold: { backgroundColor: colors.gold },
  econPillVal:  { fontSize: 16, fontWeight: '800', color: '#f0e8d0' },
  econPillLbl:  { fontSize: 9, color: '#6080a0', marginTop: 1, fontWeight: '600' },

  // Tables
  tableWrap:   { padding: 14 },
  tableHeader: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)', paddingBottom: 6, marginBottom: 2 },
  tableRow:    { flexDirection: 'row', paddingVertical: 8, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  tableRowAlt: { backgroundColor: 'rgba(255,255,255,0.02)' },
  totalsRow:   { borderTopWidth: 1, borderTopColor: 'rgba(201,168,76,0.3)', marginTop: 2, paddingTop: 10 },

  th:      { flex: 1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: '#3a5070', textTransform: 'uppercase' },
  thRight: { textAlign: 'right' },
  td:      { flex: 1, fontSize: 11, color: '#8090a8' },
  tdRight: { textAlign: 'right' },
  tdBold:  { color: '#d8d0c0', fontWeight: '700' },
  tdDim:   { color: '#4a6080' },

  symbolCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  symbolText: { fontSize: 12, fontWeight: '700', color: colors.gold },
  lotBadge:   { fontSize: 8, backgroundColor: 'rgba(201,168,76,0.2)', color: colors.gold, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, fontWeight: '700' },

  // Activity
  activityWrap:  { padding: 14 },
  activityRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  activityLeft:  { flex: 1, marginRight: 12 },
  activityRight: { alignItems: 'flex-end' },
  catPill:       { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginBottom: 4 },
  catPillText:   { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  actDesc:       { fontSize: 11, color: '#6080a0', lineHeight: 15 },
  actAmount:     { fontSize: 13, fontWeight: '700', color: '#d8d0c0' },
  actDate:       { fontSize: 10, color: '#3a5070', marginTop: 2 },

  // Waterfall
  wfallWrap:    { padding: 14 },
  wfallCard:    { backgroundColor: '#0a1628', borderWidth: 1, borderColor: '#1e3a5a', borderRadius: 10, marginBottom: 16, overflow: 'hidden' },
  wRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#0f2240' },
  wRowHighlight:{ backgroundColor: 'rgba(201,168,76,0.06)' },
  wRowLast:     { borderBottomWidth: 0 },
  wLabel:       { fontSize: 11, color: '#4a6080', flex: 1, marginRight: 8 },
  wValue:       { fontSize: 13, fontWeight: '700', color: '#c0cfe0' },
  wfallSubhead: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#3a5070', marginBottom: 4, paddingHorizontal: 14 },
});
