import { error, isObject, number } from './shared.js';

const levels = { see: 0, list: 1, read: 2, write: 3, manage: 4 };
const under = (path, root) => path === root || path.startsWith(root + '/');
export function createFs(env, ctx) {
  if (!env.fsPath) {
    env.fsPath = (caller, input) => {
      if (env.files.has(input)) return env.files.get(input).path;
      let path = String(input ?? '');
      const username = env.users.get(caller.uid)?.username;
      if (path === '~' || path.startsWith('~/')) path = `/${username}/${path.slice(2)}`;
      else if (!path.startsWith('/')) path = `/${username}/AppData/${caller.appUid}/${path}`;
      const segments = [];
      for (const part of path.split('/')) {
        if (part === '..') segments.pop();
        else if (part && part !== '.') segments.push(part);
      }
      return '/' + segments.join('/');
    };
    env.fsNode = (caller, input) => env.files.get(input) ?? [...env.files.values()].find(n => n.path === env.fsPath(caller, input));
    env.fsPermission = (caller, node, mode) => {
      if (!node || !caller.uid) return false;
      if (caller.restricted) {
        const token = env.readTokens.get(caller.restricted);
        return token && !token.revoked && token.expires > env.now() && token.uid === node.uid && ['read', 'list', 'see'].includes(mode) && env.fsPermission(token.ctx, node, 'read');
      }
      if (node.appUid !== caller.appUid) return false;
      if (caller.uid === node.owner) return true;
      return [...env.fileShares.values()].some(s => s.recipient === caller.uid && s.appUid === caller.appUid && levels[s.mode] >= levels[mode] && under(node.path, env.files.get(s.uid)?.path ?? '\u0000'));
    };
    env.readURL = async url => {
      const parsed = new URL(url);
      const token = env.readTokens.get(parsed.searchParams.get('token'));
      const node = token && env.files.get(parsed.searchParams.get('uid'));
      if (!token || token.revoked || token.expires <= env.now() || !node || (token.uid !== node.uid && !token.uids?.includes(node.uid)) || (!token.signed && !env.fsPermission(token.ctx, node, 'read'))) throw error('permission_denied', 403);
      env.charge(token.ctx, { fsReadOps: 1, egressBytes: node.data?.size ?? 0 });
      return new Response(node.data);
    };
  }
  const appRoot = () => env.fsPath(ctx, '');
  const stat = node => ({ uid: node.uid, path: node.path, name: node.path.split('/').at(-1), is_dir: node.is_dir, size: node.data?.size ?? 0, owner: { uuid: node.owner, username: env.users.get(node.owner)?.username }, is_shared: ctx.uid === node.owner ? [...env.fileShares.values()].some(s => under(node.path, env.files.get(s.uid)?.path ?? '\u0000')) : null, created: node.created, modified: node.modified });
  const check = (input, mode) => {
    const node = env.fsNode(ctx, input);
    if (!node) throw error('subject_does_not_exist', 404);
    if (!env.fsPermission(ctx, node, mode)) throw error('permission_denied', 403);
    return node;
  };
  const makeNode = (path, is_dir, owner = ctx.uid, data = null) => {
    const node = { uid: env.uuid(), path, appUid: ctx.appUid, is_dir, owner, data, created: env.now(), modified: env.now() };
    env.files.set(node.uid, node);
    return node;
  };
  if (ctx.uid && !env.fsNode(ctx, appRoot())) makeNode(appRoot(), true);
  const writableParent = (path, createParents = false) => {
    const parentPath = path.slice(0, path.lastIndexOf('/'));
    if (!parentPath.includes(`/AppData/${ctx.appUid}`)) throw error('permission_denied', 403);
    let parent = env.fsNode(ctx, parentPath);
    if (!parent && createParents) {
      const root = writableParent(parentPath, true);
      parent = makeNode(parentPath, true, root.owner);
    }
    if (!parent || !parent.is_dir) throw error('subject_does_not_exist', 404);
    if (!env.fsPermission(ctx, parent, 'write')) throw error('permission_denied', 403);
    return parent;
  };
  const shareArgs = (path, recipient, mode) => isObject(path) ? path : { path, recipient, mode };
  const recipientUser = recipient => [...env.users.values()].find(u => u.uuid === recipient?.uid || u.username === recipient?.username || u.username === recipient || u.email === recipient);
  const pageShares = (items, opts) => {
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = Math.min(200, opts.limit ?? 50);
    return { items: items.slice(start, start + limit), ...(items.length > start + limit ? { cursor: String(start + limit) } : {}), ...(opts.includeTotal ? { total: items.length } : {}) };
  };
  return {
    async stat(path) { return env.call(ctx, 'fs.stat', () => { const node = check(isObject(path) ? path.path ?? path.uid : path, 'see'); env.charge(ctx, { fsReadOps: 1 }); return stat(node); }); },
    async read(path) { return env.call(ctx, 'fs.read', () => { const node = check(isObject(path) ? path.path ?? path.uid : path, 'read'); if (node.is_dir) throw error('is_directory'); env.charge(ctx, { fsReadOps: 1, egressBytes: node.data.size }); return node.data.slice(0, node.data.size, node.data.type); }); },
    async write(path, data, opts = {}) {
      if (isObject(path)) { opts = path; data = path.data; path = path.path; }
      return env.call(ctx, 'fs.write', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const absolute = env.fsPath(ctx, path);
        let node = env.fsNode(ctx, absolute);
        const parent = node ? null : writableParent(absolute, opts.createMissingParents ?? false);
        if (node) check(node.uid, 'write');
        const created = !node;
        const blob = data instanceof Blob ? data : new Blob([data ?? '']);
        if (!node) node = makeNode(absolute, false, parent.owner, blob);
        else { if (node.is_dir) throw error('is_directory'); node.data = blob; node.modified = env.now(); }
        env.charge(ctx, { fsWriteOps: 1 }); env.emitFs?.(ctx, node, created ? 'add' : 'write');
        return stat(node);
      });
    },
    async mkdir(path, opts = {}) {
      if (isObject(path)) { opts = path; path = path.path; }
      return env.call(ctx, 'fs.mkdir', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const absolute = env.fsPath(ctx, path); const existing = env.fsNode(ctx, absolute);
        if (existing) { check(existing.uid, 'write'); if (opts.dedupeName !== false) return stat(existing); throw error('already_exists', 409); }
        const parent = writableParent(absolute, opts.createMissingParents ?? false);
        const node = makeNode(absolute, true, parent.owner);
        env.charge(ctx, { fsWriteOps: 1 }); env.emitFs?.(ctx, node, 'add'); return stat(node);
      });
    },
    async readdir(path = '', opts = {}) {
      return env.call(ctx, 'fs.readdir', () => {
        const parent = check(path, 'list');
        if (!parent.is_dir) throw error('not_directory');
        const items = [...env.files.values()].filter(n => n.path.slice(0, n.path.lastIndexOf('/')) === parent.path && env.fsPermission(ctx, n, 'see')).sort((a, b) => a.path.localeCompare(b.path)).map(stat);
        env.charge(ctx, { fsReadOps: 1 });
        return opts.limit !== undefined || opts.cursor !== undefined ? pageShares(items, opts) : items;
      });
    },
    async delete(path, opts = {}) {
      return env.call(ctx, 'fs.delete', () => {
        const node = check(path, 'write');
        const children = [...env.files.values()].filter(n => n.uid !== node.uid && under(n.path, node.path));
        if (children.length && opts.recursive === false) throw error('directory_not_empty');
        for (const child of [...children, node]) { env.emitFs?.(ctx, child, 'remove'); env.files.delete(child.uid); }
        env.charge(ctx, { fsWriteOps: 1 }); return true;
      });
    },
    async move(source, destination) {
      return env.call(ctx, 'fs.move', () => {
        const node = check(source, 'write'); let target = env.fsPath(ctx, destination);
        const destNode = env.fsNode(ctx, destination);
        if (destNode?.is_dir) target = destNode.path + '/' + node.path.split('/').at(-1);
        if (node.is_dir && under(target, node.path)) throw error('invalid_request', 400, 'Cannot move a directory inside itself');
        const parent = writableParent(target);
        if (parent.owner !== node.owner) throw error('permission_denied', 403);
        const collision = env.fsNode(ctx, target);
        if (collision && collision.uid !== node.uid) throw error('already_exists', 409);
        const from = node.path;
        for (const child of env.files.values()) if (under(child.path, from)) child.path = target + child.path.slice(from.length);
        node.modified = env.now(); env.charge(ctx, { fsWriteOps: 1 }); env.emitFs?.(ctx, node, 'move', from); return stat(node);
      });
    },
    async rename(path, name) {
      const node = check(path, 'write');
      if (name.includes('/') || name === '.' || name === '..') throw error('invalid_request');
      return this.move(path, node.path.slice(0, node.path.lastIndexOf('/') + 1) + name);
    },
    async share(path, recipient, mode) {
      const args = shareArgs(path, recipient, mode);
      return env.call(ctx, 'fs.share', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const node = check(args.path ?? args.uid, 'manage');
        if (env.options.requireFileShareVerification !== false && !env.users.get(ctx.uid).verified && !env.users.get(ctx.uid).paid) throw error('verification_required', 403);
        if (!Object.hasOwn(levels, args.mode ?? 'read') || args.mode === 'manage') throw error('permission_denied', 403);
        const recipients = Array.isArray(args.recipient) ? args.recipient : [args.recipient];
        return recipients.map(recipient => {
          const user = recipientUser(recipient);
          if (!user) throw error('user_not_found', 404);
          const share = { uid: node.uid, recipient: user.uuid, mode: args.mode ?? 'read', appUid: ctx.appUid, owner: node.owner };
          env.fileShares.set(`${node.uid}:${user.uuid}`, share);
          env.notify?.(user.uuid, { type: 'share.received', uid: node.uid });
          return { ...share, item: stat(node) };
        });
      });
    },
    async unshare(path, recipient) {
      const args = shareArgs(path, recipient);
      return env.call(ctx, 'fs.unshare', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const node = check(args.path ?? args.uid, 'see'); const user = recipientUser(args.recipient);
        if (ctx.uid !== node.owner && ctx.uid !== user?.uuid) throw error('permission_denied', 403);
        const revoked = Number(env.fileShares.delete(`${node.uid}:${user?.uuid}`));
        return { revoked };
      });
    },
    /** Shares on exactly this item, holders by their current username. */
    async getShares(path) {
      return env.call(ctx, 'fs.getShares', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const node = check(isObject(path) ? path.path ?? path.uid : path, 'manage');
        return [...env.fileShares.entries()].filter(([, s]) => s.uid === node.uid).map(([key, s]) => ({
          uid: key, mode: s.mode, path: node.path, entryUid: node.uid, isDir: node.is_dir, holder: env.users.get(s.recipient)?.username ?? null,
          issuer: env.users.get(s.owner)?.username ?? null, inheritedFrom: null, issuedByApp: s.appUid,
        }));
      });
    },
    async listShared(opts = {}) {
      return env.call(ctx, 'fs.listShared', () => {
        if (ctx.restricted) throw error('permission_denied', 403);
        const shares = [...env.fileShares.values()].filter(s => s.recipient === ctx.uid && s.appUid === ctx.appUid && env.files.has(s.uid)).map(s => ({ ...s, item: stat(env.files.get(s.uid)) }));
        return pageShares(shares, opts);
      });
    },
    async getReadURL(path, ttl = '24h') {
      return env.call(ctx, 'fs.getReadURL', () => {
        const node = check(path, 'read');
        if (ctx.restricted || node.is_dir) throw error('permission_denied', 403);
        let seconds = ttl;
        if (typeof ttl === 'string') {
          const match = /^(\d+(?:\.\d+)?)(s|m|h|d|w|y)?$/.exec(ttl);
          if (!match) throw error('invalid_request');
          seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[match[2]] ?? 0.001);
        }
        const token = env.token({ type: 'access-token', user_uid: ctx.uid, exp: Math.floor((env.now() + number(seconds) * 1000) / 1000), full_access: false });
        env.readTokens.set(token, { uid: node.uid, ctx: { ...ctx }, expires: env.now() + number(seconds) * 1000 });
        return `https://api.puter.test/token-read?uid=${encodeURIComponent(node.uid)}&token=${encodeURIComponent(token)}`;
      });
    },
    async revokeReadURL(url) {
      return env.call(ctx, 'fs.revokeReadURL', () => {
        const token = env.readTokens.get(String(url).includes('?') ? new URL(url).searchParams.get('token') : url);
        if (!token || token.ctx.uid !== ctx.uid || token.signed) throw error('permission_denied', 403);
        token.revoked = true;
      });
    },
    async sign(appUid, items) {
      return env.call(ctx, 'fs.sign', () => {
        if (ctx.restricted || appUid !== ctx.appUid) throw error('permission_denied', 403);
        const single = !Array.isArray(items) || items.length === 1;
        const nodes = (Array.isArray(items) ? items : [items]).map(item => check(typeof item === 'string' ? item : item.uid ?? item.path, 'read'));
        const token = env.id('fake-sign');
        env.readTokens.set(token, { uids: nodes.map(n => n.uid), signed: true, ctx: { ...ctx }, expires: Infinity });
        const signed = nodes.map(node => ({ uid: node.uid, url: `https://api.puter.test/token-read?uid=${encodeURIComponent(node.uid)}&token=${token}` }));
        return { token, items: single ? signed[0] : signed };
      });
    },
  };
}
