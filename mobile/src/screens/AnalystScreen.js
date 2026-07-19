// ─────────────────────────────────────────────────────────────────────────────
// AnalystScreen — 🤖 DGA Capital Analyst (agentic)
// Ask an open-ended research question; the routed engine (Grok / Claude /
// DeepSeek) runs a tool-use loop over platform data and answers with cited
// numbers. Completed runs are listed under Saved Analyses (same DB as web)
// and can be re-opened or emailed as a DGA-branded PDF.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Alert,
  RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { api, getV2User } from '../api/client';
import { spacing, radius, fontSize, Card, haptics, makeMdStyles, useTheme } from '../design';
import { relativeTime } from '../design/format';

const ANALYST_BUILD = 'an-v3-20260719';
const ENGINE_KEY = '@dga_agentic_engine_v1';
const ENGINES = [
  { id: 'claude', label: 'Claude', sub: 'Opus 4.8' },
  { id: 'grok', label: 'Grok', sub: '4.5' },
  { id: 'deepseek', label: 'DeepSeek', sub: 'cheap' },
];

const TOOL_ICON = {
  get_quote: '💹', get_sector: '🏷', read_saved_report: '📄',
  get_recent_news: '📰', list_saved_reports: '📚', get_financials: '📊',
  compute: '🧮', get_ytd_attribution: '📈', web_search: '🌐',
};

const EXAMPLES = [
  'Which of my covered names moved most today and why?',
  'Summarize the bull vs bear case on NVDA from our reports.',
  'Pull NVDA latest filing fundamentals and compute its FCF margin.',
  'Any fresh catalysts across my coverage this week?',
];

// Strip the agentic ```sleeve {...}``` block from the displayed answer.
function cleanAnswer(text) {
  return (text || '').replace(/```sleeve[\s\S]*?```/g, '').trim();
}

