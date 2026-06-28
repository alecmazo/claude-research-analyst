// ─────────────────────────────────────────────────────────────────────────────
// AnalystScreen — 🤖 AI Analyst (agentic)
// Mirrors the web "AI Analyst": ask an open-ended research question; Claude
// runs a tool-use loop over platform data (live quotes, saved Grok/Claude
// reports, SEC financials, news, reconciled YTD) and answers with cited
// numbers. A verification pass audits every numeric claim. GP-only — uses
// the v2 session token that api.request() attaches automatically.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { api } from '../api/client';
import { spacing, radius, fontSize, Card, haptics, makeMdStyles, useTheme } from '../design';

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
  const { theme: t } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const md = useMemo(() => makeMdStyles(t), [t]);
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
        <Text style={s.brand}>🤖  AI Analyst</Text>
        <Text style={s.brandSub}>agentic · pulls live data + your reports · {ANALYST_BUILD}</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled">

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
              : <Text style={s.runBtnTxt}>🤖  Analyze</Text>}
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
              <Markdown style={md}>{cleanAnswer(result.answer)}</Markdown>
              {renderVerification(result.verification)}
              {(result.tool_calls || []).length ? (
                <View style={s.toolChips}>
                  {Array.from(new Set((result.tool_calls || []).map(t => t.tool))).map((t, i) => (
                    <View key={i} style={s.toolChip}>
                      <Text style={s.toolChipTxt}>{(TOOL_ICON[t] || '🔧')} {t}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={s.resultMeta}>
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

function makeStyles(t) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.md },
  brand: { fontSize: fontSize.xl, fontWeight: '800', color: t.textPrimary, letterSpacing: -0.3 },
  brandSub: { fontSize: fontSize.small, color: t.textSecondary, marginTop: 2 },

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

  verifyBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  verifyClean: { backgroundColor: t.pillUpBg, borderColor: t.pillUpBg },
  verifyCleanTxt: { color: t.pillUpFg, fontSize: fontSize.small },
  verifyNeutral: { backgroundColor: t.surfaceAlt, borderColor: t.border },
  verifyNeutralTxt: { color: t.textSecondary, fontSize: fontSize.small },
  verifyWarn: { backgroundColor: t.surfaceAlt, borderColor: t.amber },
  verifyWarnTitle: { color: t.amber, fontSize: fontSize.small, fontWeight: '700', marginBottom: 4 },
  verifyWarnItem: { color: t.amber, fontSize: fontSize.caption, marginTop: 2, lineHeight: 17 },

  toolChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  toolChip: { backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8 },
  toolChipTxt: { fontSize: fontSize.caption, color: t.textSecondary },
  resultMeta: { marginTop: spacing.md, fontSize: fontSize.caption, color: t.textSecondary, fontVariant: ['tabular-nums'] },
});
}
