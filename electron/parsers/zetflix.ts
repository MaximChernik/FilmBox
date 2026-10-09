import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { fetchText } from '../fetcher';
import { resolveEmbed } from './embed-resolver';
import type {
  Category,
  MediaDetails,
  MediaKind,
  MediaSummary,
  PagedResult,
  PlayerTab,
  StreamCatalog,
  StreamsRequest,
  CatalogFilterState,} from '../models';
import type { SourceParser } from './base';
import { effectiveCategory, normGenre, stampGenre } from './filtering';
import {
  bestQualityFromText,
  maxYear,
  normalizeSiteDate,
  qualityFromHeight,
  siteDateFromPoster,
  yearFromPoster,
  enrichSummaries,
} from './shared';

type CheerioEl = ReturnType<CheerioAPI>;

const GO_URL = 'https://go.zet-flix.online/';
// Резерв, если GO-дверь не ответила: стабильный домен (его корень может
// отдавать 404 — fetchPage уходит на /index2.php) и зеркало дня. Мёртвое
// 4oct-зеркало убрано — устаревшие зеркала больше не резолвятся.
const FALLBACK_HOSTS = ['https://zet-flix.online', 'https://9oct.zet-flix.online'];
const HOST_TTL_MS = 10 * 60 * 1000;

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
  { id: 'serials', title: 'Сериалы' },
  { id: 'cartoons', title: 'Мультфильмы' },
];

const CATEGORY_PATHS: Record<string, string> = {
  home: '/',
  // no native route: the homepage sections are the freshest titles, and
  // the sitemap tail (sorted by lastmod) continues them
  new: '/',
  films: '/films/',
  serials: '/serials/',
  cartoons: '/cartoons/',
};

const SECTION_TITLES: Record<string, RegExp> = {
  films: /^фильм/i,
  serials: /^сериал/i,
  cartoons: /^мульт/i,
};

/**
 * Жанровые секции сайта: путь вместо `?genre=` — параметр источник молча
 * игнорирует (проверено: выдача при нём не меняется). Список сверен с
 * навигацией главной и sitemap1; у ряда жанров секций нет — они остаются
 * на локальной фильтрации. Годовые метки (`new_films_YYYY`) помечают год
 * добавления, а не фильм, поэтому год через секции не фильтруется.
 */
const GENRE_SECTIONS: Record<string, { films?: string; serials?: string }> = {
  'боевик': { films: '/films/boeviki/' },
  'комедия': { films: '/films/comedy/', serials: '/serials/comedy_serials/' },
  'драма': { films: '/films/melodramy/' },
  'мелодрама': { films: '/films/melodramy/' },
  'ужасы': { films: '/films/filmy_uzhasov/', serials: '/serials/uzhasy_serialy/' },
  'фантастика': { films: '/films/fantastic/', serials: '/serials/fantasticheskie_serialy/' },
  'фэнтези': { serials: '/serials/fantasy_serialy/' },
  'детектив': { serials: '/serials/detective/' },
  'исторический': { serials: '/serials/history_serials/' },
};

// sitemap1 = tag/section pages («/films/new_films_2024/» …) — not stories
const SITEMAPS = ['/uploads/sitemap2.xml', '/uploads/sitemap3.xml'];
const PAGE_SIZE = 10;
const KIND_BY_CATEGORY: Record<string, MediaKind | undefined> = {
  films: 'movie',
  serials: 'serial',
  cartoons: 'cartoon',
};

interface EpisodeLink {
  season: number;
  episode: number;
  url: string;
}

/** One story URL from a sitemap; lazily hydrated into a card. */
interface SmapEntry {
  path: string;
  lastmod: string;
  kind: MediaKind;
}

function classifyPath(pathname: string): MediaKind | undefined {
  if (pathname.endsWith('.html')) return undefined;
  if (/^\/films\/[^/]+\/?$/.test(pathname)) return 'movie';
  if (/^\/serials\/[^/]+\/?$/.test(pathname)) return 'serial';
  if (/^\/cartoons\/[^/]+\/?$/.test(pathname)) return 'cartoon';
  return undefined;
}

