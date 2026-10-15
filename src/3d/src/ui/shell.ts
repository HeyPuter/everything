// Application shell: top bar (menus + workspace tabs), screen, status bar.
import { h, patch, type Child } from './h';
import { appIcon, icon } from './icons';
import { openMenu, promptText, type MenuItem } from './menu';
import { app, registerOperators } from '../app/app';
import { Screen, defaultWorkspaces, workspaceTemplates, type Workspace, type LayoutNode } from './screen';
import { uiState, prefs } from '../app/prefs';
import { importMenu, exportMenu, projectUiState } from '../io/files';
import { textField } from './widgets';
import { setMode } from '../ops/object';
import { assistantOpen } from '../assistant';

export class Shell {
  el: HTMLElement;
  top: HTMLElement;
  screen: Screen;
  status: HTMLElement;
  workspaces: Workspace[] = defaultWorkspaces();
  layouts = new Map<string, LayoutNode>();
  active = '';
  fileStatus = '';

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
    this.screen = new Screen(main);
    this.setWorkspace('Layout', false);
    projectUiState.save = () => ({
      workspace: this.active,
      workspaces: this.workspaces.map((w) => ({ name: w.name, mode: w.mode })),
      layouts: Object.fromEntries([...this.layouts.entries(), [this.active, this.screen.serialize()]]),
    });
    projectUiState.load = (s) => {
      const layouts = s.layouts as Record<string, LayoutNode> | undefined;
      if (layouts) for (const [k, v] of Object.entries(layouts)) this.layouts.set(k, v);
      // custom workspace lists (added, renamed, deleted or reordered workspaces)
      const list = s.workspaces as { name: string; mode?: Workspace['mode'] }[] | undefined;
      if (Array.isArray(list) && list.length && layouts) {
        const defaults = defaultWorkspaces();
        this.workspaces = list
          .filter((w) => layouts[w.name] || defaults.some((d) => d.name === w.name))
          .map((w) => ({ name: w.name, mode: w.mode, layout: layouts[w.name] ?? defaults.find((d) => d.name === w.name)!.layout }));
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

  moveWorkspace(name: string, dir: -1 | 1) {
    const i = this.workspaces.findIndex((w) => w.name === name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.workspaces.length) return;
    [this.workspaces[i], this.workspaces[j]] = [this.workspaces[j], this.workspaces[i]];
    this.drawTop();
  }

  setWorkspace(name: string, switchMode = true) {
    if (name === this.active) return;
    const ws = this.workspaces.find((w) => w.name === name);
    if (!ws) return;
    if (this.active && this.screen.layout) this.layouts.set(this.active, this.screen.serialize());
    this.active = name;
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
          // the tab strip scrolls horizontally with the wheel when it doesn't fit (as in the reference UI)
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
                openMenu(
                  [
                    { label: 'Duplicate', action: () => this.duplicateWorkspace(w.name) },
                    { label: 'Delete', disabled: this.workspaces.length <= 1, action: () => this.deleteWorkspace(w.name) },
                    { label: 'Rename…', action: () => promptText('Rename Workspace', w.name, (n) => n && this.renameWorkspace(w.name, n)) },
                    { separator: true },
                    { label: 'Reorder to Front', action: () => this.moveWorkspace(w.name, -1) },
                    { label: 'Reorder to Back', action: () => this.moveWorkspace(w.name, 1) },
                  ],
                  { x: e.clientX, y: e.clientY },
                );
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
            const cats = [...new Set(workspaceTemplates.map((t) => t.category))];
            openMenu(
              [
                ...cats.map((c) => ({
                  label: c,
                  submenu: () => workspaceTemplates.filter((t) => t.category === c).map((t) => ({ label: t.create().name, action: () => this.addWorkspace(t.create()) })),
                })),
                { separator: true },
                { label: 'Duplicate Current', action: () => this.duplicateWorkspace(this.active) },
              ],
              e.currentTarget as HTMLElement,
            );
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
      h('div', { class: 'tb-scene' }, icon('scene_data'), textField('scene-name', app.doc.scene.name, (v) => ((app.doc.scene.name = v || 'Scene'), app.pushUndo('Rename Scene'), app.changed('doc')))),
      h('div', { class: 'tb-scene' }, icon('view_layer'), h('span', { class: 'tb-vl' }, 'ViewLayer')),
    ]);
    const tabs = this.top.querySelector<HTMLElement>('.ws-tabs');
    if (tabs) tabs.classList.toggle('overflow', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
  }

  drawStatus() {
    const m = app.modal;
    const doc = app.doc;
    const hints: [string, string][] = m?.status?.() ?? [
      ['LMB', modeHint()],
      ['MMB', 'Rotate View'],
      ['RMB', doc.mode === 'OBJECT' ? 'Object' : 'Context Menu'],
    ];
    const last = app.reports[app.reports.length - 1];
    const showReport = last && Date.now() - last.time < 6000;
    let stats = '';
    if (prefs.show_statusbar_stats) {
      let verts = 0,
        faces = 0,
        tris = 0,
        objs = 0,
        sel = 0;
      for (const ev of app.graph.objects.values()) {
        if (!ev.visible) continue;
        objs++;
        if (ev.ob.select) sel++;
        if (ev.mesh) {
          verts += ev.mesh.positions.length / 3;
          const nf = ev.mesh.offsets.length - 1;
          faces += nf;
          tris += ev.mesh.indices.length - 2 * nf;
        }
      }
      stats = `${doc.scene.collection ? 'Scene Collection' : ''} | ${app.activeObject?.name ?? ''} | Verts ${verts.toLocaleString()} | Faces ${faces.toLocaleString()} | Tris ${tris.toLocaleString()} | Objects ${sel}/${objs}`;
    }
    patch(this.status, [
      h('div', { class: 'sb-hints' }, m?.header ? h('span', { class: 'sb-modal' }, m.header()) : null, hints.map(([k, l]) => h('span', { class: 'sb-hint', key: k + l }, h('kbd', null, k), l))),
      h('div', { class: 'sb-center' }, showReport ? h('span', { class: `sb-report ${last.type.toLowerCase()}` }, icon(last.type === 'ERROR' ? 'error' : 'info_small'), last.message) : null),
      h('div', { class: 'sb-right' }, this.fileStatus ? h('span', { class: 'sb-file' }, this.fileStatus) : null, h('span', { class: 'sb-stats' }, stats), h('span', { class: 'sb-version' }, 'v1.0')),
    ]);
  }
}

function modeHint() {
  const m = app.doc.mode;
  if (m === 'SCULPT') return 'Sculpt';
  if (m.endsWith('PAINT')) return 'Paint';
  return 'Select';
}

function appMenu(): MenuItem[] {
  return [
    { label: 'About', action: () => app.run('wm.about') },
    { separator: true },
    { label: 'Install Application…', disabled: true },
  ];
}

/** File ▸ New entries (application templates, e.g. 2D Animation); modules append to it. */
export const fileNewTemplates: { label: string; icon?: string; template: string }[] = [{ label: 'General', icon: 'file_blank', template: '' }];

function fileMenu(): MenuItem[] {
  return [
    { label: 'New', icon: 'file_blank', submenu: () => fileNewTemplates.map((t) => ({ label: t.label, icon: t.icon, op: 'wm.read_homefile', props: t.template ? { app_template: t.template } : {}, shortcut: t.template ? undefined : 'Ctrl N' })) },
    { label: 'Open…', icon: 'file_folder', shortcut: 'Ctrl O', op: 'wm.open_mainfile' },
    { label: 'Recover Last Session', op: 'wm.recover_last_session' },
    { separator: true },
    { label: 'Save', icon: 'file_3d', shortcut: 'Ctrl S', op: 'wm.save_mainfile' },
    { label: 'Save As…', shortcut: 'Shift Ctrl S', op: 'wm.save_as_mainfile' },
    { separator: true },
    { label: 'Import', icon: 'import', submenu: importMenu },
    { label: 'Export', icon: 'export', submenu: exportMenu },
    { separator: true },
    { label: 'Clean Up', submenu: () => [{ label: 'Purge Unused Data', op: 'outliner.orphans_purge' }] },
    { separator: true },
    { label: 'Defaults', submenu: () => [{ label: 'Load Factory Settings', op: 'wm.read_factory_settings' }] },
  ];
}

function editMenu(): MenuItem[] {
  return [
    { label: 'Undo', shortcut: 'Ctrl Z', op: 'ed.undo', disabled: !app.undo.canUndo },
    { label: 'Redo', shortcut: 'Shift Ctrl Z', op: 'ed.redo', disabled: !app.undo.canRedo },
    { separator: true },
    { label: 'Undo History…', shortcut: 'Ctrl Alt Z', op: 'ed.undo_history' },
    { separator: true },
    { label: 'Repeat Last', shortcut: 'Shift R', op: 'screen.repeat_last' },
    { label: 'Adjust Last Operation…', shortcut: 'F9', op: 'screen.redo_last' },
    { separator: true },
    { label: 'Menu Search…', shortcut: 'F3', op: 'wm.search_menu' },
    { label: 'Rename Active Item…', shortcut: 'F2', op: 'object.rename' },
    { separator: true },
    { label: 'Preferences…', icon: 'preferences', shortcut: 'Ctrl ,', op: 'screen.userpref_show' },
  ];
}

function renderMenu(): MenuItem[] {
  return [
    { label: 'Render Image', icon: 'render', shortcut: 'F12', op: 'render.render' },
    { label: 'Render Animation', shortcut: 'Ctrl F12', op: 'render.render', props: { animation: true } },
    { separator: true },
    { label: 'Render Audio…', op: 'sound.mixdown' },
    { separator: true },
    { label: 'View Render', shortcut: 'F11', op: 'render.view_show' },
  ];
}

function windowMenu(shell: Shell): MenuItem[] {
  return [
    { label: 'Toggle Window Fullscreen', action: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) },
    { separator: true },
    { label: 'Next Workspace', shortcut: 'Ctrl Page Down', op: 'screen.workspace_cycle', props: { direction: 'NEXT' } },
    { label: 'Previous Workspace', shortcut: 'Ctrl Page Up', op: 'screen.workspace_cycle', props: { direction: 'PREV' } },
    { separator: true },
    { label: 'AI Assistant', icon: 'assistant', checked: assistantOpen(), op: 'wm.assistant_toggle' },
    { separator: true },
    { label: 'Show Status Bar Statistics', checked: prefs.show_statusbar_stats, action: () => ((prefs.show_statusbar_stats = !prefs.show_statusbar_stats), shell.drawStatus()) },
    { separator: true },
    { label: 'Save Screenshot', op: 'screen.screenshot' },
  ];
}

function helpMenu(): MenuItem[] {
  return [
    { label: 'Keyboard Shortcuts', op: 'wm.keymap_reference' },
    { label: 'About', op: 'wm.about' },
  ];
}

export let shell: Shell;
export function setShell(s: Shell) {
  shell = s;
}

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
  {
    idname: 'screen.screenshot',
    label: 'Save Screenshot',
    undo: false,
    exec: () => {
      import('../render/context').then(({ renderContext }) => {
        if (!renderContext) return;
        renderContext.engine.drawAll();
        renderContext.engine.canvas.toBlob((b) => {
          if (!b) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'screenshot.png';
          a.click();
        });
      });
    },
  },
]);

export function renderShellChildren(): Child {
  return null;
}
