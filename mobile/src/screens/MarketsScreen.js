// ─────────────────────────────────────────────────────────────────────────────
// MarketsScreen — the mobile home/dashboard tab (opens first).
//   1. Live Markets   — index ribbon (S&P, Nasdaq, Dow, VIX, …)
//   2. Idea Generator — today's movers ≥4% from your universe, tap → news
//   3. Watchlist      — equities you follow, with live price + % change
//   4. Daily Brief    — the morning brief (collapsible, with a Run button)
// Pure RN (no WebView, no SVG) so it ships over-the-air.
//
// Phase-2 redesign: icon-led section headers, tinted up/down % pills, cleaner
// cards. Data/loading logic is unchanged from the previous version.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  ActivityIndicator, StyleSheet, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, spacing, radius, shadow, fontSize, Card, haptics, mdStyles } from '../design';

// ── format helpers ───────────────────────────────────────────────────────────
function fmtPct(p) {
  if (p == null || isNaN(p)) return '—';
  return (p >= 0 ? '+' : '') + Number(p).toFixed(2) + '%';
}
function fmtPx(p) {
  if (p == null || isNaN(p)) return '—';
  const n = Number(p);
  return n >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const pctColor = (p) => (p == null ? colors.midGray : p >= 0 ? colors.green : colors.red);

// Tinted up/down pill — the signature element of the refreshed look.
function PctPill({ p, size = 12 }) {
  const up = p == null ? null : p >= 0;
  const bg = p == null ? '#f1f5f9' : up ? '#dcfce7' : '#fee2e2';
  const fg = p == null ? colors.midGray : up ? '#166534' : '#991b1b';
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {p != null && <Ionicons name={up ? 'caret-up' : 'caret-down'} size={size - 1} color={fg} />}
      <Text style={{ color: fg, fontWeight: '800', fontSize: size, fontVariant: ['tabular-nums'] }}>{fmtPct(p)}</Text>
    </View>
  );
}

