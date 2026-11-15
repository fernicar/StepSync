import * as ort from 'onnxruntime-web/webgpu';
import { createFFTPlan, fftInPlace } from '../lib/fft';
import { computeBandEnvelopesFromPCM } from '../lib/drumAnalysis';
import { BandEnvelopes, SeparationDiagnostics, StemEngineMode } from '../types';

const HTDEMUCS_MODEL_URL =
  'https://huggingface.co/aruiki/stemstudio-htdemucs-onnx/resolve/main/htdemucs_4s.opt.fp16w.onnx.gzbin';
const MODEL_CACHE_KEY = 'htdemucs_4s.opt.fp16w.onnx';
const LEGACY_MODEL_CACHE_KEY = 'htdemucs_4s.opt.fp16.istft.onnx';
const IDB_NAME = 'stepsync-onnx-cache';
const IDB_STORE = 'models';

const SEG_LEN = 343980; // ~7.8s @ 44.1 kHz expected by HT-Demucs ONNX
const OVERLAP_LEN = 44100; // 1.0s overlap-add crossfade

export interface WorkerRequest {
  type: 'separate' | 'check-cache' | 'clear-cache';
  mode?: StemEngineMode;
  left?: Float32Array;
  right?: Float32Array;
  sampleRate?: number;
  customModelBuffer?: ArrayBuffer;
}

export type WorkerMessage =
  | { type: 'progress'; stage: string; progress: number; status: 'loading-model' | 'processing' }
  | {
      type: 'complete';
      drumLeft: Float32Array;
      drumRight: Float32Array;
      sampleRate: number;
      envelopes: BandEnvelopes;
      diagnostics: SeparationDiagnostics;
    }
  | { type: 'cache-status'; cached: boolean }
  | { type: 'error'; message: string };

function postMsg(msg: WorkerMessage, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
}

// IndexedDB helpers for caching the ~166 MB ONNX model locally
function openModelDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedModel(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openModelDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function setCachedModel(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openModelDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(data, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore storage quota errors cleanly; session can still run from RAM
  }
}

async function clearCachedModel(key: string): Promise<void> {
  try {
    const db = await openModelDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore
  }
}

async function fetchModelWithProgress(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`Failed to fetch HT-Demucs model (HTTP ${response.status}).`);
  }

  const contentLength = Number(response.headers.get('content-length') || '0');
  if (!response.body) {
    const buf = await response.arrayBuffer();
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      const pct = contentLength > 0 ? Math.min(99, Math.round((received / contentLength) * 100)) : 50;
      const mbDone = (received / (1024 * 1024)).toFixed(1);
      const mbTotal = contentLength > 0 ? (contentLength / (1024 * 1024)).toFixed(1) : '?';
      postMsg({
        type: 'progress',
        status: 'loading-model',
        progress: pct,
        stage: `Downloading HT-Demucs WebGPU model (${mbDone} / ${mbTotal} MB)...`,
      });
    }
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Inflate .gzbin stream if gzip magic header (0x1f 0x8b) is present
  if (combined.length >= 2 && combined[0] === 0x1f && combined[1] === 0x8b) {
    postMsg({
      type: 'progress',
      status: 'loading-model',
      progress: 99,
      stage: 'Decompressing HT-Demucs ONNX weights...',
    });
    const decompressedStream = new Blob([combined])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(decompressedStream).arrayBuffer();
  }

  return combined.buffer;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = srcIdx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Fast 9-tap insertion-sort median helper on reusable scratch buffer.
 */
function median9(buf: Float32Array, count: number): number {
  for (let i = 1; i < count; i++) {
    const x = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > x) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = x;
  }
  return buf[count >> 1];
}

/**
 * Pure TypeScript HPSS (Harmonic-Percussive Source Separation) + transient shaping.
 * Processes STFT in memory-bounded blocks so any track length runs smoothly in a Web Worker.
 */
