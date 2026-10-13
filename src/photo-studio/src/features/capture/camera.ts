// File → Import → Images from Device: a camera capture dialog with a live
// preview, camera and resolution choice, mirroring, a countdown and bursts.
// Shots open as a new document (a burst as one layer per shot) or are added
// to the current document as embedded objects. The camera is asked for only
// when the dialog opens and released when it closes.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { containerOf, type Layer } from '../../model/document';
import type { EmbeddedContents } from '../../model/embedded';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { encodePng } from '../files/png';
import { contentsFromFile, fittedTransform, instanceLayer } from '../embedded/contents';
import { noteCapture } from '../provenance/recorder';
import './camera.css';

type Settings = { device: string; resolution: string; mirror: boolean; countdown: number; burst: number; target: 'document' | 'layer' };
const KEY = 'photo-studio-camera';
const RESOLUTIONS: [string, string][] = [
  ['best', 'Best available'],
  ['3840x2160', '3840 × 2160 (4K)'],
  ['1920x1080', '1920 × 1080'],
  ['1280x720', '1280 × 720'],
  ['640x480', '640 × 480'],
];
function load(): Settings {
  const d: Settings = { device: '', resolution: 'best', mirror: true, countdown: 0, burst: 1, target: 'document' };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      device: typeof v.device === 'string' ? v.device : d.device,
      resolution: RESOLUTIONS.some(([r]) => r === v.resolution) ? v.resolution : d.resolution,
      mirror: typeof v.mirror === 'boolean' ? v.mirror : d.mirror,
      countdown: [0, 3, 5, 10].includes(v.countdown) ? v.countdown : d.countdown,
      burst: [1, 3, 5, 10].includes(v.burst) ? v.burst : d.burst,
      target: v.target === 'layer' ? 'layer' : 'document',
    };
  } catch {
    return d;
  }
}
const save = (s: Settings) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* Optional. */
  }
};
const BURST_GAP_MS = 500;
const MAX_SIDE = 8192;

function constraints(s: Settings): MediaStreamConstraints {
  const video: MediaTrackConstraints = {};
  if (s.device) video.deviceId = { exact: s.device };
  if (s.resolution === 'best') Object.assign(video, { width: { ideal: 4096 }, height: { ideal: 2160 } });
  else {
    const [w, h] = s.resolution.split('x').map(Number);
    Object.assign(video, { width: { ideal: w }, height: { ideal: h } });
  }
  return { video, audio: false };
}
function explain(error: unknown): string {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was not allowed. Allow it for this site in the browser’s settings and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found, or it cannot use the chosen resolution.';
  if (name === 'NotReadableError') return 'The camera is in use by another application.';
  return `The camera could not start${error instanceof Error && error.message ? `: ${error.message}` : '.'}`;
}

