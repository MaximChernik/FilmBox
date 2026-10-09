import { fetchText } from '../fetcher';
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
import { kindCategory, stampGenre } from './filtering';
import { bestQualityFromText, maxYear, normalizeSiteDate } from './shared';

const API = 'https://rutube.ru/api';
const FEED_URL = `${API}/feeds/movies-serials/?format=json`;
const HOME_SHELVES = 6;
const PAGE_SIZE = 40;
/**
 * Every page must merge the SAME shelf layout — a per-page limit shifts the
 * boundaries and cards slide between pages (duplicates on one side, gaps on
 * the other). A fixed depth plus fetcher's url cache keeps pages disjoint.
 * 100 is the highest limit the recommendation shelves accept (120 → 400).
 */
const SHELF_LIMIT = 100;

/**
 * У RuTube в приложении одна вкладка — «Фильмы»: парсинг сериалов (сезонные
 * витрины, списки серий, счётчики) убран по требованию, каталог и поиск
 * источника отдают только фильмы.
 */
const CATEGORIES: Category[] = [{ id: 'films', title: 'Фильмы' }];

/** Вкладка «Фильмы» витрины «Кино и сериалы» (feeds/movies-serials). */
const FILMS_TAB = 'Фильмы';

/**
 * Editorial tag «Новые фильмы и сериалы» — лента по дате разметки; в
 * «Новинках» остаются только фильмы (серии/сериалы отфильтровываются).
 */
const NEW_TAG_ID = 8151;

interface RtCategory {
  id?: number;
  name?: string;
}

interface RtItem {
  id?: string;
  title?: string;
  description?: string;
  thumbnail_url?: string;
  rutube_poster?: string;
  video_url?: string;
  embed_url?: string;
  category?: RtCategory;
  is_adult?: boolean;
  is_serial?: boolean;
  season?: number | null;
  hits?: number;
  duration?: number;
  /** подписочные ролики: непустой список кодов продукта = «только по подписке» */
  is_paid?: boolean;
  product_id?: number | string | null;
  common_subscription_product_codes?: string[] | null;
  created_ts?: string | number;
  publication_ts?: string | number;
  last_update_ts?: string | number;
}

interface PlayOptions {
  video_balancer?: { default?: string; m3u8?: string };
}

interface RtPage {
  results?: RtItem[];
  has_next?: boolean;
  num_pages?: number;
  page?: number;
}

interface FeedResource {
  url?: string;
  content_type?: { model?: string };
}

interface FeedTab {
  name?: string;
  resources?: FeedResource[];
}

interface Feed {
  tabs?: FeedTab[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url, { noBrowser: true, timeoutMs: 15000 });
  if (!text) throw new Error('Источник RUTUBE не ответил');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Источник RUTUBE вернул неверный ответ');
  }
}

function splitYear(raw: string): { title: string; year?: string } {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const exact = cleaned.match(/\((\b(?:19|20)\d{2}\b)\)/);
  if (exact) {
    const trimmed = cleaned.replace(/\s*\([^()]*\b(?:19|20)\d{2}\b[^()]*\)\s*$/, '').trim();
    return { title: trimmed || cleaned, year: exact[1] };
  }
  // «(сериал, 2009-2010)» — a parenthetical carrying a range, not a lone year
  const trailing = cleaned.match(/\s*\(([^()]*(?:19|20)\d{2}[^()]*)\)\s*$/);
  if (trailing) {
    const year = maxYear(trailing[1]);
    if (year) {
      const title = cleaned.slice(0, trailing.index).trim();
      return { title: title || cleaned, year };
    }
  }
  // «Гипотеза любви (фильм, 2026) / The Love Hypothesis» — the year sits in a
  // mid-title parenthetical: take it, but leave the title untouched
  const inline = cleaned.match(/\(([^()]*(?:19|20)\d{2}[^()]*)\)/);
  if (inline) {
    const year = maxYear(inline[1]);
    if (year) return { title: cleaned, year };
  }
  return { title: cleaned, year: undefined };
}

/** Publication date of the item on rutube: when it appeared in listings. */
function siteDateOf(item: RtItem): string | undefined {
  return normalizeSiteDate(item.publication_ts || item.created_ts);
}

