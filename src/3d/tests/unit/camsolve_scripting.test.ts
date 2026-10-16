// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript, output } from '../../src/scripting/runner';
import { clipTable, newMarker, newMovieClip, newTrack } from '../../src/tracking/types';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

/** A clip whose tracks are projections of random points seen by a camera dollying sideways. */
function solvableClip() {
  const W = 1280,
    H = 720,
    frames = 24;
  const c = newMovieClip('MC_s', 'shot', { size: [W, H], frame_duration: frames });
  const f = (c.tracking.camera.focal_length * W) / c.tracking.camera.sensor_width;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
  for (let i = 0; i < 50; i++) {
    const X = [(rnd() - 0.5) * 10, (rnd() - 0.5) * 5, 5 + rnd() * 8];
    const t = newTrack(c.tracking, 'Track');
    for (let k = 1; k <= frames; k++) {
      const s = (k - 1) / (frames - 1);
      const yaw = -0.3 + 0.6 * s;
      const C = [-1.5 + 3 * s, 0, 0.5 * s];
      const d = [X[0] - C[0], X[1] - C[1], X[2] - C[2]];
      const p = [Math.cos(yaw) * d[0] - Math.sin(yaw) * d[2], d[1], Math.sin(yaw) * d[0] + Math.cos(yaw) * d[2]];
      if (p[2] < 0.5) continue;
      const px = W / 2 + (f * p[0]) / p[2],
        py = H / 2 - (f * p[1]) / p[2];
      if (px < 0 || py < 0 || px > W || py > H) continue;
      t.markers.push(newMarker(k, [px / W, py / H], c.size, 21, 71));
    }
    t.select = false;
    if (t.markers.length > 1) c.tracking.tracks.push(t);
  }
  clipTable(app.doc)[c.id] = c;
  app.doc.scene.active_clip = c.id;
  return c;
}

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  await new Promise((r) => setTimeout(r, 10));
}, 60000);

beforeEach(() => {
  setApp(new App(startupDocument()));
});

describe('camera solve from scripts', () => {
  it('solves with bpy.ops.clip.solve_camera and reads the reconstruction', () => {
    solvableClip();
    const out = run(`
      const clip = D.movieclips['shot'];
      const tr = clip.tracking;
      print(tr.tracks.length > 40, tr.camera.focal_length, tr.reconstruction.is_valid);
      tr.settings.use_keyframe_selection = true;
      bpy.ops.clip.solve_camera();
      const rec = tr.reconstruction;
      print(rec.is_valid, rec.cameras.length, rec.average_error < 0.1);
      const cam = rec.cameras[3];
      print(cam.frame, cam.matrix.length === 4 || cam.matrix.length === 16);
      const t = tr.tracks[0];
      print(t.has_bundle, typeof t.bundle.x, t.average_error < 0.1);
      print(tr.objects.length, tr.objects[0].name, tr.objects.active.name);
    `);
    const lines = out.split('\n');
    expect(lines[0]).toBe('true 24 false');
    expect(lines[1]).toBe('true 24 true');
    expect(lines[2]).toBe('4 true');
    expect(lines[3]).toBe('true number true');
    expect(lines[4]).toBe('1 Camera Camera');
  });

  it('tracking objects, solved camera matrices and new tracks', () => {
    solvableClip();
    const out = run(`
      const clip = D.movieclips['shot'];
      const tr = clip.tracking;
      bpy.ops.clip.solve_camera();
      const m = tr.reconstruction.cameras.matrix_from_frame(tr.objects[0].keyframe_a);
      print(Math.abs(m.translation.x) < 1e-9, tr.reconstruction.cameras.find_frame(2).frame, tr.reconstruction.cameras.find_frame(99));
      const ob = tr.objects.new('Prop');
      tr.objects.active = ob;
      print(tr.objects.length, tr.objects.active.name, ob.is_camera, ob.reconstruction.is_valid, ob.tracks.length);
      const t = ob.tracks.new('Corner', 3);
      print(ob.tracks.length, t.name, t.markers[0].frame);
      tr.objects.remove(ob);
      print(tr.objects.length);
    `);
    expect(out.split('\n')).toEqual(['true 2 null', '2 Prop false false 0', '1 Corner 3', '1']);
  });
});
