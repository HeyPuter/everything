import { describe, expect, it } from 'vitest';
import { newMovieClip, newTrack, newMarker } from '../../src/tracking/types';
import { applyH, initialQuad, newPlaneTrack, rectify, squareToQuad, trackHomography, updatePlaneTrack } from '../../src/tracking/planetrack';

/** Points on a plane seen under a homography that changes smoothly with the frame. */
function frameH(f: number): number[] {
  const a = 0.02 * f,
    s = 1 + 0.01 * f;
  return [s * Math.cos(a), -s * Math.sin(a), 10 * f, s * Math.sin(a), s * Math.cos(a), 4 * f, 0.00002 * f, -0.00001 * f, 1];
}

function planarClip(frames = 20) {
  const c = newMovieClip('MC', 'plane', { size: [1000, 800], frame_duration: frames });
  const base = [
    [300, 300],
    [600, 320],
    [620, 560],
    [320, 540],
    [450, 420],
    [520, 380],
  ];
  base.forEach((p, i) => {
    const t = newTrack(c.tracking, `T${i}`);
    for (let f = 1; f <= frames; f++) {
      const q = applyH(frameH(f - 1), p);
      t.markers.push(newMarker(f, [q[0] / 1000, q[1] / 800], c.size, 21, 71));
    }
    c.tracking.tracks.push(t);
  });
  return c;
}

describe('plane tracks', () => {
  it('fits the homography between frames from the tracks', () => {
    const c = planarClip();
    const H = trackHomography(c, c.tracking.tracks, 1, 6)!;
    // frame 1 is the identity: the fit must equal frameH(5)
    const p = applyH(H, [400, 400]);
    const q = applyH(frameH(5), [400, 400]);
    expect(p[0]).toBeCloseTo(q[0], 4);
    expect(p[1]).toBeCloseTo(q[1], 4);
  });

  it('carries the corners from the keyframe through the shot (forwards and backwards)', () => {
    const c = planarClip();
    const tracks = c.tracking.tracks;
    const q = initialQuad(tracks.slice(0, 4), 8)!;
    const pt = newPlaneTrack('Plane', tracks.map((t) => t.name));
    pt.markers.push({ frame: 8, corners: q, mute: false, is_keyed: true });
    updatePlaneTrack(c, c.tracking, pt);
    expect(pt.markers.length).toBe(20);
    // ground truth: map the keyframe corners back to frame 1 then forward to frame f
    const inv = (H: number[]) => {
      const [a, b, cc, d, e, f, g, h, i] = H;
      const A = e * i - f * h,
        B = -(d * i - f * g),
        C = d * h - e * g;
      const det = a * A + b * B + cc * C;
      return [A / det, -(b * i - cc * h) / det, (b * f - cc * e) / det, B / det, (a * i - cc * g) / det, -(a * f - cc * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    };
    for (const f of [1, 15, 20]) {
      const m = pt.markers.find((x) => x.frame === f)!;
      expect(m.is_keyed).toBe(false);
      for (let k = 0; k < 4; k++) {
        const px = [q[k][0] * 1000, q[k][1] * 800];
        const truth = applyH(frameH(f - 1), applyH(inv(frameH(7)), px));
        expect(m.corners[k][0] * 1000).toBeCloseTo(truth[0], 2);
        expect(m.corners[k][1] * 800).toBeCloseTo(truth[1], 2);
      }
    }
  });

  it('rectifies the plane area of an image', () => {
    // 4×4 image, red in the left half (canvas rows top-down)
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const k = (y * 4 + x) * 4;
        data[k] = x < 2 ? 255 : 0;
        data[k + 3] = 255;
      }
    const out = rectify({ width: 4, height: 4, data }, [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ], 2, 2);
    expect([out[0], out[4]]).toEqual([255, 0]);
    expect(squareToQuad([[0, 0], [1, 0], [1, 1], [0, 1]]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
