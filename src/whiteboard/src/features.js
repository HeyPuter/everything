import { openClusters } from "./clusters-ui.js";
import { busy } from "./accessibility/busy.js";
import { fileName } from "./file-name.js";
import { fontFiles } from "./svg-fonts.js";
import { fileDetails } from "./file-details.js";
import { createTextEditor } from "./text-editor.js";
import { equalTextRuns, textDifference } from "./rich-text.js";
import { spliceTextBlocks } from "./text-blocks.js";
import { textLinkURL } from "./text-link-data.js";
import {
  authoredTextHTML,
  languageAttribute,
  objectNameHTML,
} from "./accessibility/object-content.js";
import { openSelectionFilter } from "./selection-filter-ui.js";
import { referencedTags, importTags } from "./tags.js";
import { trimMindMap } from "./mind-map.js";
import {
  item,
  uid,
  clone,
  escape,
  bounds,
  validateBoard,
  keepOnBoard,
  MAX_OBJECTS,
} from "./model.js";
import { externalizeObjectLinks } from "./object-link-data.js";
import { mergeTableDraft } from "./table-draft.js";
import {
  tableCellContent,
  tableLanguagePatch,
  tableTextContent,
  normalizedCellLanguage,
} from "./table-language.js";
import {
  createAuthoredField,
  fieldContent,
} from "./facilitation/authored-field.js";
import { sizedTableCells } from "./table-sizing.js";
import {
  safeURL,
  completeGroups,
  group,
  isWholeGroup,
  ungroup,
  connectObjects,
  createFrame,
  orderedFrames,
  nextFrameTitle,
  attachToFrame,
  layoutUnits,
  layoutMoves,
  applyLayout,
  reorderItems,
  duplicateItems,
  updateConnectors,
} from "./scene.js";
import { placeDuplicates } from "./duplication.js";
import {
  TEMPLATE_CATALOG,
  TEMPLATE_CATEGORIES,
  fromTemplate,
  searchTemplates,
} from "./templates.js";
import {
  COMPONENTS,
  COMPONENT_GROUPS,
  componentItems,
  searchComponents,
} from "./component-library.js";
import {
  ICON_CATEGORIES,
  ICON_COLORS,
  iconItem,
  searchIcons,
} from "./icon-library.js";
import {
  shapeFamilies,
  searchShapes,
  iconSvg,
  fold,
  searchIndex,
  searchWords,
  matchesWord,
} from "./libraries.js";
import { shapePreview } from "./shape-art.js";
import {
  language,
  t,
  translateUI,
  addTranslations,
  plural,
  labelled,
} from "./i18n.js";
import { paint, exportImage } from "./render.js";
import { reflowTextItems, clearTextLayoutCache } from "./text.js";
import { loadItemFonts, itemFontFamilies, FONT_FAMILIES } from "./fonts.js";
import { clearConnectorLabelCache } from "./connectors.js";
import { exportPDF, exportRegions, pdfPlan } from "./export.js";
import { exportCSV, exportXLSX } from "./export-sheet.js";
import { createZip } from "./zip.js";
import { fileBytes } from "./content/binary.js";
import {
  deletedSince,
  recoverDeleted,
  restoreFrame,
  frameRestoreIds,
  restoreObjects,
  objectRestoreIds,
  sameObject,
  restoreBoard,
  withoutObjects,
} from "./history/restore.js";
import { createVersionPreview, versionChanges } from "./history/preview.js";
import { keptRevision } from "./storage.js";
import { readTableContent, pasteTable, tableHeight } from "./bulk-content.js";
import { canSwitchShape, shapeKey, switchShape } from "./shapes.js";
import { portableWorkshop, WORKSHOP_LIMITS } from "./facilitation/model.js";
import { unlinkCopiedJira, hasTask, statusFromTitle } from "./planning/task.js";
import { alignColumnStatuses, statusSyncEnabled } from "./planning/kanban.js";
import { protectedIds } from "./locking.js";
import { collectTasks, taskSheet } from "./planning/tasks.js";
// A writer that fails to download reports it plainly instead of with the
// browser's module error.
const loadWriter = (pending) =>
  pending.catch(() => {
    throw Error(
      "This feature could not load. Check your connection and try again.",
    );
  });
// The plain space around a followed slide that a different screen shape
// leaves, like the presenter's own surround.
const SLIDE_SURROUND = "#3a3d42";
const frameTitleHTML = (frame, fallback = "Frame") =>
  frame?.text ? authoredTextHTML(frame) : escape(t(fallback));
function frameChoicesHTML(frames, id, legend, allowNone = false) {
  // Native options cannot mark language changes within their text. Labels
  // keep the complete authored title available to each radio's name.
  const name = uid(),
    choices = allowNone ? [null, ...frames] : frames;
  return `<fieldset id="${id}" class="frame-choices"><legend>${t(legend)}</legend><div class="slide-choices">${choices
    .map(
      (frame, index) =>
        `<label><input type="radio" name="${name}" value="${frame ? escape(frame.id) : ""}" ${index === 0 ? "checked" : ""}><span>${frame ? frameTitleHTML(frame, "Untitled frame") : t("No frame")}</span></label>`,
    )
    .join("")}</div></fieldset>`;
}
const EXPORT_HELP = {
  pdf: "Large areas split across pages at a readable scale, with an overview page that shows the page grid.",
  pptx: "One slide per frame, or one slide for the board or selection. An area too large to read on one slide gets an overview slide and a slide for each part. Each slide shows a high-resolution image, the frame title, and the frame text in the speaker notes.",
  png: "Each image is up to 64 megapixels and 16,384 pixels on the longest side, or 16 megapixels on phones and tablets. Several frames download as a ZIP file with one image per frame. Use PDF for very large boards.",
  jpeg: "Each image is up to 64 megapixels and 16,384 pixels on the longest side, or 16 megapixels on phones and tablets. Several frames download as a ZIP file with one image per frame. Use PDF for very large boards.",
  svg: "A vector image with selectable text and embedded images. Several frames are stacked in one file.",
  xlsx: "A workbook with a sheet of text objects (including task fields such as assignee, start, due, and status), a Tasks sheet with assignees and dependencies when the area holds tasks, one sheet per table, and a list of frames.",
  csv: "UTF-8 comma-separated values for Excel and other spreadsheet apps.",
  json: "An editable Whiteboard file that can be imported again.",
};
// What the PDF scale and page size chosen do, beside Readable detail's
// EXPORT_HELP.pdf.
const PDF_SCALE_HELP = {
  fit: "Each area prints on one page, reduced to fit. Text in a large area can become too small to read; choose Readable detail to split it across pages.",
  percent:
    "Areas larger than a page split across pages at {scale}, with an overview page that shows the page grid.",
  page: "Each area prints on one page sized to its content.",
};
const RENDERING_HELP = {
  raster:
    "Image rendering matches the board exactly, including its fonts. An invisible copy of its text and image descriptions can be searched, selected and read aloud.",
  vector:
    "Vector rendering keeps text and shapes sharp at any zoom and makes text selectable. Standard PDF fonts replace the board fonts, so spacing can differ slightly. Images and characters those fonts lack are kept as images.",
};
// The exported tasks as the Tasks view lists them, with assignees,
// dependencies and Jira links, as a spreadsheet sheet of their own.
function taskSheets(snapshot, regions) {
  const ids = new Set(regions.flatMap((r) => r.items).map((i) => i.id));
  const rows = collectTasks(snapshot).filter((r) => ids.has(r.id));
  return rows.length ? [taskSheet(rows)] : [];
}
const EXPORT_TYPES = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8",
  json: "application/json",
};
addTranslations({
  "You’re viewing a different board. Return to the original board to save this selection, or close this dialog and select content again.":
    "Vous consultez un autre tableau. Revenez au tableau d’origine pour enregistrer cette sélection, ou fermez cette fenêtre et sélectionnez de nouveau le contenu.",
  "Content saved. You changed its name while saving. Save again to update the name.":
    "Contenu enregistré. Vous avez modifié son nom pendant l’enregistrement. Enregistrez de nouveau pour mettre le nom à jour.",
  "Enter a name for this reusable content.":
    "Saisissez un nom pour ce contenu réutilisable.",
  "None of the selected objects are available to copy. Close this dialog and select visible objects again.":
    "Aucun des objets sélectionnés ne peut être copié. Fermez cette fenêtre et sélectionnez de nouveau des objets visibles.",
  "Restoring a version. Please wait before choosing another.":
    "Restauration d’une version en cours. Veuillez attendre avant d’en choisir une autre.",
  "You’re viewing a different board. Return to the original board to use this history, or close this dialog and open history again.":
    "Vous consultez un autre tableau. Revenez au tableau d’origine pour utiliser cet historique, ou fermez cette fenêtre et rouvrez l’historique.",
  "Enter a label for the link.": "Saisissez un libellé pour le lien.",
  [EXPORT_HELP.pdf]:
    "Les grandes zones sont réparties sur plusieurs pages à une échelle lisible, avec une page de vue d’ensemble qui montre la grille des pages.",
  [EXPORT_HELP.pptx]:
    "Une diapositive par cadre, ou une seule pour le tableau ou la sélection. Une zone trop grande pour être lisible sur une seule diapositive reçoit une diapositive de vue d’ensemble et une diapositive par partie. Chaque diapositive présente une image haute résolution, le titre du cadre et son texte dans les notes de l’orateur.",
  [EXPORT_HELP.png]:
    "Chaque image compte jusqu’à 64 mégapixels et 16 384 pixels sur le côté le plus long, ou 16 mégapixels sur les téléphones et les tablettes. Plusieurs cadres se téléchargent dans un fichier ZIP, une image par cadre. Utilisez le PDF pour les très grands tableaux.",
  [EXPORT_HELP.svg]:
    "Une image vectorielle avec du texte sélectionnable et des images intégrées. Plusieurs cadres sont empilés dans un seul fichier.",
  [EXPORT_HELP.xlsx]:
    "Un classeur avec une feuille des objets texte (y compris les champs de tâche comme le responsable, le début, l’échéance et le statut), une feuille Tâches avec les responsables et les dépendances lorsque la zone contient des tâches, une feuille par tableau de données et la liste des cadres.",
  [EXPORT_HELP.csv]:
    "Valeurs séparées par des virgules en UTF-8 pour Excel et d’autres tableurs.",
  [EXPORT_HELP.json]:
    "Un fichier Whiteboard modifiable que vous pouvez importer de nouveau.",
  [PDF_SCALE_HELP.fit]:
    "Chaque zone tient sur une seule page, réduite pour s’y ajuster. Le texte d’une grande zone peut devenir trop petit pour être lu ; choisissez Détail lisible pour la répartir sur plusieurs pages.",
  [PDF_SCALE_HELP.percent]:
    "Les zones plus grandes qu’une page sont réparties sur plusieurs pages à {scale}, avec une page de vue d’ensemble qui montre la grille des pages.",
  [PDF_SCALE_HELP.page]:
    "Chaque zone est imprimée sur une page dimensionnée selon son contenu.",
  [RENDERING_HELP.raster]:
    "Le rendu en image reproduit exactement le tableau, polices comprises. Une copie invisible de son texte et des descriptions d’images peut être recherchée, sélectionnée et lue à voix haute.",
  [RENDERING_HELP.vector]:
    "Le rendu vectoriel garde le texte et les formes nets à tout niveau de zoom et rend le texte sélectionnable. Des polices PDF standard remplacent celles du tableau, ce qui peut modifier légèrement l’espacement. Les images et les caractères absents de ces polices restent des images.",
  "Frames to export": "Cadres à exporter",
  "Documents and slides": "Documents et diapositives",
  Images: "Images",
  Spreadsheets: "Feuilles de calcul",
  Editable: "Modifiable",
  "PowerPoint slides": "Diapositives PowerPoint",
  "SVG vector image": "Image vectorielle SVG",
  "Excel workbook": "Classeur Excel",
  "CSV spreadsheet": "Feuille de calcul CSV",
  "PDF options": "Options PDF",
  "Page size": "Format de page",
  Letter: "Lettre",
  Legal: "Légal",
  Tabloid: "Tabloïd",
  A4: "A4",
  A3: "A3",
  "Fit to content": "Ajusté au contenu",
  Orientation: "Orientation",
  Automatic: "Automatique",
  Landscape: "Paysage",
  Portrait: "Portrait",
  Scale: "Échelle",
  "Readable detail": "Détail lisible",
  "Fit each area on one page": "Chaque zone sur une seule page",
  Margins: "Marges",
  Narrow: "Étroites",
  Normal: "Normales",
  Wide: "Larges",
  Rendering: "Rendu",
  "Image (matches the board exactly)": "Image (identique au tableau)",
  "Vector (text and shapes)": "Vectoriel (texte et formes)",
  "Show page boundaries and labels":
    "Afficher les limites et les libellés des pages",
  "Spreadsheet content": "Contenu de la feuille de calcul",
  "Text objects and tasks": "Objets texte et tâches",
  "Estimated length: 1 page.": "Longueur estimée : 1 page.",
  "Estimated length: {count} pages.": "Longueur estimée : {count} pages.",
  "Detail is shown at {percent}% to keep the export to a reasonable length. Export frames or a selected region for more detail.":
    "Le détail est affiché à {percent} % pour que l’exportation garde une longueur raisonnable. Exportez des cadres ou une région sélectionnée pour plus de détail.",
  "Exporting image {n} of {total}…": "Exportation de l’image {n} sur {total}…",
  "Export up to 50 frames as images at a time, or use PDF.":
    "Exportez au plus 50 cadres en images à la fois, ou utilisez le PDF.",
  "Preparing export…": "Préparation de l’exportation…",
  "Exporting page {n} of {total}…": "Exportation de la page {n} sur {total}…",
  "Exporting slide {n} of {total}…":
    "Exportation de la diapositive {n} sur {total}…",
  "Export ready.": "Exportation prête.",
});
// Feature modules add More tools entries ([action, label, run]) and shape
// library choices ({ key, name, hint, icon, run }).
const extraTools = [],
  extraShapes = [];
function versionCopyTitle(title, date) {
  let end = Math.min(title.length, 160);
  const last = title.charCodeAt(end - 1),
    next = title.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
    end--;
  return `${title.slice(0, end)} (${date})`;
}

