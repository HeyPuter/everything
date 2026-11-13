// Captures microphone input for recording and input metering. Posts planar
// Float32Array chunks of about 2048 frames plus a running peak per channel.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.size = 2048;
    this.buf = null;
    this.fill = 0;
    this.peak = [0, 0];
    this.meterCount = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'record') {
        this.recording = e.data.on;
        if (!this.recording) this.flush();
      } else if (e.data.type === 'close') {
        this.closed = true;
      }
    };
  }

  flush() {
    if (!this.buf || !this.fill) return;
    const chunk = this.buf.map((c) => c.slice(0, this.fill));
    this.port.postMessage({ type: 'data', channels: chunk, time: currentTime }, chunk.map((c) => c.buffer));
    this.fill = 0;
  }

  process(inputs) {
    if (this.closed) return false; // the input closed: let the node go
    const input = inputs[0];
    if (!input || !input.length) return true;
    const n = input[0].length;
    for (let c = 0; c < Math.min(2, input.length); c++) {
      let p = this.peak[c];
      const d = input[c];
      for (let i = 0; i < n; i++) {
        const a = d[i] < 0 ? -d[i] : d[i];
        if (a > p) p = a;
      }
      this.peak[c] = p;
    }
    if (input.length === 1) this.peak[1] = this.peak[0];
    if (this.recording) {
      if (!this.buf || this.buf.length !== input.length) {
        this.buf = input.map(() => new Float32Array(this.size));
        this.fill = 0;
      }
      let at = 0;
      while (at < n) {
        const take = Math.min(n - at, this.size - this.fill);
        for (let c = 0; c < input.length; c++) this.buf[c].set(input[c].subarray(at, at + take), this.fill);
        this.fill += take;
        at += take;
        if (this.fill === this.size) {
          this.flush();
          this.buf = input.map(() => new Float32Array(this.size));
        }
      }
    }
    this.meterCount += n;
    if (this.meterCount >= sampleRate / 30) {
      this.meterCount = 0;
      this.port.postMessage({ type: 'meter', peak: this.peak.slice() });
      this.peak[0] = 0;
      this.peak[1] = 0;
    }
    return true;
  }
}

registerProcessor('audio-studio-capture', CaptureProcessor);
