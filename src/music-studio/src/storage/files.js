// File operations behind the File menu: open, save, save as, download,
// import audio and MIDI, recent files, and app.importAudio. The rules:
//
//   Signed out: Save keeps the project in this browser (IndexedDB, listed
//   under Open) and offers a download; nothing touches Puter.
//   Signed in: Save writes ~/MusicStudio/Projects/<name>.msproj (new samples
//   are uploaded once, on the first cloud save that needs them).
//
// Save state is shown through app.file ({ path?, local?, name }),
// app.saving (+ app 'saving' event) and store.markSaved().

import * as puter from './puter.js';
import { MAX_IMPORT_BYTES } from './library.js';
import * as E from '../model/edits.js';
import { createChannel, colorAt, freeInsert, FILE_EXT } from '../model/project.js';
import { decodeAudio } from '../audio/samples.js';
import { defaultParams } from '../instruments/catalog.js';
import { readMidi, isMidi, writeMidi } from '../io/midi.js';
import { importMidi, projectToMidi } from '../io/midi-project.js';
import { downloadBlob, chooseFiles, safeFileName, stripExtension } from '../io/download.js';
import { AUDIO_EXTENSIONS, isAudioName } from '../io/wav.js';
import { uid } from '../lib/util.js';
import { h } from '../lib/dom.js';
import { openDialog, confirmDialog, promptDialog } from '../ui/dialog.js';

const RECENT_MAX = 10;
const PROJECT_ACCEPT = `${FILE_EXT},.mid,.midi,application/json,audio/midi`;
const AUDIO_ACCEPT = `audio/*,${AUDIO_EXTENSIONS.join(',')}`;

const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function baseName(path = '') {
  return path.slice(path.lastIndexOf('/') + 1);
}

export class ProjectFiles {
  constructor(app, lib) {
    this.app = app;
    this.lib = lib;
    this.store = app.store;
  }

  signedIn() {
    return puter.isSignedIn();
  }

  setFile(file) {
    this.app.file = file;
    this.app.emit('file');
  }

  setSaving(on) {
    this.app.saving = on;
    this.app.emit('saving');
  }

  /** Asks before replacing a project with unsaved changes (same wording as New). */
  async confirmDiscard() {
    if (!this.store.dirty) return true;
    return confirmDialog({ title: 'Open project', message: 'Discard the changes to the current project?', confirm: 'Discard', danger: true });
  }

  /** Replaces the open project and loads its samples in the background. */
  loadProject(project, file, { dirty = false, quietSamples = false } = {}) {
    this.app.engine.stop();
    const keep = new Set(Object.keys(project.samples || {}));
    for (const id of this.app.samples.ids()) if (!keep.has(id)) this.app.samples.delete(id);
    this.store.load(project);
    if (dirty) this.store.dirty = true;
    this.setFile(file);
    if (file && (file.path || file.local)) this.addRecent(file);
    this.app.emit('saving');
    return this.loadSamples(project, { quiet: quietSamples });
  }

  async loadSamples(project, { quiet = false } = {}) {
    if (!Object.keys(project.samples || {}).length) return { loaded: 0, missing: [] };
    const r = await this.lib.loadSamples(project, this.app.samples);
    if (r.missing.length && !quiet) {
      const list = r.missing.slice(0, 3).join(', ') + (r.missing.length > 3 ? ` and ${r.missing.length - 3} more` : '');
      const signIn = !this.signedIn() && Object.values(project.samples).some((s) => s.path);
      this.app.notify(`${r.missing.length === 1 ? 'A sample was' : `${r.missing.length} samples were`} not found (${list}). Their channels are kept.${signIn ? ' Sign in to load samples from your Puter cloud.' : ''}`, { error: true, timeout: 9000 });
    }
    return r;
  }

  // ---------------------------------------------------------------- open

  async open() {
    if (this.signedIn()) return this.openFromPuter();
    return this.app.openLocalProjects?.();
  }

