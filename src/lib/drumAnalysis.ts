import { createFFTPlan, fftInPlace } from './fft';
import {
  BandEnvelopes,
  ChartDifficulty,
  DensitySubdivisionCap,
  DifficultyCellRule,
  DifficultyDensityMatrix,
  DrumEvent,
  DrumLaneRule,
  LaneDistributeMode,
  LaneIndex,
  ManualNoteEdits,
  Section,
  SpectralEnvelopeCache,
  SyncData,
} from '../types';

export const DEFAULT_LANE_RULES: DrumLaneRule[] = [
  {
    id: 'kick',
    name: 'Kick',
    enabled: true,
    minHz: 35,
    maxHz: 140,
    sensitivity: 0.02,
    lane: 2, // J
    altLane: null,
    distributeEvenOdd: false,
    distributeMode: 'fixed',
    limiter: 8, // Max 1/8th speed: ignores 16th-note kick shadows while keeping "tum-tum" 8ths
    color: 'amber',
    badge: 'K',
    isDefault: true,
  },
  {
    id: 'snare',
    name: 'Snare / Clap',
    enabled: true,
    minHz: 180,
    maxHz: 2500,
    sensitivity: 0.6,
    lane: 3, // K
    altLane: null,
    distributeEvenOdd: false,
    distributeMode: 'fixed',
    limiter: 16,
    color: 'emerald',
    badge: 'C',
    isDefault: true,
  },
  {
    id: 'hat',
    name: 'Hi-Hat',
    enabled: false,
    minHz: 4500,
    maxHz: 16000,
    sensitivity: 0.55,
    lane: 0, // D
    altLane: 1, // Alt: F
    distributeEvenOdd: false,
    limiter: 16, // Max 1/16th speed: ignores 32nd-note cymbal sizzle chatter
    color: 'sky',
    badge: 'H',
    isDefault: true,
  },
  {
    id: 'tom',
    name: 'Tom',
    enabled: false,
    minHz: 110,
    maxHz: 300,
    sensitivity: 0.5,
    lane: 1, // F
    altLane: null, // Fixed
    distributeEvenOdd: false,
    distributeMode: 'fixed',
    limiter: 16,
    color: 'pink',
    badge: 'T',
    isDefault: true,
  },
];

export function getEffectiveDistributeMode(rule: DrumLaneRule): LaneDistributeMode {
  if (rule.distributeMode) return rule.distributeMode;
  return rule.distributeEvenOdd ? 'dk-alt' : 'fixed';
}

export function getEffectiveAltLane(rule: DrumLaneRule): LaneIndex | null {
  if (rule.altLane !== undefined) {
    return rule.altLane !== null && rule.altLane !== rule.lane ? rule.altLane : null;
  }
  const mode = getEffectiveDistributeMode(rule);
  if (mode === 'dk-alt') {
    return rule.lane === 3 ? 0 : 3;
  }
  if (mode === 'fj-alt') {
    return rule.lane === 2 ? 1 : 2;
  }
  return null;
}

/**
 * Extracts 100 Hz (10ms hop) normalized spectral-flux envelopes for default presets:
 *  - Kick:       35 - 140 Hz (weighted toward 35 - 115 Hz deep sub punch)
 *  - Snare/Clap: 180 - 2500 Hz (weighted toward 180 - 750 Hz clap/snare body + snap)
 *  - Hi-Hat:     4500 - 16000 Hz (high metallic tick transients)
 */
