/**
 * Small date/field helpers shared by the source parsers: year ranges,
 * site dates baked into poster paths, and season/episode badges.
 */

import type { MediaDetails, MediaSummary } from '../models';

const ENRICH_CACHE = new Map<string, { ts: number; data: Partial<MediaSummary> }>();
let enrichLoaded = false;
const ENRICH_TTL = 30 * 60 * 1000;

function enrichFilePath(): string | null {
  try {
    const { app } = require('electron');
    return require('path').join(app.getPath('userData'), 'filmbox-enrich.json');
  } catch {
    return null;
  }
}

function enrichLoad(): void {
  if (enrichLoaded) return;
  enrichLoaded = true;
  const file = enrichFilePath();
  if (!file) return;
  try {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      { ts: number; data: Partial<MediaSummary> }
    >;
    for (const [url, entry] of Object.entries(raw)) {
      if (entry && typeof entry.ts === 'number' && Date.now() - entry.ts < ENRICH_TTL) {
        ENRICH_CACHE.set(url, entry);
      }
    }
  } catch {
    // absent or broken cache file is fine
  }
}

function enrichSave(): void {
  const file = enrichFilePath();
  if (!file) return;
  try {
    const fs = require('fs');
    const out: Record<string, { ts: number; data: Partial<MediaSummary> }> = {};
    // prune expired and cap the file size (most-recent wins)
    const fresh = [...ENRICH_CACHE]
      .filter(([, entry]) => Date.now() - entry.ts < ENRICH_TTL)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 800);
    for (const [url, entry] of fresh) out[url] = entry;
    fs.writeFileSync(file, JSON.stringify(out));
  } catch {
    // ignore
  }
}

/**
 * Listing cards often carry only a title+poster; hydrate the first cards
 * of a page from their detail pages (rating, quality, seasons, last episode).
 * Chunks run in parallel and the results are cached, so a catalog load stays
 * within one round-trip of latency.
 */
export async function enrichSummaries(
  items: MediaSummary[],
  limit: number,
  getDetails: (url: string) => Promise<MediaDetails>,
): Promise<MediaSummary[]> {
  enrichLoad();
  const head = items.slice(0, limit);
  let wrote = false;
  const hydrate = async (item: MediaSummary): Promise<MediaSummary> => {
    const hit = ENRICH_CACHE.get(item.url);
    if (hit && Date.now() - hit.ts < ENRICH_TTL) return { ...item, ...hit.data };
    // the card already carries everything a detail page would add
    const complete =
      !!item.year &&
      !!item.quality &&
      item.rating !== undefined &&
      (item.kind !== 'serial' || item.seasonsCount !== undefined);
    if (complete) return item;
    try {
      const d = await getDetails(item.url);
      const data: Partial<MediaSummary> = {
        quality: d.quality,
        seasonsCount: d.seasonsCount,
        lastEpisode: d.lastEpisode,
        rating: d.rating,
        ratingKp: d.ratingKp,
        ratingImdb: d.ratingImdb,
        year: d.year ?? item.year,
        kind: d.kind,
        // жанры карточкам нужны фильтру в рендере — списки их часто не дают
        genres: d.genres?.length ? d.genres : item.genres,
      };
      ENRICH_CACHE.set(item.url, { ts: Date.now(), data });
      wrote = true;
      return { ...item, ...data };
    } catch {
      return item;
    }
  };
  const chunks: MediaSummary[][] = [];
  for (let i = 0; i < head.length; i += 4) chunks.push(head.slice(i, i + 4));
  const results = await Promise.all(
    chunks.map((chunk) => Promise.all(chunk.map((item) => hydrate(item)))),
  );
  if (wrote) enrichSave();
  return [...results.flat(), ...items.slice(limit)];
}

/** All years inside `raw`; «2008-2015» yields both. */
function yearsIn(raw?: string | null): number[] {
  return [...(raw ?? '').matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
}

/**
 * The production year of a title: a range is taken as its maximum
 * («2008-2015» → «2015» — the year the show's run ended).
 */
export function maxYear(raw?: string | null): string | undefined {
  const years = yearsIn(raw);
  return years.length ? String(Math.max(...years)) : undefined;
}

/** Upload month baked into DLE poster paths: `/uploads/posts/2026-06/x.jpg` → «2026-06». */
export function siteDateFromPoster(url?: string | null): string | undefined {
  return (url ?? '').match(/\/uploads\/posts\/(\d{4}-\d{2})\//)?.[1];
}

/** Poster path alone can carry the release year: «…/uploads/posts/2026-09/…» → «2026». */
export function yearFromPoster(url?: string | null): string | undefined {
  return (url ?? '').match(/\/uploads\/posts\/(\d{4})-\d{2}\//)?.[1];
}

/**
 * Normalize a source date to `YYYY-MM-DD` / `YYYY-MM` so mixed sources can be
 * compared lexicographically. Accepts ISO, DD-MM-YYYY (kinokong's ld+json) and
 * unix timestamps in seconds/milliseconds.
 */
export function normalizeSiteDate(raw?: string | number | null): string | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
  }
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = value.match(/^(\d{2})-(\d{2})-(\d{4})$/); // «04-10-2026»
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return /^\d{4}-\d{2}$/.test(value) ? value : undefined;
}

/** «1 сезон 3 серия» → `{ seasonsCount: '1', lastEpisode: '3' }`. */
export function seasonsFromText(raw?: string | null): {
  seasonsCount?: string;
  lastEpisode?: string;
} {
  const text = raw ?? '';
  return {
    seasonsCount: text.match(/(\d+)\s*сезон/i)?.[1],
    lastEpisode: text.match(/(\d+)\s*серия/i)?.[1],
  };
}

/** The widest quality token found in free text, kinogo-style. */
export function bestQualityFromText(text?: string | null): string | undefined {
  const t = (text ?? '').toLowerCase();
  if (/(2160|4k|\buhd\b)/.test(t)) return '4K';
  if (/1440/.test(t)) return 'QHD (1440p)';
  if (/(1080|full\s*hd|fhd)/.test(t)) return 'FHD (1080p)';
  if (/(720|\bhd\b)/.test(t)) return 'HD (720p)';
  if (/\bsd\b/.test(t)) return 'SD';
  return undefined;
}

/** «1920»×«1080» → «FHD (1080p)» from OpenGraph og:video:height. */
export function qualityFromHeight(height?: string | number | null): string | undefined {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return undefined;
  if (h >= 2160) return '4K';
  if (h >= 1440) return 'QHD (1440p)';
  if (h >= 1080) return 'FHD (1080p)';
  if (h >= 720) return 'HD (720p)';
  return 'SD';
}

/** Season count from an info row: «Сезонов: 9» (bare count) or «Сезон: 1 сезон». */
export function seasonsFromRow(label: string, value?: string): string | undefined {
  if (!value) return undefined;
  const fromText = seasonsFromText(value).seasonsCount;
  if (fromText) return fromText;
  return label.includes('сезонов') ? value.match(/\d+/)?.[0] : undefined;
}
