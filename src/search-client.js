// Search client -- talks to the remote Bramble indexer over HTTP.
// The browser no longer crawls or indexes locally; it queries the server.

const http  = require('http');
const https = require('https');

function getSettings() {
  try { return require('./settings'); } catch { return null; }
}

function baseUrl() {
  const u = getSettings()?.get('serverUrl') || 'http://localhost:8787';
  return u.replace(/\/+$/, '');
}

function getJson(pathAndQuery, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(baseUrl() + pathAndQuery); }
    catch { return resolve(null); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// tab: 'web' | 'news'.  safe: boolean (filter explicit results server-side).
async function search(query, tab = 'web', { safe = true, limit = 30 } = {}) {
  if (!query || !query.trim()) return { query: '', results: [], stats: { indexed: 0, queued: 0 } };
  const qs = `?q=${encodeURIComponent(query.trim())}&tab=${encodeURIComponent(tab)}&safe=${safe ? 1 : 0}&limit=${limit}`;
  const data = await getJson('/api/search' + qs);
  return data || { query, results: [], stats: { indexed: 0, queued: 0 } };
}

async function images(query) {
  const qs = `?q=${encodeURIComponent((query || '').trim())}`;
  const data = await getJson('/api/images' + qs);
  return data || { query, images: [], stats: { indexed: 0, queued: 0 } };
}

async function stats() {
  const data = await getJson('/api/stats', 4000);
  return data || { indexed: 0, queued: 0 };
}

module.exports = { search, images, stats, baseUrl };
