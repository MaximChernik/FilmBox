import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { LibraryService } from '../../core/library.service';
import { PosterFlyService } from '../../core/poster-fly.service';
import type { MediaSummary } from '../../core/models';
import { TitleTipDirective } from '../title-tip.directive';
import { PosterPhComponent } from '../poster-ph.component';

/** «1 сезон», «2 сезона», «5 сезонов». */
function pluralSeasons(n: number): string {
  const tens = Math.abs(n) % 100;
  const ones = tens % 10;
  if (tens > 10 && tens < 20) return `${n} сезонов`;
  if (ones > 1 && ones < 5) return `${n} сезона`;
  if (ones === 1) return `${n} сезон`;
  return `${n} сезонов`;
}

/** «1 серия», «2 серии», «5 серий». */
function pluralEpisodes(n: number): string {
  const tens = Math.abs(n) % 100;
  const ones = tens % 10;
  if (tens > 10 && tens < 20) return `${n} серий`;
  if (ones > 1 && ones < 5) return `${n} серии`;
  if (ones === 1) return `${n} серия`;
  return `${n} серий`;
}

@Component({
  selector: 'app-media-card',
  templateUrl: './media-card.component.html',
  styleUrl: './media-card.component.scss',
  imports: [TitleTipDirective, PosterPhComponent],
  /* Отдельная стратегия на каждую карточку: при сотнях карточек в сетке
     обычный CD пересчитывал шаблоны всех карточек на каждое событие
     (скролл, наведение) — основная причина тормозов при большой загрузке. */
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaCardComponent {
  readonly item = input.required<MediaSummary>();
  /** Show a "remove" button (e.g. delete a single history entry). */
  readonly removable = input(false);
  readonly remove = output<void>();

  private readonly router = inject(Router);
  readonly library = inject(LibraryService);
  private readonly fly = inject(PosterFlyService);

  /**
   * Этот постер сейчас «летит» в страницу деталей — получает
   * `view-transition-name: poster-fly` (уникальный: флаг один на всё приложение).
   */
  readonly flying = computed(() => this.fly.url() === this.item().url);

  readonly posterBroken = signal(false);
  /** Постер отрисован (или не появится) — шиммер скелета можно выключать. */
  readonly posterLoaded = signal(false);
  readonly imgReady = computed(
    () => this.posterLoaded() || this.posterBroken() || !this.item().poster,
  );
  /** Короткая плашка качества: «FHD (1080p)» → «1080p», «4K UHD» → «4K». */
  readonly badgeQuality = computed(() => {
    const q = this.item().quality;
    if (!q) return '';
    if (/\b4k\b|2160/i.test(q)) return '4K';
    const m = q.match(/(\d{3,4})\s*p/i);
    return m ? `${m[1]}p` : q;
  });
  readonly isFavorite = computed(() => this.library.isFavorite(this.item().url));
  readonly isLater = computed(() => this.library.isLater(this.item().url));
  /** 0–100: watched part of the last episode (0 hides the bar) */
  readonly watched = computed(() => this.library.watchedPercent(this.item().url));
  /** Есть на чём продолжать (в т.ч. без известной длительности — бар скрыт, точка есть). */
  readonly hasResume = computed(() => this.library.hasResume(this.item().url));
  /** Собственная оценка пользователя (1–10) — золотым бейджем в истории просмотра. */
  readonly myRating = computed(() => this.library.ratingFor(this.item().url));
  readonly watchedText = computed(() => {
    const p = this.library.progressFor(this.item().url);
    if (!p?.time) return null;
    const f = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    // длительность неизвестна — показываем только запомненную точку
    if (!p.duration) return f(p.time);
    return `${f(p.time)} / ${f(p.duration)}`;
  });
  /** Прогресс (позиция/длительность) — computed, а не вызов функции в шаблоне. */
  readonly progress = computed(() => this.library.progressFor(this.item().url));

  /**
   * «2 сезона · 24 серии» for the meta line — skipped while the ribbon badge
   * already carries the same words (kinogo puts them on the poster).
   * `episodesCount` (a merged series card) beats `lastEpisode` (the number
   * of the latest episode) when both are set.
   */
  readonly seasonsMeta = computed(() => {
    const item = this.item();
    const ribbon = (item.ribbon ?? '').toLowerCase();
    const parts: string[] = [];
    const seasons = Number(item.seasonsCount);
    if (item.seasonsCount && !ribbon.includes(`${item.seasonsCount} сезон`)) {
      parts.push(Number.isFinite(seasons) ? pluralSeasons(seasons) : item.seasonsCount);
    }
    const episodesRaw = item.episodesCount ?? item.lastEpisode;
    const episodes = Number(episodesRaw);
    if (episodesRaw && !ribbon.includes(`${episodesRaw} серия`)) {
      parts.push(Number.isFinite(episodes) ? pluralEpisodes(episodes) : episodesRaw);
    }
    return parts.join(' · ');
  });

  open(): void {
    /* запоминаем постер ДО навигации: старый снимок view-transition должен
       захватить карточку уже с view-transition-name */
    this.fly.arm(this.item().url, this.item().poster);
    void this.router.navigate(['/details'], { queryParams: { u: this.item().url } });
  }

  onPosterError(): void {
    this.posterBroken.set(true);
  }

  toggleFavorite(event: Event): void {
    event.stopPropagation();
    this.library.toggleFavorite(this.library.summary(this.item()));
  }

  toggleLater(event: Event): void {
    event.stopPropagation();
    this.library.toggleLater(this.library.summary(this.item()));
  }

  removeItem(event: Event): void {
    event.stopPropagation();
    this.remove.emit();
  }

  markWatched(event: Event): void {
    event.stopPropagation();
    this.library.markWatched(this.item().url);
  }

  resetProgress(event: Event): void {
    event.stopPropagation();
    this.library.resetProgress(this.item().url);
  }
}
