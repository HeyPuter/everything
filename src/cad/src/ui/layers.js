/**
 * Layer Properties manager: create, rename, delete and edit layers, set the
 * current layer, and toggle visibility, freezing, locking and plotting.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { colorLabel, colorCss } from '../core/colors.js';
import { defaultLayer, freeTableName, LINEWEIGHTS, LW_DEFAULT } from '../core/schema.js';
import { lwLabel } from './combos.js';
import { confirmDialog } from './dialog.js';
import { preserveFocus, keepScroll } from './focus.js';

export class LayerManager {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.selected = null;
    this.search = h('input.input.sm', { type: 'search', placeholder: 'Search layers', 'aria-label': 'Search layers', spellcheck: 'false' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.status = h('div.lm-status');
    // Explicit messages (not every re-render) are announced.
    this.live = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    this.tbody = h('tbody');
    const th = (label, cls = '', title) => h(`th${cls}`, { scope: 'col', title: title || null }, label);
    this.table = h(
      'table.lm-table',
      { 'aria-label': 'Layers' },
      h(
        'thead',
        h(
          'tr',
          h('th.lm-c-cur', { scope: 'col' }, h('span.sr-only', 'Current')),
          th('Name', '.lm-c-name'),
          th('On', '.lm-c-tg'),
          th('Freeze', '.lm-c-tg'),
          th('Lock', '.lm-c-tg'),
          th('Plot', '.lm-c-tg'),
          th('Color', '.lm-c-color'),
          th('Linetype', '.lm-c-lt'),
          th('Lineweight', '.lm-c-lw'),
          th('Transparency', '.lm-c-tr'),
          th('Description', '.lm-c-desc'),
        ),
      ),
      this.tbody,
    );
    this.el = h(
      'div.lm',
      h(
        'div.lm-toolbar',
        h('button.btn.sm', { type: 'button', onClick: () => this.newLayer(), 'data-tip': 'New layer', 'data-tip-keys': 'Alt+N' }, icon('layer-new', 16), h('span', 'New')),
        h('button.btn.sm', { type: 'button', onClick: () => this.deleteLayer(), 'data-tip': 'Delete layer' }, icon('layer-delete', 16), h('span', 'Delete')),
        h('button.btn.sm', { type: 'button', onClick: () => this.makeCurrent(), 'data-tip': 'Set current', 'data-tip-keys': 'Alt+C' }, icon('layer-current', 16), h('span', 'Set current')),
        h('div.grow'),
        this.search,
      ),
      h('div.lm-scroll', this.table),
      this.status,
      this.live,
    );
    this.el.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      // On macOS, Option changes the key (Option+N is a dead key, Option+C
      // types ç), so use the physical key, except in text fields where those
      // characters are being typed.
      const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea');
      const k = /^[a-z]$/i.test(e.key) || typing ? e.key.toLowerCase() : e.code.replace(/^Key/, '').toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        this.newLayer();
      } else if (k === 'c') {
        e.preventDefault();
        this.makeCurrent();
      }
    });
  }

  get drawing() {
    return this.app.doc.drawing;
  }

  refresh() {
    if (!this.el.isConnected) return;
    if (this.el.contains(document.activeElement) && document.activeElement.matches('input:not([type=search]), select')) return;
    preserveFocus(this.el, () => this.render());
  }

  usage() {
    const counts = new Map();
    for (const e of this.drawing.entities.values()) counts.set(e.layer, (counts.get(e.layer) || 0) + 1);
    return counts;
  }

  render() {
    if (!this.app.doc) return;
    const d = this.drawing;
    const counts = this.usage();
    const names = [...d.layers.keys()].sort((a, b) => (a === '0' ? -1 : b === '0' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    const restoreScroll = keepScroll(this.table.parentElement);
    clear(this.tbody);
    let shown = 0;
    for (const name of names) {
      if (this.query && !name.toLowerCase().includes(this.query)) continue;
      shown++;
      const l = d.layers.get(name);
      const cur = name === d.header.clayer;
      const tg = (prop, onI, offI, label, invert = false) => {
        const active = invert ? !l[prop] : !!l[prop];
        return h(
          'td.lm-c-tg',
          h(
            'button.icon-btn.sm',
            {
              type: 'button',
              'aria-pressed': String(active),
              'aria-label': `${label} for layer ${name}`,
              'data-tip': label,
              'data-key': `layer:${name}:${prop}`,
              onClick: (e) => {
                e.stopPropagation();
                if (prop === 'frozen' && cur && !l.frozen) {
                  this.say('The current layer cannot be frozen.');
                  return;
                }
                this.app.setLayerProp(name, { [prop]: !l[prop] });
              },
            },
            icon(l[prop] ? onI : offI, 16),
          ),
        );
      };
      const nameCell = h('td.lm-c-name');
      const nameBtn = h(
        'button.lm-name',
        {
          type: 'button',
          'data-key': `layer:${name}:name`,
          'aria-pressed': String(this.selected === name),
          'aria-label': `Layer ${name}${cur ? ', current' : ''}. Press F2 to rename.`,
          onDblclick: () => this.rename(name, nameCell),
          onKeydown: (e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              e.stopPropagation();
              this.rename(name, nameCell);
            }
          },
        },
        name,
      );
      nameCell.append(nameBtn);
      const lt = h('select.input.sm', { 'aria-label': `Linetype for layer ${name}` }, [...d.linetypes.keys()].map((n) => h('option', { value: n, selected: n === l.linetype }, n)));
      lt.addEventListener('change', () => this.app.setLayerProp(name, { linetype: lt.value }));
      const lw = h('select.input.sm', { 'aria-label': `Lineweight for layer ${name}` }, [LW_DEFAULT, ...LINEWEIGHTS].map((w) => h('option', { value: w, selected: w === l.lineweight }, lwLabel(w))));
      lw.addEventListener('change', () => this.app.setLayerProp(name, { lineweight: Number(lw.value) }));
      const tr = h('input.input.sm', { type: 'number', min: 0, max: 90, step: 5, value: l.transparency || 0, 'aria-label': `Transparency for layer ${name}` });
      tr.addEventListener('change', () => {
        const v = Math.max(0, Math.min(90, Number(tr.value) || 0));
        // Show the value actually stored (the field keeps focus, so no re-render updates it).
        tr.value = v;
        this.app.setLayerProp(name, { transparency: v });
      });
      const desc = h('input.input.sm', { type: 'text', value: l.description || '', 'aria-label': `Description for layer ${name}` });
      desc.addEventListener('change', () => this.app.setLayerProp(name, { description: desc.value }));
      for (const el of [tr, desc]) el.addEventListener('keydown', (e) => e.stopPropagation());
      const row = h(
        `tr${cur ? '.current' : ''}${this.selected === name ? '.selected' : ''}`,
        { onClick: () => this.select(name) },
        h(
          'td.lm-c-cur',
          h(
            'button.icon-btn.sm',
            { type: 'button', 'data-key': `layer:${name}:cur`, 'aria-label': cur ? `${name} is the current layer` : `Make ${name} current`, 'aria-pressed': String(cur), onClick: () => this.app.setCurrentLayer(name) },
            cur ? icon('check', 16) : h('span.lm-dot', { class: counts.get(name) ? 'used' : '' }),
          ),
        ),
        nameCell,
        tg('on', 'eye', 'eye-off', 'Visible'),
        tg('frozen', 'freeze', 'thaw', 'Frozen'),
        tg('locked', 'lock', 'unlock', 'Locked'),
        tg('plot', 'printer', 'x', 'Plot'),
        h(
          'td.lm-c-color',
          h(
            'button.input.sm.color-field',
            {
              type: 'button',
              'data-key': `layer:${name}:color`,
              'aria-label': `Color for layer ${name}: ${colorLabel(l.color)}`,
              onClick: async () => {
                const c = await this.app.colorDialog(l.color, { allowBy: false });
                if (c !== null && c !== undefined) this.app.setLayerProp(name, { color: c });
              },
            },
            h('span.swatch', { style: { background: colorCss(l.color) } }),
            h('span', colorLabel(l.color)),
          ),
        ),
        h('td.lm-c-lt', lt),
        h('td.lm-c-lw', lw),
        h('td.lm-c-tr', tr),
        h('td.lm-c-desc', desc),
      );
      this.tbody.append(row);
    }
    restoreScroll();
    this.status.textContent = `${shown} of ${names.length} layers shown. Current layer: ${d.header.clayer}.`;
  }

  /** Show and announce a message. */
  say(msg) {
    this.status.textContent = msg;
    this.live.textContent = msg;
  }

  select(name) {
    this.selected = name;
    for (const tr of this.tbody.children) {
      const btn = tr.querySelector('.lm-name');
      const on = btn?.textContent === name;
      tr.classList.toggle('selected', on);
      btn?.setAttribute('aria-pressed', String(on));
    }
  }

  uniqueName(base = 'Layer') {
    return freeTableName(this.drawing.layers, base);
  }

  newLayer() {
    const d = this.drawing;
    const name = this.uniqueName();
    const src = d.layers.get(this.selected) ?? null;
    const l = src ? { ...src, name, on: true, frozen: false, locked: false, description: '' } : defaultLayer(name);
    d.transaction('New layer', () => d.setTable('layers', name, l));
    this.selected = name;
    this.render();
    const cell = [...this.tbody.querySelectorAll('.lm-name')].find((b) => b.textContent === name)?.parentElement;
    if (cell) this.rename(name, cell);
  }

  rename(name, cell) {
    if (name === '0') {
      this.say('Layer 0 cannot be renamed.');
      return;
    }
    const inp = h('input.input.sm', { type: 'text', value: name, 'aria-label': `New name for layer ${name}` });
    clear(cell).append(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      let err = null;
      if (ok && v && v !== name) {
        err = this.app.renameLayer(name, v);
        if (!err) this.selected = v;
      }
      this.render();
      // Focus the (possibly renamed) layer again, and show any error after the re-render.
      const shown = err || !v ? name : v;
      [...this.tbody.querySelectorAll('.lm-name')].find((b) => b.textContent === shown)?.focus();
      if (err) this.say(err);
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }

  async deleteLayer() {
    const name = this.selected;
    const d = this.drawing;
    if (!name) {
      this.say('Select a layer to delete first.');
      return;
    }
    if (name === '0' || name === d.header.clayer) {
      this.say(name === '0' ? 'Layer 0 cannot be deleted.' : 'The current layer cannot be deleted.');
      return;
    }
    const used = this.usage().get(name) || 0;
    const inBlocks = [...d.blocks.values()].some((b) => b.entities.some((e) => e.layer === name));
    if (used || inBlocks) {
      const ok = await confirmDialog('Delete layer?', `"${name}" holds ${used} object${used === 1 ? '' : 's'}${inBlocks ? ' and is used in blocks' : ''}. Deleting it also deletes those objects.`, { confirm: 'Delete layer and objects', danger: true });
      if (!ok) return;
    }
    d.transaction('Delete layer', () => {
      for (const [id, e] of d.entities) if (e.layer === name) d.remove(id);
      for (const b of d.blocks.values()) {
        if (b.entities.some((e) => e.layer === name)) d.setBlock(b.name, { ...b, entities: b.entities.map((e) => (e.layer === name ? { ...e, layer: '0' } : e)) });
      }
      d.setTable('layers', name, null);
    });
    this.selected = null;
    this.render();
  }

  makeCurrent() {
    if (this.selected) this.app.setCurrentLayer(this.selected);
  }
}
