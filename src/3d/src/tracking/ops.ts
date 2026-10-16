// Motion tracking operators (clip.*) and the clip editor keymaps.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import { addKeys } from '../app/keymap';
import { openMenu } from '../ui/menu';
import { uid, newObject } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import { ensureAction, ensureFCurve } from '../anim/keyframes';
import { insertKeyframe } from '../anim/fcurve';
import { newConstraint } from '../eval/constraints';
import { download } from '../io/native';
import {
  activeTrack,
  clipFrameToSourceIndex,
  clipTable,
  clipToSceneFrame,
  cloneMarker,
  enabledMarkerAt,
  ensureMarker,
  insertMarker,
  markerAt,
  markerExact,
  newMarker,
  newMovieClip,
  newTrack,
  sceneToClipFrame,
  trackSpan,
  tobj,
  trackingObjectByName,
  uniqueTrackName,
  type MovieClipData,
  type MovieTrackingMarker,
  type MovieTrackingTrack,
} from './types';
import { clipSource, probeFootage, reloadSource, cacheSettings, readySource } from './source';
import { detectFeatures } from './detect';
import { ClipEditor, currentClipEditor, contextMenu } from './editor';
import { runJob, setProgress } from './jobs';
import { trackStep, refineMarkers, detectInFrame, toNormalized } from './trackjob';
import { stabilizationTable, stabilizationMatrix, autoscaleFactor } from './stabilize';
import { createVideoWriter } from '../render/final/webm';

// ---------------------------------------------------------------------------
// context helpers

export function contextEditor(ctx?: OpContext): ClipEditor | null {
  const ed = ctx?.area?.editor;
  if (ed instanceof ClipEditor) return ed;
  return currentClipEditor();
}

export function contextClip(ctx?: OpContext): MovieClipData | null {
  const ed = contextEditor(ctx);
  const doc = ctx?.doc ?? app.doc;
  if (ed?.clip) return ed.clip;
  const id = doc.scene.active_clip;
  return (id && clipTable(doc)[id]) || null;
}

const hasClip = (ctx: OpContext) => !!contextClip(ctx);
const BAKEABLE = ['FOLLOW_TRACK', 'CAMERA_SOLVER', 'OBJECT_SOLVER'];
const ctxTracks = (ctx: OpContext) => {
  const c = contextClip(ctx);
  return c ? tobj(c).tracks : [];
};
const hasFootage = (ctx: OpContext) => {
  const c = contextClip(ctx);
  return !!c && c.size[0] > 0;
};
const curFrame = (clip: MovieClipData) => sceneToClipFrame(clip, app.doc.scene.frame_current);
const selectedTracks = (clip: MovieClipData) => tobj(clip).tracks.filter((t) => t.select && !t.hide);

// ---------------------------------------------------------------------------
// opening footage

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => res([...(input.files ?? [])]);
    input.addEventListener('cancel', () => res([]));
    input.click();
  });
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Create a movie clip from a video file or an image sequence and show it. */
export async function openClipFiles(files: File[], editor: ClipEditor | null = currentClipEditor()): Promise<MovieClipData | null> {
  if (!files.length) return null;
  const video = files.find((f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name));
  const doc = app.doc;
  let clip: MovieClipData;
  if (video) {
    const bytes = new Uint8Array(await video.arrayBuffer());
    clip = newMovieClip(uid('MC'), video.name, { source: 'MOVIE', filepath: video.name, movie: { mime: video.type || (/\.webm$/i.test(video.name) ? 'video/webm' : 'video/mp4'), bytes } });
  } else {
    const imgs = files.filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name)).sort((a, b) => natural.compare(a.name, b.name));
    if (!imgs.length) throw new Error('No video or image files selected');
    const seq = await Promise.all(imgs.map(async (f) => ({ name: f.name, mime: f.type || 'image/png', bytes: new Uint8Array(await f.arrayBuffer()) })));
    clip = newMovieClip(uid('MC'), imgs[0].name, { source: 'SEQUENCE', filepath: imgs.length > 1 ? `${imgs[0].name} … ${imgs[imgs.length - 1].name}` : imgs[0].name, sequence: seq });
  }
  const src = await probeFootage(clip);
  if (!src.width || !src.height || !src.frameCount) throw new Error('Could not read any frames from the footage');
  const names = new Set(Object.values(clipTable(app.doc)).map((c) => c.name));
  for (let i = 1; names.has(clip.name); i++) clip.name = `${clip.name.replace(/\.\d{3}$/, '')}.${String(i).padStart(3, '0')}`;
  clipTable(app.doc)[clip.id] = clip;
  if (doc === app.doc) app.doc.scene.active_clip ??= clip.id;
  editor?.setClip(clip.id);
  app.pushUndo('Open Clip');
  app.changed('doc');
  app.report('INFO', `Opened clip "${clip.name}" (${src.width}×${src.height}, ${src.frameCount} frames, ${src.fps} fps, ${src.kind === 'webcodecs' ? 'WebCodecs' : src.kind === 'video' ? 'video element' : 'images'})`);
  return clip;
}

// ---------------------------------------------------------------------------
// clipboard

let clipboard: MovieTrackingTrack[] = [];

// ---------------------------------------------------------------------------
// transform modal (G / R / S on markers)

