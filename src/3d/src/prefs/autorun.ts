// Registered texts (Text ▸ Register) run when a project is opened, if Preferences ▸ Save & Load ▸
// Auto Run Scripts allows it.
import { app, onAppReady } from '../app/app';
import { prefs } from '../app/prefs';
import { fileEvents } from '../io/files';
import { runJavaScript, output } from '../scripting/runner';
import { loadPython, runPythonText } from '../scripting/python';

/** Whether a file name matches a pattern with * and ? wildcards (case-insensitive; a pattern without wildcards matches as a prefix). */
export function globMatch(pattern: string, name: string): boolean {
  if (!/[*?]/.test(pattern)) return name.toLowerCase().startsWith(pattern.toLowerCase());
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

export async function runRegisteredTexts(): Promise<number> {
  const texts = Object.values(app.doc.texts ?? {}).filter((t) => t.use_module && t.language !== 'text');
  if (!texts.length) return 0;
  const excluded = (prefs.autoexec_paths ?? []).find((pat) => pat.trim() && globMatch(pat.trim(), app.filename ?? ''));
  if (excluded) {
    app.report('WARNING', `${texts.length} registered script(s) not run: "${app.filename}" matches the excluded path "${excluded}"`);
    return 0;
  }
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