function kindOf(item: RtItem): MediaKind {
  const category = item.category?.name ?? '';
  if (/сериал/i.test(category)) return 'serial';
  if (/мульт/i.test(category)) return 'cartoon';
  if (/аниме/i.test(category)) return 'anime';
  if (/фильм/i.test(category)) return 'movie';
  if (item.is_serial || item.season) return 'serial';
  const title = item.title ?? '';
  if (/аниме|\banime\b/i.test(title)) return 'anime';
  if (/мульт/i.test(title)) return 'cartoon';
  if (/сериал/i.test(title)) return 'serial';
  return 'unknown';
}

function toSummary(item: RtItem, fallback?: MediaKind): MediaSummary | null {
  if (!item?.video_url || item.is_adult) return null;
  const { title, year } = splitYear(item.title ?? '');
  if (!title) return null;
  const kind = kindOf(item);
  return {
    url: item.video_url,
    title,
    poster: item.rutube_poster || item.thumbnail_url || undefined,
    year,
    siteDate: siteDateOf(item),
    kind: kind !== 'unknown' ? kind : (fallback ?? kind),
    quality: bestQualityFromText(item.title),
  };
}

/**
 * Карточка-фильм: RuTube больше не парсит сериалы — в выдачу идут только
 * фильмовые категории («Фильмы», «Мультфильмы», «Аниме», «Кино»…), без
 * сезонных карточек и эпизодов. Поиск иначе возвращает эзотерику/музыку
 * с совпавшими словами.
 */
function toFilmSummary(item: RtItem): MediaSummary | null {
  const category = item.category?.name ?? '';
  if (!/фильм|аниме|кино|короткометраж/i.test(category)) return null;
  if (item.is_serial || item.season) return null;
  const title = item.title ?? '';
  if (/сериал/i.test(title)) return null;
  // эпизод в фильмовой категории: «1 сезон 1 серия», «сезон 2», «3 выпуска»
  if (
    /\d{1,3}\s*(?:сезон|сери[яйюеи]|выпуск(?:а|ов|и)?)/i.test(title) ||
    /сезон\s*\d{1,3}/i.test(title)
  ) {
    return null;
  }
  const summary = toSummary(item, 'movie');
  return summary && summary.kind !== 'serial' ? summary : null;
}

/** Video shelves only: tags/recommendation/metainfo/person — not card groups. */
function isVideoShelf(url: string): boolean {
  return url.includes('/api/') && !url.includes('/api/feeds/');
}

/** Видео-полки витрины: без tv-списков серий и подборок-шоу, глубина ограничена. */
function shelvesFrom(resources: FeedResource[] | undefined): string[] {
  const seenPaths = new Set<string>();
  const shelves: string[] = [];
  for (const resource of resources ?? []) {
    const url = resource.url;
    if (!url) continue;
    // 'tv' resources list one show's episodes — not a category shelf;
    // cardgroups (подборки tv-шоу) отсекает сам isVideoShelf
    if (!isVideoShelf(url) || resource.content_type?.model === 'tv') continue;
    const path = new URL(url).pathname;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    shelves.push(url);
    if (shelves.length >= HOME_SHELVES) break;
  }
  return shelves;
}

function extractId(url: string): string | undefined {
  return (
    url.match(/\/video\/([0-9a-f]{32})(?:\/|$)/i)?.[1] ??
    url.match(/\/play\/embed\/([0-9a-f]{32})/i)?.[1]
  );
}

/**
 * Ролик доступен только по подписке/платно — его не берём в список и не
 * парсим (поиск/мета не отдают плеер без подписки, play/options — заглушку).
 */
function subscriptionOnly(item: RtItem): boolean {
  return !!item.is_paid || !!item.product_id || !!item.common_subscription_product_codes?.length;
}

/** Номер серии/выпуска: «1» или диапазон «1-2». */
const EP_NUM = '\\d{1,3}(?:\\s*[-–—]\\s*\\d{1,3})?';
/** Слово эпизода: «серия/серии/серию/серий…» и «выпуск/выпуска/выпусков». */
const EP_WORD = '(?:сери[яйюеи]|выпуск(?:а|ов|и)?)';

/**
 * «Высокогорье - 1 сезон, 1 серия / Хребет Виктории» → «Высокогорье / Хребет
 * Виктории»: на слитой карточке остаётся название без указания серии. Помимо
 * «серия» режется «выпуск» (ток-шоу) и диапазоны («1-2 серии»).
 */
