import { Injectable, computed, signal } from '@angular/core';
import { sameMedia } from './media-key';
import { storageGet, storageSet } from './persistent-storage';
import type { MediaSummary } from './models';

export interface HistoryEntry {
  item: MediaSummary;
  watchedAt: number;
}

/** Last watched episode of a series, keyed by media url. */
export interface EpisodeProgress {
  season: number;
  episode: string;
  at: number;
  /** watched position, seconds (0 / missing = not watched yet) */
  time?: number;
  /** full length of that episode, seconds (0 / missing = unknown) */
  duration?: number;
  /** last active player tab — lets "continue" reopen the same source */
  tab?: string;
}

const FAVORITES_KEY = 'filmbox:favorites';
const HISTORY_KEY = 'filmbox:history';
const LATER_KEY = 'filmbox:later';
const PROGRESS_KEY = 'filmbox:progress';
const RATING_KEY = 'filmbox:ratings';
const STATUS_KEY = 'filmbox:statuses';
const FOLLOWS_KEY = 'filmbox:follows';
const ALERTS_KEY = 'filmbox:alerts';
const HISTORY_LIMIT = 60;
const PROGRESS_LIMIT = 120;
const ALERTS_LIMIT = 50;

/**
 * Отслеживаемый сериал: помним последнюю известную серию/сезон, чтобы
 * периодическая проверка замечала только новые выходы (и не дублировала
 * уведомление о том, что уже показано).
 */
export interface FollowEntry {
  item: MediaSummary;
  /** последняя известная серия на момент последней проверки */
  lastEpisode?: string;
  /** последний известный сезон */
  seasonsCount?: string;
  checkedAt: number;
}

/**
 * Сообщение в колокольчике шапки: проверка нашла новую серию отслеживаемого
 * сериала. Живёт отдельно от follows — серия может «всплыть» и после того,
 * как сериал перестали отслеживать.
 */
export interface AlertEntry {
  url: string;
  title: string;
  poster?: string;
  /** что нового: «Сезон 2, Серия 5» */
  text: string;
  at: number;
  read: boolean;
}

/** Статус просмотра материала. */
export type WatchStatus = 'watching' | 'watched' | 'dropped';

export interface WatchStatusOption {
  id: WatchStatus;
  title: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = storageGet(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value));
}

@Injectable({ providedIn: 'root' })
export class LibraryService {
  readonly favorites = signal<MediaSummary[]>(readJson<MediaSummary[]>(FAVORITES_KEY, []));
  readonly history = signal<HistoryEntry[]>(readJson<HistoryEntry[]>(HISTORY_KEY, []));
  readonly later = signal<MediaSummary[]>(readJson<MediaSummary[]>(LATER_KEY, []));
  readonly progress = signal<Record<string, EpisodeProgress>>(
    readJson<Record<string, EpisodeProgress>>(PROGRESS_KEY, {}),
  );
  /** Моя оценка по каждому материалу: 1–10, отсутствует = не оценено. */
  readonly ratings = signal<Record<string, number>>(
    readJson<Record<string, number>>(RATING_KEY, {}),
  );
  /** Моя метка просмотра: «смотрю» / «досмотрел» / «брошено». */
  readonly statuses = signal<Record<string, WatchStatus>>(
    readJson<Record<string, WatchStatus>>(STATUS_KEY, {}),
  );
  /** Сериалы, за которыми слежу: новые серии → системное уведомление. */
  readonly follows = signal<Record<string, FollowEntry>>(
    readJson<Record<string, FollowEntry>>(FOLLOWS_KEY, {}),
  );
  /** Лента «новых серий» для колокольчика в шапке (новые сверху). */
  readonly alerts = signal<AlertEntry[]>(readJson<AlertEntry[]>(ALERTS_KEY, []));
  readonly unreadCount = computed(() => this.alerts().filter((a) => !a.read).length);

  readonly favoriteUrls = computed(() => new Set(this.favorites().map((f) => f.url)));
  readonly laterUrls = computed(() => new Set(this.later().map((l) => l.url)));
  readonly followUrls = computed(() => new Set(Object.keys(this.follows())));

  isFavorite(url: string): boolean {
    return this.favoriteUrls().has(url);
  }

  isLater(url: string): boolean {
    return this.laterUrls().has(url);
  }

  isFollow(url: string): boolean {
    return this.followUrls().has(url);
  }

  /** Включает/выключает отслеживание новых серий (снимок серии — стартовый). */
  toggleFollow(item: MediaSummary): void {
    const next = { ...this.follows() };
    if (next[item.url]) {
      delete next[item.url];
    } else {
      next[item.url] = {
        item,
        lastEpisode: item.lastEpisode,
        seasonsCount: item.seasonsCount,
        checkedAt: Date.now(),
      };
    }
    this.follows.set(next);
    writeJson(FOLLOWS_KEY, next);
  }

