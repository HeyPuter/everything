// Hardware control surfaces over Web MIDI. Preferences > Control Surface
// turns it on, picks the input and output ports and the protocol (see
// protocol.js), and edits learned mappings. Settings live in the
// `controlSurface` pref: { enabled, input, output, protocol, mappings }.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { allTracks, findTrack } from '../model/session-edits.js';
import { dbToFader, faderToDb } from '../multitrack/levels.js';
import { decodeMidi, mcuAction, mcuFeedback, mappingKey, learnAction, LEARN_TARGETS } from './protocol.js';

export const SURFACE_DEFAULTS = { enabled: false, input: '', output: '', protocol: 'mcu', mappings: {} };

export const midiSupported = () => typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';

export function surfaceSettings(prefs) {
  return { ...SURFACE_DEFAULTS, ...(prefs.get('controlSurface') || {}), mappings: { ...(prefs.get('controlSurface')?.mappings || {}) } };
}

export function installControlSurface(app) {
  let access = null;
  let input = null;
  let output = null;
  let offset = 0; // bank: first track on strip 1
  let learning = null; // (msg) => void while a mapping waits for a control
  let feedbackTimer = 0;
  const ccValues = new Map(); // last value of each learned CC, for command triggering
  const settings = () => surfaceSettings(app.prefs);
  const session = () => (app.active?.kind === 'session' ? app.active : null);
  const stripTracks = () => {
    const doc = session();
    return doc ? allTracks(doc.state).filter((t) => t.type !== 'master' && !t.hidden) : [];
  };
  const master = () => {
    const doc = session();
    return doc ? allTracks(doc.state).find((t) => t.type === 'master') : null;
  };

  const status = { text: 'Off', listeners: new Set() };
  const setStatus = (text) => {
    status.text = text;
    for (const fn of status.listeners) fn(text);
  };

  async function connect() {
    disconnect();
    const s = settings();
    if (!s.enabled) return setStatus('Off');
    if (!midiSupported()) return setStatus('This browser has no MIDI support.');
    try {
      access = access || (await navigator.requestMIDIAccess({ sysex: false }));
    } catch {
      return setStatus('MIDI access was not allowed.');
    }
    watchPorts();
    input = pickInput(s);
    output = pickOutput(s);
    if (!input) return setStatus('No MIDI input connected.');
    input.onmidimessage = (e) => onMessage(e.data);
    setStatus(`Listening to ${input.name}`);
    scheduleFeedback();
  }

  const live = (ports) => [...ports.values()].filter((p) => p.state !== 'disconnected');
  const pickInput = (s) => live(access.inputs).find((p) => p.id === s.input) || (s.input ? null : live(access.inputs)[0]) || null;
  const pickOutput = (s) => live(access.outputs).find((p) => p.id === s.output) || null;

  // Devices plugged in or out: refresh the port lists and reconnect when the chosen ports change.
  function watchPorts() {
    access.onstatechange = () => {
      app.emit('midi-ports');
      const s = settings();
      if (s.enabled && (pickInput(s) !== input || pickOutput(s) !== output)) connect();
    };
  }

  function disconnect() {
    if (input) input.onmidimessage = null;
    input = null;
    output = null;
  }

  function onMessage(data) {
    const msg = decodeMidi(data);
    if (!msg) return;
    if (learning && (msg.type === 'noteon' || msg.type === 'cc' || msg.type === 'pitchbend')) {
      const done = learning;
      learning = null;
      done(msg);
      return;
    }
    const s = settings();
    const action = s.protocol === 'mcu' ? mcuAction(msg) : learnAction(msg, s.mappings, ccValues);
    if (action) perform(action);
  }

  function setVolume(track, pos, phase = 'input') {
    const doc = session();
    if (!doc || !track) return;
    doc.controls?.set(track.id, 'volume', Math.round(faderToDb(pos) * 10) / 10, phase);
  }

  function perform(a) {
    const doc = session();
    const tracks = stripTracks();
    const at = (strip) => tracks[offset + strip];
    switch (a.kind) {
      case 'command':
        app.commands.run(a.id);
        break;
      case 'fader':
        setVolume(at(a.strip), a.value);
        break;
      case 'master':
        setVolume(master(), a.value);
        break;
      case 'selectedVolume':
        setVolume(doc && findTrack(doc.state, doc.selectedTrack), a.value);
        break;
      case 'selectedPan': {
        const t = doc && findTrack(doc.state, doc.selectedTrack);
        if (t) doc.controls?.set(t.id, 'pan', Math.round(a.value * 200 - 100), 'input');
        break;
      }
      case 'pan': {
        const t = at(a.strip);
        if (t) doc.controls?.set(t.id, 'pan', Math.max(-100, Math.min(100, (doc.controls.value(t, 'pan') ?? t.pan) + a.delta)), 'input');
        break;
      }
      case 'toggle': {
        const t = at(a.strip);
        if (t) doc.controls?.toggle(t.id, a.key);
        break;
      }
      case 'select': {
        const t = at(a.strip);
        if (t && doc.selectTrack) doc.selectTrack(t.id);
        break;
      }
      case 'bank':
        offset = Math.max(0, Math.min(Math.max(0, tracks.length - 1), offset + a.delta));
        app.setStatus(`Control surface: tracks ${offset + 1}-${Math.min(tracks.length, offset + 8)}`);
        break;
      default:
    }
    scheduleFeedback();
  }

  // Lights and motor faders follow the session, at most every 50 ms.
  function scheduleFeedback() {
    if (!output || settings().protocol !== 'mcu' || feedbackTimer) return;
    feedbackTimer = setTimeout(() => {
      feedbackTimer = 0;
      const doc = session();
      const tracks = stripTracks().map((t) => ({ ...t, selected: doc?.selectedTrack === t.id }));
      for (const m of mcuFeedback({ tracks, master: master(), offset, playing: app.engine.playing, recording: Boolean(app.recording), loop: app.loop, faderPos: dbToFader })) {
        try {
          output.send(m);
        } catch {
          // Port went away; the next state change reconnects.
        }
      }
    }, 50);
  }

  app.prefs.on('change', (key) => key === 'controlSurface' && connect());
  for (const ev of ['transport', 'active', 'doc-change']) app.on(ev, scheduleFeedback);
  if (settings().enabled) connect();

  app.controlSurface = {
    status,
    ports: () => ({ inputs: access ? [...access.inputs.values()] : [], outputs: access ? [...access.outputs.values()] : [] }),
    /** Requests MIDI access (from a click) so the port lists fill in. */
    async requestAccess() {
      if (!midiSupported()) return false;
      try {
        access = access || (await navigator.requestMIDIAccess({ sysex: false }));
        watchPorts();
        return true;
      } catch {
        return false;
      }
    },
    /** Waits for the next control the user moves; resolves its mapping key (or null on cancel). */
    learn() {
      return new Promise((resolve) => {
        learning = (msg) => resolve(mappingKey(msg));
        this.cancelLearn = () => {
          learning = null;
          resolve(null);
        };
      });
    },
    cancelLearn() {},
    perform,
  };

  app.preferenceSections = app.preferenceSections || [];
  app.preferenceSections.push({ category: 'controlSurface', title: '', keys: ['controlSurface'], keywords: 'control surface midi controller hardware mixer faders mappings learn', build: () => surfacePrefs(app) });
}

