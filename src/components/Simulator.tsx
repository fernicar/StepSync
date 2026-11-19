import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw, Settings, Square, Video, X } from 'lucide-react';
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
import { triggerBlobDownload } from '../lib/projectCache';
import {
  ScreensaverExportHandle,
  ScreensaverVisualizer,
  ScreensaverWebmExportState,
} from './ScreensaverVisualizer';
import type { InputPercussionTrigger } from '../lib/rhythmBodyLanguage';

function formatDurationClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

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

  const [simViewMode, setSimViewMode] = useState<'stepmania' | 'screensaver'>('stepmania');

  const [pinkPantherPct, setPinkPantherPct] = useState(20);
  const [percussionPct, setPercussionPct] = useState(200);
  const [snareCounterKick, setSnareCounterKick] = useState(true);
  const [simpleBarOrientation, setSimpleBarOrientation] = useState(true);

  const screensaverExportRef = useRef<ScreensaverExportHandle | null>(null);
  const [exportWidth, setExportWidth] = useState(1280);
  const [exportHeight, setExportHeight] = useState(720);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [webmExportState, setWebmExportState] = useState<ScreensaverWebmExportState>({
    status: 'idle',
    elapsedSec: 0,
    durationSec: 0,
    error: null,
    lastFileName: null,
  });

  useEffect(() => {
    if (simViewMode !== 'screensaver') {
      setWebmExportState((prev) =>
        prev.status === 'idle'
          ? prev
          : { status: 'idle', elapsedSec: 0, durationSec: 0, error: null, lastFileName: prev.lastFileName }
      );
    }
  }, [simViewMode]);

  const [isRecording, setIsRecording] = useState(false);
  const [recordedEvents, setRecordedEvents] = useState<RecordedTap[]>([]);
  const [showDrumBaseLayer, setShowDrumBaseLayer] = useState(true);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const showDrumBaseLayerRef = useRef(showDrumBaseLayer);
  showDrumBaseLayerRef.current = showDrumBaseLayer;

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
  const playerInputTriggersRef = useRef<InputPercussionTrigger[]>([]);
  const playerHatParityCounterRef = useRef(0);

  const simSoundModeRef = useRef(simSoundMode);
  simSoundModeRef.current = simSoundMode;
  const simSoundEnabledRef = useRef(simSoundEnabled);
  simSoundEnabledRef.current = simSoundEnabled;
  const laneRulesRef = useRef(laneRules);
  laneRulesRef.current = laneRules;

  const resetPlayScore = useCallback(() => {
    judgedNotesRef.current.clear();
    playerInputTriggersRef.current = [];
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
    if (simSoundMode !== 'input') {
      playerInputTriggersRef.current = [];
    }
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

    const resolveInputSimBand = (explicitLane: LaneIndex, hitBand?: string): SimDrumBand => {
      if (hitBand) {
        const matched = bandToSimBand(hitBand);
        if (matched) return matched;
      }
      for (const rule of laneRulesRef.current) {
        if (rule.lane === explicitLane) {
          const sb = bandToSimBand(rule.id);
          if (sb) return sb;
        }
      }
      for (const rule of laneRulesRef.current) {
        if (getEffectiveAltLane(rule) === explicitLane) {
          const sb = bandToSimBand(rule.id);
          if (sb) return sb;
        }
      }
      const fallbackMap: Record<LaneIndex, SimDrumBand> = {
        0: 'hat',
        1: 'tom',
        2: 'kick',
        3: 'snare',
      };
      return fallbackMap[explicitLane];
    };

    const recordInputWheelTrigger = (explicitLane: LaneIndex, resolvedBand: SimDrumBand) => {
      if (simSoundModeRef.current !== 'input') return;
      const nowSec = performance.now() / 1000;
      const trig: InputPercussionTrigger = {
        wallTimeSec: nowSec,
        band: resolvedBand,
        lane: explicitLane,
        hatParity:
          resolvedBand === 'hat'
            ? ((playerHatParityCounterRef.current++ % 2 === 0 ? 'A' : 'B') as 'A' | 'B')
            : undefined,
      };
      const arr = playerInputTriggersRef.current;
      const pruned = arr.filter((item) => nowSec - item.wallTimeSec <= 1.2);
      pruned.push(trig);
      playerInputTriggersRef.current = pruned;
    };

    const playInputLaneSound = (explicitLane: LaneIndex, hitBand?: string) => {
      const resolved = resolveInputSimBand(explicitLane, hitBand);
      recordInputWheelTrigger(explicitLane, resolved);
      if (simSoundModeRef.current !== 'input') return;
      const enabled = simSoundEnabledRef.current;
      if (enabled[resolved]) {
        engine.playClick(resolved, undefined, 'sim');
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
    triggerBlobDownload(blob, 'recorded-events.json');
  };

  // Shared Demo auto-play & Input auto-miss sweep used by both StepMania and Screensaver views
  const evaluatePlaybackJudgement = useCallback((currentTime: number) => {
    const chartEvents = drumEventsRef.current;
    const hasMapped = showDrumBaseLayerRef.current && chartEvents.length > 0;
    if (isRecordingRef.current || calibrationPhaseRef.current !== 'IDLE' || !hasMapped) {
      prevTrackTimeRef.current = currentTime;
      return;
    }

    const evalTime = currentTime - delayCompRef.current;
    const prevTime = prevTrackTimeRef.current;

    if (simSoundModeRef.current === 'demo') {
      if (prevTime !== null && prevTime - currentTime > 2.0 && engine.getLoop()) {
        judgedNotesRef.current.clear();
      } else if (prevTime === null || Math.abs(currentTime - prevTime) > 0.5) {
        for (let i = 0; i < chartEvents.length; i++) {
          if (chartEvents[i].time < currentTime && !judgedNotesRef.current.has(i)) {
            judgedNotesRef.current.set(i, 'skipped');
          }
        }
      } else if ((isPlayingRef.current || engine.getIsPlaying()) && currentTime >= prevTime) {
        let demoHits = 0;
        for (let i = 0; i < chartEvents.length; i++) {
          if (judgedNotesRef.current.has(i)) continue;
          if (chartEvents[i].time <= currentTime) {
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
      return;
    }

    if (prevTime !== null && prevTime - currentTime > 2.0 && engine.getLoop()) {
      judgedNotesRef.current.clear();
    } else if (prevTime === null || Math.abs(currentTime - prevTime) > 0.5) {
      for (let i = 0; i < chartEvents.length; i++) {
        if (chartEvents[i].time < evalTime - 0.18 && !judgedNotesRef.current.has(i)) {
          judgedNotesRef.current.set(i, 'skipped');
        }
      }
    } else if ((isPlayingRef.current || engine.getIsPlaying()) && currentTime >= prevTime) {
      let newMisses = 0;
      for (let i = 0; i < chartEvents.length; i++) {
        if (judgedNotesRef.current.has(i)) continue;
        if (chartEvents[i].time < evalTime - 0.18) {
          judgedNotesRef.current.set(i, 'miss');
          newMisses++;
        } else if (chartEvents[i].time > evalTime) {
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
  }, []);

  useEffect(() => {
    if (simViewMode !== 'stepmania') return;
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
      evaluatePlaybackJudgement(currentTime);

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

      const rootPx = parseFloat(document.documentElement.style.fontSize) || 20;
      const scaleF = rootPx / 16;

      for (let i = 0; i < 4; i++) {
        const cx = i * laneWidth + laneWidth / 2;
        const isPressed =
          simSoundModeRef.current !== 'demo' && pressedLanesRef.current[i];
        const activeColor = laneHitFlashColor[i] || (isPressed ? '#ffffff' : null);

        ctx.fillStyle = activeColor || 'rgba(255,255,255,0.45)';
        ctx.font = `bold ${Math.round(11 * scaleF)}px monospace`;
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
        ctx.font = `${Math.round(12 * scaleF)}px monospace`;
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
          ctx.font = `${Math.round(12 * scaleF)}px monospace`;
          ctx.fillText(i.toString(), 5, beatY - 5);

          if (secCue) {
            const cueText = `${secCue.label} · ${secCue.density}`;
            ctx.save();
            ctx.font = `bold ${Math.round(10 * scaleF)}px monospace`;
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
          ctx.font = `bold ${Math.round(18 * scaleF)}px monospace`;
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
            ctx.font = `bold ${Math.round(11 * scaleF)}px monospace`;
            ctx.lineWidth = 3;
            ctx.strokeText(errStr, width / 2, 174);
            ctx.fillStyle =
              lastHud.offsetMs < 0 ? '#7dd3fc' : lastHud.offsetMs > 0 ? '#fcd34d' : '#ffffff';
            ctx.fillText(errStr, width / 2, 174);
          }

          if (lastHud.combo >= 2) {
            const comboText = `${lastHud.combo} COMBO`;
            ctx.font = `bold ${Math.round(15 * scaleF)}px monospace`;
            ctx.lineWidth = 4;
            ctx.strokeText(comboText, width / 2, 200);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(comboText, width / 2, 200);
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
    simViewMode,
    evaluatePlaybackJudgement,
  ]);

  const [importSettingsOpen, setImportSettingsOpen] = useState(false);

  const canExport = recordedEvents.length > 0 || (showDrumBaseLayer && drumEvents.length > 0);
  const effectiveScreensaverEvents = showDrumBaseLayer ? drumEvents : [];

  return (
    <div className="flex flex-col md:flex-row gap-4 items-start justify-center w-full">
      {/* LEFT COLUMN: Nested Simulation Stage Tabs (StepMania | Screensaver) */}
      <div
        className={cn(
          'flex flex-col items-stretch',
          simViewMode === 'screensaver'
            ? 'w-full flex-1 min-w-0'
            : 'w-[360px] flex-shrink-0 items-center'
        )}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5 w-full">
          <div className="inline-flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setSimViewMode('stepmania')}
              className={cn(
                'px-2 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                simViewMode === 'stepmania'
                  ? 'bg-emerald-500 text-gray-950 font-semibold'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
              )}
            >
              StepMania
            </button>
            <button
              type="button"
              onClick={() => setSimViewMode('screensaver')}
              className={cn(
                'px-2 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                simViewMode === 'screensaver'
                  ? 'bg-emerald-500 text-gray-950 font-semibold'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
              )}
            >
              Screensaver
            </button>
          </div>
          <span className="text-xs font-mono text-gray-500 truncate">
            {simViewMode === 'stepmania' ? 'D F J K' : 'D F J K · 1-4 Presets'}
          </span>
        </div>

        {simViewMode === 'stepmania' ? (
          <>
            <canvas
              ref={canvasRef}
              className="bg-black block"
              width={360}
              height={500}
            />
            <div className="mt-1.5 text-center text-gray-500 text-xs font-mono">
              Space: Play/Pause · D F J K / Arrows: Lanes
            </div>
          </>
        ) : (
          <ScreensaverVisualizer
            sync={sync}
            sections={sections}
            isPlaying={isPlaying}
            songDurationSec={audioMeta?.duration || engine.getBuffer()?.duration || 180}
            drumEvents={effectiveScreensaverEvents}
            tomBandIds={tomBandIds}
            difficulty={difficulty}
            pinkPantherPct={pinkPantherPct}
            percussionPct={percussionPct}
            snareCounterKick={snareCounterKick}
            simpleBarOrientation={simpleBarOrientation}
            simSoundMode={simSoundMode}
            simSoundEnabled={simSoundEnabled}
            pressedLanesRef={pressedLanesRef}
            judgedNotesRef={judgedNotesRef}
            lastJudgementHudRef={lastJudgementHudRef}
            playerInputTriggersRef={playerInputTriggersRef}
            playScore={playScore}
            playScoreRef={scoreMutableRef}
            onPlaybackTick={evaluatePlaybackJudgement}
            fileName={audioMeta?.fileName}
            onChangeSimSoundMode={onChangeSimSoundMode}
            onBeforeDemoExportStart={resetPlayScore}
            exportHandleRef={screensaverExportRef}
            onWebmExportStateChange={setWebmExportState}
            exportWidth={exportWidth}
            exportHeight={exportHeight}
          />
        )}
      </div>

      {/* RIGHT COLUMN: Flat Borderless Controls */}
      <div
        className={cn(
          'flex flex-col w-full space-y-3',
          simViewMode === 'screensaver' ? 'md:w-[22rem] lg:w-[24rem] shrink-0' : 'max-w-md'
        )}
      >
        {/* Sync Summary */}
        <div className="flex items-center gap-4 font-mono tabular-nums">
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold text-white">{sync.bpm.toFixed(2)}</span>
            <span className="text-xs text-gray-500 uppercase">BPM</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold text-emerald-400">{sync.offset.toFixed(3)}s</span>
            <span className="text-xs text-gray-500 uppercase">Offset</span>
          </div>
        </div>

        {/* Difficulty & Overdub */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-gray-300">
              Chart ({drumEvents.length}{rawDrumEvents.length !== drumEvents.length ? `/${rawDrumEvents.length}` : ''})
            </span>
            <div className="inline-flex items-center gap-0.5">
              {(
                [
                  { id: 'easy', label: 'Easy', persona: 'Dancer', activeClass: 'bg-sky-500/20 text-sky-300' },
                  { id: 'normal', label: 'Normal', persona: 'Performer', activeClass: 'bg-amber-500/20 text-amber-300' },
                  { id: 'hard', label: 'Hard', persona: 'Drummer', activeClass: 'bg-emerald-500/20 text-emerald-300' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onChangeDifficulty(d.id)}
                  title={`${d.label} (${d.persona})`}
                  className={cn(
                    'px-2 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                    difficulty === d.id
                      ? cn(d.activeClass, 'font-semibold')
                      : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                  )}
                >
                  {simViewMode === 'screensaver' ? `${d.label} · ${d.persona}` : d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showDrumBaseLayer}
                disabled={drumEvents.length === 0}
                onChange={(e) => setShowDrumBaseLayer(e.target.checked)}
                className="rounded border-gray-700 text-emerald-500 focus:ring-emerald-500 bg-transparent w-3.5 h-3.5 cursor-pointer disabled:opacity-40"
              />
              <span>Drum Keys</span>
            </label>

            {drumEvents.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-amber-400">K</span>
                <span className="text-emerald-400">C</span>
                <span className="text-sky-400">H</span>
                {drumEvents.some((e) => e.color === 'pink' || (e.band !== 'kick' && e.band !== 'snare' && e.band !== 'hat')) && (
                  <span className="text-pink-400">T</span>
                )}
                <span className="text-rose-400">U</span>
              </div>
            )}
          </div>
        </div>

        {/* Body Language Tuning Sliders & Snare Rule Toggle (outside Screensaver viewport) */}
        {simViewMode === 'screensaver' && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPinkPantherPct(0)}
                className="text-gray-300 hover:text-white shrink-0 whitespace-nowrap text-left"
                title="Click to jump to 0% (center wheel) to isolate percussion"
              >
                Pink Panther
              </button>
              <input
                type="range"
                min={-200}
                max={200}
                step={5}
                value={pinkPantherPct}
                onChange={(e) => setPinkPantherPct(parseInt(e.target.value, 10))}
                aria-label="Pink Panther step scale percentage"
                className="w-full accent-emerald-500 h-1.5 cursor-pointer"
              />
              <button
                type="button"
                onClick={() => setPinkPantherPct(20)}
                className="font-mono tabular-nums text-emerald-300 hover:text-white w-12 text-right shrink-0"
                title="Click to reset to +20% default"
              >
                {pinkPantherPct > 0 ? `+${pinkPantherPct}%` : `${pinkPantherPct}%`}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPercussionPct(0)}
                className="text-gray-300 hover:text-white shrink-0 whitespace-nowrap text-left"
                title="Click to jump to 0% (Pink Panther step only)"
              >
                Percussion
              </button>
              <input
                type="range"
                min={-200}
                max={200}
                step={5}
                value={percussionPct}
                onChange={(e) => setPercussionPct(parseInt(e.target.value, 10))}
                aria-label="Percussion perturbation scale percentage"
                className="w-full accent-amber-400 h-1.5 cursor-pointer"
              />
              <button
                type="button"
                onClick={() => setPercussionPct(200)}
                className="font-mono tabular-nums text-amber-300 hover:text-white w-12 text-right shrink-0"
                title="Click to reset to +200% default"
              >
                {percussionPct > 0 ? `+${percussionPct}%` : `${percussionPct}%`}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span
                className="text-gray-300 whitespace-nowrap"
                title="OFF pulls pre-snare angle toward 0° center; ON makes Snare counter current Kick orientation"
              >
                Snare Counters Kick
              </span>
              <button
                type="button"
                aria-pressed={snareCounterKick}
                onClick={() => setSnareCounterKick((v) => !v)}
                className={cn(
                  'px-2 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap shrink-0 font-medium',
                  snareCounterKick
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                )}
              >
                {snareCounterKick ? 'ON · Opposite Kick' : 'OFF · Rebound 0°'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span
                className="text-gray-300 whitespace-nowrap"
                title="OFF follows L&R&L&L / R&L&R&R step orientation; ON holds Bar A Left and Bar B Right for percussion"
              >
                Drum Orientation
              </span>
              <button
                type="button"
                aria-pressed={simpleBarOrientation}
                onClick={() => setSimpleBarOrientation((v) => !v)}
                className={cn(
                  'px-2 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap shrink-0 font-medium',
                  simpleBarOrientation
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                )}
              >
                {simpleBarOrientation ? 'ON · Bar A: L · B: R' : 'OFF · Step L&R&L&L'}
              </button>
            </div>

            {/* Configurable Demo Video Export (.webm, default 1280×720) */}
            <div className="pt-1.5 border-t border-white/[0.06] space-y-1.5">
              {webmExportState.status === 'idle' ? (
                <>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-400 whitespace-nowrap">Demo Video</span>
                    <div className="inline-flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        aria-expanded={exportSettingsOpen}
                        onClick={() => setExportSettingsOpen((v) => !v)}
                        className={cn(
                          'inline-flex items-center justify-center p-1 rounded-sm transition-colors',
                          exportSettingsOpen
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'text-gray-400 hover:text-white hover:bg-white/[0.08]'
                        )}
                        title="Configure WebM export width and height (default 1280×720)"
                        aria-label="Export resolution settings"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          screensaverExportRef.current?.startDemoWebmExport({
                            width: exportWidth,
                            height: exportHeight,
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors whitespace-nowrap shrink-0"
                        title={`Render Demo playback (with active preset & audio) to a ${exportWidth}×${exportHeight} .webm video`}
                      >
                        <Video className="w-3.5 h-3.5" />
                        <span>
                          Export WebM · {exportWidth}×{exportHeight}
                        </span>
                      </button>
                    </div>
                  </div>

                  {exportSettingsOpen && (
                    <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5 rounded-sm bg-white/[0.03] border border-white/[0.06] text-xs">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setExportWidth(1280);
                            setExportHeight(720);
                          }}
                          className={cn(
                            'px-1.5 py-0.5 rounded-sm font-mono tabular-nums transition-colors',
                            exportWidth === 1280 && exportHeight === 720
                              ? 'bg-emerald-500/25 text-emerald-300 font-semibold'
                              : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                          )}
                        >
                          1280×720
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExportWidth(1920);
                            setExportHeight(1080);
                          }}
                          className={cn(
                            'px-1.5 py-0.5 rounded-sm font-mono tabular-nums transition-colors',
                            exportWidth === 1920 && exportHeight === 1080
                              ? 'bg-emerald-500/25 text-emerald-300 font-semibold'
                              : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                          )}
                        >
                          1920×1080
                        </button>
                      </div>
                      <div className="inline-flex items-center gap-1 font-mono tabular-nums">
                        <label className="inline-flex items-center gap-1 text-gray-400">
                          <span>W</span>
                          <input
                            type="number"
                            min={320}
                            max={3840}
                            step={2}
                            value={exportWidth}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!Number.isNaN(v)) {
                                setExportWidth(Math.max(320, Math.min(3840, v)));
                              }
                            }}
                            onBlur={() =>
                              setExportWidth((w) => Math.max(320, Math.min(3840, w - (w % 2))))
                            }
                            aria-label="Export video width"
                            className="w-14 px-1 py-0.5 rounded-sm bg-gray-950/80 border border-white/10 text-gray-200 text-right focus:outline-none focus:border-emerald-500/60"
                          />
                        </label>
                        <span className="text-gray-500">×</span>
                        <label className="inline-flex items-center gap-1 text-gray-400">
                          <span>H</span>
                          <input
                            type="number"
                            min={240}
                            max={2160}
                            step={2}
                            value={exportHeight}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!Number.isNaN(v)) {
                                setExportHeight(Math.max(240, Math.min(2160, v)));
                              }
                            }}
                            onBlur={() =>
                              setExportHeight((h) => Math.max(240, Math.min(2160, h - (h % 2))))
                            }
                            aria-label="Export video height"
                            className="w-14 px-1 py-0.5 rounded-sm bg-gray-950/80 border border-white/10 text-gray-200 text-right focus:outline-none focus:border-emerald-500/60"
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2 font-mono tabular-nums">
                    <span className="text-red-400 font-semibold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      {webmExportState.status === 'finalizing'
                        ? 'Saving WebM...'
                        : `REC Demo ${exportWidth}×${exportHeight}`}
                    </span>
                    <span className="text-gray-300">
                      {formatDurationClock(webmExportState.elapsedSec)} /{' '}
                      {formatDurationClock(webmExportState.durationSec)}
                    </span>
                  </div>
                  <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 transition-[width] duration-150"
                      style={{
                        width: `${
                          webmExportState.durationSec > 0
                            ? Math.min(100, (webmExportState.elapsedSec / webmExportState.durationSec) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      type="button"
                      disabled={webmExportState.status === 'finalizing'}
                      onClick={() => screensaverExportRef.current?.stopAndSaveDemoWebmExport()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-sm bg-emerald-500 hover:bg-emerald-400 text-gray-950 disabled:opacity-50 transition-colors"
                      title="Stop recording early and download the WebM clip captured so far"
                    >
                      <Square className="w-3 h-3" />
                      <span>Stop &amp; Save</span>
                    </button>
                    <button
                      type="button"
                      disabled={webmExportState.status === 'finalizing'}
                      onClick={() => screensaverExportRef.current?.cancelDemoWebmExport()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-sm bg-white/[0.06] hover:bg-white/[0.12] text-gray-300 disabled:opacity-50 transition-colors"
                    >
                      <X className="w-3 h-3" />
                      <span>Cancel</span>
                    </button>
                  </div>
                </div>
              )}

              {webmExportState.error && (
                <div className="text-xs text-red-400">{webmExportState.error}</div>
              )}
              {!webmExportState.error && webmExportState.status === 'idle' && webmExportState.lastFileName && (
                <div className="text-xs text-emerald-400 truncate font-mono">
                  Saved {webmExportState.lastFileName}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Audio Level & Stem Audition Mode */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-400 shrink-0">Audio</span>
          <div className="flex items-center gap-1 flex-1 min-w-0">
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
            <span className="text-xs font-mono tabular-nums text-gray-400 w-9 text-right shrink-0">
              {Math.round(trackVolume * 100)}%
            </span>
          </div>
          {hasDrumStem && onChangeAuditionMode && (
            <div className="inline-flex items-center gap-0.5 shrink-0">
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
                    'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap shrink-0',
                    auditionMode === m.id
                      ? 'bg-emerald-500 text-gray-950 font-semibold'
                      : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Perfect Hit Sound Simulation (Demo / Sync / Input + Flat Band Toggles) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs text-gray-400">Sim Sound</span>
              <select
                value={simSoundMode}
                onChange={(e) => onChangeSimSoundMode?.(e.target.value as SimSoundMode)}
                className="bg-transparent hover:bg-white/[0.06] rounded-sm px-1.5 py-0.5 text-xs font-medium text-gray-200 focus:outline-none cursor-pointer"
                title="Demo: plays chart sounds & ignores input (Demotest Score) · Sync: plays chart sounds regardless of input · Input: plays only on player input"
              >
                <option value="demo" className="bg-gray-950 text-gray-200">
                  Demo
                </option>
                <option value="sync" className="bg-gray-950 text-gray-200">
                  Sync
                </option>
                <option value="input" className="bg-gray-950 text-gray-200">
                  Input
                </option>
              </select>
            </div>
            <div className="flex items-center gap-1 flex-1 min-w-0 max-w-[11rem]">
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
              <span className="text-xs font-mono tabular-nums text-gray-400 w-9 text-right shrink-0">
                {Math.round(simVolume * 100)}%
              </span>
            </div>
          </div>
          <div
            className={cn(
              'grid gap-0.5',
              hasTomBand ? 'grid-cols-4' : 'grid-cols-3'
            )}
          >
            {(
              [
                {
                  id: 'kick',
                  label: 'Kick',
                  activeClass: 'bg-amber-500/20 text-amber-300 font-semibold',
                },
                {
                  id: 'snare',
                  label: 'Snare',
                  activeClass: 'bg-emerald-500/20 text-emerald-300 font-semibold',
                },
                {
                  id: 'hat',
                  label: 'Hi-Hat',
                  activeClass: 'bg-sky-500/20 text-sky-300 font-semibold',
                },
                ...(hasTomBand
                  ? [
                      {
                        id: 'tom',
                        label: 'Tom',
                        activeClass: 'bg-pink-500/20 text-pink-300 font-semibold',
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
                    'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1',
                    isOn
                      ? lane.activeClass
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                  )}
                >
                  <span>{lane.label}</span>
                  <span className="text-xs opacity-75">{isOn ? 'ON' : 'OFF'}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Flat Live Playtest / Demotest Score */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                {simSoundMode === 'demo' ? 'Demotest Score' : 'Playtest Score'}
              </h4>
              <span className="text-xs text-gray-500">
                {isRecording
                  ? 'Recording'
                  : simSoundMode === 'demo'
                  ? 'Auto-Play'
                  : 'D F J K'}
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

          <div className="grid grid-cols-3 gap-1 text-center">
            <div>
              <div className="text-base font-mono tabular-nums font-bold text-emerald-400">
                {playScore.accuracy.toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">Accuracy</div>
            </div>
            <div>
              <div className="text-base font-mono tabular-nums font-bold text-white">
                {playScore.combo}
              </div>
              <div className="text-xs text-gray-500">Combo</div>
            </div>
            <div>
              <div className="text-base font-mono tabular-nums font-bold text-amber-300">
                {playScore.maxCombo}
              </div>
              <div className="text-xs text-gray-500">Max</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs font-mono tabular-nums">
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
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className={TIER_META[playScore.lastTier].textClass}>
                {TIER_META[playScore.lastTier].label}
              </span>
              <span className="text-gray-400">
                {playScore.lastOffsetMs === null
                  ? 'Missed'
                  : playScore.lastOffsetMs === 0
                  ? '0 ms'
                  : `${playScore.lastOffsetMs > 0 ? '+' : ''}${playScore.lastOffsetMs} ms (${
                      playScore.lastOffsetMs < 0 ? 'Early' : 'Late'
                    })`}
              </span>
            </div>
          )}
        </div>

        {/* Collapsible Recording & Calibration Settings (collapsed by default) */}
        <div>
          <button
            type="button"
            onClick={() => setImportSettingsOpen((v) => !v)}
            className="w-full py-0.5 flex items-center justify-between text-xs text-gray-300 hover:text-white transition-colors"
            aria-expanded={importSettingsOpen}
          >
            <span className="font-medium">
              Calibration & Import{' '}
              <span className="text-gray-500 font-mono tabular-nums">
                ({delayCompensation.toFixed(3)}s · {autoQuantize ? '16th' : 'Raw'})
              </span>
            </span>
            {importSettingsOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            )}
          </button>

          {importSettingsOpen && (
            <div className="pt-1 space-y-1.5">
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoQuantize}
                  onChange={(e) => setAutoQuantize && setAutoQuantize(e.target.checked)}
                  className="rounded border-gray-700 text-emerald-500 focus:ring-emerald-500 bg-transparent w-3.5 h-3.5 cursor-pointer"
                />
                <span>Quantize imports & taps to nearest 16th</span>
              </label>

              <div className="space-y-0.5">
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
          )}
        </div>

        {/* Flat Action Strip */}
        <div className="space-y-1.5">
          {(calibrationPhaseState !== 'IDLE' || calibrationStats) && (
            <div
              className={`w-full px-2 py-1 text-xs text-center rounded-sm ${
                calibrationPhaseState === 'SUCCESS' || (calibrationPhaseState === 'IDLE' && calibrationStats)
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : calibrationPhaseState === 'FAILED'
                  ? 'text-red-400 bg-red-500/10'
                  : 'text-blue-400 bg-blue-500/10'
              }`}
            >
              <div className="font-medium">{calibrationMessage}</div>

              {calibrationPhaseState === 'TESTING' && (
                <div className="mt-1 text-base font-mono tabular-nums text-blue-300">
                  {liveTapCount} <span className="text-xs text-gray-400">taps recorded</span>
                </div>
              )}

              {calibrationStats && (
                <div className="mt-1 text-xs opacity-85 flex flex-wrap justify-between gap-2 font-mono tabular-nums">
                  <span>Var: {calibrationStats.variance.toFixed(5)}</span>
                  <span>Mean: {(calibrationStats.mean * 1000).toFixed(0)}ms</span>
                  <span>Taps: {calibrationStats.count}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex w-full items-center gap-0.5">
            <button
              onClick={toggleRecording}
              className={`flex-1 px-2 py-1 text-xs font-medium rounded-sm flex items-center justify-center transition-colors whitespace-nowrap ${
                isRecording ? 'bg-red-500 hover:bg-red-600 text-white' : 'hover:bg-white/[0.06] text-gray-200'
              }`}
            >
              <span>{isRecording ? 'Stop' : 'Record / Calibrate'}</span>
            </button>
            <button
              onClick={exportRecording}
              disabled={!canExport}
              className="flex-1 px-2 py-1 text-xs rounded-sm hover:bg-white/[0.06] text-gray-200 font-medium disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Export JSON
            </button>
            <label className="flex-1 px-2 py-1 text-xs rounded-sm hover:bg-white/[0.06] text-gray-200 font-medium cursor-pointer flex items-center justify-center whitespace-nowrap">
              Load JSON
              <input type="file" accept=".json" className="hidden" onChange={importRecording} />
            </label>
          </div>

          {isRecording && (
            <div className="text-xs text-yellow-400 text-center">
              Press Arrow keys or D F J K to record overdub steps!
            </div>
          )}
          {recordedEvents.length > 0 && !isRecording && (
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span className="font-mono tabular-nums">{recordedEvents.length} user events recorded</span>
              <button
                type="button"
                onClick={() => setRecordedEvents([])}
                className="text-gray-500 hover:text-red-400 transition-colors"
              >
                Clear Taps
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