  /** Записывает результат проверки: серия не изменилась — только тик. */
  updateFollow(url: string, patch: Partial<FollowEntry>): void {
    const prev = this.follows()[url];
    if (!prev) return;
    const next = { ...this.follows(), [url]: { ...prev, ...patch, checkedAt: Date.now() } };
    this.follows.set(next);
    writeJson(FOLLOWS_KEY, next);
  }

  /** Снимает отслеживание со всех сериалов (кнопка «Очистить» во вкладке). */
  clearFollows(): void {
    this.follows.set({});
    writeJson(FOLLOWS_KEY, {});
  }

  /** Добавляет сообщение о новой серии в колокольчик (новые — сверху). */
  pushAlert(alert: Omit<AlertEntry, 'at' | 'read'>): void {
    // одна серия = одно сообщение: повторный приход той же серии затирает
    const next = [
      { ...alert, at: Date.now(), read: false },
      ...this.alerts().filter((a) => !(a.url === alert.url && a.text === alert.text)),
    ].slice(0, ALERTS_LIMIT);
    this.alerts.set(next);
    writeJson(ALERTS_KEY, next);
  }

  /** Панель колокольчика открыли — все сообщения прочитаны. */
  markAlertsRead(): void {
    if (!this.unreadCount()) return;
    this.alerts.update((list) => list.map((a) => (a.read ? a : { ...a, read: true })));
    writeJson(ALERTS_KEY, this.alerts());
  }

  clearAlerts(): void {
    this.alerts.set([]);
    writeJson(ALERTS_KEY, []);
  }

  toggleFavorite(item: MediaSummary): void {
    const exists = this.isFavorite(item.url);
    const next = exists
      ? this.favorites().filter((f) => f.url !== item.url)
      : [item, ...this.favorites()];
    this.favorites.set(next);
    writeJson(FAVORITES_KEY, next);
  }

  toggleLater(item: MediaSummary): void {
    const exists = this.isLater(item.url);
    const next = exists ? this.later().filter((l) => l.url !== item.url) : [item, ...this.later()];
    this.later.set(next);
    writeJson(LATER_KEY, next);
  }

  clearFavorites(): void {
    this.favorites.set([]);
    writeJson(FAVORITES_KEY, []);
  }

  clearLater(): void {
    this.later.set([]);
    writeJson(LATER_KEY, []);
  }

  summary(item: MediaSummary): MediaSummary {
    return {
      url: item.url,
      title: item.title,
      poster: item.poster,
      year: item.year,
      rating: item.rating,
      kind: item.kind,
      genres: item.genres,
      ribbon: item.ribbon,
      quality: item.quality,
      siteDate: item.siteDate,
      seasonsCount: item.seasonsCount,
      lastEpisode: item.lastEpisode,
      episodesCount: item.episodesCount,
    };
  }

  /**
   * Запись просмотра. Один и тот же фильм из разных источников (проверка
   * качества на других плеерах) — одна запись: старые url того же материала
   * выбрасываются, в истории остаётся свежий постер.
   */
  pushHistory(item: MediaSummary): void {
    const filtered = this.history().filter((h) => !sameMedia(h.item, item));
    const next: HistoryEntry[] = [{ item, watchedAt: Date.now() }, ...filtered].slice(
      0,
      HISTORY_LIMIT,
    );
    this.history.set(next);
    writeJson(HISTORY_KEY, next);
  }

  clearHistory(): void {
    this.history.set([]);
    writeJson(HISTORY_KEY, []);
  }

  /** Удаляет запись и все дубли того же материала с других источников. */
  removeHistory(url: string): void {
    const gone = this.history().find((h) => h.item.url === url)?.item;
    const next = this.history().filter(
      (h) => h.item.url !== url && (!gone || !sameMedia(h.item, gone)),
    );
    this.history.set(next);
    writeJson(HISTORY_KEY, next);
  }

  /** JSON snapshot of the whole library (favorites/later/history/progress). */
  exportBackup(): string {
    return JSON.stringify(
      {
        version: 1,
        favorites: this.favorites(),
        later: this.later(),
        history: this.history(),
        progress: this.progress(),
        ratings: this.ratings(),
        statuses: this.statuses(),
        follows: this.follows(),
        alerts: this.alerts(),
      },
      null,
      2,
    );
  }

