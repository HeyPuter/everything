// Libraries panel: browse, search and use library items; add from the
// current context ("+"); drag items onto the canvas or between libraries;
// right-click for item commands. Rendering is keyed by a version that
// changes with the index, the view options and the sync status.
import type { Editor } from '../../editor';
import type { Gradient } from '../../imaging/gradient/gradient';
import type { LayerStyle } from '../../imaging/effects/types';
import type { CharStyle } from '../../imaging/text/model';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { showContextMenu } from '../../app/menubar';
import { gradientToCss } from '../../imaging/gradient/edit';
import { colors } from '../effects/state';
import { showStyleThumbnail } from '../effects/style-thumbs';
import { brushPresetPreview, type BrushPresetData } from '../brushes';
import { libraries } from './service';
import { ITEM_MIME, libState, saveViewState } from './state';
import { groupByType, searchItems, TYPE_LABELS, type Library, type LibraryItem } from './model';
import { applyItem, describeItem } from './apply';
import { ADD_SOURCES } from './context';
import './libraries.css';

const assetUrls = new Map<string, Promise<string>>();
function assetUrl(hash: string): Promise<string> {
  let p = assetUrls.get(hash);
  if (!p) {
    p = libraries()
      .readAsset(hash)
      .then((b) => (b ? URL.createObjectURL(b) : ''))
      .catch(() => '');
    assetUrls.set(hash, p);
  }
  return p;
}

