import { toUnicode } from "../idn.js";
// Embeds, Google Workspace imports, and document import ("paste and
// extract"). Everything the editor provides arrives through `api`, so this
// module never reaches into main.js state.
import { createElement, FileUp } from "lucide";
import {
  item,
  clone,
  escape,
  truncate,
  bounds,
  keepOnBoard,
  MAX_OBJECTS,
} from "../model.js";
import { clearSpot } from "../placement.js";
import { t, labelled } from "../i18n.js";
import { nextFrameOrder } from "../scene.js";
import { createTextEditor } from "../text-editor.js";
import { equalTextRuns, sliceTextRuns, textDifference } from "../rich-text.js";
import { spliceTextBlocks } from "../text-blocks.js";
import { refreshedTableLanguagePatch } from "../table-language.js";
import { sizedTableCells } from "../table-sizing.js";
import "./strings.js";
import {
  normalizeEmbed,
  refusesFraming,
  providerGroup,
  providerName,
  EMBED_PROVIDERS,
  googleFile,
  sheetSourceURL,
} from "./providers.js";
import { createLiveEmbeds } from "./embed-live.js";
import { createGoogle } from "./google.js";
import { layoutDocument } from "./layout.js";
import {
  documentKind,
  checkFile,
  extractDocument,
  IMPORT_ACCEPT,
  CSV_LIMIT,
} from "./importer.js";
import { fileBytes, base64, ATTACHMENT_BYTES } from "./binary.js";
import { MAX_PAGES } from "./pdf.js";
import { canInflate } from "../unzip.js";

const GOOGLE_HELP =
  "People who view this board need access to the Google file itself. Google shows a sign-in or access request to anyone without permission.";
const EMBED_HELP =
  "Embeds show a preview card on the board. Choose Open live or press Enter to load the interactive content; it closes when you select something else, scroll away, or press Escape.";
const cancelled = (error) => error?.name === "AbortError";
const summaryParts = (counts) =>
  [
    ["frame", "Frames"],
    ["note", "Sticky notes"],
    ["text", "Text"],
    ["image", "Images"],
    ["table", "Tables"],
    ["file", "Attachments"],
  ]
    .filter(([key]) => counts[key])
    .map(([key, label]) => labelled(t(label), counts[key]));

// A file the import dialog can turn into board objects.
const importable = (file) =>
  !!documentKind(file) && !/^image\//.test(file?.type || "");