  async openFromPuter() {
    let dir;
    try {
      dir = await this.lib.cloudProjectsDir();
    } catch {
      dir = undefined;
    }
    const items = await puter.pickFiles({ multiple: false, accept: FILE_EXT, path: dir });
    const item = items[0];
    if (!item) return;
    if (/\.midi?$/i.test(item.name || '')) return this.importMidiBlob(await item.read(), item.name);
    return this.openPath(item.path);
  }

  async openPath(path) {
    puter.requireSignedIn();
    if (!(await this.confirmDiscard())) return false;
    let project;
    try {
      project = await this.lib.loadCloud(path);
    } catch (err) {
      throw new Error(puter.errorMessage(err, 'The project could not be opened.'));
    }
    const name = stripExtension(baseName(path));
    this.loadProject(project, { path, name });
    this.app.notify(`Opened ${project.name}`);
    return true;
  }

  async openLocalKey(key) {
    if (!(await this.confirmDiscard())) return false;
    const meta = (await this.lib.listLocal()).find((m) => m.key === key);
    const project = await this.lib.loadLocal(key);
    this.loadProject(project, { local: key, name: meta?.name || project.name });
    this.app.notify(`Opened ${project.name}`);
    return true;
  }

  /** File > Open from this device: a .msproj (or a .mid, imported into the current project). */
  async openDeviceFile() {
    const [file] = await chooseFiles({ accept: PROJECT_ACCEPT });
    if (file) return this.openFile(file);
    return false;
  }

  /** Opens or imports a File the user chose or dropped. */
  async openFile(file) {
    const name = file.name || '';
    if (/\.midi?$/i.test(name)) return this.importMidiBlob(file, name);
    if (isAudioName(name) || file.type?.startsWith('audio/')) return this.app.importAudio(file, { name });
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (isMidi(head)) return this.importMidiBlob(file, name);
    const project = await this.lib.readProjectText(await file.text());
    if (!(await this.confirmDiscard())) return false;
    this.loadProject(project, null, { dirty: true });
    this.app.notify(`Opened ${project.name}. Save to keep it in Music Studio.`);
    return true;
  }

  // ---------------------------------------------------------------- save

  /** File > Save. `auto` is the cloud autosave: never prompts, cloud files only. */
  async save({ auto = false } = {}) {
    if (this.app.saving) return false;
    const file = this.app.file;
    if (this.signedIn()) {
      if (file?.path) return this.saveCloudTo(file.path, { auto });
      if (auto) return false;
      return this.saveAs();
    }
    if (auto) return false;
    // A first save of a project nobody has named yet asks for a name.
    if (!file?.local && this.store.project.name === 'Untitled') return this.saveAs();
    return this.saveLocalProject(file?.local || uid(), file?.name || this.store.project.name);
  }

  /** File > Save as: asks for a name and saves a new copy. */
  async saveAs() {
    const cloud = this.signedIn();
    const name = await promptDialog({
      title: 'Save project as',
      label: cloud ? 'Name (saved to MusicStudio/Projects in your Puter cloud)' : 'Name (saved in this browser)',
      value: this.app.file?.name || this.store.project.name,
      confirm: 'Save',
      validate: (v) => (v.trim() ? '' : 'Enter a name.'),
    });
    if (name === null) return false;
    const clean = name.trim().slice(0, 120);
    if (cloud) {
      const path = await this.lib.cloudPathFor(clean);
      if (path !== this.app.file?.path && (await puter.exists(path))) {
        const ok = await confirmDialog({ title: 'Replace project?', message: `A project named "${baseName(path)}" already exists in your Puter cloud. Replace it?`, confirm: 'Replace', danger: true });
        if (!ok) return false;
      }
      this.renameProject(clean);
      return this.saveCloudTo(path);
    }
    this.renameProject(clean);
    return this.saveLocalProject(uid(), clean);
  }

