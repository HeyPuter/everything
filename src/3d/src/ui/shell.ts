// Application shell: top bar (menus + workspace tabs), screen, status bar.
import { h, patch, type Child } from './h';
import { appIcon, icon } from './icons';
import { openMenu, promptText, type MenuItem } from './menu';
import { app, registerOperators } from '../app/app';
import { Screen, areaOfElement, defaultWorkspaces, workspaceTemplates, type Workspace, type LayoutNode } from './screen';
import { uiState, prefs, savePrefs } from '../app/prefs';
import { projectUiState } from '../io/files';
import { appMenu, fileMenu, editMenu, renderMenu, windowMenu, helpMenu, fileNewTemplates } from './topbar';

export { fileNewTemplates };

/** Extra status bar content (e.g. the progress of a running render job), drawn before reports. */
export const statusWidgets: (() => Child)[] = [];
/** Scene / view layer selectors at the right of the top bar (replace the plain scene name field). */
export const topbarSceneWidgets: (() => Child)[] = [];
import { textField } from './widgets';
import { setMode, activeCollection } from '../ops/object';
import { statsLines } from '../editors/view3d/view3d';
import { assistantOpen } from '../assistant';
import './screenops';
import './view2d';
import './view2d_hosts';
import { installRegionScale } from './regionscale';
import { activeSceneId, sceneById } from '../scenes/scenes';
import { switchScene } from '../scenes/switch';
import './screenedit';
import './wmicons';
import './rampdropper';
import './browseops';
import { shellRef } from './shellref';
import './favorites';
import './areawindow';
import './screenshot';
import './menuicons';
import './moreicons';
import { APP_VERSION } from '../scripting/wmops';
import { mouseHints } from './statushints';

const STATUSBAR_KEY = 'p3d.ui.statusbar';
function loadStatusbarShown() {
  try {
    return localStorage.getItem(STATUSBAR_KEY) !== '0';
  } catch {
    return true;
  }
}

export class Shell {
  el: HTMLElement;
  top: HTMLElement;
  screen: Screen;
  status: HTMLElement;
  workspaces: Workspace[] = defaultWorkspaces();
  layouts = new Map<string, LayoutNode>();
  active = '';
  fileStatus = '';
  /** modifier keys held (the status bar's mouse hints follow them) */
  mods = { shift: false, ctrl: false, alt: false };

  constructor(root: HTMLElement) {
    this.el = root;
    root.classList.add('shell');
    this.top = document.createElement('header');
    this.top.className = 'topbar';
    const main = document.createElement('main');
    main.className = 'screen-wrap';
    this.status = document.createElement('footer');
    this.status.className = 'statusbar';
    root.append(this.top, main, this.status);
    // right-click anywhere on the status bar chooses what its right side shows
    this.status.addEventListener('contextmenu', (e) => (e.preventDefault(), openMenu(statusMenu(this), { x: e.clientX, y: e.clientY }, { title: 'Status Bar' })));
    this.screen = new Screen(main);
    installRegionScale((el) => areaOfElement.get(el) ?? null);
    // the mouse hints follow the modifier keys being held
    const mods = (e: KeyboardEvent | null) => {
      const next = { shift: !!e?.shiftKey, ctrl: !!(e?.ctrlKey || e?.metaKey), alt: !!e?.altKey };
      if (next.shift === this.mods.shift && next.ctrl === this.mods.ctrl && next.alt === this.mods.alt) return;
      this.mods = next;
      this.drawStatus();
    };
    addEventListener('keydown', (e) => mods(e), { capture: true, passive: true });
    addEventListener('keyup', (e) => mods(e), { capture: true, passive: true });
    addEventListener('blur', () => mods(null));
    // the mouse hints follow the editor under the pointer
    let lastHover: unknown = null;
    main.addEventListener('pointerover', () => {
      if (app.hoverArea === lastHover) return;
      lastHover = app.hoverArea;
      this.drawStatus();
    });
    this.el.classList.toggle('no-statusbar', !this.showStatusbar);
    this.setWorkspace('Layout', false);
    projectUiState.save = () => ({
      workspace: this.active,
      workspaces: this.workspaces.map((w) => ({ name: w.name, mode: w.mode, pinScene: w.pinScene || undefined, scene: w.pinScene ? (w.name === this.active ? activeSceneId(app.doc) : w.scene) : undefined })),
      layouts: Object.fromEntries([...this.layouts.entries(), [this.active, this.screen.serialize()]]),
    });
    projectUiState.load = (s) => {
      const layouts = s.layouts as Record<string, LayoutNode> | undefined;
      if (layouts) for (const [k, v] of Object.entries(layouts)) this.layouts.set(k, v);
      // custom workspace lists (added, renamed, deleted or reordered workspaces)
      const list = s.workspaces as { name: string; mode?: Workspace['mode']; pinScene?: boolean; scene?: string }[] | undefined;
      if (Array.isArray(list) && list.length && layouts) {
        const defaults = defaultWorkspaces();
        this.workspaces = list
          .filter((w) => layouts[w.name] || defaults.some((d) => d.name === w.name))
          .map((w) => ({ name: w.name, mode: w.mode, pinScene: w.pinScene, scene: w.scene, layout: layouts[w.name] ?? defaults.find((d) => d.name === w.name)!.layout }));
      }
      if (typeof s.workspace === 'string' && this.workspaces.some((w) => w.name === s.workspace)) {
        this.active = '';
        this.setWorkspace(s.workspace, false);
      }
    };
  }

