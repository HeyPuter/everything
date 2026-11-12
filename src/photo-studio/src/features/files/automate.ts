// File → Automate → Image Processor (and Batch once steps exist): convert many
// files at once, resize to fit, run registered steps, zip or save to Puter.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { download } from '../../persistence/puter';
import { readRgbProfile } from '../../color/profile';
import type { RGBA8 } from '../../imaging/types';
import { canEncodeAvif, fitSize, formatInfo, type ExportContext, type ExportFormat, type ExportSettings, type SourceImage } from './encode';
import { decodeFile, openFile } from './open';
import { encodeOffThread, bytesBlob, documentSource, exportContext, formatBytes, loadSettings, samplesToSource } from './pipeline';
import { pickCloudFiles } from './cloud';
import { uniqueName, zipStore } from './zip';
import { saveToCloudFolder } from './layers-export';
import { rgba16To8 } from './png';
import { escapeXML } from '../../model/assets';
import { withoutAppEvents } from '../../app/app-events';

export { registerBatchStep, installAutomate, type BatchStep } from './automate-steps';
import { batchSteps as steps, type BatchStep } from './automate-steps';

export type Input = { name: string; blob?: Blob; load?: () => Promise<Blob>; session?: DocumentSession };
const outFormats: ExportFormat[] = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'bmp', 'tga', 'gif'];