let hostCache: { host: string; ts: number } | undefined;

/**
 * The front door redirects to a daily-rotating mirror via a small JS snippet.
 * The previous day's host stays usable as a fallback.
 */
async function resolveHost(): Promise<string> {
  if (hostCache && Date.now() - hostCache.ts < HOST_TTL_MS) return hostCache.host;
  try {
    const js = await fetchText(GO_URL, { noBrowser: true, timeoutMs: 8000 });
    const m = js.match(/replace\("go\.zet-flix\.online",\s*"([^"]+)"\)/);
    if (m?.[1]) {
      hostCache = { host: `https://${m[1].replace(/^https?:\/\//, '')}`, ts: Date.now() };
      return hostCache.host;
    }
  } catch {
    // fall through to the cached/fallback host
  }
  if (!hostCache) hostCache = { host: FALLBACK_HOSTS[0], ts: 0 };
  return hostCache.host;
}

function abs(baseUrl: string, href?: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') return undefined;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function text($: CheerioAPI, el?: unknown): string {
  if (!el) return '';
  return $(el as Parameters<CheerioAPI>[0])
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRating(raw: string): number | undefined {
  const m = raw.match(/(\d+[.,]\d+|\d+)/);
  if (!m) return undefined;
  const value = Number(m[1].replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

function finfoRows($: CheerioAPI): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  $('ul.finfo li').each((_, li) => {
    const el = $(li);
    const labelText = text($, el.find('span').first());
    if (!labelText) return;
    const label = labelText.toLowerCase().replace(/[:：]/g, '').trim();
    const value = text($, el)
      .slice(labelText.length)
      .replace(/^[\s:/·|]+/, '')
      .trim();
    if (value) rows.push({ label, value });
  });
  return rows;
}

function finfoYear($: CheerioAPI): string | undefined {
  const value = finfoRows($).find((r) => r.label.includes('год'))?.value;
  return maxYear(value);
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^(смотреть|просмотр)(\s+онлайн)?\s+/i, '')
    .replace(
      /\s+(смотреть(\s+онлайн)?|просмотр(\s+онлайн)?|смотреть\s+бесплатно|онлайн\s+бесплатно|бесплатно|онлайн).*$/i,
      '',
    )
    .replace(/[\s—–-]+$/, '')
    .trim();
}

function pathnameOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).replace(/^\/index2\.php/, '');
  } catch {
    return url;
  }
}

function isZetflixHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('zet-flix.online') || host.endsWith('zetflix.online');
  } catch {
    return false;
  }
}

