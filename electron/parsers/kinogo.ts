import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { fetchText } from '../fetcher';
import type {
  Category,
  MediaDetails,
  MediaKind,
  MediaSummary,
  PagedResult,
  PlayerTab,
  CatalogFilterState,} from '../models';
import type { SourceParser } from './base';
import {
  effectiveCategory,
  extractGenreSlugs,
  resolveGenreSlug,
  rootGenreAllowed,
  singleYear,
  stampGenre,
} from './filtering';
import { maxYear, seasonsFromRow, seasonsFromText, siteDateFromPoster } from './shared';

type CheerioEl = ReturnType<CheerioAPI>;

/** Как долго живёт маппинг «жанр → слаг», снятый со страницы источника. */
const GENRE_MAP_TTL_MS = 30 * 60 * 1000;

const DEFAULT_MIRRORS = [
  'https://kinogo.club',
  'https://kinogo.ac',
  'https://kinogo.online',
  'https://kinogo-net.ru',
];

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
  { id: 'serials', title: 'Сериалы' },
  { id: 'cartoons', title: 'Мультфильмы' },
  { id: 'anime', title: 'Аниме' },
];

const CATEGORY_PATHS: Record<string, string> = {
  home: '/',
  films: '/films/',
  serials: '/zarubeshnye_serial/',
  cartoons: '/multfilm/',
  anime: '/anime/',
};

