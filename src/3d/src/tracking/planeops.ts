// Plane tracks in the clip editor: create from selected tracks, select and slide corners, draw
// (with an optional image warped onto the plane), the sidebar Plane Track panel and images made
// from the plane area.
import { h, type Child } from '../ui/h';
import { app, registerOperators, type OpContext } from '../app/app';
import { panel, enumMenu, opButton, textField } from '../ui/widgets';
import { num, bool, splitRow } from '../ui/props';
import { newImage } from '../data/defaults';
import { imageCanvas, primeImage, touchImage } from '../render/images';
import type { Vec2 } from '../data/types';
import { clipFrameToSourceIndex, enabledMarkerAt, planeTracksOf, tobj, type MovieClipData, type MovieTrackingPlaneTrack } from './types';
import { readySource } from './source';
import { contextClip } from './ops';
import type { ClipEditor } from './editor';
import type { Affine2 } from './stabilize';
import { applyH, initialQuad, insertPlaneMarker, newPlaneTrack, planeMarkerAt, rectify, squareToQuad, uniquePlaneName, updatePlaneTrack, type Quad } from './planetrack';

export function activePlaneTrack(c: MovieClipData): MovieTrackingPlaneTrack | null {
  const o = tobj(c);
  return (o.plane_tracks ?? []).find((p) => p.name === o.active_plane_track) ?? null;
}

/** Plane marker shown at a clip frame (only inside the frames the plane track covers). */
function shownMarker(pt: MovieTrackingPlaneTrack, f: number) {
  if (!pt.markers.length || f < pt.markers[0].frame || f > pt.markers[pt.markers.length - 1].frame) return null;
  const m = planeMarkerAt(pt, f);
  return m && !m.mute ? m : null;
}

function screenQuad(ed: ClipEditor, q: Quad, T: Affine2 | null): [number, number][] {
  const [W, H] = ed.clip!.size;
  return q.map((p) => ed.toScreen(p[0] * W, (1 - p[1]) * H, T));
}

// ---------------------------------------------------------------------------
// drawing

/** Draw an image onto a screen quad (projective warp approximated by an 8×8 grid of triangles). */
function drawWarped(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, quad: [number, number][], alpha: number) {
  const Hm = squareToQuad([quad[0], quad[1], quad[2], quad[3]]);
  const N = 8;
  const iw = img.width,
    ih = img.height;
  ctx.save();
  ctx.globalAlpha = alpha;
  const P = (u: number, v: number) => applyH(Hm, [u, v]);
  // image: u right, v up from the lower-left corner; canvas rows go down
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    const [pa, pb, pc] = [P(a[0], a[1]), P(b[0], b[1]), P(c[0], c[1])];
    const sa = [a[0] * iw, (1 - a[1]) * ih],
      sb = [b[0] * iw, (1 - b[1]) * ih],
      sc = [c[0] * iw, (1 - c[1]) * ih];
    // affine map image triangle → screen triangle
    const den = (sb[0] - sa[0]) * (sc[1] - sa[1]) - (sc[0] - sa[0]) * (sb[1] - sa[1]);
    if (Math.abs(den) < 1e-9) return;
    const m11 = ((pb[0] - pa[0]) * (sc[1] - sa[1]) - (pc[0] - pa[0]) * (sb[1] - sa[1])) / den;
    const m12 = ((pc[0] - pa[0]) * (sb[0] - sa[0]) - (pb[0] - pa[0]) * (sc[0] - sa[0])) / den;
    const m21 = ((pb[1] - pa[1]) * (sc[1] - sa[1]) - (pc[1] - pa[1]) * (sb[1] - sa[1])) / den;
    const m22 = ((pc[1] - pa[1]) * (sb[0] - sa[0]) - (pb[1] - pa[1]) * (sc[0] - sa[0])) / den;
    const dx = pa[0] - m11 * sa[0] - m12 * sa[1],
      dy = pa[1] - m21 * sa[0] - m22 * sa[1];
    ctx.save();
    ctx.beginPath();
    // slightly enlarged clip triangle hides seams
    const cx = (pa[0] + pb[0] + pc[0]) / 3,
      cy = (pa[1] + pb[1] + pc[1]) / 3;
    const g = (p: [number, number]) => [p[0] + (p[0] - cx) * 0.02, p[1] + (p[1] - cy) * 0.02] as const;
    const [ga, gb, gc] = [g(pa), g(pb), g(pc)];
    ctx.moveTo(ga[0], ga[1]);
    ctx.lineTo(gb[0], gb[1]);
    ctx.lineTo(gc[0], gc[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m11, m21, m12, m22, dx, dy);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const u0 = i / N,
        u1 = (i + 1) / N,
        v0 = j / N,
        v1 = (j + 1) / N;
      tri([u0, v0], [u1, v0], [u1, v1]);
      tri([u0, v0], [u1, v1], [u0, v1]);
    }
  ctx.restore();
}

