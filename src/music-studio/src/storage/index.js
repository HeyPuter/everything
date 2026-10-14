// Storage feature: wires projects, samples and files into the app.
//
//   File menu commands (open, save, save as, download, import, export).
//   app.importAudio / app.importAudioFromPath / app.recentMenuItems / app.signIn.
//   Session autosave to this device and the startup restore: the first ever
//   launch opens the demo song, later launches restore the last session.
//   Optional cloud autosave for projects saved in Puter (Preferences).
//   Unsaved-changes warning on unload, Puter desktop window title and
//   "open with" launches, and drops of project, MIDI and audio files.
//
// Also installs the app dialogs (src/dialogs).

import * as puter from './puter.js';
import { openDB } from './idb.js';
import { Library } from './library.js';
import { Autosave } from './autosave.js';
import { ProjectFiles, baseName } from './files.js';
import { parseProject, serializeProject } from '../model/serialize.js';
import { demoProject } from '../model/demo.js';
import { FILE_EXT } from '../model/project.js';
import { isAudioName } from '../io/wav.js';
import { installDialogs } from '../dialogs/index.js';
import '../styles/dialogs.css';

/** Preference: autosave projects that live in the Puter cloud (default on). */
export const cloudAutosaveOn = (prefs) => prefs.get('cloudAutosave') !== false;

export function install(app, { db = openDB() } = {}) {
  const { store, prefs } = app;
  const lib = new Library({ db });
  const files = new ProjectFiles(app, lib);
  app.library = lib;
  app.files = files;
  app.importAudio = (blob, opts) => files.importAudio(blob, opts);
  app.importAudioFromPath = (path, opts) => files.importAudioFromPath(path, opts);
  app.recentMenuItems = () => files.recentMenuItems();
  app.openProjectPath = (path) => files.openPath(path);
  app.openLocalProject = (key) => files.openLocalKey(key);
  app.signIn = async () => {
    try {
      await puter.signIn();
    } catch (err) {
      if (err?.error !== 'auth_window_closed') app.notify(err?.msg || err?.message || 'Sign in did not finish.', { error: true });
    }
    puter.resetAccountCache();
    await app.refreshAccount?.();
    return puter.isSignedIn();
  };

  // ---------------------------------------------------------------- commands
  const run = (fn) => () => fn().catch((err) => app.reportError(err));
  app.commands.register(
    { id: 'file.open', label: 'Open...', keys: ['Mod+O'], run: run(() => files.open()) },
    { id: 'file.openLocal', label: 'Open from this device...', run: run(() => files.openDeviceFile()) },
    { id: 'file.save', label: 'Save', keys: ['Mod+S'], enabled: () => !app.saving, run: run(() => files.save()) },
    { id: 'file.saveAs', label: 'Save as...', keys: ['Mod+Shift+S'], enabled: () => !app.saving, run: run(() => files.saveAs()) },
    { id: 'file.saveLocal', label: 'Save to your device', run: run(() => files.download()) },
    { id: 'file.importAudio', label: 'Audio files...', longLabel: 'Import audio files...', run: run(() => files.importAudioCommand()) },
    { id: 'file.importMidi', label: 'MIDI file...', longLabel: 'Import MIDI file...', run: run(() => files.importMidiCommand()) },
    { id: 'file.exportMidi', label: 'MIDI file...', longLabel: 'Export MIDI file...', run: run(() => files.exportMidiCommand()) },
  );

  installDialogs(app);

  // ---------------------------------------------------------------- startup
  // First ever launch: the demo song, so new users hear something right away.
  const firstLaunch = !prefs.get('launched');
  if (firstLaunch) {
    store.load(demoProject());
    prefs.set('launched', true);
  }

  const autosave = new Autosave({
    store,
    writeDraft: () => lib.saveDraft({ json: serializeProject(store.project, store.view), file: app.file, dirty: store.dirty }),
    writeCloud: () => files.save({ auto: true }),
    cloudEnabled: () => Boolean(app.file?.path) && cloudAutosaveOn(prefs) && puter.isSignedIn(),
  });
  app.autosave = autosave;
  app.on('file', () => autosave.scheduleDraft());

  let launched = false;
  const restore = async () => {
    try {
      const draft = await lib.loadDraft();
      // A file opened by the Puter desktop, or edits made meanwhile, win over the draft.
      if (!launched && draft?.json && !store.undoStack.length) {
        const project = parseProject(draft.json);
        files.loadProject(project, draft.file || null, { dirty: Boolean(draft.dirty) }).catch((err) => console.warn(err));
      }
    } catch (err) {
      console.warn('Music Studio: the last session could not be restored.', err);
    }
    autosave.start();
    if (firstLaunch) autosave.scheduleDraft();
  };
  app.restored = new Promise((resolve) => app.once('started', () => restore().then(resolve)));

  // Inside the Puter desktop: open the file the app was launched with.
  launched = puter.onLaunchedWithItems(async (items) => {
    await app.restored;
    for (const item of items || []) {
      const name = item.name || baseName(item.path || '');
      try {
        if (name.toLowerCase().endsWith(FILE_EXT)) await files.openPath(item.path);
        else if (/\.midi?$/i.test(name)) await files.importMidiBlob(await puter.readFile(item.path), name);
        else if (isAudioName(name)) await files.runImport(() => files.importAudioFromPath(item.path), name);
      } catch (err) {
        app.reportError(err);
      }
    }
  });

  // ---------------------------------------------------------------- leaving
  window.addEventListener('beforeunload', (e) => {
    if (!store.dirty) return;
    const unsaved = autosave.pending || autosave.lastError || !autosave.offs.length;
    autosave.flushAll();
    if (unsaved) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flushAll();
  });
  window.addEventListener('pagehide', () => autosave.flushAll());

  // ---------------------------------------------------------------- title, prefs
  let lastTitle = '';
  const syncTitle = () => {
    const t = `${store.dirty ? '* ' : ''}${store.project.name} - Music Studio`;
    if (t === lastTitle) return;
    lastTitle = t;
    puter.setWindowTitle(t);
  };
  if (puter.env() === 'app') {
    store.on('change', syncTitle);
    store.on('saved', syncTitle);
    app.on('file', syncTitle);
    syncTitle();
  }
  const syncHints = () => app.root.classList.toggle('hide-hints', prefs.get('hints') === false);
  prefs.on('change', (k) => {
    if (k === 'hints') syncHints();
  });
  syncHints();
  app.on('account', () => {
    if (!puter.isSignedIn()) puter.resetAccountCache();
  });

  // ---------------------------------------------------------------- drops
  // Files dropped anywhere no panel handles: projects open, MIDI and audio import.
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;
    const list = [...(e.dataTransfer?.files || [])];
    if (!list.length) return;
    e.preventDefault();
    (async () => {
      for (const f of list) {
        try {
          const r = await files.openFile(f);
          if (r && r.sampleId) app.notify(`Imported ${f.name}`);
        } catch (err) {
          app.notify(err?.message || `${f.name} could not be opened.`, { error: true });
        }
      }
    })();
  });
}
