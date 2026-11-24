// Task pane (right side): the assistant, parts browser, appearance and
// getting-started help.

import { listParts, locationLabel, onPartsChanged, recentParts } from '../platform/files';
import { cloudAvailable, storageError } from '../platform/puter';
import { h, titleWhenClipped } from '../ui/dom';
import { icon } from '../ui/icons';
import { attachTooltip } from '../ui/overlay';
import { selectTabs, tabKeys } from '../ui/tabs';
import type { App } from './app';
import type { FileOps } from './fileops';
import type { AssistantPanel } from '../assistant/panel';

/** Part colours, named for screen readers and tooltips (a hex code says little). */
const SWATCHES: [string, string][] = [
  ['#b8c4d2', 'Light steel'], ['#d0d3d8', 'Silver'], ['#8e9aa8', 'Steel grey'], ['#5d6b7c', 'Slate'], ['#3a4452', 'Charcoal'], ['#c9b28b', 'Sand'],
  ['#d48a4e', 'Copper'], ['#c45a4a', 'Brick red'], ['#c9a33d', 'Brass'], ['#6aa36a', 'Green'], ['#4f8fc0', 'Blue'], ['#7a6bc2', 'Violet'],
];

type PaneId = 'assistant' | 'files' | 'appearance' | 'help';

export class TaskPane {
  private current: PaneId | null = null;

  constructor(private app: App, private files: FileOps, private assistant: AssistantPanel) {
    const s = app.shell;
    const tabs: [PaneId, string, string][] = [['assistant', 'assistant', 'Assistant'], ['files', 'files', 'Parts'], ['appearance', 'appearance', 'Appearance'], ['help', 'help', 'Getting started']];
    for (const [id, ic, label] of tabs) {
      const b = h('button', { role: 'tab', type: 'button', id: `task-pane-tab-${id}`, 'aria-selected': 'false', 'aria-controls': s.tpPanel.id, 'aria-label': label, 'data-pane': id }, icon(ic, 18));
      attachTooltip(b, label);
      b.addEventListener('click', () => this.toggle(id));
      s.tpStrip.append(b);
    }
    // Opening a pane can move focus into it, so the arrow keys only move focus.
    tabKeys(s.tpStrip, { vertical: true, activate: false });
    app.openTaskPane = (id) => this.open(id as PaneId);
    app.toggleTaskPane = (id) => this.toggle(id as PaneId);
    app.taskPaneOpen = () => this.current;
    onPartsChanged(() => this.refreshFiles());
    // Undo, Redo, the assistant or another part change the colour shown as chosen.
    app.store.on(() => { if (this.current === 'appearance') this.syncAppearance(); });
  }

  private syncAppearance = () => {};

  /** Lists the parts again after a save, rename or delete while Parts is open. */
  private refreshFiles() {
    if (this.current !== 'files') return;
    const old = this.app.shell.tpPanel.querySelector<HTMLElement>('.tp-body');
    if (!old) return;
    // Keyboard focus in the list stays on the same row (or the pane's first control).
    const buttons = () => [...this.app.shell.tpPanel.querySelectorAll<HTMLElement>('.tp-body button')];
    const focused = buttons().indexOf(document.activeElement as HTMLElement);
    const body = h('div', { class: 'tp-body' });
    old.replaceWith(body);
    void this.renderFiles(body).then(() => {
      if (focused < 0 || !body.isConnected) return;
      const now = buttons();
      now[Math.min(focused, now.length - 1)]?.focus({ preventScroll: true });
    });
  }

  toggle(id: PaneId) {
    if (this.current === id) this.close();
    else this.open(id);
  }

  close() {
    // Focus inside the pane would be lost with it: it goes to the pane's tab.
    const tab = this.app.shell.tpPanel.contains(document.activeElement) ? this.app.shell.tpStrip.querySelector<HTMLElement>(`[data-pane="${this.current}"]`) : null;
    this.current = null;
    this.app.shell.tpPanel.hidden = true;
    this.app.shell.tpPanel.classList.remove('wide');
    this.sync();
    this.app.viewport.resize();
    tab?.focus();
  }

  open(id: PaneId, focus = true) {
    this.current = id;
    const p = this.app.shell.tpPanel;
    p.hidden = false;
    const title = id === 'assistant' ? 'Assistant' : id === 'files' ? 'Parts' : id === 'appearance' ? 'Appearance' : 'Getting Started';
    const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close task pane' }, icon('close', 16));
    close.addEventListener('click', () => this.close());
    const head = h('div', { class: 'tp-head' }, h('span', { class: 'grow', role: 'heading', 'aria-level': '2' }, title), ...(id === 'assistant' ? this.assistant.headActions : []), close);
    p.classList.toggle('wide', id === 'assistant');
    if (id === 'assistant') {
      p.replaceChildren(head, this.assistant.el);
      if (focus) this.assistant.focus();
      this.sync();
      this.app.viewport.resize();
      return;
    }
    const body = h('div', { class: 'tp-body' });
    p.replaceChildren(head, body);
    if (id === 'files') void this.renderFiles(body);
    else if (id === 'appearance') this.renderAppearance(body);
    else renderHelp(body);
    this.sync();
    this.app.viewport.resize();
  }

  private sync() {
    selectTabs(this.app.shell.tpStrip, (b) => b.dataset.pane === this.current);
    // The panel is named by the tab that shows it.
    if (this.current) this.app.shell.tpPanel.setAttribute('aria-labelledby', `task-pane-tab-${this.current}`);
    else this.app.shell.tpPanel.removeAttribute('aria-labelledby');
    this.app.shell.root.classList.toggle('assistant-open', this.current === 'assistant');
    this.app.commands.changed();
  }

