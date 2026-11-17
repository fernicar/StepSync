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
  Settings,
  RefreshCw,
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
export type CacheSourceKind = 'public' | 'indexeddb' | 'computed' | 'cleared' | null;

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
  hasCachedAnalysis?: boolean;
  cacheSource?: CacheSourceKind;
  onDownloadAnalysisCache?: () => void;
  onImportAnalysisCache?: (file: File) => void;
  onDiscardMemoryClean?: () => void;
  onDiscardAndRecalculate?: () => void;
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
      className="w-[4.75rem] bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-1.5 py-0.5 text-xs text-white text-right focus:outline-none"
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
  hasCachedAnalysis = false,
  cacheSource = null,
  onDownloadAnalysisCache,
  onImportAnalysisCache,
  onDiscardMemoryClean,
  onDiscardAndRecalculate,
}: Props) {
  const localOnnxInputRef = useRef<HTMLInputElement>(null);
  const drumFileInputRef = useRef<HTMLInputElement>(null);
  const cacheFileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = status === 'loading-model' || status === 'processing';
  const [setupExpanded, setSetupExpanded] = useState<boolean>(
    () => !hasDrumStem && !hasCachedAnalysis && cacheSource !== 'cleared'
  );

  // Auto-collapse heavy engine/import setup once a stem or cache becomes active,
  // and open automatically only if a fresh track starts with nothing loaded.
  const prevHasReadyRef = useRef<boolean>(hasDrumStem || hasCachedAnalysis || cacheSource === 'cleared');
  useEffect(() => {
    const hasReady = hasDrumStem || hasCachedAnalysis || cacheSource === 'cleared';
    if (!prevHasReadyRef.current && hasReady) {
      setSetupExpanded(false);
    } else if (prevHasReadyRef.current && !hasReady && !isRunning) {
      setSetupExpanded(true);
    }
    prevHasReadyRef.current = hasReady;
  }, [hasDrumStem, hasCachedAnalysis, cacheSource, isRunning]);

  const countByRuleId = (id: string) => drumEvents.filter((e) => e.band === id).length;

  return (
    <section className="space-y-1.5">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-semibold text-gray-200 tracking-wider uppercase">
            Drum Stem Studio
          </h2>
          {hasCachedAnalysis && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>
                {cacheSource === 'public'
                  ? 'Cached (/public)'
                  : cacheSource === 'indexeddb'
                  ? 'Cached (Browser)'
                  : hasDrumStem
                  ? 'Stem Ready'
                  : 'Analysis Cached'}
              </span>
            </span>
          )}
          {!hasCachedAnalysis && cacheSource === 'cleared' && (
            <span className="text-xs text-amber-300 font-medium">
              Clean start (auto-detect paused)
            </span>
          )}
        </div>

        {/* Audition + Marker Controls + Cogwheel Toggle */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {(hasDrumStem || hasCachedAnalysis) && !isRunning && (
            <>
              <div className="inline-flex items-center gap-0.5">
                {(
                  [
                    { id: 'mix', label: 'Mix' },
                    { id: 'drums', label: 'Drums' },
                    { id: 'blend', label: 'Blend' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onChangeAuditionMode(opt.id)}
                    className={cn(
                      'px-1.5 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap',
                      auditionMode === opt.id
                        ? 'bg-emerald-500 text-gray-950 font-semibold'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {auditionMode === 'blend' && (
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={blendRatio}
                    onChange={(e) => onChangeBlendRatio(parseFloat(e.target.value))}
                    className="w-16 accent-emerald-500"
                    title="Blend ratio"
                  />
                  <span className="font-mono tabular-nums text-gray-200 text-xs">
                    {Math.round(blendRatio * 100)}%
                  </span>
                </div>
              )}

              <label className="inline-flex items-center gap-1 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDrumMarkers}
                  onChange={(e) => setShowDrumMarkers(e.target.checked)}
                  className="rounded border-gray-700 bg-transparent text-emerald-500 focus:ring-emerald-500 w-3.5 h-3.5"
                />
                <span>Markers</span>
              </label>

              <label className="inline-flex items-center gap-1 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={quantizeDrums}
                  onChange={(e) => setQuantizeDrums(e.target.checked)}
                  className="rounded border-gray-700 bg-transparent text-emerald-500 focus:ring-emerald-500 w-3.5 h-3.5"
                />
                <span>16th</span>
              </label>
            </>
          )}

          <div className="inline-flex items-center gap-0.5">
            {isRunning && (
              <button
                type="button"
                onClick={onCancelSeparation}
                className="px-1.5 py-0.5 text-xs font-medium rounded-sm bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
            )}
            {(hasDrumStem || hasCachedAnalysis) && !isRunning && (
              <button
                type="button"
                onClick={onResetDrums}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap shrink-0"
                title="Clear stem & pause auto-detection (preserves current JSON chart notes)"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Clear</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setSetupExpanded((v) => !v)}
              aria-expanded={setupExpanded}
              className={cn(
                'px-1.5 py-0.5 text-xs font-medium rounded-sm transition-colors flex items-center gap-1 whitespace-nowrap shrink-0',
                setupExpanded
                  ? 'bg-white/10 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-white/[0.06]'
              )}
              title="Show/hide DSP vs WebGPU engine, Import Drum Stem, Re-Separate, and Cache export/reset options"
            >
              <Settings className={cn('w-3.5 h-3.5 transition-transform', setupExpanded && 'rotate-45')} />
              <span>Setup</span>
            </button>
          </div>
        </div>
      </div>

      {/* Hidden File Inputs (always mounted so Setup drawer can trigger them) */}
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
      <input
        ref={cacheFileInputRef}
        type="file"
        accept=".cache,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImportAnalysisCache?.(file);
          e.target.value = '';
        }}
      />

      {/* Collapsible Cogwheel Drawer: DSP vs WebGPU, Import, Re-Separate, WAV/Cache Export & Reset */}
      {setupExpanded && (
        <div className="pt-1 space-y-1.5">
          {/* Row 1: Engine toggle + inline WebGPU/model status + Import/Re-Separate */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => setEngineMode('dsp-hpss')}
                  className={cn(
                    'px-2 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 flex items-center gap-1',
                    engineMode === 'dsp-hpss'
                      ? 'bg-white/10 text-white'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]',
                    isRunning && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Instant DSP</span>
                </button>
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => setEngineMode('webgpu-demucs')}
                  className={cn(
                    'px-2 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0 flex items-center gap-1',
                    engineMode === 'webgpu-demucs'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]',
                    isRunning && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>WebGPU AI</span>
                </button>
              </div>

              {engineMode === 'dsp-hpss' ? (
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  STFT median percussion filter
                </span>
              ) : (
                <>
                  <span className="whitespace-nowrap">
                    {webGpuInfo.available ? (
                      <span className="text-emerald-400">WebGPU ready</span>
                    ) : (
                      <span className="text-amber-400">{webGpuInfo.reason || 'WebGPU unavailable'}</span>
                    )}
                    {' · '}
                    {modelCached ? (
                      <span className="text-emerald-400">Model cached</span>
                    ) : (
                      <span>Downloads weights on first run</span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={() => localOnnxInputRef.current?.click()}
                    className="text-gray-300 hover:text-white underline underline-offset-2 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    Load .onnx/.gzbin
                  </button>
                  {modelCached && (
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={onClearModelCache}
                      className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      Clear weights
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="inline-flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => drumFileInputRef.current?.click()}
                className="px-2 py-0.5 text-xs font-medium rounded-sm hover:bg-white/[0.06] text-gray-200 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import Stem</span>
              </button>

              <button
                type="button"
                disabled={isRunning || !hasAudio || (engineMode === 'webgpu-demucs' && !webGpuInfo.available)}
                onClick={() => onStartSeparation()}
                className="px-2 py-0.5 text-xs font-semibold rounded-sm bg-emerald-500 hover:bg-emerald-600 text-gray-950 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{hasDrumStem ? 'Re-Separate' : 'Separate Drums'}</span>
              </button>
            </div>
          </div>

          {/* Row 2: Unified Cache, Diagnostics & Export/Reset Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-xs font-mono text-gray-400 truncate">
              {cacheSource === 'computed'
                ? 'Analysis saved to browser storage — export .cache for public/.'
                : cacheSource === 'indexeddb'
                ? 'Loaded from browser storage — export .json & .cache for public/.'
                : cacheSource === 'public'
                ? 'Loaded from public/ (auto-detect skipped).'
                : diagnostics
                ? `${diagnostics.backendUsed} · Peak ${(diagnostics.peakAmplitude * 100).toFixed(0)}% · ${diagnostics.chunksProcessed} chunks`
                : 'public/: <track>.stepsync.json · <track>.stepsync.cache · <track>_drums.wav'}
            </span>
            <div className="inline-flex flex-wrap items-center gap-0.5 shrink-0">
              {onImportAnalysisCache && (
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => cacheFileInputRef.current?.click()}
                  className="px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-gray-200 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <Upload className="w-3 h-3" />
                  <span>Load .cache</span>
                </button>
              )}
              {hasCachedAnalysis && onDownloadAnalysisCache && (
                <button
                  type="button"
                  onClick={onDownloadAnalysisCache}
                  className="px-1.5 py-0.5 rounded-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                  title="Download .stepsync.cache (envelopes + 4096-FFT spectrogram) to drop into public/"
                >
                  <Download className="w-3 h-3" />
                  <span>Save .cache</span>
                </button>
              )}
              {hasDrumStem && (
                <button
                  type="button"
                  onClick={onDownloadDrumStem}
                  className="px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-emerald-300 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                  title="Download isolated drum stem as 16-bit WAV"
                >
                  <Download className="w-3 h-3" />
                  <span>Save .wav</span>
                </button>
              )}
              {(hasDrumStem || hasCachedAnalysis) && onDiscardAndRecalculate && (
                <button
                  type="button"
                  onClick={onDiscardAndRecalculate}
                  className="px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-gray-200 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                  title="Discard cached envelopes and recalculate detection from scratch"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Recalculate</span>
                </button>
              )}
              {(hasDrumStem || hasCachedAnalysis) && onDiscardMemoryClean && (
                <button
                  type="button"
                  onClick={onDiscardMemoryClean}
                  className="px-1.5 py-0.5 rounded-sm hover:bg-red-500/15 text-gray-400 hover:text-red-300 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                  title="Discard saved memory (clean start, not recommended — pauses auto-detection)"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Clean Start</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Progress State */}
      {isRunning && (
        <div className="pt-1 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-200 font-medium">{stageLabel || 'Processing...'}</span>
            <span className="font-mono tabular-nums text-emerald-400">{progress}%</span>
          </div>
          <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-150 ease-out"
              style={{ width: `${Math.max(2, progress)}%` }}
            />
          </div>
        </div>
      )}

      {/* Error State */}
      {status === 'error' && errorMessage && (
        <div className="bg-red-500/10 rounded-sm px-2 py-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-start gap-1.5 text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          {engineMode === 'webgpu-demucs' && (
            <button
              type="button"
              onClick={() => setEngineMode('dsp-hpss')}
              className="px-2 py-0.5 text-xs font-medium rounded-sm hover:bg-white/10 text-white whitespace-nowrap shrink-0"
            >
              Switch to Instant DSP
            </button>
          )}
        </div>
      )}

      {/* Diagnostic Warning */}
      {diagnostics?.note && !isRunning && (
        <div className="text-amber-300 flex items-center gap-1.5 text-xs pt-0.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{diagnostics.note}</span>
        </div>
      )}

      {/* Populated State: Pure Borderless Sheet Lane Manager */}
      {(hasDrumStem || hasCachedAnalysis) && !isRunning && (
        <div className="pt-1 space-y-1">
          {/* Lane Manager Header */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-gray-300">Lanes</span>
              <span className="text-gray-500 font-mono tabular-nums">
                {laneRules.filter((r) => r.enabled).length} active · {drumEvents.length} hits
              </span>
            </div>
            <div className="inline-flex items-center gap-0.5">
              <button
                type="button"
                onClick={onResetLaneRules}
                className="px-1.5 py-0.5 text-xs rounded-sm text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors whitespace-nowrap shrink-0"
              >
                Reset
              </button>
              {onAddTomPreset && !laneRules.some((r) => r.name.toLowerCase().includes('tom')) && (
                <button
                  type="button"
                  onClick={onAddTomPreset}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-sm bg-pink-500/15 hover:bg-pink-500/25 text-pink-300 transition-colors whitespace-nowrap shrink-0"
                  title="Add modular Tom preset (110–300 Hz)"
                >
                  <Plus className="w-3 h-3" />
                  <span>Tom</span>
                </button>
              )}
              <button
                type="button"
                onClick={onAddLaneRule}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-sm hover:bg-white/[0.06] text-gray-200 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3 h-3" />
                <span>Add Lane</span>
              </button>
            </div>
          </div>

          {/* Flat Sheet Lane Rows (zero horizontal lines, zero cell borders) */}
          <div className="space-y-0.5">
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
                    'py-0.5 flex flex-wrap lg:flex-nowrap items-center justify-between gap-2 transition-opacity hover:bg-white/[0.02] rounded-sm',
                    !rule.enabled && 'opacity-50'
                  )}
                >
                  {/* Enable + Color + Name */}
                  <div className="flex items-center gap-1.5 min-w-[10.5rem]">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => onUpdateLaneRule(rule.id, { enabled: e.target.checked })}
                      className={cn(
                        'rounded border-gray-700 bg-transparent w-3.5 h-3.5 cursor-pointer shrink-0',
                        style.checkbox
                      )}
                    />
                    <button
                      type="button"
                      onClick={cycleColor}
                      className={cn('w-2.5 h-2.5 rounded-full shrink-0 hover:scale-110 transition-transform', style.dot)}
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
                        'bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-1.5 py-0.5 text-xs font-medium w-28 focus:outline-none',
                        style.text
                      )}
                    />
                    <span className="text-xs font-mono text-gray-500">[{rule.badge}]</span>
                  </div>

                  {/* Frequency Range (Hz) + Apply Solo */}
                  <div className="flex items-center gap-1 text-xs font-mono tabular-nums shrink-0">
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
                    <span className="text-xs text-gray-500 pl-0.5">Hz</span>

                    {activeSoloBand && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateLaneRule(rule.id, {
                            minHz: Math.round(activeSoloBand.minHz),
                            maxHz: Math.round(activeSoloBand.maxHz),
                          })
                        }
                        className="ml-1 px-1.5 py-0.5 text-xs rounded-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 whitespace-nowrap"
                        title="Apply currently soloed Spectrum range to this lane"
                      >
                        Use Solo
                      </button>
                    )}
                  </div>

                  {/* Flat Key Assignment, Alt Key & Rate Limiter */}
                  {(() => {
                    const altLane = getEffectiveAltLane(rule);
                    const isAlt = altLane !== null;
                    const altOptions = LANE_KEYS.filter((lk) => lk.lane !== rule.lane);
                    return (
                      <div className="inline-flex items-center gap-0.5 shrink-0">
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
                              'px-1.5 py-0.5 text-xs font-mono rounded-sm transition-colors',
                              rule.lane === lk.lane
                                ? 'bg-white/15 text-white font-semibold'
                                : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.06]'
                            )}
                            title={`Map primary hits to lane ${lk.label}`}
                          >
                            {lk.label}
                          </button>
                        ))}

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
                            'bg-transparent hover:bg-white/[0.06] rounded-sm px-1.5 py-0.5 text-xs font-mono focus:outline-none cursor-pointer transition-colors',
                            isAlt ? 'text-sky-300 font-semibold' : 'text-gray-300'
                          )}
                          title="Fixed keeps all hits on the selected key; picking an Alt key alternates between Primary (even) and Alt (odd)"
                        >
                          <option value="fixed" className="bg-gray-950 text-gray-200">
                            Fixed
                          </option>
                          {altOptions.map((lk) => (
                            <option
                              key={lk.lane}
                              value={String(lk.lane)}
                              className="bg-gray-950 text-gray-200"
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
                          className="bg-transparent hover:bg-white/[0.06] rounded-sm px-1.5 py-0.5 text-xs font-mono tabular-nums text-gray-200 focus:outline-none cursor-pointer"
                          title="Max 1/N limits speed; On 1/N locks hits to the 1/N beat grid and ignores off-grid subdivisions"
                        >
                          <option value="off" className="bg-gray-950 text-gray-200">Limit: Off</option>
                          <option value="4" className="bg-gray-950 text-gray-200">Max 1/4</option>
                          <option value="on-4" className="bg-gray-950 text-gray-200">On 1/4</option>
                          <option value="8" className="bg-gray-950 text-gray-200">Max 1/8</option>
                          <option value="on-8" className="bg-gray-950 text-gray-200">On 1/8</option>
                          <option value="16" className="bg-gray-950 text-gray-200">Max 1/16</option>
                          <option value="on-16" className="bg-gray-950 text-gray-200">On 1/16</option>
                          <option value="32" className="bg-gray-950 text-gray-200">Max 1/32</option>
                        </select>
                      </div>
                    );
                  })()}

                  {/* Sensitivity & Hit Count */}
                  <div className="flex items-center gap-2 flex-1 min-w-[11rem] lg:max-w-[15rem]">
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
                    <span className="text-xs font-mono tabular-nums text-gray-400 w-9 text-right shrink-0">
                      {rule.enabled ? `${count}` : 'Off'}
                    </span>
                    {!rule.isDefault && (
                      <button
                        type="button"
                        onClick={() => onRemoveLaneRule(rule.id)}
                        className="p-0.5 text-gray-500 hover:text-red-400 transition-colors shrink-0"
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
        </div>
      )}
    </section>
  );
}
