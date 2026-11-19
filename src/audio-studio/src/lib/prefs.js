// User preferences persisted in localStorage (small settings only; files and
// projects never go here). Unknown keys fall back to DEFAULTS.

import { Emitter } from './emitter.js';

const KEY = 'audio-studio:prefs';

export const DEFAULTS = {
  theme: 'system',
  workspace: 'Default',
  layouts: {},
  timeFormat: 'decimal',
  tempo: 120,
  beatsPerBar: 4,
  snapping: true,
  snap: { ruler: true, rulerFine: false, markers: true, clips: true, zero: false, loops: false, frames: false },
  autoScroll: true,
  hud: true,
  statusBar: true,
  spectralLog: true,
  meterRange: 60,
  meterPeaks: 'dynamic',
  meterValleys: false,
  meterGradient: false,
  meterLed: false,
  historyLimit: 200,
  recent: [],
  zoomPresets: {},
  clipVolumeEnvelopes: true,
  clipPanEnvelopes: false,
  clipFadeHandles: true,
  favorites: null,
  defaultRate: 48000,
  batchConcurrency: 2,
  embeddedTimecode: false,
  channelZones: true,
  meterOnArm: true,
  defaultChannels: 2,
  returnToStart: true,
  skipSelection: false,
  shortcuts: {},
  shortcutSets: {},
  shortcutSet: '',
  sessionTemplates: [],
  previewEditor: false,
  previewAuto: true,
  previewZoom: 'sync', // Preview Editor zoom: 'sync' (follows the main editor) | 'independent'
  visibilityInMixer: true,
  controlSurface: { enabled: false, input: '', output: '', protocol: 'mcu', mappings: {} },

  // General
  wheelZoomFactor: 1, // multiplier on the mouse-wheel zoom rate
  wheelZoomAnchor: 'mouse', // 'mouse' | 'playhead'
  defaultFadeCurve: 'linear', // 'linear' | 'log' | 'cosine' for new fades
  rightClick: 'menu', // 'menu' | 'extend' (extend the time selection)
  hudSelectionOnly: false,
  ampUnits: 'db', // amplitude ruler unit: 'db' | 'percent' | 'normalized' | 'samples'
  syncFiles: false, // selection, zoom and playhead follow across open audio files
  zoomStep: 50, // percent of the view each Zoom In/Out (Time) step removes
  dismissedNotices: [], // notice ids turned off with "Don't show this again"
  // Appearance
  accentColor: 'blue',
  waveColors: null, // { wave, selection, background } or null for the theme colors
  waveColorPresets: [], // [{ name, wave, selection, background, playhead, cue, subclip, cart, cd }]
  uiBrightness: 0, // -100 (darker) .. 100 (lighter) for panels and backgrounds
  // Audio Channel Mapping and Audio Hardware
  inputMap: [0, 1], // device input channel recorded as file channel 1 and 2 (-1 = none)
  outputMap: [0, 1], // device output channel that plays mix channel 1 and 2 (-1 = none)
  latencyHint: 'interactive', // 'interactive' | 'balanced' | 'playback'
  outputDevice: '', // sink id; '' = system default
  // Data
  smoothDelete: false,
  smoothDeleteMs: 2,
  smoothEdits: false,
  smoothEditsMs: 5,
  srcQuality: 50, // sample-rate conversion quality, 0..100
  srcFilter: true, // pre/post filter: keep the transition band below Nyquist
  // Auto Save
  autosave: true,
  autosaveInterval: 60, // seconds
  sessionBackup: true, // periodic backups of open multitrack sessions
  sessionBackupInterval: 3, // minutes
  sessionBackupMax: 10, // backups kept per session
  // Effects
  fxOpenOnAdd: false,
  fxProcessBypassed: false,
  fxMenuSort: 'category', // 'category' | 'name'
  previewAutoMode: 'length', // automatic Preview Editor for 'length'-changing effects or 'any' effect
  // Memory
  memoryWarnMb: 2048, // 0 = never warn
  // Markers & Metadata
  exportMarkers: true,
  markerUndo: true,
  markersWithClipboard: false,
  showMarkerLines: true,
  markersInMixdowns: false,
  markerName: 'Marker',
  markerLock: false, // markers keep their times when audio before them is deleted or inserted
  // Multitrack
  panLaw: 'balance', // 'balance' | 'equalPower'
  panLawDb: -3, // centre attenuation for equal power panning
  soloExclusive: false,
  loopToLastClip: true,
  avoidOverlap: false,
  randomTrackColor: false,
  // Multitrack Clips
  autoCrossfade: true, // for new sessions
  clipsToFront: false,
  clipGainWaveform: true,
  insertMultiple: 'tracks', // 'tracks' | 'same'
  clipStretchMode: 'realtime', // mode for newly stretched clips: 'realtime' | 'rendered'
  // Playback and Recording
  returnToStartOn: 'first', // 'first' | 'second' stop
  scrollAfterReturn: false,
  stopAtSelectionEnd: true,
  scrollWave: 'page', // 'page' | 'center'
  scrollMulti: 'page',
  scrubAudio: false,
  shuttleSpeed: 1,
  meterCaution: -12,
  meterWarning: -3,
  prerollSeconds: 0,
  prerollCountdown: false,
  // Spectral Displays
  spectralGrid: false,
  spectralGridOpacity: 15, // percent
  spectralPlaySelected: false,
  pitchWindow: 0, // pitch contour analysis window in points; 0 = by sample rate
  pitchMinHz: 50,
  pitchMaxHz: 2000,
  // Time Display
  customFps: 12,
  beatNote: 4,
  subdivisions: 100,
  // Video
  videoZoom: 'fit',
  videoFullscreen: true, // double-click the Video panel for full screen
  videoTimecode: false,
  videoTcSize: 30, // percent
  videoTcOpacity: 65, // percent
  videoTcPosition: 'bc', // [t|m|b][l|c|r]
  videoTcReference: 'session', // 'session' | 'source'
  prefsCategory: 'general', // last page shown in Preferences
};

