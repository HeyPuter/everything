// Tools panel: the tool palette and the Waveform/Multitrack editor switch as
// a dockable frame (handy on tablets, where the toolbar is cramped, or for a
// palette beside the editor). Tools follow availability in the active editor.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { TOOLS } from '../ui/tools.js';
import { commandButton, syncButtons, keyedLabel } from './transport-controls.js';

export function toolsPanel(app) {
  const mode = (kind, ic, label, cmd) =>
    h('button.mode-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { kind, cmd, label: `${label} Editor` }, onclick: () => app.commands.run(cmd) }, icon(ic, 16), h('span', label));
  const modes = [mode('audio', 'mode-waveform', 'Waveform', 'view.waveform'), mode('session', 'mode-multitrack', 'Multitrack', 'view.multitrack')];
  const tools = TOOLS.map(([id, ic, label]) => commandButton(app, `tool.${id}`, ic, label, { cls: '.tool-panel-btn', size: 18, keyOf: `tool.${id}` }));
  const display = [
    commandButton(app, 'view.spectral', 'spectral-frequency', 'Show Spectral Frequency Display', { cls: '.tool-panel-btn', size: 18, keyOf: 'view.spectral' }),
    commandButton(app, 'view.spectralPitch', 'spectral-pitch', 'Show Spectral Pitch Display', { cls: '.tool-panel-btn', size: 18 }),
  ];
  const el = h(
    'div.button-panel.tools-panel',
    h('div.mode-switch', { role: 'radiogroup', 'aria-label': 'Editor' }, modes),
    h('div.button-panel-row', { role: 'toolbar', 'aria-label': 'Tools' }, tools),
    h('div.button-panel-row', { role: 'group', 'aria-label': 'Display' }, display),
  );
  let pending = 0;

  const render = () => {
    const kind = app.active?.kind;
    for (const b of modes) {
      const on = b.dataset.kind === kind;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
      b.title = keyedLabel(app, b.dataset.cmd, b.dataset.label);
    }
    syncButtons(app, [...tools, ...display]);
    // A group with nothing registered (no spectral feature) takes no space.
    for (const row of el.querySelectorAll('.button-panel-row')) row.hidden = [...row.children].every((b) => b.hidden);
  };
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(() => {
      pending = 0;
      render();
    });
  };
  for (const ev of ['active', 'tool', 'prefs', 'documents']) app.on(ev, schedule);
  render();
  return { el, render, show: render };
}
