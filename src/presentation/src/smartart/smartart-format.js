// Single shapes of a SmartArt graphic: picking one on the canvas, pictures
// in picture layouts, and the SmartArt Format tab (Change Shape, Larger,
// Smaller, shape fill, outline and effects, and WordArt text styles). The
// formatting is part of the graphic's model (P.getShapeSmartArt), so it
// stays with its item through edits and re-layouts.
import { el, icon } from "../ui.js";
import { colorMenuItems } from "../color-palette.js";
import { COMMAND_ICONS } from "../chrome/icons.js";
import { changeShapeItems } from "../format/edit-shape.js";
import { effectsMenuItems } from "../format/effects.js";
import { wordArtCss, wordArtStyles } from "../format/styles.js";
import { cssColor, PT } from "../format/controls.js";

const p = (d, c = "o") => `<path class="${c}" d="${d}"/>`;
Object.assign(COMMAND_ICONS, {
  shapeLarger:
    `<rect class="bf" x="6" y="6" width="8" height="8" rx="1.4"/>` +
    p("M2.5 6.5v-4h4M17.5 6.5v-4h-4M2.5 13.5v4h4M17.5 13.5v4h-4", "o thick"),
  shapeSmaller:
    `<rect class="bf" x="7" y="7" width="6" height="6" rx="1.2"/>` +
    p("M2.5 2.5l3 3M5.5 2.8v2.7H2.8M17.5 2.5l-3 3M14.5 2.8v2.7h2.7", "o") +
    p("M2.5 17.5l3-3M5.5 17.2v-2.7H2.8M17.5 17.5l-3-3M14.5 17.2v-2.7h2.7", "o"),
});

const ROLE_NAMES = {
  node: "Shape",
  hub: "Shape",
  child: "Text shape",
  text: "Text",
  trans: "Connector",
  bg: "Background",
  line: "Line",
  pic: "Picture",
  venn: "Shape",
};
const SCALE_STEP = 1.1;

// Leaves out fields set to undefined, and returns undefined for nothing.
const clean = (o) => {
  if (!o) return undefined;
  const out = Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) =>
        v !== undefined &&
        !(v && typeof v === "object" && !Object.keys(v).length),
    ),
  );
  return Object.keys(out).length ? out : undefined;
};
const without = (record, name) => {
  if (!record) return undefined;
  const { [name]: _gone, ...rest } = record;
  return clean(rest);
};

/** The model with shape `key`'s format changed by `fn` (null removes it). */
export function withShapeFormat(model, key, fn) {
  const slash = key.indexOf("/");
  const change = (formats, name) => {
    const next = clean(fn(formats?.[name] ?? {}));
    return next ? clean({ ...formats, [name]: next }) : without(formats, name);
  };
  if (slash < 0) {
    const format = change(model.format, key);
    const { format: _f, ...rest } = model;
    return format ? { ...rest, format } : rest;
  }
  const index = Number(key.slice(0, slash)),
    name = key.slice(slash + 1);
  return {
    ...model,
    items: model.items.map((item, i) => {
      if (i !== index) return item;
      const format = change(item.format, name);
      const { format: _f, ...rest } = item;
      return format ? { ...rest, format } : rest;
    }),
  };
}

/** The model with item `index`'s text style changed by `fn`. */
export function withTextStyle(model, index, fn) {
  return {
    ...model,
    items: model.items.map((item, i) => {
      if (i !== index) return item;
      const textStyle = clean(fn(item.textStyle ?? {}));
      const { textStyle: _t, ...rest } = item;
      return textStyle ? { ...rest, textStyle } : rest;
    }),
  };
}

