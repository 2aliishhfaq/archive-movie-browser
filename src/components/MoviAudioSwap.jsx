import React, { useEffect, useRef, useState } from 'react';
import { Languages, Loader2, Maximize, Pause, Play } from 'lucide-react';

// Load the pinned, slim Movi build only after the viewer explicitly asks to switch audio.
// Native HTML5 remains the default playback path; the WASM engine is used only for muxed
// multi-audio track access (notably in Chrome/Edge, where HTMLMediaElement.audioTracks is absent).
const MOVI_MODULE = 'https://cdn.jsdelivr.net/npm/movi-player@0.4.1/dist/element.slim.js';
const MOVI_WASM = 'https://cdn.jsdelivr.net/npm/movi-player@0.4.1/dist/movi.wasm';

const formatTime = (value = 0) => {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function MoviAudioSwap({ src, startAt = 0, autoPlay = true, onPlayer, onTimeUpdate, onPause, onFallback }) {
  const elementRef = useRef(null);
  const [tracks, setTracks] = useState([]);
  const [selected, setSelected] = useState('');
  const [time, setTime] = useState(startAt);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('Loading audio tracks…');
  const callbacks = useRef({});
  callbacks.current = { onPlayer, onTimeUpdate, onPause, onFallback };

  useEffect(() => {
    let cancelled = false;
    let player;
    let restored = false;
    let trackCheckTimer;
    const updateTracks = () => {
      if (!player || cancelled || typeof player.getAudioLangs !== 'function') return;
      const available = player.getAudioLangs() || [];
      const normalized = available
        .filter(track => track && track.lang)
        .map(track => ({ lang: String(track.lang), label: track.label || track.lang, active: !!track.active }));
      setTracks(normalized);
      const active = normalized.find(track => track.active) || normalized[0];
      if (active) setSelected(active.lang);
      setMessage(normalized.length > 1 ? '' : 'No alternate audio tracks found in this video.');
      if (normalized.length > 1 && trackCheckTimer) clearTimeout(trackCheckTimer);
    };
    const restorePlayback = () => {
      if (!player || cancelled || restored || !Number.isFinite(player.duration)) return;
      restored = true;
      if (startAt > 0) {
        try { player.currentTime = Math.min(startAt, Math.max(0, player.duration - 1)); } catch { /* wait for seekable range */ }
      }
      setDuration(Number(player.duration) || 0);
      setTime(Number(player.currentTime) || 0);
      setLoading(false);
      if (autoPlay) player.play?.().catch?.(() => {});
      updateTracks();
    };
    const onTick = () => {
      if (!player || cancelled) return;
      setTime(Number(player.currentTime) || 0);
      setDuration(Number(player.duration) || 0);
      callbacks.current.onTimeUpdate?.();
    };
    const onError = () => {
      if (!cancelled) {
        setLoading(false);
        setMessage('Audio player could not open this file. Returning to native playback…');
        callbacks.current.onFallback?.(Number(player?.currentTime) || startAt);
      }
    };

    (async () => {
      try {
        await import(/* @vite-ignore */ MOVI_MODULE);
        if (cancelled) return;
        player = elementRef.current;
        if (!player) return;
        player.setAttribute('engine', 'wasm');
        player.setAttribute('wasmurl', MOVI_WASM);
        player.setAttribute('preload', 'metadata');
        player.setAttribute('playsinline', '');
        player.src = src;
        callbacks.current.onPlayer?.(player);
        player.addEventListener('loadedmetadata', restorePlayback);
        player.addEventListener('loadeddata', restorePlayback);
        player.addEventListener('trackschange', updateTracks);
        player.addEventListener('timeupdate', onTick);
        player.addEventListener('pause', () => callbacks.current.onPause?.());
        player.addEventListener('error', onError);
        player.addEventListener('errordisplay', onError);
        player.addEventListener('canplay', restorePlayback);
        trackCheckTimer = setTimeout(() => {
          if (!cancelled && tracks.length < 2) callbacks.current.onFallback?.(Number(player.currentTime) || startAt);
        }, 4500);
      } catch {
        callbacks.current.onFallback?.(startAt);
      }
    })();

    return () => {
      cancelled = true;
      if (trackCheckTimer) clearTimeout(trackCheckTimer);
      if (player) {
        player.removeEventListener('loadedmetadata', restorePlayback);
        player.removeEventListener('loadeddata', restorePlayback);
        player.removeEventListener('trackschange', updateTracks);
        player.removeEventListener('timeupdate', onTick);
        player.removeEventListener('error', onError);
        player.removeEventListener('errordisplay', onError);
        player.pause?.();
      }
    };
  }, [src, startAt, autoPlay]);

  const switchAudio = async (language) => {
    const player = elementRef.current;
    if (!player || !language || typeof player.selectAudioLang !== 'function') return;
    try {
      await player.selectAudioLang(language);
      setSelected(language);
    } catch {
      setMessage('Could not switch this audio track.');
    }
  };

  const togglePlay = () => {
    const player = elementRef.current;
    if (!player) return;
    if (player.paused) player.play?.().catch?.(() => {});
    else player.pause?.();
  };

  return (
    <div className="absolute inset-0 bg-black">
      <movi-player
        ref={elementRef}
        src={src}
        engine="wasm"
        wasmurl={MOVI_WASM}
        preload="metadata"
        playsinline
        className="block h-full w-full bg-black"
        style={{ width: '100%', height: '100%' }}
        aria-label="Movie audio-switch player"
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/70 text-white text-sm pointer-events-none">
          <Loader2 className="h-5 w-5 animate-spin" /> Preparing audio tracks…
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/95 to-black/50 px-3 py-3 text-white">
        <button type="button" onClick={togglePlay} className="rounded p-1.5 hover:bg-white/15" aria-label="Play or pause">
          {elementRef.current?.paused === false ? <Pause size={19} /> : <Play size={19} />}
        </button>
        <span className="font-mono text-xs tabular-nums">{formatTime(time)}</span>
        <input
          aria-label="Seek video"
          className="min-w-0 flex-1 accent-white"
          type="range"
          min="0"
          max={Math.max(1, duration)}
          step="1"
          value={Math.min(time, duration || 0)}
          onChange={event => { if (elementRef.current) elementRef.current.currentTime = Number(event.target.value); }}
        />
        <span className="font-mono text-xs tabular-nums">{formatTime(duration)}</span>
        {tracks.length > 1 ? (
          <label className="flex items-center gap-1.5 text-xs">
            <Languages size={17} />
            <select
              aria-label="Audio language"
              className="max-w-28 bg-black/80 text-white rounded px-1.5 py-1"
              value={selected}
              onChange={event => switchAudio(event.target.value)}
            >
              {tracks.map(track => <option key={track.lang} value={track.lang}>{track.label}</option>)}
            </select>
          </label>
        ) : (
          <span className="max-w-32 text-[10px] text-white/70">{message || 'Checking audio…'}</span>
        )}
        <button
          type="button"
          onClick={() => elementRef.current?.requestFullscreen?.()}
          className="rounded p-1.5 hover:bg-white/15"
          aria-label="Fullscreen"
        >
          <Maximize size={19} />
        </button>
      </div>
    </div>
  );
}
