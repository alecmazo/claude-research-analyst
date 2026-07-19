/**
 * StockInfoCard — free (zero-LLM) stock snapshot.
 * Mirrors the desktop top-ticker / positions expander from GET /api/stock-info/{ticker}:
 * quote, meta, 52w range, derived ratios, fundamentals. NOT the saved research report.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView,
} from 'react-native';
import { api } from '../api/client';
import { spacing, radius, fontSize, useTheme } from '../design';

const GREEN = '#16A34A';
const RED = '#DC2626';

function fmtPx(v) {
  if (v == null || isNaN(v)) return null;
  return '$' + Number(v).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return null;
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtCompact(v) {
  if (v == null || isNaN(v)) return null;
  const a = Math.abs(Number(v));
  const sign = Number(v) < 0 ? '−' : '';
  if (a >= 1e12) return sign + '$' + (a / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
  return sign + '$' + a.toFixed(2);
}
function fmtMargin(v) {
  if (v == null || isNaN(v)) return null;
  // company_financials stores margins as fractions 0–1
  const n = Number(v);
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return pct.toFixed(1) + '%';
}

function Stat({ label, value, color, t, s }) {
  if (value == null || value === '') return null;
  return (
    <View style={s.stat}>
      <Text style={[s.statLabel, { color: t.textDim }]} numberOfLines={1}>{label}</Text>
      <Text style={[s.statVal, { color: color || t.textPrimary }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/**
 * @param {string} ticker
 * @param {object} [positionCtx] optional { qty, value, weight, avgCost, dayPct, pl }
 * @param {function} [onOpenReport]
 * @param {function} [onRunAnalysis]
 * @param {boolean} [compact] slightly tighter padding for inline expand
 */
