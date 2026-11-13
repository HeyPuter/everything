import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { createProject, createClip } from '../src/model/project.js';
import { createPlaylistView } from '../src/playlist/view.js';
import * as C from '../src/playlist/clips.js';

vi.mock('../src/render/gfx.js', () => ({ createGfx: () => ({ canvas: document.createElement('canvas'), overlay: document.createElement('canvas'), frame: vi.fn(), resize: vi.fn() }) }));
const COUNT = 150000; // Bounded fixture beyond engine function-argument limits; no audio or canvas work.
const panels = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  for (const panel of panels.splice(0)) panel.onHide();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function arrangement() {
  const project = createProject();
  const template = createClip({ kind: 'pattern', ref: project.patterns[0].id, len: 24 });
  project.clips = Array.from({ length: COUNT }, (_, i) => ({ ...template, id: `clip-${i}`, start: (COUNT - i) * 24, track: i % 2 + 2 }));
  return project;
}

it('moves a large selection together and clamps its earliest start and top track', () => {
  const project = arrangement();
  const result = C.moveClips(project, project.clips.map((c) => c.id), -100, -10);
  expect(result.ids).toHaveLength(COUNT);
  expect(result.project.clips.every((c, i) => c.start === project.clips[i].start - 24 && c.track === project.clips[i].track - 2)).toBe(true);
  expect(project.clips.at(-1).start).toBe(24);
  expect(project.clips[0].track).toBe(2);
});

it('duplicates a large selection after its full time span', () => {
  const project = arrangement();
  const result = C.duplicateClips(project, project.clips.map((c) => c.id));
  expect(result.ids).toHaveLength(COUNT);
  expect(new Set(result.ids).size).toBe(COUNT);
  expect(result.project.clips).toHaveLength(COUNT * 2);
  expect(project.clips.every((c, i) => result.project.clips[i] === c)).toBe(true);
  const copies = result.project.clips.slice(COUNT);
  expect(copies.every((c, i) => c.id !== project.clips[i].id && c.start === project.clips[i].start + COUNT * 24 && c.track === project.clips[i].track)).toBe(true);
});

it('copies a large selection relative to its earliest start and top track', () => {
  const project = arrangement();
  const board = C.copyClips(project, project.clips.map((c) => c.id));
  expect(board.clips).toHaveLength(COUNT);
  expect(board.clips.every((c, i) => c.start === project.clips[i].start - 24 && c.track === project.clips[i].track - 2 && c.ref === project.clips[i].ref)).toBe(true);
  expect(project.clips.at(-1).start).toBe(24);
});

function setup() {
  const body = document.createElement('div');
  document.body.append(body);
  const app = new App(body, { storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  app.store.load(arrangement());
  const panel = createPlaylistView(app, { body });
  panels.push(panel);
  return { app, panel, view: panel.view };
}

it('loops a large selection through the playlist and can undo it', () => {
  const { app, view } = setup();
  const original = app.store.project;
  view.actions.selectAll();
  view.loopSelection();
  expect(app.store.project.loop).toEqual({ start: 24, end: (COUNT + 1) * 24 });
  app.store.undo();
  expect(app.store.project).toBe(original);
});

it('pastes at the top track of a large selection and can undo it', () => {
  const { app, view } = setup();
  const original = app.store.project;
  view.selectClips([original.clips[1].id]);
  view.actions.copy();
  view.actions.selectAll();
  view.actions.paste();
  expect(app.store.project.clips).toHaveLength(COUNT + 1);
  expect(app.store.project.clips.at(-1)).toMatchObject({ start: 0, track: 2, len: 24, ref: original.patterns[0].id });
  app.store.undo();
  expect(app.store.project).toBe(original);
});
