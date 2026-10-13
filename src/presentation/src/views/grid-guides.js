// The grid and the drawing guides over the slide in Normal view.
//
// The grid's spacing and whether objects snap to it, and the guides placed
// on the slides, are saved in the file's view properties; whether the grid,
// the guides and the smart guides show is the person's preference on this
// device. Guides are dragged to move, dragged with Ctrl or Option held to
// copy, dragged off the slide to remove, and moved from the keyboard with
// the arrow keys.
import { el, openMenu, dialog, IS_MAC } from "../ui.js";

const EMU_PER_INCH = 914400;
export const DEFAULT_SPACING = EMU_PER_INCH / 12;
// Grid spacings offered in the dialog: inches, then centimetres.
export const SPACINGS = [
  [EMU_PER_INCH / 24, "1/24 in"],
  [EMU_PER_INCH / 16, "1/16 in"],
  [EMU_PER_INCH / 12, "1/12 in"],
  [EMU_PER_INCH / 10, "1/10 in"],
  [EMU_PER_INCH / 8, "1/8 in"],
  [EMU_PER_INCH / 6, "1/6 in"],
  [EMU_PER_INCH / 5, "1/5 in"],
  [EMU_PER_INCH / 4, "1/4 in"],
  [EMU_PER_INCH / 3, "1/3 in"],
  [EMU_PER_INCH / 2, "1/2 in"],
  [EMU_PER_INCH, "1 in"],
  [36000, "0.1 cm"],
  [72000, "0.2 cm"],
  [90000, "0.25 cm"],
  [180000, "0.5 cm"],
  [360000, "1 cm"],
  [720000, "2 cm"],
];
// Centimetres where the locale measures in them.
export const metric = () =>
  !/^en-(US|LR|MM)\b/.test(globalThis.navigator?.language || "en-US");
export function formatLength(emu, cm = metric()) {
  const value = cm ? emu / 360000 : emu / EMU_PER_INCH;
  return `${(Math.round(value * 100) / 100).toFixed(2)}${cm ? " cm" : "″"}`;
}
// Snaps one coordinate to the grid.
export const toGrid = (value, spacing) => Math.round(value / spacing) * spacing;
// The guides a slide shows by default: one through its center each way.
export const defaultGuides = (size) => [
  { orient: "horz", pos: Math.round(size.cy / 2) },
  { orient: "vert", pos: Math.round(size.cx / 2) },
];
// The grid lines drawn: the spacing, doubled until lines are at least this
// many screen pixels apart.
export function drawnSpacing(spacing, pxPerEmu, min = 8) {
  let step = spacing;
  while (step * pxPerEmu < min && step < EMU_PER_INCH * 100) step *= 2;
  return step;
}