/** Grab the current video frame as RGBA (mirrored when asked). */
export function grabFrame(video: HTMLVideoElement, mirror: boolean) {
  const k = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * k)),
    h = Math.max(1, Math.round(video.videoHeight * k));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d')!;
  if (mirror) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  g.drawImage(video, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

export async function captureDialog(e: Editor) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser offers no camera access (it needs a secure https:// page).');
  const s = load();
  if (!e.hasDocument) s.target = 'document';
  const dialog = document.createElement('dialog');
  dialog.className = 'camera-dialog';
  dialog.setAttribute('aria-label', 'Images from Device');
  dialog.innerHTML = `<form method="dialog"><h2>Images from Device</h2>
<div class="camera-body">
  <div class="camera-stage"><video playsinline muted aria-label="Camera preview"></video><div class="camera-count" aria-live="assertive" hidden></div><div class="camera-status" role="status">Starting the camera…</div></div>
  <div class="camera-settings">
    <label class="export-row"><span>Camera</span><select name="device"><option value="">Default camera</option></select></label>
    <label class="export-row"><span>Resolution</span><select name="resolution">${RESOLUTIONS.map(([v, l]) => `<option value="${v}">${escapeXML(l)}</option>`).join('')}</select></label>
    <label class="export-check"><input type="checkbox" name="mirror"><span>Mirror</span></label>
    <label class="export-row"><span>Timer</span><select name="countdown"><option value="0">Off</option><option value="3">3 seconds</option><option value="5">5 seconds</option><option value="10">10 seconds</option></select></label>
    <label class="export-row"><span>Burst</span><select name="burst"><option value="1">Single shot</option><option value="3">3 shots</option><option value="5">5 shots</option><option value="10">10 shots</option></select></label>
    <fieldset class="camera-target"><legend>Add to</legend>
      <label class="export-check"><input type="radio" name="target" value="document"><span>A new document</span></label>
      <label class="export-check"><input type="radio" name="target" value="layer" ${e.hasDocument ? '' : 'disabled'}><span>The current document (new layer)</span></label>
    </fieldset>
    <p class="export-note camera-size"></p>
  </div>
</div>
<div class="dialog-actions"><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary" data-act="capture" disabled>Capture</button></div></form>`;
  e.root.append(dialog);
  const form = dialog.querySelector('form')!;
  const video = dialog.querySelector('video')!;
  const status = dialog.querySelector<HTMLElement>('.camera-status')!;
  const count = dialog.querySelector<HTMLElement>('.camera-count')!;
  const sizeNote = dialog.querySelector<HTMLElement>('.camera-size')!;
  const captureButton = dialog.querySelector<HTMLButtonElement>('[data-act="capture"]')!;
  const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;
  field<HTMLSelectElement>('resolution').value = s.resolution;
  field<HTMLInputElement>('mirror').checked = s.mirror;
  field<HTMLSelectElement>('countdown').value = String(s.countdown);
  field<HTMLSelectElement>('burst').value = String(s.burst);
  for (const r of form.querySelectorAll<HTMLInputElement>('input[name="target"]')) r.checked = r.value === s.target;
  let stream: MediaStream | undefined;
  let closed = false;
  let generation = 0;
  const stop = () => stream?.getTracks().forEach((t) => t.stop());
  const mirror = () => video.classList.toggle('mirrored', s.mirror);
  mirror();

  async function listDevices() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const select = field<HTMLSelectElement>('device');
      select.innerHTML = `<option value="">Default camera</option>${devices.map((d, i) => `<option value="${escapeXML(d.deviceId)}">${escapeXML(d.label || `Camera ${i + 1}`)}</option>`).join('')}`;
      select.value = devices.some((d) => d.deviceId === s.device) ? s.device : '';
    } catch {
      /* The default camera still works. */
    }
  }
  async function start() {
    const g = ++generation;
    stop();
    stream = undefined;
    captureButton.disabled = true;
    status.hidden = false;
    status.textContent = 'Starting the camera…';
    try {
      let next: MediaStream;
      try {
        next = await navigator.mediaDevices.getUserMedia(constraints(s));
      } catch (error) {
        // A remembered camera that is gone: fall back to the default.
        if (!s.device || (error as DOMException)?.name !== 'OverconstrainedError' && (error as DOMException)?.name !== 'NotFoundError') throw error;
        s.device = '';
        next = await navigator.mediaDevices.getUserMedia(constraints(s));
      }
      if (g !== generation || closed) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = next;
      video.srcObject = next;
      await video.play().catch(() => {});
      if (!video.videoWidth) await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
      if (g !== generation || closed) return;
      status.hidden = true;
      captureButton.disabled = false;
      sizeNote.textContent = `Captures ${video.videoWidth} × ${video.videoHeight} px.`;
      void listDevices();
    } catch (error) {
      if (g !== generation || closed) return;
      status.textContent = explain(error);
      sizeNote.textContent = '';
    }
  }

  const read = () => {
    const prev = { ...s };
    s.device = field<HTMLSelectElement>('device').value;
    s.resolution = field<HTMLSelectElement>('resolution').value;
    s.mirror = field<HTMLInputElement>('mirror').checked;
    s.countdown = Number(field<HTMLSelectElement>('countdown').value);
    s.burst = Number(field<HTMLSelectElement>('burst').value);
    s.target = (form.querySelector<HTMLInputElement>('input[name="target"]:checked')?.value as Settings['target']) ?? 'document';
    save(s);
    mirror();
    if (prev.device !== s.device || prev.resolution !== s.resolution) void start();
  };
  form.addEventListener('change', read);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Shot = ReturnType<typeof grabFrame>;
  const shots = await new Promise<Shot[] | null>((resolve) => {
    let taken: Shot[] | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      generation++;
      stop();
      video.srcObject = null;
      dialog.close();
      dialog.remove();
      resolve(taken);
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (captureButton.disabled) return;
      captureButton.disabled = true;
      void (async () => {
        const shots: Shot[] = [];
        try {
          for (let n = s.countdown; n > 0 && !closed; n--) {
            count.hidden = false;
            count.textContent = String(n);
            await wait(1000);
          }
          count.hidden = true;
          for (let i = 0; i < s.burst && !closed; i++) {
            if (i) await wait(BURST_GAP_MS);
            shots.push(grabFrame(video, s.mirror));
            dialog.classList.remove('flash');
            void dialog.offsetWidth;
            dialog.classList.add('flash');
          }
          if (closed) return;
          taken = shots;
          close();
        } catch (error) {
          status.hidden = false;
          status.textContent = error instanceof Error ? error.message : String(error);
          captureButton.disabled = false;
        }
      })();
    });
    dialog.showModal();
    void start();
  });
  // The command is still running (busy) while the shots are added.
  if (shots?.length) await addShots(e, shots, s.target);
}

