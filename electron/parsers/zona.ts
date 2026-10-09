import { fetchText } from '../fetcher';
import type {
  Category,
  Episode,
  MediaDetails,
  MediaKind,
  MediaSummary,
  PagedResult,
  Stream,
  StreamCatalog,
  StreamsRequest,
  CatalogFilterState,
} from '../models';
import type { SourceParser } from './base';
import { effectiveCategory, normGenre, resolveGenreSlug, singleYear, stampGenre } from './filtering';
import { enrichSummaries } from './shared';

/**
 * ZONA — зеркало w140.zona.plus (ex zona.mobi): SPA на Backbone/Marionette
 * со собственным JSON API. Сервер отдаёт JSON по тем же путям, что и
 * страницы, как только запрос помечен заголовком
 * `X-Requested-With: XMLHttpRequest` (без него — HTML). Фильтры
 * собираются в путь `/movies/filter/<сегменты>/` (`genre-<слаг>`,
 * `year-<год>`, `rating-<N>`, `sort-…`): порядок сегментов сервер
 * нормализует сам, а вот больше одного жанрового сегмента не работает —
 * такой запрос вешает соединение, поэтому при типе «Мультфильм»/«Аниме»
 * жанровый сегмент один (тип важнее жанра).
 *
 * Видео: у карточки есть `mobi_link_id`, а `/ajax/video/<id>` возвращает
 * прямой mp4 (`url`); HLS-адреса в ответе источника стабильно отдают 404,
 * поэтому в каталог потоков идёт только mp4.
 */
const SITE = 'https://w140.zona.plus';

/** Сигнатура «XHR»: без неё сервер отдаёт HTML-страницу вместо JSON. */
const XHR_HEADERS: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };

const CATEGORIES: Category[] = [
  { id: 'home', title: 'Главная' },
  { id: 'new', title: 'Новинки' },
  { id: 'films', title: 'Фильмы' },
  { id: 'serials', title: 'Сериалы' },
];

/** Разделы, которые у ZONA реально есть. */
const ZONA_SECTIONS: Record<string, string> = {
  home: 'home',
  new: 'new',
  films: 'films',
  serials: 'serials',
};

/**
 * «Мультфильм»/«Аниме» — не разделы, а жанры источника (`genre-multfilm`,
 * `genre-anime`): тип применяется жанровым сегментом, а карточкам после
 * гидратации проставляется соответствующий kind.
 */
const KIND_GENRES: Record<string, string> = { cartoon: 'multfilm', anime: 'anime' };
const KIND_LABELS: Record<string, string> = { cartoon: 'мультфильм', anime: 'аниме' };

/** Жанры формы фильтров источника: подпись UI → значение сегмента пути. */
const GENRE_SLUGS = new Map<string, string>(
  Object.entries({
    Ужасы: 'uzhasy',
    Комедия: 'komediia',
    Боевик: 'boevik',
    Драма: 'drama',
    Триллер: 'triller',
    Мелодрама: 'melodrama',
    Криминал: 'kriminal',
    Приключения: 'prikliucheniia',
    Детектив: 'detektiv',
    Фантастика: 'fantastika',
    Семейный: 'semeinyi',
    'Фэнтези': 'fentezi',
    Мультфильм: 'multfilm',
    Аниме: 'anime',
    Военный: 'voennyi',
    'Исторический': 'istoriia',
    'История': 'istoriia',
    'Биографический': 'biografiia',
    'Биография': 'biografiia',
    Мюзикл: 'miuzikl',
    Вестерн: 'vestern',
    'Спортивный': 'sport',
    Спорт: 'sport',
    Детский: 'detskii',
    'Документальный': 'dokumentalnyi',
    Короткометражка: 'korotkometrazhka',
    'Фильм-нуар': 'film-nuar',
  }).map(([label, slug]) => [normGenre(label), slug]),
);

/** Всего серий, которые готовим в потоки: у сериалов на тысячи серий
 * запросы к /ajax/video заняли бы минуты, дальше — встроенный плеер сайта. */
const MAX_EPISODES = 150;

interface ZonaItem {
  name_rus?: string;
  name_id?: string;
  name_original?: string;
  cover?: string;
  year?: number | string;
  serial?: boolean;
  rating?: number;
  rating_kinopoisk?: number;
  rating_imdb?: number;
  rating_kinopoisk_count?: number;
}

interface ZonaPagination {
  current_page?: number;
  total_pages?: number;
  total_items?: number;
  next_url?: string | null;
}

interface ZonaListResponse {
  items?: ZonaItem[];
  pagination?: ZonaPagination;
}

