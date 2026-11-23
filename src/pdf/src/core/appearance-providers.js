/*
 * Drawing/layout routines from pdf-lib 1.17.1, src/api/form/appearances.ts.
 * Kept equivalent to upstream; default appearance parsing uses our token reader.
 * appearance-provider-parity.test.js checks these routines against the installed version.
 *
 * MIT License
 *
 * Copyright (c) 2019 Andrew Dillon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */
import {
  drawCheckBox,
  rotateInPlace,
  drawRadioButton,
  drawButton,
  drawTextField,
  rgb,
  componentsToColor,
  setFillingColor,
  reduceRotation,
  adjustDimsForRotation,
  layoutMultilineText,
  layoutCombedText,
  layoutSinglelineText,
  TextAlignment,
  setFontAndSize,
} from 'pdf-lib';
import { readAppearanceDefaults } from './form-style.js';
const getDefaultColor = (field) => readAppearanceDefaults(field).color;
const getDefaultFontSize = (field) => readAppearanceDefaults(field).fontSize;
/** Text broken with no space before it: CJK ideographs, kana, Hangul and their punctuation. */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u;
/**
 * Lines of `paragraph` that fit `width` at `size`: broken after spaces, between CJK
 * characters, and inside a word only when the word alone is wider than the field.
 */
function wrapParagraph(paragraph, font, size, width) {
  const measure = (text) => font.widthOfTextAtSize(text, size);
  const units = paragraph.match(/\s+|\S/gu) ?? [];
  // Words: runs of characters that are not spaces and not CJK.
  const tokens = [];
  for (const unit of units) {
    const last = tokens.at(-1);
    if (last && !/\s/u.test(unit) && !CJK.test(unit) && !/\s/u.test(last) && !CJK.test(last))
      tokens[tokens.length - 1] += unit;
    else tokens.push(unit);
  }
  const lines = [];
  let line = '';
  const push = () => {
    lines.push(line.trimEnd());
    line = '';
  };
  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      if (line) line += token;
      continue;
    }
    if (measure((line + token).trimEnd()) <= width) {
      line += token;
      continue;
    }
    if (line.trim()) push();
    else line = '';
    if (measure(token) <= width) {
      line = token;
      continue;
    }
    // A word wider than the field is broken where it reaches the edge.
    for (const char of token) {
      if (line && measure(line + char) > width) push();
      line += char;
    }
  }
  if (line || !lines.length) lines.push(line.trimEnd());
  return lines;
}
/**
 * pdf-lib's multiline layout, unless a line of it would run past the field: pdf-lib breaks
 * lines at spaces only, so a long word or a CJK sentence put all the rest of its paragraph
 * on one line, cut off at the field's edge; and with an automatic size it grew the text
 * until that one line was taller than the field. Such text is wrapped where it reaches the
 * edge instead, at the largest size that shows it all (at least 4 pt).
 */
function layoutMultilineFitted(text, { alignment, fontSize, font, bounds }) {
  const upstream = layoutMultilineText(text, { alignment, fontSize, font, bounds });
  if (upstream.lines.every((line) => line.width <= bounds.width + 1e-6)) return upstream;
  // As pdf-lib cleans and splits the text.
  const paragraphs = text
    .replace(/\t|\u0085|\u2028|\u2029/g, '    ')
    .replace(/[\b\v]/g, '')
    .split(/\r\n|\r|\n|\f/);
  const lineHeight = (size) => font.heightAtSize(size) * 1.2;
  const wrap = (size) =>
    paragraphs.flatMap((paragraph) => wrapParagraph(paragraph, font, size, bounds.width));
  let size = fontSize;
  if (!size) {
    size = 4;
    while (size < 500 && wrap(size + 1).length * lineHeight(size + 1) <= Math.abs(bounds.height))
      size++;
  }
  const height = font.heightAtSize(size);
  let y = bounds.y + bounds.height;
  const lines = wrap(size).map((line) => {
    const width = font.widthOfTextAtSize(line, size);
    y -= height * 1.2;
    const x =
      alignment === TextAlignment.Center
        ? bounds.x + bounds.width / 2 - width / 2
        : alignment === TextAlignment.Right
          ? bounds.x + bounds.width - width
          : bounds.x;
    return { text: line, encoded: font.encodeText(line), width, height, x, y };
  });
  return { fontSize: size, lineHeight: height * 1.2, lines };
}
const updateDefaultAppearance = (field, color, font, fontSize = 0) => {
  const da = [
    setFillingColor(color).toString(),
    setFontAndSize(font?.name ?? 'dummy__noop', fontSize).toString(),
  ].join('\n');
  field.setDefaultAppearance(da);
};

