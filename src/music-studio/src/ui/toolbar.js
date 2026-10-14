// The top bar: menu bar, transport, tempo, position display, pattern picker,
// window toggles, master level, CPU meter, project status and account.

import { h } from '../lib/dom.js';
import { clamp, formatDb } from '../lib/util.js';
import { icon } from './icons.js';
import { createKnob } from './knob.js';
import { openMenu } from './menu.js';
import { createMenubar } from './menubar.js';
import { createAccount } from './account.js';
import { formatBST, formatTime } from '../model/time.js';
import { cssVar } from './theme.js';
import { patternColor } from '../model/project.js';

export const REPO_URL = 'https://github.com/HeyPuter/everything';

function cmdButton(app, id, glyph, { cls = '', size = 16, toggle = false, label } = {}) {
  const b = h(`button.icon-btn${cls}`, { type: 'button', 'aria-label': label || app.commands.label(id), onclick: () => app.commands.run(id) }, icon(glyph, size));
  const keys = app.commands.keysLabel(id);
  b.title = `${label || app.commands.label(id)}${keys ? ` (${keys})` : ''}`;
  b.dataset.hint = b.title;
  if (toggle) b.setAttribute('aria-pressed', 'false');
  b.sync = () => {
    if (toggle) b.setAttribute('aria-pressed', String(Boolean(app.commands.checked(id))));
    b.disabled = !app.commands.enabled(id);
  };
  return b;
}

