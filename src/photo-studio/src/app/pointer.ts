import type { Editor } from '../editor';
import { isMac } from './shortcuts';

/** A pointer sample in document coordinates with the modifier state. */
export type CanvasPointer = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  pressure: number;
  button: number;
  buttons: number;
  shift: boolean;
  alt: boolean;
  // Command on macOS, Ctrl elsewhere.
  mod: boolean;
  pointerType: string;
  event: PointerEvent | MouseEvent;
  // Samples coalesced by the browser since the previous event (high-rate pens).
  coalesced?: CanvasPointer[];
};

export function canvasPoint(e: Editor, event: PointerEvent | MouseEvent): CanvasPointer {
  const [x, y] = e.docPoint(event.clientX, event.clientY);
  const pe = event as PointerEvent;
  return {
    x,
    y,
    clientX: event.clientX,
    clientY: event.clientY,
    // Mice report 0.5 while pressed; treat them as full pressure.
    pressure: pe.pointerType === 'pen' ? pe.pressure || 0 : 1,
    button: event.button,
    buttons: event.buttons,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: isMac ? event.metaKey : event.ctrlKey,
    pointerType: pe.pointerType ?? 'mouse',
    event,
  };
}

// A touch that has not moved this far (CSS pixels) or for this long (ms)
// may still become a two-finger pinch rather than a tool gesture.
const TOUCH_SLOP = 6;
const TOUCH_DELAY = 100;

/** Viewport navigation shared by every tool: wheel scrolling and zooming,
 * Space to pan, middle-button pan, two-finger pinch and pan on touch screens,
 * and pointer dispatch to the active tool. */
