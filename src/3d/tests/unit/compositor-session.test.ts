// @vitest-environment happy-dom
// Live compositing: the signature that decides when the last render is composited again.
import { describe, it, expect } from 'vitest';
import { emptyDocument, startupDocument } from '../../src/data/defaults';
import { signature } from '../../src/compositor/session';
import { setViewerRegion } from '../../src/compositor/viewregion';
import { newCompositingGroup } from '../../src/compositor/data';
import { addNode } from '../../src/nodes/tree';
import { newMovieClip, newTrack } from '../../src/tracking/types';
import '../../src/compositor/nodes/defs';
import '../../src/compositor/nodes/extra';

describe('compositor signature', () => {
  it('changes with the Viewer Region', () => {
    const doc = emptyDocument();
    const tree = newCompositingGroup(doc).tree;
    const a = signature(doc);
    setViewerRegion(tree, [0.2, 0.2, 0.6, 0.6]);
    const b = signature(doc);
    expect(b).not.toBe(a);
    setViewerRegion(tree, null);
    expect(signature(doc)).toBe(a);
  });
  it('changes with the tracking data of a clip a node reads, and the camera Defocus reads', () => {
    const doc = startupDocument();
    const tree = newCompositingGroup(doc).tree;
    const clip = newMovieClip('mc1', 'Shot');
    doc.movieclips = { mc1: clip };
    addNode(tree, 'CompositorNodeTrackPos', [0, 0], { clip: 'mc1' });
    const a = signature(doc);
    clip.tracking.tracks.push(newTrack(clip.tracking, 'Track'));
    expect(signature(doc)).not.toBe(a);
    const b = signature(doc);
    clip.tracking.stabilization.use_2d_stabilization = true;
    expect(signature(doc)).not.toBe(b);
    // the camera matters only with a Defocus node
    const cam = doc.cameras[doc.objects[doc.scene.camera!].data!];
    const c = signature(doc);
    cam.lens += 10;
    expect(signature(doc)).toBe(c);
    addNode(tree, 'CompositorNodeDefocus', [0, 0]);
    const d = signature(doc);
    cam.lens += 10;
    expect(signature(doc)).not.toBe(d);
  });
});
