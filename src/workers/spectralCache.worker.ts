import { buildSpectralEnvelopeCache } from '../lib/drumAnalysis';

export interface SpectralCacheRequest {
  mono: Float32Array;
  sampleRate: number;
}

export interface SpectralCacheResponse {
  sampleRate: number;
  hopTime: number;
  frameCount: number;
  numBands: number;
  minFreq: number;
  maxFreq: number;
  fluxGrid: Float32Array;
  energyGrid: Float32Array;
}

self.onmessage = (e: MessageEvent<SpectralCacheRequest>) => {
  const { mono, sampleRate } = e.data;
  const cache = buildSpectralEnvelopeCache(mono, sampleRate);
  (self as unknown as Worker).postMessage(cache, [
    cache.fluxGrid.buffer,
    cache.energyGrid.buffer,
  ]);
};
