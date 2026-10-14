// One mixer strip: number and name, color, inputs hint, pan and width knobs,
// the meter slot (meters are drawn by the panel on one canvas), the volume
// fader with its dB scale, mute and solo, and the send control that shows
// whether the selected insert routes here.
//
//   const s = createStrip(ctx, index)
//   s.update(state)   // redraws only the parts whose inputs changed
//
// state = { track, selected, inputs: Channel[], inputsKey, send }
//   send = null (nothing to show) | { mode: 'self'|'off'|'on'|'blocked', gain, color, from }

import { h } from '../lib/dom.js';
import { formatPan } from '../lib/util.js';
import { createKnob } from '../ui/knob.js';
import { icon } from '../ui/icons.js';
import { createFader } from './fader.js';
import { shortGain, formatGain, MAX_GAIN } from './db.js';

const PAN = { id: 'pan', label: 'Pan', min: -1, max: 1, def: 0 };
const WIDTH = { id: 'width', label: 'Width', min: 0, max: 2, def: 1, unit: '%' };
const SEND = { id: 'send', label: 'Send', min: 0, max: MAX_GAIN, def: 1, curve: 'pow2' };

export function createStrip(ctx, index) {
  const { ctl } = ctx;
  const master = index === 0;
  const num = h('span.mx-num', master ? 'M' : String(index));
  const inputsBtn = h('button.mx-in', { type: 'button', hidden: true }, icon('link', 10), h('span.mx-in-n', '0'));
  const fxBadge = h('span.mx-fxn', { hidden: true });
  const nameBtn = h('button.mx-name', { type: 'button' });
  const pan = createKnob({
    param: PAN,
    size: 24,
    label: 'Pan',
    format: formatPan,
    ...ctl.trackGesture(index, 'pan', 'Insert pan'),
  });
  const width = createKnob({
    param: WIDTH,
    size: 24,
    label: 'Width',
    ...ctl.trackGesture(index, 'width', 'Stereo width'),
  });
  const meter = h('div.mx-meter', { title: 'Peak meter. Click to clear the clip indicator.' });
  const fader = createFader({
    label: 'Volume',
    ...ctl.trackGesture(index, 'volume', 'Insert volume'),
    menuItems: () => ctx.stripMenuItems(index),
  });
  const readout = h('span.mx-db', { 'aria-hidden': 'true' });
  const muteBtn = h('button.led.mx-mute', { type: 'button' });
  const soloBtn = h('button.mx-solo', { type: 'button' }, 'S');
  const sendBtn = h('button.mx-send-btn', { type: 'button' }, icon('arrow-up', 12));
  const sendKnob = createKnob({ param: SEND, size: 20, showLabel: false, label: 'Send level', format: (v) => formatGain(v), onStart: () => sendG?.onStart(), onInput: (v) => sendG?.onInput(v), onEnd: (v) => sendG?.onEnd(v) });
  sendKnob.el.classList.add('mx-send-knob');
  const sendNote = h('span.mx-send-note');
  const sendRow = h('div.mx-send', sendBtn, sendKnob.el, sendNote);
  let sendG = null;

  const el = h(
    `div.mx-strip${master ? '.master' : ''}`,
    { role: 'group', dataset: { index: String(index) } },
    h('div.mx-color'),
    h('div.mx-head', num, fxBadge, inputsBtn),
    nameBtn,
    h('div.mx-knobs', pan.el, width.el),
    h('div.mx-main', meter, fader.el),
    readout,
    h('div.mx-btns', muteBtn, soloBtn),
    sendRow,
  );
  if (master) soloBtn.hidden = true;

  // Interactions ------------------------------------------------------------
  el.addEventListener('pointerdown', () => ctx.select(index), true);
  el.addEventListener('focusin', () => ctx.select(index, { fromFocus: true }));
  nameBtn.addEventListener('dblclick', () => ctx.rename(index));
  muteBtn.addEventListener('click', () => ctl.toggleMute(index));
  soloBtn.addEventListener('click', (e) => ctl.solo(index, { add: e.ctrlKey || e.metaKey }));
  meter.addEventListener('click', () => ctx.resetClip(index));
  inputsBtn.addEventListener('click', () => ctx.openInputsMenu(index, inputsBtn));
  sendBtn.addEventListener('click', () => {
    if (!last.send || last.send.mode === 'self') return;
    ctl.toggleRoute(last.send.from, index);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctx.select(index);
    ctx.openStripMenu(index, e);
  });

  // Updates -----------------------------------------------------------------
  const last = { track: null, selected: null, inputsKey: null, sendKey: null, send: null };
  const focusables = [nameBtn, inputsBtn, pan.el, width.el, fader.slider, muteBtn, soloBtn, sendBtn, sendKnob.el];

  function update(s) {
    const t = s.track;
    if (t !== last.track) {
      const prev = last.track;
      last.track = t;
      const name = t.name || (master ? 'Master' : `Insert ${index}`);
      if (!prev || prev.name !== name) {
        nameBtn.textContent = name;
        nameBtn.title = `${name}. Double-click or F2 to rename.`;
        el.setAttribute('aria-label', master ? 'Master' : `Insert ${index}, ${name}`);
        fader.setLabel(`${name} volume`);
        muteBtn.setAttribute('aria-label', `Mute ${name}`);
        soloBtn.setAttribute('aria-label', `Solo ${name}`);
        soloBtn.title = 'Solo (Ctrl/Cmd-click to solo several)';
      }
      el.style.setProperty('--strip-color', t.color || 'var(--border-strong)');
      el.classList.toggle('has-color', Boolean(t.color));
      pan.set(t.pan);
      width.set(t.width);
      fader.set(t.volume);
      readout.textContent = shortGain(t.volume);
      muteBtn.setAttribute('aria-pressed', String(!t.mute));
      muteBtn.title = t.mute ? 'Muted. Click to unmute.' : 'On. Click to mute.';
      el.classList.toggle('muted', Boolean(t.mute));
      soloBtn.setAttribute('aria-pressed', String(Boolean(t.solo)));
      const on = t.fx.filter((x) => x.on).length;
      fxBadge.hidden = !t.fx.length;
      fxBadge.textContent = `fx ${t.fx.length}`;
      fxBadge.title = `${t.fx.length} effect${t.fx.length === 1 ? '' : 's'}${on < t.fx.length ? `, ${t.fx.length - on} bypassed` : ''}`;
      fxBadge.classList.toggle('bypassed', on < t.fx.length);
    }
    if (s.selected !== last.selected) {
      last.selected = s.selected;
      el.classList.toggle('selected', s.selected);
      el.setAttribute('aria-current', s.selected ? 'true' : 'false');
      const ti = s.selected ? '0' : '-1';
      for (const f of focusables) f.tabIndex = Number(ti);
    }
    if (s.inputsKey !== last.inputsKey) {
      last.inputsKey = s.inputsKey;
      const n = s.inputs.length;
      inputsBtn.hidden = !n;
      inputsBtn.lastChild.textContent = String(n);
      const names = s.inputs.map((c) => c.name).join(', ');
      inputsBtn.setAttribute('aria-label', `Inputs: ${names}`);
      inputsBtn.title = `Channels playing through this insert: ${names}`;
    }
    const send = s.send;
    const sendKey = send ? `${send.mode}|${send.from}|${send.color}` : '';
    if (sendKey !== last.sendKey) {
      last.sendKey = sendKey;
      sendRow.dataset.mode = send ? send.mode : 'none';
      sendRow.style.setProperty('--send-color', send?.color || 'var(--accent)');
      sendBtn.hidden = !send || send.mode === 'self';
      sendKnob.el.hidden = !send || send.mode !== 'on';
      sendNote.hidden = !send || send.mode !== 'self';
      sendNote.textContent = send?.mode === 'self' ? 'Source' : '';
      if (send && send.mode !== 'self') {
        const from = ctl.label(send.from);
        const to = ctl.label(index);
        sendBtn.setAttribute('aria-pressed', String(send.mode === 'on'));
        sendBtn.setAttribute('aria-label', `Send ${from} to ${to}`);
        sendBtn.setAttribute('aria-disabled', send.mode === 'blocked' ? 'true' : 'false');
        sendBtn.title = send.mode === 'blocked' ? `${to} feeds ${from} already; a send here would loop` : send.mode === 'on' ? `${from} sends here. Click to remove the send.` : `Click to send ${from} here`;
        sendKnob.el.setAttribute('aria-label', `Send level from ${from} to ${to}`);
        sendG = ctl.routeGesture(send.from, index);
      } else sendG = null;
    }
    last.send = send;
    if (send?.mode === 'on') sendKnob.set(send.gain);
  }

  return {
    el,
    index,
    meter,
    nameBtn,
    fader,
    update,
    focus() {
      nameBtn.focus({ preventScroll: false });
    },
    setTicks: (ticks) => fader.setTicks(ticks),
  };
}
