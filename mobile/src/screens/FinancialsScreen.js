/**
 * FinancialsScreen — mobile port of the desktop SEC-XBRL company dashboard.
 *
 * Pure-DB on the server (GET /api/financials/{ticker}/dashboard + price-history)
 * so it costs ~nothing on Railway — zero LLM, zero live pulls. Charts are drawn
 * with plain Views (rotated segments) so the whole screen ships via OTA with no
 * native dependency (react-native-svg is intentionally NOT used).
 *
 * Sections: ticker search · identity + price · interactive price chart (range
 * pills) · DGA Score · key metrics · the three ranking cards (Financial
 * Strength / Profitability / DGA Value).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  RefreshControl, StyleSheet, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AppHeader from '../components/AppHeader';
import { api } from '../api/client';
import { colors, spacing, radius, shadow, fontSize } from '../design';

const LAST_KEY = '@dga_fin_last';
const RANGES = ['1M', '3M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'All'];

// ── tiny helpers ──────────────────────────────────────────────────────────────
const fmtRank = (fmt, v) => {
  if (v == null) return '—';
  if (fmt === 'pct')     return v.toFixed(2) + '%';
  if (fmt === 'int')     return String(Math.round(v));
  if (fmt === 'score10') return Math.round(v) + '/10';
  if (fmt === 'spread')  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  return v.toFixed(2);
};
const gradeColor = (v) =>
  v == null ? colors.dim : v >= 80 ? colors.green : v >= 60 ? '#65a30d'
    : v >= 40 ? colors.amber : colors.red;
const rankColor = (r) =>
  r == null ? colors.dim : r >= 7 ? colors.green : r >= 4 ? colors.amber : colors.red;
const fmtCap = (n) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6)  return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n).toLocaleString();
};
const fmtPrice = (p) => p == null ? '—' : '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── pure-View line chart (no SVG) ───────────────────────────────────────────────
function MiniLine({ points, width, height, color }) {
  const ys = (points || []).map((p) => p.c).filter((v) => v != null);
  if (ys.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.dim, fontSize: fontSize.small }}>No price history.</Text>
      </View>
    );
  }
  // Downsample to keep the View count (and memory) bounded on long ranges.
  let pts = ys;
  if (ys.length > 90) {
    const step = ys.length / 90;
    pts = Array.from({ length: 90 }, (_, i) => ys[Math.min(ys.length - 1, Math.floor(i * step))]);
  }
  const n = pts.length;
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
  lo -= pad; hi += pad;
  const xOf = (i) => (i / (n - 1)) * width;
  const yOf = (v) => height - ((v - lo) / (hi - lo)) * height;
  const segs = [];
  for (let i = 1; i < n; i++) {
    const x1 = xOf(i - 1), y1 = yOf(pts[i - 1]), x2 = xOf(i), y2 = yOf(pts[i]);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    segs.push({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, len, angle });
  }
  return (
    <View style={{ width, height }}>
      {segs.map((s, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: s.cx - s.len / 2,
            top: s.cy - 1,
            width: s.len,
            height: 2,
            backgroundColor: color,
            transform: [{ rotate: s.angle + 'deg' }],
          }}
        />
      ))}
    </View>
  );
}

// ── horizontal mini-bar (rating / vs-history / score component) ────────────────
function Bar({ pct, color, track = '#f1f5f9' }) {
  return (
    <View style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: track, overflow: 'hidden' }}>
      {pct != null && (
        <View style={{ height: '100%', width: Math.max(4, Math.min(100, pct)) + '%', backgroundColor: color, borderRadius: 4 }} />
      )}
    </View>
  );
}

// ── one ranking card (Financial Strength / Profitability / DGA Value) ──────────
function RankCard({ card }) {
  if (!card || !(card.metrics || []).length) return null;
  const rc = rankColor(card.rank);
  return (
    <View style={s.card}>
      <View style={s.rankHead}>
        <Text style={s.cardTitle}>{card.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 56 }}>
            <Bar pct={card.rank == null ? null : card.rank * 10} color={rc} />
          </View>
          <Text style={[s.rankNum, { color: rc }]}>
            {card.rank == null ? '—' : card.rank}
            <Text style={s.rankDen}>/10</Text>
          </Text>
        </View>
      </View>
      {card.metrics.map((m, i) => (
        <View key={i} style={[s.rankRow, i === card.metrics.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={s.rankName} numberOfLines={1}>{m.name}</Text>
          <Text style={s.rankVal}>{fmtRank(m.fmt, m.value)}</Text>
          <View style={s.rankBar}><Bar pct={m.quality == null ? null : Math.max(8, m.quality * 100)} color={m.rating} /></View>
          <View style={s.rankBar}><Bar pct={m.hist_pct} color={m.hist_color || colors.dim} /></View>
        </View>
      ))}
    </View>
  );
}

// ── screen ──────────────────────────────────────────────────────────────────────
export default function FinancialsScreen() {
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [ticker, setTicker] = useState(null);
  const [data, setData] = useState(null);
  const [hist, setHist] = useState(null);
  const [range, setRange] = useState('YTD');
  const [loading, setLoading] = useState(false);
  const [histLoading, setHistLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chartW, setChartW] = useState(300);
  const reqId = useRef(0);

  const loadHistory = useCallback(async (tk, rng) => {
    if (!tk) return;
    setHistLoading(true);
    try {
      const h = await api.getFinancialsPriceHistory(tk, rng);
      setHist(h && h.ok ? h : null);
    } catch (e) {
      setHist(null);
    } finally {
      setHistLoading(false);
    }
  }, []);

  const loadTicker = useCallback(async (tk, rng) => {
    const sym = (tk || '').trim().toUpperCase();
    if (!sym) return;
    Keyboard.dismiss();
    const myReq = ++reqId.current;
    setLoading(true); setError(null); setTicker(sym);
    try {
      const d = await api.getFinancialsDashboard(sym);
      if (myReq !== reqId.current) return;
      if (!d || !d.ok) {
        setData(null);
        setError(d?.error || `No financials stored for ${sym}.`);
      } else {
        setData(d);
        AsyncStorage.setItem(LAST_KEY, sym).catch(() => {});
      }
    } catch (e) {
      if (myReq === reqId.current) { setData(null); setError(String(e.message || e)); }
    } finally {
      if (myReq === reqId.current) setLoading(false);
    }
    loadHistory(sym, rng || range);
  }, [range, loadHistory]);

  // Restore last viewed company so the tab isn't blank on each visit.
  useEffect(() => {
    (async () => {
      const last = await AsyncStorage.getItem(LAST_KEY);
      if (last) { setInput(last); loadTicker(last, 'YTD'); }
    })();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const onRange = (rng) => { setRange(rng); loadHistory(ticker, rng); };

  const km = data?.key_metrics || {};
  const sc = data?.dga_score || {};
  const comps = sc.components || {};
  const rc = data?.rank_cards || {};
  const stats = hist?.stats || {};
  const lineColor = (stats.change_pct != null && stats.change_pct < 0) ? colors.red : colors.green;

  const compRow = (label, v) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginVertical: 3 }}>
      <Text style={{ width: 84, fontSize: fontSize.caption, color: colors.midGray }}>{label}</Text>
      <Bar pct={v} color={gradeColor(v)} />
      <Text style={{ width: 26, textAlign: 'right', fontSize: fontSize.caption, fontWeight: '700', color: gradeColor(v) }}>
        {v == null ? '—' : v}
      </Text>
    </View>
  );
  const kmCell = (label, val) => (
    <View style={s.kmCell}>
      <Text style={s.kmLabel}>{label}</Text>
      <Text style={s.kmVal}>{val}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.offWhite }}>
      <AppHeader title="Financials" showLogo />

      {/* Search bar */}
      <View style={s.searchWrap}>
        <TextInput
          style={s.search}
          placeholder="Search a ticker…"
          placeholderTextColor={colors.dim}
          autoCapitalize="characters"
          autoCorrect={false}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => loadTicker(input)}
          returnKeyType="search"
        />
        <TouchableOpacity style={s.goBtn} onPress={() => loadTicker(input)} activeOpacity={0.8}>
          <Text style={s.goTxt}>View</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 28 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => ticker && loadTicker(ticker)} tintColor={colors.primary} />
        }
      >
        {!ticker && !loading && (
          <Text style={s.hint}>Search a ticker to see its SEC fundamentals, DGA Score, and ranking cards.</Text>
        )}

        {loading && (
          <View style={{ paddingTop: 40, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {!loading && error && (
          <View style={s.card}>
            <Text style={{ fontSize: fontSize.bodyLg, fontWeight: '700', color: colors.darkGray }}>{ticker}</Text>
            <Text style={{ marginTop: 6, fontSize: fontSize.body, color: colors.midGray, lineHeight: 19 }}>{error}</Text>
            <Text style={{ marginTop: 8, fontSize: fontSize.small, color: colors.dim }}>
              Sync this company from the Financials tab on the desktop terminal first.
            </Text>
          </View>
        )}

        {!loading && data && (
          <>
            {/* Identity + price */}
            <View style={s.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={s.entity} numberOfLines={1}>{data.entity_name}</Text>
                  <Text style={s.symbol}>{data.ticker}</Text>
                </View>
                {!!data.rating && (
                  <View style={s.ratingPill}><Text style={s.ratingTxt}>{String(data.rating).toUpperCase()}</Text></View>
                )}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                <Text style={s.price}>{fmtPrice(data.price)}</Text>
                {stats.change_pct != null && (
                  <Text style={{ fontSize: fontSize.bodyLg, fontWeight: '700', color: lineColor }}>
                    {(stats.change_pct >= 0 ? '+' : '') + stats.change_pct.toFixed(2)}% · {range}
                  </Text>
                )}
              </View>
              <View style={s.kmGrid}>
                {kmCell('P/E', km.pe != null ? km.pe.toFixed(2) : '—')}
                {kmCell('Mkt Cap', fmtCap(km.market_cap))}
                {kmCell('P/B', km.pb != null ? km.pb.toFixed(2) : '—')}
                {kmCell('Enterprise V', fmtCap(km.enterprise_value))}
              </View>
            </View>

            {/* Price chart */}
            <View style={s.card} onLayout={(e) => setChartW(Math.round(e.nativeEvent.layout.width - spacing.lg * 2))}>
              {histLoading
                ? <View style={{ height: 120, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>
                : <MiniLine points={hist?.points} width={chartW} height={120} color={lineColor} />}
              <View style={s.rangeRow}>
                {RANGES.map((r) => {
                  const on = r === range;
                  return (
                    <TouchableOpacity key={r} onPress={() => onRange(r)} activeOpacity={0.8}
                      style={[s.rangePill, on && { backgroundColor: colors.primary }]}>
                      <Text style={[s.rangeTxt, on && { color: colors.white }]}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* DGA Score */}
            <View style={s.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Text style={s.sectionLabel}>DGA SCORE</Text>
                <Text style={{ fontSize: fontSize.hero, fontWeight: '800', color: gradeColor(sc.total) }}>
                  {sc.total == null ? '—' : sc.total}<Text style={{ fontSize: fontSize.small, color: colors.dim, fontWeight: '600' }}> /100</Text>
                </Text>
              </View>
              <View style={{ marginTop: 8 }}>
                {compRow('Profitability', comps.profitability)}
                {compRow('Growth', comps.growth)}
                {compRow('Fin. Strength', comps.financial_strength)}
                {compRow('Predictability', comps.predictability)}
                {compRow('Value', comps.value)}
              </View>
              {!!data.dga_value && (
                <View style={s.dgaValueRow}>
                  <Text style={{ fontSize: fontSize.caption, color: colors.midGray }}>DGA Value</Text>
                  <Text style={{ fontSize: fontSize.bodyLg, fontWeight: '800', color: colors.darkGray }}>{fmtPrice(data.dga_value)}</Text>
                  {!!data.verdict && <Text style={s.verdict}>{data.verdict}</Text>}
                </View>
              )}
            </View>

            {/* Ranking cards */}
            <RankCard card={rc.financial_strength} />
            <RankCard card={rc.profitability} />
            <RankCard card={rc.value} />

            <Text style={s.footnote}>
              SEC XBRL store · Rating = absolute quality · Vs History = percentile in this company’s own history · zero LLM tokens
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg,
    paddingTop: spacing.md, paddingBottom: spacing.sm, backgroundColor: colors.offWhite,
  },
  search: {
    flex: 1, height: 40, backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.lightGray, paddingHorizontal: spacing.lg,
    fontSize: fontSize.bodyLg, color: colors.darkGray, letterSpacing: 1,
  },
  goBtn: {
    height: 40, paddingHorizontal: spacing.xl, borderRadius: radius.lg,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  goTxt: { color: colors.white, fontWeight: '800', fontSize: fontSize.bodyLg },
  hint: { color: colors.midGray, fontSize: fontSize.body, lineHeight: 20, paddingTop: 20, textAlign: 'center' },

  card: {
    backgroundColor: colors.white, borderRadius: radius.xl, padding: spacing.lg,
    borderWidth: 1, borderColor: colors.lightGray, marginBottom: spacing.md, ...shadow.card,
  },
  entity: { fontSize: fontSize.lg, fontWeight: '800', color: colors.navy },
  symbol: { fontSize: fontSize.caption, color: colors.dim, marginTop: 1, letterSpacing: 1 },
  ratingPill: { backgroundColor: '#dcfce7', borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 3 },
  ratingTxt: { color: '#166534', fontSize: fontSize.micro, fontWeight: '800', letterSpacing: 0.5 },
  price: { fontSize: 26, fontWeight: '800', color: colors.navy },

  kmGrid: {
    flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: '#eef2f7',
  },
  kmCell: { width: '50%', flexDirection: 'row', justifyContent: 'space-between', paddingRight: spacing.lg, paddingVertical: 3 },
  kmLabel: { fontSize: fontSize.caption, color: colors.dim },
  kmVal: { fontSize: fontSize.small, fontWeight: '700', color: colors.darkGray },

  rangeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 10 },
  rangePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.md, backgroundColor: '#f1f5f9' },
  rangeTxt: { fontSize: fontSize.caption, fontWeight: '700', color: colors.midGray },

  sectionLabel: { fontSize: fontSize.micro, fontWeight: '800', letterSpacing: 1, color: colors.midGray },
  dgaValueRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#eef2f7' },
  verdict: { fontSize: fontSize.micro, fontWeight: '800', color: '#7c5e00', backgroundColor: '#fef3c7', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },

  rankHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardTitle: { fontSize: fontSize.bodyLg, fontWeight: '800', color: colors.navy },
  rankNum: { fontSize: fontSize.lg, fontWeight: '800' },
  rankDen: { fontSize: fontSize.caption, color: colors.dim, fontWeight: '600' },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  rankName: { flex: 1.5, fontSize: fontSize.caption, color: colors.midGray },
  rankVal: { width: 56, textAlign: 'right', fontSize: fontSize.small, fontWeight: '700', color: colors.navy, fontVariant: ['tabular-nums'] },
  rankBar: { flex: 1, marginLeft: 8 },

  footnote: { fontSize: fontSize.micro, color: colors.dim, lineHeight: 14, marginTop: 4, paddingHorizontal: 4 },
});
