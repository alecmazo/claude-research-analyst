// ─────────────────────────────────────────────────────────────────────────────
// MarketsScreen — the mobile home/dashboard tab (opens first).
//   Koyfin-style live board: dense index ribbon, movers, watchlist, brief, pulse.
//   Auto-polls quotes while focused. Market Wire lives on Research only.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
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

const QUOTE_POLL_MS = 30_000;

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
function fmtClock(d) {
  if (!d) return '';
  try {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** US equity session label from local clock → America/New_York. */
function usEquitySession(now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return { key: 'unknown', label: 'Markets', live: false, color: '#94a3b8' };
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const mins = hour * 60 + minute;
  const weekend = wd === 'Sat' || wd === 'Sun';
  if (weekend) return { key: 'closed', label: 'Weekend', live: false, color: '#94a3b8' };
  // Pre-market 4:00–9:30 · RTH 9:30–16:00 · After-hours 16:00–20:00 ET
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) {
    return { key: 'pre', label: 'Pre-Market', live: true, color: '#F5C542' };
  }
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) {
    return { key: 'open', label: 'US Open', live: true, color: '#16A34A' };
  }
  if (mins >= 16 * 60 && mins < 20 * 60) {
    return { key: 'ah', label: 'After-Hours', live: true, color: '#F5C542' };
  }
  return { key: 'closed', label: 'US Closed', live: false, color: '#94a3b8' };
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
  const [pulse, setPulse]           = useState(undefined);
  const [pulseInfoOpen, setPulseInfoOpen] = useState(false);
  const [pulseExpanded, setPulseExpanded] = useState({});
  const [pulseBusy, setPulseBusy]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quotesBusy, setQuotesBusy] = useState(false);
  const [lastQuotesAt, setLastQuotesAt] = useState(null);
  const [sessionTick, setSessionTick] = useState(0);
  const moversRef = useRef([]);
  const pollRef = useRef(null);
  const focusedRef = useRef(false);

  const session = useMemo(() => usEquitySession(new Date()), [sessionTick, lastQuotesAt]);

  const loadQuotes = useCallback(async () => {
    await Promise.all([
      api.getMarketIndices().then(d => setIndices(d.indices || [])).catch(() => {}),
      api.getWatchlist().then(d => setWatch(d || { tickers: [], quotes: {} }))
        .catch(() => setWatch({ tickers: [], quotes: {} })),
      api.getIdeaFeed(4, 60).then(d => {
        const m = d.movers || [];
        moversRef.current = m; setMovers(m); setAsOf(d.as_of || '');
      }).catch(() => {}),
    ]);
    setLastQuotesAt(new Date());
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([
      loadQuotes(),
      api.getLatestDailyBrief().then(d => setBrief(d && d.exists && d.markdown ? d : null))
        .catch(() => setBrief(null)),
      api.getLatestScan().then(d => setPulse(d && d.exists && d.results ? d : null))
        .catch(() => setPulse(null)),
    ]);
  }, [loadQuotes]);

  // Focus: load everything once, then auto-poll quotes every 30s (indices + WL + ideas).
  // Never auto-run brief / pulse (AI cost).
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    loadAll();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (!focusedRef.current) return;
      loadQuotes().catch(() => {});
      setSessionTick((n) => n + 1);
    }, QUOTE_POLL_MS);
    return () => {
      focusedRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [loadAll, loadQuotes]));

  // Keep session label fresh even between quote polls.
  useEffect(() => {
    const id = setInterval(() => setSessionTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await loadAll(); setRefreshing(false);
  }, [loadAll]);

  const onRefreshQuotes = useCallback(async () => {
    if (quotesBusy) return;
    setQuotesBusy(true);
    haptics.onPressPrimary?.();
    try {
      await loadQuotes();
    } finally {
      setQuotesBusy(false);
    }
  }, [loadQuotes, quotesBusy]);

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

  // Watchlist rows sorted by |day %| so the board feels alive (Koyfin density).
  const watchRows = useMemo(() => {
    const tks = (watch && watch.tickers) || [];
    const quotes = (watch && watch.quotes) || {};
    return tks
      .map((tk) => {
        const q = quotes[tk] || {};
        const pct = q.pct != null ? Number(q.pct) : (q.pct_change != null ? Number(q.pct_change) : null);
        return { tk, q, pct, abs: pct == null || isNaN(pct) ? -1 : Math.abs(pct) };
      })
      .sort((a, b) => b.abs - a.abs);
  }, [watch]);

  // Breadth from indices + watchlist day moves.
  const breadth = useMemo(() => {
    let up = 0, down = 0, flat = 0;
    const push = (p) => {
      if (p == null || isNaN(p)) return;
      if (p > 0.02) up += 1;
      else if (p < -0.02) down += 1;
      else flat += 1;
    };
    indices.forEach((ix) => push(ix.pct));
    watchRows.forEach((r) => push(r.pct));
    return { up, down, flat, total: up + down + flat };
  }, [indices, watchRows]);

  const cardStyle = [s.card, { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1 }];

  const quotesRefreshBtn = (
    <TouchableOpacity
      onPress={onRefreshQuotes}
      disabled={quotesBusy}
      activeOpacity={0.7}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={s.quotesRefreshBtn}
      accessibilityLabel="Refresh stock quotes"
    >
      {quotesBusy
        ? <ActivityIndicator color="#F5C542" size="small" />
        : <Ionicons name="refresh" size={20} color="#F5C542" />}
    </TouchableOpacity>
  );

  const subtitle = session.live
    ? `${session.label} · auto 30s`
    : `${session.label} · tap ↻ for quotes`;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <AppHeader
        title="Markets"
        subtitle={subtitle}
        showLogo
        right={quotesRefreshBtn}
      />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
      >
        {/* ── Live session strip (Koyfin-style status) ───────────────── */}
        <View style={s.liveStrip}>
          <View style={s.liveLeft}>
            <View style={[s.liveDot, { backgroundColor: session.color }]} />
            <Text style={[s.liveLabel, { color: session.live ? t.textPrimary : t.textSecondary }]}>
              {session.label}
            </Text>
            {session.live ? (
              <View style={s.liveBadge}>
                <Text style={s.liveBadgeTxt}>LIVE</Text>
              </View>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={onRefreshQuotes}
            disabled={quotesBusy}
            activeOpacity={0.7}
            style={s.liveRefresh}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {quotesBusy
              ? <ActivityIndicator color={t.primary} size="small" />
              : (
                <>
                  <Ionicons name="refresh" size={14} color={t.primary} />
                  <Text style={s.liveAsOf}>
                    {lastQuotesAt ? fmtClock(lastQuotesAt) : '—'}
                  </Text>
                </>
              )}
          </TouchableOpacity>
        </View>

        {/* Breadth bar */}
        {breadth.total > 0 && (
          <View style={s.breadthRow}>
            <Text style={[s.breadthTxt, { color: t.pillUpFg }]}>▲ {breadth.up}</Text>
            <View style={s.breadthTrack}>
              <View
                style={[
                  s.breadthUp,
                  {
                    flex: Math.max(breadth.up, 0.01),
                    backgroundColor: t.pillUpFg,
                  },
                ]}
              />
              <View
                style={[
                  s.breadthDown,
                  {
                    flex: Math.max(breadth.down, 0.01),
                    backgroundColor: t.pillDownFg,
                  },
                ]}
              />
            </View>
            <Text style={[s.breadthTxt, { color: t.pillDownFg }]}>{breadth.down} ▼</Text>
          </View>
        )}

        {/* ── 1. Live Markets ─────────────────────────────────────────── */}
        <SectionHeader
          icon="pulse"
          t={t}
          s={s}
          right={
            <TouchableOpacity
              onPress={onRefreshQuotes}
              disabled={quotesBusy}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={s.quotesRefreshChip}
            >
              {quotesBusy
                ? <ActivityIndicator color={t.primary} size="small" />
                : <>
                    <Ionicons name="refresh" size={13} color={t.primary} />
                    <Text style={s.quotesRefreshTxt}>Quotes</Text>
                  </>}
            </TouchableOpacity>
          }
        >Indices</SectionHeader>
        {indices.length === 0 ? (
          <Card style={cardStyle}><ActivityIndicator color={t.primary} /></Card>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
            {indices.map((ix) => {
              const up = ix.pct == null ? null : ix.pct >= 0;
              const edge = up == null ? t.border : up ? t.pillUpFg : t.pillDownFg;
              const tint = up == null
                ? t.surface
                : up
                  ? (t.isDark ? 'rgba(74,222,128,0.08)' : 'rgba(22,163,74,0.06)')
                  : (t.isDark ? 'rgba(248,113,113,0.08)' : 'rgba(220,38,38,0.05)');
              return (
                <View
                  key={ix.symbol}
                  style={[
                    s.idxChip,
                    {
                      borderLeftColor: edge,
                      borderLeftWidth: 3,
                      backgroundColor: tint,
                    },
                  ]}
                >
                  <Text style={s.idxLabel} numberOfLines={1}>{ix.label}</Text>
                  <Text style={s.idxPx}>{fmtPx(ix.price)}</Text>
                  <Text
                    style={[
                      s.idxChg,
                      { color: up == null ? t.textDim : up ? t.pillUpFg : t.pillDownFg },
                    ]}
                  >
                    {fmtPct(ix.pct)}
                  </Text>
                </View>
              );
            })}
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
              const up = m.pct_change == null ? null : m.pct_change >= 0;
              return (
                <View
                  key={m.ticker}
                  style={[
                    s.moverWrap,
                    i < movers.length - 1 && s.divider,
                    up != null && {
                      borderLeftWidth: 3,
                      borderLeftColor: up ? t.pillUpFg : t.pillDownFg,
                    },
                  ]}
                >
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

        {/* ── 3. Watchlist (sorted by |day %|) ───────────────────────── */}
        <SectionHeader
          icon="star-outline"
          t={t}
          s={s}
          right={<Text style={s.asOf}>by day %</Text>}
        >Watchlist</SectionHeader>
        {watch == null ? (
          <Card style={cardStyle}><ActivityIndicator color={t.primary} /></Card>
        ) : !watchRows.length ? (
          <Card style={cardStyle}><Text style={s.muted}>No tickers followed yet.</Text></Card>
        ) : (
          <Card style={[...cardStyle, { padding: 0 }]}>
            {watchRows.map((row, i) => {
              const { tk, q, pct } = row;
              const up = pct == null || isNaN(pct) ? null : pct >= 0;
              const pxColor = up == null ? t.textSecondary : up ? t.pillUpFg : t.pillDownFg;
              return (
                <View
                  key={tk}
                  style={[
                    s.wlRow,
                    i < watchRows.length - 1 && s.divider,
                    up != null && Math.abs(pct) >= 1.5 && {
                      backgroundColor: up
                        ? (t.isDark ? 'rgba(74,222,128,0.06)' : 'rgba(22,163,74,0.04)')
                        : (t.isDark ? 'rgba(248,113,113,0.06)' : 'rgba(220,38,38,0.04)'),
                    },
                  ]}
                >
                  <Text style={s.wlTk}>{tk}</Text>
                  <Text style={[s.wlPx, { color: pxColor }]}>${fmtPx(q.price)}</Text>
                  <View style={{ width: 84, alignItems: 'flex-end' }}><PctPill p={pct} t={t} /></View>
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

    // Live session strip
    liveStrip: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: t.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: t.border,
      paddingVertical: 10, paddingHorizontal: 12, marginBottom: spacing.sm,
    },
    liveLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    liveDot: { width: 8, height: 8, borderRadius: 4 },
    liveLabel: { fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
    liveBadge: {
      backgroundColor: 'rgba(22,163,74,0.15)', borderRadius: 4,
      paddingHorizontal: 5, paddingVertical: 1,
    },
    liveBadgeTxt: { fontSize: 9, fontWeight: '900', color: '#16A34A', letterSpacing: 0.8 },
    liveRefresh: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 56, justifyContent: 'flex-end' },
    liveAsOf: { fontSize: 12, fontWeight: '700', color: t.primary, fontVariant: ['tabular-nums'] },

    breadthRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.md,
      paddingHorizontal: 2,
    },
    breadthTxt: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 28 },
    breadthTrack: {
      flex: 1, height: 6, borderRadius: 3, flexDirection: 'row', overflow: 'hidden',
      backgroundColor: t.surfaceAlt,
    },
    breadthUp: { height: 6 },
    breadthDown: { height: 6 },

    idxChip: {
      backgroundColor: t.surface, borderRadius: radius.xl, paddingVertical: 10, paddingHorizontal: 12,
      marginRight: 8, minWidth: 104, borderWidth: 1, borderColor: t.border,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: t.cardShadowOpacity, shadowRadius: 8, elevation: 3,
    },
    idxLabel: { fontSize: 10, color: t.textSecondary, fontWeight: '700', marginBottom: 3, letterSpacing: 0.3 },
    idxPx: { fontSize: 17, color: t.textPrimary, fontWeight: '800', fontVariant: ['tabular-nums'] },
    idxChg: { fontSize: 12, fontWeight: '800', marginTop: 3, fontVariant: ['tabular-nums'] },

    quotesRefreshBtn: {
      width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(245,197,66,0.15)', borderWidth: 1, borderColor: 'rgba(245,197,66,0.45)',
    },
    quotesRefreshChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12,
      backgroundColor: t.surfaceTint, borderWidth: 1, borderColor: t.border,
    },
    quotesRefreshTxt: { fontSize: 11, fontWeight: '700', color: t.primary },

    moverWrap: { paddingHorizontal: 14 },
    divider: { borderBottomWidth: 1, borderBottomColor: t.border },
    moverRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11 },
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

    wlRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14 },
    wlTk: { flex: 1, fontSize: 14, fontWeight: '800', color: t.textPrimary, letterSpacing: 0.5 },
    wlPx: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], width: 86, textAlign: 'right', marginRight: 8 },

    runBtn: {
      backgroundColor: t.gold, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 5,
      minWidth: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3,
    },
    runBtnTxt: { fontSize: 12, fontWeight: '800', color: t.chromeNavy },
    briefHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
    briefMeta: { fontSize: 11, color: t.textSecondary, fontWeight: '600' },

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
