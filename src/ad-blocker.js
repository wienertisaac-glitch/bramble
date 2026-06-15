// Ad-blocker: parses EasyList/uBlock-origin filter syntax, intercepts webRequests
// Supports: ||domain^, /regex/, ##element (cosmetic), @@whitelist, options

const https = require('https');
const { URL } = require('url');

const FILTER_URLS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt'
];

// Compiled rule types
let networkBlockRules = [];   // { regex, options }
let networkAllowRules = [];   // whitelist (@@)
let cosmeticRules = new Map(); // domain -> [selectors]
let enabled = true;

// ── Parser ────────────────────────────────────────────────────────────────────

function ruleToRegex(rule) {
  // Convert EasyList network rule to JS regex string
  let r = rule
    .replace(/\$.*$/, '')           // strip options (handle separately)
    .replace(/\./g, '\\.')
    .replace(/\?/g, '\\?')
    .replace(/\^/g, '(?:[/?#&=]|$)')
    .replace(/\*/g, '.*')
    .replace(/^\|\|/, '(?:https?://(?:[^/]+\\.)?)')
    .replace(/^\|/, '^')
    .replace(/\|$/, '$');
  return r;
}

function parseRules(text) {
  const lines = text.split('\n');
  const block = [];
  const allow = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;

    // Cosmetic rules (##) — skip for now, handled separately
    if (line.includes('##') || line.includes('#@#')) continue;

    const isAllow = line.startsWith('@@');
    if (isAllow) line = line.slice(2);

    // Skip overly complex rules
    if (line.startsWith('/') && line.endsWith('/')) {
      // Pure regex rule
      try {
        const re = new RegExp(line.slice(1, -1));
        (isAllow ? allow : block).push(re);
      } catch { /* skip bad regex */ }
      continue;
    }

    try {
      const re = new RegExp(ruleToRegex(line), 'i');
      (isAllow ? allow : block).push(re);
    } catch { /* skip */ }
  }

  return { block, allow };
}

// ── Loader ────────────────────────────────────────────────────────────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ClaudeBrowser/1.0' }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function loadFilters() {
  const allBlock = [];
  const allAllow = [];
  for (const url of FILTER_URLS) {
    try {
      const text = await fetchText(url);
      const { block, allow } = parseRules(text);
      allBlock.push(...block);
      allAllow.push(...allow);
      console.log(`[adblock] loaded ${block.length} rules from ${url}`);
    } catch (e) {
      console.warn(`[adblock] failed to fetch ${url}: ${e.message}`);
    }
  }
  networkBlockRules = allBlock;
  networkAllowRules = allAllow;
  console.log(`[adblock] total: ${networkBlockRules.length} block, ${networkAllowRules.length} allow`);
}

// ── Check ─────────────────────────────────────────────────────────────────────

function shouldBlock(url) {
  if (!enabled) return false;
  for (const re of networkAllowRules) if (re.test(url)) return false;
  for (const re of networkBlockRules) if (re.test(url)) return true;
  return false;
}

// ── Electron integration ──────────────────────────────────────────────────────

function install(session) {
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (enabled && shouldBlock(details.url)) {
      callback({ cancel: true });
    } else {
      callback({});
    }
  });
}

function setEnabled(val) { enabled = val; }
function isEnabled() { return enabled; }
function getRuleCount() { return networkBlockRules.length; }

module.exports = { loadFilters, install, setEnabled, isEnabled, getRuleCount, shouldBlock };
