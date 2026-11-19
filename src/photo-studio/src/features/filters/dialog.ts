// The filter dialog generated from an operation's ParamSpec, with a real-size
// preview pane, canvas preview, Reset (Alt-click Cancel) and progress. The
// Lens Correction workspace is a layout of the same dialog; Develop has its
// own workspace (develop/workspace.ts).
import type { Editor } from '../../editor';
import { blendGroupStarts, blendLabel, blends, findLayer, type Blend } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { defaults, type ParamValues } from '../../imaging/types';
import { svg } from '../../app/icons';
import { filterOp, normalizeFor, commandId } from './catalog';
import { closeSession, commitSession, isLiveLayer, opLabel, openSession, sessionEntries } from './apply';
import { FilterPreview, regionThumbnail } from './preview';
import { paramForm } from './form';
import { isCancel } from './client';
import { recordStep } from './record';

// Settings last used per filter in this session, restored when its dialog reopens.
export const lastUsed = new Map<string, ParamValues>();

export function blendOptions(selected: Blend) {
  return blends.map((b) => `${blendGroupStarts.includes(b) ? '<option disabled>──────────</option>' : ''}<option value="${b}" ${b === selected ? 'selected' : ''}>${blendLabel(b)}</option>`).join('');
}

/** Create the shared dialog chrome; returns its parts. */
export function dialogShell(title: string, cls: string, paneW: number, paneH: number) {
  const dialog = document.createElement('dialog');
  dialog.className = `filter-dialog ${cls}`;
  // The fields clamp their own entries; a value between steps must not block OK.
  dialog.innerHTML = `<form method="dialog" class="fd-form" novalidate>
<h2>${escapeXML(title)}</h2>
<div class="fd-main">
  <div class="fd-left">
    <div class="fd-pane-wrap"><canvas class="fd-pane" width="${paneW}" height="${paneH}" aria-label="Preview; drag to move the preview area"></canvas></div>
    <div class="fd-zoom"><button type="button" class="icon-button" data-zoom="-1" aria-label="Zoom out" title="Zoom out">${svg('minus', 14)}</button><span class="fd-zoom-label">100%</span><button type="button" class="icon-button" data-zoom="1" aria-label="Zoom in" title="Zoom in">${svg('plus', 14)}</button><span class="fd-zoom-extra"></span></div>
  </div>
  <div class="fd-right">
    <div class="fd-extra"></div>
    <div class="fd-params"></div>
    <div class="fd-blending"></div>
  </div>
</div>
<div class="fd-progress" hidden><progress max="1" value="0"></progress><button type="button" class="fd-progress-cancel">Stop</button></div>
<footer class="fd-actions dialog-footer"><label class="fd-preview-toggle"><input type="checkbox" class="fd-preview" checked> Preview</label><button type="button" class="fd-cancel" title="Alt-click to reset">Cancel</button><button type="submit" class="primary fd-ok">OK</button></footer>
</form>`;
  document.body.append(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  makeMovable(dialog);
  // Holding Alt turns Cancel into Reset.
  const alt = (ev: KeyboardEvent) => (q('.fd-cancel').textContent = ev.altKey ? 'Reset' : 'Cancel');
  dialog.addEventListener('keydown', alt);
  dialog.addEventListener('keyup', alt);
  return {
    dialog,
    pane: q<HTMLCanvasElement>('.fd-pane'),
    zoomLabel: q('.fd-zoom-label'),
    zoomExtra: q('.fd-zoom-extra'),
    params: q('.fd-params'),
    extra: q('.fd-extra'),
    blending: q('.fd-blending'),
    progress: q('.fd-progress'),
    ok: q<HTMLButtonElement>('.fd-ok'),
    cancel: q<HTMLButtonElement>('.fd-cancel'),
    previewToggle: q<HTMLInputElement>('.fd-preview'),
    stop: q<HTMLButtonElement>('.fd-progress-cancel'),
  };
}

/** Drag a dialog by its title so the canvas preview behind it can be seen. */
export function makeMovable(dialog: HTMLDialogElement) {
  const title = dialog.querySelector<HTMLElement>('h2');
  if (!title) return;
  title.addEventListener('pointerdown', (ev) => {
    const r = dialog.getBoundingClientRect();
    const dx = ev.clientX - r.left,
      dy = ev.clientY - r.top;
    title.setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => {
      const x = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, m.clientX - dx)),
        y = Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy));
      Object.assign(dialog.style, { margin: '0', left: `${x}px`, top: `${y}px` });
    };
    const up = () => {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', up);
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
  });
}
export type DialogOptions = { edit?: { layerId: string; index: number }; initial?: ParamValues; record?: boolean };