  renameProject(name) {
    if (this.store.project.name !== name) this.store.apply('Rename project', (p) => E.setProjectProps(p, { name }));
  }

  async saveCloudTo(path, { auto = false } = {}) {
    this.setSaving(true);
    const snapshot = this.store.project;
    try {
      const r = await this.lib.saveCloud(snapshot, this.store.view, { path });
      // Edits made while saving stay unsaved.
      if (this.store.project === snapshot) this.store.markSaved();
      const name = stripExtension(baseName(r.path));
      this.setFile({ path: r.path, name });
      this.addRecent({ path: r.path, name });
      if (r.missing.length) this.app.notify(`Saved, but ${r.missing.length === 1 ? 'one sample is' : `${r.missing.length} samples are`} not on this device and could not be uploaded.`, { error: true });
      else if (!auto) this.app.notify(`Saved to your Puter cloud`);
      return true;
    } catch (err) {
      if (auto) {
        console.warn('Music Studio: cloud autosave failed.', err);
        if (puter.isQuotaError(err)) this.app.notify(puter.errorMessage(err), { error: true });
        return false;
      }
      this.app.notify(puter.errorMessage(err, 'The project could not be saved.'), { error: true, action: { label: 'Save to device', run: () => this.download() } });
      return false;
    } finally {
      this.setSaving(false);
    }
  }

  async saveLocalProject(key, name) {
    this.setSaving(true);
    const snapshot = this.store.project;
    try {
      await this.lib.saveLocal(snapshot, this.store.view, { key, name });
      if (this.store.project === snapshot) this.store.markSaved();
      this.setFile({ local: key, name });
      this.addRecent({ local: key, name });
    } catch (err) {
      this.app.notify(err?.message || 'The project could not be saved in this browser.', { error: true, action: { label: 'Save to device', run: () => this.download() } });
      return false;
    } finally {
      this.setSaving(false);
    }
    this.localSaveNotice();
    return true;
  }

  /** After a signed-out save: explain where it went, once; later saves just confirm. */
  async localSaveNotice() {
    const prefs = this.app.prefs;
    const seen = prefs.get('dismissedNotices') || [];
    const persistent = (await this.lib.db()).persistent;
    if (seen.includes('localSave')) {
      this.app.notify(persistent ? 'Saved in this browser' : 'Saved for this session only', { action: { label: 'Download', run: () => this.download() } });
      return;
    }
    prefs.set('dismissedNotices', [...seen, 'localSave']);
    const canSignIn = Boolean(puter.sdk()) && puter.env() !== 'app';
    const r = await openDialog({
      title: 'Saved in this browser',
      className: 'save-notice',
      body: h(
        'div.save-notice-body',
        h('p', persistent ? 'Your project is saved in this browser on this device. Find it again with File > Open.' : 'This browser blocks site storage, so the project is kept only until you close the tab. Download a copy to keep it.'),
        h('p', 'To keep a copy elsewhere, save the project file to your device. ', canSignIn ? 'Or sign in to Puter to save projects to your cloud and open them anywhere.' : ''),
      ),
      buttons: [
        ...(canSignIn ? [{ label: 'Sign in to Puter', value: 'signin' }] : []),
        { label: 'Save to your device', value: 'download' },
        { label: 'OK', value: 'ok', primary: true },
      ],
    });
    if (r === 'download') await this.download();
    else if (r === 'signin') await this.app.signIn?.();
  }

  /** File > Save to your device: downloads a self-contained .msproj. */
  async download() {
    const { blob, missing, skipped } = await this.lib.exportFile(this.store.project, this.store.view);
    downloadBlob(blob, `${safeFileName(this.app.file?.name || this.store.project.name)}${FILE_EXT}`);
    if (skipped) this.app.notify('Downloaded. Some samples were too large to include in the file.', { error: true });
    else if (missing.length) this.app.notify(`Downloaded without ${missing.length === 1 ? 'one missing sample' : `${missing.length} missing samples`}.`, { error: true });
    else this.app.notify('Project file downloaded');
  }