function thumb(e: Editor, item: LibraryItem): string {
  switch (item.type) {
    case 'color':
      return `<span class="lib-thumb lib-swatch" style="--swatch:${escapeXML(String(item.data.hex))}"></span>`;
    case 'gradient': {
      let css = '';
      try {
        css = gradientToCss(item.data.gradient as Gradient, colors(e));
      } catch {
        /* A damaged gradient shows as an empty swatch. */
      }
      return `<span class="lib-thumb lib-gradient" style="background:${escapeXML(css)}, var(--fx-checker)"></span>`;
    }
    case 'character-style':
    case 'paragraph-style': {
      const def = item.data.def as { style?: Partial<CharStyle>; char?: Partial<CharStyle> } | undefined;
      const c = def?.style ?? def?.char ?? {};
      const css = [c.family ? `font-family:'${String(c.family).replace(/['"<>]/g, '')}', sans-serif` : '', c.weight ? `font-weight:${Number(c.weight)}` : '', c.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
      return `<span class="lib-thumb lib-text" style="${css}">${item.type === 'character-style' ? 'Aa' : '¶'}</span>`;
    }
    case 'brush': {
      let src = '';
      try {
        src = brushPresetPreview(item.data.preset as BrushPresetData);
      } catch {
        /* Canvas unavailable. */
      }
      return `<span class="lib-thumb lib-brush"><img alt="" src="${src}"></span>`;
    }
    case 'layer-style':
      return `<span class="lib-thumb lib-image"><img alt="" data-style-thumb="${escapeXML(item.id)}" width="40" height="40"></span>`;
    case 'pattern':
    case 'graphic':
      return `<span class="lib-thumb lib-image ${item.type === 'pattern' ? 'lib-pattern' : ''}"><img alt="" data-asset="${escapeXML(item.assets?.thumb ?? item.assets?.content ?? '')}"></span>`;
  }
}

function itemHtml(e: Editor, item: LibraryItem) {
  const selected = libState.itemId === item.id;
  const extra = item.type === 'color' ? String(item.data.hex) : item.type === 'graphic' ? `${item.data.width} × ${item.data.height}` : '';
  return `<button type="button" class="lib-item" role="option" draggable="true" data-item="${escapeXML(item.id)}" aria-selected="${selected}" title="${escapeXML(describeItem(item))} — click to use, right-click for more" aria-label="${escapeXML(describeItem(item))}">${thumb(e, item)}<span class="lib-name">${escapeXML(item.name)}</span>${libState.view === 'list' && extra ? `<span class="lib-extra">${escapeXML(extra)}</span>` : ''}</button>`;
}
function itemsHtml(e: Editor, items: LibraryItem[]) {
  const list = (xs: LibraryItem[]) => `<div class="lib-items lib-${libState.view}" role="listbox" aria-label="Library items">${xs.map((i) => itemHtml(e, i)).join('')}</div>`;
  if (!libState.grouped) return list(items);
  return groupByType(items)
    .map(([t, xs]) => `<div class="lib-group"><div class="lib-group-title">${TYPE_LABELS[t]} <span class="lib-count">${xs.length}</span></div>${list(xs)}</div>`)
    .join('');
}
function libraryHtml(e: Editor, lib: Library, items: LibraryItem[], heading: boolean) {
  const head = heading ? `<div class="lib-section-title" data-library-drop="${escapeXML(lib.id)}"><button type="button" class="link-button" data-show-library="${escapeXML(lib.id)}">${escapeXML(lib.name)}</button><span class="lib-count">${items.length}</span></div>` : '';
  const body = items.length ? itemsHtml(e, items) : `<p class="muted lib-empty-note" data-library-drop="${escapeXML(lib.id)}">${libState.search ? 'No matching items.' : 'Empty. Use + to add the foreground color, a layer style, selected layers and more.'}</p>`;
  return `<section class="lib-section" data-library="${escapeXML(lib.id)}">${head}${body}</section>`;
}

function bodyHtml(e: Editor) {
  const lib = libraries();
  if (!lib.loaded) return '<p class="muted lib-empty">Loading libraries…</p>';
  const all = lib.index.libraries;
  if (!all.length) return `<div class="lib-empty"><p>No libraries yet. Libraries keep colors, styles, brushes and graphics for use in any document${lib.status.state === 'local' ? ' in this browser' : ''}.</p><button type="button" class="primary" data-command="libraries.new">New Library…</button></div>`;
  const shown = libState.libraryId ? all.filter((l) => l.id === libState.libraryId) : all;
  const parts = shown.map((l) => [l, searchItems(l.items, libState.search)] as const).filter(([, items]) => !libState.search || items.length);
  if (!parts.length) return '<p class="muted lib-empty">No items match the search.</p>';
  return parts.map(([l, items]) => libraryHtml(e, l, items, !libState.libraryId)).join('');
}

function headerHtml() {
  const lib = libraries();
  const options = [`<option value="">All Libraries</option>`, ...lib.index.libraries.map((l) => `<option value="${escapeXML(l.id)}" ${l.id === libState.libraryId ? 'selected' : ''}>${escapeXML(l.name)}</option>`)].join('');
  return `<div class="lib-toolbar"><select class="lib-select" aria-label="Library shown">${options}</select><button type="button" class="icon-button" data-lib="add" aria-haspopup="menu" title="Add to library" aria-label="Add to library">${svg('plus', 15)}</button><button type="button" class="icon-button" data-lib="view" title="${libState.view === 'grid' ? 'Show as list' : 'Show as grid'}" aria-label="${libState.view === 'grid' ? 'Show as list' : 'Show as grid'}">${svg(libState.view === 'grid' ? 'list' : 'layout-grid', 15)}</button></div><input type="search" class="lib-search" placeholder="Search libraries" aria-label="Search libraries" value="${escapeXML(libState.search)}" spellcheck="false">`;
}
function statusHtml() {
  const lib = libraries();
  const s = lib.status;
  const count = lib.index.libraries.reduce((n, l) => n + l.items.length, 0);
  return `<span class="lib-sync lib-sync-${s.state}" role="status" title="${escapeXML(s.message)}">${svg(s.state === 'local' ? 'save' : s.state === 'syncing' ? 'refresh-cw' : s.state === 'synced' ? 'cloud' : 'cloud-off', 13)}<span>${escapeXML(s.message)}</span></span><span class="lib-total">${count} item${count === 1 ? '' : 's'}</span>`;
}

/** Fill thumbnails that load asynchronously (assets, style renders). */
function fillThumbs(el: HTMLElement) {
  const lib = libraries();
  for (const img of el.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
    const h = img.dataset.asset!;
    if (!h) continue;
    void assetUrl(h).then((url) => {
      if (url && img.dataset.asset === h) img.src = url;
    });
  }
  for (const img of el.querySelectorAll<HTMLImageElement>('img[data-style-thumb]')) {
    const item = lib.item(img.dataset.styleThumb)?.item;
    if (item) showStyleThumbnail(img, item.data.style as LayerStyle, 40);
  }
}

let version = 0;
export const bump = () => version++;

export function mount(e: Editor, el: HTMLElement) {
  el.classList.add('libraries-panel');
  el.innerHTML = `<div class="lib-head"></div><div class="lib-body"></div><div class="lib-status"></div>`;
  const lib = libraries();
  lib.subscribe(() => {
    bump();
    // Keep the shown library valid when another tab deletes it.
    if (libState.libraryId && !lib.library(libState.libraryId)) libState.libraryId = '';
    libState.libraryCount = lib.index.libraries.length;
    if (el.isConnected) update(e, el);
  });
  void lib.load();
  const head = el.querySelector<HTMLElement>('.lib-head')!;
  const body = el.querySelector<HTMLElement>('.lib-body')!;
  head.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches('.lib-select')) {
      libState.libraryId = (t as HTMLSelectElement).value;
      saveViewState();
      bump();
      update(e, el);
    }
  });
  head.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.matches('.lib-search')) return;
    libState.search = t.value;
    bump();
    renderBody(e, el);
  });
  head.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-lib]')?.dataset.lib;
    if (act === 'add') {
      const r = (ev.target as HTMLElement).closest('button')!.getBoundingClientRect();
      showContextMenu(e, r.right, r.bottom + 2, ADD_SOURCES.map(([src]) => `libraries.add-${src}`), true);
    } else if (act === 'view') void e.runCommand(libState.view === 'grid' ? 'libraries.view-list' : 'libraries.view-grid');
  });
  const itemOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest<HTMLElement>('[data-item]');
  body.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const show = t.closest<HTMLElement>('[data-show-library]');
    if (show) {
      libState.libraryId = show.dataset.showLibrary!;
      saveViewState();
      bump();
      update(e, el);
      return;
    }
    const b = itemOf(t);
    if (!b) return;
    const found = lib.item(b.dataset.item);
    if (!found) return;
    select(found.item);
    body.querySelectorAll('.lib-item[aria-selected="true"]').forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    void e.run(() => applyItem(e, found.item, { alt: ev.altKey }));
  });
  const context = (b: HTMLElement, x: number, y: number) => {
    const found = lib.item(b.dataset.item);
    if (!found) return;
    select(found.item);
    const graphic = found.item.type === 'graphic';
    showContextMenu(e, x, y, [
      ...(graphic ? ['libraries.item-place', 'libraries.item-place-linked'] : ['libraries.item-apply']),
      '-',
      'libraries.item-redefine',
      'libraries.item-rename',
      'libraries.item-duplicate',
      '-',
      'libraries.item-delete',
    ]);
  };
  body.addEventListener('contextmenu', (ev) => {
    const b = itemOf(ev.target);
    if (!b) return;
    ev.preventDefault();
    context(b, ev.clientX, ev.clientY);
  });
  body.addEventListener('keydown', (ev) => {
    const b = itemOf(ev.target);
    if (!b) return;
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault();
      const r = b.getBoundingClientRect();
      context(b, r.left + 8, r.bottom);
    } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const all = [...body.querySelectorAll<HTMLElement>('.lib-item')];
      const i = all.indexOf(b) + (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : -1);
      all[Math.max(0, Math.min(all.length - 1, i))]?.focus();
      ev.preventDefault();
    }
  });
  // Drag: onto the canvas (use or place), onto an item (reorder, also across libraries) or a library heading.
  body.addEventListener('dragstart', (ev) => {
    const b = itemOf(ev.target);
    if (!b || !ev.dataTransfer) return;
    ev.dataTransfer.setData(ITEM_MIME, b.dataset.item!);
    ev.dataTransfer.effectAllowed = 'copyMove';
    b.classList.add('dragging');
  });
  body.addEventListener('dragend', () => body.querySelectorAll('.dragging,.drop-before').forEach((x) => x.classList.remove('dragging', 'drop-before')));
  const dropTarget = (t: EventTarget | null) => {
    const item = itemOf(t);
    if (item) return { library: lib.item(item.dataset.item)?.library.id, before: item.dataset.item, el: item };
    const zone = (t as HTMLElement | null)?.closest<HTMLElement>('[data-library-drop],[data-library]');
    const id = zone?.dataset.libraryDrop ?? zone?.dataset.library;
    return id ? { library: id, before: undefined, el: zone! } : undefined;
  };
  body.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes(ITEM_MIME)) return;
    const target = dropTarget(ev.target);
    if (!target?.library) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    body.querySelectorAll('.drop-before').forEach((x) => x !== target.el && x.classList.remove('drop-before'));
    target.el.classList.add('drop-before');
  });
  body.addEventListener('drop', (ev) => {
    const id = ev.dataTransfer?.getData(ITEM_MIME);
    const target = dropTarget(ev.target);
    body.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    if (!id || !target?.library || target.before === id) return;
    ev.preventDefault();
    void lib.moveItem(id, target.library, target.before);
  });
  update(e, el);
}

function select(item: LibraryItem) {
  libState.itemId = item.id;
  libState.itemType = item.type;
}

function renderBody(e: Editor, el: HTMLElement) {
  const body = el.querySelector<HTMLElement>('.lib-body')!;
  body.innerHTML = bodyHtml(e);
  fillThumbs(body);
}
export function update(e: Editor, el: HTMLElement) {
  const lib = libraries();
  libState.libraryCount = lib.index.libraries.length;
  const key = `${version}:${lib.status.state}:${lib.status.message}:${libState.view}:${libState.grouped}:${libState.libraryId}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const head = el.querySelector<HTMLElement>('.lib-head')!;
  // Keep typing in the search field undisturbed.
  const search = head.querySelector<HTMLInputElement>('.lib-search');
  const focused = search && document.activeElement === search;
  if (!focused) head.innerHTML = headerHtml();
  else {
    const select = head.querySelector('.lib-select');
    if (select) select.outerHTML = headerHtml().match(/<select[\s\S]*?<\/select>/)![0];
  }
  renderBody(e, el);
  el.querySelector<HTMLElement>('.lib-status')!.innerHTML = statusHtml();
}
