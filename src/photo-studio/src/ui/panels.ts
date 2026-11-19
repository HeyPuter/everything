import { isVectorGradient } from "../model/vector-gradient";
import { solidRgb } from "../model/vector-stroke";
import { strokeDashPixels } from "../model/vector-stroke";
import { hasMask, drawMask } from "../model/masks";
import {
  allLayers,
  blends,
  type Layer,
  type PhotoDocument,
} from "../model/document";
import { Assets, escapeXML } from "../model/assets";
import { icon, button } from "./shell";
import { cachedSourceThumbnail } from "./thumbnails";
import { vectorColorHex } from "../color/vector";
import { supportedStrokePaths } from "../model/vector-stroke";
import { applyPixelMask, rawPixelMaskCoverage } from '../model/pixel-mask';
import { worldPoint } from '../model/transform';
export const number = (
  key: string,
  label: string,
  value: number,
  min?: number,
  max?: number,
) =>
  `<label class="number-field"><span>${label}</span><input data-property="${key}" type="number" aria-label="${label}" value="${key.startsWith("stroke") || key.startsWith('mask') || key.startsWith('pattern') || key.startsWith('gradient') ? value : Math.round(value * 100) / 100}" ${key.startsWith("stroke") || key.startsWith('mask') || key.startsWith('pattern') || key.startsWith('gradient') ? 'step="any"' : ""} ${min !== undefined ? `min="${min}"` : ""} ${max !== undefined ? `max="${max}"` : ""}></label>`;
