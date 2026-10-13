// Smoke test of the whole command, tool and panel surface. Every registered
// command runs (dialogs it opens are cancelled, pickers and downloads are
// intercepted), every tool is activated, dragged and dismissed, and every panel
// is shown and updated after an edit, once in an empty workspace and once with
// a document containing every common layer kind. Any page error, unhandled
// rejection, console error, stuck busy state or broken undo fails the test.
import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, selectRect } from './helpers';

// Puter pickers never settle when the user cancels them; the stub does the same.
const puterStub = `window.puter={env:"app",auth:{isSignedIn:()=>true,getUser:async()=>({username:"smoke"})},
ui:{showOpenFilePicker:()=>new Promise(()=>{}),showSaveFilePicker:()=>new Promise(()=>{}),showDirectoryPicker:()=>new Promise(()=>{})},
fs:{write:()=>new Promise(()=>{}),read:()=>new Promise(()=>{})},ai:{}};`;

type Failure = { what: string; problem: string };
// SMOKE_VERBOSE=1 prints failures as they happen and items slower than a second.
const verbose = !!process.env.SMOKE_VERBOSE;
// SMOKE_ONLY=<regex> limits the commands and SMOKE_PARTS=commands,tools,panels the phases (for debugging).
const parts = (process.env.SMOKE_PARTS ?? 'commands,tools,panels').split(',');

class Smoke {
  errors: string[] = [];
  failures: Failure[] = [];
  constructor(public page: Page) {
    page.on('pageerror', (err) => {
      this.errors.push(`page error: ${err.message}`);
      if (verbose) console.log(err.stack);
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      this.errors.push(`console error: ${msg.text()}`);
      if (verbose) void msg.args()[0]?.evaluate((x) => (x instanceof Error ? x.stack : '')).then((stack) => stack && console.log(stack)).catch(() => {});
    });
    // Downloads, native file choosers and popups are dismissed as a user would.
    page.on('download', (d) => void d.cancel().catch(() => {}));
    // A dismissed file chooser fires "cancel" on its input, as browsers do.
    page.on('filechooser', (chooser) => void chooser.element().dispatchEvent('cancel').catch(() => {}));
    page.on('popup', (p) => void p.close().catch(() => {}));
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  }
  async boot() {
    await this.page.addInitScript(() => {
      // The system print dialog and native file pickers would block a headless run.
      window.print = () => {};
      const abort = () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
      Object.assign(window, { showOpenFilePicker: abort, showSaveFilePicker: abort, showDirectoryPicker: abort });
      window.open = () => null;
    });
    await boot(this.page, 'default', puterStub);
  }
  /** Record errors raised since the last check against `what`. */
  check(what: string) {
    for (const problem of this.errors.splice(0)) this.fail(what, problem);
  }
  fail(what: string, problem: string) {
    this.failures.push({ what, problem });
    if (verbose) console.log(`FAIL ${what}: ${problem}`);
  }
  /** Close every dialog, popover and menu a command or tool left open. */
  async dismiss(what: string) {
    const page = this.page;
    for (let round = 0; round < 6; round++) {
      const open = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
        const pops = document.querySelectorAll('.context-menu,.tool-flyout,.menubar-entry.open,[popover]:popover-open,.popover:not([hidden])');
        return { dialogs: dialogs.length, pops: pops.length };
      });
      if (!open.dialogs && !open.pops) return;
      if (round < 3) {
        await page.keyboard.press('Escape');
      } else {
        // Escape did not close it: try its Cancel or Close button.
        const clicked = await page.evaluate(() => {
          const d = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
          const b = d && [...d.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^(cancel|close|done|ok)$/i.test(b.textContent!.trim()) || /^close/i.test(b.getAttribute('aria-label') ?? ''));
          b?.click();
          return !!b;
        });
        if (!clicked || round === 5) {
          this.fail(what, `left ${open.dialogs} dialog(s) and ${open.pops} popover(s) open that Escape does not close`);
          await page.evaluate(() => {
            document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((d) => d.close());
            document.querySelectorAll('.context-menu,.tool-flyout').forEach((p) => p.remove());
          });
          return;
        }
      }
      await page.waitForTimeout(30);
    }
  }
  /** Wait until the command finished; a stuck busy flag is a failure. */
  async settle(what: string, timeout = 20_000) {
    const page = this.page;
    try {
      await page.waitForFunction(() => !window.photoStudio.busy && !window.photoStudio.toolBusy, null, { timeout });
    } catch {
      this.fail(what, 'workspace stayed busy after its dialogs were cancelled');
      await page.evaluate(() => {
        window.photoStudio.busy = false;
        window.photoStudio.toolBusy = false;
      });
    }
    try {
      await page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await Promise.race([window.photoStudio.renderer.settle(), new Promise((_, no) => setTimeout(() => no(new Error('render timeout')), 15_000))]);
      });
    } catch (error) {
      this.fail(what, `render did not complete: ${(error as Error).message}`);
    }
  }
}

