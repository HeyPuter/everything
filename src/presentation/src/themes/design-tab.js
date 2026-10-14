// The Design tab's theme commands: the theme gallery (applied to every slide
// or to the selected ones), variants, color schemes, font pairs, effect
// schemes and background styles, with Customize Colors and Customize Fonts,
// Browse for Themes and Save Current Theme. The editor reaches these through
// `ribbonApi()`; everything that changes the presentation goes through the
// host's undoable `mutate`.
import { el, dialog, openMenu, toast, button } from "../ui.js";
import { P } from "../model.js";
import {
  CATALOG,
  COLOR_SCHEMES,
  FONT_PAIRS,
  LEGACY_IDS,
  paletteOf,
  themeById,
} from "./catalog.js";
import * as E from "./engine.js";
import {
  EFFECT_SCHEMES,
  SCHEME_SLOTS,
  backgroundStyles,
  readThemeXml,
} from "./theme-xml.js";
import { accentStrip, fillCss, themePicture, themeTile } from "./thumbnails.js";
import "./themes.css";

const CUSTOM_COLORS_KEY = "presentation:custom-color-schemes";
const CUSTOM_FONTS_KEY = "presentation:custom-font-schemes";
const SLOT_LABELS = {
  dk1: "Text/Background – Dark 1",
  lt1: "Text/Background – Light 1",
  dk2: "Text/Background – Dark 2",
  lt2: "Text/Background – Light 2",
  accent1: "Accent 1",
  accent2: "Accent 2",
  accent3: "Accent 3",
  accent4: "Accent 4",
  accent5: "Accent 5",
  accent6: "Accent 6",
  hlink: "Hyperlink",
  folHlink: "Followed Hyperlink",
};

const readList = (key) => {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
const writeList = (key, list) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
};
export const customColorSchemes = () =>
  readList(CUSTOM_COLORS_KEY).filter(
    (s) =>
      s?.name &&
      SCHEME_SLOTS.every((slot) =>
        /^#[0-9a-f]{6}$/i.test(s.colors?.[slot] || ""),
      ),
  );
export const customFontSchemes = () =>
  readList(CUSTOM_FONTS_KEY).filter((s) => s?.name && s.major && s.minor);

