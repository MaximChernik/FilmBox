import type { MediaSummary } from '../../core/models';
import { effectiveYear, maxYear, normalizeTitle } from '../../core/media-key';

// Ключи дедупа живут в core — ими же пользуется библиотека (история просмотра)
export { effectiveYear, maxYear, normalizeTitle, yearsIn } from '../../core/media-key';

export function qualityScore(item: MediaSummary): number {
  const text = `${item.quality ?? ''} ${item.ribbon ?? ''}`.toLowerCase();
  if (/(2160|4k|uhd)/.test(text)) return 5;
  if (/1440/.test(text)) return 4;
  if (/(1080|full\s*hd)/.test(text)) return 3;
  if (/(720|hd\s*ready)/.test(text)) return 2;
  if (/(web-?dl|webrip|remux|bd?rip|hdtv|dvd|576|480)/.test(text)) return 1;
  return 0;
}

/** Prefer `a` over `b`: quality first, then a known year over an unknown one. */
function prefer(a: MediaSummary, b: MediaSummary): boolean {
  const qa = qualityScore(a);
  const qb = qualityScore(b);
  if (qa !== qb) return qa > qb;
  return !effectiveYear(b) && !!effectiveYear(a);
}

/** Merge two cards for the same media: the better one wins, fields combine. */
function mergePair(a: MediaSummary, b: MediaSummary): MediaSummary {
  const merged = prefer(a, b) ? a : b;
  const other = merged === a ? b : a;
  const mergedYear = merged.year ?? (effectiveYear(merged) || effectiveYear(other) || undefined);
  // quality wins the merge, but never at the cost of the kind: a card
  // without a detected kind must not erase the other's known one
  const mergedKind = knownKind(merged.kind) ?? knownKind(other.kind) ?? merged.kind;
  // the losing card may still carry fields the winner lacks — keep them all
  return {
    ...merged,
    year: mergedYear || undefined,
    kind: mergedKind,
    siteDate: newerDate(merged.siteDate, other.siteDate),
    seasonsCount: merged.seasonsCount ?? other.seasonsCount,
    lastEpisode: merged.lastEpisode ?? other.lastEpisode,
    episodesCount: merged.episodesCount ?? other.episodesCount,
    quality: merged.quality ?? other.quality,
    ribbon: merged.ribbon ?? other.ribbon,
    genres: merged.genres?.length ? merged.genres : other.genres,
  };
}

export function dedupeByQuality(items: MediaSummary[]): MediaSummary[] {
  const out: MediaSummary[] = [];
  // Точное совпадение (нормализованный заголовок + год) — O(1) через Map;
  // нечёткие варианты («Братство кольца» vs «Властелин колец: Братство
  // кольца») остаются на скане, но встречаются редко.
  const exactIdx = new Map<string, number>();
  for (const item of items) {
    const title = normalizeTitle(item.title);
    const year = effectiveYear(item);
    const key = title + '|' + year;
    const hit = exactIdx.get(key);
    if (hit !== undefined) {
      out[hit] = mergePair(out[hit], item);
      continue;
    }
    const idx = out.findIndex((other) => {
      const t2 = normalizeTitle(other.title);
      const y2 = effectiveYear(other);
      if (year !== '' && y2 !== '' && y2 !== year) return false;
      return t2.includes(title) || title.includes(t2);
    });
    if (idx === -1) {
      exactIdx.set(key, out.length);
      out.push(item);
    } else {
      out[idx] = mergePair(out[idx], item);
    }
  }
  return out;
}

/** The newer of two `YYYY-MM[-DD]` dates (lexicographic = chronological). */
function newerDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

export function mergeUnique(target: MediaSummary[], extra: MediaSummary[]): MediaSummary[] {
  const seen = new Set(target.map((i) => i.url));
  const merged = [...target];
  for (const item of extra) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      merged.push(item);
    }
  }
  return dedupeByQuality(merged);
}

