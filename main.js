const { app, BrowserWindow, WebContentsView, ipcMain, session, protocol, Menu, MenuItem } = require('electron');
const path = require('path');

// Register search: as a privileged custom scheme BEFORE app ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'search', privileges: { standard: false, secure: true, bypassCSP: true, stream: false } }
]);

// Modules (loaded after app ready so userData path is available)
let db, adBlocker, settings;

const aiOverview   = require('./src/ai-overview');
const searchClient = require('./src/search-client');

// -- "" State """""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

let mainWindow = null;
let isPrivateMode = false;
let privateSession = null;

// Tab state: id -> { view, url, title, loading, favicon }
const tabs = new Map();
let activeTabId = null;
let nextTabId = 1;

const CHROME_HEIGHT = 88;  // px reserved for browser UI at top
const STATUS_HEIGHT = 22;  // px status bar at bottom

// -- "" Helpers """""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

function getSession() {
  if (isPrivateMode) {
    if (!privateSession) {
      privateSession = session.fromPartition('private:incognito', { cache: false });
      adBlocker.install(privateSession);
      registerSearchProtocol(privateSession);
    }
    return privateSession;
  }
  return session.defaultSession;
}

const PANEL_WIDTH      = 340;
const DROPDOWN_WIDTH   = 215;
const SUGGESTIONS_PUSH = 300;  // extra px to push BrowserView down when suggestions open
let panelOpen       = false;
let dropdownOpen    = false;
let suggestionsOpen = false;

function tabBounds() {
  const [w, h] = mainWindow.getContentSize();
  const rightCut = panelOpen ? PANEL_WIDTH : (dropdownOpen ? DROPDOWN_WIDTH : 0);
  const topPush  = suggestionsOpen ? SUGGESTIONS_PUSH : 0;
  return {
    x: 0,
    y: CHROME_HEIGHT + topPush,
    width:  w - rightCut,
    height: h - CHROME_HEIGHT - topPush - STATUS_HEIGHT
  };
}

function resizeActiveTab() {
  const t = tabs.get(activeTabId);
  if (t) t.view.setBounds(tabBounds());
}

function notifyUI(event, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, ...args);
  }
}

function tabSnapshot() {
  const list = [];
  for (const [id, t] of tabs) {
    list.push({ id, url: t.url, title: t.title, loading: t.loading, active: id === activeTabId, private: isPrivateMode });
  }
  return list;
}

// -- "" Tab management """"""""""""""""""""""""""""""""""""""""""""""""""""""""""""

