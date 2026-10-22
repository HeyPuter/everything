/**
 * Page Layout view: the sheet shown as the pages it prints on (View ▸ Page Layout).
 *
 * The grid lays the cells out page by page (see grid.setPageLayout); this module says where the pages
 * break and how large the paper, margins and print scale are, from the sheet's own page setup, and
 * draws what lies around the cells: the paper, the header and footer in each page's margins (each of
 * their left, center and right sections editable in place), and the rulers in inches.
 */
import { el } from './dom.js';
import { printBands, printTitleStarts, quantizePrintScale } from './print-pagination.js';
import { printPageText, splitPrintSections, printRange, manualBreaksApply, effectivePrintSettings } from './print.js';
import { MAX_ROW, MAX_COL } from '../core/refs.js';
import { richHeaderSections } from './print-header.js';

export const PX_PER_INCH = 96;
export const PAGE_GAP = 12; // unzoomed pixels of grey between pages

// Paper sizes by SpreadsheetML paperSize code, in inches across × down (portrait).
const MM = 1 / 25.4;
const PAPER_INCHES = {
  1: [8.5, 11], 2: [8.5, 11], 3: [11, 17], 4: [17, 11], 5: [8.5, 14], 6: [5.5, 8.5], 7: [7.25, 10.5],
  8: [297 * MM, 420 * MM], 9: [210 * MM, 297 * MM], 10: [210 * MM, 297 * MM], 11: [148 * MM, 210 * MM],
  12: [250 * MM, 354 * MM], 13: [182 * MM, 257 * MM], 14: [8.5, 13], 18: [8.5, 11],
};

/** The paper's width and height in inches, as oriented. The default (no size saved) is Letter. */
export function paperInches(settings) {
  const [w, h] = PAPER_INCHES[settings?.paperSize] || PAPER_INCHES[1];
  return settings?.orientation === 'landscape' ? [h, w] : [w, h];
}

/** The sheet's page setup, or for a sheet that has none the one it prints with (see effectivePrintSettings). */
export function pageSettings(sheet) {
  return effectivePrintSettings(sheet);
}

const lineSizes = (wb, sheet, axis, from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) {
    out.push(axis === 'row'
      ? (sheet.hiddenRows.has(i) || sheet.filterHidden?.has(i) ? 0 : wb.rowHeight(sheet.id, i))
      : (sheet.hiddenCols.has(i) ? 0 : wb.colWidth(sheet.id, i)));
  }
  return out;
};

/**
 * Where the pages of a sheet begin and how large they are, in unzoomed CSS pixels (96 to the inch):
 * { paperWidth, paperHeight, margins, gap, scale, colStarts, rowStarts, cols, rows, printed, settings }.
 * Pages tile the whole sheet from A1, so blank pages follow the data; `printed` is
 * the block of pages the print area (or the used range) falls on, which is what page numbers count.
 */
