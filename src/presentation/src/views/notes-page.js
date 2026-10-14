// Notes Page view: each slide on a page of the deck's notes size, the slide
// above and its speaker notes below, as the notes would print. The notes
// are edited on the page; Page Up and Page Down go from page to page.
import { el } from "../ui.js";

const EMU_PER_INCH = 914400;
const PX_PER_INCH = 96;
// Where the slide and the notes sit on the page, as fractions of it.
const SLIDE_BOX = { left: 0.125, top: 0.075, width: 0.75, height: 0.375 };
const NOTES_BOX = { left: 0.1, top: 0.475, width: 0.8, height: 0.42 };
const NOTES_POINTS = 12;

export function createNotesPage(ctx) {
  const { P } = ctx;
  let host = null;
  let scroller = null;
  let zoom = "fit";
  const timers = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) paint(entry.target);
    },
    { rootMargin: "300px" },
  );
  const pres = () => ctx.doc().pres;
  const slides = () => P.getSlides(pres());
  const pageSize = () => {
    try {
      return P.getNotesPageSize(pres());
    } catch {
      return { width: 6858000, height: 9144000 };
    }
  };

  function paint(img) {
    const s = slides().find(
      (x) => P.getSlidePartName(x) === img.closest(".notes-page")?.dataset.part,
    );
    if (!s) return;
    const src = ctx.thumbnail(s);
    if (img.getAttribute("src") !== src) img.src = src;
  }

  // The page's width on screen: at 100% an inch of page is 96 pixels;
  // "fit" shows a whole page in the view.
  function pageWidth() {
    const size = pageSize();
    const inches = size.width / EMU_PER_INCH;
    if (zoom !== "fit") return Math.round(inches * PX_PER_INCH * zoom);
    const area = host?.getBoundingClientRect();
    if (!area?.width) return Math.round(inches * PX_PER_INCH);
    const pad = 48;
    return Math.max(
      120,
      Math.floor(
        Math.min(
          area.width - pad,
          ((area.height - pad) * size.width) / size.height,
        ),
      ),
    );
  }
  function factor() {
    const inches = pageSize().width / EMU_PER_INCH;
    return pageWidth() / (inches * PX_PER_INCH);
  }
  function layout() {
    if (!scroller) return;
    const size = pageSize();
    const width = pageWidth();
    scroller.style.setProperty("--notes-page-width", `${width}px`);
    scroller.style.setProperty(
      "--notes-page-height",
      `${Math.round((width * size.height) / size.width)}px`,
    );
    // The notes' text keeps its size relative to the page.
    scroller.style.setProperty(
      "--notes-font",
      `${((NOTES_POINTS / 72) * PX_PER_INCH * width) / ((size.width / EMU_PER_INCH) * PX_PER_INCH)}px`,
    );
    const slide = ctx.currentSize();
    // The slide keeps its own proportions inside its box on the page.
    const box = SLIDE_BOX.width * size.width;
    const boxHeight = SLIDE_BOX.height * size.height;
    const scale = Math.min(box / slide.cx, boxHeight / slide.cy);
    const w = (slide.cx * scale) / size.width;
    const h = (slide.cy * scale) / size.height;
    scroller.style.setProperty("--notes-slide-left", `${(1 - w) * 50}%`);
    scroller.style.setProperty("--notes-slide-top", `${SLIDE_BOX.top * 100}%`);
    scroller.style.setProperty("--notes-slide-width", `${w * 100}%`);
    scroller.style.setProperty("--notes-slide-height", `${h * 100}%`);
    ctx.zoomChanged();
  }

  function enter() {
    const stored = ctx.settings().notesZoom;
    zoom = stored === "fit" || !(Number(stored) > 0) ? "fit" : Number(stored);
    host = document.querySelector("#view-host");
    host.className = "view-host notes-view";
    scroller = el("div", {
      class: "notes-pages",
      role: "region",
      "aria-label": "Notes Page",
      onkeydown: keydown,
      onwheel: (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        ctx.stepZoom(e.deltaY < 0 ? 1 : -1);
      },
    });
    scroller.style.setProperty(
      "--notes-box",
      `${NOTES_BOX.left * 100}% ${NOTES_BOX.top * 100}% ${NOTES_BOX.width * 100}% ${NOTES_BOX.height * 100}%`,
    );
    host.replaceChildren(scroller);
    resize.observe(host);
    layout();
    refresh();
    scrollToCurrent();
  }
  const resize = new ResizeObserver(() => {
    if (zoom === "fit") layout();
  });
  function leave() {
    for (const [, t] of timers) clearTimeout(t.timer);
    flushAll();
    resize.disconnect();
    observer.disconnect();
    host?.replaceChildren();
    scroller = null;
  }
  function scrollToCurrent() {
    const part = P.getSlidePartName(ctx.currentSlide());
    const page = scroller?.querySelector(
      `.notes-page[data-part="${CSS.escape(part)}"]`,
    );
    page?.scrollIntoView({ block: "start" });
  }

  function refresh() {
    if (!scroller) return;
    const all = slides();
    const pages = new Map(
      [...scroller.querySelectorAll(".notes-page")].map((p) => [
        p.dataset.part,
        p,
      ]),
    );
    const current = P.getSlidePartName(ctx.currentSlide());
    all.forEach((s, i) => {
      const part = P.getSlidePartName(s);
      let page = pages.get(part);
      pages.delete(part);
      if (!page) page = makePage(part);
      page.classList.toggle("current", part === current);
      page.setAttribute("aria-label", `Notes page ${i + 1}`);
      page.querySelector(".notes-page-number").textContent = String(i + 1);
      const img = page.querySelector("img");
      img.alt = ctx.slideLabel(s, i);
      if (img.getAttribute("src")) paint(img);
      const text = page.querySelector("textarea");
      text.setAttribute("aria-label", `Notes for slide ${i + 1}`);
      const notes = P.getSlideNotes(s) || "";
      // Text being typed stays as typed until it is saved.
      if (document.activeElement !== text && !timers.has(part))
        text.value = notes;
      if (scroller.children[i] !== page)
        scroller.insertBefore(page, scroller.children[i] || null);
    });
    for (const page of pages.values()) page.remove();
  }
  function makePage(part) {
    const img = el("img", {
      class: "notes-page-slide",
      draggable: "false",
      alt: "",
    });
    const text = el("textarea", {
      class: "notes-page-text",
      placeholder: "Click to add notes",
      spellcheck: "true",
      oninput: () => schedule(part, text),
      onblur: () => flush(part),
      onfocus: () => choose(part),
    });
    const page = el(
      "article",
      { class: "notes-page", "data-part": part },
      img,
      text,
      el("span", { class: "notes-page-number", "aria-hidden": "true" }),
    );
    img.addEventListener("click", () => choose(part));
    img.addEventListener("dblclick", () =>
      ctx.choose(part, []).then(() => ctx.setView("normal")),
    );
    observer.observe(img);
    return page;
  }
  function choose(part) {
    if (P.getSlidePartName(ctx.currentSlide()) !== part) ctx.choose(part, []);
  }
  // Typing is saved after a pause and when the page loses the focus, as one
  // undo step per burst.
  function schedule(part, text) {
    clearTimeout(timers.get(part)?.timer);
    timers.set(part, {
      text,
      timer: setTimeout(() => flush(part), 600),
    });
  }
  function flush(part) {
    const pending = timers.get(part);
    if (!pending) return;
    clearTimeout(pending.timer);
    timers.delete(part);
    const value = pending.text.value;
    const s = slides().find((x) => P.getSlidePartName(x) === part);
    if (!s || (P.getSlideNotes(s) || "") === value) return;
    ctx.mutateSlide(s, (target) => P.setSlideNotes(target, value), {
      coalesce: `notes-page:${part}`,
    });
  }
  function flushAll() {
    for (const part of [...timers.keys()]) flush(part);
  }

  // Page Up and Page Down go from page to page, from the notes too.
  function keydown(e) {
    if (e.key !== "PageDown" && e.key !== "PageUp") return;
    e.preventDefault();
    const all = slides();
    const i = all.findIndex(
      (s) => P.getSlidePartName(s) === P.getSlidePartName(ctx.currentSlide()),
    );
    const next = all[i + (e.key === "PageDown" ? 1 : -1)];
    if (!next) return;
    const part = P.getSlidePartName(next);
    ctx.choose(part, []).then(() => {
      const page = scroller?.querySelector(
        `.notes-page[data-part="${CSS.escape(part)}"]`,
      );
      page?.scrollIntoView({ block: "start" });
      page?.querySelector("textarea")?.focus({ preventScroll: true });
    });
  }

  const zoomControl = {
    factor,
    isFit: () => zoom === "fit",
    setting: () => zoom,
    set(next) {
      zoom = next === "fit" ? "fit" : Math.min(4, Math.max(0.1, Number(next)));
      ctx.saveSettings({ notesZoom: zoom });
      layout();
    },
  };
  return { enter, leave, refresh, zoom: zoomControl, flush: flushAll };
}
