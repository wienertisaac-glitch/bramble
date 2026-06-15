const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  browserName:    'Bramble',
  theme:          'dark',                      // 'dark' | 'light'
  homePage:       'newtab',                    // 'newtab' | a full https:// URL
  serverUrl:      'http://localhost:8787',     // Bramble indexer (search) endpoint
  resultsPerPage: 30,
  adblock:        true,
  safeSearch:     true,
  searchHistory:  true,                        // record visited pages in history
  maxHistory:     5000,                        // history rows kept (oldest trimmed)
  aiOverview:     false,                        // local AI summaries (downloads a model on first enable)
};

let _settings = null;
let _settingsPath = null;

function getPath() {
  if (!_settingsPath) _settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return _settingsPath;
}

function load() {
  if (_settings) return _settings;
  try {
    const raw = fs.readFileSync(getPath(), 'utf8');
    _settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    _settings = { ...DEFAULTS };
  }
  return _settings;
}

function get(key) {
  return load()[key];
}

function getAll() {
  return { ...load() };
}

function set(key, value) {
  load();
  _settings[key] = value;
  save();
}

function setAll(obj) {
  load();
  _settings = { ...DEFAULTS, ..._settings, ...obj };
  save();
}

function save() {
  fs.writeFileSync(getPath(), JSON.stringify(_settings, null, 2), 'utf8');
}

module.exports = { load, get, getAll, set, setAll, save, DEFAULTS };

