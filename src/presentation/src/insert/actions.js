// Action Buttons and Action Settings: what an object does in a slide show
// when it is clicked or pointed at — go to a slide or a web address, end the
// show, play a sound, and highlight as it is clicked.
import { el, dialog } from "../ui.js";
import {
  checkbox,
  fieldRow,
  fileBytes,
  pickFiles,
  SOUND_NAMES,
  synthesizeSound,
} from "./util.js";

export const ACTION_BUTTONS = [
  ["actionButtonBackPrevious", "Back or Previous", { kind: "prevSlide" }],
  ["actionButtonForwardNext", "Forward or Next", { kind: "nextSlide" }],
  ["actionButtonBeginning", "Beginning", { kind: "firstSlide" }],
  ["actionButtonEnd", "End", { kind: "lastSlide" }],
  ["actionButtonHome", "Home", { kind: "firstSlide" }],
  ["actionButtonInformation", "Information", { kind: "none" }],
  ["actionButtonReturn", "Return", { kind: "lastViewed" }],
  ["actionButtonMovie", "Video", { kind: "none" }],
  ["actionButtonDocument", "Document", { kind: "none" }],
  ["actionButtonSound", "Sound", { kind: "none" }, "Chime"],
  ["actionButtonHelp", "Help", { kind: "none" }],
  ["actionButtonBlank", "Custom", { kind: "none" }],
];

const JUMPS = [
  ["nextSlide", "Next Slide"],
  ["prevSlide", "Previous Slide"],
  ["firstSlide", "First Slide"],
  ["lastSlide", "Last Slide"],
  ["lastViewed", "Last Slide Viewed"],
  ["endShow", "End Show"],
  ["slide", "Slide…"],
  ["url", "URL…"],
];

// Simple line drawings of each button's mark for the gallery.
const GLYPHS = {
  actionButtonBackPrevious: "M14 4 6 10l8 6z",
  actionButtonForwardNext: "M6 4l8 6-8 6z",
  actionButtonBeginning: "M15 4 7 10l8 6zM5 4v12",
  actionButtonEnd: "M5 4l8 6-8 6zM15 4v12",
  actionButtonHome: "M4 10l6-6 6 6M6 9v7h8V9",
  actionButtonInformation: "M10 3.5a1 1 0 1 1 0 .1M9 7h2v9H9z",
  actionButtonReturn: "M14 6H8a3 3 0 0 0 0 6h6M11 9l3 3-3 3",
  actionButtonMovie: "M3 6h10v8H3zM13 9l4-2v6l-4-2",
  actionButtonDocument: "M5 3h7l3 3v11H5zM12 3v3h3",
  actionButtonSound: "M3 8h3l4-3v10l-4-3H3zM13 7a4 4 0 0 1 0 6",
  actionButtonHelp: "M7 7a3 3 0 1 1 4 2.8c-.7.4-1 .9-1 1.7v.5M10 15v.5",
  actionButtonBlank: "M4 4h12v12H4z",
};

export function actionGlyph(preset) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "shape-glyph action-glyph");
  const frame = document.createElementNS(svg.namespaceURI, "rect");
  Object.entries({ x: 1.5, y: 1.5, width: 17, height: 17, rx: 2 }).forEach(
    ([k, v]) => frame.setAttribute(k, v),
  );
  const mark = document.createElementNS(svg.namespaceURI, "path");
  mark.setAttribute("d", GLYPHS[preset] ?? GLYPHS.actionButtonBlank);
  svg.append(frame, mark);
  return svg;
}