export function computeBandEnvelopesFromPCM(
  mono: Float32Array,
  sampleRate: number,
  onProgress?: (pct: number) => void
): BandEnvelopes {
  const fftSize = 2048;
  const halfFft = fftSize >> 1;
  const hopSize = Math.max(128, Math.round(sampleRate * 0.01)); // ~10ms hop
  const hopTime = hopSize / sampleRate;
  const duration = mono.length / sampleRate;
  const frameCount = Math.max(1, Math.floor(mono.length / hopSize));

  const rawKick = new Float32Array(frameCount);
  const rawSnare = new Float32Array(frameCount);
  const rawHat = new Float32Array(frameCount);
  const kickBody = new Float32Array(frameCount);
  const snareBody = new Float32Array(frameCount);

  const plan = createFFTPlan(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  const halfBins = (fftSize >> 1) + 1;
  const hzPerBin = sampleRate / fftSize;

  const kickStart = Math.max(1, Math.floor(35 / hzPerBin));
  const kickSubEnd = Math.min(halfBins - 1, Math.ceil(115 / hzPerBin));
  const kickEnd = Math.min(halfBins - 1, Math.ceil(140 / hzPerBin));

  const snareStart = Math.max(kickEnd + 1, Math.floor(180 / hzPerBin));
  const snareBodyEnd = Math.floor(750 / hzPerBin);
  const snareEnd = Math.min(halfBins - 1, Math.ceil(2500 / hzPerBin));

  const hatStart = Math.max(snareEnd + 1, Math.floor(4500 / hzPerBin));
  const hatEnd = Math.min(halfBins - 1, Math.ceil(16000 / hzPerBin));

  const prevLogMag = new Float32Array(halfBins);
  const logGamma = 3.0;

  for (let f = 0; f < frameCount; f++) {
    // Center Hann window on t = f * hopTime so transient timestamps have zero half-window lag
    const startIdx = f * hopSize - halfFft;
    for (let i = 0; i < fftSize; i++) {
      const idx = startIdx + i;
      const sample = idx >= 0 && idx < mono.length ? mono[idx] : 0;
      real[i] = sample * plan.hann[i];
      imag[i] = 0;
    }

    fftInPlace(plan, real, imag, false);

    let kickFlux = 0;
    let kickEnergy = 0;
    let subEnergy = 0;
    let snareFlux = 0;
    let snareEnergy = 0;
    let sBodyEnergy = 0;
    let hatFlux = 0;
    let hatEnergy = 0;

    for (let b = 1; b < halfBins; b++) {
      const r = real[b];
      const im = imag[b];
      const mag = Math.sqrt(r * r + im * im);
      const logMag = Math.log1p(logGamma * mag);
      const posDiff = Math.max(0, logMag - prevLogMag[b]);
      prevLogMag[b] = logMag;

      if (b >= kickStart && b <= kickEnd) {
        kickFlux += posDiff * (b <= kickSubEnd ? 1.25 : 0.75);
        kickEnergy += mag;
        if (b <= kickSubEnd) subEnergy += mag;
      } else if (b >= snareStart && b <= snareEnd) {
        const w = b <= snareBodyEnd ? 1.65 : 0.75;
        snareFlux += posDiff * w;
        snareEnergy += mag * w;
        if (b <= snareBodyEnd) sBodyEnergy += mag;
      } else if (b >= hatStart && b <= hatEnd) {
        hatFlux += posDiff;
        hatEnergy += mag;
      }
    }

    const kickBins = Math.max(1, kickEnd - kickStart + 1);
    const snareBins = Math.max(1, snareEnd - snareStart + 1);
    const hatBins = Math.max(1, hatEnd - hatStart + 1);
    const subBins = Math.max(1, kickSubEnd - kickStart + 1);
    const sBodyBins = Math.max(1, snareBodyEnd - snareStart + 1);

    kickBody[f] = subEnergy / subBins;
    snareBody[f] = sBodyEnergy / sBodyBins;

    rawKick[f] = (kickFlux / kickBins) * Math.sqrt(1 + kickEnergy / kickBins);
    rawSnare[f] = (snareFlux / snareBins) * Math.sqrt(1 + (snareEnergy / snareBins) * 0.8);
    rawHat[f] = (hatFlux / hatBins) * Math.sqrt(1 + hatEnergy / hatBins);

    if (onProgress && f % 250 === 0) {
      onProgress((f / frameCount) * 90);
    }
  }

  // Scale-invariant reference for snare/clap body so cross-band gating works at any audio gain
  const snareSamples: number[] = [];
  for (let i = 0; i < frameCount; i += 8) {
    snareSamples.push(snareBody[i]);
  }
  snareSamples.sort((a, b) => a - b);
  const snareRef = snareSamples[Math.floor(snareSamples.length * 0.96)] || 1e-6;

  const kick = new Float32Array(rawKick);
  const snare = new Float32Array(rawSnare);
  const hat = new Float32Array(rawHat);

  // Cross-band bleed suppression over a +/-30ms window (handles FFT window phase skew between low & mid)
  for (let f = 0; f < frameCount; f++) {
    let maxKBody = 0;
    let maxSBody = 0;
    let maxK = 0;
    let maxS = 0;
    for (let d = -3; d <= 3; d++) {
      const idx = f + d;
      if (idx < 0 || idx >= frameCount) continue;
      if (kickBody[idx] > maxKBody) maxKBody = kickBody[idx];
      if (snareBody[idx] > maxSBody) maxSBody = snareBody[idx];
      if (rawKick[idx] > maxK) maxK = rawKick[idx];
      if (rawSnare[idx] > maxS) maxS = rawSnare[idx];
    }

    // Also inspect recent 140ms snare body to prevent decaying snare thump tails from triggering ghost kicks
    let recentSBody = maxSBody;
    for (let d = -14; d < -3; d++) {
      const idx = f + d;
      if (idx >= 0 && snareBody[idx] > recentSBody) {
        recentSBody = snareBody[idx];
      }
    }

    // Pure kick has huge sub/mid ratio (> 6.5x); suppress pre-kick transient click bleed into snare
    if (maxKBody > maxSBody * 6.5) {
      snare[f] *= 0.12;
    }
    // Strong clap/snare owns the transient when sub/mid ratio is clap-like (< 5.5x)
    if (maxSBody > snareRef * 0.30 && maxKBody < maxSBody * 5.5) {
      kick[f] *= 0.12;
    } else if (recentSBody > snareRef * 0.35 && kickBody[f] < recentSBody * 2.8) {
      kick[f] *= 0.35;
    }

    if (maxK > rawHat[f] * 3.0 || maxS > rawHat[f] * 2.5) {
      hat[f] *= 0.35;
    }
  }

  normalizeEnvelopeRobust(kick);
  normalizeEnvelopeRobust(snare);
  normalizeEnvelopeRobust(hat);

  onProgress?.(100);

  return { hopTime, duration, kick, snare, hat };
}

/**
 * Lazily builds a 4096-FFT (~10.8 Hz bin resolution) 128-log-band spectral cache
 * so arbitrary custom [minHz, maxHz] lanes recompute in < 3 ms.
 */
export function buildSpectralEnvelopeCache(
  mono: Float32Array,
  sampleRate: number
): SpectralEnvelopeCache {
  const fftSize = 4096;
  const halfFft = fftSize >> 1;
  const hopSize = Math.max(128, Math.round(sampleRate * 0.01));
  const hopTime = hopSize / sampleRate;
  const frameCount = Math.max(1, Math.floor(mono.length / hopSize));

  const numBands = 128;
  const minFreq = 20;
  const maxFreq = 16500;
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);

  const plan = createFFTPlan(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  const halfBins = (fftSize >> 1) + 1;
  const hzPerBin = sampleRate / fftSize;

  const bandB0 = new Int32Array(numBands);
  const bandB1 = new Int32Array(numBands);
  for (let k = 0; k < numBands; k++) {
    const f0 = Math.exp(logMin + (k / numBands) * (logMax - logMin));
    const f1 = Math.exp(logMin + ((k + 1) / numBands) * (logMax - logMin));
    const b0 = Math.max(1, Math.min(halfBins - 1, Math.floor(f0 / hzPerBin)));
    const b1 = Math.max(b0, Math.min(halfBins - 1, Math.ceil(f1 / hzPerBin)));
    bandB0[k] = b0;
    bandB1[k] = b1;
  }

  const prevLogMag = new Float32Array(halfBins);
  const binMag = new Float32Array(halfBins);
  const binFlux = new Float32Array(halfBins);
  const fluxGrid = new Float32Array(frameCount * numBands);
  const energyGrid = new Float32Array(frameCount * numBands);

  const logGamma = 3.0;

  for (let f = 0; f < frameCount; f++) {
    const startIdx = f * hopSize - halfFft;
    for (let i = 0; i < fftSize; i++) {
      const idx = startIdx + i;
      const sample = idx >= 0 && idx < mono.length ? mono[idx] : 0;
      real[i] = sample * plan.hann[i];
      imag[i] = 0;
    }

    fftInPlace(plan, real, imag, false);

    for (let b = 1; b < halfBins; b++) {
      const r = real[b];
      const im = imag[b];
      const mag = Math.sqrt(r * r + im * im);
      const lm = Math.log1p(logGamma * mag);
      binMag[b] = mag;
      binFlux[b] = Math.max(0, lm - prevLogMag[b]);
      prevLogMag[b] = lm;
    }

    const rowOffset = f * numBands;
    for (let k = 0; k < numBands; k++) {
      const b0 = bandB0[k];
      const b1 = bandB1[k];
      let sumFlux = 0;
      let sumEnergy = 0;
      for (let b = b0; b <= b1; b++) {
        sumFlux += binFlux[b];
        sumEnergy += binMag[b];
      }
      const cnt = b1 - b0 + 1;
      fluxGrid[rowOffset + k] = sumFlux / cnt;
      energyGrid[rowOffset + k] = sumEnergy / cnt;
    }
  }

  return {
    sampleRate,
    hopTime,
    frameCount,
    numBands,
    minFreq,
    maxFreq,
    fluxGrid,
    energyGrid,
  };
}

export function extractBandEnvelopeFromSpectralCache(
  cache: SpectralEnvelopeCache,
  minHz: number,
  maxHz: number
): Float32Array {
  const safeMin = Math.max(cache.minFreq, Math.min(cache.maxFreq - 5, minHz));
  const safeMax = Math.max(safeMin + 5, Math.min(cache.maxFreq, maxHz));

  const logMin = Math.log(cache.minFreq);
  const logMax = Math.log(cache.maxFreq);
  const span = logMax - logMin;

  const k0 = Math.max(
    0,
    Math.min(cache.numBands - 1, Math.floor(((Math.log(safeMin) - logMin) / span) * cache.numBands))
  );
  const k1 = Math.max(
    k0,
    Math.min(cache.numBands - 1, Math.ceil(((Math.log(safeMax) - logMin) / span) * cache.numBands) - 1)
  );

  const env = new Float32Array(cache.frameCount);
  const bandCount = Math.max(1, k1 - k0 + 1);

  for (let f = 0; f < cache.frameCount; f++) {
    const rowOffset = f * cache.numBands;
    let sumFlux = 0;
    let sumEnergy = 0;
    for (let k = k0; k <= k1; k++) {
      sumFlux += cache.fluxGrid[rowOffset + k];
      sumEnergy += cache.energyGrid[rowOffset + k];
    }
    const meanFlux = sumFlux / bandCount;
    const meanEnergy = sumEnergy / bandCount;
    env[f] = meanFlux * Math.sqrt(1 + meanEnergy);
  }

  normalizeEnvelopeRobust(env);
  return env;
}

function normalizeEnvelopeRobust(env: Float32Array): void {
  if (env.length === 0) return;
  const sampleStep = Math.max(1, Math.floor(env.length / 4000));
  const samples: number[] = [];
  for (let i = 0; i < env.length; i += sampleStep) {
    samples.push(env[i]);
  }
  samples.sort((a, b) => a - b);
  const p995 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.995))] || 1e-6;
  const scale = p995 > 1e-6 ? 1 / p995 : 1;

  for (let i = 0; i < env.length; i++) {
    env[i] = Math.min(1.0, env[i] * scale);
  }
}

