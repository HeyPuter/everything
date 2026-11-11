// @vitest-environment happy-dom
// Line style modules are code that comes with a project: they obey Auto Run Scripts like registered texts.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { PerspectiveCamera } from 'three';
import { App, setApp, app } from '../../src/app/app';
import { prefs } from '../../src/app/prefs';
import { startupDocument, newText } from '../../src/data/defaults';
import { freestyleSettings } from '../../src/lines/defaults';
import { renderLineLayer } from '../../src/lines/render';

type G = { __styleModuleRan?: number };

function projectWithModule() {
  setApp(new App(startupDocument()));
  const doc = app.doc;
  doc.scene.render.use_freestyle = true;
  const fs = freestyleSettings(doc);
  fs.use_freestyle = true;
  fs.mode = 'SCRIPT';
  const t = newText('style.js', "globalThis.__styleModuleRan = (globalThis.__styleModuleRan ?? 0) + 1;\nlines.draw({ select: { edge_types: ['silhouette'] }, style: { color: [1, 0, 0], thickness: 3 } });", 'javascript');
  doc.texts[t.id] = t;
  fs.modules = [{ script: t.id, use: true }];
  app.graph.evaluate?.();
}

async function render() {
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(6, -6, 5);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  const layer = await renderLineLayer({ camera, width: 64, height: 64, frameHeight: 64 });
  let ink = 0;
  for (let i = 3; i < (layer?.length ?? 0); i += 4) if (layer![i] > 0) ink++;
  return ink;
}

describe('line style modules and Auto Run Scripts', () => {
  beforeEach(() => {
    delete (globalThis as G).__styleModuleRan;
    prefs.autoexec_paths = [];
  });

  it('does not run a project\'s style module with Auto Run Scripts off, and still draws lines', async () => {
    prefs.use_scripts_auto_execute = false;
    projectWithModule();
    const ink = await render();
    expect((globalThis as G).__styleModuleRan).toBeUndefined();
    // the built-in line sets draw instead
    expect(ink).toBeGreaterThan(0);
    const warn = app.reports.filter((r) => r.type === 'WARNING' && /line style module\(s\) not run.*Auto Run Scripts is off/.test(r.message));
    expect(warn).toHaveLength(1);
    // an animation does not repeat the report every frame
    await render();
    expect(app.reports.filter((r) => /line style module/.test(r.message))).toHaveLength(1);
  });

  it('runs it with Auto Run Scripts on, but not for a file in the excluded paths', async () => {
    prefs.use_scripts_auto_execute = true;
    projectWithModule();
    expect(await render()).toBeGreaterThan(0);
    expect((globalThis as G).__styleModuleRan).toBe(1);
    app.filename = 'downloads_scene.p3d';
    prefs.autoexec_paths = ['downloads_*'];
    await render();
    expect((globalThis as G).__styleModuleRan).toBe(1);
    expect(app.reports.at(-1)?.message).toMatch(/matches the excluded path "downloads_\*"/);
  });
});