function transformInvoke(ctx: OpContext, mode: string) {
  const ed = contextEditor(ctx);
  const clip = contextClip(ctx);
  if (!ed || !clip || ed.view !== 'CLIP') return 'CANCELLED';
  const f = curFrame(clip);
  const tracks = selectedTracks(clip).filter((t) => !t.lock && enabledMarkerAt(t, f));
  if (!tracks.length) return 'CANCELLED';
  const saved = tracks.map((t) => ({ t, exact: markerExact(t, f) ? cloneMarker(markerExact(t, f)!) : null, held: cloneMarker(markerAt(t, f)!, f) }));
  const r = ed.el.getBoundingClientRect();
  const start = { x: app.pointer.x - r.left, y: app.pointer.y - r.top };
  const [W, H] = clip.size;
  // pivot = median of the selected markers (screen space)
  let px = 0,
    py = 0;
  for (const s of saved) {
    const p = ed.toScreen(s.held.co[0] * W, (1 - s.held.co[1]) * H);
    px += p[0] / saved.length;
    py += p[1] / saved.length;
  }
  const [ix0, iy0] = ed.toImage(start.x, start.y);
  let value = 0;
  const apply = (e: PointerEvent | null) => {
    const q = e ? { x: e.clientX - r.left, y: e.clientY - r.top } : start;
    const [ix, iy] = ed.toImage(q.x, q.y);
    const prec = e?.shiftKey ? 0.1 : 1;
    for (const s of saved) {
      const m = cloneMarker(s.held, f);
      m.is_keyed = true;
      if (mode === 'TRANSLATE') {
        m.co = [s.held.co[0] + ((ix - ix0) * prec) / W, s.held.co[1] - ((iy - iy0) * prec) / H];
        value = Math.hypot(ix - ix0, iy - iy0) * prec;
      } else if (mode === 'RESIZE') {
        const d0 = Math.max(1, Math.hypot(start.x - px, start.y - py));
        const k = 1 + (Math.hypot(q.x - px, q.y - py) / d0 - 1) * prec;
        value = k;
        m.pattern_corners = s.held.pattern_corners.map((c) => [c[0] * k, c[1] * k]) as MovieTrackingMarker['pattern_corners'];
        m.search_min = [s.held.search_min[0] * k, s.held.search_min[1] * k];
        m.search_max = [s.held.search_max[0] * k, s.held.search_max[1] * k];
      } else {
        const a0 = Math.atan2(start.y - py, start.x - px),
          a1 = Math.atan2(q.y - py, q.x - px);
        // screen y is down; normalized marker space is y up (counter-clockwise on screen = positive)
        const a = -(a1 - a0) * prec;
        value = a;
        const ca = Math.cos(a),
          sa = Math.sin(a);
        m.pattern_corners = s.held.pattern_corners.map(([x, y]) => {
          const xp = x * W,
            yp = y * H;
          return [(ca * xp - sa * yp) / W, (sa * xp + ca * yp) / H];
        }) as MovieTrackingMarker['pattern_corners'];
      }
      insertMarker(s.t, m);
    }
    app.changed('doc');
  };
  const restore = () => {
    for (const s of saved) {
      if (s.exact) insertMarker(s.t, s.exact);
      else s.t.markers = s.t.markers.filter((m) => m.frame !== f);
    }
    app.changed('doc');
  };
  app.startModal({
    label: mode === 'TRANSLATE' ? 'Move' : mode === 'RESIZE' ? 'Resize' : 'Rotate',
    cursor: 'move',
    onPointerMove: (e) => apply(e),
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: restore,
    header: () => (mode === 'TRANSLATE' ? `D: ${value.toFixed(2)} px` : mode === 'RESIZE' ? `Scale: ${value.toFixed(3)}` : `Rot: ${((value * 180) / Math.PI).toFixed(1)}°`),
    status: () => [
      ['LMB', 'Confirm'],
      ['RMB', 'Cancel'],
      ['Shift', 'Precision'],
    ],
  });
  return 'RUNNING_MODAL';
}

// ---------------------------------------------------------------------------
// export

async function exportStabilized(clip: MovieClipData) {
  const src = await clipSource(clip);
  if (!src) throw new Error('No footage');
  const [W, H] = clip.size;
  const z = clip.tracking.stabilization.use_autoscale ? autoscaleFactor(clip) : 1;
  const writer = await createVideoWriter(W, H, clip.fps || app.doc.scene.render.fps);
  const canvas = document.createElement('canvas');
  canvas.width = W & ~1;
  canvas.height = H & ~1;
  const ctx = canvas.getContext('2d')!;
  let ok = true;
  await runJob('Export Stabilized Footage', async (job) => {
    for (let f = 1; f <= clip.frame_duration; f++) {
      if (job.cancelled) {
        ok = false;
        return 'Export cancelled';
      }
      const bmp = await src.get(clipFrameToSourceIndex(clip, f));
      const T = stabilizationMatrix(clip, f, z);
      // bottom-left space transform → canvas (top-left) transform
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(T[0], -T[1], -T[2], T[3], T[4] + T[2] * H, H - T[5] - T[3] * H);
      const filter = clip.tracking.stabilization.filter_type;
      ctx.imageSmoothingEnabled = filter !== 'NEAREST';
      ctx.imageSmoothingQuality = filter === 'BICUBIC' ? 'high' : 'low';
      if (bmp) ctx.drawImage(bmp, 0, 0, W, H);
      await writer.addFrame(canvas, f - 1);
      setProgress(job, f / clip.frame_duration);
    }
  }, { undo: false });
  if (!ok) return;
  const blob = await writer.finish();
  download(new Uint8Array(await blob.arrayBuffer()), `${clip.name.replace(/\.[^.]+$/, '')}_stabilized.webm`, 'video/webm');
  app.report('INFO', `Exported stabilized footage (${clip.frame_duration} frames)`);
}

// ---------------------------------------------------------------------------
// operators