function pickBandPeaks(
  env: Float32Array,
  hopTime: number,
  sensitivity: number,
  minIntervalSec: number,
  decayMaskSec = 0.22,
  isTimeAllowed?: (timeSec: number) => boolean
): { time: number; energy: number }[] {
  const results: { time: number; energy: number }[] = [];
  if (env.length < 3 || sensitivity <= 0.001) return results;

  // Higher sensitivity => lower threshold & delta; 0% removes all hits, 1-4% smoothly ramps above 0.52 up to 1.01
  const clampedSens = Math.max(0, Math.min(1, sensitivity));
  let delta: number;
  let absFloor: number;
  if (clampedSens < 0.05) {
    const t = 1 - clampedSens / 0.05;
    absFloor = 0.519 + t * (1.01 - 0.519);
    delta = 0.344 + t * (0.99 - 0.344);
  } else {
    delta = Math.max(0.02, 0.04 + (1 - clampedSens) * 0.32);
    absFloor = Math.max(0.06, 0.12 + (1 - clampedSens) * 0.42);
  }

  const localRadius = Math.max(4, Math.round(0.12 / hopTime)); // ~120ms local mean window
  let lastPeakTime = -10;
  let lastPeakEnergy = 0;

  for (let i = 1; i < env.length - 1; i++) {
    const val = env[i];
    if (val < absFloor) continue;
    if (val < env[i - 1] || val <= env[i + 1]) continue;

    const time = i * hopTime;
    if (isTimeAllowed && !isTimeAllowed(time)) continue;

    // Local mean around i
    const wStart = Math.max(0, i - localRadius);
    const wEnd = Math.min(env.length - 1, i + localRadius);
    let sum = 0;
    for (let j = wStart; j <= wEnd; j++) {
      sum += env[j];
    }
    const localMean = sum / (wEnd - wStart + 1);

    const dt = time - lastPeakTime;

    // Post-transient decay mask: suppress weak echo ripples within decayMaskSec unless >= 50% of prior peak
    if (dt >= minIntervalSec && dt < decayMaskSec && val < lastPeakEnergy * 0.50) {
      continue;
    }

    if (val >= localMean + delta) {
      if (dt >= minIntervalSec) {
        results.push({ time, energy: val });
        lastPeakTime = time;
        lastPeakEnergy = val;
      } else if (results.length > 0 && val > results[results.length - 1].energy) {
        // Replace weaker neighboring peak inside debounce window
        results[results.length - 1] = { time, energy: val };
        lastPeakTime = time;
        lastPeakEnergy = val;
      }
    }
  }

  return results;
}

