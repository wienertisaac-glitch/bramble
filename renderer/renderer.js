/* -- Bramble Browser Renderer -- */

const api = window.browser;

// -- State ---------------------------------------------------------------------
let tabs = [];
let activeTabId = null;
let isPrivate = false;
let adblockOn = true;
let suggestionIndex = -1;
let suggestionsData = [];
let panelMode = null;   // null | 'bookmarks' | 'history' | 'search-panel'
let statsInterval = null;

// -- Elements ------------------------------------------------------------------
const tabsContainer = document.getElementById('tabs-container');
const btnNewTab     = document.getElementById('btn-new-tab');
const btnBack       = document.getElementById('btn-back');
const btnForward    = document.getElementById('btn-forward');
const btnReload     = document.getElementById('btn-reload');
const addressBar    = document.getElementById('address-bar');
const suggestions   = document.getElementById('suggestions');
const btnBookmark   = document.getElementById('btn-bookmark');
const btnPrivate    = document.getElementById('btn-private');
const btnAdblock    = document.getElementById('btn-adblock');
const btnMenu       = document.getElementById('btn-menu');
const panel         = document.getElementById('panel');
const panelTitle    = document.getElementById('panel-title');
const panelContent  = document.getElementById('panel-content');
const btnPanelClose = document.getElementById('btn-panel-close');
const dropMenu      = document.getElementById('dropdown-menu');
const statusText    = document.getElementById('status-text');
const adblockCount  = document.getElementById('adblock-count');
const indexStats    = document.getElementById('index-stats');
const lockIcon      = document.getElementById('lock-icon');

// -- Tabs ----------------------------------------------------------------------

function renderTabs() {
  tabsContainer.innerHTML = '';
  for (const t of tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (t.active ? ' active' : '') + (t.private ? ' private' : '');
    div.dataset.id = t.id;

    const icon = document.createElement('div');
    icon.className = 'tab-favicon';
    if (t.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      icon.appendChild(spinner);
    } else {
      icon.innerHTML = '&#127760;';
    }

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = t.title || t.url || 'New Tab';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&#10005;';
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      api.closeTab(t.id);
    });

    div.appendChild(icon);
    div.appendChild(title);
    div.appendChild(closeBtn);
    div.addEventListener('click', () => api.switchTab(t.id));

    tabsContainer.appendChild(div);
  }
}

// -- Address bar ---------------------------------------------------------------

function updateAddressBar(url) {
  if (document.activeElement !== addressBar) {
    let display = url;
    if (url.startsWith('search:')) {
      const parts = url.slice(7).split(':');
      if (['web','images','news'].includes(parts[0])) parts.shift();
      display = decodeURIComponent(parts.join(':'));
    } else if (url.includes('newtab.html') || url === 'newtab' || url === 'about:blank') {
      display = '';
    }
    addressBar.value = display;
  }
  // Lock icon
  if (url.startsWith('https://')) {
    lockIcon.innerHTML = '&#128274;';
    lockIcon.style.opacity = '0.8';
    lockIcon.style.color = '#a6e3a1';
  } else if (url.startsWith('http://')) {
    lockIcon.innerHTML = '&#9888;';
    lockIcon.style.opacity = '0.8';
    lockIcon.style.color = '#f9e2af';
  } else {
    lockIcon.innerHTML = '&#128274;';
    lockIcon.style.opacity = '0.3';
    lockIcon.style.color = '';
  }
}

async function updateBookmarkButton(url) {
  if (!url || !url.startsWith('http')) {
    btnBookmark.classList.remove('bookmarked');
    return;
  }
  const bm = await api.isBookmarked(url);
  btnBookmark.classList.toggle('bookmarked', bm);
}

// -- Suggestions ---------------------------------------------------------------

