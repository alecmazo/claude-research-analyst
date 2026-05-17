/**
 * WatchlistScreen — Live portfolio positions watchlist
 *
 * Apple Stocks / Yahoo Finance-style list:
 *   Left   → bold ticker, grey company name, weight %
 *   Center → current price
 *   Right  → colored pill with $ change (top) and % change (bottom)
 *
 * Data source: GET /api/v2/lp/me/positions via v2Fetch (works for both LP
 * and GP/admin — privileged users get all managed accounts).
 *
 * Auto-refreshes every 30 seconds. Pulls to refresh. Groups rows by
 * account_name if multiple accounts are present.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  SectionList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { v2Fetch } from '../api/client';
import { colors } from '../components/theme';

const AUTO_REFRESH_MS = 30_000;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Number(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAbs(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const sign = n >= 0 ? '+' : '−';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
}

function fmtTotal(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtWeight(v) {
  if (v == null || isNaN(v)) return '';
  return Number(v).toFixed(1) + '% of portfolio';
}

function fmtTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return '';
  }
}

// ── Row component ─────────────────────────────────────────────────────────────

function PositionRow({ item, onPress }) {
  const isUp = Number(item.day_change_abs) >= 0;
  const pillBg = isUp ? colors.green : colors.red;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => onPress(item)}
      activeOpacity={0.65}
    >
      {/* Left: ticker + name + weight */}
      <View style={styles.rowLeft}>
        <Text style={styles.ticker} numberOfLines={1}>{item.symbol}</Text>
        <Text style={styles.company} numberOfLines={1}>{item.name || ''}</Text>
        {item.market_weight_pct != null && (
          <Text style={styles.weight}>{fmtWeight(item.market_weight_pct)}</Text>
        )}
      </View>

      {/* Center: last price */}
      <View style={styles.rowCenter}>
        <Text style={styles.price}>{fmtPrice(item.last_price)}</Text>
      </View>

      {/* Right: change pill */}
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        <Text style={styles.pillText}>{fmtAbs(item.day_change_abs)}</Text>
        <Text style={styles.pillText}>{fmtPct(item.day_change_pct)}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function AccountHeader({ title }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{title}</Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function WatchlistScreen({ navigation, title = 'Portfolio' }) {
  const [positions, setPositions]       = useState([]);
  const [sections, setSections]         = useState([]);
  const [totalValue, setTotalValue]     = useState(null);
  const [dayChange, setDayChange]       = useState({ abs: null, pct: null });
  const [asOf, setAsOf]                 = useState(null);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [error, setError]               = useState(null);
  const timerRef                        = useRef(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchPositions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else if (!positions.length) setLoading(true);
    setError(null);

    try {
      const resp = await v2Fetch('/api/v2/lp/me/positions');
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(txt || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const pos  = data.positions || [];

      setPositions(pos);
      setTotalValue(data.total_market_value ?? null);
      setAsOf(data.as_of ?? null);

      // Aggregate day change from positions
      let totalAbs = 0;
      let totalPrev = 0;
      pos.forEach(p => {
        const qty = Number(p.total_qty) || 0;
        const absChange = Number(p.day_change_abs) || 0;
        totalAbs += absChange * qty;
        // previous value of this position = market_value - (day_change_abs * qty)
        const mv = Number(p.market_value) || 0;
        totalPrev += mv - absChange * qty;
      });
      const aggAbs = totalAbs;
      const aggPct = totalPrev !== 0 ? (totalAbs / totalPrev) * 100 : 0;
      setDayChange({ abs: aggAbs, pct: aggPct });

      // Group by account_name
      const accounts = {};
      pos.forEach(p => {
        const acct = p.account_name || 'My Account';
        if (!accounts[acct]) accounts[acct] = [];
        accounts[acct].push(p);
      });
      const built = Object.entries(accounts).map(([acct, data]) => ({
        title: acct,
        data,
      }));
      setSections(built);
    } catch (e) {
      setError(e.message || 'Failed to load positions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [positions.length]);

  // ── Auto-refresh every 30 seconds ────────────────────────────────────────

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => fetchPositions(false), AUTO_REFRESH_MS);
  }, [fetchPositions]);

  useFocusEffect(
    useCallback(() => {
      fetchPositions(false);
      startTimer();
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }, [fetchPositions, startTimer])
  );

  // ── Row press handler ─────────────────────────────────────────────────────

  const handleRowPress = useCallback((item) => {
    if (navigation) {
      // Navigate to research report if it exists
      try {
        navigation.navigate('Report', { ticker: item.symbol });
      } catch {
        // Report screen may not exist — silently ignore
      }
    }
  }, [navigation]);

  // ── Summary row values ────────────────────────────────────────────────────

  const dayIsUp   = (dayChange.abs ?? 0) >= 0;
  const dayColor  = dayIsUp ? colors.green : colors.red;
  const dayAbs    = dayChange.abs != null
    ? (dayIsUp ? '+' : '−') + '$' + Math.abs(dayChange.abs).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';
  const dayPctStr = dayChange.pct != null
    ? (dayIsUp ? '+' : '−') + Math.abs(dayChange.pct).toFixed(2) + '%'
    : '—';

  // ── Render states ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.loadingText}>Loading positions…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => fetchPositions(false)}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!positions.length) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>No Positions Found</Text>
        <Text style={styles.emptyBody}>
          Your portfolio positions will appear here once your account has holdings.
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => fetchPositions(true)}>
          <Text style={styles.retryText}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
        {asOf ? (
          <Text style={styles.headerTime}>Updated {fmtTime(asOf)}</Text>
        ) : null}
      </View>

      {/* ── Portfolio summary ── */}
      <View style={styles.summary}>
        <Text style={styles.totalValue}>{fmtTotal(totalValue)}</Text>
        <Text style={[styles.dayChange, { color: dayColor }]}>
          {dayAbs} · {dayPctStr}
        </Text>
      </View>

      {/* ── Separator ── */}
      <View style={styles.divider} />

      {/* ── Positions list ── */}
      <SectionList
        sections={sections}
        keyExtractor={(item, index) => `${item.symbol}-${index}`}
        renderItem={({ item }) => (
          <PositionRow item={item} onPress={handleRowPress} />
        )}
        renderSectionHeader={({ section }) =>
          sections.length > 1 ? <AccountHeader title={section.title} /> : null
        }
        ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
        SectionSeparatorComponent={() => <View style={styles.sectionSeparator} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchPositions(true)}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        stickySectionHeadersEnabled
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A1628',
    paddingTop: 56, // safe area offset — screens use headerShown: false
  },

  // ── Loading / error / empty states ──
  centered: {
    flex: 1,
    backgroundColor: '#0A1628',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 56,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 14,
    marginTop: 12,
  },
  errorText: {
    color: '#dc2626',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyBody: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: '#5BB8D4',
    borderRadius: 10,
    paddingHorizontal: 28,
    paddingVertical: 10,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },

  // ── Page header ──
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  headerTime: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '500',
  },

  // ── Summary row ──
  summary: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    paddingTop: 2,
  },
  totalValue: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1,
    marginBottom: 3,
  },
  dayChange: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },

  // ── Dividers ──
  divider: {
    height: 0.5,
    backgroundColor: '#1e2d45',
    marginHorizontal: 0,
  },
  rowSeparator: {
    height: 0.5,
    backgroundColor: '#1e2d45',
    marginLeft: 16,
  },
  sectionSeparator: {
    height: 0.5,
    backgroundColor: '#1e2d45',
  },

  // ── Section header ──
  sectionHeader: {
    backgroundColor: '#0d1c2e',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1e2d45',
  },
  sectionHeaderText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  // ── Position row ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 72,
    backgroundColor: '#0A1628',
  },
  rowLeft: {
    flex: 1,
    justifyContent: 'center',
    marginRight: 8,
  },
  ticker: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  company: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '400',
    marginBottom: 1,
  },
  weight: {
    color: '#4a6080',
    fontSize: 11,
    fontWeight: '400',
  },
  rowCenter: {
    alignItems: 'flex-end',
    marginRight: 10,
    minWidth: 70,
  },
  price: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 0.1,
  },

  // ── Change pill ──
  pill: {
    minWidth: 84,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'center',
  },

  listContent: {
    paddingBottom: 24,
  },
});
