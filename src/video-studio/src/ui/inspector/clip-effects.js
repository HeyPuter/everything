/**
 * Effects tab for video, image, text and graphic clips: the clip's own
 * effect stack (model/clip-effects.js) with add, reorder, on/off, remove and
 * each effect's parameters. Also exports the parameter controls shared with
 * effect clips (effect.js).
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { EFFECTS, EFFECT_CATEGORIES } from '../../model/catalog.js';
import { effectParamDefs } from '../../model/effect-params.js';
import { MAX_CLIP_EFFECTS, setClipEffectParam } from '../../model/clip-effects.js';
import { slider, color, propSection, createScope, note, uidFor, keepFocus } from './common.js';
import '../../styles/effects.css';

const effectLabel = (id) => EFFECTS.find((e) => e.id === id)?.label || 'Effect';

/**
 * A view whose updaters go to a replaceable scope, so a list that is rebuilt
 * does not leave the old controls' updaters behind.
 */
export function scopedView(view) {
  let scope = createScope();
  const sub = Object.create(view, {
    bind: { value: (fn, opts) => scope.bind(fn, opts) },
  });
  view.bind(() => scope.update());
  return {
    view: sub,
    reset() {
      scope = createScope();
    },
  };
}

/**
 * Sliders and color fields for an effect's parameters.
 *  getParams(clip) -> params object (or null when the effect is gone)
 *  setParam(clip, key, value) -> false when it could not be applied
 */
export function effectParamFields(view, { id, getParams, setParam, keyPrefix, title = effectLabel(id) }) {
  return effectParamDefs(id).map((d) => {
    const label = `${title}: ${d.label.toLowerCase()}`;
    const value = (c) => getParams(c)?.[d.key] ?? d.def;
    const set = (v, final) => view.edit(label, (c) => setParam(c, d.key, v), { key: `${keyPrefix}-${d.key}`, final });
    if (d.type === 'color') return color(view, { label: d.label, get: value, set }).el;
    return slider(view, { label: d.label, min: d.min, max: d.max, step: d.step || 1, unit: d.unit || '', get: (c) => Number(value(c)), set }).el;
  });
}

/** Native select of all effects, grouped by category, with a placeholder first option. */
function effectPicker(onPick) {
  const id = uidFor('fxadd');
  const sel = h('select.select.clipfx-add', { id, 'aria-label': 'Add an effect to this clip' },
    h('option', { value: '' }, 'Add effect…'),
    EFFECT_CATEGORIES.map((g) => h('optgroup', { label: g.label }, EFFECTS.filter((e) => e.cat === g.id).map((e) => h('option', { value: e.id }, e.label)))),
  );
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '';
    if (v) onPick(v);
  });
  return sel;
}

export function clipEffectsTab(view) {
  const { actions } = view;
  const scoped = scopedView(view);
  const list = h('div.clipfx-list', { role: 'list', 'aria-label': 'Clip effects, applied top to bottom' });
  const count = h('span.clipfx-count');
  const picker = effectPicker((id) => actions.addClipEffect(view.id, id));
  const browse = h('button.btn.small', { type: 'button' }, icon('effects', 14), 'Browse');
  browse.addEventListener('click', () => view.ctx.assets?.show?.('effects'));
  const clearAll = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Remove all clip effects', 'data-tip': 'Remove all' }, icon('trash', 14));
  clearAll.addEventListener('click', () => actions.clearClipEffects(view.id));

  // The list is rebuilt after each change; focus goes back to the same control of the effect.
  const control = (i, act) => () => list.children[i]?.querySelector(`[data-act="${act}"]`);
  const item = (e, i, n) => {
    const name = effectLabel(e.id);
    const on = h('button.switch.small.clipfx-on', { type: 'button', role: 'switch', 'aria-checked': String(!e.off), 'aria-label': `${name} on`, dataset: { act: 'on' } });
    on.addEventListener('click', () => keepFocus(() => actions.toggleClipEffect(view.id, i, Boolean(e.off)), control(i, 'on')));
    const btn = (iconName, label, act, disabled, fn) => {
      const b = h('button.icon-btn.small', { type: 'button', 'aria-label': label, 'data-tip': label, disabled, dataset: { act } }, icon(iconName, 14));
      b.addEventListener('click', fn);
      return b;
    };
    const head = h('div.clipfx-head',
      on,
      h('span.clipfx-name', h('span.clipfx-index', `${i + 1}`), name),
      btn('arrowUp', `Move ${name} up`, 'up', i === 0, () => keepFocus(() => actions.moveClipEffect(view.id, i, i - 1), control(i - 1, 'up'), control(i - 1, 'down'))),
      btn('arrowDown', `Move ${name} down`, 'down', i === n - 1, () => keepFocus(() => actions.moveClipEffect(view.id, i, i + 1), control(i + 1, 'down'), control(i + 1, 'up'))),
      btn('trash', `Remove ${name}`, 'remove', false, () => keepFocus(() => actions.removeClipEffect(view.id, i), control(i, 'remove'), control(i - 1, 'remove'), () => picker)),
    );
    const fields = effectParamFields(scoped.view, {
      id: e.id,
      title: name,
      keyPrefix: `cfx-${i}`,
      getParams: (c) => (c.effects?.[i]?.id === e.id ? c.effects[i].params : null),
      setParam: (c, key, v) => (c.effects?.[i]?.id === e.id ? setClipEffectParam(c, i, key, v) : false),
    });
    return h(`div.clipfx-item${e.off ? '.off' : ''}`, { role: 'listitem', 'aria-label': `${i + 1}. ${name}${e.off ? ', off' : ''}` }, head, h('div.clipfx-params', fields));
  };

  let sig = null;
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const fx = c.effects || [];
    count.textContent = `${fx.length} of ${MAX_CLIP_EFFECTS}`;
    picker.disabled = fx.length >= MAX_CLIP_EFFECTS;
    clearAll.hidden = !fx.length;
    const s = fx.map((e) => `${e.id}:${e.off ? 0 : 1}`).join('|');
    if (s === sig) return;
    sig = s;
    scoped.reset();
    list.replaceChildren(...(fx.length
      ? fx.map((e, i) => item(e, i, fx.length))
      : [note('Effects added here apply to this clip only and move with it. Pick one below, click one in the Effects tab, or drag one onto the clip.', 'effects')]));
  };
  render();
  view.bind(render);

  return h('div.clipfx-tab', propSection('Clip effects', [
    h('div.clipfx-tools', picker, browse),
    list,
  ], { actions: h('span.clipfx-actions', count, clearAll) }));
}
