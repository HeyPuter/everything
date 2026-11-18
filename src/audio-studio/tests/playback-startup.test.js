import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { engine } from '../src/engine/engine.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';

const apps = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.endScrub();
  engine.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.assign(engine, { ctx: null, node: null, requestedRate: null });
});

function setup() {
  localStorage.clear();
  const sent = [];
  Object.assign(engine, {
    state: 'stopped',
    ctx: { currentTime: 0, sampleRate: 48000, state: 'running' },
    requestedRate: 48000,
    node: { port: { postMessage: (m) => sent.push(m) } },
    graph: { rate: 48000, tracks: [], master: { gain: 1 } },
    lastPos: { frame: 0, time: 0 },
  });
  const app = new App();
  apps.push(app);
  app.syncGraph = () => {};
  app.notify = vi.fn();
  installCoreCommands(app);
  const doc = AudioFile.blank({ name: 'First.wav', seconds: 1 });
  app.addDocument(doc);
  let ready;
  let fail;
  vi.spyOn(engine, 'ensure').mockImplementationOnce(() => new Promise((resolve, reject) => { ready = resolve; fail = reject; }));
  return { app, doc, sent, ready: () => ready(engine.ctx), fail: () => fail(new Error('Context failed')) };
}

describe('playback startup', () => {
  it.each(['stop', 'space', 'switch', 'close'])('does not start stale playback after %s while the context initializes', async (action) => {
    const { app, doc, sent, ready } = setup();
    const pending = app.play();
    if (action === 'stop') app.stop();
    if (action === 'space') app.togglePlay();
    if (action === 'switch') app.addDocument(AudioFile.blank({ name: 'Other.wav', seconds: 2 }));
    if (action === 'close') await app.closeDocument(doc, { force: true });
    ready();
    await pending;
    expect(sent.filter((m) => m.type === 'play')).toHaveLength(0);
    expect(engine.playing).toBe(false);
  });

  it('enables the Stop command while playback is still starting', async () => {
    const { app, sent, ready } = setup();
    const pending = app.commands.run('transport.play');
    expect(app.commands.isEnabled('transport.stop')).toBe(true);
    await app.commands.run('transport.stop');
    ready();
    await pending;
    expect(sent.filter((m) => m.type === 'play')).toHaveLength(0);
  });

  it('keeps the newest playback request when an earlier initialization finishes later', async () => {
    const { app, sent, ready } = setup();
    const first = app.play({ from: 100 });
    await app.play({ from: 200 });
    ready();
    await first;
    expect(sent.filter((m) => m.type === 'play').map((m) => m.from)).toEqual([200]);
    expect(engine.playing).toBe(true);
  });

  it('ignores repeat Play clicks during startup and plays normally when initialization finishes', async () => {
    const { app, sent, ready } = setup();
    const pending = app.commands.run('transport.play');
    await app.commands.run('transport.play');
    expect(engine.ensure).toHaveBeenCalledOnce();
    ready();
    await pending;
    expect(sent.filter((m) => m.type === 'play')).toHaveLength(1);
    expect(app.playbackPending).toBe(false);
    expect(engine.playing).toBe(true);
  });

  it('reports a current initialization failure and allows a subsequent retry', async () => {
    const { app, sent, fail } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = app.play();
    fail();
    await pending;
    expect(app.notify).toHaveBeenCalledOnce();
    expect(app.playbackPending).toBe(false);
    await app.commands.run('transport.play');
    expect(sent.filter((m) => m.type === 'play')).toHaveLength(1);
    expect(engine.playing).toBe(true);
  });

  it('does not report an initialization failure for a cancelled playback request', async () => {
    const { app, fail } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = app.play();
    app.stop();
    fail();
    await pending;
    expect(app.notify).not.toHaveBeenCalled();
  });
});

describe('scrub startup', () => {
  it('keeps the latest scrub position and stops after the final snippet', async () => {
    vi.useFakeTimers();
    const { app, sent, ready } = setup();
    app.prefs.set('scrubAudio', true);
    app.lastScrub = -1000;
    const first = app.scrub(200);
    expect(app.commands.isEnabled('transport.stop')).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await app.scrub(500);
    ready();
    await first;
    expect(sent.filter((m) => m.type === 'play').map((m) => m.from)).toEqual([500]);
    expect(engine.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(160);
    expect(engine.playing).toBe(false);
    expect(app.scrubbing).toBe(false);
    expect(app.commands.isEnabled('transport.stop')).toBe(false);
  });

  it('clears the old scrub stop timer when normal playback begins', async () => {
    vi.useFakeTimers();
    const { app, ready } = setup();
    app.prefs.set('scrubAudio', true);
    app.lastScrub = -1000;
    const scrub = app.scrub(200);
    ready();
    await scrub;
    await app.play({ from: 1000 });
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.playing).toBe(true);
    expect(app.scrubbing).toBe(false);
  });

  it('cannot replace normal playback when an earlier scrub finishes initializing', async () => {
    const { app, sent, ready } = setup();
    app.prefs.set('scrubAudio', true);
    app.lastScrub = -1000;
    const scrub = app.scrub(200);
    await app.play({ from: 1000 });
    ready();
    await scrub;
    expect(sent.filter((m) => m.type === 'play').map((m) => m.from)).toEqual([1000]);
    expect(app.scrubbing).toBe(false);
  });

  it.each(['stop', 'switch', 'close'])('does not begin a delayed scrub after %s', async (action) => {
    const { app, doc, sent, ready } = setup();
    app.prefs.set('scrubAudio', true);
    app.lastScrub = -1000;
    const scrub = app.scrub(200);
    if (action === 'stop') app.stop();
    if (action === 'switch') app.addDocument(AudioFile.blank({ name: 'Other.wav', seconds: 2 }));
    if (action === 'close') await app.closeDocument(doc, { force: true });
    ready();
    await scrub;
    expect(sent.filter((m) => m.type === 'play')).toHaveLength(0);
    expect(app.scrubbing).toBe(false);
  });
});
