/**
 * Text tab for text and caption clips. The text box sits above three
 * sub-tabs:
 *  Basic    presets, font (with uploaded fonts), size, emphasis, case,
 *           fill (solid, gradient, two-tone; keyframable color), layout
 *           (alignment, box size, curve) and decorations (outlines,
 *           background, glow, shadow, depth, color split) each with an
 *           on/off switch and reset, then blend and transform
 *  Bubble   shapes drawn behind the text (text-bubble.js)
 *  Effects  word-art looks (text-effects.js)
 */
import '../../styles/text.css';
import { createElement, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd } from 'lucide';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { FONTS, TEXT_PRESETS } from '../../model/catalog.js';
import { DEFAULT_TEXT_STYLE } from '../../model/project.js';
import { allClips } from '../../model/timeline.js';
import { setKey, removeKey, keyIndexAt, valueAt } from '../../model/keyframes.js';
import { caseOf, COLOR_KEYS, hasColorKeys, hexToRgb, textColorAt } from '../../model/text-style.js';
import { rasterizeText } from '../../engine/text.js';
import { FONT_ACCEPT, importFontFile } from '../../media/fonts.js';
import { segmented, section, colorField } from '../controls.js';
import { toast } from '../dialog.js';
import { slider, color, pressButton, propSection, row, choiceGrid, tabSet, uidFor, keepFocus } from './common.js';
import { transformSection, blendSection } from './transform.js';
import { bubbleTab } from './text-bubble.js';
import { effectsTab } from './text-effects.js';
import { lookCanvas } from '../text-thumbs.js';
import { wordsOf, pickKeywords } from '../../model/text-marks.js';

const fontCss = (id) => FONTS.find((f) => f.id === id)?.css || `'${id.replace(/'/g, '')}', sans-serif`;

function styleSetter(view, label, key, map = (v) => v) {
  return (v, final) => view.edit(label, (c) => {
    c.style[key] = map(v);
  }, { key: `style-${key}`, final });
}

const DEF = DEFAULT_TEXT_STYLE;

/** Text box bound to clip.text; typing merges into one undo step per pause. */
function textBox(view) {
  const id = uidFor('text');
  const ta = h('textarea.textarea.insp-textarea', { id, rows: 3, spellcheck: true });
  ta.value = view.clip.text;
  ta.addEventListener('input', () => {
    view.edit('Edit text', (c) => {
      c.text = ta.value;
    }, { key: 'text', final: false });
  });
  ta.addEventListener('change', () => view.store.seal());
  ta.addEventListener('keydown', (e) => {
    // Typing must not trigger editor shortcuts (space plays, Delete removes the clip).
    e.stopPropagation();
    if (e.key === 'Escape') ta.blur();
  });
  const sync = () => {
    const c = view.clip;
    if (c && document.activeElement !== ta && ta.value !== c.text) ta.value = c.text;
  };
  return { el: ta, id, sync };
}

/**
 * Highlight words: every word of the text as a toggle chip; pressed words
 * are drawn in the highlight color (clip.marks, model/text-marks.js).
 */
function highlightSection(view) {
  const chips = h('div.mark-chips', { role: 'group', 'aria-label': 'Words to highlight' });
  const setMarks = (label, fn) => view.edit(label, (c) => {
    const next = fn(c);
    if (next.length) c.marks = next;
    else if (c.marks) delete c.marks;
    else return false;
  });
  const pick = h('button.btn.small', { type: 'button' }, icon('highlighter', 14), 'Pick key words');
  pick.addEventListener('click', () => {
    setMarks('Highlight key words', (c) => pickKeywords(c.text));
    announce('Key words highlighted');
  });
  const clear = h('button.btn.small.ghost', { type: 'button' }, 'Clear');
  clear.addEventListener('click', () => setMarks('Clear highlights', () => []));
  const tint = color(view, {
    label: 'Highlight color',
    get: (c) => c.style.highlightColor,
    set: styleSetter(view, 'Highlight color', 'highlightColor'),
  });
  let sig = '';
  const sync = () => {
    const c = view.clip;
    if (!c) return;
    const words = wordsOf(c.text);
    const marks = new Set(c.marks || []);
    const next = `${c.text}|${[...marks].join(',')}`;
    clear.disabled = !marks.size;
    if (next === sig) return;
    sig = next;
    const shown = words.slice(0, 120);
    chips.replaceChildren(...shown.map((w, i) => {
      const b = h('button.mark-chip', { type: 'button', 'aria-pressed': String(marks.has(i)) }, w);
      b.addEventListener('click', () => keepFocus(() => {
        setMarks(marks.has(i) ? 'Remove highlight' : 'Highlight word', (x) => {
          const m = new Set(x.marks || []);
          if (m.has(i)) m.delete(i);
          else m.add(i);
          return [...m].sort((a, z) => a - z);
        });
      }, () => chips.children[i]));
      return b;
    }));
  };
  sync();
  view.bind(sync);
  return propSection('Highlight words', [chips, h('div.mark-actions', pick, clear), tint.el], {
    open: Boolean(view.clip.marks?.length || view.clip.caption),
    onReset: () => setMarks('Clear highlights', () => []),
  });
}

