import type { CatalogFilterState, MediaSummary } from '../models';

/**
 * Серверная фильтрация каталога.
 *
 * Источники отдают жанры и типы по-разному: у одних это отдельные разделы
 * (`/films/`, `/serials/`), у других — страницы жанров (`/action/`,
 * `/boeviki/`, `/film/action/`), у третьих параметры URL просто игнорируются.
 * Здесь собрано то, что переводит универсальные фильтры приложения в
 * «родные» адреса конкретного источника. Всё, что источнику недоступно,
 * остаётся на локальную фильтрацию в `filterItems()`.
 */

const KIND_CATEGORY: Record<string, string> = {
  movie: 'films',
  serial: 'serials',
  cartoon: 'cartoons',
  anime: 'anime',
};

/** Раздел каталога, отвечающий за тип (`serial` → `serials`), либо `undefined`. */
export function kindCategory(kind: string | undefined): string | undefined {
  return kind ? KIND_CATEGORY[kind] : undefined;
}

/**
 * Раздел каталога под выбранный тип. `kind` важнее выбранного раздела
 * (пользователь явно выбрал «Сериалы» — показываем сериалы), но только если
 * у источника такой раздел вообще есть: иначе вернётся исходный `categoryId`
 * и тип дорежет уже локальная фильтрация.
 */
export function effectiveCategory(
  categoryId: string,
  filters: CatalogFilterState | undefined,
  paths: Record<string, string>,
): string {
  const wanted = filters?.kind ? KIND_CATEGORY[filters.kind] : undefined;
  if (wanted && paths[wanted] !== undefined) return wanted;
  return categoryId;
}

/**
 * Год, когда диапазон сводится к одному («от 2024» или «от 2024 до 2024»).
 * Такие источники умеют отдавать архив года; диапазон они не понимают.
 */
export function singleYear(filters: CatalogFilterState | undefined): number | undefined {
  const from = Number(filters?.yearFrom) || 0;
  const to = Number(filters?.yearTo) || 0;
  // Архив года обслуживает только точный год: «Год от» без «Год до» —
  // открытый диапазон («с 2024»), его честно обслуживает локальная
  // фильтрация, а уход в архив потерял бы более новые годы.
  if (!from || !to || to !== from) return undefined;
  return from;
}

/**
 * Можно ли уходить на корневую страницу жанра (`/action/`, `/boeviki/`).
 * Корневые жанровые разделы не сохраняют выбранный раздел каталога —
 * в `/action/` лежат и фильмы, и сериалы, — поэтому уходить на них
 * безопасно только когда раздел не задан (Главная/Новинки) либо тип и так
 * повторно режется локально по `filters.kind`.
 */
export function rootGenreAllowed(categoryId: string, filters?: CatalogFilterState): boolean {
  return !!filters?.kind || categoryId === 'home' || categoryId === 'new';
}

/** Нормализация названия жанра: регистр, ё → е, лишние пробелы. */
export function normGenre(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Типичные русские окончания — чтобы «Боевики» совпало с «Боевик». */
const ENDINGS = [
  'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ы', 'и', 'ь', 'а', 'я', 'о', 'е',
];

/** Срезает окончания, не укорачивая слово ниже 5 символов. */
function stem(value: string): string {
  let s = normGenre(value);
  let changed = true;
  while (changed && s.length > 5) {
    changed = false;
    for (const ending of ENDINGS) {
      if (s.length - ending.length >= 5 && s.endsWith(ending)) {
        s = s.slice(0, -ending.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Сопоставление выбранного жанра со слагом раздела источника: сначала точное
 * совпадение, затем совпадение «стеблей» (Боевики = Боевик), затем общий
 * префикс от 4 символов (биографический = биографии, спорт = спортивный).
 * Короткие совпадения не берём: «фант» не должно связать Фантастику
 * с Фэнтези. Ярлыки подписей приводятся через `WANTED_ALIASES` — сайты
 * могут называть жанр иначе (лордфильм подписывает мюзикл разделом
 * «музыкальные»).
 */
const WANTED_ALIASES: Record<string, string[]> = {
  'мюзикл': ['музыкальные'],
};

export function resolveGenreSlug(map: Map<string, string>, wanted: string): string | undefined {
  const wantedNorm = normGenre(wanted);
  if (!wantedNorm) return undefined;
  for (const candidate of [wantedNorm, ...(WANTED_ALIASES[wantedNorm] ?? [])]) {
    const hit = matchGenreLabel(map, candidate);
    if (hit) return hit;
  }
  return undefined;
}

function matchGenreLabel(map: Map<string, string>, wantedNorm: string): string | undefined {
  const exact = map.get(wantedNorm);
  if (exact) return exact;

  const wantedStem = stem(wantedNorm);
  let best: { slug: string; score: number } | undefined;
  for (const [label, slug] of map) {
    const labelStem = stem(label);
    if (labelStem === wantedStem) return slug;
    const prefix = commonPrefix(wantedStem, labelStem);
    if (prefix >= 4 && Math.min(wantedStem.length, labelStem.length) >= 4) {
      if (!best || prefix > best.score) best = { slug, score: prefix };
    }
  }
  return best?.slug;
}

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SLUG_PATH_RE = /^\/(?:[a-z0-9_-]+\/){1,2}[a-z0-9_-]*$/i;
const CYRILLIC_RE = /^[А-Яа-яЁё][А-Яа-яЁё\s-]{1,39}$/;

/**
 * Собирает «название жанра → слаг» из навигации самой страницы источника.
 * Маппинг не хардкодится: сайты переименовывают разделы, а подписи на
 * странице всегда актуальны. Каждый сегмент пути даёт последний кусок:
 * `/action/` → `action`, `/film/action/` → `action`.
 */
export function extractGenreSlugs(html: string, origin: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!html) return out;
  let match: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const href = match[1];
    const label = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!CYRILLIC_RE.test(label)) continue;

    let path: string;
    if (href.startsWith('/')) {
      path = href;
    } else if (/^https?:\/\//i.test(href)) {
      try {
        const url = new URL(href);
        if (url.origin !== origin) continue;
        path = url.pathname;
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (!SLUG_PATH_RE.test(path)) continue;

    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1];
    if (!slug) continue;
    const key = normGenre(label);
    if (key && !out.has(key)) out.set(key, slug);
  }
  return out;
}

/**
 * Проставляет жанр, по которому источник уже отфильтровал выдачу на сервере.
 *
 * Без этого локальная фильтрация зачистила бы готовый ответ: у ReYohoho поле
 * `genres` отсутствует вовсе, у остальных источников жанры появляются только
 * у первых 12 карточек страницы (их гидратирует `enrichSummaries` со страницы
 * деталей). Вызывать **после** гидратации — иначе она перезапишет genres.
 */
export function stampGenre(items: MediaSummary[], genre: string): MediaSummary[] {
  const wanted = normGenre(genre);
  if (!wanted) return items;
  return items.map((item) => {
    const genres = item.genres ?? [];
    const already = genres.some((g) =>
      normGenre(g)
        .split(/[,;/+&·]|\s{2,}/)
        .some((part) => part.trim() === wanted),
    );
    return already ? item : { ...item, genres: [...genres, genre] };
  });
}