export const defaultCheckBoxAppearanceProvider = (checkBox, widget) => {
  // The `/DA` entry can be at the widget or field level - so we handle both
  const widgetColor = getDefaultColor(widget);
  const fieldColor = getDefaultColor(checkBox.acroField);

  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();

  const borderWidth = bs?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);

  const rotate = rotateInPlace({ ...rectangle, rotation });

  const black = rgb(0, 0, 0);
  const borderColor = componentsToColor(ap?.getBorderColor()) ?? black;
  const normalBackgroundColor = componentsToColor(ap?.getBackgroundColor());
  const downBackgroundColor = componentsToColor(ap?.getBackgroundColor(), 0.8);

  // Update color
  const textColor = widgetColor ?? fieldColor ?? black;
  if (widgetColor) {
    updateDefaultAppearance(widget, textColor);
  } else {
    updateDefaultAppearance(checkBox.acroField, textColor);
  }

  const options = {
    x: 0 + borderWidth / 2,
    y: 0 + borderWidth / 2,
    width: width - borderWidth,
    height: height - borderWidth,
    thickness: 1.5,
    borderWidth,
    borderColor,
    markColor: textColor,
  };

  return {
    normal: {
      on: [
        ...rotate,
        ...drawCheckBox({
          ...options,
          color: normalBackgroundColor,
          filled: true,
        }),
      ],
      off: [
        ...rotate,
        ...drawCheckBox({
          ...options,
          color: normalBackgroundColor,
          filled: false,
        }),
      ],
    },
    down: {
      on: [
        ...rotate,
        ...drawCheckBox({
          ...options,
          color: downBackgroundColor,
          filled: true,
        }),
      ],
      off: [
        ...rotate,
        ...drawCheckBox({
          ...options,
          color: downBackgroundColor,
          filled: false,
        }),
      ],
    },
  };
};

export const defaultRadioGroupAppearanceProvider = (radioGroup, widget) => {
  // The `/DA` entry can be at the widget or field level - so we handle both
  const widgetColor = getDefaultColor(widget);
  const fieldColor = getDefaultColor(radioGroup.acroField);

  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();

  const borderWidth = bs?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);

  const rotate = rotateInPlace({ ...rectangle, rotation });

  const black = rgb(0, 0, 0);
  const borderColor = componentsToColor(ap?.getBorderColor()) ?? black;
  const normalBackgroundColor = componentsToColor(ap?.getBackgroundColor());
  const downBackgroundColor = componentsToColor(ap?.getBackgroundColor(), 0.8);

  // Update color
  const textColor = widgetColor ?? fieldColor ?? black;
  if (widgetColor) {
    updateDefaultAppearance(widget, textColor);
  } else {
    updateDefaultAppearance(radioGroup.acroField, textColor);
  }

  const options = {
    x: width / 2,
    y: height / 2,
    width: width - borderWidth,
    height: height - borderWidth,
    borderWidth,
    borderColor,
    dotColor: textColor,
  };

  return {
    normal: {
      on: [
        ...rotate,
        ...drawRadioButton({
          ...options,
          color: normalBackgroundColor,
          filled: true,
        }),
      ],
      off: [
        ...rotate,
        ...drawRadioButton({
          ...options,
          color: normalBackgroundColor,
          filled: false,
        }),
      ],
    },
    down: {
      on: [
        ...rotate,
        ...drawRadioButton({
          ...options,
          color: downBackgroundColor,
          filled: true,
        }),
      ],
      off: [
        ...rotate,
        ...drawRadioButton({
          ...options,
          color: downBackgroundColor,
          filled: false,
        }),
      ],
    },
  };
};

