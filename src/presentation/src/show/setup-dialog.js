// The Set Up Slide Show dialog: how the show runs (presented by a speaker,
// browsed in a window, or at a kiosk), its options, which slides it shows
// and how it advances. Saved in the file's show properties.
import "../export/export.css";
import { el } from "../ui.js";
import {
  openModal,
  radioGroup,
  checkField,
  selectField,
  nextId,
} from "../export/modal.js";
import { showPrefs } from "./prefs.js";

function colorField(label, value) {
  const id = nextId("show-color");
  const input = el("input", {
    type: "color",
    id,
    class: "show-color-input",
    value: value || "#FF0000",
  });
  return {
    wrap: el(
      "div",
      { class: "file-field show-color-field" },
      el("label", { for: id }, label),
      input,
    ),
    input,
  };
}

/**
 * ctx: { P, pres(), mutate(fn), customShows() }
 * Resolves true when the setup was saved.
 */
export function openSetUpShowDialog(ctx) {
  const { P } = ctx;
  const pres = ctx.pres();
  const setup = P.getSlideShowSetup(pres);
  const count = P.getSlides(pres).length;
  const shows = ctx.customShows();

  const type = radioGroup(
    "Show type",
    nextId("show-type"),
    [
      ["present", "Presented by a speaker (full screen)"],
      ["browse", "Browsed by an individual (window)"],
      ["kiosk", "Browsed at a kiosk (full screen)"],
    ],
    setup.showType,
  );
  const scrollbar = checkField("Show scrollbar", setup.showScrollbar);
  scrollbar.wrap.classList.add("show-setup-indent");

  const loop = checkField(
    "Loop continuously until Esc",
    setup.loop || setup.showType === "kiosk",
  );
  const noNarration = checkField(
    "Show without narration",
    !setup.showNarration,
  );
  const noAnimation = checkField(
    "Show without animation",
    !setup.showAnimation,
  );
  const mediaControls = checkField(
    "Show media controls",
    setup.showMediaControls,
  );
  const pen = colorField("Pen color", setup.penColor || "#E81224");
  const laser = colorField(
    "Laser pointer color",
    setup.laserColor || "#FF0000",
  );

  const sel = setup.selection;
  const fromInput = el("input", {
    type: "number",
    class: "input show-setup-number",
    min: 1,
    max: count,
    value: sel.kind === "range" ? sel.start : 1,
    "aria-label": "From slide",
  });
  const toInput = el("input", {
    type: "number",
    class: "input show-setup-number",
    min: 1,
    max: count,
    value: sel.kind === "range" ? Math.min(sel.end, count) : count,
    "aria-label": "To slide",
  });
  const customSelect = selectField(
    "Custom show",
    shows.length
      ? shows.map((s) => [String(s.id), s.name || `Custom show ${s.id + 1}`])
      : [["", "No custom shows", true]],
    sel.kind === "custom" ? String(sel.id) : String(shows[0]?.id ?? ""),
    { "aria-label": "Custom show" },
  );
  customSelect.wrap.querySelector("label").hidden = true;
  const slides = radioGroup(
    "Show slides",
    nextId("show-slides"),
    [
      ["all", "All"],
      [
        "range",
        "From",
        el(
          "span",
          { class: "show-setup-range" },
          fromInput,
          el("span", {}, "to"),
          toInput,
        ),
      ],
      ...(shows.length ? [["custom", "Custom show", customSelect.wrap]] : []),
    ],
    sel.kind === "custom" && !shows.length ? "all" : sel.kind,
  );
  const advance = radioGroup(
    "Advance slides",
    nextId("show-advance"),
    [
      ["manual", "Manually"],
      ["timings", "Using timings, if present"],
    ],
    setup.useTimings ? "timings" : "manual",
  );
  const presenter = checkField(
    "Use Presenter View when there is a second screen",
    !!showPrefs.usePresenterView,
  );

  function sync() {
    const kind = type.value();
    scrollbar.input.disabled = kind !== "browse";
    // A kiosk loops and advances by itself.
    loop.input.disabled = kind === "kiosk";
    if (kind === "kiosk") {
      loop.input.checked = true;
      advance.set("timings");
    }
    advance.inputs.forEach((i) => (i.disabled = kind === "kiosk"));
    const which = slides.value();
    fromInput.disabled = toInput.disabled = which !== "range";
    customSelect.input.disabled = which !== "custom";
  }
  [...type.inputs, ...slides.inputs].forEach((i) =>
    i.addEventListener("change", sync),
  );
  // Typing in the range picks it.
  for (const input of [fromInput, toInput])
    input.addEventListener("focus", () => {
      slides.set("range");
      sync();
    });
  sync();

  const error = el("p", {
    class: "show-setup-error",
    role: "alert",
    hidden: true,
  });
  const body = el(
    "div",
    { class: "dialog-body show-setup" },
    el(
      "div",
      { class: "show-setup-columns" },
      el(
        "div",
        {},
        type.wrap,
        scrollbar.wrap,
        el(
          "fieldset",
          { class: "file-radios" },
          el("legend", {}, "Show options"),
          loop.wrap,
          noNarration.wrap,
          noAnimation.wrap,
          mediaControls.wrap,
          pen.wrap,
          laser.wrap,
        ),
      ),
      el(
        "div",
        {},
        slides.wrap,
        advance.wrap,
        el(
          "fieldset",
          { class: "file-radios" },
          el("legend", {}, "Multiple screens"),
          presenter.wrap,
        ),
      ),
    ),
    error,
  );

  return new Promise((resolve) => {
    let saved = false;
    const modal = openModal({
      title: "Set Up Slide Show",
      className: "show-setup-dialog",
      body,
      onClose: () => resolve(saved),
      actions: [
        { label: "Cancel", kind: "secondary", onClick: () => true },
        {
          label: "OK",
          kind: "primary",
          onClick: async () => {
            const which = slides.value();
            let selection = { kind: "all" };
            if (which === "range") {
              const start = Math.round(Number(fromInput.value));
              const end = Math.round(Number(toInput.value));
              if (!(start >= 1 && end >= start && end <= count)) {
                error.textContent = `Enter slide numbers from 1 to ${count}, the first no larger than the last.`;
                error.hidden = false;
                fromInput.focus();
                return false;
              }
              selection = { kind: "range", start, end };
            } else if (which === "custom" && customSelect.input.value !== "")
              selection = {
                kind: "custom",
                id: Number(customSelect.input.value),
              };
            const kind = type.value();
            const patch = {
              showType: kind,
              showScrollbar: scrollbar.input.checked,
              loop: kind === "kiosk" || loop.input.checked,
              showNarration: !noNarration.input.checked,
              showAnimation: !noAnimation.input.checked,
              showMediaControls: mediaControls.input.checked,
              useTimings: kind === "kiosk" || advance.value() === "timings",
              penColor: pen.input.value.toUpperCase(),
              laserColor: laser.input.value.toUpperCase(),
              selection,
            };
            showPrefs.usePresenterView = presenter.input.checked;
            saved = await ctx.mutate(() =>
              P.setSlideShowSetup(ctx.pres(), patch),
            );
            return true;
          },
        },
      ],
    });
    modal.dialog
      .querySelector(`input[name="${type.inputs[0].name}"]:checked`)
      ?.focus();
  });
}
