import { el, isComposing } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { commandIconEl } from '../ui/ribbon.js';
import { drawingParts } from '../engine/drawing-format.js';
import { writeFrame, setTransform, child, make, A, WP } from '../engine/drawing-xml.js';
import { EMU_PER_PX } from '../engine/images.js';

/**
 * The Layout dialog (Size and Position): Position (horizontal and vertical alignment or offsets and
 * their reference frames, move with text, lock anchor, allow overlap, layout in table cell), Text
 * Wrapping (style, sides, distances from text) and Size (height, width, rotation, scale, aspect lock).
 * Everything applies as one edit of the drawing; a combination the document cannot hold is reported
 * in the dialog and nothing changes.
 */
const IN = 914400;
const inches = emu => Math.round(emu / IN * 100) / 100;
const WRAPS = [['inline', 'In line with text', 'wrapInline'], ['square', 'Square', 'wrapSquare'], ['tight', 'Tight', 'wrapTight'], ['through', 'Through', 'wrapThrough'], ['topAndBottom', 'Top and bottom', 'wrapTopBottom'], ['behind', 'Behind text', 'behindText'], ['front', 'In front of text', 'inFront']];
let ids = 0;

export function openLayoutDialog({ engine, image, describe, tab = 'position', kind, apply, frameOf, offsetsFor, place, onClose }) {
  const info = describe(image) || {};
  const frame = info.frame || { inline: !image.anchor };
  const laidOut = image.anchor ? frameOf() : null;
  const formattable = ['picture', 'shape', 'textBox', 'group'].includes(kind);
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const id = () => `pic-layout-${++ids}`;
  const labelled = (text, control) => { control.id ||= id(); return el('label.pic-field', { htmlFor: control.id }, el('span', {}, text), control); };
  const num = (value, attrs = {}) => el('input.input.pic-number', { type: 'number', step: 0.01, value, ...attrs });
  const choice = (options, value, attrs = {}) => el('select.input', attrs, ...options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
  const radio = (name, value, checked, text) => { const input = el('input', { type: 'radio', name, value, checked, id: id() }); return { input, node: el('label.pic-radio', { htmlFor: input.id }, input, text) }; };

  /* ---- Text Wrapping ---- */
  const currentWrap = frame.inline ? 'inline' : frame.wrap?.type === 'none' ? (frame.behind ? 'behind' : 'front') : frame.wrap?.type || 'front';
  const wrapGroup = `pic-wrap-${++ids}`;
  const wrapRadios = WRAPS.map(([value, label, icon]) => {
    const input = el('input', { type: 'radio', name: wrapGroup, value, checked: value === currentWrap, id: id(), disabled: !formattable && ['tight', 'through'].includes(value) });
    return { value, input, node: el('label.pic-wrap-choice', { htmlFor: input.id }, input, commandIconEl(icon, 32), el('span', {}, label)) };
  });
  const wrapValue = () => wrapRadios.find(r => r.input.checked)?.value || currentWrap;
  const sideGroup = `pic-side-${++ids}`;
  const sides = [['bothSides', 'Both sides'], ['left', 'Left only'], ['right', 'Right only'], ['largest', 'Largest only']].map(([value, label]) => radio(sideGroup, value, (frame.wrap?.side || 'bothSides') === value, label));
  const d = frame.wrap?.distances || { T: 0, B: 0, L: 114300, R: 114300 };
  const distance = Object.fromEntries(['T', 'B', 'L', 'R'].map(side => [side, num(inches(d[side] ?? 0), { min: 0, max: 22, 'aria-label': `Distance from text ${{ T: 'top', B: 'bottom', L: 'left', R: 'right' }[side]} (in)` })]));
  const wrapping = el('div.pic-layout-tab', { role: 'tabpanel', 'aria-label': 'Text Wrapping' },
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Wrapping style'), el('div.pic-wrap-grid', {}, ...wrapRadios.map(r => r.node))),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Wrap text'), el('div.pic-radios.is-row', {}, ...sides.map(s => s.node))),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Distance from text (in)'), el('div.pic-grid-2', {},
      labelled('Top', distance.T), labelled('Left', distance.L), labelled('Bottom', distance.B), labelled('Right', distance.R))));

  /* ---- Position ---- */
  const h = frame.horizontal || { relativeFrom: 'column', offset: 0 }, v = frame.vertical || { relativeFrom: 'paragraph', offset: 0 };
  const hGroup = `pic-h-${++ids}`, vGroup = `pic-v-${++ids}`;
  // Aligned axes show their current place as an offset too, so switching keeps the object where it is.
  const offsetOf = axis => {
    const value = axis === 'x' ? h : v;
    if (value.offset !== undefined) return value.offset;
    if (!laidOut) return 0;
    const at = offsetsFor(laidOut, laidOut.x, laidOut.y);
    return axis === 'x' ? at.x : at.y;
  };
  const inlinePlace = frame.inline ? place?.() || { x: 0, y: 0 } : null;
  const hAlignRadio = radio(hGroup, 'align', !!h.align, 'Alignment'), hAbsRadio = radio(hGroup, 'offset', !h.align, 'Absolute position');
  const hAlign = choice([['left', 'Left'], ['center', 'Centered'], ['right', 'Right']], h.align || 'left', { 'aria-label': 'Horizontal alignment' });
  const hAlignFrom = choice([['margin', 'Margin'], ['page', 'Page'], ['column', 'Column']], h.align ? h.relativeFrom : 'column', { 'aria-label': 'Horizontal alignment relative to' });
  const hOffset = num(inches(inlinePlace ? inlinePlace.x : offsetOf('x')), { min: -22, max: 22, 'aria-label': 'Horizontal absolute position (in)' });
  const hOffsetFrom = choice([['column', 'Column'], ['margin', 'Margin'], ['page', 'Page']], h.align ? 'column' : h.relativeFrom, { 'aria-label': 'Horizontal position to the right of' });
  const vAlignRadio = radio(vGroup, 'align', !!v.align, 'Alignment'), vAbsRadio = radio(vGroup, 'offset', !v.align, 'Absolute position');
  const vAlign = choice([['top', 'Top'], ['center', 'Centered'], ['bottom', 'Bottom']], v.align || 'top', { 'aria-label': 'Vertical alignment' });
  const vAlignFrom = choice([['margin', 'Margin'], ['page', 'Page'], ['topMargin', 'Top margin'], ['bottomMargin', 'Bottom margin']], v.align ? v.relativeFrom : 'margin', { 'aria-label': 'Vertical alignment relative to' });
  const vOffset = num(inches(inlinePlace ? inlinePlace.y : offsetOf('y')), { min: -22, max: 22, 'aria-label': 'Vertical absolute position (in)' });
  const vOffsetFrom = choice([['paragraph', 'Paragraph'], ['line', 'Line'], ['margin', 'Margin'], ['page', 'Page']], v.align ? 'paragraph' : v.relativeFrom, { 'aria-label': 'Vertical position below' });
  const optionBox = (label, checked) => { const input = el('input', { type: 'checkbox', checked, id: id() }); return { input, node: el('label.pic-check', { htmlFor: input.id }, input, label) }; };
  const moveWithText = optionBox('Move object with text', !frame.inline ? ['paragraph', 'line'].includes(v.relativeFrom) : true);
  const lockAnchor = optionBox('Lock anchor', !!frame.locked);
  const allowOverlap = optionBox('Allow overlap', frame.allowOverlap !== false);
  const layoutInCell = optionBox('Layout in table cell', frame.layoutInCell !== false);
  moveWithText.input.addEventListener('change', () => {
    // Fixed on the page: measure from the page instead of the paragraph.
    if (!moveWithText.input.checked && ['paragraph', 'line'].includes(vOffsetFrom.value)) vOffsetFrom.value = 'page';
    if (moveWithText.input.checked && !['paragraph', 'line'].includes(vOffsetFrom.value)) vOffsetFrom.value = 'paragraph';
    convertVertical();
  });
  // Changing what an offset measures from keeps the object where it is on the page.
  let lastVerticalFrom = vOffsetFrom.value, lastHorizontalFrom = hOffsetFrom.value;
  function convertVertical() {
    if (!laidOut || vOffsetFrom.value === lastVerticalFrom) return;
    const at = offsetsFor({ ...laidOut, image: { ...laidOut.image, anchor: { ...laidOut.image.anchor, vertical: vOffsetFrom.value } } }, laidOut.x, laidOut.y);
    vOffset.value = String(inches(at.y)); lastVerticalFrom = vOffsetFrom.value;
  }
  vOffsetFrom.addEventListener('change', () => { moveWithText.input.checked = ['paragraph', 'line'].includes(vOffsetFrom.value); convertVertical(); });
  hOffsetFrom.addEventListener('change', () => {
    if (!laidOut || hOffsetFrom.value === lastHorizontalFrom) return;
    const at = offsetsFor({ ...laidOut, image: { ...laidOut.image, anchor: { ...laidOut.image.anchor, horizontal: hOffsetFrom.value } } }, laidOut.x, laidOut.y);
    hOffset.value = String(inches(at.x)); lastHorizontalFrom = hOffsetFrom.value;
  });
  const position = el('div.pic-layout-tab', { role: 'tabpanel', 'aria-label': 'Position' },
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Horizontal'),
      el('div.pic-position-row', {}, hAlignRadio.node, hAlign, el('span.pic-hint', {}, 'relative to'), hAlignFrom),
      el('div.pic-position-row', {}, hAbsRadio.node, el('span.pic-number-wrap', {}, hOffset, el('span.pic-unit', {}, 'in')), el('span.pic-hint', {}, 'to the right of'), hOffsetFrom)),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Vertical'),
      el('div.pic-position-row', {}, vAlignRadio.node, vAlign, el('span.pic-hint', {}, 'relative to'), vAlignFrom),
      el('div.pic-position-row', {}, vAbsRadio.node, el('span.pic-number-wrap', {}, vOffset, el('span.pic-unit', {}, 'in')), el('span.pic-hint', {}, 'below'), vOffsetFrom)),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Options'), el('div.pic-grid-2', {}, moveWithText.node, allowOverlap.node, lockAnchor.node, layoutInCell.node)),
    el('p.pic-hint.pic-position-note', {}));
  const positionNote = position.querySelector('.pic-position-note');

  /* ---- Size ---- */
  const width = num(inches(image.width), { min: 0.01, max: 22, 'aria-label': 'Width (in)' }), height = num(inches(image.height), { min: 0.01, max: 22, 'aria-label': 'Height (in)' });
  const rotation = num(Math.round((info.transform?.rotation ?? (image.rotation || 0) / 60000) * 10) / 10, { min: -3600, max: 3600, step: 1, 'aria-label': 'Rotation (degrees)' });
  const scaleW = num(100, { min: 1, max: 1000, step: 1, 'aria-label': 'Scale width (%)' }), scaleH = num(100, { min: 1, max: 1000, step: 1, 'aria-label': 'Scale height (%)' });
  const lock = optionBox('Lock aspect ratio', image.aspectLocked !== false && (kind === 'picture' || !!image.aspectLocked));
  const ratio = image.width / image.height;
  width.addEventListener('input', () => { if (lock.input.checked && Number(width.value) > 0) height.value = String(Math.round(Number(width.value) / ratio * 100) / 100); scaleW.value = String(Math.round(Number(width.value) * IN / image.width * 100)); if (lock.input.checked) scaleH.value = scaleW.value; });
  height.addEventListener('input', () => { if (lock.input.checked && Number(height.value) > 0) width.value = String(Math.round(Number(height.value) * ratio * 100) / 100); scaleH.value = String(Math.round(Number(height.value) * IN / image.height * 100)); if (lock.input.checked) scaleW.value = scaleH.value; });
  scaleW.addEventListener('input', () => { width.value = String(inches(image.width * Number(scaleW.value) / 100)); if (lock.input.checked) { scaleH.value = scaleW.value; height.value = String(inches(image.height * Number(scaleW.value) / 100)); } });
  scaleH.addEventListener('input', () => { height.value = String(inches(image.height * Number(scaleH.value) / 100)); if (lock.input.checked) { scaleW.value = scaleH.value; width.value = String(inches(image.width * Number(scaleH.value) / 100)); } });
  const source = engine.images?.get(image.assetId), pixels = source?.bitmap || source;
  const original = kind === 'picture' && pixels?.width ? { width: pixels.width * EMU_PER_PX, height: pixels.height * EMU_PER_PX } : null;
  const resetSize = el('button.btn.btn-outline.btn-sm', { type: 'button', disabled: !original, onclick: () => { width.value = String(inches(original.width)); height.value = String(inches(original.height)); scaleW.value = scaleH.value = '100'; rotation.value = '0'; } }, 'Reset');
  const size = el('div.pic-layout-tab', { role: 'tabpanel', 'aria-label': 'Size' },
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Size'), el('div.pic-grid-2', {}, labelled('Height (in)', height), labelled('Width (in)', width))),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Rotate'), labelled('Rotation (°)', rotation)),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Scale'), el('div.pic-grid-2', {}, labelled('Height (%)', scaleH), labelled('Width (%)', scaleW)), lock.node),
    original ? el('fieldset.pic-fieldset', {}, el('legend', {}, 'Original size'), el('div.pic-position-row', {}, el('span', {}, `Height: ${inches(original.height)}″   Width: ${inches(original.width)}″`), resetSize)) : null);

  /* ---- Tabs ---- */
  const panels = { position, wrapping, size };
  const tabList = el('div.pic-dialog-tabs', { role: 'tablist', 'aria-label': 'Layout' });
  const tabButtons = [['position', 'Position'], ['wrapping', 'Text Wrapping'], ['size', 'Size']].map(([key, label]) => {
    const button = el('button.pic-dialog-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { tab: key }, onclick: () => select(key) }, label);
    tabList.append(button); return button;
  });
  tabList.addEventListener('keydown', e => {
    const at = tabButtons.indexOf(document.activeElement); if (at < 0 || isComposing(e)) return;
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : null;
    if (next !== null) { e.preventDefault(); const b = tabButtons[(next + 3) % 3]; b.focus(); select(b.dataset.tab); }
  });
  function select(key) {
    for (const b of tabButtons) { const on = b.dataset.tab === key; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== key;
  }
  function sync() {
    const mode = wrapValue(), floating = mode !== 'inline', wrapped = ['square', 'tight', 'through', 'topAndBottom'].includes(mode), sided = ['square', 'tight', 'through'].includes(mode);
    for (const control of position.querySelectorAll('input, select')) control.disabled = !floating || !formattable;
    // Wrapped objects are measured from the column and paragraph; only floating ones can align or fix to the page.
    if (wrapped) {
      hAbsRadio.input.checked = vAbsRadio.input.checked = true;
      for (const control of [hAlignRadio.input, vAlignRadio.input, hAlign, hAlignFrom, vAlign, vAlignFrom, moveWithText.input]) control.disabled = true;
      if (sided || mode === 'topAndBottom') { hOffsetFrom.value = 'column'; vOffsetFrom.value = 'paragraph'; hOffsetFrom.disabled = vOffsetFrom.disabled = true; }
      moveWithText.input.checked = true;
      allowOverlap.input.disabled = layoutInCell.input.disabled = true;
    }
    positionNote.textContent = !floating ? 'An object in line with the text moves with it. Choose another wrapping style to position it.'
      : wrapped ? 'Text-wrapped objects are positioned from the column and paragraph they belong to.' : '';
    for (const r of sides) r.input.disabled = !sided;
    distance.T.disabled = distance.B.disabled = !(sided || mode === 'front' || mode === 'behind');
    distance.L.disabled = distance.R.disabled = !floating;
  }
  for (const r of wrapRadios) r.input.addEventListener('change', sync);
  for (const r of [hAlignRadio, hAbsRadio, vAlignRadio, vAbsRadio]) r.input.addEventListener('change', sync);

  /* ---- Apply ---- */
  const emu = input => Math.round(Number(input.value) * IN);
  async function submit(e) {
    e.preventDefault();
    error.hidden = true;
    const form = e.target;
    for (const input of form.querySelectorAll('input[type=number]:not(:disabled)')) if (!input.checkValidity() || input.value === '') { input.reportValidity(); return; }
    const mode = wrapValue();
    const spec = mode === 'inline' ? { inline: true } : {
      horizontal: hAlignRadio.input.checked && !hAlignRadio.input.disabled ? { relativeFrom: hAlignFrom.value, align: hAlign.value } : { relativeFrom: hOffsetFrom.value, offset: emu(hOffset) },
      vertical: vAlignRadio.input.checked && !vAlignRadio.input.disabled ? { relativeFrom: vAlignFrom.value, align: vAlign.value } : { relativeFrom: vOffsetFrom.value, offset: emu(vOffset) },
      wrap: { type: mode === 'behind' || mode === 'front' ? 'none' : mode, side: sides.find(s => s.input.checked)?.input.value || 'bothSides',
        distances: { T: mode === 'topAndBottom' ? 0 : emu(distance.T), B: mode === 'topAndBottom' ? 0 : emu(distance.B), L: emu(distance.L), R: emu(distance.R) } },
      behind: mode === 'behind', locked: lockAnchor.input.checked,
      ...(mode === 'front' || mode === 'behind' ? { allowOverlap: allowOverlap.input.checked, layoutInCell: layoutInCell.input.checked } : { allowOverlap: true, layoutInCell: true }),
      ...(frame.inline ? { order: Math.max(0, ...engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image?.anchor).map(r => r.image.anchor.order || 0)) + 1 } : {}),
    };
    const nextWidth = emu(width), nextHeight = emu(height), turn = Number(rotation.value);
    try {
    await apply(async drawing => {
      writeFrame(drawing, spec);
      const after = drawingParts(drawing);
      if (nextWidth !== image.width || nextHeight !== image.height) {
        const extent = child(after.frame, WP, 'extent');
        extent.setAttribute('cx', String(nextWidth)); extent.setAttribute('cy', String(nextHeight));
        const ext = child(child(after.properties, A, 'xfrm'), A, 'ext');
        if (ext) { ext.setAttribute('cx', String(nextWidth)); ext.setAttribute('cy', String(nextHeight)); }
      }
      if (after.properties && Math.abs(turn - (info.transform?.rotation || 0)) > 0.001) setTransform(after.properties, { rotation: turn });
      // Aspect lock (§20.1.2.2.19 graphicFrameLocks noChangeAspect).
      let locks = child(after.frame, WP, 'cNvGraphicFramePr');
      if (!locks) { locks = make(drawing.ownerDocument, WP, 'cNvGraphicFramePr'); after.frame.insertBefore(locks, child(after.frame, A, 'graphic')); }
      let frameLocks = child(locks, A, 'graphicFrameLocks');
      if (lock.input.checked) { if (!frameLocks) { frameLocks = make(drawing.ownerDocument, A, 'graphicFrameLocks'); frameLocks.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:a', A); locks.append(frameLocks); } frameLocks.setAttribute('noChangeAspect', '1'); }
      else if (frameLocks) { frameLocks.removeAttribute('noChangeAspect'); if (!frameLocks.attributes.length || [...frameLocks.attributes].every(a => a.name.startsWith('xmlns'))) frameLocks.remove(); }
      // A picture's own lock follows the frame's.
      const picLocks = after.picture?.getElementsByTagNameNS(A, 'picLocks')[0];
      if (picLocks) { if (lock.input.checked) picLocks.setAttribute('noChangeAspect', '1'); else picLocks.removeAttribute('noChangeAspect'); }
    }, 'Layout');
      modal.close();
    } catch (failure) {
      error.textContent = /pictures with|drawing|floating|unsupported|could not be created/i.test(failure.message) && !/Select|changed/.test(failure.message)
        ? 'This combination of position and wrapping is not available for this object. Try another wrapping style or position.' : failure.message;
      error.hidden = false;
    }
  }
  const content = el('form.pic-layout-dialog', { onsubmit: submit }, tabList, position, wrapping, size, error,
    !formattable ? el('p.pic-hint', {}, 'This object keeps its own layout settings; only its wrapping can change from the Wrap Text menu.') : null,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit', disabled: !formattable }, 'OK')));
  const modal = openModal({ title: 'Layout', content, wide: true, onClose });
  select(tab === 'wrapping' ? 'wrapping' : tab === 'size' ? 'size' : 'position');
  sync();
  queueMicrotask(() => tabButtons.find(b => b.getAttribute('aria-selected') === 'true')?.focus());
  return modal;
}
