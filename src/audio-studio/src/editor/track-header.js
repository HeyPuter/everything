// Track header in the Multitrack editor: color strip, editable name, mute,
// solo, record arm and input monitoring, volume and pan knobs with scrubbable
// readouts, input/output routing, the effects list, a send or the track EQ
// (the header mode buttons pick which), the automation mode,
// a level meter and a resize handle. Rows hide as the track gets shorter.
// Below them sit the automation lane headers: per lane its parameter, keyframe
// navigation at the playhead, clear and close, and a handle that sizes the lanes.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { knob, hotNumber } from '../ui/controls.js';
import { AUTOMATION_MODES, AUTOMATION_PARAMS, TRACK_COLORS, SILENT_DB, MAX_DB, wouldCycle, trackLanes, automationParams, updateTrack, sendIndexOf } from '../model/session-edits.js';
import { formatGainShort, formatPan, parseGain, parsePan, formatGain } from '../multitrack/levels.js';
import { getEffect } from '../effects/registry.js';
import { MeterBar } from '../multitrack/meter.js';
import { SendControls, EqControls, toggleTrackEffect } from '../multitrack/send-eq.js';
import { openTrackSlotMenu, editTrackEffect } from '../multitrack/fx-slots.js';
import { pickCustomColor } from '../multitrack/custom-color.js';
import { canFreeze } from '../multitrack/freeze.js';
import { fxAutomationParams, laneInfo, laneParams } from '../multitrack/fx-automation.js';

export class TrackHeader {
  /**
   * @param {MultitrackView} view
   * @param {object} track
   */
  constructor(view, track) {
    this.view = view;
    this.app = view.app;
    this.doc = view.doc;
    this.id = track.id;
    this.track = null;
    this.#build(track);
    this.update(track);
  }

