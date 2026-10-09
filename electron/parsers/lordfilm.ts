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
import { effectiveCategory, extractGenreSlugs, resolveGenreSlug, singleYear, stampGenre } from './filtering';
import { enrichSummaries, maxYear } from './shared';

const DEFAULT_HOST = 'https://lordfilm.com.ru';

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
  // the bare homepage is a promo landing (anchors only) — the updates feed
  // carries the actual cards
  home: '/lastnews/',
  new: '/lastnews/',
  films: '/film/',
  serials: '/series/',
  cartoons: '/multfilm/',
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

function parseNumber(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

interface LdActor {
  name?: string;
}

interface LdJson {
  '@type'?: string;
  name?: string;
  alternateName?: string;
  image?: string;
  description?: string;
  genre?: string;
  datePublished?: string;
  numberOfSeasons?: string;
  director?: string | LdActor | Array<string | LdActor>;
  actor?: LdActor[];
  aggregateRating?: { ratingValue?: string | number; ratingCount?: string | number };
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
    const parsed = JSON.parse(raw) as LdJson;
    if (parsed && (parsed.name || parsed['@type'])) return parsed;
    return null;
  } catch {
    return null;
  }
}

function directorNames(director?: LdJson['director']): string | undefined {
  if (!director) return undefined;
  const list = Array.isArray(director) ? director : [director];
  const names = list
    .map((d) => (typeof d === 'string' ? d : d?.name))
    .filter((n): n is string => !!n);
  return names.length ? names.join(', ') : undefined;
}

/** The details block is a row of two spans: label then value. */
function detailRows($: CheerioAPI): Record<string, string> {
  const info: Record<string, string> = {};
  $('div.detail-row').each((_, row) => {
    const spans = $(row).find('span');
    const label = text($, spans.first()).toLowerCase().replace(/[:：]/g, '').trim();
    const value = text($, spans.eq(1));
    if (label && value) info[label] = value;
  });
  return info;
}

function detectKind(url: string, ld?: LdJson | null): MediaKind {
  if (ld?.['@type'] === 'TVSeries' || ld?.['@type'] === 'TVMiniSeries') return 'serial';
  try {
    const path = new URL(url).pathname;
    if (path.startsWith('/series/')) return 'serial';
    if (path.startsWith('/multfilm/') || path.startsWith('/multseries/')) return 'cartoon';
    if (path.startsWith('/film/')) return 'movie';
  } catch {
    // not parseable — fall through
  }
  return 'movie';
}

export class LordfilmParser implements SourceParser {
  readonly id = 'lordfilm';
  readonly name = 'LordFilm';
  readonly categories = CATEGORIES;

  private baseUrl = DEFAULT_HOST;

