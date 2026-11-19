// File > Browse and Run Script: runs a JavaScript file (from Puter when signed in, else from
// this device) against the app,
// for automating repetitive work. The script body runs as an async function
// with these arguments:
//
//   app      the application (documents, active, commands, prefs, ...)
//   run      (commandId, args?) => Promise, same as app.commands.run
//   log      (...values) => void, shown in the script's result dialog
//   files    { open(blobs) } to open Files or Blobs as documents
//
// Example: normalize every open file
//   for (const doc of app.documents.filter((d) => d.kind === 'audio')) {
//     app.activate(doc);
//     await run('fx.normalizePeak', { peak: -1 });
//   }
//
// Scripts can do anything the app can, so the user confirms each run, seeing the start of
// the script first.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { pickLocalFiles, openFiles } from '../storage/files.js';
import * as puter from '../storage/puter.js';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Runs script source; resolves { ok, output: string[], error }. */
export async function runScript(app, source, { name = 'script' } = {}) {
  const output = [];
  const log = (...values) => output.push(values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '));
  try {
    const fn = new AsyncFunction('app', 'run', 'log', 'files', `"use strict";\n${source}\n//# sourceURL=${encodeURIComponent(name)}`);
    const result = await fn(app, (id, args) => app.commands.run(id, args), log, { open: (blobs) => openFiles(app, blobs) });
    if (result !== undefined) log(result);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output, error };
  }
}

/** The first `lines` lines of a script, for the confirmation ("..." when there is more). */
export function scriptPreview(source, lines = 12) {
  const all = String(source).replace(/\r\n?/g, '\n').split('\n');
  const head = all.slice(0, lines).join('\n').trimEnd();
  return all.length > lines ? `${head}\n...` : head;
}

async function pickScript() {
  if (puter.sdk() && puter.isSignedIn()) {
    const [item] = await puter.pickFiles({ multiple: false, accept: '.js,.mjs' });
    if (!item) return null;
    const blob = typeof item.read === 'function' ? await item.read() : await puter.readFile(item.path);
    return { name: item.name || blob.name || 'script.js', source: await blob.text() };
  }
  const [file] = await pickLocalFiles({ accept: '.js,.mjs,text/javascript', multiple: false });
  return file ? { name: file.name, source: await file.text() } : null;
}

async function runScriptFromFile(app) {
  const file = await pickScript();
  if (!file) return;
  const { source } = file;
  const lines = String(source).split('\n').length;
  const ok = await openDialog({
    title: 'Run Script',
    className: 'script-confirm',
    body: h(
      'div.script-result',
      h('p', { style: { margin: '0 0 8px', maxWidth: '520px' } }, `Run "${file.name}" (${lines} line${lines === 1 ? '' : 's'})? Scripts can change and close your files and use your Puter account, so only run scripts you trust.`),
      h('pre.script-output', { 'aria-label': 'Start of the script' }, scriptPreview(source)),
    ),
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Run', value: true, primary: true },
    ],
  });
  if (!ok) return;
  app.setStatus(`Running ${file.name}...`);
  const r = await runScript(app, source, { name: file.name });
  app.setStatus(r.ok ? `${file.name} finished` : `${file.name} failed`);
  if (!r.ok || r.output.length) {
    await openDialog({
      title: r.ok ? `${file.name}: Output` : `${file.name}: Error`,
      body: h(
        'div.script-result',
        r.ok ? null : h('p', { style: { color: 'var(--danger)', margin: '0 0 8px' } }, String(r.error?.message || r.error)),
        r.output.length ? h('pre.script-output', r.output.join('\n')) : null,
      ),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }
}

export function installScriptCommands(app) {
  app.commands.register([{ id: 'file.runScript', label: 'Browse and Run Script...', run: () => runScriptFromFile(app) }]);
}
