/**
 * Document Setup (Alt+Mod+P): units, bleed, a quick artboard size edit (or
 * Edit Artboards to switch to the Artboard tool), images in Outline mode,
 * and transparency grid options. Applied as one undoable change to the
 * root node.
 */
import { h } from '../../lib/dom.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { icon } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { UNIT_OPTIONS, LIMITS } from './presets.js';
import { normalizeBleed } from './format.js';
import { LANGUAGES, DOUBLE_QUOTES, SINGLE_QUOTES, typeOptionsOf } from './type-setup.js';

export const GRID_SIZES = [
  { value: 4, label: 'Small' },
  { value: 8, label: 'Medium' },
  { value: 16, label: 'Large' },
];

export const GRID_COLORS = [
  { value: 'light', label: 'Light', colors: ['#ffffff', '#e6e6e6'] },
  { value: 'medium', label: 'Medium', colors: ['#ffffff', '#d9d9d9'] },
  { value: 'dark', label: 'Dark', colors: ['#999999', '#666666'] },
  { value: 'custom', label: 'Custom', colors: null },
];

export const DEFAULT_TRANSPARENCY_GRID = { size: 8, preset: 'medium', color1: '#ffffff', color2: '#d9d9d9', simulatePaper: false };

export function transparencyGridOf(root) {
  return { ...DEFAULT_TRANSPARENCY_GRID, ...(root.transparencyGrid || {}) };
}

/** Root patch for Document Setup values (pure, for tests). */
export function documentSetupPatch(root, v) {
  const patch = {};
  if (v.units && v.units !== root.units) patch.units = v.units;
  const bleed = normalizeBleed(v.bleed);
  const old = normalizeBleed(root.bleed ?? 0);
  if (['top', 'bottom', 'left', 'right'].some((s) => bleed[s] !== old[s])) patch.bleed = bleed;
  if (Number.isInteger(v.artboard) && root.artboards[v.artboard] && Number.isFinite(v.width) && Number.isFinite(v.height)) {
    const a = root.artboards[v.artboard];
    if (Math.abs(a.w - v.width) > 1e-6 || Math.abs(a.h - v.height) > 1e-6) {
      patch.artboards = root.artboards.map((b, i) => (i === v.artboard ? { ...b, w: v.width, h: v.height } : b));
    }
  }
  if (Boolean(v.showImagesInOutline) !== Boolean(root.showImagesInOutline)) patch.showImagesInOutline = Boolean(v.showImagesInOutline);
  if (v.typeOptions) {
    const cur = typeOptionsOf(root);
    const next = { ...cur, ...v.typeOptions };
    if (Object.keys(next).some((k) => next[k] !== cur[k])) patch.typeOptions = next;
  }
  if (v.transparencyGrid) {
    const next = { ...transparencyGridOf(root), ...v.transparencyGrid };
    const cur = transparencyGridOf(root);
    if (Object.keys(next).some((k) => next[k] !== cur[k])) patch.transparencyGrid = next;
  }
  return patch;
}

