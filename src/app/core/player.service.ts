import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { EmbedMenuGroup } from './electron-api';

export interface PlayerCapabilities {
  hasQuality: boolean;
  hasAudio: boolean;
  hasSubtitles: boolean;
  hasEmbedMenu: boolean;
}

@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly api = inject(ApiService);

  readonly embedGroups = signal<EmbedMenuGroup[]>([]);
  readonly capabilities = signal<PlayerCapabilities>({
    hasQuality: false,
    hasAudio: false,
    hasSubtitles: false,
    hasEmbedMenu: false,
  });

  private menuTimer: number | null = null;

  startMenuPolling(): void {
    this.stopMenuPolling();
    void this.refreshMenu();
    this.menuTimer = window.setInterval(() => void this.refreshMenu(), 3000);
  }

  stopMenuPolling(): void {
    if (this.menuTimer !== null) {
      window.clearInterval(this.menuTimer);
      this.menuTimer = null;
    }
  }

  /**
   * Пока пользователь выбирает в острове контролов (<select> в фокусе —
   * собственный список живёт ровно пока у него фокус), нельзя стучиться
   * в stage: скрипты stage-ctl выполняются внутри iframe и забирают на него
   * фокус (video.js/kinoserial при взаимодействии с меню), а это мгновенно
   * закрывает открытый список до сделанного выбора. Пауза — только для
   * фоновых вызовов (опрос state/menu); явные действия (pick, toggle, seek)
   * идут как есть.
   */
  isIslandBusy(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLSelectElement && el.closest('.controls-island') !== null;
  }

  async refreshMenu(force = false): Promise<void> {
    if (!force && this.isIslandBusy()) return; // фоновый опрос подождёт снятия фокуса
    const res = await this.api.stageCtl('menu').catch(() => null);
    if (res && 'groups' in res && res.groups.length) {
      this.applyGroups(this.filterGroups(res.groups), force);
    }
  }

  async pickMenuItem(group: string, label: string): Promise<void> {
    const res = await this.api.stageCtl('pick', { group, label }).catch(() => null);
    if (res && 'groups' in res && res.groups.length) {
      // pick приходит из change-события: список уже закрыт, применяем сразу
      this.applyGroups(this.filterGroups(res.groups), true);
    } else {
      await this.refreshMenu(true);
    }
  }

  private filterGroups(groups: EmbedMenuGroup[]): EmbedMenuGroup[] {
    // Скорость воспроизведения намеренно не выносится: стандартный набор
    // контролов острова — качество, озвучка, субтитры, сезон, серия.
    return groups.filter((g) =>
      /^(качеств|голос|озвуч|quality|voice|субтитр|subtitle|сезон|season|серия|episode)/i.test(
        g.name,
      ),
    );
  }

  private applyGroups(groups: EmbedMenuGroup[], force: boolean): void {
    if (!force && this.isIslandBusy()) return;
    if (PlayerService.sameGroups(this.embedGroups(), groups)) return;
    this.embedGroups.set(groups);
    this.updateCapabilities();
  }

  private static sameGroups(a: EmbedMenuGroup[], b: EmbedMenuGroup[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    return a.every((g, i) => {
      const h = b[i];
      return (
        g.name === h.name &&
        g.items.length === h.items.length &&
        g.items.every((item, j) => {
          const other = h.items[j];
          return item.label === other.label && !!item.active === !!other.active;
        })
      );
    });
  }

  private updateCapabilities(): void {
    const groups = this.embedGroups();
    this.capabilities.set({
      hasQuality: groups.some((g) => /качеств|quality/i.test(g.name)),
      hasAudio: groups.some((g) => /озвуч|voice|audio/i.test(g.name)),
      hasSubtitles: groups.some((g) => /субтитр|subtitle/i.test(g.name)),
      hasEmbedMenu: groups.length > 0,
    });
  }

  reset(): void {
    this.embedGroups.set([]);
    this.capabilities.set({
      hasQuality: false,
      hasAudio: false,
      hasSubtitles: false,
      hasEmbedMenu: false,
    });
  }
}
