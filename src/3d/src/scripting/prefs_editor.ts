// Preferences editor (also hosted in the floating Preferences window): Interface, Viewport,
// Navigation, Input, Keymap, Save & Load and System sections bound to app/prefs.ts.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, operators, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu } from '../ui/menu';
import { numberField, checkbox, enumMenu, panel } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { prefs, savePrefs, defaultPreferences, type Preferences } from '../app/prefs';
import { keymaps, keyLabel, keyName, type KeyItem } from '../app/keymap';
import { renderContext } from '../render/context';
import { autosave } from '../io/files';
import { shell } from '../ui/shell';
import { setBinding, resetBinding, resetAllBindings, isActive, isModified, displayBinding, overrideCount } from './keymap_prefs';
import { python, PYODIDE_INDEX_URL, PYODIDE_VERSION } from './python';

// ---------------------------------------------------------------------------
// extra preference fields stored alongside app/prefs.ts values

export interface PrefExtras {
  show_tooltips: boolean;
  use_auto_save_temporary_files: boolean;
  use_preferences_save: boolean;
}
export const prefx = prefs as Preferences & PrefExtras;
const EXTRA_DEFAULTS: PrefExtras = { show_tooltips: true, use_auto_save_temporary_files: true, use_preferences_save: true };
for (const [k, v] of Object.entries(EXTRA_DEFAULTS)) if ((prefx as unknown as Record<string, unknown>)[k] === undefined) (prefx as unknown as Record<string, unknown>)[k] = v;

let unsaved = false;

/** Apply preference values that have runtime effects. */
export function applyPreferences() {
  const root = document.documentElement;
  const scale = Math.max(0.25, Math.min(4, prefs.resolution_scale || 1));
  root.style.setProperty('--fs', `${Math.round(prefs.font_size * scale * 10) / 10}px`);
  root.style.setProperty('--row', `${Math.round(20 * scale)}px`);
  root.style.setProperty('--ui-scale', String(scale));
  document.body.classList.toggle('no-tooltips', !prefx.show_tooltips);
  app.undo.limit = Math.max(0, Math.min(512, Math.round(prefs.undo_steps)));
  scheduleAutosaveTimer();
  // existing viewports pick up navigation settings immediately
  forEachView((v) => (v.nav.autoPersp = prefs.use_auto_perspective));
}

type ViewLike = { nav: { autoPersp: boolean } };
function forEachView(fn: (v: ViewLike) => void) {
  for (const a of shell?.screen.areas ?? []) {
    const ed = a.editor as unknown as Partial<ViewLike>;
    if (ed?.nav && typeof ed.nav === 'object' && 'autoPersp' in ed.nav) fn(ed as ViewLike);
  }
}

let autosaveTimer = 0;
function scheduleAutosaveTimer() {
  clearInterval(autosaveTimer);
  if (!prefx.use_auto_save_temporary_files) return;
  const minutes = Math.max(1, Math.min(60, Math.round(prefs.autosave_interval || 2)));
  autosaveTimer = window.setInterval(() => void autosave(), minutes * 60000);
}

/** Change a preference, apply it and persist (when auto-save preferences is on). */
export function setPref<K extends keyof (Preferences & PrefExtras)>(key: K, value: (Preferences & PrefExtras)[K]) {
  (prefx as unknown as Record<string, unknown>)[key as string] = value;
  applyPreferences();
  if (prefx.use_preferences_save || key === 'use_preferences_save') {
    savePrefs();
    unsaved = false;
  } else unsaved = true;
  app.changed('ui');
}

export function saveUserPrefs() {
  savePrefs();
  unsaved = false;
  app.report('INFO', 'Preferences saved');
  app.changed('ui');
}

export function revertPrefs() {
  try {
    const raw = localStorage.getItem('p3d.preferences.v1');
    const stored = raw ? JSON.parse(raw) : {};
    Object.assign(prefx, defaultPreferences(), EXTRA_DEFAULTS, stored);
  } catch {
    Object.assign(prefx, defaultPreferences(), EXTRA_DEFAULTS);
  }
  unsaved = false;
  applyPreferences();
  app.changed('ui');
}

export function factoryPrefs() {
  Object.assign(prefx, defaultPreferences(), EXTRA_DEFAULTS);
  resetAllBindings();
  applyPreferences();
  savePrefs();
  unsaved = false;
  app.changed('ui');
}

// ---------------------------------------------------------------------------
// editor

