import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { LibraryService } from '../../core/library.service';
import { SettingsService } from '../../core/settings.service';
import type { MediaSummary, PagedResult } from '../../core/models';
import { MediaCardComponent } from '../../shared/media-card/media-card.component';
import { SpinnerComponent } from '../../shared/spinner.component';

/** Weights of library sections in the taste profile. */
const WEIGHT_LATER = 3;
const WEIGHT_FAVORITE = 2;
const WEIGHT_HISTORY = 1;
/** Период полураспада влияния истории: свежие просмотры значат больше. */
const HISTORY_DECAY_DAYS = 30;
/**
 * Полосы качества: чем выше порог «подавления», тем злее отбрасываем
 * мусорные низкорейтинговые карточки перед скорингом.
 */
const RATING_SUPPRESS_BELOW = 6.5;
const RATING_SUPPRESS_FACTOR = 0.35;
/**
 * Буст «хорошего профиля»: когда у подборки есть жанровая опора, чёткие
 * совпадения прижимаются к верху списка сильнее, чем их тянет сырая формула.
 */
const PROFILE_SHARPEN = 1.6;
/** Сколько записей библиотеки обогащается жанрами через детали. */
const ENRICH_LIMIT = 15;
/** Сколько рекомендаций показывается перед «показать ещё». */
const PAGE_SIZE = 24;
/**
 * Максимальное время ожидания одного combo «источник × раздел».
 * Подборка агрегирует каталоги ВСЕХ активных источников — без
 * таймаута один тормозящий парсер (например, ZONA в дауне,
 * у которой соединение висит десятки секунд) вешал всю страницу:
 * спиннер крутился по минуте. Параллельные запросы, так что в
 * худшем случае подборка собирается за COMBO_TIMEOUT_MS.
 */
const COMBO_TIMEOUT_MS = 9000;
/** На столько помечаем источник «мёртвым» после таймаута/ошибки. */
const DEAD_SOURCE_MS = 60_000;

interface ProfileEntry {
  item: MediaSummary;
  weight: number;
  /** Угасающий вес: свежие просмотры давят на профиль сильнее старых. */
  decay: number;
}

interface Profile {
  genre: Map<string, number>;
  kind: Map<string, number>;
  years: Array<{ year: number; weight: number }>;
  total: number;
}

interface ScoredItem {
  item: MediaSummary;
  score: number;
}