export default function StockInfoCard({
  ticker,
  positionCtx,
  onOpenReport,
  onRunAnalysis,
  compact = false,
}) {
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t, compact), [t, compact]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const tk = String(ticker || '').trim().toUpperCase();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    if (!tk) {
      setLoading(false);
      setErr('No ticker');
      return undefined;
    }
    api.getStockInfo(tk)
      .then((d) => {
        if (!cancelled) setData(d || {});
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tk]);

  if (loading) {
    return (
      <View style={s.box}>
        <ActivityIndicator color={t.primary} />
        <Text style={[s.muted, { marginTop: 8 }]}>Loading {tk} snapshot…</Text>
      </View>
    );
  }
  if (err) {
    return (
      <View style={s.box}>
        <Text style={[s.err, { color: t.red || RED }]}>Could not load {tk}: {err}</Text>
      </View>
    );
  }

  const q = data?.quote || {};
  const m = data?.meta || {};
  const w = data?.range52w || {};
  const fin = data?.financials || {};
  const dv = data?.derived || {};
  const sr = data?.saved_report || {};
  const name = m.name || fin.entity_name || tk;
  const sectorBits = [m.sector, m.industry].filter(Boolean).join(' · ');
  const pct = q.pct_change != null ? Number(q.pct_change) : null;
  const pctColor = pct == null ? t.textSecondary : (pct >= 0 ? GREEN : RED);
  const fy = fin.fy ? ` FY${String(fin.fy).slice(-2)}` : '';

  const stats = [
    { label: '52w High', value: w.high != null ? fmtPx(w.high) : null },
    { label: '52w Low', value: w.low != null ? fmtPx(w.low) : null },
    { label: 'Off High', value: fmtPct(w.off_high_pct), color: w.off_high_pct != null && w.off_high_pct < 0 ? RED : GREEN },
    { label: 'YTD', value: fmtPct(w.ytd_pct), color: w.ytd_pct != null && w.ytd_pct < 0 ? RED : GREEN },
    { label: '1Y', value: fmtPct(w.one_year_pct), color: w.one_year_pct != null && w.one_year_pct < 0 ? RED : GREEN },
    { label: 'Realized Vol', value: q.realized_vol != null ? Number(q.realized_vol).toFixed(1) + '%' : null },
    { label: 'Mkt Cap', value: fmtCompact(dv.market_cap) },
    { label: 'P/E', value: dv.pe != null ? Number(dv.pe).toFixed(1) : null },
    { label: 'FCF Yield', value: dv.fcf_yield_pct != null ? Number(dv.fcf_yield_pct).toFixed(2) + '%' : null },
    { label: 'Net Cash', value: fmtCompact(dv.net_cash) },
    { label: 'Debt/Equity', value: dv.debt_to_equity != null ? Number(dv.debt_to_equity).toFixed(2) : null },
    { label: 'Revenue' + fy, value: fmtCompact(fin.revenue) },
    { label: 'Net Income' + fy, value: fmtCompact(fin.net_income) },
    { label: 'EBITDA' + fy, value: fmtCompact(fin.ebitda) },
    { label: 'Gross Margin', value: fmtMargin(fin.gross_margin) },
    { label: 'Op Margin', value: fmtMargin(fin.operating_margin) },
    { label: 'Net Margin', value: fmtMargin(fin.net_margin) },
    { label: 'Diluted EPS', value: fin.diluted_eps != null ? '$' + Number(fin.diluted_eps).toFixed(2) : null },
    { label: 'FCF' + fy, value: fmtCompact(fin.free_cash_flow) },
  ];

  if (positionCtx) {
    if (positionCtx.qty != null) {
      stats.push({
        label: 'Position Qty',
        value: Number(positionCtx.qty).toLocaleString('en-US', { maximumFractionDigits: 2 }),
      });
    }
    if (positionCtx.value != null) stats.push({ label: 'Position Value', value: fmtCompact(positionCtx.value) });
    if (positionCtx.weight != null) {
      stats.push({ label: 'Weight', value: Number(positionCtx.weight).toFixed(2) + '%' });
    }
    if (positionCtx.avgCost != null) stats.push({ label: 'Avg Cost', value: fmtPx(positionCtx.avgCost) });
    if (positionCtx.pl != null) {
      stats.push({
        label: 'Unrealized P/L',
        value: fmtCompact(positionCtx.pl),
        color: Number(positionCtx.pl) >= 0 ? GREEN : RED,
      });
    }
  }

  const visibleStats = stats.filter((x) => x.value != null && x.value !== '');

  return (
    <View style={s.box}>
      <View style={s.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.name, { color: t.textPrimary }]} numberOfLines={2}>{name}</Text>
          {sectorBits ? (
            <Text style={[s.sector, { color: t.textSecondary }]} numberOfLines={1}>{sectorBits}</Text>
          ) : null}
        </View>
        <View style={s.priceCol}>
          <Text style={[s.price, { color: t.textPrimary }]}>
            {q.price != null ? fmtPx(q.price) : '—'}
          </Text>
          {pct != null ? (
            <Text style={[s.dayPct, { color: pctColor }]}>{fmtPct(pct)}</Text>
          ) : null}
        </View>
      </View>

      <View style={s.badgeRow}>
        <View style={[s.badge, { backgroundColor: 'rgba(22,163,74,0.12)' }]}>
          <Text style={[s.badgeTxt, { color: GREEN }]}>NO AI · free snapshot</Text>
        </View>
        {q.live ? (
          <View style={[s.badge, { backgroundColor: t.surfaceAlt || t.surface }]}>
            <Text style={[s.badgeTxt, { color: t.textSecondary }]}>Live quote</Text>
          </View>
        ) : null}
      </View>

      {visibleStats.length ? (
        <View style={s.grid}>
          {visibleStats.map((st) => (
            <Stat key={st.label} label={st.label} value={st.value} color={st.color} t={t} s={s} />
          ))}
        </View>
      ) : (
        <Text style={s.muted}>
          No stored fundamentals for {tk} yet — quote may still be live above.
        </Text>
      )}

      <View style={s.actions}>
        {sr.exists && onOpenReport ? (
          <TouchableOpacity style={[s.btn, s.btnSecondary, { borderColor: t.border }]} onPress={onOpenReport} activeOpacity={0.8}>
            <Text style={[s.btnSecondaryTxt, { color: t.textPrimary }]} numberOfLines={1}>
              📄 Saved report{sr.rating ? ` · ${sr.rating}` : ''}
              {sr.price_target != null ? ` · PT ${fmtPx(sr.price_target)}` : ''}
            </Text>
          </TouchableOpacity>
        ) : null}
        {onRunAnalysis ? (
          <TouchableOpacity style={[s.btn, s.btnPrimary, { backgroundColor: t.primary }]} onPress={onRunAnalysis} activeOpacity={0.85}>
            <Text style={[s.btnPrimaryTxt, { color: t.onAccent || '#0A1628' }]}>⚡ Run AI analysis</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t, compact) {
  const pad = compact ? 10 : 14;
  return StyleSheet.create({
    box: {
      padding: pad,
      backgroundColor: t.surfaceAlt || t.surface,
      borderRadius: radius.md,
    },
    muted: { fontSize: fontSize.small, color: t.textSecondary, fontStyle: 'italic' },
    err: { fontSize: fontSize.small, fontWeight: '600' },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    name: { fontSize: fontSize.body, fontWeight: '800', letterSpacing: -0.2 },
    sector: { fontSize: fontSize.caption, marginTop: 2 },
    priceCol: { alignItems: 'flex-end' },
    price: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
    dayPct: { fontSize: fontSize.small, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 10 },
    badge: { borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
    badgeTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginHorizontal: -4,
    },
    stat: {
      width: '33.33%',
      paddingHorizontal: 4,
      paddingVertical: 6,
    },
    statLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.2, textTransform: 'uppercase' },
    statVal: { fontSize: 12.5, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
    actions: { marginTop: 12, gap: 8 },
    btn: {
      borderRadius: radius.md,
      paddingVertical: 11,
      paddingHorizontal: 12,
      alignItems: 'center',
    },
    btnPrimary: {},
    btnPrimaryTxt: { fontWeight: '800', fontSize: fontSize.small },
    btnSecondary: { borderWidth: 1, backgroundColor: t.surface },
    btnSecondaryTxt: { fontWeight: '700', fontSize: fontSize.caption },
  });
}

/** Scroll-friendly wrapper when used inside a bottom sheet. */
export function StockInfoScroll({ children, style }) {
  return (
    <ScrollView
      style={style}
      contentContainerStyle={{ paddingBottom: spacing.lg }}
      showsVerticalScrollIndicator={false}
      bounces
    >
      {children}
    </ScrollView>
  );
}