  #build(track) {
    const app = this.app;
    const doc = this.doc;
    const controls = () => doc.controls;
    const isMaster = track.type === 'master';
    const isBus = track.type === 'bus';
    this.colorBtn = h('button.mt-th-color', { type: 'button', 'aria-label': 'Track color', title: 'Track color', onclick: (e) => this.#colorMenu(e) });
    this.grip = h('span.mt-th-grip', { title: isMaster ? '' : 'Drag to reorder', 'aria-hidden': 'true' }, icon(isMaster ? 'mode-multitrack' : isBus ? 'track-bus' : 'grip-vertical', 13));
    this.nameInput = h('input.mt-th-name', { type: 'text', 'aria-label': 'Track name', spellcheck: false, autocomplete: 'off' });
    this.nameInput.addEventListener('change', () => {
      const v = this.nameInput.value.trim();
      if (!v) {
        this.nameInput.value = this.track.name;
        return;
      }
      app.commands.run('mt.renameTrack', { id: this.id, name: v });
    });
    this.nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.nameInput.blur();
      if (e.key === 'Escape') {
        this.nameInput.value = this.track.name;
        this.nameInput.blur();
      }
    });
    const toggle = (key, label, text, title) =>
      h(`button.mt-tb.mt-tb-${key}`, { type: 'button', 'aria-pressed': 'false', 'aria-label': label, title, onclick: () => controls().toggle(this.id, key) }, text);
    this.mute = toggle('mute', 'Mute', 'M', 'Mute');
    // The master is never soloed (it carries the whole mix), as in the Mixer.
    this.solo = isMaster ? null : toggle('solo', 'Solo', 'S', 'Solo');
    this.arm = isMaster || isBus ? null : toggle('arm', 'Arm for recording', 'R', 'Arm for Record');
    this.monitor = isMaster || isBus ? null : h('button.mt-tb.mt-tb-monitor', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Monitor input', title: 'Monitor Input: hear the input of an armed track while stopped and while recording', onclick: () => controls().toggle(this.id, 'monitor') }, icon('monitor-input', 12));

    const volSet = (v, phase) => controls().set(this.id, 'volume', v, phase);
    const panSet = (v, phase) => controls().set(this.id, 'pan', v, phase);
    this.volKnob = knob({ value: 0, min: -60, max: MAX_DB, step: 0.1, defaultValue: 0, label: 'Volume', format: (v) => formatGain(v <= -60 ? SILENT_DB : v), size: 20, onInput: (v) => volSet(v <= -60 ? SILENT_DB : v, 'input'), onChange: (v) => volSet(v <= -60 ? SILENT_DB : v, 'change') });
    this.volNum = hotNumber({ value: 0, min: SILENT_DB, max: MAX_DB, step: 0.1, defaultValue: 0, label: 'Volume (dB)', format: formatGainShort, parse: parseGain, onInput: (v) => volSet(v, 'input'), onChange: (v) => volSet(v, 'change') });
    this.panKnob = isMaster ? null : knob({ value: 0, min: -100, max: 100, step: 1, defaultValue: 0, bipolar: true, label: 'Pan', format: formatPan, size: 20, onInput: (v) => panSet(v, 'input'), onChange: (v) => panSet(v, 'change') });
    this.panNum = isMaster ? null : hotNumber({ value: 0, min: -100, max: 100, step: 1, defaultValue: 0, label: 'Pan', format: (v) => (Math.round(v) ? String(Math.round(v)) : '0'), parse: parsePan, onInput: (v) => panSet(v, 'input'), onChange: (v) => panSet(v, 'change') });
    this.invert = h('button.mt-tb.mt-tb-invert', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Invert polarity', title: 'Invert Polarity', onclick: () => controls().toggle(this.id, 'invert') }, icon('polarity', 12));
    this.fxPower = h('button.mt-tb.mt-tb-fx', { type: 'button', 'aria-pressed': 'true', 'aria-label': 'Track effects power', title: 'Track Effects Power', onclick: () => controls().toggle(this.id, 'fxPower') }, icon('power', 12));

    this.inputSel = isMaster || isBus ? null : h('select.select.mt-th-select', { 'aria-label': 'Track input', title: 'Input' });
    this.inputSel?.addEventListener('change', () => app.commands.run('mt.setTrackInput', { id: this.id, input: this.inputSel.value }));
    this.outputSel = h('select.select.mt-th-select', { 'aria-label': 'Track output', title: 'Output', disabled: isMaster });
    this.outputSel.addEventListener('change', () => app.commands.run('mt.setTrackOutput', { id: this.id, output: this.outputSel.value }));
    this.fxList = h('div.mt-th-fxlist');
    this.fxEdit = h('button.btn.sm.mt-th-fxedit', { type: 'button', onclick: () => app.commands.run('mt.trackEffects', { id: this.id }) }, icon('fx', 13), h('span', 'Effects'));

    this.autoToggle = h('button.icon-btn.sm.mt-th-autotoggle', { type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show automation lane', title: 'Show Automation Lane', onclick: () => app.commands.run('mt.toggleAutomationLane', { id: this.id }) }, icon('chevron-right', 13));
    this.modeSel = h('select.select.mt-th-select.mt-th-mode', { 'aria-label': 'Automation mode', title: 'Automation Mode' }, AUTOMATION_MODES.map((m) => h('option', { value: m.id }, m.label)));
    this.modeSel.addEventListener('change', () => app.commands.run('mt.setAutomationMode', { id: this.id, mode: this.modeSel.value }));
    this.addLaneBtn = h('button.icon-btn.sm.mt-th-addlane', { type: 'button', 'aria-label': 'Add automation lane', title: 'Add Automation Lane', onclick: () => app.commands.run('mt.addAutomationLane', { id: this.id }) }, icon('plus', 13));
    this.lanesEl = h('div.mt-th-lanes', { role: 'group', 'aria-label': 'Automation lanes' });
    this.laneResize = h('div.mt-lane-resize', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize automation lanes', tabindex: '-1' });
    this.#bindLaneResize();

    this.meter = new MeterBar({ vertical: true, label: `${track.name} level` });
    this.resize = h('div.mt-th-resize', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize track', tabindex: '-1' });
    this.#bindResize();
    this.#bindGrip();

    this.rowName = h('div.mt-th-row.mt-th-r1', this.grip, this.nameInput, h('div.mt-th-btns', this.mute, this.solo, this.arm, this.monitor));
    this.rowLevel = h(
      'div.mt-th-row.mt-th-r2',
      h('span.mt-th-glyph', { title: 'Volume', 'aria-hidden': 'true' }, icon('volume-2', 12)),
      this.volKnob,
      this.volNum,
      this.panKnob ? h('span.mt-th-glyph', { title: 'Pan', 'aria-hidden': 'true' }, icon('move-horizontal', 12)) : null,
      this.panKnob,
      this.panNum,
      h('div.spacer'),
      this.fxPower,
    );
    // Polarity sits on the input row (or the output row of buses and the master).
    this.rowIo = h(
      'div.mt-th-row.mt-th-r3.mt-th-io',
      this.inputSel ? h('div.mt-th-io-row', h('span.mt-th-glyph', { title: 'Input' }, icon('log-in', 12)), this.inputSel, this.invert) : null,
      h('div.mt-th-io-row', h('span.mt-th-glyph', { title: 'Output' }, icon('log-out', 12)), this.outputSel, this.inputSel ? null : this.invert),
    );
    this.fxPost = isMaster ? null : h('button.mt-tb.mx-fx-post', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Post-fader effects', title: 'Post-Fader (effects after the track volume and pan)', onclick: () => controls().toggle(this.id, 'fxPost') }, 'Post');
    this.freeze = isMaster || isBus ? null : h('button.mt-tb.mx-freeze', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Freeze track', title: 'Freeze: pre-render the clips and effects so they cost nothing during playback', onclick: () => app.commands.run('mt.freezeTrack', { id: this.id }) }, icon('freeze', 12));
    this.rowFx = h('div.mt-th-row.mt-th-r3.mt-th-fx', this.fxList, this.fxPost, this.freeze, this.fxEdit);
    this.sendCtl = isMaster ? null : new SendControls(app, doc, track.id, { compact: true });
    this.eqCtl = new EqControls(app, doc, track.id, { compact: true });
    this.rowSends = h('div.mt-th-row.mt-th-r3.mt-th-sendrow', this.sendCtl ? this.sendCtl.el : h('span.faint', 'No sends on the master'));
    this.rowEq = h('div.mt-th-row.mt-th-r3.mt-th-eqrow', this.eqCtl.el);
    this.rowAuto = h('div.mt-th-row.mt-th-r4', this.autoToggle, this.modeSel, this.addLaneBtn);
    this.body = h('div.mt-th-body', this.rowName, this.rowLevel, this.rowIo, this.rowFx, this.rowSends, this.rowEq, this.rowAuto);
    this.el = h(
      `div.mt-th${isMaster ? '.master' : ''}${isBus ? '.bus' : ''}`,
      // Focus selects the track too, so keyboard users act on the track they are in, as a click does.
      { role: 'group', dataset: { id: this.id }, onpointerdown: () => doc.selectTrack(this.id), onfocusin: () => doc.selectTrack(this.id) },
      this.colorBtn,
      this.body,
      this.meter.el,
      this.lanesEl,
      this.resize,
    );
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, select')) return;
      e.preventDefault();
      doc.selectTrack(this.id);
      this.view.trackMenu(this.id, e.clientX, e.clientY);
    });
  }

  #colorMenu(e) {
    const r = this.colorBtn.getBoundingClientRect();
    const names = ['Green', 'Blue', 'Amber', 'Red', 'Violet', 'Cyan', 'Pink', 'Lime', 'Orange', 'Indigo', 'Olive', 'Slate'];
    this.app.openMenu(
      [
        ...TRACK_COLORS.map((c, i) => ({ type: 'cmd', label: names[i], swatch: c, enabled: true, checked: this.track.color === c, run: () => this.app.commands.run('mt.trackColor', { id: this.id, color: c }) })),
        { type: 'sep' },
        { type: 'cmd', label: 'Custom Color...', swatch: TRACK_COLORS.includes(this.track.color) ? null : this.track.color, enabled: true, checked: !TRACK_COLORS.includes(this.track.color), run: () => pickCustomColor(this.track.color, (color) => this.app.commands.run('mt.trackColor', { id: this.id, color })) },
      ],
      { x: r.right, y: r.top, anchor: this.colorBtn, label: 'Track color' },
    );
    e.stopPropagation();
  }

  #bindResize() {
    let drag = null;
    this.resize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resize.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: this.track.height };
    });
    this.resize.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const amp = this.doc.view.amp || 1;
      const height = Math.max(28, Math.min(600, Math.round(drag.h + (e.clientY - drag.y) / amp)));
      this.view.setTrackHeight(this.id, height);
    });
    const end = () => (drag = null);
    this.resize.addEventListener('pointerup', end);
    this.resize.addEventListener('pointercancel', end);
    this.resize.addEventListener('dblclick', () => this.view.setTrackHeight(this.id, this.track.minimized ? 124 : 28, { minimize: !this.track.minimized }));
  }

  #bindLaneResize() {
    let drag = null;
    const el = this.laneResize;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: this.track.laneHeight, n: Math.max(1, trackLanes(this.track).length) };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // The handle sits under the last lane: every lane grows by its share of the move.
      const laneHeight = Math.max(28, Math.min(200, Math.round(drag.h + (e.clientY - drag.y) / drag.n)));
      if (laneHeight !== this.track.laneHeight) this.doc.amendView((st) => updateTrack(st, this.id, { laneHeight }));
    });
    const end = () => (drag = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Lane headers: rebuilt when the lanes, or whether each has keyframes, change. */
  #syncLanes(track) {
    const lanes = trackLanes(track);
    const state = this.doc.state;
    const busName = (id) => state.tracks.find((b) => b.id === id)?.name || '';
    const key = JSON.stringify([lanes, lanes.map((p) => Boolean(track.automation[p]?.length)), track.mode, (track.sends || []).map((x) => (x?.target ? busName(x.target) : '')), (track.fx || []).map((x) => (x ? `${x.id}:${x.effect}` : '')), Boolean(track.eq?.on)]);
    if (this.lanesKey === key) return;
    this.lanesKey = key;
    const run = (cmd, args) => this.app.commands.run(cmd, { id: this.id, ...args });
    const params = automationParams(track);
    const fxParams = fxAutomationParams(track);
    const label = (p) => {
      const i = sendIndexOf(p);
      if (i >= 0) return `Send ${i + 1}${track.sends?.[i]?.target ? ` (${busName(track.sends[i].target)})` : ''}`;
      return AUTOMATION_PARAMS.find((x) => x.id === p)?.label || laneInfo(track, p).label;
    };
    // Track parameters first, then each effect's settings under its name.
    const options = (param) => {
      const base = [...new Set([...params, ...(fxParams.some((x) => x.id === param) ? [] : [param])])].map((p) => h('option', { value: p, selected: p === param }, label(p)));
      const groups = new Map();
      for (const x of fxParams) {
        if (!groups.has(x.effect)) groups.set(x.effect, []);
        groups.get(x.effect).push(h('option', { value: x.id, selected: x.id === param }, `${x.effect}: ${x.label}`));
      }
      return [...base, ...[...groups].map(([name, opts]) => h('optgroup', { label: name }, opts))];
    };
    const rows = lanes.map((param, lane) => {
      const name = label(param);
      const sel = h('select.select.mt-th-select.mt-lane-param', { 'aria-label': `Automation lane ${lane + 1} parameter`, title: 'Lane Parameter' }, options(param));
      sel.addEventListener('change', () => run('mt.setAutomationParam', { param: sel.value, lane }));
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      const btn = (ic, text, cmd, extra = {}) => h('button.icon-btn.sm.mt-lane-btn', { type: 'button', 'aria-label': `${text} (${name})`, title: text, onclick: () => run(cmd, { param, lane }), ...extra }, icon(ic, 13));
      const has = Boolean(track.automation[param]?.length);
      return h(
        'div.mt-lane-head',
        { dataset: { param } },
        sel,
        btn('key-prev', 'Previous Keyframe', 'mt.previousKeyframe', { disabled: !has }),
        btn('key-toggle', 'Add or Remove Keyframe at Playhead', 'mt.toggleKeyframe'),
        btn('key-next', 'Next Keyframe', 'mt.nextKeyframe', { disabled: !has }),
        btn('lane-clear', 'Clear Lane', 'mt.clearAutomation', { disabled: !has }),
        btn('x', 'Close Lane', 'mt.removeAutomationLane'),
      );
    });
    this.lanesEl.replaceChildren(...rows, ...(rows.length ? [this.laneResize] : []));
    this.addLaneBtn.disabled = !laneParams(track).some((p) => !lanes.includes(p));
  }

  #bindGrip() {
    if (this.track?.type === 'master') return;
    let drag = null;
    this.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.el.classList.contains('master')) return;
      e.preventDefault();
      this.grip.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, moved: false };
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientY - drag.y) < 4) return;
      drag.moved = true;
      this.view.showReorder(this.id, e.clientY);
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) this.view.finishReorder(this.id, e.type === 'pointercancel' ? null : e.clientY);
    };
    this.grip.addEventListener('pointerup', end);
    this.grip.addEventListener('pointercancel', end);
  }

  /** Brings the controls in line with the track state. */
  update(track) {
    const prev = this.track;
    this.track = track;
    const state = this.doc.state;
    if (!prev || prev.color !== track.color) this.el.style.setProperty('--track-color', track.color);
    if (document.activeElement !== this.nameInput && this.nameInput.value !== track.name) this.nameInput.value = track.name;
    this.el.setAttribute('aria-label', `${track.type === 'master' ? 'Master track' : track.type === 'bus' ? 'Bus track' : 'Track'} ${track.name}`);
    for (const [btn, key] of [[this.solo, 'solo'], [this.arm, 'arm'], [this.monitor, 'monitor'], [this.invert, 'invert']]) {
      if (btn) btn.setAttribute('aria-pressed', String(Boolean(track[key])));
    }
    this.fxPower.setAttribute('aria-pressed', String(track.fxPower));
    this.fxPost?.setAttribute('aria-pressed', String(Boolean(track.fxPost)));
    this.syncFreeze();
    const fx = track.fx.filter(Boolean);
    this.fxPower.hidden = !fx.length;
    this.updateValues();
    if (this.inputSel) {
      const opts = [['none', 'None'], ['default', track.channels === 1 ? 'Default Mono Input' : 'Default Stereo Input']];
      syncOptions(this.inputSel, opts, track.input);
    }
    const outs = [['master', track.type === 'master' ? 'Default Output' : 'Mix']];
    if (track.type !== 'master') {
      for (const b of state.tracks) {
        if (b.type !== 'bus' || b.id === track.id || wouldCycle(state, track.id, b.id)) continue;
        outs.push([b.id, b.name]);
      }
    }
    syncOptions(this.outputSel, outs, track.output || 'master');
    this.modeSel.value = track.mode;
    this.#syncLanes(track);
    this.autoToggle.setAttribute('aria-expanded', String(track.showAutomation));
    this.autoToggle.classList.toggle('open', track.showAutomation);
    // Each effect with its own power switch (the first six; the editor lists them all).
    const chips = track.fx
      .map((s, i) => [s, i])
      .filter(([s]) => s)
      .slice(0, 6)
      .map(([s, i]) => {
        const name = getEffect(s.effect)?.name || s.name || 'Effect';
        const on = s.enabled !== false;
        return h(
          `span.mt-th-fxname${on ? '' : '.off'}`,
          h('button.mt-th-fxpower', { type: 'button', 'aria-pressed': String(on), 'aria-label': `${name} power`, title: on ? 'Bypass this effect' : 'Turn this effect on', onclick: () => toggleTrackEffect(this.doc, this.id, i) }, icon('power', 10)),
          h('button.mt-th-fxlabel', {
            type: 'button',
            title: `${name}: edit settings (right-click for more)`,
            onclick: () => editTrackEffect(this.app, this.doc, this.id, i),
            oncontextmenu: (e) => {
              e.preventDefault();
              e.stopPropagation();
              openTrackSlotMenu(this.app, this.doc, this.id, i, e.currentTarget);
            },
          }, name),
        );
      });
    this.fxList.replaceChildren(...(chips.length ? chips : [h('span.mt-th-fxname.empty', 'No effects')]));
    this.sendCtl?.update(track);
    this.eqCtl.update(track);
    this.meter.label = `${track.name} level`;
  }

  /** The freeze switch: on, rendering (busy) or unavailable (post-fader effects, 5.1). */
  syncFreeze() {
    if (!this.freeze) return;
    const t = this.track;
    this.freeze.setAttribute('aria-pressed', String(Boolean(t.freeze)));
    this.freeze.classList.toggle('busy', Boolean(this.doc.freezing?.has(t.id)));
    this.freeze.disabled = !t.freeze && !canFreeze(this.doc.state, t);
    this.el.classList.toggle('frozen', Boolean(t.freeze));
  }

  /** Knob readouts (also called every frame during playback for automation). */
  updateValues() {
    const t = this.track;
    const c = this.doc.controls;
    const vol = c.value(t, 'volume');
    // Each control is checked on its own: dragging one must still update the other.
    if (this.volKnob.getValue() !== Math.max(-60, vol)) this.volKnob.setValue(Math.max(-60, vol));
    if (this.volNum.getValue() !== vol) this.volNum.setValue(vol);
    this.volKnob.classList.toggle('automated', c.automated(t, 'volume'));
    // Mute follows its automation lane during playback.
    const muted = String(c.muted(t));
    if (this.mute.getAttribute('aria-pressed') !== muted) this.mute.setAttribute('aria-pressed', muted);
    this.mute.classList.toggle('automated', c.automated(t, 'mute'));
    if (this.panKnob) {
      const pan = c.value(t, 'pan');
      if (this.panKnob.getValue() !== pan) this.panKnob.setValue(pan);
      if (this.panNum.getValue() !== pan) this.panNum.setValue(pan);
      this.panKnob.classList.toggle('automated', c.automated(t, 'pan'));
    }
  }

  /** Lays the header out for its row height. */
  setHeight(px, autoPx) {
    this.el.style.height = `${px + autoPx}px`;
    // The track's own controls fill the first row; the lane headers take the rest.
    this.el.style.gridTemplateRows = autoPx ? `minmax(0, 1fr) ${autoPx}px` : '';
    this.el.style.setProperty('--lane-h', `${this.track?.laneHeight || 46}px`);
    this.resize.style.bottom = autoPx ? `${autoPx}px` : '';
    // Finger-sized rows (touch) are taller, and phone headers wrap the name onto its own line:
    // fewer rows fit in the same track height.
    const coarse = coarsePointer();
    const lift = coarse ? (document.documentElement.dataset.layout === 'phone' ? 34 : 0) : 0;
    const [a, b, c] = coarse ? [72 + lift, 104 + lift, 137 + lift] : [46, 76, 118];
    const size = px < a ? 'xs' : px < b ? 'sm' : px < c ? 'md' : 'lg';
    if (this.el.dataset.size !== size) this.el.dataset.size = size;
    this.el.classList.toggle('with-auto', autoPx > 0);
  }

  setMode(mode) {
    this.el.dataset.mode = mode;
  }

  setSelected(on) {
    this.el.classList.toggle('selected', on);
  }
}

let coarseQuery = null;
/** True on touch screens (finger-sized controls). */
function coarsePointer() {
  coarseQuery ||= globalThis.matchMedia?.('(pointer: coarse)') || { matches: false };
  return coarseQuery.matches;
}

function syncOptions(sel, options, value) {
  const key = options.map((o) => o.join('\u0001')).join('\u0002');
  if (sel.dataset.key !== key) {
    sel.replaceChildren(...options.map(([v, label]) => h('option', { value: v }, label)));
    sel.dataset.key = key;
  }
  sel.value = value;
}