/** A document with pixel, text, shape, embedded object, adjustment and group layers and a selection. */
async function buildDocument(s: Smoke) {
  const page = s.page;
  await openImage(page, 320, 240, '#6080a0', 'smoke.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    // An embedded object (a duplicate of the background converted in place).
    await e.runCommand('layer.duplicate');
    await e.runCommand('layer.embed-convert');
    await e.runCommand('layer.new-quick');
  });
  await idle(page);
  // Paint into the new pixel layer.
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await canvasDrag(page, [[30, 30], [120, 90], [200, 60]]);
  // A shape layer.
  await page.evaluate(() => window.photoStudio.setTool('rect-shape'));
  await canvasDrag(page, [[180, 120], [280, 200]]);
  // A text layer.
  await page.evaluate(() => window.photoStudio.setTool('type'));
  await canvasClick(page, 40, 200);
  await page.keyboard.type('Smoke');
  await page.keyboard.press('Escape');
  await idle(page);
  // Group the text and shape layers, then add an adjustment layer on top.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const top = e.doc.layers.slice(-2).map((l) => l.id);
    e.selectLayers(top);
    await e.runCommand('layer.group');
    await e.runCommand('layer.adj-invert');
    // Back to a pixel layer as the target, as most commands expect.
    const pixel = e.doc.layers.find((l) => l.kind === 'pixel' && l.name !== 'Background') ?? e.doc.layers[0];
    e.selectLayers([pixel.id]);
    e.setTool('move');
    e.update();
  });
  // Paths, guides, a layer style, a live filter, a layer comp, a slice and frame animation.
  await selectRect(page, { x: 40, y: 40, width: 160, height: 120 });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { allLayers } = await import('/src/model/document.ts');
    const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
    const { newLayerComp } = await import('/src/model/layer-comps.ts');
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const pixelId = e.selected;
    await e.runCommand('path.from-selection');
    const shape = allLayers(e.doc.layers).find((l) => l.kind === 'vector')!;
    // A layer mask with an edge on the embedded object (Refine Mask Edge).
    const reveal = new Uint8Array(320 * 240);
    for (let y = 30; y < 210; y++) reveal.fill(255, y * 320 + 40, y * 320 + 280);
    const maskGrid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: 320, height: 240, data: reveal });
    e.command('Smoke fixture', (d) => {
      d.paths = [{ id: 'smoke-path', name: 'Path 1', mask: structuredClone(d.workPath!) }];
      d.guides = [{ orientation: 'vertical', position: 100 }, { orientation: 'horizontal', position: 80 }];
      d.slices = [{ id: 'smoke-slice', rect: { x: 0, y: 0, width: 160, height: 120 } }];
      d.layerComps = [newLayerComp(d, 'Comp 1', { visibility: true, position: true, appearance: true })];
      const target = allLayers(d.layers).find((l) => l.id === shape.id)!;
      target.style = { enabled: true, dropShadow: [defaultDropShadow()] };
      allLayers(d.layers).find((l) => l.embed)!.maskGrid = maskGrid;
    });
    e.selectLayers([pixelId]);
    await e.runCommand('filter.convert-live');
    await e.runCommand('animation.create');
    await e.runCommand('animation.new-frame');
    e.selectLayers([pixelId]);
  });
  await idle(page);
  await selectRect(page, { x: 40, y: 40, width: 160, height: 120 });
  const kinds = await page.evaluate(async () => {
    const { allLayers } = await import('/src/model/document.ts');
    return allLayers(window.photoStudio.doc.layers).map((l) => (l.embed ? 'embedded' : l.kind));
  });
  for (const k of ['pixel', 'text', 'vector', 'embedded', 'adjustment', 'group']) expect(kinds).toContain(k);
  // Keep the project bytes so a command that closes the document can be followed by a reopen.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize } = await import('/src/model/serialization.ts');
    const w = window as unknown as Record<string, unknown>;
    w.__smokeProject = await serialize(e.doc, e.assets);
    w.__smokeSession = e.session;
    w.__smokeBase = e.doc;
    w.__smokeSelected = [...e.selectedIds];
  });
  s.check('building the test document');
}

