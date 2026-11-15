import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Repeat,
  SkipBack,
} from 'lucide-react';
import { engine } from '../lib/AudioEngine';
import { SyncData } from '../types';
import { cn } from '../lib/utils';

interface Props {
  sync: SyncData;
  duration: number;
  isPlaying: boolean;
  isLooping: boolean;
  hasAudio: boolean;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
}

function formatClock(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, '0')}.${tenths}`;
}

function formatTotal(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function GlobalTransport({
  sync,
  duration,
  isPlaying,
  isLooping,
  hasAudio,
  onTogglePlay,
  onToggleLoop,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeTextRef = useRef<HTMLSpanElement>(null);
  const beatTextRef = useRef<HTMLSpanElement>(null);

  const isDraggingRef = useRef(false);
  const dragTimeRef = useRef(0);
  const lastLiveSeekMsRef = useRef(0);

  const [hoverInfo, setHoverInfo] = useState<{ pct: number; time: number; beat: number } | null>(null);

  const safeDuration = Math.max(0.01, duration || 180);
  const secondsPerBeat = 60.0 / (sync.bpm || 120);

  const getWrappedTime = () => {
    let t = engine.getCurrentTime();
    const buf = engine.getBuffer();
    if (buf && engine.getLoop() && buf.duration > 0) {
      t = ((t % buf.duration) + buf.duration) % buf.duration;
    }
    return Math.max(0, Math.min(safeDuration, t));
  };

  useEffect(() => {
    let rafId = 0;

    const updateReadout = () => {
      const t = isDraggingRef.current ? dragTimeRef.current : getWrappedTime();
      const pct = Math.max(0, Math.min(100, (t / safeDuration) * 100));

      if (fillRef.current) {
        fillRef.current.style.width = `${pct}%`;
      }
      if (thumbRef.current) {
        thumbRef.current.style.left = `${pct}%`;
      }
      if (timeTextRef.current) {
        timeTextRef.current.textContent = `${formatClock(t)} / ${formatTotal(safeDuration)}`;
      }
      if (beatTextRef.current) {
        const beat = (t - sync.offset) / secondsPerBeat;
        beatTextRef.current.textContent = `B${beat.toFixed(1)}`;
      }

      rafId = requestAnimationFrame(updateReadout);
    };

    rafId = requestAnimationFrame(updateReadout);
    return () => cancelAnimationFrame(rafId);
  }, [safeDuration, secondsPerBeat, sync.offset, isPlaying]);

  const timeFromClientX = (clientX: number): { time: number; pct: number } => {
    const el = trackRef.current;
    if (!el) return { time: 0, pct: 0 };
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return { time: pct * safeDuration, pct: pct * 100 };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasAudio) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    const { time } = timeFromClientX(e.clientX);
    dragTimeRef.current = time;
    engine.seek(time);
    lastLiveSeekMsRef.current = performance.now();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { time, pct } = timeFromClientX(e.clientX);
    const beat = (time - sync.offset) / secondsPerBeat;
    setHoverInfo({ pct, time, beat });

    if (!isDraggingRef.current || !hasAudio) return;
    dragTimeRef.current = time;

    const now = performance.now();
    if (!engine.getIsPlaying() || now - lastLiveSeekMsRef.current > 95) {
      engine.seek(time);
      lastLiveSeekMsRef.current = now;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const { time } = timeFromClientX(e.clientX);
    dragTimeRef.current = time;
    isDraggingRef.current = false;
    if (hasAudio) {
      engine.seek(time);
    }
  };

  const stepBars = (bars: number) => {
    if (!hasAudio) return;
    const cur = getWrappedTime();
    const target = Math.max(0, Math.min(safeDuration, cur + bars * 4 * secondsPerBeat));
    engine.seek(target);
  };

  return (
    <div
      className="min-w-0 flex-1 flex items-center gap-2.5 px-3 py-1.5 bg-gray-900 border border-gray-800 rounded-lg"
      aria-label="Global Song Transport"
    >
      {/* Compact Transport Controls */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => hasAudio && engine.seek(0)}
          disabled={!hasAudio}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 transition-colors"
          title="Restart (0:00)"
        >
          <SkipBack className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={() => stepBars(-1)}
          disabled={!hasAudio}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 transition-colors"
          title="Jump back 1 bar (4 beats)"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!hasAudio}
          className={cn(
            'w-7 h-7 flex items-center justify-center rounded-md transition-colors shrink-0 disabled:opacity-40',
            isPlaying
              ? 'bg-emerald-500 text-gray-950 hover:bg-emerald-400'
              : 'bg-gray-800 text-emerald-400 hover:bg-gray-700 hover:text-emerald-300'
          )}
          title="Play / Pause (Space)"
        >
          {isPlaying ? (
            <Pause className="w-3.5 h-3.5 fill-current" />
          ) : (
            <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => stepBars(1)}
          disabled={!hasAudio}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 transition-colors"
          title="Jump forward 1 bar (4 beats)"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onToggleLoop}
          className={cn(
            'p-1.5 rounded transition-colors',
            isLooping
              ? 'text-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25'
              : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800'
          )}
          title={isLooping ? 'Loop: ON' : 'Loop: OFF'}
        >
          <Repeat className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Interactive Timeline Scrubber */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => setHoverInfo(null)}
        role="slider"
        aria-label="Seek audio position"
        aria-valuemin={0}
        aria-valuemax={Math.round(safeDuration)}
        className={cn(
          'relative min-w-[72px] flex-1 h-7 flex items-center select-none touch-none group',
          hasAudio ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
        )}
      >
        <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            ref={fillRef}
            className="h-full bg-emerald-500 transition-none"
            style={{ width: '0%' }}
          />
        </div>

        {/* Hover preview tick */}
        {hoverInfo && hasAudio && (
          <>
            <div
              className="pointer-events-none absolute top-1.5 bottom-1.5 w-px bg-white/40"
              style={{ left: `${hoverInfo.pct}%` }}
            />
            <div
              className="pointer-events-none absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 rounded bg-gray-950 border border-gray-800 text-[10px] font-mono tabular-nums text-gray-200 whitespace-nowrap shadow-md"
              style={{ left: `${Math.min(92, Math.max(8, hoverInfo.pct))}%` }}
            >
              {formatClock(hoverInfo.time)} · B{hoverInfo.beat.toFixed(1)}
            </div>
          </>
        )}

        {/* Playhead thumb */}
        <div
          ref={thumbRef}
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-emerald-400 shadow-sm group-hover:scale-125 transition-transform"
          style={{ left: '0%' }}
        />
      </div>

      {/* Time & Beat Readout */}
      <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono tabular-nums whitespace-nowrap shrink-0">
        <span ref={timeTextRef} className="text-gray-200">
          0:00.0 / {formatTotal(safeDuration)}
        </span>
        <span className="text-gray-600" aria-hidden="true">
          ·
        </span>
        <span ref={beatTextRef} className="text-emerald-400 min-w-[44px] text-right">
          B0.0
        </span>
      </div>
    </div>
  );
}