export async function imageProcessor(e: Editor, batch: boolean) {
  const remembered = loadSettings();
  const avif = await canEncodeAvif();
  const inputs: Input[] = [];
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog files-processor';
  dialog.setAttribute('aria-label', batch ? 'Batch' : 'Image Processor');
  const stepList = [...steps.values()];
  const fmt = outFormats.includes(remembered.format) && (remembered.format !== 'avif' || avif) ? remembered.format : 'jpeg';
  dialog.innerHTML = `<form method="dialog">
    <h2>${batch ? 'Batch' : 'Image Processor'}</h2>
    <section class="processor-step"><h3><span>1</span>Select images</h3>
      <div class="processor-buttons"><button type="button" data-act="local">Add from this device…</button><button type="button" data-act="cloud">Add from Puter…</button>${e.sessions.some((s) => s.hasDocument) ? '<button type="button" data-act="open">Add open documents</button>' : ''}<button type="button" data-act="clear">Clear</button></div>
      <ul class="processor-list" aria-label="Images to process"></ul>
    </section>
    <section class="processor-step"><h3><span>2</span>Resize</h3>
      <label class="dialog-field checkbox-field">Resize to fit<input type="checkbox" name="resize"></label>
      <div class="processor-row"><label class="dialog-field">W (px)<input type="number" name="w" min="1" max="8192" value="1920"></label><label class="dialog-field">H (px)<input type="number" name="h" min="1" max="8192" value="1920"></label></div>
      <label class="dialog-field checkbox-field">Do not enlarge smaller images<input type="checkbox" name="noEnlarge" checked></label>
    </section>
    <section class="processor-step"><h3><span>3</span>File type</h3>
      <div class="processor-row"><label class="dialog-field">Format<select name="format">${outFormats.filter((f) => f !== 'avif' || avif).map((f) => `<option value="${f}" ${f === fmt ? 'selected' : ''}>${formatInfo[f].label}</option>`).join('')}</select></label>
      <label class="dialog-field">Quality<input type="number" name="quality" min="1" max="100" value="${remembered.quality}"></label></div>
      <label class="dialog-field checkbox-field">Convert to sRGB<input type="checkbox" name="srgb" ${remembered.convertSrgb ? 'checked' : ''}></label>
    </section>
    ${stepList.length ? `<section class="processor-step"><h3><span>4</span>Steps</h3>${stepList.map((s) => `<label class="dialog-field checkbox-field">${escapeXML(s.label)}<input type="checkbox" name="step:${escapeXML(s.id)}" ${batch ? 'checked' : ''}></label>`).join('')}</section>` : ''}
    <section class="processor-step"><h3><span>${stepList.length ? 5 : 4}</span>Save</h3>
      <label class="dialog-field">Destination<select name="dest"><option value="zip">Download as ZIP archive</option><option value="puter">Save to a Puter folder…</option></select></label>
    </section>
    <p class="processor-status" aria-live="polite"></p>
    <div class="dialog-actions"><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary" disabled>Run</button></div>
  </form>`;
  e.root.append(dialog);
  const form = dialog.querySelector('form')!;
  const list = dialog.querySelector<HTMLElement>('.processor-list')!;
  const status = dialog.querySelector<HTMLElement>('.processor-status')!;
  const runButton = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const render = () => {
    list.innerHTML = inputs.length
      ? inputs.map((x, i) => `<li>${escapeXML(x.name)}<button type="button" class="icon-button" data-remove="${i}" aria-label="Remove ${escapeXML(x.name)}">×</button></li>`).join('')
      : '<li class="muted">No images selected</li>';
    runButton.disabled = !inputs.length;
    status.textContent = inputs.length ? `${inputs.length} image${inputs.length > 1 ? 's' : ''}` : '';
  };
  render();
  const add = (items: Input[]) => {
    inputs.push(...items);
    render();
  };
  list.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (!b) return;
    inputs.splice(Number(b.dataset.remove), 1);
    render();
  });
  let cancelled = false;
  dialog.showModal();
  return new Promise<void>((resolve) => {
    let running = false;
    const close = () => {
      cancelled = true;
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.addEventListener('click', (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') close();
      else if (act === 'clear') {
        inputs.length = 0;
        render();
      } else if (act === 'local') {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = e.el<HTMLInputElement>('#file-input').accept;
        input.onchange = () => add(Array.from(input.files ?? []).map((f) => ({ name: f.name, blob: f })));
        input.click();
      } else if (act === 'cloud') {
        // The picker never settles when dismissed; nothing waits on it.
        void pickCloudFiles(true)
          .then((items) => add(items.map((it) => ({ name: it.name, load: () => it.read() }))))
          .catch((error) => (status.textContent = String(error instanceof Error ? error.message : error)));
      } else if (act === 'open') {
        for (const s of e.sessions.filter((x) => x.hasDocument))
          inputs.push({ name: `${s.doc.name}.photo`, session: s, load: async () => (await import('../../model/serialization')).serialize(s.doc, s.assets) });
        render();
      }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (running || !inputs.length) return;
      running = true;
      for (const b of dialog.querySelectorAll<HTMLButtonElement>('button:not([data-act="cancel"])')) b.disabled = true;
      const get = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
      const opts = {
        resize: get('resize').checked,
        w: Number(get('w').value) || 0,
        h: Number(get('h').value) || 0,
        enlarge: !get('noEnlarge').checked,
        format: get('format').value as ExportFormat,
        quality: Math.max(1, Math.min(100, Number(get('quality').value) || 85)),
        srgb: get('srgb').checked,
        dest: get('dest').value,
        steps: stepList.filter((s) => (form.elements.namedItem(`step:${s.id}`) as HTMLInputElement | null)?.checked),
      };
      void runProcessor(e, inputs, opts, (text) => (status.textContent = text), () => cancelled)
        .then((files) => {
          if (cancelled) return;
          close();
          if (!files.length) return;
          if (opts.dest === 'puter') saveToCloudFolder(e, files);
          else {
            const zip = zipStore(files.map((f) => ({ name: f.name, data: f.bytes })));
            download(bytesBlob(zip, 'application/zip'), 'processed-images.zip');
            e.message(`Processed ${files.length} images (${formatBytes(zip.length)}).${files.failed.length ? ` ${failedNote(files.failed)}` : ''}`);
          }
        })
        .catch((error) => {
          running = false;
          status.textContent = error instanceof Error ? error.message : String(error);
          for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) b.disabled = false;
        });
    });
  });
}

export type RunOptions = { resize: boolean; w: number; h: number; enlarge: boolean; format: ExportFormat; quality: number; srgb: boolean; steps: BatchStep[] };

