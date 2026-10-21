import { zoomAt } from "./model.js";

export const NAVIGATION_MODES = ["auto", "mouse", "trackpad"];
// Two clicks this close together are a double click. Windows waits 500 ms
// by default, so a shorter window turns many people's double clicks into
// two single clicks.
export const DOUBLE_CLICK_MS = 500;

// A canvas focused from a pointerdown handler that cancelled the event. The
// browser never saw a mouse press, so it treats the script focus as keyboard
// focus and draws a focus ring around the whole board on every click. The
// class hides that ring until the keyboard is used again, when a visible
// focus indicator is the right thing to show.
export const POINTER_FOCUS_CLASS = "pointer-focus";
export function pointerFocus(element) {
  if (!element) return;
  element.classList.add(POINTER_FOCUS_CLASS);
  element.focus({ preventScroll: true });
}
export function keyboardFocus(element) {
  element?.classList.remove(POINTER_FOCUS_CLASS);
}
export const navigationMode = (value) =>
  NAVIGATION_MODES.includes(value) ? value : "auto";

// Wheel events do not identify their device. Auto mode recognizes discrete
// wheel steps and keeps a whole scroll burst consistent; users can override it.
export function createWheelNavigation() {
  let detected = "trackpad",
    last = -Infinity;
  return (view, event, size, mode = "auto", now = performance.now()) => {
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
    let dx = event.deltaX * unit,
      dy = event.deltaY * unit;
    if (![dx, dy].every(Number.isFinite)) return view;
    const modified = event.ctrlKey || event.metaKey;
    if (!modified && (now - last > 180 || event.deltaMode || event.deltaX)) {
      detected =
        event.deltaMode ||
        (!event.deltaX &&
          Math.abs(event.deltaY) >= 40 &&
          (event.deltaY % 100 === 0 || event.deltaY % 120 === 0))
          ? "mouse"
          : "trackpad";
    }
    last = now;
    const device = mode === "auto" ? detected : mode;
    if (modified || (device === "mouse" && !event.shiftKey && dy))
      return zoomAt(
        view,
        size.point,
        view.z *
          Math.exp(-zoomStep(dy, event.deltaMode) * (modified ? 0.008 : 0.002)),
      );
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
    return { ...view, x: view.x - dx, y: view.y - dy };
  };
}

// Zooming with the wheel about a point, at the canvas's rates: wheel steps
// in lines or pages count as pixels, and a pinch (Ctrl or Cmd) zooms faster
// than a mouse wheel.
export function wheelZoom(view, event, point, height) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1,
    dy = event.deltaY * unit;
  if (!Number.isFinite(dy) || !dy) return view;
  return zoomAt(
    view,
    point,
    view.z *
      Math.exp(
        -zoomStep(dy, event.deltaMode) *
          (event.ctrlKey || event.metaKey ? 0.008 : 0.002),
      ),
  );
}
// One wheel notch set to scroll by lines or by a page counts as pixels, so a
// page notch would otherwise zoom by the height of the canvas at once, from
// 100% to the smallest zoom. Pixel deltas, including pinches, pass through.
const zoomStep = (dy, deltaMode) =>
  deltaMode ? Math.max(-120, Math.min(120, dy)) : dy;
export function pinchView(view, start, next) {
  const zoomed = zoomAt(
    view,
    start.center,
    (view.z * next.distance) / Math.max(1, start.distance),
  );
  return {
    ...zoomed,
    x: zoomed.x + next.center.x - start.center.x,
    y: zoomed.y + next.center.y - start.center.y,
  };
}

// Whether a wheel turned over `target` scrolls something between it and
// `root` that can still move that way, as text taller than its editor does.
export function scrollsInside(event, target, root) {
  let dx = event.deltaX,
    dy = event.deltaY;
  if (event.shiftKey && !dx) [dx, dy] = [dy, 0];
  for (let el = target; el; el = el.parentElement) {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    const can = (overflow, delta, at, view, size) =>
      /auto|scroll/.test(overflow) &&
      size > view + 1 &&
      (delta < 0 ? at > 0 : delta > 0 && at + view < size - 1);
    if (
      can(
        style.overflowY,
        dy,
        el.scrollTop,
        el.clientHeight,
        el.scrollHeight,
      ) ||
      can(style.overflowX, dx, el.scrollLeft, el.clientWidth, el.scrollWidth)
    )
      return true;
    if (el === root) break;
  }
  return false;
}