interface ZonaRecord {
  name_rus?: string;
  name_id?: string;
  name_original?: string;
  image?: string;
  year?: number;
  rating?: number;
  rating_kinopoisk?: number;
  rating_imdb?: number;
  description?: string;
  country?: string;
  serial?: boolean;
  mobi_link_id?: number;
  abuse?: string;
}

interface ZonaEpisode {
  title?: string;
  episode_key?: string;
  mobi_link_id?: number;
  season?: number;
  episode?: number;
}

interface ZonaDetails {
  movie?: ZonaRecord;
  serial?: ZonaRecord;
  persons?: unknown;
  genres?: unknown;
  countries?: unknown;
  episodes?: { items?: Record<string, ZonaEpisode | undefined> };
  seasons?: { count?: number; current?: number };
}

interface VideoResponse {
  url?: string;
  error?: string;
}

/** Что фильтры переводят на язык путей источника. */
interface FilterPlan {
  segments: string[];
  /** Жанр, которым сервер уже отфильтровал выдачу — его штампует stampGenre. */
  stamp: string;
  kindOverride?: MediaKind;
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Название: у зоны поле может прийти числом (сериал «1923») — такое значение
 * роняло нормализацию заголовка на стороне UI и вместе с ней всю публикацию
 * каталога. Числовое название — валидный текст, приводим его к строке.
 */
function titleStr(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Имена из массива `{name}`/строк — жанры, страны, персоны. */
function namesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === 'string' ? entry : str((entry as { name?: unknown } | null)?.name),
      )
      .filter((name): name is string => !!name);
  }
  const one = str(value);
  return one ? [one] : [];
}

