// Main-thread stalls of everyday actions on a 24-megapixel document
// (docs/performance.md, "Large images"). Opens a generated 6000 x 4000 JPEG
// through the file input, then for each scenario prints the longest
// main-thread task, the sum of tasks over 50 ms, wall time and JS heap growth
// (median of the runs; each run's longest task / wall time in brackets).
// Usage (a dev server or preview of this app on the port):
//   node scripts/perf-large-image.mjs [port=5783] [gpu|soft] [scenarios] [profile=0|1] [runs=3]
// gpu: Chrome with the real GPU (ANGLE Metal on macOS); soft: SwiftShader, as
// in the browser tests. Scenarios (comma-separated, in order): dialog (Edit with
// Prompt), imagesize, viacopy, dup, paste (after copy), copy, select,
// visibility, opacity, blend, undo, setup2 (adds a second full layer), deep
// (switches to 16 bits). profile=1 prints the top functions of the last run.
// The "open" line includes Playwright passing the 24 MP file into the page
// (about 200 ms of its own script); profile=1 separates it.
import { chromium } from '@playwright/test';

setTimeout(() => {
  console.error('watchdog');
  process.exit(2);
}, 600_000).unref();

const port = process.argv[2] ?? '5783';
const mode = process.argv[3] ?? 'gpu';
const scenarios = (process.argv[4] ?? 'dialog').split(',');
const profile = process.argv[5] === '1';
const reps = Number(process.argv[6] ?? 3);
const W = 6000,
  H = 4000;

const args =
  mode === 'gpu'
    ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
page.on('pageerror', (err) => console.error('pageerror', err.message));
await page.route('https://js.puter.com/**', (r) =>
  r.fulfill({
    contentType: 'application/javascript',
    body: 'window.puter={env:"app",auth:{isSignedIn:()=>true}};',
  }),
);
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 120000 });
const engine = await page.locator('#engine-status').textContent();
const gpuInfo = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const ext = c?.getExtension('WEBGL_debug_renderer_info');
  return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a';
});
console.log(`engine ${engine}; GPU ${gpuInfo}; mode ${mode}`);

await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
  }).observe({ type: 'longtask', buffered: false });
});

const idle = async (dialog = false) => {
  if (!dialog)
    await page.waitForFunction(
      () => !window.photoStudio.busy && !window.photoStudio.toolBusy,
      null,
      { timeout: 120000 },
    );
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.photoStudio.renderer.settle();
    await new Promise((r) => setTimeout(r, 50));
  });
};

// A 24 MP JPEG with photo-like content (gradients + noise).
let jpeg;
{
  const b64 = await page.evaluate(
    async ({ W, H }) => {
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      const img = g.createImageData(W, H);
      const d = img.data;
      let s = 1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          const n = (s >> 16) & 31;
          const i = (y * W + x) * 4;
          d[i] = ((x * 255) / W + n) | 0;
          d[i + 1] = ((y * 255) / H + n) | 0;
          d[i + 2] = (128 + 100 * Math.sin(x / 300) * Math.cos(y / 200) + n) | 0;
          d[i + 3] = 255;
        }
      g.putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { W, H },
  );
  jpeg = Buffer.from(b64, 'base64');
}

const cdp = await context.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

