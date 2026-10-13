/**
 * Character and paragraph options behind the Character and Paragraph panel
 * menus and the Type menu: case and position toggles, underline and
 * strikethrough, kerning modes, whole-point widths, no break, hyphenation
 * and justification settings (with live preview), the line composers,
 * hanging punctuation, resetting the panels, Area Type Options and
 * auto-sized area type.
 */
import { h } from '../../lib/dom.js';
import { DEFAULT_CHAR, DEFAULT_PARA } from '../../model/nodes.js';
import { layoutText, autoSized, JUSTIFICATION_DEFAULTS, justificationOf } from '../../model/text-layout.js';
import { HYPHENATION_DEFAULTS, hyphenationOf } from '../../model/hyphenate.js';
import { session, applyCharStyle, applyParaStyle, currentCharStyle, currentParaStyle, currentTextNodes, MIXED } from './type-ops.js';
import { selectedTextNodes } from './outlines.js';
import { headOf } from './thread-model.js';

const hasText = (app) => Boolean(session(app)) || (app.editor ? selectedTextNodes(app.editor).length > 0 : false);
const hasDoc = (app) => Boolean(app.editor);

/** A character attribute toggle: on when every current character has `on`. */
function charToggle(id, label, key, on, off, shortcut = '') {
  return {
    id,
    label,
    shortcut,
    enabled: hasDoc,
    checked: (a) => currentCharStyle(a)?.[key] === on,
    run: (a) => applyCharStyle(a, { [key]: currentCharStyle(a)?.[key] === on ? off : on }, { label }),
  };
}

/** A paragraph attribute toggle. */
function paraToggle(id, label, key, on = true, off = false) {
  return {
    id,
    label,
    enabled: hasDoc,
    checked: (a) => currentParaStyle(a)?.[key] === on,
    run: (a) => applyParaStyle(a, { [key]: currentParaStyle(a)?.[key] === on ? off : on }, { label }),
  };
}

export const KERN_MODES = [
  ['metrics', 'Auto'],
  ['optical', 'Optical'],
  ['none', 'None'],
];

/** Character attributes Reset Panel restores (paint and the style reference stay). */
const CHAR_RESET = Object.fromEntries(Object.entries(DEFAULT_CHAR).filter(([k]) => k !== 'charStyle'));
const PARA_RESET = Object.fromEntries(Object.entries(DEFAULT_PARA).filter(([k]) => k !== 'paraStyle' && k !== 'tabs' && k !== 'list'));

export function resetCharacter(app) {
  applyCharStyle(app, { ...CHAR_RESET }, { label: 'Reset Character' });
}

export function resetParagraph(app) {
  applyParaStyle(app, { ...PARA_RESET }, { label: 'Reset Paragraph' });
}

/**
 * Live preview of paragraph settings: changes go into one open transaction
 * that OK commits and Cancel rolls back. With no type selected the
 * settings are for new type and apply on OK only.
 */
function paraPreview(app, label) {
  const ed = app.editor;
  const doc = ed?.doc;
  const nodes = doc ? [...new Map(currentTextNodes(app).map((n) => [headOf(doc, n).id, headOf(doc, n)])).values()] : [];
  if (!nodes.length || doc.tx) {
    return { preview() {}, commit: (patch) => applyParaStyle(app, patch, { label }), cancel() {} };
  }
  const originals = new Map(nodes.map((n) => [n.id, doc.get(n.id)]));
  const tx = doc.begin(label);
  const restore = () => {
    for (const [id, n] of originals) doc.update(id, { para: n.para, paras: n.paras, height: n.height });
  };
  return {
    preview(patch) {
      restore();
      if (patch) applyParaStyle(app, patch, { label });
      else session(app)?.changed();
    },
    commit(patch) {
      restore();
      applyParaStyle(app, patch, { label });
      tx.commit();
    },
    cancel() {
      tx.cancel();
      session(app)?.changed();
    },
  };
}

const valueOf = (v, d) => (v === MIXED || v == null ? d : v);

