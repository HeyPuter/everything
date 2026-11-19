// Editor panel: shows the active document's view (waveform or multitrack) above
// the transport bar. Views are created per document and cached while it is
// open. A single requestAnimationFrame loop drives drawing while anything is
// dirty or playing.

import { h } from '../lib/dom.js';
import { icon, appIcon } from '../ui/icons.js';
import { WaveformView } from '../editor/waveform-view.js';
import { installPreviewEditor } from '../editor/preview-editor.js';
import { transportButtons, zoomButtons, playheadText, openTimeFormatMenu } from './transport-controls.js';

export function editorPanel(app) {
  const views = new Map();
  const stage = h('div.editor-stage');
  const transport = buildTransport(app);
  const empty = buildEmpty(app);
  const previewHost = h('div.preview-host');
  const el = h('div.editor-panel', stage, previewHost, transport.el);
  installPreviewEditor(app, previewHost);
  let current = null;
  let visible = false;
  let raf = 0;

  const viewFor = (doc) => {
    let v = views.get(doc);
    if (!v) {
      const kind = app.documentKinds.get(doc.kind);
      v = kind?.view ? kind.view(app, doc) : new WaveformView(app, doc);
      views.set(doc, v);
      doc.once('close', () => {
        v.destroy?.();
        views.delete(doc);
      });
    }
    return v;
  };

  const show = () => {
    const doc = app.active;
    const next = doc ? viewFor(doc) : null;
    if (next !== current || !stage.firstChild) {
      current = next;
      if (!current) empty.refresh();
      stage.replaceChildren(current ? current.el : empty);
      if (current) requestAnimationFrame(() => current?.layout?.());
    }
    transport.update();
    app.requestRender();
  };

  const tick = () => {
    raf = 0;
    if (!visible) return;
    current?.frame?.();
    transport.tick();
    if (app.engine.playing || app.recording) app.requestRender();
  };
  app.requestRender = () => {
    if (!raf && visible) raf = requestAnimationFrame(tick);
  };

  app.on('active', show);
  app.on('transport', () => {
    transport.update();
    app.requestRender();
  });
  app.on('doc-change', (doc, e) => {
    if (doc === app.active && e.kind !== 'view') transport.update();
  });
  app.on('prefs', () => transport.update());
  app.currentView = () => current;

  return {
    el,
    show() {
      visible = true;
      show();
    },
    hide() {
      visible = false;
    },
    focus() {
      current?.focus?.();
    },
  };
}

/**
 * The editor with nothing open: big actions to open, record or create, recent
 * files, smaller links for the rest, and a drop area for audio files.
 * `refresh()` updates the keys (they can be remapped) and the recent list.
 */
function buildEmpty(app) {
  const key = (cmd) => app.commands.shortcutLabel?.(cmd) || '';
  const card = (cmd, ic, label, note, cls = '') =>
    h(
      `button.welcome-card${cls}`,
      { type: 'button', dataset: { cmd }, onclick: () => app.commands.run(cmd) },
      h('span.welcome-card-icon', icon(ic, 22)),
      h('span.welcome-card-text', h('span.welcome-card-label', label), h('span.welcome-card-note', note)),
      h('kbd.welcome-key'),
    );
  const link = (cmd, ic, label) => h('button.welcome-link', { type: 'button', dataset: { cmd }, onclick: () => app.commands.run(cmd) }, icon(ic, 14), label, h('kbd.welcome-key'));
  const cards = h(
    'div.welcome-cards',
    card('file.open', 'folder-open', 'Open', 'Audio from your Puter files', '.primary'),
    card('transport.record', 'mic', 'Record', 'Into a new audio file'),
    card('file.newAudio', 'file-plus', 'New Audio File', 'A blank file to record into'),
    card('file.newSession', 'mode-multitrack', 'New Multitrack Session', 'Arrange and mix several tracks'),
  );
  const links = h('div.welcome-links', link('file.openLocal', 'hard-drive', 'Open from this device'), link('gen.tones', 'audio-waveform', 'Generate a test tone'));
  const recentList = h('ul.welcome-recent-list');
  const recent = h('section.welcome-recent', { 'aria-label': 'Recent files' }, h('h3', 'Recent'), recentList);
  const el = h(
    'div.editor-empty',
    h(
      'div.editor-empty-inner',
      h('div.editor-empty-icon', appIcon(56)),
      h('h2', 'Open, record or create'),
      h('p.muted', 'Nothing is open yet. Pick a way to start:'),
      cards,
      links,
      recent,
      h('p.welcome-drop', icon('download', 14), 'Or drop audio files anywhere in the window'),
    ),
  );
  el.refresh = () => {
    for (const b of el.querySelectorAll('[data-cmd]')) {
      const k = key(b.dataset.cmd);
      const cap = b.querySelector('.welcome-key');
      cap.textContent = k;
      cap.hidden = !k;
      // A command a build leaves out (generators) takes its link with it.
      b.hidden = !app.commands.get?.(b.dataset.cmd);
    }
    const all = app.recentMenuItems?.() || [];
    // The files, not the commands after the separator.
    const sep = all.findIndex((it) => it.type === 'sep');
    // Only files that open ("No Recent Files" placeholders are disabled).
    const items = (sep < 0 ? all : all.slice(0, sep)).filter((it) => it.type === 'cmd' && it.enabled !== false && it.run).slice(0, 5);
    recentList.replaceChildren(...items.map((it) => h('li', h('button.welcome-recent-item', { type: 'button', onclick: () => it.run() }, icon('file-audio', 14), h('span', it.label)))));
    recent.hidden = !items.length;
  };
  el.refresh();
  return el;
}

function buildTransport(app) {
  const time = h('button.time-display', { type: 'button', title: 'Playhead time. Click to choose the time format.', 'aria-label': 'Playhead time' }, '0:00.000');
  time.addEventListener('click', () => openTimeFormatMenu(app, time, { above: true }));
  const buttons = transportButtons(app);
  const zoom = zoomButtons(app);
  const el = h(
    'div.transport',
    { role: 'toolbar', 'aria-label': 'Transport' },
    h('div.transport-time', time),
    h('div.transport-buttons', buttons.list),
    h('div.transport-zoom', zoom.list),
  );
  let lastText = '';
  return {
    el,
    tick() {
      const text = playheadText(app);
      if (text !== lastText) {
        time.textContent = text;
        lastText = text;
      }
      time.classList.toggle('idle', !app.active);
    },
    update() {
      buttons.update();
      zoom.update();
      this.tick();
    },
  };
}
