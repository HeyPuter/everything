// Application-level operators: About, Keyboard Shortcuts reference, Preferences window,
// Recover Last Session, Load Factory Preferences, Save Preferences, Purge Unused Data.
import { h, type Child } from '../ui/h';
import { appIcon, icon } from '../ui/icons';
import { app, registerOperators, operators } from '../app/app';
import { openMenu } from '../ui/menu';
import { keymaps, keyLabel } from '../app/keymap';
import { loadRecovery, decodeDocument } from '../io/native';
import { projectUiState } from '../io/files';
import { cloneShared } from '../data/cow';
import { openDialog, closeDialog } from './dialog';
import { PreferencesEditor, factoryPrefs, saveUserPrefs, itemLabel, type Section } from './prefs_editor';
import { purgeOrphanData, PURGEABLE } from './api';
import { PYODIDE_VERSION, PYODIDE_INDEX_URL } from './python';
import noticesMd from '../../THIRD_PARTY_NOTICES.md?raw';
import packageJson from '../../package.json?raw';

const pkg = (() => {
  try {
    return JSON.parse(packageJson) as { version?: string; dependencies?: Record<string, string> };
  } catch {
    return {};
  }
})();

export const APP_NAME = '3D';
export const APP_VERSION = pkg.version ?? '0.0.0';

/** Licences of the packages bundled into the application (checked against node_modules). */
const RUNTIME_LICENSES: Record<string, string> = {
  '@dimforge/rapier3d-compat': 'Apache-2.0',
  three: 'MIT',
  'three-gpu-pathtracer': 'MIT',
  'three-mesh-bvh': 'MIT',
  'xatlas-web': 'MIT',
  fzstd: 'MIT',
  'opentype.js': 'MIT',
  'three-bvh-csg': 'MIT',
  '@fontsource/inter': 'OFL-1.1',
  '@fontsource/jetbrains-mono': 'OFL-1.1',
};

// ---------------------------------------------------------------------------
// tiny Markdown renderer (headings, paragraphs, tables, lists, code, bold, links as text)

