// Web crawler + indexer. Fetches pages, extracts text/images/links, indexes them,
// and self-expands by following links and discovering sitemaps.

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const db = require('./db');

const MAX_BODY_LENGTH = 150000;
const USER_AGENT = 'BrambleBot/1.0 (+https://bramblebrowser.app/bot)';

// Crawl tuning -- override via environment variables when deploying
const CONFIG = {
  crawlDelay:        parseInt(process.env.CRAWL_DELAY)          || 150,
  crawlDepth:        parseInt(process.env.CRAWL_DEPTH)          || 4,
  crawlLinksPerPage: parseInt(process.env.CRAWL_LINKS_PER_PAGE) || 60,
  crawlBatchSize:    parseInt(process.env.CRAWL_BATCH_SIZE)     || 12,
  maxIndexed:        parseInt(process.env.MAX_INDEXED)          || 0, // 0 = no cap; stop crawling at this many pages
};

let crawling   = false;
let crawlTimer = null;

const SKIP_EXT  = /\.(css|js|json|xml|pdf|zip|tar|gz|mp3|mp4|avi|mov|wmv|flv|woff|woff2|ttf|eot|ico|svg|png|jpg|jpeg|gif|webp|bmp|tiff)(\?.*)?$/i;
const SKIP_PATH = /\/(login|logout|signin|signup|register|cart|checkout|account|wp-admin|wp-login|feed|rss|atom)(\/|$|\?)/i;
const SKIP_IMG_PATTERN = /\/(ads?|banner|tracking|pixel|beacon|spacer|blank|spinner|loading|icon|favicon|logo-\d)/i;

// -- HTML parsers --------------------------------------------------------------

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY_LENGTH);
}

