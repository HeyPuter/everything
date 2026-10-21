import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { parseContent, matrix, decode, pageSource, uniqueName } from './text-edit.js';
import { inverse, invertible, imageCorners, rewriteOccurrence } from './image-edit.js';

const identity = [1, 0, 0, 1, 0, 0];
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const numbers = (array) => array?.asArray?.().map((n) => n.asNumber?.());
const num = (n) => PDFNumber.of(n).toString();
const paint = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const pathOps = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const strokeOps = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const fillOps = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const fits = (transform, clips) =>
  clips.every((clip) =>
    imageCorners(matrix(clip.inverse, transform)).every(
      ([x, y]) =>
        x >= clip.rect[0] - 1e-6 &&
        x <= clip.rect[2] + 1e-6 &&
        y >= clip.rect[1] - 1e-6 &&
        y <= clip.rect[3] + 1e-6,
    ),
  );

// Only our explicit hint makes an unpainted path an editable object. Ordinary PDF
// end-path and clipping commands must not become selectable objects.
function pathHint(args) {
  if (args[0]?.value !== 'PuterPath' || args[1]?.type !== 'dict') return null;
  const tokens = args[1].value,
    data = Object.create(null);
  if (tokens.length !== 6) return null;
  for (let i = 0; i < tokens.length; i += 2) {
    if (tokens[i].type !== 'name' || Object.hasOwn(data, tokens[i].value)) return null;
    data[tokens[i].value] = tokens[i + 1];
  }
  if (
    data.V?.type !== 'number' ||
    data.V.value !== 1 ||
    data.Kind?.type !== 'name' ||
    !['Shape', 'Drawing'].includes(data.Kind.value) ||
    data.Rule?.type !== 'name' ||
    !['NonZero', 'EvenOdd'].includes(data.Rule.value)
  )
    return null;
  return {
    kind: data.Kind.value.toLowerCase(),
    fillRule: data.Rule.value === 'EvenOdd' ? 'evenodd' : 'nonzero',
  };
}

