import type { Editor } from '../../editor';
import { allLayers, blendGroupStarts, blendLabel, blends, findLayer, type Layer } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { hasMask } from '../../model/masks';
import { cachedSourceThumbnail, hydrateSourceThumbnails } from '../../ui/thumbnails';
import { gridThumbnail } from './thumbnails';
import { layerLock, ownLock, setFullLock, setPartialLock } from '../../model/locks';
import { bindLayerDrag } from '../../ui/layers';
import { showContextMenu } from '../../app/menubar';
import type { Panel } from '../../app/registry';
import { effectRows, fillThumb, fxBadge } from '../effects/layer-effects';
import { patchList } from '../../ui/patch-list';

const kindIcon: Record<string, string> = {
  group: 'folder',
  text: 'type',
  paint: 'paintbrush',
  vector: 'pen-tool',
  image: 'image',
  pixel: 'image',
  solid: 'square',
  adjustment: 'adjustment-layer',
};
function thumbnail(e: Editor, l: Layer) {
  const doc = e.doc;
  if (l.artboard) return svg('artboard-layer', 16);
  if (l.frame) return svg(l.frame.shape === 'ellipse' ? 'frame-ellipse' : 'frame-tool', 16);
  if (l.kind === 'pixel' && l.pixels) return `<img src="${gridThumbnail(e.assets.tiles, l.pixels, doc.width, doc.height)}" alt="" draggable="false">`;
  if (l.kind === 'solid') return fillThumb(l) ?? `<span class="swatch-thumb" style="background:${l.color}"></span>`;
  if (l.asset) {
    const url = cachedSourceThumbnail(l, e.assets, doc);
    return `<img ${url ? `src="${escapeXML(url)}"` : `data-source-thumbnail="${escapeXML(l.id)}"`} alt="" loading="lazy" draggable="false">`;
  }
  if (l.kind === 'adjustment' && l.adjustment) return svg(`adj-${l.adjustment.kind}`, 16);
  return svg(kindIcon[l.kind] ?? 'image', 16);
}
function maskThumb(e: Editor, l: Layer) {
  if (l.maskGrid) return `<img src="${gridThumbnail(e.assets.tiles, l.maskGrid, e.doc.width, e.doc.height, 40, true)}" alt="" draggable="false">`;
  return svg('mask-add', 16);
}
// Layer filtering by kind or name from the panel's filter row.
const filter = { kind: '', text: '', on: false };
function matches(l: Layer): boolean {
  if (!filter.on || (!filter.kind && !filter.text)) return true;
  const kindOk =
    !filter.kind ||
    (filter.kind === 'pixel' && ['pixel', 'image', 'paint'].includes(l.kind)) ||
    (filter.kind === 'adjustment' && (l.kind === 'adjustment' || l.kind === 'solid')) ||
    (filter.kind === 'text' && l.kind === 'text') ||
    (filter.kind === 'vector' && l.kind === 'vector') ||
    (filter.kind === 'embedded' && l.kind === 'image');
  return kindOk && (!filter.text || l.name.toLowerCase().includes(filter.text.toLowerCase()));
}
// Features narrow the list further (Isolate Layers) and add a notice above it.
export const layerRowFilters: ((e: Editor, l: Layer) => boolean)[] = [];
export const layerListBanners: ((e: Editor) => string)[] = [];
let filterEditor: Editor | undefined;
function visibleInFilter(l: Layer): boolean {
  const own = matches(l) && (!filterEditor || layerRowFilters.every((f) => f(filterEditor!, l)));
  return own || l.children.some(visibleInFilter);
}
// Features add sub-rows under a layer (Live Filters) without editing this file.
export const layerRowExtras: ((e: Editor, l: Layer, depth: number) => string)[] = [];
// Features add badges over a layer's thumbnail and a note under its name
// (the first note returned wins over the default kind label).
export const layerBadges: ((e: Editor, l: Layer) => string)[] = [];
export const layerNotes: ((e: Editor, l: Layer) => string | undefined)[] = [];
function note(e: Editor, l: Layer) {
  for (const f of layerNotes) {
    const n = f(e, l);
    if (n !== undefined) return escapeXML(n);
  }
  if (l.artboard) return `artboard · ${l.artboard.rect.width} × ${l.artboard.rect.height}`;
  if (l.frame) return l.children.length ? 'frame' : 'empty frame';
  return l.kind === 'group' ? `${allLayers(l.children).length} layers` : l.kind === 'pixel' ? '' : l.kind === 'image' ? (l.assetColorSpace === 'srgb' ? 'embedded' : '') : l.fill ? `${l.fill.type} fill` : l.kind;
}
// One fragment per layer (its row, effect and extra rows), children after
// their group, so the list patches row by row (ui/patch-list.ts).
function rows(e: Editor, layers: Layer[], depth: number, out: string[] = []): string[] {
  const selected = e.selectedIds;
  [...layers]
    .reverse()
    .filter(visibleInFilter)
    .forEach((l) => {
      const collapsed = e.collapsedGroups.has(l.id);
      const locked = l.locked || l.transparencyProtected || Object.values(l.protection ?? {}).some(Boolean);
      const masked = hasMask(l) || !!l.maskGrid;
      const maskLinked = l.pixelMask ? !l.pixelMask.positionRelativeToLayer : l.vectorMask ? !l.vectorMask.unlinked : !l.maskUnlinked;
      const linkActive = !!l.linkGroup && [...selected].some((id) => id !== l.id && findLayer(e.doc.layers, id)?.linkGroup === l.linkGroup);
      out.push(`<div class="layer-row ${selected.has(l.id) ? 'selected' : ''} ${l.background ? 'background-layer' : ''} ${l.visible ? '' : 'hidden-layer'} ${l.clipped ? 'clipped' : ''}" data-row="${escapeXML(l.id)}" draggable="true" role="listitem" style="--depth:${depth}">
<button class="eye" data-visibility="${escapeXML(l.id)}" title="${l.visible ? 'Hide' : 'Show'} layer" aria-label="${l.visible ? 'Hide' : 'Show'} ${escapeXML(l.name)}">${l.visible ? svg('eye', 15) : ''}</button>
${l.kind === 'group' ? `<button class="group-disclosure" data-collapse="${escapeXML(l.id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeXML(l.name)}" aria-expanded="${!collapsed}">${svg(collapsed ? 'chevron-right' : 'chevron-down', 13)}</button>` : l.clipped ? `<span class="clip-arrow" title="Clipped to the layer below" aria-label="Clipping mask">↳</span>` : '<span class="disclosure-spacer"></span>'}
<button class="layer-select" data-layer="${escapeXML(l.id)}" aria-pressed="${selected.has(l.id)}" aria-label="${escapeXML(l.name)}"><span class="layer-thumbnail ${l.kind} ${e.maskTarget === l.id ? '' : selected.has(l.id) && masked ? 'target' : ''}">${thumbnail(e, l)}${layerBadges.map((f) => f(e, l)).join('')}</span></button>
${masked ? `<button class="mask-link ${maskLinked ? '' : 'unlinked'}" data-mask-link="${escapeXML(l.id)}" aria-pressed="${maskLinked}" aria-label="${maskLinked ? 'Unlink' : 'Link'} mask of ${escapeXML(l.name)}" title="${maskLinked ? 'Mask moves with the layer (click to unlink)' : 'Mask stays in place (click to link)'}">${svg('link', 11)}</button>` : ''}
${masked ? `<button class="mask-thumbnail ${l.maskDisabled ? 'disabled-mask' : ''} ${e.maskTarget === l.id ? 'target' : ''}" data-mask="${escapeXML(l.id)}" aria-label="Edit mask for ${escapeXML(l.name)}" aria-pressed="${e.maskTarget === l.id}" title="Layer mask (click to edit, Shift-click to disable)">${maskThumb(e, l)}</button>` : ''}
<button class="layer-name" data-layer="${escapeXML(l.id)}" tabindex="-1" aria-hidden="true"><span class="name-text">${escapeXML(l.name)}</span><small>${note(e, l)}</small></button>
${fxBadge(l)}${l.linkGroup ? `<span class="link-badge ${linkActive ? 'active' : ''}" title="Linked layer" aria-label="Linked layer">${svg('link', 13)}</span>` : ''}${locked ? `<span class="lock-badge" title="${l.locked ? 'Layer locked' : 'Layer partially locked'}" aria-label="${l.locked ? 'Layer locked' : 'Layer partially locked'}">${svg('lock', 13)}</span>` : ''}
</div>${effectRows(l, depth)}${layerRowExtras.map((f) => f(e, l, depth)).join('')}`);
      if (l.kind === 'group' && !collapsed) rows(e, l.children, depth + 1, out);
    });
  return out;
}
function blendSelect(l?: Layer, disabled = false) {
  const options = (l?.kind === 'group' && !l.artboard && !l.frame ? (['pass through', ...blends] as Layer['blend'][]) : blends)
    .map((b) => `${blendGroupStarts.includes(b) ? '<option disabled>──────────</option>' : ''}<option value="${b}" ${l?.blend === b ? 'selected' : ''}>${blendLabel(b)}</option>`)
    .join('');
  return `<select id="blend" aria-label="Blend mode" ${!l || disabled ? 'disabled' : ''}>${options}</select>`;
}