// Filters with their own workspace (Wide Angle Correction) open it in place
// of the generated dialog, also when a Live Filter is edited.
export const customDialogs = new Map<string, (e: Editor, opts: DialogOptions) => Promise<boolean>>();

/** Show the dialog for `opId`, apply on OK; resolves true when applied. */
export async function filterDialog(e: Editor, opId: string, opts: DialogOptions = {}): Promise<boolean> {
  const custom = customDialogs.get(opId);
  if (custom) return custom(e, opts);
  const op = filterOp(opId);
  if (!op) return false;
  let blending: { opacity: number; blend: Blend } | undefined;
  let params: ParamValues;
  if (opts.edit) {
    const l = findLayer(e.doc.layers, opts.edit.layerId);
    const f = isLiveLayer(l) ? l.liveFilters[opts.edit.index] : undefined;
    if (!f) return false;
    params = normalizeFor(opId, f.params);
    blending = { opacity: f.opacity, blend: f.blend };
  } else params = normalizeFor(opId, opts.initial ?? lastUsed.get(opId) ?? defaults(op));
  const s = await openSession(e, opId, params, opts.edit);
  if (!s) return false;
  if (s.live && !blending) blending = { opacity: 1, blend: 'normal' };
  const lens = opId === 'lens-correction';
  const big = lens;
  // Large panes follow the image's aspect within the space available.
  let paneW = 300,
    paneH = 300;
  if (big) {
    const narrow = window.innerWidth < 760;
    const maxW = narrow ? window.innerWidth - 70 : Math.min(760, window.innerWidth - 460),
      maxH = narrow ? Math.min(420, window.innerHeight * 0.45) : Math.min(520, window.innerHeight - 220);
    const aspect = s.rect.width / s.rect.height;
    paneW = Math.max(240, Math.round(Math.min(maxW, maxH * aspect)));
    paneH = Math.max(180, Math.round(Math.min(maxH, paneW / aspect)));
  }
  const ui = dialogShell(`${op.label}${s.live ? ' (Live Filter)' : ''}`, lens ? 'lens' : '', paneW, paneH);
  let showGrid = false;
  const preview = new FilterPreview(s, {
    pane: ui.pane,
    progress: ui.progress,
    zoomLabel: ui.zoomLabel,
    overlay: (ctx, w, h) => {
      if (!showGrid) return;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x < w; x += 32) ctx.moveTo(x, 0), ctx.lineTo(x, h);
      for (let y = 0.5; y < h; y += 32) ctx.moveTo(0, y), ctx.lineTo(w, y);
      ctx.stroke();
    },
  });
  const update = () => preview.setEntries(sessionEntries(s, opId, params, blending));

  if (lens) ui.extra.innerHTML = `<label class="fd-grid-toggle"><input type="checkbox" class="fd-grid"> Show Grid</label>`;
  ui.extra.querySelector<HTMLInputElement>('.fd-grid')?.addEventListener('change', (ev) => {
    showGrid = (ev.target as HTMLInputElement).checked;
    preview.draw();
  });

  const forms: { set: (v: ParamValues) => void }[] = [];
  const onChange = (v: ParamValues) => {
    params = { ...params, ...v };
    update();
  };
  const thumbnail = (c: HTMLCanvasElement) => regionThumbnail(s, c);
  if (op.params.length) forms.push(paramForm(ui.params, op.params, params, onChange, { thumbnail }));
  else ui.params.innerHTML = `<p class="fd-note">This filter has no settings.</p>`;

  if (s.live && blending) {
    ui.blending.innerHTML = `<h3>Blending</h3><div class="fp-row"><label for="fd-mode">Mode</label><select id="fd-mode">${blendOptions(blending.blend)}</select></div><div class="fp-row fp-number"><label for="fd-opacity">Opacity</label><input id="fd-opacity" type="number" min="0" max="100" step="1" value="${Math.round(blending.opacity * 100)}"><span class="fp-unit">%</span><input type="range" id="fd-opacity-range" min="0" max="100" value="${Math.round(blending.opacity * 100)}" aria-label="Opacity"></div>`;
    ui.blending.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id === 'fd-mode') blending = { ...blending!, blend: t.value as Blend };
      else if (t.id === 'fd-opacity' || t.id === 'fd-opacity-range') {
        // A cleared field is not 0%; it keeps the opacity until edited.
        if (t.value.trim() === '' || !Number.isFinite(Number(t.value))) return;
        const v = Math.max(0, Math.min(100, Number(t.value)));
        blending = { ...blending!, opacity: v / 100 };
        ui.blending.querySelector<HTMLInputElement>(t.id === 'fd-opacity' ? '#fd-opacity-range' : '#fd-opacity')!.value = String(v);
      } else return;
      update();
    });
    // Leaving the field shows the opacity in use (clamped, or kept when blank).
    ui.blending.querySelector('#fd-opacity')!.addEventListener('change', (ev) => ((ev.target as HTMLInputElement).value = String(Math.round(blending!.opacity * 100))));
  }

  const initialParams = { ...params },
    initialBlending = blending && { ...blending };
  update();
  preview.setZoom(preview.local && !big ? 1 : preview.fitZoom());
  ui.dialog.addEventListener('click', (ev) => {
    const z = (ev.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (z) preview.stepZoom(Number(z.dataset.zoom) as 1 | -1);
  });
  ui.previewToggle.addEventListener('change', () => preview.setCanvasPreview(ui.previewToggle.checked));
  ui.stop.addEventListener('click', () => preview.cancel());

  return new Promise<boolean>((resolve) => {
    let closed = false;
    const close = (applied: boolean) => {
      if (closed) return;
      closed = true;
      preview.dispose(applied);
      closeSession(s);
      ui.dialog.close();
      ui.dialog.remove();
      e.update();
      resolve(applied);
    };
    ui.cancel.addEventListener('click', (ev) => {
      if (ev.altKey) {
        // Reset returns to the settings the dialog opened with.
        params = { ...initialParams };
        blending = initialBlending && { ...initialBlending };
        for (const f of forms) f.set(params);
        const mode = ui.blending.querySelector<HTMLSelectElement>('#fd-mode');
        if (mode && blending) {
          mode.value = blending.blend;
          for (const id of ['#fd-opacity', '#fd-opacity-range']) ui.blending.querySelector<HTMLInputElement>(id)!.value = String(Math.round(blending.opacity * 100));
        }
        update();
        return;
      }
      close(false);
    });
    ui.dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close(false);
    });
    ui.dialog.querySelector('form')!.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (ui.ok.disabled) return;
      ui.ok.disabled = true;
      try {
        const grid = await preview.finish();
        lastUsed.set(opId, params);
        commitSession(s, grid, opId, params, opLabel(opId), blending);
        if (!opts.edit && opts.record !== false) recordStep(e, commandId(opId), { params });
        close(true);
      } catch (error) {
        ui.ok.disabled = false;
        if (!isCancel(error)) e.message(error instanceof Error ? error.message : String(error));
      }
    });
    ui.dialog.showModal();
    ui.ok.focus();
  });
}
