import { el, isComposing } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { PAPER_SIZES, validatePageSettings, readingPageSize } from '../engine/page-settings.js';
import { recallUnit } from '../lib/units.js';

/** Twips per display unit. */
const PER_UNIT = { in: 1440, cm: 1440 / 2.54 };
export const MULTIPLE_PAGES = [['normal', 'Normal'], ['mirror', 'Mirror margins'], ['twoOnOne', '2 pages per sheet'], ['bookFold', 'Book fold'], ['reverseBookFold', 'Reverse book fold']];
export const SECTION_STARTS = [['continuous', 'Continuous'], ['nextPage', 'New page'], ['evenPage', 'Even page'], ['oddPage', 'Odd page']];
export const VERTICAL_ALIGNMENTS = [['top', 'Top'], ['center', 'Center'], ['both', 'Justified'], ['bottom', 'Bottom']];

/** How a document's pages are arranged on paper, as one choice. */
export function multiplePagesOf(s) {
  return s.bookFoldRevPrinting ? 'reverseBookFold' : s.bookFoldPrinting ? 'bookFold' : s.printTwoOnOne ? 'twoOnOne' : s.mirrorMargins ? 'mirror' : 'normal';
}
export function multiplePagesSettings(mode) {
  return { mirrorMargins: mode === 'mirror', printTwoOnOne: mode === 'twoOnOne', bookFoldPrinting: mode === 'bookFold', bookFoldRevPrinting: mode === 'reverseBookFold' };
}

/**
 * The Page Setup dialog: paper, margins and page arrangement on one tab, section layout on another,
 * with a live preview.
 * settings: the page settings of the section holding the caret.
 * apply(patch, { scope, stories }) changes only the settings the dialog changed, in the chosen scope,
 * and returns false when they cannot be applied.
 * options: { unit, tab ('page' | 'layout'), scopes: [[id, label]], scope, firstSection, stories: { firstPageDifferent, evenAndOdd } | null,
 *   lineNumbers(), borders(), setDefault(settings) }
 * Untouched measurements keep their exact stored values, including imported sizes other producers rounded.
 */
