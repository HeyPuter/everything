// Transport panel: the editor's transport buttons in a frame of their own, so
// a workspace can place them anywhere (or hide the editor's bar behind a
// maximized editor). Buttons reflect playing, recording, loop and skip state.

import { h } from '../lib/dom.js';
import { transportButtons } from './transport-controls.js';
import { toolbarKeys } from './toolbar-keys.js';

/** Buttons in clusters that wrap as a whole when the frame is narrow: play, locate, record and modes. */
const CLUSTERS = [
  ['transport.stop', 'transport.play', 'transport.pause'],
  ['transport.previous', 'transport.rewind', 'transport.forward', 'transport.next'],
  ['transport.record', 'transport.loop', 'transport.skipSelection'],
];

export function transportPanel(app) {
  const buttons = transportButtons(app, { size: 18 });
  for (const b of buttons.list) b.classList.add('tool-panel-btn');
  const placed = new Set();
  const clusters = CLUSTERS.map((ids) => {
    const list = ids.map((id) => buttons.list.find((b) => b.dataset.cmd === id)).filter(Boolean);
    list.forEach((b) => placed.add(b));
    return h('div.button-cluster', { role: 'group' }, list);
  });
  // Anything not in a cluster (a button added later) still shows, at the end.
  const rest = buttons.list.filter((b) => !placed.has(b));
  if (rest.length) clusters.push(h('div.button-cluster', { role: 'group' }, rest));
  const row = h('div.button-panel-row', { role: 'toolbar', 'aria-label': 'Transport' }, clusters);
  const keys = toolbarKeys(row);
  const el = h('div.button-panel.transport-panel', row);
  let pending = 0;

  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(() => {
      pending = 0;
      buttons.update();
      keys.sync();
    });
  };
  for (const ev of ['active', 'transport', 'prefs', 'documents']) app.on(ev, schedule);
  app.on('doc-change', (doc, e) => doc === app.active && e.kind !== 'view' && schedule());
  buttons.update();
  const show = () => {
    buttons.update();
    keys.sync();
  };
  return { el, render: show, show };
}
