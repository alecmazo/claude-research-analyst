/**
 * LPPerformanceScreen — LP-only home tab.
 *
 * Mirrors the web LP dashboard: hero with fund summary, per-fund and
 * per-managed-account cards with expandable annual performance tables
 * and bar charts, all scoped to the authenticated LP via
 * /api/v2/lp/me/overview.
 * GPs never see this screen — they get the full 6-tab GP navigator.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { v2Fetch, getV2User, logoutV2 } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, haptics } from '../design';

const SCREEN_W = Dimensions.get('window').width;

/* ── Formatters ───────────────────────────────────────────────────── */
function fmtUSD(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtPct(v, decimals = 2) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(decimals) + '%';
}
function pctColor(v) {
  if (v == null) return colors.navy;
  return v >= 0 ? '#1a7f40' : '#cc3333';
}

/* ── Pure-View bar + line chart (no native deps) ──────────────────── */
//
// Line overlay math:
//   Each bar-group slot = marginHorizontal(5) + content(26) + marginHorizontal(5) = 36px
//   Y-axis column = 32px
//   Center of group i  →  x = 32 + 5 + 13 + i*36 = 50 + i*36
//   Benchmark dot y    →  POS_H − round(br*posScale)  for br≥0
//                          POS_H + 1 + round(|br|*negScale) for br<0
//   Segment: length=√(dx²+dy²), angle=atan2(dy,dx), View centered at midpoint
//
const LINE_COLOR   = '#5bb8d4';   // steel-blue line — distinct from amber bars
const Y_AXIS_W     = 32;
const GROUP_SLOT   = 36;          // 5 margin + 26 content + 5 margin
const GROUP_CENTER = 18;          // 5 margin + 13 (half of 26 content)

