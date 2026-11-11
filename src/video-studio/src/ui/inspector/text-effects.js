/**
 * Effects sub-tab of the Text tab: word-art looks with live thumbnails.
 * Picking one replaces the clip's decorations with the look's bundle
 * (model/text-presets.js applyTextEffect); None clears them.
 */
import { h, announce } from '../../lib/dom.js';
import { TEXT_EFFECTS, applyTextEffect } from '../../model/text-presets.js';
import { choiceGrid } from './common.js';
import { dropColorKeys } from '../../model/text-style.js';
import { lookCanvas } from '../text-thumbs.js';

export function effectThumb(effect, w = 104, hh = 104) {
  return lookCanvas({ text: 'Aa', style: { ...effect.style, size: 72 } }, w, hh, { className: 'preset-canvas', bg: null, maxScale: 0.9 });
}

export function effectsTab(view) {
  const grid = choiceGrid({
    label: 'Text effects',
    className: 'preset-grid effect-grid',
    items: [{ id: null, label: 'None' }, ...TEXT_EFFECTS].map((e) => ({ id: e.id, label: e.label, preview: e.id ? effectThumb(e) : h('span.anim-demo', { dataset: { anim: 'none' } }) })),
    value: view.clip.style.effect || null,
    onPick: (id) => {
      const fx = TEXT_EFFECTS.find((e) => e.id === id) || null;
      // A look sets its own fill; keyed colors would hide it, so they go (as with Reset).
      let unkeyed = false;
      view.edit(fx ? `${fx.label} effect` : 'Remove effect', (c) => {
        c.style = applyTextEffect(c.style, fx);
        delete c.preset;
        unkeyed = dropColorKeys(c);
      });
      announce(`${fx ? `${fx.label} effect applied` : 'Effect removed'}${unkeyed ? '. Color keyframes removed' : ''}`);
    },
  });
  view.bind(() => view.clip && grid.set(view.clip.style.effect || null));
  return h('div.text-effects', h('p.field-hint.text-hint', 'Looks built from gradients, outlines, glow and depth. Fine-tune them in Basic.'), h('div.anim-grid-wrap', grid.el));
}