  /** Add a workspace from a template (unique name), like the "+" tab menu. */
  addWorkspace(template: Workspace) {
    let name = template.name;
    for (let i = 1; this.workspaces.some((w) => w.name === name); i++) name = `${template.name}.${String(i).padStart(3, '0')}`;
    this.workspaces.push({ ...template, name });
    this.setWorkspace(name);
  }

  duplicateWorkspace(name: string) {
    const ws = this.workspaces.find((w) => w.name === name);
    if (!ws) return;
    const layout = name === this.active ? this.screen.serialize() : (this.layouts.get(name) ?? ws.layout);
    let n = name.replace(/\.\d{3}$/, '');
    const stem = n;
    for (let i = 1; this.workspaces.some((w) => w.name === n); i++) n = `${stem}.${String(i).padStart(3, '0')}`;
    const i = this.workspaces.indexOf(ws);
    this.workspaces.splice(i + 1, 0, { name: n, mode: ws.mode, layout: structuredClone(layout) });
    this.layouts.set(n, structuredClone(layout));
    this.setWorkspace(n);
  }

  deleteWorkspace(name: string) {
    if (this.workspaces.length <= 1) return;
    const i = this.workspaces.findIndex((w) => w.name === name);
    if (i < 0) return;
    this.workspaces.splice(i, 1);
    this.layouts.delete(name);
    if (this.active === name) {
      this.active = '';
      this.setWorkspace(this.workspaces[Math.max(0, i - 1)].name);
    } else this.drawTop();
  }

  renameWorkspace(name: string, to: string) {
    const ws = this.workspaces.find((w) => w.name === name);
    if (!ws || !to || this.workspaces.some((w) => w.name === to)) return;
    ws.name = to;
    const l = this.layouts.get(name);
    if (l) {
      this.layouts.delete(name);
      this.layouts.set(to, l);
    }
    if (this.active === name) this.active = to;
    this.drawTop();
  }

  /** Move a workspace tab to the front or the back of the tab list. */
  moveWorkspace(name: string, to: 'FRONT' | 'BACK') {
    const i = this.workspaces.findIndex((w) => w.name === name);
    if (i < 0) return;
    const [ws] = this.workspaces.splice(i, 1);
    if (to === 'FRONT') this.workspaces.unshift(ws);
    else this.workspaces.push(ws);
    this.drawTop();
  }

  /** Delete every workspace except `name`. */
  deleteOtherWorkspaces(name: string) {
    const keep = this.workspaces.find((w) => w.name === name);
    if (!keep) return;
    for (const w of this.workspaces) if (w !== keep) this.layouts.delete(w.name);
    this.workspaces = [keep];
    if (this.active !== name) {
      this.active = '';
      this.setWorkspace(name);
    } else this.drawTop();
  }