function ReturnChart({ annual, bLabel }) {
  const [showLine, setShowLine] = useState(true);

  if (!annual.length) return null;

  const allVals  = annual.flatMap(a => [a.return_pct || 0, a.benchmark_return_pct || 0]);
  const maxPos   = Math.max(...allVals, 5);
  const maxNeg   = Math.abs(Math.min(...allVals, 0));
  const POS_H    = 80;
  const NEG_H    = maxNeg > 0 ? Math.max(24, Math.round(POS_H * maxNeg / maxPos)) : 0;
  const posScale = POS_H / maxPos;
  const negScale = maxNeg > 0 ? NEG_H / maxNeg : 1;
  const CHART_H  = POS_H + 1 + NEG_H;

  // Pixel coords for benchmark line points
  const pts = annual.map((a, i) => {
    const br = a.benchmark_return_pct || 0;
    return {
      x: Y_AXIS_W + GROUP_CENTER + i * GROUP_SLOT,
      y: br >= 0
        ? POS_H - Math.round(br * posScale)
        : POS_H + 1 + Math.round(Math.abs(br) * negScale),
      br,
    };
  });

  // Diagonal line segments between consecutive points
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    segs.push({
      cx:  (p1.x + p2.x) / 2,
      cy:  (p1.y + p2.y) / 2,
      len: Math.sqrt(dx * dx + dy * dy),
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
    });
  }

  const totalW = Y_AXIS_W + annual.length * GROUP_SLOT;
  const bmkBarOpacity = showLine ? 0.30 : 1; // dim bars when line is visible

  return (
    <View style={s.chartContainer}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>

          {/* Y-axis labels */}
          <View style={{ width: Y_AXIS_W, height: CHART_H }}>
            <Text style={s.yLabel}>{Math.round(maxPos)}%</Text>
            <View style={{ flex: 1 }} />
            <Text style={s.yLabel}>0%</Text>
            {NEG_H > 0 && (
              <>
                <View style={{ height: NEG_H }} />
                <Text style={s.yLabel}>-{Math.round(maxNeg)}%</Text>
              </>
            )}
          </View>

          {/* Bars */}
          {annual.map((a) => {
            const fr = a.return_pct || 0;
            const br = a.benchmark_return_pct || 0;
            return (
              <View key={a.year} style={s.barGroup}>
                {/* Positive area — bars grow upward from bottom */}
                <View style={[s.posArea, { height: POS_H }]}>
                  {/* fund bar */}
                  <View style={{ alignItems: 'center' }}>
                    {fr > 0 && (
                      <Text style={[s.barLabel, { color: '#1a7f40' }]}>
                        {fr.toFixed(0)}
                      </Text>
                    )}
                    <View style={[s.bar, {
                      height: fr > 0 ? Math.round(fr * posScale) : 0,
                      backgroundColor: '#1a7f40',
                    }]} />
                  </View>
                  {/* benchmark bar (dims when line is visible) */}
                  <View style={{ alignItems: 'center', opacity: bmkBarOpacity }}>
                    {br > 0 && !showLine && (
                      <Text style={[s.barLabel, { color: '#c87a0d' }]}>
                        {br.toFixed(0)}
                      </Text>
                    )}
                    <View style={[s.bar, {
                      height: br > 0 ? Math.round(br * posScale) : 0,
                      backgroundColor: '#c87a0d',
                    }]} />
                  </View>
                </View>

                {/* Zero line */}
                <View style={s.zeroLine} />

                {/* Negative area — bars grow downward from top */}
                {NEG_H > 0 && (
                  <View style={[s.negArea, { height: NEG_H }]}>
                    <View style={[s.bar, {
                      height: fr < 0 ? Math.round(Math.abs(fr) * negScale) : 0,
                      backgroundColor: '#cc3333',
                    }]} />
                    <View style={[s.bar, {
                      height: br < 0 ? Math.round(Math.abs(br) * negScale) : 0,
                      backgroundColor: '#c87a0d',
                      opacity: bmkBarOpacity * 0.65,
                    }]} />
                  </View>
                )}

                {/* Year label */}
                <Text style={s.xLabel}>{String(a.year).slice(2)}</Text>
              </View>
            );
          })}

          {/* ── Benchmark line overlay (absolute, non-interactive) ── */}
          {showLine && pts.length > 0 && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0, top: 0,
                width: totalW, height: CHART_H,
              }}
            >
              {/* Line segments */}
              {segs.map((seg, i) => (
                <View
                  key={'seg' + i}
                  style={{
                    position: 'absolute',
                    left:  seg.cx - seg.len / 2,
                    top:   seg.cy - 1,
                    width: seg.len,
                    height: 2.5,
                    backgroundColor: LINE_COLOR,
                    transform: [{ rotate: seg.angle + 'deg' }],
                    opacity: 0.92,
                  }}
                />
              ))}
              {/* Dots at each data point */}
              {pts.map((p, i) => (
                <View
                  key={'dot' + i}
                  style={{
                    position: 'absolute',
                    left: p.x - 4,
                    top:  p.y - 4,
                    width: 8, height: 8,
                    borderRadius: 4,
                    backgroundColor: LINE_COLOR,
                    borderWidth: 1.5,
                    borderColor: '#fff',
                  }}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Legend + line toggle */}
      <View style={s.chartLegend}>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: '#1a7f40' }]} />
          <Text style={s.legendText}>Fund +</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: '#cc3333' }]} />
          <Text style={s.legendText}>Fund −</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: '#c87a0d' }]} />
          <Text style={s.legendText}>{bLabel}</Text>
        </View>

        {/* Toggleable line pill */}
        <TouchableOpacity
          onPress={() => { haptics.onToggle(); setShowLine(v => !v); }}
          style={[s.legendLinePill, showLine && s.legendLinePillOn]}
          activeOpacity={0.7}
        >
          {/* Mini line + dot icon */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <View style={{ width: 10, height: 2, backgroundColor: showLine ? LINE_COLOR : '#aaa', borderRadius: 1 }} />
            <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: showLine ? LINE_COLOR : '#aaa' }} />
          </View>
          <Text style={[s.legendText, { color: showLine ? LINE_COLOR : '#aaa', marginLeft: 4 }]}>
            {bLabel} line
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* ── Annual performance panel (table + chart) for one fund/account ── */
function AnnualPerfTable({ fid }) {
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [annual, setAnnual] = useState([]);
  const [bLabel, setBLabel] = useState('Benchmark');
  const [period, setPeriod] = useState('all');
  const [view,   setView]   = useState('table'); // 'table' | 'chart'

  const load = async () => {
    setState('loading');
    try {
      const r = await v2Fetch(`/api/fund/${encodeURIComponent(fid)}/balance-history`);
      const d = await r.json();
      if (!d.ok || !d.annual?.length) { setState('done'); return; }
      let rows = d.annual || [];
      if (d.period === '5yr') rows = rows.slice(-5);
      else if (d.period === '3yr') rows = rows.slice(-3);
      setAnnual(rows);
      setBLabel(d.benchmark_label || 'Benchmark');
      setPeriod(d.period || 'all');
      setState('done');
    } catch {
      setState('error');
    }
  };

  if (state === 'idle') {
    return (
      <TouchableOpacity onPress={load} style={s.atpBtn}>
        <Text style={s.atpBtnText}>📊  Annual Performance</Text>
      </TouchableOpacity>
    );
  }
  if (state === 'loading') {
    return (
      <View style={s.atpLoading}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={s.atpLoadingText}>Loading performance…</Text>
      </View>
    );
  }
  if (state === 'error') {
    return <Text style={s.atpError}>Could not load performance data.</Text>;
  }
  if (!annual.length) {
    return <Text style={s.atpError}>No historical data available yet.</Text>;
  }

  // Compute cumulative & CAGR for summary row
  let cumPort = 1, cumBmark = 1;
  annual.forEach(a => {
    cumPort  *= (1 + (a.return_pct || 0) / 100);
    cumBmark *= (1 + (a.benchmark_return_pct || 0) / 100);
  });
  const n             = annual.length;
  const totalCumPort  = (cumPort  - 1) * 100;
  const totalCumBmark = (cumBmark - 1) * 100;
  const cagrPort      = (Math.pow(cumPort,  1 / n) - 1) * 100;
  const cagrBmark     = (Math.pow(cumBmark, 1 / n) - 1) * 100;
  const totalAlpha    = totalCumPort - totalCumBmark;
  const totalNet      = annual.reduce((s, a) => s + ((a.deposits || 0) - (a.withdrawals || 0)), 0);
  const periodLabel   = period === '3yr' ? '3-Year' : period === '5yr' ? '5-Year' : 'All-Time';

  return (
    <View style={s.atpWrap}>
      {/* Header + view toggle */}
      <View style={s.atpTopRow}>
        <View>
          <Text style={s.atpTitle}>ANNUAL PERFORMANCE</Text>
          <Text style={s.atpSubtitle}>{periodLabel} · vs {bLabel}</Text>
        </View>
        <View style={s.atpToggle}>
          <TouchableOpacity
            onPress={() => setView('table')}
            style={[s.atpTab, view === 'table' && s.atpTabActive]}
          >
            <Text style={[s.atpTabText, view === 'table' && s.atpTabTextActive]}>TABLE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setView('chart')}
            style={[s.atpTab, view === 'chart' && s.atpTabActive]}
          >
            <Text style={[s.atpTabText, view === 'chart' && s.atpTabTextActive]}>CHART</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── TABLE VIEW ─────────────────────────────────────────────── */}
      {view === 'table' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[s.atpRow, s.atpHeadRow]}>
              <Text style={[s.atpCell, s.atpColYear, s.atpHeadText]}>YEAR</Text>
              <Text style={[s.atpCell, s.atpColRet,  s.atpHeadText]}>RETURN</Text>
              <Text style={[s.atpCell, s.atpColBmk,  s.atpHeadText]}>{bLabel.toUpperCase().slice(0, 8)}</Text>
              <Text style={[s.atpCell, s.atpColAlph, s.atpHeadText]}>ALPHA</Text>
              <Text style={[s.atpCell, s.atpColFlow, s.atpHeadText]}>NET FLOWS</Text>
            </View>

            {annual.map((a, i) => {
              const net    = (a.deposits || 0) - (a.withdrawals || 0);
              const netStr = net === 0 ? '—'
                : (net > 0 ? '+' : '') + fmtUSD(Math.abs(net)) + (net < 0 ? ' out' : '');
              return (
                <View key={a.year} style={[s.atpRow, i % 2 === 1 && s.atpRowAlt]}>
                  <Text style={[s.atpCell, s.atpColYear, s.atpYearText]}>{a.year}</Text>
                  <Text style={[s.atpCell, s.atpColRet, { color: pctColor(a.return_pct), fontWeight: '700' }]}>
                    {fmtPct(a.return_pct)}
                  </Text>
                  <Text style={[s.atpCell, s.atpColBmk, { color: '#b45309' }]}>
                    {fmtPct(a.benchmark_return_pct)}
                  </Text>
                  <Text style={[s.atpCell, s.atpColAlph, { color: pctColor(a.alpha), fontWeight: '700' }]}>
                    {fmtPct(a.alpha)}
                  </Text>
                  <Text style={[s.atpCell, s.atpColFlow, { color: '#888', fontSize: 10 }]}>
                    {netStr}
                  </Text>
                </View>
              );
            })}

            {/* Summary row */}
            <View style={[s.atpRow, s.atpSummaryRow]}>
              <Text style={[s.atpCell, s.atpColYear, s.atpSummaryLabel]}>{n}YR</Text>
              <View style={[s.atpCell, s.atpColRet]}>
                <Text style={{ color: pctColor(totalCumPort), fontWeight: '800', fontSize: 10 }}>
                  {fmtPct(totalCumPort, 1)}
                </Text>
                <Text style={{ color: pctColor(cagrPort), fontSize: 9 }}>
                  {fmtPct(cagrPort, 1)} CAGR
                </Text>
              </View>
              <View style={[s.atpCell, s.atpColBmk]}>
                <Text style={{ color: '#b45309', fontWeight: '800', fontSize: 10 }}>
                  {fmtPct(totalCumBmark, 1)}
                </Text>
                <Text style={{ color: '#b45309', fontSize: 9 }}>
                  {fmtPct(cagrBmark, 1)} CAGR
                </Text>
              </View>
              <Text style={[s.atpCell, s.atpColAlph, { color: pctColor(totalAlpha), fontWeight: '800', fontSize: 10 }]}>
                {fmtPct(totalAlpha, 1)}
              </Text>
              <Text style={[s.atpCell, s.atpColFlow, { color: '#888', fontSize: 10 }]}>
                {totalNet === 0 ? '—'
                  : (totalNet > 0 ? '+' : '') + fmtUSD(Math.abs(totalNet)) + (totalNet < 0 ? ' out' : '')}
              </Text>
            </View>
          </View>
        </ScrollView>
      )}

      {/* ── CHART VIEW ─────────────────────────────────────────────── */}
      {view === 'chart' && (
        <ReturnChart annual={annual} bLabel={bLabel} />
      )}
    </View>
  );
}

