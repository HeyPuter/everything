// Saving and exporting documents: Save (back to the document's Puter file in
// its own format), Save As, Save a Copy, Export File, Save Selection As and
// Download. Encoding always runs in the export worker behind a cancellable
// progress dialog.

import { exportAudio } from './export.js';
import { exportFileDialog } from './dialog.js';
import { withProgress } from './progress.js';
import { conformOptions, defaultOptions, docBitDepth, formatForName, getFormat } from './formats.js';
import { confirmDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';
import { downloadBlob, rememberRecent } from '../storage/files.js';

/** Encodes frames [start, end) of a document with export options. */
export function encodeDoc(doc, options, { start = 0, end = doc.length, onProgress, signal } = {}) {
  return exportAudio({ channels: doc.state.channels, sampleRate: doc.sampleRate, start, end, markers: doc.state.markers, meta: doc.state.meta || {} }, options, { onProgress, signal });
}

/** Options for re-saving a document in `format`: what it was last saved with, else its own sample type. */
export function optionsForSave(doc, format) {
  const last = doc.info?.exportOptions;
  if (last && last.format === format) return conformOptions(format, last).options;
  const source = { sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc) };
  return defaultOptions(source, format);
}

function encodeWithProgress(doc, options, range, label) {
  return withProgress(label, (onProgress, signal) => encodeDoc(doc, options, { ...range, onProgress, signal }), { detail: label });
}

/**
 * Uploads to Puter behind a progress dialog. An upload cannot be stopped, so
 * Cancel only hides the dialog: a failure is still thrown (withProgress would
 * report it as a cancel), and the caller never marks an unsaved file saved.
 */
async function upload(label, path, blob) {
  let failure = null;
  const item = await withProgress(
    label,
    () =>
      puter.writeFile(path, blob).catch((err) => {
        failure = err;
        throw err;
      }),
    { delay: 600, detail: 'Uploading to Puter' },
  );
  if (failure) throw failure;
  return item;
}

/** File > Save: in place when the document has a Puter file in a writable format, else Save As. */
export async function saveDocument(app, doc, { saveAs = false, copy = false } = {}) {
  if (!doc) return false;
  const path = doc.source?.type === 'puter' ? doc.source.path : null;
  const format = path ? formatForName(path) : null;
  if (!saveAs && !copy && path && format && getFormat(format)) {
    if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) return false;
    const options = optionsForSave(doc, format);
    const state = doc.state;
    const blob = await encodeWithProgress(doc, options, {}, `Saving ${doc.name}`);
    if (!blob) return false;
    await upload(`Saving ${doc.name}`, path, blob);
    // Only mark saved if nothing changed while encoding.
    if (doc.state === state) doc.markSaved();
    app.setStatus(`Saved ${doc.name}`);
    return true;
  }
  return saveFlow(app, doc, { mode: copy ? 'copy' : 'saveAs' });
}

/**
 * The dialog-driven flows. mode: 'saveAs' | 'copy' | 'export' | 'selection' | 'download'.
 * `range` = [start, end) for 'selection'.
 */
export async function saveFlow(app, doc, { mode = 'export', range = null } = {}) {
  const [start, end] = range || [0, doc.length];
  let initialName;
  for (;;) {
    const r = await exportFileDialog(app, doc, { mode, frames: end - start, initialName });
    if (!r) return false;
    let path = null;
    let dir = null;
    if (r.location.type === 'puter') {
      if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) {
        app.notify('Sign in to Puter to save there, or choose This device.', { error: true });
        initialName = r.fileName;
        continue;
      }
      dir = r.location.dir || (await puter.appDir());
      path = puter.joinPath(dir, r.fileName);
      const isCurrent = mode === 'saveAs' && doc.source?.type === 'puter' && doc.source.path === path;
      if (!isCurrent && (await puter.exists(path))) {
        const ok = await confirmDialog({ title: 'Replace File?', message: `"${r.fileName}" already exists in ${dir}. Do you want to replace it?`, confirm: 'Replace', danger: true });
        if (!ok) {
          initialName = r.fileName;
          continue;
        }
      }
    }
    const state = doc.state;
    const label = `${mode === 'export' || mode === 'download' ? 'Exporting' : 'Saving'} ${r.fileName}`;
    const blob = await encodeWithProgress(doc, r.options, { start, end }, label);
    if (!blob) {
      app.setStatus('Cancelled');
      return false;
    }
    let item = null;
    if (path) {
      item = await upload(label, path, blob);
      rememberRecent(app, { name: r.fileName, path });
    } else downloadBlob(blob, r.fileName);
    if (mode === 'saveAs') {
      doc.source = path ? { type: 'puter', path, uid: item?.uid } : { type: 'download' };
      doc.info = { ...doc.info, format: r.options.format, exportOptions: r.options, size: blob.size };
      if (doc.name !== r.fileName) doc.rename(r.fileName);
      if (doc.state === state) doc.markSaved();
      else doc.emit('change', { kind: 'saved' });
    }
    app.setStatus(path ? `Saved ${r.fileName} to ${dir}` : `Downloaded ${r.fileName}`);
    app.emit('exported', { doc, path, fileName: r.fileName, options: r.options, mode });
    return true;
  }
}
