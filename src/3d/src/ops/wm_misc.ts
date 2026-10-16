// Window-manager operators: restore operator defaults, the operator cheat sheet, reloading
// preferences and the recent files list, opening links, theme and key configuration presets,
// closing windows and quitting.
import { app, defaultProps, operators, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { newText } from '../data/defaults';
import { pyLiteral } from '../scripting/oplog';
import { uniqueName } from '../scripting/api';
import { revertPrefs } from '../prefs/store';
import { saveUserTheme, removeUserTheme, setThemePreset, themeState, userThemes } from '../prefs/theme_ui';
import { saveUserPreset, removeUserPreset, userPresets as userKeyconfigs, keyconfig } from '../prefs/keyconfig';
import { reloadRecent } from '../io/session';
import { areaWindows, closeAreaWindow, openAreaWindow } from '../ui/areawindow';
import { defaultWorkspaces, newAreaId, type Area } from '../ui/screen';
import { leaves } from '../ui/layout';
import { openDialog, closeDialog } from '../scripting/dialog';
import { h } from '../ui/h';
import { shell } from '../ui/shell';

// ---------------------------------------------------------------------------
// operator defaults, cheat sheet

/** Every operator call with its default properties, one per line, grouped by category. */
export function operatorCheatSheet(): string {
  const lines = ['# Operators and their default properties', ''];
  let group = '';
  for (const op of [...operators.values()].sort((a, b) => a.idname.localeCompare(b.idname))) {
    const g = op.idname.split('.')[0];
    if (g !== group) {
      if (group) lines.push('');
      lines.push(`# ${g}`);
      group = g;
    }
    const d = defaultProps(op);
    const args = (op.props ?? []).filter((p) => !p.hidden).map((p) => `${p.id}=${pyLiteral(d[p.id])}`);
    lines.push(`bpy.ops.${op.idname}(${args.join(', ')})`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// links

/** Our own help destinations for wm.url_open_preset. */
const feedbackDialog = () => (globalThis as unknown as { puter?: { ui?: { showFeedbackDialog?: () => Promise<boolean> } } }).puter?.ui?.showFeedbackDialog;

const URL_PRESETS: [string, string, string][] = [
  ['BUG', 'Report a Bug', 'Tell the people who make this app about a problem'],
  ['SHORTCUTS', 'Keyboard Shortcuts', 'The list of all key bindings'],
  ['ABOUT', 'About', 'Version, credits and licences'],
];

function openUrlPreset(type: string): boolean {
  if (type === 'BUG') {
    // the Puter SDK is loaded on first use
    void import('../assistant/puter').then(async (m) => {
      await m.loadPuter();
      const f = feedbackDialog();
      if (!f) return app.report('WARNING', 'Feedback can be sent when the app runs in Puter');
      if (await f()) app.report('INFO', 'Thank you for your feedback');
    });
    return true;
  }
  if (type === 'SHORTCUTS') return app.run('wm.keymap_reference') !== 'CANCELLED';
  if (type === 'ABOUT') return app.run('wm.about') !== 'CANCELLED';
  return false;
}

// ---------------------------------------------------------------------------
// quitting

/** Leave the app: Puter closes its window; a browser tab can only be closed when the script opened it. */
function quitNow() {
  const p = (globalThis as unknown as { puter?: { exit?: () => void } }).puter;
  if (typeof p?.exit === 'function') {
    p.exit();
    return;
  }
  try {
    window.close();
  } catch {
    // ignored: browsers only close windows that scripts opened
  }
  setTimeout(() => {
    if (window.closed) return;
    openDialog({
      id: 'quit',
      title: 'Quit',
      width: 380,
      body: () =>
        h(
          'div',
          { class: 'quit-note' },
          h('p', null, 'The browser keeps this tab open. Close the tab (Ctrl W / ⌘ W) to quit.'),
          h('p', null, app.dirty ? 'Your work is kept in the auto save copy until you open another file.' : 'Your work is saved.'),
          h('div', { class: 'op-dialog-buttons' }, h('button', { class: 'btn primary', onclick: () => closeDialog('quit') }, 'Keep Working')),
        ),
    });
  }, 250);
}

function confirmQuit() {
  if (!app.dirty) return quitNow();
  openDialog({
    id: 'quit-confirm',
    title: 'Save changes before quitting?',
    width: 420,
    body: () =>
      h(
        'div',
        { class: 'quit-note' },
        h('p', null, `"${app.filename}" has unsaved changes.`),
        h(
          'div',
          { class: 'op-dialog-buttons quit-buttons' },
          h('button', { class: 'btn', onclick: () => closeDialog('quit-confirm') }, 'Cancel'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                closeDialog('quit-confirm');
                quitNow();
              },
            },
            "Don't Save",
          ),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                closeDialog('quit-confirm');
                app.run('wm.save_mainfile', {}, { invoke: false });
                // writable folders save asynchronously: wait until the file is clean
                const t0 = performance.now();
                const wait = () => (!app.dirty || performance.now() - t0 > 4000 ? quitNow() : setTimeout(wait, 100));
                wait();
              },
            },
            'Save & Quit',
          ),
        ),
      ),
  });
}