  // ---------------------------------------------------------------- recent

  addRecent(file) {
    const entry = file.path ? { path: file.path, name: file.name } : { local: file.local, name: file.name };
    const list = (this.app.prefs.get('recent') || []).filter((r) => (entry.path ? r.path !== entry.path : r.local !== entry.local));
    this.app.prefs.set('recent', [{ ...entry, at: Date.now() }, ...list].slice(0, RECENT_MAX));
  }

  recentMenuItems() {
    const list = this.app.prefs.get('recent') || [];
    const signedIn = this.signedIn();
    const items = list.map((r) => ({
      type: 'cmd',
      label: r.name || baseName(r.path || '') || 'Project',
      icon: r.path ? 'cloud' : 'hard-drive',
      keys: r.path && !signedIn ? 'Sign in' : '',
      enabled: !r.path || signedIn,
      run: () => this.openRecent(r),
    }));
    if (items.length) items.push({ type: 'sep' }, { type: 'cmd', label: 'Clear recent projects', run: () => this.app.prefs.set('recent', []) });
    return items;
  }

  async openRecent(r) {
    try {
      if (r.path) await this.openPath(r.path);
      else await this.openLocalKey(r.local);
    } catch (err) {
      this.app.prefs.set('recent', (this.app.prefs.get('recent') || []).filter((x) => x !== r && !(x.path && x.path === r.path) && !(x.local && x.local === r.local)));
      throw err;
    }
  }

  // ---------------------------------------------------------------- import audio

  /**
   * app.importAudio: decodes, stores the bytes, adds the sample and a channel
   * in one undo step. With `channel` (an existing channel id) the sample goes
   * to that channel instead (a sampler or audio channel keeps its type).
   */
  async importAudio(blob, { name, path = null, as = 'sampler', channel = null } = {}) {
    const fileName = name || blob.name || 'Audio';
    if (blob.size > MAX_IMPORT_BYTES) throw new Error(`"${fileName}" is ${mb(blob.size)}. Music Studio imports audio files up to ${mb(MAX_IMPORT_BYTES)}.`);
    const data = await blob.arrayBuffer();
    let decoded;
    try {
      decoded = await decodeAudio(data);
    } catch {
      throw new Error(`"${fileName}" could not be read as audio. Try WAV, MP3, OGG or FLAC.`);
    }
    const id = uid();
    let local = null;
    try {
      await this.lib.putSample(id, { data, name: fileName, type: blob.type || '', path });
      local = id;
    } catch (err) {
      console.warn('Music Studio: could not keep the sample on this device.', err);
    }
    this.app.samples.set(id, decoded);
    const duration = decoded.channels[0].length / decoded.rate;
    const label = stripExtension(fileName).slice(0, 60) || 'Sample';
    const ref = { id, name: fileName.slice(0, 200), path, local, duration, rate: decoded.rate, channels: decoded.channels.length };
    const p = this.store.project;
    const target = channel ? p.channels.find((c) => c.id === channel) : null;
    if (channel && !target) throw new Error('That channel no longer exists.');
    if (target) {
      const type = target.type === 'sampler' || target.type === 'audio' ? target.type : 'sampler';
      this.store.apply(`Load ${label}`, (proj) => {
        let next = E.addSample(proj, ref).project;
        next = E.updateChannel(next, target.id, type === target.type ? { sample: id } : { sample: id, type, params: { ...defaultParams(type) } });
        return next;
      });
      return { sampleId: id, channelId: target.id, duration };
    }
    const insert = freeInsert(p);
    const ch = createChannel({ type: as === 'audio' ? 'audio' : 'sampler', name: label, sample: id, color: colorAt(p.channels.length), mixer: insert });
    this.store.apply(`Import ${label}`, (proj) => {
      let next = E.addSample(proj, ref).project;
      next = E.addChannel(next, ch);
      if (insert > 0) next = E.updateMixerTrack(next, insert, { name: ch.name, color: ch.color });
      return next;
    });
    this.store.selectChannels([ch.id]);
    return { sampleId: id, channelId: ch.id, duration };
  }

