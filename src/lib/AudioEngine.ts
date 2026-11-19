export type SimDrumBand = 'kick' | 'snare' | 'hat' | 'tom';

export interface SimTriggerEvent {
  time: number;
  band: SimDrumBand;
}

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private drumBuffer: AudioBuffer | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private source: AudioBufferSourceNode | null = null;
  private drumSource: AudioBufferSourceNode | null = null;
  private mixGainNode: GainNode | null = null;
  private drumGainNode: GainNode | null = null;
  private outputBus: GainNode | null = null;
  private trackGainNode: GainNode | null = null;
  private simGainNode: GainNode | null = null;
  private simLimiterNode: DynamicsCompressorNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private drumAnalyser: AnalyserNode | null = null;
  private mediaStreamDest: MediaStreamAudioDestinationNode | null = null;
  private soloHp1: BiquadFilterNode | null = null;
  private soloHp2: BiquadFilterNode | null = null;
  private soloLp1: BiquadFilterNode | null = null;
  private soloLp2: BiquadFilterNode | null = null;
  private soloRange: { minHz: number; maxHz: number } | null = null;
  private soloConnected = false;

  private mixGainValue = 1.0;
  private drumGainValue = 0.0;
  private trackVolume = 1.0;
  private simVolume = 0.85;

  private isPlaying = false;
  private playStartTime = 0;
  private pauseOffset = 0;

  private bpm = 120;
  private trackOffset = 0;
  private metronomeActive = false;

  private lookahead = 25.0;
  private scheduleAheadTime = 0.1;
  private timerID: number | null = null;

  private nextBeatIndex = 0;
  private loop = false;

  private simEvents: SimTriggerEvent[] = [];
  private simEnabledBands: Record<SimDrumBand, boolean> = {
    kick: false,
    snare: false,
    hat: false,
    tom: false,
  };
  private lastScheduledElapsed = -0.0001;

  private initCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.outputBus = this.audioCtx.createGain();
      this.outputBus.gain.value = 1.0;

      this.trackGainNode = this.audioCtx.createGain();
      this.trackGainNode.gain.value = this.trackVolume;

      this.outputAnalyser = this.audioCtx.createAnalyser();
      this.outputAnalyser.fftSize = 8192;
      this.outputAnalyser.smoothingTimeConstant = 0.68;
      this.outputAnalyser.minDecibels = -90;
      this.outputAnalyser.maxDecibels = -10;

      this.simGainNode = this.audioCtx.createGain();
      this.simGainNode.gain.value = this.simVolume * 2.2;

      this.simLimiterNode = this.audioCtx.createDynamicsCompressor();
      this.simLimiterNode.threshold.value = -2.0;
      this.simLimiterNode.knee.value = 6.0;
      this.simLimiterNode.ratio.value = 10.0;
      this.simLimiterNode.attack.value = 0.001;
      this.simLimiterNode.release.value = 0.045;

      this.simGainNode.connect(this.simLimiterNode);
      this.simLimiterNode.connect(this.outputAnalyser);

      this.trackGainNode.connect(this.outputAnalyser);
      this.outputAnalyser.connect(this.audioCtx.destination);

      this.drumAnalyser = this.audioCtx.createAnalyser();
      this.drumAnalyser.fftSize = 8192;
      this.drumAnalyser.smoothingTimeConstant = 0.65;
      this.drumAnalyser.minDecibels = -90;
      this.drumAnalyser.maxDecibels = -10;

      this.soloHp1 = this.audioCtx.createBiquadFilter();
      this.soloHp1.type = 'highpass';
      this.soloHp1.Q.value = 0.7071;

      this.soloHp2 = this.audioCtx.createBiquadFilter();
      this.soloHp2.type = 'highpass';
      this.soloHp2.Q.value = 0.7071;

      this.soloLp1 = this.audioCtx.createBiquadFilter();
      this.soloLp1.type = 'lowpass';
      this.soloLp1.Q.value = 0.7071;

      this.soloLp2 = this.audioCtx.createBiquadFilter();
      this.soloLp2.type = 'lowpass';
      this.soloLp2.Q.value = 0.7071;

      this.soloHp1.connect(this.soloHp2);
      this.soloHp2.connect(this.soloLp1);
      this.soloLp1.connect(this.soloLp2);

      this.updateSoloRouting(true);
    }
  }

  private getNoiseBuffer(): AudioBuffer | null {
    if (!this.audioCtx) return null;
    if (!this.noiseBuffer) {
      const sampleRate = this.audioCtx.sampleRate;
      const length = Math.max(1, Math.floor(sampleRate * 0.15));
      const buf = this.audioCtx.createBuffer(1, length, sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  private updateSoloRouting(force = false) {
    if (
      !this.audioCtx ||
      !this.outputBus ||
      !this.trackGainNode ||
      !this.soloHp1 ||
      !this.soloHp2 ||
      !this.soloLp1 ||
      !this.soloLp2
    ) {
      return;
    }

    const wantSolo = this.soloRange !== null;
    if (this.soloRange) {
      const minHz = Math.max(20, Math.min(18000, this.soloRange.minHz));
      const maxHz = Math.max(minHz + 10, Math.min(20000, this.soloRange.maxHz));
      const now = this.audioCtx.currentTime;
      this.soloHp1.frequency.setTargetAtTime(minHz, now, 0.015);
      this.soloHp2.frequency.setTargetAtTime(minHz, now, 0.015);
      this.soloLp1.frequency.setTargetAtTime(maxHz, now, 0.015);
      this.soloLp2.frequency.setTargetAtTime(maxHz, now, 0.015);
    }

    if (force || wantSolo !== this.soloConnected) {
      this.outputBus.disconnect();
      this.soloLp2.disconnect();

      if (wantSolo) {
        this.outputBus.connect(this.soloHp1);
        this.soloLp2.connect(this.trackGainNode);
      } else {
        this.outputBus.connect(this.trackGainNode);
      }
      this.soloConnected = wantSolo;
    }
  }

  public setTrackVolume(volume: number) {
    this.trackVolume = Math.max(0, Math.min(1, volume));
    if (this.audioCtx && this.trackGainNode) {
      this.trackGainNode.gain.setTargetAtTime(
        this.trackVolume,
        this.audioCtx.currentTime,
        0.015
      );
    }
  }

  public getTrackVolume(): number {
    return this.trackVolume;
  }

  public setSimVolume(volume: number) {
    this.simVolume = Math.max(0, Math.min(1, volume));
    if (this.audioCtx && this.simGainNode) {
      this.simGainNode.gain.setTargetAtTime(
        this.simVolume * 2.2,
        this.audioCtx.currentTime,
        0.015
      );
    }
  }

  public getSimVolume(): number {
    return this.simVolume;
  }

  public setSimulatedTriggers(
    events: SimTriggerEvent[],
    enabledBands: Record<SimDrumBand, boolean>
  ) {
    this.simEvents = [...events].sort((a, b) => a.time - b.time);
    this.simEnabledBands = {
      kick: Boolean(enabledBands.kick),
      snare: Boolean(enabledBands.snare),
      hat: Boolean(enabledBands.hat),
      tom: Boolean(enabledBands.tom),
    };
  }

  public setSoloBand(range: { minHz: number; maxHz: number } | null) {
    this.soloRange = range
      ? {
          minHz: Math.max(20, Math.min(range.minHz, range.maxHz - 10)),
          maxHz: Math.min(20000, Math.max(range.maxHz, range.minHz + 10)),
        }
      : null;
    this.updateSoloRouting();
  }

  public getSoloBand(): { minHz: number; maxHz: number } | null {
    return this.soloRange;
  }

  public getAnalyser(source: 'output' | 'drums' = 'output'): AnalyserNode | null {
    if (source === 'drums' && this.drumBuffer && this.drumAnalyser) {
      return this.drumAnalyser;
    }
    return this.outputAnalyser;
  }

  public getSampleRate(): number {
    return this.audioCtx?.sampleRate || this.buffer?.sampleRate || 44100;
  }

  public getCaptureAudioStream(): MediaStream | null {
    this.initCtx();
    if (!this.audioCtx || !this.outputAnalyser) return null;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if (!this.mediaStreamDest) {
      this.mediaStreamDest = this.audioCtx.createMediaStreamDestination();
      this.outputAnalyser.connect(this.mediaStreamDest);
    }
    return this.mediaStreamDest.stream;
  }

  public setBuffer(buffer: AudioBuffer | null) {
    this.buffer = buffer;
    this.drumBuffer = null;
    this.mixGainValue = 1.0;
    this.drumGainValue = 0.0;
    this.pauseOffset = 0;
    if (this.isPlaying) {
      this.stop();
      this.play();
    }
  }

  public setDrumBuffer(drumBuffer: AudioBuffer | null) {
    const wasPlaying = this.isPlaying;
    const resumeTime = wasPlaying ? this.getCurrentTime() : this.pauseOffset;
    if (wasPlaying) {
      this.pause();
    }
    this.drumBuffer = drumBuffer;
    this.pauseOffset = resumeTime;
    if (wasPlaying) {
      this.play();
    }
  }

  public getDrumBuffer(): AudioBuffer | null {
    return this.drumBuffer;
  }

  public setStemMix(mixLevel: number, drumLevel: number) {
    this.mixGainValue = Math.max(0, Math.min(1, mixLevel));
    this.drumGainValue = Math.max(0, Math.min(1, drumLevel));

    if (this.audioCtx) {
      const now = this.audioCtx.currentTime;
      if (this.mixGainNode) {
        this.mixGainNode.gain.setTargetAtTime(this.mixGainValue, now, 0.015);
      }
      if (this.drumGainNode) {
        this.drumGainNode.gain.setTargetAtTime(this.drumGainValue, now, 0.015);
      }
    }
  }

  public getStemMix(): { mix: number; drum: number } {
    return { mix: this.mixGainValue, drum: this.drumGainValue };
  }

  public setSync(bpm: number, offset: number, metronome: boolean) {
    this.bpm = bpm || 120;
    this.trackOffset = offset || 0;
    this.metronomeActive = metronome;
  }

  public getCurrentTime() {
    if (!this.isPlaying || !this.audioCtx) return this.pauseOffset;

    const time = this.audioCtx.currentTime - this.playStartTime;
    if (this.buffer && !this.loop && time >= this.buffer.duration) {
      this.pause();
      return this.buffer.duration;
    }
    return time;
  }

  public getDuration() {
    return this.buffer ? this.buffer.duration : 180;
  }

  public seek(time: number) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.pauseOffset = Math.max(0, Math.min(time, this.getDuration()));
    if (wasPlaying) this.play();
  }

  public play() {
    if (this.isPlaying) return;
    this.initCtx();
    if (!this.audioCtx) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const startOffset = this.buffer
      ? this.pauseOffset % Math.max(0.001, this.buffer.duration)
      : this.pauseOffset;
    const when = this.audioCtx.currentTime + 0.01;
    this.playStartTime = when - startOffset;

    const destinationNode: AudioNode = this.outputBus || this.audioCtx.destination;

    if (this.buffer) {
      this.mixGainNode = this.audioCtx.createGain();
      this.mixGainNode.gain.setValueAtTime(
        this.drumBuffer ? this.mixGainValue : 1.0,
        this.audioCtx.currentTime
      );
      this.mixGainNode.connect(destinationNode);

      this.source = this.audioCtx.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.loop = this.loop;
      this.source.connect(this.mixGainNode);
      this.source.start(when, startOffset);
    }

    if (this.drumBuffer) {
      this.drumGainNode = this.audioCtx.createGain();
      this.drumGainNode.gain.setValueAtTime(this.drumGainValue, this.audioCtx.currentTime);
      this.drumGainNode.connect(destinationNode);

      this.drumSource = this.audioCtx.createBufferSource();
      this.drumSource.buffer = this.drumBuffer;
      this.drumSource.loop = this.loop;
      this.drumSource.connect(this.drumGainNode);
      if (this.drumAnalyser) {
        this.drumSource.connect(this.drumAnalyser);
      }
      const drumOffset = Math.min(startOffset, Math.max(0, this.drumBuffer.duration - 0.01));
      this.drumSource.start(when, drumOffset);
    }

    this.isPlaying = true;

    const secondsPerBeat = 60.0 / this.bpm;
    this.nextBeatIndex = Math.ceil((startOffset - this.trackOffset) / secondsPerBeat);
    this.lastScheduledElapsed = startOffset - 0.0001;

    this.scheduler();
  }

  private stopSources() {
    try {
      this.source?.stop();
    } catch {
      // ignore already stopped
    }
    try {
      this.drumSource?.stop();
    } catch {
      // ignore already stopped
    }
    this.source?.disconnect();
    this.drumSource?.disconnect();
    this.mixGainNode?.disconnect();
    this.drumGainNode?.disconnect();
    this.source = null;
    this.drumSource = null;
    this.mixGainNode = null;
    this.drumGainNode = null;
  }

  public pause() {
    if (!this.isPlaying || !this.audioCtx) return;
    this.stopSources();
    this.pauseOffset = Math.max(0, this.audioCtx.currentTime - this.playStartTime);
    this.isPlaying = false;
    if (this.timerID !== null) {
      window.clearTimeout(this.timerID);
      this.timerID = null;
    }
  }

  public stop() {
    if (!this.isPlaying) {
      this.pauseOffset = 0;
      return;
    }
    this.stopSources();
    this.pauseOffset = 0;
    this.isPlaying = false;
    if (this.timerID !== null) {
      window.clearTimeout(this.timerID);
      this.timerID = null;
    }
  }

  public getIsPlaying() {
    return this.isPlaying;
  }

  public getAudioContextTime() {
    this.initCtx();
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  public getBuffer() {
    return this.buffer;
  }

  public setLoop(loop: boolean) {
    this.loop = loop;
    if (this.source) {
      this.source.loop = loop;
    }
    if (this.drumSource) {
      this.drumSource.loop = loop;
    }
  }

  public getLoop() {
    return this.loop;
  }

  public playClick(
    type: SimDrumBand = 'kick',
    targetTime?: number,
    outputMode: 'direct' | 'sim' = 'direct'
  ) {
    this.initCtx();
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const t = targetTime ?? this.audioCtx.currentTime;
    const dest: AudioNode =
      outputMode === 'sim' && this.simGainNode ? this.simGainNode : this.audioCtx.destination;

    if (type === 'kick') {
      const osc = this.audioCtx.createOscillator();
      const env = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(155, t);
      osc.frequency.exponentialRampToValueAtTime(46, t + 0.06);

      env.gain.setValueAtTime(0.001, t);
      env.gain.linearRampToValueAtTime(1.15, t + 0.0015);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

      osc.connect(env);
      env.connect(dest);
      osc.start(t);
      osc.stop(t + 0.095);

      const noiseBuf = this.getNoiseBuffer();
      if (noiseBuf) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = noiseBuf;
        const bp = this.audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1800, t);
        bp.Q.setValueAtTime(1.2, t);
        const clickEnv = this.audioCtx.createGain();
        clickEnv.gain.setValueAtTime(0.001, t);
        clickEnv.gain.linearRampToValueAtTime(0.45, t + 0.001);
        clickEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.016);

        noise.connect(bp);
        bp.connect(clickEnv);
        clickEnv.connect(dest);
        noise.start(t);
        noise.stop(t + 0.018);
      }
    } else if (type === 'snare') {
      const osc = this.audioCtx.createOscillator();
      const bodyEnv = this.audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(125, t + 0.055);

      bodyEnv.gain.setValueAtTime(0.001, t);
      bodyEnv.gain.linearRampToValueAtTime(0.72, t + 0.0015);
      bodyEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.065);

      osc.connect(bodyEnv);
      bodyEnv.connect(dest);
      osc.start(t);
      osc.stop(t + 0.07);

      const noiseBuf = this.getNoiseBuffer();
      if (noiseBuf) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = noiseBuf;
        const bp = this.audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1950, t);
        bp.Q.setValueAtTime(0.85, t);
        const snapEnv = this.audioCtx.createGain();
        snapEnv.gain.setValueAtTime(0.001, t);
        snapEnv.gain.linearRampToValueAtTime(1.2, t + 0.0015);
        snapEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.085);

        noise.connect(bp);
        bp.connect(snapEnv);
        snapEnv.connect(dest);
        noise.start(t);
        noise.stop(t + 0.09);

        const airNoise = this.audioCtx.createBufferSource();
        airNoise.buffer = noiseBuf;
        const hp = this.audioCtx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(3800, t);
        const airEnv = this.audioCtx.createGain();
        airEnv.gain.setValueAtTime(0.001, t);
        airEnv.gain.linearRampToValueAtTime(0.42, t + 0.0015);
        airEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

        airNoise.connect(hp);
        hp.connect(airEnv);
        airEnv.connect(dest);
        airNoise.start(t);
        airNoise.stop(t + 0.075);
      }
    } else if (type === 'hat') {
      const noiseBuf = this.getNoiseBuffer();
      if (noiseBuf) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = noiseBuf;
        const hp = this.audioCtx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(6800, t);
        hp.Q.setValueAtTime(0.7, t);

        const env = this.audioCtx.createGain();
        env.gain.setValueAtTime(0.001, t);
        env.gain.linearRampToValueAtTime(0.95, t + 0.001);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.038);

        noise.connect(hp);
        hp.connect(env);
        env.connect(dest);
        noise.start(t);
        noise.stop(t + 0.042);
      }

      const osc = this.audioCtx.createOscillator();
      const hp = this.audioCtx.createBiquadFilter();
      const metalEnv = this.audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(6200, t);
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(7200, t);
      metalEnv.gain.setValueAtTime(0.001, t);
      metalEnv.gain.linearRampToValueAtTime(0.22, t + 0.001);
      metalEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.025);

      osc.connect(hp);
      hp.connect(metalEnv);
      metalEnv.connect(dest);
      osc.start(t);
      osc.stop(t + 0.03);
    } else if (type === 'tom') {
      const osc = this.audioCtx.createOscillator();
      const bodyEnv = this.audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(215, t);
      osc.frequency.exponentialRampToValueAtTime(102, t + 0.11);

      bodyEnv.gain.setValueAtTime(0.001, t);
      bodyEnv.gain.linearRampToValueAtTime(1.0, t + 0.002);
      bodyEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.155);

      osc.connect(bodyEnv);
      bodyEnv.connect(dest);
      osc.start(t);
      osc.stop(t + 0.16);

      const noiseBuf = this.getNoiseBuffer();
      if (noiseBuf) {
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = noiseBuf;
        const bp = this.audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1250, t);
        bp.Q.setValueAtTime(1.3, t);

        const stickEnv = this.audioCtx.createGain();
        stickEnv.gain.setValueAtTime(0.001, t);
        stickEnv.gain.linearRampToValueAtTime(0.36, t + 0.001);
        stickEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.022);

        noise.connect(bp);
        bp.connect(stickEnv);
        stickEnv.connect(dest);
        noise.start(t);
        noise.stop(t + 0.026);
      }
    }
  }

  private scheduleTick(beatIndex: number, time: number) {
    if (!this.metronomeActive || !this.audioCtx) return;
    const osc = this.audioCtx.createOscillator();
    const env = this.audioCtx.createGain();

    osc.connect(env);
    env.connect(this.audioCtx.destination);

    osc.frequency.value = beatIndex % 4 === 0 ? 880.0 : 440.0;

    env.gain.value = 1;
    env.gain.setValueAtTime(1, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.start(time);
    osc.stop(time + 0.06);
  }

  private scheduleSimulatedHits(currentTime: number) {
    if (
      this.simEvents.length === 0 ||
      (!this.simEnabledBands.kick &&
        !this.simEnabledBands.snare &&
        !this.simEnabledBands.hat &&
        !this.simEnabledBands.tom)
    ) {
      return;
    }

    const dur = this.buffer && this.buffer.duration > 0 ? this.buffer.duration : Infinity;
    const currentElapsed = Math.max(0, currentTime - this.playStartTime);
    const windowStart = Math.max(this.lastScheduledElapsed, currentElapsed - 0.0001);
    const rawWindowEnd = currentElapsed + this.scheduleAheadTime;
    const windowEnd =
      !this.loop && Number.isFinite(dur) ? Math.min(rawWindowEnd, dur) : rawWindowEnd;

    if (windowEnd <= windowStart) return;

    const startCycle =
      this.loop && Number.isFinite(dur) ? Math.max(0, Math.floor(windowStart / dur)) : 0;
    const endCycle =
      this.loop && Number.isFinite(dur) ? Math.max(startCycle, Math.floor(windowEnd / dur)) : 0;

    for (let cycle = startCycle; cycle <= endCycle; cycle++) {
      const cycleBase = cycle * (Number.isFinite(dur) ? dur : 0);
      const localStart = windowStart - cycleBase;
      const localEnd = windowEnd - cycleBase;

      let lo = 0;
      let hi = this.simEvents.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.simEvents[mid].time <= localStart) lo = mid + 1;
        else hi = mid;
      }

      for (let i = lo; i < this.simEvents.length; i++) {
        const ev = this.simEvents[i];
        if (ev.time > localEnd) break;
        if (!this.simEnabledBands[ev.band]) continue;

        const audioTime = this.playStartTime + cycleBase + ev.time;
        if (audioTime >= currentTime - 0.005) {
          this.playClick(ev.band, Math.max(currentTime, audioTime), 'sim');
        }
      }
    }

    this.lastScheduledElapsed = Math.max(this.lastScheduledElapsed, windowEnd);
  }

  private scheduler() {
    if (!this.isPlaying || !this.audioCtx) return;
    const currentTime = this.audioCtx.currentTime;
    const secondsPerBeat = 60.0 / this.bpm;

    while (true) {
      const nextBeatTimeAudio =
        this.playStartTime + this.trackOffset + this.nextBeatIndex * secondsPerBeat;
      if (nextBeatTimeAudio < currentTime + this.scheduleAheadTime) {
        if (nextBeatTimeAudio >= currentTime) {
          this.scheduleTick(this.nextBeatIndex, nextBeatTimeAudio);
        }
        this.nextBeatIndex++;
      } else {
        break;
      }
    }

    this.scheduleSimulatedHits(currentTime);

    this.timerID = window.setTimeout(() => this.scheduler(), this.lookahead);
  }
}

export const engine = new AudioEngine();
