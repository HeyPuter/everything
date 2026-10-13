// What Effect Options offers for an effect: direction, shape, amount,
// color, path direction and, for text, the sequence it builds in.

export const COLORS = [
  ["E81224", "Red"],
  ["F7630C", "Orange"],
  ["FFB900", "Gold"],
  ["16C60C", "Green"],
  ["0078D4", "Blue"],
  ["886CE4", "Purple"],
  ["808080", "Gray"],
  ["000000", "Black"],
];

/** Reverses a motion path ("M 0 0 L … E"): the object travels it from its
 *  end to its start. */
export function reversePath(d) {
  const tokens = String(d || "").match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/gi) || [];
  const segs = [];
  let i = 0,
    cmd = null,
    cur = [0, 0],
    start = [0, 0];
  const n = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === "E") break;
    if (cmd === "M") {
      cur = start = [n(), n()];
      cmd = "L";
      segs.push({ k: "M", to: cur });
    } else if (cmd === "L") {
      const to = [n(), n()];
      segs.push({ k: "L", from: cur, to });
      cur = to;
    } else if (cmd === "C") {
      const c1 = [n(), n()],
        c2 = [n(), n()],
        to = [n(), n()];
      segs.push({ k: "C", from: cur, c1, c2, to });
      cur = to;
    } else if (cmd === "Z") {
      segs.push({ k: "L", from: cur, to: start });
      cur = start;
      cmd = null;
    } else i++;
  }
  const draw = segs.filter((s) => s.k !== "M");
  if (!draw.length) return d;
  const f = (p) => `${+p[0].toFixed(5)} ${+p[1].toFixed(5)}`;
  let out = `M ${f(draw[draw.length - 1].to)}`;
  for (const s of [...draw].reverse())
    out +=
      s.k === "L" ? ` L ${f(s.from)}` : ` C ${f(s.c2)} ${f(s.c1)} ${f(s.from)}`;
  return `${out} E`;
}

/** Moves a path's end point (and the control point leading into it). */
export function movePathEnd(d, dx, dy) {
  const parts = String(d || "")
    .replace(/\s*E\s*$/i, "")
    .match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/gi);
  if (!parts) return d;
  const numbers = [];
  parts.forEach((p, i) => /[\d]/.test(p) && numbers.push(i));
  if (numbers.length < 2) return d;
  const shift = (i, by) => {
    parts[i] = String(+(Number(parts[i]) + by).toFixed(5));
  };
  const [xi, yi] = numbers.slice(-2);
  shift(xi, dx);
  shift(yi, dy);
  // A curve's second control point moves with its end, keeping its shape.
  const lastCommand = parts.findLastIndex((p) => /[A-Za-z]/.test(p));
  if (/c/i.test(parts[lastCommand]) && numbers.length >= 4) {
    const [cx, cy] = numbers.slice(-4, -2);
    shift(cx, dx);
    shift(cy, dy);
  }
  return `${parts.join(" ")} E`;
}

const groupLabel = (entry) => {
  if (entry.cls === "path" && entry.id === 35) return "Shape";
  if (entry.id === 21 && entry.cls !== "emph") return "Spokes";
  if (entry.id === 53 && entry.cls !== "emph") return "Vanishing Point";
  return "Direction";
};

export function optionGroups(
  entry,
  effect,
  { hasText = false, paragraphs = 0 },
) {
  const groups = [];
  if (entry?.variants) {
    groups.push({
      label: entry.directions ? "Shape" : "Direction",
      options: entry.variants.map(([presetId, subtype, label]) => ({
        label,
        active: effect.presetId === presetId,
        apply: () => ({
          presetId,
          presetSubtype: entry.directions ? effect.presetSubtype : subtype,
        }),
      })),
    });
  }
  if (entry?.directions)
    groups.push({
      label: "Direction",
      options: entry.directions.map(([subtype, label]) => ({
        label,
        active: effect.presetSubtype === subtype,
        apply: () => ({ presetSubtype: subtype }),
      })),
    });
  if (entry?.options) {
    const options = entry.options.map(([subtype, label]) => ({
      label,
      active: effect.presetSubtype === subtype,
      apply: () =>
        entry.cls === "path"
          ? { presetSubtype: subtype, path: undefined }
          : { presetSubtype: subtype },
    }));
    groups.push({ label: groupLabel(entry), options });
  }
  if (entry?.spin) {
    const amount = effect.amount ?? 360;
    groups.push({
      label: "Direction",
      options: [
        ["Clockwise", 1],
        ["Counterclockwise", -1],
      ].map(([label, sign]) => ({
        label,
        active: Math.sign(amount || 1) === sign,
        apply: (e) => ({ amount: Math.abs(e.amount ?? 360) * sign }),
      })),
    });
  }
  if (entry?.amounts)
    groups.push({
      label: "Amount",
      options: entry.amounts.map(([value, label]) => ({
        label,
        active: Math.abs(effect.amount ?? entry.amount) === value,
        apply: (e) => ({
          amount: entry.spin ? value * Math.sign(e.amount || 1) : value,
        }),
      })),
    });
  if (entry?.color)
    groups.push({
      label: "Color",
      options: COLORS.map(([value, label]) => ({
        label,
        swatch: value,
        active: (effect.color || "").toUpperCase() === value,
        apply: () => ({ color: value }),
      })),
    });
  if (effect.presetClass === "path")
    groups.push({
      label: "Path",
      options: [
        {
          label: "Reverse Path Direction",
          active: false,
          apply: (e) => ({
            path: reversePath(e.path),
          }),
          reverse: true,
        },
      ],
    });
  if (hasText && paragraphs > 1 && !entry?.text)
    groups.push({
      label: "Sequence",
      options: [
        {
          label: "As One Object",
          active: !effect.text,
          apply: () => ({ text: undefined }),
        },
        {
          label: "All at Once",
          active: effect.text?.by === "allAtOnce",
          apply: (e) => ({
            text: { ...(e.text || { level: 1 }), by: "allAtOnce" },
          }),
        },
        {
          label: "By Paragraph",
          active: effect.text?.by === "paragraph",
          apply: (e) => ({
            text: { ...(e.text || { level: 1 }), by: "paragraph" },
          }),
        },
      ],
    });
  return groups;
}
