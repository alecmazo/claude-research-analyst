import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import { colors } from '../components/theme';

export default function HomeScreen({ navigation }) {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [serverOk, setServerOk] = useState(null);

  const checkServer = async () => {
    try {
      await api.health();
      setServerOk(true);
    } catch {
      setServerOk(false);
    }
  };

  const loadReports = async () => {
    try {
      const data = await api.listReports();
      setReports(data);
    } catch {
      // server may be offline; fail silently
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkServer();
      loadReports();
    }, [])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([checkServer(), loadReports()]);
    setRefreshing(false);
  };

  const handleAnalyze = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    if (serverOk === false) {
      Alert.alert('Server Offline', 'Cannot reach the API server. Check Settings.');
      return;
    }
    setLoading(true);
    try {
      const job = await api.startAnalysis(t);
      setTicker('');
      navigation.navigate('Analysis', { jobId: job.job_id, ticker: t });
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const renderReport = ({ item }) => (
    <TouchableOpacity
      style={styles.reportCard}
      onPress={() => navigation.navigate('Report', { ticker: item.ticker })}
    >
      <View style={styles.reportCardLeft}>
        <Text style={styles.reportTicker}>{item.ticker}</Text>
        <Text style={styles.reportDate}>
          {new Date(item.generated_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })}
        </Text>
      </View>
      <View style={styles.reportCardRight}>
        {item.has_docx && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>DOCX</Text>
          </View>
        )}
        {item.has_pptx && (
          <View style={[styles.badge, styles.badgeGold]}>
            <Text style={styles.badgeText}>PPTX</Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={18} color={colors.midGray} />
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>DGA Research</Text>
        <View style={[styles.statusDot, { backgroundColor: serverOk === true ? colors.green : serverOk === false ? colors.red : colors.amber }]} />
      </View>

      {/* Ticker input */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>ANALYZE TICKER</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="e.g. AAPL"
            placeholderTextColor={colors.midGray}
            value={ticker}
            onChangeText={t => setTicker(t.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={handleAnalyze}
          />
          <TouchableOpacity
            style={[styles.analyzeBtn, loading && styles.analyzeBtnDisabled]}
            onPress={handleAnalyze}
            disabled={loading || !ticker.trim()}
          >
            {loading
              ? <ActivityIndicator color={colors.navy} size="small" />
              : <Text style={styles.analyzeBtnText}>RUN</Text>
            }
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>
          Downloads SEC filings → Grok AI analysis → Institutional-grade report
        </Text>
      </View>

      {/* Reports list */}
      <Text style={styles.sectionTitle}>SAVED REPORTS</Text>
      <FlatList
        data={reports}
        keyExtractor={item => item.ticker}
        renderItem={renderReport}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No reports yet. Run your first analysis above.</Text>
        }
        contentContainerStyle={reports.length === 0 && styles.emptyContainer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  header: {
    backgroundColor: colors.navy,
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { color: colors.gold, fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  inputSection: {
    backgroundColor: colors.white,
    margin: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1.5, marginBottom: 10 },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1,
    height: 50,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 18,
    fontWeight: '700',
    color: colors.navy,
    letterSpacing: 2,
  },
  analyzeBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingHorizontal: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  analyzeBtnDisabled: { opacity: 0.5 },
  analyzeBtnText: { color: colors.navy, fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  hint: { marginTop: 10, fontSize: 12, color: colors.midGray, lineHeight: 17 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginHorizontal: 16, marginBottom: 8,
  },
  reportCard: {
    backgroundColor: colors.white,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  reportCardLeft: { flex: 1 },
  reportTicker: { fontSize: 17, fontWeight: '700', color: colors.navy, letterSpacing: 1 },
  reportDate: { fontSize: 12, color: colors.midGray, marginTop: 2 },
  reportCardRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: {
    backgroundColor: colors.navyLight,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  badgeGold: { backgroundColor: colors.gold },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: '700' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { textAlign: 'center', color: colors.midGray, fontSize: 14, paddingHorizontal: 40 },
});