function dedupe(items: MediaSummary[]): MediaSummary[] {
  const seen = new Set<string>();
  const out: MediaSummary[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The server intermittently answers story URLs with the homepage or an error
 * page; a real story always has a named <h1> («Фильм … смотреть онлайн»,
 * sometimes with nested tags inside).
 */
function looksLikeStoryHtml(html: string): boolean {
  if (html.length < 3000) return false;
  const m = html.match(/<h1[^>]*>([\s\S]{0,400}?)<\/h1>/);
  const h1 = (m?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !!h1 && !/^zetflix\b/i.test(h1);
}

export class ZetflixParser implements SourceParser {
  readonly id = 'zetflix';
  readonly name = 'Zetflix';
  readonly categories = CATEGORIES;

  private smapCache?: { ts: number; entries: SmapEntry[] };

  matchesUrl(url: string): boolean {
    return isZetflixHost(url);
  }

  /**
   * Fetch a page through the current mirror: pretty URL first (works while the
   * site serves /index.php), then the DLE front controller with PATH_INFO
   * (works while /index.php is missing, which is the case right now).
   */
  private async fetchPage(path: string): Promise<{ html: string; host: string }> {
    const host = await resolveHost();
    const expectStory = /^\/(films|serials|cartoons)\//.test(path);
    const validate = expectStory ? looksLikeStoryHtml : (html: string) => html.length >= 3000;
    let html = '';
    try {
      html = await fetchText(`${host}${path}`, { noBrowser: true, timeoutMs: 15000, validate });
    } catch {
      html = '';
    }
    for (let attempt = 0; html.length < 3000 && attempt < 2; attempt++) {
      if (attempt) await delay(500);
      try {
        html = await fetchText(`${host}/index2.php${path}`, {
          noBrowser: true,
          timeoutMs: 15000,
          referer: `${host}/`,
          validate,
        });
      } catch {
        html = '';
      }
    }
    if (!html || html.length < 3000) throw new Error(`Zetflix: не удалось загрузить ${path}`);
    return { html, host };
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    // Серверная фильтрация: тип уводит в родной раздел (`/films/`, `/serials/`),
    // жанр — в секцию жанра (`/films/boeviki/`, `/serials/detective/`)
    const cat = effectiveCategory(categoryId, filters, CATEGORY_PATHS);
    const path = CATEGORY_PATHS[cat];
    if (!path) return { items: [], page, hasMore: false };

    // Секции есть только у фильмов и сериалов; для «Главной»/«Новинок» жанр
    // берёт раздел фильмов — у карточек нет genres до гидратации, и без
    // серверного жанра локальная фильтрация зачищала бы выдачу (как это
    // было на lordfilm: 3 из 35).
    const genreSec = filters?.genre ? GENRE_SECTIONS[normGenre(filters.genre)] : undefined;
    const secCat = cat === 'home' || cat === 'new' ? 'films' : cat;
    let genrePath: string | undefined;
    if (genreSec && secCat !== 'cartoons') {
      genrePath = secCat === 'serials' ? genreSec.serials : genreSec.films;
    }

    // A real category page (works while the pretty routes are alive).
    // «Новинки» has none — it reads like «Главная».
    if (genrePath || (cat !== 'home' && cat !== 'new')) {
      const native = await this.tryNativeCategory(
        genrePath ?? path,
        page,
        filters,
        genrePath ? filters?.genre : undefined,
      );
      if (native) return native;
    }

    const fresh = await this.freshSectionItems(cat);
    const entries = await this.smapEntriesFor(cat, fresh);
    // homepage cards carry no date; the sitemap's lastmod gives them one
    await this.attachSiteDates(fresh);

    if (page === 1) {
      return {
        items: await enrichSummaries(fresh, 12, (u) => this.getDetails(u)),
        page,
        hasMore: entries.length > 0,
      };
    }
    const slice = entries.slice((page - 2) * PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const hydrated: (MediaSummary | undefined)[] = [];
    for (let i = 0; i < slice.length; i += 4) {
      const chunk = slice.slice(i, i + 4);
      hydrated.push(...(await Promise.all(chunk.map((entry) => this.hydrateEntry(entry)))));
    }
    const items = hydrated.filter((item): item is MediaSummary => !!item);
    return { items, page, hasMore: (page - 1) * PAGE_SIZE < entries.length };
  }

  /**
   * Native DLE category page via the pretty URL; null when unavailable.
   * `appliedGenre` — жанр, уже учтённый в `path` (через секцию): после
   * гидратации его нужно проставить карточкам, иначе локальная фильтрация
   * отбросит их как «без жанра».
   */
  private async tryNativeCategory(
    path: string,
    page: number,
    filters?: CatalogFilterState,
    appliedGenre?: string,
  ): Promise<PagedResult | null> {
    const host = await resolveHost();
    // `?genre=`/`?year=` источник молча игнорирует (проверено: выдача не
    // меняется) — жанр уходит в URL секции (GENRE_SECTIONS), а год остаётся
    // локальной фильтрацией (секции годов помечают год добавления).
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    const url = page === 1 ? `${host}${path}${qs ? '?' + qs : ''}` : `${host}${path}page/${page}/${qs ? '?' + qs : ''}`;
    try {
      const html = await fetchText(url, { noBrowser: true, timeoutMs: 15000 });
      if (!html || html.length < 3000) return null;
      const $ = cheerio.load(html);
      // the front controller answers with the homepage while routes are broken
      if (/zetflix/i.test(text($, $('h1').first()))) return null;
      const items = this.parseCards($, host);
      if (items.length < 5) return null;
      const enriched = await enrichSummaries(items, 12, (u) => this.getDetails(u));
      return {
        items: appliedGenre ? stampGenre(enriched, appliedGenre) : enriched,
        page,
        hasMore: items.length >= 10,
      };
    } catch {
      return null;
    }
  }

  /**
   * Cards the homepage already shows (sections «Фильмы/Сериалы/Мультфильмы»,
   * unioned for «Главная» and «Новинки») — the freshest titles, served
   * without extra fetches.
   */
  private async freshSectionItems(categoryId: string): Promise<MediaSummary[]> {
    try {
      const { html, host } = await this.fetchPage('/');
      const $ = cheerio.load(html);
      const sections = this.parseSections($, host);
      if (categoryId === 'home' || categoryId === 'new') {
        const fromSections = dedupe(sections.flatMap((s) => s.items));
        return fromSections.length ? fromSections : this.parseCards($, host);
      }
      const re = SECTION_TITLES[categoryId];
      const section = re ? sections.find((s) => re.test(s.title)) : undefined;
      return section?.items ?? [];
    } catch {
      return [];
    }
  }

  /** All sitemap story URLs for the category (newest first), minus fresh ones. */
  private async smapEntriesFor(categoryId: string, fresh: MediaSummary[]): Promise<SmapEntry[]> {
    const want = KIND_BY_CATEGORY[categoryId];
    let entries = await this.catalogEntries();
    if (want) entries = entries.filter((e) => e.kind === want);
    const freshPaths = new Set(
      fresh.map((f) => {
        try {
          return new URL(f.url).pathname;
        } catch {
          return '';
        }
      }),
    );
    return entries.filter((e) => !freshPaths.has(e.path));
  }

  /** Give undated homepage cards the sitemap lastmod of their story URL. */
  private async attachSiteDates(items: MediaSummary[]): Promise<void> {
    if (!items.length) return;
    try {
      const byPath = new Map(
        (await this.catalogEntries()).map((e) => [e.path, normalizeSiteDate(e.lastmod)]),
      );
      for (const item of items) {
        if (item.siteDate) continue;
        try {
          const date = byPath.get(new URL(item.url).pathname);
          if (date) item.siteDate = date;
        } catch {
          // unparsable url — the card just stays undated
        }
      }
    } catch {
      // sitemap unavailable — «Новинки» sorts by year only
    }
  }

  /**
   * The site ships sitemaps with every story (tens of thousands); the routes
   * for them are broken right now, but the URLs stay valid via /index2.php.
   */
  private async catalogEntries(): Promise<SmapEntry[]> {
    if (this.smapCache && Date.now() - this.smapCache.ts < 30 * 60 * 1000) {
      return this.smapCache.entries;
    }
    const host = await resolveHost();
    const entries: SmapEntry[] = [];
    const seen = new Set<string>();
    for (const sm of SITEMAPS) {
      let xml = '';
      for (let attempt = 0; attempt < 2 && xml.length < 1000; attempt++) {
        if (attempt) await delay(500);
        try {
          xml = await fetchText(`${host}${sm}`, {
            noBrowser: true,
            timeoutMs: 25000,
            validate: (body) => body.length >= 1000 && body.trimStart().startsWith('<'),
          });
        } catch {
          xml = '';
        }
      }
      if (xml.length < 1000) continue;
      const re = /<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) {
        let pathname = '';
        try {
          pathname = new URL(m[1]).pathname;
        } catch {
          continue;
        }
        const kind = classifyPath(pathname);
        if (!kind || seen.has(pathname)) continue;
        seen.add(pathname);
        entries.push({ path: pathname, lastmod: m[2] ?? '', kind });
      }
    }
    // newest first; sort is stable, so same-day URLs keep sitemap order
    entries.sort((a, b) => (b.lastmod < a.lastmod ? -1 : b.lastmod > a.lastmod ? 1 : 0));
    this.smapCache = { ts: Date.now(), entries };
    return entries;
  }

  /** Load title/poster/year of one story (cached — reused by getDetails). */
  private async hydrateEntry(entry: SmapEntry): Promise<MediaSummary | undefined> {
    const host = await resolveHost();
    const url = `${host}/index2.php${entry.path}`;
    let $: CheerioAPI | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(450 * attempt);
      let html = '';
      try {
        html = await fetchText(url, {
          noBrowser: true,
          timeoutMs: 15000,
          referer: `${host}/`,
          validate: looksLikeStoryHtml,
        });
      } catch {
        html = '';
      }
      if (looksLikeStoryHtml(html)) {
        $ = cheerio.load(html);
        break;
      }
    }
    if (!$) return undefined;
    const title = cleanTitle(text($, $('h1#ftitle').first()) || text($, $('h1').first()));
    if (!title) return undefined;
    const posterImg = $('.fposter2 img').first();
    const poster =
      abs(host, posterImg.attr('data-src') || posterImg.attr('src')) ??
      abs(host, $('meta[property="og:image"]').attr('content'));
    const year = finfoYear($);
    return {
      url: `${host}${entry.path}`,
      title,
      poster,
      year,
      siteDate: normalizeSiteDate(entry.lastmod),
      kind: entry.kind,
    };
  }

  async search(query: string): Promise<PagedResult> {
    const q = query.trim();
    if (!q) return { items: [], page: 1, hasMore: false };
    const host = await resolveHost();
    const qs =
      'do=search&subaction=search&search_start=0&full_search=0&result_from=1' +
      `&story=${encodeURIComponent(q)}`;
    let html = '';
    try {
      html = await fetchText(`${host}/index.php?${qs}`, { noBrowser: true, timeoutMs: 15000 });
    } catch {
      html = '';
    }
    if (!html || html.length < 2000) {
      try {
        html = await fetchText(`${host}/index2.php?${qs}`, {
          noBrowser: true,
          timeoutMs: 15000,
          referer: `${host}/`,
        });
      } catch {
        html = '';
      }
    }
    if (!html || html.length < 2000) return { items: [], page: 1, hasMore: false };
    const $ = cheerio.load(html);
    return { items: this.parseCards($, host), page: 1, hasMore: false };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const path = pathnameOf(url);
    const { html, host } = await this.fetchPage(path);
    const $ = cheerio.load(html);

    const h1 = text($, $('h1#ftitle').first()) || text($, $('h1').first());
    const title = cleanTitle(h1) || text($, $('title').first());
    const originalTitle = text($, $('span.eng-rus').first()) || undefined;

    const posterImg = $('.fposter2 img').first();
    const poster =
      abs(host, posterImg.attr('data-src') || posterImg.attr('src')) ??
      abs(host, $('meta[property="og:image"]').attr('content'));

    const ratingKp = parseRating(text($, $('.mediablock .rat-kp').first()));
    const ratingImdb = parseRating(text($, $('.mediablock .rat-imdb').first()));
    const rating = ratingKp ?? ratingImdb;

    const rows = finfoRows($);
    const pick = (...keys: string[]): string | undefined =>
      rows.find((r) => keys.some((k) => r.label.includes(k)))?.value;

    const year = finfoYear($);

    const genresRow = rows.find((r) => r.label.includes('жанр'));
    let genres: string[] = [];
    const genreEls = $('ul.finfo span[itemprop="genre"], ul.finfo a[itemprop="genre"]');
    genreEls.each((_, g) => {
      const t = text($, g);
      if (t) genres.push(t);
    });
    if (!genres.length && genresRow) {
      genres = genresRow.value
        .split(/[,·/]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const episodes: EpisodeLink[] = [];
    const seenEp = new Set<string>();
    $('a[href*="season-"]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      const m = href.match(/season-(\d+)-episode-(\d+)/);
      if (!m) return;
      const key = `${m[1]}:${m[2]}`;
      if (seenEp.has(key)) return;
      const epUrl = abs(host, href);
      if (!epUrl) return;
      seenEp.add(key);
      episodes.push({ season: Number(m[1]), episode: Number(m[2]), url: epUrl });
    });
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

    const players: PlayerTab[] = [];
    const seenTabs = new Set<string>();
    for (const ep of episodes) {
      if (seenTabs.has(ep.url)) continue;
      seenTabs.add(ep.url);
      players.push({
        label: `Сезон ${ep.season} · Серия ${ep.episode}`,
        url: ep.url,
        kind: 'embed',
      });
    }
    let frameNo = 0;
    $('iframe[src]').each((_, frame) => {
      const frameUrl = abs(host, $(frame).attr('src'));
      if (!frameUrl || seenTabs.has(frameUrl)) return;
      seenTabs.add(frameUrl);
      frameNo++;
      players.push({
        label: frameNo === 1 ? 'Плеер' : `Плеер ${frameNo}`,
        url: frameUrl,
        kind: 'embed',
      });
    });
    if (!players.length) {
      players.push({ label: 'Плеер', url: abs(host, path) ?? url, kind: 'embed' });
    }

    let kind: MediaKind = 'movie';
    if (episodes.length) kind = 'serial';
    else if (genres.some((g) => /мультфильм|мультф/i.test(g))) kind = 'cartoon';
    else if (genres.some((g) => /аниме|anime/i.test(g))) kind = 'anime';

    const seasons = new Set(episodes.map((e) => e.season));
    const lastEp = episodes[episodes.length - 1];

    const ogDesc = ($('meta[property="og:description"]').attr('content') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const description =
      text($, $('.fdesc.full-text p').first()) || text($, $('.fdesc.full-text').first()) || ogDesc;

    return {
      sourceId: this.id,
      url,
      title,
      poster,
      originalTitle,
      year,
      country: pick('страна'),
      director: pick('режисс'),
      cast: pick('в ролях', 'актер', 'актёр'),
      seasonsCount: seasons.size ? String(seasons.size) : undefined,
      lastEpisode: lastEp ? String(lastEp.episode) : undefined,
      genres,
      rating,
      ratingKp,
      ratingImdb,
      description: description || undefined,
      players,
      kind,
      quality:
        bestQualityFromText(ogDesc) ??
        qualityFromHeight($('meta[property="og:video:height"]').attr('content')) ??
        bestQualityFromText(title),
    };
  }

  async resolveStreams(req: StreamsRequest, referer?: string): Promise<StreamCatalog> {
    const tabLabel = req.tabLabel ?? 'Плеер';
    const tabUrl = req.tabUrl;
    const path = pathnameOf(tabUrl);

    let pageUrl = tabUrl;
    let playerIframe: string | undefined;

    if (/\/iplayer\/player\.php/i.test(path)) {
      playerIframe = tabUrl;
      pageUrl = referer ?? tabUrl;
    } else {
      if (!isZetflixHost(tabUrl)) {
        return resolveEmbed(tabUrl, this.id, tabLabel, referer);
      }
      const { html, host } = await this.fetchPage(path);
      pageUrl = `${host}${path}`;
      const $ = cheerio.load(html);
      $('iframe[src]').each((_, frame) => {
        const src = $(frame).attr('src') ?? '';
        if (!playerIframe && /\/iplayer\/player\.php/i.test(src)) {
          playerIframe = abs(host, src);
        }
      });
      if (!playerIframe) {
        const direct = abs(host, $('iframe[src]').first().attr('src'));
        if (!direct) {
          return { sourceId: this.id, tabLabel, episodes: [], fallbackEmbedUrl: pageUrl };
        }
        const cat = await resolveEmbed(direct, this.id, tabLabel, pageUrl);
        if (cat.episodes.length) return cat;
        return { sourceId: this.id, tabLabel, episodes: [], fallbackEmbedUrl: direct };
      }
    }

    if (!playerIframe) {
      return { sourceId: this.id, tabLabel, episodes: [], fallbackEmbedUrl: pageUrl };
    }

    const candidates: string[] = [];
    let playerHtml = '';
    try {
      playerHtml = await fetchText(playerIframe, {
        referer: pageUrl,
        noBrowser: true,
        timeoutMs: 15000,
      });
    } catch {
      playerHtml = '';
    }
    if (playerHtml) {
      const $p = cheerio.load(playerHtml);
      const inner = $p('iframe[src]').first().attr('src');
      const fallback = $p('[data-fallback-src]').first().attr('data-fallback-src');
      const innerUrl = abs(playerIframe, inner);
      const fallbackUrl = abs(playerIframe, fallback);
      if (innerUrl) candidates.push(innerUrl);
      if (fallbackUrl) candidates.push(fallbackUrl);
    }

    let fallbackEmbedUrl = candidates[0] ?? playerIframe;
    for (const cand of candidates) {
      try {
        const cat = await resolveEmbed(cand, this.id, tabLabel, pageUrl);
        if (cat.episodes.length) return cat;
        fallbackEmbedUrl = cat.fallbackEmbedUrl ?? cand;
      } catch {
        // try the next target
      }
    }
    return { sourceId: this.id, tabLabel, episodes: [], fallbackEmbedUrl };
  }

  private parseSections(
    $: CheerioAPI,
    baseUrl: string,
  ): { title: string; items: MediaSummary[] }[] {
    const out: { title: string; items: MediaSummary[] }[] = [];
    $('.sect').each((_, sect) => {
      const el = $(sect);
      if (el.parents('.sect').length) return;
      const title = text($, el.find('.sect-title').first());
      if (!title) return;
      const items = this.parseCards($, baseUrl, el);
      if (items.length) out.push({ title, items });
    });
    return out;
  }

  private parseCards($: CheerioAPI, baseUrl: string, scope?: CheerioEl): MediaSummary[] {
    const root = scope ?? $.root();
    const items: MediaSummary[] = [];
    root.find('a.vi-img[href], a.sres-wrap[href]').each((_, node) => {
      const el = $(node);
      const href = el.attr('href');
      const url = abs(baseUrl, href);
      if (!url) return;
      // «Показать больше фильмов» и подобные ссылки ведут на корень раздела (/films/)
      // — это навигация секции, а не карточка.
      let path = '';
      try {
        path = new URL(url).pathname.replace(/\/+$/, '');
      } catch {
        return;
      }
      if (/^\/(films|serials|cartoons)$/.test(path)) return;
      const attrTitle = cleanTitle(el.attr('title') ?? '');
      const title =
        attrTitle ||
        cleanTitle(text($, el.find('.vi-title').first())) ||
        cleanTitle(text($, el.find('.sres-text h2').first())) ||
        text($, el.find('h2, h3').first());
      if (!title) return;
      if (/^Показать больше/i.test(title)) return;
      const img = el.find('img').first();
      const poster = abs(baseUrl, img.attr('data-src') || img.attr('src'));
      const yearMatch = title.match(/\((?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?\)/);
      // kind определяется по пути карточки: без него карточки главной и
      // коренных категорий исчезали из-под любого фильтра «Тип»
      const kind = classifyPath(path);
      items.push({
        url,
        title: yearMatch
          ? title.replace(/\s*\((?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?\)\s*$/, '').trim()
          : title,
        poster,
        year: yearMatch ? maxYear(yearMatch[0]) : yearFromPoster(poster),
        siteDate: siteDateFromPoster(poster),
        kind,
        quality: bestQualityFromText(attrTitle || title),
      });
    });
    return items;
  }
}
