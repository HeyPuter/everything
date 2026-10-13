/**
 * Character (Cmd+T) and Paragraph (Alt+Cmd+T) panels, and the Character and
 * Paragraph sections of the Properties panel. They edit the current text:
 * selected characters while editing, the insertion point, the selected
 * type objects, or the defaults for new type.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { icon } from '../../ui/icons.js';
import { openMenu } from '../../ui/menubar.js';
import { parseLength, parseNumber, formatLength } from '../../lib/units.js';
import { createFontPicker } from './font-picker.js';
import { familyFaces, styleName, fontEvents } from './fonts.js';
import { applyCharStyle, applyParaStyle, currentCharStyle, currentParaStyle, currentTextNodes, session, MIXED } from './type-ops.js';
import { setFontFamily, SIZE_PRESETS } from './commands.js';
import { selectedTextNodes } from './outlines.js';
import { KERN_MODES } from './type-options.js';

let fieldId = 0;

/**
 * Compact numeric field with an icon label, an optional preset menu and an
 * optional "Auto" value (null). kind: 'pt' | 'percent' | 'number' | 'angle'.
 * `words` ([[token, label]]) are named values shown and typed as words.
 */
function typeField(app, { label, iconName, kind = 'pt', units = null, presets = null, auto = false, words = null, min = -Infinity, max = Infinity, step = 1, onCommit }) {
  // Lengths show in `units()` (the Type units preference for type sizes), points otherwise.
  const unit = () => (typeof units === 'function' && units()) || 'pt';
  const id = `tf-${++fieldId}`;
  const input = h('input.ty-input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': label });
  let value = null;
  let shownAuto = false;
  const word = (v) => words?.find(([t]) => t === v);
  const fmt = (v, isAuto) => {
    if (v === MIXED || v === undefined) return '';
    if (typeof v === 'string') return word(v)?.[1] ?? '';
    if (v == null) return auto ? 'Auto' : '';
    const n = Number(v.toFixed(kind === 'pt' ? 2 : 2));
    const txt = kind === 'pt' ? formatLength(v, unit()) : kind === 'percent' ? `${n}%` : kind === 'angle' ? `${n}\u00b0` : String(n);
    return isAuto ? `(${txt})` : txt;
  };
  const parse = (s) => {
    const t = s.trim().replace(/^\((.*)\)$/, '$1');
    const w = words?.find(([tok, l]) => t.toLowerCase() === l.toLowerCase() || t.toLowerCase() === tok);
    if (w) return w[0];
    if (auto && (!t || /^auto$/i.test(t))) return null;
    const v = kind === 'pt' ? parseLength(t, unit()) : parseNumber(t.replace(/[%\u00b0]/g, ''));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
  };
  const set = (v, { autoValue } = {}) => {
    value = v;
    shownAuto = auto && v == null && autoValue != null;
    if (document.activeElement !== input) input.value = shownAuto ? fmt(autoValue, true) : fmt(v);
    input.placeholder = v === MIXED ? 'Mixed' : '';
  };
  const commit = (v) => {
    if (v === undefined) {
      set(value);
      return;
    }
    value = v;
    onCommit(v);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(parse(input.value));
      input.select();
    } else if (e.key === 'Escape') {
      set(value);
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parse(input.value);
      const base = typeof cur === 'number' ? cur : typeof value === 'number' ? value : 0;
      const v = Math.min(max, Math.max(min, base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      input.value = fmt(v);
      commit(v);
    }
  });
  input.addEventListener('change', () => commit(parse(input.value)));
  input.addEventListener('focus', () => input.select());
  const lab = h('label.ty-label', { for: id, 'data-tip': label }, icon(iconName, 16));
  const parts = [lab, input];
  if (presets) {
    const menuBtn = h('button.ty-menu', { type: 'button', 'aria-label': `${label} presets`, 'aria-haspopup': 'menu' }, icon('chevron-down', 12));
    menuBtn.addEventListener('click', () => {
      const r = menuBtn.getBoundingClientRect();
      const items = presets.map((p) => (p === '-' ? { type: 'sep' } : { type: 'cmd', label: p == null ? 'Auto' : fmt(p), enabled: true, checked: p === value, run: () => commit(p) }));
      openMenu(app, items, { x: r.left - 60, y: r.bottom + 2, anchor: menuBtn, label: `${label} presets` });
    });
    parts.push(menuBtn);
  }
  return { el: h('div.ty-field', parts), set, input };
}