/** Paragraph > Hyphenation: on/off, word and fragment lengths, consecutive hyphens, zone, capitalized words. */
export async function hyphenationDialog(app) {
  const p = currentParaStyle(app) || {};
  const s = p.hyphenation === MIXED ? HYPHENATION_DEFAULTS : hyphenationOf(p);
  const pv = paraPreview(app, 'Hyphenation');
  const patchOf = (v) => ({
    hyphenate: v.hyphenate,
    hyphenation: { minWord: Math.round(v.minWord), minBefore: Math.round(v.minBefore), minAfter: Math.round(v.minAfter), limit: Math.round(v.limit), zone: v.zone, capitalized: v.capitalized },
  });
  let v = null;
  try {
    v = await app.dialogs.form({
      title: 'Hyphenation',
      fields: [
        { key: 'hyphenate', type: 'checkbox', label: 'Hyphenate', value: p.hyphenate === true },
        { key: 'minWord', type: 'number', label: 'Words with at Least (letters)', value: s.minWord, min: 2, max: 25 },
        { key: 'minBefore', type: 'number', label: 'Letters Before a Hyphen', value: s.minBefore, min: 1, max: 15 },
        { key: 'minAfter', type: 'number', label: 'Letters After a Hyphen', value: s.minAfter, min: 1, max: 15 },
        { key: 'limit', type: 'number', label: 'Hyphens in a Row', value: s.limit, min: 0, max: 25, help: 'Most lines in a row that may end with a hyphen; 0 for no limit.' },
        { key: 'zone', type: 'length', label: 'Hyphenation Zone', value: s.zone, min: 0, max: 5000, help: 'Text that is not justified hyphenates only when a line would otherwise end farther than this from the margin.' },
        { key: 'capitalized', type: 'checkbox', label: 'Hyphenate Capitalized Words', value: s.capitalized },
        { key: 'preview', type: 'checkbox', label: 'Preview', value: true },
      ],
      previewToggle: true,
      onChange: (vals) => pv.preview(vals.preview ? patchOf(vals) : null),
    });
  } catch (err) {
    pv.cancel();
    throw err;
  }
  if (!v) {
    pv.cancel();
    return null;
  }
  pv.commit(patchOf(v));
  return v;
}

const SPACING_ROWS = [
  ['word', 'Word Spacing', 0, 1000],
  ['letter', 'Letter Spacing', -100, 500],
  ['glyph', 'Glyph Scaling', 50, 200],
];

/**
 * Paragraph > Justification: minimum, desired and maximum word spacing,
 * letter spacing and glyph scaling, auto leading and single-word lines,
 * as a grid with a live preview. Returns the settings, or null.
 */
