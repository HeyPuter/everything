// Properties editor of relight layers: the list of lights (select, show or
// hide, reset, delete, add), the selected light's color and placement, and
// the scene controls (existing light, surface shape, shadows). The canvas
// handles (features/relight) share the selected light through relightUi.
import type { AdjustHost } from './host';
import { escapeXML } from '../../model/assets';
import { button, h, select, slider } from './ui';
import {
  LIGHT_DEFAULTS,
  MAX_LIGHTS,
  TEMPERATURE_PRESETS,
  fromLinear,
  lightCss,
  newLight,
  temperatureRgb,
  type RelightLight,
} from '../../imaging/relight/model';
import { relightUi, selectedLight, selectLight } from '../relight/state';
import { notifyRelight, relightListeners } from '../relight';

let listening: (() => void) | undefined;

const hex = (c: readonly number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (s: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) || 0) as [number, number, number];

/** A slider with captions under both ends of its track. */
function endSlider(
  label: string,
  ends: [string, string],
  o: Omit<Parameters<typeof slider>[0], 'label'>,
) {
  const s = slider({ label, ...o });
  s.el.classList.add('relight-end-slider');
  s.el.append(
    h(
      'div',
      { class: 'relight-ends', 'aria-hidden': 'true' },
      `<span>${escapeXML(ends[0])}</span><span>${escapeXML(ends[1])}</span>`,
    ),
  );
  s.el
    .querySelector('input[type=range]')
    ?.setAttribute('aria-description', `${ends[0]} to ${ends[1]}`);
  return s;
}

export function relightEditor(body: HTMLElement, host: AdjustHost<'relight'>) {
  const p = host.params;
  const layerId = host.layerId ?? '';
  body.classList.add('relight-editor');
  // The canvas selects lights too: show the selection made there.
  if (listening) relightListeners.delete(listening);
  listening = () => {
    if (body.isConnected) host.rerender();
    else if (listening) relightListeners.delete(listening);
  };
  relightListeners.add(listening);

  const sel = selectedLight(layerId, p);
  const choose = (id: string) => {
    selectLight(layerId, id);
    notifyRelight();
    host.e.overlay();
  };

  // ----- Lights -----
  const bar = h('div', { class: 'relight-bar' });
  const add = button(
    'Add Light',
    () => {
      if (p.lights.length >= MAX_LIGHTS) return;
      const light = newLight(p.lights);
      p.lights.push(light);
      selectLight(layerId, light.id);
      host.change(true, 'Add Light');
      host.rerender();
    },
    {
      icon: 'relight-add-light',
      title:
        p.lights.length >= MAX_LIGHTS
          ? `A relight layer holds up to ${MAX_LIGHTS} lights`
          : 'Add a light',
    },
  );
  add.disabled = p.lights.length >= MAX_LIGHTS;
  const show = button(
    'Show lights',
    () => {
      relightUi.hidden = !relightUi.hidden;
      host.e.overlay();
      notifyRelight();
    },
    {
      icon: relightUi.hidden ? 'eye-off' : 'eye',
      title: relightUi.hidden
        ? 'Show light handles on the canvas (N)'
        : 'Hide light handles on the canvas (N)',
      pressed: !relightUi.hidden,
      cls: 'icon-button',
    },
  );
  bar.append(add, show);
  body.append(bar);

  const list = h('div', { class: 'relight-lights', role: 'group', 'aria-label': 'Lights' });
  if (!p.lights.length)
    list.append(
      h(
        'p',
        { class: 'adj-note' },
        'No lights: the layer only dims the existing light. Add a light to relight the image.',
      ),
    );
  for (const light of p.lights) {
    const on = light.id === sel?.id;
    const row = h('div', {
      class: `relight-light${on ? ' selected' : ''}${light.visible ? '' : ' off'}`,
    });
    const pick = h('button', {
      type: 'button',
      class: 'relight-pick',
      'aria-pressed': String(on),
      title: `Edit ${light.name}`,
    });
    pick.innerHTML = `<span class="relight-swatch" style="background:${lightCss(light)}"></span><span class="relight-name">${escapeXML(light.name)}</span>`;
    pick.addEventListener('click', () => choose(light.id));
    const vis = button(
      light.visible ? 'Hide' : 'Show',
      () => {
        light.visible = !light.visible;
        host.change(true, light.visible ? 'Show Light' : 'Hide Light');
        host.rerender();
      },
      {
        icon: light.visible ? 'eye' : 'eye-off',
        title: `${light.visible ? 'Hide' : 'Show'} ${light.name}`,
        pressed: !light.visible,
        cls: 'icon-button',
      },
    );
    const reset = button(
      'Reset',
      () => {
        Object.assign(light, { ...LIGHT_DEFAULTS, x: light.x, y: light.y });
        host.change(true, 'Reset Light');
        host.rerender();
      },
      { icon: 'rotate-ccw', title: `Reset ${light.name} (keeps its position)`, cls: 'icon-button' },
    );
    const del = button(
      'Delete',
      () => {
        const i = p.lights.indexOf(light);
        p.lights.splice(i, 1);
        if (on) selectLight(layerId, p.lights[Math.min(i, p.lights.length - 1)]?.id);
        host.change(true, 'Delete Light');
        host.rerender();
      },
      { icon: 'trash-2', title: `Delete ${light.name}`, cls: 'icon-button' },
    );
    row.append(pick, vis, reset, del);
    list.append(row);
  }
  body.append(list);

  // ----- Selected light -----
  if (sel) body.append(lightControls(sel, host));

  // ----- Scene -----
  body.append(h('div', { class: 'adj-field-label relight-section' }, 'Scene'));
  const scene: [keyof typeof p, string, [string, string] | undefined][] = [
    ['ambient', 'Existing light', ['Dark', 'Unchanged']],
    ['relief', 'Surface relief', ['Flat', 'Deep']],
    ['detail', 'Surface detail', ['Broad forms', 'Fine detail']],
    ['shadows', 'Shadows', ['None', 'Strong']],
  ];
  for (const [key, label, ends] of scene) {
    const o = {
      min: 0,
      max: 100,
      value: p[key] as number,
      unit: key === 'ambient' || key === 'shadows' ? '%' : undefined,
      onInput: (v: number, c: boolean) => (
        ((p as Record<string, unknown>)[key] = v),
        host.change(c)
      ),
    };
    body.append((ends ? endSlider(label, ends, o) : slider({ label, ...o })).el);
  }
  body.append(
    h(
      'p',
      { class: 'adj-note relight-hint' },
      'Drag lights on the canvas. Arrow keys nudge the selected light (Shift: 10 px); N shows or hides the lights.',
    ),
  );
}

