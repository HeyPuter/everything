// Portrait & Restore: settings normalization, the stack runner, the filter
// catalog integration (menus, Live Filters, actions) and stored presets.
import { describe, expect, it } from 'vitest';
import type { Mask8, RGBA8 } from '../src/imaging/types';
import { RESTORE_FILTERS, RUN_ORDER, isDeterministic, needsPixels, normalizeRestore, replayable } from '../src/imaging/restore/defs';
import { RESTORE_ID } from '../src/imaging/restore/id';
import { affectedArea, runRestore } from '../src/imaging/restore/pipeline';
import { commandId, normalizeFor, opIdFromCommand, stackMargin } from '../src/features/filters/catalog';
import { filterLabel } from '../src/features/filters/menu';
import { runOperation, runStack } from '../src/features/filters/stack';
import { cleanPresets, deletePreset, exportPresets, importPresets, loadLast, loadPresets, saveLast, savePreset, storable } from '../src/features/restore/settings';
import { menuSkeleton } from '../src/app/menus';

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}
const scratched = () =>
  image(64, 48, (x, y) => {
    const v = 120 + ((x * 7 + y * 13) % 9);
    return x === 20 && y > 4 && y < 44 ? [250, 250, 250] : [v, v, v];
  });
class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe('settings normalization', () => {
  it('lists every filter once in run order with valid settings', () => {
    const p = normalizeRestore({ filters: [{ id: 'skin', enabled: true, params: { smoothness: 900, area: 'nope', extra: 1 } }, { id: 'bogus', enabled: true }, 'x'] });
    expect(p.filters.map((f) => f.id)).toEqual(RUN_ORDER);
    const skin = p.filters.find((f) => f.id === 'skin')!;
    expect(skin.enabled).toBe(true);
    expect(skin.params.smoothness).toBe(100);
    expect(skin.params.area).toBe('auto');
    expect('extra' in skin.params).toBe(false);
    expect(p.filters.filter((f) => f.enabled).length).toBe(1);
    expect(normalizeRestore(null).filters.every((f) => !f.enabled)).toBe(true);
    expect(new Set(RESTORE_FILTERS.map((f) => f.group))).toEqual(new Set(['Portrait', 'Restoration', 'Color', 'Creative']));
  });
  it('validates hints, reference statistics, extras and prompts', () => {
    const p = normalizeRestore({
      filters: [
        { id: 'colorize', enabled: true, hints: [{ x: 2, y: 0.5, color: '#FF0000', radius: 500 }, { x: 0.1, y: 0.1, color: 'red' }, null] },
        { id: 'transfer', enabled: true, reference: { all: { mean: [50, 1, 2], std: [10, 3, 3] }, bands: [1, 2] } },
        { id: 'scene', enabled: true, aux: 'scene-1', prompt: 'x'.repeat(5000) },
        { id: 'depth', enabled: true, aux: '../evil' },
      ],
    });
    const c = p.filters.find((f) => f.id === 'colorize')!;
    expect(c.hints).toEqual([{ x: 1, y: 0.5, color: '#ff0000', radius: 100 }]);
    expect(p.filters.find((f) => f.id === 'transfer')!.reference).toBeUndefined();
    const scene = p.filters.find((f) => f.id === 'scene')!;
    expect(scene.aux).toBe('scene-1');
    expect(scene.prompt!.length).toBe(1000);
    expect(p.filters.find((f) => f.id === 'depth')!.aux).toBeUndefined();
  });
  it('knows which settings can be replayed without pixels', () => {
    const p = normalizeRestore({ filters: [{ id: 'skin', enabled: true }, { id: 'style', enabled: true, params: { style: 'ai' }, aux: 'style-1' }, { id: 'depth', enabled: true, params: { source: 'layer' } }] });
    expect(needsPixels(p.filters.find((f) => f.id === 'style')!)).toBe(true);
    expect(isDeterministic(p)).toBe(false);
    const r = replayable(p);
    expect(isDeterministic(r)).toBe(true);
    expect(r.filters.find((f) => f.id === 'skin')!.enabled).toBe(true);
    expect(r.filters.find((f) => f.id === 'style')!.enabled).toBe(false);
    expect(r.filters.some((f) => 'aux' in f)).toBe(false);
  });
});