export async function justificationDialog(app) {
  const p = currentParaStyle(app) || {};
  const J = p.justification === MIXED ? { ...JUSTIFICATION_DEFAULTS } : justificationOf(p);
  const pv = paraPreview(app, 'Justification');
  const uid = Math.random().toString(36).slice(2, 7);
  const inputs = {};
  const pct = (key, label, value) => {
    const input = h('input.just-input', { type: 'text', id: `jd-${key}-${uid}`, inputmode: 'decimal', autocomplete: 'off', spellcheck: false, value: `${value}%`, 'aria-label': label });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const n = parseFloat(input.value);
      if (Number.isFinite(n)) input.value = `${n + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)}%`;
      changed();
    });
    inputs[key] = input;
    return input;
  };
  const head = h('div.just-row.just-head', h('span'), h('span', 'Minimum'), h('span', 'Desired'), h('span', 'Maximum'));
  const rows = SPACING_ROWS.map(([k, label]) =>
    h(
      'div.just-row',
      { role: 'group', 'aria-label': label },
      h('span.just-label', label),
      pct(`${k}Min`, `${label} minimum`, J[`${k}Min`]),
      pct(`${k}Desired`, `${label} desired`, J[`${k}Desired`]),
      pct(`${k}Max`, `${label} maximum`, J[`${k}Max`]),
    ),
  );
  const autoLeading = pct('autoLeading', 'Auto Leading', J.autoLeading);
  const single = h(
    'select',
    { id: `jd-single-${uid}` },
    [
      ['justify', 'Full Justify'],
      ['left', 'Align Left'],
      ['center', 'Align Center'],
      ['right', 'Align Right'],
    ].map(([value, label]) => h('option', { value, selected: J.singleWord === value }, label)),
  );
  const previewBox = h('input', { type: 'checkbox', id: `jd-preview-${uid}`, checked: true });
  const error = h('p.form-error', { role: 'alert' });
  const read = () => {
    const out = {};
    for (const [k, el] of Object.entries(inputs)) out[k] = parseFloat(el.value);
    out.singleWord = single.value;
    return out;
  };
  const check = (v) => {
    for (const [k, label, lo, hi] of SPACING_ROWS) {
      const a = v[`${k}Min`];
      const b = v[`${k}Desired`];
      const c = v[`${k}Max`];
      if (![a, b, c].every(Number.isFinite)) return `Enter numbers for ${label}.`;
      if (a < lo || c > hi) return `${label} goes from ${lo}% to ${hi}%.`;
      if (!(a <= b && b <= c)) return `${label}: the minimum cannot be above the desired value, nor the desired value above the maximum.`;
    }
    if (!Number.isFinite(v.autoLeading) || v.autoLeading < 0 || v.autoLeading > 500) return 'Auto Leading goes from 0% to 500%.';
    return '';
  };
  const changed = () => {
    const v = read();
    const msg = check(v);
    error.textContent = msg;
    if (!msg) pv.preview(previewBox.checked ? { justification: v } : null);
  };
  const body = h(
    'div.form.just-form',
    h('div.just-grid', head, rows),
    h('div.form-row', h('label', { for: autoLeading.id }, 'Auto Leading'), autoLeading),
    h('div.form-row', h('label', { for: single.id }, 'Single Word Justification'), single),
    h('div.form-row.check', previewBox, h('label', { for: previewBox.id }, 'Preview')),
    error,
  );
  body.addEventListener('change', changed);
  body.addEventListener('input', changed);
  let v = null;
  try {
    v = await app.dialogs.open({
      title: 'Justification',
      body,
      className: 'justification-dialog',
      buttons: [
        { label: 'Reset', value: '__reset', left: true },
        { label: 'Cancel', value: null },
        {
          label: 'OK',
          primary: true,
          value: () => read(),
          validate: () => {
            const msg = check(read());
            error.textContent = msg;
            return !msg;
          },
        },
      ],
      onOpen: changed,
    });
  } catch (err) {
    pv.cancel();
    throw err;
  }
  if (v === '__reset') {
    pv.commit({ justification: null });
    return { ...JUSTIFICATION_DEFAULTS };
  }
  if (!v) {
    pv.cancel();
    return null;
  }
  // Settings equal to the defaults are stored as none.
  const same = Object.keys(JUSTIFICATION_DEFAULTS).every((k) => v[k] === JUSTIFICATION_DEFAULTS[k]);
  pv.commit({ justification: same ? null : v });
  return v;
}

// ---- Area Type Options ----

const areaNodes = (app) => (app.editor ? currentTextNodes(app).filter((n) => n.kind === 'area') : []);

/** Height an auto-sized frame needs for its text. */
export function autoHeight(node) {
  const lay = layoutText(node);
  const inset = node.areaOptions?.inset || 0;
  const last = lay.lines[lay.lines.length - 1];
  const bottom = last ? last.y + last.desc : node.y + inset + lay.ascent + lay.descent;
  return Math.max(1, Math.ceil((bottom + inset - node.y) * 100) / 100);
}

/**
 * Area Type Options: size, rows and columns with gutters, inset, first
 * baseline, vertical alignment, text flow and auto size, previewed live on
 * the selected frames.
 */
