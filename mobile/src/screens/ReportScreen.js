import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  TouchableOpacity, Share, Linking, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import { colors } from '../components/theme';

export default function ReportScreen({ route }) {
  const { ticker } = route.params;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    Promise.all([
      api.getReport(ticker).then(setReport).catch(e => setError(e.message)),
      api.getQuote(ticker).then(setQuote).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [ticker]);

  const handleShare = async () => {
    if (!report) return;
    await Share.share({ message: `DGA Research Report — ${ticker}\n\n${report.report_md.slice(0, 2000)}…` });
  };

  const handleDownload = async (type) => {
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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.gold} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.red} />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Sticky header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.ticker}>{ticker}</Text>
          {quote?.price && (
            <Text style={styles.price}>${quote.price.toFixed(2)}</Text>
          )}
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={handleShare}>
            <Ionicons name="share-outline" size={22} color={colors.white} />
          </TouchableOpacity>
          {report?.has_docx !== false && (
            <TouchableOpacity style={styles.iconBtn} onPress={() => handleDownload('docx')}>
              <Ionicons name="document-outline" size={22} color={colors.white} />
            </TouchableOpacity>
          )}
          {report?.has_pptx && (
            <TouchableOpacity style={[styles.iconBtn, styles.pptxBtn]} onPress={() => handleDownload('pptx')}>
              <Ionicons name="easel-outline" size={22} color={colors.navy} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {report?.generated_at && (
        <Text style={styles.generatedAt}>
          Generated {new Date(report.generated_at).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
          })}
        </Text>
      )}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Markdown style={markdownStyles}>
          {report?.report_md || ''}
        </Markdown>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: colors.red, marginTop: 12, textAlign: 'center', fontSize: 14 },
  header: {
    backgroundColor: colors.navy,
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  ticker: { color: colors.gold, fontSize: 24, fontWeight: '800', letterSpacing: 2 },
  price: { color: colors.white, fontSize: 15, marginTop: 2, fontWeight: '500' },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: {
    backgroundColor: colors.navyLight,
    borderRadius: 8,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pptxBtn: { backgroundColor: colors.gold },
  generatedAt: {
    fontSize: 11,
    color: colors.midGray,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightGray,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
});

const markdownStyles = {
  body: { color: colors.darkGray, fontSize: 14, lineHeight: 22 },
  heading1: { color: colors.navy, fontSize: 22, fontWeight: '700', marginTop: 24, marginBottom: 8 },
  heading2: { color: colors.navy, fontSize: 18, fontWeight: '700', marginTop: 20, marginBottom: 6 },
  heading3: { color: colors.darkGray, fontSize: 16, fontWeight: '600', marginTop: 14, marginBottom: 4 },
  strong: { fontWeight: '700', color: colors.navy },
  em: { fontStyle: 'italic' },
  table: { borderWidth: 1, borderColor: colors.lightGray, borderRadius: 4, marginVertical: 12 },
  thead: { backgroundColor: colors.navy },
  th: { color: colors.white, fontWeight: '700', padding: 8, fontSize: 12 },
  td: { color: colors.darkGray, padding: 8, fontSize: 12, borderTopWidth: 1, borderColor: colors.lightGray },
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
};
