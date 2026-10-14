import { shortcutLetter } from "./shortcut-keys.js";
import { escape } from "./model.js";
import { searchCommands } from "./commands.js";
import { shortcutKeys } from "./context-menu.js";
import { t, labelled } from "./i18n.js";

const PAGE_SIZE = 50;
export function createCommandPalette(api) {
  let dialog = null,
    input,
    entries = [],
    matches = [],
    active = null,
    page = 0,
    context,
    version,
    composing = false;
  let recent = [];
  try {
    const stored = JSON.parse(
      localStorage.getItem("whiteboard-recent-boards") || "[]",
    );
    if (Array.isArray(stored))
      recent = stored.filter((id) => typeof id === "string").slice(0, 20);
  } catch {}
  const read = () => api.entries(recent);
  function close() {
    const d = dialog;
    dialog = null;
    d?.close();
  }
  function setActive(id, scroll = true) {
    active = id;
    for (const option of dialog.querySelectorAll('[role="option"]'))
      option.setAttribute(
        "aria-selected",
        String(option.dataset.command === id),
      );
    const option = [...dialog.querySelectorAll('[role="option"]')].find(
      (e) => e.dataset.command === id,
    );
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function render(reset = false) {
    if (!dialog?.open) return;
    const before = active;
    matches = searchCommands(entries, input.value);
    if (reset) page = 0;
    page = Math.min(
      page,
      Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1),
    );
    const shown = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const list = dialog.querySelector("#command-results");
    list.innerHTML = shown
      .map(
        (e, n) =>
          `<div class="command-option" role="option" id="command-option-${n}" data-command="${escape(e.id)}" aria-selected="false" ${e.disabled ? 'aria-disabled="true"' : ""}><span class="command-label"><strong data-user-content>${escape(e.label)}</strong><small>${escape(e.disabled || e.category)}</small></span>${e.shortcut ? `<kbd aria-label="${labelled(t("Keyboard shortcut"), "")}${escape(shortcutKeys(e.shortcut))}">${escape(shortcutKeys(e.shortcut))}</kbd>` : ""}</div>`,
      )
      .join("");
    const first = shown.find((e) => !e.disabled) || shown[0];
    setActive(
      !reset && shown.some((e) => e.id === before) ? before : first?.id || null,
      false,
    );
    const empty = dialog.querySelector("#command-empty");
    empty.hidden = !!shown.length;
    const status = dialog.querySelector("#command-count");
    const message = t(
      matches.length === 1 ? "1 result" : `${matches.length} results`,
    );
    if (status.textContent !== message) status.textContent = message;
    const paging = dialog.querySelector(".command-pages");
    paging.hidden = matches.length <= PAGE_SIZE;
    paging.querySelector("span").textContent =
      `${page + 1} / ${Math.max(1, Math.ceil(matches.length / PAGE_SIZE))}`;
    dialog.querySelector("#commands-prev").disabled = page === 0;
    dialog.querySelector("#commands-next").disabled =
      (page + 1) * PAGE_SIZE >= matches.length;
    for (const option of list.children) {
      option.addEventListener("pointerdown", (e) => e.preventDefault());
      option.addEventListener("pointermove", () => {
        if (active !== option.dataset.command)
          setActive(option.dataset.command, false);
      });
      option.addEventListener("click", () => activate(option.dataset.command));
    }
  }
  function refresh(force = false) {
    if (!dialog?.open) return;
    if (api.context() !== context) return close();
    const next = api.version();
    if (!force && version && next.every((v, n) => v === version[n])) return;
    version = next;
    entries = read();
    render();
  }
  function activate(id) {
    if (!dialog?.open || composing) return;
    if (api.context() !== context) return close();
    // The board may have changed while the palette was open, especially during
    // collaboration. Recheck permissions/selection/capacity before execution.
    const entry = read().find((e) => e.id === id);
    if (!entry || entry.disabled) {
      refresh(true);
      const error = dialog.querySelector("#command-error");
      error.textContent =
        entry?.disabled || t("This command is no longer available.");
      return;
    }
    close();
    try {
      Promise.resolve(api.run(entry)).catch((error) =>
        api.toast(error.message),
      );
    } catch (error) {
      api.toast(error.message);
    }
  }
  function changePage(next) {
    page = Math.max(
      0,
      Math.min(next, Math.ceil(matches.length / PAGE_SIZE) - 1),
    );
    active = null;
    render();
    input.focus({ preventScroll: true });
  }
  function open() {
    if (dialog?.open) {
      input.focus();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    api.prepare();
    context = api.context();
    version = api.version();
    entries = read();
    page = 0;
    active = null;
    composing = false;
    const d = api.modal(
      "Command palette",
      `<label class="command-search"><span class="sr-only">Search commands and boards</span><input id="command-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" aria-describedby="command-hint" placeholder="Search commands and boards" autocomplete="off" spellcheck="false" maxlength="200"></label><div id="command-results" role="listbox" aria-label="Commands and boards"></div><p id="command-empty" class="dialog-copy" hidden>No matching commands or boards. Try another word.</p><p id="command-error" class="command-error" role="status"></p><div class="command-pages" hidden><button type="button" class="text-btn" id="commands-prev">Previous results</button><span></span><button type="button" class="text-btn" id="commands-next">Next results</button></div><footer class="command-footer"><span id="command-count" role="status"></span><span id="command-hint">↑ ↓ to navigate · Enter to run · Esc to close</span></footer>`,
      (d) => {
        dialog = d;
        d.classList.add("command-palette");
        input = d.querySelector("#command-search");
        input.addEventListener("compositionstart", () => (composing = true));
        input.addEventListener("compositionend", () => {
          composing = false;
          render(true);
        });
        input.addEventListener("input", () => {
          d.querySelector("#command-error").textContent = "";
          if (!composing) render(true);
        });
        input.addEventListener("keydown", (e) => {
          if (e.isComposing || e.keyCode === 229 || composing) return;
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key === "Enter") {
            e.preventDefault();
            if (!e.repeat && active) activate(active);
          } else if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            if (!matches.length) return;
            const at = matches.findIndex((entry) => entry.id === active);
            const next = Math.max(
              0,
              Math.min(
                matches.length - 1,
                at + (e.key === "ArrowDown" ? 1 : -1),
              ),
            );
            page = Math.floor(next / PAGE_SIZE);
            active = matches[next].id;
            render();
            setActive(active);
          } else if (["PageDown", "PageUp"].includes(e.key)) {
            e.preventDefault();
            changePage(page + (e.key === "PageDown" ? 1 : -1));
          }
        });
        d.addEventListener("cancel", (e) => {
          if (composing) e.preventDefault();
        });
        d.addEventListener("keydown", (e) => {
          if (
            e.key === "Escape" &&
            !e.isComposing &&
            !composing &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        });
        d.querySelector("#commands-prev").onclick = () => changePage(page - 1);
        d.querySelector("#commands-next").onclick = () => changePage(page + 1);
        render(true);
        input.focus({ preventScroll: true });
      },
    );
    d.addEventListener("close", () => {
      if (dialog === d) dialog = null;
    });
  }
  return {
    open,
    close,
    refresh,
    recordBoard(id) {
      recent = [id, ...recent.filter((value) => value !== id)].slice(0, 20);
      try {
        localStorage.setItem(
          "whiteboard-recent-boards",
          JSON.stringify(recent),
        );
      } catch {}
    },
    keydown(e) {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.altKey ||
        e.shiftKey ||
        shortcutLetter(e) !== "k"
      )
        return false;
      if (
        !dialog?.open &&
        (document.querySelector("dialog[open]") ||
          e.target.closest("input,textarea,select,[contenteditable]"))
      )
        return false;
      e.preventDefault();
      if (!e.repeat) {
        if (dialog?.open) close();
        else open();
      }
      return true;
    },
  };
}
