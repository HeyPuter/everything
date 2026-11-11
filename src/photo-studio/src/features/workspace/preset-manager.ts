import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { tools } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { download } from '../../persistence/puter';
import { gridFromImage } from '../../model/tiles';
import { documentPatternPixels, type DocumentPattern } from '../../model/fill-layer';
import { validGradient, validLayerStyle } from '../../model/layer-style';
import { gradientToCss } from '../../imaging/gradient/edit';
import { gradientPresets } from '../../imaging/gradient/presets';
import type { Gradient } from '../../imaging/gradient/gradient';
import { patternPresets } from '../../imaging/pattern/presets';
import { stylePresets, type StylePreset } from '../../imaging/effects/presets';
import { builtinBrushPresets, brushPresetPreview, setUserBrushPresets, userBrushPresets, type BrushPresetData } from '../brushes';
import { currentSwatches, replaceSwatches } from '../panels';
import { colors, loadUserGradients, patternThumb, saveUserGradients } from '../effects/state';
import { loadUserStyles, setUserStyles, showStyleThumbnail } from '../effects/style-thumbs';
import { builtinShapes, setUserShapes, userShapes, type CustomShape } from '../vector/custom-shapes';
import { setToolPresets, toolPresets, validToolPreset, type ToolPreset } from './tool-presets';
import { moveItem, parsePresetFile, presetFile } from './preset-file';

// Preset Manager (Edit → Presets): one place to rename, delete, reorder,
// import and export the user's presets of every kind. Built-in presets are
// listed for reference and are read-only.

