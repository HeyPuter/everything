// Files, export and recording: Save As / Export File dialog and encoders,
// recording into the Waveform editor (app.recorder), input metering and
// device choice, the Media Browser and Metadata panels, marker import,
// Open Recent, autosave with crash recovery and the Puter window-close prompt.

import '../styles/files.css';
import { CornerLeftUp } from 'lucide';
import { h } from '../lib/dom.js';
import { registerIcons } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { AudioFile } from '../model/audio-file.js';
import { createMarker, sortMarkers } from '../model/markers.js';
import { openFiles, pickLocalFiles } from '../storage/files.js';
import * as puter from '../storage/puter.js';
import { saveFlow } from '../export/save.js';
import { createRecorder, inputErrorMessage } from '../record/recorder.js';
import { recordingName } from '../record/take.js';
import { mediaBrowserPanel, PUTER_DRAG_TYPE, resolveMediaItems } from '../panels/media-browser.js';
import { metadataPanel } from '../panels/metadata.js';
import { parseMarkerText } from '../storage/markers-io.js';
import { installAutosave, recoveryDialog, opfsAvailable } from '../storage/autosave-controller.js';
import { newSessionId, LOCK_PREFIX } from '../storage/autosave.js';
import { installSessionBackup, SessionBackupStore, sessionRestoreDialog, backupBrowserDialog } from '../storage/session-backup.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);
const hasAudio = (app) => Boolean(audio(app));

