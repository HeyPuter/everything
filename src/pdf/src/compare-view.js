import './compare-view.css';
import { el, icon, iconButton, button, download } from './lib/ui.js';
import {
  CHANGE_LABELS,
  buildCompareReport,
  describeChange,
  describePageStatus,
  describeSummary,
  pageLabel,
  pageTransform,
  viewportRect,
} from './core/compare.js';

/**
 * The Compare files view: the old and new versions side by side, a row per aligned page pair,
 * with the changed words marked on both (insertions green on the new side, deletions red on the
 * old side, replacements and formatting amber), and a list of every change beside them.
 * Because each row holds both versions of a page, the two columns scroll together page by
 * page, and a page that was inserted, deleted or moved sits opposite an empty slot or its
 * counterpart.
 *
 * createCompareView({ oldPdf, newPdf, oldName, newName, result, onClose })
 *   oldPdf, newPdf: PDF.js documents; result: compareDocuments() for the two.
 *   -> { root, focus(), exportReport() -> Promise<Uint8Array>, destroy() }
 *
 * The root fills its positioned container (the editor places it over the document area).
 */
const GAP = 24; // between the columns and around the rows, in CSS pixels
const MAX_RENDERS = 2; // pages drawn at once
const TEXT_TYPES = new Set(['insert', 'delete', 'replace']);
const FILTERS = {
  all: () => true,
  text: (item) => TEXT_TYPES.has(item.type),
  format: (item) => item.type === 'format',
};
const TYPE_ICONS = {
  insert: 'Plus',
  delete: 'Minus',
  replace: 'RefreshCw',
  format: 'Type',
  image: 'Image',
  page: 'Files',
  note: 'Info',
};
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const stem = (name) => String(name || 'Document').replace(/\.pdf$/i, '');
// A small arrow between the file names; Lucide's ArrowRight would do but reads as a button.
const arrow = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
};

/**
 * A fingerprint of how a page looks, from a small drawing of it, for compareDocuments'
 * renderPage: pages that differ in their pictures or colors, as two scans do, have no words
 * to tell them apart.
 */
