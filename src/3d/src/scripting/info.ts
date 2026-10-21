// Info editor: reports (info / warnings / errors) and the operator log in Python-call form.
// Click to select (Shift/Ctrl to extend), A select all, Ctrl+C copy, X / Delete delete.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext, type Report } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { addKeys } from '../app/keymap';
import { opLog, type LogEntry } from './oplog';
import './info.css';

type Entry = Report | LogEntry;

const selected = new WeakSet<Entry>();
let anchor: Entry | null = null;

function entries(): Entry[] {
  const all: Entry[] = [...app.reports, ...opLog.entries];
  return all.sort((a, b) => a.time - b.time);
}

const ICON: Record<string, string> = { INFO: 'info_small', WARNING: 'warning', ERROR: 'error', OPERATOR: 'info_op' };

export class InfoEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Info', 'Window', 'Screen'];
  private list: HTMLElement;
  private boxEl: HTMLElement;
  /** B: the next drag draws a selection box */
  boxPending = false;
  private lastCount = -1;
  private unsub: () => void;
  showOps = true;
  showInfo = true;
  showWarnings = true;
  showErrors = true;

  constructor(public area: Area) {
    this.el = document.createElement('div');
    this.el.className = 'info-editor';
    this.el.tabIndex = -1;
    this.list = document.createElement('div');
    this.list.className = 'info-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.el.append(this.list);
    const fn = () => this.draw();
    opLog.listeners.add(fn);
    this.unsub = () => opLog.listeners.delete(fn);
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'info-box';
    this.el.append(this.boxEl);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.startBox(e, e.target === this.el || e.target === this.list);
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(contextMenu(), { x: e.clientX, y: e.clientY }, { title: 'Info' });
    });
    this.draw();
  }

  private visible(): Entry[] {
    return entries().filter((e) => (e.type === 'OPERATOR' ? this.showOps : e.type === 'INFO' ? this.showInfo : e.type === 'WARNING' ? this.showWarnings : this.showErrors));
  }

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) =>
      h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    const tog = (key: 'showOps' | 'showInfo' | 'showWarnings' | 'showErrors', ic: string, tip: string) =>
      h('button', { key, class: { 'hdr-toggle': true, on: this[key] }, 'data-tip': tip, 'aria-label': tip.split('\n')[0], 'aria-pressed': this[key] ? 'true' : 'false', onclick: () => ((this[key] = !this[key]), this.draw(), this.area.drawHeader()) }, icon(ic));
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => [
        { label: 'Show Operators', checked: this.showOps, action: () => ((this.showOps = !this.showOps), this.draw()) },
        { label: 'Show Info', checked: this.showInfo, action: () => ((this.showInfo = !this.showInfo), this.draw()) },
        { label: 'Show Warnings', checked: this.showWarnings, action: () => ((this.showWarnings = !this.showWarnings), this.draw()) },
        { label: 'Show Errors', checked: this.showErrors, action: () => ((this.showErrors = !this.showErrors), this.draw()) },
        { separator: true },
        { label: 'Scroll to Bottom', action: () => this.scrollBottom() },
        { separator: true },
        { label: 'Area', submenu: () => this.area.areaMenu() },
      ]),
      menu('Info', () => [
        { label: 'Select All', shortcut: 'A', op: 'info.select_all', props: { action: 'SELECT' } },
        { label: 'Deselect All', shortcut: 'Alt A', op: 'info.select_all', props: { action: 'DESELECT' } },
        { label: 'Invert Selection', shortcut: 'Ctrl I', op: 'info.select_all', props: { action: 'INVERT' } },
        { label: 'Toggle Selection', op: 'info.select_all', props: { action: 'TOGGLE' } },
        { separator: true },
        { label: 'Box Select', shortcut: 'B', op: 'info.select_box' },
        { separator: true },
        { label: 'Delete', shortcut: 'X', op: 'info.report_delete' },
        { label: 'Copy', shortcut: 'Ctrl C', op: 'info.report_copy' },
        { label: 'Replay Operators', shortcut: 'R', op: 'info.report_replay' },
        { separator: true },
        { label: 'Clear All', op: 'info.clear' },
      ]),
      h('div', { class: 'hdr-spacer' }),
      h('div', { class: 'hdr-group' }, tog('showOps', 'info_op', 'Operators\nShow the operator log'), tog('showInfo', 'info_small', 'Info\nShow info reports'), tog('showWarnings', 'warning', 'Warnings\nShow warnings'), tog('showErrors', 'error', 'Errors\nShow errors')),
    );
  }

  draw() {
    const list = this.visible();
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 30;
    patch(
      this.list,
      list.map((e, i) =>
        h(
          'div',
          {
            key: `${e.time}:${i}:${e.message.length}`,
            class: { 'info-row': true, [e.type.toLowerCase()]: true, sel: selected.has(e) },
            role: 'option',
            'aria-selected': selected.has(e) ? 'true' : 'false',
            title: e.message,
            onpointerdown: (ev: PointerEvent) => {
              if (ev.button !== 0) return;
              ev.stopPropagation();
              if (this.boxPending) return this.startBox(ev, false);
              this.click(e, ev);
              this.startBox(ev, false);
            },
          },
          h('span', { class: 'info-ic' }, icon(ICON[e.type] ?? 'info_small')),
          h('span', { class: 'info-msg' }, e.message),
        ),
      ),
    );
    if (atBottom || list.length !== this.lastCount) this.scrollBottom();
    this.lastCount = list.length;
  }

  private click(e: Entry, ev: PointerEvent) {
    const vis = this.visible();
    if (ev.shiftKey && anchor && vis.includes(anchor)) {
      const a = vis.indexOf(anchor),
        b = vis.indexOf(e);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(vis[i]);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selected.has(e)) selected.delete(e);
      else selected.add(e);
      anchor = e;
    } else {
      for (const x of vis) selected.delete(x);
      selected.add(e);
      anchor = e;
    }
    this.el.focus({ preventScroll: true });
    this.draw();
  }

  /**
   * Drag a box over rows to select them (Shift adds, Ctrl removes). `clearOnClick`: a click
   * without dragging deselects everything.
   */
  startBox(down: PointerEvent, clearOnClick: boolean) {
    const pending = this.boxPending;
    this.boxPending = false;
    const sx = down.clientX,
      sy = down.clientY;
    let dragging = pending;
    const elR = () => this.el.getBoundingClientRect();
    const mode = down.shiftKey ? 'ADD' : down.ctrlKey || down.metaKey ? 'SUB' : 'SET';
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      dragging = true;
      const r = elR();
      const x0 = Math.min(sx, e.clientX),
        y0 = Math.min(sy, e.clientY);
      Object.assign(this.boxEl.style, { display: 'block', left: `${x0 - r.left}px`, top: `${y0 - r.top + this.el.scrollTop}px`, width: `${Math.abs(e.clientX - sx)}px`, height: `${Math.abs(e.clientY - sy)}px` });
    };
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      this.boxEl.style.display = 'none';
      if (!dragging) {
        if (clearOnClick) {
          for (const x of entries()) selected.delete(x);
          this.draw();
        }
        return;
      }
      const y0 = Math.min(sy, e.clientY),
        y1 = Math.max(sy, e.clientY);
      const vis = this.visible();
      const rows = [...this.list.children] as HTMLElement[];
      if (mode === 'SET') for (const x of vis) selected.delete(x);
      rows.forEach((row, i) => {
        const rr = row.getBoundingClientRect();
        if (rr.bottom < y0 || rr.top > y1 || !vis[i]) return;
        if (mode === 'SUB') selected.delete(vis[i]);
        else selected.add(vis[i]);
      });
      this.draw();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  private scrollBottom() {
    requestAnimationFrame(() => (this.el.scrollTop = this.el.scrollHeight));
  }

  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE') {
    const vis = this.visible();
    const any = vis.some((e) => selected.has(e));
    for (const e of vis) {
      const on = action === 'SELECT' ? true : action === 'DESELECT' ? false : action === 'INVERT' ? !selected.has(e) : !any;
      if (on) selected.add(e);
      else selected.delete(e);
    }
    this.draw();
  }

  selection() {
    return this.visible().filter((e) => selected.has(e));
  }

  /** Select the visible report at `index` (from the oldest); `extend` toggles it into the selection. */
  selectPick(index: number, extend: boolean) {
    const vis = this.visible();
    const e = vis[index];
    if (!e) return false;
    if (extend) {
      if (selected.has(e)) selected.delete(e);
      else selected.add(e);
    } else {
      for (const x of vis) selected.delete(x);
      selected.add(e);
    }
    anchor = e;
    this.draw();
    return true;
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('ui') || kinds.has('doc')) this.draw();
  }

  dispose() {
    this.unsub();
  }
}

