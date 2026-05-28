import TurndownService from 'turndown';

class FetchCache {
  #maxSize;
  #ttlMs;
  #cache;

  constructor({ maxSize = 64, ttlMs = 15 * 60 * 1000 } = {}) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlMs;
    this.#cache = new Map();
  }

  get(key) {
    const entry = this.#cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.#ttlMs) {
      this.#cache.delete(key);
      return null;
    }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#cache.has(key)) this.#cache.delete(key);
    if (this.#cache.size >= this.#maxSize) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(key, { value, ts: Date.now() });
  }
}

const fetchCache = new FetchCache();

let _ProxyAgent;
async function getProxyAgent() {
  if (_ProxyAgent === undefined) {
    try {
      const mod = await import('undici');
      _ProxyAgent = mod.ProxyAgent || null;
    } catch {
      _ProxyAgent = null;
    }
  }
  return _ProxyAgent;
}

const proxyDispatcherCache = new Map();
async function getOrCreateDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const cached = proxyDispatcherCache.get(proxyUrl);
  if (cached) return cached;
  const ProxyAgent = await getProxyAgent();
  if (!ProxyAgent) return null;
  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    proxyDispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
  } catch (err) {
    console.error('[web_fetch] failed to create proxy dispatcher:', err.message);
    return null;
  }
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'noscript']);

const MAX_CONTENT_LENGTH = 50_000;
const PREVIEW_LENGTH = 2000;
const USER_AGENT = 'xwork/1.0';

const BINARY_TYPES = new Set([
  'image/', 'audio/', 'video/',
  'application/octet-stream', 'application/pdf',
  'application/zip', 'application/x-gzip', 'application/x-tar', 'application/x-rar',
]);

function isBinary(contentType) {
  if (!contentType) return false;
  const type = contentType.toLowerCase().split(';')[0].trim();
  return [...BINARY_TYPES].some(t => type.startsWith(t));
}

export const webFetchTool = {
  id: 'web_fetch',
  name: 'web_fetch',
  title: 'Web Fetch',
  description:
    'Fetch a web page and return its content as markdown. Useful for reading articles, documentation, API references, or any public web page. The content is converted from HTML to markdown for easier processing.\n\nUsage notes:\n- The URL must be a fully-formed valid URL (http or https)\n- For large pages, content is truncated to ~50K characters\n- Binary content (images, PDFs, etc.) is not supported\n- Results are cached for 15 minutes\n- Use web_search for discovering information; use web_fetch for reading specific pages in full\n- Configure a proxy (e.g. http://localhost:7890) in the tool config to reach sites behind network restrictions',
  category: 'web',
  adapter: 'builtin',
  version: '1.1.0',
  dangerLevel: 'medium',
  defaultEnabled: true,
  timeoutMs: 30000,

  defaultConfig: {
    proxy: '',
  },
  configSchema: {
    type: 'object',
    properties: {
      proxy: {
        type: 'string',
        description: 'HTTP proxy URL (e.g. http://localhost:7890). Leave empty to use a direct connection.',
      },
    },
    additionalProperties: false,
  },

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from.',
      },
      prompt: {
        type: 'string',
        description: 'Optional. Describe what information you want to extract from the page. The raw markdown content is returned — process it based on this prompt.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },

  validate({ url }) {
    if (!url || typeof url !== 'string') throw new Error('url is required');
    try { new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  },

  async handler({ url, prompt }, { config, signal }) {
    const normalizedUrl = new URL(url).toString();

    const cached = fetchCache.get(normalizedUrl);
    if (cached) {
      return { url: normalizedUrl, ...cached, cached: true, prompt: prompt || null };
    }

    const proxy = (config?.proxy || '').trim();
    const dispatcher = proxy ? await getOrCreateDispatcher(proxy) : null;

    if (proxy && !dispatcher) {
      const hasUndici = !!(await getProxyAgent());
      throw new Error(
        hasUndici
          ? `Failed to create proxy dispatcher for ${proxy}. Check that the proxy URL is valid and the service is running.`
          : `Proxy configured but undici is not available. Run npm install to install the undici dependency.`,
      );
    }

    let response;
    try {
      response = await fetch(normalizedUrl, {
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json',
        },
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      throw new Error(
        `Fetch failed for ${normalizedUrl}: ${err.cause?.message || err.message}. ` +
        (dispatcher ? 'The request was routed through the proxy.' : 'No proxy configured — try setting a proxy in the web_fetch tool config.'),
      );
    }

    const statusCode = response.status;
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) throw new Error(`HTTP ${statusCode}: ${response.statusText}`);
    if (isBinary(contentType)) throw new Error(`Unsupported content type: ${contentType.split(';')[0].trim()}`);

    const rawText = await response.text();
    let markdown = (contentType.includes('text/html') || contentType.includes('application/xhtml'))
      ? turndown.turndown(rawText)
      : rawText;

    if (markdown.length > MAX_CONTENT_LENGTH) {
      markdown = markdown.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [content truncated]';
    }

    const contentLength = Buffer.byteLength(markdown, 'utf-8');
    const entry = { statusCode, contentType: contentType.split(';')[0].trim(), contentLength, markdown };
    fetchCache.set(normalizedUrl, entry);

    return { url: normalizedUrl, ...entry, cached: false, prompt: prompt || null };
  },

  parseResult(output) {
    return {
      renderType: 'web-fetch',
      data: {
        url: output.url,
        statusCode: output.statusCode,
        contentType: output.contentType,
        contentLength: output.contentLength,
        cached: output.cached,
        contentPreview: output.markdown.slice(0, PREVIEW_LENGTH),
      },
    };
  },
};
