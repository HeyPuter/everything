// Content addresses for pixel tiles. A shared document refers to tiles by the
// SHA-256 of their bytes, so identical tiles are stored and sent once and any
// participant can verify what it downloads. The index maps the editor's own
// tile IDs (random, per browser) to hashes and back.
import { tileBytes, type TileStore } from '../model/tiles';
import { hash } from './protocol';

export class TileIndex {
  private hashes = new Map<string, string>();
  private ids = new Map<string, string>();
  constructor(public store: TileStore) {}
  hashOf(id: string) {
    return this.hashes.get(id);
  }
  /** The local tile with this content, if the store still holds it. */
  tileFor(h: string) {
    const id = this.ids.get(h);
    return id && this.store.has(id) ? id : undefined;
  }
  /** Hash every tile not yet known; returns the hashes of tiles hashed now. */
  async ensure(ids: Iterable<string>): Promise<Map<string, string>> {
    const fresh = new Map<string, string>();
    const todo = [...new Set(ids)].filter((id) => !this.hashes.has(id));
    // A few at a time keeps memory bounded on very large edits.
    for (let i = 0; i < todo.length; i += 16)
      await Promise.all(
        todo.slice(i, i + 16).map(async (id) => {
          const h = await hash(this.store.get(id) as unknown as Uint8Array);
          this.remember(id, h);
          fresh.set(id, h);
        }),
      );
    return fresh;
  }
  remember(id: string, h: string) {
    this.hashes.set(id, h);
    if (!this.tileFor(h)) this.ids.set(h, id);
  }
  /** Add downloaded tile bytes (already verified) and return the tile ID. */
  put(h: string, bytes: Uint8Array) {
    const existing = this.tileFor(h);
    if (existing) return existing;
    if (bytes.length !== tileBytes(4) && bytes.length !== tileBytes(1)) throw new Error('Invalid shared tile.');
    const id = this.store.add(new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
    this.remember(id, h);
    return id;
  }
  /** Forget tiles the store no longer holds (after a cleanup). */
  prune() {
    for (const [id, h] of this.hashes)
      if (!this.store.has(id)) {
        this.hashes.delete(id);
        if (this.ids.get(h) === id) this.ids.delete(h);
      }
  }
}