/** The «Films of YYYY» archive, resolved per request: the year rolls over. */
function yearPath(year: number): string {
  return `/filmy-${year}/`;
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

interface InfoRow {
  label: string;
  value: string;
  links: string[];
}

function parseInfoRows($: CheerioAPI, scope: CheerioEl): InfoRow[] {
  const rows: InfoRow[] = [];
  scope.find('tr').each((_, tr) => {
    const label = text($, $(tr).find('td.i-h').first());
    if (!label) return;
    const valueCell = $(tr).find('td').eq(1);
    const links: string[] = [];
    valueCell.find('a').each((__, a) => {
      const t = text($, a);
      if (t) links.push(t);
    });
    rows.push({
      label: label.toLowerCase().replace(/[:：]/g, '').trim(),
      value: text($, valueCell),
      links,
    });
  });
  return rows;
}

function pickField(rows: InfoRow[], ...keys: string[]): InfoRow | undefined {
  return rows.find((r) => keys.some((k) => r.label.includes(k)));
}

function detectKind(rows: InfoRow[], genres: string[]): MediaKind {
  const seasons = pickField(rows, 'сезонов', 'сезон');
  if (seasons) return 'serial';
  const all = genres.join(' ').toLowerCase();
  if (all.includes('мультфильм') || all.includes('мультф')) return 'cartoon';
  if (all.includes('аниме') || all.includes('anime')) return 'anime';
  if (all.includes('сериал')) return 'serial';
  return 'movie';
}

export class KinogoParser implements SourceParser {
  readonly id = 'kinogo';
  readonly name = 'Kinogo';
  readonly categories = CATEGORIES;

  private mirrors: string[];
  private baseUrl: string;

  constructor(mirrors: string[] = DEFAULT_MIRRORS) {
    this.mirrors = mirrors;
    this.baseUrl = mirrors[0];
  }

  matchesUrl(url: string): boolean {
    return /(^|\.)kinogo/i.test(new URL(url).hostname);
  }

  private async fetchFirst(
    buildUrl: (host: string) => string,
    referer?: string,
  ): Promise<{ html: string; host: string }> {
    // race the mirrors in parallel — sequentially trying four hosts (each up
    // to 20s + a hidden-browser fallback) is what made kinogo the slowest
    // source; Promise.any returns as soon as the first one answers
    const attempts = this.mirrors.map(async (host) => {
      const html = await fetchText(buildUrl(host), { referer });
      if (!html || html.length <= 3000) throw new Error(`${host}: короткий ответ`);
      return { html, host };
    });
    try {
      const winner = await Promise.any(attempts);
      if (winner.host !== this.baseUrl) this.baseUrl = winner.host;
      return winner;
    } catch (err) {
      const reasons = ((err as AggregateError).errors ?? []).map((e) => (e as Error).message);
      throw new Error(`Не удалось загрузить данные источника: ${reasons.join('; ')}`);
    }
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    // Серверная фильтрация: тип уводит в родной раздел, жанр — в страницу
    // жанра, год — в архив года. Ничего из этого не передаётся параметрами
    // URL: kinogo их игнорирует, а `?year=` вообще отдаёт 404 и убивал источник.
    const cat = effectiveCategory(categoryId, filters, CATEGORY_PATHS);
    const genrePath =
      filters?.genre && rootGenreAllowed(categoryId, filters)
        ? await this.genrePath(filters.genre)
        : undefined;
    // Архив года существует только для фильмов и сериалов. Для раздела
    // «Главная» его тоже берём: главная отдаёт свежие (2025–2026) карточки,
    // и локальный фильтр года зачистил бы их дочиста. Мультфильмам и аниме
    // архив не подставляем — он сломал бы привязку к разделу, которую
    // локальная фильтрация не восстанавливает (раздел — не фильтр).
    const yearArchive = ['home', 'new', 'films', 'serials'].includes(cat)
      ? singleYear(filters)
      : undefined;

    if (!genrePath && !yearArchive && cat === 'new') return this.getNewCatalog(page);

    const path =
      genrePath ??
      (yearArchive
        ? cat === 'serials'
          ? `/serialy-${yearArchive}/`
          : `/filmy-${yearArchive}/`
        : CATEGORY_PATHS[cat]);
    // no such category on this source — answer instantly instead of
    // silently serving the homepage under a foreign heading
    if (path === undefined) return { items: [], page, hasMore: false };
    const pagePath = page > 1 ? `page/${page}/` : '';
    const url = (host: string) => `${host}${path}${pagePath}`;
    const { html, host } = await this.fetchFirst(url);
    const $ = cheerio.load(html);
    const parsed = this.parseCards($, host);
    // Сервер уже собрал страницу под этот жанр: проставляем его карточкам,
    // иначе локальная фильтрация зачистила бы готовую выдачу — не у всех
    // карточек есть поле genres.
    const items = genrePath && filters?.genre ? stampGenre(parsed, filters.genre) : parsed;
    const hasMore = this.hasNextPage($, page);
    return { items, page, hasMore };
  }

  /** «Название жанра → слаг» по навигации самой страницы источника. */
  private genreSlugs?: { map: Map<string, string>; ts: number };

  private async genrePath(genre: string): Promise<string | undefined> {
    const now = Date.now();
    if (!this.genreSlugs || now - this.genreSlugs.ts > GENRE_MAP_TTL_MS) {
      let map = new Map<string, string>();
      try {
        const { html, host } = await this.fetchFirst((h) => `${h}${CATEGORY_PATHS['films']}`);
        map = extractGenreSlugs(html, host);
      } catch {
        // навигации нет — просто не фильтруем на сервере, оставляем локально
      }
      this.genreSlugs = { map, ts: now };
    }
    const slug = resolveGenreSlug(this.genreSlugs.map, genre);
    return slug ? `/${slug}/` : undefined;
  }

  /**
   * The current-year archive («Фильмы 2026»). Early in a year it may not
   * exist yet (0 cards) — the previous year's archive then still holds the
   * newest titles, so an empty page falls back one year and remembers the
   * winner, keeping later pages inside a single archive.
   */
  private newYear?: number;

  private async getNewCatalog(page: number): Promise<PagedResult> {
    const pagePath = page > 1 ? `page/${page}/` : '';
    const currentYear = new Date().getFullYear();
    const years = this.newYear !== undefined ? [this.newYear] : [currentYear, currentYear - 1];
    for (const year of years) {
      const path = yearPath(year);
      const url = (host: string) => `${host}${path}${pagePath}`;
      const { html, host } = await this.fetchFirst(url);
      const $ = cheerio.load(html);
      const items = this.parseCards($, host);
      if (items.length) {
        this.newYear = year;
        return { items, page, hasMore: this.hasNextPage($, page) };
      }
    }
    return { items: [], page, hasMore: false };
  }

  async search(query: string): Promise<PagedResult> {
    const q = encodeURIComponent(query.trim());
    if (!q) return { items: [], page: 1, hasMore: false };
    const { html, host } = await this.fetchFirst(
      (h) => `${h}/index.php?do=search&subaction=search&story=${q}`,
    );
    const $ = cheerio.load(html);
    return { items: this.parseCards($, host), page: 1, hasMore: false };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const { html } = await this.fetchFirst(() => url, url);
    const $ = cheerio.load(html);
    const origin = new URL(url).origin;

    const h1 = text($, $('h1').first());
    const title = h1 || text($, $('title').first());
    const posterImg = $('.movie-poster img').first();
    const poster = abs(origin, posterImg.attr('src') || posterImg.attr('data-src'));

    const rows = parseInfoRows($, $('.movie-info'));
    const genresEl = pickField(rows, 'жанр');
    const genres = genresEl?.links.length
      ? genresEl.links
      : genresEl?.value
          .split(/[,/·]/)
          .map((s) => s.trim())
          .filter(Boolean);

    const ratingBlock = $('.player-r-value').first();
    const ratingText = text($, ratingBlock);
    const rating = parseRating(ratingText.split('/')[0]);
    const votesMatch = ratingText.match(/\((\d+)\)/);
    const votes = votesMatch ? Number(votesMatch[1]) : undefined;

    const players: PlayerTab[] = [];
    $('ul.js-player-tabs li').each((_, li) => {
      const src = $(li).attr('data-src');
      if (!src) return;
      const label = text($, li) || 'Плеер';
      const url2 = abs(origin, src);
      if (!url2) return;
      const kind: PlayerTab['kind'] = /youtube|youtu\.be|trailer/i.test(url2)
        ? 'trailer'
        : /youtube|трейлер/i.test(label)
          ? 'trailer'
          : 'embed';
      players.push({ label, url: url2, kind });
    });

    const original = pickField(rows, 'оригиналь', 'original');
    const year = pickField(rows, 'год');
    const country = pickField(rows, 'страна');
    const director = pickField(rows, 'режисс');
    const cast = pickField(rows, 'в ролях', 'актер', 'актёр', 'актрис');
    const seasons = pickField(rows, 'сезонов', 'сезон');
    const lastEp = pickField(rows, 'последняя серия', 'последн');

    return {
      sourceId: this.id,
      url,
      title,
      poster,
      originalTitle: original?.value,
      year: maxYear(year?.value),
      siteDate: siteDateFromPoster(poster),
      country: country?.value,
      director: director?.value,
      cast: cast?.value,
      seasonsCount: seasons
        ? (seasonsFromRow(seasons.label, seasons.value) ?? seasons.value)
        : undefined,
      lastEpisode: lastEp?.value,
      genres: genres ?? [],
      rating,
      votes,
      quality: pickField(rows, 'качество')?.value,
      description: text($, $('.description p').first()),
      players,
      kind: detectKind(rows, genres ?? []),
    };
  }

  private parseCards($: CheerioAPI, baseUrl: string): MediaSummary[] {
    const items: MediaSummary[] = [];
    $('article.shortstory').each((_, article) => {
      const el = $(article);
      const link = el.find('h3 a').first();
      const url = abs(baseUrl, link.attr('href'));
      const title = link.attr('title')?.trim() || text($, link);
      if (!url || !title) return;

      const img = el.find('.cover img').first();
      const poster = abs(baseUrl, img.attr('data-src') || img.attr('src'));

      const rows = parseInfoRows($, el);
      const genresRow = pickField(rows, 'жанр');
      const genres = genresRow?.links.length
        ? genresRow.links
        : genresRow?.value
            .split(/[,/·]/)
            .map((s) => s.trim())
            .filter(Boolean);

      const ratingRaw = text($, el.find('.color-rate').first());
      const ribbon = el.find('.ribbon').first();
      const ribbonText = ribbon.attr('title')?.trim() || text($, ribbon) || undefined;
      const ribbonSeasons = seasonsFromText(ribbonText);
      const seasonRow = pickField(rows, 'сезонов', 'сезон');

      items.push({
        url,
        title,
        poster,
        originalTitle: pickField(rows, 'оригиналь', 'original')?.value,
        year: maxYear(pickField(rows, 'год')?.value),
        siteDate: siteDateFromPoster(poster),
        genres: genres ?? [],
        quality: pickField(rows, 'качество')?.value,
        rating: parseRating(ratingRaw),
        ribbon: ribbonText,
        seasonsCount:
          ribbonSeasons.seasonsCount ??
          (seasonRow ? seasonsFromRow(seasonRow.label, seasonRow.value) : undefined),
        lastEpisode: ribbonSeasons.lastEpisode,
        kind: detectKind(rows, genres ?? []),
      });
    });
    return items;
  }

  private hasNextPage($: CheerioAPI, currentPage: number): boolean {
    const next = currentPage + 1;
    let found = false;
    $('div.pagination a').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      if (new RegExp(`/page/${next}/(?:$|\\?)`).test(href)) found = true;
    });
    if (found) return true;
    const items = $('article.shortstory').length;
    return items >= 10;
  }
}