/** Preview chip for a text preset, drawn by the text renderer. */
function presetSample(preset) {
  return lookCanvas({ text: 'Aa', style: { ...preset.style, size: 64, boxWidth: 0, boxHeight: 0, arc: 0 } }, 104, 104, { className: 'preset-canvas', bg: null, maxScale: 0.9 });
}

function presetsRow(view) {
  const grid = choiceGrid({
    label: 'Style presets',
    className: 'preset-grid',
    items: TEXT_PRESETS.map((p) => ({ id: p.id, label: p.label, preview: presetSample(p) })),
    value: view.clip.preset || null,
    onPick: (id) => {
      const p = TEXT_PRESETS.find((x) => x.id === id);
      view.edit('Text style', (c) => {
        c.style = { ...DEFAULT_TEXT_STYLE, ...p.style };
        c.preset = p.id;
      });
      announce(`${p.label} style applied`);
    },
  });
  view.bind(() => grid.set(view.clip?.preset || null));
  return grid.el;
}

/** Fonts for the picker: bundled ones, then the project's uploaded fonts. */
function fontList(project) {
  const own = (project?.fonts || []).map((f) => ({ id: f.family, label: f.name, css: `'${f.family}', sans-serif`, own: true }));
  return [...FONTS, ...own];
}

/** Ask for a font file, store it with the project and use it for this clip. */
export function uploadFont(view, file) {
  const library = view.ctx.library;
  if (!library) return Promise.resolve(null);
  return importFontFile(library, file, view.project.fonts || []).then((entry) => {
    view.store.update(`Add font ${entry.name}`, (p) => {
      p.fonts = [...(p.fonts || []).filter((f) => f.family !== entry.family), entry];
      const c = allClips(p).find((x) => x.id === view.id);
      if (c?.style) c.style.font = entry.family;
    }, { structural: false });
    announce(`Font ${entry.name} added`);
    return entry;
  }, (err) => {
    toast(err?.message || "Couldn't add this font.", { kind: 'error' });
    return null;
  });
}