function toggleButton(iconName, label, onClick) {
  const b = h('button.icon-btn.ty-toggle', { type: 'button', 'aria-label': label, 'data-tip': label, 'aria-pressed': 'false', onclick: onClick }, icon(iconName, 16));
  return b;
}

const ALIGNS = [
  ['left', 'text-align-left', 'Align Left'],
  ['center', 'text-align-center', 'Align Center'],
  ['right', 'text-align-right', 'Align Right'],
  ['justify', 'justify-left', 'Justify with Last Line Aligned Left'],
  ['justify-center', 'justify-center', 'Justify with Last Line Aligned Center'],
  ['justify-right', 'justify-right', 'Justify with Last Line Aligned Right'],
  ['justify-all', 'justify-all', 'Justify All Lines'],
];

/** Character controls: family, style, size, leading, kerning, tracking, scales, shift, rotation, toggles. */
export function buildCharacterControls(app, { compact = false } = {}) {
  const coalesce = (k) => `char-${k}-${Date.now() >> 10}`;
  const apply = (patch, label, k) => applyCharStyle(app, patch, { label, coalesce: k ? coalesce(k) : null });
  const picker = createFontPicker(app, { label: 'Font family', onPick: (f) => setFontFamily(app, f) });
  const styleSel = h('select.select.ty-style', { 'aria-label': 'Font style' });
  styleSel.addEventListener('change', () => {
    const [w, s] = styleSel.value.split('|');
    apply({ fontWeight: Number(w), fontStyle: s }, 'Font Style');
  });
  const typeUnits = () => app.prefs.get('typeUnits');
  const size = typeField(app, { label: 'Font size', iconName: 'font-size', units: typeUnits, presets: SIZE_PRESETS, min: 0.1, max: 1296, onCommit: (v) => apply({ fontSize: v }, 'Font Size', 'size') });
  const leading = typeField(app, { label: 'Leading', iconName: 'leading', units: typeUnits, auto: true, presets: [null, ...SIZE_PRESETS], min: 0, max: 5000, onCommit: (v) => apply({ leading: v }, 'Leading', 'leading') });
  // Kerning: the automatic kerning mode (Auto, Optical, None) or manual kerning at the insertion point or on the selection.
  const kerning = typeField(app, {
    label: 'Kerning (between the characters at the insertion point)',
    iconName: 'kerning',
    kind: 'number',
    words: KERN_MODES,
    presets: [...KERN_MODES.map(([m]) => m), '-', 0, -100, -75, -50, -25, -10, -5, 5, 10, 25, 50, 75, 100, 200],
    min: -1000,
    max: 10000,
    step: 10,
    onCommit: (v) => (typeof v === 'string' ? applyCharStyle(app, { kernMode: v, kerning: 0 }, { label: 'Kerning' }) : kern(app, v)),
  });
  const tracking = typeField(app, { label: 'Tracking', iconName: 'tracking', kind: 'number', presets: [-100, -75, -50, -25, -10, -5, 0, 5, 10, 25, 50, 75, 100, 200], min: -1000, max: 10000, step: 10, onCommit: (v) => apply({ tracking: v }, 'Tracking', 'tracking') });
  const vscale = typeField(app, { label: 'Vertical scale', iconName: 'vertical-scale', kind: 'percent', presets: [50, 75, 100, 125, 150, 200], min: 1, max: 10000, onCommit: (v) => apply({ verticalScale: v }, 'Vertical Scale', 'vscale') });
  const hscale = typeField(app, { label: 'Horizontal scale', iconName: 'horizontal-scale', kind: 'percent', presets: [50, 75, 100, 125, 150, 200], min: 1, max: 10000, onCommit: (v) => apply({ horizontalScale: v }, 'Horizontal Scale', 'hscale') });
  const shift = typeField(app, { label: 'Baseline shift', iconName: 'baseline-shift', units: typeUnits, min: -5000, max: 5000, onCommit: (v) => apply({ baselineShift: v }, 'Baseline Shift', 'shift') });
  const rotation = typeField(app, { label: 'Character rotation', iconName: 'char-rotation', kind: 'angle', presets: [0, 15, 30, 45, 60, 90, 180, 270, -15, -30, -45, -90], min: -360, max: 360, onCommit: (v) => apply({ rotation: v }, 'Character Rotation', 'rotation') });
  const toggles = {
    caps: toggleButton('case-upper', 'All Caps', () => apply({ caps: cur?.caps === 'all' ? 'normal' : 'all' }, 'All Caps')),
    small: toggleButton('small-caps', 'Small Caps', () => apply({ caps: cur?.caps === 'small' ? 'normal' : 'small' }, 'Small Caps')),
    sup: toggleButton('superscript', 'Superscript', () => apply({ position: cur?.position === 'super' ? 'normal' : 'super' }, 'Superscript')),
    sub: toggleButton('subscript', 'Subscript', () => apply({ position: cur?.position === 'sub' ? 'normal' : 'sub' }, 'Subscript')),
    underline: toggleButton('underline', 'Underline', () => apply({ underline: cur?.underline !== true }, 'Underline')),
    strike: toggleButton('strikethrough', 'Strikethrough', () => apply({ strike: cur?.strike !== true }, 'Strikethrough')),
  };
  let cur = null;
  const toggleRow = h('div.ty-toggles', { role: 'group', 'aria-label': 'Character options' }, Object.values(toggles));
  // Rows marked ty-opt hide with the panel's Hide Options.
  const rows = compact
    ? [h('div.ty-row.full', picker.el), h('div.ty-row.full', styleSel), h('div.ty-row', size.el, leading.el), h('div.ty-row', kerning.el, tracking.el)]
    : [h('div.ty-row.full', picker.el), h('div.ty-row.full', styleSel), h('div.ty-row', size.el, leading.el), h('div.ty-row', kerning.el, tracking.el), h('div.ty-row.ty-opt', vscale.el, hscale.el), h('div.ty-row.ty-opt', shift.el, rotation.el), h('div.ty-opt', toggleRow)];
  const el = h('div.type-controls.char-controls', rows);
  let styleKey = '';
  const refresh = () => {
    cur = currentCharStyle(app);
    if (!cur) return;
    picker.set(cur.fontFamily);
    const fam = cur.fontFamily === MIXED ? null : cur.fontFamily;
    const faces = fam ? familyFaces(fam) : [];
    const curKey = cur.fontWeight === MIXED || cur.fontStyle === MIXED ? '' : `${cur.fontWeight}|${cur.fontStyle}`;
    const key = `${fam}:${faces.map((f) => `${f.weight}${f.style}`).join()}:${curKey}`;
    if (key !== styleKey) {
      styleKey = key;
      const opts = faces.map((f) => h('option', { value: `${f.weight}|${f.style}` }, styleName(f.weight, f.style)));
      if (curKey && !faces.some((f) => `${f.weight}|${f.style}` === curKey)) opts.push(h('option', { value: curKey }, styleName(cur.fontWeight, cur.fontStyle)));
      if (!curKey) opts.unshift(h('option', { value: '', disabled: true }, ''));
      styleSel.replaceChildren(...opts);
      styleSel.value = curKey;
    }
    size.set(cur.fontSize);
    leading.set(cur.leading, { autoValue: typeof cur.fontSize === 'number' ? cur.fontSize * 1.2 : null });
    const k = caretKerning(app, cur);
    // Without manual kerning the field shows the automatic kerning mode.
    kerning.set(k === 0 || k == null ? (cur.kernMode === MIXED ? MIXED : cur.kernMode || 'metrics') : k);
    tracking.set(cur.tracking);
    vscale.set(cur.verticalScale);
    hscale.set(cur.horizontalScale);
    shift.set(cur.baselineShift);
    rotation.set(cur.rotation);
    toggles.caps.setAttribute('aria-pressed', String(cur.caps === 'all'));
    toggles.small.setAttribute('aria-pressed', String(cur.caps === 'small'));
    toggles.sup.setAttribute('aria-pressed', String(cur.position === 'super'));
    toggles.sub.setAttribute('aria-pressed', String(cur.position === 'sub'));
    toggles.underline.setAttribute('aria-pressed', String(cur.underline === true));
    toggles.strike.setAttribute('aria-pressed', String(cur.strike === true));
  };
  return { el, refresh };
}

