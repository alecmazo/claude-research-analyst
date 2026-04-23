/**
 * PortfolioSummaryScreen
 * Shows the Grok-generated portfolio narrative (markdown) for the last
 * completed rebalance run.  Navigated to from PortfolioScreen's
 * "Last Portfolio Run" card via navigation.push('PortfolioSummary').
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import { colors } from '../components/theme';

export default function PortfolioSummaryScreen({ navigation }) {
  const [info, setInfo]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    api.getPortfolioSummary()
      .then(data => setInfo(data))
      .catch(e  => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const formatDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  };

  return (
    <View style={styles.wrapper}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Portfolio Summary</Text>
        <View style={{ width: 38 }} />
      </View>

      {info?.generated_at && (
        <Text style={styles.generatedAt}>
          Generated {formatDate(info.generated_at)}
        </Text>
      )}

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.gold} />
          <Text style={styles.loadingText}>Loading summary…</Text>
        </View>
      )}

      {!loading && error && (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Markdown style={mdStyles}>
            {info?.summary_md || '_No portfolio summary available yet._'}
          </Markdown>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.offWhite },

  header: {
    backgroundColor: colors.navy,
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.navyLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  generatedAt: {
    fontSize: 11,
    color: colors.midGray,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightGray,
  },

  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    color: colors.midGray,
    marginTop: 12,
    fontSize: 14,
  },
  errorText: {
    color: colors.red,
    marginTop: 12,
    textAlign: 'center',
    fontSize: 14,
  },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },
});

const mdStyles = {
  body:     { color: colors.darkGray, fontSize: 14, lineHeight: 22 },
  heading1: { color: colors.navy, fontSize: 22, fontWeight: '700', marginTop: 24, marginBottom: 8 },
  heading2: { color: colors.navy, fontSize: 18, fontWeight: '700', marginTop: 20, marginBottom: 6 },
  heading3: { color: colors.darkGray, fontSize: 16, fontWeight: '600', marginTop: 14, marginBottom: 4 },
  strong:   { fontWeight: '700', color: colors.navy },
  em:       { fontStyle: 'italic' },
  blockquote: {
    backgroundColor: '#EEF2F8',
    borderLeftWidth: 3,
    borderLeftColor: colors.gold,
    paddingLeft: 12,
    paddingVertical: 8,
    marginVertical: 8,
    borderRadius: 4,
  },
  code_inline: {
    backgroundColor: colors.lightGray,
    color: colors.navy,
    fontFamily: 'Courier New',
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  table:  { borderWidth: 1, borderColor: colors.lightGray, borderRadius: 4, marginVertical: 12 },
  thead:  { backgroundColor: colors.navy },
  th:     { color: colors.white, fontWeight: '700', padding: 8, fontSize: 12 },
  td:     { color: colors.darkGray, padding: 8, fontSize: 12, borderTopWidth: 1, borderColor: colors.lightGray },
};
