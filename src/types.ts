export type DrumBand = string; // 'kick' | 'snare' | 'hat' | custom lane rule id

export type LaneColor = 'amber' | 'emerald' | 'sky' | 'pink' | 'violet';

export type LaneIndex = 0 | 1 | 2 | 3; // 0: Left (D), 1: Down (F), 2: Up (J), 3: Right (K)

export interface DrumEvent {
  time: number;
  beat?: number;
  band: DrumBand;
  color?: LaneColor;
  badge?: string;
  energy: number;
  lane: LaneIndex;
  source: 'drum' | 'user';
}

export type StemEngineMode = 'dsp-hpss' | 'webgpu-demucs';

export type StemStatus = 'idle' | 'loading-model' | 'processing' | 'ready' | 'error';

export type NoteSubdivisionLimiter =
  | 4
  | 8
  | 16
  | 32
  | 'on-4'
  | 'on-8'
  | 'on-16'
  | null;

export type LaneDistributeMode = 'fixed' | 'dk-alt' | 'fj-alt';

export interface DrumLaneRule {
  id: string;
  name: string;
  enabled: boolean;
  minHz: number;
  maxHz: number;
  sensitivity: number; // 0.00 to 1.00 (higher = more hits detected)
  lane: LaneIndex;
  altLane?: LaneIndex | null; // Optional alternating lane on odd subdivisions (null = Fixed / no alt key)
  distributeEvenOdd: boolean; // Legacy boolean kept compatible with altLane
  distributeMode?: LaneDistributeMode; // Legacy distribute mode kept compatible with altLane
  limiter?: NoteSubdivisionLimiter; // Ignores consecutive shadow repeats faster than 1/N note (null = off)
  color: LaneColor;
  badge: string;
  isDefault?: boolean;
}

export interface ManualNoteSuppression {
  id: string;
  time: number;
  beat?: number;
  band: DrumBand;
  lane: LaneIndex;
}

export interface ManualNoteAddition {
  id: string;
  time: number;
  beat?: number;
  band: DrumBand;
  lane: LaneIndex;
  color: LaneColor;
  badge: string;
}

export interface ManualNoteEdits {
  suppressions: ManualNoteSuppression[];
  additions: ManualNoteAddition[];
}

export type JudgementTier = 'marvelous' | 'perfect' | 'great' | 'good' | 'boo' | 'miss';

export interface BandEnvelopes {
  hopTime: number;
  duration: number;
  kick: Float32Array;
  snare: Float32Array;
  hat: Float32Array;
}

export interface SpectralEnvelopeCache {
  sampleRate: number;
  hopTime: number;
  frameCount: number;
  numBands: number;
  minFreq: number;
  maxFreq: number;
  fluxGrid: Float32Array;
  energyGrid: Float32Array;
}

export interface SeparationDiagnostics {
  backendUsed: string;
  peakAmplitude: number;
  nanSamplesReplaced: number;
  chunksProcessed: number;
  note?: string;
}

export interface AudioMetadata {
  fileName: string;
  sampleRate: number;
  duration: number;
  onsets?: number[];
  drumEvents?: DrumEvent[];
}

export interface SyncData {
  bpm: number;
  offset: number;
  metronomeActive: boolean;
  volume: number;
}

export type ChartDifficulty = 'easy' | 'normal' | 'hard';

export type DensitySubdivisionCap = 0 | 1 | 2 | 4 | 8 | 16 | 'all';

export type MaxChordsCap = 1 | 2 | 3 | null; // 1 = Single (no chords), 2 = Jump, 3 = Hand, null = All

export type SectionDensity = 'Sparse' | 'Medium' | 'Dense';

export interface DifficultyCellRule {
  subdivision: DensitySubdivisionCap;
  maxChords: MaxChordsCap;
}

export type DifficultyDensityMatrix = Record<
  SectionDensity,
  Record<ChartDifficulty, DifficultyCellRule>
>;

export type WindshieldPreset = 'glsl-space' | 'wormhole' | 'music-rain' | 'milkdrop';

export interface Section {
  id: string;
  beat: number;
  label: string;
  density: SectionDensity;
  preset?: WindshieldPreset;
}

export type SimSoundMode = 'demo' | 'sync' | 'input';

export interface StepSyncProject {
  version: 1;
  exportedAt: string;
  audioMeta: {
    fileName: string;
    sampleRate: number;
    duration: number;
  } | null;
  sync: SyncData;
  sections: Section[];
  difficultyMatrix: DifficultyDensityMatrix;
  laneRules: DrumLaneRule[];
  quantizeDrums: boolean;
  delayCompensation: number;
  auditionMode: 'mix' | 'drums' | 'blend';
  blendRatio: number;
  simulatorDifficulty: ChartDifficulty;
  simSoundMode?: SimSoundMode;
  simSoundEnabled: { kick: boolean; snare: boolean; hat: boolean; tom?: boolean };
  simVolume: number;
  manualEdits: ManualNoteEdits;
  drumEvents?: DrumEvent[];
}

export interface AppState {
  audio: AudioMetadata | null;
  sync: SyncData;
  sections: Section[];
}
