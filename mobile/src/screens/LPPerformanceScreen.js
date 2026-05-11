/**
 * LPPerformanceScreen — LP-only home tab.
 *
 * Mirrors the web LP dashboard: hero with fund summary, per-fund and
 * per-managed-account cards, all scoped to the authenticated LP via
 * /api/v2/lp/me/overview. GPs never see this screen — they get the
 * full 6-tab GP navigator.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { v2Fetch, getV2User, logoutV2 } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, haptics } from '../design';

function fmtUSD(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export default function LPPerformanceScreen({ onLogout }) {
  const [data, setData]         = useState(null);
  const [me, setMe]             = useState(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState(null);

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

  const funds = data?.funds || [];
  const accts = data?.managed_accounts || [];
  const firstName = (me?.name || '').split(/\s+/)[0] || 'there';
  const isEmpty = funds.length === 0 && accts.length === 0;
  const totalFundNav = funds.reduce((s, f) => s + (f.fund_nav || 0), 0);
  const totalAcctNav = accts.reduce((s, a) => s + (a.nav    || 0), 0);

  return (
    <View style={styles.container}>
      <AppHeader
        title="Performance"
        right={
          <TouchableOpacity onPress={handleLogout} hitSlop={{top:8,bottom:8,left:8,right:8}}>
            <Text style={styles.logoutText}>LOGOUT</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        contentContainerStyle={styles.scroll}
      >
        {loading && !data && (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.gold} />
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
                  <View style={styles.heroTiles}>
                    {funds.length > 0 && (
                      <View style={styles.heroTile}>
                        <Text style={styles.heroTileLabel}>FUND NAV (TOTAL)</Text>
                        <Text style={styles.heroTileVal}>{totalFundNav ? fmtUSD(totalFundNav) : '—'}</Text>
                      </View>
                    )}
                    {accts.length > 0 && (
                      <View style={styles.heroTile}>
                        <Text style={styles.heroTileLabel}>MANAGED ACCT NAV</Text>
                        <Text style={styles.heroTileVal}>{totalAcctNav ? fmtUSD(totalAcctNav) : '—'}</Text>
                      </View>
                    )}
                  </View>
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
                <View style={styles.cardStats}>
                  <View style={styles.cardStat}>
                    <Text style={styles.cardStatLabel}>FUND NAV</Text>
                    <Text style={styles.cardStatVal}>{f.fund_nav != null ? fmtUSD(f.fund_nav) : '—'}</Text>
                    <Text style={styles.cardStatSub}>
                      {f.fund_nav_as_of ? `as of ${f.fund_nav_as_of}` : 'No snapshot yet'}
                    </Text>
                  </View>
                  <View style={styles.cardStat}>
                    <Text style={styles.cardStatLabel}>YOUR COMMITMENT</Text>
                    <Text style={styles.cardStatVal}>{f.commitment ? fmtUSD(f.commitment) : '—'}</Text>
                    <Text style={styles.cardStatSub}>{f.lp_count} LP{f.lp_count !== 1 ? 's' : ''} in fund</Text>
                  </View>
                </View>
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
                </View>
              </View>
            ))}

            <Text style={styles.footnote}>
              Detailed capital account activity, NAV history, and quarterly statements will appear here
              as they're published.{'\n'}
              Tax docs (K-1) are sent at year-end.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  scroll:    { padding: 14, paddingBottom: 40 },

  logoutText: {
    color: colors.gold,
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
    color: colors.gold,
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
  heroTiles: { flexDirection: 'row', gap: 10, marginTop: 4 },
  heroTile: {
    flex: 1,
    backgroundColor: 'rgba(91,184,212,0.10)',
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.20)',
    borderRadius: 9,
    padding: 11,
  },
  heroTileLabel: {
    color: colors.gold,
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

  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
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
    color: colors.gold,
    backgroundColor: colors.navy,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 9,
    letterSpacing: 0.5,
    overflow: 'hidden',
  },
  cardAlias: { fontSize: 10, color: colors.midGray, letterSpacing: 0.6, marginBottom: 8 },
  cardAliasValue: { color: colors.goldDark, fontWeight: '800' },

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

  footnote: {
    fontSize: 11,
    color: colors.midGray,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 20,
    lineHeight: 16,
    fontStyle: 'italic',
  },
});
