// Instrument editor windows (one per channel, key `channel:<id>`): a header
// with the channel name, color and preset browser; an Instrument page with
// the type's parameters grouped as in the catalog (knobs, waveform and
// option selectors, live envelope shapes, the sampler's waveform with start
// and end markers); a Channel page (volume, pan, pitch, root key, mixer
// insert, name, color); and a playable keyboard at the bottom.
//
// Every change goes through the store (continuous gestures are one undo
// step) and the window re-syncs from the store on any outside change (undo,
// automation, the rack), closing itself when its channel is deleted.

import { h, announce } from '../lib/dom.js';
import { clamp, formatDb, formatPan } from '../lib/util.js';
import * as E from '../model/edits.js';
import { COLORS, channelById } from '../model/project.js';
import { INSTRUMENTS, defaultParams } from '../instruments/catalog.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../instruments/presets.js';
import { createKnob } from '../ui/knob.js';
import { openWindow, getWindow } from '../ui/windows.js';
import { openMenu } from '../ui/menu.js';
import { icon } from '../ui/icons.js';
import { cssVar } from '../ui/theme.js';
import { dragHasPayload } from '../lib/dnd.js';
import { waveGlyph, waveGlyphName, createAdsrView } from './glyphs.js';
import { createKeyboard } from './keyboard.js';
import { channelActions } from './actions.js';

const VOLUME = { id: 'volume', label: 'Volume', min: 0, max: 1.25, def: 0.78 };
const PAN = { id: 'pan', label: 'Pan', min: -1, max: 1, def: 0 };
const PITCH = { id: 'pitch', label: 'Pitch', min: -1200, max: 1200, def: 0, step: 1, unit: 'ct' };
const ROOT = { id: 'root', label: 'Step key', min: 0, max: 127, def: 60, step: 1, unit: 'key' };

let lastTab = 'instrument';

/** Presets offered for an instrument type, "Init" first. */
export function presetsFor(type) {
  if (type === 'synth') return SYNTH_PRESETS;
  if (type === 'drum') return [{ name: 'Init', category: 'Basic', params: {} }, ...DRUM_PRESETS];
  return [{ name: 'Init', category: 'Basic', params: {} }];
}

/** The preset whose full parameter set equals `params`, or null ("Custom"). */
export function matchPreset(type, params) {
  const defs = defaultParams(type);
  for (const pr of presetsFor(type)) {
    const full = { ...defs, ...pr.params };
    if (Object.keys(full).every((k) => Math.abs((params[k] ?? defs[k]) - full[k]) < 1e-9)) return pr;
  }
  return null;
}

/** Opens (or raises) the editor window for a channel. */
export function openChannelEditor(app, id) {
  const ch = channelById(app.store.project, id);
  if (!ch) return null;
  const key = `channel:${id}`;
  const existing = getWindow(key);
  if (existing) {
    existing.raise();
    existing.focus();
    return existing;
  }
  const ed = new ChannelEditor(app, id);
  const win = openWindow({ key, title: ch.name, icon: INSTRUMENTS[ch.type]?.icon, body: ed.el, width: 600, toolbar: ed.toolbar, onClose: () => ed.destroy() });
  win.el.classList.add('ch-editor-win');
  ed.win = win;
  ed.afterOpen();
  return win;
}

class ChannelEditor {
  constructor(app, id) {
    this.app = app;
    this.store = app.store;
    this.id = id;
    this.ch = channelById(app.store.project, id);
    this.actions = channelActions(app);
    this.inst = [];
    this.chan = [];
    this.held = new Set();
    this.win = null;
    this.build();
    this.offs = [
      this.store.on('change', (p) => this.onChange(p)),
      app.samples?.on?.('change', (sid) => {
        if (sid === this.ch?.sample) this.drawWave();
      }),
    ].filter(Boolean);
    this.onTheme = () => this.drawWave();
    window.addEventListener('themechange', this.onTheme);
  }

  // ---------------------------------------------------------------- build

