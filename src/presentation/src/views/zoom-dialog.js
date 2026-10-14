// The Zoom dialog: a preset level, Fit, or a percentage typed in, for the
// view in front (the slide, the sorter's thumbnails, or the notes pages).
import { el, dialog } from "../ui.js";

export const ZOOM_PRESETS = [4, 3, 2, 1, 0.66, 0.5, 0.33];

export function parsePercent(value, { min = 10, max = 400 } = {}) {
  const n = Number(String(value).replace(/%\s*$/, "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(min, Math.min(max, Math.round(n))) / 100;
}

export async function zoomDialog({ current, fit, set, min = 10, max = 400 }) {
  const name = "zoom-choice";
  const percent = el("input", {
    type: "number",
    class: "input",
    min: String(min),
    max: String(max),
    step: "1",
    value: String(Math.round(current * 100)),
    "aria-label": "Percent",
  });
  const radio = (value, label, checked) =>
    el(
      "label",
      { class: "check-field" },
      el("input", {
        type: "radio",
        name,
        value,
        checked: checked ? true : null,
      }),
      el("span", {}, label),
    );
  const matches = (level) => !fit && Math.abs(level - current) < 0.005;
  const presets = el(
    "fieldset",
    { class: "zoom-presets" },
    el("legend", {}, "Zoom to"),
    radio("fit", "Fit", fit),
    ...ZOOM_PRESETS.map((level) =>
      radio(String(level), `${Math.round(level * 100)}%`, matches(level)),
    ),
  );
  const body = el(
    "form",
    { class: "dialog-body zoom-dialog" },
    presets,
    el("label", { class: "zoom-percent" }, "Percent", percent, "%"),
  );
  // Choosing a preset shows its percentage; typing one clears the preset.
  presets.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value && value !== "fit")
      percent.value = String(Math.round(Number(value) * 100));
  });
  percent.addEventListener("input", () => {
    for (const input of presets.querySelectorAll("input"))
      input.checked = false;
  });
  const ok = await dialog({ title: "Zoom", body, confirm: "OK" });
  if (!ok) return false;
  const chosen = presets.querySelector("input:checked")?.value;
  if (chosen === "fit") set("fit");
  else if (chosen) set(Number(chosen));
  else {
    const level = parsePercent(percent.value, { min, max });
    if (level == null) return false;
    set(level);
  }
  return true;
}