/** A WordArt gallery style as a SmartArt text style. */
export function wordArtTextStyle(format) {
  const fill =
    format.colorOpacity === 0
      ? "none"
      : format.gradient
        ? format.gradient.stops[0]?.color
        : format.color;
  const fx = format.effects || {};
  const effects = clean({
    shadow: fx.shadow
      ? {
          type: fx.shadow.inner ? "inner" : "outer",
          color: fx.shadow.color,
          opacity: fx.shadow.opacity,
          blurEmu: fx.shadow.blurEmu,
          distEmu: fx.shadow.distEmu,
          angleDeg: fx.shadow.angleDeg,
        }
      : undefined,
    glow: fx.glow ? { ...fx.glow } : undefined,
    reflection: fx.reflection ? { ...fx.reflection } : undefined,
  });
  return {
    fill: fill?.toUpperCase?.() ?? fill,
    outline: format.outline ? format.outline.color.toUpperCase() : undefined,
    outlineWidth: format.outline ? format.outline.widthEmu : undefined,
    effects,
  };
}

/** The shape under a point (frame-local EMU), topmost first. */
export function shapeAt(shapes, x, y) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const cx = s.x + s.w / 2,
      cy = s.y + s.h / 2;
    const a = (-(s.rot || 0) * Math.PI) / 180;
    const dx = x - cx,
      dy = y - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a),
      ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= s.w / 2 && Math.abs(ly) <= s.h / 2) return s;
  }
  return null;
}

