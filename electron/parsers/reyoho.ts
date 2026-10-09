import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import { fetchText } from '../fetcher';
import { resolveEmbed } from './embed-resolver';
import type {
  Category,
  Episode,
  MediaDetails,
  MediaKind,
  MediaSummary,
  PagedResult,
  PlayerTab,
  StreamCatalog,
  StreamsRequest,
  CatalogFilterState,} from '../models';
import type { SourceParser } from './base';
import { effectiveCategory, normGenre, resolveGenreSlug, stampGenre } from './filtering';

const DEFAULT_HOST = 'https://reyoho.ru';

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
  { id: 'serials', title: 'Сериалы' },
  { id: 'cartoons', title: 'Мультфильмы' },
  { id: 'anime', title: 'Аниме' },
];

/** `discover?type=` filter per section; home uses the trending feed. */
const DISCOVER_TYPES: Record<string, string> = {
  films: 'movie',
  serials: 'tv',
  cartoons: 'cartoon',
  anime: 'anime',
};

const KIND_BY_CATEGORY: Record<string, MediaKind> = {
  films: 'movie',
  serials: 'serial',
  cartoons: 'cartoon',
  anime: 'anime',
};

/**
 * Жанры `discover` — слаги CATALOG_GENRES самого сайта. Справочник
 * `/api/search/filters` отдаёт типы, теги и компании, но не жанры, так что
 * словарь собран из чанка поиска (23 жанра). Ключи — и наши подписи
 * («Исторический», «Спортивный»), и подписи сайта («История», «Спорт»):
 * окончания добивает `resolveGenreSlug`.
 */
const GENRE_SLUGS = new Map<string, string>(
  (
    [
      ['боевик', 'action'],
      ['биографический', 'biography'],
      ['биография', 'biography'],
      ['вестерн', 'western'],
      ['военный', 'war'],
      ['детектив', 'mystery'],
      ['детский', 'kids'],
      ['документальный', 'documentary'],
      ['драма', 'drama'],
      ['исторический', 'history'],
      ['история', 'history'],
      ['комедия', 'comedy'],
      ['криминал', 'crime'],
      ['мелодрама', 'romance'],
      ['мистика', 'mysticism'],
      ['музыка', 'music'],
      ['мюзикл', 'musical'],
      ['приключения', 'adventure'],
      ['семейный', 'family'],
      ['спортивный', 'sport'],
      ['спорт', 'sport'],
      ['триллер', 'thriller'],
      ['ужасы', 'horror'],
      ['фантастика', 'speculative_fiction'],
      ['фэнтези', 'fantasy'],
      ['нуар', 'film_noir'],
      ['фильм-нуар', 'film_noir'],
    ] as Array<[string, string]>
  ).map(([label, slug]) => [normGenre(label), slug]),
);

/** Мультфильмы и аниме у источника — не жанры, а типы `discover?type=`. */
const GENRE_KINDS: Record<string, string> = {
  'мультфильм': 'cartoon',
  'аниме': 'anime',
};

const HOME_PAGE_SIZE = 24;

interface DiscoverResult {
  tmdbId?: number;
  kinopoiskId?: number;
  mediaType?: string;
  title?: string;
  originalTitle?: string;
  year?: string;
  posterUrl?: string;
  rating?: number;
  genres?: string[];
  ratings?: { kp?: number | null; imdb?: number | null };
}

interface DiscoverResponse {
  results?: DiscoverResult[];
  page?: number;
  totalPages?: number;
  hasMore?: boolean;
}

interface TrendingItem {
  id?: number;
  title?: string;
  originalTitle?: string;
  posterUrl?: string;
  year?: string;
  mediaType?: string;
  kinopoiskFilmId?: number;
}

interface TrendingResponse {
  items?: TrendingItem[];
  ratings?: Record<string, { kp?: number | null; imdb?: number | null }>;
}

interface PlayerConfig {
  alloha?: { baseUrl?: string };
  turbo?: { baseUrl?: string };
  kodik?: { baseUrl?: string } | null;
  collapsUrl?: string;
  collapsEmbedUrl?: string;
  videoseed?: { baseUrl?: string };
  vibix?: { publisherId?: string; embedId?: string };
}

