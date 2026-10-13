/**
 * Generation History panel (Window > Generation History): past prompts and
 * their results, newest first. Click a result to use it again: vector art
 * is placed (fitted to the selection or the artboard), shape fills fill the
 * selected shape, patterns become swatches, palettes recolor the selection
 * and text goes into the selected type. Each entry can also send its prompt
 * and settings back to the Generate panel, or be deleted.
 */
import { h, announce } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { KIND_LABELS, timeAgo } from './history.js';
import { promptTitle } from './prompts.js';
import { resultSvg, svgDataUrl } from './vectorize.js';
import { placeArt, placementTarget, shapeFill, selectedShape, applyGeneratedPattern } from './place.js';
import { applyPalette } from './recolor.js';
import { insertGeneratedText } from './text-ai.js';
import { openGenerate } from './generate-panel.js';

const KIND_ICONS = { vectors: 'gen-vectors', shapeFill: 'gen-shape-fill', pattern: 'gen-pattern', recolor: 'gen-recolor', text: 'gen-text' };

// SVG previews are built once per stored result.
const thumbs = new WeakMap();
function thumbUrl(result) {
  let u = thumbs.get(result);
  if (!u) thumbs.set(result, (u = svgDataUrl(resultSvg(result, { background: '#ffffff' }))));
  return u;
}

/** Use a history item in the active document. Returns a short description for announcements. */
export function reuseItem(app, entry, index) {
  const ed = app.editor;
  const item = entry.items[index];
  if (!ed || !item) return null;
  const prompt = entry.prompt;
  switch (entry.kind) {
    case 'vectors':
      placeArt(ed, item.result, placementTarget(ed, entry.settings?.contentType || 'subject'), { prompt });
      return 'Placed';
    case 'shapeFill': {
      const shape = selectedShape(ed);
      if (shape) {
        shapeFill(ed, shape.id, item.result, { prompt });
        return 'Shape filled';
      }
      placeArt(ed, item.result, placementTarget(ed, 'scene'), { prompt });
      return 'Placed';
    }
    case 'pattern': {
      const r = applyGeneratedPattern(ed, item.result, { prompt });
      return `Added "${r.name}" to Swatches`;
    }
    case 'recolor': {
      if (!ed.selection.size) {
        app.notify('Select artwork to recolor with this palette.');
        return null;
      }
      const n = applyPalette(ed, item.colors);
      if (!n) app.notify('The selection has no colors to recolor.');
      return n ? `Recolored with ${item.name}` : null;
    }
    case 'text':
      insertGeneratedText(app, item.text, entry.settings?.kind || 'paragraph');
      return 'Text inserted';
    default:
      return null;
  }
}

export class GenerationHistoryPanel extends Panel {
  static id = 'generationHistory';
  static title = 'Generation History';
  static icon = 'gen-history';

  get store() {
    return this.app.generativeHistory;
  }

  build() {
    this.list = h('div.gen-history', { role: 'list', 'aria-label': 'Generations' });
    this.empty = emptyState('Prompts and results you generate appear here, so you can use them again.');
    this.el.append(this.empty, this.list);
    this.store?.on('change', () => this.visible && this.update());
  }

  menu() {
    return [
      { label: 'Open Generate Panel', run: () => openGenerate(this.app, 'vectors') },
      '-',
      { label: 'Clear History...', enabled: Boolean(this.store?.entries.length), run: () => this.clearAll() },
    ];
  }

  async clearAll() {
    const ok = await this.app.dialogs.confirm({ title: 'Clear Generation History', message: 'Remove every prompt and result from the history? Artwork already in documents stays.', okLabel: 'Clear', danger: true });
    if (ok) this.store.clear();
  }

  update() {
    if (!this.built) return;
    const entries = this.store?.entries || [];
    this.empty.hidden = entries.length > 0;
    this.list.replaceChildren(...entries.map((e) => this.#entry(e)));
  }

  #entry(e) {
    const app = this.app;
    const label = KIND_LABELS[e.kind];
    const use = (i) => {
      try {
        const msg = reuseItem(app, e, i);
        if (msg) announce(msg);
      } catch (err) {
        app.notify(err.message, { error: true });
      }
    };
    let items;
    if (e.kind === 'recolor') {
      items = e.items.map((p, i) => h('button.gen-hist-palette', { type: 'button', 'aria-label': `Recolor the selection with ${p.name}`, 'data-tip': p.name, onclick: () => use(i) }, h('span.gen-chips', { 'aria-hidden': 'true' }, p.colors.map((c) => h('span.gen-chip', { style: { background: c } })))));
    } else if (e.kind === 'text') {
      items = e.items.map((t, i) => h('button.gen-hist-text', { type: 'button', 'aria-label': `Insert: ${t.text.slice(0, 60)}`, onclick: () => use(i) }, t.text.length > 140 ? `${t.text.slice(0, 139)}…` : t.text));
    } else {
      const verb = e.kind === 'pattern' ? 'Add to Swatches' : e.kind === 'shapeFill' ? 'Fill the selected shape with' : 'Place';
      items = e.items.map((it, i) => h('button.gen-tile.small', { type: 'button', 'aria-label': `${verb} variation ${i + 1}`, 'data-tip': `${verb} variation ${i + 1}`, onclick: () => use(i) }, h('img', { src: thumbUrl(it.result), alt: '', draggable: false })));
    }
    const canReuse = ['vectors', 'shapeFill', 'pattern'].includes(e.kind);
    const head = h(
      'div.gen-hist-head',
      icon(KIND_ICONS[e.kind], 14),
      h('span.gen-hist-title', { title: e.prompt }, e.kind === 'text' && e.settings?.action !== 'generate' ? `${label}: ${e.settings?.action || ''}` : promptTitle(e.prompt || label)),
      h('span.gen-hist-time', timeAgo(e.time)),
      canReuse ? h('button.icon-btn.small', { type: 'button', 'aria-label': 'Use this prompt again', 'data-tip': 'Use this prompt again', onclick: () => openGenerate(app, e.kind, { prompt: e.prompt, settings: e.settings }) }, icon('refresh-cw', 14)) : null,
      e.kind === 'recolor' ? h('button.icon-btn.small', { type: 'button', 'aria-label': 'Open in Recolor from Prompt', 'data-tip': 'Open in Recolor from Prompt', onclick: () => app.commands.run('generative.recolor', { prompt: e.prompt, palettes: e.items }) }, icon('refresh-cw', 14)) : null,
      h('button.icon-btn.small', { type: 'button', 'aria-label': 'Delete from history', 'data-tip': 'Delete', onclick: () => this.store.remove(e.id) }, icon('trash', 14)),
    );
    return h('section.gen-hist-entry', { role: 'listitem', 'aria-label': `${label}: ${e.prompt || ''}` }, head, h(`div.gen-hist-items.kind-${e.kind}`, items));
  }
}
