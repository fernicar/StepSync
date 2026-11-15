import { BandEnvelopes, SeparationDiagnostics, StemEngineMode } from '../types';
import { computeBandEnvelopesFromPCM } from './drumAnalysis';
import type { WorkerMessage, WorkerRequest } from '../workers/stemSeparation.worker';

export interface SeparationCallbacks {
  onProgress: (progress: number, stage: string, status: 'loading-model' | 'processing') => void;
}

export interface SeparationResult {
  drumBuffer: AudioBuffer;
  envelopes: BandEnvelopes;
  diagnostics: SeparationDiagnostics;
}

let activeWorker: Worker | null = null;

export function cancelActiveSeparation(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
}

export async function checkWebGpuSupport(): Promise<{ available: boolean; reason?: string }> {
  const nav = navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown | null> } };
  if (!nav.gpu) {
    return { available: false, reason: 'WebGPU API not exposed by this browser' };
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: 'No hardware WebGPU adapter available' };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'WebGPU adapter initialization failed' };
  }
}

export function checkDemucsModelCached(): Promise<boolean> {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL('../workers/stemSeparation.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      if (e.data.type === 'cache-status') {
        resolve(e.data.cached);
        worker.terminate();
      }
    };
    worker.onerror = () => {
      resolve(false);
      worker.terminate();
    };
    const msg: WorkerRequest = { type: 'check-cache' };
    worker.postMessage(msg);
  });
}

export function clearDemucsModelCache(): Promise<void> {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL('../workers/stemSeparation.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = () => {
      resolve();
      worker.terminate();
    };
    worker.onerror = () => {
      resolve();
      worker.terminate();
    };
    const msg: WorkerRequest = { type: 'clear-cache' };
    worker.postMessage(msg);
  });
}

export function createAudioBufferFromChannels(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): AudioBuffer {
  const ctx = new OfflineAudioContext(2, left.length, sampleRate);
  const buf = ctx.createBuffer(2, left.length, sampleRate);
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  return buf;
}

export function separateDrumStem(
  sourceBuffer: AudioBuffer,
  mode: StemEngineMode,
  callbacks: SeparationCallbacks,
  customModelBuffer?: ArrayBuffer
): Promise<SeparationResult> {
  cancelActiveSeparation();

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/stemSeparation.worker.ts', import.meta.url),
      { type: 'module' }
    );
    activeWorker = worker;

    const left = new Float32Array(sourceBuffer.getChannelData(0));
    const right =
      sourceBuffer.numberOfChannels > 1
        ? new Float32Array(sourceBuffer.getChannelData(1))
        : new Float32Array(left);

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        callbacks.onProgress(msg.progress, msg.stage, msg.status);
      } else if (msg.type === 'complete') {
        const drumBuffer = createAudioBufferFromChannels(
          msg.drumLeft,
          msg.drumRight,
          msg.sampleRate
        );
        if (activeWorker === worker) activeWorker = null;
        worker.terminate();
        resolve({
          drumBuffer,
          envelopes: msg.envelopes,
          diagnostics: msg.diagnostics,
        });
      } else if (msg.type === 'error') {
        if (activeWorker === worker) activeWorker = null;
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      if (activeWorker === worker) activeWorker = null;
      worker.terminate();
      reject(new Error(err.message || 'Background worker failed unexpectedly.'));
    };

    const transferList: Transferable[] = [left.buffer, right.buffer];
    if (customModelBuffer) {
      transferList.push(customModelBuffer);
    }

    const req: WorkerRequest = {
      type: 'separate',
      mode,
      left,
      right,
      sampleRate: sourceBuffer.sampleRate,
      customModelBuffer,
    };
    worker.postMessage(req, transferList);
  });
}

export function analyzePreSeparatedDrumBuffer(drumBuffer: AudioBuffer): BandEnvelopes {
  const left = drumBuffer.getChannelData(0);
  const right =
    drumBuffer.numberOfChannels > 1 ? drumBuffer.getChannelData(1) : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    mono[i] = 0.5 * (left[i] + right[i]);
  }
  return computeBandEnvelopesFromPCM(mono, drumBuffer.sampleRate);
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataByteLength = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  view.setUint32(40, dataByteLength, true);

  const ch0 = buffer.getChannelData(0);
  const ch1 = numChannels > 1 ? buffer.getChannelData(1) : ch0;

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const raw0 = Number.isFinite(ch0[i]) ? ch0[i] : 0;
    const s0 = Math.max(-1, Math.min(1, raw0));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      const raw1 = Number.isFinite(ch1[i]) ? ch1[i] : 0;
      const s1 = Math.max(-1, Math.min(1, raw1));
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