export function ruleUsesDefaultRange(rule: DrumLaneRule): boolean {
  if (rule.id === 'kick') return rule.minHz === 35 && rule.maxHz === 140;
  if (rule.id === 'snare') return rule.minHz === 180 && rule.maxHz === 2500;
  if (rule.id === 'hat') return rule.minHz === 4500 && rule.maxHz === 16000;
  return false;
}

/**
 * Converts drum envelopes + lane rules into lane-mapped DrumEvents in < 5 ms.
 */
export function detectDrumEventsFromEnvelopes(
  envelopes: BandEnvelopes,
  rules: DrumLaneRule[],
  sync: SyncData,
  quantizeTo16th: boolean,
  spectralCache?: SpectralEnvelopeCache | null
): DrumEvent[] {
  const secondsPerBeat = 60.0 / (sync.bpm || 120);

  interface RawCandidate {
    time: number;
    energy: number;
    rule: DrumLaneRule;
    priority: number;
  }
  const raw: RawCandidate[] = [];

  for (let rIdx = 0; rIdx < rules.length; rIdx++) {
    const rule = rules[rIdx];
    if (!rule.enabled) continue;

    let env: Float32Array | null = null;
    let hopTime = envelopes.hopTime;

    if (rule.id === 'kick' && rule.minHz === 35 && rule.maxHz === 140) {
      env = envelopes.kick;
    } else if (rule.id === 'snare' && rule.minHz === 180 && rule.maxHz === 2500) {
      env = envelopes.snare;
    } else if (rule.id === 'hat' && rule.minHz === 4500 && rule.maxHz === 16000) {
      env = envelopes.hat;
    } else if (spectralCache) {
      env = extractBandEnvelopeFromSpectralCache(spectralCache, rule.minHz, rule.maxHz);
      hopTime = spectralCache.hopTime;
    } else {
      // Fallback to closest base envelope if spectral cache isn't built yet
      const mid = (rule.minHz + rule.maxHz) / 2;
      env = mid < 160 ? envelopes.kick : mid < 3200 ? envelopes.snare : envelopes.hat;
    }

    let limiterSubdiv: number | null = null;
    let gridLocked = false;
    if (typeof rule.limiter === 'number') {
      limiterSubdiv = rule.limiter;
    } else if (typeof rule.limiter === 'string' && rule.limiter.startsWith('on-')) {
      limiterSubdiv = Number(rule.limiter.slice(3)) || null;
      gridLocked = limiterSubdiv !== null;
    }

    let minInterval: number;
    let decayMaskSec = 0.22;
    const altLane = getEffectiveAltLane(rule);
    if (limiterSubdiv) {
      const subdivisionSec = secondsPerBeat * (4 / limiterSubdiv);
      minInterval = Math.max(0.045, subdivisionSec * 0.84);
      decayMaskSec = Math.min(0.22, subdivisionSec * 0.88);
    } else if (rule.limiter === null) {
      minInterval = 0.055;
      decayMaskSec = 0.12;
    } else {
      minInterval = altLane !== null
        ? Math.max(0.065, secondsPerBeat * 0.21)
        : 0.095;
    }

    let isTimeAllowed: ((timeSec: number) => boolean) | undefined;
    if (gridLocked && limiterSubdiv && sync.bpm > 0) {
      const gridPerBeat = limiterSubdiv / 4; // 1 for 1/4, 2 for 1/8, 4 for 1/16
      const stepBeats = 4 / limiterSubdiv;
      const toleranceBeats = Math.min(0.18, stepBeats * 0.22); // 0.11 beats for On 1/8 (rejects odd 16ths at 0.25)
      isTimeAllowed = (timeSec: number) => {
        const beatFloat = (timeSec - sync.offset) / secondsPerBeat;
        const nearestGridBeat = Math.round(beatFloat * gridPerBeat) / gridPerBeat;
        return Math.abs(beatFloat - nearestGridBeat) <= toleranceBeats;
      };
    }

    const peaks = pickBandPeaks(
      env,
      hopTime,
      rule.sensitivity,
      minInterval,
      decayMaskSec,
      isTimeAllowed
    );
    for (const p of peaks) {
      raw.push({ ...p, rule, priority: rIdx });
    }
  }

  const deduped = new Map<
    string,
    { time: number; beat?: number; sixteenthIdx: number; rule: DrumLaneRule; energy: number; priority: number }
  >();

  for (const item of raw) {
    let time = item.time;
    let beat: number | undefined;
    let sixteenthIdx = 0;

    if (sync.bpm > 0) {
      const beatFloat = (item.time - sync.offset) / secondsPerBeat;
      sixteenthIdx = Math.round(beatFloat * 4);
      if (quantizeTo16th) {
        const nearest16th = sixteenthIdx / 4;
        time = Math.max(0, sync.offset + nearest16th * secondsPerBeat);
        beat = Number(nearest16th.toFixed(3));
      } else {
        beat = Number(beatFloat.toFixed(3));
      }
    }

    const altLane = getEffectiveAltLane(item.rule);
    const key = altLane !== null
      ? `${item.rule.id}:16th:${sixteenthIdx}`
      : `${item.rule.id}:${time.toFixed(3)}`;

    const existing = deduped.get(key);
    if (!existing || item.energy > existing.energy) {
      deduped.set(key, {
        time,
        beat,
        sixteenthIdx,
        rule: item.rule,
        energy: item.energy,
        priority: item.priority,
      });
    }
  }

  const sorted = Array.from(deduped.values()).sort((a, b) => {
    const dt = a.time - b.time;
    if (Math.abs(dt) > 0.005) return dt;
    return a.priority - b.priority;
  });

  return sorted.map((ev) => {
    const altLane = getEffectiveAltLane(ev.rule);
    const isEven = Math.abs(ev.sixteenthIdx) % 2 === 0;
    const lane: LaneIndex =
      altLane !== null ? (isEven ? ev.rule.lane : altLane) : ev.rule.lane;

    return {
      time: ev.time,
      beat: ev.beat,
      band: ev.rule.id,
      color: ev.rule.color,
      badge: ev.rule.badge,
      energy: ev.energy,
      lane,
      source: 'drum',
    };
  });
}

