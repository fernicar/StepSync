import { ChartDifficulty, DrumEvent, LaneIndex, Section, SyncData } from '../types';

export type PinkPantherSymbol = 'L' | '&' | 'R';
export type GroovePersona = 'Dancer' | 'Performer' | 'Drummer';
export type WindshieldPreset = 'glsl-space' | 'wormhole' | 'music-rain' | 'milkdrop';

export interface InputPercussionTrigger {
  wallTimeSec: number;
  band: 'kick' | 'snare' | 'tom' | 'hat';
  lane: LaneIndex;
  hatParity?: 'A' | 'B';
}

export interface MeterState {
  currentTime: number;
  songStartTime: number;
  songEndTime: number;
  inSongBounds: boolean;
  bpm: number;
  secondsPerBeat: number;
  beatFloat: number;
  beatIndex: number;
  beatPhase: number;
  eighthIndex: number;
  eighthPhase: number;
  barIndex: number;
  phraseIndex: number;
  beatInBar: number; // 1..4
  isAnd: boolean;
}

export interface PinkPantherState {
  barParity: 'A' | 'B'; // A = Even (L & R & L & L &), B = Odd (R & L & R & R &)
  stepInBar: number; // 0..7
  pattern: readonly PinkPantherSymbol[];
  symbol: PinkPantherSymbol;
  isCompensation: boolean; // Steps 6..7 repeat previous orientation for predictable bar-flip
  baseAngleDeg: number; // -45 | 0 | +45
  activeOrientationSign: -1 | 1; // Current body orientation (-1 Left, +1 Right)
}

export interface PercussionImpulseState {
  kick: number; // 0..1 momentum envelope
  snare: number; // 0..1 rebound envelope
  tom: number; // 0..1 displacement envelope
  tomDirection: -1 | 1;
  hat: number; // 0..1 crisp hi-hat energy
  hatParity: 'A' | 'B'; // Alternates on 1/16th steps (odd/even rule)
  hatA: number; // 0..1 Channel A energy
  hatB: number; // 0..1 Channel B energy
  totalEnergy: number; // 0..1 combined rhythmic intensity
}

export interface BodyLanguageTarget {
  meter: MeterState;
  step: PinkPantherState;
  impulses: PercussionImpulseState;
  persona: GroovePersona;
  targetAngleDeg: number; // Combined Base + Kick + Snare + Tom (-82..+82)
  kickOffsetDeg: number;
  snareOffsetDeg: number;
  tomOffsetDeg: number;
}

export interface WheelMotionState {
  visualAngleDeg: number;
  angularVelocity: number;
  peakKickGlow: number;
  peakSnareGlow: number;
  peakTomGlow: number;
  peakHatAGlow: number;
  peakHatBGlow: number;
}

const BAR_A_PATTERN: readonly PinkPantherSymbol[] = ['L', '&', 'R', '&', 'L', '&', 'L', '&'];
const BAR_B_PATTERN: readonly PinkPantherSymbol[] = ['R', '&', 'L', '&', 'R', '&', 'R', '&'];

// Orientation held across each 1/8th slot (even during '&', kicks maintain the body's current side)
const BAR_A_ORIENTATIONS: readonly (-1 | 1)[] = [-1, -1, 1, 1, -1, -1, -1, -1];
const BAR_B_ORIENTATIONS: readonly (-1 | 1)[] = [1, 1, -1, -1, 1, 1, 1, 1];

export function getPersonaForDifficulty(difficulty: ChartDifficulty): GroovePersona {
  if (difficulty === 'easy') return 'Dancer';
  if (difficulty === 'normal') return 'Performer';
  return 'Drummer';
}

export function computeSongMarkers(sync: SyncData, songDurationSec: number): {
  songStartTime: number;
  songEndTime: number;
  gridBeatCount: number;
} {
  const safeBpm = Math.max(20, sync.bpm || 120);
  const beatDur = 60 / safeBpm;
  const dur = songDurationSec > 0 ? songDurationSec : 180;
  const maxBeats = Math.floor((dur - sync.offset) / beatDur);
  const gridBeatCount = Math.max(4, Math.floor(maxBeats / 4) * 4);
  const songStartTime = sync.offset;
  const songEndTime = sync.offset + gridBeatCount * beatDur;
  return { songStartTime, songEndTime, gridBeatCount };
}

/**
 * Computes normalized pulse amplitude (0..1) from event triggers inside a deterministic lookback window.
 * Fast-attack (~8ms) + smooth exponential falloff so peak feel behaves identically regardless of seek/loop.
 */
