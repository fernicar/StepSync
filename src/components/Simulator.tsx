import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  SyncData,
  Section,
  AudioMetadata,
  LaneIndex,
  ChartDifficulty,
  DifficultyDensityMatrix,
  DrumLaneRule,
  JudgementTier,
  SimSoundMode,
} from '../types';
import { engine, SimDrumBand, SimTriggerEvent } from '../lib/AudioEngine';
import { generateDifficultyChart, getEffectiveAltLane } from '../lib/drumAnalysis';
import { AuditionMode } from './StemStudio';
import { cn } from '../lib/utils';

interface ScoreSummary {
  counts: Record<JudgementTier, number>;
  combo: number;
  maxCombo: number;
  accuracy: number;
  lastTier: JudgementTier | null;
  lastOffsetMs: number | null;
}

const INITIAL_SCORE: ScoreSummary = {
  counts: {
    marvelous: 0,
    perfect: 0,
    great: 0,
    good: 0,
    boo: 0,
    miss: 0,
  },
  combo: 0,
  maxCombo: 0,
  accuracy: 100,
  lastTier: null,
  lastOffsetMs: null,
};

const TIER_WEIGHT: Record<JudgementTier, number> = {
  marvelous: 1.0,
  perfect: 1.0,
  great: 0.65,
  good: 0.35,
  boo: 0.0,
  miss: 0.0,
};

const TIER_META: Record<JudgementTier, { label: string; color: string; textClass: string }> = {
  marvelous: { label: 'MARVELOUS', color: '#67e8f9', textClass: 'text-cyan-300' },
  perfect: { label: 'PERFECT', color: '#fde047', textClass: 'text-yellow-300' },
  great: { label: 'GREAT', color: '#34d399', textClass: 'text-emerald-400' },
  good: { label: 'GOOD', color: '#38bdf8', textClass: 'text-sky-400' },
  boo: { label: 'BOO', color: '#c084fc', textClass: 'text-violet-400' },
  miss: { label: 'MISS', color: '#f87171', textClass: 'text-red-400' },
};

interface RecordedTap {
  time: number;
  lane: LaneIndex;
}

interface Props {
  sync: SyncData;
  sections: Section[];
  isPlaying: boolean;
  audioMeta: AudioMetadata | null;
  onLoadEvents?: (eventsData: any[]) => void;
  delayCompensation?: number;
  setDelayCompensation?: (val: number) => void;
  autoQuantize?: boolean;
  setAutoQuantize?: (val: boolean) => void;
  hasDrumStem?: boolean;
  auditionMode?: AuditionMode;
  onChangeAuditionMode?: (mode: AuditionMode) => void;
  trackVolume?: number;
  onChangeTrackVolume?: (val: number) => void;
  simSoundMode?: SimSoundMode;
  onChangeSimSoundMode?: (mode: SimSoundMode) => void;
  simSoundEnabled?: Record<SimDrumBand, boolean>;
  onChangeSimSoundEnabled?: (next: Record<SimDrumBand, boolean>) => void;
  simVolume?: number;
  onChangeSimVolume?: (val: number) => void;
  tomBandIds?: string[];
  laneRules?: DrumLaneRule[];
  onRecordingActiveChange?: (active: boolean) => void;
  difficulty: ChartDifficulty;
  onChangeDifficulty: (d: ChartDifficulty) => void;
  difficultyMatrix: DifficultyDensityMatrix;
  bandPriorityOrder: string[];
}

const LANE_FROM_KEY: Record<string, LaneIndex> = {
  ArrowLeft: 0,
  KeyA: 0,
  KeyD: 0,
  ArrowDown: 1,
  KeyS: 1,
  KeyF: 1,
  ArrowUp: 2,
  KeyW: 2,
  KeyJ: 2,
  ArrowRight: 3,
  KeyK: 3,
  KeyL: 3,
};