/** Kerning shown for the insertion point (the value on the character after the caret). */
function caretKerning(app, cur) {
  const s = session(app);
  if (!s) return cur.kerning;
  const n = s.node();
  const [a, b] = s.range();
  if (a !== b || !n || a >= n.text.length) return cur.kerning;
  return currentAt(n, a);
}

function currentAt(node, i) {
  let pos = 0;
  for (const r of node.runs || []) {
    if (i < pos + r.len) return r.kerning ?? node.char?.kerning ?? 0;
    pos += r.len;
  }
  return node.char?.kerning ?? 0;
}

/** Kerning at the insertion point (between two characters) or on the selected characters. */
function kern(app, v) {
  const s = session(app);
  if (s) {
    const [a, b] = s.range();
    if (a === b) {
      const n = s.node();
      if (!n || a >= n.text.length || a === 0) return;
      s.anchor = a;
      s.caret = a + 1;
      applyCharStyle(app, { kerning: v }, { label: 'Kerning' });
      s.anchor = s.caret = a;
      s.changed();
      return;
    }
  }
  applyCharStyle(app, { kerning: v }, { label: 'Kerning' });
}

/** Paragraph controls: alignment, indents, space before/after. */
export function buildParagraphControls(app, { compact = false } = {}) {
  const apply = (patch, label, k) => applyParaStyle(app, patch, { label, coalesce: k ? `para-${k}-${Date.now() >> 10}` : null });
  const group = h('div.ty-aligns', { role: 'radiogroup', 'aria-label': 'Alignment' });
  let curAlign = null;
  const buttons = ALIGNS.map(([value, ic, label], i) => {
    const b = h(
      'button.icon-btn.ty-align',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': label,
        'data-tip': label,
        tabindex: i === 0 ? '0' : '-1',
        onclick: () => apply({ align: value }, 'Paragraph Alignment'),
        onkeydown: (e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          const next = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + ALIGNS.length) % ALIGNS.length;
          buttons[next].focus();
          buttons[next].click();
        },
      },
      icon(ic, 16),
    );
    return b;
  });
  group.append(...buttons);
  const left = typeField(app, { label: 'Left indent', iconName: 'indent-left', min: -5000, max: 5000, onCommit: (v) => apply({ indentLeft: v }, 'Left Indent', 'il') });
  const right = typeField(app, { label: 'Right indent', iconName: 'indent-right', min: -5000, max: 5000, onCommit: (v) => apply({ indentRight: v }, 'Right Indent', 'ir') });
  const first = typeField(app, { label: 'First-line left indent', iconName: 'indent-first', min: -5000, max: 5000, onCommit: (v) => apply({ indentFirst: v }, 'First-Line Indent', 'if') });
  const before = typeField(app, { label: 'Space before paragraph', iconName: 'space-before', min: 0, max: 5000, onCommit: (v) => apply({ spaceBefore: v }, 'Space Before', 'sb') });
  const after = typeField(app, { label: 'Space after paragraph', iconName: 'space-after', min: 0, max: 5000, onCommit: (v) => apply({ spaceAfter: v }, 'Space After', 'sa') });
  // Lists and optical margins run the Type menu commands.
  const cmdToggle = (iconName, label, id) => toggleButton(iconName, label, () => app.commands.run(id));
  const listToggles = {
    'type.bullets': cmdToggle('list-bullets', 'Bullets', 'type.bullets'),
    'type.numbering': cmdToggle('list-numbers', 'Numbers', 'type.numbering'),
    'type.opticalMargin': cmdToggle('optical-margin', 'Optical Margin Alignment', 'type.opticalMargin'),
  };
  const listOpts = h('button.icon-btn.ty-toggle', { type: 'button', 'aria-label': 'Bullets and Numbering Options', 'data-tip': 'Bullets and Numbering Options', onclick: () => app.commands.run('type.listOptions') }, icon('sliders-horizontal', 16));
  const listRow = h('div.ty-toggles', { role: 'group', 'aria-label': 'Lists and margins' }, Object.values(listToggles), listOpts);
  const hyId = `ty-hy-${++fieldId}`;
  const hyBox = h('input', { type: 'checkbox', id: hyId, onchange: () => apply({ hyphenate: hyBox.checked }, 'Hyphenate') });
  const hyRow = h('div.ty-check', hyBox, h('label', { for: hyId }, 'Hyphenate'));
  const rows = compact
    ? [group, h('div.ty-row', left.el, right.el)]
    : [group, h('div.ty-row', left.el, right.el), h('div.ty-row', first.el, h('span')), h('div.ty-row.ty-opt', before.el, after.el), h('div.ty-opt', listRow), h('div.ty-opt', hyRow)];
  const el = h('div.type-controls.para-controls', rows);
  const refresh = () => {
    const p = currentParaStyle(app);
    if (!p) return;
    curAlign = p.align;
    buttons.forEach((b, i) => {
      const on = ALIGNS[i][0] === curAlign;
      b.setAttribute('aria-checked', String(on));
    });
    const sel = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    buttons.forEach((b, i) => (b.tabIndex = i === (sel >= 0 ? sel : 0) ? 0 : -1));
    left.set(p.indentLeft);
    right.set(p.indentRight);
    first.set(p.indentFirst);
    before.set(p.spaceBefore);
    after.set(p.spaceAfter);
    hyBox.checked = p.hyphenate === true;
    hyBox.indeterminate = p.hyphenate === MIXED;
    for (const [id, b] of Object.entries(listToggles)) {
      const cmd = app.commands.get(id);
      b.setAttribute('aria-pressed', String(Boolean(cmd?.checked?.(app))));
      b.disabled = !cmd;
    }
    listOpts.disabled = !app.commands.get('type.listOptions');
  };
  return { el, refresh };
}

