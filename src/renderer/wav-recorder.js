/**
 * WavRecorder — records the microphone into a 16-bit PCM mono WAV file.
 *
 * Uses Web Audio + an AudioWorklet to capture raw PCM (so we produce a real
 * .wav instead of the webm/opus that MediaRecorder gives us). Falls back to a
 * ScriptProcessorNode if AudioWorklet is unavailable.
 */
(function (global) {
  'use strict';

  const TARGET_SAMPLE_RATE = 16000; // plenty for speech, keeps files small

  function downsample(buffer, fromRate, toRate) {
    if (toRate >= fromRate) return buffer;
    const ratio = fromRate / toRate;
    const outLength = Math.floor(buffer.length / ratio);
    const out = new Float32Array(outLength);
    let outIdx = 0;
    let inIdx = 0;
    while (outIdx < outLength) {
      const nextIn = Math.round((outIdx + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = inIdx; i < nextIn && i < buffer.length; i++) {
        sum += buffer[i];
        count++;
      }
      out[outIdx++] = count ? sum / count : 0;
      inIdx = nextIn;
    }
    return out;
  }

  function encodeWav(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const dataBytes = total * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return buffer;
  }

  class WavRecorder {
    constructor({ onLevel } = {}) {
      this.onLevel = onLevel || (() => {});
      this.reset();
    }

    reset() {
      this.stream = null;
      this.context = null;
      this.source = null;
      this.node = null;
      this.chunks = [];
      this.sampleRate = TARGET_SAMPLE_RATE;
      this.startedAt = 0;
      this.recording = false;
    }

    get isRecording() {
      return this.recording;
    }

    async start() {
      if (this.recording) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported in this environment.');
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
          throw new Error('Microphone permission was denied. Allow microphone access for MeetingScribe in your system settings and try again.');
        }
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          throw new Error('No microphone was found. Connect a microphone and try again.');
        }
        if (err.name === 'NotReadableError') {
          throw new Error('The microphone is in use by another application.');
        }
        throw new Error(`Could not start the microphone: ${err.message}`);
      }

      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      const context = new AudioCtx();
      await context.resume();
      const source = context.createMediaStreamSource(stream);

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.chunks = [];
      this.inputRate = context.sampleRate;
      this.sampleRate = Math.min(TARGET_SAMPLE_RATE, context.sampleRate);

      const handleChunk = (float32) => {
        if (!this.recording) return;
        // level meter (RMS)
        let sum = 0;
        for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
        this.onLevel(Math.sqrt(sum / (float32.length || 1)));
        this.chunks.push(downsample(float32, this.inputRate, this.sampleRate));
      };

      if (context.audioWorklet) {
        await context.audioWorklet.addModule('pcm-worklet.js');
        const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        node.port.onmessage = (e) => handleChunk(e.data);
        source.connect(node);
        this.node = node;
      } else {
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        source.connect(node);
        node.connect(context.destination); // required for ScriptProcessor to fire
        this.node = node;
      }

      this.startedAt = Date.now();
      this.recording = true;
    }

    /** @returns {Promise<{buffer: ArrayBuffer, durationSec: number}>} */
    async stop() {
      if (!this.recording) throw new Error('Not recording.');
      this.recording = false;
      const durationSec = (Date.now() - this.startedAt) / 1000;

      try {
        if (this.node) {
          this.node.disconnect();
          if (this.node.port) this.node.port.onmessage = null;
        }
        if (this.source) this.source.disconnect();
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        if (this.context) await this.context.close();
      } catch (_) {
        /* ignore teardown errors */
      }

      const buffer = encodeWav(this.chunks, this.sampleRate);
      const sampleCount = this.chunks.reduce((n, c) => n + c.length, 0);
      // Prefer the exact duration derived from captured samples; fall back to wall clock.
      const exactDuration = sampleCount > 0 ? sampleCount / this.sampleRate : durationSec;
      this.reset();
      return { buffer, durationSec: exactDuration };
    }

    elapsedSeconds() {
      return this.recording ? (Date.now() - this.startedAt) / 1000 : 0;
    }
  }

  global.WavRecorder = WavRecorder;
})(window);
