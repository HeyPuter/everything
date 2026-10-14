// The application: owns the document store, the audio engine, commands,
// preferences and the shell, and wires keyboard shortcuts, the animation
// frame loop and the status bar hints.
//
// Feature modules are installed from main.js: each exports install(app) and
// registers panels, commands and menu items.
//
// Hooks that feature modules provide on the app (absent until installed, so
// callers check before use):
//   app.openChannelEditor(channelId)            channel rack: instrument editor window
//   app.openEffectEditor(track, slotId)         mixer: effect editor window
//   app.importAudio(blob, { name, path, as })   storage: decodes audio, adds the sample
//                                               and a channel ('sampler' | 'audio'),
//                                               resolves { sampleId, channelId, duration }
//   app.emitKeyboardNote(keyEvent, down)        piano roll: typing keyboard to piano;
//                                               returns true when the key played a note
//   app.recentMenuItems(), app.effectMenuItems() menu providers (storage, mixer)
//   app.lastTweaked = { label, target }          set by editors when a parameter moves;
//                                               target uses the automation target shape

import { Emitter } from './lib/emitter.js';
import { h } from './lib/dom.js';
import { Prefs } from './lib/prefs.js';
import { Store } from './model/store.js';
import { newProject } from './model/demo.js';
import * as E from './model/edits.js';
import { createChannel, colorAt } from './model/project.js';
import { Engine } from './engine/engine.js';
import { SampleCache } from './audio/samples.js';
import { Commands, eventCombo, isTyping } from './commands/registry.js';
import { registerCoreCommands } from './commands/core.js';
import { Shell } from './ui/shell.js';
import { createToolbar } from './ui/toolbar.js';
import { applyTheme } from './ui/theme.js';
import { toast } from './ui/toast.js';
import { openMenu, isMenuOpen } from './ui/menu.js';
import { confirmDialog } from './ui/dialog.js';
import { icon } from './ui/icons.js';

// Browser shortcuts the app reuses (see installKeyboard).
const BROWSER_KEYS = new Set(['F5', 'Mod+R', 'Mod+Shift+R', 'Mod+S', 'Mod+Shift+S', 'Mod+O', 'Mod+P']);

export class App extends Emitter {
  constructor(root, { project, storage } = {}) {
    super();
    this.root = root;
    this.prefs = new Prefs(storage);
    this.store = new Store(project || newProject());
    this.engine = new Engine(this.store, this.prefs);
    this.samples = new SampleCache(this.engine);
    this.commands = new Commands(this);
    this.activePanel = 'playlist';
    this.file = null; // { path?: Puter path, local?: IndexedDB key, name }
    this.saving = false;
    this.tools = { playlist: 'draw', pianoRoll: 'draw' };
    /** The last parameter the user changed, for "automate last tweaked". */
    this.lastTweaked = null;
  }

  /** Builds the UI. Feature modules (`features`) install after the core. */
  start(features = []) {
    applyTheme(this.prefs.get('theme'));
    this.root.classList.add('app');
    this.shell = new Shell(this, this.root);
    registerCoreCommands(this);
    for (const f of features) f.install?.(this);
    this.toolbar = createToolbar(this);
    this.buildStatusbar();
    this.shell.layout();
    this.installKeyboard();
    this.installHints();
    this.loop();
    this.engine.on('error', (err) => this.reportError(err));
    this.emit('started');
    return this;
  }

  // ---------------------------------------------------------------- panels

  registerPanel(def) {
    return this.shell.registerPanel(def);
  }

  setActivePanel(id) {
    if (this.activePanel === id) return;
    this.activePanel = id;
    for (const [pid, p] of this.shell.panels) p.host.classList.toggle('active', pid === id);
    this.emit('activepanel', id);
  }

  panel(id) {
    return this.shell.panels.get(id)?.impl || null;
  }

  // ---------------------------------------------------------------- actions

  setMode(mode) {
    this.engine.mode = mode;
  }

  setTempo(bpm, label = 'Change tempo') {
    this.store.apply(label, (p) => E.setProjectProps(p, { bpm }));
  }

  /** Adds a channel to the rack on the next free mixer insert and selects it. `index` places it (default: last). */
  addChannel({ type = 'synth', name, params, sample = null, select = true, index } = {}) {
    const p = this.store.project;
    const usedInserts = new Set(p.channels.map((c) => c.mixer));
    let insert = 1;
    while (usedInserts.has(insert) && insert < p.mixer.length - 1) insert++;
    if (usedInserts.has(insert)) insert = 0;
    const ch = createChannel({ type, name, params, sample, color: colorAt(p.channels.length), mixer: insert });
    this.store.apply(`Add ${name || 'channel'}`, (proj) => {
      let next = E.addChannel(proj, ch, index ?? proj.channels.length);
      if (insert > 0) next = E.updateMixerTrack(next, insert, { name: ch.name, color: ch.color });
      return next;
    });
    if (select) this.store.selectChannels([ch.id]);
    this.notify(`Added ${ch.name}`);
    return ch.id;
  }

