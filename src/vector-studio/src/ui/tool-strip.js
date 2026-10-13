/**
 * Floating tool strips: a tool group torn off the Tools panel, or a custom
 * toolbar (Window > Toolbars > New Toolbar). A strip is an ARIA toolbar
 * with roving tabindex, dragged by its grip, horizontal or vertical. An
 * editable strip takes tools from its Add menu or dropped from the Tools
 * panel or the All Tools drawer, and loses them from a tool's context menu.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { formatShortcut } from '../commands/registry.js';

const tipFor = (cls) => (cls.shortcut ? `${cls.label} (${formatShortcut(cls.shortcut)})` : cls.label);

/**
 * opts: { ids, label, x, y, vertical, editable, sections, onClose(), onChange(patch) }
 * `sections` ([{ label, ids }]) groups the Add menu; `onChange` gets
 * { x, y } after a move, { vertical } and { ids } after edits.
 * Returns { el, ids, setIds(ids), refresh(), remove() }.
 */
export function createToolStrip(app, { ids, label, x = 80, y = 80, vertical = false, editable = false, sections = null, onClose, onChange }) {
  let list = ids.filter((id) => app.toolClasses.has(id));
  const strip = h('div.tool-tearoff', { role: 'toolbar', 'aria-label': label, 'aria-orientation': vertical ? 'vertical' : 'horizontal' });
  strip.classList.toggle('vertical', vertical);
  strip.classList.toggle('editable', editable);
  const tools = h('div.tearoff-tools');
  let btns = [];

  const place = (left, top) => {
    strip.style.left = `${Math.max(0, Math.min(window.innerWidth - strip.offsetWidth, left))}px`;
    strip.style.top = `${Math.max(0, Math.min(window.innerHeight - strip.offsetHeight, top))}px`;
  };

  const setIds = (next) => {
    list = [...new Set(next)].filter((id) => app.toolClasses.has(id));
    render();
    onChange?.({ ids: [...list] });
  };

  const addMenu = (anchor) => {
    const groups = sections || [{ label: 'Tools', ids: [...app.toolClasses.keys()] }];
    const spec = groups
      .map((s) => ({ label: s.label, submenu: s.ids.filter((id) => app.toolClasses.has(id) && !list.includes(id)).map((id) => ({ label: app.toolClasses.get(id).label, run: () => setIds([...list, id]) })) }))
      .filter((s) => s.submenu.length);
    app.showMenuAt(anchor, spec.length ? spec : [{ label: 'Every tool is in this toolbar', run: () => {}, enabled: false }], 'Add tool');
  };

  function render() {
    btns = list.map((id) => {
      const cls = app.toolClasses.get(id);
      const b = h('button.tool-btn', { type: 'button', 'aria-label': cls.label, 'aria-pressed': String(app.toolId === id), 'data-tip': tipFor(cls), tabindex: '-1', onclick: () => app.setTool(id), ondblclick: () => app.tool?.openOptions?.() }, icon(cls.icon, 20));
      b._id = id;
      if (editable) {
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          app.showMenuAt(b, [{ label: 'Remove from Toolbar', run: () => setIds(list.filter((t) => t !== id)) }], cls.label);
        });
      }
      return b;
    });
    const add = editable ? h('button.tool-btn.tearoff-add', { type: 'button', 'aria-label': 'Add tool', 'data-tip': 'Add a tool', 'aria-haspopup': 'menu', tabindex: '-1', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 16)) : null;
    tools.replaceChildren(...btns, ...(add ? [add] : []));
    const all = [...tools.querySelectorAll('button')];
    (all.find((b) => b._id === app.toolId) || all[0])?.setAttribute('tabindex', '0');
  }

  const grip = h('div.tearoff-grip', { 'aria-hidden': 'true', title: 'Drag to move' }, icon('grip', 12));
  const head = h('div.tearoff-head', grip);
  const flip = h('button.tearoff-mini', {
    type: 'button',
    'aria-label': 'Toggle orientation',
    'data-tip': 'Horizontal or vertical',
    onclick: () => {
      const v = strip.classList.toggle('vertical');
      strip.setAttribute('aria-orientation', v ? 'vertical' : 'horizontal');
      place(strip.offsetLeft, strip.offsetTop);
      onChange?.({ vertical: v });
    },
  }, icon('arrow-left-right', 12));
  const close = h('button.tearoff-mini', { type: 'button', 'aria-label': `Close ${label}`, 'data-tip': 'Close', onclick: () => onClose?.() }, icon('x', 12));
  strip.append(head, tools, h('div.tearoff-ctrls', flip, close));

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: strip.offsetLeft, top: strip.offsetTop };
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers cannot be captured.
    }
    const move = (ev) => place(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      onChange?.({ x: strip.offsetLeft, y: strip.offsetTop });
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  strip.addEventListener('keydown', (e) => {
    const all = [...tools.querySelectorAll('button')];
    const i = all.indexOf(document.activeElement);
    const v = strip.classList.contains('vertical');
    const step = { [v ? 'ArrowDown' : 'ArrowRight']: 1, [v ? 'ArrowUp' : 'ArrowLeft']: -1 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      app.canvasHost?.focus();
      return;
    }
    if (i < 0 || !step) return;
    e.preventDefault();
    e.stopPropagation();
    all.forEach((b) => (b.tabIndex = -1));
    const b = all[(i + step + all.length) % all.length];
    b.tabIndex = 0;
    b.focus();
  });

  if (editable) {
    // Tools dragged from the All Tools drawer or the Tools panel join the strip.
    const types = ['text/x-vs-tool', 'text/x-vs-toolbar'];
    strip.addEventListener('dragover', (e) => {
      if (types.some((t) => e.dataTransfer?.types?.includes(t))) e.preventDefault();
    });
    strip.addEventListener('drop', (e) => {
      const id = types.map((t) => e.dataTransfer?.getData(t)).find(Boolean);
      if (!id || !app.toolClasses.has(id)) return;
      e.preventDefault();
      setIds([...list, id]);
    });
  }

  render();
  const off = app.on('tool', () => {
    for (const b of btns) b.setAttribute('aria-pressed', String(b._id === app.toolId));
  });
  document.body.append(strip);
  place(x, y);

  return {
    el: strip,
    get ids() {
      return [...list];
    },
    setIds,
    refresh: render,
    remove() {
      off();
      strip.remove();
    },
  };
}
