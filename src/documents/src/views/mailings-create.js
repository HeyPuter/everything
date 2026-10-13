/**
 * Create group: the Envelopes and Labels dialogs, with live previews, and their option dialogs for
 * envelope and label main documents.
 */
import { el } from '../ui/dom.js';
import { dialog, field, select, input, textarea, checkbox, radios, button, printHtml, html } from './mailings-ui.js';
import { ENVELOPE_SIZES, LABEL_LAYOUTS, SHEETS, layoutProblems } from '../engine/mail-documents.js';

const IN = 1440, MM = 1440 / 25.4;
const RETURN_KEY = 'documents.mailings.returnAddress';
const LAYOUT_KEY = 'documents.mailings.labelLayout';
const ENVELOPE_KEY = 'documents.mailings.envelope';
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Private windows keep nothing. */ } };
const round = (n, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);
const SVG = 'http://www.w3.org/2000/svg';
const svg = (name, attrs = {}, ...children) => { const node = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); node.append(...children); return node; };

/** Default delivery-address position on an envelope (twips from the top-left corner). */
export const deliveryPosition = (width, height) => ({ left: Math.round(width * 0.42), top: Math.round(height * 0.46) });

/** A measurement input in inches. */
const inches = (twips, label, attrs = {}) => input(round(twips / IN, 3), { type: 'number', step: 'any', min: 0, max: 22, 'aria-label': `${label} (in)`, ...attrs });
const readInches = node => { const n = Number(node.value); if (!Number.isFinite(n) || n < 0) throw new Error('Enter measurements as positive numbers.'); return Math.round(n * IN); };

/**
 * Envelopes. mode 'create' offers Print, New Document and Add to Document; mode 'merge' (envelope
 * main documents) asks only for size and return address and calls onSubmit with the options.
 */
