// Build tag — bump on every JS change so we can verify the OTA landed.
// Shown in the screen header so the device tells us which bundle is loaded.
const PODCAST_BUILD = 'pc-v3-tap-debug-20260523';

/**
 * PodcastScreen — DGA HiTech Podcast player (mobile)
 *
 * Lists all generated episodes (from /api/podcast/list) and plays the
 * selected one via expo-audio. Streams from the auth-bypassed
 * /api/podcast/{TICKER}/audio.mp3 endpoint (whitelisted server-side
 * so the player doesn't need to attach tokens to the audio URL).
 *
 * Cast (display only — backend owns the voice mapping):
 *   Alec    — host         (onyx)
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

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function PodcastScreen() {
  const insets = useSafeAreaInsets();
  const [episodes, setEpisodes] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [lastErr,  setLastErr]  = useState(null);

  // Create player ONCE with null source — we'll feed it new URLs via
  // player.replace(). This is more reliable than re-running useAudioPlayer
  // with a changing source (the hook's source-change behavior is opaque
  // and was the leading suspect for "tap but nothing happens").
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  // ── Enable iOS silent-mode playback (otherwise nothing plays when the
  //    ringer switch is off).
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: true,
      interruptionMode: 'mixWithOthers',
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
    // FIRST LINE: force player card visible + show tap feedback so we know
    // the touch registered, even if everything downstream fails.
    setSelectedTicker(ep.ticker);
    setLastErr(`TAP ${ep.ticker} · ${PODCAST_BUILD}`);
    try { haptics.light(); } catch {}
    // Tap the SAME row → toggle play/pause
    if (selectedTicker === ep.ticker) {
      try {
        if (status?.playing) player.pause();
        else                 player.play();
      } catch (e) { setLastErr(`toggle: ${e?.message || e}`); }
      return;
    }
    // New episode: build URL, probe reachability, then replace + play
    // (setSelectedTicker already called at function top)
    const url = await api.getPodcastAudioUrl(ep.ticker);
    setAudioUrl(url);
    console.log('[podcast] loading', ep.ticker, '→', url);

    // Probe with HEAD so we can show user a precise error if it 404s/401s
    try {
      const r = await fetch(url, { method: 'HEAD' });
      console.log('[podcast] HEAD', r.status, 'ct=', r.headers?.get?.('content-type'));
      if (!r.ok) {
        setLastErr(`HTTP ${r.status} fetching audio`);
        return;
      }
    } catch (e) {
      setLastErr(`net: ${e?.message || e}`);
      return;
    }

    // Hand the new URL to the existing player + play
    try {
      player.replace({ uri: url });
    } catch (e) {
      setLastErr(`replace: ${e?.message || e}`);
      return;
    }
    // play() is safe to call right after replace() in expo-audio v1 —
    // the player buffers + starts when ready
    try {
      player.play();
    } catch (e) {
      setLastErr(`play: ${e?.message || e}`);
    }
  }, [selectedTicker, player, status]);

  const handleSeek = useCallback((deltaSec) => {
    if (!status || !status.duration) return;
    const target = Math.max(0, Math.min(status.duration, (status.currentTime || 0) + deltaSec));
    try { player.seekTo(target); } catch (e) { console.warn('[podcast] seek failed:', e?.message); }
    haptics.light();
  }, [player, status]);

  const handleTogglePlay = useCallback(() => {
    if (!player) return;
    haptics.light();
    try {
      if (status?.playing) player.pause();
      else                 player.play();
    } catch (e) { console.warn('[podcast] toggle failed:', e?.message); }
  }, [player, status]);

  const renderEpisode = ({ item }) => {
    const isActive = item.ticker === selectedTicker;
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
            {item.ticker}
            {item.duration_sec ? (
              <Text style={styles.epMeta}>  ·  {fmtDuration(item.duration_sec)}</Text>
            ) : null}
          </Text>
          <Text style={styles.epTitle} numberOfLines={1}>
            {item.title || `${item.ticker}: Bull vs Bear`}
          </Text>
          <Text style={styles.epSub}>
            {fmtAgo(item.generated_at)}
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
        <Text style={styles.brandSub}>Rock vs Claudia · Alec calls it · {PODCAST_BUILD}</Text>
      </View>

      {/* Active episode player (sticky at top once a ticker is selected) */}
      {selectedTicker ? (
        <Card style={styles.playerCard}>
          <Text style={styles.playerTicker}>{selectedTicker}</Text>
          <Text style={styles.playerTitle} numberOfLines={1}>
            {(episodes.find(e => e.ticker === selectedTicker)?.title) || `${selectedTicker}: Bull vs Bear`}
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
          keyExtractor={(item) => item.ticker}
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
