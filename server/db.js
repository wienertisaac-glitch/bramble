// Bramble indexer database: better-sqlite3 (real on-disk SQLite).
// Stores the web index, image index, and crawl queue. Memory stays flat as the
// index grows (data lives on disk, not in RAM). Persists to ./data/index.db
// (or $DATA_DIR/index.db).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;
// DATA_DIR can point at a mounted persistent disk in production.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(DATA_DIR, 'index.db');

// -- Init --

async function ensureDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');   // better concurrency, no full-file rewrites
  db.pragma('synchronous = NORMAL');
  initSchema();
  return db;
}

// On-disk engine writes as it goes; flush just checkpoints the WAL on shutdown.
function flush() {
  if (!db) return;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
}

// Helpers: positional ? params. Coerce undefined -> null (better-sqlite3 rejects undefined).
function norm(params) { return params.map(p => (p === undefined ? null : p)); }
function run(sql, params = []) { return db.prepare(sql).run(...norm(params)); }
function all(sql, params = []) { return db.prepare(sql).all(...norm(params)); }
function get(sql, params = []) { return db.prepare(sql).get(...norm(params)) || null; }

// -- Schema --

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      body TEXT,
      indexed_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS search_terms (
      term TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      tf REAL NOT NULL,
      PRIMARY KEY (term, doc_id),
      FOREIGN KEY (doc_id) REFERENCES search_index(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_terms_term ON search_terms(term);

    CREATE TABLE IF NOT EXISTS crawl_queue (
      url TEXT PRIMARY KEY,
      depth INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS crawl_visited (
      url TEXT PRIMARY KEY,
      crawled_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL,
      alt TEXT,
      context TEXT,
      page_url TEXT NOT NULL,
      indexed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(src, page_url)
    );
    CREATE INDEX IF NOT EXISTS idx_images_page ON images(page_url);
  `);
}

// -- Search algorithm: BM25 + title boost + stemming + domain authority --

const STOPWORDS = new Set([
  'the','and','for','are','was','not','but','had','has','have','been','that',
  'this','with','from','they','will','what','when','there','their','which',
  'were','would','could','should','about','into','than','then','them','more',
  'also','can','its','our','out','one','all','new','get','how','may','just',
  'see','use','any','com','www','http','https','page','site','web','click',
  'here','read','more','view','show','find','search','result','content'
]);

function stem(w) {
  if (w.length < 5) return w;
  if (w.endsWith('tion'))  return w.slice(0,-4)+'t';
  if (w.endsWith('tions')) return w.slice(0,-5)+'t';
  if (w.endsWith('ness'))  return w.slice(0,-4);
  if (w.endsWith('ment'))  return w.slice(0,-4);
  if (w.endsWith('ings'))  return w.slice(0,-4);
  if (w.endsWith('ing'))   return w.slice(0,-3);
  if (w.endsWith('ious'))  return w.slice(0,-4);
  if (w.endsWith('ous'))   return w.slice(0,-3);
  if (w.endsWith('ive'))   return w.slice(0,-3);
  if (w.endsWith('ful'))   return w.slice(0,-3);
  if (w.endsWith('less'))  return w.slice(0,-4);
  if (w.endsWith('able'))  return w.slice(0,-4);
  if (w.endsWith('ible'))  return w.slice(0,-4);
  if (w.endsWith('ies'))   return w.slice(0,-3)+'y';
  if (w.endsWith('ied'))   return w.slice(0,-3)+'y';
  if (w.endsWith('er'))    return w.slice(0,-2);
  if (w.endsWith('est'))   return w.slice(0,-3);
  if (w.endsWith('ed'))    return w.slice(0,-2);
  if (w.endsWith('es'))    return w.slice(0,-2);
  if (w.endsWith('ly'))    return w.slice(0,-2);
  if (w.endsWith('s') && w.length > 4) return w.slice(0,-1);
  return w;
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 30 && !STOPWORDS.has(w))
    .map(stem)
    .filter(w => w.length > 1);
}

const AUTHORITY = new Map([
  ['en.wikipedia.org', 2.0], ['developer.mozilla.org', 1.9], ['docs.python.org', 1.8],
  ['nodejs.org', 1.7],        ['stackoverflow.com', 1.8],     ['github.com', 1.5],
  ['arxiv.org', 1.7],         ['nature.com', 1.7],            ['bbc.com', 1.5],
  ['reuters.com', 1.5],       ['arstechnica.com', 1.4],       ['mozilla.org', 1.6],
  ['devdocs.io', 1.6],        ['w3schools.com', 1.4],         ['mdn.io', 1.7],
  ['docs.rs', 1.6],           ['go.dev', 1.6],                ['rust-lang.org', 1.6],
]);
function domainAuthority(url) {
  try {
    const host = new URL(url).hostname.replace('www.','');
    if (AUTHORITY.has(host)) return AUTHORITY.get(host);
    for (const [d, score] of AUTHORITY) if (host.endsWith('.'+d) || host === d) return score;
  } catch {}
  return 1.0;
}

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

function computeTF(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const tf = new Map();
  for (const [t, c] of counts) tf.set(t, c / tokens.length);
  return tf;
}

// -- Search index --

function indexPage(url, title, body) {
  const titleTokens = tokenize(title || '');
  const bodyTokens  = tokenize((body || '').slice(0, 50000));
  if (titleTokens.length + bodyTokens.length < 5) return;

  const weightedTokens = [...titleTokens, ...titleTokens, ...titleTokens, ...bodyTokens];
  const tf = computeTF(weightedTokens);
  const docLen = bodyTokens.length;
  const bodyTrunc = body == null ? null : body.slice(0, 20000);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM search_index WHERE url = ?').get(url);
    let docId;
    if (existing) {
      db.prepare("UPDATE search_index SET title=?, body=?, indexed_at=strftime('%s','now') WHERE url=?")
        .run(title ?? null, bodyTrunc, url);
      db.prepare('DELETE FROM search_terms WHERE doc_id = ?').run(existing.id);
      docId = existing.id;
    } else {
      const info = db.prepare('INSERT INTO search_index (url, title, body) VALUES (?,?,?)')
        .run(url, title ?? null, bodyTrunc);
      docId = info.lastInsertRowid;
    }
    const termStmt = db.prepare('INSERT OR IGNORE INTO search_terms (term, doc_id, tf) VALUES (?,?,?)');
    for (const [term, score] of tf) termStmt.run(term, docId, score * docLen);
    db.prepare('INSERT OR IGNORE INTO crawl_visited (url) VALUES (?)').run(url);
  });

  try { tx(); } catch (e) { console.warn('[db] indexPage error:', e.message); }
}

function searchPages(queryText, limit = 30) {
  const terms = tokenize(queryText);
  if (!terms.length) return [];

  const N = (get('SELECT COUNT(*) as n FROM search_index')?.n) || 1;
  const avgDlRow = get('SELECT AVG(LENGTH(body)) as avg FROM search_index');
  const avgDl = Math.max((avgDlRow?.avg || 1000) / 6, 50);
  const now = Math.floor(Date.now() / 1000);

  const scores   = new Map();
  const termHits = new Map();
  const meta     = new Map();

  const termStmt = db.prepare(
    'SELECT st.doc_id, st.tf, si.url, si.title, si.body, si.indexed_at FROM search_terms st JOIN search_index si ON st.doc_id=si.id WHERE st.term=?'
  );
  for (const term of terms) {
    const rows = termStmt.all(term);
    const df  = rows.length || 1;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    for (const r of rows) {
      const tf   = r.tf;
      const bm25 = idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * tf / avgDl));
      scores.set(r.doc_id, (scores.get(r.doc_id) || 0) + bm25);
      if (!termHits.has(r.doc_id)) termHits.set(r.doc_id, new Set());
      termHits.get(r.doc_id).add(term);
      if (!meta.has(r.doc_id)) meta.set(r.doc_id, { title: r.title, url: r.url, body: r.body || '', indexed_at: r.indexed_at || 0 });
    }
  }

  const phrase   = queryText.toLowerCase().trim();
  const urlTerms = terms.slice(0, 5);

  const ranked = [...scores.entries()]
    .map(([id, bm25]) => {
      const m       = meta.get(id);
      const matched = termHits.get(id)?.size || 0;
      let score     = bm25;

      const titleLower = (m.title || '').toLowerCase();
      const bodyLower  = (m.body  || '').toLowerCase();
      const urlLower   = (m.url   || '').toLowerCase();

      const coverage = matched / Math.max(terms.length, 1);
      score *= (0.2 + 0.8 * coverage * coverage);

      if (phrase.length > 3) {
        if (titleLower.includes(phrase)) score *= 4.0;
        else if (bodyLower.includes(phrase)) score *= 2.0;
      }
      if (terms.length > 1 && terms.every(t => titleLower.includes(t))) score *= 3.0;

      const urlHits = urlTerms.filter(t => urlLower.includes(t)).length;
      if (urlHits) score *= (1 + urlHits * 0.2);

      const ageDays = (now - (m.indexed_at || 0)) / 86400;
      if (ageDays < 1)       score *= 1.3;
      else if (ageDays < 7)  score *= 1.15;
      else if (ageDays < 30) score *= 1.05;

      const bodyLen = bodyLower.length;
      if (bodyLen > 2000) {
        let occurrences = 0;
        for (const t of terms) {
          let pos = 0;
          while ((pos = bodyLower.indexOf(t, pos)) !== -1) { occurrences++; pos += t.length; }
        }
        const density = occurrences / (bodyLen / 1000);
        if (density < 0.3) score *= 0.3;
        else if (density < 1.0) score *= 0.7;
      }

      score *= domainAuthority(m.url);
      return { id, score, matched, m };
    })
    .sort((a, b) => b.score - a.score);

  // Collapse duplicate pages indexed under different URL variants (trailing
  // slash, query strings, percent-encoding) -- keep only the highest-scored copy.
  const seen = new Set();
  const out = [];
  for (const r of ranked) {
    const key = canonicalUrl(r.m.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }

  return out.map(({ m, matched }) => ({
    url: m.url, title: m.title, excerpt: buildExcerpt(m.body, terms),
    body: m.body?.slice(0, 400),
    termsMatched: matched, totalTerms: terms.length,
    indexed_at: m.indexed_at,
  }));
}

// Normalize a URL so the same page under different variants maps to one key.
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch {}
    path = path.replace(/\/+$/, '');   // drop trailing slash(es); ignore query + fragment
    return host + path;
  } catch { return url; }
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Excerpt is rendered as HTML (with <b> highlights), so escape page text first.
function buildExcerpt(body, terms) {
  if (!body) return '';
  const lower = body.toLowerCase();
  let best = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  const slice = best === -1
    ? body.slice(0, 200)
    : (best - 80 > 0 ? '...' : '') + body.slice(Math.max(0, best - 80), Math.min(body.length, best + 200)) +
      (best + 200 < body.length ? '...' : '');

  let snippet = escHtml(slice);
  for (const t of terms) {
    snippet = snippet.replace(new RegExp(`(${escRegex(t)})`, 'gi'), '<b>$1</b>');
  }
  return snippet;
}

// -- Images --

function storeImages(pageUrl, imgs) {
  const stmt = db.prepare('INSERT OR IGNORE INTO images (src, alt, context, page_url) VALUES (?,?,?,?)');
  const tx = db.transaction((rows) => {
    for (const { src, alt, context } of rows) stmt.run(src, alt || '', context || '', pageUrl);
  });
  try { tx(imgs); } catch { /* skip */ }
}

const JUNK_IMG = /\/(ads?|banner|tracking|pixel|beacon|logo|icon|button|sprite|spacer|blank|loading|spinner)\//i;
const JUNK_EXT = /\.(svg|ico|gif|webp)($|\?)/i;

function scoreImageForQuery(img, terms) {
  if (!terms.length) return 0.1;
  const altLower     = (img.alt     || '').toLowerCase();
  const contextLower = (img.context || '').toLowerCase();
  const srcLower     = (img.src     || '').toLowerCase();
  const pageLower    = (img.page_url || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (altLower.includes(term)) score += 3;
    if (contextLower.includes(term)) score += 2.5;
    const filename = srcLower.split('/').pop().split('?')[0];
    if (filename.includes(term)) score += 2;
    if (pageLower.includes(term)) score += 0.5;
  }
  if (img.alt && img.alt.trim().length > 3) score += 0.5;
  if ((!img.alt || img.alt.trim().length < 2) && (!img.context || img.context.trim().length < 5)) score -= 0.5;
  return score;
}

function searchImages(queryText, limit = 80) {
  const terms = tokenize(queryText);

  let candidates;
  if (!terms.length) {
    candidates = all('SELECT src, alt, context, page_url FROM images ORDER BY indexed_at DESC LIMIT 200');
  } else {
    const N = (get('SELECT COUNT(*) as n FROM search_index')?.n) || 1;
    const pageScores = new Map();
    const termStmt = db.prepare('SELECT st.doc_id, st.tf, si.url FROM search_terms st JOIN search_index si ON st.doc_id=si.id WHERE st.term=?');
    for (const term of terms) {
      const rows = termStmt.all(term);
      const idf = Math.log(N / (rows.length || 1)) + 1;
      for (const r of rows) pageScores.set(r.url, (pageScores.get(r.url) || 0) + r.tf * idf);
    }
    const topUrls = [...pageScores.entries()].sort((a,b) => b[1]-a[1]).slice(0, 40).map(([u]) => u);

    const altMatches = [];
    const altStmt = db.prepare('SELECT src, alt, context, page_url FROM images WHERE alt LIKE ? LIMIT 40');
    for (const term of terms.slice(0, 3)) altMatches.push(...altStmt.all(`%${term}%`));

    const fromPages = topUrls.length
      ? all(`SELECT src, alt, context, page_url FROM images WHERE page_url IN (${topUrls.map(()=>'?').join(',')}) LIMIT 200`, topUrls)
      : [];

    candidates = [...altMatches, ...fromPages];
  }

  candidates = candidates.filter(img =>
    img.src && !JUNK_IMG.test(img.src) && !JUNK_EXT.test(img.src) && img.src.startsWith('http'));

  const seen = new Set();
  const scored = [];
  for (const img of candidates) {
    if (seen.has(img.src)) continue;
    seen.add(img.src);
    scored.push({ ...img, domain: domainOf(img.page_url), _score: scoreImageForQuery(img, terms) });
  }

  return scored.sort((a, b) => b._score - a._score).slice(0, limit);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace('www.',''); } catch { return url; }
}

// -- Crawl queue --

function enqueue(url, depth = 0) {
  if (!url.startsWith('http')) return false;
  if (get('SELECT url FROM crawl_visited WHERE url = ?', [url])) return false;
  run('INSERT OR IGNORE INTO crawl_queue (url, depth) VALUES (?, ?)', [url, depth]);
  return true;
}

function dequeue(count = 5) {
  const rows = all('SELECT url, depth FROM crawl_queue ORDER BY queued_at LIMIT ?', [count]);
  const del = db.prepare('DELETE FROM crawl_queue WHERE url = ?');
  const tx = db.transaction((rs) => { for (const r of rs) del.run(r.url); });
  tx(rows);
  return rows;
}

function getIndexStats() {
  const pages = get('SELECT COUNT(*) as count FROM search_index');
  const queue = get('SELECT COUNT(*) as count FROM crawl_queue');
  return { indexed: pages?.count || 0, queued: queue?.count || 0 };
}

function getRandomIndexedPages(count = 30) {
  return all('SELECT url FROM search_index ORDER BY RANDOM() LIMIT ?', [count]);
}

function requeueForExpansion(url) {
  if (!url.startsWith('http')) return false;
  run('INSERT OR IGNORE INTO crawl_queue (url, depth) VALUES (?, ?)', [url, 0]);
  return true;
}

module.exports = {
  ensureDb, flush,
  indexPage, searchPages,
  storeImages, searchImages, domainOf,
  enqueue, dequeue, getIndexStats,
  getRandomIndexedPages, requeueForExpansion,
};
