// Screenshots: the whole window or one editor (through the browser's tab capture, after the user
// agrees); 3D views are cropped straight from the shared canvas.
import { app, registerOperators, type OpContext } from '../app/app';
import { renderContext } from '../render/context';
import type { Area } from './screen';

function saveCanvas(c: HTMLCanvasElement, name: string) {
  c.toBlob((b) => {
    if (!b) return app.report('ERROR', 'The screenshot could not be encoded');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    app.report('INFO', `Saved ${name}`);
  }, 'image/png');
}

/** Copy a client rectangle of the shared 3D canvas into a new canvas. */
function cropCanvas(r: DOMRect): HTMLCanvasElement | null {
  const engine = renderContext?.engine;
  if (!engine) return null;
  engine.drawAll();
  const base = engine.canvas.getBoundingClientRect();
  const dpr = engine.dpr;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.width * dpr));
  out.height = Math.max(1, Math.round(r.height * dpr));
  out.getContext('2d')!.drawImage(engine.canvas, (r.left - base.left) * dpr, (r.top - base.top) * dpr, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Grab one frame of this tab through the browser's screen capture (asks the user). */
async function captureTab(): Promise<HTMLCanvasElement | null> {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (o: unknown) => Promise<MediaStream> };
  if (!md?.getDisplayMedia) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await md.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // let the capture settle on a fresh frame
    await new Promise((r) => setTimeout(r, 200));
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return c;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

const areaOf = (ctx: OpContext) => (ctx.area && 'screen' in (ctx.area as object) ? (ctx.area as Area) : null);

registerOperators([
  {
    idname: 'screen.screenshot',
    label: 'Save Screenshot',
    description: 'Save an image of the whole window (the browser asks to share this tab first)',
    undo: false,
    exec: () => {
      void captureTab().then((c) => {
        if (c) return saveCanvas(c, 'screenshot.png');
        // no tab capture: save what the 3D views show
        const engine = renderContext?.engine;
        if (!engine) return app.report('WARNING', 'The screenshot was cancelled');
        app.report('WARNING', 'Window capture was not allowed; saved the 3D views only');
        engine.drawAll();
        saveCanvas(engine.canvas, 'screenshot.png');
      });
    },
  },
  {
    idname: 'screen.screenshot_area',
    label: 'Save Screenshot (Editor)',
    description: 'Save an image of the editor under the pointer (other editors than the 3D view need the tab sharing permission)',
    undo: false,
    poll: (ctx) => !!areaOf(ctx),
    exec: (ctx) => {
      const a = areaOf(ctx)!;
      if (a.type === 'VIEW_3D') {
        const c = cropCanvas(a.editor.el.getBoundingClientRect());
        if (!c) return 'CANCELLED';
        return void saveCanvas(c, 'screenshot_3d_view.png');
      }
      const r = a.el.getBoundingClientRect();
      const name = `screenshot_${a.type.toLowerCase()}.png`;
      void captureTab().then((full) => {
        if (!full) return app.report('WARNING', 'Window capture was not allowed');
        const sx = full.width / innerWidth,
          sy = full.height / innerHeight;
        const out = document.createElement('canvas');
        out.width = Math.round(r.width * sx);
        out.height = Math.round(r.height * sy);
        out.getContext('2d')!.drawImage(full, r.left * sx, r.top * sy, out.width, out.height, 0, 0, out.width, out.height);
        saveCanvas(out, name);
      });
    },
  },
]);
