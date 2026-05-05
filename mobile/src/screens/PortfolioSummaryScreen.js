/**
 * PortfolioSummaryScreen
 * Shows the Grok-generated portfolio narrative (markdown) for the last
 * completed rebalance run.  Navigated to from PortfolioScreen's
 * "Last Portfolio Run" card via navigation.push('PortfolioSummary').
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import AppHeader, { BackButton } from '../components/AppHeader';
import {
  colors, mdStyles, formatDate, haptics,
  MarkdownTOC, TOCToggle, extractHeadings,
} from '../design';

const LINE_PX = 22;

export default function PortfolioSummaryScreen({ navigation }) {
  const [info, setInfo]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  const [tocOpen, setTocOpen] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.getPortfolioSummary()
      .then(data => setInfo(data))
      .catch(e  => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSelectHeading = (h) => {
    const offset = Math.max(0, h.lineIndex * LINE_PX - 8);
    scrollRef.current?.scrollTo({ y: offset, animated: true });
  };

  const handleScroll = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    if (y > 600 && !showBackToTop) setShowBackToTop(true);
    else if (y <= 600 && showBackToTop) setShowBackToTop(false);
  };

  const scrollToTop = () => {
    haptics.onPressTab();
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const headingsCount = extractHeadings(info?.summary_md || '').filter(h => h.level === 2).length;

  return (
    <View style={styles.wrapper}>
      <AppHeader
        title="Portfolio Summary"
        showLogo={false}
        left={<BackButton onPress={() => navigation.goBack()} />}
        subtitle={info?.generated_at ? `Generated ${formatDate(info.generated_at)}` : null}
        right={
          headingsCount > 1 && (
            <TOCToggle open={tocOpen} onToggle={() => setTocOpen(o => !o)} />
          )
        }
      />

      <MarkdownTOC
        markdown={info?.summary_md}
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        onSelect={handleSelectHeading}
      />

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
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={64}
        >
          <Markdown style={mdStyles}>
            {info?.summary_md || '_No portfolio summary available yet._'}
          </Markdown>
        </ScrollView>
      )}

      {showBackToTop && (
        <TouchableOpacity onPress={scrollToTop} style={styles.backToTop} activeOpacity={0.8}>
          <Ionicons name="arrow-up" size={20} color={colors.navy} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper:    { flex: 1, backgroundColor: colors.offWhite },
  centered:   { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText:{ marginTop: 12, color: colors.midGray, fontSize: 13 },
  errorText:  { color: colors.red, marginTop: 12, textAlign: 'center', fontSize: 14 },
  scroll:     { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 60 },
  backToTop: {
    position: 'absolute',
    right: 16, bottom: 24,
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.gold,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.20,
    shadowRadius: 8,
    elevation: 6,
  },
});
