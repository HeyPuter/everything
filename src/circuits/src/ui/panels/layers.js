// Layers panel (board view configuration): visibility, colors, the current
// layer, single layer mode and display options.

import { h, clear } from '../dom.js';
import { LAYERS, boardLayers } from '../../model/layers.js';

export class LayersPanel {
  constructor(app) {
    this.app = app;
    this.el = h('section.panel', { 'aria-labelledby': 'layers-title' });
    this.body = h('div.panel-scroll');
    this.el.append(h('div.panel-head', h('h2#layers-title', 'Layers')), this.body);
  }

  refresh() {
    clear(this.body);
    const ed = this.app.activeEditor;
    if (!ed || ed.kind !== 'pcb') { this.body.append(h('div.panel-empty', 'Open a board to configure its layers.')); return; }
    const s = this.app.settings;
    const list = h('ul.list', { role: 'list' });
    for (const l of boardLayers(ed.copperCount)) {
      const vis = !ed.hiddenLayers.has(l);
      const cb = h('input', { type: 'checkbox', checked: vis, 'aria-label': `Show ${LAYERS[l].name}`, disabled: l === ed.activeLayer });
      cb.addEventListener('change', () => ed.setLayerVisible(l, cb.checked));
      const color = h('input', { type: 'color', value: ed.layerColor(l).slice(0, 7), 'aria-label': `${LAYERS[l].name} color`, style: { width: '26px', height: '20px', padding: 0, border: 0, background: 'none' } });
      color.addEventListener('change', () => s.set('layerColors', { ...s.get('layerColors'), [l]: color.value }));
      const radio = h('input', { type: 'radio', name: 'active-layer', checked: l === ed.activeLayer, 'aria-label': `Make ${LAYERS[l].name} current` });
      radio.addEventListener('change', () => ed.setActiveLayer(l));
      list.append(h('li.list-row', { 'aria-current': l === ed.activeLayer ? 'true' : null }, cb, color, h('span.grow', LAYERS[l].name), radio));
    }
    const opt = (label, key) => {
      const cb = h('input', { type: 'checkbox', checked: !!s.get(key) });
      cb.addEventListener('change', () => { s.set(key, cb.checked); ed.requestRender(true); });
      return h('label.check-row', cb, label);
    };
    const mode = h('select.field', { 'aria-label': 'Single layer mode' },
      [['off', 'Show all layers'], ['gray', 'Gray other layers'], ['hide', 'Hide other layers']].map(([v, t]) => h('option', { value: v, selected: ed.singleLayer === v }, t)));
    mode.addEventListener('change', () => ed.setSingleLayer(mode.value));
    this.body.append(
      list,
      h('div', { style: { padding: '8px 10px', display: 'grid', gap: '8px' } },
        h('label.muted.small', 'Single layer mode'), mode,
        opt('Net names on pads', 'padLabels'),
        opt('Heads-up coordinate display', 'showHud'),
        opt('Check rules while editing', 'onlineDrc'),
        opt('Repour polygons automatically', 'autoRepour'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button.btn.sm', { type: 'button', onClick: () => { ed.hiddenLayers.clear(); ed._layersChanged(); this.refresh(); } }, 'Show all'),
          h('button.btn.sm', { type: 'button', onClick: () => { s.set('layerColors', {}); this.refresh(); } }, 'Reset colors'))),
    );
  }
}
