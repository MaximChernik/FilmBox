/**
 * Токен цикла сброса прокрутки после навигации (см. resetScrollOnNavigation
 * в app): раздел может восстановить свою позицию после «назад» — тогда
 * сброс глушится, и guard-опрос больше не возвращает страницу к верху.
 */
let token = 0;

/** Начать новый цикл сброса — вернуть его токен. */
export function beginScrollReset(): number {
  return ++token;
}

/** `true`, пока цикл `t` ещё активен. */
export function isScrollResetActive(t: number): boolean {
  return t === token;
}

/** Отменить текущий сброс (восстановление позиции разделом после «назад»). */
export function cancelScrollReset(): void {
  token++;
}