/** Пул запросов: не больше `limit` одновременно, порядок результатов сохраняется. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) break;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class ZonaParser implements SourceParser {
  readonly id = 'zona';
  readonly name = 'ZONA';
  readonly categories = CATEGORIES;

  matchesUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return (
        host === 'zona.plus' ||
        host.endsWith('.zona.plus') ||
        host === 'zona.im' ||
        host.endsWith('.zona.im') ||
        host === 'zona.ms' ||
        host.endsWith('.zona.ms')
      );
    } catch {
      return false;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const body = await fetchText(url, {
      headers: XHR_HEADERS,
      // браузерный фолбэк не умеет ставить заголовки — только прямой запрос
      noBrowser: true,
      validate: (text) => text.trimStart().startsWith('{'),
    });
    if (!body) throw new Error('ZONA не ответил');
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error('ZONA вернул не JSON');
    }
  }

  /** `/tvseries/<slug>/season-2` → `{section:'tvseries', slug}` (сезон отбрасывается). */
  private pageKey(url: string): { section: 'movies' | 'tvseries'; slug: string } | null {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const section = parts[0] === 'tvseries' ? 'tvseries' : 'movies';
      const slug = parts[1] ?? '';
      return slug ? { section, slug } : null;
    } catch {
      return null;
    }
  }

  /** Базовая страница карточки на актуальном зеркале (без query и сезона). */
  private canonicalUrl(url: string): string {
    const key = this.pageKey(url);
    return key ? `${SITE}/${key.section}/${key.slug}` : url;
  }

  /**
   * Перевод фильтров в сегменты пути `/filter/…`. Источник принимает
   * только один жанровый сегмент, поэтому тип «Мультфильм»/«Аниме»
   * важнее выбранного жанра: сервер режет по типу, а запрошенный жанр
   * добивает stampGenre (иначе локальная фильтрация зачистила бы ответ).
   */
  private planFilters(filters?: CatalogFilterState): FilterPlan {
    const segments: string[] = [];
    const kind = filters?.kind ?? '';
    const genre = filters?.genre ?? '';
    const kindGenre = KIND_GENRES[kind];
    let stamp = '';
    let kindOverride: MediaKind | undefined;

    if (kindGenre) {
      segments.push(`genre-${kindGenre}`);
      kindOverride = kind as MediaKind;
      stamp = genre || KIND_LABELS[kind];
    } else if (genre) {
      const slug = resolveGenreSlug(GENRE_SLUGS, genre);
      if (slug) segments.push(`genre-${slug}`);
      stamp = genre;
    }

    const year = singleYear(filters);
    if (year) segments.push(`year-${year}`);

    const rating = Math.floor(Number(filters?.rating));
    if (rating >= 1 && rating <= 9) segments.push(`rating-${rating}`);

    return { segments, stamp, kindOverride };
  }

  async getCatalog(
    page: number,
    categoryId = 'home',
    filters?: CatalogFilterState,
  ): Promise<PagedResult> {
    try {
      const cat = effectiveCategory(categoryId, filters, ZONA_SECTIONS);
      const plan = this.planFilters(filters);
      // Форма источника сортирует по популярности; «Новинки» требуют дату.
      if (cat === 'new') plan.segments.push('sort-date');
      if (cat === 'films') return await this.list('/movies', page, plan);
      if (cat === 'serials') return await this.list('/tvseries', page, plan);
      if (cat === 'home' || cat === 'new') return await this.getHome(page, plan);
      return { items: [], page, hasMore: false };
    } catch {
      // неверная комбинация сегментов отдаёт 404 — для каталога это «пусто»
      return { items: [], page, hasMore: false };
    }
  }

  private async list(path: string, page: number, plan: FilterPlan): Promise<PagedResult> {
    const suffix = plan.segments.length ? `/filter/${plan.segments.join('/')}` : '';
    const data = await this.fetchJson<ZonaListResponse>(`${SITE}${path}${suffix}?page=${page}`);
    const baseKind: MediaKind = path === '/tvseries' ? 'serial' : 'movie';
    let items = (data.items ?? [])
      .map((item) => this.toSummary(item, baseKind))
      .filter((item): item is MediaSummary => !!item);
    // карточки списков не несут жанров и рейтинга IMDb — гидратируем голову
    items = await enrichSummaries(items, 12, (url) => this.getDetails(url));
    if (plan.kindOverride) items = items.map((item) => ({ ...item, kind: plan.kindOverride }));
    if (plan.stamp) items = stampGenre(items, plan.stamp);
    const current = data.pagination?.current_page ?? 0;
    const total = data.pagination?.total_pages ?? 0;
    const hasMore = current > 0 && current < total;
    return { items, page, hasMore };
  }

  /** Страница 1 переплетает фильмы и сериалы; дальше лента фильмов. */
  private async getHome(page: number, plan: FilterPlan): Promise<PagedResult> {
    if (page > 1) return this.list('/movies', page, plan);
    const [movies, series] = await Promise.all([
      this.list('/movies', 1, plan),
      this.list('/tvseries', 1, plan),
    ]);
    const fromMovies = movies.items.slice(0, 30);
    const fromSeries = series.items.slice(0, 30);
    const items: MediaSummary[] = [];
    for (let i = 0; i < Math.max(fromMovies.length, fromSeries.length); i++) {
      if (fromMovies[i]) items.push(fromMovies[i]);
      if (fromSeries[i]) items.push(fromSeries[i]);
    }
    return { items, page, hasMore: movies.hasMore };
  }

  async search(query: string): Promise<PagedResult> {
    const q = query.trim();
    if (!q) return { items: [], page: 1, hasMore: false };
    try {
      const data = await this.fetchJson<ZonaListResponse>(
        `${SITE}/search-form?query=${encodeURIComponent(q)}`,
      );
      const items = (data.items ?? [])
        .slice(0, 30)
        .map((item) => this.toSummary(item, item.serial ? 'serial' : 'movie'))
        .filter((item): item is MediaSummary => !!item);
      return {
        items: await enrichSummaries(items, 12, (url) => this.getDetails(url)),
        page: 1,
        hasMore: false,
      };
    } catch {
      return { items: [], page: 1, hasMore: false };
    }
  }

  private toSummary(item: ZonaItem, kind: MediaKind): MediaSummary | null {
    const title = titleStr(item.name_rus);
    if (!item.name_id || !title) return null;
    const path = item.serial ? 'tvseries' : 'movies';
    return {
      url: `${SITE}/${path}/${item.name_id}`,
      title,
      poster: str(item.cover),
      year: item.year != null && item.year !== '' ? String(item.year) : undefined,
      originalTitle: str(item.name_original),
      rating: num(item.rating),
      ratingKp: num(item.rating_kinopoisk),
      ratingImdb: num(item.rating_imdb),
      votes: num(item.rating_kinopoisk_count),
      kind,
    };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const key = this.pageKey(url);
    if (!key) throw new Error('ZONA не нашёл материал');
    const canonical = `${SITE}/${key.section}/${key.slug}`;
    const data = await this.fetchJson<ZonaDetails>(canonical);
    const record = data.serial ?? data.movie;
    const title = titleStr(record?.name_rus);
    if (!record || !title) throw new Error('ZONA не нашёл материал');

    const persons = data.persons && !Array.isArray(data.persons) ? data.persons : undefined;
    const directors = namesOf((persons as Record<string, unknown> | undefined)?.director);
    const actors = namesOf((persons as Record<string, unknown> | undefined)?.actors);
    const genres = namesOf(data.genres);
    const countries = namesOf(data.countries);
    const isSeries = key.section === 'tvseries';

    return {
      sourceId: this.id,
      url: canonical,
      title,
      poster: str(record.image),
      year: record.year != null ? String(record.year) : undefined,
      originalTitle: str(record.name_original),
      genres: genres.length ? genres : undefined,
      kind: isSeries ? 'serial' : 'movie',
      rating: num(record.rating),
      ratingKp: num(record.rating_kinopoisk),
      ratingImdb: num(record.rating_imdb),
      director: directors.length ? directors.join(', ') : undefined,
      cast: actors.length ? actors.slice(0, 10).join(', ') : undefined,
      seasonsCount:
        isSeries && data.seasons?.count ? String(data.seasons.count) : undefined,
      description: str(record.description),
      country: countries.length ? countries.join(', ') : str(record.country),
      // pлеер открывается как страница карточки: resolveStreams достаёт из
      // неё же прямые ссылки, а при сбое страница остаётся встроенным фолбэком
      players: [{ label: 'ZONA', url: canonical, kind: 'embed' }],
    };
  }

  /** `/ajax/video/<mobi_link_id>` → прямой mp4 (HLS у источника не работает). */
  private async videoStream(id: number): Promise<Stream | null> {
    try {
      const data = await this.fetchJson<VideoResponse>(
        `${SITE}/ajax/video/${id}?client_time=${Date.now()}`,
      );
      const raw = str(data.url);
      const url = raw ? (raw.startsWith('//') ? `https:${raw}` : raw) : undefined;
      if (url) return { type: 'mp4', url, label: 'MP4' };
    } catch {
      // ролик не готов или снят с публикации — эпизод без потока пропускаем
    }
    return null;
  }

  async resolveStreams(req: StreamsRequest): Promise<StreamCatalog> {
    const tab = req.tabUrl;
    if (!tab) throw new Error('Не указана ссылка на плеер');
    const canonical = this.canonicalUrl(tab);
    const base: StreamCatalog = {
      sourceId: this.id,
      tabLabel: req.tabLabel ?? 'ZONA',
      episodes: [],
      fallbackEmbedUrl: canonical,
    };

    let data: ZonaDetails;
    try {
      data = await this.fetchJson<ZonaDetails>(canonical);
    } catch {
      return base; // встроенный плеер сайта откроется как фолбэк
    }

    const record = data.serial ?? data.movie;
    if (!record) return base;

    if (!canonical.includes('/tvseries/')) {
      const id = Number(record.mobi_link_id);
      const stream = id ? await this.videoStream(id) : null;
      if (stream) {
        base.episodes = [
          { season: 1, episode: '1', label: 'Видео', streams: [stream], subtitles: [] },
        ];
      }
      return base;
    }

    // Сериал: страница отдаёт серии текущего сезона, остальные — по
    // `/tvseries/<slug>/season-N`; у каждой серии свой mobi_link_id.
    const count = Math.max(1, Number(data.seasons?.count) || 1);
    const seasonNums = Array.from({ length: count - 1 }, (_, i) => i + 2);
    const rest = await mapPool(seasonNums, 4, async (n) => {
      try {
        return await this.fetchJson<ZonaDetails>(`${canonical}/season-${n}`);
      } catch {
        return null;
      }
    });

    interface Ref {
      season: number;
      episode: string;
      title: string;
      id: number;
    }
    const refs: Ref[] = [];
    for (const doc of [data, ...rest]) {
      if (!doc) continue;
      for (const episode of Object.values(doc.episodes?.items ?? {})) {
        if (!episode) continue;
        const id = Number(episode.mobi_link_id);
        if (!id) continue;
        refs.push({
          season: Number(episode.season) || 1,
          episode: String(episode.episode ?? '') || '1',
          title: str(episode.title) ?? str(episode.episode_key) ?? '',
          id,
        });
        if (refs.length >= MAX_EPISODES) break;
      }
      if (refs.length >= MAX_EPISODES) break;
    }
    refs.sort((a, b) => a.season - b.season || Number(a.episode) - Number(b.episode));

    const streams = await mapPool(refs, 6, (ref) => this.videoStream(ref.id));
    const episodes: Episode[] = [];
    refs.forEach((ref, index) => {
      const stream = streams[index];
      if (!stream) return;
      episodes.push({
        season: ref.season,
        episode: ref.episode,
        label: ref.title || `Серия ${ref.episode}`,
        streams: [stream],
        subtitles: [],
      });
    });
    base.episodes = episodes;
    return base;
  }
}
