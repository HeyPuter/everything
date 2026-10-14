// Custom shows: named selections of the deck's slides, in any order, to
// present to different audiences from one file. The Custom Shows dialog
// lists them (new, edit, copy, remove, show); the Define Custom Show dialog
// picks and orders the slides. Saved in the file's custom show list.
import "../export/export.css";
import { el } from "../ui.js";
import { openModal, nextId } from "../export/modal.js";
import { lineButton } from "./icons.js";

const part = (P, s) => P.getSlidePartName(s);

/**
 * ctx: { P, pres(), mutate(fn), picture(slide), title(slide),
 *        play(id) }
 */
export function openCustomShowsDialog(ctx) {
  const { P } = ctx;
  const listId = nextId("custom-shows");
  const list = el("select", {
    class: "input show-custom-list",
    id: listId,
    size: 8,
    "aria-label": "Custom shows",
  });
  const empty = el(
    "p",
    { class: "show-custom-empty" },
    "There are no custom shows yet. Choose New to make one.",
  );
  const shows = () => P.getCustomShows(ctx.pres());
  function fill(selectId = null) {
    const all = shows();
    list.replaceChildren(
      ...all.map((s) =>
        el(
          "option",
          { value: String(s.id) },
          `${s.name || "Untitled"} (${s.slides.length} slide${s.slides.length === 1 ? "" : "s"})`,
        ),
      ),
    );
    empty.hidden = all.length > 0;
    list.hidden = !all.length;
    if (selectId !== null) list.value = String(selectId);
    if (list.selectedIndex < 0 && all.length) list.selectedIndex = 0;
    sync();
  }
  const selected = () =>
    shows().find((s) => String(s.id) === list.value) || null;
  const write = (next) =>
    ctx.mutate(() =>
      P.setCustomShows(
        ctx.pres(),
        next.map((s) => ({
          id: s.id,
          name: s.name,
          slides: resolve(s.slides),
        })),
      ),
    );
  // Slides from an earlier read, matched by part in the current deck.
  const resolve = (slides) => {
    const byPart = new Map(P.getSlides(ctx.pres()).map((s) => [part(P, s), s]));
    return slides.map((s) => byPart.get(part(P, s))).filter(Boolean);
  };
  const uniqueName = (base) => {
    const names = new Set(shows().map((s) => s.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++)
      if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  };
  const buttons = {
    new: el(
      "button",
      { type: "button", class: "btn secondary", onclick: () => edit(null) },
      "New…",
    ),
    edit: el(
      "button",
      {
        type: "button",
        class: "btn secondary",
        onclick: () => edit(selected()),
      },
      "Edit…",
    ),
    copy: el(
      "button",
      {
        type: "button",
        class: "btn secondary",
        onclick: async () => {
          const s = selected();
          if (!s) return;
          const all = shows();
          await write([
            ...all,
            { name: uniqueName(`Copy of ${s.name}`), slides: s.slides },
          ]);
          fill(shows().at(-1)?.id ?? null);
        },
      },
      "Copy",
    ),
    remove: el(
      "button",
      {
        type: "button",
        class: "btn secondary",
        onclick: async () => {
          const s = selected();
          if (!s) return;
          await write(shows().filter((x) => x.id !== s.id));
          fill();
        },
      },
      "Remove",
    ),
    show: el(
      "button",
      {
        type: "button",
        class: "btn primary",
        onclick: () => {
          const s = selected();
          if (!s) return;
          modal.close(null);
          ctx.play(s.id);
        },
      },
      "Show",
    ),
  };
  function sync() {
    const has = !!selected();
    for (const key of ["edit", "copy", "remove", "show"])
      buttons[key].disabled = !has;
  }
  list.addEventListener("change", sync);
  list.addEventListener("dblclick", () => selected() && edit(selected()));
  list.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") buttons.remove.click();
  });
  async function edit(show) {
    const result = await defineCustomShow(ctx, show, uniqueName);
    if (!result) return;
    const all = shows();
    if (show)
      await write(all.map((s) => (s.id === show.id ? { ...s, ...result } : s)));
    else await write([...all, result]);
    fill(show ? show.id : (shows().at(-1)?.id ?? null));
    list.focus();
  }
  const body = el(
    "div",
    { class: "dialog-body show-custom" },
    el("label", { for: listId, class: "show-custom-label" }, "Custom shows"),
    el(
      "div",
      { class: "show-custom-row" },
      el("div", { class: "show-custom-main" }, list, empty),
      el(
        "div",
        { class: "show-custom-buttons" },
        buttons.new,
        buttons.edit,
        buttons.copy,
        buttons.remove,
      ),
    ),
  );
  const modal = openModal({
    title: "Custom Shows",
    className: "show-custom-dialog",
    body,
    actions: [{ label: "Close", kind: "secondary", onClick: () => true }],
  });
  modal.dialog.querySelector(".dialog-actions").prepend(buttons.show);
  fill();
  (shows().length ? list : buttons.new).focus();
  return modal;
}