export async function areaOptionsDialog(app) {
  const ed = app.editor;
  const nodes = areaNodes(app);
  if (!nodes.length) return null;
  const doc = ed.doc;
  const n = nodes[0];
  const o = n.areaOptions || {};
  const originals = new Map(nodes.map((x) => [x.id, x]));
  const tx = doc.tx ? null : doc.begin('Area Type Options');
  const apply = (v) => {
    for (const [id, orig] of originals) {
      if (!v) {
        doc.update(id, { areaOptions: orig.areaOptions, width: orig.width, height: orig.height });
        continue;
      }
      const areaOptions = {
        ...(orig.areaOptions || {}),
        rows: Math.round(v.rows),
        rowGutter: v.rowGutter,
        columns: Math.round(v.columns),
        columnGutter: v.columnGutter,
        inset: v.inset,
        firstBaseline: v.firstBaseline,
        minBaseline: v.minBaseline,
        flow: v.flow,
        verticalAlign: v.verticalAlign === 'top' ? undefined : v.verticalAlign,
        autoSize: v.autoSize || undefined,
      };
      const patch = { areaOptions };
      if (!orig.areaPath) {
        patch.width = v.width;
        patch.height = v.height;
      }
      const next = doc.update(id, patch);
      if (next && autoSized(next)) doc.update(id, { height: autoHeight(next) });
    }
    session(app)?.changed();
  };
  const shaped = nodes.every((x) => x.areaPath && x.areaPath.length > 2);
  let v = null;
  try {
    v = await app.dialogs.form({
      title: 'Area Type Options',
      fields: [
        ...(shaped
          ? []
          : [
              { key: 'width', type: 'length', label: 'Width', value: n.width, min: 1 },
              { key: 'height', type: 'length', label: 'Height', value: n.height, min: 1 },
              { key: 'autoSize', type: 'checkbox', label: 'Auto Size Height to Fit the Text', value: Boolean(o.autoSize) },
            ]),
        { type: 'heading', label: 'Rows' },
        { key: 'rows', type: 'number', label: 'Number', value: o.rows || 1, min: 1, max: 100 },
        { key: 'rowGutter', type: 'length', label: 'Gutter', value: o.rowGutter ?? 18, min: 0 },
        { type: 'heading', label: 'Columns' },
        { key: 'columns', type: 'number', label: 'Number', value: o.columns || 1, min: 1, max: 100 },
        { key: 'columnGutter', type: 'length', label: 'Gutter', value: o.columnGutter ?? 18, min: 0 },
        { type: 'heading', label: 'Offset' },
        { key: 'inset', type: 'length', label: 'Inset Spacing', value: o.inset || 0, min: 0 },
        {
          key: 'firstBaseline',
          type: 'select',
          label: 'First Baseline',
          value: o.firstBaseline || 'ascent',
          options: [
            { value: 'ascent', label: 'Ascent' },
            { value: 'capHeight', label: 'Cap Height' },
            { value: 'leading', label: 'Leading' },
            { value: 'xHeight', label: 'x Height' },
            { value: 'fixed', label: 'Fixed' },
          ],
        },
        { key: 'minBaseline', type: 'length', label: 'Min', value: o.minBaseline || 0, min: 0 },
        {
          key: 'verticalAlign',
          type: 'select',
          label: 'Align Vertically',
          value: o.verticalAlign || 'top',
          options: [
            { value: 'top', label: 'Top' },
            { value: 'center', label: 'Center' },
            { value: 'bottom', label: 'Bottom' },
            { value: 'justify', label: 'Justify (spread the lines)' },
          ],
        },
        {
          key: 'flow',
          type: 'select',
          label: 'Text Flow',
          value: o.flow || 'rows',
          options: [
            { value: 'rows', label: 'By Rows, Left to Right' },
            { value: 'columns', label: 'By Columns, Left to Right' },
          ],
        },
        { key: 'preview', type: 'checkbox', label: 'Preview', value: Boolean(tx) },
      ],
      previewToggle: Boolean(tx),
      onChange: (vals) => tx && apply(vals.preview ? vals : null),
    });
  } catch (err) {
    tx?.cancel();
    throw err;
  }
  if (!v) {
    tx?.cancel();
    session(app)?.changed();
    return null;
  }
  if (tx) {
    apply(v);
    tx.commit();
  } else doc.transact('Area Type Options', () => apply(v));
  return v;
}

