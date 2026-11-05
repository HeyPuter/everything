/**
 * Status bar: coordinate readout and drafting aid toggles (grid, snap,
 * ortho, polar tracking, object snaps, tracking, dynamic input,
 * lineweights) with their option menus.
 */
import { h } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { SNAP_MODES } from '../editor/snap.js';
import { formatLinear, formatAngle } from '../core/units.js';

export const TOGGLES = [
  { key: 'grid', label: 'Grid', icon: 'grid', keys: 'F7' },
  { key: 'snap', label: 'Snap to grid', icon: 'snap', keys: 'F9', menu: 'snap' },
  { key: 'ortho', label: 'Ortho mode', icon: 'ortho', keys: 'F8' },
  { key: 'polar', label: 'Polar tracking', icon: 'polar', keys: 'F10', menu: 'polar' },
  { key: 'osnap', label: 'Object snap', icon: 'osnap', keys: 'F3', menu: 'osnap' },
  { key: 'otrack', label: 'Object snap tracking', icon: 'otrack', keys: 'F11' },
  { key: 'dyn', label: 'Dynamic input', icon: 'dyn-input', keys: 'F12' },
  { key: 'lwDisplay', label: 'Show lineweights', icon: 'lineweight' },
  { key: 'selPreview', label: 'Selection preview', icon: 'sel-cycle' },
];

const TAU = 2 * Math.PI;

/** A direction as 0 up to (not including) a full turn, as displayed: just below 0 reads 0, not 360. */
export function formatDirection(a, hd) {
  const text = formatAngle(((a % TAU) + TAU) % TAU, hd);
  return text === formatAngle(TAU, hd) ? formatAngle(0, hd) : text;
}

export class StatusBar {
  constructor(app) {
    this.app = app;
    this.coordMode = 'abs';
    this.coords = h(
      'button.sb-coords',
      { type: 'button', 'aria-label': 'Cursor coordinates. Click to change the display.', 'data-tip': 'Coordinates', 'data-tip-desc': 'Click to switch between absolute, relative and off' },
      '0, 0',
    );
    this.coords.addEventListener('click', () => {
      this.coordMode = this.coordMode === 'abs' ? 'rel' : this.coordMode === 'rel' ? 'off' : 'abs';
      if (this.coordMode === 'off') this.coords.textContent = 'Coordinates off';
    });
    this.buttons = new Map();
    const right = h('div.sb-right', { role: 'toolbar', 'aria-label': 'Drafting aids' });
    for (const t of TOGGLES) {
      const btn = h(
        'button.sb-btn',
        {
          type: 'button',
          'aria-pressed': 'false',
          'aria-label': t.label,
          'data-tip': t.label,
          'data-tip-keys': t.keys || null,
          onClick: () => app.toggleSetting(t.key),
          onContextmenu: (e) => {
            e.preventDefault();
            if (t.menu) this.menu(t.menu, e.currentTarget);
          },
        },
        icon(t.icon, 17),
      );
      const group = h('div.sb-group', btn);
      if (t.menu) {
        group.append(
          h(
            'button.sb-arrow',
            { type: 'button', 'aria-label': `${t.label} settings`, 'aria-haspopup': 'menu', onClick: (e) => this.menu(t.menu, e.currentTarget) },
            icon('chevron-down', 11),
          ),
        );
      }
      this.buttons.set(t.key, btn);
      right.append(group);
    }
    right.append(
      h('span.sb-sep'),
      h(
        'button.sb-btn.sb-text',
        { type: 'button', 'aria-label': 'Drawing units', 'data-tip': 'Drawing units', onClick: () => app.run('UNITS') },
        (this.units = h('span', 'mm')),
      ),
      h('button.sb-btn', { type: 'button', 'aria-label': 'Drafting settings', 'data-tip': 'Drafting settings', onClick: () => app.run('DSETTINGS') }, icon('settings', 17)),
      h('button.sb-btn', { type: 'button', 'aria-label': 'Clean screen', 'data-tip': 'Clean screen', 'data-tip-keys': 'Ctrl+0', onClick: () => app.toggleCleanScreen() }, icon('clean-screen', 17)),
    );
    this.modelTab = h('span.sb-model', { 'aria-current': 'page' }, 'Model');
    this.el = h('footer.statusbar', { role: 'contentinfo' }, h('div.sb-left', this.modelTab, this.coords), right);
  }

  refresh() {
    const s = this.app.settings;
    for (const [k, b] of this.buttons) b.setAttribute('aria-pressed', String(!!s[k]));
    const u = this.app.doc?.drawing.header.units;
    if (u) this.units.textContent = u === 'unitless' ? 'Unitless' : u;
  }

  setCoords(x, y, base) {
    if (this.coordMode === 'off') return;
    const hd = this.app.doc?.drawing.header;
    if (!hd) return;
    if (this.coordMode === 'rel' && base) {
      const d = Math.hypot(x - base.x, y - base.y);
      const a = Math.atan2(y - base.y, x - base.x);
      this.coords.textContent = `${formatLinear(d, hd)} < ${formatDirection(a, hd)}`;
    } else this.coords.textContent = `${formatLinear(x, hd)}, ${formatLinear(y, hd)}`;
  }

  menu(kind, anchor) {
    const app = this.app;
    const s = app.settings;
    let items = [];
    if (kind === 'osnap') {
      const on = new Set(s.osnapModes);
      items = SNAP_MODES.map((m) => ({
        label: m.label,
        icon: m.icon,
        checked: on.has(m.id),
        action: () => {
          const next = new Set(app.settings.osnapModes);
          if (next.has(m.id)) next.delete(m.id);
          else next.add(m.id);
          app.setSetting('osnapModes', [...next]);
          if (!app.settings.osnap) app.setSetting('osnap', true);
          this.menu('osnap', anchor);
        },
      }));
      items.push({ separator: true }, { label: 'Object snap settings...', icon: 'settings', action: () => app.run('DSETTINGS') });
    } else if (kind === 'polar') {
      items = [90, 45, 30, 22.5, 18, 15, 10, 5].map((a) => ({
        label: `${a}, ${a * 2}, ${a * 3}, ${a * 4}...`,
        checked: s.polarInc === a,
        radio: true,
        action: () => {
          app.setSetting('polarInc', a);
          app.setSetting('polar', true);
        },
      }));
      items.push({ separator: true }, { label: 'Tracking settings...', icon: 'settings', action: () => app.run('DSETTINGS') });
    } else if (kind === 'snap') {
      items = [1, 2.5, 5, 10, 25, 50, 100].map((v) => ({
        label: `Spacing ${v}`,
        checked: s.snapSpacing === v,
        radio: true,
        action: () => {
          app.setSetting('snapSpacing', v);
          app.setSetting('snap', true);
        },
      }));
      items.push({ separator: true }, { label: 'Snap settings...', icon: 'settings', action: () => app.run('DSETTINGS') });
    }
    showMenu(anchor, items, { label: 'Settings', alignRight: true });
  }
}