const SECTIONS = [
  ['INTERFACE', 'Interface'],
  ['VIEWPORT', 'Viewport'],
  ['NAVIGATION', 'Navigation'],
  ['INPUT', 'Input'],
  ['KEYMAP', 'Keymap'],
  ['SAVE_LOAD', 'Save & Load'],
  ['SYSTEM', 'System'],
] as const;
export type Section = (typeof SECTIONS)[number][0];

export class PreferencesEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Window', 'Screen'];
  section: Section = 'INTERFACE';
  search = '';
  searchMode: 'NAME' | 'KEY' = 'NAME';
  capturing: KeyItem | null = null;

  constructor(
    public area: Area | null,
    state?: unknown,
  ) {
    const st = (state ?? {}) as { section?: Section };
    if (st.section && SECTIONS.some((s) => s[0] === st.section)) this.section = st.section;
    this.el = document.createElement('div');
    this.el.className = 'prefs-editor';
    this.draw();
  }

  header(): Child {
    return h('div', { class: 'hdr-row' }, h('span', { class: 'prefs-hdr-title' }, 'Preferences'));
  }

  setSection(s: Section) {
    this.section = s;
    this.draw();
  }

  draw() {
    patch(this.el, [
      h(
        'nav',
        { class: 'prefs-nav', 'aria-label': 'Preference sections' },
        h(
          'div',
          { class: 'prefs-nav-list' },
          SECTIONS.map(([id, label]) =>
            h('button', { key: id, class: { 'prefs-nav-btn': true, on: this.section === id }, 'aria-current': this.section === id ? 'page' : null, onclick: () => this.setSection(id) }, label),
          ),
        ),
        h('div', { class: 'hdr-spacer' }),
        h(
          'button',
          {
            class: 'prefs-menu-btn',
            'data-tip': 'Preferences\nSave, revert or load factory preferences',
            'aria-label': 'Preferences menu',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(
                [
                  { label: 'Auto-Save Preferences', checked: prefx.use_preferences_save, action: () => setPref('use_preferences_save', !prefx.use_preferences_save) },
                  { separator: true },
                  { label: 'Save Preferences', op: 'wm.save_userpref' },
                  { label: 'Revert to Saved Preferences', action: () => revertPrefs() },
                  { separator: true },
                  { label: 'Load Factory Preferences', op: 'wm.read_factory_userpref' },
                ],
                e.currentTarget as HTMLElement,
              );
            },
          },
          icon('collapsemenu'),
          !prefx.use_preferences_save && unsaved ? h('span', { class: 'prefs-unsaved' }, 'Save Preferences*') : null,
        ),
        !prefx.use_preferences_save && unsaved ? h('button', { class: 'btn prefs-save', onclick: () => saveUserPrefs() }, 'Save Preferences') : null,
      ),
      h('div', { class: 'prefs-main' }, this.body()),
    ]);
  }

  private body(): Child {
    switch (this.section) {
      case 'INTERFACE':
        return [
          panel('pf-display', 'Display', () => [
            splitRow('Resolution Scale', numberField({ id: 'pf-scale', value: prefs.resolution_scale, min: 0.25, max: 4, step: 0.05, precision: 2, slider: true, set: (v, f) => f && setPref('resolution_scale', Math.round(v * 100) / 100) })),
            splitRow('Font Size', numberField({ id: 'pf-font', value: prefs.font_size, min: 8, max: 24, int: true, unit: 'pixel', set: (v, f) => f && setPref('font_size', Math.round(v)) })),
            splitRow('', checkbox('pf-tips', 'Tooltips', prefx.show_tooltips, (v) => setPref('show_tooltips', v)), undefined, 'check'),
            splitRow('', checkbox('pf-tips-py', 'Python Tooltips', prefs.show_tooltips_python, (v) => setPref('show_tooltips_python', v), { tip: 'Python Tooltips\nTooltips end with the scripting call or data path of the button' }), undefined, 'check'),
          ]),
          panel('pf-editors', 'Editors', () => [splitRow('', checkbox('pf-splash', 'Splash Screen', prefs.show_splash, (v) => setPref('show_splash', v), { tip: 'Splash Screen\nShow the splash screen with recent files when the application starts fresh' }), undefined, 'check')]),
          panel('pf-status', 'Status Bar', () => [
            splitRow('', checkbox('pf-stats', 'Scene Statistics', prefs.show_statusbar_stats, (v) => setPref('show_statusbar_stats', v)), undefined, 'check'),
            splitRow('', checkbox('pf-duration', 'Scene Duration', prefs.show_statusbar_scene_duration, (v) => setPref('show_statusbar_scene_duration', v)), undefined, 'check'),
            splitRow('', checkbox('pf-version', 'App Version', prefs.show_statusbar_version, (v) => setPref('show_statusbar_version', v)), undefined, 'check'),
          ]),
        ];
      case 'VIEWPORT':
        return [
          panel('pf-vp', 'Display', () => [
            splitRow('Default Focal Length', numberField({ id: 'pf-lens', value: prefs.view_lens, min: 1, max: 250, unit: 'none', precision: 0, set: (v, f) => f && setPref('view_lens', Math.round(v)) })),
            h('div', { class: 'prefs-note' }, 'Applies to newly opened 3D Viewports.'),
          ]),
        ];
      case 'NAVIGATION':
        return [
          panel('pf-orbit', 'Orbit & Pan', () => [
            splitRow('Orbit Method', enumMenu('pf-orbit-m', [{ value: 'TURNTABLE', label: 'Turntable', description: 'Use turntable style rotation in the viewport' }, { value: 'TRACKBALL', label: 'Trackball', description: 'Use trackball style rotation in the viewport' }], prefs.orbit_method, (v) => setPref('orbit_method', v as 'TURNTABLE'))),
            splitRow('', checkbox('pf-around', 'Orbit Around Selection', prefs.use_rotate_around_active, (v) => setPref('use_rotate_around_active', v)), undefined, 'check'),
            splitRow('', checkbox('pf-persp', 'Auto Perspective', prefs.use_auto_perspective, (v) => setPref('use_auto_perspective', v), { tip: 'Auto Perspective\nAutomatically switch between orthographic and perspective when changing between side-on and user views' }), undefined, 'check'),
          ]),
          panel('pf-fly', 'Fly & Walk', () => [
            splitRow('View Navigation', enumMenu('pf-navmode', [{ value: 'WALK', label: 'Walk', description: 'Shift ` walks through the scene' }, { value: 'FLY', label: 'Fly', description: 'Shift ` flies through the scene' }], prefs.navigation_mode ?? 'WALK', (v) => setPref('navigation_mode', v as 'WALK'))),
          ]),
          panel('pf-zoom', 'Zoom', () => [
            splitRow('', checkbox('pf-zmouse', 'Zoom to Mouse Position', prefs.use_zoom_to_mouse, (v) => setPref('use_zoom_to_mouse', v)), undefined, 'check'),
            splitRow('', checkbox('pf-zinv', 'Invert Zoom Wheel Direction', prefs.invert_zoom_wheel, (v) => setPref('invert_zoom_wheel', v)), undefined, 'check'),
          ]),
        ];
      case 'INPUT':
        return [
          panel('pf-kb', 'Keyboard', () => [splitRow('', checkbox('pf-numpad', 'Emulate Numpad', prefs.emulate_numpad, (v) => setPref('emulate_numpad', v), { tip: 'Emulate Numpad\nMain 1 to 0 keys act as the numpad ones (useful for laptops)' }), undefined, 'check')]),
          panel('pf-mouse', 'Mouse', () => [splitRow('', checkbox('pf-3btn', 'Emulate 3 Button Mouse', prefs.emulate_3_button_mouse, (v) => setPref('emulate_3_button_mouse', v), { tip: 'Emulate 3 Button Mouse\nUse Alt with the left mouse button to emulate the middle button' }), undefined, 'check')]),
          panel('pf-tp', 'Touchpad', () => [splitRow('', checkbox('pf-trackpad', 'Two-Finger Scroll Orbits', prefs.trackpad_orbit, (v) => setPref('trackpad_orbit', v), { tip: 'Trackpad Orbit\nTwo-finger scrolling orbits the view (off: it zooms)' }), undefined, 'check')]),
        ];
      case 'KEYMAP':
        return this.keymapBody();
      case 'SAVE_LOAD':
        return [
          panel('pf-autosave', 'Auto Save', () => [
            splitRow('', checkbox('pf-as', 'Auto Save', prefx.use_auto_save_temporary_files, (v) => setPref('use_auto_save_temporary_files', v), { tip: 'Auto Save\nPeriodically save the session for recovery (in addition to saving after edits)' }), undefined, 'check'),
            splitRow('Timer (Minutes)', numberField({ id: 'pf-as-min', value: prefs.autosave_interval, min: 1, max: 60, int: true, disabled: !prefx.use_auto_save_temporary_files, set: (v, f) => f && setPref('autosave_interval', Math.round(v)) })),
            h('div', { class: 'prefs-btn-row' }, h('button', { class: 'btn', onclick: () => app.run('wm.recover_last_session') }, 'Recover Last Session'), h('button', { class: 'btn', onclick: () => app.run('wm.recover_auto_save') }, 'Recover Auto Save…')),
          ]),
          panel('pf-undo', 'Undo', () => [
            splitRow('Undo Steps', numberField({ id: 'pf-undo-steps', value: prefs.undo_steps, min: 0, max: 512, int: true, set: (v, f) => f && setPref('undo_steps', Math.round(v)) })),
            h('div', { class: 'prefs-note' }, `${app.undo.history.length} step(s) in the current history.`),
          ]),
        ];
      case 'SYSTEM':
        return [panel('pf-gpu', 'Graphics', () => systemRows()), panel('pf-py', 'Python', () => pythonRows()), panel('pf-dev', 'Device', () => deviceRows())];
    }
  }

  // ---------------------------------------------------------------- keymap

  private keymapBody(): Child {
    const q = this.search.trim().toLowerCase();
    const names = Object.keys(keymaps).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const match = (k: KeyItem) => {
      if (!q) return true;
      if (this.searchMode === 'KEY') {
        const b = displayBinding(k);
        return keyLabel({ ...b, op: '' }).toLowerCase().includes(q);
      }
      return itemLabel(k).toLowerCase().includes(q) || (k.op ?? '').toLowerCase().includes(q);
    };
    const n = overrideCount();
    return [
      h(
        'div',
        { class: 'km-toolbar' },
        h(
          'div',
          { class: 'enum-row km-mode' },
          h('button', { class: { on: this.searchMode === 'NAME' }, onclick: () => ((this.searchMode = 'NAME'), this.draw()) }, 'Name'),
          h('button', { class: { on: this.searchMode === 'KEY' }, onclick: () => ((this.searchMode = 'KEY'), this.draw()) }, 'Key-Binding'),
        ),
        h('label', { class: 'text-field km-search' }, icon('search'), h('input', { value: this.search, placeholder: this.searchMode === 'NAME' ? 'Search by name' : 'Search by key (e.g. ctrl z)', spellcheck: 'false', 'aria-label': 'Search keymap', oninput: (e: Event) => ((this.search = (e.target as HTMLInputElement).value), this.draw()) })),
        h('button', { class: 'btn', disabled: !n, 'data-tip': 'Restore All\nRestore all key bindings to their defaults', onclick: () => (resetAllBindings(), this.draw(), app.report('INFO', 'Key bindings restored'), app.changed('ui')) }, 'Restore All'),
      ),
      names.map((name) => {
        const items = keymaps[name].filter(match);
        if (q && !items.length) return null;
        const modified = keymaps[name].some(isModified);
        return panel(
          `pf-km-${name}`,
          `${name}${modified ? ' •' : ''}`,
          () => h('div', { class: 'km-list' }, items.map((k) => this.keyRow(name, k))),
          { closed: !q },
        );
      }),
    ];
  }

  private keyRow(km: string, k: KeyItem): Child {
    const b = displayBinding(k);
    const active = isActive(k);
    const capturing = this.capturing === k;
    const idx = keymaps[km].indexOf(k);
    return h(
      'div',
      { key: `${km}#${idx}`, class: { 'km-row': true, inactive: !active, modified: isModified(k) } },
      checkbox(`km-a-${km}-${idx}`, '', active, (v) => (setBinding(km, k, { active: v }), this.draw(), app.changed('ui')), { tip: 'Active\nEnable or disable this key binding' }),
      h('span', { class: 'km-name', title: k.op ? `${k.op}${k.props ? ' ' + JSON.stringify(k.props) : ''}` : 'Menu' }, itemLabel(k)),
      h('input', {
        class: { 'km-key': true, capturing },
        readonly: true,
        'data-capture': 'key',
        value: capturing ? 'Press a key…' : keyLabel({ ...b, op: '' }).replace(/^(Ctrl |Shift |Alt )+/, '') || '—',
        'aria-label': `Key for ${itemLabel(k)}`,
        onfocus: () => ((this.capturing = k), this.draw()),
        onblur: () => {
          if (this.capturing === k) {
            this.capturing = null;
            this.draw();
          }
        },
        onkeydown: (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
          if (e.key === 'Escape') {
            this.capturing = null;
            (e.target as HTMLInputElement).blur();
            return;
          }
          setBinding(km, k, { key: keyName(e), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, active: true });
          this.capturing = null;
          (e.target as HTMLInputElement).blur();
          app.changed('ui');
        },
      }),
      h(
        'div',
        { class: 'km-mods' },
        (['ctrl', 'shift', 'alt'] as const).map((m) =>
          h('button', { key: m, class: { 'km-mod': true, on: b[m] }, 'aria-pressed': b[m] ? 'true' : 'false', onclick: () => (setBinding(km, k, { [m]: !b[m] }), this.draw(), app.changed('ui')) }, m === 'ctrl' ? 'Ctrl' : m === 'shift' ? 'Shift' : 'Alt'),
        ),
      ),
      h('button', { class: 'hdr-toggle km-reset', disabled: !isModified(k), 'data-tip': 'Restore\nRestore this key binding to its default', 'aria-label': 'Restore default', onclick: () => (resetBinding(k), this.draw(), app.changed('ui')) }, icon('km_restore')),
    );
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('ui') || kinds.has('doc')) {
      if (this.el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT' && !this.capturing) return;
      this.draw();
    }
  }

  serialize() {
    return { section: this.section };
  }

  dispose() {}
}

