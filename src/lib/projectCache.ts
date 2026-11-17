import {
  BandEnvelopes,
  SeparationDiagnostics,
  SpectralEnvelopeCache,
  StepSyncProject,
} from '../types';

const DB_NAME = 'stepsync-storage';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';
const MAGIC = 'SSCH';

export interface CachedDrumPcm {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

export interface CachedTrackData {
  fileName: string;
  updatedAt: string;
  source: 'indexeddb' | 'public' | 'computed';
  project?: StepSyncProject;
  envelopes?: BandEnvelopes | null;
  spectralCache?: SpectralEnvelopeCache | null;
  diagnostics?: SeparationDiagnostics | null;
  drumPcm?: CachedDrumPcm | null;
  stemCleared?: boolean;
}

function openStorageDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'fileName' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadTrackFromStorageDb(
  fileName: string
): Promise<CachedTrackData | null> {
  const db = await openStorageDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fileName);
      req.onsuccess = () => resolve((req.result as CachedTrackData) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveTrackToStorageDb(data: CachedTrackData): Promise<boolean> {
  const db = await openStorageDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(data);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function deleteTrackFromStorageDb(fileName: string): Promise<boolean> {
  const db = await openStorageDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(fileName);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

interface CacheFileHeader {
  version: 1;
  fileName: string;
  envelopes: {
    hopTime: number;
    duration: number;
    kickLen: number;
    snareLen: number;
    hatLen: number;
  } | null;
  spectralCache: {
    sampleRate: number;
    hopTime: number;
    frameCount: number;
    numBands: number;
    minFreq: number;
    maxFreq: number;
    fluxLen: number;
    energyLen: number;
  } | null;
  diagnostics: SeparationDiagnostics | null;
}

async function gzipBytes(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return raw;
  try {
    const compressedStream = new Blob([raw as unknown as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const out = await new Response(compressedStream).arrayBuffer();
    return new Uint8Array(out);
  } catch {
    return raw;
  }
}

async function maybeUngzipBytes(raw: Uint8Array): Promise<Uint8Array> {
  const isGzip = raw.byteLength >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!isGzip || typeof DecompressionStream === 'undefined') return raw;
  const decompressedStream = new Blob([raw as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const out = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(out);
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

export async function encodeAnalysisCacheBlob(payload: {
  fileName: string;
  envelopes: BandEnvelopes | null;
  spectralCache: SpectralEnvelopeCache | null;
  diagnostics: SeparationDiagnostics | null;
}): Promise<Blob> {
  const { fileName, envelopes, spectralCache, diagnostics } = payload;

  const header: CacheFileHeader = {
    version: 1,
    fileName,
    envelopes: envelopes
      ? {
          hopTime: envelopes.hopTime,
          duration: envelopes.duration,
          kickLen: envelopes.kick.length,
          snareLen: envelopes.snare.length,
          hatLen: envelopes.hat.length,
        }
      : null,
    spectralCache: spectralCache
      ? {
          sampleRate: spectralCache.sampleRate,
          hopTime: spectralCache.hopTime,
          frameCount: spectralCache.frameCount,
          numBands: spectralCache.numBands,
          minFreq: spectralCache.minFreq,
          maxFreq: spectralCache.maxFreq,
          fluxLen: spectralCache.fluxGrid.length,
          energyLen: spectralCache.energyGrid.length,
        }
      : null,
    diagnostics,
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const paddedHeaderLen = Math.ceil(headerBytes.byteLength / 4) * 4;

  const floatBytes =
    (envelopes
      ? (envelopes.kick.length + envelopes.snare.length + envelopes.hat.length) * 4
      : 0) +
    (spectralCache
      ? (spectralCache.fluxGrid.length + spectralCache.energyGrid.length) * 4
      : 0);

  const totalBytes = 8 + paddedHeaderLen + floatBytes;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  for (let i = 0; i < 4; i++) {
    u8[i] = MAGIC.charCodeAt(i);
  }
  view.setUint32(4, headerBytes.byteLength, true);
  u8.set(headerBytes, 8);

  let offset = 8 + paddedHeaderLen;
  const appendFloat32 = (arr: Float32Array) => {
    const dest = new Float32Array(buffer, offset, arr.length);
    dest.set(arr);
    offset += arr.length * 4;
  };

  if (envelopes) {
    appendFloat32(envelopes.kick);
    appendFloat32(envelopes.snare);
    appendFloat32(envelopes.hat);
  }
  if (spectralCache) {
    appendFloat32(spectralCache.fluxGrid);
    appendFloat32(spectralCache.energyGrid);
  }

  const compressed = await gzipBytes(u8);
  return new Blob([compressed as unknown as BlobPart], { type: 'application/octet-stream' });
}

export async function decodeAnalysisCacheArrayBuffer(arrayBuffer: ArrayBuffer): Promise<{
  fileName: string;
  envelopes: BandEnvelopes | null;
  spectralCache: SpectralEnvelopeCache | null;
  diagnostics: SeparationDiagnostics | null;
} | null> {
  try {
    const raw = await maybeUngzipBytes(new Uint8Array(arrayBuffer));
    if (raw.byteLength < 8) return null;
    const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
    if (magic !== MAGIC) return null;

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const headerLen = view.getUint32(4, true);
    if (8 + headerLen > raw.byteLength) return null;

    const headerJson = new TextDecoder().decode(raw.subarray(8, 8 + headerLen));
    const header = JSON.parse(headerJson) as CacheFileHeader;
    if (!header || header.version !== 1) return null;

    const paddedHeaderLen = Math.ceil(headerLen / 4) * 4;
    let offset = 8 + paddedHeaderLen;

    const readFloat32 = (len: number): Float32Array => {
      const byteLen = len * 4;
      const slice = new Float32Array(len);
      const src = new Uint8Array(raw.buffer, raw.byteOffset + offset, byteLen);
      new Uint8Array(slice.buffer).set(src);
      offset += byteLen;
      return slice;
    };

    let envelopes: BandEnvelopes | null = null;
    if (header.envelopes) {
      envelopes = {
        hopTime: header.envelopes.hopTime,
        duration: header.envelopes.duration,
        kick: readFloat32(header.envelopes.kickLen),
        snare: readFloat32(header.envelopes.snareLen),
        hat: readFloat32(header.envelopes.hatLen),
      };
    }

    let spectralCache: SpectralEnvelopeCache | null = null;
    if (header.spectralCache) {
      spectralCache = {
        sampleRate: header.spectralCache.sampleRate,
        hopTime: header.spectralCache.hopTime,
        frameCount: header.spectralCache.frameCount,
        numBands: header.spectralCache.numBands,
        minFreq: header.spectralCache.minFreq,
        maxFreq: header.spectralCache.maxFreq,
        fluxGrid: readFloat32(header.spectralCache.fluxLen),
        energyGrid: readFloat32(header.spectralCache.energyLen),
      };
    }

    return {
      fileName: header.fileName,
      envelopes,
      spectralCache,
      diagnostics: header.diagnostics ?? null,
    };
  } catch {
    return null;
  }
}