export function applyManualEditsToEvents(
  baseEvents: DrumEvent[],
  manualEdits: ManualNoteEdits,
  sync: SyncData,
  laneRules: DrumLaneRule[]
): DrumEvent[] {
  const { suppressions, additions } = manualEdits;
  if (suppressions.length === 0 && additions.length === 0) {
    return baseEvents;
  }

  const secondsPerBeat = sync.bpm > 0 ? 60.0 / sync.bpm : 0.5;
  const ruleById = new Map(laneRules.map((r) => [r.id, r]));

  const filtered = baseEvents.filter((ev) => {
    const evBeat = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
    for (let i = 0; i < suppressions.length; i++) {
      const sup = suppressions[i];
      if (sup.band !== ev.band) continue;
      if (Math.abs(ev.time - sup.time) <= 0.045) return false;
      if (sup.beat !== undefined && Math.abs(evBeat - sup.beat) <= 0.09) return false;
    }
    return true;
  });

  const merged = [...filtered];
  for (let i = 0; i < additions.length; i++) {
    const add = additions[i];
    const time =
      add.beat !== undefined && sync.bpm > 0
        ? Math.max(0, sync.offset + add.beat * secondsPerBeat)
        : add.time;
    const beat =
      add.beat !== undefined ? add.beat : Number(((time - sync.offset) / secondsPerBeat).toFixed(3));
    const rule = ruleById.get(add.band);

    const alreadyPresent = merged.some(
      (ev) => ev.band === add.band && ev.lane === add.lane && Math.abs(ev.time - time) <= 0.015
    );
    if (alreadyPresent) continue;

    merged.push({
      time,
      beat,
      band: add.band,
      lane: add.lane,
      color: rule?.color ?? add.color,
      badge: rule?.badge ?? add.badge,
      energy: 1.0,
      source: 'drum',
    });
  }

  return merged.sort((a, b) => a.time - b.time);
}

