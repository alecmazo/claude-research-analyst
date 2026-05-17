/**
 * WatchlistScreen — Live portfolio positions watchlist
 *
 * Apple Stocks / Yahoo Finance-style layout, grouped by account.
 * Each account section is collapsible — tap the header to toggle.
 *
 * Data source: GET /api/v2/lp/me/positions
 * Auto-refreshes every 30 seconds. Pull-to-refresh supported.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { v2Fetch, getV2User } from '../api/client';
import { colors } from '../components/theme';

const AUTO_REFRESH_MS = 30_000;
const NAVY     = '#0A1628';
const NAVY2    = '#0d1c2e';
const NAVY3    = '#132040';
const BLUE     = '#5BB8D4';
const GREEN    = '#16A34A';
const RED      = '#DC2626';
const GREY     = 'rgba(255,255,255,0.38)';
const GREY_DIM = 'rgba(255,255,255,0.22)';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUSD(v, compact = false) {
  if (v == null || isNaN(v)) return '—';
  const n = Math.abs(Number(v));
  let s;
  if (compact && n >= 1e6) s = '$' + (n / 1e6).toFixed(2) + 'M';
  else if (compact && n >= 1e3) s = '$' + (n / 1e3).toFixed(0) + 'K';
  else s = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return Number(v) < 0 ? '−' + s : s;
}

function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Number(v).toFixed(2);
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return '';
  const n = Number(v);
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
}

function fmtAbs(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return (n >= 0 ? '+$' : '−$') + Math.abs(n).toFixed(2);
}

function fmtTime() {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ item, onPress }) {
  const pct    = item.day_change_pct;
  const abs    = item.day_change_abs;
  const isUp   = pct != null ? pct >= 0 : true;
  const pillBg = pct == null ? 'rgba(255,255,255,0.08)' : isUp ? GREEN : RED;

  const absStr = abs != null ? fmtAbs(abs) : (pct != null ? fmtPct(pct) : '—');
  const pctStr = fmtPct(pct);

  const gainColor = item.unrealized_gain != null
    ? (item.unrealized_gain >= 0 ? '#4ade80' : '#f87171')
    : GREY_DIM;
  const gainTxt = item.unrealized_gain != null
    ? (item.unrealized_gain >= 0 ? '+' : '') + fmtUSD(item.unrealized_gain, true)
      + (item.unrealized_gain_pct != null
          ? ' (' + (item.unrealized_gain_pct >= 0 ? '+' : '') + item.unrealized_gain_pct.toFixed(1) + '%)'
          : '')
    : null;

  const wt = item.market_weight_pct != null
    ? item.market_weight_pct.toFixed(1) + '% of acct'
    : null;

  return (
    <TouchableOpacity style={styles.row} onPress={() => onPress(item)} activeOpacity={0.6}>
      {/* Left: ticker + name + weight */}
      <View style={styles.rowLeft}>
        <Text style={styles.ticker} numberOfLines={1}>{item.symbol}</Text>
        <Text style={styles.company} numberOfLines={1}>{item.name || ''}</Text>
        {wt ? <Text style={styles.weight}>{wt}</Text> : null}
      </View>

      {/* Center: price + unrealized */}
      <View style={styles.rowCenter}>
        <Text style={styles.price}>{fmtPrice(item.last_price)}</Text>
        {gainTxt ? (
          <Text style={[styles.gain, { color: gainColor }]} numberOfLines={1}>{gainTxt}</Text>
        ) : null}
      </View>

      {/* Right: pill */}
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        <Text style={styles.pillAbs}>{absStr}</Text>
        {pctStr ? <Text style={styles.pillPct}>{pctStr}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

// ── Collapsible account / fund section ───────────────────────────────────────

function AccountSection({ title, positions, navSum, daySum, dayValid, onPressRow, defaultOpen = true, sourceType, stakePct }) {
  const [open, setOpen] = useState(defaultOpen);

  const isFund    = sourceType === 'lp_fund';
  const chgColor  = dayValid ? (daySum >= 0 ? '#4ade80' : '#f87171') : GREY;
  const chgTxt    = dayValid ? (daySum >= 0 ? '+' : '') + fmtUSD(daySum, true) : null;
  // Show stake badge only for LP fund sections where stake < 100%
  const showStake = isFund && stakePct != null && stakePct < 99.99;

  return (
    <View style={styles.card}>
      {/* Header — tap to collapse */}
      <TouchableOpacity
        style={styles.cardHdr}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.75}
      >
        <View style={styles.cardHdrLeft}>
          <Text style={styles.cardName} numberOfLines={1}>{title}</Text>
          {showStake && (
            <Text style={styles.stakeBadge}>{stakePct.toFixed(2)}% STAKE</Text>
          )}
        </View>
        <Text style={styles.cardNav}>{fmtUSD(navSum, true)}</Text>
        {chgTxt ? (
          <Text style={[styles.cardChg, { color: chgColor }]}>{chgTxt}</Text>
        ) : null}
        <Text style={[styles.cardChevron, { transform: [{ rotate: open ? '0deg' : '-90deg' }] }]}>
          ▾
        </Text>
      </TouchableOpacity>

      {/* Collapsible body */}
      {open && positions.map((item, idx) => (
        <View key={`${item.symbol}-${idx}`}>
          {idx > 0 && <View style={styles.rowSep} />}
          <PositionRow item={item} onPress={onPressRow} />
        </View>
      ))}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function WatchlistScreen({ navigation }) {
  const [groups,       setGroups]       = useState([]);
  const [totalValue,   setTotalValue]   = useState(null);
  const [fundStakes,   setFundStakes]   = useState(null);
  const [managedNav,   setManagedNav]   = useState(null);
  const [dayChange,    setDayChange]    = useState({ abs: null, pct: null });
  const [updatedAt,    setUpdatedAt]    = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState(null);
  const [impersonated, setImpersonated] = useState(false);
  const [impName,      setImpName]      = useState('');
  const timerRef                        = useRef(null);

  // Check if this is an admin impersonation session
  useEffect(() => {
    getV2User().then(u => {
      if (u?.impersonated) {
        setImpersonated(true);
        setImpName(u.name || u.email || 'LP');
      }
    }).catch(() => {});
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchPositions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else if (!groups.length) setLoading(true);
    setError(null);

    try {
      const resp = await v2Fetch('/api/v2/lp/me/positions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data  = await resp.json();
      const pos   = (data.positions || []).sort((a, b) =>
        (b.market_weight_pct || 0) - (a.market_weight_pct || 0)
      );

      setTotalValue(data.total_market_value ?? null);
      setUpdatedAt(fmtTime());

      // Aggregate day change
      let totalAbs = 0, totalPrev = 0;
      pos.forEach(p => {
        const qty = Number(p.total_qty) || 0;
        const chg = Number(p.day_change_abs) || 0;
        const mv  = Number(p.market_value)   || 0;
        totalAbs  += chg * qty;
        totalPrev += mv - chg * qty;
      });
      setDayChange({ abs: totalAbs, pct: totalPrev ? (totalAbs / totalPrev) * 100 : 0 });

      // Group by fund_id (unique per account/fund) — fall back to account_name
      const map = {}, order = [];
      pos.forEach(p => {
        const key = p.fund_id || p.account_name || 'My Account';
        if (!map[key]) {
          map[key] = {
            title:      p.account_name || 'My Account',
            sourceType: p.source_type  || 'managed_account',
            stakePct:   p.stake_pct    ?? 100,
            positions:  [],
            navSum:     0,
            daySum:     0,
            dayValid:   false,
          };
          order.push(key);
        }
        map[key].positions.push(p);
        if (p.market_value)   map[key].navSum += p.market_value;
        if (p.day_change_abs != null && p.total_qty != null) {
          map[key].daySum  += p.day_change_abs * p.total_qty;
          map[key].dayValid = true;
        }
      });

      // Compute fund stakes vs managed account NAV breakdown
      const built = order.map(key => map[key]);
      let fundTotal = 0, acctTotal = 0;
      built.forEach(grp => {
        if (grp.sourceType === 'lp_fund') fundTotal += grp.navSum;
        else                              acctTotal += grp.navSum;
      });
      setFundStakes(fundTotal > 0 ? fundTotal : null);
      setManagedNav(acctTotal > 0 ? acctTotal : null);
      setGroups(built);

    } catch (e) {
      setError(e.message || 'Failed to load positions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [groups.length]);

  // ── Auto-refresh ──────────────────────────────────────────────────────────

  useFocusEffect(
    useCallback(() => {
      fetchPositions(false);
      timerRef.current = setInterval(() => fetchPositions(false), AUTO_REFRESH_MS);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [fetchPositions])
  );

  // ── Row press ─────────────────────────────────────────────────────────────

  const handleRowPress = useCallback((item) => {
    try { navigation?.navigate('Report', { ticker: item.symbol }); } catch {}
  }, [navigation]);

  // ── Summary values ────────────────────────────────────────────────────────

  const dayUp     = (dayChange.abs ?? 0) >= 0;
  const dayColor  = dayUp ? '#4ade80' : '#f87171';
  const dayAbsTxt = dayChange.abs != null
    ? (dayUp ? '+' : '−') + '$' + Math.abs(dayChange.abs).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : null;
  const dayPctTxt = dayChange.pct != null
    ? (dayUp ? '+' : '−') + Math.abs(dayChange.pct).toFixed(2) + '%'
    : null;

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={BLUE} size="large" />
        <Text style={styles.loadingText}>Loading positions…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => fetchPositions(false)}>
          <Text style={styles.retryTxt}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!groups.length) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>No Positions Found</Text>
        <Text style={styles.emptyBody}>Your holdings will appear here once positions are imported.</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => fetchPositions(true)}>
          <Text style={styles.retryTxt}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => fetchPositions(true)}
          tintColor={BLUE}
          colors={[BLUE]}
        />
      }
    >
      {/* ── Admin impersonation banner ── */}
      {impersonated && (
        <View style={styles.impBanner}>
          <Text style={styles.impBannerText}>
            👁  Admin preview — viewing as {impName}
          </Text>
        </View>
      )}

      {/* ── Global summary ── */}
      <View style={styles.summaryCard}>
        {/* Label + timestamp row */}
        <View style={styles.summaryTopRow}>
          <Text style={styles.summaryEyebrow}>YOUR TOTAL PORTFOLIO</Text>
          <View style={styles.summaryRight}>
            <Text style={styles.liveLabel}>LIVE PRICES</Text>
            {updatedAt ? <Text style={styles.updatedAt}>{updatedAt}</Text> : null}
          </View>
        </View>

        {/* Big total */}
        <Text style={styles.totalValue}>
          {totalValue != null ? fmtUSD(totalValue) : '—'}
        </Text>
        {dayAbsTxt && (
          <Text style={[styles.dayChange, { color: dayColor }]}>
            {dayAbsTxt}{dayPctTxt ? '  ·  ' + dayPctTxt : ''}
          </Text>
        )}

        {/* Breakdown tiles — only when we have both/either */}
        {(fundStakes != null || managedNav != null) && (
          <>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryTiles}>
              {fundStakes != null && (
                <View style={styles.summaryTile}>
                  <Text style={styles.tileLabel}>FUND STAKES</Text>
                  <Text style={styles.tileValue}>{fmtUSD(fundStakes)}</Text>
                </View>
              )}
              {fundStakes != null && managedNav != null && (
                <View style={styles.tileSep} />
              )}
              {managedNav != null && (
                <View style={styles.summaryTile}>
                  <Text style={styles.tileLabel}>MANAGED ACCT NAV</Text>
                  <Text style={styles.tileValue}>{fmtUSD(managedNav)}</Text>
                </View>
              )}
            </View>
          </>
        )}
      </View>

      {/* ── Per-account collapsible cards ── */}
      {groups.map((grp, i) => (
        <AccountSection
          key={grp.title + i}
          title={grp.title}
          positions={grp.positions}
          navSum={grp.navSum}
          daySum={grp.daySum}
          dayValid={grp.dayValid}
          onPressRow={handleRowPress}
          defaultOpen={true}
          sourceType={grp.sourceType}
          stakePct={grp.stakePct}
        />
      ))}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1320',
  },
  scrollContent: {
    paddingTop: 56,
    paddingHorizontal: 12,
    paddingBottom: 24,
  },

  centered: {
    flex: 1,
    backgroundColor: NAVY,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 56,
  },
  loadingText: { color: '#94a3b8', fontSize: 14, marginTop: 12 },
  errorText:   { color: RED, fontSize: 15, textAlign: 'center', marginBottom: 20 },
  emptyTitle:  { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyBody:   { color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  retryBtn:    { backgroundColor: BLUE, borderRadius: 10, paddingHorizontal: 28, paddingVertical: 10 },
  retryTxt:    { color: '#fff', fontSize: 15, fontWeight: '700' },

  // ── Impersonation banner ──
  impBanner: {
    backgroundColor: '#78350f',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  impBannerText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.2,
  },

  // ── Summary card ──
  summaryCard: {
    backgroundColor: NAVY,
    borderRadius: 14,
    padding: 18,
    marginBottom: 10,
  },
  summaryTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  summaryEyebrow: {
    fontSize: 9,
    fontWeight: '800',
    color: BLUE,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  totalValue: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 3,
  },
  dayChange: {
    fontSize: 14,
    fontWeight: '600',
  },
  summaryRight: { alignItems: 'flex-end' },
  liveLabel:   { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', marginBottom: 2 },
  updatedAt:   { fontSize: 11, color: 'rgba(255,255,255,0.28)' },

  // Breakdown tiles
  summaryDivider: {
    height: 1,
    backgroundColor: 'rgba(91,184,212,0.18)',
    marginTop: 14,
    marginBottom: 14,
  },
  summaryTiles: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  summaryTile: {
    flex: 1,
  },
  tileSep: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: 'rgba(91,184,212,0.18)',
    marginHorizontal: 16,
  },
  tileLabel: {
    fontSize: 8,
    fontWeight: '800',
    color: BLUE,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  tileValue: {
    fontSize: 19,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.3,
  },

  // ── Account card ──
  card: {
    backgroundColor: NAVY,
    borderRadius: 13,
    overflow: 'hidden',
    marginBottom: 10,
  },
  cardHdr: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.07)',
    gap: 8,
  },
  cardHdrLeft: {
    flex: 1,
    justifyContent: 'center',
    gap: 3,
  },
  cardName: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  stakeBadge: {
    alignSelf: 'flex-start',
    fontSize: 9,
    fontWeight: '800',
    color: BLUE,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  cardNav: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  cardChg: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardChevron: {
    color: 'rgba(255,255,255,0.30)',
    fontSize: 12,
  },

  // ── Position row ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: NAVY,
    gap: 10,
  },
  rowSep: {
    height: 0.5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginLeft: 16,
  },
  rowLeft: {
    flex: 1,
    justifyContent: 'center',
  },
  ticker:  { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3, marginBottom: 1 },
  company: { color: GREY, fontSize: 11, fontWeight: '400', marginBottom: 1 },
  weight:  { color: GREY_DIM, fontSize: 10 },

  rowCenter: {
    alignItems: 'flex-end',
    minWidth: 72,
    marginRight: 2,
  },
  price: { color: '#fff', fontSize: 14, fontWeight: '600' },
  gain:  { fontSize: 10, fontWeight: '600', marginTop: 1 },

  // ── Pill ──
  pill: {
    minWidth: 84,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillAbs: { color: '#fff', fontSize: 12, fontWeight: '800', lineHeight: 16, textAlign: 'center' },
  pillPct: { color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '700', lineHeight: 14, textAlign: 'center' },
});