let suggestTimer = null;
async function updateSuggestions(query) {
  if (!query.trim()) { hideSuggestions(); return; }

  // Pull matches from the local search index + history
  const results = await api.search(query).catch(() => []);
  suggestionsData = results.slice(0, 8);

  suggestions.innerHTML = '';

  if (suggestionsData.length) {
    const sec = document.createElement('div');
    sec.className = 'sug-section';
    sec.textContent = 'Search Results';
    suggestions.appendChild(sec);

    for (const r of suggestionsData) {
      const div = document.createElement('div');
      div.className = 'suggestion';
      div.innerHTML = `
        <span class="sug-icon">&#128269;</span>
        <span class="sug-title">${esc(r.title || r.url)}</span>
        <span class="sug-url">${esc(shortUrl(r.url))}</span>`;
      div.addEventListener('click', () => navigate(r.url));
      suggestions.appendChild(div);
    }
  }

  // Always show "Search for X" option
  const searchDiv = document.createElement('div');
  searchDiv.className = 'suggestion';
  searchDiv.innerHTML = `<span class="sug-icon">&#128269;</span><span class="sug-title">Search: <em>${esc(query)}</em></span>`;
  searchDiv.addEventListener('click', () => navigate(query));
  suggestions.appendChild(searchDiv);

  suggestions.classList.add('visible');
  suggestionIndex = -1;
  showSuggestionsContainer();
}

let suggestionsVisible = false;

function showSuggestionsContainer() {
  // Position the fixed dropdown to align with the address bar
  const rect = addressBar.getBoundingClientRect();
  suggestions.style.top   = (rect.bottom + 6) + 'px';
  suggestions.style.left  = rect.left + 'px';
  suggestions.style.width = rect.width + 'px';

  if (!suggestionsVisible) {
    suggestionsVisible = true;
    api.suggestionsOpened();
  }
}

function hideSuggestions() {
  suggestions.classList.remove('visible');
  suggestions.innerHTML = '';
  suggestionIndex = -1;
  suggestionsData = [];
  if (suggestionsVisible) {
    suggestionsVisible = false;
    api.suggestionsClosed();
  }
}

function moveSuggestion(dir) {
  const items = suggestions.querySelectorAll('.suggestion');
  if (!items.length) return;
  items.forEach(i => i.classList.remove('focused'));
  suggestionIndex = (suggestionIndex + dir + items.length + 1) % (items.length + 1) - 1;
  if (suggestionIndex >= 0 && suggestionIndex < items.length) {
    items[suggestionIndex].classList.add('focused');
    const d = suggestionsData[suggestionIndex];
    if (d) addressBar.value = d.url;
  }
}

// -- Navigation ----------------------------------------------------------------

function navigate(url) {
  hideSuggestions();
  addressBar.blur();
  api.navigate(url);
}

// -- Panel ---------------------------------------------------------------------

async function openPanel(mode) {
  panelMode = mode;
  panel.classList.remove('hidden');
  api.panelOpened();
  if (statsInterval) clearInterval(statsInterval);

  if (mode === 'bookmarks') {
    panelTitle.innerHTML = '&#11088; Bookmarks';
    await renderBookmarks();
  } else if (mode === 'history') {
    panelTitle.innerHTML = '&#128336; History';
    await renderHistory();
  } else if (mode === 'search-panel') {
    panelTitle.innerHTML = '&#128269; Search Index';
    await renderSearchPanel();
    statsInterval = setInterval(renderSearchPanel, 3000);
  } else if (mode === 'settings') {
    panelTitle.innerHTML = '&#9881; Settings';
    await renderSettings();
  }
}

function closePanel() {
  panel.classList.add('hidden');
  panelMode = null;
  api.panelClosed();
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
}

async function renderBookmarks() {
  const bms = await api.getBookmarks();
  panelContent.innerHTML = '';

  if (!bms.length) {
    panelContent.innerHTML = '<div class="panel-empty">No bookmarks yet.<br>Click &#11088; to bookmark a page.</div>';
    return;
  }

  for (const bm of bms) {
    const div = document.createElement('div');
    div.className = 'panel-item';
    div.innerHTML = `
      <span class="panel-item-icon">&#11088;</span>
      <div class="panel-item-body">
        <div class="panel-item-title">${esc(bm.title)}</div>
        <div class="panel-item-url">${esc(shortUrl(bm.url))}</div>
      </div>
      <button class="panel-item-del" title="Remove">&#10005;</button>`;
    div.querySelector('.panel-item-del').addEventListener('click', async e => {
      e.stopPropagation();
      await api.removeBookmark(bm.url);
      renderBookmarks();
    });
    div.addEventListener('click', e => {
      if (e.target.classList.contains('panel-item-del')) return;
      navigate(bm.url);
    });
    panelContent.appendChild(div);
  }
}

