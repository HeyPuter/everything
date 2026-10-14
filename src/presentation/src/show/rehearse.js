// Rehearse Timings: a toolbar over the show that times each slide as the
// presenter practises. At the end the new timings can be kept, so the show
// advances by itself at the same pace.
import { el } from "../ui.js";
import { lineButton, lineIcon } from "./icons.js";

export const formatClock = (ms) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function createRehearsal(ctx, session) {
  const { show } = session;
  const { P, all } = { P: ctx.P, all: show.all };
  const times = new Map(); // slide part -> ms
  let current = -1;
  let since = performance.now();
  let paused = false;
  let ended = false;
  const part = (i) => P.getSlidePartName(all[i]);
  function commit() {
    if (current < 0 || paused || ended) return;
    const now = performance.now();
    times.set(part(current), (times.get(part(current)) || 0) + now - since);
    since = now;
  }
  const slideMs = () =>
    current < 0
      ? 0
      : (times.get(part(current)) || 0) +
        (paused || ended ? 0 : performance.now() - since);
  const totalMs = () =>
    [...times.values()].reduce((a, b) => a + b, 0) +
    (paused || ended || current < 0 ? 0 : performance.now() - since);

  const slideTime = el("span", {
    class: "show-rehearse-slide",
    role: "timer",
    "aria-label": "Time on this slide",
  });
  const totalTime = el("span", {
    class: "show-rehearse-total",
    "aria-label": "Total time",
  });
  const pause = lineButton(
    "Pause the rehearsal",
    "Pause",
    () => setPaused(!paused),
    {
      "aria-pressed": "false",
    },
  );
  const next = lineButton("Next", "SkipForward", () => show.next());
  const repeat = lineButton("Time this slide again", "RotateCcw", () => {
    if (current < 0) return;
    times.set(part(current), 0);
    since = performance.now();
    sync();
  });
  const pausedNote = el(
    "span",
    { class: "show-rehearse-paused", hidden: true },
    "Paused",
  );
  const bar = el(
    "div",
    {
      class: "show-rehearse",
      role: "toolbar",
      "aria-label": "Rehearsal timer",
      onclick: (e) => e.stopPropagation(),
    },
    el("span", { class: "show-rehearse-title" }, "Rehearsing"),
    next,
    pause,
    slideTime,
    repeat,
    totalTime,
    pausedNote,
  );
  show.stage.append(bar);
  function setPaused(on) {
    if (on === paused) return;
    if (on) commit();
    paused = on;
    since = performance.now();
    pause.setAttribute("aria-pressed", String(paused));
    pause.setAttribute(
      "aria-label",
      paused ? "Resume the rehearsal" : "Pause the rehearsal",
    );
    pause.replaceChildren(lineIcon(paused ? "Play" : "Pause"));
    pausedNote.hidden = !paused;
    sync();
  }
  function sync() {
    slideTime.textContent = formatClock(slideMs());
    totalTime.textContent = formatClock(totalMs());
  }
  const tick = setInterval(sync, 250);
  sync();
  return {
    shown(i) {
      commit();
      ended = false;
      current = i;
      since = performance.now();
      sync();
    },
    ended() {
      commit();
      ended = true;
      sync();
    },
    dispose() {
      commit();
      clearInterval(tick);
      bar.remove();
      return {
        timings: [...times].filter(([, ms]) => ms > 0),
        totalMs: [...times.values()].reduce((a, b) => a + b, 0),
      };
    },
  };
}
