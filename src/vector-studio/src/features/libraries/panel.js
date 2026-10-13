/**
 * Libraries panel: pick a library, add assets from the selection, and use
 * them in any document. Click a color or gradient to apply it to the
 * focused fill or stroke, a style to apply it to the selection, a graphic
 * to place a copy in the middle of the view (or drag it onto the canvas).
 * Libraries are kept per user, not per document.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, paintSwatch } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { openMenu } from '../../ui/menubar.js';
import { applyStyle } from '../../ops/paint-ops.js';
import { pickStyle } from '../../model/nodes.js';
import { MIXED } from '../../model/text-runs.js';
import { selectionBounds, transformNodes } from '../../model/geometry.js';
import { translate } from '../../lib/matrix.js';
import { drawThumbnail } from '../paint/thumbs.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { viewCenter } from '../io/place.js';
import { applyCharStyle, applyParaStyle, currentCharStyle, currentParaStyle, currentTextNodes } from '../type/type-ops.js';
import { ITEM_KINDS, KIND_LABELS } from './store.js';

export const DRAG_TYPE = 'application/x-vector-studio-library-item';

const clean = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== MIXED && v !== undefined));

/** A small PNG preview of the selected artwork. */
function graphicThumb(doc, ids, size = 96) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.drawImage !== 'function') return null;
    const group = { id: '__thumb', type: 'group', children: ids, hidden: false };
    drawThumbnail(ctx, { get: (id) => (id === '__thumb' ? group : doc.get(id)), has: (id) => id === '__thumb' || doc.has(id), assets: doc.assets }, group, size, 6);
    return canvas.toDataURL?.('image/png') || null;
  } catch {
    return null;
  }
}

/** Library items that can be made from the current selection. */
export function itemsFromSelection(app, kinds) {
  const ed = app.editor;
  if (!ed) return [];
  const doc = ed.doc;
  const out = [];
  const nodes = ed.selectedNodes();
  const first = nodes[0];
  for (const kind of kinds) {
    if (kind === 'graphic') {
      const ids = ed.topSelection();
      if (!ids.length) continue;
      const assets = {};
      for (const id of ids) for (const n of [doc.get(id), ...doc.descendants(id)]) if (n?.type === 'image' && doc.assets.has(n.asset)) assets[n.asset] = doc.assets.get(n.asset);
      const data = { items: ids.map((id) => doc.exportSubtree(id)), bounds: selectionBounds(doc, ids), assets };
      // Definitions the artwork uses (symbols, brushes) travel with it, as on the clipboard.
      for (const hk of clipboardHooks) hk.copy?.(doc, ids, data);
      out.push({ kind, name: nodes.length === 1 ? first.name || 'Artwork' : `${ids.length} objects`, data, thumb: graphicThumb(doc, ids) });
    } else if ((kind === 'fill' || kind === 'stroke') && first) {
      const paint = first[kind];
      if (!paint) continue;
      out.push({ kind: paint.type === 'solid' ? 'color' : 'gradient', name: paint.type === 'solid' ? paint.color.toUpperCase() : 'Gradient', data: { paint } });
    } else if (kind === 'characterStyle' && currentTextNodes(app).length) {
      const st = clean(currentCharStyle(app));
      out.push({ kind, name: `${st.fontFamily || 'Text'} ${st.fontSize ? `${Math.round(st.fontSize * 10) / 10} pt` : ''}`.trim(), data: { char: st } });
    } else if (kind === 'paragraphStyle' && currentTextNodes(app).length) {
      out.push({ kind, name: 'Paragraph Style', data: { para: clean(currentParaStyle(app)) } });
    } else if (kind === 'graphicStyle' && first && first.type !== 'group') {
      out.push({ kind, name: 'Graphic Style', data: { style: pickStyle(first) } });
    } else if (kind === 'text') {
      const t = currentTextNodes(app)[0];
      if (t?.text) out.push({ kind, name: t.text.split('\n')[0].slice(0, 40), data: { text: t.text } });
    }
  }
  return out;
}