/** Index complete paths, including retained unpainted paths, without crossing state changes. */
export function inspectPaths(doc, index) {
  const paths = [];
  function walk(source, resources, initial, ancestry = [], ancestors = new Set()) {
    const first = paths.length;
    try {
      if (ancestry.length > 20) return;
      let state = { ...initial },
        commands = [],
        startState,
        pendingClip = false,
        eligible = true;
      const stack = [],
        marked = [];
      for (const command of parseContent(source, { inlineImages: true })) {
        const op = command.op,
          a = command.args.map((t) => t.value);
        if (pathOps.has(op)) {
          if (!commands.length) startState = { ...state };
          commands.push(command);
          continue;
        }
        if (op === 'W' || op === 'W*') {
          pendingClip = true;
          continue;
        }
        if (paint.has(op) || op === 'n') {
          if (
            commands.length &&
            eligible &&
            !pendingClip &&
            !state.textDecoration &&
            (paint.has(op) || state.ownPath)
          ) {
            const entry = describePath(commands, command, startState, resources, source, ancestry);
            if (entry) {
              entry.ordinal = paths.length;
              paths.push(entry);
            }
          }
          if (pendingClip) {
            if (commands.length === 1 && commands[0].op === 're' && invertible(startState.ctm)) {
              const [x, y, w, h] = commands[0].args.map((t) => t.value);
              state.clips = [
                ...state.clips,
                {
                  rect: [
                    Math.min(x, x + w),
                    Math.min(y, y + h),
                    Math.max(x, x + w),
                    Math.max(y, y + h),
                  ],
                  inverse: inverse(startState.ctm),
                },
              ];
            } else state.unsafe = true;
          }
          commands = [];
          pendingClip = false;
          eligible = true;
          continue;
        }
        if (commands.length) eligible = false;
        if (op === 'q') stack.push({ ...state });
        else if (op === 'Q') {
          if (!stack.length) throw new Error('Unbalanced path state');
          state = stack.pop();
        } else if (op === 'cm') state.ctm = matrix(state.ctm, a);
        else if (op === 'w') state.width = a[0];
        else if (op === 'J') state.cap = a[0];
        else if (op === 'j') state.join = a[0];
        else if (op === 'M') state.miter = a[0];
        else if (op === 'd') state.dash = source.slice(command.start, command.end);
        else if (['G', 'RG', 'K'].includes(op))
          state.stroke = source.slice(command.start, command.end);
        else if (['g', 'rg', 'k'].includes(op))
          state.fill = source.slice(command.start, command.end);
        else if (['CS', 'cs', 'SC', 'sc', 'SCN', 'scn'].includes(op)) state.unsafe = true;
        else if (op === 'Tr') state.textClip = a[0] >= 4;
        else if (op === 'ET' && state.textClip) state.unsafe = true;
        else if (op === 'BDC' || op === 'BMC') {
          marked.push({
            optional: state.optional,
            ownPath: state.ownPath,
            textDecoration: state.textDecoration,
          });
          state.optional ||= a[0] === 'OC';
          state.textDecoration ||= a[0] === 'PuterTextDecoration';
          if (a[0] === 'PuterPath') state.ownPath = pathHint(command.args);
        } else if (op === 'EMC') {
          const previous = marked.pop();
          state.optional = previous?.optional ?? false;
          state.ownPath = previous?.ownPath;
          state.textDecoration = previous?.textDecoration;
        } else if (op === 'gs') {
          const gs = get(get(resources, 'ExtGState'), a[0]);
          if (!gs) {
            state.unsafe = true;
            continue;
          }
          const mask = get(gs, 'SMask');
          if (mask) state.softMask = mask.toString() !== '/None';
          state.width = get(gs, 'LW')?.asNumber?.() ?? state.width;
          state.cap = get(gs, 'LC')?.asNumber?.() ?? state.cap;
          state.join = get(gs, 'LJ')?.asNumber?.() ?? state.join;
          state.miter = get(gs, 'ML')?.asNumber?.() ?? state.miter;
          const dash = get(gs, 'D');
          if (dash) state.dash = `${dash.get(0)} ${dash.get(1)} d`;
          state.alpha = get(gs, 'ca')?.asNumber?.() ?? state.alpha;
          state.strokeAlpha = get(gs, 'CA')?.asNumber?.() ?? state.strokeAlpha;
          state.blend = get(gs, 'BM')?.decodeText?.() ?? state.blend;
        } else if (op === 'Do') {
          const form = get(get(resources, 'XObject'), a[0]);
          if (get(form?.dict, 'Subtype')?.toString() !== '/Form') continue;
          if (ancestors.has(form)) throw new Error('Recursive form');
          const ctm = matrix(state.ctm, numbers(get(form.dict, 'Matrix')) || identity),
            bbox = numbers(get(form.dict, 'BBox'));
          // Collapsed forms have no editable geometry. Their singular transform
          // must not discard the supported paths around the invocation.
          if (!invertible(ctm)) continue;
          walk(
            decode(form),
            get(form.dict, 'Resources') || resources,
            {
              ...state,
              ctm,
              optional: state.optional || !!get(form.dict, 'OC'),
              clips:
                bbox?.length === 4
                  ? [...state.clips, { rect: bbox, inverse: inverse(ctm) }]
                  : state.clips,
            },
            [
              ...ancestry,
              {
                start: command.start,
                end: command.end,
                name: a[0],
                source: source.slice(command.start, command.end),
              },
            ],
            new Set([...ancestors, form]),
          );
        }
      }
    } catch {
      paths.splice(first);
    }
  }
  const page = doc.getPage(index);
  walk(pageSource(page), page.node.Resources(), {
    ctm: identity,
    clips: [],
    width: 1,
    cap: 0,
    join: 0,
    miter: 10,
    dash: '[] 0 d',
    stroke: '0 G',
    fill: '0 g',
    alpha: 1,
    strokeAlpha: 1,
    blend: 'Normal',
  });
  return paths;
}