export function pageLayoutMetrics(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return null;
  const p = pageSettings(sheet);
  const [w, h] = paperInches(p);
  const margins = Object.fromEntries(Object.entries(p.margins).map(([k, v]) => [k, v * PX_PER_INCH]));
  const paperWidth = w * PX_PER_INCH, paperHeight = h * PX_PER_INCH;
  const width = Math.max(1, paperWidth - margins.left - margins.right);
  const height = Math.max(1, paperHeight - margins.top - margins.bottom);
  // A print area of whole columns (or rows) prints as far as the sheet's print reaches (see printRange).
  const given = p.areas[0];
  const area = given && (given.r2 >= MAX_ROW || given.c2 >= MAX_COL) ? printRange(wb, sheetId, { range: given }) : given || wb.usedRange(sheetId);
  // The print scale: Fit to pages shrinks the print area (never enlarges it), else the Adjust to percentage.
  let scale = (Number(p.scale) || 100) / 100;
  if (p.fitToPage) {
    scale = 1;
    if (area) {
      const totalW = lineSizes(wb, sheet, 'col', area.c1, area.c2).reduce((a, b) => a + b, 0);
      const totalH = lineSizes(wb, sheet, 'row', area.r1, area.r2).reduce((a, b) => a + b, 0);
      if (p.fitWidth > 0 && totalW > 0) scale = Math.min(scale, (width * p.fitWidth) / totalW);
      if (p.fitHeight > 0 && totalH > 0) scale = Math.min(scale, (height * p.fitHeight) / totalH);
    }
    scale = quantizePrintScale(scale);
  }
  // A manual page break starts a page here as it does in print, unless fitting to a number of pages overrides it.
  const apply = manualBreaksApply({ fit: p.fitToPage ? 'pages' : 'scale', fitWidth: p.fitWidth, fitHeight: p.fitHeight });
  const forced = (breaks, on) => (on && breaks?.length ? new Set(breaks.filter((at) => at > 0)) : null);
  // Rows (or columns) to repeat print again on every page after they are reached, taking room from the cells there.
  const starts = (sizes, capacity, breaks, titles) => {
    if (titles && titles[0] < sizes.length) {
      const titled = printTitleStarts(sizes, capacity, { repeat: [titles[0], Math.min(sizes.length, titles[1] + 1)] }, breaks);
      if (titled?.length) return titled;
    }
    const bands = printBands(sizes, capacity, 0, breaks)?.bands || [{ start: 0, end: sizes.length }];
    return bands.filter((b) => b.end > b.start).map((b) => b.start);
  };
  const cols = starts(lineSizes(wb, sheet, 'col', 0, sheet.cols - 1), width / scale, forced(p.colBreaks, apply.cols), p.titleCols);
  const rows = starts(lineSizes(wb, sheet, 'row', 0, sheet.rows - 1), height / scale, forced(p.rowBreaks, apply.rows), p.titleRows);
  const bandOf = (list, i) => { let k = 0; while (k + 1 < list.length && list[k + 1] <= i) k++; return k; };
  const printed = area ? { a0: bandOf(cols, area.c1), a1: bandOf(cols, area.c2), d0: bandOf(rows, area.r1), d1: bandOf(rows, area.r2) } : { a0: 0, a1: 0, d0: 0, d1: 0 };
  return {
    paperWidth, paperHeight, margins, gap: PAGE_GAP, scale, centerAcross: !!p.horizontalCentered, centerDown: !!p.verticalCentered,
    colStarts: new Set(cols.slice(1)), rowStarts: new Set(rows.slice(1)), cols, rows, printed, settings: p,
  };
}

/**
 * A page's place in print order (0 for the first printed page) and its printed number, from its
 * column of pages (across) and row of pages (down), numbered down, then over, unless
 * the page setup says over, then down.
 */
export function pageNumber(metrics, across, down) {
  const { printed, settings } = metrics;
  const wide = printed.a1 - printed.a0 + 1, tall = printed.d1 - printed.d0 + 1;
  const a = across - printed.a0, d = down - printed.d0;
  const index = settings.pageOrder === 'overThenDown' ? d * wide + a : a * tall + d;
  const first = settings.useFirstPageNumber ? settings.firstPageNumber : 1;
  // A blank page beyond the printed ones still counts itself among the pages.
  return { index, number: first + index, pages: Math.max(wide * tall, index + 1) };
}

/** The setting a page's header or footer comes from: the first page's, an even page's, or the usual one. */
export function headerFooterKey(settings, kind, index) {
  const prefix = settings.differentFirst && index === 0 ? 'first' : settings.differentOddEven && index % 2 === 1 ? 'even' : '';
  return prefix ? `${prefix}${kind === 'header' ? 'Header' : 'Footer'}` : kind;
}

// The codes a section is edited with: &[Page] is shown where the file says &P.
const LONG = { P: 'Page', N: 'Pages', D: 'Date', T: 'Time', F: 'File', A: 'Tab', Z: 'Path' };
export function sectionEditText(raw) {
  return String(raw || '').replace(/&&|&([PNDTFAZ])/g, (m, code) => (code ? `&[${LONG[code]}]` : m));
}
export function sectionStoredText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/&&|&\[(page|pages|date|time|file|tab|path)\]/gi, (m, name) => {
    if (!name) return m;
    const code = Object.keys(LONG).find((k) => LONG[k].toLowerCase() === name.toLowerCase());
    return `&${code}`;
  });
}

/** The header or footer text with one section replaced: &L, &C and &R parts, the empty ones left out. */
export function joinSections(sections) {
  return [['L', sections.left], ['C', sections.center], ['R', sections.right]].filter(([, t]) => t).map(([code, t]) => `&${code}${t}`).join('');
}

const SIDES = ['left', 'center', 'right'];
// The Header & Footer elements to insert, as their codes.
export const HEADER_ELEMENTS = [['Page Number', '&[Page]'], ['Number of Pages', '&[Pages]'], ['Current Date', '&[Date]'], ['Current Time', '&[Time]'],
  ['File Path', '&[Path]&[File]'], ['File Name', '&[File]'], ['Sheet Name', '&[Tab]']];
