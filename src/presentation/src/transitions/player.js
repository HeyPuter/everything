// Plays a slide transition over a host element: the slide show's frame, or
// the editing canvas for Preview.
//
//   const playback = playTransition({ host, from, to, transition, backward,
//                                     layers, morph })
//   playback.finished   resolves when the transition has ended or was stopped
//   playback.cancel()   ends it at once, showing the arriving slide
//
// `from` and `to` are picture URLs of the two slides. `transition` is the
// arriving slide's TransitionOptions (effect, attributes and timing).
// Going back plays the leaving slide's transition in reverse (`backward`).
// `layers()` may supply background and content pictures for the dynamic
// content effects, and `morph(W, H)` a prepared morph scene.
//
// While playing, an overlay `.slide-transition` covers the host; it carries
// `data-effect` and a Web Animation that times the transition, so its
// duration and progress are visible to the page and to tests.

import { EFFECTS_2D } from "./effects-2d.js";
import { EFFECTS_GL, GL_EFFECTS } from "./effects-gl.js";
import { createGl } from "./gl.js";
import { drawMorph } from "./morph.js";
import {
  TRANSITIONS,
  defaultOption,
  transitionDurationMs,
  withDefaults,
} from "./catalog.js";

const DYNAMIC = new Set(["pan", "ferris", "conveyor", "window", "flythrough"]);
const MAX_WIDTH = 2400;

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Resolves Random to a concrete effect, as a show does each time it runs. */
export function resolveRandom(transition, random = Math.random) {
  if (transition?.effect !== "random") return transition;
  const pool = TRANSITIONS.filter(
    (entry) => !["none", "random", "morph", "cut"].includes(entry.id),
  );
  const entry = pool[Math.floor(random() * pool.length) % pool.length];
  const option = defaultOption(entry);
  const effect = option?.set?.effect
    ? option.set
    : { ...entry.write, ...(option?.set || {}) };
  return { ...transition, ...effect };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The slide picture did not load."));
    image.src = url;
  }).then(async (image) => {
    try {
      await image.decode?.();
    } catch {
      // Already loaded; decode() only speeds up the first draw.
    }
    return image;
  });
}

function raster(image, W, H) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.getContext("2d").drawImage(image, 0, 0, W, H);
  return canvas;
}

// A seeded generator, so pieces keep their paths from frame to frame.
function randomTable(seed) {
  const values = new Float32Array(4096);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < values.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    values[i] = (s >>> 0) / 4294967296;
  }
  return (i) => values[((i % 4096) + 4096) % 4096];
}