function contextMenu(): MenuItem[] {
  return [
    { label: 'Copy', shortcut: 'Ctrl C', op: 'info.report_copy' },
    { label: 'Delete', shortcut: 'X', op: 'info.report_delete' },
    { label: 'Replay Operators', shortcut: 'R', op: 'info.report_replay' },
  ];
}

export function deleteEntries(list: Entry[]) {
  const set = new Set(list);
  for (const arr of [app.reports, opLog.entries] as Entry[][]) {
    for (let i = arr.length - 1; i >= 0; i--) if (set.has(arr[i])) arr.splice(i, 1);
  }
}

const infoOf = (ctx: OpContext) => (ctx.area?.type === 'INFO' ? (ctx.area.editor as InfoEditor) : null);

registerOperators([
  {
    idname: 'info.select_all',
    label: '(De)select All',
    description: 'Change the selection of all visible reports',
    undo: false,
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: (ctx) => !!infoOf(ctx),
    exec: (ctx, p) => infoOf(ctx)!.selectAll(p.action as 'SELECT'),
  },
  {
    idname: 'info.select_pick',
    label: 'Select Report',
    description: 'Select a report by its index in the list (extend: toggle it in the selection)',
    undo: false,
    props: [
      { id: 'report_index', label: 'Report', type: 'int', default: 0, min: 0 },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: (ctx) => !!infoOf(ctx),
    exec: (ctx, p) => (infoOf(ctx)!.selectPick(Number(p.report_index), !!p.extend) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'info.report_copy',
    label: 'Copy Reports to Clipboard',
    description: 'Copy the selected reports to the clipboard',
    undo: false,
    poll: (ctx) => !!infoOf(ctx) && infoOf(ctx)!.selection().length > 0,
    exec: (ctx) => {
      const text = infoOf(ctx)!
        .selection()
        .map((e) => e.message)
        .join('\n');
      void navigator.clipboard?.writeText(text).then(
        () => app.report('INFO', `Copied ${text.split('\n').length} line(s)`),
        () => app.report('WARNING', 'Clipboard access was denied'),
      );
    },
  },
  {
    idname: 'info.report_delete',
    label: 'Delete Reports',
    description: 'Delete the selected reports',
    undo: false,
    poll: (ctx) => !!infoOf(ctx) && infoOf(ctx)!.selection().length > 0,
    exec: (ctx) => {
      deleteEntries(infoOf(ctx)!.selection());
      app.changed('ui');
      infoOf(ctx)!.draw();
    },
  },
  {
    idname: 'info.select_box',
    label: 'Box Select',
    description: 'Drag a box over reports to select them (Shift adds, Ctrl removes)',
    undo: false,
    poll: (ctx) => !!infoOf(ctx),
    exec: (ctx) => {
      infoOf(ctx)!.boxPending = true;
      app.report('INFO', 'Drag over the reports to select them');
    },
  },
  {
    idname: 'info.report_replay',
    label: 'Replay Operators',
    description: 'Run the selected operator reports again, in order',
    poll: (ctx) => !!infoOf(ctx) && infoOf(ctx)!.selection().some((e) => e.type === 'OPERATOR' && !!(e as LogEntry).idname),
    exec: (ctx) => {
      const list = infoOf(ctx)!.selection().filter((e): e is LogEntry => e.type === 'OPERATOR' && !!(e as LogEntry).idname);
      let n = 0;
      for (const e of list) if (app.run(e.idname!, structuredClone(e.props ?? {}), { invoke: false }) === 'FINISHED') n++;
      if (!n) return 'CANCELLED';
      app.report('INFO', `Replayed ${n} operator${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'info.clear',
    label: 'Clear Reports',
    description: 'Delete all reports and the operator log',
    undo: false,
    exec: () => {
      app.reports.length = 0;
      opLog.entries.length = 0;
      app.changed('ui');
    },
  },
]);

addKeys('Info', [
  { key: 'A', op: 'info.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'info.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'info.select_all', props: { action: 'INVERT' } },
  { key: 'C', ctrl: true, op: 'info.report_copy' },
  { key: 'X', op: 'info.report_delete' },
  { key: 'DEL', op: 'info.report_delete' },
  { key: 'B', op: 'info.select_box' },
  { key: 'R', op: 'info.report_replay' },
  { key: 'W', menu: contextMenu, menuTitle: 'Info' },
]);

registerEditor({ id: 'INFO', label: 'Info', icon: 'info', group: 'Scripting', create: (a) => new InfoEditor(a) });
