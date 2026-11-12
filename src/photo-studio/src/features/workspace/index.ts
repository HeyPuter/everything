import type { Editor } from '../../editor';
import { commands, panels, registerCommand, type PanelLocation } from '../../app/registry';
import { formDialog } from '../../ui/dialog';
import { setToolbarLayout, toolbarLayout } from '../../app/toolbar-layout';
import { menuCustomization, setMenuCustomization } from '../../app/menu-custom';
import { customShortcuts, setCustomShortcuts } from '../arrange';
import {
  baseSnapshot, deleteWorkspace, sanitizeWorkspaceState, saveWorkspace, switchWorkspace, workspaceName, workspacePresets,
  type WorkspaceSnapshot, type WorkspaceState,
} from './layouts';
import { installToolPresets } from './tool-presets';
import { installStatusBar } from './status-bar';
import { lazy, lazyRun } from '../../app/lazy';

// Editors and the Preset Manager load on first use.
const customize = lazy(() => import('./customize'));
const presetManager = lazy(() => import('./preset-manager'));
const systemInfo = lazy(() => import('./system-info'));

// Workspaces (Window → Workspace), the options bar and tools panel toggles,
// toolbar and menu customization, tool presets, the Preset Manager, Print One
// Copy and System Info.

const stateKey = 'photo-studio-workspace';
const barsKey = 'photo-studio-bars';
// Saved workspaces appear in Window → Workspace through these reserved IDs.
export const maxSavedWorkspaces = 20;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
/** Store a value; false when the browser refused it (full or blocked storage). */
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
const UNSTORED = 'This browser could not store it (its storage is full or turned off), so it lasts until the page is closed.';
const registered = (): [string, PanelLocation][] => [...panels.values()].map((p) => [p.id, p.location]);

