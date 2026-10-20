import {
  adjustDimsForRotation,
  cleanText,
  componentsToColor,
  drawOptionList,
  layoutMultilineText,
  lineSplit,
  PDFName,
  PDFNumber,
  reduceRotation,
  rgb,
  rotateInPlace,
  setFillingColor,
  setFontAndSize,
  TextAlignment,
} from 'pdf-lib';
import { readAppearanceDefaults as defaults } from './form-style.js';

/**
 * Retain option identity through sorting and wrapping; equal labels need not be equal values,
 * and equal values need not be the same option. `selected` holds positions in `options`.
 */
export function listAppearance(source, widget, font, options, selected) {
  const rows = options.slice();
  if (source.isSorted()) rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const fieldStyle = defaults(source.acroField),
    widgetStyle = defaults(widget);
  const textColor = widgetStyle.color ?? fieldStyle.color ?? rgb(0, 0, 0);
  const appearance = widget.getAppearanceCharacteristics();
  const rectangle = widget.getRectangle();
  const rotation = reduceRotation(appearance?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const borderWidth = widget.getBorderStyle()?.getWidth() ?? 0;
  const padding = 1;
  const layout = layoutMultilineText(rows.map((row) => row.label).join('\n'), {
    font,
    fontSize: widgetStyle.fontSize ?? fieldStyle.fontSize,
    alignment: TextAlignment.Left,
    bounds: {
      x: borderWidth + padding,
      y: borderWidth + padding,
      width: width - 2 * (borderWidth + padding),
      height: height - 2 * (borderWidth + padding),
    },
  });
  const selectedRows = new Set([...selected].map((index) => options[index])),
    selectedLines = [],
    rowStarts = [];
  let index = 0;
  for (const row of rows) {
    rowStarts.push(index);
    for (let remainder of lineSplit(cleanText(row.label))) {
      // The layout preserves each hard line and trims only the remainder of a soft wrap.
      // Consume its returned text to map lines without laying out or encoding them again.
      while (index < layout.lines.length) {
        const line = layout.lines[index];
        if (selectedRows.has(row)) selectedLines.push(index);
        index++;
        if (line.text.length >= remainder.length) break;
        remainder = remainder.slice(line.text.length).trim();
      }
    }
  }
  const storedTop = source.acroField.dict.lookup(PDFName.of('TI'))?.asNumber?.();
  const hasTop = Number.isInteger(storedTop) && storedTop >= 0 && storedTop < options.length;
  let topRow = hasTop ? rows.indexOf(options[storedTop]) : 0;
  // Explicit scroll positions survive appearance regeneration. A new selection clears
  // that position; show it when it would otherwise fall below the visible rows.
  const visibleLines = Math.max(
    1,
    Math.floor((height - 2 * (borderWidth + padding)) / layout.lineHeight),
  );
  if (!hasTop && selectedLines[0] >= visibleLines)
    topRow = rowStarts.findLastIndex((start) => start <= selectedLines[0]);
  const topLine = rowStarts[topRow] || 0;
  if (topLine) {
    for (const line of layout.lines) line.y += topLine * layout.lineHeight;
    if (!hasTop)
      source.acroField.dict.set(PDFName.of('TI'), PDFNumber.of(options.indexOf(rows[topRow])));
  }
  const owner = widgetStyle.color || widgetStyle.fontSize !== undefined ? widget : source.acroField;
  owner.setDefaultAppearance(
    [
      setFillingColor(textColor).toString(),
      // An automatic size (0) stays automatic, so the list fits each later selection anew.
      setFontAndSize(
        font.name,
        (widgetStyle.fontSize ?? fieldStyle.fontSize) ? layout.fontSize : 0,
      ).toString(),
    ].join('\n'),
  );
  return [
    ...rotateInPlace({ ...rectangle, rotation }),
    ...drawOptionList({
      x: borderWidth / 2,
      y: borderWidth / 2,
      width: width - borderWidth,
      height: height - borderWidth,
      borderWidth,
      borderColor: componentsToColor(appearance?.getBorderColor()),
      color: componentsToColor(appearance?.getBackgroundColor()),
      textColor,
      font: font.name,
      fontSize: layout.fontSize,
      textLines: layout.lines,
      lineHeight: layout.lineHeight,
      selectedColor: rgb(153 / 255, 193 / 255, 218 / 255),
      selectedLines,
      padding,
    }),
  ];
}
