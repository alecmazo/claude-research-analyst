import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator,
  ScrollView, TouchableOpacity, Linking, Animated, Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getGammaEnabled } from '../api/client';
import AppHeader, { BackButton } from '../components/AppHeader';
import { colors, haptics, fontSize, radius, shadow } from '../design';

const POLL_INTERVAL_MS = 2000;

// Pipeline step definitions — must match the `step` keys emitted by
// claude_analyst.py's _emit_progress(...). Order matters: it drives the
// progress checklist UI top-to-bottom.
const STEPS = [
  { key: 'sec_filings', label: 'Downloading SEC Filings', icon: 'cloud-download-outline' },
  { key: 'financials',  label: 'Extracting Financials',   icon: 'bar-chart-outline' },
  { key: 'market_data', label: 'Live Price + Analyst Ratings', icon: 'pulse-outline' },
  { key: 'grok',        label: 'Grok AI Analysis',         icon: 'analytics-outline' },
  { key: 'rendering',   label: 'Rendering Word Report',    icon: 'document-text-outline' },
  { key: 'gamma',       label: 'Gamma Presentation',       icon: 'easel-outline' },
  { key: 'upload',      label: 'Uploading to Dropbox',     icon: 'cloud-upload-outline' },
  { key: 'done',        label: 'Report Ready',             icon: 'checkmark-circle-outline' },
];

const ETA_SECONDS = 90; // Coarse user-facing estimate; tweak as the pipeline evolves.

function StepRow({ step, status }) {
  // status: 'pending' | 'active' | 'done' | 'skipped'
  const iconColor =
    status === 'done'   ? colors.green
  : status === 'active' ? colors.gold
  :                       colors.lightGray;
  const textColor =
    status === 'done'   ? colors.darkGray
  : status === 'active' ? colors.navy
  :                       colors.midGray;
  return (
    <View style={styles.stepRow}>
      <Ionicons name={step.icon} size={20} color={iconColor} />
      <Text style={[styles.stepLabel, { color: textColor }]}>{step.label}</Text>
      {status === 'active' && (
        <ActivityIndicator size="small" color={colors.gold} style={{ marginLeft: 'auto' }} />
      )}
      {status === 'done' && (
        <Ionicons name="checkmark" size={16} color={colors.green} style={{ marginLeft: 'auto' }} />
      )}
    </View>
  );
}

