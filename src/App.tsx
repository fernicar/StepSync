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
  separateDrumStem,
} from './lib/stemWorkerClient';
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
} from './types';
import { cn } from './lib/utils';
import { Waveform } from './components/Waveform';
import { Simulator } from './components/Simulator';
import { StaticWaveform } from './components/StaticWaveform';
import { AuditionMode, StemStudio } from './components/StemStudio';
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
    { id: '1', beat: 0, label: 'Intro', density: 'Medium' },
    { id: '2', beat: 16, label: 'Chorus', density: 'Dense' },
    { id: '3', beat: 48, label: 'Verse 1', density: 'Medium' },
    { id: '4', beat: 80, label: 'instrumental', density: 'Medium' },
    { id: '5', beat: 104, label: 'Chorus', density: 'Dense' },
    { id: '6', beat: 136, label: 'instrumental', density: 'Dense' },
    { id: '7', beat: 144, label: 'Verse 2', density: 'Sparse' },
    { id: '8', beat: 176, label: 'instrumental', density: 'Dense' },
    { id: '9', beat: 200, label: 'Chorus', density: 'Medium' },
    { id: '10', beat: 232, label: 'Verse 3', density: 'Sparse' },
    { id: '11', beat: 296, label: 'instrumental', density: 'Dense' },
    { id: '12', beat: 304, label: 'Chorus', density: 'Medium' },
    { id: '13', beat: 336, label: 'instrumental', density: 'Sparse' },
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
  }, [drumBuffer]);

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

  const tryAutoLoadCompanionDrumStem = async (
    audioFileName: string,
    audioCtx: AudioContext
  ): Promise<boolean> => {
    const baseName = audioFileName.replace(/\.[^/.]+$/, '');
    const candidates = [`/${encodeURIComponent(baseName)}_drums.mp3`, `/${encodeURIComponent(baseName)}_drums.wav`];
    for (const url of candidates) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) continue;
        const arr = await res.arrayBuffer();
        if (arr.byteLength === 0) continue;

        const decodedDrum = await audioCtx.decodeAudioData(arr);
        const envelopes = analyzePreSeparatedDrumBuffer(decodedDrum);

        let peakAmplitude = 0;
        for (let ch = 0; ch < decodedDrum.numberOfChannels; ch++) {
          const data = decodedDrum.getChannelData(ch);
          for (let i = 0; i < data.length; i += 16) {
            const a = Math.abs(data[i]);
            if (a > peakAmplitude) peakAmplitude = a;
          }
        }

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
        return true;
      } catch {
        // Ignore missing/unreadable candidate and check next
      }
    }
    return false;
  };

  useEffect(() => {
    const loadDefaultAudio = async () => {
      try {
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

        setAudioMeta({
          fileName: '166.m4a',
          sampleRate: decodedData.sampleRate,
          duration: decodedData.duration,
          onsets: initialOnsets,
        });

        setSync((s) => ({
          ...s,
          bpm: 96.0,
          offset: 0.16,
        }));

        await tryAutoLoadCompanionDrumStem('166.m4a', audioCtx);
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
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decodedData = await audioCtx.decodeAudioData(arrayBuffer);

      // Clear any previous drum stem when loading a new track
      cancelActiveSeparation();
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

      setAudioMeta({
        fileName: file.name,
        sampleRate: decodedData.sampleRate,
        duration: decodedData.duration,
      });

      engine.setBuffer(decodedData);

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

      await tryAutoLoadCompanionDrumStem(file.name, audioCtx);
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

      setDrumBuffer(result.drumBuffer);
      setSpectralCache(null);
      engine.setDrumBuffer(result.drumBuffer);
      setBandEnvelopes(result.envelopes);
      setStemDiagnostics(result.diagnostics);
      setAuditionMode('drums');
      setStemStatus('ready');
      setStemProgress(100);
      setStemStage('Drum stem isolated');

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
    } catch {
      setStemStatus('error');
      setStemError('Could not decode the imported drum stem audio file.');
    }
  };

  const handleDownloadDrumStem = () => {
    if (!drumBuffer) return;
    const blob = audioBufferToWavBlob(drumBuffer);
    const url = URL.createObjectURL(blob);
    const baseName = (audioMeta?.fileName || 'track').replace(/\.[^/.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}_drums.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearModelCache = async () => {
    await clearDemucsModelCache();
    setModelCached(false);
  };

  const handleResetDrums = () => {
    setDrumBuffer(null);
    setSpectralCache(null);
    engine.setDrumBuffer(null);
    setBandEnvelopes(null);
    setStemDiagnostics(null);
    setStemStatus('idle');
    setAuditionMode('mix');
    setAudioMeta((prev) => (prev ? { ...prev, drumEvents: undefined } : null));
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
    const url = URL.createObjectURL(blob);
    const baseName = (audioMeta?.fileName || 'stepsync_project').replace(/\.[^/.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.stepsync.json`;
    a.click();
    URL.revokeObjectURL(url);
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

      if (typeof parsed.sync.bpm === 'number' && typeof parsed.sync.offset === 'number') {
        setSync({
          bpm: parsed.sync.bpm,
          offset: parsed.sync.offset,
          metronomeActive: Boolean(parsed.sync.metronomeActive),
          volume: typeof parsed.sync.volume === 'number' ? parsed.sync.volume : 1.0,
        });
      }

      setSections(parsed.sections);
      if (parsed.difficultyMatrix) {
        setDifficultyMatrix(parsed.difficultyMatrix);
      }
      setLaneRules(parsed.laneRules);
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
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans p-3 md:p-4">
      <div className="max-w-5xl mx-auto space-y-2.5">
        {/* Header */}
        <header className="flex flex-wrap md:flex-nowrap items-center justify-between gap-3 border-b border-gray-800 pb-2.5">
          <div className="flex items-center gap-2.5 shrink-0">
            <Activity className="w-6 h-6 text-emerald-400 shrink-0" />
            <h1 className="text-xl font-semibold tracking-tight whitespace-nowrap">StepSync</h1>
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

          <div className="flex space-x-1.5 bg-gray-900 rounded-lg p-1 border border-gray-800 shadow-sm shrink-0">
            <button
              onClick={() => setActiveTab('editor')}
              className={cn(
                'px-3.5 py-1.5 text-sm font-medium rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap shrink-0',
                activeTab === 'editor' ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-400 hover:text-white'
              )}
            >
              <Settings2 className="w-4 h-4" />
              <span>Editor</span>
            </button>
            <button
              onClick={() => setActiveTab('simulate')}
              className={cn(
                'px-3.5 py-1.5 text-sm font-medium rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap shrink-0',
                activeTab === 'simulate' ? 'bg-gray-800 text-emerald-400 shadow-sm' : 'text-gray-400 hover:text-emerald-400'
              )}
            >
              <Gamepad2 className="w-4 h-4" />
              <span>Simulate</span>
            </button>
          </div>
        </header>

        {/* Global Real-Time Frequency Spectrum Analyzer (visible across all tabs) */}
        <SpectrumVisualizer
          isPlaying={isPlaying}
          hasAudio={Boolean(engine.getBuffer())}
          hasDrumStem={Boolean(drumBuffer)}
          onSoloBandChange={setActiveSoloBand}
        />

        {activeTab === 'editor' ? (
          <div className="space-y-2.5">
            {/* Waveform + Static Grid Alignment (or Drag & Drop Upload when empty / dragging a file) */}
            {!engine.getBuffer() || isDraggingAudio ? (
              <div
                className={cn(
                  'relative border-2 border-dashed rounded-xl p-6 transition-colors flex flex-col items-center justify-center text-center',
                  isDraggingAudio
                    ? 'border-emerald-400 bg-emerald-500/10'
                    : 'border-gray-800 hover:border-gray-600 bg-gray-900/50'
                )}
              >
                <input
                  type="file"
                  accept=".mp3,.wav,.ogg,.m4a"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Upload className={cn('w-8 h-8 mb-2', isDraggingAudio ? 'text-emerald-400' : 'text-gray-500')} />
                <p className="text-sm font-medium">
                  {isDraggingAudio ? 'Drop Audio File to Load' : 'Drag & Drop Audio File Here or Click to Browse'}
                </p>
                <p className="text-xs text-gray-500 mt-1">Supported formats: .mp3, .wav, .ogg, .m4a</p>
                {uploadError && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="w-4 h-4" />
                    <span>{uploadError}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex flex-col space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
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
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleDownloadProjectJson}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors whitespace-nowrap shrink-0"
                      title="Export full StepSync project JSON (sync, sections, matrix, lanes, manual edits)"
                    >
                      <Download className="w-3 h-3" />
                      <span>Save JSON</span>
                    </button>
                    <label
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 cursor-pointer transition-colors whitespace-nowrap shrink-0"
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
                    <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 cursor-pointer transition-colors whitespace-nowrap shrink-0">
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
            />

            {/* Analysis Results & Sync */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h2 className="text-sm font-medium text-gray-400 mb-3 tracking-wider uppercase">Sync Parameters</h2>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1.5">BPM</label>
                    <div className="flex space-x-2">
                      <input
                        type="number"
                        value={sync.bpm}
                        onChange={(e) => setSync((s) => ({ ...s, bpm: parseFloat(e.target.value) || 0 }))}
                        className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 w-full text-lg font-mono tabular-nums text-emerald-400 focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                      <button
                        onClick={() => setSync((s) => ({ ...s, bpm: Number((s.bpm / 2).toFixed(2)) }))}
                        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm font-medium transition-colors"
                      >
                        /2
                      </button>
                      <button
                        onClick={() => setSync((s) => ({ ...s, bpm: Number((s.bpm * 2).toFixed(2)) }))}
                        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm font-medium transition-colors"
                      >
                        *2
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1.5">Offset (Seconds)</label>
                    <div className="flex space-x-2">
                      <input
                        type="number"
                        step="0.005"
                        value={sync.offset}
                        onChange={(e) => setSync((s) => ({ ...s, offset: parseFloat(e.target.value) || 0 }))}
                        className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 w-full text-lg font-mono tabular-nums focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h2 className="text-sm font-medium text-gray-400 mb-3 tracking-wider uppercase">Tools</h2>
                <div className="space-y-3">
                  <button
                    onClick={handleTap}
                    className="w-full py-3 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg text-gray-300 font-medium transition-colors focus:outline-none active:bg-gray-800"
                  >
                    Tap Tempo (T)
                  </button>

                  <button
                    onClick={() => setSync((s) => ({ ...s, metronomeActive: !s.metronomeActive }))}
                    className={cn(
                      'w-full py-3 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2 shadow-sm',
                      sync.metronomeActive
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'
                        : 'bg-gray-800 text-gray-300 border border-transparent hover:bg-gray-700'
                    )}
                  >
                    {sync.metronomeActive ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                    <span>Metronome {sync.metronomeActive ? 'ON' : 'OFF'} (M)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Song Structure & Difficulty Planning */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-gray-400 tracking-wider uppercase">
                  Song Structure & Sections
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center p-0.5 bg-gray-950 border border-gray-800 rounded-md">
                    <button
                      type="button"
                      onClick={() => setSectionMetricMode('avg')}
                      className={cn(
                        'px-2 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0',
                        sectionMetricMode === 'avg'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-gray-400 hover:text-gray-200'
                      )}
                      title="Average inputs per beat in each section"
                    >
                      AVG
                    </button>
                    <button
                      type="button"
                      onClick={() => setSectionMetricMode('cnt')}
                      className={cn(
                        'px-2 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0',
                        sectionMetricMode === 'cnt'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'text-gray-400 hover:text-gray-200'
                      )}
                      title="Total input count in each section"
                    >
                      CNT
                    </button>
                  </div>

                  <select
                    value={activeSectionLaneFilter}
                    onChange={(e) => setSectionLaneFilter(e.target.value)}
                    className="bg-gray-950 border border-gray-800 rounded-md px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                    title="Filter Easy / Normal / Hard input totals by lane or arrow key"
                  >
                    <option value="all">All lanes</option>
                    <optgroup label="Arrow Keys">
                      <option value="lane:0">Key D (Left)</option>
                      <option value="lane:1">Key F (Down)</option>
                      <option value="lane:2">Key J (Up)</option>
                      <option value="lane:3">Key K (Right)</option>
                    </optgroup>
                    <optgroup label="Instrument Lanes">
                      {laneRules.map((rule) => (
                        <option key={rule.id} value={`band:${rule.id}`}>
                          {rule.name}
                          {rule.enabled ? '' : ' (Off)'}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <button
                    onClick={addSection}
                    className="flex items-center space-x-1 text-sm text-emerald-400 hover:text-emerald-300 transition-colors bg-emerald-500/10 px-3 py-1 rounded-md border border-emerald-500/20 whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Section</span>
                  </button>
                </div>
              </div>

              {/* Difficulty x Density Subdivision & Chord Cap Table */}
              <div className="border border-gray-800 rounded-lg bg-gray-950/60 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 text-xs text-gray-400">
                  <span>Difficulty × Density Matrix (Grid Cap + Simultaneous Chord Cap by Lane Priority)</span>
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
                      <tr className="border-b border-gray-800/80 text-gray-400">
                        <th className="text-left font-medium px-3 py-1.5 w-24">Density</th>
                        <th className="text-center font-medium px-2 py-1.5 text-sky-300">
                          Easy <span className="text-[10px] font-normal text-gray-500">(Grid · Chords)</span>
                        </th>
                        <th className="text-center font-medium px-2 py-1.5 text-amber-300">
                          Normal <span className="text-[10px] font-normal text-gray-500">(Grid · Chords)</span>
                        </th>
                        <th className="text-center font-medium px-2 py-1.5 text-emerald-400">
                          Hard <span className="text-[10px] font-normal text-gray-500">(Grid · Chords)</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/60">
                      {(['Sparse', 'Medium', 'Dense'] as SectionDensity[]).map((densityRow) => (
                        <tr key={densityRow} className="hover:bg-gray-900/40">
                          <td className="px-3 py-1.5 font-medium text-gray-300">{densityRow}</td>
                          {(['easy', 'normal', 'hard'] as ChartDifficulty[]).map((diffCol) => {
                            const cell = difficultyMatrix[densityRow][diffCol];
                            return (
                              <td key={diffCol} className="px-2 py-1 text-center">
                                <div className="inline-flex items-center gap-1">
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
                                    className="bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-xs font-mono tabular-nums text-gray-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                                    title="Maximum note subdivision grid allowed"
                                  >
                                    <option value="0">Off (0)</option>
                                    <option value="1">1/1</option>
                                    <option value="2">1/2</option>
                                    <option value="4">1/4</option>
                                    <option value="8">1/8</option>
                                    <option value="16">1/16</option>
                                    <option value="all">All</option>
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
                                    className="bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-xs font-mono tabular-nums text-gray-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                                    title="Max simultaneous notes (Chords) kept by Lane Manager priority: 1 = Single (no jumps), 2 = Jump, 3 = Hand"
                                  >
                                    <option value="1">1 · Single</option>
                                    <option value="2">2 · Jump</option>
                                    <option value="3">3 · Hand</option>
                                    <option value="all">All Chords</option>
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

              {/* Section Rows with Easy | Normal | Hard AVG or CNT */}
              <div className="space-y-1.5">
                {sections.length > 0 && (
                  <div className="hidden md:grid md:grid-cols-[2.25rem_5.5rem_1fr_7.5rem_4.25rem_4.25rem_4.25rem_2rem] gap-2.5 items-center px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                    <span className="text-right">#</span>
                    <span>Beat</span>
                    <span>Type</span>
                    <span>Density</span>
                    <span className="text-right text-sky-400">
                      Easy{sectionMetricMode === 'avg' ? '/b' : ''}
                    </span>
                    <span className="text-right text-amber-400">
                      Normal{sectionMetricMode === 'avg' ? '/b' : ''}
                    </span>
                    <span className="text-right text-emerald-400">
                      Hard{sectionMetricMode === 'avg' ? '/b' : ''}
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
                      className="grid grid-cols-1 md:grid-cols-[2.25rem_5.5rem_1fr_7.5rem_4.25rem_4.25rem_4.25rem_2rem] gap-2.5 items-center bg-gray-950 px-3 py-1.5 rounded-lg border border-gray-800"
                    >
                      <div className="hidden md:block text-xs font-mono tabular-nums text-gray-500 text-right">
                        #{idx + 1}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="md:hidden text-xs text-gray-500 w-14">Beat</span>
                        <input
                          type="number"
                          step="1"
                          value={section.beat}
                          onChange={(e) =>
                            updateSection(section.id, { beat: parseFloat(e.target.value) || 0 })
                          }
                          title={`${stats.beats.toFixed(0)} beats in this section`}
                          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 w-full text-sm font-mono tabular-nums focus:outline-none focus:border-emerald-500 transition-colors"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="md:hidden text-xs text-gray-500 w-14">Type</span>
                        <input
                          type="text"
                          value={section.label}
                          onChange={(e) => updateSection(section.id, { label: e.target.value })}
                          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 w-full text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="md:hidden text-xs text-gray-500 w-14">Density</span>
                        <select
                          value={section.density}
                          onChange={(e) =>
                            updateSection(section.id, { density: e.target.value as SectionDensity })
                          }
                          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 w-full text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                        >
                          <option value="Sparse">Sparse</option>
                          <option value="Medium">Medium</option>
                          <option value="Dense">Dense</option>
                        </select>
                      </div>

                      <div
                        className="flex items-center justify-between md:justify-end gap-2 font-mono tabular-nums text-xs"
                        title={`${stats.easy.count} inputs across ${stats.beats.toFixed(0)} beats`}
                      >
                        <span className="md:hidden text-sky-400">Easy</span>
                        <span className="text-sky-300 font-medium">{formatMetric(stats.easy)}</span>
                      </div>

                      <div
                        className="flex items-center justify-between md:justify-end gap-2 font-mono tabular-nums text-xs"
                        title={`${stats.normal.count} inputs across ${stats.beats.toFixed(0)} beats`}
                      >
                        <span className="md:hidden text-amber-400">Normal</span>
                        <span className="text-amber-300 font-medium">{formatMetric(stats.normal)}</span>
                      </div>

                      <div
                        className="flex items-center justify-between md:justify-end gap-2 font-mono tabular-nums text-xs"
                        title={`${stats.hard.count} inputs across ${stats.beats.toFixed(0)} beats`}
                      >
                        <span className="md:hidden text-emerald-400">Hard</span>
                        <span className="text-emerald-400 font-medium">{formatMetric(stats.hard)}</span>
                      </div>

                      <div className="flex justify-end">
                        <button
                          onClick={() => removeSection(section.id)}
                          className="p-1 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                          title="Remove section"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {sections.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-[2.25rem_5.5rem_1fr_7.5rem_4.25rem_4.25rem_4.25rem_2rem] gap-2.5 items-center px-3 pt-2 border-t border-gray-800 text-xs font-mono tabular-nums">
                    <div className="md:col-span-4 text-gray-400 font-sans font-medium">
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
                  <div className="text-center py-4 text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
                    No sections defined. Generated stepfile will use default density.
                  </div>
                )}
              </div>
            </div>

            {/* Exports */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 className="text-sm font-medium text-gray-400 tracking-wider uppercase">Generated Outputs</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex space-x-1 bg-gray-950 rounded-lg p-1 border border-gray-800">
                    <button
                      onClick={() => setOutputTab('sm')}
                      className={cn(
                        'px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0',
                        outputTab === 'sm' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
                      )}
                    >
                      .sm Header
                    </button>
                    <button
                      onClick={() => setOutputTab('llm')}
                      className={cn(
                        'px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0',
                        outputTab === 'llm' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
                      )}
                    >
                      LLM Prompt
                    </button>
                    <button
                      onClick={() => setOutputTab('project')}
                      className={cn(
                        'px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0',
                        outputTab === 'project' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
                      )}
                    >
                      Project JSON
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadProjectJson}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download .json</span>
                  </button>
                  <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-800 hover:bg-gray-700 text-gray-200 cursor-pointer transition-colors whitespace-nowrap shrink-0">
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Import .json</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={handleImportProjectJson}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              <div className="relative">
                <pre className="bg-gray-950 border border-gray-800 p-4 rounded-lg text-sm font-mono text-gray-300 overflow-x-auto min-h-[160px] max-h-[360px] whitespace-pre-wrap">
                  {outputTab === 'sm'
                    ? generateSMHeader()
                    : outputTab === 'llm'
                    ? generateLLMPrompt()
                    : generateProjectJson()}
                </pre>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      outputTab === 'sm'
                        ? generateSMHeader()
                        : outputTab === 'llm'
                        ? generateLLMPrompt()
                        : generateProjectJson()
                    )
                  }
                  className="absolute top-4 right-4 p-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-md transition-colors shadow-sm"
                  title="Copy to clipboard"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
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
