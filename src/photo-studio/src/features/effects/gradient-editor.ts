import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import type { Gradient, NoiseGradient, SolidGradient, StopColor } from '../../imaging/gradient/gradient';
import {
  deleteStop, distributeStops, gradientToCss, insertColorStop, insertOpacityStop, moveStop, reverseGradient,
  setMidpoint, setStopColor, setStopOpacity, type StopKind,
} from '../../imaging/gradient/edit';
import { allGradientFolders, colors, loadUserGradients, saveUserGradients } from './state';
import { hexRgb, rgbHex } from '../pixels';
import { svg } from '../../app/icons';

// Gradient Editor: presets, solid gradients with color and opacity stops
// (location, midpoint, smoothness) or noise gradients, and saving presets.
// Resolves with the edited gradient, or null when cancelled.
const clampPct = (v: number) => Math.min(100, Math.max(0, v));
const noiseDefault = (): NoiseGradient => ({
  kind: 'noise', name: 'Noise', roughness: 50, model: 'rgb', min: [0, 0, 0], max: [1, 1, 1], restrictColors: true, addTransparency: false, seed: 1,
});
const solidFrom = (g: Gradient): SolidGradient =>
  g.kind === 'solid'
    ? structuredClone(g)
    : { kind: 'solid', name: 'Custom', smoothness: 100, colorStops: [{ location: 0, color: [0, 0, 0] }, { location: 1, color: [255, 255, 255] }], opacityStops: [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }] };

