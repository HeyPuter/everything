// Multitrack session backups (Preferences > Auto Save). Every few minutes each
// open session whose state changed since its last backup is written to the
// origin private file system: the session file text (the same .asesx JSON a
// save writes) plus its media as 32-bit float WAV. Media are stored once per
// source revision and shared by every backup that uses them, so a backup of a
// session whose audio did not change costs only its JSON. Each session keeps
// at most `max` backups (oldest dropped first) and media no backup refers to
// are deleted.
//
// Layout in <OPFS>/audio-studio-session-backups:
//   <key>.json          manifest: { version, key, group, tab, name, source, savedAt, dirty, offered, text, media: [{ file, key, frames, channels }] }
//   media/<mkey>.wav    one source revision
//
// A backup's `group` names the open session it came from (tab id + document
// id), `tab` the browser tab that wrote it (each tab holds a Web Lock, as with
// audio-file recovery). On start, the newest backup of every group whose tab
// has ended with unsaved changes is offered for restore; all backups stay
// available in File > Restore Session Backup.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { serializeSession } from '../model/session-io.js';
import { sessionFromText } from '../multitrack/storage.js';
import { LOCK_PREFIX } from './autosave.js';

export const BACKUP_DIR = 'audio-studio-session-backups';
const VERSION = 1;
const BLOCK = 1 << 16;
/** Backups older than this are deleted on start whatever the count. */
const MAX_AGE = 30 * 24 * 3600 * 1000;

const validKey = (k) => typeof k === 'string' && /^[a-z0-9-]+$/i.test(k);

export function validBackup(m) {
  return Boolean(m && m.version === VERSION && validKey(m.key) && validKey(m.group) && typeof m.text === 'string' && Array.isArray(m.media) && m.media.every((x) => validKey(x.key)));
}

/** Backups to delete so each group keeps its newest `max` (and nothing older than maxAge). Pure. */
export function backupsToPrune(manifests, max, now = Date.now(), maxAge = MAX_AGE) {
  const byGroup = new Map();
  for (const m of manifests) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  }
  const out = [];
  for (const list of byGroup.values()) {
    list.sort((a, b) => b.savedAt - a.savedAt);
    list.forEach((m, i) => {
      if (i >= Math.max(1, max) || now - m.savedAt > maxAge) out.push(m);
    });
  }
  return out;
}

/** The newest backup of each group from an ended tab that had unsaved changes and was not offered yet. Pure. */
export function backupsToOffer(manifests, liveTabs) {
  const newest = new Map();
  for (const m of manifests) {
    const cur = newest.get(m.group);
    if (!cur || m.savedAt > cur.savedAt) newest.set(m.group, m);
  }
  return [...newest.values()].filter((m) => m.dirty && !m.offered && !liveTabs.has(m.tab)).sort((a, b) => b.savedAt - a.savedAt);
}

function wavHeader(sampleRate, channels, frames) {
  const dataSize = frames * channels * 4;
  const dv = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, Math.min(0xffffffff, 36 + dataSize), true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 4, true);
  dv.setUint16(32, channels * 4, true);
  dv.setUint16(34, 32, true);
  w(36, 'data');
  dv.setUint32(40, Math.min(0xffffffff, dataSize), true);
  return dv.buffer;
}

export class SessionBackupStore {
  /** @param {() => Promise<FileSystemDirectoryHandle>} getRoot OPFS root */
  constructor(getRoot) {
    this.getRoot = getRoot;
    this.dir = null;
  }