/** A kind usable by the «Тип» filter; `unknown`/absent is no kind at all. */
function knownKind(kind: MediaSummary['kind']): MediaSummary['kind'] {
  return kind && kind !== 'unknown' ? kind : undefined;
}

export const KIND_OPTIONS: Array<{ id: string; title: string }> = [
  { id: 'movie', title: 'Фильмы' },
  { id: 'serial', title: 'Сериалы' },
  { id: 'cartoon', title: 'Мультфильмы' },
  { id: 'anime', title: 'Аниме' },
];

/**
 * Curated genre presets for the catalog dropdown: only genres supported by a
 * majority of sources (5–8 of 8). «Аниме» (4/8) and «Спортивный» (4/8) were
 * dropped after the coverage audit. Item genres are NOT merged into the
 * dropdown — sources tag the same genre differently («Драма»/«Драмы»), which
 * used to duplicate every option with each new page load.
 */
export const PRESET_GENRES = [
  'Боевик',
  'Комедия',
  'Драма',
  'Ужасы',
  'Триллер',
  'Фантастика',
  'Фэнтези',
  'Приключения',
  'Мелодрама',
  'Детектив',
  'Криминал',
  'Семейный',
  'Мультфильм',
  'Исторический',
  'Военный',
  'Биографический',
  'Вестерн',
  'Мюзикл',
];

export const RATING_OPTIONS = ['5', '6', '7', '8', '9'];

export type SortId =
  | 'default'
  | 'year-desc'
  | 'year-asc'
  | 'title-asc'
  | 'title-desc'
  | 'rating-desc'
  | 'quality-desc';

export const SORT_OPTIONS: Array<{ id: SortId; title: string }> = [
  { id: 'default', title: 'По умолчанию' },
  { id: 'year-desc', title: 'Год: сначала новые' },
  { id: 'year-asc', title: 'Год: сначала старые' },
  { id: 'rating-desc', title: 'Рейтинг: сначала лучшие' },
  { id: 'quality-desc', title: 'Качество: сначала 4K/FHD' },
  { id: 'title-asc', title: 'Название: А-Я' },
  { id: 'title-desc', title: 'Название: Я-А' },
];

/** 5 = 4K … 0 = unknown; bucketlike sorting by the best tag on the card. */
export function qualityRank(item: MediaSummary): number {
  const text = `${item.quality ?? ''} ${item.ribbon ?? ''}`.toLowerCase();
  if (/(2160|4k|uhd)/.test(text)) return 5;
  if (/1440/.test(text)) return 4;
  if (/(1080|full\s*hd|fhd)/.test(text)) return 3;
  if (/(720|hd|hd tv)/.test(text)) return 2;
  if (/(web-?dl|webrip|remux|bd?rip|hdtv|dvd|576|480|\bsd\b)/.test(text)) return 1;
  return 0;
}

export function yearNum(item: MediaSummary): number | null {
  const year = maxYear(item.year);
  return year ? Number(year) : null;
}

/** Items lacking the field always sink to the end of the list. */
export function sortItems(items: MediaSummary[], mode: SortId): MediaSummary[] {
  if (mode === 'default') return items;
  const arr = [...items];
  const sinkLast = (a: number | null, b: number | null): number | null => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return null;
  };
  switch (mode) {
    case 'year-desc':
      arr.sort((a, b) => {
        const s = sinkLast(yearNum(a), yearNum(b));
        return s !== null ? s : (yearNum(b) as number) - (yearNum(a) as number);
      });
      break;
    case 'year-asc':
      arr.sort((a, b) => {
        const s = sinkLast(yearNum(a), yearNum(b));
        return s !== null ? s : (yearNum(a) as number) - (yearNum(b) as number);
      });
      break;
    case 'rating-desc':
      arr.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
      break;
    case 'quality-desc':
      arr.sort((a, b) => qualityRank(b) - qualityRank(a));
      break;
    case 'title-asc':
      arr.sort((a, b) => a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' }));
      break;
    case 'title-desc':
      arr.sort((a, b) => b.title.localeCompare(a.title, 'ru', { sensitivity: 'base' }));
      break;
  }
  return arr;
}

