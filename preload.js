const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  // Tab management
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  switchTab: (id) => ipcRenderer.invoke('tab:switch', id),
  getTabs: () => ipcRenderer.invoke('tab:list'),

  // Navigation
  navigate: (url) => ipcRenderer.invoke('nav:go', url),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  stop: () => ipcRenderer.invoke('nav:stop'),

  // Bookmarks
  addBookmark: (url, title) => ipcRenderer.invoke('bookmark:add', url, title),
  removeBookmark: (url) => ipcRenderer.invoke('bookmark:remove', url),
  getBookmarks: () => ipcRenderer.invoke('bookmark:list'),
  isBookmarked: (url) => ipcRenderer.invoke('bookmark:check', url),

  // History
  getHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // Search (served by the remote indexer)
  search: (query) => ipcRenderer.invoke('search:query', query),
  getIndexStats: () => ipcRenderer.invoke('search:stats'),

  // Ad-blocker
  setAdBlock: (val) => ipcRenderer.invoke('adblock:set', val),
  getAdBlock: () => ipcRenderer.invoke('adblock:get'),
  getAdBlockCount: () => ipcRenderer.invoke('adblock:count'),

  // Private mode
  setPrivate: (val) => ipcRenderer.invoke('private:set', val),
  isPrivate: () => ipcRenderer.invoke('private:get'),

  // Panel + dropdown resize
  panelOpened:    ()     => ipcRenderer.invoke('panel:open'),
  panelClosed:    ()     => ipcRenderer.invoke('panel:close'),
  dropdownOpened:     () => ipcRenderer.invoke('dropdown:open'),
  dropdownClosed:     () => ipcRenderer.invoke('dropdown:close'),
  suggestionsOpened:  () => ipcRenderer.invoke('suggestions:open'),
  suggestionsClosed:  () => ipcRenderer.invoke('suggestions:close'),

  // Settings
  getSettings: ()        => ipcRenderer.invoke('settings:get'),
  setSetting:  (k, v)    => ipcRenderer.invoke('settings:set', k, v),
  setSettings: (obj)     => ipcRenderer.invoke('settings:setAll', obj),

  // AI Overview (local model)
  getAiStatus:  ()    => ipcRenderer.invoke('ai:status'),
  setAiEnabled: (val) => ipcRenderer.invoke('ai:enable', val),

  // Events from main -> renderer
  on: (event, cb) => {
    const handler = (_, ...args) => cb(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  }
});