  /** Replaces the project after asking about unsaved changes. `make` builds the new project. */
  async newProject(make) {
    if (this.store.dirty && !(await confirmDialog({ title: 'New project', message: 'Discard the changes to the current project?', confirm: 'Discard', danger: true }))) return false;
    this.engine.stop();
    this.store.load(make());
    this.file = null;
    this.emit('file');
    return true;
  }

  // ---------------------------------------------------------------- feedback

  notify(message, opts) {
    if (!message) return null;
    return toast(message, opts);
  }

  reportError(err) {
    console.error(err);
    this.notify(err?.message || String(err), { error: true });
  }

  openMenu(items, opts) {
    return openMenu(items, opts);
  }

  /** Shows a hint in the status bar (hover help). */
  hint(text) {
    if (this.hintEl && this.hintEl.textContent !== text) this.hintEl.textContent = text || '';
  }

  // ---------------------------------------------------------------- internals

  buildStatusbar() {
    this.hintEl = h('span.status-hint', { 'aria-hidden': 'true' });
    const cloud = h('span.status-cloud');
    const syncCloud = () => {
      const signedIn = Boolean(window.puter?.auth?.isSignedIn?.());
      cloud.replaceChildren(icon(signedIn ? 'cloud' : 'hard-drive', 12), h('span', signedIn ? 'Cloud storage on' : 'Working on this device'));
      cloud.title = signedIn ? 'Projects save to your Puter cloud' : 'Sign in to save projects to your Puter cloud';
    };
    this.on('account', syncCloud);
    syncCloud();
    this.shell.statusbar.append(this.hintEl, h('span.status-spacer'), cloud, h('span.status-badge', { title: 'This app is an early alpha' }, 'Alpha'));
  }

  installHints() {
    let last = null;
    this.root.addEventListener('pointerover', (e) => {
      const t = e.target.closest?.('[data-hint], [title], [aria-label]');
      if (t === last) return;
      last = t;
      this.hint(t ? t.dataset.hint || t.getAttribute('title') || t.getAttribute('aria-label') || '' : '');
    });
  }

  installKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('.dialog-backdrop') || isMenuOpen() || isTyping(e.target)) {
        // App shortcuts that the browser would turn into a reload, save page,
        // open or print do nothing here instead (a reload loses a running export).
        const c = eventCombo(e);
        if (BROWSER_KEYS.has(c) && this.commands.lookup(c, this.activePanel)) e.preventDefault();
        return;
      }
      // Typing keyboard to piano takes plain letter keys first.
      if (this.prefs.get('typingKeyboard') && !e.ctrlKey && !e.metaKey && !e.altKey && this.emitKeyboardNote?.(e, true)) {
        e.preventDefault();
        return;
      }
      const combo = eventCombo(e);
      if (!combo) return;
      // Keys a focused control handles itself (Space on buttons, arrows on sliders).
      const t = e.target;
      if ((combo === 'Space' || combo === 'Enter') && t?.matches?.('button, [role="button"], [role="menuitem"], a, [role="radio"], [role="checkbox"], [role="tab"], [role="option"]')) {
        if (combo === 'Enter' || !t.closest('.panel-body')) return;
      }
      if (/^(Arrow|Page|Home|End)/.test(combo) && t?.matches?.('[role="slider"], [role="spinbutton"], [role="separator"], [role="listbox"], [role="grid"], [role="tree"], [role="radiogroup"] *, [role="tablist"] *')) return;
      const cmd = this.commands.lookup(combo, this.activePanel);
      if (!cmd) return;
      if (combo === 'Escape' && !this.commands.enabled(cmd.id)) return;
      e.preventDefault();
      this.commands.run(cmd.id);
    });
    document.addEventListener('keyup', (e) => {
      if (this.prefs.get('typingKeyboard')) this.emitKeyboardNote?.(e, false);
    });
    // F10 focuses the menu bar, like desktop apps.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F10' && !e.shiftKey && !isTyping(e.target)) {
        e.preventDefault();
        this.toolbar.menubar.focus();
      }
    });
  }

  loop() {
    const tick = () => {
      this.emit('frame');
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
