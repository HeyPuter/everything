/** Effect clips: which effect, plus that effect's own parameters. */
import { h } from '../../lib/dom.js';
import { EFFECTS, EFFECT_CATEGORIES } from '../../model/catalog.js';
import { carryEffectParams, clampEffectParam, effectDefaults } from '../../model/effect-params.js';
import { propSection } from './common.js';
import { groupedSelect } from './filter-clip.js';
import { scopedView, effectParamFields } from './clip-effects.js';

const effectLabel = (id) => EFFECTS.find((e) => e.id === id)?.label || 'Effect';

export function effectTab(view) {
  const pick = groupedSelect({
    label: 'Effect',
    groups: EFFECT_CATEGORIES,
    items: EFFECTS,
    value: view.clip.effect,
    onChange: (v) => view.edit('Change effect', (c) => {
      // Keep a custom name; follow the effect when the name is the old label.
      if (!c.name || c.name === effectLabel(c.effect)) c.name = effectLabel(v);
      c.params = carryEffectParams(v, c.params);
      c.effect = v;
    }),
  });
  const scoped = scopedView(view);
  const params = h('div.fx-params');
  let shown = null;
  const render = () => {
    const c = view.clip;
    if (!c) return;
    // Also while focused: setting the value of a native select does not close it or move focus.
    if (pick.select.value !== c.effect) pick.select.value = c.effect;
    if (c.effect === shown) return;
    shown = c.effect;
    scoped.reset();
    params.replaceChildren(...effectParamFields(scoped.view, {
      id: c.effect,
      keyPrefix: 'fx',
      getParams: (x) => x.params,
      setParam: (x, key, v) => {
        const val = clampEffectParam(x.effect, key, v);
        if (val === undefined) return false;
        x.params ||= {};
        x.params[key] = val;
      },
    }));
  };
  render();
  view.bind(render);
  return h('div', propSection('Effect', [pick.el, params], {
    onReset: () => view.edit('Reset effect', (c) => {
      c.params = effectDefaults(c.effect);
    }),
  }));
}