/** Preferences > Control Surface page body. */
function surfacePrefs(app) {
  const cs = app.controlSurface;
  const s = () => surfaceSettings(app.prefs);
  const save = (patch) => app.prefs.set('controlSurface', { ...s(), ...patch });
  const wrap = h('div.surface-prefs');
  const render = () => {
    const cur = s();
    const { inputs, outputs } = cs.ports();
    const enabled = h('input', { type: 'checkbox', checked: cur.enabled, onchange: async (e) => {
      if (e.target.checked) await cs.requestAccess();
      save({ enabled: e.target.checked });
      render();
    } });
    const portSelect = (list, value, key, none) =>
      h('select.select', { 'aria-label': key === 'input' ? 'MIDI input' : 'MIDI output', disabled: !cur.enabled, onchange: (e) => save({ [key]: e.target.value }) }, [h('option', { value: '' }, none), ...list.map((p) => h('option', { value: p.id, selected: p.id === value }, p.name || p.id))]);
    const proto = h(
      'select.select',
      { 'aria-label': 'Protocol', disabled: !cur.enabled, onchange: (e) => (save({ protocol: e.target.value }), render()) },
      h('option', { value: 'mcu', selected: cur.protocol === 'mcu' }, 'DAW controller (8 channel strips)'),
      h('option', { value: 'learn', selected: cur.protocol === 'learn' }, 'Custom mappings (MIDI learn)'),
    );
    const statusEl = h('p.faint', { role: 'status' }, midiSupported() ? cs.status.text : 'This browser has no MIDI support. Use a Chromium-based browser to connect hardware.');
    const rows = [
      h('label.check', enabled, 'Use a MIDI control surface'),
      h('div.form-grid', h('label', 'Input:'), portSelect(inputs, cur.input, 'input', inputs.length ? 'First available' : 'No inputs found'), h('label', 'Output (lights, motor faders):'), portSelect(outputs, cur.output, 'output', 'None'), h('label', 'Protocol:'), proto),
      statusEl,
    ];
    if (cur.protocol === 'mcu') {
      rows.push(h('p.muted', 'Faders, encoders and mute, solo, arm and select buttons control the first eight visible tracks of the session; bank buttons move to the next eight. Transport buttons control playback and recording.'));
    } else {
      rows.push(learnTable(app, cur, save, render));
    }
    wrap.replaceChildren(...rows);
  };
  const onStatus = (text) => {
    const el = wrap.querySelector('[role=status]');
    if (el) el.textContent = text;
  };
  cs.status.listeners.add(onStatus);
  app.on('midi-ports', () => wrap.isConnected && render());
  render();
  return wrap;
}

