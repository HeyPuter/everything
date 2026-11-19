// Frames: placeholders drawn with the Frame tool (rectangle or ellipse) that
// mask the image placed or dropped into them, scaled to fill or fit.
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, registerOverlay, registerTool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { allLayers, containerOf, findLayer, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import { createFrame, fitRect, frameAt, isFrame, placeInFrame, type FrameFit, type FrameLayer, type FrameShape } from '../../model/frame';
import { layerBounds, nestIntoArtboards, unionRect } from '../../model/artboard';
import { assertEditable, selectedRoots } from '../../model/layers';
import { layerLock } from '../../model/locks';
import { closestSnap, snapTargets } from '../../model/transform';
import { recordsSettings, settingsDialog } from '../action-settings';
import { propertiesEditors } from '../panels/properties';
import { layoutCommand } from './artboards';

let drag: { start: [number, number]; rect: Rect } | undefined;
let dropTarget: string | undefined;

const shapeOf = (e: Editor) => (e.settings.frameShape as FrameShape | undefined) ?? 'rect';
const fitOf = (e: Editor) => (e.settings.frameFit as FrameFit | undefined) ?? 'fill';

/** The selected frame, or the frame holding the selected layer. */
export function currentFrame(e: Editor): FrameLayer | undefined {
  const l = e.layer;
  if (isFrame(l)) return l;
  if (!l) return;
  return allLayers(e.doc.layers).find((x): x is FrameLayer => isFrame(x) && x.children.some((c) => c.id === l.id));
}

/** Top-level layer (or artboard child) a new layer should sit above. */
function insertTopLevel(d: PhotoDocument, anchor: string, l: Layer) {
  let list = d.layers;
  let index = d.layers.length;
  // Climb to a list that may hold frames: the canvas or an artboard.
  const top = anchor ? d.layers.find((x) => x.id === anchor || !!findLayer(x.children, anchor)) : undefined;
  if (top?.artboard) {
    const child = top.children.find((x) => x.id === anchor || !!findLayer(x.children, anchor));
    list = top.children;
    index = child ? list.indexOf(child) + 1 : list.length;
  } else if (top) index = d.layers.indexOf(top) + 1;
  list.splice(index, 0, l);
}

function constrain(start: [number, number], end: [number, number], p: CanvasPointer): Rect {
  let [x1, y1] = end;
  const [x0, y0] = start;
  if (p.shift) {
    const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    x1 = x0 + Math.sign(x1 - x0 || 1) * side;
    y1 = y0 + Math.sign(y1 - y0 || 1) * side;
  }
  if (p.alt) {
    const w = Math.abs(x1 - x0),
      h = Math.abs(y1 - y0);
    return { x: x0 - w, y: y0 - h, width: 2 * w, height: 2 * h };
  }
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function addFrame(e: Editor, rect: Rect, shape: FrameShape) {
  const anchor = e.selected;
  let id = '';
  layoutCommand(e, 'New Frame', (d) => {
    const f = createFrame(d, { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }, shape);
    f.frame.fit = fitOf(e);
    id = f.id;
    insertTopLevel(d, anchor, f);
    // Frames drawn over an artboard belong to it.
    nestIntoArtboards(d, [f.id]);
  });
  if (id && findLayer(e.doc.layers, id)) {
    e.selectLayers([id]);
    e.update();
  }
}

/** Place image files into a frame, replacing its content. */
export async function placeIntoFrame(e: Editor, frameId: string, file: File) {
  const { openFile } = await import('../files/open');
  const before = new Set(allLayers(e.doc.layers).map((l) => l.id));
  await openFile(e, file, file.name, true);
  const added = allLayers(e.doc.layers).find((l) => !before.has(l.id));
  if (!added) return;
  layoutCommand(e, 'Place in Frame', (d) => {
    const frame = findLayer(d.layers, frameId);
    const l = findLayer(d.layers, added.id);
    if (!isFrame(frame) || !l) return;
    const list = containerOf(d.layers, l.id)!;
    list.splice(list.indexOf(l), 1);
    l.clipped = false;
    frame.children = [l];
    placeInFrame(l, frame.frame);
  });
  e.selectLayers([frameId]);
  e.update();
}
function pickImage(e: Editor, frameId: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.psd,.tif,.tiff';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void e.run(() => placeIntoFrame(e, frameId, file));
  };
  input.click();
}

/** Refit a frame's content after its shape, size or fit mode changed. */
function refit(frame: FrameLayer) {
  for (const c of frame.children) if (c.kind !== 'adjustment' && c.kind !== 'group') placeInFrame(c, frame.frame);
}
function editFrame(e: Editor, id: string, label: string, edit: (f: FrameLayer) => void) {
  layoutCommand(e, label, (d) => {
    const f = findLayer(d.layers, id);
    if (isFrame(f)) edit(f);
  });
}

async function frameFromLayers(e: Editor, arg?: unknown) {
  const roots = e.selectedLayers;
  try {
    assertEditable(e.doc, roots);
  } catch (error) {
    return void e.message((error as Error).message);
  }
  const v = await settingsDialog(
    e,
    'layer.frame-from-layers',
    arg,
    'Frame from Layers',
    [
      { name: 'name', label: 'Name', value: roots.length === 1 ? `${roots[0].name} Frame` : 'Frame' },
      { name: 'shape', label: 'Shape', value: shapeOf(e), type: 'select', options: [['rect', 'Rectangle'], ['ellipse', 'Ellipse']] },
    ],
    'Create',
    'The frame takes the bounds of the selected layers and masks them.',
  );
  if (!v) return;
  wrapInFrame(e, new Set(roots.map((l) => l.id)), v.shape as FrameShape, v.name, 'Frame from Layers');
}
function wrapInFrame(e: Editor, ids: ReadonlySet<string>, shape: FrameShape, name: string | undefined, label: string) {
  let id = '';
  layoutCommand(e, label, (d) => {
    const roots = selectedRoots(d.layers, ids);
    const list = containerOf(d.layers, roots[0].id)!;
    if (roots.some((l) => containerOf(d.layers, l.id) !== list)) throw new Error('Select layers in the same group or artboard.');
    if (roots.some((l) => l.artboard || l.frame || allLayers(l.children).some((c) => c.frame))) throw new Error('Frames cannot contain artboards or other frames.');
    if (allLayers(d.layers).some((f) => isFrame(f) && f.children === list)) throw new Error('These layers are already in a frame.');
    const b = unionRect(roots.map(layerBounds).filter((r): r is Rect => !!r));
    if (!b) throw new Error('Select layers with content.');
    const rect = { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.max(1, Math.ceil(b.x + b.width) - Math.floor(b.x)), height: Math.max(1, Math.ceil(b.y + b.height) - Math.floor(b.y)) };
    const f = createFrame(d, rect, shape, name || undefined);
    id = f.id;
    const top = Math.max(...roots.map((l) => list.indexOf(l)));
    const insertion = list.slice(0, top).filter((l) => !roots.includes(l)).length;
    for (const l of roots) list.splice(list.indexOf(l), 1);
    f.children = roots.map((l) => ({ ...l, clipped: false }));
    list.splice(insertion, 0, f);
  });
  if (id && findLayer(e.doc.layers, id)) {
    e.selectLayers([id]);
    e.update();
  }
}
function convertToFrame(e: Editor) {
  const l = e.layer;
  if (!l) return;
  const live = l.vector?.live;
  if (l.kind === 'vector' && live && (live.kind === 'rect' || live.kind === 'ellipse')) {
    // A rectangle or ellipse shape becomes an empty frame of the same shape.
    const b = layerBounds(l)!;
    let id = '';
    layoutCommand(e, 'Convert to Frame', (d) => {
      const list = containerOf(d.layers, l.id)!;
      const f = createFrame(d, { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) }, live.kind === 'ellipse' ? 'ellipse' : 'rect', l.name);
      id = f.id;
      list.splice(list.indexOf(findLayer(d.layers, l.id)!), 1, f);
    });
    if (id && findLayer(e.doc.layers, id)) {
      e.selectLayers([id]);
      e.update();
    }
    return;
  }
  wrapInFrame(e, new Set([l.id]), 'rect', `${l.name} Frame`, 'Convert to Frame');
}
const canConvert = (e: Editor) => {
  const l = e.layer;
  return e.selectedIds.size === 1 && !!l && l.kind !== 'group' && l.kind !== 'adjustment' && !currentFrame(e);
};
const canFrame = (e: Editor) => e.selectedIds.size > 0 && e.selectedLayers.every((l) => !l.artboard && !l.frame && l.kind !== 'adjustment') && !currentFrame(e);

