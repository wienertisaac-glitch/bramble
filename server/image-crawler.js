// Dedicated image crawler -- runs alongside the main crawler.
// Targets image-rich pages and indexes images with surrounding context.

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const db = require('./db');

const USER_AGENT = 'BrambleImageBot/1.0 (+https://bramblebrowser.app/bot)';
const MAX_BYTES  = 1024 * 1024 * 2; // 2MB

let running  = false;
let imgTimer = null;

const IMAGE_SEEDS = [
  // Wikimedia Commons -- huge free image library
  'https://commons.wikimedia.org/wiki/Main_Page',
  'https://commons.wikimedia.org/wiki/Category:Featured_pictures_on_Wikimedia_Commons',
  'https://commons.wikimedia.org/wiki/Category:Nature',
  'https://commons.wikimedia.org/wiki/Category:Animals',
  'https://commons.wikimedia.org/wiki/Category:Architecture',
  'https://commons.wikimedia.org/wiki/Category:People',
  'https://commons.wikimedia.org/wiki/Category:Science',
  'https://commons.wikimedia.org/wiki/Category:Technology',
  'https://en.wikipedia.org/wiki/Portal:Arts',
  'https://en.wikipedia.org/wiki/Portal:Science',
  'https://en.wikipedia.org/wiki/Portal:Geography',
  'https://en.wikipedia.org/wiki/Portal:Biography',
  'https://en.wikipedia.org/wiki/Portal:History',
  'https://en.wikipedia.org/wiki/Portal:Technology',
  'https://www.nasa.gov/images',
  'https://images.nasa.gov',
  'https://www.nasa.gov/gallery',
  'https://unsplash.com',
  'https://www.pexels.com',
  'https://pixabay.com',
  'https://www.flickr.com/explore',
  'https://www.flickr.com/photos/tags/nature',
  'https://www.flickr.com/photos/tags/city',
  'https://www.bbc.com/news/in_pictures',
  'https://www.nationalgeographic.com/photography',
  'https://www.nationalgeographic.com/animals',
  'https://apnews.com/hub/photography',
  'https://www.metmuseum.org/art/collection',
  'https://artsandculture.google.com',
  'https://www.wikiart.org',
  'https://www.newscientist.com/subject/physics',
  'https://phys.org/news/astronomy.html',
  'https://hubblesite.org/images/gallery',
  'https://www.dezeen.com',
  'https://www.archdaily.com',
];

const SKIP_EXT  = /\.(css|js|json|pdf|zip|mp3|mp4|avi|mov)(\?.*)?$/i;
const SKIP_IMG  = /\/(ads?|banner|tracking|pixel|beacon|spacer|blank|spinner|loading|icon|favicon|logo-\d)/i;
const SKIP_PATH = /\/(login|logout|signin|signup|cart|checkout|account)(\/|$|\?)/i;

let imgQueue = [];
let imgVisited = new Set();
let seedsLoaded = false;

const MAX_QUEUE   = 5000;
const MAX_VISITED = 50000;

function loadSeeds() {
  if (seedsLoaded) return;
  seedsLoaded = true;
  for (const url of IMAGE_SEEDS) if (!imgVisited.has(url)) imgQueue.push({ url, depth: 0 });
}

function enqueue(url, depth = 0) {
  if (imgVisited.has(url)) return;
  if (SKIP_EXT.test(url)) return;
  if (SKIP_PATH.test(url)) return;
  if (imgQueue.length >= MAX_QUEUE) return;
  imgQueue.push({ url, depth });
}

function fetchPage(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 8000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        try { return resolve(fetchPage(new URL(res.headers.location, urlStr).href, redirects + 1)); }
        catch { return reject(new Error('Bad redirect')); }
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('text/html')) return reject(new Error('Not HTML'));
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size < MAX_BYTES) chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractImages(html, baseUrl) {
  const imgs = [];
  const re = /<img[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const idx = m.index;
    const srcM = tag.match(/src=["']([^"']{8,512})["']/i)
              || tag.match(/data-src=["']([^"']{8,512})["']/i)
              || tag.match(/data-lazy=["']([^"']{8,512})["']/i);
    const altM = tag.match(/alt=["']([^"']{0,300})["']/i);
    const wM   = tag.match(/width=["']?(\d+)/i);
    const hM   = tag.match(/height=["']?(\d+)/i);
    if (!srcM) continue;
    const w = wM ? parseInt(wM[1]) : 999;
    const h = hM ? parseInt(hM[1]) : 999;
    if (w < 80 || h < 80) continue;
    try {
      const src = new URL(srcM[1], baseUrl).href;
      if (!src.startsWith('http')) continue;
      if (/\.(svg|ico|gif)($|\?)/i.test(src)) continue;
      if (SKIP_IMG.test(src)) continue;
      const alt = altM ? altM[1].trim() : '';
      const start = Math.max(0, idx - 400);
      const end   = Math.min(html.length, idx + 400);
      const context = html.slice(start, end)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      imgs.push({ src, alt, context });
    } catch {}
    if (imgs.length >= 80) break;
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
      if (abs.startsWith('http') && !SKIP_EXT.test(abs) && !SKIP_PATH.test(abs)) links.push(abs);
    } catch {}
  }
  return [...new Set(links)];
}

async function crawlOne(url, depth) {
  if (imgVisited.size >= MAX_VISITED) imgVisited.clear();
  imgVisited.add(url);
  let html;
  try { html = await fetchPage(url); } catch { return; }

  const images = extractImages(html, url);
  if (images.length) {
    db.storeImages(url, images);
    console.log(`[img-crawler] ${images.length} images from ${url}`);
  }

  if (depth < 2) {
    const links = extractLinks(html, url);
    const base = new URL(url);
    let same = 0, cross = 0;
    for (const link of links) {
      try {
        const lp = new URL(link);
        if (lp.hostname === base.hostname && same < 20) { enqueue(link, depth + 1); same++; }
        else if (lp.hostname !== base.hostname && cross < 5) { enqueue(link, depth + 1); cross++; }
      } catch {}
    }
  }
}

async function tick() {
  if (!running) return;
  if (!imgQueue.length) {
    loadSeeds();
    imgTimer = setTimeout(tick, 10000);
    return;
  }
  const batch = imgQueue.splice(0, 4);
  await Promise.allSettled(batch.map((item, i) =>
    new Promise(r => setTimeout(r, i * 300)).then(() => crawlOne(item.url, item.depth))
  ));
  imgTimer = setTimeout(tick, 200);
}

function start() {
  if (running) return;
  running = true;
  loadSeeds();
  tick();
}

function stop() {
  running = false;
  if (imgTimer) { clearTimeout(imgTimer); imgTimer = null; }
}

module.exports = { start, stop };