type Entry = { name: string; thumb: string };
interface PresetKind<T = unknown> {
  id: string;
  title: string;
  icon: string;
  builtins(e: Editor): Entry[];
  user(e: Editor): T[];
  setUser(e: Editor, items: T[], label: string): void;
  entry(e: Editor, item: T): Entry;
  rename?(item: T, name: string): T;
  // File representation: validation, and conversion in both directions.
  valid(item: unknown): boolean;
  toFile?(e: Editor, item: T): unknown;
  fromFile?(e: Editor, item: unknown): T;
  needsDocument?: boolean;
  // Thumbnails that render asynchronously.
  afterRender?(e: Editor, el: HTMLElement): void;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const named = (v: unknown) => isObject(v) && typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 200;
const b64 = (d: Uint8Array | Uint8ClampedArray) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const imgThumb = (src: string, cls = '') => `<img class="pm-thumb ${cls}" src="${src}" alt="">`;
const gradientThumb = (e: Editor, g: Gradient) => `<span class="pm-thumb pm-gradient" style="background:${gradientToCss(g, colors(e))}, var(--fx-checker)"></span>`;
const shapeThumb = (d: string) => `<svg class="pm-thumb pm-shape" viewBox="-4 -4 108 108" aria-hidden="true"><path d="${escapeXML(d)}" fill="currentColor" fill-rule="evenodd"/></svg>`;

const brushes: PresetKind<BrushPresetData> = {
  id: 'brushes',
  title: 'Brushes',
  icon: 'brush-presets',
  builtins: () => builtinBrushPresets().map((p) => ({ name: p.name, thumb: imgThumb(brushPresetPreview(p), 'pm-wide') })),
  user: () => userBrushPresets(),
  setUser: (_e, items) => setUserBrushPresets(items),
  entry: (_e, p) => ({ name: p.name, thumb: imgThumb(brushPresetPreview(p), 'pm-wide') }),
  rename: (p, name) => ({ ...p, name }),
  valid: (v) => {
    if (!named(v) || !isObject((v as BrushPresetData).tip)) return false;
    const s = (v as BrushPresetData).sample;
    return s === undefined || (isObject(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0 && s.width <= 1024 && s.height <= 1024 && typeof s.data === 'string');
  },
};
const swatches: PresetKind<string> = {
  id: 'swatches',
  title: 'Swatches',
  icon: 'swatch-book',
  builtins: () => [],
  user: () => currentSwatches(),
  setUser: (e, items) => replaceSwatches(e, items),
  entry: (_e, c) => ({ name: c.toUpperCase(), thumb: `<span class="pm-thumb pm-swatch" style="background:${c}"></span>` }),
  valid: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  fromFile: (_e, v) => (v as string).toLowerCase(),
};
const gradients: PresetKind<Gradient> = {
  id: 'gradients',
  title: 'Gradients',
  icon: 'blend',
  builtins: (e) => gradientPresets.flatMap((f) => f.gradients).map((g) => ({ name: g.name ?? 'Gradient', thumb: gradientThumb(e, g) })),
  user: () => loadUserGradients(),
  setUser: (e, items) => {
    saveUserGradients(items);
    e.dock.update();
  },
  entry: (e, g) => ({ name: g.name ?? 'Gradient', thumb: gradientThumb(e, g) }),
  rename: (g, name) => ({ ...g, name }),
  valid: validGradient,
};
const styles: PresetKind<StylePreset> = {
  id: 'styles',
  title: 'Styles',
  icon: 'fx',
  builtins: () => stylePresets.map((s) => ({ name: s.name, thumb: `<img class="pm-thumb" alt="" data-style-thumb="b:${escapeXML(s.id)}">` })),
  user: () => loadUserStyles(),
  setUser: (e, items) => {
    setUserStyles(items);
    e.dock.update();
  },
  entry: (_e, s) => ({ name: s.name, thumb: `<img class="pm-thumb" alt="" data-style-thumb="u:${escapeXML(s.id)}">` }),
  rename: (s, name) => ({ ...s, name }),
  valid: (v) => named(v) && validLayerStyle((v as StylePreset).style),
  fromFile: (_e, v) => ({ ...(v as StylePreset), id: `user-${crypto.randomUUID()}` }),
  afterRender: (_e, el) => {
    const all = new Map<string, StylePreset>([...stylePresets.map((s) => [`b:${s.id}`, s] as const), ...loadUserStyles().map((s) => [`u:${s.id}`, s] as const)]);
    el.querySelectorAll<HTMLImageElement>('[data-style-thumb]').forEach((img) => {
      const s = all.get(img.dataset.styleThumb!);
      if (s) showStyleThumbnail(img, s.style, 32);
    });
  },
};
type PatternFileItem = { name: string; width: number; height: number; rgba: string };
const patterns: PresetKind<DocumentPattern> = {
  id: 'patterns',
  title: 'Patterns',
  icon: 'grid-2x2',
  needsDocument: true,
  builtins: () => patternPresets().map((p) => ({ name: p.name, thumb: imgThumb(patternThumb(p, 32)) })),
  user: (e) => [...(e.doc.patterns ?? [])],
  setUser: (e, items, label) => {
    e.command(label, (d) => {
      d.patterns = items.length ? items : undefined;
    });
  },
  entry: (e, p) => {
    const px = documentPatternPixels(p, e.assets.tiles);
    return { name: p.name, thumb: px ? imgThumb(patternThumb(px, 32)) : '<span class="pm-thumb"></span>' };
  },
  rename: (p, name) => ({ ...p, name }),
  valid: (v) => {
    if (!named(v)) return false;
    const p = v as PatternFileItem;
    return Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width <= 1024 && p.height <= 1024 && typeof p.rgba === 'string' && Math.floor((p.rgba.length * 3) / 4) >= p.width * p.height * 4;
  },
  toFile: (e, p) => {
    const px = documentPatternPixels(p, e.assets.tiles);
    return { name: p.name, width: p.width, height: p.height, rgba: px ? b64(px.tile.data) : '' };
  },
  fromFile: (e, v) => {
    const p = v as PatternFileItem;
    const data = unb64(p.rgba).subarray(0, p.width * p.height * 4);
    if (data.length !== p.width * p.height * 4) throw new Error(`Pattern “${p.name}” has incomplete pixels.`);
    const grid = gridFromImage(e.assets.tiles, { width: p.width, height: p.height, data: new Uint8ClampedArray(data) });
    return { id: `user-${crypto.randomUUID()}`, name: p.name.trim(), width: p.width, height: p.height, grid };
  },
};
const shapes: PresetKind<CustomShape> = {
  id: 'shapes',
  title: 'Shapes',
  icon: 'shapes',
  builtins: () => builtinShapes.map((s) => ({ name: s.name, thumb: shapeThumb(s.d) })),
  user: () => userShapes(),
  setUser: (e, items) => {
    setUserShapes(items);
    e.dock.update();
  },
  entry: (_e, s) => ({ name: s.name, thumb: shapeThumb(s.d) }),
  rename: (s, name) => ({ ...s, name }),
  valid: (v) => named(v) && typeof (v as CustomShape).d === 'string' && (v as CustomShape).d.length < 200_000 && /^[\sMmLlHhVvCcSsQqTtAaZz0-9.,eE+-]+$/.test((v as CustomShape).d),
  toFile: (_e, s) => ({ id: s.id, name: s.name, d: s.d }),
  fromFile: (_e, v) => ({ id: `user-${crypto.randomUUID()}`, name: (v as CustomShape).name.trim(), d: (v as CustomShape).d }),
};
const toolPresetKind: PresetKind<ToolPreset> = {
  id: 'tool-presets',
  title: 'Tool Presets',
  icon: 'tool-preset',
  builtins: () => [],
  user: () => toolPresets(),
  setUser: (e, items) => setToolPresets(e, items),
  entry: (_e, p) => ({ name: p.name, thumb: `<span class="pm-thumb pm-icon">${svg(tools.get(p.tool)?.icon ?? 'tool-preset', 16)}</span>` }),
  rename: (p, name) => ({ ...p, name }),
  valid: validToolPreset,
  fromFile: (_e, v) => ({ ...(v as ToolPreset), id: crypto.randomUUID() }),
};
export const presetKinds: PresetKind[] = [brushes, swatches, gradients, styles, patterns, shapes, toolPresetKind] as PresetKind[];

export function openPresetManager(e: Editor, initial = 'brushes') {
  document.querySelector('dialog.preset-manager')?.remove();
  const d = document.createElement('dialog');
  d.className = 'preset-manager';
  d.setAttribute('aria-label', 'Preset Manager');
  document.body.append(d);
  let kind = presetKinds.find((k) => k.id === initial) ?? presetKinds[0];
  let selected = new Set<number>();
  let anchor = -1;
  let renaming = -1;
  let filter = '';
  let notice = '';
  const user = () => kind.user(e);
  const commit = (items: unknown[], label: string) => {
    kind.setUser(e, items, label);
  };
  const render = () => {
    const available = !kind.needsDocument || e.hasDocument;
    const items = available ? user() : [];
    const q = filter.trim().toLowerCase();
    const show = (name: string) => !q || name.toLowerCase().includes(q);
    const builtins = available ? kind.builtins(e) : [];
    const userRows = items
      .map((item, i) => ({ item, i, entry: kind.entry(e, item) }))
      .filter(({ entry }) => show(entry.name))
      .map(({ i, entry }) => `<div class="pm-row ${selected.has(i) ? 'selected' : ''}" role="option" aria-selected="${selected.has(i)}" data-index="${i}" draggable="${!q}" tabindex="0">${entry.thumb}${renaming === i ? `<input class="pm-rename" value="${escapeXML(entry.name)}" aria-label="Preset name" maxlength="200">` : `<span class="pm-name">${escapeXML(entry.name)}</span>`}${q ? '' : `<span class="pm-grip" aria-hidden="true">${svg('grip-vertical', 14)}</span>`}</div>`)
      .join('');
    const builtinRows = builtins
      .filter((b) => show(b.name))
      .map((b) => `<div class="pm-row builtin" role="option" aria-selected="false" aria-disabled="true">${b.thumb}<span class="pm-name">${escapeXML(b.name)}</span><span class="pm-badge">${svg('lock', 11)}Built-in</span></div>`)
      .join('');
    const one = selected.size === 1 ? [...selected][0] : -1;
    const counts = (k: PresetKind) => (!k.needsDocument || e.hasDocument ? k.user(e).length : 0);
    d.innerHTML = `<form method="dialog"><h2>Preset Manager</h2><div class="pm-body"><nav class="pm-kinds" role="tablist" aria-label="Preset types" aria-orientation="vertical">${presetKinds
      .map((k) => `<button type="button" role="tab" data-kind="${k.id}" aria-selected="${k === kind}">${svg(k.icon, 15)}<span>${escapeXML(k.title)}</span><small>${counts(k)}</small></button>`)
      .join('')}</nav><section class="pm-main" role="tabpanel" aria-label="${escapeXML(kind.title)}"><div class="pm-toolbar"><input type="search" class="pm-filter" placeholder="Filter ${escapeXML(kind.title.toLowerCase())}" aria-label="Filter presets" value="${escapeXML(filter)}"><span class="panel-tabs-spacer"></span><button type="button" class="icon-button" data-pm="up" title="Move up" aria-label="Move up" ${selected.size && !q && Math.min(...selected) > 0 ? '' : 'disabled'}>${svg('arrow-up', 15)}</button><button type="button" class="icon-button" data-pm="down" title="Move down" aria-label="Move down" ${selected.size && !q && Math.max(...selected) < items.length - 1 ? '' : 'disabled'}>${svg('arrow-down', 15)}</button><button type="button" data-pm="rename" ${kind.rename && one >= 0 ? '' : 'disabled'}>Rename</button><button type="button" data-pm="delete" ${selected.size ? '' : 'disabled'}>Delete</button><span class="pm-divider"></span><button type="button" data-pm="import" ${available ? '' : 'disabled'}>${svg('upload', 14)}Import…</button><button type="button" data-pm="export" ${items.length ? '' : 'disabled'}>${svg('download', 14)}Export${selected.size ? ' Selected' : ''}…</button></div><div class="pm-list" role="listbox" aria-multiselectable="true" aria-label="${escapeXML(kind.title)}">${
      !available
        ? '<p class="muted pm-empty">Patterns are stored in documents. Open a document to manage its patterns.</p>'
        : (userRows ? `<div class="pm-section">Your ${escapeXML(kind.title.toLowerCase())}</div>${userRows}` : `<p class="muted pm-empty">${q ? 'No matching presets.' : `You have no ${escapeXML(kind.title.toLowerCase())} of your own yet.`}</p>`) +
          (builtinRows ? `<div class="pm-section">Built-in</div>${builtinRows}` : '')
    }</div><p class="muted pm-hint">${escapeXML(notice || (kind.id === 'patterns' ? 'Patterns belong to the current document; changes can be undone.' : 'Drag your presets to reorder them. Built-in presets are read-only. Export saves the selected presets, or all of yours, as a JSON file.'))}</p></section></div><div class="dialog-actions"><button class="primary">Done</button></div></form>`;
    kind.afterRender?.(e, d);
    const input = d.querySelector<HTMLInputElement>('.pm-rename');
    if (input) {
      input.focus();
      input.select();
    }
  };
  const setKind = (k: PresetKind) => {
    kind = k;
    selected = new Set();
    anchor = renaming = -1;
    filter = notice = '';
    render();
  };
  const finishRename = (save: boolean) => {
    const input = d.querySelector<HTMLInputElement>('.pm-rename');
    const i = renaming;
    renaming = -1;
    if (save && input && kind.rename && input.value.trim()) {
      const items = user();
      items[i] = kind.rename(items[i], input.value.trim());
      commit(items, 'Rename Preset');
    }
    render();
    d.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  };
  const move = (dir: -1 | 1) => {
    let items = user();
    const order = [...selected].sort((a, b) => (dir < 0 ? a - b : b - a));
    for (const i of order) items = moveItem(items, i, i + dir);
    selected = new Set(order.map((i) => i + dir));
    commit(items, 'Reorder Presets');
    render();
  };
  const remove = () => {
    const items = user().filter((_, i) => !selected.has(i));
    const n = selected.size;
    selected = new Set();
    notice = `Deleted ${n} preset${n === 1 ? '' : 's'}.`;
    commit(items, 'Delete Presets');
    render();
  };
  const exportItems = () => {
    const items = user().filter((_, i) => !selected.size || selected.has(i));
    const out = items.map((item) => (kind.toFile ? kind.toFile(e, item) : item));
    download(new Blob([JSON.stringify(presetFile(kind.id, out), null, 1)], { type: 'application/json' }), `${kind.id}.presets.json`);
    notice = `Exported ${out.length} preset${out.length === 1 ? '' : 's'}.`;
    render();
  };
  const importItems = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { items, skipped } = parsePresetFile(await file.text(), kind.id, kind.valid);
        const added = items.map((v) => (kind.fromFile ? kind.fromFile(e, v) : v));
        const before = user();
        commit([...before, ...added], 'Import Presets');
        selected = new Set(added.map((_, i) => before.length + i));
        notice = `Imported ${added.length} preset${added.length === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} invalid` : ''}.`;
      } catch (error) {
        notice = (error as Error).message;
      }
      render();
    };
    input.click();
  };
  d.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const k = t.closest<HTMLElement>('[data-kind]');
    if (k) {
      setKind(presetKinds.find((x) => x.id === k.dataset.kind)!);
      return;
    }
    const action = t.closest<HTMLElement>('[data-pm]')?.dataset.pm;
    if (action === 'up' || action === 'down') move(action === 'up' ? -1 : 1);
    else if (action === 'rename' && selected.size === 1) {
      renaming = [...selected][0];
      render();
    } else if (action === 'delete') remove();
    else if (action === 'export') exportItems();
    else if (action === 'import') importItems();
    if (action) return;
    const row = t.closest<HTMLElement>('.pm-row[data-index]');
    if (!row || t.closest('.pm-rename')) return;
    const i = Number(row.dataset.index);
    if (ev.shiftKey && anchor >= 0) {
      selected = new Set();
      for (let x = Math.min(anchor, i); x <= Math.max(anchor, i); x++) selected.add(x);
    } else if (ev.metaKey || ev.ctrlKey) {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      anchor = i;
    } else {
      selected = new Set([i]);
      anchor = i;
    }
    notice = '';
    render();
    d.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  });
  d.addEventListener('dblclick', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.pm-row[data-index]');
    if (!row || !kind.rename || (ev.target as HTMLElement).closest('.pm-rename')) return;
    renaming = Number(row.dataset.index);
    selected = new Set([renaming]);
    render();
  });
  d.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.classList.contains('pm-filter')) return;
    filter = t.value;
    selected = new Set();
    render();
    const f = d.querySelector<HTMLInputElement>('.pm-filter')!;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  });
  d.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.classList.contains('pm-rename')) {
      if (ev.key === 'Enter' || ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finishRename(ev.key === 'Enter');
      }
      return;
    }
    const row = t.closest<HTMLElement>('.pm-row[data-index]');
    if (!row) return;
    const i = Number(row.dataset.index);
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected.size) remove();
    else if (ev.key === 'F2' && kind.rename) {
      renaming = i;
      selected = new Set([i]);
      render();
    } else if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && ev.altKey && selected.size) move(ev.key === 'ArrowUp' ? -1 : 1);
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const rows = [...d.querySelectorAll<HTMLElement>('.pm-row[data-index]')];
      rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (ev.key === ' ') {
      selected = new Set([i]);
      anchor = i;
      render();
      d.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
    } else return;
    ev.preventDefault();
  });
  d.addEventListener('focusout', (ev) => {
    if ((ev.target as HTMLElement).classList?.contains('pm-rename') && renaming >= 0) finishRename(true);
  });
  // Drag to reorder.
  let dragFrom = -1;
  d.addEventListener('dragstart', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.pm-row[data-index]');
    if (!row) return;
    dragFrom = Number(row.dataset.index);
    ev.dataTransfer?.setData('text/plain', String(dragFrom));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  const target = (ev: DragEvent) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.pm-row[data-index]');
    if (!row) return;
    const r = row.getBoundingClientRect();
    return { row, after: ev.clientY > r.top + r.height / 2 };
  };
  const clearMarks = () => d.querySelectorAll('.drop-above,.drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
  d.addEventListener('dragover', (ev) => {
    if (dragFrom < 0) return;
    const at = target(ev);
    clearMarks();
    if (!at) return;
    ev.preventDefault();
    at.row.classList.add(at.after ? 'drop-below' : 'drop-above');
  });
  d.addEventListener('drop', (ev) => {
    const at = target(ev);
    clearMarks();
    if (dragFrom < 0 || !at) return;
    ev.preventDefault();
    let to = Number(at.row.dataset.index) + (at.after ? 1 : 0);
    if (to > dragFrom) to--;
    if (to !== dragFrom) {
      commit(moveItem(user(), dragFrom, to), 'Reorder Presets');
      selected = new Set([to]);
      anchor = to;
    }
    dragFrom = -1;
    render();
  });
  d.addEventListener('dragend', () => {
    dragFrom = -1;
    clearMarks();
  });
  d.addEventListener('close', () => d.remove());
  render();
  d.showModal();
}
