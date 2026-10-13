// Document annotations: fixed color samplers, count groups, notes and the
// measurement scale. They are part of the document (saved in .photo
// projects, edited through undoable commands) but never rendered into
// pixels or exports.
import { isDocumentId } from './ids';
import { validScale, type MeasurementScale } from '../imaging/measure/geometry';

export type ColorSampler = { x: number; y: number };
export type CountGroup = {
  id: string;
  name: string;
  color: string;
  // Marker radius and label size in screen pixels.
  markerSize: number;
  labelSize: number;
  visible: boolean;
  points: [number, number][];
};
export type DocumentNote = {
  id: string;
  x: number;
  y: number;
  author: string;
  text: string;
  color: string;
  // ISO 8601 creation time.
  created: string;
};
export type Annotations = {
  samplers?: ColorSampler[];
  counts?: CountGroup[];
  notes?: DocumentNote[];
  scale?: MeasurementScale;
};
export const MAX_SAMPLERS = 10;
export const MAX_COUNTS = 10_000;

const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

/** Validate annotations loaded from a project file. */
export function validateAnnotations(a: unknown): asserts a is Annotations | undefined {
  if (a === undefined) return;
  const bad = () => new Error('Invalid document annotations.');
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad();
  const v = a as Annotations;
  if (v.samplers !== undefined && (!Array.isArray(v.samplers) || v.samplers.length > MAX_SAMPLERS || !v.samplers.every((s) => s && finite(s.x, s.y))))
    throw bad();
  if (v.counts !== undefined) {
    if (!Array.isArray(v.counts) || v.counts.length > 100) throw bad();
    let total = 0;
    for (const g of v.counts) {
      if (!g || !str(g.id, 64) || !isDocumentId(g.id) || !str(g.name, 128) || !hex(g.color) || !finite(g.markerSize, g.labelSize) ||
        g.markerSize < 1 || g.markerSize > 64 || g.labelSize < 4 || g.labelSize > 96 || typeof g.visible !== 'boolean' || !Array.isArray(g.points))
        throw bad();
      total += g.points.length;
      if (total > MAX_COUNTS || !g.points.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0], p[1]))) throw bad();
    }
  }
  if (v.notes !== undefined) {
    if (!Array.isArray(v.notes) || v.notes.length > 1000) throw bad();
    for (const n of v.notes)
      if (!n || !str(n.id, 64) || !isDocumentId(n.id) || !finite(n.x, n.y) || !str(n.author, 256) || !str(n.text, 100_000) || !hex(n.color) || !str(n.created, 64))
        throw bad();
  }
  if (v.scale !== undefined && !validScale(v.scale)) throw bad();
}

/** Move every annotation point through `map` (canvas resize, crop, rotation). */
export function mapAnnotations(a: Annotations | undefined, map: (x: number, y: number) => [number, number]) {
  if (!a) return;
  for (const s of a.samplers ?? []) [s.x, s.y] = map(s.x, s.y);
  for (const g of a.counts ?? []) g.points = g.points.map(([x, y]) => map(x, y));
  for (const n of a.notes ?? []) [n.x, n.y] = map(n.x, n.y);
}

/** Drop empty collections so documents without annotations stay unchanged. */
export function tidyAnnotations(a: Annotations): Annotations | undefined {
  const out: Annotations = {};
  if (a.samplers?.length) out.samplers = a.samplers;
  if (a.counts?.length) out.counts = a.counts;
  if (a.notes?.length) out.notes = a.notes;
  if (a.scale) out.scale = a.scale;
  return Object.keys(out).length ? out : undefined;
}

/** Notes from an imported file: a JSON list (or `{ "notes": [...] }`) of
 * objects or strings, or plain text with one note per paragraph. Notes
 * without a position cascade from the top left of a width x height canvas. */
export function parseNotes(text: string, width: number, height: number, defaults: { author: string; color: string }, now = new Date()): DocumentNote[] {
  const step = Math.max(12, Math.min(width, height) / 20);
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let items: Partial<DocumentNote>[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    const list = Array.isArray(data) ? data : Array.isArray(data?.notes) ? data.notes : null;
    if (!list) throw new Error('The file has no list of notes.');
    items = list.map((n: unknown) => (typeof n === 'string' ? { text: n } : n && typeof n === 'object' ? (n as Partial<DocumentNote>) : {}));
  } else items = trimmed.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()).map((p) => ({ text: p.trim() }));
  const clamp = (v: unknown, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max - 1, v)) : fallback);
  return items.slice(0, 1000).map((n, i) => ({
    id: crypto.randomUUID(),
    x: clamp(n.x, width, Math.min(width - 1, step * (i + 1))),
    y: clamp(n.y, height, Math.min(height - 1, step * (i + 1))),
    author: typeof n.author === 'string' ? n.author.slice(0, 256) : defaults.author,
    text: String(n.text ?? '').slice(0, 100_000),
    color: hex(n.color) ? n.color! : defaults.color,
    created: typeof n.created === 'string' && !Number.isNaN(Date.parse(n.created)) ? n.created : now.toISOString(),
  }));
}