/** Return to the test document at its original history state (reopening it when it was closed). */
async function restoreDocument(s: Smoke, withDocument: boolean) {
  await s.page.evaluate(async (withDocument) => {
    const e = window.photoStudio;
    const w = window as unknown as Record<string, unknown>;
    e.transform.cancel();
    e.modal?.cancel();
    // Leave Quick Mask and mask editing so later commands target the layer again.
    delete e.settings.quickMask;
    delete e.settings.quickMaskPreview;
    e.maskTarget = '';
    if (!withDocument) {
      // Close documents a command created and keep the empty workspace.
      for (const other of e.sessions.filter((x) => x.hasDocument)) await e.closeSession(other, true);
      return;
    }
    let s = w.__smokeSession as typeof e.session;
    const base = w.__smokeBase as typeof e.doc;
    // The original state, wherever it is in the history now (Purge resets the list).
    if (!e.sessions.includes(s) || !s.history.documents.includes(base)) {
      if (e.sessions.includes(s)) await e.closeSession(s, true);
      const { deserialize } = await import('/src/model/serialization.ts');
      const loaded = await deserialize(w.__smokeProject as Blob);
      s = e.sessionForOpen();
      s.assets = loaded.assets;
      s.history.reset(loaded.document);
      s.hasDocument = true;
      w.__smokeSession = s;
      w.__smokeBase = s.doc;
    }
    for (const other of e.sessions.filter((x) => x !== s)) await e.closeSession(other, true);
    if (e.session !== s) await e.switchSession(s);
    if (e.doc !== w.__smokeBase) e.history.goto(e.history.documents.indexOf(base, 1) - 1);
    e.selectLayers(w.__smokeSelected as string[]);
    // Selected timeline keyframes are view state of the session.
    if (w.__smokeKeys) (await import('/src/features/animation/video-state.ts')).videoView(e).keys = structuredClone(w.__smokeKeys as never);
    e.update();
  }, withDocument);
}

/** Tiles referenced by a reachable document state but gone from the store. */
async function missingTiles(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const { documentTileIds } = await import('/src/model/pixel-layer.ts');
    for (const [i, d] of e.history.documents.entries()) {
      const gone = [...documentTileIds(d)].filter((id) => !e.assets.tiles.has(id));
      if (gone.length) return `${gone.length} tile(s) of ${i ? `history state ${i}` : 'the current document'} missing from the store`;
    }
    return '';
  });
}

/** Run the commands enabled in the current context; returns the ones that were disabled. */
async function smokeCommands(s: Smoke, withDocument: boolean, ids: string[], context: string) {
  const page = s.page;
  const disabled: string[] = [];
  for (const id of ids) {
    const what = `command ${id} (${context})`;
    const t0 = Date.now();
    const state = await page.evaluate(async (id) => {
      const e = window.photoStudio;
      const c = (await import('/src/app/registry.ts')).commands.get(id);
      if (!c) return { gone: true };
      let enabled = true;
      try {
        enabled = c.enabled ? c.enabled(e) : true;
        if (c.checked) c.checked(e);
      } catch (error) {
        return { threw: String(error) };
      }
      const w = window as unknown as Record<string, unknown>;
      w.__before = { doc: e.doc, session: e.session, position: e.history.position };
      if (enabled) void e.runCommand(id);
      return { enabled };
    }, id);
    if (state.gone) continue;
    if (state.threw) {
      s.fail(what, `enabled/checked threw ${state.threw}`);
      continue;
    }
    if (!state.enabled) {
      s.check(what);
      disabled.push(id);
      continue;
    }
    await page.waitForFunction(() => !window.photoStudio.busy || !!document.querySelector('dialog[open]'), null, { timeout: 20_000 }).catch(() => {});
    await s.dismiss(what);
    await s.settle(what);
    // A further Escape ends tool sessions and modal edits the command started.
    await page.locator('#viewport').focus().catch(() => {});
    await page.keyboard.press('Escape');
    await s.dismiss(what);
    await s.settle(what);
    // Undo reverts a document edit made by the command.
    const undo = await page.evaluate(async () => {
      const e = window.photoStudio;
      const before = (window as unknown as { __before: { doc: unknown; session: unknown; position: number } }).__before;
      if (e.session !== before.session || e.history.position <= before.position) return 'none';
      const at = e.history.position;
      await e.runCommand('edit.undo');
      return e.history.position === at - 1 ? 'ok' : `history stayed at ${e.history.position}`;
    });
    if (undo !== 'none' && undo !== 'ok') s.fail(what, `undo failed: ${undo}`);
    await s.settle(what);
    const missing = await missingTiles(page);
    if (missing) s.fail(what, missing);
    s.check(what);
    await restoreDocument(s, withDocument);
    await s.settle(`restoring after ${what}`);
    s.check(`restoring after ${what}`);
    if (verbose && Date.now() - t0 > 1000) console.log(`SLOW ${what}: ${Date.now() - t0} ms`);
  }
  return disabled;
}

