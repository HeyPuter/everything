/**
 * OpenType panel (Alt+Shift+Cmd+T): figure style, position, ligatures,
 * alternates, titling, ordinals, fractions and stylistic sets for the
 * current text. Each toggle previews its feature in the current font, and
 * features the font does not have are marked (they still apply, and take
 * effect if the text later uses a font that has them).
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { openMenu } from '../../ui/menubar.js';
import { applyCharStyle, currentCharStyle, currentTextNodes, MIXED } from './type-ops.js';
import { shapingFont, fontFeatures, ssTag } from './shaping.js';
import { quoteFamily } from '../../model/text-layout.js';

export const FIGURE_OPTIONS = [
  ['default', 'Default Figure'],
  ['tabular-lining', 'Tabular Lining'],
  ['proportional-lining', 'Proportional Lining'],
  ['proportional-oldstyle', 'Proportional Oldstyle'],
  ['tabular-oldstyle', 'Tabular Oldstyle'],
];

export const POSITION_OPTIONS = [
  ['default', 'Default Position'],
  ['sups', 'Superscript'],
  ['subs', 'Subscript'],
  ['numr', 'Numerator'],
  ['dnom', 'Denominator'],
];

/** Toggles: [attribute, label, sample text, feature tags that implement it, on-by-default]. */
export const OT_TOGGLES = [
  ['ligatures', 'Standard Ligatures', 'fi', ['liga'], true],
  ['contextual', 'Contextual Alternates', 'ct', ['calt', 'clig'], true],
  ['discretionary', 'Discretionary Ligatures', 'st', ['dlig'], false],
  ['swash', 'Swash', 'Q', ['swsh'], false],
  ['stylistic', 'Stylistic Alternates', 'a', ['salt'], false],
  ['titling', 'Titling Alternates', 'T', ['titl'], false],
  ['ordinals', 'Ordinals', '1st', ['ordn'], false],
  ['fractions', 'Fractions', '1/2', ['frac'], false],
];

const FIGURE_TAGS = { 'tabular-lining': ['tnum', 'lnum'], 'proportional-lining': ['pnum', 'lnum'], 'proportional-oldstyle': ['pnum', 'onum'], 'tabular-oldstyle': ['tnum', 'onum'] };

/**
 * Whether a font can show a figure style: it needs the spacing feature
 * (tnum/pnum, or no tnum for proportional) and, unless the style is the font's own default (oldstyle for
 * fonts that only offer lnum, lining otherwise), the figure-shape feature.
 */
export function figureAvailable(features, value) {
  if (value === 'default' || !FIGURE_TAGS[value]) return true;
  const [spacing, shape] = FIGURE_TAGS[value];
  const defaultShape = features.has('lnum') && !features.has('onum') ? 'onum' : 'lnum';
  // Fonts without spacing features have proportional figures.
  const spacingOk = features.has(spacing) || (spacing === 'pnum' && !features.has('tnum'));
  return spacingOk && (shape === defaultShape || features.has(shape));
}

/** CSS preview of a feature tag on a sample (the browser's own shaping of the same font). */
const previewCss = (tags) => tags.map((t) => `"${t}" 1`).join(', ');