export function createToolbar(app) {
  const bar = app.shell.topbar;
  const syncers = [];

  // ---------------------------------------------------------- menus
  const menubar = createMenubar(app);

  // ---------------------------------------------------------- transport
  const modeSeg = h('div.seg.mode-seg', { role: 'radiogroup', 'aria-label': 'Playback mode' });
  const modeBtn = (mode, text, hint) =>
    h('button', { type: 'button', role: 'radio', dataset: { mode, hint }, title: hint, onclick: () => app.setMode(mode) }, text);
  const patBtn = modeBtn('pattern', 'PAT', 'Pattern mode: play the selected pattern (L toggles)');
  const songBtn = modeBtn('song', 'SONG', 'Song mode: play the playlist arrangement (L toggles)');
  modeSeg.append(patBtn, songBtn);
  modeSeg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      app.setMode(app.engine.mode === 'pattern' ? 'song' : 'pattern');
      (app.engine.mode === 'pattern' ? patBtn : songBtn).focus();
    }
  });
  syncers.push(() => {
    for (const b of [patBtn, songBtn]) {
      const on = b.dataset.mode === app.engine.mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  });

  const play = cmdButton(app, 'transport.play', 'transport-play', { cls: '.transport-btn.play-btn' });
  const stop = cmdButton(app, 'transport.stop', 'transport-stop', { cls: '.transport-btn' });
  const rec = cmdButton(app, 'transport.record', 'transport-record', { cls: '.transport-btn.rec-btn', toggle: true });
  syncers.push(() => {
    play.replaceChildren(icon(app.engine.playing ? 'transport-pause' : 'transport-play', 16));
    play.setAttribute('aria-label', app.engine.playing ? 'Pause' : 'Play');
    play.title = `${app.engine.playing ? 'Pause' : 'Play'} (Space)`;
    play.classList.toggle('on', app.engine.playing);
    rec.sync();
  });

  // ---------------------------------------------------------- tempo
  const tempo = h('div.tempo', {
    role: 'spinbutton',
    tabindex: '0',
    'aria-label': 'Tempo in beats per minute',
    'aria-valuemin': '10',
    'aria-valuemax': '522',
    title: 'Tempo: drag up or down, scroll, or double-click to type (Shift for fine steps)',
    dataset: { hint: 'Tempo: drag, scroll or double-click to type. Shift for fine steps.' },
  });
  const tempoValue = h('span.tempo-value');
  tempo.append(tempoValue, h('span.tempo-unit', 'BPM'));
  const setBpm = (bpm, label = 'Change tempo') => app.setTempo(clamp(bpm, 10, 522), label);
  tempo.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    e.preventDefault();
    tempo.focus();
    tempo.setPointerCapture(e.pointerId);
    let last = e.clientY;
    let acc = app.store.project.bpm;
    app.store.begin('Change tempo');
    const move = (ev) => {
      const dy = last - ev.clientY;
      last = ev.clientY;
      acc = clamp(acc + dy * (ev.shiftKey ? 0.05 : 0.5), 10, 522);
      app.store.preview((p) => ({ ...p, bpm: Math.round(acc * (ev.shiftKey ? 100 : 1)) / (ev.shiftKey ? 100 : 1) }));
    };
    const up = () => {
      tempo.removeEventListener('pointermove', move);
      tempo.removeEventListener('pointerup', up);
      tempo.removeEventListener('pointercancel', up);
      app.store.commit();
    };
    tempo.addEventListener('pointermove', move);
    tempo.addEventListener('pointerup', up);
    tempo.addEventListener('pointercancel', up);
  });
  tempo.addEventListener('dblclick', () => typeTempo());
  tempo.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setBpm(app.store.project.bpm + Math.sign(-e.deltaY) * (e.shiftKey ? 0.1 : 1));
    },
    { passive: false },
  );
  tempo.addEventListener('keydown', (e) => {
    const b = app.store.project.bpm;
    const step = e.shiftKey ? 0.1 : 1;
    const map = { ArrowUp: b + step, ArrowDown: b - step, PageUp: b + 10, PageDown: b - 10 };
    if (e.key in map) {
      e.preventDefault();
      setBpm(Math.round(map[e.key] * 1000) / 1000);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      typeTempo();
    }
  });
  function typeTempo() {
    const input = h('input.input.sm.tempo-input', { type: 'text', inputmode: 'decimal', value: String(app.store.project.bpm), 'aria-label': 'Tempo in BPM' });
    tempo.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const close = (apply) => {
      if (done) return;
      done = true;
      const v = Number(input.value.replace(',', '.'));
      if (apply && Number.isFinite(v) && v > 0) setBpm(v);
      tempo.replaceChildren(tempoValue, h('span.tempo-unit', 'BPM'));
      tempo.focus();
      syncTempo();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }
  const syncTempo = () => {
    const b = app.store.project.bpm;
    tempoValue.textContent = b.toFixed(3);
    tempo.setAttribute('aria-valuenow', String(b));
    tempo.setAttribute('aria-valuetext', `${b} BPM`);
  };
  syncers.push(syncTempo);

  // ---------------------------------------------------------- position display
  let timeMode = 'bst';
  const timeMain = h('span.time-main');
  const timeSub = h('span.time-sub');
  const time = h(
    'button.time-display',
    {
      type: 'button',
      'aria-label': 'Song position. Activate to switch between bars and minutes.',
      title: 'Click to switch between bars:steps:ticks and minutes:seconds',
      dataset: { hint: 'Song position. Click to switch between bars:steps:ticks and minutes:seconds.' },
      onclick: () => {
        timeMode = timeMode === 'bst' ? 'time' : 'bst';
        app.prefs.set('timeMode', timeMode);
        drawTime(true);
      },
    },
    timeMain,
    timeSub,
  );
  timeMode = app.prefs.get('timeMode') || 'bst';
  let lastTimeText = '';
  const drawTime = (force) => {
    const p = app.store.project;
    const pos = app.engine.position;
    const text = timeMode === 'bst' ? formatBST(pos, p.sig) : formatTime(pos, p.bpm);
    if (!force && text === lastTimeText) return;
    lastTimeText = text;
    timeMain.textContent = text;
    timeSub.textContent = timeMode === 'bst' ? 'B:S:T' : 'M:S:CS';
  };

  // ---------------------------------------------------------- option toggles
  const metro = cmdButton(app, 'options.metronome', 'metronome', { toggle: true });
  const countIn = cmdButton(app, 'options.countIn', 'countin', { toggle: true });
  const typing = cmdButton(app, 'options.typingKeyboard', 'keyboard', { toggle: true });
  syncers.push(() => [metro, countIn, typing].forEach((b) => b.sync()));

  // ---------------------------------------------------------- pattern picker
  const patSwatch = h('span.pattern-swatch');
  const patName = h('span.pattern-name');
  const patPick = h(
    'button.pattern-picker',
    { type: 'button', 'aria-haspopup': 'menu', title: 'Select pattern', dataset: { hint: 'Select the pattern to edit and play. F4 makes a new one; Num + and - step through them.' } },
    patSwatch,
    patName,
    icon('chevron-down', 14),
  );
  patPick.addEventListener('click', () => {
    const p = app.store.project;
    openMenu(
      [
        ...p.patterns.map((pat, i) => ({ type: 'radio', label: `${i + 1}. ${pat.name}`, checked: pat.id === app.store.view.pattern, swatch: patternColor(p, pat), run: () => app.store.setPattern(pat.id) })),
        { type: 'sep' },
        app.commands.menuItem('patterns.new'),
        app.commands.menuItem('patterns.clone'),
        app.commands.menuItem('patterns.rename'),
      ].filter(Boolean),
      { anchor: patPick, label: 'Patterns' },
    );
  });
  const patNew = cmdButton(app, 'patterns.new', 'plus', { cls: '.sm', size: 14 });
  const patGroup = h('div.pattern-group', h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Previous pattern', title: 'Previous pattern (Num -)', onclick: () => app.commands.run('patterns.prev') }, icon('chevron-left', 14)), patPick, h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Next pattern', title: 'Next pattern (Num +)', onclick: () => app.commands.run('patterns.next') }, icon('chevron-right', 14)), patNew);
  syncers.push(() => {
    const p = app.store.project;
    const pat = app.store.pattern;
    patSwatch.style.background = patternColor(p, pat);
    patName.textContent = pat.name;
    patPick.setAttribute('aria-label', `Pattern: ${pat.name}. Select pattern`);
  });

  // ---------------------------------------------------------- windows
  const wins = [
    ['view.playlist', 'win-playlist', 'playlist'],
    ['view.rack', 'win-rack', 'rack'],
    ['view.pianoRoll', 'win-piano', 'pianoRoll'],
    ['view.mixer', 'win-mixer', 'mixer'],
    ['view.browser', 'win-browser', 'browser'],
  ].map(([id, glyph, panel]) => {
    const b = cmdButton(app, id, glyph, { size: 18, toggle: true });
    b.sync = () => b.setAttribute('aria-pressed', String(app.shell.isVisible(panel)));
    return b;
  });
  syncers.push(() => wins.forEach((b) => b.sync()));
  const winGroup = h('div.tb-group.win-group', { role: 'group', 'aria-label': 'Windows' }, ...wins);

  // ---------------------------------------------------------- master, meter, cpu
  const masterParam = { id: 'volume', label: 'Master', min: 0, max: 1.25, def: 0.8 };
  const master = createKnob({
    param: masterParam,
    value: app.store.project.mixer[0].volume,
    label: 'Master',
    ariaLabel: 'Master volume',
    size: 26,
    showLabel: false,
    format: formatDb,
    onStart: () => app.store.begin('Master volume'),
    onInput: (v) => app.store.preview((p) => ({ ...p, mixer: [{ ...p.mixer[0], volume: v }, ...p.mixer.slice(1)] })),
    onEnd: () => app.store.commit(),
  });
  master.el.dataset.hint = 'Master volume';
  syncers.push(() => master.set(app.store.project.mixer[0].volume));

  const meterCanvas = h('canvas.tb-meter', { width: 8, height: 28, 'aria-hidden': 'true' });
  const cpuFill = h('span.cpu-fill');
  const cpuText = h('span.cpu-text', '0%');
  const cpu = h('div.cpu', { role: 'meter', 'aria-label': 'Audio engine load', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', title: 'Audio engine load', dataset: { hint: 'Audio engine load: the share of real time the audio engine needs.' } }, h('span.cpu-bar', cpuFill), cpuText);
  let lastCpu = -1;
  const drawMeters = () => {
    const m = app.engine.meters;
    const c = meterCanvas.getContext('2d');
    const w = meterCanvas.width;
    const ht = meterCanvas.height;
    c.clearRect(0, 0, w, ht);
    c.fillStyle = cssVar('--meter-bg');
    c.fillRect(0, 0, w, ht);
    for (let ch = 0; ch < 2; ch++) {
      const peak = Math.min(1, m[ch] || 0);
      const db = peak > 0 ? 20 * Math.log10(peak) : -60;
      const frac = clamp((db + 60) / 60, 0, 1);
      c.fillStyle = cssVar(db > -1 ? '--meter-high' : db > -9 ? '--meter-mid' : '--meter-low');
      c.fillRect(ch * 4, ht - frac * ht, 3, frac * ht);
    }
    const pct = Math.round((app.engine.cpu || 0) * 100);
    if (pct !== lastCpu) {
      lastCpu = pct;
      cpuFill.style.width = `${clamp(pct, 0, 100)}%`;
      cpuText.textContent = `${pct}%`;
      cpu.setAttribute('aria-valuenow', String(pct));
    }
  };

  // ---------------------------------------------------------- project status
  const projName = h('span.project-name');
  const projState = h('span.project-state');
  const project = h('button.project-status', { type: 'button', title: 'Project settings', onclick: () => app.commands.run('project.settings') }, projName, projState);
  syncers.push(() => {
    projName.textContent = app.store.project.name;
    const saving = app.saving;
    projState.textContent = saving ? 'Saving...' : app.store.dirty ? 'Edited' : app.file?.path ? 'Saved' : app.file?.local ? 'Saved on this device' : '';
    project.setAttribute('aria-label', `Project: ${app.store.project.name}. ${projState.textContent}. Open project settings`);
    document.title = `${app.store.dirty ? '• ' : ''}${app.store.project.name} - Music Studio`;
  });

  const github = h('a.icon-btn.github-link', { href: REPO_URL, target: '_blank', rel: 'noopener', 'aria-label': 'Source code on GitHub (opens in a new tab)', title: 'Source code on GitHub', dataset: { hint: 'Music Studio is open source. View the code on GitHub.' } }, icon('github', 16));
  const account = createAccount(app);

  // ---------------------------------------------------------- layout
  const transport = h('div.tb-group.transport', { role: 'group', 'aria-label': 'Transport' }, modeSeg, play, stop, rec);
  const lcd = h('div.tb-group.lcd', tempo, time);
  const opts = h('div.tb-group.tb-options', { role: 'group', 'aria-label': 'Recording options' }, metro, countIn, typing);
  const right = h('div.tb-right', h('div.tb-group.tb-master', master.el, meterCanvas, cpu), project, github, account);
  bar.append(h('div.tb-row', menubar.el, transport, lcd, opts, h('div.tb-group.tb-pattern', patGroup), winGroup, h('div.tb-spacer'), right));

  const sync = () => {
    for (const s of syncers) s();
    drawTime(true);
  };
  app.store.on('change', sync);
  app.store.on('view', sync);
  app.store.on('saved', sync);
  app.engine.on('state', sync);
  app.on('layout', sync);
  app.on('saving', sync);
  app.prefs.on('change', sync);
  app.on('frame', () => {
    drawTime(false);
    drawMeters();
  });
  sync();
  return { sync, menubar };
}
