import { Injectable, signal } from '@angular/core';

/**
 * Shared-element анимация постера («увеличение постера при открытии»).
 *
 * Кликаем карточку в сетке → запоминаем URL материала и картинку. Каталог и
 * страница деталей по этому совпадению дают своему постеру одно и то же
 * `view-transition-name: poster-fly`, и браузер сам анимирует (FLIP): постер
 * вылетает из сетки и увеличивается в герой страницы. Обратная навигация
 * даёт зеркальное «уменьшение» обратно в карточку.
 *
 * Флаг живёт до следующего клика — он же гасит `view-transition-name` у
 * прошлой карточки, так что в одном снимке всегда только один «летящий»
 * постер (дубликат URL в одном представлении — единственная оговорка).
 */
@Injectable({ providedIn: 'root' })
export class PosterFlyService {
  /** URL материала, чей постер сейчас «летит»; null — анимации нет. */
  readonly url = signal<string | null>(null);
  /** Картинка со старой карточки: пока грузятся детали, показываем её. */
  readonly poster = signal<string | null>(null);

  arm(url: string, poster: string | null | undefined): void {
    this.url.set(url);
    this.poster.set(poster ?? null);
  }
}