/** Listbox font picker; each font is shown in its own face. */
export function fontPicker(view) {
  const id = uidFor('font');
  const labelId = `${id}-label`;
  const current = h('span.font-current');
  const btn = h('button.select.font-button', { type: 'button', id, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-labelledby': `${labelId} ${id}` }, current);
  const list = h('ul.font-list', { role: 'listbox', id: `${id}-list`, tabindex: '-1', 'aria-labelledby': labelId, hidden: true });
  const file = h('input', { type: 'file', accept: FONT_ACCEPT, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const upload = h('button.icon-btn.font-upload', { type: 'button', 'aria-label': 'Upload font', 'data-tip': 'Upload font (TTF, OTF, WOFF)' }, icon('upload', 16));
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) uploadFont(view, f);
  });
  let fonts = [];
  let opts = [];
  let sigFonts = '';
  const build = () => {
    fonts = fontList(view.project);
    sigFonts = fonts.map((f) => f.id).join('|');
    opts = fonts.map((f, i) => {
      const li = h('li.font-option', { role: 'option', id: `${id}-o${i}`, 'aria-selected': 'false', dataset: { font: f.id }, style: { fontFamily: f.css } }, f.label);
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(f.id));
      return li;
    });
    const firstOwn = fonts.findIndex((f) => f.own);
    const items = [...opts];
    if (firstOwn >= 0) items.splice(firstOwn, 0, h('li.font-group', { role: 'presentation' }, 'Your fonts'));
    list.replaceChildren(...items);
  };
  build();
  let active = 0;
  const value = () => view.clip?.style.font || DEFAULT_TEXT_STYLE.font;
  const labelOf = (f) => fonts.find((x) => x.id === f)?.label || f;
  const paint = () => {
    const nextSig = fontList(view.project).map((f) => f.id).join('|');
    if (nextSig !== sigFonts) build();
    const f = value();
    current.textContent = labelOf(f);
    current.style.fontFamily = fontCss(f);
    opts.forEach((o) => o.setAttribute('aria-selected', String(o.dataset.font === f)));
  };
  const setActive = (i) => {
    active = Math.max(0, Math.min(opts.length - 1, i));
    opts.forEach((o, j) => o.classList.toggle('active', j === active));
    list.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, fonts.findIndex((f) => f.id === value())));
    list.focus();
  };
  const close = (refocus = true) => {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  const choose = (font) => {
    close();
    if (font === value()) return;
    view.edit('Change font', (c) => {
      c.style.font = font;
    });
    announce(`Font ${labelOf(font)}`);
  };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  let typed = '';
  let typedAt = 0;
  list.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(opts.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(opts[active].dataset.font);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      close(false);
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = performance.now();
      typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const i = fonts.findIndex((f) => f.label.toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i);
    } else return;
    e.preventDefault();
  });
  list.addEventListener('focusout', (e) => {
    if (!list.contains(e.relatedTarget) && e.relatedTarget !== btn) close(false);
  });
  paint();
  view.bind(paint);
  return h('div.field.insp-row.font-field', h('span.field-label', { id: labelId }, 'Font'), h('div.insp-row-control.font-wrap', btn, list, upload, file));
}

/**
 * Section whose header switch turns a text decoration on or off, with a
 * reset that puts its settings back to the defaults.
 */
function toggledSection(view, title, { isOn, turnOn, turnOff, keys }, children) {
  const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-label': `Show ${title.toLowerCase()}`, 'aria-checked': String(isOn(view.clip)) });
  sw.addEventListener('click', () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    view.edit(on ? `Add ${title.toLowerCase()}` : `Remove ${title.toLowerCase()}`, (c) => (on ? turnOn(c.style) : turnOff(c.style)));
    announce(`${title} ${on ? 'on' : 'off'}`);
  });
  const reset = h('button.icon-btn.small.section-reset', { type: 'button', 'aria-label': `Reset ${title.toLowerCase()}`, 'data-tip': 'Reset' }, icon('rotateLeft', 14));
  reset.addEventListener('click', () => {
    const was = isOn(view.clip);
    view.edit(`Reset ${title.toLowerCase()}`, (c) => {
      for (const k of keys) c.style[k] = DEF[k];
      if (was) turnOn(c.style);
    });
    announce(`${title} reset`);
  });
  const body = h('div.toggled-body', children);
  const sec = section(title, body, { open: isOn(view.clip), actions: h('div.section-actions', reset, sw) });
  const paint = () => {
    const c = view.clip;
    if (!c) return;
    const on = isOn(c);
    sw.setAttribute('aria-checked', String(on));
    body.classList.toggle('is-off', !on);
  };
  paint();
  view.bind(paint);
  return sec;
}

// Remembers per clip what a decoration looked like before it was switched off.
const lastOn = new Map();
function memo(id) {
  let m = lastOn.get(id);
  if (!m) lastOn.set(id, (m = {}));
  return m;
}

/** Segmented control with lucide icons or text labels and accessible names. */
function choiceRow(view, { label, options, get, set }) {
  const seg = segmented({
    label,
    iconOnly: options.every((o) => o.svg),
    options: options.map((o) => ({ value: o.value, label: o.label })),
    value: get(view.clip),
    onChange: (v) => set(v),
  });
  seg.el.querySelectorAll('button').forEach((b, i) => {
    const o = options[i];
    b.setAttribute('aria-label', o.label);
    b.setAttribute('data-tip', o.label);
    if (o.svg) {
      const el = createElement(o.svg);
      el.setAttribute('width', 15);
      el.setAttribute('height', 15);
      el.setAttribute('aria-hidden', 'true');
      el.classList.add('icon');
      b.replaceChildren(el);
    } else if (o.short) b.replaceChildren(h('span.seg-short', { 'aria-hidden': 'true' }, o.short));
  });
  view.bind(() => view.clip && seg.set(get(view.clip)));
  return seg;
}

