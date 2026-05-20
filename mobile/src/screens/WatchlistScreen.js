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
  Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { v2Fetch, getV2User } from '../api/client';
import { colors } from '../components/theme';

const VIEW_CONFIG_KEY = 'positions_view_config_v1';

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
  // Always display in US Pacific time to match the web dashboard
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' PT';
}

// Full dollar format — never abbreviates (used for gain/loss amounts)
function fmtUSDFull(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  // Use full dollar format (not abbreviated) for gains to match web ui84 behaviour
  const gainTxt = item.unrealized_gain != null
    ? (item.unrealized_gain >= 0 ? '+' : '') + fmtUSDFull(item.unrealized_gain)
      + (item.unrealized_gain_pct != null
          ? ' (' + (item.unrealized_gain_pct >= 0 ? '+' : '') + item.unrealized_gain_pct.toFixed(1) + '%)'
          : '')
    : null;

  // _acct_weight_pct is computed per-account in fetchPositions; fallback to global field
  const wt = (item._acct_weight_pct ?? item.market_weight_pct) != null
    ? (item._acct_weight_pct ?? item.market_weight_pct).toFixed(1) + '% of acct'
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

function AccountSection({
  title, positions, navSum, daySum, dayValid, onPressRow,
  sourceType, stakePct,
  // view-config props
  open, onToggle,
  editMode, onMoveUp, onMoveDown, canMoveUp, canMoveDown,
}) {
  const isFund    = sourceType === 'lp_fund';
  const chgColor  = dayValid ? (daySum >= 0 ? '#4ade80' : '#f87171') : GREY;
  const chgTxt    = dayValid ? (daySum >= 0 ? '+' : '') + fmtUSDFull(daySum) : null;
  const showStake = isFund && stakePct != null && stakePct < 99.99;

  return (
    <View style={styles.card}>
      {/* Header — tap to collapse, or reorder in edit mode */}
      <TouchableOpacity
        style={styles.cardHdr}
        onPress={onToggle}
        activeOpacity={0.75}
      >
        {/* Drag handle (edit mode only) */}
        {editMode && (
          <View style={styles.reorderHandle}>
            <TouchableOpacity
              onPress={onMoveUp}
              disabled={!canMoveUp}
              hitSlop={{ top: 8, bottom: 4, left: 8, right: 8 }}
              style={[styles.reorderBtn, !canMoveUp && { opacity: 0.25 }]}
            >
              <Text style={styles.reorderArrow}>▲</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onMoveDown}
              disabled={!canMoveDown}
              hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
              style={[styles.reorderBtn, !canMoveDown && { opacity: 0.25 }]}
            >
              <Text style={styles.reorderArrow}>▼</Text>
            </TouchableOpacity>
          </View>
        )}

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
  // ── Data ──────────────────────────────────────────────────────────────────
  const [groupMap,     setGroupMap]     = useState({});   // key → group data
  const [totalValue,   setTotalValue]   = useState(null);
  const [fundStakes,   setFundStakes]   = useState(null);
  const [managedNav,   setManagedNav]   = useState(null);
  const [dayChange,    setDayChange]    = useState({ abs: null, pct: null });
  const [updatedAt,    setUpdatedAt]    = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState(null);

  // ── View config (persisted) ───────────────────────────────────────────────
  const [orderedKeys,  setOrderedKeys]  = useState([]);   // display order
  const [openMap,      setOpenMap]      = useState({});   // key → bool
  const [editMode,     setEditMode]     = useState(false);
  const [saveFlash,    setSaveFlash]    = useState(false);// brief "Saved!" feedback

  // ── Impersonation ─────────────────────────────────────────────────────────
  const [impersonated, setImpersonated] = useState(false);
  const [impName,      setImpName]      = useState('');
  const timerRef                        = useRef(null);

  // Computed ordered group list
  const groups = orderedKeys.map(k => groupMap[k]).filter(Boolean);

  // Check if this is an admin impersonation session
  useEffect(() => {
    getV2User().then(u => {
      if (u?.impersonated) {
        setImpersonated(true);
        setImpName(u.name || u.email || 'LP');
      }
    }).catch(() => {});
  }, []);

  // ── Load saved view config from AsyncStorage ──────────────────────────────
  const loadViewConfig = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(VIEW_CONFIG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  const saveViewConfig = useCallback(async (keys, opens) => {
    try {
      await AsyncStorage.setItem(VIEW_CONFIG_KEY, JSON.stringify({
        orderedKeys: keys,
        openMap:     opens,
      }));
    } catch {}
  }, []);

  // ── Save View button handler ──────────────────────────────────────────────
  const handleSaveView = useCallback(async () => {
    await saveViewConfig(orderedKeys, openMap);
    setEditMode(false);
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 2000);
  }, [orderedKeys, openMap, saveViewConfig]);

  // ── Reorder: move a key up or down ───────────────────────────────────────
  const moveGroup = useCallback((idx, dir) => {
    setOrderedKeys(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  // ── Toggle open/closed ────────────────────────────────────────────────────
  const toggleOpen = useCallback((key) => {
    setOpenMap(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchPositions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else if (!orderedKeys.length) setLoading(true);
    setError(null);

    try {
      const [resp, savedConfig] = await Promise.all([
        v2Fetch('/api/v2/lp/me/positions'),
        loadViewConfig(),
      ]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const pos  = (data.positions || []).sort((a, b) =>
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

      // Build group map keyed by fund_id / account_name
      const map = {};
      const defaultOrder = [];
      pos.forEach(p => {
        const key = p.fund_id || p.account_name || 'My Account';
        if (!map[key]) {
          map[key] = {
            key,
            title:      p.account_name || 'My Account',
            sourceType: p.source_type  || 'managed_account',
            stakePct:   p.stake_pct    ?? 100,
            positions:  [],
            navSum:     0,
            daySum:     0,
            dayValid:   false,
          };
          defaultOrder.push(key);
        }
        map[key].positions.push(p);
        if (p.market_value)   map[key].navSum += p.market_value;
        if (p.day_change_abs != null && p.total_qty != null) {
          map[key].daySum  += p.day_change_abs * p.total_qty;
          map[key].dayValid = true;
        }
      });

      // Apply saved order: saved keys first (if still present), new keys appended
      const savedKeys = savedConfig?.orderedKeys || [];
      const knownKeys = new Set(Object.keys(map));
      const ordered = [
        ...savedKeys.filter(k => knownKeys.has(k)),
        ...defaultOrder.filter(k => !savedKeys.includes(k)),
      ];

      // Apply saved open/close state; default = open for any unsaved key
      const savedOpen = savedConfig?.openMap || {};
      const opens = {};
      ordered.forEach(k => {
        opens[k] = k in savedOpen ? savedOpen[k] : true;
      });

      // Recompute each position's weight relative to its own account (not global AUM)
      Object.values(map).forEach(grp => {
        const groupTotal = grp.navSum;
        grp.positions = grp.positions.map(p => ({
          ...p,
          _acct_weight_pct: groupTotal > 0 && p.market_value != null
            ? (p.market_value / groupTotal) * 100
            : null,
        }));
      });

      // Compute breakdown totals
      let fundTotal = 0, acctTotal = 0;
      Object.values(map).forEach(grp => {
        if (grp.sourceType === 'lp_fund') fundTotal += grp.navSum;
        else                              acctTotal += grp.navSum;
      });
      setFundStakes(fundTotal > 0 ? fundTotal : null);
      setManagedNav(acctTotal > 0 ? acctTotal : null);
      setGroupMap(map);
      setOrderedKeys(ordered);
      setOpenMap(prev => ({ ...opens, ...prev })); // keep any in-session toggles

    } catch (e) {
      setError(e.message || 'Failed to load positions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadViewConfig, orderedKeys.length]);

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
    ? (dayUp ? '+' : '−') + '$' + Math.abs(dayChange.abs).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

  const hasMultipleGroups = groups.length > 1;

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

      {/* ── View config toolbar ── */}
      {groups.length > 0 && (
        <View style={styles.toolbar}>
          {editMode ? (
            <>
              <Text style={styles.toolbarHint}>↑↓ to reorder · tap headers to collapse</Text>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSaveView} activeOpacity={0.75}>
                <Text style={styles.saveBtnText}>💾  Save View</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {saveFlash
                ? <Text style={styles.savedFlash}>✓ View saved</Text>
                : <Text style={styles.toolbarHint}>Tap sections to expand · hold to reorder</Text>
              }
              <TouchableOpacity
                style={styles.editBtn}
                onPress={() => setEditMode(true)}
                activeOpacity={0.75}
              >
                <Text style={styles.editBtnText}>Edit Layout</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* ── Per-account collapsible cards ── */}
      {groups.map((grp, i) => (
        <AccountSection
          key={grp.key}
          title={grp.title}
          positions={grp.positions}
          navSum={grp.navSum}
          daySum={grp.daySum}
          dayValid={grp.dayValid}
          onPressRow={handleRowPress}
          sourceType={grp.sourceType}
          stakePct={grp.stakePct}
          open={openMap[grp.key] !== false}
          onToggle={() => toggleOpen(grp.key)}
          editMode={editMode}
          onMoveUp={() => moveGroup(i, -1)}
          onMoveDown={() => moveGroup(i, 1)}
          canMoveUp={i > 0}
          canMoveDown={i < groups.length - 1}
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

  // ── View config toolbar ──
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 6,
    gap: 8,
  },
  toolbarHint: {
    flex: 1,
    fontSize: 10,
    color: 'rgba(255,255,255,0.28)',
    letterSpacing: 0.2,
  },
  savedFlash: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: '#4ade80',
    letterSpacing: 0.3,
  },
  editBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(91,184,212,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(91,184,212,0.30)',
  },
  editBtnText: {
    color: BLUE,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  saveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: BLUE,
  },
  saveBtnText: {
    color: '#0A1628',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },

  // ── Reorder handles (edit mode) ──
  reorderHandle: {
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
    gap: 0,
  },
  reorderBtn: {
    padding: 2,
  },
  reorderArrow: {
    color: BLUE,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 13,
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