function learnTable(app, cur, save, render) {
  const cs = app.controlSurface;
  const byTarget = new Map(Object.entries(cur.mappings).map(([k, t]) => [t, k]));
  const label = (key) => {
    if (!key) return 'Not assigned';
    const [type, ch, num] = key.split(':');
    if (type === 'pb') return `Pitch bend, channel ${Number(ch) + 1}`;
    return `${type === 'cc' ? 'CC' : 'Note'} ${num}, channel ${Number(ch) + 1}`;
  };
  return h(
    'table.data-table.surface-map',
    h('thead', h('tr', h('th', 'Action'), h('th', 'Control'), h('th', ''))),
    h(
      'tbody',
      LEARN_TARGETS.map((t) => {
        const key = byTarget.get(t.id);
        const learnBtn = h('button.btn', { type: 'button', disabled: !cur.enabled }, 'Learn');
        learnBtn.addEventListener('click', async () => {
          learnBtn.textContent = 'Move a control...';
          learnBtn.classList.add('capturing');
          const k = await cs.learn();
          if (!k) return render();
          const mappings = Object.fromEntries(Object.entries(surfaceSettings(app.prefs).mappings).filter(([mk, mt]) => mk !== k && mt !== t.id));
          mappings[k] = t.id;
          save({ mappings });
          render();
        });
        const clear = h('button.icon-btn', { type: 'button', 'aria-label': `Clear ${t.label}`, title: 'Clear', disabled: !key, onclick: () => {
          const mappings = { ...surfaceSettings(app.prefs).mappings };
          delete mappings[key];
          save({ mappings });
          render();
        } }, icon('x', 14));
        return h('tr', h('td', t.label), h('td.muted', label(key)), h('td.kbd-cell', learnBtn, clear));
      }),
    ),
  );
}
