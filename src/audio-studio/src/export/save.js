// Saving and exporting documents: Save (back to the document's Puter file in
// its own format), Save As, Save a Copy, Export File, Save Selection As and
// Download. Encoding always runs in the export worker behind a cancellable
// progress dialog.

import { exportAudio } from './export.js';
import { exportFileDialog } from './dialog.js';
import { withProgress } from './progress.js';
import {
  conformOptions,
  defaultOptions,
  docBitDepth,
  emptyExportError,
  exportMarkers,
  formatForName,
  getFormat,
  outputFrames,
} from './formats.js';
import { confirmDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';
import { downloadBlob, rememberRecent } from '../storage/files.js';
import { VIDEO_EXTENSIONS, extensionOf } from '../audio/decode.js';
import { wavChunksOf } from '../audio/wav.js';
import { normalizePath } from '../lib/paths.js';

const homeRelative = (p) => p === '~' || p.startsWith('~/');
const homeParent = (p) => p === '~/..' || p.startsWith('~/../');
const couldAlias = (a, b) => a !== b && a.split('/').pop() === b.split('/').pop() && (homeRelative(a) !== homeRelative(b) || homeParent(a) || homeParent(b));

function destinationPaths(app, path) {
  const key = normalizePath(path);
  let home;
  const paths = {
    key,
    resolve: (p) => normalizePath(home && homeRelative(p) ? `${home}${p.slice(1)}` : p),
    async ensureHome() {
      if (home) return;
      const found = await puter.homeDir();
      if (!found.startsWith('/')) throw new Error('Could not resolve the Puter home folder. Try saving this file again.');
      home = found;
    },
    prepareMatches(writtenPath) {
      if (!home && (app.documents || []).some((d) => d.kind === 'audio' && d.source?.type === 'puter' && d.source.path && (!writtenPath || !d.source.path.startsWith('/')) && couldAlias(normalizePath(d.source.path), key))) return paths.ensureHome();
    },
    matches: (p, writtenPath) => paths.resolve(p) === paths.resolve(key) || paths.resolve(p) === writtenPath,
    uncertain: (p, writtenPath) => !home && (!writtenPath || !paths.resolve(p).startsWith('/')) && couldAlias(normalizePath(p), key),
  };
  return paths;
}

/** Encodes frames [start, end) of a document with export options. */
export function encodeDoc(doc, options, { start = 0, end = doc.length, onProgress, signal } = {}) {
  const { channels, markers, meta } = doc.state;
  // WAV chunks kept from the opened file (iXML...); the pipeline keeps those still true.
  const chunks = wavChunksOf(doc) || null;
  const source = { channels, sampleRate: doc.sampleRate, start, end, markers, chunks };
  source.meta = meta || {};
  return exportAudio(source, options, { onProgress, signal });
}

/**
 * Options for re-saving a document in `format`: what it was last saved with, else its own
 * sample type. A rate or channel count chosen for that save holds only while the document
 * keeps the sample type it had then (`from`): after Convert Sample Type the file gets the new one.
 */
export function optionsForSave(doc, format) {
  const last = doc.info?.exportOptions;
  if (last && last.format === format) {
    const from = last.from;
    const { sampleRate, channelCount: channels } = doc;
    const converted = from && (from.sampleRate !== sampleRate || from.channels !== channels);
    const opts = converted ? { ...last, sampleRate, channels } : last;
    return conformOptions(format, opts).options;
  }
  const source = { sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc) };
  return defaultOptions(source, format);
}

function encodeWithProgress(doc, options, range, label) {
  return withProgress(label, (onProgress, signal) => encodeDoc(doc, options, { ...range, onProgress, signal }), { detail: label });
}

/** Normalized path -> completion of its reserved encode/upload operations. */
const uploads = new Map();
let nextSaveAs = 0;
const appliedSaveAs = new WeakMap();
const writtenChunks = new WeakMap();
const writtenRanges = new WeakMap();

function stateInRange(state, range) {
  if (!range || (range.start === 0 && range.end === (state.channels[0]?.length || 0))) return state;
  const prior = writtenRanges.get(state);
  if (prior?.start === range.start && prior.end === range.end) return prior.state;
  const snapshot = {
    ...state,
    channels: state.channels.map((channel) => channel.slice(range.start, range.end)),
    markers: exportMarkers(state.markers || [], range.start, range.end, state.sampleRate, state.sampleRate),
  };
  writtenRanges.set(state, { ...range, state: snapshot });
  return snapshot;
}

function stateWithChunks(state, chunks) {
  chunks = chunks || null;
  if (state.wavChunks === chunks) return state;
  const prior = writtenChunks.get(state);
  if (prior?.chunks === chunks) return prior.state;
  const snapshot = { ...state, wavChunks: chunks };
  // Repeated writes of the same state must not dirty a tab that reverted to it.
  writtenChunks.set(state, { chunks, state: snapshot });
  return snapshot;
}

