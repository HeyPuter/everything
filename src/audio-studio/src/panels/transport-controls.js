// Transport, zoom and time controls shared by the editor's transport bar and
// the standalone Transport, Time and Zoom panels. Every button runs a command
// by id (data-cmd), so syncButtons() can refresh enabled and pressed states
// for any copy of them.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import '../editor/editor-icons.js';

/**
 * [command, icon, label, command whose key the label names] for the transport
 * buttons, in display order.
 */
export const TRANSPORT_BUTTONS = [
  ['transport.stop', 'transport-stop', 'Stop'],
  ['transport.play', 'transport-play', 'Play', 'transport.toggle'],
  ['transport.pause', 'transport-pause', 'Pause'],
  ['transport.previous', 'transport-start', 'Move Playhead to Previous'],
  ['transport.rewind', 'transport-rewind', 'Rewind'],
  ['transport.forward', 'transport-forward', 'Fast Forward'],
  ['transport.next', 'transport-end', 'Move Playhead to Next'],
  ['transport.record', 'transport-record', 'Record', 'transport.record'],
  ['transport.loop', 'transport-loop', 'Loop Playback'],
  ['transport.skipSelection', 'transport-skip-selection', 'Skip Selection'],
];

/** The zoom buttons of the editor's transport bar. */
export const ZOOM_BUTTONS = [
  ['view.zoomInAmp', 'zoom-in-amp', 'Zoom In (Amplitude)'],
  ['view.zoomOutAmp', 'zoom-out-amp', 'Zoom Out (Amplitude)'],
  ['view.zoomInTime', 'zoom-in-time', 'Zoom In (Time)'],
  ['view.zoomOutTime', 'zoom-out-time', 'Zoom Out (Time)'],
  ['view.zoomFull', 'zoom-full', 'Zoom Out Full (All Axes)'],
  ['view.zoomInPoint', 'zoom-in-point', 'Zoom In at In Point'],
  ['view.zoomOutPoint', 'zoom-out-point', 'Zoom In at Out Point'],
  ['view.zoomSelection', 'zoom-selection', 'Zoom to Selection'],
  ['view.zoomResetTime', 'zoom-reset', 'Zoom Reset (Time)'],
  ['view.zoomInTrack', 'zoom-in-track', 'Zoom In Full (Selected Track)'],
];

/** `label` with the current key of command `keyOf`, "Play (Space)", or `label` when it has none. */
export function keyedLabel(app, keyOf, label) {
  const key = app.commands.shortcutLabel(keyOf);
  return key ? `${label} (${key})` : label;
}

/** Gives a button made with `keyOf` the key its command has now (keys can be remapped). */
export function syncKeyedLabel(app, b) {
  if (!b.dataset.keyOf) return;
  const text = keyedLabel(app, b.dataset.keyOf, b.dataset.label);
  if (b.title === text) return;
  b.title = text;
  b.setAttribute('aria-label', text);
}

/** An icon button that runs `cmd`; with `keyOf`, its label names that command's key. */
export function commandButton(app, cmd, ic, label, { cls = '', size = 16, args, keyOf } = {}) {
  const text = keyOf ? keyedLabel(app, keyOf, label) : label;
  const dataset = keyOf ? { cmd, label, keyOf } : { cmd };
  const run = () => app.commands.run(cmd, args);
  return h(
    `button.icon-btn${cls}`,
    { type: 'button', 'aria-label': text, title: text, dataset, onclick: run },
    icon(ic, size),
  );
}

/** Holding rewind or fast forward shuttles the playhead after a short delay. */
function shuttle(app, b, cmd) {
  let timer = 0;
  let delay = 0;
  let shuttled = false;
  b.addEventListener('pointerdown', () => {
    shuttled = false;
    delay = setTimeout(() => {
      shuttled = true;
      timer = setInterval(() => app.commands.run(cmd, { shuttle: true }), 60);
    }, 350);
  });
  // Releasing after a shuttle is not also a click (a one-second jump on top of it).
  b.addEventListener(
    'click',
    (e) => {
      if (!shuttled) return;
      shuttled = false;
      e.stopImmediatePropagation();
    },
    true,
  );
  const stop = () => {
    clearTimeout(delay);
    clearInterval(timer);
  };
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointerleave', stop);
  b.addEventListener('pointercancel', stop);
}

/**
 * The transport buttons. Returns { list, byCmd, update } where update()
 * reflects playing, recording, loop and skip-selection state.
 */
export function transportButtons(app, { size = 16 } = {}) {
  const byCmd = {};
  const list = TRANSPORT_BUTTONS.map(([cmd, ic, label, keyOf]) => {
    const cls = `.transport-btn${cmd === 'transport.record' ? '.record' : ''}`;
    const b = commandButton(app, cmd, ic, label, { cls, size, keyOf });
    byCmd[cmd] = b;
    return b;
  });
  shuttle(app, byCmd['transport.rewind'], 'transport.rewind');
  shuttle(app, byCmd['transport.forward'], 'transport.forward');
  const update = () => {
    const playing = app.engine.playing;
    const play = byCmd['transport.play'];
    const rec = byCmd['transport.record'];
    play.classList.toggle('on', playing);
    play.setAttribute('aria-pressed', String(playing));
    rec.classList.toggle('on', Boolean(app.recording));
    rec.setAttribute('aria-pressed', String(Boolean(app.recording)));
    byCmd['transport.loop'].setAttribute('aria-pressed', String(app.loop));
    byCmd['transport.skipSelection'].setAttribute('aria-pressed', String(Boolean(app.prefs.get('skipSelection'))));
    syncButtons(app, list, { pressed: false });
  };
  return { list, byCmd, update };
}

/** Zoom buttons for [cmd, icon, label] specs (default: the transport bar's set). */
export function zoomButtons(app, specs = ZOOM_BUTTONS, { size = 16, cls = '.transport-btn' } = {}) {
  const list = specs.map(([cmd, ic, label]) => commandButton(app, cmd, ic, label, { cls, size }));
  return { list, update: () => syncButtons(app, list, { pressed: false }) };
}

/**
 * Refreshes command buttons: disabled from `enabled`, aria-pressed from
 * `checked` for commands that have one (unless `pressed` is false).
 * Buttons whose command is not registered are hidden.
 */
export function syncButtons(app, buttons, { pressed = true } = {}) {
  for (const b of buttons) {
    const id = b.dataset.cmd;
    const cmd = app.commands.get(id);
    b.hidden = !cmd;
    if (!cmd) continue;
    b.disabled = !app.commands.isEnabled(id);
    if (pressed && cmd.checked) b.setAttribute('aria-pressed', String(app.commands.isChecked(id)));
    syncKeyedLabel(app, b);
  }
}

/** Playhead time text in the current format (zero when no file is open). */
export function playheadText(app) {
  return app.active ? app.formatTime(Math.round(app.playhead)) : app.formatTime(0, 48000);
}

/** Opens the time display format menu next to `anchor`. */
export function openTimeFormatMenu(app, anchor, { above = false } = {}) {
  const r = anchor.getBoundingClientRect();
  app.openMenu(app.timeFormatMenuItems?.() || [], { x: r.left, y: above ? r.top - 4 : r.bottom + 2, above, anchor, label: 'Time display format' });
}
