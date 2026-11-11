// @vitest-environment happy-dom
// Live compositing: the signature that decides when the last render is composited again.
import { describe, it, expect } from 'vitest';
import { emptyDocument } from '../../src/data/defaults';
import { signature } from '../../src/compositor/session';
import { setViewerRegion } from '../../src/compositor/viewregion';
import { newCompositingGroup } from '../../src/compositor/data';

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
});
