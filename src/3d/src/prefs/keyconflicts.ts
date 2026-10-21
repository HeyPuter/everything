// Key conflicts (pure): bindings of one keymap that the same key event would trigger together.
import { keyLabel, type KeyItem } from '../app/keymap';

export interface KeyConflict {
  keymap: string;
  /** the shared key, e.g. "Ctrl Shift A" (with " (Release)" etc. for other events) */
  key: string;
  /** what the clashing items run */
  items: string[];
}

const what = (k: KeyItem) => k.op || (k.menu ? `menu ${k.menuTitle ?? ''}`.trim() : k.action ? 'an action' : 'nothing');

/** Conflicts in every keymap. Items with different context conditions may share a key on purpose. */
export function keyConflicts(maps: Record<string, KeyItem[]>): KeyConflict[] {
  const out: KeyConflict[] = [];
  for (const [km, list] of Object.entries(maps)) {
    const groups = new Map<string, KeyItem[]>();
    for (const k of list) {
      if (k.inactive || !k.key || k.key === 'NONE') continue;
      const sig = `${k.key}|${!!k.ctrl}|${!!k.shift}|${!!k.alt}|${!!k.any}|${k.value ?? 'PRESS'}`;
      const g = groups.get(sig) ?? [];
      g.push(k);
      groups.set(sig, g);
    }
    for (const g of groups.values()) {
      // only items sharing the same condition (or both unconditional) clash
      const byWhen = new Map<unknown, KeyItem[]>();
      for (const k of g) byWhen.set(k.when ?? null, [...(byWhen.get(k.when ?? null) ?? []), k]);
      for (const same of byWhen.values()) {
        if (same.length < 2) continue;
        // the same operator with different properties is a real clash too; identical duplicates as well
        const v = same[0].value && same[0].value !== 'PRESS' ? ` (${same[0].value.toLowerCase().replace('_', ' ')})` : '';
        out.push({ keymap: km, key: keyLabel(same[0]) + v, items: same.map(what) });
      }
    }
  }
  return out;
}
