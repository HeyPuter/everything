/**
 * Design tab dialogs: Customize Colors, Customize Fonts, Custom Paragraph Spacing, Custom Watermark,
 * Fill Effects and More Colors. Each shows a live preview and applies through the callback it is given;
 * a callback that returns (or resolves to) false keeps the dialog open.
 */
import { el, fieldId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { segmented } from '../ui/segmented.js';
import { COLOR_SLOTS, COLOR_SLOT_LABELS, FONT_SCHEMES, WATERMARK_TEXTS } from '../engine/document-themes.js';
import { GRADIENT_STYLES, PATTERNS, TEXTURES, drawGradient, drawPattern, drawTexture } from './page-fill-effects.js';

/** Fonts the canvas can draw: bundled faces and their reviewed substitutes. */
export const DESIGN_FONTS = [...new Set([...FONT_SCHEMES.flatMap(s => [s.major, s.minor]), 'Noto Sans', 'Open Sans', 'Montserrat', 'Karla', 'Source Sans Pro', 'Oswald', 'Bebas Neue'])].sort((a, b) => a.localeCompare(b));
export const WATERMARK_PRESETS = ['CONFIDENTIAL', 'DO NOT COPY', 'DRAFT', 'SAMPLE', 'URGENT', 'ASAP'].flatMap(text => [{ text, layout: 'diagonal' }, { text, layout: 'horizontal' }]);
const LANGUAGES = [['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['es-ES', 'Spanish'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch']];
const fontStack = name => `"${name}", "Canvas Noto Sans", "Noto Sans", sans-serif`;
const hexOf = value => value.replace('#', '').toUpperCase();

function dialog({ title, body, submitLabel = 'Save', onSubmit, extra = [], wide = true }) {
  const error = el('p.field-error', { role: 'alert', hidden: true });
  let modal;
  const form = el('form.ed-dialog-body.design-dialog', { onsubmit: async e => {
    e.preventDefault();
    error.hidden = true;
    try {
      const result = await onSubmit();
      if (result === false) return;
      modal.close();
    } catch (failure) { error.textContent = failure?.message || String(failure); error.hidden = false; }
  } }, ...body, error,
  el('div.row.row-end', {}, ...extra, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, submitLabel)));
  modal = openModal({ title, content: form, wide });
  return { modal, form, error };
}
const field = (label, control, hint) => el('label.field', {}, el('span.field-label', {}, label), control, hint && el('span.field-hint', {}, hint));
const nameInput = value => el('input.input', { type: 'text', value, required: true, maxLength: 60, 'aria-label': 'Name' });

/** Customize Colors: the twelve theme colors, with a sample that follows them. */
export function openCustomizeColors({ colors, name, apply }) {
  const values = { ...colors };
  const sample = el('div.design-color-sample', { 'aria-hidden': 'true' });
  const drawSample = () => {
    sample.style.background = `#${values.lt1}`;
    sample.replaceChildren(el('span.design-sample-heading', { style: { color: `#${values.dk2}` } }, 'Heading'),
      el('span.design-sample-text', { style: { color: `#${values.dk1}` } }, 'Body text ', el('span', { style: { color: `#${values.hlink}`, textDecoration: 'underline' } }, 'link')),
      el('span.design-sample-bars', {}, ...[1, 2, 3, 4, 5, 6].map(i => el('span', { style: { background: `#${values[`accent${i}`]}` } }))));
  };
  const inputs = COLOR_SLOTS.map(slot => {
    const input = el('input.design-color-input', { type: 'color', value: `#${values[slot]}`, 'aria-label': COLOR_SLOT_LABELS[slot], oninput: () => { values[slot] = hexOf(input.value); drawSample(); } });
    return el('label.design-color-field', {}, input, el('span', {}, COLOR_SLOT_LABELS[slot]));
  });
  const named = nameInput(name);
  drawSample();
  dialog({ title: 'Customize Colors', body: [
    el('div.design-color-layout', {}, el('div.design-color-fields', { role: 'group', 'aria-label': 'Theme colors' }, ...inputs), el('div', {}, el('span.field-label', {}, 'Sample'), sample)),
    field('Name', named)],
  onSubmit: () => apply({ name: named.value.trim() || name, colors: { ...values } }),
  extra: [el('button.btn.btn-ghost', { type: 'button', onclick: () => { Object.assign(values, colors); COLOR_SLOTS.forEach((slot, i) => { inputs[i].querySelector('input').value = `#${colors[slot]}`; }); drawSample(); } }, 'Reset')] });
}

