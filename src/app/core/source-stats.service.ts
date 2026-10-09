import { Injectable, signal } from '@angular/core';
import { storageGet, storageSet } from './persistent-storage';

const KEY = 'filmbox:srcstats';
/** Держим только самые свежие записи — хвост из давно забытых источников не нужен. */
const LIMIT = 40;

/** Сводка по источнику: сколько раз он реально отдавал рабочий плеер. */
export interface SourceStat {
  ok: number;
  fail: number;
  ts: number;
}

function readStats(): Record<string, SourceStat> {
  try {
    const raw = storageGet(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SourceStat>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Память о том, какой источник реально отдал плеер: «Смотреть» не должен
 * каждый раз начинать с заведомо нерабочей вкладки. Счёт живёт в общем
 * state-файле, пишется синхронно (как библиотека) и переживает перезапуск.
 */
@Injectable({ providedIn: 'root' })
export class SourceStatsService {
  private readonly state = signal<Record<string, SourceStat>>(readStats());

  /**
   * Доля успеха со сглаживанием Лапласа: неизвестный источник = 0.5,
   * безупречный → близко к 1, заведомо нерабочий → к 0. Равные счёты
   * не меняют порядок вкладок (стабильная сортировка).
   */
  score(id: string): number {
    const s = this.state()[id];
    if (!s) return 0.5;
    return (s.ok + 1) / (s.ok + s.fail + 2);
  }

  stat(id: string): SourceStat | null {
    return this.state()[id] ?? null;
  }

  /** «Надёжный» — подтверждённые успехи перевешивают сбои (нужно ≥2 удач). */
  isTrusted(id: string): boolean {
    const s = this.state()[id];
    return !!s && s.ok >= 2 && s.ok > s.fail;
  }

  noteOk(id: string): void {
    this.bump(id, 1, 0);
  }

  noteFail(id: string): void {
    this.bump(id, 0, 1);
  }

  private bump(id: string, ok: number, fail: number): void {
    const prev = this.state()[id];
    const next: SourceStat = {
      ok: (prev?.ok ?? 0) + ok,
      fail: (prev?.fail ?? 0) + fail,
      ts: Date.now(),
    };
    const merged = { ...this.state(), [id]: next };
    const keys = Object.keys(merged);
    if (keys.length > LIMIT) {
      keys.sort((a, b) => (merged[b].ts ?? 0) - (merged[a].ts ?? 0));
      for (const key of keys.slice(LIMIT)) delete merged[key];
    }
    this.state.set(merged);
    storageSet(KEY, JSON.stringify(merged));
  }
}
