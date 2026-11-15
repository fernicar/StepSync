export async function analyzeAudio(buffer: AudioBuffer): Promise<{ bpm: number; offset: number }> {
  const duration = Math.min(buffer.duration, 30);
  const sampleRate = buffer.sampleRate;
  const offlineCtx = new OfflineAudioContext(1, sampleRate * duration, sampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;

  const filter = offlineCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 150;

  source.connect(filter);
  filter.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  const data = renderedBuffer.getChannelData(0);

  let maxAmp = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > maxAmp) maxAmp = Math.abs(data[i]);
  }
  const threshold = maxAmp * 0.8;

  const peaks: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] > threshold) {
      peaks.push(i);
      i += Math.floor(sampleRate / 4);
    }
  }

  if (peaks.length < 2) return { bpm: 120, offset: 0 };

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  const intervalCounts = new Map<number, number>();
  intervals.forEach(interval => {
    const bucket = Math.round(interval / 1000) * 1000;
    intervalCounts.set(bucket, (intervalCounts.get(bucket) || 0) + 1);
  });

  let bestBucket = 0;
  let maxCount = 0;
  for (const [bucket, count] of intervalCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestBucket = bucket;
    }
  }

  if (bestBucket === 0) return { bpm: 120, offset: 0 };

  const bpm = Math.round((60 * sampleRate) / bestBucket);
  const offset = peaks[0] / sampleRate;

  return { bpm: bpm > 0 ? bpm : 120, offset };
}

export async function detectOnsets(buffer: AudioBuffer): Promise<number[]> {
  const duration = buffer.duration;
  const sampleRate = buffer.sampleRate;
  
  const processDuration = Math.min(duration, 300);
  const offlineCtx = new OfflineAudioContext(1, sampleRate * processDuration, sampleRate);
  
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  
  const filter = offlineCtx.createBiquadFilter();
  filter.type = 'peaking';
  filter.frequency.value = 2000;
  filter.Q.value = 1;
  
  source.connect(filter);
  filter.connect(offlineCtx.destination);
  source.start(0);
  
  const renderedBuffer = await offlineCtx.startRendering();
  const data = renderedBuffer.getChannelData(0);
  
  const windowSize = Math.floor(sampleRate / 100); 
  const envelope = new Float32Array(Math.floor(data.length / windowSize));
  let maxAmp = 0;
  
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += Math.abs(data[i * windowSize + j]);
    }
    envelope[i] = sum / windowSize;
    if (envelope[i] > maxAmp) maxAmp = envelope[i];
  }
  
  const threshold = maxAmp * 0.15;
  const onsets: number[] = [];
  let lastPeak = 0;
  
  for (let i = 1; i < envelope.length; i++) {
    const diff = envelope[i] - envelope[i - 1];
    if (diff > threshold) {
       const time = (i * windowSize) / sampleRate;
       if (time - lastPeak > 0.08) { // 80ms debounce
           onsets.push(time);
           lastPeak = time;
       }
    }
  }
  return onsets;
}