  /** Replace the library with a JSON snapshot from {@link exportBackup}. */
  importBackup(json: string): void {
    const data = JSON.parse(json) as {
      favorites?: MediaSummary[];
      later?: MediaSummary[];
      history?: HistoryEntry[];
      progress?: Record<string, EpisodeProgress>;
      ratings?: Record<string, number>;
      statuses?: Record<string, WatchStatus>;
      follows?: Record<string, FollowEntry>;
      alerts?: AlertEntry[];
    };
    if (!data || typeof data !== 'object') throw new Error('Неверный формат файла');
    if (Array.isArray(data.favorites)) {
      this.favorites.set(data.favorites);
      writeJson(FAVORITES_KEY, data.favorites);
    }
    if (Array.isArray(data.later)) {
      this.later.set(data.later);
      writeJson(LATER_KEY, data.later);
    }
    if (Array.isArray(data.history)) {
      this.history.set(data.history);
      writeJson(HISTORY_KEY, data.history);
    }
    if (data.progress && typeof data.progress === 'object') {
      this.progress.set(data.progress);
      writeJson(PROGRESS_KEY, data.progress);
    }
    if (data.ratings && typeof data.ratings === 'object') {
      this.ratings.set(data.ratings);
      writeJson(RATING_KEY, data.ratings);
    }
    if (data.statuses && typeof data.statuses === 'object') {
      this.statuses.set(data.statuses);
      writeJson(STATUS_KEY, data.statuses);
    }
    if (data.follows && typeof data.follows === 'object') {
      this.follows.set(data.follows);
      writeJson(FOLLOWS_KEY, data.follows);
    }
    if (data.alerts && Array.isArray(data.alerts)) {
      this.alerts.set(data.alerts);
      writeJson(ALERTS_KEY, data.alerts);
    }
  }

  ratingFor(url: string): number | undefined {
    return url ? this.ratings()[url] : undefined;
  }

  /** value ≤ 0 или совпадение с текущей — снимает оценку. */
  setRating(url: string, value: number): void {
    if (!url) return;
    const next = { ...this.ratings() };
    if (value <= 0 || next[url] === value) delete next[url];
    else next[url] = Math.max(1, Math.min(10, Math.round(value)));
    this.ratings.set(next);
    writeJson(RATING_KEY, next);
  }

  statusFor(url: string): WatchStatus | undefined {
    return url ? this.statuses()[url] : undefined;
  }

  /** null или повтор того же статуса — снимает его. */
  setStatus(url: string, value: WatchStatus | null): void {
    if (!url) return;
    const next = { ...this.statuses() };
    if (value === null || next[url] === value) delete next[url];
    else next[url] = value;
    this.statuses.set(next);
    writeJson(STATUS_KEY, next);
  }

  getProgress(url: string): EpisodeProgress | undefined {
    return this.progress()[url];
  }

  progressFor(url: string): EpisodeProgress | undefined {
    return this.progress()[url];
  }

  /** Mark the remembered position as fully seen (hides the progress bar). */
  markWatched(url: string): void {
    const p = this.progress()[url];
    if (!p) return;
    const next = {
      ...this.progress(),
      [url]: {
        ...p,
        time: p.duration && p.duration > 0 ? p.duration : (p.time ?? 1),
        at: Date.now(),
      },
    };
    this.progress.set(next);
    writeJson(PROGRESS_KEY, next);
  }

  /** Forget the exact position, keep the last episode. */
  resetProgress(url: string): void {
    const p = this.progress()[url];
    if (!p) return;
    const next = { ...this.progress(), [url]: { ...p, time: 0, duration: 0, at: Date.now() } };
    this.progress.set(next);
    writeJson(PROGRESS_KEY, next);
  }

  /** 0–100 rounded; 0 when nothing meaningful is watched (barely started / finished). */
  watchedPercent(url: string): number {
    const p = this.progress()[url];
    if (!p?.time || !p.duration) return 0;
    const pct = p.time / p.duration;
    if (pct < 0.02 || pct >= 0.95) return 0;
    return Math.round(pct * 100);
  }

  /**
   * Есть на чём продолжать: позиция записана и просмотр не завершён.
   * Для записей без известной длительности (стримы, отдавшие только позицию)
   * процент не посчитать — такие записи тоже считаются продолжаемыми.
   */
  hasResume(url: string): boolean {
    const p = this.progress()[url];
    if (!p?.time || p.time < 5) return false;
    if (p.duration && p.duration > 0) {
      const pct = p.time / p.duration;
      return pct >= 0.02 && pct < 0.95;
    }
    return true;
  }

  /**
   * Records the episode a title was left on; with `time`/`duration` it also
   * records the exact playback position (throttled by the player itself).
   * Switching to another episode resets the position.
   */
  setProgress(
    url: string,
    season: number,
    episode: string,
    time?: number,
    duration?: number,
    tab?: string,
  ): void {
    const prev = this.progress()[url];
    const sameEpisode = !!prev && prev.season === season && prev.episode === episode;
    if (sameEpisode && time === undefined && tab === undefined) return; // nothing new to write
    const entry: EpisodeProgress = {
      season,
      episode,
      at: Date.now(),
      time: time ?? (sameEpisode ? (prev.time ?? 0) : 0),
      duration: duration ?? (sameEpisode ? (prev.duration ?? 0) : 0),
      tab: tab ?? (sameEpisode ? prev.tab : undefined),
    };
    let next: Record<string, EpisodeProgress> = { ...this.progress(), [url]: entry };
    const entries = Object.entries(next);
    if (entries.length > PROGRESS_LIMIT) {
      entries.sort((a, b) => b[1].at - a[1].at);
      next = Object.fromEntries(entries.slice(0, PROGRESS_LIMIT));
    }
    this.progress.set(next);
    writeJson(PROGRESS_KEY, next);
  }
}
