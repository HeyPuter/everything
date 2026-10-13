// Photo Album: choose several pictures, put them in order, pick a layout,
// captions and a frame, and get new slides with the pictures laid out.
import { el, dialog, iconButton, icon } from "../ui.js";
import { text as textBox } from "../model.js";
import { canvasPng, checkbox, fieldRow, loadImage, pickFiles } from "./util.js";

import {
  ALBUM_LAYOUTS,
  ALBUM_FRAMES,
  albumBoxes,
  containBox,
} from "./geometry.js";
export { ALBUM_LAYOUTS, ALBUM_FRAMES, albumBoxes, containBox };

async function grayscale(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const g = canvas.getContext("2d");
    g.filter = "grayscale(1)";
    g.drawImage(image, 0, 0);
    return canvasPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createPhotoAlbum(ctx) {
  const { P } = ctx;

  async function photoAlbum() {
    ctx.commitText();
    const items = []; // { file, url, caption }
    let selected = -1;
    let layout = "1";
    let frame = "rect";
    let captions = false;
    let blackAndWhite = false;
    let titleSlide = true;
    const list = el("ul", {
      class: "album-list",
      role: "listbox",
      "aria-label": "Pictures in album",
    });
    const preview = el(
      "div",
      { class: "album-preview" },
      el("p", {}, "Add pictures to begin."),
    );
    const status = el("p", { class: "album-status", role: "status" });
    const albumTitle = el("input", {
      class: "input",
      value: "Photo Album",
      maxlength: 120,
      "aria-label": "Album title",
    });
    const move = (step) => {
      const to = selected + step;
      if (selected < 0 || to < 0 || to >= items.length) return;
      [items[selected], items[to]] = [items[to], items[selected]];
      selected = to;
      render();
      list.children[selected]?.focus();
    };
    const remove = () => {
      if (selected < 0) return;
      URL.revokeObjectURL(items[selected].url);
      items.splice(selected, 1);
      selected = Math.min(selected, items.length - 1);
      render();
    };
    const up = iconButton("Move up", "ArrowUp", () => move(-1));
    const down = iconButton("Move down", "ArrowDown", () => move(1));
    const removeButton = el(
      "button",
      { type: "button", class: "btn secondary", onclick: remove },
      "Remove",
    );
    function render() {
      list.replaceChildren(
        ...items.map((item, i) =>
          el(
            "li",
            {
              class: `album-item ${i === selected ? "selected" : ""}`,
              role: "option",
              tabindex: i === selected || (selected < 0 && i === 0) ? 0 : -1,
              "aria-selected": String(i === selected),
              onclick: () => {
                selected = i;
                render();
              },
              onkeydown: (e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (e.altKey) move(e.key === "ArrowDown" ? 1 : -1);
                  else {
                    selected = Math.max(
                      0,
                      Math.min(
                        items.length - 1,
                        i + (e.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
                    render();
                    list.children[selected]?.focus();
                  }
                } else if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  remove();
                }
              },
            },
            el("span", { class: "album-index" }, `${i + 1}`),
            el("img", { src: item.url, alt: "" }),
            el("input", {
              class: "input album-caption",
              value: item.caption,
              "aria-label": `Caption for picture ${i + 1}`,
              onclick: (e) => e.stopPropagation(),
              oninput: (e) => (item.caption = e.target.value),
            }),
          ),
        ),
      );
      up.disabled = selected <= 0;
      down.disabled = selected < 0 || selected >= items.length - 1;
      removeButton.disabled = selected < 0;
      const item = items[selected] ?? items[0];
      preview.replaceChildren(
        item
          ? el("img", { src: item.url, alt: `Preview of ${item.caption}` })
          : el("p", {}, "Add pictures to begin."),
      );
      const perSlide = ALBUM_LAYOUTS.find(([id]) => id === layout)[2];
      status.textContent = items.length
        ? `${items.length} picture${items.length === 1 ? "" : "s"} on ${Math.ceil(items.length / perSlide)} slide${Math.ceil(items.length / perSlide) === 1 ? "" : "s"}.`
        : "";
    }
    const add = el(
      "button",
      {
        type: "button",
        class: "btn secondary",
        onclick: async () => {
          const files = await pickFiles("image/png,image/jpeg", {
            multiple: true,
          });
          for (const file of files)
            items.push({
              file,
              url: URL.createObjectURL(file),
              caption: file.name.replace(/\.[^.]+$/, ""),
            });
          if (selected < 0 && items.length) selected = 0;
          render();
        },
      },
      icon("Plus", 16),
      el("span", {}, "Add Pictures…"),
    );
    const layoutSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Picture layout",
        onchange: (e) => ((layout = e.target.value), render()),
      },
      ...ALBUM_LAYOUTS.map(([id, label]) =>
        el("option", { value: id, selected: id === layout }, label),
      ),
    );
    const frameSelect = el(
      "select",
      {
        class: "input",
        "aria-label": "Frame shape",
        onchange: (e) => (frame = e.target.value),
      },
      ...ALBUM_FRAMES.map(([id, label]) => el("option", { value: id }, label)),
    );
    const body = el(
      "div",
      { class: "dialog-body album-dialog" },
      el(
        "div",
        { class: "album-columns" },
        el(
          "section",
          { class: "album-pictures", "aria-label": "Pictures" },
          el("div", { class: "album-toolbar" }, add, up, down, removeButton),
          list,
          status,
        ),
        el(
          "section",
          { class: "album-side", "aria-label": "Preview and options" },
          preview,
          fieldRow("Album title", albumTitle),
          checkbox(
            "Start with a title slide",
            titleSlide,
            (on) => (titleSlide = on),
          ),
          fieldRow("Picture layout", layoutSelect),
          fieldRow("Frame shape", frameSelect),
          checkbox(
            "Captions below pictures",
            captions,
            (on) => (captions = on),
          ),
          checkbox(
            "All pictures black and white",
            blackAndWhite,
            (on) => (blackAndWhite = on),
          ),
        ),
      ),
    );
    render();
    const ok = await dialog({ title: "Photo Album", body, confirm: "Create" });
    const urls = items.map((i) => i.url);
    if (!ok || !items.length) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      return;
    }
    // Read (and scale down) every picture before the edit.
    const pictures = [];
    for (const item of items) {
      const image = await ctx.readImage(item.file);
      const bytes = blackAndWhite
        ? await grayscale(image.bytes, item.file.type)
        : image.bytes;
      pictures.push({
        ...image,
        bytes,
        caption: item.caption,
        name: item.file.name,
      });
    }
    urls.forEach((u) => URL.revokeObjectURL(u));
    const size = ctx.currentSize();
    const [, , perSlide, titled] = ALBUM_LAYOUTS.find(([id]) => id === layout);
    const ink = ctx.inkColor();
    let firstNew = null;
    await ctx.mutate(() => {
      const pres = ctx.pres();
      const before = P.getSlides(pres).length;
      if (titleSlide) {
        const s = P.addBlankSlide(pres);
        const inch = 914400;
        textBox(
          s,
          albumTitle.value.trim() || "Photo Album",
          1,
          size.cy / inch / 2 - 0.9,
          size.cx / inch - 2,
          1.2,
          44,
          ink,
          true,
        );
        P.setShapeAlignment?.(P.getSlideShapes(s).at(-1), "center");
      }
      for (let at = 0; at < pictures.length; at += perSlide) {
        const group = pictures.slice(at, at + perSlide);
        const s = P.addBlankSlide(pres);
        const inch = 914400;
        if (titled)
          textBox(
            s,
            albumTitle.value.trim() || "Photo Album",
            0.6,
            0.35,
            size.cx / inch - 1.2,
            0.9,
            32,
            ink,
            true,
          );
        const cells = albumBoxes(layout, group.length, size, captions);
        group.forEach((picture, i) => {
          const cell = cells[i];
          const b =
            layout === "fit"
              ? containBox(cell, picture.width, picture.height)
              : containBox(cell, picture.width, picture.height);
          const shape = P.addSlideImage(s, picture.bytes, {
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.w),
            h: Math.round(b.h),
            name: `Picture ${i + 1}`,
          });
          P.setShapeDescription(shape, picture.caption || picture.name);
          applyFrame(shape, frame);
          if (captions && picture.caption) {
            const caption = textBox(
              s,
              picture.caption,
              b.x / inch,
              (b.y + b.h) / inch + 0.05,
              b.w / inch,
              0.4,
              14,
              ink,
            );
            P.setShapeAlignment?.(caption, "center");
          }
        });
        ctx.dedupe(s);
      }
      firstNew = before;
    });
    if (firstNew != null) ctx.goToSlide(firstNew);
  }

  function applyFrame(shape, frame) {
    switch (frame) {
      case "roundRect":
      case "ellipse":
        P.setShapePresetGeometry(shape, frame);
        break;
      case "whiteFrame":
        P.setShapeStroke(shape, { color: "#FFFFFF", widthEmu: 88900 });
        P.setShapeShadow(shape, {
          blurEmu: 50800,
          offsetEmu: 19050,
          opacity: 0.35,
        });
        break;
      case "blackFrame":
        P.setShapeStroke(shape, { color: "#000000", widthEmu: 88900 });
        break;
      case "shadow":
        P.setShapeShadow(shape, {
          blurEmu: 127000,
          offsetEmu: 38100,
          opacity: 0.4,
        });
        break;
    }
  }

  return { photoAlbum };
}
