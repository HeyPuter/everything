// Light Markdown for assistant replies, built as DOM nodes (never HTML text):
// paragraphs, bullet and numbered lists, fenced code, `code`, **bold** and *italic*.

function inline(text: string): Node[] {
  const out: Node[] = [];
  // _emphasis_ only between word boundaries, so names like hole_dia keep their underscores.
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_\n]*_(?![\p{L}\p{N}_]))/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    let el: HTMLElement;
    if (t.startsWith('`')) { el = document.createElement('code'); el.textContent = t.slice(1, -1); }
    else if (t.startsWith('**')) { el = document.createElement('strong'); el.append(...inline(t.slice(2, -2))); }
    else { el = document.createElement('em'); el.textContent = t.slice(1, -1); }
    out.push(el);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let listEl: HTMLElement | null = null;
  const flush = () => {
    if (para.length) {
      const p = document.createElement('p');
      para.forEach((l, i) => { if (i) p.append(document.createElement('br')); p.append(...inline(l)); });
      frag.append(p);
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      listEl = null;
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      frag.append(pre);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const tag = bullet ? 'UL' : 'OL';
      const li = document.createElement('li');
      li.append(...inline(bullet ? bullet[1] : numbered![2]));
      // A list that starts again (after a blank line or a paragraph) keeps its numbering.
      const list = () => { const l = document.createElement(tag.toLowerCase()); if (numbered && numbered[1] !== '1') l.setAttribute('start', String(Number(numbered[1]))); return l; };
      // An indented item goes in a list inside the item above it, so the outer numbering carries on.
      const parent = /^\s{2,}/.test(line) ? listEl?.lastElementChild : null;
      if (parent) {
        let sub = parent.lastElementChild;
        if (!sub || sub.tagName !== tag) { sub = list(); parent.append(sub); }
        sub.append(li);
        continue;
      }
      if (!listEl || listEl.tagName !== tag) { listEl = list(); frag.append(listEl); }
      listEl.append(li);
      continue;
    }
    if (!line.trim()) { flush(); listEl = null; continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      listEl = null;
      const h = document.createElement('p');
      const b = document.createElement('strong');
      b.append(...inline(heading[1]));
      h.append(b);
      frag.append(h);
      continue;
    }
    listEl = null;
    para.push(line);
  }
  flush();
  return frag;
}