export function createActionFeatures(ctx) {
  const { P } = ctx;

  /** Gallery rows for the Shapes menu and the Action Buttons menu. */
  function actionButtonsGallery() {
    const row = el("div", {
      class: "shape-gallery-row",
      role: "group",
      "aria-label": "Action Buttons",
    });
    for (const [preset, label] of ACTION_BUTTONS)
      row.append(
        el(
          "button",
          {
            type: "button",
            class: "shape-choice",
            role: "menuitem",
            tabindex: -1,
            "aria-label": `Action Button: ${label}`,
            title: `Action Button: ${label}`,
            "data-preset": preset,
            onclick: () => {
              ctx.closeMenu();
              ctx.startDrawing(preset);
            },
          },
          actionGlyph(preset),
        ),
      );
    return [{ header: "Action Buttons" }, { custom: row }];
  }

  const menuItems = () =>
    ACTION_BUTTONS.map(([preset, label]) => ({
      label,
      onSelect: () => ctx.startDrawing(preset),
    }));

  /** After an action button is drawn: its default action, and the dialog. */
  function afterDraw(obj, tool, at) {
    const entry = ACTION_BUTTONS.find(([preset]) => preset === tool);
    if (!entry) return;
    if (at?.click) {
      const b = P.getShapeBounds(obj);
      const edge = P.inches(0.75);
      P.setShapeBounds(obj, { x: b.x, y: b.y, w: edge, h: edge });
    }
    const [, label, jump, sound] = entry;
    P.setShapeActionSettings(obj, {
      click: {
        jump,
        sound: sound ? { name: sound, data: synthesizeSound(sound) } : null,
        highlight: true,
      },
      hover: null,
    });
    P.setShapeDescription(obj, `Action button: ${label}`);
    const id = P.getShapeId(obj);
    setTimeout(() => {
      const target = P.findShapeById(ctx.slide(), id);
      if (target) actionSettings(target).catch(ctx.fail);
    }, 0);
  }

  function panel(kind, initial) {
    const state = {
      jumpOn:
        !!initial &&
        initial.jump.kind !== "none" &&
        initial.jump.kind !== "other",
      jump:
        initial?.jump.kind && !["none", "other"].includes(initial.jump.kind)
          ? initial.jump.kind
          : "nextSlide",
      slidePart:
        initial?.jump.kind === "slide"
          ? P.getSlidePartName(initial.jump.slide)
          : null,
      url: initial?.jump.kind === "url" ? initial.jump.url : "https://",
      soundOn: !!initial?.sound,
      sound:
        initial?.sound === "stop"
          ? "__stop"
          : initial?.sound
            ? initial.sound.name
            : SOUND_NAMES[0],
      soundData:
        initial?.sound && initial.sound !== "stop" ? initial.sound.data : null,
      highlight: kind === "click" ? !!initial?.highlight : false,
      other: initial?.jump.kind === "other" ? initial.jump.action : null,
    };
    const name = `action-${kind}`;
    const slides = P.getSlides(ctx.pres());
    const jumpSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Hyperlink to",
        onchange: (e) => ((state.jump = e.target.value), sync()),
      },
      ...JUMPS.map(([v, label]) =>
        el("option", { value: v, selected: v === state.jump }, label),
      ),
    );
    const slideSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Slide",
        onchange: (e) => (state.slidePart = e.target.value),
      },
      ...slides.map((s, i) =>
        el(
          "option",
          {
            value: P.getSlidePartName(s),
            selected: P.getSlidePartName(s) === state.slidePart,
          },
          `${i + 1}. ${ctx.slideTitle(s) || "Untitled"}`,
        ),
      ),
    );
    if (!state.slidePart && slides[0])
      state.slidePart = P.getSlidePartName(slides[0]);
    const urlInput = el("input", {
      class: "input",
      type: "url",
      value: state.url,
      "aria-label": "Web address",
      oninput: (e) => (state.url = e.target.value),
    });
    const soundSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Sound",
        onchange: async (e) => {
          if (e.target.value === "__file") {
            const [file] = await pickFiles("audio/wav,.wav");
            if (file) {
              state.sound = file.name.replace(/\.wav$/i, "");
              state.soundData = await fileBytes(file);
              e.target.add(
                el("option", { value: state.sound }, state.sound),
                e.target.options.length - 1,
              );
              e.target.value = state.sound;
            } else e.target.value = state.sound;
            return;
          }
          state.sound = e.target.value;
          state.soundData = null;
        },
      },
      el(
        "option",
        { value: "__stop", selected: state.sound === "__stop" },
        "[Stop Previous Sound]",
      ),
      ...[
        ...new Set([...SOUND_NAMES, ...(state.soundData ? [state.sound] : [])]),
      ].map((n) => el("option", { value: n, selected: n === state.sound }, n)),
      el("option", { value: "__file" }, "Other Sound (WAV)…"),
    );
    const radio = (value, label, checked, disabled = false) =>
      el(
        "label",
        { class: `insert-radio ${disabled ? "disabled" : ""}` },
        el("input", {
          type: "radio",
          name,
          value,
          checked,
          disabled,
          onchange: () => {
            state.jumpOn = value === "jump";
            sync();
          },
        }),
        el("span", {}, label),
      );
    const slideRow = fieldRow("Slide", slideSelect);
    const urlRow = fieldRow("Address", urlInput);
    const sync = () => {
      jumpSelect.disabled = !state.jumpOn;
      slideRow.hidden = !state.jumpOn || state.jump !== "slide";
      urlRow.hidden = !state.jumpOn || state.jump !== "url";
      soundSelect.disabled = !state.soundOn;
    };
    const node = el(
      "div",
      { class: "action-panel", role: "tabpanel", id: `action-panel-${kind}` },
      el(
        "div",
        { role: "radiogroup", "aria-label": "Action", class: "action-choices" },
        radio("none", "None", !state.jumpOn && !state.other),
        radio("jump", "Hyperlink to:", state.jumpOn),
        el("div", { class: "hf-indent" }, jumpSelect, slideRow, urlRow),
        radio(
          "program",
          "Run program (not available in the browser)",
          false,
          true,
        ),
      ),
      state.other
        ? el(
            "p",
            { class: "action-note" },
            `This object has an action this app does not run (${state.other}). Choosing another replaces it.`,
          )
        : null,
      checkbox(
        "Play sound:",
        state.soundOn,
        (on) => ((state.soundOn = on), sync()),
      ),
      el("div", { class: "hf-indent" }, soundSelect),
      kind === "click"
        ? checkbox(
            "Highlight click",
            state.highlight,
            (on) => (state.highlight = on),
          )
        : null,
    );
    sync();
    const value = () => {
      if (!state.jumpOn && !state.soundOn && !state.highlight)
        return state.other
          ? {
              jump: { kind: "other", action: state.other },
              sound: null,
              highlight: false,
            }
          : null;
      let jump = { kind: "none" };
      if (state.jumpOn) {
        if (state.jump === "slide") {
          const s = P.getSlides(ctx.pres()).find(
            (x) => P.getSlidePartName(x) === state.slidePart,
          );
          jump = s ? { kind: "slide", slide: s } : { kind: "none" };
        } else if (state.jump === "url") {
          const url = ctx.normalizeUrl(state.url);
          if (!url)
            throw new Error(
              "Enter a web address starting with http:// or https://.",
            );
          jump = { kind: "url", url };
        } else jump = { kind: state.jump };
      } else if (state.other) jump = { kind: "other", action: state.other };
      const sound = !state.soundOn
        ? null
        : state.sound === "__stop"
          ? "stop"
          : {
              name: state.sound,
              data: state.soundData ?? synthesizeSound(state.sound),
            };
      return { jump, sound, highlight: state.highlight };
    };
    return { node, value };
  }

  async function actionSettings(obj = ctx.currentShape()) {
    if (!obj) return;
    const current = P.getShapeActionSettings(obj);
    // A media object's "play" click belongs to its playback settings.
    const click = panel(
      "click",
      current.click?.jump.action === "ppaction://media" ? null : current.click,
    );
    const hover = panel("hover", current.hover);
    hover.node.hidden = true;
    const ids = ["click", "hover"];
    // The tabs are one stop for Tab; the arrow keys move between them.
    const select = (id, focus = false) => {
      click.node.hidden = id !== "click";
      hover.node.hidden = id !== "hover";
      for (const other of ids) {
        const t = body.querySelector(`#action-tab-${other}`);
        t.setAttribute("aria-selected", String(other === id));
        t.tabIndex = other === id ? 0 : -1;
        if (other === id && focus) t.focus();
      }
    };
    const tab = (id, label, selected) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          class: "hf-tab",
          id: `action-tab-${id}`,
          "aria-controls": `action-panel-${id}`,
          "aria-selected": String(selected),
          tabindex: selected ? 0 : -1,
          onclick: () => select(id),
          onkeydown: (e) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            const at = ids.indexOf(id);
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? ids.length - 1
                  : step
                    ? (at + step + ids.length) % ids.length
                    : null;
            if (next === null) return;
            e.preventDefault();
            select(ids[next], true);
          },
        },
        label,
      );
    const body = el(
      "div",
      { class: "dialog-body action-dialog" },
      el(
        "div",
        { class: "hf-tabs", role: "tablist", "aria-label": "When" },
        tab("click", "Mouse Click", true),
        tab("hover", "Mouse Over", false),
      ),
      click.node,
      hover.node,
    );
    const ok = await dialog({ title: "Action Settings", body, confirm: "OK" });
    if (!ok) return;
    const settings = { click: click.value(), hover: hover.value() };
    await ctx.mutateShape(obj, (target, slide) => {
      P.setShapeActionSettings(target, settings);
      ctx.pruneMedia(slide);
    });
  }

  return {
    actionButtonsGallery,
    menuItems,
    afterDraw,
    actionSettings,
    ACTION_BUTTONS,
  };
}
