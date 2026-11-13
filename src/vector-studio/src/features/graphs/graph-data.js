/**
 * The Graph Data window: a floating, non-modal spreadsheet for the
 * selected graph. Type in cells (Enter moves down, Tab right, arrows move
 * between cells), paste tab- or comma-separated data from a spreadsheet,
 * import CSV/TSV/text files, transpose rows and columns, switch x and y
 * for scatter graphs, revert to the graph's data and apply. The window
 * follows the selection to another graph when there are no unapplied edits.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { trimCells, parseDelimited, transposeCells, switchXY, dataNotes, dataNotesText, TYPE_LABELS } from './graph-math.js';
import { selectedGraphs, updateGraph } from './graph-ops.js';
import { isGraph } from './graph-live.js';

const MIN_ROWS = 14;
const MIN_COLS = 7;

function colName(j) {
  let s = '';
  let n = j + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export class GraphDataWindow {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.gid = null;
    this.cells = [];
    this.dirty = false;
    this.editor = null;
    this.onSelection = () => this.#follow();
    this.onDocChange = () => this.#refresh();
    // Without unapplied edits the window follows the active document; with them it stays with its own.
    app.on?.('active-editor', (ed) => {
      if (!this.open || this.dirty || ed === this.editor) return;
      const g = ed ? selectedGraphs(ed)[0] : null;
      if (!g) return this.close();
      this.#bind(ed);
      this.#load(g);
    });
    app.on?.('closed', (ed) => ed === this.editor && this.close());
  }

  get open() {
    return Boolean(this.el?.isConnected);
  }

  /** Open (or focus) the window for a graph. */
  show(gid) {
    const g = this.app.editor?.doc.get(gid);
    if (!isGraph(g)) return;
    if (!this.open) {
      this.returnTo = document.activeElement;
      this.#build();
    }
    this.#bind(this.app.editor);
    this.#load(g);
    this.el.querySelector('input.gd-cell')?.focus();
  }

  close() {
    if (!this.el) return;
    this.#bind(null);
    const hadFocus = this.el.contains(document.activeElement);
    this.el.remove();
    // Focus goes back where it was (the canvas), not to the page.
    if (hadFocus) {
      const back = this.returnTo?.isConnected && this.returnTo !== document.body ? this.returnTo : this.app.canvasHost;
      back?.focus?.({ preventScroll: true });
    }
    this.returnTo = null;
    this.el = null;
    this.gid = null;
  }

  /** Ask before discarding edits; resolves true when the window may close or switch. */
  async settle() {
    if (!this.dirty) return true;
    const apply = await this.app.dialogs.confirm({ title: 'Graph Data', message: 'Apply your changes to the graph?', okLabel: 'Apply', cancelLabel: 'Discard' });
    if (apply) this.apply();
    else this.dirty = false;
    return true;
  }

  /** Listen to an editor's selection and document (null stops listening). */
  #bind(editor) {
    if (editor === this.editor) return;
    this.editor?.off('selection', this.onSelection);
    this.editor?.doc.off('change', this.onDocChange);
    this.editor = editor;
    editor?.on('selection', this.onSelection);
    editor?.doc.on('change', this.onDocChange);
  }

  #follow() {
    if (!this.open || this.dirty) return;
    const g = selectedGraphs(this.editor)[0];
    if (g && g.id !== this.gid) this.#load(g);
  }

  /** The document changed (undo, another edit): show the graph's data unless there are unapplied edits. */
  #refresh() {
    if (!this.open || this.dirty) return;
    const g = this.editor?.doc.get(this.gid);
    if (!isGraph(g)) return this.close();
    if (g.live.data === this.source && g.live.type === this.type) return;
    const at = document.activeElement?.closest?.('input.gd-cell');
    this.#load(g, at && this.table.contains(at) ? [Number(at.dataset.r), Number(at.dataset.c)] : null);
  }

  #build() {
    const status = h('span.gd-status', { role: 'status', 'aria-live': 'polite' });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain', hidden: true, onchange: () => this.#importFile(file) });
    const btn = (name, label, onclick, extra = {}) => h('button.icon-btn', { type: 'button', 'aria-label': label, 'data-tip': label, onclick, ...extra }, icon(name, 16));
    this.switchBtn = btn('gd-switch-xy', 'Switch X/Y', () => this.#transform(switchXY));
    const toolbar = h(
      'div.gd-toolbar',
      { role: 'toolbar', 'aria-label': 'Graph data tools' },
      btn('gd-import', 'Import Data...', () => file.click()),
      btn('gd-transpose', 'Transpose Row/Column', () => this.#transform(transposeCells)),
      this.switchBtn,
      h('span.gd-sep'),
      btn('gd-revert', 'Revert', () => this.#revert()),
      h('button.btn.primary.small.gd-apply', { type: 'button', onclick: () => this.apply() }, 'Apply'),
      file,
    );
    this.title = h('h2.gd-title', { id: 'gd-title' }, 'Graph Data');
    const header = h('div.gd-header', this.title, h('button.icon-btn.gd-close', { type: 'button', 'aria-label': 'Close', onclick: async () => (await this.settle()) && this.close() }, icon('x', 16)));
    this.table = h('table.gd-grid', { role: 'grid', 'aria-labelledby': 'gd-title' });
    this.status = status;
    this.el = h('div.graph-data', { role: 'dialog', 'aria-labelledby': 'gd-title', 'aria-modal': 'false' }, header, toolbar, h('div.gd-scroll', this.table), h('div.gd-footer', status, h('span.gd-hint', 'Enter moves down, Tab moves right. Paste rows from a spreadsheet.')));
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.settle().then(() => this.close());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
    });
    this.#dragHandle(header);
    document.body.append(this.el);
  }

  #dragHandle(handle) {
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = this.el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      handle.setPointerCapture?.(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.el.style.left = `${Math.max(0, start.left + e.clientX - start.x)}px`;
      this.el.style.top = `${Math.max(0, start.top + e.clientY - start.y)}px`;
      this.el.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => (start = null));
    handle.addEventListener('pointercancel', () => (start = null));
  }

  #load(g, focus = null) {
    this.gid = g.id;
    this.type = g.live.type;
    this.source = g.live.data;
    this.original = trimCells(g.live.data || []);
    this.cells = this.original.map((r) => r.slice());
    this.dirty = false;
    this.title.textContent = `Graph Data: ${TYPE_LABELS[this.type] || 'Graph'}`;
    this.switchBtn.disabled = this.type !== 'scatter';
    this.#render(focus);
    this.#setStatus('');
  }

  #setStatus(text) {
    if (this.status) this.status.textContent = text;
  }

  #render(focus = null) {
    const rows = Math.max(MIN_ROWS, this.cells.length + 6);
    const cols = Math.max(MIN_COLS, (this.cells[0]?.length || 0) + 3);
    const head = h('tr', h('th.gd-corner', { scope: 'col' }), ...Array.from({ length: cols }, (_, j) => h('th', { scope: 'col' }, colName(j))));
    const body = [];
    for (let i = 0; i < rows; i++) {
      const tr = h('tr', h('th', { scope: 'row' }, String(i + 1)));
      for (let j = 0; j < cols; j++) {
        const input = h('input.gd-cell', {
          type: 'text',
          value: this.cells[i]?.[j] ?? '',
          spellcheck: false,
          autocomplete: 'off',
          'aria-label': `Row ${i + 1}, column ${colName(j)}`,
          dataset: { r: String(i), c: String(j) },
        });
        input.addEventListener('input', () => this.#set(i, j, input.value));
        input.addEventListener('keydown', (e) => this.#key(e, i, j));
        input.addEventListener('paste', (e) => this.#paste(e, i, j));
        tr.append(h('td', input));
      }
      body.push(tr);
    }
    this.table.replaceChildren(h('thead', head), h('tbody', body));
    if (focus) this.#cell(focus[0], focus[1])?.focus();
  }

  #cell(i, j) {
    return this.table.querySelector(`input[data-r="${i}"][data-c="${j}"]`);
  }

  #set(i, j, value) {
    while (this.cells.length <= i) this.cells.push([]);
    const row = this.cells[i];
    while (row.length <= j) row.push('');
    row[j] = value;
    this.dirty = true;
    this.#setStatus('Edited: apply to update the graph.');
  }

  #key(e, i, j) {
    const input = e.currentTarget;
    let to = null;
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) to = [i + (e.shiftKey ? -1 : 1), j];
    else if (e.key === 'ArrowDown') to = [i + 1, j];
    else if (e.key === 'ArrowUp') to = [i - 1, j];
    else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) to = [i, j + 1];
    else if (e.key === 'ArrowLeft' && input.selectionEnd === 0) to = [i, j - 1];
    if (!to) return;
    const next = this.#cell(Math.max(0, to[0]), Math.max(0, to[1]));
    if (!next) {
      if (to[0] >= 0 && to[1] >= 0) {
        // Past the visible grid: grow it.
        this.#set(to[0], to[1], this.cells[to[0]]?.[to[1]] ?? '');
        this.#render(to);
      }
      e.preventDefault();
      return;
    }
    e.preventDefault();
    next.focus();
    next.select?.();
  }

  #paste(e, i, j) {
    const text = e.clipboardData?.getData('text/plain');
    if (!text || !/[\t\n\r,;]/.test(text)) return;
    e.preventDefault();
    this.pasteAt(text, i, j);
  }

  /** Paste delimited text with its top-left at cell (i, j). */
  pasteAt(text, i, j) {
    const rows = parseDelimited(text);
    rows.forEach((r, di) => r.forEach((v, dj) => this.#set(i + di, j + dj, v)));
    this.#render([i, j]);
    this.#setStatus(`Pasted ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
  }

  async #importFile(input) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      this.importText(await f.text(), f.name);
    } catch {
      this.app.notify(`Could not read ${f.name}.`, { error: true });
    }
  }

  /** Replace the grid with imported CSV/TSV text. */
  importText(text, name = 'data') {
    const rows = parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : null);
    if (!rows.length) {
      this.app.notify(`${name} has no data.`, { error: true });
      return;
    }
    this.cells = rows;
    this.dirty = true;
    this.#render([0, 0]);
    this.#setStatus(`Imported ${rows.length} row${rows.length === 1 ? '' : 's'} from ${name}.`);
  }

  #transform(fn) {
    this.cells = fn(this.cells);
    this.dirty = true;
    this.#render([0, 0]);
  }

  #revert() {
    this.cells = this.original.map((r) => r.slice());
    this.dirty = false;
    this.#render([0, 0]);
    this.#setStatus('Reverted to the graph’s data.');
  }

  /** Apply the grid to the graph (one undo step). */
  apply() {
    const ed = this.editor;
    const g = ed?.doc.get(this.gid);
    if (!isGraph(g)) {
      this.#setStatus('The graph is gone.');
      return false;
    }
    const data = trimCells(this.cells);
    ed.doc.transact('Graph Data', () => updateGraph(ed.doc, g.id, { data }));
    this.original = data.map((r) => r.slice());
    this.source = ed.doc.get(g.id).live.data;
    this.dirty = false;
    this.#setStatus(`Applied. ${dataNotesText(dataNotes(data, g.live.type))}`.trim());
    return true;
  }

  /** The current grid (trimmed), for tests and callers. */
  get data() {
    return trimCells(this.cells);
  }
}