function sourceImage(l: Layer, assets: Assets, doc?: PhotoDocument) {
  const url = cachedSourceThumbnail(l, assets, doc);
  return `<img ${url ? `src="${escapeXML(url)}"` : `data-source-thumbnail="${escapeXML(l.id)}"`} alt="" loading="lazy" draggable="false">`;
}
export function gradientProperties(l: Layer, doc: PhotoDocument) {
  const fill = l.vector!.fill;
  if (!isVectorGradient(fill)) return "";
  return `<h3>Gradient fill</h3><label class="number-field"><span>Style</span><select data-property="gradientStyle" aria-label="Gradient style">${["linear", "radial", "angle", "reflected", "diamond"].map((style) => `<option value="${style}" ${(fill.style ?? "linear") === style ? "selected" : ""}>${style[0].toUpperCase() + style.slice(1)}</option>`).join("")}</select></label>
    ${number("gradientAngle", "Gradient angle (°)", fill.angle ?? 0)}${number("gradientScale", "Gradient scale (%)", fill.scalePercent ?? 100, 0)}${number("gradientSmoothness", "Gradient smoothness (%)", ((fill.interpolationSamples ?? 4096) / 4096) * 100, 0, 100)}
    ${number("gradientOffsetX", "Gradient offset X (%)", fill.offsetPercent?.x ?? 0)}${number("gradientOffsetY", "Gradient offset Y (%)", fill.offsetPercent?.y ?? 0)}
    <label class="lock-label"><input type="checkbox" data-property="gradientReverse" ${fill.reverse ? "checked" : ""}> Reverse gradient</label><label class="lock-label"><input type="checkbox" data-property="gradientAligned" ${fill.align === false ? "" : "checked"}> Align gradient with layer</label>
    <h3>Color stops</h3>${fill.colorStops.map((stop, i) => `<label class="color-row">Color stop ${i + 1}<input type="color" aria-label="Color stop ${i + 1}" data-property="gradientColor${i}Color" value="${vectorColorHex({ rgb: solidRgb({ type: "color", color: stop.color })!, space: "document" }, doc)}"></label>${number("gradientColor" + i + "Location", "Color stop " + (i + 1) + " position (%)", stop.location * 100, 0, 100)}${number("gradientColor" + i + "Midpoint", "Color stop " + (i + 1) + " midpoint (%)", (stop.midpoint ?? 0.5) * 100, 0, 100)}<button class="wide" data-action="gradient-remove-color-${i}" ${fill.colorStops.length <= 1 ? "disabled" : ""}>Remove color stop ${i + 1}</button>`).join("")}
    <button class="wide" data-action="gradient-add-color" ${fill.colorStops.length >= 256 ? "disabled" : ""}>Add color stop</button>
    <h3>Opacity stops</h3>${fill.opacityStops.map((stop, i) => `${number("gradientOpacity" + i + "OpacityPercent", "Opacity stop " + (i + 1) + " opacity (%)", stop.opacityPercent, 0, 100)}${number("gradientOpacity" + i + "Location", "Opacity stop " + (i + 1) + " position (%)", stop.location * 100, 0, 100)}${number("gradientOpacity" + i + "Midpoint", "Opacity stop " + (i + 1) + " midpoint (%)", (stop.midpoint ?? 0.5) * 100, 0, 100)}<button class="wide" data-action="gradient-remove-opacity-${i}">Remove opacity stop ${i + 1}</button>`).join("")}
    <button class="wide" data-action="gradient-add-opacity" ${fill.opacityStops.length >= 256 ? "disabled" : ""}>Add opacity stop</button>`;
}
export function strokeProperties(l: Layer, doc: PhotoDocument) {
  const s = l.vector!.stroke;
  const open = l.vector!.mask.paths.some((p) => p.open),
    available = supportedStrokePaths(l.vector!.mask, {
      enabled: true,
      alignment: s?.alignment ?? (open ? "center" : "inside"),
      lineDashSet: s?.lineDashSet,
    });
  if (!s && !available) return "";
  const select = (
    key: string,
    label: string,
    options: string[],
    value: string,
  ) =>
    `<label class="number-field"><span>${label}</span><select data-property="${key}" aria-label="${label}">${options.map((v) => `<option value="${v}" ${v === value ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label>`;
  return `<h3>Stroke</h3><label class="lock-label"><input type="checkbox" data-property="strokeEnabled" ${s?.enabled ? "checked" : ""} ${available ? "" : 'disabled title="Stroke unavailable for these path operations"'}> Show stroke</label>${
    s
      ? `<label class="lock-label"><input type="checkbox" data-property="fillEnabled" ${s.fillEnabled ? "checked" : ""}> Show fill</label><label class="color-row">Stroke color <input type="color" aria-label="Stroke color" data-property="strokeColor" value="${vectorColorHex(s.color, doc)}"></label>${number("strokeWidth", "Stroke width (" + s.lineWidth.units.toLowerCase() + ")", s.lineWidth.value, 0)}${number("strokeOpacity", "Stroke opacity (%)", s.opacity * 100, 0, 100)}${!l.vector!.mask.paths.some((p) => p.open) ? select("strokeAlignment", "Stroke alignment", ["inside", "center", "outside"], s.alignment) : ""}${select("strokeCap", "Stroke cap", ["butt", "round", "square"], s.cap)}${select("strokeJoin", "Stroke join", ["miter", "round", "bevel"], s.join)}${number("strokeMiter", "Miter limit", s.miterLimit, 1)}<label class="number-field"><span>Dash and gap lengths (pixels)</span><input type="text" aria-label="Dash and gap lengths (pixels)" data-property="strokeDashes" value="${strokeDashPixels(s).join(", ")}" placeholder="Solid"></label>${number("strokeDashOffset", "Dash offset (" + (s.lineDashOffset.units === "None" ? "pixels" : s.lineDashOffset.units.toLowerCase()) + ")", s.lineDashOffset.value)}`
      : ""
  }`;
}
export function layerOptions(l?: Layer, locked = l?.locked ?? false) {
  return `<label class="blend-control"><span class="sr-only">Blend mode</span><select id="blend" ${!l || locked ? "disabled" : ""}>${blends.map((b) => `<option value="${b}" ${l?.blend === b ? "selected" : ""}>${b[0].toUpperCase() + b.slice(1)}</option>`).join("")}</select></label><label class="opacity-control">Opacity <input id="opacity" type="number" min="0" max="100" value="${Math.round((l?.opacity ?? 1) * 100)}" ${!l || locked ? "disabled" : ""}>%</label>`;
}
export function layerList(
  layers: Layer[],
  selected: ReadonlySet<string>,
  assets?: Assets,
  collapsed: ReadonlySet<string> = new Set(),
  depth = 0,
  maskTarget = '',
  doc?: PhotoDocument,
): string {
  return [...layers]
    .reverse()
    .map(
      (l) =>
        `<div class="layer-row ${selected.has(l.id) ? "selected" : ""}" data-row="${escapeXML(l.id)}" draggable="true" role="listitem" style="--depth:${depth}"><button data-visibility="${escapeXML(l.id)}" title="${l.visible ? "Hide" : "Show"} layer" aria-label="${l.visible ? "Hide" : "Show"} ${escapeXML(l.name)}">${icon(l.visible ? "eye" : "eye-off")}</button>${l.kind === "group" ? `<button class="group-disclosure" data-collapse="${escapeXML(l.id)}" aria-label="${collapsed.has(l.id) ? "Expand" : "Collapse"} ${escapeXML(l.name)}" aria-expanded="${!collapsed.has(l.id)}">${icon("chevron-right")}</button>` : '<span class="disclosure-spacer"></span>'}<button class="layer-select" data-layer="${escapeXML(l.id)}" aria-pressed="${selected.has(l.id)}"><span class="layer-thumbnail ${l.kind}" ${l.kind === "solid" ? `style="background:${l.color}"` : ""}>${l.asset && assets ? sourceImage(l, assets, doc) : l.kind === "solid" ? "" : icon(l.kind === "group" ? "folder" : l.kind === "text" ? "type" : l.kind === "paint" ? "paintbrush" : l.kind === "vector" ? "pen-tool" : "image")}</span><span>${escapeXML(l.name)}<small>${l.kind === "group" ? `${allLayers(l.children).length} layers` : l.kind}${hasMask(l) ? " · masked" : ""}</small></span>${l.locked || l.transparencyProtected || Object.values(l.protection ?? {}).some(Boolean) ? `<span title="${l.locked ? "Layer locked" : "Layer partially locked"}" aria-label="${l.locked ? "Layer locked" : "Layer partially locked"}">${icon("lock-keyhole")}</span>` : ""}</button>${hasMask(l) ? `<button class="mask-thumbnail ${l.maskDisabled ? "disabled-mask" : ""}" data-mask="${escapeXML(l.id)}" aria-label="Edit mask for ${escapeXML(l.name)}" aria-pressed="${maskTarget === l.id}" title="Edit layer mask"><img src="${maskThumbnail(l, assets, doc)}" alt="" draggable="false"></button>` : ""}</div>${collapsed.has(l.id) ? "" : layerList(l.children, selected, assets, collapsed, depth + 1, maskTarget, doc)}`,
    )
    .join('');
}
export function emptyLayers() {
  return `<div class="empty-layers">${icon('layers-2')}<p>Your layers will appear here</p><button data-action="import">Add an image</button></div>`;
}
export function undoButtons(canUndo: boolean, canRedo: boolean) {
  return (
    button("undo", "Undo", "undo-2", canUndo ? "" : "disabled") +
    button("redo", "Redo", "redo-2", canRedo ? "" : "disabled")
  );
}

export function historyPanel(labels: string[], canRedo: boolean) {
  const rows = ["Opened document", ...labels];
  return `<div class="history-entries">${rows.map((label, i) => `<div class="history-row ${i === rows.length - 1 ? "current" : ""}">${icon(i ? "history" : "image")}<span>${escapeXML(label)}</span></div>`).join("")}</div><div class="history-controls">${undoButtons(labels.length > 0, canRedo)}</div><p class="history-note">Use Undo and Redo to step through your edits.</p>`;
}

const thumbnails = new WeakMap<Layer, string>();
function maskThumbnail(l: Layer, assets?: Assets, doc?: PhotoDocument) {
  const old = thumbnails.get(l);
  if (old) return old;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const c = canvas.getContext('2d')!;
  const w = l.kind === 'group' && doc ? doc.width : l.sourceWidth;
  const h = l.kind === 'group' && doc ? doc.height : l.sourceHeight;
  c.scale(32 / w, 32 / h);
  if (l.pixelMask) {
    const plain = { ...l, maskDisabled: false, maskInverted: false,
      ...(l.kind === 'group' ? { transform: { x: 0,y: 0,width: w,height: h,rotation: 0 } } : {}) };
    const render = (base: number) => {
      c.clearRect(0,0,w,h);
      drawMask(c,plain,w,h,undefined,base);
      return c.getImageData(0,0,32,32);
    };
    const black = render(0), white = render(1);
    const samples = l.pixelMask.asset && assets ? assets.coverage(l.pixelMask.asset) : undefined;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const at = (y*32+x)*4, point = worldPoint(plain.transform,(x+.5)/32,(y+.5)/32);
      const raw = rawPixelMaskCoverage(l,samples,...point);
      const basis = raw*(white.data[at+3]-black.data[at+3])/255+black.data[at+3]/255;
      const value = applyPixelMask({...l,maskDisabled:false},basis);
      black.data[at] = black.data[at+1] = black.data[at+2] = Math.round(value*255);
      black.data[at+3] = 255;
    }
    c.resetTransform(); c.putImageData(black,0,0);
    const url = canvas.toDataURL(); thumbnails.set(l,url); return url;
  }
  drawMask(
    c,
    l.kind === 'group' ? { ...l, transform: { x: 0, y: 0, width: w, height: h, rotation: 0 } } : l,
    w,
    h,
    l.maskAsset && assets ? assets.get(l.maskAsset) : undefined,
  );
  c.globalCompositeOperation = 'destination-over';
  c.fillStyle = '#000';
  c.fillRect(0, 0, w, h);
  const url = canvas.toDataURL();
  thumbnails.set(l, url);
  return url;
}
