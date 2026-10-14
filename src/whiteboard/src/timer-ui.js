import { t } from "./i18n.js";
import {
  MAX_TIMER,
  changeTimer,
  timerPhase,
  timerRemaining,
  timerText,
} from "./timer.js";

export function createTimerUI(api) {
  let root,
    host,
    boardId,
    interval,
    expanded = false,
    dirty = false,
    seen,
    alerted,
    audio,
    signature,
    presentation;
  let sound = true;
  try {
    sound = localStorage.getItem("whiteboard-timer-sound") !== "false";
  } catch {}
  function arm(force = false) {
    if (
      !sound ||
      (!force && timerPhase(api.board()?.timer, api.now()) !== "running")
    )
      return;
    try {
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) return;
      audio ||= new Audio();
      audio.resume()?.catch(() => {});
    } catch {}
  }
  const unlock = () => arm();
  // A browser lets a page start sound once someone has used it, so a
  // participant who clicked before the facilitator started the timer, and
  // since only watches, still hears it end.
  async function chime() {
    if (!sound) return;
    if (
      audio?.state !== "running" &&
      globalThis.navigator?.userActivation?.hasBeenActive
    ) {
      arm(true);
      // A browser that still wants a fresh click, as Safari can, leaves
      // this waiting; a chime that late would ring at the click, so it is
      // left out instead.
      try {
        await Promise.race([
          audio?.resume(),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      } catch {}
    }
    if (audio?.state !== "running") return;
    try {
      for (const [n, frequency] of [523.25, 659.25, 783.99].entries()) {
        const tone = audio.createOscillator(),
          gain = audio.createGain(),
          start = audio.currentTime + n * 0.16;
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        tone.connect(gain);
        gain.connect(audio.destination);
        tone.start(start);
        tone.stop(start + 0.36);
        tone.onended = () => {
          tone.disconnect();
          gain.disconnect();
        };
      }
    } catch {}
  }
  function detach() {
    clearInterval(interval);
    interval = null;
    seen = null;
    document.removeEventListener("visibilitychange", render);
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    root?.remove();
    root = null;
    presentation?.button.remove();
    presentation = null;
    audio?.close()?.catch(() => {});
    audio = null;
  }
  function bind() {
    const nextId = api.board()?.id;
    if (boardId !== nextId) {
      expanded = false;
      seen = null;
      alerted = null;
    }
    detach();
    boardId = nextId;
    dirty = false;
    signature = null;
    host = document.querySelector(".canvas-wrap");
    if (!host) return;
    root = document.createElement("section");
    root.id = "workshop-timer";
    root.className = "workshop-timer panel";
    root.setAttribute("aria-label", t("Workshop timer"));
    root.innerHTML = `<div class="timer-heading"><strong>${t("Timer")}</strong><button type="button" class="text-btn" id="timer-minimize">${t("Minimize")}</button></div><output id="timer-countdown" role="timer" aria-live="off" aria-label="${t("Time remaining")}"></output><p id="timer-state" role="status" aria-live="polite"></p><progress id="timer-progress" aria-label="${t("Time remaining")}" max="1" value="0"></progress><form id="timer-form"><div id="timer-setup"><div class="field-row"><label class="field">${t("Minutes")}<input id="timer-minutes" type="number" min="0" max="1440" step="1" value="5" required></label><label class="field">${t("Seconds")}<input id="timer-seconds" type="number" min="0" max="59" step="1" value="0" required></label></div><div class="timer-presets">${[1, 5, 10].map((n) => `<button type="button" class="text-btn" data-timer-preset="${n}">${n} ${t("min")}</button>`).join("")}</div></div><div class="timer-actions"><button class="primary" id="timer-start">${t("Start timer")}</button>${["pause", "resume", "stop"].map((cmd) => `<button type="button" class="secondary" data-timer-command="${cmd}">${t({ pause: "Pause timer", resume: "Resume timer", stop: "Reset timer" }[cmd])}</button>`).join("")}</div><div class="timer-extensions"><button type="button" class="text-btn" data-timer-extra="60000">+1 ${t("min")}</button><button type="button" class="text-btn" data-timer-extra="300000">+5 ${t("min")}</button></div></form><p id="timer-error" role="alert" hidden></p><label class="timer-sound"><input id="timer-sound" type="checkbox" ${sound ? "checked" : ""}>${t("Play a chime on this device")}</label><p id="timer-help" class="dialog-copy"></p>`;
    host.append(root);
    root.querySelector("#timer-minimize").onclick = () => {
      expanded = false;
      render();
      (
        presentation?.button || document.querySelector("[data-timer-access]")
      )?.focus();
    };
    root.querySelector("#timer-sound").onchange = (e) => {
      sound = e.target.checked;
      try {
        localStorage.setItem("whiteboard-timer-sound", String(sound));
      } catch {}
      if (sound) arm(true);
    };
    root.querySelectorAll("#timer-setup input").forEach(
      (input) =>
        (input.oninput = () => {
          dirty = true;
          root.querySelector("#timer-error").hidden = true;
          render();
        }),
    );
    root.querySelectorAll("[data-timer-preset]").forEach(
      (button) =>
        (button.onclick = () => {
          if (!api.canEdit()) return;
          root.querySelector("#timer-minutes").value =
            button.dataset.timerPreset;
          root.querySelector("#timer-seconds").value = "0";
          dirty = true;
          render();
        }),
    );
    root.querySelector("#timer-form").onsubmit = (e) => {
      e.preventDefault();
      if (!e.isComposing) act("start");
    };
    root
      .querySelectorAll("[data-timer-command]")
      .forEach(
        (button) => (button.onclick = () => act(button.dataset.timerCommand)),
      );
    root
      .querySelectorAll("[data-timer-extra]")
      .forEach(
        (button) =>
          (button.onclick = () => act("extend", +button.dataset.timerExtra)),
      );
    for (const event of ["copy", "cut", "paste"])
      root.addEventListener(event, (e) => e.stopPropagation());
    root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        root.querySelector("#timer-minimize").click();
      }
    });
    document.addEventListener("visibilitychange", render);
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
    render();
  }
  function act(action, extra) {
    if (!root || api.board()?.id !== boardId || !api.canEdit()) return;
    const error = root.querySelector("#timer-error");
    try {
      const timer = api.board().timer,
        now = api.now(),
        phase = timerPhase(timer, now);
      if (action === "start" && !["idle", "finished"].includes(phase)) return;
      const minutes = +root.querySelector("#timer-minutes").value,
        seconds = +root.querySelector("#timer-seconds").value;
      if (
        action === "start" &&
        (!Number.isInteger(minutes) ||
          !Number.isInteger(seconds) ||
          minutes < 0 ||
          seconds < 0 ||
          seconds > 59 ||
          minutes * 60 + seconds < 1 ||
          minutes * 60 + seconds > 86400)
      )
        throw Error("Set a timer from 1 second to 24 hours.");
      const next = changeTimer(timer, action, {
        now,
        duration: (minutes * 60 + seconds) * 1000,
        extra,
      });
      if (next !== timer) {
        arm(true);
        api.save(next);
        dirty = false;
      }
      error.hidden = true;
      render();
      if (
        ["start", "pause", "resume", "stop"].includes(action) &&
        next !== timer
      ) {
        root
          .querySelector(
            action === "stop"
              ? "#timer-minutes"
              : `[data-timer-command="${next.state === "running" ? "pause" : "resume"}"]`,
          )
          .focus();
      }
    } catch (e) {
      error.hidden = false;
      error.textContent = t(e.message);
    }
  }
  function render() {
    if (!root || !root.isConnected || api.board()?.id !== boardId) return;
    const timer = api.board().timer,
      now = api.now(),
      phase = timerPhase(timer, now),
      remaining = timerRemaining(timer, now);
    const key = timer && `${timer.id}:${timer.endsAt}`;
    const ready = api.ready?.() !== false;
    if (
      phase === "finished" &&
      seen?.phase === "running" &&
      seen.key === key &&
      alerted !== key &&
      ready
    ) {
      alerted = key;
      // The open panel says so itself, in its status; a notification too
      // would have it said twice.
      if (!expanded || covered()) api.toast("Time’s up.");
      chime();
    }
    // A finish seen while the board was busy is told of at the next tick.
    if (ready || phase !== "finished") seen = { phase, key };
    const counting = phase === "running";
    if (counting && !interval) interval = setInterval(render, 250);
    if (!counting && interval) {
      clearInterval(interval);
      interval = null;
    }
    if (root.hidden !== !expanded) {
      root.hidden = !expanded;
      api.layout?.();
      place();
    }
    const label = t(
      {
        idle: "Ready",
        running: "Counting down",
        paused: "Paused",
        finished: "Time’s up.",
      }[phase],
    );
    const draftDuration =
      (+root.querySelector("#timer-minutes").value * 60 +
        +root.querySelector("#timer-seconds").value) *
      1000;
    const display =
      phase === "idle"
        ? timerText(
            dirty && Number.isFinite(draftDuration)
              ? draftDuration
              : timer?.duration || 300000,
          )
        : timerText(remaining);
    const output = root.querySelector("#timer-countdown");
    if (output.textContent !== display) output.textContent = display;
    const state = root.querySelector("#timer-state");
    if (state.textContent !== label) state.textContent = label;
    const progress = root.querySelector("#timer-progress");
    progress.max = timer?.duration || 1;
    progress.value = remaining;
    progress.hidden = phase === "idle";
    for (const button of document.querySelectorAll("[data-timer-access]")) {
      const badge = button.querySelector(".timer-badge");
      if (badge) {
        // The badge sits in the header's top row, which is measured again
        // whenever a button there shows or hides.
        if (badge.hidden !== (phase === "idle"))
          badge.hidden = phase === "idle";
        if (badge.textContent !== display) badge.textContent = display;
      }
      // Screen readers announce a focused control's new name, so while the
      // button has focus its name changes only with the phase, not with
      // each second counted down; it gives the time again once focused anew.
      if (
        button !== document.activeElement ||
        button.dataset.timerPhase !== label
      ) {
        button.dataset.timerPhase = label;
        const name =
          phase === "idle"
            ? t("Timer")
            : `${t("Timer")} · ${display} · ${label}`;
        if (button.getAttribute("aria-label") !== name)
          button.setAttribute("aria-label", name);
      }
      button.setAttribute("aria-expanded", String(expanded));
      button.classList.toggle("timer-finished", phase === "finished");
    }
    const writable = api.canEdit(),
      sig = `${phase}:${writable}:${timer?.duration}:${!!api.board().shared}`;
    if (signature === sig) return;
    signature = sig;
    const focused = document.activeElement;
    const setup = ["idle", "finished"].includes(phase);
    root.querySelector("#timer-setup").hidden = !setup;
    root.querySelector("#timer-start").hidden = !setup;
    root.querySelector('[data-timer-command="pause"]').hidden =
      phase !== "running";
    root.querySelector('[data-timer-command="resume"]').hidden =
      phase !== "paused";
    root.querySelector('[data-timer-command="stop"]').hidden = phase === "idle";
    root.querySelector(".timer-extensions").hidden = ![
      "running",
      "paused",
    ].includes(phase);
    root
      .querySelectorAll("#timer-form input,#timer-form button")
      .forEach((el) => (el.disabled = !writable));
    root.querySelector('[data-timer-command="resume"]').disabled =
      !writable || !remaining;
    root
      .querySelectorAll("[data-timer-extra]")
      .forEach(
        (el) =>
          (el.disabled =
            !writable ||
            (timer?.duration || 0) + +el.dataset.timerExtra > MAX_TIMER),
      );
    if (!dirty && timer) {
      const seconds = Math.ceil(timer.duration / 1000);
      root.querySelector("#timer-minutes").value = Math.floor(seconds / 60);
      root.querySelector("#timer-seconds").value = seconds % 60;
    }
    if (
      root.contains(focused) &&
      (focused.disabled || focused.closest("[hidden]"))
    )
      root.querySelector("#timer-minimize").focus();
    root.querySelector("#timer-help").textContent = t(
      api.board().shared
        ? "The timer is shared with everyone on this board. Editors can control it."
        : "The timer keeps counting when minimized or when you leave this board.",
    );
  }
  // Whether the panel is drawn at all: on a phone a side panel takes its
  // place, and the stylesheet hides it.
  const covered = () =>
    root.ownerDocument.defaultView?.getComputedStyle(root).display === "none";
  function open() {
    if (!root) return;
    expanded = !expanded;
    arm(true);
    render();
    if (!expanded) return;
    // A side panel covering the timer goes, so the timer opens in view; a
    // timer that would still be out of view stays minimized.
    if (covered()) api.uncover?.();
    if (covered()) {
      expanded = false;
      render();
      return;
    }
    root.querySelector("#timer-minimize").focus();
  }
  function present(dialog) {
    if (!root) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary presentation-timer-access";
    button.dataset.timerAccess = "";
    button.setAttribute("aria-controls", "workshop-timer");
    button.innerHTML = `${t("Timer")} <span class="timer-badge"></span>`;
    button.onclick = open;
    dialog.append(button, root);
    presentation = { dialog, button };
    place();
    dialog.addEventListener(
      "close",
      () => {
        button.remove();
        if (root && host?.isConnected) {
          host.append(root);
          presentation = null;
          render();
          place();
        }
      },
      { once: true },
    );
    render();
  }
  // On a phone the selection toolbar docks under the header, with the
  // workshop banner below it. The timer opens below both rather than over
  // them, and ends above the tool rows, or over them when the screen is too
  // short to leave it room there.
  function place() {
    if (!root) return;
    let top = "",
      maxHeight = "";
    // In a presentation it keeps its place there.
    if (
      !root.hidden &&
      host &&
      root.parentNode === host &&
      host.ownerDocument.defaultView.matchMedia?.("(max-width: 760px)").matches
    ) {
      const box = host.getBoundingClientRect();
      const docked = [
        ...host.querySelectorAll(
          ":scope > #selection-tools:not(.is-floating), :scope > #workshop-banner",
        ),
      ]
        .filter((el) => !el.hidden)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height);
      if (docked.length) {
        const from = Math.max(...docked.map((r) => r.bottom)) + 8;
        const rows = [
          ...host.querySelectorAll(
            ":scope > .left-rail > .panel, :scope > .canvas-bottom > .panel",
          ),
        ]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height && r.top > from)
          .map((r) => r.top);
        const above = Math.min(box.bottom, ...rows) - 8 - from;
        top = `${Math.round(from - box.top)}px`;
        maxHeight = `${Math.round(above >= 180 ? above : box.bottom - 12 - from)}px`;
      }
    }
    if (root.style.top !== top) root.style.top = top;
    if (root.style.maxHeight !== maxHeight) root.style.maxHeight = maxHeight;
  }
  return { bind, detach, render, open, present, place };
}