function createTab(url = 'about:blank') {
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      session: getSession(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webRTCIPHandlingPolicy: 'disable_non_proxied_udp'
    }
  });

  tabs.set(id, { view, url, title: url, loading: false });
  mainWindow.contentView.addChildView(view);

  const wc = view.webContents;

  wc.on('did-start-loading', () => {
    const t = tabs.get(id);
    if (t) { t.loading = true; notifyUI('tabs:updated', tabSnapshot()); }
  });

  wc.on('did-stop-loading', () => {
    const t = tabs.get(id);
    if (!t) return;
    t.loading = false;
    t.url = wc.getURL();
    notifyUI('tabs:updated', tabSnapshot());
    notifyUI('nav:state', { url: t.url, canBack: wc.canGoBack(), canForward: wc.canGoForward() });
  });

  wc.on('page-title-updated', (_, title) => {
    const t = tabs.get(id);
    if (!t) return;
    t.title = title;
    notifyUI('tabs:updated', tabSnapshot());
  });

  wc.on('did-navigate', (_, navUrl) => {
    const t = tabs.get(id);
    if (!t) return;
    t.url = navUrl;
    notifyUI('nav:state', { url: navUrl, canBack: wc.canGoBack(), canForward: wc.canGoForward() });

    // Record history (skip private mode, internal pages, and when the user
    // has turned off history saving in settings)
    if (!isPrivateMode && navUrl.startsWith('http') && settings.get('searchHistory') !== false) {
      db.addHistory(navUrl, t.title || navUrl);
    }
  });

  wc.on('did-navigate-in-page', (_, navUrl) => {
    const t = tabs.get(id);
    if (t) { t.url = navUrl; notifyUI('nav:state', { url: navUrl, canBack: wc.canGoBack(), canForward: wc.canGoForward() }); }
  });

  // Intercept all navigations -- run through resolveUrl / AI search path
  wc.on('will-navigate', (e, navUrl) => {
    if (navUrl.includes('newtab.html')) return;
    if (navUrl.startsWith('data:')) return;

    // search: is now handled by the protocol handler -- only catch stray file:// navigations
    if (!navUrl.startsWith('file://')) return;

    e.preventDefault();

    // file:// from newtab -- extract typed text as query
    const parts = navUrl.split('/');
    const query = decodeURIComponent(parts[parts.length - 1]);

    if (!query || query.endsWith('.html')) return; // let real file navigations through
    if (isSearchQuery(query)) {
      wc.loadURL(`search:web:${encodeURIComponent(query)}`);
    } else {
      const resolved = resolveUrl(query);
      if (resolved === 'newtab') wc.loadFile(path.join(__dirname, 'renderer', 'newtab.html'));
      else wc.loadURL(resolved);
    }
  });

  wc.setWindowOpenHandler(({ url: newUrl }) => {
    createTab(newUrl);
    switchTab(nextTabId - 1);
    return { action: 'deny' };
  });

  // Context menu
  wc.on('context-menu', (_, params) => {
    const menu = new Menu();
    if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
      menu.append(new MenuItem({ label: `Search for "${params.selectionText.slice(0,30)}"`, async click() {
        const q = params.selectionText;
        const safe = settings.get('safeSearch') !== false;
        const data = await searchClient.search(q, 'web', { safe });
        notifyUI('search:results', { query: q, results: data.results || [] });
      }}));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({ label: 'Open Link in New Tab', click() { createTab(params.linkURL); switchTab(nextTabId-1); } }));
      menu.append(new MenuItem({ label: 'Copy Link', click() { require('electron').clipboard.writeText(params.linkURL); } }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Back', enabled: wc.canGoBack(), click() { wc.goBack(); } }));
    menu.append(new MenuItem({ label: 'Forward', enabled: wc.canGoForward(), click() { wc.goForward(); } }));
    menu.append(new MenuItem({ label: 'Reload', click() { wc.reload(); } }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Inspect Element', click() { wc.inspectElement(params.x, params.y); } }));
    menu.popup({ window: mainWindow });
  });

  switchTab(id);
  if (url === 'newtab') {
    view.webContents.loadFile(path.join(__dirname, 'renderer', 'newtab.html'));
  } else if (url !== 'about:blank') {
    view.webContents.loadURL(url);
  }
  return id;
}

function switchTab(id) {
  const target = tabs.get(id);
  if (!target) return;

  // Hide all others, show + size the target
  for (const [tid, t] of tabs) {
    t.view.setVisible(tid === id);
  }
  target.view.setBounds(tabBounds());

  activeTabId = id;
  // Re-adding moves the view to the top of the z-order (replaces setTopBrowserView)
  mainWindow.contentView.addChildView(target.view);
  notifyUI('tabs:updated', tabSnapshot());
  const wc = target.view.webContents;
  notifyUI('nav:state', { url: target.url, canBack: wc.canGoBack(), canForward: wc.canGoForward() });
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  mainWindow.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);

  if (tabs.size === 0) {
    createTab('about:blank');
    return;
  }

  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    switchTab(remaining[remaining.length - 1]);
  }
  notifyUI('tabs:updated', tabSnapshot());
}

// -- "" URL resolution """"""""""""""""""""""""""""""""""""""""""""""""""""""""""""

// search:web:javascript  or  search:javascript  (legacy)
function parseSearchUrl(url) {
  const body = url.slice('search:'.length);
  const tabs = ['web','images','news'];
  for (const t of tabs) {
    if (body.startsWith(t + ':')) return { tab: t, query: decodeURIComponent(body.slice(t.length + 1)) };
  }
  return { tab: 'web', query: decodeURIComponent(body) };
}

