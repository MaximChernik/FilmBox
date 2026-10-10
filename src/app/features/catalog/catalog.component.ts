import { Component, computed, DestroyRef, effect, inject, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationStart, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { LibraryService } from '../../core/library.service';
import { NavHistoryService } from '../../core/nav-history.service';
import { cancelScrollReset } from '../../core/scroll-reset';
import { SettingsService } from '../../core/settings.service';
import type { Category, MediaSummary, PagedResult, SourceInfo } from '../../core/models';
import { MediaCardComponent } from '../../shared/media-card/media-card.component';
import {
  type CatalogFilterState,
  filterItems,
  hasActiveFilters,
  KIND_OPTIONS,
  mergeUnique,
  normFilter,
  PRESET_GENRES,
  RATING_OPTIONS,
  SORT_OPTIONS,
  sortItems,
  sortNewest,
  type SortId,
  yearNum,
} from './catalog-items.model';

/** Снимок вида раздела в history.state его записи — для «назад» без потерь. */
interface CatalogViewState {
  /** `cat:<id>` или `search:<q>` — снимок применим только к своему разделу. */
  key: string;
  scroll: number;
  items: MediaSummary[];
  page: number;
  hasMore: boolean;
  title: string;
  categoryId: string;
  searchQuery: string;
  filters: CatalogFilterState;
  sort: SortId;
}

/**
 * Последний ушедший вид каталога. Angular при pop-навигации переписывает
 * history.state ({navigationId}) и снапшот в записи теряется — слот хранит
 * его независимо; свежий вход в раздел мимо «назад» снимок не применяет.
 */
let lastCatalogView: CatalogViewState | null = null;

/** Углы поворота дайса по трём осям (в градусах). */
interface DiceAngles {
  x: number;
  y: number;
  z: number;
}

const DICE_AXES = ['x', 'y', 'z'] as const;

/**
 * Случайный «бросок»: 1–3 оси (каждая выбирается с вероятностью 60%,
 * но не меньше одной) и 1–3 полного оборота по каждой со случайным знаком.
 * Все приращения кратны 360°, поэтому в покое кубик всегда лежит строго
 * фронтально, а плоскость вращения у каждого броска своя.
 */
function spinDice(cur: DiceAngles): DiceAngles {
  const axes = DICE_AXES.filter(() => Math.random() < 0.6);
  if (!axes.length) axes.push(DICE_AXES[Math.floor(Math.random() * DICE_AXES.length)]);
  const next: DiceAngles = { ...cur };
  for (const ax of axes) {
    const turns = 1 + Math.floor(Math.random() * 3);
    const sign = Math.random() < 0.5 ? -1 : 1;
    next[ax] += sign * turns * 360;
  }
  /* теоретически возможный «пустой» бросок (все оси пропущены) — форсируем */
  if (next.x === cur.x && next.y === cur.y && next.z === cur.z) next.x += 360;
  return next;
}

@Component({
  templateUrl: './catalog.component.html',
  styleUrl: './catalog.component.scss',
  imports: [RouterLink, MediaCardComponent],
})
export class CatalogComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly settings = inject(SettingsService);
  private readonly library = inject(LibraryService);

  private readonly routeParam = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private readonly queryParam = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly isSearch = !!this.route.snapshot.data['search'];
  private readonly defaultCategory = (this.route.snapshot.data['category'] as string) ?? 'home';

  readonly items = signal<MediaSummary[]>([]);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly categories = signal<Category[]>([]);
  readonly categoryId = signal('home');
  readonly searchQuery = signal('');

  /**
   * Заголовок раздела — реактивный: категории приходят из `sources:list`
   * асинхронно, поэтому императивный `title.set()` в openCategory()
   * оставлял старый текст (переход с «Главной» в другой раздел показывал
   * прежний заголовок). computed пересчитывается сам, когда чипсы догрузились.
   */
  readonly title = computed(() => {
    if (this.isSearch) {
      const q = this.searchQuery();
      return q ? `Поиск: «${q}»` : 'Поиск';
    }
    return this.categories().find((c) => c.id === this.categoryId())?.title ?? 'Каталог';
  });

  readonly filterKind = signal('');
  readonly filterGenre = signal('');
  readonly filterYearFrom = signal('');
  readonly filterYearTo = signal('');
  readonly filterRating = signal('');
  readonly filterQuality = signal('');

  /** Панель фильтров прилипла к хедеру — тогда у неё срезаны верхние углы. */
  readonly filtersStuck = signal(false);
  private readonly filtersPanel = viewChild<ElementRef<HTMLElement>>('filtersPanel');

  readonly sort = signal<SortId>('default');
  readonly sortOptions = SORT_OPTIONS;

  readonly kindOptions = KIND_OPTIONS;
  readonly ratingOptions = RATING_OPTIONS;

  /**
   * Curated preset list only: merging item genres (old behavior) duplicated
   * every option, because sources spell the same genre differently
   * («Драма»/«Драмы»). A value restored from the URL that is no longer a
   * preset stays in the list — otherwise the select would render blank while
   * that filter is active.
   */
  readonly genreOptions = computed(() => {
    const list = [...PRESET_GENRES];
    const active = this.filterGenre();
    if (active && !list.some((genre) => normFilter(genre) === normFilter(active))) {
      list.push(active);
    }
    return list.sort((a, b) => a.localeCompare(b, 'ru'));
  });

  readonly filterState = computed<CatalogFilterState>(() => ({
    kind: this.filterKind(),
    genre: this.filterGenre(),
    yearFrom: this.filterYearFrom(),
    yearTo: this.filterYearTo(),
    rating: this.filterRating(),
    quality: this.filterQuality(),
  }));

  readonly hasFilters = computed(() => hasActiveFilters(this.filterState()));

  readonly filteredItems = computed(() => filterItems(this.items(), this.filterState()));

  readonly sortedItems = computed(() => {
    const items = this.filteredItems();
    const mode = this.sort();
    // «Новинки» sorts by production year, then by the source's update date
    if (mode === 'default' && !this.isSearch && this.categoryId() === 'new') {
      // Источники кладут в «Новинки» и старые перезаливы (перечислены заново).
      // Карточки с известным годом старше двух лет отсекаем — новые релизы
      // сортируются по году, безгодовые всплывут после гидратации года.
      const cutoff = new Date().getFullYear() - 2;
      return sortNewest(items.filter((item) => (yearNum(item) ?? cutoff) >= cutoff));
    }
    return sortItems(items, mode);
  });

  /**
   * Полка «Продолжить просмотр» на главной: незавершённые просмотры из
   * истории (прогресс-бар карточки заполнится автоматически).
   */
  readonly continueItems = computed(() => {
    if (this.categoryId() !== 'home' || this.isSearch) return [];
    return this.library
      .history()
      .filter((h) => this.library.hasResume(h.item.url))
      .slice(0, 12)
      .map((h) => h.item);
  });

  /** Меню жанров у кнопки кубика (выпадает по ▾). */
  readonly diceMenuOpen = signal(false);

  /** Выбор жанра в меню кубика: '' — совсем любой, иначе конкретный жанр. */
  pickDiceGenre(genre: string): void {
    this.diceMenuOpen.set(false);
    this.randomFilmRoll(genre);
  }

  /**
   * Первый шаг клавиатурной навигации: стрелка при неустановленном фокусе
   * (только что открыли страницу) ставит фокус на первую карточку сетки —
   * дальше стрелки работают через (keydown) самой сетки. Меню кубика при
   * этом закрывается по Esc.
   */
  private readonly onGridEntry = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (this.diceMenuOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.diceMenuOpen.set(false);
      }
      return;
    }
    if (!e.key.startsWith('Arrow')) return;
    // открыт попап кастомного селекта — там своя навигация
    if (document.querySelector('.sel-pop')) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable)
      return;
    // фокус нигде конкретно — только тогда занимаем страницу стрелкой
    if (target && target !== document.body && tag !== 'MAIN') return;
    const first = document.querySelector<HTMLElement>('.page-grid [tabindex="0"]');
    if (!first) return;
    e.preventDefault();
    first.focus();
  };

  /**
   * «Дайс»: кидаем кубик и открываем случайный фильм всего каталога.
   * genre — переопределение жанра из меню (undefined — жанр берётся из
   * активных фильтров, как при обычном клике).
   */
  randomFilmRoll(genre?: string): void {
    if (this.diceBusy) return;
    // фолбэк-пул тоже учитывает жанр, выбранный в меню кубика
    const fallbackState: CatalogFilterState =
      genre !== undefined ? { ...this.filterState(), genre } : this.filterState();
    const loaded = filterItems(this.sortedItems(), fallbackState);
    this.diceBusy = true;
    this.diceRoll.update(spinDice);
    // кубик крутится вхолостую, пока идёт сбор пула по каталогу
    this.diceSpin = setInterval(() => this.diceRoll.update(spinDice), 560);
    void this.pickRandomFromCatalog(genre)
      .catch(() => null)
      .then((pick) => {
        clearInterval(this.diceSpin);
        this.diceSpin = undefined;
        this.diceBusy = false;
        // фолбэк — привычный выбор из уже загруженных карточек
        const target =
          pick ?? (loaded.length ? loaded[Math.floor(Math.random() * loaded.length)] : null);
        if (!target) return;
        void this.router.navigate(['/details'], { queryParams: { u: target.url } });
      });
  }

  /**
   * Случайный просмотрщик каталога: шесть связок «источник → случайная
   * категория → случайная глубокая страница» запрашиваются параллельно,
   * из ответов собирается пул (дедуп по url) и выбирается один фильм.
   */
  private async pickRandomFromCatalog(genre?: string): Promise<MediaSummary | null> {
    // «Локальные» — отдельный раздел с файлами, в общий пул не мешаем
    const ids = new Set(this.activeSourceIds().filter((id) => id !== 'local'));
    const sources = this.sourceList.filter((s) => ids.has(s.id));
    if (!sources.length) return null;

    // выбор жанра в меню кубика перекрывает жанр из фильтров на этот бросок
    const state: CatalogFilterState =
      genre !== undefined ? { ...this.filterState(), genre } : this.filterState();

    const shuffled = [...sources].sort(() => Math.random() - 0.5);
    const jobs = shuffled.slice(0, 6).map((s) => {
      // home — витрина последних добавлений, а не весь каталог; скрытые
      // разделы (мультфильмы/аниме) в кубик не попадают — их убрал пользователь
      const cats = s.categories.filter(
        (c) => c.id !== 'home' && c.id !== 'cartoons' && c.id !== 'anime' && c.id !== 'local',
      );
      const cat = cats.length ? cats[Math.floor(Math.random() * cats.length)] : undefined;
      return {
        sourceId: s.id,
        categoryId: cat?.id,
        page: 1 + Math.floor(Math.random() * 120),
        filters: state,
      };
    });

    const pool: MediaSummary[] = [];
    const seen = new Set<string>();
    // не ждём всех источников: как только набралось достаточно карточек (или
    // все ответили) — идём выбирать, зависший источник кубик не тормозит
    await new Promise<void>((resolvePool) => {
      let left = jobs.length;
      const done = (): void => {
        left -= 1;
        if (left <= 0 || pool.length >= 48) resolvePool();
      };
      for (const job of jobs) {
        this.fetchRandomPage(job)
          .then((items) => {
            for (const item of items) {
              if (!item.url || seen.has(item.url)) continue;
              seen.add(item.url);
              pool.push(item);
            }
          })
          .catch(() => undefined)
          .finally(done);
      }
    });
    // жанр/тип/год уже применены на стороне источника; рейтинг и качество —
    // локальные фильтры, добираем их тут же через общий filterItems
    const list = filterItems(pool, state);
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  /**
   * Страница за глубиной каталога возвращает пусто — уменьшаем номер вдвое
   * и пробуем снова, чтобы попасть в реальную глубину источника.
   */
  private async fetchRandomPage(job: {
    sourceId: string;
    page: number;
    categoryId?: string;
    filters: CatalogFilterState;
  }): Promise<MediaSummary[]> {
    let page = job.page;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await this.api.loadCatalog({
          sourceId: job.sourceId,
          page,
          categoryId: job.categoryId,
          filters: job.filters,
          probe: true,
        });
        if (res.items.length) return res.items;
      } catch {
        // DLE-источники на странице за глубиной отвечают 404 — то же самое,
        // что пустая страница: уменьшаем номер и пробуем ближе к началу
      }
      if (page <= 2) return [];
      page = Math.max(1, Math.floor(page / 2));
    }
    return [];
  }

  /**
   * Текущий угол дайса. Кратность 360° гарантирует строго фронтальное
   * положение в покое — «случайность» живёт только в приращениях spinDice().
   */
  readonly diceRoll = signal<DiceAngles>({ x: 0, y: 0, z: 0 });

  /** Инлайн-transform для биндинга: rotateX() rotateY() rotateZ(). */
  readonly diceTransform = computed(() => {
    const a = this.diceRoll();
    return `rotateX(${a.x}deg) rotateY(${a.y}deg) rotateZ(${a.z}deg)`;
  });

  /**
   * Шесть граней объёмного дайса (противоположные дают 7). Точки — координаты
   * в системе 20×20; стороны кубика 20px, поэтому глубина = 10px (см. SCSS).
   */
  readonly diceFaces: ReadonlyArray<{ cls: string; pips: ReadonlyArray<[number, number]> }> = [
    { cls: 'f-front', pips: [[10, 10]] },
    {
      cls: 'f-back',
      pips: [
        [6.5, 6],
        [6.5, 10],
        [6.5, 14],
        [13.5, 6],
        [13.5, 10],
        [13.5, 14],
      ],
    },
    {
      cls: 'f-right',
      pips: [
        [6.5, 6.5],
        [10, 10],
        [13.5, 13.5],
      ],
    },
    {
      cls: 'f-left',
      pips: [
        [6.5, 6.5],
        [13.5, 6.5],
        [6.5, 13.5],
        [13.5, 13.5],
      ],
    },
    {
      cls: 'f-top',
      pips: [
        [6.5, 6.5],
        [13.5, 13.5],
      ],
    },
    {
      cls: 'f-bottom',
      pips: [
        [6.5, 6.5],
        [13.5, 6.5],
        [6.5, 13.5],
        [13.5, 13.5],
        [10, 10],
      ],
    },
  ];

  onSort(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as SortId;
    this.sort.set(mode);
    void this.deepenForSort();
  }

  /** Токен отмены фонового углубления пула при смене сортировки/раздела. */
  private deepenSeq = 0;

  /**
   * Сортировка работает по загруженному пулу, а изначально это одна страница
   * с каждого источника — «Название: А-Я» на такой выборке бессмысленно.
   * При выборе сортировки в фоне дотягиваем несколько страниц (с отменой,
   * если сортировку сменили или раздел ушёл), чтобы порядок решался по
   * большему пулу, а не по первому экрану.
   */
  private async deepenForSort(): Promise<void> {
    const seq = ++this.deepenSeq;
    if (this.sort() === 'default' || this.isSearch) return;
    for (let round = 0, waited = 0; round < 6; round++) {
      if (seq !== this.deepenSeq || !this.hasMore() || this.error()) return;
      if (this.loading()) {
        // идёт чужая загрузка — ждём её конца, не сжигая раунды вхолостую
        if (++waited > 100) return; // ~15 с тишины — выходим, не зависаем
        await new Promise((r) => setTimeout(r, 150));
        round--;
        continue;
      }
      waited = 0;
      await this.loadMore();
    }
  }

  /**
   * При выбранном жанре карточки без жанров не проходят фильтр («неизвестно»
   * ≠ «подходит») — гидратируем их деталями (кэш ApiService, 60 с): сетка
   * сужается сразу и уточняется по мере ответов — совпавшие источники
   * доезжают, остальные остаются скрытыми.
   */
  private async hydrateGenres(): Promise<void> {
    const missing = this.items()
      .filter((item) => !item.genres?.length && !this.genresTried.has(item.url))
      .slice(0, 40);
    if (!missing.length) return;
    for (const item of missing) this.genresTried.add(item.url);
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.allSettled(
        missing.slice(i, i + 8).map(async (item) => {
          try {
            const details = await this.api.loadDetails(item.url);
            const genres = details.genres?.length ? details.genres : undefined;
            if (!genres) return;
            this.items.update((list) =>
              list.map((it) => (it.url === item.url ? { ...it, genres } : it)),
            );
          } catch {
            // без жанров карточка остаётся вне выборки — это честный итог
          }
        }),
      );
      if (!this.filterGenre()) return; // фильтр сняли — трафик не тратим
    }
  }

  /** url'ы, по которым год уже запрашивали (даже если источник его не дал). */
  private readonly yearsTried = new Set<string>();

  /**
   * В «Новинках» карточки часто идут без года — сортировка по году для них
   * бесполезна, а фильтр старых перезаливов их пропускает. Гидратируем год
   * деталями (кэш ApiService, 60 с): сетка сразу показывает то, что уже
   * известно, и уточняется по мере ответов.
   */
  private async hydrateYears(): Promise<void> {
    const missing = this.items()
      .filter((item) => !item.year && !this.yearsTried.has(item.url))
      .slice(0, 40);
    if (!missing.length) return;
    for (const item of missing) this.yearsTried.add(item.url);
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.allSettled(
        missing.slice(i, i + 8).map(async (item) => {
          try {
            const details = await this.api.loadDetails(item.url);
            if (!details.year) return;
            this.items.update((list) =>
              list.map((it) => (it.url === item.url ? { ...it, year: details.year } : it)),
            );
          } catch {
            // без года карточка всплывёт внизу — честный итог
          }
        }),
      );
      if (this.categoryId() !== 'new' || this.sort() !== 'default') return;
    }
  }

  /**
   * `true`, пока панель закреплена под хедером: её верх упёрся в `--header-h`
   * и дальше не двигается при прокрутке (сравниваем с +1px на субпиксели).
   */
  private syncFiltersStuck(): void {
    const el = this.filtersPanel()?.nativeElement;
    if (!el) return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--header-h');
    const headerH = parseFloat(raw) || 67;
    this.filtersStuck.set(el.getBoundingClientRect().top <= headerH + 1);
  }

  readonly sourceIds = signal<string[]>([]);
  /** все источники (включая выключенные) — из них строятся чипсы разделов */
  private sourceList: SourceInfo[] = [];

  /** Идёт бросок дайса (сбор пула из каталога) — повторные клики глушим. */
  private diceBusy = false;
  private diceSpin: ReturnType<typeof setInterval> | undefined;
  private readonly moreBySource = new Map<string, boolean>();
  private autoFilling = false;
  private lastDisabledKey: string | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  /** url'ы, по которым жанры уже запрашивали (даже если источник их не дал). */
  private readonly genresTried = new Set<string>();
  private fetchSeq = 0;

  private readonly router = inject(Router);
  private readonly nav = inject(NavHistoryService);
  /** Ключ вида, восстановленного из снимка — его не перезагружаем. */
  private restoredKey: string | null = null;
  /** Последний ключ маршрута, обработанный эффектом маршрута в конструкторе. */
  private lastRouteKey: string | null = null;
  private stateSaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.restoreState();
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void this.ensureGridFilled(), 250);
    };
    window.addEventListener('resize', onResize);

    // прилипшая к хедеру панель теряет скругление верхних углов
    let stuckRaf = 0;
    const onScroll = (): void => {
      // прокрутку — в снимок вида, чтобы «назад» вернул ту же позицию
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = setTimeout(() => this.saveState(), 350);
      if (stuckRaf) return;
      stuckRaf = requestAnimationFrame(() => {
        stuckRaf = 0;
        this.syncFiltersStuck();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // стрелка с «чистой» страницы — ставим фокус на первую карточку сетки
    window.addEventListener('keydown', this.onGridEntry);

    destroyRef.onDestroy(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', this.onGridEntry);
      if (stuckRaf) cancelAnimationFrame(stuckRaf);
      clearTimeout(resizeTimer);
      clearTimeout(this.filterTimer);
      clearTimeout(this.stateSaveTimer);
      clearTimeout(stateEffectTimer);
      clearInterval(this.diceSpin);
    });

    // первый расчёт — как только панель появится в DOM (viewChild → undefined → элемент)
    effect(() => {
      if (this.filtersPanel()) this.syncFiltersStuck();
    });

    if (this.api.isElectron) {
      this.api
        .listSources()
        .then((sources) => {
          this.sourceList = sources;
          this.sourceIds.set(sources.map((s) => s.id));
          this.applyCategories();
        })
        .catch(() => undefined);
    }

    effect(() => {
      const params = this.routeParam();
      const query = this.queryParam();
      const id = params.get('id') ?? this.defaultCategory;
      const q = query.get('q') ?? '';
      const key = this.isSearch ? `search:${q}` : `cat:${id}`;
      // Ключ маршрута не изменился — выходим сразу, ничего не сбрасывая.
      // Первый запуск зовёт openCategory() синхронно **внутри** эффекта, а тот
      // читает filterState(), sourceIds(), settings(), categories() — эффект
      // подписывается и на них. Без этой проверки выбор любого фильтра
      // перезапускал бы раздел, а openCategory гасит фильтры через
      // resetFilters(): фильтры применялись и тут же стирались («ничего не
      // происходит»). Побочный эффект — выравнивается и двойная загрузка
      // каталога при старте, когда sources:list догоняет категории.
      if (this.lastRouteKey === key) return;
      this.lastRouteKey = key;
      // вид восстановлен из снимка — его не перезагружаем и не сбрасываем,
      // пока маршрут остаётся тем же (paramMap может переиздаться повторно)
      if (this.restoredKey === key) return;
      this.restoredKey = null;
      if (this.isSearch) {
        void this.runSearch(q);
      } else {
        void this.openCategory(id);
      }
    });

    // Снимок вида (фильтры/сортировка/страница/прокрутка) живёт в history.state
    // текущей записи: его читает restoreState() при возврате «назад» с карточки.
    let stateEffectTimer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      this.filterKind();
      this.filterGenre();
      this.filterYearFrom();
      this.filterYearTo();
      this.filterRating();
      this.filterQuality();
      this.sort();
      this.page();
      this.hasMore();
      this.items();
      this.title();
      this.categoryId();
      this.searchQuery();
      // дебаунс: снимок пишется раз в 350 мс, а не на каждый ответ источника
      clearTimeout(stateEffectTimer);
      stateEffectTimer = setTimeout(() => this.saveState(), 350);
    });

    // уход из раздела: URL ещё не обновлён — запись всё ещё «наша», самое
    // точное место для снимка (после него replaceState попадёт уже не туда)
    const saveSub = this.router.events
      .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
      .subscribe(() => this.saveState());
    destroyRef.onDestroy(() => {
      saveSub.unsubscribe();
      this.deepenSeq++; // раздел ушёл — фоновое углубление пула отменяем
    });

    // Reload the catalog when the set of enabled sources changes in settings,
    // or when the user reorders sources by dragging them.
    effect(() => {
      const s = this.settings.settings();
      const key = [...s.disabledSources].sort().join('|') + '#' + s.sourceOrder.join(',');
      if (this.lastDisabledKey === null) {
        this.lastDisabledKey = key;
        return;
      }
      if (this.lastDisabledKey === key) return;
      this.lastDisabledKey = key;
      // выключенный источник пропадает и из чипсов разделов
      this.applyCategories();
      void this.reloadCurrent();
    });

    // Дозаполнить жанры карточкам при активном жанровом фильтре; чтение
    // items() внутри hydrateGenres привязывает эффект и к новым страницам.
    effect(() => {
      if (!this.filterGenre()) return;
      void this.hydrateGenres();
    });

    // Год для «Новинок» (сортировка/фильтр старых перезаливов по нему);
    // чтение items() привязывает эффект и к новым страницам.
    effect(() => {
      if (this.isSearch || this.categoryId() !== 'new' || this.sort() !== 'default') return;
      void this.hydrateYears();
    });
  }

  /** Ключ вида (раздел + поисковый запрос) — для сопоставления со снимком. */
  private viewKey(): string {
    if (this.isSearch) return `search:${this.queryParam().get('q') ?? ''}`;
    return `cat:${this.route.snapshot.paramMap.get('id') ?? this.defaultCategory}`;
  }

  /** Снимок вида: слот (переживает затирание Angular) + history.state записи. */
  private saveState(): void {
    const snap: CatalogViewState = {
      key: this.viewKey(),
      scroll: Math.round(window.scrollY),
      items: this.items(),
      page: this.page(),
      hasMore: this.hasMore(),
      title: this.title(),
      categoryId: this.categoryId(),
      searchQuery: this.searchQuery(),
      filters: this.filterState(),
      sort: this.sort(),
    };
    lastCatalogView = snap;
    const prev = history.state;
    const base = prev && typeof prev === 'object' ? prev : {};
    history.replaceState({ ...base, fbCatalog: snap }, '');
  }

  /**
   * «Назад» с карточки должен открыть этот же раздел с теми же фильтрами,
   * сортировкой, страницей и прокруткой — берём снимок: из history.state
   * (если Angular его не переписал) или из слота последнего ухода.
   */
  private restoreState(): void {
    if (!this.nav.openingBack) return; // свежий вход в раздел всегда заново
    const key = this.viewKey();
    const holder = history.state as { fbCatalog?: CatalogViewState } | null;
    const fromEntry = holder && typeof holder === 'object' ? holder.fbCatalog : undefined;
    const saved =
      fromEntry?.key === key
        ? fromEntry
        : lastCatalogView?.key === key
          ? lastCatalogView
          : undefined;
    if (!saved || !Array.isArray(saved.items) || !saved.items.length) return;
    const f = saved.filters ?? this.filterState();
    this.filterKind.set(f.kind);
    this.filterGenre.set(f.genre);
    this.filterYearFrom.set(f.yearFrom);
    this.filterYearTo.set(f.yearTo);
    this.filterRating.set(f.rating);
    this.filterQuality.set(f.quality);
    this.sort.set(saved.sort);
    this.items.set(saved.items);
    this.page.set(saved.page ?? 1);
    this.hasMore.set(saved.hasMore ?? false);
    this.categoryId.set(saved.categoryId ?? 'home');
    this.searchQuery.set(saved.searchQuery ?? '');
    this.restoredKey = key;
    // глушим сброс прокрутки после навигации — вернём свою позицию
    cancelScrollReset();
    // карточки растут по aspect-ratio — высота сетки известна сразу после рендера
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        cancelScrollReset();
        const scroll = saved.scroll ?? 0;
        if (scroll > 0) window.scrollTo({ top: scroll, behavior: 'instant' });
        this.syncSelectValues();
      }),
    );
    // подстраховка, если первый рендер попал в кадр позже (throttled window)
    setTimeout(() => this.syncSelectValues(), 220);
  }

  /**
   * На первом рендере Angular ставит `[value]` select'а раньше, чем <option>
   * получают свои значения — выбор не «прилипает» (LView уже думает, что всё
   * применено). Восстанавливаем значения селекторов вручную, пока сигнал
   * не изменится и Angular снова сам обновит привязку.
   */
  private syncSelectValues(): void {
    const set = (selector: string, value: string): void => {
      const el = document.querySelector(selector);
      if (el instanceof HTMLSelectElement && value) el.value = value;
    };
    set('.filters select[aria-label="Тип"]', this.filterKind());
    set('.filters select[aria-label="Жанр"]', this.filterGenre());
    set('.filters select[aria-label="Рейтинг"]', this.filterRating());
    set('.filters select[aria-label="Качество"]', this.filterQuality());
    set('.filters .sort-select', this.sort());
  }

  private async reloadCurrent(): Promise<void> {
    if (this.isSearch) {
      await this.runSearch(this.searchQuery());
    } else {
      await this.fetch(1, this.categoryId(), false);
    }
  }

  /**
   * Чипсы разделов: только включённые источники (отключены все — работают
   * все, как сказано в подсказке настроек). Так выключенный «Локальный»
   * источник сразу убирает вкладку «Локальные».
   */
  private applyCategories(): void {
    const disabled = new Set(this.settings.get().disabledSources);
    const active = this.sourceList.filter((s) => !disabled.has(s.id));
    const usable = active.length ? active : this.sourceList;
    const cats = new Map<string, Category>();
    for (const source of usable) {
      for (const cat of source.categories) {
        // cartoons/anime are reachable via the kind filter, not the chips row
        if (cat.id === 'cartoons' || cat.id === 'anime') continue;
        if (!cats.has(cat.id)) cats.set(cat.id, cat);
      }
    }
    if (cats.size) this.categories.set([...cats.values()]);
  }

  private activeSourceIds(): string[] {
    const all = this.sourceIds();
    const disabled = new Set(this.settings.get().disabledSources);
    const active = all.filter((id) => !disabled.has(id));
    if (active.length) return this.settings.orderedSourceIds(active);
    return all.length ? this.settings.orderedSourceIds(all) : ['kinogo'];
  }

  private async openCategory(id: string): Promise<void> {
    this.deepenSeq++; // раздел сменился — фоновое углубление пула отменяем
    this.categoryId.set(id);
    this.resetFilters(false);
    // заголовок — реактивный computed от categoryId/categories, см. поле title
    await this.fetch(1, id, false);
  }

  private async runSearch(q: string): Promise<void> {
    this.deepenSeq++;
    const query = q.trim();
    this.searchQuery.set(query);
    this.resetFilters(false);
    this.items.set([]);
    this.hasMore.set(false);
    if (!query) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const ids = this.activeSourceIds();
      const settled = await Promise.allSettled(
        ids.map((sourceId) => this.api.search({ sourceId, query })),
      );
      const ok = settled.filter(
        (s): s is PromiseFulfilledResult<PagedResult> => s.status === 'fulfilled',
      );
      if (!ok.length) throw this.firstReason(settled);
      let merged: MediaSummary[] = [];
      for (const r of ok) merged = mergeUnique(merged, r.value.items);
      this.items.set(merged);
      this.hasMore.set(false);
    } catch (err) {
      this.error.set((err as Error).message || 'Ошибка поиска');
    } finally {
      this.loading.set(false);
    }
  }

  private firstReason(settled: PromiseSettledResult<PagedResult>[]): unknown {
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected') as
      PromiseRejectedResult | undefined;
    return rejected?.reason ?? new Error('Ни один источник не ответил');
  }

  private fetch(
    page: number,
    categoryId: string,
    append: boolean,
    ids = this.activeSourceIds(),
  ): Promise<void> {
    // Stream results per source: the first source to answer fills the grid
    // immediately instead of waiting for the slowest mirror (the «anime takes
    // forever» complaint). The returned promise settles once every source has
    // reported, so loadMore/ensureGridFilled keep their sequential semantics.
    // `seq` discards stragglers of a superseded fetch.
    const seq = ++this.fetchSeq;
    this.loading.set(true);
    this.error.set(null);
    this.page.set(page);
    if (!ids.length) {
      this.loading.set(false);
      this.hasMore.set(false);
      return Promise.resolve();
    }

    const settled: Array<PromiseSettledResult<PagedResult> | undefined> = ids.map(() => undefined);
    let pending = ids.length;
    let collected: MediaSummary[] = [];

    return new Promise<void>((resolve) => {
      const publish = (index: number, result: PromiseSettledResult<PagedResult>): void => {
        const stale = seq !== this.fetchSeq;
        if (!stale) {
          settled[index] = result;
          if (result.status === 'fulfilled') {
            const fresh = result.value.items;
            if (append) {
              this.items.update((prev) => mergeUnique(prev, fresh));
            } else {
              collected = mergeUnique(collected, fresh);
              this.items.set(collected);
            }
          }
          this.moreBySource.set(ids[index], result.status === 'fulfilled' && result.value.hasMore);
          const done = settled.filter(
            (s) => s !== undefined,
          ) as PromiseSettledResult<PagedResult>[];
          const ok = done.filter(
            (s): s is PromiseFulfilledResult<PagedResult> => s.status === 'fulfilled',
          );
          this.hasMore.set(ok.some((r) => r.value.hasMore));
          if (--pending === 0) {
            this.loading.set(false);
            if (!ok.length) {
              const rejected = done.find(
                (s): s is PromiseRejectedResult => s.status === 'rejected',
              ) as PromiseRejectedResult | undefined;
              this.error.set(
                ((rejected?.reason as Error | undefined)?.message as string) ||
                  'Не удалось загрузить каталог',
              );
            }
            if (!append) void this.ensureGridFilled();
            resolve();
          }
          return;
        }
        if (--pending === 0) resolve();
      };

      ids.forEach((sourceId, index) => {
        this.api.loadCatalog({ sourceId, page, categoryId, filters: this.filterState() }).then(
          (value) => publish(index, { status: 'fulfilled', value }),
          (reason) => publish(index, { status: 'rejected', reason }),
        );
      });
    });
  }

  /**
   * Fetch several pages at once, in parallel. Used while a filter is active:
   * matching cards are rare, so one page per sequential round made filter
   * changes crawl — a batch of four pages lands in roughly the time of one.
   */
  private fetchPages(pages: number[], ids: string[]): Promise<void> {
    const seq = ++this.fetchSeq;
    this.loading.set(true);
    this.error.set(null);
    const jobs: Array<{ page: number; sourceId: string }> = [];
    for (const page of pages) for (const sourceId of ids) jobs.push({ page, sourceId });
    if (!jobs.length) {
      this.loading.set(false);
      return Promise.resolve();
    }

    let pending = jobs.length;
    let okCount = 0;
    const best = new Map<string, { page: number; hasMore: boolean }>();
    // Ответы всех источников копим и публикуем одним обновлением: 36 ответов
    // в раунде — это 36 пересчётов фильтра/сортировки и 36 перерисовок сетки.
    const fresh: MediaSummary[] = [];

    return new Promise<void>((resolve) => {
      const finalize = (): void => {
        if (seq === this.fetchSeq) {
          if (fresh.length) this.items.update((prev) => mergeUnique(prev, fresh));
          for (const [sourceId, state] of best) this.moreBySource.set(sourceId, state.hasMore);
          this.page.set(Math.max(...pages));
          this.hasMore.set([...best.values()].some((state) => state.hasMore));
          if (!okCount) this.error.set('Не удалось загрузить каталог');
          this.loading.set(false);
        }
        resolve();
      };
      const doneOne = (): void => {
        if (--pending === 0) finalize();
      };

      for (const job of jobs) {
        this.api
          .loadCatalog({ sourceId: job.sourceId, page: job.page, categoryId: this.categoryId(), filters: this.filterState() })
          .then(
            (value) => {
              if (seq === this.fetchSeq) {
                okCount++;
                fresh.push(...value.items);
                const current = best.get(job.sourceId);
                if (!current || job.page >= current.page) {
                  best.set(job.sourceId, { page: job.page, hasMore: value.hasMore });
                }
              }
              doneOne();
            },
            () => doneOne(),
          );
      }
    });
  }

  private async ensureGridFilled(): Promise<void> {
    if (this.autoFilling || this.isSearch) return;
    this.autoFilling = true;
    try {
      let attempts = 0;
      // Up to 6 rounds: the sources that understand a filter answer with a
      // dense page (the viewport fills after 1–2 rounds), while the rest are
      // narrowed locally by filterItems() and need deeper digging.
      const maxAttempts = 6;
      while (attempts < maxAttempts && this.hasMore() && !this.loading()) {
        const grid = document.querySelector<HTMLElement>('.page-grid');
        if (grid && grid.children.length) {
          const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
          if (!cols) break;
          const first = grid.firstElementChild as HTMLElement | null;
          const cardHeight = first?.getBoundingClientRect().height || 320;
          const gridTop = grid.getBoundingClientRect().top;
          const rows = Math.ceil((window.innerHeight - gridTop) / cardHeight) + 1;
          if (rows > 0 && this.filteredItems().length >= cols * rows) break;
        } else if (this.filteredItems().length >= 12) {
          // no grid at all: the filter hid every loaded card — keep digging
          // until something matches (this used to bail out and wait forever)
          break;
        }
        await this.loadMore();
        attempts++;
      }
    } finally {
      this.autoFilling = false;
    }
  }

  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;

    if (this.hasFilters()) {
      // Matching cards are sparse under a filter: fetch batches of two pages
      // in parallel per round instead of one page per slow sequential round.
      const before = this.filteredItems().length;
      let rounds = 0;
      while (rounds < 2 && this.hasMore() && !this.error()) {
        const ids = this.activeSourceIds().filter((id) => this.moreBySource.get(id));
        if (!ids.length) {
          this.hasMore.set(false);
          break;
        }
        const base = this.page();
        await this.fetchPages([base + 1, base + 2], ids);
        rounds++;
        if (this.filteredItems().length > before) break;
      }
      void this.ensureGridFilled();
      return;
    }

    const ids = this.activeSourceIds().filter((id) => this.moreBySource.get(id));
    if (!ids.length) {
      this.hasMore.set(false);
      return;
    }
    await this.fetch(this.page() + 1, this.categoryId(), true, ids);
    void this.ensureGridFilled();
  }

  async retry(): Promise<void> {
    if (this.isSearch) {
      await this.runSearch(this.searchQuery());
    } else {
      await this.fetch(this.page(), this.categoryId(), false);
    }
  }

  onFilterChange(): void {
    // When filters change, we must restart from page 1 to ensure we see matching items
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => void this.reloadCurrent(), 350);
  }

  onFilterKind(event: Event): void {
    this.filterKind.set((event.target as HTMLSelectElement).value);
    this.onFilterChange();
  }

  onFilterGenre(event: Event): void {
    this.filterGenre.set((event.target as HTMLSelectElement).value);
    this.onFilterChange();
  }

  onFilterYearFrom(event: Event): void {
    this.filterYearFrom.set((event.target as HTMLInputElement).value);
    this.onFilterChange();
  }

  onFilterYearTo(event: Event): void {
    this.filterYearTo.set((event.target as HTMLInputElement).value);
    this.onFilterChange();
  }

  onFilterRating(event: Event): void {
    this.filterRating.set((event.target as HTMLSelectElement).value);
    this.onFilterChange();
  }

  onFilterQuality(event: Event): void {
    this.filterQuality.set((event.target as HTMLSelectElement).value);
    this.onFilterChange();
  }

  resetFilters(refill = true): void {
    this.filterKind.set('');
    this.filterGenre.set('');
    this.filterYearFrom.set('');
    this.filterYearTo.set('');
    this.filterRating.set('');
    this.filterQuality.set('');
    if (refill) void this.ensureGridFilled();
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
      case 'Escape':
        // Esc с наведённой карточкой — назад (или домой, если назад некуда)
        event.preventDefault();
        this.nav.back(() => void this.router.navigate(['/']));
        return;
      default:
        return;
    }
    event.preventDefault();
    cards[Math.min(Math.max(next, 0), cards.length - 1)]?.focus();
  }
}