export const DEFAULT_DIFFICULTY_MATRIX: DifficultyDensityMatrix = {
  Sparse: {
    easy: { subdivision: 2, maxChords: 1 },
    normal: { subdivision: 4, maxChords: 1 },
    hard: { subdivision: 'all', maxChords: null },
  },
  Medium: {
    easy: { subdivision: 4, maxChords: 1 },
    normal: { subdivision: 8, maxChords: 1 },
    hard: { subdivision: 'all', maxChords: null },
  },
  Dense: {
    easy: { subdivision: 8, maxChords: 1 },
    normal: { subdivision: 8, maxChords: 2 },
    hard: { subdivision: 'all', maxChords: null },
  },
};

export function simplifyEventsBySubdivisionCap(
  events: DrumEvent[],
  sync: SyncData,
  cap: DensitySubdivisionCap
): DrumEvent[] {
  if (cap === 0 || events.length === 0) return [];
  if (cap === 'all') return events;

  const secondsPerBeat = sync.bpm > 0 ? 60.0 / sync.bpm : 0.5;
  const gridPerBeat = cap / 4; // 1/1 -> 0.25, 1/2 -> 0.5, 1/4 -> 1, 1/8 -> 2, 1/16 -> 4
  const stepBeats = 4 / cap;
  const tolBeats = cap === 16 ? 0.125 : Math.min(0.22, stepBeats * 0.24);

  const keptBySlot = new Map<string, DrumEvent>();
  for (const ev of events) {
    const beatFloat = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
    const snapped = Math.round(beatFloat * gridPerBeat) / gridPerBeat;
    if (Math.abs(beatFloat - snapped) > tolBeats) continue;

    const slotKey = `${ev.band}:${snapped.toFixed(3)}`;
    const existing = keptBySlot.get(slotKey);
    if (!existing || ev.energy > existing.energy) {
      keptBySlot.set(slotKey, ev);
    }
  }

  return Array.from(keptBySlot.values()).sort((a, b) => a.time - b.time);
}

