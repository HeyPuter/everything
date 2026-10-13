import { textLinkRects } from "./text-links.js";
import { textLinkURL } from "./text-link-data.js";
import { rotationOf, centerOf, rotatePoint } from "./geometry.js";

// The web links an export keeps, so a shared or archived copy still opens
// them: whole link and embed cards, and linked words, each as a board area
// with its address. A turned object's areas turn with it.
export function exportLinks(items, ctx) {
  const links = [];
  for (const i of items) {
    const rotation = rotationOf(i),
      center = rotation ? centerOf(i) : null;
    const add = (box, url, text) =>
      links.push({
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        url,
        text: text || url,
        rotation,
        center,
      });
    if (i.type === "link" || i.type === "embed") {
      const url = textLinkURL(i.url);
      if (url)
        add(
          {
            x: Math.min(i.x, i.x + i.w),
            y: Math.min(i.y, i.y + i.h),
            w: Math.abs(i.w),
            h: Math.abs(i.h),
          },
          url,
          i.text,
        );
    } else if (i.textRuns?.some((r) => r.style?.link))
      for (const r of textLinkRects(i, ctx)) add(r, r.url, r.text);
  }
  return links;
}
// A link area's corners on the board, clockwise from its top left.
export function linkCorners(link) {
  const corners = [
    { x: link.x, y: link.y },
    { x: link.x + link.w, y: link.y },
    { x: link.x + link.w, y: link.y + link.h },
    { x: link.x, y: link.y + link.h },
  ];
  return link.rotation
    ? corners.map((p) => rotatePoint(p, link.center, link.rotation))
    : corners;
}