export function bindCanvas(e: Editor) {
  const viewport = e.el('#viewport');
  let spaceHeld = false;
  let gesture:
    | { kind: 'pan'; start: [number, number]; pan: { x: number; y: number }; pointer: number; samples: [number, number, number][] }
    | { kind: 'tool'; pointer: number }
    // A one-finger touch waiting to tell a tool gesture from a pinch.
    | { kind: 'touch'; pointer: number; down: PointerEvent; timer: number }
    | { kind: 'pinch'; ids: [number, number]; zoom: number; pan: { x: number; y: number }; mid: [number, number]; dist: number }
    | { kind: 'brush'; pointer: number; start: [number, number]; local: [number, number]; from: { size: number; hardness: number; opacity: number; roundness: number } }
    | undefined;
  // The secondary-button press that starts a brush resize must not open the context menu.
  let suppressMenu = false;
  // Touch points on the viewport (client coordinates).
  const touches = new Map<number, [number, number]>();
  const startTool = (down: PointerEvent) => {
    const tool = e.activeTool;
    gesture = { kind: 'tool', pointer: down.pointerId };
    e.toolBusy = true;
    void Promise.resolve(tool?.pointerDown?.(e, canvasPoint(e, down))).catch((error) => e.message(String(error?.message ?? error)));
  };
  // A waiting touch becomes a tool gesture once it moves, stays down or lifts.
  const commitTouch = () => {
    if (gesture?.kind !== 'touch') return;
    clearTimeout(gesture.timer);
    startTool(gesture.down);
  };
  const pinchState = (ids: [number, number]) => {
    const [a, b] = ids.map((id) => touches.get(id)!);
    const r = viewport.getBoundingClientRect();
    return { mid: [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top] as [number, number], dist: Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])) };
  };
  viewport.addEventListener(
    'contextmenu',
    (event) => {
      if (!suppressMenu) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  const brushPreview = (g: Extract<NonNullable<typeof gesture>, { kind: 'brush' }>, v: { size: number; hardness: number; opacity: number }) => {
    const [x, y] = g.local,
      r = Math.max(1, (v.size * e.zoom) / 2),
      color = e.preferences.brushPreviewColor;
    const inner = Math.round(Math.min(0.999, v.hardness) * 100);
    const label = e.preferences.altDragHardness ? `Hardness ${Math.round(v.hardness * 100)}%` : `Opacity ${Math.round(v.opacity * 100)}%`;
    e.screenOverlayContent = `<defs><radialGradient id="brush-adjust-fill"><stop offset="0%" stop-color="${color}" stop-opacity="0.55"/><stop offset="${inner}%" stop-color="${color}" stop-opacity="0.55"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * g.from.roundness}" fill="url(#brush-adjust-fill)" class="brush-adjust-preview"/><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * g.from.roundness}" class="brush-cursor"/><text x="${x}" y="${y + r * g.from.roundness + 16}" text-anchor="middle" class="brush-adjust-label">Size ${Math.round(v.size)} px · ${label}</text>`;
    e.screenOverlay();
  };
  let flick = 0;
  // Tools → Enable flick panning: a quick pan keeps gliding and slows down.
  const glide = (vx: number, vy: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.pow(0.994, dt);
      vx *= decay;
      vy *= decay;
      e.pan.x += vx * dt;
      e.pan.y += vy * dt;
      e.view();
      if (Math.hypot(vx, vy) > 0.02) flick = requestAnimationFrame(step);
    };
    flick = requestAnimationFrame(step);
  };
  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (e.transform.dragging) return;
      // Deltas are read before deltaMode (Firefox then reports pixels); lines and pages become pixels.
      const dx = event.deltaX,
        dy = event.deltaY;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      // Pinch gestures arrive as ctrl+wheel; Alt/Mod+wheel also zooms.
      if (event.ctrlKey || event.metaKey || event.altKey || e.preferences.wheelZooms) {
        const rect = viewport.getBoundingClientRect();
        // A pinch sends small steps (100 × ln of its scale change) and zooms at that
        // rate. A mouse wheel notch with Ctrl, the zoom modifier on Windows and Linux,
        // sends 100 or more and zooms in steps like Alt+wheel, not by e per notch.
        const pinch = event.ctrlKey && !event.altKey && scale === 1 && Math.abs(dy) < 40;
        e.zoomAt(e.zoom * Math.exp(-dy * scale * (pinch ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        e.pan.x -= (event.shiftKey ? dy : dx) * scale;
        e.pan.y -= (event.shiftKey ? 0 : dy) * scale;
        e.view();
      }
    },
    { passive: false },
  );
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !event.repeat && !(event.target as HTMLElement).closest('input,textarea,select,[contenteditable],puter-user-menu')) {
      spaceHeld = true;
      viewport.classList.add('space-pan');
    }
  });
  const releaseSpace = () => {
    spaceHeld = false;
    viewport.classList.remove('space-pan');
  };
  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') releaseSpace();
  });
  // Space released in another window never sends its keyup here.
  window.addEventListener('blur', releaseSpace);
  viewport.addEventListener('pointerdown', (event) => {
    if (event.defaultPrevented || e.busy || !e.renderer) return;
    if ((event.target as HTMLElement).closest('button,input,.canvas-ui')) return;
    viewport.focus({ preventScroll: true });
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, [event.clientX, event.clientY]);
      // Captured, so its release is seen even off the canvas.
      viewport.setPointerCapture(event.pointerId);
      // A second finger before the first started a tool gesture (or while
      // panning) pinches: zoom and pan follow both fingers.
      if (touches.size === 2 && (!gesture || gesture.kind === 'touch' || gesture.kind === 'pan')) {
        if (gesture?.kind === 'touch') clearTimeout(gesture.timer);
        viewport.classList.remove('panning');
        const ids = [...touches.keys()] as [number, number];
        gesture = { kind: 'pinch', ids, zoom: e.zoom, pan: { ...e.pan }, ...pinchState(ids) };
        cancelAnimationFrame(flick);
        event.preventDefault();
        return;
      }
      // Further fingers never start another gesture.
      if (gesture) return;
    }
    const tool = e.activeTool;
    const pan = event.button === 1 || spaceHeld || (tool?.id === 'hand' && event.button === 0);
    cancelAnimationFrame(flick);
    const adjust = tool?.brush && e.hasDocument && ((event.button === 2 && event.altKey) || (isMac && event.button === 0 && event.ctrlKey && event.altKey));
    if (adjust) {
      suppressMenu = true;
      const r = viewport.getBoundingClientRect();
      gesture = { kind: 'brush', pointer: event.pointerId, start: [event.clientX, event.clientY], local: [event.clientX - r.left, event.clientY - r.top], from: { ...tool.brush!.get(e) } };
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
      brushPreview(gesture, gesture.from);
      return;
    }
    if (pan) {
      gesture = { kind: 'pan', start: [event.clientX, event.clientY], pan: { ...e.pan }, pointer: event.pointerId, samples: [[event.clientX, event.clientY, performance.now()]] };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('panning');
      event.preventDefault();
      return;
    }
    if (event.button !== 0 && event.button !== 2) return;
    if (event.button === 2) return; // context menus handle the secondary button
    if (!tool?.pointerDown) return;
    if (tool.needsDocument !== false && !e.hasDocument) return;
    viewport.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      gesture = { kind: 'touch', pointer: event.pointerId, down: event, timer: window.setTimeout(commitTouch, TOUCH_DELAY) };
      return;
    }
    startTool(event);
  });
  viewport.addEventListener('pointermove', (event) => {
    const p = canvasPoint(e, event);
    e.updatePointerInfo(p);
    if (touches.has(event.pointerId)) touches.set(event.pointerId, [event.clientX, event.clientY]);
    if (!gesture) {
      e.activeTool?.hover?.(e, p);
      return;
    }
    if (gesture.kind === 'pinch') {
      if (!gesture.ids.includes(event.pointerId) || !gesture.ids.every((id) => touches.has(id))) return;
      const g = gesture,
        now = pinchState(g.ids);
      // Zoom about the starting midpoint, then follow the midpoint's movement.
      e.zoom = g.zoom;
      e.pan = { ...g.pan };
      e.zoomAt(g.zoom * (now.dist / g.dist), g.mid[0], g.mid[1]);
      e.pan = { x: e.pan.x + now.mid[0] - g.mid[0], y: e.pan.y + now.mid[1] - g.mid[1] };
      e.view();
      return;
    }
    if (event.pointerId !== gesture.pointer) return;
    if (gesture.kind === 'touch') {
      if (Math.hypot(event.clientX - gesture.down.clientX, event.clientY - gesture.down.clientY) < TOUCH_SLOP) return;
      commitTouch();
    }
    if (gesture.kind === 'brush') {
      // Right enlarges, up hardens (or makes the brush more opaque).
      const dx = event.clientX - gesture.start[0],
        dy = event.clientY - gesture.start[1];
      const f = gesture.from;
      const v = { size: Math.round(Math.max(1, Math.min(5000, f.size + (2 * dx) / e.zoom))), hardness: f.hardness, opacity: f.opacity };
      if (e.preferences.altDragHardness) v.hardness = Math.max(0, Math.min(1, f.hardness - dy / 200));
      else v.opacity = Math.max(0.01, Math.min(1, f.opacity - dy / 200));
      e.activeTool?.brush?.set(e, v);
      brushPreview(gesture, v);
      return;
    }
    if (gesture.kind === 'pan') {
      e.pan.x = gesture.pan.x + event.clientX - gesture.start[0];
      e.pan.y = gesture.pan.y + event.clientY - gesture.start[1];
      gesture.samples = [...gesture.samples.slice(-5), [event.clientX, event.clientY, performance.now()]];
      e.view();
      return;
    }
    const coalesced = (event as PointerEvent).getCoalescedEvents?.() ?? [];
    p.coalesced = coalesced.length > 1 ? coalesced.map((c) => canvasPoint(e, c)) : undefined;
    e.activeTool?.pointerMove?.(e, p);
  });
  const end = (event: PointerEvent) => {
    touches.delete(event.pointerId);
    if (gesture?.kind === 'pinch') {
      if (!gesture.ids.includes(event.pointerId)) return;
      // The remaining finger does nothing until it lifts.
      for (const id of gesture.ids) if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
      gesture = undefined;
      return;
    }
    if (!gesture || event.pointerId !== gesture.pointer) return;
    // A tap: the tool gets its press and release.
    if (gesture.kind === 'touch') {
      if (event.type === 'pointercancel') {
        clearTimeout(gesture.timer);
        gesture = undefined;
        return;
      }
      commitTouch();
    }
    const g = gesture;
    gesture = undefined;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    viewport.classList.remove('panning');
    if (g.kind === 'brush') {
      e.screenOverlayContent = '';
      e.screenOverlay();
      // A context menu event can follow the release (Windows); swallow it.
      setTimeout(() => (suppressMenu = false), 300);
      return;
    }
    if (g.kind === 'pan' && e.preferences.flickPanning && event.type === 'pointerup') {
      // Velocity over the last ~80 ms of the drag, in pixels per millisecond.
      const now = performance.now();
      const recent = g.samples.filter((s) => now - s[2] < 80);
      if (recent.length >= 2) {
        const a = recent[0],
          b = recent[recent.length - 1],
          dt = Math.max(1, b[2] - a[2]);
        const vx = (b[0] - a[0]) / dt,
          vy = (b[1] - a[1]) / dt;
        if (Math.hypot(vx, vy) > 0.4) glide(vx, vy);
      }
    }
    if (g.kind === 'tool') {
      e.toolBusy = false;
      void Promise.resolve(e.activeTool?.pointerUp?.(e, canvasPoint(e, event))).catch((error) => e.message(String(error?.message ?? error)));
    }
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button,input,.canvas-ui')) return;
    e.activeTool?.doubleClick?.(e, canvasPoint(e, event));
  });
  viewport.addEventListener('pointerleave', () => e.updatePointerInfo(undefined));
}
