# ⬢ Bramble

A privacy-focused desktop browser with its own **search engine**. Bramble is
split into two parts:

- **The browser** (this folder) — an Electron desktop client. Tabs, bookmarks,
  history, settings, ad-blocking, and an optional local AI overview all run on
  the user's machine. Nothing about a user's browsing is sent anywhere.
- **The indexer** (`server/`) — a standalone Node service **you host**. It
  crawls the web, builds a search index, and serves results over a small HTTP
  API. The browser queries it for search; it never receives users' browsing.

```
┌──────────────────────────┐         HTTP (search/images/stats)         ┌──────────────────────────┐
│  Bramble browser (client) │  ───────────────────────────────────────▶ │  Bramble indexer (server) │
│  • UI, tabs               │                                            │  • crawler + image crawler│
│  • bookmarks, history     │ ◀─────────────────────────────────────────│  • SQLite index (sql.js)  │
│  • settings, ad-block     │            JSON results                    │  • search API             │
│  • AI overview (local)    │                                            └──────────────────────────┘
│  runs on each user's PC   │   The server crawls on its own. The client
└──────────────────────────┘   never sends visited URLs to the server.
```

## Features

- **Tabbed browsing** with sandboxed, context-isolated web views.
- **Own search engine** — BM25 ranking, title boost, stemming, domain
  authority; Web / Images / News tabs. The index lives on your server.
- **Ad & tracker blocking** (EasyList + EasyPrivacy), client-side.
- **AI Overview** (optional, off by default) — summarizes results with a small
  model that runs **locally in the app** via
  [Transformers.js](https://github.com/huggingface/transformers.js). The model
  (~300 MB) is downloaded and cached on first enable; after that it runs entirely
  on the user's machine — no external service. Toggle it in Settings.
- **Bookmarks & history** stored locally, with import/export.
- **Private mode**, **Safe Search**, light/dark themes, configurable homepage,
  results-per-page, history limits, and indexer URL.

## Requirements

- [Node.js](https://nodejs.org) 18+
- AI Overviews need no extra software — the model downloads in-app on first
  enable. (They're off by default; search works without them.)

## Running it

### 1. Start the indexer (server)

```bash
cd server
npm install
npm start
```

It listens on `http://localhost:8787` by default and immediately begins
crawling from a seed list, building the index in `server/data/index.db`.
Give it a little time before search results fill in.

Configure with environment variables:

| Variable              | Default | Meaning                          |
|-----------------------|---------|----------------------------------|
| `PORT`                | `8787`  | HTTP port                        |
| `CRAWL_DELAY`         | `150`   | ms stagger between fetches       |
| `CRAWL_DEPTH`         | `4`     | max crawl depth                  |
| `CRAWL_LINKS_PER_PAGE`| `60`    | same-domain links queued per page|
| `CRAWL_BATCH_SIZE`    | `12`    | parallel fetches per tick        |

### 2. Start the browser (client)

```bash
npm install
npm start
```

By default the browser points at `http://localhost:8787`. To use a hosted
indexer, change **Menu (⋮) → Settings → Indexer Server** (or edit `serverUrl`
in the saved settings file in Electron's `userData`).

## API (indexer)

| Endpoint        | Returns                                                    |
|-----------------|------------------------------------------------------------|
| `GET /api/health` | `{ ok, indexed, queued }`                                |
| `GET /api/stats`  | `{ indexed, queued }`                                    |
| `GET /api/search?q=&tab=web|news&safe=1&limit=30` | `{ query, tab, results, stats }` |
| `GET /api/images?q=` | `{ query, images, stats }`                            |

## Layout

| Path                       | Role |
|----------------------------|------|
| `main.js`                  | Electron app, tabs, IPC, `search:` protocol (fetches from indexer) |
| `preload.js`               | Safe IPC bridge to the renderer |
| `renderer/`                | Browser UI, settings, panels, new-tab page |
| `src/database.js`          | Local bookmarks + history (sql.js) |
| `src/search-client.js`     | HTTP client for the remote indexer |
| `src/ad-blocker.js`        | EasyList parser + request blocking |
| `src/ai-overview.js`       | Local in-app summaries (Transformers.js) |
| `src/settings.js`          | Client settings (incl. `serverUrl`) |
| `server/`                  | The indexer: `index.js` (API), `crawler.js`, `image-crawler.js`, `db.js`, `seeds.js` |

## License

Source-available for personal use — see [LICENSE](LICENSE). Redistribution and
commercial use are reserved. (Not an OSI open-source license.)
