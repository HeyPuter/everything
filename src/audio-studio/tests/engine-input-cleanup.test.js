import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';

afterEach(() => vi.unstubAllGlobals());

function setup(failure) {
  const error = new Error('Capture setup failed');
  const track = { stop: vi.fn(), getSettings: () => ({ channelCount: 2 }) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connect: vi.fn(() => { if (failure === 'connect') throw error; }), disconnect: vi.fn() };
  const port = { postMessage: vi.fn() };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal('AudioWorkletNode', class {
    constructor() {
      if (failure === 'node') throw error;
      this.port = port;
    }
  });
  const engine = new Engine();
  engine.ctx = {
    audioWorklet: { addModule: vi.fn(async () => { if (failure === 'module') throw error; }) },
    createMediaStreamSource: () => source,
  };
  engine.ensure = async () => engine.ctx;
  return { engine, track, source, port, error };
}

describe('microphone setup cleanup', () => {
  it.each(['module', 'node', 'connect'])('releases the microphone when capture setup fails at %s', async (failure) => {
    const { engine, track, source, port, error } = setup(failure);
    await expect(engine.openInput()).rejects.toBe(error);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(engine.input).toBeNull();
    if (failure !== 'module') expect(source.disconnect).toHaveBeenCalledOnce();
    if (failure === 'connect') expect(port.postMessage).toHaveBeenCalledWith({ type: 'close' });
  });

  it('keeps a successfully opened input active until explicitly closed', async () => {
    const { engine, track, source, port } = setup();
    const input = await engine.openInput();
    expect(engine.input).toBe(input);
    expect(track.stop).not.toHaveBeenCalled();
    engine.closeInput();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(engine.input).toBeNull();
  });
});