export function installIo(app) {
  registerIcons({ 'corner-left-up': CornerLeftUp });
  app.registerPanel({ id: 'media', title: 'Media Browser', create: mediaBrowserPanel, near: ['files', 'favorites', 'markers'] });
  app.registerPanel({ id: 'metadata', title: 'Metadata', create: metadataPanel, near: ['properties', 'assistant'] });
  app.recorder = createRecorder(app);
  app.recording = false;
  app.inputMetering = false;
  const C = app.commands;

  C.register([
    { id: 'file.exportFile', label: 'File...', shortcut: 'Mod+Shift+E', enabled: hasAudio, run: () => saveFlow(app, audio(app), { mode: 'export' }) },
    {
      id: 'file.saveSelectionAs',
      label: 'Save Selection As...',
      shortcut: 'Mod+Alt+S',
      enabled: (a) => Boolean(audio(a)?.hasSelection),
      run: () => {
        const doc = audio(app);
        return saveFlow(app, doc, { mode: 'selection', range: [doc.selection.start, doc.selection.end] });
      },
    },
    { id: 'file.download', label: 'Download to This Device...', enabled: hasAudio, run: () => saveFlow(app, audio(app), { mode: 'download' }) },
    { id: 'file.importMarkers', label: 'Markers...', enabled: hasAudio, run: () => importMarkers(app) },
    {
      id: 'file.recover',
      label: 'Recover Unsaved Files...',
      enabled: () => Boolean(autosave),
      run: async () => {
        const list = await autosave.check();
        if (!list.length) return app.notify('There are no autosaved files to recover.');
        return recoveryDialog(app, autosave, list);
      },
    },
    {
      id: 'file.restoreBackup',
      label: 'Restore Session Backup...',
      enabled: () => Boolean(app.sessionBackup),
      run: () => backupBrowserDialog(app, app.sessionBackup),
    },
    {
      id: 'transport.record',
      label: (a) => (a.recording ? 'Stop Recording' : 'Record'),
      shortcut: 'Shift+Space',
      // Base command for every kind: the multitrack session overrides run()
      // through its document kind to record into armed tracks.
      enabled: () => true,
      run: () => toggleRecord(app),
    },
    {
      id: 'transport.punchRoll',
      label: 'Punch and Roll',
      // Waveform editor: rolls in from before the playhead (or selection) and records over what follows.
      enabled: (a) => Boolean(audio(a)) && !a.recording,
      run: () => punchAndRoll(app),
    },
    {
      id: 'transport.meterInput',
      label: 'Meter Input Signal',
      checked: (a) => Boolean(a.inputMetering),
      run: () => toggleInputMeter(app),
    },
  ]);

  app.preferenceSections = app.preferenceSections || [];
  app.preferenceSections.push({ category: 'audioHardware', title: 'Devices', keywords: 'input microphone device latency output', build: audioHardwarePrefs });

  // Open Recent: Puter files, reopened through their path.
  app.recentMenuItems = () => {
    const list = app.prefs.get('recent') || [];
    if (!list.length) return [{ type: 'cmd', label: 'No Recent Files', enabled: false }];
    return [
      ...list.map((r) => ({
        type: 'cmd',
        label: r.name,
        enabled: Boolean(r.path),
        run: async () => {
          if (puter.sdk() && !puter.isSignedIn() && !(await puter.signIn().catch(() => false))) return;
          const open = app.documents.find((d) => d.source?.path === r.path);
          if (open) return app.activate(open);
          const docs = await openFiles(app, [{ name: r.name, path: r.path }]);
          if (!docs.length) app.prefs.set('recent', (app.prefs.get('recent') || []).filter((x) => x.path !== r.path));
        },
      })),
      { type: 'sep' },
      { type: 'cmd', label: 'Clear Recent Files', enabled: true, run: () => app.prefs.set('recent', []) },
    ];
  };

  // Drags from the Media Browser: open, or insert into a session when dropped on it.
  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes(PUTER_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || ![...(e.dataTransfer?.types || [])].includes(PUTER_DRAG_TYPE)) return;
    e.preventDefault();
    let items = [];
    try {
      items = JSON.parse(e.dataTransfer.getData(PUTER_DRAG_TYPE));
    } catch {
      return;
    }
    const onEditor = e.target instanceof Element && e.target.closest('[data-panel="editor"]');
    // Device folder items arrive as references; read them as Files.
    items = await resolveMediaItems(items);
    if (!items.length) return;
    if (onEditor && app.active?.kind === 'session' && app.commands.isEnabled('mt.insertFiles', { docs: [true] })) {
      const docs = await openFiles(app, items, { activate: false });
      if (docs.length) app.commands.run('mt.insertFiles', { docs, items, clientX: e.clientX, clientY: e.clientY });
    } else openFiles(app, items);
  });

  installWindowClose(app);

  // Autosave and the recovery prompt (after the shell has mounted).
  let autosave = null;
  const intervalMs = () => Math.max(5, Number(app.prefs.get('autosaveInterval')) || 60) * 1000;
  const startAutosave = () => {
    try {
      autosave = installAutosave(app, { interval: intervalMs() });
    } catch (err) {
      console.warn('[autosave]', err);
    }
    app.autosave = autosave;
  };
  if (app.prefs.get('autosave') !== false) startAutosave();
  app.autosave = autosave;
  // Multitrack session backups share the tab id (and its Web Lock) with autosave.
  let tab = autosave?.session;
  if (!tab) {
    tab = newSessionId();
    navigator.locks?.request?.(`${LOCK_PREFIX}${tab}`, () => new Promise(() => {})).catch(() => {});
  }
  try {
    app.sessionBackup = opfsAvailable() ? installSessionBackup(app, { store: new SessionBackupStore(() => navigator.storage.getDirectory()), tab }) : null;
  } catch (err) {
    console.warn('[session backup]', err);
    app.sessionBackup = null;
  }
  if (app.sessionBackup) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && app.prefs.get('sessionBackup') !== false) app.sessionBackup.run();
    });
  }
  if (autosave || app.sessionBackup) {
    setTimeout(async () => {
      const list = autosave ? await autosave.check() : [];
      if (list.length) await recoveryDialog(app, autosave, list);
      const sessions = app.sessionBackup ? await app.sessionBackup.check() : [];
      if (sessions.length) await sessionRestoreDialog(app, app.sessionBackup, sessions);
    }, 600);
  }
  // Preferences > Auto Save apply right away.
  app.prefs.on('change', (key) => {
    if (key === 'autosave') {
      const on = app.prefs.get('autosave') !== false;
      if (on && !autosave) startAutosave();
      else if (on) autosave.start?.();
      else autosave?.stop?.();
    } else if (key === 'autosaveInterval') autosave?.setInterval?.(intervalMs());
  });
}

// ------------------------------------------------------------------ record

