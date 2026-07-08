// ─────────────────────────────────────────────────────────────────────────────
// MarketsScreen — the mobile home/dashboard tab (opens first).
//   1. Live Markets   — index ribbon (S&P, Nasdaq, Dow, VIX, …)
//   2. Idea Generator — today's movers ≥4% from your universe, tap → news
//   3. Watchlist      — equities you follow, with live price + % change
//   4. Daily Brief    — the morning brief (collapsible, with a Run button)
// Pure RN (no WebView, no SVG) so it ships over-the-air. Theme-aware (light/dark).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity,
  ActivityIndicator, StyleSheet, Linking, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import AppHeader from '../components/AppHeader';
import { spacing, radius, fontSize, Card, haptics, makeMdStyles, useTheme } from '../design';

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

function PctPill({ p, size = 12, t }) {
  const up = p == null ? null : p >= 0;
  const bg = p == null ? t.pillFlatBg : up ? t.pillUpBg : t.pillDownBg;
  const fg = p == null ? t.pillFlatFg : up ? t.pillUpFg : t.pillDownFg;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {p != null && <Ionicons name={up ? 'caret-up' : 'caret-down'} size={size - 1} color={fg} />}
      <Text style={{ color: fg, fontWeight: '800', fontSize: size, fontVariant: ['tabular-nums'] }}>{fmtPct(p)}</Text>
    </View>
  );
}

