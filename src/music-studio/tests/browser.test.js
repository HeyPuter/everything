import { describe, it, expect } from 'vitest';
import { instrumentNodes, effectNodes, projectNodes, projectSignature, filterNodes, flattenNodes, typeahead, countLeaves } from '../src/panels/browser-items.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../src/instruments/presets.js';
import { EFFECT_TYPES } from '../src/effects/catalog.js';

const tree = () => [
  { id: 'sec:instruments', label: 'Instruments', kind: 'section', children: instrumentNodes() },
  { id: 'sec:effects', label: 'Effects', kind: 'section', children: effectNodes() },
  { id: 'sec:project', label: 'Project', kind: 'section', children: projectNodes(demoProject()) },
];

describe('browser tree', () => {
  it('lists every instrument type, preset and effect', () => {
    const inst = instrumentNodes();
    expect(countLeaves(inst)).toBe(3 + SYNTH_PRESETS.length - 1 + DRUM_PRESETS.length);
    expect(countLeaves(effectNodes())).toBe(EFFECT_TYPES.length);
    const acid = inst.find((n) => n.id === 'grp:synth').children.flatMap((g) => g.children).find((n) => n.label === 'Acid Bass');
    expect(acid.data).toMatchObject({ type: 'synth', name: 'Acid Bass' });
  });

  it('filters by words across labels, keywords and parents', () => {
    const r = filterNodes(tree(), 'bass');
    const labels = flattenNodes(r, new Set(), { expandAll: true }).map((x) => x.node.label);
    expect(labels).toContain('Acid Bass');
    expect(labels).toContain('Sub Bass');
    expect(labels).toContain('Bass'); // the demo's channel
    expect(labels).not.toContain('Kick');
    // Words combine; a parent's label counts.
    const lead = flattenNodes(filterNodes(tree(), 'lead saw'), new Set(), { expandAll: true }).map((x) => x.node.label);
    expect(lead).toContain('Saw Lead');
    expect(lead).not.toContain('Square Lead');
    // Category names match their items (keywords).
    expect(countLeaves(filterNodes(tree(), 'dynamics'))).toBe(2);
    expect(filterNodes(tree(), 'zzzz')).toEqual([]);
    const t = tree();
    expect(filterNodes(t, '  ')).toBe(t);
  });

  it('flattens only expanded groups with ARIA positions', () => {
    const rows = flattenNodes(tree(), new Set(['sec:effects']));
    expect(rows[0]).toMatchObject({ level: 1, pos: 1, size: 3, expandable: true, open: false });
    const fx = rows.findIndex((r) => r.node.id === 'sec:effects');
    expect(rows[fx].open).toBe(true);
    expect(rows[fx + 1]).toMatchObject({ level: 2, parent: 'sec:effects', pos: 1 });
    expect(rows.at(-1).node.id).toBe('sec:project');
  });

  it('jumps by type-ahead, wrapping around', () => {
    const rows = flattenNodes(tree(), new Set(['sec:instruments']));
    const i = typeahead(rows, 0, 'd');
    expect(rows[i].node.label).toBe('Drum Synth');
    expect(rows[typeahead(rows, i, 'dr')].node.label).toBe('Drum Synth');
    expect(rows[typeahead(rows, rows.length - 1, 'i')].node.label).toBe('Instruments');
    expect(typeahead(rows, 0, 'qqq')).toBe(-1);
  });

  it('shows project parts and changes its signature only when they change', () => {
    const p = demoProject();
    const nodes = projectNodes(p);
    expect(nodes.find((n) => n.id === 'prj:patterns').count).toBe(4);
    expect(nodes.find((n) => n.id === 'prj:samples').children[0].kind).toBe('note');
    const sig = projectSignature(p);
    const moved = E.setProjectProps(p, { bpm: 90 });
    expect(projectSignature(moved)).toBe(sig);
    const renamed = E.updatePattern(p, p.patterns[0].id, { name: 'Drums' });
    expect(projectSignature(renamed)).not.toBe(sig);
  });
});