  matchesUrl(url: string): boolean {
    try {
      return /(^|\.)lordfilm/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  private async fetchPage(url: string, referer?: string): Promise<string> {
    const html = await fetchText(url, { referer });
    if (!html || html.length < 2000) throw new Error('Пустая страница источника LordFilm');
    this.baseUrl = new URL(url).origin;
    return html;
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    // Серверная фильтрация: тип уводит в родной раздел, жанр — в страницу
    // жанра этого раздела (для «Главной»/«Новинок» — в раздел фильмов),
    // одиночный год — в годовой архив. Query `?genre=`/`?year=` источник
    // молча игнорирует, поэтому в URL они не передаются.
    const cat = effectiveCategory(categoryId, filters, CATEGORY_PATHS);
    const catPath = CATEGORY_PATHS[cat];
    const genrePath = await this.genrePath(cat, filters?.genre);
    // Годовые архивы: `/film/year2024/`, `/series/year2024/`, для «Главной» и
    // «Новинок» — верхний `/year2024/` (ведёт на раздел фильмов, как в kinogo).
    // У мультфильмов годового архива нет — год остаётся локальной фильтрацией.
    // Жанр важнее года: комбинации «жанр+год» у источника нет, а локальный
    // год на карточках (`.item__year`) срабатывает.
    const year = singleYear(filters);
    let yearPath: string | undefined;
    if (!genrePath && year) {
      if (catPath === CATEGORY_PATHS['films'] || catPath === CATEGORY_PATHS['serials']) {
        yearPath = `${catPath}year${year}/`;
      } else if (catPath !== CATEGORY_PATHS['cartoons']) {
        yearPath = `/year${year}/`;
      }
    }
    const path = genrePath ?? yearPath ?? catPath;
    // no such section on this source — answer without a wasted round-trip
    if (path === undefined) return { items: [], page, hasMore: false };
    const pagePath = page > 1 ? `page/${page}/` : '';
    const html = await this.fetchPage(`${this.baseUrl}${path}${pagePath}`);
    const $ = cheerio.load(html);
    const parsed = this.parseCards($);
    const hasMore = this.hasNextPage($, page);
    const enriched = await enrichSummaries(parsed, 12, (u) => this.getDetails(u));
    // Жанр применён сервером — проставляем его карточкам после гидратации
    // (она перезаписывает genres данными со страницы деталей).
    const items = genrePath && filters?.genre ? stampGenre(enriched, filters.genre) : enriched;
    return { items, page, hasMore };
  }

  /** «Название жанра → слаг» по навигации страницы раздела. */
  private genreSlugs?: { map: Map<string, string>; ts: number };

  /**
   * Жанровые разделы на LordFilm существуют только под `/film/` и
   * `/series/`; у мультфильмов собственных нет — для них (как и для
   * неизвестных разделов) остаёмся на локальной фильтрации. У «Главной»
   * и «Новинок» своих жанровых страниц тоже нет, но берём раздел
   * фильмов: без серверного жанра локальная фильтрация оставляла бы
   * 3 из 35 карточек (у карточек нет поля genres до гидратации).
   */
  private async genrePath(cat: string, genre?: string): Promise<string | undefined> {
    const base = CATEGORY_PATHS[cat];
    const sectioned = base === CATEGORY_PATHS['films'] || base === CATEGORY_PATHS['serials'];
    const feed = base === CATEGORY_PATHS['home'] || base === CATEGORY_PATHS['new'];
    if (!genre || (!sectioned && !feed)) {
      return undefined;
    }
    const now = Date.now();
    if (!this.genreSlugs || now - this.genreSlugs.ts > GENRE_MAP_TTL_MS) {
      let map = new Map<string, string>();
      try {
        const html = await fetchText(`${this.baseUrl}${CATEGORY_PATHS['films']}`, {
          referer: `${this.baseUrl}/`,
        });
        map = extractGenreSlugs(html, this.baseUrl);
      } catch {
        // навигации нет — фильтрация останется локальной
      }
      this.genreSlugs = { map, ts: now };
    }
    const slug = resolveGenreSlug(this.genreSlugs.map, genre);
    const genreBase = sectioned ? base : CATEGORY_PATHS['films'];
    return slug ? `${genreBase}${slug}/` : undefined;
  }

  async search(query: string): Promise<PagedResult> {
    const q = encodeURIComponent(query.trim());
    if (!q) return { items: [], page: 1, hasMore: false };
    try {
      const html = await this.fetchPage(
        `${this.baseUrl}/index.php?do=search&subaction=search&story=${q}`,
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

    const h1 = text($, $('h1').first());
    // «Одиссея (2026)» — the trailing paren holds the year
    const yearInParens = h1.match(/\s*\(((?:19|20)\d{2})\)\s*$/);
    const title = (yearInParens ? h1.replace(/\s*\([^)]*\)\s*$/, '') : h1).trim();
    const poster = abs(origin, ld?.image ?? $('meta[property="og:image"]').attr('content'));

    const info = detailRows($);
    const genres = (ld?.genre ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);

    const rating =
      parseNumber(text($, $('div.page__list-rates-item.kp span').first())) ??
      parseNumber(String(ld?.aggregateRating?.ratingValue ?? ''));
    const votes =
      parseNumber(text($, $('div.page__list-rates-item.kp small').first())) ??
      parseNumber(String(ld?.aggregateRating?.ratingCount ?? ''));

    // player tabs: labels from the buttons, one content box per iframe
    const labels: string[] = [];
    $('div.tabs-block__select button').each((_, button) => {
      const label = text($, button);
      if (label) labels.push(label);
    });
    const frames: string[] = [];
    $('div.tabs-block__content').each((_, box) => {
      const frame = $(box).find('iframe').first();
      const src = abs(origin, frame.attr('src') || frame.attr('data-src'));
      if (src && !src.startsWith('about:')) frames.push(src);
    });
    const players: PlayerTab[] = frames.map((u, i) => {
      const label = labels[i] ?? 'Плеер';
      const kind: PlayerTab['kind'] =
        /youtube|youtu\.be/i.test(u) || /трейлер/i.test(label) ? 'trailer' : 'embed';
      return { label, url: u, kind };
    });

    const cast =
      info['в ролях'] ??
      ld?.actor
        ?.map((a) => a?.name)
        .filter(Boolean)
        .join(', ');
    const year =
      (yearInParens ? maxYear(yearInParens[1]) : undefined) ??
      maxYear(ld?.datePublished) ??
      maxYear(h1);

    return {
      sourceId: this.id,
      url,
      title: title || ld?.name || h1,
      poster,
      originalTitle: ld?.alternateName || undefined,
      year,
      genres,
      rating,
      votes: Number.isFinite(votes as number) ? (votes as number) : undefined,
      director: info['режиссёр'] ?? info['режиссер'] ?? directorNames(ld?.director),
      cast: cast || undefined,
      seasonsCount:
        ld?.numberOfSeasons ??
        text(
          $,
          $('.sect__title').filter((_, el) => /Сезон \d+ из \d+/.test(text($, el))),
        ).match(/из (\d+)/)?.[1],
      description:
        ld?.description || $('meta[property="og:description"]').attr('content') || undefined,
      players,
      kind: detectKind(url, ld),
    };
  }

  private parseCards($: CheerioAPI): MediaSummary[] {
    const items: MediaSummary[] = [];
    const seen = new Set<string>();
    $('div.item.expand-link').each((_, card) => {
      const el = $(card);
      const link = el.find('a.item__title').first();
      const url = abs(this.baseUrl, link.attr('href'));
      const title = text($, link) || link.attr('title')?.trim() || '';
      if (!url || !title || seen.has(url)) return;
      seen.add(url);
      const img = el.find('img').first();
      const poster = abs(this.baseUrl, img.attr('src') || img.attr('data-src'));
      const rating = parseNumber(text($, el.find('.item__rates-item.kp').first()));
      items.push({
        url,
        title,
        poster,
        year: maxYear(text($, el.find('.item__year').first())),
        rating,
        kind: detectKind(url),
      });
    });
    return items;
  }

  private hasNextPage($: CheerioAPI, currentPage: number): boolean {
    const next = currentPage + 1;
    let found = false;
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      if (href.includes(`/page/${next}/`)) found = true;
    });
    return found;
  }
}