async function smokeTools(s: Smoke, withDocument: boolean) {
  const page = s.page;
  // Session tools (transform, warps) belong to their commands, which run above.
  const ids = await page.evaluate(async () => {
    const { toolGroups } = await import('/src/app/toolbar.ts');
    return [...(await import('/src/app/registry.ts')).tools.values()].filter((t) => toolGroups.includes(t.group)).map((t) => t.id);
  });
  for (const id of ids) {
    const what = `tool ${id}${withDocument ? '' : ' (empty workspace)'}`;
    const t0 = Date.now();
    await page.evaluate((id) => window.photoStudio.setTool(id), id);
    if ((await page.evaluate(() => window.photoStudio.tool)) !== id) s.fail(what, 'could not be activated');
    await s.settle(what);
    await canvasDrag(page, [[60, 60], [100, 80], [150, 110]]).catch((error) => s.fail(what, `drag failed: ${error}`));
    await s.dismiss(what);
    await s.settle(what);
    await page.locator('#viewport').focus().catch(() => {});
    await page.keyboard.press('Escape');
    await s.dismiss(what);
    await s.settle(what);
    s.check(what);
    await page.evaluate(() => window.photoStudio.setTool('move'));
    await restoreDocument(s, withDocument);
    await page.evaluate(() => window.photoStudio.fit());
    await s.settle(what);
    s.check(`${what}, deactivating`);
    if (verbose && Date.now() - t0 > 2000) console.log(`SLOW ${what}: ${Date.now() - t0} ms`);
  }
}

async function smokePanels(s: Smoke, withDocument: boolean) {
  const page = s.page;
  const ids = await page.evaluate(async () => [...(await import('/src/app/registry.ts')).panels.keys()]);
  for (const id of ids) {
    const what = `panel ${id}${withDocument ? '' : ' (empty workspace)'}`;
    const mounted = await page.evaluate((id) => {
      const e = window.photoStudio;
      e.dock.show(id);
      return !!document.querySelector(`[data-panel="${id}"]`)?.isConnected;
    }, id);
    if (!mounted) s.fail(what, 'did not mount when shown');
    await s.settle(what);
    // An edit refreshes visible panels; undo refreshes them again.
    if (withDocument) {
      await page.evaluate(async () => {
        const e = window.photoStudio;
        await e.runCommand('layer.new-quick');
        await e.runCommand('edit.undo');
      });
    } else await page.evaluate(() => window.photoStudio.update());
    await s.settle(what);
    s.check(what);
  }
}

/** Convert the test document's frame animation to a video timeline with a
 * video layer from a small generated WebM (painted on one frame, opacity
 * keyframed, a keyframe selected, a work area set) and keep it as the base state. */
