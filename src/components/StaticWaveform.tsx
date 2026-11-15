import React, { useEffect, useRef, useState } from 'react';
import { Undo2, RotateCcw } from 'lucide-react';
import {
  DrumEvent,
  DrumLaneRule,
  LaneColor,
  LaneIndex,
  ManualNoteEdits,
  Section,
  SyncData,
} from '../types';
import { engine } from '../lib/AudioEngine';
import { DEFAULT_LANE_RULES, getEffectiveAltLane } from '../lib/drumAnalysis';
import { AuditionMode } from './StemStudio';
import { cn } from '../lib/utils';

type GridEditMode = 'pan' | 'edit';
type SnapDivision = 4 | 8 | 16 | 'free';

interface Props {
  sync: SyncData;
  setSync: (fn: (prev: SyncData) => SyncData) => void;
  buffer: AudioBuffer | null;
  duration: number;
  drumBuffer?: AudioBuffer | null;
  drumEvents?: DrumEvent[];
  auditionMode?: AuditionMode;
  showDrumMarkers?: boolean;
  sections?: Section[];
  laneRules?: DrumLaneRule[];
  manualEdits?: ManualNoteEdits;
  onToggleNoteAt?: (payload: {
    existingEvent?: DrumEvent;
    time: number;
    beat: number;
    rule: DrumLaneRule;
    lane: LaneIndex;
  }) => void;
  onUndoEdit?: () => void;
  canUndoEdit?: boolean;
  onResetEdits?: () => void;
}

