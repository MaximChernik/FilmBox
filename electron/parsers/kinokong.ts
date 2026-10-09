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
import {
  maxYear,
  normalizeSiteDate,
  seasonsFromRow,
  seasonsFromText,
  siteDateFromPoster,
  bestQualityFromText,
  enrichSummaries,
} from './shared';

const DEFAULT_HOST = 'https://kinokong.co';

/** Как долго живёт маппинг «жанр → слаг», снятый со страницы источника. */
const GENRE_MAP_TTL_MS = 30 * 60 * 1000;

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
  { id: 'serials', title: 'Сериалы' },
  { id: 'cartoons', title: 'Мультфильмы' },
];

const CATEGORY_PATHS: Record<string, string> = {
  home: '/',
  // the homepage lists the freshest uploads across films AND serials —
  // a dedicated novelties section does not exist here
  new: '/',
  films: '/filmes_v2/',
  serials: '/seriez/',
  cartoons: '/multfilmy/',
};

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

function splitTitle(raw: string): { title: string; year?: string; ribbon?: string } {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const labelMatch = cleaned.match(/\(([^)]+)\)/);
  const label = labelMatch?.[1];
  // a label with a year («(2025)», «(2008-2015)», «(фильм, 2026)») is a date,
  // not a badge; ranges count as their maximum year
  const hasYear = !!label && /\b(?:19|20)\d{2}\b/.test(label);
  const year = hasYear ? maxYear(label) : undefined;
  const title = year || label ? cleaned.replace(/\s*\([^)]*\)\s*$/, '').trim() : cleaned;
  const ribbon = label && !hasYear ? label : undefined;
  return { title: title || cleaned, year, ribbon };
}

