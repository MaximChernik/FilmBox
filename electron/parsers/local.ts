import * as fs from 'fs';
import * as path from 'path';
import type {
  Category,
  MediaDetails,
  MediaSummary,
  PagedResult,
  PlayerTab,
  StreamCatalog,
  StreamsRequest,
  CatalogFilterState,} from '../models';
import type { SourceParser } from './base';
import { stateReadRaw } from '../state-store';

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'wmv', 'mpg', 'mpeg']);
const MAX_FILES = 800;
const MAX_DEPTH = 4;

/** Отдельный раздел для локальных файлов — не подмешивается в чужие категории. */
const LOCAL_CATEGORY: Category = { id: 'local', title: 'Локальные' };

/** Короткий кэш сканирования: папку дёргают и шапка, и каталог. */
const SCAN_TTL_MS = 1500;
let scanCache: { folder: string; at: number; files: string[] } | null = null;

function scanCached(folder: string): string[] {
  const now = Date.now();
  if (scanCache && scanCache.folder === folder && now - scanCache.at < SCAN_TTL_MS) {
    return scanCache.files;
  }
  const files = scan(folder);
  scanCache = { folder, at: now, files };
  return files;
}

function isSerialName(dirName: string, base: string): boolean {
  if (/сериал|series/i.test(dirName)) return true;
  return /(^|[\W_\.])s\d{1,2}e\d{1,2}|(\d{1,2})x\d{2}|сезон|season|\b\d+\s*серия\b/i.test(base);
}

function parseQuality(base: string): string | undefined {
  const m = base.match(
    /(2160p|4k|1080p|720p|web[-\s]?dl|webrip|blu[-\s]?ray|bdrip|brrip|camrip|rip)/i,
  );
  return m ? m[1] : undefined;
}

export function fileToUrl(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/').replace(/^\//, '');
  return 'file:///' + encodeURI(normalized);
}