export const layersPanel: Panel = {
  id: 'layers',
  title: 'Layers',
  icon: 'layers',
  location: 'dock-bottom',
  shortcut: 'F7',
  mount: (e, el) => {
    el.classList.add('layers-panel');
    el.innerHTML = `<div class="layer-filter"><select class="layer-filter-kind" aria-label="Filter layers by kind"><option value="">Kind</option><option value="pixel">Pixel layers</option><option value="adjustment">Adjustment and fill layers</option><option value="text">Type layers</option><option value="vector">Shape layers</option><option value="embedded">Embedded objects</option></select><input class="layer-filter-text" type="search" placeholder="Name" aria-label="Filter layers by name"><button class="icon-button toggle layer-filter-toggle" aria-pressed="false" title="Turn layer filtering on or off" aria-label="Layer filtering">${svg('search', 13)}</button></div><div class="layer-options"></div><div class="lock-row"></div><div id="layers" role="list" aria-label="Document layers"></div><div class="layer-root-drop" hidden>Drop here to move to the top level</div>
<div class="layer-footer">
<button data-command="layer.link" title="Link or unlink the selected layers" aria-label="Link layers">${svg('link', 16)}</button>
<button data-command="layer.style-dialog" title="Add a layer style" aria-label="Add a layer style">${svg('fx', 16)}</button>
<button data-command="layer.add-mask" title="Add layer mask" aria-label="Add layer mask">${svg('mask-add', 16)}</button>
<button data-layer-adjust title="Create new fill or adjustment layer" aria-label="New fill or adjustment layer">${svg('adjustment-layer', 16)}</button>
<button data-command="layer.new-group" title="Create a new group" aria-label="New group">${svg('folder-plus', 16)}</button>
<button data-command="layer.new-quick" title="Create a new layer" aria-label="New layer">${svg('plus', 16)}</button>
<button data-command="layer.delete" title="Delete layer" aria-label="Delete layer">${svg('trash-2', 16)}</button>
</div><span id="layer-count" class="sr-only"></span>`;
    el.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('[data-layer-adjust]')) {
        const r = target.closest('[data-layer-adjust]')!.getBoundingClientRect();
        showContextMenu(e, r.left, r.top - 4, [
          'layer.fill-solid', 'layer.fill-gradient', 'layer.fill-pattern', '-',
          'layer.adj-brightness-contrast', 'layer.adj-levels', 'layer.adj-curves', 'layer.adj-exposure', '-',
          'layer.adj-vibrance', 'layer.adj-hue-saturation', 'layer.adj-color-balance', 'layer.adj-black-white', 'layer.adj-photo-filter', 'layer.adj-channel-mixer', 'layer.adj-color-lookup', '-',
          'layer.adj-invert', 'layer.adj-posterize', 'layer.adj-threshold', 'layer.adj-gradient-map', 'layer.adj-selective-color',
        ]);
        return;
      }
      const vis = target.closest<HTMLElement>('[data-visibility]')?.dataset.visibility;
      if (vis) {
        // Alt-click shows only this layer; a second Alt-click shows all layers again.
        if (ev.altKey) {
          const only = allLayers(e.doc.layers).every((l) => l.id === vis || !l.visible);
          e.command('Show/Hide Layers', (d) => {
            for (const l of allLayers(d.layers)) l.visible = only ? true : l.id === vis || !!findLayer(l.children, vis);
          });
        } else
          e.command('Toggle visibility', (d) => {
            const l = findLayer(d.layers, vis);
            if (l) l.visible = !l.visible;
          });
        return;
      }
      const collapse = target.closest<HTMLElement>('[data-collapse]')?.dataset.collapse;
      if (collapse) {
        if (e.collapsedGroups.has(collapse)) e.collapsedGroups.delete(collapse);
        else e.collapsedGroups.add(collapse);
        e.update();
        el.querySelector<HTMLButtonElement>(`[data-collapse="${collapse}"]`)?.focus();
        return;
      }
      const maskLink = target.closest<HTMLElement>('[data-mask-link]')?.dataset.maskLink;
      if (maskLink) {
        if (!e.selectedIds.has(maskLink) || e.selectedIds.size > 1) e.selectLayer(maskLink);
        const l = findLayer(e.doc.layers, maskLink);
        void e.runCommand(l?.vectorMask ? 'layer.vmask-link' : 'layer.mask-link');
        return;
      }
      const maskId = target.closest<HTMLElement>('[data-mask]')?.dataset.mask;
      if (maskId) {
        if (ev.shiftKey) {
          e.selected = maskId;
          e.editLayer('Toggle Layer Mask', (l) => (l.maskDisabled = !l.maskDisabled));
          return;
        }
        e.selectLayer(maskId);
        e.maskTarget = maskId;
        e.update();
        return;
      }
      const id = target.closest<HTMLElement>('[data-layer]')?.dataset.layer;
      if (id) {
        // Mod-click on a thumbnail loads the layer's transparency as a selection.
        if ((ev.metaKey || ev.ctrlKey) && target.closest('.layer-thumbnail')) {
          void e.runCommand('select.load-transparency', id);
          return;
        }
        // Re-selecting the only selected layer keeps the rows in place, so the
        // second click of a double-click lands on the same element.
        const only = e.selectedIds.size === 1 && e.selectedIds.has(id) && !e.maskTarget;
        if (!(only && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey)) e.selectLayer(id, ev.metaKey || ev.ctrlKey, ev.shiftKey);
      }
    });
    el.addEventListener('dblclick', async (ev) => {
      const name = (ev.target as HTMLElement).closest<HTMLElement>('.layer-name');
      const thumb = (ev.target as HTMLElement).closest<HTMLElement>('.layer-thumbnail,.fx-badge');
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!row) return;
      const id = row.dataset.row!;
      // Double-clicking a layer mask opens Select and Mask on it, or the mask's
      // Properties (Tools → Double-click a layer mask to open Select and Mask).
      const maskThumb = (ev.target as HTMLElement).closest<HTMLElement>('[data-mask]');
      if (maskThumb) {
        e.selectLayer(id);
        e.maskTarget = id;
        e.update();
        if (e.preferences.maskDblClickRefine) void e.runCommand('select.mask-refine', 'mask');
        else e.dock.show('properties');
        return;
      }
      // The Background layer converts to a normal layer instead of renaming.
      if (findLayer(e.doc.layers, id)?.background && !(ev.target as HTMLElement).closest('.fx-badge,[data-visibility],[data-mask],[data-mask-link]')) {
        e.selectLayer(id);
        void e.runCommand('layer.from-background');
        return;
      }
      if (thumb && (ev.target as HTMLElement).closest('.fx-badge')) {
        void e.runCommand('layer.style-dialog');
        return;
      }
      if (name) {
        const l = findLayer(e.doc.layers, id);
        if (!l) return;
        const text = name.querySelector('.name-text') as HTMLElement;
        const input = document.createElement('input');
        input.className = 'layer-rename';
        input.value = l.name;
        input.setAttribute('aria-label', 'Layer name');
        text.replaceWith(input);
        input.focus();
        input.select();
        // Escape cancels: the input leaving the list afterwards blurs it, which
        // must not commit the draft name.
        let finished = false;
        const done = (commit: boolean) => {
          if (finished) return;
          finished = true;
          if (commit && input.value.trim() && input.value !== l.name) {
            e.selected = id;
            e.editLayer('Rename Layer', (x) => (x.name = input.value.trim()));
          } else e.update();
        };
        input.addEventListener('keydown', (k) => {
          if (k.key === 'Enter') done(true);
          if (k.key === 'Escape') done(false);
          k.stopPropagation();
        });
        input.addEventListener('blur', () => done(true), { once: true });
      } else if (thumb) {
        const l = findLayer(e.doc.layers, id);
        if (l?.kind === 'text') void e.runCommand('type.edit');
        else if (l?.kind === 'adjustment') e.dock.show('properties');
        else if (l?.kind === 'solid' && l.fill) e.dock.show('properties');
        else if (l?.kind === 'solid') void e.runCommand('color.pick-layer-color');
        else if (l?.kind === 'image') void e.runCommand('layer.embed-edit');
      } else if (!(ev.target as HTMLElement).closest('button,input')) {
        // Double-clicking a row's empty area opens its layer style.
        e.selectLayer(id);
        void e.runCommand('layer.style-dialog');
      }
    });
    el.addEventListener('contextmenu', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!row) return;
      ev.preventDefault();
      if (!e.selectedIds.has(row.dataset.row!)) e.selectLayer(row.dataset.row!);
      const target = findLayer(e.doc.layers, row.dataset.row!);
      const embedded = target?.kind === 'image';
      showContextMenu(e, ev.clientX, ev.clientY, [
        'layer.rename', 'layer.style-dialog', '-', 'layer.duplicate', 'layer.delete', 'layer.group', 'layer.ungroup', '-',
        ...(target?.frame ? ['frame.place', 'frame.clear', '-'] : []),
        'layer.embed-convert', ...(embedded ? ['layer.embed-new-via-copy', 'layer.embed-edit', 'layer.embed-replace', 'layer.embed-export', 'layer.embed-to-layers', 'layer.embed-reset'] : []), 'layer.rasterize', 'layer.rasterize-style', '-',
        'layer.mask-toggle', 'layer.mask-delete', 'layer.mask-apply', 'layer.clipping-mask', '-',
        'layer.style-copy', 'layer.style-paste', 'layer.style-clear', '-',
        'layer.link', 'layer.select-linked', 'layer.from-background', '-',
        'layer.merge-down', 'layer.merge-visible', 'layer.flatten',
      ]);
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id === 'blend') e.editLayer('Change blend mode', (l) => (l.blend = t.value as Layer['blend']));
      else if (t.id === 'opacity') e.editLayer('Change opacity', (l) => (l.opacity = Math.max(0, Math.min(1, Number(t.value) / 100))));
      else if (t.id === 'fill-opacity') e.editLayer('Change fill opacity', (l) => (l.fillOpacity = Math.max(0, Math.min(1, Number(t.value) / 100))));
    });
    el.addEventListener('click', (ev) => {
      const lock = (ev.target as HTMLElement).closest<HTMLElement>('[data-lock-button]');
      if (!lock || !e.layer) return;
      const key = lock.dataset.lockButton!;
      if (layerLock(e.doc.layers, e.selected, 'all', false)) return;
      if (key === 'all') e.command('Lock layer', (d) => setFullLock(findLayer(d.layers, e.selected)!, !e.layer!.locked));
      else
        e.command('Change layer protection', (d) => {
          const l = findLayer(d.layers, e.selected)!;
          const k = key as 'transparency' | 'composite' | 'position';
          setPartialLock(l, k, !ownLock(l, k === 'composite' ? 'pixels' : k));
        });
    });
    const kind = el.querySelector<HTMLSelectElement>('.layer-filter-kind')!,
      text = el.querySelector<HTMLInputElement>('.layer-filter-text')!,
      toggle = el.querySelector<HTMLButtonElement>('.layer-filter-toggle')!;
    const apply = () => {
      filter.kind = kind.value;
      filter.text = text.value;
      toggle.setAttribute('aria-pressed', String(filter.on));
      layersPanel.update!(e, el);
    };
    kind.addEventListener('change', () => {
      filter.on = true;
      apply();
    });
    text.addEventListener('input', () => {
      filter.on = true;
      apply();
    });
    toggle.addEventListener('click', () => {
      filter.on = !filter.on;
      apply();
    });
    bindLayerDrag(e, el);
  },
  update: (e, el) => {
    const l = e.selectedIds.size === 1 ? e.layer : undefined;
    const locked = !!l && !!layerLock(e.doc.layers, l.id, 'all', false);
    const options = el.querySelector('.layer-options')!;
    const focus = document.activeElement?.id;
    patchList(options, [`${blendSelect(l, locked || l?.locked)}<label class="opacity-control">Opacity <input id="opacity" type="number" min="0" max="100" value="${Math.round((l?.opacity ?? 1) * 100)}" ${!l || locked ? 'disabled' : ''}>%</label>`]);
    const lockRow = el.querySelector('.lock-row')!;
    const own = (k: 'transparency' | 'pixels' | 'position') => !!l && ownLock(l, k);
    patchList(lockRow, [`<span class="lock-label-text">Lock:</span>
<button class="icon-button toggle" data-lock-button="transparency" aria-pressed="${own('transparency')}" title="Lock transparent pixels" aria-label="Lock transparency" ${!l ? 'disabled' : ''}>${svg('grid-2x2', 14)}</button>
<button class="icon-button toggle" data-lock-button="composite" aria-pressed="${own('pixels')}" title="Lock image pixels" aria-label="Lock image pixels" ${!l ? 'disabled' : ''}>${svg('paintbrush', 14)}</button>
<button class="icon-button toggle" data-lock-button="position" aria-pressed="${own('position')}" title="Lock position" aria-label="Lock position" ${!l ? 'disabled' : ''}>${svg('move', 14)}</button>
<button class="icon-button toggle" data-lock-button="all" aria-pressed="${!!l?.locked}" title="Lock all" aria-label="Lock layer" ${!l ? 'disabled' : ''}>${svg('lock', 14)}</button>
<label class="opacity-control fill-control">Fill <input id="fill-opacity" type="number" min="0" max="100" value="${Math.round((l?.fillOpacity ?? 1) * 100)}" ${!l || locked ? 'disabled' : ''}>%</label>`]);
    if (focus === 'blend' || focus === 'opacity' || focus === 'fill-opacity') el.querySelector<HTMLElement>(`#${focus}`)?.focus();
    const list = el.querySelector('#layers')!;
    const scroll = list.scrollTop;
    filterEditor = e;
    const banners = layerListBanners.map((f) => f(e)).filter(Boolean);
    const list_ = [...banners, ...rows(e, e.doc.layers, 0)];
    patchList(list, list_.length ? list_ : [`<div class="empty-layers">${svg('layers-2', 22)}<p>Your layers will appear here</p><button data-command="file.open">Add an image</button></div>`]);
    list.scrollTop = scroll;
    el.querySelector('.layer-root-drop')!.toggleAttribute('hidden', !e.doc.layers.length);
    el.querySelector('#layer-count')!.textContent = String(allLayers(e.doc.layers).length);
    hydrateSourceThumbnails(el, e.doc, e.assets);
  },
  menu: () => ['layer.new', 'layer.duplicate', 'layer.delete', '-', 'layer.new-group', 'layer.group', '-', 'layer.rename', 'layer.style-dialog', '-', 'layer.clipping-mask', '-', 'layer.merge-down', 'layer.merge-visible', 'layer.flatten'],
};
