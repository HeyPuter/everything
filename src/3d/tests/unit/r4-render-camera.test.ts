// Panoramic cameras of the path tracer: ray directions per projection and the shader patch.
import { describe, expect, it } from 'vitest';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { panoramaParams, panoramaDirection, patchPanorama, panorama, defaultPanorama } from '../../src/render/final/ptcamera';
import { newCamera } from '../../src/data/defaults';

const close = (a: number[] | null, b: number[]) => {
  expect(a).not.toBeNull();
  a!.forEach((x, i) => expect(x).toBeCloseTo(b[i], 4));
};

function cam(type: string, extra: Record<string, unknown> = {}) {
  const ca = newCamera('Cam');
  ca.type = 'PANO';
  Object.assign(panorama(ca), { panorama_type: type, ...extra });
  return panoramaParams(ca)!;
}

describe('panoramic cameras', () => {
  it('only panoramic cameras get panorama parameters; defaults fill in', () => {
    const ca = newCamera('Cam');
    expect(panoramaParams(ca)).toBeNull();
    ca.type = 'PANO';
    expect(panorama(ca).panorama_type).toBe(defaultPanorama().panorama_type);
  });

  it('equirectangular: centre looks forward, quarter turns to the sides, top up', () => {
    const p = cam('EQUIRECTANGULAR');
    close(panoramaDirection(p, 0.5, 0.5, 2), [0, 0, -1]);
    close(panoramaDirection(p, 0.75, 0.5, 2), [1, 0, 0]);
    close(panoramaDirection(p, 0.25, 0.5, 2), [-1, 0, 0]);
    close(panoramaDirection(p, 0.5, 1, 2), [0, 1, 0]);
  });

  it('mirror ball and equidistant fisheye fill the frame; the rim looks back / sideways', () => {
    const mb = cam('MIRRORBALL');
    close(panoramaDirection(mb, 0.5, 0.5, 2), [0, 0, -1]);
    // 90° from forward at radius √½
    const d = panoramaDirection(mb, 0.5 + Math.SQRT1_2 / 2, 0.5, 2)!;
    expect(d[2]).toBeCloseTo(0, 4);
    expect(d[0]).toBeGreaterThan(0.99);
    expect(panoramaDirection(mb, 0.99, 0.99, 2)).toBeNull();
    const fe = cam('FISHEYE_EQUIDISTANT', { fisheye_fov: Math.PI });
    close(panoramaDirection(fe, 1, 0.5, 2), [1, 0, 0]);
    close(panoramaDirection(fe, 0.5, 1, 2), [0, 1, 0]);
  });

  it('equisolid fisheye follows the lens: radius on the sensor = 2 f sin(θ/2)', () => {
    const p = cam('FISHEYE_EQUISOLID', { fisheye_lens: 10.5, fisheye_fov: Math.PI });
    // a point 10 mm from the centre of a 36 mm sensor
    const u = 0.5 + 10 / 36;
    const dir = panoramaDirection(p, u, 0.5, 16 / 9)!;
    const theta = Math.acos(-dir[2]);
    expect(2 * 10.5 * Math.sin(theta / 2)).toBeCloseTo(10, 4);
    // beyond the field of view: outside the image circle
    expect(panoramaDirection(p, 1, 0, 16 / 9)).toBeNull();
  });

  it('cube face and cylinder projections', () => {
    const cf = cam('EQUIANGULAR_CUBEMAP_FACE');
    close(panoramaDirection(cf, 1, 0.5, 1), [Math.SQRT1_2, 0, -Math.SQRT1_2]);
    const cy = cam('CENTRAL_CYLINDRICAL');
    close(panoramaDirection(cy, 0.5, 0.5, 2), [0, 0, -1]);
  });

  it('patches the camera ray function of the path tracer', () => {
    const m = new PhysicalPathTracingMaterial();
    const src = patchPanorama(m.fragmentShader)!;
    expect(src).toContain('ptPanoDir( jitteredUv )');
    expect(src).toContain('if ( ptPanoOutside )');
  });
});