async function videoContext(s: Smoke) {
  await restoreDocument(s, true);
  await s.page.evaluate(async () => {
    const e = window.photoStudio;
    const w = window as unknown as Record<string, unknown>;
    await e.runCommand('timeline.convert-to-video');
    const { muxWebm } = await import('/src/imaging/codecs/webm.ts');
    const chunks: { data: Uint8Array; timestampMs: number; key: boolean }[] = [];
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, timestampMs: chunk.timestamp / 1000, key: chunk.type === 'key' });
      },
      error: () => {},
    });
    encoder.configure({ codec: 'vp8', width: 32, height: 32, bitrate: 200_000, framerate: 10 });
    for (let k = 0; k < 4; k++) {
      const frame = new VideoFrame(new Uint8ClampedArray(32 * 32 * 4).fill(60 * k + 20), { format: 'RGBA', codedWidth: 32, codedHeight: 32, timestamp: k * 100_000, duration: 100_000 });
      encoder.encode(frame, { keyFrame: k === 0 });
      frame.close();
    }
    await encoder.flush();
    await e.runCommand('layer.video-new-file', new File([muxWebm(chunks, { width: 32, height: 32, codec: 'V_VP8', frameRate: 10 })], 'smoke.webm', { type: 'video/webm' }));
    const { writeRect } = await import('/src/model/tiles.ts');
    const id = e.selected;
    const data = new Uint8ClampedArray(16 * 16 * 4).fill(200);
    e.command('Smoke paint', (d) => {
      const l = d.layers.find((x) => x.id === id)!;
      l.pixels = writeRect(e.assets.tiles, l.pixels!, 10, 10, { width: 16, height: 16, data });
    });
    await e.runCommand('timeline.animate-opacity');
    await e.runCommand('timeline.work-end');
    const { videoView } = await import('/src/features/animation/video-state.ts');
    videoView(e).keys = [{ id, prop: 'opacity', t: 0 }];
    w.__smokeKeys = videoView(e).keys;
    const { serialize } = await import('/src/model/serialization.ts');
    w.__smokeProject = await serialize(e.doc, e.assets);
    w.__smokeSession = e.session;
    w.__smokeBase = e.doc;
    w.__smokeSelected = [id];
  });
  await idle(s.page);
  s.check('building the video timeline state');
}

const contexts = ['pixel layer', 'text layer', 'shape layer', 'embedded object', 'adjustment layer', 'group', 'several layers'];
/** Select the layers a context names as the target for the next commands. */
async function selectContext(s: Smoke, context: string) {
  await s.page.evaluate(async (context) => {
    const e = window.photoStudio;
    const w = window as unknown as Record<string, unknown>;
    const { allLayers } = await import('/src/model/document.ts');
    const layers = allLayers(e.doc.layers);
    const pick: Record<string, (l: (typeof layers)[number]) => boolean> = {
      'pixel layer': (l) => l.kind === 'pixel' && l.name !== 'Background',
      'text layer': (l) => l.kind === 'text',
      'shape layer': (l) => l.kind === 'vector',
      'embedded object': (l) => !!l.embed,
      'adjustment layer': (l) => l.kind === 'adjustment',
      group: (l) => l.kind === 'group',
    };
    const ids = context === 'several layers' ? e.doc.layers.map((l) => l.id) : [layers.find(pick[context])!.id];
    w.__smokeSelected = ids;
    e.selectLayers(ids);
    e.update();
  }, context);
}

for (const withDocument of [false, true]) {
  test(`every command, tool and panel runs cleanly ${withDocument ? 'with a document' : 'in an empty workspace'}`, async ({ page, context }) => {
    test.setTimeout(Number(process.env.SMOKE_TIMEOUT) || (withDocument ? 300_000 : 180_000));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const s = new Smoke(page);
    await s.boot();
    s.check('startup');
    if (withDocument) await buildDocument(s);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__smokeSession = window.photoStudio.session;
      w.__smokeBase = window.photoStudio.doc;
      w.__smokeSelected = [...window.photoStudio.selectedIds];
    });
    const t0 = Date.now();
    const only = new RegExp(process.env.SMOKE_ONLY ?? '');
    const all = (await page.evaluate(async () => [...(await import('/src/app/registry.ts')).commands.keys()])).filter((id) => only.test(id));
    let rest = all;
    if (parts.includes('commands')) {
      // Commands disabled for the pixel layer get another chance with each other kind of target.
      for (const context of withDocument ? contexts : ['empty workspace']) {
        if (context !== 'pixel layer' && context !== 'empty workspace') await selectContext(s, context);
        rest = await smokeCommands(s, withDocument, rest, context);
      }
      if (withDocument) {
        // The video commands get a document with a video timeline and a video layer.
        await videoContext(s);
        rest = await smokeCommands(s, withDocument, rest, 'video layer');
        await selectContext(s, 'pixel layer');
      }
    }
    const ran = all.length - rest.length;
    if (verbose) console.log(`Never enabled: ${rest.join(' ')}`);
    const t1 = Date.now();
    if (parts.includes('tools')) await smokeTools(s, withDocument);
    const t2 = Date.now();
    if (parts.includes('panels')) await smokePanels(s, withDocument);
    if (verbose) console.log(`Timing: commands ${t1 - t0} ms, tools ${t2 - t1} ms, panels ${Date.now() - t2} ms`);
    console.log(`Smoke ${withDocument ? 'document' : 'empty'}: ran ${ran} enabled commands`);
    expect(s.failures, s.failures.map((f) => `${f.what}: ${f.problem}`).join('\n')).toEqual([]);
  });
}
