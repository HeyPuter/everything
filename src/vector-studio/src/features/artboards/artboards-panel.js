/**
 * Artboards panel: the numbered artboard list. Click (or Enter) activates
 * and fits an artboard, double-click the name to rename (F2 from the
 * keyboard), the options button opens Artboard Options, dragging a row (or
 * Alt+Up/Down) reorders and renumbers, and the footer has Rearrange All,
 * Move Up/Down, New Artboard and Delete Artboard. Cmd/Ctrl-click and
 * Shift-click pick several artboards for Duplicate and Delete in the panel
 * menu.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { addArtboard, deleteArtboard, reorderArtboard, updateArtboard, duplicateArtboard, artworkOnArtboard } from './artboard-ops.js';

/** Indexes of the artboards picked in the Artboards panel (the active one when none is), ascending. */
export function pickedArtboards(app) {
  const ed = app.editor;
  if (!ed) return [];
  const picked = app.dock?.panels.get('artboards')?.picked;
  const boards = ed.doc.artboards;
  const out = picked?.size ? boards.map((b, i) => (picked.has(b.id) ? i : -1)).filter((i) => i >= 0) : [];
  if (!out.length && boards.length) out.push(Math.min(ed.activeArtboard, boards.length - 1));
  return out;
}

/** Duplicate artboards side by side to the right of all artboards (with their artwork when asked). Returns the new indexes. */
export function duplicateArtboards(doc, indexes, { withArtwork = true, gap = 20 } = {}) {
  const ids = indexes.map((i) => doc.artboards[i]?.id).filter(Boolean);
  const made = [];
  let x = Math.max(...doc.artboards.map((b) => b.x + b.w)) + gap;
  for (const id of ids) {
    const i = doc.artboards.findIndex((b) => b.id === id);
    const src = doc.artboards[i];
    const { index } = duplicateArtboard(doc, i, x - src.x, 0, { withArtwork });
    made.push(index);
    x += src.w + gap;
  }
  return made;
}

/** Delete artboards by index (a document keeps at least one). Returns how many went. */
export function deleteArtboards(doc, indexes) {
  const ids = indexes.map((i) => doc.artboards[i]?.id).filter(Boolean);
  let n = 0;
  for (const id of ids) {
    const i = doc.artboards.findIndex((b) => b.id === id);
    if (deleteArtboard(doc, i)) n++;
  }
  return n;
}

/** Indexes of artboards with no artwork on them. */
export function emptyArtboards(doc) {
  return doc.artboards.map((_, i) => i).filter((i) => !artworkOnArtboard(doc, i).length);
}

export class ArtboardsPanel extends Panel {
  static id = 'artboards';
  static title = 'Artboards';
  static icon = 'tool-artboard';
  static placement = 'strip';

  menu() {
    return ['artboards.new', 'artboards.duplicate', 'artboards.delete', 'artboards.deleteEmpty', '-', 'artboards.convert', 'artboards.options', 'artboards.rearrange', '-', 'artboards.moveUp', 'artboards.moveDown', '-', 'artboards.fitArtwork', 'artboards.fitSelection', 'artboards.switchOrientation', '-', 'artboards.resetNames'];
  }