function drawStaticPath(
  ctx: CanvasRenderingContext2D,
  buf: AudioBuffer,
  viewStart: number,
  viewEnd: number,
  width: number,
  height: number,
  zoom: number,
  strokeStyle: string
) {
  const data = buf.getChannelData(0);
  const sampleRate = buf.sampleRate;
  const startSample = Math.floor(viewStart * sampleRate);
  const endSample = Math.floor(viewEnd * sampleRate);

  ctx.beginPath();
  let moved = false;
  const step = Math.ceil((endSample - startSample) / width);
  if (step > 0) {
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
  void zoom;
}

export function StaticWaveform({
  sync,
  setSync,
  buffer,
  duration,
  drumBuffer = null,
  drumEvents = [],
  auditionMode = 'mix',
  showDrumMarkers = true,
  sections = [],
  laneRules = DEFAULT_LANE_RULES,
  manualEdits = { suppressions: [], additions: [] },
  onToggleNoteAt,
  onUndoEdit,
  canUndoEdit = false,
  onResetEdits,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [zoom, setZoom] = useState(100);
  const [scrollTime, setScrollTime] = useState(0);
  const [cursor, setCursor] = useState('default');
  const [editMode, setEditMode] = useState<GridEditMode>('pan');
  const [snapDivision, setSnapDivision] = useState<SnapDivision>(16);
  const [brushRuleId, setBrushRuleId] = useState<string>('kick');

  const zoomRef = useRef(zoom);
  const scrollTimeRef = useRef(scrollTime);
  const syncRef = useRef(sync);
  const editModeRef = useRef(editMode);
  const snapRef = useRef(snapDivision);
  const brushRuleRef = useRef<DrumLaneRule>(
    laneRules.find((r) => r.id === brushRuleId) || laneRules[0] || DEFAULT_LANE_RULES[0]
  );
  const hoverStateRef = useRef<{
    x: number;
    y: number;
    matchedEvent: DrumEvent | null;
    snapTime: number;
    snapBeat: number;
    targetLane: LaneIndex;
  } | null>(null);

  const activeBrushRule =
    laneRules.find((r) => r.id === brushRuleId) || laneRules[0] || DEFAULT_LANE_RULES[0];

  zoomRef.current = zoom;
  scrollTimeRef.current = scrollTime;
  syncRef.current = sync;
  editModeRef.current = editMode;
  snapRef.current = snapDivision;
  brushRuleRef.current = activeBrushRule;

  const getN = (offset: number, bpm: number, dur: number) => {
    if (bpm <= 0) return 4;
    const beatDur = 60 / bpm;
    const maxBeats = Math.floor((dur - offset) / beatDur);
    return Math.max(4, Math.floor(maxBeats / 4) * 4);
  };

  const [dragState, setDragState] = useState<{
    type: 'start' | 'half' | 'end' | 'pan';
    startX: number;
    initialTime: number;
    initialBpm?: number;
    initialOffset?: number;
    lockedN?: number;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      const z = zoomRef.current;
      const st = scrollTimeRef.current;

      const timeAtMouse = st + mouseX / z;
      const zoomFactor = e.deltaY > 0 ? 0.8 : 1.25;
      const newZoom = Math.max(10, Math.min(z * zoomFactor, 5000));

      const newScrollTime = timeAtMouse - mouseX / newZoom;
      setZoom(newZoom);
      setScrollTime(newScrollTime);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      const currentSync = syncRef.current;
      const st = currentSync.offset;
      const bpm = currentSync.bpm;
      const n = dragState?.lockedN ?? getN(st, bpm, duration);
      const end = st + n * (60 / bpm);
      const half = st + (n / 2) * (60 / bpm);

      const viewStart = scrollTimeRef.current;
      const viewEnd = viewStart + width / zoomRef.current;

      if (buffer) {
        if (drumBuffer && auditionMode === 'drums') {
          drawStaticPath(ctx, drumBuffer, viewStart, viewEnd, width, height, zoomRef.current, '#10b981');
        } else if (drumBuffer && auditionMode === 'blend') {
          drawStaticPath(ctx, buffer, viewStart, viewEnd, width, height, zoomRef.current, 'rgba(79, 70, 229, 0.35)');
          drawStaticPath(ctx, drumBuffer, viewStart, viewEnd, width, height, zoomRef.current, '#10b981');
        } else {
          drawStaticPath(ctx, buffer, viewStart, viewEnd, width, height, zoomRef.current, '#4f46e5');
        }
      }

      if (bpm > 0) {
        const beatDur = 60 / bpm;
        const beatPx = beatDur * zoomRef.current;
        const labelStep = beatPx >= 24 ? 1 : beatPx >= 8 ? 4 : beatPx >= 3 ? 16 : 32;
        const firstBeat = Math.ceil((viewStart - st) / beatDur);
        const lastBeat = Math.floor((viewEnd - st) / beatDur);

        ctx.font = '12px monospace';
        ctx.lineJoin = 'round';
        for (let i = firstBeat; i <= lastBeat; i++) {
          const t = st + i * beatDur;
          const x = (t - viewStart) * zoomRef.current;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.strokeStyle = i % 4 === 0 ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)';
          ctx.lineWidth = i % 4 === 0 ? 1 : 0.5;
          ctx.stroke();

          if (i % labelStep === 0) {
            const beatNumText = i.toString();
            const textWidth = ctx.measureText(beatNumText).width;
            const textX = x - textWidth / 2;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.strokeText(beatNumText, textX, height - 5);
            ctx.fillStyle = i % 4 === 0 ? '#ef4444' : '#9ca3af';
            ctx.fillText(beatNumText, textX, height - 5);
          }
        }
      }

      // Draw color-coded lane markers across the static grid
      if (showDrumMarkers && drumEvents.length > 0) {
        const showLabels = zoomRef.current >= 70;
        const colorHex: Record<string, string> = {
          amber: 'rgba(245, 158, 11, 0.95)',
          emerald: 'rgba(52, 211, 153, 0.9)',
          sky: 'rgba(56, 189, 248, 0.85)',
          pink: 'rgba(236, 72, 153, 0.92)',
          violet: 'rgba(167, 139, 250, 0.92)',
        };
        ctx.font = 'bold 10px monospace';
        const isManualAdd = (ev: DrumEvent) =>
          manualEdits.additions.some(
            (a) => a.band === ev.band && a.lane === ev.lane && Math.abs(a.time - ev.time) <= 0.02
          );

        const drawMarker = (ev: DrumEvent, yTop: number, barH: number, textY: number) => {
          const x = (ev.time - viewStart) * zoomRef.current;
          const fallbackColor =
            ev.band === 'kick'
              ? 'rgba(245, 158, 11, 0.95)'
              : ev.band === 'snare'
              ? 'rgba(52, 211, 153, 0.9)'
              : ev.band === 'hat'
              ? 'rgba(56, 189, 248, 0.85)'
              : 'rgba(236, 72, 153, 0.92)';
          ctx.fillStyle = (ev.color && colorHex[ev.color]) || fallbackColor;
          ctx.fillRect(x - 1, yTop, 2.5, barH);
          if (isManualAdd(ev)) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - 2, yTop - 1, 4.5, barH + 2);
          }
          if (showLabels) {
            const badge = ev.badge || (ev.band === 'kick' ? 'K' : ev.band === 'snare' ? 'C' : ev.band === 'hat' ? 'H' : 'T');
            ctx.fillText(badge, x + 3, textY);
          }
        };

        for (const ev of drumEvents) {
          if (ev.time < viewStart || ev.time > endTimeViewSafe(viewEnd)) continue;
          if (ev.band === 'hat') drawMarker(ev, 16, 14, 27);
        }
        for (const ev of drumEvents) {
          if (ev.time < viewStart || ev.time > endTimeViewSafe(viewEnd)) continue;
          if (ev.band === 'snare') drawMarker(ev, height - 20, 18, height - 6);
        }
        for (const ev of drumEvents) {
          if (ev.time < viewStart || ev.time > endTimeViewSafe(viewEnd)) continue;
          if (ev.band !== 'kick' && ev.band !== 'snare' && ev.band !== 'hat') {
            drawMarker(ev, 32, 14, 43);
          }
        }
        for (const ev of drumEvents) {
          if (ev.time < viewStart || ev.time > endTimeViewSafe(viewEnd)) continue;
          if (ev.band === 'kick') drawMarker(ev, height / 2 - 10, 20, height / 2 - 2);
        }
      }

      function endTimeViewSafe(vEnd: number) {
        return vEnd + 0.05;
      }

      // Draw Edit Notes hover target (Remove existing marker OR Add snapped marker)
      if (editModeRef.current === 'edit' && hoverStateRef.current) {
        const hs = hoverStateRef.current;
        const brush = brushRuleRef.current;
        const colorSolid: Record<LaneColor, string> = {
          amber: '#f59e0b',
          emerald: '#34d399',
          sky: '#38bdf8',
          pink: '#ec4899',
          violet: '#a78bfa',
        };
        const bandStrip = (band: string): { yTop: number; barH: number; textY: number } => {
          if (band === 'hat') return { yTop: 16, barH: 14, textY: 27 };
          if (band === 'snare') return { yTop: height - 20, barH: 18, textY: height - 6 };
          if (band === 'kick') return { yTop: height / 2 - 10, barH: 20, textY: height / 2 - 2 };
          return { yTop: 32, barH: 14, textY: 43 };
        };

        if (hs.matchedEvent) {
          const ev = hs.matchedEvent;
          const x = (ev.time - viewStart) * zoomRef.current;
          const strip = bandStrip(ev.band);
          ctx.save();
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2;
          ctx.strokeRect(x - 5, strip.yTop - 3, 11, strip.barH + 6);
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = '#fca5a5';
          ctx.fillText(`-Del ${ev.badge || 'Hit'}`, Math.min(width - 54, x + 8), strip.yTop + 10);
          ctx.restore();
        } else {
          const x = (hs.snapTime - viewStart) * zoomRef.current;
          const strip = bandStrip(brush.id);
          const col = colorSolid[brush.color] || '#ec4899';
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([2, 2]);
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.strokeStyle = `${col}88`;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.72;
          ctx.fillStyle = col;
          ctx.fillRect(x - 1.5, strip.yTop, 3, strip.barH);
          ctx.font = 'bold 10px monospace';
          ctx.fillText(`+${brush.badge}`, Math.min(width - 28, x + 4), strip.textY);
          ctx.restore();
        }
      }

      const drawHandle = (t: number, color: string, label: string) => {
        const x = (t - viewStart) * zoomRef.current;
        if (x >= -20 && x <= width + 20) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x - 14, 0);
          ctx.lineTo(x + 14, 0);
          ctx.lineTo(x, 14);
          ctx.fill();

          ctx.font = 'bold 12px monospace';
          const textWidth = ctx.measureText(label).width;
          const textX = x - textWidth / 2;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
          ctx.strokeText(label, textX, 11);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, textX, 11);
        }
      };

      drawHandle(st, '#10b981', 'Start');
      drawHandle(half, '#eab308', 'Half');
      drawHandle(end, '#ef4444', 'End');

      // Draw section cues from Song Structure & Sections (white text with dark outline)
      if (bpm > 0 && sections.length > 0) {
        const beatDur = 60 / bpm;
        const sorted = [...sections].sort((a, b) => a.beat - b.beat);
        const handleXs = [st, half, end].map((t) => (t - viewStart) * zoomRef.current);

        ctx.save();
        ctx.font = 'bold 11px monospace';
        ctx.lineJoin = 'round';

        for (let idx = 0; idx < sorted.length; idx++) {
          const sec = sorted[idx];
          const sTime = st + sec.beat * beatDur;
          const nextTime =
            idx + 1 < sorted.length
              ? st + sorted[idx + 1].beat * beatDur
              : Infinity;

          if (nextTime < viewStart || sTime > viewEnd) continue;

          const sX = (sTime - viewStart) * zoomRef.current;
          const nextX = nextTime < Infinity ? (nextTime - viewStart) * zoomRef.current : Infinity;

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
          let handleSafeMinX = Math.max(-2, sX - 2);

          // Avoid colliding with Start / Half / End handle triangles at top strip
          for (const hX of handleXs) {
            if (labelX < hX + 20 && labelX + textWidth > hX - 20) {
              labelX = hX + 20;
              handleSafeMinX = Math.max(handleSafeMinX, hX + 18);
            }
          }

          if (nextTime < Infinity) {
            labelX = Math.min(labelX, nextX - textWidth - 8);
          }

          if (labelX >= handleSafeMinX && nextX - labelX >= 20) {
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
            ctx.strokeText(label, labelX, 12);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, labelX, 12);
          }
        }
        ctx.restore();
      }

      // Draw white playback location line
      let currentTime = engine.getCurrentTime();
      const engineBuffer = engine.getBuffer();
      if (engineBuffer && engine.getLoop()) {
        currentTime = currentTime % engineBuffer.duration;
      }
      const playheadX = (currentTime - viewStart) * zoomRef.current;
      if (playheadX >= -2 && playheadX <= width + 2) {
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
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [
    buffer,
    duration,
    dragState,
    drumBuffer,
    drumEvents,
    auditionMode,
    showDrumMarkers,
    sections,
    manualEdits,
  ]);

  const computeCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y, height: canvas.height };
  };

  const computeHoverEditInfo = (x: number, y: number, height: number) => {
    const rawTime = scrollTimeRef.current + x / zoomRef.current;
    const stripCenter = (band: string) => {
      if (band === 'hat') return 23;
      if (band === 'snare') return height - 11;
      if (band === 'kick') return height / 2;
      return 39;
    };

    let matchedEvent: DrumEvent | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < drumEvents.length; i++) {
      const ev = drumEvents[i];
      const evX = (ev.time - scrollTimeRef.current) * zoomRef.current;
      const dx = Math.abs(evX - x);
      if (dx > 9) continue;
      const dy = Math.abs(stripCenter(ev.band) - y);
      if (dy > 28) continue;
      const score = dx + dy * 0.4;
      if (score < bestScore) {
        bestScore = score;
        matchedEvent = ev;
      }
    }

    const bpm = syncRef.current.bpm > 0 ? syncRef.current.bpm : 120;
    const beatDur = 60 / bpm;
    const beatFloat = (rawTime - syncRef.current.offset) / beatDur;

    let snapBeat = beatFloat;
    let snapTime = Math.max(0, rawTime);
    if (snapRef.current !== 'free') {
      const divPerBeat = snapRef.current / 4;
      snapBeat = Math.round(beatFloat * divPerBeat) / divPerBeat;
      snapTime = Math.max(0, syncRef.current.offset + snapBeat * beatDur);
    } else {
      snapBeat = Number(beatFloat.toFixed(3));
    }

    const rule = brushRuleRef.current;
    const altLane = getEffectiveAltLane(rule);
    const sixteenthIdx = Math.round(snapBeat * 4);
    const isEven = Math.abs(sixteenthIdx) % 2 === 0;
    const targetLane: LaneIndex =
      altLane !== null ? (isEven ? rule.lane : altLane) : rule.lane;

    return { x, y, matchedEvent, snapTime, snapBeat: Number(snapBeat.toFixed(3)), targetLane };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y, height } = computeCanvasCoords(e);

    if (editMode === 'edit' && e.button === 0) {
      const info = computeHoverEditInfo(x, y, height);
      onToggleNoteAt?.({
        existingEvent: info.matchedEvent || undefined,
        time: info.snapTime,
        beat: info.snapBeat,
        rule: activeBrushRule,
        lane: info.targetLane,
      });
      return;
    }

    const rect = canvasRef.current!.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const scaleX = canvasRef.current!.width / Math.max(1, rect.width);
    const timeAtCursor = scrollTime + (cssX * scaleX) / zoom;

    const threshold = 15 / zoom;

    const st = sync.offset;
    const n = getN(st, sync.bpm, duration);
    const end = st + n * (60 / sync.bpm);
    const half = st + (n / 2) * (60 / sync.bpm);

    if (Math.abs(timeAtCursor - st) < threshold) {
      setDragState({ type: 'start', startX: e.clientX, initialTime: st });
    } else if (Math.abs(timeAtCursor - end) < threshold) {
      setDragState({ type: 'end', startX: e.clientX, initialTime: end, initialBpm: sync.bpm, initialOffset: st, lockedN: n });
    } else if (Math.abs(timeAtCursor - half) < threshold) {
      setDragState({ type: 'half', startX: e.clientX, initialTime: half, initialBpm: sync.bpm, initialOffset: st, lockedN: n });
    } else {
      setDragState({ type: 'pan', startX: e.clientX, initialTime: scrollTime });
      setCursor('grabbing');
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editMode === 'edit' && !dragState) {
      const { x, y, height } = computeCanvasCoords(e);
      const info = computeHoverEditInfo(x, y, height);
      hoverStateRef.current = info;
      setCursor(info.matchedEvent ? 'pointer' : 'crosshair');
      return;
    }

    if (!dragState) {
      const { x } = computeCanvasCoords(e);
      const timeAtCursor = scrollTime + x / zoom;
      const threshold = 15 / zoom;

      const st = sync.offset;
      const n = getN(st, sync.bpm, duration);
      const end = st + n * (60 / sync.bpm);
      const half = st + (n / 2) * (60 / sync.bpm);

      if (Math.abs(timeAtCursor - st) < threshold || Math.abs(timeAtCursor - end) < threshold || Math.abs(timeAtCursor - half) < threshold) {
        setCursor('ew-resize');
      } else {
        setCursor('grab');
      }
      return;
    }

    const dx = e.clientX - dragState.startX;
    const dt = dx / zoom;

    if (dragState.type === 'pan') {
      setScrollTime(dragState.initialTime - dt);
    } else if (dragState.type === 'start') {
      const newOffset = dragState.initialTime + dt;
      setSync((s) => ({ ...s, offset: Number(newOffset.toFixed(3)) }));
    } else if (dragState.type === 'end' && dragState.lockedN && dragState.initialOffset !== undefined) {
      const newEnd = dragState.initialTime + dt;
      const beatDur = (newEnd - dragState.initialOffset) / dragState.lockedN;
      if (beatDur > 0.1) {
        const newBpm = 60 / beatDur;
        setSync((s) => ({ ...s, bpm: Number(newBpm.toFixed(2)) }));
      }
    } else if (dragState.type === 'half' && dragState.lockedN && dragState.initialOffset !== undefined) {
      const newHalf = dragState.initialTime + dt;
      const newEnd = dragState.initialOffset + 2 * (newHalf - dragState.initialOffset);
      const beatDur = (newEnd - dragState.initialOffset) / dragState.lockedN;
      if (beatDur > 0.1) {
        const newBpm = 60 / beatDur;
        setSync((s) => ({ ...s, bpm: Number(newBpm.toFixed(2)) }));
      }
    }
  };

  const handleMouseUp = () => {
    setDragState(null);
    setCursor(editMode === 'edit' ? 'crosshair' : 'grab');
  };

  const handleMouseLeave = () => {
    hoverStateRef.current = null;
    if (dragState?.type === 'pan') {
      setDragState(null);
    }
    setCursor('default');
  };

  const totalEditsCount = manualEdits.suppressions.length + manualEdits.additions.length;

  const brushBtnClass = (rule: DrumLaneRule, active: boolean) => {
    if (!active) return 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200';
    if (rule.color === 'amber') return 'bg-amber-500/20 border-amber-500/60 text-amber-300 font-semibold';
    if (rule.color === 'emerald') return 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 font-semibold';
    if (rule.color === 'sky') return 'bg-sky-500/20 border-sky-500/60 text-sky-300 font-semibold';
    if (rule.color === 'violet') return 'bg-violet-500/20 border-violet-500/60 text-violet-300 font-semibold';
    return 'bg-pink-500/20 border-pink-500/60 text-pink-300 font-semibold';
  };

  return (
    <div className="flex flex-col space-y-2 mt-2">
      <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-gray-400 px-1">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-gray-300 font-medium">Static Grid</span>
          <div className="inline-flex p-0.5 bg-gray-950 border border-gray-800 rounded-md">
            <button
              type="button"
              onClick={() => {
                setEditMode('pan');
                hoverStateRef.current = null;
              }}
              className={cn(
                'px-2 py-0.5 text-xs rounded transition-colors whitespace-nowrap shrink-0',
                editMode === 'pan'
                  ? 'bg-gray-800 text-white font-medium'
                  : 'text-gray-400 hover:text-gray-200'
              )}
            >
              Pan & Sync
            </button>
            <button
              type="button"
              onClick={() => setEditMode('edit')}
              className={cn(
                'px-2 py-0.5 text-xs rounded transition-colors whitespace-nowrap shrink-0',
                editMode === 'edit'
                  ? 'bg-emerald-500/25 text-emerald-300 font-semibold'
                  : 'text-gray-400 hover:text-gray-200'
              )}
            >
              Edit Notes
            </button>
          </div>
          {totalEditsCount > 0 && (
            <span className="text-xs font-mono tabular-nums text-emerald-400">
              {totalEditsCount} manual {totalEditsCount === 1 ? 'edit' : 'edits'}
            </span>
          )}
        </div>

        {editMode === 'edit' ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Lane Brush Selector */}
            <div className="flex items-center gap-1">
              <span className="text-gray-500 mr-0.5">Add:</span>
              {laneRules.map((rule) => (
                <button
                  key={rule.id}
                  type="button"
                  onClick={() => setBrushRuleId(rule.id)}
                  className={cn(
                    'px-2 py-0.5 text-xs font-mono rounded border transition-colors whitespace-nowrap shrink-0',
                    brushBtnClass(rule, activeBrushRule.id === rule.id)
                  )}
                  title={`Click grid to add ${rule.name}`}
                >
                  {rule.badge}
                </button>
              ))}
            </div>

            {/* Snap Subdivision */}
            <div className="inline-flex p-0.5 bg-gray-950 border border-gray-800 rounded-md">
              {(
                [
                  { id: 4, label: '1/4' },
                  { id: 8, label: '1/8' },
                  { id: 16, label: '1/16' },
                  { id: 'free', label: 'Free' },
                ] as const
              ).map((s) => (
                <button
                  key={String(s.id)}
                  type="button"
                  onClick={() => setSnapDivision(s.id)}
                  className={cn(
                    'px-1.5 py-0.5 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0',
                    snapDivision === s.id
                      ? 'bg-gray-800 text-white font-semibold'
                      : 'text-gray-400 hover:text-gray-200'
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {canUndoEdit && onUndoEdit && (
              <button
                type="button"
                onClick={onUndoEdit}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-200 whitespace-nowrap shrink-0"
                title="Undo last note edit"
              >
                <Undo2 className="w-3 h-3" />
                <span>Undo</span>
              </button>
            )}
            {totalEditsCount > 0 && onResetEdits && (
              <button
                type="button"
                onClick={onResetEdits}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded text-gray-400 hover:text-red-400 hover:bg-red-500/10 whitespace-nowrap shrink-0"
                title="Clear all manual note additions and deletions"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4">
            {showDrumMarkers && drumEvents.length > 0 && (
              <span className="flex items-center gap-3 text-xs">
                <span className="text-amber-400">K: Kick</span>
                <span className="text-emerald-400">C: Clap/Snare</span>
                <span className="text-sky-400">H: Hi-Hat</span>
              </span>
            )}
            <span>Scroll to Zoom · Drag Handles</span>
          </div>
        )}
      </div>
      <canvas
        ref={canvasRef}
        width={800}
        height={120}
        style={{ cursor }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        className="w-full h-[120px] bg-black rounded-md shadow-inner border border-gray-800 touch-none"
      />
    </div>
  );
}
