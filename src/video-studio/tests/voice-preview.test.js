import { it, expect, vi, afterEach } from 'vitest';
import { previewClip } from '../src/ui/inspector/voice.js';
import { Emitter } from '../src/lib/emitter.js';
import { US } from '../src/lib/time.js';

afterEach(() => vi.useRealTimers());

function setup() {
  const player = Object.assign(new Emitter(), {
    playing: false,
    play() {
      this.playing = true;
      this.emit('play', { playing: true });
    },
    pause: vi.fn(function pause() {
      this.playing = false;
      this.emit('play', { playing: false });
    }),
  });
  const store = { time: 0, seek: vi.fn((t) => (store.time = t)) };
  const view = { ctx: { player }, store, clip: { start: 2 * US, duration: 10 * US } };
  return { player, store, view };
}

it('stops its own preview and returns to where it started', () => {
  vi.useFakeTimers();
  const { player, store, view } = setup();
  expect(previewClip(view)).toBe(true);
  expect(player.playing).toBe(true);
  vi.advanceTimersByTime(3600);
  expect(player.playing).toBe(false);
  expect(store.seek).toHaveBeenLastCalledWith(2 * US);
});

it('leaves playback the user started after stopping the preview', () => {
  vi.useFakeTimers();
  const { player, store, view } = setup();
  previewClip(view);
  vi.advanceTimersByTime(1000);
  player.pause();
  player.pause.mockClear();
  store.seek.mockClear();
  player.play();
  vi.advanceTimersByTime(5000);
  expect(player.playing).toBe(true);
  expect(player.pause).not.toHaveBeenCalled();
  expect(store.seek).not.toHaveBeenCalled();
});