/** Keys left out of exported settings: they point at files on this device or account. */
export const LOCAL_ONLY_KEYS = new Set(['recent', 'exportFolder', 'mediaFolder', 'inputDevice', 'outputDevice']);

const SETTINGS_KIND = 'audio-studio-settings';

/** A JSON-able snapshot of every stored preference (shortcuts, favorites and workspaces included). */
export function exportSettings(prefs, now = new Date()) {
  const values = {};
  for (const [k, v] of Object.entries(prefs.values)) if (!LOCAL_ONLY_KEYS.has(k)) values[k] = v;
  return { kind: SETTINGS_KIND, version: 1, exported: now.toISOString(), prefs: values };
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Checks a parsed settings file. Returns { values, skipped } or throws an
 * Error with a message for the user. Keys with a known default must keep its
 * type (a null default accepts objects); unknown keys must look like ours.
 */
export function validateSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The file is not an Audio Studio settings file.');
  if (data.kind !== SETTINGS_KIND || typeof data.prefs !== 'object' || !data.prefs || Array.isArray(data.prefs)) throw new Error('The file is not an Audio Studio settings file.');
  if (Number(data.version) > 1) throw new Error('These settings were exported by a newer version of Audio Studio.');
  const values = {};
  const skipped = [];
  for (const [k, v] of Object.entries(data.prefs)) {
    if (!/^[A-Za-z][\w.-]{0,63}$/.test(k) || LOCAL_ONLY_KEYS.has(k) || v === undefined) {
      skipped.push(k);
      continue;
    }
    if (k in DEFAULTS) {
      const want = typeOf(DEFAULTS[k]);
      const got = typeOf(v);
      const ok = got === want || (want === 'null' && (got === 'object' || got === 'array')) || (got === 'null' && want === 'object') || (want === 'number' && got === 'number' && Number.isFinite(v));
      if (!ok || (got === 'number' && !Number.isFinite(v))) {
        skipped.push(k);
        continue;
      }
    }
    values[k] = v;
  }
  return { values, skipped };
}

// Renames keys, command IDs and panel IDs used by earlier versions.
function migrate(values) {
  for (const [from, to] of [['essentialPresets', 'soundAssistantPresets'], ['essentialCollapsed', 'soundAssistantCollapsed']]) {
    if (!(from in values)) continue;
    values[to] ??= values[from];
    delete values[from];
  }
  const shortcuts = values.shortcuts;
  if (shortcuts && 'window.essential' in shortcuts) {
    shortcuts['window.assistant'] ??= shortcuts['window.essential'];
    delete shortcuts['window.essential'];
  }
  const panel = (id) => (id === 'essential' ? 'assistant' : id);
  const walk = (node) => {
    if (node?.t === 'group') {
      if (Array.isArray(node.tabs)) node.tabs = node.tabs.map(panel);
      node.a = panel(node.a);
    } else if (Array.isArray(node?.c)) node.c.forEach(walk);
  };
  if (values.layouts && typeof values.layouts === 'object') Object.values(values.layouts).forEach(walk);
  return values;
}

export class Prefs extends Emitter {
  constructor(storage = globalThis.localStorage) {
    super();
    this.storage = storage;
    this.values = {};
    try {
      this.values = migrate(JSON.parse(storage?.getItem(KEY) || '{}') || {});
    } catch {
      this.values = {};
    }
  }

  get(key) {
    return key in this.values ? this.values[key] : structuredClone(DEFAULTS[key]);
  }

  set(key, value) {
    this.values[key] = value;
    this.#save();
    this.emit('change', key, value);
  }

  toggle(key) {
    this.set(key, !this.get(key));
  }

  /** Back to defaults: the given keys, or every key when none are given. */
  reset(keys) {
    const list = keys ? keys.filter((k) => k in this.values) : Object.keys(this.values);
    if (!list.length) return;
    for (const k of list) delete this.values[k];
    this.#save();
    for (const k of list) this.emit('change', k, this.get(k));
  }

  /** Replaces stored values with `values` (an imported settings file), keeping local-only keys. */
  replaceAll(values) {
    const before = Object.keys(this.values);
    const kept = Object.fromEntries(Object.entries(this.values).filter(([k]) => LOCAL_ONLY_KEYS.has(k)));
    this.values = migrate({ ...structuredClone(values), ...kept });
    this.#save();
    for (const k of new Set([...before, ...Object.keys(this.values)])) this.emit('change', k, this.get(k));
  }

  #save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.values));
    } catch {
      // Storage full or blocked: keep the values for this session.
    }
  }
}
