/**
 * Utility panels and the remaining menu commands:
 *
 *  - History, Actions, Links, Attributes, Document Info, Color Guide,
 *    Asset Export and Magic Wand panels
 *  - Object: Ungroup All, Lock/Hide All Artwork Above, Create Trim Marks,
 *    Path > Smooth, Align center and Align To, Switch Orientation, Clipping
 *    Mask > Edit Contents, Collect For Export
 *  - Select: Same Appearance Attribute / Graphic Style, Direction Handles,
 *    Global Edit, saved selections
 *  - Edit: My Settings, Edit Original, Convert to CMYK/RGB, Recolor with
 *    Preset, Overprint Black
 *  - File: Save as Template, Version History, Document Color Mode, File
 *    Info, Package
 *  - Help: Welcome Screen, What's New, System Info
 *
 * Installs after the type module so its hooks chain onto the ones type sets.
 */
import './styles.css';
import { registerPanelIcons } from './icons.js';
import { HistoryPanel, ensureOpenSnapshot } from './history.js';
import { ActionsPanel, syncActionCommands } from './actions-panel.js';
import { ActionEngine } from './actions-model.js';
import { LinksPanel, editOriginal } from './links.js';
import { AttributesPanel, installAttributeHooks } from './attributes.js';
import { DocumentInfoPanel } from './document-info-panel.js';
import { ColorGuidePanel } from './color-guide.js';
import { AssetExportPanel, registerAssetCommands } from './asset-export.js';
import { MagicWandPanel } from './magic-wand-panel.js';
import { registerObjectCommands } from './object-commands.js';
import { registerSelectCommands } from './select-commands.js';
import { registerEditCommands } from './edit-commands.js';
import { registerFileCommands } from './file-commands.js';
import { registerHelpCommands } from './help-commands.js';

export function install(app) {
  registerPanelIcons();
  for (const P of [HistoryPanel, ActionsPanel, LinksPanel, AttributesPanel, DocumentInfoPanel, ColorGuidePanel, AssetExportPanel, MagicWandPanel]) app.registerPanel(P);
  installAttributeHooks();
  registerObjectCommands(app);
  registerSelectCommands(app);
  registerEditCommands(app);
  registerFileCommands(app);
  registerHelpCommands(app);
  registerAssetCommands(app);

  app.commands.register({
    id: 'edit.editOriginal',
    label: 'Edit Original',
    enabled: (a) => a.editor?.selectedNodes().filter((n) => n.type === 'image').length === 1,
    run: (a) => editOriginal(a, a.editor, a.editor.selectedNodes().find((n) => n.type === 'image').id),
  });

  // Actions: recorder and player, and a command per action with a shortcut.
  app.actions = new ActionEngine(app, { onChange: () => app.dock?.update() });
  app.commands.register({
    id: 'actions.play',
    label: 'Play Action',
    enabled: (a, args) => Boolean(a.editor && args?.action),
    run: (a, args) => a.actions.play(args.action),
  });
  app.on('settings-imported', (values) => {
    if ('actionSets' in values) {
      app.actions.reload();
      syncActionCommands(app, app.actions);
    }
  });

  // Panels that show history refresh on history-only events (Clear History, snapshots).
  const watched = new WeakSet();
  app.on('active-editor', (ed) => {
    if (!ed || watched.has(ed.doc)) return;
    watched.add(ed.doc);
    // The History panel's "opened" snapshot: the document as it was first shown
    // (after the code that opened it finished setting it up).
    queueMicrotask(() => ensureOpenSnapshot(ed, app.prefs));
    ed.doc.on('history', () => app.editor?.doc === ed.doc && app.dock?.update());
  });
  app.on('started', () => syncActionCommands(app, app.actions));
}
