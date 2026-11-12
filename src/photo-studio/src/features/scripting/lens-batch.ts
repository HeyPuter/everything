// File → Automate → Lens Correction: correct many photos at once with
// automatic settings (straightening and vignetting measured per image) or
// one set of custom settings, saved as a ZIP or into a Puter folder.
import './scripting.css';
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { lensCorrection, type LensParams } from '../../imaging/filters/lens';
import type { ParamSpec, RGBA8 } from '../../imaging/types';
import { download } from '../../persistence/puter';
import { failedNote, runProcessor, type Input } from '../files/automate';
import { formatInfo, type ExportFormat } from '../files/encode';
import { bytesBlob, formatBytes } from '../files/pipeline';
import { zipStore } from '../files/zip';
import { saveToCloudFolder } from '../files/layers-export';
import { hexRgb } from '../pixels';
import type { LensJob } from './lens-batch.worker';

const formats: ExportFormat[] = ['jpeg', 'png', 'tiff', 'webp'];

/** Lens Correction in a worker, one image at a time. */
function lensRunner() {
  const worker = new Worker(new URL('./lens-batch.worker.ts', import.meta.url), { type: 'module', name: 'lens-batch' });
  let next = 0;
  const waiting = new Map<number, { resolve: (img: RGBA8) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<{ id: number; image?: RGBA8; error?: string }>) => {
    const w = waiting.get(ev.data.id);
    waiting.delete(ev.data.id);
    if (ev.data.error || !ev.data.image) w?.reject(new Error(ev.data.error ?? 'Lens Correction failed.'));
    else w?.resolve(ev.data.image);
  };
  worker.onerror = (ev) => {
    for (const w of waiting.values()) w.reject(new Error(ev.message || 'Lens Correction failed.'));
    waiting.clear();
  };
  return {
    run(job: Omit<LensJob, 'id'>): Promise<RGBA8> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ ...job, id }, [job.image.data.buffer]);
      });
    },
    dispose: () => worker.terminate(),
  };
}

function paramField(p: ParamSpec) {
  if (p.type === 'select') return `<label class="dialog-field">${escapeXML(p.label)}<select name="p:${p.key}" title="${escapeXML(p.label)} for every photo">${p.options.map((o) => `<option value="${escapeXML(o.value)}" ${o.value === p.default ? 'selected' : ''}>${escapeXML(o.label)}</option>`).join('')}</select></label>`;
  if (p.type === 'number') return `<label class="dialog-field">${escapeXML(p.label)}${p.unit ? ` (${escapeXML(p.unit)})` : ''}<input type="number" name="p:${p.key}" min="${p.min}" max="${p.max}" step="${p.step ?? 1}" value="${p.default}" title="${escapeXML(p.label)} for every photo (${p.min} to ${p.max})"></label>`;
  return '';
}

