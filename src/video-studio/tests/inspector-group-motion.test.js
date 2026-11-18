import { describe, it, expect, afterEach } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { mainTrack, setSpeed } from '../src/model/timeline.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { evaluate } from '../src/engine/scene.js';

HTMLCanvasElement.prototype.getContext = () => null;
const FREE = { ripple: false, linkOverlays: false };
let env;
function setup({ nested = false } = {}) {
  const p = fixture();
  const [v] = onMain(p, clip('video', 0, 4), clip('video', 4, 2));
  let c = createCompound(p, [v.id], FREE);
  c.name = 'Opening motion';
  c.keyframes.x = [{ t: 0, v: 0, ease: 'linear' }, { t: s(4), v: 0.4, ease: 'linear' }];
  c.transform.scale = 0.5;
  if (nested) {
    const outer = createCompound(p, [c.id], FREE);
    outer.name = 'Outer motion'; outer.transform.x = 0.2; outer.transform.scale = 0.8; outer.opacity = 0.4;
    [c] = breakApart(p, outer.id, FREE);
  }
  const [child] = breakApart(p, c.id, FREE);
  setSpeed(p, child.id, 2, FREE);
  const store = new EditorStore(p);
  const ctx = { store }; ctx.actions = createActions(ctx);
  const inspector = createInspector(ctx);
  document.body.append(inspector.el);
  store.select(child.id);
  inspector.showTab('groupMotion');
  env = { ctx, store, inspector, el: inspector.el };
  return env;
}
const field = label => [...env.el.querySelectorAll('.field')].find(f => f.querySelector('.field-label')?.textContent === label);
const parent = () => env.store.selected.clip.inherited[0].parent;
function change(label, value) {
  const input = field(label).querySelector('.num-input');
  input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true }));
}
afterEach(() => { env?.inspector.dispose(); env?.el.remove(); env = null; document.querySelectorAll('.toast').forEach(t => t.remove()); });

describe('retained group motion controls', () => {
  it('shows familiar units, edits retained motion, and follows undo and the playhead', () => {
    const { store } = setup();
    expect(field('Group').querySelector('select').selectedOptions[0].textContent).toBe('Opening motion');
    expect(field('Scale').querySelector('.num-input').value).toBe('50');
    store.seek(s(0.5));
    expect(Number(field('Position X').querySelector('.num-input').value)).toBeCloseTo(192);
    change('Scale', 75);
    expect(parent().transform.scale).toBe(0.75);
    expect(store.selected.clip.transform.scale).toBe(1);
    store.undo();
    expect(field('Scale').querySelector('.num-input').value).toBe('50');
    change('Position Y', 108);
    expect(parent().transform.y).toBeCloseTo(-0.1);
  });

  it('keys and navigates in the former compound clock after a speed change', () => {
    const { store } = setup();
    store.seek(s(0.5));
    change('Position X', 384);
    expect(parent().keyframes.x.map(k => k.t)).toEqual([0, s(1), s(4)]);
    field('Position X').querySelector('[aria-label="Next Position X keyframe"]').click();
    expect(store.time).toBe(s(2));
    field('Position X').querySelector('[aria-label="Previous Position X keyframe"]').click();
    expect(store.time).toBe(s(0.5));
    field('Position X').querySelector('.kf-btn').click();
    expect(parent().keyframes.x).toHaveLength(2);
  });

  it('refuses keyed edits off the clip and all edits on locked tracks', () => {
    const { store } = setup();
    store.seek(s(3));
    const before = JSON.stringify(parent().keyframes);
    change('Position X', 700);
    expect(JSON.stringify(parent().keyframes)).toBe(before);
    store.seek(s(0.5));
    store.update('Lock', p => { mainTrack(p).locked = true; });
    change('Scale', 200);
    expect(parent().transform.scale).toBe(0.5);
    expect(field('Scale').querySelector('.num-input').value).toBe('50');
  });

  it('removes group motion as one undoable edit and restores its tab on undo', () => {
    const { store, el } = setup();
    store.seek(s(0.5));
    const before = evaluate(store.project, store.time)[0];
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Remove group motion').click();
    expect(store.selected.clip.inherited).toBeUndefined();
    expect([...el.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Group motion')).toBe(false);
    store.undo();
    expect([...el.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Group motion')).toBe(true);
    expect(evaluate(store.project, store.time)[0].x).toBe(before.x);
  });
  it('removes one nested group while retaining the outer group and its editable controls', () => {
    const { store, el } = setup({ nested: true });
    const remove = () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Remove group motion').click();
    expect([...field('Group').querySelector('select').options].map(o => o.textContent)).toEqual(['Opening motion', 'Outer motion']);
    remove();
    expect([...field('Group').querySelector('select').options].map(o => o.textContent)).toEqual(['Outer motion']);
    const layer = evaluate(store.project, 0)[0];
    expect(layer.x).toBeCloseTo(0.2);
    expect(layer.scale).toBeCloseTo(0.8);
    expect(layer.opacity).toBeCloseTo(0.4);
    change('Scale', 90);
    expect(evaluate(store.project, 0)[0].scale).toBeCloseTo(0.9);
    remove();
    expect(store.selected.clip.inherited).toBeUndefined();
  });

  it('keeps media clock records out of the group picker and cleans them up on removal', () => {
    const { ctx, store, el, inspector } = setup();
    const id = store.selected.clip.id;
    ctx.actions.replaceClip(id, store.project.assets.silent);
    inspector.showTab('groupMotion');
    expect([...field('Group').querySelector('select').options].map(o => o.textContent)).toEqual(['Opening motion']);
    store.seek(s(0.5));
    change('Position X', 384);
    expect(store.selected.clip.inherited[0].parent.inherited[0].parent.keyframes.x.find(k => k.t === s(1)).v).toBe(0.2);
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Remove group motion').click();
    expect(store.selected.clip.inherited).toBeUndefined();
  });

  it('uses preview-frame tolerance when toggling a sped-up group keyframe', () => {
    const { store } = setup();
    store.seek(s(0.5)); change('Position X', 384);
    store.seek(s(0.49));
    const key = field('Position X').querySelector('.kf-btn');
    expect(key.getAttribute('aria-pressed')).toBe('true');
    key.click();
    expect(parent().keyframes.x).toHaveLength(2);
  });

  it('does not offer controls for an empty timing-only record', () => {
    const { store, el } = setup();
    store.update('Empty timing', p => {
      mainTrack(p).clips[0].inherited[0].parent.clockOnly = true;
    });
    expect([...el.querySelectorAll('[role=tab]')].some(t => t.textContent === 'Group motion')).toBe(false);
  });

});
