import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { textLayer } from '../src/imaging/text/model';

const faces: FakeFace[] = [];
class FakeFace {
  resolve!: (face: FakeFace) => void;
  reject!: (error: Error) => void;
  ready = new Promise<FakeFace>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(public family: string) { faces.push(this); }
  load() { return this.ready; }
}
const add = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  faces.length = 0;
  add.mockClear();
  vi.stubGlobal('FontFace', FakeFace);
  vi.stubGlobal('document', { fonts: { add } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('uses a promptly loaded face and clears its fallback timer', async () => {
  const { prepareFonts, onFontsLoaded } = await import('../src/imaging/text/fonts');
  const loaded = vi.fn();
  onFontsLoaded(loaded);
  const ready = prepareFonts(textLayer('Text', { family: 'Caveat' }), { allowFallback: true });
  faces[0].resolve(faces[0]);
  await ready;
  expect(add).toHaveBeenCalledWith(faces[0]);
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds rendering once per download without ending the strict wait or discarding late fonts', async () => {
  const { prepareFonts, onFontsLoaded } = await import('../src/imaging/text/fonts');
  const loaded = vi.fn();
  const unsubscribe = onFontsLoaded(loaded);
  const data = textLayer('Text', { family: 'Caveat' });
  let strictDone = false, fallbackDone = false;
  const strict = prepareFonts(data).then(() => { strictDone = true; });
  const fallback = prepareFonts(data, { allowFallback: true }).then(() => { fallbackDone = true; });
  await vi.advanceTimersByTimeAsync(2999);
  expect(fallbackDone).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await fallback;
  expect(strictDone).toBe(false);
  expect(add).not.toHaveBeenCalled();
  // Another layer using that download can render immediately, without another timer.
  await prepareFonts(textLayer('Second', { family: 'Caveat' }), { allowFallback: true });
  expect(vi.getTimerCount()).toBe(0);
  expect(faces).toHaveLength(1);
  faces[0].resolve(faces[0]);
  await strict;
  expect(strictDone).toBe(true);
  expect(add).toHaveBeenCalledTimes(1);
  expect(loaded).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it('also bounds a separately loaded OpenType feature face', async () => {
  const { prepareFonts } = await import('../src/imaging/text/fonts');
  const data = textLayer('123', { family: 'Crimson Pro', features: 'onum' });
  const ready = prepareFonts(data, { allowFallback: true });
  expect(faces).toHaveLength(2);
  faces[0].resolve(faces[0]);
  await vi.advanceTimersByTimeAsync(3000);
  await ready;
  expect(add).toHaveBeenCalledTimes(1);
  faces[1].resolve(faces[1]);
  await prepareFonts(data);
  expect(add).toHaveBeenCalledTimes(2);
});

it('failed downloads unblock immediately and can be retried', async () => {
  const { prepareFonts, onFontsLoaded } = await import('../src/imaging/text/fonts');
  const loaded = vi.fn();
  onFontsLoaded(loaded);
  const data = textLayer('Text', { family: 'Caveat' });
  const failed = prepareFonts(data, { allowFallback: true });
  faces[0].reject(new Error('Offline'));
  await failed;
  expect(loaded).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const retry = prepareFonts(data, { allowFallback: true });
  expect(faces).toHaveLength(2);
  faces[1].resolve(faces[1]);
  await retry;
  expect(add).toHaveBeenCalledTimes(1);
  expect(loaded).toHaveBeenCalledTimes(1);
});
