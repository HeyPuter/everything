import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createText } from '../src/model/nodes.js';
import { registerMeasureFont } from '../src/model/text-layout.js';
import { apply, invert, multiply } from '../src/lib/matrix.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import {
  installFreeform,
  freeformStyle,
  freeformFrame,
  framePoint,
} from '../src/features/paint/freeform.js';

beforeAll(() => {
  installCanvasStub();
  installFreeform();
  const buf = readFileSync(
    resolve(process.cwd(), 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'),
  );
  registerMeasureFont(
    'Inter',
    400,
    'normal',
    opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  );
});

const ff = {
  type: 'freeform',
  points: [
    { x: 0, y: 0.5, color: '#ff0000' },
    { x: 1, y: 0.5, color: '#0000ff' },
  ],
};

describe('Freeform gradients on type', () => {
  it('place the blend over the type, inside its transform and run placement', () => {
    // A canvas the raster can be drawn into, and a pattern that records its matrix.
    const getContext = HTMLCanvasElement.prototype.getContext;
    const hadMatrix = 'DOMMatrix' in globalThis;
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      };
    };
    if (!hadMatrix)
      globalThis.DOMMatrix = class {
        constructor(m) {
          this.m = m;
        }
      };
    try {
      const doc = VDocument.create({ width: 800, height: 600 });
      const c = Math.cos(0.3);
      const s = Math.sin(0.3);
      const t = createText('WWWW', 300, 300, {
        fill: ff,
        transform: [c * 2, s * 2, -s * 2, c * 2, 50, 80],
      });
      doc.transact('add', () => doc.insert(t, doc.layers()[0].id));
      const node = doc.get(t.id);
      const seg = [1, 0, 0, 1, 300, 300];
      let pattern = null;
      const ctx = {
        createPattern: (canvas) =>
          (pattern = {
            canvas,
            setTransform(m) {
              this.m = m.m;
            },
          }),
      };
      expect(freeformStyle(ctx, doc, node, ff, seg)).toBe(pattern);
      // The raster's middle lands on the middle of the type's frame, in the run's own space.
      const f = freeformFrame(doc, node);
      const mid = framePoint(f, 0.5, 0.5);
      const local = apply(invert(multiply(node.transform, seg)), mid.x, mid.y);
      const p = apply(pattern.m, pattern.canvas.width / 2, pattern.canvas.height / 2);
      expect(p.x).toBeCloseTo(local.x, 6);
      expect(p.y).toBeCloseTo(local.y, 6);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      if (!hadMatrix) delete globalThis.DOMMatrix;
    }
  });

  it("export to SVG in the type's own space", () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      };
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = () => `data:image/png;base64,${'A'.repeat(40)}`;
    try {
      const doc = VDocument.create({ width: 800, height: 600 });
      const c = Math.cos(0.3);
      const s = Math.sin(0.3);
      const t = createText('WWWW', 300, 300, {
        fill: ff,
        transform: [c * 2, s * 2, -s * 2, c * 2, 50, 80],
      });
      doc.transact('add', () => doc.insert(t, doc.layers()[0].id));
      const node = doc.get(t.id);
      const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 2000, h: 2000 } });
      const m = svg
        .match(/<pattern [^>]*patternTransform="matrix\(([^)]*)\)"/)[1]
        .split(' ')
        .map(Number);
      const text = svg
        .match(/<text[^>]*transform="matrix\(([^)]*)\)"/)[1]
        .split(/[ ,]+/)
        .map(Number);
      // The pattern sits inside the text element's transform: together they place the blend on the frame.
      const f = freeformFrame(doc, node);
      const mid = framePoint(f, 0.5, 0.5);
      const p = apply(multiply(text, m), 0.5, 0.5);
      expect(p.x).toBeCloseTo(mid.x, 2);
      expect(p.y).toBeCloseTo(mid.y, 2);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      HTMLCanvasElement.prototype.toDataURL = toDataURL;
    }
  });
});
