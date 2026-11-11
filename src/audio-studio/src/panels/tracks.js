// Tracks panel: the audio and bus tracks of the active multitrack session with
// an eye toggle each (hidden tracks leave the editor and the Mixer), a search
// filter, and the Track Visibility commands (filters and presets 1-9) in its
// toolbar and panel menu. Clicking a track selects it in the session.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { resolveItems } from '../ui/menubar.js';
import { VISIBILITY_MENU } from '../multitrack/visibility.js';

/** Panel menu items: the Track Visibility commands. */
export function tracksMenu(app) {
  return resolveItems(app, VISIBILITY_MENU);
}

export function tracksPanel(app) {
  const search = h('input.input.panel-search', { type: 'search', placeholder: 'Search tracks', 'aria-label': 'Search tracks' });
  const showAll = h('button.icon-btn', { type: 'button', 'aria-label': 'Show All Tracks', title: 'Show All Tracks', dataset: { cmd: 'mt.showAll' }, onclick: () => app.commands.run('mt.showAll') }, icon('eye', 15));
  const more = h('button.icon-btn', { type: 'button', 'aria-label': 'Track Visibility', title: 'Track Visibility', 'aria-haspopup': 'menu' }, icon('ellipsis', 15));
  more.addEventListener('click', () => {
    const r = more.getBoundingClientRect();
    app.openMenu(tracksMenu(app), { x: r.left, y: r.bottom + 2, anchor: more, label: 'Track Visibility' });
  });
  const toolbar = h('div.panel-toolbar', showAll, more, search);
  const list = h('ul.track-list', { role: 'listbox', 'aria-label': 'Tracks' });
  const empty = h(
    'div.empty-state.tracks-empty',
    h('p', 'The Tracks panel lists the tracks of a multitrack session.'),
    h('button.btn', { type: 'button', onclick: () => app.commands.run(app.documents.some((d) => d.kind === 'session') ? 'view.multitrack' : 'file.newSession') }, icon('mode-multitrack', 14), 'Open Multitrack Session'),
  );
  const el = h('div.tracks-panel', toolbar, list, empty);
  let pending = 0;

  const session = () => (app.active?.kind === 'session' ? app.active : null);

  const row = (doc, t) => {
    const hidden = Boolean(t.hidden);
    const eye = h(
      'button.icon-btn.sm.track-eye',
      {
        type: 'button',
        tabindex: '-1',
        'aria-label': `${hidden ? 'Show' : 'Hide'} ${t.name}`,
        title: hidden ? 'Show Track' : 'Hide Track',
        'aria-pressed': String(!hidden),
        onclick: (e) => {
          e.stopPropagation();
          app.commands.run('mt.toggleTrackVisibility', { id: t.id });
        },
      },
      icon(hidden ? 'eye-off' : 'eye', 14),
    );
    const selected = doc.selectedTrack === t.id;
    return h(
      `li.track-row${hidden ? '.hidden-track' : ''}`,
      {
        role: 'option',
        tabindex: selected ? '0' : '-1',
        'aria-selected': String(selected),
        dataset: { id: t.id },
        style: { '--track-color': t.color },
        onclick: () => {
          doc.selectTrack(t.id);
          render();
          list.querySelector(`[data-id="${t.id}"]`)?.focus();
        },
        ondblclick: () => app.commands.run('mt.renameTrack', { id: t.id }),
      },
      eye,
      h('span.track-chip', { 'aria-hidden': 'true' }),
      icon(t.type === 'bus' ? 'track-bus' : 'audio-lines', 13, 'track-type'),
      h('span.track-name', t.name),
      hidden ? h('span.sr-only', ' (hidden)') : null,
    );
  };

  const render = () => {
    const doc = session();
    el.classList.toggle('no-session', !doc);
    showAll.disabled = !app.commands.isEnabled('mt.showAll');
    more.disabled = !doc;
    search.disabled = !doc;
    if (!doc) {
      list.replaceChildren();
      return;
    }
    const q = search.value.trim().toLowerCase();
    const tracks = doc.state.tracks.filter((t) => !q || t.name.toLowerCase().includes(q));
    // Rows are rebuilt on every edit (Space hides a track): keyboard focus stays on the same track.
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.track-row')?.dataset.id : null;
    list.replaceChildren(...tracks.map((t) => row(doc, t)));
    if (!tracks.length) list.append(h('li.track-empty', q ? 'No matching tracks' : 'This session has no tracks'));
    if (!list.querySelector('[tabindex="0"]')) list.querySelector('.track-row')?.setAttribute('tabindex', '0');
    if (focused) list.querySelector(`.track-row[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  };
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(() => {
      pending = 0;
      render();
    });
  };

  list.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('.track-row')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const id = rows[i].dataset.id;
    if (e.key === 'ArrowDown') rows[i + 1]?.click();
    else if (e.key === 'ArrowUp') rows[i - 1]?.click();
    else if (e.key === ' ' || e.key === 'Enter') app.commands.run('mt.toggleTrackVisibility', { id });
    else if (e.key === 'F2') app.commands.run('mt.renameTrack', { id });
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  search.addEventListener('input', render);
  app.on('active', render);
  app.on('doc-change', (doc, e) => doc === app.active && (e.kind === 'edit' || e.kind === 'history' || e.kind === 'clip-selection' || e.kind === 'selection') && schedule());
  render();
  return { el, render, show: render };
}