export async function documentSetupDialog(app, editor = app.editor) {
  if (!editor) return false;
  const doc = editor.doc;
  const root = doc.root;
  let units = root.units || 'pt';
  const bleed = normalizeBleed(root.bleed ?? 0);
  const tg = transparencyGridOf(root);
  const boardIndex = Math.min(editor.activeArtboard, root.artboards.length - 1);

  const id = (s) => `ds-${s}`;
  const unitsSel = h('select.select', { id: id('units') }, UNIT_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === units }, o.label)));
  const bleedIn = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((s) => [s, h('input', { type: 'text', id: id(`bleed-${s}`), value: formatLength(bleed[s], units), inputmode: 'decimal', autocomplete: 'off', spellcheck: false })]));
  const linked = { on: new Set(Object.values(bleed)).size === 1 };
  const linkBtn = h('button.icon-btn.newdoc-link', { type: 'button', 'aria-label': 'Link bleed values', 'aria-pressed': String(linked.on), 'data-tip': 'Make all settings the same' }, icon(linked.on ? 'link' : 'unlink', 14));
  linkBtn.addEventListener('click', () => {
    linked.on = !linked.on;
    linkBtn.setAttribute('aria-pressed', String(linked.on));
    linkBtn.replaceChildren(icon(linked.on ? 'link' : 'unlink', 14));
    if (linked.on) for (const s of ['bottom', 'left', 'right']) bleedIn[s].value = bleedIn.top.value;
  });
  for (const [s, el] of Object.entries(bleedIn)) {
    el.addEventListener('input', () => {
      if (linked.on) for (const [o, other] of Object.entries(bleedIn)) if (o !== s) other.value = el.value;
    });
  }
  const boardSel = h(
    'select.select',
    { id: id('artboard') },
    root.artboards.map((a, i) => h('option', { value: String(i), selected: i === boardIndex }, `${i + 1}  ${a.name || `Artboard ${i + 1}`}`)),
  );
  const wIn = h('input', { type: 'text', id: id('w'), inputmode: 'decimal', autocomplete: 'off', spellcheck: false });
  const hIn = h('input', { type: 'text', id: id('h'), inputmode: 'decimal', autocomplete: 'off', spellcheck: false });
  const fillBoard = () => {
    const a = root.artboards[Number(boardSel.value)];
    wIn.value = formatLength(a.w, units);
    hIn.value = formatLength(a.h, units);
  };
  fillBoard();
  boardSel.addEventListener('change', fillBoard);
  unitsSel.addEventListener('change', () => {
    const prev = units;
    units = unitsSel.value;
    for (const el of [...Object.values(bleedIn), wIn, hIn]) {
      const v = parseLength(el.value, prev);
      if (Number.isFinite(v)) el.value = formatLength(v, units);
    }
  });

  const imagesOutline = h('input', { type: 'checkbox', id: id('img-outline'), checked: Boolean(root.showImagesInOutline) });
  const sizeSel = h('select.select', { id: id('grid-size') }, GRID_SIZES.map((o) => h('option', { value: String(o.value), selected: o.value === tg.size }, o.label)));
  const colorSel = h('select.select', { id: id('grid-colors') }, GRID_COLORS.map((o) => h('option', { value: o.value, selected: o.value === tg.preset }, o.label)));
  const c1 = h('input', { type: 'color', id: id('c1'), value: tg.color1, 'aria-label': 'Grid color 1' });
  const c2 = h('input', { type: 'color', id: id('c2'), value: tg.color2, 'aria-label': 'Grid color 2' });
  colorSel.addEventListener('change', () => {
    const p = GRID_COLORS.find((o) => o.value === colorSel.value);
    if (p?.colors) [c1.value, c2.value] = p.colors;
  });
  for (const c of [c1, c2]) c.addEventListener('input', () => (colorSel.value = 'custom'));
  const paper = h('input', { type: 'checkbox', id: id('paper'), checked: Boolean(tg.simulatePaper) });
  const to = typeOptionsOf(root);
  const quoteOptions = (list, value) => (list.includes(value) ? list : [value, ...list]).map((q) => h('option', { value: q, selected: q === value }, `${q[0]}abc${q[1]}`));
  const langSel = h('select.select', { id: id('lang') }, LANGUAGES.map((l) => h('option', { value: l.value, selected: l.value === to.language }, l.label)));
  const doubleSel = h('select.select', { id: id('dq') }, quoteOptions(DOUBLE_QUOTES, to.double));
  const singleSel = h('select.select', { id: id('sq') }, quoteOptions(SINGLE_QUOTES, to.single));
  const smartQuotes = h('input', { type: 'checkbox', id: id('smartq'), checked: to.quotes });
  // A language brings its usual quote marks.
  langSel.addEventListener('change', () => {
    const l = LANGUAGES.find((x) => x.value === langSel.value);
    if (l) {
      doubleSel.value = l.double;
      singleSel.value = l.single;
    }
  });
  const error = h('p.form-error', { role: 'alert' });

  const canEditArtboards = app.toolClasses.has('artboard');
  let editArtboards = false;
  const row = (label, forId, ...ctl) => h('div.form-row', h('label', { for: forId }, label), h('div.files-ctl', ...ctl));
  const body = h(
    'div.form.files-setup',
    h('h3.form-heading', 'General'),
    row('Units', id('units'), unitsSel),
    h(
      'fieldset.newdoc-bleed',
      h('legend', 'Bleed'),
      h('div.newdoc-bleed-grid', Object.entries(bleedIn).map(([s, el]) => h('div.newdoc-bleed-cell', h('label', { for: el.id }, s[0].toUpperCase() + s.slice(1)), el)), linkBtn),
    ),
    h('h3.form-heading', 'Artboard Size'),
    root.artboards.length > 1 ? row('Artboard', id('artboard'), boardSel) : null,
    row('Width', id('w'), wIn),
    row('Height', id('h'), hIn),
    canEditArtboards
      ? h('div.form-row', h('span'), h('button.btn', { type: 'button', onclick: (e) => ((editArtboards = true), e.currentTarget.closest('dialog').close()) }, 'Edit Artboards'))
      : null,
    h('div.form-row.check', imagesOutline, h('label', { for: id('img-outline') }, 'Show Images in Outline Mode')),
    h('h3.form-heading', 'Transparency'),
    row('Grid Size', id('grid-size'), sizeSel),
    row('Grid Colors', id('grid-colors'), colorSel, c1, c2),
    h('div.form-row.check', paper, h('label', { for: id('paper') }, 'Simulate Colored Paper')),
    h('h3.form-heading', 'Type'),
    row('Language', id('lang'), langSel),
    row('Double Quotes', id('dq'), doubleSel),
    row('Single Quotes', id('sq'), singleSel),
    h('div.form-row.check', smartQuotes, h('label', { for: id('smartq') }, "Use Typographer's Quotes")),
    error,
  );

  const read = () => {
    const b = {};
    for (const [s, el] of Object.entries(bleedIn)) b[s] = parseLength(el.value, units);
    return {
      units,
      bleed: b,
      artboard: Number(boardSel.value),
      width: parseLength(wIn.value, units),
      height: parseLength(hIn.value, units),
      showImagesInOutline: imagesOutline.checked,
      transparencyGrid: { size: Number(sizeSel.value), preset: colorSel.value, color1: c1.value, color2: c2.value, simulatePaper: paper.checked },
      typeOptions: { language: langSel.value, double: doubleSel.value, single: singleSel.value, quotes: smartQuotes.checked },
    };
  };
  const validate = () => {
    const v = read();
    const bad = (el, msg) => {
      error.textContent = msg;
      el.focus();
      return false;
    };
    for (const [s, el] of Object.entries(bleedIn)) if (!Number.isFinite(v.bleed[s]) || v.bleed[s] < 0 || v.bleed[s] > LIMITS.maxBleed) return bad(el, `Bleed must be between 0 and ${LIMITS.maxBleed} pt.`);
    if (!Number.isFinite(v.width) || v.width < LIMITS.minSize || v.width > LIMITS.maxSize) return bad(wIn, `Width must be between ${LIMITS.minSize} and ${LIMITS.maxSize} pt.`);
    if (!Number.isFinite(v.height) || v.height < LIMITS.minSize || v.height > LIMITS.maxSize) return bad(hIn, `Height must be between ${LIMITS.minSize} and ${LIMITS.maxSize} pt.`);
    error.textContent = '';
    return true;
  };

  const v = await openDialog({
    title: 'Document Setup',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, validate, value: read },
    ],
  });
  if (editArtboards) {
    app.setTool('artboard');
    return false;
  }
  if (!v) return false;
  const patch = documentSetupPatch(doc.root, v);
  if (!Object.keys(patch).length) return true;
  doc.transact('Document Setup', () => doc.updateRoot(patch));
  for (const view of app.views.values()) view.invalidate();
  return true;
}