export function createContentTools(api) {
  // The person's organization and, on a shared board, the board's
  // organization can each turn Google Workspace or embeds off.
  const own = (feature) => api.allows?.(feature) ?? true,
    onBoard = (feature) => api.boardAllows?.(feature) ?? true,
    allows = (feature) => own(feature) && onBoard(feature);
  const offReason = (group) =>
    !own(group)
      ? group === "google"
        ? "Your organization has turned off Google Workspace integrations."
        : "Your organization has turned off embedded content."
      : !onBoard(group)
        ? group === "google"
          ? "This board’s organization has turned off Google Workspace integrations."
          : "This board’s organization has turned off embedded content."
        : "";
  const live = createLiveEmbeds({ ...api, allows, offReason });
  const google = createGoogle({ fetcher: api.fetcher });
  let running = null;

  const blockedReason = (provider) => {
    const group = providerGroup(provider);
    return group ? offReason(group) : "";
  };
  const canCreate = (target = api.board()) =>
    !!target && api.board() === target && api.canAdd();
  function roomFor(target, count) {
    if (target.items.length + count > MAX_OBJECTS)
      throw Error("A board can contain up to 5,000 objects.");
  }
  // Where an object of this size goes: at the point chosen, as by a drop,
  // or else in the middle of the view, beside what is already there.
  function spot(point, w, h) {
    if (point) return point;
    const c = api.viewCenter(),
      p = { x: c.x - w / 2, y: c.y - h / 2 };
    return api.openSpot ? api.openSpot(p, { w, h }) : p;
  }
  function embedItem(result, title, point) {
    const video = EMBED_PROVIDERS[result.provider]?.video,
      [w, h] = [480, video ? 300 : 340],
      at = spot(point, w, h);
    return item("embed", at.x, at.y, {
      url: result.url,
      provider: result.provider,
      text:
        truncate((title || "").trim(), 500) || t(providerName(result.provider)),
      w,
      h,
      color: "#ffffff",
    });
  }
  function linkItem(url, point) {
    const at = spot(point, 320, 115);
    return item("link", at.x, at.y, {
      w: 320,
      h: 115,
      url,
      text: toUnicode(new URL(url).hostname),
      color: "#dce5f7",
    });
  }
  function insert(items, target) {
    if (!canCreate(target)) return false;
    roomFor(target, items.length);
    return api.insert(items, target);
  }

  // Embed content dialog, also used to edit an existing embed.
  function embedDialog({
    url = "",
    point,
    target = api.board(),
    existing,
  } = {}) {
    if (!target) return;
    if (existing ? !api.canEdit(new Set([existing.id])) : !canCreate(target))
      return;
    const generic = allows("embeds");
    // The services listed are the ones the organizations allow.
    const services =
      generic && allows("google")
        ? `${t("Google Docs, Sheets, Slides, Forms, Drawings, Drive files and folders, and Calendar; YouTube; Vimeo; Microsoft Forms and Office viewer links; Figma; Loom; and Miro boards.")} ${t("Other secure (HTTPS) web pages can be embedded if they allow it.")}`
        : generic
          ? `${t("YouTube; Vimeo; Microsoft Forms and Office viewer links; Figma; Loom; and Miro boards.")} ${t("Other secure (HTTPS) web pages can be embedded if they allow it.")}`
          : allows("google")
            ? `${t("Google Docs, Sheets, Slides, Forms, Drawings, Drive files and folders, and Calendar.")} ${t("Your organization allows only these services.")}`
            : t(
                "Embedded content and Google Workspace integrations are turned off.",
              );
    api.modal(
      existing ? "Embed properties" : "Embed content",
      `<form class="content-form" novalidate aria-describedby="embed-error">
      <label class="field">Link to embed<input id="embed-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" required aria-describedby="embed-detected embed-help embed-error" value="${escape(existing?.url || url)}"></label>
      <p id="embed-detected" class="content-detected" role="status" aria-live="polite"></p>
      <div class="field"><span id="embed-title-label">Title</span><div id="embed-title"></div><small id="embed-title-help">${t("Optional")}</small></div>
      <p class="dialog-copy" id="embed-help">${t(EMBED_HELP)}</p>
      <p class="dialog-copy content-google-note" id="embed-google" hidden>${t(GOOGLE_HELP)}</p>
      <details class="content-providers"><summary>Supported services</summary><p class="dialog-copy">${services}</p></details>
      <p class="content-error" id="embed-error" role="alert" tabindex="-1"></p>
      <div class="dialog-footer">${existing ? `<button type="button" class="secondary" id="embed-live">Open live</button>` : `<button type="button" class="secondary" id="embed-link">Add link card</button>`}<button class="primary" type="submit" id="embed-submit">${existing ? "Save changes" : "Embed"}</button></div></form>`,
      (d) => {
        const input = d.querySelector("#embed-url"),
          detected = d.querySelector("#embed-detected"),
          error = d.querySelector("#embed-error"),
          submit = d.querySelector("#embed-submit"),
          form = d.querySelector("form");
        let conflict = false;
        const clearConflict = () => {
          if (!conflict) return;
          error.textContent = "";
          conflict = false;
        };
        form.addEventListener("input", clearConflict);
        form.addEventListener("change", clearConflict);
        const titleField = createTextEditor(
          d.ownerDocument,
          existing || { text: "" },
          { plainTextOnly: true, maxLength: 500, multiline: false },
        );
        titleField.id = "embed-title";
        titleField.className = "authored-label-field";
        titleField.tabIndex = 0;
        titleField.setAttribute("data-user-content", "");
        titleField.setAttribute("aria-labelledby", "embed-title-label");
        titleField.setAttribute(
          "aria-describedby",
          "embed-title-help embed-error",
        );
        d.querySelector("#embed-title").replaceWith(titleField);
        d.addEventListener("close", () => titleField.destroy(), { once: true });
        const openedTitle = titleField.value,
          openedText = existing?.text || "",
          openedRuns = clone(existing?.textRuns || []),
          openedLanguage = existing?.lang;
        let result = null;
        const update = () => {
          error.textContent = "";
          conflict = false;
          result = normalizeEmbed(input.value, { generic });
          // A page its site refuses to frame would show an empty frame.
          if (result?.provider === "web" && refusesFraming(result.url))
            result = null;
          const blocked = result && blockedReason(result.provider);
          d.querySelector("#embed-google").hidden =
            providerGroup(result?.provider) !== "google";
          detected.textContent = !input.value.trim()
            ? ""
            : blocked
              ? t(blocked)
              : result
                ? `${t(providerName(result.provider))} · ${t("Ready to embed")}`
                : t(
                    "This link cannot be embedded. Add it as a link card instead.",
                  );
          submit.disabled = !result || !!blocked;
          if (blocked) result = null;
        };
        input.oninput = update;
        update();
        const link = d.querySelector("#embed-link");
        if (link)
          link.onclick = () => {
            let url;
            try {
              url = new URL(input.value.trim());
              if (!["http:", "https:"].includes(url.protocol)) throw Error();
            } catch {
              error.textContent = t("Enter a valid http or https link.");
              return;
            }
            try {
              if (insert([linkItem(url.href, point)], target)) d.close();
            } catch (e) {
              error.textContent = t(e.message);
            }
          };
        const openLive = d.querySelector("#embed-live");
        if (openLive)
          openLive.onclick = () => {
            d.close();
            if (api.board()?.items.includes(existing)) live.open(existing);
          };
        form.onsubmit = (event) => {
          event.preventDefault();
          clearConflict();
          if (!result) return;
          const title = titleField.value;
          try {
            if (existing) {
              if (
                api.board() !== target ||
                !target.items.includes(existing) ||
                !api.canEdit(new Set([existing.id]))
              )
                return d.close();
              const titleChanged = title !== openedTitle;
              if (
                titleChanged &&
                ((existing.text || "") !== openedText ||
                  existing.lang !== openedLanguage ||
                  !equalTextRuns(existing.textRuns, openedRuns))
              ) {
                conflict = true;
                error.textContent = t(
                  "This object changed. Open it again to edit it.",
                );
                error.focus();
                return;
              }
              live.close(existing.id);
              // A title left as the provider's name follows a new provider.
              const defaultTitle =
                !titleChanged &&
                !openedRuns.length &&
                existing.provider !== result.provider &&
                openedText === t(providerName(existing.provider));
              api.mutate(() => {
                Object.assign(existing, {
                  url: result.url,
                  provider: result.provider,
                });
                if (defaultTitle) {
                  existing.text = t(providerName(result.provider));
                  delete existing.textBlocks;
                }
                if (!titleChanged) return;
                const prev = existing.text || "",
                  trimmed = title.trim(),
                  offset = title.length - title.trimStart().length,
                  text =
                    truncate(trimmed, 500) || t(providerName(result.provider)),
                  runs = trimmed
                    ? sliceTextRuns(
                        titleField.textRuns,
                        offset,
                        offset + text.length,
                      )
                    : [],
                  { start, end, insert } = textDifference(prev, text),
                  blocks = spliceTextBlocks(
                    prev,
                    existing.textBlocks,
                    start,
                    end,
                    insert,
                  );
                existing.text = text;
                if (runs.length) existing.textRuns = runs;
                else delete existing.textRuns;
                if (blocks.length) existing.textBlocks = blocks;
                else delete existing.textBlocks;
              });
              d.close();
            } else if (insert([embedItem(result, title, point)], target))
              d.close();
          } catch (e) {
            error.textContent = t(e.message);
          }
        };
        input.focus();
      },
    );
  }

  // Pasting or dropping a link to a known provider offers a choice.
  function linkChoice(result, url, point, target) {
    const sheet = result.provider === "google-sheets" && !result.published;
    const doc = result.provider === "google-docs";
    api.modal(
      "Add link",
      `<p class="dialog-copy" data-user-content>${escape(url)}</p>
      <p class="dialog-copy">${escape(t(providerName(result.provider)))} · ${t("Embed it as live content or add a link card.")}</p>
      ${providerGroup(result.provider) === "google" ? `<p class="dialog-copy content-google-note">${t(GOOGLE_HELP)}</p>` : ""}
      <p class="content-error" role="alert"></p>
      <div class="dialog-footer content-choice">${sheet ? '<button type="button" class="secondary" data-choice="sheet">Import as table</button>' : ""}${doc ? '<button type="button" class="secondary" data-choice="doc">Import as sticky notes</button>' : ""}<button type="button" class="secondary" data-choice="link">Link card</button><button type="button" class="primary" data-choice="embed">Embed</button></div>`,
      (d) => {
        const error = d.querySelector(".content-error");
        d.querySelectorAll("[data-choice]").forEach((button) => {
          button.onclick = () => {
            const choice = button.dataset.choice;
            try {
              if (choice === "sheet") {
                d.close();
                return googleDialog({ url, mode: "sheet", point });
              }
              if (choice === "doc") {
                d.close();
                return googleDialog({ url, mode: "doc", point });
              }
              const object =
                choice === "embed"
                  ? embedItem(result, "", point)
                  : linkItem(url, point);
              if (insert([object], target)) d.close();
            } catch (e) {
              error.textContent = t(e.message);
            }
          };
        });
        d.querySelector('[data-choice="embed"]').focus();
      },
    );
  }

  // One import at a time; cancellation leaves the board unchanged.
  async function runImport(d, task) {
    const status = d.querySelector(".content-status"),
      bar = d.querySelector("progress"),
      submit = d.querySelector('[type="submit"]'),
      cancel = d.querySelector(".content-cancel"),
      error = d.querySelector(".content-error");
    const controller = new AbortController(),
      attachOnly = d.querySelector("#content-attach-only"),
      chooser = d.querySelector("#content-choose");
    running = controller;
    if (attachOnly) attachOnly.disabled = true;
    // A file chosen mid-import would change what the import is reading.
    if (chooser) chooser.disabled = true;
    error.textContent = "";
    submit.disabled = true;
    cancel.textContent = t("Cancel import");
    bar.hidden = false;
    bar.removeAttribute("value");
    const progress = (message, value) => {
      status.textContent =
        t(message) + (value != null ? ` ${Math.round(value * 100)}%` : "");
      if (value == null) bar.removeAttribute("value");
      else bar.value = Math.round(value * 100);
    };
    d.addEventListener("close", () => controller.abort(), { once: true });
    try {
      const result = await task(controller.signal, progress);
      if (controller.signal.aborted || !result) return;
      const parts = summaryParts(result.counts);
      const skipped = result.skipped.map((s) =>
        labelled(`${t(s.reason)}${s.detail ? ` (${s.detail})` : ""}`, s.count),
      );
      const message = `${labelled(t("Imported"), "")}${parts.join(" · ") || t("nothing")}.${skipped.length ? ` ${labelled(t("Skipped"), "")}${skipped.join(" · ")}.` : ""}`;
      bar.hidden = true;
      status.textContent = message;
      api.toast(
        parts.length
          ? "Import complete. Undo removes it."
          : "Nothing was imported.",
      );
      d.dataset.done = "true";
      cancel.textContent = t("Done");
      submit.hidden = true;
      if (attachOnly) attachOnly.hidden = true;
      cancel.focus();
    } catch (e) {
      bar.hidden = true;
      if (cancelled(e)) {
        status.textContent = t("Import cancelled. The board is unchanged.");
      } else {
        status.textContent = "";
        error.textContent = t(e.message || "Could not import this document.");
      }
      submit.disabled = false;
      cancel.textContent = t("Cancel");
    } finally {
      if (attachOnly) attachOnly.disabled = false;
      if (chooser) chooser.disabled = false;
      if (running === controller) running = null;
    }
  }
  function place(target, result, point) {
    if (api.board() !== target || !api.canAdd())
      throw new DOMException("Cancelled", "AbortError");
    if (!result.items.length) return result;
    roomFor(target, result.items.length);
    // Without a point chosen, the new frames go in the middle of the view,
    // or beside the board's content rather than over it.
    if (!point) {
      const box = bounds(result.items),
        c = api.viewCenter(),
        at = clearSpot(target.items, {
          x: c.x - box.w / 2,
          y: c.y - box.h / 2,
          w: box.w,
          h: box.h,
        });
      for (const i of result.items) {
        i.x += at.x - box.x;
        i.y += at.y - box.y;
      }
      keepOnBoard(result.items);
    }
    // Refused, as on a board the facilitator locked, it reports so rather
    // than a completed import.
    if (!api.insert(result.items, target)) throw Error("Nothing was imported.");
    api.focus?.(result.items.filter((i) => i.type === "frame"));
    return result;
  }
  const layoutOptions = (target, extra) => ({
    ctx: api.measure(),
    room: MAX_OBJECTS - target.items.length,
    // Imported frames come after the board's last, as a count of frames
    // would repeat an order once one was deleted.
    baseOrder: nextFrameOrder(target.items),
    decode: api.decodeImage,
    labels: { notes: t("Speaker notes"), slide: t("Slide") },
    ...extra,
  });

  function importDialog(initial = [], point, { attach = true } = {}) {
    const target = api.board();
    if (!canCreate(target)) return;
    if (running) return api.toast("An import is already in progress.");
    let file = null,
      kind = null,
      workbook = null;
    api.modal(
      "Import document",
      `<form class="content-form" novalidate>
      <p class="dialog-copy">${t("Add the content of a PDF, PowerPoint (.pptx), Word (.docx), Excel (.xlsx), CSV, text, or Markdown file as editable objects in a new frame.")}</p>
      <div class="content-file"><button type="button" class="secondary" id="content-choose">Choose file</button><span id="content-file-name" data-user-content aria-live="polite">${t("No file chosen")}</span></div>
      <fieldset class="content-options" id="content-pdf" hidden><legend>PDF options</legend>
        <label class="field">Pages to import<select id="content-pages">${[5, 10, 20, 30, MAX_PAGES].map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n} ${t("pages")}</option>`).join("")}</select></label>
        <label class="check-row"><input type="checkbox" id="content-pdf-text"> <span>Also extract text as sticky notes</span></label>
      </fieldset>
      <fieldset class="content-options" id="content-sheet" hidden><legend>Table options</legend>
        <label class="field" id="content-sheet-field" hidden>Sheet<select id="content-sheet-name"></select></label>
        <label class="check-row"><input type="radio" name="content-table-mode" value="split" checked> <span>Split large ranges into several tables</span></label>
        <label class="check-row"><input type="radio" name="content-table-mode" value="first"> <span>Import only the first 20 rows and 12 columns</span></label>
        <p class="dialog-copy">${t("Board tables hold up to 20 rows, 12 columns, and 2,000 characters per cell.")}</p>
      </fieldset>
      <label class="check-row"><input type="checkbox" id="content-attach" ${attach ? "checked" : ""}> <span>Keep the original file as an attachment</span></label>
      <progress class="content-progress" max="100" hidden aria-label="${escape(t("Import progress"))}"></progress>
      <p class="content-status dialog-copy" role="status" aria-live="polite"></p>
      <p class="content-error" role="alert"></p>
      <div class="dialog-footer content-choice"><button type="button" class="secondary content-cancel">Cancel</button><button type="button" class="secondary" id="content-attach-only" hidden>Attach without importing</button><button class="primary" type="submit" disabled>Import</button></div></form>`,
      (d) => {
        const name = d.querySelector("#content-file-name"),
          error = d.querySelector(".content-error"),
          submit = d.querySelector('[type="submit"]'),
          sheetField = d.querySelector("#content-sheet-field"),
          sheetSelect = d.querySelector("#content-sheet-name");
        let pending = null;
        const attachOnly = d.querySelector("#content-attach-only");
        // The file is read before it is attached; a second press meanwhile
        // would attach it twice.
        let attaching = false;
        attachOnly.onclick = async () => {
          if (!pending || running || attaching) return;
          attaching = true;
          try {
            if (pending.size > ATTACHMENT_BYTES)
              throw Error("Choose a file smaller than 10 MB.");
            const bytes = await fileBytes(pending);
            const name = truncate(pending.name, 255);
            const at = spot(point, 280, 110);
            const object = item("file", at.x, at.y, {
              w: 280,
              h: 110,
              text: name,
              fileName: name,
              data: `data:application/octet-stream;base64,${base64(bytes)}`,
              color: "#eadcf0",
            });
            if (insert([object], target)) d.close();
          } catch (e) {
            error.textContent = t(e.message);
          } finally {
            attaching = false;
          }
        };
        async function choose(next) {
          pending = next;
          // A file card's own document is already attached.
          attachOnly.hidden = !attach;
          error.textContent = "";
          d.querySelector(".content-status").textContent = "";
          submit.hidden = false;
          // A new file starts a new import, so the footer offers Cancel again.
          d.querySelector(".content-cancel").textContent = t("Cancel");
          delete d.dataset.done;
          try {
            kind = checkFile(next);
            if (["pptx", "docx", "xlsx"].includes(kind) && !canInflate())
              throw Error(
                "This browser cannot open compressed Office files. Update your browser and try again.",
              );
          } catch (e) {
            file = kind = null;
            // The previous file's PDF, table, and sheet options go with it.
            d.querySelector("#content-pdf").hidden = true;
            d.querySelector("#content-sheet").hidden = true;
            sheetField.hidden = true;
            workbook = null;
            submit.disabled = true;
            name.textContent = next.name;
            error.textContent = t(e.message);
            return;
          }
          file = next;
          name.textContent = `${file.name} · ${t({ pdf: "PDF", pptx: "PowerPoint", docx: "Word", xlsx: "Excel", csv: "CSV", text: "Text", markdown: "Markdown" }[kind])}`;
          d.querySelector("#content-pdf").hidden = kind !== "pdf";
          d.querySelector("#content-sheet").hidden = ![
            "xlsx",
            "csv",
            "docx",
            "pptx",
            "markdown",
          ].includes(kind);
          sheetField.hidden = true;
          workbook = null;
          submit.disabled = kind === "xlsx";
          if (kind === "xlsx") {
            // Read the workbook now so the sheet picker lists its sheets.
            // A workbook chosen while another is still being read wins.
            const chosen = next;
            try {
              const opened = await extractDocument(
                kind,
                await fileBytes(chosen),
              );
              if (file !== chosen) return;
              workbook = opened;
              const visible = workbook.sheets
                .map((s, n) => ({ ...s, n }))
                .filter((s) => !s.hidden);
              sheetSelect.innerHTML =
                visible
                  .map(
                    (s) =>
                      `<option value="${s.n}" data-user-content>${escape(s.name)}</option>`,
                  )
                  .join("") +
                (visible.length > 1
                  ? `<option value="all">${escape(t("All sheets"))}</option>`
                  : "");
              sheetField.hidden = false;
              submit.disabled = !visible.length;
              if (!visible.length)
                error.textContent = t("This workbook has no sheets to import.");
            } catch (e) {
              if (file !== chosen) return;
              error.textContent = t(
                e.message || "Could not read this workbook.",
              );
            }
          }
        }
        d.querySelector("#content-choose").onclick = () =>
          api.fileInput(IMPORT_ACCEPT, (chosen) => choose(chosen));
        d.querySelector(".content-cancel").onclick = () => {
          if (running) running.abort();
          else d.close();
        };
        d.querySelector("form").onsubmit = (event) => {
          event.preventDefault();
          if (!file || running) return;
          const current = file,
            currentKind = kind,
            book = workbook,
            choice = sheetSelect.value,
            attach = d.querySelector("#content-attach").checked,
            tableMode = d.querySelector(
              '[name="content-table-mode"]:checked',
            ).value;
          runImport(d, async (signal, progress) => {
            progress("Reading file…");
            const bytes = await fileBytes(current);
            let model;
            if (currentKind === "xlsx") {
              const indices =
                choice === "all"
                  ? book.sheets
                      .map((s, n) => (s.hidden ? -1 : n))
                      .filter((n) => n >= 0)
                  : [+choice];
              const sheets = [];
              for (const [n, index] of indices.entries()) {
                progress("Reading sheets…", n / indices.length);
                sheets.push(await book.read(index, { signal }));
              }
              model = { kind: "sheets", sheets, skipped: book.skipped };
            } else {
              progress(
                currentKind === "pdf"
                  ? "Loading the PDF reader…"
                  : "Extracting content…",
              );
              model = await extractDocument(currentKind, bytes, {
                name: current.name,
                signal,
                loadPdfjs: api.loadPdfjs,
                maxPages: +d.querySelector("#content-pages").value,
                text: d.querySelector("#content-pdf-text").checked,
                progress: (n, count) =>
                  progress("Rendering pages…", (n - 1) / count),
              });
            }
            if (signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            progress("Placing content…");
            const result = await layoutDocument(
              model,
              layoutOptions(target, {
                file: current,
                bytes,
                point: point || api.viewCenter(),
                signal,
                attach,
                tableMode,
              }),
            );
            if (signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            return place(target, result, point);
          });
        };
        if (initial[0]) choose(initial[0]);
        else d.querySelector("#content-choose").focus();
      },
    );
  }

  // Google Workspace: embed, Sheets as tables, Docs outline, Slides frames.
  function googleDialog({ url = "", mode, point } = {}) {
    const target = api.board();
    if (!canCreate(target)) return;
    if (!allows("google")) return api.toast(offReason("google"));
    if (running) return api.toast("An import is already in progress.");
    api.modal(
      "Google Workspace",
      `<form class="content-form" novalidate>
      <label class="field">Google Docs, Sheets, Slides, Forms, or Drive link<input id="google-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="google-detected google-help" value="${escape(url)}"></label>
      <p id="google-detected" class="content-detected" role="status" aria-live="polite"></p>
      <fieldset class="content-options"><legend>Add as</legend>
        <label class="check-row"><input type="radio" name="google-mode" value="embed" checked> <span>Live embed</span></label>
        <label class="check-row"><input type="radio" name="google-mode" value="sheet"> <span>Editable table from Google Sheets</span></label>
        <label class="check-row"><input type="radio" name="google-mode" value="doc"> <span>Google Doc outline as sticky notes</span></label>
        <label class="check-row"><input type="radio" name="google-mode" value="slides"> <span>Google Slides as frames</span></label>
      </fieldset>
      <fieldset class="content-options" id="google-table" hidden><legend>Large sheets</legend>
        <label class="check-row"><input type="radio" name="google-table-mode" value="split" checked> <span>Split into several tables</span></label>
        <label class="check-row"><input type="radio" name="google-table-mode" value="first"> <span>Import only the first 20 rows and 12 columns</span></label>
      </fieldset>
      <p class="dialog-copy" id="google-help">${t(GOOGLE_HELP)} ${t("Imports need the file shared with “Anyone with the link” or published to the web. Tables imported from Google Sheets can be refreshed later.")}</p>
      <progress class="content-progress" max="100" hidden aria-label="${escape(t("Import progress"))}"></progress>
      <p class="content-status dialog-copy" role="status" aria-live="polite"></p>
      <p class="content-error" role="alert"></p>
      <div class="dialog-footer"><button type="button" class="secondary content-cancel">Cancel</button><button class="primary" type="submit">Add to board</button></div></form>`,
      (d) => {
        const input = d.querySelector("#google-url"),
          detected = d.querySelector("#google-detected"),
          submit = d.querySelector('[type="submit"]');
        const radios = [...d.querySelectorAll('[name="google-mode"]')];
        if (mode) radios.find((r) => r.value === mode).checked = true;
        let touched = !!mode;
        radios.forEach(
          (r) => (r.onchange = () => ((touched = true), update())),
        );
        const update = () => {
          const found = googleFile(input.value);
          const kind = found?.provider;
          const allowed = {
            embed: !!found,
            sheet: kind === "google-sheets",
            doc: kind === "google-docs",
            slides: kind === "google-slides" && !found?.published,
          };
          for (const r of radios) r.disabled = !!found && !allowed[r.value];
          if (found && !touched) {
            const preferred = { "google-sheets": "sheet" }[kind] || "embed";
            radios.find((r) => r.value === preferred).checked = true;
          }
          let chosen = radios.find((r) => r.checked);
          if (chosen?.disabled) {
            radios.find((r) => r.value === "embed").checked = true;
            chosen = radios[0];
          }
          d.querySelector("#google-table").hidden = chosen.value !== "sheet";
          detected.textContent = !input.value.trim()
            ? ""
            : found
              ? t(providerName(found.provider))
              : t("Paste a link to a Google Docs, Sheets, or Slides file.");
          submit.disabled = !found || !!d.dataset.done;
        };
        input.oninput = () => {
          delete d.dataset.done;
          submit.hidden = false;
          update();
        };
        update();
        d.querySelector(".content-cancel").onclick = () => {
          if (running) running.abort();
          else d.close();
        };
        d.querySelector("form").onsubmit = (event) => {
          event.preventDefault();
          if (running) return;
          const value = input.value,
            choice = radios.find((r) => r.checked).value,
            tableMode = d.querySelector(
              '[name="google-table-mode"]:checked',
            ).value;
          if (choice === "embed") {
            const result = normalizeEmbed(value, { generic: false });
            if (!result || providerGroup(result.provider) !== "google") return;
            try {
              if (insert([embedItem(result, "", point)], target)) d.close();
            } catch (e) {
              d.querySelector(".content-error").textContent = t(e.message);
            }
            return;
          }
          runImport(d, async (signal, progress) => {
            progress("Downloading from Google…");
            let model, source, title;
            if (choice === "sheet") {
              const sheet = await google.sheet(value, { signal });
              source = sheet.source;
              title = t("Google Sheets");
              model = {
                kind: "sheets",
                sheets: [
                  {
                    name: title,
                    rows: sheet.rows,
                    truncated: sheet.truncated,
                    limit: CSV_LIMIT,
                  },
                ],
              };
            } else if (choice === "doc") {
              ({ model, source } = await google.document(value, { signal }));
              title = t("Google Docs");
            } else {
              ({ model, source } = await google.slides(value, { signal }));
              title = t("Google Slides");
            }
            progress("Placing content…");
            // The first frame links back to the Google file.
            const lead = linkItem(source.url, { x: 0, y: 0 });
            lead.text = title;
            const result = await layoutDocument(
              model,
              layoutOptions(target, {
                point: point || api.viewCenter(),
                signal,
                lead,
                tableMode,
                title,
                source: choice === "sheet" ? source : undefined,
              }),
            );
            if (signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            return place(target, result, point);
          });
        };
        input.focus();
      },
    );
  }

  async function refreshSheet(i = selectedSheet()) {
    if (!i) return api.toast("Select a table imported from Google Sheets.");
    if (!allows("google")) return api.toast(offReason("google"));
    if (!api.canEdit(new Set([i.id]))) return;
    const target = api.board();
    api.toast("Refreshing from Google Sheets…");
    try {
      const { cells, range } = await google.refresh(i);
      // Shared boards replace objects on remote edits; apply the refresh to
      // the table as it is now, if it still comes from the same source.
      const source = i.sourceUrl;
      i = target.items.find((x) => x.id === i.id);
      if (
        api.board() !== target ||
        i?.type !== "table" ||
        i.sourceUrl !== source ||
        !api.canEdit(new Set([i.id]))
      )
        return;
      const nextSource = sheetSourceURL(googleFile(i.sourceUrl), range);
      if (
        JSON.stringify(cells) === JSON.stringify(i.cells) &&
        nextSource === i.sourceUrl
      )
        return api.toast("This table is already up to date.");
      const patch = sizedTableCells(i, cells, api.measure(), true);
      const languagePatch = refreshedTableLanguagePatch(i, cells);
      api.mutate(() =>
        Object.assign(i, patch, languagePatch, { sourceUrl: nextSource }),
      );
      api.toast(
        "Table refreshed from Google Sheets. Undo restores the previous cells.",
      );
    } catch (e) {
      api.toast(e.message || "Could not refresh this table.");
    }
  }
  function selectedSheet() {
    const selection = api.selection();
    if (selection.size !== 1) return null;
    const i = api.board()?.items.find((x) => selection.has(x.id));
    return i?.type === "table" && i.sourceUrl ? i : null;
  }

  // Toolbar entry and refresh chip, created on demand because the editor
  // replaces its markup whenever it opens a board.
  let refreshChip = null;
  function chrome() {
    const tools = document.querySelector(".canvas-wrap .tools");
    if (tools && !tools.querySelector('[data-action="import-document"]')) {
      const button = document.createElement("button");
      button.className = "icon-btn";
      button.dataset.action = "import-document";
      button.setAttribute("aria-label", t("Import document"));
      button.title = t("Import document");
      const svg = createElement(FileUp);
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("stroke-width", "1.65");
      button.append(svg);
      button.onclick = () => api.action("import-document");
      (
        tools.querySelector('[data-action="image"]') || tools.lastElementChild
      )?.after(button);
    }
    const importButton = tools?.querySelector(
      '[data-action="import-document"]',
    );
    if (importButton) importButton.disabled = !!api.readOnly();
    const hint = document.querySelector(".drop-hint span");
    if (hint && !hint.dataset.content) {
      hint.dataset.content = "true";
      hint.textContent = t(
        "Images, documents (PDF, Word, PowerPoint, Excel), files, text, and links",
      );
    }
    const wrap = document.querySelector(".canvas-wrap");
    if (wrap && (!refreshChip || refreshChip.parentNode !== wrap)) {
      refreshChip = document.createElement("button");
      refreshChip.type = "button";
      refreshChip.className = "sheet-refresh";
      refreshChip.hidden = true;
      refreshChip.onclick = () => refreshSheet();
      wrap.append(refreshChip);
    }
    const table = !api.readOnly() && !api.busy?.() && selectedSheet();
    if (refreshChip) {
      refreshChip.hidden = !table;
      if (table) {
        const view = api.view(),
          canvas = document.querySelector("#canvas"),
          rect = canvas.getBoundingClientRect(),
          outer = wrap.getBoundingClientRect();
        const label = t("Refresh from Google Sheets");
        if (refreshChip.textContent !== label) refreshChip.textContent = label;
        refreshChip.style.left = `${rect.left - outer.left + table.x * view.z + view.x}px`;
        refreshChip.style.top = `${rect.top - outer.top + (table.y + table.h) * view.z + view.y + 10}px`;
      }
    }
  }

  // Enter opens the selected embed; Escape closes live embeds.
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !api.board() ||
      document.querySelector("dialog[open]") ||
      event.target.closest?.(
        "input,textarea,select,[contenteditable],button,a,iframe",
      )
    )
      return;
    if (event.key === "Escape" && live.isOpen()) {
      event.preventDefault();
      live.closeAll(true);
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const i = live.selectedEmbed();
      if (i && !event.target.closest?.("[data-id]")) {
        event.preventDefault();
        live.open(i);
      }
    }
  });

  // An attached document whose contents can still be imported.
  const canImport = (i) =>
    i?.type === "file" &&
    importable({ name: i.fileName || "", type: "" }) &&
    !api.readOnly();
  const actions = {
    embed: () => embedDialog(),
    "import-document": () => importDialog(),
    "google-workspace": () => googleDialog(),
    "google-sheet": () => googleDialog({ mode: "sheet" }),
    "refresh-sheet": () => refreshSheet(),
    "open-embed": () => {
      const i = live.selectedEmbed();
      if (i) live.open(i);
      else api.toast("Select an embed first.");
    },
  };
  return {
    actions,
    live,
    render() {
      live.render();
      chrome();
    },
    // Double-click and Enter open the embed live; properties edit it.
    edit(i, properties = false) {
      if (i?.type !== "embed") return false;
      if (properties) embedDialog({ existing: i });
      else live.open(i);
      return true;
    },
    // Returns true when a pasted or dropped link was handled here.
    receiveText(text, point, target) {
      const value = text.trim();
      if (!value || /\s/.test(value)) return false;
      const result = normalizeEmbed(value, { generic: false });
      if (
        !result ||
        blockedReason(result.provider) ||
        api.readOnly() ||
        !canCreate(target)
      )
        return false;
      linkChoice(result, value, point, target);
      return true;
    },
    // A lone document opens the import dialog, which can also attach it
    // unchanged. Several files are attached as they are; when documents
    // are among them, the list says so, and each one's file card can
    // import its contents later.
    receiveFiles(files, point) {
      const [file] = files;
      if (
        files.length !== 1 ||
        !importable(file) ||
        api.readOnly() ||
        running
      ) {
        const kept = [...files];
        kept.documents = files.length > 1 && files.some(importable);
        return kept;
      }
      importDialog([file], point);
      return [];
    },
    canImport,
    // Imports an attached document's contents beside its file card. The
    // card stays, so a second attachment is not offered by default.
    importAttachment(i) {
      if (!canImport(i)) return false;
      if (!String(i.data).startsWith("data:")) {
        api.toast("The attachment is still downloading. Try again shortly.");
        return true;
      }
      const [head, body] = i.data.split(","),
        type = head.slice(5).split(";")[0],
        bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      importDialog(
        [new File([bytes], i.fileName, { type })],
        { x: i.x + i.w + 60, y: i.y },
        { attach: false },
      );
      return true;
    },
    close() {
      running?.abort();
      live.closeAll();
    },
  };
}
