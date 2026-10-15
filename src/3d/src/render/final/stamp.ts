// Output ▸ Metadata: information about a render (date, frame, camera, …) written into saved
// image files as text chunks and, with Burn Into Image, drawn onto the image itself.
import type { DocumentData, RenderSettings } from '../../data/types';
import { crc32 } from './zip';
import { formatTime } from './units';

export interface StampField {
  key: string;
  label: string;
  value: string;
}

export interface StampContext {
  doc: DocumentData;
  frame: number;
  /** render time in seconds */
  renderTime: number;
  filename: string;
  now: Date;
  hostname?: string;
  /** peak memory in bytes, when known */
  memory?: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Fields enabled in the Metadata panel, in display order. */
export function stampFields(r: RenderSettings, c: StampContext): StampField[] {
  const out: StampField[] = [];
  const add = (on: boolean | undefined, key: string, label: string, value: string) => {
    if (on) out.push({ key, label, value });
  };
  const s = c.doc.scene;
  const camOb = s.camera ? c.doc.objects[s.camera] : undefined;
  const cam = camOb?.data ? c.doc.cameras[camOb.data] : undefined;
  const d = c.now;
  add(r.use_stamp_filename, 'File', 'File', c.filename);
  add(r.use_stamp_date, 'Date', 'Date', `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  add(r.use_stamp_time, 'Time', 'Time', timecode(c.frame, r.fps / (r.fps_base || 1)));
  add(r.use_stamp_render_time, 'RenderTime', 'Render Time', formatTime(c.renderTime));
  add(r.use_stamp_frame, 'Frame', 'Frame', String(c.frame).padStart(String(s.frame_end).length, '0'));
  add(r.use_stamp_frame_range, 'FrameRange', 'Frame Range', `${s.frame_start}:${s.frame_end}`);
  if (r.use_stamp_memory && c.memory) add(true, 'Memory', 'Peak Memory', `${(c.memory / (1024 * 1024)).toFixed(2)}M`);
  if (r.use_stamp_hostname && c.hostname) add(true, 'Hostname', 'Hostname', c.hostname);
  add(r.use_stamp_camera, 'Camera', 'Camera', camOb?.name ?? '');
  if (r.use_stamp_lens && cam) add(true, 'Lens', 'Lens', cam.type === 'ORTHO' ? `${cam.ortho_scale.toFixed(2)} (ortho)` : `${Math.round(cam.lens)}.00 mm`);
  add(r.use_stamp_scene, 'Scene', 'Scene', s.name);
  if (r.use_stamp_marker) {
    const m = s.timeline_markers.filter((x) => x.frame <= c.frame).sort((a, b) => b.frame - a.frame)[0];
    add(true, 'Marker', 'Marker', m?.name ?? '');
  }
  if (r.use_stamp_note && r.stamp_note_text) add(true, 'Note', 'Note', r.stamp_note_text);
  return out;
}

/** HH:MM:SS+FF time code of a frame. */
export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, frame);
  const rate = Math.max(1, Math.round(fps));
  const secs = Math.floor(f / rate);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}+${pad(f % rate)}`;
}

/** Text lines drawn onto the image: the note on its own line, the rest wrapped to fit. */
export function stampLines(fields: StampField[], labels: boolean, measure: (s: string) => number, maxWidth: number): { top: string[]; bottom: string[] } {
  const text = (f: StampField) => (labels ? `${f.label} ${f.value}` : f.value);
  const note = fields.filter((f) => f.key === 'Note').map(text);
  const parts = fields.filter((f) => f.key !== 'Note').map(text);
  const bottom: string[] = [];
  let line = '';
  for (const p of parts) {
    const next = line ? `${line}   ${p}` : p;
    if (line && measure(next) > maxWidth) {
      bottom.push(line);
      line = p;
    } else line = next;
  }
  if (line) bottom.push(line);
  return { top: note, bottom };
}

const css = (c: [number, number, number, number] | undefined, d: [number, number, number, number]) => {
  const v = c ?? d;
  const k = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgba(${k(v[0])},${k(v[1])},${k(v[2])},${Math.max(0, Math.min(1, v[3]))})`;
};

/**
 * Draw the metadata onto a transparent W×H overlay (RGBA8, straight alpha) that is composited
 * over the display-converted image (Burn Into Image).
 */
export function burnStampOverlay(fields: StampField[], r: RenderSettings, W: number, H: number): Uint8ClampedArray | null {
  if (!fields.length || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  const size = Math.max(8, Math.min(64, r.stamp_font_size ?? 12));
  const font = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.font = font;
  const padX = Math.round(size * 0.5),
    lineH = Math.round(size * 1.35);
  const { top, bottom } = stampLines(fields, r.use_stamp_labels !== false, (s) => g.measureText(s).width, W - padX * 2);
  const band = (lines: string[], y0: number) => {
    if (!lines.length) return;
    const hh = lines.length * lineH + Math.round(size * 0.4);
    g.fillStyle = css(r.stamp_background, [0, 0, 0, 0.25]);
    g.fillRect(0, y0, W, hh);
    g.fillStyle = css(r.stamp_foreground, [0.8, 0.8, 0.8, 1]);
    g.font = font;
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, padX, y0 + Math.round(size * 0.2) + lineH * (i + 0.5)));
  };
  band(top, 0);
  band(bottom, H - (bottom.length * lineH + Math.round(size * 0.4)));
  return g.getImageData(0, 0, W, H).data;
}

/** Composite a straight-alpha overlay over RGBA8 pixels in place. */
export function compositeOverlay(px: Uint8ClampedArray, overlay: Uint8ClampedArray) {
  const n = Math.min(px.length, overlay.length);
  for (let i = 0; i < n; i += 4) {
    const a = overlay[i + 3];
    if (!a) continue;
    const k = a / 255;
    px[i] = overlay[i] * k + px[i] * (1 - k);
    px[i + 1] = overlay[i + 1] * k + px[i + 1] * (1 - k);
    px[i + 2] = overlay[i + 2] * k + px[i + 2] * (1 - k);
    px[i + 3] = Math.max(px[i + 3], a);
  }
  return px;
}

// ---------------------------------------------------------------------------
// PNG text chunks

const latin1 = (s: string) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));

/** Insert tEXt chunks (key/value metadata) into a PNG file after its header chunk. */
export function pngWithText(png: Uint8Array, entries: [string, string][]): Uint8Array {
  if (!entries.length || png.length < 33 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return png;
  // signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 crc)
  const at = 8 + 25;
  const chunks = entries.map(([k, v]) => {
    const key = latin1(k.slice(0, 79));
    const val = latin1(v);
    const data = new Uint8Array(key.length + 1 + val.length);
    data.set(key, 0);
    data.set(val, key.length + 1);
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + total);
  out.set(png.subarray(0, at), 0);
  let o = at;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  out.set(png.subarray(at), o);
  return out;
}

/** Read the tEXt chunks of a PNG (for tests and the Image Editor's Metadata panel). */
export function pngText(png: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  while (o + 8 <= png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'tEXt') {
      const d = png.subarray(o + 8, o + 8 + len);
      const z = d.indexOf(0);
      if (z > 0) out.push([String.fromCharCode(...d.subarray(0, z)), String.fromCharCode(...d.subarray(z + 1))]);
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}
