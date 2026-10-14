// Ink Replay: the slide's ink drawn again, stroke by stroke in the order and
// at the pace it was written (from each stroke's recorded timing; strokes
// without it are drawn at an even speed in their stacking order). Long
// pauses between strokes are shortened. The slide shows without its ink
// underneath while the strokes play over it.
import { el, icon } from "../ui.js";
import { isInk, strokeSamples, strokeStyle } from "./ink-model.js";

const SVG = "http://www.w3.org/2000/svg";
const MIN_GAP = 80;
const MAX_GAP = 450;

/**
 * The replay's timeline: each stroke's samples with the time (ms from the
 * replay's start) each is reached, and the replay's length. `strokes` are
 * { samples, timing, style } in stacking order; `speed` is how far an
 * untimed stroke goes per millisecond.
 */
export function replayTimeline(strokes, { speed = 10000 } = {}) {
  const order = strokes
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => {
      const ta = a.timing?.start,
        tb = b.timing?.start;
      return ta != null && tb != null ? ta - tb || a.i - b.i : a.i - b.i;
    });
  let clock = 0;
  let previous = null;
  const out = [];
  for (const s of order) {
    const pts = s.samples;
    if (!pts.length) continue;
    const times = s.timing?.times;
    const timed =
      times &&
      times.length >= 2 &&
      pts.every((p) => p.at < times.length || p.f === 0);
    let local;
    if (timed) {
      local = pts.map((p) => {
        const a = times[Math.min(p.at, times.length - 1)];
        const b = times[Math.min(p.at + 1, times.length - 1)];
        return a + (b - a) * (p.f || 0) - times[0];
      });
    } else {
      let run = 0;
      local = pts.map((p, i) => {
        if (i) run += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
        return run / speed;
      });
    }
    const duration = Math.max(local.at(-1) || 0, 1);
    let gap = previous ? MIN_GAP * 2 : 0;
    if (previous?.timing && s.timing) {
      const pause =
        s.timing.start - (previous.timing.start + previous.duration);
      gap = Math.max(MIN_GAP, Math.min(MAX_GAP, pause));
    }
    const begin = clock + gap;
    out.push({
      ...s,
      begin,
      duration,
      times: local.map((t) => begin + t),
    });
    clock = begin + duration;
    previous = { timing: s.timing, duration };
  }
  return { strokes: out, total: clock };
}

/** The points of a stroke drawn by time `t`, the last one part-way along. */
export function drawnBy(stroke, t) {
  const { samples, times } = stroke;
  if (t < times[0]) return [];
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    if (times[i] <= t) {
      out.push(samples[i]);
      continue;
    }
    const prev = samples[i - 1];
    if (prev) {
      const f = (t - times[i - 1]) / (times[i] - times[i - 1] || 1);
      out.push({
        x: prev.x + (samples[i].x - prev.x) * f,
        y: prev.y + (samples[i].y - prev.y) * f,
      });
    }
    break;
  }
  return out;
}

/**
 * Plays the ink on `slide` over `canvas`. `background` is the slide drawn
 * without its ink. Resolves when the replay is closed. `autoplay: false`
 * starts paused (for tests and reduced motion).
 */
export function playInkReplay({
  P,
  canvas,
  slide,
  slideSize,
  background,
  autoplay = true,
  onClose,
}) {
  const shapes = P.getSlideShapes(slide).filter((s) => isInk(P, s));
  const size = slideSize();
  const strokes = shapes.map((s) => ({
    samples: strokeSamples(P, s, 6),
    timing: P.getShapeInkTiming?.(s) || null,
    style: strokeStyle(P, s),
  }));
  const { strokes: timeline, total } = replayTimeline(strokes, {
    speed: size.cx / 900,
  });
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size.cx} ${size.cy}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "ink-replay-strokes");
  const paths = timeline.map((s) => {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("stroke", s.style.color);
    path.setAttribute("stroke-opacity", String(s.style.opacity));
    path.setAttribute("stroke-width", String(s.style.width));
    svg.append(path);
    return path;
  });
  const playButton = el("button", {
    type: "button",
    class: "ink-replay-btn",
  });
  const slider = el("input", {
    type: "range",
    class: "ink-replay-slider",
    min: "0",
    max: String(Math.ceil(total)),
    step: "1",
    value: "0",
    "aria-label": "Replay position",
  });
  const close = el(
    "button",
    {
      type: "button",
      class: "ink-replay-btn",
      "aria-label": "Close Ink Replay",
      title: "Close (Esc)",
    },
    icon("X", 16),
  );
  const bar = el(
    "div",
    { class: "ink-replay-bar", role: "toolbar", "aria-label": "Ink Replay" },
    playButton,
    slider,
    close,
  );
  const overlay = el(
    "div",
    {
      class: "ink-replay",
      "data-strokes": String(timeline.length),
      role: "region",
      "aria-label": "Ink Replay",
    },
    el("img", { class: "ink-replay-slide", src: background, alt: "" }),
    svg,
    bar,
  );
  canvas.append(overlay);

  let now = 0;
  let playing = false;
  let last = 0;
  let timer = null;
  function draw() {
    timeline.forEach((s, i) => {
      const pts = drawnBy(s, now);
      paths[i].setAttribute(
        "d",
        pts.length
          ? `M${pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join("L")}${pts.length === 1 ? "l1 0" : ""}`
          : "",
      );
    });
    slider.value = String(Math.round(now));
    overlay.dataset.time = String(Math.round(now));
  }
  function sync() {
    const done = now >= total;
    const label = playing ? "Pause" : done ? "Replay from the start" : "Play";
    playButton.setAttribute("aria-label", label);
    playButton.title = label;
    playButton.replaceChildren(
      icon(playing ? "Pause" : done ? "RotateCcw" : "Play", 16),
    );
    overlay.classList.toggle("playing", playing);
  }
  function tick() {
    if (!playing) return;
    const t = performance.now();
    now = Math.min(total, now + (t - last));
    last = t;
    draw();
    if (now >= total) {
      playing = false;
      sync();
      return;
    }
    timer = setTimeout(tick, 16);
  }
  function play() {
    if (now >= total) now = 0;
    playing = true;
    last = performance.now();
    sync();
    tick();
  }
  function pause() {
    playing = false;
    clearTimeout(timer);
    sync();
  }
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));
  function finish() {
    pause();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
    resolveDone();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (
      e.key === " " &&
      !e.target.closest?.("input,textarea,[contenteditable]")
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (playing) pause();
      else play();
    }
  }
  playButton.addEventListener("click", () => (playing ? pause() : play()));
  slider.addEventListener("input", () => {
    pause();
    now = Number(slider.value);
    draw();
    sync();
  });
  close.addEventListener("click", finish);
  // Clicks on the replay stay in it: the slide under it is not selected.
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  overlay.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);
  draw();
  sync();
  if (autoplay && total > 0) play();
  playButton.focus({ preventScroll: true });
  return {
    done,
    close: finish,
    play,
    pause,
    get total() {
      return total;
    },
    seek(t) {
      now = Math.max(0, Math.min(total, t));
      draw();
      sync();
    },
  };
}