const ops: Operator[] = [
  {
    idname: 'clip.open',
    label: 'Open Clip',
    description: 'Load a movie file or an image sequence (select several images) as a movie clip',
    undo: false,
    invoke: (ctx) => {
      const ed = contextEditor(ctx);
      void pickFiles('video/*,image/*,.mp4,.m4v,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff').then((files) =>
        openClipFiles(files, ed).catch((e) => app.report('ERROR', `Cannot open clip: ${e instanceof Error ? e.message : String(e)}`)),
      );
      return 'CANCELLED';
    },
  },
  {
    idname: 'clip.reload',
    label: 'Reload Clip',
    description: 'Reload clip (drops cached frames and decodes the footage again)',
    undo: false,
    poll: hasClip,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      reloadSource(c);
      void probeFootage(c).then(() => app.changed('doc'));
      app.report('INFO', `Reloaded clip "${c.name}"`);
    },
  },
  {
    idname: 'clip.set_scene_frames',
    label: 'Set Scene Frames',
    description: "Set scene's start and end frame to match clip's start frame and length",
    poll: hasFootage,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      ctx.doc.scene.frame_start = c.frame_start;
      ctx.doc.scene.frame_end = c.frame_start + Math.max(1, c.frame_duration) - 1;
      if (c.fps > 0) ctx.doc.scene.render.fps = Math.round(c.fps);
    },
  },
  {
    idname: 'clip.prefetch',
    label: 'Prefetch Frames',
    description: 'Prefetch frames from disk for faster playback/tracking',
    undo: false,
    poll: hasFootage,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      void runJob(
        'Prefetching',
        async (job) => {
          const src = await clipSource(c);
          if (!src) return;
          const s = app.doc.scene;
          const a = Math.max(1, sceneToClipFrame(c, s.frame_start)),
            b = Math.min(c.frame_duration, sceneToClipFrame(c, s.frame_end));
          const budget = Math.floor((cacheSettings.limitMB * 1024 * 1024) / Math.max(1, src.width * src.height * 4));
          let n = 0;
          for (let f = a; f <= b && n < budget; f++, n++) {
            if (job.cancelled) break;
            await src.get(clipFrameToSourceIndex(c, f));
            setProgress(job, (f - a + 1) / (b - a + 1));
          }
          return `Prefetched ${n} frames`;
        },
        { undo: false },
      );
    },
  },
  {
    idname: 'clip.set_center_principal',
    label: 'Set Principal to Center',
    description: 'Set optical center to center of footage',
    poll: hasClip,
    exec: (ctx) => {
      contextClip(ctx)!.tracking.camera.principal_point = [0, 0];
    },
  },
  {
    idname: 'clip.add_marker',
    label: 'Add Marker',
    description: 'Place new marker at specified location',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0.5, 0.5] }],
    poll: hasFootage,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const loc = p.location as [number, number];
      const tr = newTrack(c.tracking, 'Track');
      insertMarker(tr, newMarker(curFrame(c), [loc[0], loc[1]], c.size, c.tracking.settings.default_pattern_size, c.tracking.settings.default_search_size));
      for (const t of tobj(c).tracks) t.select = false;
      tr.select = true;
      tobj(c).tracks.push(tr);
      tobj(c).active_track = tr.name;
    },
  },
  {
    idname: 'clip.add_marker_at_click',
    label: 'Add Marker at Click',
    description: 'Place new marker at the desired (clicked) position',
    poll: hasFootage,
    invoke: (ctx) => {
      const ed = contextEditor(ctx);
      const c = contextClip(ctx);
      if (!ed || !c || ed.view !== 'CLIP') return 'CANCELLED';
      app.startModal({
        label: 'Add Marker',
        cursor: 'crosshair',
        onPointerDown: (e) => {
          if (e.button !== 0) return 'CANCELLED';
          const r = ed.el.getBoundingClientRect();
          if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return 'CANCELLED';
          const [ix, iy] = ed.toImage(e.clientX - r.left, e.clientY - r.top);
          const cl = ed.clip!;
          const tr = newTrack(cl.tracking, 'Track');
          insertMarker(tr, newMarker(curFrame(cl), [ix / cl.size[0], 1 - iy / cl.size[1]], cl.size, cl.tracking.settings.default_pattern_size, cl.tracking.settings.default_search_size));
          for (const t of tobj(cl).tracks) t.select = false;
          tobj(cl).tracks.push(tr);
          tobj(cl).active_track = tr.name;
          return 'FINISHED';
        },
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
        header: () => 'Use LMB click to define location where place the marker',
        status: () => [
          ['LMB', 'Place Marker'],
          ['Esc', 'Cancel'],
        ],
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'clip.delete_track',
    label: 'Delete Track',
    description: 'Delete selected tracks',
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: (ctx) => !!ctxTracks(ctx).some((t) => t.select && !t.hide),
    invoke: (ctx, p) => {
      if (!p.confirm) return ops.find((o) => o.idname === 'clip.delete_track')!.exec!(ctx, p);
      openMenu([{ label: 'Delete Track', icon: 'trash', op: 'clip.delete_track', props: { confirm: false } }], { x: app.pointer.x, y: app.pointer.y }, { title: 'Delete track?' });
      return 'CANCELLED';
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const n = tobj(c).tracks.filter((t) => t.select && !t.hide).length;
      tobj(c).tracks = tobj(c).tracks.filter((t) => !(t.select && !t.hide));
      if (!tobj(c).tracks.some((t) => t.name === tobj(c).active_track)) tobj(c).active_track = null;
      app.report('INFO', `Deleted ${n} track${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'clip.delete_marker',
    label: 'Delete Marker',
    description: 'Delete marker for current frame from selected tracks',
    poll: (ctx) => !!ctxTracks(ctx).some((t) => t.select && !t.hide),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      let n = 0;
      for (const t of selectedTracks(c)) {
        const before = t.markers.length;
        t.markers = t.markers.filter((m) => m.frame !== f);
        n += before - t.markers.length;
      }
      tobj(c).tracks = tobj(c).tracks.filter((t) => t.markers.length > 0);
      if (!tobj(c).tracks.some((t) => t.name === tobj(c).active_track)) tobj(c).active_track = null;
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'clip.track_markers',
    label: 'Track Markers',
    description: 'Track selected markers',
    props: [
      { id: 'backwards', label: 'Backwards', type: 'bool', default: false },
      { id: 'sequence', label: 'Track Sequence', type: 'bool', default: false },
    ],
    undo: false,
    poll: hasFootage,
    exec: (ctx, p) => {
      const clipId = contextClip(ctx)!.id;
      const backwards = !!p.backwards,
        sequence = !!p.sequence;
      void runJob('Track Markers', async (job) => {
        const startScene = app.doc.scene.frame_current;
        const clip0 = clipTable(app.doc)[clipId];
        const f0 = sceneToClipFrame(clip0, startScene);
        const end = backwards ? 1 : clip0.frame_duration;
        const total = Math.max(1, Math.abs(end - f0));
        const counts = new Map<string, number>();
        let frames = 0;
        const failed = new Set<string>();
        for (;;) {
          if (job.cancelled) break;
          const clip = clipTable(app.doc)[clipId];
          if (!clip) break;
          const f = sceneToClipFrame(clip, app.doc.scene.frame_current);
          if (backwards ? f <= 1 : f >= clip.frame_duration) break;
          const tracks = tobj(clip).tracks.filter((t) => t.select && !t.hide && !t.lock && enabledMarkerAt(t, f) && !(t.frames_limit > 0 && (counts.get(t.name) ?? 0) >= t.frames_limit));
          if (!tracks.length) break;
          const out = await trackStep(clip, tracks, f, backwards);
          for (const t of tracks) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
          out.failed.forEach((n) => failed.add(n));
          frames++;
          app.setFrame(clipToSceneFrame(clip, backwards ? f - 1 : f + 1));
          app.changed('doc');
          setProgress(job, frames / total);
          if (!sequence || !out.active.length) break;
          // yield to the UI between frames
          await new Promise((r) => setTimeout(r, 0));
        }
        return `Tracked ${frames} frame${frames === 1 ? '' : 's'}${failed.size ? `; lost: ${[...failed].join(', ')}` : ''}`;
      });
    },
  },
  {
    idname: 'clip.clear_track_path',
    label: 'Clear Track Path',
    description: 'Clear tracks after/before current position or clear the whole track',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'REMAINED',
        items: [
          ['UPTO', 'Clear Up To', 'Clear path up to current frame'],
          ['REMAINED', 'Clear Remained', 'Clear path at remaining frames (after current)'],
          ['ALL', 'Clear All', 'Clear the whole path'],
        ],
      },
      { id: 'clear_active', label: 'Clear Active', type: 'bool', default: false },
    ],
    poll: hasClip,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      const list = p.clear_active ? [activeTrack(c)].filter(Boolean) as MovieTrackingTrack[] : selectedTracks(c);
      for (const t of list) {
        const cur = ensureMarker(t, f);
        if (!cur) continue;
        if (p.action === 'UPTO' || p.action === 'ALL') {
          t.markers = t.markers.filter((m) => m.frame >= f);
          const d = cloneMarker(cur, f - 1);
          d.mute = true;
          d.is_keyed = false;
          insertMarker(t, d);
        }
        if (p.action === 'REMAINED' || p.action === 'ALL') {
          t.markers = t.markers.filter((m) => m.frame <= f);
          const d = cloneMarker(cur, f + 1);
          d.mute = true;
          d.is_keyed = false;
          insertMarker(t, d);
        }
      }
    },
  },
  {
    idname: 'clip.refine_markers',
    label: 'Refine Markers',
    description: "Refine selected markers positions by running the tracker from track's reference to current frame",
    props: [{ id: 'backwards', label: 'Backwards', type: 'bool', default: false }],
    undo: false,
    poll: hasFootage,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      void runJob('Refine Markers', async () => {
        const n = await refineMarkers(c, selectedTracks(c).filter((t) => !t.lock), curFrame(c), !!p.backwards);
        return `Refined ${n} marker${n === 1 ? '' : 's'}`;
      });
    },
  },
  {
    idname: 'clip.detect_features',
    label: 'Detect Features',
    description: 'Automatically detect features and place markers to track',
    props: [
      { id: 'placement', label: 'Placement', type: 'enum', default: 'FRAME', items: [['FRAME', 'Whole Frame', 'Place markers across the whole frame']] },
      { id: 'margin', label: 'Margin', type: 'int', default: 16, min: 0, subtype: 'pixel' },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.5, min: 0.0001, precision: 4 },
      { id: 'min_distance', label: 'Distance', type: 'int', default: 120, min: 0, subtype: 'pixel' },
    ],
    poll: hasFootage,
    exec: (ctx, p) => {
      const clip = contextClip(ctx)!;
      const f = curFrame(clip);
      const opts = { margin: Number(p.margin), threshold: Number(p.threshold), min_distance: Number(p.min_distance) };
      const place = (c: MovieClipData, feats: { x: number; y: number }[]) => {
        for (const t of tobj(c).tracks) t.select = false;
        for (const ft of feats) {
          const tr = newTrack(c.tracking, 'Track');
          insertMarker(tr, newMarker(f, toNormalized(c, ft.x, ft.y), c.size, c.tracking.settings.default_pattern_size, c.tracking.settings.default_search_size));
          tobj(c).tracks.push(tr);
          tobj(c).active_track = tr.name;
        }
        app.report('INFO', `Detected ${feats.length} feature${feats.length === 1 ? '' : 's'}`);
      };
      // the shown frame is normally decoded already: detect synchronously so the redo panel works
      const src = readySource(clip);
      const gray = src?.graySync(clipFrameToSourceIndex(clip, f));
      if (gray) {
        place(clip, detectFeatures(gray, opts));
        return 'FINISHED';
      }
      const clipId = clip.id;
      void runJob('Detect Features', async () => {
        const feats = await detectInFrame(clipTable(app.doc)[clipId], f, opts);
        const c = clipTable(app.doc)[clipId];
        if (c) place(c, feats);
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'clip.disable_markers',
    label: 'Disable Markers',
    description: 'Disable/enable selected markers',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'DISABLE', items: [['DISABLE', 'Disable'], ['ENABLE', 'Enable'], ['TOGGLE', 'Toggle']] }],
    poll: hasClip,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      for (const t of selectedTracks(c)) {
        if (t.lock) continue;
        const m = ensureMarker(t, f);
        if (!m) continue;
        m.mute = p.action === 'DISABLE' ? true : p.action === 'ENABLE' ? false : !m.mute;
      }
    },
  },
  {
    idname: 'clip.hide_tracks',
    label: 'Hide Tracks',
    description: 'Hide selected tracks',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: hasClip,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      for (const t of tobj(c).tracks) if (t.select !== !!p.unselected) t.hide = true;
      for (const t of tobj(c).tracks) if (t.hide) t.select = false;
    },
  },
  {
    idname: 'clip.hide_tracks_clear',
    label: 'Hide Tracks Clear',
    description: 'Clear hide selected tracks',
    poll: hasClip,
    exec: (ctx) => {
      for (const t of tobj(contextClip(ctx)!).tracks)
        if (t.hide) {
          t.hide = false;
          t.select = true;
        }
    },
  },
  {
    idname: 'clip.lock_tracks',
    label: 'Lock Tracks',
    description: 'Lock/unlock selected tracks',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'LOCK', items: [['LOCK', 'Lock'], ['UNLOCK', 'Unlock'], ['TOGGLE', 'Toggle']] }],
    poll: hasClip,
    exec: (ctx, p) => {
      for (const t of selectedTracks(contextClip(ctx)!)) t.lock = p.action === 'LOCK' ? true : p.action === 'UNLOCK' ? false : !t.lock;
    },
  },
  {
    idname: 'clip.select_all',
    label: '(De)select All',
    description: 'Change selection of all tracking markers',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: hasClip,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const vis = tobj(c).tracks.filter((t) => !t.hide);
      let action = p.action;
      if (action === 'TOGGLE') action = vis.some((t) => t.select) ? 'DESELECT' : 'SELECT';
      for (const t of vis) t.select = action === 'SELECT' ? true : action === 'DESELECT' ? false : !t.select;
    },
  },
  {
    idname: 'clip.select_box',
    label: 'Box Select',
    description: 'Select markers using box selection',
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP' && hasClip(ctx),
    invoke: (ctx) => {
      const ed = contextEditor(ctx)!;
      ed.boxPending = true;
      ed.canvas.style.cursor = 'crosshair';
      app.report('INFO', 'Drag to select markers (Shift extends, Ctrl subtracts)');
      return 'CANCELLED';
    },
  },
  {
    idname: 'clip.select_grouped',
    label: 'Select Grouped',
    description: 'Select all tracks from specified group',
    props: [
      {
        id: 'group',
        label: 'Action',
        type: 'enum',
        default: 'ESTIMATED',
        items: [
          ['KEYFRAMED', 'Keyframed Tracks', 'Select all keyframed tracks'],
          ['ESTIMATED', 'Estimated Tracks', 'Select all estimated tracks'],
          ['TRACKED', 'Tracked Tracks', 'Select all tracked tracks'],
          ['LOCKED', 'Locked Tracks', 'Select all locked tracks'],
          ['DISABLED', 'Disabled Tracks', 'Select all disabled tracks'],
          ['COLOR', 'Tracks with Same Color', 'Select all tracks with same color as active track'],
          ['FAILED', 'Failed Tracks', 'Select all tracks which failed to be reconstructed or tracked'],
        ],
      },
    ],
    poll: hasClip,
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      const act = activeTrack(c);
      for (const t of tobj(c).tracks) {
        if (t.hide) continue;
        const ex = markerExact(t, f),
          m = markerAt(t, f);
        let sel = false;
        switch (p.group) {
          case 'KEYFRAMED':
            sel = !!ex && ex.is_keyed && !ex.mute;
            break;
          case 'ESTIMATED':
            sel = !ex && !!m && !m.mute && f >= t.markers[0].frame;
            break;
          case 'TRACKED':
            sel = !!ex && !ex.is_keyed && !ex.mute;
            break;
          case 'LOCKED':
            sel = t.lock;
            break;
          case 'DISABLED':
            sel = !!m && m.mute;
            break;
          case 'COLOR':
            sel = !!act && t.use_custom_color === act.use_custom_color && (!t.use_custom_color || t.color.every((v, i) => Math.abs(v - act.color[i]) < 1e-4));
            break;
          case 'FAILED':
            sel = !!t.markers.length && t.markers[t.markers.length - 1].mute;
            break;
        }
        if (sel) t.select = true;
      }
    },
  },
  {
    idname: 'clip.keyframe_insert',
    label: 'Insert Keyframe',
    description: 'Insert a keyframe to selected tracks at current frame',
    poll: hasClip,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      for (const t of selectedTracks(c)) {
        if (t.lock) continue;
        const m = ensureMarker(t, f);
        if (m) m.is_keyed = true;
      }
    },
  },
  {
    idname: 'clip.keyframe_delete',
    label: 'Delete Keyframe',
    description: 'Delete a keyframe from selected tracks at current frame',
    poll: hasClip,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const f = curFrame(c);
      for (const t of selectedTracks(c)) {
        const m = markerExact(t, f);
        if (m && !t.lock) m.is_keyed = false;
      }
    },
  },
  {
    idname: 'clip.join_tracks',
    label: 'Join Tracks',
    description: 'Join selected tracks',
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && !!activeTrack(c)?.select && selectedTracks(c).length > 1;
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const act = activeTrack(c)!;
      const others = selectedTracks(c).filter((t) => t !== act);
      for (const o of others)
        for (const m of o.markers) {
          if (m.mute) continue;
          const ex = markerExact(act, m.frame);
          if (ex && !ex.mute) {
            ex.co = [(ex.co[0] + m.co[0]) / 2, (ex.co[1] + m.co[1]) / 2];
            ex.is_keyed ||= m.is_keyed;
          } else insertMarker(act, cloneMarker(m));
        }
      if (c.tracking.stabilization) for (const o of others) if (o.use_2d_stabilization) act.use_2d_stabilization = true;
      tobj(c).tracks = tobj(c).tracks.filter((t) => !others.includes(t));
    },
  },
  {
    idname: 'clip.average_tracks',
    label: 'Average Tracks',
    description: 'Average selected tracks into active',
    props: [{ id: 'keep_original', label: 'Keep Original', type: 'bool', default: true }],
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && selectedTracks(c).length > 1;
    },
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const sel = selectedTracks(c);
      const frames = new Set<number>();
      for (const t of sel) for (const m of t.markers) if (!m.mute) frames.add(m.frame);
      const tr = newTrack(c.tracking, 'Average Track');
      for (const f of [...frames].sort((a, b) => a - b)) {
        const ms = sel.map((t) => markerExact(t, f)).filter((m): m is MovieTrackingMarker => !!m && !m.mute);
        if (!ms.length) continue;
        const m = cloneMarker(ms[0], f);
        m.co = [ms.reduce((s, x) => s + x.co[0], 0) / ms.length, ms.reduce((s, x) => s + x.co[1], 0) / ms.length];
        m.is_keyed = ms.some((x) => x.is_keyed);
        insertMarker(tr, m);
      }
      if (!tr.markers.length) return 'CANCELLED';
      if (!p.keep_original) tobj(c).tracks = tobj(c).tracks.filter((t) => !sel.includes(t));
      for (const t of tobj(c).tracks) t.select = false;
      tobj(c).tracks.push(tr);
      tobj(c).active_track = tr.name;
    },
  },
  {
    idname: 'clip.copy_tracks',
    label: 'Copy Tracks',
    description: 'Copy the selected tracks to the internal clipboard',
    undo: false,
    poll: (ctx) => !!ctxTracks(ctx).some((t) => t.select),
    exec: (ctx) => {
      clipboard = structuredClone(selectedTracks(contextClip(ctx)!));
      app.report('INFO', `Copied ${clipboard.length} track(s)`);
    },
  },
  {
    idname: 'clip.paste_tracks',
    label: 'Paste Tracks',
    description: 'Paste tracks from the internal clipboard',
    poll: (ctx) => hasClip(ctx) && clipboard.length > 0,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      for (const t of tobj(c).tracks) t.select = false;
      for (const src of clipboard) {
        const t = structuredClone(src);
        t.name = uniqueTrackName(c.tracking, t.name);
        t.select = true;
        tobj(c).tracks.push(t);
        tobj(c).active_track = t.name;
      }
    },
  },
  {
    idname: 'clip.track_settings_as_default',
    label: 'Copy Settings to Defaults',
    description: 'Copy tracking settings from active track to default settings',
    poll: (ctx) => !!contextClip(ctx) && !!activeTrack(contextClip(ctx)!),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const t = activeTrack(c)!;
      const s = c.tracking.settings;
      const m = markerAt(t, curFrame(c));
      if (m) {
        s.default_pattern_size = Math.round(Math.max(...m.pattern_corners.map((p) => Math.abs(p[0]))) * 2 * c.size[0]);
        s.default_search_size = Math.round((m.search_max[0] - m.search_min[0]) * c.size[0]);
      }
      Object.assign(s, {
        default_motion_model: t.motion_model,
        default_pattern_match: t.pattern_match,
        default_margin: t.margin,
        default_correlation_min: t.correlation_min,
        default_frames_limit: t.frames_limit,
        use_default_brute: t.use_brute,
        use_default_normalization: t.use_normalization,
        use_default_red_channel: t.use_red_channel,
        use_default_green_channel: t.use_green_channel,
        use_default_blue_channel: t.use_blue_channel,
        default_weight: t.weight,
      });
    },
  },
  {
    idname: 'clip.track_settings_to_track',
    label: 'Apply Default Settings',
    description: 'Apply default tracking settings to all selected tracks',
    poll: (ctx) => !!ctxTracks(ctx).some((t) => t.select),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const s = c.tracking.settings;
      const f = curFrame(c);
      for (const t of selectedTracks(c)) {
        Object.assign(t, {
          motion_model: s.default_motion_model,
          pattern_match: s.default_pattern_match,
          margin: s.default_margin,
          correlation_min: s.default_correlation_min,
          frames_limit: s.default_frames_limit,
          use_brute: s.use_default_brute,
          use_normalization: s.use_default_normalization,
          use_red_channel: s.use_default_red_channel,
          use_green_channel: s.use_default_green_channel,
          use_blue_channel: s.use_default_blue_channel,
          weight: s.default_weight,
        });
        const m = ensureMarker(t, f);
        if (m) {
          const fresh = newMarker(f, m.co, c.size, s.default_pattern_size, s.default_search_size);
          m.pattern_corners = fresh.pattern_corners;
          m.search_min = fresh.search_min;
          m.search_max = fresh.search_max;
        }
      }
    },
  },
  {
    idname: 'clip.track_copy_color',
    label: 'Copy Color',
    description: 'Copy color to all selected tracks',
    poll: (ctx) => !!contextClip(ctx) && !!activeTrack(contextClip(ctx)!),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const a = activeTrack(c)!;
      for (const t of selectedTracks(c)) {
        t.use_custom_color = a.use_custom_color;
        t.color = [...a.color];
      }
    },
  },
  // 2D stabilization track lists
  ...(['', '_rotation'] as const).flatMap((kind): Operator[] => {
    const key = kind ? 'use_2d_stabilization_rotation' : 'use_2d_stabilization';
    const what = kind ? 'rotation' : 'translation';
    return [
      {
        idname: `clip.stabilize_2d${kind}_add`,
        label: kind ? 'Add Stabilization Rotation Tracks' : 'Add Stabilization Tracks',
        description: `Add selected tracks to 2D ${what} stabilization`,
        poll: (ctx) => !!contextClip(ctx)?.tracking.tracks.some((t) => t.select),
        exec: (ctx) => {
          for (const t of selectedTracks(contextClip(ctx)!)) t[key] = true;
        },
      },
      {
        idname: `clip.stabilize_2d${kind}_remove`,
        label: kind ? 'Remove Stabilization Rotation Track' : 'Remove Stabilization Track',
        description: `Remove selected track from ${what} stabilization`,
        poll: (ctx) => !!contextClip(ctx)?.tracking.tracks.some((t) => t[key]),
        exec: (ctx) => {
          const c = contextClip(ctx)!;
          const st = c.tracking.stabilization;
          const list = c.tracking.tracks.filter((t) => t[key]);
          const idx = kind ? st.active_rotation_track_index : st.active_track_index;
          const t = list[idx] ?? list[list.length - 1];
          if (!t) return 'CANCELLED';
          t[key] = false;
          if (kind) st.active_rotation_track_index = Math.max(0, Math.min(idx, list.length - 2));
          else st.active_track_index = Math.max(0, Math.min(idx, list.length - 2));
        },
      },
      {
        idname: `clip.stabilize_2d${kind}_select`,
        label: kind ? 'Select Stabilization Rotation Tracks' : 'Select Stabilization Tracks',
        description: `Select tracks which are used for ${what} stabilization`,
        poll: hasClip,
        exec: (ctx) => {
          for (const t of contextClip(ctx)!.tracking.tracks) if (t[key] && !t.hide) t.select = true;
        },
      },
    ];
  }),
  {
    idname: 'clip.track_to_empty',
    label: 'Link Empty to Track',
    description: 'Create an Empty object which will be copying movement of active track',
    poll: (ctx) => !!contextClip(ctx) && !!activeTrack(contextClip(ctx)!) && ctx.doc.mode === 'OBJECT',
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const t = activeTrack(c)!;
      const ob = newObject(t.name, 'EMPTY', null);
      addObjectToScene(ctx.doc, ob, { location: [0, 0, 0] });
      const con = newConstraint('FOLLOW_TRACK', uid('cn'));
      const objIndex = c.tracking.active_object_index ?? 0;
      Object.assign(con, { use_active_clip: false, clip: c.id, track: t.name, object: objIndex > 0 ? (c.tracking.objects?.[objIndex - 1]?.name ?? '') : '', use_3d_position: !!t.has_bundle && objIndex === 0 });
      ob.constraints.push(con);
    },
  },
  {
    idname: 'clip.constraint_to_fcurve',
    label: 'Constraint to F-Curve',
    description: 'Bake the motion this tracking constraint gives the object into keyframes and remove the constraint',
    props: [{ id: 'constraint', label: 'Constraint', type: 'string', default: '' }],
    poll: () => !!app.activeObject?.constraints.some((c) => BAKEABLE.includes(c.type)),
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const con = ob.constraints.find((c) => BAKEABLE.includes(c.type) && (!p.constraint || c.name === p.constraint));
      if (!con) return 'CANCELLED';
      const doc = ctx.doc;
      const clipsT = clipTable(doc);
      const clip = (con.use_active_clip !== false ? clipsT[doc.scene.active_clip ?? ''] : clipsT[(con.clip as string) ?? '']) ?? null;
      let span: [number, number] | null = null;
      if (con.type === 'FOLLOW_TRACK') {
        const track = clip ? trackingObjectByName(clip, con.object as string).tracks.find((t) => t.name === con.track) : undefined;
        if (!clip || !track) {
          app.report('ERROR', 'Movie clip or track to get keyframes from is not set');
          return 'CANCELLED';
        }
        span = trackSpan(track);
      } else {
        const rec = clip ? trackingObjectByName(clip, con.type === 'OBJECT_SOLVER' ? (con.object as string) : '').reconstruction : undefined;
        if (!clip || !rec?.is_valid) {
          app.report('ERROR', 'The movie clip has no camera solution to bake');
          return 'CANCELLED';
        }
        span = [rec.cameras[0].frame, rec.cameras[rec.cameras.length - 1].frame];
      }
      const a = span ? clipToSceneFrame(clip!, span[0]) : doc.scene.frame_start,
        b = span ? clipToSceneFrame(clip!, span[1]) : doc.scene.frame_end;
      const keep = doc.scene.frame_current;
      const samples: { f: number; m: Matrix4 }[] = [];
      for (let f = a; f <= b; f++) {
        doc.scene.frame_current = f;
        app.graph.evaluate(doc);
        const ev = app.graph.get(ob.id);
        if (!ev) continue;
        let m = ev.world.clone();
        if (ob.parent) {
          const pe = app.graph.get(ob.parent);
          if (pe) m = pe.world.clone().multiply(new Matrix4().fromArray(ob.matrix_parent_inverse)).invert().multiply(m);
        }
        samples.push({ f, m });
      }
      doc.scene.frame_current = keep;
      ob.constraints = ob.constraints.filter((c) => c !== con);
      const act = ensureAction(doc, ob);
      ob.rotation_mode = ob.rotation_mode === 'QUATERNION' || ob.rotation_mode === 'AXIS_ANGLE' ? 'XYZ' : ob.rotation_mode;
      for (const { f, m } of samples) {
        const pos = new Vector3(),
          q = new Quaternion(),
          s = new Vector3();
        m.decompose(pos, q, s);
        const e = new Euler().setFromQuaternion(q, ob.rotation_mode as 'XYZ');
        [pos.x, pos.y, pos.z].forEach((v, i) => insertKeyframe(ensureFCurve(act, 'location', i), f, v));
        [e.x, e.y, e.z].forEach((v, i) => insertKeyframe(ensureFCurve(act, 'rotation_euler', i), f, v));
        [s.x, s.y, s.z].forEach((v, i) => insertKeyframe(ensureFCurve(act, 'scale', i), f, v));
      }
      app.graph.invalidate(ob.id);
      app.report('INFO', `Baked ${samples.length} frames of "${con.name}" into keyframes`);
    },
  },
  {
    idname: 'clip.export_stabilized_footage',
    label: 'Export Stabilized Footage',
    description: 'Render the clip with 2D stabilization applied to a WebM video',
    undo: false,
    poll: (ctx) => hasFootage(ctx) && !!contextClip(ctx)?.tracking.stabilization.use_2d_stabilization,
    exec: (ctx) => {
      void exportStabilized(contextClip(ctx)!).catch((e) => app.report('ERROR', `Export failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  },
  {
    idname: 'clip.export_stabilization_data',
    label: 'Export Stabilization Data',
    description: 'Save the per-frame 2D stabilization (offset, rotation, scale) as CSV',
    undo: false,
    poll: (ctx) => hasFootage(ctx) && !!contextClip(ctx)?.tracking.stabilization.use_2d_stabilization,
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const rows = stabilizationTable(c);
      const csv = ['frame,scene_frame,offset_x_px,offset_y_px,rotation_rad,scale', ...rows.map((r) => [r.frame, clipToSceneFrame(c, r.frame), r.x.toFixed(4), r.y.toFixed(4), r.angle.toFixed(6), r.scale.toFixed(6)].join(','))].join('\n');
      download(csv, `${c.name.replace(/\.[^.]+$/, '')}_stabilization.csv`, 'text/csv');
      app.report('INFO', `Exported stabilization data (${rows.length} frames)`);
    },
  },
  // view operators
  {
    idname: 'clip.view_all',
    label: 'Frame All',
    description: 'View whole image with markers',
    props: [{ id: 'fit_view', label: 'Fit View', type: 'bool', default: false }],
    undo: false,
    poll: (ctx) => !!contextEditor(ctx),
    exec: (ctx, p) => {
      const ed = contextEditor(ctx)!;
      if (ed.view === 'CLIP') ed.frameAll(!!p.fit_view);
      else ed.frameAllView();
    },
  },
  {
    idname: 'clip.view_selected',
    label: 'Frame Selected',
    description: 'View all selected elements',
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP',
    exec: (ctx) => contextEditor(ctx)!.frameSelected(),
  },
  {
    idname: 'clip.view_zoom_in',
    label: 'Zoom In',
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP',
    exec: (ctx) => contextEditor(ctx)!.zoomAt(1.25),
  },
  {
    idname: 'clip.view_zoom_out',
    label: 'Zoom Out',
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP',
    exec: (ctx) => contextEditor(ctx)!.zoomAt(0.8),
  },
  {
    idname: 'clip.view_zoom_ratio',
    label: 'View Zoom Ratio',
    description: 'Set the zoom ratio (based on clip size)',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 1, min: 1 / 64, max: 64 }],
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP',
    exec: (ctx, p) => contextEditor(ctx)!.setRatio(Number(p.ratio)),
  },
  {
    idname: 'clip.lock_selection_toggle',
    label: 'Toggle Lock Selection',
    description: 'Toggle Lock Selection option of the current clip editor',
    undo: false,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP',
    exec: (ctx) => {
      const ed = contextEditor(ctx)!;
      ed.lockSelection = !ed.lockSelection;
      ed.redrawAll();
    },
  },
  {
    idname: 'clip.frame_jump',
    label: 'Jump to Frame',
    description: 'Jump to special frame',
    props: [
      {
        id: 'position',
        label: 'Position',
        type: 'enum',
        default: 'PATHSTART',
        items: [
          ['PATHSTART', 'Path Start', 'Jump to start of current path'],
          ['PATHEND', 'Path End', 'Jump to end of current path'],
          ['FAILEDPREV', 'Previous Failed', 'Jump to previous failed frame'],
          ['FAILNEXT', 'Next Failed', 'Jump to next failed frame'],
        ],
      },
    ],
    undo: false,
    poll: (ctx) => !!contextClip(ctx) && !!activeTrack(contextClip(ctx)!),
    exec: (ctx, p) => {
      const c = contextClip(ctx)!;
      const t = activeTrack(c)!;
      const f = curFrame(c);
      let target: number | null = null;
      if (p.position === 'PATHSTART' || p.position === 'PATHEND') {
        // contiguous enabled segments; use the one at the current frame, else the nearest in the jump direction
        const segs: [number, number][] = [];
        for (const m of t.markers) {
          if (m.mute) continue;
          const last = segs[segs.length - 1];
          if (last && m.frame === last[1] + 1) last[1] = m.frame;
          else segs.push([m.frame, m.frame]);
        }
        const seg = segs.find(([a, b]) => f >= a && f <= b) ?? (p.position === 'PATHSTART' ? segs.filter(([, b]) => b < f).pop() : segs.find(([a]) => a > f));
        if (seg) target = p.position === 'PATHSTART' ? seg[0] : seg[1];
      } else {
        const muted = t.markers.filter((m) => m.mute).map((m) => m.frame);
        target = p.position === 'FAILEDPREV' ? (muted.filter((x) => x < f).pop() ?? null) : (muted.find((x) => x > f) ?? null);
      }
      if (target === null) return 'CANCELLED';
      app.setFrame(clipToSceneFrame(c, target));
    },
  },
  {
    idname: 'clip.transform',
    label: 'Transform Markers',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATE', items: [['TRANSLATE', 'Move'], ['ROTATE', 'Rotate'], ['RESIZE', 'Resize']] }],
    internal: true,
    poll: (ctx) => contextEditor(ctx)?.view === 'CLIP' && !!ctxTracks(ctx).some((t) => t.select && !t.lock),
    invoke: (ctx, p) => transformInvoke(ctx, p.mode as string),
  },
];

registerOperators(ops);

// ---------------------------------------------------------------------------
// keymaps (default layout)

const isClipView = () => currentClipEditor()?.view === 'CLIP';

addKeys('Clip', [
  { key: 'O', alt: true, op: 'clip.open' },
  { key: 'LEFT_ARROW', alt: true, op: 'clip.track_markers', props: { backwards: true, sequence: false } },
  { key: 'RIGHT_ARROW', alt: true, op: 'clip.track_markers', props: { backwards: false, sequence: false } },
  { key: 'T', ctrl: true, op: 'clip.track_markers', props: { backwards: false, sequence: true } },
  { key: 'T', ctrl: true, shift: true, op: 'clip.track_markers', props: { backwards: true, sequence: true } },
  { key: 'P', op: 'clip.prefetch' },
]);

addKeys('Clip Editor', [
  { key: 'HOME', op: 'clip.view_all' },
  { key: 'F', op: 'clip.view_all', props: { fit_view: true } },
  { key: 'NUMPAD_PERIOD', op: 'clip.view_selected' },
  { key: 'NUMPAD_PLUS', op: 'clip.view_zoom_in' },
  { key: 'NUMPAD_MINUS', op: 'clip.view_zoom_out' },
  { key: 'NUMPAD_1', op: 'clip.view_zoom_ratio', props: { ratio: 1 } },
  { key: 'NUMPAD_2', op: 'clip.view_zoom_ratio', props: { ratio: 0.5 } },
  { key: 'NUMPAD_4', op: 'clip.view_zoom_ratio', props: { ratio: 0.25 } },
  { key: 'NUMPAD_8', op: 'clip.view_zoom_ratio', props: { ratio: 0.125 } },
  { key: 'NUMPAD_2', ctrl: true, op: 'clip.view_zoom_ratio', props: { ratio: 2 } },
  { key: 'NUMPAD_4', ctrl: true, op: 'clip.view_zoom_ratio', props: { ratio: 4 } },
  { key: 'NUMPAD_8', ctrl: true, op: 'clip.view_zoom_ratio', props: { ratio: 8 } },
  { key: 'LEFT_ARROW', shift: true, ctrl: true, op: 'clip.frame_jump', props: { position: 'PATHSTART' } },
  { key: 'RIGHT_ARROW', shift: true, ctrl: true, op: 'clip.frame_jump', props: { position: 'PATHEND' } },
  { key: 'LEFT_ARROW', shift: true, alt: true, op: 'clip.frame_jump', props: { position: 'FAILEDPREV' } },
  { key: 'RIGHT_ARROW', shift: true, alt: true, op: 'clip.frame_jump', props: { position: 'FAILNEXT' } },
  { key: 'A', op: 'clip.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'clip.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'clip.select_all', props: { action: 'INVERT' } },
  { key: 'B', op: 'clip.select_box', when: isClipView },
  {
    key: 'G',
    shift: true,
    menuTitle: 'Select Grouped',
    menu: () =>
      (
        [
          ['KEYFRAMED', 'Keyframed Tracks'],
          ['ESTIMATED', 'Estimated Tracks'],
          ['TRACKED', 'Tracked Tracks'],
          ['LOCKED', 'Locked Tracks'],
          ['DISABLED', 'Disabled Tracks'],
          ['COLOR', 'Tracks with Same Color'],
          ['FAILED', 'Failed Tracks'],
        ] as const
      ).map(([g, l]) => ({ label: l, op: 'clip.select_grouped', props: { group: g } })),
  },
  { key: 'X', shift: true, op: 'clip.delete_marker' },
  { key: 'DEL', shift: true, op: 'clip.delete_marker' },
  { key: 'D', shift: true, op: 'clip.disable_markers', props: { action: 'TOGGLE' } },
  { key: 'X', op: 'clip.delete_track' },
  { key: 'DEL', op: 'clip.delete_track' },
  { key: 'L', ctrl: true, op: 'clip.lock_tracks', props: { action: 'LOCK' } },
  { key: 'L', alt: true, op: 'clip.lock_tracks', props: { action: 'UNLOCK' } },
  { key: 'H', alt: true, op: 'clip.hide_tracks_clear' },
  { key: 'H', op: 'clip.hide_tracks', props: { unselected: false } },
  { key: 'H', shift: true, op: 'clip.hide_tracks', props: { unselected: true } },
  { key: 'I', op: 'clip.keyframe_insert' },
  { key: 'I', alt: true, op: 'clip.keyframe_delete' },
  { key: 'J', ctrl: true, op: 'clip.join_tracks' },
  { key: 'L', op: 'clip.lock_selection_toggle' },
  { key: 'G', op: 'clip.transform', props: { mode: 'TRANSLATE' } },
  { key: 'R', op: 'clip.transform', props: { mode: 'ROTATE' } },
  { key: 'S', op: 'clip.transform', props: { mode: 'RESIZE' } },
  { key: 'T', alt: true, op: 'clip.clear_track_path', props: { action: 'REMAINED', clear_active: false } },
  { key: 'T', shift: true, op: 'clip.clear_track_path', props: { action: 'UPTO', clear_active: false } },
  { key: 'T', shift: true, alt: true, op: 'clip.clear_track_path', props: { action: 'ALL', clear_active: false } },
  { key: 'C', ctrl: true, op: 'clip.copy_tracks' },
  { key: 'V', ctrl: true, op: 'clip.paste_tracks' },
  { key: 'W', menuTitle: 'Context Menu', menu: () => contextMenu(), when: isClipView },
]);

addKeys('Clip Graph Editor', [
  { key: 'HOME', op: 'clip.view_all' },
  { key: 'A', op: 'clip.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'clip.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'clip.select_all', props: { action: 'INVERT' } },
  { key: 'X', op: 'clip.delete_track' },
  { key: 'DEL', op: 'clip.delete_track' },
  { key: 'T', alt: true, op: 'clip.clear_track_path', props: { action: 'REMAINED', clear_active: true } },
  { key: 'T', shift: true, op: 'clip.clear_track_path', props: { action: 'UPTO', clear_active: true } },
  { key: 'T', shift: true, alt: true, op: 'clip.clear_track_path', props: { action: 'ALL', clear_active: true } },
  { key: 'D', shift: true, op: 'clip.disable_markers', props: { action: 'TOGGLE' } },
]);

addKeys('Clip Dopesheet Editor', [
  { key: 'HOME', op: 'clip.view_all' },
  { key: 'X', op: 'clip.delete_track' },
  { key: 'DEL', op: 'clip.delete_track' },
  { key: 'A', op: 'clip.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'clip.select_all', props: { action: 'DESELECT' } },
]);

