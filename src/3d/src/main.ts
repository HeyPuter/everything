// Application entry point.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { Object3D } from 'three';
import { App, setApp, app } from './app/app';
import { startupDocument } from './data/defaults';
import { installKeyboard } from './app/keymap';
import './app/keys';
import './app/keys_extra';
import { RenderContext, setRenderContext } from './render/context';
import { onImageReady } from './render/images';
import { Shell, setShell } from './ui/shell';
import { installTooltips, pointerDownOutsideMenus } from './ui/menu';
// editors
import { View3D, setLastView3D } from './editors/view3d/view3d';
import { registerEditor } from './ui/screen';
import './editors/outliner';
import './editors/properties/properties';
import './editors/properties/tabs';
import './editors/properties/stack';
import './eval/modifiers_extra';
import './anim/motionpaths';
import './editors/view3d/tools3d';
import './ops/imageobjects';
import './ops/viewnav';
import './ops/bakeaction';
import './editors/filebrowser';
import './editors/timeline';
import './editors/uv/uveditor';
// operators
import './ops/object';
import './ops/view3d';
import './ops/screen';
import './ops/transform';
import './ops/wm';
import './ops/data';
import './io/files';
import { onFileStatus, scheduleAutosave, autosave, projectUiState } from './io/files';
import { loadRecovery, decodeDocument } from './io/native';
import { setMode } from './ops/object';
import { loadFonts } from './io/fonts';
import { registerModules } from './modules';
import { restoreAssistant } from './assistant';

// The app is Z-up; three.js defaults to Y-up for helpers.
Object3D.DEFAULT_UP.set(0, 0, 1);

setApp(new App(startupDocument()));

registerEditor({
  id: 'VIEW_3D',
  label: '3D Viewport',
  icon: 'view3d',
  group: 'General',
  create: (area, state) => {
    const v = new View3D(area, state);
    setLastView3D(v);
    return v;
  },
});

registerModules();

const root = document.getElementById('app')!;
let ctx: RenderContext;
try {
  ctx = new RenderContext(app, document.body);
  setRenderContext(ctx);
  ctx.engine.onLost = (msg) => showFatal(msg);
} catch (e) {
  showFatal(`WebGL 2 is required to display the 3D viewport. ${e instanceof Error ? e.message : ''}`);
}
onImageReady(() => {
  ctx?.forceSync();
  ctx?.engine.requestDraw();
});

const shell = new Shell(root);
setShell(shell);
restoreAssistant();
installKeyboard();
installTooltips(document.body);
addEventListener('pointerdown', (e) => pointerDownOutsideMenus(e.target), true);
addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

app.subscribe((kinds) => {
  shell.screen.update(kinds);
  shell.drawStatus();
  if (kinds.has('doc') || kinds.has('mode') || kinds.has('ui')) shell.drawTop();
  if (kinds.has('doc') || kinds.has('geometry')) scheduleAutosave();
});
onFileStatus((s) => {
  shell.fileStatus = s;
  shell.drawStatus();
});
setInterval(() => shell.drawStatus(), 2000);

app.changed('doc', 'ui');

// text objects get their outlines once the bundled font is loaded
void loadFonts(() => {
  app.graph.invalidate();
  app.changed('doc', 'geometry');
});

// Recover the last autosaved session (if any) without blocking startup. If the user already
// changed something before the stored session finished loading, their work wins.
const startRevision = app.revision;
// `?factory-startup` skips session recovery
const factoryStartup = new URLSearchParams(location.search).has('factory-startup');
const recovered = (factoryStartup ? Promise.resolve(null) : loadRecovery())
  .then((rec) => {
    if (!rec || app.revision !== startRevision) return;
    try {
      const { doc, extra } = decodeDocument(rec.bytes);
      const mode = doc.mode;
      doc.mode = 'OBJECT';
      app.setDocument(doc);
      app.filename = rec.name;
      if (extra.ui) projectUiState.load(extra.ui as Record<string, unknown>);
      // re-enter the saved mode through its handler so mode state is initialised
      if (mode !== 'OBJECT' && app.activeObject && setMode(app.doc, mode)) app.changed('mode');
      app.dirty = true;
      app.report('INFO', 'Recovered the last autosaved session');
    } catch {
      app.report('WARNING', 'The autosaved session could not be recovered');
    }
  })
  .catch(() => {});
(window as unknown as { appReady: Promise<void> }).appReady = recovered;

addEventListener('visibilitychange', () => {
  if (document.hidden) void autosave();
});
addEventListener('beforeunload', () => void autosave());

function showFatal(message: string) {
  const el = document.createElement('div');
  el.className = 'error-screen';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  document.body.append(el);
}

// expose for scripting & debugging
(window as unknown as { app: App }).app = app;