// Only active pointers are retained. Camera gestures never inspect board data.
export function createCanvasNavigation(api) {
  let canvas, session, timer, safariGesture;
  // Once a pen has touched the board, a finger only moves the view, so a
  // palm resting between strokes draws, selects and places nothing, unless
  // the person has turned that off in Preferences.
  let penUsed = false;
  const penMode = () => penUsed && api.penOnly?.() !== false;
  const touches = new Map();
  const wheel = createWheelNavigation();
  let mode = "auto";
  try {
    mode = navigationMode(localStorage.getItem("whiteboard-navigation"));
  } catch {}
  const state = () => api.state();
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Number.isFinite(e.clientX) ? e.clientX - r.left : r.width / 2,
      y: Number.isFinite(e.clientY) ? e.clientY - r.top : r.height / 2,
    };
  };
  const eventCopy = (e) => ({
    clientX: e.clientX,
    clientY: e.clientY,
    button: e.button,
    buttons: e.buttons,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    currentTarget: canvas,
    preventDefault() {},
  });
  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const capture = (id) => {
    try {
      canvas.setPointerCapture?.(id);
    } catch {}
  };
  const release = (id) => {
    try {
      if (canvas?.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    } catch {}
  };
  // The window-level release listener is installed once per page.
  let released = false;
  function clear() {
    clearTimer();
    const ids = [...touches.keys(), ...(session ? [session.pointer] : [])];
    session = safariGesture = null;
    touches.clear();
    ids.forEach(release);
  }
  function stop(cancel = false) {
    const s = session,
      g = safariGesture;
    clear();
    if (s && s.board === state().board) {
      if (s.kind === "direct") {
        if (cancel) api.cancel();
        else api.end();
      }
      if (cancel && s.touch) api.restoreSelection(s.selection);
      if (cancel && ["pan", "pinch"].includes(s.kind))
        api.navigate(s.originalView);
    }
    if (g && cancel && g.board === state().board) api.navigate(g.view);
    return !!(s || g);
  }
  const valid = () => session && session.board === state().board;
  function pair() {
    const [a, b] = [...touches.values()].slice(0, 2).map(local);
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }
  function beginPinch() {
    clearTimer();
    if (session.kind === "direct") api.cancel();
    api.restoreSelection(session.selection);
    api.resetTap();
    session.kind = "pinch";
    session.view = { ...state().view };
    session.pair = pair();
  }
  function down(e) {
    if (e.currentTarget !== canvas) return;
    // A stylus eraser arrives as its own button.
    const eraser =
      e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) === 32);
    if (e.button !== 0 && e.button !== 1 && e.button !== 2 && !eraser) return;
    if (safariGesture) stop();
    const touch = e.pointerType === "touch";
    if (e.pointerType === "pen" && !penUsed) {
      penUsed = true;
      if (penMode()) api.penStarted?.();
    }
    // Ignore palms while the pen/mouse is in use and foreign mouse pointers.
    if (session && !session.touch) {
      if (touch || session.pointer !== e.pointerId) return;
      stop();
    }
    if (!touch && touches.size) {
      // A pen arriving while a finger rests on the screen, as a palm does
      // before the pen lands, takes over: the finger's gesture is cancelled
      // and whatever it began is dropped, as when a second finger joins.
      if (e.pointerType !== "pen") return;
      stop(true);
    }
    e.preventDefault();
    if (touch && touches.has(e.pointerId)) return;
    if (touch && touches.size >= 3) return;
    capture(e.pointerId);
    if (touch) touches.set(e.pointerId, eventCopy(e));
    if (touch && touches.size > 1) {
      if (touches.size === 2) beginPinch();
      return;
    }
    // After a pen, a resting finger or palm closes nothing that is open,
    // such as Find on board, until it moves.
    if (!touch || !penMode()) api.prepare(e);
    const current = state();
    session = {
      board: current.board,
      tool: current.tool,
      pointer: e.pointerId,
      touch,
      kind: touch ? "pending" : "direct",
      event: eventCopy(e),
      originalView: { ...current.view },
      view: { ...current.view },
      selection: api.selection(),
    };
    if (!touch) {
      // Erasing starts at once and holds no marquee.
      if (eraser) return api.begin(e);
      // Point tools complete on release. Beginning them here can save an
      // object or move focus before a cancelled mouse/pen press ends.
      if (e.button === 0 && api.deferTap?.(e)) {
        session.kind = "tap";
        return;
      }
      const canHold =
        e.button === 0 &&
        !e.altKey &&
        api.canMarquee?.() &&
        !api.pressesSelection?.(e);
      api.begin(e);
      if (canHold && api.canMarquee?.())
        timer = setTimeout(() => {
          if (!valid() || session.kind !== "direct" || !api.canMarquee?.())
            return;
          api.restoreSelection(session.selection);
          api.resetTap();
          api.begin(session.event, { marquee: true, precise: true });
        }, 500);
      return;
    }
    // After a pen, a still finger or palm does nothing; one that moves on
    // pans, and two still pinch.
    if (penMode()) session.kind = "still";
    else if (["pen", "eraser", "arrow", "region"].includes(current.tool)) {
      session.kind = "direct";
      settle();
      api.begin(e);
    } else if (current.tool === "hand") {
      session.kind = "pan";
    } else if (current.tool === "select") {
      // Selected objects/handles can be dragged; unselected content is safe to pan over.
      session.edit = api.touchEdit(e);
      // A hold selects through what lies under the finger, but never on
      // the selection itself, which a drag after any pause moves.
      if (!session.edit)
        timer = setTimeout(() => {
          if (!valid() || session.kind !== "pending" || touches.size !== 1)
            return;
          session.kind = "direct";
          api.resetTap();
          settle();
          api.begin(session.event, { marquee: true, precise: true });
        }, 500);
    }
  }
  // A finger that turns out to tap or drag content, rather than move the
  // view, gives the board focus now, as a mouse press did at once.
  function settle() {
    api.prepare();
  }
  function move(e) {
    if (e.currentTarget !== canvas) return;
    if (!session) {
      if (e.pointerType !== "touch") api.hover?.(e);
      return;
    }
    if (!valid()) {
      clear();
      return;
    }
    if (session.touch) {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, eventCopy(e));
      e.preventDefault();
      if (session.kind === "pinch") {
        if (touches.size >= 2)
          api.navigate(pinchView(session.view, session.pair, pair()));
        return;
      }
    } else if (session.pointer !== e.pointerId) return;
    if (session.pointer !== e.pointerId) return;
    const dx = e.clientX - session.event.clientX,
      dy = e.clientY - session.event.clientY;
    if (!session.touch && Math.hypot(dx, dy) > 3) clearTimer();
    // A mouse or pen press with a shape or frame tool that moves on draws
    // the object at that size; a still press places it on release.
    if (
      session.kind === "tap" &&
      Math.hypot(dx, dy) > 6 &&
      api.sizes?.(session.event)
    ) {
      session.kind = "direct";
      api.begin(session.event, { size: true });
    }
    if (session.kind === "still" && Math.hypot(dx, dy) > 6) {
      session.kind = "pan";
      api.prepare(session.event);
    }
    if (session.kind === "pending" && Math.hypot(dx, dy) > 6) {
      clearTimer();
      api.resetTap();
      if (session.edit) {
        session.kind = "direct";
        settle();
        api.begin(session.event);
      } else if (session.touch && api.sizes?.(session.event)) {
        // A finger dragged with a note, text, shape or frame tool draws the
        // object at that size, as a mouse or pen does and as the tool's tip
        // says; two fingers still pan and zoom.
        session.kind = "direct";
        settle();
        api.begin(session.event, { size: true });
      } else session.kind = "pan";
    }
    if (session.kind === "pan") {
      api.navigate({
        ...session.view,
        x: session.view.x + dx,
        y: session.view.y + dy,
      });
    } else if (session.kind === "direct") api.move(e);
  }
  // `anywhere` takes a release the canvas itself never received: WebKit
  // does not deliver a pointerup to the capturing element when the pointer
  // is released outside its bounds, as a quick stroke ending past the
  // canvas edge does, and only the loss of capture reaches it.
  function up(e, cancelled = false, anywhere = false) {
    if (!anywhere && e.currentTarget !== canvas) return;
    if (!valid()) {
      clear();
      return;
    }
    if (
      session.touch
        ? !touches.has(e.pointerId)
        : session.pointer !== e.pointerId
    )
      return;
    e.preventDefault();
    if (cancelled) {
      stop(true);
      return;
    }
    clearTimer();
    if (session.kind === "pinch") {
      // Rebase after a finger leaves, so lifting/replacing fingers never jumps
      // the camera and the remaining finger never starts editing an object.
      touches.delete(e.pointerId);
      release(e.pointerId);
      if (touches.size >= 2) {
        session.view = { ...state().view };
        session.pair = pair();
      } else if (touches.size === 1) {
        const [id, event] = touches.entries().next().value;
        session.pointer = id;
        session.event = event;
        session.kind = "pan";
        session.view = { ...state().view };
      } else clear();
      return;
    }
    const s = session;
    clear();
    if (s.kind === "tap" || s.kind === "pending") {
      if (s.kind === "tap") {
        if (state().tool !== s.tool || !api.deferTap?.(s.event)) return;
      }
      if (s.kind === "tap" || api.deferTap?.(s.event)) {
        const r = canvas.getBoundingClientRect();
        // Only use bounds when layout is available. Pointer capture also
        // delivers release events outside the originating canvas.
        if (
          r.width > 0 &&
          r.height > 0 &&
          !(
            e.clientX >= r.left &&
            e.clientX < r.left + r.width &&
            e.clientY >= r.top &&
            e.clientY < r.top + r.height
          )
        )
          return;
      }
      if (s.touch) settle();
      api.begin(s.event);
      api.end(e);
    } else if (s.kind === "direct") {
      api.end(e);
      // A right-button press that never became a pan opens the menu.
      if (
        !anywhere &&
        e.type === "pointerup" &&
        s.event.button === 2 &&
        Math.hypot(e.clientX - s.event.clientX, e.clientY - s.event.clientY) <=
          4
      )
        api.contextMenu?.(e);
    }
  }
  function onWheel(e) {
    if (!canvas || !state().board) return;
    e.preventDefault();
    if (touches.size || safariGesture) return;
    // A mouse or pen drag goes on while the wheel moves the view under it,
    // as when panning to reach a far corner; other gestures finish first.
    if (session?.kind === "direct" && !session.touch && api.continues?.())
      clearTimer();
    else {
      stop();
      api.end();
    }
    const r = canvas.getBoundingClientRect();
    api.navigate(
      wheel(
        state().view,
        e,
        { width: r.width, height: r.height || 150, point: local(e) },
        mode,
      ),
    );
  }
  function gesture(e, overlay = false) {
    if (!overlay && e.currentTarget !== canvas) return;
    e.preventDefault();
    if (touches.size) return; // Pointer Events own touchscreen pinches.
    if (e.type === "gesturestart") {
      stop();
      api.end();
      safariGesture = {
        view: { ...state().view },
        board: state().board,
        point: local(e),
      };
    } else if (safariGesture && safariGesture.board === state().board) {
      if (Number.isFinite(e.scale) && e.scale > 0)
        api.navigate(
          zoomAt(
            safariGesture.view,
            safariGesture.point,
            safariGesture.view.z * e.scale,
          ),
        );
      if (e.type === "gestureend") safariGesture = null;
    }
  }
  return {
    wheel: onWheel,
    mode: () => mode,
    setMode(value) {
      mode = navigationMode(value);
      try {
        localStorage.setItem("whiteboard-navigation", mode);
      } catch {}
    },
    storage(e) {
      if (e.key === "whiteboard-navigation" || e.key === null)
        mode = navigationMode(e.newValue);
    },
    finish: () => stop(),
    cancel: () => stop(true),
    // What floats over the board, such as a text editor or a toolbar, moves
    // the board under a wheel or pinch as the canvas would, rather than
    // letting the browser zoom the page. Text or a list there that can
    // scroll further still scrolls first; a pinch always zooms the board.
    bindOverlays(container, selector) {
      container.addEventListener(
        "wheel",
        (e) => {
          const overlay = e.target.closest?.(selector);
          if (
            !canvas ||
            !overlay ||
            (!e.ctrlKey && !e.metaKey && scrollsInside(e, e.target, overlay))
          )
            return;
          onWheel(e);
        },
        { passive: false },
      );
      for (const type of ["gesturestart", "gesturechange", "gestureend"])
        container.addEventListener(
          type,
          (e) => {
            if (canvas && e.target.closest?.(selector)) gesture(e, true);
          },
          { passive: false },
        );
    },
    detach() {
      clear();
      canvas = null;
    },
    bind(element) {
      clear();
      canvas = element;
      element.addEventListener("pointerdown", down);
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", (e) => up(e));
      element.addEventListener("pointercancel", (e) => up(e, true));
      // Capture lost during a mouse or pen gesture ends it as a release
      // would, keeping what was drawn or moved so far, rather than dropping
      // it without a word: WebKit delivers no pointerup to the capturing
      // canvas for a release outside its bounds. A press not yet begun, and
      // a touch, still cancel. Capture regained at once, as by the next
      // press, is the stale notice of an earlier release; browsers differ
      // on when it arrives.
      element.addEventListener("lostpointercapture", (e) => {
        if (canvas?.hasPointerCapture?.(e.pointerId)) return;
        const finish = session?.kind === "direct" && !session.touch;
        up(e, !finish, finish);
      });
      if (!released) {
        released = true;
        globalThis.addEventListener?.("pointerup", (e) => {
          if (canvas && e.target !== canvas) up(e, false, true);
        });
      }
      element.addEventListener("contextmenu", (e) => e.preventDefault());
      element.addEventListener(
        "wheel",
        (e) => {
          if (e.currentTarget === canvas) onWheel(e);
        },
        { passive: false },
      );
      for (const type of ["gesturestart", "gesturechange", "gestureend"])
        element.addEventListener(type, gesture, { passive: false });
    },
  };
}

