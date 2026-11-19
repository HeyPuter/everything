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
 * The L and H bands' types: a shelf (the default) or a bell like bands 1..5.
 * Each glyph draws its response; the high shelf's is mirrored.
 */
export const LH_TYPES = [
  { name: 'Shelf', d: 'M3 8h5c3 0 5 8 8 8h5' },
  { name: 'Peak', d: 'M3 16h4c3 0 3-9 5-9s2 9 5 9h4' },
];

/** A button in the L or H band's Q cell: shows its type and switches shelf and peak. */
function bandTypeButton(ctx, prefix, label, high) {
  const id = `${prefix}Type`;
  const btn = h('button.peq-shape', { type: 'button', onclick: () => ctx.set(id, ctx.values[id] === 1 ? 0 : 1) });
  const show = (values) => {
    const k = values[id] === 1 ? 1 : 0;
    const t = LH_TYPES[k];
    const svg = glyph(t.d, 16);
    if (high && k === 0) svg.style.transform = 'scaleX(-1)';
    btn.replaceChildren(svg);
    btn.setAttribute('aria-label', `${label} type: ${t.name}`);
    btn.setAttribute('aria-pressed', String(k === 1));
    btn.title = k === 1 ? `${label} band is a peak (bell). Click to make it a shelf.` : `${label} band is a shelf. Click to make it a peak (bell).`;
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
  // The L and H bands' Q cells also carry their type button (beside the typed Q).
  for (const [section, prefix, high, label] of [['Low Shelf', 'ls', false, 'Low'], ['High Shelf', 'hs', true, 'High']]) {
    // Its cells run Frequency, Gain, Q, On (the table's rows).
    const qCell = table.querySelectorAll(`.fx-table-cell[data-section="${section}"]`)[2];
    if (!qCell) continue;
    qCell.classList.add('peq-shelf-q');
    qCell.append(bandTypeButton(ctx, prefix, label, high));
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
