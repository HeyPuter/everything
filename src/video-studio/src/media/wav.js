/**
 * PCM WAV encoding. Sound effects, speech mixdowns for transcription and
 * other app-made audio are stored as plain 16-bit WAV files, which every
 * decoder (and Mediabunny) reads.
 */

/**
 * Encode channels (array of Float32Array, or an AudioBuffer) as a 16-bit
 * PCM WAV file. Returns an ArrayBuffer.
 */
export function wavBytes(channels, sampleRate) {
  const chans = toChannels(channels);
  const rate = Math.round(sampleRate ?? channels.sampleRate);
  if (!chans.length || !rate) throw new Error('Nothing to encode');
  const frames = Math.min(...chans.map((c) => c.length));
  const numCh = chans.length;
  const blockAlign = numCh * 2;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  // Interleave straight into an Int16Array view (WAV is little-endian, as are all browser hosts).
  const out = new Int16Array(buf, 44, frames * numCh);
  for (let c = 0; c < numCh; c++) {
    const src = chans[c];
    for (let i = 0, j = c; i < frames; i++, j += numCh) {
      const s = src[i];
      // NaN becomes silence; the asymmetric scale keeps -1 and 1 exact.
      out[j] = s >= 1 ? 32767 : s <= -1 ? -32768 : s < 0 ? Math.round(s * 32768) : s > 0 ? Math.round(s * 32767) : 0;
    }
  }
  return buf;
}

/** The 44-byte header of a 16-bit PCM WAV file holding frames sample frames. */
export function wavHeader(frames, numCh, rate) {
  const dataBytes = frames * numCh * 2;
  const v = new DataView(new ArrayBuffer(44));
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(v.buffer);
}

/**
 * Write channels[c][from..to) as interleaved 16-bit samples into out at
 * index at, for numCh output channels (a missing channel repeats the last
 * one), as wavBytes does. For writing long files piece by piece after a
 * wavHeader. Returns the index after the last sample written.
 */
export function writePcm16(out, at, channels, from, to, numCh = channels.length) {
  const frames = Math.max(0, to - from);
  for (let c = 0; c < numCh; c++) {
    const src = channels[Math.min(c, channels.length - 1)];
    for (let i = 0, j = at + c; i < frames; i++, j += numCh) {
      const s = src[from + i];
      out[j] = s >= 1 ? 32767 : s <= -1 ? -32768 : s < 0 ? Math.round(s * 32768) : s > 0 ? Math.round(s * 32767) : 0;
    }
  }
  return at + frames * numCh;
}

/** Same as wavBytes, wrapped in a Blob of type audio/wav. */
export function encodeWav(channels, sampleRate) {
  return new Blob([wavBytes(channels, sampleRate)], { type: 'audio/wav' });
}

function toChannels(input) {
  if (Array.isArray(input)) return input;
  if (input instanceof Float32Array) return [input];
  if (input && typeof input.getChannelData === 'function') {
    const out = [];
    for (let c = 0; c < input.numberOfChannels; c++) out.push(input.getChannelData(c));
    return out;
  }
  return [];
}

/** Read back a 16-bit PCM WAV made by wavBytes (used by tests and for quick checks). */
export function readWav(buffer) {
  const v = new DataView(buffer);
  const tag = (off) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  const numCh = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  if (bits !== 16) throw new Error('Only 16-bit WAV is supported');
  const bytes = v.getUint32(40, true);
  const frames = bytes / (numCh * 2);
  const ints = new Int16Array(buffer, 44, frames * numCh);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < numCh; c++) channels[c][i] = ints[i * numCh + c] / (ints[i * numCh + c] < 0 ? 32768 : 32767);
  return { sampleRate, channels };
}