export function createGridGuides(ctx) {
  const { P, chrome } = ctx;
  const props = () => {
    try {
      return P.getViewProperties(ctx.doc().pres);
    } catch {
      return { guides: [], gridSpacing: null, snapToGrid: null };
    }
  };
  const spacing = () => props().gridSpacing?.cx || DEFAULT_SPACING;
  const snapping = () => props().snapToGrid === true;
  const smartGuides = () => chrome.smartGuides !== false;
  // The deck's guides, or the two center ones until any are placed.
  const guides = () => {
    const list = props().guides;
    return list.length ? list : defaultGuides(ctx.currentSize());
  };
  const writeGuides = (list) =>
    ctx.mutate(() => P.setViewProperties(ctx.doc().pres, { guides: list }));

  // Draws the grid and the guides into the canvas's aids layer.
  function decorate(aids, canvas) {
    const size = ctx.currentSize();
    const width = canvas.getBoundingClientRect().width || 1;
    if (chrome.gridlines) {
      const step = drawnSpacing(spacing(), width / size.cx);
      aids.style.setProperty("--grid-x", `${(step / size.cx) * 100}%`);
      aids.style.setProperty("--grid-y", `${(step / size.cy) * 100}%`);
      aids.classList.add("grid");
    }
    if (chrome.guides)
      guides().forEach((guide, i) => aids.append(guideLine(guide, i, size)));
  }

  function describe(guide, size) {
    const horizontal = guide.orient === "horz";
    const center = horizontal ? size.cy / 2 : size.cx / 2;
    const offset = guide.pos - center;
    const side = horizontal
      ? offset < 0
        ? "above"
        : "below"
      : offset < 0
        ? "left of"
        : "right of";
    return Math.abs(offset) < 1
      ? `${horizontal ? "Horizontal" : "Vertical"} guide at the center`
      : `${horizontal ? "Horizontal" : "Vertical"} guide, ${formatLength(Math.abs(offset))} ${side} center`;
  }
  function guideLine(guide, i, size) {
    const horizontal = guide.orient === "horz";
    const node = el("div", {
      class: `guide-line ${horizontal ? "horizontal" : "vertical"}`,
      role: "separator",
      tabindex: 0,
      "aria-orientation": horizontal ? "horizontal" : "vertical",
      "aria-label": describe(guide, size),
      "data-guide": i,
    });
    if (horizontal) node.style.top = `${(guide.pos / size.cy) * 100}%`;
    else node.style.left = `${(guide.pos / size.cx) * 100}%`;
    node.addEventListener("pointerdown", (e) => drag(e, i));
    node.addEventListener("keydown", (e) => key(e, i));
    node.addEventListener("contextmenu", (e) => menu(e, i));
    return node;
  }

  function drag(e, i) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const node = e.currentTarget;
    const canvas = node.closest("#slide-canvas");
    const list = guides().map((g) => ({ ...g }));
    const guide = list[i];
    const horizontal = guide.orient === "horz";
    const size = ctx.currentSize();
    const copy = e.ctrlKey || e.altKey;
    let moving = node;
    if (copy) {
      moving = node.cloneNode();
      moving.classList.add("copying");
      node.after(moving);
    }
    moving.classList.add("dragging");
    const tip = el("div", { class: "guide-tip", role: "status" });
    canvas.append(tip);
    node.setPointerCapture(e.pointerId);
    let pos = guide.pos;
    let off = false;
    const place = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const fraction = horizontal
        ? (ev.clientY - rect.top) / rect.height
        : (ev.clientX - rect.left) / rect.width;
      const length = horizontal ? size.cy : size.cx;
      off = fraction < -0.02 || fraction > 1.02;
      pos = Math.round(fraction * length);
      if (snapping() && !ev.altKey) pos = toGrid(pos, spacing());
      pos = Math.max(0, Math.min(length, pos));
      if (horizontal) moving.style.top = `${(pos / length) * 100}%`;
      else moving.style.left = `${(pos / length) * 100}%`;
      moving.classList.toggle("removing", off);
      const center = length / 2;
      tip.textContent = off
        ? "Remove"
        : formatLength(Math.abs(pos - center)).replace(/^0\.00.*/, "0");
      tip.style.left = `${ev.clientX - rect.left + 12}px`;
      tip.style.top = `${ev.clientY - rect.top + 12}px`;
    };
    place(e);
    const up = (ev) => {
      node.removeEventListener("pointermove", place);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", cancel);
      tip.remove();
      if (ev.type === "pointercancel") {
        ctx.renderCanvasAids();
        return;
      }
      if (off) {
        if (!copy) list.splice(i, 1);
      } else if (copy) list.push({ orient: guide.orient, pos });
      else list[i] = { orient: guide.orient, pos };
      if (!copy && !off && pos === guide.pos) {
        ctx.renderCanvasAids();
        return;
      }
      writeGuides(list);
    };
    const cancel = (ev) => up(ev);
    node.addEventListener("pointermove", place);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
  }

  function key(e, i) {
    const list = guides().map((g) => ({ ...g }));
    const guide = list[i];
    const horizontal = guide.orient === "horz";
    const size = ctx.currentSize();
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      list.splice(i, 1);
      writeGuides(list).then(() => focusGuide(Math.max(0, i - 1)));
      return;
    }
    const step = (e.shiftKey ? 6 : 1) * spacing();
    const delta = {
      ArrowUp: horizontal ? -step : 0,
      ArrowDown: horizontal ? step : 0,
      ArrowLeft: horizontal ? 0 : -step,
      ArrowRight: horizontal ? 0 : step,
    }[e.key];
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    const length = horizontal ? size.cy : size.cx;
    list[i] = {
      orient: guide.orient,
      pos: Math.max(0, Math.min(length, guide.pos + delta)),
    };
    writeGuides(list).then(() => focusGuide(i));
  }
  function focusGuide(i) {
    document
      .querySelector(`#slide-canvas .guide-line[data-guide="${i}"]`)
      ?.focus();
  }

  function addGuide(orient) {
    const size = ctx.currentSize();
    const list = guides().map((g) => ({ ...g }));
    list.push({
      orient,
      pos: Math.round((orient === "horz" ? size.cy : size.cx) / 2),
    });
    if (!chrome.guides) ctx.show("guides", true);
    return writeGuides(list);
  }

  function menu(e, i) {
    e.preventDefault();
    e.stopPropagation();
    openMenu({
      x: e.clientX,
      y: e.clientY,
      contextual: true,
      label: "Guide",
      items: [
        {
          label: "Add Vertical Guide",
          icon: "o:gridlines",
          onSelect: () => addGuide("vert"),
        },
        {
          label: "Add Horizontal Guide",
          icon: "o:gridlines",
          onSelect: () => addGuide("horz"),
        },
        { separator: true },
        {
          label: "Delete Guide",
          icon: "Trash2",
          onSelect: () => {
            const list = guides().map((g) => ({ ...g }));
            list.splice(i, 1);
            writeGuides(list);
          },
        },
      ],
    });
  }

  // Snapping while an object moves: the guides offer targets like the
  // other objects' edges do, and an edge that meets none of them settles
  // on the grid.
  function snapTargets() {
    if (!chrome.guides) return { xs: [], ys: [] };
    const xs = [],
      ys = [];
    for (const g of guides()) (g.orient === "horz" ? ys : xs).push(g.pos);
    return { xs, ys };
  }
  // The distance that puts the first of these edges on the grid.
  function gridDelta(values) {
    if (!snapping() || !values.length) return null;
    const step = spacing();
    let best = null;
    for (const v of values) {
      const delta = toGrid(v, step) - v;
      if (best == null || Math.abs(delta) < Math.abs(best)) best = delta;
    }
    return best;
  }

  async function gridDialog() {
    const current = props();
    const spacingNow = current.gridSpacing?.cx || DEFAULT_SPACING;
    const cm = metric();
    const snap = el("input", {
      type: "checkbox",
      checked: current.snapToGrid === true,
    });
    const select = el(
      "select",
      { class: "input", "aria-label": "Spacing" },
      ...SPACINGS.filter(([, label]) => label.endsWith(cm ? "cm" : "in")).map(
        ([value, label]) =>
          el(
            "option",
            {
              value: String(value),
              selected: Math.abs(value - spacingNow) < 1 ? true : null,
            },
            label,
          ),
      ),
      el("option", { value: "custom" }, "Custom"),
    );
    const unit = cm ? 360000 : EMU_PER_INCH;
    const custom = el("input", {
      type: "number",
      class: "input",
      min: cm ? "0.01" : "0.01",
      max: cm ? "5.08" : "2",
      step: "0.01",
      value: String(Math.round((spacingNow / unit) * 1000) / 1000),
      "aria-label": `Custom spacing in ${cm ? "centimetres" : "inches"}`,
    });
    const known = SPACINGS.some(([v]) => Math.abs(v - spacingNow) < 1);
    if (!known) select.value = "custom";
    const syncCustom = () => {
      custom.disabled = select.value !== "custom";
      if (select.value !== "custom")
        custom.value = String(
          Math.round((Number(select.value) / unit) * 1000) / 1000,
        );
    };
    select.addEventListener("change", syncCustom);
    syncCustom();
    const showGrid = el("input", {
      type: "checkbox",
      checked: !!chrome.gridlines,
    });
    const showGuides = el("input", {
      type: "checkbox",
      checked: !!chrome.guides,
    });
    const smart = el("input", { type: "checkbox", checked: smartGuides() });
    const check = (input, label) =>
      el("label", { class: "check-field" }, input, el("span", {}, label));
    const body = el(
      "form",
      { class: "dialog-body grid-dialog" },
      el(
        "fieldset",
        {},
        el("legend", {}, "Snap"),
        check(snap, "Snap objects to the grid"),
      ),
      el(
        "fieldset",
        {},
        el("legend", {}, "Grid"),
        el(
          "div",
          { class: "grid-spacing" },
          el("label", {}, "Spacing", select),
          el("label", {}, cm ? "cm" : "inches", custom),
        ),
        check(showGrid, "Show the grid on the slide"),
      ),
      el(
        "fieldset",
        {},
        el("legend", {}, "Guides"),
        check(showGuides, "Show drawing guides"),
        check(smart, "Show smart guides while shapes line up"),
      ),
    );
    const ok = await dialog({ title: "Grid and Guides", body, confirm: "OK" });
    if (!ok) return false;
    const chosen =
      select.value === "custom"
        ? Math.round(Number(custom.value) * unit)
        : Number(select.value);
    const value = Number.isFinite(chosen) && chosen > 0 ? chosen : spacingNow;
    chrome.smartGuides = smart.checked;
    if (!!chrome.gridlines !== showGrid.checked)
      ctx.show("gridlines", showGrid.checked);
    if (!!chrome.guides !== showGuides.checked)
      ctx.show("guides", showGuides.checked);
    ctx.saveChrome();
    if (
      snap.checked !== (current.snapToGrid === true) ||
      Math.abs(value - spacingNow) >= 1
    )
      await ctx.mutate(() =>
        P.setViewProperties(ctx.doc().pres, {
          snapToGrid: snap.checked,
          gridSpacing: { cx: value, cy: value },
        }),
      );
    ctx.renderCanvasAids();
    return true;
  }

  function setSnapToGrid(on) {
    return ctx.mutate(() =>
      P.setViewProperties(ctx.doc().pres, { snapToGrid: on }),
    );
  }
  function setSmartGuides(on) {
    chrome.smartGuides = on;
    ctx.saveChrome();
    ctx.sync();
  }

  // The View menu's Grid and Guides submenu.
  function menuItems() {
    const mod = IS_MAC ? "⌘" : "Ctrl";
    return [
      {
        label: "Smart Guides",
        checked: smartGuides(),
        onSelect: () => setSmartGuides(!smartGuides()),
      },
      {
        label: "Guides",
        checked: !!chrome.guides,
        onSelect: () => ctx.show("guides", !chrome.guides),
      },
      {
        label: "Gridlines",
        checked: !!chrome.gridlines,
        shortcut: `${mod}+'`,
        onSelect: () => ctx.show("gridlines", !chrome.gridlines),
      },
      { separator: true },
      {
        label: "Snap to Grid",
        checked: snapping(),
        onSelect: () => setSnapToGrid(!snapping()),
      },
      { separator: true },
      {
        label: "Add Vertical Guide",
        onSelect: () => addGuide("vert"),
      },
      {
        label: "Add Horizontal Guide",
        onSelect: () => addGuide("horz"),
      },
      { separator: true },
      {
        label: "Grid Options…",
        icon: "o:gridlines",
        onSelect: () => gridDialog().catch(ctx.fail),
      },
    ];
  }

  return {
    decorate,
    snapTargets,
    gridDelta,
    smartGuides,
    snapping,
    spacing,
    guides,
    addGuide,
    gridDialog,
    setSnapToGrid,
    setSmartGuides,
    menuItems,
  };
}