/** Customize Fonts: the heading and body fonts, with a sample. */
export function openCustomizeFonts({ fonts, name, apply }) {
  const select = value => el('select.input', {}, ...[...new Set([value, ...DESIGN_FONTS])].map(font => el('option', { value: font, selected: font === value }, font)));
  const major = select(fonts.major), minor = select(fonts.minor);
  const sample = el('div.design-font-preview', { 'aria-hidden': 'true' });
  const draw = () => sample.replaceChildren(el('span.design-font-preview-heading', { style: { fontFamily: fontStack(major.value) } }, 'Heading'),
    el('span.design-font-preview-body', { style: { fontFamily: fontStack(minor.value) } }, 'Body text for paragraphs and lists.'));
  major.addEventListener('change', draw); minor.addEventListener('change', draw); draw();
  const named = nameInput(name);
  major.setAttribute('aria-label', 'Heading font'); minor.setAttribute('aria-label', 'Body font');
  dialog({ title: 'Customize Fonts', body: [el('div.grid-2', {}, field('Heading font', major), field('Body font', minor)), el('span.field-label', {}, 'Sample'), sample, field('Name', named)],
    onSubmit: () => apply({ name: named.value.trim() || name, major: major.value, minor: minor.value }) });
}

/** Custom Paragraph Spacing for the Normal style: before and after in points, line spacing as a multiple. */
export function openParagraphSpacing({ before, after, line, apply }) {
  const number = (value, min, max, step, label) => el('input.input', { type: 'number', value: Number(value.toFixed(2)), min, max, step, required: true, 'aria-label': label });
  const b = number(before, 0, 600, 0.5, 'Before (pt)'), a = number(after, 0, 600, 0.5, 'After (pt)'), l = number(line, 0.06, 132, 0.01, 'Line spacing (multiple)');
  dialog({ title: 'Custom Paragraph Spacing', submitLabel: 'OK', wide: false,
    body: [el('p.field-hint', {}, 'Sets the spacing of the Normal style; styles based on it follow.'), el('div.grid-2', {}, field('Before (pt)', b), field('After (pt)', a)), field('Line spacing (multiple)', l)],
    onSubmit: () => {
      for (const input of [b, a, l]) if (!input.checkValidity()) { input.reportValidity(); return false; }
      return apply({ before: Number(b.value), after: Number(a.value), line: Number(l.value) });
    } });
}

/** More Colors for the page: any RGB color. */
export function openPageColor({ value, apply }) {
  const picker = el('input.design-page-color', { type: 'color', value: `#${value}`, 'aria-label': 'Page color' });
  const hex = el('input.input', { type: 'text', value: `#${value}`, 'aria-label': 'Hex value', maxLength: 7, pattern: '#?[0-9A-Fa-f]{6}' });
  picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); });
  hex.addEventListener('input', () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value.trim())) picker.value = `#${hex.value.trim().replace('#', '')}`; });
  dialog({ title: 'Page Color', submitLabel: 'OK', wide: false, body: [el('div.design-page-color-row', {}, picker, field('Hex value', hex))],
    onSubmit: () => { if (!hex.checkValidity()) { hex.reportValidity(); return false; } return apply(hexOf(hex.value.trim())); } });
}