/** Picks and orders the slides of one custom show. Resolves
 * { name, slides } or null. */
export function defineCustomShow(ctx, show, uniqueName = (n) => n) {
  const { P } = ctx;
  const deck = P.getSlides(ctx.pres());
  const byPart = new Map(deck.map((s) => [part(P, s), s]));
  let chosen = (show?.slides || [])
    .map((s) => byPart.get(part(P, s)))
    .filter(Boolean);
  const nameId = nextId("custom-name");
  const name = el("input", {
    class: "input",
    id: nameId,
    value: show?.name || uniqueName("Custom Show"),
    maxlength: 120,
  });
  const label = (s) => {
    const i = deck.indexOf(s);
    const title = ctx.title(s);
    return `${i + 1}. ${title || "Untitled slide"}`;
  };
  const deckList = el("ul", {
    class: "show-custom-pick",
    role: "group",
    "aria-label": "Slides in presentation",
  });
  const boxes = deck.map((s) => {
    const input = el("input", { type: "checkbox", "aria-label": label(s) });
    deckList.append(
      el(
        "li",
        {},
        el(
          "label",
          { class: "show-custom-slide" },
          input,
          el("img", { src: ctx.picture(s), alt: "", loading: "lazy" }),
          el("span", {}, label(s)),
        ),
      ),
    );
    return input;
  });
  const showList = el("ol", {
    class: "show-custom-order",
    role: "listbox",
    "aria-label": "Slides in custom show",
    tabindex: 0,
  });
  let active = 0;
  function render() {
    showList.replaceChildren(
      ...chosen.map((s, i) =>
        el(
          "li",
          {
            role: "option",
            id: `${nameId}-o${i}`,
            "aria-selected": String(i === active),
            class: i === active ? "active" : "",
            onclick: () => {
              active = i;
              render();
            },
          },
          el("img", { src: ctx.picture(s), alt: "" }),
          el("span", {}, label(s)),
        ),
      ),
    );
    if (chosen.length)
      showList.setAttribute("aria-activedescendant", `${nameId}-o${active}`);
    else showList.removeAttribute("aria-activedescendant");
    up.disabled = active <= 0;
    down.disabled = active >= chosen.length - 1;
    remove.disabled = !chosen.length;
    ok.disabled = !chosen.length || !name.value.trim();
  }
  const add = el(
    "button",
    {
      type: "button",
      class: "btn secondary show-custom-add",
      onclick: () => {
        const picks = deck.filter((_, i) => boxes[i].checked);
        if (!picks.length) return;
        chosen.push(...picks);
        boxes.forEach((b) => (b.checked = false));
        active = chosen.length - 1;
        render();
      },
    },
    "Add »",
  );
  const move = (by) => {
    const to = active + by;
    if (to < 0 || to >= chosen.length) return;
    [chosen[active], chosen[to]] = [chosen[to], chosen[active]];
    active = to;
    render();
  };
  const up = lineButton("Move slide up", "ChevronUp", () => move(-1));
  const down = lineButton("Move slide down", "ChevronDown", () => move(1));
  const remove = lineButton("Remove slide from the custom show", "X", () => {
    chosen.splice(active, 1);
    active = Math.max(0, Math.min(active, chosen.length - 1));
    render();
  });
  showList.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.altKey) move(e.key === "ArrowDown" ? 1 : -1);
      else {
        active = Math.max(
          0,
          Math.min(
            chosen.length - 1,
            active + (e.key === "ArrowDown" ? 1 : -1),
          ),
        );
        render();
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove.click();
    }
  });
  let ok;
  const body = el(
    "div",
    { class: "dialog-body show-define" },
    el(
      "div",
      { class: "file-field" },
      el("label", { for: nameId }, "Slide show name"),
      name,
    ),
    el(
      "div",
      { class: "show-define-columns" },
      el(
        "div",
        { class: "show-define-col" },
        el("h3", {}, "Slides in presentation"),
        deckList,
      ),
      el("div", { class: "show-define-mid" }, add),
      el(
        "div",
        { class: "show-define-col" },
        el("h3", {}, "Slides in custom show"),
        showList,
      ),
      el("div", { class: "show-define-side" }, up, down, remove),
    ),
  );
  return new Promise((resolve) => {
    let result = null;
    const modal = openModal({
      title: show ? "Edit Custom Show" : "Define Custom Show",
      className: "show-define-dialog",
      body,
      onClose: () => resolve(result),
      actions: [
        { label: "Cancel", kind: "secondary", onClick: () => true },
        {
          label: "OK",
          kind: "primary",
          onClick: () => {
            if (!chosen.length || !name.value.trim()) return false;
            result = { name: name.value.trim(), slides: chosen };
            return true;
          },
        },
      ],
    });
    ok = modal.buttons[1];
    name.addEventListener("input", render);
    render();
    name.focus();
    name.select();
  });
}
