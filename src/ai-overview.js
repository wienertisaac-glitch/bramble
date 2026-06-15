// AI Overview -- runs a small summarization model locally, in-process, via
// Transformers.js (@xenova/transformers). The model weights are downloaded from
// the HuggingFace hub the first time the feature is enabled and cached on disk
// (in Electron userData), so nothing is ever sent to a remote server at query time.
//
// This feature is OFF by default. main.js loads the model only when the user
// turns it on in Settings, and gates generation on that setting.

const MODEL = 'Xenova/distilbart-cnn-6-6'; // ~300 MB quantized summarization model

let _transformers = null;
let _summarizer   = null;
let _ready        = false;
let _loading      = false;
let _progress     = 0;     // 0-100 download/load progress
let _status       = '';    // last progress status string

async function ensureLib() {
  // @huggingface/transformers is ESM-only; load it from CommonJS via dynamic import.
  if (!_transformers) _transformers = await import('@huggingface/transformers');
  return _transformers;
}

// Download (first run) + load the model. Safe to call repeatedly; no-ops if
// already loaded or loading. `onProgress({status,file,progress})` is optional.
async function load(cacheDir, onProgress) {
  if (_ready || _loading) return _ready;
  _loading = true;
  _progress = 0;
  try {
    const { pipeline, env } = await ensureLib();
    if (cacheDir) env.cacheDir = cacheDir;   // persist weights outside the (read-only) asar
    env.allowRemoteModels = true;

    _summarizer = await pipeline('summarization', MODEL, {
      dtype: 'q8',   // quantized weights (~300 MB) instead of full fp32
      progress_callback: (p) => {
        if (typeof p.progress === 'number') _progress = Math.round(p.progress);
        _status = p.status || '';
        if (onProgress) onProgress({ status: _status, file: p.file, progress: _progress });
      },
    });

    _ready = true;
    _progress = 100;
    console.log(`[ai] model ready: ${MODEL}`);
  } catch (e) {
    console.warn('[ai] model load failed:', e.message);
  } finally {
    _loading = false;
  }
  return _ready;
}

// Summarize the top search results into a short overview.
async function generate(query, results) {
  if (!_ready || !_summarizer) return null;

  const context = (results || [])
    .slice(0, 5)
    .map(r => {
      const snippet = String(r.excerpt || r.body || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      return `${r.title || ''}. ${snippet}`;
    })
    .join(' ')
    .trim()
    .slice(0, 3000);

  if (!context) return null;

  try {
    const out = await _summarizer(context, { max_new_tokens: 130, min_length: 25, do_sample: false });
    const text = Array.isArray(out) ? out[0]?.summary_text : out?.summary_text;
    return (text || '').trim() || null;
  } catch (e) {
    console.warn('[ai] generate failed:', e.message);
    return null;
  }
}

function isReady()    { return _ready; }
function isLoading()  { return _loading; }
function getProgress(){ return _progress; }
function getStatus()  { return _status; }
function getModel()   { return MODEL; }

module.exports = { load, generate, isReady, isLoading, getProgress, getStatus, getModel };
