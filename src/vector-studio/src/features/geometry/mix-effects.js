/**
 * Effect > Pathfinder > Hard Mix, Soft Mix and Trap as live effects. On a
 * group they recolor or trap its artwork as a whole (combine hook); on a
 * single object they do nothing. Soft Mix and Trap have options dialogs,
 * also used to edit them from the Appearance panel.
 */
import { h } from '../../lib/dom.js';
import { registerGeomEffect } from '../../model/geom-effects.js';
import { registerEffectType, EFFECTS } from '../paint/effects-model.js';
import { engineResult } from '../effects/geom/engine.js';
import { openEffectDialog, addEffectNow, sliderField, numberRow, checkField } from '../effects/dialog-kit.js';
import { mixTrapCombine } from './mix-trap.js';

const combine = (items, fx, info) => mixTrapCombine(items, fx, (op, shapes, params) => engineResult(op, shapes, params, { pending: info?.pending }));
const passThrough = (subs) => subs;

const DEFS = {
  hardMix: {
    label: 'Hard Mix',
    command: 'effect.pathfinder.hardMix',
    noDialog: true,
    defaults: {},
    describe: () => 'Pathfinder: Hard Mix',
  },
  softMix: {
    label: 'Soft Mix',
    command: 'effect.pathfinder.softMix',
    defaults: { rate: 0.5 },
    ranges: { rate: [0, 1] },
    describe: (e) => `Pathfinder: Soft Mix ${Math.round(e.rate * 100)}%`,
  },
  trap: {
    label: 'Trap',
    command: 'effect.pathfinder.trap',
    defaults: { thickness: 0.25, tint: 0.4, reverse: false },
    ranges: { thickness: [0.01, 5000], tint: [0, 1] },
    describe: (e) => `Pathfinder: Trap ${Number(e.thickness.toFixed(3))} pt`,
  },
};

for (const [type, def] of Object.entries(DEFS)) {
  registerGeomEffect(type, { apply: passThrough, combine });
  registerEffectType(type, def);
}

function softMixDialog(app, opts = {}) {
  return openEffectDialog(app, 'softMix', {
    ...opts,
    title: 'Soft Mix',
    build(ctx) {
      const rate = sliderField({ label: 'Mixing rate', value: ctx.start.rate * 100, min: 0, max: 100, kind: 'percent', onInput: ctx.changed, ends: ['Bottom color', 'Top color'] });
      const help = h('p.form-help', 'Where objects overlap, the colors below show through the ones above at this rate.');
      return { body: h('div.fx-body', rate.el, help), read: () => ({ rate: rate.get() / 100 }), focus: () => rate.field };
    },
  });
}

function trapDialog(app, opts = {}) {
  return openEffectDialog(app, 'trap', {
    ...opts,
    title: 'Trap',
    build(ctx) {
      const s = ctx.start;
      const thickness = numberRow({ label: 'Thickness', value: s.thickness, kind: 'length', unit: ctx.unit, min: 0.01, max: 5000, step: 0.05, onInput: ctx.changed });
      const tintRow = sliderField({ label: 'Tint reduction', value: s.tint * 100, min: 0, max: 100, kind: 'percent', onInput: ctx.changed });
      const reverse = checkField({ label: 'Reverse traps (spread the darker color)', value: s.reverse, onChange: ctx.changed });
      const help = h('p.form-help', 'Strips of the lighter color overlap the darker one where they meet, hiding gaps when printing plates shift.');
      return {
        body: h('div.fx-body', thickness.el, tintRow.el, reverse.el, help),
        read: () => ({ thickness: thickness.get(), tint: tintRow.get() / 100, reverse: reverse.get() }),
        focus: () => thickness.field,
      };
    },
  });
}

/** Effect menu commands and Appearance panel editing for the mix and trap effects. */
export function installMixEffects(app) {
  EFFECTS.softMix.openDialog = softMixDialog;
  EFFECTS.trap.openDialog = trapDialog;
  EFFECTS.hardMix.openDialog = (a, { params, edit } = {}) => {
    if (edit) {
      a.notify('Hard Mix has no options.', { polite: true });
      return false;
    }
    return addEffectNow(a, 'hardMix', params || {});
  };
  const hasSel = (a) => Boolean(a.editor?.selection.size);
  app.commands.register([
    { id: 'effect.pathfinder.hardMix', label: 'Hard Mix', enabled: hasSel, run: (a) => EFFECTS.hardMix.openDialog(a, {}) },
    { id: 'effect.pathfinder.softMix', label: 'Soft Mix...', enabled: hasSel, run: (a) => softMixDialog(a) },
    { id: 'effect.pathfinder.trap', label: 'Trap...', enabled: hasSel, run: (a) => trapDialog(a) },
  ]);
}