export const defaultButtonAppearanceProvider = (button, widget, font) => {
  // The `/DA` entry can be at the widget or field level - so we handle both
  const widgetColor = getDefaultColor(widget);
  const fieldColor = getDefaultColor(button.acroField);
  const widgetFontSize = getDefaultFontSize(widget);
  const fieldFontSize = getDefaultFontSize(button.acroField);

  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();
  const captions = ap?.getCaptions();
  const normalText = captions?.normal ?? '';
  const downText = captions?.down ?? normalText ?? '';

  const borderWidth = bs?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);

  const rotate = rotateInPlace({ ...rectangle, rotation });

  const black = rgb(0, 0, 0);

  const borderColor = componentsToColor(ap?.getBorderColor());
  const normalBackgroundColor = componentsToColor(ap?.getBackgroundColor());
  const downBackgroundColor = componentsToColor(ap?.getBackgroundColor(), 0.8);

  const bounds = {
    x: borderWidth,
    y: borderWidth,
    width: width - borderWidth * 2,
    height: height - borderWidth * 2,
  };
  const normalLayout = layoutSinglelineText(normalText, {
    alignment: TextAlignment.Center,
    fontSize: widgetFontSize ?? fieldFontSize,
    font,
    bounds,
  });
  const downLayout = layoutSinglelineText(downText, {
    alignment: TextAlignment.Center,
    fontSize: widgetFontSize ?? fieldFontSize,
    font,
    bounds,
  });

  // Update font size and color
  const fontSize = Math.min(normalLayout.fontSize, downLayout.fontSize);
  const textColor = widgetColor ?? fieldColor ?? black;
  // An automatic size (0) stays automatic: each widget, and each later value, fits anew.
  const storedSize = (widgetFontSize ?? fieldFontSize) ? fontSize : 0;
  if (widgetColor || widgetFontSize !== undefined) {
    updateDefaultAppearance(widget, textColor, font, storedSize);
  } else {
    updateDefaultAppearance(button.acroField, textColor, font, storedSize);
  }

  const options = {
    x: 0 + borderWidth / 2,
    y: 0 + borderWidth / 2,
    width: width - borderWidth,
    height: height - borderWidth,
    borderWidth,
    borderColor,
    textColor,
    font: font.name,
    fontSize,
  };

  return {
    normal: [
      ...rotate,
      ...drawButton({
        ...options,
        color: normalBackgroundColor,
        textLines: [normalLayout.line],
      }),
    ],
    down: [
      ...rotate,
      ...drawButton({
        ...options,
        color: downBackgroundColor,
        textLines: [downLayout.line],
      }),
    ],
  };
};