async function renderHistory() {
  const hist = await api.getHistory();
  panelContent.innerHTML = '';

  const searchBox = document.createElement('input');
  searchBox.className = 'panel-search-box';
  searchBox.placeholder = 'Filter history...';
  panelContent.appendChild(searchBox);

  const list = document.createElement('div');
  panelContent.appendChild(list);

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear All History';
  clearBtn.style.cssText = 'width:100%;margin-top:8px;padding:8px;background:rgba(243,139,168,0.15);border:1px solid rgba(243,139,168,0.3);color:#f38ba8;border-radius:6px;cursor:pointer;font-size:12px;';
  clearBtn.addEventListener('click', async () => {
    if (confirm('Clear all browsing history?')) {
      await api.clearHistory();
      renderHistory();
    }
  });

  function renderList(items) {
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="panel-empty">No history.</div>';
      return;
    }
    for (const h of items) {
      const div = document.createElement('div');
      div.className = 'panel-item';
      const date = new Date(h.visited_at * 1000);
      div.innerHTML = `
        <span class="panel-item-icon">&#128336;</span>
        <div class="panel-item-body">
          <div class="panel-item-title">${esc(h.title || h.url)}</div>
          <div class="panel-item-url">${esc(shortUrl(h.url))}</div>
        </div>
        <span class="panel-item-time">${formatTime(date)}</span>`;
      div.addEventListener('click', () => navigate(h.url));
      list.appendChild(div);
    }
  }

  renderList(hist);
  panelContent.appendChild(clearBtn);

  searchBox.addEventListener('input', () => {
    const q = searchBox.value.toLowerCase();
    const filtered = q ? hist.filter(h => (h.url+h.title).toLowerCase().includes(q)) : hist;
    renderList(filtered);
  });
}

