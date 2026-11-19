// Develop presets saved per browser: named settings and the settings last
// applied with OK ("Last Used"). Recalled settings go through the filter's
// normalization, so presets saved by older versions are migrated.
import type { ParamValues } from '../../../imaging/types';
import { normalizeFor } from '../catalog';

const KEY = 'photo-studio-develop-presets';
const LAST_KEY = 'photo-studio-develop-last';
export type DevelopPreset = { name: string; params: Record<string, unknown> };

// In-memory copies keep presets working when storage is unavailable.
let memory: DevelopPreset[] | undefined;
let lastMemory: Record<string, unknown> | null | undefined;

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage is optional; the in-memory copy still works this session. */
  }
}

export function developPresets(): DevelopPreset[] {
  if (!memory) {
    const v = read(KEY);
    memory = Array.isArray(v)
      ? v.filter(
          (p): p is DevelopPreset =>
            !!p && typeof p.name === 'string' && !!p.params && typeof p.params === 'object',
        )
      : [];
  }
  return memory;
}
/** Save (or replace, by name) a preset; returns the stored name. */
export function saveDevelopPreset(name: string, params: ParamValues): string | undefined {
  const clean = name.trim().slice(0, 80);
  if (!clean) return undefined;
  const list = developPresets().filter((p) => p.name !== clean);
  list.push({ name: clean, params: structuredClone(params) as Record<string, unknown> });
  list.sort((a, b) => a.name.localeCompare(b.name));
  memory = list;
  write(KEY, list);
  return clean;
}
export function deleteDevelopPreset(name: string) {
  memory = developPresets().filter((p) => p.name !== name);
  write(KEY, memory);
}
/** Settings of a stored preset, migrated and normalized. */
export const presetSettings = (p: Record<string, unknown>) => normalizeFor('develop', p);

export function rememberDevelopLast(params: ParamValues) {
  lastMemory = structuredClone(params) as Record<string, unknown>;
  write(LAST_KEY, lastMemory);
}
export function developLast(): Record<string, unknown> | undefined {
  if (lastMemory === undefined) {
    const v = read(LAST_KEY);
    lastMemory =
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }
  return lastMemory ?? undefined;
}
/** Forget cached copies (tests). */
export function resetDevelopPresetCache() {
  memory = undefined;
  lastMemory = undefined;
}
