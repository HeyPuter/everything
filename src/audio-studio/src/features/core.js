// Core feature: the editor and the basic panels plus core commands.

import { installCoreCommands } from '../commands/core.js';
import { installEditExtraCommands } from '../commands/edit-extra.js';
import { installFileExtraCommands } from '../commands/file-extra.js';
import { editorPanel } from '../panels/editor.js';
import { installPreviewEditorCommands } from '../editor/preview-editor.js';
import { filesPanel } from '../panels/files.js';
import { historyPanel } from '../panels/history.js';
import { markersPanel } from '../panels/markers.js';
import { levelsPanel, installMeterCommands } from '../panels/levels.js';
import { installStatusCommands } from '../ui/status-fields.js';
import { installViewCommands } from '../commands/view-extra.js';
import { installWorkspaceCommands } from '../ui/workspace-manager.js';
import { installHelpCommands } from '../commands/help.js';
import { installScriptCommands } from '../commands/scripts.js';
import { selectionPanel } from '../panels/selection.js';
import { propertiesPanel } from '../panels/properties.js';

export function installCore(app) {
  installCoreCommands(app);
  installEditExtraCommands(app);
  installFileExtraCommands(app);
  installMeterCommands(app);
  installStatusCommands(app);
  installViewCommands(app);
  installWorkspaceCommands(app);
  installHelpCommands(app);
  installScriptCommands(app);
  installPreviewEditorCommands(app);
  app.registerPanel({
    id: 'editor',
    title: (a) => (a.active ? `Editor: ${a.active.name}` : 'Editor'),
    closable: false,
    create: editorPanel,
    menu: (a) => [
      ...a.documents.map((d) => ({ type: 'cmd', label: d.name, enabled: true, checked: d === a.active, run: () => a.activate(d) })),
      ...(a.documents.length ? [{ type: 'sep' }] : []),
      { type: 'cmd', label: 'Close File', enabled: Boolean(a.active), run: () => a.closeDocument(a.active) },
      { type: 'cmd', label: 'Close All Files', enabled: a.documents.length > 0, run: () => a.commands.run('file.closeAll') },
    ],
  });
  app.registerPanel({ id: 'files', title: 'Files', create: filesPanel, near: ['favorites', 'media'], menu: (a) => a.dock?.instances.get('files')?.menu?.() || [] });
  app.registerPanel({ id: 'history', title: 'History', create: historyPanel, near: ['markers'], menu: (a) => a.dock?.instances.get('history')?.menu?.() || [] });
  app.registerPanel({ id: 'markers', title: 'Markers', create: markersPanel, near: ['effects', 'media'] });
  app.registerPanel({ id: 'levels', title: 'Levels', create: levelsPanel, menu: (a) => a.levelsMenu?.() || [] });
  app.registerPanel({ id: 'selection', title: 'Selection/View', create: selectionPanel, near: ['levels'] });
  app.registerPanel({ id: 'properties', title: 'Properties', create: propertiesPanel, near: ['assistant'] });
  // Panel titles that depend on the active document refresh with it.
  app.on('active', () => app.dock?.render());
  app.on('doc-change', (doc, e) => doc === app.active && e.kind === 'rename' && app.dock?.render());
}