function isSearchQuery(input) {
  if (!input) return false;
  if (input === 'newtab') return false;
  if (input.startsWith('about:') || input.startsWith('file:') || input.startsWith('data:')) return false;
  if (input.startsWith('search:')) return true;
  if (/^https?:\/\//i.test(input)) return false;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/.test(input)) return false;
  return true;
}

function resolveUrl(input) {
  input = input.trim();
  if (!input) return 'newtab';
  if (input === 'newtab') return 'newtab';
  if (input.startsWith('about:') || input.startsWith('file:') || input.startsWith('data:')) return input;
  if (input.startsWith('search:')) return input;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/.test(input)) return `https://${input}`;
  // Search query -- route through the search: protocol (served from the remote indexer)
  return `search:web:${encodeURIComponent(input)}`;
}

function buildSearchPage(query, results, stats = {}, tab = 'web', images = [], aiSummary = null) {
  const s          = settings ? settings.getAll() : {};
  const theme      = s.theme === 'light' ? 'light' : 'dark';
  const safeSearch = s.safeSearch !== false;
  const indexed = (stats.indexed || 0).toLocaleString();
  const queued  = (stats.queued  || 0).toLocaleString();
  const qEnc    = encodeURIComponent(query);

  const crawlStatus = stats.queued > 0
    ? `<span class="crawling">&#9679; Crawling (${queued} queued)</span>`
    : `<span class="idle">&#9679; Idle</span>`;

  // -- Tab content --
  let content = '';

  if (tab === 'images') {
    const nsfwCount = images.filter(i => i.nsfw).length;
    // Always show the safe-search toggle on image results
    const nsfwBar = images.length ? `<div class="nsfw-bar">
      <span>&#128444; ${images.length} image${images.length!==1?'s':''}${nsfwCount?' &nbsp;&#183;&nbsp; &#128286; '+nsfwCount+' sensitive':''}</span>
      <label class="nsfw-toggle">
        <input type="checkbox" id="unblur-all" onchange="toggleBlur(this.checked)" ${safeSearch?'':'checked'}>
        <span class="nsfw-track"></span>
        <span style="font-size:12px;margin-left:6px">Show sensitive</span>
      </label>
    </div>` : '';

    content = images.length
      ? `${nsfwBar}<div class="img-grid">${images.map(img => {
          const nsfw = img.nsfw ? 'nsfw' : '';
          return `<div class="img-card ${nsfw}" onclick="imgClick(event,this,'${escHtml(img.page_url)}')" title="${escHtml(img.alt || img.src)}">
            <div class="img-wrap">
              <img src="${escHtml(img.src)}" alt="${escHtml(img.alt || '')}" loading="lazy"
                   onerror="this.closest('.img-card').style.display='none'">
              ${img.nsfw ? `<div class="nsfw-overlay">
                <span class="nsfw-icon">&#128286;</span>
                <span class="nsfw-label">Sensitive</span>
                <button class="nsfw-reveal" onclick="revealOne(event,this)">Tap to reveal</button>
              </div>` : ''}
            </div>
            <div class="img-caption">${escHtml(img.alt || img.domain || '')}</div>
          </div>`;
        }).join('')}
        </div>`
      : `<div class="no-results"><div class="no-results-icon">&#128444;</div>
          <p>No images indexed for <strong>${escHtml(query)}</strong></p>
          <p class="hint">Images are collected while browsing. Visit more pages to build the image index.</p>
         </div>`;
  } else {
    const aiBox = aiSummary ? `
      <div class="ai-overview">
        <div class="ai-overview-header">&#10024; AI Overview</div>
        <div class="ai-overview-body">${escHtml(aiSummary)}</div>
      </div>` : '';

    content = results.length
      ? aiBox + results.map((r, i) => {
          let domain = r.url;
          try { domain = new URL(r.url).hostname.replace('www.',''); } catch {}
          const date = tab === 'news' && r.visited_at
            ? `<span class="news-date">${new Date(r.visited_at * 1000).toLocaleDateString()}</span>` : '';
          return `<div class="result">
            <div class="result-num">${i+1}</div>
            <div class="result-body">
              ${date}
              <a class="result-title" href="${escHtml(r.url)}">${escHtml(r.title || r.url)}</a>
              <div class="result-url">${escHtml(domain)}</div>
              ${r.excerpt ? `<p class="result-snippet">${r.excerpt}</p>` : ''}
            </div>
          </div>`;
        }).join('')
      : `<div class="no-results">
          <div class="no-results-icon">${tab==='news'?'&#128240;':'&#128269;'}</div>
          <p>No ${tab==='news'?'news ':''}results for <strong>${escHtml(query)}</strong></p>
          <p class="hint">${indexed} pages indexed${stats.queued>0?`, ${queued} crawling`:''}${stats.indexed<50?'<br>Index still building -- try again soon':''}.</p>
         </div>`;
  }

  const D = theme === 'light' ? {
    bg:'#f8f9fa', bg2:'#ffffff', bg3:'#e9ecef', border:'#dee2e6',
    text:'#212529', textDim:'#6c757d', textMid:'#495057',
    accent:'#7048e8', accentText:'#ffffff',
    link:'#7048e8', url:'#198754', snippet:'#495057',
    statsBg:'#ffffff', crawling:'#198754', idle:'#adb5bd',
    imgBg:'#e9ecef', noResText:'#6c757d', hintText:'#adb5bd'
  } : {
    bg:'#0f0f17', bg2:'#181825', bg3:'#252535', border:'#313145',
    text:'#cdd6f4', textDim:'#6c7086', textMid:'#a6adc8',
    accent:'#a78bfa', accentText:'#0f0f17',
    link:'#a78bfa', url:'#64a07a', snippet:'#a6adc8',
    statsBg:'#181825', crawling:'#a6e3a1', idle:'#45475a',
    imgBg:'#1a1a2e', noResText:'#6c7086', hintText:'#45475a'
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(query)} &mdash; Bramble</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:${D.bg};color:${D.text};min-height:100vh}
  header{background:${D.bg2};border-bottom:1px solid ${D.border};padding:12px 20px;display:flex;align-items:center;gap:16px}
  .logo{font-size:1.1em;font-weight:800;white-space:nowrap;background:linear-gradient(135deg,#a78bfa,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;flex-shrink:0}
  .search-bar{flex:1;max-width:560px;display:flex;gap:8px}
  .search-bar input{flex:1;padding:8px 13px;background:${D.bg3};border:1px solid ${D.border};border-radius:8px;color:${D.text};font-size:14px;outline:none;transition:border-color .15s}
  .search-bar input:focus{border-color:${D.accent}}
  .search-bar button{padding:8px 16px;background:${D.accent};border:none;border-radius:8px;color:${D.accentText};font-weight:700;cursor:pointer;font-size:13px}
  .search-bar button:hover{opacity:.85}
  .tab-bar{background:${D.bg2};border-bottom:1px solid ${D.border};padding:0 20px;display:flex;gap:4px}
  .tab-btn{padding:10px 16px;font-size:13px;color:${D.textDim};cursor:pointer;border:none;background:transparent;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;display:flex;align-items:center;gap:6px}
  .tab-btn:hover{color:${D.text}}
  .tab-btn.active{color:${D.accent};border-bottom-color:${D.accent};font-weight:600}
  .stats-bar{padding:5px 20px;font-size:11px;color:${D.textDim};background:${D.statsBg};display:flex;gap:14px}
  .crawling{color:${D.crawling}}.idle{color:${D.idle}}
  main{max-width:760px;padding:16px 20px}
  .result-count{font-size:12px;color:${D.textDim};margin-bottom:14px}
  .result{display:flex;gap:10px;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid ${D.bg3}}
  .result:last-child{border-bottom:none}
  .result-num{color:${D.textDim};font-size:12px;min-width:20px;padding-top:2px;text-align:right;flex-shrink:0}
  .result-body{flex:1;min-width:0}
  .result-title{display:block;font-size:.98em;color:${D.link};text-decoration:none;margin-bottom:2px;line-height:1.4}
  .result-title:hover{text-decoration:underline}
  .result-url{font-size:11px;color:${D.url};margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .result-snippet{font-size:13px;color:${D.snippet};line-height:1.55}
  .result-snippet b{color:${D.text};font-weight:600}
  .news-date{font-size:11px;color:${D.textDim};display:block;margin-bottom:3px}
  .img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:4px 0}
  .img-card{display:flex;flex-direction:column;background:${D.bg3};border:1px solid ${D.border};border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .15s,transform .1s}
  .img-card:hover{border-color:${D.accent};transform:translateY(-2px)}
  .img-wrap{position:relative;overflow:hidden}
  .img-card img{width:100%;height:130px;object-fit:cover;background:${D.imgBg};display:block;transition:filter .3s}
  .img-card.nsfw img{filter:blur(18px) brightness(.7)}
  .img-card.nsfw.revealed img{filter:none}
  .img-caption{font-size:10px;color:${D.textDim};padding:5px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nsfw-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:rgba(0,0,0,.35);pointer-events:none}
  .img-card.revealed .nsfw-overlay{display:none}
  .nsfw-icon{font-size:22px}.nsfw-label{font-size:11px;color:#f8c8c8;font-weight:600}
  .nsfw-reveal{pointer-events:all;margin-top:4px;padding:4px 10px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:20px;color:#fff;font-size:10px;cursor:pointer}
  .nsfw-reveal:hover{background:rgba(255,255,255,.25)}
  .nsfw-bar{display:flex;align-items:center;justify-content:space-between;background:#1e1218;border:1px solid rgba(248,113,113,.2);border-radius:10px;padding:8px 14px;margin-bottom:12px;font-size:12px;color:#f87171}
  .nsfw-toggle{display:flex;align-items:center;cursor:pointer}
  .nsfw-toggle input{display:none}
  .nsfw-track{width:34px;height:18px;background:#3f1f1f;border-radius:9px;position:relative;transition:background .2s;flex-shrink:0}
  .nsfw-track::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#6b2020;transition:transform .2s,background .2s}
  .nsfw-toggle input:checked+.nsfw-track{background:rgba(248,113,113,.4)}
  .nsfw-toggle input:checked+.nsfw-track::after{transform:translateX(16px);background:#f87171}
  .ai-overview{background:${D.bg2};border:1px solid ${D.accent}44;border-radius:12px;padding:16px 18px;margin-bottom:20px;position:relative}
  .ai-overview-header{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${D.accent};margin-bottom:8px}
  .ai-overview-body{font-size:14px;color:${D.text};line-height:1.65}
  .no-results{text-align:center;padding:50px 20px;color:${D.noResText}}
  .no-results-icon{font-size:2.8em;margin-bottom:14px}
  .no-results p{margin-bottom:6px;font-size:14px}
  .no-results strong{color:${D.text}}
  .hint{font-size:12px;color:${D.hintText};line-height:1.6;margin-top:8px}
</style>
</head>
<body>
<header>
  <div class="logo">&#11041; Bramble</div>
  <form class="search-bar" onsubmit="go(event,'${tab}')">
    <input id="q" type="text" value="${escHtml(query)}" placeholder="Search...">
    <button type="submit">Search</button>
  </form>
</header>
<div class="tab-bar">
  <button class="tab-btn ${tab==='web'?'active':''}"    onclick="go(null,'web')">Web</button>
  <button class="tab-btn ${tab==='images'?'active':''}" onclick="go(null,'images')">&#128444; Images</button>
  <button class="tab-btn ${tab==='news'?'active':''}"   onclick="go(null,'news')">News</button>
</div>
<div class="stats-bar">
  <span>&#128196; ${indexed} indexed</span>
  <span>&#128279; ${queued} queued</span>
  ${crawlStatus}
</div>
<main>
  ${results.length && tab!=='images' ? `<p class="result-count">About ${results.length} result${results.length!==1?'s':''}</p>` : ''}
  ${content}
</main>
<script>
  function go(e, tab){
    if(e) e.preventDefault();
    const q=document.getElementById('q').value.trim()||${JSON.stringify(query)};
    window.location.href='search:'+tab+':'+encodeURIComponent(q);
  }
  function revealOne(e, btn){
    e.stopPropagation();
    btn.closest('.img-card').classList.add('revealed');
  }
  function toggleBlur(showAll){
    document.querySelectorAll('.img-card.nsfw').forEach(c=>{
      c.classList.toggle('revealed', showAll);
    });
  }
  function imgClick(e, card, url){
    if(card.classList.contains('nsfw') && !card.classList.contains('revealed')) return;
    window.open(url,'_blank');
  }
</script>
</body></html>`;
}

// -- "" Search protocol handler """""""""""""""""""""""""""""""""""""""""""""""""""

function registerSearchProtocol(sess) {
  sess.protocol.handle('search', async (request) => {
    try {
      const { query, tab } = parseSearchUrl(request.url);
      const safeSearch = settings ? settings.get('safeSearch') !== false : true;
      const limit = settings ? settings.get('resultsPerPage') || 30 : 30;
      let results = [], images = [], stats = { indexed: 0, queued: 0 };

      if (tab === 'images') {
        // Server returns an nsfw flag per image; safe-search controls blurring in the page.
        const data = await searchClient.images(query);
        images = (data.images || []).map(i => ({ ...i, nsfw: safeSearch ? i.nsfw : false }));
        stats  = data.stats || stats;
      } else {
        // Server applies news filtering (tab) and explicit-content filtering (safe).
        const data = await searchClient.search(query, tab === 'news' ? 'news' : 'web', { safe: safeSearch, limit });
        results = data.results || [];
        stats   = data.stats || stats;
      }

      // AI overview (local model) -- only when enabled and loaded. Run with a
      // 20s timeout so a slow CPU summary never blocks the results page.
      let aiSummary = null;
      const aiEnabled = settings && settings.get('aiOverview') === true;
      if (tab === 'web' && results.length && aiEnabled && aiOverview.isReady()) {
        try {
          aiSummary = await Promise.race([
            aiOverview.generate(query, results),
            new Promise(r => setTimeout(() => r(null), 20000))
          ]);
        } catch {}
      }

      const html = buildSearchPage(query, results, stats, tab, images, aiSummary);
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } catch (e) {
      console.error('[search protocol]', e);
      return new Response(`<h2>Search error: ${escHtml(e.message)}</h2>`, { headers: { 'content-type': 'text/html' } });
    }
  });
}

// -- "" Search dispatcher """""""""""""""""""""""""""""""""""""""""""""""""""""""""
// Content classification (NSFW / news) lives on the indexer server. The client
// just navigates to the search: protocol, which fetches from the server.

function performSearch(query, tab, targetWc) {
  // Navigate to search: protocol -- handled by registerSearchProtocol
  targetWc.loadURL(`search:${tab}:${encodeURIComponent(query)}`);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// -- "" IPC Handlers """"""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

function registerIPC() {
  ipcMain.handle('tab:new', (_, url) => {
    const id = createTab(url ? resolveUrl(url) : 'newtab');
    return id;
  });
  ipcMain.handle('tab:close', (_, id) => closeTab(id));
  ipcMain.handle('tab:switch', (_, id) => switchTab(id));
  ipcMain.handle('tab:list', () => tabSnapshot());

  ipcMain.handle('nav:go', async (_, url) => {
    const t = tabs.get(activeTabId);
    if (!t) return;

    if (url.startsWith('search:')) {
      const { query, tab } = parseSearchUrl(url);
      performSearch(query, tab, t.view.webContents);
      return;
    }

    const input = url.trim();
    if (isSearchQuery(input)) {
      t.view.webContents.loadURL(`search:web:${encodeURIComponent(input)}`);
      return;
    }

    const resolved = resolveUrl(input);
    t.url = resolved;
    if (resolved === 'newtab') {
      t.view.webContents.loadFile(path.join(__dirname, 'renderer', 'newtab.html'));
    } else {
      t.view.webContents.loadURL(resolved);
    }
  });
  ipcMain.handle('nav:back', () => tabs.get(activeTabId)?.view.webContents.goBack());
  ipcMain.handle('nav:forward', () => tabs.get(activeTabId)?.view.webContents.goForward());
  ipcMain.handle('nav:reload', () => tabs.get(activeTabId)?.view.webContents.reload());
  ipcMain.handle('nav:stop', () => tabs.get(activeTabId)?.view.webContents.stop());

  ipcMain.handle('bookmark:add', (_, url, title) => db.addBookmark(url, title));
  ipcMain.handle('bookmark:remove', (_, url) => db.removeBookmark(url));
  ipcMain.handle('bookmark:list', () => db.getBookmarks());
  ipcMain.handle('bookmark:check', (_, url) => db.isBookmarked(url));

  ipcMain.handle('history:list', () => db.getHistory(200));
  ipcMain.handle('history:clear', () => db.clearHistory());

  // Search runs against the remote indexer. Used by address-bar suggestions,
  // the search panel, and the context-menu "search selection" action.
  ipcMain.handle('search:query', async (_, q) => {
    const safe = settings.get('safeSearch') !== false;
    const data = await searchClient.search(q, 'web', { safe });
    return data.results || [];
  });
  ipcMain.handle('search:stats', () => searchClient.stats());

  ipcMain.handle('adblock:set', (_, val) => adBlocker.setEnabled(val));
  ipcMain.handle('adblock:get', () => adBlocker.isEnabled());
  ipcMain.handle('adblock:count', () => adBlocker.getRuleCount());

  ipcMain.handle('private:set', (_, val) => {
    isPrivateMode = val;
    if (!val && privateSession) privateSession.clearStorageData();
  });
  ipcMain.handle('private:get', () => isPrivateMode);

  // Panel/dropdown visibility -- shrinks BrowserView so overlays are visible
  ipcMain.handle('panel:open',    () => { panelOpen = true;    resizeActiveTab(); });
  ipcMain.handle('panel:close',   () => { panelOpen = false;   resizeActiveTab(); });
  ipcMain.handle('dropdown:open',     () => { dropdownOpen    = true;  resizeActiveTab(); });
  ipcMain.handle('dropdown:close',    () => { dropdownOpen    = false; resizeActiveTab(); });
  ipcMain.handle('suggestions:open',  () => { suggestionsOpen = true;  resizeActiveTab(); });
  ipcMain.handle('suggestions:close', () => { suggestionsOpen = false; resizeActiveTab(); });

  // Settings (all client-side: theme, homepage, indexer URL, privacy prefs)
  ipcMain.handle('settings:get',    ()        => settings.getAll());
  ipcMain.handle('settings:set',    (_, k, v) => settings.set(k, v));
  ipcMain.handle('settings:setAll', (_, obj)  => settings.setAll(obj));

  // AI Overview (local model, off by default; downloads on first enable)
  ipcMain.handle('ai:status', () => aiStatus());
  ipcMain.handle('ai:enable', async (_, val) => {
    settings.set('aiOverview', !!val);
    if (val) startAiLoad();   // download/load in the background; progress via 'ai:progress'
    return aiStatus();
  });
}

function aiStatus() {
  return {
    enabled:  settings ? settings.get('aiOverview') === true : false,
    ready:    aiOverview.isReady(),
    loading:  aiOverview.isLoading(),
    progress: aiOverview.getProgress(),
    model:    aiOverview.getModel(),
  };
}

// Load (and on first run, download) the local AI model, reporting progress to the UI.
function startAiLoad() {
  if (aiOverview.isReady() || aiOverview.isLoading()) return;
  const cacheDir = path.join(app.getPath('userData'), 'models');
  aiOverview.load(cacheDir, (p) => notifyUI('ai:progress', { ...p, ...aiStatus() }))
    .then(() => notifyUI('ai:progress', { status: 'ready', ...aiStatus() }))
    .catch(e => console.warn('[ai] load failed:', e.message));
}

// -- "" Window """"""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    frame: true,
    title: 'Bramble',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // preload needs Node APIs
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', () => resizeActiveTab());

  mainWindow.webContents.on('did-finish-load', () => {
    // Open the configured homepage on launch (defaults to the new-tab page)
    const home = (settings.get('homePage') || 'newtab').trim();
    createTab(home === 'newtab' ? 'newtab' : resolveUrl(home));
  });
}

// -- "" App lifecycle """""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

app.whenReady().then(async () => {
  db        = require('./src/database');
  adBlocker = require('./src/ad-blocker');
  settings  = require('./src/settings');

  // Init local DB (bookmarks + history). Async -- sql.js WASM load.
  await db.ensureDb();

  // Install ad-blocker on default session before any windows open
  adBlocker.install(session.defaultSession);

  // Load filter lists in background (don't block startup)
  adBlocker.loadFilters().catch(e => console.warn('Adblock filter load failed:', e.message));

  registerIPC();
  createWindow();

  // Register search: protocol handler on default session (fetches from indexer)
  registerSearchProtocol(session.defaultSession);

  // Apply saved adblock setting
  adBlocker.setEnabled(settings.get('adblock') !== false);

  // If the user previously enabled AI overviews, load the (already-cached) model
  if (settings.get('aiOverview') === true) startAiLoad();
});

app.on('window-all-closed', () => {
  db.flush();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  db.flush();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