function runDspHpss(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): { drumLeft: Float32Array; drumRight: Float32Array } {
  const fftSize = 2048;
  const hopSize = 512; // 75% overlap
  const halfBins = (fftSize >> 1) + 1;
  const len = left.length;

  const plan = createFFTPlan(fftSize);
  const totalFrames = Math.max(1, Math.ceil((len + fftSize) / hopSize));

  const drumLeft = new Float32Array(len);
  const drumRight = new Float32Array(len);

  // Process in blocks of frames with +/- 4 frame context for time-median filtering
  const blockFrames = 256;
  const radiusT = 4;
  const radiusF = 4;
  const contextFrames = blockFrames + radiusT * 2;

  const blockRealL = new Float32Array(contextFrames * fftSize);
  const blockImagL = new Float32Array(contextFrames * fftSize);
  const blockRealR = new Float32Array(contextFrames * fftSize);
  const blockImagR = new Float32Array(contextFrames * fftSize);
  const blockMag = new Float32Array(contextFrames * halfBins);

  const scratch = new Float32Array(9);
  const frameReal = new Float32Array(fftSize);
  const frameImag = new Float32Array(fftSize);

  // Constant OLA normalization factor for Hann analysis + Hann synthesis at 75% overlap = 1.5
  const olaNorm = 1 / 1.5;

  // Vocal-band gentle bias: between ~280Hz and ~3200Hz, require stronger percussive dominance
  const hzPerBin = sampleRate / fftSize;
  const vocalBinLow = Math.floor(280 / hzPerBin);
  const vocalBinHigh = Math.ceil(3200 / hzPerBin);

  for (let blockStart = 0; blockStart < totalFrames; blockStart += blockFrames) {
    const validFrames = Math.min(blockFrames, totalFrames - blockStart);
    const ctxStart = blockStart - radiusT;
    const ctxCount = validFrames + radiusT * 2;

    // 1. Compute STFT for context window
    for (let cf = 0; cf < ctxCount; cf++) {
      const globalFrame = ctxStart + cf;
      const sampleOffset = globalFrame * hopSize - (fftSize >> 1);
      const specOffset = cf * fftSize;
      const magOffset = cf * halfBins;

      if (globalFrame < 0 || globalFrame >= totalFrames) {
        blockRealL.fill(0, specOffset, specOffset + fftSize);
        blockImagL.fill(0, specOffset, specOffset + fftSize);
        blockRealR.fill(0, specOffset, specOffset + fftSize);
        blockImagR.fill(0, specOffset, specOffset + fftSize);
        blockMag.fill(0, magOffset, magOffset + halfBins);
        continue;
      }

      // Left channel
      for (let i = 0; i < fftSize; i++) {
        const sIdx = sampleOffset + i;
        const w = plan.hann[i];
        frameReal[i] = sIdx >= 0 && sIdx < len ? left[sIdx] * w : 0;
        frameImag[i] = 0;
      }
      fftInPlace(plan, frameReal, frameImag, false);
      blockRealL.set(frameReal, specOffset);
      blockImagL.set(frameImag, specOffset);

      // Right channel
      for (let i = 0; i < fftSize; i++) {
        const sIdx = sampleOffset + i;
        const w = plan.hann[i];
        frameReal[i] = sIdx >= 0 && sIdx < len ? right[sIdx] * w : 0;
        frameImag[i] = 0;
      }
      fftInPlace(plan, frameReal, frameImag, false);
      blockRealR.set(frameReal, specOffset);
      blockImagR.set(frameImag, specOffset);

      // Combined magnitude for HPSS mask estimation
      for (let b = 0; b < halfBins; b++) {
        const rl = blockRealL[specOffset + b];
        const il = blockImagL[specOffset + b];
        const rr = blockRealR[specOffset + b];
        const ir = blockImagR[specOffset + b];
        blockMag[magOffset + b] = 0.5 * (Math.sqrt(rl * rl + il * il) + Math.sqrt(rr * rr + ir * ir));
      }
    }

    // 2. Estimate Percussive Wiener Mask & iSTFT overlap-add for validFrames
    for (let vf = 0; vf < validFrames; vf++) {
      const cf = vf + radiusT;
      const globalFrame = blockStart + vf;
      const sampleOffset = globalFrame * hopSize - (fftSize >> 1);
      const specOffset = cf * fftSize;
      const magOffset = cf * halfBins;

      // Apply mask to L & R positive bins, mirror Hermitian conjugate
      for (let b = 0; b < halfBins; b++) {
        // Time median H (9-tap along time)
        let tCount = 0;
        for (let dt = -radiusT; dt <= radiusT; dt++) {
          scratch[tCount++] = blockMag[(cf + dt) * halfBins + b];
        }
        const hVal = median9(scratch, tCount);

        // Freq median P (9-tap along frequency)
        let fCount = 0;
        const bMin = Math.max(0, b - radiusF);
        const bMax = Math.min(halfBins - 1, b + radiusF);
        for (let fb = bMin; fb <= bMax; fb++) {
          scratch[fCount++] = blockMag[magOffset + fb];
        }
        const pVal = median9(scratch, fCount);

        // Harmonic suppression multiplier stronger in mid vocal region
        const hBias = b >= vocalBinLow && b <= vocalBinHigh ? 1.45 : 1.0;
        const p2 = pVal * pVal;
        const h2 = (hVal * hBias) * (hVal * hBias);
        const mask = p2 / (p2 + h2 + 1e-12);

        const rl = blockRealL[specOffset + b] * mask;
        const il = blockImagL[specOffset + b] * mask;
        const rr = blockRealR[specOffset + b] * mask;
        const ir = blockImagR[specOffset + b] * mask;

        blockRealL[specOffset + b] = rl;
        blockImagL[specOffset + b] = il;
        blockRealR[specOffset + b] = rr;
        blockImagR[specOffset + b] = ir;

        if (b > 0 && b < halfBins - 1) {
          const conj = fftSize - b;
          blockRealL[specOffset + conj] = rl;
          blockImagL[specOffset + conj] = -il;
          blockRealR[specOffset + conj] = rr;
          blockImagR[specOffset + conj] = -ir;
        }
      }

      // iFFT Left
      frameReal.set(blockRealL.subarray(specOffset, specOffset + fftSize));
      frameImag.set(blockImagL.subarray(specOffset, specOffset + fftSize));
      fftInPlace(plan, frameReal, frameImag, true);
      for (let i = 0; i < fftSize; i++) {
        const sIdx = sampleOffset + i;
        if (sIdx >= 0 && sIdx < len) {
          drumLeft[sIdx] += frameReal[i] * plan.hann[i] * olaNorm;
        }
      }

      // iFFT Right
      frameReal.set(blockRealR.subarray(specOffset, specOffset + fftSize));
      frameImag.set(blockImagR.subarray(specOffset, specOffset + fftSize));
      fftInPlace(plan, frameReal, frameImag, true);
      for (let i = 0; i < fftSize; i++) {
        const sIdx = sampleOffset + i;
        if (sIdx >= 0 && sIdx < len) {
          drumRight[sIdx] += frameReal[i] * plan.hann[i] * olaNorm;
        }
      }
    }

    const pct = Math.min(88, Math.round(((blockStart + validFrames) / totalFrames) * 88));
    postMsg({
      type: 'progress',
      status: 'processing',
      progress: pct,
      stage: `Separating percussion via HPSS (${pct}%)...`,
    });
  }

  return { drumLeft, drumRight };
}