// ---------------------------------------------------------------------------
// windows

/** The floating window an area belongs to (null for the main window). */
function windowOf(ctx: OpContext): string | null {
  const a = ctx.area as Area | null;
  if (!a) return null;
  for (const [id, sc] of areaWindows) if (sc.areas.includes(a)) return id;
  return null;
}

// ---------------------------------------------------------------------------

const presetProps = [
  { id: 'name', label: 'Name', type: 'string' as const, default: '' },
  { id: 'remove_name', label: 'Remove Name', type: 'bool' as const, default: false, hidden: true },
  { id: 'remove_active', label: 'Remove Active', type: 'bool' as const, default: false, hidden: true },
];

const activeThemeName = () => (themeState.preset.startsWith('user:') ? themeState.preset.slice(5) : '');

registerOperators([
  {
    idname: 'wm.operator_defaults',
    label: 'Restore Defaults',
    description: 'Set the settings of the last operation back to their defaults',
    undo: false,
    poll: () => !!app.lastOp && !!operators.get(app.lastOp.idname)?.props?.length,
    exec: () => {
      const last = app.lastOp!;
      const op = operators.get(last.idname)!;
      const d = defaultProps(op);
      // hidden properties carry what the operation acted on: keep them
      for (const p of op.props ?? []) if (p.hidden) d[p.id] = last.props[p.id];
      app.redoLast(d);
    },
  },
  {
    idname: 'wm.operator_cheat_sheet',
    label: 'Operator Cheat Sheet',
    description: 'List every operator with its default properties in a new text block',
    exec: (ctx) => {
      const t = newText(uniqueName(ctx.doc.texts, 'OperatorList.txt'), operatorCheatSheet(), 'python');
      ctx.doc.texts[t.id] = t;
      // show it in a Text Editor when one is open
      const area = shell?.screen.findArea('TEXT');
      (area?.editor as unknown as { setText?: (id: string) => void } | undefined)?.setText?.(t.id);
      app.report('INFO', `See "${t.name}" in the Text Editor`);
    },
  },
  {
    idname: 'wm.read_userpref',
    label: 'Revert to Saved Preferences',
    description: 'Discard preference changes that were not saved',
    undo: false,
    exec: () => {
      revertPrefs();
      app.report('INFO', 'Preferences reverted to the saved state');
      app.changed('ui');
    },
  },
  {
    idname: 'wm.read_history',
    label: 'Reload History File',
    description: 'Read the list of recent files again (e.g. after another tab changed it)',
    undo: false,
    exec: () => void reloadRecent().then(() => app.changed('ui')),
  },
  {
    idname: 'wm.url_open',
    label: 'Open Website',
    description: 'Open a web address in a new browser tab',
    undo: false,
    internal: true,
    props: [{ id: 'url', label: 'URL', type: 'string', default: '' }],
    exec: (_c, p) => {
      const url = String(p.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        app.report('WARNING', 'Only http and https addresses can be opened');
        return 'CANCELLED';
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  },
  {
    idname: 'wm.url_open_preset',
    label: 'Open Help',
    description: 'Open a help destination: report a bug, the keyboard shortcuts, or About',
    undo: false,
    props: [{ id: 'type', label: 'Site', type: 'enum', default: 'SHORTCUTS', items: URL_PRESETS }],
    exec: (_c, p) => (openUrlPreset(String(p.type)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'wm.interface_theme_preset_add',
    label: 'Add Theme Preset',
    description: 'Save the current theme colours as a theme of your own (or remove one)',
    undo: false,
    props: presetProps,
    exec: (_c, p) => {
      const name = String(p.remove_active ? activeThemeName() : (p.name ?? '')).trim();
      if (!name) return 'CANCELLED';
      if (p.remove_name || p.remove_active) {
        if (!(name in userThemes())) return 'CANCELLED';
        removeUserTheme(name);
      } else {
        saveUserTheme(name);
        setThemePreset(`user:${name}`);
      }
      app.changed('ui');
    },
  },
  {
    idname: 'wm.interface_theme_preset_remove',
    label: 'Remove Theme Preset',
    description: 'Remove a theme of your own (the active one when no name is given)',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => Object.keys(userThemes()).length > 0,
    exec: (_c, p) => {
      const name = String(p.name || activeThemeName());
      if (!(name in userThemes())) return 'CANCELLED';
      removeUserTheme(name);
      app.changed('ui');
    },
  },
  {
    idname: 'wm.interface_theme_preset_save',
    label: 'Save Theme Preset',
    description: 'Store the current colours in the active theme of your own',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => !!activeThemeName(),
    exec: (_c, p) => {
      const name = String(p.name || activeThemeName());
      saveUserTheme(name);
      setThemePreset(`user:${name}`);
      app.report('INFO', `Saved theme "${name}"`);
    },
  },
  {
    idname: 'wm.keyconfig_preset_add',
    label: 'Add Keyconfig Preset',
    description: 'Save the current key bindings as a key configuration of your own (or remove one)',
    undo: false,
    props: presetProps,
    exec: (_c, p) => {
      const name = String(p.remove_active ? (keyconfig.data.name ?? '') : (p.name ?? '')).trim();
      if (!name) return 'CANCELLED';
      if (p.remove_name || p.remove_active) {
        if (!(name in userKeyconfigs())) return 'CANCELLED';
        removeUserPreset(name);
      } else saveUserPreset(name);
      app.changed('ui');
    },
  },
  {
    idname: 'wm.keyconfig_preset_remove',
    label: 'Remove Keyconfig Preset',
    description: 'Remove a key configuration of your own (the active one when no name is given)',
    undo: false,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => Object.keys(userKeyconfigs()).length > 0,
    exec: (_c, p) => {
      const name = String(p.name || keyconfig.data.name || '');
      if (!(name in userKeyconfigs())) return 'CANCELLED';
      removeUserPreset(name);
      app.changed('ui');
    },
  },
  {
    idname: 'wm.window_close',
    label: 'Close Window',
    description: 'Close the window under the pointer (the main window: quit)',
    undo: false,
    exec: (ctx) => {
      const id = windowOf(ctx);
      if (id) closeAreaWindow(id);
      else confirmQuit();
    },
  },
  {
    idname: 'wm.window_new_main',
    label: 'New Main Window',
    description: 'Open a window with the factory layout of the active workspace',
    undo: false,
    poll: () => !!shell,
    exec: () => {
      const ws = defaultWorkspaces().find((w) => w.name === shell.active) ?? defaultWorkspaces()[0];
      const layout = structuredClone(ws.layout);
      for (const st of leaves(layout)) st.id = newAreaId();
      const w = Math.round(innerWidth * 0.75),
        hh = Math.round(innerHeight * 0.75);
      openAreaWindow(layout, { width: w, height: hh, x: (innerWidth - w) / 2, y: 50, title: ws.name });
    },
  },
  {
    idname: 'wm.properties_context_change',
    label: 'Change Properties Tab',
    description: 'Show a tab of the Properties editor (OBJECT, MODIFIER, MATERIAL, …)',
    undo: false,
    internal: true,
    props: [{ id: 'context', label: 'Context', type: 'string', default: '' }],
    exec: (ctx, p) => {
      const tab = String(p.context ?? '').toUpperCase();
      const a = ctx.area?.type === 'PROPERTIES' ? (ctx.area as Area) : shell?.screen.findArea('PROPERTIES');
      const ed = a?.editor as unknown as { setTab?: (id: string) => void } | undefined;
      if (!ed?.setTab || !tab) return 'CANCELLED';
      ed.setTab(tab);
      app.changed('ui');
    },
  },
  {
    idname: 'wm.quit_blender',
    label: 'Quit',
    description: 'Leave the app, offering to save unsaved changes first',
    undo: false,
    exec: () => confirmQuit(),
  },
]);

addKeys('Window', [{ key: 'Q', ctrl: true, op: 'wm.quit_blender' }]);
