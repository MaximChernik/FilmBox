import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';

/**
 * Кастомный тултип с полным текстом: появляется над элементом при наведении.
 * Нативный `title` не используется — он не стилизуется и медленно всплывает.
 * Узел создаётся в document.body, поэтому не обрезается overflow'ом карточек
 * и не зависит от порядка наложения слоёв в сетке.
 */
@Directive({
  selector: '[appTitleTip]',
  standalone: true,
})
export class TitleTipDirective {
  /** Полный текст, который нужно показать в тултипе. */
  readonly appTitleTip = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private node: HTMLDivElement | null = null;
  private readonly dismiss = () => this.hide();

  @HostListener('mouseenter')
  show(): void {
    const text = this.appTitleTip()?.trim();
    this.hide();
    if (!text) return;

    const node = document.createElement('div');
    node.className = 'title-tip';
    node.setAttribute('role', 'tooltip');
    node.textContent = text;
    document.body.appendChild(node);

    const r = this.host.nativeElement.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    /* центр над элементом, но не вылезая за края окна */
    const left = Math.min(Math.max(r.left + r.width / 2, w / 2 + 8), window.innerWidth - w / 2 - 8);
    /* сверху; если там не помещается — под элементом */
    let top = r.top - 10 - h;
    if (top < 8) top = r.bottom + 10;
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;

    this.node = node;
    requestAnimationFrame(() => node.classList.add('show'));
    window.addEventListener('scroll', this.dismiss, true);
    window.addEventListener('resize', this.dismiss);
  }

  @HostListener('mouseleave')
  @HostListener('mousedown')
  hide(): void {
    if (this.node) {
      this.node.remove();
      this.node = null;
    }
    window.removeEventListener('scroll', this.dismiss, true);
    window.removeEventListener('resize', this.dismiss);
  }
}
