/**
 * Exact frames decoded with WebCodecs (through Mediabunny) for the preview.
 * Used when a media element cannot show the wanted frame yet: while it is
 * still loading or seeking (fast scrubbing), or when the browser defers
 * media loading. Keeps one decoder per file and coalesces requests so only
 * the latest wanted time is decoded.
 *
 * Also hands out pairs of consecutive frames for smooth slow motion while
 * paused (pair()), from a second sink so the two kinds of request do not
 * overwrite each other's canvases.
 */
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';

export class FrameSource {
  /** blobFor(asset): the file to decode (default the library's; the player passes proxies). */
  constructor({ library, onFrame, height = 720, blobFor }) {
    this.library = library;
    this.blobFor = blobFor || ((asset) => library.mediaBlob(asset));
    this.onFrame = onFrame;
    this.height = height;
    this.entries = new Map(); // assetId -> { sink, input, busy, want, frame: { sec, canvas }, failed }
  }

  async _open(asset) {
    const blob = await this.blobFor(asset);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      throw new Error('cannot decode');
    }
    const h = Math.min(this.height, asset.height || this.height);
    // Two pooled canvases: one being shown while the next decodes.
    const sink = new CanvasSink(track, { height: h, fit: 'contain', poolSize: 2 });
    // Pairs: four, so the pair on screen survives while the next pair decodes.
    const pairSink = new CanvasSink(track, { height: h, fit: 'contain', poolSize: 4 });
    return { input, sink, pairSink };
  }

  _entry(asset, sec) {
    let e = this.entries.get(asset.id);
    if (!e) {
      e = { sink: null, input: null, busy: false, want: sec, frame: null, failed: false, opening: null, pair: null, pairWant: null, pairBusy: false };
      this.entries.set(asset.id, e);
    }
    return e;
  }

  async _ready(asset, e) {
    if (!e.sink) {
      e.opening ||= this._open(asset);
      const { input, sink, pairSink } = await e.opening;
      e.input = input;
      e.sink = sink;
      e.pairSink = pairSink;
    }
  }

  /** Last decoded frame for the asset if it is within tolerance of sec. */
  get(asset, sec, tolerance) {
    const e = this.entries.get(asset.id);
    if (!e?.frame) return null;
    return Math.abs(e.frame.sec - sec) <= tolerance ? e.frame : null;
  }

  /** Nearest decoded frame regardless of time (better than a black frame). */
  any(asset) {
    return this.entries.get(asset.id)?.frame || null;
  }

  request(asset, sec) {
    const e = this._entry(asset, sec);
    if (e.failed) return;
    e.want = sec;
    if (!e.busy) this._run(asset, e);
  }

  async _run(asset, e) {
    e.busy = true;
    try {
      await this._ready(asset, e);
      while (e.want !== null) {
        const sec = e.want;
        e.want = null;
        if (e.frame && Math.abs(e.frame.sec - sec) < 1e-4) continue;
        const wrapped = await e.sink.getCanvas(sec);
        if (wrapped) {
          // Remember the time asked for so tolerance checks match the request.
          e.frame = { sec, canvas: wrapped.canvas, ts: wrapped.timestamp, version: (e.frame?.version || 0) + 1 };
          this.onFrame?.();
        }
      }
    } catch {
      e.failed = true;
    } finally {
      e.busy = false;
    }
  }

  /**
   * The two consecutive frames around sec: { a, b, version } with a and b
   * as { canvas, ts } (b null at the end of the file). Returns the decoded
   * pair when it covers sec, else null and decodes it (onFrame follows).
   */
  pair(asset, sec) {
    const e = this._entry(asset, sec);
    if (covers(e.pair, sec)) return e.pair;
    if (e.failed) return null;
    e.pairWant = sec;
    if (!e.pairBusy) this._runPair(asset, e);
    return null;
  }

  async _runPair(asset, e) {
    e.pairBusy = true;
    try {
      await this._ready(asset, e);
      while (e.pairWant !== null) {
        const sec = e.pairWant;
        e.pairWant = null;
        if (covers(e.pair, sec)) continue;
        const it = e.pairSink.canvases(sec);
        try {
          const first = await it.next();
          if (first.done) continue;
          const second = await it.next();
          const b = second.done ? null : { canvas: second.value.canvas, ts: second.value.timestamp };
          e.pair = { a: { canvas: first.value.canvas, ts: first.value.timestamp }, b, version: (e.pair?.version || 0) + 1 };
        } finally {
          await it.return?.();
        }
        this.onFrame?.();
      }
    } catch {
      e.failed = true;
    } finally {
      e.pairBusy = false;
    }
  }

  /** Drop the decoder of an asset (its file went away, e.g. a deleted proxy). */
  forget(assetId) {
    const e = this.entries.get(assetId);
    if (!e) return;
    this.entries.delete(assetId);
    if (e.input) e.input.dispose();
    else e.opening?.then(({ input }) => input.dispose()).catch(() => {});
  }

  dispose() {
    for (const e of this.entries.values()) e.input?.dispose();
    this.entries.clear();
  }
}

/** Whether a decoded pair holds the frame shown at sec (and the one after it). */
function covers(pair, sec) {
  if (!pair) return false;
  const eps = 1e-6;
  return pair.a.ts <= sec + eps && (!pair.b || sec + eps < pair.b.ts);
}
