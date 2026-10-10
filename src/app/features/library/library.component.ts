import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { LibraryService } from '../../core/library.service';
import type { MediaSummary } from '../../core/models';
import { MediaCardComponent } from '../../shared/media-card/media-card.component';

type Tab = 'favorites' | 'later' | 'history' | 'follows';

@Component({
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
  imports: [RouterLink, MediaCardComponent],
})
export class LibraryComponent {
  private readonly router = inject(Router);
  readonly library = inject(LibraryService);

  readonly tab = signal<Tab>('favorites');

  readonly favorites = this.library.favorites;
  readonly later = this.library.later;
  readonly historyItems = computed(() => this.library.history().map((h) => h.item));
  /** Вкладка «Отслеживаю»: карточки отслеживаемых сериалов. */
  readonly follows = computed(() => Object.values(this.library.follows()).map((f) => f.item));

  readonly list = computed<MediaSummary[]>(() => {
    switch (this.tab()) {
      case 'later':
        return this.later();
      case 'follows':
        return this.follows();
      case 'history': {
        const items = this.historyItems();
        switch (this.historyFilter()) {
          case 'progress':
            return items.filter((i) => {
              const w = this.library.watchedPercent(i.url);
              return w > 0;
            });
          case 'fresh':
            return items.filter((i) => !this.library.progressFor(i.url)?.time);
          case 'done':
            return items.filter((i) => {
              const p = this.library.progressFor(i.url);
              return !!p?.time && !!p?.duration && p.time >= p.duration * 0.95;
            });
          default:
            return items;
        }
      }
      default:
        return this.favorites();
    }
  });

  readonly historyFilter = signal<'all' | 'progress' | 'fresh' | 'done'>('all');

  setHistoryFilter(v: 'all' | 'progress' | 'fresh' | 'done'): void {
    this.historyFilter.set(v);
  }

  readonly title = computed(() => {
    switch (this.tab()) {
      case 'later':
        return 'Смотреть позже';
      case 'history':
        return 'История просмотра';
      case 'follows':
        return 'Отслеживаю';
      default:
        return 'Избранное';
    }
  });

  readonly isEmpty = computed(() => !this.list().length);

  constructor() {
    this.syncTab();
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.syncTab());
  }

  private syncTab(): void {
    const url = this.router.url;
    const tab: Tab = url.startsWith('/later')
      ? 'later'
      : url.startsWith('/history')
        ? 'history'
        : url.startsWith('/follows')
          ? 'follows'
          : 'favorites';
    this.tab.set(tab);
  }

  clearCurrent(): void {
    switch (this.tab()) {
      case 'later':
        this.library.clearLater();
        break;
      case 'history':
        this.library.clearHistory();
        break;
      case 'follows':
        this.library.clearFollows();
        break;
      default:
        this.library.clearFavorites();
    }
  }

  removeItem(item: MediaSummary): void {
    if (this.tab() === 'history') this.library.removeHistory(item.url);
  }

  /** Arrow-key navigation between cards in the grid. */
  onGridKeydown(event: KeyboardEvent): void {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.getAttribute('tabindex') !== '0') return;
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.page-grid [tabindex="0"]'));
    const i = cards.indexOf(active);
    if (i < 0) return;
    const grid = document.querySelector<HTMLElement>('.page-grid');
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1 : 1;
    let next = i;
    switch (event.key) {
      case 'ArrowRight':
        next = i + 1;
        break;
      case 'ArrowLeft':
        next = i - 1;
        break;
      case 'ArrowDown':
        next = i + cols;
        break;
      case 'ArrowUp':
        next = i - cols;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cards.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    cards[Math.min(Math.max(next, 0), cards.length - 1)]?.focus();
  }
}