function stripEpisodePart(raw: string): string {
  // NB: \b после кириллицы в JS не работает (кириллица не входит в \w) —
  // границы слов в этих правилах не используются.
  return (
    raw
      // «- 1 сезон, 1 серия «Название эпизода»» — с именем эпизода
      .replace(
        new RegExp(
          `\\s*[-–—|:.]?\\s*\\d{1,3}\\s*сезон\\s*[,/]?\\s*${EP_NUM}\\s*${EP_WORD}\\s*«[^»]*»`,
          'gi',
        ),
        '',
      )
      // «1 серия «Название эпизода»»
      .replace(new RegExp(`\\s*[-–—|:.]?\\s*${EP_NUM}\\s*${EP_WORD}\\s*«[^»]*»`, 'gi'), '')
      // «- 1 сезон, 1 серия» / «1 сезон 2 серия» / «24 сезон, 3 выпуск»
      .replace(
        new RegExp(`\\s*[-–—|:.]?\\s*\\d{1,3}\\s*сезон\\s*[,/]?\\s*${EP_NUM}\\s*${EP_WORD}`, 'gi'),
        '',
      )
      // «Кости - сезон 1 серия 1» — номер после «сезон»
      .replace(
        new RegExp(
          `\\s*[-–—|:.]?\\s*сезон\\s*[,/]?\\s*${EP_NUM}\\s*${EP_WORD}\\s*(?:[,/]?\\s*\\d{1,3})?`,
          'gi',
        ),
        '',
      )
      // ведущая «1 серия | Название» / «1 серия Название»
      .replace(new RegExp(`^\\s*${EP_NUM}\\s*${EP_WORD}\\s*(?:[|–—-]+\\s*|\\s+)`), '')
      // «Название - 3 серия» / «Название: 3 серия» / «Название - 3 выпуск»
      .replace(new RegExp(`\\s*[-–—|:]\\s*${EP_NUM}\\s*${EP_WORD}`, 'gi'), '')
      // рекламный хвост «… 1 серия смотреть бесплатно» — мешал хвостовому правилу
      .replace(/\s+(?:смотреть(?:\s+(?:онлайн|бесплатно))*|онлайн|бесплатно)\s*$/i, '')
      // хвостовые «Название 3 серия», «Название - 2 сезон», «Название - сезон 2»
      .replace(new RegExp(`\\s+${EP_NUM}\\s*${EP_WORD}\\s*$`, 'i'), '')
      .replace(/\s*[-–—|:]?\s*\d{1,3}\s*сезон\s*$/i, '')
      .replace(/\s*[-–—|:]\s*сезон\s*\d{1,3}\s*$/i, '')
      // хвостовая пунктуация срезанного «…, 3 выпуск» — «Экстрасенсы,»
      .replace(/[\s,;:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** Названия карточек без серийных хвостов («3 серия») и рекламы («смотреть онлайн»). */
function stripTitles(items: MediaSummary[]): MediaSummary[] {
  for (const item of items) item.title = stripEpisodePart(item.title) || item.title;
  return items;
}

export class RutubeParser implements SourceParser {
  readonly id = 'rutube';
  readonly name = 'RUTUBE';
  readonly categories = CATEGORIES;

  matchesUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'rutube.ru' || host.endsWith('.rutube.ru') || host === 'rt.be';
    } catch {
      return false;
    }
  }

  /**
   * Главная/Новинки/Фильмы отдаются только фильмами (сериалы в RuTube не
   * парсим); прочие категории (Сериалы/Мультфильмы/Аниме) отвечают пусто.
   */
  async getCatalog(page: number, categoryId = 'films', filters?: CatalogFilterState): Promise<PagedResult> {
    // У RuTube размечены только фильмы (сериалы и эпизоды отсекаются при
    // парсинге), поэтому остальные типы просить бессмысленно — такие фильтры
    // отсекаем сразу, не тратя запрос.
    const kind = kindCategory(filters?.kind);
    if (kind && kind !== 'films') return { items: [], page, hasMore: false };
    if (categoryId !== 'home' && categoryId !== 'new' && categoryId !== 'films') {
      return { items: [], page, hasMore: false };
    }
    // Серверный жанр = поиск по слову; раньше ветка жанра жила только в
    // «Фильмах», и с Главной/Новинок фильтр молча отдавал нефильтрованную
    // витрину, которую локальный слой зачищал впустую.
    if (filters?.genre) return this.searchByGenre(filters.genre, page);
    if (categoryId === 'home') return this.getHomeCatalog(page);
    if (categoryId === 'new') return this.getNewCatalog(page);
    return this.getTabCatalog(page);
  }

  /**
   * «Главная»: горячие полки витрины (таб «Главная»), отфильтрованные до
   * фильмов — сводная главная других источников остаётся без сериалов RuTube.
   */
  private async getHomeCatalog(page: number): Promise<PagedResult> {
    const feed = await fetchJson<Feed>(FEED_URL);
    const tab = feed.tabs?.find((t) => t.name === 'Главная') ?? feed.tabs?.[0];
    const shelves = shelvesFrom(tab?.resources);
    if (!shelves.length) throw new Error('Источник RUTUBE: пустая витрина');
    return this.mergeShelves(page, shelves);
  }

  /**
   * «Новинки»: тег-лента «Новые фильмы и сериалы» с нативной пагинацией
   * (sort=tagged_d); серии и сериалы из ленты уходят — остаются фильмы.
   */
  private async getNewCatalog(page: number): Promise<PagedResult> {
    try {
      const url = new URL(`${API}/tags/video/${NEW_TAG_ID}/`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('page', String(page));
      url.searchParams.set('sort', 'tagged_d');
      url.searchParams.set('show_hidden_videos', 'False');
      const data = await fetchJson<RtPage>(url.toString());
      const items = stripTitles(
        (data.results ?? []).map(toFilmSummary).filter((x): x is MediaSummary => !!x),
      );
      return { items, page, hasMore: !!data.has_next && items.length > 0 };
    } catch {
      return { items: [], page, hasMore: false };
    }
  }

  /**
   * Витрина «Кино и сериалы», вкладка «Фильмы»: только видео-полки (подборки
   * tv-показаний и серии — мимо). Карточки режутся на фильмы через
   * toFilmSummary: сезонные карточки и эпизоды в выдачу не попадают.
   */
  private async getTabCatalog(page: number): Promise<PagedResult> {
    const feed = await fetchJson<Feed>(FEED_URL);
    const tab = feed.tabs?.find((t) => t.name === FILMS_TAB);
    const shelves = shelvesFrom(tab?.resources);
    if (!shelves.length) throw new Error('Источник RUTUBE: пустая витрина');
    return this.mergeShelves(page, shelves);
  }

  /**
   * Поиск по жанру через API RuTube. Штамп обязателен: у карточек RuTube
   * поле `genres` пустое и локальная фильтрация зачистила бы результат.
   */
  private async searchByGenre(genre: string, page: number): Promise<PagedResult> {
    const url = new URL(`${API}/search/video/`);
    url.searchParams.set('query', genre);
    url.searchParams.set('page', String(page));
    url.searchParams.set('format', 'json');
    try {
      const data = await fetchJson<RtPage>(url.toString());
      const items = stampGenre(
        stripTitles(
          (data.results ?? []).map(toFilmSummary).filter((x): x is MediaSummary => !!x),
        ),
        genre,
      );
      return { items, page, hasMore: !!data.has_next && items.length > 0 };
    } catch {
      return { items: [], page, hasMore: false };
    }
  }

  /** Общее слияние полок: только фильмы, дедуп по url, срез страницы. */
  private async mergeShelves(page: number, shelves: string[]): Promise<PagedResult> {
    const need = page * PAGE_SIZE;
    const lists = await Promise.all(shelves.map((u) => this.fetchShelf(u, SHELF_LIMIT)));

    const seen = new Set<string>();
    const merged: MediaSummary[] = [];
    for (const list of lists) {
      for (const item of list) {
        const summary = toFilmSummary(item);
        if (!summary || seen.has(summary.url)) continue;
        seen.add(summary.url);
        merged.push(summary);
      }
    }

    const from = Math.max(0, need - PAGE_SIZE);
    const items = stripTitles(merged.slice(from, need));
    return {
      items,
      page,
      hasMore: merged.length > need,
    };
  }

  private async fetchShelf(url: string, limit: number): Promise<RtItem[]> {
    // shelves reject limits above their cap (400) — halve until one fits;
    // the chosen url is deterministic, so page slicing stays stable
    for (;;) {
      try {
        const target = new URL(url);
        target.searchParams.set('limit', String(limit));
        const data = await fetchJson<RtPage>(target.toString());
        return data.results ?? [];
      } catch (err) {
        if (limit <= 40) throw err;
        limit = Math.max(40, Math.floor(limit / 2));
      }
    }
  }

  /** Поиск по видео: сериалы и эпизоды из выдачи не идут — только фильмы. */
  async search(query: string): Promise<PagedResult> {
    const q = query.trim();
    if (!q) return { items: [], page: 1, hasMore: false };
    const data = await fetchJson<RtPage>(
      `${API}/search/video/?format=json&query=${encodeURIComponent(q)}&page=1`,
    );
    const items = stripTitles(
      (data.results ?? []).map(toFilmSummary).filter((x): x is MediaSummary => !!x),
    );
    return { items, page: 1, hasMore: !!data.has_next && items.length > 0 };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const id = extractId(url);
    if (!id) throw new Error('Источник RUTUBE: не найден id видео');
    const item = await fetchJson<RtItem>(`${API}/video/${id}/?format=json`);
    const { title, year } = splitYear(item.title ?? '');
    // чистое название — без серийных хвостов и рекламы
    const cleanTitle = stripEpisodePart(title || item.title || '');
    const poster = item.rutube_poster || item.thumbnail_url;
    const description = item.description?.trim() || undefined;
    const yearFromDescription = maxYear(
      description?.match(/год выпуска:?\s*((?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?)/i)?.[1],
    );

    const players: PlayerTab[] = [
      {
        label: 'Плеер',
        url: item.embed_url || `https://rutube.ru/play/embed/${id}`,
        kind: 'embed',
      },
    ];

    return {
      sourceId: this.id,
      url: item.video_url || url,
      title: cleanTitle || title || item.title || '',
      poster,
      year: year ?? yearFromDescription,
      siteDate: siteDateOf(item),
      description,
      genres: [],
      kind: kindOf(item),
      players,
      quality: bestQualityFromText(`${item.title ?? ''}\n${description ?? ''}`),
    };
  }

  /**
   * RUTUBE отдаёт реальный HLS через /api/play/options/. Списков серий больше
   * нет (только фильмы): видео всегда одно; подписочные заглушки без HLS не
   * трогаем — сразу уходит фолбэк-стейдж.
   */
  async resolveStreams(req: StreamsRequest): Promise<StreamCatalog> {
    const tab = req.tabUrl ?? '';
    const id = extractId(tab);
    const embed = id ? `https://rutube.ru/play/embed/${id}` : tab;
    const base: StreamCatalog = {
      sourceId: this.id,
      tabLabel: req.tabLabel ?? 'Плеер',
      episodes: [],
      fallbackEmbedUrl: embed,
    };
    if (!id) return base;

    let meta: RtItem;
    try {
      meta = await fetchJson<RtItem>(`${API}/video/${id}/?format=json`);
    } catch {
      return base;
    }

    // ролик по подписке — HLS всё равно не отдаст, запрос не тратим
    if (subscriptionOnly(meta)) return base;
    const hls = await this.hlsUrl(id);
    if (!hls) return base;
    const episodes: Episode[] = [
      {
        season: 1,
        episode: '1',
        label: 'Видео',
        duration: meta.duration,
        streams: [{ type: 'hls', url: hls, label: 'HLS' }],
        subtitles: [],
      },
    ];
    return { ...base, episodes };
  }

  /**
   * Signed HLS master playlist for one video (player options API).
   * The raichu-embed query params are required: without them the endpoints
   * answer 404, and paid videos come back as a subscription stub (no
   * `video_balancer`) — those fall back to the iframe embed.
   */
  private async hlsUrl(id: string): Promise<string | undefined> {
    try {
      const options = await fetchJson<PlayOptions>(
        `${API}/play/options/${id}/?format=json&no_404=true&client=wdp&pver=v2` +
          `&platform=web&mq=all&referer=${encodeURIComponent('https://rutube.ru/')}`,
      );
      return options.video_balancer?.default ?? options.video_balancer?.m3u8;
    } catch {
      return undefined;
    }
  }
}