export function buildOpenTypeControls(app) {
  const apply = (patch, label) => applyCharStyle(app, patch, { label });
  let cur = null;
  let features = null; // Set of tags in the current font, or null while unknown
  const figure = h(
    'select.select.ot-select',
    { 'aria-label': 'Figure style', onchange: () => apply({ figures: figure.value }, 'Figure Style') },
    FIGURE_OPTIONS.map(([v, l]) => h('option', { value: v }, l)),
  );
  const position = h(
    'select.select.ot-select',
    { 'aria-label': 'Position', onchange: () => apply({ otPosition: position.value }, 'OpenType Position') },
    POSITION_OPTIONS.map(([v, l]) => h('option', { value: v }, l)),
  );
  const toggles = OT_TOGGLES.map(([key, label, sample, tags, def]) => {
    const b = h(
      'button.ot-toggle',
      {
        type: 'button',
        'aria-label': label,
        'aria-pressed': 'false',
        'data-tip': label,
        'data-key': key,
        onclick: () => {
          const on = cur?.[key] === MIXED ? !def : cur?.[key] ?? def;
          apply({ [key]: !on }, label);
        },
      },
      h('span.ot-sample', { 'aria-hidden': 'true', style: `font-feature-settings: ${previewCss(tags)}` }, sample),
    );
    return { b, key, label, tags, def };
  });
  const setsBtn = h(
    'button.ot-toggle.ot-sets',
    { type: 'button', 'aria-label': 'Stylistic Sets', 'aria-haspopup': 'menu', 'data-tip': 'Stylistic Sets', onclick: () => openSets() },
    h('span.ot-sample', { 'aria-hidden': 'true' }, 'ss'),
    icon('chevron-down', 10),
  );
  const openSets = () => {
    const sets = Array.isArray(cur?.stylisticSets) ? cur.stylisticSets : [];
    const available = [];
    for (let n = 1; n <= 20; n++) if (!features || features.has(ssTag(n))) available.push(n);
    const items = available.map((n) => ({
      type: 'cmd',
      label: `Stylistic Set ${n}`,
      enabled: true,
      checked: sets.includes(n),
      run: () => {
        const next = sets.includes(n) ? sets.filter((s) => s !== n) : [...sets, n].sort((a, b) => a - b);
        apply({ stylisticSets: next.length ? next : null }, 'Stylistic Sets');
      },
    }));
    if (!items.length) items.push({ type: 'cmd', label: 'This font has no stylistic sets', enabled: false });
    if (sets.length) items.push({ type: 'sep' }, { type: 'cmd', label: 'Clear Stylistic Sets', enabled: true, run: () => apply({ stylisticSets: null }, 'Stylistic Sets') });
    const r = setsBtn.getBoundingClientRect();
    openMenu(app, items, { x: r.left, y: r.bottom + 2, anchor: setsBtn, label: 'Stylistic Sets' });
  };
  const row = h('div.ot-toggles', { role: 'group', 'aria-label': 'OpenType features' }, toggles.map((t) => t.b), setsBtn);
  const note = h('p.panel-note.ot-note', { role: 'status' });
  const el = h(
    'div.type-controls.ot-controls',
    h('div.ot-field', h('label.ot-label', 'Figure'), figure),
    h('div.ot-field', h('label.ot-label', 'Position'), position),
    row,
    note,
  );
  // Labels point at their selects.
  el.querySelectorAll('.ot-field').forEach((f, i) => {
    const sel = f.querySelector('select');
    sel.id = `ot-${i}-${Math.random().toString(36).slice(2, 7)}`;
    f.querySelector('label').htmlFor = sel.id;
  });

  const refresh = () => {
    cur = currentCharStyle(app);
    if (!cur) return;
    const fam = cur.fontFamily === MIXED ? null : cur.fontFamily;
    const font = fam ? shapingFont({ ...cur, fontWeight: cur.fontWeight === MIXED ? 400 : cur.fontWeight, fontStyle: cur.fontStyle === MIXED ? 'normal' : cur.fontStyle }) : null;
    features = font ? fontFeatures(font) : null;
    const famCss = fam ? `${quoteFamily(fam)}, var(--font-ui)` : '';
    figure.value = cur.figures === MIXED ? '' : cur.figures || 'default';
    position.value = cur.otPosition === MIXED ? '' : cur.otPosition || 'default';
    figure.classList.toggle('mixed', cur.figures === MIXED);
    position.classList.toggle('mixed', cur.otPosition === MIXED);
    for (const o of figure.options) o.disabled = Boolean(features && !figureAvailable(features, o.value));
    for (const o of position.options) o.disabled = Boolean(features && o.value !== 'default' && !features.has(o.value));
    const missing = [];
    for (const t of toggles) {
      const v = cur[t.key];
      t.b.setAttribute('aria-pressed', v === MIXED ? 'mixed' : String(v ?? t.def));
      const has = !features || t.tags.some((g) => features.has(g)) || (t.key === 'fractions' && features.has('numr'));
      t.b.classList.toggle('unavailable', !has);
      t.b.dataset.tip = has ? t.label : `${t.label} (not in this font)`;
      if (!has && (v === true || v === MIXED) && !t.def) missing.push(t.label);
      t.b.querySelector('.ot-sample').style.fontFamily = famCss;
    }
    const sets = Array.isArray(cur.stylisticSets) ? cur.stylisticSets : [];
    setsBtn.setAttribute('aria-pressed', cur.stylisticSets === MIXED ? 'mixed' : String(sets.length > 0));
    const anySets = !features || [...features].some((f) => /^ss\d\d$/.test(f));
    setsBtn.classList.toggle('unavailable', !anySets);
    for (const n of sets) if (features && !features.has(ssTag(n))) missing.push(`Stylistic Set ${n}`);
    if (cur.figures && cur.figures !== MIXED && features && !figureAvailable(features, cur.figures)) missing.push('the figure style');
    if (cur.otPosition && cur.otPosition !== 'default' && cur.otPosition !== MIXED && features && !features.has(cur.otPosition)) missing.push('the position');
    note.textContent = missing.length ? `${fam || 'This font'} has no ${missing.join(', ')}.` : features && !features.size ? `${fam} has no OpenType substitutions.` : '';
  };
  return { el, refresh };
}

