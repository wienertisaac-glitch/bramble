// Bramble indexer -- HTTP search API in front of the crawler + index.
// Run with: npm start   (configure with PORT / CRAWL_* env vars)

const http = require('http');
const { URL } = require('url');
const db = require('./db');
const crawler = require('./crawler');
const imageCrawler = require('./image-crawler');
const seeds = require('./seeds');

const PORT = parseInt(process.env.PORT) || 8787;

// -- Content classification (lists live here, on the server) -------------------

const SAFE_SEARCH_TERMS = [
  'porn','xxx','nude','naked','sex','hentai','nsfw','adult','erotic','fetish',
  'playboy','onlyfans','escort','stripper','lingerie','topless','explicit',
  'lewd','r18','18+','mature content','sexually','genitalia','pornographic'
];
const NSFW_DOMAINS = [
  'xvideos','pornhub','xhamster','redtube','youporn','tube8','xnxx',
  'onlyfans','chaturbate','livejasmin','stripchat'
];
const NEWS_DOMAINS = [
  'bbc.','reuters.','apnews.','npr.org','techcrunch.','theverge.','arstechnica.',
  'wired.','technologyreview.','venturebeat.','zdnet.','engadget.','newscientist.',
  'nature.com','phys.org','scientificamerican.','nationalgeographic.','theguardian.',
  'nytimes.','washingtonpost.','cnn.','nbcnews.','abcnews.'
];

function hostOf(url) {
  try { return new URL(url).hostname.replace('www.',''); } catch { return ''; }
}
function isNsfwUrl(url) {
  const lower = (url || '').toLowerCase();
  if (SAFE_SEARCH_TERMS.some(t => lower.includes(t))) return true;
  const host = hostOf(url);
  return NSFW_DOMAINS.some(d => host.includes(d));
}
function isNsfwImage(img) {
  const text = [img.alt, img.src, img.page_url, img.context].filter(Boolean).join(' ').toLowerCase();
  if (SAFE_SEARCH_TERMS.some(t => text.includes(t))) return true;
  const host = hostOf(img.page_url || img.src);
  return NSFW_DOMAINS.some(d => host.includes(d));
}
function isNewsDomain(url) { return NEWS_DOMAINS.some(d => (url || '').includes(d)); }

// -- HTTP helpers --------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
}

// -- Routes --------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); }
  catch { return json(res, 400, { error: 'bad request' }); }
  const p = u.pathname;

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, ...db.getIndexStats() });

    if (p === '/api/stats')  return json(res, 200, db.getIndexStats());

    if (p === '/api/search') {
      const q     = (u.searchParams.get('q') || '').trim();
      const tab   = u.searchParams.get('tab') || 'web';
      const safe  = u.searchParams.get('safe') !== '0';
      const limit = Math.max(5, Math.min(100, parseInt(u.searchParams.get('limit')) || 30));

      let results = q ? db.searchPages(q, limit) : [];
      if (tab === 'news') results = results.filter(r => isNewsDomain(r.url));
      results = results.map(r => ({ ...r, nsfw: isNsfwUrl(r.url) }));
      if (safe) results = results.filter(r => !r.nsfw);

      return json(res, 200, { query: q, tab, results, stats: db.getIndexStats() });
    }

    if (p === '/api/images') {
      const q = (u.searchParams.get('q') || '').trim();
      const images = db.searchImages(q).map(img => ({
        src: img.src, alt: img.alt, page_url: img.page_url,
        domain: img.domain, nsfw: isNsfwImage(img),
      }));
      return json(res, 200, { query: q, images, stats: db.getIndexStats() });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[indexer] request error:', e.message);
    return json(res, 500, { error: 'internal error' });
  }
});

// -- Boot ----------------------------------------------------------------------

// Set DISABLE_CRAWL=1 to run serve-only: answer searches from the existing index
// but stop crawling. Near-zero CPU/bandwidth and the index stops growing -- handy
// when self-hosting on a home PC once the index is big enough.
const CRAWL_DISABLED = process.env.DISABLE_CRAWL === '1' || process.env.DISABLE_CRAWL === 'true';

async function main() {
  await db.ensureDb();
  const stats = db.getIndexStats();

  if (CRAWL_DISABLED) {
    console.log('[indexer] crawling disabled (serve-only mode)');
  } else {
    crawler.startCrawler();
    imageCrawler.start();
    if (stats.indexed === 0 && stats.queued === 0) {
      console.log(`[indexer] first run -- seeding crawler with ${seeds.length} URLs...`);
      for (const url of seeds) crawler.seedUrl(url);
    }
  }

  server.listen(PORT, () => {
    console.log(`[indexer] Bramble indexer listening on http://localhost:${PORT}`);
    console.log(`[indexer] index: ${stats.indexed} pages, ${stats.queued} queued${CRAWL_DISABLED ? ' (serve-only)' : ''}`);
  });
}

function shutdown() {
  console.log('[indexer] shutting down...');
  crawler.stopCrawler();
  imageCrawler.stop();
  db.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(e => { console.error('[indexer] fatal:', e); process.exit(1); });
