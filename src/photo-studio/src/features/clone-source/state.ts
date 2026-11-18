// Clone sources shared by the Clone Stamp and the Healing Brush: up to five
// source points (Alt-click sets the active one), each with its own offset,
// scale, rotation and flips, plus the source overlay drawn on the canvas.
// Sources are session state of the workspace, not part of the document; a
// source may come from another open document, whose pixels are captured when
// the source is set.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument } from '../../model/document';
import { findLayer } from '../../model/document';
import { canvasRect } from '../../model/selection';
import { readRGBA } from '../../model/tiles';
import type { RGBA8 } from '../../imaging/types';
import {
  bilinearSampler,
  identityCloneTransform,
  isTranslation,
  mappedSampler,
  sourceMapping,
  type CloneTransform,
  type Sampler,
} from '../../imaging/retouch/clone-transform';
import { compositeRGBA, toRGBA8 } from '../pixels';
import { gridSampler, imageSampler } from '../retouch/samplers';

export type SampleMode = 'current' | 'below' | 'all';
export type CloneSource = CloneTransform & {
  point: [number, number];
  // Destination minus source once a stroke fixed it (or typed in the panel).
  offset?: [number, number];
  sessionId: string;
  docName: string;
  layerName: string;
  // The layer that was current when the source was set.
  layerId?: string;
  // Pixels captured from another document when the source was set there.
  snapshot?: RGBA8;
};
export type OverlaySettings = { show: boolean; opacity: number; clipped: boolean; autoHide: boolean; invert: boolean; blend: 'normal' | 'darken' | 'lighten' | 'difference' };

export const SOURCE_COUNT = 5;
export const cloneState = {
  active: 0,
  sources: new Array<CloneSource | undefined>(SOURCE_COUNT).fill(undefined),
  // Transform for sources not set yet (the panel edits the active slot).
  pending: identityCloneTransform(),
  overlay: { show: false, opacity: 100, clipped: true, autoHide: false, invert: false, blend: 'normal' } as OverlaySettings,
  linkScale: true,
};
export const activeSource = () => cloneState.sources[cloneState.active];
const listeners = new Set<() => void>();
export function onCloneSourceChange(f: () => void) {
  listeners.add(f);
}
export function cloneSourceChanged() {
  overlayImage = undefined;
  for (const f of listeners) f();
}

export function sampleMode(e: Editor, tool: 'clone' | 'heal'): SampleMode {
  const v = e.settings[tool === 'clone' ? 'cloneSample' : 'healSample'];
  return v === 'all' || v === 'below' ? v : 'current';
}
export const ignoreAdjustments = (e: Editor) => e.settings.cloneIgnoreAdjustments === true;

/** The layer stack up to and including `id` (layers above it removed), with
 * adjustment layers optionally hidden: what "Current & Below" samples. */
export function layersBelow(layers: Layer[], id: string, hideAdjustments = false): Layer[] | undefined {
  const strip = (list: Layer[]) => (hideAdjustments ? withoutAdjustments(list) : list);
  const walk = (list: Layer[]): Layer[] | undefined => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return strip(list.slice(0, i + 1));
      if (l.kind === 'group') {
        const inner = walk(l.children);
        if (inner) return [...strip(list.slice(0, i)), { ...l, children: inner }];
      }
    }
    return undefined;
  };
  return walk(layers);
}
export function withoutAdjustments(list: Layer[]): Layer[] {
  return list.map((l) => (l.kind === 'adjustment' ? { ...l, visible: false } : l.kind === 'group' ? { ...l, children: withoutAdjustments(l.children) } : l));
}
function sampledDoc(
  e: Editor,
  mode: SampleMode,
  doc = e.doc,
  layerId = e.layer?.id,
): PhotoDocument {
  if (mode === 'below' && layerId) {
    const layers = layersBelow(doc.layers, layerId, ignoreAdjustments(e));
    if (layers) return { ...doc, layers };
  }
  if (ignoreAdjustments(e)) return { ...doc, layers: withoutAdjustments(doc.layers) };
  return doc;
}

// Documents are immutable snapshots, so object identity names a state.
const docIds = new WeakMap<object, number>();
let nextDocId = 1;
function docKey(doc: PhotoDocument) {
  let id = docIds.get(doc);
  if (!id) docIds.set(doc, (id = nextDocId++));
  return id;
}
// Composites are rendered on the GPU; cache them by what they show.
let composite: { key: string; img: RGBA8 } | undefined;
const compositeKey = (e: Editor, mode: SampleMode) => `${mode}:${ignoreAdjustments(e)}:${docKey(e.doc)}:${mode === 'below' ? e.layer?.id : ''}`;
async function compositeFor(e: Editor, mode: SampleMode): Promise<RGBA8> {
  const key = compositeKey(e, mode);
  if (composite?.key !== key) {
    const img = await compositeRGBA(e, sampledDoc(e, mode));
    composite = { key, img };
  }
  return composite.img;
}
/** True when a stroke can start without rendering a composite first. */
export function sourceReady(e: Editor, mode: SampleMode) {
  const src = activeSource();
  return !src || src.sessionId !== e.session.id || mode === 'current' || composite?.key === compositeKey(e, mode);
}
/** Render the composite a stroke will need ahead of time. */
export function warmSource(e: Editor, mode: SampleMode) {
  if (!sourceReady(e, mode) && e.hasDocument) void compositeFor(e, mode).catch(() => undefined);
}

