// File > Export > Multitrack Mixdown: the export dialog with Mixdown Options,
// then one render and encode per file (the master mix and/or each chosen
// track or bus as its own file) behind one cancellable progress dialog, and
// the files written to a Puter folder or downloaded.

import { exportFileDialog } from './dialog.js';
import { withProgress } from './progress.js';
import { encodeDoc } from './save.js';
import { getFormat, sanitizeFileName, stripExtension, emptyExportError, outputFrames } from './formats.js';
import { confirmDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';
import { downloadBlob, rememberRecent } from '../storage/files.js';
import { renderSession, renderedDoc } from '../multitrack/render.js';
import { sessionBaseName } from '../model/session-io.js';

/** Tracks and buses a mixdown can write as separate files. */
export function mixdownTracks(state) {
  const used = new Set(state.clips.map((c) => c.trackId));
  // A bus is empty when nothing is routed or sent to it; an audio track when it has no clips.
  const fed = new Set(state.tracks.flatMap((t) => [t.output, ...(t.sends || []).map((x) => x.target)]).filter(Boolean));
  return state.tracks
    .filter((t) => t.type === 'audio' || t.type === 'bus')
    .map((t) => ({ id: t.id, name: t.name, type: t.type, channels: t.channels, empty: t.type === 'bus' ? !fed.has(t.id) : !used.has(t.id) }));
}

/**
 * The files a mixdown writes: the master as `fileName`, each track as "<stem>_<track>.<ext>".
 * Names are unique (ignoring case), so two tracks called "Vocals" do not overwrite each other.
 */
export function mixdownTargets(fileName, formatId, master, tracks) {
  const ext = getFormat(formatId)?.ext || 'wav';
  const stem = stripExtension(fileName);
  const used = new Set();
  const unique = (base) => {
    let name = `${base}.${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
  const out = [];
  if (master) out.push({ kind: 'master', fileName: unique(stem) });
  for (const t of tracks) out.push({ kind: 'track', trackId: t.id, name: t.name, fileName: unique(`${stem}_${sanitizeFileName(t.name) || 'Track'}`) });
  return out;
}

/**
 * Runs the export for a snapshot of a session: `job` = { state, start, end, clipIds?, markers? },
 * taken when the command ran so later edits do not change what is written.
 */
export async function exportMixdown(app, session, { state, start, end, clipIds = null, markers = [] }) {
  const tracks = mixdownTracks(state);
  const masterChannels = state.master.channels;
  const frames = end - start;
  // What the dialog describes as the source: the master mix.
  const source = {
    name: `${sessionBaseName(session.name)}_mixdown.wav`,
    sampleRate: state.sampleRate,
    channelCount: masterChannels,
    length: frames,
    info: { bitDepth: 32 },
    source: session.source,
    state: { markers },
  };
  let initial = null;
  for (;;) {
    const r = await exportFileDialog(app, source, { mode: 'mixdown', frames, initial, mixdown: { tracks } });
    if (!r) return false;
    const empty = emptyExportError(r.options.format, outputFrames(frames, state.sampleRate, r.options.sampleRate));
    if (empty) {
      app.notify(empty, { error: true });
      initial = r;
      continue;
    }
    const chosen = tracks.filter((t) => r.mixdown.tracks.includes(t.id));
    const targets = mixdownTargets(r.fileName, r.options.format, r.mixdown.master, chosen);
    let dir = null;
    if (r.location.type === 'puter') {
      if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) {
        app.notify('Sign in to Puter to save there, or choose This device.', { error: true });
        initial = r;
        continue;
      }
      dir = r.location.dir || (await puter.appDir());
      const existing = [];
      for (const t of targets) if (await puter.exists(puter.joinPath(dir, t.fileName))) existing.push(t.fileName);
      if (existing.length) {
        const message =
          existing.length === 1
            ? `"${existing[0]}" already exists in ${dir}. Do you want to replace it?`
            : `${existing.length} of these files already exist in ${dir}: ${existing.slice(0, 4).map((n) => `"${n}"`).join(', ')}${existing.length > 4 ? ', ...' : ''}. Do you want to replace them?`;
        const ok = await confirmDialog({ title: existing.length === 1 ? 'Replace File?' : 'Replace Files?', message, confirm: 'Replace', danger: true });
        if (!ok) {
          initial = { ...r, location: { ...r.location, dir } };
          continue;
        }
      }
    }
    const count = targets.length;
    const label = count > 1 ? `Exporting ${count} files` : `Exporting ${r.fileName}`;
    const files = await withProgress(
      label,
      async (onProgress, signal) => {
        const out = [];
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          // Rendering and encoding each take half of a file's share of the bar.
          const part = (half) => (f) => onProgress((i + (half + f) / 2) / count);
          const data = await renderSession(app, session, { state, start, end, clipIds, trackId: t.trackId || null, label: t.kind === 'master' ? 'Mixing down' : `Rendering ${t.name}`, onProgress: part(0), signal });
          // A mono master mixes down to a mono file.
          const channels = t.kind === 'master' && masterChannels === 1 ? data.slice(0, 1) : data;
          const doc = renderedDoc(app, session, channels, t.fileName, markers, state.sampleRate);
          const blob = await encodeDoc(doc, r.options, { onProgress: part(1), signal });
          if (!blob || signal.aborted) return null;
          out.push({ ...t, blob });
        }
        return out;
      },
      { detail: count > 1 ? `${count} files` : r.fileName },
    );
    if (!files) {
      app.setStatus('Cancelled');
      return false;
    }
    if (dir) {
      // An upload cannot be stopped: Cancel only skips the files not started yet.
      let failure = null;
      let done = 0;
      await withProgress(
        label,
        async (onProgress, signal) => {
          for (const f of files) {
            if (signal.aborted) break;
            await puter.writeFile(puter.joinPath(dir, f.fileName), f.blob).catch((err) => {
              failure = err;
              throw err;
            });
            onProgress(++done / files.length);
          }
        },
        { delay: 600, detail: 'Uploading to Puter' },
      );
      if (failure) throw failure;
      if (done) rememberRecent(app, { name: files[0].fileName, path: puter.joinPath(dir, files[0].fileName) });
      app.setStatus(done === 1 ? `Saved ${files[0].fileName} to ${dir}` : `Saved ${done} files to ${dir}`);
    } else {
      for (const f of files) downloadBlob(f.blob, f.fileName);
      app.setStatus(files.length === 1 ? `Downloaded ${files[0].fileName}` : `Downloaded ${files.length} files`);
    }
    return true;
  }
}
