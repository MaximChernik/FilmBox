export interface FetchOptions {
  referer?: string;
  timeoutMs?: number;
  /**
   * Дополнительные заголовки запроса поверх стандартных. Например, ZONA
   * отдаёт JSON только на запросы с `X-Requested-With: XMLHttpRequest`,
   * остальным — HTML.
   */
  headers?: Record<string, string>;
  /** Skip the hidden-browser fallback (fast fail on hosts that never need it). */
  noBrowser?: boolean;
  /**
   * Reject wrong bodies served with 200 (e.g. homepage instead of a story):
   * such responses are neither cached nor returned — the caller sees '' and
   * can retry.
   */
  validate?: (html: string) => boolean;
}

// Единый User-Agent для всего приложения: токены HLS-сегментов (interkh)
// привязаны к UA, с которым был запрошен embed — main и рендер обязаны совпадать.
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 8 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

interface CacheEntry {
  ts: number;
  html: string;
}

const cache = new Map<string, CacheEntry>();

export function isCloudflareChallenge(html: string): boolean {
  if (!html) return false;
  return (
    html.includes('cf-chl-') ||
    html.includes('challenge-platform') ||
    (html.includes('Just a moment') && html.includes('<title>'))
  );
}

async function fetchDirect(url: string, opts: FetchOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    };
    if (opts.referer) headers['Referer'] = opts.referer;
    if (opts.headers) Object.assign(headers, opts.headers);
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchViaBrowser(url: string): Promise<string> {
  let electron: any;
  try {
    electron = require('electron');
  } catch {
    return '';
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') return '';

  const win = new electron.BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { javascript: true, contextIsolation: true },
  });

  try {
    await win.loadURL(url, { userAgent: USER_AGENT });
    const deadline = Date.now() + 25000;
    let html = '';
    while (Date.now() < deadline) {
      await sleep(1500);
      html = await win.webContents.executeJavaScript(
        'document.documentElement ? document.documentElement.outerHTML : ""',
        true,
      );
      if (html && html.length > 4000 && !isCloudflareChallenge(html)) return html;
    }
    return html;
  } catch {
    return '';
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.html;

  let html = '';
  // one retry: transient 429/timeouts are common when several shelves are
  // fetched in parallel, and an empty body would fail the whole catalog call
  for (let attempt = 0; attempt < 2 && !html; attempt++) {
    if (attempt) await sleep(500);
    try {
      html = await fetchDirect(url, opts);
    } catch (err) {
      if (isCloudflareChallenge((err as Error)?.message ?? '')) throw err;
    }
  }

  if ((isCloudflareChallenge(html) || html === '') && !opts.noBrowser) {
    const viaBrowser = await fetchViaBrowser(url);
    if (viaBrowser) html = viaBrowser;
  }

  if (html && opts.validate && !opts.validate(html)) html = '';

  if (html) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, { ts: Date.now(), html });
  }
  return html;
}

export function clearCache(): void {
  cache.clear();
}