function describePath(commands, end, state, resources, source, ancestry) {
  const points = [],
    svg = [];
  let current = [0, 0],
    first = current,
    pointCount = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  // Calculate bounds while reading geometry. Only a rectangle's first four
  // corners need retaining; large paths need no second coordinate collection.
  const includePoint = (x, y) => {
    pointCount++;
    if (points.length < 4) points.push([x, y]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const command of commands) {
    const a = command.args.map((t) => t.value);
    if (!a.every(Number.isFinite)) return null;
    if (command.op === 're') {
      const [x, y, w, h] = a;
      includePoint(x, y);
      includePoint(x + w, y + h);
      svg.push(`M ${x} ${y} h ${w} v ${h} h ${-w} Z`);
      current = first = [x, y];
    } else if (command.op === 'h') {
      svg.push('Z');
      current = first;
    } else {
      let coords = a;
      if (command.op === 'v') coords = [...current, ...a];
      if (command.op === 'y') coords = [...a, ...a.slice(-2)];
      svg.push(`${command.op === 'm' ? 'M' : command.op === 'l' ? 'L' : 'C'} ${coords.join(' ')}`);
      for (let i = 0; i < coords.length; i += 2) includePoint(coords[i], coords[i + 1]);
      current = coords.slice(-2);
      if (command.op === 'm') first = current;
    }
  }
  if (!points.length) return null;
  if (['s', 'b', 'b*'].includes(end.op)) svg.push('Z');
  const stroked = strokeOps.has(end.op),
    filled = fillOps.has(end.op);
  const rectangle =
    (commands.length === 1 && commands[0].op === 're') ||
    (commands.map((c) => c.op).join(' ') === 'm l l l h' &&
      pointCount === 4 &&
      points.every((p, i) => {
        const next = points[(i + 1) % 4];
        return p[0] === next[0] || p[1] === next[1];
      }));
  const pad = stroked
    ? Math.max(0.25, state.width / 2) *
      (state.join === 0 && !rectangle ? Math.max(1, state.miter) : 1)
    : 0;
  const bounds = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  const degenerate = minX === maxX || minY === maxY;
  if (state.ownPath) {
    for (const axis of [0, 1])
      if (bounds[axis + 2] === bounds[axis]) {
        bounds[axis] -= 0.25;
        bounds[axis + 2] += 0.25;
      }
  }
  if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return null;
  const local = [bounds[2] - bounds[0], 0, 0, bounds[3] - bounds[1], bounds[0], bounds[1]],
    transform = matrix(state.ctm, local);
  const start = commands[0].start;
  return {
    kind:
      state.ownPath?.kind ||
      (filled || rectangle || commands.some((c) => c.op === 'h') ? 'shape' : 'drawing'),
    id: [...ancestry.map((p) => p.start), start].join(':'),
    start,
    end: end.end,
    source: source.slice(start, end.end),
    path: ancestry,
    transform,
    ctm: state.ctm,
    local,
    bounds,
    resources,
    state,
    svg: svg.join(' '),
    stroked,
    filled,
    fillRule: filled
      ? end.op.includes('*')
        ? 'evenodd'
        : 'nonzero'
      : state.ownPath?.fillRule || 'nonzero',
    invisible: !((stroked && state.strokeAlpha > 0) || (filled && !degenerate && state.alpha > 0)),
    opacity: 1,
    blend: state.blend,
    clips: state.clips,
    editable:
      !state.unsafe &&
      !state.optional &&
      !state.softMask &&
      ((stroked && state.strokeAlpha > 0) || (filled && state.alpha > 0) || state.ownPath) &&
      transform.every(Number.isFinite) &&
      Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) > 1e-10 &&
      fits(transform, state.clips),
  };
}

