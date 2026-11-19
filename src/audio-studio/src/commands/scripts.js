// File > Browse and Run Script: a dialog with a script editor, a library of
// example scripts and a Browse button that loads a JavaScript file (from
// Puter when signed in, else from this device). The script body runs as an
// async function with these arguments (SCRIPT_API below documents them in
// the dialog):
//
//   app       the application (documents, active, commands, prefs, ...)
//   run       (commandId, args?) => Promise, same as app.commands.run
//   log       (...values) => void, shown under the editor
//   files     { open(blobs), puter(path) } to open Files/Blobs or a Puter file
//   effect    (id, values?) => Promise<boolean>: applies an effect, unset values at their defaults
//   exportFile (doc, { format, name, folder, ... }) => Promise<{ path } | { download }>
//   seconds   (n, doc?) => frames of n seconds in doc (default: the active file)
//   marker    (at, { name, duration, type, doc }) => adds a marker (one undo step)
//   wait      (ms) => Promise
//
// Scripts can do anything the app can: the code is always in view before it runs.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { pickLocalFiles, openFiles, downloadBlob } from '../storage/files.js';
import * as puter from '../storage/puter.js';
import { getEffect, defaults, EFFECTS } from '../effects/registry.js';
import { createMarker, sortMarkers } from '../model/markers.js';
import { encodeDoc } from '../export/save.js';
import { defaultOptions, conformOptions, docBitDepth, withExtension, sanitizeFileName, stripExtension, getFormat } from '../export/formats.js';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** The helpers a script gets besides `app`, keyed by argument name. */
export function scriptHelpers(app, log) {
  const active = () => (app.active?.kind === 'audio' ? app.active : null);
  return {
    run: (id, args) => app.commands.run(id, args),
    log,
    files: {
      open: (blobs) => openFiles(app, Array.isArray(blobs) ? blobs : [blobs]),
      puter: async (path) => {
        const blob = await puter.readFile(path);
        return openFiles(app, [Object.assign(new File([blob], path.split('/').pop()), { path })]);
      },
    },
    effect: async (id, values = {}) => {
      const def = getEffect(id);
      if (!def) throw new Error(`There is no effect "${id}". effects() lists them.`);
      if (!active()) throw new Error('Open an audio file first (app.activate(doc) switches files).');
      const unknown = Object.keys(values).filter((k) => !def.params.some((p) => p.id === k));
      if (unknown.length) throw new Error(`${def.name} has no setting ${unknown.map((k) => `"${k}"`).join(', ')}. Its settings: ${def.params.map((p) => p.id).join(', ')}.`);
      return app.commands.run(`fx.${id}`, { values: { ...defaults(def), ...values } });
    },
    effects: () => [...EFFECTS.values()].map((d) => ({ id: d.id, name: d.name, params: d.params.map((p) => ({ id: p.id, default: p.default, min: p.min, max: p.max })) })),
    exportFile: async (doc = active(), o = {}) => {
      if (!doc || doc.kind !== 'audio') throw new Error('exportFile needs an audio file.');
      const format = getFormat(o.format || 'wav')?.id;
      if (!format) throw new Error(`Unknown format "${o.format}". Use wav, aiff, flac, mp3, opus or m4a.`);
      const base = defaultOptions({ sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc) }, format);
      const options = conformOptions(format, { ...base, ...o, format, settings: { ...base.settings, ...(o.settings || {}) } }).options;
      const name = withExtension(sanitizeFileName(o.name || stripExtension(doc.name)) || 'Untitled', format);
      const blob = await encodeDoc(doc, options);
      if (o.folder && puter.isSignedIn()) {
        const path = puter.joinPath(o.folder, name);
        await puter.writeFile(path, blob);
        return { path };
      }
      downloadBlob(blob, name);
      return { download: name };
    },
    seconds: (n, doc = active()) => Math.round(Number(n) * (doc?.sampleRate || 48000)),
    marker: (at, { name, duration = 0, type, doc = active() } = {}) => {
      if (!doc?.state?.markers) throw new Error('marker() needs an open audio file or session.');
      const m = createMarker({ name: name || undefined, start: Math.max(0, Math.round(at)), duration: Math.max(0, Math.round(duration)), ...(type ? { type } : {}) });
      doc.apply('Add Marker', { ...doc.state, markers: sortMarkers([...doc.state.markers, m]) });
      return m;
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Runs script source; resolves { ok, output: string[], error }. */
export async function runScript(app, source, { name = 'script' } = {}) {
  const output = [];
  const log = (...values) => output.push(values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '));
  try {
    const helpers = scriptHelpers(app, log);
    const names = Object.keys(helpers);
    const fn = new AsyncFunction('app', ...names, `"use strict";\n${source}\n//# sourceURL=${encodeURIComponent(name)}`);
    const result = await fn(app, ...names.map((k) => helpers[k]));
    if (result !== undefined) log(result);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output, error };
  }
}

/** The first `lines` lines of a script ("..." when there is more). */
export function scriptPreview(source, lines = 12) {
  const all = String(source).replace(/\r\n?/g, '\n').split('\n');
  const head = all.slice(0, lines).join('\n').trimEnd();
  return all.length > lines ? `${head}\n...` : head;
}

/** What scripts can use, shown in the dialog. */
export const SCRIPT_API = [
  ['app', 'The application: app.documents, app.active, app.activate(doc), app.prefs, app.notify(text).'],
  ['run(id, args?)', 'Runs a command by id, as a menu item or shortcut does (Keyboard Shortcuts lists the ids by name).'],
  ['effect(id, values?)', 'Applies an effect to the selection, or the whole active file; settings left out keep their defaults.'],
  ['effects()', 'Lists the effects with their setting ids, defaults and ranges.'],
  ['exportFile(doc, { format, name, folder, sampleRate, channels, bitDepth, settings })', 'Writes a file: to a Puter folder when signed in and folder is given, else as a download.'],
  ['files.open(blobs) / files.puter(path)', 'Opens File objects, or a Puter file by its path.'],
  ['seconds(n, doc?)', 'Frames in n seconds of a file (selections and the playhead are in frames).'],
  ['marker(at, { name, duration, type, doc })', 'Adds a marker at a frame (a range marker with a duration).'],
  ['log(...values)', 'Writes a line to the output below.'],
  ['wait(ms)', 'Pauses the script.'],
];

/** Example scripts for common automations. */
export const SCRIPT_EXAMPLES = [
  {
    name: 'List open files',
    about: 'Logs each audio file with its length, sample rate and channels.',
    code: `for (const doc of app.documents.filter((d) => d.kind === 'audio')) {
  log(doc.name, (doc.length / doc.sampleRate).toFixed(2) + ' s', doc.sampleRate + ' Hz', doc.channelCount + ' ch');
}`,
  },
  {
    name: 'Normalize every open file',
    about: 'Brings the peak of each open file to -1 dB.',
    code: `for (const doc of app.documents.filter((d) => d.kind === 'audio')) {
  app.activate(doc);
  doc.setSelection(0, 0); // no selection: the whole file
  await run('fx.normalizePeak', { peak: -1 });
  log('Normalized', doc.name);
}`,
  },
  {
    name: 'Fade in and out',
    about: 'Adds a 2-second fade at the start and end of the active file.',
    code: `const doc = app.active;
const len = Math.min(seconds(2), Math.floor(doc.length / 2));
doc.setSelection(0, len);
await run('fx.fadeIn');
doc.setSelection(doc.length - len, doc.length);
await run('fx.fadeOut');
doc.setSelection(0, 0);`,
  },
  {
    name: 'Apply an effect with settings',
    about: 'Raises the active file by 3 dB with Amplify; change the id and values for other effects.',
    code: `// effects() lists every effect id with its settings.
const ok = await effect('amplify', { left: 3, right: 3 });
log(ok ? 'Amplified' : 'Nothing was changed');`,
  },
  {
    name: 'Export every open file as MP3',
    about: 'Writes each open file as a 192 kbps MP3 (to ~/AudioStudio/MP3 when signed in to Puter).',
    code: `const folder = app.prefs.get('exportFolder') ? app.prefs.get('exportFolder') + '/MP3' : '~/AudioStudio/MP3';
for (const doc of app.documents.filter((d) => d.kind === 'audio')) {
  const r = await exportFile(doc, { format: 'mp3', settings: { bitrate: 192 }, folder });
  log(doc.name, '->', r.path || r.download);
}`,
  },
  {
    name: 'Marker every 30 seconds',
    about: 'Adds a cue marker every 30 seconds through the active file.',
    code: `const doc = app.active;
let n = 0;
for (let t = seconds(30); t < doc.length; t += seconds(30)) marker(t, { name: 'Part ' + ++n });
log('Markers:', doc.state.markers.length);`,
  },
];

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

/** The Scripts dialog: example library, editor, API reference and output. */
export function scriptsDialog(app) {
  let name = 'script.js';
  const editor = h('textarea.input.script-editor', { spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Script', rows: 14, wrap: 'off' });
  editor.value = app.prefs.get('scriptDraft') || SCRIPT_EXAMPLES[0].code;
  const nameText = h('span.script-name', app.prefs.get('scriptDraft') ? 'Your last script' : SCRIPT_EXAMPLES[0].name);
  const output = h('pre.script-output', { role: 'log', 'aria-label': 'Script output', 'aria-live': 'polite' });
  const status = h('span.script-status', { role: 'status' });
  const examples = h(
    'div.script-examples',
    { role: 'list', 'aria-label': 'Example scripts' },
    SCRIPT_EXAMPLES.map((ex) =>
      h('button.script-example', { type: 'button', role: 'listitem', title: ex.about, onclick: () => {
        editor.value = ex.code;
        name = `${ex.name}.js`;
        nameText.textContent = ex.name;
        output.textContent = '';
        status.textContent = ex.about;
        editor.focus();
      } }, h('strong', ex.name), h('span.muted', ex.about)),
    ),
  );
  const browse = h('button.btn', { type: 'button' }, icon('folder-open', 14), 'Browse...');
  browse.addEventListener('click', async () => {
    const file = await pickScript().catch((err) => {
      status.textContent = err?.message || 'The script could not be read.';
      return null;
    });
    if (!file) return;
    editor.value = file.source;
    name = file.name;
    nameText.textContent = file.name;
    output.textContent = '';
    status.textContent = `Loaded ${file.name}. Read it before running: scripts can change and close files and use your Puter account.`;
  });
  const save = h('button.btn', { type: 'button' }, icon('download', 14), 'Download');
  save.addEventListener('click', () => downloadBlob(new Blob([editor.value], { type: 'text/javascript' }), /\.m?js$/i.test(name) ? name : `${name}.js`));
  const runBtn = h('button.btn.primary', { type: 'button' }, icon('play', 14), 'Run');
  let running = false;
  const runNow = async () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    app.prefs.set('scriptDraft', editor.value);
    status.textContent = `Running ${name}...`;
    output.textContent = '';
    const r = await runScript(app, editor.value, { name });
    output.textContent = [...r.output, ...(r.ok ? [] : [`Error: ${r.error?.message || r.error}`])].join('\n');
    output.classList.toggle('script-failed', !r.ok);
    status.textContent = r.ok ? `${name} finished.` : `${name} stopped with an error.`;
    app.setStatus?.(status.textContent);
    running = false;
    runBtn.disabled = false;
  };
  runBtn.addEventListener('click', runNow);
  // Ctrl/Cmd+Enter runs; Tab inserts two spaces (Escape, then Tab, leaves the editor).
  let escaped = false;
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      runNow();
    } else if (e.key === 'Tab' && !e.shiftKey && !escaped) {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    } else if (e.key === 'Escape' && !escaped) {
      e.stopPropagation();
      escaped = true;
      status.textContent = 'Tab now moves to the next control.';
      return;
    }
    if (e.key !== 'Escape') escaped = false;
  });
  const api = h(
    'details.script-api',
    h('summary', 'What scripts can use'),
    h('dl', SCRIPT_API.flatMap(([k, v]) => [h('dt', h('code', k)), h('dd', v)])),
  );
  return openDialog({
    title: 'Scripts',
    className: 'scripts-dialog',
    wide: true,
    initialFocus: '.script-editor',
    body: h(
      'div.scripts',
      { 'data-own-enter': '' },
      h('section.script-library', h('h3.script-head', 'Examples'), examples),
      h('section.script-main', h('div.script-bar', nameText, h('span.spacer'), browse, save, runBtn), editor, h('div.faint.script-hint', 'Ctrl+Enter (⌘+Enter on Mac) runs the script.'), api, status, output),
    ),
    buttons: [{ label: 'Close', value: true }],
  });
}

export function installScriptCommands(app) {
  app.commands.register([{ id: 'file.runScript', label: 'Browse and Run Script...', run: () => scriptsDialog(app) }]);
}