export default function AnalysisScreen({ route, navigation }) {
  const { jobId, ticker } = route.params;
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState({ step: 'queued', pct: 0, label: 'Starting…' });
  const [elapsed, setElapsed] = useState(0);
  const timerRef    = useRef(null);
  const elapsedRef  = useRef(null);
  const startedAt   = useRef(Date.now());

  // Animated progress bar — interpolates between server-reported pct values
  const barPct = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(barPct, {
      toValue: progress.pct ?? 0,
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress.pct, barPct]);

  // Tick the elapsed-time counter every second
  useEffect(() => {
    elapsedRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(elapsedRef.current);
  }, []);

  const poll = async () => {
    try {
      const data = await api.getJobStatus(jobId);
      setJob(data);
      if (data.progress) {
        setProgress(data.progress);
      }

      if (data.status === 'done') {
        clearInterval(timerRef.current);
        haptics.onSuccess();
        // If the server recovered this job from disk after a restart,
        // auto-navigate to the report immediately — no need for user action.
        if (data.result?.recovered) {
          navigation.replace('Report', { ticker });
        }
      } else if (data.status === 'failed') {
        clearInterval(timerRef.current);
        haptics.onError();
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
            navigation.replace('Report', { ticker });
            return;
          }
        } catch (_) { /* report doesn't exist either */ }
        setJob({
          job_id: jobId, ticker, status: 'failed',
          error: 'The server restarted mid-analysis (a new deploy landed). Tap Retry to re-run.',
          result: null, created_at: '',
        });
      } else {
        setJob(prev => ({
          ...(prev || { job_id: jobId, ticker, created_at: '' }),
          status: 'failed', error: msg, result: null,
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

  // Step status from server-reported progress.step.
  // Steps before the current one are 'done'; current is 'active'; rest are 'pending'.
  const currentStepIdx = STEPS.findIndex(s => s.key === progress.step);
  const stepStatus = (idx) => {
    if (isDone)   return 'done';
    if (isFailed) return idx < currentStepIdx ? 'done' : 'pending';
    if (currentStepIdx < 0) return idx === 0 ? 'active' : 'pending';
    if (idx <  currentStepIdx) return 'done';
    if (idx === currentStepIdx) return 'active';
    return 'pending';
  };

  const etaRemain = Math.max(0, ETA_SECONDS - elapsed);
  const etaStr = etaRemain > 0
    ? `~${etaRemain}s remaining`
    : 'Wrapping up…';

  // ── Render result hero card after completion ──
  const r = job?.result;
  const rating = r?.summary?.rating || '';
  const ratingColor =
    /BUY|OVERWEIGHT/i.test(rating)  ? colors.green
  : /SELL|UNDERWEIGHT/i.test(rating) ? colors.red
  :                                    colors.amber;
  const target = r?.summary?.price_target;
  const upsidePct = (target && r?.market_price)
    ? ((Number(target) - Number(r.market_price)) / Number(r.market_price)) * 100
    : null;

  return (
    <View style={styles.wrapper}>
      <AppHeader
        title={ticker}
        showLogo={false}
        subtitle="Institutional Research Analysis"
        left={<BackButton onPress={() => navigation.goBack()} />}
      />

      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* ── Progress card ── */}
        <View style={styles.card}>
          {/* Top progress bar + ETA */}
          <View style={styles.progressBarWrap}>
            <Animated.View
              style={[
                styles.progressBar,
                {
                  width: barPct.interpolate({
                    inputRange:  [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                  backgroundColor: isFailed ? colors.red : colors.gold,
                },
              ]}
            />
          </View>
          <View style={styles.progressMeta}>
            <Text style={styles.progressLabel}>
              {isDone ? 'Complete' : isFailed ? 'Failed' : (progress.label || 'Working…')}
            </Text>
            {!isDone && !isFailed && (
              <Text style={styles.progressEta}>{etaStr}</Text>
            )}
            {(isDone || isFailed) && (
              <Text style={styles.progressEta}>{elapsed}s</Text>
            )}
          </View>

          {/* Step checklist */}
          <View style={styles.stepsContainer}>
            {STEPS.map((step, i) => (
              <StepRow key={step.key} step={step} status={stepStatus(i)} />
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
              onPress={() => {
                haptics.onPressPrimary();
                navigation.replace('Analysis', { jobId: '__retry__', ticker });
              }}
            >
              <Ionicons name="refresh" size={16} color={colors.gold} />
              <Text style={styles.retryBtnText}>Retry Analysis</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Hero result card after done ── */}
        {isDone && r && (
          <View style={styles.heroCard}>
            <Text style={styles.heroEntity} numberOfLines={1}>
              {r.entity_name || ticker}
            </Text>
            <View style={styles.heroRow}>
              {rating ? (
                <View style={[styles.ratingBadge, { backgroundColor: ratingColor }]}>
                  <Text style={styles.ratingBadgeText}>{rating.toUpperCase()}</Text>
                </View>
              ) : null}
              {r.market_price != null && (
                <View style={styles.priceBlock}>
                  <Text style={styles.priceLabel}>PRICE</Text>
                  <Text style={styles.priceValue}>${Number(r.market_price).toFixed(2)}</Text>
                </View>
              )}
              {target && (
                <View style={styles.priceBlock}>
                  <Text style={styles.priceLabel}>TARGET</Text>
                  <Text style={styles.priceValue}>${Number(target).toFixed(2)}</Text>
                  {upsidePct != null && (
                    <Text style={[
                      styles.upsideText,
                      upsidePct >= 0 ? styles.upsideUp : styles.upsideDown,
                    ]}>
                      {upsidePct >= 0 ? '+' : ''}{upsidePct.toFixed(1)}%
                    </Text>
                  )}
                </View>
              )}
            </View>
          </View>
        )}

        {/* ── Gamma deck CTA ── */}
        {isDone && r?.gamma_url && (
          <TouchableOpacity
            style={styles.gammaBtn}
            onPress={() => { haptics.onPressPrimary(); Linking.openURL(r.gamma_url); }}
            activeOpacity={0.85}
          >
            <Ionicons name="easel-outline" size={18} color={colors.navy} />
            <Text style={styles.gammaBtnText}>View Gamma Presentation</Text>
            <Ionicons name="open-outline" size={15} color={colors.navy} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        )}

        {/* ── Gamma error ── */}
        {isDone && r?.gamma_error && (() => {
          const err = r.gamma_error || '';
          const isCredits = /credit|insufficient|billing/i.test(err);
          return (
            <TouchableOpacity
              style={[styles.gammaErrorBox, isCredits && styles.gammaCreditsBox]}
              onPress={() => Linking.openURL('https://gamma.app/account')}
              activeOpacity={isCredits ? 0.6 : 1}
            >
              <Ionicons
                name={isCredits ? 'card-outline' : 'warning-outline'}
                size={16}
                color={isCredits ? '#92400E' : colors.amber}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.gammaErrorText}>
                  {isCredits ? 'Gamma credits exhausted' : 'Gamma error'}
                </Text>
                <Text style={[styles.gammaErrorText, { marginTop: 2 }]}>{err}</Text>
                {isCredits && (
                  <Text style={[styles.gammaErrorText, { marginTop: 4, fontWeight: '700', textDecorationLine: 'underline' }]}>
                    Tap to open gamma.app/account →
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })()}

        {/* ── View Full Report CTA ── */}
        {isDone && (
          <TouchableOpacity
            style={styles.viewReportBtn}
            onPress={() => { haptics.onPressPrimary(); navigation.navigate('Report', { ticker }); }}
            activeOpacity={0.85}
          >
            <Text style={styles.viewReportText}>View Full Report</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.navy} />
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper:  { flex: 1, backgroundColor: colors.offWhite },
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 60 },

  card: {
    backgroundColor: colors.white,
    borderRadius: radius.xl + 2,
    padding: 20,
    ...shadow.hero,
  },

  // ── Progress bar ──
  progressBarWrap: {
    height: 6,
    backgroundColor: colors.lightGray,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  progressLabel: {
    flex: 1,
    fontSize: fontSize.body,
    fontWeight: '700',
    color: colors.navy,
  },
  progressEta: {
    fontSize: fontSize.small,
    color: colors.midGray,
    fontFamily: 'Courier New',
    fontWeight: '600',
    marginLeft: 8,
  },

  // ── Step checklist ──
  stepsContainer: { gap: 14 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  stepLabel: { fontSize: fontSize.bodyLg, fontWeight: '500', flex: 1 },

  // ── Error / retry ──
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

  // ── Hero result card ──
  heroCard: {
    backgroundColor: colors.navy,
    borderRadius: radius.xl + 2,
    padding: 20,
    marginTop: 14,
    borderWidth: 1.5,
    borderColor: colors.gold,
  },
  heroEntity: {
    fontSize: 16, fontWeight: '700',
    color: colors.lightGray, letterSpacing: 0.4,
    marginBottom: 12,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
  },
  ratingBadge: {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 4,
  },
  ratingBadgeText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 1,
  },
  priceBlock: { alignItems: 'flex-start' },
  priceLabel: {
    fontSize: 9, fontWeight: '800', color: colors.midGray,
    letterSpacing: 1.2, marginBottom: 2,
  },
  priceValue: {
    fontSize: 18, fontWeight: '800', color: colors.gold,
    fontFamily: 'Courier New',
  },
  upsideText: {
    fontSize: 11, fontWeight: '800', fontFamily: 'Courier New',
    marginTop: 2,
  },
  upsideUp:   { color: colors.green },
  upsideDown: { color: colors.red },

  // ── Gamma + view-report CTAs ──
  viewReportBtn: {
    backgroundColor: colors.gold,
    borderRadius: radius.xl,
    padding: 16,
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    ...shadow.hero,
  },
  viewReportText: { fontSize: 16, fontWeight: '800', color: colors.navy, letterSpacing: 0.6 },
  // The Gamma button is now a strong gold-fill CTA (was offWhite + border)
  // since the deck is a premium output that deserves visual priority.
  gammaBtn: {
    backgroundColor: colors.gold,
    borderRadius: radius.xl,
    padding: 14,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  gammaBtnText: { fontSize: 14, fontWeight: '800', color: colors.navy, flex: 1 },
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
  gammaErrorText: { fontSize: 12, color: '#92400E', lineHeight: 16 },
  gammaCreditsBox: {
    backgroundColor: '#FEF3C7',
    borderColor: '#D97706',
    borderWidth: 1.5,
  },
});