export function playTransition({
  host,
  from,
  to,
  transition,
  backward = false,
  layers = null,
  morph = null,
  seed = 0x5eed,
}) {
  const t = withDefaults(resolveRandom(transition));
  const duration = transitionDurationMs(transition);
  const effect = t?.effect || "none";
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  if (!t || effect === "none" || !(duration > 0) || !host) {
    done();
    return { finished, cancel() {}, element: null };
  }
  const overlay = document.createElement("div");
  overlay.className = "slide-transition";
  overlay.dataset.effect = effect;
  overlay.dataset.direction = backward ? "backward" : "forward";
  overlay.setAttribute("aria-hidden", "true");
  // Until the pictures are ready, the leaving slide stays in view.
  const holding = new Image();
  holding.className = "slide-transition-hold";
  holding.alt = "";
  holding.src = from;
  overlay.append(holding);
  host.append(overlay);

  let stopped = false;
  let clock = null;
  let frame = 0;
  let gl = null;
  const motion =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const onMotion = () => {
    if (motion?.matches) cancel();
  };
  motion?.addEventListener?.("change", onMotion);

  function cleanup() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    motion?.removeEventListener?.("change", onMotion);
    try {
      gl?.dispose();
    } catch {
      // The context may already be lost.
    }
    overlay.remove();
    done();
  }
  function cancel() {
    if (clock) clock.finish();
    else cleanup();
  }

  (async () => {
    const rect = host.getBoundingClientRect();
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    let W = Math.max(2, Math.round((rect.width || 960) * ratio));
    let H = Math.max(2, Math.round((rect.height || 540) * ratio));
    if (W > MAX_WIDTH) {
      H = Math.round((H * MAX_WIDTH) / W);
      W = MAX_WIDTH;
    }
    const [fromImage, toImage] = await Promise.all([
      loadImage(from),
      loadImage(to),
    ]);
    if (stopped) return;
    // Forward, A leaves and B arrives; backward plays the same change in
    // reverse, from the arriving slide's point of view.
    const A = raster(backward ? toImage : fromImage, W, H);
    const B = raster(backward ? fromImage : toImage, W, H);
    let parts = null;
    if (DYNAMIC.has(effect) || (effect === "prism" && t.isContent)) {
      try {
        const urls = await layers?.();
        if (urls) {
          const load = async (url) => raster(await loadImage(url), W, H);
          const [abg, afg, bbg, bfg] = await Promise.all([
            load(urls.from.bg),
            load(urls.from.fg),
            load(urls.to.bg),
            load(urls.to.fg),
          ]);
          const leaving = { bg: abg, fg: afg },
            arriving = { bg: bbg, fg: bfg };
          parts = backward
            ? { A: arriving, B: leaving }
            : { A: leaving, B: arriving };
        }
      } catch {
        parts = null;
      }
    }
    let scene = null;
    if (effect === "morph" && morph) {
      try {
        scene = await morph(W, H, backward);
      } catch (error) {
        console.warn("Morph could not prepare the slides", error);
        scene = null;
      }
    }
    if (stopped) return;
    const random = randomTable(seed);
    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = W;
    scratchCanvas.height = H;
    const cellCanvases = new Map();
    const orders = new Map();
    const g = {
      W,
      H,
      A,
      B,
      o: t,
      q: 0,
      random,
      layers: parts,
      scratch: () => scratchCanvas,
      cellCanvas: (cols, rows) => {
        const key = `${cols}x${rows}`;
        let c = cellCanvases.get(key);
        if (!c) {
          c = document.createElement("canvas");
          c.width = cols;
          c.height = rows;
          cellCanvases.set(key, c);
        }
        return c;
      },
      // A stable random order of n pieces: piece i comes at order[i].
      order: (n) => {
        let o = orders.get(n);
        if (!o) {
          const list = [...Array(n).keys()];
          for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(random(i * 7 + 3) * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
          }
          o = new Float32Array(n);
          list.forEach((piece, rank) => (o[piece] = rank));
          orders.set(n, o);
        }
        return o;
      },
    };
    const canvas = document.createElement("canvas");
    canvas.className = "slide-transition-canvas";
    canvas.width = W;
    canvas.height = H;
    let render;
    if (GL_EFFECTS.has(effect)) {
      try {
        gl = createGl(canvas);
        if (gl) {
          gl.texture(A);
          gl.texture(B);
          if (parts)
            for (const layer of [
              parts.A.bg,
              parts.A.fg,
              parts.B.bg,
              parts.B.fg,
            ])
              gl.texture(layer);
          g.gl = gl;
          const draw = EFFECTS_GL[effect];
          render = () => {
            gl.begin(W, H);
            draw(g);
          };
        }
      } catch {
        try {
          gl?.dispose();
        } catch {
          // Nothing to release.
        }
        gl = null;
      }
    }
    let surface = canvas;
    if (!render) {
      // A WebGL canvas cannot change to 2D; start from a fresh one.
      if (GL_EFFECTS.has(effect)) {
        surface = document.createElement("canvas");
        surface.className = "slide-transition-canvas";
        surface.width = W;
        surface.height = H;
      }
      const ctx = surface.getContext("2d");
      g.ctx = ctx;
      if (effect === "morph" && scene) {
        render = () => drawMorph(ctx, scene, g.q, W, H, scratchCanvas);
      } else {
        const draw = EFFECTS_2D[effect] || EFFECTS_2D.fade;
        render = () => {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          draw(g);
        };
      }
    }
    const paint = (p) => {
      g.q = backward ? 1 - p : p;
      render();
    };
    paint(0);
    overlay.replaceChildren(surface);
    clock = overlay.animate([{ opacity: 1 }, { opacity: 1 }], {
      duration,
      easing: "linear",
    });
    const tick = () => {
      if (stopped || !clock) return;
      const time = Number(clock.currentTime) || 0;
      paint(Math.min(1, Math.max(0, time / duration)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    clock.finished.then(cleanup, cleanup);
  })().catch((error) => {
    console.warn("The transition could not play", error);
    cleanup();
  });

  return { finished, cancel, element: overlay };
}