export function createSmartArtFormat({
  P,
  h,
  modelOf,
  keyOf,
  selectedGraphic,
  update,
}) {
  let pick = null; // { frame: keyOf(graphic), shape: shape key }
  const last = { fill: null, line: null, text: null, textOutline: null };

  const authored = (obj) => !!obj && !!modelOf(obj)?.layout;
  const shapesOf = (obj) => {
    try {
      return authored(obj) ? P.getSmartArtShapes(obj) : [];
    } catch {
      return [];
    }
  };
  const picked = () => {
    const obj = selectedGraphic();
    if (!obj || !pick || pick.frame !== keyOf(obj)) return null;
    const shape = shapesOf(obj).find((s) => s.key === pick.shape);
    return shape ? { obj, shape, model: modelOf(obj) } : null;
  };
  const itemText = (model, shape) =>
    shape.item === null
      ? ""
      : (model?.items[shape.item]?.text || "").replace(/\s+/g, " ").trim();
  const describe = (model, shape) => {
    const text = itemText(model, shape);
    const role = ROLE_NAMES[shape.role] || "Shape";
    return text ? `${role}: ${text}` : role;
  };
  const choose = (obj, key) => {
    pick = key ? { frame: keyOf(obj), shape: key } : null;
    h.refreshRibbon();
    h.refreshCanvas?.();
  };

  /** Picks the shape under a click on a selected graphic (fractions of
   *  its frame). Returns whether one was picked. */
  function pickAt(obj, fx, fy) {
    if (!authored(obj)) return false;
    const b = h.bounds(obj);
    if (!b) return false;
    const found = shapeAt(shapesOf(obj), fx * b.w, fy * b.h);
    choose(obj, found?.key ?? null);
    return !!found;
  }
  function clearPick() {
    if (pick) choose(selectedGraphic(), null);
  }

  // One undoable change to the picked shape's format.
  function setFormat(fn, target = picked()) {
    if (!target) return;
    update(target.obj, (m) => withShapeFormat(m, target.shape.key, fn));
  }
  function setTextStyle(fn, target = picked()) {
    if (!target || target.shape.item === null) return;
    update(target.obj, (m) => withTextStyle(m, target.shape.item, fn));
  }

  /** Fills shape `key` of `obj` with a picture the person chooses. */
  function insertPicture(obj, key) {
    h.pickPicture?.((bytes) =>
      h.mutateShape(obj, (target) => {
        const model = P.getShapeSmartArt(target);
        if (!model?.layout) return h.skip;
        const picture = P.addSmartArtPicture(target, bytes);
        P.setShapeSmartArt(
          target,
          withShapeFormat(model, key, (f) => ({
            ...f,
            picture,
            fill: undefined,
          })),
        );
      }),
    );
  }

  /* ---------- Canvas ---------- */
  function decorateCanvas(canvas) {
    canvas.querySelectorAll(".smartart-parts").forEach((n) => n.remove());
    const obj = selectedGraphic();
    if (!obj || !authored(obj) || h.readOnly()) return;
    const hit = canvas.querySelector(
      `.object-hit[data-shape-id="${P.getShapeId(obj)}"]`,
    );
    const b = h.bounds(obj);
    if (!hit || !b?.w || !b?.h) return;
    const model = modelOf(obj);
    const box = el("div", {
      class: "smartart-parts",
      "data-shape-id": String(P.getShapeId(obj)),
    });
    for (const key of ["left", "top", "width", "height", "transform"])
      box.style[key] = hit.style[key];
    const current = picked();
    for (const s of shapesOf(obj)) {
      const place = (node) => {
        Object.assign(node.style, {
          left: `${(s.x / b.w) * 100}%`,
          top: `${(s.y / b.h) * 100}%`,
          width: `${(s.w / b.w) * 100}%`,
          height: `${(s.h / b.h) * 100}%`,
          transform: s.rot ? `rotate(${s.rot}deg)` : "",
        });
        return node;
      };
      if (current?.shape.key === s.key)
        box.append(
          place(
            el("div", {
              class: "smartart-part picked",
              "aria-hidden": "true",
            }),
          ),
        );
      if (s.role === "pic" && !s.format?.picture) {
        const slot = el("div", { class: "smartart-picture-slot" });
        place(slot);
        const label = `Insert picture${itemText(model, s) ? ` for ${itemText(model, s)}` : ""}`;
        slot.append(
          el(
            "button",
            {
              type: "button",
              class: "smartart-picture-button",
              "aria-label": label,
              title: label,
              "data-part": s.key,
              onpointerdown: (e) => e.stopPropagation(),
              onclick: (e) => {
                e.stopPropagation();
                insertPicture(obj, s.key);
              },
            },
            icon("o:picture", 18),
          ),
        );
        box.append(slot);
      }
    }
    canvas.append(box);
  }

  /* ---------- Menus ---------- */
  const theme = () => h.theme();
  function selectShapeMenu() {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    const current = picked();
    return [
      {
        label: "Whole Graphic",
        checked: !current,
        onSelect: () => choose(obj, null),
      },
      { separator: true },
      ...shapesOf(obj).map((s) => ({
        label: describe(model, s),
        checked: current?.shape.key === s.key,
        onSelect: () => choose(obj, s.key),
      })),
    ];
  }
  function fillMenu() {
    const target = picked();
    return colorMenuItems({
      theme: theme(),
      current: cssColor(target?.shape.format?.fill, theme()),
      onPick: (value, hex) => {
        last.fill = { value, hex };
        setFormat((f) => ({ ...f, fill: value, picture: undefined }));
      },
      none: {
        label: "No Fill",
        icon: "Ban",
        onSelect: () =>
          setFormat((f) => ({ ...f, fill: "none", picture: undefined })),
      },
      extra: [
        { separator: true },
        {
          label: "Picture…",
          icon: "o:picture",
          disabled: !target,
          onSelect: () => insertPicture(target.obj, target.shape.key),
        },
      ],
    });
  }
  function outlineMenu() {
    const target = picked();
    const width = target?.shape.format?.lineWidth;
    return colorMenuItems({
      theme: theme(),
      current: cssColor(target?.shape.format?.line, theme()),
      onPick: (value, hex) => {
        last.line = { value, hex };
        setFormat((f) => ({ ...f, line: value }));
      },
      none: {
        label: "No Outline",
        icon: "Ban",
        onSelect: () => setFormat((f) => ({ ...f, line: "none" })),
      },
      extra: [
        { separator: true },
        {
          label: "Weight",
          icon: "o:lineSpacing",
          items: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => ({
            label: `${w} pt`,
            checked: width === Math.round(w * PT),
            onSelect: () =>
              setFormat((f) => ({ ...f, lineWidth: Math.round(w * PT) })),
          })),
        },
      ],
    });
  }
  // The shared effect galleries, without their links to the Format pane.
  function effectMenus(current, apply, only) {
    return effectsMenuItems(
      {
        current,
        apply,
        apply3D: () => {},
        openOptions: () => {},
        accentColor: (token) =>
          cssColor(`scheme:${token}`, theme()) || "#4472C4",
      },
      { only },
    ).map((group) => ({
      ...group,
      items: group.items.filter(
        (item, i, all) =>
          !/Options…$/.test(item.label || "") &&
          !(item.separator && /Options…$/.test(all[i + 1]?.label || "")),
      ),
    }));
  }
  function effectsMenu() {
    const target = picked();
    return effectMenus(
      target?.shape.format?.effects ?? {},
      (patch) =>
        setFormat((f) => ({
          ...f,
          effects: clean({ ...f.effects, ...patch }),
        })),
      ["Shadow", "Reflection", "Glow", "Soft Edges"],
    );
  }
  const textStyleOf = (target) =>
    target && target.shape.item !== null
      ? (target.model?.items[target.shape.item]?.textStyle ?? {})
      : {};
  function textFillMenu() {
    const target = picked();
    return colorMenuItems({
      theme: theme(),
      current: cssColor(textStyleOf(target).fill, theme()),
      onPick: (value, hex) => {
        last.text = { value, hex };
        setTextStyle((t) => ({ ...t, fill: value }));
      },
    });
  }
  function textOutlineMenu() {
    const target = picked();
    return colorMenuItems({
      theme: theme(),
      current: cssColor(textStyleOf(target).outline, theme()),
      onPick: (value, hex) => {
        last.textOutline = { value, hex };
        setTextStyle((t) => ({
          ...t,
          outline: value,
          outlineWidth: t.outlineWidth ?? Math.round(0.75 * PT),
        }));
      },
      none: {
        label: "No Outline",
        icon: "Ban",
        onSelect: () =>
          setTextStyle((t) => ({
            ...t,
            outline: undefined,
            outlineWidth: undefined,
          })),
      },
    });
  }
  function textEffectsMenu() {
    const target = picked();
    return effectMenus(
      textStyleOf(target).effects ?? {},
      (patch) =>
        setTextStyle((t) => ({
          ...t,
          effects: clean({ ...t.effects, ...patch }),
        })),
      ["Shadow", "Reflection", "Glow"],
    );
  }
  function wordArtChoices() {
    return wordArtStyles(theme()).map((s, i) => ({
      id: `smartart-wordart-${i}`,
      label: s.label,
      render: () =>
        el("span", { class: "fmt-wordart", style: wordArtCss(s.format) }, "A"),
    }));
  }
  function applyWordArt(id) {
    const style =
      wordArtStyles(theme())[
        Number(String(id).replace("smartart-wordart-", ""))
      ];
    if (style) setTextStyle(() => wordArtTextStyle(style.format));
  }

  /* ---------- Tab ---------- */
  function tab() {
    const visible = () => authored(selectedGraphic());
    const on = () => !!picked() && !h.readOnly();
    const onItem = () => on() && picked().shape.item !== null;
    const scaleBy = (k) =>
      setFormat((f) => {
        const next = Math.round((f.scale ?? 1) * k * 100) / 100;
        return {
          ...f,
          scale:
            Math.abs(next - 1) < 0.01
              ? undefined
              : Math.min(3, Math.max(0.3, next)),
        };
      });
    const hint = "Click a shape in the graphic, or use Select Shape, first.";
    return {
      id: "smartart-format",
      label: "SmartArt Format",
      contextual: true,
      visible,
      groups: [
        {
          id: "smartart-shapes",
          label: "Shapes",
          icon: "editShape",
          items: [
            {
              type: "large",
              id: "smartart-change-shape",
              label: "Change\nShape",
              icon: "editShape",
              title: "Change Shape",
              description: `Draw the chosen shape of the graphic as another shape. ${hint}`,
              enabled: () => on() && picked().shape.geom !== "custom",
              menu: () => {
                const target = picked();
                return changeShapeItems({
                  current: target?.shape.geom,
                  choose: (geom) => setFormat((f) => ({ ...f, geom })),
                });
              },
              menuWidth: 300,
            },
            {
              type: "stack",
              items: [
                {
                  type: "small",
                  id: "smartart-larger",
                  label: "Larger",
                  icon: "shapeLarger",
                  title: "Larger",
                  description: "Make the shape a step larger.",
                  enabled: on,
                  run: () => scaleBy(SCALE_STEP),
                },
                {
                  type: "small",
                  id: "smartart-smaller",
                  label: "Smaller",
                  icon: "shapeSmaller",
                  title: "Smaller",
                  description: "Make the shape a step smaller.",
                  enabled: on,
                  run: () => scaleBy(1 / SCALE_STEP),
                },
                {
                  type: "small",
                  id: "smartart-select-shape",
                  label: "Select Shape",
                  icon: "select",
                  title: "Select Shape",
                  description: "Choose one shape of the graphic to format.",
                  enabled: () => visible() && !h.readOnly(),
                  menu: () => selectShapeMenu(),
                },
              ],
            },
            {
              type: "large",
              id: "smartart-reset-shape",
              label: "Reset\nShape",
              icon: "resetGraphic",
              title: "Reset Shape",
              description:
                "Remove this shape's own formatting and its text style.",
              enabled: on,
              run: () => {
                const target = picked();
                if (!target) return;
                update(target.obj, (m) => {
                  let next = withShapeFormat(m, target.shape.key, () => null);
                  if (target.shape.item !== null)
                    next = withTextStyle(next, target.shape.item, () => null);
                  return next;
                });
              },
            },
          ],
        },
        {
          id: "smartart-shape-styles",
          label: "Shape Styles",
          icon: "quickStyles",
          items: [
            {
              type: "stack",
              items: [
                {
                  type: "color",
                  id: "smartart-shape-fill",
                  label: "Shape Fill",
                  icon: "shapeFill",
                  enabled: on,
                  color: () => last.fill?.hex,
                  run: () =>
                    last.fill &&
                    setFormat((f) => ({
                      ...f,
                      fill: last.fill.value,
                      picture: undefined,
                    })),
                  menu: () => fillMenu(),
                  menuLabel: "Fill colors",
                },
                {
                  type: "color",
                  id: "smartart-shape-outline",
                  label: "Shape Outline",
                  icon: "shapeOutline",
                  enabled: on,
                  color: () => last.line?.hex,
                  run: () =>
                    last.line &&
                    setFormat((f) => ({ ...f, line: last.line.value })),
                  menu: () => outlineMenu(),
                  menuLabel: "Outline colors",
                },
                {
                  type: "small",
                  id: "smartart-shape-effects",
                  label: "Shape Effects",
                  icon: "shapeEffects",
                  enabled: on,
                  menu: () => effectsMenu(),
                },
              ],
            },
          ],
        },
        {
          id: "smartart-wordart",
          label: "WordArt Styles",
          icon: "wordArt",
          items: [
            {
              type: "gallery",
              id: "smartart-wordart-gallery",
              label: "WordArt Styles",
              columns: 4,
              panelColumns: 6,
              itemClass: "style-thumb",
              showLabels: false,
              enabled: onItem,
              items: () => wordArtChoices(),
              choose: (choice) => applyWordArt(choice.id),
            },
            {
              type: "stack",
              items: [
                {
                  type: "color",
                  id: "smartart-text-fill",
                  label: "Text Fill",
                  icon: "textFill",
                  enabled: onItem,
                  color: () => last.text?.hex,
                  run: () =>
                    last.text &&
                    setTextStyle((t) => ({ ...t, fill: last.text.value })),
                  menu: () => textFillMenu(),
                  menuLabel: "Text fill colors",
                },
                {
                  type: "color",
                  id: "smartart-text-outline",
                  label: "Text Outline",
                  icon: "textOutline",
                  enabled: onItem,
                  color: () => last.textOutline?.hex,
                  run: () =>
                    last.textOutline &&
                    setTextStyle((t) => ({
                      ...t,
                      outline: last.textOutline.value,
                      outlineWidth: t.outlineWidth ?? Math.round(0.75 * PT),
                    })),
                  menu: () => textOutlineMenu(),
                  menuLabel: "Text outline colors",
                },
                {
                  type: "small",
                  id: "smartart-text-effects",
                  label: "Text Effects",
                  icon: "textEffects",
                  enabled: onItem,
                  menu: () => textEffectsMenu(),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  return {
    pickAt,
    clearPick,
    picked,
    decorateCanvas,
    insertPicture,
    tab,
  };
}