// ----- Overlay -----
function shapeMarkup(f: FrameLayer, cls: string, z: number, extra = '') {
  const r = f.frame.rect;
  return f.frame.shape === 'ellipse'
    ? `<ellipse class="${cls}" cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" stroke-width="${1 / z}" ${extra}/>`
    : `<rect class="${cls}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${1 / z}" ${extra}/>`;
}
function frameOverlay(e: Editor) {
  if (!e.hasDocument || e.settings.extrasHidden) return '';
  const doc = e.displayDoc;
  const z = e.zoom;
  const current = currentFrame(e)?.id;
  let html = '';
  const visit = (layers: Layer[]) => {
    for (const l of layers) {
      if (!l.visible) continue;
      if (isFrame(l)) {
        const r = l.frame.rect;
        if (!l.children.length) {
          // Placeholder cross, inset into ellipses so it stays inside the shape.
          const k = l.frame.shape === 'ellipse' ? (1 - Math.SQRT1_2) / 2 : 0;
          const x0 = r.x + r.width * k,
            y0 = r.y + r.height * k,
            x1 = r.x + r.width * (1 - k),
            y1 = r.y + r.height * (1 - k);
          html += shapeMarkup(l, 'frame-placeholder', z, `stroke-dasharray="${5 / z} ${4 / z}"`);
          html += `<path class="frame-placeholder cross" d="M${x0} ${y0}L${x1} ${y1}M${x1} ${y0}L${x0} ${y1}" stroke-width="${1 / z}"/>`;
        }
        if (l.id === current || l.id === dropTarget) html += shapeMarkup(l, l.id === dropTarget ? 'frame-drop-target' : 'frame-outline', z * 0.66);
        continue;
      }
      if (l.kind === 'group') visit(l.children);
    }
  };
  visit(doc.layers);
  if (drag && e.tool === 'frame') {
    const r = drag.rect;
    html += shapeShapePreview(shapeOf(e), r, z);
  }
  return html;
}
function shapeShapePreview(shape: FrameShape, r: Rect, z: number) {
  return shape === 'ellipse'
    ? `<ellipse class="frame-outline" cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" stroke-width="${1.5 / z}"/>`
    : `<rect class="frame-outline" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${1.5 / z}"/>`;
}

