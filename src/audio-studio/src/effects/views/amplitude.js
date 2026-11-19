// Dialog views for Amplitude effects laid out by hand. Normalize: the target
// beside its switch and unit, the equal-channels option, and DC bias adjust
// with its amount, in three compact rows. Channel Mixer: a page per output
// channel, each input's amount with its own Invert box.

import { h } from '../../lib/dom.js';
import { registerEditor } from '../editors.js';
import { checkbox, numberField, radioChoice, enableWhen, showWhen, controlsFor, groupBox, tabPanels } from '../layout.js';

function normalizeView(ctx) {
  const target = h(
    'span.nm-target',
    showWhen(ctx, h('span', numberField(ctx, 'targetPercent')), (v) => v.unit === 1),
    showWhen(ctx, h('span', numberField(ctx, 'targetDb')), (v) => v.unit === 0),
  );
  return h(
    'div.fx-stack.nm-view',
    h('div.nm-row', checkbox(ctx, 'normalizeTo', { label: 'Normalize To:' }), enableWhen(ctx, h('span.nm-row', target, radioChoice(ctx, 'unit', { label: null })), (v) => v.normalizeTo)),
    enableWhen(ctx, h('div.nm-row', checkbox(ctx, 'equal')), (v) => v.normalizeTo),
    h('div.nm-row', checkbox(ctx, 'removeDc', { label: 'DC Bias Adjust:' }), enableWhen(ctx, h('span', numberField(ctx, 'dcAmount')), (v) => v.removeDc)),
  );
}
normalizeView.hides = true;

registerEditor('normalize', normalizeView);

/**
 * An input's Invert box: checked while its amount is negative (the input
 * mixed in upside down); toggling flips the amount's sign. At 0 % there is
 * nothing to invert, so the box waits for an amount.
 */
export function invertInputBox(ctx, id, name) {
  const box = h('input', { type: 'checkbox', 'aria-label': `Invert ${name}`, onchange: () => ctx.set(id, -ctx.values[id]) });
  const show = (values) => {
    const v = values[id];
    box.checked = v < 0;
    box.disabled = v === 0;
    box.title = v === 0 ? `Set an amount for ${name} to invert it` : `Mix ${name} in with its polarity inverted`;
  };
  show(ctx.values);
  ctx.subscribe(show);
  return h('label.cm-invert', box);
}

const MIXER_PAGES = [
  { label: 'L', title: 'Left Output', inputs: [['lToL', 'the left input'], ['rToL', 'the right input']], invert: 'invertL' },
  { label: 'R', title: 'Right Output', inputs: [['lToR', 'the left input'], ['rToR', 'the right input']], invert: 'invertR' },
];

function channelMixerView(ctx) {
  const pages = MIXER_PAGES.map((pg) => ({
    label: pg.label,
    content: groupBox(
      pg.title,
      h(
        'div.cm-grid',
        h('span.cm-head', 'Input Channel'),
        h('span.cm-head.cm-head-invert', 'Invert'),
        pg.inputs.flatMap(([id, name]) => [controlsFor(ctx, [id]), invertInputBox(ctx, id, name)]),
      ),
      controlsFor(ctx, [pg.invert]),
    ),
  }));
  return tabPanels(pages, { label: 'Output channel' });
}
channelMixerView.hides = true;
registerEditor('channelMixer', channelMixerView);