/** Custom Watermark: none, a picture (scale, washout) or text (language, text, font, size, color, transparency, layout). */
export function openCustomWatermark({ current, apply }) {
  let kind = current?.kind || 'text', picture = null;
  const text = current?.kind === 'text' ? current : { text: 'DRAFT', font: null, size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal', language: 'en-US' };
  const listId = fieldId('watermark-texts');
  const words = el('input.input', { type: 'text', value: text.text, list: listId, maxLength: 120, 'aria-label': 'Text' });
  const fonts = el('select.input', { 'aria-label': 'Font' }, el('option', { value: '' }, 'Automatic'), ...DESIGN_FONTS.map(f => el('option', { value: f, selected: f === text.font }, f)));
  const size = el('select.input', { 'aria-label': 'Size' }, el('option', { value: 'auto' }, 'Auto'), ...[36, 48, 54, 60, 66, 72, 80, 90, 96, 105, 120, 144].map(n => el('option', { value: n, selected: n === text.size }, String(n))));
  const color = el('input.design-color-input', { type: 'color', value: `#${text.color || 'C0C0C0'}`, 'aria-label': 'Color' });
  const transparent = el('input', { type: 'checkbox', checked: text.semitransparent !== false });
  const language = el('select.input', { 'aria-label': 'Language' }, ...LANGUAGES.map(([code, label]) => el('option', { value: code, selected: code === (text.language || 'en-US') }, label)));
  let layout = text.layout || 'diagonal';
  const layoutGroup = segmented([['diagonal', 'Diagonal'], ['horizontal', 'Horizontal']], layout, value => { layout = value; draw(); }, 'Layout');
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  const pictureName = el('span.field-hint', {}, current?.kind === 'picture' ? 'The current picture is kept unless you choose another.' : 'No picture chosen.');
  const choose = el('button.btn.btn-outline', { type: 'button', onclick: () => file.click() }, 'Select Picture…');
  const scale = el('select.input', { 'aria-label': 'Scale' }, ...[['auto', 'Auto'], ['0.5', '50%'], ['1', '100%'], ['1.5', '150%'], ['2', '200%'], ['5', '500%']].map(([v, label]) => el('option', { value: v, selected: String(current?.scale ?? 'auto') === v }, label)));
  const washout = el('input', { type: 'checkbox', checked: current?.kind === 'picture' ? !!current.washout : true });
  const preview = el('div.design-watermark-preview', { 'aria-hidden': 'true' });
  let previewUrl = null;
  const draw = () => {
    if (kind === 'text') {
      const label = el(`span.design-watermark-text.is-${layout}`, { style: { color: color.value, opacity: transparent.checked ? '0.5' : '1', fontFamily: fontStack(fonts.value || 'Noto Sans') } }, words.value || ' ');
      preview.replaceChildren(el('span.design-watermark-page', {}, label));
    } else if (kind === 'picture') {
      preview.replaceChildren(el('span.design-watermark-page', {}, previewUrl ? el('img', { src: previewUrl, alt: '', style: { opacity: washout.checked ? '0.35' : '1' } }) : el('span.design-watermark-empty', {}, 'Picture')));
    } else preview.replaceChildren(el('span.design-watermark-page', {}));
  };
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: chosen.type }));
      picture = { bytes, mime: chosen.type === 'image/png' ? 'image/png' : 'image/jpeg', width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: chosen.type }));
      pictureName.textContent = chosen.name;
    } catch { pictureName.textContent = 'That picture could not be read. Choose a PNG or JPEG file.'; picture = null; }
    draw();
  });
  for (const control of [words, fonts, size, color, transparent, washout]) control.addEventListener('input', draw);
  const textPanel = el('div.design-panel', {},
    field('Language', language), field('Text', words), el('datalist', { id: listId }, ...WATERMARK_TEXTS.map(t => el('option', { value: t }))),
    el('div.grid-2', {}, field('Font', fonts), field('Size', size)),
    el('div.design-inline', {}, el('label.design-color-field', {}, color, el('span', {}, 'Color')), el('label.ed-check', {}, transparent, 'Semitransparent')),
    el('div.field', {}, el('span.field-label', {}, 'Layout'), layoutGroup));
  const picturePanel = el('div.design-panel', {}, el('div.design-inline', {}, choose, pictureName), file,
    el('div.grid-2', {}, field('Scale', scale), el('label.ed-check.design-washout', {}, washout, 'Washout')));
  const show = () => { textPanel.hidden = kind !== 'text'; picturePanel.hidden = kind !== 'picture'; draw(); };
  const kinds = segmented([['none', 'No watermark'], ['picture', 'Picture'], ['text', 'Text']], kind, value => { kind = value; show(); }, 'Watermark');
  const watermark = () => {
    if (kind === 'none') return null;
    if (kind === 'picture') {
      if (!picture) throw new Error('Select a picture first.');
      return { kind: 'picture', ...picture, scale: scale.value === 'auto' ? 'auto' : Number(scale.value), washout: washout.checked };
    }
    if (!words.value.trim()) throw new Error('Enter the watermark text.');
    return { kind: 'text', text: words.value.trim(), font: fonts.value || null, size: size.value === 'auto' ? 'auto' : Number(size.value), color: hexOf(color.value), semitransparent: transparent.checked, layout, language: language.value };
  };
  const applyButton = el('button.btn.btn-outline', { type: 'button', onclick: async () => {
    try { error.hidden = true; await apply(watermark()); } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  } }, 'Apply');
  const { modal, error } = dialog({ title: 'Watermark', submitLabel: 'OK', extra: [applyButton],
    body: [el('div.field', {}, kinds), el('div.design-watermark-layout', {}, el('div', {}, textPanel, picturePanel), preview)],
    onSubmit: async () => { await apply(watermark()); } });
  const close = modal.close;
  modal.close = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); close(); };
  show();
}

