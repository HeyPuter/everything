// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalMedia } from '../src/net/media.js';

/*
 * Screen sharing is guarded by `if (this.screenStream) return`, which only
 * helps once a capture has landed. getDisplayMedia is asynchronous — the
 * picker takes as long as the user takes — so the interesting question is
 * what two overlapping requests do.
 */

class FakeTrack {
  kind = 'video';
  readyState = 'live';
  contentHint = '';
  #listeners = new Set();
  constructor(label) {
    this.label = label;
  }
  addEventListener(type, fn) {
    if (type === 'ended') this.#listeners.add(fn);
  }
  removeEventListener(type, fn) {
    this.#listeners.delete(fn);
  }
  stop() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    // Real MediaStreamTrack.stop() fires 'ended' synchronously. A share
    // teardown that stops tracks before clearing screenStream would then
    // re-enter stopScreenShare via the ended listener and emit twice.
    for (const fn of [...this.#listeners]) fn();
  }
  /** What the browser's own "Stop sharing" control does. */
  end() {
    this.stop();
  }
}

class FakeStream {
  constructor(tracks = []) {
    this.id = `stream-${Math.random().toString(36).slice(2)}`;
    this._tracks = tracks;
  }
  getTracks() {
    return this._tracks;
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t) {
    this._tracks.push(t);
  }
  removeTrack(t) {
    this._tracks = this._tracks.filter((x) => x !== t);
  }
}

let media;
let captures;
let release;

beforeEach(() => {
  globalThis.MediaStream = FakeStream;
  captures = [];
  release = [];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      // Hand back a stream only when the test says the picker was answered.
      getDisplayMedia: vi.fn(() => {
        const track = new FakeTrack(`capture-${captures.length + 1}`);
        const stream = new FakeStream([track]);
        captures.push(stream);
        return new Promise((resolve) => release.push(() => resolve(stream)));
      }),
      getUserMedia: () => Promise.reject(new Error('no devices')),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  media = new LocalMedia();
});

afterEach(() => {
  media = null;
});

describe('screen share', () => {
  it('publishes the capture and reports it once', async () => {
    const events = [];
    media.on('screen', (e) => events.push(e.on));
    const started = media.startScreenShare();
    release[0]();
    const stream = await started;

    expect(media.presenting).toBe(true);
    expect(media.screenStream).toBe(stream);
    expect(events).toEqual([true]);
    expect(stream.getVideoTracks()[0].contentHint).toBe('detail');
  });

  it('asks for one capture however many times the control is hit', async () => {
    const events = [];
    media.on('screen', (e) => events.push(e.on));

    // Two clicks before the picker is answered — the second must not open
    // a second picker.
    const first = media.startScreenShare();
    const second = media.startScreenShare();
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(events).toEqual([true]);
    // Nothing was captured and then abandoned still running.
    const live = captures.filter((s) => s.getTracks().some((t) => t.readyState === 'live'));
    expect(live).toEqual([media.screenStream]);
  });

  it('both callers get the capture that was actually published', async () => {
    const first = media.startScreenShare();
    const second = media.startScreenShare();
    release.forEach((fn) => fn());
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(media.screenStream);
    expect(b).toBe(media.screenStream);
  });

  it('stops cleanly, and can start again afterwards', async () => {
    const started = media.startScreenShare();
    release[0]();
    const stream = await started;
    media.stopScreenShare();

    expect(media.presenting).toBe(false);
    expect(stream.getTracks()[0].readyState).toBe('ended');

    const again = media.startScreenShare();
    release.at(-1)();
    await again;
    expect(media.presenting).toBe(true);
  });

  it('emits screen-off once when stop() fires ended synchronously', async () => {
    const events = [];
    media.on('screen', (e) => events.push(e.on));
    const started = media.startScreenShare();
    release[0]();
    await started;

    media.stopScreenShare();

    expect(media.presenting).toBe(false);
    // One off event — not a second from the track's ended listener re-entering.
    expect(events).toEqual([true, false]);
  });

  it('follows the browser’s own Stop sharing control', async () => {
    const events = [];
    media.on('screen', (e) => events.push(e.on));
    const started = media.startScreenShare();
    release[0]();
    const stream = await started;

    stream.getVideoTracks()[0].end();
    expect(media.presenting).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('does not let an abandoned capture take down the live one', async () => {
    const first = media.startScreenShare();
    const second = media.startScreenShare();
    release.forEach((fn) => fn());
    await Promise.all([first, second]);

    // Whatever the first request produced must not be wired to the state
    // the second one owns.
    for (const stream of captures) {
      if (stream === media.screenStream) continue;
      stream.getVideoTracks()[0].end();
    }
    expect(media.presenting).toBe(true);
  });

  it('discards a capture answered after the call is over', async () => {
    const started = media.startScreenShare();
    media.stopAll(); // left the meeting while the picker was still up
    release[0]();

    await expect(started).rejects.toThrow();
    expect(media.presenting).toBe(false);
    // Nothing is left running that the browser would keep reporting as
    // a shared screen, with nothing able to stop it.
    expect(captures[0].getTracks().every((t) => t.readyState === 'ended')).toBe(true);
  });

  it('reports a dismissed picker to the caller and stays not presenting', async () => {
    navigator.mediaDevices.getDisplayMedia = vi.fn(() => {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    });

    await expect(media.startScreenShare()).rejects.toThrow(/Permission denied/);
    expect(media.presenting).toBe(false);

    // And a later attempt is not blocked by the failed one.
    navigator.mediaDevices.getDisplayMedia = vi.fn(() => {
      const track = new FakeTrack('after-denial');
      return Promise.resolve(new FakeStream([track]));
    });
    await media.startScreenShare();
    expect(media.presenting).toBe(true);
  });
});