/**
 * Text color with keyframes: the three channels are keyed together, so the
 * color fades between keys. Without keys the style color changes.
 */
function textColorField(view) {
  const current = (c) => textColorAt(c, view.local()) || c.style.color;
  const field = colorField({
    label: 'Color',
    value: current(view.clip),
    onInput: (v, final) => {
      view.edit('Text color', (c) => {
        if (hasColorKeys(c)) {
          const rgb = hexToRgb(v);
          const local = Math.round(view.store.time - c.start);
          if (local < 0 || local > c.duration) return false;
          COLOR_KEYS.forEach((k, i) => setKey(c.keyframes, k, local, rgb[i], 'linear', view.tol()));
        } else c.style.color = v;
      }, { key: 'style-color', final });
    },
  });
  const kfBtn = h('button.icon-btn.small.kf-btn', { type: 'button', 'aria-pressed': 'false' }, icon('keyframe', 14));
  const prev = h('button.icon-btn.small.kf-nav', { type: 'button', 'aria-label': 'Previous color keyframe', 'data-tip': 'Previous keyframe' }, icon('chevronLeft', 12));
  const next = h('button.icon-btn.small.kf-nav', { type: 'button', 'aria-label': 'Next color keyframe', 'data-tip': 'Next keyframe' }, icon('chevronRight', 12));
  prev.addEventListener('click', () => view.jumpKey(COLOR_KEYS[0], -1));
  next.addEventListener('click', () => view.jumpKey(COLOR_KEYS[0], 1));
  kfBtn.addEventListener('click', () => {
    const c = view.clip;
    const local = Math.round(view.store.time - c.start);
    if (local < 0 || local > c.duration) {
      toast('Move the playhead over the clip to add a keyframe.', { kind: 'info' });
      return;
    }
    const has = keyIndexAt(c.keyframes, COLOR_KEYS[0], local, view.tol()) >= 0;
    view.edit(has ? 'Remove keyframe' : 'Add keyframe', (clip) => {
      const base = hexToRgb(clip.style.color);
      // The color the removed key showed, kept when it was the last one.
      const keyed = has ? textColorAt(clip, local) : null;
      COLOR_KEYS.forEach((k, i) => {
        if (has) removeKey(clip.keyframes, k, local, view.tol());
        else setKey(clip.keyframes, k, local, valueAt(clip.keyframes, k, local, base[i]), 'linear', view.tol());
      });
      // The last key gone: the color at that moment becomes the base color.
      if (has && !hasColorKeys(clip) && keyed) clip.style.color = keyed;
    });
    announce(has ? 'Keyframe removed' : 'Keyframe added');
  });
  field.el.querySelector('.color-row').append(h('div.kf-group', prev, kfBtn, next));
  let last = null;
  view.bind(() => {
    const c = view.clip;
    if (!c) return;
    const v = current(c);
    if (v !== last) {
      last = v;
      field.set(v);
    }
    const st = view.keyState(COLOR_KEYS[0]);
    kfBtn.setAttribute('aria-pressed', String(st === 'on'));
    kfBtn.classList.toggle('has-keys', st !== 'none');
    kfBtn.setAttribute('aria-label', st === 'on' ? 'Remove color keyframe' : 'Add keyframe for color');
    kfBtn.setAttribute('data-tip', st === 'on' ? 'Remove keyframe' : 'Add keyframe');
  }, { time: true });
  return field;
}

/** Size of the text as drawn now, in project pixels (for switching to a fixed box). */
function measuredWidth(clip) {
  try {
    return Math.round(rasterizeText({ ...clip, style: { ...clip.style, boxWidth: 0, arc: 0 } }, 1, 1, true).projW);
  } catch {
    return 600;
  }
}

