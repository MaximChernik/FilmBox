import { Component } from '@angular/core';

@Component({
  selector: 'app-spinner',
  template: `<div class="spinner" role="status" aria-label="Загрузка"><span></span></div>`,
  styles: [
    `
      .spinner {
        display: flex;
        justify-content: center;
        padding: 48px 0;
      }
      .spinner span {
        width: 44px;
        height: 44px;
        border: 3px solid rgba(255, 255, 255, 0.1);
        border-top-color: var(--accent);
        border-right-color: rgba(229, 9, 20, 0.5);
        border-radius: 50%;
        box-shadow: 0 0 18px rgba(229, 9, 20, 0.25);
        animation: spin 0.75s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class SpinnerComponent {}