/** Reserve write order before encoding, while allowing encodes to run in parallel. */
async function withUploadOrder(app, path, work) {
  if (!path) return work(null, null);
  const paths = destinationPaths(app, path);
  const previous = [...uploads.values()].filter((p) => p.key === paths.key || couldAlias(p.key, paths.key));
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  // Retain the whole chain for each spelling. A failed middle encode must
  // not hide its older predecessor from a later save through another alias.
  const reservation = { key: paths.key, done: Promise.all([uploads.get(paths.key)?.done, done]) };
  uploads.set(paths.key, reservation);
  reservation.done.then(() => uploads.get(paths.key) === reservation && uploads.delete(paths.key));
  const before = async () => {
    if (previous.some((p) => p.key !== paths.key)) await paths.ensureHome();
    const matching = paths.prepareMatches();
    if (matching) await matching;
    await Promise.all(previous.filter((p) => paths.matches(p.key)).map((p) => p.done));
  };
  try {
    // Resolve identity only when encoded bytes are ready; encodes stay parallel.
    return await work((label, blob) => upload(label, path, blob, before()), paths);
  } finally {
    release();
  }
}

/**
 * Uploads to Puter behind a progress dialog. An upload cannot be stopped, so
 * Cancel only hides the dialog: a failure is still thrown (withProgress would
 * report it as a cancel), and the caller never marks an unsaved file saved.
 */
async function upload(label, path, blob, before) {
  const write = (async () => {
    await before;
    return puter.writeFile(path, blob);
  })();
  let failure = null;
  const item = await withProgress(
    label,
    () =>
      write.catch((err) => {
        failure = err;
        throw err;
      }),
    { delay: 600, detail: 'Uploading to Puter' },
  );
  if (failure) throw failure;
  return item;
}

async function writtenDestination(paths, item) {
  const writtenPath = typeof item?.path === 'string' && item.path.startsWith('/') ? normalizePath(item.path) : null;
  // A newly opened alias may need a lookup after the upload. Its failure must
  // not undo a committed save or leave an uncertain tab falsely clean.
  let unresolved = false;
  try {
    const matching = paths?.prepareMatches(writtenPath);
    if (matching) await matching;
  } catch { unresolved = true; }
  return { paths, writtenPath, unresolved };
}

/** Keep every open view of a written audio file consistent with its disk state. */
function markWritten(app, doc, { path, identity, state, options, size, chunks, range = null, associate = false }) {
  const { paths, writtenPath, unresolved } = identity;
  const targets = new Set();
  let invalidated = false;
  for (const target of new Set([doc, ...(app.documents || [])])) {
    if (target === doc && associate) targets.add(target);
    else if (target.kind === 'audio' && path && target.source?.type === 'puter' && target.source.path) {
      if (paths.matches(target.source.path, writtenPath)) targets.add(target);
      else if (unresolved && paths.uncertain(target.source.path, writtenPath)) {
        target.invalidateSaved(); invalidated = true;
      }
    }
  }
  if (invalidated) app.notify(`Saved ${path.split('/').pop()}, but could not verify which open tabs refer to this file. Affected tabs are marked unsaved. Reopen the file to see its saved version.`, { error: true });
  if (!targets.size) return;
  // Partial exports retain a shared-block snapshot for Revert, while keeping
  // each tab's editable audio and history untouched.
  const saved = stateInRange(state, range);
  const from = { sampleRate: state.sampleRate, channels: state.channels.length };
  for (const target of targets) {
    target.info = { ...target.info, format: options.format, exportOptions: { ...options, from }, size };
    // Keep the open audio's chunks until Revert selects the written snapshot;
    // Undo and crash recovery then follow the metadata of their own audio.
    target.markSaved(target !== doc && target.info.wavChunks !== chunks ? stateWithChunks(saved, chunks) : saved);
  }
}

/**
 * File > Save: in place when the document has a Puter file in a writable format, else Save As.
 * A video file (an .mp4 opened for its sound) is never overwritten with audio alone, nor a
 * raw ADTS .aac stream with an MPEG-4 file (AAC is written only inside .m4a).
 */
