// Core commands: files, editing, selection, markers, view, transport,
// windows and help. Commands that only make sense for one document kind check
// it in `enabled`; another kind can override any command (see registry.js).

import { h } from '../lib/dom.js';
import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';
import * as E from '../model/edits.js';
import { createMarker, nextMarkerName, sortMarkers, MARKER_TYPES } from '../model/markers.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { openFiles, pickLocalFiles, openFromPuter, saveDocument, encodeDocument, downloadBlob } from '../storage/files.js';
import { TIME_FORMATS, parseTime } from '../lib/time.js';
import { appIcon } from '../ui/icons.js';
import { dsp } from '../audio/dsp.js';
import { baseName } from '../audio/decode.js';
import * as puter from '../storage/puter.js';
import { shortcutsDialog } from '../ui/shortcuts-dialog.js';
import { preferencesDialog } from '../ui/preferences.js';
import { deleteSmoothFrames, zoomInFactor } from '../editor/view-prefs.js';
import { shuttleCommands } from './shuttle.js';
import { mixPasteDialog, convertSampleTypeDialog, interpretRateDialog } from './edit-dialogs.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);
const hasAudio = (app) => Boolean(audio(app));
const hasSel = (app) => Boolean(audio(app)?.hasSelection);
const anyDoc = (app) => Boolean(app.active);

/** Resamples clip channels to `rate` when needed (paste between files). */
async function conformRate(clip, rate) {
  if (!clip || clip.sampleRate === rate) return clip;
  const d = await dsp();
  return {
    sampleRate: rate,
    channels: clip.channels.map((c) => Channel.fromSamples(d.resample(c.toArray(), clip.sampleRate, rate))),
  };
}

/** Clipboard data for the selection; markers inside it come along when Preferences say so. */
function clipFromSelection(app, doc) {
  const [a, b] = doc.hasSelection ? [doc.selection.start, doc.selection.end] : [0, 0];
  const clip = { type: 'audio', ...E.copyRange(doc.state, a, b, doc.channelMask) };
  if (app.prefs.get('markersWithClipboard')) clip.markers = E.markersInRange(doc.state.markers, a, b);
  return clip;
}

/** Adds clipboard markers (relative to the clip, at `fromRate`) to a state at frame `at`. */
function withClipMarkers(app, state, clip, at, fromRate) {
  if (!clip?.markers?.length || !app.prefs.get('markersWithClipboard')) return state;
  const ratio = state.sampleRate / (fromRate || state.sampleRate);
  const added = clip.markers.map((m) => createMarker({ ...m, start: at + m.start * ratio, duration: m.duration * ratio }));
  return { ...state, markers: sortMarkers([...state.markers, ...added]) };
}

function newDocFromClip(app, clip, name) {
  const doc = new AudioFile({ name: app.uniqueName(name || 'Untitled'), sampleRate: clip.sampleRate, channels: clip.channels.slice(), markers: app.prefs.get('markersWithClipboard') ? (clip.markers || []).map((m) => createMarker(m)) : [] });
  app.addDocument(doc);
  return doc;
}

// --------------------------------------------------------------- dialogs

