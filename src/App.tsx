import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Upload,
  Copy,
  Trash2,
  Plus,
  Activity,
  Settings2,
  Gamepad2,
  Volume2,
  VolumeX,
  AlertCircle,
  Download,
  FolderOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { engine, SimDrumBand } from './lib/AudioEngine';
import { analyzeAudio, detectOnsets } from './lib/audioProcessing';
import {
  applyManualEditsToEvents,
  computeSectionDifficultyCounts,
  DEFAULT_DIFFICULTY_MATRIX,
  DEFAULT_LANE_RULES,
  detectDrumEventsFromEnvelopes,
} from './lib/drumAnalysis';
import {
  analyzePreSeparatedDrumBuffer,
  audioBufferToWavBlob,
  cancelActiveSeparation,
  checkDemucsModelCached,
  checkWebGpuSupport,
  clearDemucsModelCache,
  createAudioBufferFromChannels,
  separateDrumStem,
} from './lib/stemWorkerClient';
import {
  CachedDrumPcm,
  decodeAnalysisCacheArrayBuffer,
  deleteTrackFromStorageDb,
  encodeAnalysisCacheBlob,
  loadTrackFromStorageDb,
  saveTrackToStorageDb,
  triggerBlobDownload,
} from './lib/projectCache';
import {
  Section,
  SectionDensity,
  SyncData,
  AudioMetadata,
  StemEngineMode,
  StemStatus,
  BandEnvelopes,
  DrumEvent,
  DrumLaneRule,
  ChartDifficulty,
  DensitySubdivisionCap,
  DifficultyDensityMatrix,
  MaxChordsCap,
  SpectralEnvelopeCache,
  SeparationDiagnostics,
  LaneIndex,
  ManualNoteEdits,
  SimSoundMode,
  StepSyncProject,
  WindshieldPreset,
} from './types';
import { cn } from './lib/utils';
import { Waveform } from './components/Waveform';
import { Simulator } from './components/Simulator';
import { StaticWaveform } from './components/StaticWaveform';
import { AuditionMode, CacheSourceKind, StemStudio } from './components/StemStudio';
import { GlobalTransport } from './components/GlobalTransport';
import { SpectrumVisualizer } from './components/SpectrumVisualizer';

