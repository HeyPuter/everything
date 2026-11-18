// Filter Gallery: stack several texture-like effects (effect layers with their
// own settings, order and visibility) and preview them together.
import type { Editor } from '../../editor';
import { findLayer } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { defaults, type ParamValues } from '../../imaging/types';
import { svg } from '../../app/icons';
import { GALLERY_ID, filterOp, galleryEffects, galleryGroups, normalizeParams, type GalleryEffect } from './catalog';
import { closeSession, commitSession, isLiveLayer, openSession, sessionEntries } from './apply';
import { Lane, isCancel } from './client';
import { FilterPreview, toCanvas } from './preview';
import { paramForm } from './form';
import { dialogShell, lastUsed } from './dialog';
import { recordStep } from './record';

const thumbLane = new Lane('thumbs');

export async function galleryDialog(e: Editor, opts: { edit?: { layerId: string; index: number }; initial?: ParamValues } = {}): Promise<boolean> {
  let effects: GalleryEffect[];
  if (opts.edit) {
    const l = findLayer(e.doc.layers, opts.edit.layerId);
    const f = isLiveLayer(l) ? l.liveFilters[opts.edit.index] : undefined;
    if (!f) return false;
    effects = galleryEffects(f.params as ParamValues);
  } else effects = galleryEffects(opts.initial ?? lastUsed.get(GALLERY_ID) ?? ({} as ParamValues));
  if (!effects.length) effects = [{ id: 'oil-paint', params: defaults(filterOp('oil-paint')!), enabled: true }];
  let selected = effects.length - 1;
  const params = () => ({ effects: effects.map((x) => ({ ...x, params: { ...x.params } })) }) as unknown as ParamValues;
  const session = await openSession(e, GALLERY_ID, params(), opts.edit);
  if (!session) return false;
  const s = session;
  const paneW = Math.max(300, Math.min(560, window.innerWidth - 640)),
    paneH = Math.max(240, Math.min(460, window.innerHeight - 220));
  const ui = dialogShell(`Filter Gallery${s.live ? ' (Live Filter)' : ''}`, 'gallery', paneW, paneH);
  const browser = document.createElement('div');
  browser.className = 'fg-browser';
  browser.innerHTML = galleryGroups
    .map(
      (g) => `<details open><summary>${escapeXML(g.label)}</summary><div class="fg-thumbs">${g.ids
        .filter((id) => filterOp(id))
        .map((id) => `<button type="button" class="fg-thumb" data-effect="${id}" title="${escapeXML(filterOp(id)!.label)}"><span class="fg-img" data-thumb="${id}"></span><span class="fg-label">${escapeXML(filterOp(id)!.label)}</span></button>`)
        .join('')}</div></details>`,
    )
    .join('');
  ui.dialog.querySelector('.fd-main')!.insertBefore(browser, ui.dialog.querySelector('.fd-right'));
  ui.extra.innerHTML = `<div class="fp-row"><label for="fg-effect">Effect</label><select id="fg-effect">${galleryGroups.map((g) => `<optgroup label="${escapeXML(g.label)}">${g.ids.filter((id) => filterOp(id)).map((id) => `<option value="${id}">${escapeXML(filterOp(id)!.label)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
  const preview = new FilterPreview(s, { pane: ui.pane, progress: ui.progress, zoomLabel: ui.zoomLabel });
  const update = () => preview.setEntries(sessionEntries(s, GALLERY_ID, params()));

  const renderLayers = () => {
    ui.blending.innerHTML = `<h3>Effect Layers</h3><div class="fg-layers" role="listbox" aria-label="Effect layers">${effects
      .map((x, i) => ({ x, i }))
      .reverse()
      .map(({ x, i }) => `<div class="fg-layer ${i === selected ? 'selected' : ''} ${x.enabled ? '' : 'disabled'}" role="option" aria-selected="${i === selected}" data-layer-index="${i}"><button type="button" class="eye" data-eye="${i}" aria-label="${x.enabled ? 'Hide' : 'Show'} ${escapeXML(filterOp(x.id)!.label)}">${x.enabled ? svg('eye', 14) : ''}</button><span>${escapeXML(filterOp(x.id)!.label)}</span></div>`)
      .join('')}</div><div class="fg-layer-buttons"><button type="button" class="icon-button" data-act="up" title="Move effect up" aria-label="Move effect up" ${selected >= effects.length - 1 ? 'disabled' : ''}>${svg('arrow-up', 14)}</button><button type="button" class="icon-button" data-act="down" title="Move effect down" aria-label="Move effect down" ${selected <= 0 ? 'disabled' : ''}>${svg('arrow-down', 14)}</button><button type="button" class="icon-button" data-act="new" title="New effect layer" aria-label="New effect layer">${svg('plus', 14)}</button><button type="button" class="icon-button" data-act="delete" title="Delete effect layer" aria-label="Delete effect layer" ${effects.length <= 1 ? 'disabled' : ''}>${svg('trash-2', 14)}</button></div>`;
    for (const b of browser.querySelectorAll<HTMLElement>('[data-effect]')) b.classList.toggle('selected', b.dataset.effect === effects[selected]?.id);
    ui.extra.querySelector<HTMLSelectElement>('#fg-effect')!.value = effects[selected].id;
  };
  const renderParams = () => {
    const x = effects[selected];
    const op = filterOp(x.id)!;
    // A fresh host per effect: the form binds its listeners to it.
    const host = document.createElement('div');
    ui.params.replaceChildren(host);
    if (op.params.length)
      paramForm(host, op.params, x.params, (v) => {
        x.params = { ...x.params, ...v };
        update();
      });
    else host.innerHTML = `<p class="fd-note">${escapeXML(op.label)} has no settings.</p>`;
  };
  const choose = (id: string) => {
    const op = filterOp(id);
    if (!op) return;
    effects[selected] = { id, params: normalizeParams(op.params, lastUsed.get(id) ?? defaults(op)), enabled: true };
    renderLayers();
    renderParams();
    update();
  };
  browser.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-effect]');
    if (b) choose(b.dataset.effect!);
  });
  ui.extra.addEventListener('change', (ev) => choose((ev.target as HTMLSelectElement).value));
  ui.blending.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const eye = t.closest<HTMLElement>('[data-eye]');
    if (eye) {
      const x = effects[Number(eye.dataset.eye)];
      x.enabled = !x.enabled;
      renderLayers();
      update();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'new') {
      effects.splice(selected + 1, 0, { ...effects[selected], params: { ...effects[selected].params } });
      selected++;
    } else if (act === 'delete' && effects.length > 1) {
      effects.splice(selected, 1);
      selected = Math.max(0, selected - 1);
    } else if (act === 'up' && selected < effects.length - 1) {
      [effects[selected], effects[selected + 1]] = [effects[selected + 1], effects[selected]];
      selected++;
    } else if (act === 'down' && selected > 0) {
      [effects[selected], effects[selected - 1]] = [effects[selected - 1], effects[selected]];
      selected--;
    } else {
      const row = t.closest<HTMLElement>('[data-layer-index]');
      if (!row) return;
      selected = Number(row.dataset.layerIndex);
      renderLayers();
      renderParams();
      return;
    }
    renderLayers();
    renderParams();
    update();
  });
  renderLayers();
  renderParams();
  update();
  preview.setZoom(Math.max(preview.fitZoom(), 0.5));
  void loadThumbs();
  async function loadThumbs() {
    let k = 0,
      w = s.rect.width,
      h = s.rect.height;
    while (Math.max(w, h) > 128 && k < 12) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      k++;
    }
    const ids = galleryGroups.flatMap((g) => g.ids).filter((id) => filterOp(id));
    try {
      const res = await thumbLane.run(
        { type: 'thumbs', job: 0, key: s.key, view: { level: k, x: 0, y: 0, width: w, height: h }, filters: ids.map((id) => [{ id, params: defaults(filterOp(id)!), seed: 1 }]), ctx: { foreground: [0, 0, 0], background: [255, 255, 255] } },
        [s.key],
      );
      res.images?.forEach((img, i) => {
        const slot = browser.querySelector(`[data-thumb="${ids[i]}"]`);
        if (slot) slot.replaceChildren(toCanvas(img));
      });
    } catch (error) {
      if (!isCancel(error)) console.warn(error);
    }
  }
  ui.dialog.addEventListener('click', (ev) => {
    const z = (ev.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (z) preview.stepZoom(Number(z.dataset.zoom) as 1 | -1);
  });
  ui.previewToggle.addEventListener('change', () => preview.setCanvasPreview(ui.previewToggle.checked));
  ui.stop.addEventListener('click', () => preview.cancel());
  const initial = JSON.stringify(effects);
  return new Promise<boolean>((resolve) => {
    let closed = false;
    const close = (applied: boolean) => {
      if (closed) return;
      closed = true;
      thumbLane.cancel();
      preview.dispose(applied);
      closeSession(s);
      ui.dialog.close();
      ui.dialog.remove();
      e.update();
      resolve(applied);
    };
    ui.cancel.addEventListener('click', (ev) => {
      if (ev.altKey) {
        effects = JSON.parse(initial);
        selected = effects.length - 1;
        renderLayers();
        renderParams();
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
        const p = params();
        lastUsed.set(GALLERY_ID, p);
        for (const x of effects) lastUsed.set(x.id, x.params);
        commitSession(s, grid, GALLERY_ID, p, 'Filter Gallery');
        if (!opts.edit) recordStep(e, 'filter.gallery', { params: p });
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
