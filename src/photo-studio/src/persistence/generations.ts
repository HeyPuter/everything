// Generation History: every AI result (Generate Image, Edit with Prompt, AI
// Fill, AI Expand, the AI layer of Upscale and images the Assistant asked for)
// kept in this browser with its prompt and settings, bounded by count and
// size (oldest removed first). Pure storage; the panel lives in
// features/generations.
import { IndexedDbStore, MemoryStore, type LocalStore } from './local-store';

export type GenerationKind = 'generate' | 'edit' | 'fill' | 'expand' | 'upscale' | 'restore' | 'assistant';
export const GENERATION_KINDS: GenerationKind[] = ['generate', 'edit', 'fill', 'expand', 'upscale', 'restore', 'assistant'];
export const GENERATION_LABELS: Record<GenerationKind, string> = {
  generate: 'Generate Image',
  edit: 'Edit with Prompt',
  fill: 'AI Fill',
  expand: 'AI Expand',
  upscale: 'AI Upscale',
  restore: 'Portrait & Restore',
  assistant: 'Assistant',
};

export type GenerationEntry = {
  id: string;
  kind: GenerationKind;
  prompt: string;
  // The dialog settings that produced it (style, aspect, model, quality,
  // method...), enough to open the dialog again with the same choices.
  settings: Record<string, unknown>;
  model?: string;
  // Where the result was placed in its document (document pixels), if anywhere.
  placement?: { x: number; y: number; width?: number; height?: number };
  docId?: string;
  docName: string;
  time: number;
  width: number;
  height: number;
  // Bytes of the stored image.
  size: number;
  thumb?: Blob;
};

export type GenerationLimits = { count: number; bytes: number };
export const DEFAULT_GENERATION_LIMITS: GenerationLimits = { count: 150, bytes: 250 * 1024 * 1024 };

type Stores = 'entries' | 'images';
let shared: LocalStore<Stores> | undefined;
function defaultStore(): LocalStore<Stores> {
  shared ??= typeof indexedDB !== 'undefined' ? new IndexedDbStore<Stores>('photo-studio-generations', ['entries', 'images']) : new MemoryStore<Stores>();
  return shared;
}

export class GenerationStore {
  constructor(private store: LocalStore<Stores> = defaultStore()) {}
  /** Store a result; older entries beyond the limits are removed. */
  async add(entry: Omit<GenerationEntry, 'id' | 'time' | 'size'> & { time?: number }, image: Blob, limits: GenerationLimits = DEFAULT_GENERATION_LIMITS): Promise<GenerationEntry> {
    const full: GenerationEntry = { ...entry, id: crypto.randomUUID(), time: entry.time ?? Date.now(), size: image.size };
    // The image and its entry are written together, so a failed write (quota)
    // leaves no image without an entry.
    if (this.store.putAll)
      await this.store.putAll([
        { store: 'images', key: full.id, value: image },
        { store: 'entries', key: full.id, value: full },
      ]);
    else {
      await this.store.put('images', full.id, image);
      try {
        await this.store.put('entries', full.id, full);
      } catch (error) {
        await this.store.delete('images', full.id).catch(() => {});
        throw error;
      }
    }
    await this.prune(limits);
    return full;
  }
  /** Remove the oldest entries until both limits hold (the newest always
   * stays), and images no entry refers to (left by an interrupted removal). */
  async prune(limits: GenerationLimits = DEFAULT_GENERATION_LIMITS) {
    const list = await this.list();
    let bytes = list.reduce((s, x) => s + x.size + (x.thumb?.size ?? 0), 0);
    for (let i = list.length - 1; i >= 1 && (i >= limits.count || bytes > limits.bytes); i--) {
      bytes -= list[i].size + (list[i].thumb?.size ?? 0);
      await this.remove(list[i].id);
    }
    await this.removeOrphans();
  }
  private async removeOrphans() {
    if (!this.store.keys) return;
    // Images first: an entry written meanwhile (with its image, at once) is
    // then among the entries read after.
    const images = await this.store.keys('images');
    const ids = new Set(await this.store.keys('entries'));
    for (const key of images) if (!ids.has(key)) await this.store.delete('images', key);
  }
  /** Every entry, newest first. */
  async list(): Promise<GenerationEntry[]> {
    return (await this.store.all<GenerationEntry>('entries')).sort((a, b) => b.time - a.time);
  }
  async get(id: string) {
    return this.store.get<GenerationEntry>('entries', id);
  }
  async image(id: string): Promise<Blob | undefined> {
    return this.store.get<Blob>('images', id);
  }
  async remove(id: string) {
    await this.store.delete('entries', id);
    await this.store.delete('images', id);
  }
  async clear() {
    for (const e of await this.store.all<GenerationEntry>('entries')) await this.remove(e.id);
    await this.removeOrphans();
  }
}

/** Entries of one kind (or all) whose prompt, model or document name contains every word of `query`. */
export function filterGenerations(list: GenerationEntry[], opts: { kind?: GenerationKind | 'all'; query?: string }): GenerationEntry[] {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((x) => {
    if (opts.kind && opts.kind !== 'all' && x.kind !== opts.kind) return false;
    const hay = `${x.prompt} ${x.model ?? ''} ${x.docName}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
