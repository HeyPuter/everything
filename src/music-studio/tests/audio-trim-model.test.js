import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { createProject, createChannel, createClip } from '../src/model/project.js';
import { createPlaylistView } from '../src/playlist/view.js';
import { resizeClips } from '../src/playlist/clips.js';
import { parseProject, serializeProject } from '../src/model/serialize.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ canvas: document.createElement('canvas'), overlay: document.createElement('canvas'), frame: vi.fn(), resize: vi.fn() }) }));
const panels = [];
afterEach(() => {
  for (const panel of panels.splice(0)) panel.onHide();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function fixture() {
  const p = createProject(); p.bpm = 120;
  const ch = createChannel({ type: 'audio', sample: 's' });
  p.channels = [ch]; p.samples.s = { id: 's', duration: 1, rate: 48000, channels: 1 };
  p.automation.a = { id: 'a', target: { kind: 'channel', id: ch.id, param: 'tune' }, points: [{ t: 0, v: 0.75 }] };
  p.clips = [createClip({ kind: 'audio', ref: ch.id, len: 384 }), createClip({ kind: 'auto', ref: 'a', len: 48, track: 1 })];
  return p;
}
it.each(['keyboard', 'duplicate', 'paste', 'make unique'])('uses decoded sample metadata for cropped audio %s actions', (action) => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const body = document.createElement('div'); document.body.append(body);
  const app = new App(body, { storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  const get = vi.spyOn(app.samples, 'get').mockReturnValue({ channels: [new Float32Array(48000)], rate: 48000, duration: 1 });
  const p = fixture(), id = p.clips[0].id;
  app.store.load(resizeClips(p, [id], 'left', 48));
  const panel = createPlaylistView(app, { body }); panels.push(panel);
  panel.selectClips([id]);
  const before = app.store.project;
  get.mockClear();
  if (action === 'keyboard') {
    panel.focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  } else if (action === 'make unique') panel.view.makeUnique(id);
  else if (action === 'duplicate') panel.actions.duplicate();
  else { panel.actions.copy(); panel.actions.paste(); }
  expect(get).toHaveBeenCalledWith('s');
  const clip = app.store.project.clips.find((c) => panel.view.selection.has(c.id));
  expect(clip.offset).toBeCloseTo(96, 6); // half a source second, even after moving away from the tuning lane
  expect(clip.audioOffset).toBe(clip.offset);
  expect(Object.hasOwn(clip, 'audioSeconds')).toBe(false);
  app.store.undo(); expect(app.store.project).toBe(before);
});
it.each([undefined, -1, Infinity, '12', 500])('validates saved audio anchor %s while retaining legacy offsets', (value) => {
  const p = fixture();
  p.clips[0].offset = 48.25;
  p.clips[0].audioOffset = value;
  const loaded = parseProject(serializeProject(p));
  expect(loaded.clips[0].offset).toBe(48.25);
  expect(loaded.clips[0].audioOffset).toBe(value === 500 ? 48.25 : undefined);
  expect(loaded.clips[1].audioOffset).toBeUndefined();
});
it('bounds left-extension work at very large imported timeline positions', () => {
  const p = fixture();
  p.clips[0].start = Number.MAX_VALUE;
  expect(resizeClips(p, [p.clips[0].id], 'left', -Number.MAX_VALUE)).toBe(p);
});