  build() {
    const ch = this.ch;
    // Window toolbar: preset browser.
    this.presetName = h('span.ed-preset-name');
    this.presetBtn = h('button.btn.sm.ed-preset', { type: 'button', 'aria-haspopup': 'menu', title: 'Choose a preset', onclick: () => this.openPresetMenu() }, this.presetName, icon('chevron-down', 12));
    const prev = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Previous preset', title: 'Previous preset', onclick: () => this.stepPreset(-1) }, icon('chevron-left', 14));
    const next = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Next preset', title: 'Next preset', onclick: () => this.stepPreset(1) }, icon('chevron-right', 14));
    this.toolbar = h('div.ed-toolbar', prev, this.presetBtn, next);

    // Header: color, name, type.
    this.colorBtn = h('button.ed-color', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Channel color', title: 'Channel color', onclick: (e) => this.openColorMenu(e.currentTarget) });
    this.nameInput = h('input.input.sm.ed-name', { type: 'text', 'aria-label': 'Channel name', maxlength: '60', spellcheck: false });
    this.nameInput.addEventListener('change', () => this.actions.setName(this.id, this.nameInput.value));
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
      if (e.key === 'Escape') {
        this.nameInput.value = this.ch.name;
        this.nameInput.blur();
        e.stopPropagation();
      }
    });
    this.typeBadge = h('span.ed-type');
    const head = h('div.ed-head', this.colorBtn, this.nameInput, this.typeBadge);

