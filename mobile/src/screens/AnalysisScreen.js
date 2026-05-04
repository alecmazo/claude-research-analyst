import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator,
  ScrollView, TouchableOpacity, Alert, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getGammaEnabled } from '../api/client';
import { colors } from '../components/theme';

const POLL_INTERVAL_MS = 3000;

const STEPS = [
  { key: 'queued',   label: 'Queued',                   icon: 'time-outline' },
  { key: 'running',  label: 'Downloading SEC Filings',   icon: 'cloud-download-outline' },
  { key: 'running2', label: 'Extracting Financials',     icon: 'bar-chart-outline' },
  { key: 'running3', label: 'Grok AI Analysis',          icon: 'analytics-outline' },
  { key: 'done',     label: 'Report Ready',              icon: 'checkmark-circle-outline' },
];

function StepRow({ step, active, done }) {
  const iconColor = done ? colors.green : active ? colors.gold : colors.lightGray;
  const textColor = done ? colors.darkGray : active ? colors.navy : colors.midGray;
  return (
    <View style={styles.stepRow}>
      <Ionicons name={step.icon} size={22} color={iconColor} />
      <Text style={[styles.stepLabel, { color: textColor }]}>{step.label}</Text>
      {active && <ActivityIndicator size="small" color={colors.gold} style={{ marginLeft: 'auto' }} />}
      {done && <Ionicons name="checkmark" size={18} color={colors.green} style={{ marginLeft: 'auto' }} />}
    </View>
  );
}

