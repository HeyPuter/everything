// What inserted objects do in a slide show: video and audio play as their
// playback settings say, zooms jump to their slide or section and come
// back, and action settings follow clicks and pointer-overs with jumps,
// sounds and highlights.
import { el } from "../ui.js";
import {
  groupParents,
  slideBounds,
  slideRotation,
  visibleSlideShapes,
} from "../model.js";
import { bytesUrl } from "./util.js";

export function createShowExtras(ctx, show) {
  const { P } = ctx;
  const { pres, all, frame, size } = show;
  const urls = [];
  const url = (bytes, type) => {
    const u = bytesUrl(bytes, type);
    urls.push(u);
    return u;
  };
  const partOf = (s) => P.getSlidePartName(s);
  const indexOfPart = (part) => all.findIndex((s) => partOf(s) === part);
  let index = -1;
  let layer = null;
  let images = new Map();
  let returnTo = null; // { zoom: index, from: index, until: index }
  const viewed = [];
  let sound = null;
  let pendingMedia = []; // media waiting for clicks, in order
  const playing = new Set(); // { element, across }
  let selfJump = false;

  // ---- Slide images without media hidden while not playing ---------------
  async function prepare() {
    const hidden = all.some((s) =>
      P.getSlideShapes(s).some(
        (x) =>
          P.getShapeMediaKind(x) &&
          P.getShapeMedia(x)?.options.hideWhileNotPlaying,
      ),
    );
    if (!hidden) return;
    const copy = await P.loadPresentation(await P.savePresentation(pres));
    const byPart = new Map(P.getSlides(copy).map((s) => [partOf(s), s]));
    for (const s of all) {
      const twin = byPart.get(partOf(s));
      if (!twin) continue;
      let changed = false;
      for (const x of P.getSlideShapes(twin))
        if (
          P.getShapeMediaKind(x) &&
          P.getShapeMedia(x)?.options.hideWhileNotPlaying
        ) {
          P.setShapeHidden(x, true);
          changed = true;
        }
      if (changed) images.set(partOf(s), ctx.previewOf(copy, twin));
    }
  }
  const imageFor = (slide) => images.get(partOf(slide)) ?? null;

  // ---- Regions ----------------------------------------------------------
  function region(shape, parents, cls) {
    const b = slideBounds(pres, shape, parents);
    if (!b) return null;
    const node = el("div", { class: `presenter-object ${cls}` });
    Object.assign(node.style, {
      left: `${(b.x / size.width) * 100}%`,
      top: `${(b.y / size.height) * 100}%`,
      width: `${(b.w / size.width) * 100}%`,
      height: `${(b.h / size.height) * 100}%`,
      transform: `rotate(${slideRotation(shape, parents)}deg)`,
    });
    return node;
  }

  const zoomData = (shape) => {
    const data = P.getShapeObjectData(shape);
    return data?.type === "zoom" ? data : null;
  };
  const actionsOf = (shape) => {
    try {
      return P.getShapeActionSettings(shape);
    } catch {
      return { click: null, hover: null };
    }
  };
  const ownAction = (a) =>
    !!a &&
    a.jump.action !== "ppaction://media" &&
    (!!a.sound ||
      a.highlight ||
      ["endShow", "lastViewed", "none"].includes(a.jump.kind));
  /** Objects these extras handle; the show's own link regions skip them. */
  function claims(shape) {
    if (P.getShapeMediaKind(shape)) return true;
    if (zoomData(shape)) return true;
    const a = actionsOf(shape);
    return !!a.hover || ownAction(a.click);
  }

  function playSound(action) {
    if (!action?.sound) return;
    sound?.pause();
    sound = null;
    if (action.sound === "stop") return;
    sound = new Audio(url(action.sound.data, "audio/wav"));
    sound.play().catch(() => {});
  }
  function flash(node) {
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }
  function jump(action) {
    const j = action?.jump;
    if (!j) return;
    switch (j.kind) {
      case "nextSlide":
        return go(index + 1);
      case "prevSlide":
        return go(index - 1);
      case "firstSlide":
        return go(0);
      case "lastSlide":
        return go(all.length - 1);
      case "lastViewed":
        return viewed.length > 1 ? go(viewed[viewed.length - 2]) : undefined;
      case "endShow":
        return show.close();
      case "slide": {
        const i = indexOfPart(partOf(j.slide));
        return i >= 0 ? go(i) : undefined;
      }
      case "url":
        if (/^(https?:|mailto:)/i.test(j.url))
          window.open(j.url, "_blank", "noopener,noreferrer");
    }
  }
  function go(i) {
    selfJump = true;
    try {
      show.show(Math.max(0, Math.min(all.length - 1, i)));
    } finally {
      selfJump = false;
    }
  }

  // ---- Zoom -------------------------------------------------------------
  function zoomTo(shape, data, node) {
    const link = P.getShapeClickAction(shape);
    if (link?.kind !== "slide") return;
    const target = indexOfPart(partOf(link.slide));
    if (target < 0) return;
    let until = target;
    if (data.kind !== "slide") {
      const section = (P.getSlideSections(pres) || []).find((sec) =>
        sec.slides.some((s) => partOf(s) === partOf(link.slide)),
      );
      if (section) {
        const parts = new Set(section.slides.map(partOf));
        while (until + 1 < all.length && parts.has(partOf(all[until + 1])))
          until++;
      }
    }
    const from = index;
    const finish = () => {
      returnTo = data.returnToZoom
        ? { zoom: from, start: target, until }
        : null;
      go(target);
    };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (data.transition === false || reduce) return finish();
    // The zoom's picture grows from its place to fill the slide.
    const r = node.getBoundingClientRect(),
      f = frame.getBoundingClientRect();
    const grow = el("img", {
      class: "presenter-zoom-grow",
      src: ctx.previewOf(pres, all[target]),
      alt: "",
    });
    Object.assign(grow.style, {
      left: `${r.left - f.left}px`,
      top: `${r.top - f.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      transitionDuration: `${data.duration ?? 1000}ms`,
    });
    frame.append(grow);
    void grow.offsetWidth;
    Object.assign(grow.style, {
      left: "0px",
      top: "0px",
      width: `${f.width}px`,
      height: `${f.height}px`,
    });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      finish();
      grow.remove();
    };
    grow.addEventListener("transitionend", end, { once: true });
    setTimeout(end, (data.duration ?? 1000) + 200);
  }

  // ---- Media ------------------------------------------------------------
  function mediaPlayer(shape, parents) {
    const media = P.getShapeMedia(shape);
    if (!media) return null;
    const o = media.options;
    const node = region(shape, parents, `presenter-media ${media.kind}`);
    if (!node) return null;
    const element = document.createElement(
      media.kind === "video" ? "video" : "audio",
    );
    element.src = url(media.data, media.contentType);
    element.preload = "auto";
    element.playsInline = true;
    element.setAttribute(
      "aria-label",
      `${media.kind === "video" ? "Video" : "Audio"}: ${P.getShapeDescription?.(shape) || P.getShapeName?.(shape) || ""}`,
    );
    if (media.kind === "video") node.append(element);
    const durationMs = Number(P.getShapeObjectData(shape)?.durationMs) || 0;
    const startAt = o.trimStart / 1000;
    const endAt = () =>
      ((durationMs || element.duration * 1000 || Infinity) - o.trimEnd) / 1000;
    const volume = o.muted ? 0 : o.volume;
    element.volume = volume;
    let fading = 0;
    const fade = () => {
      cancelAnimationFrame(fading);
      const step = () => {
        const t = element.currentTime;
        let k = 1;
        if (o.fadeIn) k = Math.min(k, (t - startAt) / (o.fadeIn / 1000));
        if (o.fadeOut) k = Math.min(k, (endAt() - t) / (o.fadeOut / 1000));
        k = Math.max(0, Math.min(1, k));
        element.volume = volume * k;
        if (media.kind === "video" && (o.fadeIn || o.fadeOut))
          element.style.opacity = String(k);
        if (!element.paused) fading = requestAnimationFrame(step);
      };
      step();
    };
    const player = {
      shape,
      element,
      node,
      kind: media.kind,
      options: o,
      across: media.kind === "audio" && o.playAcrossSlides,
      started: false,
      play() {
        player.started = true;
        if (
          element.currentTime < startAt ||
          element.currentTime >= endAt() - 0.05
        )
          element.currentTime = startAt;
        node.classList.add("playing");
        if (o.fullScreen && media.kind === "video")
          node.classList.add("full-screen");
        playing.add(player);
        element.play().catch(() => {});
        fade();
      },
      pause() {
        element.pause();
      },
      toggle() {
        if (element.paused) player.play();
        else player.pause();
      },
      stop() {
        element.pause();
        cancelAnimationFrame(fading);
        playing.delete(player);
        node.remove();
        element.remove();
      },
    };
    element.addEventListener("timeupdate", () => {
      if (element.currentTime < endAt()) return;
      if (o.loop) {
        element.currentTime = startAt;
        return;
      }
      element.pause();
      node.classList.remove("full-screen");
      if (o.rewind) {
        element.currentTime = startAt;
        node.classList.remove("playing");
      }
    });
    element.addEventListener("ended", () => {
      if (o.loop) player.play();
      else {
        node.classList.remove("full-screen");
        if (o.rewind) node.classList.remove("playing");
      }
    });
    element.addEventListener("pause", () => cancelAnimationFrame(fading));
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      player.toggle();
    });
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `Play or pause ${media.kind}`);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        player.toggle();
      }
    });
    // Media hidden while not playing shows only while it plays.
    if (o.hideWhileNotPlaying) node.classList.add("hide-stopped");
    // Sound lives on the frame, so playing across slides outlasts the slide.
    if (media.kind === "audio") {
      element.hidden = true;
      frame.append(element);
    }
    return player;
  }

  // ---- Slide lifecycle ----------------------------------------------------
  function slideShown(slide, i) {
    index = i;
    if (viewed[viewed.length - 1] !== i) viewed.push(i);
    // Focus on an object of the slide being left stays in the show.
    const hadFocus = !!layer?.contains(document.activeElement);
    layer?.remove();
    if (hadFocus)
      frame.querySelector(".presenter-slide:not(.presenter-leaving)")?.focus();
    for (const p of [...playing]) if (!p.across) p.stop();
    pendingMedia = [];
    layer = el("div", { class: "presenter-objects" });
    frame.append(layer);
    const parents = groupParents(slide);
    const autoplay = [];
    for (const shape of visibleSlideShapes(slide)) {
      if (P.getShapeMediaKind(shape)) {
        // Narrations stay silent when the show is set to play without them.
        if (show.skipMedia?.(shape)) continue;
        const player = mediaPlayer(shape, parents);
        if (!player) continue;
        layer.append(player.node);
        if (player.options.start === "automatically") autoplay.push(player);
        else if (player.options.start === "inClickSequence")
          pendingMedia.push(player);
        continue;
      }
      const zoom = zoomData(shape);
      if (zoom) {
        const node = region(shape, parents, "presenter-zoom");
        if (!node) continue;
        const target = P.getShapeClickAction(shape);
        node.append(
          el("button", {
            type: "button",
            class: "presenter-zoom-button",
            "aria-label": `Zoom to ${target?.kind === "slide" ? `slide ${indexOfPart(partOf(target.slide)) + 1}` : "slide"}`,
            onclick: (e) => {
              e.stopPropagation();
              zoomTo(shape, zoom, node);
            },
          }),
        );
        layer.append(node);
        continue;
      }
      const actions = actionsOf(shape);
      if (!actions.hover && !ownAction(actions.click)) continue;
      const node = region(shape, parents, "presenter-action");
      if (!node) continue;
      const button = el("button", {
        type: "button",
        class: "presenter-action-button",
        "aria-label": P.getShapeDescription?.(shape) || "Action",
        onclick: (e) => {
          e.stopPropagation();
          if (!actions.click) return;
          if (actions.click.highlight) flash(node);
          playSound(actions.click);
          jump(actions.click);
        },
      });
      if (!actions.click) button.classList.add("hover-only");
      node.append(button);
      if (actions.hover)
        node.addEventListener("pointerenter", () => {
          if (actions.hover.highlight) flash(node);
          playSound(actions.hover);
          jump(actions.hover);
        });
      layer.append(node);
    }
    // Media that starts by itself waits for the slide's transition, unless
    // the show has moved on or ended by then.
    const shown = layer;
    setTimeout(() => {
      if (layer === shown) autoplay.forEach((p) => p.play());
    }, 50);
  }

  /** The slide to go to instead of `i`; null when the step was used up.
   * `step` is "click" or "auto" (the show's timer) for a plain advance and
   * unset for a jump to a slide. */
  function navigate(i, from, { step } = {}) {
    if (selfJump) return i;
    if (step && i === from + 1) {
      // The next click plays media waiting in the click sequence; the
      // timer and jumps move on without it.
      const waiting = step === "click" && pendingMedia.shift();
      if (waiting) {
        waiting.play();
        return null;
      }
      if (returnTo && from === returnTo.until) {
        const back = returnTo.zoom;
        returnTo = null;
        return back;
      }
    }
    if (returnTo && (i < returnTo.start || i > returnTo.until)) returnTo = null;
    return i;
  }

  function dispose() {
    for (const p of [...playing]) p.stop();
    sound?.pause();
    layer?.remove();
    layer = null;
    urls.forEach((u) => URL.revokeObjectURL(u));
  }

  return { prepare, imageFor, slideShown, navigate, claims, dispose };
}
