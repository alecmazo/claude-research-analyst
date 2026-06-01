// ─────────────────────────────────────────────────────────────────────────────
// AnalystScreen — 🤖 AI Analyst (agentic)
// Mirrors the web "AI Analyst": ask an open-ended research question; Claude
// runs a tool-use loop over platform data (live quotes, saved Grok/Claude
// reports, SEC financials, news, reconciled YTD) and answers with cited
// numbers. A verification pass audits every numeric claim. GP-only — uses
// the v2 session token that api.request() attaches automatically.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import { colors, spacing, radius, fontSize, Card, haptics, mdStyles } from '../design';

const ANALYST_BUILD = 'an-v1-20260528';

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

// Strip the agentic ```sleeve {...}``` block from the displayed answer — it's a
// machine-readable allocation hint, not prose. Everything else (headings,
// tables, lists, code, blockquotes) is rendered by the shared rich Markdown
// renderer + mdStyles, identical to how Reports render — replacing the old
// bold-only renderer that flattened tables and lists to plain text.
function cleanAnswer(text) {
  return (text || '').replace(/```sleeve[\s\S]*?```/g, '').trim();
}

export default function AnalystScreen() {
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);   // {label, steps, tool_calls, cost_usd}
  const [result, setResult] = useState(null);        // {answer, tool_calls, verification, cost_usd, model}
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const run = useCallback(async () => {
    const q = (question || '').trim();
    if (q.length < 4) { setError('Ask a real question.'); return; }
    try { haptics.onPressPrimary?.(); } catch {}
    setRunning(true); setError(null); setResult(null);
    setProgress({ label: 'Starting…', steps: 0, tool_calls: [], cost_usd: 0 });
    const t0 = Date.now();
    try {
      const d0 = await api.startAgentic(q);
      if (!d0.ok) throw new Error(d0.error || 'Failed to start');
      const jobId = d0.job_id;
      pollRef.current = setInterval(async () => {
        if (Date.now() - t0 > 180000) {   // 3-min cap
          stopPoll(); setRunning(false); setError('Timed out after 3 min.'); return;
        }
        try {
          const d = await api.getAgentic(jobId);
          if (d.status === 'done' && d.result) {
            stopPoll(); setRunning(false); setProgress(null); setResult(d.result);
          } else if (d.status === 'error') {
            stopPoll(); setRunning(false); setError(d.label || d.error || 'failed');
          } else {
            setProgress({ label: d.label || 'Working…', steps: d.steps || 0,
                          tool_calls: d.tool_calls || [], cost_usd: d.cost_usd || 0 });
          }
        } catch (_) { /* transient */ }
      }, 1400);
    } catch (e) {
      setRunning(false); setError(String(e?.message || e));
    }
  }, [question]);

  const renderVerification = (v) => {
    if (!v) return null;
    if (v.verdict === 'clean') {
      return (
        <View style={[styles.verifyBox, styles.verifyClean]}>
          <Text style={styles.verifyCleanTxt}>✓ Verified — every numeric claim is backed by a tool call.</Text>
        </View>
      );
    }
    if (v.verdict === 'unchecked') {
      return (
        <View style={[styles.verifyBox, styles.verifyNeutral]}>
          <Text style={styles.verifyNeutralTxt}>⚠ Verification did not run.</Text>
        </View>
      );
    }
    return (
      <View style={[styles.verifyBox, styles.verifyWarn]}>
        <Text style={styles.verifyWarnTitle}>⚠ Flagged {(v.flags || []).length} claim(s) — review before sharing:</Text>
        {(v.flags || []).map((f, i) => (
          <Text key={i} style={styles.verifyWarnItem}>
            • <Text style={{ fontWeight: '700' }}>{f.issue || 'flag'}:</Text> {f.claim || ''}
            {f.note ? `  (${f.note})` : ''}
          </Text>
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.brand}>🤖  AI Analyst</Text>
        <Text style={styles.brandSub}>agentic · pulls live data + your reports · {ANALYST_BUILD}</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled">

          <TextInput
            style={styles.input}
            placeholder="Ask a research question — e.g. compare NVDA and AMD on valuation and catalysts using our reports."
            placeholderTextColor={colors.midGray}
            value={question}
            onChangeText={setQuestion}
            multiline
            editable={!running}
          />

          <TouchableOpacity
            style={[styles.runBtn, running && styles.runBtnDisabled]}
            onPress={run} disabled={running} activeOpacity={0.85}>
            {running
              ? <ActivityIndicator color={colors.navy} />
              : <Text style={styles.runBtnTxt}>🤖  Analyze</Text>}
          </TouchableOpacity>

          {!running && !result && (
            <View style={styles.examples}>
              {EXAMPLES.map((ex, i) => (
                <TouchableOpacity key={i} style={styles.exChip} onPress={() => setQuestion(ex)}>
                  <Text style={styles.exChipTxt}>{ex}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {error ? (
            <Card style={styles.errCard}><Text style={styles.errTxt}>❌ {error}</Text></Card>
          ) : null}

          {progress ? (
            <Card style={styles.progCard}>
              <View style={styles.progHead}>
                <ActivityIndicator size="small" color={colors.gold} />
                <Text style={styles.progLabel} numberOfLines={2}>{progress.label}</Text>
              </View>
              <Text style={styles.progMeta}>
                {progress.steps} steps
                {progress.cost_usd ? `  ·  $${Number(progress.cost_usd).toFixed(3)}` : ''}
              </Text>
              {(progress.tool_calls || []).slice(-6).map((tc, i) => (
                <Text key={i} style={styles.toolLine}>
                  {(TOOL_ICON[tc.tool] || '🔧')} {tc.tool}
                  {tc.input ? `  ${JSON.stringify(tc.input).slice(0, 40)}` : ''}
                </Text>
              ))}
            </Card>
          ) : null}

          {result ? (
            <Card style={styles.resultCard}>
              <Markdown style={mdStyles}>{cleanAnswer(result.answer)}</Markdown>
              {renderVerification(result.verification)}
              {(result.tool_calls || []).length ? (
                <View style={styles.toolChips}>
                  {Array.from(new Set((result.tool_calls || []).map(t => t.tool))).map((t, i) => (
                    <View key={i} style={styles.toolChip}>
                      <Text style={styles.toolChipTxt}>{(TOOL_ICON[t] || '🔧')} {t}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={styles.resultMeta}>
                {result.cost_usd != null ? `💸 $${Number(result.cost_usd).toFixed(3)}` : ''}
                {result.model ? `  ·  ${result.model}` : ''}
              </Text>
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.offWhite },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.md },
  brand: { fontSize: fontSize.xl, fontWeight: '800', color: colors.navy, letterSpacing: -0.3 },
  brandSub: { fontSize: fontSize.small, color: colors.midGray, marginTop: 2 },

  input: {
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.lightGray,
    borderRadius: radius.md, padding: spacing.md, fontSize: fontSize.body,
    color: colors.navy, minHeight: 80, textAlignVertical: 'top',
  },
  runBtn: {
    marginTop: spacing.md, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 13, alignItems: 'center', justifyContent: 'center',
  },
  runBtnDisabled: { opacity: 0.7 },
  runBtnTxt: { color: colors.navy, fontWeight: '800', fontSize: fontSize.body, letterSpacing: 0.3 },

  examples: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  exChip: {
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.lightGray,
    borderRadius: radius.pill, paddingVertical: 7, paddingHorizontal: 12,
  },
  exChipTxt: { fontSize: fontSize.small, color: colors.midGray },

  errCard: { marginTop: spacing.lg, padding: spacing.md, borderColor: colors.red, borderWidth: 1 },
  errTxt: { color: colors.red, fontSize: fontSize.body },

  progCard: { marginTop: spacing.lg, padding: spacing.md },
  progHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progLabel: { flex: 1, fontSize: fontSize.body, fontWeight: '700', color: colors.navy },
  progMeta: { fontSize: fontSize.caption, color: colors.midGray, marginTop: 4, fontVariant: ['tabular-nums'] },
  toolLine: { fontSize: fontSize.caption, color: colors.midGray, marginTop: 4 },

  resultCard: { marginTop: spacing.lg, padding: spacing.lg },

  verifyBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  verifyClean: { backgroundColor: '#ecfdf5', borderColor: '#bbf7d0' },
  verifyCleanTxt: { color: '#047857', fontSize: fontSize.small },
  verifyNeutral: { backgroundColor: '#f1f5f9', borderColor: colors.lightGray },
  verifyNeutralTxt: { color: colors.midGray, fontSize: fontSize.small },
  verifyWarn: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  verifyWarnTitle: { color: '#92400e', fontSize: fontSize.small, fontWeight: '700', marginBottom: 4 },
  verifyWarnItem: { color: '#92400e', fontSize: fontSize.caption, marginTop: 2, lineHeight: 17 },

  toolChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  toolChip: { backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: colors.lightGray, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8 },
  toolChipTxt: { fontSize: fontSize.caption, color: colors.midGray },
  resultMeta: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.midGray, fontVariant: ['tabular-nums'] },
});