export default function AnalysisScreen({ route, navigation }) {
  const { jobId, ticker } = route.params;
  const [job, setJob] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const timerRef = useRef(null);

  const poll = async () => {
    try {
      const data = await api.getJobStatus(jobId);
      setJob(data);

      if (data.status === 'running') {
        // Simulate sub-steps by cycling through indices 1-3
        setStepIndex(prev => (prev < 3 ? prev + 1 : 3));
      } else if (data.status === 'done') {
        setStepIndex(4);
        clearInterval(timerRef.current);
        // If the server recovered this job from disk after a restart,
        // auto-navigate to the report immediately — no need for user action.
        if (data.result?.recovered) {
          navigation.replace('Report', { ticker });
        }
      } else if (data.status === 'failed') {
        clearInterval(timerRef.current);
      }
    } catch (err) {
      clearInterval(timerRef.current);
      const msg = err?.message || String(err);

      // 404 means the server restarted and lost the in-memory job.
      // Try to find the report on disk — if it exists, navigate straight there.
      if (msg.includes('404') || msg.toLowerCase().includes('job not found') || msg.toLowerCase().includes('job was lost')) {
        try {
          const report = await api.getReport(ticker);
          if (report?.report_md) {
            // Report was already finished before the restart — go straight to it.
            navigation.replace('Report', { ticker });
            return;
          }
        } catch (_) {
          // Report doesn't exist either — the job truly never finished.
        }
        // Job lost and no report found — show a clean retry error.
        setJob({
          job_id: jobId,
          ticker,
          status: 'failed',
          error: 'The server restarted mid-analysis (a new deploy landed). Tap Retry to re-run.',
          result: null,
          created_at: '',
        });
        setStepIndex(0);
      } else {
        setJob(prev => ({
          ...(prev || { job_id: jobId, ticker, created_at: '' }),
          status: 'failed',
          error: msg,
          result: null,
        }));
      }
    }
  };

  useEffect(() => {
    // If this is a retry, kick off a fresh job then start polling the new id.
    if (jobId === '__retry__') {
      (async () => {
        try {
          const gammaOn = await getGammaEnabled();
          const newJob = await api.startAnalysis(ticker, gammaOn);
          // Replace so the back stack points to the new job id.
          navigation.replace('Analysis', { jobId: newJob.job_id, ticker });
        } catch (err) {
          setJob({ job_id: '', ticker, status: 'failed',
                   error: err?.message || 'Could not restart analysis', result: null, created_at: '' });
        }
      })();
      return;
    }
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [jobId]);

  const isDone = job?.status === 'done';
  const isFailed = job?.status === 'failed';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.ticker}>{ticker}</Text>
        <Text style={styles.subtitle}>Institutional Research Analysis</Text>

        <View style={styles.stepsContainer}>
          {STEPS.map((step, i) => (
            <StepRow
              key={step.key}
              step={step}
              active={!isDone && !isFailed && i === stepIndex}
              done={isDone ? true : i < stepIndex}
            />
          ))}
        </View>

        {isFailed && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={20} color={colors.red} />
            <Text style={styles.errorText}>{job?.error || 'Analysis failed'}</Text>
          </View>
        )}
        {isFailed && (
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => navigation.replace('Analysis', { jobId: '__retry__', ticker })}
          >
            <Ionicons name="refresh" size={16} color={colors.navy} />
            <Text style={styles.retryBtnText}>Retry Analysis</Text>
          </TouchableOpacity>
        )}

        {isDone && job?.result && (
          <View style={styles.resultBox}>
            <Text style={styles.resultRow}>
              <Text style={styles.resultLabel}>Company: </Text>
              {job.result.entity_name || ticker}
            </Text>
            {job.result.market_price && (
              <Text style={styles.resultRow}>
                <Text style={styles.resultLabel}>Price: </Text>
                ${job.result.market_price.toFixed(2)}
              </Text>
            )}
            {job.result.summary?.rating && (
              <Text style={styles.resultRow}>
                <Text style={styles.resultLabel}>Rating: </Text>
                {job.result.summary.rating}
              </Text>
            )}
            {job.result.summary?.price_target && (
              <Text style={styles.resultRow}>
                <Text style={styles.resultLabel}>Price Target: </Text>
                ${job.result.summary.price_target}
              </Text>
            )}
          </View>
        )}
      </View>

      {isDone && job?.result?.gamma_url && (
        <TouchableOpacity
          style={styles.gammaBtn}
          onPress={() => Linking.openURL(job.result.gamma_url)}
        >
          <Ionicons name="easel-outline" size={18} color={colors.navy} />
          <Text style={styles.gammaBtnText}>View Gamma Presentation</Text>
          <Ionicons name="open-outline" size={15} color={colors.navy} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>
      )}
      {isDone && job?.result?.gamma_error && (
        <View style={styles.gammaErrorBox}>
          <Ionicons name="warning-outline" size={16} color={colors.amber} />
          <Text style={styles.gammaErrorText}>Gamma: {job.result.gamma_error}</Text>
        </View>
      )}

      {isDone && (
        <TouchableOpacity
          style={styles.viewReportBtn}
          onPress={() => navigation.navigate('Report', { ticker })}
        >
          <Text style={styles.viewReportText}>View Full Report</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.navy} />
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  ticker: { fontSize: 32, fontWeight: '800', color: colors.navy, letterSpacing: 2 },
  subtitle: { fontSize: 13, color: colors.midGray, marginTop: 4, marginBottom: 24 },
  stepsContainer: { gap: 16 },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  stepLabel: { fontSize: 15, fontWeight: '500' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 12,
    marginTop: 20,
    gap: 10,
  },
  errorText: { color: colors.red, flex: 1, fontSize: 13, lineHeight: 18 },
  resultBox: {
    backgroundColor: colors.offWhite,
    borderRadius: 8,
    padding: 14,
    marginTop: 20,
    gap: 6,
  },
  resultRow: { fontSize: 14, color: colors.darkGray },
  resultLabel: { fontWeight: '700', color: colors.navy },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.navy,
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
  },
  retryBtnText: { color: colors.gold, fontWeight: '700', fontSize: 14 },
  viewReportBtn: {
    backgroundColor: colors.gold,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  viewReportText: { fontSize: 16, fontWeight: '700', color: colors.navy },
  gammaBtn: {
    backgroundColor: colors.offWhite,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: colors.gold,
  },
  gammaBtnText: { fontSize: 14, fontWeight: '700', color: colors.navy, flex: 1 },
  gammaErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#FFFBEB',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  gammaErrorText: { fontSize: 12, color: '#92400E', flex: 1, lineHeight: 16 },
});