export function drawPlaneTracks(ed: ClipEditor, ctx: CanvasRenderingContext2D, T: Affine2 | null) {
  const c = ed.clip;
  if (!c) return;
  const o = tobj(c);
  const f = ed.clipFrame;
  for (const pt of o.plane_tracks ?? []) {
    const m = shownMarker(pt, f);
    if (!m) continue;
    const q = screenQuad(ed, m.corners, T);
    const img = pt.image ? app.doc.images[pt.image] : null;
    if (img && pt.image_opacity > 0) drawWarped(ctx, imageCanvas(img), q, pt.image_opacity);
    const active = pt.name === o.active_plane_track;
    const col = pt.select ? (active ? '#ffffff' : '#f0fb18') : '#b6b74a';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = col;
    ctx.setLineDash(m.is_keyed ? [] : [6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // plane axes from the first corner: X towards the second, Y towards the fourth
    const axis = (to: [number, number], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(q[0][0], q[0][1]);
      ctx.lineTo(q[0][0] + (to[0] - q[0][0]) * 0.3, q[0][1] + (to[1] - q[0][1]) * 0.3);
      ctx.stroke();
    };
    axis(q[1], '#e0423a');
    axis(q[3], '#6bc04c');
    if (pt.select) {
      ctx.fillStyle = col;
      for (const p of q) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8);
        ctx.fillStyle = col;
        ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
      }
    }
    if (ed.overlays.show_names) {
      ctx.font = '11px var(--font, sans-serif)';
      ctx.fillStyle = col;
      ctx.fillText(pt.name, q[2][0] + 6, q[2][1] - 4);
    }
  }
}

// ---------------------------------------------------------------------------
// interaction

