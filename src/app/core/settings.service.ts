import { effect, inject, Injectable, signal } from '@angular/core';
import { storageGet, storageSet } from './persistent-storage';

export type CardDensity = 'compact' | 'normal' | 'large';

export interface AppSettings {
  disabledSources: string[];
  /** User drag-and-drop order of source ids; empty = registry order. */
  sourceOrder: string[];
  density: CardDensity;
  homeTab: string;
  autoNext: boolean;
  historyEnabled: boolean;
  /** Ambient-подсветка: размытая копия кадра «подсвечивает» темноту вокруг сцены. */
  ambient: boolean;
  volume: number;
  muted: boolean;
  eqEnabled: boolean;
  eqGains: number[];
  /** Путь к папке с видеофайлами — локальный источник «Мои файлы». */
  localVideosPath: string;
}

const KEY = 'filmbox:settings';

const DEFAULTS: AppSettings = {
  disabledSources: [],
  sourceOrder: [],
  density: 'normal',
  homeTab: 'home',
  autoNext: true,
  historyEnabled: true,
  ambient: true,
  volume: 1,
  muted: false,
  eqEnabled: false,
  eqGains: [0, 0, 0, 0, 0],
  localVideosPath: '',
};

function readSettings(): AppSettings {
  try {
    const raw = storageGet(KEY);
    if (!raw) return { ...DEFAULTS };
    const merged = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    if (!Array.isArray(merged.sourceOrder)) merged.sourceOrder = [];
    else
      merged.sourceOrder = merged.sourceOrder.filter((id): id is string => typeof id === 'string');
    if (!Array.isArray(merged.eqGains) || merged.eqGains.length !== 5) {
      merged.eqGains = [...DEFAULTS.eqGains];
    } else {
      merged.eqGains = merged.eqGains.map((g) => {
        const n = Number(g);
        return Number.isFinite(n) ? Math.min(12, Math.max(-12, n)) : 0;
      });
    }
    const volume = Number(merged.volume);
    merged.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly state = signal<AppSettings>(readSettings());

  readonly settings = this.state.asReadonly();

  constructor() {
    effect(() => {
      const value = this.state();
      storageSet(KEY, JSON.stringify(value));
    });
  }

  static instance(): SettingsService {
    return inject(SettingsService);
  }

  get(): AppSettings {
    return this.state();
  }

  update(patch: Partial<AppSettings>): void {
    this.state.set({ ...this.state(), ...patch });
  }

  toggleSource(id: string): void {
    const disabled = new Set(this.state().disabledSources);
    if (disabled.has(id)) disabled.delete(id);
    else disabled.add(id);
    this.update({ disabledSources: [...disabled] });
  }

  /** Sorts ids by the user's drag order; unknown ids sink to the end, keeping their relative order. */
  orderedSourceIds(ids: string[]): string[] {
    const order = this.state().sourceOrder;
    if (!order.length) return ids;
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...ids].sort(
      (a, b) => (pos.get(a) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  reset(): void {
    this.state.set({ ...DEFAULTS });
  }
}