export function addMoreTools(entries) {
  extraTools.push(...entries);
}
export function addShapeChoices(entries) {
  extraShapes.push(...entries);
}
export function createFeatures(api) {
  // Where an object of this size goes to sit in the middle of the view, or
  // beside what is already there, as a new sticky note does.
  const centred = (w, h) => {
    const c = api.viewCenter(),
      p = { x: c.x - w / 2, y: c.y - h / 2 };
    return api.openSpot ? api.openSpot(p, { w, h }) : p;
  };
  // Closing and reopening history must not start a second restore while
  // this board's previous request still waits for its version or backup.
  const historyRestores = new WeakMap();
  const selected = () =>
    api.board().items.filter((i) => api.selection().has(i.id));
  // Returns false when the board is full, so a dialog can stay open.
  function add(i) {
    if (api.board().items.length >= MAX_OBJECTS) {
      api.toast("A board can contain at most 5,000 objects.");
      return false;
    }
    api.placeItems?.([i]);
    api.mutate(() => {
      api.board().items.push(i);
      api.select(new Set([i.id]));
    });
  }
  function labelField(d, id, i, required = false) {
    const field = createTextEditor(d.ownerDocument, i || { text: "" }, {
      plainTextOnly: true,
      maxLength: 200,
      multiline: false,
    });
    field.id = id;
    field.className = "authored-label-field";
    field.tabIndex = 0;
    field.setAttribute("data-user-content", "");
    field.setAttribute("aria-labelledby", `${id}-label`);
    if (required) field.setAttribute("aria-required", "true");
    field.addEventListener("input", () =>
      field.removeAttribute("aria-invalid"),
    );
    d.querySelector(`#${id}`).replaceWith(field);
    d.addEventListener("close", () => field.destroy(), { once: true });
    field.focus();
    return field;
  }
  function saveLabel(i, text, formatting) {
    const prev = i.text || "",
      runs = clone(formatting),
      { start, end, insert } = textDifference(prev, text),
      blocks = spliceTextBlocks(prev, i.textBlocks, start, end, insert);
    if (runs.length) i.textRuns = runs;
    else delete i.textRuns;
    if (blocks.length) i.textBlocks = blocks;
    else delete i.textBlocks;
    i.text = text;
  }
  function linkDialog(i) {
    const editing = !!i;
    api.modal(
      editing ? "Edit link" : "Add link",
      `<form aria-describedby="link-conflict-error"><div class="field"><span id="link-label-label">Label</span><div id="link-label"></div><p id="link-label-error" role="alert" hidden></p></div><label class="field">URL<input id="link-url" type="text" inputmode="url" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://example.com" value="${escape(i?.url || "")}" required aria-describedby="link-url-error link-conflict-error"></label><p id="link-url-error" role="alert" hidden></p><p id="link-conflict-error" class="dialog-copy" role="alert" tabindex="-1" hidden></p><div class="dialog-footer">${editing ? '<button type="button" class="secondary" id="open-link">Open link</button>' : ""}<button class="primary" type="submit">${editing ? "Save changes" : "Add link"}</button></div></form>`,
      (d) => {
        const field = labelField(d, "link-label", i, true);
        const urlField = d.querySelector("#link-url"),
          urlError = d.querySelector("#link-url-error"),
          labelError = d.querySelector("#link-label-error"),
          form = d.querySelector("form"),
          conflictError = d.querySelector("#link-conflict-error");
        field.setAttribute(
          "aria-describedby",
          `${labelError.id} ${conflictError.id}`,
        );
        const clearConflict = () => {
          conflictError.textContent = "";
          conflictError.hidden = true;
        };
        form.addEventListener("input", clearConflict);
        form.addEventListener("change", clearConflict);
        const error = (input, message, text = "") => {
          message.textContent = text ? t(text) : "";
          message.hidden = !text;
          if (text) input.setAttribute("aria-invalid", "true");
          else input.removeAttribute("aria-invalid");
        };
        urlField.addEventListener("input", () => error(urlField, urlError));
        field.addEventListener("input", () => error(field, labelError));
        // As the fields showed them, to save only what changes here.
        const shown = {
          url: d.querySelector("#link-url").value,
          text: d.querySelector("#link-label").value,
        };
        const was = { url: i?.url || "", text: i?.text || "" };
        const openedRuns = clone(i?.textRuns || []),
          openedLanguage = i?.lang;
        if (editing)
          d.querySelector("#open-link").onclick = () =>
            window.open(safeURL(i.url), "_blank", "noopener,noreferrer");
        form.onsubmit = (e) => {
          e.preventDefault();
          clearConflict();
          // A bare host such as example.com is taken as https, as the text
          // editor's link field and the object link panel take it.
          const url = textLinkURL(urlField.value, true);
          if (!url) {
            error(urlField, urlError, "Enter a valid http or https link.");
            urlField.focus();
            return;
          }
          error(urlField, urlError);
          const text = field.value;
          if (!text) {
            error(field, labelError, "Enter a label for the link.");
            field.focus();
            return;
          }
          error(field, labelError);
          // Collaborators can lock or remove the card while this is open.
          if (editing && !api.board()?.items.includes(i)) {
            d.close();
            return api.toast("This link is no longer on the board.");
          }
          if (editing && !api.canEdit(new Set([i.id]))) return;
          if (editing) {
            // Only fields changed here are saved, and never over someone
            // else's newer value.
            const next = {};
            if (d.querySelector("#link-url").value !== shown.url)
              next.url = url;
            if (text !== shown.text) next.text = text;
            if (
              Object.keys(next).some((key) => (i[key] || "") !== was[key]) ||
              (next.text !== undefined &&
                (i.lang !== openedLanguage ||
                  !equalTextRuns(i.textRuns, openedRuns)))
            ) {
              conflictError.textContent = t(
                "This object changed. Open it again to edit it.",
              );
              conflictError.hidden = false;
              conflictError.focus();
              return;
            }
            if (Object.keys(next).length)
              api.mutate(() => {
                if (next.text !== undefined)
                  saveLabel(i, next.text, field.textRuns);
                if (next.url !== undefined) i.url = next.url;
              });
          } else {
            const p = centred(280, 115);
            if (
              add(
                item("link", p.x, p.y, {
                  url,
                  text,
                  w: 280,
                  h: 115,
                  color: "#dce5f7",
                }),
              ) === false
            )
              return;
          }
          d.close();
        };
      },
    );
  }
  function tableDialog(i) {
    let pasted = false;
    const original = i ? clone(i) : null;
    let cells = i
      ? clone(i.cells)
      : [
          [t("Label"), t("Text")],
          ["", ""],
          ["", ""],
        ];
    let cellLanguages = clone(i?.cellLanguages || {});
    api.modal(
      i ? "Edit table" : "Add table",
      `<form aria-describedby="table-conflict-error table-paste-error table-size-error"><div class="table-actions"><button type="button" data-table="row">Add row</button><button type="button" data-table="col">Add column</button><button type="button" data-table="remove-row">Remove last row</button><button type="button" data-table="remove-col">Remove last column</button></div><div id="cell-editor" class="cell-editor" aria-describedby="table-conflict-error table-paste-error table-size-error"></div><p id="table-conflict-error" class="dialog-copy" role="alert" tabindex="-1" hidden></p><p id="table-paste-error" class="dialog-copy" role="alert" hidden></p><p id="table-size-error" class="dialog-copy" role="alert" tabindex="-1" hidden></p><div class="dialog-footer"><button class="primary" type="submit">${i ? "Save changes" : "Add table"}</button></div></form>`,
      (d) => {
        const form = d.querySelector("form"),
          conflictError = d.querySelector("#table-conflict-error"),
          pasteError = d.querySelector("#table-paste-error"),
          sizeError = d.querySelector("#table-size-error");
        const clearConflict = () => {
          conflictError.textContent = "";
          conflictError.hidden = true;
        };
        const clearPaste = () => {
          pasteError.textContent = "";
          pasteError.hidden = true;
        };
        const clearSize = () => {
          sizeError.textContent = "";
          sizeError.hidden = true;
        };
        const showSize = (message) => {
          sizeError.textContent = t(message);
          sizeError.hidden = false;
          sizeError.focus();
        };
        form.addEventListener("input", clearSize);
        form.addEventListener("change", clearSize);
        form.addEventListener("input", clearPaste);
        form.addEventListener("change", clearPaste);
        form.addEventListener("input", clearConflict);
        form.addEventListener("change", clearConflict);
        let fields = [];
        const capture = () => {
          for (const input of fields) {
            const r = +input.dataset.row,
              c = +input.dataset.col,
              content = fieldContent(input);
            if (typeof cells[r]?.[c] !== "string") continue;
            cells[r][c] = content.text;
            const metadata = normalizedCellLanguage(content.text, {
              lang: content.lang,
              textRuns: content.textRuns,
            });
            if (Object.keys(metadata).length)
              cellLanguages[`${r},${c}`] = metadata;
            else delete cellLanguages[`${r},${c}`];
          }
        };
        const render = () => {
          clearConflict();
          clearPaste();
          clearSize();
          const states = new Map(
              fields.map((input) => [input.id, input.languageState()]),
            ),
            focused = d.ownerDocument.activeElement?.id;
          capture();
          fields.forEach((input) => input.destroy());
          fields = [];
          cellLanguages =
            tableLanguagePatch({ cells, cellLanguages }, cells).cellLanguages ||
            {};
          d.querySelector("#cell-editor").innerHTML =
            `<table aria-label="${t("Table cells")}"><tbody>${cells.map((row, r) => `<tr>${row.map((_, c) => `<td><span class="sr-only" id="table-dialog-cell-${r}-${c}-label">${t("Row")} ${r + 1}, ${t("Column")} ${c + 1}</span><textarea id="table-dialog-cell-${r}-${c}"></textarea></td>`).join("")}</tr>`).join("")}</tbody></table>`;
          cells.forEach((row, r) =>
            row.forEach((_, c) => {
              const id = `table-dialog-cell-${r}-${c}`,
                input = createAuthoredField(
                  d.querySelector(`#${id}`),
                  tableCellContent({ cells, cellLanguages }, r, c, false),
                  { maxLength: 2000, inheritedLanguage: i?.lang },
                );
              input.dataset.row = r;
              input.dataset.col = c;
              input.setAttribute(
                "aria-describedby",
                [
                  input.getAttribute("aria-describedby"),
                  conflictError.id,
                  pasteError.id,
                  sizeError.id,
                ]
                  .filter(Boolean)
                  .join(" "),
              );
              fields.push(input);
              const saved = states.get(id);
              if (saved) input.restoreLanguageState(saved);
              input.addEventListener("input", capture);
              input.addEventListener(
                "paste",
                (event) => {
                  if (!event.clipboardData) return;
                  clearPaste();
                  clearSize();
                  try {
                    const incomingContent = readTableContent(
                        event.clipboardData,
                      ),
                      incoming = incomingContent?.cells;
                    if (!incoming) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    capture();
                    cells = pasteTable(cells, incoming, r, c);
                    // A spreadsheet replaces cells, so old passage ranges cannot
                    // remain attached to unrelated incoming text.
                    incoming.forEach((line, y) =>
                      line.forEach((_, x) => {
                        const key = `${r + y},${c + x}`,
                          lang = cellLanguages[key]?.lang;
                        cellLanguages[key] =
                          incomingContent.cellLanguages?.[`${y},${x}`] ||
                          (lang ? { lang } : {});
                      }),
                    );
                    pasted = true;
                    fields.forEach((field) => field.destroy());
                    fields = [];
                    render();
                    d.querySelector(
                      `[data-row="${r}"][data-col="${c}"]`,
                    ).focus();
                  } catch (error) {
                    event.preventDefault();
                    pasteError.textContent = t(error.message);
                    pasteError.hidden = false;
                  }
                },
                true,
              );
            }),
          );
          if (focused)
            d.querySelector(`#${focused}`)?.focus({ preventScroll: true });
        };
        d.addEventListener(
          "close",
          () => fields.forEach((input) => input.destroy()),
          { once: true },
        );
        render();
        // The cells are what the dialog is for; the keyboard starts in the
        // first rather than on Close. A new table's sample heading is
        // selected, so typing replaces it.
        const first = fields[0];
        first?.focus({ preventScroll: true });
        if (first && !i) first.setSelectionRange(0, first.value.length);
        d.querySelectorAll("[data-table]").forEach(
          (btn) =>
            (btn.onclick = () => {
              capture();
              switch (btn.dataset.table) {
                case "row":
                  if (cells.length < 20) cells.push(cells[0].map(() => ""));
                  break;
                case "col":
                  if (cells[0].length < 12)
                    cells.forEach((row) => row.push(""));
                  break;
                case "remove-row":
                  if (cells.length > 1) cells.pop();
                  break;
                case "remove-col":
                  if (cells[0].length > 1) cells.forEach((row) => row.pop());
              }
              render();
            }),
        );
        form.onsubmit = (e) => {
          e.preventDefault();
          clearConflict();
          clearPaste();
          clearSize();
          capture();
          if (i) {
            if (
              !api.board()?.items.includes(i) ||
              !api.canEdit(new Set([i.id]))
            )
              return;
            try {
              const merged = mergeTableDraft(
                {
                  cells,
                  cellLanguages: Object.keys(cellLanguages).length
                    ? cellLanguages
                    : undefined,
                },
                original,
                i,
              );
              cells = merged.cells;
              cellLanguages = merged.cellLanguages || {};
            } catch (error) {
              conflictError.textContent = t(error.message);
              conflictError.hidden = false;
              conflictError.focus();
              return;
            }
          }
          if (i && (i.columnWidths || i.rowHeights)) {
            try {
              const patch = sizedTableCells(
                i,
                cells,
                document.createElement("canvas").getContext("2d"),
              );
              api.mutate(() =>
                Object.assign(i, patch, {
                  cellLanguages: Object.keys(cellLanguages).length
                    ? cellLanguages
                    : undefined,
                }),
              );
              d.close();
            } catch (error) {
              showSize(error.message);
            }
            return;
          }
          const w = i
            ? Math.max(i.w, cells[0].length * 140)
            : cells[0].length * 170;
          const h = Math.max(
            i?.h || 0,
            cells.length * (i ? 65 : 75),
            pasted
              ? tableHeight(
                  cells,
                  w,
                  document.createElement("canvas").getContext("2d"),
                  i,
                )
              : 0,
          );
          if (h > 1e6) {
            showSize(
              "The table is too tall. Use a smaller font or fewer lines.",
            );
            return;
          }
          if (i)
            api.mutate(() => {
              i.cells = cells;
              i.cellLanguages = Object.keys(cellLanguages).length
                ? cellLanguages
                : undefined;
              i.w = w;
              i.h = h;
            });
          else {
            const p = centred(w, h);
            if (
              add(
                item("table", p.x, p.y, {
                  cells,
                  ...(Object.keys(cellLanguages).length
                    ? { cellLanguages }
                    : {}),
                  w,
                  h,
                  color: "#ffffff",
                }),
              ) === false
            )
              return;
          }
          d.close();
        };
      },
    );
  }
  function attachFile(target) {
    const boardId = api.board().id;
    api.fileInput("*/*", async (file) => {
      try {
        if (file.size > 10 * 1024 * 1024)
          throw Error("Choose a file smaller than 10 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let start = 0; start < bytes.length; start += 32768)
          binary += String.fromCharCode(
            ...bytes.subarray(start, start + 32768),
          );
        if (api.board()?.id !== boardId) return;
        if (
          target &&
          (!api.board().items.includes(target) ||
            !api.canEdit(new Set([target.id])))
        )
          return;
        const data = "data:application/octet-stream;base64," + btoa(binary);
        if (target)
          api.mutate(() =>
            Object.assign(target, {
              data,
              fileName: file.name,
              text: file.name,
            }),
          );
        else {
          const p = centred(280, 110);
          add(
            item("file", p.x, p.y, {
              data,
              fileName: file.name,
              text: file.name,
              w: 280,
              h: 110,
              color: "#eadcf0",
            }),
          );
        }
      } catch (error) {
        api.toast(error.message);
      }
    });
  }
  function fileDialog(i) {
    api.modal(
      "File attachment",
      `<form aria-describedby="file-conflict-error"><div class="field"><span id="file-label-label">Label</span><div id="file-label"></div></div><p class="dialog-copy"><span data-user-content>${escape(i.fileName)}</span> · ${escape(fileDetails({ ...i, text: i.fileName }))}</p><p id="file-conflict-error" class="dialog-copy" role="alert" tabindex="-1" hidden></p><div class="dialog-footer"><button class="secondary" type="button" id="replace-file">Attach file</button><button class="secondary" type="button" id="download-file">Download attachment</button>${api.canImportFile?.(i) ? `<button class="secondary" type="button" id="import-file">Import contents</button>` : ""}<button class="primary">Save changes</button></div></form>`,
      (d) => {
        const field = labelField(d, "file-label", i),
          form = d.querySelector("form"),
          conflictError = d.querySelector("#file-conflict-error");
        field.setAttribute("aria-describedby", conflictError.id);
        const clearConflict = () => {
          conflictError.textContent = "";
          conflictError.hidden = true;
        };
        form.addEventListener("input", clearConflict);
        form.addEventListener("change", clearConflict);
        const opened = i.text,
          openedRuns = clone(i.textRuns || []),
          openedLanguage = i.lang;
        d.querySelector("#replace-file").onclick = () => {
          d.close();
          attachFile(i);
        };
        const importFile = d.querySelector("#import-file");
        if (importFile)
          importFile.onclick = () => {
            d.close();
            api.importAttachment(i);
          };
        d.querySelector("#download-file").onclick = () => {
          // On a shared board the file arrives after the card does.
          if (!String(i.data).startsWith("data:"))
            return api.toast(
              "The attachment is still downloading. Try again shortly.",
            );
          const raw = atob(i.data.split(",")[1]),
            bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
          api.download(bytes, i.fileName, "application/octet-stream");
        };
        form.onsubmit = (e) => {
          e.preventDefault();
          clearConflict();
          if (!api.board()?.items.includes(i) || !api.canEdit(new Set([i.id])))
            return;
          const label = field.value;
          // Unchanged here, someone else's newer label stays.
          if (label !== (opened || "")) {
            if (
              i.text !== opened ||
              i.lang !== openedLanguage ||
              !equalTextRuns(i.textRuns, openedRuns)
            ) {
              conflictError.textContent = t(
                "This object changed. Open it again to edit it.",
              );
              conflictError.hidden = false;
              conflictError.focus();
              return;
            }
            api.mutate(() => saveLabel(i, label, field.textRuns));
          }
          d.close();
        };
      },
    );
  }
  function organizeSelection(value) {
    if (!api.canEdit()) return;
    const items = api.board().items,
      ids = api.selection();
    if (!ids.size) return api.toast("Select objects first.");
    if (["front", "back", "forward", "backward"].includes(value)) {
      const next = reorderItems(items, ids, value, api.selectionOptions?.());
      if (next !== items) api.mutate(() => (api.board().items = next));
      return;
    }
    if (
      [
        "left",
        "center",
        "right",
        "top",
        "middle",
        "bottom",
        "horizontal",
        "vertical",
      ].includes(value)
    ) {
      const moves = layoutMoves(items, ids, value, api.selectionOptions?.());
      if (moves.length)
        api.mutate(() =>
          applyLayout(items, moves, { skip: api.concealedIn?.(api.board()) }),
        );
      return;
    }
    if (["frame", "connect"].includes(value) && items.length >= MAX_OBJECTS)
      return api.toast("A board can contain at most 5,000 objects.");
    if (value === "ungroup" && !items.some((i) => ids.has(i.id) && i.groupId))
      return;
    if (value === "group" && isWholeGroup(items, ids, api.selectionOptions?.()))
      return api.toast("Already grouped.");
    api.mutate(() => {
      if (value === "group")
        api.select(group(items, ids, api.selectionOptions?.()));
      else if (value === "ungroup") ungroup(items, ids);
      else if (value === "connect") {
        const arrow = connectObjects(items, ids);
        api.select(new Set([arrow.id]));
      } else if (value === "frame") {
        // Named as a frame drawn with the Frame tool is.
        const frame = createFrame(
          items,
          ids,
          nextFrameTitle(items, t("Frame")),
          api.selectionOptions?.(),
        );
        api.select(new Set([frame.id]));
      }
    });
  }
  function organize() {
    if (!api.canEdit()) return;
    if (!api.selection().size) {
      api.toast("Select objects first.");
      return;
    }
    const items = api.board().items,
      ids = api.selection();
    const count = layoutUnits(items, ids, api.selectionOptions?.()).length;
    // Frames hidden from this person are not offered to move into.
    const concealed = api.concealedIn?.(api.board()) || new Set();
    const options = (entries, disabled = false) =>
      entries
        .map(
          ([key, label]) =>
            `<button data-organize="${key}" ${disabled ? "disabled" : ""}>${label}</button>`,
        )
        .join("");
    api.modal(
      "Organize selection",
      `<div class="arrange-sections">
      <fieldset><legend>Position</legend><button type="button" class="secondary" data-organize="move">Move selection</button></fieldset>
      <fieldset><legend>Alignment</legend><div class="arrange-grid">${options(
        [
          ["left", "Align left"],
          ["top", "Align top"],
          ["center", "Center horizontally"],
          ["middle", "Center vertically"],
          ["right", "Align right"],
          ["bottom", "Align bottom"],
        ],
        count < 2,
      )}</div></fieldset>
      <fieldset><legend>Spacing</legend><p class="dialog-copy">Select at least three objects or groups to distribute evenly.</p><div class="arrange-grid">${options(
        [
          ["horizontal", "Distribute horizontally"],
          ["vertical", "Distribute vertically"],
        ],
        count < 3,
      )}</div></fieldset>
      <fieldset><legend>Layer order</legend><div class="arrange-grid">${[
        ["front", "Bring to front"],
        ["forward", "Bring forward"],
        ["backward", "Send backward"],
        ["back", "Send to back"],
      ]
        .map((entry) =>
          options(
            [entry],
            reorderItems(items, ids, entry[0], api.selectionOptions?.()) ===
              items,
          ),
        )
        .join("")}</div></fieldset>
      <fieldset><legend>Group and organize</legend><div class="arrange-grid">${options(
        [
          ["group", "Group selection"],
          ["ungroup", "Ungroup selection"],
          ["connect", "Connect selected objects"],
          ["frame", "Create frame around selection"],
          ["cluster", "Cluster sticky notes"],
          ["snippet", "Save as reusable content"],
        ],
      )}</div></fieldset>
      ${frameChoicesHTML(
        orderedFrames(items).filter((f) => !concealed.has(f.id)),
        "parent-frame",
        "Move into frame",
        true,
      )}<button class="secondary" id="assign-frame">Move into frame</button></div>`,
      (d) => {
        d.querySelectorAll("[data-organize]").forEach(
          (btn) =>
            (btn.onclick = () => {
              try {
                const value = btn.dataset.organize;
                if (value === "move") {
                  d.close();
                  api.moveSelection();
                  return;
                }
                if (value === "cluster") {
                  d.close();
                  openClusters(api);
                  return;
                }
                if (value === "snippet") {
                  d.close();
                  saveSnippet();
                  return;
                }
                organizeSelection(value);
                d.close();
              } catch (error) {
                api.toast(error.message);
              }
            }),
        );
        d.querySelector("#assign-frame").onclick = () => {
          // A collaborator may have removed the frame or locked the
          // selection meanwhile; that is said, and the dialog stays.
          try {
            const parent = d.querySelector("#parent-frame input:checked").value;
            if (!api.canEdit(api.selection())) return;
            if (
              parent &&
              !api
                .board()
                .items.some((i) => i.id === parent && i.type === "frame")
            )
              throw Error("Choose a valid frame.");
            api.mutate(() =>
              attachToFrame(api.board().items, api.selection(), parent),
            );
            d.close();
          } catch (error) {
            api.toast(error.message);
          }
        };
      },
    );
  }
  function presentationSetup() {
    const frames = orderedFrames((api.visualBoard?.() || api.board()).items);
    api.modal(
      "Presentation",
      `<p class="dialog-copy">${frames.length ? "Choose frames in presentation order." : "This board has no frames, so it presents as one slide. Add frames to make slides."}</p>${frames.length > 1 ? `<div class="slide-choice-actions"><button type="button" class="text-btn" id="slides-all">${t("Select all")}</button><button type="button" class="text-btn" id="slides-none">${t("Select none")}</button></div>` : ""}<div class="slide-choices" role="group" aria-label="${t("Frames")}" ${frames.length ? "" : "hidden"}>${frames.map((f) => `<label><input type="checkbox" value="${escape(f.id)}" aria-describedby="presentation-error" checked><span>${frameTitleHTML(f)}</span></label>`).join("")}</div><p id="presentation-error" class="dialog-copy" role="alert" hidden></p><div class="dialog-footer">${api.selection().size ? '<button class="secondary" id="present-selection">Present selection</button>' : ""}<button class="primary" id="start-presentation">${frames.length ? "Start presentation" : "Present board"}</button></div>`,
      (d) => {
        const choices = d.querySelector(".slide-choices"),
          error = d.querySelector("#presentation-error");
        const clearError = () => {
          error.textContent = "";
          error.hidden = true;
          choices.removeAttribute("aria-invalid");
        };
        choices.addEventListener("change", () => {
          if (choices.querySelector("input:checked")) clearError();
        });
        // With many frames, presenting a few starts from none.
        for (const [id, checked] of [
          ["#slides-all", true],
          ["#slides-none", false],
        ]) {
          const button = d.querySelector(id);
          if (button)
            button.onclick = () => {
              for (const input of choices.querySelectorAll("input"))
                input.checked = checked;
              if (checked) clearError();
            };
        }
        d.querySelector("#start-presentation").onclick = () => {
          const ids = [...choices.querySelectorAll("input:checked")].map(
            (e) => e.value,
          );
          if (frames.length && !ids.length) {
            error.textContent = t("Choose at least one frame.");
            error.hidden = false;
            choices.setAttribute("aria-invalid", "true");
            choices.querySelector("input")?.focus();
            return;
          }
          clearError();
          start({
            scope: frames.length ? "frames" : "board",
            frameIds: ids,
          });
        };
        // Collaborators can remove the chosen frames, or the selection, while
        // this dialog is open; the reason then shows here instead of nothing.
        function start(options) {
          let regions;
          try {
            regions = exportRegions(
              api.visualBoard?.() || api.board(),
              options,
            );
          } catch (e) {
            error.textContent = t(e.message);
            error.hidden = false;
            return;
          }
          d.close();
          present(regions, () =>
            exportRegions(api.visualBoard?.() || api.board(), options),
          );
        }
        const btn = d.querySelector("#present-selection");
        if (btn)
          btn.onclick = () => {
            clearError();
            start({ scope: "selection", selection: api.selection() });
          };
      },
    );
  }
  function present(regions, refresh = null) {
    // A selected frame is where the presentation starts, as in Miro.
    let index = Math.max(
      0,
      regions.findIndex((r) => r.frameId && api.selection().has(r.frameId)),
    );
    const dialog = api.modal(
      "Presentation",
      `<div class="presentation-stage"><canvas id="slide-canvas" role="img" tabindex="0" aria-labelledby="slide-title" aria-describedby="slide-outline"></canvas></div><div class="presentation-controls"><button class="secondary" id="slide-prev">Previous slide</button><span id="slide-count" role="status" aria-live="polite"></span><button class="secondary" id="slide-next">Next slide</button><button class="secondary" id="slide-fullscreen">Fullscreen</button><button class="primary" id="slide-exit">Exit presentation</button></div><p class="presentation-hint"><span class="hint-keys">${t("Use arrow keys or Space to navigate slides. Press Escape to exit.")}</span><span class="hint-touch">${t("Swipe left or right, or use the buttons, to change slides.")}</span></p><div id="slide-outline" class="sr-only"></div>`,
      (d) => {
        d.classList.add("presentation-dialog");
        api.presentTimer?.(d);
        api.presentReactions?.(d);
        const canvas = d.querySelector("canvas");
        const render = () => {
          const region = regions[index],
            r = canvas.getBoundingClientRect(),
            z = Math.min(
              (r.width || 900) / region.rect.w,
              (r.height || 500) / region.rect.h,
            );
          // The frame is the slide, as in Miro: its editing outline and
          // its title are left out, and only what it holds is shown.
          paint(
            canvas,
            region.items.filter((i) => i.id !== region.frameId),
            {
              x: (r.width || 900) / 2 - (region.rect.x + region.rect.w / 2) * z,
              y:
                (r.height || 500) / 2 - (region.rect.y + region.rect.h / 2) * z,
              z,
            },
            {
              background: "#ffffff",
              textColor: "#30342f",
              mindCounts: region.mindCounts,
              tags: api.board().tags,
            },
          );
          api.presentAttention?.(d, region.rect, {
            ...(region.frameId ? { frame: region.frameId } : {}),
            at: index + 1,
            of: regions.length,
          });
          const frame = region.items.find((i) => i.id === region.frameId);
          const name = frame?.text
            ? frameTitleHTML(frame)
            : `<span data-user-content>${escape(region.name)}</span>`;
          // A facilitator sees, and is told, which slides participants
          // brought along would find covered.
          const hidden =
            region.frameId && api.hiddenFromParticipants?.(region.frameId);
          // The count is a status, read whenever it is written, so it is
          // written only when it says something new, not when the board
          // redraws the slide for a timer or someone else's change.
          const count = `${index + 1} / ${regions.length} · <span id="slide-title">${name}</span>${hidden ? ` <span class="badge slide-hidden">${t("Hidden from participants")}</span>` : ""}`;
          const status = d.querySelector("#slide-count");
          if (status.dataset.shown !== count) {
            status.innerHTML = count;
            status.dataset.shown = count;
          }
          const prev = d.querySelector("#slide-prev"),
            next = d.querySelector("#slide-next");
          prev.disabled = index === 0;
          next.disabled = index === regions.length - 1;
          // A button that disables under the keyboard hands it to the other
          // one, or to the slide, so the arrow keys still turn the slides.
          if (document.activeElement?.disabled)
            (document.activeElement === next && !prev.disabled
              ? prev
              : document.activeElement === prev && !next.disabled
                ? next
                : canvas
            ).focus();
          d.querySelector("#slide-outline").innerHTML = region.items
            .map((i) => objectNameHTML(i))
            .join(". ");
        };
        const move = (delta) => {
          index = Math.max(0, Math.min(regions.length - 1, index + delta));
          render();
        };
        d.querySelector("#slide-prev").onclick = () => move(-1);
        d.querySelector("#slide-next").onclick = () => move(1);
        // A finger or pen swiping across the slide turns it: left for the
        // next, right for the previous, as on a phone or tablet.
        let swipe = null;
        canvas.addEventListener("pointerdown", (e) => {
          swipe =
            e.pointerType === "mouse"
              ? null
              : { id: e.pointerId, x: e.clientX, y: e.clientY };
        });
        canvas.addEventListener("pointerup", (e) => {
          if (swipe?.id !== e.pointerId) return;
          const dx = e.clientX - swipe.x,
            dy = e.clientY - swipe.y;
          swipe = null;
          if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5)
            move(dx < 0 ? 1 : -1);
        });
        canvas.addEventListener("pointercancel", () => (swipe = null));
        d.querySelector("#slide-exit").onclick = () => d.close();
        d.querySelector("#slide-fullscreen").onclick = async () => {
          try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await d.requestFullscreen();
            render();
          } catch {
            api.toast("Fullscreen is unavailable. Presentation remains open.");
          }
        };
        d.addEventListener("keydown", (e) => {
          // Space and Enter turn the slide, as presentation clickers send
          // them, except on a button, which they press.
          const pressing =
            [" ", "Enter"].includes(e.key) && e.target.closest?.("button");
          const forward = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"],
            back = ["ArrowLeft", "ArrowUp", "PageUp"];
          if (
            !pressing &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            [...forward, ...back, "Home", "End"].includes(e.key)
          ) {
            e.preventDefault();
            if (e.key === "Home") index = 0;
            else if (e.key === "End") index = regions.length - 1;
            else
              index = Math.max(
                0,
                Math.min(
                  regions.length - 1,
                  index +
                    (forward.includes(e.key) && !(e.key === " " && e.shiftKey)
                      ? 1
                      : -1),
                ),
              );
            render();
          }
        });
        window.addEventListener("resize", render);
        // Slides show the board as it is, as in Miro: what collaborators
        // change, add or delete while it is presented shows on the next
        // look, keeping to the frame being shown.
        const presented = api.board();
        const signature = () => {
          const b = api.board();
          return b && [b.items, b.items.length, b.updated, b.workshop];
        };
        let seen = signature();
        const live = refresh
          ? setInterval(() => {
              // Leaving the board, as with Back, ends its presentation.
              if (api.board() !== presented) return d.close();
              const now = signature();
              if (!now || now.every((v, n) => v === seen?.[n])) return;
              seen = now;
              const shown = regions[index]?.frameId;
              // Nothing left to present, as when the facilitator hides or
              // stages every presented frame or all of them are deleted,
              // ends the presentation; showing the slides from before would
              // show what is now hidden.
              let next;
              try {
                next = refresh();
              } catch {
                next = [];
              }
              // Frames deleted or hidden meanwhile leave the presentation.
              const ids = new Set(
                (api.visualBoard?.() || api.board()).items.map((i) => i.id),
              );
              next = next.filter((r) => !r.frameId || ids.has(r.frameId));
              if (!next.length) {
                api.toast("The presented frames are no longer available.");
                return d.close();
              }
              regions = next;
              const at = shown
                ? regions.findIndex((r) => r.frameId === shown)
                : -1;
              index = at >= 0 ? at : Math.min(index, regions.length - 1);
              render();
            }, 500)
          : null;
        d.addEventListener("close", () => {
          clearInterval(live);
          window.removeEventListener("resize", render);
          if (document.fullscreenElement === d)
            document.exitFullscreen().catch(() => {});
          // The board opens on the last slide shown.
          if (api.board() && api.board() === presented)
            api.focusRegion?.(regions[index].rect);
        });
        render();
        canvas.focus();
      },
    );
    return dialog;
  }
  // Someone following a presenter sees the slide shown, from their own view
  // of the board, so what is hidden from them stays hidden, and nothing
  // around it: the space a different screen shape leaves is plain. A frame
  // is found again by its id; a selection or the whole board shows the area
  // presented. Unchanged slides are not painted again.
  let followed = null;
  function followSlide(canvas, camera, slide) {
    const b = api.board();
    if (!b) return null;
    const r = canvas.getBoundingClientRect(),
      width = r.width || 900,
      height = r.height || 500;
    const key = JSON.stringify([camera, slide, width, height, language]);
    if (
      followed?.canvas === canvas &&
      followed.key === key &&
      followed.items === b.items &&
      followed.count === b.items.length &&
      followed.updated === b.updated &&
      followed.workshop === b.workshop
    )
      return followed.shown;
    const seen = api.visualBoard?.() || b,
      area = {
        x: camera.x - camera.w / 2,
        y: camera.y - camera.h / 2,
        w: camera.w,
        h: camera.h,
      };
    let region = null;
    if (slide.frame)
      try {
        region = exportRegions(seen, {
          scope: "frames",
          frameIds: [slide.frame],
        })[0];
      } catch {
        region = null;
      }
    region ??= exportRegions(seen, { scope: "region", region: area })[0];
    const { rect } = region,
      z = Math.min(width / rect.w, height / rect.h),
      view = {
        x: width / 2 - (rect.x + rect.w / 2) * z,
        y: height / 2 - (rect.y + rect.h / 2) * z,
        z,
      },
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    paint(
      canvas,
      region.items.filter((i) => i.id !== region.frameId),
      view,
      {
        background: "#ffffff",
        textColor: "#30342f",
        mindCounts: region.mindCounts,
        tags: b.tags,
        width,
        height,
        dpr,
      },
    );
    // Objects reaching past the slide's edge are cut off there.
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = SLIDE_SURROUND;
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.rect(
        view.x + rect.x * z,
        view.y + rect.y * z,
        rect.w * z,
        rect.h * z,
      );
      ctx.fill("evenodd");
    }
    const frame = region.items.find((i) => i.id === region.frameId);
    const shown = {
      name: frame?.text
        ? frameTitleHTML(frame)
        : `<span data-user-content>${escape(region.name)}</span>`,
      outline: region.items
        .filter((i) => i.id !== region.frameId)
        .map((i) => objectNameHTML(i))
        .join(". "),
    };
    followed = {
      canvas,
      key,
      items: b.items,
      count: b.items.length,
      updated: b.updated,
      workshop: b.workshop,
      shown,
    };
    return shown;
  }
  async function versions() {
    const openedBoard = api.board(),
      boardId = openedBoard.id;
    const shared = api.sharedHistory?.();
    // Someone who cannot edit the board sees its versions and can open one
    // as a copy, but is not offered restoring.
    const readOnly = () => !!api.readOnly?.();
    const retention = `<details class="history-retention"><summary>${t("How long versions are kept")}</summary><p class="dialog-copy">${t("The 30 most recent versions are kept on this device, and one for each quarter hour of the last 30 days (up to 200 more), within 50 MB; when space runs short, the last version of each day is kept before the others. Pictures shared by several versions are stored once. Named checkpoints and the version saved before each restoration are kept apart from these: the newest 100, within another 50 MB.")}</p></details>`;
    const d = api.modal(
      "Version history",
      `<div class="history-layout"><section class="history-preview" aria-labelledby="history-preview-title"><div class="history-preview-head"><div class="history-preview-name"><strong id="history-preview-title">${t("Preview of the version")}</strong><small id="history-preview-meta"></small></div><div class="history-zoom" role="group" aria-label="${t("Preview of the version")}"><button type="button" class="icon-btn" data-preview-zoom="out" aria-label="${t("Zoom out of the preview")}" title="${t("Zoom out of the preview")}" disabled><i data-lucide="minus" aria-hidden="true"></i></button><button type="button" class="icon-btn" data-preview-zoom="fit" aria-label="${t("Fit the version in the preview")}" title="${t("Fit the version in the preview")}" disabled><i data-lucide="maximize" aria-hidden="true"></i></button><button type="button" class="icon-btn" data-preview-zoom="in" aria-label="${t("Zoom in on the preview")}" title="${t("Zoom in on the preview")}" disabled><i data-lucide="plus" aria-hidden="true"></i></button></div></div><div class="history-stage"><canvas id="history-preview-canvas" role="img" tabindex="0" aria-describedby="history-changes history-preview-help" hidden></canvas><p class="history-empty">${t("Choose a version to see the board as it was then, with what has changed since.")}</p></div><p id="history-preview-help" class="sr-only">${t("Drag to move around this version. Ctrl/Cmd + scroll, a pinch or the + and - keys zoom.")}</p><div class="history-changes" id="history-changes" role="status" aria-live="polite"></div></section><div class="history-sidebar"><p class="dialog-copy">${t(shared ? "Everyone's edits to this shared board are kept, so any earlier version can be restored. Restoring saves a new version and never removes history." : "Versions of this board are saved on this device as you edit. Restoring one keeps the current version first, and Undo takes it back.")}</p>${shared ? "" : retention}${readOnly() ? `<p class="dialog-copy">${t("You can view earlier versions and open one as a copy. Only people who can edit this board restore versions.")}</p>` : ""}<p id="history-status" class="dialog-copy" role="status" aria-live="polite" tabindex="-1" hidden></p>${shared ? `<h3>${t("Shared board history")}</h3><div class="revision-list" id="shared-revisions"><p>${t("Loading…")}</p></div>` : ""}<h3>${t("Versions on this device")}</h3>${shared ? retention : ""}<details class="checkpoint-details"><summary autofocus><i data-lucide="bookmark-plus" aria-hidden="true"></i>${t("Name the current version")}</summary><form class="checkpoint-create"><label class="field">Checkpoint name<input id="checkpoint-label" maxlength="120" value="${t("Checkpoint")}"></label><button class="primary" id="checkpoint-create">Create checkpoint</button></form></details><label class="history-filter"><input type="checkbox" id="history-named">${t("Named versions only")}</label><div class="revision-list" id="local-revisions"></div></div></div>`,
    );
    // A history dialog can stay open through address-bar navigation. Its
    // versions must never be restored into whichever board is now open.
    function onBoard() {
      if (api.board() === openedBoard) return true;
      const status = d.querySelector("#history-status");
      delete status.dataset.restoring;
      status.textContent = t(
        "You’re viewing a different board. Return to the original board to use this history, or close this dialog and open history again.",
      );
      status.hidden = false;
      if (d.isConnected) status.focus();
      return false;
    }
    d.classList.add("history-dialog");
    // The chosen version is shown beside the list, as the board was then,
    // with what changed since pointed out.
    const stage = d.querySelector(".history-stage"),
      previewCanvas = stage.querySelector("canvas"),
      previewer = createVersionPreview(stage),
      changesNote = d.querySelector("#history-changes"),
      highlight = () =>
        d.querySelector("#history-highlight")?.checked !== false;
    d.addEventListener("close", () => previewer.destroy(), { once: true });
    d.querySelectorAll("[data-preview-zoom]").forEach((button) => {
      const zoom = button.dataset.previewZoom;
      button.onclick = () =>
        zoom === "in"
          ? previewer.zoomIn()
          : zoom === "out"
            ? previewer.zoomOut()
            : previewer.fit();
    });
    // Each version is read once while the dialog is open to show it and to
    // list its restore options; restoring reads it again.
    const loaded = new Map();
    const cachedLoad = (key, load) => {
      if (!loaded.has(key)) {
        let pending;
        try {
          pending = Promise.resolve(load());
        } catch (error) {
          pending = Promise.reject(error);
        }
        loaded.set(
          key,
          pending.catch((error) => {
            loaded.delete(key);
            throw error;
          }),
        );
      }
      return loaded.get(key);
    };
    // How each listed version is named and read, by its key ("l:" and the
    // id of a version on this device, "s:" and the time of a shared one).
    const sources = new Map();
    let picked = null;
    const markPicked = () =>
      d.querySelectorAll("[data-pick]").forEach((button) => {
        const on = button.dataset.pick === picked;
        button.setAttribute("aria-pressed", String(on));
        button.closest(".revision-row")?.classList.toggle("picked", on);
      });
    async function pick(key) {
      const source = sources.get(key);
      if (!source || !onBoard()) return;
      picked = key;
      markPicked();
      d.querySelector("#history-preview-title").textContent = source.title;
      d.querySelector("#history-preview-meta").textContent = source.meta;
      changesNote.textContent = t("Loading this version…");
      let version;
      try {
        version = await cachedLoad(key, source.load);
      } catch (error) {
        if (picked === key && d.isConnected)
          changesNote.textContent = t(
            error.message || "Could not load this version.",
          );
        return;
      }
      if (picked !== key || !d.isConnected || !onBoard()) return;
      // Nothing the workshop hides from this person, then or now, is shown
      // or counted.
      const current = api.board(),
        hidden = api.concealedIn
          ? new Set([...api.concealedIn(version), ...api.concealedIn(current)])
          : new Set(),
        items = version.items.filter((i) => !hidden.has(i.id)),
        changes = versionChanges(
          current.items.filter((i) => !hidden.has(i.id)),
          items,
        );
      previewCanvas.hidden = false;
      stage.querySelector(".history-empty").hidden = true;
      d.querySelectorAll("[data-preview-zoom]").forEach(
        (button) => (button.disabled = false),
      );
      previewCanvas.setAttribute(
        "aria-label",
        `${t("Preview of the version")}: ${source.title}, ${source.meta}`,
      );
      previewer.show({
        items,
        tags: version.tags,
        changes,
        highlight: highlight(),
      });
      const counts = [
        ["removed", changes.removed.size, "{count} deleted since"],
        ["changed", changes.changed.size, "{count} changed since"],
        ["added", changes.added, "{count} added since"],
      ].filter(([, count]) => count);
      changesNote.innerHTML = `<span>${plural(items.length, "{count} object", "{count} objects")}</span>${
        counts.length
          ? counts
              .map(
                ([kind, count, text]) =>
                  `<span class="history-change" data-change="${kind}">${plural(count, text, text)}</span>`,
              )
              .join("")
          : `<span>${t("Same as the board now.")}</span>`
      }${
        changes.removed.size || changes.changed.size
          ? `<label class="history-highlight"><input type="checkbox" id="history-highlight" ${highlight() ? "checked" : ""}>${t("Highlight changes")}</label>`
          : ""
      }`;
      changesNote
        .querySelector("#history-highlight")
        ?.addEventListener("change", (e) =>
          previewer.highlight(e.currentTarget.checked),
        );
    }
    // The preview goes back to its hint, as when a shown version is deleted.
    function unpick() {
      picked = null;
      previewer.clear();
      previewCanvas.hidden = true;
      stage.querySelector(".history-empty").hidden = false;
      changesNote.textContent = "";
      d.querySelector("#history-preview-title").textContent = t(
        "Preview of the version",
      );
      d.querySelector("#history-preview-meta").textContent = "";
      d.querySelectorAll("[data-preview-zoom]").forEach(
        (button) => (button.disabled = true),
      );
      markPicked();
    }
    // A restore can await both a shared version and its recovery backup.
    // Keep every history action from starting a competing restoration.
    const restoreState = historyRestores.get(openedBoard) || {
      pending: false,
      dialogs: new Set(),
    };
    historyRestores.set(openedBoard, restoreState);
    let releaseControls = [];
    function releaseHeldControls() {
      for (const release of releaseControls) release();
      releaseControls = [];
    }
    function syncRestoreControls() {
      const status = d.querySelector("#history-status");
      if (restoreState.pending) {
        if (status.hidden || status.dataset.restoring) {
          status.textContent = t(
            "Restoring a version. Please wait before choosing another.",
          );
          status.hidden = false;
          status.dataset.restoring = "true";
        }
        holdControls();
      } else {
        if (status.dataset.restoring) {
          status.hidden = true;
          delete status.dataset.restoring;
        }
        releaseHeldControls();
      }
    }
    restoreState.dialogs.add(syncRestoreControls);
    d.addEventListener(
      "close",
      () => {
        restoreState.dialogs.delete(syncRestoreControls);
        releaseHeldControls();
      },
      { once: true },
    );
    syncRestoreControls();
    function holdControls() {
      if (!restoreState.pending || !d.isConnected) return;
      d.querySelectorAll(
        ".revision-list button, .revision-list input, #checkpoint-create",
      ).forEach((control) => {
        if (!control.disabled) releaseControls.push(busy(control));
      });
    }
    function beginRestore(button) {
      if (!onBoard() || restoreState.pending || button.disabled) return null;
      restoreState.pending = true;
      const done = busy(button);
      for (const sync of restoreState.dialogs) sync();
      return () => {
        restoreState.pending = false;
        done();
        for (const sync of restoreState.dialogs) sync();
      };
    }
    const locale = () => (language === "fr" ? "fr-CA" : "en-CA");
    const when = (at) => new Date(at).toLocaleString(locale());
    // Versions are listed under their day, at the minute they were saved;
    // seconds tell apart neighbours saved in the same minute.
    const clock = (at, seconds = false) =>
      new Date(at).toLocaleTimeString(locale(), {
        hour: "numeric",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
      });
    const clocks = (times) => {
      const short = times.map((at) => clock(at));
      return times.map((at, n) =>
        short[n] === short[n - 1] || short[n] === short[n + 1]
          ? clock(at, true)
          : short[n],
      );
    };
    function dayName(at) {
      const date = new Date(at),
        today = new Date(),
        start = (x) =>
          new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(),
        days = Math.round((start(today) - start(date)) / 86400_000);
      if (days === 0) return t("Today");
      if (days === 1) return t("Yesterday");
      return date.toLocaleDateString(locale(), {
        weekday: "long",
        month: "long",
        day: "numeric",
        ...(date.getFullYear() !== today.getFullYear()
          ? { year: "numeric" }
          : {}),
      });
    }
    // Rows, each under the heading of its day.
    const byDay = (entries, row) => {
      let day = null;
      const times = clocks(entries.map((e) => e.at));
      return entries
        .map((e, n) => {
          const name = dayName(e.at),
            heading =
              name === day
                ? ""
                : `<h4 class="revision-day">${escape(name)}</h4>`;
          day = name;
          return heading + row(e, times[n], name);
        })
        .join("");
    };
    // Granular restore choices for one version, loaded on demand.
    // `onDevice` versions are this device's own; the audit log records a
    // restoration from them without a shared version's time.
    function manageHTML(id) {
      const r = id && find(id);
      if (!r) return "";
      const named = keptRevision(r);
      return `<div class="revision-manage"><button type="button" class="text-btn" data-manage="name">${t(named ? "Rename" : "Name this version")}</button>${named ? `<button type="button" class="text-btn danger" data-manage="delete">${t("Delete version")}</button>` : ""}</div><form class="revision-rename" hidden><label class="field">${t("Version name")}<input maxlength="120" required></label><div class="dialog-footer"><button type="button" class="secondary" data-manage="cancel">${t("Cancel")}</button><button class="primary">${t("Save name")}</button></div></form><div class="revision-delete" role="group" aria-label="${t("Delete version")}" hidden><p class="dialog-copy">${t("This version is removed from this device for good.")}</p><div class="dialog-footer"><button type="button" class="secondary" data-manage="keep">${t("Keep version")}</button><button type="button" class="primary danger-fill" data-manage="confirm">${t("Delete version")}</button></div></div>`;
    }
    // Naming, renaming and deleting a version on this device, from its
    // restore options. Deleting asks first, in place.
    function manage(panel, id) {
      const actions = panel.querySelector(".revision-manage"),
        form = panel.querySelector(".revision-rename"),
        input = form.querySelector("input"),
        confirm = panel.querySelector(".revision-delete"),
        options = panel.previousElementSibling?.querySelector(
          "[data-revision-options]",
        );
      const show = (part) => {
        actions.hidden = part !== actions;
        form.hidden = part !== form;
        confirm.hidden = part !== confirm;
      };
      // Once the list shows the change, the keyboard goes back to the row.
      const finish = async (message) => {
        panel.remove();
        options?.setAttribute("aria-expanded", "false");
        await render();
        api.toast(message);
        const row = d.querySelector(`[data-revision-options="${id}"]`);
        (
          row || d.querySelector("#local-revisions [data-revision-options]")
        )?.focus({ preventScroll: true });
      };
      panel.querySelector('[data-manage="name"]').onclick = () => {
        const r = find(id);
        input.value = r && keptRevision(r) ? t(r.label) : "";
        show(form);
        input.focus();
      };
      panel
        .querySelector('[data-manage="delete"]')
        ?.addEventListener("click", () => {
          show(confirm);
          confirm.querySelector('[data-manage="keep"]').focus();
        });
      for (const back of panel.querySelectorAll(
        '[data-manage="cancel"], [data-manage="keep"]',
      ))
        back.onclick = () => {
          show(actions);
          actions.querySelector("button").focus();
        };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const label = input.value.trim();
        if (!label || !onBoard()) return;
        const done = busy(form.querySelector(".primary"));
        try {
          await api.local.nameRevision(id, label);
          if (picked === `l:${id}`)
            d.querySelector("#history-preview-title").textContent = label;
          await finish("Version named.");
        } catch {
          api.toast("Could not name this version.");
        } finally {
          done();
        }
      };
      confirm.querySelector('[data-manage="confirm"]').onclick = async (e) => {
        if (!onBoard()) return;
        const done = busy(e.currentTarget);
        try {
          await api.local.removeRevision(id);
          if (picked === `l:${id}`) unpick();
          await finish("Version deleted.");
        } catch {
          api.toast("Could not delete this version.");
        } finally {
          done();
        }
      };
    }
    // `removed`, for a shared version, reads the objects that were added and
    // deleted again within it, which no listed version holds.
    async function options(
      button,
      load,
      at,
      onDevice = false,
      key = null,
      removed = null,
    ) {
      if (!onBoard() || restoreState.pending || button.disabled) return;
      const row = button.closest(".revision-row");
      if (key && picked !== key) pick(key);
      // A version on this device can be named, renamed or deleted.
      const localId = onDevice && key?.startsWith("l:") ? key.slice(2) : null;
      const existing = row.nextElementSibling;
      if (existing?.classList.contains("revision-options")) {
        existing.remove();
        button.setAttribute("aria-expanded", "false");
        return;
      }
      const done = busy(button);
      let version, passing;
      try {
        [version, passing] = await Promise.all([
          load(),
          removed ? removed().catch(() => null) : null,
        ]);
      } catch (error) {
        api.toast(error.message || "Could not load this version.");
        return;
      } finally {
        done();
        holdControls();
      }
      if (!row.isConnected || !d.isConnected || !onBoard()) return;
      const current = api.board();
      // Objects deleted within the version can be recovered with those
      // deleted since, behind what the version holds.
      const held = new Set(version.items.map((i) => i.id)),
        brief = (Array.isArray(passing?.items) ? passing.items : []).filter(
          (i) => i && !held.has(i.id),
        ),
        known = new Set((version.tags || []).map((tag) => tag.id)),
        everything = brief.length
          ? {
              ...version,
              items: [...version.items, ...brief],
              tags: [
                ...(version.tags || []),
                ...(passing.tags || []).filter((tag) => !known.has(tag?.id)),
              ],
            }
          : version;
      // What the workshop hides from this person, then or now, is not
      // named or counted here.
      const hidden = api.concealedIn
        ? new Set([...api.concealedIn(everything), ...api.concealedIn(current)])
        : new Set();
      const shown = version.items.filter((i) => !hidden.has(i.id));
      const frames = shown.filter((i) => i.type === "frame");
      // Nothing hidden from this person is restored or recovered either.
      const visible = { ...version, items: shown },
        recovering = {
          ...everything,
          items: everything.items.filter((i) => !hidden.has(i.id)),
        };
      const missing = deletedSince(current, recovering);
      // Deleted objects can be recovered one by one, as in Miro; a line
      // attached to them comes back with what it joins.
      const recoverable = missing.filter(
          (i) => i.type !== "arrow" || (!i.startId && !i.endId),
        ),
        listed = recoverable.slice(0, 300),
        unlisted = recoverable.slice(300);
      const selected = [...api.selection()];
      const panel = document.createElement("div");
      panel.className = "revision-options";
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", t("Restore options"));
      panel.innerHTML = `<p class="dialog-copy">${plural(shown.length, "{count} object", "{count} objects")} · <span data-user-content>${escape(version.title)}</span></p><div class="dialog-footer"><button class="secondary" data-part="objects" ${selected.length && !readOnly() ? "" : "disabled"}>${t("Restore selected objects")} (${selected.length})</button><button class="secondary" data-part="deleted" ${recoverable.length && !readOnly() ? "" : "disabled"}>${t("Recover deleted objects")} (${recoverable.length})</button><button class="secondary" data-part="copy">${t("Open as a copy")}</button></div>${
        recoverable.length > 1
          ? `<details class="connection-choices deleted-choices"><summary>${t("Choose deleted objects")}</summary><fieldset class="frame-choices"><legend class="sr-only">${t("Deleted objects")}</legend><div class="slide-choices">${listed.map((i) => `<label><input type="checkbox" value="${escape(i.id)}" checked><span>${objectNameHTML(i, 120)}</span></label>`).join("")}</div>${unlisted.length ? `<p class="dialog-copy">${t("The first {shown} are listed; the other {rest} are recovered with them.").replace("{shown}", listed.length).replace("{rest}", unlisted.length)}</p>` : ""}</fieldset></details>`
          : ""
      }${frames.length ? `${frameChoicesHTML(frames, "restore-frame", "Frame")}<button class="secondary" data-part="frame" ${readOnly() ? "disabled" : ""}>${t("Restore this frame")}</button>` : ""}${manageHTML(localId)}`;
      row.after(panel);
      if (localId) manage(panel, localId);
      button.setAttribute("aria-expanded", "true");
      const chosenDeleted = () =>
        new Set([
          ...[...panel.querySelectorAll(".deleted-choices input:checked")].map(
            (input) => input.value,
          ),
          ...(panel.querySelector(".deleted-choices")
            ? unlisted
            : recoverable
          ).map((i) => i.id),
        ]);
      panel
        .querySelector(".deleted-choices")
        ?.addEventListener("change", () => {
          const count = chosenDeleted().size,
            recover = panel.querySelector('[data-part="deleted"]');
          recover.textContent = `${t("Recover deleted objects")} (${count})`;
          recover.disabled = !count;
        });
      panel.querySelectorAll("[data-part]").forEach((el) => {
        el.onclick = async () => {
          if (!onBoard() || restoreState.pending || el.disabled) return;
          const part = el.dataset.part;
          if (part === "copy") {
            const copy = clone(version);
            copy.id = uid();
            delete copy.shared;
            delete copy.timer;
            // Like a duplicate, the copy starts without the live workshop
            // and without anything hidden from this person, then or now.
            const ids = new Set(copy.items.map((i) => i.id));
            const now = api.concealedIn
              ? [...api.concealedIn(api.board())].filter((id) => ids.has(id))
              : [];
            if (now.length) {
              const before = copy.items;
              copy.items = withoutObjects(copy, new Set(now)).items;
              // Tags used only on what was left out go with it, so no list
              // of tags shows that hidden content exists.
              const used = new Set(before.flatMap((i) => i.tagIds || [])),
                seen = new Set(copy.items.flatMap((i) => i.tagIds || []));
              if (copy.tags)
                copy.tags = copy.tags.filter(
                  (tag) => !used.has(tag.id) || seen.has(tag.id),
                );
            }
            let covered = now.length;
            if (api.portableCopy) covered += api.portableCopy(copy);
            else {
              copy.workshop = portableWorkshop(copy.workshop);
              if (!copy.workshop) delete copy.workshop;
            }
            copy.title = versionCopyTitle(version.title, when(at));
            copy.updated = Date.now();
            copy.favorite = false;
            // A personal board holds its images itself, as a duplicate
            // does; one not downloaded yet is fetched, or the copy waits.
            const media = api.includeSharedMedia?.(copy);
            if (media) {
              // One copy per press, while the images download.
              el.disabled = true;
              try {
                await media;
              } catch (error) {
                return api.toast(error.message);
              } finally {
                el.disabled = false;
              }
            }
            d.close();
            await api.addBoard(copy);
            if (covered)
              api.toast(
                "Workshop content hidden from you was left out of the copy.",
              );
            return;
          }
          // Restoring part of the board changes existing objects, so their
          // locks apply; recovering deleted objects adds new ones.
          const frameId = panel.querySelector(
            "#restore-frame input:checked",
          )?.value;
          // Worked out again after the backup below is saved: a lock, or
          // content hidden from this person, can arrive meanwhile.
          const plan = () => {
            if (!onBoard()) return null;
            const covered = api.concealedIn
              ? new Set([...hidden, ...api.concealedIn(api.board())])
              : hidden;
            const from = part === "deleted" ? recovering : visible,
              source = {
                ...from,
                items: from.items.filter((i) => !covered.has(i.id)),
              };
            // The workshop may have hidden the frame since these options
            // opened.
            if (part === "frame" && !source.items.some((i) => i.id === frameId))
              throw Error("That frame is no longer shown to you.");
            const affected =
              part === "objects"
                ? objectRestoreIds(api.board(), source, new Set(selected))
                : part === "frame"
                  ? frameRestoreIds(api.board(), source, frameId, covered)
                  : new Set();
            return api.canEdit(affected) ? { source, covered } : null;
          };
          const done = beginRestore(el);
          if (!done) return;
          try {
            if (!plan()) return;
            await api.local.checkpoint(api.board(), "Before restoration", {
              kept: true,
            });
            const checked = plan();
            if (!checked) return;
            const { source, covered } = checked;
            const result =
              part === "objects"
                ? restoreObjects(api.board(), source, new Set(selected))
                : part === "frame"
                  ? restoreFrame(api.board(), source, frameId, covered)
                  : recoverDeleted(api.board(), source, chosenDeleted());
            const before = new Map(api.board().items.map((i) => [i.id, i]));
            api.replaceItems(result.items);
            shared?.note({
              at: onDevice ? null : at,
              scope: part,
              objects: result.count,
            });
            d.close();
            // What came back is selected and brought into view, so it can
            // be found, checked, and moved or undone at once.
            const back = api
              .board()
              .items.filter(
                (i) => !before.has(i.id) || !sameObject(before.get(i.id), i),
              );
            if (back.length) {
              api.select(new Set(back.map((i) => i.id)));
              const box = bounds(back),
                shown = api.viewBounds?.();
              if (
                shown &&
                (box.x < shown.x ||
                  box.y < shown.y ||
                  box.x + box.w > shown.x + shown.w ||
                  box.y + box.h > shown.y + shown.h)
              )
                api.focusRegion?.(box);
              api.draw();
            }
            api.toast(
              plural(
                result.count,
                "{count} object restored.",
                "{count} objects restored.",
              ),
              { label: "Undo", run: () => api.undo?.(), untilEdit: true },
            );
          } catch (error) {
            api.toast(error.message || "Could not restore this version.");
          } finally {
            done();
          }
        };
      });
      holdControls();
      api.refresh?.();
    }
    async function restoreWhole(button, load, at, onDevice = false) {
      // Checks read-only access and reports it without a false success.
      if (!onBoard() || !api.canEdit(new Set())) return;
      const done = beginRestore(button);
      if (!done) return;
      try {
        const version = await load();
        if (!onBoard()) return;
        const then = new Map(version.items.map((i) => [i.id, i]));
        // Worked out again after the backup below is saved: a lock, or
        // content hidden from this person, can arrive meanwhile.
        const plan = () => {
          if (!onBoard()) return null;
          // Nothing the workshop hides from this person, then or now, comes
          // back or changes: objects hidden now stay as they are.
          const hidden = api.concealedIn
            ? new Set([
                ...api.concealedIn(version),
                ...api.concealedIn(api.board()),
              ])
            : new Set();
          // Like restoring a frame, the objects it would change or remove
          // are checked for locks.
          const changed = new Set(
            api
              .board()
              .items.filter(
                (i) =>
                  !hidden.has(i.id) &&
                  (!then.has(i.id) || !sameObject(then.get(i.id), i)),
              )
              .map((i) => i.id),
          );
          if (!api.canEdit(changed)) return null;
          return restoreBoard(api.board(), version, hidden);
        };
        if (!plan()) return;
        await api.local.checkpoint(api.board(), "Before restoration", {
          kept: true,
        });
        const restored = plan();
        if (!restored) return;
        // The record says how many objects the restoration changed, added
        // or removed, not how many the board holds.
        const before = new Map(api.board().items.map((i) => [i.id, i])),
          after = new Map(restored.items.map((i) => [i.id, i]));
        let changed = 0;
        for (const [id, i] of before)
          if (!after.has(id) || !sameObject(i, after.get(id))) changed++;
        for (const id of after.keys()) if (!before.has(id)) changed++;
        api.restore(restored);
        shared?.note({
          at: onDevice ? null : at,
          scope: "board",
          objects: changed,
        });
        d.close();
        api.toast("Version restored.", {
          label: "Undo",
          run: () => api.undo?.(),
          untilEdit: true,
        });
      } catch {
        api.toast("Could not restore this version.");
      } finally {
        done();
      }
    }
    // Checkpoints and older shared pages refresh these lists while someone
    // may be reviewing restore choices. Keep each saved row and its options,
    // including an in-flight load, rather than rebuilding their controls.
    function showRevisionRows(list, html, keyAttribute) {
      const key = (row) =>
        row?.querySelector(`[${keyAttribute}]`)?.getAttribute(keyAttribute);
      const oldRows = [...list.querySelectorAll(".revision-row")],
        previous = new Map(oldRows.map((row) => [key(row), row])),
        focused = list.contains(document.activeElement)
          ? document.activeElement
          : null,
        anchor =
          focused?.closest(".revision-row") ||
          focused?.closest(".revision-options")?.previousElementSibling,
        oldIndex = oldRows.indexOf(anchor),
        template = document.createElement("template");
      template.innerHTML = html;
      const nodes = [],
        rows = [];
      for (const node of template.content.children) {
        if (!node.classList.contains("revision-row")) {
          nodes.push(node);
          continue;
        }
        const retained = previous.get(key(node));
        if (!retained) {
          nodes.push(node);
          rows.push(node);
          continue;
        }
        const options = retained.nextElementSibling;
        // Dates, labels and counts can follow the interface language without
        // replacing buttons that are focused or awaiting a response.
        const name = retained.firstElementChild,
          fresh = node.firstElementChild;
        if (name.innerHTML !== fresh.innerHTML)
          name.innerHTML = fresh.innerHTML;
        const labels = node.querySelectorAll(".revision-actions button");
        retained
          .querySelectorAll(".revision-actions button")
          .forEach((button, index) => {
            button.textContent = labels[index].textContent;
          });
        nodes.push(retained);
        rows.push(retained);
        if (options?.classList.contains("revision-options"))
          nodes.push(options);
      }
      list.replaceChildren(...nodes);
      if (focused) {
        // A version pruned from this device hands focus to nearby options,
        // never to a Restore button that could perform a different action.
        const fallback =
          rows[Math.max(0, Math.min(oldIndex, rows.length - 1))]?.querySelector(
            `[${keyAttribute}-options]`,
          ) || d.querySelector("#checkpoint-label");
        (focused.isConnected ? focused : fallback)?.focus({
          preventScroll: true,
        });
      }
    }
    // Shared versions arrive a page at a time, newest first.
    let sharedRows = [],
      sharedCreated = 0;
    const renderShared = async (older = false) => {
      if (!onBoard()) return;
      const list = d.querySelector("#shared-revisions"),
        focusedBeforeLoad = document.activeElement;
      try {
        const { versions, more, created } = await shared.list(
          older ? sharedRows.at(-1)?.at : undefined,
        );
        if (Number.isSafeInteger(created)) sharedCreated = created;
        if (!d.isConnected || !onBoard()) return;
        // Only well-formed versions are shown; the list comes from the
        // board's worker and becomes markup.
        const page = (Array.isArray(versions) ? versions : []).filter(
          (v) =>
            Number.isSafeInteger(v?.at) &&
            Number.isSafeInteger(v.edits) &&
            Array.isArray(v.authors),
        );
        const rows = (sharedRows = older ? [...sharedRows, ...page] : page);
        const focusAt = older ? page[0]?.at : null,
          focusNewPage =
            document.activeElement === focusedBeforeLoad ||
            document.activeElement === document.body;
        showRevisionRows(
          list,
          rows.length
            ? byDay(
                rows.map((v, n) => ({ ...v, n })),
                (v, time, day) => {
                  const authors = `<span data-user-content>${escape(v.authors.map(String).join(", "))}</span>`,
                    title = v.original ? t("Original version") : time,
                    details = v.original
                      ? `${time}${v.authors.length ? ` · ${authors}` : ""}`
                      : `${authors} · ${v.edits} ${t(v.edits === 1 ? "edit" : "edits")}${v.n === 0 ? ` · ${t("Current version")}` : ""}`;
                  sources.set(`s:${v.at}`, {
                    title,
                    meta: v.original ? `${day}, ${time}` : day,
                    load: () => shared.load(v.at),
                  });
                  return `<div class="revision-row"><button type="button" class="revision-pick" id="shared-version-${v.at}" data-pick="s:${v.at}" aria-pressed="false"><strong>${escape(title)}</strong><small>${details}</small></button><div class="revision-actions"><button class="secondary" data-shared="${v.at}" aria-describedby="shared-version-${v.at}" ${v.n === 0 || readOnly() ? "disabled" : ""}>${t("Restore version")}</button><button class="text-btn" data-shared-options="${v.at}" aria-describedby="shared-version-${v.at}" aria-expanded="false">${t("More options")}</button></div></div>`;
                },
              ) +
                (more === true
                  ? `<button class="text-btn" id="shared-older">${t("Show older versions")}</button>`
                  : "")
            : `<p>${t("No shared edits yet.")}</p>`,
          "data-shared",
        );
        const olderButton = list.querySelector("#shared-older");
        if (olderButton)
          olderButton.onclick = () => {
            const done = busy(olderButton);
            renderShared(true).finally(done);
          };
        // After showing older versions, the first of them has focus.
        if (focusAt !== null && focusAt !== undefined && focusNewPage)
          list.querySelector(`[data-shared="${focusAt}"]`)?.focus();
        list.querySelectorAll("[data-shared]").forEach((btn) => {
          const at = Number(btn.dataset.shared);
          btn.onclick = () => restoreWhole(btn, () => shared.load(at), at);
        });
        list.querySelectorAll("[data-shared-options]").forEach((btn) => {
          const at = Number(btn.dataset.sharedOptions);
          // A version's edits began after the one before it in the list.
          const n = sharedRows.findIndex((v) => v.at === at),
            after = sharedRows[n + 1]?.at ?? sharedCreated;
          btn.onclick = () =>
            options(
              btn,
              () => cachedLoad(`s:${at}`, () => shared.load(at)),
              at,
              false,
              `s:${at}`,
              shared.removed && !sharedRows[n]?.original
                ? () => cachedLoad(`r:${at}`, () => shared.removed(at, after))
                : null,
            );
        });
        list.querySelectorAll("[data-pick]").forEach((btn) => {
          btn.onclick = () => pick(btn.dataset.pick);
        });
        markPicked();
        holdControls();
        api.refresh?.();
      } catch (error) {
        // Announced, as the list it replaces loads silently.
        const alert = document.createElement("p");
        alert.setAttribute("role", "alert");
        alert.textContent = t(
          error.message || "Could not load the shared history.",
        );
        list.replaceChildren(alert);
      }
    };
    // Versions on this device, newest first, read again after each change
    // to them; the named-only filter shows them again without reading.
    let revisions = [];
    const render = async () => {
      await api.waitForSaves();
      if (!d.isConnected || !onBoard()) return;
      const read = (await api.local.revisions(boardId)).sort(
        (a, b) => b.created - a.created,
      );
      if (!d.isConnected || !onBoard()) return;
      revisions = read;
      showLocal();
    };
    // What the app names on its own, as opposed to what people name.
    const SAFETY_LABELS = new Set([
      "Before restoration",
      "Before deletion",
      "Unsaved changes from another tab",
    ]);
    function showLocal() {
      const namedOnly = d.querySelector("#history-named").checked,
        shown = namedOnly ? revisions.filter(keptRevision) : revisions;
      showRevisionRows(
        d.querySelector("#local-revisions"),
        shown.length
          ? byDay(
              shown.map((r) => ({ ...r, at: r.created })),
              (r, time, day) => {
                const named = keptRevision(r),
                  label = escape(t(r.label)),
                  count = plural(
                    r.board.items.length,
                    "{count} object",
                    "{count} objects",
                  );
                sources.set(`l:${r.id}`, {
                  title: named ? t(r.label) : time,
                  meta: named ? `${day}, ${time}` : day,
                  load: async () => find(r.id).board,
                });
                return `<div class="revision-row${named ? " named" : ""}"><button type="button" class="revision-pick" id="local-version-${escape(r.id)}" data-pick="l:${escape(r.id)}" aria-pressed="false"><strong>${named ? `<i data-lucide="${SAFETY_LABELS.has(r.label) ? "history" : "bookmark"}" aria-hidden="true"></i><span data-user-content>${label}</span>` : escape(time)}</strong><small>${named ? `${escape(time)} · ` : ""}${count}</small></button><div class="revision-actions"><button class="secondary" data-revision="${r.id}" aria-describedby="local-version-${escape(r.id)}" ${readOnly() ? "disabled" : ""}>${t("Restore version")}</button><button class="text-btn" data-revision-options="${r.id}" aria-describedby="local-version-${escape(r.id)}" aria-expanded="false">${t("More options")}</button></div></div>`;
              },
            )
          : `<p>${t(namedOnly ? "No named versions yet." : "No saved versions yet.")}</p>`,
        "data-revision",
      );
      d.querySelectorAll("[data-revision]").forEach(
        (btn) =>
          (btn.onclick = () =>
            restoreWhole(
              btn,
              async () => find(btn.dataset.revision).board,
              find(btn.dataset.revision).created,
              true,
            )),
      );
      d.querySelectorAll("[data-revision-options]").forEach(
        (btn) =>
          (btn.onclick = () =>
            options(
              btn,
              async () => find(btn.dataset.revisionOptions).board,
              find(btn.dataset.revisionOptions).created,
              true,
              `l:${btn.dataset.revisionOptions}`,
            )),
      );
      d.querySelectorAll("#local-revisions [data-pick]").forEach((btn) => {
        btn.onclick = () => pick(btn.dataset.pick);
      });
      markPicked();
      holdControls();
      api.refresh?.();
    }
    const find = (id) => revisions.find((r) => r.id === id);
    d.querySelector("#history-named").onchange = showLocal;
    d.querySelector("#checkpoint-create").onclick = async (e) => {
      // The form only lets Enter in the name field press this button.
      e.preventDefault?.();
      // One checkpoint per press: a double click must not save two.
      const button = e.currentTarget;
      if (button.disabled || restoreState.pending || !onBoard()) return;
      const done = busy(button);
      try {
        await api.local.checkpoint(
          api.board(),
          d.querySelector("#checkpoint-label").value.trim() || "Checkpoint",
          { kept: true },
        );
        api.toast("Checkpoint saved.");
        await render();
      } catch {
        api.toast("Could not save the checkpoint. Export a backup.");
      } finally {
        done();
        holdControls();
      }
    };
    await Promise.all([render(), shared ? renderShared() : null]);
  }
  async function saveSnippet() {
    const openedBoard = api.board(),
      ids = new Set(api.selection());
    if (!openedBoard || !ids.size) {
      api.toast("Select objects first.");
      return;
    }
    // As with copying, objects hidden from this person are never saved,
    // including the hidden contents of a visible frame or group.
    const hidden = () => api.concealedIn?.(openedBoard) || new Set(),
      concealed = hidden();
    if ([...ids].every((id) => concealed.has(id))) {
      api.toast("Hidden objects cannot be copied.");
      return;
    }
    api.modal(
      "Save as reusable content",
      `<form><label class="field">Name<input id="snippet-name" maxlength="120" required></label><p id="snippet-status" class="dialog-copy" role="status" aria-live="polite" tabindex="-1" hidden></p><div class="dialog-footer"><button class="primary">Save</button></div></form>`,
      (d) => {
        const name = d.querySelector("#snippet-name");
        let savedContent;
        name.oninput = () => {
          if (!name.hasAttribute("aria-invalid")) return;
          name.removeAttribute("aria-invalid");
          name.removeAttribute("aria-describedby");
          d.querySelector("#snippet-status").hidden = true;
        };
        const feedback = (message, focus = true) => {
          name.removeAttribute("aria-invalid");
          name.removeAttribute("aria-describedby");
          const status = d.querySelector("#snippet-status");
          status.textContent = t(message);
          status.hidden = false;
          if (focus && d.isConnected) status.focus();
        };
        d.querySelector("form").onsubmit = async (e) => {
          e.preventDefault();
          // One save per press: a double submit must not save it twice.
          const button = d.querySelector(".primary");
          if (button.disabled) return;
          // The name belongs to the board and selection where this opened,
          // including after navigation clears the editor's live selection.
          if (api.board() !== openedBoard) {
            feedback(
              "You’re viewing a different board. Return to the original board to save this selection, or close this dialog and select content again.",
            );
            return;
          }
          const title = name.value.trim();
          if (!title) {
            feedback("Enter a name for this reusable content.");
            name.setAttribute("aria-invalid", "true");
            name.setAttribute("aria-describedby", "snippet-status");
            if (d.isConnected) name.focus();
            return;
          }
          let content = savedContent;
          // A name correction updates the saved snapshot, including if the
          // source objects have changed since its original successful save.
          if (!content) {
            const concealed = hidden();
            const source = clone(
              openedBoard.items.filter((i) => !concealed.has(i.id)),
            );
            const keep = source.filter((i) => ids.has(i.id));
            if (!keep.length) {
              feedback(
                "None of the selected objects are available to copy. Close this dialog and select visible objects again.",
              );
              return;
            }
            const chosenIds = new Set(keep.map((i) => i.id)),
              wholeGroups = completeGroups(source, chosenIds);
            externalizeObjectLinks(keep, api.objectURL);
            for (const i of keep) {
              trimMindMap(i, chosenIds);
              if (i.groupId && !wholeGroups.has(i.groupId)) delete i.groupId;
              if (!chosenIds.has(i.parentId)) delete i.parentId;
              // Lines may be attached at just one end; trim each end separately.
              if (!chosenIds.has(i.startId)) delete i.startId;
              if (!chosenIds.has(i.endId)) delete i.endId;
            }
            // A facilitator's own playbook keeps its steps' timings and
            // instructions for the frames it holds.
            const steps = (openedBoard.workshop?.agenda?.steps || []).filter(
              (step) =>
                keep.some((i) => i.id === step.frame && i.type === "frame"),
            );
            // Kanban columns saved from a board with status sync turn it on
            // where they are inserted, as the Kanban template does.
            const columns =
              statusSyncEnabled(openedBoard) &&
              keep.some(
                (i) => i.type === "frame" && statusFromTitle(i.text || ""),
              );
            content = {
              id: uid(),
              items: keep,
              tags: referencedTags(keep, openedBoard.tags),
              ...(steps.length ? { agenda: { steps: clone(steps) } } : {}),
              ...(columns ? { planning: { statusSync: true } } : {}),
              version: 1,
            };
          }
          const template = { ...content, title, updated: Date.now() };
          const done = busy(button);
          // Only a shared board's undownloaded media are waited for.
          const media = api.includeSharedMedia?.(template);
          if (media)
            try {
              await media;
            } catch (error) {
              done();
              return feedback(error.message);
            }
          try {
            await api.local.saveTemplate(template);
            savedContent = template;
          } catch {
            return api.toast("Could not save this content on this device.");
          } finally {
            done();
          }
          if (d.isConnected && name.value.trim() !== title) {
            feedback(
              "Content saved. You changed its name while saving. Save again to update the name.",
              false,
            );
            return;
          }
          d.close();
          api.toast("Reusable content saved.");
        };
      },
    );
  }
  // Built boards and components are cached per language for previews.
  const libraryPreviews = new Map();
  const savedPreviews = new Map();
  const TRASH = [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }],
    ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }],
    ["line", { x1: 10, x2: 10, y1: 11, y2: 17 }],
    ["line", { x1: 14, x2: 14, y1: 11, y2: 17 }],
  ];
  const library = {
    tab: "templates",
    category: "",
    group: "",
    iconCategory: "",
    color: ICON_COLORS[0].value,
  };
  function previewItems(kind, id) {
    // Saved content is drawn from what the library read, not cached.
    if (kind === "saved") return savedPreviews.get(id) || [];
    const key = `${kind}|${id}|${language}`;
    if (!libraryPreviews.has(key))
      libraryPreviews.set(
        key,
        kind === "template"
          ? fromTemplate(id, language).items
          : componentItems(id, language),
      );
    return libraryPreviews.get(key);
  }
  function paintLibraryPreview(canvas, items) {
    if (!items.length) return;
    const width = 240,
      height = 130,
      a = bounds(items),
      z = Math.min(width / (a.w + 40), height / (a.h + 40));
    paint(
      canvas,
      items,
      {
        x: width / 2 - (a.x + a.w / 2) * z,
        y: height / 2 - (a.y + a.h / 2) * z,
        z,
      },
      {
        width,
        height,
        background: "#ffffff",
        textColor: "#30342f",
        mindBadges: false,
      },
    );
  }
  // Previews paint when scrolled into view, or a few at a time without
  // IntersectionObserver, so the dialog opens immediately.
  const previewCleanup = new WeakMap();
  function schedulePreviews(d, container) {
    // Each render replaces the previous list's observer or scroll handler,
    // and closing the dialog ends the current one.
    if (previewCleanup.has(container)) previewCleanup.get(container)();
    else d.addEventListener("close", () => previewCleanup.get(container)?.());
    const canvases = [...container.querySelectorAll("canvas[data-preview-id]")];
    const draw = (canvas) => {
      if (!canvas.isConnected || canvas.dataset.painted) return;
      canvas.dataset.painted = "true";
      try {
        paintLibraryPreview(
          canvas,
          previewItems(canvas.dataset.previewKind, canvas.dataset.previewId),
        );
      } catch {
        /* A preview failure must not block the library. */
      }
    };
    if (window.IntersectionObserver) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            draw(entry.target);
          }
      });
      canvases.forEach((canvas) => observer.observe(canvas));
      previewCleanup.set(container, () => observer.disconnect());
      return;
    }
    // Without an observer, paint the first rows, then more as the list scrolls.
    let budget = 0;
    const next = () => {
      if (!d.isConnected) return;
      canvases.splice(0, 2).forEach(draw);
      if (canvases.length && (budget -= 2) > 0) setTimeout(next, 0);
    };
    const more = () => {
      if (budget <= 0 && canvases.length) setTimeout(next, 0);
      budget = 8;
    };
    container.addEventListener("scroll", more, { passive: true });
    previewCleanup.set(container, () => {
      canvases.length = 0;
      container.removeEventListener("scroll", more);
    });
    more();
  }
  // Arrow keys, Home and End move between cards in a wrapping grid.
  function gridKeys(container, selector) {
    container.addEventListener("keydown", (e) => {
      const items = [...container.querySelectorAll(selector)],
        index = items.indexOf(document.activeElement);
      if (index < 0) return;
      const top = items[0].offsetTop;
      let columns = items.findIndex((el) => el.offsetTop !== top);
      if (columns < 1) columns = 1;
      // Up and Down go to the nearest item in the row above or below. A
      // dialog's sections are separate grids with their own column counts.
      const vertical = (down) => {
        const at = items[index].getBoundingClientRect();
        let best = -1,
          row = Infinity,
          gap = Infinity;
        items.forEach((el, n) => {
          const r = el.getBoundingClientRect();
          const dy = down ? r.top - at.top : at.top - r.top,
            dx = Math.abs(r.left - at.left);
          if (dy < 1 || !(r.width || r.height) || dy > row + 1) return;
          if (dy < row - 1) [row, gap] = [dy, Infinity];
          if (dx < gap) [best, gap] = [n, dx];
        });
        return best >= 0 ? best : index + (down ? columns : -columns);
      };
      const target = {
        ArrowRight: () => index + 1,
        ArrowLeft: () => index - 1,
        ArrowDown: () => vertical(true),
        ArrowUp: () => vertical(false),
        Home: () => 0,
        End: () => items.length - 1,
      }[e.key]?.();
      if (target === undefined) return;
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, target))].focus();
    });
  }
  // Toggle buttons that filter a list; one is pressed at a time.
  function filterChips(root, label, entries, active, attribute, onChange) {
    const html = `<div class="library-chips" role="group" aria-label="${t(label)}">${entries
      .map(
        ([id, name, count]) =>
          `<button type="button" class="library-chip" data-${attribute}="${id}" aria-pressed="${id === active}">${escape(name)}${count == null ? "" : ` <span>${count}</span>`}</button>`,
      )
      .join("")}</div>`;
    return {
      html,
      bind() {
        const buttons = root.querySelectorAll(`[data-${attribute}]`);
        // A row that scrolls, as on a phone, shows the chosen chip.
        const row = buttons[0]?.parentElement,
          pressed = [...buttons].find(
            (b) => b.getAttribute("aria-pressed") === "true",
          );
        if (row && pressed && row.scrollWidth > row.clientWidth)
          row.scrollLeft +=
            pressed.getBoundingClientRect().left -
            row.getBoundingClientRect().left -
            8;
        buttons.forEach(
          (btn) =>
            (btn.onclick = () => {
              buttons.forEach((b) =>
                b.setAttribute("aria-pressed", b === btn ? "true" : "false"),
              );
              onChange(btn.dataset[attribute]);
            }),
        );
      },
    };
  }
  // A search field whose Down arrow moves into the results.
  function bindSearch(search, results, render) {
    search.oninput = render;
    search.onkeydown = (e) => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      results.querySelector("button")?.focus();
    };
  }
  const resultCount = (n) => t(`${n} result${n === 1 ? "" : "s"}`);
  // Inserts copies centered in the view. A whole template that would
  // cover what is already there goes beside the board's content
  // instead, and the view moves to show it. Saved pieces land in the
  // middle like components; the view zooms out only if they don't fit.
  function insertContent(
    items,
    tags,
    {
      template = false,
      fit = false,
      close = () => {},
      planning = null,
      agenda = null,
    } = {},
  ) {
    if (!api.canEdit(new Set())) return api.toast("This board is read-only.");
    if (api.board().items.length + items.length > MAX_OBJECTS)
      return api.toast("A board can contain at most 5,000 objects.");
    close();
    const source = clone(items),
      middle = api.viewCenter(),
      a = bounds(source);
    for (const i of source) {
      i.x += middle.x - a.x - a.w / 2;
      i.y += middle.y - a.y - a.h / 2;
    }
    const existing = api.board().items;
    if (template && existing.length) {
      const placed = bounds(source),
        covers = existing.some((i) => {
          const b = bounds([i]);
          return (
            b.x < placed.x + placed.w &&
            b.x + b.w > placed.x &&
            b.y < placed.y + placed.h &&
            b.y + b.h > placed.y
          );
        });
      if (covers) {
        const content = bounds(existing);
        for (const i of source) {
          i.x += content.x + content.w + 160 - placed.x;
          i.y += content.y - placed.y;
        }
      }
    }
    // With the view at the board's edge, the copies stay on the board.
    keepOnBoard(source);
    let imported;
    try {
      imported = importTags(api.board(), source, tags);
    } catch (error) {
      api.toast(error.message);
      return;
    }
    let inserted = [],
      aligned = null,
      stepsLeft = false;
    // A Kanban template's cards keep following their columns, so it turns
    // status sync on for the board, as Turn on Kanban status sync does.
    const syncing = planning?.statusSync && !api.board().planning?.statusSync;
    api.mutate(() => {
      if (imported.length || api.board().tags) api.board().tags = imported;
      const ids = new Set(source.map((i) => i.id));
      const copies = [];
      duplicateItems(source, ids, 0);
      copies.push(...source.slice(ids.size));
      unlinkCopiedJira(copies, items);
      // Inserted frames come after the board's own, in their order.
      const last = Math.max(
        -1,
        ...orderedFrames(api.board().items).map((f) => f.order || 0),
      );
      orderedFrames(copies).forEach((f, n) => (f.order = last + 1 + n));
      // Saved steps follow their frames' copies into the board's agenda,
      // for someone who runs the board's workshop; anyone else inserts the
      // frames alone, as a participant cannot change the agenda.
      if (agenda?.steps?.length && api.runsWorkshop?.()) {
        const copied = new Map(
          source.slice(0, ids.size).map((i, n) => [i.id, copies[n].id]),
        );
        // Steps for frames no longer on the board, as after undoing an
        // insert, which leaves the agenda as it was, make no room.
        const present = new Set(api.board().items.map((i) => i.id));
        const steps = (api.board().workshop?.agenda?.steps || []).filter(
          (step) => present.has(step.frame),
        );
        const added = agenda.steps
          .filter((step) => copied.has(step.frame))
          .map((step) => ({ ...clone(step), frame: copied.get(step.frame) }));
        if (steps.length + added.length > WORKSHOP_LIMITS.steps)
          stepsLeft = true;
        else if (added.length)
          api.board().workshop = {
            ...api.board().workshop,
            agenda: { steps: [...steps, ...added] },
          };
      }
      api.placeItems?.(copies);
      api.board().items.push(...copies);
      // Like pasted objects, copies landing in a frame join it,
      // unless the frame is hidden from this person.
      placeDuplicates(
        api.board().items,
        new Set(copies.map((i) => i.id)),
        api.concealedIn?.(api.board()),
      );
      api.select(new Set(copies.map((i) => i.id)));
      inserted = copies;
      if (syncing) {
        api.board().planning = { statusSync: true };
        // The board's own cards still to do in status frames take their
        // frame's status; locked, hidden and inserted ones are left alone.
        const byId = new Map(api.board().items.map((i) => [i.id, i]));
        aligned = alignColumnStatuses(
          api.board(),
          new Set([
            ...copies.map((i) => i.id),
            ...(api.concealedIn?.(api.board()) || []),
            ...[...protectedIds(api.board().items)].filter(
              (id) => byId.get(id)?.type !== "frame",
            ),
          ]),
        );
      }
    });
    if (!inserted.length) return false;
    if (stepsLeft)
      api.toast(
        "The frames were added without their agenda steps: the agenda holds at most 60 steps.",
      );
    if (aligned)
      api.toast(
        aligned.length
          ? `${t("Kanban status sync is on for this board.")} ${labelled(t("Statuses updated"), "")}${aligned.length}`
          : "Kanban status sync is on for this board.",
      );
    const box = bounds(inserted),
      shown = fit && api.viewBounds?.();
    if (
      template ||
      (shown &&
        (box.x < shown.x ||
          box.y < shown.y ||
          box.x + box.w > shown.x + shown.w ||
          box.y + box.h > shown.y + shown.h))
    )
      api.focusRegion?.(box);
    return true;
  }
  async function templateLibrary(tab = "templates") {
    const custom = await api.local.templates(),
      l = language === "fr" ? 1 : 0,
      onBoard = !!api.board();
    library.tab = onBoard ? tab : "templates";
    const tabs = [
      ["templates", "Templates"],
      ["components", "Components"],
      ["icons", "Icons and stickers"],
    ];
    api.modal(
      "Template library",
      `${onBoard ? `<div class="library-tabs" role="tablist" aria-label="${t("Library sections")}">${tabs.map(([id, label]) => `<button type="button" role="tab" id="library-tab-${id}" aria-controls="library-panel" data-library-tab="${id}">${t(label)}</button>`).join("")}</div>` : ""}<div id="library-panel" class="library-panel"></div>`,
      (d) => {
        d.classList.add("wide-dialog");
        const panel = d.querySelector("#library-panel");
        const insert = (items, tags, options = {}) =>
          insertContent(items, tags, { ...options, close: () => d.close() });
        const use = (b, saved = false) => {
          if (api.board())
            insert(
              b.items,
              b.tags,
              saved
                ? { fit: true, agenda: b.agenda, planning: b.planning }
                : { template: true, planning: b.planning },
            );
          else {
            d.close();
            // A saved playbook's steps become the new board's agenda.
            const { agenda, ...board } = b;
            api.addBoard(agenda ? { ...board, workshop: { agenda } } : board);
          }
        };
        // Saved content comes first, newest first, so recent work is at hand.
        custom.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        savedPreviews.clear();
        for (const b of custom) savedPreviews.set(b.id, b.items || []);
        const savedDate = (at) =>
          at
            ? new Date(at).toLocaleDateString(l ? "fr-CA" : "en-CA", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "";
        const searchSaved = (query) => {
          const words = searchWords(query);
          return custom.filter((b) => {
            const index = searchIndex(b.title || "");
            return words.every((word) => matchesWord(index, word));
          });
        };
        const templatesPanel = () => {
          const categories = filterChips(
            panel,
            "Template categories",
            [
              ["", t("All"), TEMPLATE_CATALOG.length + custom.length],
              ["mine", t("My reusable content"), custom.length],
              ...TEMPLATE_CATEGORIES.map((c) => [
                c.id,
                c.name[l],
                TEMPLATE_CATALOG.filter((def) => def.categoryId === c.id)
                  .length,
              ]),
              [
                "playbooks",
                t("Playbooks"),
                TEMPLATE_CATALOG.filter((def) => def.playbook).length,
              ],
            ],
            library.category,
            "category",
            (id) => {
              library.category = id;
              render();
            },
          );
          panel.innerHTML = `<label class="search template-search"><input id="template-search" type="search" aria-label="Search templates" placeholder="Search templates" autocomplete="off"></label>${categories.html}<p class="library-count" role="status" aria-live="polite"></p><div class="template-library-list"></div>`;
          const list = panel.querySelector(".template-library-list"),
            search = panel.querySelector("#template-search"),
            count = panel.querySelector(".library-count");
          const action = t(api.board() ? "Insert into board" : "Use template");
          const savedCard = (b) => {
            const id = escape(b.id),
              name = escape(b.title || "");
            return `<div class="library-saved" data-custom-row="${id}"><button type="button" class="library-template" data-custom="${id}"><canvas class="library-preview" data-preview-kind="saved" data-preview-id="${id}" aria-hidden="true"></canvas><small>${t("My reusable content")}</small><strong data-user-content>${name}</strong><span>${escape(t("Saved {date}").replace("{date}", savedDate(b.updated)))}</span><b>${action}</b></button><button type="button" class="library-remove" data-remove-template="${id}" aria-label="${escape(t("Delete template"))}: ${name}" title="${escape(t("Delete template"))}">${iconSvg(TRASH)}<span>${t("Confirm delete")}</span></button></div>`;
          };
          const render = () => {
            const mine = library.category === "mine",
              playbooks = library.category === "playbooks",
              matches = mine
                ? []
                : searchTemplates(
                    search.value,
                    playbooks ? "" : library.category,
                  ).filter((def) => !playbooks || def.playbook),
              saved =
                mine || !library.category ? searchSaved(search.value) : [];
            count.textContent = resultCount(matches.length + saved.length);
            list.innerHTML =
              matches.length || saved.length
                ? saved.map(savedCard).join("") +
                  matches
                    .map(
                      (def) =>
                        `<button type="button" class="library-template" data-use="${def.id}"><canvas class="library-preview" data-preview-kind="template" data-preview-id="${def.id}" aria-hidden="true"></canvas><small data-user-content>${escape(def.category[l])}${def.playbook ? ` · ${escape(t("Playbook"))}` : ""}</small><strong data-user-content>${escape(def.name[l])}</strong><span data-user-content>${escape(def.description[l])}</span><b>${action}</b></button>`,
                    )
                    .join("")
                : mine && !custom.length
                  ? `<p class="dialog-copy">${t("No reusable content yet. Select objects on a board, then choose Save as reusable content from the right-click menu or More options.")}</p>`
                  : // A search that finds nothing in the chosen category
                    // offers the others, where it may find something.
                    library.category &&
                      (searchTemplates(search.value).length ||
                        searchSaved(search.value).length)
                    ? `<p class="dialog-copy">${t("No templates found in this category.")} <button type="button" class="text-btn library-search-all" data-search-all>${t("Search all categories")}</button></p>`
                    : `<p class="dialog-copy">${t("No templates found.")}</p>`;
            const all = list.querySelector("[data-search-all]");
            if (all)
              all.onclick = () => {
                library.category = "";
                panel
                  .querySelectorAll("[data-category]")
                  .forEach((chip) =>
                    chip.setAttribute(
                      "aria-pressed",
                      chip.dataset.category === "" ? "true" : "false",
                    ),
                  );
                render();
                (list.querySelector(".library-template") || search).focus();
              };
            list
              .querySelectorAll("[data-use]")
              .forEach(
                (btn) =>
                  (btn.onclick = () =>
                    use(fromTemplate(btn.dataset.use, language))),
              );
            list.querySelectorAll("[data-custom]").forEach(
              (btn) =>
                (btn.onclick = () =>
                  use(
                    {
                      ...clone(custom.find((b) => b.id === btn.dataset.custom)),
                      id: uid(),
                      updated: Date.now(),
                      favorite: false,
                    },
                    true,
                  )),
            );
            list
              .querySelectorAll("[data-remove-template]")
              .forEach((btn) => (btn.onclick = () => remove(btn)));
            schedulePreviews(d, list);
          };
          // Saved content has no undo, so deleting takes a second press.
          const remove = async (btn) => {
            const id = btn.dataset.removeTemplate,
              entry = custom.find((b) => b.id === id);
            if (!entry) return;
            if (!btn.dataset.confirm) {
              btn.dataset.confirm = "true";
              btn.classList.add("danger");
              btn.setAttribute(
                "aria-label",
                `${t("Confirm delete")}: ${entry.title || ""}`,
              );
              // The relabelled button keeps focus, so say what it now asks.
              count.textContent = t("Confirm delete");
              return;
            }
            if (btn.disabled) return;
            btn.disabled = true;
            try {
              await api.local.removeTemplate(id);
            } catch {
              btn.disabled = false;
              delete btn.dataset.confirm;
              btn.classList.remove("danger");
              btn.setAttribute(
                "aria-label",
                `${t("Delete template")}: ${entry.title || ""}`,
              );
              return api.toast("Could not delete this content on this device.");
            }
            if (!d.isConnected) return;
            const shown = [...list.querySelectorAll("[data-custom-row]")],
              at = shown.findIndex((row) => row.dataset.customRow === id),
              nextId = (shown[at + 1] || shown[at - 1])?.dataset.customRow;
            custom.splice(custom.indexOf(entry), 1);
            savedPreviews.delete(id);
            for (const [chip, n] of [
              ["", TEMPLATE_CATALOG.length + custom.length],
              ["mine", custom.length],
            ]) {
              const figure = panel.querySelector(
                `[data-category="${chip}"] span`,
              );
              if (figure) figure.textContent = n;
            }
            render();
            // Keep keyboard focus in the list instead of dropping to the page.
            (
              [...list.querySelectorAll("[data-custom]")].find(
                (btn) => btn.dataset.custom === nextId,
              ) ||
              list.querySelector(".library-template") ||
              search
            ).focus();
          };
          render();
          categories.bind();
          bindSearch(search, list, render);
          gridKeys(list, ".library-template");
        };
        const componentsPanel = () => {
          const groups = filterChips(
            panel,
            "Component groups",
            [
              ["", t("All"), COMPONENTS.length],
              ...COMPONENT_GROUPS.map((g) => [
                g.id,
                g.name[l],
                COMPONENTS.filter((c) => c.group === g.id).length,
              ]),
            ],
            library.group,
            "group",
            (id) => {
              library.group = id;
              render();
            },
          );
          panel.innerHTML = `<label class="search template-search"><input id="component-search" type="search" aria-label="${t("Search components")}" placeholder="${t("Search components")}" autocomplete="off"></label>${groups.html}<p class="library-count" role="status" aria-live="polite"></p><div class="template-library-list component-list"></div>`;
          const list = panel.querySelector(".component-list"),
            search = panel.querySelector("#component-search"),
            names = new Map(COMPONENT_GROUPS.map((g) => [g.id, g.name[l]]));
          const render = () => {
            const matches = searchComponents(search.value, library.group);
            panel.querySelector(".library-count").textContent = resultCount(
              matches.length,
            );
            list.innerHTML = matches.length
              ? matches
                  .map(
                    (c) =>
                      `<button type="button" class="library-template" data-component="${c.id}"><canvas class="library-preview" data-preview-kind="component" data-preview-id="${c.id}" aria-hidden="true"></canvas><small data-user-content>${escape(names.get(c.group))}</small><strong data-user-content>${escape(c.name[l])}</strong><span data-user-content>${escape(c.description[l])}</span><b>${t("Insert component")}</b></button>`,
                  )
                  .join("")
              : `<p>${t("No components found.")}</p>`;
            list
              .querySelectorAll("[data-component]")
              .forEach(
                (btn) =>
                  (btn.onclick = () =>
                    insert(componentItems(btn.dataset.component, language))),
              );
            schedulePreviews(d, list);
          };
          render();
          groups.bind();
          bindSearch(search, list, render);
          gridKeys(list, ".library-template");
        };
        const iconsPanel = () => {
          panel.innerHTML = `<div class="icon-filters"><label class="search template-search"><input id="icon-search" type="search" aria-label="${t("Search icons")}" placeholder="${t("Search icons")}" autocomplete="off"></label><label class="field">${t("Icon categories")}<select id="icon-category"><option value="">${t("All")}</option>${ICON_CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === library.iconCategory ? "selected" : ""}>${escape(c.name[l])}</option>`).join("")}</select></label><label class="field">${t("Icon color")}<select id="icon-color">${ICON_COLORS.map((c) => `<option value="${c.value}" ${c.value === library.color ? "selected" : ""}>${escape(c.name[l])}</option>`).join("")}</select></label></div><p class="library-count" role="status" aria-live="polite"></p><div class="icon-grid"></div>`;
          const grid = panel.querySelector(".icon-grid"),
            search = panel.querySelector("#icon-search"),
            entries = new Map();
          const render = () => {
            const matches = searchIcons(search.value, library.iconCategory);
            panel.querySelector(".library-count").textContent = resultCount(
              matches.length,
            );
            grid.style.color = library.color;
            grid.innerHTML = matches.length
              ? matches
                  .map((entry) => {
                    entries.set(entry.id, entry);
                    const name = escape(entry.name[l]);
                    return `<button type="button" class="icon-choice" data-icon="${entry.id}" aria-label="${escape(t(entry.sticker ? "Insert sticker" : "Insert icon"))}: ${name}" title="${name}">${entry.sticker ? `<span class="sticker-preview" style="background:${entry.background};color:${entry.glyph}">${entry.node ? iconSvg(entry.node) : `<b>${escape(entry.label)}</b>`}</span>` : iconSvg(entry.node)}</button>`;
                  })
                  .join("")
              : `<p>${t("No icons found.")}</p>`;
            grid.querySelectorAll("[data-icon]").forEach(
              (btn) =>
                (btn.onclick = () =>
                  insert([
                    iconItem(entries.get(btn.dataset.icon), 0, 0, {
                      color: library.color,
                      lang: language,
                    }),
                  ])),
            );
          };
          render();
          bindSearch(search, grid, render);
          gridKeys(grid, ".icon-choice");
          panel.querySelector("#icon-category").onchange = (e) => {
            library.iconCategory = e.target.value;
            render();
          };
          panel.querySelector("#icon-color").onchange = (e) => {
            library.color = e.target.value;
            grid.style.color = library.color;
          };
        };
        const show = (next, focus = false) => {
          library.tab = next;
          d.querySelectorAll("[data-library-tab]").forEach((btn) => {
            const active = btn.dataset.libraryTab === next;
            btn.setAttribute("aria-selected", active ? "true" : "false");
            btn.tabIndex = active ? 0 : -1;
            if (active && focus) btn.focus();
          });
          if (onBoard) {
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", `library-tab-${next}`);
          }
          ({
            templates: templatesPanel,
            components: componentsPanel,
            icons: iconsPanel,
          })[next]();
          translateUI(panel);
        };
        d.querySelectorAll("[data-library-tab]").forEach((btn) => {
          btn.onclick = () => show(btn.dataset.libraryTab);
          btn.onkeydown = (e) => {
            const order = tabs.map(([id]) => id),
              index = order.indexOf(btn.dataset.libraryTab),
              next = {
                ArrowRight: index + 1,
                ArrowLeft: index - 1,
                Home: 0,
                End: order.length - 1,
              }[e.key];
            if (next === undefined) return;
            e.preventDefault();
            show(order[(next + order.length) % order.length], true);
          };
        });
        show(library.tab);
        // The dialog chose its first field before the panel existed; typing
        // goes straight into the search, as in Miro.
        panel
          .querySelector('input[type="search"]')
          ?.focus({ preventScroll: true });
      },
    );
  }
  function exports() {
    const board = api.board(),
      shown = (api.visualBoard?.() || board).items,
      frames = orderedFrames(shown),
      chosen = new Set(api.selection()),
      selectedFrames = frames.filter((f) => chosen.has(f.id)),
      tables = shown.filter((i) => i.type === "table");
    // A selection of whole frames, with or without what they hold, exports
    // as those frames, one page or slide each, as Miro's frame export does.
    const byId = new Map(shown.map((i) => [i.id, i]));
    const inChosenFrame = (i) => {
      for (let n = 0; i && n < 100; i = byId.get(i.parentId), n++)
        if (i.type === "frame" && chosen.has(i.id)) return true;
      return false;
    };
    const framesChosen =
      selectedFrames.length > 0 &&
      [...chosen].every((id) => inChosenFrame(byId.get(id)));
    // Letter is the default in North America; elsewhere A4.
    const letter = /-(US|CA|MX|PH|CL|CO|VE|GT|PR)$/i.test(
      globalThis.navigator?.language || "",
    );
    const option = (value, label, selected = false) =>
      `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
    const sheetChoiceName = uid(),
      sheetChoices = [
        ["objects", escape(t("Text objects and tasks"))],
        ...(shown.some(hasTask) ? [["tasks", escape(t("Tasks"))]] : []),
        ["frames", escape(t("Frames"))],
        ...tables.map((i, n) => {
          const prefix = labelled(`${t("Table")} ${n + 1}`, ""),
            header = tableTextContent(i, {
              rows: [i.cells[0]],
              separator: ", ",
              limit: Math.max(0, 80 - prefix.length),
            });
          return [
            `table:${i.id}`,
            `${escape(prefix)}${authoredTextHTML(header)}`,
          ];
        }),
      ],
      sheetChoicesHTML = sheetChoices
        .map(
          ([value, label], n) =>
            `<label><input type="radio" name="${sheetChoiceName}" value="${escape(value)}" ${n === 0 ? "checked" : ""}><span>${label}</span></label>`,
        )
        .join("");
    api.modal(
      "Export board",
      `<form><label class="field">Export scope<select id="export-scope"><option value="board">Entire board</option><option value="selection" ${api.selection().size ? (api.region() && !framesChosen ? "selected" : "") : "disabled"}>Selected objects</option>${api.region() ? `<option value="region" ${framesChosen || api.selection().size ? "" : "selected"}>Export region</option>` : ""}<option value="frames" ${frames.length ? (framesChosen ? "selected" : "") : "disabled"}>Defined frames</option></select></label>${frames.length > 1 ? `<div class="slide-choice-actions" id="export-frame-actions" hidden><button type="button" class="text-btn" id="export-frames-all">${t("Select all")}</button><button type="button" class="text-btn" id="export-frames-none">${t("Select none")}</button></div>` : ""}<div id="export-frames" class="slide-choices" role="group" aria-label="${t("Frames to export")}" aria-describedby="export-error" hidden>${frames.map((f) => `<label><input type="checkbox" value="${escape(f.id)}" aria-describedby="export-error" ${!selectedFrames.length || selectedFrames.includes(f) ? "checked" : ""}><span>${frameTitleHTML(f, "Untitled frame")}</span></label>`).join("")}</div><label class="field">Export format<select id="export-format" aria-describedby="export-help"><optgroup label="${t("Documents and slides")}">${option("pdf", "PDF document")}${option("pptx", "PowerPoint slides")}</optgroup><optgroup label="${t("Images")}">${option("png", "PNG image")}${option("jpeg", "JPEG image")}${option("svg", "SVG vector image")}</optgroup><optgroup label="${t("Spreadsheets")}">${option("xlsx", "Excel workbook")}${option("csv", "CSV spreadsheet")}</optgroup><optgroup label="${t("Editable")}">${option("json", "Whiteboard file")}</optgroup></select></label>` +
        `<fieldset id="pdf-options" class="export-options"><legend>PDF options</legend><div class="field-row"><label class="field">Page size<select id="pdf-page-size">${option("letter", "Letter", letter)}${option("legal", "Legal")}${option("tabloid", "Tabloid")}${option("a4", "A4", !letter)}${option("a3", "A3")}${option("fit", "Fit to content")}</select></label><label class="field">Orientation<select id="pdf-orientation">${option("auto", "Automatic")}${option("landscape", "Landscape")}${option("portrait", "Portrait")}</select></label></div>` +
        `<div class="field-row"><label class="field">Scale<select id="pdf-scale" aria-describedby="export-help">${option("auto", "Readable detail")}${option("fit", "Fit each area on one page")}${[25, 50, 75, 100, 150, 200].map((n) => option(n, `${n}%`)).join("")}</select></label><label class="field">Margins<select id="pdf-margin">${option("narrow", "Narrow")}${option("normal", "Normal", true)}${option("wide", "Wide")}</select></label></div>` +
        `<label class="field">Rendering<select id="pdf-mode" aria-describedby="pdf-mode-help">${option("raster", "Image (matches the board exactly)")}${option("vector", "Vector (text and shapes)")}</select></label><p id="pdf-mode-help" class="dialog-copy"></p><label class="export-check"><input type="checkbox" id="pdf-markers" checked> Show page boundaries and labels</label><p id="pdf-estimate" class="dialog-copy" aria-live="polite"></p></fieldset>` +
        `<fieldset class="frame-choices" id="sheet-choice" hidden><legend>${t("Spreadsheet content")}</legend><div class="slide-choices" id="export-sheet">${sheetChoicesHTML}</div></fieldset>` +
        `<p id="export-help" class="dialog-copy"></p><p id="export-error" class="dialog-copy" role="alert" hidden></p><div class="dialog-footer"><p id="export-status" class="dialog-copy export-status" role="status" aria-live="polite"></p><button class="primary" type="submit">Export</button></div></form>`,
      (d) => {
        const $ = (selector) => d.querySelector(selector);
        $("#export-sheet").addEventListener("focusin", (e) => {
          e.target.closest("label")?.scrollIntoView?.({
            block: "nearest",
            inline: "nearest",
          });
          // Keep the radio visible even when its caption exceeds the scroll area.
          e.target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        });
        const clearError = () => {
          $("#export-error").textContent = "";
          $("#export-error").hidden = true;
          $("#export-frames").removeAttribute("aria-invalid");
        };
        const pdfOptions = () => ({
          pageSize: $("#pdf-page-size").value,
          orientation: $("#pdf-orientation").value,
          scale: $("#pdf-scale").value,
          margin: $("#pdf-margin").value,
          mode: $("#pdf-mode").value,
          markers: $("#pdf-markers").checked,
        });
        const frameIds = () =>
          [...d.querySelectorAll("#export-frames input:checked")].map(
            (i) => i.value,
          );
        const update = () => {
          clearError();
          const scope = $("#export-scope").value,
            format = $("#export-format").value;
          $("#export-frames").hidden = scope !== "frames";
          if ($("#export-frame-actions"))
            $("#export-frame-actions").hidden = scope !== "frames";
          $("#pdf-options").hidden = format !== "pdf";
          $("#sheet-choice").hidden = format !== "csv";
          $("#pdf-orientation").disabled = $("#pdf-page-size").value === "fit";
          if (!scaleChosen)
            $("#pdf-scale").value = scope === "frames" ? "fit" : "auto";
          const scale = $("#pdf-scale").value;
          $("#export-help").textContent =
            format !== "pdf" ||
            (scale === "auto" && $("#pdf-page-size").value !== "fit")
              ? t(EXPORT_HELP[format])
              : $("#pdf-page-size").value === "fit"
                ? t(PDF_SCALE_HELP.page)
                : scale === "fit"
                  ? t(PDF_SCALE_HELP.fit)
                  : t(PDF_SCALE_HELP.percent).replace("{scale}", `${scale}%`);
          $("#pdf-mode-help").textContent = t(
            RENDERING_HELP[$("#pdf-mode").value],
          );
          if (format !== "pdf") return;
          // With no frame chosen there is nothing to count; exporting says
          // the same.
          if (scope === "frames" && !frameIds().length) {
            $("#pdf-estimate").textContent = t("Choose at least one frame.");
            return;
          }
          // Page count preview for the current scope and page settings.
          try {
            const plan = pdfPlan(
              exportRegions(api.visualBoard?.() || board, {
                scope,
                selection: chosen,
                region: api.region(),
                frameIds: frameIds(),
              }),
              pdfOptions(),
            );
            // Readable detail is shown smaller where the area needs more
            // pages than an export holds; that is said, with what helps.
            const reduce = Math.min(
              1,
              ...plan.map((p) => (p.kind === "overview" ? p.reduce : 1)),
            );
            $("#pdf-estimate").textContent =
              (plan.length === 1
                ? t("Estimated length: 1 page.")
                : t("Estimated length: {count} pages.").replace(
                    "{count}",
                    plan.length,
                  )) +
              (reduce < 1
                ? ` ${t(
                    "Detail is shown at {percent}% to keep the export to a reasonable length. Export frames or a selected region for more detail.",
                  ).replace(
                    "{percent}",
                    Math.max(1, Math.round(reduce * 100)),
                  )}`
                : "");
          } catch (error) {
            $("#pdf-estimate").textContent = t(error.message);
          }
        };
        // Frames print as slides do, one page each, until a scale is
        // chosen; other scopes split large areas into readable detail.
        let scaleChosen = false;
        $("#pdf-scale").addEventListener("change", () => (scaleChosen = true));
        d.querySelector("form").addEventListener("change", update);
        // Exporting a few of many frames starts from none.
        for (const [id, checked] of [
          ["#export-frames-all", true],
          ["#export-frames-none", false],
        ]) {
          const button = d.querySelector(id);
          if (button)
            button.onclick = () => {
              for (const input of d.querySelectorAll("#export-frames input"))
                input.checked = checked;
              update();
            };
        }
        update();
        // Closing the dialog cancels an export in progress: it stops
        // between pages, frames or slides, and nothing downloads.
        let running = null;
        d.addEventListener("close", () => running?.abort());
        d.querySelector("form").onsubmit = async (e) => {
          e.preventDefault();
          clearError();
          const btn = d.querySelector("button[type=submit]"),
            status = $("#export-status"),
            run = (running = new AbortController()),
            { signal } = run;
          btn.disabled = true;
          status.textContent = t("Preparing export…");
          let missingFrames = false;
          try {
            const scope = $("#export-scope").value,
              format = $("#export-format").value,
              ids = frameIds();
            if (scope === "frames" && !ids.length) {
              missingFrames = true;
              throw Error("Choose at least one frame.");
            }
            const snapshot = clone(
                format === "json" ? board : api.visualBoard?.() || board,
              ),
              selection = new Set(api.selection()),
              region = clone(api.region());
            await loadItemFonts(snapshot.items);
            await document.fonts?.ready;
            clearTextLayoutCache();
            clearConnectorLabelCache();
            if (
              reflowTextItems(
                snapshot.items,
                document.createElement("canvas").getContext("2d"),
              )
            )
              updateConnectors(snapshot.items);
            const regions = exportRegions(snapshot, {
              scope,
              selection,
              region,
              frameIds: ids,
              // Data formats hold every object; pictures show the board
              // as it is seen, with collapsed branches folded away.
              includeHidden: ["json", "xlsx", "csv"].includes(format),
            });
            let blob;
            if (format === "pdf")
              blob = await exportPDF(snapshot, regions, language, undefined, {
                ...pdfOptions(),
                signal,
                progress: (n, total) =>
                  (status.textContent = t("Exporting page {n} of {total}…")
                    .replace("{n}", n)
                    .replace("{total}", total)),
              });
            // The PowerPoint and SVG writers load when first used.
            else if (format === "pptx")
              blob = await (
                await loadWriter(import("./export-pptx.js"))
              ).exportPPTX(snapshot, regions, {
                lang: language,
                signal,
                progress: (n, total) =>
                  (status.textContent = t("Exporting slide {n} of {total}…")
                    .replace("{n}", n)
                    .replace("{total}", total)),
              });
            else if (format === "svg")
              blob = (await loadWriter(import("./export-svg.js"))).exportSVG(
                snapshot,
                regions,
                {
                  lang: language,
                  // The fonts its text uses go with it.
                  fonts: await fontFiles(
                    [
                      ...itemFontFamilies([
                        // Titles and tags are in DM Sans.
                        { fontFamily: "dm-sans" },
                        ...regions.flatMap((r) => r.items),
                      ]),
                    ].map((id) => FONT_FAMILIES.find((f) => f.id === id).name),
                  ),
                },
              );
            else if (format === "xlsx")
              blob = exportXLSX(
                snapshot,
                regions,
                taskSheets(snapshot, regions),
              );
            else if (format === "csv")
              blob = exportCSV(
                snapshot,
                regions,
                $("#export-sheet input:checked").value,
                taskSheets(snapshot, regions),
              );
            else if (format === "json") {
              const items = [
                  ...new Map(
                    regions
                      .flatMap((r) => r.items)
                      .map((i) => [i.id, clone(i)]),
                  ).values(),
                ],
                kept = new Set(items.map((i) => i.id));
              for (const i of items) {
                trimMindMap(i, kept);
                if (!kept.has(i.parentId)) delete i.parentId;
                if (!kept.has(i.startId)) delete i.startId;
                if (!kept.has(i.endId)) delete i.endId;
              }
              const exported = { ...snapshot, items };
              if (scope !== "board") {
                delete exported.comments;
                delete exported.workshop;
                if (exported.tags)
                  exported.tags = referencedTags(items, exported.tags);
                externalizeObjectLinks(
                  items,
                  api.objectURL && ((id) => api.objectURL(id, snapshot)),
                );
              }
              delete exported.shared;
              delete exported.timer;
              api.portable?.(exported);
              await api.includeSharedMedia?.(exported);
              // Without indentation, which can add half again to the size of
              // a board with many objects.
              blob = JSON.stringify(exported);
            } else if (regions.length === 1)
              blob = await exportImage(
                { ...snapshot, items: regions[0].items },
                regions[0].rect,
                format,
                { mindCounts: regions[0].mindCounts },
              );
            else {
              // Several frames download together, one image each, numbered
              // in frame order, as one ZIP file.
              if (regions.length > 50)
                throw Error(
                  "Export up to 50 frames as images at a time, or use PDF.",
                );
              const entries = [];
              for (const [n, r] of regions.entries()) {
                if (signal.aborted) return;
                status.textContent = t("Exporting image {n} of {total}…")
                  .replace("{n}", n + 1)
                  .replace("{total}", regions.length);
                const image = await exportImage(
                  { ...snapshot, items: r.items },
                  r.rect,
                  format,
                  { mindCounts: r.mindCounts },
                );
                entries.push({
                  name: `${String(n + 1).padStart(2, "0")} ${fileName(r.name, t("Frame"))}.${format}`,
                  data: await fileBytes(image),
                });
              }
              blob = new Blob([createZip(entries)], {
                type: "application/zip",
              });
            }
            if (signal.aborted) return;
            running = null;
            const zipped = blob.type === "application/zip";
            api.download(
              blob,
              // A title of only symbols still names the file, instead of
              // a hidden ".pdf".
              fileName(board.title, "Whiteboard") +
                "." +
                (zipped ? "zip" : format),
              zipped ? "application/zip" : EXPORT_TYPES[format],
            );
            api.exported?.(format, scope);
            d.close();
            // Said after the dialog is gone; a status inside it would be
            // removed with it before it is read out.
            api.toast("Export ready.");
          } catch (error) {
            // A cancelled export closed with its dialog; it is no error.
            if (signal.aborted) return;
            running = null;
            status.textContent = "";
            $("#export-error").textContent = t(
              error.message || "Export failed. Please try again.",
            );
            $("#export-error").hidden = false;
            if (missingFrames) {
              $("#export-frames").setAttribute("aria-invalid", "true");
              $("#export-frames input")?.focus();
            }
            btn.disabled = false;
          }
        };
      },
    );
  }
  function shapeLibrary(change = false) {
    const board = api.board();
    const ids = new Set(
      change
        ? selected()
            .filter(canSwitchShape)
            .map((i) => i.id)
        : [],
    );
    if (!board) return;
    // A participant of a locked board adds only sticky notes, and cannot
    // turn their own into other shapes.
    const locked = api.boardLocked?.();
    if (locked) return api.toast(locked);
    if (!api.canEdit(change ? api.selection() : ids)) return;
    const chosen = board.items.filter((i) => ids.has(i.id));
    if (change && (!chosen.length || !chosen.every(canSwitchShape))) return;
    let family = "";
    api.modal(
      change ? "Change shape" : "Shapes",
      `<label class="search template-search"><input id="shape-search" type="search" aria-label="Search shapes" placeholder="Search shapes" autocomplete="off"></label><div class="shape-chips"></div><div class="shape-families"></div>`,
      (d) => {
        // From the tool rail the shapes open beside it, over the board,
        // rather than in the middle of the window.
        const rail = change
          ? null
          : document.querySelector(".left-rail")?.getBoundingClientRect();
        if (rail?.width) {
          d.classList.add("rail-flyout");
          d.style.setProperty(
            "--flyout-left",
            `${Math.round(rail.right + 8)}px`,
          );
          d.style.setProperty("--flyout-top", `${Math.round(rail.top)}px`);
        }
        const container = d.querySelector(".shape-families"),
          search = d.querySelector("#shape-search");
        const families = filterChips(
          d,
          "Shape families",
          [
            ["", t("All")],
            ...shapeFamilies(change).map((f) => [f.id, t(f.name)]),
          ],
          "",
          "family",
          (id) => {
            family = id;
            render();
          },
        );
        d.querySelector(".shape-chips").outerHTML = families.html;
        const render = () => {
          const results = searchShapes(search.value, family, change);
          container.innerHTML = results.length
            ? results
                .map(
                  (f) =>
                    `<section class="shape-family"><h3 id="shape-family-${f.id}">${t(f.name)}</h3><div class="shape-library" role="group" aria-labelledby="shape-family-${f.id}">${f.shapes
                      .map(
                        ({ key, name, hint }) =>
                          `<button type="button" class="shape-choice" data-shape="${key}" title="${t(name)}" ${change ? `aria-pressed="${chosen.every((i) => shapeKey(i) === key)}"` : ""}>${shapePreview(key)}<strong>${t(name)}</strong>${hint && f.id === "basic" ? `<small>${t(hint)}</small>` : ""}</button>`,
                      )
                      .join("")}</div></section>`,
                )
                .join("")
            : `<p class="dialog-copy">${t("No shapes found.")}</p>`;
          // Choices other features register, such as task cards, are found
          // as shapes are: in either language, ignoring accents and order.
          const words = fold(search.value).split(/\s+/).filter(Boolean);
          const extras =
            change || family
              ? []
              : extraShapes.filter((c) => {
                  const text = fold(
                    [c.name, t(c.name), c.hint || "", t(c.hint || "")]
                      .concat(c.keywords || [])
                      .join(" "),
                  );
                  return words.every((word) => text.includes(word));
                });
          if (extras.length) {
            container.querySelector(":scope > p.dialog-copy")?.remove();
            container.insertAdjacentHTML(
              "beforeend",
              `<section class="shape-family"><h3 id="shape-family-extra">${t("Planning")}</h3><div class="shape-library" role="group" aria-labelledby="shape-family-extra">${extras.map((c) => `<button type="button" class="shape-choice" data-extra="${c.key}">${c.icon || ""}<strong>${t(c.name)}</strong>${c.hint ? `<small>${t(c.hint)}</small>` : ""}</button>`).join("")}</div></section>`,
            );
            container.querySelectorAll("[data-extra]").forEach((btn) => {
              btn.onclick = () => {
                if (api.board() !== board || !api.canEdit(ids)) return;
                d.close();
                extraShapes.find((c) => c.key === btn.dataset.extra)?.run();
              };
            });
          }
          container.querySelectorAll("[data-shape]").forEach((btn) => {
            btn.onclick = (e) => {
              if (api.board() !== board || !api.canEdit(ids)) return;
              const key = btn.dataset.shape;
              if (change) {
                // Re-read after the dialog: collaborators can change or delete objects.
                const items = board.items.filter((i) => ids.has(i.id));
                if (items.length !== ids.size || !items.every(canSwitchShape))
                  return d.close();
                d.close();
                if (items.every((i) => shapeKey(i) === key)) return;
                api.mutate(() => items.forEach((i) => switchShape(i, key)));
              } else {
                d.close();
                // A pointer places the shape where it clicks or drags next,
                // as in Miro; the keyboard adds it in the middle of the view.
                api.addShape(key, { arm: e.detail > 0 });
              }
            };
          });
        };
        render();
        families.bind();
        bindSearch(search, container, render);
        gridKeys(container, ".shape-choice");
      },
    );
  }
  function more() {
    const groups = [
      [
        "Insert",
        [
          ["shapes", "Shapes"],
          ["link", "Add link"],
          ["table", "Add table"],
          ["mind-map", "Mind map"],
          ["bulk-notes", "Bulk sticky notes"],
          ["file", "Attach file"],
          ["import-document", "Import document"],
          ["embed", "Embed content"],
          ["google-workspace", "Google Workspace"],
          ["templates", "Template library"],
          ["components", "Components"],
          ["icons", "Icons and stickers"],
          ...extraTools.map(([action, label]) => [action, label]),
        ],
      ],
      [
        "Selection",
        [
          ["organize", "Organize selection"],
          ["filter-selection", "Filter selection"],
          ["cluster", "Cluster sticky notes"],
          ["copy-image", "Copy as image"],
          ["copy-style", "Copy style"],
          ["paste-style", "Paste style"],
          ["clear-content", "Clear content"],
          ["replace-image", "Replace image"],
          ["unlock-all", "Unlock all objects"],
        ],
      ],
      [
        "View",
        [
          ["frames", "Frames and navigation"],
          ["minimap", "Minimap"],
          ["present", "Presentation"],
          ["timer", "Timer"],
          ["facilitation", "Facilitation"],
          ["dimensions", "Object dimensions"],
        ],
      ],
      [
        "Board",
        [
          ["history", "Version history"],
          ["region", "Select export region"],
          ["exact-region", "Set export region"],
          ...(api.region() ? [["clear-region", "Clear export region"]] : []),
          ["grid", "Grid and snapping"],
          ["selection-settings", "Selection settings"],
          ["navigation", "Mouse, trackpad, and touch"],
          // Mentions, replies and assignments from other boards, without
          // going back to the library.
          ...(api.notificationsAvailable?.()
            ? [["notifications", "Notifications"]]
            : []),
        ],
      ],
      [
        "Help",
        [
          ["commands", "Command palette"],
          ["help-center", "Help and training"],
          ["help", "Keyboard shortcuts"],
        ],
      ],
    ];
    api.modal(
      "More tools",
      groups
        .map(
          ([heading, tools], n) =>
            `<h3 class="more-tools-heading" id="more-tools-${n}">${t(heading)}</h3><div class="more-tools-grid" role="group" aria-labelledby="more-tools-${n}">${tools
              .map(
                ([action, label]) =>
                  `<button class="secondary" data-feature="${action}" ${["copy-image", "filter-selection", "clear-content"].includes(action) && !api.selection().size ? "disabled" : ""}>${label}</button>`,
              )
              .join("")}</div>`,
        )
        .join(""),
      (d) => {
        // From its button in the header, the list hangs under it like a
        // menu rather than opening in the middle of the window.
        const from = document
          .querySelector('[data-action="more-tools"]')
          ?.getBoundingClientRect();
        if (from?.width && window.innerWidth > 760) {
          d.classList.add("anchored-menu");
          d.style.setProperty("--menu-top", `${Math.round(from.bottom + 8)}px`);
          d.style.setProperty(
            "--menu-right",
            `${Math.max(8, Math.round(window.innerWidth - from.right))}px`,
          );
        }
        d.querySelectorAll("[data-feature]").forEach(
          (btn) =>
            (btn.onclick = () => {
              d.close();
              runTool(btn.dataset.feature);
            }),
        );
      },
    );
  }
  // Runs a More tools entry, whichever part of the app provides it.
  function runTool(action) {
    const extra = extraTools.find(([name]) => name === action);
    if (action === "help") api.help();
    else if (action === "help-center") api.helpCenter();
    else if (action === "notifications") api.notifications?.();
    else if (extra) extra[2]();
    else actions[action]?.();
  }
  // What the tool rail's Add content button offers: the kinds of content
  // its own tools do not add, as tiles beside the rail, as in Miro.
  function addContent() {
    if (!api.board()) return;
    const choices = [
      ["table", "table", "Table"],
      ["link", "link", "Link"],
      ["file", "paperclip", "File"],
      ["mind-map", "network", "Mind map"],
      ["embed", "app-window", "Embed"],
      ["task-card", "square-check", "Task card"],
      ["bulk-notes", "sticky-note", "Bulk sticky notes"],
      ["components", "component", "Components"],
      ["icons", "smile-plus", "Icons and stickers"],
    ].filter(
      ([action]) => actions[action] || extraTools.some(([n]) => n === action),
    );
    api.modal(
      "Add content",
      `<div class="add-content-grid" role="group" aria-label="${t("Add content")}">${choices
        .map(
          ([action, ic, label]) =>
            `<button type="button" class="secondary add-content-choice" data-add="${action}"><i data-lucide="${ic}" aria-hidden="true"></i><span>${t(label)}</span></button>`,
        )
        .join("")}</div>`,
      (d) => {
        // Beside its button on the rail, over the board, kept on screen.
        const from = document
          .querySelector('.left-rail [data-action="add-content"]')
          ?.getBoundingClientRect();
        const rail = document
          .querySelector(".left-rail")
          ?.getBoundingClientRect();
        if (from?.width && rail?.width && window.innerWidth > 760) {
          d.classList.add("rail-flyout", "add-content-flyout");
          d.style.setProperty(
            "--flyout-left",
            `${Math.round(rail.right + 8)}px`,
          );
          const height = d.getBoundingClientRect().height || 320;
          d.style.setProperty(
            "--flyout-top",
            `${Math.round(Math.max(8, Math.min(from.top, window.innerHeight - height - 16)))}px`,
          );
        }
        const grid = d.querySelector(".add-content-grid");
        grid.querySelectorAll("[data-add]").forEach(
          (btn) =>
            (btn.onclick = () => {
              d.close();
              runTool(btn.dataset.add);
            }),
        );
        gridKeys(grid, ".add-content-choice");
      },
    );
  }
  // Adding content is refused as these open, with the reason, rather than
  // after someone has filled them in or picked a file.
  const adding = (open) => () => api.canEdit(new Set()) && open();
  const actions = {
    commands: () => api.commands(),
    "mind-map": () => api.mindMap(),
    shapes: () => shapeLibrary(),
    "change-shape": () => shapeLibrary(true),
    link: adding(() => linkDialog()),
    table: adding(() => tableDialog()),
    "bulk-notes": () => api.bulkNotes(),
    file: adding(() => attachFile()),
    organize,
    "filter-selection": () => openSelectionFilter(api),
    cluster: () => openClusters(api),
    "copy-image": () => api.copyImage(),
    "copy-style": () => api.copyStyle(),
    "paste-style": () => api.pasteStyle(),
    "clear-content": () => api.clearContent(),
    "replace-image": () => api.replaceImage(),
    "unlock-all": () => api.unlockAll(),
    frames: () => api.frames(),
    minimap: () => api.minimap(),
    timer: () => api.timer(),
    facilitation: () => api.facilitation?.(),
    navigation: () => api.navigation(),
    "selection-settings": () => api.selectionSettings(),
    grid: () => api.grid(),
    dimensions: () => api.dimensions(),
    present: presentationSetup,
    history: versions,
    // Away from a board, templates only start new boards.
    templates: () =>
      (!api.board() || api.canEdit(new Set())) && templateLibrary("templates"),
    components: adding(() => templateLibrary("components")),
    icons: adding(() => templateLibrary("icons")),
    "save-snippet": saveSnippet,
    "more-tools": more,
    "add-content": addContent,
    region: () => api.setTool("region"),
    "exact-region": () => api.exactRegion(),
    "clear-region": () => api.clearRegion(),
    export: exports,
  };
  return {
    actions,
    followSlide,
    // Inserts a whole template's objects into the open board, as the
    // template library does, with a Kanban board's status sync.
    insertTemplate: (items, tags, planning) =>
      insertContent(items, tags, { template: true, planning }),
    organizeSelection,
    edit(i) {
      if (i.type === "link") linkDialog(i);
      else if (i.type === "table") tableDialog(i);
      else if (i.type === "file") fileDialog(i);
      else return false;
      return true;
    },
  };
}
