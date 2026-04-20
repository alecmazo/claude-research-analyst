import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Switch, Linking,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api/client';
import { colors } from '../components/theme';

const FALLBACK_STRATEGIES = [
  {
    key: 'pro',
    label: 'Pro Standard',
    description: '10–20 positions, max 12% each, sector cap 25%. Institutional risk/reward.',
  },
  {
    key: 'concentrated',
    label: 'Concentrated High Conviction',
    description: '8–10 positions, max 20% each, sector cap 35%. Higher conviction tilt.',
  },
  {
    key: 'allin',
    label: 'All In — Top 3',
    description: 'Only the 3 highest-conviction names, up to 40% each. Max aggression.',
  },
];

export default function PortfolioScreen() {
  const [strategies, setStrategies] = useState(FALLBACK_STRATEGIES);
  const [selectedStrategy, setSelectedStrategy] = useState('pro');
  const [file, setFile] = useState(null);
  const [reuseCache, setReuseCache] = useState(true);
  const [generateGamma, setGenerateGamma] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    api.listStrategies()
      .then(s => { if (Array.isArray(s) && s.length) setStrategies(s); })
      .catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'text/csv',
          '*/*',
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (asset) setFile(asset);
    } catch (err) {
      Alert.alert('Could not pick file', err.message);
    }
  };

  const startRun = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setJob(null);
    try {
      const resp = await api.startPortfolio({
        fileUri: file.uri,
        fileName: file.name,
        mimeType: file.mimeType,
        strategy: selectedStrategy,
        reuseExisting: reuseCache,
        generateGamma,
      });
      setJob(resp);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => pollJob(resp.job_id), 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const pollJob = async (jobId) => {
    try {
      const j = await api.getPortfolioJob(jobId);
      setJob(j);
      if (j.status === 'done' || j.status === 'failed') {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      clearInterval(pollRef.current);
      setError(err.message);
    }
  };

  const openDownload = async () => {
    if (!job) return;
    const url = await api.portfolioDownloadUrl(job.job_id);
    Linking.openURL(url);
  };

  const result = job?.result;
  const orderedStrategies = result
    ? [result.primary_strategy, ...Object.keys(result.strategies).filter(k => k !== result.primary_strategy)]
    : [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Portfolio Rebalance</Text>
      </View>

      {/* File picker card */}
      <View style={styles.card}>
        <Text style={styles.label}>UPLOAD PORTFOLIO</Text>
        <Text style={styles.hint}>
          CSV or XLSX with columns: Ticker, Weight (%), Optimized. The Optimized column is ignored on input.
        </Text>
        <TouchableOpacity style={styles.fileBtn} onPress={pickFile}>
          <Ionicons name="document-attach-outline" size={20} color={colors.navy} />
          <Text style={styles.fileBtnText}>
            {file ? file.name : 'Choose Portfolio File'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Strategy picker */}
      <View style={styles.card}>
        <Text style={styles.label}>PRIMARY STRATEGY</Text>
        {strategies.map(s => {
          const selected = s.key === selectedStrategy;
          return (
            <TouchableOpacity
              key={s.key}
              style={[styles.strategyOption, selected && styles.strategyOptionSelected]}
              onPress={() => setSelectedStrategy(s.key)}
              activeOpacity={0.7}
            >
              <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected && <View style={styles.radioInner} />}
              </View>
              <View style={styles.strategyBody}>
                <Text style={styles.strategyTitle}>{s.label}</Text>
                <Text style={styles.strategyDesc}>{s.description}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        <Text style={styles.hint}>
          The xlsx output contains all three strategies; your primary choice shows first.
        </Text>
      </View>

      {/* Options */}
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Reuse cached reports (faster)</Text>
          <Switch
            value={reuseCache}
            onValueChange={setReuseCache}
            trackColor={{ false: colors.lightGray, true: colors.gold }}
            thumbColor={colors.white}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Generate Gamma Presentations</Text>
          <Switch
            value={generateGamma}
            onValueChange={setGenerateGamma}
            trackColor={{ false: colors.lightGray, true: colors.gold }}
            thumbColor={colors.white}
          />
        </View>
        <TouchableOpacity
          style={[styles.runBtn, (!file || submitting) && styles.runBtnDisabled]}
          onPress={startRun}
          disabled={!file || submitting}
        >
          {submitting
            ? <ActivityIndicator color={colors.navy} />
            : <Text style={styles.runBtnText}>RUN REBALANCE</Text>}
        </TouchableOpacity>
      </View>

      {/* Progress / result */}
      {job && (
        <View style={styles.card}>
          <Text style={styles.label}>STATUS</Text>
          <Text style={styles.statusText}>
            {job.status === 'done'
              ? `✅ Done — ${job.n_tickers} tickers analyzed`
              : job.status === 'failed'
                ? '❌ Failed'
                : `${job.status === 'running' ? 'Analyzing' : 'Queued'} — ${job.n_tickers} tickers (${job.strategy})…`}
          </Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
          {job.error && <Text style={styles.errorText}>{job.error}</Text>}

          {result && orderedStrategies.map(k => {
            const s = result.strategies[k];
            if (!s) return null;
            const isPrimary = k === result.primary_strategy;
            const pills = Object.entries(s.weights)
              .sort(([, a], [, b]) => b - a);
            return (
              <View key={k} style={[styles.resultBlock, isPrimary && styles.resultBlockPrimary]}>
                <View style={styles.resultHead}>
                  <Text style={styles.resultTitle}>
                    {s.label}{isPrimary ? ' — Primary' : ''}
                  </Text>
                  <Text style={styles.resultCount}>{s.held} positions</Text>
                </View>
                <View style={styles.pillRow}>
                  {pills.length === 0 && <Text style={styles.emptyPill}>No positions</Text>}
                  {pills.map(([t, w]) => (
                    <View key={t} style={styles.pill}>
                      <Text style={styles.pillTicker}>{t}</Text>
                      <Text style={styles.pillWeight}>{(w * 100).toFixed(1)}%</Text>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}

          {job.status === 'done' && (
            <TouchableOpacity style={styles.runBtn} onPress={openDownload}>
              <Text style={styles.runBtnText}>Download DGA-portfolio.xlsx</Text>
            </TouchableOpacity>
          )}
          {job.status === 'done' && result?.gsheets?.ok && (
            <TouchableOpacity
              style={[styles.runBtn, styles.sheetsBtn]}
              onPress={() => Linking.openURL(result.gsheets.url)}
            >
              <Ionicons name="logo-google" size={16} color={colors.white} style={{ marginRight: 6 }} />
              <Text style={[styles.runBtnText, { color: colors.white }]}>Open in Google Sheets</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  content: { paddingBottom: 40 },
  header: {
    backgroundColor: colors.navy,
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
  },
  headerTitle: { color: colors.gold, fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  card: {
    backgroundColor: colors.white,
    margin: 16,
    marginBottom: 0,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 11, fontWeight: '700', color: colors.midGray,
    letterSpacing: 1.5, marginBottom: 10,
  },
  hint: { fontSize: 12, color: colors.midGray, lineHeight: 17, marginTop: 8 },
  fileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderStyle: 'dashed',
    borderRadius: 10,
    backgroundColor: colors.offWhite,
  },
  fileBtnText: { fontSize: 14, fontWeight: '600', color: colors.navy, flex: 1 },
  strategyOption: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    padding: 12,
    borderWidth: 1.5,
    borderColor: colors.lightGray,
    borderRadius: 10,
    marginBottom: 8,
  },
  strategyOptionSelected: {
    borderColor: colors.gold,
    backgroundColor: 'rgba(201, 162, 39, 0.06)',
  },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: colors.midGray,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  radioOuterSelected: { borderColor: colors.gold },
  radioInner: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold,
  },
  strategyBody: { flex: 1 },
  strategyTitle: { fontSize: 15, fontWeight: '700', color: colors.navy, marginBottom: 2 },
  strategyDesc: { fontSize: 12.5, color: colors.darkGray, lineHeight: 17 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleLabel: { fontSize: 14, fontWeight: '600', color: colors.darkGray },
  runBtn: {
    backgroundColor: colors.gold,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { color: colors.navy, fontWeight: '800', fontSize: 14, letterSpacing: 1 },
  sheetsBtn: { backgroundColor: '#0F9D58', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  statusText: { fontSize: 14, fontWeight: '600', color: colors.navy, marginBottom: 6 },
  errorText: { fontSize: 13, color: colors.red, marginTop: 4 },
  resultBlock: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.lightGray,
    borderRadius: 10,
    backgroundColor: colors.offWhite,
  },
  resultBlockPrimary: {
    borderColor: colors.gold,
    backgroundColor: 'rgba(201, 162, 39, 0.08)',
  },
  resultHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  resultTitle: { fontSize: 13, fontWeight: '800', color: colors.navy, letterSpacing: 0.5 },
  resultCount: { fontSize: 11, fontWeight: '700', color: colors.midGray, letterSpacing: 1 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.lightGray,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillTicker: { fontSize: 12, color: colors.darkGray },
  pillWeight: { fontSize: 12, fontWeight: '700', color: colors.navy },
  emptyPill: { fontSize: 12, color: colors.midGray, fontStyle: 'italic' },
});