/* ── Main screen ──────────────────────────────────────────────────── */
export default function LPPerformanceScreen({ onLogout, isDemo, onSwitchToAdmin }) {
  const [data, setData]             = useState(null);
  const [me,   setMe]               = useState(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [user, resp] = await Promise.all([
        getV2User(),
        v2Fetch('/api/v2/lp/me/overview'),
      ]);
      setMe(user);
      if (!resp.ok) throw new Error('overview ' + resp.status);
      const json = await resp.json();
      setData(json);
    } catch (err) {
      setError(err?.message || 'Could not load your portfolio.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    haptics.onPressTab?.();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleLogout = async () => {
    await logoutV2();
    onLogout?.();
  };

  const funds           = data?.funds            || [];
  const accts           = data?.managed_accounts || [];
  const firstName       = (me?.name || '').split(/\s+/)[0] || 'there';
  const isEmpty         = funds.length === 0 && accts.length === 0;
  // Use stake_value (LP's prorated net-of-carry share) — matches web hero card
  const totalFundStakes = funds.reduce((s, f) => s + (f.stake_value || 0), 0);
  const totalAcctNav    = accts.reduce((s, a) => s + (a.nav || 0), 0);
  const totalPortfolio  = totalFundStakes + totalAcctNav;

  return (
    <View style={styles.container}>
      <AppHeader
        title="Performance"
        right={
          <TouchableOpacity onPress={handleLogout} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.logoutText}>LOGOUT</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={styles.scroll}
      >
        {loading && !data && (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.loadingText}>Loading your portfolio…</Text>
          </View>
        )}

        {error && (
          <View style={styles.errorWrap}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={load} style={styles.retryBtn}>
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Demo mode banner */}
        {isDemo && (
          <View style={styles.demoBanner}>
            <Text style={styles.demoBannerText}>
              🎭 Demo Mode · Investor identities anonymised · Read-only
            </Text>
            {onSwitchToAdmin && (
              <TouchableOpacity style={styles.demoAdminBtn} onPress={onSwitchToAdmin} activeOpacity={0.8}>
                <Text style={styles.demoAdminBtnText}>⚙️  Switch to Admin View</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {data && (
          <>
            {/* Hero card */}
            <View style={styles.heroCard}>
              <Text style={styles.heroEyebrow}>
                DGA Capital · {me?.role === 'gp' ? 'GP Overview' : 'Your Portfolio'}
              </Text>
              <Text style={styles.heroTitle}>Welcome back, {firstName}</Text>

              {isEmpty ? (
                <Text style={styles.heroSub}>
                  We don't have any DGA Capital funds or managed accounts linked to your login{' '}
                  ({me?.email}) yet. Once the GP assigns one, it will appear here. Reach out to{' '}
                  alecmazo1@gmail.com with any questions.
                </Text>
              ) : (
                <>
                  <Text style={styles.heroSub}>
                    {funds.length > 0 && `${funds.length} fund${funds.length > 1 ? 's' : ''}`}
                    {funds.length > 0 && accts.length > 0 && ' + '}
                    {accts.length > 0 && `${accts.length} managed account${accts.length > 1 ? 's' : ''}`}
                  </Text>

                  {/* Total portfolio — big number */}
                  <View style={styles.heroTotalRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.heroTotalLabel}>YOUR TOTAL PORTFOLIO</Text>
                      <Text style={styles.heroTotalVal}>
                        {totalPortfolio > 0 ? fmtUSD(totalPortfolio) : '—'}
                      </Text>
                      <Text style={styles.heroTotalSub}>
                        equity stakes net of carry{accts.length ? ' + managed accounts' : ''}
                      </Text>
                    </View>
                  </View>

                  {/* Breakdown tiles */}
                  {(funds.length > 0 || accts.length > 0) && (
                    <View style={styles.heroTiles}>
                      {funds.length > 0 && (
                        <View style={styles.heroTile}>
                          <Text style={styles.heroTileLabel}>FUND STAKES (TOTAL)</Text>
                          <Text style={styles.heroTileVal}>
                            {totalFundStakes > 0 ? fmtUSD(totalFundStakes) : '—'}
                          </Text>
                          {funds.reduce((s, f) => s + (f.commitment || 0), 0) > 0 && (
                            <Text style={styles.heroTileSub}>
                              Commitment {fmtUSD(funds.reduce((s, f) => s + (f.commitment || 0), 0))}
                            </Text>
                          )}
                        </View>
                      )}
                      {accts.length > 0 && (
                        <View style={styles.heroTile}>
                          <Text style={styles.heroTileLabel}>MANAGED ACCT NAV</Text>
                          <Text style={styles.heroTileVal}>
                            {totalAcctNav > 0 ? fmtUSD(totalAcctNav) : '—'}
                          </Text>
                          <Text style={styles.heroTileSub}>
                            {accts.length} managed account{accts.length !== 1 ? 's' : ''}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>

            {/* Per-fund cards */}
            {funds.map(f => (
              <View key={f.fund_id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{f.fund_name}</Text>
                  <Text style={styles.cardBadge}>{f.short_name}</Text>
                </View>
                {f.lp_alias && (
                  <Text style={styles.cardAlias}>
                    Your alias · <Text style={styles.cardAliasValue}>{f.lp_alias}</Text>
                  </Text>
                )}
                {/* YOUR CURRENT STAKE — top, emphasized, full width */}
                <View style={styles.cardStatStake}>
                  <Text style={styles.cardStatLabel}>YOUR CURRENT STAKE</Text>
                  <Text style={styles.cardStatStakeVal}>
                    {f.stake_value != null ? fmtUSD(f.stake_value) : '—'}
                  </Text>
                  <Text style={styles.cardStatSub}>
                    {f.commitment && f.total_committed
                      ? `${((f.commitment / f.total_committed) * 100).toFixed(1)}% of fund · `
                      : ''}
                    {f.market_nav ? 'Live market value · net of carry'
                      : f.fund_nav ? 'Annual snapshot · net of carry'
                      : 'Net of carry'}
                  </Text>
                </View>

                {/* FUND NAV + COMMITMENT — second row, two columns */}
                <View style={[styles.cardStats, { marginTop: 8 }]}>
                  <View style={styles.cardStat}>
                    <Text style={styles.cardStatLabel}>FUND NAV (TOTAL)</Text>
                    <Text style={styles.cardStatVal}>
                      {f.effective_nav != null ? fmtUSD(f.effective_nav)
                        : f.fund_nav != null ? fmtUSD(f.fund_nav) : '—'}
                    </Text>
                    <Text style={styles.cardStatSub}>
                      {f.market_nav ? 'Live from positions'
                        : f.fund_nav_as_of ? `as of ${f.fund_nav_as_of}`
                        : 'No snapshot yet'}
                    </Text>
                  </View>
                  <View style={styles.cardStat}>
                    <Text style={styles.cardStatLabel}>YOUR COMMITMENT</Text>
                    <Text style={styles.cardStatVal}>{f.commitment ? fmtUSD(f.commitment) : '—'}</Text>
                    <Text style={styles.cardStatSub}>
                      {f.lp_count} LP{f.lp_count !== 1 ? 's' : ''} in fund
                      {f.total_committed ? ` · ${fmtUSD(f.total_committed)} total raised` : ''}
                    </Text>
                  </View>
                </View>
                <AnnualPerfTable key={f.fund_id + '-atp'} fid={f.fund_id} />
              </View>
            ))}

            {/* Per-managed-account cards */}
            {accts.map(a => (
              <View key={a.fund_id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{a.account_name}</Text>
                  <Text style={styles.cardBadge}>MANAGED · {a.short_name}</Text>
                </View>
                <View style={styles.cardStats}>
                  <View style={styles.cardStat}>
                    <Text style={styles.cardStatLabel}>ACCOUNT NAV</Text>
                    <Text style={styles.cardStatVal}>{a.nav != null ? fmtUSD(a.nav) : '—'}</Text>
                    <Text style={styles.cardStatSub}>
                      {a.nav_as_of ? `as of ${a.nav_as_of}` : 'No snapshot yet'}
                    </Text>
                  </View>
                  {a.ytd_pct != null && (
                    <View style={styles.cardStat}>
                      <Text style={styles.cardStatLabel}>YTD RETURN</Text>
                      <Text style={[styles.cardStatVal, { color: pctColor(a.ytd_pct) }]}>
                        {fmtPct(a.ytd_pct)}
                      </Text>
                      <Text style={styles.cardStatSub}>year to date</Text>
                    </View>
                  )}
                </View>
                <AnnualPerfTable key={a.fund_id + '-atp'} fid={a.fund_id} />
              </View>
            ))}

            <Text style={styles.footnote}>
              Detailed capital account activity, NAV history, and quarterly statements will appear
              here as they're published.{'\n'}
              Tax docs (K-1) are sent at year-end.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/* ── Styles ───────────────────────────────────────────────────────── */
const s = StyleSheet.create({
  /* Annual perf button (idle) */
  atpBtn: {
    marginTop: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(91,184,212,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(91,184,212,0.28)',
    borderRadius: 8,
    alignItems: 'center',
  },
  atpBtnText: {
    color: colors.navy,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  atpLoading: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  atpLoadingText: { fontSize: 11, color: colors.midGray },
  atpError:       { marginTop: 10, fontSize: 11, color: '#cc3333', fontStyle: 'italic' },

  /* Expanded panel wrapper */
  atpWrap: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.07)',
    paddingTop: 10,
  },

  /* Header row: title + TABLE|CHART toggle */
  atpTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  atpTitle: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.navy,
    letterSpacing: 1.1,
  },
  atpSubtitle: { fontSize: 9, color: colors.midGray, marginTop: 1 },

  /* Toggle tabs */
  atpToggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  atpTab: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'transparent',
  },
  atpTabActive:     { backgroundColor: colors.navy },
  atpTabText:       { fontSize: 9, fontWeight: '800', color: colors.midGray, letterSpacing: 0.7 },
  atpTabTextActive: { color: '#fff' },

  /* Table */
  atpRow:        { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  atpHeadRow:    { borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.08)', paddingBottom: 4 },
  atpRowAlt:     { backgroundColor: 'rgba(0,0,0,0.02)' },
  atpSummaryRow: { borderTopWidth: 2, borderTopColor: 'rgba(0,0,0,0.12)', marginTop: 2, paddingTop: 6 },

  atpCell:     { paddingHorizontal: 5, fontSize: 11 },
  atpColYear:  { width: 42 },
  atpColRet:   { width: 64, textAlign: 'right' },
  atpColBmk:   { width: 64, textAlign: 'right' },
  atpColAlph:  { width: 60, textAlign: 'right' },
  atpColFlow:  { width: 88, textAlign: 'right' },

  atpHeadText:     { fontSize: 8, fontWeight: '800', color: colors.midGray, letterSpacing: 0.8 },
  atpYearText:     { fontWeight: '700', color: colors.navy },
  atpSummaryLabel: { fontWeight: '800', fontSize: 10, color: colors.navy },

  /* Chart (pure View — no SVG) */
  chartContainer: { marginTop: 6, overflow: 'hidden' },

  barGroup: { alignItems: 'center', marginHorizontal: 5 },

  /* Positive bars sit at the bottom of posArea */
  posArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 3,
  },
  /* Negative bars sit at the top of negArea */
  negArea: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 3,
  },

  bar:      { width: 11, minHeight: 0 },
  barLabel: { fontSize: 7, fontWeight: '700', marginBottom: 1, textAlign: 'center' },
  zeroLine: { height: 1, width: 26, backgroundColor: 'rgba(0,0,0,0.18)' },
  xLabel:   { fontSize: 8, color: '#666', marginTop: 4, textAlign: 'center' },

  yLabel: { fontSize: 8, color: '#aaa', textAlign: 'right' },

  chartLegend: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 10,
    paddingLeft: 2,
    flexWrap: 'wrap',
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot:  { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 9, color: colors.midGray, fontWeight: '600' },

  legendLinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: 'transparent',
  },
  legendLinePillOn: {
    borderColor: 'rgba(91,184,212,0.45)',
    backgroundColor: 'rgba(91,184,212,0.10)',
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  scroll:    { padding: 14, paddingBottom: 40 },

  logoutText: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },

  loadingWrap: { padding: 30, alignItems: 'center' },
  loadingText: { color: colors.midGray, fontSize: 12, marginTop: 10 },

  errorWrap: {
    backgroundColor: '#fee', padding: 16, borderRadius: 10,
    alignItems: 'center', margin: 14,
  },
  errorText: { color: colors.red, fontSize: 13, textAlign: 'center', marginBottom: 10 },
  retryBtn: {
    paddingHorizontal: 18, paddingVertical: 8,
    backgroundColor: colors.navy, borderRadius: 6,
  },
  retryText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },

  heroCard: {
    backgroundColor: colors.navy,
    borderRadius: 12,
    padding: 18,
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.30)',
    marginBottom: 14,
  },
  heroEyebrow: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  heroTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  heroSub: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 14,
  },
  // Hero total portfolio row
  heroTotalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 10,
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(91,184,212,0.18)',
  },
  heroTotalLabel: {
    color: colors.primary,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  heroTotalVal: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
    marginBottom: 3,
  },
  heroTotalSub: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: 9,
  },

  heroTiles: { flexDirection: 'row', gap: 10, marginTop: 0 },
  heroTile: {
    flex: 1,
    backgroundColor: 'rgba(91,184,212,0.10)',
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.20)',
    borderRadius: 9,
    padding: 11,
  },
  heroTileLabel: {
    color: colors.primary,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  heroTileVal: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  heroTileSub: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 9,
    marginTop: 2,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)',
  },
  cardHead:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  cardTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    color: colors.navy,
    letterSpacing: 0.4,
  },
  cardBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.primary,
    backgroundColor: colors.navy,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 9,
    letterSpacing: 0.5,
    overflow: 'hidden',
  },
  cardAlias:      { fontSize: 10, color: colors.midGray, letterSpacing: 0.6, marginBottom: 8 },
  cardAliasValue: { color: colors.primaryDark, fontWeight: '800' },

  cardStats: { flexDirection: 'row', gap: 10 },
  cardStat: {
    flex: 1,
    backgroundColor: colors.offWhite,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1, borderColor: colors.lightGray,
  },
  cardStatLabel: {
    fontSize: 8,
    fontWeight: '800',
    color: colors.midGray,
    letterSpacing: 1.0,
  },
  cardStatVal: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.navy,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  cardStatSub: { fontSize: 9, color: colors.midGray, marginTop: 2 },

  // YOUR CURRENT STAKE — full-width highlighted tile at top of fund card
  cardStatStake: {
    backgroundColor: 'rgba(91,184,212,0.07)',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(91,184,212,0.22)',
  },
  cardStatStakeVal: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.navy,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.3,
  },

  footnote: {
    fontSize: 11,
    color: colors.midGray,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 20,
    lineHeight: 16,
    fontStyle: 'italic',
  },

  // ── Demo Mode ──
  demoBanner: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 10,
    alignItems: 'center',
  },
  demoBannerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  demoAdminBtn: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 20,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  demoAdminBtnText: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '800',
  },
});