function basicPanel(view) {
  const c = view.clip;
  const mem = memo(view.id);
  const size = slider(view, {
    label: 'Size',
    min: 4,
    max: 300,
    hardMax: 600,
    get: (x) => Math.round(x.style.size),
    set: styleSetter(view, 'Text size', 'size'),
  });
  const emphasis = h('div.insp-tools', { role: 'group', 'aria-label': 'Text emphasis' },
    pressButton(view, { label: 'Bold', iconName: 'bold', get: (x) => x.style.bold, set: (v) => styleSetter(view, 'Bold', 'bold')(v, true) }),
    pressButton(view, { label: 'Italic', iconName: 'italic', get: (x) => x.style.italic, set: (v) => styleSetter(view, 'Italic', 'italic')(v, true) }),
    pressButton(view, { label: 'Underline', iconName: 'underline', get: (x) => x.style.underline, set: (v) => styleSetter(view, 'Underline', 'underline')(v, true) }),
  );
  const caseSeg = choiceRow(view, {
    label: 'Case',
    options: [
      { value: 'none', label: 'As typed', short: 'Aa' },
      { value: 'upper', label: 'Uppercase', short: 'AB' },
      { value: 'lower', label: 'Lowercase', short: 'ab' },
      { value: 'title', label: 'Title case', short: 'Ab' },
    ],
    get: (x) => caseOf(x.style),
    set: (v) => view.edit('Text case', (x) => {
      x.style.case = v;
      delete x.style.uppercase;
    }),
  });

  // Fill
  const fillType = choiceRow(view, {
    label: 'Fill',
    options: [
      { value: 'solid', label: 'Solid', short: 'Solid' },
      { value: 'linear', label: 'Gradient', short: 'Gradient' },
      { value: 'split', label: 'Two-tone split', short: 'Split' },
    ],
    get: (x) => x.style.fillType || 'solid',
    set: (v) => view.edit('Fill type', (x) => {
      // Leaving a solid fill: the gradient starts from the current color.
      if (v !== 'solid' && x.style.fillType === 'solid') x.style.grad1 = x.style.color;
      x.style.fillType = v;
    }),
  });
  const solid = textColorField(view);
  const g1 = color(view, { label: 'Color 1', get: (x) => x.style.grad1, set: styleSetter(view, 'Gradient color', 'grad1') });
  const g2 = color(view, { label: 'Color 2', get: (x) => x.style.grad2, set: styleSetter(view, 'Gradient color', 'grad2') });
  const g3 = color(view, { label: 'Color 3', get: (x) => x.style.grad3 || x.style.grad2, set: styleSetter(view, 'Gradient color', 'grad3') });
  const third = pressButton(view, {
    label: 'Third color',
    iconName: 'plus',
    get: (x) => Boolean(x.style.grad3),
    set: (v) => view.edit(v ? 'Add gradient color' : 'Remove gradient color', (x) => {
      x.style.grad3 = v ? x.style.grad2 : '';
    }),
  });
  const angle = slider(view, { label: 'Angle', min: -180, max: 180, hardMin: -360, hardMax: 360, unit: '°', get: (x) => Math.round(x.style.gradAngle), set: styleSetter(view, 'Gradient angle', 'gradAngle') });
  const fillOpacity = slider(view, { label: 'Fill opacity', min: 0, max: 100, unit: '%', get: (x) => Math.round((x.style.fillOpacity ?? 1) * 100), set: styleSetter(view, 'Fill opacity', 'fillOpacity', (v) => v / 100) });
  const thirdRow = row('Colors', third);
  view.bind(() => {
    const x = view.clip;
    if (!x) return;
    const grad = x.style.fillType === 'linear' || x.style.fillType === 'split';
    solid.el.hidden = grad;
    g1.el.hidden = !grad;
    g2.el.hidden = !grad;
    g3.el.hidden = !(x.style.fillType === 'linear' && x.style.grad3);
    thirdRow.hidden = x.style.fillType !== 'linear';
    angle.el.hidden = !grad;
  });

  // Layout
  const align = choiceRow(view, {
    label: 'Alignment',
    options: [
      { value: 'left', label: 'Align left' },
      { value: 'center', label: 'Align center' },
      { value: 'right', label: 'Align right' },
    ],
    get: (x) => x.style.align,
    set: (v) => styleSetter(view, 'Text alignment', 'align')(v, true),
  });
  // Plain icons from the shared set for horizontal alignment.
  align.el.querySelectorAll('button').forEach((b, i) => b.replaceChildren(icon(['alignLeft', 'alignCenter', 'alignRight'][i], 15)));
  const vAlign = choiceRow(view, {
    label: 'Vertical alignment',
    options: [
      { value: 'top', label: 'Top of box', svg: AlignVerticalJustifyStart },
      { value: 'middle', label: 'Middle of box', svg: AlignVerticalJustifyCenter },
      { value: 'bottom', label: 'Bottom of box', svg: AlignVerticalJustifyEnd },
    ],
    get: (x) => x.style.vAlign || 'middle',
    set: (v) => styleSetter(view, 'Vertical alignment', 'vAlign')(v, true),
  });
  const spacing = slider(view, {
    label: 'Letter spacing',
    min: -20,
    max: 100,
    hardMin: -50,
    hardMax: 200,
    get: (x) => Math.round(x.style.letterSpacing),
    set: styleSetter(view, 'Letter spacing', 'letterSpacing'),
  });
  const lineHeight = slider(view, {
    label: 'Line height',
    min: 0.5,
    max: 3,
    step: 0.05,
    decimals: 2,
    hardMax: 4,
    get: (x) => Math.round(x.style.lineHeight * 100) / 100,
    set: styleSetter(view, 'Line height', 'lineHeight'),
  });
  const boxMode = choiceRow(view, {
    label: 'Text box',
    options: [
      { value: 'auto', label: 'Fit the text', short: 'Auto' },
      { value: 'fixed', label: 'Fixed width, wrap lines', short: 'Wrap' },
    ],
    get: (x) => (x.style.boxWidth > 0 ? 'fixed' : 'auto'),
    set: (v) => view.edit(v === 'fixed' ? 'Wrap text' : 'Auto size text', (x) => {
      if (v === 'fixed') x.style.boxWidth = x.style.boxWidth || Math.max(100, Math.min(4000, measuredWidth(x)));
      else {
        x.style.boxWidth = 0;
        x.style.boxHeight = 0;
      }
    }),
  });
  const boxW = slider(view, { label: 'Box width', min: 50, max: 3000, hardMax: 8000, unit: 'px', get: (x) => Math.round(x.style.boxWidth), set: styleSetter(view, 'Box width', 'boxWidth', (v) => Math.max(1, Math.round(v))) });
  const boxH = slider(view, { label: 'Box height', min: 0, max: 2000, hardMax: 8000, unit: 'px', get: (x) => Math.round(x.style.boxHeight), set: styleSetter(view, 'Box height', 'boxHeight', (v) => Math.max(0, Math.round(v))) });
  const vRow = row('Vertical', vAlign.el);
  view.bind(() => {
    const x = view.clip;
    if (!x) return;
    const fixed = x.style.boxWidth > 0;
    boxW.el.hidden = !fixed;
    boxH.el.hidden = !fixed;
    vRow.hidden = !(fixed && x.style.boxHeight > 0);
  });
  const curve = slider(view, { label: 'Curve', min: -100, max: 100, get: (x) => Math.round(x.style.arc || 0), set: styleSetter(view, 'Curve text', 'arc') });

  let captionAll = null;
  if (c.caption) {
    const b = h('button.btn.small.block', { type: 'button' }, icon('captions', 14), 'Apply style to all captions');
    b.addEventListener('click', () => {
      const style = structuredClone(view.clip.style);
      let n = 0;
      view.store.update('Apply caption style', (p) => {
        for (const x of allClips(p)) {
          if (x.type === 'text' && x.caption && x.id !== view.id) {
            x.style = structuredClone(style);
            n++;
          }
        }
        return n > 0;
      }, { structural: false });
      announce(n ? `Style applied to ${n} captions` : 'No other captions');
    });
    captionAll = b;
  }

  const basic = propSection('Basic', [
    fontPicker(view),
    size.el,
    row('Style', emphasis),
    row('Case', caseSeg.el),
    captionAll,
  ], {
    onReset: () => view.edit('Reset text style', (x) => {
      const preset = TEXT_PRESETS.find((p) => p.id === x.preset);
      x.style = { ...DEFAULT_TEXT_STYLE, ...(preset?.style || {}) };
      for (const k of COLOR_KEYS) delete x.keyframes[k];
    }),
  });
  const fill = propSection('Fill', [row('Type', fillType.el), solid.el, g1.el, g2.el, thirdRow, g3.el, angle.el, fillOpacity.el], {
    onReset: () => view.edit('Reset fill', (x) => {
      for (const k of ['fillType', 'fillOpacity', 'grad1', 'grad2', 'grad3', 'gradAngle']) x.style[k] = DEF[k];
    }),
  });
  const layout = propSection('Layout', [row('Align', align.el), spacing.el, lineHeight.el, row('Box', boxMode.el), boxW.el, boxH.el, vRow, curve.el], {
    onReset: () => view.edit('Reset layout', (x) => {
      for (const k of ['align', 'vAlign', 'letterSpacing', 'lineHeight', 'boxWidth', 'boxHeight', 'arc']) x.style[k] = DEF[k];
    }),
  });

  const stroke = toggledSection(view, 'Stroke', {
    keys: ['strokeColor', 'strokeWidth'],
    isOn: (x) => x.style.strokeWidth > 0,
    turnOn: (s) => (s.strokeWidth = mem.strokeWidth || 4),
    turnOff: (s) => {
      mem.strokeWidth = s.strokeWidth;
      s.strokeWidth = 0;
    },
  }, [
    color(view, { label: 'Stroke color', get: (x) => x.style.strokeColor, set: styleSetter(view, 'Stroke color', 'strokeColor') }).el,
    slider(view, { label: 'Width', min: 0, max: 40, get: (x) => Math.round(x.style.strokeWidth), set: styleSetter(view, 'Stroke width', 'strokeWidth') }).el,
  ]);
  const stroke2 = toggledSection(view, 'Outer stroke', {
    keys: ['stroke2Color', 'stroke2Width'],
    isOn: (x) => x.style.stroke2Width > 0,
    turnOn: (s) => (s.stroke2Width = mem.stroke2Width || 4),
    turnOff: (s) => {
      mem.stroke2Width = s.stroke2Width;
      s.stroke2Width = 0;
    },
  }, [
    color(view, { label: 'Outer color', get: (x) => x.style.stroke2Color, set: styleSetter(view, 'Outer stroke color', 'stroke2Color') }).el,
    slider(view, { label: 'Width', min: 0, max: 40, get: (x) => Math.round(x.style.stroke2Width), set: styleSetter(view, 'Outer stroke width', 'stroke2Width') }).el,
  ]);
  const background = toggledSection(view, 'Background', {
    keys: ['bgColor', 'bgOpacity', 'bgRadius'],
    isOn: (x) => x.style.bgOpacity > 0,
    turnOn: (s) => (s.bgOpacity = mem.bgOpacity || 1),
    turnOff: (s) => {
      mem.bgOpacity = s.bgOpacity;
      s.bgOpacity = 0;
    },
  }, [
    color(view, { label: 'Background color', get: (x) => x.style.bgColor, set: styleSetter(view, 'Background color', 'bgColor') }).el,
    slider(view, { label: 'Opacity', min: 0, max: 100, unit: '%', get: (x) => Math.round(x.style.bgOpacity * 100), set: styleSetter(view, 'Background opacity', 'bgOpacity', (v) => v / 100) }).el,
    slider(view, { label: 'Corner radius', min: 0, max: 100, hardMax: 200, get: (x) => Math.round(x.style.bgRadius), set: styleSetter(view, 'Corner radius', 'bgRadius') }).el,
  ]);
  const glow = toggledSection(view, 'Glow', {
    keys: ['glowColor', 'glowStrength', 'glowRadius'],
    isOn: (x) => x.style.glowStrength > 0,
    turnOn: (s) => (s.glowStrength = mem.glowStrength || 50),
    turnOff: (s) => {
      mem.glowStrength = s.glowStrength;
      s.glowStrength = 0;
    },
  }, [
    color(view, { label: 'Glow color', get: (x) => x.style.glowColor, set: styleSetter(view, 'Glow color', 'glowColor') }).el,
    slider(view, { label: 'Strength', min: 0, max: 100, get: (x) => Math.round(x.style.glowStrength), set: styleSetter(view, 'Glow strength', 'glowStrength') }).el,
    slider(view, { label: 'Radius', min: 0, max: 100, get: (x) => Math.round(x.style.glowRadius), set: styleSetter(view, 'Glow radius', 'glowRadius') }).el,
  ]);
  const shadow = toggledSection(view, 'Shadow', {
    keys: ['shadowColor', 'shadowOpacity', 'shadowBlur', 'shadowDistance', 'shadowAngle'],
    isOn: (x) => x.style.shadowOpacity > 0,
    turnOn: (s) => (s.shadowOpacity = mem.shadowOpacity || 0.6),
    turnOff: (s) => {
      mem.shadowOpacity = s.shadowOpacity;
      s.shadowOpacity = 0;
    },
  }, [
    color(view, { label: 'Shadow color', get: (x) => x.style.shadowColor, set: styleSetter(view, 'Shadow color', 'shadowColor') }).el,
    slider(view, { label: 'Opacity', min: 0, max: 100, unit: '%', get: (x) => Math.round(x.style.shadowOpacity * 100), set: styleSetter(view, 'Shadow opacity', 'shadowOpacity', (v) => v / 100) }).el,
    slider(view, { label: 'Blur', min: 0, max: 100, get: (x) => Math.round(x.style.shadowBlur), set: styleSetter(view, 'Shadow blur', 'shadowBlur') }).el,
    slider(view, { label: 'Distance', min: 0, max: 100, get: (x) => Math.round(x.style.shadowDistance), set: styleSetter(view, 'Shadow distance', 'shadowDistance') }).el,
    slider(view, { label: 'Angle', min: -180, max: 180, hardMin: -360, hardMax: 360, unit: '°', get: (x) => Math.round(((x.style.shadowAngle + 180) % 360 + 360) % 360 - 180), set: styleSetter(view, 'Shadow angle', 'shadowAngle') }).el,
  ]);
  const depth = toggledSection(view, '3D depth', {
    keys: ['extrudeColor', 'extrudeDepth', 'extrudeAngle'],
    isOn: (x) => x.style.extrudeDepth > 0,
    turnOn: (s) => (s.extrudeDepth = mem.extrudeDepth || 8),
    turnOff: (s) => {
      mem.extrudeDepth = s.extrudeDepth;
      s.extrudeDepth = 0;
    },
  }, [
    color(view, { label: 'Depth color', get: (x) => x.style.extrudeColor, set: styleSetter(view, 'Depth color', 'extrudeColor') }).el,
    slider(view, { label: 'Depth', min: 0, max: 60, get: (x) => Math.round(x.style.extrudeDepth), set: styleSetter(view, 'Depth', 'extrudeDepth') }).el,
    slider(view, { label: 'Angle', min: -180, max: 180, hardMin: -360, hardMax: 360, unit: '°', get: (x) => Math.round(((x.style.extrudeAngle + 180) % 360 + 360) % 360 - 180), set: styleSetter(view, 'Depth angle', 'extrudeAngle') }).el,
  ]);
  const split = toggledSection(view, 'Color split', {
    keys: ['glitch', 'glitchColorA', 'glitchColorB'],
    isOn: (x) => x.style.glitch > 0,
    turnOn: (s) => (s.glitch = mem.glitch || 4),
    turnOff: (s) => {
      mem.glitch = s.glitch;
      s.glitch = 0;
    },
  }, [
    slider(view, { label: 'Offset', min: 0, max: 40, get: (x) => Math.round(x.style.glitch), set: styleSetter(view, 'Color split', 'glitch') }).el,
    color(view, { label: 'Left color', get: (x) => x.style.glitchColorA, set: styleSetter(view, 'Split color', 'glitchColorA') }).el,
    color(view, { label: 'Right color', get: (x) => x.style.glitchColorB, set: styleSetter(view, 'Split color', 'glitchColorB') }).el,
  ]);

  return h('div.text-basic',
    propSection('Presets', presetsRow(view)),
    basic,
    highlightSection(view),
    fill,
    layout,
    stroke,
    stroke2,
    background,
    glow,
    shadow,
    depth,
    split,
    blendSection(view),
    transformSection(view),
  );
}

const SUBS = [
  { id: 'basic', label: 'Basic' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'effects', label: 'Word art' },
];

export function textTab(view, state = {}) {
  const box = textBox(view);
  const subs = tabSet({
    label: 'Text options',
    className: 'subtabs',
    items: SUBS,
    value: state.textSub || 'basic',
    onChange: (id) => {
      state.textSub = id;
      show(id);
    },
  });
  const show = (id) => {
    view.resetScope();
    view.bind(box.sync);
    subs.panel.replaceChildren(id === 'bubble' ? bubbleTab(view) : id === 'effects' ? effectsTab(view) : basicPanel(view));
  };
  show(subs.current);
  return h('div.text-tab',
    h('div.insp-block', h('label.sr-only', { for: box.id }, 'Text'), box.el),
    subs.list,
    subs.panel,
  );
}
