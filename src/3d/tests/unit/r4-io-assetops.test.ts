// @vitest-environment happy-dom
// Single-asset operators (data-block selector menus) and the asset shelf popover operator.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, operators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { encodeTarget } from '../../src/assets/types';

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
});
beforeEach(() => setApp(new App(startupDocument())));

describe('single asset operators', () => {
  it('marks and clears exactly one data-block', () => {
    const mat = Object.values(app.doc.materials)[0];
    const cube = Object.values(app.doc.objects).find((o) => o.type === 'MESH')!;
    cube.select = true;
    expect(app.run('asset.mark_single', { targets: encodeTarget('materials', mat.id) }, { invoke: false })).toBe('FINISHED');
    expect(app.doc.materials[mat.id].asset_data).toBeTruthy();
    // the selected object was not marked
    expect(app.doc.objects[cube.id].asset_data).toBeFalsy();
    expect(app.run('asset.mark_single', { targets: encodeTarget('materials', mat.id) }, { invoke: false })).toBe('CANCELLED');
    expect(app.run('asset.clear_single', { targets: encodeTarget('materials', mat.id), set_fake_user: true }, { invoke: false })).toBe('FINISHED');
    expect(app.doc.materials[mat.id].asset_data).toBeFalsy();
    expect(app.doc.materials[mat.id].use_fake_user).toBe(true);
  });

  it('falls back to the active object', () => {
    const act = app.doc.scene.active_object!;
    expect(app.run('asset.mark_single', {}, { invoke: false })).toBe('FINISHED');
    expect(app.doc.objects[act].asset_data).toBeTruthy();
  });

  it('registers the browser and shelf operators', () => {
    for (const id of ['asset.assign_action', 'asset.library_reload_listing', 'asset.browse_containing_blend_file', 'asset.catalog_undo_push', 'wm.call_asset_shelf_popover']) expect(operators.has(id), id).toBe(true);
    expect(app.run('wm.call_asset_shelf_popover', { name: 'NOPE' }, { invoke: false })).toBe('CANCELLED');
  });
});