  private async renderFiles(body: HTMLElement) {
    body.append(
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => this.app.commands.run('new') }, icon('new', 14), 'New'),
        h('button', { class: 'btn small', type: 'button', onclick: () => this.app.commands.run('open') }, icon('open', 14), 'Open')),
    );
    const list = h('div', { class: 'file-list', role: 'list', 'aria-busy': 'true' }, h('div', { class: 'field-label' }, 'Loading...'));
    body.append(h('div', { class: 'field-label' }, cloudAvailable() ? 'Your parts' : 'Parts in this browser'), list);
    try {
      let cloudError = '';
      const parts = await listParts((e) => { cloudError = storageError(e); });
      list.textContent = '';
      list.removeAttribute('aria-busy');
      if (cloudError) list.before(h('div', { class: 'field-label', role: 'alert' }, `Your cloud parts could not be listed: ${cloudError}`));
      // A list role needs list items: the empty message is shown without it.
      if (!parts.length) {
        list.removeAttribute('role');
        list.append(h('div', { class: 'field-label' }, cloudError ? 'No parts saved in this browser.' : 'No saved parts yet.'));
      }
      for (const p of parts.slice(0, 50)) {
        // Buttons keep their role; list items wrap them (as in the Open dialog).
        const b = h('button', { class: 'file-item', type: 'button' }, icon(p.location.type === 'cloud' ? 'cloud' : 'device', 16),
          h('span', { class: 'txt' }, clippedName(p.name), h('span', { class: 'meta' }, p.modified ? new Date(p.modified).toLocaleDateString() : locationLabel(p.location))));
        b.addEventListener('click', () => void this.files.openLocation(p.location, p.name, undefined, p.size));
        list.append(h('div', { class: 'file-row', role: 'listitem' }, b));
      }
      // The pane lists the newest; Open lists them all.
      if (parts.length > 50) {
        const more = parts.length - 50;
        list.after(h('button', { class: 'btn small', type: 'button', onclick: () => this.app.commands.run('open') }, `${more} more ${more === 1 ? 'part' : 'parts'}: show all in Open`));
      }
    } catch (e) {
      list.removeAttribute('aria-busy');
      list.removeAttribute('role');
      list.textContent = storageError(e);
    }
  }

  private renderAppearance(body: HTMLElement) {
    const app = this.app;
    const cur = app.store.doc.color;
    const grid = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Part colour' });
    for (const [c, label] of SWATCHES) {
      const b = h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': label, 'aria-pressed': String(c === cur), 'data-color': c });
      attachTooltip(b, label);
      b.addEventListener('click', () => {
        app.store.change('Appearance', (doc) => { doc.color = c; });
        app.applyModelColor();
        // Updated in place, so keyboard focus stays on the swatch.
        for (const x of grid.children) x.setAttribute('aria-pressed', String(x === b));
        custom.value = c;
      });
      grid.append(b);
    }
    const custom = h('input', { type: 'color', value: cur, 'aria-label': 'Custom colour', style: { width: '100%', height: '32px', border: '0', background: 'none' } }) as HTMLInputElement;
    this.syncAppearance = () => {
      const c = app.store.doc.color;
      for (const x of grid.children) x.setAttribute('aria-pressed', String(x.getAttribute('data-color') === c));
      if (c && custom.value !== c) custom.value = c;
    };
    custom.addEventListener('change', () => {
      app.store.change('Appearance', (doc) => { doc.color = custom.value; });
      app.applyModelColor();
    });
    body.append(h('div', { class: 'field-label' }, 'Part colour'), grid, h('label', { class: 'field-label' }, 'Custom colour'), custom);
  }
}

/** A part's name in a list, in full as a tooltip when it is clipped. */
function clippedName(name: string): HTMLElement {
  const el = h('span', { class: 'n' }, name);
  titleWhenClipped(el);
  return el;
}

export function renderHelp(body: HTMLElement) {
  const steps: [string, string][] = [
    ['1. Sketch', 'Select a plane (Front, Top or Right) or a flat face and click Sketch. The view turns to face the plane.'],
    ['2. Draw', 'Use Line (L), Rectangle (R), Circle (C) and the other tools. Geometry snaps to points, midpoints and horizontal or vertical directions and adds matching constraints.'],
    ['3. Constrain', 'Use Smart Dimension (D) to set sizes, and the Constrain group of the Sketch tab (Coincident, Parallel, Tangent...) to fix how geometry relates. Convert Entities projects model edges into the sketch, linked to the model. Blue geometry can still move; black is fully defined; red conflicts.'],
    ['4. Build', 'Exit the sketch and use Extruded Boss, Revolved Boss or a Cut. Then add fillets, chamfers, holes, shells and patterns.'],
    ['5. Change', 'Double-click a feature in the design tree or a face in the model to edit it. Everything after it rebuilds.'],
    ['6. Save and share', 'Save to your Puter cloud (or this browser), or export STEP and STL files.'],
  ];
  for (const [t, d] of steps) body.append(h('div', {}, h('div', { style: { fontWeight: '600' } }, t), h('div', { class: 'field-label' }, d)));
  body.append(h('div', { class: 'field-label' }, 'Navigate: middle or right drag to rotate, Ctrl + middle or Shift + right drag to pan, wheel to zoom, F to fit. Press F1 for all shortcuts.'));
}

export function recentItems(app: App, files: FileOps) {
  const list = recentParts();
  if (!list.length) return [{ label: 'No recent parts', disabled: true }];
  void app;
  return list.slice(0, 10).map((r) => ({ label: `${r.name}  (${locationLabel(r.location)})`, icon: r.location.type === 'cloud' ? 'cloud' : 'device', run: () => void files.openLocation(r.location, r.name) }));
}