function evalImpulse(dtSec: number, attackSec: number, decaySec: number): number {
  if (dtSec < -0.008 || dtSec > decaySec * 3.5) return 0;
  const shifted = Math.max(0, dtSec + 0.008);
  const attack = shifted < attackSec ? shifted / attackSec : 1;
  const decay = Math.exp(-Math.max(0, shifted - attackSec) / decaySec);
  return Math.max(0, Math.min(1, attack * decay));
}

function lowerBoundByTime(events: DrumEvent[], targetTime: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].time < targetTime) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Pure deterministic decoder: state = f(currentTime, BPM, Start, End, ChartEvents)
 * Zero historical integration drift across scrubbing, pausing, or looping.
 */
export function evaluateRhythmBodyLanguage(params: {
  currentTime: number;
  sync: SyncData;
  songDurationSec: number;
  drumEvents: DrumEvent[];
  tomBandSet: Set<string>;
  difficulty: ChartDifficulty;
  sections?: Section[];
  loopDurationSec?: number;
  pinkPantherScale?: number; // -2.0 .. +2.0 (default 0.2 = +20%)
  percussionScale?: number; // -2.0 .. +2.0 (default 2.0 = +200%)
  snareCounterKick?: boolean; // true = Snare pushes opposite current Kick orientation
  simpleBarOrientation?: boolean; // true = Bar A Left (-1), Bar B Right (+1) for percussion
  useInputTriggers?: boolean; // true in Input mode: Kick/Snare/Tom respond strictly to user key hits
  inputTriggers?: readonly InputPercussionTrigger[];
  inputNowSec?: number;
}): BodyLanguageTarget {
  const {
    currentTime,
    sync,
    songDurationSec,
    drumEvents,
    tomBandSet,
    difficulty,
    loopDurationSec,
    pinkPantherScale = 0.2,
    percussionScale = 2,
    snareCounterKick = true,
    simpleBarOrientation = true,
    useInputTriggers = false,
    inputTriggers = [],
    inputNowSec = 0,
  } = params;

  const safeBpm = Math.max(20, sync.bpm || 120);
  const secondsPerBeat = 60 / safeBpm;
  const { songStartTime, songEndTime } = computeSongMarkers(sync, songDurationSec);

  // Layer 1 - Meter (purely derived from BPM + Start Marker + Current Time)
  const inSongBounds =
    currentTime >= songStartTime - 0.01 && currentTime <= songEndTime + 0.01;
  const rawBeatFloat = (currentTime - songStartTime) / secondsPerBeat;
  const clampedBeatFloat = inSongBounds
    ? Math.max(0, rawBeatFloat)
    : rawBeatFloat < 0
    ? 0
    : Math.max(0, (songEndTime - songStartTime) / secondsPerBeat);

  const beatIndex = Math.floor(clampedBeatFloat);
  const beatPhase = clampedBeatFloat - beatIndex;
  const rawEighth = clampedBeatFloat * 2;
  const eighthIndex = Math.floor(rawEighth);
  const eighthPhase = rawEighth - eighthIndex;
  const barIndex = Math.floor(beatIndex / 4);
  const phraseIndex = Math.floor(barIndex / 4);
  const beatInBar = ((beatIndex % 4) + 4) % 4 + 1;
  const isAnd = (((eighthIndex % 2) + 2) % 2) === 1;

  const meter: MeterState = {
    currentTime,
    songStartTime,
    songEndTime,
    inSongBounds,
    bpm: safeBpm,
    secondsPerBeat,
    beatFloat: clampedBeatFloat,
    beatIndex,
    beatPhase,
    eighthIndex,
    eighthPhase,
    barIndex,
    phraseIndex,
    beatInBar,
    isAnd,
  };

  // Layer 2 - Pink Panther Step (predictable bar-level orientation inversion)
  const isBarA = ((barIndex % 2) + 2) % 2 === 0;
  const pattern = isBarA ? BAR_A_PATTERN : BAR_B_PATTERN;
  const orientMap = isBarA ? BAR_A_ORIENTATIONS : BAR_B_ORIENTATIONS;
  const stepInBar = ((eighthIndex % 8) + 8) % 8;
  const symbol = pattern[stepInBar];
  const isCompensation = stepInBar >= 6;

  const rawBaseAngleDeg = symbol === 'L' ? -45 : symbol === 'R' ? 45 : 0;
  const baseAngleDeg = rawBaseAngleDeg * pinkPantherScale;
  const activeOrientationSign = orientMap[stepInBar];
  const percussionOrientationSign: -1 | 1 = simpleBarOrientation
    ? isBarA
      ? -1
      : 1
    : activeOrientationSign;

  const step: PinkPantherState = {
    barParity: isBarA ? 'A' : 'B',
    stepInBar,
    pattern,
    symbol,
    isCompensation,
    baseAngleDeg,
    activeOrientationSign,
  };

  // Layer 3 - Percussion Perturbations (deterministic lookback around currentTime)
  let kick = 0;
  let snare = 0;
  let tom = 0;
  let tomDirection: -1 | 1 = percussionOrientationSign;
  let hat = 0;
  let hatA = 0;
  let hatB = 0;
  let activeHatParity: 'A' | 'B' =
    Math.abs(Math.round(clampedBeatFloat * 4)) % 2 === 1 ? 'A' : 'B';

  if (useInputTriggers) {
    for (let i = 0; i < inputTriggers.length; i++) {
      const trig = inputTriggers[i];
      const dt = inputNowSec - trig.wallTimeSec;
      if (dt < -0.01 || dt > 0.75) continue;
      const amp = 0.95;
      if (trig.band === 'kick') {
        const v = evalImpulse(dt, 0.01, 0.145) * amp;
        if (v > kick) kick = v;
      } else if (trig.band === 'snare') {
        const v = evalImpulse(dt, 0.008, 0.125) * amp;
        if (v > snare) snare = v;
      } else if (trig.band === 'hat') {
        const v = evalImpulse(dt, 0.006, 0.075) * amp;
        const parity: 'A' | 'B' = trig.hatParity ?? (i % 2 === 1 ? 'A' : 'B');
        if (v > hat) {
          hat = v;
          activeHatParity = parity;
        }
        if (parity === 'A' && v > hatA) hatA = v;
        if (parity === 'B' && v > hatB) hatB = v;
      } else if (trig.band === 'tom') {
        const v = evalImpulse(dt, 0.012, 0.18) * amp;
        if (v > tom) {
          tom = v;
          tomDirection = trig.lane <= 1 ? -1 : 1;
        }
      }
    }
  } else if (drumEvents.length > 0 && inSongBounds) {
    const windowSec = 0.34;
    const scanEventsAround = (evalTime: number) => {
      const startIdx = lowerBoundByTime(drumEvents, evalTime - windowSec);
      for (let i = startIdx; i < drumEvents.length; i++) {
        const ev = drumEvents[i];
        const dt = evalTime - ev.time;
        if (dt < -0.01) break;

        const amp = Math.max(0.45, Math.min(1.15, ev.energy || 0.8));

        if (ev.band === 'kick') {
          const v = evalImpulse(dt, 0.01, 0.145) * amp;
          if (v > kick) kick = v;
        } else if (ev.band === 'snare') {
          const v = evalImpulse(dt, 0.008, 0.125) * amp;
          if (v > snare) snare = v;
        } else if (ev.band === 'hat') {
          const v = evalImpulse(dt, 0.006, 0.075) * amp;
          const evBeat =
            typeof ev.beat === 'number'
              ? ev.beat
              : (ev.time - songStartTime) / secondsPerBeat;
          // 1/16th odd/even rule: Odd 1/16 => Channel A, Even 1/16 => Channel B
          const sixteenthSlot = Math.round(evBeat * 4);
          const parity: 'A' | 'B' = Math.abs(sixteenthSlot) % 2 === 1 ? 'A' : 'B';
          if (v > hat) {
            hat = v;
            activeHatParity = parity;
          }
          if (parity === 'A' && v > hatA) hatA = v;
          if (parity === 'B' && v > hatB) hatB = v;
        } else if (tomBandSet.has(ev.band) || ev.band === 'tom') {
          const v = evalImpulse(dt, 0.012, 0.18) * amp;
          if (v > tom) {
            tom = v;
            // Alternate L/R on lane (Lanes 0/1 sweep left, Lanes 2/3 sweep right)
            tomDirection = ev.lane <= 1 ? -1 : 1;
          }
        }
      }
    };

    scanEventsAround(currentTime);
    // Seamlessly evaluate tail envelopes when track loops back near 0s
    if (loopDurationSec && currentTime < windowSec && loopDurationSec > windowSec) {
      scanEventsAround(currentTime + loopDurationSec);
    }
  }

  kick = Math.min(1, kick);
  snare = Math.min(1, snare);
  tom = Math.min(1, tom);
  hat = Math.min(1, hat);
  hatA = Math.min(1, hatA);
  hatB = Math.min(1, hatB);

  const totalEnergy = Math.min(
    1,
    kick * 0.45 + snare * 0.35 + tom * 0.35 + hat * 0.2
  );

  const impulses: PercussionImpulseState = {
    kick,
    snare,
    tom,
    tomDirection,
    hat,
    hatParity: activeHatParity,
    hatA,
    hatB,
    totalEnergy,
  };

  // Persona gain tuning layered atop filtered Easy / Normal / Hard chart density
  const persona = getPersonaForDifficulty(difficulty);
  const kickGain = difficulty === 'easy' ? 18 : difficulty === 'normal' ? 24 : 30;
  const snareGain = difficulty === 'easy' ? 0.55 : difficulty === 'normal' ? 0.72 : 0.85;
  const tomGain = difficulty === 'easy' ? 24 : difficulty === 'normal' ? 32 : 42;

  const activePlayerInput = useInputTriggers && (kick > 0 || snare > 0 || tom > 0 || hat > 0);

  // Outside song bounds: keep neutral calm posture unless player is actively tapping in Input mode
  if (!inSongBounds && !activePlayerInput) {
    return {
      meter,
      step: {
        ...step,
        symbol: '&',
        baseAngleDeg: 0,
        isCompensation: false,
      },
      impulses,
      persona,
      targetAngleDeg: 0,
      kickOffsetDeg: 0,
      snareOffsetDeg: 0,
      tomOffsetDeg: 0,
    };
  }

  const effectiveBaseDeg = inSongBounds ? baseAngleDeg : 0;

  // Kick -> pushes wheel further toward current percussion orientation (momentum)
  const kickOffsetDeg = percussionOrientationSign * kick * kickGain * percussionScale;

  // Snare -> either counters current Kick orientation directly (cancels simultaneous Kick)
  // or pulls pre-snare angle back toward 0° center (rebound)
  const preSnareAngle = effectiveBaseDeg + kickOffsetDeg;
  const snareOffsetDeg = snareCounterKick
    ? -percussionOrientationSign * snare * kickGain * percussionScale
    : -preSnareAngle * snare * snareGain * percussionScale;

  // Tom -> temporary expressive displacement (stronger lateral sweep than snare)
  const tomOffsetDeg = tomDirection * tom * tomGain * percussionScale;

  const rawTarget = preSnareAngle + snareOffsetDeg + tomOffsetDeg;
  const targetAngleDeg = Math.max(-180, Math.min(180, rawTarget));

  return {
    meter,
    step,
    impulses,
    persona,
    targetAngleDeg,
    kickOffsetDeg,
    snareOffsetDeg,
    tomOffsetDeg,
  };
}

