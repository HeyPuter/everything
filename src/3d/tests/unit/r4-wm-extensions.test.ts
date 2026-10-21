import { describe, it, expect } from 'vitest';
import { parseManifest, compareVersions, packageFiles, filterExtensions, allTags } from '../../src/prefs/extensions_core';

const good = { schema: 1, id: 'mesh_tools', name: 'Mesh Tools', version: '1.2.0', type: 'add-on', entry: 'main.py', tags: ['Mesh', 'Modeling'] };

describe('extension manifests', () => {
  it('accepts a valid manifest and normalizes it', () => {
    const r = parseManifest({ ...good, tagline: '  Tools ', entry: './main.py' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.entry).toBe('main.py');
      expect(r.manifest.tagline).toBe('Tools');
      expect(r.manifest.maintainer).toBe('');
    }
  });
  it('refuses broken manifests with a reason', () => {
    const bad = (o: object) => {
      const r = parseManifest({ ...good, ...o });
      return r.ok ? '' : r.error;
    };
    expect(bad({ schema: 2 })).toMatch(/schema/);
    expect(bad({ id: 'Mesh Tools' })).toMatch(/lowercase/);
    expect(bad({ name: '' })).toMatch(/name/);
    expect(bad({ version: 'one' })).toMatch(/version/);
    expect(bad({ type: 'brush' })).toMatch(/type/);
    expect(bad({ entry: 'main.txt' })).toMatch(/\.py or \.js/);
    expect(bad({ type: 'theme', entry: 'theme.py' })).toMatch(/\.json/);
    expect(bad({ entry: '../x.py' })).toMatch(/entry/);
    expect(parseManifest({ ...good, min_app_version: '9.0' }, '0.1.0').ok).toBe(false);
    expect(parseManifest({ ...good, min_app_version: '0.1' }, '0.1.0').ok).toBe(true);
    expect(parseManifest([]).ok).toBe(false);
  });
  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9', '1')).toBe(-1);
  });
  it('finds the manifest at the root or in one folder', () => {
    const b = new Uint8Array([1]);
    expect(packageFiles({ 'extension.json': b, 'main.py': b })?.root).toBe('');
    const nested = packageFiles({ 'pkg/extension.json': b, 'pkg/main.py': b, '__MACOSX/pkg/._main.py': b });
    expect(nested?.root).toBe('pkg/');
    expect(Object.keys(nested!.files).sort()).toEqual(['extension.json', 'main.py']);
    expect(packageFiles({ 'a/b/extension.json': b })).toBeNull();
  });
  it('filters by text, type and tags', () => {
    const mk = (id: string, type: 'add-on' | 'theme', tags: string[]) => ({ manifest: { ...good, id, name: id, type, tags, tagline: '', maintainer: '', website: '' } as never });
    const list = [mk('zeta', 'add-on', ['Mesh']), mk('alpha', 'theme', ['Dark']), mk('beta', 'add-on', [])];
    expect(filterExtensions(list, { type: 'add-on' }).map((e) => (e as { manifest: { id: string } }).manifest.id)).toEqual(['beta', 'zeta']);
    expect(filterExtensions(list, { tags: ['Dark'] })).toHaveLength(1);
    expect(filterExtensions(list, { text: 'ZET' })).toHaveLength(1);
    expect(allTags(list)).toEqual(['Dark', 'Mesh']);
  });
});
