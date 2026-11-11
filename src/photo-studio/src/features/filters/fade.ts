// Edit → Fade: blend the last filter (or adjustment) result with the state
// before it, by opacity and blend mode. Available only right after applying.
import type { Editor } from '../../editor';
import { findLayer } from '../../model/document';
import { setLayerPixels } from '../../model/pixel-layer';
import type { TileGrid } from '../../model/tiles';
import { isBlendMode, blendModes, type BlendMode } from '../../imaging/blend';
import type { IRect } from '../../imaging/types';
import { escapeXML } from '../../model/assets';
import { previewTarget, type PixelTarget } from '../pixels';
import { canFade, filterState } from './state';
import { Lane, isCancel, registerSource, releaseSource } from './client';
import { gridPayload, mergeTiles } from './tilepack';
import { recordStep } from './record';
import { makeMovable } from './dialog';

/** Let other features (adjustments) offer Fade for the result they just committed. */
export function rememberFade(e: Editor, info: { label: string; target: PixelTarget; before: TileGrid; after: TileGrid; rect: IRect }) {
  filterState.fade = { ...info, doc: e.doc, quick: info.target.kind === 'quick-mask' ? info.after : undefined };
}
export { canFade, fadeLabel } from './state';

const lane = new Lane('fade');
let keys = 0;

export async function fade(e: Editor, arg?: { opacity: number; mode: BlendMode }) {
  const f = filterState.fade;
  if (!f || !canFade(e)) return;
  const store = e.assets.tiles;
  const bk = `fadeA${++keys}`,
    ak = `fadeB${keys}`;
  registerSource({ type: 'load', key: bk, rect: f.rect, image: gridPayload(store, f.before, f.rect) });
  registerSource({ type: 'load', key: ak, rect: f.rect, image: gridPayload(store, f.after, f.rect) });
  const render = async (opacity: number, mode: BlendMode) => {
    const res = await lane.run({ type: 'fade', job: 0, beforeKey: bk, afterKey: ak, mode, opacity, output: 'tiles' }, [bk, ak]);
    return mergeTiles(store, f.after, res.tiles!);
  };
  const commit = (grid: TileGrid, opacity: number, mode: BlendMode) => {
    const label = `Fade ${f.label}`;
    // A fade cannot be faded again; clear it before the edit refreshes menus.
    filterState.fade = undefined;
    delete e.settings.quickMaskPreview;
    if (f.target.kind === 'quick-mask') {
      e.settings.quickMask = grid;
      e.update();
    } else {
      const id = f.target.layer.id,
        kind = f.target.kind;
      e.command(label, (d) => {
        const l = findLayer(d.layers, id);
        if (!l) return;
        if (kind === 'mask') l.maskGrid = grid;
        else setLayerPixels(l, grid, d);
      });
    }
    recordStep(e, 'edit.fade', { params: { opacity, mode } });
  };
  try {
    if (arg) {
      commit(await render(arg.opacity, arg.mode), arg.opacity, arg.mode);
      return;
    }
    await fadeDialog(e, f.label, render, commit, f.target);
  } catch (error) {
    if (!isCancel(error)) throw error;
  } finally {
    releaseSource(bk);
    releaseSource(ak);
  }
}

function fadeDialog(e: Editor, label: string, render: (o: number, m: BlendMode) => Promise<TileGrid>, commit: (g: TileGrid, o: number, m: BlendMode) => void, target: PixelTarget) {
  const dialog = document.createElement('dialog');
  dialog.className = 'filter-dialog fade-dialog';
  dialog.innerHTML = `<form method="dialog"><h2>Fade</h2><p class="fd-note">${escapeXML(label)}</p>
<div class="fp-row fp-number"><label for="fade-opacity">Opacity</label><input id="fade-opacity" type="number" min="0" max="100" value="100"><span class="fp-unit">%</span><input id="fade-range" type="range" min="0" max="100" value="100" aria-label="Opacity"></div>
<div class="fp-row"><label for="fade-mode">Mode</label><select id="fade-mode">${blendModes.map((m, i) => `${i && blendModes[i - 1].group !== m.group ? '<option disabled>──────────</option>' : ''}<option value="${m.id}">${escapeXML(m.label)}</option>`).join('')}</select></div>
<label class="fd-preview-toggle"><input type="checkbox" id="fade-preview" checked> Preview</label>
<div class="dialog-actions"><button type="button" class="fd-cancel">Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  document.body.append(dialog);
  makeMovable(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  let opacity = 1,
    mode: BlendMode = 'normal',
    latest: { key: string; grid: TileGrid } | undefined,
    timer = 0;
  const key = () => `${opacity}:${mode}`;
  const show = async () => {
    if (!q<HTMLInputElement>('#fade-preview').checked) {
      delete e.settings.quickMaskPreview;
      e.preview(e.doc);
      return;
    }
    const k = key();
    try {
      const grid = latest?.key === k ? latest.grid : await render(opacity, mode);
      latest = { key: k, grid };
      if (k === key()) e.preview(previewTarget(e, target, grid));
    } catch (error) {
      if (!isCancel(error)) e.message(String(error));
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void show(), 60);
  };
  dialog.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.id === 'fade-opacity' || t.id === 'fade-range') {
      // A cleared field is not 0%; it keeps the opacity until edited.
      if (t.value.trim() === '' || !Number.isFinite(Number(t.value))) return;
      const v = Math.max(0, Math.min(100, Number(t.value)));
      opacity = v / 100;
      q<HTMLInputElement>(t.id === 'fade-opacity' ? '#fade-range' : '#fade-opacity').value = String(v);
    } else if (t.id === 'fade-mode' && isBlendMode(t.value)) mode = t.value;
    schedule();
  });
  // Leaving the field shows the opacity in use (clamped, or kept when blank).
  q('#fade-opacity').addEventListener('change', (ev) => ((ev.target as HTMLInputElement).value = String(Math.round(opacity * 100))));
  q('#fade-preview').addEventListener('change', () => void show());
  return new Promise<void>((resolve) => {
    const close = () => {
      clearTimeout(timer);
      lane.cancel();
      dialog.close();
      dialog.remove();
      delete e.settings.quickMaskPreview;
      e.update();
      resolve();
    };
    q('.fd-cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('form')!.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearTimeout(timer);
      try {
        const grid = latest?.key === key() ? latest.grid : await render(opacity, mode);
        const [o, m] = [opacity, mode];
        close();
        commit(grid, o, m);
      } catch (error) {
        if (!isCancel(error)) e.message(String(error));
      }
    });
    dialog.showModal();
    void show();
  });
}