function inspectFloatStats(arr: Float32Array, length = arr.length): {
  maxAbs: number;
  nanCount: number;
  infCount: number;
} {
  let maxAbs = 0;
  let nanCount = 0;
  let infCount = 0;
  const limit = Math.min(length, arr.length);
  for (let i = 0; i < limit; i++) {
    const v = arr[i];
    if (Number.isNaN(v)) {
      nanCount++;
    } else if (!Number.isFinite(v)) {
      infCount++;
    } else {
      const a = Math.abs(v);
      if (a > maxAbs) maxAbs = a;
    }
  }
  return { maxAbs, nanCount, infCount };
}

/**
 * WebGPU HT-Demucs ONNX inference with 7.8s overlap-add chunking.
 */
async function runWebGpuDemucs(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  customModelBuffer?: ArrayBuffer
): Promise<{
  drumLeft: Float32Array;
  drumRight: Float32Array;
  outSampleRate: number;
  diagnostics: SeparationDiagnostics;
}> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown | null> } }).gpu;
  if (!gpu) {
    throw new Error('WebGPU is not enabled in this browser. Switch to Instant DSP (HPSS) or use a WebGPU-enabled browser.');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error('No compatible WebGPU GPU adapter found. Switch to Instant DSP (HPSS).');
  }

  ort.env.wasm.wasmPaths = {
    wasm: `${self.location.origin}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
  };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  await clearCachedModel(LEGACY_MODEL_CACHE_KEY);
  let modelBuffer = customModelBuffer || (await getCachedModel(MODEL_CACHE_KEY));
  if (!modelBuffer) {
    postMsg({
      type: 'progress',
      status: 'loading-model',
      progress: 1,
      stage: 'Downloading WebGPU HT-Demucs (fp16w/fp32) model (cached locally after first run)...',
    });
    modelBuffer = await fetchModelWithProgress(HTDEMUCS_MODEL_URL);
    await setCachedModel(MODEL_CACHE_KEY, modelBuffer);
  } else if (
    customModelBuffer &&
    new Uint8Array(customModelBuffer, 0, Math.min(2, customModelBuffer.byteLength))[0] === 0x1f &&
    new Uint8Array(customModelBuffer, 0, Math.min(2, customModelBuffer.byteLength))[1] === 0x8b
  ) {
    const decompressedStream = new Blob([customModelBuffer])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    modelBuffer = await new Response(decompressedStream).arrayBuffer();
  }

  postMsg({
    type: 'progress',
    status: 'loading-model',
    progress: 100,
    stage: 'Initializing WebGPU inference session...',
  });

  // IMPORTANT: htdemucs_4s.opt.fp16.istft.onnx is already optimized prior to fp16 conversion.
  // Running ORT graph optimizers again at runtime ('all') can overflow folded fp16 constants to NaN.
  const createSession = async (
    providers: ('webgpu' | 'wasm')[],
    optLevel: 'disabled' | 'basic' | 'all'
  ) => {
    return await ort.InferenceSession.create(modelBuffer!, {
      executionProviders: providers,
      graphOptimizationLevel: optLevel,
    });
  };

  let backendUsed = 'webgpu+wasm (opt=disabled)';
  let session: ort.InferenceSession;
  try {
    session = await createSession(['webgpu', 'wasm'], 'disabled');
  } catch (err1) {
    try {
      backendUsed = 'webgpu+wasm (opt=basic)';
      session = await createSession(['webgpu', 'wasm'], 'basic');
    } catch (err2) {
      try {
        backendUsed = 'wasm (opt=disabled)';
        postMsg({
          type: 'progress',
          status: 'loading-model',
          progress: 100,
          stage: 'WebGPU session unsupported for this model; falling back to WASM...',
        });
        session = await createSession(['wasm'], 'disabled');
      } catch (err3) {
        const msg1 = err1 instanceof Error ? err1.message : String(err1);
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        const msg3 = err3 instanceof Error ? err3.message : String(err3);
        throw new Error(`ONNX session failed (${msg1} | ${msg2} | ${msg3})`);
      }
    }
  }

  const targetRate = 44100;
  const left44 = resampleLinear(left, sampleRate, targetRate);
  const right44 = resampleLinear(right, sampleRate, targetRate);
  const totalSamples = left44.length;

  const step = SEG_LEN - OVERLAP_LEN;
  const totalChunks = Math.max(1, Math.ceil(Math.max(0, totalSamples - OVERLAP_LEN) / step));

  const runChunk = async (
    sess: ort.InferenceSession,
    chunkIndex: number
  ): Promise<{ leftOut: Float32Array; rightOut: Float32Array; copyLen: number; inputPeak: number; dims: readonly number[]; type: string }> => {
    const inputName = sess.inputNames[0] || 'mix';
    const outputName = sess.outputNames[0] || 'stems';
    const start = chunkIndex * step;
    const mixChunk = new Float32Array(2 * SEG_LEN);
    const copyLen = Math.min(SEG_LEN, totalSamples - start);

    let inputPeak = 0;
    for (let i = 0; i < copyLen; i++) {
      const l = left44[start + i];
      const r = right44[start + i];
      mixChunk[i] = l;
      mixChunk[SEG_LEN + i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > inputPeak) inputPeak = a;
    }

    const inputTensor = new ort.Tensor('float32', mixChunk, [1, 2, SEG_LEN]);
    const results = await sess.run({ [inputName]: inputTensor });
    const outputTensor = results[outputName];
    const dims = outputTensor.dims;
    const type = outputTensor.type;
    const rawData = await outputTensor.getData();
    const outData = rawData as Float32Array;

    // Copy stem 0 (Drums) stereo channels before disposing tensor
    const leftOut = new Float32Array(copyLen);
    const rightOut = new Float32Array(copyLen);
    leftOut.set(outData.subarray(0, copyLen));
    rightOut.set(outData.subarray(SEG_LEN, SEG_LEN + copyLen));

    inputTensor.dispose();
    outputTensor.dispose();

    return { leftOut, rightOut, copyLen, inputPeak, dims, type };
  };

  let note: string | undefined;

  try {
    // Find first non-silent chunk to validate that the GPU execution produces valid non-NaN audio
    let probeChunkIdx = 0;
    for (let c = 0; c < totalChunks; c++) {
      const s = c * step;
      const end = Math.min(totalSamples, s + SEG_LEN);
      let peak = 0;
      for (let i = s; i < end; i += 64) {
        const a = Math.max(Math.abs(left44[i]), Math.abs(right44[i]));
        if (a > peak) peak = a;
      }
      if (peak > 0.005) {
        probeChunkIdx = c;
        break;
      }
    }

    let probeResult = await runChunk(session, probeChunkIdx);
    let probeStatsL = inspectFloatStats(probeResult.leftOut);
    let probeStatsR = inspectFloatStats(probeResult.rightOut);

    if (
      probeResult.inputPeak > 0.005 &&
      (probeStatsL.nanCount > 0 ||
        probeStatsR.nanCount > 0 ||
        probeStatsL.infCount > 0 ||
        probeStatsR.infCount > 0 ||
        (probeStatsL.maxAbs < 1e-5 && probeStatsR.maxAbs < 1e-5))
    ) {
      // WebGPU shader overflowed or returned zeros on this hardware; retry via WASM CPU EP
      const webgpuDiag = `ep=${backendUsed}, dims=[${probeResult.dims.join(',')}], type=${probeResult.type}, nan=${probeStatsL.nanCount + probeStatsR.nanCount}, maxAbs=${Math.max(probeStatsL.maxAbs, probeStatsR.maxAbs).toExponential(2)}`;
      await session.release();

      postMsg({
        type: 'progress',
        status: 'loading-model',
        progress: 100,
        stage: `WebGPU produced invalid output (${webgpuDiag}); retrying via WASM CPU...`,
      });

      backendUsed = 'wasm fallback (opt=disabled)';
      note = `WebGPU overflowed on GPU (${webgpuDiag}); separated via WASM fallback.`;
      session = await createSession(['wasm'], 'disabled');
      probeResult = await runChunk(session, probeChunkIdx);
      probeStatsL = inspectFloatStats(probeResult.leftOut);
      probeStatsR = inspectFloatStats(probeResult.rightOut);

      if (
        probeStatsL.nanCount > 0 ||
        probeStatsR.nanCount > 0 ||
        (probeStatsL.maxAbs < 1e-5 && probeStatsR.maxAbs < 1e-5)
      ) {
        throw new Error(
          `Model produced silent/NaN output on both WebGPU and WASM (${webgpuDiag} | wasmMax=${Math.max(probeStatsL.maxAbs, probeStatsR.maxAbs).toExponential(2)}, wasmNaN=${probeStatsL.nanCount + probeStatsR.nanCount}). Try Instant DSP (HPSS) or clear cached model.`
        );
      }
    }

    const drumLeft = new Float32Array(totalSamples);
    const drumRight = new Float32Array(totalSamples);
    const weightAcc = new Float32Array(totalSamples);
    let totalNanReplaced = 0;

    for (let c = 0; c < totalChunks; c++) {
      const start = c * step;
      const chunkRes = c === probeChunkIdx ? probeResult : await runChunk(session, c);

      for (let i = 0; i < chunkRes.copyLen; i++) {
        let w = 1.0;
        if (c > 0 && i < OVERLAP_LEN) {
          w = i / OVERLAP_LEN;
        } else if (c < totalChunks - 1 && i >= SEG_LEN - OVERLAP_LEN) {
          w = (SEG_LEN - i) / OVERLAP_LEN;
        }
        let lVal = chunkRes.leftOut[i];
        let rVal = chunkRes.rightOut[i];
        if (!Number.isFinite(lVal)) {
          lVal = 0;
          totalNanReplaced++;
        }
        if (!Number.isFinite(rVal)) {
          rVal = 0;
          totalNanReplaced++;
        }
        drumLeft[start + i] += lVal * w;
        drumRight[start + i] += rVal * w;
        weightAcc[start + i] += w;
      }

      const pct = Math.min(89, Math.round(((c + 1) / totalChunks) * 89));
      postMsg({
        type: 'progress',
        status: 'processing',
        progress: pct,
        stage: `Separating drums via ${backendUsed.startsWith('wasm') ? 'WASM fallback' : 'WebGPU'} (chunk ${c + 1} / ${totalChunks})...`,
      });
    }

    let peakAmplitude = 0;
    for (let i = 0; i < totalSamples; i++) {
      const w = weightAcc[i];
      if (w > 1e-6) {
        drumLeft[i] /= w;
        drumRight[i] /= w;
      }
      const a = Math.max(Math.abs(drumLeft[i]), Math.abs(drumRight[i]));
      if (a > peakAmplitude) peakAmplitude = a;
    }

    if (peakAmplitude < 1e-5) {
      throw new Error(
        `Separated drum buffer was silent (peak=${peakAmplitude.toExponential(2)}, backend=${backendUsed}). Try Instant DSP (HPSS).`
      );
    }

    return {
      drumLeft,
      drumRight,
      outSampleRate: targetRate,
      diagnostics: {
        backendUsed,
        peakAmplitude,
        nanSamplesReplaced: totalNanReplaced,
        chunksProcessed: totalChunks,
        note,
      },
    };
  } finally {
    await session.release();
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  try {
    if (req.type === 'check-cache') {
      await clearCachedModel(LEGACY_MODEL_CACHE_KEY);
      const cached = await getCachedModel(MODEL_CACHE_KEY);
      postMsg({ type: 'cache-status', cached: cached !== null });
      return;
    }

    if (req.type === 'clear-cache') {
      await clearCachedModel(LEGACY_MODEL_CACHE_KEY);
      await clearCachedModel(MODEL_CACHE_KEY);
      postMsg({ type: 'cache-status', cached: false });
      return;
    }

    if (req.type === 'separate') {
      if (!req.left || !req.right || !req.sampleRate) {
        throw new Error('Missing audio channel buffers for separation.');
      }

      let drumLeft: Float32Array;
      let drumRight: Float32Array;
      let outSampleRate = req.sampleRate;
      let diagnostics: SeparationDiagnostics;

      if (req.mode === 'webgpu-demucs') {
        const res = await runWebGpuDemucs(
          req.left,
          req.right,
          req.sampleRate,
          req.customModelBuffer
        );
        drumLeft = res.drumLeft;
        drumRight = res.drumRight;
        outSampleRate = res.outSampleRate;
        diagnostics = res.diagnostics;
      } else {
        const res = runDspHpss(req.left, req.right, req.sampleRate);
        drumLeft = res.drumLeft;
        drumRight = res.drumRight;
        const statsL = inspectFloatStats(drumLeft);
        const statsR = inspectFloatStats(drumRight);
        diagnostics = {
          backendUsed: 'DSP HPSS (STFT)',
          peakAmplitude: Math.max(statsL.maxAbs, statsR.maxAbs),
          nanSamplesReplaced: 0,
          chunksProcessed: 1,
        };
      }

      postMsg({
        type: 'progress',
        status: 'processing',
        progress: 90,
        stage: 'Analyzing Kick, Snare/Clap, and Hi-Hat bands...',
      });

      const mono = new Float32Array(drumLeft.length);
      for (let i = 0; i < drumLeft.length; i++) {
        mono[i] = 0.5 * (drumLeft[i] + drumRight[i]);
      }

      const envelopes = computeBandEnvelopesFromPCM(mono, outSampleRate, (envPct) => {
        const totalPct = 90 + Math.round(envPct * 0.1);
        postMsg({
          type: 'progress',
          status: 'processing',
          progress: Math.min(99, totalPct),
          stage: 'Analyzing Kick, Snare/Clap, and Hi-Hat bands...',
        });
      });

      postMsg(
        {
          type: 'complete',
          drumLeft,
          drumRight,
          sampleRate: outSampleRate,
          envelopes,
          diagnostics,
        },
        [
          drumLeft.buffer,
          drumRight.buffer,
          envelopes.kick.buffer,
          envelopes.snare.buffer,
          envelopes.hat.buffer,
        ]
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected worker error during stem separation.';
    postMsg({ type: 'error', message });
  }
};
