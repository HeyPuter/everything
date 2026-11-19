// Preferences feature: commands that open Preferences on a given page,
// File > Import/Export > Application Settings, and the wiring that hands
// preference values to the modules that act on them (markers, clip
// placement, effect chains, meters, appearance, audio devices and channel
// maps), keeps open audio files in step when synchronizing is on and warns
// when open audio grows past the memory limit.

import { h } from '../lib/dom.js';
import { exportSettings, validateSettings } from '../lib/prefs.js';
import { markerOptions } from '../model/markers.js';
import { placementOptions } from '../multitrack/insert.js';
import { rackOptions } from '../effects/rack.js';
import { meterLevels } from '../multitrack/meter.js';
import { installAppearance } from '../ui/appearance.js';
import { CATEGORIES, preferencesDialog, openAudioBytes } from '../ui/preferences.js';
import { formatBytesShort } from '../export/formats.js';
import { openDialog } from '../ui/dialog.js';
import { pickLocalFiles, downloadBlob } from '../storage/files.js';
import { setResampleSettings } from '../audio/dsp.js';

/** Copies preference values into the module options that read them. */
export function applyModulePrefs(prefs) {
  markerOptions.undo = prefs.get('markerUndo') !== false;
  markerOptions.name = String(prefs.get('markerName') || 'Marker').trim() || 'Marker';
  markerOptions.lock = Boolean(prefs.get('markerLock'));
  placementOptions.randomColor = Boolean(prefs.get('randomTrackColor'));
  placementOptions.avoidOverlap = Boolean(prefs.get('avoidOverlap'));
  placementOptions.sameTrack = prefs.get('insertMultiple') === 'same';
  placementOptions.embeddedTimecode = Boolean(prefs.get('embeddedTimecode'));
  rackOptions.processBypassed = Boolean(prefs.get('fxProcessBypassed'));
  rackOptions.sort = prefs.get('fxMenuSort') === 'name' ? 'name' : 'category';
  const caution = Number(prefs.get('meterCaution'));
  const warning = Number(prefs.get('meterWarning'));
  meterLevels.caution = Number.isFinite(caution) ? caution : -12;
  meterLevels.warning = Number.isFinite(warning) ? Math.max(meterLevels.caution, warning) : -3;
  setResampleSettings({ quality: prefs.get('srcQuality'), filter: prefs.get('srcFilter') !== false });
}

/** Hands device settings to the playback engine. */
export function applyEnginePrefs(app) {
  const e = app.engine;
  if (!e) return;
  e.setLatencyHint?.(app.prefs.get('latencyHint') || 'interactive');
  e.setOutputMap?.(app.prefs.get('outputMap'));
  e.setInputMap?.(app.prefs.get('inputMap'));
  if ((app.prefs.get('outputDevice') || '') !== (e.sinkId || '')) e.setSink?.(app.prefs.get('outputDevice') || '');
}

const ENGINE_KEYS = new Set(['latencyHint', 'outputMap', 'inputMap', 'outputDevice']);

/** Settings file name for today: "Audio Studio Settings 2026-10-12.json". */
export function settingsFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Audio Studio Settings ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Applies validated settings: preferences, then the shortcuts and workspace that depend on them. */
export function importSettingsValues(app, values) {
  app.prefs.replaceAll(values);
  app.commands.reloadShortcuts?.();
  if (app.dock && app.layoutMode === 'desktop') app.setWorkspace(app.prefs.get('workspace'));
}

