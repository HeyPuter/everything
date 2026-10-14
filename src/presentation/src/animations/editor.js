// The Animations tab and everything around it in the editor: applying and
// changing effects, the Animation Pane, numbered badges on the canvas,
// previews, the Animation Painter, triggers and custom motion paths.
//
// The slide's effects live in its timing tree; every change reads the list
// (P.getSlideAnimations), edits it, and writes it back (setSlideAnimations)
// through the editor's undoable mutateSlide.
import "./animations.css";
import "./editor.css";
import { el, openMenu, toast } from "../ui.js";
import {
  CATEGORIES,
  EFFECTS,
  categoryOf,
  effectIcon,
  effectKey,
  effectName,
  entryFor,
  newEffect,
  noneIcon,
} from "./catalog.js";
import { createAnimationPlayer, pathEnd, slideTimeline } from "./player.js";
import { movePathEnd } from "./options.js";
import { createAnimationPane } from "./pane.js";
import { effectOptionsDialog, moreEffectsDialog } from "./dialogs.js";
import { optionGroups } from "./options.js";

export const START_LABELS = {
  click: "On Click",
  with: "With Previous",
  after: "After Previous",
};
const seconds = (ms) => Math.round(ms / 10) / 100;

export function createAnimationTools(ctx) {
  const { P } = ctx;
  // Effects chosen in the pane (indexes into the slide's list). Empty means
  // "the effects of the selected objects".
  let chosen = [];
  let chosenFor = "";
  let autoPreview = true;
  let painter = null; // { effects, sticky }
  let preview = null; // the player while a preview plays
  let drawing = null; // custom path drawing state
  let tabActive = false;
  const pane = createAnimationPane({
    tools: () => api,
    P,
    ctx,
  });

  const slide = () => ctx.slide();
  const effects = () => {
    const s = slide();
    if (!s) return [];
    try {
      return P.getSlideAnimations(s);
    } catch {
      return [];
    }
  };
  const selectedIds = () =>
    new Set(ctx.selectedShapes().map((s) => String(P.getShapeId(s))));
  // The effects the ribbon's timing and options act on.
  function current() {
    const list = effects();
    const key = [...selectedIds()].sort().join(",");
    if (chosenFor !== key || chosen.some((i) => i >= list.length)) {
      chosen = [];
      chosenFor = key;
    }
    if (chosen.length)
      return chosen.map((i) => ({ index: i, effect: list[i] }));
    const ids = selectedIds();
    return list
      .map((effect, index) => ({ index, effect }))
      .filter(({ effect }) => ids.has(effect.shapeId));
  }
  function choose(indexes, { select = true } = {}) {
    const list = effects();
    chosen = [...new Set(indexes)].filter((i) => i >= 0 && i < list.length);
    const shapeIds = [...new Set(chosen.map((i) => list[i].shapeId))];
    if (select && shapeIds.length) ctx.selectShapes(shapeIds.map(Number));
    chosenFor = [...selectedIds()].sort().join(",");
    ctx.refresh();
  }
  const shapeText = (shapeId) => {
    const shape = P.findShapeById(slide(), Number(shapeId));
    if (!shape) return false;
    try {
      return P.getShapeParagraphCount(shape) > 0 && !!P.getShapeText(shape);
    } catch {
      return false;
    }
  };
  const hasText = (shapeId) => shapeText(shapeId);

  // Writes a new list; `pick` says which effects to choose afterwards.
  function write(next, { pick = null, coalesce = null, label = null } = {}) {
    const target = slide();
    if (!target) return Promise.resolve(false);
    return ctx
      .mutateSlide(target, (s) => P.setSlideAnimations(s, next), {
        coalesce,
      })
      .then((done) => {
        if (done && pick) {
          chosen = pick;
          chosenFor = [...selectedIds()].sort().join(",");
        }
        if (done && label) ctx.announce?.(label);
        ctx.refresh();
        return done;
      });
  }
  function update(change, options) {
    const list = effects();
    const targets = current();
    if (!targets.length) return Promise.resolve(false);
    const next = list.map((e, i) =>
      targets.some((t) => t.index === i) ? { ...e, ...change(e) } : e,
    );
    return write(next, { pick: targets.map((t) => t.index), ...options });
  }

  // ---- Applying effects ----
  function applyEntry(entry, { add = false } = {}) {
    if (entry?.custom) return startCustomPath({ add });
    const shapes = ctx.selectedShapes();
    if (!shapes.length) {
      toast("Select an object to animate first.");
      return;
    }
    const list = effects();
    const targets = current();
    let next = [...list];
    let pick = [];
    if (!entry) {
      // None: removes the selected objects' (or chosen) effects.
      const drop = new Set(targets.map((t) => t.index));
      return write(
        list.filter((_, i) => !drop.has(i)),
        { label: "Animation removed" },
      );
    }
    if (!add && targets.length) {
      // Replace each chosen effect, keeping its timing.
      next = list.map((e, i) => {
        if (!targets.some((t) => t.index === i)) return e;
        const fresh = newEffect(entry, e.shapeId);
        return {
          ...fresh,
          start: e.start,
          delayMs: e.delayMs,
          ...(e.trigger ? { trigger: e.trigger } : {}),
          ...(e.text && entry.cls !== "path" && hasText(e.shapeId)
            ? { text: e.text }
            : {}),
          ...(entry.cls === "path" &&
          e.presetClass === "path" &&
          e.path &&
          !entry.id
            ? { path: e.path }
            : {}),
        };
      });
      pick = targets.map((t) => t.index);
    } else {
      for (const shape of shapes) {
        const id = String(P.getShapeId(shape));
        // Text in a placeholder or a text box builds a paragraph at a time
        // by default, as lists usually are presented.
        const text =
          entry.cls !== "path" &&
          entry.cls !== "emph" &&
          P.getShapePlaceholderType?.(shape) &&
          P.getShapeParagraphCount(shape) > 1
            ? { text: { by: "paragraph", level: 1 } }
            : {};
        next.push(newEffect(entry, id, text));
        pick.push(next.length - 1);
      }
    }
    if (entry.text && pick.some((i) => !hasText(next[i].shapeId))) {
      toast(`${entry.name} needs an object with text.`);
      return;
    }
    return write(next, { pick, label: `${entry.name} applied` }).then(
      (done) => {
        if (done && autoPreview) playPreview({ only: pick });
      },
    );
  }

  // ---- Previews ----
  function stopPreview() {
    if (!preview) return;
    preview.player.destroy();
    preview.overlay.remove();
    ctx.canvas()?.classList.remove("anim-previewing");
    preview = null;
    ctx.refresh();
  }
  async function playPreview({ only = null, from = 0 } = {}) {
    stopPreview();
    const canvas = ctx.canvas();
    const s = slide();
    if (!canvas || !s) return;
    const all = effects();
    if (!all.length) return;
    let list = all;
    if (only) {
      list = only.map((i) => all[i]).filter(Boolean);
      // Played on their own, the chosen effects start together, in order.
      list = list.map((e, i) => ({
        ...e,
        start: i === 0 ? "click" : e.start === "click" ? "after" : e.start,
        trigger: undefined,
      }));
    }
    const overlay = el("div", {
      class: "anim-preview",
      role: "img",
      "aria-label": "Animation preview",
    });
    canvas.append(overlay);
    canvas.classList.add("anim-previewing");
    let player;
    try {
      player = createAnimationPlayer({
        pres: ctx.doc().pres,
        slide: s,
        frame: overlay,
        effects: list,
        renderLayer: (layer) => ctx.renderLayer(s, layer),
      });
    } catch (error) {
      overlay.remove();
      canvas.classList.remove("anim-previewing");
      throw error;
    }
    const session = { player, overlay };
    preview = session;
    overlay.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      stopPreview();
    });
    ctx.refresh();
    await player.playAll({ from });
    if (preview === session)
      setTimeout(() => preview === session && stopPreview(), 400);
  }

  // ---- Effect options ----
  function optionsFor() {
    const targets = current();
    if (!targets.length) return [];
    const first = targets[0].effect;
    const entry = entryFor(first);
    return optionGroups(entry, first, {
      hasText: hasText(first.shapeId),
      paragraphs: shapeParagraphCount(first.shapeId),
    });
  }
  const shapeParagraphCount = (shapeId) => {
    const shape = P.findShapeById(slide(), Number(shapeId));
    try {
      return shape ? P.getShapeParagraphCount(shape) : 0;
    } catch {
      return 0;
    }
  };
  // A path effect's own path, or its preset's, for options that change it.
  const withPath = (e) =>
    e.presetClass === "path" && !e.path
      ? { ...e, path: P.motionPathFor(e.presetId, e.presetSubtype) }
      : e;
  function effectOptionsMenu() {
    const groups = optionsFor();
    const items = [];
    for (const group of groups) {
      if (items.length) items.push({ separator: true });
      items.push({ header: group.label });
      for (const option of group.options)
        items.push({
          label: option.label,
          checked: option.active,
          onSelect: () =>
            update((e) => option.apply(withPath(e)), { label: option.label }),
        });
    }
    if (!items.length)
      items.push({ label: "No options for this effect", disabled: true });
    return items;
  }

  // ---- Animation Painter ----
  function startPainter(sticky = false) {
    if (painter) {
      painter = null;
      ctx.canvas()?.classList.remove("anim-painting");
      ctx.refresh();
      return;
    }
    const source = current();
    if (!source.length) {
      toast("Select an animated object to copy its animation.");
      return;
    }
    painter = { effects: source.map((t) => t.effect), sticky };
    ctx.canvas()?.classList.add("anim-painting");
    toast("Click an object to give it this animation.");
    ctx.refresh();
  }
  function paintOnto(shapeId) {
    if (!painter) return false;
    const id = String(shapeId);
    const list = effects().filter((e) => e.shapeId !== id);
    const copies = painter.effects.map((e) => {
      const { source, trigger, ...rest } = e;
      return {
        ...rest,
        shapeId: id,
        ...(rest.text && !hasText(id) ? { text: undefined } : {}),
      };
    });
    const next = [...list, ...copies];
    if (!painter.sticky) {
      painter = null;
      ctx.canvas()?.classList.remove("anim-painting");
    }
    write(next, {
      pick: copies.map((_, i) => list.length + i),
      label: "Animation copied",
    });
    return true;
  }

  // ---- Reordering, timing, triggers ----
  function move(direction) {
    const list = effects();
    const targets = current()
      .map((t) => t.index)
      .sort((a, b) => a - b);
    if (!targets.length) return;
    const order = list.map((_, i) => i);
    const seq = direction < 0 ? targets : [...targets].reverse();
    for (const i of seq) {
      const at = order.indexOf(i);
      const to = at + direction;
      if (to < 0 || to >= order.length || targets.includes(order[to])) continue;
      [order[at], order[to]] = [order[to], order[at]];
    }
    const next = order.map((i) => list[i]);
    write(next, {
      pick: targets.map((i) => order.indexOf(i)),
      label: direction < 0 ? "Moved earlier" : "Moved later",
    });
  }
  function reorder(from, to) {
    const list = effects();
    if (from === to || from < 0 || from >= list.length) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
    write(next, { pick: [next.indexOf(item)], label: "Animation moved" });
  }
  function remove(indexes = current().map((t) => t.index)) {
    const drop = new Set(indexes);
    if (!drop.size) return;
    chosen = [];
    write(
      effects().filter((_, i) => !drop.has(i)),
      { label: drop.size > 1 ? "Animations removed" : "Animation removed" },
    );
  }
  function triggerMenu() {
    const targets = current();
    const s = slide();
    const ids = new Set(targets.map((t) => t.effect.shapeId));
    const shapes = s
      ? ctx.topLevelShapes(s).filter((x) => !ids.has(String(P.getShapeId(x))))
      : [];
    const triggerOf = targets[0]?.effect.trigger;
    return [
      {
        label: "On Click of",
        items: shapes.length
          ? shapes.map((x) => ({
              label: ctx.shapeLabel(x),
              checked: triggerOf === String(P.getShapeId(x)),
              onSelect: () =>
                update(() => ({ trigger: String(P.getShapeId(x)) }), {
                  label: "Trigger set",
                }),
            }))
          : [{ label: "No other objects on this slide", disabled: true }],
      },
      {
        label: "As Part of the Click Sequence",
        checked: !triggerOf,
        disabled: !triggerOf,
        onSelect: () =>
          update(
            (e) => {
              const { trigger, ...rest } = e;
              return { ...rest, trigger: undefined };
            },
            { label: "Trigger removed" },
          ),
      },
    ];
  }

  // ---- Custom motion paths ----
  function startCustomPath({ add = false } = {}) {
    const shapes = ctx.selectedShapes();
    if (shapes.length !== 1) {
      toast("Select one object to draw its path.");
      return;
    }
    const canvas = ctx.canvas();
    if (!canvas) return;
    stopDrawing();
    const layer = el("div", {
      class: "anim-path-draw",
      tabindex: 0,
      role: "application",
      "aria-label":
        "Draw a motion path: click to add points, drag to draw freely, double-click or press Enter to finish, Escape to cancel.",
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    svg.append(line);
    layer.append(svg);
    canvas.append(layer);
    layer.focus();
    const points = [];
    let dragging = false;
    const at = (e) => {
      const r = layer.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      ];
    };
    const draw = (extra = null) =>
      line.setAttribute(
        "points",
        [...points, ...(extra ? [extra] : [])]
          .map(([x, y]) => `${x * 1000},${y * 1000}`)
          .join(" "),
      );
    const finish = () => {
      const shape = shapes[0];
      stopDrawing();
      // A double-click to finish lands its clicks on the last point.
      for (let i = points.length - 1; i > 0; i--)
        if (
          Math.hypot(
            points[i][0] - points[i - 1][0],
            points[i][1] - points[i - 1][1],
          ) < 0.003
        )
          points.splice(i, 1);
      if (points.length < 2) return;
      const [x0, y0] = points[0];
      const d =
        `M 0 0 ` +
        points
          .slice(1)
          .map(([x, y]) => `L ${+(x - x0).toFixed(5)} ${+(y - y0).toFixed(5)}`)
          .join(" ") +
        " E";
      const entry = EFFECTS.find((e) => e.cls === "path" && e.custom);
      const effect = newEffect(entry, String(P.getShapeId(shape)), { path: d });
      const list = effects();
      const targets = add ? [] : current();
      let next, pick;
      if (targets.length) {
        next = list.map((e, i) =>
          targets.some((t) => t.index === i)
            ? { ...effect, start: e.start, delayMs: e.delayMs }
            : e,
        );
        pick = targets.map((t) => t.index);
      } else {
        next = [...list, effect];
        pick = [next.length - 1];
      }
      write(next, { pick, label: "Custom path drawn" }).then(
        (done) => done && autoPreview && playPreview({ only: pick }),
      );
    };
    layer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      layer.setPointerCapture(e.pointerId);
      points.push(at(e));
      dragging = true;
      draw();
    });
    layer.addEventListener("pointermove", (e) => {
      if (!points.length) return;
      const p = at(e);
      if (dragging && e.buttons & 1) {
        const last = points[points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.008) points.push(p);
        draw();
      } else draw(p);
    });
    layer.addEventListener("pointerup", () => (dragging = false));
    layer.addEventListener("dblclick", (e) => {
      e.preventDefault();
      finish();
    });
    layer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopDrawing();
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    });
    drawing = { layer };
    toast("Draw the path on the slide. Double-click or press Enter to finish.");
  }
  function stopDrawing() {
    drawing?.layer.remove();
    drawing = null;
  }

  // ---- Canvas: badges and motion paths ----
  function attach() {
    const canvas = ctx.canvas();
    if (!canvas) return;
    canvas.querySelector(".anim-badges")?.remove();
    // A preview whose slide was redrawn under it has ended.
    if (preview && !preview.overlay.isConnected) stopPreview();
    if (!canvas.dataset.animTools) {
      canvas.dataset.animTools = "1";
      canvas.addEventListener(
        "pointerdown",
        (e) => {
          if (!painter || e.button !== 0) return;
          const hit = e.target.closest?.(".object-hit");
          if (!hit) return;
          e.preventDefault();
          e.stopPropagation();
          paintOnto(hit.dataset.shapeId);
        },
        { capture: true },
      );
    }
    canvas.classList.toggle("anim-painting", !!painter);
    // A double-click on the Animation Painter keeps it for several objects.
    const painterButton = document.querySelector(
      '.ribbon [data-command="animation-painter"]',
    );
    if (painterButton && !painterButton.dataset.sticky) {
      painterButton.dataset.sticky = "1";
      painterButton.addEventListener("dblclick", () => {
        painter = null;
        startPainter(true);
      });
    }
    if (!(tabActive || pane.open)) return;
    const s = slide();
    if (!s) return;
    const { effects: list, groups } = slideTimeline(s, effects());
    if (!list.length) return;
    const size = ctx.slideSize();
    const steps = new Map(); // shape id → labels
    const auto = groups[0]?.auto ? 1 : 0;
    groups.forEach((g, gi) => {
      const label = String(gi + 1 - auto);
      for (const item of g.items) {
        const labels = steps.get(item.shapeId) ?? [];
        if (!labels.includes(label)) labels.push(label);
        steps.set(item.shapeId, labels);
      }
    });
    for (const e of list)
      if (e.trigger) {
        const labels = steps.get(e.shapeId) ?? [];
        if (!labels.includes("⚡")) labels.push("⚡");
        steps.set(e.shapeId, labels);
      }
    const layer = el("div", { class: "anim-badges", "aria-hidden": "false" });
    const chosenIds = new Set(current().map((t) => t.effect.shapeId));
    for (const [shapeId, labels] of steps) {
      const shape = P.findShapeById(s, Number(shapeId));
      const b = shape && ctx.bounds(shape);
      if (!b) continue;
      const indexes = list
        .map((e, i) => (e.shapeId === shapeId ? i : -1))
        .filter((i) => i >= 0);
      const badge = el(
        "button",
        {
          type: "button",
          class: `anim-badge ${chosenIds.has(shapeId) ? "chosen" : ""}`,
          style: `left:${(b.x / size.cx) * 100}%;top:${(b.y / size.cy) * 100}%`,
          "aria-label": `Animations of ${ctx.shapeLabel(shape)}: ${labels.join(", ")}`,
          title: `${ctx.shapeLabel(shape)}: ${indexes.map((i) => effectName(list[i])).join(", ")}`,
          onpointerdown: (e) => e.stopPropagation(),
          onclick: (e) => {
            e.stopPropagation();
            choose(indexes);
          },
        },
        ...labels.map((l) => el("span", {}, l)),
      );
      layer.append(badge);
    }
    // Motion paths of the chosen effects, drawn from their objects.
    const paths = current().filter((t) => t.effect.presetClass === "path");
    if (paths.length) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "anim-paths");
      svg.setAttribute("viewBox", "0 0 1000 1000");
      svg.setAttribute("preserveAspectRatio", "none");
      for (const { effect } of paths) {
        const shape = P.findShapeById(s, Number(effect.shapeId));
        const b = shape && ctx.bounds(shape);
        if (!b) continue;
        const cx = ((b.x + b.w / 2) / size.cx) * 1000;
        const cy = ((b.y + b.h / 2) / size.cy) * 1000;
        const d = (
          effect.path || P.motionPathFor(effect.presetId, effect.presetSubtype)
        )
          .replace(/E\s*$/i, "")
          .replace(
            /(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)/gi,
            (_, x, y) =>
              `${(cx + Number(x) * 1000).toFixed(2)} ${(cy + Number(y) * 1000).toFixed(2)}`,
          );
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", d);
        path.setAttribute("vector-effect", "non-scaling-stroke");
        svg.append(path);
        // Where the object starts and ends; the end can be dragged.
        const source =
          effect.path || P.motionPathFor(effect.presetId, effect.presetSubtype);
        const [ex, ey] = pathEnd(source);
        const at = (x, y) =>
          `left:${cx / 10 + x * 100}%;top:${cy / 10 + y * 100}%`;
        layer.append(
          el("span", { class: "anim-path-start", style: at(0, 0) }),
          endHandle(effect, source, at(ex, ey), ctx.shapeLabel(shape)),
        );
      }
      layer.append(svg);
    }
    canvas.append(layer);
  }

  // Dragging a path's end moves its last point (and the control point that
  // leads into it); arrow keys nudge it.
  function endHandle(effect, source, style, name) {
    const index = effects().findIndex((e) => sameEffect(e, effect));
    const moveEnd = (dx, dy) =>
      write(
        effects().map((e, i) =>
          i === index ? { ...e, path: movePathEnd(source, dx, dy) } : e,
        ),
        { pick: [index], label: "Path changed" },
      );
    const handle = el("button", {
      type: "button",
      class: "anim-path-end",
      style,
      "aria-label": `End of the motion path of ${name}. Drag or use the arrow keys to move it.`,
      title: "Drag to move the end of the path",
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const canvas = ctx.canvas();
        const r = canvas.getBoundingClientRect();
        const x0 = e.clientX,
          y0 = e.clientY;
        const left = parseFloat(handle.style.left),
          top = parseFloat(handle.style.top);
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          handle.style.left = `${left + ((ev.clientX - x0) / r.width) * 100}%`;
          handle.style.top = `${top + ((ev.clientY - y0) / r.height) * 100}%`;
        };
        const up = (ev) => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          const dx = (ev.clientX - x0) / r.width,
            dy = (ev.clientY - y0) / r.height;
          if (Math.abs(dx) + Math.abs(dy) > 0.002) moveEnd(dx, dy);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      },
      onkeydown: (e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        const d = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        moveEnd(...d);
      },
    });
    return handle;
  }
  const sameEffect = (a, b) =>
    a.source && b.source
      ? a.source === b.source
      : JSON.stringify(a) === JSON.stringify(b);

  // ---- The tab ----
  const one = () => current().length > 0;
  const startOf = () => {
    const c = current();
    if (!c.length) return "";
    const s = c[0].effect.start;
    return c.every((t) => t.effect.start === s) ? START_LABELS[s] : "";
  };
  const galleryChoices = () => [
    {
      id: "none",
      label: "None",
      render: () => noneIcon(32),
      category: "none",
    },
    ...EFFECTS.filter((e) => e.gallery).map((entry) => ({
      id: effectKey(entry),
      label: entry.name,
      entry,
      category: entry.cls,
      description: `${categoryOf(entry.cls).label} effect`,
      disabled:
        entry.text &&
        !ctx.selectedShapes().some((s) => hasText(P.getShapeId(s))),
      render: () => effectIcon(entry, 32),
    })),
  ];
  function selectedChoice() {
    const c = current();
    if (!ctx.selectedShapes().length) return null;
    if (!c.length) return "none";
    const entry = entryFor(c[0].effect);
    return entry && c.length === 1 ? effectKey(entry) : null;
  }
  const moreFooter = () => [
    ...CATEGORIES.map((cat) => ({
      label: `More ${cat.id === "path" ? "Motion Paths" : `${cat.label} Effects`}…`,
      onSelect: () => openMore(cat.id),
    })),
  ];
  function openMore(cls, { add = false } = {}) {
    const c = current();
    moreEffectsDialog({
      cls,
      current: !add && c.length === 1 ? entryFor(c[0].effect) : null,
      hasText: ctx.selectedShapes().some((s) => hasText(P.getShapeId(s))),
      preview: (entry) => {
        if (!autoPreview) return;
      },
    }).then((entry) => entry && applyEntry(entry, { add }));
  }
  function addAnimationMenu(anchor) {
    const items = [];
    for (const cat of CATEGORIES) {
      items.push({ header: cat.label });
      const grid = el("div", {
        class: "anim-add-grid",
        role: "group",
        "aria-label": cat.label,
      });
      for (const entry of EFFECTS.filter((e) => e.cls === cat.id && e.gallery))
        grid.append(
          el(
            "button",
            {
              type: "button",
              class: "anim-add-item",
              role: "menuitem",
              tabindex: -1,
              disabled:
                (entry.text &&
                  !ctx
                    .selectedShapes()
                    .some((s) => hasText(P.getShapeId(s)))) ||
                null,
              onclick: () => {
                closeMenus();
                applyEntry(entry, { add: true });
              },
            },
            effectIcon(entry, 28),
            el("span", {}, entry.name),
          ),
        );
      items.push({ custom: grid });
    }
    items.push({ separator: true });
    for (const cat of CATEGORIES)
      items.push({
        label: `More ${cat.id === "path" ? "Motion Paths" : `${cat.label} Effects`}…`,
        onSelect: () => openMore(cat.id, { add: true }),
      });
    return items;
  }
  const closeMenus = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  function tab() {
    return {
      id: "animations",
      label: "Animations",
      after: "transitions",
      groups: [
        {
          id: "anim-preview",
          label: "Preview",
          icon: "previewAnimation",
          items: [
            {
              type: "large",
              id: "preview-animations",
              label: "Preview",
              icon: "previewAnimation",
              title: "Preview Animations",
              description: "Play the animations of this slide on the canvas.",
              split: true,
              enabled: () => effects().length > 0,
              run: () => (preview ? stopPreview() : playPreview()),
              menu: () => [
                {
                  label: "Preview",
                  disabled: !effects().length,
                  onSelect: () => playPreview(),
                },
                {
                  label: "AutoPreview",
                  checked: autoPreview,
                  onSelect: () => {
                    autoPreview = !autoPreview;
                  },
                },
              ],
              menuLabel: "Preview options",
            },
          ],
        },
        {
          id: "anim-gallery",
          label: "Animation",
          icon: "entrance",
          collapsible: false,
          items: [
            {
              type: "gallery",
              id: "animation-gallery",
              label: "Animations",
              columns: 8,
              panelColumns: 8,
              itemClass: "anim-choice",
              enabled: () => ctx.selectedShapes().length > 0,
              items: galleryChoices,
              sections: (choices) => [
                {
                  label: null,
                  items: choices.filter((c) => c.category === "none"),
                },
                ...CATEGORIES.map((cat) => ({
                  label: cat.label,
                  items: choices.filter((c) => c.category === cat.id),
                })),
              ],
              selected: selectedChoice,
              choose: (choice) => applyEntry(choice.entry || null),
              footer: moreFooter,
            },
            {
              type: "large",
              id: "animation-effect-options",
              label: "Effect\nOptions",
              icon: "effectOptions",
              title: "Effect Options",
              description:
                "Change the direction, shape, amount or sequence of the effect.",
              enabled: () => optionsFor().length > 0,
              menu: () => effectOptionsMenu(),
            },
          ],
        },
        {
          id: "anim-advanced",
          label: "Advanced Animation",
          icon: "addAnimation",
          items: [
            {
              type: "large",
              id: "add-animation",
              label: "Add\nAnimation",
              icon: "addAnimation",
              title: "Add Animation",
              description:
                "Add another effect to the selected objects, after the ones they have.",
              enabled: () => ctx.selectedShapes().length > 0,
              menu: (anchor) => addAnimationMenu(anchor),
            },
            {
              type: "stack",
              items: [
                {
                  type: "toggle",
                  id: "animation-pane",
                  label: "Animation Pane",
                  icon: "animationPane",
                  title: "Animation Pane",
                  description:
                    "Show the list of this slide's effects with their timing.",
                  pressed: () => pane.open,
                  run: () => togglePane(),
                },
                {
                  type: "small",
                  id: "animation-trigger",
                  label: "Trigger",
                  icon: "trigger",
                  title: "Trigger",
                  description:
                    "Play the effect when another object is clicked during the show.",
                  enabled: one,
                  menu: () => triggerMenu(),
                },
                {
                  type: "toggle",
                  id: "animation-painter",
                  label: "Animation Painter",
                  icon: "animationPainter",
                  title: `Animation Painter (${ctx.modKey}+Alt+Shift+C)`,
                  description:
                    "Copy the selected object's animation to the next object you click. Double-click to copy it to several.",
                  enabled: () => one() || !!painter,
                  pressed: () => !!painter,
                  run: () => startPainter(false),
                },
              ],
            },
          ],
        },
        {
          id: "anim-timing",
          label: "Timing",
          icon: "duration",
          items: [
            {
              type: "stack",
              items: [
                {
                  type: "row",
                  items: [
                    { type: "label", label: "Start" },
                    {
                      type: "combo",
                      id: "animation-start",
                      label: "Start",
                      width: 118,
                      enabled: one,
                      value: startOf,
                      options: () => Object.values(START_LABELS),
                      commit: (value) => {
                        const start = Object.keys(START_LABELS).find(
                          (k) =>
                            START_LABELS[k].toLowerCase() ===
                            value.toLowerCase(),
                        );
                        if (start) return update(() => ({ start }));
                      },
                    },
                  ],
                },
                {
                  type: "spin",
                  id: "animation-duration",
                  label: "Duration",
                  icon: "duration",
                  width: 66,
                  min: 0,
                  max: 59,
                  step: 0.25,
                  enabled: one,
                  format: (n) => n.toFixed(2),
                  value: () => {
                    const c = current();
                    return c.length ? seconds(c[0].effect.durationMs) : null;
                  },
                  commit: (n) =>
                    update(() => ({ durationMs: Math.round(n * 1000) }), {
                      coalesce: "animation-duration",
                    }),
                },
                {
                  type: "spin",
                  id: "animation-delay",
                  label: "Delay",
                  icon: "delay",
                  width: 66,
                  min: 0,
                  max: 59,
                  step: 0.25,
                  enabled: one,
                  format: (n) => n.toFixed(2),
                  value: () => {
                    const c = current();
                    return c.length ? seconds(c[0].effect.delayMs) : null;
                  },
                  commit: (n) =>
                    update(() => ({ delayMs: Math.round(n * 1000) }), {
                      coalesce: "animation-delay",
                    }),
                },
              ],
            },
            {
              type: "stack",
              items: [
                { type: "label", label: "Reorder Animation" },
                {
                  type: "small",
                  id: "animation-earlier",
                  label: "Move Earlier",
                  icon: "moveEarlier",
                  title: "Move Earlier",
                  enabled: () => current().some((t) => t.index > 0),
                  run: () => move(-1),
                },
                {
                  type: "small",
                  id: "animation-later",
                  label: "Move Later",
                  icon: "moveLater",
                  title: "Move Later",
                  enabled: () => {
                    const n = effects().length;
                    return current().some((t) => t.index < n - 1);
                  },
                  run: () => move(1),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  function togglePane(force) {
    pane.toggle(force);
    attach();
    ctx.refresh();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      if (drawing) {
        stopDrawing();
        return true;
      }
      if (preview) {
        stopPreview();
        return true;
      }
      if (painter) {
        painter = null;
        ctx.canvas()?.classList.remove("anim-painting");
        ctx.refresh();
        return true;
      }
    }
    if (
      e.key.toLowerCase() === "c" &&
      e.altKey &&
      e.shiftKey &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      startPainter(false);
      return true;
    }
    return false;
  }

  const api = {
    tab,
    attach,
    effects,
    current,
    choose,
    write,
    update,
    remove,
    reorder,
    move,
    applyEntry,
    playPreview,
    stopPreview,
    get previewing() {
      return !!preview;
    },
    togglePane,
    pane,
    hasText,
    shapeParagraphCount,
    optionsFor,
    openEffectDialog: (tabName = "effect") => {
      const c = current();
      if (!c.length) return;
      effectOptionsDialog({
        effect: c[0].effect,
        tab: tabName,
        tools: api,
        ctx,
      }).then((change) => {
        if (!change) return;
        const added = change.sound?.bytes ? change.sound : null;
        if (!added) return update(() => change);
        // A new sound: embed its audio and point the effects at it, as one
        // undoable step.
        const list = effects();
        const targets = current();
        const target = slide();
        if (!target || !targets.length) return;
        return ctx
          .mutateSlide(target, (s) => {
            const relId = P.addSlideAnimationSound(s, added.bytes, added.name);
            P.setSlideAnimations(
              s,
              list.map((e, i) =>
                targets.some((t) => t.index === i)
                  ? { ...e, ...change, sound: { relId, name: added.name } }
                  : e,
              ),
            );
          })
          .then((done) => {
            if (done) {
              chosen = targets.map((t) => t.index);
              chosenFor = [...selectedIds()].sort().join(",");
            }
            ctx.refresh();
          });
      });
    },
    startPainter,
    get painting() {
      return !!painter;
    },
    setTabActive(on) {
      tabActive = on;
      attach();
    },
    sync() {
      pane.render();
      attach();
    },
    onKey,
    stop() {
      stopPreview();
      stopDrawing();
      painter = null;
    },
  };
  return api;
}
