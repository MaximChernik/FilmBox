import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { fetchText } from '../fetcher';
import type { Category, MediaDetails, MediaSummary, PagedResult, PlayerTab, CatalogFilterState } from '../models';
import type { SourceParser } from './base';
import { kindCategory, normGenre, stampGenre } from './filtering';
import { maxYear } from './shared';

const DEFAULT_HOST = 'https://reyohoho.com';

/** Размер страницы родного фида (сайт подставляет его в курсорную подгрузку). */
const PAGE_SIZE = 40;

/** Карточка родного фида `?handler=Movies` — ровно то, чем грузится лента сайта. */
interface FeedMovie {
  id: number;
  name: string;
  year?: number;
  posterUrl?: string;
  kp?: string;
  imdb?: string;
  tmdb?: string;
}

interface FeedResponse {
  movies?: FeedMovie[];
  hasMore?: boolean;
  nextCursor?: string;
}

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
];

/**
 * «Жанр приложения → слаг ReYohoho». Справочника жанров сайт не отдаёт
 * (в навигации только Драма/Спорт/Ужасы), поэтому слаги проверены по живой
 * выдаче: несуществующий слаг молча возвращает главную страницу. Мультфильмы
 * и аниме у источника отсутствуют вовсе.
 */
const GENRE_SLUGS: Record<string, string> = {
  'боевик': 'action',
  'комедия': 'comedy',
  'драма': 'drama',
  'ужасы': 'horror',
  'триллер': 'thriller',
  'фантастика': 'sci-fi',
  'фэнтези': 'fantasy',
  'приключения': 'adventure',
  'мелодрама': 'melodrama',
  'детектив': 'detective',
  'криминал': 'crime',
  'семейный': 'family',
  'исторический': 'history',
  'военный': 'war',
  'биографический': 'biography',
  'вестерн': 'western',
  'мюзикл': 'musical',
  'спортивный': 'sport',
  'спорт': 'sport',
  'документальный': 'documentary',
};