/** Lightweight markdown → HTML for the server PDF/email pipeline. */
function answerMdToHtml(md) {
  let s = String(md || '');
  s = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  s = s
    .replace(/^#### (.+)$/gm, '<div class="md-h md-h4">$1</div>')
    .replace(/^### (.+)$/gm, '<div class="md-h md-h3">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="md-h md-h2">$1</div>')
    .replace(/^# (.+)$/gm, '<div class="md-h md-h1">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (block) =>
    `<ul class="md-list">${block}</ul>`);
  s = s
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  return `<div class="md-rendered"><p>${s}</p></div>`;
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return String(iso).slice(0, 16);
  }
}

export default function AnalystScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const md = useMemo(() => makeMdStyles(t), [t]);

  const [question, setQuestion] = useState('');
  const [engine, setEngine] = useState('claude');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);   // live or re-opened
  const [activeQuestion, setActiveQuestion] = useState('');
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // Saved analyses
  const [reviews, setReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsError, setReviewsError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Email modal
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailPayload, setEmailPayload] = useState(null); // { question, answer, stamp }

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const loadReviews = useCallback(async () => {
    setReviewsError(null);
    try {
      const d = await api.listAnalystReviews('analyst');
      if (d && d.ok === false) throw new Error(d.error || 'Failed to load');
      setReviews(Array.isArray(d?.reviews) ? d.reviews : []);
    } catch (e) {
      setReviewsError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(ENGINE_KEY).then((v) => {
      if (v && ENGINES.some((e) => e.id === v)) setEngine(v);
    }).catch(() => {});
    setReviewsLoading(true);
    loadReviews().finally(() => setReviewsLoading(false));
    return () => stopPoll();
  }, [loadReviews]);

  const pickEngine = useCallback((id) => {
    setEngine(id);
    AsyncStorage.setItem(ENGINE_KEY, id).catch(() => {});
    try { haptics.onPressPrimary?.(); } catch {}
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadReviews();
    setRefreshing(false);
  }, [loadReviews]);

  const run = useCallback(async () => {
    const q = (question || '').trim();
    if (q.length < 4) { setError('Ask a real question.'); return; }
    try { haptics.onPressPrimary?.(); } catch {}
    setRunning(true); setError(null); setResult(null);
    setActiveQuestion(q);
    setProgress({ label: 'Starting…', steps: 0, tool_calls: [], cost_usd: 0 });
    const t0 = Date.now();
    try {
      const d0 = await api.startAgentic(q, engine);
      if (!d0.ok) throw new Error(d0.error || 'Failed to start');
      const jobId = d0.job_id;
      pollRef.current = setInterval(async () => {
        if (Date.now() - t0 > 180000) {
          stopPoll(); setRunning(false); setError('Timed out after 3 min.'); return;
        }
        try {
          const d = await api.getAgentic(jobId);
          if (d.status === 'done' && d.result) {
            stopPoll();
            setRunning(false);
            setProgress(null);
            setResult(d.result);
            // Server persists async — give it a beat then refresh the list
            setTimeout(() => { loadReviews(); }, 1800);
          } else if (d.status === 'error') {
            stopPoll(); setRunning(false); setError(d.label || d.error || 'failed');
          } else {
            setProgress({
              label: d.label || 'Working…',
              steps: d.steps || 0,
              tool_calls: d.tool_calls || [],
              cost_usd: d.cost_usd || 0,
            });
          }
        } catch (_) { /* transient */ }
      }, 1400);
    } catch (e) {
      setRunning(false); setError(String(e?.message || e));
    }
  }, [question, engine, loadReviews]);

  const openReview = useCallback(async (id) => {
    try { haptics.onPressPrimary?.(); } catch {}
    setError(null);
    try {
      const d = await api.getAnalystReview(id);
      if (!d?.ok || !d.review) throw new Error(d?.error || 'Not found');
      const rv = d.review;
      setActiveQuestion(rv.question || '');
      setResult({
        answer: rv.answer || '',
        verification: rv.verification,
        tool_calls: rv.tool_calls || [],
        cost_usd: rv.cost_usd,
        model: rv.model,
        generated_at: rv.generated_at,
        review_id: rv.id,
      });
      setProgress(null);
    } catch (e) {
      setError('Could not open saved analysis: ' + String(e?.message || e));
    }
  }, []);

  const deleteReview = useCallback((id, snip) => {
    Alert.alert(
      'Delete analysis?',
      snip ? `"${snip.slice(0, 80)}${snip.length > 80 ? '…' : ''}"` : 'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteAnalystReview(id);
              setReviews((prev) => prev.filter((r) => r.id !== id));
              if (result?.review_id === id) setResult(null);
            } catch (e) {
              Alert.alert('Delete failed', String(e?.message || e));
            }
          },
        },
      ],
    );
  }, [result]);

  const openEmail = useCallback(async (payload) => {
    const ans = cleanAnswer(payload?.answer || '');
    if (!ans) {
      Alert.alert('Nothing to email', 'Open or run an analysis first.');
      return;
    }
    let def = '';
    try {
      const u = await getV2User();
      def = (u && u.email) || '';
    } catch {}
    setEmailTo(def);
    setEmailPayload({
      question: payload.question || activeQuestion || '',
      answer: ans,
      stamp: payload.stamp || formatWhen(payload.generated_at) || '',
    });
    setEmailOpen(true);
  }, [activeQuestion]);

  const sendEmail = useCallback(async () => {
    const to = (emailTo || '').trim();
    if (!to || !to.includes('@')) {
      Alert.alert('Email required', 'Enter a valid recipient address.');
      return;
    }
    if (!emailPayload?.answer) return;
    setEmailBusy(true);
    try {
      const d = await api.emailResearchPdf({
        title: 'AI Analyst',
        question: emailPayload.question,
        answerHtml: answerMdToHtml(emailPayload.answer),
        stamp: emailPayload.stamp,
        to,
      });
      if (d && d.ok === false) throw new Error(d.detail || d.error || 'Send failed');
      try { haptics.onSuccess?.(); } catch {}
      setEmailOpen(false);
      Alert.alert('Sent', `Analysis emailed to ${to}`);
    } catch (e) {
      Alert.alert('Email failed', String(e?.message || e));
    } finally {
      setEmailBusy(false);
    }
  }, [emailTo, emailPayload]);

  const renderVerification = (v) => {
    if (!v) return null;
    if (v.verdict === 'clean') {
      return (
        <View style={[s.verifyBox, s.verifyClean]}>
          <Text style={s.verifyCleanTxt}>✓ Verified — every numeric claim is backed by a tool call.</Text>
        </View>
      );
    }
    if (v.verdict === 'unchecked') {
      return (
        <View style={[s.verifyBox, s.verifyNeutral]}>
          <Text style={s.verifyNeutralTxt}>⚠ Verification did not run.</Text>
        </View>
      );
    }
    return (
      <View style={[s.verifyBox, s.verifyWarn]}>
        <Text style={s.verifyWarnTitle}>⚠ Flagged {(v.flags || []).length} claim(s) — review before sharing:</Text>
        {(v.flags || []).map((f, i) => (
          <Text key={i} style={s.verifyWarnItem}>
            • <Text style={{ fontWeight: '700' }}>{f.issue || 'flag'}:</Text> {f.claim || ''}
            {f.note ? `  (${f.note})` : ''}
          </Text>
        ))}
      </View>
    );
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.brand}>🤖  DGA Capital Analyst</Text>
        <Text style={s.brandSub}>agentic · live data + reports · {ANALYST_BUILD}</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}>
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.gold} />
          }
        >
          <Text style={s.engineLabel}>ENGINE</Text>
          <View style={s.engineRow}>
            {ENGINES.map((e) => {
              const on = engine === e.id;
              return (
                <TouchableOpacity
                  key={e.id}
                  style={[s.engineChip, on && s.engineChipOn]}
                  onPress={() => pickEngine(e.id)}
                  disabled={running}
                  activeOpacity={0.8}
                >
                  <Text style={[s.engineChipTxt, on && s.engineChipTxtOn]}>{e.label}</Text>
                  <Text style={[s.engineChipSub, on && s.engineChipTxtOn]}>{e.sub}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            style={s.input}
            placeholder="Ask a research question — e.g. compare NVDA and AMD on valuation and catalysts using our reports."
            placeholderTextColor={t.textSecondary}
            value={question}
            onChangeText={setQuestion}
            multiline
            editable={!running}
          />

          <TouchableOpacity
            style={[s.runBtn, running && s.runBtnDisabled]}
            onPress={run} disabled={running} activeOpacity={0.85}>
            {running
              ? <ActivityIndicator color={t.onAccent} />
              : <Text style={s.runBtnTxt}>
                  🤖  Analyze · {ENGINES.find((x) => x.id === engine)?.label || 'Claude'}
                </Text>}
          </TouchableOpacity>

          {!running && !result && (
            <View style={s.examples}>
              {EXAMPLES.map((ex, i) => (
                <TouchableOpacity key={i} style={s.exChip} onPress={() => setQuestion(ex)}>
                  <Text style={s.exChipTxt}>{ex}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {error ? (
            <Card style={s.errCard}><Text style={s.errTxt}>❌ {error}</Text></Card>
          ) : null}

          {progress ? (
            <Card style={s.progCard}>
              <View style={s.progHead}>
                <ActivityIndicator size="small" color={t.gold} />
                <Text style={s.progLabel} numberOfLines={2}>{progress.label}</Text>
              </View>
              <Text style={s.progMeta}>
                {progress.steps} steps
                {progress.cost_usd ? `  ·  $${Number(progress.cost_usd).toFixed(3)}` : ''}
              </Text>
              {(progress.tool_calls || []).slice(-6).map((tc, i) => (
                <Text key={i} style={s.toolLine}>
                  {(TOOL_ICON[tc.tool] || '🔧')} {tc.tool}
                  {tc.input ? `  ${JSON.stringify(tc.input).slice(0, 40)}` : ''}
                </Text>
              ))}
            </Card>
          ) : null}

          {result ? (
            <Card style={s.resultCard}>
              {activeQuestion ? (
                <Text style={s.resultQ} numberOfLines={4}>{activeQuestion}</Text>
              ) : null}
              <Markdown style={md}>{cleanAnswer(result.answer)}</Markdown>
              {renderVerification(result.verification)}
              {(result.tool_calls || []).length ? (
                <View style={s.toolChips}>
                  {Array.from(new Set((result.tool_calls || []).map((x) => x.tool))).map((tool, i) => (
                    <View key={i} style={s.toolChip}>
                      <Text style={s.toolChipTxt}>{(TOOL_ICON[tool] || '🔧')} {tool}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={s.resultMeta}>
                {result.cost_usd != null ? `💸 $${Number(result.cost_usd).toFixed(3)}` : ''}
                {result.model ? `  ·  ${result.model}` : ''}
                {result.generated_at ? `  ·  ${formatWhen(result.generated_at)}` : ''}
              </Text>
              <View style={s.resultActions}>
                <TouchableOpacity
                  style={s.emailBtn}
                  onPress={() => openEmail({
                    question: activeQuestion,
                    answer: result.answer,
                    generated_at: result.generated_at,
                  })}
                  activeOpacity={0.85}
                >
                  <Text style={s.emailBtnTxt}>✉  Email analysis</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.clearBtn}
                  onPress={() => { setResult(null); setActiveQuestion(''); }}
                  activeOpacity={0.85}
                >
                  <Text style={s.clearBtnTxt}>Close</Text>
                </TouchableOpacity>
              </View>
            </Card>
          ) : null}

          {/* ── Saved analyses ─────────────────────────────────────────── */}
          <View style={s.savedHead}>
            <Text style={s.savedTitle}>📚  Saved analyses</Text>
            <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.savedRefresh}>Refresh</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.savedHint}>
            Past DGA Capital Analyst runs — tap to re-open, email as PDF, or delete.
          </Text>

          {reviewsLoading && !reviews.length ? (
            <View style={s.savedEmpty}>
              <ActivityIndicator color={t.gold} />
            </View>
          ) : null}

          {reviewsError ? (
            <Card style={s.errCard}><Text style={s.errTxt}>{reviewsError}</Text></Card>
          ) : null}

          {!reviewsLoading && !reviewsError && !reviews.length ? (
            <Card style={s.savedEmptyCard}>
              <Text style={s.savedEmptyTxt}>
                No saved analyses yet — run one above and it will appear here.
              </Text>
            </Card>
          ) : null}

          {reviews.map((rv) => {
            const snip = (rv.question || '(no question)').replace(/\s+/g, ' ').trim();
            const when = rv.generated_at
              ? (relativeTime(rv.generated_at) || formatWhen(rv.generated_at))
              : '';
            return (
              <Card key={rv.id} style={s.revCard}>
                <TouchableOpacity onPress={() => openReview(rv.id)} activeOpacity={0.8}>
                  <Text style={s.revQ} numberOfLines={2}>{snip}</Text>
                  <Text style={s.revMeta}>
                    {when}
                    {rv.model ? `  ·  ${rv.model}` : ''}
                    {rv.cost_usd != null ? `  ·  $${Number(rv.cost_usd).toFixed(3)}` : ''}
                  </Text>
                </TouchableOpacity>
                <View style={s.revActions}>
                  <TouchableOpacity style={s.revAct} onPress={() => openReview(rv.id)}>
                    <Text style={s.revActTxt}>View</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.revAct}
                    onPress={async () => {
                      try {
                        const d = await api.getAnalystReview(rv.id);
                        if (!d?.ok || !d.review) throw new Error('not found');
                        openEmail({
                          question: d.review.question,
                          answer: d.review.answer,
                          generated_at: d.review.generated_at,
                        });
                      } catch (e) {
                        Alert.alert('Could not load analysis', String(e?.message || e));
                      }
                    }}
                  >
                    <Text style={s.revActTxt}>✉ Email</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.revAct, s.revActDanger]}
                    onPress={() => deleteReview(rv.id, snip)}
                  >
                    <Text style={[s.revActTxt, s.revActDangerTxt]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            );
          })}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Email modal */}
      <Modal
        visible={emailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !emailBusy && setEmailOpen(false)}
      >
        <View style={s.modalBackdrop}>
          <View style={[s.modalCard, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <Text style={s.modalTitle}>✉ Email analysis</Text>
            <Text style={s.modalSub}>
              Sends a DGA-branded PDF of this analysis (same as the desk).
            </Text>
            {emailPayload?.question ? (
              <Text style={s.modalQ} numberOfLines={3}>{emailPayload.question}</Text>
            ) : null}
            <Text style={s.modalLabel}>To</Text>
            <TextInput
              style={s.modalInput}
              value={emailTo}
              onChangeText={setEmailTo}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="name@example.com"
              placeholderTextColor={t.textSecondary}
              editable={!emailBusy}
            />
            <View style={s.modalActions}>
              <TouchableOpacity
                style={s.modalCancel}
                disabled={emailBusy}
                onPress={() => setEmailOpen(false)}
              >
                <Text style={s.modalCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalSend, emailBusy && { opacity: 0.7 }]}
                disabled={emailBusy}
                onPress={sendEmail}
              >
                {emailBusy
                  ? <ActivityIndicator color={t.onAccent} />
                  : <Text style={s.modalSendTxt}>Send PDF</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(t) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.md },
    brand: { fontSize: fontSize.xl, fontWeight: '800', color: t.textPrimary, letterSpacing: -0.3 },
    brandSub: { fontSize: fontSize.small, color: t.textSecondary, marginTop: 2 },

    engineLabel: {
      fontSize: 9, fontWeight: '800', letterSpacing: 0.8, color: t.textSecondary,
      marginBottom: 6,
    },
    engineRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
    engineChip: {
      flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: radius.md,
      backgroundColor: t.surface, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center',
    },
    engineChipOn: {
      borderColor: t.primary, backgroundColor: t.primary,
    },
    engineChipTxt: { fontSize: fontSize.small, fontWeight: '800', color: t.textPrimary },
    engineChipSub: { fontSize: 9, fontWeight: '600', color: t.textSecondary, marginTop: 1 },
    engineChipTxtOn: { color: t.onAccent || '#0A1628' },
    input: {
      backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
      borderRadius: radius.md, padding: spacing.md, fontSize: fontSize.body,
      color: t.textPrimary, minHeight: 80, textAlignVertical: 'top',
    },
    runBtn: {
      marginTop: spacing.md, backgroundColor: t.primary, borderRadius: radius.md,
      paddingVertical: 13, alignItems: 'center', justifyContent: 'center',
    },
    runBtnDisabled: { opacity: 0.7 },
    runBtnTxt: { color: t.onAccent, fontWeight: '800', fontSize: fontSize.body, letterSpacing: 0.3 },

    examples: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    exChip: {
      backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
      borderRadius: radius.pill, paddingVertical: 7, paddingHorizontal: 12,
    },
    exChipTxt: { fontSize: fontSize.small, color: t.textSecondary },

    errCard: { marginTop: spacing.lg, padding: spacing.md, borderColor: t.red, borderWidth: 1 },
    errTxt: { color: t.red, fontSize: fontSize.body },

    progCard: { marginTop: spacing.lg, padding: spacing.md },
    progHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    progLabel: { flex: 1, fontSize: fontSize.body, fontWeight: '700', color: t.textPrimary },
    progMeta: { fontSize: fontSize.caption, color: t.textSecondary, marginTop: 4, fontVariant: ['tabular-nums'] },
    toolLine: { fontSize: fontSize.caption, color: t.textSecondary, marginTop: 4 },

    resultCard: { marginTop: spacing.lg, padding: spacing.lg },
    resultQ: {
      fontSize: fontSize.small, fontWeight: '700', color: t.textPrimary,
      backgroundColor: t.surfaceAlt, borderLeftWidth: 3, borderLeftColor: t.gold || t.primary,
      paddingVertical: 8, paddingHorizontal: 10, marginBottom: spacing.md, borderRadius: 4,
    },

    verifyBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
    verifyClean: { backgroundColor: t.pillUpBg, borderColor: t.pillUpBg },
    verifyCleanTxt: { color: t.pillUpFg, fontSize: fontSize.small },
    verifyNeutral: { backgroundColor: t.surfaceAlt, borderColor: t.border },
    verifyNeutralTxt: { color: t.textSecondary, fontSize: fontSize.small },
    verifyWarn: { backgroundColor: t.surfaceAlt, borderColor: t.amber },
    verifyWarnTitle: { color: t.amber, fontSize: fontSize.small, fontWeight: '700', marginBottom: 4 },
    verifyWarnItem: { color: t.amber, fontSize: fontSize.caption, marginTop: 2, lineHeight: 17 },

    toolChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
    toolChip: {
      backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border,
      borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8,
    },
    toolChipTxt: { fontSize: fontSize.caption, color: t.textSecondary },
    resultMeta: {
      marginTop: spacing.md, fontSize: fontSize.caption, color: t.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    resultActions: {
      flexDirection: 'row', gap: 10, marginTop: spacing.md, alignItems: 'center',
    },
    emailBtn: {
      flex: 1, backgroundColor: t.primary, borderRadius: radius.md,
      paddingVertical: 11, alignItems: 'center',
    },
    emailBtnTxt: { color: t.onAccent, fontWeight: '800', fontSize: fontSize.small },
    clearBtn: {
      paddingVertical: 11, paddingHorizontal: 14, borderRadius: radius.md,
      borderWidth: 1, borderColor: t.border, backgroundColor: t.surface,
    },
    clearBtnTxt: { color: t.textSecondary, fontWeight: '700', fontSize: fontSize.small },

    savedHead: {
      marginTop: spacing.xl, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'space-between',
    },
    savedTitle: { fontSize: fontSize.body, fontWeight: '800', color: t.textPrimary },
    savedRefresh: { fontSize: fontSize.small, fontWeight: '700', color: t.primary },
    savedHint: {
      fontSize: fontSize.caption, color: t.textSecondary, marginTop: 4, marginBottom: spacing.sm,
    },
    savedEmpty: { paddingVertical: spacing.lg, alignItems: 'center' },
    savedEmptyCard: { marginTop: spacing.sm, padding: spacing.md },
    savedEmptyTxt: { fontSize: fontSize.small, color: t.textSecondary, fontStyle: 'italic' },

    revCard: { marginTop: spacing.sm, padding: spacing.md },
    revQ: { fontSize: fontSize.body, fontWeight: '700', color: t.textPrimary, lineHeight: 20 },
    revMeta: {
      fontSize: fontSize.caption, color: t.textSecondary, marginTop: 4,
      fontVariant: ['tabular-nums'],
    },
    revActions: { flexDirection: 'row', gap: 8, marginTop: spacing.sm },
    revAct: {
      borderWidth: 1, borderColor: t.border, borderRadius: radius.pill,
      paddingVertical: 5, paddingHorizontal: 12, backgroundColor: t.surfaceAlt,
    },
    revActTxt: { fontSize: fontSize.caption, fontWeight: '700', color: t.textPrimary },
    revActDanger: { borderColor: t.red + '55' },
    revActDangerTxt: { color: t.red },

    modalBackdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: t.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16,
      padding: spacing.lg,
    },
    modalTitle: { fontSize: fontSize.lg, fontWeight: '800', color: t.textPrimary },
    modalSub: { fontSize: fontSize.small, color: t.textSecondary, marginTop: 4, marginBottom: spacing.md },
    modalQ: {
      fontSize: fontSize.small, color: t.textPrimary, fontWeight: '600',
      backgroundColor: t.surfaceAlt, padding: 10, borderRadius: 6, marginBottom: spacing.md,
    },
    modalLabel: {
      fontSize: fontSize.caption, fontWeight: '800', color: t.textSecondary,
      letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6,
    },
    modalInput: {
      borderWidth: 1, borderColor: t.border, borderRadius: radius.md,
      paddingHorizontal: 12, paddingVertical: 11, fontSize: fontSize.body,
      color: t.textPrimary, backgroundColor: t.bg, marginBottom: spacing.lg,
    },
    modalActions: { flexDirection: 'row', gap: 10 },
    modalCancel: {
      flex: 1, paddingVertical: 13, alignItems: 'center',
      borderRadius: radius.md, borderWidth: 1, borderColor: t.border,
    },
    modalCancelTxt: { fontWeight: '700', color: t.textSecondary },
    modalSend: {
      flex: 1.2, paddingVertical: 13, alignItems: 'center',
      borderRadius: radius.md, backgroundColor: t.primary,
    },
    modalSendTxt: { fontWeight: '800', color: t.onAccent },
  });
}
