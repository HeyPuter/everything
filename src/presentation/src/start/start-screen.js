// The library screen's own pieces: the rail of sections down its side, the
// box that writes a presentation from a description, the strip of themes a
// new deck can start in, and what this device remembers about the
// presentations listed (which are pinned, and when each was last opened).
// main.js lays them out with the template cards and the list.
import "./start-screen.css";
import { el, icon, button } from "../ui.js";
import { lucide } from "../draw/draw-icons.js";
import { SLIDE_COUNTS, DEFAULT_SLIDE_COUNT } from "./deck-from-prompt.js";

export { libraryMeta, libraryKey } from "./library-meta.js";

/* ---------- The rail ---------- */

/**
 * The sections down the library's side. `sections` is [{ id, label, icon,
 * run, action? }], an action (such as Open) not being a place to show as
 * current; `current` is the one showing.
 */
export function homeRail(sections, current = "home") {
  return el(
    "nav",
    { class: "home-rail", "aria-label": "Library sections" },
    ...sections.map((s) =>
      el(
        "button",
        {
          type: "button",
          class: "home-rail-item",
          "data-section": s.id,
          "aria-current": s.id === current ? "page" : null,
          onclick: (e) => {
            // Open is an action; the others are places on the screen.
            if (!s.action)
              for (const b of e.currentTarget.parentElement.children)
                b.toggleAttribute("aria-current", b === e.currentTarget);
            if (!s.action) e.currentTarget.setAttribute("aria-current", "page");
            s.run();
          },
        },
        lucide(s.icon, 22),
        el("span", {}, s.label),
      ),
    ),
  );
}

/* ---------- Describe your presentation ---------- */

/**
 * The box that writes a deck from a description. `themes` is [{ key, name }];
 * `create(description, { slides, theme, signal, onProgress })` does the work
 * and resolves once the deck is open (or throws). `available()` says whether
 * the AI can be reached.
 */
export function promptBox({ themes, theme, create, available }) {
  const field = el("textarea", {
    class: "home-prompt-input",
    rows: 2,
    maxlength: 4000,
    placeholder:
      "Describe your presentation: what it is about, who it is for, and anything it must cover",
    "aria-label": "Describe your presentation",
  });
  const slides = el(
    "select",
    { class: "home-prompt-select", "aria-label": "Number of slides" },
    ...SLIDE_COUNTS.map((n) =>
      el(
        "option",
        { value: String(n), selected: n === DEFAULT_SLIDE_COUNT },
        `${n} slides`,
      ),
    ),
  );
  const palette = el(
    "select",
    { class: "home-prompt-select", "aria-label": "Theme" },
    ...themes.map((t) =>
      el("option", { value: t.key, selected: t.key === theme }, t.name),
    ),
  );
  const status = el("p", {
    class: "home-prompt-status",
    role: "status",
    "aria-live": "polite",
  });
  let controller = null;
  const go = button(
    "Create",
    "Sparkles",
    () => run(),
    "primary home-prompt-go",
  );
  const stop = button("Stop", null, () => controller?.abort(), "secondary", {
    hidden: true,
  });
  function busy(on) {
    box.classList.toggle("busy", on);
    field.readOnly = on;
    slides.disabled = palette.disabled = on;
    go.hidden = on;
    stop.hidden = !on;
  }
  async function run() {
    const description = field.value.trim();
    if (!description) {
      status.textContent = "Describe the presentation you want first.";
      field.focus();
      return;
    }
    if (!available()) {
      status.textContent =
        "The AI service is not available. Check your connection and reload.";
      return;
    }
    controller = new AbortController();
    busy(true);
    const count = Number(slides.value);
    status.textContent = "Writing your outline…";
    try {
      await create(description, {
        slides: count,
        theme: palette.value,
        signal: controller.signal,
        onProgress: ({ slides: done }) => {
          status.textContent = `Writing slide ${Math.min(done + 1, count + 1)} of ${count + 1}…`;
        },
      });
      if (box.isConnected) status.textContent = "";
    } catch (e) {
      status.textContent = e?.stopped
        ? "Stopped."
        : e?.message || "The presentation could not be written. Try again.";
    } finally {
      controller = null;
      if (box.isConnected) busy(false);
    }
  }
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  });
  const box = el(
    "form",
    {
      class: "home-prompt",
      "aria-label": "Write a presentation with AI",
      onsubmit: (e) => {
        e.preventDefault();
        run();
      },
    },
    el(
      "label",
      { class: "home-prompt-label" },
      lucide("Sparkles", 16),
      "Describe your presentation",
    ),
    field,
    el(
      "div",
      { class: "home-prompt-bar" },
      slides,
      palette,
      el("span", { class: "home-prompt-spacer" }),
      stop,
      go,
    ),
    status,
  );
  return box;
}

/* ---------- Themes ---------- */

/**
 * A strip of themes a new deck can start in: [{ key, name, preview }], the
 * preview a picture of a title slide in it. `pick(key)` starts the deck.
 */
export function themeStrip(themes, pick) {
  return el(
    "section",
    { class: "home-themes", "aria-label": "Start in a theme" },
    el("h2", { class: "home-themes-title" }, "Themes"),
    el(
      "div",
      { class: "home-themes-row", role: "list" },
      ...themes.map((t) =>
        el(
          "button",
          {
            type: "button",
            class: "home-theme",
            role: "listitem",
            "data-theme-key": t.key,
            "aria-label": `New presentation in the ${t.name} theme`,
            onclick: () => pick(t.key),
          },
          el(
            "span",
            { class: "home-theme-preview" },
            t.preview
              ? el("img", {
                  src: t.preview,
                  alt: "",
                  loading: "lazy",
                  draggable: "false",
                })
              : icon("Palette", 24),
          ),
          el("span", { class: "home-theme-name" }, t.name),
        ),
      ),
    ),
  );
}

/** The "Recent" and "Pinned" switch over the list. */
export function libraryFilter(current, choose) {
  const make = (id, label) =>
    el(
      "button",
      {
        type: "button",
        class: "library-filter-btn",
        "aria-pressed": String(current === id),
        "data-filter": id,
        onclick: () => choose(id),
      },
      label,
    );
  return el(
    "div",
    { class: "library-filter", role: "group", "aria-label": "Show" },
    make("recent", "Recent"),
    make("pinned", "Pinned"),
  );
}

export { lucide };
