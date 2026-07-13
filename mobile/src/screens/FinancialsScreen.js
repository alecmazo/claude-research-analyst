/**
 * FinancialsScreen — mobile port of the desktop SEC-XBRL company dashboard.
 *
 * Pure-DB on the server (GET /api/financials/{ticker}/dashboard + price-history)
 * so it costs ~nothing on Railway — zero LLM, zero live pulls. Charts are drawn
 * with plain Views (rotated segments) so the whole screen ships via OTA with no
 * native dependency. Theme-aware (light/dark) via useTheme().
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
  RefreshControl, StyleSheet, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AppHeader from '../components/AppHeader';
import { api } from '../api/client';
import { spacing, radius, fontSize, useTheme } from '../design';

const LAST_KEY = '@dga_fin_last';
const RANGES = ['1M', '3M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'All'];

// Plain-language explanations of the scores/graphics (tap ⓘ to reveal).
const EXPL_DGA_SCORE =
  'A 0–100 quality composite blended from five pillars: Profitability (30%), Growth (25%), ' +
  'Financial Strength (20%), Predictability (15%), and Value (10%). Each bar is that pillar’s own ' +
  '0–100 sub-score; the headline number weights them as above.';
const EXPL_RATING_HIST =
  'Rating bar = where today’s value sits vs this company’s own history (≤12 fiscal years) — ' +
  'fuller bar = near its own best (for leverage/PE, lower is better so “best” means cheaper/safer). ' +
  'Vs Industry = percentile vs industry/sector peers in the SEC store; blank if fewer than 3 peers ' +
  'have that metric (never guessed). Card /10 = mean of available Rating percentiles.';
const EXPL_VALUE_RANK =
  'DGA Value Rank compares valuation multiples (P/E, EV/EBITDA, P/FCF, yields, price vs DCF/Graham/Lynch). ' +
  'Rating (own history) is usually blank for multiples — we only have the current store price, not multi-year ' +
  'price history per FY. Vs Industry fills when ≥3 store peers have the same multiple. Lower multiple / higher ' +
  'yield ranks better. Blank ≠ zero — it means no comparison data.';

// ── tiny helpers ──────────────────────────────────────────────────────────────
const fmtRank = (fmt, v) => {
  if (v == null) return '—';
  if (fmt === 'pct')     return v.toFixed(2) + '%';
  if (fmt === 'int')     return String(Math.round(v));
  if (fmt === 'score10') return Math.round(v) + '/10';
  if (fmt === 'spread')  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  return v.toFixed(2);
};
const gradeColor = (t, v) =>
  v == null ? t.textDim : v >= 80 ? t.green : v >= 60 ? '#65a30d' : v >= 40 ? t.amber : t.red;
const rankColor = (t, r) =>
  r == null ? t.textDim : r >= 7 ? t.green : r >= 4 ? t.amber : t.red;
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
function MiniLine({ points, width, height, color, dimColor }) {
  const ys = (points || []).map((p) => p.c).filter((v) => v != null);
  if (ys.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: dimColor, fontSize: fontSize.small }}>No price history.</Text>
      </View>
    );
  }
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
      {segs.map((sg, i) => (
        <View key={i} style={{
          position: 'absolute', left: sg.cx - sg.len / 2, top: sg.cy - 1,
          width: sg.len, height: 2, backgroundColor: color, transform: [{ rotate: sg.angle + 'deg' }],
        }} />
      ))}
    </View>
  );
}

function Bar({ pct, color, track }) {
  return (
    <View style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: track, overflow: 'hidden' }}>
      {pct != null && (
        <View style={{ height: '100%', width: Math.max(4, Math.min(100, pct)) + '%', backgroundColor: color, borderRadius: 4 }} />
      )}
    </View>
  );
}

// Compact number formats for the fundamentals legends.
const fmtNum = (n) => {
  if (n == null) return '';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6)  return (n / 1e6).toFixed(0) + 'M';
  return String(Math.round(n));
};
const fmtMoney = (n) => n == null ? '' : '$' + fmtNum(n);
const fmtPctS  = (v) => v == null ? '' : v.toFixed(1) + '%';

// ── grouped-bar fundamentals mini-chart (pure View — matches desktop bars) ─────
// Bars per fiscal period, one group of side-by-side bars per series, sharing a
// zero baseline so negative values (e.g. net income, FCF) drop below the line.
function MiniBars({ series, width, height, t }) {
  const all = series.flatMap((s) => (s.values || [])).filter((v) => v != null);
  if (!all.length) return <View style={{ height }} />;
  const hi = Math.max(0, ...all);
  const lo = Math.min(0, ...all);
  const range = (hi - lo) || 1;
  const zeroY = height * (hi / range);                 // y of the zero baseline
  const n = Math.max(...series.map((s) => (s.values || []).length), 1);
  const slotW = width / n;
  const k = series.length;
  const gap = 1;
  const barW = Math.max(2, Math.min(9, slotW / (k + 0.6)));
  const groupW = k * barW + (k - 1) * gap;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const groupLeft = i * slotW + (slotW - groupW) / 2;
    series.forEach((ser, j) => {
      const v = (ser.values || [])[i];
      if (v == null) return;
      let barTop, barH;
      if (v >= 0) { barH = hi > 0 ? (v / hi) * zeroY : 0; barTop = zeroY - barH; }
      else        { barH = lo < 0 ? (Math.abs(v) / Math.abs(lo)) * (height - zeroY) : 0; barTop = zeroY; }
      if (barH < 1 && v !== 0) barH = 1;                // keep tiny values visible
      bars.push(
        <View key={i + '-' + j} style={{
          position: 'absolute', left: groupLeft + j * (barW + gap), top: barTop,
          width: barW, height: barH, backgroundColor: ser.color, borderRadius: 1,
        }} />
      );
    });
  }
  return (
    <View style={{ width, height }}>
      {lo < 0 && <View style={{ position: 'absolute', left: 0, right: 0, top: zeroY, height: 1, backgroundColor: t.border }} />}
      {bars}
    </View>
  );
}

function FundChart({ title, series, width, fmt, t }) {
  if (!series.some((s) => (s.values || []).some((v) => v != null))) return null;
  const last = (vals) => { const f = (vals || []).filter((v) => v != null); return f.length ? f[f.length - 1] : null; };
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <Text style={{ fontSize: fontSize.caption, fontWeight: '800', color: t.textPrimary }}>{title}</Text>
        {series.map((ser, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: ser.color }} />
            <Text style={{ fontSize: 9.5, color: t.textSecondary }}>{ser.name} {fmt(last(ser.values))}</Text>
          </View>
        ))}
      </View>
      <MiniBars series={series} width={width} height={62} t={t} />
    </View>
  );
}

function RankCard({ card, t, s, expl }) {
  const [open, setOpen] = useState(false);
  if (!card || !(card.metrics || []).length) return null;
  const rc = rankColor(t, card.rank);
  return (
    <View style={s.card}>
      <View style={s.rankHead}>
        <TouchableOpacity onPress={() => setOpen((o) => !o)} activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 }}>
          <Text style={s.cardTitle}>{card.title}</Text>
          <Ionicons name={open ? 'information-circle' : 'information-circle-outline'} size={15} color={open ? t.primary : t.textDim} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 56 }}>
            <Bar pct={card.rank == null ? null : card.rank * 10} color={rc} track={t.surfaceAlt} />
          </View>
          <Text style={[s.rankNum, { color: rc }]}>
            {card.rank == null ? '—' : card.rank}
            <Text style={s.rankDen}>/10</Text>
          </Text>
        </View>
      </View>
      {open && <Text style={s.explTxt}>{expl}</Text>}
      <View style={s.rankColHead}>
        <Text style={[s.rankName, { color: t.textDim }]}>Metric</Text>
        <Text style={[s.rankVal, { color: t.textDim, fontWeight: '700' }]}>Current</Text>
        <Text style={s.rankColLbl}>Rating</Text>
        <Text style={s.rankColLbl}>vs Ind</Text>
      </View>
      {card.metrics.map((m, i) => {
        // Rating = own-history percentile; Vs Industry = ind_pct only (blank if missing).
        const ratePct = m.hist_pct != null ? m.hist_pct
          : (m.quality != null ? Math.round(m.quality * 100) : null);
        const rateCol = m.hist_color || m.rating || t.textDim;
        const indPct = m.ind_pct != null ? m.ind_pct : null;
        const indCol = m.ind_color || t.textDim;
        return (
        <View key={i} style={[s.rankRow, i === card.metrics.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={s.rankName} numberOfLines={1}>{m.name}</Text>
          <Text style={s.rankVal}>{fmtRank(m.fmt, m.value)}</Text>
          <View style={s.rankBar}>{ratePct != null ? <Bar pct={ratePct} color={rateCol} track={t.surfaceAlt} /> : null}</View>
          <View style={s.rankBar}>{indPct != null ? <Bar pct={indPct} color={indCol} track={t.surfaceAlt} /> : null}</View>
        </View>
        );
      })}
    </View>
  );
}

// ── screen ──────────────────────────────────────────────────────────────────────
export default function FinancialsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [input, setInput] = useState('');
  const [ticker, setTicker] = useState(null);
  const [data, setData] = useState(null);
  const [hist, setHist] = useState(null);
  const [range, setRange] = useState('YTD');
  const [loading, setLoading] = useState(false);
  const [histLoading, setHistLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chartW, setChartW] = useState(300);
  const [scoreInfo, setScoreInfo] = useState(false);
  const reqId = useRef(0);

  const loadHistory = useCallback(async (tk, rng) => {
    if (!tk) return;
    setHistLoading(true);
    try {
      const h = await api.getFinancialsPriceHistory(tk, rng);
      setHist(h && h.ok ? h : null);
    } catch (e) { setHist(null); }
    finally { setHistLoading(false); }
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
      if (!d || !d.ok) { setData(null); setError(d?.error || `No financials stored for ${sym}.`); }
      else { setData(d); AsyncStorage.setItem(LAST_KEY, sym).catch(() => {}); }
    } catch (e) {
      if (myReq === reqId.current) { setData(null); setError(String(e.message || e)); }
    } finally {
      if (myReq === reqId.current) setLoading(false);
    }
    loadHistory(sym, rng || range);
  }, [range, loadHistory]);

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
  const anchors = data?.valuation || [];
  const S = data?.series || [];
  const col = (k) => S.map((x) => x[k]);
  const stats = hist?.stats || {};
  const lineColor = (stats.change_pct != null && stats.change_pct < 0) ? t.red : t.green;

  const compRow = (label, v) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginVertical: 3 }}>
      <Text style={{ width: 84, fontSize: fontSize.caption, color: t.textSecondary }}>{label}</Text>
      <Bar pct={v} color={gradeColor(t, v)} track={t.surfaceAlt} />
      <Text style={{ width: 26, textAlign: 'right', fontSize: fontSize.caption, fontWeight: '700', color: gradeColor(t, v) }}>
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
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <AppHeader title="Financials" showLogo />

      <View style={s.searchWrap}>
        <TextInput
          style={s.search}
          placeholder="Search a ticker…"
          placeholderTextColor={t.textDim}
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
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => ticker && loadTicker(ticker)} tintColor={t.primary} />}
      >
        {!ticker && !loading && (
          <Text style={s.hint}>Search a ticker to see its SEC fundamentals, DGA Score, and ranking cards.</Text>
        )}

        {loading && (
          <View style={{ paddingTop: 40, alignItems: 'center' }}><ActivityIndicator color={t.primary} /></View>
        )}

        {!loading && error && (
          <View style={s.card}>
            <Text style={{ fontSize: fontSize.bodyLg, fontWeight: '700', color: t.textPrimary }}>{ticker}</Text>
            <Text style={{ marginTop: 6, fontSize: fontSize.body, color: t.textSecondary, lineHeight: 19 }}>{error}</Text>
            <Text style={{ marginTop: 8, fontSize: fontSize.small, color: t.textDim }}>
              Sync this company from the Financials tab on the desktop terminal first.
            </Text>
          </View>
        )}

        {!loading && data && (
          <>
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

            <View style={s.card} onLayout={(e) => setChartW(Math.round(e.nativeEvent.layout.width - spacing.lg * 2))}>
              {histLoading
                ? <View style={{ height: 120, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={t.primary} /></View>
                : <MiniLine points={hist?.points} width={chartW} height={120} color={lineColor} dimColor={t.textDim} />}
              <View style={s.rangeRow}>
                {RANGES.map((r) => {
                  const on = r === range;
                  return (
                    <TouchableOpacity key={r} onPress={() => onRange(r)} activeOpacity={0.8}
                      style={[s.rangePill, on && { backgroundColor: t.primary }]}>
                      <Text style={[s.rangeTxt, on && { color: t.onAccent }]}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={s.card}>
              <TouchableOpacity onPress={() => setScoreInfo((o) => !o)} activeOpacity={0.7}
                style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Text style={s.sectionLabel}>DGA SCORE</Text>
                  <Ionicons name={scoreInfo ? 'information-circle' : 'information-circle-outline'} size={15} color={scoreInfo ? t.primary : t.textDim} />
                </View>
                <Text style={{ fontSize: fontSize.hero, fontWeight: '800', color: gradeColor(t, sc.total) }}>
                  {sc.total == null ? '—' : sc.total}<Text style={{ fontSize: fontSize.small, color: t.textDim, fontWeight: '600' }}> /100</Text>
                </Text>
              </TouchableOpacity>
              {scoreInfo && <Text style={s.explTxt}>{EXPL_DGA_SCORE}</Text>}
              <View style={{ marginTop: 8 }}>
                {compRow('Profitability', comps.profitability)}
                {compRow('Growth', comps.growth)}
                {compRow('Fin. Strength', comps.financial_strength)}
                {compRow('Predictability', comps.predictability)}
                {compRow('Value', comps.value)}
              </View>
              {!!data.dga_value && (
                <View style={s.dgaValueRow}>
                  <Text style={{ fontSize: fontSize.caption, color: t.textSecondary }}>DGA Value</Text>
                  <Text style={{ fontSize: fontSize.bodyLg, fontWeight: '800', color: t.textPrimary }}>{fmtPrice(data.dga_value)}</Text>
                  {!!data.verdict && <Text style={s.verdict}>{data.verdict}</Text>}
                </View>
              )}
            </View>

            {/* Fundamentals — the six desktop charts, condensed for mobile */}
            {S.length > 1 && (
              <View style={s.card} onLayout={(e) => setChartW(Math.round(e.nativeEvent.layout.width - spacing.lg * 2))}>
                <Text style={[s.sectionLabel, { marginBottom: 10 }]}>FUNDAMENTALS · {data.period_type === 'quarter' ? 'QUARTERLY' : 'ANNUAL'}</Text>
                <FundChart title="Revenue · Net income · EBITDA" fmt={fmtMoney} width={chartW} t={t}
                  series={[{ name: 'Rev', color: t.primary, values: col('revenue') }, { name: 'NI', color: t.green, values: col('net_income') }, { name: 'EBITDA', color: t.amber, values: col('ebitda') }]} />
                <FundChart title="Cash vs Debt" fmt={fmtMoney} width={chartW} t={t}
                  series={[{ name: 'Cash', color: t.green, values: col('cash') }, { name: 'Debt', color: t.red, values: col('debt') }]} />
                <FundChart title="Operating & Free cash flow" fmt={fmtMoney} width={chartW} t={t}
                  series={[{ name: 'OCF', color: t.amber, values: col('ocf') }, { name: 'FCF', color: t.primary, values: col('fcf') }]} />
                <FundChart title="ROIC vs WACC" fmt={fmtPctS} width={chartW} t={t}
                  series={[{ name: 'ROIC', color: t.green, values: col('roic_pct') }, { name: 'WACC', color: t.red, values: col('wacc_pct') }]} />
                <FundChart title="Shares outstanding" fmt={fmtNum} width={chartW} t={t}
                  series={[{ name: 'Shares', color: t.primary, values: col('shares') }]} />
                <FundChart title="Equity vs Assets" fmt={fmtMoney} width={chartW} t={t}
                  series={[{ name: 'Equity', color: t.green, values: col('equity') }, { name: 'Assets', color: t.primary, values: col('assets') }]} />
              </View>
            )}

            <RankCard card={rc.financial_strength} t={t} s={s} expl={EXPL_RATING_HIST} />
            <RankCard card={rc.profitability} t={t} s={s} expl={EXPL_RATING_HIST} />
            <RankCard card={rc.value} t={t} s={s} expl={EXPL_VALUE_RANK} />

            {/* Valuation anchors — per-share fair-value models vs current price */}
            {anchors.length > 0 && (
              <View style={s.card}>
                <Text style={[s.sectionLabel, { marginBottom: 8 }]}>VALUATION ANCHORS</Text>
                {anchors.map((a, i) => {
                  const maxAbs = Math.max(data.price || 0, ...anchors.map((x) => Math.abs(x.value || 0)), 1);
                  const w = Math.min(100, (Math.abs(a.value || 0) / maxAbs) * 100);
                  const barCol = a.value < 0 ? t.red : a.kind === 'dga' ? t.gold : a.kind === 'target' ? t.primary : t.textSecondary;
                  return (
                    <View key={i} style={s.anchorRow}>
                      <Text style={s.anchorLabel} numberOfLines={1}>{a.label}</Text>
                      <View style={s.anchorTrack}>
                        <View style={{ height: '100%', width: w + '%', backgroundColor: barCol, borderRadius: 3, opacity: 0.85 }} />
                        {!!data.price && <View style={{ position: 'absolute', left: Math.min(100, (data.price / maxAbs) * 100) + '%', top: -2, bottom: -2, width: 2, backgroundColor: t.textPrimary }} />}
                      </View>
                      <Text style={s.anchorVal}>{fmtPrice(a.value)}</Text>
                    </View>
                  );
                })}
                {!!data.price && <Text style={s.anchorNote}>▏ vertical line = current price ({fmtPrice(data.price)})</Text>}
              </View>
            )}

            <Text style={s.footnote}>
              SEC XBRL store · tap ⓘ on any score for how it’s computed · zero LLM tokens
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
    searchWrap: {
      flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg,
      paddingTop: spacing.md, paddingBottom: spacing.sm, backgroundColor: t.bg,
    },
    search: {
      flex: 1, height: 40, backgroundColor: t.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: t.border, paddingHorizontal: spacing.lg,
      fontSize: fontSize.bodyLg, color: t.textPrimary, letterSpacing: 1,
    },
    goBtn: {
      height: 40, paddingHorizontal: spacing.xl, borderRadius: radius.lg,
      backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center',
    },
    goTxt: { color: t.onAccent, fontWeight: '800', fontSize: fontSize.bodyLg },
    hint: { color: t.textSecondary, fontSize: fontSize.body, lineHeight: 20, paddingTop: 20, textAlign: 'center' },

    card: {
      backgroundColor: t.surface, borderRadius: radius.xl, padding: spacing.lg,
      borderWidth: 1, borderColor: t.border, marginBottom: spacing.md,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: t.cardShadowOpacity, shadowRadius: 8, elevation: 3,
    },
    entity: { fontSize: fontSize.lg, fontWeight: '800', color: t.textPrimary },
    symbol: { fontSize: fontSize.caption, color: t.textDim, marginTop: 1, letterSpacing: 1 },
    ratingPill: { backgroundColor: t.ratingBg, borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 3 },
    ratingTxt: { color: t.ratingFg, fontSize: fontSize.micro, fontWeight: '800', letterSpacing: 0.5 },
    price: { fontSize: 26, fontWeight: '800', color: t.textPrimary },

    kmGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.borderSubtle },
    kmCell: { width: '50%', flexDirection: 'row', justifyContent: 'space-between', paddingRight: spacing.lg, paddingVertical: 3 },
    kmLabel: { fontSize: fontSize.caption, color: t.textDim },
    kmVal: { fontSize: fontSize.small, fontWeight: '700', color: t.textPrimary },

    rangeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 10 },
    rangePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.md, backgroundColor: t.surfaceAlt },
    rangeTxt: { fontSize: fontSize.caption, fontWeight: '700', color: t.textSecondary },

    sectionLabel: { fontSize: fontSize.micro, fontWeight: '800', letterSpacing: 1, color: t.textSecondary },
    dgaValueRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.borderSubtle },
    verdict: { fontSize: fontSize.micro, fontWeight: '800', color: t.amber, backgroundColor: t.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },

    rankHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    cardTitle: { fontSize: fontSize.bodyLg, fontWeight: '800', color: t.textPrimary },
    rankNum: { fontSize: fontSize.lg, fontWeight: '800' },
    rankDen: { fontSize: fontSize.caption, color: t.textDim, fontWeight: '600' },
    rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.borderSubtle },
    rankName: { flex: 1.5, fontSize: fontSize.caption, color: t.textSecondary },
    rankVal: { width: 56, textAlign: 'right', fontSize: fontSize.small, fontWeight: '700', color: t.textPrimary, fontVariant: ['tabular-nums'] },
    rankBar: { flex: 1, marginLeft: 8 },
    rankColHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 4 },
    rankColLbl: { flex: 1, marginLeft: 8, fontSize: 9, fontWeight: '800', letterSpacing: 0.4, color: t.textDim, textTransform: 'uppercase' },
    explTxt: { fontSize: fontSize.caption, color: t.textSecondary, lineHeight: 17, backgroundColor: t.surfaceAlt, padding: 10, borderRadius: radius.md, marginBottom: 10 },

    anchorRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
    anchorLabel: { width: 132, fontSize: fontSize.caption, color: t.textSecondary },
    anchorTrack: { flex: 1, height: 12, marginHorizontal: 8, backgroundColor: t.surfaceAlt, borderRadius: 3, position: 'relative' },
    anchorVal: { width: 64, textAlign: 'right', fontSize: fontSize.small, fontWeight: '700', color: t.textPrimary, fontVariant: ['tabular-nums'] },
    anchorNote: { fontSize: fontSize.micro, color: t.textDim, marginTop: 6 },

    footnote: { fontSize: fontSize.micro, color: t.textDim, lineHeight: 14, marginTop: 4, paddingHorizontal: 4 },
  });
}
