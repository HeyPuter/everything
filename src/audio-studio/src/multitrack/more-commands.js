// Smaller multitrack and menu commands: Clip > Link Media (point clips whose
// media is missing at a file), Edit > Insert > Into Multitrack Session (pick
// the session), Track Visibility > Settings Apply to Mixer, Favorites >
// Delete Favorite, and the Time Display edit commands.

import { h } from '../lib/dom.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { pickLocalFiles, audioFileFromBlob } from '../storage/files.js';
import { channelsAtRate, insertDocs } from './insert.js';
import { Session } from '../model/session.js';
import { loadFavorites, removeFavorite } from '../effects/favorites.js';
import { sessionToXmeml, timebaseFor } from './interchange.js';
import { encodeWav } from '../audio/wav.js';
import { zipStore } from '../lib/zip.js';
import { downloadBlob } from '../storage/files.js';
import { sanitizeFileName } from '../export/formats.js';
import { sessionBaseName } from '../model/session-io.js';
import { withProgress } from '../export/progress.js';

const session = (app) => (app.active?.kind === 'session' ? app.active : null);
const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);

/** Sources of the selected clips (or every clip when none is selected) whose media is missing. */
export function offlineSources(doc) {
  const ids = doc.selectedClips?.size ? new Set(doc.selectedClips) : null;
  const out = new Map();
  for (const c of doc.state.clips) {
    if (ids && !ids.has(c.id)) continue;
    const src = doc.pool.get(c.sourceId);
    if (src && (src.offline || !src.channels?.length)) out.set(src.id, src);
  }
  return [...out.values()];
}

async function linkMedia(app) {
  const doc = session(app);
  const sources = offlineSources(doc);
  for (const src of sources) {
    const [file] = await pickLocalFiles({ multiple: false });
    if (!file) return;
    try {
      const media = await audioFileFromBlob(file, file.name, { type: 'local' });
      app.addDocument(media, { activate: false });
      const channels = await channelsAtRate(media.state.channels, media.sampleRate, doc.sampleRate);
      doc.updateSource(src.id, { channels, name: media.name, sampleRate: media.sampleRate, docId: media.id, offline: false, stateRef: media.state });
      // The media pool is not in the undo state: the link needs a save to be kept.
      doc.savedState = null;
      doc.emit('change', { kind: 'saved' });
      app.setStatus(`Linked ${src.name} to ${media.name}`);
    } catch (err) {
      app.notify(err?.message || `"${file.name}" could not be opened.`, { error: true });
    }
  }
  app.syncGraph();
}

async function deleteFavoriteDialog(app) {
  const list = loadFavorites(app.prefs);
  if (!list.length) return app.notify('There are no favorites to delete.');
  const sel = h('select.select', { 'aria-label': 'Favorite', size: Math.min(10, list.length), style: { width: '100%' } }, list.map((f, i) => h('option', { value: f.id, selected: i === 0 }, f.name)));
  const r = await openDialog({
    title: 'Delete Favorite',
    body: h('div', { style: { minWidth: '280px' } }, sel),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Delete', value: 'ok', danger: true },
    ],
  });
  if (r !== 'ok') return;
  const fav = list.find((f) => f.id === sel.value);
  if (fav && (await confirmDialog({ title: 'Delete Favorite', message: `Delete the favorite "${fav.name}"?`, confirm: 'Delete', danger: true }))) removeFavorite(app.prefs, fav.id);
}