export function lensCorrectionBatch(e: Editor): Promise<void> {
  const inputs: Input[] = [];
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog files-processor lens-batch';
  dialog.setAttribute('aria-label', 'Lens Correction');
  dialog.innerHTML = `<form method="dialog">
    <h2>Lens Correction</h2>
    <section class="processor-step"><h3><span>1</span>Images</h3>
      <div class="processor-buttons"><button type="button" data-act="local" title="Choose photos on this device">Add from this device…</button><button type="button" data-act="cloud" title="Choose photos on Puter">Add from Puter…</button>${e.sessions.some((s) => s.hasDocument) ? '<button type="button" data-act="open" title="Use the documents open in Photo Studio">Add open documents</button>' : ''}<button type="button" data-act="clear" title="Remove every image from the list">Clear</button></div>
      <ul class="processor-list" aria-label="Images to correct"></ul>
    </section>
    <section class="processor-step"><h3><span>2</span>Correction</h3>
      <div class="segmented lens-mode" role="radiogroup" aria-label="Settings">
        <label title="Measure the tilt and the corner darkening of each photo"><input type="radio" name="mode" value="auto" checked> Automatic</label>
        <label title="Apply the same settings to every photo"><input type="radio" name="mode" value="custom"> Custom</label>
      </div>
      <div class="lens-auto">
        <label class="dialog-field checkbox-field" title="Rotate so strong near-vertical and near-horizontal edges become straight">Straighten tilted horizons and verticals<input type="checkbox" name="straighten" checked></label>
        <label class="dialog-field checkbox-field" title="Brighten corners that are darker than the center">Remove vignetting<input type="checkbox" name="vignette" checked></label>
        <label class="dialog-field checkbox-field" title="Enlarge slightly after rotating so no empty corners show">Fill the frame after straightening<input type="checkbox" name="fill" checked></label>
      </div>
      <div class="lens-custom" hidden>${lensCorrection.params.map(paramField).join('')}</div>
    </section>
    <section class="processor-step"><h3><span>3</span>Save</h3>
      <div class="processor-row"><label class="dialog-field">Format<select name="format" title="File type of the corrected photos">${formats.map((f) => `<option value="${f}">${formatInfo[f].label}</option>`).join('')}</select></label>
      <label class="dialog-field">Quality<input type="number" name="quality" min="1" max="100" value="90" title="JPEG and WebP quality"></label></div>
      <label class="dialog-field">Destination<select name="dest" title="Where the corrected photos go"><option value="zip">Download as ZIP archive</option><option value="puter">Save to a Puter folder…</option></select></label>
    </section>
    <p class="processor-status" aria-live="polite"></p>
    <div class="dialog-actions"><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary" disabled>Correct</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const list = dialog.querySelector<HTMLElement>('.processor-list')!;
  const status = dialog.querySelector<HTMLElement>('.processor-status')!;
  const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
  const checked = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).checked;
  const render = () => {
    list.innerHTML = inputs.length
      ? inputs.map((x, i) => `<li>${escapeXML(x.name)}<button type="button" class="icon-button" data-remove="${i}" aria-label="Remove ${escapeXML(x.name)}" title="Remove from the list">×</button></li>`).join('')
      : '<li class="muted">No images selected</li>';
    submit.disabled = !inputs.length;
    status.textContent = inputs.length ? `${inputs.length} image${inputs.length > 1 ? 's' : ''}` : '';
  };
  render();
  form.addEventListener('change', () => {
    const auto = value('mode') === 'auto';
    dialog.querySelector<HTMLElement>('.lens-auto')!.hidden = !auto;
    dialog.querySelector<HTMLElement>('.lens-custom')!.hidden = auto;
  });
  return new Promise((resolve) => {
    let cancelled = false;
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
      const t = ev.target as HTMLElement;
      const remove = t.closest<HTMLElement>('[data-remove]');
      if (remove && !running) {
        inputs.splice(Number(remove.dataset.remove), 1);
        return render();
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') close();
      else if (act === 'clear' && !running) {
        inputs.length = 0;
        render();
      } else if (act === 'local') {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = e.el<HTMLInputElement>('#file-input').accept;
        input.onchange = () => {
          inputs.push(...Array.from(input.files ?? []).map((f) => ({ name: f.name, blob: f })));
          render();
        };
        input.click();
      } else if (act === 'cloud')
        // The picker never settles when dismissed; nothing waits on it.
        void import('../files/cloud')
          .then(({ pickCloudFiles }) => pickCloudFiles(true))
          .then((items) => {
            inputs.push(...items.map((it) => ({ name: it.name, load: () => it.read() })));
            render();
          })
          .catch((error) => (status.textContent = String(error instanceof Error ? error.message : error)));
      else if (act === 'open') {
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
      const auto = value('mode') === 'auto' ? { straighten: checked('straighten'), vignette: checked('vignette'), fill: checked('fill') } : undefined;
      const params: LensParams = {};
      if (!auto)
        for (const p of lensCorrection.params) {
          const v = value(`p:${p.key}`);
          (params as Record<string, unknown>)[p.key] = p.type === 'number' ? Math.min(p.max, Math.max(p.min, Number(v) || 0)) : v;
        }
      const format = value('format') as ExportFormat;
      const dest = value('dest');
      const lens = lensRunner();
      const background = hexRgb(e.background);
      const step = { id: 'lens-correction', label: 'Lens Correction', apply: (image: RGBA8) => lens.run({ image: { ...image, data: new Uint8ClampedArray(image.data) }, params, auto, background }) };
      const opts = { resize: false, w: 0, h: 0, enlarge: false, format, quality: Math.max(1, Math.min(100, Number(value('quality')) || 90)), srgb: true, steps: [step] };
      void runProcessor(e, inputs, opts, (text) => (status.textContent = text), () => cancelled)
        .then((files) => {
          lens.dispose();
          if (cancelled) return;
          close();
          if (!files.length) return;
          if (dest === 'puter') saveToCloudFolder(e, files);
          else {
            const zip = zipStore(files.map((f) => ({ name: f.name, data: f.bytes })));
            download(bytesBlob(zip, 'application/zip'), 'lens-corrected.zip');
            e.message(`Corrected ${files.length} image${files.length > 1 ? 's' : ''} (${formatBytes(zip.length)}).${files.failed.length ? ` ${failedNote(files.failed)}` : ''}`);
          }
        })
        .catch((error) => {
          lens.dispose();
          running = false;
          status.textContent = error instanceof Error ? error.message : String(error);
          for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) b.disabled = false;
          render();
        });
    });
    dialog.showModal();
  });
}
