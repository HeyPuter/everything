import type { Misspelling } from '../../imaging/text/spelling';

type Skipped = { text: string; hits: Map<string, Misspelling> };
const key = (hit: Misspelling) => `${hit.start}:${hit.end}:${hit.word}`;

/** Ignore individual occurrences for one spelling dialog, isolated by document. */
export class SpellingSkips {
  private owners = new WeakMap<object, Map<string, Skipped>>();

  has(owner: object, id: string): boolean {
    return !!this.owners.get(owner)?.get(id)?.hits.size;
  }

  ignore(owner: object, id: string, text: string, hit: Misspelling) {
    let layers = this.owners.get(owner);
    if (!layers) this.owners.set(owner, layers = new Map());
    let skipped = layers.get(id);
    if (skipped?.text !== text) layers.set(id, skipped = { text, hits: new Map() });
    skipped.hits.set(key(hit), { ...hit });
  }

  filter(owner: object, id: string, text: string, hits: Misspelling[]): Misspelling[] {
    const layers = this.owners.get(owner), skipped = layers?.get(id);
    if (!skipped) return hits;
    // Unrelated edits may move or replace words. Recheck that layer instead
    // of applying an old Ignore choice to a different occurrence.
    if (skipped.text !== text) {
      layers!.delete(id);
      return hits;
    }
    return hits.filter((hit) => !skipped.hits.has(key(hit)));
  }

  /** Known corrections move surviving ignored words with the edited text. */
  remap(owner: object, id: string, before: string, after: string, mapIndex: (at: number) => number) {
    const skipped = this.owners.get(owner)?.get(id);
    if (!skipped || skipped.text !== before) return;
    const hits = new Map<string, Misspelling>();
    for (const hit of skipped.hits.values()) {
      const next = { ...hit, start: mapIndex(hit.start), end: mapIndex(hit.end) };
      if (after.slice(next.start, next.end) === hit.word) hits.set(key(next), next);
    }
    skipped.text = after;
    skipped.hits = hits;
  }
}
