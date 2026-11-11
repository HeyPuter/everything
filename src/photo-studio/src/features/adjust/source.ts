// Input pixels for the adjustment editors: the composite beneath an
// adjustment layer (histograms, eyedroppers) and on-canvas point picking.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument } from '../../model/document';
import { histograms, type Histograms } from '../../imaging/adjust';
import type { Mask8, RGBA8 } from '../../imaging/types';
import { compositeRGBA } from '../pixels';

/** The document as it composites up to (not including) layer `id`: that
 * layer and everything drawn after it are hidden. */
export function documentBelow(doc: PhotoDocument, id: string): PhotoDocument {
  let found = false;
  const walk = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      if (found) return { ...l, visible: false };
      if (l.id === id) {
        found = true;
        return { ...l, visible: false };
      }
      return l.children.length ? { ...l, children: walk(l.children) } : l;
    });
  return { ...doc, layers: walk(doc.layers), selection: null };
}

// `x`, `y`: document position of the image's top-left pixel (default 0, 0).
export type SourceImage = { image: RGBA8; hist: Histograms; selection?: Mask8; x?: number; y?: number };
const cache = new Map<string, Promise<SourceImage>>();
/** Composite beneath an adjustment layer, memoized on the document content. */
export function belowSource(e: Editor, id: string): Promise<SourceImage> {
  const below = documentBelow(e.doc, id);
  // Hidden layers do not contribute, so editing this layer (or anything
  // above it) keeps the cached composite.
  const key = `${e.session.id}:${below.width}x${below.height}:${JSON.stringify(below.layers, (k, v) => (k === '' || !v || typeof v !== 'object' || !('visible' in v) || v.visible ? v : v.id))}`;
  let p = cache.get(key);
  if (!p) {
    p = compositeRGBA(e, below).then((image) => ({ image, hist: histograms(image) }));
    p.catch(() => cache.delete(key));
    // A handful of entries cover switching between a few adjustment layers.
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(key, p);
  }
  return p;
}

/** Color of an image at document coordinates (point sample). */
export function sampleAt(img: RGBA8, x: number, y: number): [number, number, number] | null {
  const px = Math.floor(x),
    py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
  const i = (py * img.width + px) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** True when a pointer event lands on the canvas viewport, directly or
 * through the transparent shield behind an adjustment dialog. */
export function overViewport(e: Editor, ev: { target: EventTarget | null; clientX: number; clientY: number }) {
  const t = ev.target as HTMLElement | null;
  if (t?.closest?.('#viewport')) return true;
  if (!t?.closest?.('.adj-shield')) return false;
  const r = e.el('#viewport').getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom;
}

type Pending = { resolve: (p: [number, number] | null) => void; cleanup: () => void };
let pending: Pending | undefined;
export const picking = () => !!pending;
/** Arm a one-shot canvas eyedropper. Resolves with document coordinates, or
 * null when cancelled (Escape, another pick, or `cancelPick`). Canvas input
 * is intercepted in the capture phase so the active tool never sees it. */
export function pickPoint(e: Editor): Promise<[number, number] | null> {
  cancelPick();
  const viewport = e.el('#viewport');
  return new Promise((resolve) => {
    const swallow = (ev: Event) => {
      if (!overViewport(e, ev as MouseEvent)) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    const down = (ev: PointerEvent) => {
      if (!overViewport(e, ev) || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const pt = e.docPoint(ev.clientX, ev.clientY);
      finish(pt);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    const finish = (pt: [number, number] | null) => {
      const p = pending;
      pending = undefined;
      p?.cleanup();
      resolve(pt);
    };
    const cleanup = () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      // The matching pointerup/click must not reach the tool either; stop
      // swallowing once the click has passed (or soon, if it never comes).
      const release = () => {
        window.removeEventListener('pointerup', swallow, true);
        window.removeEventListener('click', swallow, true);
        window.removeEventListener('click', release, true);
      };
      window.addEventListener('click', release, true);
      setTimeout(release, 1500);
      viewport.classList.remove('adj-picking');
      document.body.classList.remove('adj-picking-on');
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('keydown', key, true);
    viewport.classList.add('adj-picking');
    document.body.classList.add('adj-picking-on');
    pending = { resolve, cleanup };
  });
}
export function cancelPick() {
  const p = pending;
  pending = undefined;
  if (p) {
    p.cleanup();
    p.resolve(null);
  }
}
