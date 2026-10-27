import { describe, expect, it } from 'vitest';
import { cfgToSvg, layoutCfg } from '../src/engine/cfg-layout.js';
import { buildBasicBlocks } from '../src/engine/functions.js';
import { analyzeBinary } from '../src/engine/analyze.js';
import { makeTinyPe } from './fixtures.js';

describe('layoutCfg', () => {
  it('returns empty geometry for no blocks', () => {
    expect(layoutCfg([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('places entry above a fall-through successor', () => {
    const blocks = [
      {
        id: 'bb_0',
        start: 0,
        end: 4,
        successors: [4],
        instructions: [{ mnemonic: 'nop', size: 4 }],
      },
      {
        id: 'bb_4',
        start: 4,
        end: 5,
        successors: [],
        instructions: [{ mnemonic: 'ret', size: 1, isRet: true }],
      },
    ];
    const layout = layoutCfg(blocks);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    const entry = layout.nodes.find((n) => n.id === 'bb_0');
    const next = layout.nodes.find((n) => n.id === 'bb_4');
    expect(next.y).toBeGreaterThan(entry.y);
    expect(layout.edges[0].from).toBe('bb_0');
    expect(layout.edges[0].to).toBe('bb_4');
  });

  it('emits SVG with selected node highlight', () => {
    const blocks = [
      { id: 'bb_0', start: 0, end: 1, successors: [], instructions: [{ mnemonic: 'ret', isRet: true }] },
    ];
    const svg = cfgToSvg(layoutCfg(blocks), { selectedStart: 0 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('bb_0');
    expect(svg).toContain('#d6e8c8');
  });
});

describe('CFG from PE analysis', () => {
  it('layouts entry function blocks', () => {
    const doc = analyzeBinary(makeTinyPe());
    const entry = doc.functions.find((f) => f.reasons.includes('entry'));
    expect(entry.blocks.length).toBeGreaterThan(0);
    const layout = layoutCfg(entry.blocks);
    expect(layout.nodes.length).toBe(entry.blocks.length);
    expect(buildBasicBlocks(entry.blocks.flatMap((b) => b.instructions)).length).toBeGreaterThan(0);
  });
});
