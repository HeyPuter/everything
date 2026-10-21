/**
 * Plain text, HTML and RTF from an export document model (see export-layout.js).
 *
 *   writeText(model) -> string   reading order; tables as tab-separated rows; "\f" between pages
 *   writeHtml(model, { title }) -> string   semantic headings, paragraphs, lists, tables, images
 *   writeRtf(model) -> string   paragraphs, headings, tables, pictures and per-page sections
 */
import { xml } from './ooxml-zip.js';

const plain = (runs) => runs.map((r) => (r.tab ? '\t' : r.text)).join('');

function markerText(list, counters) {
  if (list.kind === 'bullet') return '•';
  const key = `${list.instance}:${list.level}`;
  const value = counters.has(key) ? counters.get(key) + 1 : list.start || 1;
  counters.set(key, value);
  const format = (n) => {
    switch (list.kind) {
      case 'lowerLetter':
        return String.fromCharCode(96 + (((n - 1) % 26) + 1));
      case 'upperLetter':
        return String.fromCharCode(64 + (((n - 1) % 26) + 1));
      case 'lowerRoman':
        return roman(n).toLowerCase();
      case 'upperRoman':
        return roman(n);
      default:
        return String(n);
    }
  };
  return (list.pattern || '%1.').replace('%1', format(value));
}

function roman(n) {
  const table = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  for (const [value, letters] of table)
    while (n >= value) {
      out += letters;
      n -= value;
    }
  return out;
}

const tableRows = (block) =>
  block.rows.map((row) => {
    const cells = [];
    for (const cell of row.cells) {
      cells.push(cell.paragraphs.map((p) => plain(p.runs).replace(/\t/g, ' ')).join(' '));
      for (let k = 1; k < cell.span; k++) cells.push('');
    }
    return cells.join('\t').replace(/\t+$/, '');
  });

export function writeText(model) {
  const counters = new Map();
  return model.pages
    .map((page) => {
      const lines = [];
      let previous = null;
      for (const block of [...page.header, ...page.blocks, ...page.footer]) {
        if (
          previous &&
          (block.type !== 'paragraph' ||
            previous.type !== 'paragraph' ||
            block.heading ||
            (block.gapAbove ?? 0) > (block.size || 10) * 0.6)
        )
          lines.push('');
        if (block.type === 'paragraph') {
          const indent = block.list ? '  '.repeat(block.list.level || 0) : '';
          const marker = block.list ? markerText(block.list, counters) + ' ' : '';
          lines.push(indent + marker + plain(block.runs));
        } else if (block.type === 'table') lines.push(...tableRows(block));
        else continue;
        previous = block;
      }
      return lines.join('\n');
    })
    .join('\n\f');
}

/* ---------------------------------------------------------------- HTML */