export function openEnvelopes({ mode = 'create', delivery: initialDelivery = '', onAdd, onNew, onSubmit }) {
  const saved = (() => { try { return JSON.parse(stored(ENVELOPE_KEY) || '{}'); } catch { return {}; } })();
  const size = select([...ENVELOPE_SIZES.map(s => [s.id, s.name]), ['custom', 'Custom size']], saved.size || 'us10', { 'aria-label': 'Envelope size' });
  const width = inches(ENVELOPE_SIZES[0].width, 'Width'), height = inches(ENVELOPE_SIZES[0].height, 'Height');
  const delivery = textarea(initialDelivery, { 'aria-label': 'Delivery address', rows: 5 });
  const returnAddress = textarea(stored(RETURN_KEY) || '', { 'aria-label': 'Return address', rows: 4 });
  const omit = checkbox('Omit the return address', !!saved.omit);
  const left = inches(0, 'Delivery address from left'), top = inches(0, 'Delivery address from top');
  const fontSize = select([['10', '10 pt'], ['11', '11 pt'], ['12', '12 pt'], ['14', '14 pt']], saved.fontSize || '12', { 'aria-label': 'Font size' });
  const preview = svg('svg', { class: 'mm-envelope-preview', role: 'img', 'aria-label': 'Envelope preview' });
  const dims = () => {
    const preset = ENVELOPE_SIZES.find(s => s.id === size.value);
    return preset ? { width: preset.width, height: preset.height } : { width: readInches(width), height: readInches(height) };
  };
  const resetPosition = () => { const d = dims(), p = deliveryPosition(d.width, d.height); left.value = round(p.left / IN, 3); top.value = round(p.top / IN, 3); };
  const onSize = () => {
    const preset = ENVELOPE_SIZES.find(s => s.id === size.value);
    width.disabled = height.disabled = !!preset;
    if (preset) { width.value = round(preset.width / IN, 3); height.value = round(preset.height / IN, 3); }
    resetPosition(); draw();
  };
  function draw() {
    let d; try { d = dims(); } catch { return; }
    const w = d.width / IN, h = d.height / IN, pt = Number(fontSize.value) / 72;
    const lines = (text, x, y, scale = 1) => String(text).split('\n').map((line, i) => svg('text', { x, y: y + (i + 1) * pt * 1.2 * scale, 'font-size': pt * scale }, line));
    const deliveryText = mode === 'merge' ? '«AddressBlock»' : delivery.value;
    let l = 0, t = 0; try { l = readInches(left) / IN; t = readInches(top) / IN; } catch { /* drawn when valid */ }
    preview.setAttribute('viewBox', `-0.1 -0.1 ${w + 0.2} ${h + 0.2}`);
    preview.replaceChildren(
      svg('rect', { x: 0, y: 0, width: w, height: h, rx: 0.05, class: 'mm-paper' }),
      svg('rect', { x: w - 0.95, y: 0.25, width: 0.7, height: 0.85, class: 'mm-stamp' }),
      ...(omit.input.checked ? [] : lines(returnAddress.value, 0.4, 0.3, 0.85)),
      ...lines(deliveryText, l, t));
  }
  for (const c of [delivery, returnAddress, left, top, width, height]) c.addEventListener('input', draw);
  for (const c of [fontSize]) c.addEventListener('change', draw);
  omit.input.addEventListener('change', () => { returnAddress.disabled = omit.input.checked; draw(); });
  size.addEventListener('change', onSize);
  for (const c of [width, height]) c.addEventListener('change', () => { resetPosition(); draw(); });
  returnAddress.disabled = omit.input.checked;
  onSize();
  const options = () => {
    const d = dims();
    if (d.width < 3 * IN || d.height < 2.5 * IN || d.width > 22 * IN || d.height > 22 * IN) throw new Error('Envelopes must be between 3 × 2½ in and 22 × 22 in.');
    store(RETURN_KEY, returnAddress.value); store(ENVELOPE_KEY, JSON.stringify({ size: size.value, omit: omit.input.checked, fontSize: fontSize.value }));
    return { width: d.width, height: d.height, delivery: delivery.value, returnAddress: returnAddress.value, omitReturn: omit.input.checked, deliveryLeft: readInches(left), deliveryTop: readInches(top), fontSize: Number(fontSize.value) };
  };
  const requireDelivery = o => { if (mode === 'create' && !o.delivery.trim()) throw new Error('Type the delivery address.'); return o; };
  const printEnvelope = () => {
    const o = requireDelivery(options()), w = o.width / IN, h = o.height / IN;
    const block = (text, x, y, size) => `<div class="block" style="left:${x}in;top:${y}in;font-size:${size}pt">${html(text)}</div>`;
    printHtml(`<div class="sheet">${o.omitReturn ? '' : block(o.returnAddress, 0.4, 0.3, o.fontSize - 2)}${block(o.delivery, o.deliveryLeft / IN, o.deliveryTop / IN, o.fontSize)}</div>`, { width: w, height: h, title: 'Envelope' });
  };
  const body = [
    el('div.mm-two', {},
      el('div', {},
        mode === 'create' ? field('Delivery address', delivery) : el('p.field-hint', {}, 'Each envelope gets the recipient’s address from an Address Block field.'),
        field('Return address', returnAddress), omit),
      el('div', {}, el('p.field-label', {}, 'Preview'), preview,
        el('div.mm-inline', {}, field('Envelope size', size), field('Font size', fontSize)),
        el('div.mm-inline', {}, field('Width (in)', width), field('Height (in)', height)),
        el('div.mm-inline', {}, field('Address from left (in)', left), field('Address from top (in)', top)),
        el('p.field-hint', {}, 'Printing uses a page the size of the envelope. Feed it the way your printer’s manual describes, and pick the matching paper size if the print dialog asks.'))),
  ];
  if (mode === 'merge') return dialog({ title: 'Envelope Options', size: 'xwide', submit: 'OK', body, onSubmit: () => onSubmit(options()) });
  const modal = dialog({ title: 'Envelopes', size: 'xwide', submit: 'Add to Document', body,
    actions: [button('Print…', () => { try { printEnvelope(); } catch (e) { modal.error(e.message); } }), button('New Document', async () => { try { const o = requireDelivery(options()); modal.close(); await onNew(o); } catch (e) { modal.error(e.message); } })],
    onSubmit: () => onAdd(requireDelivery(options())) });
  return modal;
}

