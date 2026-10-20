// Everything a running slide show offers beyond moving through the slides:
// the right-click menu, pointer tools and ink, see all slides, zoom, the
// shortcut list, live subtitles, live cameras, media controls, the
// presenter's view (in this window or with the audience in a second one),
// kiosk behaviour, and the rehearsal and recording toolbars.
//
// The show itself (src/main.js `present`) hands over its elements and a few
// controls; this module adds to them and never replaces how slides are
// drawn, animated or transitioned.
import { el, iconButton, openMenu, closeMenu, IS_MAC } from "../ui.js";
import { lineButton, lineIcon } from "./icons.js";
import { createShowInk, INK_COLORS } from "./ink.js";
import { createSubtitles } from "./subtitles.js";
import {
  showPrefs,
  spokenLanguage,
  SUBTITLE_POSITIONS,
  speechRecognitionClass,
} from "./prefs.js";
import { prepareAudienceWindow } from "./audience.js";
import { createCameraSource, placeCameras } from "./camera.js";
import { createRehearsal } from "./rehearse.js";
import { createRecordingStudio } from "./recorder.js";

const CTRL = IS_MAC ? "Control" : "Ctrl";
const IDLE_CURSOR_MS = 3000;
const ZOOM_STEPS = [1, 2, 3, 4];

/** The show's shortcuts, as the help lists them. */
export const SHOW_SHORTCUTS = [
  ["Next slide or animation", "N, Space, Right, Down, Page Down, Enter, click"],
  ["Previous slide or animation", "P, Left, Up, Page Up, Backspace"],
  ["Go to slide number", "Number, then Enter"],
  ["First or last slide", "Home, End"],
  ["See all slides", "G or -"],
  ["Zoom in, zoom out", "+ and -"],
  ["Black screen, or back", "B or ."],
  ["White screen, or back", "W or ,"],
  ["Pause or resume automatic advance", "S"],
  ["Laser pointer", `L or ${CTRL}+L`],
  ["Pen", `${CTRL}+P`],
  ["Highlighter", `${CTRL}+I`],
  ["Eraser", `${CTRL}+E`],
  ["Erase all ink on the slide", "E"],
  ["Show or hide ink", `${CTRL}+M`],
  ["Show the pointer as an arrow", `${CTRL}+A`],
  ["Hide the pointer", `${CTRL}+H`],
  ["Hide the pointer when it rests", `${CTRL}+U`],
  ["Live subtitles on or off", `${CTRL}+J`],
  ["Shortcuts", "? or F1"],
  ["End the show", "Esc"],
];

/**
 * ctx: { P, slideBounds(pres, shape), customShows(), playCustomShow(id),
 *        afterShow(result), isNarration(shape), cameraPicture() }
 * show: the running show's parts and controls (see main.js `present`).
 */
