import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator,
  ScrollView, TouchableOpacity, Linking, Animated, Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, getGammaEnabled } from '../api/client';
import AppHeader, { BackButton } from '../components/AppHeader';
import { haptics, fontSize, radius, shadow, useTheme } from '../design';

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

function StepRow({ t, s, step, status }) {
  // status: 'pending' | 'active' | 'done' | 'skipped'
  const iconColor =
    status === 'done'   ? t.green
  : status === 'active' ? t.primary
  :                       t.textDim;
  const textColor =
    status === 'done'   ? t.textPrimary
  : status === 'active' ? t.textPrimary
  :                       t.textSecondary;
  return (
    <View style={s.stepRow}>
      <Ionicons name={step.icon} size={20} color={iconColor} />
      <Text style={[s.stepLabel, { color: textColor }]}>{step.label}</Text>
      {status === 'active' && (
        <ActivityIndicator size="small" color={t.primary} style={{ marginLeft: 'auto' }} />
      )}
      {status === 'done' && (
        <Ionicons name="checkmark" size={16} color={t.green} style={{ marginLeft: 'auto' }} />
      )}
    </View>
  );
}

export default function AnalysisScreen({ route, navigation }) {
  const { jobId, ticker } = route.params;
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
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
    /BUY|OVERWEIGHT/i.test(rating)  ? t.green
  : /SELL|UNDERWEIGHT/i.test(rating) ? t.red
  :                                    t.amber;
  const target = r?.summary?.price_target;
  const upsidePct = (target && r?.market_price)
    ? ((Number(target) - Number(r.market_price)) / Number(r.market_price)) * 100
    : null;

  return (
    <View style={s.wrapper}>
      <AppHeader
        title={ticker}
        showLogo={false}
        subtitle="Institutional Research Analysis"
        left={<BackButton onPress={() => navigation.goBack()} />}
      />

      <ScrollView style={s.container} contentContainerStyle={s.content}>
        {/* ── Progress card ── */}
        <View style={s.card}>
          {/* Top progress bar + ETA */}
          <View style={s.progressBarWrap}>
            <Animated.View
              style={[
                s.progressBar,
                {
                  width: barPct.interpolate({
                    inputRange:  [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                  backgroundColor: isFailed ? t.red : t.primary,
                },
              ]}
            />
          </View>
          <View style={s.progressMeta}>
            <Text style={s.progressLabel}>
              {isDone ? 'Complete' : isFailed ? 'Failed' : (progress.label || 'Working…')}
            </Text>
            {!isDone && !isFailed && (
              <Text style={s.progressEta}>{etaStr}</Text>
            )}
            {(isDone || isFailed) && (
              <Text style={s.progressEta}>{elapsed}s</Text>
            )}
          </View>

          {/* Step checklist */}
          <View style={s.stepsContainer}>
            {STEPS.map((step, i) => (
              <StepRow t={t} s={s} key={step.key} step={step} status={stepStatus(i)} />
            ))}
          </View>

          {isFailed && (
            <View style={s.errorBox}>
              <Ionicons name="alert-circle" size={20} color={t.red} />
              <Text style={s.errorText}>{job?.error || 'Analysis failed'}</Text>
            </View>
          )}
          {isFailed && (
            <TouchableOpacity
              style={s.retryBtn}
              onPress={() => {
                haptics.onPressPrimary();
                navigation.replace('Analysis', { jobId: '__retry__', ticker });
              }}
            >
              <Ionicons name="refresh" size={16} color={t.primary} />
              <Text style={s.retryBtnText}>Retry Analysis</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Hero result card after done ── */}
        {isDone && r && (
          <View style={s.heroCard}>
            <Text style={s.heroEntity} numberOfLines={1}>
              {r.entity_name || ticker}
            </Text>
            <View style={s.heroRow}>
              {rating ? (
                <View style={[s.ratingBadge, { backgroundColor: ratingColor }]}>
                  <Text style={s.ratingBadgeText}>{rating.toUpperCase()}</Text>
                </View>
              ) : null}
              {r.market_price != null && (
                <View style={s.priceBlock}>
                  <Text style={s.priceLabel}>PRICE</Text>
                  <Text style={s.priceValue}>${Number(r.market_price).toFixed(2)}</Text>
                </View>
              )}
              {target && (
                <View style={s.priceBlock}>
                  <Text style={s.priceLabel}>TARGET</Text>
                  <Text style={s.priceValue}>${Number(target).toFixed(2)}</Text>
                  {upsidePct != null && (
                    <Text style={[
                      s.upsideText,
                      upsidePct >= 0 ? s.upsideUp : s.upsideDown,
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
            style={s.gammaBtn}
            onPress={() => { haptics.onPressPrimary(); Linking.openURL(r.gamma_url); }}
            activeOpacity={0.85}
          >
            <Ionicons name="easel-outline" size={18} color={t.chromeNavy} />
            <Text style={s.gammaBtnText}>View Gamma Presentation</Text>
            <Ionicons name="open-outline" size={15} color={t.chromeNavy} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        )}

        {/* ── Gamma error ── */}
        {isDone && r?.gamma_error && (() => {
          const err = r.gamma_error || '';
          const isCredits = /credit|insufficient|billing/i.test(err);
          return (
            <TouchableOpacity
              style={[s.gammaErrorBox, isCredits && s.gammaCreditsBox]}
              onPress={() => Linking.openURL('https://gamma.app/account')}
              activeOpacity={isCredits ? 0.6 : 1}
            >
              <Ionicons
                name={isCredits ? 'card-outline' : 'warning-outline'}
                size={16}
                color={isCredits ? t.amber : t.amber}
              />
              <View style={{ flex: 1 }}>
                <Text style={s.gammaErrorText}>
                  {isCredits ? 'Gamma credits exhausted' : 'Gamma error'}
                </Text>
                <Text style={[s.gammaErrorText, { marginTop: 2 }]}>{err}</Text>
                {isCredits && (
                  <Text style={[s.gammaErrorText, { marginTop: 4, fontWeight: '700', textDecorationLine: 'underline' }]}>
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
            style={s.viewReportBtn}
            onPress={() => { haptics.onPressPrimary(); navigation.navigate('Report', { ticker }); }}
            activeOpacity={0.85}
          >
            <Text style={s.viewReportText}>View Full Report</Text>
            <Ionicons name="arrow-forward" size={18} color={t.chromeNavy} />
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
  wrapper:  { flex: 1, backgroundColor: t.bg },
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 60 },

  card: {
    backgroundColor: t.surface,
    borderRadius: radius.xl + 2,
    padding: 20,
    ...shadow.hero,
  },

  // ── Progress bar ──
  progressBarWrap: {
    height: 6,
    backgroundColor: t.surfaceAlt,
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
    color: t.textPrimary,
  },
  progressEta: {
    fontSize: fontSize.small,
    color: t.textSecondary,
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
    backgroundColor: t.pillDownBg,
    borderRadius: 8,
    padding: 12,
    marginTop: 20,
    gap: 10,
  },
  errorText: { color: t.red, flex: 1, fontSize: 13, lineHeight: 18 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: t.chromeNavy,
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
  },
  retryBtnText: { color: t.primary, fontWeight: '700', fontSize: 14 },

  // ── Hero result card ──
  heroCard: {
    backgroundColor: t.chromeNavy,
    borderRadius: radius.xl + 2,
    padding: 20,
    marginTop: 14,
    borderWidth: 1.5,
    borderColor: t.primary,
  },
  heroEntity: {
    fontSize: 16, fontWeight: '700',
    color: t.onChrome, letterSpacing: 0.4,
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
    color: t.onChrome,
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 1,
  },
  priceBlock: { alignItems: 'flex-start' },
  priceLabel: {
    fontSize: 9, fontWeight: '800', color: t.textSecondary,
    letterSpacing: 1.2, marginBottom: 2,
  },
  priceValue: {
    fontSize: 18, fontWeight: '800', color: t.primary,
    fontFamily: 'Courier New',
  },
  upsideText: {
    fontSize: 11, fontWeight: '800', fontFamily: 'Courier New',
    marginTop: 2,
  },
  upsideUp:   { color: t.green },
  upsideDown: { color: t.red },

  // ── Gamma + view-report CTAs ──
  viewReportBtn: {
    backgroundColor: t.primary,
    borderRadius: radius.xl,
    padding: 16,
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    ...shadow.hero,
  },
  viewReportText: { fontSize: 16, fontWeight: '800', color: t.chromeNavy, letterSpacing: 0.6 },
  // The Gamma button is now a strong gold-fill CTA (was offWhite + border)
  // since the deck is a premium output that deserves visual priority.
  gammaBtn: {
    backgroundColor: t.primary,
    borderRadius: radius.xl,
    padding: 14,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  gammaBtnText: { fontSize: 14, fontWeight: '800', color: t.chromeNavy, flex: 1 },
  gammaErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: t.surfaceAlt,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: t.amber,
  },
  gammaErrorText: { fontSize: 12, color: t.amber, lineHeight: 16 },
  gammaCreditsBox: {
    backgroundColor: t.surfaceAlt,
    borderColor: t.amber,
    borderWidth: 1.5,
  },
});
}
