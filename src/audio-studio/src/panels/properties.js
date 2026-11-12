// Properties panel: details of the active file (or of whatever a feature
// module provides through app.propertySections, e.g. track and clip
// properties in a multitrack session), under a header naming the file or
// session. Every section collapses from its heading; collapsed headings are
// remembered across files and sessions.

import '../styles/docked-panels.css';
import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';

/**
 * Turns each `section.prop-section` with an `h3.prop-heading` inside `root`
 * into a disclosure: the heading becomes a toggle button; `collapsed` holds
 * the heading texts that start closed and is updated as the user toggles.
 */
export function makeCollapsible(root, collapsed, onToggle) {
  for (const section of root.querySelectorAll('section.prop-section')) {
    const heading = section.querySelector(':scope > .prop-heading');
    if (!heading || heading.querySelector('.prop-toggle')) continue;
    const key = heading.textContent.trim();
    const body = h('div.prop-body');
    for (const child of [...section.childNodes]) if (child !== heading) body.append(child);
    section.append(body);
    const btn = h('button.prop-toggle', { type: 'button' }, icon('chevron-down', 12), h('span', key));
    const set = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      section.classList.toggle('collapsed', !open);
    };
    set(!collapsed.has(key));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      if (open) collapsed.delete(key);
      else collapsed.add(key);
      set(open);
      onToggle?.(key, open);
    });
    heading.replaceChildren(btn);
  }
}

export function propertiesPanel(app) {
  const el = h('div.properties-panel');
  /** Feature modules push (app, doc) => HTMLElement | null section builders. */
  app.propertySections = app.propertySections || [];
  const collapsed = new Set(app.prefs.get('propertiesCollapsed') || []);
  const remember = () => app.prefs.set('propertiesCollapsed', [...collapsed]);

  const row = (label, value) => h('div.prop-row', h('span.prop-label', label), h('span.prop-value', value));

  const focusables = () => [...el.querySelectorAll('button, input, select, textarea, [tabindex]')];
  // A control's identity across rebuilds: its label, or its heading's text.
  const nameOf = (c) => c.getAttribute('aria-label') || c.textContent.trim();

  /** Rebuilds the panel; keyboard focus stays on the same control (or near it). */
  const render = () => {
    const had = el.contains(document.activeElement) ? document.activeElement : null;
    const at = had ? focusables().indexOf(had) : -1;
    build();
    if (!had || (document.activeElement && document.activeElement !== document.body)) return;
    const list = focusables();
    const same = list.find((c) => c.tagName === had.tagName && nameOf(c) === nameOf(had));
    const tab = el.closest('.panel-group')?.querySelector('[role=tab][aria-selected=true]');
    (same || list[Math.min(at, list.length - 1)] || tab)?.focus({ preventScroll: true });
  };

  const build = () => {
    const doc = app.active;
    el.replaceChildren();
    if (!doc) {
      el.append(h('div.empty-state', 'No Selection'));
      return;
    }
    el.append(h('div.prop-header', icon(doc.kind === 'audio' ? 'file-audio' : 'mode-multitrack', 15), h('span.prop-title', { title: doc.name }, doc.name)));
    for (const build of app.propertySections) {
      const section = build(app, doc);
      if (section) el.append(section);
    }
    if (doc.kind !== 'audio') {
      makeCollapsible(el, collapsed, remember);
      return;
    }
    const name = h('input.input', { type: 'text', value: doc.name, 'aria-label': 'File name' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) doc.rename(v);
      else name.value = doc.name;
    });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const bytes = doc.length * doc.channelCount * 4;
    el.append(
      h(
        'section.prop-section',
        h('h3.prop-heading', 'File'),
        h('div.prop-row', h('label.prop-label', 'Name'), name),
        row('Location', doc.source?.path || (doc.source?.type === 'local' ? 'This device' : 'Not saved')),
        row('Duration', app.formatTime(doc.length, doc.sampleRate)),
        row('Sample Rate', `${doc.sampleRate} Hz`),
        row('Channels', doc.channelCount === 1 ? 'Mono' : doc.channelCount === 2 ? 'Stereo' : String(doc.channelCount)),
        row('Bit Depth', doc.info.bitDepth === 32 ? '32 (float)' : String(doc.info.bitDepth)),
        row('Source Format', (doc.info.format || 'wav').toUpperCase()),
        row('Uncompressed Size', formatBytes(bytes)),
        row('Markers', String(doc.state.markers.length)),
      ),
    );
    makeCollapsible(el, collapsed, remember);
  };
  app.on('active', render);
  app.on('doc-change', (doc, e) => doc === app.active && (e.kind === 'edit' || e.kind === 'history' || e.kind === 'saved' || e.kind === 'rename' || e.kind === 'properties') && render());
  app.on('properties', render);
  render();
  return { el, show: render };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
