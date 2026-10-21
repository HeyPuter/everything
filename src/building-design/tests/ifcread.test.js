import { describe, it, expect } from 'vitest';
import { createSampleProject } from '../src/core/sample.js';
import { Scene } from '../src/core/scene.js';
import { writeIFC } from '../src/io/ifc.js';
import { readIFC, parseStep } from '../src/io/ifcread.js';
import { packParts, buildImported } from '../src/core/imported.js';

const bounds = (tris) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], tris[i + k]);
      max[k] = Math.max(max[k], tris[i + k]);
    }
  return { min, max };
};

describe('reading IFC', () => {
  it('parses STEP values: strings, references, enums, lists, typed values and unset', () => {
    const E = parseStep("DATA;\n#1=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',#2,'It''s a wall',$,*,.T.,(#3,#4),IFCLABEL('x'),-1.5E2);\nENDSEC;");
    expect(E.get(1).type).toBe('IFCWALL');
    expect(E.get(1).args).toEqual(['2O2Fr$t4X7Zf8NOew3FLOH', { ref: 2 }, "It's a wall", null, null, { enum: 'T' }, [{ ref: 3 }, { ref: 4 }], 'x', -150]);
  });

  it('reads back a model this app exported, at the same size', () => {
    const doc = createSampleProject();
    const app = { doc, scene: new Scene(doc) };
    const text = writeIFC(app);
    const read = readIFC(typeof text === 'string' ? text : text.text);
    expect(read.count).toBeGreaterThan(10);
    const packed = packParts(read);
    expect(packed.types.WALL).toBeGreaterThan(3);
    const all = packed.parts.flatMap((p) => p.tris);
    const b = bounds(all);
    // The sample house is about 12 m x 8 m and a storey and a roof high.
    expect(b.max[0] - b.min[0]).toBeGreaterThan(9000);
    expect(b.max[2] - b.min[2]).toBeGreaterThan(3000);
    const mesh = buildImported({ parts: packed.parts, at: [0, 0], rotation: 0, z: 0 });
    expect(mesh.pos.length).toBeGreaterThan(1000);
  });
});