const ORDER = ['Window', 'Screen', 'Frames', '3D View', 'Object Mode', 'Mesh', 'Text', 'Console', 'Info'];
const order = (n: string) => {
  const i = ORDER.indexOf(n);
  return i < 0 ? ORDER.length : i;
};

export function itemLabel(k: KeyItem): string {
  if (!k.op) return k.menuTitle ? `${k.menuTitle} Menu` : 'Menu';
  const op = operators.get(k.op);
  let label = op?.label ?? k.op;
  if (k.props && Object.keys(k.props).length) {
    const v = Object.entries(k.props)
      .map(([key, x]) => (typeof x === 'string' ? x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, ' ') : typeof x === 'boolean' ? (x ? key.replace(/^use_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '') : typeof x === 'number' ? String(Math.round(x * 1000) / 1000) : ''))
      .filter(Boolean)
      .join(', ');
    if (v) label += ` (${v})`;
  }
  return label;
}

function row(label: string, value: string) {
  return h('div', { class: 'prefs-info-row' }, h('span', { class: 'pi-label' }, label), h('span', { class: 'pi-value' }, value));
}

let glInfo: [string, string][] | null = null;
function systemRows(): Child {
  if (!glInfo) {
    glInfo = [];
    try {
      const r = renderContext?.engine.renderer;
      const gl = (r?.getContext() as WebGL2RenderingContext | undefined) ?? document.createElement('canvas').getContext('webgl2');
      if (!gl) glInfo.push(['WebGL', 'Not available']);
      else {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        glInfo.push(['Vendor', String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR))]);
        glInfo.push(['Renderer', String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))]);
        glInfo.push(['Version', String(gl.getParameter(gl.VERSION))]);
        glInfo.push(['Shading Language', String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))]);
        glInfo.push(['Max Texture Size', String(gl.getParameter(gl.MAX_TEXTURE_SIZE))]);
        glInfo.push(['Max Samples', String(gl.getParameter(gl.MAX_SAMPLES))]);
        glInfo.push(['Extensions', String(gl.getSupportedExtensions()?.length ?? 0)]);
      }
      glInfo.push(['WebGPU', typeof navigator !== 'undefined' && 'gpu' in navigator ? 'Available' : 'Not available']);
    } catch (e) {
      glInfo.push(['WebGL', `Unavailable (${(e as Error).message})`]);
    }
  }
  return glInfo.map(([a, b]) => row(a, b));
}