export function urlToFilePath(url: string): string {
  const raw = decodeURIComponent(url.replace(/^file:\/\/\//, ''));
  return raw.replace(/\//g, path.sep);
}

function titleFromBase(base: string, year?: string): string {
  let t = base.replace(/\./g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (year) t = t.replace(new RegExp(`\\b${year}\\b`), '');
  t = t
    .replace(
      /\b(2160p|4k|1080p|720p|web[-\s]?dl|webrip|blu[-\s]?ray|bdrip|brrip|camrip|rip|s\d{1,2}e\d{1,2}|\d{1,2}x\d{2}|torrent|hdrip|remastered)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
    .trim();
  return t || base.trim();
}

/** Recursively collect base file paths up to depth/file-count caps. */
function scan(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scan(full, depth + 1, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase().slice(1);
      if (VIDEO_EXTS.has(ext)) out.push(full);
    }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function findPoster(dir: string, base: string): string | undefined {
  const candidates = [
    path.join(dir, base + '.jpg'),
    path.join(dir, base + '.jpeg'),
    path.join(dir, base + '.png'),
    path.join(dir, 'poster.jpg'),
    path.join(dir, 'poster.jpeg'),
    path.join(dir, 'poster.png'),
    path.join(dir, 'folder.jpg'),
    path.join(dir, 'cover.jpg'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return fileToUrl(c);
    } catch {
      // ignore
    }
  }
  return undefined;
}

function toSummary(fullPath: string): MediaSummary {
  const dir = path.dirname(fullPath);
  const dirName = path.basename(dir);
  const ext = path.extname(fullPath);
  const base = path.basename(fullPath, ext);
  const yearMatch = base.match(/(19|20)\d{2}/);
  const quality = parseQuality(base);
  const serial = isSerialName(dirName, base);
  const title = titleFromBase(base, yearMatch?.[0]);
  let siteDate = '';
  try {
    const st = fs.statSync(fullPath);
    siteDate = st.mtime.toISOString().slice(0, 10);
  } catch {
    // mtime unknown — leave empty
  }
  return {
    url: fileToUrl(fullPath),
    title,
    poster: findPoster(dir, base),
    year: yearMatch?.[0],
    quality,
    kind: serial ? 'serial' : 'movie',
    siteDate,
    genres: [],
  };
}

function toDetails(fullPath: string): MediaDetails {
  const summary = toSummary(fullPath);
  const players: PlayerTab[] = [{ label: 'Мой файл', url: summary.url, kind: 'unknown' }];
  return {
    ...summary,
    players,
    sourceId: 'local',
    description: `Локальный файл: ${path.basename(fullPath)}`,
  };
}

/** folder from FilmBox settings (синхронизируются main'ом через state store) */
function localFolderFromSettings(): string | null {
  try {
    const raw = stateReadRaw('filmbox:settings');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { localVideosPath?: unknown };
    const folder = typeof parsed.localVideosPath === 'string' ? parsed.localVideosPath.trim() : '';
    return folder && fs.existsSync(folder) ? folder : null;
  } catch {
    return null;
  }
}

export class LocalSourceParser implements SourceParser {
  readonly id = 'local';
  readonly name = 'Мои файлы';

  /**
   * Раздел «Локальные» появляется только когда указана папка и в ней есть
   * видеофайлы — иначе чип и пункт меню не показываются вовсе.
   */
  get categories(): Category[] {
    const folder = localFolderFromSettings();
    if (!folder) return [];
    return scanCached(folder).length ? [LOCAL_CATEGORY] : [];
  }

  matchesUrl(url: string): boolean {
    try {
      return /^file:\/\//i.test(url);
    } catch {
      return false;
    }
  }

  /**
   * Локальные файлы живут только в своём разделе «Локальные»:
   * в home/films/serials и чужих категориях они не подмешиваются.
   */
  async getCatalog(page: number, categoryId = 'local', filters?: CatalogFilterState): Promise<PagedResult> {
    if (categoryId !== 'local') return { items: [], page, hasMore: false };
    const folder = localFolderFromSettings();
    if (!folder) return { items: [], page, hasMore: false };
    let all = scanCached(folder)
      .map(toSummary)
      .sort(
        (a, b) =>
          (b.siteDate ?? '').localeCompare(a.siteDate ?? '') ||
          a.title.localeCompare(b.title, 'ru'),
      );
    // Серверная фильтрация невозможна — фильтруем локально до пагинации.
    if (filters) {
      all = all.filter((item) => {
        if (filters.kind && item.kind !== filters.kind) return false;
        if (filters.yearFrom || filters.yearTo) {
          const y = item.year ? Number(item.year) : NaN;
          if (filters.yearFrom && (isNaN(y) || y < Number(filters.yearFrom))) return false;
          if (filters.yearTo && (isNaN(y) || y > Number(filters.yearTo))) return false;
        }
        if (filters.rating && (item.rating ?? 0) < Number(filters.rating)) return false;
        return true;
      });
    }
    const pageSize = 40;
    const start = (Math.max(1, page) - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize),
      page,
      hasMore: start + pageSize < all.length,
    };
  }

  async search(query: string): Promise<PagedResult> {
    const q = query.trim().toLowerCase();
    const folder = localFolderFromSettings();
    if (!folder || !q) return { items: [], page: 1, hasMore: false };
    const items = scanCached(folder)
      .map(toSummary)
      .filter((it) => it.title.toLowerCase().includes(q));
    return { items, page: 1, hasMore: false };
  }

  async getDetails(url: string): Promise<MediaDetails> {
    const fullPath = urlToFilePath(url);
    if (!fs.existsSync(fullPath)) {
      throw new Error('Локальный файл не найден — возможно, он был перемещён или удалён');
    }
    return toDetails(fullPath);
  }

  async resolveStreams(req: StreamsRequest): Promise<StreamCatalog> {
    const fullPath = urlToFilePath(req.tabUrl);
    const base = path.basename(fullPath, path.extname(fullPath));
    return {
      sourceId: this.id,
      tabLabel: base,
      episodes: [
        {
          season: 1,
          episode: 'Файл',
          label: titleFromBase(base, base.match(/(19|20)\d{2}/)?.[0]),
          streams: [{ type: 'mp4', url: req.tabUrl, label: 'Локально' }],
          subtitles: [],
        },
      ],
      fallbackEmbedUrl: req.tabUrl,
    };
  }
}
