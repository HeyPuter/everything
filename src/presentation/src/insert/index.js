// The Insert features beyond the basics: icons, video and audio, screenshots,
// photo albums, equations, header and footer, zooms, action buttons and
// settings, and embedded objects. The editor hands in what they need (its
// state and edit functions) and gets back ribbon commands, extra tabs and a
// few hooks: drawing over the canvas, opening an object on double-click, and
// what the slide show does with them.
import "./insert.css";
import "./insert-icons.js";
import { closeMenu } from "../ui.js";
import { colorMenuItems } from "../color-palette.js";
import {
  P,
  preview,
  pruneUnusedMedia,
  dedupeSlideMedia,
  slideBounds,
  slideTitle,
  visibleSlideShapes,
  text as textBox,
} from "../model.js";
import { createIconFeatures } from "./icons.js";
import { createMediaFeatures } from "./media.js";
import { createScreenshotFeatures } from "./screenshot.js";
import { createPhotoAlbum } from "./photo-album.js";
import { createEquationFeatures } from "./equation.js";
import { createHeaderFooter } from "./header-footer.js";
import { createZoomFeatures } from "./zoom.js";
import { createActionFeatures } from "./actions.js";
import { createObjectFeatures } from "./object.js";
import { createShowExtras } from "./show.js";

const hex = (value, fallback) => {
  const v = String(value || "").replace("#", "");
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : fallback;
};

