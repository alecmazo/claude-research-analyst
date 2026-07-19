/**
 * WatchlistScreen — Live portfolio positions watchlist
 *
 * Apple Stocks / Yahoo Finance-style layout, grouped by account.
 * Each account section is collapsible — tap the header to toggle.
 *
 * Data source: GET /api/v2/lp/me/positions
 * Auto-refreshes every 30 seconds. Pull-to-refresh supported.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Modal,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { v2Fetch, getV2User, api } from '../api/client';
import { colors } from '../components/theme';
import StockInfoCard, { StockInfoScroll } from '../components/StockInfoCard';
import { useTheme } from '../design';

const VIEW_CONFIG_KEY = 'positions_view_config_v1';
const BLOTTER_CONFIG_KEY = 'positions_blotter_config_v1';

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

// Whole-dollar format with commas (used for market value / P&L amounts)
function fmt$(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return (n < 0 ? '−$' : '$')
    + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Signed 1-decimal percent for P/L (e.g. "+15.9%")
function fmtPlPct(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(decimals) + '%';
}

// ── Blotter row — dense one-liner: TICKER + weight | day % | value ──────────
// (Option A design, approved from mockups: professional tape, tap for sheet.)
function BlotterRow({ p, t, onPress }) {
  const day = p.day_change_pct != null ? Number(p.day_change_pct) : null;
  const dayColor = day == null ? t.textDim : (day >= 0 ? GREEN : RED);
  const mv = p.market_value != null
    ? fmt$(p.market_value)
    : (p.last_price != null && p.total_qty != null
        ? fmt$(Number(p.last_price) * Number(p.total_qty))
        : '—');
  return (
    <TouchableOpacity style={bl.row} onPress={() => onPress(p)} activeOpacity={0.6}>
      <View style={bl.rowLeft}>
        <Text style={[bl.rowTicker, { color: t.textPrimary }]} numberOfLines={1}>{p.symbol}</Text>
        {p._scope_weight_pct != null ? (
          <Text style={[bl.rowWeight, { color: t.textDim }]}>
            {Number(p._scope_weight_pct).toFixed(1)}% of book
          </Text>
        ) : null}
      </View>
      <Text style={[bl.rowDay, { color: dayColor }]}>
        {day != null ? fmtPct(day) : '—'}
      </Text>
      <Text style={[bl.rowValue, { color: t.textPrimary }]}>{mv}</Text>
    </TouchableOpacity>
  );
}

// ── Bottom-sheet detail for one position ─────────────────────────────────────
// Free stock-info card (same as desktop ticker expand) + position context.
// "View report" is optional and secondary — default content is NOT the report.
function PositionSheet({ p, t, onClose, onReport, onAnalyze }) {
  if (!p) return null;
  const gain = p.unrealized_gain != null ? Number(p.unrealized_gain) : null;
  const pct = p.unrealized_gain_pct != null
    ? Number(p.unrealized_gain_pct)
    : (gain != null && p.total_cost ? (gain / Number(p.total_cost)) * 100 : null);
  const plColor = (gain ?? pct ?? 0) >= 0 ? GREEN : RED;
  const plTxt = [
    gain != null ? (gain >= 0 ? '+' : '') + fmt$(gain) : null,
    pct != null ? fmtPlPct(pct, 1) : null,
  ].filter(Boolean).join(' · ');
  const qty = p.total_qty != null ? Number(p.total_qty) : null;
  const avgCost = (p.total_cost != null && qty)
    ? Number(p.total_cost) / qty : null;
  const dayAbs = (p.day_change_abs != null && qty != null)
    ? Number(p.day_change_abs) * qty : null;
  const name = p.name && String(p.name).trim().toUpperCase() !== String(p.symbol || '').toUpperCase()
    ? String(p.name).trim() : null;
  const posCtx = {
    qty,
    value: p.market_value != null ? Number(p.market_value) : null,
    weight: p._scope_weight_pct != null ? Number(p._scope_weight_pct)
      : (p._acct_weight_pct != null ? Number(p._acct_weight_pct) : null),
    avgCost,
    pl: gain,
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={bl.sheetBackdrop} activeOpacity={1} onPress={onClose} />
      <View style={[bl.sheet, bl.sheetTall, { backgroundColor: t.surface }]}>
        <View style={bl.sheetGrab} />
        <View style={bl.sheetHead}>
          <Text style={[bl.sheetTicker, { color: t.textPrimary }]} numberOfLines={1}>
            {p.symbol}{name ? '  ·  ' + name : ''}
          </Text>
          {plTxt ? <Text style={[bl.sheetPl, { color: plColor }]}>P/L {plTxt}</Text> : null}
        </View>
        {p._acct_title ? (
          <Text style={[bl.sheetMeta, { color: t.textSecondary }]}>{p._acct_title}</Text>
        ) : null}
        {dayAbs != null ? (
          <Text style={[bl.sheetDay, { color: dayAbs >= 0 ? GREEN : RED }]}>
            Today {fmtAbs(dayAbs)}{p.day_change_pct != null ? '  ·  ' + fmtPct(p.day_change_pct) : ''}
          </Text>
        ) : null}
        <StockInfoScroll style={{ flex: 1, marginTop: 8 }}>
          <StockInfoCard
            ticker={p.symbol}
            positionCtx={posCtx}
            onOpenReport={onReport ? () => onReport(p) : undefined}
            onRunAnalysis={onAnalyze ? () => onAnalyze(p) : undefined}
          />
        </StockInfoScroll>
        <TouchableOpacity
          style={[bl.sheetBtn, { borderColor: t.border, marginTop: 10 }]}
          onPress={onClose}
          activeOpacity={0.75}
        >
          <Text style={[bl.sheetBtnTxt, { color: t.textSecondary }]}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function WatchlistScreen({ navigation }) {
  // ── Theme ─────────────────────────────────────────────────────────────────
  const { theme: t } = useTheme();
  const ts = useMemo(() => makeThemedStyles(t), [t]);

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
  const [orderedKeys,  setOrderedKeys]  = useState([]);   // account chip order
  const [openMap,      setOpenMap]      = useState({});   // retained for config compat
  // ── Blotter controls (persisted via BLOTTER_CONFIG_KEY) ───────────────────
  const [acctFilter,   setAcctFilter]   = useState('all'); // 'all' | group key
  const [sortBy,       setSortBy]       = useState('value'); // value|day|pl|az
  const [sheetItem,    setSheetItem]    = useState(null);  // bottom-sheet position

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

  // ── Blotter filter/sort persistence ───────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(BLOTTER_CONFIG_KEY).then(raw => {
      if (!raw) return;
      try {
        const c = JSON.parse(raw);
        if (c.sortBy) setSortBy(c.sortBy);
        if (c.acctFilter) setAcctFilter(c.acctFilter);
      } catch {}
    }).catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(BLOTTER_CONFIG_KEY,
      JSON.stringify({ acctFilter, sortBy })).catch(() => {});
  }, [acctFilter, sortBy]);

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

  const handleOpenReport = useCallback((item) => {
    try {
      navigation?.navigate('Research', {
        screen: 'Report',
        params: { ticker: item.symbol },
      });
    } catch {
      try { navigation?.navigate('Report', { ticker: item.symbol }); } catch {}
    }
  }, [navigation]);

  const handleRunAnalysis = useCallback((item) => {
    const tk = item?.symbol;
    if (!tk) return;
    Alert.alert(
      'Run AI analysis?',
      `${tk} full equity report costs tokens (Grok). This is deliberate — not automatic.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run',
          onPress: async () => {
            try {
              const job = await api.startAnalysis(tk, false, 'grok');
              try {
                navigation?.navigate('Research', {
                  screen: 'Analysis',
                  params: { jobId: job.job_id, ticker: tk },
                });
              } catch {
                navigation?.navigate('Analysis', { jobId: job.job_id, ticker: tk });
              }
            } catch (e) {
              Alert.alert('Analysis failed', e.message || String(e));
            }
          },
        },
      ],
    );
  }, [navigation]);

  // ── Blotter scope: filter → weight → sort ─────────────────────────────────
  const scopeGroups = acctFilter === 'all'
    ? groups : groups.filter(g => g.key === acctFilter);
  const scopeRows = useMemo(() => {
    const rows = [];
    scopeGroups.forEach(g => g.positions.forEach(p =>
      rows.push({ ...p, _acct_title: g.title })));
    const total = rows.reduce((a, p) => a + (Number(p.market_value) || 0), 0);
    rows.forEach(p => {
      p._scope_weight_pct = total > 0 && p.market_value != null
        ? (Number(p.market_value) / total) * 100 : null;
    });
    const day = p => (p.day_change_pct != null ? Number(p.day_change_pct) : -Infinity);
    const pl  = p => (p.unrealized_gain_pct != null ? Number(p.unrealized_gain_pct) : -Infinity);
    const mv  = p => (Number(p.market_value) || 0);
    if (sortBy === 'day')      rows.sort((a, b) => day(b) - day(a));
    else if (sortBy === 'pl')  rows.sort((a, b) => pl(b) - pl(a));
    else if (sortBy === 'az')  rows.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    else                       rows.sort((a, b) => mv(b) - mv(a));
    return rows;
  }, [scopeGroups, sortBy]);
  const scopeValue = scopeRows.reduce((a, p) => a + (Number(p.market_value) || 0), 0);
  let scopeDayAbs = 0, scopeDayPrev = 0;
  scopeRows.forEach(p => {
    const q = Number(p.total_qty) || 0, c = Number(p.day_change_abs) || 0;
    scopeDayAbs  += c * q;
    scopeDayPrev += (Number(p.market_value) || 0) - c * q;
  });
  const scopeDayPct = scopeDayPrev ? (scopeDayAbs / scopeDayPrev) * 100 : null;

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
      <View style={[styles.centered, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={BLUE} size="large" />
        <Text style={[styles.loadingText, { color: t.textSecondary }]}>Loading positions…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: t.bg }]}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => fetchPositions(false)}>
          <Text style={styles.retryTxt}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!groups.length) {
    return (
      <View style={[styles.centered, { backgroundColor: t.bg }]}>
        <Text style={[styles.emptyTitle, { color: t.textPrimary }]}>No Positions Found</Text>
        <Text style={[styles.emptyBody, { color: t.textSecondary }]}>Your holdings will appear here once positions are imported.</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => fetchPositions(true)}>
          <Text style={styles.retryTxt}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }


  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: t.bg }]}
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

      {/* ── Account filter chips ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={bl.chipBar}>
        {[{ key: 'all', title: 'All' }, ...groups].map(g => {
          const active = acctFilter === g.key;
          return (
            <TouchableOpacity
              key={g.key}
              style={[bl.chip, active ? bl.chipActive : bl.chipIdle]}
              onPress={() => setAcctFilter(g.key)}
              activeOpacity={0.75}
            >
              <Text style={active ? bl.chipTxtActive : bl.chipTxtIdle} numberOfLines={1}>
                {g.title}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* ── Scope strip (filtered account) ── */}
      {acctFilter !== 'all' && (
        <View style={[bl.scopeStrip, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[bl.scopeTxt, { color: t.textSecondary }]} numberOfLines={1}>
            {(scopeGroups[0] && scopeGroups[0].title) || ''} · {fmt$(scopeValue)}
          </Text>
          {scopeDayPct != null ? (
            <Text style={[bl.scopeDay, { color: scopeDayAbs >= 0 ? GREEN : RED }]}>
              {fmtAbs(scopeDayAbs)} · {fmtPct(scopeDayPct)} today
            </Text>
          ) : null}
        </View>
      )}

      {/* ── Sort chips ── */}
      <View style={bl.sortBar}>
        {[['value', 'Value ↓'], ['day', 'Day %'], ['pl', 'P/L %'], ['az', 'A–Z']].map(([k, label]) => {
          const active = sortBy === k;
          return (
            <TouchableOpacity
              key={k}
              style={[bl.sortChip,
                      { borderColor: active ? BLUE : t.border },
                      active && { backgroundColor: 'rgba(91,184,212,0.10)' }]}
              onPress={() => setSortBy(k)}
              activeOpacity={0.75}
            >
              <Text style={[bl.sortChipTxt, { color: active ? (t.isDark ? '#84CCE3' : '#3E9AB8') : t.textDim }]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Blotter ── */}
      <View style={[bl.list, { backgroundColor: t.surface, borderColor: t.border }]}>
        {scopeRows.map((p, idx) => (
          <View key={`${p.symbol}-${p._acct_title || ''}-${idx}`}>
            {idx > 0 && <View style={[bl.sep, { backgroundColor: t.border }]} />}
            <BlotterRow p={p} t={t} onPress={setSheetItem} />
          </View>
        ))}
      </View>

      {/* ── Bottom-sheet detail ── */}
      {sheetItem ? (
        <PositionSheet
          p={sheetItem}
          t={t}
          onClose={() => setSheetItem(null)}
          onReport={(pp) => { setSheetItem(null); handleOpenReport(pp); }}
          onAnalyze={(pp) => { setSheetItem(null); handleRunAnalysis(pp); }}
        />
      ) : null}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

// ── Blotter styles ────────────────────────────────────────────────────────────
const bl = StyleSheet.create({
  chipBar: { marginBottom: 8, flexGrow: 0 },
  chip: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6 },
  chipActive: { backgroundColor: BLUE },
  chipIdle:   { backgroundColor: NAVY3 },
  chipTxtActive: { color: NAVY, fontSize: 11, fontWeight: '800', maxWidth: 160 },
  chipTxtIdle:   { color: '#84CCE3', fontSize: 11, fontWeight: '600', maxWidth: 160 },

  scopeStrip: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, paddingVertical: 7, marginBottom: 8,
  },
  scopeTxt: { fontSize: 11, fontWeight: '700', flexShrink: 1, marginRight: 8 },
  scopeDay: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },

  sortBar: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  sortChip: {
    borderWidth: 1, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 4,
  },
  sortChipTxt: { fontSize: 10.5, fontWeight: '700' },

  list: {
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12, minHeight: 46,
  },
  rowLeft: { flex: 1, minWidth: 0, paddingRight: 8 },
  rowTicker: { fontSize: 13.5, fontWeight: '800', letterSpacing: 0.3 },
  rowWeight: { fontSize: 9, marginTop: 1 },
  rowDay: {
    width: 66, textAlign: 'right', fontSize: 12, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rowValue: {
    width: 88, textAlign: 'right', fontSize: 12.5, fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 2, borderTopColor: BLUE,
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 30,
  },
  sheetTall: {
    height: '82%',
  },
  sheetGrab: {
    width: 34, height: 4, borderRadius: 2, backgroundColor: 'rgba(128,140,155,0.45)',
    alignSelf: 'center', marginBottom: 10,
  },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' },
  sheetTicker: { fontSize: 15, fontWeight: '800', flexShrink: 1, marginRight: 8 },
  sheetPl: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  sheetMeta: { fontSize: 11.5, marginTop: 7 },
  sheetDay: { fontSize: 11.5, fontWeight: '700', marginTop: 5, fontVariant: ['tabular-nums'] },
  sheetBtns: { flexDirection: 'row', gap: 8, marginTop: 16 },
  sheetBtnPrimary: {
    borderWidth: 1.5, borderColor: BLUE, borderRadius: 9,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  sheetBtnPrimaryTxt: { color: '#3E9AB8', fontSize: 12.5, fontWeight: '800' },
  sheetBtn: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 8 },
  sheetBtnTxt: { fontSize: 12.5, fontWeight: '700' },
});

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
  // (card container + rows are themed — see makeThemedStyles below)
  cardHdr: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    gap: 8,
  },
  cardHdrLeft: {
    flex: 1,
    justifyContent: 'center',
    gap: 3,
  },
  cardName: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  stakeBadge: {
    alignSelf: 'flex-start',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  cardNav: {
    fontSize: 13,
    fontWeight: '700',
  },
  cardChg: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardChevron: {
    fontSize: 12,
  },
});

// ── Themed styles — brokerage-style ticker rows (light/dark via useTheme) ────

const makeThemedStyles = (t) => StyleSheet.create({
  // Account card container (flat list inside — no per-row boxes)
  card: {
    backgroundColor: t.surface,
    borderRadius: 13,
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: t.border,
  },
  cardHdr:      { borderBottomColor: t.borderSubtle },
  cardName:     { color: t.textSecondary },
  cardNav:      { color: t.textPrimary },
  cardChevron:  { color: t.textDim },
  stakeBadge:   { color: t.primary },
  reorderArrow: { color: t.primary },
});

// ── Themed position-row styles (ui377 value/P&L-first design) ────────────────
