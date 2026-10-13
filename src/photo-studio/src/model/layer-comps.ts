import { isDocumentId } from './ids';
import { allLayers, blends, type Blend, type Layer, type PhotoDocument } from './document';

// A layer comp records, per layer, the visibility, position and appearance
// (opacity, fill opacity, blend mode and layer style) captured at one moment,
// so alternative layouts of one document can be switched and exported.
export type LayerCompState = {
  visible?: boolean;
  // Position: the artboard or frame rectangle origin, the tile grid
  // origin for pixel layers (independent of later painting), else the
  // transform's top-left corner.
  x?: number;
  y?: number;
  opacity?: number;
  fillOpacity?: number;
  blend?: Blend;
  // Layer style at capture time; null when the layer had none.
  style?: Record<string, unknown> | null;
};
export type LayerCompCapture = { visibility: boolean; position: boolean; appearance: boolean };
export type LayerComp = {
  id: string;
  name: string;
  comment?: string;
  capture: LayerCompCapture;
  layers: Record<string, LayerCompState>;
};

function position(l: Layer): [number, number] | undefined {
  if (l.artboard) return [l.artboard.rect.x, l.artboard.rect.y];
  if (l.frame) return [l.frame.rect.x, l.frame.rect.y];
  if (l.kind === 'group' || l.kind === 'adjustment') return;
  if (l.kind === 'pixel' && l.pixels) return [l.pixels.x, l.pixels.y];
  return [l.transform.x, l.transform.y];
}

/** Capture the current state of every layer. */
export function captureLayers(doc: Pick<PhotoDocument, 'layers'>, capture: LayerCompCapture): Record<string, LayerCompState> {
  const out: Record<string, LayerCompState> = {};
  for (const l of allLayers(doc.layers)) {
    const s: LayerCompState = {};
    if (capture.visibility) s.visible = l.visible;
    const p = capture.position ? position(l) : undefined;
    if (p) [s.x, s.y] = p;
    if (capture.appearance) {
      s.opacity = l.opacity;
      s.fillOpacity = l.fillOpacity ?? 1;
      s.blend = l.blend;
      s.style = l.style ? structuredClone(l.style) : null;
    }
    out[l.id] = s;
  }
  return out;
}

export function newLayerComp(doc: Pick<PhotoDocument, 'layers'>, name: string, capture: LayerCompCapture, comment?: string): LayerComp {
  return { id: crypto.randomUUID(), name, ...(comment ? { comment } : {}), capture: { ...capture }, layers: captureLayers(doc, capture) };
}

/** Layers a comp refers to that no longer exist (it cannot be fully restored). */
export function missingLayers(doc: Pick<PhotoDocument, 'layers'>, comp: LayerComp): string[] {
  const ids = new Set(allLayers(doc.layers).map((l) => l.id));
  return Object.keys(comp.layers).filter((id) => !ids.has(id));
}

export type ApplyResult = { missing: number; added: number; moved: string[] };
/** Restore a comp onto a document draft. Layers created after the comp keep
 * their current state; layers it refers to that were deleted are counted.
 * Moving a pixel layer shifts its transform; the history bakes the move. */
export function applyLayerComp(doc: PhotoDocument, comp: LayerComp): ApplyResult {
  const layers = allLayers(doc.layers);
  const result: ApplyResult = { missing: missingLayers(doc, comp).length, added: 0, moved: [] };
  for (const l of layers) {
    const s = comp.layers[l.id];
    if (!s) {
      result.added++;
      continue;
    }
    if (comp.capture.visibility && s.visible !== undefined) l.visible = s.visible;
    if (comp.capture.position && s.x !== undefined && s.y !== undefined) {
      const now = position(l);
      if (now && (Math.abs(now[0] - s.x) > 1e-6 || Math.abs(now[1] - s.y) > 1e-6)) {
        const dx = s.x - now[0],
          dy = s.y - now[1];
        if (l.artboard) l.artboard.rect = { ...l.artboard.rect, x: s.x, y: s.y };
        else if (l.frame) l.frame.rect = { ...l.frame.rect, x: s.x, y: s.y };
        else l.transform = { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy };
        result.moved.push(l.id);
      }
    }
    if (comp.capture.appearance) {
      if (s.opacity !== undefined) l.opacity = s.opacity;
      if (s.fillOpacity !== undefined) {
        if (s.fillOpacity === 1) delete l.fillOpacity;
        else l.fillOpacity = s.fillOpacity;
      }
      if (s.blend !== undefined && (s.blend !== 'pass through' || l.kind === 'group')) l.blend = s.blend;
      if (s.style !== undefined && l.kind !== 'adjustment') {
        if (s.style) l.style = structuredClone(s.style);
        else delete l.style;
      }
    }
  }
  return result;
}