/** Image pixels a new source captures in its own document (used when the
 * stroke happens in another document). */
async function captureSnapshot(e: Editor, mode: SampleMode): Promise<RGBA8 | undefined> {
  if (mode !== 'current') return compositeFor(e, mode);
  const l = e.layer;
  if (l?.kind === 'pixel' && l.pixels) return readRGBA(e.assets.tiles, l.pixels, canvasRect(e.doc));
  return compositeRGBA(e, { ...e.doc, layers: l ? [{ ...l, visible: true }] : [] });
}
/** Pixels of a source set in another document: captured when it was set
 * (with several documents open), else read now from that document while it
 * is still open (the source was set while it was the only document). */
export async function foreignSnapshot(
  e: Editor,
  src: CloneSource,
  mode: SampleMode,
): Promise<RGBA8 | undefined> {
  if (src.snapshot) return src.snapshot;
  const s = e.sessions.find((x) => x.id === src.sessionId);
  if (!s?.hasDocument) return;
  const doc = s.doc;
  const l = src.layerId ? findLayer(doc.layers, src.layerId) : undefined;
  let img: RGBA8;
  if (mode === 'current' && l?.kind === 'pixel' && l.pixels)
    img = readRGBA(s.assets.tiles, l.pixels, canvasRect(doc));
  else {
    const shown =
      mode === 'current'
        ? { ...doc, layers: l ? [{ ...l, visible: true }] : [] }
        : sampledDoc(e, mode, doc, src.layerId);
    img = toRGBA8(await e.renderer.documentPixels(shown, s.assets), doc.width, doc.height);
  }
  // Kept with the source, as a snapshot taken when it was set would be.
  src.snapshot = img;
  return img;
}

/** Alt-click: set the active source at a point of the current document. */
export async function setSource(e: Editor, x: number, y: number, tool: 'clone' | 'heal') {
  const prev = activeSource();
  const t: CloneTransform = prev ? { scaleW: prev.scaleW, scaleH: prev.scaleH, rotation: prev.rotation, flipH: prev.flipH, flipV: prev.flipV } : { ...cloneState.pending };
  const src: CloneSource = { ...t, point: [x, y], sessionId: e.session.id, docName: e.doc.name, layerId: e.layer?.id, layerName: sampleMode(e, tool) === 'current' ? (e.layer?.name ?? '') : sampleMode(e, tool) === 'all' ? 'All Layers' : `${e.layer?.name ?? ''} and below` };
  cloneState.sources[cloneState.active] = src;
  cloneSourceChanged();
  // Another document may be painted later; keep this one's pixels with the source.
  if (e.sessions.length > 1) src.snapshot = await captureSnapshot(e, sampleMode(e, tool));
}

/** Anchor (destination of the source point) for a stroke starting at `p`. */
export function strokeAnchor(src: CloneSource, p: [number, number], aligned: boolean): [number, number] {
  if (!aligned || !src.offset) src.offset = [p[0] - src.point[0], p[1] - src.point[1]];
  return [src.point[0] + src.offset[0], src.point[1] + src.offset[1]];
}

/** Per-pixel reader of a source for a stroke on `target` (a pixel layer grid
 * of the current document), with the source's transform applied. */
export async function strokeSampler(e: Editor, src: CloneSource, anchor: [number, number], mode: SampleMode, targetLayer: Layer): Promise<Sampler | undefined> {
  const map = sourceMapping(src.point, anchor, src);
  const translation = isTranslation(src);
  if (src.sessionId !== e.session.id) {
    const snapshot = await foreignSnapshot(e, src, mode);
    if (!snapshot) {
      e.message('The clone source document is no longer available. Alt-click to set a new source.');
      return;
    }
    return mappedSampler(bilinearSampler(snapshot), imageSampler(snapshot), map, translation);
  }
  if (mode === 'current') return currentLayerSampler(e, src, anchor, targetLayer);
  const img = await compositeFor(e, mode);
  return mappedSampler(bilinearSampler(img), imageSampler(img), map, translation);
}

/** Sampler over the target layer's committed pixels (Current Layer mode). */
export function currentLayerSampler(e: Editor, src: CloneSource, anchor: [number, number], layer: Layer): Sampler | undefined {
  const grid = layer.pixels;
  if (!grid) return;
  const map = sourceMapping(src.point, anchor, src);
  const nearest = gridSampler(e, grid);
  if (isTranslation(src)) return mappedSampler(nearest, nearest, map, true);
  // Interpolation needs a canvas-sized read of the layer.
  const img = readRGBA(e.assets.tiles, grid, canvasRect(e.doc));
  return mappedSampler(bilinearSampler(img), nearest, map, false);
}