function normGenre(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'!?():;,—–]/g, ' ')
    .replace(/[\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

@Component({
  templateUrl: './recs.component.html',
  styleUrl: './recs.component.scss',
  imports: [RouterLink, MediaCardComponent, SpinnerComponent],
})
export class RecsComponent {
  private readonly api = inject(ApiService);
  private readonly library = inject(LibraryService);
  private readonly settings = inject(SettingsService);

  /** Full ranked pool; the grid shows the first `shown` entries. */
  private readonly pool = signal<ScoredItem[]>([]);
  readonly shown = signal(PAGE_SIZE);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly error = signal<string | null>(null);
  readonly built = signal(false);
  /** Human-readable explanation of how the list is formed. */
  readonly reason = signal('');

  readonly items = computed(() =>
    this.pool()
      .slice(0, this.shown())
      .map((s) => s.item),
  );

  readonly stats = computed(() => ({
    later: this.library.later().length,
    favorites: this.library.favorites().length,
    history: this.library.history().length,
  }));
  readonly hasLibrary = computed(
    () => this.stats().later + this.stats().favorites + this.stats().history > 0,
  );

  /** Signature of the library that recommendations are built from. */
  private readonly libKey = computed(() => {
    const later = this.library
      .later()
      .map((i) => i.url)
      .join(',');
    const favorites = this.library
      .favorites()
      .map((i) => i.url)
      .join(',');
    const history = this.library
      .history()
      .map((h) => h.item.url)
      .join(',');
    return `${later}|${favorites}|${history}`;
  });
  private lastLibKey: string | null = null;
  private buildToken = 0;

  private profile: Profile | null = null;
  /** Профиль вкуса собран на узком костяке жанров — можно отточить скоринг. */
  private sharpenProfile = false;
  private excludedUrls = new Set<string>();
  private seenUrls = new Set<string>();
  private seenTitles = new Set<string>();
  private combos: Array<{ sourceId: string; categoryId: string }> = [];
  private pageNo = 1;
  /** combo key → that combo still has deeper catalog pages. */
  private readonly moreState = signal<Record<string, boolean>>({});
  /** sourceId → до какого момента источник считаем недоступным. */
  private deadUntil = new Map<string, number>();

  constructor() {
    void this.build();
    // Rebuild recommendations when items are removed/added in history,
    // favorites or "watch later" while this page is open.
    effect(() => {
      const key = this.libKey();
      if (this.lastLibKey === null) {
        this.lastLibKey = key;
        return;
      }
      if (this.lastLibKey === key) return;
      this.lastLibKey = key;
      void this.build();
    });
  }

  readonly hasMore = computed(
    () =>
      this.shown() < this.pool().length ||
      Object.values(this.moreState()).some((hasMore) => hasMore),
  );

  private collectEntries(): ProfileEntry[] {
    const now = Date.now();
    const entries: ProfileEntry[] = [];
    for (const item of this.library.later()) {
      entries.push({ item, weight: WEIGHT_LATER, decay: 1 });
    }
    for (const item of this.library.favorites()) {
      entries.push({ item, weight: WEIGHT_FAVORITE, decay: 1 });
    }
    for (const entry of this.library.history()) {
      // угасание по 30-дневному полураспаду: вчерашний просмотр весит почти
      // как свежий, а годовалый — почти ничто
      const ageDays = (now - entry.watchedAt) / (24 * 60 * 60 * 1000);
      const decay = Math.pow(0.5, ageDays / HISTORY_DECAY_DAYS);
      entries.push({ item: entry.item, weight: WEIGHT_HISTORY, decay });
    }
    return entries;
  }

  private async buildProfile(entries: ProfileEntry[]): Promise<Profile> {
    const missing = entries
      .filter((e) => !e.item.genres?.length)
      .map((e) => e.item)
      .slice(0, ENRICH_LIMIT);
    const enriched = new Map<string, MediaSummary>();
    if (missing.length) {
      const settled = await Promise.allSettled(missing.map((i) => this.api.loadDetails(i.url)));
      for (const result of settled) {
        if (result.status === 'fulfilled') enriched.set(result.value.url, result.value);
      }
    }

    const profile: Profile = { genre: new Map(), kind: new Map(), years: [], total: 0 };
    for (const entry of entries) {
      const details = enriched.get(entry.item.url);
      const genres = entry.item.genres?.length ? entry.item.genres : (details?.genres ?? []);
      const w = entry.weight * entry.decay;
      for (const genre of genres) {
        const key = normGenre(genre);
        if (!key) continue;
        profile.genre.set(key, (profile.genre.get(key) ?? 0) + w);
      }
      if (entry.item.kind) {
        profile.kind.set(entry.item.kind, (profile.kind.get(entry.item.kind) ?? 0) + w);
      }
      const year = Number(entry.item.year);
      if (Number.isFinite(year) && year > 1900) {
        profile.years.push({ year, weight: w });
      }
      profile.total += w;
    }
    return profile;
  }

  /**
   * Чёткость профиля: сколько жанров реально держится на весах библиотеки.
   * `true` — есть узкий костяк вкуса (2–5 доминантных жанров), которым стоит
   * верить; `false` — либо данных мало, либо вкусы размазаны, и усиление
   * только размазало бы подборку.
   */
  private hasSharpProfile(profile: Profile): boolean {
    const weights = [...profile.genre.values()].sort((a, b) => b - a);
    if (weights.length < 2 || weights.length > 5) return false;
    const top = weights.slice(0, 2).reduce((sum, w) => sum + w, 0);
    const all = weights.reduce((sum, w) => sum + w, 0);
    return all > 0 && top / all > 0.4;
  }

  /**
   * Score: genre overlap ×2 + profile kind + year proximity (±1-2 years) + rating.
   * Items matching the taste profile always rank above rating-only fillers.
   */
  private scoreCandidate(item: MediaSummary, profile: Profile): number {
    let score = 0;
    let genreHits = 0;
    for (const genre of item.genres ?? []) {
      const weight = profile.genre.get(normGenre(genre)) ?? 0;
      genreHits += weight;
      score += weight * 2;
    }
    if (item.kind) score += profile.kind.get(item.kind) ?? 0;
    const year = Number(item.year);
    if (Number.isFinite(year)) {
      for (const y of profile.years) {
        const delta = Math.abs(year - y.year);
        if (delta === 0) score += y.weight * 1.2;
        else if (delta === 1) score += y.weight * 0.6;
        else if (delta === 2) score += y.weight * 0.3;
      }
    }
    // рейтинг как мягкое качество: карточки ниже ~6.5 прижимаются вниз, а
    // не конкурируют с действительно подходящими по вкусу
    const rating = item.rating;
    if (rating !== undefined && Number.isFinite(rating)) {
      const r = Math.min(Math.max(rating, 0), 10);
      const factor = r < RATING_SUPPRESS_BELOW ? RATING_SUPPRESS_FACTOR : 1;
      score += (r / 10) * factor;
    }
    // когда профиль чёткий, усиливаем реальные совпадения — «жанровая опора»
    // прижимает точные попадания к верху
    if (genreHits > 0 && this.sharpenProfile) {
      score *= PROFILE_SHARPEN;
    }
    return score;
  }

  private rank(candidates: MediaSummary[]): ScoredItem[] {
    const profile = this.profile;
    return candidates
      .map((item) => ({
        item,
        score: profile ? this.scoreCandidate(item, profile) : (item.rating ?? 0),
      }))
      .sort((a, b) => b.score - a.score || (b.item.rating ?? 0) - (a.item.rating ?? 0));
  }

  private describeReason(profile: Profile): string {
    const topGenres = [...profile.genre.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([genre]) => genre);
    const count = Math.round(profile.total);
    const unit = pluralRu(count, 'запись', 'записи', 'записей');
    if (!topGenres.length) {
      return `По вашей библиотеке (${count} ${unit}) жанров пока не прослеживается — сортируем кандидатов по рейтингу.`;
    }
    const sharpen = this.sharpenProfile
      ? `Профиль чёткий (2–5 доминантных жанров) — совпадения усилены ×${PROFILE_SHARPEN}. `
      : 'Вкусы размазаны по многим жанрам — усиление не применяли. ';
    return (
      `${sharpen}Опора: ${topGenres.join(', ')}. ` +
      `Веса: «Смотреть позже» ×${WEIGHT_LATER}, избранное ×${WEIGHT_FAVORITE}, история ×${WEIGHT_HISTORY} ` +
      `с угасанием по ${HISTORY_DECAY_DAYS}-дневному полураспаду — всего ${count} ${unit}. ` +
      `Кандидаты — каталоги активных источников, низкорейтинговые карточки прижаты вниз.`
    );
  }

  private async fetchPage(page: number): Promise<ScoredItem[]> {
    const now = Date.now();
    const combos = this.combos.filter((c) => {
      const dead = this.deadUntil.get(c.sourceId) ?? 0;
      return dead < now && (this.moreState()[this.comboKey(c)] !== false || page === 1);
    });
    const settled = await Promise.allSettled(combos.map((c) => this.fetchCombo(c, page)));
    const more: Record<string, boolean> = { ...this.moreState() };
    const fresh: MediaSummary[] = [];
    settled.forEach((result, i) => {
      const key = this.comboKey(combos[i]);
      if (result.status !== 'fulfilled') {
        more[key] = false;
        /* источник не отвечает — не дёргаем его ещё минуту */
        this.deadUntil.set(combos[i].sourceId, now + DEAD_SOURCE_MS);
        return;
      }
      more[key] = result.value.hasMore;
      for (const item of result.value.items) {
        const titleKey = `${normalizeTitle(item.title)}|${item.year ?? ''}`;
        if (this.excludedUrls.has(item.url)) continue;
        if (this.seenUrls.has(item.url) || this.seenTitles.has(titleKey)) continue;
        this.seenUrls.add(item.url);
        this.seenTitles.add(titleKey);
        fresh.push(item);
      }
    });
    this.moreState.set(more);
    return this.rank(fresh);
  }

  private comboKey(combo: { sourceId: string; categoryId: string }): string {
    return `${combo.sourceId}|${combo.categoryId}`;
  }

  /**
   * loadCatalog с таймаутом: медленный или зависший источник
   * отклоняется как недоступный, а не висит всю подборку.
   */
  private fetchCombo(
    combo: { sourceId: string; categoryId: string },
    page: number,
  ): Promise<PagedResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Источник ${combo.sourceId} не отвечает`)),
        COMBO_TIMEOUT_MS,
      );
    });
    return Promise.race([
      this.api.loadCatalog({
        sourceId: combo.sourceId,
        page,
        categoryId: combo.categoryId,
      }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async build(): Promise<void> {
    if (!this.api.isElectron) {
      this.error.set('Нет соединения с приложением');
      return;
    }
    const token = ++this.buildToken;
    if (!this.hasLibrary()) {
      this.pool.set([]);
      this.shown.set(PAGE_SIZE);
      this.built.set(true);
      this.reason.set('');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = this.collectEntries();
      const profile = await this.buildProfile(entries);
      if (token !== this.buildToken) return;
      this.profile = profile;
      this.sharpenProfile = this.hasSharpProfile(profile);
      this.excludedUrls = new Set(entries.map((e) => e.item.url));
      this.seenUrls = new Set(this.excludedUrls);
      this.seenTitles = new Set<string>();
      this.moreState.set({});
      this.pageNo = 1;

      const sources = await this.api.listSources();
      const disabled = new Set(this.settings.get().disabledSources);
      const active = sources.filter((s) => !disabled.has(s.id));
      const activeById = new Map(active.map((s) => [s.id, s]));
      const orderedActive = this.settings
        .orderedSourceIds(active.map((s) => s.id))
        .map((id) => activeById.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s);
      const categories = ['home', 'films', 'serials'];
      this.combos = [];
      for (const source of orderedActive) {
        for (const categoryId of categories) {
          this.combos.push({ sourceId: source.id, categoryId });
        }
      }

      const ranked = await this.fetchPage(1);
      if (token !== this.buildToken) return;
      this.pool.set(ranked);
      this.shown.set(Math.min(PAGE_SIZE, ranked.length));
      this.reason.set(this.describeReason(profile));
      this.built.set(true);
    } catch (err) {
      if (token !== this.buildToken) return;
      this.error.set((err as Error).message || 'Не удалось собрать подборку');
    } finally {
      if (token === this.buildToken) this.loading.set(false);
    }
  }

  /** Reveal the next batch of the pool; when it is exhausted, fetch deeper catalog pages. */
  async loadMore(): Promise<void> {
    if (this.loading() || this.loadingMore() || !this.hasMore()) return;
    if (this.shown() < this.pool().length) {
      this.shown.update((n) => n + PAGE_SIZE);
      return;
    }
    const token = this.buildToken;
    this.loadingMore.set(true);
    try {
      const before = this.pool().length;
      const ranked = await this.fetchPage(++this.pageNo);
      if (token !== this.buildToken) return;
      if (ranked.length) {
        this.pool.set([...this.pool(), ...ranked].sort((a, b) => b.score - a.score));
        this.shown.update((n) => n + PAGE_SIZE);
      } else if (this.pool().length === before) {
        this.pageNo--;
      }
    } catch (err) {
      this.error.set((err as Error).message || 'Не удалось загрузить ещё');
    } finally {
      this.loadingMore.set(false);
    }
  }
}
