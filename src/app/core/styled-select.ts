/**
 * Собственные выпадающие списки для всех <select> приложения.
 *
 * Нативный popup рисует ОС (на Windows — системный список), почти не
 * подчиняется CSS и выбивается из тёмной темы, поэтому клик по селектору
 * перехватывается: список рисуется своим элементом в body — тёмная карточка
 * в стиле приложения.
 *
 * Фокус всё время остаётся на <select> — благодаря этому
 * PlayerService.isIslandBusy() по-прежнему приостанавливает фоновый stage-ctl,
 * пока пользователь выбирает пункт острова контролов (см. also mousedown
 * preventDefault: системный popup не успевает открыться).
 */

interface Handled {
  sel: HTMLSelectElement;
  t: number;
}

let installed = false;

export function installStyledSelects(): void {
  if (installed) return;
  installed = true;

  let pop: HTMLDivElement | null = null;
  let open: HTMLSelectElement | null = null;
  let items: HTMLDivElement[] = [];
  let activeIdx = -1;
  let byMousedown: Handled | null = null;
  let suppressClick: Handled | null = null;

  /** Флаг живёт до следующего mousedown: один клик может породить два click
   *  (label + активация на селекторе) — оба должны быть проигнорированы. */
  const fresh = (h: Handled | null, sel: HTMLSelectElement): boolean =>
    h !== null && h.sel === sel && Date.now() - h.t < 700;

  function close(): void {
    pop?.remove();
    pop = null;
    if (open) {
      open.setAttribute('aria-expanded', 'false');
      open = null;
    }
    items = [];
    activeIdx = -1;
  }

  /** Селектор, которому принадлежит событие: сам <select> или его <label>. */
  function relatedSelect(target: EventTarget | null): HTMLSelectElement | null {
    const el = target instanceof Element ? target : null;
    if (!el) return null;
    const direct = el.closest('select');
    if (direct instanceof HTMLSelectElement) return direct;
    const inLabel = el.closest('label')?.querySelector('select');
    return inLabel instanceof HTMLSelectElement ? inLabel : null;
  }

  function pick(sel: HTMLSelectElement, value: string): void {
    if (!sel.isConnected) return; // остров перерисовался — брать нечего
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setActive(i: number): void {
    if (!pop || !items.length) return;
    activeIdx = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((el, n) => el.classList.toggle('is-active', n === activeIdx));
    const el = items[activeIdx];
    const box = pop;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }

  /** Привязать popup к селектору: ширина, доступное место,.flip и координаты. */
  function place(box: HTMLDivElement, rect: DOMRect): void {
    box.style.minWidth = `${Math.ceil(rect.width)}px`;
    // полная высота содержимого (пункты не сжимаются — см. flex: none):
    // вмещаем весь список, если хватает места, иначе ограничиваем и скроллим.
    // maxHeight — border-box: равный needed отнял бы 2px бордюров и дал
    // «фейковый» скролл на коротких списках, поэтому ограничиваем только
    // реально не влезающее.
    const needed = box.scrollHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 14;
    const spaceAbove = rect.top - 14;
    const below = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    const avail = Math.max(96, Math.min(640, below ? spaceBelow : spaceAbove));
    box.style.maxHeight = needed <= avail ? '' : `${Math.floor(avail)}px`;
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let left = rect.left;
    if (left + bw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - bw - 8);
    const top = below ? rect.bottom + 6 : rect.top - 6 - bh;
    box.style.left = `${Math.round(Math.max(8, left))}px`;
    box.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function openPopup(sel: HTMLSelectElement): void {
    close();
    if (sel.disabled) return;
    open = sel;
    sel.focus(); // mousedown отменён — фокус ставим сами
    sel.setAttribute('aria-expanded', 'true');

    const box = document.createElement('div');
    box.className = 'sel-pop';
    box.setAttribute('role', 'listbox');
    items = [];
    let group: HTMLOptGroupElement | null = null;
    let selectedIdx = -1;

    for (const opt of Array.from(sel.options)) {
      const parent = opt.parentElement;
      if (parent instanceof HTMLOptGroupElement && parent !== group) {
        group = parent;
        const head = document.createElement('div');
        head.className = 'sel-pop-group';
        head.textContent = group.label;
        box.appendChild(head);
      }
      const item = document.createElement('div');
      item.className = 'sel-pop-item';
      item.setAttribute('role', 'option');
      item.textContent = (opt.label || opt.text).trim();
      if (opt.title) item.title = opt.title;
      if (opt.disabled) {
        item.classList.add('is-off');
      } else {
        if (opt.value === sel.value) {
          item.classList.add('is-sel');
          item.setAttribute('aria-selected', 'true');
          selectedIdx = items.length;
        }
        item.addEventListener('click', () => {
          pick(sel, opt.value);
          close();
          sel.focus();
        });
        item.addEventListener('mouseenter', () => setActive(items.indexOf(item)));
        items.push(item);
      }
      box.appendChild(item);
    }

    if (!items.length) {
      // пустой список — нечего показывать
      sel.setAttribute('aria-expanded', 'false');
      open = null;
      return;
    }

    pop = box;
    document.body.appendChild(box);
    place(box, sel.getBoundingClientRect());
    setActive(selectedIdx >= 0 ? selectedIdx : 0);

    // колесо над списком крутит только список, не страницу
    box.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  function reposition(): void {
    if (!pop || !open) return;
    if (!open.isConnected || open.disabled) {
      close();
      return;
    }
    place(pop, open.getBoundingClientRect());
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      const target = e.target;
      if (pop && target instanceof Node && pop.contains(target)) {
        e.preventDefault(); // не уводим фокус с <select>
        return;
      }
      const sel = relatedSelect(target);
      byMousedown = null;
      suppressClick = null;
      if (sel) {
        if (sel.disabled) return;
        e.preventDefault(); // системный popup не открываем, фокус не крадём
        byMousedown = { sel, t: Date.now() };
        if (open === sel) {
          close();
          suppressClick = byMousedown;
          byMousedown = null;
        } else {
          openPopup(sel); // внутри закрывает предыдущий список
        }
        return;
      }
      if (open) close();
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const sel = relatedSelect(e.target);
      if (!sel) return;
      if (fresh(byMousedown, sel) || fresh(suppressClick, sel)) return; // уже сделано на mousedown
      openPopup(sel); // активация без нашего mousedown (label/клавиатура)
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (open && pop) {
        if (!open.isConnected) {
          close();
          return;
        }
        switch (e.key) {
          case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
          case 'Tab':
            close();
            return;
          case 'ArrowDown':
            e.preventDefault();
            e.stopPropagation();
            setActive(activeIdx + 1);
            return;
          case 'ArrowUp':
            e.preventDefault();
            e.stopPropagation();
            setActive(activeIdx - 1);
            return;
          case 'Home':
            e.preventDefault();
            setActive(0);
            return;
          case 'End':
            e.preventDefault();
            setActive(items.length - 1);
            return;
          case 'Enter':
          case ' ':
            e.preventDefault();
            e.stopPropagation();
            items[activeIdx]?.click();
            return;
          default:
            return;
        }
      }
      // Alt+↓ / F4 — привычное открытие списка с клавиатуры
      const sel = document.activeElement;
      if (
        sel instanceof HTMLSelectElement &&
        !sel.disabled &&
        ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4')
      ) {
        e.preventDefault();
        openPopup(sel);
      }
    },
    true,
  );

  // страница живёт своей жизнью: скролл и resize перепривязывают список
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
}