/** The label layout chooser with measurement details and a sheet preview. Returns { node, layout() }. */
function layoutPicker(onChange = () => {}, text = () => '') {
  const groups = Object.entries(SHEETS).map(([id, sheet]) => el('optgroup', { label: sheet.name }, ...LABEL_LAYOUTS.filter(l => l.sheet === id).map(l => el('option', { value: l.id }, l.name))));
  const choice = el('select.input', { 'aria-label': 'Label sheet' }, ...groups, el('option', { value: 'custom' }, 'Custom measurements'));
  choice.value = LABEL_LAYOUTS.some(l => l.id === stored(LAYOUT_KEY)) ? stored(LAYOUT_KEY) : 'letter-30';
  const sheet = select(Object.entries(SHEETS).map(([id, s]) => [id, s.name]), 'letter', { 'aria-label': 'Page size' });
  const num = (label, attrs = {}) => input('', { type: 'number', step: 'any', min: 0, 'aria-label': label, ...attrs });
  const inputs = { width: num('Label width'), height: num('Label height'), top: num('Top margin'), left: num('Side margin'), pitchX: num('Horizontal pitch'), pitchY: num('Vertical pitch'), columns: num('Labels across', { step: 1, min: 1, max: 10 }), rows: num('Labels down', { step: 1, min: 1, max: 40 }) };
  const unit = el('span.mm-unit');
  const preview = svg('svg', { class: 'mm-sheet-preview', role: 'img', 'aria-label': 'Label sheet preview' });
  let current = null, highlight = null;
  const scale = u => u === 'mm' ? MM : IN;
  const show = layout => {
    current = layout;
    const s = scale(layout.unit);
    for (const key of ['width', 'height', 'top', 'left', 'pitchX', 'pitchY']) inputs[key].value = round(layout[key] / s, layout.unit === 'mm' ? 2 : 4);
    inputs.columns.value = layout.columns; inputs.rows.value = layout.rows;
    sheet.value = layout.sheet; unit.textContent = layout.unit === 'mm' ? 'Measurements in millimeters' : 'Measurements in inches';
    draw();
  };
  const read = () => {
    const base = LABEL_LAYOUTS.find(l => l.id === choice.value) || current || LABEL_LAYOUTS[0];
    if (choice.value !== 'custom') return base;
    const s = scale(current?.unit || 'in');
    const layout = { id: 'custom', name: 'Custom', unit: current?.unit || 'in', sheet: sheet.value, columns: Math.round(Number(inputs.columns.value)), rows: Math.round(Number(inputs.rows.value)) };
    for (const key of ['width', 'height', 'top', 'left', 'pitchX', 'pitchY']) layout[key] = Number(inputs[key].value) * s;
    return layout;
  };
  function draw() {
    let layout; try { layout = read(); } catch { return; }
    const page = SHEETS[layout.sheet] || SHEETS.letter, w = page.width / IN, h = page.height / IN;
    preview.setAttribute('viewBox', `-0.1 -0.1 ${w + 0.2} ${h + 0.2}`);
    const rects = [];
    for (let r = 0; r < Math.min(layout.rows, 40); r++) for (let c = 0; c < Math.min(layout.columns, 10); c++) {
      const on = highlight && highlight.row === r + 1 && highlight.column === c + 1;
      const x = (layout.left + c * layout.pitchX) / IN, y = (layout.top + r * layout.pitchY) / IN, lw = layout.width / IN, lh = layout.height / IN;
      rects.push(svg('rect', { x, y, width: lw, height: lh, rx: Math.min(0.08, lh / 6), class: on ? 'mm-label is-on' : 'mm-label' }));
      // The label's text, to scale, where it will print.
      const lines = (highlight && !on) ? [] : String(text() || '').split('\n').filter(Boolean).slice(0, 6);
      const size = Math.min(10 / 72, lh / Math.max(lines.length, 1) / 1.3);
      lines.forEach((line, i) => rects.push(svg('text', { x: x + 0.06, y: y + (lh - lines.length * size * 1.2) / 2 + (i + 0.85) * size * 1.2, 'font-size': size, class: 'mm-label-text' }, line.slice(0, 60))));
    }
    preview.replaceChildren(svg('rect', { x: 0, y: 0, width: w, height: h, class: 'mm-paper' }), ...rects);
    onChange(layout);
  }
  choice.addEventListener('change', () => { if (choice.value !== 'custom') show(LABEL_LAYOUTS.find(l => l.id === choice.value)); else draw(); });
  for (const node of [...Object.values(inputs), sheet]) node.addEventListener('input', () => { choice.value = 'custom'; draw(); });
  sheet.addEventListener('change', () => { choice.value = 'custom'; draw(); });
  show(LABEL_LAYOUTS.find(l => l.id === choice.value) || LABEL_LAYOUTS[0]);
  const details = el('details.mm-details', {}, el('summary', {}, 'Measurements'), unit,
    el('div.mm-measure-grid', {}, field('Page size', sheet), field('Label width', inputs.width), field('Label height', inputs.height), field('Top margin', inputs.top), field('Side margin', inputs.left),
      field('Horizontal pitch', inputs.pitchX), field('Vertical pitch', inputs.pitchY), field('Labels across', inputs.columns), field('Labels down', inputs.rows)),
    el('p.field-hint', {}, 'Pitch is the distance from the start of one label to the start of the next.'));
  return {
    node: el('div.mm-layout', {}, field('Label sheet', choice), details), preview,
    layout() { const layout = read(); const problems = layoutProblems(layout); if (problems.length) throw new Error(problems[0]); if (choice.value !== 'custom') store(LAYOUT_KEY, choice.value); return layout; },
    highlight(spot) { highlight = spot; draw(); },
  };
}