/** Place a graphic item's artwork in the editor at `point` (default: view center). */
export function placeGraphic(app, data, point = null) {
  const ed = app.editor;
  if (!ed || !data?.items?.length) return [];
  const doc = ed.doc;
  for (const [id, a] of Object.entries(data.assets || {})) if (!doc.assets.has(id)) doc.assets.set(id, a);
  const layer = ed.targetLayer().id;
  const ids = [];
  doc.transact('Place Library Graphic', () => {
    let items = data.items;
    for (const hk of clipboardHooks) items = hk.paste?.(doc, data, items) || items;
    for (const sub of items) ids.push(doc.importSubtree(sub, layer).id);
    const b = selectionBounds(doc, ids);
    const at = point || viewCenter(ed);
    if (b) transformNodes(doc, ids, translate(at.x - (b.x + b.w / 2), at.y - (b.y + b.h / 2)));
  });
  ed.select(ids);
  return ids;
}

/** Use an item: apply a paint or style, or place a graphic or text. */
export function useItem(app, item, opts = {}) {
  const ed = app.editor;
  if (!ed) return false;
  switch (item.kind) {
    case 'color':
    case 'gradient':
      applyStyle(ed, { [ed.focusPaint === 'stroke' ? 'stroke' : 'fill']: item.data.paint }, 'Apply Library Color');
      return true;
    case 'graphicStyle':
      applyStyle(ed, item.data.style, 'Apply Graphic Style');
      return true;
    case 'characterStyle':
      applyCharStyle(app, item.data.char, { label: 'Apply Character Style' });
      return true;
    case 'paragraphStyle':
      applyParaStyle(app, item.data.para, { label: 'Apply Paragraph Style' });
      return true;
    case 'graphic':
      return placeGraphic(app, item.data, opts.point).length > 0;
    case 'text':
      if (app.placeText) app.placeText(item.data.text);
      else navigator.clipboard?.writeText?.(item.data.text);
      return true;
    default:
      return false;
  }
}

export class LibrariesPanel extends Panel {
  static id = 'libraries';
  static title = 'Libraries';
  static icon = 'panel-libraries';

