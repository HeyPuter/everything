// Application state and wiring. Feature modules (src/features.js) register
// commands, panels, document kinds and menu providers on this object.

import { Emitter } from './lib/emitter.js';
import { Prefs } from './lib/prefs.js';
import { CommandRegistry } from './commands/registry.js';
import { engine, sourceKey } from './engine/engine.js';
import { applyTheme } from './ui/theme.js';
import { toast } from './ui/toast.js';
import { openMenu } from './ui/menubar.js';
import { WORKSPACES, TABLET, PHONE, DEFAULT_WORKSPACE, LAYOUT_VERSION } from './ui/workspaces.js';
import { saveChangesDialog } from './ui/dialog.js';
import { formatTime, beatSeconds } from './lib/time.js';

export class App extends Emitter {
  constructor() {
    super();
    this.prefs = new Prefs();
    this.commands = new CommandRegistry(this);
    this.engine = engine;
    this.documents = [];
    this.active = null;
    this.tool = 'time';
    /** Tools usable in the Waveform editor (see toolAvailable). */
    this.waveformTools = new Set(['time']);
    /** Tool availability providers, consulted in order: (id, app) => boolean. */
    this.toolProviders = this.toolProviders || [];
    /** Five clipboards, like a pro audio editor; each holds { sampleRate, channels } or a clip set. */
    this.clipboards = [null, null, null, null, null];
    this.clipboardIndex = 0;
    this.panels = new Map();
    this.documentKinds = new Map(); // kind -> { view: (app, doc) => view, graph: (app, doc) => {graph, sources} }
    this.previewFx = null; // effect slot specs previewed by an open effect dialog
    this.dock = null;
    this.lastCommand = null;
    this.layoutMode = 'desktop';
    this.statusMessage = '';
    applyTheme(this.prefs.get('theme'));
    this.#migrateLayouts();
    this.pendingReturn = null; // second-stop mode: where the next Stop returns to
    this.prefs.on('change', (key) => {
      if (key === 'theme') applyTheme(this.prefs.get('theme'));
      if (key === 'historyLimit') for (const d of this.documents) if (d.history) d.history.limit = Math.max(10, Number(this.prefs.get('historyLimit')) || 200);
      this.emit('prefs', key);
    });
    engine.on('state', (s) => this.emit('transport', s));
    engine.on('ended', (frame) => this.#onEnded(frame));
  }

  // --------------------------------------------------------------- registry

  registerPanel(def) {
    this.panels.set(def.id, def);
  }

  registerDocumentKind(kind, def) {
    this.documentKinds.set(kind, def);
  }

  /**
   * Whether a tool applies in the active editor: listed by the document kind
   * (registerDocumentKind(kind, { tools }); app.waveformTools for audio files),
   * or enabled by a provider (e.g. the spectral tools while the spectral display is on).
   */
  toolAvailable(id) {
    if (id === 'time') return true;
    const doc = this.active;
    const tools = doc ? this.documentKinds.get(doc.kind)?.tools || (doc.kind === 'audio' ? this.waveformTools : null) : null;
    if (tools && (Array.isArray(tools) ? tools.includes(id) : tools.has(id))) return true;
    return this.toolProviders.some((p) => p(id, this));
  }

  // -------------------------------------------------------------- documents

  addDocument(doc, { activate = true } = {}) {
    if (doc.history) doc.history.limit = Math.max(10, Number(this.prefs.get('historyLimit')) || 200);
    this.documents.push(doc);
    doc.on('change', (e) => this.#onDocChange(doc, e));
    this.emit('documents');
    if (activate) this.activate(doc);
    return doc;
  }

  activate(doc) {
    if (this.active === doc) return;
    if (engine.playing) this.stop();
    this.active = doc;
    this.previewFx = null;
    this.pendingReturn = null;
    this.emit('active', doc);
    this.emit('documents');
    this.syncGraph();
    if (doc && this.dock && !this.dock.isVisible('editor')) this.dock.openPanel('editor', { focus: false });
  }

  async closeDocument(doc, { force = false } = {}) {
    if (!doc) return true;
    if (!force && doc.dirty) {
      this.activate(doc);
      const answer = await saveChangesDialog(doc.name);
      if (answer === null) return false;
      if (answer === 'save') {
        const ok = await this.commands.run('file.save');
        if (!ok && doc.dirty) return false;
      }
    }
    if (this.active === doc && engine.playing) this.stop();
    const i = this.documents.indexOf(doc);
    if (i >= 0) this.documents.splice(i, 1);
    doc.emit('close');
    this.emit('documents');
    if (this.active === doc) {
      this.active = null;
      this.activate(this.documents[Math.min(i, this.documents.length - 1)] || null);
      if (!this.active) {
        this.emit('active', null);
        this.syncGraph();
      }
    }
    // The focused editor surface went away with the document: keep keyboard
    // focus in the editor (the next file, or the empty state's first button).
    setTimeout(() => {
      const f = document.activeElement;
      if (f && f !== document.body && f.isConnected) return;
      (this.focusTarget() || document.querySelector('[data-panel="editor"] button'))?.focus({ preventScroll: true });
    }, 0);
    return true;
  }

  #onDocChange(doc, e) {
    this.emit('doc-change', doc, e);
    if (doc !== this.active) return;
    if (e.kind === 'edit' || e.kind === 'history' || e.kind === 'graph') this.syncGraph();
    if (e.kind === 'selection' && engine.playing && this.loop) this.#updateLoop();
  }

  /** Unique default name like "Untitled 2". */
  uniqueName(base, ext = '') {
    const names = new Set(this.documents.map((d) => d.name));
    if (!names.has(base + ext)) return base + ext;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}${ext}`)) return `${base} ${i}${ext}`;
  }

  // --------------------------------------------------------------- playback

  /** Rebuilds the engine graph for the active document. */
  syncGraph() {
    const doc = this.active;
    if (!doc) {
      engine.setGraph({ rate: engine.rate, tracks: [], master: { gain: 1 } }, new Map());
      return;
    }
    const kind = this.documentKinds.get(doc.kind);
    const { graph, sources } = kind?.graph ? kind.graph(this, doc) : audioFileGraph(this, doc);
    engine.setGraph(graph, sources);
  }

  get loop() {
    return Boolean(this.prefs.get('loop'));
  }

  /**
   * Where loop playback wraps without a selection: the end of the content, or
   * for sessions with "loop at the end of the last clip" off, the end of the
   * bar that clip ends in.
   */
  loopEnd(doc = this.active) {
    const len = doc?.length ?? 0;
    if (doc?.kind !== 'session' || this.prefs.get('loopToLastClip') !== false || !len) return len;
    const music = this.timeOptions();
    const bar = beatSeconds({ ...music, tempo: doc.state.tempo || music.tempo }) * (doc.state.beatsPerBar || music.beatsPerBar) * doc.sampleRate;
    return bar > 0 ? Math.ceil(len / bar - 1e-9) * bar : len;
  }

  /** The loop range for the document: its selection, else the whole content. */
  loopRange(doc = this.active) {
    if (!doc) return null;
    const sel = doc.selection;
    if (sel && sel.end > sel.start) return { start: sel.start, end: sel.end };
    return { start: 0, end: Math.max(1, Math.round(this.loopEnd(doc))) };
  }

  /** Play from the playhead; within a selection, stop (or loop) at its end. */
  async play({ from, to, loop } = {}) {
    const doc = this.active;
    if (!doc) return;
    // Real playback ends any scrubbing: its pending stop must not cut this off.
    this.endScrub();
    try {
      const sel = doc.selection;
      const len = doc.length;
      let start = from ?? doc.cursor;
      let end = to ?? null;
      const hasSel = sel && sel.end > sel.start;
      if (hasSel && end === null && start >= sel.start && start < sel.end && this.prefs.get('stopAtSelectionEnd') !== false) end = sel.end;
      if (start >= len && !hasSel) start = 0;
      const doLoop = loop ?? this.loop;
      const loopRange = doLoop ? this.loopRange(doc) : null;
      if (loopRange && !hasSel) end = Math.max(end ?? 0, loopRange.end);
      this.pendingReturn = null;
      this.playStart = start;
      await engine.play({ from: start, to: end ?? len, loop: loopRange });
      this.emit('transport', 'playing');
    } catch (err) {
      console.error(err);
      this.notify('Playback is not available in this browser.', { error: true });
    }
  }

  stop() {
    if (!engine.playing && this.pendingReturn != null) {
      // Second stop: back to where playback started.
      this.#returnTo(this.pendingReturn);
      return;
    }
    this.#stopped(engine.stop());
  }

  /** True when Stop would move the playhead back to the start (second-stop mode). */
  get canReturn() {
    return !engine.playing && this.pendingReturn != null && this.active != null;
  }

  togglePlay() {
    if (engine.playing) this.stop();
    else this.play();
  }

  #onEnded(frame) {
    if (this.scrubbing) return; // a scrub snippet ended: the playhead stays where it was dragged
    this.#stopped(frame);
  }

  /**
   * Plays a short snippet at `frame` while the playhead is dragged in the
   * time ruler (Preferences > Playback and Recording > play audio while
   * scrubbing). Does nothing during normal playback.
   */
  async scrub(frame) {
    if (!this.prefs.get('scrubAudio') || !this.active || (engine.playing && !this.scrubbing)) return;
    const now = performance.now();
    if (now - (this.lastScrub || 0) < 45) return;
    this.lastScrub = now;
    this.scrubbing = true;
    clearTimeout(this.scrubTimer);
    const len = Math.round(this.active.sampleRate * 0.07);
    try {
      await engine.play({ from: Math.max(0, Math.round(frame)), to: Math.round(frame) + len, loop: null });
    } catch {
      // No audio output: scrubbing stays silent.
    }
    const token = (this.scrubToken = (this.scrubToken || 0) + 1);
    this.scrubTimer = setTimeout(() => {
      if (!this.scrubbing || token !== this.scrubToken) return;
      this.scrubbing = false;
      if (engine.playing) engine.stop();
    }, 160);
  }

  /** Forgets any scrub in progress (its snippet and its delayed stop). */
  endScrub() {
    clearTimeout(this.scrubTimer);
    this.scrubToken = (this.scrubToken || 0) + 1;
    this.scrubbing = false;
  }

  /** Places the playhead after playback stops, honouring Preferences > Playback and Recording. */
  #stopped(at) {
    const doc = this.active;
    const from = this.playStart;
    this.playStart = null;
    this.pendingReturn = null;
    if (doc) {
      const back = this.prefs.get('returnToStart') && from != null;
      if (back && this.prefs.get('returnToStartOn') === 'second') {
        doc.setCursor(at);
        this.pendingReturn = from;
      } else if (back) this.#returnTo(from, { emit: false });
      else doc.setCursor(at);
    }
    this.emit('transport', 'stopped');
  }

  #returnTo(frame, { emit = true } = {}) {
    const doc = this.active;
    this.pendingReturn = null;
    if (!doc) return;
    doc.setCursor(frame);
    if (this.prefs.get('scrollAfterReturn')) {
      const v = doc.view;
      const span = v.end - v.start;
      if (frame < v.start || frame > v.end) doc.setView(frame - span * 0.1, frame - span * 0.1 + span);
    }
    if (emit) this.emit('transport', 'stopped');
  }

  /** Loop playback follows the selection; without one it loops the whole content, as when it starts. */
  #updateLoop() {
    if (this.active) engine.setLoop(this.loopRange(this.active));
  }

  /** Time Display preferences as the `music` options of lib/time.js. */
  timeOptions() {
    const p = this.prefs;
    return { tempo: p.get('tempo'), beatsPerBar: p.get('beatsPerBar'), beatNote: p.get('beatNote'), subdivisions: p.get('subdivisions'), fps: p.get('customFps') };
  }

  /** Playhead in document frames: live while playing, else the cursor. */
  get playhead() {
    if (engine.playing) return engine.position;
    return this.active?.cursor ?? 0;
  }

  // ---------------------------------------------------------- notifications

  notify(message, opts) {
    return toast(message, opts);
  }

  setStatus(message) {
    this.statusMessage = message;
    this.emit('status', message);
  }

  openMenu(items, opts) {
    return openMenu(this, items, opts);
  }

  /** Element that should hold focus after menu commands (the editor surface). */
  focusTarget() {
    return document.querySelector('[data-panel="editor"] .editor-surface') || null;
  }

  formatTime(frames, rate = this.active?.sampleRate || 48000) {
    return formatTime(frames, rate, this.prefs.get('timeFormat'), this.timeOptions());
  }

  // ------------------------------------------------------------- workspaces

  get clipboard() {
    return this.clipboards[this.clipboardIndex];
  }

  set clipboard(value) {
    this.clipboards[this.clipboardIndex] = value;
    this.emit('clipboard');
  }

  /** Layout for the current screen size and chosen workspace. */
  currentLayout() {
    if (this.layoutMode === 'phone') return PHONE();
    if (this.layoutMode === 'tablet') return TABLET();
    const name = this.prefs.get('workspace');
    // A layout tree from storage; damaged ones (old versions, edited settings files) are skipped.
    const valid = (n) => Boolean(n && typeof n === 'object' && (n.t === 'group' ? Array.isArray(n.tabs) : Array.isArray(n.c)));
    const saved = this.prefs.get('layouts')?.[name];
    if (valid(saved)) return saved;
    // Then the layout saved with "Save Changes", a custom workspace as created, or the built-in one.
    const kept = [this.prefs.get('savedLayouts')?.[name], this.prefs.get('customWorkspaces')?.[name]].find(valid);
    if (kept) return structuredClone(kept);
    return (WORKSPACES[name] || WORKSPACES[DEFAULT_WORKSPACE])();
  }

  /** Forgets panel arrangements made on top of an older version of the built-in workspaces. */
  #migrateLayouts() {
    if (this.prefs.get('layoutVersion') === LAYOUT_VERSION) return;
    const layouts = { ...(this.prefs.get('layouts') || {}) };
    const stale = Object.keys(layouts).filter((name) => WORKSPACES[name] && !this.prefs.get('savedLayouts')?.[name]);
    for (const name of stale) delete layouts[name];
    if (stale.length) this.prefs.set('layouts', layouts);
    if (!WORKSPACES[this.prefs.get('workspace')] && !this.prefs.get('customWorkspaces')?.[this.prefs.get('workspace')]) this.prefs.set('workspace', DEFAULT_WORKSPACE);
    this.prefs.set('layoutVersion', LAYOUT_VERSION);
  }

  setWorkspace(name, { reset = false } = {}) {
    if (reset) {
      const layouts = { ...this.prefs.get('layouts') };
      delete layouts[name];
      this.prefs.set('layouts', layouts);
    }
    this.prefs.set('workspace', name);
    this.dock?.setLayout(this.currentLayout());
    this.emit('workspace', name);
  }

  saveLayout() {
    if (this.layoutMode !== 'desktop' || !this.dock) return;
    const name = this.prefs.get('workspace');
    this.prefs.set('layouts', { ...this.prefs.get('layouts'), [name]: this.dock.layout() });
  }

  workspaceNames() {
    const custom = Object.keys(this.prefs.get('customWorkspaces') || {});
    return [...Object.keys(WORKSPACES), ...custom.filter((n) => !WORKSPACES[n])];
  }
}

/** Playback graph for an audio file: one track playing the whole file. */
export function audioFileGraph(app, doc) {
  const channels = doc.state.channels;
  const key = sourceKey(channels);
  const sources = new Map([[key, channels]]);
  const clip = { id: 'file', source: key, channels: channels.length, start: 0, offset: 0, length: doc.length, gain: 1, fadeIn: 0, fadeOut: 0 };
  const track = { id: 'file', gain: 1, pan: 0, mute: false, solo: false, clips: doc.length ? [clip] : [], fx: app.previewFx || [] };
  const graph = { rate: doc.sampleRate, tracks: [track], master: { gain: 1 } };
  app.extendFileGraph?.(graph, doc); // Effects Rack slots follow the preview slots
  for (const hook of app.fileGraphHooks || []) hook(graph, doc);
  return { graph, sources };
}
