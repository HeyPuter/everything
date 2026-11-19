// Dialog views for the equalizers. Parametric: master gain fader beside the
// curve (whose span follows Range), the band table, and Constant, Ultra-Quiet
// and Range along the bottom. Graphic: the response curve, a vertical
// slider per band whose span follows Range (6 to 48 dB, centred on 0), and
// Range, Accuracy and Master Gain underneath. Shrinking Range pulls bands
// that fall outside it back to its edge.

import { h } from '../../lib/dom.js';
import { registerEditor, eqEditor } from '../editors.js';
import { paramControls } from '../dialog.js';
import { controlsFor, groupBox, numberField, sectionControls, vSlider, radioChoice, checkbox, glyph } from '../layout.js';

/** Band params with their slider span set by Range. */
export function bandsInRange(def, range) {
  const half = Math.max(3, Math.min(24, range / 2));
  return def.params.filter((p) => p.section === 'Bands').map((p) => ({ ...p, min: -half, max: half }));
}

function graphicView(ctx) {
  const graph = eqEditor({ range: 24 })(ctx);
  const strip = h('div.geq-bands');
  let controls = null;
  let built = null;
  let from = null;
  const build = () => {
    built = ctx.values.range;
    controls = paramControls({ ...ctx.def, params: bandsInRange(ctx.def, built), layout: { vertical: ['Bands'] } }, () => ctx.values, (id, v) => {
      from = id;
      ctx.set(id, v);
      from = null;
    });
    strip.replaceChildren(controls.el);
  };
  build();
  ctx.subscribe((values) => {
    const half = values.range / 2;
    const over = bandsInRange(ctx.def, values.range).filter((p) => Math.abs(values[p.id]) > half + 1e-9);
    for (const p of over) ctx.set(p.id, Math.sign(values[p.id]) * half);
    if (over.length) return;
    if (values.range !== built) build();
    else controls.refresh(values, from);
  });
  const bottom = groupBox(
    '',
    h(
      'div.geq-settings',
      h('div.geq-range', h('span.fx-label', 'Range:'), numberField(ctx, 'range')),
      h('div.geq-accuracy', controlsFor(ctx, ['accuracy'])),
      h('div.geq-gain', controlsFor(ctx, ['gain'], { labels: { gain: 'Gain' } })),
    ),
  );
  return h('div.fx-stack', graph, strip, bottom);
}
graphicView.hides = true;

for (const id of ['graphicEq10', 'graphicEq20', 'graphicEq30']) registerEditor(id, Object.assign((ctx) => graphicView(ctx), { hides: true, dialogClass: id === 'graphicEq10' ? '' : 'fx-wide' }));

/** Graph span in dB either side of 0 for the Parametric Equalizer's Range. */
export const parametricSpan = (values) => (values.range === 1 ? 48 : 15);

/**
 * Shelf shapes the L and H bands step through: the Q of the shelf's
 * transition. Gentle spreads it over several octaves, Standard is the flat
 * Butterworth shelf, Steep packs it into about an octave with a small
 * overshoot either side. Any other Q typed in the table counts as the
 * nearest shape.
 */
export const SHELF_SHAPES = [
  { name: 'Gentle', q: 0.5, d: 'M3 8c6 0 9 8 18 8' },
  { name: 'Standard', q: 0.7071, d: 'M3 8h5c3 0 5 8 8 8h5' },
  { name: 'Steep', q: 1.4, d: 'M3 8h6l1.5-1.5L13 17l1.5-1H21' },
];

/** Index in SHELF_SHAPES of the shape nearest Q (on a log scale). */
export function shelfShapeOf(q) {
  let best = 0;
  SHELF_SHAPES.forEach((s, i) => {
    if (Math.abs(Math.log(q / s.q)) < Math.abs(Math.log(q / SHELF_SHAPES[best].q))) best = i;
  });
  return best;
}

/** A button in a shelf's Q cell: shows the shape and steps to the next one. */
function shelfShapeButton(ctx, prefix, label, high) {
  const id = `${prefix}Q`;
  const btn = h('button.peq-shape', { type: 'button', onclick: () => {
    const next = SHELF_SHAPES[(shelfShapeOf(ctx.values[id]) + 1) % SHELF_SHAPES.length];
    ctx.set(id, next.q);
  } });
  const show = (values) => {
    const k = shelfShapeOf(values[id]);
    const s = SHELF_SHAPES[k];
    const next = SHELF_SHAPES[(k + 1) % SHELF_SHAPES.length];
    const svg = glyph(s.d, 16);
    if (high) svg.style.transform = 'scaleX(-1)';
    btn.replaceChildren(svg);
    btn.setAttribute('aria-label', `${label} shape: ${s.name}`);
    btn.title = `${label} shape: ${s.name}. Click for ${next.name}; type a Q for any shape in between.`;
    btn.disabled = !values[`${prefix}On`];
  };
  show(ctx.values);
  ctx.subscribe(show);
  return btn;
}

function parametricView(ctx) {
  const graph = eqEditor({ range: parametricSpan })(ctx);
  const sections = [...new Set(ctx.def.params.map((p) => p.section).filter(Boolean))];
  const table = sectionControls(ctx, sections);
  // The shelves' Q cells also carry a shape button (beside the typed Q).
  for (const [section, prefix, high] of [['Low Shelf', 'ls', false], ['High Shelf', 'hs', true]]) {
    // Its cells run Frequency, Gain, Q, On (the table's rows).
    const qCell = table.querySelectorAll(`.fx-table-cell[data-section="${section}"]`)[2];
    if (!qCell) continue;
    qCell.classList.add('peq-shelf-q');
    qCell.append(shelfShapeButton(ctx, prefix, section, high));
  }
  return h(
    'div.fx-stack',
    h('div.peq-top', vSlider(ctx, 'gain', { label: 'Gain' }), graph),
    table,
    h('div.peq-bottom', radioChoice(ctx, 'qMode'), checkbox(ctx, 'ultraQuiet'), radioChoice(ctx, 'range')),
  );
}
parametricView.hides = true;
parametricView.dialogClass = 'fx-wide';
registerEditor('parametricEq', parametricView);
