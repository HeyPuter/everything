/**
 * Status bar: the hint line for the active tool, then zoom, view rotation,
 * artboard navigation and the current tool name.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { openMenu } from './menubar.js';

const ZOOM_PRESETS = [0.0313, 0.0625, 0.125, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64];

export function createStatusbar(app) {
  const hint = h('p.status-hint', { 'aria-live': 'off' });
  const zoomInput = h('input.status-zoom', {
    type: 'text',
    'aria-label': 'Zoom level',
    inputmode: 'decimal',
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        applyZoom(zoomInput.value);
        zoomInput.blur();
      }
      if (e.key === 'Escape') zoomInput.blur();
    },
    onblur: () => refresh(),
  });
  // A menu button (the native select's arrow did not fit the 20px slot and its options ignored the theme).
  const zoomList = h(
    'button.status-zoom-menu',
    {
      type: 'button',
      'aria-label': 'Zoom presets',
      'aria-haspopup': 'menu',
      'data-tip': 'Zoom presets',
      onclick: () => {
        const r = zoomList.getBoundingClientRect();
        const items = [
          ...ZOOM_PRESETS.map((z) => ({ type: 'cmd', label: `${Number((z * 100).toFixed(2))}%`, enabled: true, run: () => applyZoom(z * 100) })),
          { type: 'sep' },
          { type: 'cmd', label: 'Fit Artboard', enabled: true, run: () => applyZoom('fit') },
          { type: 'cmd', label: 'Fit All', enabled: true, run: () => applyZoom('all') },
        ];
        openMenu(app, items, { x: r.left - 60, y: r.top - 4, anchor: zoomList, label: 'Zoom presets', above: true });
      },
    },
    icon('chevron-down', 12),
  );
  const applyZoom = (v) => {
    const ed = app.editor;
    if (!ed) return;
    if (v === 'fit') ed.fitArtboard();
    else if (v === 'all') ed.fitAll();
    else {
      const n = parseFloat(String(v).replace('%', ''));
      if (Number.isFinite(n) && n > 0) {
        ed.view.zoomAt(n / 100, ed.view.width / 2, ed.view.height / 2);
        ed.viewChanged();
      }
    }
    refresh();
  };
  const rotInput = h('select.status-select.rot', { 'aria-label': 'View rotation', onchange: () => {
    const ed = app.editor;
    if (!ed) return;
    ed.view.rotateView(Number(rotInput.value));
    ed.viewChanged();
  } }, ...[0, 15, 30, 45, 60, 90, 120, 150, 180, -15, -30, -45, -60, -90, -120, -150].map((d) => h('option', { value: String((360 + d) % 360) }, `${d}°`)));

  const first = h('button.icon-btn.small', { type: 'button', 'aria-label': 'First artboard', onclick: () => go(0) }, icon('chevrons-left', 14));
  const prev = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Previous artboard', onclick: () => go((app.editor?.activeArtboard ?? 0) - 1) }, icon('chevron-left', 14));
  const boardSel = h('select.status-select', { 'aria-label': 'Artboard', onchange: () => go(Number(boardSel.value)) });
  const next = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Next artboard', onclick: () => go((app.editor?.activeArtboard ?? 0) + 1) }, icon('chevron-right', 14));
  const last = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Last artboard', onclick: () => go(Infinity) }, icon('chevrons-right', 14));
  const go = (i) => {
    const ed = app.editor;
    if (!ed) return;
    const n = ed.doc.artboards.length;
    ed.setActiveArtboard(Math.max(0, Math.min(n - 1, i === Infinity ? n - 1 : i)));
    ed.fitArtboard();
    refresh();
  };
  const toolName = h('span.status-tool');
  const panelsBtn = h('button.icon-btn.small.status-panels', { type: 'button', 'aria-label': 'Panels', 'aria-pressed': String(Boolean(app.dockOpen)), 'data-tip': 'Show or hide panels', onclick: () => app.setDockOpen(!app.panelsShown) }, icon('panel-right', 16));

  const el = h(
    'footer.statusbar',
    hint,
    h(
      'div.status-row',
      h('div.status-group', h('div.status-zoom-wrap', zoomInput, zoomList)),
      h('div.status-group', icon('rotate-cw', 13), rotInput),
      h('div.status-group.artboard-nav', first, prev, boardSel, next, last),
      toolName,
      h('span.status-spacer'),
      panelsBtn,
    ),
  );

  function refresh() {
    const ed = app.editor;
    panelsBtn.setAttribute('aria-pressed', String(Boolean(app.panelsShown)));
    el.classList.toggle('no-doc', !ed);
    if (!ed) return;
    if (document.activeElement !== zoomInput) zoomInput.value = `${Number((ed.view.zoom * 100).toFixed(2))}%`;
    // An angle from the Rotate View tool that is not a preset gets its own entry (the select went blank).
    const rot = String(Math.round(ed.view.rotation) % 360);
    let custom = rotInput.querySelector('option.custom');
    if ([...rotInput.options].some((o) => o.value === rot && o !== custom)) custom?.remove();
    else {
      if (!custom) rotInput.prepend((custom = h('option.custom')));
      custom.value = rot;
      custom.textContent = `${Number(rot) > 180 ? Number(rot) - 360 : rot}°`;
    }
    rotInput.value = rot;
    const boards = ed.doc.artboards;
    if (boardSel.options.length !== boards.length || boardSel._names !== boards.map((b) => b.name).join('|')) {
      boardSel._names = boards.map((b) => b.name).join('|');
      boardSel.replaceChildren(...boards.map((b, i) => h('option', { value: String(i) }, String(i + 1))));
    }
    boardSel.value = String(ed.activeArtboard);
    first.disabled = prev.disabled = ed.activeArtboard <= 0;
    next.disabled = last.disabled = ed.activeArtboard >= boards.length - 1;
    toolName.textContent = app.tool?.constructor.label.replace(' Tool', '') || '';
  }

  function setHint(text) {
    // Render "Click the object to select | Shift+Click ..." with the key phrases bold.
    hint.replaceChildren();
    if (!text) return;
    text.split(' | ').forEach((part, i) => {
      if (i) hint.append(h('span.hint-sep', { 'aria-hidden': 'true' }, '|'));
      const m = /^((?:[A-Z][\w+]*\+)*(?:Click|Drag|Double-click|Up\/Down Arrow|Left\/Right Arrow|Enter|Esc|Option|Shift|Space|\[ and \]|Press F|Hold \w+))(.*)$/.exec(part);
      if (m) hint.append(h('b', m[1]), m[2]);
      else hint.append(part);
    });
  }

  return { el, refresh, setHint };
}