function topFunctions(prof, n = 25) {
  const self = new Map();
  const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]));
  const counts = new Map();
  for (const id of prof.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  const dt = (prof.endTime - prof.startTime) / 1000 / Math.max(1, prof.samples.length);
  for (const [id, c] of counts) {
    const nd = byId.get(id);
    const f = nd.callFrame;
    if (f.functionName === '(idle)' || f.functionName === '(program)') continue;
    const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + c * dt);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
// Inclusive time per function (for finding callers).
function inclusive(prof, n = 40) {
  const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]));
  const parent = new Map();
  for (const nd of prof.nodes) for (const c of nd.children ?? []) parent.set(c, nd.id);
  const dt = (prof.endTime - prof.startTime) / 1000 / Math.max(1, prof.samples.length);
  const incl = new Map();
  for (const id of prof.samples) {
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = byId.get(cur).callFrame;
      if (
        f.functionName === '(idle)' ||
        f.functionName === '(program)' ||
        f.functionName === '(root)'
      )
        continue;
      const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + dt);
    }
  }
  return [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function measure(name, action, after, dialog = false) {
  const results = [];
  for (let r = 0; r < reps; r++) {
    await idle();
    await page.evaluate(() => (window.__lt = []));
    if (profile && r === reps - 1) await cdp.send('Profiler.start');
    const mem0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    const t0 = await page.evaluate(() => performance.now());
    await action();
    await idle(dialog);
    const t1 = await page.evaluate(() => performance.now());
    let prof;
    if (profile && r === reps - 1) prof = (await cdp.send('Profiler.stop')).profile;
    const lt = await page.evaluate(() => window.__lt);
    const mem1 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    const longest = lt.reduce((m, x) => Math.max(m, x.dur), 0);
    const sum = lt.reduce((m, x) => m + x.dur, 0);
    results.push({ wall: t1 - t0 - 50, longest, sum, n: lt.length, heapMB: (mem1 - mem0) / 1e6 });
    if (prof) {
      console.log(`  -- ${name} self time (ms):`);
      for (const [k, v] of topFunctions(prof))
        console.log(`     ${v.toFixed(1).padStart(7)}  ${k}`);
      console.log(`  -- ${name} inclusive (ms):`);
      for (const [k, v] of inclusive(prof)) console.log(`     ${v.toFixed(1).padStart(7)}  ${k}`);
    }
    if (after) await after();
  }
  const med = (k) => {
    const v = results.map((x) => x[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  console.log(
    `${name.padEnd(28)} longest task ${med('longest').toFixed(0).padStart(5)} ms | tasks>50ms sum ${med('sum').toFixed(0).padStart(5)} ms (${med('n')}) | wall ${med('wall').toFixed(0).padStart(5)} ms | heap Δ ${med('heapMB').toFixed(0)} MB  [${results.map((x) => x.longest.toFixed(0) + '/' + x.wall.toFixed(0)).join(',')}]`,
  );
}

const run = (id, arg) =>
  page.evaluate(({ id, arg }) => window.photoStudio.runCommand(id, arg), { id, arg });
const start = (id, arg) =>
  page.evaluate(({ id, arg }) => void window.photoStudio.runCommand(id, arg), { id, arg });
const closeDialogs = async () => {
  for (let i = 0; i < 5; i++) {
    const open = await page.evaluate(() =>
      [...document.querySelectorAll('dialog')].some((d) => d.open),
    );
    if (!open) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
};
const openFile = async () => {
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'photo24.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await page.waitForFunction(
    () => window.photoStudio.hasDocument && window.photoStudio.doc.width === 6000,
    null,
    { timeout: 120000 },
  );
};
const layerCount = () => page.evaluate(() => window.photoStudio.doc.layers.length);

// Open the document first (measured once as "open").
{
  await page.evaluate(() => (window.__lt = []));
  if (profile && scenarios.includes('open')) await cdp.send('Profiler.start');
  const t0 = await page.evaluate(() => performance.now());
  await openFile();
  await idle();
  const t1 = await page.evaluate(() => performance.now());
  const lt = await page.evaluate(() => window.__lt);
  console.log(
    `${'open 24 MP JPEG'.padEnd(28)} longest task ${lt
      .reduce((m, x) => Math.max(m, x.dur), 0)
      .toFixed(0)
      .padStart(
        5,
      )} ms | tasks sum ${lt.reduce((m, x) => m + x.dur, 0).toFixed(0)} ms | wall ${(t1 - t0).toFixed(0)} ms`,
  );
  if (profile && scenarios.includes('open')) {
    const prof = (await cdp.send('Profiler.stop')).profile;
    for (const [k, v] of topFunctions(prof)) console.log(`     ${v.toFixed(1).padStart(7)}  ${k}`);
    console.log('  -- inclusive');
    for (const [k, v] of inclusive(prof)) console.log(`     ${v.toFixed(1).padStart(7)}  ${k}`);
  }
}
const kind = await page.evaluate(() =>
  window.photoStudio.doc.layers.map((l) => l.kind + ':' + l.name).join(','),
);
console.log('layers:', kind);

for (const s of scenarios) {
  if (s === 'dialog')
    await measure(
      'open Edit with Prompt',
      async () => {
        await start('edit.edit-with-prompt');
        await page.waitForFunction(() =>
          [...document.querySelectorAll('dialog')].some((d) => d.open),
        );
      },
      closeDialogs,
      true,
    );
  if (s === 'imagesize')
    await measure(
      'open Image Size',
      async () => {
        await start('image.image-size');
        await page.waitForFunction(() =>
          [...document.querySelectorAll('dialog')].some((d) => d.open),
        );
      },
      closeDialogs,
      true,
    );
  if (s === 'viacopy')
    await measure(
      'Layer via Copy',
      async () => {
        const n = await layerCount();
        await run('layer.via-copy');
        await page.waitForFunction((n) => window.photoStudio.doc.layers.length > n, n);
      },
      () => run('edit.undo'),
    );
  if (s === 'paste')
    await measure(
      'Paste 24 MP',
      async () => {
        const n = await layerCount();
        await run('edit.paste');
        await page.waitForFunction((n) => window.photoStudio.doc.layers.length > n, n);
      },
      () => run('edit.undo'),
    );
  if (s === 'select')
    await measure('select other layer', async () => {
      await page.evaluate(() => {
        const e = window.photoStudio;
        const other = e.doc.layers.find((l) => l.id !== e.selected);
        e.selectLayers([other.id]);
      });
    });
  if (s === 'visibility')
    await measure('toggle visibility', async () => {
      await page.evaluate(() =>
        window.photoStudio.editLayer('Hide', (l) => (l.visible = !l.visible)),
      );
    });
  if (s === 'opacity')
    await measure('change opacity', async () => {
      await page.evaluate(() => {
        const e = window.photoStudio;
        e.editLayer('Opacity', (l) => (l.opacity = l.opacity === 1 ? 0.5 : 1));
      });
    });
  if (s === 'blend')
    await measure('change blend mode', async () => {
      await page.evaluate(() => {
        const e = window.photoStudio;
        e.editLayer(
          'Blend',
          (l) => (l.blendMode = l.blendMode === 'multiply' ? 'normal' : 'multiply'),
        );
      });
    });
  if (s === 'undo')
    await measure('undo + redo', async () => {
      await run('edit.undo');
      await idle();
      await run('edit.redo');
    });
  if (s === 'dup')
    await measure(
      'duplicate layer',
      async () => {
        const n = await layerCount();
        await run('layer.duplicate');
        await page.waitForFunction((n) => window.photoStudio.doc.layers.length > n, n);
      },
      () => run('edit.undo'),
    );
  if (s === 'setup2') {
    // Make a second full-size layer for select/visibility tests.
    await run('layer.via-copy');
    await idle();
  }
  if (s === 'deep') {
    await page.evaluate(() =>
      window.photoStudio.command('Deep', (d) => void (d.bitsPerChannel = 16)),
    );
    await idle();
  }
  if (s === 'copy') {
    await run('select.all');
    await run('edit.copy');
    await run('select.deselect');
    await idle();
  }
}
await browser.close();
