/**
 * Customizable keyboard shortcuts: Edit > Keyboard Shortcuts edits tool and
 * command shortcuts in named sets; the active set applies at startup and
 * when settings are imported.
 */
import './styles.css';
import { keyboardShortcutsDialog } from './dialog.js';
import { activeChanges, applyChanges } from './sets.js';

export function install(app) {
  app.commands.register({ id: 'edit.keyboardShortcuts', label: 'Keyboard Shortcuts...', shortcut: 'Alt+Shift+Mod+K', run: (a) => keyboardShortcutsDialog(a) });
  // The quick reference keeps its own name and no longer shares the key.
  const ref = app.commands.get('help.shortcuts');
  if (ref) app.commands.register({ ...ref, label: 'Shortcut Reference', shortcut: undefined, defaultShortcut: undefined });
  // Feature modules register commands until start, and panels register theirs on 'started'.
  app.on('started', () => applyChanges(app, activeChanges(app.prefs)));
  // Edit > My Settings > Import: an imported shortcut set applies right away.
  app.on('settings-imported', (values) => 'shortcutSets' in values && applyChanges(app, activeChanges(app.prefs)));
}
