// The playback worklet's effect host: the DSP reaches the worklet as bytes
// (Chrome drops a compiled WebAssembly.Module posted to an AudioWorklet) and
// a graph that arrived first gets its effects once the host is ready.
import { describe, it, expect, beforeAll } from 'vitest';
import { wasmBytes } from './fx-wasm.js';

let Processor = null;

beforeAll(async () => {
  globalThis.sampleRate = 48000;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = {
        sent: [],
        postMessage(m) {
          this.sent.push(m);
        },
        onmessage: null,
      };
    }
  };
  globalThis.registerProcessor = (name, cls) => (Processor = cls);
  await import('../src/engine/mixer-worklet.js');
});

const graph = () => ({
  tracks: [
    {
      id: 'file',
      gain: 1,
      pan: 0,
      clips: [],
      fx: [{ key: 'preview:amplify', kind: 1, params: [-40, -40, 1], enabled: true }],
    },
  ],
  master: { gain: 1 },
});
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('mixer worklet effects', () => {
  it('compiles the DSP from bytes and brings in effects of a graph sent before it', async () => {
    const p = new Processor();
    const send = (m) => p.port.onmessage({ data: m });
    send({ type: 'graph', graph: graph() });
    expect(p.host).toBe(null);
    send({
      type: 'init',
      bytes: wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    });
    await settle();
    expect(p.host).toBeTruthy();
    const slot = p.graph.tracks[0].fx[0];
    expect(slot.handle).toBeTruthy();
    expect(slot.key).toBe('preview:amplify');
    // Later graphs resolve at once and reuse the instance.
    send({ type: 'graph', graph: graph() });
    expect(p.graph.tracks[0].fx[0].handle).toBe(slot.handle);
    // The effect processes audio: -40 dB on a full-scale block.
    const buf = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
    for (let i = 0; i < 40; i++)
      p.host.run(
        p.graph.tracks[0].fx,
        buf.map((b) => b.fill(1)),
        128,
      );
    expect(buf[0][127]).toBeCloseTo(0.01, 3);
    expect(p.port.sent.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('still accepts a compiled module', async () => {
    const p = new Processor();
    p.port.onmessage({ data: { type: 'init', module: new WebAssembly.Module(wasmBytes) } });
    p.port.onmessage({ data: { type: 'graph', graph: graph() } });
    await settle();
    expect(p.graph.tracks[0].fx[0].handle).toBeTruthy();
  });

  it('reports DSP that does not compile', async () => {
    const p = new Processor();
    p.port.onmessage({ data: { type: 'init', bytes: new Uint8Array([1, 2, 3]).buffer } });
    await settle();
    expect(p.host).toBe(null);
    expect(
      p.port.sent.some((m) => m.type === 'error' && /Effects are unavailable/.test(m.message)),
    ).toBe(true);
  });
});
