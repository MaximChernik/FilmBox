import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from '../../core/api.service';
import { LibraryService, type WatchStatus } from '../../core/library.service';
import { NavHistoryService } from '../../core/nav-history.service';
import { PosterFlyService } from '../../core/poster-fly.service';
import { SettingsService } from '../../core/settings.service';
import { SourceStatsService } from '../../core/source-stats.service';
import type { MediaDetails, MediaSummary, PlayerTab, SourceInfo } from '../../core/models';
import { PosterPhComponent } from '../../shared/poster-ph.component';
import { SpinnerComponent } from '../../shared/spinner.component';
import { MediaCardComponent } from '../../shared/media-card/media-card.component';
import { effectiveYear, normalizeTitle } from '../catalog/catalog-items.model';

/**
 * The same film/series found on another enabled source. Players hydrate in
 * the background: `undefined` — details are still loading, `null` — failed.
 */
interface SourceTab {
  sourceId: string;
  sourceName: string;
  url: string;
  details?: MediaDetails | null;
  loading?: boolean;
}

/** 5400 → «1 ч 30 мин», 2400 → «40 мин», 45 → «45 сек» */
function formatLeft(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} сек`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

@Component({
  templateUrl: './details.component.html',
  styleUrl: './details.component.scss',
  imports: [RouterLink, SpinnerComponent, MediaCardComponent, PosterPhComponent],
})
export class DetailsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly nav = inject(NavHistoryService);
  private readonly api = inject(ApiService);
  private readonly settings = inject(SettingsService);
  readonly library = inject(LibraryService);
  private readonly srcStats = inject(SourceStatsService);
  private readonly sanitizer = inject(DomSanitizer);

  private readonly queryParam = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly details = signal<MediaDetails | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sourceTabs = signal<SourceTab[]>([]);
  private dupToken = 0;
  /** Детали совпавших источников по sourceId (undefined — грузятся, null — ошибка). */
  private readonly tabDetails = signal<Record<string, MediaDetails | null>>({});
  private readonly sourceNames = signal<Record<string, string>>({});
  private readonly activeSourceId = signal<string | null>(null);

  private readonly fly = inject(PosterFlyService);

  /**
   * Постер со старой карточки: пока детали грузятся, герой уже показывает
   * картинку — иначе снимок нового состояния для view-transition не успел бы
   * увидеть постер и «увеличение» не сработало.
   */
  readonly flyPoster = computed(() => {
    const url = this.queryParam().get('u');
    return this.fly.url() === url ? this.fly.poster() : null;
  });

  /** URL постера, который уже отвалился (битая ссылка) — на него заглушка. */
  private readonly brokenPoster = signal<string | null>(null);

  /**
   * Источник картинки героя: реальный постер, а до его загрузки — постер
   * со старой карточки. Нода `<img>` при этом не пересоздаётся. Если
   * картинка не открылась — вместо неё идёт стилизованная заглушка.
   */
  readonly posterSrc = computed(() => {
    const url = this.details()?.poster ?? this.flyPoster();
    return url && this.brokenPoster() !== url ? url : null;
  });

  onPosterError(): void {
    const url = this.details()?.poster ?? this.flyPoster();
    if (url) this.brokenPoster.set(url);
  }

  /**
   * Герой-постер носит view-transition-name во время перелёта (в обе стороны).
   * Имя держится на постоянной ноде — Chromium прерывает view-transition,
   * если именованный элемент исчезает из DOM в его процессе.
   */
  readonly posterFlying = computed(() => {
    const url = this.details()?.url ?? this.queryParam().get('u');
    return !!url && this.fly.url() === url;
  });

  /**
   * Первая вкладка — сам открытый источник, дальше — совпадения в порядке
   * пользователя; плееры каждого источника доезжают в фоне. Поверх этого —
   * приоритет источников: те, что чаще реально отдавали рабочий плеер,
   * поднимаются вверх; при равном счёте порядок не меняется.
   */
  readonly allTabs = computed<SourceTab[]>(() => {
    const primary = this.details();
    if (!primary) return [];
    const names = this.sourceNames();
    const bySource = this.tabDetails();
    const tabs: SourceTab[] = [
      {
        sourceId: primary.sourceId,
        sourceName: names[primary.sourceId] ?? primary.sourceId,
        url: primary.url,
        details: primary,
        loading: false,
      },
    ];
    for (const tab of this.sourceTabs()) {
      const known = tab.sourceId in bySource;
      tabs.push({
        ...tab,
        sourceName: names[tab.sourceId] ?? tab.sourceName,
        details: known ? bySource[tab.sourceId] : undefined,
        loading: !known,
      });
    }
    return tabs.sort((a, b) => this.srcStats.score(b.sourceId) - this.srcStats.score(a.sourceId));
  });

  readonly activeTab = computed<SourceTab | null>(() => {
    const tabs = this.allTabs();
    const selected = this.activeSourceId();
    return tabs.find((tab) => tab.sourceId === selected) ?? tabs[0] ?? null;
  });
  readonly activePlayers = computed(() => this.activeTab()?.details?.players ?? []);
  readonly embedPlayers = computed(() => this.activePlayers().filter((p) => p.kind === 'embed'));
  readonly activeTabLoading = computed(() => !!this.activeTab()?.loading);

  /** URL активной вкладки: прогресс и «Открыть на сайте» живут по источнику. */
  readonly activeUrl = computed(() => {
    const tab = this.activeTab();
    return tab?.details?.url ?? tab?.url ?? this.details()?.url ?? '';
  });

  /** Источник с подтверждённо высокой долей удач — звёздочка у его вкладки. */
  readonly trustedSourceId = computed(() => {
    for (const tab of this.allTabs()) {
      if (this.srcStats.isTrusted(tab.sourceId)) return tab.sourceId;
    }
    return null;
  });

  /** Подпись вкладки с фактической статистикой: kinogo — удач: 12, сбоев: 1. */
  tabTitle(tab: SourceTab): string {
    const s = this.srcStats.stat(tab.sourceId);
    return s ? `${tab.sourceId} — удач: ${s.ok}, сбоев: ${s.fail}` : tab.sourceId;
  }

  readonly isFavorite = computed(() => {
    const url = this.details()?.url;
    return url ? this.library.isFavorite(url) : false;
  });
  readonly isLater = computed(() => {
    const url = this.details()?.url;
    return url ? this.library.isLater(url) : false;
  });
  readonly progress = computed(() => {
    const url = this.activeUrl();
    return url ? this.library.getProgress(url) : undefined;
  });
  readonly progressLabel = computed(() => {
    const p = this.progress();
    if (!p) return null;
    const base = `Сезон ${p.season} · ${p.episode}`;
    const left = (p.duration ?? 0) - (p.time ?? 0);
    return p.duration && p.time && left > 30 ? `${base}, осталось ${formatLeft(left)}` : base;
  });

  /** Моя оценка / статус привязаны к активной вкладке источника. */
  readonly myRating = computed(() => this.library.ratingFor(this.activeUrl()));
  readonly myStatus = computed<WatchStatus | undefined>(() =>
    this.library.statusFor(this.activeUrl()),
  );
  readonly statusOptions: { id: WatchStatus; title: string }[] = [
    { id: 'watching', title: 'Смотрю' },
    { id: 'watched', title: 'Досмотрел' },
    { id: 'dropped', title: 'Брошено' },
  ];
  /** Моя оценка 1–10 по активному материалу (повтор/0 = снять). */
  setMyRating(value: number): void {
    this.library.setRating(this.activeUrl(), value);
  }
  setMyStatus(value: WatchStatus | null): void {
    this.library.setStatus(this.activeUrl(), value);
  }

  /** Похожие материалы — из первого каталожного среза того же источника. */
  readonly similar = signal<MediaSummary[]>([]);

  constructor() {
    effect(() => {
      const url = this.queryParam().get('u');
      void this.load(url);
    });
  }

  private async load(url: string | null): Promise<void> {
    if (!url) {
      this.error.set('Не указана ссылка на материал');
      return;
    }
    if (this.details()?.url === url) return;
    this.closeTrailer();
    this.loading.set(true);
    this.error.set(null);
    this.sourceTabs.set([]);
    this.tabDetails.set({});
    this.activeSourceId.set(null);
    this.similar.set([]);
    try {
      const details = await this.api.loadDetails(url);
      this.details.set(details);
      void this.loadSimilar(details);
      void this.findDuplicateSources(details);
    } catch (err) {
      this.error.set((err as Error).message || 'Не удалось загрузить описание');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * «Похожие материалы»: первый каталожный срез того же источника и того же
   * типа, отсортированный по пересечению жанров (а при равном пересечении —
   * по рейтингу). Это намеренно встроенное в рендерер решение — без новых
   * IPC-обработчиков и расширенного скрейпинга.
   */
  private async loadSimilar(d: MediaDetails): Promise<void> {
    if (!d.sourceId) {
      this.similar.set([]);
      return;
    }
    try {
      const categoryId =
        d.kind === 'serial'
          ? 'serials'
          : d.kind === 'cartoon'
            ? 'cartoons'
            : d.kind === 'anime'
              ? 'anime'
              : 'films';
      const page = await this.api.loadCatalog({ sourceId: d.sourceId, page: 1, categoryId });
      const target = new Set((d.genres ?? []).map((g) => g.toLowerCase()));
      const scored = page.items
        .filter((it) => it.url !== d.url)
        .map((it) => {
          const overlap = (it.genres ?? []).filter((g) => target.has(g.toLowerCase())).length;
          // карточки без жанров — младше жанрово-совпадающих, но старше случайных
          const score = overlap > 0 ? 100 * overlap + (it.rating ?? 0) : 50 + (it.rating ?? 0);
          return { it, score };
        })
        .sort((a, b) => b.score - a.score);
      this.similar.set(scored.slice(0, 8).map((s) => s.it));
    } catch {
      this.similar.set([]);
    }
  }

  /**
   * Fan-out: ask every other enabled source for this title and offer the
   * matches as extra tabs (results arrive in the user's source order).
   */
  private async findDuplicateSources(details: MediaDetails): Promise<void> {
    const token = ++this.dupToken;
    if (!details.sourceId) return;
    let sources: SourceInfo[];
    try {
      sources = await this.api.listSources();
    } catch {
      return;
    }
    if (token !== this.dupToken) return;
    this.sourceNames.set(Object.fromEntries(sources.map((s) => [s.id, s.name])));
    const disabled = new Set(this.settings.get().disabledSources);
    const others = sources.filter((s) => s.id !== details.sourceId && !disabled.has(s.id));
    if (!others.length) return;
    const ordered = this.settings.orderedSourceIds(others.map((s) => s.id));
    const byId = new Map(others.map((s) => [s.id, s]));

    const settled = await Promise.allSettled(
      ordered.map((sourceId) => this.api.search({ sourceId, query: details.title })),
    );
    if (token !== this.dupToken) return;

    const title = normalizeTitle(details.title);
    const year = effectiveYear(details);
    const tabs: SourceTab[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      const match = result.value.items.find((item) => this.isSameMedia(item, title, year, details));
      if (match) {
        tabs.push({
          sourceId: ordered[i],
          sourceName: byId.get(ordered[i])?.name ?? ordered[i],
          url: match.url,
        });
      }
    }
    this.sourceTabs.set(tabs);
    // Плееры каждого совпавшего источника — в фоне: вкладка кликабельна сразу,
    // а её строка показывает «Загрузка плееров…», пока детали едут.
    void Promise.allSettled(
      tabs.map(async (tab) => {
        let extra: MediaDetails | null = null;
        try {
          extra = await this.api.loadDetails(tab.url);
        } catch {
          extra = null;
        }
        if (token !== this.dupToken) return;
        this.tabDetails.update((state) => ({ ...state, [tab.sourceId]: extra }));
      }),
    );
  }

  /** Same title (or a subtitle variant with a matching year) and compatible kind. */
  private isSameMedia(item: MediaSummary, title: string, year: string, d: MediaDetails): boolean {
    const t = normalizeTitle(item.title);
    const y = effectiveYear(item);
    const sameTitle =
      t === title || (year && y && year === y && (t.includes(title) || title.includes(t)));
    if (!sameTitle) return false;
    if (year && y && year !== y) return false;
    const kinds = [d.kind, item.kind].filter(
      (k): k is NonNullable<typeof k> => !!k && k !== 'unknown',
    );
    return kinds.length < 2 || kinds[0] === kinds[1];
  }

  /**
   * Вкладка источника переключается на месте: плееры, прогресс и «Смотреть»
   * становятся активного источника, страница (и её состояние) не перезагружается.
   */
  selectSource(sourceId: string): void {
    if (this.activeSourceId() === sourceId) return;
    this.activeSourceId.set(sourceId);
    this.error.set(null);
  }

  /** «Назад» — на реально открытый ранее раздел (с его фильтрами и сортировкой). */
  goBack(event?: Event): void {
    event?.preventDefault();
    this.nav.back(() => void this.router.navigate(['/']));
  }

  watch(tab?: PlayerTab): void {
    const active = this.activeTab();
    const details = active?.details ?? null;
    // плееры вкладки ещё грузятся — кнопка на это время выключена
    if (!details) return;
    const progress = this.library.getProgress(details.url);
    const resumeTab = progress?.tab
      ? details.players.find((p) => p.url === progress.tab)
      : undefined;
    const target = tab ?? resumeTab ?? this.embedPlayers()[0] ?? details.players[0];
    // без плееров у активной вкладки показана строка «Нет плееров» —
    // контент ошибкой не гасим
    if (!target) return;
    void this.router.navigate(['/watch'], {
      queryParams: {
        u: details.url,
        t: target.url,
        tl: target.label,
        ...(progress ? { s: progress.season, e: progress.episode } : {}),
      },
    });
    if (this.settings.get().historyEnabled) {
      this.library.pushHistory(this.library.summary(details));
    }
  }

  toggleFavorite(): void {
    const details = this.details();
    if (!details) return;
    this.library.toggleFavorite(this.library.summary(details));
  }

  toggleLater(): void {
    const details = this.details();
    if (!details) return;
    this.library.toggleLater(this.library.summary(details));
  }

  openOnSite(): void {
    const url = this.activeUrl();
    if (url) void this.api.openExternal(url);
  }

  // — Трейлер —
  /** Фазы модалки: закрыта / ищем / играет iframe / не нашли. */
  readonly trailerPhase = signal<'closed' | 'loading' | 'open' | 'error'>('closed');
  readonly trailerUrl = signal<SafeResourceUrl | null>(null);
  readonly trailerError = signal<string | null>(null);
  readonly trailerVisible = computed(() => this.trailerPhase() !== 'closed');
  /** Пока шёл поиск, модалку могли закрыть — поздний ответ игнорируем. */
  private trailerToken = 0;

  /**
   * Кнопка «Трейлер»: сначала вкладка «Трейлер» со страницы источника
   * (обычно YouTube), затем поиск по RuTube «название [год] трейлер».
   */
  async openTrailer(): Promise<void> {
    const d = this.details();
    if (!d || this.trailerPhase() === 'loading') return;
    const token = ++this.trailerToken;
    this.trailerPhase.set('loading');
    this.trailerError.set(null);
    try {
      const embed = await this.findTrailer(d);
      if (token !== this.trailerToken) return;
      if (!embed) {
        this.trailerError.set('Трейлер не найден');
        this.trailerPhase.set('error');
        return;
      }
      this.trailerUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(embed));
      this.trailerPhase.set('open');
    } catch (err) {
      if (token !== this.trailerToken) return;
      this.trailerError.set((err as Error).message || 'Не удалось найти трейлер');
      this.trailerPhase.set('error');
    }
  }

  closeTrailer(): void {
    this.trailerToken++;
    this.trailerPhase.set('closed');
    this.trailerUrl.set(null);
    this.trailerError.set(null);
  }

  private async findTrailer(d: MediaDetails): Promise<string | null> {
    const own = d.players.find((p) => p.kind === 'trailer' && p.url);
    if (own) {
      const embed = toTrailerEmbed(own.url);
      if (embed) return embed;
    }
    const norm = normalizeTitle(d.title);
    const pickBest = (items: MediaSummary[]) =>
      items
        .filter((it) => /трейлер|тизер/i.test(it.title))
        .map((it) => {
          let score = 0;
          if (normalizeTitle(it.title).includes(norm)) score += 4;
          if (d.year && it.title.includes(d.year)) score += 2;
          return { it, score };
        })
        .sort((a, b) => b.score - a.score)[0]?.it ?? null;

    let res = await this.api.search({
      sourceId: 'rutube',
      query: `${d.title}${d.year ? ` ${d.year}` : ''} трейлер`,
    });
    let pick = pickBest(res.items);
    if (!pick && d.year) {
      res = await this.api.search({ sourceId: 'rutube', query: `${d.title} трейлер` });
      pick = pickBest(res.items);
    }
    if (!pick) return null;
    const id = pick.url.match(/\/video\/([0-9a-f]{32})/i)?.[1];
    return id ? `https://rutube.ru/play/embed/${id}/` : null;
  }
}

/**
 * URL вкладки «Трейлер» → рабочий embed для iframe: YouTube — в nocookie
 * (Referer для него подставляет main.ts), RuTube — в play/embed; на всё
 * остальное полагаться не стоит — лучше поискать трейлер заново.
 */
function toTrailerEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('rutube.ru')) {
      if (u.pathname.includes('/play/embed/')) return url;
      const rt = u.pathname.match(/\/video\/([0-9a-f]{32})/i);
      return rt ? `https://rutube.ru/play/embed/${rt[1]}/` : null;
    }
    let id = '';
    if (host.endsWith('youtu.be')) id = u.pathname.split('/')[1] ?? '';
    else {
      id = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})(?:\/|$)/)?.[1] ?? '';
      if (!id) id = u.searchParams.get('v') ?? '';
    }
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch {
    return null;
  }
}
