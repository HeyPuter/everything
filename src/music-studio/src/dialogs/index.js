// App dialogs and tool windows, registered as commands (menus pick them up
// by id): project settings, preferences, audio settings, shortcuts, about,
// getting started tour, undo history, tap tempo, purge unused, audio and
// stem export, and the signed-out "Open project" list.

import { openProjectSettings } from './project-settings.js';
import { openPreferences } from './preferences.js';
import { openShortcuts } from './shortcuts.js';
import { openAbout } from './about.js';
import { startTour, offerTourFromAlphaNotice } from './tour.js';
import { openHistory, openTapTempo, purgeCommand } from './tools.js';
import { openExportDialog } from './export.js';
import { openLocalProjects } from './open-local.js';

export function installDialogs(app) {
  const run = (fn) => () => Promise.resolve(fn()).catch((err) => app.reportError(err));
  app.openLocalProjects = () => openLocalProjects(app);
  app.openPreferences = (section) => openPreferences(app, { section });
  app.startTour = () => startTour(app);
  app.commands.register(
    { id: 'project.settings', label: 'Project settings...', run: run(() => openProjectSettings(app)) },
    { id: 'options.preferences', label: 'Preferences...', keys: ['Mod+,'], run: run(() => openPreferences(app)) },
    { id: 'options.audio', label: 'Audio settings...', run: run(() => openPreferences(app, { section: 'audio' })) },
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', keys: ['?', 'Mod+/'], run: run(() => openShortcuts(app)) },
    { id: 'help.about', label: 'About Music Studio', run: run(() => openAbout()) },
    { id: 'help.tour', label: 'Getting started tour', run: () => startTour(app) },
    { id: 'view.history', label: 'Undo history', keys: ['Alt+Z'], run: () => openHistory(app) },
    { id: 'tools.tapTempo', label: 'Tap tempo...', run: run(() => openTapTempo(app)) },
    { id: 'tools.purgeUnused', label: 'Purge unused...', run: run(() => purgeCommand(app)) },
    { id: 'file.exportWav', label: 'Audio (WAV)...', keys: ['Mod+R'], run: run(() => openExportDialog(app)) },
    { id: 'file.exportStems', label: 'Mixer stems (ZIP of WAV files)...', run: run(() => openExportDialog(app, { stems: true })) },
  );
  // The first-run alpha notice appears after start; offer the tour from it.
  app.once('ready', () => offerTourFromAlphaNotice(app));
  setTimeout(() => offerTourFromAlphaNotice(app), 0);
}
