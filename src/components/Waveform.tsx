import React, { useEffect, useRef } from 'react';
import { DrumEvent, Section, SyncData } from '../types';
import { engine } from '../lib/AudioEngine';
import { AuditionMode } from './StemStudio';

interface Props {
  sync: SyncData;
  isPlaying: boolean;
  duration: number;
  drumBuffer?: AudioBuffer | null;
  drumEvents?: DrumEvent[];
  auditionMode?: AuditionMode;
  showDrumMarkers?: boolean;
  sections?: Section[];
}

function drawWaveformPath(
  ctx: CanvasRenderingContext2D,
  buffer: AudioBuffer,
  startTime: number,
  windowSize: number,
  width: number,
  height: number,
  strokeStyle: string
) {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const startSample = Math.floor(startTime * sampleRate);
  const endSample = Math.floor((startTime + windowSize) * sampleRate);

  ctx.beginPath();
  let moved = false;
  const step = Math.max(1, Math.ceil((endSample - startSample) / width));

  for (let i = 0; i < width; i++) {
    let min = 1.0;
    let max = -1.0;
    let hasData = false;
    for (let j = 0; j < step; j++) {
      const idx = startSample + i * step + j;
      if (idx >= 0 && idx < data.length) {
        const datum = data[idx];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
        hasData = true;
      }
    }
    if (hasData) {
      if (!moved) {
        ctx.moveTo(i, height / 2 + max * (height / 2));
        moved = true;
      }
      ctx.lineTo(i, height / 2 + max * (height / 2));
      ctx.lineTo(i, height / 2 + min * (height / 2));
    }
  }
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function Waveform({
  sync,
  isPlaying,
  duration,
  drumBuffer = null,
  drumEvents = [],
  auditionMode = 'mix',
  showDrumMarkers = true,
  sections = [],
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let animationId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      let currentTime = engine.getCurrentTime();
      const buffer = engine.getBuffer();

      if (buffer && engine.getLoop()) {
        currentTime = currentTime % buffer.duration;
      }

      const windowSize = 5;
      const startTime = currentTime - windowSize / 2;

      if (buffer) {
        if (drumBuffer && auditionMode === 'drums') {
          drawWaveformPath(ctx, drumBuffer, startTime, windowSize, width, height, '#10b981');
        } else if (drumBuffer && auditionMode === 'blend') {
          drawWaveformPath(ctx, buffer, startTime, windowSize, width, height, 'rgba(59, 130, 246, 0.35)');
          drawWaveformPath(ctx, drumBuffer, startTime, windowSize, width, height, '#10b981');
        } else {
          drawWaveformPath(ctx, buffer, startTime, windowSize, width, height, '#3b82f6');
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        for (let i = 0; i < width; i++) {
          const amplitude = Math.sin(i * 0.05) * 15 * Math.random();
          ctx.lineTo(i, height / 2 + amplitude);
        }
        ctx.strokeStyle = '#3b82f6';
        ctx.stroke();
      }

      const rootPx = parseFloat(document.documentElement.style.fontSize) || 20;
      const scaleF = rootPx / 16;

      // Draw beat lines
      if (sync.bpm > 0) {
        const secondsPerBeat = 60.0 / sync.bpm;
        const startBeat = Math.ceil((startTime - sync.offset) / secondsPerBeat);

        for (let i = startBeat; i < startBeat + Math.ceil(windowSize / secondsPerBeat) + 2; i++) {
          const beatTime = sync.offset + i * secondsPerBeat;
          if (beatTime > startTime + windowSize) break;
          if (beatTime >= startTime) {
            const x = ((beatTime - startTime) / windowSize) * width;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.strokeStyle = i % 4 === 0 ? '#ef4444' : '#4b5563';
            ctx.lineWidth = i % 4 === 0 ? 2 : 1;
            ctx.stroke();

            ctx.fillStyle = i % 4 === 0 ? '#ef4444' : '#9ca3af';
            ctx.font = `${Math.round(11 * scaleF)}px monospace`;
            const beatNumText = i.toString();
            const textWidth = ctx.measureText(beatNumText).width;
            ctx.fillText(beatNumText, x - textWidth / 2, height - 5);
          }
        }
      }

      // Draw section cues from Song Structure & Sections (sticky label + white text with dark outline)
      if (sync.bpm > 0 && sections.length > 0) {
        const beatDur = 60.0 / sync.bpm;
        const pxPerSec = width / windowSize;
        const endTime = startTime + windowSize;
        const sorted = [...sections].sort((a, b) => a.beat - b.beat);

        ctx.save();
        ctx.font = `bold ${Math.round(10 * scaleF)}px monospace`;
        ctx.lineJoin = 'round';

        for (let idx = 0; idx < sorted.length; idx++) {
          const sec = sorted[idx];
          const sTime = sync.offset + sec.beat * beatDur;
          const nextTime =
            idx + 1 < sorted.length
              ? sync.offset + sorted[idx + 1].beat * beatDur
              : Infinity;

          if (nextTime < startTime || sTime > endTime) continue;

          const sX = (sTime - startTime) * pxPerSec;
          const nextX = nextTime < Infinity ? (nextTime - startTime) * pxPerSec : Infinity;

          if (sX >= -2 && sX <= width + 2) {
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([3, 3]);
            ctx.moveTo(sX, 0);
            ctx.lineTo(sX, height);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }

          const label = (sec.label || `Section ${idx + 1}`).trim();
          const textWidth = ctx.measureText(label).width;
          let labelX = Math.max(6, sX + 5);
          if (nextTime < Infinity) {
            labelX = Math.min(labelX, nextX - textWidth - 8);
          }

          const minVisibleBound = Math.max(0, sX);
          if (labelX >= minVisibleBound - 2 && nextX - labelX >= 20) {
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
            ctx.strokeText(label, labelX, 13);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, labelX, 13);
          }
        }
        ctx.restore();
      }

      // Draw lane-mapped transient markers (Hats -> Claps at bottom -> Custom/Tom -> Kicks at center on top)
      if (showDrumMarkers && drumEvents.length > 0) {
        const endTime = startTime + windowSize;
        const colorHex: Record<string, string> = {
          amber: '#f59e0b',
          emerald: '#34d399',
          sky: '#38bdf8',
          pink: '#ec4899',
          violet: '#a78bfa',
        };
        ctx.font = `bold ${Math.round(9.5 * scaleF)}px monospace`;
        const drawMarker = (ev: DrumEvent, yTop: number, barH: number, textY: number) => {
          const x = ((ev.time - startTime) / windowSize) * width;
          const fallbackColor =
            ev.band === 'kick' ? '#f59e0b' : ev.band === 'snare' ? '#34d399' : ev.band === 'hat' ? '#38bdf8' : '#ec4899';
          const fill = (ev.color && colorHex[ev.color]) || fallbackColor;
          const badge = ev.badge || (ev.band === 'kick' ? 'K' : ev.band === 'snare' ? 'C' : ev.band === 'hat' ? 'H' : 'T');
          ctx.fillStyle = fill;
          ctx.fillRect(x - 1.5, yTop, 3, barH);
          ctx.fillText(badge, x + 3, textY);
        };

        for (const ev of drumEvents) {
          if (ev.time < startTime || ev.time > endTime) continue;
          if (ev.band === 'hat') drawMarker(ev, 4, 14, 14);
        }
        for (const ev of drumEvents) {
          if (ev.time < startTime || ev.time > endTime) continue;
          if (ev.band === 'snare') drawMarker(ev, height - 22, 18, height - 8);
        }
        for (const ev of drumEvents) {
          if (ev.time < startTime || ev.time > endTime) continue;
          if (ev.band !== 'kick' && ev.band !== 'snare' && ev.band !== 'hat') {
            drawMarker(ev, 20, 16, 31);
          }
        }
        for (const ev of drumEvents) {
          if (ev.time < startTime || ev.time > endTime) continue;
          if (ev.band === 'kick') drawMarker(ev, height / 2 - 12, 24, height / 2 - 2);
        }
      }

      // Draw playhead
      const playheadX = ((currentTime - startTime) / windowSize) * width;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationId);
  }, [sync, isPlaying, duration, drumBuffer, drumEvents, auditionMode, showDrumMarkers, sections]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-24 bg-black block"
      width={800}
      height={96}
    />
  );
}
