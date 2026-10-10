import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { LibraryService } from './library.service';

/** Период проверки отслеживаемых сериалов: раз в 45 минут. */
const CHECK_INTERVAL_MS = 45 * 60 * 1000;
/** Первый прогон — через 5 минут после старта (даём источниковому ресурсу прогреться). */
const FIRST_CHECK_MS = 5 * 60 * 1000;
/** Пауза между запросами деталей, чтобы не бить по источнику пачкой. */
const GAP_MS = 1200;

/**
 * Слежение за новыми сериями: периодически перечитывает детали отслеживаемых
 * сериалов и при изменении `lastEpisode`/`seasonsCount` шлёт системное
 * уведомление (Windows Notification через IPC `app:notify`).
 */
@Injectable({ providedIn: 'root' })
export class FollowCheckService {
  private readonly api = inject(ApiService);
  private readonly library = inject(LibraryService);

  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Map<string, { lastEpisode?: string; seasonsCount?: string }>();
  private running = false;

  /** Запускает периодическую проверку (идемпотентно; вне Electron — no-op). */
  start(): void {
    if (this.timer || !this.api.isElectron) return;
    this.timer = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.checkNow(), FIRST_CHECK_MS);
  }

  /** Прогон по всем отслеживаемым (может зваться вручную из настроек). */
  async checkNow(): Promise<void> {
    if (this.running) return;
    const entries = Object.entries(this.library.follows());
    if (!entries.length) return;
    this.running = true;
    try {
      for (const [url, entry] of entries) {
        // первый уход в цикл: запоминаем базовые значения без уведомления
        const base = this.seen.get(url) ?? {
          lastEpisode: entry.lastEpisode,
          seasonsCount: entry.seasonsCount,
        };
        this.seen.set(url, base);
        try {
          const d = await this.api.loadDetails(url);
          this.handle(url, base, d.lastEpisode, d.seasonsCount, d.title);
        } catch {
          // источник недоступен — пропускаем, следующий тик попробует снова
        }
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    } finally {
      this.running = false;
    }
  }

  private handle(
    url: string,
    base: { lastEpisode?: string; seasonsCount?: string },
    lastEpisode: string | undefined,
    seasonsCount: string | undefined,
    title: string,
  ): void {
    const episodeChanged = !!lastEpisode && lastEpisode !== base.lastEpisode;
    const seasonChanged = !!seasonsCount && seasonsCount !== base.seasonsCount;
    if (episodeChanged || seasonChanged) {
      const what = seasonChanged && !episodeChanged ? `сезон ${seasonsCount}` : lastEpisode;
      void this.api.notify(`Новая серия: «${title}» — ${what}`).catch(() => undefined);
    }
    this.seen.set(url, { lastEpisode: lastEpisode ?? base.lastEpisode, seasonsCount });
    this.library.updateFollow(url, {
      lastEpisode: lastEpisode ?? base.lastEpisode,
      seasonsCount,
    });
  }
}