export function installWorkspace(e: Editor) {
  let state: WorkspaceState = sanitizeWorkspaceState(load(stateKey, null));
  const bars = load<{ optionsBar?: boolean; toolsPanel?: boolean }>(barsKey, {});
  const save = () => store(stateKey, state);

  const setBars = (optionsBar: boolean, toolsPanel: boolean) => {
    e.root.classList.toggle('options-hidden', !optionsBar);
    e.root.classList.toggle('tools-hidden', !toolsPanel);
    store(barsKey, { optionsBar, toolsPanel });
    // The canvas area changed size.
    window.dispatchEvent(new Event('resize'));
  };
  setBars(bars.optionsBar !== false, bars.toolsPanel !== false);
  const live = (): WorkspaceSnapshot => ({
    dock: e.dock.getLayout(),
    optionsBar: !e.root.classList.contains('options-hidden'),
    toolsPanel: !e.root.classList.contains('tools-hidden'),
  });
  const show = (s: WorkspaceSnapshot) => {
    e.dock.setLayout(s.dock);
    setBars(s.optionsBar, s.toolsPanel);
    if (s.shortcuts) setCustomShortcuts(s.shortcuts);
    if (s.toolbar) setToolbarLayout(s.toolbar);
    if (s.menus) setMenuCustomization(s.menus);
    e.toolbar.render();
    e.update();
  };
  const refreshLabels = () => {
    const reset = commands.get('window.workspace-reset');
    if (reset) reset.label = `Reset ${workspaceName(state, state.current)}`;
    for (let i = 0; i < maxSavedWorkspaces; i++) commands.delete(`window.workspace-user-${i}`);
    state.saved.slice(0, maxSavedWorkspaces).forEach((w, i) =>
      registerCommand({ id: `window.workspace-user-${i}`, label: w.name, recordable: false, checked: () => state.current === w.id, run: () => select(w.id) }),
    );
  };
  const select = (id: string) => {
    const next = switchWorkspace(state, live(), id, registered());
    state = next.state;
    save();
    show(next.show);
    refreshLabels();
  };

  for (const p of workspacePresets)
    registerCommand({ id: `window.workspace-${p.id}`, label: p.name, recordable: false, checked: () => state.current === p.id, run: () => select(p.id) });
  registerCommand(
    {
      id: 'window.workspace-reset',
      label: 'Reset Essentials',
      recordable: false,
      description: 'Restore the current workspace to its saved arrangement',
      run: () => {
        delete state.modified[state.current];
        save();
        show(baseSnapshot(state, state.current, registered()));
        e.message(`${workspaceName(state, state.current)} workspace reset.`);
      },
    },
    {
      id: 'window.workspace-new',
      label: 'New Workspace…',
      recordable: false,
      run: async () => {
        const v = await formDialog(
          'New Workspace',
          [
            { name: 'name', label: 'Name', value: state.saved.some((s) => s.id === state.current) ? workspaceName(state, state.current) : 'My Workspace' },
            { name: 'shortcuts', label: 'Include keyboard shortcuts', value: 'no', type: 'checkbox' },
            { name: 'toolbar', label: 'Include toolbar layout', value: 'yes', type: 'checkbox' },
            { name: 'menus', label: 'Include menu customization', value: 'no', type: 'checkbox' },
          ],
          'Save',
          'Saves the current panel arrangement and the options bar and tools panel. A workspace with the same name is replaced.',
        );
        const name = v?.name.trim();
        if (!v || !name) return;
        if (!state.saved.some((s) => s.name.toLowerCase() === name.toLowerCase()) && state.saved.length >= maxSavedWorkspaces) {
          e.message(`Up to ${maxSavedWorkspaces} workspaces can be saved. Delete one first.`);
          return;
        }
        const snapshot: WorkspaceSnapshot = live();
        if (v.shortcuts === 'yes') snapshot.shortcuts = customShortcuts();
        if (v.toolbar === 'yes') snapshot.toolbar = structuredClone(toolbarLayout());
        if (v.menus === 'yes') snapshot.menus = structuredClone(menuCustomization());
        state = saveWorkspace(state, name, snapshot, `user-${crypto.randomUUID()}`);
        const stored = save();
        refreshLabels();
        e.message(stored ? `Workspace “${name}” saved.` : `Workspace “${name}” set up. ${UNSTORED}`);
      },
    },
    {
      id: 'window.workspace-delete',
      label: 'Delete Workspace…',
      recordable: false,
      enabled: () => state.saved.length > 0,
      run: async () => {
        const v = await formDialog('Delete Workspace', [{ name: 'id', label: 'Workspace', value: state.saved.find((s) => s.id === state.current)?.id ?? state.saved[0].id, type: 'select', options: state.saved.map((s) => [s.id, s.name]) }], 'Delete');
        if (!v) return;
        const name = workspaceName(state, v.id);
        const wasCurrent = state.current === v.id;
        state = deleteWorkspace(state, v.id);
        save();
        if (wasCurrent) show(state.modified[state.current] ?? baseSnapshot(state, state.current, registered()));
        refreshLabels();
        e.message(`Workspace “${name}” deleted.`);
      },
    },
    {
      id: 'window.workspace-lock',
      label: 'Lock Workspace',
      recordable: false,
      description: 'Keep panels from being moved, resized or collapsed',
      checked: () => state.locked,
      run: () => {
        state.locked = !state.locked;
        e.dock.locked = state.locked;
        save();
        e.dock.render();
        e.message(state.locked ? 'Workspace locked.' : 'Workspace unlocked.');
      },
    },
    {
      id: 'window.options-bar',
      label: 'Options',
      recordable: false,
      checked: (e) => !e.root.classList.contains('options-hidden'),
      run: (e) => setBars(e.root.classList.contains('options-hidden'), !e.root.classList.contains('tools-hidden')),
    },
    {
      id: 'window.tools-panel',
      label: 'Tools',
      recordable: false,
      checked: (e) => !e.root.classList.contains('tools-hidden'),
      run: (e) => setBars(!e.root.classList.contains('options-hidden'), e.root.classList.contains('tools-hidden')),
    },
    { id: 'edit.toolbar', label: 'Toolbar…', recordable: false, description: 'Rearrange the toolbar and move tools to Extra Tools', ...lazyRun(customize, (m, e) => m.openToolbarEditor(e)) },
    { id: 'edit.menus', label: 'Menus…', recordable: false, shortcut: 'Mod+Alt+Shift+M', description: 'Hide or color menu commands', ...lazyRun(customize, (m, e) => m.openMenuEditor(e)) },
    { id: 'edit.preset-manager', label: 'Preset Manager…', recordable: false, description: 'Rename, reorder, delete, import and export presets', ...lazyRun(presetManager, (m, e) => m.openPresetManager(e)) },
    {
      id: 'file.print-one-copy',
      label: 'Print One Copy',
      shortcut: 'Mod+Alt+Shift+P',
      description: 'Print the image with the current settings, without the setup step',
      enabled: (e) => e.hasDocument,
      run: async (e) => {
        const { printImage } = await import('../files/info');
        await printImage(e);
      },
    },
    { id: 'help.system-info', label: 'System Info…', recordable: false, description: 'Graphics, memory and browser capabilities', ...lazyRun(systemInfo, (m, e) => m.showSystemInfo(e)) },
  );
  installToolPresets();
  installStatusBar(e);
  refreshLabels();

  // The dock exists once the workspace chrome is built (after features install).
  const attach = () => {
    if (!e.dock) {
      requestAnimationFrame(attach);
      return;
    }
    e.dock.locked = state.locked;
    e.dock.render();
  };
  queueMicrotask(attach);
}
