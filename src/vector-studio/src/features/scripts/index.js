/**
 * File > Scripts: built-in automation scripts, the Script Editor (type,
 * paste, run, save and download scripts, for tablets as much as
 * desktops), Other Script... to run a .js file from the device, recently
 * run and saved scripts, and the Scripting Reference. Scripts use the API
 * documented in runner.js.
 */
import './styles.css';
import { runScript } from './runner.js';
import { BUILT_IN_SCRIPTS } from './built-ins.js';
import {
  openScriptEditor,
  openScriptReference,
  pickScriptFile,
  rememberScript,
  errorText,
  RECENT_KEY,
} from './editor.js';

export { BUILT_IN_SCRIPTS };

async function run(app, name, source) {
  const r = await runScript(app, source, { name });
  if (r.ok) {
    if (r.value) app.notify(`${name}: ${r.value}`, { timeout: 6000 });
    else if (!r.changes) app.notify(`${name} finished.`, { polite: true });
  } else if (r.stopped) app.notify(`${name} was stopped.`, { polite: true });
  else app.notify(`${name}: ${errorText(r)}`, { error: true, timeout: 6000 });
  return r;
}

/** Ask for a .js file and run it; remember it in the recent list (source kept locally). */
function runOtherScript(app) {
  pickScriptFile((file, source) => {
    // Small scripts are remembered so they can be run again from the menu.
    rememberScript(app, file.name, source);
    run(app, file.name.replace(/\.m?js$/i, ''), source);
  });
}

export function install(app) {
  app.commands.register([
    {
      id: 'file.otherScript',
      label: 'Other Script...',
      shortcut: 'Mod+F12',
      enabled: (a) => Boolean(a.editor),
      run: (a) => runOtherScript(a),
    },
    {
      id: 'file.scriptEditor',
      label: 'Script Editor...',
      enabled: () => true,
      run: (a) => openScriptEditor(a),
    },
    {
      id: 'file.scriptReference',
      label: 'Scripting Reference...',
      enabled: () => true,
      run: () => openScriptReference(),
    },
    ...BUILT_IN_SCRIPTS.map((s) => ({
      id: `script.${s.id}`,
      label: s.label || s.name,
      enabled: (a) => Boolean(a.editor),
      run: (a) => run(a, s.name, s.source),
    })),
  ]);
  app.menuSources.set('scripts', (a) => {
    const recent = a.prefs.get(RECENT_KEY) || [];
    return [
      ...BUILT_IN_SCRIPTS.map((s) => `script.${s.id}`),
      ...(recent.length
        ? [
            '-',
            ...recent.map((r) => ({
              label: r.name,
              enabled: Boolean(a.editor),
              run: (x) => run(x, r.name.replace(/\.m?js$/i, ''), r.source),
            })),
          ]
        : []),
      '-',
      'file.scriptEditor',
      'file.scriptReference',
      'file.otherScript',
    ];
  });
}
