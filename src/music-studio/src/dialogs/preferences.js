// Preferences: General (theme, hints, layout, warnings), Audio (latency,
// sample rate, output device, test tone, MIDI input) and Saving (cloud
// autosave, where projects are kept). Changes apply immediately.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';

const LATENCY = [
  { value: 'interactive', label: 'Lowest latency', hint: 'Best for playing live. Needs a fast device.' },
  { value: 'balanced', label: 'Balanced', hint: 'A little more delay, fewer dropouts.' },
  { value: 'playback', label: 'Most stable', hint: 'For slower devices and big projects. Playing live feels delayed.' },
];
const RATES = [
  { value: 'auto', label: 'Device default' },
  { value: 44100, label: '44.1 kHz' },
  { value: 48000, label: '48 kHz' },
  { value: 96000, label: '96 kHz' },
];

let seq = 0;
const nid = (p) => `${p}-${++seq}`;

function selectRow(label, options, value, onChange, hint) {
  const id = nid('pref');
  const sel = h('select.select', { id, onchange: () => onChange(sel.value) }, options.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(value) }, o.label)));
  return h('div.pref-row', h('label', { for: id }, label), h('div.pref-control', sel, hint ? h('div.pref-hint', hint) : null));
}

function checkRow(label, checked, onChange, hint) {
  const id = nid('pref');
  const box = h('input', { id, type: 'checkbox', checked, onchange: () => onChange(box.checked) });
  return h('div.pref-row.pref-check', h('div'), h('div.pref-control', h('label.check', { for: id }, box, h('span', label)), hint ? h('div.pref-hint', hint) : null));
}

function buttonRow(label, text, onClick, hint) {
  return h('div.pref-row', h('span.pref-label', label), h('div.pref-control', h('button.btn.sm', { type: 'button', onclick: onClick }, text), hint ? h('div.pref-hint', hint) : null));
}

