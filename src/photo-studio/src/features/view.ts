import type { Editor } from '../editor';
import { registerCommand, registerOverlay, registerPanel, type Panel } from '../app/registry';
import { formDialog } from '../ui/dialog';
import { readMask, readRGBA, emptyGrid, gridTileIds, writeRect, TILE, tileKey, type TileGrid } from '../model/tiles';
import { tileHolders } from '../app/session';
import { applySelection, canvasRect, selectionGrid } from '../model/selection';
import { commitSelectionMask, selectionOp } from './selection';
import { escapeXML } from '../model/assets';
import { svg } from '../app/icons';
import { gridThumbnail } from './panels/thumbnails';
import { findLayer } from '../model/document';
import { extraHidden, gridSpacing } from './view-extras';
import { installGuides } from './guides';
import { syncMultichannel, toggleSpotVisibility } from './color/spot-channels';

// Grid, pixel grid, Quick Mask and the Channels panel (guides: features/guides.ts).
let lastQuickMaskUrl: { grid: TileGrid; url: string; time: number } | undefined;

function quickMaskOverlay(e: Editor) {
  const grid = (e.settings.quickMaskPreview as TileGrid | undefined) ?? (e.settings.quickMask as TileGrid | undefined);
  if (!grid) return '';
  const now = performance.now();
  if (!lastQuickMaskUrl || lastQuickMaskUrl.grid !== grid) {
    if (lastQuickMaskUrl && now - lastQuickMaskUrl.time < 80) {
      // Throttle redraws while painting; schedule a catch-up frame.
      requestAnimationFrame(() => e.overlay());
    } else {
      // Unselected areas are tinted, like a translucent red film.
      const doc = e.doc;
      const scale = Math.min(1, 2048 / Math.max(doc.width, doc.height));
      const w = Math.max(1, Math.round(doc.width * scale)),
        h = Math.max(1, Math.round(doc.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext('2d')!;
      const img = c.createImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = Math.floor((x + 0.5) / scale),
            dy = Math.floor((y + 0.5) / scale);
          const id = grid.tiles[tileKey(Math.floor(dx / TILE), Math.floor(dy / TILE))];
          const v = id ? e.assets.tiles.get(id)[(dy % TILE) * TILE + (dx % TILE)] : (grid.fill ?? 0);
          const o = (y * w + x) * 4;
          img.data[o] = 255;
          img.data[o + 3] = Math.round((255 - v) * 0.5);
        }
      c.putImageData(img, 0, 0);
      lastQuickMaskUrl = { grid, url: canvas.toDataURL(), time: now };
    }
  }
  return lastQuickMaskUrl ? `<image href="${lastQuickMaskUrl.url}" x="0" y="0" width="${e.doc.width}" height="${e.doc.height}" preserveAspectRatio="none" style="image-rendering:auto"/>` : '';
}

const channelsPanel: Panel = {
  id: 'channels',
  title: 'Channels',
  icon: 'channel',
  location: 'dock-bottom',
  mount: (e, el) => {
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const eye = t.closest<HTMLElement>('[data-spot-eye]');
      if (eye) {
        toggleSpotVisibility(e, eye.dataset.spotEye!);
        return;
      }
      const row = t.closest<HTMLElement>('[data-channel]');
      if (!row) return;
      const id = row.dataset.channel!;
      if (ev.metaKey || ev.ctrlKey || t.closest('.channel-thumb')) {
        void loadChannel(e, id, selectionOp(e, { shift: ev.shiftKey, alt: ev.altKey }));
        return;
      }
      e.settings.activeChannel = id;
      e.dock.update();
    });
    el.addEventListener('dblclick', async (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-channel]');
      const ch = e.doc.channels?.find((c) => c.id === row?.dataset.channel);
      if (!ch) return;
      // Ink channels also choose the color they print in.
      const v = await formDialog('Channel Options', [{ name: 'name', label: 'Name', value: ch.name }, ...(ch.spot ? [{ name: 'color', label: 'Ink color', value: ch.color ?? '#000000', type: 'color' }] : [])], 'OK');
      if (v)
        e.command('Channel Options', (d) => {
          const c = d.channels!.find((c) => c.id === ch.id)!;
          c.name = v.name;
          if (c.spot && /^#[0-9a-f]{6}$/i.test(v.color ?? '')) c.color = v.color.toLowerCase();
          syncMultichannel(e.assets.tiles, d);
        });
    });
  },
  update: (e, el) => {
    const doc = e.doc;
    const active = e.settings.activeChannel as string | undefined;
    const composite = doc.layers.length ? '' : '';
    const spots = doc.mode === 'multichannel' ? (doc.channels ?? []).filter((c) => c.spot) : [];
    const thumb = (c: (typeof spots)[number]) => `<button class="channel-thumb" aria-label="Load ${escapeXML(c.name)} as selection" title="Click to load as selection"><img src="${gridThumbnail(e.assets.tiles, c.grid, doc.width, doc.height, 34, true)}" alt=""></button>`;
    // Multichannel documents list their ink channels in place of RGB.
    const inkRows = spots
      .map((c, i) => `<div class="channel-row ${active === c.id ? 'selected' : ''}" data-channel="${escapeXML(c.id)}"><button type="button" class="eye" data-spot-eye="${escapeXML(c.id)}" aria-pressed="${!c.hidden}" aria-label="${c.hidden ? 'Show' : 'Hide'} ${escapeXML(c.name)}" title="${c.hidden ? 'Show' : 'Hide'} channel">${c.hidden ? '' : svg('eye', 14)}</button>${thumb(c)}<span class="channel-ink" style="background:${c.color ?? '#000000'}" aria-hidden="true"></span><span class="channel-name">${escapeXML(c.name)}</span><kbd>⌘${i + 1}</kbd></div>`)
      .join('');
    const rows = spots.length ? inkRows : [
      ['rgb', 'RGB', 'Mod+2'],
      ['red', 'Red', 'Mod+3'],
      ['green', 'Green', 'Mod+4'],
      ['blue', 'Blue', 'Mod+5'],
    ]
      .map(([id, name, key]) => `<div class="channel-row ${!active || active === id ? 'selected' : ''}" data-channel="${id}"><span class="eye">${svg('eye', 14)}</span><span class="channel-thumb ${id}"></span><span class="channel-name">${name}</span><kbd>${key.replace('Mod+', '⌘')}</kbd></div>`)
      .join('');
    const alpha = (doc.channels ?? [])
      .filter((c) => !spots.includes(c))
      .map((c, i) => `<div class="channel-row ${active === c.id ? 'selected' : ''}" data-channel="${escapeXML(c.id)}"><span class="eye"></span>${thumb(c)}<span class="channel-name">${escapeXML(c.name)}</span><kbd>⌘${i + (spots.length ? spots.length + 1 : 6)}</kbd></div>`)
      .join('');
    const quick = e.settings.quickMask ? `<div class="channel-row selected quick-mask-row"><span class="eye">${svg('eye', 14)}</span><span class="channel-thumb"></span><span class="channel-name"><i>Quick Mask</i></span></div>` : '';
    el.innerHTML = `<div class="channel-list">${rows}${alpha}${quick}${composite}</div><div class="layer-footer"><button data-command="select.load-active-channel" title="Load channel as selection" aria-label="Load channel as selection">${svg('circle-dashed', 16)}</button><button data-command="select.save" title="Save selection as channel" aria-label="Save selection as channel">${svg('mask-add', 16)}</button><button data-command="channel.new" title="Create new channel" aria-label="New channel">${svg('plus', 16)}</button><button data-command="channel.delete" title="Delete channel" aria-label="Delete channel">${svg('trash-2', 16)}</button></div>`;
  },
  menu: () => ['channel.new', 'channel.duplicate', 'channel.delete', '-', 'select.save', 'select.load'],
};
async function loadChannel(e: Editor, id: string, op: ReturnType<typeof selectionOp>) {
  const doc = e.doc;
  const area = canvasRect(doc);
  if (['rgb', 'red', 'green', 'blue'].includes(id)) {
    // Loading a color channel selects by its luminance/values.
    const { compositeRGBA } = await import('./pixels');
    const img = await compositeRGBA(e);
    const m = new Uint8Array(area.width * area.height);
    for (let i = 0; i < m.length; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      m[i] = id === 'red' ? r : id === 'green' ? g : id === 'blue' ? b : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    commitSelectionMask(e, { width: area.width, height: area.height, data: m }, op, 'Load Selection');
    return;
  }
  const ch = doc.channels?.find((c) => c.id === id);
  if (!ch) return;
  const m = readMask(e.assets.tiles, ch.grid, area);
  // Ink channels store 0 for full ink: the ink is what gets selected.
  if (ch.spot) for (let i = 0; i < m.data.length; i++) m.data[i] = 255 - m.data[i];
  commitSelectionMask(e, m, op, 'Load Selection');
}

export function installView(e: Editor) {
  installGuides(e);
  registerPanel(channelsPanel);
  registerOverlay('grid', (e) => {
    if (!e.preferences.showGrid || extraHidden(e, 'grid') || !e.hasDocument) return '';
    const s = gridSpacing(e),
      n = Math.max(1, e.preferences.gridSubdivisions),
      sub = s / n,
      z = e.zoom;
    const W = e.doc.width,
      H = e.doc.height;
    // Lines closer than 3 screen pixels would fill the canvas: skip subdivisions, then the grid.
    if (s * z < 3) return '';
    const minor = sub * z >= 3 && n > 1;
    const major = (v: number) => Math.abs(v / s - Math.round(v / s)) < 1e-6;
    if (e.preferences.gridStyle === 'dots') {
      // Dots at every intersection of major lines, smaller dots at subdivisions.
      const step = minor ? sub : s;
      if ((W / step) * (H / step) > 40000) return '';
      let d = '';
      for (let x = 0; x <= W + 1e-6; x += step)
        for (let y = 0; y <= H + 1e-6; y += step) {
          const r = (major(x) && major(y) ? 1.6 : 0.9) / z;
          d += `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
        }
      return `<path d="${d}" class="grid-dots"/>`;
    }
    let d = '',
      dm = '';
    const step = minor ? sub : s;
    for (let x = step; x < W; x += step) (major(x) ? (d += `M${x} 0V${H}`) : (dm += `M${x} 0V${H}`));
    for (let y = step; y < H; y += step) (major(y) ? (d += `M0 ${y}H${W}`) : (dm += `M0 ${y}H${W}`));
    return `<path d="${dm}" class="grid-minor" stroke-width="${0.5 / z}"/><path d="${d}" class="grid-major" stroke-width="${1 / z}"/>`;
  });
  registerOverlay('pixel-grid', (e) => {
    if (e.zoom < 8 || e.preferences.showPixelGrid === false || extraHidden(e, 'pixel-grid') || !e.hasDocument) return '';
    // Only the visible region gets lines, to keep the overlay small.
    // The visible region in document space (any view rotation).
    const v = e.el('#viewport').getBoundingClientRect();
    const corners = [e.docPoint(v.left, v.top), e.docPoint(v.right, v.top), e.docPoint(v.right, v.bottom), e.docPoint(v.left, v.bottom)];
    const x0 = Math.min(...corners.map((c) => c[0])),
      y0 = Math.min(...corners.map((c) => c[1])),
      x1 = Math.max(...corners.map((c) => c[0])),
      y1 = Math.max(...corners.map((c) => c[1]));
    const ax = Math.max(0, Math.floor(x0)),
      ay = Math.max(0, Math.floor(y0)),
      bx = Math.min(e.doc.width, Math.ceil(x1)),
      by = Math.min(e.doc.height, Math.ceil(y1));
    let d = '';
    for (let x = ax; x <= bx; x++) d += `M${x} ${ay}V${by}`;
    for (let y = ay; y <= by; y++) d += `M${ax} ${y}H${bx}`;
    return `<path d="${d}" class="pixel-grid" stroke-width="${1 / e.zoom}"/>`;
  });
  registerOverlay('quick-mask', quickMaskOverlay);
  // Painting in Quick Mask makes tiles no document refers to until it ends.
  tileHolders.push(() => {
    const ids = gridTileIds(e.settings.quickMask as TileGrid | undefined);
    return gridTileIds(e.settings.quickMaskPreview as TileGrid | undefined, ids);
  });
  const toggle = (key: 'showGrid' | 'showGuides' | 'snap' | 'guidesLocked' | 'showPixelGrid') => () => {
    e.preferences[key] = !(e.preferences[key] ?? (key === 'showPixelGrid'));
    e.savePreferences();
    e.update();
  };
  registerCommand(
    { id: 'view.show-grid', label: 'Grid', shortcut: "Mod+'", checked: (e) => e.preferences.showGrid, run: toggle('showGrid'), recordable: false },
    { id: 'view.show-guides', label: 'Guides', shortcut: 'Mod+;', checked: (e) => e.preferences.showGuides, run: toggle('showGuides'), recordable: false },
    { id: 'view.show-pixel-grid', label: 'Pixel Grid', checked: (e) => e.preferences.showPixelGrid !== false, run: toggle('showPixelGrid'), recordable: false },
    {
      id: 'view.show-selection-edges',
      label: 'Selection Edges',
      checked: (e) => !e.settings.hideSelectionEdges,
      run: (e) => {
        e.settings.hideSelectionEdges = !e.settings.hideSelectionEdges;
        e.overlay();
      },
      recordable: false,
    },
    { id: 'view.snap', label: 'Snap', shortcut: 'Mod+Shift+;', checked: (e) => e.transform.snapping, run: (e) => { e.transform.snapping = !e.transform.snapping; e.options(); }, recordable: false },
    { id: 'view.guides-lock', label: 'Lock Guides', shortcut: 'Mod+Alt+;', checked: (e) => !!e.preferences.guidesLocked, run: toggle('guidesLocked'), recordable: false },
    {
      id: 'select.quick-mask',
      label: 'Edit in Quick Mask Mode',
      shortcut: 'Q',
      checked: (e) => !!e.settings.quickMask,
      enabled: (e) => e.hasDocument,
      run: (e) => {
        const store = e.assets.tiles;
        if (e.settings.quickMask) {
          const grid = e.settings.quickMask as TileGrid;
          delete e.settings.quickMask;
          delete e.settings.quickMaskPreview;
          commitSelectionMask(e, readMask(store, grid, canvasRect(e.doc)), 'replace', 'Quick Mask');
          e.root.querySelector('.quick-mask-button')?.setAttribute('aria-pressed', 'false');
          e.update();
          return;
        }
        const sel = selectionGrid(e.doc, store);
        e.settings.quickMask = sel ?? emptyGrid(1);
        e.root.querySelector('.quick-mask-button')?.setAttribute('aria-pressed', 'true');
        if (!['brush', 'pencil', 'eraser', 'bucket', 'gradient'].includes(e.tool)) e.setTool('brush');
        e.message('Quick Mask: paint with black to remove from the selection, white to add. Press Q to exit.');
        e.update();
      },
    },
    {
      id: 'select.save',
      label: 'Save Selection…',
      enabled: (e) => !!e.doc.selection,
      run: async (e) => {
        const n = (e.doc.channels?.length ?? 0) + 1;
        const v = await formDialog('Save Selection', [{ name: 'name', label: 'Name', value: `Alpha ${n}` }], 'OK');
        if (!v) return;
        const sel = selectionGrid(e.doc, e.assets.tiles)!;
        const grid = sel.fill ? writeRect(e.assets.tiles, emptyGrid(1), 0, 0, readMask(e.assets.tiles, sel, canvasRect(e.doc))) : sel;
        e.command('Save Selection', (d) => {
          d.channels = [...(d.channels ?? []), { id: crypto.randomUUID(), name: v.name || `Alpha ${n}`, grid }];
        });
      },
    },
    {
      id: 'select.load',
      label: 'Load Selection…',
      enabled: (e) => !!e.doc.channels?.length || e.selectedIds.size > 0,
      run: async (e) => {
        const options: [string, string][] = [
          ...(e.doc.channels ?? []).map((c) => [c.id, c.name] as [string, string]),
          ...(e.layer?.kind === 'pixel' ? [[`layer:${e.layer.id}`, `${e.layer.name} Transparency`] as [string, string]] : []),
        ];
        if (!options.length) return;
        const v = await formDialog('Load Selection', [
          { name: 'channel', label: 'Channel', value: options[0][0], type: 'select', options },
          { name: 'invert', label: 'Invert', value: 'no', type: 'checkbox' },
          { name: 'op', label: 'Operation', value: 'replace', type: 'select', options: [['replace', 'New Selection'], ['add', 'Add to Selection'], ['subtract', 'Subtract from Selection'], ['intersect', 'Intersect with Selection']] },
        ], 'OK');
        if (!v) return;
        const area = canvasRect(e.doc);
        let m;
        if (v.channel.startsWith('layer:')) {
          const l = findLayer(e.doc.layers, v.channel.slice(6))!;
          const img = readRGBA(e.assets.tiles, l.pixels!, area);
          m = { width: area.width, height: area.height, data: new Uint8Array(area.width * area.height).map((_, i) => img.data[i * 4 + 3]) };
        } else m = readMask(e.assets.tiles, e.doc.channels!.find((c) => c.id === v.channel)!.grid, area);
        if (v.invert === 'yes') for (let i = 0; i < m.data.length; i++) m.data[i] = 255 - m.data[i];
        commitSelectionMask(e, m, v.op as never, 'Load Selection');
      },
    },
    {
      id: 'select.load-active-channel',
      label: 'Load Channel as Selection',
      hidden: true,
      run: (e) => loadChannel(e, (e.settings.activeChannel as string) ?? 'rgb', 'replace'),
    },
    {
      id: 'channel.new',
      label: 'New Channel',
      enabled: (e) => e.hasDocument,
      run: (e) => {
        const n = (e.doc.channels?.length ?? 0) + 1;
        e.command('New Channel', (d) => {
          d.channels = [...(d.channels ?? []), { id: crypto.randomUUID(), name: `Alpha ${n}`, grid: emptyGrid(1) }];
        });
      },
    },
    {
      id: 'channel.duplicate',
      label: 'Duplicate Channel',
      enabled: (e) => !!e.doc.channels?.some((c) => c.id === e.settings.activeChannel),
      run: (e) => {
        const ch = e.doc.channels!.find((c) => c.id === e.settings.activeChannel)!;
        e.command('Duplicate Channel', (d) => {
          d.channels = [...d.channels!, { ...ch, id: crypto.randomUUID(), name: `${ch.name} copy` }];
          syncMultichannel(e.assets.tiles, d);
        });
      },
    },
    {
      id: 'channel.delete',
      label: 'Delete Channel',
      enabled: (e) => !!e.doc.channels?.some((c) => c.id === e.settings.activeChannel),
      run: (e) => {
        const id = e.settings.activeChannel;
        e.command('Delete Channel', (d) => {
          d.channels = d.channels!.filter((c) => c.id !== id);
          if (!d.channels.length) d.channels = undefined;
          syncMultichannel(e.assets.tiles, d);
        });
        delete e.settings.activeChannel;
      },
    },
  );
  void applySelection;
}