export function gradientEditor(e: Editor, initial: Gradient): Promise<Gradient | null> {
  return new Promise((resolve) => {
    let g: Gradient = structuredClone(initial);
    let lastSolid = solidFrom(initial);
    let selected: { kind: StopKind; index: number } | null = g.kind === 'solid' ? { kind: 'color', index: 0 } : null;
    const ctx = colors(e);
    const dialog = document.createElement('dialog');
    dialog.className = 'gradient-editor';
    dialog.setAttribute('aria-label', 'Gradient Editor');
    e.root.append(dialog);
    const finish = (value: Gradient | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const presetsHtml = () =>
      allGradientFolders()
        .map((f, fi) => `<div class="picker-folder"><span>${escapeXML(f.name)}</span><div class="picker-grid">${f.gradients.map((x, gi) => `<button type="button" data-preset="${fi}:${gi}" title="${escapeXML(x.name ?? 'Gradient')}" aria-label="${escapeXML(x.name ?? 'Gradient')}" style="background:${gradientToCss(x, ctx)}, var(--fx-checker)"></button>`).join('')}</div></div>`)
        .join('');
    const stopColorHex = (c: StopColor) => rgbHex(...(c === 'foreground' ? ctx.foreground : c === 'background' ? ctx.background : c));
    const render = () => {
      const solid = g.kind === 'solid' ? g : null;
      const sel = selected && solid ? (selected.kind === 'color' ? solid.colorStops[selected.index] : solid.opacityStops[selected.index]) : null;
      const stops = (kind: StopKind) =>
        solid
          ? (kind === 'color' ? solid.colorStops : solid.opacityStops)
              .map((s, i) => {
                const fill = kind === 'color' ? stopColorHex((s as { color: StopColor }).color) : `hsl(0 0% ${Math.round((s as { opacity: number }).opacity * 100)}%)`;
                const on = selected?.kind === kind && selected.index === i;
                return `<button type="button" class="ge-stop ${kind} ${on ? 'selected' : ''}" data-stop="${kind}:${i}" style="left:${s.location * 100}%;--stop:${fill}" aria-pressed="${on}" aria-label="${kind === 'color' ? 'Color' : 'Opacity'} stop at ${Math.round(s.location * 100)}%" title="Arrow keys move the stop; Delete removes it"></button>`;
              })
              .join('')
          : '';
      // Midpoint diamond between the selected stop and the next one.
      let midpoint = '';
      if (solid && selected) {
        const list = selected.kind === 'color' ? solid.colorStops : solid.opacityStops;
        const a = list[selected.index], b = list[selected.index + 1];
        if (a && b) midpoint = `<span class="ge-mid ${selected.kind}" data-mid style="left:${(a.location + (b.location - a.location) * ((a.midpoint ?? 50) / 100)) * 100}%" title="Midpoint ${Math.round(a.midpoint ?? 50)}%"></span>`;
      }
      dialog.innerHTML = `<form method="dialog"><h2>Gradient Editor</h2>
<div class="ge-presets">${presetsHtml()}</div>
<div class="ge-row"><label>Name <input data-name value="${escapeXML(g.name ?? 'Custom')}" maxlength="60"></label><button type="button" data-save>Save as Preset</button></div>
<div class="ge-row"><label>Gradient Type <select data-kind><option value="solid" ${solid ? 'selected' : ''}>Solid</option><option value="noise" ${solid ? '' : 'selected'}>Noise</option></select></label>
${solid ? `<label>Smoothness <input type="number" data-smooth min="0" max="100" value="${Math.round(solid.smoothness ?? 0)}">%</label><button type="button" class="icon-button" data-reverse title="Reverse" aria-label="Reverse gradient">${svg('arrow-left-right', 14)}</button><button type="button" data-distribute title="Space stops evenly">Distribute</button>` : ''}</div>
${solid ? `<div class="ge-bar-wrap"><div class="ge-track opacity" data-track="opacity">${stops('opacity')}${selected?.kind === 'opacity' ? midpoint : ''}</div><div class="ge-bar" style="background:${gradientToCss(g, ctx, 90, 48)}, var(--fx-checker)"></div><div class="ge-track color" data-track="color">${stops('color')}${selected?.kind === 'color' ? midpoint : ''}</div></div>
<fieldset class="ge-stops"><legend>Stops</legend>${sel ? `${selected!.kind === 'opacity' ? `<label>Opacity <input type="number" data-opacity min="0" max="100" value="${Math.round((sel as { opacity: number }).opacity * 100)}">%</label>` : `<label>Color <input type="color" data-color value="${stopColorHex((sel as { color: StopColor }).color)}"></label><label>Use <select data-color-source><option value="custom">Custom</option><option value="foreground" ${(sel as { color: StopColor }).color === 'foreground' ? 'selected' : ''}>Foreground</option><option value="background" ${(sel as { color: StopColor }).color === 'background' ? 'selected' : ''}>Background</option></select></label>`}<label>Location <input type="number" data-stop-location min="0" max="100" value="${Math.round(sel.location * 100)}">%</label><button type="button" data-delete ${(selected!.kind === 'color' ? solid.colorStops : solid.opacityStops).length <= 2 ? 'disabled' : ''}>Delete</button>` : '<span class="muted">Click above or below the bar to add a stop.</span>'}</fieldset>` : noiseHtml(g as NoiseGradient)}
<div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
    };
    const noiseHtml = (n: NoiseGradient) => {
      const labels = n.model === 'rgb' ? ['R', 'G', 'B'] : n.model === 'hsb' ? ['H', 'S', 'B'] : ['L', 'a', 'b'];
      return `<div class="ge-bar" style="background:${gradientToCss(n, ctx, 90, 64)}, var(--fx-checker)"></div>
<div class="ge-noise"><label>Roughness <input type="number" data-rough min="0" max="100" value="${Math.round(n.roughness)}">%</label><label>Color Model <select data-model>${['rgb', 'hsb', 'lab'].map((m) => `<option value="${m}" ${n.model === m ? 'selected' : ''}>${m.toUpperCase()}</option>`).join('')}</select></label>
${labels.map((c, i) => `<div class="ge-range"><span>${c}</span><input type="range" min="0" max="100" data-min="${i}" value="${Math.round(n.min[i] * 100)}" aria-label="${c} minimum"><input type="range" min="0" max="100" data-max="${i}" value="${Math.round(n.max[i] * 100)}" aria-label="${c} maximum"></div>`).join('')}
<label class="fx-check"><input type="checkbox" data-restrict ${n.restrictColors ? 'checked' : ''}>Restrict Colors</label><label class="fx-check"><input type="checkbox" data-transparency ${n.addTransparency ? 'checked' : ''}>Add Transparency</label><button type="button" data-randomize>Randomize</button></div>`;
    };
    const solid = () => g as SolidGradient;
    const update = () => {
      if (g.kind === 'solid') lastSolid = g;
      const name = dialog.querySelector<HTMLInputElement>('[data-name]')?.value;
      // Rendering replaces the stop buttons; keyboard focus follows the selected stop.
      const stopFocused = !!document.activeElement?.closest('[data-stop]') && dialog.contains(document.activeElement);
      render();
      if (name !== undefined) dialog.querySelector<HTMLInputElement>('[data-name]')!.value = name;
      if (stopFocused && selected) dialog.querySelector<HTMLElement>(`[data-stop="${selected.kind}:${selected.index}"]`)?.focus();
    };
    dialog.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = dialog.querySelector<HTMLInputElement>('[data-name]')?.value.trim();
      finish({ ...g, name: name || g.name });
    });
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish(null);
    });
    dialog.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('[data-cancel]')) return finish(null);
      // Enter or Space on a stop selects it (pointer presses select on pointerdown).
      const stopEl = t.closest<HTMLElement>('[data-stop]');
      if (stopEl && g.kind === 'solid') {
        const [kind, i] = stopEl.dataset.stop!.split(':');
        if (selected?.kind !== kind || selected.index !== Number(i)) {
          selected = { kind: kind as StopKind, index: Number(i) };
          update();
        }
        return;
      }
      const preset = t.closest<HTMLElement>('[data-preset]')?.dataset.preset;
      if (preset) {
        const [fi, gi] = preset.split(':').map(Number);
        g = structuredClone(allGradientFolders()[fi].gradients[gi]);
        selected = g.kind === 'solid' ? { kind: 'color', index: 0 } : null;
        return update();
      }
      if (t.closest('[data-save]')) {
        const name = dialog.querySelector<HTMLInputElement>('[data-name]')?.value.trim() || 'Custom';
        saveUserGradients([...loadUserGradients(), { ...structuredClone(g), name }]);
        e.dock?.update();
        return update();
      }
      if (t.closest('[data-reverse]')) {
        g = reverseGradient(solid());
        if (selected) selected = { kind: selected.kind, index: (selected.kind === 'color' ? solid().colorStops : solid().opacityStops).length - 1 - selected.index };
        return update();
      }
      if (t.closest('[data-distribute]')) {
        g = distributeStops(distributeStops(solid(), 'color'), 'opacity');
        return update();
      }
      if (t.closest('[data-delete]') && selected) {
        g = deleteStop(solid(), selected.kind, selected.index);
        selected = { kind: selected.kind, index: Math.max(0, selected.index - 1) };
        return update();
      }
      if (t.closest('[data-randomize]')) {
        g = { ...(g as NoiseGradient), seed: (Math.random() * 2 ** 31) | 0 };
        return update();
      }
    });
    dialog.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      const n = g as NoiseGradient;
      if (t.matches('[data-kind]')) {
        g = t.value === 'noise' ? { ...noiseDefault(), name: g.name } : lastSolid;
        selected = g.kind === 'solid' ? { kind: 'color', index: 0 } : null;
      } else if (t.matches('[data-smooth]')) g = { ...solid(), smoothness: clampPct(Number(t.value) || 0) };
      else if (t.matches('[data-opacity]') && selected) g = setStopOpacity(solid(), selected.index, clampPct(Number(t.value) || 0) / 100);
      else if (t.matches('[data-color-source]') && selected) {
        const s = solid().colorStops[selected.index];
        g = setStopColor(solid(), selected.index, t.value === 'custom' ? hexRgb(stopColorHex(s.color)) : (t.value as StopColor));
      } else if (t.matches('[data-stop-location]') && selected) {
        const moved = moveStop(solid(), selected.kind, selected.index, clampPct(Number(t.value) || 0) / 100);
        g = moved.gradient;
        selected = { kind: selected.kind, index: moved.index };
      } else if (t.matches('[data-rough]')) g = { ...n, roughness: clampPct(Number(t.value) || 0) };
      else if (t.matches('[data-model]')) g = { ...n, model: t.value as NoiseGradient['model'] };
      else if (t.matches('[data-restrict]')) g = { ...n, restrictColors: t.checked };
      else if (t.matches('[data-transparency]')) g = { ...n, addTransparency: t.checked };
      else if (t.dataset.min !== undefined || t.dataset.max !== undefined) {
        const i = Number(t.dataset.min ?? t.dataset.max);
        const v = Number(t.value) / 100;
        const min = [...n.min] as [number, number, number], max = [...n.max] as [number, number, number];
        if (t.dataset.min !== undefined) min[i] = Math.min(v, max[i]);
        else max[i] = Math.max(v, min[i]);
        g = { ...n, min, max };
      } else return;
      update();
    });
    dialog.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.matches('[data-color]') && selected) {
        g = setStopColor(solid(), selected.index, hexRgb(t.value));
        const bar = dialog.querySelector<HTMLElement>('.ge-bar');
        if (bar) bar.style.background = `${gradientToCss(g, ctx, 90, 48)}, var(--fx-checker)`;
        const stop = dialog.querySelector<HTMLElement>(`[data-stop="color:${selected.index}"]`);
        stop?.style.setProperty('--stop', t.value);
      }
    });
    // Stops from the keyboard: arrows move the focused stop (Shift: 10%), Delete removes it.
    dialog.addEventListener('keydown', (ev) => {
      const stopEl = (ev.target as HTMLElement).closest<HTMLElement>('[data-stop]');
      if (!stopEl || g.kind !== 'solid') return;
      const [kind, i] = stopEl.dataset.stop!.split(':') as [StopKind, string];
      const index = Number(i);
      const list = kind === 'color' ? solid().colorStops : solid().opacityStops;
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        const step = (ev.shiftKey ? 0.1 : 0.01) * (ev.key === 'ArrowLeft' ? -1 : 1);
        const to = ev.key === 'Home' ? 0 : ev.key === 'End' ? 1 : Math.round((list[index].location + step) * 1000) / 1000;
        const moved = moveStop(solid(), kind, index, to);
        g = moved.gradient;
        selected = { kind, index: moved.index };
        update();
      } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && list.length > 2) {
        ev.preventDefault();
        g = deleteStop(solid(), kind, index);
        selected = { kind, index: Math.max(0, index - 1) };
        update();
      }
    });
    // Stops: click a track to add, drag to move, drag away to delete.
    dialog.addEventListener('pointerdown', (ev) => {
      const t = ev.target as HTMLElement;
      const track = t.closest<HTMLElement>('[data-track]');
      if (!track || g.kind !== 'solid') return;
      const kind = track.dataset.track as StopKind;
      const rect = track.getBoundingClientRect();
      const at = (x: number) => Math.min(1, Math.max(0, (x - rect.left) / rect.width));
      ev.preventDefault();
      if (t.closest('[data-mid]') && selected) {
        const list = kind === 'color' ? solid().colorStops : solid().opacityStops;
        const a = list[selected.index], b = list[selected.index + 1];
        const index = selected.index;
        const move = (p: PointerEvent) => {
          const pos = at(p.clientX);
          g = setMidpoint(solid(), kind, index, ((pos - a.location) / Math.max(1e-6, b.location - a.location)) * 100);
          update();
        };
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
        return;
      }
      const stopEl = t.closest<HTMLElement>('[data-stop]');
      let index: number;
      if (stopEl) index = Number(stopEl.dataset.stop!.split(':')[1]);
      else {
        const inserted = kind === 'color' ? insertColorStop(solid(), at(ev.clientX), undefined, ctx) : insertOpacityStop(solid(), at(ev.clientX));
        g = inserted.gradient;
        index = inserted.index;
      }
      selected = { kind, index };
      update();
      const startY = ev.clientY;
      const move = (p: PointerEvent) => {
        if (!selected) return;
        const away = Math.abs(p.clientY - startY) > 40;
        const count = (kind === 'color' ? solid().colorStops : solid().opacityStops).length;
        dialog.querySelector<HTMLElement>(`[data-stop="${kind}:${selected.index}"]`)?.classList.toggle('removing', away && count > 2);
        if (away) return;
        const moved = moveStop(solid(), kind, selected.index, at(p.clientX));
        g = moved.gradient;
        selected = { kind, index: moved.index };
        update();
      };
      const up = (p: PointerEvent) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        // A gradient keeps at least two stops of each kind; dropping one of them does nothing.
        if (selected && Math.abs(p.clientY - startY) > 40 && (kind === 'color' ? solid().colorStops : solid().opacityStops).length > 2) {
          g = deleteStop(solid(), kind, selected.index);
          selected = { kind, index: Math.max(0, selected.index - 1) };
          update();
        }
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    render();
    dialog.showModal();
  });
}
