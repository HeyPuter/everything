import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { UNDERLINE_STYLES } from '../engine/underlines.js';
import { FALLBACK_SIZES } from '../lib/fontsize.js';
import { openTextColor } from './text-color.js';
import { fontChoices } from './font-picker.js';

const STYLES = [['regular', 'Regular'], ['italic', 'Italic'], ['bold', 'Bold'], ['boldItalic', 'Bold Italic']];
const SCALES = [200, 150, 100, 90, 80, 66, 50, 33];
const fontStyle = f => f.bold === null || f.italic === null ? '' : f.bold ? (f.italic ? 'boldItalic' : 'bold') : f.italic ? 'italic' : 'regular';
const swatch = color => !color || color === 'auto' ? '#000' : `#${color}`;

/**
 * The Font dialog: font, style, size, color, underline and effects on one tab; scale, spacing,
 * position and kerning on Advanced. Fields start from the selection; a mixed value stays blank or
 * indeterminate and only fields the user changes are applied, in one undo step.
 *
 * format: the selection's run formatting (null where mixed). apply(patch) returns false on failure.
 */
export function openFontDialog({ format: f, sample = '', apply, onClose, setDefault = null, textEffects = null, ligatures = false, title = 'Font' }) {
  const patch = {};
  const set = values => { Object.assign(patch, values); preview(); };
  const current = key => key in patch ? patch[key] : f[key];

  /* ---- Font tab ---- */
  const fontName = f.fontAscii === f.fontHAnsi ? f.fontAscii : '';
  const fonts = el('datalist', { id: 'ed-font-dialog-fonts' }, ...fontChoices().map(name => el('option', { value: name })));
  const font = el('input.input', { type: 'text', value: fontName || '', placeholder: fontName ? '' : 'Mixed', list: fonts.id, 'aria-label': 'Font', autocomplete: 'off',
    oninput: () => { const name = font.value.trim(); if (name) set({ fontAscii: name, fontHAnsi: name }); else { delete patch.fontAscii; delete patch.fontHAnsi; preview(); } } });
  const style = el('select.input', { 'aria-label': 'Font style', onchange: () => set({ bold: style.value.startsWith('bold'), italic: /italic/i.test(style.value) }) },
    ...(fontStyle(f) ? [] : [el('option', { value: '', disabled: true }, 'Mixed')]), ...STYLES.map(([value, label]) => el('option', { value }, label)));
  style.value = fontStyle(f);
  const sizes = el('datalist', { id: 'ed-font-dialog-sizes' }, ...FALLBACK_SIZES.map(size => el('option', { value: size })));
  const size = el('input.input', { type: 'number', min: 1, max: 1638, step: 0.5, value: f.fontSize ?? '', placeholder: f.fontSize == null ? 'Mixed' : '', list: sizes.id, 'aria-label': 'Size',
    oninput: () => { if (size.value && size.checkValidity()) set({ fontSize: Number(size.value), fontSizeCs: Number(size.value) }); } });
  const colorButton = (label, key) => {
    const chip = el('span.ed-font-chip');
    const button = el('button.btn.btn-outline.ed-font-color', { type: 'button', 'aria-label': label, 'aria-haspopup': 'true', onclick: () => {
      openTextColor(current(key), color => { set({ [key]: color }); paint(); }, { anchor: button });
    } }, chip, el('span.ed-font-color-name'));
    const paint = () => {
      const value = current(key);
      chip.style.background = value === null ? 'repeating-linear-gradient(45deg, #ccc 0 3px, #fff 3px 6px)' : swatch(value);
      button.lastChild.textContent = value === null ? 'Mixed' : value === 'auto' ? 'Automatic' : `#${value}`;
    };
    paint();
    return button;
  };
  const underline = el('select.input', { 'aria-label': 'Underline style', onchange: () => set({ underlineStyle: underline.value }) },
    ...(f.underlineStyle === null ? [el('option', { value: '', disabled: true }, 'Mixed')] : []),
    ...Object.entries(UNDERLINE_STYLES).map(([value, label]) => el('option', { value }, value === 'none' ? '(none)' : label)));
  underline.value = f.underlineStyle ?? '';

  // Effects: each pair shares one property, so checking one clears its partner.
  const effects = [];
  const effect = (label, key, on, partner) => {
    const box = el('input', { type: 'checkbox', onchange: () => {
      box.indeterminate = false;
      if (box.checked && partner) { const other = effects.find(e => e.label === partner); other.box.checked = false; other.box.indeterminate = false; }
      set({ [key]: box.checked ? on : key === 'verticalAlign' ? 'baseline' : key === 'capitalization' ? 'normal' : key === 'vanish' ? false : 'none' });
    } });
    if (f[key] === null) box.indeterminate = true; else box.checked = f[key] === on;
    effects.push({ label, box });
    return el('label.ed-check', {}, box, label);
  };
  const effectGrid = el('fieldset.ed-font-effects', {}, el('legend', {}, 'Effects'),
    effect('Strikethrough', 'strikethrough', 'single', 'Double strikethrough'), effect('Small caps', 'capitalization', 'smallCaps', 'All caps'),
    effect('Double strikethrough', 'strikethrough', 'double', 'Strikethrough'), effect('All caps', 'capitalization', 'caps', 'Small caps'),
    effect('Superscript', 'verticalAlign', 'superscript', 'Subscript'), effect('Hidden', 'vanish', true),
    effect('Subscript', 'verticalAlign', 'subscript', 'Superscript'));

  /* ---- Advanced tab ---- */
  const scales = el('datalist', { id: 'ed-font-dialog-scales' }, ...SCALES.map(n => el('option', { value: n })));
  const scale = el('input.input', { type: 'number', min: 1, max: 600, step: 1, value: f.textScale ?? '', placeholder: f.textScale == null ? 'Mixed' : '', list: scales.id, 'aria-label': 'Scale (%)',
    oninput: () => { if (scale.value && scale.checkValidity()) set({ textScale: Number(scale.value) }); } });
  const signed = (value, positive, negative) => value === null ? '' : value > 0 ? positive : value < 0 ? negative : 'normal';
  const amount = (label, value) => el('input.input', { type: 'number', min: 0, max: 1584, step: 0.05, value: value ? Math.abs(value) : '', placeholder: value === null ? 'Mixed' : '', 'aria-label': label });
  const spacing = el('select.input', { 'aria-label': 'Spacing' }, el('option', { value: '', disabled: true, hidden: f.characterSpacing !== null }, 'Mixed'),
    el('option', { value: 'normal' }, 'Normal'), el('option', { value: 'expanded' }, 'Expanded'), el('option', { value: 'condensed' }, 'Condensed'));
  spacing.value = signed(f.characterSpacing, 'expanded', 'condensed');
  const spacingBy = amount('Spacing by (pt)', f.characterSpacing);
  const applySpacing = () => {
    spacingBy.disabled = spacing.value === 'normal';
    if (spacing.value === 'normal') { spacingBy.value = ''; set({ characterSpacing: 0 }); return; }
    if (!spacing.value) return;
    const by = Number(spacingBy.value || 1);
    if (!spacingBy.value) spacingBy.value = '1';
    if (spacingBy.checkValidity()) set({ characterSpacing: spacing.value === 'condensed' ? -by : by });
  };
  spacing.addEventListener('change', applySpacing); spacingBy.addEventListener('input', applySpacing);
  spacingBy.disabled = spacing.value === 'normal';
  const position = el('select.input', { 'aria-label': 'Position' }, el('option', { value: '', disabled: true, hidden: f.baselineShift !== null }, 'Mixed'),
    el('option', { value: 'normal' }, 'Normal'), el('option', { value: 'raised' }, 'Raised'), el('option', { value: 'lowered' }, 'Lowered'));
  position.value = signed(f.baselineShift, 'raised', 'lowered');
  const positionBy = amount('Position by (pt)', f.baselineShift);
  positionBy.max = 200; positionBy.step = 0.5;
  const applyPosition = () => {
    positionBy.disabled = position.value === 'normal';
    if (position.value === 'normal') { positionBy.value = ''; set({ baselineShift: 0 }); return; }
    if (!position.value) return;
    if (!positionBy.value) positionBy.value = '3';
    if (positionBy.checkValidity()) set({ baselineShift: position.value === 'lowered' ? -Number(positionBy.value) : Number(positionBy.value) });
  };
  position.addEventListener('change', applyPosition); positionBy.addEventListener('input', applyPosition);
  positionBy.disabled = position.value === 'normal';
  const kern = el('input', { type: 'checkbox' });
  const kernFrom = el('input.input', { type: 'number', min: 0.5, max: 1638, step: 0.5, value: f.kerning || '', placeholder: f.kerning === null ? 'Mixed' : '', 'aria-label': 'Kerning from (pt)' });
  if (f.kerning === null) kern.indeterminate = true; else kern.checked = f.kerning > 0;
  kernFrom.disabled = !kern.checked;
  const applyKerning = () => {
    kern.indeterminate = false; kernFrom.disabled = !kern.checked;
    if (!kern.checked) { set({ kerning: 0 }); return; }
    if (!kernFrom.value) kernFrom.value = String(f.fontSize || 12);
    if (kernFrom.checkValidity()) set({ kerning: Number(kernFrom.value) });
  };
  kern.addEventListener('change', applyKerning); kernFrom.addEventListener('input', applyKerning);

  // Ligatures only where this document renders OpenType features (its compatibility settings allow them).
  const LIGATURES = [['none', 'None'], ['standard', 'Standard only'], ['standardContextual', 'Standard and contextual'], ['historicalDiscretional', 'Historical and discretionary'], ['all', 'All']];
  const ligatureSelect = el('select.input', { 'aria-label': 'Ligatures', onchange: () => set({ ligatures: ligatureSelect.value }) },
    ...(f.ligatures == null || !LIGATURES.some(([v]) => v === f.ligatures) ? [el('option', { value: '', disabled: true }, f.ligatures == null ? 'Mixed' : 'Custom')] : []), ...LIGATURES.map(([v, label]) => el('option', { value: v }, label)));
  ligatureSelect.value = LIGATURES.some(([v]) => v === f.ligatures) ? f.ligatures : '';

  /* ---- Preview ---- */
  const previewText = el('span', {}, (sample.replace(/\s+/g, ' ').trim().slice(0, 48)) || fontName || 'Aa Bb Cc');
  const previewBox = el('div.ed-font-preview', { 'aria-hidden': 'true' }, previewText);
  function preview() {
    const s = previewText.style, family = current('fontAscii');
    s.fontFamily = family ? `"${family}", system-ui, sans-serif` : '';
    s.fontWeight = current('bold') ? '700' : '400';
    s.fontStyle = current('italic') ? 'italic' : 'normal';
    s.fontSize = `${Math.min(28, Math.max(8, current('fontSize') || 12)) * 4 / 3}px`;
    const color = current('color');
    s.color = color && color !== 'auto' ? `#${color}` : '';
    const strike = current('strikethrough'), line = current('underlineStyle');
    s.textDecorationLine = [line && line !== 'none' ? 'underline' : '', strike && strike !== 'none' ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    s.textDecorationStyle = line === 'double' || strike === 'double' ? 'double' : /dot/i.test(line || '') ? 'dotted' : /dash/i.test(line || '') ? 'dashed' : /wav/i.test(line || '') ? 'wavy' : 'solid';
    const capitalization = current('capitalization');
    s.textTransform = capitalization === 'caps' ? 'uppercase' : '';
    s.fontVariantCaps = capitalization === 'smallCaps' ? 'small-caps' : '';
    const vertical = current('verticalAlign');
    s.verticalAlign = vertical === 'superscript' ? 'super' : vertical === 'subscript' ? 'sub' : '';
    s.letterSpacing = current('characterSpacing') ? `${current('characterSpacing') * 4 / 3}px` : '';
    s.display = 'inline-block';
    s.transform = current('textScale') && current('textScale') !== 100 ? `scaleX(${current('textScale') / 100})` : '';
    // Hidden text previews as it shows with formatting marks: dotted underline, dimmed.
    s.opacity = current('vanish') ? '0.55' : '';
    if (current('vanish') && s.textDecorationLine === 'none') { s.textDecorationLine = 'underline'; s.textDecorationStyle = 'dotted'; }
  }
  preview();

  /* ---- Tabs and actions ---- */
  const row = (label, control) => el('label.ed-font-field', {}, el('span.field-label', {}, label), control);
  const fontPanel = el('div.ed-font-panel', { role: 'tabpanel', id: 'ed-font-tab-font', 'aria-labelledby': 'ed-font-tab-font-button' },
    el('div.ed-font-grid', {}, row('Font', font), row('Font style', style), row('Size', size)),
    el('div.ed-font-grid', {}, row('Font color', colorButton('Font color', 'color')), row('Underline style', underline), row('Underline color', colorButton('Underline color', 'underlineColor'))),
    effectGrid, fonts, sizes);
  const advancedPanel = el('div.ed-font-panel', { role: 'tabpanel', id: 'ed-font-tab-advanced', 'aria-labelledby': 'ed-font-tab-advanced-button', hidden: true },
    el('fieldset.ed-font-advanced', {}, el('legend', {}, 'Character Spacing'),
      row('Scale (%)', scale),
      el('div.ed-font-pair', {}, row('Spacing', spacing), row('By (pt)', spacingBy)),
      el('div.ed-font-pair', {}, row('Position', position), row('By (pt)', positionBy)),
      el('div.ed-font-pair', {}, el('label.ed-check', {}, kern, 'Kerning for fonts:'), row('Points and above', kernFrom))),
    ligatures && el('fieldset.ed-font-advanced', {}, el('legend', {}, 'OpenType Features'), row('Ligatures', ligatureSelect)),
    scales);
  const tabs = [['font', 'Font', fontPanel], ['advanced', 'Advanced', advancedPanel]];
  const tabButtons = tabs.map(([id, label, panel], i) => el('button.ed-font-tab', { type: 'button', role: 'tab', id: `ed-font-tab-${id}-button`, 'aria-controls': panel.id, 'aria-selected': String(!i), tabindex: i ? -1 : 0,
    onclick: () => show(id), onkeydown: e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = tabs[(i + 1) % tabs.length][0]; show(next); tabButtons[(i + 1) % tabs.length].focus(); } } }, label));
  function show(id) {
    tabs.forEach(([tab, , panel], i) => { const on = tab === id; panel.hidden = !on; tabButtons[i].setAttribute('aria-selected', String(on)); tabButtons[i].tabIndex = on ? 0 : -1; });
  }
  const message = el('p.field-error', { role: 'alert', hidden: true });
  let modal;
  const form = el('form.ed-dialog-body.ed-font-dialog', { onsubmit: async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (Object.keys(patch).length) {
      let failure = null;
      const ok = await apply(patch, error => { failure = error; });
      if (ok === false) { message.textContent = failure?.message || 'This formatting cannot be applied to the selection.'; message.hidden = false; return; }
    }
    modal.close();
  } },
  el('div.ed-font-tabs', { role: 'tablist', 'aria-label': 'Font settings' }, ...tabButtons),
  fontPanel, advancedPanel,
  el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), previewBox),
  message,
  el('div.fmt-footer', {},
    el('div.fmt-footer-start', {},
      setDefault && el('button.btn.btn-ghost', { type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        let failure = null;
        const ok = await setDefault({ ...patch }, error => { failure = error; });
        if (ok === false) { if (failure) { message.textContent = failure.message; message.hidden = false; } return; }
        modal.close();
      } }, 'Set As Default'),
      textEffects && el('button.btn.btn-outline', { type: 'button', onclick: () => { modal.close(); textEffects(); } }, 'Text Effects…')),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))));
  modal = openModal({ title, content: form, wide: true, onClose });
  font.focus(); font.select();
  return modal;
}