/**
 * «Новинки» by default: the production year first (newest releases on top),
 * then the source's publication/update date. Cards without a year or date
 * sink to the end of their group; ties keep the incoming order.
 */
export function sortNewest(items: MediaSummary[]): MediaSummary[] {
  return [...items].sort((a, b) => {
    const ya = yearNum(a);
    const yb = yearNum(b);
    if (ya !== null && yb !== null && ya !== yb) return yb - ya;
    if (ya === null && yb !== null) return 1;
    if (ya !== null && yb === null) return -1;
    // the same year (or both unknown) — the newer site date wins
    const da = a.siteDate ?? '';
    const db = b.siteDate ?? '';
    if (da === db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da > db ? -1 : 1;
  });
}

export function normFilter(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Split an item's genres into normalized tokens. Comparison happens token by
 * token — a substring match would wrongly pass «Драма» for «Мелодрама».
 */
export function genreTokens(item: MediaSummary): string[] {
  const out: string[] = [];
  for (const genre of item.genres ?? []) {
    for (const part of normFilter(genre).split(/[,;/+&·]|\s{2,}/)) {
      const token = part.trim();
      if (token) out.push(token);
    }
  }
  return out;
}

/** Typical Russian endings so «Драмы» still matches «Драма». */
const GENRE_ENDINGS = [
  'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ы', 'и', 'ь', 'а', 'я', 'о', 'е',
];

/** Cuts endings without shortening below 5 chars — mirrors `resolveGenreSlug`
 * in the parsers so local and server-side genre matching agree. */
function stemFilter(value: string): string {
  let s = normFilter(value).replace(/\s+/g, ' ');
  let changed = true;
  while (changed && s.length > 5) {
    changed = false;
    for (const ending of GENRE_ENDINGS) {
      if (s.length - ending.length >= 5 && s.endsWith(ending)) {
        s = s.slice(0, -ending.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Item token vs the selected preset: equal stems, or a shared prefix of at
 * least 4 chars («История» vs «Исторический»). Never a plain substring —
 * «Мелодрама» must not pass for «Драма».
 */
export function genreMatches(token: string, selected: string): boolean {
  const a = stemFilter(token);
  const b = stemFilter(selected);
  if (a === b) return true;
  return commonPrefixLen(a, b) >= 4 && Math.min(a.length, b.length) >= 4;
}

export interface CatalogFilterState {
  kind: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  rating: string;
  quality: string;
}

/** `true` when at least one filter narrows the list down. */
export function hasActiveFilters(f: CatalogFilterState): boolean {
  return !!(f.kind || f.genre || f.yearFrom || f.yearTo || f.rating || f.quality);
}

/** Keeps only the items matching every active filter (empty state = no filter). */
export function filterItems(items: MediaSummary[], f: CatalogFilterState): MediaSummary[] {
  const kind = f.kind;
  const genre = normFilter(f.genre);
  const yearFrom = Number(f.yearFrom) || 0;
  const yearTo = Number(f.yearTo) || 0;
  const minRating = Number(f.rating) || 0;
  if (!kind && !genre && !yearFrom && !yearTo && !minRating && !f.quality) return items;
  return items.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (genre && !genreTokens(item).some((token) => genreMatches(token, genre))) return false;
    if (yearFrom || yearTo) {
      const year = yearNum(item);
      if (year === null) return false;
      if (yearFrom && year < yearFrom) return false;
      if (yearTo && year > yearTo) return false;
    }
    if (minRating && (item.rating ?? 0) < minRating) return false;
    if (f.quality) {
      // the option means "at least this quality"
      const want: Record<string, number> = { '4k': 5, fhd: 3, hd: 2, sd: 1 };
      const min = want[f.quality];
      if (min !== undefined && qualityRank(item) < min) return false;
    }
    return true;
  });
}
