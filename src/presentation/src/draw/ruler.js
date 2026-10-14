// The ruler stencil: a straight edge laid over the slide that pens follow.
// It is dragged to move, turned by its knob, the mouse wheel or the
// keyboard, and shows its angle. A stroke begun along either edge is drawn
// straight along it (ink-geometry followRuler).
import { el } from "../ui.js";

const KEY = "presentation.drawRuler.v1";

function load() {
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem(KEY) || "null");
    if (s && [s.x, s.y, s.angle].every(Number.isFinite))
      return {
        x: Math.min(0.95, Math.max(0.05, s.x)),
        y: Math.min(0.95, Math.max(0.05, s.y)),
        angle: s.angle,
      };
  } catch {}
  return { x: 0.5, y: 0.55, angle: -15 };
}
function save(state) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {}
}
const norm = (a) => {
  let v = (((Math.round(a * 10) / 10) % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
};

/** A ruler over `canvas()`; `slideSize()` gives the slide in EMUs. */
export function createRuler({ canvas, slideSize }) {
  let visible = false;
  const state = load();
  let node = null;
  const label = el("span", { class: "ink-ruler-angle", "aria-hidden": "true" });
  const knob = el("span", {
    class: "ink-ruler-knob",
    title: "Drag to turn the ruler",
    "aria-hidden": "true",
  });
  // Ruler proportions, as fractions of the slide's width.
  const LENGTH = 0.78,
    THICK = 0.075;

  function build() {
    node = el(
      "div",
      {
        class: "ink-ruler",
        tabindex: 0,
        role: "group",
        "aria-roledescription": "ruler",
        "aria-label": "",
        "aria-keyshortcuts":
          "ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowLeft Alt+ArrowRight",
      },
      el("span", { class: "ink-ruler-ticks", "aria-hidden": "true" }),
      label,
      knob,
    );
    node.addEventListener("pointerdown", grab);
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("keydown", key);
  }
  function place() {
    const host = canvas();
    if (!node || !host) return;
    node.style.left = `${state.x * 100}%`;
    node.style.top = `${state.y * 100}%`;
    node.style.width = `${LENGTH * 100}%`;
    node.style.height = `${(THICK * 100 * host.clientWidth) / Math.max(1, host.clientHeight)}%`;
    node.style.transform = `translate(-50%, -50%) rotate(${state.angle}deg)`;
    const shown = `${Math.round(Math.abs(state.angle))}°`;
    label.textContent = shown;
    label.style.transform = `rotate(${-state.angle}deg)`;
    node.setAttribute(
      "aria-label",
      `Ruler at ${Math.round(state.angle)} degrees. Arrow keys move it; Alt with Left or Right turns it.`,
    );
  }
  function attach() {
    const host = canvas();
    if (!visible || !host) {
      node?.remove();
      return;
    }
    if (!node) build();
    if (node.parentElement !== host) host.append(node);
    place();
  }
  function commit() {
    place();
    save(state);
  }
  function grab(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = canvas().getBoundingClientRect();
    node.setPointerCapture(e.pointerId);
    const turning = e.target === knob;
    const start = { x: state.x, y: state.y, px: e.clientX, py: e.clientY };
    const move = (ev) => {
      if (turning) {
        const cx = host.left + state.x * host.width,
          cy = host.top + state.y * host.height;
        let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
        // Whole degrees, and a pull toward the level and the upright.
        a = Math.round(a);
        for (const s of [-180, -90, -45, 0, 45, 90, 180])
          if (Math.abs(a - s) <= 2) a = s;
        state.angle = norm(a);
      } else {
        state.x = Math.min(
          1,
          Math.max(0, start.x + (ev.clientX - start.px) / host.width),
        );
        state.y = Math.min(
          1,
          Math.max(0, start.y + (ev.clientY - start.py) / host.height),
        );
      }
      place();
    };
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      commit();
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }
  function wheel(e) {
    e.preventDefault();
    state.angle = norm(
      state.angle + Math.sign(e.deltaY) * (e.shiftKey ? 15 : 1),
    );
    commit();
  }
  function key(e) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const turn = e.shiftKey ? 15 : 1;
    let handled = true;
    if (e.altKey && e.key === "ArrowLeft")
      state.angle = norm(state.angle - turn);
    else if (e.altKey && e.key === "ArrowRight")
      state.angle = norm(state.angle + turn);
    else if (e.key === "ArrowLeft") state.x = Math.max(0, state.x - step);
    else if (e.key === "ArrowRight") state.x = Math.min(1, state.x + step);
    else if (e.key === "ArrowUp") state.y = Math.max(0, state.y - step);
    else if (e.key === "ArrowDown") state.y = Math.min(1, state.y + step);
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    commit();
  }
  return {
    get visible() {
      return visible;
    },
    setVisible(on) {
      visible = !!on;
      attach();
    },
    attach,
    /** The ruler in slide EMUs, for followRuler; null while hidden. */
    geometry() {
      if (!visible) return null;
      const size = slideSize();
      return {
        cx: state.x * size.cx,
        cy: state.y * size.cy,
        angle: state.angle,
        length: LENGTH * size.cx,
        thickness: THICK * size.cx,
      };
    },
    get angle() {
      return state.angle;
    },
    set(next) {
      Object.assign(state, next);
      commit();
    },
  };
}