function extractTitle(html) {
  const t = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (t) return t[1].trim();
  const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']{1,300})["']/i)
          || html.match(/content=["']([^"']{1,300})["'][^>]*property=["']og:title["']/i);
  return og ? og[1].trim() : '';
}

function extractContext(html, imgIndex, radius = 300) {
  const start = Math.max(0, imgIndex - radius);
  const end   = Math.min(html.length, imgIndex + radius);
  return html.slice(start, end)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function extractImages(html, baseUrl) {
  const imgs = [];
  const re = /<img[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag      = m[0];
    const imgIndex = m.index;
    const srcM = tag.match(/src=["']([^"']{8,512})["']/i)
              || tag.match(/data-src=["']([^"']{8,512})["']/i);
    const altM = tag.match(/alt=["']([^"']{0,300})["']/i);
    const wM   = tag.match(/width=["']?(\d+)/i);
    const hM   = tag.match(/height=["']?(\d+)/i);
    if (!srcM) continue;

    const w = wM ? parseInt(wM[1]) : 999;
    const h = hM ? parseInt(hM[1]) : 999;
    if (w < 60 || h < 60) continue;

    try {
      const src = new URL(srcM[1], baseUrl).href;
      if (!src.startsWith('http')) continue;
      if (/\.(svg|ico|gif|webp)($|\?)/i.test(src)) continue;
      if (SKIP_IMG_PATTERN.test(src)) continue;
      const alt     = altM ? altM[1].trim() : '';
      const context = extractContext(html, imgIndex);
      imgs.push({ src, alt, context });
    } catch { /* skip */ }
    if (imgs.length >= 60) break;
  }
  return imgs;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /href=["']([^"'#\s]{8,512})["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      if (!abs.startsWith('http')) continue;
      if (SKIP_EXT.test(abs)) continue;
      if (SKIP_PATH.test(abs)) continue;
      links.push(abs);
    } catch { /* skip */ }
  }
  return [...new Set(links)];
}

// -- Network helpers -----------------------------------------------------------

async function fetchText(urlStr, maxBytes = 500000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': USER_AGENT }, timeout: 8000 }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size < maxBytes) chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function discoverSitemaps(pageUrl) {
  try {
    const base   = new URL(pageUrl);
    const origin = `${base.protocol}//${base.hostname}`;

    let robotsTxt = '';
    try { robotsTxt = await fetchText(`${origin}/robots.txt`, 100000); } catch {}

    const sitemapUrls = [];
    for (const line of robotsTxt.split('\n')) {
      const m = line.match(/^Sitemap:\s*(.+)/i);
      if (m) sitemapUrls.push(m[1].trim());
    }
    if (!sitemapUrls.length) {
      sitemapUrls.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
    }

    let found = 0;
    for (const sUrl of sitemapUrls.slice(0, 3)) {
      try {
        const xml = await fetchText(sUrl, 500000);
        const locs = [...xml.matchAll(/<loc>\s*([^<]{8,512})\s*<\/loc>/gi)].map(r => r[1].trim());
        for (const loc of locs.slice(0, 200)) {
          if (loc.startsWith('http') && !SKIP_EXT.test(loc)) { db.enqueue(loc, 1); found++; }
        }
        const sitemaps = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>/gi)].map(r => r[1].trim());
        for (const s of sitemaps.slice(0, 10)) sitemapUrls.push(s);
      } catch { /* sitemap not found */ }
    }
    if (found) console.log(`[crawler] sitemap: found ${found} URLs on ${base.hostname}`);
  } catch {}
}

function fetchPage(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        try { return resolve(fetchPage(new URL(res.headers.location, urlStr).href, redirects + 1)); }
        catch { return reject(new Error('Bad redirect')); }
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return reject(new Error('Not HTML'));

      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8', 0, MAX_BODY_LENGTH)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// -- Crawl one URL -------------------------------------------------------------

const sitemapFetched = new Set();

async function crawlOne(url, depth) {
  if (url.startsWith('data:') || url.startsWith('file:') || url.startsWith('about:')) return;
  let html;
  try { html = await fetchPage(url); } catch { return; }

  const title  = extractTitle(html);
  const body   = extractText(html);
  const images = extractImages(html, url);
  db.indexPage(url, title, body);
  if (images.length) db.storeImages(url, images);

  const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (hostname && !sitemapFetched.has(hostname)) {
    sitemapFetched.add(hostname);
    discoverSitemaps(url).catch(() => {});
  }

  const links = extractLinks(html, url);
  const base  = new URL(url);
  const same  = [];
  const cross = [];
  for (const link of links) {
    try { (new URL(link).hostname === base.hostname ? same : cross).push(link); } catch {}
  }

  const toQueue = [...same.slice(0, CONFIG.crawlLinksPerPage), ...cross.slice(0, 20)];
  for (const link of toQueue) {
    db.enqueue(link, depth + 1 > CONFIG.crawlDepth ? CONFIG.crawlDepth : depth + 1);
  }
}

// -- Crawl loop ----------------------------------------------------------------

let _lastReseed = 0;
const RESEED_INTERVAL_MS = 60 * 1000;

function reseedFromIndex() {
  const now = Date.now();
  if (now - _lastReseed < RESEED_INTERVAL_MS) return;
  _lastReseed = now;
  try {
    const pages = db.getRandomIndexedPages(40);
    let queued = 0;
    for (const { url } of pages) if (db.requeueForExpansion(url)) queued++;
    if (queued) console.log(`[crawler] re-queued ${queued} indexed pages to expand links`);
  } catch {}
}

async function tick() {
  if (!crawling) return;

  // Stop crawling once we hit the page cap (keep serving searches).
  if (CONFIG.maxIndexed > 0 && db.getIndexStats().indexed >= CONFIG.maxIndexed) {
    console.log(`[crawler] reached ${CONFIG.maxIndexed.toLocaleString()} indexed pages — crawling paused (search still works). Restart without MAX_INDEXED to resume.`);
    stopCrawler();
    return;
  }

  const items = db.dequeue(CONFIG.crawlBatchSize);
  if (items.length) {
    await Promise.allSettled(
      items.map((item, i) =>
        new Promise(r => setTimeout(r, i * CONFIG.crawlDelay)).then(() => crawlOne(item.url, item.depth))
      )
    );
    crawlTimer = setTimeout(tick, 100);
  } else {
    reseedFromIndex();
    crawlTimer = setTimeout(tick, 3000);
  }
}

function startCrawler() {
  if (crawling) return;
  crawling = true;
  tick();
}

function stopCrawler() {
  crawling = false;
  if (crawlTimer) { clearTimeout(crawlTimer); crawlTimer = null; }
}

function seedUrl(url) {
  db.enqueue(url, 0);
  if (!crawling) startCrawler();
}

module.exports = { startCrawler, stopCrawler, seedUrl, CONFIG };