export class CharacterPanel extends Panel {
  static id = 'character';
  static title = 'Character';
  static icon = 'type';
  static placement = 'strip';
  static shortcut = 'Mod+T';

  build() {
    this.controls = buildCharacterControls(this.app);
    this.note = h('p.panel-note');
    this.el.append(this.controls.el, this.note);
    syncOptions(this);
  }

  update() {
    if (!this.app.editor) {
      this.note.textContent = 'Open a document to set type.';
      return;
    }
    this.controls.refresh();
    this.note.textContent = currentTextNodes(this.app).length ? '' : 'Settings apply to new type.';
  }

  menu() {
    return [
      optionsItem(this),
      '-',
      'type.allCaps',
      'type.smallCaps',
      'type.superscript',
      'type.subscript',
      'type.underline',
      'type.strikethrough',
      '-',
      { label: 'Kerning', submenu: KERN_MODES.map(([m]) => `type.kern.${m}`) },
      'type.fractionalWidths',
      'type.noBreak',
      '-',
      'view.snapGlyph',
      { label: 'Character Edit Tool', enabled: Boolean(this.app.editor), run: (a) => a.setTool('character-edit') },
      '-',
      'type.character.reset',
    ];
  }
}

/** Show or hide a panel's optional rows (remembered per panel). */
function optionsShown(panel) {
  return panel.app.prefs.get(`${panel.id}Options`) !== false;
}