/** Keep comp positions relative to their layers across a canvas edit that
 * maps document points through `f` (resize, rotation, flip) and rebuilds
 * layer content: the offset between each captured position and the layer's
 * position before the edit is carried through `f` and added to the layer's
 * position after it. `after` is the edited document, holding the comps of
 * `before` unchanged. */
export function remapCompPositions(before: Pick<PhotoDocument, 'layers' | 'layerComps'>, after: PhotoDocument, f: (x: number, y: number) => [number, number]) {
  const was = new Map(allLayers(before.layers).map((l) => [l.id, position(l)]));
  const now = new Map(allLayers(after.layers).map((l) => [l.id, position(l)]));
  after.layerComps = before.layerComps?.map((comp) => {
    const layers: Record<string, LayerCompState> = {};
    for (const [id, s] of Object.entries(comp.layers)) {
      const a = was.get(id),
        b = now.get(id);
      if (s.x === undefined || s.y === undefined || !a || !b) {
        layers[id] = { ...s };
        continue;
      }
      const [cx, cy] = f(s.x, s.y),
        [ax, ay] = f(a[0], a[1]);
      layers[id] = { ...s, x: Math.round((b[0] + cx - ax) * 1000) / 1000, y: Math.round((b[1] + cy - ay) * 1000) / 1000 };
    }
    return { ...comp, layers };
  });
}

/** Re-capture a comp from the document, keeping its name and options. */
export function updateLayerComp(doc: Pick<PhotoDocument, 'layers'>, comp: LayerComp, capture: LayerCompCapture = comp.capture): LayerComp {
  return { ...comp, capture: { ...capture }, layers: captureLayers(doc, capture) };
}

export function validateLayerComps(comps: unknown, lastComp: unknown) {
  if (comps === undefined) {
    if (lastComp !== undefined) throw new Error('Invalid layer comps.');
    return;
  }
  const bad = () => new Error('Invalid layer comps.');
  if (!Array.isArray(comps) || comps.length > 500) throw bad();
  const ids = new Set<string>();
  const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  const unit = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);
  for (const c of comps as LayerComp[]) {
    if (!c || !isDocumentId(c.id) || ids.has(c.id) || typeof c.name !== 'string' || c.name.length > 256) throw bad();
    ids.add(c.id);
    if (c.comment !== undefined && (typeof c.comment !== 'string' || c.comment.length > 4096)) throw bad();
    const k = c.capture;
    if (!k || typeof k.visibility !== 'boolean' || typeof k.position !== 'boolean' || typeof k.appearance !== 'boolean') throw bad();
    if (!c.layers || typeof c.layers !== 'object' || Array.isArray(c.layers)) throw bad();
    for (const s of Object.values(c.layers))
      if (
        !s ||
        typeof s !== 'object' ||
        (s.visible !== undefined && typeof s.visible !== 'boolean') ||
        !num(s.x) ||
        !num(s.y) ||
        !unit(s.opacity) ||
        !unit(s.fillOpacity) ||
        (s.blend !== undefined && !(blends.includes(s.blend) || s.blend === 'pass through')) ||
        (s.style !== undefined && s.style !== null && (typeof s.style !== 'object' || Array.isArray(s.style)))
      )
        throw bad();
  }
  if (lastComp !== undefined && (typeof lastComp !== 'string' || !ids.has(lastComp))) throw bad();
}

/** Whether the document currently shows the comp: every existing layer it
 * refers to has the captured state (only the captured aspects count). */
export function compMatches(doc: Pick<PhotoDocument, 'layers'>, comp: LayerComp): boolean {
  const now = captureLayers(doc, comp.capture);
  return Object.entries(now).every(([id, s]) => !comp.layers[id] || JSON.stringify(s) === JSON.stringify(comp.layers[id]));
}

/** Change which aspects a comp restores. Aspects turned on are captured from
 * the document; data for aspects turned off is dropped. */
export function recaptureAspects(doc: Pick<PhotoDocument, 'layers'>, comp: LayerComp, capture: LayerCompCapture): LayerComp {
  const added = {
    visibility: capture.visibility && !comp.capture.visibility,
    position: capture.position && !comp.capture.position,
    appearance: capture.appearance && !comp.capture.appearance,
  };
  const fresh = captureLayers(doc, added);
  const layers: Record<string, LayerCompState> = {};
  for (const [id, old] of Object.entries(comp.layers)) {
    const s: LayerCompState = { ...old, ...(fresh[id] ?? {}) };
    if (!capture.visibility) delete s.visible;
    if (!capture.position) {
      delete s.x;
      delete s.y;
    }
    if (!capture.appearance) {
      delete s.opacity;
      delete s.fillOpacity;
      delete s.blend;
      delete s.style;
    }
    layers[id] = s;
  }
  // Layers created since the comp was made gain the newly captured aspects only.
  for (const [id, s] of Object.entries(fresh)) if (!layers[id] && Object.keys(s).length) layers[id] = s;
  return { ...comp, capture: { ...capture }, layers };
}