async function newRecordingDialog(app) {
  const name = h('input.input', { type: 'text', value: app.uniqueName(recordingName()), 'aria-label': 'File name', style: { width: '100%' } });
  const rate = h('select.select', { 'aria-label': 'Sample rate' }, [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000].map((r) => h('option', { value: r, selected: r === app.prefs.get('defaultRate') }, `${r} Hz`)));
  const channels = h('select.select', { 'aria-label': 'Channels' }, h('option', { value: '1', selected: app.prefs.get('defaultChannels') === 1 }, 'Mono'), h('option', { value: '2', selected: app.prefs.get('defaultChannels') !== 1 }, 'Stereo'));
  const bits = h('select.select', { 'aria-label': 'Bit depth' }, [16, 24, 32].map((b) => h('option', { value: b, selected: b === 32 }, b === 32 ? '32 (float)' : String(b))));
  const r = await openDialog({
    title: 'New Audio File',
    body: h(
      'div',
      h('p.muted', { style: { margin: '0 0 10px', maxWidth: '360px' } }, 'Recording starts in a new file with these settings.'),
      h('div.form-grid', h('label', 'File Name:'), name, h('label', 'Sample Rate:'), rate, h('label', 'Channels:'), channels, h('label', 'Bit Depth:'), bits),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Record', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  app.prefs.set('defaultRate', Number(rate.value));
  app.prefs.set('defaultChannels', Number(channels.value));
  return { name: name.value.trim() || recordingName(), sampleRate: Number(rate.value), channels: Number(channels.value), bitDepth: Number(bits.value) };
}

async function toggleRecord(app) {
  if (app.recorder.active) return app.recorder.stop();
  if (app.active && app.active.kind !== 'audio') return;
  let doc = audio(app);
  if (!doc) {
    const o = await newRecordingDialog(app);
    if (!o) return;
    doc = AudioFile.blank({ name: o.name, sampleRate: o.sampleRate, channels: o.channels });
    doc.info.bitDepth = o.bitDepth;
    app.addDocument(doc);
  }
  const replace = doc.hasSelection ? [doc.selection.start, doc.selection.end] : null;
  if (prerolling) return prerolling.cancel();
  const secs = Number(app.prefs.get('prerollSeconds')) || 0;
  if (replace && secs > 0 && replace[0] > 0) {
    if (!(await preroll(app, doc, replace[0], secs))) return;
  }
  return app.recorder.start({ doc, replace, at: doc.cursor });
}

/**
 * Punch and Roll: plays the pre-roll (Preferences > Playback and Recording,
 * at least two seconds) before the punch-in point, then records from there:
 * over the selection, or over everything after the playhead.
 */
async function punchAndRoll(app) {
  const doc = audio(app);
  if (!doc || app.recorder.active) return;
  if (prerolling) return prerolling.cancel();
  const at = doc.hasSelection ? doc.selection.start : Math.round(app.playhead);
  if (app.engine.playing) app.stop();
  doc.setCursor(at);
  const replace = doc.hasSelection ? [doc.selection.start, doc.selection.end] : [at, Infinity];
  const secs = Math.max(2, Number(app.prefs.get('prerollSeconds')) || 0);
  if (at > 0 && !(await preroll(app, doc, at, secs))) return;
  return app.recorder.start({ doc, replace, at });
}

// ----------------------------------------------------------------- pre-roll

let prerolling = null;

/**
 * Punch-in pre-roll (Preferences > Playback and Recording): plays `secs` of
 * the audio before the punch-in point, optionally with a countdown, then
 * resolves true. Stopping playback or pressing Record again cancels (false).
 */
function preroll(app, doc, at, secs) {
  const engine = app.engine;
  const from = Math.max(0, Math.round(at - secs * doc.sampleRate));
  const total = (at - from) / doc.sampleRate;
  return new Promise((resolve) => {
    let done = false;
    let raf = 0;
    const counter = app.prefs.get('prerollCountdown') ? h('div.preroll-countdown', { role: 'status', 'aria-live': 'polite' }) : null;
    if (counter) document.body.append(counter);
    const finish = (ok) => {
      if (done) return;
      done = true;
      prerolling = null;
      offEnded();
      offTransport();
      cancelAnimationFrame(raf);
      counter?.remove();
      app.setStatus(ok ? '' : 'Pre-roll cancelled');
      resolve(ok);
    };
    const offEnded = engine.on('ended', () => finish(true));
    // A stop before the punch-in point (Space, Stop) cancels; the natural end arrives as 'ended'.
    const offTransport = app.on('transport', (s) => {
      if (s === 'stopped') setTimeout(() => finish(engine.lastPos?.frame >= at - doc.sampleRate * 0.05), 0);
    });
    prerolling = {
      cancel: () => {
        finish(false);
        if (engine.playing) app.stop();
      },
    };
    const started = performance.now();
    let shown = '';
    const tick = () => {
      if (done) return;
      const left = Math.max(0, total - (performance.now() - started) / 1000);
      const text = `Recording in ${Math.ceil(left)}`;
      if (counter && text !== shown) counter.textContent = shown = text;
      raf = requestAnimationFrame(tick);
    };
    app.setStatus('Pre-roll...');
    app
      .play({ from, to: at, loop: false })
      .then(() => {
        if (!engine.playing && !done) finish(false);
        else tick();
      });
  });
}

async function toggleInputMeter(app) {
  const engine = app.engine;
  if (app.inputMetering) {
    app.inputMetering = false;
    if (!app.recording) {
      engine.closeInput();
      app.meterInput?.(false);
    }
  } else {
    if (!app.recording) {
      try {
        await engine.openInput({ deviceId: app.prefs.get('inputDevice') || undefined });
      } catch (err) {
        app.notify(inputErrorMessage(err), { error: true });
        return;
      }
    }
    app.inputMetering = true;
    app.meterInput?.(true);
    app.dock?.openPanel('levels', { focus: false });
  }
  app.emit('transport', engine.state);
}

// ------------------------------------------------------------- preferences

function audioHardwarePrefs(app) {
  const p = app.prefs;
  const input = h('select.select', { 'aria-label': 'Default input device' }, h('option', { value: '' }, 'System Default'));
  // Output choice needs AudioContext.setSinkId (not in every browser).
  const canPickOutput = typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';
  const output = h('select.select', { 'aria-label': 'Default output device' }, h('option', { value: '' }, 'System Default'));
  const allow = h('button.btn', { type: 'button', hidden: true }, 'Show Device Names');
  const latency = h('span.muted.tabular');
  const fill = async () => {
    let devices = [];
    try {
      devices = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
    } catch {
      devices = [];
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
    input.replaceChildren(h('option', { value: '' }, 'System Default'), ...inputs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Input ${i + 1}`)));
    input.value = inputs.some((d) => d.deviceId === p.get('inputDevice')) ? p.get('inputDevice') : '';
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
    output.replaceChildren(h('option', { value: '' }, 'System Default'), ...outputs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Output ${i + 1}`)));
    output.value = outputs.some((d) => d.deviceId === p.get('outputDevice')) ? p.get('outputDevice') : '';
    allow.hidden = !inputs.length || inputs.some((d) => d.label);
    const e = app.engine;
    latency.textContent = e.ctx ? `${((e.outputLatencyFrames / e.rate) * 1000).toFixed(1)} ms at ${e.rate} Hz` : 'Measured when playback or recording starts';
  };
  input.addEventListener('change', async () => {
    p.set('inputDevice', input.value || null);
    if (app.inputMetering && !app.recording) {
      try {
        await app.engine.openInput({ deviceId: input.value || undefined });
      } catch (err) {
        app.notify(inputErrorMessage(err), { error: true });
      }
    }
  });
  output.addEventListener('change', () => p.set('outputDevice', output.value));
  allow.addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      app.notify(inputErrorMessage(err), { error: true });
    }
    fill();
  });
  fill();
  return [
    h(
      'div.form-grid',
      h('label', 'Default Input:'),
      h('div.io-row', input, allow),
      canPickOutput ? h('label', 'Default Output:') : null,
      canPickOutput ? output : null,
      h('label', 'Output Latency:'),
      latency,
    ),
  ];
}

