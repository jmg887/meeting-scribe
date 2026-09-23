/* AudioWorklet processor: forwards mono Float32 PCM chunks to the main thread. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // Copy — the underlying buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
