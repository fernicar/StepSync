import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Maximize2, Minimize2 } from 'lucide-react';
import { ChartDifficulty, DrumEvent, JudgementTier, Section, SimSoundMode, SyncData } from '../types';
import { engine, SimDrumBand } from '../lib/AudioEngine';
import { cn } from '../lib/utils';
import { triggerBlobDownload } from '../lib/projectCache';
import {
  BodyLanguageTarget,
  evaluateRhythmBodyLanguage,
  getPersonaForDifficulty,
  InputPercussionTrigger,
  stepWheelMotionState,
  WheelMotionState,
  WindshieldPreset,
} from '../lib/rhythmBodyLanguage';

export interface ScreensaverWebmExportState {
  status: 'idle' | 'armed' | 'recording' | 'finalizing';
  elapsedSec: number;
  durationSec: number;
  error: string | null;
  lastFileName: string | null;
}

export interface ScreensaverExportHandle {
  startDemoWebmExport: (options?: { width?: number; height?: number }) => Promise<void>;
  stopAndSaveDemoWebmExport: () => void;
  cancelDemoWebmExport: () => void;
}

interface JudgementHudSnapshot {
  tier: JudgementTier;
  offsetMs: number | null;
  combo: number;
  atMs: number;
}

export interface ScreensaverScoreSummary {
  counts: Record<JudgementTier, number>;
  combo: number;
  maxCombo: number;
  accuracy: number;
  lastTier: JudgementTier | null;
  lastOffsetMs: number | null;
}

interface Props {
  sync: SyncData;
  sections: Section[];
  isPlaying: boolean;
  songDurationSec: number;
  drumEvents: DrumEvent[];
  tomBandIds: string[];
  difficulty: ChartDifficulty;
  pinkPantherPct?: number;
  percussionPct?: number;
  snareCounterKick?: boolean;
  simpleBarOrientation?: boolean;
  simSoundMode?: SimSoundMode;
  simSoundEnabled?: Record<SimDrumBand, boolean>;
  pressedLanesRef?: React.RefObject<[boolean, boolean, boolean, boolean]>;
  judgedNotesRef?: React.RefObject<Map<number, JudgementTier | 'skipped'>>;
  lastJudgementHudRef?: React.RefObject<JudgementHudSnapshot | null>;
  playerInputTriggersRef?: React.RefObject<InputPercussionTrigger[]>;
  playScore?: ScreensaverScoreSummary;
  playScoreRef?: React.RefObject<ScreensaverScoreSummary>;
  onPlaybackTick?: (currentTime: number) => void;
  fileName?: string;
  onChangeSimSoundMode?: (mode: SimSoundMode) => void;
  onBeforeDemoExportStart?: () => void;
  exportHandleRef?: React.MutableRefObject<ScreensaverExportHandle | null>;
  onWebmExportStateChange?: (state: ScreensaverWebmExportState) => void;
  exportWidth?: number;
  exportHeight?: number;
}

function normalizeExportDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  const clamped = Math.max(min, Math.min(max, raw));
  const even = clamped - (clamped % 2);
  return Math.max(min, even);
}

interface DashScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getCockpitScreenLayout(w: number, h: number): {
  isPortrait: boolean;
  left: DashScreenRect;
  right: DashScreenRect;
} {
  const isPortrait = h > w * 1.05;
  if (isPortrait) {
    // Vertical 9:16 cockpit: twin widescreen console bays side-by-side below the U-yoke
    return {
      isPortrait: true,
      left: { x: w * 0.032, y: h * 0.858, w: w * 0.454, h: h * 0.118 },
      right: { x: w * 0.514, y: h * 0.858, w: w * 0.454, h: h * 0.118 },
    };
  }
  return {
    isPortrait: false,
    left: { x: w * 0.032, y: h * 0.725, w: w * 0.28, h: h * 0.237 },
    right: { x: w * 0.688, y: h * 0.725, w: w * 0.28, h: h * 0.237 },
  };
}

const PRESETS: readonly { id: WindshieldPreset; keyNum: string; label: string }[] = [
  { id: 'glsl-space', keyNum: '1', label: 'GLSL Space' },
  { id: 'wormhole', keyNum: '2', label: 'Wormhole' },
  { id: 'music-rain', keyNum: '3', label: 'Music Rain' },
  { id: 'milkdrop', keyNum: '4', label: 'MilkDrop' },
];

const PERSONA_META: Record<
  ChartDifficulty,
  { name: string; diffLabel: string; textClass: string; accentHex: string }
> = {
  easy: { name: 'Dancer', diffLabel: 'Easy', textClass: 'text-sky-300', accentHex: '#38bdf8' },
  normal: { name: 'Performer', diffLabel: 'Normal', textClass: 'text-amber-300', accentHex: '#f59e0b' },
  hard: { name: 'Drummer', diffLabel: 'Hard', textClass: 'text-emerald-300', accentHex: '#34d399' },
};

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform float uBeatFloat;
uniform float uBeatPhase;
uniform float uBarPhase;
uniform float uPhrasePhase;
uniform float uKick;
uniform float uSnare;
uniform float uTom;
uniform float uHat;
uniform float uHatDir;
uniform float uEnergy;
uniform float uPersonaScale;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
`;

const GLSL_SPACE_FRAG =
  FRAGMENT_HEADER +
  `
void main() {
  vec2 uv = (vUv * uRes - 0.5 * uRes) / min(uRes.x, uRes.y);
  float horizonY = 0.05;
  vec3 col = vec3(0.015, 0.02, 0.045);

  float pulse = 0.5 + 0.5 * cos(uBeatPhase * 6.2831853);
  float forwardSpeed = uTime * (1.2 + 0.55 * uPersonaScale) + uBeatFloat * 0.32 + uKick * 0.12;

  if (uv.y < horizonY) {
    // Deep twilight night floor behind foreground dot-matrix spectrum terrain (no square grid)
    float depth = max(0.0, horizonY - uv.y);
    float haze = exp(-depth * 14.0);
    vec3 valleyCol = vec3(0.008, 0.011, 0.022);
    vec3 horizonRimCol = mix(vec3(0.06, 0.16, 0.28), vec3(0.18, 0.11, 0.24), 0.5 + 0.5 * sin(uPhrasePhase * 6.28318));
    col = mix(valleyCol, horizonRimCol, haze * (0.45 + 0.35 * uSnare + 0.25 * uKick));
  } else {
    // Late-night cosmos, subtle mountain ridge & fractal nebula sky
    float skyY = uv.y - horizonY;
    vec3 zenith = mix(vec3(0.01, 0.015, 0.04), vec3(0.05, 0.02, 0.11), 0.5 + 0.5 * sin(uBarPhase * 6.28318));
    col = mix(vec3(0.06, 0.14, 0.24) * (0.6 + 0.6 * uSnare), zenith, clamp(skyY * 2.1, 0.0, 1.0));

    // Distant twilight sun / moon disc synced to bar phase & kick breath
    vec2 sunPos = vec2(0.0, 0.18 + 0.015 * sin(uBeatFloat * 0.5));
    float sunDist = length(uv - sunPos);
    float sunR = 0.20 + uKick * 0.028 * uPersonaScale;
    float sunMask = smoothstep(sunR + 0.012, sunR - 0.006, sunDist);
    float scanlines = smoothstep(-0.2, 0.5, sin(uv.y * 130.0 - uTime * 2.5));
    vec3 sunCol = mix(vec3(0.95, 0.38, 0.58), vec3(0.98, 0.72, 0.22), clamp((uv.y - horizonY) * 2.8, 0.0, 1.0));
    col = mix(col, sunCol * (0.65 + 0.35 * scanlines), sunMask * 0.85);
    col += sunCol * exp(-sunDist * 7.0) * (0.28 + 0.35 * uKick);

    // Subtle procedural aurora / fractal ribbons in upper sky
    vec2 nUv = vec2(uv.x * 1.4, skyY * 2.4 - uTime * 0.08);
    nUv *= rot2(0.12 * sin(uTime * 0.15 + uTom * 0.4));
    float wave = sin(nUv.x * 5.0 + sin(nUv.y * 4.0 + uTime * 0.6)) * cos(nUv.y * 6.0 - uBeatFloat * 0.35);
    vec3 aurora = mix(vec3(0.04, 0.82, 0.68), vec3(0.65, 0.25, 0.92), 0.5 + 0.5 * wave);
    col += aurora * smoothstep(0.35, 0.98, abs(wave)) * smoothstep(0.05, 0.45, skyY) * (0.18 + 0.28 * uTom + 0.16 * uHat);

    // Sharp drifting starfield (hi-hat triggers gentle shimmer)
    vec2 starUv = uv * 28.0 + vec2(0.0, uTime * 0.25);
    vec2 sid = floor(starUv);
    vec2 sf = fract(starUv) - 0.5;
    float rnd = hash21(sid);
    if (rnd > 0.92) {
      float twinkle = 0.45 + 0.55 * sin(uTime * 4.5 + rnd * 60.0 + uHat * 4.0 * uHatDir);
      float sGlow = smoothstep(0.18, 0.02, length(sf)) * twinkle;
      col += mix(vec3(0.75, 0.92, 1.0), vec3(0.35, 0.85, 0.95), fract(rnd * 17.0)) * sGlow * (0.8 + 0.8 * uHat);
    }

    // Obsidian mountain silhouette framing horizon line
    float mHeight = 0.028
      + 0.028 * abs(sin(uv.x * 3.1 + 0.8))
      + 0.015 * sin(uv.x * 9.5 + 2.1)
      + 0.008 * cos(uv.x * 19.0);
    if (skyY < mHeight) {
      col *= 0.18;
      col += vec3(0.02, 0.04, 0.08) * (1.0 + uSnare);
    }
  }

  // Horizon atmospheric glow line
  float hGlow = exp(-abs(uv.y - horizonY) * 55.0);
  col += mix(vec3(0.18, 0.85, 0.95), vec3(0.98, 0.65, 0.22), uKick) * hGlow * (0.55 + 0.75 * uSnare + 0.45 * uKick);

  // Subtle vignette preserving cockpit immersion
  float vig = smoothstep(1.35, 0.35, length(vUv - 0.5));
  col *= 0.72 + 0.28 * vig;

  fragColor = vec4(col, 1.0);
}
`;

const WORMHOLE_FRAG =
  FRAGMENT_HEADER +
  `