const base64 = (bytes) => {
  if (typeof Buffer === 'function')
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

function htmlRuns(runs, body) {
  return runs
    .map((run) => {
      if (run.tab) return '<span class="tab">\t</span>';
      if (!run.text) return '';
      let out = xml(run.text);
      const style = [];
      if (run.color && run.color !== '000000') style.push(`color:#${run.color}`);
      if (run.font && run.font !== body.font)
        style.push(`font-family:'${run.font.replace(/'/g, '')}'`);
      if (run.size && Math.abs(run.size - body.size) > 0.6 && !run.script)
        style.push(`font-size:${Math.round(run.size * 10) / 10}pt`);
      if (run.script === 'superscript') out = `<sup>${out}</sup>`;
      if (run.script === 'subscript') out = `<sub>${out}</sub>`;
      if (run.strike) out = `<s>${out}</s>`;
      if (run.underline) out = `<u>${out}</u>`;
      if (run.italic) out = `<em>${out}</em>`;
      if (run.bold) out = `<strong>${out}</strong>`;
      if (style.length) out = `<span style="${style.join(';')}">${out}</span>`;
      return out;
    })
    .join('');
}

function htmlParagraph(block, body) {
  const style = [];
  if (block.align && block.align !== 'left') style.push(`text-align:${block.align}`);
  if (!block.list && block.indent > 2) style.push(`margin-left:${Math.round(block.indent)}pt`);
  if (!block.list && Math.abs(block.firstLine) > 2)
    style.push(`text-indent:${Math.round(block.firstLine)}pt`);
  const attr = style.length ? ` style="${style.join(';')}"` : '';
  // Heading runs need not repeat the heading's own bold weight.
  const runs = block.heading
    ? block.runs.map((r) => ({
        ...r,
        bold: false,
        size: 0,
        ...(r.tab ? { tab: false, text: ' ' } : {}),
      }))
    : block.runs;
  const content = htmlRuns(runs, body);
  if (block.heading) return `<h${block.heading}${attr}>${content}</h${block.heading}>`;
  return `<p${attr}>${content}</p>`;
}

function htmlTable(block, body) {
  let out = '<table>';
  for (const row of block.rows) {
    out += '<tr>';
    for (const cell of row.cells) {
      if (cell.merged) continue;
      const tag = row.header ? 'th' : 'td';
      const attrs = [];
      if (cell.span > 1) attrs.push(`colspan="${cell.span}"`);
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
      const style = [];
      if (cell.align && cell.align !== 'left') style.push(`text-align:${cell.align}`);
      if (cell.fill) style.push(`background:#${cell.fill}`);
      if (style.length) attrs.push(`style="${style.join(';')}"`);
      out += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${cell.paragraphs.map((p) => htmlRuns(p.runs, body)).join('<br>')}</${tag}>`;
    }
    out += '</tr>';
  }
  return out + '</table>';
}

function htmlImage(picture, w, h, block) {
  const style =
    block?.align === 'center'
      ? ' style="display:block;margin:0 auto"'
      : block?.align === 'right'
        ? ' style="display:block;margin-left:auto"'
        : '';
  return `<img src="data:${picture.mime};base64,${base64(picture.bytes)}" width="${Math.round(w)}" height="${Math.round(h)}" alt=""${style}>`;
}

export function writeHtml(model, { title = '' } = {}) {
  const { body } = model;
  let html = '';
  for (const page of model.pages) {
    html += `<section class="page" id="page-${page.index + 1}">`;
    if (page.header.length)
      html += `<header>${page.header.map((b) => htmlParagraph(b, body)).join('')}</header>`;
    const scanned = !page.blocks.length && page.images.length;
    if (scanned)
      for (const image of page.images)
        html += `<p>${htmlImage(image.picture, image.w, image.h)}</p>`;
    const stack = []; // open lists: { tag, level }
    const closeTo = (level) => {
      while (stack.length && stack.at(-1).level >= level) html += `</li></${stack.pop().tag}>`;
    };
    for (const block of page.blocks) {
      if (block.type === 'paragraph' && block.list) {
        const level = block.list.level || 0;
        const tag = block.list.kind === 'bullet' ? 'ul' : 'ol';
        // Back from a nested list, the list it sits in carries on with its numbering.
        closeTo(level + 1);
        const current = stack.at(-1);
        if (
          current &&
          current.level === level &&
          current.tag === tag &&
          current.instance === block.list.instance
        )
          html += '</li>';
        else {
          if (current && current.level === level) html += `</li></${stack.pop().tag}>`;
          const type = {
            lowerLetter: 'a',
            upperLetter: 'A',
            lowerRoman: 'i',
            upperRoman: 'I',
          }[block.list.kind];
          // A list carried on from the page before starts at the number its item shows.
          const first = block.list.value > 1 ? block.list.value : block.list.start;
          const start = tag === 'ol' && first > 1 ? ` start="${first}"` : '';
          html += `<${tag}${type ? ` type="${type}"` : ''}${start}>`;
          stack.push({ tag, level, instance: block.list.instance });
        }
        html += `<li>${htmlRuns(block.runs, body)}`;
        continue;
      }
      if (block.type === 'paragraph' && stack.length && block.indent > 8 && !block.heading) {
        html += `<br>${htmlRuns(block.runs, body)}`;
        continue;
      }
      closeTo(0);
      if (block.type === 'paragraph') html += htmlParagraph(block, body);
      else if (block.type === 'table') html += htmlTable(block, body);
      else if (block.type === 'image')
        html += `<figure>${htmlImage(block.picture, block.w, block.h, block)}</figure>`;
    }
    closeTo(0);
    if (page.footer.length)
      html += `<footer>${page.footer.map((b) => htmlParagraph(b, body)).join('')}</footer>`;
    html += '</section>\n';
  }
  const css =
    `body{font-family:'${body.font}',sans-serif;font-size:${body.size}pt;line-height:1.35;max-width:52em;margin:2em auto;padding:0 1em;color:#000}` +
    `section.page{margin-bottom:2em}section.page+section.page{border-top:1px solid #ccc;padding-top:1em}` +
    `header,footer{color:#666;font-size:0.85em}table{border-collapse:collapse;margin:0.6em 0}td,th{padding:2px 6px;vertical-align:top;border:1px solid #ddd}` +
    `th{text-align:left}figure{margin:0.6em 0}img{max-width:100%;height:auto}.tab{display:inline-block;min-width:2em}p{margin:0.35em 0}`;
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${xml(title || 'Document')}</title>\n<style>${css}</style>\n</head>\n<body>\n${html}</body>\n</html>\n`;
}

/* ---------------------------------------------------------------- RTF */

const rtfText = (text) =>
  String(text)
    .replace(/[\\{}]/g, (c) => '\\' + c)
    .replace(/\t/g, '\\tab ')
    .replace(/[^\x00-\x7f]/gu, (c) => {
      const code = c.codePointAt(0);
      if (code > 0xffff) {
        const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800,
          lo = ((code - 0x10000) % 0x400) + 0xdc00;
        return `\\u${hi - 65536}?\\u${lo - 65536}?`;
      }
      return `\\u${code > 32767 ? code - 65536 : code}?`;
    });

export function writeRtf(model) {
  const fonts = [model.body.font];
  const colors = ['000000'];
  const fontIndex = (name) => {
    if (!fonts.includes(name)) fonts.push(name);
    return fonts.indexOf(name);
  };
  const colorIndex = (hex) => {
    if (!colors.includes(hex)) colors.push(hex);
    return colors.indexOf(hex) + 1;
  };
  const tw = (pt) => Math.round(pt * 20);
  const runs = (list) =>
    list
      .map((r) => {
        if (r.tab) return '\\tab ';
        if (!r.text) return '';
        const props = [
          `\\f${fontIndex(r.font || model.body.font)}`,
          `\\fs${Math.max(2, Math.round((r.size || model.body.size) * 2))}`,
        ];
        if (r.bold) props.push('\\b');
        if (r.italic) props.push('\\i');
        if (r.underline) props.push('\\ul');
        if (r.strike) props.push('\\strike');
        if (r.script === 'superscript') props.push('\\super');
        if (r.script === 'subscript') props.push('\\sub');
        if (r.color && r.color !== '000000') props.push(`\\cf${colorIndex(r.color)}`);
        return `{${props.join('')} ${rtfText(r.text)}}`;
      })
      .join('');
  const counters = new Map();
  const hex = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, '0');
      if (i % 64 === 63) s += '\n';
    }
    return s;
  };
  let body = '';
  model.pages.forEach((page, k) => {
    const m = page.margins;
    body += `${k ? '\\sect' : ''}\\sectd\\sbkpage\\pgwsxn${tw(page.width)}\\pghsxn${tw(page.height)}${page.width > page.height ? '\\lndscpsxn' : ''}\\marglsxn${tw(m.left)}\\margrsxn${tw(m.right)}\\margtsxn${tw(m.top)}\\margbsxn${tw(m.bottom)}\n`;
    for (const block of page.blocks) {
      if (block.type === 'paragraph') {
        const align = { center: '\\qc', right: '\\qr', justify: '\\qj' }[block.align] || '\\ql';
        const before = Math.max(0, Math.min(72, block.gapAbove ?? 0));
        const outline = block.heading ? `\\outlinelevel${block.heading - 1}` : '';
        const marker = block.list ? `${markerText(block.list, counters)}\\tab ` : '';
        const indent = block.list
          ? `\\li${tw(block.indent)}\\fi${tw(block.firstLine || -18)}`
          : `\\li${tw(block.indent || 0)}\\fi${tw(block.firstLine || 0)}`;
        const tabs = block.tabs
          ? block.tabs
              .map(
                (t) =>
                  `${t.kind === 'right' ? '\\tqr' : t.kind === 'center' ? '\\tqc' : ''}\\tx${tw(t.pos)}`,
              )
              .join('')
          : '';
        body += `\\pard\\plain${outline}${align}${indent}\\sb${tw(before)}\\sa0${tabs} ${marker ? `{\\f0 ${marker}}` : ''}${runs(block.runs)}\\par\n`;
      } else if (block.type === 'table') {
        for (const row of block.rows) {
          let def = `\\trowd\\trgaph43\\trleft${tw(Math.max(0, block.columns[0] - (block.column?.x0 ?? block.columns[0])))}`;
          for (const cell of row.cells) {
            if (block.ruled)
              def +=
                '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
            if (cell.rowSpan > 1) def += '\\clvmgf';
            if (cell.merged) def += '\\clvmrg';
            if (cell.fill) def += `\\clcbpat${colorIndex(cell.fill)}`;
            def += `\\cellx${tw(block.columns[cell.col + cell.span] - (block.column?.x0 ?? block.columns[0]))}`;
          }
          body += def + '\n';
          for (const cell of row.cells) {
            const align = { center: '\\qc', right: '\\qr' }[cell.align] || '\\ql';
            body += `\\pard\\plain\\intbl${align} ${cell.paragraphs.map((p) => runs(p.runs)).join('\\line ')}\\cell\n`;
          }
          body += '\\row\n';
        }
        body += '\\pard\\plain\\par\n';
      } else if (block.type === 'image') {
        const p = block.picture;
        const blip = p.mime === 'image/png' ? '\\pngblip' : '\\jpegblip';
        const align = { center: '\\qc', right: '\\qr' }[block.align] || '\\ql';
        body += `\\pard\\plain${align}{\\pict${blip}\\picw${p.width || 1}\\pich${p.height || 1}\\picwgoal${tw(block.w)}\\pichgoal${tw(block.h)}\n${hex(p.bytes)}}\\par\n`;
      }
    }
  });
  const fontTable = fonts.map((f, i) => `{\\f${i}\\fnil ${rtfText(f)};}`).join('');
  const colorTable =
    ';' +
    colors
      .map(
        (c) =>
          `\\red${parseInt(c.slice(0, 2), 16)}\\green${parseInt(c.slice(2, 4), 16)}\\blue${parseInt(c.slice(4, 6), 16)};`,
      )
      .join('');
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl${fontTable}}{\\colortbl${colorTable}}\\viewkind4\n${body}}`;
}