  showStatusbar = loadStatusbarShown();
  setStatusbarShown(v: boolean) {
    this.showStatusbar = v;
    this.el.classList.toggle('no-statusbar', !v);
    try {
      localStorage.setItem(STATUSBAR_KEY, v ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }

  setWorkspace(name: string, switchMode = true) {
    if (name === this.active) return;
    const ws = this.workspaces.find((w) => w.name === name);
    if (!ws) return;
    if (this.active && this.screen.layout) this.layouts.set(this.active, this.screen.serialize());
    // a pinned workspace remembers the scene it was left with
    const prev = this.workspaces.find((w) => w.name === this.active);
    if (prev?.pinScene) prev.scene = activeSceneId(app.doc);
    this.active = name;
    if (switchMode && ws.pinScene && ws.scene && ws.scene !== activeSceneId(app.doc) && sceneById(app.doc, ws.scene)) switchScene(ws.scene);
    uiState.workspace = name;
    this.screen.load(structuredClone(this.layouts.get(name) ?? ws.layout));
    // workspaces carry a preferred object mode
    if (switchMode && ws.mode !== undefined) {
      const ob = app.activeObject;
      const target = ws.mode;
      const valid = ob && (target === 'OBJECT' || (ob.type === 'MESH' && target !== 'PAINT_GREASE_PENCIL') || (target === 'PAINT_GREASE_PENCIL' && ob.type === 'GREASEPENCIL') || (target === 'EDIT' && ['CURVE', 'FONT', 'ARMATURE', 'LATTICE', 'META'].includes(ob.type)) || (target === 'POSE' && ob.type === 'ARMATURE'));
      if (valid && app.doc.mode !== target && setMode(app.doc, target)) app.changed('mode');
    } else if (switchMode && !ws.mode && app.doc.mode !== 'OBJECT') {
      if (setMode(app.doc, 'OBJECT')) app.changed('mode');
    }
    this.screen.update(new Set(['doc', 'ui']));
    this.drawTop();
  }

  drawTop() {
    const menus: [string, () => MenuItem[]][] = [
      ['File', fileMenu],
      ['Edit', editMenu],
      ['Render', renderMenu],
      ['Window', () => windowMenu(this)],
      ['Help', helpMenu],
    ];
    patch(this.top, [
      h('button', { class: 'tb-logo', 'data-tip': 'About', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(appMenu(), e.currentTarget as HTMLElement)) }, appIcon(18)),
      ...menus.map(([label, fn]) =>
        h(
          'button',
          {
            key: label,
            class: 'tb-menu',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(fn(), e.currentTarget as HTMLElement);
            },
            onpointerenter: (e: PointerEvent) => {
              if (document.querySelector('.tb-menu.menu-open') && !(e.currentTarget as HTMLElement).classList.contains('menu-open')) openMenu(fn(), e.currentTarget as HTMLElement);
            },
          },
          label,
        ),
      ),
      h(
        'nav',
        {
          class: 'ws-tabs',
          role: 'tablist',
          // the tab strip scrolls horizontally with the wheel when it doesn't fit
          onwheel: (e: WheelEvent) => {
            const el = e.currentTarget as HTMLElement;
            if (el.scrollWidth <= el.clientWidth) return;
            e.preventDefault();
            el.scrollLeft += e.deltaY || e.deltaX;
            el.classList.toggle('overflow', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
          },
        },
        this.workspaces.map((w) =>
          h(
            'button',
            {
              key: w.name,
              role: 'tab',
              class: { 'ws-tab': true, on: w.name === this.active },
              'aria-selected': w.name === this.active ? 'true' : 'false',
              onclick: () => this.setWorkspace(w.name),
              oncontextmenu: (e: MouseEvent) => {
                e.preventDefault();
                openMenu(workspaceMenu(this, w.name), { x: e.clientX, y: e.clientY });
              },
              ondblclick: () => promptText('Rename Workspace', w.name, (n) => n && this.renameWorkspace(w.name, n)),
            },
            w.name,
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'ws-add',
          'data-tip': 'Add Workspace',
          'aria-label': 'Add Workspace',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(addWorkspaceMenu(this), e.currentTarget as HTMLElement);
          },
        },
        icon('add'),
      ),
      h('div', { class: 'tb-spacer' }),
      h(
        'button',
        {
          class: { 'tb-assistant': true, on: assistantOpen() },
          'data-tip': 'AI Assistant: build and change the scene by describing it',
          'aria-pressed': assistantOpen() ? 'true' : 'false',
          onclick: () => app.run('wm.assistant_toggle'),
        },
        icon('assistant'),
        'Assistant',
      ),
      topbarSceneWidgets.length
        ? topbarSceneWidgets.map((f) => f())
        : [
            h('div', { class: 'tb-scene' }, icon('scene_data'), textField('scene-name', app.doc.scene.name, (v) => ((app.doc.scene.name = v || 'Scene'), app.pushUndo('Rename Scene'), app.changed('doc')))),
            h('div', { class: 'tb-scene' }, icon('view_layer'), h('span', { class: 'tb-vl' }, 'ViewLayer')),
          ],
    ]);
    const tabs = this.top.querySelector<HTMLElement>('.ws-tabs');
    if (tabs) tabs.classList.toggle('overflow', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
  }

  drawStatus() {
    const m = app.modal;
    const doc = app.doc;
    const hints: [string, string][] = m?.status?.() ?? mouseHints({ editor: app.hoverArea?.type, mode: doc.mode, objectType: app.activeObject?.type, ...this.mods }) ?? [];
    const last = app.reports[app.reports.length - 1];
    const showReport = last && Date.now() - last.time < 6000;
    const right: Child[] = [];
    if (this.fileStatus) right.push(h('span', { key: 'file', class: 'sb-file' }, this.fileStatus));
    if (prefs.show_statusbar_stats) right.push(h('span', { key: 'stats', class: 'sb-stats' }, statusStats()));
    if (prefs.show_statusbar_scene_duration) right.push(h('span', { key: 'dur', class: 'sb-duration' }, sceneDuration()));
    const mem = prefs.show_statusbar_memory ? memoryText() : '';
    if (mem) right.push(h('span', { key: 'mem', class: 'sb-memory' }, mem));
    if (prefs.show_statusbar_version) right.push(h('span', { key: 'ver', class: 'sb-version' }, APP_VERSION));
    patch(this.status, [
      h('div', { class: 'sb-hints' }, m?.header ? h('span', { class: 'sb-modal' }, m.header()) : null, hints.map(([k, l]) => h('span', { class: 'sb-hint', key: k + l }, hintKey(k), l))),
      h('div', { class: 'sb-center' }, statusWidgets.map((w) => w()), showReport ? h('span', { class: `sb-report ${last.type.toLowerCase()}`, 'data-tip': 'Click to show the Info log', onclick: () => app.run('screen.info_log_show') }, icon(last.type === 'ERROR' ? 'error' : 'info_small'), last.message) : null),
      h('div', { class: 'sb-right' }, right.flatMap((c, i) => (i ? [h('span', { key: `sep${i}`, class: 'sb-sep' }), c] : [c]))),
    ]);
  }
}

/** A mouse button hint shows a mouse icon; other keys show as key caps. */
function hintKey(k: string): Child {
  const mouse: Record<string, string> = { LMB: 'mouse_lmb', MMB: 'mouse_mmb', RMB: 'mouse_rmb' };
  return mouse[k] ? h('span', { class: 'sb-mouse', 'aria-label': k }, icon(mouse[k])) : h('kbd', null, k);
}

/** Scene statistics for the status bar: active collection, active object, then the mode's counts. */
function statusStats(): string {
  const doc = app.doc;
  const short: Record<string, string> = { Vertices: 'Verts', Triangles: 'Tris' };
  const rows = statsLines();
  const objects = rows.find(([k]) => k === 'Objects');
  const counts = rows.filter(([k]) => k !== 'Objects' && (doc.mode === 'EDIT' || k !== 'Edges')).map(([k, v]) => `${short[k] ?? k}:${v.replace(/ \/ /g, '/')}`);
  const coll = doc.collections[activeCollection(doc)];
  const parts = [coll && coll.id !== doc.scene.collection ? coll.name : 'Scene Collection', app.activeObject?.name ?? '', ...counts, objects ? `Objects:${objects[1].replace(/ \/ /g, '/')}` : ''];
  return parts.filter(Boolean).join(' | ');
}

/** Length of the scene's frame range as time, then the frame count. */
function sceneDuration(): string {
  const s = app.doc.scene;
  const fps = s.render.fps / (s.render.fps_base || 1);
  const frames = s.frame_end - s.frame_start + 1;
  const secs = frames / fps;
  const mm = Math.floor(secs / 60);
  const ss = secs - mm * 60;
  return `Duration: ${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')} (Frame ${s.frame_current}/${frames})`;
}

/** Script memory in use, where the browser reports it. */
function memoryText(): string {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? `Memory: ${(m.usedJSHeapSize / 1048576).toFixed(1)} MiB` : '';
}

/** Right-click menu of the status bar: what its right side shows. */
function statusMenu(sh: Shell): MenuItem[] {
  const toggle = (key: 'show_statusbar_stats' | 'show_statusbar_scene_duration' | 'show_statusbar_memory' | 'show_statusbar_version') => () => {
    prefs[key] = !prefs[key];
    savePrefs();
    sh.drawStatus();
  };
  const hasMemory = !!(performance as Performance & { memory?: unknown }).memory;
  return [
    { label: 'Scene Statistics', checked: prefs.show_statusbar_stats, action: toggle('show_statusbar_stats') },
    { label: 'Scene Duration', checked: prefs.show_statusbar_scene_duration, action: toggle('show_statusbar_scene_duration') },
    ...(hasMemory ? [{ label: 'System Memory', checked: prefs.show_statusbar_memory, action: toggle('show_statusbar_memory') }] : []),
    { label: 'App Version', checked: prefs.show_statusbar_version, action: toggle('show_statusbar_version') },
  ];
}

/** The "+" menu next to the workspace tabs: templates by category, then a copy of the current one. */
function addWorkspaceMenu(sh: Shell): MenuItem[] {
  const cats = [...new Set(workspaceTemplates.map((t) => t.category))];
  return [
    ...cats.map((c) => ({
      label: c,
      submenu: () => workspaceTemplates.filter((t) => t.category === c).map((t) => ({ label: t.create().name, action: () => sh.addWorkspace(t.create()) })),
    })),
    { separator: true },
    { label: 'Duplicate Current', action: () => sh.duplicateWorkspace(sh.active) },
  ];
}

/** Right-click menu of a workspace tab. */
function workspaceMenu(sh: Shell, name: string): MenuItem[] {
  const p = { name };
  const ws = sh.workspaces.find((w) => w.name === name);
  return [
    { label: 'Duplicate', icon: 'duplicate', op: 'workspace.duplicate', props: p },
    { label: 'Delete', icon: 'remove', op: 'workspace.delete', props: p },
    { label: 'Rename…', action: () => promptText('Rename Workspace', name, (n) => n && sh.renameWorkspace(name, n)) },
    { separator: true },
    { label: 'Reorder to Front', icon: 'tria_left_bar', op: 'workspace.reorder_to_front', props: p },
    { label: 'Reorder to Back', icon: 'tria_right_bar', op: 'workspace.reorder_to_back', props: p },
    { separator: true },
    { label: 'Pin Scene', checked: !!ws?.pinScene, op: 'workspace.scene_pin_toggle', props: p },
    { separator: true },
    { label: 'Previous Workspace', shortcut: 'Ctrl Page Up', op: 'screen.workspace_cycle', props: { direction: 'PREV' } },
    { label: 'Next Workspace', shortcut: 'Ctrl Page Down', op: 'screen.workspace_cycle', props: { direction: 'NEXT' } },
    { separator: true },
    { label: 'Delete All Others', op: 'workspace.delete_all_others', props: p },
  ];
}

export let shell: Shell;
export function setShell(s: Shell) {
  shell = s;
  shellRef.current = s;
}

/** Workspace named by an operator's `name` property (empty: the active one). */
const wsName = (p: Record<string, unknown>) => String(p.name || shell?.active || '');
const wsProp = { id: 'name', label: 'Workspace', type: 'string' as const, default: '', hidden: true };

registerOperators([
  { idname: 'workspace.duplicate', label: 'Duplicate Workspace', description: 'Add a copy of the workspace with the same layout', undo: false, props: [wsProp], poll: () => !!shell, exec: (_c, p) => shell.duplicateWorkspace(wsName(p)) },
  { idname: 'workspace.delete', label: 'Delete Workspace', description: 'Remove the workspace tab', undo: false, props: [wsProp], poll: () => !!shell && shell.workspaces.length > 1, exec: (_c, p) => shell.deleteWorkspace(wsName(p)) },
  { idname: 'workspace.reorder_to_front', label: 'Reorder Workspace to Front', description: 'Move the workspace tab to the start of the list', undo: false, props: [wsProp], poll: () => !!shell, exec: (_c, p) => shell.moveWorkspace(wsName(p), 'FRONT') },
  { idname: 'workspace.reorder_to_back', label: 'Reorder Workspace to Back', description: 'Move the workspace tab to the end of the list', undo: false, props: [wsProp], poll: () => !!shell, exec: (_c, p) => shell.moveWorkspace(wsName(p), 'BACK') },
  { idname: 'workspace.delete_all_others', label: 'Delete All Other Workspaces', description: 'Remove every workspace tab except this one', undo: false, props: [wsProp], poll: () => !!shell && shell.workspaces.length > 1, exec: (_c, p) => shell.deleteOtherWorkspaces(wsName(p)) },
  {
    idname: 'workspace.scene_pin_toggle',
    label: 'Pin Scene to Workspace',
    description: 'Remember the scene used in this workspace and switch back to it whenever the workspace is activated',
    undo: false,
    props: [wsProp],
    poll: () => !!shell,
    exec: (_c, p) => {
      const ws = shell.workspaces.find((w) => w.name === wsName(p));
      if (!ws) return 'CANCELLED';
      ws.pinScene = !ws.pinScene;
      ws.scene = ws.pinScene ? activeSceneId(app.doc) : undefined;
      app.changed('ui');
    },
  },
  {
    idname: 'workspace.add',
    label: 'Add Workspace',
    description: 'Add a workspace from a template, or a copy of the current one',
    undo: false,
    poll: () => !!shell,
    invoke: (ctx) => {
      const p = ctx.event ?? app.pointer;
      openMenu(addWorkspaceMenu(shell), { x: p.x, y: p.y }, { title: 'Add Workspace' });
      return 'CANCELLED';
    },
    exec: () => shell.duplicateWorkspace(shell.active),
  },
  {
    idname: 'workspace.append_activate',
    label: 'Append and Activate Workspace',
    description: 'Add a workspace from the built-in templates by name and switch to it',
    undo: false,
    props: [
      { id: 'idname', label: 'Identifier', type: 'string', default: '' },
      { id: 'filepath', label: 'Filepath', type: 'string', default: '' },
    ],
    poll: () => !!shell,
    exec: (_c, p) => {
      const name = String(p.idname);
      const t = workspaceTemplates.find((x) => x.create().name === name);
      if (!t) {
        app.report('ERROR', `No workspace template named "${name}"`);
        return 'CANCELLED';
      }
      shell.addWorkspace(t.create());
    },
  },
  {
    idname: 'screen.toggle_statusbar',
    label: 'Show Status Bar',
    description: 'Show or hide the status bar at the bottom of the window',
    undo: false,
    poll: () => !!shell,
    exec: () => shell.setStatusbarShown(!shell.showStatusbar),
  },
]);

registerOperators([
  {
    idname: 'screen.workspace_cycle',
    label: 'Cycle Workspace',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'NEXT', items: [['NEXT', 'Next'], ['PREV', 'Previous']] }],
    undo: false,
    exec: (_ctx, p) => {
      const i = shell.workspaces.findIndex((w) => w.name === shell.active);
      const n = shell.workspaces.length;
      shell.setWorkspace(shell.workspaces[(i + (p.direction === 'NEXT' ? 1 : n - 1)) % n].name);
    },
  },
]);

export function renderShellChildren(): Child {
  return null;
}
