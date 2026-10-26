// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HEAD_BYTES, allowedUrl, cleanText, fetchPreview, guardedFetch, isBlockedIp, parseHead, readHead, stripHidden } from '../../worker/ops/trip/unfurl.js';

const ok = (raw) => allowedUrl(raw)?.href ?? null;
const html = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location ? { location } : {} });

describe('allowedUrl: schemes, credentials and ports', () => {
  it('accepts public http(s) pages and drops the fragment', () => {
    expect(ok('https://example.org/guide?x=1#top')).toBe('https://example.org/guide?x=1');
    expect(ok('http://www.lisboa.pt/')).toBe('http://www.lisboa.pt/');
    expect(ok('https://bücher.example.org/')).toBe('https://xn--bcher-kva.example.org/');
    expect(ok('https://example.org:443/')).toBe('https://example.org/');
    expect(ok('http://example.org:80/a')).toBe('http://example.org/a');
    expect(ok('https://93.184.216.34/')).toBe('https://93.184.216.34/');
    expect(ok('https://[2606:2800:220:1:248:1893:25c8:1946]/')).toBe('https://[2606:2800:220:1:248:1893:25c8:1946]/');
  });
  it('refuses other schemes, credentials, odd ports and junk', () => {
    for (const raw of ['ftp://example.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.org/', 'ws://example.org/',
      'https://user:pass@example.org/', 'https://user@example.org/', 'https://example.org:8080/', 'http://example.org:22/', 'https://example.org:6379/',
      'not a url', '', 'https://', `https://example.org/${'a'.repeat(2100)}`]) expect(ok(raw), raw).toBeNull();
    expect(allowedUrl(42)).toBeNull();
    expect(allowedUrl(null)).toBeNull();
  });
});

describe('allowedUrl: local names', () => {
  it('refuses localhost, single labels and local-only suffixes', () => {
    for (const raw of ['http://localhost/', 'http://LOCALHOST./', 'http://app.localhost/', 'http://printer.local/', 'http://metadata.google.internal/computeMetadata/v1/',
      'http://router.home.arpa/', 'http://nas.lan/', 'http://intranet/', 'http://metadata/', 'http://instance-data/latest/', 'http://box.localdomain/',
      'http://wiki.corp/', 'http://site.test/', 'http://site.example/', 'http://x.onion/']) expect(ok(raw), raw).toBeNull();
  });
  it('refuses wildcard DNS and names that embed a private IPv4 address', () => {
    for (const raw of ['http://127.0.0.1.nip.io/', 'http://10.0.0.1.sslip.io/', 'http://anything.xip.io/', 'http://localtest.me/', 'http://a.lvh.me/',
      'http://10-0-0-5.example.com/', 'http://app.192.168.1.10.example.com/', 'http://a-1-169-254-169-254.example.net/']) expect(ok(raw), raw).toBeNull();
    expect(ok('http://8-8-8-8.example.com/')).toBe('http://8-8-8-8.example.com/');
  });
});

describe('isBlockedIp and IPv4 literals', () => {
  it('blocks loopback, private, CGNAT, link-local metadata, documentation, multicast and reserved IPv4', () => {
    for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.100.100.200', '100.127.255.255', '127.0.0.1', '127.255.255.254',
      '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.192', '192.0.2.1', '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.19.255.255',
      '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '192.169.0.1', '198.20.0.1', '223.255.255.255'])
      expect(isBlockedIp(ip), ip).toBe(false);
  });
  it('sees through the IPv4 spellings URL normalizes', () => {
    for (const raw of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/', 'http://017700000001/', 'http://0/',
      'http://169.254.169.254/latest/meta-data/', 'http://0xA9.0xFE.0xA9.0xFE/', 'http://[::ffff:169.254.169.254]/']) expect(ok(raw), raw).toBeNull();
  });
  it('blocks IPv6 loopback, local, multicast and every IPv4-carrying form', () => {
    for (const raw of ['http://[::1]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[fc00::1]/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://[febf::1]/',
      'http://[fec0::1]/', 'http://[ff02::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::7f00:1]/', 'http://[::127.0.0.1]/',
      'http://[64:ff9b::a9fe:a9fe]/', 'http://[2001:db8::1]/', 'http://[2002:7f00:1::]/', 'http://[2001::1]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[100::1]/', 'http://[0:1::]/'])
      expect(ok(raw), raw).toBeNull();
    for (const ip of ['[2606:4700:4700::1111]', '[2a00:1450:4001:82a::200e]', '[2001:4860:4860::8888]']) expect(isBlockedIp(ip), ip).toBe(false);
  });
});