function pointInPoly(x: number, y: number, q: [number, number][]) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i],
      [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function selectPlane(c: MovieClipData, pt: MovieTrackingPlaneTrack, extend: boolean) {
  const o = tobj(c);
  if (!extend) {
    for (const t of o.tracks) t.select = false;
    for (const p of o.plane_tracks ?? []) p.select = false;
  }
  pt.select = true;
  o.active_plane_track = pt.name;
}

/** Edit the plane marker on frame f: a keyframe there (auto keying) or the plane redefined from f. */
function setCorners(c: MovieClipData, pt: MovieTrackingPlaneTrack, f: number, corners: Quad) {
  if (!pt.use_auto_keying) for (const m of pt.markers) m.is_keyed = false;
  insertPlaneMarker(pt, { frame: f, corners, mute: false, is_keyed: true });
  void c;
}

/** Corner drag on a selected plane track (true when the press was handled). */
export function planeCornerDown(ed: ClipEditor, e: PointerEvent, start: { x: number; y: number }): boolean {
  const c = ed.clip;
  if (!c) return false;
  const f = ed.clipFrame;
  const T = ed.stab();
  for (const pt of tobj(c).plane_tracks ?? []) {
    if (!pt.select) continue;
    const m = shownMarker(pt, f);
    if (!m) continue;
    const q = screenQuad(ed, m.corners, T);
    const i = q.findIndex((p) => Math.abs(p[0] - start.x) <= 6 && Math.abs(p[1] - start.y) <= 6);
    if (i < 0) continue;
    slideCorner(ed, e, pt, i, start);
    return true;
  }
  return false;
}

/** Click inside a plane track selects it (true when handled). */
export function planeBodyDown(ed: ClipEditor, e: PointerEvent, start: { x: number; y: number }): boolean {
  const c = ed.clip;
  if (!c) return false;
  const f = ed.clipFrame;
  const T = ed.stab();
  const hit = (tobj(c).plane_tracks ?? []).find((pt) => {
    const m = shownMarker(pt, f);
    return m && pointInPoly(start.x, start.y, screenQuad(ed, m.corners, T));
  });
  if (!hit) return false;
  selectPlane(c, hit, e.shiftKey);
  app.pushUndo('Select');
  app.changed('doc');
  return true;
}

function slideCorner(ed: ClipEditor, e: PointerEvent, pt: MovieTrackingPlaneTrack, corner: number, start: { x: number; y: number }) {
  const c = ed.clip!;
  const f = ed.clipFrame;
  const el = ed.canvas;
  el.setPointerCapture(e.pointerId);
  selectPlane(c, pt, true);
  const before = structuredClone(pt.markers);
  const orig = shownMarker(pt, f)!.corners.map((p) => [p[0], p[1]]) as Quad;
  const [W, H] = c.size;
  const [ix0, iy0] = ed.toImage(start.x, start.y);
  let moved = false;
  const move = (ev: PointerEvent) => {
    const p = ed.local(ev);
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
    moved = true;
    const [ix, iy] = ed.toImage(p.x, p.y);
    const k = ev.shiftKey ? 0.2 : 1;
    const q = orig.map((v) => [v[0], v[1]]) as Quad;
    q[corner] = [orig[corner][0] + ((ix - ix0) * k) / W, orig[corner][1] - ((iy - iy0) * k) / H];
    pt.markers = structuredClone(before);
    setCorners(c, pt, f, q);
    app.changed('doc');
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    if (moved) {
      updatePlaneTrack(c, tobj(c), pt);
      app.pushUndo('Slide Plane Marker');
    } else app.pushUndo('Select');
    app.changed('doc');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// images from the plane

function framePixels(c: MovieClipData, f: number) {
  const src = readySource(c);
  const bmp = src?.peek(clipFrameToSourceIndex(c, f));
  if (!bmp) return null;
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, cv.width, cv.height);
}

/** Pixels of the plane area at the current frame (null while the frame is not decoded). */
function planeImagePixels(c: MovieClipData, pt: MovieTrackingPlaneTrack, f: number, size?: [number, number]): ImageData | null {
  const m = shownMarker(pt, f);
  const px = framePixels(c, f);
  if (!m || !px) return null;
  const q: Vec2[] = m.corners.map((p) => [p[0] * px.width, p[1] * px.height]);
  const len = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = size?.[0] ?? Math.max(4, Math.round(Math.max(len(q[0], q[1]), len(q[3], q[2])))),
    hh = size?.[1] ?? Math.max(4, Math.round(Math.max(len(q[0], q[3]), len(q[1], q[2]))));
  const data = rectify(px, q, w, hh);
  return new ImageData(data, w, hh);
}

const hasActivePlane = (ctx: OpContext) => {
  const c = contextClip(ctx);
  return !!c && !!activePlaneTrack(c) && !!shownMarker(activePlaneTrack(c)!, sceneFrameToClip(ctx, c));
};
const sceneFrameToClip = (ctx: OpContext, c: MovieClipData) => ctx.doc.scene.frame_current - c.frame_start + 1;

registerOperators([
  {
    idname: 'clip.create_plane_track',
    label: 'Create Plane Track',
    description: 'Create a plane track that follows the selected tracks (four or more tracks on the same plane)',
    poll: (ctx) => {
      const c = contextClip(ctx);
      if (!c) return false;
      const f = sceneFrameToClip(ctx, c);
      return tobj(c).tracks.filter((t) => t.select && !t.hide && enabledMarkerAt(t, f)).length >= 4;
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const o = tobj(c);
      const f = sceneFrameToClip(ctx, c);
      const sel = o.tracks.filter((t) => t.select && !t.hide && enabledMarkerAt(t, f));
      const q = initialQuad(sel, f);
      if (!q) return 'CANCELLED';
      const pt = newPlaneTrack(uniquePlaneName(o, 'Plane Track'), sel.map((t) => t.name));
      pt.markers.push({ frame: f, corners: q, mute: false, is_keyed: true });
      planeTracksOf(o).push(pt);
      selectPlane(c, pt, false);
      updatePlaneTrack(c, o, pt);
      app.report('INFO', `Plane track follows ${sel.length} tracks over ${pt.markers.length} frames`);
    },
  },
  {
    idname: 'clip.slide_plane_marker',
    label: 'Slide Plane Marker',
    description: 'Move a corner of the active plane track on the current frame',
    props: [
      { id: 'corner', label: 'Corner', type: 'int', default: 0, min: 0, max: 3 },
      { id: 'offset', label: 'Offset', type: 'vec2', default: [0, 0] },
    ],
    poll: hasActivePlane,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const pt = activePlaneTrack(c)!;
      const f = sceneFrameToClip(ctx, c);
      const m = shownMarker(pt, f)!;
      const k = Math.max(0, Math.min(3, Number(p.corner) | 0));
      const off = p.offset as [number, number];
      const q = m.corners.map((v) => [v[0], v[1]]) as Quad;
      q[k] = [q[k][0] + off[0], q[k][1] + off[1]];
      setCorners(c, pt, f, q);
      updatePlaneTrack(c, tobj(c), pt);
    },
  },
  {
    idname: 'clip.new_image_from_plane_marker',
    label: 'New Image from Plane Marker',
    description: 'Create an image from the footage inside the active plane track (rectified) and show it on the plane',
    poll: hasActivePlane,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const pt = activePlaneTrack(c)!;
      const px = planeImagePixels(c, pt, sceneFrameToClip(ctx, c));
      if (!px) {
        app.report('ERROR', 'The footage of this frame is not loaded yet');
        return 'CANCELLED';
      }
      const img = newImage(pt.name, px.width, px.height, 'BLANK');
      ctx.doc.images[img.id] = img;
      primeImage(img, px);
      touchImage(img);
      pt.image = img.id;
    },
  },
  {
    idname: 'clip.update_image_from_plane_marker',
    label: 'Update Image from Plane Marker',
    description: "Replace the pixels of the plane track's image with the footage inside the plane on this frame",
    poll: (ctx) => hasActivePlane(ctx) && !!activePlaneTrack(contextClip(ctx)!)!.image && !!ctx.doc.images[activePlaneTrack(contextClip(ctx)!)!.image!],
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const pt = activePlaneTrack(c)!;
      const img = ctx.doc.images[pt.image!];
      const px = planeImagePixels(c, pt, sceneFrameToClip(ctx, c), [img.width, img.height]);
      if (!px) {
        app.report('ERROR', 'The footage of this frame is not loaded yet');
        return 'CANCELLED';
      }
      primeImage(img, px);
      touchImage(img);
    },
  },
]);

