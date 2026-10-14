// Header & Footer: the date, slide number and footer text shown at the foot
// of slides, and the header, footer, date and page number of notes pages
// and handouts.
import { el, dialog } from "../ui.js";
import { checkbox } from "./util.js";

export const DATE_FORMATS = Array.from(
  { length: 13 },
  (_, i) => `datetime${i + 1}`,
);

export function createHeaderFooter(ctx) {
  const { P } = ctx;

  const formatLabel = (format) => {
    try {
      return (
        P.formatDateTimeField(format, new Date(), {
          language: ctx.language(),
        }) ?? format
      );
    } catch {
      return format;
    }
  };

  function dateControls(initial, onChange) {
    let mode = initial?.mode ?? "auto";
    let format = initial?.mode === "auto" ? initial.format : "datetime1";
    let fixed =
      initial?.mode === "fixed" ? initial.text : formatLabel("datetime1");
    const select = el(
      "select",
      {
        class: "input",
        "aria-label": "Date format",
        onchange: (e) => ((format = e.target.value), emit()),
      },
      ...DATE_FORMATS.map((f) =>
        el("option", { value: f, selected: f === format }, formatLabel(f)),
      ),
    );
    const text = el("input", {
      class: "input",
      value: fixed,
      "aria-label": "Fixed date",
      oninput: (e) => ((fixed = e.target.value), emit()),
    });
    let enabled = true;
    const sync = () => {
      select.disabled = !enabled || mode !== "auto";
      text.disabled = !enabled || mode !== "fixed";
      node
        ?.querySelectorAll("input[type=radio]")
        .forEach((r) => (r.disabled = !enabled));
    };
    const emit = () => {
      sync();
      onChange(mode === "auto" ? { mode, format } : { mode, text: fixed });
    };
    const name = `hf-date-${Math.random().toString(36).slice(2)}`;
    const radio = (value, label) =>
      el(
        "label",
        { class: "insert-radio" },
        el("input", {
          type: "radio",
          name,
          value,
          checked: mode === value,
          onchange: () => ((mode = value), emit()),
        }),
        el("span", {}, label),
      );
    let node = null;
    node = el(
      "div",
      { class: "hf-date", role: "radiogroup", "aria-label": "Date and time" },
      radio("auto", "Update automatically"),
      select,
      radio("fixed", "Fixed"),
      text,
    );
    sync();
    return {
      node,
      setEnabled: (on) => {
        enabled = on;
        sync();
      },
      value: () => (mode === "auto" ? { mode, format } : { mode, text: fixed }),
    };
  }

  function preview(state) {
    const box = (cls, on) =>
      el("span", { class: `hf-preview-${cls} ${on ? "on" : ""}` });
    return el(
      "div",
      { class: "hf-preview", "aria-hidden": "true" },
      box("dt", state.dateOn),
      box("ftr", state.footerOn),
      box("num", state.numberOn),
    );
  }

  async function headerFooter() {
    ctx.commitText();
    const pres = ctx.pres();
    const slide = ctx.slide();
    const current = P.getSlideHeaderFooter(slide);
    const slides = P.getSlides(pres);
    const titleSlides = slides.filter((s) => P.isTitleSlide(s));
    const others = slides.filter((s) => !P.isTitleSlide(s));
    const shownOn = (s) => {
      const hf = P.getSlideHeaderFooter(s);
      return !!(hf.date || hf.footer !== null || hf.slideNumber);
    };
    const s = {
      dateOn: !!current.date,
      date: current.date,
      numberOn: current.slideNumber,
      footerOn: current.footer !== null,
      footer: current.footer ?? "",
      hideOnTitle:
        titleSlides.length > 0 &&
        others.some(shownOn) &&
        !titleSlides.some(shownOn),
    };
    const notes = P.getNotesHeaderFooter(pres);
    const n = {
      dateOn: !!notes.date,
      date: notes.date,
      headerOn: notes.header !== null,
      header: notes.header ?? "",
      numberOn: notes.pageNumber,
      footerOn: notes.footer !== null,
      footer: notes.footer ?? "",
    };
    const slidePreview = el("div");
    const refresh = () => slidePreview.replaceChildren(preview(s));
    const slideDate = dateControls(s.date, (v) => (s.date = v));
    const notesDate = dateControls(n.date, (v) => (n.date = v));
    slideDate.setEnabled(s.dateOn);
    notesDate.setEnabled(n.dateOn);
    const footerInput = el("input", {
      class: "input",
      value: s.footer,
      "aria-label": "Footer text",
      oninput: (e) => (s.footer = e.target.value),
    });
    const notesHeader = el("input", {
      class: "input",
      value: n.header,
      "aria-label": "Header text",
      oninput: (e) => (n.header = e.target.value),
    });
    const notesFooter = el("input", {
      class: "input",
      value: n.footer,
      "aria-label": "Notes footer text",
      oninput: (e) => (n.footer = e.target.value),
    });
    const slidePanel = el(
      "div",
      {
        class: "hf-panel",
        role: "tabpanel",
        id: "hf-slide",
        "aria-labelledby": "hf-tab-slide",
      },
      el(
        "div",
        { class: "hf-columns" },
        el(
          "fieldset",
          { class: "hf-fields" },
          el("legend", {}, "Include on slide"),
          checkbox("Date and time", s.dateOn, (on) => {
            s.dateOn = on;
            slideDate.setEnabled(on);
            refresh();
          }),
          el("div", { class: "hf-indent" }, slideDate.node),
          checkbox(
            "Slide number",
            s.numberOn,
            (on) => ((s.numberOn = on), refresh()),
          ),
          checkbox(
            "Footer",
            s.footerOn,
            (on) => ((s.footerOn = on), refresh()),
          ),
          el("div", { class: "hf-indent" }, footerInput),
          checkbox(
            "Don't show on title slide",
            s.hideOnTitle,
            (on) => (s.hideOnTitle = on),
          ),
        ),
        el(
          "div",
          { class: "hf-side" },
          el("span", { class: "hf-caption" }, "Preview"),
          slidePreview,
        ),
      ),
    );
    const notesPanel = el(
      "div",
      {
        class: "hf-panel",
        role: "tabpanel",
        id: "hf-notes",
        "aria-labelledby": "hf-tab-notes",
        hidden: true,
      },
      el(
        "fieldset",
        { class: "hf-fields" },
        el("legend", {}, "Include on notes pages and handouts"),
        checkbox("Date and time", n.dateOn, (on) => {
          n.dateOn = on;
          notesDate.setEnabled(on);
        }),
        el("div", { class: "hf-indent" }, notesDate.node),
        checkbox("Header", n.headerOn, (on) => (n.headerOn = on)),
        el("div", { class: "hf-indent" }, notesHeader),
        checkbox("Page number", n.numberOn, (on) => (n.numberOn = on)),
        checkbox("Footer", n.footerOn, (on) => (n.footerOn = on)),
        el("div", { class: "hf-indent" }, notesFooter),
      ),
    );
    let tab = "slide";
    const tabButton = (id, label) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          id: `hf-tab-${id}`,
          class: "hf-tab",
          "aria-controls": `hf-${id}`,
          "aria-selected": String(id === tab),
          onclick: () => {
            tab = id;
            slidePanel.hidden = id !== "slide";
            notesPanel.hidden = id !== "notes";
            tabs
              .querySelectorAll(".hf-tab")
              .forEach((t) =>
                t.setAttribute(
                  "aria-selected",
                  String(t.id === `hf-tab-${id}`),
                ),
              );
          },
        },
        label,
      );
    const tabs = el(
      "div",
      { class: "hf-tabs", role: "tablist", "aria-label": "Header and footer" },
      tabButton("slide", "Slide"),
      tabButton("notes", "Notes and Handouts"),
    );
    refresh();
    const body = el(
      "div",
      { class: "dialog-body hf-dialog" },
      tabs,
      slidePanel,
      notesPanel,
    );
    const choice = await dialog({
      title: "Header and Footer",
      body,
      actions: [
        { label: "Cancel", value: null },
        { label: "Apply", value: "apply" },
        { label: "Apply to All", value: "all", kind: "primary" },
      ],
    });
    if (!choice) return;
    const settings = {
      date: s.dateOn ? slideDate.value() : null,
      slideNumber: s.numberOn,
      footer: s.footerOn ? s.footer : null,
    };
    const notesSettings = {
      date: n.dateOn ? notesDate.value() : null,
      header: n.headerOn ? n.header : null,
      footer: n.footerOn ? n.footer : null,
      pageNumber: n.numberOn,
    };
    const targets = choice === "all" ? null : new Set(ctx.selectedSlideParts());
    const language = ctx.language();
    await ctx.mutate(() => {
      const all = P.getSlides(ctx.pres());
      all.forEach((target, i) => {
        if (
          tab === "slide" &&
          targets &&
          !targets.has(P.getSlidePartName(target))
        )
          return;
        if (tab === "notes") return;
        const off = s.hideOnTitle && P.isTitleSlide(target);
        P.applySlideHeaderFooter(
          target,
          off
            ? { date: null, slideNumber: false, footer: null }
            : {
                ...settings,
                date:
                  settings.date?.mode === "auto"
                    ? { ...settings.date, lang: language }
                    : settings.date,
              },
          i + 1,
        );
      });
      if (tab === "notes" || choice === "all")
        P.setNotesHeaderFooter(ctx.pres(), notesSettings);
    });
  }

  return { headerFooter };
}