function inline(text: string): Child[] {
  const out: Child[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', null, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', null, t.slice(1, -1)));
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      out.push(/^https:\/\//.test(mm[2]) ? h('a', { href: mm[2], target: '_blank', rel: 'noopener noreferrer' }, mm[1]) : mm[1]);
    }
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(md: string): Child[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Child[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(h('p', null, inline(para.join(' '))));
    para = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) {
      flush();
      const level = /^#+/.exec(l)![0].length;
      out.push(h(`h${Math.min(6, level + 2)}`, null, inline(l.replace(/^#+\s*/, ''))));
      i++;
    } else if (/^\s*\|/.test(l)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(h('table', { class: 'md-table' }, h('thead', null, h('tr', null, (head ?? []).map((c) => h('th', null, inline(c))))), h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c))))))));
    } else if (/^\s*[-*]\s/.test(l)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s/, ''));
      out.push(h('ul', null, items.map((t) => h('li', null, inline(t)))));
    } else if (!l.trim()) {
      flush();
      i++;
    } else {
      para.push(l.trim());
      i++;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// About

function aboutBody(): Child {
  const deps = Object.entries(pkg.dependencies ?? {});
  return h(
    'div',
    { class: 'about' },
    h('div', { class: 'about-head' }, h('span', { class: 'about-logo' }, appIcon(40)), h('div', null, h('div', { class: 'about-name' }, APP_NAME), h('div', { class: 'about-version' }, `Version ${APP_VERSION}`))),
    h('p', null, `${APP_NAME} is a browser-based 3D creation suite: modelling, sculpting, painting, animation, node-based shading, rendering and scripting in Python or JavaScript.`),
    h('p', { class: 'about-note' }, 'Its interface follows the conventions of established open-source 3D software so existing skills and scripts carry over. It is an independent implementation and is not affiliated with or endorsed by any other 3D software project.'),
    h('h3', null, 'Credits'),
    h('p', null, 'Rendering is built on three.js; geometry, evaluation, editors and the scripting API are implemented in this project. Fonts: Inter and JetBrains Mono.'),
    h('h3', null, 'Bundled components'),
    h(
      'table',
      { class: 'md-table' },
      h('thead', null, h('tr', null, h('th', null, 'Package'), h('th', null, 'Version'), h('th', null, 'License'))),
      h('tbody', null, deps.map(([name, ver]) => h('tr', { key: name }, h('td', null, name), h('td', null, ver.replace(/^[\^~]/, '')), h('td', null, RUNTIME_LICENSES[name] ?? 'see package')))),
    ),
    h('h3', null, 'Loaded on demand'),
    h(
      'table',
      { class: 'md-table' },
      h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Version'), h('th', null, 'License'))),
      h('tbody', null, h('tr', null, h('td', null, 'Pyodide — Python runtime, downloaded unmodified the first time Python is used'), h('td', null, PYODIDE_VERSION), h('td', null, 'MPL-2.0'))),
    ),
    h('p', { class: 'about-note' }, `Source: ${PYODIDE_INDEX_URL}`),
    h('h3', null, 'Third-party notices'),
    h('div', { class: 'about-notices' }, renderMarkdown(noticesMd)),
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts reference (printable)

let refFilter = '';
function keymapReferenceBody(): Child {
  const q = refFilter.trim().toLowerCase();
  const groups = Object.entries(keymaps)
    .map(([name, items]) => {
      const seen = new Set<string>();
      const rows = items
        .filter((k) => !k.inactive && k.key !== 'NONE')
        .map((k) => ({ label: itemLabel(k), key: keyLabel(k) }))
        .filter((r) => {
          const id = `${r.label}|${r.key}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return !q || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) || name.toLowerCase().includes(q);
        });
      return { name, rows };
    })
    .filter((g) => g.rows.length);
  return h(
    'div',
    { class: 'kmref' },
    h(
      'div',
      { class: 'kmref-toolbar no-print' },
      h('label', { class: 'text-field' }, icon('search'), h('input', { value: refFilter, placeholder: 'Filter shortcuts', spellcheck: 'false', 'aria-label': 'Filter shortcuts', oninput: (e: Event) => ((refFilter = (e.target as HTMLInputElement).value), app.changed('ui')) })),
      h('button', { class: 'btn', onclick: () => printReference() }, 'Print…'),
    ),
    h('h2', { class: 'kmref-title print-only' }, `${APP_NAME} — Keyboard Shortcuts`),
    h(
      'div',
      { class: 'kmref-cols' },
      groups.map((g) =>
        h(
          'section',
          { key: g.name, class: 'kmref-group' },
          h('h3', null, g.name),
          h('table', null, h('tbody', null, g.rows.map((r, i) => h('tr', { key: i }, h('td', { class: 'kmref-label' }, r.label), h('td', { class: 'kmref-key' }, r.key.split(' ').map((p) => h('kbd', null, p))))))),
        ),
      ),
    ),
  );
}

function printReference() {
  document.body.classList.add('printing-kmref');
  const done = () => {
    document.body.classList.remove('printing-kmref');
    removeEventListener('afterprint', done);
  };
  addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}

// ---------------------------------------------------------------------------
// Preferences window

let prefsEditor: PreferencesEditor | null = null;
export function showPreferences(section?: Section) {
  if (!prefsEditor) prefsEditor = new PreferencesEditor(null);
  if (section) prefsEditor.section = section;
  const ed = prefsEditor;
  openDialog({
    id: 'preferences',
    title: 'Preferences',
    floating: true,
    width: 760,
    height: 560,
    className: 'prefs-window',
    body: () => {
      ed.update(new Set(['ui']));
      return h('div', { class: 'prefs-host', ref: (el: HTMLElement) => el.append(ed.el) });
    },
    onClose: () => {
      prefsEditor = null;
    },
  });
}

// ---------------------------------------------------------------------------
// orphan purge preview

function purgePreview(): { total: number; byType: [string, number][] } {
  const d = cloneShared(app.doc);
  const before = PURGEABLE.map((t) => Object.keys((d as unknown as Record<string, object | undefined>)[t] ?? {}).length);
  purgeOrphanData(d);
  const byType: [string, number][] = [];
  let total = 0;
  PURGEABLE.forEach((t, i) => {
    const n = before[i] - Object.keys((d as unknown as Record<string, object | undefined>)[t] ?? {}).length;
    if (n) byType.push([t.replace(/_/g, ' '), n]);
    total += n;
  });
  return { total, byType };
}

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'wm.about',
    label: 'About',
    description: `Show information about ${APP_NAME}`,
    undo: false,
    exec: () => void openDialog({ id: 'about', title: `About ${APP_NAME}`, width: 620, className: 'about-dialog', body: aboutBody }),
  },
  {
    idname: 'wm.keymap_reference',
    label: 'Keyboard Shortcuts',
    description: 'Show a printable reference of all keyboard shortcuts',
    undo: false,
    exec: () => void openDialog({ id: 'kmref', title: 'Keyboard Shortcuts', width: 880, className: 'kmref-dialog', body: keymapReferenceBody }),
  },
  {
    idname: 'screen.userpref_show',
    label: 'Open Preferences…',
    description: 'Edit user preferences and keymaps',
    undo: false,
    props: [{ id: 'section', label: 'Section', type: 'string', default: '', hidden: true }],
    exec: (_c, p) => showPreferences((String(p.section || '') || undefined) as Section | undefined),
  },
  {
    idname: 'wm.save_userpref',
    label: 'Save Preferences',
    description: 'Make the current preferences default',
    undo: false,
    exec: () => saveUserPrefs(),
  },
  {
    idname: 'wm.read_factory_userpref',
    label: 'Load Factory Preferences',
    description: 'Load factory default preferences and key bindings (your scene is kept)',
    undo: false,
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    exec: (_c, p) => {
      if (p.confirm) {
        openMenu(
          [{ heading: 'Load factory default preferences?' }, { label: 'Load Factory Preferences', icon: 'error', action: () => app.run('wm.read_factory_userpref', { confirm: false }) }],
          { x: app.pointer.x, y: app.pointer.y },
        );
        return 'CANCELLED';
      }
      factoryPrefs();
      app.report('INFO', 'Factory preferences loaded');
    },
  },
  {
    idname: 'wm.read_factory_settings',
    label: 'Load Factory Settings',
    description: 'Start over with the factory default scene, workspaces and preferences (your saved startup file is kept)',
    undo: false,
    props: [
      { id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true },
      { id: 'use_empty', label: 'Empty', type: 'bool', default: false },
    ],
    exec: (_c, p) => {
      if (p.confirm) {
        openMenu(
          [{ heading: 'Load factory settings? Unsaved changes are lost.' }, { label: 'Load Factory Settings', icon: 'error', action: () => app.run('wm.read_factory_settings', { confirm: false, use_empty: p.use_empty }) }],
          { x: app.pointer.x, y: app.pointer.y },
        );
        return 'CANCELLED';
      }
      factoryPrefs();
      app.run('wm.read_homefile', { use_factory_startup: true });
      if (p.use_empty) {
        app.run('object.select_all', { action: 'SELECT' }, { invoke: false });
        app.run('object.delete', { confirm: false }, { invoke: false });
        app.undo.reset(app.doc);
      }
      app.report('INFO', 'Factory settings loaded');
    },
  },
  {
    idname: 'wm.recover_last_session',
    label: 'Recover Last Session',
    description: 'Open the automatically saved session',
    undo: false,
    exec: () => {
      void loadRecovery().then((rec) => {
        if (!rec) {
          app.report('WARNING', 'No autosaved session found');
          return;
        }
        try {
          const { doc, extra } = decodeDocument(rec.bytes);
          app.setDocument(doc);
          app.filename = rec.name;
          if (extra.ui && typeof extra.ui === 'object') projectUiState.load(extra.ui as Record<string, unknown>);
          app.report('INFO', `Recovered session from ${new Date(rec.time).toLocaleString()}`);
        } catch (e) {
          app.report('ERROR', `The autosaved session could not be recovered: ${(e as Error).message}`);
        }
      });
    },
  },
  {
    idname: 'outliner.orphans_purge',
    label: 'Purge Unused Data',
    description: 'Remove all unused data-blocks (meshes, materials, images, actions, node groups, textures…) without a fake user',
    props: [
      { id: 'do_recursive', label: 'Recursive Delete', type: 'bool', default: true },
      { id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true },
    ],
    invoke: (_c, p) => {
      if (!p.confirm) return app.run('outliner.orphans_purge', { ...p, confirm: false }, { invoke: false }) as 'FINISHED';
      const prev = purgePreview();
      if (!prev.total) {
        app.report('INFO', 'No orphaned data-blocks to purge');
        return 'CANCELLED';
      }
      openMenu(
        [
          { heading: `Purge Unused Data (${prev.total} data-block${prev.total === 1 ? '' : 's'})` },
          ...prev.byType.map(([t, n]) => ({ label: `${n} ${t}`, disabled: true })),
          { separator: true },
          { label: 'Delete', icon: 'trash', action: () => app.run('outliner.orphans_purge', { do_recursive: p.do_recursive, confirm: false }, { invoke: false }) },
        ],
        { x: app.pointer.x, y: app.pointer.y },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const n = purgeOrphanData(ctx.doc, !!p.do_recursive);
      if (!n) {
        app.report('INFO', 'No orphaned data-blocks to purge');
        return 'CANCELLED';
      }
      app.report('INFO', `Deleted ${n} data-block${n === 1 ? '' : 's'}`);
      return 'FINISHED';
    },
  },
]);

export { closeDialog, operators };