/** Shots become a new document (one layer each) or embedded objects in the current one. */
export async function addShots(e: Editor, shots: { width: number; height: number; data: Uint8ClampedArray }[], target: Settings['target']) {
  if (!shots.length) return;
  const name = `Camera ${stamp()}`;
  const png = (img: (typeof shots)[number]) => new Blob([encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 }) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  if (target === 'layer' && e.hasDocument) {
    const parts: { c: EmbeddedContents; l: Layer }[] = [];
    for (const [i, shot] of shots.entries()) {
      const c = await contentsFromFile(e, e.doc, e.assets, png(shot), `${name}${shots.length > 1 ? ` ${i + 1}` : ''}.png`);
      parts.push({ c, l: instanceLayer(c, c.name, fittedTransform(e.doc, c.width, c.height)) });
    }
    const anchor = e.selected;
    e.command(shots.length > 1 ? 'Capture Burst' : 'Capture from Camera', (d) => {
      for (const { c } of parts) d.embeds = { ...d.embeds, [c.id]: c };
      const list = (anchor && containerOf(d.layers, anchor)) || d.layers;
      const at = list.findIndex((x) => x.id === anchor);
      list.splice(at < 0 ? list.length : at + 1, 0, ...parts.map((p) => p.l));
    });
    e.selectLayers(parts.map((p) => p.l.id));
    e.update();
    e.message(`Added ${shots.length} camera shot${shots.length === 1 ? '' : 's'} as embedded objects.`);
    return;
  }
  const { openFile } = await import('../files/open');
  await openFile(e, png(shots[0]), `${name}.png`);
  noteCapture(e.session);
  if (shots.length > 1) {
    const doc = e.doc;
    const layers = shots.slice(1).map((shot, i) => newPixelLayer(`Shot ${i + 2}`, doc, gridFromImage(e.assets.tiles, shot)));
    e.command('Add Burst Shots', (d) => {
      d.layers[0].name = 'Shot 1';
      d.layers.push(...layers);
    });
    e.selected = layers.at(-1)!.id;
    e.update();
  }
  e.message(shots.length > 1 ? `Captured ${shots.length} shots into a new document, one layer each.` : 'Captured a new document from the camera.');
}