  /** Imports an audio file already in Puter (the browser's My files). */
  async importAudioFromPath(path, opts = {}) {
    puter.requireSignedIn();
    const blob = await puter.readFile(path);
    return this.importAudio(blob, { name: baseName(path), path, ...opts });
  }

  /** File > Import audio: from this device, or from Puter when signed in. */
  async importAudioCommand() {
    let source = 'device';
    if (this.signedIn()) {
      source = await openDialog({
        title: 'Import audio',
        body: h('p', 'Add audio files as sampler channels. Choose where the files are.'),
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'From Puter', value: 'puter' },
          { label: 'From this device', value: 'device', primary: true },
        ],
      });
      if (!source) return;
    }
    if (source === 'puter') {
      const items = await puter.pickFiles({ multiple: true, accept: AUDIO_EXTENSIONS });
      for (const item of items) await this.runImport(() => this.importAudioFromPath(item.path), item.name);
      return;
    }
    const files = await chooseFiles({ accept: AUDIO_ACCEPT, multiple: true });
    for (const f of files) await this.runImport(() => this.importAudio(f, { name: f.name }), f.name);
  }

  async runImport(fn, name) {
    try {
      const r = await fn();
      this.app.notify(`Imported ${name}`);
      return r;
    } catch (err) {
      this.app.notify(err?.message || `${name} could not be imported.`, { error: true });
      return null;
    }
  }

  // ---------------------------------------------------------------- MIDI

  async importMidiCommand() {
    const [file] = await chooseFiles({ accept: '.mid,.midi,audio/midi' });
    if (file) await this.importMidiBlob(file, file.name);
  }

  /** Adds a MIDI file's parts to the project in one undo step. */
  async importMidiBlob(blob, name = 'MIDI') {
    const midi = readMidi(await blob.arrayBuffer());
    // Take the file's tempo only when the song is still empty.
    const useTempo = !this.store.project.clips.length;
    const label = stripExtension(name) || 'MIDI';
    const r = this.store.apply(`Import ${label}`, (p) => importMidi(p, midi, { name: label, useTempo }));
    if (r?.patternIds?.length) this.store.setPattern(r.patternIds[0]);
    const parts = r?.patternIds?.length || 0;
    this.app.notify(`Imported ${label}: ${parts} part${parts === 1 ? '' : 's'} on the playlist${useTempo ? ` at ${r.bpm} BPM` : ''}`);
    return r;
  }

  /** File > Export MIDI: the song or the current pattern as a Standard MIDI File. */
  async exportMidiCommand() {
    const hasSong = this.store.project.clips.some((c) => c.kind === 'pattern');
    const mode = await openDialog({
      title: 'Export MIDI',
      body: h('p', 'Writes a Standard MIDI File with one track per channel, for other music apps. Sounds and effects are not included.'),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Current pattern', value: 'pattern', primary: !hasSong },
        ...(hasSong ? [{ label: 'Song', value: 'song', primary: true }] : []),
      ],
    });
    if (!mode) return;
    const p = this.store.project;
    const data = projectToMidi(p, { mode, patternId: this.store.view.pattern });
    if (!data.tracks.length) {
      this.app.notify(mode === 'song' ? 'The song has no notes to export.' : 'The pattern has no notes to export.', { error: true });
      return;
    }
    const bytes = writeMidi(data);
    const suffix = mode === 'pattern' ? ` - ${this.store.pattern.name}` : '';
    downloadBlob(new Blob([bytes], { type: 'audio/midi' }), `${safeFileName(p.name + suffix)}.mid`);
    this.app.notify('MIDI file downloaded');
  }
}