export async function openPreferences(app, { section = 'general' } = {}) {
  const prefs = app.prefs;
  const engine = app.engine;

  // ---------------------------------------------------------------- general
  const general = h(
    'div.pref-section',
    selectRow('Theme', [{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], prefs.get('theme'), (v) => app.commands.run(`theme.${v}`)),
    checkRow('Show hints in the status bar', prefs.get('hints') !== false, (v) => prefs.set('hints', v), 'Describes the control under the pointer.'),
    buttonRow('Window layout', 'Reset layout', () => {
      app.commands.run('view.resetLayout');
      app.notify('Window layout reset');
    }),
    buttonRow('Messages', 'Show all messages again', () => {
      prefs.set('dismissedNotices', []);
      try {
        localStorage.removeItem('music-studio:alphaNoticeSeen');
      } catch {
        // Blocked storage: nothing was remembered anyway.
      }
      app.notify('Dismissed messages will show again');
    }, 'One-time notices, such as the alpha notice and the save tips, show again.'),
  );

  // ---------------------------------------------------------------- audio
  const latencyHint = h('div.pref-hint');
  const syncLatencyHint = (v) => {
    latencyHint.textContent = `${LATENCY.find((l) => l.value === v)?.hint || ''} Applies the next time audio starts.`;
  };
  const latency = selectRow('Latency', LATENCY, prefs.get('latencyHint'), (v) => {
    prefs.set('latencyHint', v);
    syncLatencyHint(v);
    engine.restart?.();
  });
  latency.querySelector('.pref-control').append(latencyHint);
  syncLatencyHint(prefs.get('latencyHint'));

  const rate = selectRow('Sample rate', RATES, prefs.get('sampleRate') ?? 'auto', (v) => {
    prefs.set('sampleRate', v === 'auto' ? 'auto' : Number(v));
    engine.restart?.();
  }, 'Applies the next time audio starts. Exports choose their own rate.');

  const audio = h('div.pref-section', latency, rate);
  const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  if (canSink && navigator.mediaDevices?.enumerateDevices) {
    const id = nid('pref');
    const sel = h('select.select', { id }, h('option', { value: '' }, 'System default'));
    const row = h('div.pref-row', h('label', { for: id }, 'Output device'), h('div.pref-control', sel, h('div.pref-hint', 'Device names appear once the browser has allowed audio input.')));
    audio.append(row);
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        const outs = list.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default');
        outs.forEach((d, i) => sel.append(h('option', { value: d.deviceId, selected: d.deviceId === prefs.get('outputDevice') }, d.label || `Output ${i + 1}`)));
      })
      .catch(() => {});
    sel.addEventListener('change', async () => {
      prefs.set('outputDevice', sel.value);
      try {
        if (engine.setOutputDevice) await engine.setOutputDevice(sel.value);
        else if (engine.ctx?.setSinkId) await engine.ctx.setSinkId(sel.value);
      } catch (err) {
        app.notify(`That output could not be used: ${err?.message || err}`, { error: true });
      }
    });
  }
  audio.append(
    buttonRow('Test', 'Play test tone', async () => {
      try {
        await engine.start();
        const stop = engine.audition?.({ type: 'synth', params: { osc1_wave: 0, osc2_level: 0, sub_level: 0, cutoff: 20000, a_attack: 10, a_sustain: 1, a_release: 80, vel_amp: 0, gain: 0.5 } }, 69, 0.7);
        setTimeout(() => stop?.(), 900);
      } catch (err) {
        app.reportError(err);
      }
    }, 'A one-second A at 440 Hz through the master output.'),
  );
  if (app.commands.has('options.midiInput')) {
    audio.append(checkRow('MIDI keyboard input', Boolean(app.commands.checked('options.midiInput')), () => app.commands.run('options.midiInput'), 'Play instruments from a connected MIDI keyboard.'));
  }

  // ---------------------------------------------------------------- saving
  const signedIn = puter.isSignedIn();
  const where = h('p.pref-note', signedIn ? 'Projects save to MusicStudio/Projects in your Puter cloud. Your current session is also kept in this browser, so a reload never loses work.' : 'You are not signed in, so projects save in this browser on this device. Your current session is kept automatically, so a reload never loses work.');
  const saving = h(
    'div.pref-section',
    where,
    checkRow('Autosave cloud projects', prefs.get('cloudAutosave') !== false, (v) => prefs.set('cloudAutosave', v), 'Saves a project that is in your Puter cloud a minute after you stop editing, and when you leave the page.'),
  );
  if (!signedIn && puter.sdk() && puter.env() !== 'app') {
    saving.append(buttonRow('Puter cloud', 'Sign in', () => app.signIn?.(), 'Save projects to your Puter cloud and open them on any device.'));
  }
  const usage = h('div.pref-hint');
  saving.append(h('div.pref-row', h('span.pref-label', 'This browser'), h('div.pref-control', usage)));
  navigator.storage
    ?.estimate?.()
    .then((e) => {
      if (e?.usage !== undefined) usage.textContent = `${(e.usage / 1024 / 1024).toFixed(1)} MB used by Music Studio and other data for this site.`;
    })
    .catch(() => {});

  // ---------------------------------------------------------------- tabs
  const sections = [
    { id: 'general', label: 'General', el: general },
    { id: 'audio', label: 'Audio', el: audio },
    { id: 'saving', label: 'Saving', el: saving },
  ];
  const tabs = h('div.pref-tabs', { role: 'tablist', 'aria-label': 'Preferences', 'aria-orientation': 'vertical' });
  const panels = h('div.pref-panels');
  const select = (id, focus = false) => {
    for (const s of sections) {
      const on = s.id === id;
      s.tab.setAttribute('aria-selected', String(on));
      s.tab.tabIndex = on ? 0 : -1;
      s.el.hidden = !on;
      if (on && focus) s.tab.focus();
    }
  };
  for (const s of sections) {
    const tabId = nid('tab');
    const panelId = nid('tabpanel');
    s.tab = h('button.pref-tab', { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, onclick: () => select(s.id) }, s.label);
    s.el.id = panelId;
    s.el.setAttribute('role', 'tabpanel');
    s.el.setAttribute('aria-labelledby', tabId);
    tabs.append(s.tab);
    panels.append(s.el);
  }
  tabs.addEventListener('keydown', (e) => {
    const i = sections.findIndex((s) => s.tab === document.activeElement);
    const moves = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (e.key in moves) {
      e.preventDefault();
      select(sections[(i + moves[e.key] + sections.length) % sections.length].id, true);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      select(sections[e.key === 'Home' ? 0 : sections.length - 1].id, true);
    }
  });
  select(sections.some((s) => s.id === section) ? section : 'general');

  await openDialog({
    title: 'Preferences',
    wide: true,
    className: 'dlg-prefs',
    body: h('div.prefs', tabs, panels),
    buttons: [{ label: 'Done', value: true, primary: true }],
    initialFocus: '.pref-tab[aria-selected="true"]',
  });
}
