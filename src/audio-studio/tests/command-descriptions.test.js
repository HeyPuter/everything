import { expect, it } from 'vitest';
import { DESCRIPTIONS, describeCommand, asSentence } from '../src/commands/descriptions.js';
import { commandMenuPaths } from '../src/ui/menus.js';

async function fullApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  const app = new App();
  for (const install of FEATURES) install(app);
  return app;
}

it('describes the commands people look up, and builds the rest from what they are', async () => {
  const app = await fullApp();
  const C = app.commands;
  // Every written description belongs to a real command.
  expect(Object.keys(DESCRIPTIONS).filter((id) => !C.get(id))).toEqual([]);
  const paths = commandMenuPaths();
  const d = (id) => describeCommand(C, id, { paths, label: C.label(id) });
  expect(d('edit.copy')).toBe(DESCRIPTIONS['edit.copy']);
  // Effects describe themselves.
  expect(d('fx.amplify')).toMatch(/^Raises or lowers the level/);
  expect(d('window.markers')).toBe('Shows or hides the Markers panel.');
  expect(d('workspace.select3')).toBe('Switches to the Default workspace.');
  expect(d('prefs.general')).toBe('Opens Preferences at the General page.');
  expect(d('view.statusBar')).toMatch(/^Turns .* on or off/);
  expect(asSentence('Move Playhead to Previous')).toBe('Moves playhead to previous.');
  expect(asSentence('Apply Effects Rack')).toBe('Applies effects rack.');
  expect(asSentence('Switch to Next File')).toBe('Switches to next file.');
  expect(asSentence('Nudge Left 5 Steps')).toBe('Nudges left 5 steps.');
  expect(asSentence('Normalize')).toBe('Normalizes.');
  expect(asSentence('About Audio Studio')).toBe('');
  // Every command gets something to read.
  const empty = [...C.commands.keys()].filter((id) => !d(id));
  expect(empty.length / C.commands.size).toBeLessThan(0.03);
});

it('shows the description column and finds commands by their description', async () => {
  const app = await fullApp();
  const { shortcutsDialog } = await import('../src/ui/shortcuts-dialog.js');
  shortcutsDialog(app);
  const dlg = document.querySelector('.shortcuts-dialog');
  const search = dlg.querySelector('input[type=search], .sc-commands input');
  search.value = 'clipboard';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  const rows = [...dlg.querySelectorAll('.sc-row')];
  expect(rows.some((r) => r.dataset.id === 'edit.copy')).toBe(true);
  expect(rows.find((r) => r.dataset.id === 'edit.copy').querySelector('.sc-desc').textContent).toBe(DESCRIPTIONS['edit.copy']);
  document.querySelectorAll('.dialog-backdrop').forEach((b) => b.remove());
});
