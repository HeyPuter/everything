import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Video Editing workspace; `imp` imports app modules (the instances the app uses). */
async function videoWorkspace(page: Page) {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100000));
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    (window as any).imp = (p: string) => import(U(p));
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
  });
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
  await expectNoErrors(errors);
});