function pythonRows(): Child {
  const st = python.state;
  return [
    row('Status', st === 'ready' ? `Loaded (Python ${python.version})` : st === 'loading' ? 'Loading…' : st === 'error' ? 'Failed to load' : 'Not loaded (loads on first use)'),
    row('Runtime', `Pyodide ${PYODIDE_VERSION} (MPL-2.0)`),
    row('Source', PYODIDE_INDEX_URL),
    st === 'error' ? h('div', { class: 'prefs-note err' }, python.error) : null,
  ];
}

function deviceRows(): Child {
  const n = navigator as Navigator & { deviceMemory?: number };
  return [
    row('Device Pixel Ratio', String(devicePixelRatio)),
    row('CPU Threads', String(n.hardwareConcurrency ?? '?')),
    row('Memory', n.deviceMemory ? `${n.deviceMemory} GB (approx.)` : 'Unknown'),
    row('Platform', (n as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? n.platform ?? ''),
    row('Browser', n.userAgent),
    row('Storage', typeof indexedDB !== 'undefined' ? 'IndexedDB available (session recovery)' : 'IndexedDB unavailable'),
  ];
}

registerEditor({ id: 'PREFERENCES', label: 'Preferences', icon: 'preferences', group: 'Data', create: (a, s) => new PreferencesEditor(a, s) });
