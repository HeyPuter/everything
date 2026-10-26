// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PAGE, RECEIVER, isBlockedIp, publicHost, reachProblem, reachableUrl } from '../../src/shared/reach.js';
import { allowedUrl } from '../../worker/ops/trip/unfurl.js';
import { urlProblem } from '../../src/lib/notify-out/guard.js';

// One host of every blocked class, as a path-less https URL.
const BLOCKED = {
  'IPv4 this network 0/8': ['0.0.0.0', '0.1.2.3'],
  'IPv4 private 10/8': ['10.0.0.1', '10.255.255.255'],
  'IPv4 shared CGNAT 100.64/10': ['100.64.0.1', '100.127.255.255'],
  'IPv4 loopback 127/8': ['127.0.0.1', '127.255.255.254'],
  'IPv4 link-local and metadata 169.254/16': ['169.254.169.254', '169.254.0.1'],
  'IPv4 private 172.16/12': ['172.16.0.1', '172.31.255.255'],
  'IPv4 IETF protocol 192.0.0/24': ['192.0.0.192'],
  'IPv4 documentation': ['192.0.2.1', '198.51.100.7', '203.0.113.9'],
  'IPv4 6to4 relay 192.88.99/24': ['192.88.99.1'],
  'IPv4 private 192.168/16': ['192.168.0.1'],
  'IPv4 benchmarking 198.18/15': ['198.18.0.1', '198.19.255.255'],
  'IPv4 multicast': ['224.0.0.1', '239.255.255.250'],
  'IPv4 reserved and broadcast': ['240.0.0.1', '255.255.255.255'],
  'IPv4 spellings URL normalizes': ['2130706433', '0x7f000001', '0177.0.0.1', '0x7f.1', '127.1', '0xA9.0xFE.0xA9.0xFE'],
  'IPv6 unspecified and loopback': ['[::]', '[::1]', '[0:0:0:0:0:0:0:1]'],
  'IPv6 IPv4-mapped and compatible': ['[::ffff:127.0.0.1]', '[::ffff:a9fe:a9fe]', '[::7f00:1]'],
  'IPv6 reserved 0000::/8': ['[0:1::]'],
  'IPv6 unique local fc00::/7': ['[fc00::1]', '[fd00:ec2::254]'],
  'IPv6 link-local and site-local': ['[fe80::1]', '[febf::1]', '[fec0::1]'],
  'IPv6 multicast': ['[ff02::1]'],
  'IPv6 NAT64': ['[64:ff9b::a9fe:a9fe]'],
  'IPv6 documentation': ['[2001:db8::1]'],
  'IPv6 6to4': ['[2002:7f00:1::]'],
  'IPv6 Teredo': ['[2001::1]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]'],
  'IPv6 discard-only 100::/64': ['[100::1]'],
  'single-label names': ['localhost', 'intranet', 'metadata'],
  'local-only suffixes': ['app.localhost', 'printer.local', 'metadata.google.internal', 'router.home.arpa', 'nas.lan', 'box.localdomain',
    'wiki.intranet', 'wiki.corp', 'my.private', 'site.test', 'site.invalid', 'site.example', 'x.onion', 'LOCALHOST.'],
  'wildcard DNS': ['127.0.0.1.nip.io', '10.0.0.1.sslip.io', 'a.xip.io', 'localtest.me', 'a.lvh.me', 'a.vcap.me', 'a.traefik.me', 'tunnel.localhost.run'],
  'names embedding a private IPv4': ['10-0-0-5.example.com', 'app.192.168.1.10.example.com', 'a-1-169-254-169-254.example.net'],
};

describe('shared reach guard', () => {
  it.each(Object.entries(BLOCKED))('refuses %s under both policies and in both callers', (_, hosts) => {
    for (const host of hosts) {
      expect(reachProblem(`https://${host}/`, PAGE), host).toBe('private');
      expect(reachProblem(`https://${host}/`, RECEIVER), host).toBe('private');
      expect(allowedUrl(`https://${host}/`), host).toBeNull();
      expect(urlProblem(`https://${host}/`), host).toBe('url_private');
    }
  });

  it('refuses a numeric last label, which URL itself rejects', () => {
    expect(publicHost('host.123')).toBe(false);
    expect(reachProblem('https://host.123/', PAGE)).not.toBeNull();
    expect(urlProblem('https://host.123/')).not.toBeNull();
  });

  it('accepts public hosts', () => {
    for (const host of ['example.org', 'xn--bcher-kva.example.org', '93.184.216.34', '8-8-8-8.example.com', '[2606:4700:4700::1111]', 'ntfy.sh']) {
      expect(reachProblem(`https://${host}/x`, PAGE), host).toBeNull();
      expect(reachProblem(`https://${host}/x`, RECEIVER), host).toBeNull();
      expect(publicHost(host), host).toBe(true);
    }
    for (const ip of ['1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '192.169.0.1', '198.20.0.1', '223.255.255.255'])
      expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('refuses junk, whitespace, credentials and over-long URLs', () => {
    for (const raw of ['', 'not a url', 'https://', ' https://example.org/', 'https://example.org/a b', 'https://example.org/\n', `https://example.org/${'a'.repeat(2100)}`])
      expect(reachProblem(raw, PAGE), JSON.stringify(raw)).toBe('invalid');
    expect(reachProblem(42)).toBe('invalid');
    expect(reachProblem(null)).toBe('invalid');
    for (const raw of ['https://user:pass@example.org/', 'https://user@example.org/']) {
      expect(reachProblem(raw, PAGE)).toBe('credentials');
      expect(urlProblem(raw)).toBe('url_credentials');
    }
  });

  it('applies each caller its own schemes and ports', () => {
    expect(reachProblem('http://example.org/', PAGE)).toBeNull();
    expect(reachProblem('http://example.org/', RECEIVER)).toBe('scheme');
    expect(urlProblem('http://example.org/')).toBe('url_https');
    for (const raw of ['ftp://example.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.org/'])
      expect(reachProblem(raw, PAGE), raw).toBe('scheme');
    expect(reachProblem('https://example.org:8443/', RECEIVER)).toBeNull();
    expect(reachProblem('https://example.org:8443/', PAGE)).toBe('port');
    expect(reachProblem('http://example.org:80/', PAGE)).toBeNull();
    for (const raw of ['https://example.org:8080/', 'https://example.org:6379/', 'https://example.org:22/']) {
      expect(reachProblem(raw, PAGE), raw).toBe('port');
      expect(urlProblem(raw), raw).toBe('url_port');
    }
  });

  it('carries the stricter rules of both former guards into link previews', () => {
    // From the notify guard: whitespace and localhost.run.
    expect(allowedUrl('https://example.org/a\tb')).toBeNull();
    expect(allowedUrl('https://x.localhost.run/')).toBeNull();
    // Both: the fragment is dropped.
    expect(reachableUrl('https://example.org/a#frag').href).toBe('https://example.org/a');
    expect(allowedUrl('https://example.org/a#frag').href).toBe('https://example.org/a');
  });
});
