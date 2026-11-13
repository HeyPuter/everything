import { afterEach, expect, it, vi } from 'vitest';
import { createProject, createClip } from '../src/model/project.js';
import { Store } from '../src/model/store.js';
import * as E from '../src/model/edits.js';
import * as C from '../src/playlist/clips.js';
import { addAutomationClip } from '../src/automation/create.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const project = createProject();
  const automation = { id: '00000000', name: 'Original level', target: { kind: 'mixer', track: 0, param: 'volume' }, points: [{ t: 0, v: 0.2 }, { t: 96, v: 0.7 }] };
  project.automation[automation.id] = automation;
  project.clips = ['clip-a', 'clip-b'].map((id, i) => ({ ...createClip({ kind: 'auto', ref: automation.id, start: i * 96, len: 96 }), id }));
  return { project, automation };
}
function collide() {
  let i = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.fill(Math.max(0, i++ - 1)));
}

it('adds a new automation clip without replacing an earlier curve after an ID collision', async () => {
  const { project, automation } = fixture();
  const store = new Store(project);
  const app = { store, engine: { mode: 'song', position: 192 } };
  collide();
  const result = await addAutomationClip(app, { target: { kind: 'mixer', track: 0, param: 'pan' }, at: 192 });
  expect(Object.keys(store.project.automation)).toHaveLength(2);
  expect(store.project.automation[automation.id]).toBe(automation);
  expect(result.id).not.toBe(automation.id);
  expect(store.project.automation[result.id].target.param).toBe('pan');
  expect(store.project.clips.find((c) => c.id === result.clipId).ref).toBe(result.id);
  expect(store.project.clips.slice(0, 2)).toEqual(project.clips);
  store.undo();
  expect(store.project).toBe(project);
  store.redo();
  expect(store.project.automation[automation.id]).toBe(automation);
});

it('makes only the chosen automation clip unique when its new source ID collides', () => {
  const { project, automation } = fixture();
  collide();
  const result = C.makeUnique(project, 'clip-b');
  expect(result.id).not.toBe(automation.id);
  expect(result.project.automation[automation.id]).toBe(automation);
  expect(result.project.clips.map((c) => c.ref)).toEqual([automation.id, result.id]);
  const edited = E.updateAutomation(result.project, result.id, { points: [{ t: 0, v: 1 }] });
  expect(edited.automation[automation.id].points).toEqual(automation.points);
  const removed = E.removeAutomation(edited, result.id);
  expect(removed.clips).toEqual([project.clips[0]]);
  expect(removed.automation[automation.id]).toBe(automation);
});

it('reserves explicitly supplied automation IDs without changing the input', () => {
  const { project, automation } = fixture();
  const input = { ...automation, name: 'New curve', points: [{ t: 0, v: 1 }] };
  collide();
  const result = E.addAutomation(project, input);
  expect(Object.keys(result.project.automation)).toHaveLength(2);
  expect(result.project.automation[automation.id]).toBe(automation);
  expect(result.project.automation[result.id].name).toBe('New curve');
  expect(input.id).toBe(automation.id);
});

it('keeps sequential curve additions distinct from each other and existing curves', () => {
  const { project, automation } = fixture();
  collide();
  const first = E.addAutomation(project, { name: 'First', target: { kind: 'tempo' } });
  const second = E.addAutomation(first.project, { name: 'Second', target: { kind: 'mixer', track: 0, param: 'pan' } });
  expect(new Set([automation.id, first.id, second.id]).size).toBe(3);
  expect(Object.keys(second.project.automation)).toHaveLength(3);
  expect(second.project.automation[first.id].name).toBe('First');
  expect(second.project.automation[automation.id]).toBe(automation);
});

it('preserves a valid supplied ID even when a pattern uses it', () => {
  const project = createProject();
  const id = project.patterns[0].id;
  const result = E.addAutomation(project, { id, name: 'Curve', target: { kind: 'tempo' } });
  expect(result.id).toBe(id);
  expect(result.project.automation[id].id).toBe(id);
  expect(result.project.patterns[0]).toBe(project.patterns[0]);
});
