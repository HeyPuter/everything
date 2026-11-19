// Preferences: the settings window (Edit → Preferences), applying settings to
// the workspace, tooltips and warnings that can be turned off.
import './preferences.css';
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { applyPreferences, syncCheckerSize } from './apply';
import { installTooltips } from './tooltips';
import { installReadouts } from './readouts';
import { lazy } from '../../app/lazy';
import { toolCursor } from './cursors';

export { warnOnce } from './warnings';

const preferencesWindow = lazy(() => import('./window'));

export function installPreferences(e: Editor) {
  registerCommand({
    id: 'edit.preferences',
    label: 'Preferences…',
    shortcut: 'Mod+K',
    recordable: false,
    description: 'Settings for the interface, tools, files, history and more',
    run: async () => void (await preferencesWindow()).openPreferences(e),
    prefetch: preferencesWindow.prefetch,
  });
  registerCommand({
    id: 'file.export-preferences',
    label: 'Export Preferences…',
    recordable: false,
    description: 'Quick export format, location, quality, metadata and color conversion',
    run: async () => void (await preferencesWindow()).openPreferences(e, 'export'),
    prefetch: preferencesWindow.prefetch,
  });
  e.cursorFor = (tool) => toolCursor(e, tool);
  e.preferenceHooks.push(applyPreferences);
  e.viewHooks.push(syncCheckerSize);
  installTooltips(e);
  installReadouts(e);
  applyPreferences(e);
}
