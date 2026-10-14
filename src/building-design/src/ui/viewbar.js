/**
 * View control bar (bottom of the view): scale, detail level, visual style,
 * thin lines, section box, perspective, temporary hide/isolate and reveal
 * hidden elements, depending on the kind of view.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { scaleOptions, scaleLabel } from '../core/units.js';

const STYLES = [
  ['wireframe', 'Wireframe', 'styleWire'],
  ['hidden', 'Hidden Line', 'styleHidden'],
  ['shaded', 'Shaded', 'styleShaded'],
  ['consistent', 'Consistent Colors', 'styleConsistent'],
  ['realistic', 'Realistic', 'styleRealistic'],
];

const DETAILS = [
  ['coarse', 'Coarse', 'detailCoarse'],
  ['medium', 'Medium', 'detailMedium'],
  ['fine', 'Fine', 'detailFine'],
];

export function renderViewbar(app) {
  const bar = app.shell.viewbar;
  clear(bar);
  const view = app.activeView;
  if (!view || !app.doc) return;
  const set = (patch, label) => app.commit(label, () => app.doc.update(view.id, patch));
  const btn = (content, label, onClick, pressed = null, extra = {}) =>
    h('button.vb-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'aria-pressed': pressed == null ? null : String(pressed), 'aria-haspopup': extra.menu ? 'menu' : null, onClick, ...extra.attrs }, content);
  const sep = () => h('span.vb-sep');
  const graphical = !['schedule', 'sheet'].includes(view.kind);
  if (view.scale && view.kind !== 'view3d') {
    bar.append(
      btn(
        [h('span', scaleLabel(view.scale, app.doc.units)), icon('chevron-up', 12)],
        `View scale ${scaleLabel(view.scale, app.doc.units)}`,
        (e) => showMenu(e.currentTarget, scaleOptions(app.doc.units).map((o) => ({ label: o.label, checked: o.value === view.scale, radio: true, action: () => set({ scale: o.value }, 'View scale') })), { label: 'View scale' }),
        null,
        { menu: true },
      ),
    );
  }
  if (graphical) {
    const d = DETAILS.find((x) => x[0] === (view.detail || 'medium')) || DETAILS[1];
    bar.append(
      btn(icon(d[2], 16), `Detail level: ${d[1]}`, (e) => showMenu(e.currentTarget, DETAILS.map(([v, l, ic]) => ({ label: l, icon: ic, checked: view.detail === v, radio: true, action: () => set({ detail: v }, 'Detail level') })), { label: 'Detail level' }), null, { menu: true }),
    );
    if (view.kind !== 'plan' && view.kind !== 'ceilingPlan') {
      const s = STYLES.find((x) => x[0] === (view.style || 'shaded')) || STYLES[2];
      bar.append(btn(icon(s[2], 16), `Visual style: ${s[1]}`, (e) => showMenu(e.currentTarget, STYLES.map(([v, l, ic]) => ({ label: l, icon: ic, checked: view.style === v, radio: true, action: () => set({ style: v }, 'Visual style') })), { label: 'Visual style' }), null, { menu: true }));
    }
    bar.append(btn(icon('thinLines', 16), 'Thin lines', () => app.toggleSetting('thinLines'), !!app.settings.thinLines));
    if (view.kind === 'view3d') {
      const persp = app.vc?.cam?.persp !== false;
      bar.append(
        btn(icon('view3d', 16), persp ? 'Perspective (click for orthographic)' : 'Orthographic (click for perspective)', () => {
          const c = app.vc;
          if (!c?.cam) return;
          c.cam.persp = !persp;
          app.viewChanged();
          renderViewbar(app);
          app.requestRender();
        }, persp),
        btn(icon('sectionBox', 16), 'Section box', () => app.toggleSectionBox(), !!view.sectionBox),
      );
    }
    if (view.kind === 'plan') bar.append(btn(icon('palette', 16), 'Room color fill', () => app.toggleViewProp('roomFill'), !!view.roomFill));
    bar.append(sep());
    const t = app.temp.get(view.id);
    bar.append(
      btn(icon('isolate', 16), 'Temporary hide/isolate', (e) =>
        showMenu(
          e.currentTarget,
          [
            { label: 'Isolate Element', icon: 'isolate', disabled: !app.selection.size, action: () => app.temporary('isolate') },
            { label: 'Hide Element', icon: 'hideEl', disabled: !app.selection.size, action: () => app.temporary('hide') },
            { separator: true },
            { label: 'Reset Temporary Hide/Isolate', icon: 'refresh', disabled: !t, action: () => app.temporary('reset') },
            { label: 'Hide Selected in View', icon: 'hideEl', disabled: !app.selection.size, action: () => app.hideInView('element') },
          ],
          { label: 'Temporary hide/isolate' },
        ),
      !!t, { menu: true }),
      btn(icon('reveal', 16), 'Reveal hidden elements', () => app.toggleReveal(), app.reveal.has(view.id)),
    );
    if (view.hiddenCats?.length || view.hiddenIds?.length) bar.append(h('span.vb-label', `${(view.hiddenIds?.length || 0) + (view.hiddenCats?.length || 0)} hidden`));
  }
}
