import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Единая стилизованная заглушка постера, когда картинки нет (нет ссылки
 * или она отвалилась): тёмный киноплакатный градиент, плёнка-иконка и
 * красная нить FilmBox внизу. Один и тот же вид везде — карточки,
 * герой деталей, подсказки поиска.
 */
@Component({
  selector: 'app-poster-ph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ph">
      <svg
        class="ph-icon"
        viewBox="0 0 44 44"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="6.5" y="10.5" width="31" height="23" rx="3.5" />
        <path d="M14.5 10.5v23M29.5 10.5v23" />
        <path d="M9.5 15.5h2.5M9.5 22h2.5M9.5 28.5h2.5" />
        <path d="M32 15.5h2.5M32 22h2.5M32 28.5h2.5" />
      </svg>
      @if (label(); as text) {
        <span class="ph-text">{{ text }}</span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        aspect-ratio: 2 / 3;
        container-type: inline-size;
      }

      .ph {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: clamp(4px, 4cqw, 14px);
        width: 100%;
        height: 100%;
        padding: 7cqw;
        box-sizing: border-box;
        overflow: hidden;
        text-align: center;
        color: rgba(255, 255, 255, 0.42);
        background:
          linear-gradient(160deg, rgba(229, 9, 20, 0.16), transparent 46%),
          radial-gradient(120% 85% at 50% -8%, rgba(255, 255, 255, 0.07), transparent 62%),
          linear-gradient(180deg, #1a1a21, #12121a);
      }

      /* фирменная красная нить вдоль нижнего края — как в шапке */
      .ph::after {
        content: '';
        position: absolute;
        left: 10%;
        right: 10%;
        bottom: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, rgba(229, 9, 20, 0.85), transparent);
      }

      .ph-icon {
        width: clamp(22px, 38cqw, 76px);
        height: auto;
        flex-shrink: 0;
        opacity: 0.75;
      }

      .ph-text {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        max-width: 100%;
        font-size: clamp(10px, 7cqw, 16px);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: 0.02em;
        color: rgba(255, 255, 255, 0.62);
      }
    `,
  ],
})
export class PosterPhComponent {
  /** Название под иконкой; пусто — только иконка (для мелких превью). */
  readonly title = input('');

  readonly label = computed(() => this.title().trim());
}