void main() {
  vec2 uv = (vUv * uRes - 0.5 * uRes) / min(uRes.x, uRes.y);
  // Fixed optical horizon slightly above center console so tunnel streams ahead above wheel
  vec2 center = vec2(0.0, 0.10);
  vec2 p = uv - center;

  float r = max(0.02, length(p));
  float a = atan(p.y, p.x);

  float depthSpeed = uTime * (1.1 + 0.45 * uPersonaScale) + uBeatFloat * 0.38 + uKick * 0.16;
  float invR = 0.65 / r + depthSpeed;

  // Smooth organic plasma aurora tunnel walls (zero square wireframe grids)
  float twist = a + 0.28 * sin(invR * 0.45 - uTime * 0.35) + 0.18 * uTom * sin(uBeatFloat * 3.14159);
  float streamA = 0.5 + 0.5 * sin(twist * 3.0 + invR * 1.4 - uTime * 0.8);
  float streamB = 0.5 + 0.5 * cos(twist * 5.0 - invR * 0.9 + uPhrasePhase * 6.28318);
  float aurora = pow(streamA * streamB, 1.35);

  vec3 cCyan = vec3(0.04, 0.72, 0.88);
  vec3 cIndigo = vec3(0.14, 0.08, 0.36);
  vec3 cAmber = vec3(0.92, 0.52, 0.14);
  vec3 cPink = vec3(0.84, 0.24, 0.62);

  vec3 wallCol = mix(cIndigo, cCyan, streamA * 0.75);
  wallCol = mix(wallCol, cPink, aurora * 0.65 + 0.22 * uTom);
  wallCol = mix(wallCol, cAmber, uKick * 0.38 * aurora);

  float centerCore = exp(-r * 6.8);
  float tunnelMask = smoothstep(0.02, 0.48, r);

  vec3 col = vec3(0.008, 0.011, 0.022);
  col += wallCol * (0.28 + 0.45 * uEnergy) * aurora * tunnelMask;
  col += mix(cCyan, vec3(0.85, 0.96, 1.0), 0.45 + 0.5 * uSnare) * centerCore * (0.48 + 0.52 * uKick + 0.3 * uHat);

  // Faint radial hi-hat warp wisps in outer periphery
  float streak = smoothstep(0.95, 0.998, sin(a * 18.0 + invR * 8.0)) * uHat * tunnelMask;
  col += vec3(0.55, 0.92, 1.0) * streak * 0.45;

  fragColor = vec4(col, 1.0);
}
`;

const MILKDROP_FRAG =
  FRAGMENT_HEADER +
  `
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float galaxyFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 m = rot2(0.62);
  for (int i = 0; i < 4; i++) {
    v += amp * valueNoise(p);
    p = m * p * 2.05 + vec2(11.3, 7.1);
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (vUv * uRes - 0.5 * uRes) / min(uRes.x, uRes.y);
  vec2 p = uv - vec2(0.0, 0.06);

  float r = length(p);
  float a = atan(p.y, p.x);

  // Subtle cosmic galaxy disk rotation driven by rhythm & time
  float spin = uTime * 0.09 + uBarPhase * 0.25;
  float logR = log(max(r, 0.015));

  // Two-arm & four-arm logarithmic spiral structure + soft interstellar dust clouds
  float armAngle = a - logR * 2.6 + spin;
  float mainArms = 0.5 + 0.5 * cos(armAngle * 2.0);
  float minorArms = 0.5 + 0.5 * cos(armAngle * 4.0 + 0.9);
  float spiralBand = pow(mainArms, 2.2) * 0.72 + pow(minorArms, 3.0) * 0.28;

  // Soft gaseous nebula & dark cosmic dust lanes in warped polar coordinates
  vec2 cloudUv = p * rot2(spin * 0.55 - logR * 0.85) * 3.4;
  float dust = galaxyFbm(cloudUv + vec2(uTime * 0.03, -uTime * 0.02));
  float nebula = galaxyFbm(cloudUv * 1.65 - vec2(uTime * 0.04, uTom * 0.25));

  float diskMask = exp(-r * (1.85 - 0.25 * uKick));
  float coreGlow = exp(-r * 6.5) * (0.55 + 0.45 * uKick + 0.25 * uSnare);
  float armDensity = spiralBand * diskMask * smoothstep(0.22, 0.92, dust + 0.28);

  vec3 deepSpace = vec3(0.006, 0.008, 0.018);
  vec3 outerVoid = vec3(0.025, 0.022, 0.075);
  vec3 armCyan = vec3(0.08, 0.62, 0.92);
  vec3 nebulaViolet = vec3(0.58, 0.24, 0.86);
  vec3 coreGold = vec3(0.98, 0.76, 0.36);

  vec3 col = mix(deepSpace, outerVoid, exp(-r * 1.4));
  vec3 armColor = mix(nebulaViolet, armCyan, smoothstep(0.25, 0.85, nebula));
  armColor = mix(armColor, coreGold, exp(-r * 3.6) * 0.65);

  col += armColor * armDensity * (0.55 + 0.42 * uEnergy);
  col += nebulaViolet * nebula * diskMask * 0.16 * (1.0 + uTom * 0.5);
  col += mix(coreGold, vec3(0.85, 0.96, 1.0), 0.35 + 0.35 * uSnare) * coreGlow * 0.45;

  // Crisp multi-layer deep-space starfield (twinkles subtly with hi-hat texture)
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer + 1);
    float scale = 26.0 * fl;
    vec2 starCoord = (p * rot2(spin * (0.18 / fl))) * scale;
    vec2 sid = floor(starCoord);
    vec2 sf = fract(starCoord) - 0.5;
    float rnd = hash21(sid + fl * 37.0);
    if (rnd > (layer == 0 ? 0.91 : 0.945)) {
      vec2 jitter = (vec2(hash21(sid + 1.7), hash21(sid + 9.3)) - 0.5) * 0.55;
      float d = length(sf - jitter);
      float twinkle = 0.55 + 0.45 * sin(uTime * (2.5 + fl) + rnd * 50.0 + uHat * 3.5 * uHatDir);
      float star = exp(-d * (layer == 0 ? 11.0 : 14.0)) * twinkle;
      vec3 starTint = mix(vec3(0.68, 0.86, 1.0), vec3(1.0, 0.84, 0.64), fract(rnd * 23.0));
      col += starTint * star * (0.48 + 0.42 * uHat) / fl;
    }
  }

  float vig = smoothstep(1.35, 0.25, r);
  col *= 0.72 + 0.28 * vig;

  fragColor = vec4(col, 1.0);
}
`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Windshield GLSL compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  fragSrc: string
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('Windshield GLSL link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

interface RainParticle {
  x: number;
  y: number;
  z: number;
  prevZ: number;
  hueSeed: number;
  size: number;
}

function createRainParticles(count: number): RainParticle[] {
  const out: RainParticle[] = [];
  for (let i = 0; i < count; i++) {
    const z = 0.08 + Math.random() * 0.92;
    out.push({
      x: (Math.random() - 0.5) * 2.4,
      y: (Math.random() - 0.5) * 1.8,
      z,
      prevZ: z,
      hueSeed: Math.random(),
      size: 0.7 + Math.random() * 1.6,
    });
  }
  return out;
}

const SPEC_MIN_FREQ = 30;
const SPEC_MAX_FREQ = 16000;
const SPEC_LOG_MIN = Math.log(SPEC_MIN_FREQ);
const SPEC_LOG_MAX = Math.log(SPEC_MAX_FREQ);
const SPEC_HALF_COLS = 48; // Halved count mirrored -> [Mountain, Road | Mirrored Road, Mirrored Mountain]
const SPEC_HISTORY_ROWS = 26;

function colorForSpecFreq(hz: number): string {
  if (hz < 120) return '#f59e0b'; // Kick amber mountains
  if (hz < 280) return '#ec4899'; // Tom low-mid pink slope
  if (hz < 2600) return '#34d399'; // Snare/Clap emerald foothills
  if (hz < 4500) return '#94a3b8'; // Transition slate
  return '#38bdf8'; // Hi-hat sky-blue road center
}

const SPEC_BIN_COLORS: readonly string[] = Array.from({ length: SPEC_HALF_COLS }, (_, c) => {
  const hz = Math.exp(SPEC_LOG_MIN + (c / Math.max(1, SPEC_HALF_COLS - 1)) * (SPEC_LOG_MAX - SPEC_LOG_MIN));
  return colorForSpecFreq(hz);
});

const HIGHWAY_TIER_META: Record<JudgementTier, { label: string; color: string }> = {
  marvelous: { label: 'MARVELOUS', color: '#67e8f9' },
  perfect: { label: 'PERFECT', color: '#fde047' },
  great: { label: 'GREAT', color: '#34d399' },
  good: { label: 'GOOD', color: '#38bdf8' },
  boo: { label: 'BOO', color: '#c084fc' },
  miss: { label: 'MISS', color: '#f87171' },
};

const HIGHWAY_BAND_COLORS: Record<string, string> = {
  amber: '#f59e0b',
  emerald: '#34d399',
  sky: '#38bdf8',
  pink: '#ec4899',
  violet: '#a78bfa',
  kick: '#f59e0b',
  snare: '#34d399',
  hat: '#38bdf8',
};

export function ScreensaverVisualizer({
  sync,
  sections,
  isPlaying,
  songDurationSec,
  drumEvents,
  tomBandIds,
  difficulty,
  pinkPantherPct = 20,
  percussionPct = 200,
  snareCounterKick = true,
  simpleBarOrientation = true,
  simSoundMode = 'sync',
  simSoundEnabled = { kick: false, snare: false, hat: false, tom: false },
  pressedLanesRef,
  judgedNotesRef,
  lastJudgementHudRef,
  playerInputTriggersRef,
  playScore,
  playScoreRef,
  onPlaybackTick,
  fileName,
  onChangeSimSoundMode,
  onBeforeDemoExportStart,
  exportHandleRef,
  onWebmExportStateChange,
  exportWidth = 1280,
  exportHeight = 720,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const rainCanvasRef = useRef<HTMLCanvasElement>(null);
  const cockpitCanvasRef = useRef<HTMLCanvasElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [preset, setPreset] = useState<WindshieldPreset>('glsl-space');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [glFallback, setGlFallback] = useState(false);
  const [showInputHighway, setShowInputHighway] = useState(true);
  const [activeExportSize, setActiveExportSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const [isArmedToRecord, setIsArmedToRecord] = useState(false);
  const [isPortraitView, setIsPortraitView] = useState(() => exportHeight > exportWidth * 1.05);

  const presetRef = useRef<WindshieldPreset>(preset);
  presetRef.current = preset;
  const showInputHighwayRef = useRef(showInputHighway);
  showInputHighwayRef.current = showInputHighway;
  const glFallbackRef = useRef(glFallback);
  glFallbackRef.current = glFallback;
  const isPortraitViewRef = useRef(isPortraitView);
  isPortraitViewRef.current = isPortraitView;
  const lastAutoSectionKeyRef = useRef<string | null>(null);
  const prevAutoBeatRef = useRef<number | null>(null);

  const sortedSections = useMemo(
    () => [...sections].sort((a, b) => a.beat - b.beat),
    [sections]
  );

  const exportSessionRef = useRef<{
    active: boolean;
    armed: boolean;
    finishing: boolean;
    cancelled: boolean;
    recorder: MediaRecorder | null;
    videoStream: MediaStream | null;
    chunks: Blob[];
    mimeType: string;
    prevLoop: boolean;
    durationSec: number;
    width: number;
    height: number;
    outFileName: string;
    startedPlaybackAtMs: number;
    lastProgressUiMs: number;
    finishTimerId: number | null;
    clearTerrainOnStart?: boolean;
    beginCaptureFn?: () => Promise<void>;
  } | null>(null);

  const tomBandSet = useMemo(() => new Set(['tom', ...tomBandIds]), [tomBandIds]);

  const propsRef = useRef({
    sync,
    sections,
    sortedSections,
    isPlaying,
    songDurationSec,
    drumEvents,
    tomBandSet,
    difficulty,
    pinkPantherPct,
    percussionPct,
    snareCounterKick,
    simpleBarOrientation,
    simSoundMode,
    simSoundEnabled,
    pressedLanesRef,
    judgedNotesRef,
    lastJudgementHudRef,
    playerInputTriggersRef,
    playScoreRef,
    onPlaybackTick,
    fileName,
    onChangeSimSoundMode,
    onBeforeDemoExportStart,
    onWebmExportStateChange,
    exportWidth,
    exportHeight,
  });
  propsRef.current = {
    sync,
    sections,
    sortedSections,
    isPlaying,
    songDurationSec,
    drumEvents,
    tomBandSet,
    difficulty,
    pinkPantherPct,
    percussionPct,
    snareCounterKick,
    simpleBarOrientation,
    simSoundMode,
    simSoundEnabled,
    pressedLanesRef,
    judgedNotesRef,
    lastJudgementHudRef,
    playerInputTriggersRef,
    playScoreRef,
    onPlaybackTick,
    fileName,
    onChangeSimSoundMode,
    onBeforeDemoExportStart,
    onWebmExportStateChange,
    exportWidth,
    exportHeight,
  };

  // Minimal DOM HUD snapshot throttled cleanly for 15fps UI readouts (no 60fps React re-renders)
  const [hudReadout, setHudReadout] = useState<{
    barDisplay: string;
    beatDisplay: string;
    symbol: 'L' | '&' | 'R';
    stepInBar: number;
    barParity: 'A' | 'B';
    pattern: readonly ('L' | '&' | 'R')[];
    inSongBounds: boolean;
    kick: number;
    snare: number;
    tom: number;
    hatA: number;
    hatB: number;
    visualDeg: number;
  }>({
    barDisplay: '01',
    beatDisplay: '1',
    symbol: '&',
    stepInBar: 0,
    barParity: 'A',
    pattern: ['L', '&', 'R', '&', 'L', '&', 'L', '&'],
    inSongBounds: false,
    kick: 0,
    snare: 0,
    tom: 0,
    hatA: 0,
    hatB: 0,
    visualDeg: 0,
  });

  // Track browser fullscreen state
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else if (el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen toggle unavailable:', err);
    }
  };

  // Number keys 1..4 quick preset switching while viewing Screensaver
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const matched = PRESETS.find((p) => p.keyNum === e.key);
      if (matched) {
        setPreset(matched.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Capture Spacebar while recording is armed so the window has focus before capture starts
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      const sess = exportSessionRef.current;
      if (!sess || !sess.active || !sess.armed) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!e.repeat) {
          void sess.beginCaptureFn?.();
        }
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, []);

  // Main unified animation engine (WebGL shaders + Music Rain particles + Futuristic Cockpit Vector Overlay)
  useEffect(() => {
    const bgCanvas = bgCanvasRef.current;
    const rainCanvas = rainCanvasRef.current;
    const cockpitCanvas = cockpitCanvasRef.current;
    if (!bgCanvas || !rainCanvas || !cockpitCanvas) return;

    const cockpitCtx = cockpitCanvas.getContext('2d');
    const rainCtx = rainCanvas.getContext('2d');
    if (!cockpitCtx || !rainCtx) return;

    // Initialize WebGL2 shader pipeline for GLSL Space / Wormhole / MilkDrop
    let gl: WebGL2RenderingContext | null = null;
    let glPrograms: Partial<Record<'glsl-space' | 'wormhole' | 'milkdrop', WebGLProgram>> = {};
    let quadVao: WebGLVertexArrayObject | null = null;
    let quadVbo: WebGLBuffer | null = null;
    let glContextLost = false;

    const initWebGL = () => {
      try {
        const ctx = bgCanvas.getContext('webgl2', {
          antialias: false,
          powerPreference: 'high-performance',
        });
        if (!ctx) {
          setGlFallback(true);
          return;
        }
        gl = ctx;

        const spaceProg = createProgram(ctx, GLSL_SPACE_FRAG);
        const wormProg = createProgram(ctx, WORMHOLE_FRAG);
        const milkProg = createProgram(ctx, MILKDROP_FRAG);
        if (spaceProg) glPrograms['glsl-space'] = spaceProg;
        if (wormProg) glPrograms['wormhole'] = wormProg;
        if (milkProg) glPrograms['milkdrop'] = milkProg;
        setGlFallback(!(spaceProg && wormProg && milkProg));

        quadVao = ctx.createVertexArray();
        quadVbo = ctx.createBuffer();
        ctx.bindVertexArray(quadVao);
        ctx.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
        ctx.bufferData(
          ctx.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
          ctx.STATIC_DRAW
        );
        ctx.enableVertexAttribArray(0);
        ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);
        ctx.bindVertexArray(null);
      } catch {
        gl = null;
        setGlFallback(true);
      }
    };

    initWebGL();

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      glContextLost = true;
      setGlFallback(true);
    };
    const handleContextRestored = () => {
      glContextLost = false;
      glPrograms = {};
      initWebGL();
    };
    bgCanvas.addEventListener('webglcontextlost', handleContextLost);
    bgCanvas.addEventListener('webglcontextrestored', handleContextRestored);

    const particles = createRainParticles(220);
    const terrainHistory: Float32Array[] = [];
    const liveColValues = new Float32Array(SPEC_HALF_COLS);
    const liveWaveValues = new Float32Array(SPEC_HALF_COLS);
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let timeData: Uint8Array<ArrayBuffer> | null = null;
    let lastHistoryPushMs = 0;

    let motionState: WheelMotionState = {
      visualAngleDeg: 0,
      angularVelocity: 0,
      peakKickGlow: 0,
      peakSnareGlow: 0,
      peakTomGlow: 0,
      peakHatAGlow: 0,
      peakHatBGlow: 0,
    };

    let lastFrameMs = performance.now();
    let lastHudUpdateMs = 0;
    let visualTimeAcc = 0;
    let prevRenderedPreset: WindshieldPreset | null = null;
    let rafId = 0;

    const resizeCanvases = () => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const exportSess = exportSessionRef.current;
      const exporting = Boolean(exportSess?.active);
      const targetW =
        exporting && exportSess ? exportSess.width : Math.max(320, Math.round(rect.width * dpr));
      const targetH =
        exporting && exportSess ? exportSess.height : Math.max(240, Math.round(rect.height * dpr));

      const screenLayout = getCockpitScreenLayout(rect.width, rect.height);
      const nextPortrait = targetH > targetW * 1.05;
      if (isPortraitViewRef.current !== nextPortrait) {
        isPortraitViewRef.current = nextPortrait;
        setIsPortraitView(nextPortrait);
      }

      const dashScale = Math.max(
        nextPortrait ? 0.62 : 0.85,
        Math.min(screenLayout.left.w / 196, screenLayout.left.h / 104)
      );
      container.style.setProperty('--dash-fs', `${(dashScale * 16).toFixed(2)}px`);

      if (bgCanvas.width !== targetW || bgCanvas.height !== targetH) {
        bgCanvas.width = targetW;
        bgCanvas.height = targetH;
      }
      if (rainCanvas.width !== targetW || rainCanvas.height !== targetH) {
        rainCanvas.width = targetW;
        rainCanvas.height = targetH;
      }
      if (cockpitCanvas.width !== targetW || cockpitCanvas.height !== targetH) {
        cockpitCanvas.width = targetW;
        cockpitCanvas.height = targetH;
      }
    };

    const drawMirroredSpectrumTerrain = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number
    ) => {
      const total = terrainHistory.length;
      if (total === 0) return;

      const isPortrait = h > w * 1.05;
      // Exact sky/valley horizon matching GLSL_SPACE_FRAG horizonY = 0.05, ending at the dashboard sill
      const horizonY = h * 0.5 - 0.05 * Math.min(w, h);
      const baseY = isPortrait ? h * 0.61 : h * 0.69;
      const sweepH = Math.max(30, baseY - horizonY);
      const totalDots = SPEC_HALF_COLS * 2;
      const dotScale = Math.max(0.75, Math.min(2.2, Math.hypot(w, h) / 1150));

      // Iterate newest (horizon, back) -> oldest (foreground, front) for clean painter occlusion
      for (let r = total - 1; r >= 0; r--) {
        const slice = terrainHistory[r];
        const ageRatio = total > 1 ? (total - 1 - r) / (total - 1) : 0; // 0 = newest (horizon), 1 = oldest (foreground)
        const invAge = 1 - ageRatio; // 1 at horizon, 0 at foreground
        const rowBaseY = baseY - invAge * sweepH;
        const rowWidth = w * (1.5 - invAge * 0.55); // 95% at horizon -> 150% at near dashboard sill
        const xInset = (w - rowWidth) * 0.5;
        const rowGain = (0.2 + invAge * 1.5) * (Math.min(w, h) * 0.16);
        const intensityBoost = 0.65 + ageRatio * 0.35;

        // Dark occlusion silhouette beneath advancing dot-matrix ridge so front rows cover distant hills
        ctx.beginPath();
        ctx.moveTo(xInset, rowBaseY);
        for (let c = 0; c < totalDots; c++) {
          const binIdx = c < SPEC_HALF_COLS ? c : totalDots - 1 - c;
          const cx = xInset + (c / (totalDots - 1)) * rowWidth;
          const cy = rowBaseY - slice[binIdx] * rowGain;
          ctx.lineTo(cx, cy);
        }
        ctx.lineTo(xInset + rowWidth, rowBaseY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(3, 5, 11, 0.72)';
        ctx.fill();

        // Mirrored dot-matrix terrain points: [Mountain (30Hz) .. Road (16kHz) | Mirrored Road .. Mirrored Mountain]
        for (let c = 0; c < totalDots; c++) {
          const binIdx = c < SPEC_HALF_COLS ? c : totalDots - 1 - c;
          const amp = slice[binIdx];
          if (amp < 0.03) continue;
          const cx = xInset + (c / (totalDots - 1)) * rowWidth;
          if (cx < -10 || cx > w + 10) continue;
          const cy = rowBaseY - amp * rowGain;
          ctx.fillStyle = SPEC_BIN_COLORS[binIdx];
          ctx.globalAlpha = Math.min(1, 0.25 + intensityBoost * 0.65 + amp * 0.25);
          const dotR = (1.0 + ageRatio * 0.9 + amp * 0.95) * dotScale;
          ctx.beginPath();
          ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    };

    const drawWormholeDotMatrix = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      target: BodyLanguageTarget,
      timeSec: number
    ) => {
      // Exact vanishing portal matched to WORMHOLE_FRAG center = (0.0, 0.10)
      const cx = w * 0.5;
      const cy = h * 0.5 - 0.1 * Math.min(w, h);
      const minR = Math.min(w, h) * 0.055;
      const maxR = Math.hypot(w * 0.58, h * 0.65);
      const dotScale = Math.max(0.75, Math.min(2.2, Math.hypot(w, h) / 1150));

      const totalDots = SPEC_HALF_COLS * 2; // 96 radial points around 360° in 4 mirrored quadrants
      const quadDots = totalDots / 4; // 24 dots per quadrant
      const total = terrainHistory.length;
      const ringTwistBase =
        timeSec * 0.16 + Math.sin(target.meter.beatFloat * 0.35) * 0.22;

      if (total === 0) {
        // Gentle idle breathing rings before first audio sample arrives
        for (let ring = 0; ring < 8; ring++) {
          const depthT = Math.pow(ring / 7, 1.5);
          const rad = minR + depthT * (maxR * 0.72 - minR);
          const alpha = 0.16 + (1 - depthT) * 0.25;
          ctx.fillStyle = ring % 2 === 0 ? '#38bdf8' : '#34d399';
          ctx.globalAlpha = alpha;
          for (let c = 0; c < totalDots; c += 2) {
            const theta = (c / totalDots) * Math.PI * 2 + ringTwistBase + ring * 0.06;
            const px = cx + Math.cos(theta) * rad;
            const py = cy + Math.sin(theta) * rad;
            if (px < -10 || px > w + 10 || py < -10 || py > h + 10) continue;
            ctx.beginPath();
            ctx.arc(px, py, (1.1 + depthT * 1.2) * dotScale, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        return;
      }

      // Iterate newest (deep vanishing core) -> oldest (outer edge whipping past windshield)
      for (let r = total - 1; r >= 0; r--) {
        const slice = terrainHistory[r];
        const ageRatio = total > 1 ? (total - 1 - r) / (total - 1) : 0; // 0 = center core, 1 = nearest foreground
        const invAge = 1 - ageRatio;
        const depthT = Math.pow(ageRatio, 1.48);
        const baseRingR = minR + depthT * (maxR - minR);
        // Sculpted inward canyon walls that gently flatten as rings whip past cockpit edges
        const radialRelief = (0.18 + invAge * 0.44) * baseRingR;
        const swirl = ringTwistBase + invAge * 0.42;
        const intensityBoost = 0.6 + ageRatio * 0.4;

        // Soft dark tunnel ring shadow separating chronological depths without grid lines
        ctx.beginPath();
        for (let c = 0; c <= totalDots; c++) {
          const ci = c % totalDots;
          const q = Math.floor(ci / quadDots);
          const posInQ = ci % quadDots;
          const u = posInQ / Math.max(1, quadDots - 1);
          const binIdx = Math.round((q % 2 === 0 ? u : 1 - u) * (SPEC_HALF_COLS - 1));
          const amp = slice[binIdx];
          const rad = Math.max(minR * 0.55, baseRingR - amp * radialRelief);
          const theta = (ci / totalDots) * Math.PI * 2 + swirl;
          const px = cx + Math.cos(theta) * rad;
          const py = cy + Math.sin(theta) * rad;
          if (c === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(15, 23, 42, ${(0.22 + invAge * 0.25).toFixed(2)})`;
        ctx.lineWidth = Math.max(1, 1.5 * dotScale);
        ctx.stroke();

        // Plot luminous 360° dot-matrix sound canyon points
        for (let c = 0; c < totalDots; c++) {
          const q = Math.floor(c / quadDots);
          const posInQ = c % quadDots;
          const u = posInQ / Math.max(1, quadDots - 1);
          const binIdx = Math.round((q % 2 === 0 ? u : 1 - u) * (SPEC_HALF_COLS - 1));
          const amp = slice[binIdx];
          if (amp < 0.03) continue;

          const rad = Math.max(minR * 0.55, baseRingR - amp * radialRelief);
          const theta = (c / totalDots) * Math.PI * 2 + swirl;
          const px = cx + Math.cos(theta) * rad;
          const py = cy + Math.sin(theta) * rad;
          if (px < -12 || px > w + 12 || py < -12 || py > h + 12) continue;

          ctx.fillStyle = SPEC_BIN_COLORS[binIdx];
          ctx.globalAlpha = Math.min(1, 0.22 + intensityBoost * 0.65 + amp * 0.25);
          const dotR = (0.95 + ageRatio * 1.65 + amp * 1.05) * dotScale;
          ctx.beginPath();
          ctx.arc(px, py, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    };

    const drawMilkdropDotMatrix = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      target: BodyLanguageTarget,
      timeSec: number,
      useAlphaDecay: boolean
    ) => {
      // Soft transparent liquid decay over WebGL fractal backdrop (classic MilkDrop afterglow trails)
      if (useAlphaDecay) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0, 0, 0, ${0.22 + target.impulses.snare * 0.08})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      // Optical center aligned to MILKDROP_FRAG (uv - vec2(0.0, 0.06))
      const cx = w * 0.5;
      const cy = h * 0.5 - 0.06 * Math.min(w, h);
      const minDim = Math.min(w, h);
      const dotScale = Math.max(0.75, Math.min(2.2, Math.hypot(w, h) / 1150));

      const { kick, snare, tom, hat, hatParity } = target.impulses;
      const folds = Math.floor(target.meter.phraseIndex) % 2 === 0 ? 6 : 8;
      const sectorAngle = (Math.PI * 2) / folds;
      const baseSpin = timeSec * 0.16 + Math.sin(target.meter.beatFloat * 0.38) * 0.25;
      const coreR = minDim * (0.11 + kick * 0.032);
      const maxPetalR = minDim * 0.56;

      // 1. K-Fold Mirrored Dot-Matrix Kaleidoscope Petals (outermost echoes -> glowing newest core)
      const total = terrainHistory.length;
      if (total > 0) {
        const colStep = 2; // 24 mirrored frequency dots per kaleidoscope sector
        for (let r = 0; r < total; r++) {
          const slice = terrainHistory[r];
          const ageRatio = total > 1 ? (total - 1 - r) / (total - 1) : 0; // 0 = newest, 1 = oldest
          const invAge = 1 - ageRatio;
          const ringR = coreR * 0.85 + Math.pow(ageRatio, 1.15) * (maxPetalR - coreR * 0.85);
          const swirlOffset =
            baseSpin +
            Math.sin(ageRatio * 3.4 - timeSec * 1.1 + tom * 0.9) * 0.18 +
            ageRatio * 0.42;
          const petalGain = (0.18 + invAge * 0.55) * minDim * 0.19;

          for (let f = 0; f < folds; f++) {
            const mirror = f % 2 === 1;
            const foldStart = f * sectorAngle + swirlOffset;
            for (let c = 0; c < SPEC_HALF_COLS; c += colStep) {
              const amp = slice[c];
              if (amp < 0.035) continue;

              const u = c / (SPEC_HALF_COLS - 1);
              const localU = mirror ? 1 - u : u;
              const theta = foldStart + localU * sectorAngle;
              // Bass flares petals outward; highs weave crisp delicate inner filaments
              const radial = ringR + amp * petalGain;
              const px = cx + Math.cos(theta) * radial;
              const py = cy + Math.sin(theta) * radial;
              if (px < -12 || px > w + 12 || py < -12 || py > h + 12) continue;

              ctx.fillStyle = SPEC_BIN_COLORS[c];
              ctx.globalAlpha = Math.min(0.92, (0.18 + invAge * 0.62) * (0.45 + amp * 0.75));
              const dotR = (0.85 + invAge * 1.1 + amp * 1.15) * dotScale;
              ctx.beginPath();
              ctx.arc(px, py, dotR, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.globalAlpha = 1;
      }

      // 2. Live Winamp-Style Mirrored Dot-Matrix Oscilloscope Ring at Mandala Core
      const scopeDots = SPEC_HALF_COLS * 2;
      const waveAmpScale = minDim * (0.048 + snare * 0.045 + hat * 0.018);
      const scopeSpin = -baseSpin * 0.75;
      for (let c = 0; c < scopeDots; c++) {
        const idx = c < SPEC_HALF_COLS ? c : scopeDots - 1 - c;
        const wave = liveWaveValues[idx];
        const energy = Math.min(1, Math.abs(wave) * 1.8);
        const theta = (c / scopeDots) * Math.PI * 2 + scopeSpin;
        const radial = Math.max(minDim * 0.04, coreR + wave * waveAmpScale);
        const px = cx + Math.cos(theta) * radial;
        const py = cy + Math.sin(theta) * radial;

        ctx.fillStyle =
          energy > 0.58
            ? '#f59e0b'
            : hatParity === 'A'
            ? SPEC_BIN_COLORS[idx]
            : '#34d399';
        ctx.globalAlpha = 0.45 + energy * 0.55;
        const dotR = (1.15 + energy * 1.35) * dotScale;
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const draw2DFallbackPreset = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      activePreset: WindshieldPreset,
      target: BodyLanguageTarget
    ) => {
      const { beatPhase } = target.meter;
      const { kick, snare, tom } = target.impulses;
      if (activePreset === 'milkdrop') {
        // Gentle dark trail fill so 2D fallback also carries classic MilkDrop liquid persistence
        ctx.fillStyle = `rgba(4, 6, 13, ${0.24 + snare * 0.08})`;
        ctx.fillRect(0, 0, w, h);
        const my = h * 0.5 - 0.06 * Math.min(w, h);
        const aura = ctx.createRadialGradient(w * 0.5, my, 0, w * 0.5, my, Math.min(w, h) * 0.52);
        aura.addColorStop(0, `rgba(16, 185, 129, ${0.14 + snare * 0.16})`);
        aura.addColorStop(0.5, `rgba(236, 72, 153, ${0.08 + tom * 0.12})`);
        aura.addColorStop(1, 'rgba(4, 6, 13, 0)');
        ctx.fillStyle = aura;
        ctx.fillRect(0, 0, w, h);
        return;
      }

      ctx.fillStyle = '#04060d';
      ctx.fillRect(0, 0, w, h);

      const cx = w * 0.5;
      const hy = h * 0.5 - 0.05 * Math.min(w, h);

      if (activePreset === 'wormhole') {
        const wy = h * 0.5 - 0.1 * Math.min(w, h);
        const aura = ctx.createRadialGradient(cx, wy, 0, cx, wy, Math.max(w, h) * 0.55);
        aura.addColorStop(0, `rgba(56, 189, 248, ${0.28 + kick * 0.25})`);
        aura.addColorStop(0.35, `rgba(139, 92, 246, ${0.14 + tom * 0.16})`);
        aura.addColorStop(1, 'rgba(4, 6, 13, 0)');
        ctx.fillStyle = aura;
        ctx.fillRect(0, 0, w, h);
      } else {
        // GLSL-Space 2D twilight sky fallback (ground uses mirrored dot-matrix terrain)
        const grad = ctx.createLinearGradient(0, 0, 0, hy);
        grad.addColorStop(0, '#040612');
        grad.addColorStop(1, `rgba(24, 52, 82, ${0.65 + snare * 0.25})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, hy);

        ctx.strokeStyle = `rgba(56, 189, 248, ${0.28 + beatPhase * 0.2})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, hy);
        ctx.lineTo(w, hy);
        ctx.stroke();
      }
    };

    const drawMusicRain = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      dtSec: number,
      target: BodyLanguageTarget,
      timeSec: number
    ) => {
      const { kick, snare, tom, hat, hatParity } = target.impulses;
      const personaMult =
        target.persona === 'Dancer' ? 0.72 : target.persona === 'Performer' ? 1.0 : 1.32;

      // Subtle motion trail persistence
      ctx.fillStyle = `rgba(3, 5, 11, ${0.28 + snare * 0.14})`;
      ctx.fillRect(0, 0, w, h);

      const isPortrait = h > w * 1.05;
      const cx = w * 0.5;
      const cy = isPortrait ? h * 0.33 : h * 0.42;

      // Deep subtle radial horizon ambience
      const bgGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.65);
      bgGlow.addColorStop(0, `rgba(14, 116, 144, ${0.12 + kick * 0.14 + snare * 0.12})`);
      bgGlow.addColorStop(0.55, `rgba(15, 23, 42, ${0.06 + tom * 0.08})`);
      bgGlow.addColorStop(1, 'rgba(2, 4, 8, 0)');
      ctx.fillStyle = bgGlow;
      ctx.fillRect(0, 0, w, h);

      const projX = isPortrait ? Math.min(w, h) * 0.54 : w * 0.45;
      const projY = isPortrait ? Math.min(w, h) * 0.54 : h * 0.45;
      const baseSpeed = (0.38 + kick * 1.15 + snare * 0.55 + tom * 0.85) * personaMult;
      const turb = (0.04 + tom * 0.28 + hat * 0.12) * personaMult;

      const activeRatio =
        target.persona === 'Dancer' ? 0.55 : target.persona === 'Performer' ? 0.82 : 1.0;
      const count = Math.floor(particles.length * activeRatio);

      ctx.lineCap = 'round';
      for (let i = 0; i < count; i++) {
        const pt = particles[i];
        pt.prevZ = pt.z;
        pt.z -= baseSpeed * dtSec * (0.65 + pt.hueSeed * 0.65);

        // Turbulence twist from percussion (independent of wheel steering!)
        const swirl =
          Math.sin(timeSec * 2.2 + pt.hueSeed * 12.0 + target.meter.beatFloat * 1.5) *
          turb *
          dtSec;
        const rx = pt.x - pt.y * swirl;
        const ry = pt.y + pt.x * swirl;
        pt.x = rx;
        pt.y = ry;

        if (pt.z <= 0.025) {
          pt.x = (Math.random() - 0.5) * 2.4;
          pt.y = (Math.random() - 0.5) * 1.8;
          pt.z = 0.92 + Math.random() * 0.08;
          pt.prevZ = pt.z;
          continue;
        }

        const scaleNow = 0.52 / pt.z;
        const scalePrev = 0.52 / pt.prevZ;
        const sx = cx + pt.x * scaleNow * projX;
        const sy = cy + pt.y * scaleNow * projY;
        const px = cx + pt.x * scalePrev * projX;
        const py = cy + pt.y * scalePrev * projY;

        if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;

        const alpha = Math.min(0.95, (1.0 - pt.z) * 1.15 * (0.55 + 0.55 * target.impulses.totalEnergy));
        let strokeColor: string;
        if (kick > 0.45 && pt.hueSeed < 0.35) {
          strokeColor = `rgba(245, 158, 11, ${alpha})`;
        } else if (tom > 0.38 && pt.hueSeed > 0.72) {
          strokeColor = `rgba(236, 72, 153, ${alpha})`;
        } else if (snare > 0.35 && pt.hueSeed >= 0.35 && pt.hueSeed < 0.58) {
          strokeColor = `rgba(52, 211, 153, ${alpha})`;
        } else {
          strokeColor =
            hatParity === 'A'
              ? `rgba(56, 189, 248, ${alpha})`
              : `rgba(125, 211, 252, ${alpha})`;
        }

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = Math.max(1.0, (1.0 - pt.z) * 2.8 * pt.size * (Math.max(w, h) / 900));
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }
    };

    const drawHighwayArrow = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      sizeR: number,
      dir: 'left' | 'down' | 'up' | 'right',
      color: string,
      badge: string
    ) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = color;
      if (dir === 'left') ctx.rotate(-Math.PI / 2);
      else if (dir === 'down') ctx.rotate(Math.PI);
      else if (dir === 'right') ctx.rotate(Math.PI / 2);

      ctx.beginPath();
      ctx.moveTo(0, -sizeR);
      ctx.lineTo(sizeR, 0);
      ctx.lineTo(sizeR * 0.34, 0);
      ctx.lineTo(sizeR * 0.34, sizeR);
      ctx.lineTo(-sizeR * 0.34, sizeR);
      ctx.lineTo(-sizeR * 0.34, 0);
      ctx.lineTo(-sizeR, 0);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, sizeR * 0.09);
      ctx.stroke();
      ctx.restore();

      if (badge) {
        ctx.save();
        ctx.font = `bold ${Math.max(8, Math.round(sizeR * 0.62))}px monospace`;
        ctx.fillStyle = '#030712';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge, x, y);
        ctx.restore();
      }
    };

    const drawWindshieldInputHighway = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      cx: number,
      wheelR: number,
      roofY: number,
      currentTime: number,
      playing: boolean,
      curEvents: DrumEvent[],
      curToms: Set<string>,
      curSimMode: SimSoundMode,
      curSimEnabled: Record<SimDrumBand, boolean>,
      curPressedRef: React.RefObject<[boolean, boolean, boolean, boolean]> | undefined,
      curJudgedRef: React.RefObject<Map<number, JudgementTier | 'skipped'>> | undefined,
      curJudgementHudRef: React.RefObject<JudgementHudSnapshot | null> | undefined
    ) => {
      const isPortrait = h > w * 1.05;
      const hwLeft = cx - wheelR;
      const hwWidth = wheelR * 2;
      const laneW = hwWidth / 4;
      const hitY = isPortrait ? h * 0.53 : h * 0.592;
      const dashStopY = isPortrait ? h * 0.565 : h * 0.632;
      const scrollSpeed = isPortrait ? h * 0.44 : h * 0.64; // rain down cleanly from windshield top to dashboard hit line
      const boxHalf = Math.min(laneW * 0.34, h * 0.028);
      const arrowR = Math.min(laneW * 0.32, h * 0.026);
      const arrowDirs: readonly ('left' | 'down' | 'up' | 'right')[] = ['left', 'down', 'up', 'right'];
      const laneLabels = ['←', '↓', '↑', '→'];
      const keyHints = ['D', 'F', 'J', 'K'];

      ctx.save();
      // Clip arrows cleanly inside windshield vertical span above dashboard edge
      ctx.beginPath();
      ctx.rect(hwLeft - arrowR, roofY, hwWidth + arrowR * 2, dashStopY - roofY);
      ctx.clip();

      // Subtle dark translucent vertical lane column tint over windshield matching wheel width
      const trackGrad = ctx.createLinearGradient(0, roofY, 0, dashStopY);
      trackGrad.addColorStop(0, 'rgba(3, 5, 11, 0)');
      trackGrad.addColorStop(0.28, 'rgba(3, 5, 11, 0.24)');
      trackGrad.addColorStop(1, 'rgba(3, 5, 11, 0.42)');
      ctx.fillStyle = trackGrad;
      ctx.fillRect(hwLeft, roofY, hwWidth, dashStopY - roofY);

      // Subtle lane rails
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      for (let l = 0; l <= 4; l++) {
        const lx = hwLeft + l * laneW;
        ctx.beginPath();
        ctx.moveTo(lx, roofY + h * 0.04);
        ctx.lineTo(lx, dashStopY);
        ctx.stroke();
      }

      // Highlight receptors for Demo / Sync scheduled hits OR live D F J K presses
      const laneHitFlashColor: Array<string | null> = [null, null, null, null];
      if (playing && curEvents.length > 0 && curSimMode !== 'input') {
        const anySoundOn =
          curSimEnabled.kick ||
          curSimEnabled.snare ||
          curSimEnabled.hat ||
          curSimEnabled.tom;
        if (curSimMode === 'demo' || anySoundOn) {
          for (let i = 0; i < curEvents.length; i++) {
            const ev = curEvents[i];
            const simBand: SimDrumBand | null =
              ev.band === 'kick' || ev.band === 'snare' || ev.band === 'hat'
                ? ev.band
                : curToms.has(ev.band)
                ? 'tom'
                : null;
            if (curSimMode !== 'demo' && (!simBand || !curSimEnabled[simBand])) {
              continue;
            }
            const dt = currentTime - ev.time;
            if (dt >= -0.01 && dt <= 0.065) {
              laneHitFlashColor[ev.lane] =
                (ev.color && HIGHWAY_BAND_COLORS[ev.color]) ||
                HIGHWAY_BAND_COLORS[ev.band] ||
                '#ec4899';
            }
          }
        }
      }

      // Glowing horizontal Hit Line near dashboard crest
      ctx.beginPath();
      ctx.moveTo(hwLeft, hitY);
      ctx.lineTo(hwLeft + hwWidth, hitY);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
      ctx.lineWidth = Math.max(1.2, h * 0.003);
      ctx.stroke();

      // Draw 4 receptors at hitY
      const pressedLanes = curPressedRef?.current;
      for (let i = 0; i < 4; i++) {
        const laneCx = hwLeft + i * laneW + laneW * 0.5;
        const isPressed = curSimMode !== 'demo' && Boolean(pressedLanes?.[i]);
        const activeColor = laneHitFlashColor[i] || (isPressed ? '#ffffff' : null);

        if (activeColor) {
          ctx.fillStyle = isPressed ? 'rgba(255,255,255,0.2)' : `${activeColor}36`;
          ctx.fillRect(laneCx - boxHalf, hitY - boxHalf, boxHalf * 2, boxHalf * 2);
        }
        ctx.strokeStyle = activeColor || 'rgba(255, 255, 255, 0.34)';
        ctx.lineWidth = activeColor ? 2.2 : 1.5;
        ctx.strokeRect(laneCx - boxHalf, hitY - boxHalf, boxHalf * 2, boxHalf * 2);

        ctx.fillStyle = activeColor || 'rgba(255, 255, 255, 0.36)';
        ctx.font = `bold ${Math.max(10, Math.round(boxHalf * 0.72))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(laneLabels[i], laneCx, hitY);

        ctx.fillStyle = activeColor || 'rgba(148, 163, 184, 0.78)';
        ctx.font = `bold ${Math.max(9, Math.round(boxHalf * 0.58))}px monospace`;
        ctx.fillText(keyHints[i], laneCx, hitY - boxHalf - Math.max(6, boxHalf * 0.42));
      }

      // Raining arrows falling from top of windshield down to hitY near dashboard
      const judgedMap = curJudgedRef?.current;
      for (let i = 0; i < curEvents.length; i++) {
        const hitStatus = judgedMap?.get(i);
        if (hitStatus && hitStatus !== 'miss' && hitStatus !== 'skipped') continue;
        const ev = curEvents[i];
        const y = hitY - (ev.time - currentTime) * scrollSpeed;
        if (y < roofY - arrowR * 1.5 || y > dashStopY + arrowR) continue;

        const badge =
          ev.badge ||
          (ev.band === 'kick' ? 'K' : ev.band === 'snare' ? 'C' : ev.band === 'hat' ? 'H' : 'T');
        const color =
          (ev.color && HIGHWAY_BAND_COLORS[ev.color]) ||
          HIGHWAY_BAND_COLORS[ev.band] ||
          '#ec4899';

        // Soft fade-in at top header & fade-out if missed below hit line
        let alpha = hitStatus === 'miss' ? 0.34 : 0.94;
        if (y < roofY + h * 0.06) {
          alpha *= Math.max(0, (y - roofY) / (h * 0.06));
        } else if (y > hitY + boxHalf * 0.8) {
          alpha *= Math.max(0, 1 - (y - (hitY + boxHalf * 0.8)) / (dashStopY - hitY));
        }

        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        const laneCx = hwLeft + ev.lane * laneW + laneW * 0.5;
        drawHighwayArrow(ctx, laneCx, y, arrowR, arrowDirs[ev.lane], color, badge);
      }
      ctx.globalAlpha = 1;

      ctx.restore();
    };

    const drawFuturisticCockpit = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      target: BodyLanguageTarget,
      motion: WheelMotionState,
      currentTime: number,
      playing: boolean,
      curEvents: DrumEvent[],
      curToms: Set<string>,
      curSimMode: SimSoundMode,
      curSimEnabled: Record<SimDrumBand, boolean>,
      curPressedRef: React.RefObject<[boolean, boolean, boolean, boolean]> | undefined,
      curJudgedRef: React.RefObject<Map<number, JudgementTier | 'skipped'>> | undefined,
      curJudgementHudRef: React.RefObject<JudgementHudSnapshot | null> | undefined,
      inputOverlayVisible: boolean
    ) => {
      ctx.clearRect(0, 0, w, h);

      const screenLayout = getCockpitScreenLayout(w, h);
      const isPortrait = screenLayout.isPortrait;
      const scale = isPortrait ? Math.min(w / 620, h / 1100) : Math.min(w / 960, h / 600);
      const cx = w * 0.5;
      const wheelCy = isPortrait ? h * 0.695 : h * 0.82;
      const wheelR = isPortrait
        ? Math.min(w * 0.255, h * 0.145)
        : Math.min(w * 0.165, h * 0.275);

      const kickG = motion.peakKickGlow;
      const snareG = motion.peakSnareGlow;
      const tomG = motion.peakTomGlow;
      const hatAG = motion.peakHatAGlow;
      const hatBG = motion.peakHatBGlow;

      // Key interior frame coordinates connecting ceiling -> cockpit-angled [\\  /] pillars -> solid dashboard
      // Narrower dash shoulders flare outward to ceiling, forming a fighter/spaceship canopy & open side windows
      const roofYEdge = isPortrait ? h * 0.036 : h * 0.05;
      const roofYMid = isPortrait ? h * 0.028 : h * 0.04;
      const outerEdgeW = Math.max(5, w * 0.008);
      const pillarInnerTopX = isPortrait ? w * 0.078 : w * 0.088;
      const pillarInnerBotX = isPortrait ? w * 0.125 : w * 0.148;
      const pillarW = Math.max(14, w * 0.026);
      const pillarOuterTopX = pillarInnerTopX - pillarW;
      const pillarOuterBotX = pillarInnerBotX - pillarW;
      const dashCornerY = isPortrait ? h * 0.592 : h * 0.664;
      const dashShoulderY = isPortrait ? h * 0.602 : h * 0.674;
      const dashCrestY = isPortrait ? h * 0.565 : h * 0.625;
      const dashBinnacleMidY = isPortrait ? h * 0.596 : h * 0.668;
      const dashPadLowerY = isPortrait ? h * 0.642 : h * 0.716;
      const dashPadCrestY = isPortrait ? h * 0.594 : h * 0.656;
      const dashPadSideY = isPortrait ? h * 0.634 : h * 0.705;
      const dashWingY = isPortrait ? h * 0.636 : h * 0.706;

      // 0. Raining Input Arrow Highway projected above wheel width onto hit line near dashboard
      if (inputOverlayVisible) {
        drawWindshieldInputHighway(
          ctx,
          w,
          h,
          cx,
          wheelR,
          roofYMid,
          currentTime,
          playing,
          curEvents,
          curToms,
          curSimMode,
          curSimEnabled,
          curPressedRef,
          curJudgedRef,
          curJudgementHudRef
        );
      }

      // 1. Solid Opaque Dashboard Body (spans full door-to-door width below windshield + side-window sills)
      const dashGrad = ctx.createLinearGradient(0, dashCrestY, 0, h);
      dashGrad.addColorStop(0, '#10131b');
      dashGrad.addColorStop(0.18, '#090b10');
      dashGrad.addColorStop(0.55, '#05060a');
      dashGrad.addColorStop(1, '#030407');

      const traceDashTopContour = (offsetY = 0) => {
        const binnacleShoulderL = isPortrait ? w * 0.24 : w * 0.325;
        const binnacleShoulderR = w - binnacleShoulderL;
        ctx.moveTo(0, dashCornerY + offsetY);
        ctx.lineTo(pillarInnerBotX, dashShoulderY + offsetY);
        ctx.quadraticCurveTo(w * 0.19, dashBinnacleMidY + offsetY, binnacleShoulderL, dashBinnacleMidY + offsetY);
        // Sculpted driver instrument binnacle hood rising over steering wheel
        ctx.bezierCurveTo(
          isPortrait ? w * 0.32 : w * 0.38,
          dashBinnacleMidY - h * 0.003 + offsetY,
          isPortrait ? w * 0.37 : w * 0.41,
          dashCrestY + offsetY,
          cx,
          dashCrestY + offsetY
        );
        ctx.bezierCurveTo(
          isPortrait ? w * 0.63 : w * 0.59,
          dashCrestY + offsetY,
          isPortrait ? w * 0.68 : w * 0.62,
          dashBinnacleMidY - h * 0.003 + offsetY,
          binnacleShoulderR,
          dashBinnacleMidY + offsetY
        );
        ctx.quadraticCurveTo(w * 0.81, dashBinnacleMidY + offsetY, w - pillarInnerBotX, dashShoulderY + offsetY);
        ctx.lineTo(w, dashCornerY + offsetY);
      };

      ctx.beginPath();
      traceDashTopContour(0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = dashGrad;
      ctx.fill();

      // Subtle upper dash deck shadow / sculpted brow shelf
      ctx.save();
      ctx.beginPath();
      traceDashTopContour(0);
      ctx.lineTo(w, dashPadLowerY);
      ctx.quadraticCurveTo(w * 0.82, dashPadSideY + h * 0.003, isPortrait ? w * 0.76 : w * 0.675, dashPadSideY);
      ctx.bezierCurveTo(
        isPortrait ? w * 0.65 : w * 0.6,
        dashPadSideY,
        isPortrait ? w * 0.62 : w * 0.58,
        dashPadCrestY,
        cx,
        dashPadCrestY
      );
      ctx.bezierCurveTo(
        isPortrait ? w * 0.38 : w * 0.42,
        dashPadCrestY,
        isPortrait ? w * 0.35 : w * 0.4,
        dashPadSideY,
        isPortrait ? w * 0.24 : w * 0.325,
        dashPadSideY
      );
      ctx.quadraticCurveTo(w * 0.18, dashPadSideY + h * 0.003, 0, dashPadLowerY);
      ctx.closePath();
      const padGrad = ctx.createLinearGradient(0, dashCrestY, 0, dashPadLowerY + h * 0.005);
      padGrad.addColorStop(0, '#161a24');
      padGrad.addColorStop(1, '#090b10');
      ctx.fillStyle = padGrad;
      ctx.fill();
      ctx.restore();

      // Windshield & side-window base rubber seal along solid dashboard cowl edge
      ctx.beginPath();
      traceDashTopContour(0);
      ctx.strokeStyle = `rgba(148, 163, 184, ${0.18 + snareG * 0.22 + kickG * 0.15})`;
      ctx.lineWidth = Math.max(1.5, 2.2 * scale);
      ctx.stroke();

      // Subtle lower fascia accent line + Hi-Hat A/B wing ticks embedded along dash trim
      ctx.beginPath();
      ctx.moveTo(w * 0.025, dashWingY + h * 0.002);
      ctx.quadraticCurveTo(w * 0.15, dashWingY - h * 0.006, isPortrait ? w * 0.25 : w * 0.325, dashWingY - h * 0.008);
      ctx.moveTo(isPortrait ? w * 0.75 : w * 0.675, dashWingY - h * 0.008);
      ctx.quadraticCurveTo(w * 0.85, dashWingY - h * 0.006, w * 0.975, dashWingY + h * 0.002);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = Math.max(1, 1.2 * scale);
      ctx.stroke();

      const wingSegments = 5;
      const wingSpan = isPortrait ? 0.16 : 0.22;
      for (let i = 0; i < wingSegments; i++) {
        const t = i / (wingSegments - 1);
        const wxL = w * (0.045 + t * wingSpan);
        const wyL = dashWingY - t * h * 0.006;
        ctx.fillStyle = `rgba(56, 189, 248, ${0.1 + hatAG * (0.75 - i * 0.1)})`;
        ctx.fillRect(wxL, wyL, (isPortrait ? 11 : 14) * scale, 2.2 * scale);

        const wxR = w * (0.955 - t * wingSpan) - (isPortrait ? 11 : 14) * scale;
        const wyR = dashWingY - t * h * 0.006;
        ctx.fillStyle = `rgba(125, 211, 252, ${0.1 + hatBG * (0.75 - i * 0.1)})`;
        ctx.fillRect(wxR, wyR, (isPortrait ? 11 : 14) * scale, 2.2 * scale);
      }

      // Recessed Left & Right Dashboard Screen Bezels (housing the embedded GUI displays)
      const drawDashScreenBezel = (x: number, y: number, bw: number, bh: number) => {
        const rad = 8 * scale;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, rad);
        ctx.fillStyle = '#04060b';
        ctx.fill();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        ctx.lineWidth = Math.max(1, 1.4 * scale);
        ctx.stroke();

        // Outer molded plastic recess rim
        ctx.beginPath();
        ctx.roundRect(x - 2 * scale, y - 2 * scale, bw + 4 * scale, bh + 4 * scale, rad + 2 * scale);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.lineWidth = Math.max(2, 3 * scale);
        ctx.stroke();
        ctx.restore();
      };

      drawDashScreenBezel(
        screenLayout.left.x,
        screenLayout.left.y,
        screenLayout.left.w,
        screenLayout.left.h
      );
      drawDashScreenBezel(
        screenLayout.right.x,
        screenLayout.right.y,
        screenLayout.right.w,
        screenLayout.right.h
      );

      // 2. Solid Roof Ceiling Headliner & Slim Outer Door Border Framing Open Side Windows
      const roofGrad = ctx.createLinearGradient(0, 0, 0, roofYEdge + 8);
      roofGrad.addColorStop(0, '#07090e');
      roofGrad.addColorStop(1, '#0e121b');

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(w, dashCornerY + 2);
      ctx.lineTo(w - outerEdgeW, dashCornerY + 2);
      ctx.lineTo(w - outerEdgeW, roofYEdge);
      ctx.quadraticCurveTo(w * 0.94, roofYEdge - 0.004 * h, w - pillarInnerTopX, roofYEdge);
      ctx.quadraticCurveTo(cx, roofYMid - 0.008 * h, pillarInnerTopX, roofYEdge);
      ctx.quadraticCurveTo(w * 0.06, roofYEdge - 0.004 * h, outerEdgeW, roofYEdge);
      ctx.lineTo(outerEdgeW, dashCornerY + 2);
      ctx.lineTo(0, dashCornerY + 2);
      ctx.closePath();
      ctx.fillStyle = roofGrad;
      ctx.fill();

      // Angled Left & Right A-Pillars Connecting Ceiling Frame Directly to Solid Dashboard
      const drawAPillar = (
        outerTopX: number,
        innerTopX: number,
        innerBotX: number,
        outerBotX: number,
        isLeft: boolean
      ) => {
        const minX = Math.min(outerTopX, outerBotX, innerTopX, innerBotX);
        const maxX = Math.max(outerTopX, outerBotX, innerTopX, innerBotX);
        const pGrad = ctx.createLinearGradient(minX, 0, maxX, 0);
        if (isLeft) {
          pGrad.addColorStop(0, '#07090e');
          pGrad.addColorStop(0.5, '#131823');
          pGrad.addColorStop(1, '#090c12');
        } else {
          pGrad.addColorStop(0, '#090c12');
          pGrad.addColorStop(0.5, '#131823');
          pGrad.addColorStop(1, '#07090e');
        }

        ctx.beginPath();
        ctx.moveTo(outerTopX, roofYEdge - 4);
        ctx.lineTo(innerTopX, roofYEdge - 4);
        ctx.lineTo(innerBotX, dashShoulderY + 2);
        ctx.lineTo(outerBotX, dashCornerY + 2);
        ctx.closePath();
        ctx.fillStyle = pGrad;
        ctx.fill();

        // Crisp weather-stripping highlights separating A-pillar from windshield & side-window glass
        ctx.beginPath();
        ctx.moveTo(outerTopX, roofYEdge - 2);
        ctx.lineTo(outerBotX, dashCornerY + 1);
        ctx.moveTo(innerTopX, roofYEdge - 2);
        ctx.lineTo(innerBotX, dashShoulderY + 1);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.lineWidth = Math.max(1.2, 1.6 * scale);
        ctx.stroke();
      };

      drawAPillar(pillarOuterTopX, pillarInnerTopX, pillarInnerBotX, pillarOuterBotX, true);
      drawAPillar(
        w - pillarOuterTopX,
        w - pillarInnerTopX,
        w - pillarInnerBotX,
        w - pillarOuterBotX,
        false
      );

      // Continuous upper roof rubber gasket sealing ceiling across side windows & windshield
      ctx.beginPath();
      ctx.moveTo(outerEdgeW, roofYEdge);
      ctx.quadraticCurveTo(w * 0.06, roofYEdge - 0.004 * h, pillarInnerTopX, roofYEdge);
      ctx.quadraticCurveTo(cx, roofYMid - 0.008 * h, w - pillarInnerTopX, roofYEdge);
      ctx.quadraticCurveTo(w * 0.94, roofYEdge - 0.004 * h, w - outerEdgeW, roofYEdge);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = Math.max(1.2, 1.8 * scale);
      ctx.stroke();

      // Compact center windshield sensor housing / rearview pod anchored to solid ceiling frame
      const podHalfTop = isPortrait ? w * 0.095 : w * 0.068;
      const podHalfBot = isPortrait ? w * 0.072 : w * 0.052;
      const podBotY = isPortrait ? h * 0.052 : h * 0.072;
      const podApexY = isPortrait ? h * 0.058 : h * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx - podHalfTop, roofYMid - 0.004 * h);
      ctx.lineTo(cx - podHalfBot, podBotY);
      ctx.quadraticCurveTo(cx, podApexY, cx + podHalfBot, podBotY);
      ctx.lineTo(cx + podHalfTop, roofYMid - 0.004 * h);
      ctx.closePath();
      ctx.fillStyle = '#07090e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = Math.max(1, 1.2 * scale);
      ctx.stroke();

      // Steering column shroud emerging cleanly out of the binnacle behind the wheel
      const shroudTopY = wheelCy - wheelR * 0.18;
      const shroudH = isPortrait
        ? Math.max(24, screenLayout.left.y - shroudTopY - 6 * scale)
        : h - shroudTopY + wheelR * 0.02;
      ctx.beginPath();
      ctx.roundRect(cx - wheelR * 0.34, shroudTopY, wheelR * 0.68, shroudH, 8 * scale);
      ctx.fillStyle = '#06080d';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = Math.max(1, 1.2 * scale);
      ctx.stroke();

      // Judgement, Timing Offset (ms) & Combo HUD in open binnacle space directly below hit line
      if (inputOverlayVisible) {
        const lastHud = curJudgementHudRef?.current;
        if (lastHud) {
          const age = performance.now() - lastHud.atMs;
          if (age < 700) {
            const alpha = Math.max(0, 1 - Math.max(0, age - 450) / 250);
            const meta = HIGHWAY_TIER_META[lastHud.tier];
            const jScale = Math.max(0.85, Math.min(2.4, Math.min(w, h) / 460));
            const labelY = isPortrait ? h * 0.588 : h * 0.65;
            const msY = isPortrait ? h * 0.612 : h * 0.682;
            const comboY = isPortrait ? h * 0.635 : h * 0.713;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.font = `bold ${Math.round(13.5 * jScale)}px monospace`;
            ctx.lineWidth = Math.max(2.5, 3.2 * jScale);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
            ctx.strokeText(meta.label, cx, labelY);
            ctx.fillStyle = meta.color;
            ctx.fillText(meta.label, cx, labelY);

            if (lastHud.offsetMs !== null) {
              const errStr =
                lastHud.offsetMs === 0
                  ? '0ms'
                  : `${lastHud.offsetMs > 0 ? '+' : ''}${lastHud.offsetMs}ms`;
              ctx.font = `bold ${Math.round(9.5 * jScale)}px monospace`;
              ctx.lineWidth = Math.max(2, 2.4 * jScale);
              ctx.strokeText(errStr, cx, msY);
              ctx.fillStyle =
                lastHud.offsetMs < 0 ? '#7dd3fc' : lastHud.offsetMs > 0 ? '#fcd34d' : '#ffffff';
              ctx.fillText(errStr, cx, msY);
            }

            if (lastHud.combo >= 2) {
              const comboText = `${lastHud.combo} COMBO`;
              ctx.font = `bold ${Math.round(11 * jScale)}px monospace`;
              ctx.lineWidth = Math.max(2, 2.8 * jScale);
              ctx.strokeText(comboText, cx, comboY);
              ctx.fillStyle = '#ffffff';
              ctx.fillText(comboText, cx, comboY);
            }
            ctx.restore();
          }
        }
      }

      // 3. Static Bezel Orientation Arc Marks (-90°..+90° rail + -45° L, 0° &, +45° R reference ticks behind wheel)
      const arcR = wheelR * 1.16;
      ctx.save();
      ctx.translate(cx, wheelCy);
      ctx.beginPath();
      ctx.arc(0, 0, arcR, -Math.PI, 0);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
      ctx.lineWidth = Math.max(1, 1.5 * scale);
      ctx.stroke();

      // Reference ticks at -45°, 0°, +45°
      const refAngles = [
        { deg: -45, active: target.step.baseAngleDeg < -1 },
        { deg: 0, active: Math.abs(target.step.baseAngleDeg) <= 1 },
        { deg: 45, active: target.step.baseAngleDeg > 1 },
      ];
      for (const ref of refAngles) {
        const rad = ((ref.deg - 90) * Math.PI) / 180;
        const x0 = Math.cos(rad) * (arcR - 5 * scale);
        const y0 = Math.sin(rad) * (arcR - 5 * scale);
        const x1 = Math.cos(rad) * (arcR + 7 * scale);
        const y1 = Math.sin(rad) * (arcR + 7 * scale);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = ref.active
          ? 'rgba(52, 211, 153, 0.85)'
          : 'rgba(148, 163, 184, 0.3)';
        ctx.lineWidth = ref.active ? 2.5 * scale : 1.5 * scale;
        ctx.stroke();
      }

      // Target ghost dot chasing outside rim (peak-hold cue)
      const targetRad = ((target.targetAngleDeg - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(
        Math.cos(targetRad) * arcR,
        Math.sin(targetRad) * arcR,
        3.2 * scale,
        0,
        Math.PI * 2
      );
      ctx.fillStyle =
        tomG > 0.3
          ? `rgba(236, 72, 153, ${0.55 + tomG * 0.45})`
          : kickG > 0.3
          ? `rgba(245, 158, 11, ${0.55 + kickG * 0.45})`
          : 'rgba(16, 185, 129, 0.72)';
      ctx.fill();
      ctx.restore();

      // 4. Sculpted Spaceship U-Yoke Flight Control Wheel (open top silhouette tracking smoothed visualAngleDeg)
      const visualRad = (motion.visualAngleDeg * Math.PI) / 180;
      const wheelBreathScale = 1 + kickG * 0.022;

      ctx.save();
      ctx.translate(cx, wheelCy);
      ctx.scale(wheelBreathScale, wheelBreathScale);
      ctx.rotate(visualRad);

      const rimThickness = Math.max(14, 21 * scale);
      const uStartAngle = -0.10 * Math.PI; // upper-right shoulder (~2:30)
      const uEndAngle = Math.PI + 0.10 * Math.PI; // upper-left shoulder (~9:30)
      const hornTipX = wheelR * 0.82;
      const hornTipY = -wheelR * 0.62;

      const traceUYokePath = () => {
        ctx.beginPath();
        ctx.moveTo(hornTipX, hornTipY);
        ctx.lineTo(Math.cos(uStartAngle) * wheelR, Math.sin(uStartAngle) * wheelR);
        ctx.arc(0, 0, wheelR, uStartAngle, uEndAngle, false);
        ctx.lineTo(-hornTipX, hornTipY);
      };

      const bandColor =
        tomG > 0.35
          ? '#ec4899'
          : kickG > 0.32
          ? '#f59e0b'
          : snareG > 0.28
          ? '#34d399'
          : '#38bdf8';

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Soft cockpit drop shadow behind U-yoke
      ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
      ctx.shadowBlur = 18 * scale;

      // Machined metallic outer bevel casing around the entire U-yoke & horn grips
      traceUYokePath();
      ctx.strokeStyle = `rgba(148, 163, 184, ${0.18 + snareG * 0.2})`;
      ctx.lineWidth = rimThickness + 3 * scale;
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Primary matte obsidian spaceship yoke grip body
      traceUYokePath();
      ctx.strokeStyle = '#090b11';
      ctx.lineWidth = rimThickness;
      ctx.stroke();

      // Recessed glowing rhythm edge channel along the inner lower U-arc
      ctx.beginPath();
      ctx.arc(0, 0, wheelR - rimThickness * 0.34, uStartAngle + 0.12, uEndAngle - 0.12, false);
      ctx.strokeStyle =
        tomG > 0.3
          ? `rgba(236, 72, 153, ${0.28 + tomG * 0.65})`
          : kickG > 0.25
          ? `rgba(245, 158, 11, ${0.24 + kickG * 0.6})`
          : snareG > 0.25
          ? `rgba(52, 211, 153, ${0.24 + snareG * 0.6})`
          : 'rgba(56, 189, 248, 0.18)';
      ctx.lineWidth = Math.max(1.2, 2 * scale);
      ctx.stroke();

      // Structural yoke crossbar arms & bottom column spine
      const drawSpoke = (angleRad: number, widthPx: number) => {
        ctx.save();
        ctx.rotate(angleRad);
        ctx.beginPath();
        ctx.moveTo(-widthPx * 0.72, wheelR * 0.22);
        ctx.lineTo(-widthPx * 0.45, wheelR * 0.94);
        ctx.lineTo(widthPx * 0.45, wheelR * 0.94);
        ctx.lineTo(widthPx * 0.72, wheelR * 0.22);
        ctx.closePath();
        ctx.fillStyle = '#0c0f16';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      };
      drawSpoke(Math.PI * 0.48, 18 * scale);
      drawSpoke(-Math.PI * 0.48, 18 * scale);
      drawSpoke(0, 15 * scale); // bottom spine (+Y)

      // Center obsidian floating flight hub
      const hubR = wheelR * 0.27;
      ctx.beginPath();
      ctx.arc(0, 0, hubR, 0, Math.PI * 2);
      ctx.fillStyle = '#07090e';
      ctx.fill();
      ctx.strokeStyle = `rgba(148, 163, 184, ${0.2 + snareG * 0.45})`;
      ctx.lineWidth = Math.max(1.2, 1.8 * scale);
      ctx.stroke();

      // Core beat telemetry ring inside center hub + upright flight-vector pointer tick
      ctx.beginPath();
      ctx.arc(0, 0, hubR * (0.48 + snareG * 0.16), 0, Math.PI * 2);
      ctx.strokeStyle =
        snareG > 0.2
          ? `rgba(52, 211, 153, ${0.35 + snareG * 0.65})`
          : kickG > 0.2
          ? `rgba(245, 158, 11, ${0.3 + kickG * 0.6})`
          : 'rgba(148, 163, 184, 0.24)';
      ctx.lineWidth = Math.max(1.5, 2.5 * scale);
      ctx.stroke();

      // Upright orientation pointer crest at top of center hub (gives instant 0°/-45°/+45° reference!)
      ctx.beginPath();
      ctx.moveTo(0, -hubR * 0.95);
      ctx.lineTo(0, -hubR * 0.56);
      ctx.strokeStyle = bandColor;
      ctx.lineWidth = Math.max(2.2, 3.2 * scale);
      ctx.stroke();

      // Twin luminous horn-tip sight accents on left & right spaceship grip ends
      const drawHornLed = (sign: -1 | 1) => {
        ctx.beginPath();
        ctx.moveTo(sign * hornTipX, hornTipY);
        ctx.lineTo(
          sign * (hornTipX * 0.96 + Math.cos(uStartAngle) * wheelR * 0.05),
          hornTipY + (Math.sin(uStartAngle) * wheelR - hornTipY) * 0.26
        );
        ctx.strokeStyle = bandColor;
        ctx.lineWidth = rimThickness * 0.42;
        ctx.stroke();
      };
      drawHornLed(-1);
      drawHornLed(1);

      // Subtle machined thumb grip inlays along the vertical sides of the U-yoke
      ctx.beginPath();
      ctx.arc(0, 0, wheelR - rimThickness * 0.14, Math.PI - 0.18, Math.PI + 0.18);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.16 + kickG * 0.45})`;
      ctx.lineWidth = 2.4 * scale;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, wheelR - rimThickness * 0.14, -0.18, 0.18);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.16 + kickG * 0.45})`;
      ctx.lineWidth = 2.4 * scale;
      ctx.stroke();

      ctx.restore();
    };

    const drawExportDashboardDisplays = (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      target: BodyLanguageTarget,
      motion: WheelMotionState,
      activePreset: WindshieldPreset,
      curDiff: ChartDifficulty,
      curSimMode: SimSoundMode,
      curScore: ScreensaverScoreSummary | undefined
    ) => {
      const pMeta = PERSONA_META[curDiff] || {
        name: getPersonaForDifficulty(curDiff),
        diffLabel: curDiff.charAt(0).toUpperCase() + curDiff.slice(1),
        textClass: 'text-emerald-300',
        accentHex: '#34d399',
      };
      const screenLayout = getCockpitScreenLayout(w, h);
      const fs = Math.min(screenLayout.left.w / 196, screenLayout.left.h / 104) * 16;

      // Left Dashboard Telemetry Screen
      const lx = screenLayout.left.x;
      const ly = screenLayout.left.y;
      const lw = screenLayout.left.w;
      const lh = screenLayout.left.h;
      const lpx = fs * 0.625;
      const lpy = fs * 0.5;
      const barNum = Math.max(1, target.meter.barIndex + 1);
      const barDisp = String(barNum).padStart(2, '0');
      const deg = Math.round(motion.visualAngleDeg);
      const symColor =
        target.step.symbol === 'L'
          ? '#7dd3fc'
          : target.step.symbol === 'R'
          ? '#fcd34d'
          : '#6ee7b7';

      ctx.save();
      if (showInputHighwayRef.current && curScore) {
        // Row 1: Demotest/Playtest Score + Current Difficulty
        const isDemo = curSimMode === 'demo';
        ctx.font = `700 ${Math.round(fs * 0.55)}px monospace`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = isDemo ? '#6ee7b7' : '#d1d5db';
        ctx.fillText(isDemo ? 'Demotest Score' : 'Playtest Score', lx + lpx, ly + lpy);

        ctx.textAlign = 'right';
        ctx.fillStyle = pMeta.accentHex;
        ctx.fillText(`${pMeta.diffLabel} Difficulty`, lx + lw - lpx, ly + lpy);

        // Row 2: Accu % / Combo / Max (Bar A/B omitted during game)
        const midY = ly + lpy + fs * 1.15;
        ctx.font = `700 ${Math.round(fs * 0.58)}px monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#34d399';
        ctx.fillText(`Accu ${curScore.accuracy.toFixed(1)}%`, lx + lpx, midY);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`Combo ${curScore.combo}`, lx + lw * 0.6, midY);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#fcd34d';
        ctx.fillText(`Max ${curScore.maxCombo}`, lx + lw - lpx, midY);

        // Bottom 2x3 Judgement Counts Grid
        const countsGridTop = ly + lh - lpy - fs * 1.9;
        const cells = [
          { k: 'MARV', v: curScore.counts.marvelous, c: '#67e8f9' },
          { k: 'PERF', v: curScore.counts.perfect, c: '#fde047' },
          { k: 'GREAT', v: curScore.counts.great, c: '#34d399' },
          { k: 'GOOD', v: curScore.counts.good, c: '#38bdf8' },
          { k: 'BOO', v: curScore.counts.boo, c: '#c084fc' },
          { k: 'MISS', v: curScore.counts.miss, c: '#f87171' },
        ];
        const colW = (lw - lpx * 2 - fs * 0.6) / 3;
        ctx.font = `600 ${Math.round(fs * 0.6)}px monospace`;
        cells.forEach((cell, idx) => {
          const col = idx % 3;
          const row = Math.floor(idx / 3);
          const cx0 = lx + lpx + col * (colW + fs * 0.3);
          const cy0 = countsGridTop + row * (fs * 0.98);
          ctx.textAlign = 'left';
          ctx.fillStyle = cell.c;
          ctx.fillText(cell.k, cx0, cy0);
          ctx.textAlign = 'right';
          ctx.fillStyle = '#e5e7eb';
          ctx.fillText(String(cell.v), cx0 + colW, cy0);
        });
      } else {
        ctx.font = `700 ${Math.round(fs * 0.6875)}px monospace`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = pMeta.accentHex;
        ctx.fillText(pMeta.name.toUpperCase(), lx + lpx, ly + lpy);

        ctx.font = `500 ${Math.round(fs * 0.6875)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#d1d5db';
        ctx.fillText(`B${barDisp}·${target.meter.beatInBar}`, lx + lw * 0.52, ly + lpy);

        ctx.font = `700 ${Math.round(fs * 0.6875)}px monospace`;
        ctx.fillStyle = symColor;
        ctx.fillText(target.meter.inSongBounds ? target.step.symbol : 'IDLE', lx + lw * 0.75, ly + lpy);

        ctx.font = `500 ${Math.round(fs * 0.6875)}px monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#9ca3af';
        ctx.fillText(`${deg > 0 ? `+${deg}` : deg}°`, lx + lw - lpx, ly + lpy);

        // Middle Bar A/B label (clean, without Pink Panther text)
        const subY = ly + lh * 0.38;
        ctx.font = `500 ${Math.round(fs * 0.625)}px monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = '#6b7280';
        ctx.fillText(`BAR ${target.step.barParity}`, lx + lw - lpx, subY);

        // Bottom 8-step pattern grid
        const gridGap = fs * 0.125;
        const cellW = (lw - lpx * 2 - gridGap * 7) / 8;
        const cellH = fs * 1.1;
        const gridY = ly + lh - lpy - cellH;
        ctx.font = `700 ${Math.round(fs * 0.6875)}px monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        for (let i = 0; i < 8; i++) {
          const cx = lx + lpx + i * (cellW + gridGap);
          const isActive = target.meter.inSongBounds && i === target.step.stepInBar;
          const isComp = i >= 6;
          ctx.beginPath();
          ctx.roundRect(cx, gridY, cellW, cellH, fs * 0.15);
          ctx.fillStyle = isActive
            ? '#10b981'
            : isComp
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(255, 255, 255, 0.03)';
          ctx.fill();
          ctx.fillStyle = isActive
            ? '#030712'
            : isComp
            ? 'rgba(244, 114, 182, 0.85)'
            : '#9ca3af';
          ctx.fillText(target.step.pattern[i], cx + cellW * 0.5, gridY + cellH * 0.5);
        }
      }

      // Right Dashboard Infotainment Bay
      const rx = screenLayout.right.x;
      const ry = screenLayout.right.y;
      const rw = screenLayout.right.w;
      const rh = screenLayout.right.h;
      const rpx = fs * 0.625;
      const rpy = fs * 0.5;
      const iconColW = fs * 1.65;
      const presetAreaW = rw - rpx * 2 - fs * 0.375 - iconColW;
      const pGap = fs * 0.25;
      const tileW = (presetAreaW - pGap) / 2;
      const tileH = fs * 1.15;

      ctx.font = `600 ${Math.round(fs * 0.6875)}px monospace`;
      ctx.textBaseline = 'middle';
      PRESETS.forEach((p, idx) => {
        const col = idx % 2;
        const row = Math.floor(idx / 2);
        const px = rx + rpx + col * (tileW + pGap);
        const py = ry + rpy + row * (tileH + pGap);
        const isOn = activePreset === p.id;
        ctx.beginPath();
        ctx.roundRect(px, py, tileW, tileH, fs * 0.2);
        ctx.fillStyle = isOn ? '#10b981' : 'rgba(255, 255, 255, 0.04)';
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = isOn ? '#030712' : '#d1d5db';
        ctx.fillText(`${p.keyNum} ${p.label}`, px + fs * 0.35, py + tileH * 0.5);
      });

      // Active simulation mode & resolution badge on right column
      const badgeX = rx + rw - rpx - iconColW;
      ctx.beginPath();
      ctx.roundRect(badgeX, ry + rpy, iconColW, tileH, fs * 0.2);
      ctx.fillStyle =
        curSimMode === 'demo'
          ? 'rgba(16, 185, 129, 0.18)'
          : curSimMode === 'input'
          ? 'rgba(244, 63, 94, 0.2)'
          : 'rgba(56, 189, 248, 0.18)';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = `700 ${Math.round(fs * 0.52)}px monospace`;
      ctx.fillStyle =
        curSimMode === 'demo' ? '#6ee7b7' : curSimMode === 'input' ? '#fda4af' : '#7dd3fc';
      ctx.fillText(curSimMode.toUpperCase(), badgeX + iconColW * 0.5, ry + rpy + tileH * 0.5);

      ctx.beginPath();
      ctx.roundRect(badgeX, ry + rpy + tileH + pGap, iconColW, tileH, fs * 0.2);
      ctx.fillStyle = showInputHighwayRef.current ? '#10b981' : 'rgba(255, 255, 255, 0.04)';
      ctx.fill();
      ctx.fillStyle = showInputHighwayRef.current ? '#030712' : '#9ca3af';
      ctx.fillText(`${Math.min(w, h)}p`, badgeX + iconColW * 0.5, ry + rpy + tileH + pGap + tileH * 0.5);

      // Bottom K / S / T Impulse Meters
      const stripTop = ry + rh - rpy - fs * 0.9;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx + rpx, stripTop);
      ctx.lineTo(rx + rw - rpx, stripTop);
      ctx.stroke();

      const meterY = stripTop + fs * 0.55;
      const meters = [
        { label: 'K', val: target.impulses.kick, color: '#fbbf24' },
        { label: 'S', val: target.impulses.snare, color: '#34d399' },
        { label: 'T', val: target.impulses.tom, color: '#f472b6' },
      ];
      const slotW = (rw - rpx * 2 - fs * 1.0) / 3;
      ctx.font = `600 ${Math.round(fs * 0.625)}px monospace`;
      meters.forEach((m, idx) => {
        const mx = rx + rpx + idx * (slotW + fs * 0.5);
        ctx.textAlign = 'left';
        ctx.fillStyle = m.color;
        ctx.fillText(m.label, mx, meterY);
        const barX = mx + fs * 0.65;
        const barW = Math.max(8, slotW - fs * 0.65);
        const barH = fs * 0.375;
        ctx.beginPath();
        ctx.roundRect(barX, meterY - barH * 0.5, barW, barH, fs * 0.1);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fill();
        if (m.val > 0.01) {
          ctx.beginPath();
          ctx.roundRect(barX, meterY - barH * 0.5, barW * Math.min(1, m.val), barH, fs * 0.1);
          ctx.fillStyle = m.color;
          ctx.fill();
        }
      });

      ctx.restore();
    };

    const tick = (nowMs: number) => {
      const dtSec = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
      lastFrameMs = nowMs;

      resizeCanvases();

      const {
        sync: curSync,
        sections: curSections,
        isPlaying: playing,
        songDurationSec: curDur,
        drumEvents: curEvents,
        tomBandSet: curToms,
        difficulty: curDiff,
        pinkPantherPct: curPinkPct,
        percussionPct: curPercPct,
        snareCounterKick: curSnareCounter,
        simpleBarOrientation: curSimpleBar,
        simSoundMode: curSimMode,
        simSoundEnabled: curSimEnabled,
        pressedLanesRef: curPressedRef,
        judgedNotesRef: curJudgedRef,
        lastJudgementHudRef: curJudgementHudRef,
        playerInputTriggersRef: curPlayerTriggersRef,
        playScoreRef: curPlayScoreRef,
        onPlaybackTick: curOnPlaybackTick,
        onWebmExportStateChange: curOnExportState,
      } = propsRef.current;

      const playingNow = playing || engine.getIsPlaying();

      // Keep smooth ambient drift even when paused; advance deterministically on audio clock when playing
      visualTimeAcc += playingNow ? dtSec : dtSec * 0.32;

      let currentTime = engine.getCurrentTime();
      const buffer = engine.getBuffer();
      const loopDur = buffer && engine.getLoop() ? buffer.duration : curDur;
      if (buffer && engine.getLoop()) {
        currentTime = currentTime % buffer.duration;
      }

      curOnPlaybackTick?.(currentTime);

      const inputNowSec = performance.now() / 1000;
      let activePlayerTriggers = curPlayerTriggersRef?.current;
      if (curSimMode === 'input' && activePlayerTriggers && activePlayerTriggers.length > 0) {
        if (inputNowSec - activePlayerTriggers[0].wallTimeSec > 1.2) {
          activePlayerTriggers = activePlayerTriggers.filter((t) => inputNowSec - t.wallTimeSec <= 1.2);
          curPlayerTriggersRef.current = activePlayerTriggers;
        }
      }

      const target = evaluateRhythmBodyLanguage({
        currentTime,
        sync: curSync,
        songDurationSec: curDur,
        drumEvents: curEvents,
        tomBandSet: curToms,
        difficulty: curDiff,
        sections: curSections,
        loopDurationSec: loopDur,
        pinkPantherScale: curPinkPct / 100,
        percussionScale: curPercPct / 100,
        snareCounterKick: curSnareCounter,
        simpleBarOrientation: curSimpleBar,
        useInputTriggers: curSimMode === 'input',
        inputTriggers: activePlayerTriggers,
        inputNowSec,
      });

      motionState = stepWheelMotionState(motionState, target, dtSec);

      // Auto-switch preset cleanly when crossing into a section with an assigned preset (or seeking/looping)
      const beatFloatNow = target.meter.beatFloat;
      const prevBeat = prevAutoBeatRef.current;
      prevAutoBeatRef.current = beatFloatNow;
      const didJumpOrLoop = prevBeat !== null && Math.abs(beatFloatNow - prevBeat) > 0.35;
      if (didJumpOrLoop) {
        lastAutoSectionKeyRef.current = null;
      }

      const curSortedSections = propsRef.current.sortedSections;
      let activeSection: Section | null = null;
      if (curSortedSections.length > 0) {
        if (beatFloatNow < curSortedSections[0].beat - 1e-4) {
          if (curSortedSections[0].beat <= 0 && beatFloatNow >= -4) {
            activeSection = curSortedSections[0];
          }
        } else {
          for (let si = curSortedSections.length - 1; si >= 0; si--) {
            if (curSortedSections[si].beat <= beatFloatNow + 1e-4) {
              activeSection = curSortedSections[si];
              break;
            }
          }
        }
      }

      if ((playingNow || didJumpOrLoop) && activeSection) {
        const secKey = `${activeSection.id}:${activeSection.preset ?? ''}`;
        if (lastAutoSectionKeyRef.current !== secKey) {
          lastAutoSectionKeyRef.current = secKey;
          if (activeSection.preset && activeSection.preset !== presetRef.current) {
            presetRef.current = activeSection.preset;
            setPreset(activeSection.preset);
          }
        }
      } else if (!activeSection) {
        lastAutoSectionKeyRef.current = null;
      }

      const activePreset = presetRef.current;
      const w = bgCanvas.width;
      const h = bgCanvas.height;

      // Sample live audio waveform (60fps) and FFT spectrum history (32ms steps) when playing
      const analyser = engine.getAnalyser('output');
      if (analyser && playingNow) {
        const binCount = analyser.frequencyBinCount;
        if (!timeData || timeData.length !== analyser.fftSize) {
          timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        }
        analyser.getByteTimeDomainData(timeData);
        const timeStep = timeData.length / SPEC_HALF_COLS;
        for (let i = 0; i < SPEC_HALF_COLS; i++) {
          const sampleIdx = Math.min(timeData.length - 1, Math.floor(i * timeStep));
          liveWaveValues[i] = (timeData[sampleIdx] - 128) / 128;
        }

        if (nowMs - lastHistoryPushMs >= 32) {
          lastHistoryPushMs = nowMs;
          if (!freqData || freqData.length !== binCount) {
            freqData = new Uint8Array(new ArrayBuffer(binCount));
          }
          analyser.getByteFrequencyData(freqData);
          const sampleRate = engine.getSampleRate();
          const hzPerBin = sampleRate / (binCount * 2);

          for (let i = 0; i < SPEC_HALF_COLS; i++) {
            const f0 = Math.exp(SPEC_LOG_MIN + (i / SPEC_HALF_COLS) * (SPEC_LOG_MAX - SPEC_LOG_MIN));
            const f1 = Math.exp(SPEC_LOG_MIN + ((i + 1) / SPEC_HALF_COLS) * (SPEC_LOG_MAX - SPEC_LOG_MIN));
            const b0 = Math.max(1, Math.floor(f0 / hzPerBin));
            const b1 = Math.min(binCount - 1, Math.max(b0, Math.ceil(f1 / hzPerBin)));

            let peak = 0;
            for (let b = b0; b <= b1; b++) {
              const v = freqData[b] / 255;
              if (v > peak) peak = v;
            }
            liveColValues[i] = peak;
          }

          terrainHistory.push(new Float32Array(liveColValues));
          if (terrainHistory.length > SPEC_HISTORY_ROWS) {
            terrainHistory.shift();
          }
        }
      }

      if (activePreset !== prevRenderedPreset) {
        rainCtx.clearRect(0, 0, w, h);
        prevRenderedPreset = activePreset;
      }

      // Render Windshield Layer
      if (activePreset === 'music-rain') {
        drawMusicRain(rainCtx, w, h, dtSec, target, visualTimeAcc);
      } else {
        const shaderProg = !glContextLost && gl ? glPrograms[activePreset] : undefined;
        if (gl && shaderProg && quadVao) {
          gl.viewport(0, 0, w, h);
          gl.useProgram(shaderProg);
          gl.bindVertexArray(quadVao);

          const uRes = gl.getUniformLocation(shaderProg, 'uRes');
          const uTime = gl.getUniformLocation(shaderProg, 'uTime');
          const uBeatFloat = gl.getUniformLocation(shaderProg, 'uBeatFloat');
          const uBeatPhase = gl.getUniformLocation(shaderProg, 'uBeatPhase');
          const uBarPhase = gl.getUniformLocation(shaderProg, 'uBarPhase');
          const uPhrasePhase = gl.getUniformLocation(shaderProg, 'uPhrasePhase');
          const uKick = gl.getUniformLocation(shaderProg, 'uKick');
          const uSnare = gl.getUniformLocation(shaderProg, 'uSnare');
          const uTom = gl.getUniformLocation(shaderProg, 'uTom');
          const uHat = gl.getUniformLocation(shaderProg, 'uHat');
          const uHatDir = gl.getUniformLocation(shaderProg, 'uHatDir');
          const uEnergy = gl.getUniformLocation(shaderProg, 'uEnergy');
          const uPersonaScale = gl.getUniformLocation(shaderProg, 'uPersonaScale');

          const pScale = curDiff === 'easy' ? 0.72 : curDiff === 'normal' ? 1.0 : 1.32;

          if (uRes) gl.uniform2f(uRes, w, h);
          if (uTime) gl.uniform1f(uTime, visualTimeAcc);
          if (uBeatFloat) gl.uniform1f(uBeatFloat, target.meter.beatFloat);
          if (uBeatPhase) gl.uniform1f(uBeatPhase, target.meter.beatPhase);
          if (uBarPhase) gl.uniform1f(uBarPhase, (target.meter.beatFloat % 4) / 4);
          if (uPhrasePhase) gl.uniform1f(uPhrasePhase, (target.meter.beatFloat % 16) / 16);
          if (uKick) gl.uniform1f(uKick, target.impulses.kick);
          if (uSnare) gl.uniform1f(uSnare, target.impulses.snare);
          if (uTom) gl.uniform1f(uTom, target.impulses.tom);
          if (uHat) gl.uniform1f(uHat, target.impulses.hat);
          if (uHatDir) gl.uniform1f(uHatDir, target.impulses.hatParity === 'A' ? 1.0 : -1.0);
          if (uEnergy) gl.uniform1f(uEnergy, target.impulses.totalEnergy);
          if (uPersonaScale) gl.uniform1f(uPersonaScale, pScale);

          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindVertexArray(null);

          if (activePreset === 'glsl-space') {
            rainCtx.clearRect(0, 0, w, h);
            drawMirroredSpectrumTerrain(rainCtx, w, h);
          } else if (activePreset === 'wormhole') {
            rainCtx.clearRect(0, 0, w, h);
            drawWormholeDotMatrix(rainCtx, w, h, target, visualTimeAcc);
          } else if (activePreset === 'milkdrop') {
            drawMilkdropDotMatrix(rainCtx, w, h, target, visualTimeAcc, true);
          }
        } else {
          // Graceful 2D fallback rendering into rainCtx when WebGL2 is unavailable
          draw2DFallbackPreset(rainCtx, w, h, activePreset, target);
          if (activePreset === 'glsl-space') {
            drawMirroredSpectrumTerrain(rainCtx, w, h);
          } else if (activePreset === 'wormhole') {
            drawWormholeDotMatrix(rainCtx, w, h, target, visualTimeAcc);
          } else if (activePreset === 'milkdrop') {
            drawMilkdropDotMatrix(rainCtx, w, h, target, visualTimeAcc, false);
          }
        }
      }

      // Render Foreground Futuristic Cockpit + Wheel + Optional Input Arrow Highway
      drawFuturisticCockpit(
        cockpitCtx,
        w,
        h,
        target,
        motionState,
        currentTime,
        playingNow,
        curEvents,
        curToms,
        curSimMode,
        curSimEnabled,
        curPressedRef,
        curJudgedRef,
        curJudgementHudRef,
        showInputHighwayRef.current
      );

      // Composite configured WxH WebM frame (WebGL + 2D overlay + Cockpit + Dashboard Screens) once recording starts
      const exportSess = exportSessionRef.current;
      if (exportSess?.active && !exportSess.armed) {
        if (exportSess.clearTerrainOnStart) {
          terrainHistory.length = 0;
          liveColValues.fill(0);
          liveWaveValues.fill(0);
          rainCtx.clearRect(0, 0, w, h);
          exportSess.clearTerrainOnStart = false;
        }
        const expCanvas = exportCanvasRef.current;
        if (expCanvas) {
          const expCtx = expCanvas.getContext('2d', { alpha: false });
          if (expCtx) {
            const expW = exportSess.width;
            const expH = exportSess.height;
            expCtx.fillStyle = '#04060b';
            expCtx.fillRect(0, 0, expW, expH);

            if (activePreset !== 'music-rain' && !glContextLost && !glFallbackRef.current) {
              expCtx.drawImage(bgCanvas, 0, 0, expW, expH);
            }
            if (
              activePreset === 'music-rain' ||
              activePreset === 'glsl-space' ||
              activePreset === 'wormhole' ||
              activePreset === 'milkdrop' ||
              glContextLost ||
              glFallbackRef.current
            ) {
              expCtx.drawImage(rainCanvas, 0, 0, expW, expH);
            }
            expCtx.drawImage(cockpitCanvas, 0, 0, expW, expH);
            drawExportDashboardDisplays(
              expCtx,
              expW,
              expH,
              target,
              motionState,
              activePreset,
              curDiff,
              curSimMode,
              curPlayScoreRef?.current
            );
          }
        }

        if (!exportSess.finishing && exportSess.startedPlaybackAtMs > 0) {
          const elapsed = Math.min(exportSess.durationSec, Math.max(0, currentTime));
          if (nowMs - exportSess.lastProgressUiMs > 180) {
            exportSess.lastProgressUiMs = nowMs;
            curOnExportState?.({
              status: 'recording',
              elapsedSec: elapsed,
              durationSec: exportSess.durationSec,
              error: null,
              lastFileName: null,
            });
          }

          const pastGraceWindow = performance.now() - exportSess.startedPlaybackAtMs > 300;
          const reachedEnd =
            exportSess.durationSec > 0 && currentTime >= exportSess.durationSec - 0.035;
          const stoppedNaturally = pastGraceWindow && !engine.getIsPlaying();

          if (reachedEnd || stoppedNaturally) {
            exportSess.finishing = true;
            curOnExportState?.({
              status: 'finalizing',
              elapsedSec: exportSess.durationSec,
              durationSec: exportSess.durationSec,
              error: null,
              lastFileName: null,
            });
            exportSess.finishTimerId = window.setTimeout(() => {
              const s = exportSessionRef.current;
              if (s?.recorder && s.recorder.state !== 'inactive') {
                s.recorder.stop();
              }
            }, 180);
          }
        }
      }

      // Update lightweight React DOM HUD at ~15fps
      if (nowMs - lastHudUpdateMs > 66) {
        lastHudUpdateMs = nowMs;
        const barNum = Math.max(1, target.meter.barIndex + 1);
        setHudReadout({
          barDisplay: String(barNum).padStart(2, '0'),
          beatDisplay: `${target.meter.beatInBar}${target.meter.isAnd ? '&' : ' '}`,
          symbol: target.step.symbol,
          stepInBar: target.step.stepInBar,
          barParity: target.step.barParity,
          pattern: target.step.pattern,
          inSongBounds: target.meter.inSongBounds,
          kick: target.impulses.kick,
          snare: target.impulses.snare,
          tom: target.impulses.tom,
          hatA: target.impulses.hatA,
          hatB: target.impulses.hatB,
          visualDeg: Math.round(motionState.visualAngleDeg),
        });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      const sess = exportSessionRef.current;
      if (sess?.active) {
        sess.cancelled = true;
        sess.armed = false;
        if (sess.finishTimerId !== null) {
          window.clearTimeout(sess.finishTimerId);
          sess.finishTimerId = null;
        }
        if (sess.recorder && sess.recorder.state !== 'inactive') {
          sess.recorder.stop();
        } else {
          sess.active = false;
          exportSessionRef.current = null;
          engine.setLoop(sess.prevLoop);
        }
      }
      bgCanvas.removeEventListener('webglcontextlost', handleContextLost);
      bgCanvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (gl) {
        Object.values(glPrograms).forEach((p) => {
          if (p) gl?.deleteProgram(p);
        });
        if (quadVbo) gl.deleteBuffer(quadVbo);
        if (quadVao) gl.deleteVertexArray(quadVao);
      }
    };
  }, []);

  // Wire imperative configurable WxH WebM export handle (preserves active mode + waits for Space to begin)
  useEffect(() => {
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

    const handle: ScreensaverExportHandle = {
      startDemoWebmExport: async (options) => {
        const {
          songDurationSec: propDur,
          sortedSections: curSorted,
          onBeforeDemoExportStart: beforeStart,
          onWebmExportStateChange: setState,
          exportWidth: curExportW,
          exportHeight: curExportH,
        } = propsRef.current;

        if (exportSessionRef.current?.active) return;

        if (
          typeof MediaRecorder === 'undefined' ||
          typeof HTMLCanvasElement.prototype.captureStream !== 'function'
        ) {
          setState?.({
            status: 'idle',
            elapsedSec: 0,
            durationSec: 0,
            error: 'Browser does not support Canvas WebM MediaRecorder export.',
            lastFileName: null,
          });
          return;
        }

        const exportW = normalizeExportDimension(options?.width ?? curExportW, 1280, 320, 3840);
        const exportH = normalizeExportDimension(options?.height ?? curExportH, 720, 240, 2160);

        const supportedMime =
          [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
          ].find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

        let expCanvas = exportCanvasRef.current;
        if (!expCanvas) {
          expCanvas = document.createElement('canvas');
          exportCanvasRef.current = expCanvas;
        }
        expCanvas.width = exportW;
        expCanvas.height = exportH;

        const prevLoop = engine.getLoop();
        const buf = engine.getBuffer();
        const exportDuration =
          buf && buf.duration > 0 ? buf.duration : Math.max(1, propDur || engine.getDuration());

        // Prepare playback at 0:00 and keep the user's current simulation mode (Demo / Sync / Input) intact
        engine.pause();
        engine.setLoop(false);
        engine.seek(0);
        beforeStart?.();

        // Reset section auto-switch tracker and preview initial beat-0 section preset if configured
        lastAutoSectionKeyRef.current = null;
        prevAutoBeatRef.current = null;
        if (curSorted.length > 0 && curSorted[0].beat <= 0 && curSorted[0].preset) {
          lastAutoSectionKeyRef.current = `${curSorted[0].id}:${curSorted[0].preset}`;
          if (curSorted[0].preset !== presetRef.current) {
            presetRef.current = curSorted[0].preset;
            setPreset(curSorted[0].preset);
          }
        }

        // Blur clicked export button so Spacebar cleanly starts capture rather than clicking a button
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && activeEl !== document.body && typeof activeEl.blur === 'function') {
          activeEl.blur();
        }

        const chunks: Blob[] = [];
        const session: NonNullable<typeof exportSessionRef.current> = {
          active: true,
          armed: true,
          finishing: false,
          cancelled: false,
          recorder: null,
          videoStream: null,
          chunks,
          mimeType: supportedMime,
          prevLoop,
          durationSec: exportDuration,
          width: exportW,
          height: exportH,
          outFileName: '',
          startedPlaybackAtMs: 0,
          lastProgressUiMs: 0,
          finishTimerId: null,
          clearTerrainOnStart: true,
        };

        session.beginCaptureFn = async () => {
          if (!session.active || !session.armed || session.cancelled) return;
          session.armed = false;
          setIsArmedToRecord(false);

          const {
            simSoundMode: activeMode,
            fileName: trackName,
            sortedSections: latestSorted,
            onBeforeDemoExportStart: onBeginReset,
            onWebmExportStateChange: onExportState,
          } = propsRef.current;

          const baseName = (trackName || 'screensaver')
            .replace(/\.[^/.]+$/, '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_');
          session.outFileName = `${baseName}_${activeMode}_${exportW}x${exportH}.webm`;

          engine.pause();
          engine.setLoop(false);
          engine.seek(0);
          onBeginReset?.();
          session.clearTerrainOnStart = true;

          lastAutoSectionKeyRef.current = null;
          prevAutoBeatRef.current = null;
          if (latestSorted.length > 0 && latestSorted[0].beat <= 0 && latestSorted[0].preset) {
            lastAutoSectionKeyRef.current = `${latestSorted[0].id}:${latestSorted[0].preset}`;
            if (latestSorted[0].preset !== presetRef.current) {
              presetRef.current = latestSorted[0].preset;
              setPreset(latestSorted[0].preset);
            }
          }

          onExportState?.({
            status: 'recording',
            elapsedSec: 0,
            durationSec: exportDuration,
            error: null,
            lastFileName: null,
          });

          // Render 2 clean initial frames at target resolution before starting recorder
          await nextFrame();
          await nextFrame();

          if (!exportSessionRef.current || exportSessionRef.current !== session || session.cancelled) {
            return;
          }

          const audioStream = engine.getCaptureAudioStream();
          const videoStream = expCanvas!.captureStream(60);
          session.videoStream = videoStream;

          const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
          if (audioStream) {
            tracks.push(...audioStream.getAudioTracks());
          }
          const combinedStream = new MediaStream(tracks);

          const targetVideoBitrate = Math.max(
            4_000_000,
            Math.min(18_000_000, Math.round(((exportW * exportH) / (1280 * 720)) * 7_500_000))
          );

          let recorder: MediaRecorder;
          try {
            recorder = new MediaRecorder(combinedStream, {
              mimeType: supportedMime,
              videoBitsPerSecond: targetVideoBitrate,
              audioBitsPerSecond: 192_000,
            });
          } catch {
            try {
              recorder = new MediaRecorder(combinedStream, { mimeType: supportedMime });
            } catch {
              recorder = new MediaRecorder(combinedStream);
            }
          }
          session.recorder = recorder;

          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) {
              session.chunks.push(ev.data);
            }
          };

          recorder.onstop = () => {
            if (session.finishTimerId !== null) {
              window.clearTimeout(session.finishTimerId);
              session.finishTimerId = null;
            }
            session.videoStream?.getVideoTracks().forEach((t) => t.stop());
            session.active = false;
            session.armed = false;
            if (exportSessionRef.current === session) {
              exportSessionRef.current = null;
            }
            setIsArmedToRecord(false);
            setActiveExportSize(null);

            engine.pause();
            engine.setLoop(session.prevLoop);

            if (!session.cancelled && session.chunks.length > 0) {
              const blob = new Blob(session.chunks, {
                type: recorder.mimeType || session.mimeType || 'video/webm',
              });
              triggerBlobDownload(blob, session.outFileName);
              propsRef.current.onWebmExportStateChange?.({
                status: 'idle',
                elapsedSec: 0,
                durationSec: session.durationSec,
                error: null,
                lastFileName: session.outFileName,
              });
            } else {
              propsRef.current.onWebmExportStateChange?.({
                status: 'idle',
                elapsedSec: 0,
                durationSec: 0,
                error: null,
                lastFileName: null,
              });
            }
          };

          recorder.onerror = () => {
            session.cancelled = true;
            propsRef.current.onWebmExportStateChange?.({
              status: 'idle',
              elapsedSec: 0,
              durationSec: 0,
              error: 'WebM encoding failed during capture.',
              lastFileName: null,
            });
            if (recorder.state !== 'inactive') {
              recorder.stop();
            }
          };

          recorder.start(250);
          session.startedPlaybackAtMs = performance.now();
          engine.play();
        };

        exportSessionRef.current = session;
        setActiveExportSize({ width: exportW, height: exportH });
        setIsArmedToRecord(true);
        setState?.({
          status: 'armed',
          elapsedSec: 0,
          durationSec: exportDuration,
          error: null,
          lastFileName: null,
        });
      },
      stopAndSaveDemoWebmExport: () => {
        const sess = exportSessionRef.current;
        if (!sess || !sess.active || sess.armed) return;
        sess.finishing = true;
        if (sess.finishTimerId !== null) {
          window.clearTimeout(sess.finishTimerId);
          sess.finishTimerId = null;
        }
        propsRef.current.onWebmExportStateChange?.({
          status: 'finalizing',
          elapsedSec: Math.min(sess.durationSec, engine.getCurrentTime()),
          durationSec: sess.durationSec,
          error: null,
          lastFileName: null,
        });
        if (sess.recorder && sess.recorder.state !== 'inactive') {
          sess.recorder.stop();
        }
      },
      cancelDemoWebmExport: () => {
        const sess = exportSessionRef.current;
        if (!sess || !sess.active) return;
        sess.cancelled = true;
        sess.finishing = true;
        sess.armed = false;
        if (sess.finishTimerId !== null) {
          window.clearTimeout(sess.finishTimerId);
          sess.finishTimerId = null;
        }
        if (sess.recorder && sess.recorder.state !== 'inactive') {
          sess.recorder.stop();
        } else {
          sess.active = false;
          exportSessionRef.current = null;
          setIsArmedToRecord(false);
          setActiveExportSize(null);
          engine.pause();
          engine.setLoop(sess.prevLoop);
          propsRef.current.onWebmExportStateChange?.({
            status: 'idle',
            elapsedSec: 0,
            durationSec: 0,
            error: null,
            lastFileName: null,
          });
        }
      },
    };

    if (exportHandleRef) {
      exportHandleRef.current = handle;
    }
    return () => {
      if (exportHandleRef && exportHandleRef.current === handle) {
        exportHandleRef.current = null;
      }
    };
  }, [exportHandleRef]);

  const personaMeta = PERSONA_META[difficulty] || {
    name: getPersonaForDifficulty(difficulty),
    diffLabel: difficulty.charAt(0).toUpperCase() + difficulty.slice(1),
    textClass: 'text-emerald-300',
    accentHex: '#34d399',
  };

  const targetPreviewSize =
    activeExportSize ?? (exportHeight > exportWidth * 1.05 ? { width: exportWidth, height: exportHeight } : null);
  const isPortraitPreview = Boolean(
    !isFullscreen && targetPreviewSize && targetPreviewSize.height > targetPreviewSize.width * 1.05
  );

  return (
    <div
      ref={containerRef}
      style={
        !isFullscreen && targetPreviewSize
          ? { aspectRatio: `${targetPreviewSize.width} / ${targetPreviewSize.height}` }
          : undefined
      }
      className={cn(
        'relative overflow-hidden bg-[#04060b] select-none',
        isFullscreen
          ? 'h-screen w-screen'
          : isPortraitPreview
          ? 'h-[min(74vh,640px)] max-w-full mx-auto'
          : activeExportSize
          ? 'w-full min-h-[420px]'
          : 'w-full aspect-[16/10] min-h-[420px]'
      )}
    >
      {/* Layer 1: WebGL Procedural Windshield Canvas (GLSL Space / Wormhole / MilkDrop) */}
      <canvas
        ref={bgCanvasRef}
        className={cn(
          'absolute inset-0 w-full h-full block transition-opacity duration-200',
          preset === 'music-rain' || glFallback
            ? 'opacity-0 pointer-events-none'
            : 'opacity-100'
        )}
      />

      {/* Layer 2: Mirrored Dot-Matrix Terrain / Wormhole / MilkDrop Kaleidoscope / Music Rain / 2D Fallback */}
      <canvas
        ref={rainCanvasRef}
        className={cn(
          'absolute inset-0 w-full h-full block pointer-events-none',
          preset === 'music-rain' ||
            preset === 'glsl-space' ||
            preset === 'wormhole' ||
            preset === 'milkdrop' ||
            glFallback
            ? 'opacity-100'
            : 'opacity-0'
        )}
      />

      {/* Layer 3: Recessed Dark Futuristic Cockpit & Expressive Steering Wheel */}
      <canvas
        ref={cockpitCanvasRef}
        className="absolute inset-0 w-full h-full block pointer-events-none"
      />

      {/* Armed WebM Recording Gate Prompt (only in DOM before capture starts) */}
      {isArmedToRecord && (
        <div className="pointer-events-none absolute inset-x-0 top-[20%] z-20 flex flex-col items-center justify-center px-4 text-center">
          <div className="px-4 py-2 rounded-sm bg-black/75 border border-emerald-400/45 shadow-lg">
            <div className="text-sm font-mono font-bold tracking-wider uppercase text-emerald-300">
              Press space to begin
            </div>
            <div className="mt-0.5 text-xs font-mono text-gray-300">
              Mode: {simSoundMode.toUpperCase()}
              {activeExportSize ? ` · ${activeExportSize.width}×${activeExportSize.height}` : ''}
            </div>
          </div>
        </div>
      )}

      {/* Embedded Dashboard Displays (all GUI inside solid car dashboard, keeping windshield unobstructed) */}
      {/* Left Dashboard Telemetry Cluster: DemoTest/PlayTest Score when Input Highway ON, else Step Meter + Bar A/B */}
      <div
        style={{ fontSize: 'var(--dash-fs, 16px)' }}
        className={cn(
          'pointer-events-none absolute z-10 flex flex-col justify-between px-[0.625em] py-[0.45em] font-mono tabular-nums overflow-hidden',
          isPortraitView
            ? 'left-[3.2%] right-[51.4%] top-[85.8%] bottom-[2.4%]'
            : 'left-[3.2%] right-[68.8%] top-[72.5%] bottom-[3.8%]'
        )}
      >
        {showInputHighway && playScore ? (
          <>
            <div className="flex items-center justify-between gap-[0.2em] text-[0.55em] leading-none">
              <span
                className={cn(
                  'font-semibold tracking-tight truncate',
                  simSoundMode === 'demo' ? 'text-emerald-300' : 'text-gray-200'
                )}
              >
                {simSoundMode === 'demo' ? 'Demotest Score' : 'Playtest Score'}
              </span>
              <span className={cn('font-semibold shrink-0', personaMeta.textClass)}>
                {personaMeta.diffLabel} Difficulty
              </span>
            </div>

            <div className="flex items-center justify-between gap-[0.2em] text-[0.58em] leading-none">
              <span className="text-emerald-400 font-bold">Accu {playScore.accuracy.toFixed(1)}%</span>
              <span className="text-white font-bold">Combo {playScore.combo}</span>
              <span className="text-amber-300 font-bold">Max {playScore.maxCombo}</span>
            </div>

            <div className="grid grid-cols-3 gap-x-[0.4em] gap-y-[0.15em] text-[0.58em] leading-tight">
              <div className="flex items-center justify-between">
                <span className="text-cyan-300 font-semibold">MARV</span>
                <span className="text-gray-200">{playScore.counts.marvelous}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-yellow-300 font-semibold">PERF</span>
                <span className="text-gray-200">{playScore.counts.perfect}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-emerald-400 font-semibold">GREAT</span>
                <span className="text-gray-200">{playScore.counts.great}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sky-400 font-semibold">GOOD</span>
                <span className="text-gray-200">{playScore.counts.good}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-violet-400 font-semibold">BOO</span>
                <span className="text-gray-200">{playScore.counts.boo}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-red-400 font-semibold">MISS</span>
                <span className="text-gray-200">{playScore.counts.miss}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-[0.25em] text-[0.6875em] leading-none">
              <span className={cn('font-semibold uppercase tracking-wider truncate', personaMeta.textClass)}>
                {personaMeta.name}
              </span>
              <span className="text-gray-300 shrink-0">
                B{hudReadout.barDisplay}·{hudReadout.beatDisplay.trim()}
              </span>
              <span
                className={cn(
                  'font-bold text-center shrink-0',
                  hudReadout.symbol === 'L'
                    ? 'text-sky-300'
                    : hudReadout.symbol === 'R'
                    ? 'text-amber-300'
                    : 'text-emerald-300'
                )}
              >
                {hudReadout.inSongBounds ? hudReadout.symbol : 'IDLE'}
              </span>
              <span className="text-gray-400 shrink-0">
                {hudReadout.visualDeg > 0 ? `+${hudReadout.visualDeg}` : hudReadout.visualDeg}°
              </span>
            </div>

            <div className="flex flex-col gap-[0.25em]">
              <div className="flex items-center justify-end text-[0.625em] text-gray-500 uppercase tracking-wider">
                <span>Bar {hudReadout.barParity}</span>
              </div>
              <div className="grid grid-cols-8 gap-[0.125em] text-[0.6875em]">
                {hudReadout.pattern.map((sym, idx) => {
                  const isActive = hudReadout.inSongBounds && idx === hudReadout.stepInBar;
                  const isComp = idx >= 6;
                  return (
                    <span
                      key={idx}
                      className={cn(
                        'py-[0.15em] text-center rounded-[0.15em] transition-colors',
                        isActive
                          ? 'bg-emerald-500 text-gray-950 font-bold'
                          : isComp
                          ? 'bg-white/[0.04] text-pink-400/85'
                          : 'bg-white/[0.03] text-gray-400'
                      )}
                    >
                      {sym}
                    </span>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Right Dashboard Infotainment Bay: Windshield Preset Switcher, Fullscreen & Drum Perturbations */}
      <div
        style={{ fontSize: 'var(--dash-fs, 16px)' }}
        className={cn(
          'pointer-events-auto absolute z-10 flex flex-col justify-between px-[0.625em] py-[0.5em] font-mono tabular-nums overflow-hidden',
          isPortraitView
            ? 'left-[51.4%] right-[3.2%] top-[85.8%] bottom-[2.4%]'
            : 'left-[68.8%] right-[3.2%] top-[72.5%] bottom-[3.8%]'
        )}
      >
        <div className="flex items-start justify-between gap-[0.375em]">
          <div className="grid grid-cols-2 gap-[0.25em] flex-1 min-w-0">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={cn(
                  'px-[0.375em] py-[0.18em] text-[0.6875em] rounded-[0.2em] transition-colors truncate text-left',
                  preset === p.id
                    ? 'bg-emerald-500 text-gray-950 font-semibold'
                    : 'bg-white/[0.04] text-gray-300 hover:text-white hover:bg-white/[0.1]'
                )}
                title={`Preset ${p.keyNum}: ${p.label}`}
              >
                {p.keyNum} {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-[0.25em] shrink-0">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-[0.25em] rounded-[0.2em] bg-white/[0.04] text-gray-300 hover:text-white hover:bg-white/[0.1] transition-colors shrink-0"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Screensaver'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-[0.875em] h-[0.875em]" />
              ) : (
                <Maximize2 className="w-[0.875em] h-[0.875em]" />
              )}
            </button>
            <button
              type="button"
              aria-pressed={showInputHighway}
              onClick={() => setShowInputHighway((v) => !v)}
              className={cn(
                'p-[0.25em] rounded-[0.2em] transition-colors shrink-0',
                showInputHighway
                  ? 'bg-emerald-500 text-gray-950 font-semibold'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.1]'
              )}
              title={showInputHighway ? 'Hide D F J K Input Arrows' : 'Show D F J K Input Arrows'}
            >
              <ArrowDown className="w-[0.875em] h-[0.875em]" />
            </button>
          </div>
        </div>

        {/* Bottom Infotainment Strip: Percussion Perturbation Meters */}
        <div className="flex items-center justify-between gap-[0.5em] text-[0.625em] pt-[0.25em] border-t border-white/[0.06]">
          <div className="flex items-center gap-[0.25em] flex-1 min-w-0" title="Kick pushes toward current orientation">
            <span className="text-amber-400">K</span>
            <div className="flex-1 h-[0.375em] bg-white/10 overflow-hidden rounded-[0.1em]">
              <div
                className="h-full bg-amber-400"
                style={{ width: `${Math.round(hudReadout.kick * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-[0.25em] flex-1 min-w-0" title="Snare rebounds toward center 0°">
            <span className="text-emerald-400">S</span>
            <div className="flex-1 h-[0.375em] bg-white/10 overflow-hidden rounded-[0.1em]">
              <div
                className="h-full bg-emerald-400"
                style={{ width: `${Math.round(hudReadout.snare * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-[0.25em] flex-1 min-w-0" title="Tom lateral displacement">
            <span className="text-pink-400">T</span>
            <div className="flex-1 h-[0.375em] bg-white/10 overflow-hidden rounded-[0.1em]">
              <div
                className="h-full bg-pink-400"
                style={{ width: `${Math.round(hudReadout.tom * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-[0.125em] shrink-0" title="Hi-Hat alternating 1/16th A/B texture">
            <span className={hudReadout.hatA >= hudReadout.hatB ? 'text-sky-300 font-bold' : 'text-gray-500'}>
              A
            </span>
            <span className="text-gray-600">/</span>
            <span className={hudReadout.hatB > hudReadout.hatA ? 'text-cyan-300 font-bold' : 'text-gray-500'}>
              B
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
