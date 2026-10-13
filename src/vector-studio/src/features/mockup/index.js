/**
 * Mockups: artwork placed onto a photo as a live, editable object.
 *
 *  - Object > Mockup: Make, Release, Edit Art (also a double-click) and
 *    Detect Surface; Object > Expand turns a mockup into plain artwork
 *  - corner handles on the canvas (Selection tool) for the perspective fit;
 *    Direct Selection bends the mesh fit
 *  - the Mockup panel (Window > Mockup)
 *
 * Match Font (Type > Match Font, the Match Font panel): identify lettering
 * in images or outlined type with Puter AI and set it as editable type.
 *
 * Expand Image (Object > Generative > Expand Image, Fill Bleed): extend a
 * placed image with Puter AI or, without it, on this device.
 */
import './styles.css';
import './mockup-model.js';
import { installLightingExport } from './lighting.js';
import { registerMockupIcons } from './icons.js';
import { isMockup } from './mockup-model.js';
import { MockupPanel } from './mockup-panel.js';
import { installMockupWidgets } from './mockup-widgets.js';
import { targetMockups, singleMockup, makeTargets, makeCommand, releaseCommand, toggleEditArt, detectCommand, finishEditingOutsideIsolation, editingArt } from './mockup-ui.js';
import { selectionDoubleClickHooks } from '../../tools/selection.js';
import { MatchFontPanel } from './match-font-panel.js';
import { matchSources } from './match-font.js';
import { singleImage, frameTargets, makeFrame, fillFrame, expandBy, fillBleed } from './expand-image.js';

/** Double-clicking a mockup with the Selection tool edits its art. */
function editOnDoubleClick(tool, target) {
  if (!isMockup(target) || editingArt(tool.editor.doc, target)) return false;
  tool.editor.select([target.id]);
  return toggleEditArt(tool.app, { on: true });
}

function registerCommands(app) {
  app.commands.register([
    {
      id: 'mockup.make',
      label: 'Make',
      enabled: (a) => Boolean(makeTargets(a.editor)),
      run: (a) => makeCommand(a),
    },
    {
      id: 'mockup.release',
      label: 'Release',
      enabled: (a) => targetMockups(a.editor).length > 0,
      run: (a) => releaseCommand(a),
    },
    {
      id: 'mockup.edit',
      label: (a) => {
        const m = singleMockup(a.editor);
        return m && editingArt(a.editor.doc, m) ? 'Finish Editing Art' : 'Edit Art';
      },
      enabled: (a) => Boolean(singleMockup(a.editor)),
      run: (a) => toggleEditArt(a),
    },
    {
      id: 'mockup.detect',
      label: 'Detect Surface',
      enabled: (a) => Boolean(singleMockup(a.editor)),
      run: (a) => detectCommand(a),
    },
    {
      id: 'type.matchFont',
      label: 'Match Font...',
      enabled: (a) => Boolean(a.editor),
      run: (a) => {
        a.openPanel('matchFont');
        const panel = a.dock?.panels.get('matchFont');
        if (panel && matchSources(a.editor).length) return panel.match();
        return null;
      },
    },
    { id: 'expandImage.makeFrame', label: 'Make Frame', enabled: (a) => Boolean(singleImage(a.editor)), run: (a) => makeFrame(a) },
    { id: 'expandImage.fill', label: 'Fill Frame...', enabled: (a) => Boolean(frameTargets(a.editor)), run: (a) => fillFrame(a) },
    { id: 'expandImage.expand', label: 'Expand By...', enabled: (a) => Boolean(singleImage(a.editor)), run: (a) => expandBy(a) },
    { id: 'expandImage.bleed', label: 'Fill Bleed...', enabled: (a) => Boolean(singleImage(a.editor)), run: (a) => fillBleed(a) },
  ]);
}

export function install(app) {
  registerMockupIcons();
  installLightingExport();
  registerCommands(app);
  app.registerPanel(MockupPanel);
  app.registerPanel(MatchFontPanel);
  installMockupWidgets(app);
  if (!selectionDoubleClickHooks.includes(editOnDoubleClick)) selectionDoubleClickHooks.push(editOnDoubleClick);
  // Leaving isolation (Escape, Exit Isolation Mode) also ends editing the art.
  const watched = new WeakSet();
  app.on('active-editor', (editor) => {
    if (!editor || watched.has(editor)) return;
    watched.add(editor);
    editor.on('isolation', () => finishEditingOutsideIsolation(editor));
  });
}
