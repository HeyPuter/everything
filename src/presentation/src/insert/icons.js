// Insert Icons: a searchable, categorised gallery of line icons inserted as
// SVG pictures (with a PNG for readers without SVG), and the Graphics Format
// tab that recolours, re-weights and converts them.
import { el, dialog, toast, icon as uiIcon } from "../ui.js";
import { colorMenuItems } from "../color-palette.js";
import { ICON_CATEGORIES, iconWords } from "./icon-catalog.js";
import {
  iconSvg,
  recolorSvg,
  svgFreeformPaths,
  svgStyle,
} from "./svg-tools.js";
import { svgToPng } from "./util.js";

let lucide = null;
// The whole set comes from its own module: importing "lucide" here as well
// as for the interface's icons put all of them in the startup bundle.
const loadIcons = async () =>
  (lucide ??= import("lucide/dist/esm/iconsAndAliases.mjs").then((m) => {
    const out = {};
    for (const [name, value] of Object.entries(m))
      if (Array.isArray(value) && /^[A-Z]/.test(name)) out[name] = value;
    return out;
  }));

const RASTER = 256;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createIconFeatures(ctx) {
  const { P } = ctx;

  const isIcon = (obj) =>
    !!obj &&
    P.getShapeKind(obj) === "picture" &&
    P.getShapeObjectData(obj)?.type === "icon" &&
    !!P.getShapeSvgSource(obj);
  // Icons and SVG pictures of no other kind (equations and zooms have tabs
  // of their own).
  const isSvgPicture = (obj) =>
    !!obj &&
    !["equation", "zoom", "media"].includes(P.getShapeObjectData(obj)?.type) &&
    isAnySvgPicture(obj);
  const isAnySvgPicture = (obj) =>
    !!obj &&
    P.getShapeKind(obj) === "picture" &&
    !!P.getShapeSvgSource(obj) &&
    !P.getShapeMediaKind(obj);
  const selectedIcons = () => ctx.selectedShapes().filter(isSvgPicture);

  async function sources(svg) {
    return {
      svg: encoder.encode(svg),
      png: await svgToPng(svg, RASTER, RASTER),
    };
  }

  function iconCell(name, node, chosen, toggle) {
    const preview = el("span", {
      class: "icon-cell-art",
      "aria-hidden": "true",
    });
    preview.innerHTML = iconSvg(name, node, {
      stroke: "currentColor",
      size: 36,
    });
    return el(
      "button",
      {
        type: "button",
        class: "icon-cell",
        role: "option",
        "aria-selected": chosen ? "true" : "false",
        "aria-label": iconWords(name),
        title: iconWords(name),
        "data-icon": name,
        tabindex: -1,
        onclick: (e) => toggle(name, e.currentTarget),
      },
      preview,
      el(
        "span",
        { class: "icon-cell-check", "aria-hidden": "true" },
        uiIcon("Check", 12),
      ),
    );
  }

  /** The Icons dialog. `single` picks one icon (Change Graphic). */
  async function chooseIcons({ single = false } = {}) {
    const icons = await loadIcons();
    const chosen = new Set();
    let category = "All";
    const search = el("input", {
      class: "input icon-search",
      type: "search",
      placeholder: "Search icons",
      "aria-label": "Search icons",
      autocomplete: "off",
    });
    const grid = el("div", {
      class: "icon-grid",
      role: "listbox",
      "aria-multiselectable": single ? "false" : "true",
      "aria-label": "Icons",
    });
    const count = el("span", { class: "icon-count", role: "status" });
    const chips = el("div", {
      class: "icon-categories",
      role: "tablist",
      "aria-label": "Icon categories",
    });
    const names = Object.keys(icons);
    const categories = [
      ["All", names],
      ...ICON_CATEGORIES.map(([label, list]) => [
        label,
        list.split(/\s+/).filter((n) => n in icons),
      ]),
    ];
    const toggle = (name, node) => {
      if (single) {
        chosen.clear();
        grid
          .querySelectorAll('[aria-selected="true"]')
          .forEach((n) => n.setAttribute("aria-selected", "false"));
      }
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      node.setAttribute("aria-selected", String(chosen.has(name)));
      sync();
    };
    let shown = [];
    const LIMIT = 240;
    function fill() {
      const q = search.value.trim().toLowerCase();
      const pool = categories.find(([label]) => label === category)[1];
      const terms = q.split(/\s+/).filter(Boolean);
      shown = pool.filter((n) => {
        const words = iconWords(n);
        return terms.every((t) => words.includes(t));
      });
      grid.replaceChildren(
        ...shown
          .slice(0, LIMIT)
          .map((n) => iconCell(n, icons[n], chosen.has(n), toggle)),
      );
      if (!shown.length)
        grid.append(
          el("p", { class: "icon-empty" }, "No icons match your search."),
        );
      // Tab reaches the icons once, at the first; the arrow keys move on.
      const first = grid.querySelector(".icon-cell");
      if (first) first.tabIndex = 0;
      sync();
    }
    function sync() {
      const more =
        shown.length > LIMIT
          ? ` Showing ${LIMIT} of ${shown.length}; search to narrow.`
          : "";
      count.textContent = `${chosen.size} selected.${more}`;
      insertButton.disabled = !chosen.size;
      insertButton.textContent = single
        ? "Insert"
        : chosen.size > 1
          ? `Insert (${chosen.size})`
          : "Insert";
    }
    for (const [label] of categories)
      chips.append(
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: "icon-category",
            "aria-selected": label === category ? "true" : "false",
            tabindex: label === category ? 0 : -1,
            onclick: (e) => {
              category = label;
              chips.querySelectorAll(".icon-category").forEach((c) => {
                c.setAttribute("aria-selected", String(c === e.currentTarget));
                c.tabIndex = c === e.currentTarget ? 0 : -1;
              });
              fill();
            },
          },
          label,
        ),
      );
    search.addEventListener("input", fill);
    // The categories are one stop for Tab; Left and Right choose among them.
    chips.addEventListener("keydown", (e) => {
      const tabs = [...chips.children];
      const at = tabs.indexOf(document.activeElement);
      const next = {
        ArrowRight: at + 1,
        ArrowLeft: at - 1,
        Home: 0,
        End: tabs.length - 1,
      }[e.key];
      if (at < 0 || next === undefined) return;
      e.preventDefault();
      const tab = tabs[(next + tabs.length) % tabs.length];
      tab.click();
      tab.focus();
    });
    // The icon last reached is where Tab comes back to.
    grid.addEventListener("focusin", (e) => {
      if (!e.target.classList?.contains("icon-cell")) return;
      for (const cell of grid.querySelectorAll('.icon-cell[tabindex="0"]'))
        if (cell !== e.target) cell.tabIndex = -1;
      e.target.tabIndex = 0;
    });
    // Arrow keys move through the grid.
    grid.addEventListener("keydown", (e) => {
      const cells = [...grid.querySelectorAll(".icon-cell")];
      const at = cells.indexOf(document.activeElement);
      if (at < 0) return;
      const columns = Math.max(
        1,
        Math.round(grid.clientWidth / (cells[0].offsetWidth || 56)),
      );
      const step = {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: columns,
        ArrowUp: -columns,
      }[e.key];
      if (!step) return;
      e.preventDefault();
      cells[Math.max(0, Math.min(cells.length - 1, at + step))]?.focus();
    });
    let resolved = false;
    const insertButton = el(
      "button",
      { type: "button", class: "btn primary", disabled: true },
      "Insert",
    );
    const body = el(
      "div",
      { class: "dialog-body icons-dialog" },
      search,
      chips,
      grid,
      el(
        "div",
        { class: "icon-footer" },
        count,
        el(
          "span",
          { class: "icon-footer-actions" },
          el(
            "button",
            {
              type: "button",
              class: "btn secondary",
              onclick: () =>
                body.closest("dialog")?.dispatchEvent(new Event("cancel")),
            },
            "Cancel",
          ),
          insertButton,
        ),
      ),
    );
    const result = dialog({
      title: single ? "Change Graphic" : "Insert Icons",
      body,
      confirm: null,
      cancel: null,
    });
    insertButton.addEventListener("click", () => {
      resolved = true;
      body.closest("dialog")?.dispatchEvent(new Event("cancel"));
    });
    fill();
    search.focus();
    await result;
    return resolved
      ? [...chosen].map((name) => ({ name, node: icons[name] }))
      : [];
  }

  async function insertIcons() {
    ctx.commitText();
    const picked = await chooseIcons();
    if (!picked.length) return;
    const color = ctx.inkColor();
    const made = await Promise.all(
      picked.map(async ({ name, node }) => ({
        name,
        ...(await sources(iconSvg(name, node, { stroke: color }))),
      })),
    );
    const size = ctx.currentSize();
    const edge = P.inches(1);
    const ids = [];
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      made.forEach((m, i) => {
        const columns = Math.min(made.length, 6);
        const x = Math.round(
          (size.cx - columns * edge * 1.3) / 2 + (i % columns) * edge * 1.3,
        );
        const y = Math.round(
          size.cy / 2 - edge / 2 + Math.floor(i / columns) * edge * 1.3,
        );
        const shape = P.addSlideVectorPicture(
          slide,
          { png: m.png, svg: m.svg },
          {
            x,
            y,
            w: edge,
            h: edge,
            name: `Graphic ${P.getSlideShapes(slide).length + 1}`,
          },
        );
        P.setShapeObjectData(shape, { type: "icon", name: m.name });
        P.setShapeDescription(shape, iconWords(m.name));
        ids.push(P.getShapeId(shape));
      });
      ctx.selectIds(ids);
    });
    ctx.ribbonSelect("graphics-format");
  }

  async function restyle(change) {
    const targets = selectedIcons();
    if (!targets.length) return;
    const updates = await Promise.all(
      targets.map(async (obj) => {
        const svg = recolorSvg(
          decoder.decode(P.getShapeSvgSource(obj)),
          change,
        );
        return [P.getShapeId(obj), await sources(svg)];
      }),
    );
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      for (const [id, src] of updates) {
        const obj = P.findShapeById(slide, id);
        if (obj) P.setShapeVectorPicture(obj, src);
      }
      ctx.pruneMedia(slide);
    });
  }

  async function changeGraphic() {
    const obj = ctx.currentShape();
    if (!isSvgPicture(obj)) return;
    const [picked] = await chooseIcons({ single: true });
    if (!picked) return;
    const style = svgStyle(decoder.decode(P.getShapeSvgSource(obj)));
    const src = await sources(iconSvg(picked.name, picked.node, style));
    await ctx.mutateShape(obj, (target, slide) => {
      P.setShapeVectorPicture(target, src);
      P.setShapeObjectData(target, { type: "icon", name: picked.name });
      P.setShapeDescription(target, iconWords(picked.name));
      ctx.pruneMedia(slide);
    });
  }

  // Freeform shapes drawn from the icon's outlines, in its colours, so its
  // points can be edited and it takes shape fills and outlines.
  async function convertToShape() {
    const targets = selectedIcons();
    if (!targets.length) return;
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      const ids = [];
      for (const original of targets) {
        const obj = P.findShapeById(slide, P.getShapeId(original));
        if (!obj) continue;
        const svg = decoder.decode(P.getShapeSvgSource(obj));
        const style = svgStyle(svg);
        const b = P.getShapeBounds(obj);
        const paths = svgFreeformPaths(svg);
        if (!paths.length) continue;
        const shape = P.addSlideShape(slide, {
          preset: "rect",
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          name: `Freeform ${P.getSlideShapes(slide).length + 1}`,
        });
        P.setShapeFreeformPaths(shape, paths);
        if (style.fill && style.fill !== "none")
          P.setShapeFill(shape, style.fill);
        else P.setShapeNoFill(shape);
        P.setShapeStroke(shape, {
          color: style.stroke === "currentColor" ? "#000000" : style.stroke,
          widthEmu: Math.max(3175, Math.round((style.strokeWidth / 24) * b.w)),
        });
        P.setShapeStrokeCap?.(shape, "rnd");
        P.setShapeStrokeJoin?.(shape, "round");
        const description = P.getShapeDescription?.(obj);
        if (description) P.setShapeDescription(shape, description);
        P.removeShape(obj);
        ids.push(P.getShapeId(shape));
      }
      ctx.pruneMedia(slide);
      ctx.selectIds(ids);
    });
    toast("Converted to an editable shape.");
  }

  const STYLES = [
    ["Dark line", { stroke: "#1F2937", fill: "none", strokeWidth: 2 }],
    ["Accent line", { stroke: "accent", fill: "none", strokeWidth: 2 }],
    ["Bold line", { stroke: "#111827", fill: "none", strokeWidth: 3 }],
    ["Light line", { stroke: "#6B7280", fill: "none", strokeWidth: 1.25 }],
    ["Accent fill", { stroke: "#FFFFFF", fill: "accent", strokeWidth: 1.5 }],
    ["Tinted", { stroke: "accent", fill: "tint", strokeWidth: 2 }],
  ];
  const resolveStyle = (style) => {
    const accent = ctx.accentColor();
    const pick = (v) =>
      v === "accent" ? accent : v === "tint" ? `${accent}33` : v;
    return {
      stroke: pick(style.stroke),
      fill: pick(style.fill),
      strokeWidth: style.strokeWidth,
    };
  };

  const theme = () => ctx.themeColors();
  const tab = () => ({
    id: "graphics-format",
    label: "Graphics Format",
    contextual: true,
    visible: () =>
      ctx.selectedShapes().length > 0 &&
      ctx.selectedShapes().every(isSvgPicture),
    groups: [
      {
        id: "graphics-change",
        label: "Change",
        icon: "icons",
        items: [
          {
            type: "large",
            id: "graphics-change-graphic",
            label: "Change\nGraphic",
            icon: "icons",
            title: "Change Graphic",
            description:
              "Replace this icon with another, keeping its size and colours.",
            run: () => changeGraphic().catch(ctx.fail),
          },
          {
            type: "large",
            id: "graphics-convert",
            label: "Convert\nto Shape",
            icon: "editShape",
            title: "Convert to Shape",
            description:
              "Turn the icon into a shape whose points and colours can be edited.",
            run: () => convertToShape().catch(ctx.fail),
          },
        ],
      },
      {
        id: "graphics-styles",
        label: "Graphics Styles",
        icon: "quickStyles",
        items: [
          {
            type: "large",
            id: "graphics-style-menu",
            label: "Graphics\nStyles",
            icon: "quickStyles",
            title: "Graphics Styles",
            menu: () =>
              STYLES.map(([label, style]) => ({
                label,
                onSelect: () => restyle(resolveStyle(style)).catch(ctx.fail),
              })),
          },
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "graphics-fill",
                label: "Graphics Fill",
                icon: "shapeFill",
                title: "Graphics Fill",
                description: "Fill the icon's enclosed areas.",
                menu: () => [
                  ...colorMenuItems({
                    theme: theme(),
                    none: "No Fill",
                    onPick: (value, hex) =>
                      restyle({ fill: hex || value }).catch(ctx.fail),
                  }),
                  {
                    label: "No Fill",
                    onSelect: () => restyle({ fill: "none" }).catch(ctx.fail),
                  },
                ],
              },
              {
                type: "small",
                id: "graphics-outline",
                label: "Graphics Outline",
                icon: "shapeOutline",
                title: "Graphics Outline",
                description: "Colour and weight of the icon's lines.",
                menu: () => [
                  ...colorMenuItems({
                    theme: theme(),
                    onPick: (value, hex) =>
                      restyle({ stroke: hex || value }).catch(ctx.fail),
                  }),
                  { separator: true },
                  {
                    label: "Weight",
                    items: [1, 1.5, 2, 2.5, 3].map((w) => ({
                      label: `${w} (of 24)`,
                      onSelect: () =>
                        restyle({ strokeWidth: w }).catch(ctx.fail),
                    })),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "graphics-accessibility",
        label: "Accessibility",
        icon: "altText",
        items: [
          {
            type: "large",
            id: "graphics-alt-text",
            label: "Alt\nText",
            icon: "altText",
            title: "Alt Text",
            run: () => ctx.altText(),
          },
        ],
      },
    ],
  });

  return {
    insertIcons,
    chooseIcons,
    isIcon,
    isSvgPicture,
    tab,
    convertToShape,
    restyle,
  };
}