function abs(origin: string, href?: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') return undefined;
  try {
    return new URL(trimmed, origin).toString();
  } catch {
    return undefined;
  }
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  // ratings are 1..10 — a 0 (or negative) means «no data» on these feeds
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Extract a JSON object starting at `start`, skipping `\"`-escaped chars. */
function extractObject(source: string, start: number): string | null {
  if (start < 0 || source[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** `\"key\":9.1` inside the RSC payload → 9.1. */
function rscNumber(html: string, key: string): number | undefined {
  const m = html.match(new RegExp(`${key}\\\\":\\s*([0-9.]+|null)`));
  if (!m || m[1] === 'null') return undefined;
  return num(m[1]);
}

/** First visible `Страны: …` run in the page (JSON-escaped or plain). */
function countryFromHtml(html: string): string | undefined {
  const m = html.match(
    /Страны?[:：][^A-Za-zА-Яа-я]{0,12}([A-Za-zА-Яа-я][A-Za-zА-Яа-я .,'-]{2,60})/,
  );
  const value = m?.[1].replace(/[.,-]+$/, '').trim();
  return value && value.length > 2 ? value : undefined;
}

export class ReYoHoHoRuParser implements SourceParser {
  readonly id = 'reyoho';
  readonly name = 'ReYoHoHo RU';
  readonly categories = CATEGORIES;

  private baseUrl = DEFAULT_HOST;

  matchesUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'reyoho.ru' || host === 'www.reyoho.ru';
    } catch {
      return false;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const body = await fetchText(url, { referer: `${DEFAULT_HOST}/` });
    if (!body) throw new Error('ReYoHoHo RU не ответил');
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error('ReYoHoHo RU вернул не JSON');
    }
  }

  async getCatalog(page: number, categoryId = 'home', filters?: CatalogFilterState): Promise<PagedResult> {
    const cat = effectiveCategory(categoryId, filters, DISCOVER_TYPES);
    const genre = filters?.genre || '';
    const yearFrom = filters?.yearFrom || '';
    const yearTo = filters?.yearTo || '';
    const rating = filters?.rating || '';
    const hasFilters = !!(genre || yearFrom || yearTo || rating);
    // the trending feed is newest-first — it doubles as «Новинки». Фильтров
    // у него нет, поэтому любой активный фильтр переключает на `discover`.
    if (!hasFilters && (cat === 'home' || cat === 'new')) return this.getTrending(page);

    // Серверная фильтрация: discover понимает `type`, `genres`,
    // `year_from/to` и `rating_kp_from` (рейтинг у нас тоже Кинопоиска).
    // Раньше здесь стояли `genre`/`year`/`rating` — их API молча игнорировал.
    const params = new URLSearchParams({ page: String(page) });
    let type = DISCOVER_TYPES[cat];
    // «Мультфильм»/«Аниме» на Главной — не жанр, а тип; подменяем только
    // когда раздел и так не задан, иначе выбранная категория важнее.
    const genreKind = genre ? GENRE_KINDS[normGenre(genre)] : undefined;
    const appliedKind = !type && genreKind ? genreKind : undefined;
    if (appliedKind) type = appliedKind;
    if (type) params.set('type', type);
    const slug = genre ? resolveGenreSlug(GENRE_SLUGS, genre) : undefined;
    if (slug) params.set('genres', slug);
    if (yearFrom) params.set('year_from', yearFrom);
    if (yearTo) params.set('year_to', yearTo);
    if (rating) params.set('rating_kp_from', rating);
    const data = await this.fetchJson<DiscoverResponse>(
      `${DEFAULT_HOST}/api/search/discover?${params}`,
    );
    const kind = KIND_BY_CATEGORY[cat];
    const parsed = (data.results ?? [])
      .map((r) => this.resultToSummary(r, kind))
      .filter((i): i is MediaSummary => !!i);
    // Сервер уже сузил выдачу под жанр (или тип «мультфильм/аниме») —
    // проставляем его карточкам, чтобы локальная фильтрация не зачистила
    // готовый ответ по отсутствующему или «не тому» полю genres.
    const applied = slug || appliedKind ? stampGenre(parsed, genre) : parsed;
    return { items: applied, page, hasMore: !!data.hasMore };
  }

  /** Newest-first mixed feed, sliced locally (the API ignores `page`). */
  private async getTrending(page: number): Promise<PagedResult> {
    const data = await this.fetchJson<TrendingResponse>(`${DEFAULT_HOST}/api/trending?filter=all`);
    const all = data.items ?? [];
    const ratings = data.ratings ?? {};
    const start = (page - 1) * HOME_PAGE_SIZE;
    const slice = all.slice(start, start + HOME_PAGE_SIZE);
    const items = slice
      .map((item): MediaSummary | null => {
        const id = item.kinopoiskFilmId ?? item.id;
        if (!item.title || !id) return null;
        const key = `${item.mediaType ?? 'movie'}:${item.id}`;
        const rating = ratings[key];
        return {
          url: `${DEFAULT_HOST}/${item.mediaType === 'tv' ? 'series' : 'film'}/${id}`,
          title: item.title,
          poster: abs(DEFAULT_HOST, item.posterUrl),
          year: item.year,
          originalTitle: item.originalTitle || undefined,
          rating: num(rating?.kp),
          ratingKp: num(rating?.kp),
          ratingImdb: num(rating?.imdb),
          kind: item.mediaType === 'tv' ? 'serial' : 'movie',
        };
      })
      .filter((i): i is MediaSummary => !!i);
    return { items, page, hasMore: start + slice.length < all.length };
  }

  async search(query: string): Promise<PagedResult> {
    const q = query.trim();
    if (!q) return { items: [], page: 1, hasMore: false };
    try {
      const data = await this.fetchJson<DiscoverResponse>(
        `${DEFAULT_HOST}/api/search/discover?q=${encodeURIComponent(q)}&page=1`,
      );
      const items = (data.results ?? [])
        .map((r) => this.resultToSummary(r))
        .filter((i): i is MediaSummary => !!i);
      return { items, page: 1, hasMore: false };
    } catch {
      return { items: [], page: 1, hasMore: false };
    }
  }

  private resultToSummary(r: DiscoverResult, kind?: MediaKind): MediaSummary | null {
    if (!r.kinopoiskId || !r.title) return null;
    const mediaKind: MediaKind = kind ?? (r.mediaType === 'tv' ? 'serial' : 'movie');
    return {
      url: `${DEFAULT_HOST}/${r.mediaType === 'tv' ? 'series' : 'film'}/${r.kinopoiskId}`,
      title: r.title,
      poster: abs(DEFAULT_HOST, r.posterUrl),
      year: r.year,
      originalTitle: r.originalTitle || undefined,
      genres: r.genres?.length ? r.genres : undefined,
      rating: num(r.ratings?.kp) ?? num(r.rating),
      ratingKp: num(r.ratings?.kp),
      ratingImdb: num(r.ratings?.imdb),
      kind: mediaKind,
    };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const html = await fetchText(url, { referer: url });
    if (!html || html.length < 3000) throw new Error('Пустая страница ReYoHoHo RU');
    const origin = new URL(url).origin;

    const $doc = cheerio.load(html);
    let ld: Record<string, unknown> | null = null;
    try {
      const raw = $doc('script[type="application/ld+json"]').first().text();
      if (raw) ld = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ld+json is optional — the RSC payload below covers the essentials
    }
    const $c: CheerioAPI = $doc;

    let cfg = this.parsePlayerConfig(html);
    const ratingKp = rscNumber(html, 'ratingKinopoisk');
    const ratingImdb = rscNumber(html, 'ratingImdb');

    const ldType = typeof ld?.['@type'] === 'string' ? (ld['@type'] as string) : '';
    const serialPath = /^\/series\//.test(new URL(url).pathname);
    const kind: MediaKind = ldType === 'TVSeries' || serialPath ? 'serial' : 'movie';

    const genreRaw = ld?.genre;
    const genres = Array.isArray(genreRaw)
      ? genreRaw.filter((g): g is string => typeof g === 'string')
      : typeof genreRaw === 'string' && genreRaw
        ? [genreRaw]
        : undefined;

    const datePublished = typeof ld?.datePublished === 'string' ? ld.datePublished : '';
    const yearMatch = html.match(
      /initialFilmInfo\\":\{\\"details\\":\{\\"type\\":\\"[A-Z]+\\",\\"year\\":(\d{4})/,
    );
    const year = datePublished.slice(0, 4) || yearMatch?.[1] || undefined;

    const agg = (ld?.aggregateRating ?? {}) as Record<string, unknown>;

    // the hero poster: first TMDB-proxy jpg on the page, else the ld+json poster
    const hero = html.match(/\/api\/img\/t\/p\/w(?:500|780)\/[A-Za-z0-9]+\.jpg/);
    const ldImage = typeof ld?.image === 'string' ? ld.image : undefined;
    const poster = hero ? `${origin}${hero[0]}` : abs(origin, ldImage);

    const title =
      (typeof ld?.name === 'string' && ld.name) ||
      $c('h1').first().text().replace(/\s+/g, ' ').trim() ||
      url;
    const originalTitle = typeof ld?.alternateName === 'string' ? ld.alternateName : undefined;

    // SSR иногда отдаёт `initialPlayerConfig: null` («Чернобыль», «Триггер») —
    // тогда сайт сам догружает конфиг через /api/player-config; повторяем его
    // вызов, иначе карточка останется вовсе без плееров.
    let players = this.buildPlayers(cfg);
    if (!players.length) {
      cfg = (await this.fetchPlayerConfig(url)) ?? cfg;
      players = this.buildPlayers(cfg);
    }

    return {
      sourceId: this.id,
      url,
      title,
      poster,
      originalTitle,
      year,
      genres,
      kind,
      rating: ratingKp ?? num(agg.ratingValue),
      ratingKp,
      ratingImdb,
      votes: num(agg.ratingCount),
      country: countryFromHtml(html),
      description:
        (typeof ld?.description === 'string' && ld.description) ||
        $c('meta[property="og:description"]').attr('content') ||
        undefined,
      players,
    };
  }

  async resolveStreams(req: StreamsRequest, referer?: string): Promise<StreamCatalog> {
    const tab = req.tabUrl;
    if (!tab) throw new Error('Не указана ссылка на плеер');

    return resolveEmbed(tab, this.id, req.tabLabel ?? 'ReYoHoHo RU', referer);
  }

  /** `initialPlayerConfig` lives inside the escaped `__next_f` payload. */
  private parsePlayerConfig(html: string): PlayerConfig | null {
    let from = 0;
    for (;;) {
      const keyIdx = html.indexOf('initialPlayerConfig', from);
      if (keyIdx < 0) return null;
      from = keyIdx + 1;
      // `initialPlayerConfig\":null` — конфига в SSR нет, его сайт грузит через API
      const after = html.slice(keyIdx + 20, keyIdx + 48).replace(/^[\\":\s]+/, '');
      if (after.startsWith('null')) continue;
      const brace = html.indexOf('{', keyIdx);
      if (brace < 0) return null;
      const raw = extractObject(html, brace);
      if (!raw) continue;
      try {
        const cfg = JSON.parse(raw.replace(/\\"/g, '"')) as PlayerConfig;
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg;
      } catch {
        // вхождение оказалось JS-кодом, а не конфигом — пробуем следующее
      }
    }
  }

  private buildPlayers(cfg: PlayerConfig | null): PlayerTab[] {
    const players: PlayerTab[] = [];
    if (cfg?.alloha?.baseUrl)
      players.push({ label: 'Alloha', url: cfg.alloha.baseUrl, kind: 'embed' });
    if (cfg?.turbo?.baseUrl)
      players.push({ label: 'Turbo', url: cfg.turbo.baseUrl, kind: 'embed' });
    const collaps = cfg?.collapsEmbedUrl || cfg?.collapsUrl;
    if (collaps) players.push({ label: 'Collaps', url: collaps, kind: 'embed' });
    if (cfg?.kodik?.baseUrl)
      players.push({ label: 'Kodik', url: cfg.kodik.baseUrl, kind: 'embed' });
    return players;
  }

  /**
   * Клиент reyoho при `initialPlayerConfig: null` дёргает /api/player-config —
   * для части тайтлов плееры приходят только оттуда.
   */
  private async fetchPlayerConfig(pageUrl: string): Promise<PlayerConfig | null> {
    try {
      const u = new URL(pageUrl);
      const id = u.pathname.split('/').filter(Boolean).pop() ?? '';
      if (!/^\d+$/.test(id)) return null;
      const mediaType = u.pathname.startsWith('/series') ? 'tv' : 'movie';
      const api =
        `${DEFAULT_HOST}/api/player-config?` +
        `kinopoiskId=${encodeURIComponent(id)}&mediaType=${mediaType}`;
      const body = await fetchText(api, { referer: pageUrl });
      if (!body) return null;
      const cfg = JSON.parse(body) as PlayerConfig;
      return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
    } catch {
      return null;
    }
  }
}
