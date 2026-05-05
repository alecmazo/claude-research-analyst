import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  TouchableOpacity, Share, Linking, Alert, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import AppHeader, { BackButton } from '../components/AppHeader';
import {
  colors, mdStylesReport, formatDate, haptics,
  MarkdownTOC, TOCToggle, extractHeadings,
} from '../design';

// Approximate vertical pixels per markdown line — used for TOC scroll.
// Tuned by spot-checking real reports; anchors land within ~1 viewport
// of the actual heading without any DOM-style measurement.
const LINE_PX = 22;

export default function ReportScreen({ route, navigation }) {
  const { ticker } = route.params;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── TOC state ──
  const [tocOpen, setTocOpen] = useState(false);
  const scrollRef = useRef(null);

  // ── "Back to top" floating button visibility ──
  const [showBackToTop, setShowBackToTop] = useState(false);

  // ── Data load + refresh ──────────────────────────────────────────────────
  const loadAll = async () => {
    setError(null);
    try {
      const r = await api.getReport(ticker);
      setReport(r);
    } catch (e) {
      setError(e.message);
    }
    try { setQuote(await api.getQuote(ticker)); } catch {}
  };

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [ticker]);

  const onRefresh = async () => {
    setRefreshing(true);
    haptics.onPressTab();
    await loadAll();
    setRefreshing(false);
  };

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleShare = async () => {
    if (!report) return;
    haptics.onPressPrimary();
    await Share.share({
      message: `DGA Research Report — ${ticker}\n\n${report.report_md.slice(0, 2000)}…`,
    });
  };

  const handleDownload = async (type) => {
    haptics.onPressPrimary();
    try {
      const url = await api.downloadUrl(ticker, type);
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Cannot open', `URL not supported: ${url}`);
      }
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const handleViewGamma = () => {
    if (!report?.gamma_url) return;
    haptics.onPressPrimary();
    Linking.openURL(report.gamma_url);
  };

  // ── TOC scroll-to-heading ────────────────────────────────────────────────
  // RN doesn't expose layout offsets for inline markdown nodes, so we
  // approximate: count lines from the top of the doc to the heading,
  // multiply by a measured line-height. Lands within a viewport of the
  // actual heading on real reports — more than good enough for navigation.
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

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.wrapper}>
        <AppHeader
          title={ticker}
          showLogo={false}
          left={<BackButton onPress={() => navigation.goBack()} />}
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.gold} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.wrapper}>
        <AppHeader
          title={ticker}
          showLogo={false}
          left={<BackButton onPress={() => navigation.goBack()} />}
        />
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </View>
    );
  }

  const headingsCount = extractHeadings(report?.report_md || '').filter(h => h.level === 2).length;

  // Subtitle row: price + change + generated-at
  const priceStr = quote?.price != null ? `$${Number(quote.price).toFixed(2)}` : null;
  const pct      = quote?.pct_change;
  const pctStr   = pct != null ? `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%` : null;
  const isUp     = pct != null && pct >= 0;

  return (
    <View style={styles.wrapper}>
      <AppHeader
        title={ticker}
        showLogo={false}
        left={<BackButton onPress={() => navigation.goBack()} />}
        right={
          <View style={styles.headerActions}>
            {headingsCount > 1 && (
              <TOCToggle open={tocOpen} onToggle={() => setTocOpen(o => !o)} />
            )}
            <TouchableOpacity onPress={handleShare} style={styles.iconBtn} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
              <Ionicons name="share-outline" size={18} color={colors.gold} />
            </TouchableOpacity>
            {report?.has_docx !== false && (
              <TouchableOpacity onPress={() => handleDownload('docx')} style={styles.iconBtn} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                <Ionicons name="document-outline" size={18} color={colors.gold} />
              </TouchableOpacity>
            )}
            {report?.has_pptx && (
              <TouchableOpacity onPress={() => handleDownload('pptx')} style={[styles.iconBtn, styles.iconBtnGold]} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                <Ionicons name="easel-outline" size={18} color={colors.navy} />
              </TouchableOpacity>
            )}
            {report?.gamma_url && (
              <TouchableOpacity onPress={handleViewGamma} style={[styles.iconBtn, styles.iconBtnGold]} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
                <Ionicons name="play-outline" size={18} color={colors.navy} />
              </TouchableOpacity>
            )}
          </View>
        }
      />

      {/* Sub-header with live price + generated-at */}
      <View style={styles.subBar}>
        <View style={styles.subBarLeft}>
          {priceStr && (
            <>
              <Text style={styles.subBarPrice}>{priceStr}</Text>
              {pctStr && (
                <Text style={[styles.subBarPct, isUp ? styles.pctUp : styles.pctDown]}>
                  {pctStr}
                </Text>
              )}
            </>
          )}
        </View>
        {report?.generated_at && (
          <Text style={styles.generatedAt}>
            {formatDate(report.generated_at)}
          </Text>
        )}
      </View>

      {/* TOC drawer */}
      <MarkdownTOC
        markdown={report?.report_md}
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        onSelect={handleSelectHeading}
      />

      {/* Body */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onScroll={handleScroll}
        scrollEventThrottle={64}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.gold}
          />
        }
      >
        <Markdown style={mdStylesReport}>
          {report?.report_md || ''}
        </Markdown>
      </ScrollView>

      {/* Floating "back to top" button */}
      {showBackToTop && (
        <TouchableOpacity
          onPress={scrollToTop}
          style={styles.backToTop}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-up" size={20} color={colors.navy} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.offWhite },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: colors.red, marginTop: 12, textAlign: 'center', fontSize: 14 },

  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: {
    backgroundColor: colors.navyLight,
    borderRadius: 8,
    width: 36, height: 36,
    justifyContent: 'center', alignItems: 'center',
  },
  iconBtnGold: { backgroundColor: colors.gold },

  // ── Sub-bar with live price + generated-at ──
  subBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: colors.white,
    borderBottomWidth: 1, borderBottomColor: colors.lightGray,
  },
  subBarLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  subBarPrice: {
    fontSize: 16, fontWeight: '800', color: colors.navy,
    fontFamily: 'Courier New',
  },
  subBarPct: {
    fontSize: 12, fontWeight: '700', fontFamily: 'Courier New',
  },
  pctUp:   { color: colors.green },
  pctDown: { color: colors.red },
  generatedAt: { fontSize: 11, color: colors.midGray },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 60 },

  // Floating "back to top" button (visible after scrolling > 600px)
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