export default function App() {
  const [audioMeta, setAudioMeta] = useState<AudioMetadata | null>({
    fileName: 'example_track.mp3',
    sampleRate: 44100,
    duration: 184.23,
  });

  const [rawEvents, setRawEvents] = useState<any[]>([]);
  const [autoQuantize, setAutoQuantize] = useState(true);
  const [delayCompensation, setDelayCompensation] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [sync, setSync] = useState<SyncData>({
    bpm: 96.0,
    offset: 0.16,
    metronomeActive: false,
    volume: 1.0,
  });

  const [sections, setSections] = useState<Section[]>([
    { id: '1', beat: 0, label: 'Intro', density: 'Medium', preset: 'milkdrop' },
    { id: '2', beat: 16, label: 'Chorus', density: 'Dense', preset: 'glsl-space' },
    { id: '3', beat: 48, label: 'Verse 1', density: 'Medium', preset: 'wormhole' },
    { id: '4', beat: 80, label: 'instrumental', density: 'Medium', preset: 'music-rain' },
    { id: '5', beat: 104, label: 'Chorus', density: 'Dense', preset: 'glsl-space' },
    { id: '6', beat: 136, label: 'instrumental', density: 'Dense', preset: 'music-rain' },
    { id: '7', beat: 144, label: 'Verse 2', density: 'Sparse', preset: 'wormhole' },
    { id: '8', beat: 176, label: 'instrumental', density: 'Dense', preset: 'music-rain' },
    { id: '9', beat: 200, label: 'Chorus', density: 'Medium', preset: 'glsl-space' },
    { id: '10', beat: 232, label: 'Verse 3', density: 'Sparse', preset: 'wormhole' },
    { id: '11', beat: 296, label: 'instrumental', density: 'Dense', preset: 'music-rain' },
    { id: '12', beat: 304, label: 'Chorus', density: 'Medium', preset: 'glsl-space' },
    { id: '13', beat: 336, label: 'instrumental', density: 'Sparse', preset: 'milkdrop' },
  ]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'editor' | 'simulate'>('editor');
  const [outputTab, setOutputTab] = useState<'sm' | 'llm' | 'project'>('sm');
  const [isSimulatorRecording, setIsSimulatorRecording] = useState(false);

  const [taps, setTaps] = useState<number[]>([]);
  const [isLooping, setIsLooping] = useState(true);
  const [isDraggingAudio, setIsDraggingAudio] = useState(false);
  const dragDepthRef = useRef(0);

  // Stem Separation & Band Analysis state
  const [engineMode, setEngineMode] = useState<StemEngineMode>('webgpu-demucs');
  const [webGpuInfo, setWebGpuInfo] = useState<{ available: boolean; reason?: string }>({
    available: false,
  });
  const [modelCached, setModelCached] = useState(false);
  const [stemStatus, setStemStatus] = useState<StemStatus>('idle');
  const [stemProgress, setStemProgress] = useState(0);
  const [stemStage, setStemStage] = useState('');
  const [stemError, setStemError] = useState<string | null>(null);
  const [stemDiagnostics, setStemDiagnostics] = useState<SeparationDiagnostics | null>(null);

  const [drumBuffer, setDrumBuffer] = useState<AudioBuffer | null>(null);
  const [bandEnvelopes, setBandEnvelopes] = useState<BandEnvelopes | null>(null);
  const [spectralCache, setSpectralCache] = useState<SpectralEnvelopeCache | null>(null);
  const [laneRules, setLaneRules] = useState<DrumLaneRule[]>(DEFAULT_LANE_RULES);
  const [activeSoloBand, setActiveSoloBand] = useState<{ minHz: number; maxHz: number } | null>(null);
  const [auditionMode, setAuditionMode] = useState<AuditionMode>('mix');
  const [blendRatio, setBlendRatio] = useState(0.8);
  const [showDrumMarkers, setShowDrumMarkers] = useState(true);
  const [quantizeDrums, setQuantizeDrums] = useState(false);
  const [sectionLaneFilter, setSectionLaneFilter] = useState<string>('all');
  const [sectionMetricMode, setSectionMetricMode] = useState<'avg' | 'cnt'>('avg');
  const [simulatorDifficulty, setSimulatorDifficulty] = useState<ChartDifficulty>('hard');
  const [difficultyMatrix, setDifficultyMatrix] = useState<DifficultyDensityMatrix>(
    DEFAULT_DIFFICULTY_MATRIX
  );
  const [simSoundMode, setSimSoundMode] = useState<SimSoundMode>('sync');
  const [simSoundEnabled, setSimSoundEnabled] = useState<Record<SimDrumBand, boolean>>({
    kick: false,
    snare: false,
    hat: false,
    tom: false,
  });
  const [simVolume, setSimVolume] = useState(0.85);
  const [manualEdits, setManualEdits] = useState<ManualNoteEdits>({
    suppressions: [],
    additions: [],
  });
  const [manualEditHistory, setManualEditHistory] = useState<ManualNoteEdits[]>([]);
  const [projectStatus, setProjectStatus] = useState<{
    type: 'ok' | 'error';
    text: string;
  } | null>(null);
  const [cacheSource, setCacheSource] = useState<CacheSourceKind>(null);
  const [spectralBuildNonce, setSpectralBuildNonce] = useState(0);
  const [hydratedFileKey, setHydratedFileKey] = useState<string | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [startDraft, setStartDraft] = useState('');
  const [startFocused, setStartFocused] = useState(false);
  const [endDraft, setEndDraft] = useState('');
  const [endFocused, setEndFocused] = useState(false);
  const endFocusLockedNRef = useRef<number | null>(null);
  const [sectionsPanelOpen, setSectionsPanelOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [outputsPanelOpen, setOutputsPanelOpen] = useState(false);
  const [rootFontPx, setRootFontPx] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem('stepsync-root-font-px') || '20', 10);
      if (!Number.isNaN(saved) && saved >= 18 && saved <= 28) return saved;
    } catch {
      // Ignore storage access errors
    }
    return 20;
  });

  useEffect(() => {
    document.documentElement.style.fontSize = `${rootFontPx}px`;
    try {
      localStorage.setItem('stepsync-root-font-px', String(rootFontPx));
    } catch {
      // Ignore storage access errors
    }
  }, [rootFontPx]);

  const skipNextSpectralBuildForBufferRef = useRef<AudioBuffer | null>(null);
  const customDrumPcmRef = useRef<CachedDrumPcm | null>(null);
  const stemClearedRef = useRef<boolean>(false);

  useEffect(() => {
    checkWebGpuSupport().then(setWebGpuInfo);
    checkDemucsModelCached().then(setModelCached);
    return () => {
      cancelActiveSeparation();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsPlaying(engine.getIsPlaying());
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    engine.setSync(sync.bpm, sync.offset, sync.metronomeActive);
    engine.setTrackVolume(sync.volume);
  }, [sync]);

  useEffect(() => {
    engine.setSimVolume(simVolume);
  }, [simVolume]);

  useEffect(() => {
    engine.setLoop(isLooping);
  }, [isLooping]);

  // Keep AudioEngine stem mix levels synced
  useEffect(() => {
    if (!drumBuffer) {
      engine.setStemMix(1.0, 0.0);
      return;
    }
    if (auditionMode === 'mix') {
      engine.setStemMix(1.0, 0.0);
    } else if (auditionMode === 'drums') {
      engine.setStemMix(0.0, 1.0);
    } else {
      engine.setStemMix(1.0 - blendRatio * 0.75, blendRatio);
    }
  }, [auditionMode, blendRatio, drumBuffer]);

  // Pre-build 4096-FFT spectral cache in background Web Worker whenever a drum stem is set
  useEffect(() => {
    if (!drumBuffer) {
      setSpectralCache(null);
      return;
    }

    if (skipNextSpectralBuildForBufferRef.current === drumBuffer) {
      skipNextSpectralBuildForBufferRef.current = null;
      return;
    }

    const ch0 = drumBuffer.getChannelData(0);
    const mono = new Float32Array(ch0.length);
    if (drumBuffer.numberOfChannels > 1) {
      const ch1 = drumBuffer.getChannelData(1);
      for (let i = 0; i < ch0.length; i++) {
        mono[i] = 0.5 * (ch0[i] + ch1[i]);
      }
    } else {
      mono.set(ch0);
    }

    let cancelled = false;
    const worker = new Worker(
      new URL('./workers/spectralCache.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e: MessageEvent<SpectralEnvelopeCache>) => {
      if (!cancelled) {
        setSpectralCache(e.data);
      }
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
    };
    worker.postMessage({ mono, sampleRate: drumBuffer.sampleRate }, [mono.buffer]);

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [drumBuffer, spectralBuildNonce]);

  // Re-detect lane-mapped DrumEvents instantaneously whenever lane rules, Hz bounds, or sync change
  useEffect(() => {
    if (!bandEnvelopes) return;

    const events = detectDrumEventsFromEnvelopes(
      bandEnvelopes,
      laneRules,
      sync,
      quantizeDrums,
      spectralCache
    );
    const uniqueOnsets = [...new Set(events.map((e) => e.time))].sort((a, b) => a - b);
    setAudioMeta((prev) =>
      prev
        ? {
            ...prev,
            drumEvents: events,
            onsets: uniqueOnsets,
          }
        : null
    );
  }, [bandEnvelopes, laneRules, sync.bpm, sync.offset, quantizeDrums, spectralCache]);

  const extractDrumPcm = (buf: AudioBuffer): CachedDrumPcm => {
    const ch0 = buf.getChannelData(0);
    const left = new Float32Array(ch0.length);
    left.set(ch0);
    const right = new Float32Array(ch0.length);
    if (buf.numberOfChannels > 1) {
      right.set(buf.getChannelData(1));
    } else {
      right.set(ch0);
    }
    return { sampleRate: buf.sampleRate, left, right };
  };

  const fetchPublicCompanionProject = async (
    audioFileName: string
  ): Promise<StepSyncProject | null> => {
    const baseName = audioFileName.replace(/\.[^/.]+$/, '');
    try {
      const res = await fetch(`/${encodeURIComponent(baseName)}.stepsync.json`);
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) return null;
      const parsed = (await res.json()) as Partial<StepSyncProject>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.version !== 1 ||
        !parsed.sync ||
        !Array.isArray(parsed.sections) ||
        !Array.isArray(parsed.laneRules)
      ) {
        return null;
      }
      return parsed as StepSyncProject;
    } catch {
      return null;
    }
  };

  const fetchPublicAnalysisCache = async (audioFileName: string) => {
    const baseName = audioFileName.replace(/\.[^/.]+$/, '');
    try {
      const res = await fetch(`/${encodeURIComponent(baseName)}.stepsync.cache`);
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) return null;
      return await decodeAnalysisCacheArrayBuffer(buf);
    } catch {
      return null;
    }
  };

  const fetchCompanionDrumAudioOnly = async (
    audioFileName: string,
    audioCtx: AudioContext
  ): Promise<{ buffer: AudioBuffer; url: string } | null> => {
    const baseName = audioFileName.replace(/\.[^/.]+$/, '');
    const candidates = [
      `/${encodeURIComponent(baseName)}_drums.mp3`,
      `/${encodeURIComponent(baseName)}_drums.wav`,
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) continue;
        const arr = await res.arrayBuffer();
        if (arr.byteLength === 0) continue;
        const buffer = await audioCtx.decodeAudioData(arr);
        return { buffer, url };
      } catch {
        // Ignore missing/unreadable candidate and check next
      }
    }
    return null;
  };

  const applyProjectSettings = (parsed: Partial<StepSyncProject>) => {
    if (
      parsed.sync &&
      typeof parsed.sync.bpm === 'number' &&
      typeof parsed.sync.offset === 'number'
    ) {
      setSync({
        bpm: parsed.sync.bpm,
        offset: parsed.sync.offset,
        metronomeActive: Boolean(parsed.sync.metronomeActive),
        volume: typeof parsed.sync.volume === 'number' ? parsed.sync.volume : 1.0,
      });
    }

    if (Array.isArray(parsed.sections)) {
      setSections(parsed.sections);
    }
    if (parsed.difficultyMatrix) {
      setDifficultyMatrix(parsed.difficultyMatrix);
    }
    if (Array.isArray(parsed.laneRules)) {
      setLaneRules(parsed.laneRules);
    }
    if (typeof parsed.quantizeDrums === 'boolean') setQuantizeDrums(parsed.quantizeDrums);
    if (typeof parsed.delayCompensation === 'number') setDelayCompensation(parsed.delayCompensation);
    if (
      parsed.auditionMode === 'mix' ||
      parsed.auditionMode === 'drums' ||
      parsed.auditionMode === 'blend'
    ) {
      setAuditionMode(parsed.auditionMode);
    }
    if (typeof parsed.blendRatio === 'number') setBlendRatio(parsed.blendRatio);
    if (
      parsed.simulatorDifficulty === 'easy' ||
      parsed.simulatorDifficulty === 'normal' ||
      parsed.simulatorDifficulty === 'hard'
    ) {
      setSimulatorDifficulty(parsed.simulatorDifficulty);
    }
    if (
      parsed.simSoundMode === 'demo' ||
      parsed.simSoundMode === 'sync' ||
      parsed.simSoundMode === 'input'
    ) {
      setSimSoundMode(parsed.simSoundMode);
    }
    if (parsed.simSoundEnabled) {
      setSimSoundEnabled({
        kick: Boolean(parsed.simSoundEnabled.kick),
        snare: Boolean(parsed.simSoundEnabled.snare),
        hat: Boolean(parsed.simSoundEnabled.hat),
        tom: Boolean(parsed.simSoundEnabled.tom),
      });
    }
    if (typeof parsed.simVolume === 'number') setSimVolume(parsed.simVolume);

    if (
      parsed.manualEdits &&
      Array.isArray(parsed.manualEdits.suppressions) &&
      Array.isArray(parsed.manualEdits.additions)
    ) {
      setManualEdits(parsed.manualEdits);
    } else {
      setManualEdits({ suppressions: [], additions: [] });
    }
    setManualEditHistory([]);
  };

  const tryAutoLoadCompanionDrumStem = async (
    audioFileName: string,
    audioCtx: AudioContext
  ): Promise<boolean> => {
    const companion = await fetchCompanionDrumAudioOnly(audioFileName, audioCtx);
    if (!companion) return false;

    const { buffer: decodedDrum, url } = companion;
    const envelopes = analyzePreSeparatedDrumBuffer(decodedDrum);

    let peakAmplitude = 0;
    for (let ch = 0; ch < decodedDrum.numberOfChannels; ch++) {
      const data = decodedDrum.getChannelData(ch);
      for (let i = 0; i < data.length; i += 16) {
        const a = Math.abs(data[i]);
        if (a > peakAmplitude) peakAmplitude = a;
      }
    }

    customDrumPcmRef.current = null;
    stemClearedRef.current = false;
    setDrumBuffer(decodedDrum);
    setSpectralCache(null);
    engine.setDrumBuffer(decodedDrum);
    setBandEnvelopes(envelopes);
    setStemDiagnostics({
      backendUsed: `Pre-separated (${url})`,
      peakAmplitude,
      nanSamplesReplaced: 0,
      chunksProcessed: 1,
    });
    setStemStatus('ready');
    setStemProgress(100);
    setStemStage(`Loaded ${url}`);
    setCacheSource('computed');
    return true;
  };

  const hydrateTrackWithPublicAndDb = async (
    fileName: string,
    decodedData: AudioBuffer,
    audioCtx: AudioContext,
    fallbackMeta: AudioMetadata,
    applyFallbackSync?: () => Promise<void>
  ) => {
    const [dbEntry, publicProject, publicCache] = await Promise.all([
      loadTrackFromStorageDb(fileName),
      fetchPublicCompanionProject(fileName),
      fetchPublicAnalysisCache(fileName),
    ]);

    const dbUpdatedMs = dbEntry?.updatedAt ? Date.parse(dbEntry.updatedAt) : 0;
    const publicExportedMs = publicProject?.exportedAt ? Date.parse(publicProject.exportedAt) : 0;
    const preferPublicProject =
      Boolean(publicProject) && (!dbEntry?.project || publicExportedMs > dbUpdatedMs);
    const chosenProject = preferPublicProject
      ? publicProject
      : dbEntry?.project ?? publicProject ?? null;

    if (chosenProject) {
      applyProjectSettings(chosenProject);
    } else if (applyFallbackSync) {
      await applyFallbackSync();
    }

    // 1. User previously executed Clean Start / Clear Stem for this track: respect cleared state
    if (dbEntry?.stemCleared && !preferPublicProject) {
      stemClearedRef.current = true;
      customDrumPcmRef.current = null;
      setDrumBuffer(null);
      engine.setDrumBuffer(null);
      setBandEnvelopes(null);
      setSpectralCache(null);
      setStemDiagnostics(null);
      setStemStatus('idle');
      setStemProgress(0);
      setStemStage('');
      setAuditionMode('mix');
      setCacheSource('cleared');

      if (chosenProject?.drumEvents && chosenProject.drumEvents.length > 0) {
        const restoredEvents = chosenProject.drumEvents;
        const restoredOnsets = [...new Set(restoredEvents.map((ev) => ev.time))].sort(
          (a, b) => a - b
        );
        setAudioMeta({
          ...fallbackMeta,
          drumEvents: restoredEvents,
          onsets: restoredOnsets,
        });
      } else {
        setAudioMeta(fallbackMeta);
      }
      setHydratedFileKey(fileName);
      return;
    }

    // 2. Restore cached bandEnvelopes & spectralCache from StorageDB or /public/*.stepsync.cache
    const usePublicCache =
      Boolean(publicCache?.envelopes) &&
      (!dbEntry?.envelopes ||
        (dbEntry.source !== 'computed' && publicExportedMs > dbUpdatedMs));
    const resolvedEnvelopes = usePublicCache
      ? publicCache!.envelopes!
      : dbEntry?.envelopes ?? publicCache?.envelopes ?? null;

    if (resolvedEnvelopes) {
      const resolvedSource: 'public' | 'indexeddb' = usePublicCache
        ? 'public'
        : dbEntry?.envelopes
        ? 'indexeddb'
        : 'public';
      const resolvedSpectral =
        resolvedSource === 'public'
          ? publicCache?.spectralCache ?? null
          : dbEntry?.spectralCache ?? publicCache?.spectralCache ?? null;
      const resolvedDiagnostics =
        resolvedSource === 'public'
          ? publicCache?.diagnostics ?? null
          : dbEntry?.diagnostics ?? publicCache?.diagnostics ?? null;

      stemClearedRef.current = false;
      setAudioMeta(fallbackMeta);

      let restoredDrumBuffer: AudioBuffer | null = null;
      if (resolvedSource === 'indexeddb' && dbEntry?.drumPcm) {
        customDrumPcmRef.current = dbEntry.drumPcm;
        restoredDrumBuffer = createAudioBufferFromChannels(
          dbEntry.drumPcm.left,
          dbEntry.drumPcm.right,
          dbEntry.drumPcm.sampleRate
        );
      } else {
        customDrumPcmRef.current = null;
        const companion = await fetchCompanionDrumAudioOnly(fileName, audioCtx);
        restoredDrumBuffer = companion?.buffer ?? null;
      }

      if (restoredDrumBuffer) {
        if (resolvedSpectral) {
          skipNextSpectralBuildForBufferRef.current = restoredDrumBuffer;
        }
        setDrumBuffer(restoredDrumBuffer);
        engine.setDrumBuffer(restoredDrumBuffer);
      } else {
        setDrumBuffer(null);
        engine.setDrumBuffer(null);
      }

      setSpectralCache(resolvedSpectral);
      setBandEnvelopes(resolvedEnvelopes);
      setStemDiagnostics(resolvedDiagnostics);
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage(
        resolvedSource === 'public'
          ? 'Loaded cached analysis from public/'
          : 'Loaded cached analysis from browser storage'
      );
      setCacheSource(resolvedSource);

      if (resolvedSource === 'public') {
        await saveTrackToStorageDb({
          fileName,
          updatedAt: new Date().toISOString(),
          source: 'public',
          project: chosenProject ?? undefined,
          envelopes: resolvedEnvelopes,
          spectralCache: resolvedSpectral,
          diagnostics: resolvedDiagnostics,
          drumPcm: null,
          stemCleared: false,
        });
      }
      setHydratedFileKey(fileName);
      return;
    }

    // 3. No cached envelopes: check companion *_drums.mp3|.wav (unless we have a JSON-only chart with no drum file)
    stemClearedRef.current = false;
    setAudioMeta(fallbackMeta);
    const loadedCompanion = await tryAutoLoadCompanionDrumStem(fileName, audioCtx);
    if (!loadedCompanion && chosenProject?.drumEvents && chosenProject.drumEvents.length > 0) {
      const restoredEvents = chosenProject.drumEvents;
      const restoredOnsets = [...new Set(restoredEvents.map((ev) => ev.time))].sort(
        (a, b) => a - b
      );
      setAudioMeta({
        fileName,
        sampleRate: decodedData.sampleRate,
        duration: decodedData.duration,
        drumEvents: restoredEvents,
        onsets: restoredOnsets,
      });
      setStemStatus('idle');
      setCacheSource(publicProject ? 'public' : dbEntry ? 'indexeddb' : null);
    }

    setHydratedFileKey(fileName);
  };

  useEffect(() => {
    const loadDefaultAudio = async () => {
      try {
        setHydratedFileKey(null);
        const response = await fetch('/166.m4a');
        if (!response.ok) return;
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

        engine.setBuffer(decodedData);

        let initialOnsets: number[] = [];
        try {
          const eventsRes = await fetch('/recorded-events.json');
          if (eventsRes.ok) {
            const eventsData = await eventsRes.json();
            setRawEvents(eventsData);

            const secondsPerBeat = 60.0 / 96.0;
            const offset = 0.16;
            const userEvents = eventsData.filter((e: any) => e.source !== 'drum');
            let medianDelay = 0;
            if (userEvents.length > 0) {
              const diffs = userEvents.map((e: any) => {
                const beatFloat = (e.time - offset) / secondsPerBeat;
                const nearest16th = Math.round(beatFloat * 4) / 4;
                const idealTime = offset + nearest16th * secondsPerBeat;
                return e.time - idealTime;
              });
              diffs.sort((a: number, b: number) => a - b);
              medianDelay = diffs[Math.floor(diffs.length / 2)] || 0;
              setDelayCompensation(medianDelay);
            } else {
              setDelayCompensation(0);
            }

            const quantizedOnsets = eventsData.map((e: any) => {
              const adjustedTime = e.time - medianDelay;
              const beatFloat = (adjustedTime - offset) / secondsPerBeat;
              const nearest16th = Math.round(beatFloat * 4) / 4;
              return offset + nearest16th * secondsPerBeat;
            });
            initialOnsets = [...new Set<number>(quantizedOnsets)].sort((a, b) => a - b);
          } else {
            initialOnsets = await detectOnsets(decodedData);
          }
        } catch {
          initialOnsets = await detectOnsets(decodedData);
        }

        const fallbackMeta: AudioMetadata = {
          fileName: '166.m4a',
          sampleRate: decodedData.sampleRate,
          duration: decodedData.duration,
          onsets: initialOnsets,
        };

        await hydrateTrackWithPublicAndDb(
          '166.m4a',
          decodedData,
          audioCtx,
          fallbackMeta,
          async () => {
            setSync((s) => ({
              ...s,
              bpm: 96.0,
              offset: 0.16,
            }));
          }
        );
      } catch (e) {
        console.error('Failed to load default audio', e);
      }
    };
    loadDefaultAudio();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'KeyM' && !isSimulatorRecording) {
        setSync((s) => ({ ...s, metronomeActive: !s.metronomeActive }));
      } else if (e.code === 'KeyT' && !isSimulatorRecording) {
        handleTap();
      } else if (e.code === 'ArrowUp' && activeTab === 'editor' && !isSimulatorRecording) {
        setSync((s) => ({ ...s, offset: Number((s.offset + 0.005).toFixed(3)) }));
      } else if (e.code === 'ArrowDown' && activeTab === 'editor' && !isSimulatorRecording) {
        setSync((s) => ({ ...s, offset: Number((s.offset - 0.005).toFixed(3)) }));
      } else if (
        (e.code === 'ArrowLeft' || e.code === 'ArrowRight') &&
        activeTab === 'editor' &&
        !isSimulatorRecording &&
        engine.getBuffer()
      ) {
        e.preventDefault();
        const barSec = (60.0 / (sync.bpm || 120)) * 4;
        const delta = e.code === 'ArrowRight' ? barSec : -barSec;
        let cur = engine.getCurrentTime();
        const dur = engine.getDuration();
        if (engine.getLoop() && dur > 0) cur = cur % dur;
        engine.seek(Math.max(0, Math.min(dur, cur + delta)));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, sync, isSimulatorRecording, activeTab]);

  const togglePlay = () => {
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    } else {
      engine.play();
      setIsPlaying(true);
    }
  };

  const handleTap = () => {
    const now = Date.now();
    setTaps((prev) => {
      const newTaps = [...prev, now];
      if (newTaps.length > 1 && now - newTaps[newTaps.length - 2] > 2000) {
        return [now];
      }

      if (newTaps.length >= 4) {
        const recentTaps = newTaps.slice(-4);
        const intervals = [];
        for (let i = 1; i < recentTaps.length; i++) {
          intervals.push(recentTaps[i] - recentTaps[i - 1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const newBpm = Math.round((60000 / avgInterval) * 100) / 100;
        setSync((s) => ({ ...s, bpm: newBpm }));
      }
      return newTaps.slice(-4);
    });
  };

  const loadAudioFile = async (file: File) => {
    setUploadError(null);

    try {
      setHydratedFileKey(null);
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

      // Clear previous stem state cleanly before hydrating the newly loaded track
      cancelActiveSeparation();
      customDrumPcmRef.current = null;
      stemClearedRef.current = false;
      setCacheSource(null);
      setDrumBuffer(null);
      setBandEnvelopes(null);
      setSpectralCache(null);
      setStemDiagnostics(null);
      setStemStatus('idle');
      setStemError(null);
      setAuditionMode('mix');
      setRawEvents([]);
      setManualEdits({ suppressions: [], additions: [] });
      setManualEditHistory([]);
      setProjectStatus(null);

      const fallbackMeta: AudioMetadata = {
        fileName: file.name,
        sampleRate: decodedData.sampleRate,
        duration: decodedData.duration,
      };
      setAudioMeta(fallbackMeta);
      engine.setBuffer(decodedData);

      await hydrateTrackWithPublicAndDb(
        file.name,
        decodedData,
        audioCtx,
        fallbackMeta,
        async () => {
          const result = await analyzeAudio(decodedData);
          const onsets = await detectOnsets(decodedData);
          setAudioMeta({
            fileName: file.name,
            sampleRate: decodedData.sampleRate,
            duration: decodedData.duration,
            onsets,
          });
          setSync((s) => ({
            ...s,
            bpm: result.bpm,
            offset: Number(result.offset.toFixed(3)),
          }));
        }
      );
    } catch {
      setUploadError('Unsupported audio encoding. Please try a standard WAV, MP3, OGG, or M4A file.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadAudioFile(file);
    e.target.value = '';
  };

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'));

    const onWindowDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingAudio(true);
    };
    const onWindowDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onWindowDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingAudio(false);
      }
    };
    const onWindowDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingAudio(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        loadAudioFile(file);
      }
    };

    window.addEventListener('dragenter', onWindowDragEnter);
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('drop', onWindowDrop);
    return () => {
      window.removeEventListener('dragenter', onWindowDragEnter);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('drop', onWindowDrop);
    };
  }, []);

  const handleStartSeparation = async (customModelFile?: File) => {
    const sourceBuf = engine.getBuffer();
    if (!sourceBuf) return;

    setStemError(null);
    setStemDiagnostics(null);
    setStemProgress(0);
    setStemStatus(engineMode === 'webgpu-demucs' ? 'loading-model' : 'processing');
    setStemStage(
      engineMode === 'webgpu-demucs'
        ? 'Preparing HT-Demucs WebGPU worker...'
        : 'Starting HPSS percussion separation...'
    );

    try {
      const customBuffer = customModelFile ? await customModelFile.arrayBuffer() : undefined;
      const result = await separateDrumStem(
        sourceBuf,
        engineMode,
        {
          onProgress: (progress, stage, status) => {
            setStemProgress(progress);
            setStemStage(stage);
            setStemStatus(status);
          },
        },
        customBuffer
      );

      customDrumPcmRef.current = extractDrumPcm(result.drumBuffer);
      stemClearedRef.current = false;
      setDrumBuffer(result.drumBuffer);
      setSpectralCache(null);
      engine.setDrumBuffer(result.drumBuffer);
      setBandEnvelopes(result.envelopes);
      setStemDiagnostics(result.diagnostics);
      setAuditionMode('drums');
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage('Drum stem isolated');
      setCacheSource('computed');

      if (engineMode === 'webgpu-demucs') {
        setModelCached(true);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Drum stem separation failed.';
      setStemStatus('error');
      setStemError(message);
    }
  };

  const handleCancelSeparation = () => {
    cancelActiveSeparation();
    setStemStatus(drumBuffer ? 'ready' : 'idle');
    setStemProgress(0);
    setStemStage('');
  };

  const handleImportDrumStem = async (file: File) => {
    setStemError(null);
    setStemStatus('processing');
    setStemProgress(30);
    setStemStage(`Decoding imported drum stem (${file.name})...`);
    try {
      const arr = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decodedDrum = await audioCtx.decodeAudioData(arr);

      // If no main track is loaded yet, also use this as main buffer
      if (!engine.getBuffer()) {
        engine.setBuffer(decodedDrum);
        setAudioMeta({
          fileName: file.name,
          sampleRate: decodedDrum.sampleRate,
          duration: decodedDrum.duration,
        });
        setHydratedFileKey(file.name);
      }

      setStemProgress(70);
      setStemStage('Extracting Kick, Snare/Clap, and Hi-Hat bands...');
      const envelopes = analyzePreSeparatedDrumBuffer(decodedDrum);

      let peakAmplitude = 0;
      for (let ch = 0; ch < decodedDrum.numberOfChannels; ch++) {
        const data = decodedDrum.getChannelData(ch);
        for (let i = 0; i < data.length; i += 16) {
          const a = Math.abs(data[i]);
          if (a > peakAmplitude) peakAmplitude = a;
        }
      }

      customDrumPcmRef.current = extractDrumPcm(decodedDrum);
      stemClearedRef.current = false;
      setDrumBuffer(decodedDrum);
      setSpectralCache(null);
      engine.setDrumBuffer(decodedDrum);
      setBandEnvelopes(envelopes);
      setStemDiagnostics({
        backendUsed: 'Imported WAV/Audio',
        peakAmplitude,
        nanSamplesReplaced: 0,
        chunksProcessed: 1,
      });
      setAuditionMode('drums');
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage('Imported drum stem ready');
      setCacheSource('computed');
    } catch {
      setStemStatus('error');
      setStemError('Could not decode the imported drum stem audio file.');
    }
  };

  const handleDownloadDrumStem = () => {
    if (!drumBuffer) return;
    const blob = audioBufferToWavBlob(drumBuffer);
    const baseName = (audioMeta?.fileName || 'track').replace(/\.[^/.]+$/, '');
    triggerBlobDownload(blob, `${baseName}_drums.wav`);
  };

  const handleClearModelCache = async () => {
    await clearDemucsModelCache();
    setModelCached(false);
  };

  const handleResetDrums = () => {
    cancelActiveSeparation();
    customDrumPcmRef.current = null;
    stemClearedRef.current = true;
    setDrumBuffer(null);
    setSpectralCache(null);
    engine.setDrumBuffer(null);
    setBandEnvelopes(null);
    setStemDiagnostics(null);
    setStemStatus('idle');
    setStemProgress(0);
    setStemStage('');
    setAuditionMode('mix');
    setCacheSource('cleared');
  };

  const handleDownloadAnalysisCache = async () => {
    if ((!bandEnvelopes && !spectralCache) || !audioMeta?.fileName) {
      setProjectStatus({ type: 'error', text: 'No computed analysis cache available yet.' });
      return;
    }
    try {
      const blob = await encodeAnalysisCacheBlob({
        fileName: audioMeta.fileName,
        envelopes: bandEnvelopes,
        spectralCache,
        diagnostics: stemDiagnostics,
      });
      const baseName = audioMeta.fileName.replace(/\.[^/.]+$/, '');
      triggerBlobDownload(blob, `${baseName}.stepsync.cache`);
      setProjectStatus({ type: 'ok', text: `Saved ${baseName}.stepsync.cache` });
    } catch {
      setProjectStatus({ type: 'error', text: 'Failed to export .stepsync.cache file.' });
    }
  };

  const handleImportAnalysisCache = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const decoded = await decodeAnalysisCacheArrayBuffer(buf);
      if (!decoded || !decoded.envelopes) {
        setProjectStatus({ type: 'error', text: 'Invalid .stepsync.cache file.' });
        return;
      }
      stemClearedRef.current = false;
      setSpectralCache(decoded.spectralCache);
      setBandEnvelopes(decoded.envelopes);
      setStemDiagnostics(decoded.diagnostics);
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage(`Imported ${file.name}`);
      setCacheSource('computed');
      setProjectStatus({ type: 'ok', text: `Loaded ${file.name}` });
    } catch {
      setProjectStatus({ type: 'error', text: 'Failed to read .stepsync.cache file.' });
    }
  };

  const handleDiscardMemoryClean = async () => {
    cancelActiveSeparation();
    const fileName = audioMeta?.fileName;
    customDrumPcmRef.current = null;
    stemClearedRef.current = true;
    setDrumBuffer(null);
    engine.setDrumBuffer(null);
    setBandEnvelopes(null);
    setSpectralCache(null);
    setStemDiagnostics(null);
    setStemStatus('idle');
    setStemProgress(0);
    setStemStage('');
    setAuditionMode('mix');
    setManualEdits({ suppressions: [], additions: [] });
    setManualEditHistory([]);
    setLaneRules(DEFAULT_LANE_RULES);
    setAudioMeta((prev) => (prev ? { ...prev, drumEvents: undefined } : null));
    setCacheSource('cleared');
    setProjectStatus({ type: 'ok', text: 'Memory discarded (clean start; auto-detect paused)' });

    if (fileName) {
      await deleteTrackFromStorageDb(fileName);
    }
  };

  const handleDiscardAndRecalculate = async () => {
    const fileName = audioMeta?.fileName;
    stemClearedRef.current = false;
    if (fileName) {
      await deleteTrackFromStorageDb(fileName);
    }

    if (drumBuffer) {
      setStemStatus('processing');
      setStemProgress(50);
      setStemStage('Recalculating drum envelopes & FFT spectrogram...');
      const envelopes = analyzePreSeparatedDrumBuffer(drumBuffer);
      setSpectralCache(null);
      setBandEnvelopes(envelopes);
      setSpectralBuildNonce((n) => n + 1);
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage('Recalculated from active drum stem');
      setCacheSource('computed');
      return;
    }

    if (fileName) {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const loaded = await tryAutoLoadCompanionDrumStem(fileName, audioCtx);
      if (loaded) return;
    }

    await handleStartSeparation();
  };

  const handleUpdateLaneRule = (id: string, updates: Partial<DrumLaneRule>) => {
    setLaneRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const handleAddLaneRule = () => {
    const customIndex = laneRules.filter((r) => !r.isDefault).length + 1;
    const minHz = activeSoloBand ? Math.max(20, Math.round(activeSoloBand.minHz)) : 110;
    const maxHz = activeSoloBand ? Math.min(16500, Math.round(activeSoloBand.maxHz)) : 300;
    const newRule: DrumLaneRule = {
      id: `custom-${Date.now()}`,
      name: customIndex === 1 ? 'Tom' : `Band ${customIndex}`,
      enabled: true,
      minHz,
      maxHz,
      sensitivity: 0.55,
      lane: 1, // F
      altLane: null,
      distributeEvenOdd: false,
      distributeMode: 'fixed',
      limiter: 16,
      color: 'pink',
      badge: 'T',
      isDefault: false,
    };
    setLaneRules((prev) => [...prev, newRule]);
  };

  const handleAddTomPreset = () => {
    const hasTom = laneRules.some(
      (r) => r.id === 'tom' || r.name.trim().toLowerCase() === 'tom'
    );
    if (hasTom) return;
    const newRule: DrumLaneRule = {
      id: 'tom',
      name: 'Tom',
      enabled: true,
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
    };
    setLaneRules((prev) => [...prev, newRule]);
  };

  const handleRemoveLaneRule = (id: string) => {
    setLaneRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleResetLaneRules = () => {
    setLaneRules(DEFAULT_LANE_RULES);
  };

  const pushManualEditHistory = (snapshot: ManualNoteEdits) => {
    setManualEditHistory((prev) => [...prev.slice(-39), snapshot]);
  };

  const handleToggleNoteAt = ({
    existingEvent,
    time,
    beat,
    rule,
    lane,
  }: {
    existingEvent?: DrumEvent;
    time: number;
    beat: number;
    rule: DrumLaneRule;
    lane: LaneIndex;
  }) => {
    pushManualEditHistory(manualEdits);
    if (existingEvent) {
      const addIdx = manualEdits.additions.findIndex(
        (a) =>
          a.band === existingEvent.band &&
          a.lane === existingEvent.lane &&
          Math.abs(a.time - existingEvent.time) <= 0.025
      );
      if (addIdx !== -1) {
        setManualEdits((prev) => ({
          ...prev,
          additions: prev.additions.filter((_, i) => i !== addIdx),
        }));
        return;
      }

      const supId = `sup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setManualEdits((prev) => ({
        ...prev,
        suppressions: [
          ...prev.suppressions,
          {
            id: supId,
            time: existingEvent.time,
            beat: existingEvent.beat,
            band: existingEvent.band,
            lane: existingEvent.lane,
          },
        ],
      }));
      return;
    }

    const supIdx = manualEdits.suppressions.findIndex(
      (sup) =>
        sup.band === rule.id &&
        (Math.abs(sup.time - time) <= 0.045 ||
          (sup.beat !== undefined && Math.abs(sup.beat - beat) <= 0.09))
    );
    if (supIdx !== -1) {
      setManualEdits((prev) => ({
        ...prev,
        suppressions: prev.suppressions.filter((_, i) => i !== supIdx),
      }));
      return;
    }

    const addId = `add-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setManualEdits((prev) => ({
      ...prev,
      additions: [
        ...prev.additions,
        {
          id: addId,
          time,
          beat,
          band: rule.id,
          lane,
          color: rule.color,
          badge: rule.badge,
        },
      ],
    }));
  };

  const handleUndoEdit = () => {
    setManualEditHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setManualEdits(last);
      return prev.slice(0, -1);
    });
  };

  const handleResetEdits = () => {
    if (manualEdits.suppressions.length === 0 && manualEdits.additions.length === 0) return;
    pushManualEditHistory(manualEdits);
    setManualEdits({ suppressions: [], additions: [] });
  };

  const addSection = () => {
    const lastBeat = sections.length > 0 ? sections[sections.length - 1].beat : 0;
    setSections([
      ...sections,
      {
        id: Math.random().toString(),
        beat: lastBeat + 32.0,
        label: 'New Section',
        density: 'Medium',
      },
    ]);
  };

  const removeSection = (id: string) => {
    setSections(sections.filter((s) => s.id !== id));
  };

  const updateSection = (id: string, updates: Partial<Section>) => {
    setSections(sections.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  };

  const activeSectionLaneFilter = useMemo(() => {
    if (sectionLaneFilter.startsWith('band:')) {
      const id = sectionLaneFilter.slice(5);
      if (!laneRules.some((r) => r.id === id)) return 'all';
    }
    return sectionLaneFilter;
  }, [sectionLaneFilter, laneRules]);

  const effectiveDrumEvents = useMemo(
    () => applyManualEditsToEvents(audioMeta?.drumEvents || [], manualEdits, sync, laneRules),
    [audioMeta?.drumEvents, manualEdits, sync, laneRules]
  );

  const tomBandIds = useMemo(
    () =>
      laneRules
        .filter((r) => r.id === 'tom' || r.name.trim().toLowerCase().includes('tom'))
        .map((r) => r.id),
    [laneRules]
  );

  const simulatorAudioMeta = useMemo(
    () => (audioMeta ? { ...audioMeta, drumEvents: effectiveDrumEvents } : null),
    [audioMeta, effectiveDrumEvents]
  );

  const sectionDifficultyCounts = useMemo(() => {
    const events: DrumEvent[] =
      effectiveDrumEvents.length > 0
        ? effectiveDrumEvents
        : (audioMeta?.onsets || []).map((time) => ({
            time,
            band: 'onset',
            energy: 1,
            lane: 1,
            source: 'drum',
          }));

    return computeSectionDifficultyCounts(
      sections,
      events,
      sync,
      difficultyMatrix,
      activeSectionLaneFilter,
      laneRules.map((r) => r.id),
      audioMeta?.duration || engine.getDuration()
    );
  }, [
    effectiveDrumEvents,
    audioMeta?.onsets,
    audioMeta?.duration,
    sections,
    sync,
    difficultyMatrix,
    activeSectionLaneFilter,
    laneRules,
  ]);

  const generateSMHeader = () => {
    return `#TITLE:${audioMeta?.fileName || 'My Track'};\n#OFFSET:${sync.offset.toFixed(3)};\n#BPMS:0.000=${sync.bpm.toFixed(2)};\n`;
  };

  const generateLLMPrompt = () => {
    const formatSub = (c: DensitySubdivisionCap) =>
      c === 0 ? 'Mute' : c === 'all' ? 'All' : `1/${c}`;
    const formatChord = (m: MaxChordsCap) =>
      m === 1 ? 'Single' : m === 2 ? 'Jump' : m === 3 ? 'Hand' : 'All';
    const sectionsText = sections
      .map((s) => {
        const caps = difficultyMatrix[s.density];
        return `- Beat ${s.beat}: ${s.label} (${s.density} — Easy: ${formatSub(caps.easy.subdivision)}/${formatChord(caps.easy.maxChords)}, Normal: ${formatSub(caps.normal.subdivision)}/${formatChord(caps.normal.maxChords)}, Hard: ${formatSub(caps.hard.subdivision)}/${formatChord(caps.hard.maxChords)})`;
      })
      .join('\n');

    const laneNames = ['Left', 'Down', 'Up', 'Right'];
    let rhythmHints = '';

    if (effectiveDrumEvents.length > 0) {
      const secondsPerBeat = 60.0 / sync.bpm;
      const mapped = effectiveDrumEvents
        .slice(0, 160)
        .map((ev) => {
          const beatFloat = (ev.time - sync.offset) / secondsPerBeat;
          const quantized = Math.round(beatFloat * 4) / 4;
          const bStr = Number.isInteger(quantized) ? quantized.toString() : quantized.toFixed(2);
          const bandLabel = ev.band === 'snare' ? 'CLAP' : ev.band.toUpperCase();
          return `${bStr}:${bandLabel}->${laneNames[ev.lane]}`;
        });
      rhythmHints = `\n\n=== DRUM-MAPPED EVENT MAP ===\nExtracted from isolated drum stem (Kick/Clap/Hi-Hat/Tom mapped to lanes):\n[ ${mapped.join(', ')}${effectiveDrumEvents.length > 160 ? ', ...' : ''} ]\n`;
    } else if (audioMeta?.onsets && audioMeta.onsets.length > 0) {
      const beatEvents: string[] = [];
      const secondsPerBeat = 60.0 / sync.bpm;
      for (const onset of audioMeta.onsets) {
        const beatFloat = (onset - sync.offset) / secondsPerBeat;
        if (beatFloat >= -0.5) {
          const quantized = Math.round(beatFloat * 4) / 4;
          const formatted = Number.isInteger(quantized) ? quantized.toString() : quantized.toFixed(2);
          if (!beatEvents.includes(formatted)) {
            beatEvents.push(formatted);
          }
        }
      }
      rhythmHints = `\n\n=== EVENT MAP ===\nHere is the actual detected transient rhythm map (quantized to nearest 16th). Place steps ONLY on these beats to sync with the music:\n[ ${beatEvents.slice(0, 150).join(', ')}${beatEvents.length > 150 ? ', ...' : ''} ]\n`;
    }

    return `I need you to generate a valid StepMania stepfile (.sm format) based on the timing rules.
Here is the extracted audio metadata:

- TITLE: ${audioMeta?.fileName || 'My Track'}
- BPM: ${sync.bpm}
- OFFSET: ${sync.offset}

The song sections and targeted density maps are as follows:
${sectionsText}${rhythmHints}

Follow the syntax format strictly:
1. Format all rows. 4 rows per measure = 4th notes, 8 rows = 8th notes, 16 rows = 16th notes.
2. Ensure playability constraint adherence: No triple-steps, maintain foot alternation, and keep hold keys logically closed with matching release values (3).
3. Output the raw .sm structure directly inside a code block.`;
  };

  const buildProjectPayload = (): StepSyncProject => ({
    version: 1,
    exportedAt: new Date().toISOString(),
    audioMeta: audioMeta
      ? {
          fileName: audioMeta.fileName,
          sampleRate: audioMeta.sampleRate,
          duration: audioMeta.duration,
        }
      : null,
    sync,
    sections,
    difficultyMatrix,
    laneRules,
    quantizeDrums,
    delayCompensation,
    auditionMode,
    blendRatio,
    simulatorDifficulty,
    simSoundMode,
    simSoundEnabled,
    simVolume,
    manualEdits,
    drumEvents:
      audioMeta?.drumEvents && audioMeta.drumEvents.length > 0
        ? audioMeta.drumEvents
        : undefined,
  });

  const generateProjectJson = () => JSON.stringify(buildProjectPayload(), null, 2);

  const handleDownloadProjectJson = () => {
    const json = generateProjectJson();
    const blob = new Blob([json], { type: 'application/json' });
    const baseName = (audioMeta?.fileName || 'stepsync_project').replace(/\.[^/.]+$/, '');
    triggerBlobDownload(blob, `${baseName}.stepsync.json`);
    setProjectStatus({ type: 'ok', text: `Saved ${baseName}.stepsync.json` });
  };

  const handleImportProjectJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<StepSyncProject>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.version !== 1 ||
        !parsed.sync ||
        !Array.isArray(parsed.sections) ||
        !Array.isArray(parsed.laneRules)
      ) {
        setProjectStatus({ type: 'error', text: 'Invalid StepSync project JSON file.' });
        return;
      }

      applyProjectSettings(parsed);

      if (!bandEnvelopes && Array.isArray(parsed.drumEvents)) {
        const restoredEvents = parsed.drumEvents;
        const restoredOnsets = [...new Set(restoredEvents.map((ev) => ev.time))].sort((a, b) => a - b);
        setAudioMeta((prev) =>
          prev
            ? { ...prev, drumEvents: restoredEvents, onsets: restoredOnsets }
            : parsed.audioMeta
            ? {
                fileName: parsed.audioMeta.fileName,
                sampleRate: parsed.audioMeta.sampleRate,
                duration: parsed.audioMeta.duration,
                drumEvents: restoredEvents,
                onsets: restoredOnsets,
              }
            : null
        );
      }

      const audioHint =
        parsed.audioMeta?.fileName && audioMeta?.fileName && parsed.audioMeta.fileName !== audioMeta.fileName
          ? ` (Audio hint: ${parsed.audioMeta.fileName})`
          : '';
      setProjectStatus({
        type: 'ok',
        text: `Loaded ${file.name}${audioHint}`,
      });
    } catch {
      setProjectStatus({ type: 'error', text: 'Failed to parse StepSync project JSON.' });
    }
  };

  // Persist track project + cached envelopes/spectral spectrogram to IndexedDB after hydration
  useEffect(() => {
    if (!audioMeta?.fileName || hydratedFileKey !== audioMeta.fileName) return;

    const timer = window.setTimeout(() => {
      saveTrackToStorageDb({
        fileName: audioMeta.fileName,
        updatedAt: new Date().toISOString(),
        source:
          cacheSource === 'public' || cacheSource === 'indexeddb' ? cacheSource : 'computed',
        project: buildProjectPayload(),
        envelopes: bandEnvelopes,
        spectralCache,
        diagnostics: stemDiagnostics,
        drumPcm: customDrumPcmRef.current,
        stemCleared: stemClearedRef.current,
      });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [
    hydratedFileKey,
    audioMeta,
    sync,
    sections,
    difficultyMatrix,
    laneRules,
    quantizeDrums,
    delayCompensation,
    auditionMode,
    blendRatio,
    simulatorDifficulty,
    simSoundMode,
    simSoundEnabled,
    simVolume,
    manualEdits,
    bandEnvelopes,
    spectralCache,
    stemDiagnostics,
    cacheSource,
  ]);

  const handleLoadEvents = (eventsData: any[]) => {
    if (!audioMeta) return;
    setRawEvents(eventsData);

    // If imported JSON contains band/lane annotations, surface them directly
    if (eventsData.some((e: any) => e.band && e.lane !== undefined)) {
      const importedDrumEvents: DrumEvent[] = eventsData
        .filter((e: any) => e.band && e.lane !== undefined)
        .map((e: any) => ({
          time: Number(e.time),
          beat: e.beat,
          band: e.band,
          energy: 1,
          lane: e.lane,
          source: e.source || 'drum',
        }));
      setAudioMeta((prev) => (prev ? { ...prev, drumEvents: importedDrumEvents } : null));
    }

    const userEvents = eventsData.filter((e: any) => e.source !== 'drum');
    if (userEvents.length > 0) {
      const secondsPerBeat = 60.0 / sync.bpm;
      const offset = sync.offset;
      const diffs = userEvents.map((e: any) => {
        const beatFloat = (e.time - offset) / secondsPerBeat;
        const nearest16th = Math.round(beatFloat * 4) / 4;
        const idealTime = offset + nearest16th * secondsPerBeat;
        return e.time - idealTime;
      });
      diffs.sort((a: number, b: number) => a - b);
      const medianDelay = diffs[Math.floor(diffs.length / 2)] || 0;
      setDelayCompensation(medianDelay);
    }
  };

  useEffect(() => {
    if (!audioMeta || rawEvents.length === 0 || bandEnvelopes) return;

    const secondsPerBeat = 60.0 / sync.bpm;
    const offset = sync.offset;

    let processedOnsets: number[] = [];

    if (autoQuantize) {
      const quantizedOnsets = rawEvents.map((e: any) => {
        const adjustedTime = e.time - delayCompensation;
        const beatFloat = (adjustedTime - offset) / secondsPerBeat;
        const nearest16th = Math.round(beatFloat * 4) / 4;
        return offset + nearest16th * secondsPerBeat;
      });
      processedOnsets = [...new Set<number>(quantizedOnsets)].sort((a, b) => a - b);
    } else {
      const adjustedOnsets = rawEvents.map((e: any) => e.time - delayCompensation);
      processedOnsets = [...new Set<number>(adjustedOnsets)].sort((a, b) => a - b);
    }

    setAudioMeta((prev) => (prev ? { ...prev, onsets: processedOnsets } : null));
  }, [rawEvents, autoQuantize, delayCompensation, sync.bpm, sync.offset, bandEnvelopes]);

  return (
    <div className="min-h-screen bg-[#0b0c0e] text-gray-100 font-sans p-2 md:p-3">
      <div className="max-w-7xl mx-auto space-y-2">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-2 pb-0.5">
          <div className="flex items-center gap-1.5 shrink-0">
            <Activity className="w-5 h-5 text-emerald-400 shrink-0" />
            <h1 className="text-base font-semibold tracking-tight whitespace-nowrap">StepSync</h1>
          </div>

          <GlobalTransport
            sync={sync}
            duration={audioMeta?.duration || engine.getDuration()}
            isPlaying={isPlaying}
            isLooping={isLooping}
            hasAudio={Boolean(engine.getBuffer())}
            onTogglePlay={togglePlay}
            onToggleLoop={() => setIsLooping((l) => !l)}
          />

          <div className="flex items-center gap-2 shrink-0">
            <label
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap"
              title="Adjust global text size across the entire interface (min 18px–28px root scale)"
            >
              <span className="font-medium text-gray-300">Size</span>
              <input
                type="range"
                min={18}
                max={28}
                step={1}
                value={rootFontPx}
                onChange={(e) => setRootFontPx(parseInt(e.target.value, 10))}
                aria-label="Global text size"
                className="w-16 accent-emerald-400 cursor-pointer"
              />
              <span className="font-mono tabular-nums text-emerald-400 w-9 text-right">
                {Math.round(rootFontPx * 0.75)}px+
              </span>
            </label>

            <div className="inline-flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setActiveTab('editor')}
                className={cn(
                  'px-2 py-0.5 text-xs font-medium rounded-sm flex items-center gap-1 transition-colors whitespace-nowrap shrink-0',
                  activeTab === 'editor' ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                )}
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>Editor</span>
              </button>
              <button
                onClick={() => setActiveTab('simulate')}
                className={cn(
                  'px-2 py-0.5 text-xs font-medium rounded-sm flex items-center gap-1 transition-colors whitespace-nowrap shrink-0',
                  activeTab === 'simulate' ? 'bg-white/10 text-emerald-400' : 'text-gray-400 hover:text-emerald-400 hover:bg-white/[0.06]'
                )}
              >
                <Gamepad2 className="w-3.5 h-3.5" />
                <span>Simulate</span>
              </button>
            </div>
          </div>
        </header>

        {/* Global Real-Time Frequency Spectrum Analyzer (collapsed by default) */}
        <SpectrumVisualizer
          isPlaying={isPlaying}
          hasAudio={Boolean(engine.getBuffer())}
          hasDrumStem={Boolean(drumBuffer)}
          onSoloBandChange={setActiveSoloBand}
        />

        {activeTab === 'editor' ? (
          <div className="space-y-2">
            {/* Waveform + Static Grid Alignment (or Drag & Drop Upload when empty / dragging a file) */}
            {!engine.getBuffer() || isDraggingAudio ? (
              <div
                className={cn(
                  'relative border border-dashed rounded-md p-4 transition-colors flex flex-col items-center justify-center text-center',
                  isDraggingAudio
                    ? 'border-emerald-400 bg-emerald-500/10'
                    : 'border-gray-800 hover:border-gray-600'
                )}
              >
                <input
                  type="file"
                  accept=".mp3,.wav,.ogg,.m4a"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Upload className={cn('w-7 h-7 mb-1.5', isDraggingAudio ? 'text-emerald-400' : 'text-gray-500')} />
                <p className="text-sm font-medium">
                  {isDraggingAudio ? 'Drop Audio File to Load' : 'Drag & Drop Audio File Here or Click to Browse'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Supported: .mp3, .wav, .ogg, .m4a</p>
                {uploadError && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5" />
                    <span>{uploadError}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 font-mono tabular-nums text-emerald-400 truncate">
                    <span>
                      {audioMeta?.fileName || 'Loaded Audio'} ·{' '}
                      {Math.floor((audioMeta?.duration || engine.getDuration()) / 60)}:
                      {Math.floor((audioMeta?.duration || engine.getDuration()) % 60)
                        .toString()
                        .padStart(2, '0')}
                    </span>
                    {uploadError && (
                      <span className="text-red-400 inline-flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {uploadError}
                      </span>
                    )}
                    {projectStatus && (
                      <span
                        className={cn(
                          'font-sans truncate',
                          projectStatus.type === 'error' ? 'text-red-400' : 'text-sky-300'
                        )}
                      >
                        {projectStatus.text}
                      </span>
                    )}
                  </div>
                  <div className="inline-flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleDownloadProjectJson}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-gray-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
                      title="Export full StepSync project JSON (sync, sections, matrix, lanes, manual edits)"
                    >
                      <Download className="w-3 h-3" />
                      <span>Save JSON</span>
                    </button>
                    <label
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-gray-300 hover:text-white cursor-pointer transition-colors whitespace-nowrap shrink-0"
                      title="Import a saved .stepsync.json project file"
                    >
                      <FolderOpen className="w-3 h-3" />
                      <span>Load JSON</span>
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={handleImportProjectJson}
                        className="hidden"
                      />
                    </label>
                    <label className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-gray-300 hover:text-white cursor-pointer transition-colors whitespace-nowrap shrink-0">
                      <Upload className="w-3 h-3" />
                      <span>Change Audio</span>
                      <input
                        type="file"
                        accept=".mp3,.wav,.ogg,.m4a"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                <Waveform
                  sync={sync}
                  isPlaying={isPlaying}
                  duration={audioMeta?.duration || 180}
                  drumBuffer={drumBuffer}
                  drumEvents={effectiveDrumEvents}
                  auditionMode={auditionMode}
                  showDrumMarkers={showDrumMarkers}
                  sections={sections}
                />
                <StaticWaveform
                  sync={sync}
                  setSync={setSync}
                  buffer={engine.getBuffer()}
                  duration={audioMeta?.duration || 180}
                  drumBuffer={drumBuffer}
                  drumEvents={effectiveDrumEvents}
                  auditionMode={auditionMode}
                  showDrumMarkers={showDrumMarkers}
                  sections={sections}
                  laneRules={laneRules}
                  manualEdits={manualEdits}
                  onToggleNoteAt={handleToggleNoteAt}
                  onUndoEdit={handleUndoEdit}
                  canUndoEdit={manualEditHistory.length > 0}
                  onResetEdits={handleResetEdits}
                />
              </div>
            )}

            {/* Drum Stem Separation & Lane Manager */}
            <StemStudio
              hasAudio={Boolean(engine.getBuffer())}
              engineMode={engineMode}
              setEngineMode={setEngineMode}
              webGpuInfo={webGpuInfo}
              modelCached={modelCached}
              status={stemStatus}
              progress={stemProgress}
              stageLabel={stemStage}
              errorMessage={stemError}
              hasDrumStem={Boolean(drumBuffer)}
              auditionMode={auditionMode}
              onChangeAuditionMode={setAuditionMode}
              blendRatio={blendRatio}
              onChangeBlendRatio={setBlendRatio}
              showDrumMarkers={showDrumMarkers}
              setShowDrumMarkers={setShowDrumMarkers}
              quantizeDrums={quantizeDrums}
              setQuantizeDrums={setQuantizeDrums}
              laneRules={laneRules}
              onUpdateLaneRule={handleUpdateLaneRule}
              onAddLaneRule={handleAddLaneRule}
              onAddTomPreset={handleAddTomPreset}
              onRemoveLaneRule={handleRemoveLaneRule}
              onResetLaneRules={handleResetLaneRules}
              activeSoloBand={activeSoloBand}
              drumEvents={effectiveDrumEvents}
              diagnostics={stemDiagnostics}
              onStartSeparation={handleStartSeparation}
              onCancelSeparation={handleCancelSeparation}
              onImportDrumStem={handleImportDrumStem}
              onDownloadDrumStem={handleDownloadDrumStem}
              onClearModelCache={handleClearModelCache}
              onResetDrums={handleResetDrums}
              hasCachedAnalysis={Boolean(bandEnvelopes)}
              cacheSource={cacheSource}
              onDownloadAnalysisCache={handleDownloadAnalysisCache}
              onImportAnalysisCache={handleImportAnalysisCache}
              onDiscardMemoryClean={handleDiscardMemoryClean}
              onDiscardAndRecalculate={handleDiscardAndRecalculate}
            />

            {/* Collapsible Sync & Timing Bar (collapsed by default) */}
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                <button
                  type="button"
                  onClick={() => setSyncPanelOpen((v) => !v)}
                  aria-expanded={syncPanelOpen}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left text-xs hover:text-white transition-colors"
                >
                  <span className="font-semibold uppercase tracking-wider text-gray-200 whitespace-nowrap">
                    Sync & Timing
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400 truncate">
                    {sync.bpm.toFixed(2)} BPM · {sync.offset.toFixed(3)}s
                  </span>
                </button>

                <div className="inline-flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleTap}
                    className="px-1.5 py-0.5 text-xs rounded-sm hover:bg-white/[0.06] text-gray-300 transition-colors whitespace-nowrap"
                    title="Tap Tempo (T)"
                  >
                    Tap (T)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSync((s) => ({ ...s, metronomeActive: !s.metronomeActive }))}
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap',
                      sync.metronomeActive
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                    )}
                    title="Toggle Metronome (M)"
                  >
                    {sync.metronomeActive ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                    <span>Metronome {sync.metronomeActive ? 'ON' : 'OFF'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSyncPanelOpen((v) => !v)}
                    aria-expanded={syncPanelOpen}
                    className="p-0.5 rounded-sm text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                    title={syncPanelOpen ? 'Collapse Sync Parameters' : 'Expand Sync Parameters'}
                  >
                    {syncPanelOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {syncPanelOpen && (() => {
                const gridDuration = audioMeta?.duration || 180;
                const getGridBeatCount = (offset: number, bpm: number, dur: number) => {
                  if (bpm <= 0) return 4;
                  const beatDur = 60 / bpm;
                  const maxBeats = Math.floor((dur - offset) / beatDur);
                  return Math.max(4, Math.floor(maxBeats / 4) * 4);
                };
                const gridBeatCount = getGridBeatCount(sync.offset, sync.bpm, gridDuration);
                const safeBeatDur = sync.bpm > 0 ? 60 / sync.bpm : 0.5;
                const startMarkerTime = Number(sync.offset.toFixed(3));
                const endMarkerTime = Number((sync.offset + gridBeatCount * safeBeatDur).toFixed(3));

                const commitEndMarker = (rawStr: string, keepFocus = false) => {
                  const parsed = parseFloat(rawStr);
                  const lockedN = endFocusLockedNRef.current ?? gridBeatCount;
                  if (Number.isFinite(parsed) && lockedN > 0) {
                    const beatDur = (parsed - sync.offset) / lockedN;
                    if (beatDur > 0.1) {
                      const newBpm = Math.max(20, Math.min(400, 60 / beatDur));
                      setSync((s) => ({ ...s, bpm: Number(newBpm.toFixed(2)) }));
                    }
                  }
                  if (!keepFocus) {
                    setEndFocused(false);
                    endFocusLockedNRef.current = null;
                  }
                };

                return (
                  <div className="pt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="flex items-center gap-1.5 flex-[1.35] min-w-[11rem]">
                      <label className="text-xs text-gray-400 uppercase tracking-wider shrink-0">BPM</label>
                      <div className="flex flex-1 items-center gap-1 min-w-0">
                        <input
                          type="number"
                          value={sync.bpm}
                          onChange={(e) => setSync((s) => ({ ...s, bpm: parseFloat(e.target.value) || 0 }))}
                          className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-2 py-0.5 w-full min-w-[4.5rem] text-sm font-mono tabular-nums text-emerald-400 focus:outline-none"
                        />
                        <button
                          onClick={() => setSync((s) => ({ ...s, bpm: Number((s.bpm / 2).toFixed(2)) }))}
                          className="px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-xs font-medium text-gray-300 transition-colors shrink-0"
                        >
                          /2
                        </button>
                        <button
                          onClick={() => setSync((s) => ({ ...s, bpm: Number((s.bpm * 2).toFixed(2)) }))}
                          className="px-1.5 py-0.5 rounded-sm hover:bg-white/[0.06] text-xs font-medium text-gray-300 transition-colors shrink-0"
                        >
                          *2
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-1 min-w-[8.5rem]">
                      <label className="text-xs text-gray-400 uppercase tracking-wider shrink-0">Offset</label>
                      <input
                        type="number"
                        step="0.005"
                        value={sync.offset}
                        onChange={(e) => setSync((s) => ({ ...s, offset: parseFloat(e.target.value) || 0 }))}
                        className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-2 py-0.5 w-full min-w-[4.5rem] text-sm font-mono tabular-nums text-white focus:outline-none"
                        title="Shifts Beat 0 (Start) and End together in seconds"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 flex-1 min-w-[8.5rem]">
                      <label
                        className="text-xs text-emerald-400 uppercase tracking-wider shrink-0 font-semibold"
                        title="Green Start marker position in seconds (equals Offset)"
                      >
                        Start
                      </label>
                      <div className="flex flex-1 items-center gap-1 min-w-0">
                        <input
                          type="number"
                          step="0.005"
                          value={startFocused ? startDraft : startMarkerTime.toFixed(3)}
                          onFocus={() => {
                            setStartDraft(startMarkerTime.toFixed(3));
                            setStartFocused(true);
                          }}
                          onChange={(e) => {
                            const val = e.target.value;
                            setStartDraft(val);
                            const parsed = parseFloat(val);
                            if (
                              Number.isFinite(parsed) &&
                              !val.endsWith('.') &&
                              !val.endsWith('-') &&
                              val.trim() !== ''
                            ) {
                              setSync((s) => ({ ...s, offset: Number(parsed.toFixed(3)) }));
                            }
                          }}
                          onBlur={() => {
                            const parsed = parseFloat(startDraft);
                            if (Number.isFinite(parsed)) {
                              setSync((s) => ({ ...s, offset: Number(parsed.toFixed(3)) }));
                            }
                            setStartFocused(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              (e.currentTarget as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              setStartFocused(false);
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-2 py-0.5 w-full min-w-[4.5rem] text-sm font-mono tabular-nums text-emerald-300 focus:outline-none"
                          title="Green Start marker (seconds). Matches Offset and shifts End at the same time."
                        />
                        <span className="text-xs font-mono text-gray-500 shrink-0">s</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-1 min-w-[8.5rem]">
                      <label
                        className="text-xs text-red-400 uppercase tracking-wider shrink-0 font-semibold"
                        title={`Red End marker position in seconds (beat ${gridBeatCount})`}
                      >
                        End
                      </label>
                      <div className="flex flex-1 items-center gap-1 min-w-0">
                        <input
                          type="number"
                          step="0.01"
                          value={endFocused ? endDraft : endMarkerTime.toFixed(3)}
                          onFocus={() => {
                            endFocusLockedNRef.current = gridBeatCount;
                            setEndDraft(endMarkerTime.toFixed(3));
                            setEndFocused(true);
                          }}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEndDraft(val);
                            const inputType = (e.nativeEvent as InputEvent | undefined)?.inputType;
                            const isTyped =
                              inputType === 'insertText' ||
                              inputType === 'deleteContentBackward' ||
                              inputType === 'deleteContentForward' ||
                              inputType === 'insertFromPaste' ||
                              inputType === 'deleteByCut';
                            if (!isTyped) {
                              commitEndMarker(val, true);
                            }
                          }}
                          onBlur={() => commitEndMarker(endDraft, false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              commitEndMarker(endDraft, false);
                              (e.currentTarget as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              setEndFocused(false);
                              endFocusLockedNRef.current = null;
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-2 py-0.5 w-full min-w-[4.5rem] text-sm font-mono tabular-nums text-red-300 focus:outline-none"
                          title={`Red End marker (seconds, beat ${gridBeatCount}). Changing Offset shifts this; editing End scales BPM.`}
                        />
                        <span className="text-xs font-mono text-gray-500 shrink-0">s</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>

            {/* Collapsible Song Structure & Difficulty Planning (collapsed by default) */}
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                <button
                  type="button"
                  onClick={() => setSectionsPanelOpen((v) => !v)}
                  aria-expanded={sectionsPanelOpen}
                  className="flex flex-wrap items-center gap-2 min-w-0 flex-1 text-left text-xs hover:text-white transition-colors"
                >
                  <span className="font-semibold uppercase tracking-wider text-gray-200 whitespace-nowrap">
                    Sections & Difficulty
                  </span>
                  <span className="font-mono tabular-nums text-gray-400 truncate">
                    {sections.length} {sections.length === 1 ? 'section' : 'sections'}
                    {sections.length > 0 && (
                      <>
                        {' · '}
                        <span className="text-sky-300">
                          E {sectionMetricMode === 'avg' ? sectionDifficultyCounts.totals.easy.avg.toFixed(2) : sectionDifficultyCounts.totals.easy.count}
                        </span>
                        {' · '}
                        <span className="text-amber-300">
                          N {sectionMetricMode === 'avg' ? sectionDifficultyCounts.totals.normal.avg.toFixed(2) : sectionDifficultyCounts.totals.normal.count}
                        </span>
                        {' · '}
                        <span className="text-emerald-400">
                          H {sectionMetricMode === 'avg' ? sectionDifficultyCounts.totals.hard.avg.toFixed(2) : sectionDifficultyCounts.totals.hard.count}
                        </span>
                      </>
                    )}
                  </span>
                </button>

                <div className="inline-flex items-center gap-0.5 shrink-0">
                  {sectionsPanelOpen && (
                    <>
                      <button
                        type="button"
                        onClick={() => setSectionMetricMode('avg')}
                        className={cn(
                          'px-1.5 py-0.5 text-xs font-mono rounded-sm transition-colors whitespace-nowrap',
                          sectionMetricMode === 'avg'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                        )}
                        title="Average inputs per beat in each section"
                      >
                        AVG
                      </button>
                      <button
                        type="button"
                        onClick={() => setSectionMetricMode('cnt')}
                        className={cn(
                          'px-1.5 py-0.5 text-xs font-mono rounded-sm transition-colors whitespace-nowrap',
                          sectionMetricMode === 'cnt'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                        )}
                        title="Total input count in each section"
                      >
                        CNT
                      </button>

                      <select
                        value={activeSectionLaneFilter}
                        onChange={(e) => setSectionLaneFilter(e.target.value)}
                        className="bg-transparent hover:bg-white/[0.06] rounded-sm px-1.5 py-0.5 text-xs text-gray-200 focus:outline-none cursor-pointer"
                        title="Filter Easy / Normal / Hard input totals by lane or arrow key"
                      >
                        <option value="all" className="bg-gray-950 text-gray-200">All lanes</option>
                        <optgroup label="Arrow Keys" className="bg-gray-950 text-gray-200">
                          <option value="lane:0">Key D (Left)</option>
                          <option value="lane:1">Key F (Down)</option>
                          <option value="lane:2">Key J (Up)</option>
                          <option value="lane:3">Key K (Right)</option>
                        </optgroup>
                        <optgroup label="Instrument Lanes" className="bg-gray-950 text-gray-200">
                          {laneRules.map((rule) => (
                            <option key={rule.id} value={`band:${rule.id}`}>
                              {rule.name}
                              {rule.enabled ? '' : ' (Off)'}
                            </option>
                          ))}
                        </optgroup>
                      </select>

                      <button
                        type="button"
                        onClick={() => setMatrixOpen((v) => !v)}
                        className={cn(
                          'px-1.5 py-0.5 text-xs rounded-sm transition-colors whitespace-nowrap',
                          matrixOpen
                            ? 'bg-white/10 text-white'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                        )}
                        title="Toggle Difficulty × Density Matrix table"
                      >
                        Matrix
                      </button>

                      <button
                        onClick={addSection}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 transition-colors whitespace-nowrap shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Section</span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setSectionsPanelOpen((v) => !v)}
                    aria-expanded={sectionsPanelOpen}
                    className="p-0.5 rounded-sm text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                    title={sectionsPanelOpen ? 'Collapse Sections & Difficulty' : 'Expand Sections & Difficulty'}
                  >
                    {sectionsPanelOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {sectionsPanelOpen && (
                <div className="pt-1 space-y-2">
                  {/* Collapsible Difficulty x Density Matrix (collapsed by default) */}
                  {matrixOpen && (
                    <div className="pb-1">
                      <div className="flex items-center justify-between pb-1 text-xs text-gray-400">
                        <span>Difficulty × Density Matrix (Grid Cap + Chord Priority Cap)</span>
                        <button
                          type="button"
                          onClick={() => setDifficultyMatrix(DEFAULT_DIFFICULTY_MATRIX)}
                          className="text-gray-500 hover:text-gray-200 transition-colors whitespace-nowrap shrink-0"
                        >
                          Reset Matrix
                        </button>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="text-gray-400">
                              <th className="text-left font-medium px-1.5 py-0.5 w-20">Density</th>
                              <th className="text-center font-medium px-1.5 py-0.5 text-sky-300">Easy</th>
                              <th className="text-center font-medium px-1.5 py-0.5 text-amber-300">Normal</th>
                              <th className="text-center font-medium px-1.5 py-0.5 text-emerald-400">Hard</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(['Sparse', 'Medium', 'Dense'] as SectionDensity[]).map((densityRow) => (
                              <tr key={densityRow} className="hover:bg-white/[0.02]">
                                <td className="px-1.5 py-0.5 font-medium text-gray-300">{densityRow}</td>
                                {(['easy', 'normal', 'hard'] as ChartDifficulty[]).map((diffCol) => {
                                  const cell = difficultyMatrix[densityRow][diffCol];
                                  return (
                                    <td key={diffCol} className="px-1 py-0.5 text-center">
                                      <div className="inline-flex items-center gap-0.5">
                                        <select
                                          value={String(cell.subdivision)}
                                          onChange={(e) => {
                                            const rawVal = e.target.value;
                                            const parsed: DensitySubdivisionCap =
                                              rawVal === 'all'
                                                ? 'all'
                                                : (Number(rawVal) as DensitySubdivisionCap);
                                            setDifficultyMatrix((prev) => ({
                                              ...prev,
                                              [densityRow]: {
                                                ...prev[densityRow],
                                                [diffCol]: {
                                                  ...prev[densityRow][diffCol],
                                                  subdivision: parsed,
                                                },
                                              },
                                            }));
                                          }}
                                          className="bg-transparent hover:bg-white/[0.06] rounded-sm px-1 py-0.5 text-xs font-mono tabular-nums text-gray-200 focus:outline-none cursor-pointer"
                                          title="Maximum note subdivision grid allowed"
                                        >
                                          <option value="0" className="bg-gray-950 text-gray-200">Off (0)</option>
                                          <option value="1" className="bg-gray-950 text-gray-200">1/1</option>
                                          <option value="2" className="bg-gray-950 text-gray-200">1/2</option>
                                          <option value="4" className="bg-gray-950 text-gray-200">1/4</option>
                                          <option value="8" className="bg-gray-950 text-gray-200">1/8</option>
                                          <option value="16" className="bg-gray-950 text-gray-200">1/16</option>
                                          <option value="all" className="bg-gray-950 text-gray-200">All</option>
                                        </select>
                                        <select
                                          value={cell.maxChords === null ? 'all' : String(cell.maxChords)}
                                          onChange={(e) => {
                                            const rawVal = e.target.value;
                                            const parsed: MaxChordsCap =
                                              rawVal === 'all'
                                                ? null
                                                : (Number(rawVal) as Exclude<MaxChordsCap, null>);
                                            setDifficultyMatrix((prev) => ({
                                              ...prev,
                                              [densityRow]: {
                                                ...prev[densityRow],
                                                [diffCol]: {
                                                  ...prev[densityRow][diffCol],
                                                  maxChords: parsed,
                                                },
                                              },
                                            }));
                                          }}
                                          className="bg-transparent hover:bg-white/[0.06] rounded-sm px-1 py-0.5 text-xs font-mono tabular-nums text-gray-200 focus:outline-none cursor-pointer"
                                          title="Max simultaneous notes (Chords) kept by Lane priority"
                                        >
                                          <option value="1" className="bg-gray-950 text-gray-200">1·Single</option>
                                          <option value="2" className="bg-gray-950 text-gray-200">2·Jump</option>
                                          <option value="3" className="bg-gray-950 text-gray-200">3·Hand</option>
                                          <option value="all" className="bg-gray-950 text-gray-200">All</option>
                                        </select>
                                      </div>
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Flat Spreadsheet Section Rows (zero lines, black writing inputs) */}
                  <div className="space-y-1">
                    {sections.length > 0 && (
                      <div className="hidden md:grid md:grid-cols-[2.25rem_5rem_1fr_5.5rem_7.25rem_3.75rem_3.75rem_3.75rem_2rem] gap-1.5 items-center py-0.5 text-xs font-medium uppercase tracking-wider text-gray-500">
                        <span className="text-right">#</span>
                        <span className="px-1">Beat</span>
                        <span className="px-1">Type</span>
                        <span className="px-1">Density</span>
                        <span className="px-1">Preset</span>
                        <span className="text-right text-sky-400">
                          E{sectionMetricMode === 'avg' ? '/b' : ''}
                        </span>
                        <span className="text-right text-amber-400">
                          N{sectionMetricMode === 'avg' ? '/b' : ''}
                        </span>
                        <span className="text-right text-emerald-400">
                          H{sectionMetricMode === 'avg' ? '/b' : ''}
                        </span>
                        <span />
                      </div>
                    )}

                    {sections.map((section, idx) => {
                      const stats = sectionDifficultyCounts.bySectionId[section.id] || {
                        easy: { count: 0, avg: 0 },
                        normal: { count: 0, avg: 0 },
                        hard: { count: 0, avg: 0 },
                        beats: 0,
                      };
                      const formatMetric = (m: { count: number; avg: number }) =>
                        sectionMetricMode === 'avg' ? m.avg.toFixed(2) : String(m.count);
                      return (
                        <div
                          key={section.id}
                          className="grid grid-cols-1 md:grid-cols-[2.25rem_5rem_1fr_5.5rem_7.25rem_3.75rem_3.75rem_3.75rem_2rem] gap-1.5 items-center py-0.5 hover:bg-white/[0.02] rounded-sm"
                        >
                          <div className="hidden md:block text-xs font-mono tabular-nums text-gray-500 text-right">
                            {idx + 1}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="md:hidden text-xs text-gray-500 w-14">Beat</span>
                            <input
                              type="number"
                              step="1"
                              value={section.beat}
                              onChange={(e) =>
                                updateSection(section.id, { beat: parseFloat(e.target.value) || 0 })
                              }
                              title={`${stats.beats.toFixed(0)} beats in this section`}
                              className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-1.5 py-0.5 w-full text-xs font-mono tabular-nums text-white focus:outline-none"
                            />
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="md:hidden text-xs text-gray-500 w-14">Type</span>
                            <input
                              type="text"
                              value={section.label}
                              onChange={(e) => updateSection(section.id, { label: e.target.value })}
                              className="bg-black ring-1 ring-white/25 hover:ring-white/45 focus:ring-2 focus:ring-emerald-400 rounded-sm px-1.5 py-0.5 w-full text-xs text-white focus:outline-none"
                            />
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="md:hidden text-xs text-gray-500 w-14">Density</span>
                            <select
                              value={section.density}
                              onChange={(e) =>
                                updateSection(section.id, { density: e.target.value as SectionDensity })
                              }
                              className="bg-transparent hover:bg-white/[0.05] focus:bg-white/[0.08] rounded-sm px-1 py-0.5 w-full text-xs focus:outline-none cursor-pointer"
                            >
                              <option value="Sparse" className="bg-gray-950 text-gray-200">Sparse</option>
                              <option value="Medium" className="bg-gray-950 text-gray-200">Medium</option>
                              <option value="Dense" className="bg-gray-950 text-gray-200">Dense</option>
                            </select>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="md:hidden text-xs text-gray-500 w-14">Preset</span>
                            <select
                              value={section.preset ?? ''}
                              onChange={(e) => {
                                const val = e.target.value as WindshieldPreset | '';
                                updateSection(section.id, { preset: val || undefined });
                              }}
                              className={cn(
                                'bg-transparent hover:bg-white/[0.05] focus:bg-white/[0.08] rounded-sm px-1 py-0.5 w-full text-xs focus:outline-none cursor-pointer',
                                section.preset ? 'text-emerald-300 font-medium' : 'text-gray-400'
                              )}
                              title="Auto-switch Screensaver preset (1 GLSL, 2 Wormhole, 3 Rain, 4 MilkDrop) when entering this section"
                            >
                              <option value="" className="bg-gray-950 text-gray-400">
                                — Keep
                              </option>
                              <option value="glsl-space" className="bg-gray-950 text-gray-200">
                                1 · GLSL
                              </option>
                              <option value="wormhole" className="bg-gray-950 text-gray-200">
                                2 · Wormhole
                              </option>
                              <option value="music-rain" className="bg-gray-950 text-gray-200">
                                3 · Rain
                              </option>
                              <option value="milkdrop" className="bg-gray-950 text-gray-200">
                                4 · MilkDrop
                              </option>
                            </select>
                          </div>

                          <div
                            className="flex items-center justify-between md:justify-end gap-1 font-mono tabular-nums text-xs"
                            title={`${stats.easy.count} inputs across ${stats.beats.toFixed(0)} beats`}
                          >
                            <span className="md:hidden text-sky-400">Easy</span>
                            <span className="text-sky-300 font-medium">{formatMetric(stats.easy)}</span>
                          </div>

                          <div
                            className="flex items-center justify-between md:justify-end gap-1 font-mono tabular-nums text-xs"
                            title={`${stats.normal.count} inputs across ${stats.beats.toFixed(0)} beats`}
                          >
                            <span className="md:hidden text-amber-400">Normal</span>
                            <span className="text-amber-300 font-medium">{formatMetric(stats.normal)}</span>
                          </div>

                          <div
                            className="flex items-center justify-between md:justify-end gap-1 font-mono tabular-nums text-xs"
                            title={`${stats.hard.count} inputs across ${stats.beats.toFixed(0)} beats`}
                          >
                            <span className="md:hidden text-emerald-400">Hard</span>
                            <span className="text-emerald-400 font-medium">{formatMetric(stats.hard)}</span>
                          </div>

                          <div className="flex justify-end">
                            <button
                              onClick={() => removeSection(section.id)}
                              className="p-0.5 text-gray-500 hover:text-red-400 rounded-sm transition-colors"
                              title="Remove section"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {sections.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-[2.25rem_5rem_1fr_5.5rem_7.25rem_3.75rem_3.75rem_3.75rem_2rem] gap-1.5 items-center pt-1 text-xs font-mono tabular-nums">
                        <div className="md:col-span-5 text-gray-400 font-sans font-medium">
                          {sectionMetricMode === 'avg' ? 'Overall Avg / Beat' : 'Total Inputs'}
                        </div>
                        <div className="flex items-center justify-between md:justify-end text-sky-300 font-semibold">
                          <span className="md:hidden font-sans text-sky-400">Easy</span>
                          <span>
                            {sectionMetricMode === 'avg'
                              ? sectionDifficultyCounts.totals.easy.avg.toFixed(2)
                              : sectionDifficultyCounts.totals.easy.count}
                          </span>
                        </div>
                        <div className="flex items-center justify-between md:justify-end text-amber-300 font-semibold">
                          <span className="md:hidden font-sans text-amber-400">Normal</span>
                          <span>
                            {sectionMetricMode === 'avg'
                              ? sectionDifficultyCounts.totals.normal.avg.toFixed(2)
                              : sectionDifficultyCounts.totals.normal.count}
                          </span>
                        </div>
                        <div className="flex items-center justify-between md:justify-end text-emerald-400 font-semibold">
                          <span className="md:hidden font-sans text-emerald-400">Hard</span>
                          <span>
                            {sectionMetricMode === 'avg'
                              ? sectionDifficultyCounts.totals.hard.avg.toFixed(2)
                              : sectionDifficultyCounts.totals.hard.count}
                          </span>
                        </div>
                        <div />
                      </div>
                    )}

                    {sections.length === 0 && (
                      <div className="text-center py-2 text-gray-500 text-xs">
                        No sections defined. Generated stepfile will use default density.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Collapsible Exports & Outputs (collapsed by default) */}
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                <button
                  type="button"
                  onClick={() => setOutputsPanelOpen((v) => !v)}
                  aria-expanded={outputsPanelOpen}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left text-xs hover:text-white transition-colors"
                >
                  <span className="font-semibold uppercase tracking-wider text-gray-200 whitespace-nowrap">
                    Generated Outputs
                  </span>
                  <span className="text-gray-400 truncate">
                    .sm Header · LLM Prompt · Project JSON
                  </span>
                </button>

                <div className="inline-flex items-center gap-0.5 shrink-0">
                  {outputsPanelOpen && (
                    <>
                      <button
                        onClick={() => setOutputTab('sm')}
                        className={cn(
                          'px-1.5 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                          outputTab === 'sm' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
                        )}
                      >
                        .sm Header
                      </button>
                      <button
                        onClick={() => setOutputTab('llm')}
                        className={cn(
                          'px-1.5 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                          outputTab === 'llm' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
                        )}
                      >
                        LLM Prompt
                      </button>
                      <button
                        onClick={() => setOutputTab('project')}
                        className={cn(
                          'px-1.5 py-0.5 text-xs font-medium rounded-sm transition-colors whitespace-nowrap shrink-0',
                          outputTab === 'project' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
                        )}
                      >
                        Project JSON
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard.writeText(
                        outputTab === 'sm'
                          ? generateSMHeader()
                          : outputTab === 'llm'
                          ? generateLLMPrompt()
                          : generateProjectJson()
                      )
                    }
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm hover:bg-white/[0.06] text-gray-300 transition-colors whitespace-nowrap shrink-0"
                    title="Copy active output to clipboard"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadProjectJson}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3 h-3" />
                    <span>.json</span>
                  </button>
                  <label className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm hover:bg-white/[0.06] text-gray-200 cursor-pointer transition-colors whitespace-nowrap shrink-0">
                    <FolderOpen className="w-3 h-3" />
                    <span>Import</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={handleImportProjectJson}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setOutputsPanelOpen((v) => !v)}
                    aria-expanded={outputsPanelOpen}
                    className="p-0.5 rounded-sm text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                    title={outputsPanelOpen ? 'Collapse Generated Outputs' : 'Expand Generated Outputs'}
                  >
                    {outputsPanelOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {outputsPanelOpen && (
                <pre className="bg-black/50 p-2 text-xs font-mono text-gray-300 overflow-x-auto min-h-[140px] max-h-[320px] whitespace-pre-wrap">
                  {outputTab === 'sm'
                    ? generateSMHeader()
                    : outputTab === 'llm'
                    ? generateLLMPrompt()
                    : generateProjectJson()}
                </pre>
              )}
            </section>
          </div>
        ) : (
          <div>
            <Simulator
              sync={sync}
              sections={sections}
              isPlaying={isPlaying}
              audioMeta={simulatorAudioMeta}
              onLoadEvents={handleLoadEvents}
              delayCompensation={delayCompensation}
              setDelayCompensation={setDelayCompensation}
              autoQuantize={autoQuantize}
              setAutoQuantize={setAutoQuantize}
              hasDrumStem={Boolean(drumBuffer)}
              auditionMode={auditionMode}
              onChangeAuditionMode={setAuditionMode}
              trackVolume={sync.volume}
              onChangeTrackVolume={(vol) => setSync((s) => ({ ...s, volume: vol }))}
              simSoundMode={simSoundMode}
              onChangeSimSoundMode={setSimSoundMode}
              simSoundEnabled={simSoundEnabled}
              onChangeSimSoundEnabled={setSimSoundEnabled}
              simVolume={simVolume}
              onChangeSimVolume={setSimVolume}
              tomBandIds={tomBandIds}
              laneRules={laneRules}
              onRecordingActiveChange={setIsSimulatorRecording}
              difficulty={simulatorDifficulty}
              onChangeDifficulty={setSimulatorDifficulty}
              difficultyMatrix={difficultyMatrix}
              bandPriorityOrder={laneRules.map((r) => r.id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
