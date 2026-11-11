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