describe('stack runner', () => {
  it('runs the enabled filters, limited by the selection', async () => {
    const src = scratched();
    const p = normalizeRestore({ filters: [{ id: 'restore', enabled: true, params: { fade: 0, denoise: 0 } }] });
    const out = await runRestore(src, p, { scale: 1, overlay: 'restore', affected: true });
    expect(out.image.data[(20 + 20 * 64) * 4]).toBeLessThan(160);
    expect(out.overlay!.data[20 + 20 * 64]).toBe(255);
    // Only defects changed, so the affected area is the defect mask.
    expect(out.affected!.data[20 + 20 * 64]).toBe(255);
    expect(out.affected!.data[50 + 20 * 64]).toBe(0);
    const sel: Mask8 = { width: 64, height: 48, data: new Uint8Array(64 * 48) };
    for (let y = 0; y < 24; y++) sel.data.fill(255, y * 64, y * 64 + 64);
    const limited = await runRestore(src, p, { scale: 1, selection: sel });
    expect(limited.image.data[(20 + 10 * 64) * 4]).toBeLessThan(160);
    expect(limited.image.data[(20 + 40 * 64) * 4]).toBe(250);
  });
  it('returns a copy and no overlay when nothing is on', async () => {
    const src = scratched();
    const out = await runRestore(src, normalizeRestore({}), { scale: 1, overlay: 'restore' });
    expect(out.image.data).toEqual(src.data);
    expect(out.image.data).not.toBe(src.data);
  });
  it('uses named extra pixels for AI results and skips them when missing', async () => {
    const src = scratched();
    const orange = image(64, 48, () => [240, 130, 30]);
    const p = normalizeRestore({ filters: [{ id: 'scene', enabled: true, params: { protect: false, strength: 100 }, aux: 'scene-1' }] });
    const withAI = await runRestore(src, p, { scale: 1, aux: (n) => (n === 'scene-1' ? orange : undefined) });
    expect(Array.from(withAI.image.data.slice(0, 3))).toEqual([240, 130, 30]);
    const without = await runRestore(src, p, { scale: 1 });
    expect(without.image.data).toEqual(src.data);
  });
  it('keeps the layer transparency with AI style and scene results', async () => {
    // Left half transparent, right half opaque; the AI result is opaque orange.
    const src = image(64, 48, () => [90, 90, 90]);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) src.data[(y * 64 + x) * 4 + 3] = x < 16 ? 0 : 128;
    const orange = image(64, 48, () => [240, 130, 30]);
    const aux = (n: string) => (n === 'ai-1' ? orange : undefined);
    for (const f of [
      { id: 'scene', enabled: true, params: { protect: false, strength: 100 }, aux: 'ai-1' },
      { id: 'scene', enabled: true, params: { protect: false, strength: 50 }, aux: 'ai-1' },
      { id: 'style', enabled: true, params: { style: 'ai', strength: 60 }, aux: 'ai-1' },
    ]) {
      const out = await runRestore(src, normalizeRestore({ filters: [f] }), { scale: 1, aux });
      for (let i = 3; i < src.data.length; i += 4) expect(out.image.data[i]).toBe(src.data[i]);
      // The colors still change.
      expect(out.image.data[(10 * 64 + 50) * 4]).toBeGreaterThan(120);
    }
  });
  it('limits "Selection only" skin smoothing by a feathered selection once, not twice', async () => {
    const r = (() => {
      let s = 5;
      return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    })();
    const src = image(64, 48, () => {
      const v = (r() - 0.5) * 60;
      return [200 + v, 150 + v, 125 + v];
    });
    // Half coverage everywhere: a feathered selection's edge.
    const sel: Mask8 = { width: 64, height: 48, data: new Uint8Array(64 * 48).fill(128) };
    const skin = (area: string) => normalizeRestore({ filters: [{ id: 'skin', enabled: true, params: { area, smoothness: 100, detail: 0 } }] });
    const whole = await runRestore(src, skin('all'), { scale: 1 });
    const limited = await runRestore(src, skin('selection'), { scale: 1, selection: sel, overlay: 'skin', affected: true });
    let diff = 0, n = 0;
    for (let i = 0; i < src.data.length; i += 4)
      for (let c = 0; c < 3; c++) {
        const full = whole.image.data[i + c] - src.data[i + c];
        if (Math.abs(full) < 8) continue;
        // Half of the full change, not a quarter.
        diff += (limited.image.data[i + c] - src.data[i + c]) / full;
        n++;
      }
    expect(n).toBeGreaterThan(100);
    expect(diff / n).toBeGreaterThan(0.45);
    expect(diff / n).toBeLessThan(0.55);
    // The overlay shows the selection, and the affected area is limited by it once.
    expect(limited.overlay!.data[100]).toBe(128);
    expect(limited.affected!.data[100]).toBe(128);
  });
  it('caches stage results by everything they depend on', async () => {
    const src = scratched();
    const cache = new Map<string, unknown>();
    let made = 0;
    const memo = <T,>(k: string, make: () => T): T => {
      if (!cache.has(k)) {
        made++;
        cache.set(k, make());
      }
      return cache.get(k) as T;
    };
    const p = normalizeRestore({ filters: [{ id: 'restore', enabled: true }, { id: 'style', enabled: true, params: { style: 'print' } }] });
    await runRestore(src, p, { scale: 1, memo });
    const first = made;
    // Changing only the second filter reuses the first stage.
    p.filters.find((f) => f.id === 'style')!.params.brush = 9;
    await runRestore(src, p, { scale: 1, memo });
    expect(made - first).toBe(1);
  });
  it('measures the affected area from differences when a filter has no own area', () => {
    const a = image(32, 32, () => [100, 100, 100]);
    const b = image(32, 32, (x) => (x < 16 ? [100, 100, 100] : [200, 100, 100]));
    const m = affectedArea(a, b, [undefined]);
    expect(m.data[16 * 32 + 28]).toBeGreaterThan(200);
    expect(m.data[16 * 32 + 3]).toBe(0);
  });
});

