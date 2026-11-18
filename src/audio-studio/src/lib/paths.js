// Puter paths use slash-separated components, independently of the host OS.
export function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !path.startsWith('/')) parts.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
}

export function relativePath(dir, path) {
  const from = normalizePath(dir).split('/');
  const to = normalizePath(path).split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...from.slice(common).filter(Boolean).map(() => '..'), ...to.slice(common)].join('/');
}
