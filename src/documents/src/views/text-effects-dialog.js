import { el } from '../ui/dom.js';
import { tabStrip, field, group, select, openFormatDialog, colorField } from './format-dialog-kit.js';

const EMU_PER_PT = 12700;
const OUTLINE_WIDTHS = [[3175, '¼ pt'], [6350, '½ pt'], [9525, '¾ pt'], [12700, '1 pt'], [19050, '1½ pt'], [28575, '2¼ pt'], [38100, '3 pt']];
/** Shadow presets: [label, distance pt, angle °, blur pt]. */
export const SHADOW_PRESETS = [['Offset: bottom right', 3, 45, 3], ['Offset: bottom', 3, 90, 3], ['Offset: right', 3, 0, 3], ['Offset: top left', 3, 225, 3], ['Soft glow-like halo', 0, 0, 8]];

/**
 * Text Effects: text fill (solid or none), outline and shadow, written as w14 text effects (§17.3.2 run
 * properties extended by the 2010 wordprocessingml namespace) and painted by the canvas. Reflection, glow
 * and 3-D presets are not offered: the canvas does not render them.
 *
 * format: the selection's run formatting. apply(patch) returns false on failure.
 */
export function openTextEffects({ format: f, apply, onClose }) {
  const ink = f.color && f.color !== 'auto' ? f.color : '000000';
  /* ---- Fill and outline ---- */
  const fill = select('Text fill', [['solid', 'Solid fill (text color)'], ['none', 'No fill (outline only)']], f.textFill === 'none' ? 'none' : 'solid', { onchange: () => paint() });
  const outline = select('Text outline', [['none', 'No line'], ['solid', 'Solid line']], f.textOutline ? 'solid' : 'none', { onchange: () => { sync(); paint(); } });
  const outlineColor = colorField('Outline color', f.textOutline?.color || ink, { reset: { value: ink, label: 'Text color' }, onchange: () => paint() });
  const outlineWidth = select('Outline width', OUTLINE_WIDTHS.map(([v, t]) => [String(v), t]), String(OUTLINE_WIDTHS.find(([v]) => v === f.textOutline?.width)?.[0] ?? 9525), { onchange: () => paint() });
  /* ---- Shadow ---- */
  const s = f.textShadow;
  const shadow = select('Shadow type', [['none', 'No shadow'], ['outer', 'Outer shadow']], s ? 'outer' : 'none', { onchange: () => { sync(); paint(); } });
  const preset = select('Shadow preset', [['', 'Custom'], ...SHADOW_PRESETS.map(([label], i) => [String(i), label])], '', { onchange: () => {
    const chosen = SHADOW_PRESETS[Number(preset.value)]; if (!chosen) return;
    [distance.value, angle.value, blur.value] = [chosen[1], chosen[2], chosen[3]].map(String); paint();
  } });
  const shadowColor = colorField('Shadow color', s?.color || '000000', { reset: { value: '000000', label: 'Black' }, onchange: () => paint() });
  const number = (label, value, min, max, step) => el('input.input', { type: 'number', min, max, step, value, 'aria-label': label, oninput: () => { preset.value = ''; paint(); } });
  const transparency = number('Shadow transparency (%)', Math.round((1 - (s?.alpha ?? 0.6)) * 100), 0, 100, 1);
  const blur = number('Shadow blur (pt)', s ? Math.round(s.blurRadius / EMU_PER_PT * 10) / 10 : 3, 0, 100, 0.5);
  const distance = number('Shadow distance (pt)', s ? Math.round(s.distance / EMU_PER_PT * 10) / 10 : 3, 0, 200, 0.5);
  const angle = number('Shadow angle (°)', s ? Math.round(s.direction / 60000) : 45, 0, 359, 1);
  const shadowFields = [preset, shadowColor, transparency, blur, distance, angle];
  function sync() {
    outlineColor.disabled = outlineWidth.disabled = outline.value === 'none';
    for (const control of shadowFields) control.disabled = shadow.value === 'none';
  }
  /* ---- Preview ---- */
  const sample = el('span', {}, 'AaBbCcYyZz');
  const previewBox = el('div.ed-font-preview.fmt-effects-preview', { 'aria-hidden': 'true' }, sample);
  function paint() {
    const st = sample.style;
    const width = outline.value === 'solid' ? Number(outlineWidth.value) / EMU_PER_PT * 4 / 3 : 0;
    st.webkitTextStroke = width ? `${Math.max(0.5, width)}px #${outlineColor.value}` : '';
    st.color = fill.value === 'none' ? 'transparent' : `#${ink}`;
    if (fill.value === 'none' && !width) st.webkitTextStroke = `0.5px #${ink}`;
    if (shadow.value === 'outer') {
      const rad = Number(angle.value || 0) * Math.PI / 180, d = Number(distance.value || 0) * 4 / 3;
      const alpha = 1 - Number(transparency.value || 0) / 100;
      const hex = shadowColor.value, rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');
      st.textShadow = `${(Math.cos(rad) * d).toFixed(1)}px ${(Math.sin(rad) * d).toFixed(1)}px ${Number(blur.value || 0) * 4 / 3}px rgba(${rgb},${alpha})`;
    } else st.textShadow = '';
  }
  sync(); paint();
  const fillPanel = el('div', {}, group('Text fill', field('Fill', fill)), group('Text outline', el('div.fmt-grid', {}, field('Line', outline), field('Color', outlineColor), field('Width', outlineWidth))));
  const shadowPanel = el('div', {}, group('Shadow', el('div.fmt-grid', {}, field('Shadow', shadow), field('Presets', preset), field('Color', shadowColor), field('Transparency (%)', transparency)),
    el('div.fmt-grid', {}, field('Blur (pt)', blur), field('Distance (pt)', distance), field('Angle (°)', angle))),
    el('p.field-hint', {}, 'Reflection, glow and 3-D formats from other files are kept but cannot be edited here.'));
  const tabs = tabStrip('Text effects', [['fill', 'Text Fill & Outline', fillPanel], ['shadow', 'Shadow', shadowPanel]]);
  const modal = openFormatDialog({ title: 'Format Text Effects', className: 'fmt-effects-dialog', onClose,
    body: [tabs.node, fillPanel, shadowPanel, el('div.ed-font-preview-frame', {}, el('span.field-label', {}, 'Preview'), previewBox)],
    submit: () => {
      const patch = {};
      if (fill.value === 'none' && f.textFill !== 'none') patch.textFill = 'none';
      if (fill.value === 'solid' && f.textFill === 'none') patch.textFill = ink;
      const nextOutline = outline.value === 'solid' ? { width: Number(outlineWidth.value), color: outlineColor.value, join: 'round', cap: 'flat', miter: 8 } : null;
      if (JSON.stringify(nextOutline) !== JSON.stringify(f.textOutline ?? null)) patch.textOutline = nextOutline;
      for (const [input, label, max] of [[transparency, 'Transparency', 100], [blur, 'Blur', 100], [distance, 'Distance', 200], [angle, 'Angle', 359]]) {
        if (shadow.value === 'outer' && (input.value === '' || !input.checkValidity())) throw new Error(`${label} must be a number from 0 to ${max}.`);
      }
      const nextShadow = shadow.value === 'outer' ? { blurRadius: Math.round(Number(blur.value) * EMU_PER_PT), distance: Math.round(Number(distance.value) * EMU_PER_PT), direction: Math.round(Number(angle.value) % 360) * 60000,
        scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, alignment: 'tl', color: shadowColor.value, alpha: Math.round((1 - Number(transparency.value) / 100) * 1000) / 1000 } : null;
      if (JSON.stringify(nextShadow) !== JSON.stringify(f.textShadow ?? null)) patch.textShadow = nextShadow;
      return Object.keys(patch).length ? apply(patch) : true;
    } });
  fill.focus();
  return modal;
}