  async #dir() {
    if (!this.dir) this.dir = await (await this.getRoot()).getDirectoryHandle(BACKUP_DIR, { create: true });
    return this.dir;
  }

  async #media() {
    return (await this.#dir()).getDirectoryHandle('media', { create: true });
  }

  async hasMedia(key) {
    try {
      await (await this.#media()).getFileHandle(`${key}.wav`);
      return true;
    } catch {
      return false;
    }
  }

  /** Writes one source revision (Channel objects) as float WAV. */
  async writeMedia(key, sampleRate, channels) {
    const media = await this.#media();
    const file = await media.getFileHandle(`${key}.wav`, { create: true });
    let out;
    try {
      out = await file.createWritable();
    } catch (err) {
      await media.removeEntry(`${key}.wav`).catch(() => {});
      throw err;
    }
    try {
      const nch = channels.length;
      const frames = channels[0]?.length ?? 0;
      await out.write(wavHeader(sampleRate, nch, frames));
      const tmp = Array.from({ length: nch }, () => new Float32Array(BLOCK));
      for (let at = 0; at < frames; at += BLOCK) {
        const n = Math.min(BLOCK, frames - at);
        const inter = new Float32Array(n * nch);
        for (let c = 0; c < nch; c++) {
          channels[c].read(at, tmp[c], 0, n);
          for (let i = 0, p = c; i < n; i++, p += nch) inter[p] = tmp[c][i];
        }
        await out.write(inter);
        await new Promise((r) => setTimeout(r, 0));
      }
      await out.close();
    } catch (err) {
      await out.abort?.().catch(() => {});
      // Creating the handle made an empty file: remove it, or hasMedia() would
      // report this revision as written and every later backup would lack its audio.
      await media.removeEntry(`${key}.wav`).catch(() => {});
      throw err;
    }
  }

  async readMedia(key) {
    return (await (await this.#media()).getFileHandle(`${key}.wav`)).getFile();
  }

  async writeManifest(m) {
    const f = await (await this.#dir()).getFileHandle(`${m.key}.json`, { create: true });
    const w = await f.createWritable();
    await w.write(JSON.stringify(m));
    await w.close();
  }

  async list() {
    const dir = await this.#dir();
    const out = [];
    const names = [];
    for await (const [name, handle] of dir.entries()) names.push([name, handle]);
    for (const [name, handle] of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await (await handle.getFile()).text());
        if (validBackup(m)) out.push(m);
        else await dir.removeEntry(name).catch(() => {});
      } catch {
        await dir.removeEntry(name).catch(() => {});
      }
    }
    return out;
  }

  async remove(key) {
    await (await this.#dir()).removeEntry(`${key}.json`).catch(() => {});
  }

  /** Deletes media no remaining manifest refers to (except `keep`, being written now). */
  async sweepMedia(manifests, keep = new Set()) {
    const used = new Set([...keep, ...manifests.flatMap((m) => m.media.map((x) => x.key))]);
    const media = await this.#media();
    const names = [];
    for await (const [name] of media.entries()) names.push(name);
    for (const name of names) if (name.endsWith('.wav') && !used.has(name.slice(0, -4))) await media.removeEntry(name).catch(() => {});
  }
}

/**
 * Starts session backups. Settings come from prefs: sessionBackup (on/off),
 * sessionBackupInterval (minutes) and sessionBackupMax (per session).
 */
export function installSessionBackup(app, { store, tab, now = () => Date.now() } = {}) {
  if (!store) return null;
  const written = new Map(); // session doc id -> state last backed up
  const mediaKeys = new WeakMap(); // channels array -> media key
  let seq = 0;
  let running = null;
  let timer = null;
  let warned = false;
  const minutes = () => Math.max(1, Math.min(120, Number(app.prefs.get('sessionBackupInterval')) || 3));
  const max = () => Math.max(1, Math.min(100, Math.round(Number(app.prefs.get('sessionBackupMax')) || 10)));
  const enabled = () => app.prefs.get('sessionBackup') !== false;

  const mediaKeyFor = (doc, id, channels) => {
    let k = mediaKeys.get(channels);
    if (!k) mediaKeys.set(channels, (k = `${tab}-${doc.id}-${id}-${(++seq).toString(36)}`.replace(/[^a-z0-9-]/gi, '')));
    return k;
  };

  /** Backs up one session now (whether or not it changed). */
  const backup = async (doc) => {
    const { text, media } = serializeSession(doc);
    const parsed = JSON.parse(text);
    const entries = [];
    const fresh = new Set();
    for (const m of media) {
      if (!m.channels?.length) continue;
      const key = mediaKeyFor(doc, m.id, m.channels);
      fresh.add(key);
      if (!(await store.hasMedia(key))) await store.writeMedia(key, doc.sampleRate, m.channels);
      entries.push({ file: m.file, key, frames: m.channels[0].length, channels: m.channels.length });
    }
    const at = now();
    const manifest = {
      version: VERSION,
      key: `${tab}-${doc.id}-${at.toString(36)}${(++seq).toString(36)}`.replace(/[^a-z0-9-]/gi, ''),
      group: `${tab}-${doc.id}`.replace(/[^a-z0-9-]/gi, ''),
      tab,
      name: parsed.name || doc.name,
      source: doc.source?.type === 'puter' ? { type: 'puter', path: doc.source.path } : { type: doc.source?.type || 'new' },
      savedAt: at,
      dirty: Boolean(doc.dirty),
      offered: false,
      text,
      media: entries,
    };
    await store.writeManifest(manifest);
    const all = await store.list();
    const drop = backupsToPrune(all, max(), at);
    for (const m of drop) await store.remove(m.key);
    const dropped = new Set(drop.map((m) => m.key));
    await store.sweepMedia(all.filter((m) => !dropped.has(m.key)), fresh);
    return manifest;
  };

  const run = async () => {
    if (running) return running;
    running = (async () => {
      for (const doc of app.documents) {
        if (doc.kind !== 'session' || written.get(doc.id) === doc.state) continue;
        // A session that was never edited has nothing worth keeping.
        if (!written.has(doc.id) && !doc.dirty) continue;
        if (doc.stretcher?.busy || doc.remixer?.busy) continue;
        const state = doc.state;
        try {
          await backup(doc);
          written.set(doc.id, state);
        } catch (err) {
          if (!warned) {
            warned = true;
            console.warn('[session backup]', err);
            app.notify("Session backups could not be written to this browser's storage.", { error: true });
          }
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = () => {
    clearInterval(timer);
    timer = enabled() ? setInterval(run, minutes() * 60 * 1000) : null;
  };
  schedule();
  app.prefs.on?.('change', (key) => {
    if (key === 'sessionBackup' || key === 'sessionBackupInterval') schedule();
  });

  const liveTabs = async () => {
    const live = new Set([tab]);
    try {
      const q = await navigator.locks?.query?.();
      for (const l of q?.held || []) if (l.name?.startsWith(LOCK_PREFIX)) live.add(l.name.slice(LOCK_PREFIX.length));
    } catch {
      // Without the Locks API every other tab counts as ended.
    }
    return live;
  };

  return {
    store,
    run,
    backup,
    /** Every backup, newest first. */
    async list() {
      try {
        return (await store.list()).sort((a, b) => b.savedAt - a.savedAt);
      } catch {
        return [];
      }
    },
    /** Backups to offer on start (see backupsToOffer); old ones are pruned first. */
    async check() {
      let all = [];
      try {
        all = await store.list();
        const drop = backupsToPrune(all, max(), now());
        for (const m of drop) await store.remove(m.key);
        if (drop.length) {
          const dropped = new Set(drop.map((m) => m.key));
          all = all.filter((m) => !dropped.has(m.key));
          await store.sweepMedia(all);
        }
      } catch {
        return [];
      }
      return backupsToOffer(all, await liveTabs());
    },
    /** Marks backups as offered so start-up does not ask about them again. */
    async markOffered(manifests) {
      for (const m of manifests) await store.writeManifest({ ...m, offered: true }).catch(() => {});
    },
    /** Opens a backup as a new, unsaved session. */
    async restore(m) {
      const files = new Map(m.media.map((x) => [x.file, x.key]));
      const name = app.uniqueName ? app.uniqueName(m.name) : m.name;
      const session = await sessionFromText(app, m.text, name, { type: 'recovered' }, async (src) => {
        const key = files.get(src.file);
        return key ? store.readMedia(key) : null;
      });
      // Saving a restored session asks where unless it came from Puter; its media are written again.
      if (m.source?.type === 'puter') session.source = { type: 'puter', path: m.source.path };
      session.savedState = null;
      app.addDocument(session);
      return session;
    },
    destroy() {
      clearInterval(timer);
    },
  };
}

const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Start-up prompt for sessions that closed with unsaved changes. */
export async function sessionRestoreDialog(app, controller, manifests) {
  if (!manifests.length) return [];
  const checks = manifests.map((m) => h('input', { type: 'checkbox', checked: true, 'aria-label': `Restore ${m.name}` }));
  const r = await openDialog({
    title: 'Restore Multitrack Sessions',
    body: h(
      'div.io-recover',
      h('p', 'These sessions had unsaved changes when Audio Studio last closed. Their latest backups are in this browser:'),
      h(
        'ul.io-recover-list',
        manifests.map((m, i) => h('li', h('label.check', checks[i], h('span.io-recover-name', m.name), h('span.muted', ` ${m.media.length} media file${m.media.length === 1 ? '' : 's'}, backed up ${when(m.savedAt)}`)))),
      ),
      h('p.muted', 'Older backups stay available in File > Restore Session Backup.'),
    ),
    buttons: [
      { label: 'Not Now', value: null },
      { label: 'Restore', value: 'restore', primary: true },
    ],
  });
  if (r !== 'restore') {
    await controller.markOffered(manifests);
    return [];
  }
  const out = [];
  for (const [i, m] of manifests.entries()) {
    if (!checks[i].checked) continue;
    try {
      out.push(await controller.restore(m));
    } catch (err) {
      console.warn('[session backup] restore failed', err);
      app.notify(`"${m.name}" could not be restored.`, { error: true });
    }
  }
  await controller.markOffered(manifests);
  if (out.length) app.notify(`Restored ${out.length} session${out.length > 1 ? 's' : ''}. Save to keep ${out.length > 1 ? 'them' : 'it'}.`);
  return out;
}

/** File > Restore Session Backup: every backup in this browser, grouped by session. */
export async function backupBrowserDialog(app, controller) {
  const list = await controller.list();
  if (!list.length) {
    app.notify('There are no session backups in this browser.');
    return null;
  }
  const name = `backup-${Math.random().toString(36).slice(2)}`;
  const radios = new Map();
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const exact = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const body = h(
    'ul.io-recover-list.io-backup-list',
    [...groups.values()].map((items) =>
      h(
        'li',
        h('div.io-recover-name', items[0].name),
        items.map((m) => {
          const r = h('input', { type: 'radio', name, value: m.key, checked: m === list[0] });
          radios.set(m.key, r);
          return h('label.check', r, exact(m.savedAt), h('span.muted', m.dirty ? ' unsaved changes' : ' saved'));
        }),
      ),
    ),
  );
  const r = await openDialog({
    title: 'Restore Session Backup',
    body: h('div.io-recover', h('p', 'Choose a backup to open as a new session:'), body),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Open', value: 'open', primary: true },
    ],
  });
  if (r !== 'open') return null;
  const m = list.find((x) => radios.get(x.key)?.checked);
  return m ? controller.restore(m) : null;
}
