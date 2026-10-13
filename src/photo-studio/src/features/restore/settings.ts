// Remembered settings and named presets of the Portrait & Restore workspace,
// kept in this browser. Image-specific parts (color hints, AI results, depth
// layers) are never stored.
import { normalizeRestore, type RestoreFilterId, type RestoreParams } from '../../imaging/restore/defs';

export type OutputKind = 'layer' | 'new-layer' | 'masked-layer' | 'document' | 'live';
export const OUTPUTS: { id: OutputKind; label: string }[] = [
  { id: 'new-layer', label: 'New layer' },
  { id: 'masked-layer', label: 'New layer with mask' },
  { id: 'layer', label: 'Current layer' },
  { id: 'document', label: 'New document' },
  { id: 'live', label: 'Live Filter (editable)' },
];
export type Remembered = { params: RestoreParams; output: OutputKind; selected: RestoreFilterId; depthChannel: boolean };
export type Preset = { name: string; params: RestoreParams };

const LAST_KEY = 'photo-studio-portrait-restore';
const PRESETS_KEY = 'photo-studio-portrait-restore-presets';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
function storage(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function read(store: Store | undefined, key: string): unknown {
  try {
    return JSON.parse(store?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
function write(store: Store | undefined, key: string, value: unknown) {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: settings are simply not remembered.
  }
}

/** Settings without image-specific parts. */
export function storable(p: RestoreParams): RestoreParams {
  return normalizeRestore({
    filters: p.filters.map(({ aux: _aux, hints: _hints, ...f }) => f),
  });
}

const isOutput = (v: unknown): v is OutputKind => OUTPUTS.some((o) => o.id === v);
export function loadLast(store = storage()): Remembered {
  const v = read(store, LAST_KEY) as Partial<Remembered> | null;
  const params = normalizeRestore(v?.params);
  // A first visit starts with Skin Smoothing on.
  if (!v?.params) params.filters.find((f) => f.id === 'skin')!.enabled = true;
  const selected = params.filters.find((f) => f.id === v?.selected)?.id ?? 'skin';
  return { params, output: isOutput(v?.output) ? v.output : 'new-layer', selected, depthChannel: v?.depthChannel === true };
}
export function saveLast(r: Remembered, store = storage()) {
  write(store, LAST_KEY, { ...r, params: storable(r.params) });
}

export function cleanPresets(v: unknown): Preset[] {
  if (!Array.isArray(v)) return [];
  const out: Preset[] = [];
  for (const x of v.slice(0, 200)) {
    const o = x as Partial<Preset> | null;
    if (!o || typeof o.name !== 'string' || !o.name.trim()) continue;
    const name = o.name.trim().slice(0, 80);
    if (out.some((p) => p.name === name)) continue;
    out.push({ name, params: storable(normalizeRestore(o.params)) });
  }
  return out;
}
export function loadPresets(store = storage()): Preset[] {
  return cleanPresets(read(store, PRESETS_KEY));
}
/** Add or replace a preset by name; returns the new list. */
export function savePreset(name: string, params: RestoreParams, store = storage()): Preset[] {
  const list = loadPresets(store).filter((p) => p.name !== name.trim());
  list.push({ name: name.trim().slice(0, 80), params: storable(params) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  write(store, PRESETS_KEY, list);
  return list;
}
export function deletePreset(name: string, store = storage()): Preset[] {
  const list = loadPresets(store).filter((p) => p.name !== name);
  write(store, PRESETS_KEY, list);
  return list;
}
/** Presets as a shareable file, and back. */
export const exportPresets = (list: Preset[]) => JSON.stringify({ type: 'photo-studio-portrait-restore-presets', version: 1, presets: list }, null, 2);
export function importPresets(text: string, store = storage()): { added: number; list: Preset[] } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('This file is not a Portrait & Restore preset file.');
  }
  const presets = cleanPresets((v as { presets?: unknown })?.presets ?? v);
  if (!presets.length) throw new Error('No presets were found in this file.');
  const list = loadPresets(store).filter((p) => !presets.some((q) => q.name === p.name));
  list.push(...presets);
  list.sort((a, b) => a.name.localeCompare(b.name));
  write(store, PRESETS_KEY, list);
  return { added: presets.length, list };
}