const HEADER_OPTIONS = [['Different First Page', 'differentFirst', false], ['Different Odd & Even Pages', 'differentOddEven', false],
  ['Scale with Document', 'scaleWithDoc', true], ['Align with Page Margins', 'alignWithMargins', true]];

/** Put text at the caret in a section (or at its end), and the caret after it. */
function insertAtCaret(section, text) {
  const sel = window.getSelection?.();
  let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !section.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(section);
    range.collapse(false);
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}
const SIDE_LABEL = { left: 'Left', center: 'Center', right: 'Right' };
const KIND_LABEL = { header: 'Header', footer: 'Footer', firstHeader: 'First Page Header', firstFooter: 'First Page Footer', evenHeader: 'Even Page Header', evenFooter: 'Even Page Footer' };

/**
 * The provider grid.setPageLayout takes. `commit(sheetId, patch)` saves page setup fields (a header or
 * footer); `redraw()` asks the grid for a fresh frame; `fileName()` names the document for &F and `filePath()` its folder for &Z; `focusGrid()`
 * hands the keyboard back to the cells.
 */
export function createPageLayout({ wb, commit, redraw = () => {}, fileName = () => '', filePath = () => '', focusGrid = () => {} }) {
  let editing = null; // { node (the page), section, raw, sheetId, key, side }
  const pageNodes = new Map(); // page key → node, with its signature in dataset.sig

  function info(sheet, page) {
    return { file: fileName() || 'Spreadsheet', path: filePath(), tab: sheet.name, palette: wb.colorPalette, normalFont: wb.normalFont, page: page.number, pages: page.pages };
  }

  /** A section's drawn text, as print draws it, put back in the flow of its own box. */
  function sectionView(text, sheet, page, side, fontScale) {
    const spans = richHeaderSections(text, info(sheet, page), fontScale);
    const span = spans[SIDES.indexOf(side)];
    Object.assign(span.style, { position: 'static', left: '', right: '', display: 'block' });
    // Unformatted text takes the sheet's ink, so it reads on a dark sheet too.
    for (const run of span.children) if (/^(#000000|rgb\(0, 0, 0\))$/.test(run.style.color)) run.style.color = '';
    return span;
  }

  function band(kind, sheet, metrics, page, unit) {
    const s = metrics.settings, m = metrics.margins;
    const key = headerFooterKey(s, kind, page.index);
    const text = printPageText(s, page.index)[kind] || '';
    const parts = splitPrintSections(text);
    const canEdit = !wb.isProtected?.(sheet.id);
    const edge = s.alignWithMargins !== false;
    const fontScale = unit * (s.scaleWithDoc !== false ? metrics.scale : 1);
    const distance = (kind === 'header' ? m.header : m.footer) * unit;
    const room = Math.max(18 * unit, ((kind === 'header' ? m.top : m.bottom) - (kind === 'header' ? m.header : m.footer)) * unit);
    const box = el(`div.pl-hf.pl-${kind}`, {
      dataset: { key },
      style: { left: `${(edge ? m.left : 0) * unit}px`, right: `${(edge ? m.right : 0) * unit}px`, [kind === 'header' ? 'top' : 'bottom']: `${distance}px`, height: `${room}px` },
    });
    if (!text) box.classList.add('pl-blank');
    for (const side of SIDES) {
      const section = el('div.pl-section', {
        role: 'textbox', 'aria-multiline': 'true', tabindex: -1, spellcheck: false,
        'aria-label': `${KIND_LABEL[key]}, ${SIDE_LABEL[side]} section`, title: canEdit ? `${KIND_LABEL[key]}: ${SIDE_LABEL[side].toLowerCase()} section` : null,
        contenteditable: canEdit ? 'true' : 'false',
        dataset: { side, kind, key },
      }, parts[side] ? sectionView(text, sheet, page, side, fontScale) : null);
      section.addEventListener('focus', () => beginEdit(section, sheet.id, key, side));
      section.addEventListener('blur', () => endEdit(section, sheet, page, metrics, unit));
      box.append(section);
    }
    if (!text) box.append(el('span.pl-add', { 'aria-hidden': 'true' }, kind === 'header' ? 'Add header' : 'Add footer'));
    if (canEdit) box.append(tools(kind, sheet.id, s));
    return box;
  }

  /**
   * The Header & Footer tools shown while a section is typed in, on a contextual tab:
   * the elements to insert, a jump to the footer (or header), and the header and footer options.
   */
  function tools(kind, sheetId, s) {
    const keep = (e) => e.preventDefault(); // the section keeps the focus and its caret
    const button = (label, attrs, onclick) => el('button.pl-tool', { type: 'button', tabindex: -1, title: label, ...attrs, onpointerdown: keep, onmousedown: keep, onclick }, label);
    const elements = HEADER_ELEMENTS.map(([label, code]) => button(label, { dataset: { code } }, () => { if (editing) insertAtCaret(editing.section, code); }));
    const other = kind === 'header' ? 'footer' : 'header';
    const go = button(kind === 'header' ? 'Go to Footer' : 'Go to Header', {}, (e) => {
      e.target.closest('.pl-page')?.querySelector(`.pl-${other} .pl-section[data-side="center"]`)?.focus();
    });
    const options = HEADER_OPTIONS.map(([label, field, fallback]) => button(label, { 'aria-pressed': String(s[field] ?? fallback), dataset: { option: field } }, (e) => {
      const current = pageSettings(wb.sheet(sheetId));
      const on = !(current[field] ?? fallback);
      commit(sheetId, { [field]: on });
      e.target.setAttribute('aria-pressed', String(on));
    }));
    return el('div.pl-tools', { role: 'toolbar', 'aria-label': 'Header & Footer' },
      el('div.pl-tool-row', {}, ...elements, go), el('div.pl-tool-row', {}, ...options));
  }

  function beginEdit(section, sheetId, key, side) {
    // What the section holds now: the page may have been drawn before another section was saved.
    const raw = splitPrintSections(pageSettings(wb.sheet(sheetId))[key] || '')[side];
    editing = { node: section.closest('.pl-page'), section, sheetId, key, side, raw: raw || '' };
    section.closest('.pl-hf')?.classList.add('pl-editing');
    section.textContent = sectionEditText(raw);
    // The caret goes to the end of what is there, ready to add to it.
    const range = document.createRange?.();
    if (range && section.firstChild) {
      range.selectNodeContents(section);
      range.collapse(false);
      const sel = window.getSelection?.();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function endEdit(section, sheet, page, metrics, unit) {
    if (!editing || editing.section !== section) return;
    const { sheetId, key, side, raw, cancelled } = editing;
    editing = null;
    section.closest('.pl-hf')?.classList.remove('pl-editing');
    const next = cancelled ? raw : sectionStoredText(section.innerText ?? section.textContent).replace(/\n+$/, '');
    if (next !== raw && wb.sheet(sheetId)) {
      const settings = pageSettings(wb.sheet(sheetId));
      const sections = splitPrintSections(settings[key] || '');
      sections[side] = next;
      commit(sheetId, { [key]: joinSections(sections) });
    }
    // The section shows its text as printed again; the page is drawn afresh with the next frame.
    const s = pageSettings(wb.sheet(sheetId));
    const text = s[key] || '';
    section.replaceChildren(...(splitPrintSections(text)[side] ? [sectionView(text, sheet, page, side, unit * (s.scaleWithDoc !== false ? metrics.scale : 1))] : []));
    const box = section.closest('.pl-hf');
    box?.classList.toggle('pl-blank', !text);
    if (box?.querySelector('.pl-add')) box.querySelector('.pl-add').hidden = !!text;
    const node = section.closest('.pl-page');
    if (node) delete node.dataset.sig;
    redraw();
  }

  function onKey(e) {
    const section = e.target.closest?.('.pl-section');
    if (!section) return;
    e.stopPropagation(); // the keys belong to the header, not to the cells
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editing) editing.cancelled = true;
      section.blur();
      focusGrid();
    } else if (e.key === 'Tab') {
      // Tab moves between the left, center and right sections.
      e.preventDefault();
      const all = [...section.closest('.pl-page').querySelectorAll('.pl-section[contenteditable="true"]')];
      const next = all[(all.indexOf(section) + (e.shiftKey ? -1 : 1) + all.length) % all.length];
      next?.focus();
    }
  }

  function page(sheet, metrics, p, unit) {
    const number = pageNumber(metrics, p.across, p.down);
    const s = metrics.settings;
    const texts = printPageText(s, number.index);
    const sig = JSON.stringify([p.x, p.y, p.width, p.height, unit, metrics.scale, texts.header, texts.footer, number, sheet.name, fileName(), filePath(), s.margins, s.alignWithMargins, s.scaleWithDoc, !!wb.isProtected?.(sheet.id), new Date().toDateString()]);
    const key = `${sheet.id}|${p.across}.${p.down}`;
    let node = pageNodes.get(key);
    if (node && node.dataset.sig === sig) return node;
    if (node && editing?.node === node) return node;
    node = el('div.pl-page', {
      dataset: { page: `${p.across}.${p.down}`, sig },
      // Placed by left and top rather than a transform, so the header tools can stand over the cells.
      style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.width}px`, height: `${p.height}px` },
    }, band('header', sheet, metrics, number, unit), band('footer', sheet, metrics, number, unit));
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'click', 'dblclick', 'contextmenu', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut']) {
      node.addEventListener(type, (e) => { if (e.target.closest?.('.pl-hf')) e.stopPropagation(); });
    }
    node.addEventListener('keydown', onKey);
    // A press on "Add header" (or anywhere in an empty band) starts typing in its center section.
    node.addEventListener('pointerdown', (e) => {
      const box = e.target.closest?.('.pl-hf');
      if (!box || e.target.closest('.pl-section, .pl-tools')) return;
      e.preventDefault();
      box.querySelector('.pl-section[data-side="center"][contenteditable="true"]')?.focus();
    });
    pageNodes.set(key, node);
    return node;
  }

  return {
    metrics: (sheet) => pageLayoutMetrics(wb, sheet.id),
    get editing() { return !!editing; },
    /** Draw the pages in view (and keep a page whose header is being typed in, wherever it is). */
    render(layer, pages, { unit, metrics, sheetId }) {
      const sheet = wb.sheet(sheetId);
      if (!sheet || !metrics) { layer.replaceChildren(); return; }
      const nodes = pages.map((p) => page(sheet, metrics, p, unit));
      if (editing?.node && !nodes.includes(editing.node)) nodes.push(editing.node);
      // Forget pages long out of view, so a long scroll does not keep them all.
      if (pageNodes.size > 200) for (const [k, n] of pageNodes) if (!nodes.includes(n)) pageNodes.delete(k);
      // Pages that stay are left where they are: taking a page out and back would take the focus from a header being typed in.
      const keep = new Set(nodes);
      for (const child of [...layer.children]) if (!keep.has(child)) child.remove();
      for (const n of nodes) if (n.parentNode !== layer) layer.append(n);
    },
    /** The rulers over the pages along one axis: the margins shaded, a tick every eighth of an inch, inches numbered from the margin. */
    ruler(axis, pages, { unit, metrics }) {
      const m = metrics.margins;
      const [before, after] = axis === 'col' ? [m.left, m.right] : [m.top, m.bottom];
      const inch = PX_PER_INCH * unit;
      return pages.map((p) => {
        const size = p.size, lead = before * unit, tail = after * unit;
        const across = axis === 'col';
        const ticks = [];
        // Ticks run both ways from the margin, an eighth of an inch apart (fewer when zoomed out), longer at the half inch.
        const per = inch / 8 >= 5 ? 8 : inch / 4 >= 5 ? 4 : 2;
        const step = inch / per;
        for (let k = -Math.floor(lead / step); lead + k * step <= size; k++) {
          const at = lead + k * step;
          if (k % per === 0) {
            if (k !== 0) ticks.push(`<text ${across ? `x="${at}" y="12"` : `x="${-at}" y="12" transform="rotate(-90)"`} text-anchor="middle">${Math.abs(k / per)}</text>`);
            continue;
          }
          const len = (k * 2) % per === 0 ? 6 : 3;
          ticks.push(across ? `<line x1="${at}" x2="${at}" y1="${16 - len}" y2="16"/>` : `<line y1="${at}" y2="${at}" x1="${16 - len}" x2="16"/>`);
        }
        const svg = `<svg width="${across ? size : 18}" height="${across ? 18 : size}" aria-hidden="true">${ticks.join('')}</svg>`;
        return el('div.pl-ruler', {
          style: across ? { left: `${p.origin}px`, width: `${size}px` } : { top: `${p.origin}px`, height: `${size}px` },
        }, el('div.pl-ruler-margin', { style: across ? { left: '0', width: `${lead}px` } : { top: '0', height: `${lead}px` } }),
        el('div.pl-ruler-margin', { style: across ? { right: '0', width: `${tail}px` } : { bottom: '0', height: `${tail}px` } }),
        el('div.pl-ruler-ticks', { html: svg }));
      });
    },
  };
}
