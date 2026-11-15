import React, { useEffect, useRef, useState } from 'react';
import {
  Cpu,
  Sliders,
  Upload,
  Volume2,
  X,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Download,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  DrumEvent,
  DrumLaneRule,
  LaneColor,
  LaneIndex,
  NoteSubdivisionLimiter,
  SeparationDiagnostics,
  StemEngineMode,
  StemStatus,
} from '../types';
import { getEffectiveAltLane } from '../lib/drumAnalysis';
import { cn } from '../lib/utils';

export type AuditionMode = 'mix' | 'drums' | 'blend';

interface Props {
  hasAudio: boolean;
  engineMode: StemEngineMode;
  setEngineMode: (mode: StemEngineMode) => void;
  webGpuInfo: { available: boolean; reason?: string };
  modelCached: boolean;
  status: StemStatus;
  progress: number;
  stageLabel: string;
  errorMessage: string | null;
  hasDrumStem: boolean;
  auditionMode: AuditionMode;
  onChangeAuditionMode: (mode: AuditionMode) => void;
  blendRatio: number;
  onChangeBlendRatio: (ratio: number) => void;
  showDrumMarkers: boolean;
  setShowDrumMarkers: (show: boolean) => void;
  quantizeDrums: boolean;
  setQuantizeDrums: (q: boolean) => void;
  laneRules: DrumLaneRule[];
  onUpdateLaneRule: (id: string, updates: Partial<DrumLaneRule>) => void;
  onAddLaneRule: () => void;
  onAddTomPreset?: () => void;
  onRemoveLaneRule: (id: string) => void;
  onResetLaneRules: () => void;
  activeSoloBand?: { minHz: number; maxHz: number } | null;
  drumEvents: DrumEvent[];
  diagnostics?: SeparationDiagnostics | null;
  onStartSeparation: (customModelFile?: File) => void;
  onCancelSeparation: () => void;
  onImportDrumStem: (file: File) => void;
  onDownloadDrumStem: () => void;
  onClearModelCache: () => void;
  onResetDrums: () => void;
}

const COLOR_STYLES: Record<
  LaneColor,
  { text: string; dot: string; bar: string; checkbox: string }
> = {
  amber: {
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    bar: 'accent-amber-500',
    checkbox: 'text-amber-500 focus:ring-amber-500',
  },
  emerald: {
    text: 'text-emerald-400',
    dot: 'bg-emerald-400',
    bar: 'accent-emerald-500',
    checkbox: 'text-emerald-500 focus:ring-emerald-500',
  },
  sky: {
    text: 'text-sky-400',
    dot: 'bg-sky-400',
    bar: 'accent-sky-500',
    checkbox: 'text-sky-500 focus:ring-sky-500',
  },
  pink: {
    text: 'text-pink-400',
    dot: 'bg-pink-400',
    bar: 'accent-pink-500',
    checkbox: 'text-pink-500 focus:ring-pink-500',
  },
  violet: {
    text: 'text-violet-400',
    dot: 'bg-violet-400',
    bar: 'accent-violet-500',
    checkbox: 'text-violet-500 focus:ring-violet-500',
  },
};

const COLOR_ORDER: LaneColor[] = ['amber', 'emerald', 'sky', 'pink', 'violet'];
const LANE_KEYS: { lane: LaneIndex; label: string }[] = [
  { lane: 0, label: 'D' },
  { lane: 1, label: 'F' },
  { lane: 2, label: 'J' },
  { lane: 3, label: 'K' },
];

function HzInput({
  value,
  min,
  max,
  title,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  title: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const commit = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={5}
      value={focused ? draft : value}
      onFocus={() => {
        setDraft(String(value));
        setFocused(true);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseInt(e.target.value, 10);
        if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
          onCommit(parsed);
        }
      }}
      onBlur={() => {
        setFocused(false);
        commit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(draft);
          e.currentTarget.blur();
        }
      }}
      className="w-16 bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-gray-200 text-right focus:outline-none focus:border-emerald-500"
      title={title}
    />
  );
}

