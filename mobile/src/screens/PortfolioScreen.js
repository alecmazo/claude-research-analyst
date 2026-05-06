/**
 * PortfolioScreen — Live portfolio overview
 *
 * After the rebalance functionality moved to Fund → My Portfolio and
 * paper portfolios moved to Ideas, this screen shows:
 *   • A portal card pointing to Fund → My Portfolio for rebalance + YTD
 *   • A portal card pointing to Ideas → Paper Portfolios for tracked briefs
 *
 * The PortfolioSummary sub-screen (last Grok portfolio roll-up) is still
 * reachable via navigation.navigate('PortfolioSummary').
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import AppHeader from '../components/AppHeader';
import { colors, haptics, formatDate } from '../design';

export default function PortfolioScreen({ navigation }) {
  const [lastPortfolio, setLastPortfolio] = useState(null);

  useEffect(() => {
    // Show "View Summary" if a portfolio run exists
    api.getLastPortfolio().then(info => {
      if (info?.exists) setLastPortfolio(info);
    }).catch(() => {});
  }, []);

  const goToFundMyPortfolio = () => {
    haptics.onPressTab();
    navigation.getParent()?.navigate('Fund', { screen: 'FundHome', params: { openBranch: 'My Portfolio' } });
  };

  const goToIdeas = () => {
    haptics.onPressTab();
    navigation.getParent()?.navigate('Intelligence', { screen: 'PaperTracker' });
  };

  return (
    <View style={styles.wrapper}>
      <AppHeader title="Portfolio" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* Last portfolio summary card */}
        {lastPortfolio && (
          <View style={styles.card}>
            <Text style={styles.label}>LAST PORTFOLIO SUMMARY</Text>
            <Text style={styles.meta}>
              {formatDate(lastPortfolio.generated_at)}
            </Text>
            <TouchableOpacity
              style={styles.btn}
              onPress={() => navigation.navigate('PortfolioSummary')}
            >
              <Ionicons name="document-text-outline" size={16} color={colors.navy} style={{ marginRight: 6 }} />
              <Text style={styles.btnText}>View Summary →</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Run Rebalance portal → Fund / My Portfolio */}
        <TouchableOpacity style={styles.portalCard} onPress={goToFundMyPortfolio} activeOpacity={0.85}>
          <View style={styles.portalIconWrap}>
            <Ionicons name="swap-horizontal-outline" size={28} color={colors.gold} />
          </View>
          <View style={styles.portalBody}>
            <Text style={styles.portalTitle}>Run Rebalance</Text>
            <Text style={styles.portalDesc}>
              Upload your portfolio CSV, run the AI rebalance analysis,
              and download the optimized allocation — in Fund → My Portfolio.
            </Text>
            <Text style={styles.portalCta}>Open Fund → My Portfolio →</Text>
          </View>
        </TouchableOpacity>

        {/* Paper Portfolios portal → Ideas tab */}
        <TouchableOpacity style={styles.portalCard} onPress={goToIdeas} activeOpacity={0.85}>
          <View style={styles.portalIconWrap}>
            <Ionicons name="bookmark-outline" size={28} color={colors.gold} />
          </View>
          <View style={styles.portalBody}>
            <Text style={styles.portalTitle}>Paper Portfolios</Text>
            <Text style={styles.portalDesc}>
              Intelligence brief baskets tracked vs SPY and your live portfolio.
              Lock in any brief from the Ideas tab.
            </Text>
            <Text style={styles.portalCta}>Open Ideas → Paper Portfolios →</Text>
          </View>
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper:   { flex: 1, backgroundColor: colors.offWhite },
  container: { flex: 1 },
  content:   { padding: 16, paddingBottom: 40 },

  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginBottom: 6,
  },
  meta: { fontSize: 12, color: colors.midGray, marginBottom: 12 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  btnText: { color: colors.navy, fontWeight: '800', fontSize: 13 },

  portalCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
  },
  portalIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: 'rgba(201,168,76,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  portalBody: { flex: 1 },
  portalTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: 4,
  },
  portalDesc: {
    fontSize: 12,
    color: colors.midGray,
    lineHeight: 17,
    marginBottom: 8,
  },
  portalCta: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.gold,
  },
});
