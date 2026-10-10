import type { MediaSummary } from './models';

/**
 * Нормализованный ключ одного фильма/сериала. Разные источники отдают
 * разные url и постеры на один и тот же материал — по ключу записи
 * склеиваются (история просмотра не плодит дублей).
 */
export function normalizeTitle(title: string): string {
  // Парсеры типизированы как строки, но нестроковое значение (у зоны сериал
  // «1923» приходил числом) роняло публикацию каталога целиком — на всякий
  // случай приводим к строке, а не падаем.
  const raw = typeof title === 'string' ? title : String(title ?? '');
  const base = raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    // «Название (2026) / The Title» — год в скобках и второе (английское) имя
    .replace(/\s*\([^()]*\b(?:19|20)\d{2}\b[^()]*\)/g, ' ')
    .split(/\s*\|\s*/)
    .shift()!
    .split(/\s+\/\s+/)
    .shift()!
    .replace(/[«»"'!?():;,—–|/]/g, ' ')
    .replace(/[\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** All years inside `raw`; «2008-2015» yields both. */
export function yearsIn(raw?: string | null): number[] {
  return [...(raw ?? '').matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
}

/** A range like «2008-2015» counts as its latest year. */
export function maxYear(raw?: string | null): string | undefined {
  const years = yearsIn(raw);
  return years.length ? String(Math.max(...years)) : undefined;
}

/** Year for dedupe: the field when set, otherwise a year parsed out of the title. */
export function effectiveYear(item: MediaSummary): string {
  const direct = maxYear(item.year);
  if (direct) return direct;
  const m = String(item.title ?? '').match(/\([^()]*\b(?:19|20)\d{2}\b[^()]*\)/);
  return m ? (maxYear(m[0]) ?? '') : '';
}

/**
 * Один и тот же материал? Заголовки равны, а годы — если известны у обеих
 * записей — совпадают (ремейки с одинаковым названием остаются разными).
 */
export function sameMedia(a: MediaSummary, b: MediaSummary): boolean {
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  const ya = effectiveYear(a);
  const yb = effectiveYear(b);
  return !ya || !yb || ya === yb;
}