export function StemStudio({
  hasAudio,
  engineMode,
  setEngineMode,
  webGpuInfo,
  modelCached,
  status,
  progress,
  stageLabel,
  errorMessage,
  hasDrumStem,
  auditionMode,
  onChangeAuditionMode,
  blendRatio,
  onChangeBlendRatio,
  showDrumMarkers,
  setShowDrumMarkers,
  quantizeDrums,
  setQuantizeDrums,
  laneRules,
  onUpdateLaneRule,
  onAddLaneRule,
  onAddTomPreset,
  onRemoveLaneRule,
  onResetLaneRules,
  activeSoloBand = null,
  drumEvents,
  diagnostics,
  onStartSeparation,
  onCancelSeparation,
  onImportDrumStem,
  onDownloadDrumStem,
  onClearModelCache,
  onResetDrums,
}: Props) {
  const localOnnxInputRef = useRef<HTMLInputElement>(null);
  const drumFileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = status === 'loading-model' || status === 'processing';

  const countByRuleId = (id: string) => drumEvents.filter((e) => e.band === id).length;

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      {/* Header Row */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold text-gray-200 tracking-wider uppercase">
              Drum Stem Studio
            </h2>
            {hasDrumStem && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Drum stem active</span>
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Isolate drums locally in a background Web Worker, customize Hz detection bands, and map hits to arrow lanes.
          </p>
        </div>

        {/* Engine Mode Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center p-1 bg-gray-950 border border-gray-800 rounded-lg">
            <button
              type="button"
              disabled={isRunning}
              onClick={() => setEngineMode('dsp-hpss')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5',
                engineMode === 'dsp-hpss'
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-gray-200',
                isRunning && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Instant DSP (HPSS)</span>
            </button>
            <button
              type="button"
              disabled={isRunning}
              onClick={() => setEngineMode('webgpu-demucs')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5',
                engineMode === 'webgpu-demucs'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-gray-400 hover:text-gray-200',
                isRunning && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>WebGPU AI (HT-Demucs)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mode Info & Primary Action Strip */}
      <div className="border-t border-gray-800 pt-2.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="text-xs text-gray-400 space-y-1">
          {engineMode === 'dsp-hpss' ? (
            <p>
              <span className="text-gray-200 font-medium">Zero-download percussive separation:</span>{' '}
              Separates sharp transients from sustained vocals and synths in seconds using STFT median filtering.
            </p>
          ) : (
            <div className="space-y-1">
              <p>
                <span className="text-gray-200 font-medium">Neural 4-stem isolation (HT-Demucs):</span>{' '}
                {webGpuInfo.available ? (
                  <span className="text-emerald-400">WebGPU adapter detected</span>
                ) : (
                  <span className="text-amber-400">{webGpuInfo.reason || 'WebGPU unavailable'}</span>
                )}
                {' · '}
                {modelCached ? (
                  <span className="text-emerald-400">Model cached in browser</span>
                ) : (
                  <span>First run downloads WebGPU HT-Demucs weights (cached locally)</span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => localOnnxInputRef.current?.click()}
                  className="text-gray-300 hover:text-white underline underline-offset-2 disabled:opacity-50"
                >
                  Load local .onnx / .gzbin model
                </button>
                <input
                  ref={localOnnxInputRef}
                  type="file"
                  accept=".onnx,.gzbin"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onStartSeparation(file);
                    e.target.value = '';
                  }}
                />
                {modelCached && (
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={onClearModelCache}
                    className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    Clear cached model
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isRunning}
            onClick={() => drumFileInputRef.current?.click()}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import Drum Stem</span>
          </button>
          <input
            ref={drumFileInputRef}
            type="file"
            accept=".mp3,.wav,.ogg,.m4a"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImportDrumStem(file);
              e.target.value = '';
            }}
          />

          {isRunning ? (
            <button
              type="button"
              onClick={onCancelSeparation}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!hasAudio || (engineMode === 'webgpu-demucs' && !webGpuInfo.available)}
              onClick={() => onStartSeparation()}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-600 text-gray-950 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{hasDrumStem ? 'Re-Separate Drums' : 'Separate Drum Stem'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress State */}
      {isRunning && (
        <div className="border-t border-gray-800 pt-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-200 font-medium">{stageLabel || 'Processing...'}</span>
            <span className="font-mono tabular-nums text-emerald-400">{progress}%</span>
          </div>
          <div className="w-full h-2 bg-gray-950 rounded-full overflow-hidden border border-gray-800">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-150 ease-out"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>
        </div>
      )}

      {/* Error State with Recovery */}
      {status === 'error' && errorMessage && (
        <div className="border border-red-500/40 bg-red-500/10 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2 text-xs text-red-300">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          {engineMode === 'webgpu-demucs' && (
            <button
              type="button"
              onClick={() => setEngineMode('dsp-hpss')}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-800 hover:bg-gray-700 text-white whitespace-nowrap shrink-0"
            >
              Switch to Instant DSP
            </button>
          )}
        </div>
      )}

      {/* Populated State: Audition + Configurable Lane Manager */}
      {hasDrumStem && !isRunning && (
        <div className="border-t border-gray-800 pt-3 space-y-3">
          {/* Audition & Grid Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Volume2 className="w-4 h-4 text-emerald-400" />
                <span>Audition:</span>
              </div>
              <div className="inline-flex items-center p-1 bg-gray-950 border border-gray-800 rounded-lg">
                {(
                  [
                    { id: 'mix', label: 'Full Mix' },
                    { id: 'drums', label: 'Drums Only' },
                    { id: 'blend', label: 'Blend' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onChangeAuditionMode(opt.id)}
                    className={cn(
                      'px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                      auditionMode === opt.id
                        ? 'bg-emerald-500 text-gray-950 font-semibold'
                        : 'text-gray-400 hover:text-gray-200'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {auditionMode === 'blend' && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span>Drums</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={blendRatio}
                    onChange={(e) => onChangeBlendRatio(parseFloat(e.target.value))}
                    className="w-24 accent-emerald-500"
                  />
                  <span className="font-mono tabular-nums text-gray-200">
                    {Math.round(blendRatio * 100)}%
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDrumMarkers}
                  onChange={(e) => setShowDrumMarkers(e.target.checked)}
                  className="rounded border-gray-700 bg-gray-800 text-emerald-500 focus:ring-emerald-500 w-4 h-4"
                />
                <span>Show Markers</span>
              </label>

              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={quantizeDrums}
                  onChange={(e) => setQuantizeDrums(e.target.checked)}
                  className="rounded border-gray-700 bg-gray-800 text-emerald-500 focus:ring-emerald-500 w-4 h-4"
                />
                <span>Snap to 16th Grid</span>
              </label>

              <button
                type="button"
                onClick={onDownloadDrumStem}
                className="px-2.5 py-1 text-xs font-medium rounded-md bg-gray-800 hover:bg-gray-700 text-emerald-300 border border-emerald-500/30 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                title="Download isolated drum stem as 16-bit WAV"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .wav</span>
              </button>

              <button
                type="button"
                onClick={onResetDrums}
                className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-200 transition-colors"
                title="Clear isolated drum stem"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Clear Stem</span>
              </button>
            </div>
          </div>

          {/* Lane Manager Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-gray-300">Lane Manager</span>
              <span className="text-gray-500 font-mono tabular-nums">
                {laneRules.filter((r) => r.enabled).length} active · {drumEvents.length} total hits
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onResetLaneRules}
                className="px-2.5 py-1 text-xs text-gray-400 hover:text-white rounded border border-gray-800 hover:border-gray-700 transition-colors whitespace-nowrap shrink-0"
              >
                Reset Defaults
              </button>
              {onAddTomPreset && !laneRules.some((r) => r.name.toLowerCase().includes('tom')) && (
                <button
                  type="button"
                  onClick={onAddTomPreset}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-pink-500/15 hover:bg-pink-500/25 text-pink-300 border border-pink-500/30 transition-colors whitespace-nowrap shrink-0"
                  title="Add modular Tom preset (110–300 Hz, F/J alternating)"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Tom</span>
                </button>
              )}
              <button
                type="button"
                onClick={onAddLaneRule}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Lane</span>
              </button>
            </div>
          </div>

          {/* Configurable Lane Rules */}
          <div className="divide-y divide-gray-800 border border-gray-800 rounded-lg bg-gray-950/60">
            {laneRules.map((rule) => {
              const style = COLOR_STYLES[rule.color] || COLOR_STYLES.pink;
              const count = countByRuleId(rule.id);

              const cycleColor = () => {
                const idx = COLOR_ORDER.indexOf(rule.color);
                const next = COLOR_ORDER[(idx + 1) % COLOR_ORDER.length];
                onUpdateLaneRule(rule.id, { color: next });
              };

              return (
                <div
                  key={rule.id}
                  className={cn(
                    'px-3 py-2 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 transition-opacity',
                    !rule.enabled && 'opacity-50'
                  )}
                >
                  {/* Enable + Color + Name */}
                  <div className="flex items-center gap-2 min-w-[175px]">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => onUpdateLaneRule(rule.id, { enabled: e.target.checked })}
                      className={cn(
                        'rounded border-gray-700 bg-gray-800 w-4 h-4 cursor-pointer shrink-0',
                        style.checkbox
                      )}
                    />
                    <button
                      type="button"
                      onClick={cycleColor}
                      className={cn('w-3 h-3 rounded-full shrink-0 ring-1 ring-white/20 hover:scale-110 transition-transform', style.dot)}
                      title="Click to cycle lane marker color"
                    />
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        const firstChar = val.trim().charAt(0).toUpperCase();
                        onUpdateLaneRule(rule.id, {
                          name: val,
                          badge: rule.id === 'snare' && val.toLowerCase().includes('clap') ? 'C' : firstChar || rule.badge,
                        });
                      }}
                      className={cn(
                        'bg-transparent border border-transparent hover:border-gray-800 focus:border-gray-700 focus:bg-gray-900 rounded px-1.5 py-0.5 text-sm font-medium w-28 focus:outline-none',
                        style.text
                      )}
                    />
                    <span className="text-[11px] font-mono text-gray-500">[{rule.badge}]</span>
                  </div>

                  {/* Frequency Range (Hz) + Apply Solo */}
                  <div className="flex items-center gap-1.5 text-xs font-mono tabular-nums shrink-0">
                    <HzInput
                      value={rule.minHz}
                      min={20}
                      max={rule.maxHz - 5}
                      title="Minimum Hz"
                      onCommit={(minHz) => onUpdateLaneRule(rule.id, { minHz })}
                    />
                    <span className="text-gray-600">–</span>
                    <HzInput
                      value={rule.maxHz}
                      min={rule.minHz + 5}
                      max={16500}
                      title="Maximum Hz"
                      onCommit={(maxHz) => onUpdateLaneRule(rule.id, { maxHz })}
                    />
                    <span className="text-gray-500">Hz</span>

                    {activeSoloBand && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateLaneRule(rule.id, {
                            minHz: Math.round(activeSoloBand.minHz),
                            maxHz: Math.round(activeSoloBand.maxHz),
                          })
                        }
                        className="ml-1 px-1.5 py-0.5 text-[11px] rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 whitespace-nowrap"
                        title="Apply currently soloed Spectrum range to this lane"
                      >
                        Use Solo
                      </button>
                    )}
                  </div>

                  {/* Key Assignment, Alt Key & Rate Limiter */}
                  {(() => {
                    const altLane = getEffectiveAltLane(rule);
                    const isAlt = altLane !== null;
                    const altOptions = LANE_KEYS.filter((lk) => lk.lane !== rule.lane);
                    return (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="inline-flex p-0.5 bg-gray-900 border border-gray-800 rounded">
                          {LANE_KEYS.map((lk) => (
                            <button
                              key={lk.lane}
                              type="button"
                              onClick={() =>
                                onUpdateLaneRule(rule.id, {
                                  lane: lk.lane,
                                  ...(altLane === lk.lane
                                    ? {
                                        altLane: null,
                                        distributeMode: 'fixed',
                                        distributeEvenOdd: false,
                                      }
                                    : altLane !== null
                                    ? { altLane }
                                    : {}),
                                })
                              }
                              className={cn(
                                'px-1.5 py-0.5 text-[11px] font-mono rounded transition-colors',
                                rule.lane === lk.lane
                                  ? 'bg-gray-700 text-white font-semibold'
                                  : 'text-gray-500 hover:text-gray-200'
                              )}
                              title={`Map primary hits to lane ${lk.label}`}
                            >
                              {lk.label}
                            </button>
                          ))}
                        </div>

                        <select
                          value={altLane === null ? 'fixed' : String(altLane)}
                          onChange={(e) => {
                            const val = e.target.value;
                            const nextAlt =
                              val === 'fixed' ? null : (Number(val) as LaneIndex);
                            onUpdateLaneRule(rule.id, {
                              altLane: nextAlt,
                              distributeMode: nextAlt === null ? 'fixed' : undefined,
                              distributeEvenOdd: false,
                            });
                          }}
                          className={cn(
                            'rounded px-1.5 py-1 text-[11px] font-mono border focus:outline-none cursor-pointer transition-colors',
                            isAlt
                              ? 'bg-sky-950 border-sky-500/40 text-sky-300'
                              : 'bg-gray-900 border-gray-800 text-gray-300'
                          )}
                          title="Fixed keeps all hits on the selected key; picking an Alt key alternates between Primary (even) and Alt (odd)"
                        >
                          <option value="fixed" className="bg-gray-900 text-gray-200">
                            Fixed
                          </option>
                          {altOptions.map((lk) => (
                            <option
                              key={lk.lane}
                              value={String(lk.lane)}
                              className="bg-gray-900 text-gray-200"
                            >
                              Alt: {lk.label}
                            </option>
                          ))}
                        </select>

                    <select
                      value={rule.limiter === null || rule.limiter === undefined ? 'off' : String(rule.limiter)}
                      onChange={(e) => {
                        const val = e.target.value;
                        const parsed: NoteSubdivisionLimiter =
                          val === 'off'
                            ? null
                            : val.startsWith('on-')
                            ? (val as NoteSubdivisionLimiter)
                            : (Number(val) as NoteSubdivisionLimiter);
                        onUpdateLaneRule(rule.id, { limiter: parsed });
                      }}
                      className="bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-[11px] font-mono tabular-nums text-gray-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                      title="Max 1/N limits speed; On 1/N locks hits to the 1/N beat grid and ignores off-grid subdivisions"
                    >
                      <option value="off">Limit: Off</option>
                      <option value="4">Max 1/4</option>
                      <option value="on-4">On 1/4</option>
                      <option value="8">Max 1/8</option>
                      <option value="on-8">On 1/8</option>
                      <option value="16">Max 1/16</option>
                      <option value="on-16">On 1/16</option>
                      <option value="32">Max 1/32</option>
                    </select>
                  </div>
                    );
                  })()}

                  {/* Sensitivity & Hit Count */}
                  <div className="flex items-center gap-2.5 flex-1 lg:max-w-[235px]">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      disabled={!rule.enabled}
                      value={rule.sensitivity}
                      onChange={(e) =>
                        onUpdateLaneRule(rule.id, {
                          sensitivity: parseFloat(e.target.value),
                        })
                      }
                      className={cn('w-full cursor-pointer', style.bar)}
                      title="Detection sensitivity (0% = none, 100% = max)"
                    />
                    <span className="text-xs font-mono tabular-nums text-gray-300 w-9 text-right shrink-0">
                      {Math.round(rule.sensitivity * 100)}%
                    </span>
                    <span className="text-xs font-mono tabular-nums text-gray-400 w-14 text-right shrink-0">
                      {rule.enabled ? `${count}` : 'Off'}
                    </span>
                    {!rule.isDefault && (
                      <button
                        type="button"
                        onClick={() => onRemoveLaneRule(rule.id)}
                        className="p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                        title="Remove custom lane"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {diagnostics && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-gray-400 bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2">
              <div className="font-mono tabular-nums">
                Backend: <span className="text-gray-200">{diagnostics.backendUsed}</span>
                {' · '}
                Peak: <span className="text-gray-200">{(diagnostics.peakAmplitude * 100).toFixed(0)}%</span>
                {' · '}
                Chunks: <span className="text-gray-200">{diagnostics.chunksProcessed}</span>
                {diagnostics.nanSamplesReplaced > 0 && (
                  <>
                    {' · '}
                    <span className="text-amber-300">
                      NaN repaired: {diagnostics.nanSamplesReplaced}
                    </span>
                  </>
                )}
              </div>
              {diagnostics.note && (
                <div className="text-amber-300 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{diagnostics.note}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