    // Tabs.
    this.tabs = {};
    const tab = (id, label) => {
      const b = h('button.ed-tab', { type: 'button', role: 'tab', id: `ed-tab-${this.id}-${id}`, 'aria-controls': `ed-page-${this.id}-${id}`, onclick: () => this.showTab(id) }, label);
      this.tabs[id] = b;
      return b;
    };
    const tablist = h('div.ed-tabs', { role: 'tablist', 'aria-label': 'Editor pages' }, tab('instrument', 'Instrument'), tab('channel', 'Channel'));
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const id = this.page === 'instrument' ? 'channel' : 'instrument';
      this.showTab(id);
      this.tabs[id].focus();
    });
    this.instPage = h('div.ed-page', { role: 'tabpanel', id: `ed-page-${this.id}-instrument`, 'aria-labelledby': `ed-tab-${this.id}-instrument` });
    this.chanPage = h('div.ed-page', { role: 'tabpanel', id: `ed-page-${this.id}-channel`, 'aria-labelledby': `ed-tab-${this.id}-channel` });

    // Keyboard.
    this.kb = createKeyboard({
      base: 48,
      label: `${ch.name} keyboard`,
      onNoteOn: (key, vel) => this.noteOn(key, vel),
      onNoteOff: (key) => this.noteOff(key),
    });

    this.el = h('div.ch-editor', head, tablist, h('div.ed-pages', this.instPage, this.chanPage), this.kb.el);
    this.el.addEventListener('keydown', (e) => this.onKey(e, true));
    this.el.addEventListener('keyup', (e) => this.onKey(e, false));
    this.el.addEventListener('focusout', (e) => {
      if (!this.el.closest('.float-win')?.contains(e.relatedTarget)) this.kb.releaseAll();
    });
    this.buildInstrument();
    this.buildChannel();
    this.syncHeader();
    this.showTab(lastTab);
  }

  afterOpen() {
    // The waveform needs layout to know its width.
    requestAnimationFrame(() => this.drawWave());
    this.opened = true;
    this.observeWave();
  }

  /** Redraws the waveform when its box resizes (the box is rebuilt with the instrument). */
  observeWave() {
    this.ro?.disconnect();
    if (!this.opened || !this.waveBox || typeof ResizeObserver === 'undefined') return;
    this.ro ||= new ResizeObserver(() => this.drawWave());
    this.ro.observe(this.waveBox);
  }

  showTab(id) {
    this.page = id;
    lastTab = id;
    for (const [k, b] of Object.entries(this.tabs)) {
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
    }
    this.instPage.hidden = id !== 'instrument';
    this.chanPage.hidden = id !== 'channel';
    if (id === 'instrument') requestAnimationFrame(() => this.drawWave());
  }

  /** Knob for an instrument parameter. */
  paramKnob(def, group) {
    const id = this.id;
    const k = createKnob({
      param: def,
      value: this.ch.params[def.id] ?? def.def,
      label: def.label,
      ariaLabel: `${group} ${def.label.toLowerCase()}`,
      size: 34,
      onStart: () => this.store.begin(`Change ${def.label.toLowerCase()}`),
      onInput: (v) => {
        this.store.preview((p) => E.setChannelParam(p, id, def.id, v));
        this.app.lastTweaked = { label: `${this.ch.name} ${group === def.label ? def.label : `${group} ${def.label}`}`.trim(), target: { kind: 'channel', id, param: def.id } };
      },
      onEnd: () => this.store.commit(),
    });
    k.el.classList.add('ed-knob');
    this.inst.push({ sync: (ch) => k.set(ch.params[def.id] ?? def.def) });
    return k.el;
  }

  /** Discrete choice: a switch for Off/On, a select for long lists, else a segmented radio group. */
  optionControl(def, group) {
    const id = this.id;
    const set = (v) => {
      if ((this.ch.params[def.id] ?? def.def) === v) return;
      this.store.apply(`Change ${def.label.toLowerCase()}`, (p) => E.setChannelParam(p, id, def.id, v));
      this.app.lastTweaked = { label: `${this.ch.name} ${def.label}`, target: { kind: 'channel', id, param: def.id } };
    };
    const value = () => Math.round(this.ch.params[def.id] ?? def.def);
    const opts = def.options;
    if (opts.length === 2 && opts[0] === 'Off' && opts[1] === 'On') {
      const sw = h('button.ed-switch', { type: 'button', role: 'switch', 'aria-label': `${group} ${def.label}`, onclick: () => set(value() ? 0 : 1) }, h('span.ed-switch-track', h('span.ed-switch-thumb')), h('span.ed-switch-label', def.label));
      const sync = () => sw.setAttribute('aria-checked', String(Boolean(value())));
      sync();
      this.inst.push({ sync });
      return h('div.ed-opt.ed-opt-switch', sw);
    }
    if (opts.length > 6) {
      const sel = h('select.select.sm', { 'aria-label': `${group} ${def.label}` }, ...opts.map((o, i) => h('option', { value: String(i) }, o)));
      sel.addEventListener('change', () => set(Number(sel.value)));
      const sync = () => {
        sel.value = String(value());
      };
      sync();
      this.inst.push({ sync });
      return h('label.ed-opt', h('span.ed-opt-label', def.label), sel);
    }
    const glyphs = opts.every((o) => waveGlyphName(o));
    const seg = h('div.seg.ed-seg', { role: 'radiogroup', 'aria-label': `${group} ${def.label}` });
    const btns = opts.map((o, i) => {
      const b = h('button', { type: 'button', role: 'radio', title: o, 'aria-label': o, onclick: () => set(i) }, glyphs ? waveGlyph(waveGlyphName(o)) : o);
      seg.append(b);
      return b;
    });
    seg.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const n = clamp(value() + d, 0, opts.length - 1);
      set(n);
      btns[n].focus();
    });
    const sync = () => {
      const v = value();
      btns.forEach((b, i) => {
        b.setAttribute('aria-checked', String(i === v));
        b.tabIndex = i === v ? 0 : -1;
      });
    };
    sync();
    this.inst.push({ sync });
    return h('div.ed-opt', h('span.ed-opt-label', def.label), seg);
  }

  buildInstrument() {
    this.inst = [];
    this.waveBox = null;
    const type = this.ch.type;
    const def = INSTRUMENTS[type];
    const groups = new Map();
    for (const p of def?.params || []) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    }
    const out = [];
    if (type === 'sampler' || type === 'audio') out.push(this.buildSample());
    for (const [name, params] of groups) {
      const body = h('div.ed-group-body');
      const env = envelopeOf(params);
      if (env) {
        const view = createAdsrView({ label: name });
        body.append(h('div.ed-adsr', view.el));
        const sync = (ch) => view.update({ attack: ch.params[env.attack] ?? 0, decay: ch.params[env.decay] ?? 0, sustain: ch.params[env.sustain] ?? 0, release: ch.params[env.release] ?? 0 });
        sync(this.ch);
        this.inst.push({ sync });
      }
      const knobs = h('div.ed-knobs');
      const opts = h('div.ed-opts');
      for (const p of params) {
        if (p.options) opts.append(this.optionControl(p, name));
        else knobs.append(this.paramKnob(p, name));
      }
      if (opts.childNodes.length) body.append(opts);
      if (knobs.childNodes.length) body.append(knobs);
      out.push(h(`section.ed-group${env ? '.ed-env' : ''}`, { 'aria-label': name }, h('h3.ed-group-title', name), body));
    }
    this.instPage.replaceChildren(h('div.ed-groups', out));
    this.builtType = type;
  }

  // ---------------------------------------------------------------- sampler

  buildSample() {
    this.waveCanvas = h('canvas.ed-wave-canvas', { 'aria-hidden': 'true' });
    this.waveEmpty = h('div.ed-wave-empty', icon('file-audio', 18), h('span', 'Drop an audio file here'));
    this.waveBox = h('div.ed-wave', { title: 'Drag the markers to set the start and end' }, this.waveCanvas, this.waveEmpty);
    this.sampleName = h('span.ed-sample-name');
    const load = h('button.btn.sm', { type: 'button', onclick: () => this.pickSample() }, icon('upload', 14), 'Load sample');
    this.loadBtn = load;
    const box = h('section.ed-group.ed-sample', { 'aria-label': 'Sample' }, h('div.ed-sample-bar', h('h3.ed-group-title', 'Sample'), this.sampleName, h('span.spacer'), load), this.waveBox);
    this.waveBox.addEventListener('pointerdown', (e) => this.dragMarker(e));
    box.addEventListener('dragover', (e) => {
      if (!dragHasPayload(e)) return;
      e.preventDefault();
      box.classList.add('drop');
    });
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget)) box.classList.remove('drop');
    });
    box.addEventListener('drop', (e) => {
      box.classList.remove('drop');
      const f = [...(e.dataTransfer?.files || [])].find((x) => /^audio\//.test(x.type) || /\.(wav|mp3|ogg|flac|aac|m4a|aiff?|webm|opus)$/i.test(x.name));
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      this.loadSample(f);
    });
    this.inst.push({ sync: () => this.syncSample() });
    this.syncSample();
    return box;
  }

  syncSample() {
    const ref = this.ch.sample ? this.store.project.samples[this.ch.sample] : null;
    if (this.sampleName) this.sampleName.textContent = ref ? ref.name : 'No sample loaded';
    if (this.loadBtn) this.loadBtn.disabled = !this.app.importAudio;
    if (this.loadBtn) this.loadBtn.title = this.app.importAudio ? 'Load an audio file from this device' : 'Audio import is not available yet';
    this.drawWave();
  }

  pickSample() {
    if (!this.app.importAudio) return;
    const input = h('input', { type: 'file', accept: 'audio/*', hidden: true });
    input.addEventListener('change', () => {
      if (input.files[0]) this.loadSample(input.files[0]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  /** Imports a file and assigns the sample to this channel (removing any channel the import created). */
  async loadSample(file) {
    const app = this.app;
    if (!app.importAudio) {
      app.notify('Audio import is not available yet.', { error: true });
      return;
    }
    try {
      const r = await app.importAudio(file, { name: String(file.name || 'Sample').replace(/\.[a-z0-9]+$/i, ''), as: 'sampler', channel: this.id });
      if (!r?.sampleId) return;
      this.store.apply('Load sample', (p) => {
        let next = E.updateChannel(p, this.id, { sample: r.sampleId });
        if (r.channelId && r.channelId !== this.id) next = E.removeChannels(next, [r.channelId]);
        return next;
      });
      announce('Sample loaded');
    } catch (err) {
      app.reportError(err);
    }
  }

  drawWave() {
    const cv = this.waveCanvas;
    if (!cv || !this.waveBox?.isConnected) return;
    const w = Math.round(this.waveBox.clientWidth);
    const hgt = Math.round(this.waveBox.clientHeight) || 72;
    if (!w) return;
    const data = this.ch.sample ? this.app.samples?.get(this.ch.sample) : null;
    this.waveEmpty.hidden = Boolean(data);
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (cv.width !== w * dpr || cv.height !== hgt * dpr) {
      cv.width = w * dpr;
      cv.height = hgt * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${hgt}px`;
    }
    let ctx = null;
    try {
      ctx = cv.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const start = this.ch.params.start ?? 0;
    const end = this.ch.params.end ?? 1;
    const mid = hgt / 2;
    ctx.fillStyle = cssVar('--grid-line');
    ctx.fillRect(0, Math.round(mid), w, 1);
    if (data?.peaks) {
      const { min, max } = data.peaks;
      const cols = min.length;
      ctx.fillStyle = this.ch.color;
      for (let x = 0; x < w; x++) {
        const c0 = Math.floor((x / w) * cols);
        const c1 = Math.max(c0 + 1, Math.floor(((x + 1) / w) * cols));
        let lo = 0;
        let hi = 0;
        for (let c = c0; c < c1 && c < cols; c++) {
          if (min[c] < lo) lo = min[c];
          if (max[c] > hi) hi = max[c];
        }
        const y0 = mid - hi * (mid - 2);
        const y1 = mid - lo * (mid - 2);
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    // Shade outside the play region, then the markers.
    ctx.fillStyle = cssVar('--scrim');
    ctx.fillRect(0, 0, start * w, hgt);
    ctx.fillRect(end * w, 0, w - end * w, hgt);
    ctx.fillStyle = cssVar('--accent');
    for (const [v, label] of [[start, 'S'], [end, 'E']]) {
      const x = clamp(Math.round(v * w), 1, w - 1);
      ctx.fillRect(x - 1, 0, 2, hgt);
      ctx.fillRect(label === 'S' ? x : x - 12, 0, 12, 12);
      ctx.fillStyle = cssVar('--accent-text');
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(label, label === 'S' ? x + 3 : x - 9, 9);
      ctx.fillStyle = cssVar('--accent');
    }
  }

  dragMarker(e) {
    if (e.button !== 0 || !this.waveBox) return;
    e.preventDefault();
    const r = this.waveBox.getBoundingClientRect();
    if (!r.width) return;
    const at = (x) => clamp((x - r.left) / r.width, 0, 1);
    const start = this.ch.params.start ?? 0;
    const end = this.ch.params.end ?? 1;
    const n = at(e.clientX);
    const which = Math.abs(n - start) <= Math.abs(n - end) ? 'start' : 'end';
    const id = this.id;
    this.store.begin(which === 'start' ? 'Sample start' : 'Sample end');
    const apply = (x) => {
      const other = which === 'start' ? end : start;
      const v = which === 'start' ? Math.min(at(x), other - 0.002) : Math.max(at(x), other + 0.002);
      this.store.preview((p) => E.setChannelParam(p, id, which, clamp(Math.round(v * 10000) / 10000, 0, 1)));
      this.app.lastTweaked = { label: `${this.ch.name} sample ${which}`, target: { kind: 'channel', id, param: which } };
    };
    apply(e.clientX);
    try {
      this.waveBox.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events.
    }
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      this.waveBox.removeEventListener('pointermove', move);
      this.waveBox.removeEventListener('pointerup', up);
      this.waveBox.removeEventListener('pointercancel', up);
      this.store.commit();
    };
    this.waveBox.addEventListener('pointermove', move);
    this.waveBox.addEventListener('pointerup', up);
    this.waveBox.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- channel page

  channelKnob(param, format, target = param.id) {
    const id = this.id;
    const k = createKnob({
      param,
      value: this.ch[param.id],
      label: param.label,
      ariaLabel: `Channel ${param.label.toLowerCase()}`,
      size: 38,
      format,
      onStart: () => this.store.begin(`Channel ${param.label.toLowerCase()}`),
      onInput: (v) => {
        this.store.preview((p) => E.updateChannel(p, id, { [param.id]: v }));
        if (target) this.app.lastTweaked = { label: `${this.ch.name} ${param.label.toLowerCase()}`, target: { kind: 'channel', id, param: target } };
      },
      onEnd: () => this.store.commit(),
    });
    k.el.classList.add('ed-knob');
    this.chan.push({ sync: (ch) => k.set(ch[param.id]) });
    return k.el;
  }

  buildChannel() {
    this.chan = [];
    const id = this.id;
    const knobs = h(
      'div.ed-knobs',
      this.channelKnob(VOLUME, formatDb),
      this.channelKnob(PAN, formatPan),
      this.channelKnob(PITCH, null),
      this.channelKnob(ROOT, null, null),
    );
    // Mixer insert.
    this.insertSel = h('select.select.sm', { 'aria-label': 'Mixer insert' });
    this.insertSel.addEventListener('change', () => this.actions.setInsert(id, Number(this.insertSel.value)));
    const free = h('button.btn.sm.ghost', { type: 'button', title: 'Route to the first insert no other channel uses', onclick: () => this.actions.assignFree([id]) }, 'Free insert');
    const syncInsert = (ch) => {
      const mixer = this.store.project.mixer;
      if (this.insertMixer !== mixer) {
        this.insertMixer = mixer;
        this.insertSel.replaceChildren(...mixer.map((t, i) => h('option', { value: String(i) }, i === 0 ? 'Master' : `${i}. ${t.name}`)));
      }
      this.insertSel.value = String(ch.mixer);
    };
    syncInsert(this.ch);
    this.chan.push({ sync: syncInsert });
    // Name.
    this.nameInput2 = h('input.input.sm', { type: 'text', maxlength: '60', 'aria-label': 'Name', spellcheck: false });
    this.nameInput2.addEventListener('change', () => this.actions.setName(id, this.nameInput2.value));
    // Colors.
    this.swatches = h('div.ed-swatches', { role: 'radiogroup', 'aria-label': 'Color' });
    const sw = COLORS.map((c, i) => {
      const b = h('button.ed-swatch', { type: 'button', role: 'radio', 'aria-label': `Color ${i + 1}`, style: { background: c }, onclick: () => this.actions.setColor([id], c) });
      this.swatches.append(b);
      return b;
    });
    this.swatches.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const i = (Math.max(0, COLORS.indexOf(this.ch.color)) + d + COLORS.length) % COLORS.length;
      this.actions.setColor([id], COLORS[i]);
      sw[i].focus();
    });
    const syncColor = (ch) => {
      const at = COLORS.indexOf(ch.color);
      sw.forEach((b, i) => {
        b.setAttribute('aria-checked', String(i === at));
        b.tabIndex = i === (at < 0 ? 0 : at) ? 0 : -1;
      });
    };
    syncColor(this.ch);
    this.chan.push({ sync: syncColor });
    this.chanPage.replaceChildren(
      h(
        'div.ed-groups',
        h('section.ed-group', { 'aria-label': 'Levels' }, h('h3.ed-group-title', 'Levels and tuning'), h('div.ed-group-body', knobs)),
        h(
          'section.ed-group',
          { 'aria-label': 'Routing and appearance' },
          h('h3.ed-group-title', 'Routing'),
          h('div.ed-form', h('label.ed-field', h('span', 'Mixer insert'), h('div.ed-row', this.insertSel, free)), h('label.ed-field', h('span', 'Name'), this.nameInput2), h('div.ed-field', h('span', 'Color'), this.swatches)),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- header and presets

  syncHeader() {
    const ch = this.ch;
    if (document.activeElement !== this.nameInput) this.nameInput.value = ch.name;
    if (this.nameInput2 && document.activeElement !== this.nameInput2) this.nameInput2.value = ch.name;
    this.colorBtn.style.background = ch.color;
    this.el.style.setProperty('--ch', ch.color);
    this.typeBadge.textContent = INSTRUMENTS[ch.type]?.label || ch.type;
    const pr = matchPreset(ch.type, ch.params);
    this.presetName.textContent = pr ? pr.name : 'Custom';
    this.presetBtn.setAttribute('aria-label', `Preset: ${pr ? pr.name : 'Custom'}. Choose a preset`);
  }

  openColorMenu(anchor) {
    openMenu(
      COLORS.map((c, i) => ({ type: 'radio', label: `Color ${i + 1}`, swatch: c, checked: this.ch.color === c, run: () => this.actions.setColor([this.id], c) })),
      { anchor, label: 'Channel color' },
    );
  }

  openPresetMenu() {
    const type = this.ch.type;
    const cur = matchPreset(type, this.ch.params);
    const items = [];
    let cat = null;
    for (const pr of presetsFor(type)) {
      if (pr.category !== cat) {
        cat = pr.category;
        items.push({ type: 'heading', label: cat });
      }
      items.push({ type: 'radio', label: pr.name, checked: cur === pr, run: () => this.loadPreset(pr) });
    }
    openMenu(items, { anchor: this.presetBtn, label: 'Presets' });
  }

  stepPreset(d) {
    const list = presetsFor(this.ch.type);
    const cur = matchPreset(this.ch.type, this.ch.params);
    const i = cur ? list.indexOf(cur) : d > 0 ? -1 : 0;
    this.loadPreset(list[(i + d + list.length) % list.length]);
  }

  loadPreset(pr) {
    const ch = this.ch;
    const type = ch.type;
    const params = { ...defaultParams(type), ...pr.params };
    // A channel still named after its preset (or its instrument) takes the new preset's name.
    const old = matchPreset(type, ch.params);
    const rename = pr.name !== 'Init' && (ch.name === INSTRUMENTS[type]?.label || (old && ch.name === old.name));
    this.store.apply(`Load preset ${pr.name}`, (p) => {
      let next = E.updateChannel(p, this.id, { params });
      if (rename) next = E.updateChannel(next, this.id, { name: pr.name });
      return next;
    });
    announce(`Preset ${pr.name}`);
  }

  // ---------------------------------------------------------------- sound

  noteOn(key, vel) {
    const engine = this.app.engine;
    this.held.add(key);
    if (engine.ready) engine.noteOn(this.id, key, vel);
    else
      Promise.resolve(engine.start())
        .then(() => {
          if (this.held.has(key)) engine.noteOn(this.id, key, vel);
        })
        .catch((err) => this.app.reportError(err));
  }

  noteOff(key) {
    this.held.delete(key);
    this.app.engine.noteOff(this.id, key);
  }

  onKey(e, down) {
    if (e.target.closest('input, select, textarea')) return;
    if (this.kb.handleKey(e, down)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------- sync

  onChange(p) {
    const ch = channelById(p, this.id);
    if (!ch) {
      this.win?.close();
      return;
    }
    if (ch === this.ch && p.mixer === this.insertMixer) return;
    const prev = this.ch;
    this.ch = ch;
    if (ch.type !== this.builtType) {
      this.buildInstrument();
      this.observeWave();
      requestAnimationFrame(() => this.drawWave());
    } else if (ch !== prev) for (const c of this.inst) c.sync(ch);
    for (const c of this.chan) c.sync(ch);
    if (ch.name !== prev.name) this.win?.setTitle(ch.name);
    this.syncHeader();
  }

  destroy() {
    for (const off of this.offs) off();
    this.offs = [];
    window.removeEventListener('themechange', this.onTheme);
    this.ro?.disconnect();
    this.kb.releaseAll();
  }
}

/** The attack/decay/sustain/release param ids of a group, if it is an envelope. */
function envelopeOf(params) {
  const find = (suffix) => params.find((p) => p.id.endsWith(`_${suffix}`))?.id;
  const env = { attack: find('attack'), decay: find('decay'), sustain: find('sustain'), release: find('release') };
  return env.attack && env.decay && env.sustain && env.release ? env : null;
}