function parseRating(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

interface LdJson {
  name?: string;
  description?: string;
  datePublished?: string;
  dateCreated?: string;
  aggregateRating?: { ratingValue?: number | string; ratingCount?: number | string };
}

function readLdJson($: CheerioAPI): LdJson | null {
  let raw: string | undefined;
  $('script[type="application/ld+json"]').each((_, s) => {
    if (raw) return;
    const content = $(s).text();
    if (content.includes('"@type"')) raw = content;
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LdJson & { '@type'?: string };
    if (parsed && (parsed.name || parsed.aggregateRating)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function detectKind(title: string, href: string, genres: string[]): MediaKind {
  const all = `${title} ${href} ${genres.join(' ')}`.toLowerCase();
  if (all.includes('мультфильм') || all.includes('мультф') || all.includes('multserial'))
    return 'cartoon';
  if (all.includes('аниме') || all.includes('anime')) return 'anime';
  if (all.includes('сериал') || all.includes('serial') || all.includes('сезон')) return 'serial';
  return 'movie';
}

export class KinokongParser implements SourceParser {
  readonly id = 'kinokong';
  readonly name = 'KinoKong';
  readonly categories = CATEGORIES;

  private baseUrl = DEFAULT_HOST;

  matchesUrl(url: string): boolean {
    return /(^|\.)kinokong/i.test(new URL(url).hostname);
  }

  private async fetchPage(url: string, referer?: string): Promise<string> {
    const html = await fetchText(url, { referer });
    if (!html || html.length < 2000) throw new Error('Пустая страница источника KinoKong');
    this.baseUrl = new URL(url).origin;
    return html;
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    // Серверная фильтрация: тип уводит в родной раздел, жанр — в страницу
    // жанра, одиночный год — в архив `/<год>/` («Материалы за 2024 год»,
    // листается через page/N/). Query `?genre=`/`?year=` этот источник
    // молча игнорирует, поэтому в URL они не передаются. Жанр важнее года:
    // страницы «жанр+год» у источника нет, а локальный год на карточках
    // срабатывает. Архив без нужного года перенаправляется на свежий —
    // его отсечёт локальная фильтрация по годам.
    const cat = effectiveCategory(categoryId, filters, CATEGORY_PATHS);
    const genrePath =
      filters?.genre && rootGenreAllowed(categoryId, filters)
        ? await this.genrePath(filters.genre)
        : undefined;
    const year = singleYear(filters);
    const path = genrePath ?? (year ? `/${year}/` : CATEGORY_PATHS[cat]);
    // no such category on this source — answer instantly instead of fetching
    // an unrelated page (anime used to hit /multfilmy/ and waste a round-trip)
    if (path === undefined) return { items: [], page, hasMore: false };
    const pagePath = page > 1 ? `page/${page}/` : '';
    const url = `${this.baseUrl}${path}${pagePath}`;
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);
    const parsed = this.parseCards($);
    const hasMore = this.hasNextPage($, page);
    const enriched = await enrichSummaries(parsed, 12, (u) => this.getDetails(u));
    // Жанр применён сервером — проставляем его карточкам после гидратации
    // (она перезаписывает genres своими данными со страницы деталей).
    const items = genrePath && filters?.genre ? stampGenre(enriched, filters.genre) : enriched;
    return { items, page, hasMore };
  }

  /** «Название жанра → слаг» по навигации главной страницы источника. */
  private genreSlugs?: { map: Map<string, string>; ts: number };

  private async genrePath(genre: string): Promise<string | undefined> {
    const now = Date.now();
    if (!this.genreSlugs || now - this.genreSlugs.ts > GENRE_MAP_TTL_MS) {
      let map = new Map<string, string>();
      try {
        const html = await fetchText(`${this.baseUrl}/`, { referer: `${this.baseUrl}/` });
        map = extractGenreSlugs(html, this.baseUrl);
      } catch {
        // навигации нет — фильтрация останется локальной
      }
      this.genreSlugs = { map, ts: now };
    }
    const slug = resolveGenreSlug(this.genreSlugs.map, genre);
    return slug ? `/${slug}/` : undefined;
  }

  async search(query: string): Promise<PagedResult> {
    const q = encodeURIComponent(query.trim());
    if (!q) return { items: [], page: 1, hasMore: false };
    try {
      const html = await this.fetchPage(
        `${this.baseUrl}/index.php?story=${q}&do=search&subaction=search`,
      );
      const $ = cheerio.load(html);
      return { items: this.parseCards($), page: 1, hasMore: false };
    } catch {
      return { items: [], page: 1, hasMore: false };
    }
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const html = await this.fetchPage(url, url);
    const $ = cheerio.load(html);
    const origin = new URL(url).origin;
    const ld = readLdJson($);

    const h1 = text($, $('h1.bslide__title').first()) || text($, $('h1').first());
    const parsed = splitTitle(h1);
    const title = parsed.title;
    const posterImg = $('img.bslide__poster, .big-slider .bslide__poster img').first();
    const poster = abs(
      origin,
      posterImg.attr('src') ||
        posterImg.attr('data-src') ||
        $('header.big-slider img').first().attr('data-src'),
    );

    // the info block lives in ul.pmovie__list with labels in <div>, while the
    // slider's ul.bslide__text uses <span> — read the label from either and
    // take the value as the row's remaining text
    const info: Record<string, string> = {};
    $('ul.bslide__text li, ul.pmovie__header-list li, ul.pmovie__list li').each((_, li) => {
      const el = $(li);
      const labelText = text($, el.children().first());
      if (!labelText) return;
      const full = text($, el);
      const value = full.startsWith(labelText) ? full.slice(labelText.length).trim() : full;
      if (!value) return;
      info[labelText.toLowerCase().replace(/[:：]/g, '').trim()] = value;
    });

    const genresRaw = info['жанр'] ?? '';
    const genres = genresRaw
      .split(/[,/·]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const ratingRaw = ld?.aggregateRating?.ratingValue;
    const rating =
      typeof ratingRaw === 'number'
        ? ratingRaw
        : ratingRaw
          ? Number(String(ratingRaw).replace(',', '.'))
          : undefined;
    const votesRaw = ld?.aggregateRating?.ratingCount;
    const votes = typeof votesRaw === 'number' ? votesRaw : votesRaw ? Number(votesRaw) : undefined;

    const players: PlayerTab[] = [];
    const labels: string[] = [];
    $('div.tabs-block__select span').each((_, span) => {
      const t = text($, span);
      if (t) labels.push(t);
    });
    const contents = $('div.pmovie__player iframe').toArray();
    contents.forEach((frame, index) => {
      const src = $(frame).attr('data-src') || $(frame).attr('src');
      const url2 = abs(origin, src);
      if (!url2 || url2.startsWith('about:')) return;
      const label = labels[index] ?? 'Плеер';
      const kind: PlayerTab['kind'] =
        /youtube|youtu\.be/i.test(url2) || /трейлер/i.test(label) ? 'trailer' : 'embed';
      players.push({ label, url: url2, kind });
    });

    const year = maxYear(info['год'] ?? parsed.year ?? ld?.datePublished?.slice(0, 4));
    const siteDate = normalizeSiteDate(ld?.dateCreated) ?? siteDateFromPoster(poster);
    const seasonsCount =
      info['сезонов']?.match(/\d+/)?.[0] ??
      (info['сезон'] ? seasonsFromRow('сезонов', info['сезон']) : undefined);

    return {
      sourceId: this.id,
      url,
      title: title || (ld?.name ?? ''),
      poster,
      originalTitle: text($, $('h1.bslide__subtitle').first()) || undefined,
      year,
      siteDate,
      country: info['страна'],
      director: info['режиссёр'] ?? info['режиссер'],
      cast: info['в ролях'] ?? info['актеры'],
      seasonsCount,
      genres,
      rating: Number.isFinite(rating as number) ? (rating as number) : undefined,
      votes: Number.isFinite(votes as number) ? (votes as number) : undefined,
      description: ld?.description ?? text($, $('.pmovie__description p, .full-text p').first()),
      players,
      kind: detectKind(h1, url, genres),
    };
  }

  private parseCards($: CheerioAPI): MediaSummary[] {
    const items: MediaSummary[] = [];
    const seen = new Set<string>();
    const push = (
      url: string | undefined,
      raw: string,
      poster?: string,
      badge?: string,
      genres: string[] = [],
    ) => {
      if (!url || !raw || seen.has(url)) return;
      seen.add(url);
      const parsed = splitTitle(raw);
      // the poster badge is either a season counter («1 сезон»), a quality
      // tag («WEB-DL») or an arbitrary ribbon
      const isSeasonBadge = !!badge && /\d+\s*сезон/i.test(badge);
      const isQualityBadge =
        !!badge &&
        !isSeasonBadge &&
        /(web-?dl|webrip|bd?rip|blu-?ray|hdtv|dvd|cam\b|4k|2160|1080|720|576|480|full\s*hd|\bhd\b)/i.test(
          badge,
        );
      const badgeSeasons = isSeasonBadge ? seasonsFromText(badge) : undefined;
      items.push({
        url,
        title: parsed.title,
        poster,
        year: maxYear(parsed.year),
        siteDate: siteDateFromPoster(poster),
        genres,
        quality: isQualityBadge ? badge : (bestQualityFromText(raw) ?? undefined),
        ribbon: isSeasonBadge || isQualityBadge ? undefined : (badge ?? parsed.ribbon),
        seasonsCount: badgeSeasons?.seasonsCount,
        lastEpisode: badgeSeasons?.lastEpisode,
        kind: detectKind(raw, url, genres),
      });
    };

    $('#dle-content div.poster').each((_, card) => {
      const el = $(card);
      const link = el.find('h3 a').first();
      const url = abs(this.baseUrl, link.attr('href'));
      const raw = text($, link) || link.attr('title') || '';
      const img = el.find('img').first();
      const poster = abs(this.baseUrl, img.attr('src') || img.attr('data-src'));
      const ribbon = text($, el.find('.bslide__label').first()) || undefined;
      const genres: string[] = [];
      el.find('ul.poster__subtitle li').each((__, li) => {
        const g = text($, li);
        if (g) genres.push(g);
      });
      push(
        url,
        raw,
        poster,
        ribbon,
        genres.flatMap((g) =>
          g
            .split(/[/·]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      );
    });

    $('a.top[href]').each((_, a) => {
      const el = $(a);
      const url = abs(this.baseUrl, el.attr('href'));
      const raw = el.attr('title')?.trim() || '';
      const img = el.find('img').first();
      const poster = abs(this.baseUrl, img.attr('data-src') || img.attr('src'));
      push(url, raw, poster);
    });

    return items;
  }

  private hasNextPage($: CheerioAPI, currentPage: number): boolean {
    const next = currentPage + 1;
    let found = false;
    $('#pagination a, .pagination__pages a').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      if (new RegExp(`/page/${next}/(?:$|\\?)`).test(href)) found = true;
    });
    return found;
  }
}
