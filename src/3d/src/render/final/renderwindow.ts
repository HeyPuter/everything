// Floating render view (the render window, F11) hosting an Image Editor
// on the Render Result. An Image Editor area already showing the Render Result is used instead.
import { patch } from '../../ui/h';
import { app, registerOperators, type AreaLike } from '../../app/app';
import { shell } from '../../ui/shell';
import { ImageEditor, RENDER_RESULT } from './imageeditor';
import { renderResult } from './result';

interface RenderWindow {
  el: HTMLElement;
  header: HTMLElement;
  editor: ImageEditor;
  area: AreaLike;
  unsub: () => void;
}

let win: RenderWindow | null = null;

function screenEditorShowingResult(): ImageEditor | null {
  const areas = shell?.screen?.areas ?? [];
  for (const a of areas) {
    if (a.type !== 'IMAGE_EDITOR' || a.el.style.display === 'none') continue;
    const ed = a.editor as unknown as ImageEditor;
    if (ed instanceof ImageEditor && ed.imageId === RENDER_RESULT) return ed;
  }
  return null;
}

export function isRenderWindowOpen() {
  return !!win;
}

/** Show the Render Result: in an Image Editor area showing it, or in the floating window. */
export function showRenderView() {
  const ed = screenEditorShowingResult();
  if (ed) {
    ed.showRenderResult();
    return;
  }
  openWindow();
}

export function closeRenderWindow() {
  if (!win) return;
  const w = win;
  win = null;
  w.unsub();
  w.editor.dispose();
  w.el.remove();
  if (app.hoverArea === w.area) app.hoverArea = null;
  if (app.activeArea === w.area) app.activeArea = null;
}

function openWindow() {
  if (win) {
    win.editor.showRenderResult();
    win.el.style.zIndex = '60';
    return;
  }
  const el = document.createElement('div');
  el.className = 'rf-window';
  const title = document.createElement('div');
  title.className = 'rf-title';
  title.textContent = 'Render';
  const header = document.createElement('div');
  header.className = 'area-header rf-header';
  const body = document.createElement('div');
  body.className = 'rf-body';
  el.append(title, header, body);
  const host = { redrawHeader: () => drawHeader(), close: () => closeRenderWindow() };
  const editor = new ImageEditor(host, { render: true });
  body.append(editor.el);
  // size: fit the render inside 85% of the window
  const r = renderResult.get();
  const rw = r?.width ?? 1920,
    rh = r?.height ?? 1080;
  const maxW = innerWidth * 0.85,
    maxH = innerHeight * 0.85 - 56;
  const s = Math.min(1, maxW / rw, maxH / rh);
  const W = Math.max(560, Math.round(rw * s)),
    H = Math.max(300, Math.round(rh * s) + 56);
  Object.assign(el.style, { width: `${W}px`, height: `${H}px`, left: `${Math.round((innerWidth - W) / 2)}px`, top: `${Math.round(Math.max(8, (innerHeight - H) / 2))}px` });
  document.body.append(el);
  const area: AreaLike = { id: 'render-window', type: 'IMAGE_EDITOR', el, editor };
  el.addEventListener('pointerenter', () => (app.hoverArea = area));
  el.addEventListener('pointerleave', () => {
    if (app.hoverArea === area) app.hoverArea = null;
  });
  el.addEventListener('pointerdown', () => ((app.activeArea = area), (app.hoverArea = area)), true);
  // drag by the title bar
  title.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    title.setPointerCapture(e.pointerId);
    const sx = e.clientX - el.offsetLeft,
      sy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.min(innerWidth - 60, Math.max(-el.offsetWidth + 60, ev.clientX - sx))}px`;
      el.style.top = `${Math.min(innerHeight - 30, Math.max(0, ev.clientY - sy))}px`;
    };
    const up = () => {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', up);
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', up);
  });
  title.addEventListener('dblclick', () => {
    const full = el.classList.toggle('maximized');
    void full;
    editor.resize();
  });
  new ResizeObserver(() => editor.resize()).observe(body);
  const drawHeader = () => patch(header, editor.header());
  const unsub = app.subscribe((kinds) => {
    if (!win) return;
    editor.update(kinds);
    drawHeader();
  });
  win = { el, header, editor, area, unsub };
  drawHeader();
  editor.update(new Set(['doc', 'ui']));
  app.hoverArea = area;
}

registerOperators([
  {
    idname: 'render.view_show',
    label: 'View Render',
    description: 'Toggle the render view showing the last render result (F11)',
    undo: false,
    exec: () => {
      if (win) closeRenderWindow();
      else showRenderView();
      return 'CANCELLED';
    },
  },
]);