// Films-only source: one newest-first feed, titles live under /films/<kp-id>,
// sections are genres («Популярное», «Детский»…) — no serial/cartoon shelves.
const CATEGORY_PATHS: Record<string, string> = {
  home: '/',
  new: '/',
  films: '/',
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

/** «8,6 / 10» / «7.4» / «-» → number | undefined (no zero-from-empty traps). */
function parseRating(raw?: string): number | undefined {
  if (!raw) return undefined;
  const head = raw.split('/')[0];
  const cleaned = head.replace(',', '.').replace(/[^\d.]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export class ReYohohoParser implements SourceParser {
  readonly id = 'reyohoho';
  readonly name = 'ReYohoho';
  readonly categories = CATEGORIES;

  private baseUrl = DEFAULT_HOST;

  matchesUrl(url: string): boolean {
    try {
      return /(^|\.)reyohoho\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  private async fetchPage(url: string, referer?: string): Promise<string> {
    // Прямой запрос: скрытый браузер-фолбэк fetcher'а добавлял бы 1.5–25 с на
    // каждый пустой ответ медленного хоста — именно это читалось как «очень
    // долгий парсинг». Пустой ответ = витрину пропускаем, а не ждём браузер.
    const html = await fetchText(url, { referer, noBrowser: true, timeoutMs: 12000 });
    if (!html || html.length < 2000) throw new Error('Пустая страница источника ReYohoho');
    this.baseUrl = new URL(url).origin;
    return html;
  }

  /** Фид и HTML живут на одном URL: `?handler=Movies` переключает ответ в JSON. */
  private async fetchJson<T>(url: string): Promise<T> {
    const body = await fetchText(url, {
      noBrowser: true,
      timeoutMs: 12000,
      validate: (text) => text.trimStart().startsWith('{'),
    });
    if (!body) throw new Error('Пустая страница источника ReYohoho');
    return JSON.parse(body) as T;
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    // У источника только фильмы: сериалов, мультфильмов и аниме здесь нет,
    // а фид всегда отдаёт kind: 'movie' — такие фильтры отсекаем сразу,
    // не тратя запрос (раньше они просто терялись в локальной фильтрации).
    const kind = kindCategory(filters?.kind);
    if (kind && kind !== 'films') return { items: [], page, hasMore: false };

    const path = CATEGORY_PATHS[categoryId];
    // no such section on this source — answer without a wasted round-trip
    if (path === undefined) return { items: [], page, hasMore: false };

    // Родной фид `?handler=Movies` — тот, чем сайт грузит свою ленту:
    // жанр (genreSlug), диапазон годов (yearFrom/yearTo) и листание применяются
    // сервером, а hasMore/nextCursor явно сообщают о продолжении. Это важно
    // для отфильтрованных страниц: у них нет seo-ссылок ?page=, и HTML-листание
    // обрывалось на первом экране (~5 карточек). Курсор источника равен номеру
    // страницы, поэтому запрос страницы N воспроизводим без состояния.
    const params = new URLSearchParams({ handler: 'Movies', pageSize: String(PAGE_SIZE) });
    const slug = filters?.genre ? GENRE_SLUGS[normGenre(filters.genre)] : undefined;
    if (slug) params.set('genreSlug', slug);
    // Диапазон годов — только парой: сервер игнорирует голый yearFrom
    // (отдаёт дефолтную ленту), а голый yearTo вообще ломает ответ (HTML
    // вместо JSON). Открытые диапазоны («с 2024»/«по 2024») обслуживает
    // локальная фильтрация.
    const yf = Number(filters?.yearFrom) || 0;
    const yt = Number(filters?.yearTo) || 0;
    if (yf && yt && yt >= yf) {
      params.set('yearFrom', String(yf));
      params.set('yearTo', String(yt));
    }
    if (page > 1) params.set('next', String(page));
    const data = await this.fetchJson<FeedResponse>(`${this.baseUrl}${path}?${params.toString()}`);
    const parsed = (data.movies ?? []).map((movie) => this.toSummary(movie));
    // Сервер уже собрал страницу под жанр — проставляем его карточкам:
    // у ReYohoho поле genres отсутствует вовсе, и локальная фильтрация
    // зачистила бы полностью готовую выдачу.
    const items = slug && filters?.genre ? stampGenre(parsed, filters.genre) : parsed;
    return { items, page, hasMore: !!data.hasMore };
  }

  async search(query: string): Promise<PagedResult> {
    const q = query.trim();
    if (!q) return { items: [], page: 1, hasMore: false };
    try {
      const params = new URLSearchParams({ handler: 'Movies', pageSize: String(PAGE_SIZE), q });
      const data = await this.fetchJson<FeedResponse>(`${this.baseUrl}/?${params.toString()}`);
      return {
        items: (data.movies ?? []).map((movie) => this.toSummary(movie)),
        page: 1,
        hasMore: false,
      };
    } catch {
      return { items: [], page: 1, hasMore: false };
    }
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const html = await this.fetchPage(url, url);
    const $ = cheerio.load(html);
    const origin = new URL(url).origin;

    const title = text($, $('h1.film-details-title').first()) || text($, $('h1').first());
    const originalTitle = text($, $('.film-details-subtitle span').first()) || undefined;
    const poster = abs(
      origin,
      $('img.film-details-poster').first().attr('src') ??
        $('meta[property="og:image"]').attr('content'),
    );

    let year: string | undefined;
    $('.film-details-meta .film-meta-chip').each((_, chip) => {
      const value = text($, chip);
      if (/^(19|20)\d{2}$/.test(value)) year = value;
    });
    if (!year) year = maxYear(text($, $('.film-details-meta').first()));

    const rating = parseRating(
      text($, $('.film-average-rating-value strong').first()) ||
        text($, $('.film-average-rating-value').first()),
    );

    const genres: string[] = [];
    let country: string | undefined;
    $('.film-details-line').each((_, line) => {
      const label = text($, $(line).find('.film-line-label').first())
        .toLowerCase()
        .replace(/[:：]/g, '')
        .trim();
      const value = text($, $(line).find('span').eq(1));
      if (!label || !value) return;
      if (label.startsWith('жанр')) {
        for (const g of value.split(',')) {
          const trimmed = g.trim();
          if (trimmed) genres.push(trimmed);
        }
      } else if (label.startsWith('стран')) {
        country = value;
      }
    });

    // player panes: buttons carry labels, panes carry iframe srcs. The site
    // JS (when present — fetchText may answer with the rendered page) pauses
    // inactive iframes, moving the real URL into data-player-url and leaving
    // about:blank behind. Vibix has no URL of its own in the static markup
    // and resolves to a kinescope frame that refuses foreign parents;
    // VeoVeo answers 404 — both are skipped.
    const labels = new Map<string, string>();
    $('button.film-player-option').each((_, button) => {
      const key = $(button).attr('data-player-select');
      const label = $(button).attr('data-player-name')?.trim();
      if (key && label) labels.set(key, label);
    });
    const players: PlayerTab[] = [];
    $('div.film-player-pane[data-player-pane]').each((_, pane) => {
      const frame = $(pane).find('iframe').first();
      const src = abs(
        origin,
        frame.attr('data-player-url') || frame.attr('data-src') || frame.attr('src'),
      );
      if (!src || src.startsWith('about:')) return;
      if (/perepolokha\.link|kinescopecdn\.net/i.test(src)) return;
      const label = labels.get($(pane).attr('data-player-pane') ?? '') ?? 'Плеер';
      players.push({ label, url: src, kind: 'embed' });
    });
    // the stravers pane resolves instantly and plays from the stage;
    // the kinoserial pane is a flaky host — keep it second
    players.sort((a, b) => Number(/stravers/i.test(b.url)) - Number(/stravers/i.test(a.url)));

    return {
      sourceId: this.id,
      url,
      title,
      poster,
      originalTitle,
      year,
      genres,
      rating,
      country,
      description:
        text($, $('.film-details-description').first()) ||
        $('meta[property="og:description"]').attr('content') ||
        undefined,
      players,
      kind: 'movie',
    };
  }

  private toSummary(movie: FeedMovie): MediaSummary {
    const ratingKp = parseRating(movie.kp);
    const ratingImdb = parseRating(movie.imdb);
    const ratingTmdb = parseRating(movie.tmdb);
    return {
      url: `${this.baseUrl}/films/${movie.id}`,
      title: movie.name,
      poster: abs(this.baseUrl, movie.posterUrl),
      year: movie.year ? String(movie.year) : undefined,
      rating: ratingKp ?? ratingImdb ?? ratingTmdb,
      ratingKp,
      ratingImdb,
      kind: 'movie',
    };
  }
}