async function exportInterchange(app) {
  const doc = session(app);
  if (doc.stretcher?.busy) await doc.stretcher.whenIdle();
  if (doc.remixer?.busy) await doc.remixer.whenIdle();
  const base = sessionBaseName(doc.name);
  // One WAV per source the clips use, named after the source and kept unique.
  const files = new Map();
  const taken = new Set();
  for (const c of doc.state.clips) {
    if (files.has(c.sourceId)) continue;
    const src = doc.pool.get(c.sourceId);
    if (!src?.channels?.length) continue;
    const stem = sanitizeFileName(String(src.name || 'Audio').replace(/\.[a-z0-9]{1,5}$/i, '')) || 'Audio';
    let name = `${stem}.wav`;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem} ${i}.wav`;
    taken.add(name.toLowerCase());
    files.set(c.sourceId, name);
  }
  const xml = sessionToXmeml(doc.state, doc.pool, { name: base, files, timebase: timebaseFor(app.prefs.get('timeFormat')) });
  const entries = await withProgress('Exporting Interchange XML', async (onProgress) => {
    const out = [{ name: `${base}.xml`, data: new TextEncoder().encode(xml) }];
    let i = 0;
    for (const [id, name] of files) {
      const src = doc.pool.get(id);
      const blob = encodeWav({ sampleRate: doc.sampleRate, channels: src.channels.map((c) => c.toArray()), bitDepth: 24 });
      out.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      onProgress(++i / files.size);
    }
    return out;
  });
  if (!entries) return;
  downloadBlob(zipStore(entries), `${base} Interchange.zip`);
  app.setStatus(`Exported ${base}.xml with ${files.size} media file${files.size === 1 ? '' : 's'}`);
}

export function installMoreCommands(app) {
  app.commands.register([
    {
      id: 'clip.linkMedia',
      label: 'Link Media...',
      enabled: (a) => Boolean(session(a) && offlineSources(session(a)).length),
      run: () => linkMedia(app),
    },
    {
      id: 'mt.visibilityMixer',
      label: 'Track Visibility Settings Apply to Mixer',
      checked: (a) => a.prefs.get('visibilityInMixer') !== false,
      run: () => app.prefs.set('visibilityInMixer', app.prefs.get('visibilityInMixer') === false),
    },
    { id: 'fav.delete', label: 'Delete Favorite...', run: () => deleteFavoriteDialog(app) },
    { id: 'file.exportInterchange', label: 'Interchange XML...', enabled: (a) => Boolean(session(a)?.state.clips.length), run: () => exportInterchange(app) },
    { id: 'view.editFrameRate', label: 'Edit Custom Frame Rate...', run: () => app.commands.run('edit.preferences', { category: 'time' }) },
    { id: 'view.editTempo', label: 'Edit Tempo...', run: () => (session(app) ? app.commands.run('mt.sessionProperties') : app.commands.run('edit.preferences', { category: 'time' })) },
  ]);

  // Edit > Insert > Into Multitrack Session: each open session, or a new one.
  app.insertSessionMenuItems = () => {
    const file = audio(app);
    const insertInto = async (target) => {
      const range = file.hasSelection ? [file.selection.start, file.selection.end] : null;
      app.activate(target);
      await insertDocs(app, target, [file], { at: target.cursor, range });
    };
    return [
      ...app.documents
        .filter((d) => d.kind === 'session')
        .map((s) => ({ type: 'cmd', label: s.name, enabled: Boolean(file?.length), run: () => insertInto(s) })),
      { type: 'sep' },
      {
        type: 'cmd',
        label: 'New Multitrack Session',
        enabled: Boolean(file?.length),
        run: () => {
          const s = new Session({ name: app.uniqueName('Untitled Session', '.asesx'), sampleRate: file.sampleRate, tracks: 6, autoCrossfade: app.prefs.get('autoCrossfade') !== false });
          app.addDocument(s, { activate: false });
          return insertInto(s);
        },
      },
    ];
  };

  // Edit > Enable Channels gains an "All Channels" item.
  const channelItems = app.channelMenuItems;
  app.channelMenuItems = () => {
    const doc = audio(app);
    const items = channelItems?.() || [];
    if (!doc || doc.channelCount < 2) return items;
    return [{ type: 'cmd', label: 'All Channels', enabled: true, checked: doc.selection.channels.every((c) => c !== false), run: () => doc.setSelection(doc.selection.start, doc.selection.end, { channels: doc.state.channels.map(() => true) }) }, { type: 'sep' }, ...items];
  };

  // Time Display menu: the formats, then shortcuts to edit the custom rate and tempo.
  const timeItems = app.timeFormatMenuItems;
  app.timeFormatMenuItems = () => [...(timeItems?.() || []), { type: 'sep' }, ...['view.editFrameRate', 'view.editTempo'].map((id) => ({ type: 'cmd', label: app.commands.label(id), enabled: true, run: () => app.commands.run(id) }))];
}