function SectionHeader({ icon, children, right }) {
  return (
    <View style={styles.sectionRow}>
      <View style={styles.sectionIcon}>
        <MaterialCommunityIcons name={icon} size={15} color={colors.primary} />
      </View>
      <Text style={styles.sectionLabel}>{children}</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

export default function MarketsScreen() {
  const [indices, setIndices]   = useState([]);
  const [movers, setMovers]     = useState(null);   // null = loading
  const [moversAsOf, setAsOf]   = useState('');
  const [expanded, setExpanded] = useState({});     // ticker → bool
  const [watch, setWatch]       = useState(null);   // { tickers, quotes }
  const [brief, setBrief]       = useState(undefined); // undefined=loading, null=none, obj=brief
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const moversRef = useRef([]);

  const loadAll = useCallback(async () => {
    await Promise.all([
      api.getMarketIndices().then(d => setIndices(d.indices || [])).catch(() => {}),
      api.getIdeaFeed(4, 60).then(d => {
        const m = d.movers || [];
        moversRef.current = m; setMovers(m); setAsOf(d.as_of || '');
      }).catch(() => setMovers([])),
      api.getWatchlist().then(d => setWatch(d || { tickers: [], quotes: {} }))
        .catch(() => setWatch({ tickers: [], quotes: {} })),
      api.getLatestDailyBrief().then(d => setBrief(d && d.exists && d.markdown ? d : null))
        .catch(() => setBrief(null)),
    ]);
  }, []);

  useFocusEffect(useCallback(() => { loadAll(); }, [loadAll]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await loadAll(); setRefreshing(false);
  }, [loadAll]);

  const toggleMover = useCallback(async (m) => {
    const tk = m.ticker;
    setExpanded(e => ({ ...e, [tk]: !e[tk] }));
    haptics.onPressPrimary?.();
    if ((!m.news || !m.news.length) && !m._newsTried) {
      m._newsTried = true;
      try {
        const d = await api.getNews(tk, 6);
        const items = (d.news && d.news[tk]) || [];
        if (items.length) { m.news = items; setMovers([...moversRef.current]); }
      } catch (e) { /* leave "no headlines" */ }
    }
  }, []);

  const runBrief = useCallback(async () => {
    setBriefBusy(true);
    try {
      const job = await api.startDailyBrief();
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const j = await api.getDailyBriefJob(job.job_id).catch(() => null);
        if (j && (j.status === 'done' || j.status === 'completed' || j.status === 'error')) break;
      }
      const d = await api.getLatestDailyBrief().catch(() => null);
      setBrief(d && d.exists && d.markdown ? d : null);
      setBriefOpen(true);
    } catch (e) { /* swallow */ }
    finally { setBriefBusy(false); }
  }, []);

  return (
    <View style={styles.flex}>
      <AppHeader title="Markets" subtitle="Live moves · ideas · watchlist · brief" showLogo />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* ── 1. Live Markets ─────────────────────────────────────────── */}
        <SectionHeader icon="pulse">Live Markets</SectionHeader>
        {indices.length === 0 ? (
          <Card style={styles.card}><ActivityIndicator color={colors.primary} /></Card>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
            {indices.map((ix) => (
              <View key={ix.symbol} style={styles.idxChip}>
                <Text style={styles.idxLabel} numberOfLines={1}>{ix.label}</Text>
                <Text style={styles.idxPx}>{fmtPx(ix.price)}</Text>
                <View style={{ marginTop: 4, alignSelf: 'flex-start' }}><PctPill p={ix.pct} size={11} /></View>
              </View>
            ))}
          </ScrollView>
        )}

        {/* ── 2. Idea Generator ──────────────────────────────────────── */}
        <SectionHeader icon="lightbulb-on-outline"
          right={moversAsOf ? <Text style={styles.asOf}>{moversAsOf}</Text> : null}>
          Idea Generator
        </SectionHeader>
        {movers == null ? (
          <Card style={styles.card}><ActivityIndicator color={colors.primary} /></Card>
        ) : movers.length === 0 ? (
          <Card style={styles.card}><Text style={styles.muted}>No movers ≥ ±4% in your universe right now.</Text></Card>
        ) : (
          <Card style={[styles.card, { padding: 0 }]}>
            {movers.map((m, i) => {
              const open = !!expanded[m.ticker];
              return (
                <View key={m.ticker} style={[styles.moverWrap, i < movers.length - 1 && styles.divider]}>
                  <TouchableOpacity style={styles.moverRow} onPress={() => toggleMover(m)} activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.moverHead}>
                        <Text style={styles.moverTk}>{m.ticker}</Text>
                        {(m.reason_class && m.reason_class !== 'unknown') ? (
                          <Text style={styles.reasonChip}>{String(m.reason_class).replace('_', ' ')}</Text>
                        ) : null}
                      </View>
                      {!!m.reason_text && <Text style={styles.reasonTxt} numberOfLines={open ? 0 : 1}>{m.reason_text}</Text>}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <PctPill p={m.pct_change} />
                      <Text style={styles.moverPx}>${fmtPx(m.price)}</Text>
                    </View>
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.dim} style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                  {open && (
                    <View style={styles.moverDetail}>
                      {m.sector && m.sector !== 'Unknown' ? (
                        <Text style={styles.detailMeta}>
                          {m.sector}{m.sector_etf ? `  ·  ${m.sector_etf} ${fmtPct(m.sector_pct_change)}` : ''}
                        </Text>
                      ) : null}
                      {(m.news && m.news.length) ? m.news.map((n, j) => (
                        <TouchableOpacity key={j} style={styles.newsItem}
                          onPress={() => n.url && Linking.openURL(n.url).catch(() => {})} activeOpacity={n.url ? 0.6 : 1}>
                          <Text style={styles.newsTitle}>{n.title}</Text>
                          <Text style={styles.newsMeta}>{n.publisher || ''}</Text>
                        </TouchableOpacity>
                      )) : <Text style={styles.muted}>No recent headlines.</Text>}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
        )}

        {/* ── 3. Watchlist ───────────────────────────────────────────── */}
        <SectionHeader icon="star-outline">Watchlist</SectionHeader>
        {watch == null ? (
          <Card style={styles.card}><ActivityIndicator color={colors.primary} /></Card>
        ) : !(watch.tickers || []).length ? (
          <Card style={styles.card}><Text style={styles.muted}>No tickers followed yet.</Text></Card>
        ) : (
          <Card style={[styles.card, { padding: 0 }]}>
            {(watch.tickers || []).map((tk, i) => {
              const q = (watch.quotes || {})[tk] || {};
              return (
                <View key={tk} style={[styles.wlRow, i < watch.tickers.length - 1 && styles.divider]}>
                  <Text style={styles.wlTk}>{tk}</Text>
                  <Text style={styles.wlPx}>${fmtPx(q.price)}</Text>
                  <View style={{ width: 84, alignItems: 'flex-end' }}><PctPill p={q.pct} /></View>
                </View>
              );
            })}
          </Card>
        )}

        {/* ── 4. Daily Brief ─────────────────────────────────────────── */}
        <SectionHeader icon="newspaper-variant-outline"
          right={
            <TouchableOpacity onPress={runBrief} disabled={briefBusy} style={styles.runBtn} activeOpacity={0.8}>
              {briefBusy ? <ActivityIndicator color={colors.navy} size="small" />
                : <><Ionicons name="refresh" size={13} color={colors.navy} /><Text style={styles.runBtnTxt}>Run</Text></>}
            </TouchableOpacity>
          }
        >Daily Brief</SectionHeader>
        <Card style={styles.card}>
          {brief === undefined ? (
            <ActivityIndicator color={colors.primary} />
          ) : brief === null ? (
            <Text style={styles.muted}>No brief yet — tap Run to generate today’s brief.</Text>
          ) : (
            <View>
              <TouchableOpacity style={styles.briefHead} onPress={() => setBriefOpen(o => !o)} activeOpacity={0.7}>
                <Text style={styles.briefMeta}>Generated {brief.generated_at ? String(brief.generated_at).slice(5, 16).replace('T', ' ') : ''}</Text>
                <Ionicons name={briefOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.dim} />
              </TouchableOpacity>
              {briefOpen
                ? <Markdown style={mdStyles}>{brief.markdown}</Markdown>
                : <Text style={styles.muted} numberOfLines={2}>{(brief.markdown || '').replace(/[#*>`]/g, '').replace(/\n+/g, ' ').trim()}</Text>}
            </View>
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.offWhite },
  card: { marginBottom: spacing.lg },

  // Section header
  sectionRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, marginTop: spacing.xs, gap: 8 },
  sectionIcon: {
    width: 26, height: 26, borderRadius: 8, backgroundColor: '#eef6fb',
    alignItems: 'center', justifyContent: 'center',
  },
  sectionLabel: { fontSize: 12, fontWeight: '800', color: colors.navy, letterSpacing: 0.8, textTransform: 'uppercase' },
  asOf: { fontSize: 10, color: colors.dim, fontWeight: '500' },
  muted: { fontSize: 13, color: colors.midGray },

  // Tinted % pill
  pill: { flexDirection: 'row', alignItems: 'center', gap: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },

  // Live Markets chips
  idxChip: {
    backgroundColor: colors.white, borderRadius: radius.xl, paddingVertical: 11, paddingHorizontal: 14,
    marginRight: 9, minWidth: 112, borderWidth: 1, borderColor: colors.lightGray, ...shadow.card,
  },
  idxLabel: { fontSize: 10, color: colors.midGray, fontWeight: '700', marginBottom: 4, letterSpacing: 0.3 },
  idxPx: { fontSize: 16, color: colors.navy, fontWeight: '800', fontVariant: ['tabular-nums'] },

  // Idea Generator
  moverWrap: { paddingHorizontal: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.lightGray },
  moverRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  moverHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  moverTk: { fontSize: 15, fontWeight: '800', color: colors.navy, letterSpacing: 0.5 },
  reasonChip: {
    fontSize: 9, fontWeight: '700', color: colors.midGray, backgroundColor: colors.offWhite,
    borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', textTransform: 'uppercase',
  },
  reasonTxt: { fontSize: 11.5, color: colors.midGray, marginTop: 2 },
  moverPx: { fontSize: 11, color: colors.dim, fontVariant: ['tabular-nums'] },
  moverDetail: { paddingBottom: 12, paddingTop: 2 },
  detailMeta: { fontSize: 11, color: colors.midGray, marginBottom: 6, fontWeight: '600' },
  newsItem: { paddingVertical: 5, borderTopWidth: 1, borderTopColor: colors.offWhite },
  newsTitle: { fontSize: 12.5, color: colors.darkGray, fontWeight: '600', lineHeight: 17 },
  newsMeta: { fontSize: 10, color: colors.dim, marginTop: 1 },

  // Watchlist
  wlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 },
  wlTk: { flex: 1, fontSize: 14, fontWeight: '800', color: colors.navy, letterSpacing: 0.5 },
  wlPx: { fontSize: 13, color: colors.darkGray, fontWeight: '600', fontVariant: ['tabular-nums'], width: 86, textAlign: 'right', marginRight: 8 },

  // Daily Brief
  runBtn: {
    backgroundColor: colors.gold, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 5,
    minWidth: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3,
  },
  runBtnTxt: { fontSize: 12, fontWeight: '800', color: colors.navy },
  briefHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  briefMeta: { fontSize: 11, color: colors.midGray, fontWeight: '600' },
});