export class OpenTypePanel extends Panel {
  static id = 'openType';
  static title = 'OpenType';
  static icon = 'opentype';
  static placement = 'strip';
  static shortcut = 'Alt+Shift+Mod+T';

  build() {
    this.controls = buildOpenTypeControls(this.app);
    this.hint = h('p.panel-note');
    this.el.append(this.controls.el, this.hint);
  }

  update() {
    const has = Boolean(this.app.editor);
    this.el.classList.toggle('disabled', !has);
    if (!has) {
      this.hint.textContent = 'Open a document to set type.';
      return;
    }
    this.controls.refresh();
    this.hint.textContent = currentTextNodes(this.app).length ? '' : 'Settings apply to new type.';
  }

  menu() {
    return openTypeMenu(this.app);
  }
}

/** Every OpenType setting as menu items: features, figure styles, positions and stylistic sets. */
export function openTypeMenu(app) {
  const cur = app.editor ? currentCharStyle(app) : null;
  const en = Boolean(cur);
  const apply = (patch, label) => applyCharStyle(app, patch, { label });
  const fam = cur && cur.fontFamily !== MIXED ? cur.fontFamily : null;
  const font = fam ? shapingFont({ ...cur, fontWeight: cur.fontWeight === MIXED ? 400 : cur.fontWeight, fontStyle: cur.fontStyle === MIXED ? 'normal' : cur.fontStyle }) : null;
  const features = font ? fontFeatures(font) : null;
  const toggles = OT_TOGGLES.map(([key, label, , , def]) => {
    const v = cur?.[key];
    const on = v === MIXED ? false : v ?? def;
    return { label, enabled: en, checked: on, run: () => apply({ [key]: !on }, label) };
  });
  const pick = (key, options, label) =>
    options.map(([v, l]) => ({ label: l, enabled: en && (!features || key !== 'figures' || figureAvailable(features, v)), checked: (cur?.[key] || 'default') === v, run: () => apply({ [key]: v }, label) }));
  const sets = Array.isArray(cur?.stylisticSets) ? cur.stylisticSets : [];
  const setItems = [];
  for (let n = 1; n <= 20; n++) {
    if (features && !features.has(ssTag(n)) && !sets.includes(n)) continue;
    setItems.push({
      label: `Set ${n}`,
      enabled: en,
      checked: sets.includes(n),
      run: () => {
        const next = sets.includes(n) ? sets.filter((x) => x !== n) : [...sets, n].sort((a, b) => a - b);
        apply({ stylisticSets: next.length ? next : null }, 'Stylistic Sets');
      },
    });
  }
  if (!setItems.length) setItems.push({ label: 'None in This Font', enabled: false, run() {} });
  if (sets.length) setItems.push('-', { label: 'Clear Stylistic Sets', enabled: en, run: () => apply({ stylisticSets: null }, 'Stylistic Sets') });
  const reset = Object.fromEntries(OT_TOGGLES.map(([key, , , , def]) => [key, def]));
  return [
    ...toggles,
    '-',
    { label: 'Figure', submenu: pick('figures', FIGURE_OPTIONS, 'Figure Style') },
    { label: 'Position', submenu: pick('otPosition', POSITION_OPTIONS, 'OpenType Position') },
    { label: 'Stylistic Sets', submenu: setItems },
    '-',
    { label: 'Reset OpenType Features', enabled: en, run: () => apply({ ...reset, figures: 'default', otPosition: 'default', stylisticSets: null }, 'Reset OpenType Features') },
  ];
}
