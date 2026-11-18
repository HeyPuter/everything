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
  it.each(['context', 'permission', 'processor'])('does not reopen an input closed while awaiting %s', async (stage) => {
    const { engine, track } = setup();
    let release;
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const target = stage === 'context' ? engine : stage === 'permission' ? navigator.mediaDevices : engine.ctx.audioWorklet;
    const key = stage === 'context' ? 'ensure' : stage === 'permission' ? 'getUserMedia' : 'addModule';
    const original = target[key].bind(target);
    target[key] = async (...args) => { entered(); await gate; return original(...args); };
    const opening = engine.openInput();
    await reached;
    engine.closeInput();
    release();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.input).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(stage === 'context' ? 0 : 1);
  });

  it('keeps the latest selected device when an earlier permission request finishes last', async () => {
    const { engine } = setup();
    const requests = new Map();
    navigator.mediaDevices.getUserMedia = vi.fn(({ audio }) => new Promise((resolve) => requests.set(audio.deviceId.exact, resolve)));
    const stream = () => {
      const track = { stop: vi.fn(), getSettings: () => ({ channelCount: 2 }) };
      return { track, getTracks: () => [track], getAudioTracks: () => [track] };
    };
    const older = stream();
    const newer = stream();
    const first = engine.openInput({ deviceId: 'old' });
    await Promise.resolve();
    const second = engine.openInput({ deviceId: 'new' });
    await Promise.resolve();
    requests.get('new')(newer);
    const input = await second;
    requests.get('old')(older);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.input).toBe(input);
    expect(engine.input.deviceId).toBe('new');
    expect(older.track.stop).toHaveBeenCalledOnce();
    expect(newer.track.stop).not.toHaveBeenCalled();
    engine.closeInput();
    expect(newer.track.stop).toHaveBeenCalledOnce();
  });

  it('treats a late failure from a cancelled request as cancellation, not a device failure to retry', async () => {
    const { engine } = setup();
    let reject;
    navigator.mediaDevices.getUserMedia = () => new Promise((_, no) => { reject = no; });
    const pending = engine.openInput();
    await Promise.resolve();
    engine.closeInput();
    reject(new DOMException('Device removed', 'NotFoundError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

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