export function createThemeTools(host) {
  // host: {
  //   pres(), slide(), selectedSlides(), available(), masterView(),
  //   mutate(fn, options), skip, palette(), setPalette(key),
  //   formatBackground(), pickFile(accept, handler), download(blob, name),
  //   fontList(), rerender(), docName(),
  // }
  const pres = () => host.pres();
  const slides = () => P.getSlides(pres());
  const aspect = () => {
    const size = P.getSlideSize(pres());
    return size && Number(size.width) / Number(size.height) < 1.5
      ? "4:3"
      : "16:9";
  };
  // The masters an edit to "the theme" reaches: those the slides use.
  const deckMasters = () => {
    const used = E.mastersOf(pres(), slides());
    return used.length
      ? used
      : P.getSlideMasters(pres()).map((m) => m.partName);
  };
  const currentMaster = () =>
    E.masterOfSlide(pres(), host.slide()) || deckMasters()[0];
  const info = () => {
    try {
      return E.masterInfo(pres(), currentMaster());
    } catch {
      return null;
    }
  };
  const resolvedColors = (i = info()) => i?.colors || {};
  const slidesOn = (masters) =>
    slides().filter((s) => masters.includes(E.masterOfSlide(pres(), s)));
  const run =
    (fn) =>
    (...args) => {
      try {
        const result = fn(...args);
        result?.catch?.((e) => toast(e?.message || String(e)));
      } catch (e) {
        toast(e?.message || String(e));
      }
    };

  // ---- Themes -------------------------------------------------------------

  /**
   * Applies built-in theme `id` to every slide (or `selected` slides) in
   * `variant`. False when every slide already has it.
   */
  function applyTheme(id, { selected = false, variant = 0 } = {}) {
    if (!themeById(id)) return false;
    return host.mutate(() => {
      const targets = selected ? host.selectedSlides() : slides();
      if (!targets.length) return host.skip;
      const masters = E.mastersOf(pres(), targets);
      const already =
        masters.length === 1 &&
        (!selected || slidesOn(masters).length === targets.length) &&
        E.masterInfo(pres(), masters[0])?.theme?.id === id &&
        E.masterInfo(pres(), masters[0])?.variant === variant;
      if (already) return host.skip;
      const from = E.currentPalette(pres(), targets[0], host.palette());
      E.applyTheme(pres(), id, {
        variant,
        slides: selected ? targets : undefined,
        from,
      });
      if (!selected) host.setPalette(id);
    });
  }

  /**
   * The palette command the assistant and the Theme dialog use: the deck in
   * theme `key`. False when the deck already uses it.
   */
  function applyPalette(key) {
    if (!themeById(key) || key === host.palette()) return false;
    const from = E.currentPalette(pres(), host.slide(), host.palette());
    E.applyTheme(pres(), key, { from });
    host.setPalette(key);
  }

  function applyMasterToSlides(master, selected) {
    return host.mutate(() => {
      const targets = selected ? host.selectedSlides() : slides();
      const before = E.mastersOf(pres(), targets);
      if (before.length === 1 && before[0] === master) return host.skip;
      for (const s of targets) E.moveSlideToMaster(pres(), s, master);
      if (!selected) E.dropUnusedMasters(pres(), before);
    });
  }

  function themeChoices() {
    const deck = P.getSlideMasters(pres())
      .filter((m) => m.slideCount > 0 || P.getSlideMasters(pres()).length === 1)
      .map((m) => {
        const i = E.masterInfo(pres(), m.partName);
        const layout =
          m.layouts.find((l) => l.type === "title") || m.layouts[0];
        return {
          id: `deck:${m.partName}`,
          label: i?.name || m.name || "This presentation",
          description: "A theme this presentation uses",
          section: "deck",
          version: layout ? templateVersion(layout.partName) : "",
          render: () =>
            el(
              "span",
              { class: "theme-tile" },
              layout
                ? el("img", {
                    src: deckPicture(layout.partName),
                    alt: "",
                    draggable: "false",
                  })
                : el("span", { class: "theme-tile-empty" }),
              i?.colors?.accent1 ? accentStrip(i.colors) : null,
            ),
        };
      });
    return [
      ...deck,
      ...CATALOG.map((t) => ({
        id: t.id,
        label: t.name,
        section: "builtin",
        render: () => themeTile(t.id, 0, aspect()),
      })),
    ];
  }
  const pictureCache = new Map();
  function templateVersion(part) {
    const pkg = P._internalPackageOf(pres());
    const master = P.getLayoutMasterPartName(pres(), part);
    return [part, master]
      .map((n) => pkg.getPart(n)?.data?.length || 0)
      .join(".");
  }
  function deckPicture(layoutPart) {
    const key = `${layoutPart}|${templateVersion(layoutPart)}`;
    if (!pictureCache.has(key)) {
      const view = P.getTemplateSlide(pres(), layoutPart);
      pictureCache.set(key, host.preview(view));
    }
    return pictureCache.get(key);
  }
  function currentTheme() {
    const i = info();
    if (i?.theme && E.masterInfo(pres(), currentMaster())?.variant >= 0)
      return i.theme.id;
    return `deck:${currentMaster()}`;
  }
  function chooseTheme(id) {
    if (String(id).startsWith("deck:"))
      return applyMasterToSlides(id.slice(5), false);
    return applyTheme(id);
  }
  function themeContextMenu(choice) {
    const deck = String(choice.id).startsWith("deck:");
    return [
      {
        label: "Apply to All Slides",
        onSelect: run(() =>
          deck
            ? applyMasterToSlides(choice.id.slice(5), false)
            : applyTheme(choice.id),
        ),
      },
      {
        label: "Apply to Selected Slides",
        disabled: host.masterView(),
        onSelect: run(() =>
          deck
            ? applyMasterToSlides(choice.id.slice(5), true)
            : applyTheme(choice.id, { selected: true }),
        ),
      },
    ];
  }
  const themeSections = (choices) =>
    [
      {
        label: "This Presentation",
        items: choices.filter((c) => c.section === "deck"),
      },
      {
        label: "Built-in",
        items: choices.filter((c) => c.section === "builtin"),
      },
    ].filter((s) => s.items.length);
  function themeGalleryFooter() {
    return [
      {
        label: "Browse for Themes…",
        icon: "o:folderOpen",
        onSelect: browseThemes,
      },
      {
        label: "Save Current Theme…",
        icon: "o:save",
        onSelect: run(saveTheme),
      },
    ];
  }

  function browseThemes() {
    host.pickFile(".thmx,.pptx,.potx,.ppsx", async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await host.mutate(() => {
        E.applyThemeFile(pres(), bytes);
      });
    });
  }

  async function saveTheme() {
    const master = currentMaster();
    if (!master) return;
    const name =
      (info()?.name || host.docName() || "Theme")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim() || "Theme";
    const bytes = P.exportThemeFile(pres(), master, {
      thumbnail: await thumbnailPng().catch(() => null),
    });
    await host.download(
      new Blob([bytes], { type: "application/vnd.ms-officetheme" }),
      `${name}.thmx`,
      "Theme saved.",
    );
  }
  // A small PNG of the theme's Title Slide layout, for file browsers.
  async function thumbnailPng() {
    const master = P.getSlideMasters(pres()).find(
      (m) => m.partName === currentMaster(),
    );
    const layout =
      master?.layouts.find((l) => l.type === "title") || master?.layouts[0];
    if (!layout || typeof document === "undefined") return null;
    const img = new Image();
    img.src = deckPicture(layout.partName);
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = Math.round(
      256 / (img.naturalWidth / img.naturalHeight || 16 / 9),
    );
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  // ---- Variants -------------------------------------------------------------

  function variantChoices() {
    const i = info();
    if (!i?.theme) return [];
    return i.theme.variants.map((v, index) => ({
      id: index,
      label: v.name,
      render: () => themeTile(i.theme.id, index, aspect()),
    }));
  }
  const currentVariant = () => {
    const v = info()?.variant;
    return v >= 0 ? v : null;
  };
  function applyVariant(index) {
    return host.mutate(() => {
      const i = info();
      if (!i?.theme || i.variant === index) return host.skip;
      const masters = deckMasters().filter(
        (m) => E.masterInfo(pres(), m)?.theme?.id === i.theme.id,
      );
      if (!E.applyVariant(pres(), masters, index, slides())) return host.skip;
    });
  }

  // ---- Colors, fonts, effects -------------------------------------------------

  function schemeRow(name, colors) {
    return el(
      "span",
      { class: "scheme-row" },
      el(
        "span",
        { class: "scheme-swatches", "aria-hidden": "true" },
        ...[
          "dk1",
          "lt1",
          "dk2",
          "lt2",
          "accent1",
          "accent2",
          "accent3",
          "accent4",
          "accent5",
          "accent6",
        ].map((slot) => el("span", { style: `background:${colors[slot]}` })),
      ),
      el("span", { class: "scheme-name" }, name),
    );
  }
  function applyColors(colors, name, dark) {
    return host.mutate(() => {
      const changed = E.applyColors(
        pres(),
        deckMasters(),
        { ...colors, name },
        {
          dark,
          slides: slides(),
        },
      );
      if (!changed) return host.skip;
    });
  }
  function colorsMenu() {
    const i = info();
    const current = i?.colorName;
    const item = (scheme) => ({
      label: schemeRow(scheme.name, scheme.colors),
      checked: scheme.name === current,
      onSelect: run(() => applyColors(scheme.colors, scheme.name, scheme.dark)),
    });
    const custom = customColorSchemes();
    const builtin = COLOR_SCHEMES.filter(
      (s, n, all) => all.findIndex((o) => o.name === s.name) === n,
    );
    const own = i?.theme ? i.theme.variants.map((v) => v.name) : [];
    return [
      custom.length && { header: "Custom" },
      ...custom.map((s) => item({ ...s, dark: undefined })),
      own.length && { header: "This theme" },
      ...builtin.filter((s) => own.includes(s.name)).map(item),
      { header: "Built-in" },
      ...builtin
        .filter((s, n) => !own.includes(s.name) && n % 4 === 0)
        .map(item),
      {
        label: "More Color Schemes",
        items: builtin
          .filter((s, n) => !own.includes(s.name) && n % 4 !== 0)
          .map(item),
      },
      { separator: true },
      {
        label: "Customize Colors…",
        icon: "o:colors",
        onSelect: run(customizeColors),
      },
    ].filter(Boolean);
  }

  function fontRow(major, minor, name) {
    return el(
      "span",
      { class: "font-row" },
      el(
        "span",
        {
          class: "font-sample",
          style: `font-family:"${major}"`,
          "aria-hidden": "true",
        },
        "Aa",
      ),
      el(
        "span",
        { class: "font-names" },
        el("span", { class: "font-name" }, name),
        el(
          "span",
          { class: "font-pair" },
          el("span", { style: `font-family:"${major}"` }, major),
          " · ",
          el("span", { style: `font-family:"${minor}"` }, minor),
        ),
      ),
    );
  }
  function applyFonts(fonts) {
    return host.mutate(() => {
      if (!E.applyFonts(pres(), deckMasters(), fonts)) return host.skip;
    });
  }
  function fontsMenu() {
    const i = info();
    const item = (f) => ({
      label: fontRow(f.major, f.minor, f.name),
      checked: i?.fonts?.major === f.major && i?.fonts?.minor === f.minor,
      onSelect: run(() => applyFonts(f)),
    });
    const custom = customFontSchemes();
    return [
      custom.length && { header: "Custom" },
      ...custom.map(item),
      { header: "Built-in" },
      ...FONT_PAIRS.map(item),
      { separator: true },
      {
        label: "Customize Fonts…",
        icon: "o:fonts",
        onSelect: run(customizeFonts),
      },
    ].filter(Boolean);
  }

  function effectsMenu() {
    const current = info()?.effects;
    return EFFECT_SCHEMES.map((fx) => ({
      label: fx.name,
      checked: fx.id === current,
      onSelect: run(() =>
        host.mutate(() => {
          if (!E.applyEffects(pres(), deckMasters(), fx.id)) return host.skip;
        }),
      ),
    }));
  }

  // ---- Background styles --------------------------------------------------

  function backgroundStylesNode() {
    const i = info();
    const colors = resolvedColors(i);
    const styles = backgroundStyles(i?.theme?.backgroundStyles || "calm");
    const grid = el("div", {
      class: "bg-styles",
      role: "group",
      "aria-label": "Background styles",
    });
    for (const style of styles) {
      const b = el("button", {
        type: "button",
        class: "bg-style menu-item",
        role: "menuitem",
        tabindex: -1,
        "aria-label": style.name,
        title: `${style.name}. Right-click to apply to selected slides.`,
        style: `background:${colors.dk1 ? fillCss(style.fill, colors, i?.dark) : "#ddd"}`,
        onclick: run(() => applyBackgroundStyle(style, false)),
        oncontextmenu: (e) => {
          e.preventDefault();
          openMenu({
            anchor: b,
            x: e.clientX,
            y: e.clientY,
            contextual: true,
            label: `${style.name} options`,
            items: [
              {
                label: "Apply to All Slides",
                onSelect: run(() => applyBackgroundStyle(style, false)),
              },
              {
                label: "Apply to Selected Slides",
                onSelect: run(() => applyBackgroundStyle(style, true)),
              },
            ],
          });
        },
      });
      grid.append(b);
    }
    return grid;
  }
  function applyBackgroundStyle(style, selected) {
    return host.mutate(() => {
      if (selected) {
        for (const s of host.selectedSlides())
          E.setBackgroundFill(s, style.fill);
        return;
      }
      const masters = deckMasters();
      for (const m of masters)
        E.setBackgroundFill(P.getTemplateSlide(pres(), m), style.fill);
      // Every slide shows it: their own backgrounds give way.
      for (const s of slidesOn(masters))
        if (P.getSlideBackground(s).kind !== "inherit")
          P.clearSlideBackground(s);
    });
  }
  function backgroundStylesMenu() {
    return [
      { custom: backgroundStylesNode() },
      { separator: true },
      {
        label: "Format Background…",
        icon: "o:formatBackground",
        onSelect: () => host.formatBackground(),
      },
      {
        label: "Reset Slide Background",
        onSelect: run(() =>
          host.mutate(() => {
            const targets = host
              .selectedSlides()
              .filter((s) => P.getSlideBackground(s).kind !== "inherit");
            if (!targets.length) return host.skip;
            for (const s of targets) P.clearSlideBackground(s);
          }),
        ),
      },
    ];
  }

  // ---- Hide background graphics --------------------------------------------

  const hidesGraphics = (s) =>
    /\sshowMasterSp="(0|false)"/.test(P.getSlideXmlString(s).slice(0, 600));
  const backgroundGraphicsHidden = () => {
    const targets = host.selectedSlides();
    return targets.length > 0 && targets.every(hidesGraphics);
  };
  function setBackgroundGraphicsHidden(on) {
    return host.mutate(() => {
      const targets = host
        .selectedSlides()
        .filter((s) => hidesGraphics(s) !== on);
      if (!targets.length) return host.skip;
      for (const s of targets) P.setTemplateShowsMasterShapes(s, !on);
    });
  }

  // ---- Customize Colors -------------------------------------------------------

  async function customizeColors() {
    const i = info();
    const start = {
      ...(i?.colors?.dk1 ? i.colors : themeById("paper").variants[0].colors),
    };
    const colors = { ...start };
    let dark = !!i?.dark;
    const nameInput = el("input", {
      class: "input",
      value: "Custom 1",
      "aria-label": "Name",
      maxlength: 60,
    });
    const used = new Set(customColorSchemes().map((s) => s.name));
    for (let n = 1; used.has(nameInput.value); n++)
      nameInput.value = `Custom ${n + 1}`;
    const preview = el("div", {
      class: "scheme-preview",
      "aria-hidden": "true",
    });
    const drawPreview = () => {
      const make = (isDark) => {
        const p = paletteOf(colors, isDark);
        return el(
          "div",
          {
            class: "scheme-preview-slide",
            style: `background:${p.bg};color:${p.ink}`,
          },
          el("div", { class: "scheme-preview-title" }, "Text"),
          el(
            "div",
            { class: "scheme-preview-bars" },
            ...[1, 2, 3, 4, 5, 6].map((n) =>
              el("span", {
                style: `background:${colors[`accent${n}`]};height:${30 + n * 9}%`,
              }),
            ),
          ),
          el(
            "div",
            { class: "scheme-preview-links" },
            el("span", { style: `color:${colors.hlink}` }, "Hyperlink"),
            " ",
            el("span", { style: `color:${colors.folHlink}` }, "Followed"),
          ),
        );
      };
      preview.replaceChildren(make(false), make(true));
    };
    drawPreview();
    const inputs = SCHEME_SLOTS.map((slot) => {
      const input = el("input", {
        type: "color",
        value: colors[slot],
        "aria-label": SLOT_LABELS[slot],
        oninput: (e) => {
          colors[slot] = e.target.value.toLowerCase();
          drawPreview();
        },
      });
      return [slot, input];
    });
    const darkBox = el("input", {
      type: "checkbox",
      checked: dark || null,
      onchange: (e) => (dark = e.target.checked),
    });
    const body = el(
      "form",
      {
        class: "dialog-body customize-colors",
        onsubmit: (e) => e.preventDefault(),
      },
      el(
        "div",
        { class: "customize-columns" },
        el(
          "fieldset",
          { class: "scheme-slots" },
          el("legend", {}, "Theme colors"),
          ...inputs.map(([slot, input]) =>
            el(
              "label",
              { class: "scheme-slot" },
              input,
              el("span", {}, SLOT_LABELS[slot]),
            ),
          ),
        ),
        el(
          "div",
          { class: "scheme-preview-wrap" },
          el("span", { class: "helper" }, "Preview"),
          preview,
        ),
      ),
      el(
        "label",
        { class: "bg-check" },
        darkBox,
        "Dark background (text in the light colors)",
      ),
      el("label", { class: "field" }, el("span", {}, "Name"), nameInput),
      button(
        "Reset",
        null,
        () => {
          Object.assign(colors, start);
          for (const [slot, input] of inputs) input.value = colors[slot];
          drawPreview();
        },
        "text-button",
      ),
    );
    const ok = await dialog({
      title: "Customize Colors",
      body,
      confirm: "Save",
    });
    if (!ok) return;
    const name = nameInput.value.trim() || "Custom";
    const list = customColorSchemes().filter((s) => s.name !== name);
    list.unshift({ name, colors: { ...colors } });
    if (!writeList(CUSTOM_COLORS_KEY, list.slice(0, 30)))
      toast(
        "The color scheme is applied, but this browser could not keep it for later.",
      );
    await applyColors(colors, name, dark);
  }

  // ---- Customize Fonts --------------------------------------------------------

  async function customizeFonts() {
    const i = info();
    const families = [
      ...new Set([
        ...host.fontList(),
        "Raleway",
        "Playfair Display",
        ...FONT_PAIRS.flatMap((f) => [f.major, f.minor]),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    const pick = (label, value) => {
      const node = el(
        "select",
        { class: "input", "aria-label": label },
        ...families.map((f) =>
          el("option", { value: f, style: `font-family:"${f}"` }, f),
        ),
      );
      node.value = families.includes(value) ? value : families[0];
      return node;
    };
    const major = pick("Heading font", i?.fonts?.major || "Arial");
    const minor = pick("Body font", i?.fonts?.minor || "Arial");
    const sample = el("div", { class: "font-preview", "aria-hidden": "true" });
    const draw = () =>
      sample.replaceChildren(
        el(
          "div",
          {
            class: "font-preview-heading",
            style: `font-family:"${major.value}"`,
          },
          "Heading",
        ),
        el(
          "div",
          { class: "font-preview-body", style: `font-family:"${minor.value}"` },
          "Body text is set in this font. It should read well at any size.",
        ),
      );
    major.onchange = draw;
    minor.onchange = draw;
    draw();
    const nameInput = el("input", {
      class: "input",
      value: "Custom 1",
      "aria-label": "Name",
      maxlength: 60,
    });
    const used = new Set(customFontSchemes().map((s) => s.name));
    for (let n = 1; used.has(nameInput.value); n++)
      nameInput.value = `Custom ${n + 1}`;
    const body = el(
      "form",
      {
        class: "dialog-body customize-fonts",
        onsubmit: (e) => e.preventDefault(),
      },
      el("label", { class: "field" }, el("span", {}, "Heading font"), major),
      el("label", { class: "field" }, el("span", {}, "Body font"), minor),
      el("span", { class: "helper" }, "Preview"),
      sample,
      el("label", { class: "field" }, el("span", {}, "Name"), nameInput),
    );
    const ok = await dialog({
      title: "Customize Fonts",
      body,
      confirm: "Save",
    });
    if (!ok) return;
    const scheme = {
      name: nameInput.value.trim() || "Custom",
      major: major.value,
      minor: minor.value,
    };
    const list = customFontSchemes().filter((s) => s.name !== scheme.name);
    list.unshift(scheme);
    if (!writeList(CUSTOM_FONTS_KEY, list.slice(0, 30)))
      toast(
        "The fonts are applied, but this browser could not keep them for later.",
      );
    await applyFonts(scheme);
  }

  // The Slide Master tab's Edit Theme and Background groups: the same
  // commands, offered while the masters themselves are being edited.
  function masterThemeGroups() {
    const themesMenu = () => [
      { header: "Built-in" },
      ...CATALOG.map((t) => ({
        label: el(
          "span",
          { class: "theme-menu-row" },
          el("img", {
            src: themePicture(t.id, 0, { aspect: aspect() }),
            alt: "",
            draggable: "false",
          }),
          el("span", {}, t.name),
        ),
        checked: info()?.theme?.id === t.id,
        onSelect: run(() => applyTheme(t.id)),
      })),
      { separator: true },
      {
        label: "Browse for Themes…",
        icon: "o:folderOpen",
        onSelect: browseThemes,
      },
      {
        label: "Save Current Theme…",
        icon: "o:save",
        onSelect: run(saveTheme),
      },
    ];
    return [
      {
        id: "master-edit-theme",
        label: "Edit Theme",
        icon: "themes",
        items: [
          {
            type: "large",
            id: "master-themes",
            label: "Themes",
            icon: "themes",
            title: "Themes",
            description: "Give the masters another theme.",
            menu: themesMenu,
            menuLabel: "Themes",
          },
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "master-theme-colors",
                label: "Colors",
                showLabel: true,
                icon: "colors",
                title: "Colors",
                menu: colorsMenu,
                menuLabel: "Theme colors",
              },
              {
                type: "small",
                id: "master-theme-fonts",
                label: "Fonts",
                showLabel: true,
                icon: "fonts",
                title: "Fonts",
                menu: fontsMenu,
                menuLabel: "Theme fonts",
              },
              {
                type: "small",
                id: "master-theme-effects",
                label: "Effects",
                showLabel: true,
                icon: "effects",
                title: "Effects",
                menu: effectsMenu,
                menuLabel: "Theme effects",
              },
            ],
          },
          {
            type: "large",
            id: "master-background-styles",
            label: "Background\nStyles",
            icon: "backgroundStyles",
            title: "Background Styles",
            menu: backgroundStylesMenu,
            menuLabel: "Background styles",
          },
        ],
      },
    ];
  }

  return {
    masterThemeGroups,
    applyTheme,
    applyPalette,
    themeChoices,
    themeSections,
    currentTheme,
    chooseTheme,
    themeContextMenu,
    themeGalleryFooter,
    variantChoices,
    currentVariant,
    applyVariant,
    colorsMenu,
    fontsMenu,
    effectsMenu,
    backgroundStylesMenu,
    backgroundGraphicsHidden,
    setBackgroundGraphicsHidden,
    browseThemes,
    saveTheme,
    customizeColors,
    customizeFonts,
    info,
  };
}

/** Start-screen pictures: a theme's Title Slide with its name. */
export const themeStartPicture = (key) =>
  themeById(key) && !LEGACY_IDS.has(key)
    ? themePicture(key, 0, {
        title: themeById(key).name,
        subtitle: "Presentation subtitle",
      })
    : null;

export { readThemeXml };