/** Fill Effects: gradient, texture, pattern or picture, with a page preview. */
export function openFillEffects({ page, apply }) {
  let kind = 'gradient', pictureFill = null;
  const state = { color1: 'DEEAF6', color2: 'FFFFFF', style: 'horizontal', texture: TEXTURES[0][0], pattern: PATTERNS[0][0], foreground: '7F7F7F', background: 'FFFFFF' };
  const canvas = el('canvas.design-fill-preview', { width: 120, height: Math.round(120 * page.height / page.width), 'aria-label': 'Preview', role: 'img' });
  const draw = () => {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (kind === 'gradient') drawGradient(ctx, canvas.width, canvas.height, state);
    else if (kind === 'pattern') drawPattern(ctx, canvas.width, canvas.height, state, 1);
    else if (kind === 'texture') drawTexture(ctx, canvas.width, canvas.height, state);
    else if (pictureFill?.bitmap) { const pattern = ctx.createPattern(pictureFill.bitmap, 'repeat'); ctx.fillStyle = pattern; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  };
  const colorInput = (key, label) => { const input = el('input.design-color-input', { type: 'color', value: `#${state[key]}`, 'aria-label': label, oninput: () => { state[key] = hexOf(input.value); draw(); } }); return el('label.design-color-field', {}, input, el('span', {}, label)); };
  const tile = (list, key, paint) => el('div.design-tile-grid', { role: 'radiogroup', 'aria-label': { texture: 'Texture', pattern: 'Pattern', style: 'Shading style' }[key] }, ...list.map(([id, label]) => {
    const preview = el('canvas', { width: 40, height: 40, 'aria-hidden': 'true' });
    const ctx = preview.getContext('2d'); if (ctx) paint(ctx, id);
    const button = el('button.design-tile', { type: 'button', role: 'radio', 'aria-checked': String(state[key] === id), title: label, 'aria-label': label, onclick: () => {
      state[key] = id; for (const b of button.parentNode.children) b.setAttribute('aria-checked', String(b === button)); draw();
    } }, preview);
    return button;
  }));
  const gradientPanel = el('div.design-panel', {}, el('div.design-inline', {}, colorInput('color1', 'Color 1'), colorInput('color2', 'Color 2')),
    el('div.field', {}, el('span.field-label', {}, 'Shading style'), tile(GRADIENT_STYLES, 'style', (ctx, id) => drawGradient(ctx, 40, 40, { color1: '7FA7D9', color2: 'FFFFFF', style: id }))));
  const texturePanel = el('div.design-panel', {}, tile(TEXTURES, 'texture', (ctx, id) => drawTexture(ctx, 40, 40, { texture: id })));
  const patternPanel = el('div.design-panel', {}, tile(PATTERNS, 'pattern', (ctx, id) => drawPattern(ctx, 40, 40, { pattern: id, foreground: '595959', background: 'FFFFFF' }, 2)),
    el('div.design-inline', {}, colorInput('foreground', 'Foreground'), colorInput('background', 'Background')));
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  const pictureName = el('span.field-hint', {}, 'No picture chosen. The picture repeats across each page.');
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: chosen.type }));
      pictureFill = { bytes, mime: chosen.type === 'image/png' ? 'image/png' : 'image/jpeg', name: chosen.name, bitmap };
      pictureName.textContent = chosen.name;
    } catch { pictureName.textContent = 'That picture could not be read. Choose a PNG or JPEG file.'; pictureFill = null; }
    draw();
  });
  const picturePanel = el('div.design-panel', {}, el('div.design-inline', {}, el('button.btn.btn-outline', { type: 'button', onclick: () => file.click() }, 'Select Picture…'), pictureName), file);
  const panels = { gradient: gradientPanel, texture: texturePanel, pattern: patternPanel, picture: picturePanel };
  const show = () => { for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== kind; draw(); };
  const kinds = segmented([['gradient', 'Gradient'], ['texture', 'Texture'], ['pattern', 'Pattern'], ['picture', 'Picture']], kind, value => { kind = value; show(); }, 'Fill type');
  dialog({ title: 'Fill Effects', submitLabel: 'OK',
    body: [el('div.field', {}, kinds), el('div.design-fill-layout', {}, el('div', {}, ...Object.values(panels)), el('div', {}, el('span.field-label', {}, 'Sample'), canvas)),
      el('p.field-hint', {}, 'Fill effects are saved as a picture background, so other apps show the same fill.')],
    onSubmit: async () => {
      if (kind === 'picture' && !pictureFill) throw new Error('Select a picture first.');
      const ok = await apply(kind === 'picture' ? { kind, bytes: pictureFill.bytes, mime: pictureFill.mime, name: pictureFill.name } : { kind, ...state });
      if (ok) pictureFill?.bitmap?.close?.();
      return ok;
    } });
  show();
}
