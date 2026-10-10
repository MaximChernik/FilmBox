import { Component, input } from '@angular/core';

/** 15px line icons for the header navigation. */
@Component({
  selector: 'app-nav-icon',
  styles: [
    `
      :host {
        display: inline-flex;
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        margin-right: 2px;
      }
      svg {
        width: 100%;
        height: 100%;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `,
  ],
  template: `
    @switch (name()) {
      @case ('home') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 7.4 8 2.6l5.5 4.8" />
          <path d="M4.4 6.6V13a.5.5 0 0 0 .5.5h6.2a.5.5 0 0 0 .5-.5V6.6" />
        </svg>
      }
      @case ('new') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2 9.3 6.7 14 8l-4.7 1.3L8 14l-1.3-4.7L2 8l4.7-1.3z" />
        </svg>
      }
      @case ('films') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.4" y="3" width="11.2" height="10" rx="1.5" />
          <path d="M6 3v10M10 3v10" />
        </svg>
      }
      @case ('serials') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="3.4" width="12" height="8" rx="1.5" />
          <path d="M6 13.4h4M8 11.4v2" />
        </svg>
      }
      @case ('local') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.2 12.6V4.2a.7.7 0 0 1 .7-.7h2.6l1.4 1.7h6.2a.7.7 0 0 1 .7.7v6.7a.7.7 0 0 1-.7.7H2.9a.7.7 0 0 1-.7-.7z"
          />
        </svg>
      }
      @case ('recs') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.75" />
          <path d="m10.6 5.4-1.4 4.2-4.2 1.4 1.4-4.2z" />
        </svg>
      }
      @case ('favorites') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 13.2C5 11 2.8 9.1 2.8 6.7A2.7 2.7 0 0 1 8 5.3a2.7 2.7 0 0 1 5.2 1.4c0 2.4-2.2 4.3-5.2 6.5z"
          />
        </svg>
      }
      @case ('later') {
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.8 13.6 8 10.9l-3.8 2.7V3.9c0-.5.4-.9.9-.9h5.8c.5 0 .9.4.9.9z" />
        </svg>
      }
    }
  `,
})
export class NavIconComponent {
  readonly name = input.required<string>();
}