/** Keep auto-sized area type as tall as its text, in the same undo step as the edit. */
export function installAutoSize(app) {
  const wired = new WeakSet();
  const wire = (ed) => {
    if (!ed || wired.has(ed.doc)) return;
    wired.add(ed.doc);
    const doc = ed.doc;
    let busy = false;
    doc.on('change', (e) => {
      if (busy || !e.live || !doc.tx || !e.ids) return;
      for (const id of e.ids) {
        const node = doc.get(id);
        if (!node || node.type !== 'text' || !autoSized(node)) continue;
        const height = autoHeight(node);
        if (Math.abs(height - node.height) < 0.01) continue;
        busy = true;
        try {
          doc.update(id, { height });
        } finally {
          busy = false;
        }
      }
    });
  };
  app.on('active-editor', wire);
  if (app.editor) wire(app.editor);
}

// ---- commands ----

export function installTypeOptions(app) {
  installAutoSize(app);
  const c = app.commands;
  c.register([
    charToggle('type.allCaps', 'All Caps', 'caps', 'all', 'normal', 'Shift+Mod+K'),
    charToggle('type.smallCaps', 'Small Caps', 'caps', 'small', 'normal'),
    charToggle('type.superscript', 'Superscript', 'position', 'super', 'normal'),
    charToggle('type.subscript', 'Subscript', 'position', 'sub', 'normal'),
    charToggle('type.underline', 'Underline', 'underline', true, false, 'Shift+Mod+U'),
    charToggle('type.strikethrough', 'Strikethrough', 'strike', true, false, 'Shift+Mod+/'),
    {
      id: 'type.fractionalWidths',
      label: 'Fractional Widths',
      enabled: hasDoc,
      checked: (a) => currentCharStyle(a)?.fractionalWidths !== false,
      run: (a) => applyCharStyle(a, { fractionalWidths: currentCharStyle(a)?.fractionalWidths === false }, { label: 'Fractional Widths' }),
    },
    charToggle('type.noBreak', 'No Break', 'noBreak', true, false),
    ...KERN_MODES.map(([mode, label]) => ({
      id: `type.kern.${mode}`,
      label: mode === 'none' ? 'No Automatic Kerning' : `${label} Kerning`,
      enabled: hasDoc,
      checked: (a) => (currentCharStyle(a)?.kernMode ?? 'metrics') === mode,
      run: (a) => applyCharStyle(a, { kernMode: mode }, { label: 'Kerning' }),
    })),
    { id: 'type.character.reset', label: 'Reset Panel', enabled: hasDoc, run: resetCharacter },
    paraToggle('type.hyphenate', 'Hyphenate', 'hyphenate'),
    { id: 'type.hyphenation', label: 'Hyphenation...', enabled: hasDoc, run: hyphenationDialog },
    { id: 'type.justification', label: 'Justification...', enabled: hasDoc, run: justificationDialog },
    {
      id: 'type.composer.single',
      label: 'Single-line Composer',
      enabled: hasDoc,
      checked: (a) => (currentParaStyle(a)?.composer ?? 'single') === 'single',
      run: (a) => applyParaStyle(a, { composer: 'single' }, { label: 'Single-line Composer' }),
    },
    {
      id: 'type.composer.every',
      label: 'Every-line Composer',
      enabled: hasDoc,
      checked: (a) => currentParaStyle(a)?.composer === 'every',
      run: (a) => applyParaStyle(a, { composer: 'every' }, { label: 'Every-line Composer' }),
    },
    paraToggle('type.hangingPunctuation', 'Hanging Punctuation', 'hangingPunctuation'),
    { id: 'type.paragraph.reset', label: 'Reset Panel', enabled: hasDoc, run: resetParagraph },
    { id: 'type.areaOptions', label: 'Area Type Options...', enabled: (a) => areaNodes(a).length > 0, run: areaOptionsDialog },
  ]);
}

export { hasText, valueOf };
