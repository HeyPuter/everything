import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { commandIconEl } from '../ui/ribbon.js';
import * as presets from './picture-presets.js';
import { ARTISTIC_EFFECTS } from '../engine/picture-processing.js';
import { bakedState } from './picture-adjustments.js';

/**
 * The Format pane (Format Picture / Format Shape): every setting of the selected drawing in four
 * sections — Fill & Line, Effects, Layout & Properties and, for pictures, Picture. Each change is one
 * edit of the drawing (one undo step); the pane reads the drawing back after every change.
 */
const PT = 12700, IN = 914400;
let ids = 0;

export function createPane(context) {
  const { selected, describe, kind, commands, palette, theme, pickColor, onClose } = context;
  const heading = el('h2', {}, 'Format');
  const tabs = el('div.pic-pane-tabs', { role: 'tablist', 'aria-label': 'Format sections' });
  const panelId = `pic-pane-body-${++ids}`;
  const body = el('div.canvas-panel-scroll.pic-pane-body', { role: 'tabpanel', id: panelId });
  // Formatting from the pane keeps the keyboard in the pane (see placeDrawing).
  const node = el('aside.pic-pane', { 'aria-label': 'Format pane', 'data-keeps-focus': '' },
    el('div.canvas-panel-heading', {}, heading, el('button.icon-btn', { type: 'button', 'aria-label': 'Close Format pane', onclick: () => close() }, iconEl('x', 18))),
    tabs, body);
  node.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented) { e.preventDefault(); close(); } });
  let section = 'fill', drawn = null;
  const SECTIONS = [['fill', 'Fill & Line', 'shapeFill'], ['effects', 'Effects', 'pictureEffects'], ['layout', 'Layout & Properties', 'position'], ['picture', 'Picture', 'pictures']];
  const tabButtons = SECTIONS.map(([id, label, icon]) => {
    const button = el('button.pic-pane-tab', { type: 'button', role: 'tab', id: `${panelId}-${id}`, 'aria-controls': panelId, 'aria-selected': 'false', tabindex: -1, 'aria-label': label, title: label, dataset: { section: id }, onclick: () => show(id) }, commandIconEl(icon, 18));
    tabs.append(button); return button;
  });
  tabs.addEventListener('keydown', e => {
    const list = tabButtons.filter(b => !b.hidden), at = list.indexOf(document.activeElement);
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key] ?? null;
    if (next !== null && at >= 0) { e.preventDefault(); const b = list[(next + list.length) % list.length]; b.focus(); b.click(); }
  });

  /* ---- Form helpers ---- */
  const field = (label, control, hint) => {
    // The label names the field itself, also when it sits in a wrapper with its unit.
    const target = control.matches('input, select, textarea, button') ? control : control.querySelector('input, select, textarea, button') || control;
    const id = target.id || `pic-field-${++ids}`; target.id = id;
    return el('div.pic-field', {}, el('label', { htmlFor: id }, label), control, hint ? el('span.pic-hint', {}, hint) : null);
  };
  const number = (value, { min, max, step = 1, unit = '', onCommit }) => {
    const input = el('input.input.pic-number', { type: 'number', min, max, step, value: value ?? '', onchange: () => { if (input.value === '' || !input.checkValidity()) { input.reportValidity(); return; } onCommit(Number(input.value)); } });
    return unit ? el('span.pic-number-wrap', {}, input, el('span.pic-unit', {}, unit)) : input;
  };
  const slider = (label, value, { min, max, step = 1, unit = '%', onCommit }) => {
    const id = `pic-field-${++ids}`;
    const range = el('input.pic-range', { type: 'range', min, max, step, value, id, 'aria-label': label });
    const box = el('input.input.pic-number', { type: 'number', min, max, step, value, 'aria-label': `${label} value` });
    range.addEventListener('input', () => { box.value = range.value; });
    range.addEventListener('change', () => onCommit(Number(range.value)));
    box.addEventListener('change', () => { if (!box.checkValidity() || box.value === '') { box.reportValidity(); return; } range.value = box.value; onCommit(Number(box.value)); });
    return el('div.pic-field.pic-slider', {}, el('label', { htmlFor: id }, label), el('div.pic-slider-row', {}, range, box, el('span.pic-unit', {}, unit)));
  };
  const select = (options, value, onChange) => el('select.input.pic-select', { onchange: e => onChange(e.target.value) }, ...options.map(([label, v]) => el('option', { value: v, selected: String(v) === String(value) }, label)));
  const check = (label, checked, onChange, disabled = false) => { const id = `pic-field-${++ids}`; return el('label.pic-check', { htmlFor: id }, el('input', { type: 'checkbox', id, checked, disabled, onchange: e => onChange(e.target.checked) }), label); };
  const colorButton = (label, value, onPick, none) => {
    const hex = value === 'none' || !value ? null : presets.resolveColor(value, palette());
    const button = el('button.btn.btn-outline.pic-color-button', { type: 'button', 'aria-label': `${label}: ${hex ? `#${hex}` : 'none'}`, dataset: { focusKey: label }, onclick: () => pickColor(button, label, value, onPick, none) },
      el(hex ? 'span.pic-color-chip' : 'span.pic-color-chip.is-none', { style: { background: hex ? `#${hex}` : 'transparent' } }), el('span', {}, hex ? `#${hex}` : 'None'));
    return button;
  };
  const group = (title, ...children) => el('details.pic-group', { open: true }, el('summary', {}, title), el('div.pic-group-body', {}, ...children.filter(Boolean)));
  // One name for the whole group, so its options are one tab stop with arrow keys between them.
  const radios = (name, options, value, onChange) => { const groupName = `${name}-${++ids}`; return el('div.pic-radios', { role: 'radiogroup', 'aria-label': name }, ...options.map(([label, v]) => { const id = `pic-field-${++ids}`; return el('label.pic-radio', { htmlFor: id }, el('input', { type: 'radio', id, name: groupName, checked: v === value, onchange: () => onChange(v) }), label); })); };

  /* ---- Sections ---- */
  function fillSection(image, info) {
    const shapeLike = ['shape', 'textBox'].includes(kind(image));
    const fill = info.fill, line = info.outline;
    const fillType = !fill ? (shapeLike ? 'automatic' : 'none') : fill.type;
    const solidColor = fill?.type === 'solid' ? fill.color : null;
    const out = [];
    if (shapeLike) {
      const fillBody = el('div.pic-subfields');
      const base = solidColor ? (solidColor.scheme ? { scheme: solidColor.scheme } : { rgb: solidColor.rgb }) : theme() ? { scheme: 'accent1' } : { rgb: palette().accent1 };
      if (fill?.type === 'solid') fillBody.append(field('Color', colorButton('Fill color', solidColor, c => commands.fill({ type: 'solid', color: c === 'none' ? 'FFFFFF' : c }, 'Fill'))),
        slider('Transparency', Math.round((1 - (solidColor?.alpha ?? 1)) * 100), { min: 0, max: 100, onCommit: v => commands.fill({ type: 'solid', color: { ...(typeof solidColor === 'object' ? solidColor : { rgb: solidColor }), alpha: 1 - v / 100 } }, 'Fill Transparency') }));
      if (fill?.type === 'gradient') {
        const stops = fill.stops || [];
        fillBody.append(field('Preset', select([['Choose…', ''], ...presets.GRADIENT_PRESETS.map(([name], i) => [name, String(i)])], '', v => v !== '' && commands.fill(presets.GRADIENT_PRESETS[Number(v)][1](base), 'Gradient'))),
          field('Type', select([['Linear', 'linear'], ['Radial', 'circle'], ['Rectangular', 'rect']], fill.path || 'linear', v => commands.fill({ ...fill, ...(v === 'linear' ? { path: undefined, angle: fill.angle || 90 } : { path: v }) }, 'Gradient'))),
          fill.path ? null : field('Angle', number(Math.round(fill.angle || 0), { min: 0, max: 359, unit: '°', onCommit: v => commands.fill({ ...fill, angle: v }, 'Gradient') })),
          ...stops.map((stop, i) => field(`Stop ${i + 1} color`, colorButton(`Stop ${i + 1} color`, stop.color, c => commands.fill({ ...fill, stops: stops.map((s, j) => j === i ? { ...s, color: c } : s) }, 'Gradient')))));
      }
      if (fill?.type === 'pattern') fillBody.append(
        field('Pattern', select(presets.PATTERN_PRESETS.map(([n, v]) => [n, v]), fill.preset, v => commands.fill({ ...fill, preset: v }, 'Pattern'))),
        field('Foreground', colorButton('Pattern foreground', fill.foreground, c => commands.fill({ ...fill, foreground: c }, 'Pattern'))),
        field('Background', colorButton('Pattern background', fill.background, c => commands.fill({ ...fill, background: c }, 'Pattern'))));
      out.push(group('Fill', radios('Fill', [['No fill', 'none'], ['Solid fill', 'solid'], ['Gradient fill', 'gradient'], ['Pattern fill', 'pattern'], ...(fillType === 'automatic' ? [['Automatic', 'automatic']] : [])], fillType, v => {
        if (v === 'none') commands.fill({ type: 'none' }, 'No Fill');
        else if (v === 'solid') commands.fill({ type: 'solid', color: base.rgb || base }, 'Solid Fill');
        else if (v === 'gradient') commands.fill(presets.GRADIENT_PRESETS[0][1](base), 'Gradient Fill');
        else if (v === 'pattern') commands.fill({ type: 'pattern', preset: 'pct50', foreground: base.rgb || base, background: 'FFFFFF' }, 'Pattern Fill');
      }), fillBody));
    }
    const lineOn = !!line && line.color !== 'none' && line.color !== undefined;
    const lineBody = el('div.pic-subfields');
    if (lineOn) {
      const arrowsAllowed = shapeLike;
      lineBody.append(
        field('Color', colorButton('Line color', line.color, c => commands.outline({ color: c }, 'Line Color'))),
        field('Width', number(Math.round(line.width / PT * 100) / 100, { min: 0, max: 1584, step: 0.25, unit: 'pt', onCommit: v => commands.outline({ width: Math.round(v * PT) }, 'Line Width') })),
        field('Compound type', select(presets.COMPOUNDS, line.compound, v => commands.outline({ compound: v }, 'Compound Type'))),
        field('Dash type', select(presets.DASHES, line.dash, v => commands.outline({ dash: v }, 'Dash Type'))),
        field('Cap type', select([['Flat', 'flat'], ['Round', 'rnd'], ['Square', 'sq']], line.cap, v => commands.outline({ cap: v }, 'Cap Type'))),
        field('Join type', select([['Round', 'round'], ['Bevel', 'bevel'], ['Miter', 'miter']], line.join || 'round', v => commands.outline({ join: v }, 'Join Type'))),
        arrowsAllowed ? field('Begin arrow type', select(presets.LINE_END_TYPES, line.headEnd?.type || 'none', v => commands.outline({ headEnd: v === 'none' ? null : { type: v, w: line.headEnd?.w || 'med', len: line.headEnd?.len || 'med' } }, 'Arrow'))) : null,
        arrowsAllowed ? field('End arrow type', select(presets.LINE_END_TYPES, line.tailEnd?.type || 'none', v => commands.outline({ tailEnd: v === 'none' ? null : { type: v, w: line.tailEnd?.w || 'med', len: line.tailEnd?.len || 'med' } }, 'Arrow'))) : null);
    }
    out.push(group('Line', radios('Line', [['No line', 'none'], ['Solid line', 'solid'], ...(line === undefined && shapeLike ? [['Automatic', 'automatic']] : [])], lineOn ? 'solid' : line === undefined && shapeLike ? 'automatic' : 'none', v => {
      if (v === 'none') commands.outline({ color: 'none' }, 'No Line');
      else if (v === 'solid') commands.outline({ color: '000000', width: PT, dash: 'solid' }, 'Solid Line');
    }), lineBody));
    return out;
  }
  function effectsSection(image, info) {
    const effects = info.effects || {}, picture = kind(image) === 'picture';
    const shadow = effects.shadow, glow = effects.glow, soft = effects.softEdge, reflection = effects.reflection;
    const set = (patch, label) => commands.effects(patch, label);
    const shadowBody = shadow ? [
      field('Color', colorButton('Shadow color', shadow.color || '000000', c => set({ shadow: { ...shadow, color: c === 'none' ? '000000' : c } }, 'Shadow Color'))),
      slider('Transparency', Math.round((1 - (shadow.alpha ?? 1)) * 100), { min: 0, max: 100, onCommit: v => set({ shadow: { ...shadow, alpha: 1 - v / 100 } }, 'Shadow') }),
      slider('Blur', Math.round(shadow.blur / PT), { min: 0, max: 100, unit: 'pt', onCommit: v => set({ shadow: { ...shadow, blur: v * PT } }, 'Shadow') }),
      slider('Distance', Math.round(shadow.distance / PT), { min: 0, max: 200, unit: 'pt', onCommit: v => set({ shadow: { ...shadow, distance: v * PT } }, 'Shadow') }),
      slider('Angle', Math.round(shadow.direction), { min: 0, max: 359, unit: '°', onCommit: v => set({ shadow: { ...shadow, direction: v } }, 'Shadow') }),
    ] : [];
    const glowBody = glow ? [
      field('Color', colorButton('Glow color', glow.color, c => set({ glow: { ...glow, color: c } }, 'Glow Color'))),
      slider('Size', Math.round(glow.radius / PT), { min: 0, max: 150, unit: 'pt', onCommit: v => set({ glow: v ? { ...glow, radius: v * PT } : null }, 'Glow') }),
      slider('Transparency', Math.round((1 - (glow.alpha ?? 1)) * 100), { min: 0, max: 100, onCommit: v => set({ glow: { ...glow, alpha: 1 - v / 100 } }, 'Glow') }),
    ] : [];
    const reflectionBody = reflection ? [
      slider('Transparency', Math.round((1 - reflection.startAlpha) * 100), { min: 0, max: 100, onCommit: v => set({ reflection: { ...reflection, startAlpha: 1 - v / 100 } }, 'Reflection') }),
      slider('Size', Math.round(reflection.endPosition / 1000), { min: 1, max: 100, onCommit: v => set({ reflection: { ...reflection, endPosition: v * 1000 } }, 'Reflection') }),
      slider('Distance', Math.round(reflection.distance / PT), { min: 0, max: 100, unit: 'pt', onCommit: v => set({ reflection: { ...reflection, distance: v * PT } }, 'Reflection') }),
      slider('Blur', Math.round(reflection.blur / PT * 10) / 10, { min: 0, max: 100, step: 0.5, unit: 'pt', onCommit: v => set({ reflection: { ...reflection, blur: v * PT } }, 'Reflection') }),
    ] : [];
    const presetSelect = (list, current, onPick) => select([['Choose a preset…', ''], ...list.map(([name], i) => [name, String(i)])], '', v => v !== '' && onPick(list[Number(v)][1]));
    const groups = [
      group('Shadow', field('Presets', presetSelect(presets.SHADOW_PRESETS, shadow, s => set({ shadow: s ? { ...s, color: '000000' } : null }, 'Shadow'))), ...shadowBody),
      group('Reflection', field('Presets', presetSelect(presets.REFLECTION_PRESETS, reflection, r => set({ reflection: r }, 'Reflection'))), ...reflectionBody),
      group('Glow', field('Presets', select([['No glow', '0'], ...presets.GLOW_SIZES.map(s => [`${s} pt`, String(s)])], glow ? '' : '0', v => set({ glow: Number(v) ? { radius: Number(v) * PT, color: glow?.color || (theme() ? { scheme: 'accent1' } : palette().accent1), alpha: glow?.alpha ?? 0.6 } : null }, 'Glow'))), ...glowBody),
      group('Soft Edges', slider('Size', Math.round((soft?.radius || 0) / PT * 10) / 10, { min: 0, max: 100, step: 0.5, unit: 'pt', onCommit: v => set({ softEdge: v ? { radius: Math.round(v * PT) } : null }, 'Soft Edges') })),
    ];
    if (picture) {
      const bevel = info.threeD?.bevel;
      groups.push(group('3-D Format',
        field('Top bevel', select([['None', ''], ['Circle', 'circle'], ['Angle', 'angle']], bevel?.preset || '', v => commands.threeD({ bevel: v ? { preset: v, width: bevel?.width || 6 * PT, height: bevel?.height || 6 * PT } : null }, 'Bevel'))),
        bevel ? field('Width', number(Math.round(bevel.width / PT * 10) / 10, { min: 0, max: 100, step: 0.5, unit: 'pt', onCommit: v => commands.threeD({ bevel: { ...bevel, width: v * PT } }, 'Bevel') })) : null,
        bevel ? field('Height', number(Math.round(bevel.height / PT * 10) / 10, { min: 0, max: 100, step: 0.5, unit: 'pt', onCommit: v => commands.threeD({ bevel: { ...bevel, height: v * PT } }, 'Bevel') })) : null),
      group('3-D Rotation', field('Presets', select(presets.ROTATION_3D_PRESETS.map(([n, v]) => [n, v]), info.threeD?.camera || 'orthographicFront', v => commands.threeD({ camera: v }, '3-D Rotation')))));
    }
    return groups;
  }
  function layoutSection(image, info) {
    const out = [];
    const body = info.body;
    if (body) out.push(group('Text Box',
      field('Vertical alignment', select([['Top', 't'], ['Middle', 'ctr'], ['Bottom', 'b']], body.anchor, v => commands.body({ anchor: v }, 'Vertical Alignment'))),
      check('Resize shape to fit text', body.autofit === 'shape', v => commands.body({ autofit: v ? 'shape' : 'none' }, 'Autofit')),
      ...[['Left margin', 'left'], ['Right margin', 'right'], ['Top margin', 'top'], ['Bottom margin', 'bottom']].map(([label, key]) => field(label, number(Math.round(body.insets[key] / IN * 100) / 100, { min: 0, max: 22, step: 0.01, unit: 'in', onCommit: v => commands.body({ insets: { [key]: Math.round(v * IN) } }, 'Text Box Margins') }))),
      check('Wrap text in shape', body.wrap, v => commands.body({ wrap: v }, 'Wrap Text in Shape'))));
    out.push(group('Size',
      field('Height', number(context.sizeOf(image, 'height'), { min: 0.01, max: 22, step: 0.01, unit: 'in', onCommit: v => context.setSize('height', v) })),
      field('Width', number(context.sizeOf(image, 'width'), { min: 0.01, max: 22, step: 0.01, unit: 'in', onCommit: v => context.setSize('width', v) })),
      field('Rotation', number(Math.round((info.transform?.rotation || 0) * 10) / 10, { min: -3600, max: 3600, step: 1, unit: '°', onCommit: v => commands.rotate(v - (info.transform?.rotation || 0), 'Rotation') })),
      el('button.btn.btn-outline.pic-link-button', { type: 'button', onclick: () => context.openSizePosition('size') }, 'Size and Position…')));
    out.push(group('Alt Text', el('p.pic-hint', {}, info.decorative ? 'Marked as decorative.' : info.description ? `“${info.description}”` : 'No description yet.'),
      el('button.btn.btn-outline.pic-link-button', { type: 'button', onclick: () => context.openAltText?.() }, 'Edit Alt Text…')));
    return out;
  }
  function pictureSection(image, info) {
    const blip = info.blip || {}, lum = blip.luminance || { brightness: 0, contrast: 0 }, state = bakedState(blip.layer);
    const recolor = presets.recolorPresets(palette());
    const all = [...recolor.basic, ...recolor.dark, ...recolor.light];
    const recolorId = blip.grayscale ? 'grayscale' : blip.biLevel !== null && blip.biLevel !== undefined ? `bw${Math.round(blip.biLevel * 100)}` : blip.duotone ? all.find(p => p.patch.duotone && JSON.stringify(p.patch.duotone) === JSON.stringify(blip.duotone.map(c => c?.rgb)))?.id || 'custom' : 'none';
    return [
      group('Picture Corrections',
        slider('Sharpness', Math.round((state.sharpen || 0) * 100), { min: -100, max: 100, onCommit: v => commands.processed('Sharpness', { sharpen: v ? v / 100 : null }) }),
        slider('Brightness', Math.round(lum.brightness * 100), { min: -100, max: 100, onCommit: v => commands.setLuminance(v / 100, lum.contrast) }),
        slider('Contrast', Math.round(lum.contrast * 100), { min: -100, max: 100, onCommit: v => commands.setLuminance(lum.brightness, v / 100) })),
      group('Picture Color',
        slider('Saturation', Math.round((state.saturation ?? 1) * 100), { min: 0, max: 400, onCommit: v => commands.processed('Saturation', { saturation: v === 100 ? null : v / 100 }) }),
        slider('Temperature', Math.round(state.temperature ?? 6500), { min: 1500, max: 11500, step: 50, unit: 'K', onCommit: v => commands.processed('Temperature', { temperature: v === 6500 ? null : v }) }),
        field('Recolor', select([...all.map(p => [p.label, p.id]), ...(recolorId === 'custom' ? [['Custom duotone', 'custom']] : [])], recolorId, v => { const p = all.find(x => x.id === v); if (p) commands.recolor(p.patch); }))),
      group('Picture Transparency',
        slider('Transparency', Math.round((1 - (blip.alpha ?? 1)) * 100), { min: 0, max: 100, onCommit: v => commands.setTransparency(v / 100) })),
      group('Artistic Effects',
        field('Effect', select([['None', ''], ...ARTISTIC_EFFECTS.map(e => [e.name, e.id])], state.artistic?.id || '', v => commands.processed('Artistic Effects', { artistic: v ? { id: v, amount: 0.5 } : null })))),
      group('Crop',
        el('p.pic-hint', {}, `Left ${pct(info.crop?.left)} · Top ${pct(info.crop?.top)} · Right ${pct(info.crop?.right)} · Bottom ${pct(info.crop?.bottom)}`),
        el('button.btn.btn-outline.pic-link-button', { type: 'button', disabled: !context.editor()?.startCrop, onclick: () => context.editor()?.startCrop?.() }, 'Crop on the page')),
    ];
  }
  const pct = v => `${Math.round((v || 0) / 1000)}%`;

  function render() {
    const image = selected(), info = image ? describe(image) : null;
    const picture = !!image && kind(image) === 'picture';
    heading.textContent = !image ? 'Format' : picture ? 'Format Picture' : kind(image) === 'group' ? 'Format Group' : 'Format Shape';
    tabButtons.find(b => b.dataset.section === 'picture').hidden = !picture;
    if (section === 'picture' && !picture) section = 'fill';
    for (const button of tabButtons) { const on = button.dataset.section === section; button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; if (on) body.setAttribute('aria-labelledby', button.id); }
    // Controls get new ids on each render: the focused one is found again by its section, group and label
    // (a color button by its label alone, since its name also tells the color it changes).
    const keyOf = n => [n.closest('details')?.querySelector('summary')?.textContent, n.closest('[role="radiogroup"]')?.getAttribute('aria-label'),
      n.dataset.focusKey || n.getAttribute('aria-label') || n.labels?.[0]?.textContent || n.closest('label')?.textContent || n.textContent, n.tagName, n.type].join('\u0000');
    const focusedKey = document.activeElement && body.contains(document.activeElement) ? keyOf(document.activeElement) : null;
    if (!image || !info) { body.replaceChildren(el('p.pic-empty', {}, 'Select a picture or shape to format it.')); return; }
    if (kind(image) === 'chart' || kind(image) === 'diagram' || kind(image) === 'other') { body.replaceChildren(el('p.pic-empty', {}, 'This object keeps its own formatting. Use Layout & Properties to change its size and position.'), ...layoutSection(image, info)); return; }
    const content = section === 'fill' ? fillSection(image, info) : section === 'effects' ? effectsSection(image, info) : section === 'layout' ? layoutSection(image, info) : pictureSection(image, info);
    body.replaceChildren(...content);
    if (focusedKey) [...body.querySelectorAll('button, input, select, textarea, summary')].find(n => keyOf(n) === focusedKey)?.focus();
  }
  function show(id) { if (id) section = id === 'line' ? 'fill' : id; drawn = null; refresh(); }
  function refresh() {
    const image = selected(), key = `${section}:${image?.assetId}:${image?.shell?.length}:${image?.id}:${image?.width}x${image?.height}:${image?.rotation}:${image?.opacity}`;
    if (key === drawn) return;
    drawn = key; render();
  }
  function close() { node.remove(); onClose(); }
  return { node, show, refresh, close: () => node.remove() };
}