export function createShowSession(ctx, show) {
  const { P } = ctx;
  const { pres, all, options, stage, frame, slideArea, size, setup } = show;
  const cleanups = [];
  const history = [];
  let index = -1;
  let step = 0; // animation click steps played on the current slide
  let audience = null; // { win, doc, stage, dispose }
  let mirror = null; // the presenter's copy of the slide in Presenter View
  let consoleView = null;
  let gridOverlay = null;
  let helpOverlay = null;
  let zoom = { scale: 1, cx: 0.5, cy: 0.5 };
  let pointerMode = "auto"; // auto | visible | hidden
  let idleTimer = 0;
  const kiosk =
    setup.showType === "kiosk" && !options.rehearse && !options.record;
  const listen = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  };
  const status = (message) => {
    show.status.textContent = message || "";
    stage.classList.toggle("has-status", !!message);
    if (message)
      setTimeout(() => {
        if (show.status.textContent === message) status(null);
      }, 6000);
  };

  // ---- Ink and pointer ----------------------------------------------------
  const ink = createShowInk({
    size,
    penColor: setup.penColor || "#E81224",
    onChange: () => consoleView?.sync(),
  });
  cleanups.push(ink.addSurface(frame));
  function setTool(tool) {
    if (tool && show.laserEnabled()) show.toggleLaser();
    ink.setTool(ink.tool === tool ? null : tool);
    syncToolButtons();
  }
  function toggleLaser() {
    if (ink.tool) ink.setTool(null);
    show.toggleLaser();
    syncToolButtons();
  }
  function setPointer(mode) {
    pointerMode = mode;
    if (mode !== "auto") {
      clearTimeout(idleTimer);
      stage.classList.remove("cursor-idle");
    }
    stage.classList.toggle("cursor-hidden", mode === "hidden");
    if (mode !== "hidden" && ink.tool) ink.setTool(null);
    if (mode === "hidden" && show.laserEnabled()) show.toggleLaser();
    syncToolButtons();
  }
  function wake() {
    stage.classList.remove("cursor-idle");
    clearTimeout(idleTimer);
    if (pointerMode === "auto")
      idleTimer = setTimeout(
        () => stage.classList.add("cursor-idle"),
        IDLE_CURSOR_MS,
      );
  }
  listen(stage, "pointermove", wake);
  wake();

  // ---- Cameras on slides --------------------------------------------------
  const cameras = createCameraSource();
  const cameraLayer = el("div", {
    class: "show-cameras",
    "aria-hidden": "true",
  });
  frame.append(cameraLayer);
  let clearCameras = () => {};

  // ---- Subtitles ----------------------------------------------------------
  const subtitles = createSubtitles({
    host: stage,
    language: spokenLanguage(),
    position: showPrefs.subtitlePosition,
    onState: (message) => {
      if (message) status(message);
      syncToolButtons();
    },
  });
  cleanups.push(() => subtitles.dispose());
  function toggleSubtitles() {
    subtitles.toggle();
    syncToolButtons();
  }

  // ---- Zoom ---------------------------------------------------------------
  function applyZoom() {
    const { scale, cx, cy } = zoom;
    const transform =
      scale > 1
        ? `translate(${(0.5 - cx * scale) * 100}%, ${(0.5 - cy * scale) * 100}%) scale(${scale})`
        : "";
    for (const node of [frame, mirror?.frame]) {
      if (!node) continue;
      node.style.transformOrigin = "0 0";
      node.style.transform = transform;
    }
    stage.classList.toggle("show-zoomed", scale > 1);
  }
  function clampZoom() {
    const half = 0.5 / zoom.scale;
    zoom.cx = Math.min(1 - half, Math.max(half, zoom.cx));
    zoom.cy = Math.min(1 - half, Math.max(half, zoom.cy));
  }
  let lastPoint = null;
  listen(frame, "pointermove", (e) => {
    const box = frame.getBoundingClientRect();
    if (!box.width) return;
    lastPoint = {
      x: (e.clientX - box.left) / box.width,
      y: (e.clientY - box.top) / box.height,
    };
  });
  function zoomBy(step) {
    const at = ZOOM_STEPS.indexOf(zoom.scale);
    const next =
      ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + step))];
    if (next === zoom.scale) return false;
    if (zoom.scale === 1 && next > 1) {
      zoom.cx = lastPoint?.x ?? 0.5;
      zoom.cy = lastPoint?.y ?? 0.5;
    }
    zoom.scale = next;
    clampZoom();
    applyZoom();
    return true;
  }
  function resetZoom() {
    if (zoom.scale === 1) return false;
    zoom = { scale: 1, cx: 0.5, cy: 0.5 };
    applyZoom();
    return true;
  }
  // While zoomed in, dragging moves around the slide.
  let dragged = false;
  listen(
    frame,
    "pointerdown",
    (e) => {
      dragged = false;
      if (zoom.scale === 1 || ink.tool || show.laserEnabled() || e.button !== 0)
        return;
      if (e.target.closest("button, a, video, .presenter-object")) return;
      const box = frame.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy };
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / box.width;
        const dy = (ev.clientY - start.y) / box.height;
        if (Math.abs(dx) + Math.abs(dy) > 0.005) dragged = true;
        zoom.cx = start.cx - dx;
        zoom.cy = start.cy - dy;
        clampZoom();
        applyZoom();
      };
      const up = () => {
        frame.ownerDocument.removeEventListener("pointermove", move);
        frame.ownerDocument.removeEventListener("pointerup", up);
      };
      frame.ownerDocument.addEventListener("pointermove", move);
      frame.ownerDocument.addEventListener("pointerup", up);
    },
    true,
  );
  // Clicks that only point (kiosk), pan a zoomed slide, or fall on a
  // zoomed slide do not advance the show.
  listen(
    frame,
    "click",
    (e) => {
      const onControl = e.target.closest(
        "button, a, video, .presenter-object, .presenter-link",
      );
      if (onControl) return;
      if (dragged || zoom.scale > 1 || kiosk) {
        dragged = false;
        e.stopPropagation();
      }
    },
    true,
  );

  // ---- See all slides -----------------------------------------------------
  function openGrid() {
    if (gridOverlay) return closeGrid();
    closeHelp();
    const host = consoleView ? consoleView.root : stage;
    const current = show.current();
    const items = all.map((s, i) =>
      el(
        "button",
        {
          type: "button",
          class: `show-grid-item ${i === current ? "current" : ""}`,
          "aria-label": `Slide ${i + 1}${show.title(s) ? `: ${show.title(s)}` : ""}`,
          "aria-current": i === current ? "true" : null,
          onclick: (e) => {
            e.stopPropagation();
            closeGrid();
            show.go(i);
          },
        },
        el("img", {
          src: show.picture(s),
          alt: "",
          loading: "lazy",
          draggable: "false",
        }),
        el("span", { class: "show-grid-number" }, String(i + 1)),
      ),
    );
    const list = el(
      "div",
      { class: "show-grid-list", role: "group" },
      ...items,
    );
    gridOverlay = el(
      "section",
      {
        class: "show-grid",
        "aria-label": "All slides",
        onclick: (e) => e.stopPropagation(),
      },
      el(
        "div",
        { class: "show-grid-head" },
        el("h2", {}, "All slides"),
        iconButton("Close all slides", "X", () => closeGrid()),
      ),
      list,
    );
    gridOverlay.addEventListener("keydown", (e) => {
      const at = items.indexOf(e.target.closest(".show-grid-item"));
      if (at < 0) return;
      const columns = Math.max(
        1,
        Math.round(list.clientWidth / (items[0].offsetWidth || 1)),
      );
      const moves = {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: columns,
        ArrowUp: -columns,
        Home: -at,
        End: items.length - 1 - at,
      };
      if (e.key in moves) {
        e.preventDefault();
        items[
          Math.max(0, Math.min(items.length - 1, at + moves[e.key]))
        ].focus();
      }
    });
    host.append(gridOverlay);
    (items[current] || items[0])?.focus();
    items[current]?.scrollIntoView?.({ block: "nearest" });
  }
  function closeGrid() {
    if (!gridOverlay) return false;
    gridOverlay.remove();
    gridOverlay = null;
    show.focus();
    return true;
  }

  // ---- Help ---------------------------------------------------------------
  function openHelp() {
    if (helpOverlay) return closeHelp();
    closeGrid();
    helpOverlay = el(
      "section",
      {
        class: "show-help",
        role: "dialog",
        "aria-label": "Slide show shortcuts",
        tabindex: -1,
        onclick: (e) => e.stopPropagation(),
      },
      el(
        "div",
        { class: "show-grid-head" },
        el("h2", {}, "Slide show shortcuts"),
        iconButton("Close shortcuts", "X", () => closeHelp()),
      ),
      el(
        "table",
        {},
        el(
          "tbody",
          {},
          ...SHOW_SHORTCUTS.map(([what, keys]) =>
            el("tr", {}, el("th", { scope: "row" }, what), el("td", {}, keys)),
          ),
        ),
      ),
    );
    (consoleView ? consoleView.root : stage).append(helpOverlay);
    helpOverlay.focus();
  }
  function closeHelp() {
    if (!helpOverlay) return false;
    helpOverlay.remove();
    helpOverlay = null;
    show.focus();
    return true;
  }

  // ---- Black and white screens -------------------------------------------
  const press = (key) =>
    show.dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );

  // ---- Menus --------------------------------------------------------------
  function lastViewed() {
    for (let i = history.length - 2; i >= 0; i--)
      if (history[i] !== show.current()) return history[i];
    return null;
  }
  function pointerItems() {
    return [
      {
        label: "Laser Pointer",
        shortcut: `${CTRL}+L`,
        checked: show.laserEnabled(),
        onSelect: toggleLaser,
      },
      {
        label: "Pen",
        shortcut: `${CTRL}+P`,
        checked: ink.tool === "pen",
        onSelect: () => setTool("pen"),
      },
      {
        label: "Highlighter",
        shortcut: `${CTRL}+I`,
        checked: ink.tool === "highlighter",
        onSelect: () => setTool("highlighter"),
      },
      {
        label: "Eraser",
        shortcut: `${CTRL}+E`,
        checked: ink.tool === "eraser",
        onSelect: () => setTool("eraser"),
      },
      {
        label: "Erase All Ink on Slide",
        shortcut: "E",
        disabled: !ink.has(),
        onSelect: () => ink.clear(),
      },
      { separator: true },
      {
        label: "Ink Color",
        items: INK_COLORS.map(([color, name]) => ({
          label: name,
          checked: ink.colors.pen === color,
          onSelect: () => {
            ink.setColor("pen", color);
            if (ink.tool !== "pen") setTool("pen");
          },
        })),
      },
      {
        label: "Arrow Options",
        items: [
          ["auto", "Automatic", `${CTRL}+U`],
          ["visible", "Visible", `${CTRL}+A`],
          ["hidden", "Hidden", `${CTRL}+H`],
        ].map(([mode, label, shortcut]) => ({
          label,
          shortcut,
          checked: pointerMode === mode,
          onSelect: () => setPointer(mode),
        })),
      },
      {
        label: "Show Ink",
        shortcut: `${CTRL}+M`,
        checked: ink.visible,
        onSelect: () => ink.setVisible(!ink.visible),
      },
    ];
  }
  function menuItems() {
    const shows = ctx.customShows?.() || [];
    const previous = lastViewed();
    return [
      { label: "Next", shortcut: "N", onSelect: () => show.next() },
      { label: "Previous", shortcut: "P", onSelect: () => show.previous() },
      {
        label: "Last Viewed",
        disabled: previous === null,
        onSelect: () => previous !== null && show.go(previous),
      },
      { label: "See All Slides", shortcut: "G", onSelect: openGrid },
      zoom.scale > 1
        ? { label: "Zoom Out", shortcut: "-", onSelect: () => zoomBy(-1) }
        : { label: "Zoom In", shortcut: "+", onSelect: () => zoomBy(1) },
      shows.length && !options.record && !options.rehearse
        ? {
            label: "Custom Show",
            items: shows.map((s) => ({
              label: s.name || `Custom show ${s.id + 1}`,
              onSelect: () => ctx.playCustomShow(s.id, show),
            })),
          }
        : null,
      { separator: true },
      {
        label: "Screen",
        items: [
          { label: "Black Screen", shortcut: "B", onSelect: () => press("b") },
          { label: "White Screen", shortcut: "W", onSelect: () => press("w") },
        ],
      },
      { label: "Pointer Options", items: pointerItems() },
      {
        label: "Subtitles",
        shortcut: `${CTRL}+J`,
        checked: subtitles.running,
        onSelect: toggleSubtitles,
      },
      {
        label: consoleView ? "Hide Presenter View" : "Show Presenter View",
        onSelect: () => (consoleView ? closeConsole() : openConsole()),
      },
      show.autoAdvance
        ? {
            label: show.paused() ? "Resume" : "Pause",
            shortcut: "S",
            onSelect: () => show.setPaused(!show.paused()),
          }
        : null,
      { separator: true },
      { label: "Help", shortcut: "?", onSelect: openHelp },
      { label: "End Show", shortcut: "Esc", onSelect: () => show.close() },
    ].filter(Boolean);
  }
  function openShowMenu(anchor, x = null, y = null) {
    openMenu({
      anchor,
      x,
      y,
      contextual: x !== null,
      label: "Slide show",
      items: menuItems(),
      minWidth: 230,
    });
  }
  listen(stage, "contextmenu", (e) => {
    if (e.target.closest(".presenter-controls, .show-console-side")) return;
    e.preventDefault();
    if (kiosk) return;
    openShowMenu(stage, e.clientX, e.clientY);
  });

  // ---- Buttons on the control bar ----------------------------------------
  const toolsButton = iconButton(
    "Pointer and ink tools",
    "o:penTool",
    (e) =>
      openMenu({
        anchor: e.currentTarget,
        label: "Pointer and ink tools",
        items: pointerItems(),
        minWidth: 230,
      }),
    { "aria-pressed": "false", title: "Pointer and ink tools" },
  );
  const gridButton = lineButton(
    "See all slides",
    "LayoutGrid",
    () => openGrid(),
    {
      title: "See all slides (G)",
    },
  );
  const subtitlesButton = lineButton(
    "Subtitles",
    "Captions",
    () => toggleSubtitles(),
    { "aria-pressed": "false", title: `Subtitles (${CTRL}+J)` },
  );
  const moreButton = lineButton(
    "More slide show options",
    "Ellipsis",
    (e) => openShowMenu(e.currentTarget),
    { title: "More options" },
  );
  function syncToolButtons() {
    show.inkChanged?.();
    const active = !!ink.tool || show.laserEnabled();
    toolsButton.setAttribute("aria-pressed", String(active));
    subtitlesButton.setAttribute("aria-pressed", String(subtitles.running));
    consoleView?.syncTools();
  }
  gridButton.classList.add("show-optional");
  subtitlesButton.classList.add("show-optional");
  for (const b of [toolsButton, gridButton, subtitlesButton, moreButton])
    b.classList.add("show-extra");
  if (!show.reading && !kiosk)
    show.controls.append(toolsButton, gridButton, subtitlesButton, moreButton);

  // ---- Presenter view -----------------------------------------------------
  function openConsole() {
    if (consoleView) return;
    consoleView = createConsole();
    stage.classList.add("show-presenting");
    consoleView.update();
    show.fit();
  }
  function closeConsole() {
    if (!consoleView) return;
    if (audience) detachAudience();
    consoleView.dispose();
    consoleView = null;
    stage.classList.remove("show-presenting");
    show.fit();
  }
  function createConsole() {
    const disposers = [];
    const started = { at: Date.now(), pausedAt: 0 };
    const elapsed = () => (started.pausedAt || Date.now()) - started.at;
    const time = el("span", {
      class: "show-console-time",
      role: "timer",
      "aria-label": "Time elapsed",
    });
    const pauseTimer = lineButton("Pause the timer", "Pause", () => {
      if (started.pausedAt) {
        started.at += Date.now() - started.pausedAt;
        started.pausedAt = 0;
      } else started.pausedAt = Date.now();
      syncTimer();
    });
    const resetTimer = lineButton("Restart the timer", "RotateCcw", () => {
      started.at = Date.now();
      if (started.pausedAt) started.pausedAt = started.at;
      syncTimer();
    });
    const clock = el("span", {
      class: "show-console-clock",
      "aria-label": "Time of day",
    });
    const counter = el("span", {
      class: "show-console-counter",
      "aria-live": "polite",
    });
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    function syncTimer() {
      time.textContent = fmt(elapsed());
      const paused = !!started.pausedAt;
      pauseTimer.setAttribute(
        "aria-label",
        paused ? "Resume the timer" : "Pause the timer",
      );
      pauseTimer.title = paused ? "Resume the timer" : "Pause the timer";
      pauseTimer.replaceChildren(lineIcon(paused ? "Play" : "Pause"));
      clock.textContent = new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    }
    const tick = setInterval(syncTimer, 500);
    disposers.push(() => clearInterval(tick));
    const top = el(
      "div",
      {
        class: "show-console-top",
        role: "toolbar",
        "aria-label": "Presenter timer",
      },
      time,
      pauseTimer,
      resetTimer,
      el("span", { class: "show-console-sep", "aria-hidden": "true" }),
      clock,
      el("span", { class: "show-console-sep", "aria-hidden": "true" }),
      counter,
      el("span", { class: "show-console-grow" }),
      audienceToggle(),
    );
    const nextImage = el("img", {
      class: "show-console-next",
      alt: "",
      draggable: "false",
    });
    const nextLabel = el("p", { class: "show-console-next-label" });
    const notesText = el("div", {
      class: "show-console-notes-text",
      tabindex: 0,
    });
    const setFont = (px) => {
      showPrefs.notesFontSize = Math.max(12, Math.min(48, px));
      notesText.style.fontSize = `${showPrefs.notesFontSize}px`;
    };
    setFont(showPrefs.notesFontSize);
    const side = el(
      "aside",
      {
        class: "show-console-side",
        "aria-label": "Presenter notes and next slide",
      },
      el("h2", {}, "Next"),
      nextImage,
      nextLabel,
      el(
        "div",
        { class: "show-console-notes-head" },
        el("h2", {}, "Notes"),
        lineButton("Make the notes text smaller", "AArrowDown", () =>
          setFont(showPrefs.notesFontSize - 2),
        ),
        lineButton("Make the notes text larger", "AArrowUp", () =>
          setFont(showPrefs.notesFontSize + 2),
        ),
      ),
      notesText,
    );
    // Tools across the bottom of the presenter's view.
    const toolButton = (label, name, run, extra = {}) =>
      (name.startsWith("o:") ? iconButton : lineButton)(label, name, run, {
        title: label,
        ...extra,
      });
    const tools = {
      pen: toolButton("Pen", "o:penTool", () => setTool("pen"), {
        "aria-pressed": "false",
      }),
      laser: toolButton("Laser pointer", "o:laser", () => toggleLaser(), {
        "aria-pressed": "false",
      }),
      eraser: toolButton("Eraser", "o:eraserTool", () => setTool("eraser"), {
        "aria-pressed": "false",
      }),
    };
    const bar = el(
      "div",
      {
        class: "show-console-tools",
        role: "toolbar",
        "aria-label": "Presenter tools",
      },
      tools.pen,
      tools.laser,
      tools.eraser,
      toolButton("Highlighter", "Highlighter", () => setTool("highlighter")),
      toolButton("See all slides", "LayoutGrid", () => openGrid()),
      toolButton(
        "Zoom into the slide",
        "ZoomIn",
        () => zoomBy(1) || resetZoom(),
      ),
      toolButton("Black or unblack the screen", "Moon", () => press("b")),
      toolButton("Subtitles", "Captions", () => toggleSubtitles(), {
        "aria-pressed": "false",
      }),
      toolButton("More options", "Ellipsis", (e) =>
        openShowMenu(e.currentTarget),
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn show-console-end",
          onclick: () => show.close(),
        },
        "End Show",
      ),
    );
    tools.subtitles = bar.children[7];
    stage.append(top, side, bar);
    disposers.push(() => {
      top.remove();
      side.remove();
      bar.remove();
    });
    syncTimer();
    function update() {
      const n = show.current();
      const ended = show.isEnded();
      counter.textContent = ended
        ? "End of show"
        : `Slide ${n + 1} of ${all.length}`;
      const coming = ended
        ? null
        : n + 1 < all.length
          ? all[n + 1]
          : setup.loop
            ? all[0]
            : null;
      if (coming) {
        nextImage.src = show.picture(coming);
        nextImage.hidden = false;
        const at = all.indexOf(coming);
        nextLabel.textContent = `Slide ${at + 1}${show.title(coming) ? `: ${show.title(coming)}` : ""}`;
        const steps = show.animationSteps?.() ?? 0;
        if (step < steps)
          nextLabel.textContent = `Next click: animation ${step + 1} of ${steps} on this slide, then ${nextLabel.textContent}`;
      } else {
        nextImage.removeAttribute("src");
        nextImage.hidden = true;
        nextLabel.textContent = "End of slide show";
      }
      const notes = ended ? "" : P.getSlideNotes(all[n]) || "";
      notesText.textContent = notes || "No notes for this slide.";
      notesText.classList.toggle("empty", !notes);
      mirror?.update();
    }
    function syncTools() {
      tools.pen.setAttribute("aria-pressed", String(ink.tool === "pen"));
      tools.eraser.setAttribute("aria-pressed", String(ink.tool === "eraser"));
      tools.laser.setAttribute("aria-pressed", String(show.laserEnabled()));
      tools.subtitles.setAttribute("aria-pressed", String(subtitles.running));
    }
    syncTools();
    return {
      root: stage,
      update,
      sync: () => mirror?.update(),
      syncTools,
      dispose: () => disposers.forEach((f) => f()),
    };
  }
  function audienceToggle() {
    const b = el(
      "button",
      {
        type: "button",
        class: "btn show-console-swap",
        title: "Show the slides in a second window for the audience",
        onclick: () => {
          if (audience) detachAudience();
          else {
            const win = globalThis.open(
              "",
              "presentation-audience",
              "popup=yes,width=960,height=540",
            );
            if (win) attachAudience(win);
            else
              status(
                "The browser blocked the audience window. Allow pop-ups for this site to use a second screen.",
              );
          }
          b.firstChild.textContent = audience
            ? "One window"
            : "Audience window";
        },
      },
      el("span", {}, options.audience ? "One window" : "Audience window"),
    );
    return b;
  }

  // The slide moves to the audience's window; the presenter keeps a copy.
  function attachAudience(win) {
    try {
      audience = prepareAudienceWindow(win, {
        title: ctx.title?.() || "Slide Show",
      });
    } catch {
      audience = null;
      status("The audience window could not be prepared.");
      return;
    }
    const { doc } = audience;
    audience.stage.append(slideArea);
    subtitles.moveTo(audience.stage);
    // Blank screens and the end of the show reach the audience too.
    const copyState = () => {
      for (const cls of ["blank", "blank-white", "ended"])
        audience?.stage.classList.toggle(cls, stage.classList.contains(cls));
    };
    const observer = new MutationObserver(copyState);
    observer.observe(stage, { attributes: true, attributeFilter: ["class"] });
    copyState();
    const fit = () => show.fit();
    win.addEventListener("resize", fit);
    const onKey = (e) => {
      if (handleKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        show.close();
        return;
      }
      const copy = new KeyboardEvent("keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        bubbles: true,
        cancelable: true,
      });
      show.dialog.dispatchEvent(copy);
      if (copy.defaultPrevented) e.preventDefault();
    };
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("contextmenu", (e) => e.preventDefault());
    const closed = () => {
      if (audience?.win === win) detachAudience({ closing: true });
    };
    win.addEventListener("pagehide", closed);
    mirror = createMirror();
    audience.cleanup = () => {
      observer.disconnect();
      win.removeEventListener("resize", fit);
      win.removeEventListener("pagehide", closed);
      doc.removeEventListener("keydown", onKey);
    };
    requestAnimationFrame(fit);
    setTimeout(fit, 100);
  }
  function detachAudience({ closing = false } = {}) {
    if (!audience) return;
    const current = audience;
    audience = null;
    current.cleanup?.();
    mirror?.dispose();
    mirror = null;
    stage.prepend(slideArea);
    subtitles.moveTo(stage);
    if (!closing) current.dispose();
    applyZoom();
    show.fit();
    requestAnimationFrame(() => show.fit());
  }
  // The presenter's copy of the slide, with its own ink surface and a laser
  // dot that also shows on the audience's slide.
  function createMirror() {
    const image = el("img", {
      class: "presenter-slide",
      alt: "",
      draggable: "false",
    });
    const inner = el("div", { class: "presenter-frame show-mirror" }, image);
    const dot = el("div", {
      class: "presenter-laser show-mirror-dot",
      hidden: true,
      "aria-hidden": "true",
    });
    const remoteDot = el("div", {
      class: "presenter-laser show-mirror-dot",
      hidden: true,
      "aria-hidden": "true",
    });
    inner.append(dot);
    frame.append(remoteDot);
    const area = el(
      "div",
      { class: "presenter-slide-area show-mirror-area" },
      inner,
    );
    stage.prepend(area);
    const removeInk = ink.addSurface(inner);
    const fit = () => {
      const ratio = size.width / size.height;
      const w = Math.min(area.clientWidth, area.clientHeight * ratio);
      inner.style.width = `${Math.floor(w)}px`;
      inner.style.height = `${Math.floor(w / ratio)}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    const color = () => {
      const c = setup.laserColor || "#FF0000";
      for (const d of [dot, remoteDot]) {
        d.style.backgroundColor = c;
        d.style.color = c;
      }
    };
    color();
    inner.addEventListener("pointermove", (e) => {
      if (!show.laserEnabled()) {
        dot.hidden = remoteDot.hidden = true;
        inner.classList.remove("laser-pointing");
        return;
      }
      const box = inner.getBoundingClientRect();
      const x = ((e.clientX - box.left) / box.width) * 100;
      const y = ((e.clientY - box.top) / box.height) * 100;
      for (const d of [dot, remoteDot]) {
        d.style.left = `${x}%`;
        d.style.top = `${y}%`;
        d.hidden = false;
      }
      inner.classList.add("laser-pointing");
    });
    inner.addEventListener("pointerleave", () => {
      dot.hidden = remoteDot.hidden = true;
      inner.classList.remove("laser-pointing");
    });
    inner.addEventListener("click", (e) => {
      if (e.target.closest("button, a")) return;
      if (show.laserEnabled()) return;
      if (show.isEnded()) show.close();
      else if (!kiosk) show.next();
    });
    return {
      frame: inner,
      update() {
        const n = show.current();
        if (show.isEnded()) image.removeAttribute("src");
        else image.src = show.picture(all[n]);
        image.alt = show.isEnded() ? "End of slide show" : `Slide ${n + 1}`;
      },
      dispose() {
        observer.disconnect();
        removeInk();
        area.remove();
        remoteDot.remove();
      },
    };
  }

  // ---- Media controls -----------------------------------------------------
  function addMediaControls() {
    if (!setup.showMediaControls) return;
    for (const node of frame.querySelectorAll(".presenter-media.video")) {
      const video = node.querySelector("video");
      if (!video || node.querySelector(".show-media-bar")) continue;
      if (/narration/i.test(video.getAttribute("aria-label") || ""))
        node.classList.add("show-narration-video");
      const play = el("button", {
        type: "button",
        class: "show-media-play",
        "aria-label": "Play",
      });
      const seek = el("input", {
        type: "range",
        min: 0,
        max: 1000,
        value: 0,
        "aria-label": "Seek",
      });
      const time = el("span", { class: "show-media-time" }, "0:00");
      const bar = el("div", { class: "show-media-bar" }, play, seek, time);
      const fmt = (s) =>
        `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
      const sync = () => {
        play.replaceChildren(lineIcon(video.paused ? "Play" : "Pause", 14));
        play.setAttribute("aria-label", video.paused ? "Play" : "Pause");
        if (Number.isFinite(video.duration) && video.duration > 0)
          seek.value = String(
            Math.round((video.currentTime / video.duration) * 1000),
          );
        time.textContent = fmt(video.currentTime);
      };
      for (const type of ["play", "pause", "timeupdate", "loadedmetadata"])
        video.addEventListener(type, sync);
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        if (video.paused) node.click();
        else video.pause();
      });
      seek.addEventListener("input", (e) => {
        e.stopPropagation();
        if (Number.isFinite(video.duration))
          video.currentTime = (Number(seek.value) / 1000) * video.duration;
      });
      bar.addEventListener("click", (e) => e.stopPropagation());
      bar.addEventListener("keydown", (e) => e.stopPropagation());
      node.append(bar);
      sync();
    }
  }

  // ---- Kiosk --------------------------------------------------------------
  if (kiosk) {
    stage.classList.add("show-kiosk");
    let idle = 0;
    const restart = () => {
      clearTimeout(idle);
      idle = setTimeout(() => show.go(0), setup.kioskRestartMs || 300000);
    };
    for (const type of ["pointermove", "pointerdown", "keydown"])
      listen(stage, type, restart);
    restart();
    cleanups.push(() => clearTimeout(idle));
  }

  // ---- Keyboard -----------------------------------------------------------
  const NAVIGATION = new Set([
    "ArrowRight",
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "Enter",
    " ",
    "Backspace",
  ]);
  function handleKey(e) {
    if (e.isComposing) return false;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    if (helpOverlay) {
      if (key === "Escape" || key === "?" || key === "F1") {
        closeHelp();
        return done();
      }
      return e.target.closest?.(".show-help") ? false : done();
    }
    if (gridOverlay) {
      if (key === "Escape" || lower === "g" || key === "-") {
        closeGrid();
        return done();
      }
      // Keys inside the grid move between its slides.
      return e.target.closest?.(".show-grid")
        ? NAVIGATION.has(key) && key !== "Enter" && key !== " "
          ? done()
          : false
        : done();
    }
    if (studio?.keydown?.(e)) return done();
    if (rehearsal?.keydown?.(e)) return done();
    if (key === "Escape") {
      if (ink.tool) {
        ink.setTool(null);
        syncToolButtons();
        return done();
      }
      if (resetZoom()) return done();
      return false;
    }
    if (key === "F1" || (key === "?" && !e.ctrlKey && !e.metaKey)) {
      if (kiosk) return done();
      openHelp();
      return done();
    }
    if (ctrl) {
      const actions = {
        p: () => setTool("pen"),
        i: () => setTool("highlighter"),
        e: () => setTool("eraser"),
        l: () => toggleLaser(),
        a: () => setPointer("visible"),
        h: () => setPointer("hidden"),
        u: () => setPointer("auto"),
        m: () => ink.setVisible(!ink.visible),
        j: () => toggleSubtitles(),
      };
      if (actions[lower] && !kiosk) {
        actions[lower]();
        return done();
      }
      return false;
    }
    if (!plain) return false;
    if (kiosk) {
      if (NAVIGATION.has(key) || /^[0-9a-z.,+=\-]$/i.test(key)) return done();
      return false;
    }
    if (lower === "e") {
      ink.clear();
      return done();
    }
    if (lower === "g") {
      openGrid();
      return done();
    }
    if (key === "-" || key === "_") {
      if (!zoomBy(-1)) openGrid();
      return done();
    }
    if (key === "+" || key === "=") {
      zoomBy(1);
      return done();
    }
    if (key === ".") {
      press("b");
      return done();
    }
    if (key === ",") {
      press("w");
      return done();
    }
    if (zoom.scale > 1 && NAVIGATION.has(key)) resetZoom();
    return false;
  }

  // ---- Rehearsal and recording -------------------------------------------
  const session = {
    show,
    ink,
    cameras,
    status,
    setTool,
    toggleLaser,
    openGrid,
    openMenu: openShowMenu,
    get index() {
      return index;
    },
  };
  const rehearsal = options.rehearse ? createRehearsal(ctx, session) : null;
  const studio = options.record ? createRecordingStudio(ctx, session) : null;

  // ---- Start --------------------------------------------------------------
  if (options.presenter || options.audience) openConsole();
  if (options.audience && !options.audience.closed)
    attachAudience(options.audience);
  else if (options.audience === null && options.presenter)
    status(
      "The audience window was blocked, so Presenter View shows in this window.",
    );
  if (showPrefs.alwaysSubtitles && !options.record) {
    if (speechRecognitionClass()) subtitles.start();
    else
      status(
        "Live subtitles need speech recognition, which this browser does not offer.",
      );
  }
  syncToolButtons();

  let disposed = false;
  return {
    keydown: handleKey,
    /** After the show draws slide `i`; `finished` when it opens with its
     * animations done (reached by going back, or shown without animation). */
    shown(i, { finished = false } = {}) {
      const changed = i !== index;
      step = finished ? (show.animationSteps?.() ?? 0) : 0;
      index = i;
      if (history[history.length - 1] !== i) history.push(i);
      if (changed) resetZoom();
      ink.setSlide(P.getSlidePartName(all[i]));
      clearCameras();
      clearCameras = placeCameras({
        P,
        slide: all[i],
        layer: cameraLayer,
        size,
        source: cameras,
        bounds: (shape) => ctx.slideBounds(pres, shape),
      });
      setTimeout(addMediaControls, 80);
      consoleView?.update();
      rehearsal?.shown(i);
      studio?.shown(i);
    },
    // The show's own pen button drives the same ink.
    inkTool: () => ink.tool,
    setInkTool(tool) {
      if (tool && show.laserEnabled()) show.toggleLaser();
      ink.setTool(tool);
      syncToolButtons();
    },
    inkColor: () => ink.colors.pen,
    setInkColor: (color) => ink.setColor("pen", color),
    clearInk: () => ink.clear(),
    /** An animation click step played (1) or was taken back (-1). */
    stepped(by) {
      const steps = show.animationSteps?.() ?? 0;
      step = Math.max(0, Math.min(steps, step + by));
      consoleView?.update();
    },
    /** The show reached its end screen. */
    ended() {
      ink.setTool(null);
      syncToolButtons();
      consoleView?.update();
      rehearsal?.ended();
      studio?.ended();
    },
    /** Whether media on the slide should be left out of this show. */
    skipMedia(shape) {
      return (
        (!setup.showNarration || options.record) && !!ctx.isNarration?.(shape)
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closeMenu();
      clearTimeout(idleTimer);
      clearCameras();
      const result = {
        ink: ink.all(),
        rehearsal: rehearsal?.dispose() ?? null,
        recording: studio?.dispose() ?? null,
      };
      if (audience) {
        const current = audience;
        audience = null;
        current.cleanup?.();
        current.dispose();
      }
      mirror?.dispose();
      consoleView?.dispose();
      cleanups.forEach((f) => f());
      cameras.stop();
      ctx.afterShow?.(result);
    },
  };
}
