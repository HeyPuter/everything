// Wires AutosaveStore to the app: periodic and on-hide autosaves, cleanup on
// save/close, and the recovery prompt at startup.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import {
  AutosaveStore,
  buildManifest,
  planAutosave,
  recoverable,
  newSessionId,
  LOCK_PREFIX,
  unpackChunks,
} from './autosave.js';
import { parseWav } from '../audio/wav.js';
import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';
import { createMarker, sortMarkers } from '../model/markers.js';
import { formatBytesShort } from '../export/formats.js';

const INTERVAL = 60 * 1000;
const MAX_BYTES = 1.5 * 1024 ** 3;

export function opfsAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory) && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
}

export function installAutosave(app, { store = opfsAvailable() ? new AutosaveStore(() => navigator.storage.getDirectory()) : null, interval = INTERVAL } = {}) {
  if (!store) return null;
  const session = newSessionId();
  const written = new Map(); // doc id -> state last written
  const keys = new Map(); // doc id -> storage key
  let running = null;
  let warned = false;

  // Hold a lock for the life of this tab so other tabs know these files are live.
  navigator.locks?.request?.(`${LOCK_PREFIX}${session}`, () => new Promise(() => {})).catch(() => {});

  const keyFor = (doc) => {
    let k = keys.get(doc.id);
    if (!k) keys.set(doc.id, (k = `${session}-${doc.id}`));
    return k;
  };

  const drop = async (docId) => {
    const k = keys.get(docId);
    written.delete(docId);
    if (!k) return;
    keys.delete(docId);
    await store.remove(k).catch(() => {});
  };

  const run = async () => {
    if (running) return running;
    running = (async () => {
      // Clean entries of documents that are saved again or closed.
      const open = new Set(app.documents.map((d) => d.id));
      for (const id of [...keys.keys()]) {
        const doc = app.documents.find((d) => d.id === id);
        if (!open.has(id) || !doc?.dirty) await drop(id);
      }
      let budget = MAX_BYTES;
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota) budget = Math.min(budget, Math.max(0, (est.quota - (est.usage || 0)) * 0.8));
      } catch {
        // Keep the default budget.
      }
      for (const doc of planAutosave(app.documents, written, budget)) {
        if (app.recording && app.recorder?.take && doc === app.active) continue;
        const state = doc.state;
        const key = keyFor(doc);
        try {
          await store.write(doc, buildManifest(doc, { session, key }));
          // Saved or closed while the copy was being written (drop() ran meanwhile):
          // remove it, or the next start would offer a closed document for recovery.
          if (keys.get(doc.id) !== key) await store.remove(key).catch(() => {});
          else written.set(doc.id, state);
        } catch (err) {
          if (keys.get(doc.id) !== key) {
            await store.remove(key).catch(() => {});
          } else if (!warned) {
            warned = true;
            console.warn('[autosave]', err);
            app.notify('Autosave could not write to this browser\'s storage. Save your work to Puter or download it.', { error: true });
          }
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  let timer = setInterval(run, interval);
  let stopped = false;
  const onHide = () => {
    if (!stopped && document.visibilityState === 'hidden') run();
  };
  document.addEventListener('visibilitychange', onHide);
  app.on('doc-change', (doc, e) => {
    if (e.kind === 'saved' && !doc.dirty) drop(doc.id);
  });
  app.on('documents', () => {
    const open = new Set(app.documents.map((d) => d.id));
    for (const id of [...keys.keys()]) if (!open.has(id)) drop(id);
  });

  const controller = {
    session,
    run,
    store,
    get interval() {
      return interval;
    },
    /** Changes how often recovery copies are written (Preferences > Auto Save). */
    setInterval(ms) {
      interval = Math.max(5000, Number(ms) || INTERVAL);
      clearInterval(timer);
      if (!stopped) timer = setInterval(run, interval);
    },
    get stopped() {
      return stopped;
    },
    /** Stops writing recovery copies (autosave turned off); existing copies stay recoverable. */
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Resumes after stop(). */
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(run, interval);
    },
    async check() {
      let list = [];
      try {
        list = await store.list();
      } catch {
        return [];
      }
      let live = new Set([session]);
      try {
        const q = await navigator.locks?.query?.();
        for (const l of q?.held || []) if (l.name?.startsWith(LOCK_PREFIX)) live.add(l.name.slice(LOCK_PREFIX.length));
      } catch {
        // Without the Locks API every other session counts as ended.
      }
      return recoverable(list, live);
    },
    async recover(manifests) {
      const docs = [];
      for (const m of manifests) {
        try {
          const file = await store.readAudio(m.key);
          const r = parseWav(await file.arrayBuffer());
          const doc = new AudioFile({
            name: app.uniqueName(m.name),
            sampleRate: m.sampleRate,
            channels: r.channels.map((c) => Channel.fromSamples(c)),
            markers: sortMarkers((m.markers || []).map((x) => createMarker(x))),
            meta: m.meta || {},
            info: { bitDepth: m.bitDepth, format: m.format, exportOptions: m.exportOptions || undefined },
            source: m.source?.type === 'puter' ? m.source : { type: 'recovered' },
          });
          doc.info.wavChunks = unpackChunks(m.wavChunks); // iXML... kept for the next WAV save
          doc.savedState = null; // unsaved until the user saves it
          app.addDocument(doc, { activate: !docs.length });
          docs.push(doc);
          await store.remove(m.key);
        } catch (err) {
          console.warn('[autosave] recovery failed', err);
          app.notify(`"${m.name}" could not be recovered.`, { error: true });
        }
      }
      if (docs.length) run();
      return docs;
    },
    async discard(manifests) {
      for (const m of manifests) await store.remove(m.key).catch(() => {});
    },
    destroy() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
    },
  };
  return controller;
}

/** The startup prompt: Recover / Not Now / Discard. */
export async function recoveryDialog(app, controller, manifests) {
  if (!manifests.length) return [];
  const checks = manifests.map((m) => h('input', { type: 'checkbox', checked: true, 'aria-label': `Recover ${m.name}` }));
  const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const list = h(
    'ul.io-recover-list',
    manifests.map((m, i) =>
      h(
        'li',
        h(
          'label.check',
          checks[i],
          h('span.io-recover-name', m.name),
          h('span.muted', ` ${app.formatTime(m.frames, m.sampleRate)}, ${formatBytesShort(m.bytes)}, autosaved ${when(m.savedAt)}`),
        ),
      ),
    ),
  );
  const r = await openDialog({
    title: 'Recover Unsaved Audio',
    body: h('div.io-recover', h('p', 'Audio Studio closed with unsaved changes. These files were autosaved in this browser:'), list),
    buttons: [
      { label: 'Discard', value: 'discard', danger: true },
      { label: 'Not Now', value: null },
      { label: 'Recover', value: 'recover', primary: true },
    ],
  });
  const chosen = manifests.filter((_, i) => checks[i].checked);
  if (r === 'recover') {
    const docs = await controller.recover(chosen);
    const rest = manifests.filter((m) => !chosen.includes(m));
    if (rest.length) await controller.discard(rest);
    if (docs.length) app.notify(`Recovered ${docs.length} file${docs.length > 1 ? 's' : ''}. Save to keep ${docs.length > 1 ? 'them' : 'it'}.`);
    return docs;
  }
  if (r === 'discard') await controller.discard(manifests);
  return [];
}
