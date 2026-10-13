// Transitions drawn frame by frame on a canvas, for exported videos and
// animated GIFs. Each draws the moment `t` (0 to 1) between the slide being
// left and the one arriving; effects the exporter has no drawing for fade.

// CSS's "ease" curve, which the slide show's transitions use.
export function ease(t) {
  const x1 = 0.25,
    y1 = 0.1,
    x2 = 0.25,
    y2 = 1;
  const bez = (a, b, s) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  let lo = 0,
    hi = 1,
    s = t;
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) / 2;
    if (bez(x1, x2, s) < t) lo = s;
    else hi = s;
  }
  return bez(y1, y2, s);
}

// The direction a slide moves in, as a unit vector: "l" moves toward the
// left (arriving from the right), and so on.
function vector(direction, fallback = "l") {
  switch (direction || fallback) {
    case "r":
      return [1, 0];
    case "u":
      return [0, -1];
    case "d":
      return [0, 1];
    case "lu":
      return [-1, -1];
    case "ru":
      return [1, -1];
    case "ld":
      return [-1, 1];
    case "rd":
      return [1, 1];
    default:
      return [-1, 0];
  }
}

export const DRAWN_TRANSITIONS = new Set([
  "none",
  "cut",
  "fade",
  "push",
  "wipe",
  "cover",
  "pull",
  "split",
  "zoom",
  "dissolve",
  "random",
]);

export function drawTransition(context, from, to, transition, t) {
  const { width: w, height: h } = context.canvas;
  const effect = transition?.effect || "none";
  const p = ease(Math.max(0, Math.min(1, t)));
  context.save();
  context.fillStyle = "#000";
  context.fillRect(0, 0, w, h);
  const draw = (image, x = 0, y = 0, alpha = 1, scale = 1) => {
    if (!image) return;
    context.globalAlpha = alpha;
    const sw = w * scale,
      sh = h * scale;
    context.drawImage(image, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh);
    context.globalAlpha = 1;
  };
  switch (effect) {
    case "none":
    case "cut":
      draw(t < 1 ? from : to);
      break;
    case "push": {
      const [dx, dy] = vector(transition.direction);
      draw(from, dx * w * p, dy * h * p);
      draw(to, dx * w * (p - 1), dy * h * (p - 1));
      break;
    }
    case "cover": {
      const [dx, dy] = vector(transition.direction);
      draw(from);
      draw(to, dx * w * (p - 1), dy * h * (p - 1));
      break;
    }
    case "pull": {
      const [dx, dy] = vector(transition.direction);
      draw(to);
      draw(from, dx * w * p, dy * h * p);
      break;
    }
    case "wipe": {
      // The arriving slide is revealed by an edge that travels across.
      const [dx, dy] = vector(transition.direction);
      draw(from);
      context.beginPath();
      if (dx < 0) context.rect(w * (1 - p), 0, w * p, h);
      else if (dx > 0) context.rect(0, 0, w * p, h);
      else if (dy < 0) context.rect(0, h * (1 - p), w, h * p);
      else context.rect(0, 0, w, h * p);
      context.clip();
      draw(to);
      break;
    }
    case "split": {
      const vertical = transition.orientation === "vert";
      const out = transition.direction !== "in";
      draw(from);
      context.beginPath();
      const k = out ? p : 1 - p;
      if (vertical) {
        if (out) context.rect((w * (1 - k)) / 2, 0, w * k, h);
        else {
          context.rect(0, 0, (w * (1 - k)) / 2, h);
          context.rect(w - (w * (1 - k)) / 2, 0, (w * (1 - k)) / 2, h);
        }
      } else if (out) context.rect(0, (h * (1 - k)) / 2, w, h * k);
      else {
        context.rect(0, 0, w, (h * (1 - k)) / 2);
        context.rect(0, h - (h * (1 - k)) / 2, w, (h * (1 - k)) / 2);
      }
      context.clip();
      draw(to);
      break;
    }
    case "zoom":
      draw(from, 0, 0, 1 - p, 1 + 0.15 * p);
      draw(to, 0, 0, p, 0.85 + 0.15 * p);
      break;
    default:
      if (transition?.throughBlack || transition?.thruBlk) {
        if (p < 0.5) draw(from, 0, 0, 1 - p * 2);
        else draw(to, 0, 0, (p - 0.5) * 2);
      } else {
        draw(from);
        draw(to, 0, 0, p);
      }
  }
  context.restore();
}

// How long a slide's transition plays, in milliseconds: its own duration,
// else its speed; no transition (or a cut) takes no time.
export function transitionDuration(transition) {
  const effect = transition?.effect || "none";
  if (effect === "none" || effect === "cut") return 0;
  return (
    transition.durationMs ??
    { fast: 500, med: 750, slow: 1000 }[transition.speed ?? "fast"] ??
    500
  );
}

// The show as a timeline: for each slide, when its transition starts, how
// long it plays, and how long the slide then stays.
export function showTimeline(
  transitions,
  { secondsPerSlide = 5, useTimings = true } = {},
) {
  let at = 0;
  return transitions.map((transition, i) => {
    const duration = i === 0 ? 0 : transitionDuration(transition);
    const timed = useTimings && Number.isFinite(transition?.advanceAfterMs);
    const hold = Math.max(
      timed ? transition.advanceAfterMs : secondsPerSlide * 1000,
      100,
    );
    const entry = { start: at, transition: duration, hold };
    at += duration + hold;
    return entry;
  });
}