// The objects in the part of a board, w by h board units, that holds the
// most of them, for a board spread wider than the view can show at its
// furthest zoom out. Objects are counted by their centres in cells half
// that size, and the block of two by two cells with the most is the part;
// a tie goes to the part met first in the board's order.
export function busiestPart(items, w, h) {
  const across = w / 2,
    down = h / 2,
    cells = new Map();
  const cell = (i) => [
    Math.floor((i.x + i.w / 2) / across),
    Math.floor((i.y + i.h / 2) / down),
  ];
  for (const i of items) {
    const key = cell(i).join();
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  let best = null,
    most = 0;
  for (const key of cells.keys()) {
    const [col, row] = key.split(",").map(Number);
    for (const left of [col - 1, col])
      for (const top of [row - 1, row]) {
        const count =
          (cells.get(`${left},${top}`) || 0) +
          (cells.get(`${left + 1},${top}`) || 0) +
          (cells.get(`${left},${top + 1}`) || 0) +
          (cells.get(`${left + 1},${top + 1}`) || 0);
        if (count > most) {
          most = count;
          best = [left, top];
        }
      }
  }
  if (!best) return items;
  return items.filter((i) => {
    const [col, row] = cell(i);
    return (
      col >= best[0] &&
      col <= best[0] + 1 &&
      row >= best[1] &&
      row <= best[1] + 1
    );
  });
}