// Image files dropped on a frame go into it instead of onto the canvas.
function bindDrop(e: Editor) {
  const viewport = e.el('#viewport');
  const frameUnder = (ev: DragEvent) => {
    if (!e.hasDocument || !ev.dataTransfer?.types.includes('Files')) return;
    const [x, y] = e.docPoint(ev.clientX, ev.clientY);
    const f = frameAt(e.doc, x, y);
    return f && !layerLock(e.doc.layers, f.id, 'all') ? f : undefined;
  };
  viewport.addEventListener('dragover', (ev) => {
    const id = frameUnder(ev)?.id;
    if (id !== dropTarget) {
      dropTarget = id;
      e.overlay();
    }
  });
  viewport.addEventListener('dragleave', () => {
    if (!dropTarget) return;
    dropTarget = undefined;
    e.overlay();
  });
  viewport.addEventListener(
    'drop',
    (ev) => {
      const f = frameUnder(ev);
      dropTarget = undefined;
      const file = ev.dataTransfer?.files[0];
      if (!f || !file) return;
      ev.preventDefault();
      ev.stopPropagation();
      viewport.classList.remove('dragover');
      void e.run(() => placeIntoFrame(e, f.id, file));
    },
    true,
  );
}

const numField = (key: string, label: string, value: number, min?: number) =>
  `<label class="number-field"><span>${label}</span><input type="number" data-frame="${key}" step="1" ${min !== undefined ? `min="${min}"` : ''} value="${Math.round(value)}" aria-label="Frame ${label}"></label>`;