async function loadInput(e: Editor, input: Input, documentSteps: BatchStep[]): Promise<{ src: SourceImage; ctx: ExportContext }> {
  if (input.session && !documentSteps.length) {
    const s = input.session;
    return { src: samplesToSource(await e.renderer.documentPixels({ ...s.doc, selection: null }, s.assets), s.doc.width, s.doc.height), ctx: exportContext(s.doc) };
  }
  const blob = input.blob ?? (await input.load!());
  const native = /\.(photo|psd|psb)$/i.test(input.name);
  if (!native && !documentSteps.length) {
    const d = await decodeFile(blob, input.name, { pages: 'first' });
    let profile = null;
    try {
      profile = d.icc ? readRgbProfile(d.icc) : null;
    } catch {
      profile = null;
    }
    return { src: d.deep?.data instanceof Uint16Array ? { width: d.image.width, height: d.image.height, data: d.deep.data } : d.image, ctx: { profile, icc: profile ? d.icc : undefined, dpi: d.dpi } };
  }
  // Layered files and document steps go through a temporary editor tab.
  const previous = e.session;
  const before = new Set(e.sessions);
  if (!(await openFile(e, blob, input.name, false, { pages: 'first' }))) throw new Error(`${input.name} could not be opened.`);
  const s = e.sessions.find((x) => !before.has(x)) ?? e.session;
  try {
    for (const step of documentSteps) await step.document!(e);
    return { src: await documentSource(e, s.doc), ctx: exportContext(s.doc) };
  } finally {
    await e.closeSession(s, true);
    if (e.sessions.includes(previous)) await e.switchSession(previous);
  }
}

export async function runProcessor(e: Editor, inputs: Input[], o: RunOptions, report: (s: string) => void, cancelled: () => boolean) {
  // Temporary tabs of a batch do not trigger script events.
  return withoutAppEvents(() => processAll(e, inputs, o, report, cancelled));
}
async function processAll(e: Editor, inputs: Input[], o: RunOptions, report: (s: string) => void, cancelled: () => boolean) {
  const base = loadSettings();
  const used = new Set<string>();
  const files: { name: string; bytes: Uint8Array; blob: Blob }[] = [];
  const failures: string[] = [];
  const documentSteps = o.steps.filter((s) => s.document);
  const t0 = performance.now();
  for (let i = 0; i < inputs.length; i++) {
    if (cancelled()) break;
    const input = inputs[i];
    report(`Processing ${i + 1} of ${inputs.length}: ${input.name}`);
    try {
      let { src, ctx } = await loadInput(e, input, documentSteps);
      for (const step of o.steps)
        if (step.apply) {
          const img = src.data instanceof Uint16Array ? { width: src.width, height: src.height, data: rgba16To8(src.data) } : (src as RGBA8);
          src = await step.apply(img, { name: input.name });
        }
      const [w, h] = o.resize ? fitSize(src.width, src.height, o.w, o.h, o.enlarge) : [src.width, src.height];
      const settings: ExportSettings = { ...base, format: o.format, quality: o.quality, convertSrgb: o.srgb, sizeMode: 'exact', width: w, height: h, canvasWidth: 0, canvasHeight: 0, depth: 16 };
      const { bytes } = await encodeOffThread(src, settings, ctx);
      const name = uniqueName(`${input.name.replace(/\.[^.]+$/, '')}.${formatInfo[o.format].ext}`, used);
      files.push({ name, bytes, blob: bytesBlob(bytes, formatInfo[o.format].mime) });
    } catch (error) {
      failures.push(`${input.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) e.message(failedNote(failures));
  report(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  // Callers add the failures to their own closing message.
  return Object.assign(files, { failed: failures });
}
/** “2 files failed. a.png: … · b.png: …”, or '' when none did. */
export function failedNote(failures: string[]) {
  return failures.length ? `${failures.length} file${failures.length > 1 ? 's' : ''} failed. ${failures.slice(0, 3).join(' · ')}` : '';
}
