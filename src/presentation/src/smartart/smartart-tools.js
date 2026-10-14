// SmartArt in the editor: inserting a graphic, the Text Pane, the SmartArt
// Design tab, Convert to SmartArt for bulleted text, and the graphic's
// section of the Format pane. The engine (lib/pptx smartart) writes the
// graphic's parts; this module only decides what to write.
import "./smartart.css";
import "../charts/chart-icons.js";
import { el, toast, button, closeMenu } from "../ui.js";
import { chooseSmartArtLayout, svgUrl } from "./smartart-dialog.js";
import { openTextPane } from "./smartart-pane.js";
import {
  addAbove,
  addAfter,
  addBefore,
  addBelow,
  canDemote,
  canMoveDown,
  canMoveUp,
  canPromote,
  demote,
  itemsFromParagraphs,
  moveDown,
  moveUp,
  normalize,
  promote,
  removeItem,
} from "./outline.js";

// Layouts offered first when bulleted text becomes a graphic.
const CONVERT_PICKS = 8;

export function createSmartArtTools(h) {
  const { P } = h;
  let pane = null;
  let current = { key: null, index: 0 };
  let warnedForeign = new Set();

  const isSmartArt = (obj) => {
    try {
      return !!obj && P.isDiagramShape(obj);
    } catch {
      return false;
    }
  };
  const modelOf = (obj) => {
    try {
      return obj ? P.getShapeSmartArt(obj) : null;
    } catch {
      return null;
    }
  };
  const selectedGraphic = () => {
    const list = h.selection();
    return list.length === 1 && isSmartArt(list[0]) ? list[0] : null;
  };
  const keyOf = (obj) =>
    `${P.getSlidePartName(P.getShapeSlide(obj))}#${P.getShapeId(obj)}`;
  const layoutInfo = (id) => P.SMARTART_LAYOUTS.find((l) => l.id === id);
  function palette() {
    const t = h.theme() || {};
    const hex = (v, d) => `#${String(v || d).replace("#", "")}`;
    return {
      accents: [1, 2, 3, 4, 5, 6].map((i) => hex(t[`accent${i}`], "4472C4")),
      dk1: hex(t.dark1, "000000"),
      lt1: hex(t.light1, "FFFFFF"),
    };
  }
  const currentIndex = (obj, model) => {
    if (!obj || !model) return 0;
    if (pane?.open && pane.key === keyOf(obj)) current.index = pane.current;
    else if (current.key !== keyOf(obj))
      current = { key: keyOf(obj), index: model.items.length - 1 };
    return Math.max(0, Math.min(current.index, model.items.length - 1));
  };
  // One undoable edit of the graphic's model.
  function update(obj, fn, coalesce = null) {
    if (!obj) return Promise.resolve(false);
    let nextIndex = null;
    return h
      .mutateShape(
        obj,
        (target) => {
          const model = modelOf(target);
          if (!model) return h.skip;
          let next = fn(model);
          if (!next) return h.skip;
          if (next.index != null) {
            nextIndex = next.index;
            next = next.model;
          }
          if (JSON.stringify(next) === JSON.stringify(model)) return h.skip;
          if (!next.layout && structureChanged(model.items, next.items)) {
            // An imported layout can take new text but not new shapes; the
            // graphic moves to the nearest layout this editor draws.
            next = { ...next, layout: P.guessSmartArtLayout(target) };
            const key = keyOf(target);
            if (!warnedForeign.has(key)) {
              warnedForeign.add(key);
              toast(
                `The graphic now uses the ${layoutInfo(next.layout)?.name || "closest"} layout so it can take the change.`,
              );
            }
          }
          P.setShapeSmartArt(target, next);
        },
        coalesce ? { coalesce: `${coalesce}:${keyOf(obj)}` } : undefined,
      )
      .then((ok) => {
        if (ok && nextIndex != null) {
          current = { key: keyOf(obj), index: nextIndex };
          if (pane?.open && pane.key === keyOf(obj)) {
            pane.sync();
            pane.current = nextIndex;
            pane.focusItem(nextIndex);
          }
        }
        return ok;
      });
  }
  const structureChanged = (a, b) =>
    a.length !== b.length || a.some((x, i) => x.level !== b[i].level);
  const updateSelected = (fn, coalesce) =>
    update(selectedGraphic(), fn, coalesce);

  /* ---------- Insert ---------- */
  async function insert() {
    h.commitText();
    const layout = await chooseSmartArtLayout({
      P,
      title: "Choose a SmartArt Graphic",
      confirm: "Insert",
      palette: palette(),
    });
    if (!layout) return;
    const info = layoutInfo(layout);
    const size = h.slideSize();
    const w = Math.round(size.cx * 0.64),
      hgt = Math.round(size.cy * 0.62);
    const x = Math.round((size.cx - w) / 2),
      y = Math.round((size.cy - hgt) / 2 + size.cy * 0.05);
    await place(
      {
        layout,
        items: info.sample.map((i) => ({ ...i })),
        colors: P.DEFAULT_SMARTART_COLORS,
        style: P.DEFAULT_SMARTART_STYLE,
      },
      { x, y, w, h: hgt },
    );
  }
  async function place(model, box, { replace = null } = {}) {
    let id = null;
    const ok = await h.mutateSlide(h.slide(), (target) => {
      if (replace) {
        const old = P.findShapeById(target, replace);
        if (old) h.removeShape(target, old);
      }
      const shape = P.addSlideSmartArt(target, { model, ...box });
      P.renameShape(shape, `SmartArt ${P.getShapeId(shape)}`);
      id = P.getShapeId(shape);
      h.selectIds([id]);
    });
    if (ok && id != null) {
      h.selectTab?.("smartart-design");
      openPane();
    }
    return ok;
  }

  /* ---------- Text Pane ---------- */
  function openPane(obj = selectedGraphic()) {
    if (!obj) return;
    const key = keyOf(obj);
    if (pane?.open) {
      if (pane.key === key) {
        pane.close();
        return;
      }
      pane.close();
    }
    const part = P.getSlidePartName(P.getShapeSlide(obj));
    const id = P.getShapeId(obj);
    const target = () => {
      const s = P.getSlides(h.pres()).find(
        (x) => P.getSlidePartName(x) === part,
      );
      const shape = s ? P.findShapeById(s, id) : null;
      return isSmartArt(shape) ? shape : null;
    };
    const model = modelOf(obj);
    const opened = openTextPane({
      title: "Text Pane",
      about: model?.layout
        ? `${layoutInfo(model.layout)?.name}: ${layoutInfo(model.layout)?.description}`
        : "",
      read: () => modelOf(target())?.items.map((i) => ({ ...i })) ?? null,
      write: (items) =>
        update(
          target(),
          (m) => ({ ...m, items: normalize(items) }),
          "smartart-text",
        ),
      onCurrent: (i) => {
        current = { key, index: i };
        h.refreshRibbon();
      },
    });
    if (!opened) return;
    opened.key = key;
    opened.onClose = () => {
      if (pane === opened) pane = null;
      h.refreshRibbon();
    };
    pane = opened;
    h.refreshRibbon();
  }
  const paneOpen = () => {
    const obj = selectedGraphic();
    return !!(obj && pane?.open && pane.key === keyOf(obj));
  };

  /* ---------- Outline commands ---------- */
  function outline(op) {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    if (!model) return;
    const i = currentIndex(obj, model);
    update(obj, (m) => {
      const result = op(m.items, i);
      return {
        model: { ...m, items: normalize(result.items) },
        index: result.index,
      };
    });
  }
  const can = (test) => {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    if (!model || h.readOnly()) return false;
    return test(model.items, currentIndex(obj, model), model);
  };
  function addShapeMenu() {
    return [
      {
        label: "Add Shape After",
        icon: "o:addShape",
        onSelect: () => outline(addAfter),
      },
      { label: "Add Shape Before", onSelect: () => outline(addBefore) },
      { label: "Add Shape Above", onSelect: () => outline(addAbove) },
      { label: "Add Shape Below", onSelect: () => outline(addBelow) },
      { separator: true },
      {
        label: "Delete Current Shape",
        icon: "o:deleteRows",
        disabled: !can((items) => items.length > 1),
        onSelect: () => outline(removeItem),
      },
    ];
  }

  /* ---------- Layouts, colours and styles ---------- */
  function layoutChoices() {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    const pal = palette();
    const version = JSON.stringify([
      model?.colors,
      model?.style,
      pal.accents[0],
    ]);
    return P.SMARTART_LAYOUTS.map((l) => ({
      id: l.id,
      label: l.name,
      description: l.description,
      category: l.category,
      version,
      render: () =>
        el("img", {
          class: "smartart-gallery-img",
          alt: "",
          "aria-hidden": "true",
          src: preview(l.id, {
            colors: model?.colors,
            style: model?.style,
            palette: pal,
          }),
        }),
    }));
  }
  const previews = new Map();
  function preview(layout, opts, width = 96, height = 72) {
    const key = JSON.stringify([layout, opts, width, height]);
    if (!previews.has(key)) {
      let url = "";
      try {
        url = svgUrl(
          P.smartArtPreviewSvg(layout, {
            width,
            height,
            ...(opts.colors ? { colors: opts.colors } : {}),
            ...(opts.style ? { style: opts.style } : {}),
            ...(opts.items ? { items: opts.items.slice(0, 12) } : {}),
            palette: opts.palette,
          }),
        );
      } catch {}
      previews.set(key, url);
      if (previews.size > 400) previews.delete(previews.keys().next().value);
    }
    return previews.get(key);
  }
  function layoutSections(choices) {
    return P.SMARTART_CATEGORIES.map((c) => ({
      label: c.label,
      items: choices.filter((x) => x.category === c.id),
    })).filter((s) => s.items.length);
  }
  function colorsMenu() {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    if (!model) return [];
    const pal = palette();
    const layout = model.layout || P.guessSmartArtLayout(obj);
    const out = [];
    let group = null;
    let grid = null;
    for (const scheme of P.SMARTART_COLOR_SCHEMES) {
      if (scheme.group !== group) {
        group = scheme.group;
        out.push({ header: group });
        grid = el("div", {
          class: "chart-menu-grid",
          role: "group",
          "aria-label": group,
          style: "grid-template-columns:repeat(5, auto)",
        });
        out.push({ custom: grid });
      }
      grid.append(
        el(
          "button",
          {
            type: "button",
            role: "menuitemradio",
            "aria-checked": String(scheme.id === model.colors),
            tabindex: -1,
            class: "chart-menu-choice smartart-color-choice",
            "aria-label": scheme.name,
            title: scheme.name,
            onclick: () => {
              closeMenu();
              updateSelected((m) => ({
                ...m,
                colors: scheme.id,
                layout: m.layout || layout,
              }));
            },
          },
          el("img", {
            class: "smartart-color-img",
            alt: "",
            "aria-hidden": "true",
            src: preview(
              layout,
              { colors: scheme.id, style: model.style, palette: pal },
              60,
              40,
            ),
          }),
        ),
      );
    }
    return out;
  }
  function styleChoices() {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    if (!model) return [];
    const pal = palette();
    const layout = model.layout || P.guessSmartArtLayout(obj);
    const version = JSON.stringify([layout, model.colors, pal.accents[0]]);
    return P.SMARTART_STYLES.map((s) => ({
      id: s.id,
      label: s.name,
      version,
      render: () =>
        el("img", {
          class: "smartart-gallery-img",
          alt: "",
          "aria-hidden": "true",
          src: preview(layout, {
            colors: model.colors,
            style: s.id,
            palette: pal,
          }),
        }),
    }));
  }

  /* ---------- Reset and convert ---------- */
  function resetGraphic() {
    updateSelected((m) => ({
      ...m,
      layout: m.layout || P.guessSmartArtLayout(selectedGraphic()),
      colors: P.DEFAULT_SMARTART_COLORS,
      style: P.DEFAULT_SMARTART_STYLE,
      rightToLeft: undefined,
    }));
  }
  function convertToShapes() {
    const obj = selectedGraphic();
    if (!obj) return;
    pane?.close();
    h.mutateShape(obj, (target, targetSlide) => {
      const group = P.convertSmartArtToShapes(targetSlide, target);
      h.selectIds([P.getShapeId(group)]);
    });
  }
  function convertToText() {
    const obj = selectedGraphic();
    const model = modelOf(obj);
    if (!model) return;
    pane?.close();
    const lines = P.smartArtTextLines(model);
    h.mutateShape(obj, (target, targetSlide) => {
      const b = h.bounds(target);
      const box = P.addSlideTextBox(targetSlide, {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        text: lines.map((l) => l.text).join("\n"),
      });
      P.renameShape(box, `TextBox ${P.getShapeId(box)}`);
      P.setShapeBullets(box, "bullet");
      lines.forEach((l, i) => h.setIndentLevel(box, i, l.level, true));
      h.removeShape(targetSlide, target);
      h.selectIds([P.getShapeId(box)]);
    });
  }
  // Bulleted text that can become a graphic: one text object with text.
  function convertibleText() {
    const list = h.selection();
    if (list.length !== 1) return null;
    const obj = list[0];
    if (isSmartArt(obj) || !h.canHoldText(obj)) return null;
    try {
      if (!P.getShapeParagraphCount(obj)) return null;
      if (!P.getShapeText(obj).trim()) return null;
    } catch {
      return null;
    }
    return obj;
  }
  function paragraphsOf(obj) {
    const text = h.displayText(obj).split("\n");
    return text.map((t, i) => {
      let level = 0;
      try {
        level = P.getParagraphPropertiesEffective(h.pres(), obj, i)?.level ?? 0;
      } catch {}
      return { text: t, level };
    });
  }
  async function convertText(obj, layout) {
    if (!obj) return;
    h.commitText();
    if (!layout) {
      layout = await chooseSmartArtLayout({
        P,
        title: "Convert to SmartArt",
        confirm: "Convert",
        palette: palette(),
        items: itemsFromParagraphs(paragraphsOf(obj)),
      });
      if (!layout) return;
    }
    const items = itemsFromParagraphs(paragraphsOf(obj));
    if (!items.length) {
      toast("The text box has no text to convert.");
      return;
    }
    const b = h.bounds(obj);
    const box = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.max(P.inches(3), Math.round(b.w)),
      h: Math.max(P.inches(2), Math.round(b.h)),
    };
    await place(
      {
        layout,
        items,
        colors: P.DEFAULT_SMARTART_COLORS,
        style: P.DEFAULT_SMARTART_STYLE,
      },
      box,
      { replace: P.getShapeId(obj) },
    );
  }
  function convertMenu() {
    const obj = convertibleText();
    if (!obj) return [];
    const items = itemsFromParagraphs(paragraphsOf(obj));
    const pal = palette();
    const picks = [];
    for (const c of P.SMARTART_CATEGORIES) {
      const l = P.SMARTART_LAYOUTS.find(
        (x) => x.category === c.id && !x.picture,
      );
      if (l) picks.push(l);
    }
    for (const l of P.SMARTART_LAYOUTS)
      if (picks.length < CONVERT_PICKS * 2 && !picks.includes(l) && !l.picture)
        picks.push(l);
    const grid = el("div", {
      class: "chart-menu-grid",
      role: "group",
      "aria-label": "Layouts",
      style: "grid-template-columns:repeat(4, auto)",
    });
    for (const l of picks.slice(0, CONVERT_PICKS * 2))
      grid.append(
        el(
          "button",
          {
            type: "button",
            role: "menuitem",
            tabindex: -1,
            class: "chart-menu-choice",
            "aria-label": l.name,
            title: l.name,
            onclick: () => {
              closeMenu();
              convertText(obj, l.id);
            },
          },
          el("img", {
            class: "smartart-gallery-img",
            alt: "",
            "aria-hidden": "true",
            src: preview(l.id, { items, palette: pal }),
          }),
        ),
      );
    return [
      { custom: grid },
      { separator: true },
      {
        label: "More SmartArt Graphics…",
        icon: "o:smartArt",
        onSelect: () => convertText(obj),
      },
    ];
  }

  /* ---------- Format pane ---------- */
  function inspector(obj) {
    if (!isSmartArt(obj)) return null;
    const model = modelOf(obj);
    if (!model) return null;
    const f = h.fields;
    const select = (label, value, options, apply) =>
      f.field(
        label,
        el(
          "select",
          {
            class: "input",
            "aria-label": label,
            onchange: (e) => update(obj, (m) => apply(m, e.target.value)),
          },
          ...options.map(([v, l]) =>
            el("option", { value: v, selected: v === value }, l),
          ),
        ),
      );
    return [
      el("h3", {}, "SmartArt graphic"),
      select(
        "Layout",
        model.layout,
        [
          ...(model.layout ? [] : [["", "Imported layout"]]),
          ...P.SMARTART_LAYOUTS.map((l) => [l.id, `${l.name}`]),
        ],
        (m, v) => (v ? { ...m, layout: v } : null),
      ),
      select(
        "Colors",
        model.colors,
        P.SMARTART_COLOR_SCHEMES.map((c) => [c.id, c.name]),
        (m, v) => ({
          ...m,
          colors: v,
          layout: m.layout || P.guessSmartArtLayout(obj),
        }),
      ),
      select(
        "Style",
        model.style,
        P.SMARTART_STYLES.map((s) => [s.id, s.name]),
        (m, v) => ({
          ...m,
          style: v,
          layout: m.layout || P.guessSmartArtLayout(obj),
        }),
      ),
      el(
        "label",
        { class: "check-field" },
        el("input", {
          type: "checkbox",
          checked: !!model.rightToLeft,
          onchange: (e) =>
            update(obj, (m) => ({
              ...m,
              rightToLeft: e.target.checked || undefined,
              layout: m.layout || P.guessSmartArtLayout(obj),
            })),
        }),
        el("span", {}, "Right to left"),
      ),
      el(
        "div",
        { class: "arrange-buttons" },
        button("Text Pane", "o:textPane", () => openPane(obj), "secondary"),
        button(
          "Convert to Shapes",
          "o:convertToShapes",
          () => convertToShapes(),
          "secondary",
        ),
      ),
    ];
  }
  const formatTitle = (obj) => (isSmartArt(obj) ? "Format SmartArt" : null);

  /* ---------- Tabs ---------- */
  function tabs() {
    const visible = () => !!selectedGraphic();
    const enabled = () => !!modelOf(selectedGraphic()) && !h.readOnly();
    const small = (id, label, iconName, run, test, extra = {}) => ({
      type: "small",
      id,
      label,
      icon: iconName,
      title: label,
      enabled: () => enabled() && (!test || can(test)),
      run,
      ...extra,
    });
    return [
      {
        id: "smartart-design",
        label: "SmartArt Design",
        contextual: true,
        visible,
        groups: [
          {
            id: "smartart-create",
            label: "Create Graphic",
            icon: "addShape",
            items: [
              {
                type: "large",
                id: "smartart-add-shape",
                label: "Add\nShape",
                icon: "addShape",
                title: "Add Shape",
                description:
                  "Add a shape after the current one, or choose where.",
                split: true,
                enabled,
                run: () => outline(addAfter),
                menu: () => addShapeMenu(),
              },
              {
                type: "stack",
                items: [
                  small("smartart-add-bullet", "Add Bullet", "bullets", () =>
                    outline(addBelow),
                  ),
                  small(
                    "smartart-text-pane",
                    "Text Pane",
                    "textPane",
                    () => openPane(),
                    null,
                    {
                      type: "toggle",
                      showLabel: true,
                      pressed: () => paneOpen(),
                    },
                  ),
                  small(
                    "smartart-rtl",
                    "Right to Left",
                    "rightToLeft",
                    () =>
                      updateSelected((m) => ({
                        ...m,
                        rightToLeft: !m.rightToLeft || undefined,
                        layout:
                          m.layout || P.guessSmartArtLayout(selectedGraphic()),
                      })),
                    null,
                    {
                      type: "toggle",
                      showLabel: true,
                      pressed: () => !!modelOf(selectedGraphic())?.rightToLeft,
                    },
                  ),
                ],
              },
              {
                type: "stack",
                items: [
                  small(
                    "smartart-promote",
                    "Promote",
                    "promote",
                    () => outline(promote),
                    canPromote,
                  ),
                  small(
                    "smartart-demote",
                    "Demote",
                    "demote",
                    () => outline(demote),
                    canDemote,
                  ),
                ],
              },
              {
                type: "stack",
                items: [
                  small(
                    "smartart-move-up",
                    "Move Up",
                    "moveUp",
                    () => outline(moveUp),
                    canMoveUp,
                  ),
                  small(
                    "smartart-move-down",
                    "Move Down",
                    "moveDown",
                    () => outline(moveDown),
                    canMoveDown,
                  ),
                ],
              },
            ],
          },
          {
            id: "smartart-layouts",
            label: "Layouts",
            icon: "smartArtLayout",
            collapsible: false,
            items: [
              {
                type: "gallery",
                id: "smartart-layout-gallery",
                label: "Layouts",
                columns: 4,
                panelColumns: 6,
                itemClass: "smartart-gallery-thumb",
                showLabels: false,
                enabled,
                items: () => layoutChoices(),
                sections: (choices) => layoutSections(choices),
                selected: () => modelOf(selectedGraphic())?.layout || null,
                choose: (choice) =>
                  updateSelected((m) => ({ ...m, layout: choice.id })),
              },
            ],
          },
          {
            id: "smartart-styles",
            label: "SmartArt Styles",
            icon: "quickStyles",
            collapsible: false,
            items: [
              {
                type: "large",
                id: "smartart-colors",
                label: "Change\nColors",
                icon: "chartColors",
                title: "Change Colors",
                description: "Choose a color scheme for the graphic.",
                enabled,
                menu: () => colorsMenu(),
                menuWidth: 340,
              },
              {
                type: "gallery",
                id: "smartart-style-gallery",
                label: "SmartArt Styles",
                columns: 4,
                panelColumns: 4,
                itemClass: "smartart-gallery-thumb",
                showLabels: false,
                enabled,
                items: () => styleChoices(),
                selected: () => modelOf(selectedGraphic())?.style || null,
                choose: (choice) =>
                  updateSelected((m) => ({
                    ...m,
                    style: choice.id,
                    layout:
                      m.layout || P.guessSmartArtLayout(selectedGraphic()),
                  })),
              },
            ],
          },
          {
            id: "smartart-reset",
            label: "Reset",
            icon: "resetGraphic",
            items: [
              {
                type: "large",
                id: "smartart-reset-graphic",
                label: "Reset\nGraphic",
                icon: "resetGraphic",
                title: "Reset Graphic",
                description:
                  "Discard the colors and style changes made to the graphic.",
                enabled,
                run: () => resetGraphic(),
              },
              {
                type: "large",
                id: "smartart-convert",
                label: "Convert",
                icon: "convertToShapes",
                title: "Convert",
                description:
                  "Turn the graphic into bulleted text or into ordinary shapes.",
                enabled,
                menu: () => [
                  {
                    label: "Convert to Text",
                    icon: "o:convertToText",
                    onSelect: () => convertToText(),
                  },
                  {
                    label: "Convert to Shapes",
                    icon: "o:convertToShapes",
                    onSelect: () => convertToShapes(),
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  return {
    isSmartArt,
    insert,
    openPane,
    tabs,
    inspector,
    formatTitle,
    canConvert: () => !!convertibleText() && !h.readOnly(),
    convertMenu,
    sync: () => pane?.sync(),
    closePane: () => pane?.close(),
  };
}