export function installFrames(_e: Editor) {
  // Records the settings its dialog was confirmed with.
  recordsSettings('layer.frame-from-layers');
  registerTool({
    id: 'frame',
    label: 'Frame Tool',
    key: 'K',
    icon: 'frame-tool',
    group: 'frame',
    cursor: () => 'crosshair',
    options: (e) =>
      `<span class="segmented" role="group" aria-label="Frame shape"><button class="icon-button toggle" data-frame-shape="rect" aria-pressed="${shapeOf(e) === 'rect'}" title="Rectangular frame" aria-label="Rectangular frame">${svg('frame-tool', 16)}</button><button class="icon-button toggle" data-frame-shape="ellipse" aria-pressed="${shapeOf(e) === 'ellipse'}" title="Elliptical frame" aria-label="Elliptical frame">${svg('frame-ellipse', 16)}</button></span>
<label>Placed images <select id="frame-fit"><option value="fill" ${fitOf(e) === 'fill' ? 'selected' : ''}>Fill the frame</option><option value="fit" ${fitOf(e) === 'fit' ? 'selected' : ''}>Fit inside the frame</option></select></label>
<span class="hint">Drag to draw a frame (Shift: square or circle, Alt: from center). Drop an image on a frame to place it.</span>`,
    bindOptions: ({ e, el }) => {
      el.querySelectorAll<HTMLElement>('[data-frame-shape]').forEach((b) =>
        b.addEventListener('click', () => {
          e.settings.frameShape = b.dataset.frameShape;
          e.options();
        }),
      );
      el.querySelector<HTMLSelectElement>('#frame-fit')?.addEventListener('change', (ev) => (e.settings.frameFit = (ev.target as HTMLSelectElement).value));
    },
    pointerDown: (_e, p) => {
      drag = { start: [p.x, p.y], rect: { x: p.x, y: p.y, width: 0, height: 0 } };
    },
    pointerMove: (e, p) => {
      if (!drag) return;
      let end: [number, number] = [p.x, p.y];
      if (e.transform.snapping && !p.alt) {
        const t = snapTargets(e.doc, []);
        const th = 6 / e.zoom;
        end = [closestSnap([p.x], t.x, th)?.target ?? p.x, closestSnap([p.y], t.y, th)?.target ?? p.y];
      }
      drag.rect = constrain(drag.start, end, p);
      e.overlay();
    },
    pointerUp: (e) => {
      const d = drag;
      drag = undefined;
      e.overlay();
      if (!d || d.rect.width < 3 || d.rect.height < 3) return;
      addFrame(e, d.rect, shapeOf(e));
    },
    deactivate: () => (drag = undefined),
  });
  registerCommand(
    { id: 'layer.frame-from-layers', label: 'Frame from Layers…', run: (e, arg) => frameFromLayers(e, arg), enabled: canFrame, description: 'Mask the selected layers with a new frame' },
    { id: 'layer.convert-to-frame', label: 'Convert to Frame', run: (e) => convertToFrame(e), enabled: canConvert, description: 'Turn a rectangle or ellipse shape into an empty frame, or frame a layer' },
    {
      id: 'frame.place',
      label: 'Place Image in Frame…',
      run: (e) => {
        const f = currentFrame(e);
        if (f) pickImage(e, f.id);
      },
      enabled: (e) => !!currentFrame(e),
      recordable: false,
    },
    {
      id: 'frame.clear',
      label: 'Clear Frame Content',
      run: (e) => {
        const f = currentFrame(e);
        if (f) editFrame(e, f.id, 'Clear Frame', (x) => (x.children = []));
      },
      enabled: (e) => !!currentFrame(e)?.children.length,
    },
  );
  contributeMenu('layer.new-menu', ['layer.frame-from-layers', 'layer.convert-to-frame'], 'layer.artboard-from-layers');
  registerOverlay('frames', frameOverlay);
  bindDrop(_e);
  propertiesEditors.set('frame', {
    mount: (e, el, l) => {
      if (!isFrame(l)) return;
      const f = l.frame;
      const locked = !!layerLock(e.doc.layers, l.id, 'all');
      const r = f.rect;
      el.innerHTML = `<div class="property-body frame-properties"><span class="eyebrow">FRAME</span>
<input class="layer-name-input" data-frame="name" aria-label="Frame name" value="${escapeXML(l.name)}" ${locked ? 'disabled' : ''}>
<fieldset ${locked ? 'disabled' : ''}>
<h3>Frame</h3>
<label class="number-field"><span>Shape</span><select data-frame="shape" aria-label="Frame shape"><option value="rect" ${f.shape === 'rect' ? 'selected' : ''}>Rectangle</option><option value="ellipse" ${f.shape === 'ellipse' ? 'selected' : ''}>Ellipse</option></select></label>
<div class="transform-grid" style="margin-top:6px">${numField('x', 'X', r.x)}${numField('y', 'Y', r.y)}${numField('width', 'W', r.width, 1)}${numField('height', 'H', r.height, 1)}</div>
<h3>Content</h3>
<label class="number-field"><span>Scaling</span><select data-frame="fit" aria-label="Content scaling"><option value="fill" ${f.fit === 'fill' ? 'selected' : ''}>Fill the frame</option><option value="fit" ${f.fit === 'fit' ? 'selected' : ''}>Fit inside the frame</option></select></label>
<p class="muted">${l.children.length ? `${escapeXML(l.children.map((c) => c.name).join(', '))}` : 'Empty — place an image or drop one on the frame.'}</p>
<button class="wide" data-frame-action="place">${svg('image-plus', 13)} ${l.children.length ? 'Replace image…' : 'Place image…'}</button>
${l.children.length ? `<button class="wide" data-frame-action="refit">${svg('scan', 13)} Refit content</button><button class="wide" data-frame-action="clear">${svg('trash-2', 13)} Clear content</button>` : ''}
</fieldset></div>`;
      const id = l.id;
      el.addEventListener('change', (ev) => {
        const t = ev.target as HTMLInputElement;
        const key = t.dataset.frame;
        const cur = findLayer(e.doc.layers, id);
        if (!key || !isFrame(cur)) return;
        if (key === 'name') {
          if (t.value.trim()) e.command('Rename Frame', (d) => (findLayer(d.layers, id)!.name = t.value.trim()));
        } else if (key === 'shape') editFrame(e, id, 'Frame Shape', (x) => (x.frame.shape = t.value as FrameShape));
        else if (key === 'fit')
          editFrame(e, id, 'Frame Content Scaling', (x) => {
            x.frame.fit = t.value as FrameFit;
            refit(x);
          });
        else {
          const v = Math.round(Number(t.value) || 0);
          editFrame(e, id, key === 'x' || key === 'y' ? 'Move Frame' : 'Resize Frame', (x) => {
            const r0 = x.frame.rect;
            const next = { ...r0, [key]: key === 'width' || key === 'height' ? Math.max(1, v) : v };
            const dx = next.x - r0.x,
              dy = next.y - r0.y;
            x.frame.rect = next;
            // Moving carries the content; resizing refits it.
            if (key === 'x' || key === 'y') for (const c of allLayers(x.children)) if (c.kind !== 'group') c.transform = { ...c.transform, x: c.transform.x + dx, y: c.transform.y + dy };
            else refit(x);
          });
        }
      });
      el.addEventListener('click', (ev) => {
        const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-frame-action]')?.dataset.frameAction;
        if (action === 'place') pickImage(e, id);
        if (action === 'clear') editFrame(e, id, 'Clear Frame', (x) => (x.children = []));
        if (action === 'refit') editFrame(e, id, 'Refit Frame Content', refit);
      });
    },
  });
}
export { fitRect };