  build() {
    const app = this.app;
    this.store = app.libraries;
    this.view = app.prefs.get('librariesView') || 'grid';
    this.current = app.prefs.get('librariesCurrent') || null;
    this.query = '';
    this.select = h('select.lib-select', { 'aria-label': 'Library', onchange: () => this.choose(this.select.value) });
    this.menuBtn = iconButton('ellipsis', 'Library options', (e) => this.openLibraryMenu(e.currentTarget), { className: 'small' });
    this.search = h('input.lib-search', { type: 'search', placeholder: 'Search this library', 'aria-label': 'Search library' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.gridBtn = iconButton('grid-view', 'Show as Grid', () => this.setView('grid'), { className: 'small', pressed: this.view === 'grid' });
    this.listBtn = iconButton('list-view', 'Show as List', () => this.setView('list'), { className: 'small', pressed: this.view === 'list' });
    this.content = h('div.lib-content');
    this.addBtn = h('button.btn.small.lib-add', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => this.openAddMenu(e.currentTarget) }, icon('plus', 14), 'Add');
    this.where = h('p.lib-where');
    this.el.append(h('div.lib-top', this.select, this.menuBtn), h('div.lib-bar', this.search, this.gridBtn, this.listBtn), this.content, h('div.lib-footer', this.addBtn, this.where));
    this.unsub = this.store.onChange(() => this.visible && this.render());
    this.store.load().then(() => this.render());
  }

  menu() {
    const lib = this.library;
    const ed = this.app.editor;
    const has = Boolean(ed?.selection.size);
    const text = currentTextNodes(this.app).length > 0;
    const first = ed?.selectedNodes()[0];
    const add = (label, kinds, enabled) => ({ label, enabled: Boolean(lib) && enabled, run: () => this.addFromSelection(kinds) });
    return [
      { label: 'New Library...', run: () => this.createLibrary() },
      { label: 'Rename Library...', enabled: Boolean(lib), run: () => this.renameLibrary() },
      { label: 'Duplicate Library', enabled: Boolean(lib), run: async () => this.choose((await this.store.duplicate(lib.id)).id) },
      { label: 'Delete Library...', enabled: Boolean(lib), run: () => this.deleteLibrary() },
      '-',
      {
        label: 'Add from Selection',
        submenu: [
          add('Graphic', ['graphic'], has),
          add('Fill Color', ['fill'], Boolean(first?.fill)),
          add('Stroke Color', ['stroke'], Boolean(first?.stroke)),
          add('Graphic Style', ['graphicStyle'], Boolean(first && first.type !== 'group')),
          '-',
          add('Character Style', ['characterStyle'], text),
          add('Paragraph Style', ['paragraphStyle'], text),
          add('Text', ['text'], text),
          '-',
          add('Everything Selected', ['graphic', 'fill', 'stroke', ...(text ? ['characterStyle'] : [])], has),
        ],
      },
      '-',
      { label: 'View as Grid', checked: this.view === 'grid', run: () => this.setView('grid') },
      { label: 'View as List', checked: this.view === 'list', run: () => this.setView('list') },
      { label: 'Sort by Name', enabled: Boolean(lib && lib.items.length > 1), run: () => this.sortItems() },
      '-',
      { label: 'Import Library...', run: () => this.importLibrary() },
      { label: 'Export Library...', enabled: Boolean(lib), run: () => this.exportLibrary() },
    ];
  }

  /** Sort the library's items by kind, then name. */
  async sortItems() {
    const lib = this.library;
    if (!lib) return;
    const order = new Map(ITEM_KINDS.map((k, i) => [k, i]));
    const sorted = lib.items.slice().sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
    lib.items = sorted;
    await this.store.save(lib);
    this.render();
  }

  setView(v) {
    this.view = v;
    this.app.prefs.set('librariesView', v);
    this.gridBtn.setAttribute('aria-pressed', String(v === 'grid'));
    this.listBtn.setAttribute('aria-pressed', String(v === 'list'));
    this.render();
  }

  get library() {
    return this.store.get(this.current) || this.store.libraries[0] || null;
  }

  choose(id) {
    this.current = id;
    this.app.prefs.set('librariesCurrent', id);
    this.render();
  }

  update() {
    // The selection decides which Add choices are enabled; the list itself changes only with the store.
    this.addBtn.disabled = !this.library;
  }

  shown() {
    super.shown();
    this.store.load().then(() => this.render());
  }

  render() {
    const libs = this.store.libraries;
    const lib = this.library;
    this.select.replaceChildren(...(libs.length ? libs.map((l) => h('option', { value: l.id, selected: l === lib }, l.name)) : [h('option', { value: '' }, 'No libraries')]));
    this.select.disabled = !libs.length;
    this.addBtn.disabled = !lib;
    const loc = this.store.location;
    this.where.textContent = loc === 'cloud' ? 'Saved in your Puter cloud' : loc === 'local' ? 'Saved in this browser. Sign in to keep libraries in your cloud.' : '';
    this.content.classList.toggle('grid', this.view === 'grid');
    this.content.classList.toggle('list', this.view === 'list');
    if (!this.store.loaded) {
      this.content.replaceChildren(h('p.panel-empty', 'Loading libraries…'));
      return;
    }
    if (!lib) {
      this.content.replaceChildren(
        h('div.lib-empty', h('p', 'Keep colors, graphics and styles you use often in a library, ready in every document.'), h('button.btn.primary.small', { type: 'button', onclick: () => this.createLibrary() }, 'Create Library')),
      );
      return;
    }
    const q = this.query;
    const items = lib.items.filter((it) => !q || it.name.toLowerCase().includes(q) || KIND_LABELS[it.kind].toLowerCase().includes(q));
    if (!items.length) {
      this.content.replaceChildren(h('p.panel-empty', q ? 'No matching assets.' : 'This library is empty. Select artwork or text and choose Add.'));
      return;
    }
    const sections = [];
    for (const kind of ITEM_KINDS) {
      const list = items.filter((it) => it.kind === kind);
      if (!list.length) continue;
      sections.push(h('section.lib-section', h('h3.lib-heading', `${KIND_LABELS[kind]} (${list.length})`), h(`div.lib-items.kind-${kind}`, { role: 'list' }, list.map((it) => this.itemEl(lib, it)))));
    }
    this.content.replaceChildren(...sections);
  }

  itemEl(lib, it) {
    let preview;
    if (it.kind === 'color' || it.kind === 'gradient') preview = paintSwatch(it.data.paint, { className: 'lib-swatch' });
    else if (it.kind === 'graphic') preview = it.thumb ? h('img.lib-thumb', { src: it.thumb, alt: '' }) : h('span.lib-glyph', icon('component', 20));
    else if (it.kind === 'characterStyle') preview = h('span.lib-glyph.lib-type', { style: `font-family: ${JSON.stringify(it.data.char.fontFamily || 'inherit')}; font-weight: ${it.data.char.fontWeight || 400}; font-style: ${it.data.char.fontStyle || 'normal'}` }, 'Aa');
    else if (it.kind === 'paragraphStyle') preview = h('span.lib-glyph', icon('pilcrow', 18));
    else if (it.kind === 'graphicStyle') preview = h('span.lib-glyph', icon('sparkles', 18));
    else preview = h('span.lib-glyph', icon('type', 18));
    const label = it.name || KIND_LABELS[it.kind];
    const verb = it.kind === 'graphic' ? 'Place' : it.kind === 'text' ? 'Insert' : 'Apply';
    const el = h(
      'div.lib-item',
      {
        role: 'listitem',
        tabindex: '0',
        draggable: it.kind === 'graphic' ? 'true' : 'false',
        'data-tip': `${verb} ${label}`,
        'aria-label': `${label}, ${KIND_LABELS[it.kind]}. Enter to ${verb.toLowerCase()}, Delete to remove, F2 to rename.`,
        onclick: () => this.use(it),
        oncontextmenu: (e) => {
          e.preventDefault();
          this.openItemMenu(lib, it, { x: e.clientX, y: e.clientY });
        },
        onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.use(it);
          } else if (e.key === 'Delete' || e.key === 'Backspace') this.store.removeItems(lib.id, [it.id]);
          else if (e.key === 'F2') this.renameItem(lib, it);
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            const r = el.getBoundingClientRect();
            this.openItemMenu(lib, it, { x: r.left, y: r.bottom });
          }
        },
      },
      preview,
      h('span.lib-name', label),
    );
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ lib: lib.id, item: it.id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    return el;
  }

  use(it) {
    if (!this.app.editor) {
      this.app.notify('Open a document to use library assets.', { polite: true });
      return;
    }
    useItem(this.app, it);
  }

  addFromSelection(kinds) {
    const lib = this.library;
    if (!lib) return;
    const items = itemsFromSelection(this.app, kinds);
    if (!items.length) {
      this.app.notify('Select artwork or text to add to the library.', { polite: true });
      return;
    }
    this.store.addItems(lib.id, items);
    this.app.notify(`Added ${items.length === 1 ? items[0].name || 'an asset' : `${items.length} assets`} to ${lib.name}.`, { polite: true });
  }

  openAddMenu(anchor) {
    const ed = this.app.editor;
    const has = Boolean(ed?.selection.size);
    const text = currentTextNodes(this.app).length > 0;
    const first = ed?.selectedNodes()[0];
    const r = anchor.getBoundingClientRect();
    openMenu(
      this.app,
      [
        { type: 'cmd', label: 'Graphic', enabled: has, run: () => this.addFromSelection(['graphic']) },
        { type: 'cmd', label: 'Fill Color', enabled: Boolean(first?.fill), run: () => this.addFromSelection(['fill']) },
        { type: 'cmd', label: 'Stroke Color', enabled: Boolean(first?.stroke), run: () => this.addFromSelection(['stroke']) },
        { type: 'cmd', label: 'Graphic Style', enabled: Boolean(first && first.type !== 'group'), run: () => this.addFromSelection(['graphicStyle']) },
        { type: 'sep' },
        { type: 'cmd', label: 'Character Style', enabled: text, run: () => this.addFromSelection(['characterStyle']) },
        { type: 'cmd', label: 'Paragraph Style', enabled: text, run: () => this.addFromSelection(['paragraphStyle']) },
        { type: 'cmd', label: 'Text', enabled: text, run: () => this.addFromSelection(['text']) },
        { type: 'sep' },
        { type: 'cmd', label: 'Everything Selected', enabled: has, run: () => this.addFromSelection(['graphic', 'fill', 'stroke', ...(text ? ['characterStyle'] : [])]) },
      ],
      { x: r.left, y: r.top, anchor, label: 'Add to library', above: true },
    );
  }

  openItemMenu(lib, it, at) {
    openMenu(
      this.app,
      [
        { type: 'cmd', label: it.kind === 'graphic' ? 'Place Copy' : it.kind === 'text' ? 'Insert' : 'Apply', enabled: Boolean(this.app.editor), run: () => this.use(it) },
        { type: 'cmd', label: 'Rename…', enabled: true, run: () => this.renameItem(lib, it) },
        ...this.store.libraries.filter((l) => l.id !== lib.id).slice(0, 12).map((l) => ({ type: 'cmd', label: `Copy to ${l.name}`, enabled: true, run: () => this.store.addItems(l.id, [JSON.parse(JSON.stringify(it))]) })),
        { type: 'sep' },
        { type: 'cmd', label: 'Delete', enabled: true, run: () => this.store.removeItems(lib.id, [it.id]) },
      ],
      { x: at.x, y: at.y, label: 'Library item' },
    );
  }

  async renameItem(lib, it) {
    const v = await this.app.dialogs.form({ title: 'Rename Asset', fields: [{ key: 'name', label: 'Name', type: 'text', value: it.name }] });
    if (v?.name?.trim()) this.store.renameItem(lib.id, it.id, v.name.trim());
  }

  async createLibrary() {
    const v = await this.app.dialogs.form({ title: 'New Library', fields: [{ key: 'name', label: 'Name', type: 'text', value: this.store.libraries.length ? `Library ${this.store.libraries.length + 1}` : 'My Library' }] });
    const name = v?.name?.trim();
    if (!name) return;
    const lib = await this.store.create(name);
    this.choose(lib.id);
  }

  openLibraryMenu(anchor) {
    const lib = this.library;
    const r = anchor.getBoundingClientRect();
    openMenu(
      this.app,
      [
        { type: 'cmd', label: 'New Library…', enabled: true, run: () => this.createLibrary() },
        { type: 'cmd', label: 'Rename Library…', enabled: Boolean(lib), run: () => this.renameLibrary() },
        { type: 'cmd', label: 'Duplicate Library', enabled: Boolean(lib), run: async () => this.choose((await this.store.duplicate(lib.id)).id) },
        { type: 'sep' },
        { type: 'cmd', label: 'Import Library…', enabled: true, run: () => this.importLibrary() },
        { type: 'cmd', label: 'Export Library…', enabled: Boolean(lib), run: () => this.exportLibrary() },
        { type: 'sep' },
        { type: 'cmd', label: 'Delete Library…', enabled: Boolean(lib), run: () => this.deleteLibrary() },
      ],
      { x: r.left, y: r.bottom, anchor, label: 'Library options' },
    );
  }

  async renameLibrary() {
    const lib = this.library;
    const v = await this.app.dialogs.form({ title: 'Rename Library', fields: [{ key: 'name', label: 'Name', type: 'text', value: lib.name }] });
    if (v?.name?.trim()) await this.store.rename(lib.id, v.name.trim());
  }

  async deleteLibrary() {
    const lib = this.library;
    const ok = await this.app.dialogs.confirm({ title: 'Delete Library', message: `Delete “${lib.name}” and its ${lib.items.length} assets? Documents that used them keep their artwork.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    await this.store.remove(lib.id);
    this.choose(this.store.libraries[0]?.id || null);
  }

  exportLibrary() {
    const lib = this.library;
    const url = URL.createObjectURL(new Blob([JSON.stringify(lib)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${lib.name}.vslibrary.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  importLibrary() {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const lib = await this.store.importLibrary(JSON.parse(await file.text()));
        this.choose(lib.id);
        this.app.notify(`Imported ${lib.name}.`, { polite: true });
      } catch (err) {
        this.app.notify(err?.message || 'Could not import the library.', { error: true });
      }
    });
    document.body.append(input);
    input.click();
  }
}
