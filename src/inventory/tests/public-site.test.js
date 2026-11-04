import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { articles, articlePath, collections } from '../site/content.js';
import { publicPaths, renderPage } from '../site/render.js';

const landing = readFileSync(new URL('../src/views/landing.html', import.meta.url), 'utf8');
const dom = (html) => new JSDOM(html, { url: 'https://inventory.example/' }).window.document;
const pages = new Map([['/', landing], ...publicPaths.map(path => [path, renderPage(path)])]);

/* Parsed once per page: every article links to its own headings twice (the
   sidebar and the mobile disclosure), and reparsing the target document per
   link makes the link check quadratic in the size of the library. */
const parsed = new Map();
const docFor = (path) => {
  if (!parsed.has(path)) parsed.set(path, dom(pages.get(path)));
  return parsed.get(path);
};

describe('public library', () => {
  it('publishes every article once, in its declared category', () => {
    expect(new Set(articles.map(a => a.slug)).size).toBe(articles.length);
    for (const article of articles) {
      expect(collections[article.collection].categories).toContain(article.category);
      expect(article.sections.length).toBeGreaterThanOrEqual(3);
      expect(article.sections.every(s => s.html.length > 200)).toBe(true);
    }
  });

  it('renders readable documents with working links and local assets', () => {
    for (const [path, html] of pages) {
      const document = docFor(path);
      expect(document.querySelectorAll('h1'), path).toHaveLength(1);
      expect(html, path).not.toMatch(/Cap Table|cap-table|vesting|liquidation|equity/);
      const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
      expect(new Set(ids).size, path).toBe(ids.length);
      for (const link of document.querySelectorAll('a[href]')) {
        const url = new URL(link.getAttribute('href'), 'https://inventory.example' + path);
        if (url.origin !== 'https://inventory.example') continue;
        if (url.hash.startsWith('#/')) continue;
        expect(pages.has(url.pathname), `${path} → ${url.pathname}`).toBe(true);
        if (url.hash && url.hash !== '#landing-top') {
          expect(docFor(url.pathname).getElementById(url.hash.slice(1)), `${path} → ${url.href}`).not.toBeNull();
        }
      }
      for (const asset of document.querySelectorAll('img[src], source[srcset]')) {
        const name = asset.getAttribute('src') || asset.getAttribute('srcset');
        expect(existsSync(new URL('../public/' + name.replace(/^\.?\//, ''), import.meta.url)), name).toBe(true);
      }
      if (path !== '/') {
        expect(document.querySelector('script[src*="puter"]')).toBeNull();
        expect(document.querySelector('link[rel="canonical"]').href).toBe('https://inventory.puter.com' + path);
        expect(document.querySelector('meta[name="description"]').content.length).toBeGreaterThan(30);
      }
    }
  });

  it('marks missing pages noindex and provides navigation out', () => {
    const document = dom(renderPage('/missing/'));
    expect(document.querySelector('meta[name="robots"]').content).toBe('noindex, follow');
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('main a[href="/docs/"]')).not.toBeNull();
  });

  it('keeps all related article references resolvable', () => {
    for (const article of articles) {
      for (const slug of article.related) {
        const related = articles.find(a => a.slug === slug);
        expect(related, `${article.slug} → ${slug}`).toBeDefined();
        expect(publicPaths).toContain(articlePath(related));
      }
    }
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([
  [undefined, 'https://inventory.puter.com'],
  ['https://inventory.example/', 'https://inventory.example'],
])('generates matching canonical URLs and sitemap with SITE_URL=%s', async (configuredOrigin, expectedOrigin) => {
  vi.stubEnv('SITE_URL', configuredOrigin);
  vi.resetModules();
  const { renderPage, renderSitemap, publicPaths } = await import('../site/render.js');
  const document = dom(renderPage('/docs/getting-started/'));
  expect(document.querySelector('link[rel="canonical"]').href).toBe(expectedOrigin + '/docs/getting-started/');
  expect(document.querySelector('meta[property="og:url"]').content).toBe(expectedOrigin + '/docs/getting-started/');
  const graph = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
  expect(graph['@graph'].some(node => node['@type'] === 'TechArticle')).toBe(true);
  for (const path of ['/', ...publicPaths]) expect(renderSitemap()).toContain(`<loc>${expectedOrigin}${path}</loc>`);
});

it('omits origin metadata and sitemap when SITE_URL is explicitly empty', async () => {
  vi.stubEnv('SITE_URL', '');
  vi.resetModules();
  const { renderPage, renderSitemap } = await import('../site/render.js');
  const document = dom(renderPage('/docs/getting-started/'));
  expect(document.querySelector('link[rel="canonical"]')).toBeNull();
  expect(document.querySelector('meta[property="og:url"]')).toBeNull();
  expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
  expect(renderSitemap()).toBeNull();
});
