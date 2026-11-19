import React, { useEffect, useRef, useState } from 'react';
import { BarChart2, ChevronDown, ChevronUp, X } from 'lucide-react';
import { engine } from '../lib/AudioEngine';
import { cn } from '../lib/utils';

interface Props {
  isPlaying: boolean;
  hasAudio: boolean;
  hasDrumStem: boolean;
  onSoloBandChange?: (band: { minHz: number; maxHz: number } | null) => void;
}

type SpectrumMode = 'bars' | 'landscape';
type SpectrumSource = 'output' | 'drums';

const MIN_FREQ = 30;
const MAX_FREQ = 16000;
const LOG_MIN = Math.log(MIN_FREQ);
const LOG_MAX = Math.log(MAX_FREQ);

const GRID_FREQS = [
  { hz: 40, label: '40' },
  { hz: 100, label: '100' },
  { hz: 250, label: '250' },
  { hz: 1000, label: '1k' },
  { hz: 4000, label: '4k' },
  { hz: 12000, label: '12k' },
];

const BAND_ZONES = [
  { label: 'Kick', minHz: 35, maxHz: 140, color: '#f59e0b' },
  { label: 'Tom', minHz: 110, maxHz: 300, color: '#ec4899' },
  { label: 'Clap/Snare', minHz: 180, maxHz: 2500, color: '#34d399' },
  { label: 'Hat', minHz: 4500, maxHz: 16000, color: '#38bdf8' },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToX(hz: number, width: number): number {
  const clamped = Math.max(MIN_FREQ, Math.min(MAX_FREQ, hz));
  return ((Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * width;
}

function xToFreq(x: number, width: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  return Math.exp(LOG_MIN + ratio * (LOG_MAX - LOG_MIN));
}

function freqToNoteLabel(hz: number): string {
  if (hz < 20) return '';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const note = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}

function colorForFreq(hz: number): string {
  if (hz < 120) return '#f59e0b'; // Kick amber
  if (hz < 280) return '#ec4899'; // Tom low-mid pink
  if (hz < 2600) return '#34d399'; // Snare/Clap emerald
  if (hz < 4500) return '#94a3b8'; // Transition slate
  return '#38bdf8'; // Hi-hat sky blue
}

export function SpectrumVisualizer({ isPlaying, hasAudio, hasDrumStem, onSoloBandChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [collapsed, setCollapsed] = useState(true);
  const [mode, setMode] = useState<SpectrumMode>('bars');
  const [source, setSource] = useState<SpectrumSource>('output');
  const [showBands, setShowBands] = useState(true);
  const [hoverFreq, setHoverFreq] = useState<number | null>(null);
  const [peakFreq, setPeakFreq] = useState<number | null>(null);
  const [soloBand, setSoloBand] = useState<{ minHz: number; maxHz: number } | null>(null);
  const [cursorStyle, setCursorStyle] = useState<'crosshair' | 'ew-resize' | 'grab' | 'grabbing'>('crosshair');

  const activeSource: SpectrumSource = hasDrumStem ? source : 'output';

  // Persistent visual buffers so pausing keeps the last visible frame
  const barsCount = 72;
  const colsCount = 96;
  const historyRows = 26;

  const peaksRef = useRef<Float32Array>(new Float32Array(barsCount));
  const lastBarsRef = useRef<Float32Array>(new Float32Array(barsCount));
  const historyRef = useRef<Float32Array[]>([]);
  const lastHistoryPushMsRef = useRef(0);
  const peakReadoutTickRef = useRef(0);

  const dragRef = useRef<{
    mode: 'new' | 'move' | 'resize-left' | 'resize-right';
    startX: number;
    moved: boolean;
    anchorHz: number;
    initBand: { minHz: number; maxHz: number } | null;
  } | null>(null);

  const applySoloBand = (next: { minHz: number; maxHz: number } | null) => {
    setSoloBand(next);
    engine.setSoloBand(next);
    onSoloBandChange?.(next);
  };

  useEffect(() => {
    if (!soloBand) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        applySoloBand(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [soloBand]);

  useEffect(() => {
    return () => {
      engine.setSoloBand(null);
    };
  }, []);

  // Sync canvas backing size cleanly with container width
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || collapsed) return;

    const updateSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = Math.max(320, Math.floor(container.clientWidth));
      const cssH = 116;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [collapsed]);

  useEffect(() => {
    if (collapsed) return;

    let rafId = 0;
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    const colValues = new Float32Array(colsCount);

    const render = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      ctx.save();
      ctx.scale(dpr, dpr);

      // Pure black studio canvas
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      const bottomPad = showBands ? 24 : 14;
      const topPad = 8;
      const plotH = Math.max(24, height - bottomPad - topPad);

      // Subtle horizontal dB guides
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (const frac of [0.25, 0.5, 0.75]) {
        const y = topPad + plotH * frac;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Logarithmic vertical frequency grid lines
      const rootPx = parseFloat(document.documentElement.style.fontSize) || 20;
      const scaleF = rootPx / 16;
      const gridPx = Math.round(10 * scaleF);
      const bandPx = Math.round(9 * scaleF);

      ctx.font = `${gridPx}px monospace`;
      ctx.textAlign = 'center';
      for (const g of GRID_FREQS) {
        const gx = freqToX(g.hz, width);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(gx, topPad);
        ctx.lineTo(gx, topPad + plotH);
        ctx.stroke();

        ctx.fillStyle = 'rgba(156,163,175,0.78)';
        ctx.fillText(g.label, gx, height - (showBands ? 14 : 3));
      }

      // Optional drum-band brackets along the bottom edge
      if (showBands) {
        ctx.font = `${bandPx}px monospace`;
        for (let idx = 0; idx < BAND_ZONES.length; idx++) {
          const z = BAND_ZONES[idx];
          const x0 = freqToX(z.minHz, width);
          const x1 = freqToX(z.maxHz, width);
          const yBase = height - 4 - (idx === 1 ? 7 : 0); // Offset Tom slightly so Kick/Tom overlap stays readable
          ctx.strokeStyle = z.color;
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x0, yBase - 2);
          ctx.lineTo(x0, yBase);
          ctx.lineTo(x1, yBase);
          ctx.lineTo(x1, yBase - 2);
          ctx.stroke();

          ctx.fillStyle = z.color;
          ctx.textAlign = 'center';
          ctx.fillText(z.label, (x0 + x1) / 2, yBase - 2);
          ctx.globalAlpha = 1;
        }
      }

      // Sample AnalyserNode if audio is playing
      const analyser = engine.getAnalyser(activeSource);
      const sampleRate = engine.getSampleRate();
      let maxVal = 0;
      let maxHz = 0;

      if (analyser && isPlaying && hasAudio) {
        const binCount = analyser.frequencyBinCount;
        if (!freqData || freqData.length !== binCount) {
          freqData = new Uint8Array(new ArrayBuffer(binCount));
        }
        analyser.getByteFrequencyData(freqData);
        const hzPerBin = sampleRate / (binCount * 2);

        const targetCount = mode === 'bars' ? barsCount : colsCount;
        const outBuf = mode === 'bars' ? lastBarsRef.current : colValues;

        for (let i = 0; i < targetCount; i++) {
          const f0 = Math.exp(LOG_MIN + (i / targetCount) * (LOG_MAX - LOG_MIN));
          const f1 = Math.exp(LOG_MIN + ((i + 1) / targetCount) * (LOG_MAX - LOG_MIN));
          const b0 = Math.max(1, Math.floor(f0 / hzPerBin));
          const b1 = Math.min(binCount - 1, Math.max(b0, Math.ceil(f1 / hzPerBin)));

          let peak = 0;
          for (let b = b0; b <= b1; b++) {
            const v = freqData[b] / 255;
            if (v > peak) peak = v;
          }
          outBuf[i] = peak;

          if (peak > maxVal) {
            maxVal = peak;
            maxHz = Math.sqrt(f0 * f1);
          }

          if (mode === 'bars') {
            if (peak >= peaksRef.current[i]) {
              peaksRef.current[i] = peak;
            } else {
              peaksRef.current[i] = Math.max(0, peaksRef.current[i] - 0.012);
            }
          }
        }

        if (now - peakReadoutTickRef.current > 120) {
          peakReadoutTickRef.current = now;
          setPeakFreq(maxVal > 0.08 ? maxHz : null);
        }

        if (mode === 'landscape' && now - lastHistoryPushMsRef.current >= 32) {
          lastHistoryPushMsRef.current = now;
          const slice = new Float32Array(colValues);
          historyRef.current.push(slice);
          if (historyRef.current.length > historyRows) {
            historyRef.current.shift();
          }
        }
      } else if (!isPlaying && mode === 'bars') {
        // Slowly settle peak dots even when paused cleanly
        for (let i = 0; i < barsCount; i++) {
          if (peaksRef.current[i] > lastBarsRef.current[i]) {
            peaksRef.current[i] = Math.max(lastBarsRef.current[i], peaksRef.current[i] - 0.008);
          }
        }
      }

      if (mode === 'bars') {
        const bars = lastBarsRef.current;
        const peaks = peaksRef.current;
        const slotW = width / barsCount;
        const barW = Math.max(2, slotW - 2);

        for (let i = 0; i < barsCount; i++) {
          const val = bars[i];
          const peak = peaks[i];
          const centerHz = Math.exp(LOG_MIN + ((i + 0.5) / barsCount) * (LOG_MAX - LOG_MIN));
          const colColor = colorForFreq(centerHz);
          const x = i * slotW + 1;

          if (val > 0.01) {
            const barH = Math.max(2, val * plotH);
            const y = topPad + plotH - barH;
            ctx.fillStyle = colColor;
            ctx.globalAlpha = 0.25 + val * 0.65;
            ctx.fillRect(x, y, barW, barH);
            ctx.globalAlpha = 1;
          }

          if (peak > 0.02) {
            const py = topPad + plotH - peak * plotH;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x, Math.max(topPad, py - 2), barW, 2);
          }
        }
      } else {
        // Landscape Mode: rolling dot-matrix waterfall terrain (newest back-horizon -> oldest front-bottom foreground)
        const slices = historyRef.current;
        const total = slices.length;
        const baseY = topPad + plotH;

        // Iterate newest (horizon, back) -> oldest (foreground, front) for proper painter occlusion
        for (let r = total - 1; r >= 0; r--) {
          const slice = slices[r];
          const ageRatio = total > 1 ? (total - 1 - r) / (total - 1) : 0; // 0 = newest (horizon), 1 = oldest (foreground)
          const invAge = 1 - ageRatio; // 1 at horizon, 0 at foreground
          const rowBaseY = baseY - invAge * (plotH * 0.52);
          const xInset = invAge * width * 0.055;
          const rowWidth = width - xInset * 2;
          const rowGain = (0.2 + invAge * 1.5) * (plotH * 0.48);
          const intensityBoost = 0.65 + ageRatio * 0.35; // Crisp bright entry right at the horizon

          // Occlusion silhouette so advancing foreground ridges cleanly sit over horizon behind
          ctx.beginPath();
          ctx.moveTo(xInset, rowBaseY);
          for (let c = 0; c < colsCount; c++) {
            const cx = xInset + (c / (colsCount - 1)) * rowWidth;
            const cy = rowBaseY - slice[c] * rowGain;
            ctx.lineTo(cx, cy);
          }
          ctx.lineTo(xInset + rowWidth, rowBaseY);
          ctx.closePath();
          ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
          ctx.fill();

          // Subtle ridge hairline connecting the slice
          ctx.beginPath();
          for (let c = 0; c < colsCount; c++) {
            const cx = xInset + (c / (colsCount - 1)) * rowWidth;
            const cy = rowBaseY - slice[c] * rowGain;
            if (c === 0) ctx.moveTo(cx, cy);
            else ctx.lineTo(cx, cy);
          }
          ctx.strokeStyle = `rgba(148, 163, 184, ${(0.08 + intensityBoost * 0.24).toFixed(2)})`;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Luminous dot peaks across bass -> treble advancing forward from horizon
          for (let c = 0; c < colsCount; c++) {
            const amp = slice[c];
            if (amp < 0.03) continue;
            const cx = xInset + (c / (colsCount - 1)) * rowWidth;
            const cy = rowBaseY - amp * rowGain;
            const centerHz = Math.exp(LOG_MIN + (c / (colsCount - 1)) * (LOG_MAX - LOG_MIN));
            ctx.fillStyle = colorForFreq(centerHz);
            ctx.globalAlpha = Math.min(1, 0.25 + intensityBoost * 0.65 + amp * 0.25);
            const dotR = 1.0 + ageRatio * 0.9 + amp * 0.95;
            ctx.beginPath();
            ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }

      // Solo band highlight & muted outer regions
      if (soloBand) {
        const sx0 = Math.max(0, freqToX(soloBand.minHz, width));
        const sx1 = Math.min(width, freqToX(soloBand.maxHz, width));

        // Dim muted frequency sectors outside the soloed slice
        ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
        if (sx0 > 0) ctx.fillRect(0, topPad, sx0, plotH);
        if (sx1 < width) ctx.fillRect(sx1, topPad, width - sx1, plotH);

        // Subtle passband highlight
        ctx.fillStyle = 'rgba(16, 185, 129, 0.09)';
        ctx.fillRect(sx0, topPad, Math.max(1, sx1 - sx0), plotH);

        // Solo boundary handles
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx0, topPad);
        ctx.lineTo(sx0, topPad + plotH);
        ctx.moveTo(sx1, topPad);
        ctx.lineTo(sx1, topPad + plotH);
        ctx.stroke();

        // Compact min/max Hz badges at top corners of the passband
        ctx.font = `bold ${Math.round(10 * scaleF)}px monospace`;
        ctx.fillStyle = '#34d399';
        const minLabel = formatHz(soloBand.minHz);
        const maxLabel = formatHz(soloBand.maxHz);
        if (sx1 - sx0 > 95) {
          ctx.textAlign = 'left';
          ctx.fillText(minLabel, sx0 + 4, topPad + 11);
          ctx.textAlign = 'right';
          ctx.fillText(maxLabel, sx1 - 4, topPad + 11);
        } else {
          ctx.textAlign = sx0 > width * 0.65 ? 'right' : 'left';
          const anchorX = sx0 > width * 0.65 ? sx0 - 4 : sx1 + 4;
          ctx.fillText(`${minLabel}–${maxLabel}`, anchorX, topPad + 11);
        }
      }

      // Hover crosshair indicator
      if (hoverFreq !== null && !dragRef.current) {
        const hx = freqToX(hoverFreq, width);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, topPad);
        ctx.lineTo(hx, topPad + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [collapsed, mode, activeSource, showBands, isPlaying, hasAudio, hoverFreq, soloBand]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    e.currentTarget.setPointerCapture(e.pointerId);

    if (soloBand) {
      const sx0 = freqToX(soloBand.minHz, rect.width);
      const sx1 = freqToX(soloBand.maxHz, rect.width);
      if (Math.abs(x - sx0) <= 7) {
        dragRef.current = { mode: 'resize-left', startX: x, moved: false, anchorHz: soloBand.maxHz, initBand: soloBand };
        setCursorStyle('ew-resize');
        return;
      }
      if (Math.abs(x - sx1) <= 7) {
        dragRef.current = { mode: 'resize-right', startX: x, moved: false, anchorHz: soloBand.minHz, initBand: soloBand };
        setCursorStyle('ew-resize');
        return;
      }
      if (x > sx0 + 7 && x < sx1 - 7) {
        dragRef.current = { mode: 'move', startX: x, moved: false, anchorHz: xToFreq(x, rect.width), initBand: soloBand };
        setCursorStyle('grabbing');
        return;
      }
    }

    const hz = xToFreq(x, rect.width);
    dragRef.current = { mode: 'new', startX: x, moved: false, anchorHz: hz, initBand: null };
    setCursorStyle('ew-resize');
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const hz = xToFreq(x, rect.width);
    setHoverFreq(hz);

    const drag = dragRef.current;
    if (!drag) {
      if (soloBand) {
        const sx0 = freqToX(soloBand.minHz, rect.width);
        const sx1 = freqToX(soloBand.maxHz, rect.width);
        if (Math.abs(x - sx0) <= 7 || Math.abs(x - sx1) <= 7) {
          setCursorStyle('ew-resize');
        } else if (x > sx0 + 7 && x < sx1 - 7) {
          setCursorStyle('grab');
        } else {
          setCursorStyle('crosshair');
        }
      } else {
        setCursorStyle('crosshair');
      }
      return;
    }

    if (Math.abs(x - drag.startX) >= 4) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    if (drag.mode === 'new') {
      const fLow = Math.min(drag.anchorHz, hz);
      const fHigh = Math.max(drag.anchorHz, hz);
      applySoloBand({
        minHz: Math.max(MIN_FREQ, fLow),
        maxHz: Math.min(MAX_FREQ, Math.max(fHigh, fLow * 1.06)),
      });
    } else if (drag.mode === 'resize-left' && drag.initBand) {
      const fLow = Math.max(MIN_FREQ, Math.min(hz, drag.initBand.maxHz * 0.92));
      applySoloBand({ minHz: fLow, maxHz: drag.initBand.maxHz });
    } else if (drag.mode === 'resize-right' && drag.initBand) {
      const fHigh = Math.min(MAX_FREQ, Math.max(hz, drag.initBand.minHz * 1.08));
      applySoloBand({ minHz: drag.initBand.minHz, maxHz: fHigh });
    } else if (drag.mode === 'move' && drag.initBand) {
      const initX0 = freqToX(drag.initBand.minHz, rect.width);
      const initX1 = freqToX(drag.initBand.maxHz, rect.width);
      const spanPx = initX1 - initX0;
      const dx = x - drag.startX;
      const clampedX0 = Math.max(0, Math.min(rect.width - spanPx, initX0 + dx));
      const clampedX1 = clampedX0 + spanPx;
      applySoloBand({
        minHz: xToFreq(clampedX0, rect.width),
        maxHz: xToFreq(clampedX1, rect.width),
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!drag.moved) {
      // Single click clears any active solo band
      applySoloBand(null);
    }
    dragRef.current = null;
    setCursorStyle('crosshair');
  };

  const hoverBand =
    hoverFreq !== null
      ? BAND_ZONES.find((z) => hoverFreq >= z.minHz && hoverFreq <= z.maxHz)?.label
      : undefined;

  return (
    <section
      ref={containerRef}
      aria-label="Frequency Spectrum Analyzer"
    >
      <div className="flex items-center justify-between gap-1 py-0.5 flex-nowrap">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:text-white transition-colors"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand spectrum analyzer' : 'Collapse spectrum analyzer'}
        >
          <BarChart2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-200 whitespace-nowrap">
            Spectrum
          </span>
          <span className="hidden sm:inline text-xs text-gray-400 font-mono tabular-nums truncate min-w-0">
            {soloBand
              ? `Solo ${formatHz(soloBand.minHz)}–${formatHz(soloBand.maxHz)}`
              : hoverFreq !== null
              ? `${formatHz(hoverFreq)} (${freqToNoteLabel(hoverFreq)})${hoverBand ? ` · ${hoverBand}` : ''}`
              : peakFreq !== null
              ? `Peak ${formatHz(peakFreq)} (${freqToNoteLabel(peakFreq)})`
              : collapsed
              ? 'Collapsed · click to inspect Hz & solo bands'
              : 'Drag to solo band'}
          </span>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {soloBand && (
            <button
              type="button"
              onClick={() => applySoloBand(null)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors whitespace-nowrap"
              title="Clear frequency solo (Esc or click spectrum)"
            >
              <X className="w-3 h-3" />
              <span>Clear Solo</span>
            </button>
          )}

          {!collapsed && (
            <div className="inline-flex items-center gap-0.5">
              {hasDrumStem &&
                (
                  [
                    { id: 'output', label: 'Output' },
                    { id: 'drums', label: 'Drums' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSource(opt.id)}
                    className={cn(
                      'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap',
                      activeSource === opt.id
                        ? 'bg-emerald-500 text-gray-950 font-semibold'
                        : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}

              {(
                [
                  { id: 'bars', label: 'Bars' },
                  { id: 'landscape', label: '3D' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setMode(opt.id)}
                  className={cn(
                    'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap',
                    mode === opt.id
                      ? 'bg-white/10 text-white font-medium'
                      : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                  )}
                >
                  {opt.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setShowBands((v) => !v)}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap',
                  showBands
                    ? 'bg-white/10 text-gray-200'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
                )}
                title="Toggle Kick / Tom / Clap / Hat frequency brackets"
              >
                Bands
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="p-0.5 text-gray-400 hover:text-white rounded-sm hover:bg-white/[0.06] transition-colors"
            title={collapsed ? 'Expand spectrum analyzer' : 'Collapse spectrum analyzer'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="relative bg-black">
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => {
              if (!dragRef.current) setHoverFreq(null);
            }}
            style={{ cursor: cursorStyle }}
            className="block w-full h-[116px] touch-none select-none"
          />
        </div>
      )}
    </section>
  );
}