describe('filter catalog integration', () => {
  it('has a command, a menu entry and a label', () => {
    expect(commandId(RESTORE_ID)).toBe('filter.portrait-restore');
    expect(opIdFromCommand('filter.portrait-restore')).toBe(RESTORE_ID);
    expect(filterLabel(RESTORE_ID)).toBe('Portrait & Restore');
    const filter = menuSkeleton.find((m) => m.id === 'filter')!;
    expect(filter.items).toContain('filter.portrait-restore');
    // A global operation: Live Filters and selections render the whole canvas.
    expect(stackMargin([{ id: RESTORE_ID, params: {} }])).toBeUndefined();
    expect((normalizeFor(RESTORE_ID, { filters: 'x' }) as unknown as { filters: unknown[] }).filters.length).toBe(RUN_ORDER.length);
  });
  it('runs as a Live Filter stack entry and as a recorded operation', async () => {
    const src = scratched();
    const params = normalizeFor(RESTORE_ID, { filters: [{ id: 'restore', enabled: true, params: { fade: 0, denoise: 0 } }] });
    const direct = await runOperation(RESTORE_ID, src, params, { foreground: [0, 0, 0], background: [255, 255, 255] });
    expect(direct.data[(20 + 20 * 64) * 4]).toBeLessThan(160);
    const stacked = await runStack(src, [{ id: RESTORE_ID, params, opacity: 0.5 }], { foreground: [0, 0, 0], background: [255, 255, 255] });
    const v = stacked.data[(20 + 20 * 64) * 4];
    expect(v).toBeGreaterThan(direct.data[(20 + 20 * 64) * 4]);
    expect(v).toBeLessThan(250);
  });
});

describe('remembered settings and presets', () => {
  it('starts with Skin Smoothing and remembers settings without image-specific parts', () => {
    const store = new MemoryStorage();
    const first = loadLast(store);
    expect(first.params.filters.find((f) => f.id === 'skin')!.enabled).toBe(true);
    expect(first.output).toBe('new-layer');
    const p = normalizeRestore({ filters: [{ id: 'colorize', enabled: true, hints: [{ x: 0.5, y: 0.5, color: '#00ff00', radius: 4 }], aux: 'colorize-1' }] });
    saveLast({ params: p, output: 'masked-layer', selected: 'colorize', depthChannel: true }, store);
    const back = loadLast(store);
    expect(back.output).toBe('masked-layer');
    expect(back.selected).toBe('colorize');
    expect(back.depthChannel).toBe(true);
    const c = back.params.filters.find((f) => f.id === 'colorize')!;
    expect(c.enabled).toBe(true);
    expect(c.hints).toEqual([]);
    expect(c.aux).toBeUndefined();
    expect(storable(p).filters.find((f) => f.id === 'colorize')!.hints).toEqual([]);
  });
  it('saves, replaces, deletes, exports and imports presets', () => {
    const store = new MemoryStorage();
    const a = normalizeRestore({ filters: [{ id: 'depth', enabled: true, params: { blur: 70 } }] });
    savePreset('Soft focus', a, store);
    savePreset('Archive', normalizeRestore({ filters: [{ id: 'restore', enabled: true }] }), store);
    savePreset('Soft focus', normalizeRestore({ filters: [{ id: 'depth', enabled: true, params: { blur: 20 } }] }), store);
    let list = loadPresets(store);
    expect(list.map((p) => p.name)).toEqual(['Archive', 'Soft focus']);
    expect(list[1].params.filters.find((f) => f.id === 'depth')!.params.blur).toBe(20);
    const text = exportPresets(list);
    list = deletePreset('Archive', store);
    expect(list.map((p) => p.name)).toEqual(['Soft focus']);
    const other = new MemoryStorage();
    expect(importPresets(text, other).added).toBe(2);
    expect(loadPresets(other).length).toBe(2);
    expect(() => importPresets('nope', other)).toThrow();
    expect(() => importPresets('{"presets":[]}', other)).toThrow();
    expect(cleanPresets([{ name: '  ' }, { name: 'A' }, { name: 'A' }, 5]).map((p) => p.name)).toEqual(['A']);
  });
});
