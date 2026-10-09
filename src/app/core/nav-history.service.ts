import { Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Глубина внутриприложенной истории: сколько раз можно вернуться «назад»,
 * не вылетая из приложения. Каждый новый переход (push) увеличивает её,
 * popstate (history.back/forward) — уменьшает; стартовый NavigationEnd
 * не считается.
 */
@Injectable({ providedIn: 'root' })
export class NavHistoryService {
  private started = false;
  private pendingPops = 0;

  readonly depth = signal(0);

  /** popstate в полёте: компонент, создающийся сейчас, открывается «назад». */
  get openingBack(): boolean {
    return this.pendingPops > 0;
  }

  constructor() {
    const router = inject(Router);
    window.addEventListener('popstate', () => this.pendingPops++);
    router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        if (!this.started) {
          this.started = true;
          return;
        }
        if (this.pendingPops > 0) {
          this.pendingPops--;
          this.depth.update((d) => Math.max(0, d - 1));
        } else {
          this.depth.update((d) => d + 1);
        }
      });
  }

  /**
   * Вернуться на предыдущий открытый экран (с сохранением его состояния);
   * если назад нечего — вызвать fallback (переход «домой»).
   */
  back(fallback: () => void): void {
    if (this.depth() <= 0) {
      fallback();
      return;
    }
    const before = window.location.hash;
    const onPop = (): void => window.clearTimeout(timer);
    const timer = window.setTimeout(() => {
      window.removeEventListener('popstate', onPop);
      // адрес не сдвинулся — счётчик «врал», идём через fallback
      if (window.location.hash === before) {
        this.depth.update((d) => Math.max(0, d - 1));
        fallback();
      }
    }, 350);
    window.addEventListener('popstate', onPop, { once: true });
    window.history.back();
  }
}