function syncOptions(panel) {
  panel.el.classList.toggle('ty-options-hidden', !optionsShown(panel));
}

function optionsItem(panel) {
  return {
    label: optionsShown(panel) ? 'Hide Options' : 'Show Options',
    run: () => {
      panel.app.prefs.set(`${panel.id}Options`, !optionsShown(panel));
      syncOptions(panel);
    },
  };
}

export class ParagraphPanel extends Panel {
  static id = 'paragraph';
  static title = 'Paragraph';
  static icon = 'pilcrow';
  static placement = 'strip';
  static shortcut = 'Alt+Mod+T';

  build() {
    this.controls = buildParagraphControls(this.app);
    this.note = h('p.panel-note');
    this.el.append(this.controls.el, this.note);
    syncOptions(this);
  }

  update() {
    if (!this.app.editor) return;
    this.controls.refresh();
    this.note.textContent = currentTextNodes(this.app).length ? '' : 'Settings apply to new type.';
  }

  menu() {
    return [
      optionsItem(this),
      '-',
      'type.hangingPunctuation',
      'type.opticalMargin',
      '-',
      'type.justification',
      'type.hyphenation',
      '-',
      'type.composer.single',
      'type.composer.every',
      '-',
      'type.paragraph.reset',
    ];
  }
}

const hasTextSelection = (app) => (ed) => Boolean(ed.textEdit) || selectedTextNodes(ed).length > 0;

export function installTypePanels(app) {
  app.registerPanel(CharacterPanel);
  app.registerPanel(ParagraphPanel);
  PropertiesPanel.extraSections.push(
    {
      id: 'character',
      title: 'Character',
      when: hasTextSelection(app),
      build: (a) => {
        const c = buildCharacterControls(a, { compact: true });
        const more = h('button.btn.small.ty-more', { type: 'button', onclick: () => a.openPanel('character') }, icon('ellipsis', 14), 'More Options');
        return { el: h('div', c.el, more), refresh: c.refresh };
      },
    },
    {
      id: 'paragraph',
      title: 'Paragraph',
      when: hasTextSelection(app),
      build: (a) => {
        const c = buildParagraphControls(a, { compact: true });
        const more = h('button.btn.small.ty-more', { type: 'button', onclick: () => a.openPanel('paragraph') }, icon('ellipsis', 14), 'More Options');
        return { el: h('div', c.el, more), refresh: c.refresh };
      },
    },
  );
  // Caret moves and font loads refresh the panels.
  app.on('text-selection', () => app.dock?.update());
  fontEvents.on('local', () => app.dock?.update());
}