// ---------------------------------------------------------------------------
// sidebar panel

export function planeTrackPanel(ed: ClipEditor, c: MovieClipData): Child {
  const pt = activePlaneTrack(c);
  if (!pt) return null;
  void ed;
  const images = Object.values(app.doc.images);
  return panel('clip-n-plane', 'Plane Track', () => [
    h(
      'div',
      { class: 'clip-name-row' },
      textField(`clip-pname-${pt.name}`, pt.name, (v) => {
        const o = tobj(c);
        if (!v || v === pt.name || (o.plane_tracks ?? []).some((p) => p.name === v)) return;
        // compositor nodes deforming with this plane follow the rename
        for (const g of Object.values(app.doc.node_groups)) for (const n of g.tree.nodes) if (n.type === 'CompositorNodePlaneTrackDeform' && n.props.plane_track_name === pt.name) n.props.plane_track_name = v;
        if (o.active_plane_track === pt.name) o.active_plane_track = v;
        pt.name = v;
        app.pushUndo('Rename Plane Track');
        app.changed('doc');
      }),
    ),
    bool(pt, 'use_auto_keying', 'Auto Keyframe', { tip: 'Moving a corner adds a keyframe (otherwise the plane is redefined from the current frame)' }),
    splitRow(
      'Image',
      enumMenu('clip-plane-img', [{ value: '', label: '—' }, ...images.map((im) => ({ value: im.id, label: im.name, icon: 'image' }))], pt.image ?? '', (v) => {
        pt.image = v || null;
        app.pushUndo('Plane Track Image');
        app.changed('doc');
      }),
    ),
    num(pt, 'image_opacity', 'Opacity', { min: 0, max: 1, slider: true, unit: 'factor' }),
    h('div', { class: 'btn-col' }, opButton('clip.new_image_from_plane_marker', 'New Image from Plane'), opButton('clip.update_image_from_plane_marker', 'Update Image from Plane')),
    h('div', { class: 'clip-info' }, `${pt.tracks.length} tracks · ${pt.markers.length} frames · ${pt.markers.filter((m) => m.is_keyed).length} keyframes`),
  ]);
}

/** Recompute plane tracks after their point tracks changed (tracking, edits). */
export function refreshPlaneTracks(c: MovieClipData) {
  for (const pt of tobj(c).plane_tracks ?? []) updatePlaneTrack(c, tobj(c), pt);
}