export function Simulator({
  sync,
  sections,
  isPlaying,
  audioMeta,
  onLoadEvents,
  delayCompensation = 0,
  setDelayCompensation,
  autoQuantize = true,
  setAutoQuantize,
  hasDrumStem = false,
  auditionMode = 'mix',
  onChangeAuditionMode,
  trackVolume = 1.0,
  onChangeTrackVolume,
  simSoundMode = 'sync',
  onChangeSimSoundMode,
  simSoundEnabled = { kick: false, snare: false, hat: false, tom: false },
  onChangeSimSoundEnabled,
  simVolume = 0.85,
  onChangeSimVolume,
  tomBandIds = [],
  laneRules = [],
  onRecordingActiveChange,
  difficulty,
  onChangeDifficulty,
  difficultyMatrix,
  bandPriorityOrder,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordedEvents, setRecordedEvents] = useState<RecordedTap[]>([]);
  const [showDrumBaseLayer, setShowDrumBaseLayer] = useState(true);

  const calibrationPhaseRef = useRef<'IDLE' | 'TESTING' | 'FAILED' | 'SUCCESS'>('IDLE');
  const [calibrationPhaseState, setCalibrationPhaseState] = useState<'IDLE' | 'TESTING' | 'FAILED' | 'SUCCESS'>('IDLE');
  const [calibrationMessage, setCalibrationMessage] = useState('');
  const [calibrationStats, setCalibrationStats] = useState<{ variance: number; mean: number; count: number } | null>(null);
  const [liveTapCount, setLiveTapCount] = useState(0);
  const [lastTapTrigger, setLastTapTrigger] = useState(0);

  const setCalibrationPhase = (phase: 'IDLE' | 'TESTING' | 'FAILED' | 'SUCCESS') => {
    calibrationPhaseRef.current = phase;
    setCalibrationPhaseState(phase);
    if (phase === 'TESTING') setCalibrationStats(null);
  };

  const calibrationDataRef = useRef<{
    startTime: number;
    taps: number[];
    nextTick: number;
  }>({ startTime: 0, taps: [], nextTick: 0 });
  const calibrationRafRef = useRef<number>(0);

  useEffect(() => {
    onRecordingActiveChange?.(isRecording || calibrationPhaseState === 'TESTING');
  }, [isRecording, calibrationPhaseState, onRecordingActiveChange]);

  const importRecording = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (onLoadEvents) onLoadEvents(data);
      } catch (err) {
        console.error('Failed to parse JSON', err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  useEffect(() => {
    const checkCalibrationResults = (startTick: number, endTick: number) => {
      if (calibrationPhaseRef.current !== 'TESTING') return;

      const data = calibrationDataRef.current;
      const secondsPerBeat = 60.0 / sync.bpm;
      const secondsPerTick = secondsPerBeat / 2.0;

      const diffs: number[] = [];
      for (const tap of data.taps) {
        const i = Math.round((tap - data.startTime) / secondsPerTick);
        if (i >= startTick && i < endTick) {
          const tickInCompass = i % 8;
          if ([0, 2, 4, 5, 6].includes(tickInCompass)) {
            const expected = data.startTime + i * secondsPerTick;
            diffs.push(tap - expected);
          }
        }
      }

      if (diffs.length < 8) {
        setCalibrationMessage('Not enough consistent taps... Keep going!');
        data.taps = data.taps.filter((t) => t > data.startTime + (endTick - 24) * secondsPerTick);
        return;
      }

      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const variance = diffs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / diffs.length;

      setCalibrationStats({ variance, mean, count: diffs.length });

      if (variance > 0.005) {
        setCalibrationMessage('Taps too inconsistent... Keep going!');
        data.taps = data.taps.filter((t) => t > data.startTime + (endTick - 24) * secondsPerTick);
        return;
      }

      diffs.sort((a, b) => a - b);
      const median = diffs[Math.floor(diffs.length / 2)];

      if (setDelayCompensation) {
        setDelayCompensation(median);
      }

      setCalibrationPhase('IDLE');
      setCalibrationMessage(`Calibration complete! Delay: ${(median * 1000).toFixed(0)}ms`);

      setRecordedEvents([]);
      setIsRecording(true);

      if (!engine.getIsPlaying()) {
        engine.play();
      }
    };

    const calibrationLoop = () => {
      if (calibrationPhaseRef.current !== 'TESTING') return;

      const data = calibrationDataRef.current;
      const now = engine.getAudioContextTime();
      const secondsPerBeat = 60.0 / sync.bpm;
      const secondsPerTick = secondsPerBeat / 2.0;

      if (data.startTime === 0) {
        data.startTime = now + 0.5;
      }

      const expectedTickTime = data.startTime + data.nextTick * secondsPerTick;
      if (now >= expectedTickTime) {
        const tickInCompass = data.nextTick % 8;

        let soundType: 'kick' | 'hat' | 'snare' | null = null;
        if (tickInCompass === 0) soundType = 'kick';
        else if (tickInCompass === 2) soundType = 'hat';
        else if (tickInCompass === 4) soundType = 'kick';
        else if (tickInCompass === 5) soundType = 'snare';
        else if (tickInCompass === 6) soundType = 'hat';

        if (soundType) {
          engine.playClick(soundType);
        }

        data.nextTick++;

        if (data.nextTick >= 16 && data.nextTick % 16 === 0) {
          const endT = data.nextTick;
          const startT = endT - 16;
          setTimeout(() => {
            if (calibrationPhaseRef.current === 'TESTING') {
              checkCalibrationResults(startT, endT);
            }
          }, 300);
        }
      }

      if (calibrationPhaseRef.current === 'TESTING') {
        calibrationRafRef.current = requestAnimationFrame(calibrationLoop);
      }
    };

    if (calibrationPhaseState === 'TESTING') {
      calibrationRafRef.current = requestAnimationFrame(calibrationLoop);
    }

    return () => cancelAnimationFrame(calibrationRafRef.current);
  }, [calibrationPhaseState, sync.bpm, setDelayCompensation]);

  const rawDrumEvents = audioMeta?.drumEvents || [];

  const drumEvents = useMemo(
    () =>
      generateDifficultyChart(
        sections,
        rawDrumEvents,
        sync,
        difficultyMatrix,
        difficulty,
        bandPriorityOrder
      ),
    [sections, rawDrumEvents, sync, difficultyMatrix, difficulty, bandPriorityOrder]
  );

  // Playtest scoring state & refs
  const [playScore, setPlayScore] = useState<ScoreSummary>(INITIAL_SCORE);
  const drumEventsRef = useRef(drumEvents);
  drumEventsRef.current = drumEvents;
  const delayCompRef = useRef(delayCompensation);
  delayCompRef.current = delayCompensation;

  const pressedLanesRef = useRef<[boolean, boolean, boolean, boolean]>([false, false, false, false]);
  const judgedNotesRef = useRef<Map<number, JudgementTier | 'skipped'>>(new Map());
  const scoreMutableRef = useRef<ScoreSummary & { weightedSum: number; totalJudged: number }>({
    ...INITIAL_SCORE,
    counts: { ...INITIAL_SCORE.counts },
    weightedSum: 0,
    totalJudged: 0,
  });
  const lastJudgementHudRef = useRef<{
    tier: JudgementTier;
    offsetMs: number | null;
    combo: number;
    atMs: number;
  } | null>(null);
  const prevTrackTimeRef = useRef<number | null>(null);

  const simSoundModeRef = useRef(simSoundMode);
  simSoundModeRef.current = simSoundMode;
  const simSoundEnabledRef = useRef(simSoundEnabled);
  simSoundEnabledRef.current = simSoundEnabled;
  const laneRulesRef = useRef(laneRules);
  laneRulesRef.current = laneRules;

  const resetPlayScore = useCallback(() => {
    judgedNotesRef.current.clear();
    scoreMutableRef.current = {
      ...INITIAL_SCORE,
      counts: { marvelous: 0, perfect: 0, great: 0, good: 0, boo: 0, miss: 0 },
      weightedSum: 0,
      totalJudged: 0,
    };
    lastJudgementHudRef.current = null;
    prevTrackTimeRef.current = null;
    setPlayScore({
      ...INITIAL_SCORE,
      counts: { marvelous: 0, perfect: 0, great: 0, good: 0, boo: 0, miss: 0 },
    });
  }, []);

  useEffect(() => {
    resetPlayScore();
  }, [difficulty, drumEvents.length, resetPlayScore]);

  const prevSimSoundModeRef = useRef<SimSoundMode>(simSoundMode);
  useEffect(() => {
    if (prevSimSoundModeRef.current !== simSoundMode) {
      if (simSoundMode === 'demo' || prevSimSoundModeRef.current === 'demo') {
        resetPlayScore();
      }
      prevSimSoundModeRef.current = simSoundMode;
    }
  }, [simSoundMode, resetPlayScore]);

  const tomBandSet = useMemo(() => new Set(['tom', ...tomBandIds]), [tomBandIds]);
  const bandToSimBand = useCallback(
    (band: string): SimDrumBand | null => {
      if (band === 'kick' || band === 'snare' || band === 'hat') return band;
      if (tomBandSet.has(band)) return 'tom';
      return null;
    },
    [tomBandSet]
  );

  useEffect(() => {
    const recordJudgement = (tier: JudgementTier, offsetMs: number | null) => {
      const s = scoreMutableRef.current;
      s.counts[tier] += 1;
      s.totalJudged += 1;
      s.weightedSum += TIER_WEIGHT[tier];
      s.combo = tier === 'boo' || tier === 'miss' ? 0 : s.combo + 1;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s.accuracy = s.totalJudged > 0 ? (s.weightedSum / s.totalJudged) * 100 : 100;
      s.lastTier = tier;
      s.lastOffsetMs = offsetMs;

      lastJudgementHudRef.current = {
        tier,
        offsetMs,
        combo: s.combo,
        atMs: performance.now(),
      };

      setPlayScore({
        counts: { ...s.counts },
        combo: s.combo,
        maxCombo: s.maxCombo,
        accuracy: s.accuracy,
        lastTier: tier,
        lastOffsetMs: offsetMs,
      });
    };

    const playInputLaneSound = (explicitLane: LaneIndex, hitBand?: string) => {
      if (simSoundModeRef.current !== 'input') return;
      const enabled = simSoundEnabledRef.current;
      if (hitBand) {
        const matched = bandToSimBand(hitBand);
        if (matched && enabled[matched]) {
          engine.playClick(matched, undefined, 'sim');
          return;
        }
      }
      for (const rule of laneRulesRef.current) {
        const alt = getEffectiveAltLane(rule);
        if (rule.lane === explicitLane || alt === explicitLane) {
          const sb = bandToSimBand(rule.id);
          if (sb && enabled[sb]) {
            engine.playClick(sb, undefined, 'sim');
            return;
          }
        }
      }
      const fallbackMap: Record<LaneIndex, SimDrumBand> = {
        0: 'hat',
        1: 'tom',
        2: 'kick',
        3: 'snare',
      };
      const fb = fallbackMap[explicitLane];
      if (enabled[fb]) {
        engine.playClick(fb, undefined, 'sim');
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') return;

      const explicitLane = LANE_FROM_KEY[e.code];
      const inDemoMode =
        !isRecording &&
        calibrationPhaseRef.current === 'IDLE' &&
        simSoundModeRef.current === 'demo';

      if (inDemoMode) {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
          e.preventDefault();
        }
        return;
      }

      if (!e.repeat && explicitLane !== undefined) {
        pressedLanesRef.current[explicitLane] = true;
      }

      if (!e.repeat) {
        if (calibrationPhaseRef.current === 'TESTING') {
          const now = engine.getAudioContextTime();
          calibrationDataRef.current.taps.push(now);
          setLiveTapCount(calibrationDataRef.current.taps.length);
          setLastTapTrigger(Date.now());
          return;
        }

        if (isRecording) {
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
            e.preventDefault();
          }
          const time = engine.getCurrentTime();
          setRecordedEvents((prev) => {
            const lane: LaneIndex =
              explicitLane !== undefined ? explicitLane : ((prev.length % 4) as LaneIndex);
            return [...prev, { time, lane }];
          });
          return;
        }

        // Playable Simulator mode: match D F J K / Arrow keys to active chart notes
        if (explicitLane !== undefined) {
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
            e.preventDefault();
          }

          if (!engine.getIsPlaying() || !showDrumBaseLayer) {
            playInputLaneSound(explicitLane);
            return;
          }
          const activeNotes = drumEventsRef.current;
          if (activeNotes.length === 0) {
            playInputLaneSound(explicitLane);
            return;
          }

          let curTime = engine.getCurrentTime();
          const buf = engine.getBuffer();
          if (buf && engine.getLoop()) {
            curTime = curTime % buf.duration;
          }
          const tapTime = curTime - delayCompRef.current;

          let bestIdx = -1;
          let bestAbs = 0.181;
          let bestSignedDiff = 0;

          for (let i = 0; i < activeNotes.length; i++) {
            const ev = activeNotes[i];
            if (ev.lane !== explicitLane) continue;
            if (judgedNotesRef.current.has(i)) continue;
            const diff = tapTime - ev.time;
            const absDiff = Math.abs(diff);
            if (absDiff < bestAbs) {
              bestAbs = absDiff;
              bestIdx = i;
              bestSignedDiff = diff;
            }
          }

          if (bestIdx !== -1) {
            playInputLaneSound(explicitLane, activeNotes[bestIdx].band);
            const absMs = bestAbs * 1000;
            const tier: JudgementTier =
              absMs <= 22.5
                ? 'marvelous'
                : absMs <= 45.0
                ? 'perfect'
                : absMs <= 90.0
                ? 'great'
                : absMs <= 135.0
                ? 'good'
                : 'boo';
            judgedNotesRef.current.set(bestIdx, tier);
            recordJudgement(tier, Math.round(bestSignedDiff * 1000));
          } else {
            playInputLaneSound(explicitLane);
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const explicitLane = LANE_FROM_KEY[e.code];
      if (explicitLane !== undefined) {
        pressedLanesRef.current[explicitLane] = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isRecording, showDrumBaseLayer, bandToSimBand]);

  const toggleRecording = () => {
    if (isRecording || calibrationPhaseState !== 'IDLE') {
      setIsRecording(false);
      setCalibrationPhase('IDLE');
      engine.stop();
    } else {
      setCalibrationPhase('TESTING');
      setCalibrationMessage('Calibration: Tap any key along with the drum pattern...');
      setLiveTapCount(0);
      calibrationDataRef.current = { startTime: 0, taps: [], nextTick: 0 };
    }
  };

  const hasTomBand =
    tomBandIds.length > 0 || rawDrumEvents.some((ev) => tomBandSet.has(ev.band));

  // Sync active difficulty chart events & sound toggles to AudioEngine scheduler when mode is Demo or Sync
  useEffect(() => {
    if (!showDrumBaseLayer || calibrationPhaseState === 'TESTING' || simSoundMode === 'input') {
      engine.setSimulatedTriggers([], { kick: false, snare: false, hat: false, tom: false });
      return;
    }

    const triggerEvents: SimTriggerEvent[] = [];
    for (let i = 0; i < drumEvents.length; i++) {
      const ev = drumEvents[i];
      if (ev.band === 'kick' || ev.band === 'snare' || ev.band === 'hat') {
        triggerEvents.push({ time: ev.time, band: ev.band });
      } else if (tomBandSet.has(ev.band)) {
        triggerEvents.push({ time: ev.time, band: 'tom' });
      }
    }
    engine.setSimulatedTriggers(triggerEvents, simSoundEnabled);
  }, [drumEvents, showDrumBaseLayer, simSoundEnabled, simSoundMode, calibrationPhaseState, tomBandSet]);

  useEffect(() => {
    return () => {
      engine.setSimulatedTriggers([], { kick: false, snare: false, hat: false, tom: false });
    };
  }, []);

  const exportRecording = () => {
    const secondsPerBeat = 60.0 / sync.bpm;
    const userFormatted = recordedEvents.map((ev) => {
      let adjustedTime = ev.time - delayCompensation;
      if (autoQuantize) {
        const beatFloat = (adjustedTime - sync.offset) / secondsPerBeat;
        const nearest16th = Math.round(beatFloat * 4) / 4;
        adjustedTime = sync.offset + nearest16th * secondsPerBeat;
      }
      const beat = (adjustedTime - sync.offset) / secondsPerBeat;
      return {
        time: Number(adjustedTime.toFixed(3)),
        beat: Number(beat.toFixed(3)),
        lane: ev.lane,
        source: 'user' as const,
      };
    });

    const drumFormatted =
      showDrumBaseLayer && drumEvents.length > 0
        ? drumEvents.map((ev) => ({
            time: Number(ev.time.toFixed(3)),
            beat: Number((((ev.time - sync.offset) / secondsPerBeat)).toFixed(3)),
            lane: ev.lane,
            band: ev.band,
            source: 'drum' as const,
          }))
        : [];

    const combined = [...drumFormatted, ...userFormatted].sort((a, b) => a.time - b.time);
    const data = JSON.stringify(combined, null, 2);

    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recorded-events.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    let animationId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const arrows = ['left', 'down', 'up', 'right'];
    const bandColors: Record<string, string> = {
      amber: '#f59e0b',
      emerald: '#34d399',
      sky: '#38bdf8',
      pink: '#ec4899',
      violet: '#a78bfa',
      kick: '#f59e0b',
      snare: '#34d399',
      hat: '#38bdf8',
    };

    const drawArrow = (
      c: CanvasRenderingContext2D,
      x: number,
      y: number,
      dir: string,
      color: string,
      outlineColor = '#ffffff',
      badge?: string
    ) => {
      c.save();
      c.translate(x, y);
      c.fillStyle = color;
      switch (dir) {
        case 'left':
          c.rotate(-Math.PI / 2);
          break;
        case 'up':
          break;
        case 'down':
          c.rotate(Math.PI);
          break;
        case 'right':
          c.rotate(Math.PI / 2);
          break;
      }
      c.beginPath();
      c.moveTo(0, -15);
      c.lineTo(15, 0);
      c.lineTo(5, 0);
      c.lineTo(5, 15);
      c.lineTo(-5, 15);
      c.lineTo(-5, 0);
      c.lineTo(-15, 0);
      c.closePath();
      c.fill();

      c.strokeStyle = outlineColor;
      c.lineWidth = 1.25;
      c.stroke();
      c.restore();

      if (badge) {
        c.save();
        c.font = 'bold 9px monospace';
        c.fillStyle = '#030712';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(badge, x, y);
        c.restore();
      }
    };

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, width, height);

      const targetY = 60;
      const laneWidth = width / 4;
      const laneLabels = ['←', '↓', '↑', '→'];
      const keyHints = ['D', 'F', 'J', 'K'];

      let currentTime = engine.getCurrentTime();
      const buffer = engine.getBuffer();
      if (buffer && engine.getLoop()) {
        currentTime = currentTime % buffer.duration;
      }

      const secondsPerBeat = 60.0 / sync.bpm;
      const scrollSpeed = 350;
      const startBeat = Math.floor((currentTime - sync.offset) / secondsPerBeat);

      const hasMappedDrumEvents = showDrumBaseLayer && drumEvents.length > 0;

      // Auto-play Demotest OR Play Mode auto-miss sweep & seek/loop wrap detection
      if (!isRecording && calibrationPhaseRef.current === 'IDLE' && hasMappedDrumEvents) {
        const evalTime = currentTime - delayCompensation;
        const prevTime = prevTrackTimeRef.current;

        if (simSoundModeRef.current === 'demo') {
          if (prevTime !== null && prevTime - currentTime > 2.0 && engine.getLoop()) {
            judgedNotesRef.current.clear();
          } else if (prevTime === null || Math.abs(currentTime - prevTime) > 0.5) {
            for (let i = 0; i < drumEvents.length; i++) {
              if (drumEvents[i].time < currentTime && !judgedNotesRef.current.has(i)) {
                judgedNotesRef.current.set(i, 'skipped');
              }
            }
          } else if (isPlaying && currentTime >= prevTime) {
            let demoHits = 0;
            for (let i = 0; i < drumEvents.length; i++) {
              if (judgedNotesRef.current.has(i)) continue;
              if (drumEvents[i].time <= currentTime) {
                judgedNotesRef.current.set(i, 'marvelous');
                demoHits++;
              } else {
                break;
              }
            }

            if (demoHits > 0) {
              const s = scoreMutableRef.current;
              s.counts.marvelous += demoHits;
              s.totalJudged += demoHits;
              s.weightedSum += demoHits * TIER_WEIGHT.marvelous;
              s.combo += demoHits;
              s.maxCombo = Math.max(s.maxCombo, s.combo);
              s.accuracy = s.totalJudged > 0 ? (s.weightedSum / s.totalJudged) * 100 : 100;
              s.lastTier = 'marvelous';
              s.lastOffsetMs = 0;
              lastJudgementHudRef.current = {
                tier: 'marvelous',
                offsetMs: 0,
                combo: s.combo,
                atMs: performance.now(),
              };
              setPlayScore({
                counts: { ...s.counts },
                combo: s.combo,
                maxCombo: s.maxCombo,
                accuracy: s.accuracy,
                lastTier: 'marvelous',
                lastOffsetMs: 0,
              });
            }
          }
          prevTrackTimeRef.current = currentTime;
        } else {
          if (prevTime !== null && prevTime - currentTime > 2.0 && engine.getLoop()) {
            // Looped back to start: allow hitting notes cleanly on the next pass
            judgedNotesRef.current.clear();
          } else if (prevTime === null || Math.abs(currentTime - prevTime) > 0.5) {
            // Seeked or just started mid-track: silently skip already-passed notes
            for (let i = 0; i < drumEvents.length; i++) {
              if (drumEvents[i].time < evalTime - 0.18 && !judgedNotesRef.current.has(i)) {
                judgedNotesRef.current.set(i, 'skipped');
              }
            }
          } else if (isPlaying && currentTime >= prevTime) {
            let newMisses = 0;
            for (let i = 0; i < drumEvents.length; i++) {
              if (judgedNotesRef.current.has(i)) continue;
              if (drumEvents[i].time < evalTime - 0.18) {
                judgedNotesRef.current.set(i, 'miss');
                newMisses++;
              } else if (drumEvents[i].time > evalTime) {
                break;
              }
            }

            if (newMisses > 0) {
              const s = scoreMutableRef.current;
              s.counts.miss += newMisses;
              s.totalJudged += newMisses;
              s.combo = 0;
              s.accuracy = s.totalJudged > 0 ? (s.weightedSum / s.totalJudged) * 100 : 100;
              s.lastTier = 'miss';
              s.lastOffsetMs = null;
              lastJudgementHudRef.current = {
                tier: 'miss',
                offsetMs: null,
                combo: 0,
                atMs: performance.now(),
              };
              setPlayScore({
                counts: { ...s.counts },
                combo: 0,
                maxCombo: s.maxCombo,
                accuracy: s.accuracy,
                lastTier: 'miss',
                lastOffsetMs: null,
              });
            }
          }
          prevTrackTimeRef.current = currentTime;
        }
      } else {
        prevTrackTimeRef.current = currentTime;
      }

      // Highlight receptors for Demo / Sync scheduled hits OR live user key presses
      const laneHitFlashColor: Array<string | null> = [null, null, null, null];
      if (isPlaying && hasMappedDrumEvents && simSoundModeRef.current !== 'input') {
        const anySoundOn =
          simSoundEnabled.kick ||
          simSoundEnabled.snare ||
          simSoundEnabled.hat ||
          simSoundEnabled.tom;
        if (simSoundModeRef.current === 'demo' || anySoundOn) {
          for (let i = 0; i < drumEvents.length; i++) {
            const ev = drumEvents[i];
            const simBand: SimDrumBand | null =
              ev.band === 'kick' || ev.band === 'snare' || ev.band === 'hat'
                ? ev.band
                : tomBandSet.has(ev.band)
                ? 'tom'
                : null;
            if (simSoundModeRef.current !== 'demo' && (!simBand || !simSoundEnabled[simBand])) {
              continue;
            }
            const dt = currentTime - ev.time;
            if (dt >= -0.01 && dt <= 0.065) {
              laneHitFlashColor[ev.lane] =
                (ev.color && bandColors[ev.color]) || bandColors[ev.band] || '#ec4899';
            }
          }
        }
      }

      for (let i = 0; i < 4; i++) {
        const cx = i * laneWidth + laneWidth / 2;
        const isPressed =
          simSoundModeRef.current !== 'demo' && pressedLanesRef.current[i];
        const activeColor = laneHitFlashColor[i] || (isPressed ? '#ffffff' : null);

        ctx.fillStyle = activeColor || 'rgba(255,255,255,0.45)';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(keyHints[i], cx, targetY - 28);

        if (activeColor) {
          ctx.fillStyle = isPressed ? 'rgba(255,255,255,0.18)' : `${activeColor}33`;
          ctx.fillRect(cx - 20, targetY - 20, 40, 40);
        }
        ctx.strokeStyle = activeColor || 'rgba(255,255,255,0.28)';
        ctx.lineWidth = activeColor ? 2.5 : 2;
        ctx.strokeRect(cx - 20, targetY - 20, 40, 40);
        ctx.fillStyle = activeColor || 'rgba(255,255,255,0.25)';
        ctx.font = '12px monospace';
        ctx.fillText(laneLabels[i], cx, targetY + 4);
      }
      ctx.textAlign = 'left';

      const processedUserEvents = recordedEvents.map((ev) => {
        let adjusted = ev.time - delayCompensation;
        if (autoQuantize) {
          const beatFloat = (adjusted - sync.offset) / secondsPerBeat;
          const nearest16th = Math.round(beatFloat * 4) / 4;
          adjusted = sync.offset + nearest16th * secondsPerBeat;
        }
        return { time: adjusted, lane: ev.lane };
      });

      const sectionByBeat = new Map<number, Section>();
      for (const sec of sections) {
        sectionByBeat.set(Math.round(sec.beat), sec);
      }

      for (let i = startBeat - 1; i < startBeat + 8; i++) {
        const beatTime = sync.offset + i * secondsPerBeat;
        const beatY = targetY + (beatTime - currentTime) * scrollSpeed;

        if (beatY > -50 && beatY < height + 50) {
          const secCue = sectionByBeat.get(i);
          ctx.beginPath();
          ctx.moveTo(0, beatY);
          ctx.lineTo(width, beatY);
          ctx.strokeStyle = secCue
            ? 'rgba(255, 255, 255, 0.55)'
            : i % 4 === 0
            ? 'rgba(239, 68, 68, 0.4)'
            : 'rgba(75, 85, 99, 0.4)';
          ctx.lineWidth = secCue || i % 4 === 0 ? 2 : 1;
          ctx.stroke();

          ctx.fillStyle = i % 4 === 0 ? '#ef4444' : '#9ca3af';
          ctx.font = '14px monospace';
          ctx.fillText(i.toString(), 5, beatY - 5);

          if (secCue) {
            const cueText = `${secCue.label} · ${secCue.density}`;
            ctx.save();
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'right';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
            ctx.strokeText(cueText, width - 8, beatY - 5);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(cueText, width - 8, beatY - 5);
            ctx.restore();
          }
        }
      }

      // Draw Band-Mapped Drum Base Layer (hide notes already struck cleanly in Play Mode)
      if (hasMappedDrumEvents) {
        for (let i = 0; i < drumEvents.length; i++) {
          const hitStatus = judgedNotesRef.current.get(i);
          if (hitStatus && hitStatus !== 'miss' && hitStatus !== 'skipped') continue;
          const ev = drumEvents[i];
          const y = targetY + (ev.time - currentTime) * scrollSpeed;
          if (y > -50 && y < height + 50) {
            const badge = ev.badge || (ev.band === 'kick' ? 'K' : ev.band === 'snare' ? 'C' : ev.band === 'hat' ? 'H' : 'T');
            const color = (ev.color && bandColors[ev.color]) || bandColors[ev.band] || '#ec4899';
            ctx.globalAlpha = hitStatus === 'miss' ? 0.35 : 0.92;
            drawArrow(
              ctx,
              ev.lane * laneWidth + laneWidth / 2,
              y,
              arrows[ev.lane],
              color,
              '#ffffff',
              badge
            );
            ctx.globalAlpha = 1.0;
          }
        }
      }

      // Draw User-Recorded Overdub Layer on top
      for (let j = 0; j < processedUserEvents.length; j++) {
        const ev = processedUserEvents[j];
        const y = targetY + (ev.time - currentTime) * scrollSpeed;
        if (y > -50 && y < height + 50) {
          ctx.globalAlpha = 1.0;
          drawArrow(
            ctx,
            ev.lane * laneWidth + laneWidth / 2,
            y,
            arrows[ev.lane],
            '#f43f5e',
            '#fef08a',
            'U'
          );
        }
      }

      // Unobtrusive Judgement & Combo Callout on Highway
      const lastHud = lastJudgementHudRef.current;
      if (lastHud && !isRecording) {
        const age = performance.now() - lastHud.atMs;
        if (age < 700) {
          const alpha = Math.max(0, 1 - Math.max(0, age - 450) / 250);
          const meta = TIER_META[lastHud.tier];
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.textAlign = 'center';
          ctx.lineJoin = 'round';
          ctx.font = 'bold 20px monospace';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
          ctx.strokeText(meta.label, width / 2, 152);
          ctx.fillStyle = meta.color;
          ctx.fillText(meta.label, width / 2, 152);

          if (lastHud.offsetMs !== null) {
            const errStr =
              lastHud.offsetMs === 0
                ? '0ms'
                : `${lastHud.offsetMs > 0 ? '+' : ''}${lastHud.offsetMs}ms`;
            ctx.font = 'bold 11px monospace';
            ctx.lineWidth = 3;
            ctx.strokeText(errStr, width / 2, 170);
            ctx.fillStyle =
              lastHud.offsetMs < 0 ? '#7dd3fc' : lastHud.offsetMs > 0 ? '#fcd34d' : '#ffffff';
            ctx.fillText(errStr, width / 2, 170);
          }

          if (lastHud.combo >= 2) {
            const comboText = `${lastHud.combo} COMBO`;
            ctx.font = 'bold 16px monospace';
            ctx.lineWidth = 4;
            ctx.strokeText(comboText, width / 2, 194);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(comboText, width / 2, 194);
          }
          ctx.restore();
        }
      }

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationId);
  }, [
    sync,
    isPlaying,
    isRecording,
    autoQuantize,
    delayCompensation,
    recordedEvents,
    showDrumBaseLayer,
    drumEvents,
    sections,
    simSoundEnabled,
    tomBandSet,
  ]);

  const canExport = recordedEvents.length > 0 || (showDrumBaseLayer && drumEvents.length > 0);

  return (
    <div className="flex flex-col md:flex-row gap-5 items-start justify-center p-1 rounded-lg w-full">
      {/* LEFT COLUMN: Simulator Canvas */}
      <div className="flex flex-col items-center flex-shrink-0">
        <canvas
          ref={canvasRef}
          className="bg-black border-2 border-gray-800 rounded-lg shadow-2xl"
          width={360}
          height={500}
        />
        <div className="mt-2.5 text-center text-gray-400 text-xs space-y-1">
          <p>
            Press <kbd className="bg-gray-800 px-2 py-0.5 rounded text-gray-300 font-mono border border-gray-700">Space</kbd> to toggle playback.
          </p>
          <p>
            While recording: Arrow keys or <kbd className="bg-gray-800 px-1.5 py-0.5 rounded font-mono border border-gray-700">D F J K</kbd> map directly to lanes.
          </p>
        </div>
      </div>

      {/* RIGHT COLUMN: Settings and Controls */}
      <div className="flex flex-col w-full max-w-sm space-y-3">
        {/* Sync Info */}
        <div className="flex space-x-6 items-center justify-center p-3 bg-gray-900 rounded-lg border border-gray-800">
          <div className="flex flex-col text-center">
            <span className="text-2xl font-mono tabular-nums font-bold text-white">{sync.bpm.toFixed(2)}</span>
            <span className="text-xs text-gray-500 uppercase tracking-wider">BPM</span>
          </div>
          <div className="h-8 w-px bg-gray-700"></div>
          <div className="flex flex-col text-center">
            <span className="text-2xl font-mono tabular-nums font-bold text-emerald-400">{sync.offset.toFixed(3)}s</span>
            <span className="text-xs text-gray-500 uppercase tracking-wider">Offset</span>
          </div>
        </div>

        {/* Drum Stem Layer & Difficulty Switcher */}
        <div className="space-y-2.5 p-3 bg-gray-900 rounded-lg border border-gray-800">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-gray-300">Drum Base Layer</h4>
            <span className="text-xs font-mono tabular-nums text-gray-400">
              {drumEvents.length}
              {rawDrumEvents.length !== drumEvents.length ? ` / ${rawDrumEvents.length}` : ''} notes
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-400">Difficulty</span>
            <div className="inline-flex p-0.5 bg-gray-950 border border-gray-800 rounded-md">
              {(
                [
                  { id: 'easy', label: 'Easy', activeClass: 'bg-sky-500/25 text-sky-300' },
                  { id: 'normal', label: 'Normal', activeClass: 'bg-amber-500/25 text-amber-300' },
                  { id: 'hard', label: 'Hard', activeClass: 'bg-emerald-500/25 text-emerald-300' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onChangeDifficulty(d.id)}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0',
                    difficulty === d.id
                      ? cn(d.activeClass, 'font-semibold')
                      : 'text-gray-400 hover:text-white'
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center space-x-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showDrumBaseLayer}
              disabled={drumEvents.length === 0}
              onChange={(e) => setShowDrumBaseLayer(e.target.checked)}
              className="rounded border-gray-700 text-emerald-500 focus:ring-emerald-500 bg-gray-800 w-4 h-4 cursor-pointer disabled:opacity-40"
            />
            <span>Show Drum-Mapped Keys (Overdub)</span>
          </label>

          {drumEvents.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-xs pt-1">
              <span className="text-amber-400">K: Kick</span>
              <span className="text-emerald-400">C: Clap</span>
              <span className="text-sky-400">H: Hat</span>
              {drumEvents.some((e) => e.color === 'pink' || (e.band !== 'kick' && e.band !== 'snare' && e.band !== 'hat')) && (
                <span className="text-pink-400">T: Custom/Tom</span>
              )}
              <span className="text-rose-400">U: User</span>
            </div>
          )}

          {/* Audio Level & Stem Audition Mode */}
          <div className="pt-2 border-t border-gray-800 flex items-center justify-between gap-2">
            <span className="text-xs text-gray-400 shrink-0">Audio</span>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={trackVolume}
                onChange={(e) => onChangeTrackVolume?.(parseFloat(e.target.value))}
                aria-label="Audio volume"
                className="w-full accent-emerald-500 h-1.5 cursor-pointer"
              />
              <span className="text-[11px] font-mono tabular-nums text-gray-400 w-8 text-right shrink-0">
                {Math.round(trackVolume * 100)}%
              </span>
            </div>
            {hasDrumStem && onChangeAuditionMode && (
              <div className="inline-flex p-0.5 bg-gray-950 border border-gray-800 rounded-md shrink-0">
                {(
                  [
                    { id: 'mix', label: 'Mix' },
                    { id: 'drums', label: 'Drums' },
                    { id: 'blend', label: 'Blend' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onChangeAuditionMode(m.id)}
                    className={cn(
                      'px-2 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0',
                      auditionMode === m.id
                        ? 'bg-emerald-500 text-gray-950 font-semibold'
                        : 'text-gray-400 hover:text-white'
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Perfect Hit Sound Simulation (Demo / Sync / Input + Band Toggles) */}
          <div className="pt-2 border-t border-gray-800 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-gray-400">Sim Sound</span>
                <select
                  value={simSoundMode}
                  onChange={(e) => onChangeSimSoundMode?.(e.target.value as SimSoundMode)}
                  className="bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-200 focus:outline-none focus:border-sky-500 cursor-pointer"
                  title="Demo: plays chart sounds & ignores input (Demotest Score) · Sync: plays chart sounds regardless of input · Input: plays only on player input"
                >
                  <option value="demo" className="bg-gray-900 text-gray-200">
                    Demo
                  </option>
                  <option value="sync" className="bg-gray-900 text-gray-200">
                    Sync
                  </option>
                  <option value="input" className="bg-gray-900 text-gray-200">
                    Input
                  </option>
                </select>
              </div>
              <div className="flex items-center gap-1.5 flex-1 min-w-0 max-w-[165px]">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={simVolume}
                  onChange={(e) => onChangeSimVolume?.(parseFloat(e.target.value))}
                  aria-label="Simulated hit sound volume"
                  className="w-full accent-sky-400 h-1.5 cursor-pointer"
                />
                <span className="text-[11px] font-mono tabular-nums text-gray-400 w-8 text-right shrink-0">
                  {Math.round(simVolume * 100)}%
                </span>
              </div>
            </div>
            <div className={cn('grid gap-1.5', hasTomBand ? 'grid-cols-4' : 'grid-cols-3')}>
              {(
                [
                  {
                    id: 'kick',
                    label: 'Kick',
                    activeClass: 'bg-amber-500/20 border-amber-500/60 text-amber-300 font-semibold',
                  },
                  {
                    id: 'snare',
                    label: 'Snare',
                    activeClass:
                      'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 font-semibold',
                  },
                  {
                    id: 'hat',
                    label: 'Hi-Hat',
                    activeClass: 'bg-sky-500/20 border-sky-500/60 text-sky-300 font-semibold',
                  },
                  ...(hasTomBand
                    ? [
                        {
                          id: 'tom',
                          label: 'Tom',
                          activeClass:
                            'bg-pink-500/20 border-pink-500/60 text-pink-300 font-semibold',
                        } as const,
                      ]
                    : []),
                ] as const
              ).map((lane) => {
                const isOn = simSoundEnabled[lane.id];
                return (
                  <button
                    key={lane.id}
                    type="button"
                    aria-pressed={isOn}
                    onClick={() =>
                      onChangeSimSoundEnabled?.({
                        ...simSoundEnabled,
                        [lane.id]: !isOn,
                      })
                    }
                    className={cn(
                      'px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1',
                      isOn
                        ? lane.activeClass
                        : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700'
                    )}
                  >
                    <span>{lane.label}</span>
                    <span className="text-[10px] opacity-75">{isOn ? 'ON' : 'OFF'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Live Playtest / Demotest Score Card */}
        <div className="p-3 bg-gray-900 rounded-lg border border-gray-800 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium text-gray-300">
                {simSoundMode === 'demo' ? 'Demotest Score' : 'Playtest Score'}
              </h4>
              <span className="text-xs text-gray-500">
                {isRecording
                  ? 'Recording'
                  : simSoundMode === 'demo'
                  ? 'Demo Auto-Play'
                  : 'Tap D F J K'}
              </span>
            </div>
            <button
              type="button"
              onClick={resetPlayScore}
              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors whitespace-nowrap shrink-0"
              title="Reset score and combo"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-0.5 text-center">
            <div>
              <div className="text-lg font-mono tabular-nums font-bold text-emerald-400">
                {playScore.accuracy.toFixed(1)}%
              </div>
              <div className="text-[11px] text-gray-500">Accuracy</div>
            </div>
            <div>
              <div className="text-lg font-mono tabular-nums font-bold text-white">
                {playScore.combo}
              </div>
              <div className="text-[11px] text-gray-500">Combo</div>
            </div>
            <div>
              <div className="text-lg font-mono tabular-nums font-bold text-amber-300">
                {playScore.maxCombo}
              </div>
              <div className="text-[11px] text-gray-500">Max Combo</div>
            </div>
          </div>

          <div className="pt-2 border-t border-gray-800 grid grid-cols-3 gap-x-3 gap-y-1 text-xs font-mono tabular-nums">
            <div className="flex items-center justify-between">
              <span className="text-cyan-300">Marv</span>
              <span className="text-gray-200">{playScore.counts.marvelous}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-yellow-300">Perf</span>
              <span className="text-gray-200">{playScore.counts.perfect}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-emerald-400">Great</span>
              <span className="text-gray-200">{playScore.counts.great}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sky-400">Good</span>
              <span className="text-gray-200">{playScore.counts.good}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-violet-400">Boo</span>
              <span className="text-gray-200">{playScore.counts.boo}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-red-400">Miss</span>
              <span className="text-gray-200">{playScore.counts.miss}</span>
            </div>
          </div>

          {playScore.lastTier && (
            <div className="pt-1.5 border-t border-gray-800 flex items-center justify-between text-xs font-mono tabular-nums">
              <span className={TIER_META[playScore.lastTier].textClass}>
                {TIER_META[playScore.lastTier].label}
              </span>
              <span className="text-gray-400">
                {playScore.lastOffsetMs === null
                  ? 'Missed window'
                  : playScore.lastOffsetMs === 0
                  ? '0 ms (Exact)'
                  : `${playScore.lastOffsetMs > 0 ? '+' : ''}${playScore.lastOffsetMs} ms (${
                      playScore.lastOffsetMs < 0 ? 'Early' : 'Late'
                    })`}
              </span>
            </div>
          )}
        </div>

        {/* Event Import Settings */}
        <div className="space-y-4 p-4 bg-gray-900 rounded-lg border border-gray-800">
          <h4 className="text-sm font-medium text-gray-300">Recording & Import Settings</h4>
          <label className="flex items-center space-x-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoQuantize}
              onChange={(e) => setAutoQuantize && setAutoQuantize(e.target.checked)}
              className="rounded border-gray-700 text-emerald-500 focus:ring-emerald-500 bg-gray-800 w-4 h-4 cursor-pointer"
            />
            <span>Quantize imports & taps to nearest 16th</span>
          </label>

          <div className="space-y-1 pt-2">
            <div className="flex justify-between text-xs text-gray-400">
              <span>Delay Compensation</span>
              <span className="font-mono tabular-nums">{delayCompensation.toFixed(3)}s</span>
            </div>
            <input
              type="range"
              min="-0.5"
              max="0.5"
              step="0.005"
              value={delayCompensation}
              onChange={(e) => setDelayCompensation && setDelayCompensation(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col space-y-4">
          {(calibrationPhaseState !== 'IDLE' || calibrationStats) && (
            <div
              className={`w-full p-3 text-sm text-center rounded border ${
                calibrationPhaseState === 'SUCCESS' || (calibrationPhaseState === 'IDLE' && calibrationStats)
                  ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10'
                  : calibrationPhaseState === 'FAILED'
                  ? 'border-red-500 text-red-400 bg-red-500/10'
                  : 'border-blue-500 text-blue-400 bg-blue-500/10'
              }`}
            >
              <div className="font-medium flex items-center justify-center space-x-2">
                <span>{calibrationMessage}</span>
              </div>

              {calibrationPhaseState === 'TESTING' && (
                <div className="mt-2 text-xs opacity-80 grid grid-cols-1 gap-2 text-center bg-black/20 p-2 rounded">
                  <div className="text-xl font-mono tabular-nums text-blue-300">
                    {liveTapCount} <span className="text-xs text-gray-400">taps recorded</span>
                  </div>
                </div>
              )}

              {calibrationStats && (
                <div className="mt-2 text-xs opacity-80 grid grid-cols-2 gap-2 text-left bg-black/20 p-2 rounded font-mono tabular-nums">
                  <div>
                    <span className="opacity-60">Variance:</span> {calibrationStats.variance.toFixed(5)}
                  </div>
                  <div>
                    <span className="opacity-60">Mean Delay:</span> {(calibrationStats.mean * 1000).toFixed(0)}ms
                  </div>
                  <div className="col-span-2">
                    <span className="opacity-60">Valid Taps (Recent):</span> {calibrationStats.count}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex space-x-2 w-full justify-center">
            <button
              onClick={toggleRecording}
              className={`flex-1 px-2 py-2 text-sm rounded font-medium flex items-center justify-center space-x-2 transition-colors whitespace-nowrap ${
                isRecording ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
              }`}
            >
              <span>{isRecording ? 'Stop' : 'Record / Calibrate'}</span>
            </button>
            <button
              onClick={exportRecording}
              disabled={!canExport}
              className="flex-1 px-2 py-2 text-sm rounded bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Export JSON
            </button>
            <label className="flex-1 px-2 py-2 text-sm rounded bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium cursor-pointer flex items-center justify-center whitespace-nowrap">
              Load JSON
              <input type="file" accept=".json" className="hidden" onChange={importRecording} />
            </label>
          </div>

          {isRecording && (
            <div className="text-sm text-yellow-400 text-center">
              Press Arrow keys / D F J K (or any key except Space) to record overdub steps!
            </div>
          )}
          {recordedEvents.length > 0 && !isRecording && (
            <div className="flex items-center justify-between text-xs text-gray-400 px-1">
              <span className="font-mono tabular-nums">{recordedEvents.length} user events recorded</span>
              <button
                type="button"
                onClick={() => setRecordedEvents([])}
                className="text-gray-500 hover:text-red-400 transition-colors"
              >
                Clear User Taps
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
