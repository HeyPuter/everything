import { afterEach, expect, it, vi } from 'vitest';
import * as P from '../src/model/project.js';
import * as E from '../src/model/edits.js';
import { demoProject } from '../src/model/demo.js';
import { Store } from '../src/model/store.js';
import { MixerController } from '../src/mixer/controller.js';
import { createFxPanel } from '../src/mixer/fx-panel.js';
import { compileAutomation } from '../src/engine/compile.js';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture() {
  const project = P.createProject();
  const original = { ...P.createSlot('reverb'), id: '00000000', mix: 0.4, on: false };
  project.mixer[1].fx = [original];
  project.automation.a = { id: 'a', target: { kind: 'fx', track: 1, slot: original.id, param: 'wet' }, points: [{ t: 0, v: 0.8 }] };
  project.clips = [P.createClip({ kind: 'auto', ref: 'a', len: 96 })];
  const store = new Store(project), app = { store, notify: vi.fn(), openEffectEditor: vi.fn() };
  const ctl = new MixerController(app);
  return { project, original, store, app, ctl };
}
function collide() {
  const random = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => bytes.length === 8 && calls++ < 2 ? bytes.fill(0) : random(bytes));
}

it.each(['append', 'prepend', 'duplicate'])('keeps effect rows and edits independent after %s ID collisions', (action) => {
  const { project, original, store, app, ctl } = fixture();
  const panel = createFxPanel({ app, ctl }); document.body.append(panel.el);
  panel.update(project, 1);
  collide();
  const id = action === 'duplicate' ? ctl.duplicateEffect(1, original.id) : ctl.addEffect(1, 'delay', action === 'prepend' ? 0 : undefined);
  panel.update(store.project, 1);
  expect(panel.el.querySelectorAll('.mx-slot[data-id]')).toHaveLength(2);
  expect(id).not.toBe(original.id);
  expect(compileAutomation(store.project, () => -1)[0].target.fx).toBe(action === 'prepend' ? 1 : 0);
  const rows = [...panel.el.querySelectorAll('.mx-slot[data-id]')];
  rows.find((r) => r.dataset.id === id).querySelector('.mx-slot-name').click();
  expect(app.openEffectEditor).toHaveBeenCalledWith(1, id);
  ctl.toggleEffect(1, id);
  expect(store.project.mixer[1].fx.find((s) => s.id === original.id)).toBe(original);
  ctl.removeEffect(1, id);
  expect(store.project.mixer[1].fx).toEqual([original]);
  store.undo(); store.undo(); store.undo(); expect(store.project).toBe(project);
  store.redo(); expect(store.project.mixer[1].fx).toHaveLength(2);
});

it.each(['another slot', 'replaced slot'])('does not attach old automation when replacing an effect collides with %s', (collision) => {
  const { project, original, store, ctl } = fixture();
  const target = collision === 'replaced slot' ? original : { ...P.createSlot('reverb'), id: 'second', on: true, mix: 0.7 };
  if (target !== original) project.mixer[1].fx.push(target);
  collide();
  const id = ctl.replaceEffect(1, target.id, 'delay');
  expect(id).not.toBe(original.id);
  const fx = store.project.mixer[1].fx;
  expect(new Set(fx.map((s) => s.id)).size).toBe(fx.length);
  expect(fx.find((s) => s.id === id)).toMatchObject({ type: 'delay', on: target.on, mix: target.mix });
  const lanes = compileAutomation(store.project, () => -1);
  expect(lanes).toHaveLength(target === original ? 0 : 1);
  if (target !== original) expect(lanes[0].target.fx).toBe(0);
  ctl.removeEffect(1, id);
  expect(store.project.mixer[1].fx).toEqual(target === original ? [] : [original]);
  store.undo(); store.undo(); expect(store.project).toBe(project);
});

it('does not revive automation for a removed effect when a new slot ID collides', () => {
  const { project, original, store, ctl } = fixture();
  ctl.removeEffect(1, original.id);
  expect(compileAutomation(store.project, () => -1)).toHaveLength(0);
  collide();
  const id = ctl.addEffect(1, 'delay');
  expect(compileAutomation(store.project, () => -1)).toHaveLength(0);
  expect(id).not.toBe(original.id);
  expect(store.project.automation.a).toBe(project.automation.a);
  store.undo(); store.undo(); expect(store.project).toBe(project);
  expect(compileAutomation(store.project, () => -1)).toHaveLength(1);
});

it('keeps both demo lead effects independently addressable under colliding IDs', () => {
  const expected = demoProject();
  const create = P.createSlot;
  vi.spyOn(P, 'createSlot').mockImplementation((...args) => ({ ...create(...args), id: '00000000' }));
  const p = demoProject();
  for (let i = 0; i < p.mixer.length; i++) {
    const fx = p.mixer[i].fx;
    expect(new Set(fx.map((s) => s.id)).size).toBe(fx.length);
    expect(fx.map(({ id, ...s }) => s)).toEqual(expected.mixer[i].fx.map(({ id, ...s }) => s));
    if (fx.length) expect(E.removeSlot(p, i, fx[0].id).mixer[i].fx).toHaveLength(fx.length - 1);
  }
});

it('allows a slot ID used on another insert while preserving same-type replacement', () => {
  const { project, original } = fixture();
  collide();
  const result = E.addSlot(project, 2, 'delay');
  expect(result.id).toBe(original.id);
  const store = new Store(result.project), ctl = new MixerController({ store, notify() {} });
  const before = store.project;
  expect(ctl.replaceEffect(2, result.id, 'delay')).toBe(result.id);
  expect(store.project).toBe(before);
});