/** Whole source image (healing reads a rectangle of it). */
export async function sourceImage(e: Editor, src: CloneSource, mode: SampleMode, targetLayer: Layer): Promise<RGBA8 | undefined> {
  if (src.sessionId !== e.session.id) return foreignSnapshot(e, src, mode);
  if (mode === 'current') {
    const grid = findLayer(e.doc.layers, targetLayer.id)?.pixels ?? targetLayer.pixels;
    return grid ? readRGBA(e.assets.tiles, grid, canvasRect(e.doc)) : undefined;
  }
  return compositeFor(e, mode);
}

// ----- Overlay -----
// A reduced copy of the source image as an object URL, placed with an SVG
// transform so moving the pointer only changes attributes.
let overlayImage: { key: string; url: string; width: number; height: number; scale: number } | undefined;
let overlayPending = '';
async function buildOverlay(e: Editor, key: string, src: CloneSource, mode: SampleMode) {
  overlayPending = key;
  const img =
    src.sessionId === e.session.id
      ? e.layer
        ? await sourceImage(e, src, mode, e.layer)
        : undefined
      : await foreignSnapshot(e, src, mode);
  if (!img || overlayPending !== key) return;
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)),
    h = Math.max(1, Math.round(img.height * scale));
  const full = document.createElement('canvas');
  full.width = img.width;
  full.height = img.height;
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(full, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r));
  if (!blob || overlayPending !== key) return;
  if (overlayImage) URL.revokeObjectURL(overlayImage.url);
  overlayImage = { key, url: URL.createObjectURL(blob), width: img.width, height: img.height, scale };
  e.overlay();
}
export function overlayKey(e: Editor, src: CloneSource, mode: SampleMode) {
  if (src.sessionId !== e.session.id) return `snap:${src.sessionId}:${src.point}`;
  return mode === 'current' ? `layer:${e.layer?.id}:${docKey(e.doc)}` : compositeKey(e, mode);
}

/** SVG for the source overlay under the pointer (document coordinates). */
export function sourceOverlay(e: Editor, tool: 'clone' | 'heal', brushSize: number, painting: boolean, strokeAnchorPoint?: [number, number]): string {
  const src = activeSource();
  const o = cloneState.overlay;
  const p = e.pointerInfo;
  if (!src || !o.show || !p || (o.autoHide && painting)) return '';
  const mode = sampleMode(e, tool);
  const key = overlayKey(e, src, mode);
  if (overlayImage?.key !== key) {
    if (overlayPending !== key) void buildOverlay(e, key, src, mode);
    return '';
  }
  // Where the source point lands: the stroke's anchor, the fixed offset, or under the pointer.
  const D = strokeAnchorPoint ?? (src.offset && e.settings.cloneAligned !== false ? [src.point[0] + src.offset[0], src.point[1] + src.offset[1]] : [p.x, p.y]);
  const sx = (src.scaleW / 100) * (src.flipH ? -1 : 1),
    sy = (src.scaleH / 100) * (src.flipV ? -1 : 1);
  const im = overlayImage;
  const clip = o.clipped ? `<clipPath id="clone-overlay-clip"><circle cx="${p.x}" cy="${p.y}" r="${Math.max(1, brushSize / 2)}"/></clipPath>` : '';
  const style = `opacity:${o.opacity / 100};${o.blend !== 'normal' ? `mix-blend-mode:${o.blend};` : ''}${o.invert ? 'filter:invert(1);' : ''}`;
  return `<g class="clone-overlay" style="${style}" ${o.clipped ? 'clip-path="url(#clone-overlay-clip)"' : ''}>${clip}<image href="${im.url}" x="0" y="0" width="${im.width}" height="${im.height}" preserveAspectRatio="none" transform="translate(${D[0]} ${D[1]}) rotate(${src.rotation}) scale(${sx} ${sy}) translate(${-src.point[0]} ${-src.point[1]})"/></g>`;
}
/** Crosshair marking where the active source is read. */
export function sourceMarker(e: Editor, at: [number, number]) {
  const z = e.zoom;
  return `<g class="clone-source" stroke-width="${1 / z}"><circle cx="${at[0]}" cy="${at[1]}" r="${6 / z}"/><path d="M${at[0] - 9 / z} ${at[1]}h${18 / z}M${at[0]} ${at[1] - 9 / z}v${18 / z}"/></g>`;
}
/** Where the source is read under the pointer right now. */
export function currentSourcePoint(e: Editor, src: CloneSource, painting: boolean, anchor?: [number, number]): [number, number] {
  const p = e.pointerInfo;
  if (painting && anchor && p) return sourceMapping(src.point, anchor, src)(p.x, p.y);
  return src.point;
}
