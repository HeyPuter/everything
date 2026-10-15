// Registered texts (Text ▸ Register) run when a project is opened, if Preferences ▸ Save & Load ▸
// Auto Run Scripts allows it.
import { app, onAppReady } from '../app/app';
import { prefs } from '../app/prefs';
import { fileEvents } from '../io/files';
import { runJavaScript, output } from '../scripting/runner';
import { loadPython, runPythonText } from '../scripting/python';

export async function runRegisteredTexts(): Promise<number> {
  const texts = Object.values(app.doc.texts ?? {}).filter((t) => t.use_module && t.language !== 'text');
  if (!texts.length) return 0;
  if (!prefs.use_scripts_auto_execute) {
    app.report('WARNING', `${texts.length} registered script(s) not run: Auto Run Scripts is off (Preferences ▸ Save & Load)`);
    return 0;
  }
  let n = 0;
  for (const t of texts) {
    try {
      const r = t.language === 'python' ? (await loadPython(), runPythonText(t.body, t.name, `Run ${t.name}`)) : runJavaScript(t.body, t.name, `Run ${t.name}`);
      if (!r.ok) {
        output.push(`${t.name}: ${r.error}`, 'ERROR');
        app.report('ERROR', `Registered script "${t.name}" failed: ${r.error}`);
      } else n++;
    } catch (e) {
      app.report('ERROR', `Registered script "${t.name}" failed: ${(e as Error).message}`);
    }
  }
  return n;
}

onAppReady(() => {
  fileEvents.opened.push(() => void runRegisteredTexts());
  // the project the session starts with (after a recovered session has loaded)
  setTimeout(() => {
    const ready = (window as unknown as { appReady?: Promise<void> }).appReady ?? Promise.resolve();
    void ready.then(() => runRegisteredTexts());
  }, 0);
});
