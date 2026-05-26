// Build tag — bump on every JS change so we can verify the OTA landed.
// Shown in the screen header so the device tells us which bundle is loaded.
const PODCAST_BUILD = 'pc-v14-prod-date-20260525';

/**
 * PodcastScreen — DGA HiTech Podcast player (mobile)
 *
 * Lists all generated episodes (from /api/podcast/list) and plays the
 * selected one via expo-audio. Streams from the auth-bypassed
 * /api/podcast/{TICKER}/audio.mp3 endpoint (whitelisted server-side
 * so the player doesn't need to attach tokens to the audio URL).
 *
 * Cast (display only — backend owns the voice mapping):
 *   Opus    — host         (onyx)
 *   Rock    — Grok analyst (fable, British inflection)
 *   Claudia — Claude analyst (nova)
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { api } from '../api/client';
import { colors, spacing, radius, shadow, fontSize, letterSpacing, Card, haptics } from '../design';

function fmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// Absolute production date — shows "May 25" or "May 25 '24" so the user
// can see exactly when an episode was made, not just relative time.
function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const mo = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const yr = d.getFullYear();
  const curYr = new Date().getFullYear();
  return yr === curYr ? `${mo} ${day}` : `${mo} ${day} '${String(yr).slice(-2)}`;
}
function fmtWhen(iso) {
  const abs = fmtDateShort(iso);
  const ago = fmtAgo(iso);
  return abs && ago ? `${abs} · ${ago}` : (abs || ago);
}

// ── Bulletproof play/pause toggle ────────────────────────────────────────────
// Calling player.pause()/play() on a player that's still buffering, or whose
// source hasn't fully loaded, has been observed to crash the app on iOS in
// expo-audio v1. This helper:
//   • verifies player + status objects are well-formed before touching them
//   • guards each method call individually so one failing call can't trip up
//     the next one
//   • surfaces any failure to the on-screen diag strip so we can debug
//     without needing Metro logs
function safeSeek(player, status, deltaSec, setLastErr) {
  if (!player || typeof player !== 'object') {
    try { setLastErr('seek: no player'); } catch {}
    return;
  }
  if (!status || status.isLoaded !== true) {
    try { setLastErr('seek: still loading…'); } catch {}
    return;
  }
  const dur = typeof status.duration === 'number' ? status.duration : 0;
  if (!dur) {
    try { setLastErr('seek: no duration'); } catch {}
    return;
  }
  const cur = typeof status.currentTime === 'number' ? status.currentTime : 0;
  const target = Math.max(0, Math.min(dur, cur + deltaSec));
  if (typeof player.seekTo !== 'function') {
    try { setLastErr('seek: no seekTo method'); } catch {}
    return;
  }
  try {
    // expo-audio's seekTo returns a Promise — if we don't catch its
    // rejection it would surface as an unhandled native exception and
    // crash the app on iOS.
    const r = player.seekTo(target);
    if (r && typeof r.catch === 'function') {
      r.catch((e) => { try { setLastErr(`seek: ${e?.message || e}`); } catch {} });
    }
  } catch (e) {
    try { setLastErr(`seek: ${e?.message || e}`); } catch {}
  }
}

function safeToggle(player, status, setLastErr) {
  if (!player || typeof player !== 'object') {
    try { setLastErr('toggle: no player'); } catch {}
    return;
  }
  // Avoid touching the player at all if its source isn't loaded yet —
  // pausing a non-loaded player has been the suspected crash trigger.
  if (!status || status.isLoaded !== true) {
    try { setLastErr('toggle: still loading…'); } catch {}
    return;
  }
  try {
    if (status.playing === true) {
      if (typeof player.pause === 'function') player.pause();
    } else {
      if (typeof player.play === 'function')  player.play();
    }
  } catch (e) {
    try { setLastErr(`toggle: ${e?.message || e}`); } catch {}
  }
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Synthetic ticker keys for multi-ticker formats (Roundup, Portfolio Roundup)
// look like "PORTFOLIO_27TICKERS_1779758656" or "ROUNDUP_NVDA,INTC,AMD".
// Shorten them for display — keep the raw key for routing / API calls.
function shortTicker(raw) {
  if (!raw) return '';
  const s = String(raw);
  // PORTFOLIO_<n>TICKERS_<ts> → "Portfolio · 27 names"
  let m = s.match(/^PORTFOLIO_(\d+)TICKERS?_\d+$/i);
  if (m) return `Portfolio · ${m[1]} names`;
  // PORTFOLIO_<TICKER,TICKER,...> (legacy)
  m = s.match(/^PORTFOLIO_(.+)$/i);
  if (m) {
    const names = m[1].split(',').filter(Boolean);
    return names.length <= 3
      ? `Portfolio · ${names.join(', ')}`
      : `Portfolio · ${names.length} names`;
  }
  // ROUNDUP_<TICKER,TICKER,...>
  m = s.match(/^ROUNDUP_(.+)$/i);
  if (m) {
    const names = m[1].split(',').filter(Boolean);
    return names.length <= 4
      ? `Roundup · ${names.join(', ')}`
      : `Roundup · ${names.length} names`;
  }
  return s;   // plain single ticker — already short
}

// Clean an episode title that may also contain the synthetic key.
function cleanTitle(title, ticker, format) {
  if (!title) return shortTicker(ticker) + (format ? ` · ${format.replace(/_/g, ' ')}` : '');
  // Drop "TICKER:format" prefix shapes
  let t = String(title).trim();
  if (t.includes(':')) {
    const [head, tail] = t.split(':', 2);
    if (head && head.trim().toUpperCase() === String(ticker).toUpperCase()) {
      t = tail.trim();
    }
  }
  // If the title IS the raw key, shorten it.
  if (/^PORTFOLIO_\d+TICKERS?_\d+/i.test(t) || /^PORTFOLIO_[A-Z0-9,.\-]+$/i.test(t)) {
    return shortTicker(t);
  }
  return t;
}

export default function PodcastScreen() {
  const insets = useSafeAreaInsets();
  const [episodes, setEpisodes] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Compound key — ticker AND format. A single ticker can have multiple
  // episodes (one per format: debate, pre_mortem, memo, catalysts, quick_hit,
  // portfolio_roundup). Keying off ticker alone made the screen highlight
  // ALL formats for the same ticker on tap.
  const [selectedKey, setSelectedKey] = useState(null);   // "TICKER::format"
  const [audioUrl, setAudioUrl] = useState(null);
  const [lastErr,  setLastErr]  = useState(null);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Helper — compound key builder. Falls back to 'debate' for legacy rows
  // that don't have a format yet.
  const epKey = (ep) => (ep ? `${ep.ticker}::${ep.format || 'debate'}` : null);
  const selectedEp = () =>
    episodes.find((e) => epKey(e) === selectedKey) || null;

  // Create player ONCE with null source — we'll feed it new URLs via
  // player.replace(). This is more reliable than re-running useAudioPlayer
  // with a changing source (the hook's source-change behavior is opaque
  // and was the leading suspect for "tap but nothing happens").
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  // ── Load saved playback rate on mount ──────────────────────────
  useEffect(() => {
    AsyncStorage.getItem('dga_podcast_rate')
      .then((v) => {
        const n = parseFloat(v || '1');
        if (n && n >= 0.5 && n <= 2.5) setPlaybackRate(n);
      })
      .catch(() => {});
  }, []);

  // ── Apply rate to player whenever it changes (or audio reloads) ──
  useEffect(() => {
    if (!player) return;
    try {
      if (typeof player.setPlaybackRate === 'function') {
        // expo-audio v1: setPlaybackRate(rate, pitchCorrection?)
        player.setPlaybackRate(playbackRate, 'high');
      } else if ('playbackRate' in player) {
        player.playbackRate = playbackRate;
      }
    } catch (e) {
      console.warn('[podcast] setPlaybackRate failed:', e?.message);
    }
  }, [player, playbackRate, audioUrl, status?.isLoaded]);

  const changeRate = useCallback((rate) => {
    setPlaybackRate(rate);
    AsyncStorage.setItem('dga_podcast_rate', String(rate)).catch(() => {});
    try { haptics.light(); } catch {}
  }, []);

  // ── Enable iOS silent-mode playback (otherwise nothing plays when the
  //    ringer switch is off).
  useEffect(() => {
    // Build 19+ has UIBackgroundModes:['audio'] in Info.plist, so iOS
    // allows audio to continue when the screen locks or the app
    // backgrounds. shouldPlayInBackground tells expo-audio to configure
    // the audio session accordingly.
    setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: true,
    })
      .then(() => console.log('[podcast] audio mode set'))
      .catch((e) => {
        const msg = e?.message || String(e);
        console.warn('[podcast] setAudioModeAsync failed:', msg);
        setLastErr(`audioMode: ${msg}`);
      });
  }, []);

  const loadEpisodes = useCallback(async () => {
    try {
      setError(null);
      const data = await api.listPodcastEpisodes();
      setEpisodes(data.episodes || []);
    } catch (e) {
      setError(e?.message || 'Failed to load episodes');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadEpisodes();
  }, [loadEpisodes]);

  const handleSelect = useCallback(async (ep) => {
    const key = epKey(ep);
    const fmt = ep.format || 'debate';
    // FIRST LINE: force player card visible + show tap feedback so we know
    // the touch registered, even if everything downstream fails.
    setSelectedKey(key);
    setLastErr(`TAP ${ep.ticker} (${fmt})`);
    try { haptics.light(); } catch {}
    // Tap the SAME (ticker, format) → toggle play/pause
    if (selectedKey === key) {
      safeToggle(player, status, setLastErr);
      return;
    }
    // New episode: build format-aware URL → replace → play
    const url = await api.getPodcastAudioUrl(ep.ticker, fmt);
    setAudioUrl(url);
    console.log('[podcast] loading', key, '→', url);

    try {
      player.replace({ uri: url });
    } catch (e) {
      setLastErr(`replace: ${e?.message || e}`);
      return;
    }
    try {
      player.play();
    } catch (e) {
      setLastErr(`play: ${e?.message || e}`);
    }
  }, [selectedKey, player, status, episodes]);

  const handleSeek = useCallback((deltaSec) => {
    try { haptics.light(); } catch {}
    safeSeek(player, status, deltaSec, setLastErr);
  }, [player, status]);

  const handleTogglePlay = useCallback(() => {
    try { haptics.light(); } catch {}
    safeToggle(player, status, setLastErr);
  }, [player, status]);

  // Format icon for the row label — visually distinguishes Debate / Pre-Mortem
  // / Memo / Catalysts / Quick Hit / Roundup / Portfolio Roundup at a glance.
  const FORMAT_ICON = {
    debate:            '⚔️',
    pre_mortem:        '🪦',
    memo:              '📋',
    catalysts:         '📅',
    quick_hit:         '⚡',
    roundup:           '📰',
    portfolio_roundup: '🧰',
  };

  const renderEpisode = ({ item }) => {
    const key = epKey(item);
    const isActive = key === selectedKey;
    const fmt = item.format || 'debate';
    const ic = FORMAT_ICON[fmt] || '';
    return (
      <TouchableOpacity
        onPress={() => handleSelect(item)}
        activeOpacity={0.7}
        style={[styles.epRow, isActive && styles.epRowActive]}
      >
        <View style={[styles.epIcon, isActive && styles.epIconActive]}>
          <MaterialCommunityIcons
            name={isActive && status?.playing ? 'pause' : 'play'}
            size={20}
            color={isActive ? colors.navy : colors.white}
          />
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text style={styles.epTicker}>
            {shortTicker(item.ticker)} {ic}
            {item.duration_sec ? (
              <Text style={styles.epMeta}>  ·  {fmtDuration(item.duration_sec)}</Text>
            ) : null}
          </Text>
          <Text style={styles.epTitle} numberOfLines={1}>
            {cleanTitle(item.title, item.ticker, item.format)}
          </Text>
          <Text style={styles.epSub}>
            {fmtWhen(item.generated_at)}
            {item.cost_usd != null ? `  ·  $${Number(item.cost_usd).toFixed(2)}` : ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.brand}>🎙️  DGA HiTech</Text>
        <Text style={styles.brandSub}>Rock vs Claudia · Opus calls it · {PODCAST_BUILD}</Text>
      </View>

      {/* Active episode player (sticky at top once an episode is selected) */}
      {selectedKey ? (
        <Card style={styles.playerCard}>
          <Text style={styles.playerTicker}>
            {shortTicker(selectedEp()?.ticker || selectedKey.split('::')[0])}
            {'  '}
            <Text style={{ fontSize: 12, opacity: 0.7 }}>
              {FORMAT_ICON[selectedEp()?.format || 'debate'] || ''}
            </Text>
            {selectedEp()?.generated_at ? (
              <Text style={{ fontSize: 11, opacity: 0.65, fontWeight: '600' }}>
                {'   '}📅 {fmtDateShort(selectedEp()?.generated_at)}
              </Text>
            ) : null}
          </Text>
          <Text style={styles.playerTitle} numberOfLines={1}>
            {cleanTitle(selectedEp()?.title, selectedEp()?.ticker, selectedEp()?.format)}
          </Text>
          {/* Diagnostic strip — temporary until playback is reliable */}
          <Text style={styles.diag} numberOfLines={2}>
            {lastErr
              ? `⚠ ${lastErr}`
              : status?.isLoaded
                ? `▸ loaded · ${status.playing ? 'PLAYING' : 'paused'} · ${Math.round(status.duration || 0)}s`
                : `⏳ loading audio…  url: ${(audioUrl || '').replace(/^https?:\/\//, '')}`}
          </Text>
          <View style={styles.scrubRow}>
            <Text style={styles.scrubTime}>{fmtDuration(status?.currentTime || 0)}</Text>
            <View style={styles.scrubTrack}>
              <View
                style={[
                  styles.scrubFill,
                  { width: `${Math.min(100, ((status?.currentTime || 0) / (status?.duration || 1)) * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.scrubTime}>{fmtDuration(status?.duration || 0)}</Text>
          </View>
          <View style={styles.controlsRow}>
            <TouchableOpacity onPress={() => handleSeek(-15)} style={styles.ctrlBtn}>
              <MaterialCommunityIcons name="rewind-15" size={28} color={colors.white} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleTogglePlay} style={styles.playBtn}>
              <MaterialCommunityIcons
                name={status?.playing ? 'pause' : 'play'}
                size={36}
                color={colors.navy}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleSeek(30)} style={styles.ctrlBtn}>
              <MaterialCommunityIcons name="fast-forward-30" size={28} color={colors.white} />
            </TouchableOpacity>
          </View>

          {/* Playback speed control */}
          <View style={styles.speedRow}>
            <Text style={styles.speedLabel}>SPEED</Text>
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => {
              const active = Math.abs(playbackRate - r) < 0.01;
              return (
                <TouchableOpacity
                  key={r}
                  onPress={() => changeRate(r)}
                  style={[styles.speedBtn, active && styles.speedBtnActive]}
                >
                  <Text style={[styles.speedBtnTxt, active && styles.speedBtnTxtActive]}>
                    {r}×
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>
      ) : null}

      {/* Episode list */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.gold} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); loadEpisodes(); }} style={styles.retryBtn}>
            <Text style={styles.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : episodes.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="podcast" size={48} color={colors.midGray} />
          <Text style={styles.emptyTitle}>No episodes yet</Text>
          <Text style={styles.emptySub}>
            Generate one from the web app (LLM Lab → Podcast → Generate audio).
          </Text>
        </View>
      ) : (
        <FlatList
          data={episodes}
          keyExtractor={(item) => epKey(item)}
          renderItem={renderEpisode}
          contentContainerStyle={{ paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadEpisodes(); }}
              tintColor={colors.gold}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.offWhite },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  brand:    { color: colors.navy, fontSize: fontSize.xl, fontWeight: '800', letterSpacing: -0.3 },
  brandSub: { color: colors.midGray, fontSize: fontSize.caption, marginTop: 2 },

  // Player card (navy)
  playerCard: {
    backgroundColor: colors.navy,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    ...shadow.hero,
  },
  playerTicker: {
    color: colors.gold,
    fontSize: fontSize.hero,
    fontWeight: '800',
    letterSpacing: letterSpacing.ticker,
  },
  playerTitle: {
    color: colors.white,
    fontSize: fontSize.body,
    fontWeight: '600',
    marginTop: 2,
    opacity: 0.85,
  },
  diag: {
    color: '#84CCE3', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6, opacity: 0.85,
  },
  scrubRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: spacing.lg, gap: spacing.md,
  },
  scrubTime: {
    color: colors.white, fontSize: fontSize.caption, opacity: 0.7,
    minWidth: 38, textAlign: 'center',
  },
  scrubTrack: {
    flex: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2, overflow: 'hidden',
  },
  scrubFill: { height: '100%', backgroundColor: colors.gold },
  controlsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: spacing.lg, gap: spacing.xl,
  },
  ctrlBtn: { padding: spacing.sm },
  playBtn: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: colors.gold,
    alignItems: 'center', justifyContent: 'center', ...shadow.card,
  },

  // Speed buttons
  speedRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: spacing.lg, gap: 6, flexWrap: 'wrap',
  },
  speedLabel: {
    color: '#84CCE3', fontSize: 10, fontWeight: '700',
    letterSpacing: 1, marginRight: 4,
  },
  speedBtn: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
    borderWidth: 1, borderColor: '#84CCE3', backgroundColor: 'transparent',
  },
  speedBtnActive: { backgroundColor: '#5BB8D4', borderColor: '#5BB8D4' },
  speedBtnTxt: { color: '#84CCE3', fontSize: 11, fontWeight: '700' },
  speedBtnTxtActive: { color: '#0A1628' },

  // Episode rows
  epRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.xl, paddingVertical: spacing.lg,
    backgroundColor: colors.panel,
  },
  epRowActive: { backgroundColor: '#fffbeb' },
  epIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
  },
  epIconActive: { backgroundColor: colors.gold },
  epTicker: {
    color: colors.navy, fontSize: fontSize.lg, fontWeight: '800',
    letterSpacing: letterSpacing.ticker,
  },
  epMeta: { color: colors.midGray, fontSize: fontSize.small, fontWeight: '500' },
  epTitle: { color: colors.navy, fontSize: fontSize.small, marginTop: 2 },
  epSub:   { color: colors.midGray, fontSize: fontSize.caption, marginTop: 2 },
  sep:     { height: 1, backgroundColor: colors.lightGray, marginHorizontal: spacing.xl },

  // States
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  emptyTitle:{ color: colors.navy, fontSize: fontSize.lg, fontWeight: '700', marginTop: spacing.md },
  emptySub:  { color: colors.midGray, fontSize: fontSize.small, textAlign: 'center', marginTop: spacing.sm },
  errorText: { color: colors.red, fontSize: fontSize.body, textAlign: 'center' },
  retryBtn:  { marginTop: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
               backgroundColor: colors.navy, borderRadius: radius.md },
  retryTxt:  { color: colors.white, fontWeight: '700', letterSpacing: letterSpacing.button },
});
