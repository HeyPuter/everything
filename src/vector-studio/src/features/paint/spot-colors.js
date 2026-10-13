/**
 * Spot Colors dialog (Swatches panel menu): the options of the document's
 * spot inks (see prepress/separations.js).
 *
 *   Process builds   what spot inks print as when they are converted to
 *                    process (per ink, or every ink at export): the ink's
 *                    on-screen color through the press model ('lab'), or
 *                    each ink's own CMYK equivalent ('cmyk')
 *   per ink          name, print on its own plate or as process, and its
 *                    CMYK equivalent (prefilled from the press model)
 *
 * Changes apply as one undo step; renaming an ink renames its swatch.
 */
import { h } from '../../lib/dom.js';
import { hexToRgb } from '../../lib/color.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { swatchesOf, updateSwatch } from './swatch-model.js';
import { isSpotSwatch, inkUsage } from '../prepress/separations.js';
import { separate, documentCmykProfile } from '../prepress/color-management.js';

const INKS = ['c', 'm', 'y', 'k'];
const INK_LABELS = { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' };
const round1 = (v) => Math.round(v * 10) / 10;

/** The press model's CMYK build of a color (percent). */
export function pressCmyk(hex, profile = 'coatedWeb') {
  const { r, g, b } = hexToRgb(hex);
  const c = separate([r / 255, g / 255, b / 255], profile);
  return { c: round1(c.c), m: round1(c.m), y: round1(c.y), k: round1(c.k) };
}

/** The document's spot swatches. */
export function spotSwatches(doc) {
  return swatchesOf(doc).filter(isSpotSwatch);
}

/**
 * Apply Spot Colors settings (inside a transaction): { definition,
 * inks: [{ id, name, printAsProcess, cmyk }] }.
 */
export function applySpotSettings(doc, { definition, inks = [] }) {
  doc.updateRoot({ spotColors: { ...(doc.root.spotColors || {}), definition: definition === 'cmyk' ? 'cmyk' : 'lab' } });
  for (const ink of inks) {
    const sw = swatchesOf(doc).find((s) => s.id === ink.id);
    if (!sw) continue;
    const patch = { printAsProcess: ink.printAsProcess ? true : undefined };
    if (ink.name && ink.name !== sw.name) patch.name = ink.name;
    if (ink.cmyk) patch.spotCmyk = Object.fromEntries(INKS.map((k) => [k, Math.max(0, Math.min(100, Number(ink.cmyk[k]) || 0))]));
    updateSwatch(doc, sw.id, patch);
  }
}

let uid = 0;

/** One ink's row: chip, name, how it prints, its CMYK equivalent. */
function inkRow(sw, profile, used) {
  const n = ++uid;
  const name = h('input.spc-name', { type: 'text', value: sw.name || 'Spot', 'aria-label': 'Ink name', spellcheck: false, autocomplete: 'off' });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const printAs = h(
    'select.select.spc-print',
    { 'aria-label': `How ${sw.name} prints` },
    h('option', { value: 'plate', selected: !sw.printAsProcess }, 'Own plate'),
    h('option', { value: 'process', selected: Boolean(sw.printAsProcess) }, 'Process'),
  );
  const start = sw.spotCmyk || pressCmyk(sw.paint.color, profile);
  const fields = {};
  const cmyk = h('div.spc-cmyk', { role: 'group', 'aria-label': `${sw.name} CMYK equivalent` });
  for (const k of INKS) {
    const id = `spc-${n}-${k}`;
    fields[k] = h('input.spc-num', { type: 'number', id, min: 0, max: 100, step: 0.1, value: String(round1(start[k])), 'aria-label': `${INK_LABELS[k]} percent` });
    cmyk.append(h('label.spc-ink', { for: id }, h('span', { 'aria-hidden': 'true' }, k.toUpperCase()), fields[k]));
  }
  const reset = h('button.btn.small.spc-reset', { type: 'button', 'data-tip': 'Use the press model build', onclick: () => {
    const c = pressCmyk(sw.paint.color, profile);
    for (const k of INKS) fields[k].value = String(c[k]);
  } }, 'Reset');
  const el = h(
    'div.spc-row',
    { role: 'listitem', 'data-id': sw.id },
    h('span.spc-chip', { style: { background: sw.paint.color }, 'aria-hidden': 'true' }),
    h('div.spc-main', h('div.spc-line', name, printAs, used ? null : h('span.spc-unused.muted', 'Unused')), h('div.spc-line', cmyk, reset)),
  );
  return {
    el,
    read: () => ({
      id: sw.id,
      name: name.value.trim() || sw.name,
      printAsProcess: printAs.value === 'process',
      cmyk: Object.fromEntries(INKS.map((k) => [k, Number(fields[k].value) || 0])),
    }),
  };
}

/** Open the Spot Colors dialog for the active document. Resolves to true when applied. */
export async function spotColorsDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const profile = documentCmykProfile(app, doc);
  const inks = spotSwatches(doc);
  let used = new Set();
  try {
    used = inkUsage(doc, profile).spots;
  } catch {
    used = new Set(inks.map((s) => s.id));
  }
  const definition = doc.root.spotColors?.definition === 'cmyk' ? 'cmyk' : 'lab';
  const radio = (value, label, hint) => {
    const id = `spc-def-${value}`;
    return h('div.spc-choice', h('input', { type: 'radio', id, name: 'spc-def', value, checked: value === definition }), h('label', { for: id }, h('strong', label), h('span.muted', hint)));
  };
  const rows = inks.map((sw) => inkRow(sw, profile, used.has(sw.id)));
  const body = h(
    'div.form.spot-colors',
    h(
      'fieldset.spc-defs',
      h('legend', 'Process builds of spot inks'),
      radio('lab', 'Match the on-screen color', 'Spot inks convert through the document’s press model.'),
      radio('cmyk', 'Use each ink’s CMYK equivalent', 'The values below print when a spot ink is converted to process.'),
    ),
    rows.length
      ? h('div.spc-list', { role: 'list', 'aria-label': 'Spot inks' }, rows.map((r) => r.el))
      : h('p.panel-empty', 'This document has no spot colors. Set a swatch’s Color Type to Spot Color in Swatch Options to add one.'),
  );
  const res = await openDialog({
    title: 'Spot Colors',
    body,
    className: 'spot-colors-dialog',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => ({ definition: body.querySelector('input[name="spc-def"]:checked')?.value || 'lab', inks: rows.map((r) => r.read()) }) },
    ],
  });
  if (!res || app.editor !== ed) return false;
  doc.transact('Spot Colors', () => applySpotSettings(doc, res));
  return true;
}