/**
 * Labels. mode 'create': address text, full page or one label, Print and New Document.
 * mode 'merge': layout only (Label Options), then onSubmit(layout).
 */
export function openLabels({ mode = 'create', address: initial = '', onNew, onSubmit }) {
  const address = textarea(initial, { 'aria-label': 'Address', rows: 5 });
  const useReturn = checkbox('Use the return address');
  const which = radios('Print', [['full', 'Full page of the same label'], ['single', 'A single label']], 'full', () => sync());
  const row = input('1', { type: 'number', min: 1, max: 40, 'aria-label': 'Row' }), column = input('1', { type: 'number', min: 1, max: 10, 'aria-label': 'Column' });
  const picker = layoutPicker(layout => { row.max = layout.rows; column.max = layout.columns; }, () => address.value);
  address.addEventListener('input', () => sync());
  const fontSize = select([['8', '8 pt'], ['9', '9 pt'], ['10', '10 pt'], ['11', '11 pt'], ['12', '12 pt'], ['14', '14 pt']], '10', { 'aria-label': 'Font size' });
  function sync() {
    row.disabled = column.disabled = which.value !== 'single';
    picker.highlight(which.value === 'single' ? { row: Number(row.value), column: Number(column.value) } : null);
  }
  for (const c of [row, column]) c.addEventListener('input', sync);
  useReturn.input.addEventListener('change', () => { if (useReturn.input.checked) address.value = stored(RETURN_KEY) || ''; sync(); });
  sync();
  if (mode === 'merge') return dialog({ title: 'Label Options', size: 'xwide', body: [el('div.mm-two', {}, el('div', {}, picker.node, field('Font size', fontSize)), el('div', {}, el('p.field-label', {}, 'Preview'), picker.preview))],
    onSubmit: () => onSubmit(picker.layout(), { fontSize: Number(fontSize.value) }) });
  const options = () => {
    const layout = picker.layout();
    if (!address.value.trim()) throw new Error('Type the text for the labels.');
    const single = which.value === 'single' ? { row: Number(row.value), column: Number(column.value) } : null;
    if (single && (single.row < 1 || single.row > layout.rows || single.column < 1 || single.column > layout.columns)) throw new Error(`Choose a row from 1 to ${layout.rows} and a column from 1 to ${layout.columns}.`);
    return { layout, text: address.value, single, fontSize: Number(fontSize.value) };
  };
  const print = () => {
    const o = options(), page = SHEETS[o.layout.sheet] || SHEETS.letter, blocks = [];
    for (let r = 0; r < o.layout.rows; r++) for (let c = 0; c < o.layout.columns; c++) {
      if (o.single && (o.single.row !== r + 1 || o.single.column !== c + 1)) continue;
      const x = (o.layout.left + c * o.layout.pitchX) / IN, y = (o.layout.top + r * o.layout.pitchY) / IN;
      blocks.push(`<div class="block" style="left:${x + 0.06}in;top:${y}in;width:${o.layout.width / IN - 0.12}in;height:${o.layout.height / IN}in;display:flex;align-items:center;font-size:${o.fontSize}pt"><div>${html(o.text)}</div></div>`);
    }
    printHtml(`<div class="sheet">${blocks.join('')}</div>`, { width: page.width / IN, height: page.height / IN, title: 'Labels' });
  };
  const modal = dialog({ title: 'Labels', size: 'xwide', submit: 'New Document', body: [
    el('div.mm-two', {},
      el('div', {}, field('Address', address), useReturn, el('p.field-label', {}, 'Print'), which, el('div.mm-inline', {}, field('Row', row), field('Column', column)), field('Font size', fontSize)),
      el('div', {}, picker.node, el('p.field-label', {}, 'Preview'), picker.preview)),
  ], actions: [button('Print…', () => { try { print(); } catch (e) { modal.error(e.message); } })], onSubmit: () => onNew(options()) });
  return modal;
}