/** `textColor` draws the text in another color, leaving the field's own (its /DA) as it is. */
export const defaultTextFieldAppearanceProvider = (
  textField,
  widget,
  font,
  { textColor: shown } = {},
) => {
  // The `/DA` entry can be at the widget or field level - so we handle both
  const widgetColor = getDefaultColor(widget);
  const fieldColor = getDefaultColor(textField.acroField);
  const widgetFontSize = getDefaultFontSize(widget);
  const fieldFontSize = getDefaultFontSize(textField.acroField);

  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();
  const text = textField.getText() ?? '';

  const borderWidth = bs?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);

  const rotate = rotateInPlace({ ...rectangle, rotation });

  const black = rgb(0, 0, 0);

  const borderColor = componentsToColor(ap?.getBorderColor());
  const normalBackgroundColor = componentsToColor(ap?.getBackgroundColor());

  let textLines;
  let fontSize;

  const padding = textField.isCombed() ? 0 : 1;
  const bounds = {
    x: borderWidth + padding,
    y: borderWidth + padding,
    width: width - (borderWidth + padding) * 2,
    height: height - (borderWidth + padding) * 2,
  };
  if (textField.isMultiline()) {
    const layout = layoutMultilineFitted(text, {
      alignment: textField.getAlignment(),
      fontSize: widgetFontSize ?? fieldFontSize,
      font,
      bounds,
    });
    textLines = layout.lines;
    fontSize = layout.fontSize;
  } else if (textField.isCombed()) {
    const layout = layoutCombedText(text, {
      fontSize: widgetFontSize ?? fieldFontSize,
      font,
      bounds,
      cellCount: textField.getMaxLength() ?? 0,
    });
    textLines = layout.cells;
    fontSize = layout.fontSize;
  } else {
    const layout = layoutSinglelineText(text, {
      alignment: textField.getAlignment(),
      fontSize: widgetFontSize ?? fieldFontSize,
      font,
      bounds,
    });
    textLines = [layout.line];
    fontSize = layout.fontSize;
  }

  // Update font size and color
  const textColor = widgetColor ?? fieldColor ?? black;
  // An automatic size (0) stays automatic: each widget, and each later value, fits anew.
  const storedSize = (widgetFontSize ?? fieldFontSize) ? fontSize : 0;
  if (widgetColor || widgetFontSize !== undefined) {
    updateDefaultAppearance(widget, textColor, font, storedSize);
  } else {
    updateDefaultAppearance(textField.acroField, textColor, font, storedSize);
  }

  const options = {
    x: 0 + borderWidth / 2,
    y: 0 + borderWidth / 2,
    width: width - borderWidth,
    height: height - borderWidth,
    borderWidth: borderWidth ?? 0,
    borderColor,
    textColor: shown ?? textColor,
    font: font.name,
    fontSize,
    color: normalBackgroundColor,
    textLines,
    padding,
  };

  return [...rotate, ...drawTextField(options)];
};

export const defaultDropdownAppearanceProvider = (dropdown, widget, font) => {
  // The `/DA` entry can be at the widget or field level - so we handle both
  const widgetColor = getDefaultColor(widget);
  const fieldColor = getDefaultColor(dropdown.acroField);
  const widgetFontSize = getDefaultFontSize(widget);
  const fieldFontSize = getDefaultFontSize(dropdown.acroField);

  const rectangle = widget.getRectangle();
  const ap = widget.getAppearanceCharacteristics();
  const bs = widget.getBorderStyle();
  const text = dropdown.getSelected()[0] ?? '';

  const borderWidth = bs?.getWidth() ?? 0;
  const rotation = reduceRotation(ap?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);

  const rotate = rotateInPlace({ ...rectangle, rotation });

  const black = rgb(0, 0, 0);

  const borderColor = componentsToColor(ap?.getBorderColor());
  const normalBackgroundColor = componentsToColor(ap?.getBackgroundColor());

  const padding = 1;
  const bounds = {
    x: borderWidth + padding,
    y: borderWidth + padding,
    width: width - (borderWidth + padding) * 2,
    height: height - (borderWidth + padding) * 2,
  };
  const { line, fontSize } = layoutSinglelineText(text, {
    alignment: TextAlignment.Left,
    fontSize: widgetFontSize ?? fieldFontSize,
    font,
    bounds,
  });

  // Update font size and color
  const textColor = widgetColor ?? fieldColor ?? black;
  // An automatic size (0) stays automatic: each widget, and each later value, fits anew.
  const storedSize = (widgetFontSize ?? fieldFontSize) ? fontSize : 0;
  if (widgetColor || widgetFontSize !== undefined) {
    updateDefaultAppearance(widget, textColor, font, storedSize);
  } else {
    updateDefaultAppearance(dropdown.acroField, textColor, font, storedSize);
  }

  const options = {
    x: 0 + borderWidth / 2,
    y: 0 + borderWidth / 2,
    width: width - borderWidth,
    height: height - borderWidth,
    borderWidth: borderWidth ?? 0,
    borderColor,
    textColor,
    font: font.name,
    fontSize,
    color: normalBackgroundColor,
    textLines: [line],
    padding,
  };

  return [...rotate, ...drawTextField(options)];
};