// Pull a one-line summary out of a pulse scan's markdown digest.
// Prefers the "Today's Move:" line the scan prompt mandates; falls back to the
// first substantive line. Strips markdown decoration for plain display.
function pulseSummary(md) {
  if (!md) return '';
  const clean = (ln) => ln.replace(/[*_`#>\[\]]/g, '').replace(/📰/g, '').trim();
  const lines = String(md).split('\n');
  for (const ln of lines) {
    const idx = ln.toLowerCase().indexOf('s move:');
    if (idx >= 0) return clean(ln.slice(idx + 7));
  }
  for (const ln of lines) {
    const txt = clean(ln);
    if (txt.length > 25 && !txt.startsWith('HIGH') && !txt.startsWith('MED') && !txt.startsWith('LOW')) {
      return txt;
    }
  }
  return '';
}

function SentimentPill({ sentiment, t }) {
  const sUp = String(sentiment || '').toUpperCase();
  const bg = sUp === 'BULLISH' ? t.pillUpBg : sUp === 'BEARISH' ? t.pillDownBg : t.pillFlatBg;
  const fg = sUp === 'BULLISH' ? t.pillUpFg : sUp === 'BEARISH' ? t.pillDownFg : t.pillFlatFg;
  const label = sUp ? sUp.charAt(0) + sUp.slice(1).toLowerCase() : 'Neutral';
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontWeight: '800', fontSize: 11 }}>{label}</Text>
    </View>
  );
}

function SectionHeader({ icon, children, right, t, s }) {
  return (
    <View style={styles.sectionRow}>
      <View style={[styles.sectionIcon, { backgroundColor: t.surfaceTint }]}>
        <MaterialCommunityIcons name={icon} size={15} color={t.primary} />
      </View>
      <Text style={s.sectionLabel}>{children}</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

export default function MarketsScreen() {
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const md = useMemo(() => makeMdStyles(t), [t]);
  const [indices, setIndices]   = useState([]);
  const [movers, setMovers]     = useState(null);   // null = loading
  const [moversAsOf, setAsOf]   = useState('');
  const [expanded, setExpanded] = useState({});     // ticker → bool
  const [watch, setWatch]       = useState(null);   // { tickers, quotes }
  const [brief, setBrief]       = useState(undefined); // undefined=loading, null=none, obj=brief
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  // Market Pulse — LATEST STORED scan only (free read); a new scan runs ONLY on
  // explicit, confirmed tap of the Scan button (AI cost — never auto-run).
  const [pulse, setPulse]           = useState(undefined); // undefined=loading, null=none, obj={scanned_at, results}
  const [pulseInfoOpen, setPulseInfoOpen] = useState(false);
  const [pulseExpanded, setPulseExpanded] = useState({}); // ticker → bool
  const [pulseBusy, setPulseBusy]   = useState(false);
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
      // Free, read-only: last completed scan from the server's kv store.
      api.getLatestScan().then(d => setPulse(d && d.exists && d.results ? d : null))
        .catch(() => setPulse(null)),
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

  // Market Pulse scan — AI cost, so: explicit tap → Alert confirm → run + poll.
  // NEVER called from mount/focus/refresh paths.
  const runPulseScan = useCallback(() => {
    const tks = (watch && watch.tickers) || [];
    const n = tks.length;
    if (!n) {
      Alert.alert('Watchlist empty', 'Market Pulse scans your watchlist tickers — add some in Watchlist first.');
      return;
    }
    Alert.alert(
      'Run Market Pulse now?',
      `This runs an AI scan (Grok live web/X search) across ${n} watchlist ticker${n === 1 ? '' : 's'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Run', onPress: async () => {
          haptics.onPressPrimary?.();
          setPulseBusy(true);
          try {
            const job = await api.startScan(tks);
            for (let i = 0; i < 120; i++) {
              await new Promise(r => setTimeout(r, 4000));
              const j = await api.getScanJob(job.job_id).catch(() => null);
              if (j && (j.status === 'done' || j.status === 'cancelled' || j.status === 'failed')) break;
              // Results stream ticker-by-ticker into the store — show progress.
              if (i % 3 === 2) {
                const d = await api.getLatestScan().catch(() => null);
                if (d && d.exists && d.results) setPulse(d);
              }
            }
          } catch (e) {
            Alert.alert('Scan failed', e.message || String(e));
          } finally {
            const d = await api.getLatestScan().catch(() => null);
            if (d && d.exists && d.results) setPulse(d);
            setPulseBusy(false);
          }
        }},
      ],
    );
  }, [watch]);

  const cardStyle = [s.card, { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1 }];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <AppHeader title="Markets" subtitle="Live moves · ideas · watchlist · brief" showLogo />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
      >
        {/* ── 1. Live Markets ─────────────────────────────────────────── */}
        <SectionHeader icon="pulse" t={t} s={s}>Live Markets</SectionHeader>
        {indices.length === 0 ? (
          <Card style={cardStyle}><ActivityIndicator color={t.primary} /></Card>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
            {indices.map((ix) => (
              <View key={ix.symbol} style={s.idxChip}>
                <Text style={s.idxLabel} numberOfLines={1}>{ix.label}</Text>
                <Text style={s.idxPx}>{fmtPx(ix.price)}</Text>
                <View style={{ marginTop: 4, alignSelf: 'flex-start' }}><PctPill p={ix.pct} size={11} t={t} /></View>
              </View>
            ))}
          </ScrollView>
        )}

        {/* ── 2. Idea Generator ──────────────────────────────────────── */}
        <SectionHeader icon="lightbulb-on-outline" t={t} s={s}
          right={moversAsOf ? <Text style={s.asOf}>{moversAsOf}</Text> : null}>
          Idea Generator
        </SectionHeader>
        {movers == null ? (
          <Card style={cardStyle}><ActivityIndicator color={t.primary} /></Card>
        ) : movers.length === 0 ? (
          <Card style={cardStyle}><Text style={s.muted}>No movers ≥ ±4% in your universe right now.</Text></Card>
        ) : (
          <Card style={[...cardStyle, { padding: 0 }]}>
            {movers.map((m, i) => {
              const open = !!expanded[m.ticker];
              return (
                <View key={m.ticker} style={[s.moverWrap, i < movers.length - 1 && s.divider]}>
                  <TouchableOpacity style={s.moverRow} onPress={() => toggleMover(m)} activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <View style={s.moverHead}>
                        <Text style={s.moverTk}>{m.ticker}</Text>
                        {(m.reason_class && m.reason_class !== 'unknown') ? (
                          <Text style={s.reasonChip}>{String(m.reason_class).replace('_', ' ')}</Text>
                        ) : null}
                      </View>
                      {!!m.reason_text && <Text style={s.reasonTxt} numberOfLines={open ? 0 : 1}>{m.reason_text}</Text>}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 2 }}>
                      <PctPill p={m.pct_change} t={t} />
                      <Text style={s.moverPx}>${fmtPx(m.price)}</Text>
                    </View>
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={t.textDim} style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                  {open && (
                    <View style={s.moverDetail}>
                      {m.sector && m.sector !== 'Unknown' ? (
                        <Text style={s.detailMeta}>
                          {m.sector}{m.sector_etf ? `  ·  ${m.sector_etf} ${fmtPct(m.sector_pct_change)}` : ''}
                        </Text>
                      ) : null}
                      {(m.news && m.news.length) ? m.news.map((n, j) => (
                        <TouchableOpacity key={j} style={s.newsItem}
                          onPress={() => n.url && Linking.openURL(n.url).catch(() => {})} activeOpacity={n.url ? 0.6 : 1}>
                          <Text style={s.newsTitle}>{n.title}</Text>
                          <Text style={s.newsMeta}>{n.publisher || ''}</Text>
                        </TouchableOpacity>
                      )) : <Text style={s.muted}>No recent headlines.</Text>}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
        )}

        {/* ── 3. Watchlist ───────────────────────────────────────────── */}
        <SectionHeader icon="star-outline" t={t} s={s}>Watchlist</SectionHeader>
        {watch == null ? (
          <Card style={cardStyle}><ActivityIndicator color={t.primary} /></Card>
        ) : !(watch.tickers || []).length ? (
          <Card style={cardStyle}><Text style={s.muted}>No tickers followed yet.</Text></Card>
        ) : (
          <Card style={[...cardStyle, { padding: 0 }]}>
            {(watch.tickers || []).map((tk, i) => {
              const q = (watch.quotes || {})[tk] || {};
              return (
                <View key={tk} style={[s.wlRow, i < watch.tickers.length - 1 && s.divider]}>
                  <Text style={s.wlTk}>{tk}</Text>
                  <Text style={s.wlPx}>${fmtPx(q.price)}</Text>
                  <View style={{ width: 84, alignItems: 'flex-end' }}><PctPill p={q.pct} t={t} /></View>
                </View>
              );
            })}
          </Card>
        )}

        {/* ── 4. Daily Brief ─────────────────────────────────────────── */}
        <SectionHeader icon="newspaper-variant-outline" t={t} s={s}
          right={
            <TouchableOpacity onPress={runBrief} disabled={briefBusy} style={s.runBtn} activeOpacity={0.8}>
              {briefBusy ? <ActivityIndicator color={t.chromeNavy} size="small" />
                : <><Ionicons name="refresh" size={13} color={t.chromeNavy} /><Text style={s.runBtnTxt}>Run</Text></>}
            </TouchableOpacity>
          }
        >Daily Brief</SectionHeader>
        <Card style={cardStyle}>
          {brief === undefined ? (
            <ActivityIndicator color={t.primary} />
          ) : brief === null ? (
            <Text style={s.muted}>No brief yet — tap Run to generate today’s brief.</Text>
          ) : (
            <View>
              <TouchableOpacity style={s.briefHead} onPress={() => setBriefOpen(o => !o)} activeOpacity={0.7}>
                <Text style={s.briefMeta}>Generated {brief.generated_at ? String(brief.generated_at).slice(5, 16).replace('T', ' ') : ''}</Text>
                <Ionicons name={briefOpen ? 'chevron-up' : 'chevron-down'} size={18} color={t.textDim} />
              </TouchableOpacity>
              {briefOpen
                ? <Markdown style={md}>{brief.markdown}</Markdown>
                : <Text style={s.muted} numberOfLines={2}>{(brief.markdown || '').replace(/[#*>`]/g, '').replace(/\n+/g, ' ').trim()}</Text>}
            </View>
          )}
        </Card>

        {/* ── 5. Market Pulse ────────────────────────────────────────── */}
        <SectionHeader icon="radar" t={t} s={s}
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {pulse && pulse.scanned_at ? (
                <Text style={s.asOf}>{String(pulse.scanned_at).slice(5, 16).replace('T', ' ')}</Text>
              ) : null}
              <TouchableOpacity
                onPress={() => setPulseInfoOpen(o => !o)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
              >
                <Ionicons name="information-circle-outline" size={17}
                  color={pulseInfoOpen ? t.primary : t.textDim} />
              </TouchableOpacity>
              <TouchableOpacity onPress={runPulseScan} disabled={pulseBusy} style={s.runBtn} activeOpacity={0.8}>
                {pulseBusy ? <ActivityIndicator color={t.chromeNavy} size="small" />
                  : <><Ionicons name="flash" size={13} color={t.chromeNavy} /><Text style={s.runBtnTxt}>Scan</Text></>}
              </TouchableOpacity>
            </View>
          }
        >Market Pulse</SectionHeader>
        <Card style={[...cardStyle, { padding: 0 }]}>
          {pulseInfoOpen && (
            <View style={s.pulseInfoBox}>
              <Text style={s.pulseInfoTxt}>
                Market Pulse runs a live web + X (Twitter) search for every ticker on your
                watchlist and tags each one Bullish / Bearish / Neutral with the day's primary
                price driver. It runs on your Automation schedule (Settings) or when you tap
                Scan — opening this screen only loads the last completed scan and never starts
                a new one.
              </Text>
            </View>
          )}
          {pulse === undefined ? (
            <View style={{ padding: 14 }}><ActivityIndicator color={t.primary} /></View>
          ) : (pulse === null || !Object.keys(pulse.results || {}).length) ? (
            <Text style={[s.muted, { padding: 14 }]}>
              No pulse scan yet — tap Scan or schedule it in Settings.
            </Text>
          ) : (
            Object.keys(pulse.results).sort().map((tk, i, arr) => {
              const r = pulse.results[tk] || {};
              const failed = r.ok === false;
              const line = failed
                ? (r.error ? `Scan failed: ${String(r.error).slice(0, 120)}` : 'Scan failed.')
                : pulseSummary(r.markdown);
              const canExpand = !failed && !!r.markdown;
              const open = !!pulseExpanded[tk];
              const head = (
                <>
                  <View style={s.pulseHead}>
                    <Text style={s.pulseTk}>{tk}</Text>
                    <SentimentPill sentiment={failed ? 'UNKNOWN' : r.sentiment} t={t} />
                    <View style={{ flex: 1 }} />
                    {r.pct_change != null && (
                      <Text style={[s.pulsePct, { color: r.pct_change >= 0 ? t.pillUpFg : t.pillDownFg }]}>
                        {fmtPct(r.pct_change)}
                      </Text>
                    )}
                    {canExpand && (
                      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={t.textDim} style={{ marginLeft: 6 }} />
                    )}
                  </View>
                  {!!line && <Text style={s.pulseTxt} numberOfLines={open ? 0 : 2}>{line}</Text>}
                </>
              );
              return (
                <View key={tk} style={[s.pulseRow, i < arr.length - 1 && s.divider]}>
                  {canExpand ? (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => { haptics.onPressPrimary?.(); setPulseExpanded(e => ({ ...e, [tk]: !e[tk] })); }}
                    >
                      {head}
                    </TouchableOpacity>
                  ) : head}
                  {canExpand && open && (
                    <View style={{ marginTop: 6 }}>
                      <Markdown style={md}>{r.markdown}</Markdown>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

// Layout-only styles shared across themes (no colors here).
const styles = StyleSheet.create({
  sectionRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, marginTop: spacing.xs, gap: 8 },
  sectionIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
});

function makeStyles(t) {
  return StyleSheet.create({
    card: { marginBottom: spacing.md },
    sectionLabel: { fontSize: 12, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.8, textTransform: 'uppercase' },
    asOf: { fontSize: 10, color: t.textDim, fontWeight: '500' },
    muted: { fontSize: 13, color: t.textSecondary },

    idxChip: {
      backgroundColor: t.surface, borderRadius: radius.xl, paddingVertical: 11, paddingHorizontal: 14,
      marginRight: 9, minWidth: 112, borderWidth: 1, borderColor: t.border,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: t.cardShadowOpacity, shadowRadius: 8, elevation: 3,
    },
    idxLabel: { fontSize: 10, color: t.textSecondary, fontWeight: '700', marginBottom: 4, letterSpacing: 0.3 },
    idxPx: { fontSize: 16, color: t.textPrimary, fontWeight: '800', fontVariant: ['tabular-nums'] },

    moverWrap: { paddingHorizontal: 14 },
    divider: { borderBottomWidth: 1, borderBottomColor: t.border },
    moverRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    moverHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    moverTk: { fontSize: 15, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.5 },
    reasonChip: {
      fontSize: 9, fontWeight: '700', color: t.textSecondary, backgroundColor: t.surfaceAlt,
      borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden', textTransform: 'uppercase',
    },
    reasonTxt: { fontSize: 11.5, color: t.textSecondary, marginTop: 2 },
    moverPx: { fontSize: 11, color: t.textDim, fontVariant: ['tabular-nums'] },
    moverDetail: { paddingBottom: 12, paddingTop: 2 },
    detailMeta: { fontSize: 11, color: t.textSecondary, marginBottom: 6, fontWeight: '600' },
    newsItem: { paddingVertical: 5, borderTopWidth: 1, borderTopColor: t.borderSubtle },
    newsTitle: { fontSize: 12.5, color: t.textPrimary, fontWeight: '600', lineHeight: 17 },
    newsMeta: { fontSize: 10, color: t.textDim, marginTop: 1 },

    wlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 },
    wlTk: { flex: 1, fontSize: 14, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.5 },
    wlPx: { fontSize: 13, color: t.textSecondary, fontWeight: '600', fontVariant: ['tabular-nums'], width: 86, textAlign: 'right', marginRight: 8 },

    runBtn: {
      backgroundColor: t.gold, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 5,
      minWidth: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3,
    },
    runBtnTxt: { fontSize: 12, fontWeight: '800', color: t.chromeNavy },
    briefHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
    briefMeta: { fontSize: 11, color: t.textSecondary, fontWeight: '600' },

    // Market Pulse
    pulseInfoBox: {
      paddingHorizontal: 14, paddingVertical: 10,
      backgroundColor: t.surfaceAlt,
      borderBottomWidth: 1, borderBottomColor: t.border,
    },
    pulseInfoTxt: { fontSize: 12, color: t.textSecondary, lineHeight: 17 },
    pulseRow:  { paddingHorizontal: 14, paddingVertical: 11 },
    pulseHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    pulseTk:   { fontSize: 15, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.5 },
    pulsePct:  { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    pulseTxt:  { fontSize: 11.5, color: t.textSecondary, marginTop: 3, lineHeight: 16 },
  });
}
