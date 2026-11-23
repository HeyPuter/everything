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
    const layout = layoutMultilineText(text, {
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