// ----------------------------------------------------------------- markers

export async function importMarkers(app) {
  const doc = audio(app);
  let file = null;
  let item = null;
  if (puter.sdk() && puter.isSignedIn()) {
    [item] = await puter.pickFiles({ multiple: false, accept: '.csv,.txt,.tsv' });
    if (item) file = await item.read();
  } else {
    [file] = await pickLocalFiles({ accept: '.csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values', multiple: false });
  }
  if (!file) return;
  const name = file.name || item?.name || '';
  let parsed;
  try {
    const timeOptions = { timeFormat: app.prefs.get('timeFormat'), ...app.timeOptions() };
    parsed = parseMarkerText(await file.text(), doc.sampleRate, timeOptions);
  } catch (err) {
    // A file with no readable markers is the user's to fix, not a failure of the command.
    const why = err?.message ? ` ${err.message}` : '';
    const from = name ? ` from "${name}"` : '';
    const hint =
      'Marker files are tab-separated or CSV text with Name and Start columns, as File > Export > Markers writes them.';
    app.notify(`No markers were imported${from}.${why} ${hint}`, { error: true });
    return;
  }
  const inside = parsed.filter((m) => m.start <= doc.length).map((m) => createMarker({ ...m, duration: Math.min(m.duration, doc.length - m.start) }));
  if (!inside.length) {
    app.notify('All markers in the file are past the end of this audio.', { error: true });
    return;
  }
  doc.apply('Import Markers', { ...doc.state, markers: sortMarkers([...doc.state.markers, ...inside]) });
  app.notify(`Imported ${inside.length} marker${inside.length === 1 ? '' : 's'}${inside.length < parsed.length ? ` (${parsed.length - inside.length} past the end were skipped)` : ''}.`);
  app.dock?.openPanel('markers', { focus: false });
}

// ------------------------------------------------------------ window close

function installWindowClose(app) {
  const p = puter.sdk();
  if (!p?.ui?.onWindowClose || puter.env() !== 'app') return;
  p.ui.onWindowClose(async () => {
    if (app.recorder.active) await app.recorder.stop();
    for (const doc of app.documents.filter((d) => d.dirty)) {
      if (!(await app.closeDocument(doc))) return; // Cancel keeps the window open
    }
    await app.autosave?.run().catch(() => {});
    p.exit();
  });
}
