// Local browser data: bookmarks + history only.
// The web index lives on the remote indexer (see src/search-client.js).
// Uses sql.js (pure WASM SQLite) and persists to a file in Electron userData.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Lazy settings access -- avoids a require cycle at module load time
function getSettings() {
  try { return require('./settings'); } catch { return null; }
}

let SQL, db;
let dirty = false;
let dbPath;

// -- Init --

async function ensureDb() {
  if (db) return db;

  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  dbPath = path.join(app.getPath('userData'), 'bramble.db');

  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  initSchema();
  setInterval(flush, 10000); // flush to disk every 10s when dirty
  return db;
}

function flush() {
  if (!dirty || !db) return;
  try {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    dirty = false;
  } catch (e) {
    console.warn('[db] flush error:', e.message);
  }
}

function run(sql, params = []) {
  db.run(sql, params);
  dirty = true;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

// -- Schema --

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      visited_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  dirty = false;
}

// -- Bookmarks --

function addBookmark(url, title) {
  run('INSERT OR REPLACE INTO bookmarks (url, title) VALUES (?, ?)', [url, title]);
}

function removeBookmark(url) {
  run('DELETE FROM bookmarks WHERE url = ?', [url]);
}

function getBookmarks() {
  return all('SELECT * FROM bookmarks ORDER BY created_at DESC');
}

function isBookmarked(url) {
  return !!get('SELECT id FROM bookmarks WHERE url = ?', [url]);
}

// -- History --

function addHistory(url, title) {
  run('INSERT INTO history (url, title) VALUES (?, ?)', [url, title || url]);
  trimHistory();
}

// Keep history bounded to the configured maxHistory (oldest rows trimmed).
// Only checks every 50 inserts to avoid a COUNT on every navigation.
let _historyInserts = 0;
function trimHistory() {
  if (++_historyInserts % 50 !== 0) return;
  const max = Math.max(100, getSettings()?.get('maxHistory') ?? 5000);
  const n = get('SELECT COUNT(*) as n FROM history')?.n || 0;
  if (n <= max) return;
  run('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY visited_at DESC LIMIT ?)', [max]);
}

function getHistory(limit = 200) {
  return all('SELECT * FROM history ORDER BY visited_at DESC LIMIT ?', [limit]);
}

function searchHistory(query) {
  const q = `%${query}%`;
  return all('SELECT * FROM history WHERE url LIKE ? OR title LIKE ? ORDER BY visited_at DESC LIMIT 20', [q, q]);
}

function clearHistory() {
  run('DELETE FROM history');
}

module.exports = {
  ensureDb, flush,
  addBookmark, removeBookmark, getBookmarks, isBookmarked,
  addHistory, getHistory, searchHistory, clearHistory,
};
