// Mixer panel: a channel strip per audio and bus track plus the master, with
// polarity and routing, the effects chain, sends to buses (one shown at a
// time, picked from a list of eight), the track EQ, pan, automation mode,
// mute/solo/arm/monitor, a dB fader and a peak meter with hold. Strips scroll
// horizontally; the master stays put. A gutter on the left collapses the
// routing, effects, sends and EQ sections of every strip at once.
// Parameter changes go through the session's TrackControls (undo and
// automation writing behave as in the track headers).

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { knob, hotNumber } from '../ui/controls.js';
import { getEffect } from '../effects/registry.js';
import { allTracks, wouldCycle, SILENT_DB, MAX_DB, AUTOMATION_MODES } from '../model/session-edits.js';
import { SendControls, EqControls, toggleTrackEffect } from '../multitrack/send-eq.js';
import { dbToFader, faderToDb, formatGain, formatGainShort, formatPan, parseGain } from '../multitrack/levels.js';
import { MeterBar, METER_RANGE } from '../multitrack/meter.js';

const SCALE = [15, 10, 5, 0, -5, -10, -20, -30, -40, -60];

/** Vertical dB fader (role=slider). */
export function fader({ value, label, onInput, onChange }) {
  let current = value;
  const thumb = h('div.mx-thumb', { 'aria-hidden': 'true' });
  const track = h('div.mx-fader-track', h('div.mx-fader-groove'), thumb);
  const el = h('div.mx-fader', { role: 'slider', tabindex: '0', 'aria-label': label, 'aria-orientation': 'vertical', 'aria-valuemin': String(SILENT_DB), 'aria-valuemax': String(MAX_DB) }, track);
  const show = () => {
    const p = dbToFader(current);
    thumb.style.bottom = `calc(${(p * 100).toFixed(2)}% - ${(p * 18).toFixed(1)}px)`;
    el.setAttribute('aria-valuenow', String(Math.round(current * 10) / 10));
    el.setAttribute('aria-valuetext', formatGain(current));
  };
  const set = (v, commit) => {
    v = Math.max(SILENT_DB, Math.min(MAX_DB, Math.round(v * 10) / 10));
    if (v < -60) v = SILENT_DB; // the bottom of the travel is silence
    const changed = v !== current;
    current = v;
    show();
    if (changed || commit) (commit ? onChange : onInput)?.(v);
  };
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    if (e.altKey) {
      set(0, true);
      return;
    }
    const rect = track.getBoundingClientRect();
    if (e.target !== thumb) {
      // Click on the groove jumps there.
      set(faderToDb(1 - (e.clientY - rect.top) / rect.height), false);
    }
    drag = { y: e.clientY, p: dbToFader(current), h: rect.height };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const fine = e.shiftKey ? 0.2 : 1;
    set(faderToDb(drag.p + ((drag.y - e.clientY) / drag.h) * fine), false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    onChange?.(current);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => set(0, true));
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(current <= SILENT_DB ? -60 : current + step, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(current - step <= -60 ? SILENT_DB : current - step, true);
    else if (e.key === 'PageUp') set(current <= SILENT_DB ? -60 : current + 3, true);
    else if (e.key === 'PageDown') set(current - 3 <= -60 ? SILENT_DB : current - 3, true);
    else if (e.key === 'Home') set(MAX_DB, true);
    else if (e.key === 'End') set(SILENT_DB, true);
    else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') set(0, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  show();
  el.setValue = (v) => {
    current = v;
    show();
  };
  el.getValue = () => current;
  return el;
}

class Strip {
  constructor(app, doc, track) {
    this.app = app;
    this.doc = doc;
    this.id = track.id;
    this.track = null;
    const c = () => doc.controls;
    const isMaster = track.type === 'master';
    const isAudio = track.type === 'audio';
    const toggle = (key, text, label) => h(`button.mt-tb.mt-tb-${key}`, { type: 'button', 'aria-label': label, title: label, 'aria-pressed': 'false', onclick: () => c().toggle(this.id, key) }, text);
    this.input = isAudio ? h('select.select.mx-select', { 'aria-label': 'Input', title: 'Input' }) : null;
    this.input?.addEventListener('change', () => app.commands.run('mt.setTrackInput', { id: this.id, input: this.input.value }));
    this.output = h('select.select.mx-select', { 'aria-label': 'Output', title: 'Output', disabled: isMaster });
    this.output.addEventListener('change', () => app.commands.run('mt.setTrackOutput', { id: this.id, output: this.output.value }));
    this.fxRows = h('div.mx-fx', { role: 'group', 'aria-label': 'Effects' });
    this.invert = h('button.mt-tb.mt-tb-invert', { type: 'button', 'aria-label': 'Invert polarity', title: 'Invert Polarity', 'aria-pressed': 'false', onclick: () => c().toggle(this.id, 'invert') }, icon('polarity', 12));
    this.mode = h('select.select.mx-select.mx-mode', { 'aria-label': 'Automation mode', title: 'Automation Mode' }, AUTOMATION_MODES.map((m) => h('option', { value: m.id }, m.label)));
    this.mode.addEventListener('change', () => app.commands.run('mt.setAutomationMode', { id: this.id, mode: this.mode.value }));
    this.fxPower = h('button.mt-tb.mt-tb-fx', { type: 'button', 'aria-label': 'Effects power', title: 'Effects Power', 'aria-pressed': 'true', onclick: () => c().toggle(this.id, 'fxPower') }, icon('power', 12));
    this.fxEdit = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Edit effects', title: 'Edit Effects', onclick: () => app.commands.run('mt.trackEffects', { id: this.id }) }, icon('fx', 13));
    this.pan = isMaster ? null : knob({ value: 0, min: -100, max: 100, step: 1, defaultValue: 0, bipolar: true, label: 'Pan', format: formatPan, size: 26, onInput: (v) => c().set(this.id, 'pan', v, 'input'), onChange: (v) => c().set(this.id, 'pan', v, 'change') });
    this.panText = h('span.mx-pan-text', 'C');
    this.mute = toggle('mute', 'M', 'Mute');
    this.solo = isMaster ? null : toggle('solo', 'S', 'Solo');
    this.arm = isAudio ? toggle('arm', 'R', 'Arm for Record') : null;
    this.monitor = isAudio ? h('button.mt-tb.mt-tb-monitor', { type: 'button', 'aria-label': 'Monitor input', title: 'Monitor Input', 'aria-pressed': 'false', onclick: () => c().toggle(this.id, 'monitor') }, icon('monitor-input', 12)) : null;
    this.fader = fader({ value: 0, label: `${track.name} volume`, onInput: (v) => c().set(this.id, 'volume', v, 'input'), onChange: (v) => c().set(this.id, 'volume', v, 'change') });
    this.meter = new MeterBar({ vertical: true, label: `${track.name} level` });
    this.dbNum = hotNumber({ value: 0, min: SILENT_DB, max: MAX_DB, step: 0.1, defaultValue: 0, label: 'Volume (dB)', format: formatGainShort, parse: parseGain, onInput: (v) => c().set(this.id, 'volume', v, 'input'), onChange: (v) => c().set(this.id, 'volume', v, 'change') });
    this.name = h('div.mx-name');
    this.sends = isMaster ? null : new SendControls(app, doc, track.id);
    this.eq = new EqControls(app, doc, track.id);
    const scale = h('div.mx-scale', { 'aria-hidden': 'true' }, SCALE.map((db) => h('span', { style: { bottom: `calc(${(dbToFader(db) * 100).toFixed(2)}% - ${(dbToFader(db) * 18 - 9).toFixed(1)}px)` } }, db > 0 ? `+${db}` : String(db))));
    // Meter scale: dBFS every 12 dB beside the meter.
    const mscale = h('div.mx-mscale', { 'aria-hidden': 'true' }, [0, -12, -24, -36, -48, -60].map((db) => h('span', { style: { bottom: `${((METER_RANGE + db) / METER_RANGE) * 100}%` } }, String(db))));
    this.el = h(
      `div.mx-strip${isMaster ? '.master' : ''}${track.type === 'bus' ? '.bus' : ''}`,
      // Focus selects the track too, so keyboard users act on the strip they are in, as a click does.
      { role: 'group', dataset: { id: this.id }, onpointerdown: () => doc.selectTrack(this.id), onfocusin: () => doc.selectTrack(this.id) },
      // Sections the gutter can collapse (data-sec); the master keeps empty
      // ones so its controls line up with the tracks'.
      h('div.mx-sec', { dataset: { sec: 'io' } }, h('div.mx-io', h('div.mx-io-top', this.invert), this.input ? h('label.mx-io-row', icon('log-in', 12), this.input) : h('div.mx-io-row.placeholder', { 'aria-hidden': 'true' }), h('label.mx-io-row', icon('log-out', 12), this.output))),
      h('div.mx-sec', { dataset: { sec: 'fx' } }, h('div.mx-fx-head', h('span', 'Effects'), h('div.spacer'), this.fxPower, this.fxEdit), this.fxRows),
      h('div.mx-sec', { dataset: { sec: 'sends' } }, this.sends?.el),
      h('div.mx-sec', { dataset: { sec: 'eq' } }, this.eq.el),
      h('div.mx-panrow', this.pan, this.pan ? this.panText : null),
      this.mode,
      h('div.mx-btns', this.mute, this.solo, this.arm, this.monitor),
      h('div.mx-level', scale, this.fader, this.meter.el, mscale),
      h('div.mx-db', this.dbNum),
      this.name,
    );
    this.update(track);
  }

  update(track) {
    const doc = this.doc;
    this.track = track;
    const state = doc.state;
    this.el.style.setProperty('--track-color', track.color);
    this.el.setAttribute('aria-label', `${track.type === 'master' ? 'Master' : track.name} channel strip`);
    this.name.textContent = track.name;
    this.name.title = track.name;
    for (const [b, k] of [[this.mute, 'mute'], [this.solo, 'solo'], [this.arm, 'arm'], [this.monitor, 'monitor'], [this.invert, 'invert']]) b?.setAttribute('aria-pressed', String(Boolean(track[k])));
    this.mode.value = track.mode;
    this.fxPower.setAttribute('aria-pressed', String(track.fxPower));
    if (this.input) {
      this.input.replaceChildren(h('option', { value: 'none' }, 'None'), h('option', { value: 'default' }, track.channels === 1 ? 'Default Mono Input' : 'Default Stereo Input'));
      this.input.value = track.input;
    }
    const outs = [h('option', { value: 'master' }, track.type === 'master' ? 'Default Output' : 'Mix')];
    if (track.type !== 'master') for (const b of state.tracks) if (b.type === 'bus' && b.id !== track.id && !wouldCycle(state, track.id, b.id)) outs.push(h('option', { value: b.id }, b.name));
    this.output.replaceChildren(...outs);
    this.output.value = track.output || 'master';
    // Every effect (the list scrolls past four), each with its own power, then empty slots up to four.
    const edit = () => this.app.commands.run('mt.trackEffects', { id: this.id });
    const filled = track.fx.map((s, i) => [s, i]).filter(([s]) => s);
    const rows = filled.map(([s, i]) => {
      const name = getEffect(s.effect)?.name || 'Effect';
      const on = s.enabled !== false;
      return h(
        `div.mx-fx-slot${on ? '' : '.off'}`,
        h('button.mx-fx-power', { type: 'button', 'aria-pressed': String(on), 'aria-label': `${name} power`, title: on ? 'Bypass this effect' : 'Turn this effect on', onclick: () => toggleTrackEffect(this.doc, this.id, i) }, icon('power', 10)),
        h('button.mx-fx-name', { type: 'button', 'aria-label': `${name}${on ? '' : ' (off)'}, edit effects`, onclick: edit }, name),
      );
    });
    for (let i = rows.length; i < 4; i++) rows.push(h('button.mx-fx-slot.empty', { type: 'button', 'aria-label': `Empty effect slot ${i + 1}, add an effect`, onclick: edit }));
    this.fxRows.replaceChildren(...rows);
    this.fader.setAttribute('aria-label', `${track.name} volume`);
    this.sends?.update(track);
    this.eq.update(track);
    this.values();
  }

  values() {
    const c = this.doc.controls;
    const t = this.track;
    const v = c.value(t, 'volume');
    // Each control is checked on its own: moving the fader must still update the readout.
    if (this.fader.getValue() !== v) this.fader.setValue(v);
    if (this.dbNum.getValue() !== v) this.dbNum.setValue(v);
    this.fader.classList.toggle('automated', c.automated(t, 'volume'));
    if (this.pan) {
      const p = c.value(t, 'pan');
      if (this.pan.getValue() !== p) this.pan.setValue(p);
      if (this.panText.textContent !== formatPan(p)) this.panText.textContent = formatPan(p);
    }
  }
}

export function mixerPanel(app) {
  const strips = new Map();
  const scroller = h('div.mx-strips', { role: 'group', 'aria-label': 'Channel strips' });
  const masterBox = h('div.mx-master');
  const empty = h(
    'div.empty-state.mx-empty',
    h('p', 'The Mixer shows the tracks of a multitrack session.'),
    h('button.btn', { type: 'button', onclick: () => app.commands.run(app.documents.some((d) => d.kind === 'session') ? 'view.multitrack' : 'file.newSession') }, icon('mode-multitrack', 14), 'Open Multitrack Session'),
  );
  // Gutter: a toggle per collapsible section, lined up with the strips.
  const SECTIONS = [
    { id: 'io', label: 'Inputs and Outputs', glyph: 'track-io' },
    { id: 'fx', label: 'Effects', glyph: 'fx' },
    { id: 'sends', label: 'Sends', glyph: 'corner-down-right' },
    { id: 'eq', label: 'EQ', glyph: 'sliders-horizontal' },
  ];
  const collapsed = () => new Set(app.prefs.get('mixerCollapsed') || []);
  const secBtns = SECTIONS.map((sec) =>
    h(
      'button.mx-gutter-btn',
      {
        type: 'button',
        dataset: { sec: sec.id },
        'aria-expanded': 'true',
        'aria-label': sec.label,
        title: `Show or hide ${sec.label}`,
        onclick: () => {
          const set = collapsed();
          if (set.has(sec.id)) set.delete(sec.id);
          else set.add(sec.id);
          app.prefs.set('mixerCollapsed', [...set]);
        },
      },
      icon('chevron-down', 11),
      icon(sec.glyph, 12),
    ),
  );
  const gutter = h('div.mx-gutter', { role: 'group', 'aria-label': 'Mixer sections' }, secBtns);
  const el = h('div.mixer-panel', gutter, scroller, masterBox, empty);
  let visible = false;
  let raf = 0;
  let doc = null;
  let busKey = '';

  const session = () => {
    if (app.active?.kind === 'session') return app.active;
    return null;
  };

  const render = () => {
    const d = session();
    if (d !== doc) {
      for (const s of strips.values()) s.el.remove();
      strips.clear();
      doc = d;
    }
    el.classList.toggle('no-session', !doc);
    if (!doc) return;
    // Hidden tracks leave the Mixer too unless Track Visibility says otherwise.
    const hideHidden = app.prefs.get('visibilityInMixer') !== false;
    const tracks = allTracks(doc.state).filter((t) => !hideHidden || !t.hidden);
    // Output and send menus list the buses: rebuild every strip when they change.
    const buses = doc.state.tracks.filter((t) => t.type === 'bus').map((t) => `${t.id}:${t.name}:${t.output}:${(t.sends || []).map((x) => x.target).join(',')}`).join('|');
    const busesChanged = buses !== busKey;
    busKey = buses;
    const seen = new Set();
    const order = [];
    for (const t of tracks) {
      seen.add(t.id);
      let s = strips.get(t.id);
      if (!s) {
        s = new Strip(app, doc, t);
        strips.set(t.id, s);
      } else if (s.track !== t || busesChanged) s.update(t);
      s.el.classList.toggle('selected', doc.selectedTrack === t.id);
      if (t.type !== 'master') order.push(s.el);
      else if (masterBox.firstChild !== s.el) masterBox.replaceChildren(s.el);
    }
    for (const [id, s] of strips) {
      if (!seen.has(id)) {
        s.el.remove();
        strips.delete(id);
      }
    }
    const cur = [...scroller.children];
    if (cur.length !== order.length || cur.some((x, i) => x !== order[i])) scroller.replaceChildren(...order);
    layoutSections();
  };

  /** Applies the collapsed sections and lines the gutter and the master up with the first strip. */
  function layoutSections() {
    const hidden = collapsed();
    for (const b of secBtns) {
      const on = hidden.has(b.dataset.sec);
      b.setAttribute('aria-expanded', String(!on));
      el.classList.toggle(`mx-hide-${b.dataset.sec}`, on);
    }
    if (!doc || !visible) return;
    const first = scroller.firstElementChild;
    const master = masterBox.firstElementChild;
    const masterSends = master?.querySelector(".mx-sec[data-sec='sends']");
    if (masterSends) masterSends.style.minHeight = '';
    for (const b of secBtns) {
      const sec = first?.querySelector(`.mx-sec[data-sec='${b.dataset.sec}']`);
      b.hidden = !sec;
      if (sec) b.style.top = `${sec.offsetTop}px`;
      if (sec && b.dataset.sec === 'sends' && masterSends) masterSends.style.minHeight = `${sec.offsetHeight}px`;
    }
  }

  const tick = () => {
    raf = 0;
    if (!visible || !doc) return;
    const now = performance.now();
    let active = false;
    for (const s of strips.values()) {
      if (app.engine.playing) s.values();
      if (s.meter.draw(now)) active = true;
    }
    if (active || app.engine.playing) raf = requestAnimationFrame(tick);
  };
  const schedule = () => {
    if (!raf && visible) raf = requestAnimationFrame(tick);
  };

  app.engine.on('meters', (m) => {
    if (!doc || app.active !== doc) return;
    for (const [id, s] of strips) s.meter.feed(s.track.type === 'master' ? m.master : m.tracks.get(id) || [0, 0]);
    schedule();
  });
  app.on('active', render);
  app.on('doc-change', (d, e) => {
    if (d !== app.active || d.kind !== 'session') return;
    if (e.kind === 'edit' || e.kind === 'history' || e.kind === 'clip-selection') render();
    else if (e.kind === 'cursor' || e.kind === 'automation') for (const s of strips.values()) s.values();
  });
  app.on('transport', schedule);
  app.on('prefs', (key) => key === 'visibilityInMixer' && render());
  app.on('prefs', (key) => key === 'mixerCollapsed' && layoutSections());
  render();
  return {
    el,
    show() {
      visible = true;
      render();
      schedule();
    },
    hide() {
      visible = false;
    },
  };
}
