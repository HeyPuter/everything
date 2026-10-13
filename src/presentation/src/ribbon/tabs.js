// The ribbon's tabs, groups and commands. Everything here is declarative:
// each command calls into `api`,
// the editor's command surface built in main.js, and asks it whether the
// command is available. A command appears only when the app can carry it out.
const M = (api) => api.modKey;

export function buildTabs(api) {
  const text = () => api.textTarget();
  const sel = () => api.selection();
  const one = () => sel().length === 1;
  const some = () => sel().length > 0;
  const shapeSel = () => api.selectionKind() === "shape";
  const pictureSel = () => api.selectionKind() === "picture";
  const tableSel = () => api.selectionKind() === "table";
  const fmt = () => api.textFormat();
  const keep = { keepFocus: true };

  const clipboard = {
    id: "clipboard",
    label: "Clipboard",
    icon: "paste",
    items: [
      {
        type: "large",
        id: "paste",
        label: "Paste",
        icon: "paste",
        title: `Paste (${M(api)}+V)`,
        description: "Add content from the clipboard to the slide.",
        split: true,
        run: () => api.paste(),
        menu: () => api.pasteMenu(),
        menuLabel: "Paste options",
      },
      {
        type: "stack",
        items: [
          {
            type: "small",
            id: "cut",
            label: "Cut",
            icon: "cut",
            title: `Cut (${M(api)}+X)`,
            enabled: some,
            run: () => api.cut(),
          },
          {
            type: "small",
            id: "copy",
            label: "Copy",
            icon: "copy",
            title: `Copy (${M(api)}+C)`,
            enabled: some,
            run: () => api.copy(),
          },
          {
            type: "toggle",
            id: "format-painter",
            label: "Format",
            ariaLabel: "Format Painter",
            icon: "formatPainter",
            title: `Format Painter (${M(api)}+Shift+C, then ${M(api)}+Shift+V)`,
            description:
              "Copy the formatting of the selection and apply it to the next object you click. Double-click to apply it to several.",
            enabled: () => one() || api.formatPainterActive(),
            pressed: () => api.formatPainterActive(),
            run: () => api.formatPainter(),
          },
        ],
      },
    ],
  };
  const slides = {
    id: "slides",
    label: "Slides",
    icon: "newSlide",
    items: [
      {
        type: "large",
        id: "new-slide",
        label: "New\nSlide",
        icon: "newSlide",
        title: `New Slide (${api.newSlideKeys})`,
        description: "Add a slide after the current one.",
        split: true,
        run: () => api.newSlide(),
        menu: () => api.newSlideMenu(),
        menuLabel: "New Slide layouts",
      },
      {
        type: "large",
        id: "layout",
        label: "Layout",
        icon: "layout",
        title: "Layout",
        description: "Choose a different layout for the selected slides.",
        menu: () => api.layoutMenu(),
        enabled: () => api.canChangeLayout(),
      },
      {
        type: "large",
        id: "reset",
        label: "Reset",
        icon: "resetSlide",
        title: "Reset",
        description:
          "Reset the position, size and formatting of the slide's placeholders to their layout's.",
        enabled: () => api.canResetSlide(),
        run: () => api.resetSlide(),
      },
      {
        type: "large",
        id: "section",
        label: "Section",
        icon: "section",
        title: "Section",
        description: "Organize your slides into sections.",
        menu: () => api.sectionMenu(),
      },
    ],
  };
  const font = {
    id: "font",
    label: "Font",
    icon: "textColor",
    items: [
      {
        type: "stack",
        rows: 2,
        items: [
          {
            type: "row",
            items: [
              {
                type: "combo",
                id: "font-name",
                label: "Font",
                width: 134,
                listWidth: 220,
                enabled: () => !!text(),
                value: () => fmt().font || "",
                options: () => api.fontList(),
                optionStyle: (name) => ({
                  fontFamily: api.fontPreviewFamily(name),
                }),
                commit: (value) => api.applyText({ font: value }),
              },
              {
                type: "combo",
                id: "font-size",
                label: "Font Size",
                width: 50,
                enabled: () => !!text(),
                value: () =>
                  fmt().size ? Math.round(fmt().size * 10) / 10 : "",
                options: () => api.fontSizes(),
                commit: (value) => {
                  const n = parseFloat(value);
                  if (Number.isFinite(n) && n >= 1 && n <= 4000)
                    return api.applyText({ size: n });
                },
              },
              {
                type: "small",
                id: "font-grow",
                label: "Increase Font Size",
                showLabel: false,
                icon: "fontGrow",
                title: `Increase Font Size (${M(api)}+Shift+>)`,
                enabled: () => !!text(),
                run: () => api.stepTextSize(1),
                ...keep,
              },
              {
                type: "small",
                id: "font-shrink",
                label: "Decrease Font Size",
                showLabel: false,
                icon: "fontShrink",
                title: `Decrease Font Size (${M(api)}+Shift+<)`,
                enabled: () => !!text(),
                run: () => api.stepTextSize(-1),
                ...keep,
              },
              { type: "divider" },
              {
                type: "small",
                id: "clear-formatting",
                label: "Clear All Formatting",
                showLabel: false,
                icon: "clearFormat",
                title: "Clear All Formatting (Ctrl+Space)",
                description:
                  "Remove all formatting from the selection, leaving only the normal, unformatted text.",
                enabled: () => !!text(),
                run: () => api.clearFormatting(),
                ...keep,
              },
            ],
          },
          {
            type: "row",
            items: [
              toggle("bold", "Bold", "bold", `${M(api)}+B`),
              toggle("italic", "Italic", "italic", `${M(api)}+I`),
              toggle("underline", "Underline", "underline", `${M(api)}+U`),
              toggle("strike", "Strikethrough", "strike"),
              {
                type: "toggle",
                id: "superscript",
                label: "Superscript",
                showLabel: false,
                icon: "superscript",
                title: "Superscript",
                enabled: () => !!text(),
                pressed: () => (fmt().baseline || 0) > 0,
                run: () => api.toggleBaseline(30),
                ...keep,
              },
              {
                type: "toggle",
                id: "subscript",
                label: "Subscript",
                showLabel: false,
                icon: "subscript",
                title: "Subscript",
                enabled: () => !!text(),
                pressed: () => (fmt().baseline || 0) < 0,
                run: () => api.toggleBaseline(-25),
                ...keep,
              },
              {
                type: "small",
                id: "char-spacing",
                label: "Character Spacing",
                showLabel: false,
                icon: "charSpacing",
                title: "Character Spacing",
                description:
                  "Increase or decrease the spacing between characters.",
                enabled: () => !!text(),
                menu: () => api.charSpacingMenu(),
              },
              {
                type: "small",
                id: "change-case",
                label: "Change Case",
                showLabel: false,
                icon: "changeCase",
                title: "Change Case",
                description:
                  "Change the selected text to uppercase, lowercase, or other capitalizations.",
                enabled: () => !!text(),
                menu: () => api.changeCaseMenu(),
              },
              { type: "divider" },
              {
                type: "color",
                id: "highlight",
                label: "Text Highlight Color",
                showLabel: false,
                icon: "highlight",
                title: "Text Highlight Color",
                description:
                  "Make text stand out by highlighting it in a bright color.",
                enabled: () => !!text(),
                color: () => api.lastColor("highlight"),
                run: () => api.applyLastColor("highlight"),
                menu: () => api.colorMenu("highlight"),
                menuLabel: "Highlight colors",
                ...keep,
              },
              {
                type: "color",
                id: "font-color",
                label: "Font Color",
                showLabel: false,
                icon: "textColor",
                title: "Font Color",
                description: "Change the color of your text.",
                enabled: () => !!text(),
                color: () => api.lastColor("text"),
                run: () => api.applyLastColor("text"),
                menu: () => api.colorMenu("text"),
                menuLabel: "Font colors",
                ...keep,
              },
            ],
          },
        ],
      },
    ],
  };
  function toggle(key, label, icon, shortcut) {
    return {
      type: "toggle",
      id: key,
      label,
      showLabel: false,
      icon,
      title: shortcut ? `${label} (${shortcut})` : label,
      enabled: () => !!text(),
      pressed: () => api.textToggleState(key),
      run: () => api.toggleText(key),
      ...keep,
    };
  }
  const paragraph = {
    id: "paragraph",
    label: "Paragraph",
    icon: "alignLeft",
    items: [
      {
        type: "stack",
        rows: 2,
        items: [
          {
            type: "row",
            items: [
              {
                type: "toggle",
                id: "bullets",
                label: "Bullets",
                showLabel: false,
                icon: "bullets",
                title: "Bullets",
                enabled: () => api.canList(),
                pressed: () => api.listStyle() === "bullet",
                run: () => api.toggleList("bullet"),
                split: true,
                menu: () => api.bulletMenu(),
                menuLabel: "Bullet styles",
                ...keep,
              },
              {
                type: "toggle",
                id: "numbering",
                label: "Numbering",
                showLabel: false,
                icon: "numbering",
                title: "Numbering",
                enabled: () => api.canList(),
                pressed: () => api.listStyle() === "number",
                run: () => api.toggleList("number"),
                split: true,
                menu: () => api.numberingMenu(),
                menuLabel: "Numbering styles",
                ...keep,
              },
              { type: "divider" },
              {
                type: "small",
                id: "indent-less",
                label: "Decrease List Level",
                showLabel: false,
                icon: "indentLess",
                title: "Decrease List Level (Shift+Tab)",
                enabled: () => api.canList(),
                run: () => api.indent(-1),
                ...keep,
              },
              {
                type: "small",
                id: "indent-more",
                label: "Increase List Level",
                showLabel: false,
                icon: "indentMore",
                title: "Increase List Level (Tab)",
                enabled: () => api.canList(),
                run: () => api.indent(1),
                ...keep,
              },
              { type: "divider" },
              {
                type: "small",
                id: "line-spacing",
                label: "Line Spacing",
                showLabel: false,
                icon: "lineSpacing",
                title: "Line Spacing",
                description:
                  "Choose how much space appears between lines of text.",
                enabled: () => api.canList(),
                menu: () => api.lineSpacingMenu(),
              },
              {
                type: "small",
                id: "columns",
                label: "Columns",
                showLabel: false,
                icon: "columns",
                title: "Add or Remove Columns",
                description: "Split your text into two or more columns.",
                enabled: () => api.canColumns(),
                menu: () => api.columnsMenu(),
              },
            ],
          },
          {
            type: "row",
            items: [
              align("left", "Align Left", "alignLeft", `${M(api)}+L`),
              align("center", "Center", "alignCenter", `${M(api)}+E`),
              align("right", "Align Right", "alignRight", `${M(api)}+R`),
              align("justify", "Justify", "justify", `${M(api)}+J`),
              { type: "divider" },
              {
                type: "small",
                id: "text-direction",
                label: "Text Direction",
                showLabel: false,
                icon: "textDirection",
                title: "Text Direction",
                description:
                  "Change the orientation of text to vertical, stacked, or rotated.",
                enabled: () => api.canColumns(),
                menu: () => api.textDirectionMenu(),
              },
              {
                type: "small",
                id: "align-text",
                label: "Align Text",
                showLabel: false,
                icon: "alignText",
                title: "Align Text",
                description: "Change how text is aligned within the text box.",
                enabled: () => !!text(),
                menu: () => api.alignTextMenu(),
              },
              {
                type: "small",
                id: "convert-smartart",
                label: "Convert to SmartArt",
                showLabel: false,
                icon: "smartArtConvert",
                title: "Convert to SmartArt Graphic",
                description:
                  "Convert the text to a diagram such as a process or hierarchy.",
                visible: () => !!api.canConvertToSmartArt,
                enabled: () => !!api.canConvertToSmartArt?.(),
                menu: () => api.convertToSmartArtMenu?.(),
              },
            ],
          },
        ],
      },
    ],
  };
  function align(value, label, icon, shortcut) {
    return {
      type: "toggle",
      id: `align-${value}`,
      label,
      showLabel: false,
      icon,
      title: `${label} (${shortcut})`,
      enabled: () => !!text(),
      pressed: () => !!text() && api.alignment() === value,
      run: () => api.setAlignment(value),
      ...keep,
    };
  }
  const insertShapesGroup = (largeLabels = true) => ({
    id: "drawing-insert",
    label: "Drawing",
    icon: "shapes",
    items: [
      {
        type: "large",
        id: "picture",
        label: "Picture",
        icon: "picture",
        title: "Picture",
        description: "Insert a picture from your device.",
        split: true,
        run: () => api.insertPicture(),
        menu: () => api.pictureMenu(),
        menuLabel: "Picture sources",
      },
      {
        type: "large",
        id: "shapes",
        label: "Shapes",
        icon: "shapes",
        title: "Shapes",
        description:
          "Draw a shape: choose one, then click or drag on the slide.",
        menu: () => api.shapesMenu(),
        menuWidth: 300,
      },
      {
        type: "large",
        id: "text-box",
        label: "Text\nBox",
        ariaLabel: "Text Box",
        icon: "textBox",
        title: "Text Box",
        description: "Draw a text box: click or drag on the slide.",
        pressed: () => api.drawingTool() === "text",
        run: () => api.startDrawing("text"),
      },
    ],
  });
  const drawing = {
    id: "drawing",
    label: "Drawing",
    icon: "arrange",
    items: [
      {
        type: "large",
        id: "arrange",
        label: "Arrange",
        icon: "arrange",
        title: "Arrange",
        description: "Order, group, align and rotate objects.",
        enabled: some,
        menu: () => api.arrangeMenu(),
      },
      {
        type: "large",
        id: "quick-styles",
        label: "Quick\nStyles",
        icon: "quickStyles",
        title: "Quick Styles",
        description: "Choose a visual style for the shape or line.",
        enabled: () => api.canStyleShape(),
        menu: () => api.quickStylesMenu(),
        menuWidth: 340,
      },
      {
        type: "stack",
        items: [
          {
            type: "color",
            id: "shape-fill",
            label: "Shape Fill",
            icon: "shapeFill",
            title: "Shape Fill",
            description:
              "Fill the selected shape with a solid color, gradient, picture, or texture.",
            enabled: () => api.canFill(),
            color: () => api.lastColor("fill"),
            run: () => api.applyLastColor("fill"),
            menu: () => api.colorMenu("fill"),
            menuLabel: "Fill colors",
          },
          {
            type: "color",
            id: "shape-outline",
            label: "Shape Outline",
            icon: "shapeOutline",
            title: "Shape Outline",
            description:
              "Choose the color, width, and line style for the outline of the shape.",
            enabled: () => api.canOutline(),
            color: () => api.lastColor("line"),
            run: () => api.applyLastColor("line"),
            menu: () => api.colorMenu("line"),
            menuLabel: "Outline colors",
          },
          {
            type: "small",
            id: "shape-effects",
            label: "Shape Effects",
            icon: "shapeEffects",
            title: "Shape Effects",
            description:
              "Apply a visual effect to the shape, such as a shadow.",
            enabled: () => api.canEffects(),
            menu: () => api.effectsMenu(),
          },
        ],
      },
    ],
  };
  const editing = {
    id: "editing",
    label: "Editing",
    icon: "find",
    items: [
      {
        type: "stack",
        items: [
          {
            type: "small",
            id: "find",
            label: "Find",
            icon: "find",
            title: `Find (${M(api)}+F)`,
            run: () => api.find(),
          },
          {
            type: "small",
            id: "replace",
            label: "Replace",
            icon: "replace",
            title: `Replace (${M(api)}+H)`,
            run: () => api.replace(),
          },
          {
            type: "small",
            id: "select",
            label: "Select",
            icon: "select",
            title: "Select",
            menu: () => api.selectMenu(),
          },
        ],
      },
    ],
  };
  const designer = {
    id: "designer",
    label: "Designer",
    icon: "designer",
    items: [
      {
        type: "large",
        id: "designer",
        label: "Design\nIdeas",
        icon: "designer",
        title: "Design Ideas",
        description:
          "Ask the AI assistant for design suggestions for this slide.",
        visible: () => api.hasAssistant(),
        run: () => api.designIdeas(),
      },
    ],
  };

  const home = {
    id: "home",
    label: "Home",
    groups: [
      clipboard,
      slides,
      font,
      paragraph,
      insertShapesGroup(),
      drawing,
      editing,
      designer,
    ].map((g, i) => ({ ...g, priority: [6, 5, 9, 8, 4, 3, 1, 2][i] })),
  };

  const insert = {
    id: "insert",
    label: "Insert",
    groups: [
      {
        id: "insert-slides",
        label: "Slides",
        icon: "newSlide",
        items: [
          {
            type: "large",
            id: "insert-new-slide",
            label: "New\nSlide",
            icon: "newSlide",
            title: `New Slide (${api.newSlideKeys})`,
            split: true,
            run: () => api.newSlide(),
            menu: () => api.newSlideMenu(),
            menuLabel: "New Slide layouts",
          },
        ],
      },
      {
        id: "tables",
        label: "Tables",
        icon: "table",
        items: [
          {
            type: "large",
            id: "table",
            label: "Table",
            icon: "table",
            title: "Table",
            description: "Add a table to the slide.",
            menu: () => api.tableMenu(),
            menuWidth: 220,
          },
        ],
      },
      {
        id: "images",
        label: "Images",
        icon: "pictures",
        items: [
          {
            type: "large",
            id: "insert-pictures",
            label: "Pictures",
            icon: "pictures",
            title: "Pictures",
            description: "Insert pictures from your device.",
            split: true,
            run: () => api.insertPicture(),
            menu: () => api.pictureMenu(),
            menuLabel: "Picture sources",
          },
          {
            type: "large",
            id: "photo-album",
            label: "Photo\nAlbum",
            icon: "photoAlbum",
            title: "Photo Album",
            description:
              "Create a presentation with one picture on each slide.",
            visible: () => !!api.photoAlbum,
            run: () => api.photoAlbum?.(),
          },
        ],
      },
      {
        id: "illustrations",
        label: "Illustrations",
        icon: "shapes",
        items: [
          {
            type: "large",
            id: "insert-shapes",
            label: "Shapes",
            icon: "shapes",
            title: "Shapes",
            menu: () => api.shapesMenu(),
            menuWidth: 300,
          },
          {
            type: "large",
            id: "icons",
            label: "Icons",
            icon: "icons",
            title: "Icons",
            description: "Insert an icon to communicate visually.",
            visible: () => !!api.insertIcons,
            run: () => api.insertIcons?.(),
          },
          {
            type: "large",
            id: "smartart",
            label: "SmartArt",
            icon: "smartArt",
            title: "SmartArt",
            description:
              "Insert a SmartArt graphic to communicate information visually.",
            visible: () => !!api.insertSmartArt,
            run: () => api.insertSmartArt?.(),
          },
          {
            type: "large",
            id: "chart",
            label: "Chart",
            icon: "chart",
            title: "Chart",
            description: "Add a chart to illustrate and compare data.",
            visible: () => !!api.insertChart,
            run: () => api.insertChart?.(),
          },
        ],
      },
      {
        id: "links",
        label: "Links",
        icon: "link",
        items: [
          {
            type: "large",
            id: "link",
            label: "Link",
            icon: "link",
            title: `Link (${M(api)}+K)`,
            description: "Create a link to a web page or another slide.",
            enabled: () => api.canLink(),
            run: () => api.insertLink(),
          },
          {
            type: "large",
            id: "action",
            label: "Action",
            icon: "action",
            title: "Action",
            description:
              "Make the selected object go to a slide or web page when clicked in a slide show.",
            enabled: () => api.canLink(),
            menu: () => api.actionMenu(),
          },
        ],
      },
      {
        id: "comments",
        label: "Comments",
        icon: "newComment",
        items: [
          {
            type: "large",
            id: "insert-comment",
            label: "Comment",
            icon: "newComment",
            title: `New Comment (${M(api)}+Alt+M)`,
            visible: () => !!api.newComment,
            run: () => api.newComment?.(),
          },
        ],
      },
      {
        id: "text",
        label: "Text",
        icon: "textBox",
        items: [
          {
            type: "large",
            id: "insert-text-box",
            label: "Text\nBox",
            icon: "textBox",
            title: "Text Box",
            pressed: () => api.drawingTool() === "text",
            run: () => api.startDrawing("text"),
          },
          {
            type: "large",
            id: "header-footer",
            label: "Header &\nFooter",
            icon: "headerFooter",
            title: "Header & Footer",
            description:
              "Add the date, slide number, or footer text to slides.",
            visible: () => !!api.headerFooter,
            run: () => api.headerFooter?.(),
          },
          {
            type: "large",
            id: "wordart",
            label: "WordArt",
            icon: "wordArt",
            title: "WordArt",
            description: "Add decorative text to the slide.",
            menu: () => api.wordArtMenu(),
            menuWidth: 300,
          },
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "date-time",
                label: "Date & Time",
                icon: "dateTime",
                title: "Date & Time",
                description: "Insert the current date or time.",
                enabled: () => api.canInsertField(),
                menu: () => api.dateTimeMenu(),
              },
              {
                type: "small",
                id: "slide-number",
                label: "Slide Number",
                icon: "slideNumber",
                title: "Slide Number",
                description: "Insert the slide number.",
                enabled: () => api.canInsertField(),
                run: () => api.insertSlideNumber(),
              },
            ],
          },
        ],
      },
      {
        id: "symbols",
        label: "Symbols",
        icon: "symbol",
        items: [
          {
            type: "large",
            id: "equation",
            label: "Equation",
            icon: "equation",
            title: "Equation",
            visible: () => !!api.insertEquation,
            run: () => api.insertEquation?.(),
          },
          {
            type: "large",
            id: "symbol",
            label: "Symbol",
            icon: "symbol",
            title: "Symbol",
            description: "Add characters that are not on your keyboard.",
            enabled: () => api.canInsertField(),
            run: () => api.insertSymbol(),
          },
        ],
      },
      {
        id: "media",
        label: "Media",
        icon: "video",
        visible: () => !!api.insertVideo,
        items: [
          {
            type: "large",
            id: "video",
            label: "Video",
            icon: "video",
            title: "Video",
            run: () => api.insertVideo?.(),
          },
          {
            type: "large",
            id: "audio",
            label: "Audio",
            icon: "audio",
            title: "Audio",
            run: () => api.insertAudio?.(),
          },
        ],
      },
    ],
  };

  const design = {
    id: "design",
    label: "Design",
    groups: [
      {
        id: "themes",
        label: "Themes",
        icon: "themes",
        collapsible: false,
        items: [
          {
            type: "gallery",
            id: "themes",
            label: "Themes",
            columns: 7,
            panelColumns: 4,
            itemClass: "theme-thumb",
            showLabels: false,
            items: () => api.themeChoices(),
            selected: () => api.currentTheme(),
            choose: (choice) => api.applyTheme(choice.id),
            footer: () => api.themeGalleryFooter(),
          },
        ],
      },
      {
        id: "variants",
        label: "Variants",
        icon: "variants",
        visible: () => api.variantChoices().length > 0,
        items: [
          {
            type: "gallery",
            id: "variants",
            label: "Variants",
            columns: 4,
            itemClass: "variant-thumb",
            showLabels: false,
            items: () => api.variantChoices(),
            selected: () => api.currentVariant(),
            choose: (choice) => api.applyVariant(choice.id),
            footer: () => api.variantFooter(),
          },
        ],
      },
      {
        id: "customize",
        label: "Customize",
        icon: "slideSize",
        items: [
          {
            type: "large",
            id: "slide-size",
            label: "Slide\nSize",
            icon: "slideSize",
            title: "Slide Size",
            description: "Change the size of the slides in this presentation.",
            menu: () => api.slideSizeMenu(),
          },
          {
            type: "large",
            id: "format-background",
            label: "Format\nBackground",
            icon: "formatBackground",
            title: "Format Background",
            description: "Adjust the background of the slide.",
            run: () => api.formatBackground(),
          },
        ],
      },
      {
        id: "design-ideas",
        label: "Designer",
        icon: "designer",
        visible: () => api.hasAssistant(),
        items: [
          {
            type: "large",
            id: "design-designer",
            label: "Design\nIdeas",
            icon: "designer",
            title: "Design Ideas",
            description:
              "Ask the AI assistant for design suggestions for this slide.",
            run: () => api.designIdeas(),
          },
        ],
      },
    ],
  };

  const transitions = {
    id: "transitions",
    label: "Transitions",
    groups: [
      {
        id: "preview",
        label: "Preview",
        icon: "previewTransition",
        items: [
          {
            type: "large",
            id: "preview-transition",
            label: "Preview",
            icon: "previewTransition",
            title: "Preview Transitions",
            description: "Play the transition on the current slide.",
            enabled: () => api.canPreviewTransition(),
            run: () => api.previewTransition(),
          },
        ],
      },
      {
        id: "transition-gallery",
        label: "Transition to This Slide",
        icon: "previewTransition",
        collapsible: false,
        items: [
          {
            type: "gallery",
            id: "transition-gallery",
            label: "Transitions",
            columns: 9,
            panelColumns: 8,
            itemClass: "transition-choice",
            items: () => api.transitionChoices(),
            sections: (choices) => api.transitionSections(choices),
            selected: () => api.currentTransition(),
            choose: (choice) => api.setTransition(choice.id),
          },
          {
            type: "large",
            id: "effect-options",
            label: "Effect\nOptions",
            icon: "effectOptions",
            title: "Effect Options",
            description:
              "Change the direction or other options of the transition.",
            enabled: () => api.transitionOptions().length > 0,
            menu: () => api.transitionOptionsMenu(),
          },
        ],
      },
      {
        id: "timing",
        label: "Timing",
        icon: "duration",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "transition-sound",
                label: "Sound",
                icon: "transitionSound",
                title: "Transition Sound",
                visible: () => !!api.transitionSoundMenu,
                menu: () => api.transitionSoundMenu?.(),
              },
              {
                type: "spin",
                id: "transition-duration",
                label: "Duration",
                icon: "duration",
                width: 66,
                min: 0.01,
                max: 59,
                step: 0.25,
                format: (n) => `${n.toFixed(2)}`,
                enabled: () => api.currentTransition() !== "none",
                value: () => api.transitionDuration(),
                commit: (n) => api.setTransitionDuration(n),
              },
              {
                type: "small",
                id: "apply-to-all",
                label: "Apply To All",
                icon: "applyToAll",
                title: "Apply To All",
                description:
                  "Use this slide's transition and timing for every slide.",
                run: () => api.applyTransitionToAll(),
              },
            ],
          },
          {
            type: "stack",
            items: [
              { type: "label", label: "Advance Slide" },
              {
                type: "check",
                id: "advance-on-click",
                label: "On Mouse Click",
                checked: () => api.advanceOnClick(),
                commit: (on) => api.setAdvanceOnClick(on),
              },
              {
                type: "row",
                items: [
                  {
                    type: "check",
                    id: "advance-after-on",
                    label: "After",
                    checked: () => api.advanceAfter() != null,
                    commit: (on) =>
                      api.setAdvanceAfter(
                        on ? (api.advanceAfter() ?? 0) : null,
                      ),
                  },
                  {
                    type: "spin",
                    id: "advance-after",
                    label: "Advance after",
                    ariaLabel: "Advance after (seconds)",
                    showLabel: false,
                    width: 84,
                    min: 0,
                    max: 86399,
                    step: 1,
                    format: (n) => api.formatSeconds(n),
                    parse: (s) => api.parseSeconds(s),
                    value: () => api.advanceAfter() ?? 0,
                    commit: (n) => api.setAdvanceAfter(n),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const slideShow = {
    id: "slideshow",
    label: "Slide Show",
    groups: [
      {
        id: "start",
        label: "Start Slide Show",
        icon: "playFromStart",
        items: [
          {
            type: "large",
            id: "play-from-start",
            label: "From\nBeginning",
            icon: "playFromStart",
            title: "Play from Start (F5)",
            run: () => api.present({ from: "beginning" }),
          },
          {
            type: "large",
            id: "play-from-current",
            label: "From Current\nSlide",
            icon: "playFromCurrent",
            title: "Play from Current Slide (Shift+F5)",
            run: () => api.present({ from: "current" }),
          },
          {
            type: "large",
            id: "presenter-view",
            label: "Presenter\nView",
            icon: "presenterView",
            title: "Presenter View (Alt+F5)",
            description:
              "Present with your notes, the next slide, and a timer on your screen.",
            visible: () => !!api.presenterView,
            run: () => api.presenterView?.(),
          },
          {
            type: "large",
            id: "custom-show",
            label: "Custom\nSlide Show",
            icon: "customShow",
            title: "Custom Slide Show",
            visible: () => !!api.customShowMenu,
            menu: () => api.customShowMenu?.(),
          },
        ],
      },
      {
        id: "set-up",
        label: "Set Up",
        icon: "setUpShow",
        items: [
          {
            type: "large",
            id: "set-up-show",
            label: "Set Up\nSlide Show",
            icon: "setUpShow",
            title: "Set Up Slide Show",
            visible: () => !!api.setUpShow,
            run: () => api.setUpShow?.(),
          },
          {
            type: "large",
            id: "hide-slide",
            label: "Hide\nSlide",
            icon: "hideSlide",
            title: "Hide Slide",
            description:
              "Hide the selected slides; they are skipped during the slide show.",
            pressed: () => api.slideHidden(),
            run: () => api.toggleHideSlide(),
          },
          {
            type: "large",
            id: "rehearse",
            label: "Rehearse\nTimings",
            icon: "rehearse",
            title: "Rehearse Timings",
            visible: () => !!api.rehearse,
            run: () => api.rehearse?.(),
          },
          {
            type: "stack",
            items: [
              {
                type: "check",
                id: "use-timings",
                label: "Use Timings",
                visible: () => !!api.setUseTimings,
                checked: () => api.useTimings?.() ?? true,
                commit: (on) => api.setUseTimings?.(on),
              },
            ],
          },
        ],
      },
    ],
  };

  const review = {
    id: "review",
    label: "Review",
    groups: [
      {
        id: "proofing",
        label: "Proofing",
        icon: "spelling",
        items: [
          {
            type: "large",
            id: "spelling",
            label: "Spelling",
            icon: "spelling",
            title: "Spelling (F7)",
            description: "Check the spelling of the text in the presentation.",
            run: () => api.spelling(),
          },
          {
            type: "large",
            id: "thesaurus",
            label: "Thesaurus",
            icon: "thesaurus",
            title: "Thesaurus",
            visible: () => !!api.thesaurus,
            run: () => api.thesaurus?.(),
          },
        ],
      },
      {
        id: "accessibility",
        label: "Accessibility",
        icon: "accessibility",
        items: [
          {
            type: "large",
            id: "check-accessibility",
            label: "Check\nAccessibility",
            icon: "accessibility",
            title: "Check Accessibility",
            description:
              "Find content that people with disabilities might find hard to read.",
            run: () => api.checkAccessibility(),
          },
          {
            type: "large",
            id: "alt-text",
            label: "Alt\nText",
            icon: "altText",
            title: "Alt Text",
            description:
              "Describe the selected picture or object for people who use screen readers.",
            enabled: () => one(),
            run: () => api.altText(),
          },
        ],
      },
      {
        id: "language",
        label: "Language",
        icon: "language",
        items: [
          {
            type: "large",
            id: "language",
            label: "Language",
            icon: "language",
            title: "Language",
            description: "Choose the proofing language of the selected text.",
            menu: () => api.languageMenu(),
          },
        ],
      },
      {
        id: "review-comments",
        label: "Comments",
        icon: "newComment",
        visible: () => !!api.newComment,
        items: [
          {
            type: "large",
            id: "new-comment",
            label: "New\nComment",
            icon: "newComment",
            title: "New Comment",
            run: () => api.newComment?.(),
          },
          {
            type: "large",
            id: "delete-comment",
            label: "Delete",
            icon: "deleteComment",
            title: "Delete Comment",
            enabled: () => !!api.canDeleteComment?.(),
            menu: () => api.deleteCommentMenu?.(),
          },
          {
            type: "large",
            id: "previous-comment",
            label: "Previous",
            icon: "previousComment",
            title: "Previous Comment",
            enabled: () => !!api.hasComments?.(),
            run: () => api.stepComment?.(-1),
          },
          {
            type: "large",
            id: "next-comment",
            label: "Next",
            icon: "nextComment",
            title: "Next Comment",
            enabled: () => !!api.hasComments?.(),
            run: () => api.stepComment?.(1),
          },
          {
            type: "large",
            id: "show-comments",
            label: "Show\nComments",
            icon: "showComments",
            title: "Show Comments",
            pressed: () => !!api.commentsOpen?.(),
            run: () => api.toggleComments?.(),
          },
        ],
      },
    ],
  };

  const viewTab = {
    id: "view",
    label: "View",
    groups: [
      {
        id: "presentation-views",
        label: "Presentation Views",
        icon: "normalView",
        items: [
          view("normal", "Normal", "normalView"),
          view("outline", "Outline View", "outlineView"),
          view("sorter", "Slide Sorter", "slideSorter"),
          view("notesPage", "Notes Page", "notesPage"),
          view("reading", "Reading View", "readingView"),
        ],
      },
      {
        id: "master-views",
        label: "Master Views",
        icon: "slideMaster",
        visible: () => !!api.masterView,
        items: [
          {
            type: "large",
            id: "slide-master",
            label: "Slide\nMaster",
            icon: "slideMaster",
            title: "Slide Master",
            run: () => api.masterView?.("slide"),
          },
        ],
      },
      {
        id: "show",
        label: "Show",
        icon: "ruler",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "check",
                id: "show-ruler",
                label: "Ruler",
                checked: () => api.showing("ruler"),
                commit: (on) => api.show("ruler", on),
              },
              {
                type: "check",
                id: "show-gridlines",
                label: "Gridlines",
                checked: () => api.showing("gridlines"),
                commit: (on) => api.show("gridlines", on),
              },
              {
                type: "check",
                id: "show-guides",
                label: "Guides",
                checked: () => api.showing("guides"),
                commit: (on) => api.show("guides", on),
              },
            ],
          },
          {
            type: "large",
            id: "notes",
            label: "Notes",
            icon: "notesPane",
            title: "Notes",
            description: "Show or hide the notes pane under the slide.",
            pressed: () => api.showing("notes"),
            run: () => api.show("notes", !api.showing("notes")),
          },
          {
            type: "small",
            id: "grid-settings",
            label: "Grid Settings",
            icon: "gridlines",
            showLabel: true,
            title: "Grid and Guides",
            description:
              "Set the grid spacing, snapping, and which guides show.",
            visible: () => !!api.gridDialog,
            run: () => api.gridDialog(),
          },
        ],
      },
      {
        id: "zoom",
        label: "Zoom",
        icon: "zoom",
        items: [
          {
            type: "large",
            id: "zoom",
            label: "Zoom",
            icon: "zoom",
            title: "Zoom",
            menu: () => api.zoomMenu(),
          },
          {
            type: "large",
            id: "fit-to-window",
            label: "Fit to\nWindow",
            icon: "fitWindow",
            title: `Fit to Window (${M(api)}+0)`,
            run: () => api.fitToWindow(),
          },
        ],
      },
      {
        id: "color-mode",
        label: "Color/Grayscale",
        icon: "color",
        items: [
          {
            type: "stack",
            items: [
              colorMode("color", "Color", "color"),
              colorMode("grayscale", "Grayscale", "grayscale"),
              colorMode("blackwhite", "Black and White", "blackScreen"),
            ],
          },
        ],
      },
      {
        id: "panes",
        label: "Panes",
        icon: "formatPane",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "toggle",
                id: "view-thumbnails",
                label: "Slide Thumbnails",
                icon: "normalView",
                pressed: () => api.showing("thumbnails"),
                run: () => api.show("thumbnails", !api.showing("thumbnails")),
              },
              {
                type: "toggle",
                id: "view-format-pane",
                label: "Format Pane",
                icon: "formatPane",
                pressed: () => api.showing("formatPane"),
                run: () => api.show("formatPane", !api.showing("formatPane")),
              },
              {
                type: "toggle",
                id: "view-assistant",
                label: "AI Assistant",
                icon: "Sparkles",
                title: `AI Assistant (${M(api)}+J)`,
                visible: () => api.hasAssistant(),
                pressed: () => api.showing("assistant"),
                run: () => api.show("assistant", !api.showing("assistant")),
              },
            ],
          },
        ],
      },
    ],
  };
  function view(id, label, icon) {
    return {
      type: "large",
      id: `view-${id}`,
      label,
      icon,
      title: label,
      visible: () => api.supportsView(id),
      pressed: () => api.currentView() === id,
      run: () => api.setView(id),
    };
  }
  function colorMode(id, label, icon) {
    return {
      type: "toggle",
      id: `color-mode-${id}`,
      label,
      icon,
      pressed: () => api.colorMode() === id,
      run: () => api.setColorMode(id),
    };
  }

  // ---- Contextual tabs ----
  const arrangeGroup = {
    id: "format-arrange",
    label: "Arrange",
    icon: "arrange",
    items: [
      {
        type: "stack",
        items: [
          {
            type: "small",
            id: "bring-forward",
            label: "Bring Forward",
            icon: "bringForward",
            title: `Bring Forward (${M(api)}+Shift+])`,
            split: true,
            run: () => api.order("forward"),
            menu: () => api.orderMenu("forward"),
          },
          {
            type: "small",
            id: "send-backward",
            label: "Send Backward",
            icon: "sendBackward",
            title: `Send Backward (${M(api)}+Shift+[)`,
            split: true,
            run: () => api.order("backward"),
            menu: () => api.orderMenu("backward"),
          },
          {
            type: "small",
            id: "selection-pane",
            label: "Selection Pane",
            icon: "selectionPane",
            title: "Selection Pane",
            description:
              "See every object on the slide; select, show, hide, and reorder them.",
            pressed: () => api.selectionPaneOpen(),
            run: () => api.toggleSelectionPane(),
          },
        ],
      },
      {
        type: "stack",
        items: [
          {
            type: "small",
            id: "align",
            label: "Align",
            icon: "align",
            title: "Align Objects",
            menu: () => api.alignMenu(),
          },
          {
            type: "small",
            id: "group",
            label: "Group",
            icon: "group",
            title: "Group Objects",
            menu: () => api.groupMenu(),
          },
          {
            type: "small",
            id: "rotate",
            label: "Rotate",
            icon: "rotate",
            title: "Rotate Objects",
            menu: () => api.rotateMenu(),
          },
        ],
      },
    ],
  };
  const sizeGroup = {
    id: "format-size",
    label: "Size",
    icon: "size",
    items: [
      {
        type: "stack",
        rows: 2,
        items: [
          {
            type: "spin",
            id: "shape-height",
            label: "Height",
            ariaLabel: "Shape Height",
            icon: "sizeHeight",
            showLabel: false,
            width: 80,
            min: 0.01,
            max: 200,
            step: 0.1,
            format: (n) => `${n.toFixed(2)}″`,
            parse: (s) => parseFloat(s),
            value: () => api.size("h"),
            commit: (n) => api.setSize("h", n),
          },
          {
            type: "spin",
            id: "shape-width",
            label: "Width",
            ariaLabel: "Shape Width",
            icon: "sizeWidth",
            showLabel: false,
            width: 80,
            min: 0.01,
            max: 200,
            step: 0.1,
            format: (n) => `${n.toFixed(2)}″`,
            parse: (s) => parseFloat(s),
            value: () => api.size("w"),
            commit: (n) => api.setSize("w", n),
          },
        ],
      },
      {
        type: "small",
        id: "format-pane",
        label: "Format Pane",
        showLabel: false,
        icon: "formatPane",
        title: "Format Pane",
        description: "Open the Format pane to fine-tune the selection.",
        run: () => api.show("formatPane", true),
      },
    ],
  };
  const shapeFormat = {
    id: "shape-format",
    label: "Shape Format",
    contextual: true,
    visible: () =>
      shapeSel() ||
      (some() &&
        !pictureSel() &&
        !tableSel() &&
        !["chart", "smartart"].includes(api.selectionKind())),
    groups: [
      {
        id: "insert-shapes",
        label: "Insert Shapes",
        icon: "shapes",
        items: [
          {
            type: "large",
            id: "format-shapes",
            label: "Shapes",
            icon: "shapes",
            title: "Shapes",
            menu: () => api.shapesMenu(),
            menuWidth: 300,
          },
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "change-shape",
                label: "Edit Shape",
                icon: "editShape",
                title: "Change Shape",
                description:
                  "Change the shape of this drawing, keeping its formatting.",
                enabled: () => api.canChangeShape(),
                menu: () => api.changeShapeMenu(),
                menuWidth: 300,
              },
              {
                type: "small",
                id: "format-text-box",
                label: "Text Box",
                icon: "textBox",
                pressed: () => api.drawingTool() === "text",
                run: () => api.startDrawing("text"),
              },
            ],
          },
        ],
      },
      {
        id: "shape-styles",
        label: "Shape Styles",
        icon: "quickStyles",
        collapsible: false,
        items: [
          {
            type: "gallery",
            id: "shape-styles",
            label: "Shape Styles",
            columns: 6,
            panelColumns: 7,
            itemClass: "style-thumb",
            showLabels: false,
            enabled: () => api.canStyleShape(),
            items: () => api.shapeStyleChoices(),
            choose: (choice) => api.applyShapeStyle(choice.id),
          },
          {
            type: "stack",
            items: [
              {
                type: "color",
                id: "format-shape-fill",
                label: "Shape Fill",
                icon: "shapeFill",
                enabled: () => api.canFill(),
                color: () => api.lastColor("fill"),
                run: () => api.applyLastColor("fill"),
                menu: () => api.colorMenu("fill"),
                menuLabel: "Fill colors",
              },
              {
                type: "color",
                id: "format-shape-outline",
                label: "Shape Outline",
                icon: "shapeOutline",
                enabled: () => api.canOutline(),
                color: () => api.lastColor("line"),
                run: () => api.applyLastColor("line"),
                menu: () => api.colorMenu("line"),
                menuLabel: "Outline colors",
              },
              {
                type: "small",
                id: "format-shape-effects",
                label: "Shape Effects",
                icon: "shapeEffects",
                enabled: () => api.canEffects(),
                menu: () => api.effectsMenu(),
              },
            ],
          },
        ],
      },
      {
        id: "wordart-styles",
        label: "WordArt Styles",
        icon: "wordArt",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "color",
                id: "text-fill",
                label: "Text Fill",
                icon: "textFill",
                enabled: () => !!text(),
                color: () => api.lastColor("text"),
                run: () => api.applyLastColor("text"),
                menu: () => api.colorMenu("text"),
                menuLabel: "Text fill colors",
              },
              {
                type: "color",
                id: "text-outline",
                label: "Text Outline",
                icon: "textOutline",
                visible: () => api.canTextOutline(),
                enabled: () => !!text(),
                color: () => api.lastColor("textOutline"),
                run: () => api.applyLastColor("textOutline"),
                menu: () => api.colorMenu("textOutline"),
                menuLabel: "Text outline colors",
              },
              {
                type: "small",
                id: "text-effects",
                label: "Text Effects",
                icon: "textEffects",
                enabled: () => !!text(),
                menu: () => api.textEffectsMenu(),
              },
            ],
          },
        ],
      },
      {
        id: "accessibility-format",
        label: "Accessibility",
        icon: "altText",
        items: [
          {
            type: "large",
            id: "format-alt-text",
            label: "Alt\nText",
            icon: "altText",
            title: "Alt Text",
            enabled: () => one(),
            run: () => api.altText(),
          },
        ],
      },
      arrangeGroup,
      sizeGroup,
    ],
  };

  const pictureFormat = {
    id: "picture-format",
    label: "Picture Format",
    contextual: true,
    visible: pictureSel,
    groups: [
      {
        id: "adjust",
        label: "Adjust",
        icon: "corrections",
        items: [
          {
            type: "large",
            id: "corrections",
            label: "Corrections",
            icon: "corrections",
            title: "Corrections",
            description: "Make the picture brighter or darker.",
            menu: () => api.correctionsMenu(),
            menuWidth: 240,
          },
          {
            type: "large",
            id: "picture-transparency",
            label: "Transparency",
            icon: "transparency",
            title: "Transparency",
            description: "Make the picture partly see-through.",
            menu: () => api.transparencyMenu(),
          },
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "change-picture",
                label: "Change Picture",
                icon: "changePicture",
                title: "Change Picture",
                description:
                  "Replace the picture, keeping its size and position.",
                run: () => api.changePicture(),
              },
              {
                type: "small",
                id: "reset-picture",
                label: "Reset Picture",
                icon: "resetPicture",
                title: "Reset Picture",
                description:
                  "Discard the formatting changes made to the picture.",
                run: () => api.resetPicture(),
              },
            ],
          },
        ],
      },
      {
        id: "picture-styles",
        label: "Picture Styles",
        icon: "pictureEffects",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "color",
                id: "picture-border",
                label: "Picture Border",
                icon: "pictureBorder",
                enabled: () => api.canOutline(),
                color: () => api.lastColor("line"),
                run: () => api.applyLastColor("line"),
                menu: () => api.colorMenu("line"),
                menuLabel: "Border colors",
              },
              {
                type: "small",
                id: "picture-effects",
                label: "Picture Effects",
                icon: "pictureEffects",
                enabled: () => api.canEffects(),
                menu: () => api.effectsMenu(),
              },
            ],
          },
        ],
      },
      {
        id: "picture-accessibility",
        label: "Accessibility",
        icon: "altText",
        items: [
          {
            type: "large",
            id: "picture-alt-text",
            label: "Alt\nText",
            icon: "altText",
            title: "Alt Text",
            run: () => api.altText(),
          },
        ],
      },
      { ...arrangeGroup, id: "picture-arrange" },
      {
        id: "picture-size",
        label: "Size",
        icon: "crop",
        items: [
          {
            type: "large",
            id: "crop",
            label: "Crop",
            icon: "crop",
            title: "Crop",
            description: "Trim away unwanted parts of the picture.",
            menu: () => api.cropMenu(),
          },
          ...sizeGroup.items,
        ],
      },
    ],
  };

  const tableDesign = {
    id: "table-design",
    label: "Table Design",
    contextual: true,
    visible: tableSel,
    groups: [
      {
        id: "table-style-options",
        label: "Table Style Options",
        icon: "tableStyles",
        items: [
          {
            type: "stack",
            items: [
              tableFlag("firstRow", "Header Row"),
              tableFlag("lastRow", "Total Row"),
              tableFlag("bandRow", "Banded Rows"),
            ],
          },
          {
            type: "stack",
            items: [
              tableFlag("firstCol", "First Column"),
              tableFlag("lastCol", "Last Column"),
              tableFlag("bandCol", "Banded Columns"),
            ],
          },
        ],
      },
      {
        id: "table-styles",
        label: "Table Styles",
        icon: "tableStyles",
        collapsible: false,
        items: [
          {
            type: "gallery",
            id: "table-styles",
            label: "Table Styles",
            columns: 6,
            panelColumns: 7,
            itemClass: "table-style-thumb",
            showLabels: false,
            items: () => api.tableStyleChoices(),
            selected: () => api.currentTableStyle(),
            choose: (choice) => api.applyTableStyle(choice.id),
          },
          {
            type: "stack",
            items: [
              {
                type: "color",
                id: "table-shading",
                label: "Shading",
                icon: "shading",
                color: () => api.lastColor("cell"),
                run: () => api.applyLastColor("cell"),
                menu: () => api.colorMenu("cell"),
                menuLabel: "Shading colors",
              },
            ],
          },
        ],
      },
    ],
  };
  function tableFlag(key, label) {
    return {
      type: "check",
      id: `table-${key}`,
      label,
      checked: () => api.tableFlag(key),
      commit: (on) => api.setTableFlag(key, on),
    };
  }
  const tableLayout = {
    id: "table-layout",
    label: "Layout",
    contextual: true,
    visible: tableSel,
    groups: [
      {
        id: "rows-columns",
        label: "Rows & Columns",
        icon: "insertBelow",
        items: [
          {
            type: "large",
            id: "table-delete",
            label: "Delete",
            icon: "deleteTable",
            title: "Delete Rows, Columns, or Table",
            menu: () => api.tableDeleteMenu(),
          },
          tableCommand(
            "insert-above",
            "Insert\nAbove",
            "insertAbove",
            "rowAbove",
          ),
          tableCommand(
            "insert-below",
            "Insert\nBelow",
            "insertBelow",
            "rowBelow",
          ),
          tableCommand("insert-left", "Insert\nLeft", "insertLeft", "colLeft"),
          tableCommand(
            "insert-right",
            "Insert\nRight",
            "insertRight",
            "colRight",
          ),
        ],
      },
      {
        id: "merge",
        label: "Merge",
        icon: "mergeCells",
        visible: () => !!api.mergeCells,
        items: [
          {
            type: "large",
            id: "merge-cells",
            label: "Merge\nCells",
            icon: "mergeCells",
            enabled: () => !!api.canMergeCells?.(),
            run: () => api.mergeCells?.(),
          },
          {
            type: "large",
            id: "split-cells",
            label: "Split\nCells",
            icon: "splitCells",
            enabled: () => !!api.canSplitCells?.(),
            run: () => api.splitCells?.(),
          },
        ],
      },
      {
        id: "cell-size",
        label: "Cell Size",
        icon: "distributeRows",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "distribute-rows",
                label: "Distribute Rows",
                icon: "distributeRows",
                run: () => api.distributeTable("rows"),
              },
              {
                type: "small",
                id: "distribute-columns",
                label: "Distribute Columns",
                icon: "distributeColumns",
                run: () => api.distributeTable("cols"),
              },
            ],
          },
        ],
      },
      {
        id: "table-alignment",
        label: "Alignment",
        icon: "alignCenter",
        items: [
          {
            type: "stack",
            rows: 2,
            items: [
              {
                type: "row",
                items: [
                  align("left", "Align Left", "alignLeft", `${M(api)}+L`),
                  align("center", "Center", "alignCenter", `${M(api)}+E`),
                  align("right", "Align Right", "alignRight", `${M(api)}+R`),
                ],
              },
              {
                type: "row",
                items: [
                  anchor("top", "Align Top", "valignTop"),
                  anchor("center", "Center Vertically", "valignMiddle"),
                  anchor("bottom", "Align Bottom", "valignBottom"),
                ],
              },
            ],
          },
        ],
      },
      { ...arrangeGroup, id: "table-arrange" },
    ],
  };
  function tableCommand(id, label, icon, where) {
    return {
      type: "large",
      id: `table-${id}`,
      label,
      icon,
      title: label,
      run: () => api.tableInsert(where),
    };
  }
  function anchor(value, label, icon) {
    return {
      type: "toggle",
      id: `anchor-${value}`,
      label,
      showLabel: false,
      icon,
      title: label,
      enabled: () => !!text(),
      pressed: () => api.anchor() === value,
      run: () => api.setAnchor(value),
    };
  }

  // Tabs from other modules join after the tab they name, or with the
  // contextual tabs at the end.
  const extra = api.extraTabs ? api.extraTabs() : [];
  const tabs = [home, insert, design, transitions, slideShow, review, viewTab];
  for (const t of extra.filter((t) => !t.contextual)) {
    const at = tabs.findIndex((x) => x.id === t.after);
    tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, t);
  }
  tabs.push(
    shapeFormat,
    pictureFormat,
    tableDesign,
    tableLayout,
    ...extra.filter((t) => t.contextual),
  );
  return tabs;
}