  build() {
    const app = this.app;
    this.picked = new Set();
    this.list = h('ul.ab-list', {
      'aria-multiselectable': 'true',
      role: 'listbox',
      'aria-label': 'Artboards',
      tabindex: '0',
      'aria-description': 'Enter fits the artboard in the window, F2 renames, Alt+Enter opens Artboard Options, Alt+Up and Alt+Down reorder, Delete deletes',
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('focus', () => this.focusRow(this.app.editor?.activeArtboard ?? 0));
    this.footer = h(
      'div.ab-footer',
      iconButton('layout-grid', 'Rearrange All Artboards', () => app.commands.run('artboards.rearrange')),
      h('span.ab-spacer'),
      (this.upBtn = iconButton('chevron-up', 'Move Up', () => this.move(-1))),
      (this.downBtn = iconButton('chevron-down', 'Move Down', () => this.move(1))),
      iconButton('artboard-new', 'New Artboard', () => this.newArtboard()),
      (this.delBtn = iconButton('trash', 'Delete Artboard', () => this.deleteActive())),
    );
    this.empty = h('p.panel-empty', 'No document open.');
    this.el.append(this.empty, this.list, this.footer);
    this.renaming = -1;
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    this.list.hidden = this.footer.hidden = !ed;
    if (!ed) return;
    if (this.renaming >= 0) return;
    const boards = ed.doc.artboards;
    const active = Math.min(ed.activeArtboard, boards.length - 1);
    for (const id of [...this.picked]) if (!boards.some((b) => b.id === id)) this.picked.delete(id);
    // The active artboard is always picked: a plain click picks just it.
    if (boards[active] && !this.picked.has(boards[active].id)) {
      this.picked.clear();
      this.picked.add(boards[active].id);
    }
    const focused = this.list.contains(document.activeElement);
    this.list.setAttribute('aria-activedescendant', `ab-row-${active}`);
    this.list.replaceChildren(
      ...boards.map((a, i) => {
        const row = h(
          'li.ab-row',
          {
            id: `ab-row-${i}`,
            role: 'option',
            'aria-selected': String(this.picked.has(a.id)),
            'aria-current': i === active ? 'true' : null,
            draggable: 'false',
            dataset: { index: String(i) },
          },
          h('span.ab-num', String(i + 1)),
          h('span.ab-name', a.name),
          h('span.ab-size', { 'aria-hidden': 'true' }, `${Math.round(a.w)} x ${Math.round(a.h)}`),
          h(
            // A pointer affordance inside the option (not a nested control);
            // the keyboard opens the same dialog with Alt+Enter on the list.
            'span.icon-btn.small.ab-opt',
            {
              'aria-hidden': 'true',
              'data-tip': 'Artboard Options',
              onclick: (e) => {
                e.stopPropagation();
                ed.setActiveArtboard(i);
                this.app.commands.run('artboards.options', { index: i });
              },
            },
            icon('artboard-options', 14),
          ),
        );
        row.addEventListener('pointerdown', (e) => this.startDrag(e, i, row));
        row.addEventListener('dblclick', (e) => {
          if (e.target.closest('.ab-name')) this.rename(i);
          else ed.fitArtboard(i);
        });
        return row;
      }),
    );
    this.upBtn.disabled = active <= 0;
    this.downBtn.disabled = active >= boards.length - 1;
    this.delBtn.disabled = boards.length <= 1;
    if (focused) this.list.focus({ preventScroll: true });
    this.list.querySelector(`#ab-row-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  focusRow(i) {
    const ed = this.app.editor;
    if (!ed) return;
    this.list.setAttribute('aria-activedescendant', `ab-row-${i}`);
  }

  activate(i, fit = false) {
    const ed = this.app.editor;
    if (!ed) return;
    ed.setActiveArtboard(i);
    if (fit) ed.fitArtboard(i);
  }

  onKey(e) {
    const ed = this.app.editor;
    if (!ed || this.renaming >= 0) return;
    const n = ed.doc.artboards.length;
    const i = ed.activeArtboard;
    const go = (j) => {
      e.preventDefault();
      e.stopPropagation();
      this.activate(Math.max(0, Math.min(n - 1, j)), false);
    };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      this.move(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp') return go(i - 1);
    if (e.key === 'ArrowDown') return go(i + 1);
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(n - 1);
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      this.app.commands.run('artboards.options', { index: i });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      ed.fitArtboard(i);
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      this.rename(i);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.deleteActive();
    }
  }

  rename(i) {
    const ed = this.app.editor;
    const row = this.list.querySelector(`#ab-row-${i}`);
    if (!ed || !row) return;
    const nameEl = row.querySelector('.ab-name');
    const input = h('input.ab-rename', { type: 'text', value: ed.doc.artboards[i].name, 'aria-label': 'Artboard name', spellcheck: false });
    this.renaming = i;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      this.renaming = -1;
      if (save && v && ed.doc.artboards[i] && v !== ed.doc.artboards[i].name) ed.doc.transact('Rename Artboard', () => updateArtboard(ed.doc, i, { name: v }));
      this.update();
      this.list.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** Pick rows with the pointer: Cmd/Ctrl toggles a row, Shift adds the range from the active row. */
  pick(i, e) {
    const ed = this.app.editor;
    const boards = ed.doc.artboards;
    const id = boards[i]?.id;
    if (!id) return;
    if (e.metaKey || e.ctrlKey) {
      if (this.picked.has(id) && this.picked.size > 1) {
        this.picked.delete(id);
        const next = boards.findIndex((b) => this.picked.has(b.id));
        ed.setActiveArtboard(next);
        return;
      }
      this.picked.add(id);
    } else if (e.shiftKey) {
      const from = ed.activeArtboard;
      for (let k = Math.min(from, i); k <= Math.max(from, i); k++) this.picked.add(boards[k].id);
    } else {
      this.picked.clear();
      this.picked.add(id);
    }
    ed.setActiveArtboard(i);
  }

  startDrag(e, i, row) {
    if (e.button !== 0 || e.target.closest('button, input, .ab-opt')) return;
    const ed = this.app.editor;
    if (!ed) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      this.pick(i, e);
      return;
    }
    this.pick(i, e);
    const y0 = e.clientY;
    let moved = false;
    let target = i;
    const rows = () => [...this.list.querySelectorAll('.ab-row')];
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      row.classList.add('dragging');
      const rs = rows();
      // The gap the pointer is in: before row `gap`, or after the last row.
      let gap = rs.length;
      for (let k = 0; k < rs.length; k++) {
        const r = rs[k].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          gap = k;
          break;
        }
      }
      target = artboardDropIndex(i, gap);
      rs.forEach((r, k) => {
        r.classList.toggle('drop-before', target !== i && k === gap);
        r.classList.toggle('drop-after', target !== i && gap === rs.length && k === rs.length - 1);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      row.classList.remove('dragging');
      if (moved && target !== i) {
        ed.doc.transact('Reorder Artboards', () => reorderArtboard(ed.doc, i, target));
        ed.setActiveArtboard(target);
      }
      this.update();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  move(dir) {
    const ed = this.app.editor;
    if (!ed) return;
    const i = ed.activeArtboard;
    const j = i + dir;
    if (j < 0 || j >= ed.doc.artboards.length) return;
    ed.doc.transact('Reorder Artboards', () => reorderArtboard(ed.doc, i, j));
    ed.setActiveArtboard(j);
  }

  newArtboard() {
    const ed = this.app.editor;
    if (!ed) return;
    const a = ed.artboard();
    const right = Math.max(...ed.doc.artboards.map((b) => b.x + b.w));
    let index = -1;
    ed.doc.transact('New Artboard', () => {
      index = addArtboard(ed.doc, { x: right + 20, y: a?.y ?? 0, w: a?.w ?? 612, h: a?.h ?? 792 });
    });
    ed.setActiveArtboard(index);
  }

  deleteActive() {
    const ed = this.app.editor;
    if (!ed) return;
    if (ed.doc.artboards.length <= 1) {
      this.app.notify('A document needs at least one artboard.');
      return;
    }
    const i = ed.activeArtboard;
    ed.doc.transact('Delete Artboard', () => deleteArtboard(ed.doc, i));
    ed.setActiveArtboard(Math.min(i, ed.doc.artboards.length - 1));
  }
}

/** New index for the artboard at `from` dropped into the gap before row `gap` (rows.length = after the last). */
export function artboardDropIndex(from, gap) {
  return gap > from ? gap - 1 : gap;
}
