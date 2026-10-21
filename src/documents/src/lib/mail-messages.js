/**
 * Email messages from merged documents: an HTML and a plain-text body built from the document
 * model's paragraphs, and standard MIME (.eml) files for mail clients when sending directly is not
 * available.
 */

const escape = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Hidden text is neither shown nor printed, so a merged message leaves it out too.
const paragraphText = p => p.runs.map(r => r.vanish ? '' : r.text).join('');

/** Plain text of a model: line breaks as newlines, objects dropped. */
export function plainText(model) {
  return model.paragraphs.map(paragraphText).join('\n').replace(/\v/g, '\n').replace(/[\f\u000e]/g, '\n\n').replace(/￼/g, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function runHtml(run) {
  if (!run.text || run.image || run.vanish) return '';
  let text = escape(run.text.replace(/￼/g, '')).replace(/\v/g, '<br>').replace(/\t/g, '&emsp;');
  if (!text) return '';
  const style = [];
  if (run.color && run.color !== 'auto') style.push(`color:#${run.color}`);
  if (run.fontSize && run.fontSize !== 12) style.push(`font-size:${run.fontSize}pt`);
  if (style.length) text = `<span style="${style.join(';')}">${text}</span>`;
  if (run.underline || (run.underlineStyle && run.underlineStyle !== 'none')) text = `<u>${text}</u>`;
  if (run.italic) text = `<i>${text}</i>`;
  if (run.bold) text = `<b>${text}</b>`;
  const target = run.link?.target;
  if (target && /^(https?:|mailto:)/i.test(target)) text = `<a href="${escape(target)}">${text}</a>`;
  return text;
}
const paragraphHtml = p => {
  const align = p.format?.alignment && p.format.alignment !== 'left' ? ` style="text-align:${p.format.alignment === 'both' ? 'justify' : p.format.alignment}"` : '';
  return `<p${align}>${p.runs.map(runHtml).join('') || '&nbsp;'}</p>`;
};

/** HTML for a model: paragraphs with basic character formatting, and tables as tables. */
export function documentHtml(model) {
  const out = [], done = new Set();
  for (const p of model.paragraphs) {
    if (!p.cellId) { out.push(paragraphHtml(p)); continue; }
    const table = model.tables.find(t => t.rows.some(r => r.cells.some(c => c.id === p.cellId)));
    if (!table || done.has(table.id)) continue;
    done.add(table.id);
    const cell = id => model.paragraphs.filter(q => q.cellId === id).map(paragraphHtml).join('');
    out.push(`<table style="border-collapse:collapse">${table.rows.map(row => `<tr>${row.cells.filter(c => c.vMerge !== 'continue').map(c => `<td style="padding:4px 8px;vertical-align:top"${c.span > 1 ? ` colspan="${c.span}"` : ''}>${cell(c.id)}</td>`).join('')}</tr>`).join('')}</table>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:12pt">${out.join('\n')}</body></html>`;
}

const base64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/.{1,76}/g, '$&\r\n').trimEnd();
};
/** A header value: plain ASCII stays readable; anything else is RFC 2047 encoded. */
const header = text => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64(text).replace(/\r\n/g, '')}?=`;
const address = text => String(text || '').replace(/[\r\n<>]/g, '').trim();

/** An unsent message as an .eml file (RFC 5322 with MIME parts). */
export function emlMessage({ to, subject = '', text = '', html = null, from = '', date = new Date() }) {
  const boundary = `----=_documents_${Math.random().toString(36).slice(2)}`;
  const lines = [
    ...(from ? [`From: ${address(from)}`] : []),
    `To: ${address(to)}`,
    `Subject: ${header(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'X-Unsent: 1',
  ];
  if (!html) return [...lines, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(text), ''].join('\r\n');
  return [...lines, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(html),
    `--${boundary}--`, ''].join('\r\n');
}

/** A safe file name for a message to an address. */
export const emlName = (index, to) => `${String(index).padStart(3, '0')} ${String(to || 'message').replace(/[^\w.@+-]+/g, '_').slice(0, 60)}.eml`;

export const EMAIL_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