async function importSettings(app) {
  const [file] = await pickLocalFiles({ accept: '.json,application/json', multiple: false });
  if (!file) return false;
  let parsed;
  try {
    parsed = validateSettings(JSON.parse(await file.text()));
  } catch (err) {
    app.notify(err instanceof SyntaxError ? `"${file.name}" is not a valid settings file.` : err.message, { error: true });
    return false;
  }
  const n = Object.keys(parsed.values).length;
  const r = await openDialog({
    title: 'Import Application Settings',
    body: h(
      'div',
      { style: { maxWidth: '440px' } },
      h('p', { style: { margin: '0 0 8px' } }, `Replace your current preferences, keyboard shortcuts, favorites and workspaces with the ${n} setting${n === 1 ? '' : 's'} in "${file.name}"?`),
      parsed.skipped.length ? h('p.muted', { style: { margin: 0 } }, `${parsed.skipped.length} unrecognized entr${parsed.skipped.length === 1 ? 'y' : 'ies'} will be ignored.`) : null,
      h('p.muted', { style: { margin: '8px 0 0' } }, 'Recent files and folder locations on this device are kept.'),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Import', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return false;
  importSettingsValues(app, parsed.values);
  app.notify('Settings imported.');
  return true;
}

export function installPreferences(app) {
  applyModulePrefs(app.prefs);
  applyEnginePrefs(app);
  installAppearance(app);

  app.prefs.on('change', (key) => {
    applyModulePrefs(app.prefs);
    // Settings the playback graph is built from.
    if (key === 'panLaw' || key === 'panLawDb' || key === 'fxProcessBypassed') app.syncGraph();
    if (key === 'shortcuts') app.commands.reloadShortcuts?.();
    if (ENGINE_KEYS.has(key)) applyEnginePrefs(app);
  });

  // Preferences > Memory: one warning each time open audio grows past the limit.
  let overLimit = false;
  app.on('documents', () => {
    const limit = Number(app.prefs.get('memoryWarnMb')) * 1024 * 1024;
    const bytes = openAudioBytes(app);
    if (!(limit > 0) || bytes <= limit) {
      overLimit = false;
      return;
    }
    if (overLimit) return;
    overLimit = true;
    app.notify(`Open files use about ${formatBytesShort(bytes)} of memory. Save and close files you no longer need to keep the browser responsive.`);
  });

  // Keep selection, zoom and playhead in step across open audio files.
  let syncing = false;
  app.on('doc-change', (doc, e) => {
    if (syncing || doc !== app.active || doc.kind !== 'audio' || !app.prefs.get('syncFiles')) return;
    if (e.kind !== 'view' && e.kind !== 'selection' && e.kind !== 'cursor') return;
    syncing = true;
    try {
      for (const d of app.documents) {
        if (d === doc || d.kind !== 'audio') continue;
        const r = d.sampleRate / doc.sampleRate;
        if (e.kind === 'view') d.setView(doc.view.start * r, doc.view.end * r);
        else if (e.kind === 'selection') d.setSelection(doc.selection.start * r, doc.selection.end * r);
        else d.setCursor(Math.min(d.length, doc.cursor * r));
      }
    } finally {
      syncing = false;
    }
  });
  // A file brought forward picks up the current range too.
  let previous = null;
  app.on('active', (doc) => {
    const from = previous;
    previous = doc;
    if (!app.prefs.get('syncFiles') || doc?.kind !== 'audio' || from?.kind !== 'audio' || !app.documents.includes(from)) return;
    const r = doc.sampleRate / from.sampleRate;
    syncing = true;
    try {
      doc.setView(from.view.start * r, from.view.end * r);
      doc.setSelection(from.selection.start * r, from.selection.end * r);
      doc.setCursor(Math.min(doc.length, from.cursor * r));
    } finally {
      syncing = false;
    }
  });

  app.commands.register([
    ...CATEGORIES.map((c) => ({ id: `prefs.${c.id}`, label: `${c.label}...`, run: () => preferencesDialog(app, { category: c.id }) })),
    { id: 'file.importSettings', label: 'Application Settings...', run: () => importSettings(app) },
    {
      id: 'file.exportSettings',
      label: 'Application Settings...',
      run: () => {
        const json = JSON.stringify(exportSettings(app.prefs), null, 2);
        downloadBlob(new Blob([json], { type: 'application/json' }), settingsFileName());
        app.setStatus('Settings exported');
      },
    },
  ]);
}