export function pathColorHex(command) {
  const { op, args } = parseContent(command)[0],
    values = args.map((a) => a.value);
  const rgb =
    op.toLowerCase() === 'g'
      ? [values[0], values[0], values[0]]
      : op.toLowerCase() === 'k'
        ? values.slice(0, 3).map((v) => 1 - Math.min(1, v + values[3]))
        : values;
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function editPath(
  doc,
  index,
  entry,
  { transform = entry.transform, remove = false, style = {} } = {},
) {
  const current = inspectPaths(doc, index).find((p) => p.id === entry.id);
  if (
    !entry.editable ||
    !current?.editable ||
    current.source !== entry.source ||
    current.transform.some((n, i) => Math.abs(n - entry.transform[i]) > 1e-7)
  )
    throw new Error('This drawing changed or cannot yet be edited. Select it again.');
  inverse(transform);
  if (!remove && !fits(transform, entry.clips))
    throw new Error('Keep the drawing inside its original frame.');
  for (const key of ['filled', 'stroked'])
    if (style[key] !== undefined && typeof style[key] !== 'boolean')
      throw new Error('Choose whether the fill or stroke is enabled.');
  const filled = style.filled ?? entry.filled,
    stroked = style.stroked ?? entry.stroked;
  const changedPaint = filled !== entry.filled || stroked !== entry.stroked;
  let source = entry.source;
  const commands = [];
  const nextState = { ...entry.state, ctm: matrix(transform, inverse(entry.local)) };
  for (const [key, painted, operator] of [
    ['stroke', stroked, 'RG'],
    ['fill', filled, 'rg'],
  ]) {
    const hex = style[key];
    if (hex === undefined) continue;
    if (!painted || !/^#[0-9a-f]{6}$/i.test(hex))
      throw new Error('Choose a valid color for this path.');
    if (hex.toLowerCase() === pathColorHex(entry.state[key])) continue;
    const command =
      hex
        .slice(1)
        .match(/../g)
        .map((v) => num(parseInt(v, 16) / 255))
        .join(' ') +
      ' ' +
      operator;
    nextState[key] = command;
    commands.push(command);
  }
  if (style.width !== undefined) {
    if (!stroked || !Number.isFinite(style.width) || style.width < 0 || style.width > 10000)
      throw new Error('Choose a stroke width between 0 and 10000 points.');
    if (Math.abs(style.width - entry.state.width) > 1e-8) {
      nextState.width = style.width;
      commands.push(`${num(style.width)} w`);
    }
  }
  const opacity = {};
  for (const [key, painted, stateKey, pdfKey] of [
    ['fillOpacity', filled, 'alpha', 'ca'],
    ['strokeOpacity', stroked, 'strokeAlpha', 'CA'],
  ]) {
    const value = style[key];
    if (value === undefined) continue;
    if (!painted || !Number.isFinite(value) || value < 0 || value > 1)
      throw new Error('Choose an opacity between 0 and 100 percent.');
    if (Math.abs(value - entry.state[stateKey]) > 1e-8) {
      nextState[stateKey] = value;
      opacity[pdfKey] = value;
    }
  }
  const changedOpacity = Object.keys(opacity).length > 0;
  // Retain fully transparent paths so opacity can be restored after reopening.
  if (changedPaint || changedOpacity)
    nextState.ownPath = { kind: entry.kind, fillRule: entry.fillRule };
  if (changedPaint) {
    const end = parseContent(source).at(-1);
    // Lower-case paint operators close the last subpath; retain that geometry when
    // changing paint modes. Filling alone must not close an originally open stroke.
    source =
      source.slice(0, end.start) +
      (['s', 'b', 'b*'].includes(end.op) ? 'h\n' : '') +
      (filled
        ? (stroked ? 'B' : 'f') + (entry.fillRule === 'evenodd' ? '*' : '')
        : stroked
          ? 'S'
          : 'n');
  }
  if (!remove && (commands.length || changedPaint || changedOpacity)) {
    const pathCommands = parseContent(source),
      end = pathCommands.pop();
    const next = describePath(pathCommands, end, nextState, entry.resources, source, entry.path);
    if (!next?.editable) throw new Error('Keep the stroke inside its original frame.');
  }
  if (
    !remove &&
    !commands.length &&
    !changedPaint &&
    !changedOpacity &&
    transform.every((n, i) => Math.abs(n - entry.transform[i]) < 1e-8)
  )
    return false;
  if (changedPaint || changedOpacity)
    source = `/PuterPath << /V 1 /Kind /${entry.kind === 'shape' ? 'Shape' : 'Drawing'} /Rule /${entry.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero'} >> BDC\n${source}\nEMC`;
  const states = get(entry.resources, 'ExtGState') || doc.context.obj({});
  const opacityName = changedOpacity && !remove ? uniqueName(states, 'PathOpacity') : null;
  if (opacityName) commands.push(`${opacityName} gs`);
  const local = matrix(matrix(inverse(entry.ctm), transform), inverse(entry.local));
  rewriteOccurrence(
    doc,
    index,
    entry,
    remove ? 'n' : `q\n${local.map(num).join(' ')} cm\n${commands.join('\n')}\n${source}\nQ`,
    opacityName
      ? (resources) => {
          const copy = states.clone(doc.context);
          copy.set(opacityName, doc.context.obj({ Type: 'ExtGState', ...opacity }));
          resources.set(PDFName.of('ExtGState'), copy);
        }
      : undefined,
  );
}

export async function pathPreview(doc, entry) {
  const preview = await PDFDocument.create(),
    s = entry.state;
  const w = entry.bounds[2] - entry.bounds[0],
    h = entry.bounds[3] - entry.bounds[1],
    scale = Math.min(2, 1200 / Math.max(w, h));
  const page = preview.addPage([w * scale, h * scale]);
  // Supported path blocks use only geometry and device colors, so no page assets are needed.
  const resources = preview.context.obj({});
  const states = preview.context.obj({
    Preview: { Type: 'ExtGState', ca: s.alpha, CA: s.strokeAlpha, BM: 'Normal' },
  });
  resources.set(PDFName.of('ExtGState'), states);
  page.node.set(PDFName.of('Resources'), resources);
  const commands = `q ${scale} 0 0 ${scale} ${-entry.bounds[0] * scale} ${-entry.bounds[1] * scale} cm /Preview gs ${s.width} w ${s.cap} J ${s.join} j ${s.miter} M ${s.dash} ${s.stroke} ${s.fill}\n${entry.source}\nQ`;
  page.node.set(
    PDFName.of('Contents'),
    preview.context.register(preview.context.flateStream(commands)),
  );
  return preview.save();
}