export function simplifyEventsByDifficultyRule(
  events: DrumEvent[],
  sync: SyncData,
  rule: DifficultyCellRule,
  bandPriorityOrder: string[]
): DrumEvent[] {
  const subFiltered = simplifyEventsBySubdivisionCap(events, sync, rule.subdivision);
  if (subFiltered.length === 0 || rule.maxChords === null) {
    return subFiltered;
  }

  const secondsPerBeat = sync.bpm > 0 ? 60.0 / sync.bpm : 0.5;
  const slotSubdiv = rule.subdivision === 'all' ? 16 : rule.subdivision;
  const slotGridPerBeat = slotSubdiv / 4;

  const slotBuckets = new Map<string, DrumEvent[]>();
  for (const ev of subFiltered) {
    const beatFloat = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
    const slotBeat = Math.round(beatFloat * slotGridPerBeat) / slotGridPerBeat;
    const key = slotBeat.toFixed(3);
    const list = slotBuckets.get(key);
    if (list) list.push(ev);
    else slotBuckets.set(key, [ev]);
  }

  const getPriority = (band: string) => {
    const idx = bandPriorityOrder.indexOf(band);
    return idx === -1 ? 999 : idx;
  };

  const result: DrumEvent[] = [];
  for (const bucket of slotBuckets.values()) {
    bucket.sort((a, b) => {
      const pDiff = getPriority(a.band) - getPriority(b.band);
      if (pDiff !== 0) return pDiff;
      return b.energy - a.energy;
    });

    const usedLanes = new Set<number>();
    let picked = 0;
    for (const ev of bucket) {
      if (usedLanes.has(ev.lane)) continue;
      usedLanes.add(ev.lane);
      result.push(ev);
      picked++;
      if (picked >= rule.maxChords) break;
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

export interface SectionDifficultyMetric {
  count: number;
  avg: number;
}

export function generateDifficultyChart(
  sections: Section[],
  events: DrumEvent[],
  sync: SyncData,
  matrix: DifficultyDensityMatrix,
  difficulty: ChartDifficulty,
  bandPriorityOrder: string[]
): DrumEvent[] {
  if (events.length === 0) return [];
  if (sections.length === 0) {
    return simplifyEventsByDifficultyRule(
      events,
      sync,
      matrix.Medium[difficulty],
      bandPriorityOrder
    );
  }

  const secondsPerBeat = sync.bpm > 0 ? 60.0 / sync.bpm : 0.5;
  const sorted = [...sections].sort((a, b) => a.beat - b.beat);
  const boundaryPad = 0.125;
  const out: DrumEvent[] = [];

  // Any pre-first-section events inherit the first section's density
  const firstStartBeat = sorted[0].beat - boundaryPad;
  const preEvents = events.filter((ev) => {
    const b = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
    return b < firstStartBeat;
  });
  if (preEvents.length > 0) {
    out.push(
      ...simplifyEventsByDifficultyRule(
        preEvents,
        sync,
        matrix[sorted[0].density][difficulty],
        bandPriorityOrder
      )
    );
  }

  for (let i = 0; i < sorted.length; i++) {
    const sec = sorted[i];
    const startBeat = sec.beat - boundaryPad;
    const endBeat = i + 1 < sorted.length ? sorted[i + 1].beat - boundaryPad : Infinity;
    const secEvents = events.filter((ev) => {
      const b = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
      return b >= startBeat && b < endBeat;
    });
    if (secEvents.length > 0) {
      out.push(
        ...simplifyEventsByDifficultyRule(
          secEvents,
          sync,
          matrix[sec.density][difficulty],
          bandPriorityOrder
        )
      );
    }
  }

  return out.sort((a, b) => a.time - b.time);
}

export function computeSectionDifficultyCounts(
  sections: Section[],
  events: DrumEvent[],
  sync: SyncData,
  matrix: DifficultyDensityMatrix,
  laneFilter: string, // 'all' | 'lane:0..3' | 'band:<id>'
  bandPriorityOrder: string[],
  trackDurationSec = 0
): {
  bySectionId: Record<string, Record<ChartDifficulty, SectionDifficultyMetric> & { beats: number }>;
  totals: Record<ChartDifficulty, SectionDifficultyMetric> & { beats: number };
} {
  const bySectionId: Record<
    string,
    Record<ChartDifficulty, SectionDifficultyMetric> & { beats: number }
  > = {};
  const totals: Record<ChartDifficulty, SectionDifficultyMetric> & { beats: number } = {
    easy: { count: 0, avg: 0 },
    normal: { count: 0, avg: 0 },
    hard: { count: 0, avg: 0 },
    beats: 0,
  };

  if (sections.length === 0) {
    return { bySectionId, totals };
  }

  const matchesLaneFilter = (ev: DrumEvent): boolean => {
    if (laneFilter.startsWith('lane:')) {
      return ev.lane === Number(laneFilter.slice(5));
    }
    if (laneFilter.startsWith('band:')) {
      return ev.band === laneFilter.slice(5);
    }
    return true;
  };

  const secondsPerBeat = sync.bpm > 0 ? 60.0 / sync.bpm : 0.5;
  const sorted = [...sections].sort((a, b) => a.beat - b.beat);
  const boundaryPad = 0.125; // Keep transients landing right on/before barline in the new section

  const lastStartBeat = sorted[sorted.length - 1].beat;
  const trackTotalBeats =
    trackDurationSec > sync.offset && secondsPerBeat > 0
      ? (trackDurationSec - sync.offset) / secondsPerBeat
      : lastStartBeat + 16;

  for (let i = 0; i < sorted.length; i++) {
    const sec = sorted[i];
    const startBeat = sec.beat - boundaryPad;
    const nextBeat = i + 1 < sorted.length ? sorted[i + 1].beat : Math.max(sec.beat, trackTotalBeats);
    const endBeat = i + 1 < sorted.length ? sorted[i + 1].beat - boundaryPad : Infinity;
    const sectionBeats = Math.max(0, nextBeat - sec.beat);

    // Filter section events BEFORE chord reduction so Lane Manager priority resolves cross-instrument occlusion
    const secEvents = events.filter((ev) => {
      const b = ev.beat ?? (ev.time - sync.offset) / secondsPerBeat;
      return b >= startBeat && b < endBeat;
    });

    const cellRules = matrix[sec.density];
    const countFor = (diff: ChartDifficulty) => {
      const simplified = simplifyEventsByDifficultyRule(
        secEvents,
        sync,
        cellRules[diff],
        bandPriorityOrder
      );
      const count = simplified.filter(matchesLaneFilter).length;
      const avg = sectionBeats > 0 ? count / sectionBeats : 0;
      return { count, avg };
    };

    const easy = countFor('easy');
    const normal = countFor('normal');
    const hard = countFor('hard');

    bySectionId[sec.id] = { easy, normal, hard, beats: sectionBeats };
    totals.easy.count += easy.count;
    totals.normal.count += normal.count;
    totals.hard.count += hard.count;
    totals.beats += sectionBeats;
  }

  if (totals.beats > 0) {
    totals.easy.avg = totals.easy.count / totals.beats;
    totals.normal.avg = totals.normal.count / totals.beats;
    totals.hard.avg = totals.hard.count / totals.beats;
  }

  return { bySectionId, totals };
}