/**
 * Target-following smoothing with asymmetric rise/settle dynamics
 * (rises swiftly on transient energy, settles gracefully like a vintage peak-hold meter).
 */
export function stepWheelMotionState(
  prev: WheelMotionState,
  target: BodyLanguageTarget,
  dtSec: number
): WheelMotionState {
  const dt = Math.min(0.05, Math.max(0.001, dtSec));
  const diff = target.targetAngleDeg - prev.visualAngleDeg;

  const isRisingOutward =
    Math.abs(target.targetAngleDeg) > Math.abs(prev.visualAngleDeg) &&
    target.impulses.totalEnergy > 0.15;
  const rate = isRisingOutward ? 16.5 : 10.5;
  const smoothing = 1 - Math.exp(-rate * dt);

  const nextAngle = prev.visualAngleDeg + diff * smoothing;
  const velocity = (nextAngle - prev.visualAngleDeg) / dt;

  // Peak-dot luminance indicators: fast rise, musical decay
  const glowStep = (cur: number, next: number) =>
    next >= cur ? next : cur * Math.exp(-6.5 * dt);

  return {
    visualAngleDeg: nextAngle,
    angularVelocity: velocity,
    peakKickGlow: glowStep(prev.peakKickGlow, target.impulses.kick),
    peakSnareGlow: glowStep(prev.peakSnareGlow, target.impulses.snare),
    peakTomGlow: glowStep(prev.peakTomGlow, target.impulses.tom),
    peakHatAGlow: glowStep(prev.peakHatAGlow, target.impulses.hatA),
    peakHatBGlow: glowStep(prev.peakHatBGlow, target.impulses.hatB),
  };
}