export async function pageFingerprint(page) {
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 96 / Math.max(natural.width, natural.height, 1) });
  const canvas = el('canvas', {
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height)),
  });
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: context, viewport }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 0x01000193);
    return hash >>> 0;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export function createCompareView({ oldPdf, newPdf, oldName, newName, result, onClose }) {
  const docs = { old: oldPdf, new: newPdf };
  const geometry = {
    old: result.geometry.old.map((g) => ({ ...g, ...pageTransform(g, 1) })),
    new: result.geometry.new.map((g) => ({ ...g, ...pageTransform(g, 1) })),
  };
  // Everything the list can select, in document order: page events, then the page's changes.
  const items = [];
  result.pages.forEach((entry, row) => {
    const status = describePageStatus(entry);
    if (status) items.push({ type: 'page', row, entry, label: status });
    // Differences the word diff does not cover: page size, rotation, vector drawing.
    if (entry.notes.length) items.push({ type: 'note', row, entry, label: entry.notes.join(', ') });
    for (const change of entry.changes) items.push({ type: change.type, row, entry, change });
  });
  items.forEach((item, i) => (item.index = i));
  let filter = 'all';
  let selected = items.length ? 0 : -1;
  let scale = 0;
  let destroyed = false;

  // Toolbar ------------------------------------------------------------------------------------
  const position = el('span', { class: 'compare-position' });
  const live = el('span', { class: 'sr-only', 'aria-live': 'polite' });
  const prev = iconButton('Previous change', 'ChevronUp', () => step(-1));
  const next = iconButton('Next change', 'ChevronDown', () => step(1));
  const filterButtons = Object.entries({
    all: 'All',
    text: 'Text',
    format: 'Formatting',
  }).map(([key, label]) =>
    el(
      'button',
      {
        type: 'button',
        class: 'compare-filter-btn',
        'aria-pressed': String(key === filter),
        'data-filter': key,
        onclick: () => setFilter(key),
      },
      label,
    ),
  );
  const listToggle = iconButton('Show list of changes', 'PanelLeft', () => showList(side.hidden));
  const exportButton = button(
    'Export report',
    'Download',
    async () => {
      exportButton.disabled = true;
      try {
        download(await exportReport(), `${stem(newName)} compare report.pdf`);
      } finally {
        exportButton.disabled = false;
      }
    },
    'btn compare-btn',
  );
  const toolbar = el(
    'div',
    { class: 'compare-toolbar' },
    el('h2', { class: 'compare-title' }, 'Compare'),
    el(
      'span',
      { class: 'compare-files' },
      el('span', { class: 'compare-file is-old', title: `Old file: ${oldName}` }, oldName),
      arrow(),
      el('span', { class: 'compare-file is-new', title: `New file: ${newName}` }, newName),
    ),
    el(
      'span',
      {
        class: 'compare-summary',
        role: 'status',
        title: describeSummary(result.summary),
      },
      describeSummary(result.summary),
    ),
    el('span', { class: 'compare-sep', 'aria-hidden': 'true' }),
    listToggle,
    prev,
    position,
    next,
    el(
      'div',
      { class: 'compare-filter', role: 'group', 'aria-label': 'Show changes' },
      el('span', { class: 'compare-filter-label', 'aria-hidden': 'true' }, 'Show:'),
      filterButtons,
    ),
    exportButton,
    button('Close', 'X', () => onClose?.(), 'btn compare-close', {
      'aria-label': 'Close compare',
    }),
    live,
  );

  // The list of changes ----------------------------------------------------------------------
  const list = el('div', {
    class: 'compare-list',
    role: 'listbox',
    'aria-label': 'Changes',
    onkeydown: onListKey,
  });
  const empty = el('p', { class: 'compare-empty', hidden: true });
  const side = el('div', { class: 'compare-side' }, list, empty);
  const options = [];
  const groups = [];
  {
    let group = null;
    for (const item of items) {
      if (!group || group.row !== item.row) {
        const id = `compare-group-${item.row}`;
        const node = el(
          'div',
          { class: 'compare-group', role: 'group', 'aria-labelledby': id },
          el('div', { class: 'compare-group-head', id }, pageLabel(item.entry)),
        );
        group = { row: item.row, node, options: [] };
        groups.push(group);
        list.append(node);
      }
      const option = el(
        'div',
        {
          class: `compare-item is-${item.type}`,
          role: 'option',
          id: `compare-item-${item.index}`,
          tabindex: item.index === selected ? 0 : -1,
          'aria-selected': String(item.index === selected),
          'aria-label': itemLabel(item),
          onclick: () => {
            select(item.index);
            reveal(item);
          },
        },
        el(
          'span',
          { class: 'compare-item-icon', 'aria-hidden': 'true' },
          icon(TYPE_ICONS[item.type], 14),
        ),
        itemBody(item),
      );
      option.item = item;
      options[item.index] = option;
      group.options.push(option);
      group.node.append(option);
    }
  }

  function itemLabel(item) {
    if (item.type === 'page') return item.label;
    if (item.type === 'note') return `${item.label}, ${pageLabel(item.entry).toLowerCase()}`;
    return `${describeChange(item.change)}, ${pageLabel(item.entry).toLowerCase()}`;
  }
  function itemBody(item) {
    const excerpt = (text) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
    };
    const c = item.change;
    const head = el(
      'span',
      { class: 'compare-item-type' },
      item.change ? CHANGE_LABELS[item.type] : item.label,
    );
    let detail = null;
    if (item.type === 'insert') detail = el('ins', {}, excerpt(c.newText));
    else if (item.type === 'delete') detail = el('del', {}, excerpt(c.oldText));
    else if (item.type === 'replace')
      detail = [el('del', {}, excerpt(c.oldText)), ' → ', el('ins', {}, excerpt(c.newText))];
    else if (item.type === 'format')
      detail = [
        el('span', {}, excerpt(c.newText)),
        el(
          'span',
          { class: 'compare-format' },
          `${fontLabel(c.format.old)} → ${fontLabel(c.format.new)}`,
        ),
      ];
    else if (item.type === 'image') detail = el('span', {}, c.detail);
    return el(
      'span',
      { class: 'compare-item-text', 'aria-hidden': 'true' },
      head,
      detail && el('span', { class: 'compare-item-detail' }, detail),
    );
  }
  function fontLabel(format) {
    return `${format.font ? `${format.font} ` : ''}${format.size} pt`;
  }

  // The documents, a row per aligned pair --------------------------------------------------
  const heads = el(
    'div',
    { class: 'compare-heads', 'aria-hidden': 'true' },
    el('div', {}, el('strong', {}, 'Old'), ` ${oldName}`),
    el('div', {}, el('strong', {}, 'New'), ` ${newName}`),
  );
  const papers = []; // { side, index, node, canvas, marks, rendered, task, row }
  const rows = result.pages.map((entry, row) => {
    const cell = (sideName) => {
      const index = sideName === 'old' ? entry.oldIndex : entry.newIndex;
      const otherIndex = sideName === 'old' ? entry.newIndex : entry.oldIndex;
      if (index == null) {
        const other = geometry[sideName === 'old' ? 'new' : 'old'][otherIndex];
        const node = el(
          'div',
          { class: 'compare-placeholder' },
          sideName === 'old' ? 'Not in the old file' : 'Not in the new file',
        );
        return { node, size: other, placeholder: true };
      }
      const canvas = el('canvas', { 'aria-hidden': 'true' });
      const marks = el('div', {
        class: 'compare-marks',
        'aria-hidden': 'true',
      });
      const node = el('div', { class: 'compare-paper', 'data-side': sideName }, canvas, marks);
      const paper = {
        side: sideName,
        index,
        node,
        canvas,
        marks,
        rendered: 0,
        task: null,
        row,
      };
      node.paper = paper;
      papers.push(paper);
      return { node, size: geometry[sideName][index], paper };
    };
    const left = cell('old'),
      right = cell('new');
    const label = (sideName, c) => {
      const index = sideName === 'old' ? entry.oldIndex : entry.newIndex;
      const badge = {
        added: 'Inserted page',
        removed: 'Deleted page',
        moved: 'Moved page',
      }[entry.status];
      return el(
        'div',
        { class: 'compare-page-label' },
        index == null ? '' : `${sideName === 'old' ? 'Old' : 'New'} page ${index + 1}`,
        badge && !c.placeholder
          ? el('span', { class: `compare-badge is-${entry.status}` }, badge)
          : null,
      );
    };
    const node = el(
      'div',
      {
        class: `compare-row is-${entry.status}`,
        role: 'group',
        'aria-label': `${pageLabel(entry)}${describePageStatus(entry) ? `, ${describePageStatus(entry).toLowerCase()}` : ''}`,
        'data-row': row,
      },
      el('div', { class: 'compare-cell' }, left.node, label('old', left)),
      el('div', { class: 'compare-cell' }, right.node, label('new', right)),
    );
    return { node, cells: [left, right], entry };
  });
  const sheet = el(
    'div',
    { class: 'compare-sheet' },
    heads,
    rows.map((r) => r.node),
  );
  const scroller = el(
    'div',
    {
      class: 'compare-docs',
      tabindex: '0',
      'aria-label': 'Old and new documents side by side',
    },
    sheet,
  );

  // Marks on the pages, placed in percentages so they follow any zoom.
  const marksOf = new Map(); // item index -> mark elements
  for (const item of items) {
    const marks = [];
    // One label for all of a change's marks: an inserted page has a mark per line, and the
    // label reads through the whole inserted text each time it is made.
    let title = null;
    const place = (sideName, rects) => {
      const index = sideName === 'old' ? item.entry.oldIndex : item.entry.newIndex;
      const paper = rows[item.row].cells[sideName === 'old' ? 0 : 1].paper;
      if (index == null || !paper) return;
      const g = geometry[sideName][index];
      for (const rect of rects) {
        const box = viewportRect(rect, g.transform);
        const pad = 1;
        const mark = el('div', {
          class: `compare-mark is-${item.type}`,
          title: (title ??= itemLabel(item)),
          'data-item': item.index,
        });
        Object.assign(mark.style, {
          left: `${((box.left - pad) / g.width) * 100}%`,
          top: `${((box.top - pad) / g.height) * 100}%`,
          width: `${((box.width + 2 * pad) / g.width) * 100}%`,
          height: `${((box.height + 2 * pad) / g.height) * 100}%`,
        });
        paper.marks.append(mark);
        marks.push(mark);
      }
    };
    if (item.change) {
      place('old', item.change.oldRects);
      place('new', item.change.newRects);
    }
    marksOf.set(item.index, marks);
  }
  sheet.addEventListener('click', (e) => {
    const mark = e.target.closest?.('.compare-mark');
    if (!mark) return;
    const index = Number(mark.dataset.item);
    select(index);
    options[index]?.scrollIntoView({ block: 'nearest' });
  });

  const root = el(
    'section',
    {
      class: 'compare-view',
      'aria-label': 'Compare files',
      'data-filter': filter,
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose?.();
        } else if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g')) {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      },
    },
    toolbar,
    el('div', { class: 'compare-body' }, side, scroller),
  );

  // Selection and navigation -----------------------------------------------------------------
  const visibleItems = () => items.filter(FILTERS[filter]);
  function select(index, { focus = false } = {}) {
    if (selected >= 0) {
      options[selected]?.setAttribute('aria-selected', 'false');
      if (options[selected]) options[selected].tabIndex = -1;
      for (const mark of marksOf.get(selected) || []) mark.classList.remove('is-active');
      rows[items[selected].row].node.classList.remove('is-active');
    }
    selected = index;
    const option = options[index];
    if (option) {
      option.setAttribute('aria-selected', 'true');
      option.tabIndex = 0;
      if (focus) option.focus();
    }
    for (const mark of marksOf.get(index) || []) mark.classList.add('is-active');
    if (items[index]) rows[items[index].row].node.classList.add('is-active');
    updateState();
  }
  function step(delta) {
    const visible = visibleItems();
    if (!visible.length) return;
    let at = visible.findIndex((item) => item.index === selected);
    if (at === -1)
      at =
        delta > 0
          ? visible.findIndex((item) => item.index > selected) - 1
          : visible.findLastIndex((item) => item.index < selected) + 1;
    const target = visible[Math.max(0, Math.min(visible.length - 1, at + delta))];
    if (!target) return;
    select(target.index);
    options[target.index]?.scrollIntoView({ block: 'nearest' });
    reveal(target);
  }
  function updateState() {
    const visible = visibleItems();
    const at = visible.findIndex((item) => item.index === selected);
    position.textContent = visible.length
      ? `${at === -1 ? '–' : at + 1} of ${visible.length}`
      : 'None';
    prev.disabled =
      !visible.length || (at !== -1 ? at === 0 : !visible.some((i) => i.index < selected));
    next.disabled =
      !visible.length ||
      (at !== -1 ? at === visible.length - 1 : !visible.some((i) => i.index > selected));
  }
  /** Scroll the documents so the item shows on both sides, and announce it. */
  function reveal(item) {
    // Positions in the scroller's content, measured from where things are on screen now.
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const topOf = (node) => node.getBoundingClientRect().top - origin;
    const marks = marksOf.get(item.index) || [];
    // The highest mark on either side a third of the way down, else the top of the row.
    const top = marks.length
      ? Math.min(...marks.map(topOf)) - scroller.clientHeight / 3
      : topOf(rows[item.row].node) - heads.offsetHeight - 4;
    scroller.scrollTo({
      top: Math.max(0, top),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
    const visible = visibleItems();
    const at = visible.findIndex((i) => i.index === item.index);
    live.textContent = `${at + 1} of ${visible.length}: ${itemLabel(item)}`;
  }
  function onListKey(e) {
    const visible = visibleItems();
    if (!visible.length) return;
    const at = Math.max(
      0,
      visible.findIndex((item) => item.index === selected),
    );
    const move = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: visible.length - 1,
    }[e.key];
    if (move != null) {
      e.preventDefault();
      const target = visible[Math.max(0, Math.min(visible.length - 1, move))];
      select(target.index, { focus: true });
      options[target.index].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (items[selected]) reveal(items[selected]);
    }
  }
  function setFilter(key) {
    filter = key;
    root.dataset.filter = key;
    for (const b of filterButtons) b.setAttribute('aria-pressed', String(b.dataset.filter === key));
    const test = FILTERS[key];
    for (const option of options) if (option) option.hidden = !test(option.item);
    for (const group of groups) group.node.hidden = group.options.every((o) => o.hidden);
    const visible = visibleItems();
    empty.hidden = visible.length > 0;
    empty.textContent = items.length
      ? 'No changes of this kind.'
      : 'No differences found. The text of both files is the same.';
    // Keep the selection on something the list shows.
    if (visible.length && !visible.some((item) => item.index === selected)) {
      const after = visible.find((item) => item.index > selected) || visible.at(-1);
      select(after.index);
    } else updateState();
  }
  function showList(show) {
    side.hidden = !show;
    listToggle.setAttribute('aria-pressed', String(show));
    listToggle.setAttribute('aria-label', 'Show list of changes');
    root.classList.toggle('list-hidden', !show);
  }

  // Rendering -----------------------------------------------------------------------------------
  const maxWidth = Math.max(
    1,
    ...geometry.old.map((g) => g.width),
    ...geometry.new.map((g) => g.width),
  );
  function layout() {
    const width = scroller.clientWidth;
    if (!width) return;
    const fit = (width - 3 * GAP) / 2 / maxWidth;
    const next = Math.max(0.2, Math.min(2, fit));
    if (scale && Math.abs(next - scale) / scale < 0.01) return;
    // Keep the page in view where it was across the change of size.
    const anchorRow = rows.find((r) => r.node.offsetTop + r.node.offsetHeight > scroller.scrollTop);
    const offset = anchorRow
      ? (scroller.scrollTop - anchorRow.node.offsetTop) / (anchorRow.node.offsetHeight || 1)
      : 0;
    scale = next;
    for (const row of rows)
      for (const c of row.cells) {
        c.node.style.width = `${Math.floor(c.size.width * scale)}px`;
        c.node.style.height = `${Math.floor(c.size.height * scale)}px`;
      }
    if (anchorRow)
      scroller.scrollTop = anchorRow.node.offsetTop + offset * anchorRow.node.offsetHeight;
    for (const paper of papers) if (paper.visible) queue(paper);
  }
  const pending = new Set();
  let running = 0;
  function queue(paper) {
    pending.add(paper);
    pump();
  }
  function pump() {
    while (running < MAX_RENDERS && pending.size && !destroyed) {
      const [paper] = pending;
      pending.delete(paper);
      if (!paper.visible || paper.rendered === scale) continue;
      running++;
      draw(paper).finally(() => {
        running--;
        pump();
      });
    }
  }
  async function draw(paper) {
    const target = scale;
    let page = null;
    try {
      page = await docs[paper.side].getPage(paper.index + 1);
      if (destroyed || !paper.visible || target !== scale) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      let viewport = page.getViewport({ scale: target * ratio });
      // Very large pages are drawn at a lower resolution rather than as huge canvases.
      const area = viewport.width * viewport.height;
      if (area > 16e6)
        viewport = page.getViewport({
          scale: target * ratio * Math.sqrt(16e6 / area),
        });
      // Drawn off to the side and swapped in, so a redraw at a new size never flashes blank.
      const canvas = el('canvas', { 'aria-hidden': 'true' });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      paper.task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
      });
      await paper.task.promise;
      paper.task = null;
      if (destroyed || !paper.visible) return;
      paper.canvas.replaceWith(canvas);
      paper.canvas = canvas;
      paper.rendered = target;
    } catch {
      /* A cancelled or failed drawing leaves the page blank; it is retried when shown again. */
      paper.task = null;
    } finally {
      // PDF.js keeps a drawn page's decoded pictures until told otherwise; two scans compared
      // page by page would hold every picture of both by the end.
      page?.cleanup();
    }
  }
  function release(paper) {
    pending.delete(paper);
    paper.task?.cancel();
    paper.task = null;
    if (paper.rendered) {
      paper.canvas.width = 0;
      paper.canvas.height = 0;
      paper.rendered = 0;
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const paper = entry.target.paper;
        paper.visible = entry.isIntersecting;
        if (paper.visible) queue(paper);
        else release(paper);
      }
    },
    { root: scroller, rootMargin: '800px 0px' },
  );
  for (const paper of papers) observer.observe(paper.node);
  let frame = 0;
  const resizer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(layout);
  });
  resizer.observe(scroller);

  async function exportReport() {
    return buildCompareReport(result, { oldName, newName });
  }

  if (window.matchMedia?.('(max-width: 760px)').matches) showList(false);
  else showList(true);
  setFilter('all');
  if (selected >= 0) select(selected);
  requestAnimationFrame(() => {
    if (!destroyed && root.isConnected) focus();
  });
  function focus() {
    (options[selected] && !side.hidden ? options[selected] : scroller).focus({
      preventScroll: true,
    });
  }

  return {
    root,
    focus,
    exportReport,
    destroy() {
      destroyed = true;
      observer.disconnect();
      resizer.disconnect();
      cancelAnimationFrame(frame);
      for (const paper of papers) release(paper);
      root.remove();
    },
  };
}