async function newAudioDialog(app, { title = 'New Audio File', name } = {}) {
  const nameInput = h('input.input', { type: 'text', value: name || app.uniqueName('Untitled'), 'aria-label': 'File name', style: { width: '100%' } });
  const rate = h(
    'select.select',
    { 'aria-label': 'Sample rate' },
    [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000].map((r) => h('option', { value: r, selected: r === app.prefs.get('defaultRate') }, `${r} Hz`)),
  );
  const channels = h('select.select', { 'aria-label': 'Channels' }, h('option', { value: '1', selected: app.prefs.get('defaultChannels') === 1 }, 'Mono'), h('option', { value: '2', selected: app.prefs.get('defaultChannels') !== 1 }, 'Stereo'));
  const bits = h('select.select', { 'aria-label': 'Bit depth' }, [8, 16, 24, 32].map((b) => h('option', { value: b, selected: b === 32 }, b === 32 ? '32 (float)' : String(b))));
  const r = await openDialog({
    title,
    body: h(
      'div.form-grid',
      h('label', 'File Name:'),
      nameInput,
      h('label', 'Sample Rate:'),
      rate,
      h('label', 'Channels:'),
      channels,
      h('label', 'Bit Depth:'),
      bits,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  app.prefs.set('defaultRate', Number(rate.value));
  app.prefs.set('defaultChannels', Number(channels.value));
  return { name: nameInput.value.trim() || 'Untitled', sampleRate: Number(rate.value), channels: Number(channels.value), bitDepth: Number(bits.value) };
}

async function durationDialog(app, title, label) {
  const doc = audio(app);
  const input = h('input.input', { type: 'text', value: app.formatTime(doc.sampleRate, doc.sampleRate), 'aria-label': label, style: { width: '160px' } });
  const r = await openDialog({
    title,
    body: h('div.form-grid', h('label', `${label}:`), input),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  const frames = parseTime(input.value, doc.sampleRate, app.prefs.get('timeFormat'), app.timeOptions());
  if (!Number.isFinite(frames) || frames <= 0) {
    app.notify('Enter a duration greater than zero.', { error: true });
    return null;
  }
  return frames;
}

async function convertSampleType(app) {
  const doc = audio(app);
  const state = await convertSampleTypeDialog(app, doc);
  if (!state) return;
  const ratio = state.sampleRate / doc.sampleRate;
  doc.view = { ...doc.view, start: doc.view.start * ratio, end: doc.view.end * ratio };
  doc.selection = { start: 0, end: 0, channels: state.channels.map(() => true) };
  doc.apply('Convert Sample Type', state, { cursor: Math.round(doc.cursor * ratio) });
  app.syncGraph();
}

function aboutDialog() {
  return openDialog({
    title: 'About Audio Studio',
    body: h(
      'div.about',
      h('div.about-logo', appIcon(64)),
      h('p', 'Audio Studio is a waveform and multitrack audio editor that runs in your browser. Audio is processed on your device; files you save go to your own Puter cloud storage.'),
      h('p.muted', 'Signal processing runs in WebAssembly compiled from Rust, playback in an AudioWorklet, and waveforms and spectrograms are drawn with WebGL2.'),
      h('p.muted', 'Icons from Lucide (ISC license) plus original glyphs.'),
    ),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---------------------------------------------------------- registration

export function installCoreCommands(app) {
  const C = app.commands;
  const markersOf = (args) => {
    const doc = audio(app);
    // The Markers panel's selection; without that panel (it is created when first shown),
    // the markers selected on the editor's time ruler.
    const ids = args?.ids?.length ? args.ids : app.selectedMarkerIds?.() || [...(app.currentView?.()?.selectedMarkers || [])];
    return doc ? doc.state.markers.filter((m) => ids.includes(m.id)) : [];
  };

  C.register([
    // ---------------------------------------------------------------- File
    {
      id: 'file.newAudio',
      label: 'Audio File...',
      shortcut: 'Mod+Shift+N',
      run: async () => {
        const o = await newAudioDialog(app);
        if (!o) return;
        const doc = AudioFile.blank({ name: o.name, sampleRate: o.sampleRate, channels: o.channels });
        doc.info.bitDepth = o.bitDepth;
        app.addDocument(doc);
      },
    },
    { id: 'file.open', label: 'Open...', shortcut: 'Mod+O', run: () => openFromPuter(app) },
    { id: 'file.openLocal', label: 'Open from This Device...', shortcut: 'Mod+Shift+O', run: async () => openFiles(app, await pickLocalFiles()) },
    {
      id: 'file.appendCurrent',
      label: 'To Current...',
      enabled: hasAudio,
      run: async () => {
        const doc = audio(app);
        const files = await pickLocalFiles();
        for (const f of files) {
          const [opened] = await openFiles(app, [f], { activate: false });
          if (!opened) continue;
          const clip = await conformRate({ sampleRate: opened.sampleRate, channels: opened.state.channels }, doc.sampleRate);
          app.closeDocument(opened, { force: true });
          doc.apply('Append', E.insertClip(doc.state, doc.length, clip));
        }
      },
    },
    {
      id: 'file.appendNew',
      label: 'To New...',
      run: async () => {
        const files = await pickLocalFiles();
        const docs = await openFiles(app, files, { activate: false });
        if (!docs.length) return;
        const first = docs[0];
        for (const d of docs.slice(1)) {
          const clip = await conformRate({ sampleRate: d.sampleRate, channels: d.state.channels }, first.sampleRate);
          first.apply('Append', E.insertClip(first.state, first.length, clip));
          app.closeDocument(d, { force: true });
        }
        app.activate(first);
      },
    },
    {
      id: 'file.import',
      label: 'File...',
      shortcut: 'Mod+I',
      run: async () => {
        if (puter.sdk() && puter.isSignedIn()) return openFiles(app, await puter.pickFiles({ multiple: true }), { activate: false });
        return openFiles(app, await pickLocalFiles(), { activate: false });
      },
    },
    { id: 'file.importLocal', label: 'File from This Device...', run: async () => openFiles(app, await pickLocalFiles(), { activate: false }) },
    { id: 'file.close', label: 'Close', shortcut: 'Mod+W', enabled: anyDoc, run: () => app.closeDocument(app.active) },
    {
      id: 'file.closeAll',
      label: 'Close All',
      shortcut: 'Mod+Shift+W',
      enabled: (a) => a.documents.length > 0,
      run: async () => {
        for (const d of app.documents.slice()) if (!(await app.closeDocument(d))) return;
      },
    },
    { id: 'file.save', label: 'Save', shortcut: 'Mod+S', enabled: hasAudio, run: () => saveDocument(app, audio(app)) },
    { id: 'file.saveAs', label: 'Save As...', shortcut: 'Mod+Shift+S', enabled: hasAudio, run: () => saveDocument(app, audio(app), { saveAs: true }) },
    { id: 'file.saveCopy', label: 'Save a Copy...', enabled: hasAudio, run: () => saveDocument(app, audio(app), { copy: true }) },
    {
      id: 'file.saveSelectionAs',
      label: 'Save Selection As...',
      shortcut: 'Mod+Alt+S',
      enabled: hasSel,
      run: async () => {
        const doc = audio(app);
        const clip = E.copyRange(doc.state, doc.selection.start, doc.selection.end);
        const tmp = new AudioFile({ name: `${baseName(doc.name)} Selection.wav`, sampleRate: doc.sampleRate, channels: clip.channels, info: { ...doc.info } });
        return saveDocument(app, tmp, { copy: true });
      },
    },
    {
      id: 'file.saveAll',
      label: 'Save All',
      shortcut: 'Mod+Shift+Alt+S',
      enabled: (a) => a.documents.some((d) => d.dirty),
      run: async () => {
        const current = app.active;
        for (const d of app.documents.filter((x) => x.dirty)) {
          app.activate(d);
          await C.run('file.save');
        }
        app.activate(current);
      },
    },
    {
      id: 'file.revert',
      label: 'Revert',
      enabled: (a) => Boolean(a.active?.dirty && a.active.history),
      run: async () => {
        const doc = app.active;
        if (!(await confirmDialog({ title: 'Revert', message: `Discard all changes to "${doc.name}" since it was last saved?`, confirm: 'Revert', danger: true }))) return;
        const i = doc.history.entries.findIndex((e) => e.state === doc.savedState);
        if (i >= 0) doc.history.goTo(i);
        // The saved state can be gone from the history (cleared, trimmed, or
        // rewritten by marker changes kept out of it): restore it as a new step.
        else if (doc.savedState && doc.apply) doc.apply('Revert', doc.savedState);
        else doc.history.goTo(0);
      },
    },
    {
      id: 'file.download',
      label: 'Download to This Device',
      enabled: hasAudio,
      run: async () => {
        const doc = audio(app);
        downloadBlob(await encodeDocument(doc, { format: 'wav' }), `${baseName(doc.name)}.wav`);
      },
    },
    { id: 'file.properties', label: 'File Info', enabled: anyDoc, run: () => app.dock.openPanel('properties') },
    {
      id: 'file.exportMarkers',
      label: 'Markers...',
      enabled: (a) => Boolean(audio(a)?.state.markers.length),
      run: () => {
        const doc = audio(app);
        // Sample columns keep positions exact when the list is imported again.
        const rows = [['Name', 'Start', 'Duration', 'Time Format', 'Type', 'Description', 'Start Samples', 'Duration Samples', 'Sample Rate']];
        for (const m of doc.state.markers) rows.push([m.name, app.formatTime(m.start, doc.sampleRate), app.formatTime(m.duration, doc.sampleRate), app.prefs.get('timeFormat'), m.type, m.description || '', m.start, m.duration, doc.sampleRate]);
        const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join('\t')).join('\n');
        downloadBlob(new Blob([csv], { type: 'text/csv' }), `${baseName(doc.name)} Markers.csv`);
      },
    },

    // ---------------------------------------------------------------- Edit
    {
      id: 'edit.undo',
      label: (a) => (a.active?.history?.undoLabel ? `Undo ${a.active.history.undoLabel}` : 'Undo'),
      shortcut: 'Mod+Z',
      enabled: (a) => Boolean(a.active?.history?.canUndo),
      run: () => app.active.history.undo(),
    },
    {
      id: 'edit.redo',
      label: (a) => (a.active?.history?.redoLabel ? `Redo ${a.active.history.redoLabel}` : 'Redo'),
      shortcut: 'Mod+Shift+Z',
      altShortcuts: ['Mod+Y'],
      enabled: (a) => Boolean(a.active?.history?.canRedo),
      run: () => app.active.history.redo(),
    },
    {
      id: 'edit.repeat',
      label: 'Repeat Previous Command',
      shortcut: 'Mod+R',
      enabled: (a) => Boolean(a.lastCommand),
      // Commands with settings open their dialog again; see edit.repeatNoDialog.
      run: () => C.run(app.lastCommand.id, { ...app.lastCommand.args, repeat: false }),
    },
    {
      id: 'edit.repeatNoDialog',
      label: 'Repeat Previous Command Without Dialog',
      enabled: (a) => Boolean(a.lastCommand),
      run: () => C.run(app.lastCommand.id, { ...app.lastCommand.args, repeat: true }),
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      shortcut: 'Mod+X',
      enabled: hasSel,
      run: () => {
        const doc = audio(app);
        app.clipboard = clipFromSelection(app, doc);
        const { start, end } = doc.selection;
        doc.apply('Cut', E.deleteRange(doc.state, start, end, doc.channelMask, { smooth: deleteSmoothFrames(app, doc.sampleRate) }), { selection: { start, end: start }, cursor: start });
      },
    },
    { id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', enabled: hasSel, run: () => (app.clipboard = clipFromSelection(app, audio(app))) },
    { id: 'edit.copyToNew', label: 'Copy to New', shortcut: 'Mod+Alt+C', enabled: hasSel, run: () => newDocFromClip(app, clipFromSelection(app, audio(app)), `${baseName(audio(app).name)} Copy`) },
    {
      id: 'edit.paste',
      label: 'Paste',
      shortcut: 'Mod+V',
      enabled: (a) => hasAudio(a) && a.clipboard?.type === 'audio',
      run: async () => {
        const doc = audio(app);
        // The clipboard as it was when Paste ran (another can be chosen while a clip is resampled).
        const source = app.clipboard;
        const clip = await conformRate(source, doc.sampleRate);
        const n = clip.channels[0]?.length ?? 0;
        const at = doc.hasSelection ? doc.selection.start : doc.cursor;
        let state = doc.hasSelection ? E.replaceRange(doc.state, doc.selection.start, doc.selection.end, clip, doc.channelMask) : E.insertClip(doc.state, at, clip, doc.channelMask);
        if (!doc.channelMask) state = withClipMarkers(app, state, source, at, source.sampleRate);
        doc.apply('Paste', state, { selection: { start: at, end: at + n }, cursor: at });
      },
    },
    { id: 'edit.pasteToNew', label: 'Paste to New', shortcut: 'Mod+Alt+V', enabled: (a) => a.clipboard?.type === 'audio', run: () => newDocFromClip(app, app.clipboard, 'Untitled') },
    { id: 'edit.mixPaste', label: 'Mix Paste...', shortcut: 'Mod+Shift+V', enabled: hasAudio, run: () => mixPasteDialog(app, { doc: audio(app), conformRate }) },
    {
      id: 'edit.delete',
      label: 'Delete',
      shortcut: 'Delete',
      altShortcuts: ['Backspace'],
      enabled: hasSel,
      run: () => {
        const doc = audio(app);
        const { start, end } = doc.selection;
        doc.apply('Delete', E.deleteRange(doc.state, start, end, doc.channelMask, { smooth: deleteSmoothFrames(app, doc.sampleRate) }), { selection: { start, end: start }, cursor: start });
      },
    },
    {
      id: 'edit.crop',
      label: 'Crop',
      shortcut: 'Mod+T',
      enabled: hasSel,
      run: () => {
        const doc = audio(app);
        const { start, end } = doc.selection;
        doc.apply('Crop', E.cropRange(doc.state, start, end), { selection: { start: 0, end: end - start }, cursor: 0 });
        doc.setView(0, end - start);
      },
    },
    {
      id: 'edit.insertSilence',
      label: 'Silence...',
      enabled: hasAudio,
      run: async (a, args) => {
        const doc = audio(app);
        // args.seconds (a recorded favorite) inserts without asking.
        const frames = args?.seconds > 0 ? Math.round(args.seconds * doc.sampleRate) : await durationDialog(app, 'Insert Silence', 'Duration');
        if (!frames) return;
        const at = doc.hasSelection ? doc.selection.start : doc.cursor;
        doc.apply('Insert Silence', E.insertSilence(doc.state, at, frames), { selection: { start: at, end: at + frames } });
      },
    },
    { id: 'edit.selectAll', label: 'Select All', shortcut: 'Mod+A', enabled: hasAudio, run: () => audio(app).setSelection(0, audio(app).length, { channels: audio(app).state.channels.map(() => true) }) },
    { id: 'edit.deselect', label: 'Deselect All', shortcut: 'Mod+Shift+A', enabled: hasAudio, run: () => audio(app).setSelection(audio(app).cursor, audio(app).cursor) },
    {
      id: 'edit.selectView',
      label: 'Select Current View Time',
      enabled: hasAudio,
      run: () => {
        const doc = audio(app);
        doc.setSelection(doc.view.start, doc.view.end);
      },
    },
    {
      id: 'edit.selectInverse',
      label: 'Select Inverse',
      enabled: hasSel,
      run: () => {
        // With one contiguous selection, the inverse is the longer remaining side.
        const doc = audio(app);
        const { start, end } = doc.selection;
        if (start > doc.length - end) doc.setSelection(0, start);
        else doc.setSelection(end, doc.length);
      },
    },
    ...[1, 2, 3, 4, 5].map((n) => ({
      id: `edit.clipboard${n}`,
      label: `Clipboard ${n}`,
      shortcut: `Mod+${n}`,
      checked: (a) => a.clipboardIndex === n - 1,
      run: () => {
        app.clipboardIndex = n - 1;
        app.setStatus(`Clipboard ${n} is now active${app.clipboard ? '' : ' (empty)'}`);
        app.emit('clipboard');
      },
    })),
    { id: 'edit.snapping', label: 'Enable Snapping', shortcut: 'S', checked: (a) => a.prefs.get('snapping'), run: () => app.prefs.toggle('snapping') },
    ...[
      ['markers', 'Snap to Markers'],
      ['ruler', 'Snap to Ruler (Coarse)'],
      ['rulerFine', 'Snap to Ruler (Fine)'],
      ['clips', 'Snap to Clips'],
      ['loops', 'Snap to Loops'],
      ['zero', 'Snap to Zero Crossings'],
      ['frames', 'Snap to Frames'],
    ].map(([k, label]) => ({
      id: `snap.${k}`,
      label,
      checked: (a) => Boolean(a.prefs.get('snap')[k]),
      run: () => app.prefs.set('snap', { ...app.prefs.get('snap'), [k]: !app.prefs.get('snap')[k] }),
    })),
    { id: 'edit.convertSampleType', label: 'Convert Sample Type...', shortcut: 'Shift+T', enabled: hasAudio, run: () => convertSampleType(app) },
    {
      id: 'edit.interpretRate',
      label: 'Interpret Sample Rate...',
      enabled: hasAudio,
      run: async () => {
        const doc = audio(app);
        const rate = await interpretRateDialog(app, doc);
        if (!rate || rate === doc.sampleRate) return;
        const ratio = rate / doc.sampleRate;
        doc.apply('Interpret Sample Rate', { ...doc.state, sampleRate: rate });
        doc.setView(doc.view.start, doc.view.end);
        app.syncGraph();
        app.setStatus(`Now interpreted at ${rate} Hz (${ratio > 1 ? 'faster' : 'slower'} playback)`);
      },
    },
    { id: 'edit.keyboardShortcuts', label: 'Keyboard Shortcuts...', shortcut: 'Alt+K', run: () => shortcutsDialog(app) },
    { id: 'edit.preferences', label: 'Preferences...', shortcut: 'Mod+,', run: (a, args) => preferencesDialog(app, args) },

    // ---------------------------------------------------------------- Tools
    ...[
      ['move', 'Move', 'V'],
      ['razor', 'Razor', 'R'],
      ['slip', 'Slip', 'Y'],
      ['time', 'Time Selection', 'T'],
      ['marquee', 'Marquee Selection', 'E'],
      ['lasso', 'Lasso Selection', 'D'],
      ['brush', 'Paintbrush Selection', 'P'],
      ['heal', 'Spot Healing Brush', 'B'],
    ].map(([id, label, key]) => ({
      id: `tool.${id}`,
      label,
      shortcut: key,
      enabled: (a) => (a.toolAvailable ? a.toolAvailable(id) : id === 'time'),
      checked: (a) => a.tool === id,
      run: () => app.setTool(id),
    })),

    // -------------------------------------------------------------- Markers
    { id: 'marker.add', label: 'Add Cue Marker', shortcut: 'M', enabled: hasAudio, repeatable: false, run: () => app.currentView?.()?.addMarker?.({ range: false }) },
    { id: 'marker.addRange', label: 'Add Range Marker', shortcut: 'Shift+M', enabled: hasSel, run: () => app.currentView?.()?.addMarker?.({ range: true }) },
    {
      id: 'marker.rename',
      label: 'Rename Selected Marker',
      enabled: (a, args) => Boolean(args?.id || markersOf(args).length),
      run: async (a, args) => {
        const doc = audio(app);
        const m = doc.state.markers.find((x) => x.id === (args?.id || markersOf(args)[0]?.id));
        if (!m) return;
        const typeSel = h('select.select', { 'aria-label': 'Marker type' }, MARKER_TYPES.map((t) => h('option', { value: t.id, selected: t.id === m.type }, t.label)));
        const name = h('input.input', { type: 'text', value: m.name, 'aria-label': 'Marker name', style: { width: '100%' } });
        const desc = h('textarea.input', { rows: 2, 'aria-label': 'Description', style: { width: '100%' } }, m.description || '');
        const r = await openDialog({
          title: 'Marker',
          body: h('div.form-grid', h('label', 'Name:'), name, h('label', 'Type:'), typeSel, h('label', 'Description:'), desc),
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'OK', value: 'ok', primary: true },
          ],
        });
        if (r !== 'ok') return;
        doc.apply('Rename Marker', { ...doc.state, markers: doc.state.markers.map((x) => (x.id === m.id ? { ...x, name: name.value, type: typeSel.value, description: desc.value } : x)) });
      },
    },
    {
      id: 'marker.deleteSelected',
      label: 'Delete Selected Markers',
      enabled: (a, args) => markersOf(args).length > 0,
      run: (a, args) => {
        const doc = audio(app);
        const ids = new Set(markersOf(args).map((m) => m.id));
        doc.apply(ids.size > 1 ? 'Delete Markers' : 'Delete Marker', { ...doc.state, markers: doc.state.markers.filter((m) => !ids.has(m.id)) });
      },
    },
    {
      id: 'marker.deleteAll',
      label: 'Delete All Markers',
      enabled: (a) => Boolean(audio(a)?.state.markers.length),
      run: () => {
        const doc = audio(app);
        doc.apply('Delete All Markers', { ...doc.state, markers: [] });
      },
    },
    {
      id: 'marker.merge',
      label: 'Merge Selected Markers',
      enabled: (a, args) => markersOf(args).length > 1,
      run: (a, args) => {
        const doc = audio(app);
        const ms = markersOf(args);
        const start = Math.min(...ms.map((m) => m.start));
        const end = Math.max(...ms.map((m) => m.start + m.duration));
        const ids = new Set(ms.map((m) => m.id));
        const merged = createMarker({ start, duration: end - start, name: ms[0].name, type: ms[0].type });
        doc.apply('Merge Markers', { ...doc.state, markers: sortMarkers([...doc.state.markers.filter((m) => !ids.has(m.id)), merged]) });
      },
    },
    {
      id: 'marker.convertRange',
      label: 'Convert to Range',
      enabled: (a, args) => markersOf(args).length === 1 && markersOf(args)[0].duration === 0 && hasSel(a),
      run: (a, args) => {
        const doc = audio(app);
        const m = markersOf(args)[0];
        doc.apply('Convert Marker', { ...doc.state, markers: doc.state.markers.map((x) => (x.id === m.id ? { ...x, start: doc.selection.start, duration: doc.selection.end - doc.selection.start } : x)) });
      },
    },
    {
      id: 'marker.previous',
      label: 'Move Playhead to Previous Marker',
      shortcut: 'Alt+ArrowLeft',
      enabled: hasAudio,
      run: () => {
        const doc = audio(app);
        const at = app.playhead;
        const prev = doc.state.markers.flatMap((m) => [m.start, m.start + m.duration]).filter((f) => f < at).sort((a, b) => b - a)[0] ?? 0;
        app.currentView?.()?.seek(prev);
      },
    },
    {
      id: 'marker.next',
      label: 'Move Playhead to Next Marker',
      shortcut: 'Alt+ArrowRight',
      enabled: hasAudio,
      run: () => {
        const doc = audio(app);
        const at = app.playhead;
        const next = doc.state.markers.flatMap((m) => [m.start, m.start + m.duration]).filter((f) => f > at).sort((a, b) => a - b)[0] ?? doc.length;
        app.currentView?.()?.seek(next);
      },
    },

    // ------------------------------------------------------- Simple effects
    {
      id: 'fx.invert',
      label: 'Invert',
      enabled: hasAudio,
      repeatable: true,
      run: () => {
        const doc = audio(app);
        const [a, b] = doc.editRange();
        doc.apply('Invert', E.invertRange(doc.state, a, b, doc.channelMask));
      },
    },
    {
      id: 'fx.reverse',
      label: 'Reverse',
      enabled: hasAudio,
      repeatable: true,
      run: () => {
        const doc = audio(app);
        const [a, b] = doc.editRange();
        doc.apply('Reverse', E.reverseRange(doc.state, a, b, doc.channelMask));
      },
    },
    {
      id: 'fx.silence',
      label: 'Silence',
      enabled: hasSel,
      repeatable: true,
      run: () => {
        const doc = audio(app);
        doc.apply('Silence', E.silenceRange(doc.state, doc.selection.start, doc.selection.end, doc.channelMask));
      },
    },
    { id: 'fx.applyLast', label: (a) => (a.lastCommand ? `Repeat ${C.label(a.lastCommand.id)}` : 'Repeat Last Effect'), enabled: (a) => Boolean(a.lastCommand), run: () => C.run('edit.repeatNoDialog') },

    // ---------------------------------------------------------------- View
    {
      id: 'view.waveform',
      label: 'Waveform Editor',
      shortcut: '9',
      checked: (a) => a.active?.kind === 'audio',
      run: () => {
        const doc = app.documents.find((d) => d.kind === 'audio');
        if (app.active?.kind === 'audio') return;
        if (app.active?.waveformTarget?.()) app.activate(app.active.waveformTarget());
        else if (doc) app.activate(doc);
        else C.run('file.newAudio');
      },
    },
    {
      id: 'view.multitrack',
      label: 'Multitrack Editor',
      shortcut: '0',
      checked: (a) => a.active?.kind === 'session',
      run: () => {
        const s = app.documents.find((d) => d.kind === 'session');
        if (app.active?.kind === 'session') return;
        if (s) app.activate(s);
        else C.run('file.newSession');
      },
    },
    { id: 'view.hud', label: 'Show HUD', shortcut: 'Shift+U', checked: (a) => a.prefs.get('hud'), run: () => app.prefs.toggle('hud') },
    { id: 'view.statusBar', label: 'Show Status Bar', checked: (a) => a.prefs.get('statusBar'), run: () => app.prefs.toggle('statusBar') },
    { id: 'view.autoScroll', label: 'Auto-Scroll During Playback', checked: (a) => a.prefs.get('autoScroll'), run: () => app.prefs.toggle('autoScroll') },
    { id: 'view.clipFadeHandles', label: 'Show Fade Handles', checked: (a) => a.prefs.get('clipFadeHandles'), run: () => app.prefs.toggle('clipFadeHandles') },
    {
      id: 'view.zoomInTime',
      label: 'Zoom In (Time)',
      shortcut: '=',
      altShortcuts: ['Shift+=', '+'],
      enabled: anyDoc,
      run: () => zoomTime(app, zoomInFactor(app)),
    },
    { id: 'view.zoomOutTime', label: 'Zoom Out (Time)', shortcut: '-', enabled: anyDoc, run: () => zoomTime(app, 1 / zoomInFactor(app)) },
    { id: 'view.zoomInAmp', label: 'Zoom In (Amplitude)', shortcut: 'Alt+=', enabled: hasAudio, run: () => audio(app).setAmp(audio(app).view.amp * 1.5) },
    { id: 'view.zoomOutAmp', label: 'Zoom Out (Amplitude)', shortcut: 'Alt+-', enabled: hasAudio, run: () => audio(app).setAmp(audio(app).view.amp / 1.5) },
    {
      id: 'view.zoomFull',
      label: 'Zoom Out Full (All Axes)',
      shortcut: '\\',
      enabled: anyDoc,
      run: () => {
        const doc = app.active;
        doc.setView(0, Math.max(doc.length, doc.sampleRate));
        if (doc.setAmp) doc.setAmp(1);
      },
    },
    {
      id: 'view.zoomSelection',
      label: 'Zoom to Selection',
      shortcut: 'Shift+\\',
      enabled: (a) => Boolean(a.active?.hasSelection),
      run: () => {
        const doc = app.active;
        const { start, end } = doc.selection;
        const pad = (end - start) * 0.02;
        doc.setView(start - pad, end + pad);
      },
    },
    {
      id: 'view.zoomInPoint',
      label: 'Zoom In at In Point',
      enabled: (a) => Boolean(a.active?.hasSelection),
      run: () => {
        const doc = app.active;
        const span = (doc.view.end - doc.view.start) / 4;
        doc.setView(doc.selection.start - span / 2, doc.selection.start + span / 2);
      },
    },
    {
      id: 'view.zoomOutPoint',
      label: 'Zoom In at Out Point',
      enabled: (a) => Boolean(a.active?.hasSelection),
      run: () => {
        const doc = app.active;
        const span = (doc.view.end - doc.view.start) / 4;
        doc.setView(doc.selection.end - span / 2, doc.selection.end + span / 2);
      },
    },
    ...[1, 2, 3, 4, 5].flatMap((n) => [
      {
        id: `view.zoomPreset${n}`,
        label: `Zoom to Preset ${n}`,
        enabled: (a) => Boolean(a.active && a.prefs.get('zoomPresets')[n]),
        run: () => {
          const span = app.prefs.get('zoomPresets')[n] * app.active.sampleRate;
          const c = app.playhead;
          app.active.setView(c - span / 2, c + span / 2);
        },
      },
      {
        id: `view.saveZoom${n}`,
        label: `Save Current Zoom to Preset ${n}`,
        enabled: anyDoc,
        run: () => app.prefs.set('zoomPresets', { ...app.prefs.get('zoomPresets'), [n]: (app.active.view.end - app.active.view.start) / app.active.sampleRate }),
      },
    ]),
    {
      id: 'view.scrollToPlayhead',
      label: 'Scroll to Playhead',
      enabled: anyDoc,
      run: () => {
        const doc = app.active;
        const span = doc.view.end - doc.view.start;
        doc.setView(app.playhead - span / 2, app.playhead + span / 2);
      },
    },
    ...['system', 'light', 'dark'].map((t) => ({
      id: `theme.${t}`,
      label: t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark',
      checked: (a) => a.prefs.get('theme') === t,
      run: () => app.prefs.set('theme', t),
    })),

    // ------------------------------------------------------------ Transport
    { id: 'transport.play', label: 'Play', enabled: anyDoc, run: () => (app.engine.playing ? null : app.play()) },
    { id: 'transport.toggle', label: 'Play/Stop', shortcut: 'Space', enabled: anyDoc, run: () => app.togglePlay() },
    { id: 'transport.stop', label: 'Stop', enabled: (a) => a.engine.playing || Boolean(a.recording) || Boolean(a.canReturn), run: () => (app.recording ? C.run('transport.record') : app.stop()) },
    {
      id: 'transport.pause',
      label: 'Pause',
      enabled: (a) => a.engine.playing,
      run: () => {
        const at = app.engine.stop();
        app.playStart = null;
        app.active?.setCursor(at);
        app.emit('transport', 'paused');
      },
    },
    {
      id: 'transport.previous',
      label: 'Move Playhead to Previous',
      shortcut: 'Home',
      enabled: anyDoc,
      run: () => {
        const doc = app.active;
        // While playing, a stop just passed (within 50 ms) is skipped so pressing Previous again
        // goes on to the one before it; when stopped the playhead sits exactly on its stop.
        const at = app.engine.playing ? app.playhead - doc.sampleRate * 0.05 : app.playhead;
        const stops = [0, ...(doc.state?.markers || []).flatMap((m) => [m.start, m.start + m.duration])];
        if (doc.hasSelection) stops.push(doc.selection.start, doc.selection.end);
        const prev = stops.filter((f) => f < at).sort((a, b) => b - a)[0] ?? 0;
        seekTo(app, prev);
      },
    },
    {
      id: 'transport.next',
      label: 'Move Playhead to Next',
      shortcut: 'End',
      enabled: anyDoc,
      run: () => {
        const doc = app.active;
        const at = app.playhead;
        const stops = [doc.length, ...(doc.state?.markers || []).flatMap((m) => [m.start, m.start + m.duration])];
        if (doc.hasSelection) stops.push(doc.selection.start, doc.selection.end);
        const next = stops.filter((f) => f > at).sort((a, b) => a - b)[0] ?? doc.length;
        seekTo(app, next);
      },
    },
    { id: 'transport.toStart', label: 'Move Playhead to Beginning', shortcut: 'Mod+ArrowLeft', enabled: anyDoc, run: () => seekTo(app, 0) },
    { id: 'transport.toEnd', label: 'Move Playhead to End', shortcut: 'Mod+ArrowRight', enabled: anyDoc, run: () => seekTo(app, app.active.length) },
    { id: 'transport.rewind', label: 'Rewind', shortcut: 'Alt+[', enabled: anyDoc, run: (a, args) => seekTo(app, app.playhead - app.active.sampleRate * (args?.shuttle ? 0.25 : 1)) },
    { id: 'transport.forward', label: 'Fast Forward', shortcut: 'Alt+]', enabled: anyDoc, run: (a, args) => seekTo(app, app.playhead + app.active.sampleRate * (args?.shuttle ? 0.25 : 1)) },
    {
      id: 'transport.loop',
      label: 'Loop Playback',
      shortcut: 'Mod+L',
      checked: (a) => a.loop,
      run: () => {
        app.prefs.set('loop', !app.loop);
        if (app.engine.playing) {
          app.engine.setLoop(app.loop ? app.loopRange(app.active) : null);
        }
        app.emit('transport', app.engine.state);
      },
    },
    ...shuttleCommands(app),
    { id: 'transport.skipSelection', label: 'Skip Selection', checked: (a) => a.prefs.get('skipSelection'), run: () => app.prefs.toggle('skipSelection') },

    // --------------------------------------------------------------- Window
    { id: 'window.maximize', label: 'Maximize Frame', shortcut: '`', run: () => app.dock.toggleMaximize() },
    ...[
      ['editor', 'Editor', 'Alt+1'],
      ['mixer', 'Mixer', 'Alt+2'],
      ['properties', 'Properties', 'Alt+3'],
      ['assistant', 'Sound Assistant', 'Alt+4'],
      ['levels', 'Level Meters', 'Alt+7'],
      ['markers', 'Markers', 'Alt+8'],
      ['files', 'Files', 'Alt+9'],
      ['effects', 'Effects Rack', 'Alt+0'],
      ['frequency', 'Frequency Analysis', 'Alt+Z'],
      ['amplitude', 'Amplitude Statistics'],
      ['batch', 'Batch Process'],
      ['diagnostics', 'Diagnostics'],
      ['favorites', 'Favorites'],
      ['history', 'History'],
      ['loudness', 'Match Loudness', 'Alt+5'],
      ['media', 'Media Browser'],
      ['metadata', 'Metadata', 'Mod+P'],
      ['phaseAnalysis', 'Phase Analysis'],
      ['phase', 'Phase Meter', 'Alt+X'],
      ['selection', 'Selection/View', 'Alt+6'],
      ['events', 'Events'],
      ['playlist', 'Playlist'],
      ['time', 'Time'],
      ['tools', 'Tools'],
      ['trackPanner', 'Track Panner'],
      ['tracks', 'Tracks'],
      ['transport', 'Transport'],
      ['zoom', 'Zoom'],
    ].map(([id, label, shortcut]) => ({
      id: `window.${id}`,
      label,
      shortcut,
      enabled: (a) => a.panels.has(id),
      checked: (a) => Boolean(a.dock?.isOpen(id)),
      run: () => (app.dock.isVisible(id) && id !== 'editor' ? app.dock.closePanel(id) : app.dock.openPanel(id)),
    })),

    // ----------------------------------------------------------------- Help
    { id: 'help.shortcuts', label: 'Keyboard Shortcuts', shortcut: 'Mod+/', run: () => shortcutsDialog(app) },
    { id: 'help.about', label: 'About Audio Studio', run: () => aboutDialog() },
  ]);

  // Dynamic menus.
  app.timeFormatMenuItems = () =>
    TIME_FORMATS.map((f) => ({
      type: 'cmd',
      // The custom rate names its frame rate, as in "Custom (12 fps)".
      label: f.id === 'frames' ? `Custom (${Number(app.prefs.get('customFps')) || 12} fps)` : f.label,
      enabled: true,
      checked: app.prefs.get('timeFormat') === f.id,
      run: () => app.prefs.set('timeFormat', f.id),
    }));
  app.documentMenuItems = () => app.documents.map((d) => ({ type: 'cmd', label: `${d.name}${d.dirty ? ' *' : ''}`, enabled: true, checked: d === app.active, run: () => app.activate(d) }));
  app.recentMenuItems = () => {
    const list = app.prefs.get('recent') || [];
    if (!list.length) return [];
    return [
      ...list.map((r) => ({
        type: 'cmd',
        label: r.name,
        enabled: true,
        run: async () => {
          try {
            const blob = await puter.readFile(r.path);
            await openFiles(app, [Object.assign(blob, { name: r.name })]).then((docs) => docs[0] && (docs[0].source = { type: 'puter', path: r.path }));
          } catch {
            app.notify(`"${r.name}" could not be opened. It may have been moved or deleted.`, { error: true });
          }
        },
      })),
      { type: 'sep' },
      { type: 'cmd', label: 'Clear Recent', enabled: true, run: () => app.prefs.set('recent', []) },
    ];
  };
  app.channelMenuItems = () => {
    const doc = audio(app);
    if (!doc) return [];
    return doc.state.channels.map((_, i) => ({
      type: 'cmd',
      label: doc.channelCount === 1 ? 'Mono' : ['Left', 'Right'][i] || `Channel ${i + 1}`,
      enabled: true,
      checked: doc.selection.channels[i] !== false,
      run: () => doc.setChannelEnabled(i, doc.selection.channels[i] === false),
    }));
  };
  app.setTool = (id) => {
    app.tool = id;
    app.emit('tool', id);
  };
}

function zoomTime(app, factor) {
  const doc = app.active;
  const v = doc.view;
  const span = v.end - v.start;
  const p = app.playhead;
  const centre = p >= v.start && p <= v.end ? p : (v.start + v.end) / 2;
  const frac = (centre - v.start) / span;
  const nspan = span * factor;
  doc.setView(centre - frac * nspan, centre - frac * nspan + nspan);
}

function seekTo(app, frame) {
  const doc = app.active;
  if (!doc) return;
  frame = Math.max(0, Math.min(doc.length, Math.round(frame)));
  const view = app.currentView?.();
  if (view?.seek) view.seek(frame);
  else doc.setCursor(frame);
  const v = doc.view;
  if (frame < v.start || frame > v.end) {
    const span = v.end - v.start;
    doc.setView(frame - span / 2, frame + span / 2);
  }
}