export async function saveDocument(app, doc, { saveAs = false, copy = false } = {}) {
  if (!doc) return false;
  const path = doc.source?.type === 'puter' ? doc.source.path : null;
  const ext = path ? extensionOf(path) : '';
  const inPlace = path && ext !== 'aac' && !VIDEO_EXTENSIONS.includes(ext);
  const format = inPlace ? formatForName(path) : null;
  if (!saveAs && !copy && path && format && getFormat(format)) {
    if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) return false;
    return withUploadOrder(app, path, async (write, paths) => {
      const options = optionsForSave(doc, format);
      const state = doc.state;
      const chunks = wavChunksOf(doc);
      const name = doc.name;
      const blob = await encodeWithProgress(doc, options, {}, `Saving ${name}`);
      if (!blob) return false;
      const item = await write(`Saving ${name}`, blob);
      // Save As may have moved this document while the old write was pending.
      const identity = await writtenDestination(paths, item);
      markWritten(app, doc, { path, identity, state, options, size: blob.size, chunks });
      app.setStatus(`Saved ${name}`);
      return true;
    });
  }
  return saveFlow(app, doc, { mode: copy ? 'copy' : 'saveAs' });
}

/**
 * The dialog-driven flows. mode: 'saveAs' | 'copy' | 'export' | 'selection' | 'download'.
 * `range` = [start, end) for 'selection'.
 */
export async function saveFlow(app, doc, { mode = 'export', range = null } = {}) {
  const saveAsId = mode === 'saveAs' ? ++nextSaveAs : 0;
  // A selection's coordinates belong to the audio shown when the command ran.
  // Keep its source stable through the dialog, sign-in and destination checks.
  const sourceDoc = mode === 'selection' ? {
    name: doc.name,
    source: { ...doc.source },
    info: { ...doc.info },
    state: doc.state,
    sampleRate: doc.sampleRate,
    channelCount: doc.channelCount,
    length: doc.length,
  } : doc;
  // Only explicit selections have fixed bounds. For whole files, encodeDoc
  // must use the current length after the dialog and destination checks.
  const bounds = range ? { start: range[0], end: range[1] } : {};
  const frameCount = () => range ? bounds.end - bounds.start : sourceDoc.length;
  // After a declined Replace or a failed sign-in the dialog reopens with the same choices.
  let initial = null;
  for (;;) {
    const r = await exportFileDialog(app, sourceDoc, { mode, frames: frameCount(), initial });
    if (!r) return false;
    // Nothing to encode in a format that cannot be empty: say so and let another format be chosen.
    const outFrames = outputFrames(frameCount(), sourceDoc.sampleRate, r.options.sampleRate);
    const empty = emptyExportError(r.options.format, outFrames);
    if (empty) {
      app.notify(empty, { error: true });
      initial = r;
      continue;
    }
    let path = null;
    let dir = null;
    if (r.location.type === 'puter') {
      if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) {
        app.notify('Sign in to Puter to save there, or choose This device.', { error: true });
        initial = r;
        continue;
      }
      dir = r.location.dir || (await puter.appDir());
      path = puter.joinPath(dir, r.fileName);
      const isCurrent = mode === 'saveAs' && doc.source?.type === 'puter' && doc.source.path === path;
      if (!isCurrent && (await puter.exists(path))) {
        const ok = await confirmDialog({ title: 'Replace File?', message: `"${r.fileName}" already exists in ${dir}. Do you want to replace it?`, confirm: 'Replace', danger: true });
        if (!ok) {
          initial = { ...r, location: { ...r.location, dir } };
          continue;
        }
      }
    }
    return withUploadOrder(app, path, async (write, paths) => {
      const state = sourceDoc.state;
      const chunks = wavChunksOf(sourceDoc);
      const label = `${mode === 'export' || mode === 'download' ? 'Exporting' : 'Saving'} ${r.fileName}`;
      const blob = await encodeWithProgress(sourceDoc, r.options, bounds, label);
      if (!blob) {
        app.setStatus('Cancelled');
        return false;
      }
      let item = null;
      if (path) {
        item = await write(label, blob);
        rememberRecent(app, { name: r.fileName, path });
      } else downloadBlob(blob, r.fileName);
      // Finish any alias lookup before deciding which Save As association wins.
      const identity = await writtenDestination(paths, item);
      // Independent destinations can finish out of order. Keep the newest
      // successful Save As association; failed/cancelled attempts don't win.
      const associate = mode === 'saveAs' && saveAsId > (appliedSaveAs.get(doc) || 0);
      if (associate) {
        appliedSaveAs.set(doc, saveAsId);
        doc.source = path ? { type: 'puter', path, uid: item?.uid } : { type: 'download' };
        if (doc.name !== r.fileName) doc.rename(r.fileName);
      }
      markWritten(app, doc, { path, identity, state, options: r.options, size: blob.size, chunks, range: range ? bounds : null, associate });
      app.setStatus(path ? `Saved ${r.fileName} to ${dir}` : `Downloaded ${r.fileName}`);
      app.emit('exported', { doc, path, fileName: r.fileName, options: r.options, mode });
      return true;
    });
  }
}
