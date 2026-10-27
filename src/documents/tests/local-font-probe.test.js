import { afterEach, it, expect, vi } from 'vitest';

// Chrome on macOS can block a thread inside FontFace.load() for the local() name of an on-demand
// system font. The page's own thread must never be the one that asks first.
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function environment({ installed = [], stuck = [], workers = true } = {}) {
  vi.resetModules(); vi.useFakeTimers();
  const pageLoads = [], started = [], terminated = [];
  const name = source => /local\("([^"]+)"\)/.exec(source)?.[1];
  vi.stubGlobal('FontFace', class {
    constructor(family, source) { this.source = source; }
    load() { pageLoads.push(name(this.source)); return stuck.includes(name(this.source)) ? new Promise(() => {}) : installed.includes(name(this.source)) ? Promise.resolve(this) : Promise.reject(new Error('absent')); }
  });
  if (workers) vi.stubGlobal('Worker', class {
    constructor() { started.push(this); queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
    postMessage({ id, source }) {
      if (stuck.includes(name(source))) return; // The lookup never returns.
      queueMicrotask(() => this.onmessage?.({ data: { id, found: installed.includes(name(source)) } }));
    }
    terminate() { terminated.push(this); }
  });
  return { ...await import('../src/engine/local-font-probe.js'), pageLoads, started, terminated };
}
const settle = promise => promise.then(face => ({ face }), error => ({ error: error.message }));

it('asks a worker first and loads only installed faces on the page', async () => {
  const env = await environment({ installed: ['Arial'] });
  const [arial, missing] = await Promise.all([settle(env.loadLocalFace('Arial', 'local("Arial")')), settle(env.loadLocalFace('Missing', 'local("Missing")'))]);
  expect(arial.face.source).toBe('local("Arial")');
  expect(missing.error).toBe('The font is not installed.');
  expect(env.pageLoads).toEqual(['Arial']);
  // Answers are kept: asking again needs no worker.
  await env.loadLocalFace('Arial', 'local("Arial")');
  expect(env.started.length).toBeLessThanOrEqual(2);
});

it('gives up on a name whose lookup never returns without ever asking for it on the page', async () => {
  const env = await environment({ installed: ['Arial'], stuck: ['NanumGothic', 'Unknown'] });
  const nanum = settle(env.loadLocalFace('NanumGothic', 'local("NanumGothic")'));
  await vi.advanceTimersByTimeAsync(env.LOCAL_FONT_DEADLINE_MS);
  expect((await nanum).error).toBe('The font is not installed.');
  expect(env.terminated).toHaveLength(1);
  // While lookups are stuck other missing names stall too; installed ones still answer at once.
  const unknown = settle(env.loadLocalFace('Unknown', 'local("Unknown")')), arial = settle(env.loadLocalFace('Arial', 'local("Arial")'));
  await vi.advanceTimersByTimeAsync(300);
  expect((await unknown).error).toBe('The font is not installed.');
  expect((await arial).face).toBeTruthy();
  expect(env.pageLoads).toEqual(['Arial']);
});

it('bounds a direct load when no worker can ask', async () => {
  const env = await environment({ installed: ['Arial'], stuck: ['Slow'], workers: false });
  expect((await settle(env.loadLocalFace('Arial', 'local("Arial")'))).face).toBeTruthy();
  const slow = settle(env.loadLocalFace('Slow', 'local("Slow")'));
  await vi.advanceTimersByTimeAsync(env.LOCAL_FONT_DEADLINE_MS);
  expect((await slow).error).toBe('The installed font did not load in time.');
});

it('opens a document font whose lookup never returns as an available CSS family, without waiting forever', async () => {
  const env = await environment({ stuck: ['NanumGothic'] });
  // The family still renders through the browser's ordinary font matching.
  const fonts = new Set();
  vi.stubGlobal('document', { baseURI: 'https://documents.test/', fonts, createElement: () => ({ getContext: () => ({ font: '', measureText() { return { width: this.font.includes('"NanumGothic"') ? 101 : 100, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 }; } }) }) });
  const { checkFontAvailability, fontAvailable } = await import('../src/engine/font-availability.js');
  let done = false;
  checkFontAvailability('NanumGothic').then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(env.LOCAL_FONT_DEADLINE_MS);
  expect(done).toBe(true);
  expect(fontAvailable('NanumGothic')).toBe(true);
  expect(env.pageLoads).toEqual([]);
});
