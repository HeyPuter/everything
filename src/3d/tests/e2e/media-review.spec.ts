import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A workspace (Video Editing by default); `imp` imports app modules (the instances the app uses). */
async function videoWorkspace(page: Page, name = 'Video Editing') {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100000));
  const errors = await openApp(page);
  await page.evaluate(async (name) => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    (window as any).imp = (p: string) => import(U(p));
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === name).create());
  }, name);
  await page.waitForTimeout(300);
  return errors;
}

test('sequencer: stopping playback silences an echo modifier at once', async ({ page }) => {
  const errors = await videoWorkspace(page);
  // tap the output: everything that reaches the speakers goes through an analyser
  await page.evaluate(() => {
    const w = window as any;
    const orig = AudioNode.prototype.connect as any;
    const taps = new Map<BaseAudioContext, AnalyserNode>();
    (AudioNode.prototype as any).connect = function (this: AudioNode, t: any, ...rest: any[]) {
      if (t instanceof AudioDestinationNode) {
        let a = taps.get(this.context);
        if (!a) {
          a = this.context.createAnalyser();
          orig.call(a, t);
          taps.set(this.context, a);
          w.tap = a;
        }
        return orig.call(this, a, ...rest);
      }
      return orig.call(this, t, ...rest);
    };
    w.rms = () => {
      const a = w.tap as AnalyserNode | undefined;
      if (!a) return 0;
      const d = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      return Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
    };
  });
  const playing = await page.evaluate(async () => {
    const w = window as any;
    const wav = await w.imp('/src/sequencer/wav.ts');
    const add = await w.imp('/src/sequencer/add.ts');
    const rate = 48000;
    const ch = new Float32Array(rate * 4);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    const [s] = await add.addSound(new File([wav.encodeWav([ch], rate)], 'tone.wav', { type: 'audio/wav' }), 1, 1);
    w.app.run('sequencer.strip_modifier_add', { type: 'ECHO' });
    Object.assign(s.modifiers[0], { feedback: 0.9, delay: 0.3 });
    w.app.changed('doc');
    w.app.setFrame(1);
    w.app.run('screen.animation_play');
    await new Promise((r) => setTimeout(r, 1200));
    return w.rms();
  });
  // headless runs without an audio clock cannot hear anything either way
  test.skip(playing < 0.01, 'no audio output in this browser');
  await page.evaluate(() => (window as any).app.run('screen.animation_play'));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).rms())).toBeLessThan(0.001);
  await expectNoErrors(errors);
});

test('sequencer: dragging the Channel field resolves overlaps only where the drag ends', async ({ page }) => {
  const errors = await videoWorkspace(page);
  await page.evaluate(async () => {
    const w = window as any;
    const S = await w.imp('/src/sequencer/strips.ts');
    w.app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 20 }, { invoke: false });
    const ed = w.app.doc.scene.sequence_editor;
    ed.strips[0].name = 'A';
    ed.active_strip = 'A';
    for (const [name, ch] of [['B', 2], ['C', 3]] as const) {
      const s = S.newStrip('COLOR', name, ch, 5, 20);
      s.select = false;
      ed.strips.push(s);
    }
    w.app.pushUndo('Setup');
    w.app.changed('doc');
  });
  const tl = page.locator('.seq-main').last();
  await tl.hover();
  await page.keyboard.press('n');
  await page.locator('.sb-tab', { hasText: /^Strip$/ }).last().click();
  const field = page.locator('.num-field[data-id^="seq-ch-"]').first();
  await field.scrollIntoViewIfNeeded();
  const b = (await field.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  // slowly, so the value passes channels 2 and 3 (occupied) on the way
  for (let i = 1; i <= 24; i++) await page.mouse.move(b.x + b.width / 2 + i, b.y + b.height / 2);
  await page.mouse.up();
  const a = await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((s: any) => s.name === 'A'));
  expect(a.channel).toBeGreaterThan(4);
  // the strip kept its time (passing the occupied channels used to shuffle it to frame -15)
  expect(a.frame_start).toBe(1);
  // a locked strip's channel cannot be changed either
  await page.locator('.seq-sb-head').first().scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const w = window as any;
    w.app.doc.scene.sequence_editor.strips.find((s: any) => s.name === 'A').lock = true;
    w.app.changed('doc');
  });
  await expect(page.locator('.num-field[data-id^="seq-ch-"]').first()).toHaveClass(/disabled/);
  await expectNoErrors(errors);
});

test('clip editor: footage the browser cannot open is reported once, not reopened on every redraw', async ({ page }) => {
  await videoWorkspace(page, 'Motion Tracking');
  const urls = await page.evaluate(async () => {
    const w = window as any;
    let n = 0;
    const create = URL.createObjectURL;
    URL.createObjectURL = (o: Blob | MediaSource) => (n++, create(o));
    const T = await w.imp('/src/tracking/types.ts');
    const E = await w.imp('/src/tracking/editor.ts');
    const c = T.newMovieClip('MCbad', 'bad.mp4', { filepath: 'bad.mp4', movie: { mime: 'video/mp4', bytes: new Uint8Array(4096).fill(7) }, size: [640, 360], frame_duration: 50 });
    T.clipTable(w.app.doc)[c.id] = c;
    w.app.doc.scene.active_clip = c.id;
    E.currentClipEditor().setClip(c.id);
    for (let i = 0; i < 8; i++) {
      w.app.setFrame(1 + i);
      w.app.changed('doc');
      await new Promise((r) => setTimeout(r, 250));
    }
    URL.createObjectURL = create;
    return n;
  });
  expect(urls).toBeLessThanOrEqual(1);
  // the editor knows why there is no picture (and says so instead of "Loading…")
  const err = await page.evaluate(async () => {
    const w = window as any;
    const S = await w.imp('/src/tracking/source.ts');
    return S.sourceError(w.app.doc.movieclips.MCbad);
  });
  expect(err).toBeTruthy();
});

test('sequencer: a mask modifier using an effect of its own strip renders (no endless recursion)', async ({ page }) => {
  const errors = await videoWorkspace(page);
  const warnings: string[] = [];
  page.on('console', (m) => m.type() === 'warning' && /strip failed/.test(m.text()) && warnings.push(m.text()));
  await page.evaluate(async () => {
    const w = window as any;
    const app = w.app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 20 }, { invoke: false });
    const ed = app.doc.scene.sequence_editor;
    const color = ed.strips[0];
    app.run('sequencer.effect_strip_add', { type: 'GAUSSIAN_BLUR', frame_start: 1, channel: 2, length: 20 }, { invoke: false });
    const blur = ed.strips.find((s: any) => s.type === 'GAUSSIAN_BLUR');
    ed.active_strip = color.name;
    app.run('sequencer.strip_modifier_add', { type: 'MASK' });
    Object.assign(color.modifiers[0], { input_mask_type: 'STRIP', input_mask_strip: blur.name });
    app.setFrame(5);
    app.changed('doc');
    // let the preview render the frame
    await new Promise((r) => setTimeout(r, 1500));
  });
  expect(warnings).toEqual([]);
  await expectNoErrors(errors);
});