function lightControls(light: RelightLight, host: AdjustHost<'relight'>) {
  const box = h('div', {
    class: 'relight-selected',
    role: 'group',
    'aria-label': `${light.name} settings`,
  });
  box.append(h('div', { class: 'adj-field-label relight-section' }, escapeXML(light.name)));
  // Live previews draw the handles from the working copy.
  const change = (c: boolean, label: string) => {
    relightUi.draft = c ? undefined : { layerId: host.layerId ?? '', params: host.params };
    host.change(c, label);
    host.e.overlay();
  };

  // Color: a temperature preset, any temperature, or a custom color.
  const presetValue = light.color ? 'custom' : `k:${light.temperature}`;
  const options: [string, string][] = TEMPERATURE_PRESETS.map((t) => [
    `k:${t.kelvin}`,
    `${t.label} · ${t.kelvin} K`,
  ]);
  if (!light.color && !TEMPERATURE_PRESETS.some((t) => t.kelvin === light.temperature))
    options.push([presetValue, `Custom · ${light.temperature} K`]);
  options.push(['custom', 'Custom color']);
  const color = select('Color', options, presetValue, (v) => {
    if (v === 'custom') {
      light.color = temperatureRgb(light.temperature).map((c) =>
        Math.round(fromLinear(c) * 255),
      ) as [number, number, number];
    } else {
      light.color = null;
      light.temperature = Number(v.slice(2));
    }
    host.change(true, 'Change Light Color');
    host.rerender();
  });
  color.el.classList.add('relight-color');
  color.el.prepend(
    h('span', {
      class: 'relight-swatch',
      style: `background:${lightCss(light)}`,
      'aria-hidden': 'true',
    }),
  );
  box.append(color.el);
  if (light.color) {
    const row = h('label', { class: 'adj-select relight-custom' });
    row.innerHTML = `<span class="adj-field-label">Custom color</span><input type="color" value="${hex(light.color)}" aria-label="Custom light color">`;
    const input = row.querySelector('input')!;
    input.addEventListener(
      'input',
      () => ((light.color = fromHex(input.value)), host.change(false)),
    );
    input.addEventListener(
      'change',
      () => (
        (light.color = fromHex(input.value)),
        host.change(true, 'Change Light Color'),
        host.rerender()
      ),
    );
    box.append(row);
  } else {
    box.append(
      slider({
        label: 'Temperature',
        min: 1500,
        max: 12000,
        step: 100,
        unit: 'K',
        value: light.temperature,
        track: 'linear-gradient(90deg,#ff8a1f,#ffd9a8 35%,#fff 45%,#cfe0ff 70%,#9fbfff)',
        onInput: (v, c) => (
          (light.temperature = v),
          change(c, 'Change Light Color'),
          c && host.rerender()
        ),
      }).el,
    );
  }
  const pct = (v: number) => Math.round(v * 100);
  box.append(
    endSlider('Horizontal', ['Left', 'Right'], {
      min: -50,
      max: 150,
      unit: '%',
      value: pct(light.x),
      onInput: (v, c) => ((light.x = v / 100), change(c, 'Move Light')),
    }).el,
    endSlider('Vertical', ['Top', 'Bottom'], {
      min: -50,
      max: 150,
      unit: '%',
      value: pct(light.y),
      onInput: (v, c) => ((light.y = v / 100), change(c, 'Move Light')),
    }).el,
    endSlider('Depth', ['Behind', 'In front'], {
      min: -100,
      max: 100,
      value: light.depth,
      onInput: (v, c) => ((light.depth = v), change(c, 'Move Light')),
    }).el,
    slider({
      label: 'Brightness',
      min: 0,
      max: 200,
      unit: '%',
      value: light.brightness,
      track: 'linear-gradient(90deg,#000,#fff)',
      onInput: (v, c) => ((light.brightness = v), change(c, 'Change Light')),
    }).el,
    endSlider('Spread', ['Narrow', 'Wide'], {
      min: 0,
      max: 100,
      value: light.spread,
      onInput: (v, c) => ((light.spread = v), change(c, 'Change Light')),
    }).el,
    endSlider('Softness', ['Hard', 'Soft'], {
      min: 0,
      max: 100,
      value: light.softness,
      onInput: (v, c) => ((light.softness = v), change(c, 'Change Light')),
    }).el,
  );
  return box;
}