export function openPageSetup(settings, apply, options = {}) {
  const unit = options.unit || recallUnit(), per = PER_UNIT[unit] || 1440;
  const inputs = {}, originals = {};
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const write = (key, twips) => {
    const text = String(Number((twips / per).toFixed(unit === 'cm' ? 3 : 5)));
    inputs[key].value = text;
    originals[key] = { text, twips };
  };
  const read = key => inputs[key].value === originals[key].text ? originals[key].twips : Math.round(Number(inputs[key].value) * per);
  const measure = (key, label, { min = 0, max = 22 } = {}) => {
    inputs[key] = el('input.input', { type: 'number', required: true, step: unit === 'cm' ? 0.01 : 0.01, min: min * (unit === 'cm' ? 2.54 : 1), max: max * (unit === 'cm' ? 2.54 : 1), 'aria-label': `${label} (${unit})`,
      oninput: () => { if (['width', 'height'].includes(key)) paper.value = matchPaper(); preview(); } });
    write(key, settings[key]);
    const caption = el('span.field-label', {}, `${label} (${unit})`);
    const field = el('label.field', {}, caption, inputs[key]);
    field.caption = caption;
    return field;
  };

  /* ---- Margins ---- */
  const top = measure('top', 'Top margin', { min: -22 }), bottom = measure('bottom', 'Bottom margin', { min: -22 });
  const left = measure('left', 'Left margin'), right = measure('right', 'Right margin');
  const gutter = measure('gutter', 'Gutter');
  const gutterPosition = el('select.input', { 'aria-label': 'Gutter position', onchange: preview },
    el('option', { value: 'left' }, 'Left'), el('option', { value: 'top' }, 'Top'));
  gutterPosition.value = settings.gutterAtTop ? 'top' : 'left';
  const orientation = el('select.input', { 'aria-label': 'Page orientation', onchange: () => {
    const w = read('width'), h = read('height');
    write('width', h); write('height', w);
    paper.value = matchPaper(); preview();
  } }, ...['portrait', 'landscape'].map(value => el('option', { value, selected: value === settings.orientation }, value[0].toUpperCase() + value.slice(1))));
  const pages = el('select.input', { 'aria-label': 'Multiple pages', onchange: () => {
    // A booklet folds a landscape sheet in half.
    if (['bookFold', 'reverseBookFold'].includes(pages.value) && orientation.value === 'portrait') { orientation.value = 'landscape'; orientation.dispatchEvent(new Event('change')); }
    preview();
  } }, ...MULTIPLE_PAGES.map(([value, label]) => el('option', { value }, label)));
  pages.value = multiplePagesOf(settings);
  /* ---- Paper ---- */
  const width = measure('width', 'Width', { min: 1 }), height = measure('height', 'Height', { min: 1 });
  const paper = el('select.input', { 'aria-label': 'Paper size', onchange: () => {
    const size = PAPER_SIZES[paper.value];
    if (!size) return;
    const [w, h] = orientation.value === 'landscape' ? [...size].reverse() : size;
    write('width', w); write('height', h); preview();
  } }, ...[...Object.keys(PAPER_SIZES), 'Custom'].map(value => el('option', { value }, value === 'Custom' ? 'Custom size' : value)));
  function matchPaper() {
    const w = read('width'), h = read('height');
    return Object.entries(PAPER_SIZES).find(([, dims]) => {
      const [pw, ph] = orientation.value === 'landscape' ? [...dims].reverse() : dims;
      return Math.abs(pw - w) <= 2 && Math.abs(ph - h) <= 2;
    })?.[0] || 'Custom';
  }
  paper.value = matchPaper();
  // Paper, orientation and margins share one tab: everything that shapes the page is in view together.
  const pagePanel = panel('page', 'Page',
    el('fieldset.ps-group', {}, el('legend', {}, 'Paper'), el('div.canvas-page-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Paper size'), paper),
      el('label.field', {}, el('span.field-label', {}, 'Orientation'), orientation), width, height)),
    el('fieldset.ps-group', {}, el('legend', {}, 'Margins'), el('div.canvas-page-fields', {}, top, bottom, left, right, gutter,
      el('label.field', {}, el('span.field-label', {}, 'Gutter position'), gutterPosition))),
    el('fieldset.ps-group', {}, el('legend', {}, 'Pages'), el('label.field', {}, el('span.field-label', {}, 'Multiple pages'), pages)));

  /* ---- Layout ---- */
  const start = el('select.input', { 'aria-label': 'Section start', disabled: !!options.firstSection, title: options.firstSection ? 'The first section always starts on the first page.' : '' },
    ...SECTION_STARTS.map(([value, label]) => el('option', { value }, label)));
  start.value = settings.sectionType;
  const stories = options.stories;
  const evenOdd = el('input', { type: 'checkbox', checked: !!stories?.evenAndOdd, disabled: !stories });
  const firstPage = el('input', { type: 'checkbox', checked: !!stories?.firstPageDifferent, disabled: !stories });
  const headerDistance = measure('header', 'Header'), footerDistance = measure('footer', 'Footer');
  const vertical = el('select.input', { 'aria-label': 'Vertical alignment', onchange: preview }, ...VERTICAL_ALIGNMENTS.map(([value, label]) => el('option', { value }, label)));
  vertical.value = settings.verticalAlignment;
  const extra = (label, run) => el('button.btn.btn-outline', { type: 'button', disabled: !run, onclick: () => run?.() }, label);
  const layoutPanel = panel('layout', 'Layout',
    el('fieldset.ps-group', {}, el('legend', {}, 'Section'), el('label.field', {}, el('span.field-label', {}, 'Section start'), start)),
    el('fieldset.ps-group', {}, el('legend', {}, 'Headers and footers'),
      el('label.ed-check', {}, evenOdd, 'Different odd and even pages'), el('label.ed-check', {}, firstPage, 'Different first page'),
      el('div.canvas-page-fields', {}, headerDistance, footerDistance),
      el('p.field-hint', {}, 'Header and footer distances are measured from the edge of the page.')),
    el('fieldset.ps-group', {}, el('legend', {}, 'Page'), el('label.field', {}, el('span.field-label', {}, 'Vertical alignment'), vertical)),
    el('div.ps-buttons', {}, extra('Line Numbers…', options.lineNumbers), extra('Borders…', options.borders)));

  /* ---- Tabs, preview and scope ---- */
  const tabs = [['page', 'Page', pagePanel], ['layout', 'Layout', layoutPanel]];
  function panel(id, label, ...children) { return el('div.ed-font-panel.ps-panel', { role: 'tabpanel', id: `ps-tab-${id}`, 'aria-labelledby': `ps-tab-${id}-button`, hidden: true }, ...children); }
  const tabButtons = tabs.map(([id, label, node], i) => el('button.ed-font-tab', { type: 'button', role: 'tab', id: `ps-tab-${id}-button`, 'aria-controls': node.id,
    onclick: () => show(id), onkeydown: e => {
      if (isComposing(e) || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      e.preventDefault(); const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; show(tabs[next][0]); tabButtons[next].focus();
    } }, label));
  function show(id) {
    tabs.forEach(([tab, , node], i) => { const on = tab === id; node.hidden = !on; tabButtons[i].setAttribute('aria-selected', String(on)); tabButtons[i].tabIndex = on ? 0 : -1; });
  }
  const scopes = options.scopes?.length ? options.scopes : [['document', 'Whole document']];
  const scope = el('select.input', { 'aria-label': 'Apply to' }, ...scopes.map(([value, label]) => el('option', { value }, label)));
  scope.value = options.scope && scopes.some(([value]) => value === options.scope) ? options.scope : scopes[0][0];
  const sheet = el('div.ps-preview-sheet', { 'aria-hidden': 'true' });
  const previewBox = el('div.ps-preview', { role: 'img', 'aria-label': 'Page preview' }, sheet);

  /** The settings as the dialog now describes them; only fields that changed. */
  function changes() {
    const patch = {};
    for (const key of Object.keys(inputs)) if (read(key) !== settings[key]) patch[key] = read(key);
    if (orientation.value !== settings.orientation) patch.orientation = orientation.value;
    const arrangement = multiplePagesSettings(pages.value);
    for (const [key, value] of Object.entries(arrangement)) if (value !== settings[key]) patch[key] = value;
    if ((gutterPosition.value === 'top') !== settings.gutterAtTop) patch.gutterAtTop = gutterPosition.value === 'top';
    if (!start.disabled && start.value !== settings.sectionType) patch.sectionType = start.value;
    if (vertical.value !== settings.verticalAlignment) patch.verticalAlignment = vertical.value;
    return patch;
  }
  function storyChanges() {
    if (!stories) return null;
    const next = {};
    if (evenOdd.checked !== !!stories.evenAndOdd) next.evenAndOdd = evenOdd.checked;
    if (firstPage.checked !== !!stories.firstPageDifferent) next.firstPageDifferent = firstPage.checked;
    return Object.keys(next).length ? next : null;
  }
  function preview() {
    // Mirrored and booklet pages put the gutter inside; their side margins read as inside and outside.
    const mirrored = ['mirror', 'bookFold', 'reverseBookFold'].includes(pages.value);
    left.caption.textContent = `${mirrored ? 'Inside' : 'Left'} margin (${unit})`; inputs.left.setAttribute('aria-label', left.caption.textContent);
    right.caption.textContent = `${mirrored ? 'Outside' : 'Right'} margin (${unit})`; inputs.right.setAttribute('aria-label', right.caption.textContent);
    gutterPosition.disabled = mirrored;
    let next;
    try { next = validatePageSettings({ ...settings, ...changes() }); } catch { sheet.replaceChildren(); return; }
    const [w, h] = readingPageSize(next), scale = 96 / Math.max(w, h);
    const box = (x, y, bw, bh, cls) => el(`span.${cls}`, { style: { left: `${x * scale}px`, top: `${y * scale}px`, width: `${Math.max(0, bw) * scale}px`, height: `${Math.max(0, bh) * scale}px` } });
    const g = next.gutter, atTop = next.gutterAtTop && !mirrored;
    const l = next.left + (atTop ? 0 : g), t = Math.abs(next.top) + (atTop ? g : 0);
    const spread = mirrored || pages.value === 'twoOnOne';
    const one = (dx, swap) => {
      const page = el('span.ps-page', { style: { left: `${dx}px`, width: `${w * scale}px`, height: `${h * scale}px` } },
        box(swap ? next.right : l, t, w - next.left - next.right - (atTop ? 0 : g), h - t - Math.abs(next.bottom), 'ps-text'));
      if (g && !atTop) page.append(box(swap ? w - g : 0, 0, g, h, 'ps-gutter'));
      if (g && atTop) page.append(box(0, 0, w, g, 'ps-gutter'));
      return page;
    };
    sheet.style.width = `${(spread ? 2 : 1) * w * scale + (spread ? 4 : 0)}px`; sheet.style.height = `${h * scale}px`;
    sheet.style.alignItems = { top: 'flex-start', center: 'center', both: 'stretch', bottom: 'flex-end' }[vertical.value] || '';
    sheet.replaceChildren(...(spread ? [one(0, mirrored), one(w * scale + 4, false)] : [one(0, false)]));
  }

  const setDefault = options.setDefault && el('button.btn.btn-ghost.ps-default', { type: 'button', onclick: () => {
    try { options.setDefault(validatePageSettings({ ...settings, ...changes() })); error.hidden = true; }
    catch (e) { error.textContent = e.message; error.hidden = false; }
  } }, 'Set As Default');
  const content = el('form.ed-dialog-body.ps-dialog', { onsubmit: e => {
    e.preventDefault();
    if (!content.reportValidity()) return;
    try {
      const patch = changes(), storyPatch = storyChanges();
      validatePageSettings({ ...settings, ...patch });
      if (Object.keys(patch).length && apply(patch, { scope: scope.value, stories: storyPatch }) === false) throw new Error('These page settings cannot fit the current text. Adjust the margins or page size.');
      if (!Object.keys(patch).length && storyPatch) apply({}, { scope: scope.value, stories: storyPatch });
      modal.close();
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  } },
  el('div.ed-font-tabs', { role: 'tablist', 'aria-label': 'Page setup' }, ...tabButtons),
  el('div.ps-body', {}, el('div.ps-panels', {}, pagePanel, layoutPanel),
    el('div.ps-side', {}, el('span.field-label', {}, 'Preview'), previewBox,
      el('label.field', {}, el('span.field-label', {}, 'Apply to'), scope))),
  ...((settings.bookFoldPrinting || settings.bookFoldRevPrinting) ? [el('p.field-hint', {}, 'In a booklet, width and height describe each reading page. Without a top gutter, landscape booklets alternate margins and add the gutter to the saved right margin.')] : []),
  el('p.field-hint', {}, 'Negative top and bottom margins keep their saved sign and the same distance from the page edge.'),
  error,
  el('div.row.ps-actions', {}, setDefault || el('span'),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Apply'))));
  show(options.tab === 'layout' ? 'layout' : 'page');
  preview();
  const modal = openModal({ title: 'Page setup', content, wide: true, onClose: () => {
    const root = modal.panel.closest('.modal-root');
    root?.setAttribute('inert', ''); root?.setAttribute('aria-hidden', 'true');
  } });
  return modal;
}