async function renderSearchPanel() {
  const stats = await api.getIndexStats();

  if (panelMode !== 'search-panel') return;

  if (!panelContent.querySelector('.stats-grid')) {
    panelContent.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="stat-indexed">0</div><div class="stat-label">Pages Indexed</div></div>
        <div class="stat-card"><div class="stat-value" id="stat-queue">0</div><div class="stat-label">In Queue</div></div>
      </div>
      <input class="panel-search-box" id="panel-search-input" placeholder="Search indexed pages...">
      <div id="panel-search-results"></div>`;

    document.getElementById('panel-search-input').addEventListener('input', async function() {
      const q = this.value.trim();
      const results = q ? await api.search(q) : [];
      renderSearchResults(results);
    });
  }

  document.getElementById('stat-indexed').textContent = stats.indexed.toLocaleString();
  document.getElementById('stat-queue').textContent = stats.queued.toLocaleString();
}

function renderSearchResults(results) {
  const container = document.getElementById('panel-search-results');
  if (!container) return;
  container.innerHTML = '';
  if (!results.length) {
    container.innerHTML = '<div class="panel-empty">No results.</div>';
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.innerHTML = `
      <div class="search-result-title">${esc(r.title || r.url)}</div>
      <div class="search-result-url">${esc(shortUrl(r.url))}</div>
      ${r.excerpt ? `<div class="search-result-excerpt">${r.excerpt}</div>` : ''}`;
    div.addEventListener('click', () => navigate(r.url));
    container.appendChild(div);
  }
}

// -- Settings panel ------------------------------------------------------------

async function renderSettings() {
  const cfg = await api.getSettings();
  const bms = await api.getBookmarks();
  const hist = await api.getHistory();

  panelContent.innerHTML = `
    <div class="settings-divider" style="margin-top:0">Appearance</div>
    <div class="settings-section settings-row">
      <div>
        <div class="settings-label">Theme</div>
        <div class="settings-hint">Switch between dark and light mode</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="theme-btn ${cfg.theme!=='light'?'active':''}" id="s-dark" onclick="setTheme('dark')">&#127769; Dark</button>
        <button class="theme-btn ${cfg.theme==='light'?'active':''}" id="s-light" onclick="setTheme('light')">&#9728; Light</button>
      </div>
    </div>
    <input type="hidden" id="s-theme" value="${cfg.theme||'dark'}">
    <div class="settings-section">
      <div class="settings-label">Homepage</div>
      <select class="settings-input" id="s-homepage">
        <option value="newtab" ${cfg.homePage==='newtab'?'selected':''}>New Tab Page</option>
        <option value="https://en.wikipedia.org" ${cfg.homePage==='https://en.wikipedia.org'?'selected':''}>Wikipedia</option>
        <option value="custom" ${cfg.homePage&&cfg.homePage!=='newtab'&&cfg.homePage!=='https://en.wikipedia.org'?'selected':''}>Custom URL...</option>
      </select>
      <input class="settings-input" id="s-homepage-custom" placeholder="https://example.com"
        value="${esc(cfg.homePage&&cfg.homePage!=='newtab'&&cfg.homePage!=='https://en.wikipedia.org'?cfg.homePage:'')}"
        style="margin-top:6px;${cfg.homePage&&cfg.homePage!=='newtab'&&cfg.homePage!=='https://en.wikipedia.org'?'':'display:none'}">
    </div>

    <div class="settings-divider">Search</div>
    <div class="settings-section">
      <div class="settings-label">Indexer Server</div>
      <div class="settings-hint" style="margin-bottom:6px">Where search results come from. Run your own Bramble indexer or point at a hosted one.</div>
      <input class="settings-input" id="s-server" type="text" placeholder="http://localhost:8787" value="${esc(cfg.serverUrl||'http://localhost:8787')}">
    </div>
    <div class="settings-section settings-row">
      <div>
        <div class="settings-label">Safe Search</div>
        <div class="settings-hint">Filter explicit content from images and results</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="s-safe" ${cfg.safeSearch!==false?'checked':''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="settings-section">
      <div class="settings-label">Results Per Page</div>
      <input class="settings-input" id="s-results" type="number" min="5" max="100" value="${cfg.resultsPerPage||30}">
    </div>

    <div class="settings-divider">Privacy & Security</div>
    <div class="settings-section settings-row">
      <div>
        <div class="settings-label">Ad Blocker</div>
        <div class="settings-hint">Block ads & trackers (EasyList + EasyPrivacy)</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="s-adblock" ${cfg.adblock!==false?'checked':''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="settings-section settings-row">
      <div>
        <div class="settings-label">Save Browsing History</div>
        <div class="settings-hint">Record pages you visit</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="s-save-history" ${cfg.searchHistory!==false?'checked':''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="settings-section">
      <div class="settings-label">Max History Items</div>
      <input class="settings-input" id="s-max-history" type="number" min="100" max="100000" step="100" value="${cfg.maxHistory||5000}">
    </div>

    <div class="settings-divider">AI Overview</div>
    <div class="settings-section settings-row">
      <div>
        <div class="settings-label">AI Overview</div>
        <div class="settings-hint">Summarize results with a local model. Downloads ~300&nbsp;MB the first time you turn it on, then runs entirely on your machine &mdash; nothing is sent anywhere.</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="s-ai" ${cfg.aiOverview===true?'checked':''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="settings-section" id="s-ai-status" style="display:none">
      <div class="settings-hint" id="s-ai-status-text"></div>
    </div>

    <div class="settings-divider">History</div>
    <div class="settings-section">
      <div class="settings-hint" style="margin-bottom:8px">${hist.length.toLocaleString()} items saved</div>
      <button class="settings-btn danger" id="s-clear-hist">&#128465; Clear All History</button>
    </div>

    <div class="settings-divider">Bookmarks</div>
    <div class="settings-section">
      <div class="settings-hint" style="margin-bottom:8px">${bms.length.toLocaleString()} bookmarks saved</div>
      <button class="settings-btn" id="s-export-bm" style="background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3)">&#128203; Export Bookmarks</button>
      <label class="settings-btn" id="s-import-bm-label" style="display:block;text-align:center;margin-top:6px;background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);cursor:pointer">
        &#128229; Import Bookmarks
        <input type="file" id="s-import-bm" accept=".json,.html" style="display:none">
      </label>
    </div>

    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="settings-btn primary" id="s-save" style="flex:1">Save Settings</button>
    </div>`;

  // Homepage select logic
  document.getElementById('s-homepage').addEventListener('change', function() {
    document.getElementById('s-homepage-custom').style.display = this.value === 'custom' ? '' : 'none';
  });

  // AI Overview toggle -- applies immediately (downloads the model on first enable)
  const aiToggle = document.getElementById('s-ai');
  api.getAiStatus().then(renderAiStatus);
  aiToggle.addEventListener('change', async () => {
    const st = await api.setAiEnabled(aiToggle.checked);
    renderAiStatus(st);
  });

  document.getElementById('s-clear-hist').addEventListener('click', async () => {
    if (confirm('Clear all browsing history?')) {
      await api.clearHistory();
      document.querySelector('#panel-content .settings-hint').textContent = '0 items saved';
    }
  });

  // Export bookmarks as JSON
  document.getElementById('s-export-bm').addEventListener('click', async () => {
    const bookmarks = await api.getBookmarks();
    const json = JSON.stringify(bookmarks, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Bramble-bookmarks.json';
    a.click();
  });

  // Import bookmarks from JSON
  document.getElementById('s-import-bm').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = JSON.parse(text);
      let count = 0;
      for (const bm of (Array.isArray(items) ? items : [])) {
        if (bm.url && bm.title) { await api.addBookmark(bm.url, bm.title); count++; }
      }
      alert(`Imported ${count} bookmarks.`);
    } catch { alert('Failed to parse bookmark file.'); }
  });

  document.getElementById('s-save').addEventListener('click', async () => {
    const hpSel = document.getElementById('s-homepage').value;
    const homePage = hpSel === 'custom'
      ? document.getElementById('s-homepage-custom').value.trim() || 'newtab'
      : hpSel;

    const newSettings = {
      theme:         document.getElementById('s-theme').value,
      serverUrl:     document.getElementById('s-server').value.trim() || 'http://localhost:8787',
      safeSearch:    document.getElementById('s-safe').checked,
      resultsPerPage: parseInt(document.getElementById('s-results').value) || 30,
      adblock:       document.getElementById('s-adblock').checked,
      searchHistory: document.getElementById('s-save-history').checked,
      maxHistory:    parseInt(document.getElementById('s-max-history').value) || 5000,
      homePage,
    };
    await api.setSettings(newSettings);
    await api.setAdBlock(newSettings.adblock);
    applyBranding(newSettings);
    // Reload current tab if it's a search page so theme applies
    const active = tabs.find(t => t.active);
    if (active && (active.url || '').startsWith('search:')) {
      api.reload();
    }
    const btn = document.getElementById('s-save');
    btn.innerHTML = '&#10003; Saved!';
    setTimeout(() => { btn.innerHTML = 'Save Settings'; }, 2000);
  });
}

function applyBranding(cfg) {
  if (!cfg) return;
  document.title = cfg.browserName || 'Bramble';
  applyTheme(cfg.theme);
}

function applyTheme(theme) {
  document.body.classList.toggle('light-mode', theme === 'light');
}

function setTheme(t) {
  document.getElementById('s-theme').value = t;
  document.getElementById('s-dark').classList.toggle('active', t === 'dark');
  document.getElementById('s-light').classList.toggle('active', t === 'light');
  applyTheme(t);
}

// Reflect AI model status/download progress in the settings panel (if open).
function renderAiStatus(st) {
  const box = document.getElementById('s-ai-status');
  const txt = document.getElementById('s-ai-status-text');
  if (!box || !txt || !st) return;
  if (st.ready || st.status === 'ready') {
    box.style.display = '';
    txt.textContent = '✓ Model ready — AI overviews are on.';
  } else if (st.loading || st.enabled) {
    box.style.display = '';
    txt.textContent = `Downloading model… ${st.progress || 0}%`;
  } else {
    box.style.display = 'none';
    txt.textContent = '';
  }
}

// -- Event wiring --------------------------------------------------------------

btnNewTab.addEventListener('click', () => api.newTab());

btnBack.addEventListener('click', () => api.back());
btnForward.addEventListener('click', () => api.forward());
btnReload.addEventListener('click', () => {
  if (btnReload.dataset.loading === 'true') api.stop();
  else api.reload();
});

addressBar.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigate(addressBar.value);
  } else if (e.key === 'Escape') {
    hideSuggestions();
    addressBar.blur();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSuggestion(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSuggestion(-1);
  }
});

addressBar.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => updateSuggestions(addressBar.value), 200);
});

addressBar.addEventListener('focus', () => {
  addressBar.select();
  if (addressBar.value) updateSuggestions(addressBar.value);
});

addressBar.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 150);
});

btnBookmark.addEventListener('click', async () => {
  const active = tabs.find(t => t.active);
  if (!active || !active.url.startsWith('http')) return;
  const bm = await api.isBookmarked(active.url);
  if (bm) {
    await api.removeBookmark(active.url);
    btnBookmark.classList.remove('bookmarked');
  } else {
    await api.addBookmark(active.url, active.title || active.url);
    btnBookmark.classList.add('bookmarked');
  }
  if (panelMode === 'bookmarks') renderBookmarks();
});

btnPrivate.addEventListener('click', async () => {
  isPrivate = !isPrivate;
  await api.setPrivate(isPrivate);
  document.body.classList.toggle('private-mode', isPrivate);
  btnPrivate.classList.toggle('active', isPrivate);
  statusText.innerHTML = isPrivate ? '&#128274; Private mode -- no history saved' : '';
  if (isPrivate) api.newTab();
});

btnAdblock.addEventListener('click', async () => {
  adblockOn = !adblockOn;
  await api.setAdBlock(adblockOn);
  btnAdblock.classList.toggle('active', adblockOn);
  btnAdblock.title = adblockOn ? 'Ad Blocker: ON' : 'Ad Blocker: OFF';
});

btnMenu.addEventListener('click', e => {
  const opening = dropMenu.classList.contains('hidden');
  dropMenu.classList.toggle('hidden');
  if (opening) api.dropdownOpened();
  else api.dropdownClosed();
  e.stopPropagation();
});

document.addEventListener('click', () => {
  if (!dropMenu.classList.contains('hidden')) {
    dropMenu.classList.add('hidden');
    api.dropdownClosed();
  }
});
dropMenu.addEventListener('click', e => e.stopPropagation());

dropMenu.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', async () => {
    dropMenu.classList.add('hidden');
    api.dropdownClosed();
    const action = item.dataset.action;
    if (action === 'bookmarks') openPanel('bookmarks');
    else if (action === 'history') openPanel('history');
    else if (action === 'search-panel') openPanel('search-panel');
    else if (action === 'settings') openPanel('settings');
    else if (action === 'clear-history') {
      if (confirm('Clear all browsing history?')) { await api.clearHistory(); }
    } else if (action === 'devtools') {
      // Trigger devtools via IPC would need main process support
      // For now, signal via console
      console.log('DevTools: right-click on page -> Inspect Element');
    }
  });
});

btnPanelClose.addEventListener('click', closePanel);

// -- IPC events from main -------------------------------------------------------

api.on('tabs:updated', (updatedTabs) => {
  tabs = updatedTabs;
  const active = tabs.find(t => t.active);
  activeTabId = active?.id ?? null;
  renderTabs();

  if (active) {
    updateAddressBar(active.url);
    updateBookmarkButton(active.url);
    btnReload.dataset.loading = active.loading ? 'true' : 'false';
    btnReload.innerHTML = active.loading ? '&#10005;' : '&#8635;';
    btnReload.title = active.loading ? 'Stop' : 'Reload';
  }
});

api.on('nav:state', ({ url, canBack, canForward }) => {
  updateAddressBar(url);
  updateBookmarkButton(url);
  btnBack.disabled = !canBack;
  btnForward.disabled = !canForward;
});

api.on('search:results', ({ query, results }) => {
  openPanel('search-panel').then(() => {
    const inp = document.getElementById('panel-search-input');
    if (inp) { inp.value = query; }
    renderSearchResults(results);
  });
});

// Live AI model download/load progress (updates the settings panel if open)
api.on('ai:progress', (st) => renderAiStatus(st));

// -- Status bar polling ---------------------------------------------------------

async function updateStatus() {
  const stats = await api.getIndexStats().catch(() => null);
  if (stats) {
    indexStats.textContent = `Index: ${stats.indexed.toLocaleString()} pages`;
  }
  if (adblockOn) {
    const rules = await api.getAdBlockCount().catch(() => 0);
    adblockCount.textContent = rules ? `${rules.toLocaleString()} filter rules` : '';
  } else {
    adblockCount.textContent = '';
  }
}
setInterval(updateStatus, 5000);
updateStatus();

// -- Utils ---------------------------------------------------------------------

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 40) : '');
  } catch { return url; }
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return date.toLocaleDateString();
}

// -- Init ----------------------------------------------------------------------

(async () => {
  isPrivate = await api.isPrivate();
  adblockOn = await api.getAdBlock();
  btnAdblock.classList.toggle('active', adblockOn);
  btnPrivate.classList.toggle('active', isPrivate);
  document.body.classList.toggle('private-mode', isPrivate);

  // Apply saved branding
  const cfg = await api.getSettings();
  applyBranding(cfg);

  tabs = await api.getTabs();
  renderTabs();
})();