export function createInsertFeatures(host) {
  const ctx = {
    P,
    pres: () => host.doc().pres,
    slide: host.slide,
    currentShape: host.currentShape,
    selectedShapes: host.selectedShapes,
    selectedIds: host.selectedIds,
    selectIds: host.selectIds,
    commitText: host.commitText,
    fail: host.fail,
    mutate: host.mutate,
    mutateSlide: host.mutateSlide,
    mutateShape: host.mutateShape,
    currentSize: host.currentSize,
    ribbonSelect: (id) => setTimeout(() => host.ribbon()?.select?.(id), 0),
    themeColors: () => {
      try {
        return P.getPresentationTheme(host.doc().pres);
      } catch {
        return null;
      }
    },
    inkColor: () =>
      hex(host.theme()?.ink, hex(ctx.themeColors()?.dark1, "#1F2937")),
    accentColor: () =>
      hex(host.theme()?.accent, hex(ctx.themeColors()?.accent1, "#2563EB")),
    pruneMedia: (slide) => pruneUnusedMedia(host.doc().pres, slide),
    dedupe: (slide) => dedupeSlideMedia(host.doc().pres, slide),
    readImage: host.readImage,
    insertImageFile: host.insertImageFile,
    altText: host.altText,
    goToSlide: host.goToSlide,
    previewSrc: (slide) => host.previewSrc(slide),
    previewOf: (pres, slide) => preview(pres, slide),
    slideTitle: (slide) => slideTitle(slide, host.doc().pres),
    titleText: (slide, value, size) =>
      textBox(
        slide,
        value,
        0.6,
        0.4,
        size.cx / 914400 - 1.2,
        1,
        36,
        ctx.inkColor(),
        true,
      ),
    language: () => host.language?.() || "en-US",
    selectedSlideParts: () => [...host.selectedSlideParts()],
    normalizeUrl: host.normalizeUrl,
    closeMenu,
    startDrawing: host.startDrawing,
    visibleShapes: (slide) => visibleSlideShapes(slide),
    slideBounds: (obj) => slideBounds(host.doc().pres, obj),
    refreshCanvas: host.refreshCanvas,
    colorItems: (onHex) =>
      colorMenuItems({
        theme: ctx.themeColors(),
        onPick: (value, picked) => onHex(picked || value),
      }),
  };

  const icons = createIconFeatures(ctx);
  const media = createMediaFeatures(ctx);
  const screenshot = createScreenshotFeatures(ctx);
  const album = createPhotoAlbum(ctx);
  const equation = createEquationFeatures(ctx);
  const headerFooter = createHeaderFooter(ctx);
  const zoom = createZoomFeatures(ctx);
  const actions = createActionFeatures(ctx);
  const object = createObjectFeatures(ctx);
  const run = (fn) => () => fn().catch(host.fail);

  /** Commands for the ribbon (merged into its api). */
  const api = () => ({
    insertIcons: run(icons.insertIcons),
    insertVideo: run(media.insertVideo),
    insertAudio: run(media.insertAudio),
    videoMenu: media.videoMenu,
    audioMenu: media.audioMenu,
    screenshot: run(() => screenshot.screenshot()),
    screenshotMenu: screenshot.menu,
    photoAlbum: run(album.photoAlbum),
    insertEquation: run(() => equation.insertEquation()),
    equationMenu: equation.menu,
    headerFooter: run(headerFooter.headerFooter),
    insertZoomMenu: zoom.menu,
    insertObject: run(object.insertObject),
    actionSettings: run(() => actions.actionSettings()),
    actionButtonsMenu: actions.menuItems,
  });

  const tabs = () => [
    icons.tab(),
    media.playbackTab(),
    equation.tab(),
    zoom.tab(),
  ];

  /** Opens an object on double-click; true when it was one of ours. */
  function open(obj) {
    if (equation.isEquation(obj)) {
      equation.editEquation(obj).catch(host.fail);
      return true;
    }
    if (object.isObject(obj)) {
      object.objectInfo(obj).catch(host.fail);
      return true;
    }
    if (media.isMedia(obj)) {
      media.toggle(obj);
      return true;
    }
    return false;
  }

  /** Items for the menu bar's Insert menu. */
  const menuItems = () => [
    { label: "Icons…", icon: "o:icons", onSelect: run(icons.insertIcons) },
    { label: "Screenshot", icon: "o:screenshot", items: screenshot.menu() },
    {
      label: "Photo Album…",
      icon: "o:photoAlbum",
      onSelect: run(album.photoAlbum),
    },
    { separator: true },
    { label: "Video", icon: "o:video", items: media.videoMenu() },
    { label: "Audio", icon: "o:audio", items: media.audioMenu() },
    { separator: true },
    {
      label: "Equation…",
      icon: "o:equation",
      onSelect: run(() => equation.insertEquation()),
    },
    {
      label: "Header and Footer…",
      icon: "o:headerFooter",
      onSelect: run(headerFooter.headerFooter),
    },
    { separator: true },
    { label: "Zoom", icon: "o:zoomSlide", items: zoom.menu() },
    {
      label: "Action Buttons",
      icon: "o:actionButtons",
      items: actions.menuItems(),
    },
    {
      label: "Action Settings…",
      icon: "o:action",
      disabled: !host.currentShape(),
      onSelect: run(() => actions.actionSettings()),
    },
    { label: "Object…", icon: "o:object", onSelect: run(object.insertObject) },
  ];

  /** Object menu items for inserted objects, ending with a separator. */
  function contextItems(obj) {
    const items = [];
    if (equation.isEquation(obj))
      items.push({
        label: "Edit Equation",
        icon: "o:equation",
        onSelect: run(() => equation.editEquation(obj)),
      });
    if (media.isMedia(obj))
      items.push(
        {
          label: "Play / Pause",
          icon: "o:mediaPlay",
          onSelect: () => media.toggle(obj),
        },
        { label: "Trim…", icon: "o:trim", onSelect: run(media.trimDialog) },
      );
    if (object.isObject(obj))
      items.push({
        label: "Open Object",
        icon: "o:object",
        onSelect: () => object.openObject(obj),
      });
    if (obj && !media.isMedia(obj))
      items.push({
        label: "Action Settings…",
        icon: "o:action",
        onSelect: run(() => actions.actionSettings(obj)),
      });
    return items.length ? [...items, { separator: true }] : [];
  }

  return {
    contextItems,
    api,
    tabs,
    open,
    menuItems,
    decorateCanvas: (canvas) => media.decorate(canvas),
    afterDraw: (obj, tool, at) => actions.afterDraw(obj, tool, at),
    shapesGallery: () => actions.actionButtonsGallery(),
    slideShow: (show) => createShowExtras(ctx, show),
    leaveSlide: () => media.stopAll(),
    actionSettings: (obj) => actions.actionSettings(obj),
  };
}