describe('guardedFetch', () => {
  it('follows public redirects by hand and refuses one that leads to a blocked host', async () => {
    const fetcher = vi.fn(async (url) => (url === 'https://short.example.org/a' ? redirect('https://real.example.org/page') : html('<title>Real</title>')));
    const result = await guardedFetch('https://short.example.org/a', { fetch: fetcher });
    expect(result.url).toBe('https://real.example.org/page');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://short.example.org/a', 'https://real.example.org/page']);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });

    for (const location of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/', 'http://10.0.0.5/admin', 'file:///etc/passwd', 'http://[::1]/', '//127.0.0.1/x']) {
      const evil = vi.fn(async (url) => (url.startsWith('https://short') ? redirect(location) : html('<title>secret</title>')));
      expect(await guardedFetch('https://short.example.org/a', { fetch: evil }), location).toBeNull();
      expect(evil).toHaveBeenCalledTimes(1);
    }
  });
  it('checks the address a runtime reports after following a redirect itself', async () => {
    const response = html('<title>internal</title>');
    Object.defineProperty(response, 'url', { value: 'http://192.168.1.1/' });
    expect(await guardedFetch('https://example.org/', { fetch: async () => response })).toBeNull();
  });
  it('gives up after three redirects, on a missing Location and on errors', async () => {
    let n = 0;
    const loop = vi.fn(async () => redirect(`https://hop${++n}.example.org/`));
    expect(await guardedFetch('https://start.example.org/', { fetch: loop })).toBeNull();
    expect(loop).toHaveBeenCalledTimes(4);
    expect(await guardedFetch('https://example.org/', { fetch: async () => redirect(null) })).toBeNull();
    expect(await guardedFetch('https://example.org/', { fetch: async () => new Response('no', { status: 404 }) })).toBeNull();
    expect(await guardedFetch('https://example.org/', { fetch: async () => { throw new TypeError('network'); } })).toBeNull();
    const never = vi.fn();
    expect(await guardedFetch('http://127.0.0.1/', { fetch: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
  it('starts no hop once the time budget is spent and caps each hop', async () => {
    let time = 0;
    const slow = vi.fn(async () => { time += 6000; return redirect('https://next.example.org/'); });
    expect(await guardedFetch('https://example.org/', { fetch: slow, now: () => time, deadline: 8000 })).toBeNull();
    expect(slow).toHaveBeenCalledTimes(2);
    expect(slow.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('readHead and parseHead', () => {
  it('stops at </head> and never reads past the byte cap', async () => {
    const pulled = [];
    const stream = (chunks) => new ReadableStream({ pull(controller) { const next = chunks.shift(); if (!next) controller.close(); else { pulled.push(next.length); controller.enqueue(new TextEncoder().encode(next)); } } });
    const text = await readHead(new Response(stream(['<html><head><title>A</title>', '</head><body>', 'x'.repeat(5000)]), { headers: { 'content-type': 'text/html' } }));
    expect(text).toContain('</head>');
    expect(pulled).toHaveLength(2);
    const huge = await readHead(new Response(stream(Array.from({ length: 40 }, () => `<meta name="x" content="${'y'.repeat(8000)}">`)), { headers: { 'content-type': 'text/html' } }));
    expect(new TextEncoder().encode(huge).length).toBeLessThanOrEqual(HEAD_BYTES);
  });
  it('ignores a </head> inside a comment or script, and decodes a declared meta charset', async () => {
    expect(stripHidden('a<!-- </head> -->b<script>"</head>"</script>c')).toBe('abc');
    const latin = new Uint8Array([...new TextEncoder().encode('<head><meta charset="windows-1252"><title>Caf'), 0xe9, ...new TextEncoder().encode('</title></head>')]);
    expect(parseHead(await readHead(new Response(latin, { headers: { 'content-type': 'text/html' } })), 'https://x.example/').title).toBe('Café');
  });
  it('reads Open Graph first, then title and description, as plain text', () => {
    const page = `<head><!-- <meta property="og:title" content="Old"> --><title>Fallback &amp; more</title>
      <meta property="og:title" content="Lisbon &#8211; the guide">
      <meta name="description" content="Trams, &quot;pastéis&quot; and views">
      <meta property="og:image" content="/img/cover.jpg"></head><body><meta property="og:title" content="Body"></body>`;
    expect(parseHead(page, 'https://guide.example.org/lisbon')).toEqual({ title: 'Lisbon – the guide', desc: 'Trams, "pastéis" and views', image: 'https://guide.example.org/img/cover.jpg' });
    expect(parseHead('<head><title>Only title</title></head>', 'https://a.example/')).toEqual({ title: 'Only title', desc: '', image: null });
    expect(parseHead('<head><meta property="og:image" content="https://a.example/x.png"></head>', 'https://a.example/')).toBeNull();
  });
  it('keeps only public https image URLs and strips markup and control characters', () => {
    const image = (src) => parseHead(`<head><title>T</title><meta property="og:image" content="${src}"></head>`, 'http://page.example.org/').image;
    expect(image('http://cdn.example.org/a.jpg')).toBeNull();
    expect(image('https://169.254.169.254/a.png')).toBeNull();
    expect(image('javascript:alert(1)')).toBeNull();
    expect(image('/relative.png')).toBeNull();
    expect(image('https://cdn.example.org/a.jpg')).toBe('https://cdn.example.org/a.jpg');
    const hostile = parseHead('<head><title><script>x</script>Hi‮ there\u0007</title></head>', 'https://a.example/');
    expect(hostile.title).toBe('Hi there');
    expect(cleanText('x'.repeat(500), 200)).toHaveLength(200);
  });
});

describe('fetchPreview', () => {
  it('reads HTML only', async () => {
    expect(await fetchPreview('https://a.example.org/', { fetch: async () => html('<head><title>Hello</title></head>') })).toEqual({ title: 'Hello', desc: '', image: null });
    expect(await fetchPreview('https://a.example.org/x.pdf', { fetch: async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) })).toBeNull();
    expect(await fetchPreview('https://a.example.org/x.json', { fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) })).toBeNull();
  });
});
