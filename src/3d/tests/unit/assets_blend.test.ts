// Asset marks read from .blend files (tests/fixtures/blend/assets_zstd.blend, written by
// tests/fixtures/blend/make_assets.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBlend } from '../../src/io/blend/convert';
import { applyCatalogFile, parseCatalogFile } from '../../src/io/blend/assets';
import { assetsOf } from '../../src/assets/types';
import { catalogTree } from '../../src/assets/catalogs';

const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../fixtures/blend/${n}`, import.meta.url)));

describe('.blend asset marks', () => {
  it('turns asset-marked data-blocks into assets with their metadata', async () => {
    const { doc } = await readBlend(fixture('assets_zstd.blend'));
    const assets = assetsOf(doc);
    const byName = Object.fromEntries(assets.map((a) => [a.block.name, a]));
    expect(Object.keys(byName).sort()).toEqual(['Asset World', 'Cube', 'Lonely Red', 'My GN']);
    expect(byName.Cube.table).toBe('objects');
    const m = byName.Cube.block.asset_data!;
    expect(m.description).toBe('A test box');
    expect(m.author).toBe('Tester');
    expect(m.license).toBe('CC0');
    expect(m.copyright).toBe('none');
    expect(m.tags).toEqual(['box', 'test']);
    expect(m.catalog_id).toBe('12345678-1234-4234-8234-123456789abc');
    // assets nothing uses are converted too
    expect(byName['Lonely Red'].table).toBe('materials');
    expect(byName['My GN'].table).toBe('node_groups');
    expect(doc.node_groups[byName['My GN'].block.id].tree.type).toBe('GEOMETRY');
    expect(byName['Asset World'].table).toBe('worlds');
    expect(doc.materials[byName['Lonely Red'].block.id].use_fake_user).toBe(true);
    // the catalog exists (named from its one-line name until a definition file is read)
    expect(doc.asset_catalogs!.some((c) => c.id === m.catalog_id)).toBe(true);
  });

  it('reads catalog definition files', async () => {
    expect(parseCatalogFile('VERSION 1\n# comment\n12345678-1234-4234-8234-123456789ABC:Props/Boxes:Props-Boxes\nbad line\n')).toEqual([{ id: '12345678-1234-4234-8234-123456789abc', path: 'Props/Boxes' }]);
    const { doc } = await readBlend(fixture('assets_zstd.blend'));
    applyCatalogFile(doc, '12345678-1234-4234-8234-123456789abc:Props/Big Boxes:Props-Big Boxes\n');
    const tree = catalogTree(doc.asset_catalogs!);
    expect(tree.map((n) => n.path)).toContain('Props');
    expect(tree.find((n) => n.path === 'Props')!.children.map((n) => n.path)).toEqual(['Props/Big Boxes']);
  });
});
