import {
  Component,
  computed,
  DestroyRef,
  effect,
  HostListener,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import Hls from 'hls.js';
import { ApiService } from '../../core/api.service';
import type { EmbedMenuGroup, StageCtlResult, StageState } from '../../core/electron-api';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../../core/player.service';
import { SettingsService } from '../../core/settings.service';
import { SourceStatsService } from '../../core/source-stats.service';
import type { Episode, MediaDetails, Stream, StreamCatalog, Subtitle } from '../../core/models';
import { SpinnerComponent } from '../../shared/spinner.component';
import { NavHistoryService } from '../../core/nav-history.service';
import { PlayerControlsComponent } from './player-controls.component';

/** Попытки автозапуска embed-плеера после загрузки кадра, мс. */
const AUTOPLAY_DELAYS = [2500, 6000, 10000];

interface AudioTrackOption {
  index: number;
  label: string;
}

interface QualityOption {
  index: number;
  label: string;
}

const EQ_BAND_LABELS = ['100 Гц', '400 Гц', '1 кГц', '3 кГц', '8 кГц'];
const EQ_BAND_FREQUENCIES = [100, 400, 1000, 3000, 8000];
const EQ_PRESETS: Record<string, number[]> = {
  Плоский: [0, 0, 0, 0, 0],
  Бас: [8, 4, 0, 0, 0],
  Вокал: [-2, 0, 6, 4, 0],
  Рок: [5, 3, -1, 3, 5],
  Кино: [6, 3, 0, 2, 5],
  Наушники: [4, 1, -1, 2, 4],
};

/** Leading number of an episode label («3 серия» → 3); non-numeric → 0. */
function episodeNumber(label: string): number {
  const n = parseInt(String(label).replace(/^\D+/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

@Component({
  templateUrl: './player.component.html',
  styleUrl: './player.component.scss',
  imports: [SpinnerComponent, PlayerControlsComponent],
})
export class PlayerComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private readonly library = inject(LibraryService);
  private readonly playerService = inject(PlayerService);
  readonly settings = inject(SettingsService);
  private readonly srcStats = inject(SourceStatsService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  private readonly queryParam = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly stageEl = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly frameEl = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  readonly details = signal<MediaDetails | null>(null);
  readonly catalog = signal<StreamCatalog | null>(null);
  readonly activeEpisode = signal<Episode | null>(null);
  readonly activeSeason = signal(1);
  readonly subtitleIndex = signal(-1);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly iframeUrl = signal<SafeResourceUrl | null>(null);
  readonly audioTracks = signal<AudioTrackOption[]>([]);
  readonly activeAudioTrack = signal(-1);
  readonly qualityLevels = signal<QualityOption[]>([]);
  /** -1 = auto (hls.js abr) */
  readonly activeQuality = signal(-1);
  readonly eqOpen = signal(false);
  /** transport bar: whether the stage currently plays */
  readonly playing = signal(true);
  /** transport bar: playback position, seconds */
  readonly curTime = signal(0);
  /** transport bar: конец буфера, сек — сколько контента уже подгружено */
  readonly bufferedTime = signal(0);
  /** наведение на полоску: pct — позиция курсора 0..100, x — px для подсказки */
  readonly seekHover = signal<{ pct: number; x: number } | null>(null);
  /** transport bar: duration, seconds (0 when unknown) */
  readonly duration = signal(0);
  /** fullscreen: hide the transport while the mouse stays idle / off the stage */
  readonly controlsHidden = signal(false);
  /** «Театр»: крупная сцена, скрыты шапка и хоткеи, управление остаётся */
  readonly theater = signal(false);
  /** идёт ли сейчас вывод в picture-in-picture */
  readonly pipActive = signal(false);
  /**
   * В сцене сейчас нативный `<video>` (null — источник ещё не выбран).
   * «Картинка в картинка» даётся только такому плееру: iframe-плееры в
   * отдельное окно не выводим — там они не воспроизводятся.
   */
  readonly stageNative = signal<boolean | null>(null);
  /** PiP: отдельное OS-окно со сценой нативного плеера */
  readonly pipAvailable = computed(() => {
    if (this.isPip()) return false;
    if (this.stageNative() !== true || this.iframeUrl()) return false;
    return typeof (window as any).api?.openPipWindow === 'function';
  });

  /** открыто ли это окно по маршруту `/watch?...&pip=1` (окно PiP). */
  readonly isPip = computed(() => (this.queryParam()?.get('pip') ?? '') === '1');
  /** группы меню embed-плеера (качество/озвучка) для острова контролов */
  readonly embedGroups = signal<EmbedMenuGroup[]>([]);

  readonly eqEnabled = computed(() => this.settings.settings().eqEnabled);
  readonly eqGains = computed(() => this.settings.settings().eqGains);
  readonly volPct = computed(() => Math.round(this.settings.settings().volume * 100));
  readonly muted = computed(() => this.settings.settings().muted);
  /** seek slider position, 0..1000 */
  readonly seekPct = computed(() => {
    const d = this.duration();
    return d > 0 ? Math.min(1000, Math.round((this.curTime() / d) * 1000)) : 0;
  });
  /** позиция подгруженного куска на полоске, 0..1000 */
  readonly bufferedPct = computed(() => {
    const d = this.duration();
    return d > 0 ? Math.min(1000, Math.round((this.bufferedTime() / d) * 1000)) : 0;
  });
  /** время перемотки под курсором — подсказка над полоской */
  readonly seekTip = computed(() => {
    const h = this.seekHover();
    const d = this.duration();
    if (!h || d <= 0) return null;
    return { x: h.x, time: (h.pct / 100) * d };
  });
  readonly eqBandLabels = EQ_BAND_LABELS;
  readonly eqPresetNames = Object.keys(EQ_PRESETS);

  readonly episodes = computed(() => {
    const list = this.catalog()?.episodes ?? [];
    return [...list].sort(
      (a, b) => a.season - b.season || episodeNumber(a.episode) - episodeNumber(b.episode),
    );
  });
  readonly seasons = computed(() =>
    [...new Set(this.episodes().map((e) => e.season))].sort((a, b) => a - b),
  );
  readonly episodesInSeason = computed(() =>
    this.episodes().filter((e) => e.season === this.activeSeason()),
  );
  readonly subtitles = computed<Subtitle[]>(() => this.activeEpisode()?.subtitles ?? []);
  readonly subtitleOptions = computed(() =>
    this.subtitles().map((s, i) => ({ index: i, label: s.name })),
  );
  readonly episodeOptions = computed(() =>
    this.episodesInSeason().map((e) => ({ episode: e.episode, label: e.label })),
  );
  readonly embedLastPick = computed(() => {
    const map = new Map<string, string>();
    for (const group of this.embedGroups()) {
      const active = group.items.find((i) => i.active);
      if (active) map.set(group.name, active.label);
    }
    return map;
  });
  readonly hasControls = computed(
    () =>
      this.qualityLevels().length > 0 ||
      this.audioTracks().length > 0 ||
      this.subtitleOptions().length > 0 ||
      this.embedGroups().length > 0 ||
      this.seasons().length > 1 ||
      this.episodeOptions().length > 1,
  );

  private hls: Hls | null = null;
  private lastKey = '';
  private loadedTab: string | null = null;
  /** raw url of the iframe currently in the stage (iframeUrl keeps only the trusted handle) */
  private iframeRaw = '';
  /** episode the current <video> belongs to (activeEpisode may already be the next one) */
  private mountedEpisode: Episode | null = null;
  private lastTimeSave = 0;
  /** Последний ответ stage-ctl iframe-сцены — позиция для сохранения при закрытии. */
  private lastStageState: StageState | null = null;
  /** Пауза ли была на прошлом тике опроса — ловим момент постановки на паузу. */
  private stageWasPaused = true;
  /** За точкой iframe уже перемотали — один раз на загрузку кадра. */
  private stageResumed = false;

  private audioCtx: AudioContext | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private eqGraphBuilt = false;

  private hideTimer: number | null = null;

  /** Вкладки плееров, уже пробованные на этой карточке (автопереход при сбое). */
  private readonly triedTabs = new Set<string>();
  /**
   * Исход текущей попытки уже записан в статистику источника. Один исход на
   * попытку: `ok` при первом реальном воспроизведении, `fail` — когда источник
   * исчерпал себя (нет ссылок / кадр мёртв / ошибка потока).
   */
  private statsDone = false;
  /** Тики опроса state подряд, в которых в кадре не нашлось ни одного <video>. */
  private stageDeadTicks = 0;
  /** Последняя активность указателя — пользователь сам пытается запустить плеер. */
  private lastStageActivity = 0;
  /** С мёртвым кадром уже попробовали переключиться — до смены iframe не повторяем. */
  private deadHandled = false;
  private switchHintTimer: number | null = null;

  /** Плеер карточки не отвечает — короткая подсказка над контролами. */
  readonly switchHint = signal<string | null>(null);

  private readonly nav = inject(NavHistoryService);

  /** Any pointer activity: reveal the controls and restart the idle timer. */
  private readonly onPointerActivity = (): void => this.pokeControls();

  /** Mouse moved over the cross-origin iframe — it reports activity via postMessage. */
  private readonly onStageMessage = (e: MessageEvent): void => {
    const data = e.data as { fb?: string } | null;
    if (data && data.fb === 'mm') this.pokeControls();
  };

  private readonly onFullscreenChange = (): void => {
    if (document.fullscreenElement) {
      this.pokeControls();
    } else {
      if (this.hideTimer !== null) {
        window.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      this.controlsHidden.set(false);
    }
  };

  /** Reveal the transport; in fullscreen it hides again after ~2.6s of silence. */
  pokeControls(): void {
    this.lastStageActivity = Date.now();
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.controlsHidden.set(false);
    if (!document.fullscreenElement) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (document.fullscreenElement) this.controlsHidden.set(true);
    }, 2600);
  }

  /** The pointer left the stage — hide immediately while fullscreen. */
  leaveStage(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (document.fullscreenElement) this.controlsHidden.set(true);
  }

  constructor() {
    effect(() => {
      const p = this.queryParam();
      const key = `${p.get('u') ?? ''}|${p.get('t') ?? ''}|${p.get('s') ?? ''}|${p.get('e') ?? ''}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      void this.reload();
    });

    effect((onCleanup) => {
      const video = this.videoEl()?.nativeElement;
      const episode = this.activeEpisode();
      if (!video || !episode) return;
      untracked(() => this.mount(video, episode));
      onCleanup(() => this.unmount(video));
    });

    effect(() => {
      const enabled = this.eqEnabled();
      const gains = this.eqGains();
      this.applyEq(enabled, gains);
    });

    // Rezka only plays through its own media page, which the stage embeds
    // as-is; poll for the player box there and crop the iframe down to it,
    // otherwise the stage shows the whole site around the player.
    effect((onCleanup) => {
      const frame = this.iframeUrl();
      const raw = this.iframeRaw;
      if (!frame || !raw || !/^https:\/\/rezka\.mov\//i.test(raw)) return;
      void this.updateCrop();
      const timer = window.setInterval(() => void this.updateCrop(), 1200);
      const refresh = (): void => void this.updateCrop();
      window.addEventListener('resize', refresh);
      document.addEventListener('fullscreenchange', refresh);
      onCleanup(() => {
        window.clearInterval(timer);
        window.removeEventListener('resize', refresh);
        document.removeEventListener('fullscreenchange', refresh);
        this.resetCrop();
      });
    });

    // The stage iframe is cross-origin: the renderer cannot touch its <video>,
    // so main runs its transport — volume/mute are pushed into every frame and
    // the frames report their state back (the transport bar below the stage).
    // Re-applied on each settings change and every second — the player may
    // (re)create its media element («Смотреть», next episode) at any moment.
    // Пока открыт список селектора острова — тихие тики state пропускаются:
    // их скрипты воруют фокус у списка (см. PlayerService.isIslandBusy).
    effect((onCleanup) => {
      const { volume, muted } = this.settings.settings();
      const series =
        this.episodes().length > 1 ||
        this.embedGroups().some((g) => /сезон|серия|season|episode/i.test(g.name));
      if (!this.iframeUrl()) return;
      if (!this.playerService.isIslandBusy()) {
        void this.api
          .stageCtl('state', { volume, muted, series })
          .then((st) => this.applyStageState(st));
      }
      const timer = window.setInterval(() => void this.stageSync(), 1000);
      onCleanup(() => window.clearInterval(timer));
    });

    // Embed-плеер долго висит чёрным: Alloha держит <video> на паузе до клика —
    // пробуем стартовать сами (как прямые потоки), несколько раз, пока кадр
    // не поднимется. Если <video> в кадре вовсе нет — см. noteDeadStage.
    effect((onCleanup) => {
      const frame = this.iframeUrl();
      if (!frame) return;
      const timers: number[] = [];
      const schedule = (idx: number): void => {
        if (idx >= AUTOPLAY_DELAYS.length) return;
        timers.push(
          window.setTimeout(() => {
            if (this.iframeUrl() !== frame) return;
            void this.tryAutoPlay();
            schedule(idx + 1);
          }, AUTOPLAY_DELAYS[idx]),
        );
      };
      schedule(0);
      onCleanup(() => timers.forEach((t) => window.clearTimeout(t)));
    });

    // Остров контролов: меню embed-плеера (качество/озвучка) читается через
    // main и обновляется по таймеру — плеер пересоздаёт меню по ходу игры
    effect((onCleanup) => {
      if (!this.iframeUrl()) {
        this.playerService.reset();
        this.embedGroups.set([]);
        return;
      }
      this.playerService.startMenuPolling();
      onCleanup(() => this.playerService.stopMenuPolling());
    });

    effect(() => {
      this.embedGroups.set(this.playerService.embedGroups());
    });

    // don't lose position when the window closes or the tab hides
    const flush = (): void => this.flushProgress();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    // fullscreen auto-hide: the window pointer covers the transport/video,
    // the embed iframe reports its own mouse moves via postMessage (ctlScript)
    window.addEventListener('mousemove', this.onPointerActivity);
    window.addEventListener('message', this.onStageMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    // основное окно: когда OS-уровень PiP закрыт — кнопка возвращается
    this.api.onPipWindowClosed(() => {
      if (!this.isPip()) this.pipActive.set(false);
    });
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('mousemove', this.onPointerActivity);
      window.removeEventListener('message', this.onStageMessage);
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
      if (this.switchHintTimer !== null) window.clearTimeout(this.switchHintTimer);
    });
  }

  /** Immediate position save (window close / navigation / tab pause). */
  private flushProgress(): void {
    // iframe-сцена: свежий <video> недоступен — берём последний тик stage-ctl
    if (this.iframeUrl()) {
      if (this.lastStageState) this.saveStageTime(this.lastStageState, true);
      return;
    }
    const video = this.videoEl()?.nativeElement;
    if (video && this.mountedEpisode) this.saveWatchedTime(video, this.mountedEpisode);
  }

  private async reload(): Promise<void> {
    const p = this.queryParam();
    const url = p.get('u');
    const tabUrl = p.get('t');
    if (!url || !tabUrl) {
      this.stageNative.set(null);
      this.error.set('Не указана ссылка на видео');
      return;
    }

    const sameSource = this.details()?.url === url && this.loadedTab === tabUrl;
    if (!sameSource && this.details()?.url !== url) this.triedTabs.clear(); // новая карточка
    this.triedTabs.add(tabUrl);
    this.error.set(null);

    if (!sameSource) {
      this.loading.set(true);
      this.iframeUrl.set(null);
      this.stageNative.set(null);
      this.loadedTab = null;
      this.statsDone = false; // новая попытка — исход посчитаем заново
      try {
        if (this.details()?.url !== url) {
          this.details.set(await this.api.loadDetails(url));
        }
        const details = this.details();
        if (!details) return;
        const catalog = await this.api.loadStreams({
          sourceId: details.sourceId,
          tabUrl,
          tabLabel: p.get('tl') ?? undefined,
          refererUrl: url,
        });
        this.catalog.set(catalog);
        this.loadedTab = tabUrl;
        if (this.settings.get().historyEnabled) {
          this.library.pushHistory(this.library.summary(details));
        }
        if (!catalog.episodes.length) {
          if (catalog.fallbackEmbedUrl) {
            this.useIframe(catalog.fallbackEmbedUrl);
          } else if (!this.tryNextTab()) {
            this.error.set('Источник не вернул ссылок на видео');
            this.noteSourceOutcome('fail');
          }
        }
      } catch (err) {
        if (!this.tryNextTab()) {
          this.error.set((err as Error).message || 'Не удалось загрузить видео');
          this.noteSourceOutcome('fail');
        }
      } finally {
        this.loading.set(false);
      }
    }

    const wantedSeason = Number(p.get('s'));
    const wantedEpisode = p.get('e');
    const list = this.episodes();
    if (!list.length) return;

    let episode =
      Number.isFinite(wantedSeason) && wantedEpisode
        ? list.find((e) => e.season === wantedSeason && e.episode === wantedEpisode)
        : undefined;
    // no explicit episode in the URL — resume where the series was left off
    if (!episode && !wantedEpisode) {
      const progress = this.library.getProgress(url);
      if (progress) {
        episode = list.find((e) => e.season === progress.season && e.episode === progress.episode);
      }
    }
    if (!episode) episode = list[0];

    this.activeEpisode.set(episode);
    this.activeSeason.set(episode.season);
    this.subtitleIndex.set(-1);
    this.saveProgress(episode);
  }

  private saveProgress(episode: Episode): void {
    if (this.episodes().length < 2) return; // single-episode items have no series progress
    const url = this.queryParam().get('u') ?? this.details()?.url;
    if (!url) return;
    this.library.setProgress(
      url,
      episode.season,
      episode.episode,
      undefined,
      undefined,
      this.queryParam().get('t') ?? undefined,
    );
  }

  /** Playback position of the episode the <video> is currently showing. */
  private saveWatchedTime(video: HTMLVideoElement, episode: Episode): void {
    const url = this.queryParam().get('u') ?? this.details()?.url;
    if (!url) return;
    const at = video.currentTime;
    if (!Number.isFinite(at) || at < 3 || video.ended) return;
    // Длительность у части потоков неизвестна (HLS без metadata): раньше
    // из-за этого такой фильм не сохранялся вовсе — теперь пишем 0,
    // точка запомнится, а возобновление применится после metadata.
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (dur && at >= dur - 1) return; // досмотрено до конца — возобновлять нечего
    const tab = this.queryParam().get('t') ?? undefined;
    this.library.setProgress(url, episode.season, episode.episode, at, dur, tab);
  }

  /**
   * Позиция iframe-сцены: кадр кросс-доменный, но main уже читает его
   * <video> через stage-ctl (t/d каждую секунду) — пишем её в прогресс,
   * чтобы и встроенные плееры помнили, на чём остановились.
   */
  private saveStageTime(st: StageState, force = false): void {
    const url = this.queryParam().get('u') ?? this.details()?.url;
    if (!url || !this.iframeUrl()) return;
    const at = st.t;
    if (!Number.isFinite(at) || at < 3) return;
    const dur = Number.isFinite(st.d) && st.d > 0 ? st.d : 0;
    if (dur && at >= dur - 1) return;
    if (!force && Date.now() - this.lastTimeSave < 5000) return;
    this.lastTimeSave = Date.now();
    const ep = this.activeEpisode() ?? this.mountedEpisode;
    const p = this.queryParam();
    const seasonParam = Number(p.get('s'));
    this.library.setProgress(
      url,
      ep?.season ?? (Number.isFinite(seasonParam) && seasonParam > 0 ? seasonParam : 1),
      ep?.episode ?? p.get('e') ?? '1',
      at,
      dur,
      p.get('t') ?? undefined,
    );
  }

  /** Фильм/серия дошли до конца — хранить точку «продолжить» уже не с чем. */
  private finalizeEndedProgress(): void {
    const url = this.queryParam().get('u') ?? this.details()?.url;
    if (!url) return;
    const p = this.library.getProgress(url);
    if (!p) return;
    if (p.duration && p.duration > 0) this.library.markWatched(url);
    else this.library.resetProgress(url); // длительности не было — просто забываем точку
  }

  /** Конец буфера <video> — сколько контента подгружено, сек. */
  private readBuffered(video: HTMLVideoElement): void {
    try {
      const ranges = video.buffered;
      const at = video.currentTime;
      let end = 0;
      for (let i = 0; i < ranges.length; i++) {
        // диапазон, покрывающий позицию, — берём его конец
        if (ranges.start(i) <= at && at <= ranges.end(i)) {
          end = ranges.end(i);
          break;
        }
        // иначе — самый дальний конец из уже начатых до позиции
        if (ranges.start(i) <= at) end = Math.max(end, ranges.end(i));
      }
      this.bufferedTime.set(end);
    } catch {
      // буфер недоступен — полоска просто останется пустой
    }
  }

  /** Seek back to the stored position; a watched-out episode restarts from zero. */
  private applyResume(video: HTMLVideoElement, episode: Episode): void {
    const url = this.queryParam().get('u') ?? this.details()?.url;
    const saved = url ? this.library.getProgress(url) : undefined;
    if (!saved || saved.season !== episode.season || saved.episode !== episode.episode) return;
    const at = saved.time ?? 0;
    if (at < 5) return;
    const duration = video.duration || saved.duration || 0;
    if (duration && at >= duration * 0.95) return;
    try {
      video.currentTime = at;
    } catch {
      // media not seekable yet
    }
  }

  selectSeason(season: number): void {
    this.activeSeason.set(season);
    const first = this.episodesInSeason()[0];
    if (first) this.selectEpisode(first);
  }

  selectEpisode(episode: Episode): void {
    this.iframeUrl.set(null);
    this.stageNative.set(null);
    this.activeEpisode.set(episode);
    this.activeSeason.set(episode.season);
    this.subtitleIndex.set(-1);
    this.saveProgress(episode);
    const p = this.queryParam();
    void this.router.navigate(['/watch'], {
      queryParams: {
        u: p.get('u'),
        t: p.get('t'),
        tl: p.get('tl'),
        s: episode.season,
        e: episode.episode,
      },
      replaceUrl: true,
    });
  }

  private playNext(force = false): void {
    if (!force && !this.settings.get().autoNext) return;
    const current = this.activeEpisode();
    if (!current) return;
    const list = this.episodes();
    const index = list.findIndex(
      (e) => e.season === current.season && e.episode === current.episode,
    );
    const next = index >= 0 ? list[index + 1] : undefined;
    if (next) this.selectEpisode(next);
  }

  private mount(video: HTMLVideoElement, episode: Episode): void {
    this.unmount(video);
    this.resetTracks(video);
    this.mountedEpisode = episode;
    // default to the first Russian subtitle track when the source ships one
    const ru = (episode?.subtitles ?? []).findIndex((s) => /рус|ru/i.test(`${s.name} ${s.url}`));
    if (ru >= 0 && this.subtitleIndex() < 0) {
      this.subtitleIndex.set(ru);
      setTimeout(() => this.applySubtitle(ru, 0), 400);
    }
    this.playing.set(false);
    this.curTime.set(0);
    this.duration.set(0);
    this.bufferedTime.set(0);
    video.onended = () => {
      this.playing.set(false);
      this.finalizeEndedProgress();
      this.playNext();
    };
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) this.duration.set(video.duration);
      this.applyResume(video, episode);
    };
    // save the position at most once per 5s — and once more on unmount
    video.ontimeupdate = () => {
      this.curTime.set(video.currentTime);
      if (Number.isFinite(video.duration) && video.duration > 0) this.duration.set(video.duration);
      this.readBuffered(video);
      if (Date.now() - this.lastTimeSave < 5000) return;
      this.lastTimeSave = Date.now();
      this.saveWatchedTime(video, episode);
    };
    // подгруженный кусок растёт и без сдвига позиции (буферизация на паузе)
    video.onprogress = () => this.readBuffered(video);

    const saved = this.settings.get();
    video.volume = saved.volume;
    video.muted = saved.muted;
    video.onvolumechange = () => {
      this.settings.update({ volume: video.volume, muted: video.muted });
    };
    video.onplay = () => {
      this.playing.set(true);
      this.noteSourceOutcome('ok');
      if (this.eqEnabled() && !this.eqGraphBuilt) this.ensureEqGraph();
      void this.audioCtx?.resume().catch(() => undefined);
    };
    video.onpause = () => {
      this.playing.set(false);
      // пауза — пишем точку сразу, не дожидаясь 5-секундного тика timeupdate
      this.lastTimeSave = Date.now();
      if (this.mountedEpisode) this.saveWatchedTime(video, this.mountedEpisode);
    };

    this.audioTracks.set([]);
    this.activeAudioTrack.set(-1);
    this.qualityLevels.set([]);
    this.activeQuality.set(-1);

    // считаем сцену не-нативной, пока не выбран hls/mp4-поток
    this.stageNative.set(false);
    const stream: Stream | undefined =
      episode.streams.find((s) => s.type === 'hls') ?? episode.streams[0];

    if (!stream) {
      this.error.set('Для этого эпизода нет источников');
      this.noteSourceOutcome('fail');
      return;
    }

    if (stream.type === 'iframe') {
      this.useIframe(stream.url);
      return;
    }

    if (stream.type === 'dash') {
      this.error.set('Источник отдаёт только DASH — открываем плеер источника');
      const fallback = this.catalog()?.fallbackEmbedUrl;
      if (fallback) this.useIframe(fallback);
      return;
    }

    // дальше — только <video> в сцене
    this.stageNative.set(true);

    if (stream.type === 'hls' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          const code = (data.response as { code?: number } | undefined)?.code;
          const fragUrl = (data.frag as { url?: string } | undefined)?.url;
          this.error.set(
            `Ошибка воспроизведения: ${data.details}${code ? ` (HTTP ${code})` : ''}` +
              (fragUrl ? ` [${fragUrl.slice(0, 120)}]` : ''),
          );
          this.noteSourceOutcome('fail');
        }
      });
      const syncAudioTracks = () => this.syncAudioTracks(hls, episode);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        syncAudioTracks();
        this.syncQualityLevels(hls);
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.AUDIO_TRACK_LOADED, syncAudioTracks);
      hls.on(Hls.Events.LEVELS_UPDATED, () => this.syncQualityLevels(hls));
      hls.loadSource(stream.url);
      hls.attachMedia(video);
      this.hls = hls;
      return;
    }

    video.src = stream.url;
    void video.play().catch(() => undefined);
  }

  private syncAudioTracks(hls: Hls, episode: Episode): void {
    const tracks = hls.audioTracks ?? [];
    if (tracks.length < 2) {
      this.audioTracks.set([]);
      this.activeAudioTrack.set(-1);
      return;
    }
    const names = episode.audioNames;
    const options: AudioTrackOption[] = [];
    if (names?.length) {
      for (let i = 0; i < Math.min(names.length, tracks.length); i++) {
        const name = (names[i] ?? '').trim();
        if (!name || name.toLowerCase() === 'delete') continue;
        options.push({ index: i, label: name });
      }
    }
    if (options.length < 2) {
      options.length = 0;
      for (let i = 0; i < tracks.length; i++) {
        options.push({ index: i, label: `Дорожка ${i + 1}` });
      }
    }
    this.audioTracks.set(options);
    this.activeAudioTrack.set(hls.audioTrack);
  }

  onAudioTrackChange(index: number): void {
    this.activeAudioTrack.set(index);
    if (this.hls) this.hls.audioTrack = index;
  }

  private syncQualityLevels(hls: Hls): void {
    const levels = hls.levels ?? [];
    if (levels.length < 2) {
      this.qualityLevels.set([]);
      this.activeQuality.set(-1);
      return;
    }
    const decorated = levels.map((lvl, index) => ({
      index,
      height: lvl.height ?? 0,
      bitrate: lvl.bitrate ?? 0,
    }));
    decorated.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    const heightSeen = new Map<number, number>();
    const options: QualityOption[] = decorated.map((lvl) => {
      const count = heightSeen.get(lvl.height) ?? 0;
      heightSeen.set(lvl.height, count + 1);
      if (lvl.height) {
        return {
          index: lvl.index,
          label: count ? `${lvl.height}p (${lvl.bitrate} кбит)` : `${lvl.height}p`,
        };
      }
      return { index: lvl.index, label: `${Math.round(lvl.bitrate / 1000)} кбит/с` };
    });
    this.qualityLevels.set(options);
    this.activeQuality.set(hls.currentLevel);
  }

  onQualityChange(index: number): void {
    this.activeQuality.set(index);
    if (this.hls) this.hls.currentLevel = index;
  }

  private unmount(video: HTMLVideoElement): void {
    if (this.mountedEpisode) this.saveWatchedTime(video, this.mountedEpisode);
    this.mountedEpisode = null;
    this.lastTimeSave = 0;
    video.onended = null;
    video.onvolumechange = null;
    video.onplay = null;
    video.onpause = null;
    video.ontimeupdate = null;
    video.onloadedmetadata = null;
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // element may be detached
    }
  }

  private resetTracks(video: HTMLVideoElement): void {
    video.querySelectorAll('track').forEach((t) => t.remove());
    const episode = this.activeEpisode();
    episode?.subtitles.forEach((sub) => {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = sub.name;
      track.srclang = 'ru';
      track.src = sub.url;
      video.appendChild(track);
    });
  }

  onSubtitleChange(value: number): void {
    this.subtitleIndex.set(value);
    this.applySubtitle(value, 0);
  }

  private applySubtitle(index: number, attempt: number): void {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    const tracks = video.textTracks;
    if (index >= 0 && index >= tracks.length && attempt < 12) {
      setTimeout(() => this.applySubtitle(index, attempt + 1), 200);
      return;
    }
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === index ? 'showing' : 'disabled';
    }
  }

  toggleEqPanel(): void {
    const open = !this.eqOpen();
    this.eqOpen.set(open);
    // панель открывается под хоткеями — показать её, если она ниже сгиба
    if (open) {
      queueMicrotask(() =>
        document.querySelector('.eq')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      );
    }
  }

  toggleEq(): void {
    const enabled = !this.eqEnabled();
    this.settings.update({ eqEnabled: enabled });
    if (enabled) {
      this.ensureEqGraph();
      void this.audioCtx?.resume().catch(() => undefined);
    }
  }

  applyEqPreset(event: Event): void {
    const name = (event.target as HTMLSelectElement).value;
    const preset = EQ_PRESETS[name];
    if (preset) this.settings.update({ eqGains: [...preset] });
  }

  resetEq(): void {
    this.settings.update({ eqGains: [0, 0, 0, 0, 0] });
  }

  onEqGain(band: number, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const gains = [...this.eqGains()];
    gains[band] = value;
    this.settings.update({ eqGains: gains });
  }

  private ensureEqGraph(): void {
    if (this.eqGraphBuilt) return;
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaElementSource(video);
      let node: AudioNode = source;
      this.eqFilters = EQ_BAND_FREQUENCIES.map((freq, i) => {
        const filter = this.audioCtx!.createBiquadFilter();
        if (i === 0) filter.type = 'lowshelf';
        else if (i === EQ_BAND_FREQUENCIES.length - 1) filter.type = 'highshelf';
        else filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1;
        node.connect(filter);
        node = filter;
        return filter;
      });
      node.connect(this.audioCtx.destination);
      this.eqGraphBuilt = true;
      this.applyEq(this.eqEnabled(), this.eqGains());
    } catch {
      this.eqGraphBuilt = false;
    }
  }

  private applyEq(enabled: boolean, gains: number[]): void {
    if (!this.eqGraphBuilt || !this.audioCtx) return;
    this.eqFilters.forEach((filter, i) => {
      const gain = enabled ? (gains[i] ?? 0) : 0;
      filter.gain.setTargetAtTime(gain, this.audioCtx!.currentTime, 0.02);
    });
  }

  useIframe(url: string): void {
    this.stageNative.set(false);
    this.iframeRaw = url;
    this.iframeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
    // fresh stage — state is unknown until the first poll answers
    this.playing.set(true);
    this.curTime.set(0);
    this.duration.set(0);
    this.bufferedTime.set(0);
    this.embedGroups.set([]);
    this.stageDeadTicks = 0;
    this.deadHandled = false;
    // новый кадр — позиция и перемотка свежего плеера начинаются заново
    this.lastStageState = null;
    this.stageWasPaused = true;
    this.stageResumed = false;
  }

  /** One round-trip to the stage: push volume, optionally act, read the state back. */
  private async stageSync(
    action?: 'toggle' | 'seek',
    time?: number,
  ): Promise<StageCtlResult | null> {
    if (!this.iframeUrl()) return null;
    // фоновый тик: пока фокус на селекторе острова (список открыт), stage не
    // трогаем — его скрипты в iframe перехватывают фокус и закрывают список
    if (!action && this.playerService.isIslandBusy()) return null;
    const { volume, muted } = this.settings.get();
    const series =
      this.episodes().length > 1 ||
      this.embedGroups().some((g) => /сезон|серия|season|episode/i.test(g.name));
    const st = await this.api
      .stageCtl(action ?? 'state', { volume, muted, time, series })
      .catch(() => null);
    this.applyStageState(st);
    return st;
  }

  private applyStageState(st: StageCtlResult | null): void {
    if (!this.iframeUrl()) return;
    if (!st || !('paused' in st)) {
      // в кадре нет ни одного <video> — у части эмбедов оно не поднимается вовсе
      this.noteDeadStage();
      return;
    }
    this.stageDeadTicks = 0;
    this.lastStageState = st;
    // в кадре есть отвечающий <video> — источник реально отдал плеер
    this.noteSourceOutcome('ok');
    const wasPaused = this.stageWasPaused;
    this.stageWasPaused = st.paused;
    this.playing.set(!st.paused);
    this.curTime.set(st.t);
    if (st.d > 0) this.duration.set(st.d);
    if (typeof st.b === 'number') this.bufferedTime.set(st.b);
    // первый тик с известной длительностью — перематываем на сохранённую точку
    if (!this.stageResumed && st.d > 0) {
      this.stageResumed = true;
      this.applyStageResume();
    }
    // позиция: на паузе — сразу, пока играет — не чаще раза в 5 секунд
    if (st.paused && !wasPaused) this.saveStageTime(st, true);
    else if (!st.paused) this.saveStageTime(st);
  }

  /** Первый осмысленный тик кадра — перемотка на сохранённую точку (как у <video>). */
  private applyStageResume(): void {
    const p = this.queryParam();
    const url = p.get('u');
    const saved = url ? this.library.getProgress(url) : undefined;
    if (!saved || (saved.time ?? 0) < 5) return;
    const season = Number(p.get('s'));
    const episode = p.get('e');
    // явно открыт другой сезон/серия — своя точка им не нужна
    if (Number.isFinite(season) && season > 0 && episode) {
      if (saved.season !== season || saved.episode !== episode) return;
    }
    const at = saved.time ?? 0;
    const dur = saved.duration ?? 0;
    if (dur > 0 && at >= dur * 0.95) return; // досмотрено — начинаем заново
    void this.stageSync('seek', at);
  }

  /**
   * Кадр без <video> дольше ~15 секунд — плеер карточки мёртв: уводим на
   * следующий ещё не пробованный, чтобы сбой одного плеера не ломал
   * воспроизведение всей карточки (напр. Turbo вместо рабочего Collaps).
   */
  private noteDeadStage(): void {
    if (this.deadHandled || this.loading() || this.playerService.isIslandBusy()) return;
    this.stageDeadTicks++;
    if (this.stageDeadTicks < 15) return;
    // указатель был в кадре/на панели — пользователь сам пытается запустить
    if (Date.now() - this.lastStageActivity < 6000) {
      this.stageDeadTicks = 0;
      return;
    }
    this.deadHandled = true;
    if (!this.tryNextTab()) {
      this.error.set('Плеер источника не отвечает');
      this.noteSourceOutcome('fail');
    }
  }

  /**
   * Один исход текущей попытки в статистику источника: плеер заработал (`ok`)
   * либо источник исчерпал себя (`fail`). Записываем, только пока открыты те же
   * детали, что и в маршруте, — фоновая дозагрузка не должна засчитываться.
   */
  private noteSourceOutcome(outcome: 'ok' | 'fail'): void {
    if (this.statsDone) return;
    const details = this.details();
    if (!details || details.url !== this.queryParam().get('u')) return;
    this.statsDone = true;
    if (outcome === 'ok') this.srcStats.noteOk(details.sourceId);
    else this.srcStats.noteFail(details.sourceId);
  }

  /**
   * Один из плееров карточки упал — переключаемся на следующий не пробованный.
   * `true` — переход инициирован (вкладка сменилась, пойдёт новый reload).
   */
  private tryNextTab(): boolean {
    const p = this.queryParam();
    const url = p.get('u');
    const details = this.details();
    if (!url || !details || details.url !== url) return false;
    const failed = p.get('tl') ?? 'источник';
    const next = details.players.find(
      (tab) => tab.kind === 'embed' && !this.triedTabs.has(tab.url),
    );
    if (!next) return false;
    const s = p.get('s');
    const e = p.get('e');
    this.showSwitchHint(`Плеер «${failed}» не отвечает — пробую «${next.label}»`);
    void this.router.navigate(['/watch'], {
      queryParams: {
        u: url,
        t: next.url,
        tl: next.label,
        ...(s ? { s } : {}),
        ...(e ? { e } : {}),
      },
    });
    return true;
  }

  private showSwitchHint(text: string): void {
    this.switchHint.set(text);
    if (this.switchHintTimer !== null) window.clearTimeout(this.switchHintTimer);
    this.switchHintTimer = window.setTimeout(() => {
      this.switchHintTimer = null;
      this.switchHint.set(null);
    }, 7000);
  }

  /**
   * Запустить embed-плеер: Alloha и похожие держат <video> на паузе в нуле,
   * пока по нему не кликнут — воспроизводим сами, как прямые потоки.
   */
  private async tryAutoPlay(): Promise<void> {
    if (!this.iframeUrl() || this.playerService.isIslandBusy()) return;
    const st = await this.stageSync();
    if (!st || !('paused' in st)) return; // видео в кадре нет — toggle бессилен
    if (st.paused && st.t === 0) await this.stageSync('toggle');
  }

  /** Переключить пункт меню embed-плеера из острова контролов. */
  async onEmbedPick(group: string, label: string): Promise<void> {
    if (!label) return;
    await this.playerService.pickMenuItem(group, label);
  }

  onSeasonSelect(season: number): void {
    if (Number.isFinite(season)) this.selectSeason(season);
  }

  onEpisodeSelect(episode: string): void {
    const ep = this.episodesInSeason().find((e) => String(e.episode) === episode);
    if (ep) this.selectEpisode(ep);
  }

  /**
   * Measure the player box on the embedded page (via main — the frame is
   * cross-origin): main scrolls the page to the player and reports its box,
   * then the iframe is shifted/clipped so only that box is visible. While
   * the site shows its access check the crop is removed so it can be solved.
   */
  private async updateCrop(): Promise<void> {
    const raw = this.iframeRaw;
    const el = this.frameEl()?.nativeElement;
    const stage = this.stageEl()?.nativeElement;
    if (!raw || !el || !stage) return;
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    if (!stageW || !stageH) return;
    const rect = await this.api.frameRect(raw, stageW, stageH).catch(() => null);
    if (this.iframeRaw !== raw || this.frameEl()?.nativeElement !== el) return;
    if (!rect) return;
    if (rect.state === 'gate') {
      this.resetCrop();
      return;
    }
    if (rect.state !== 'ok' || rect.x == null || rect.y == null || !rect.w || !rect.h) return;
    const sx = rect.sx ?? 0;
    const sy = rect.sy ?? 0;
    const height = rect.height ?? Math.min(stageH, rect.h);
    const leftPad = rect.leftPad ?? Math.max(0, (stageW - rect.w) / 2);
    const topPad = rect.topPad ?? Math.max(0, (stageH - height) / 2);
    const tx = leftPad - (rect.x - sx);
    const ty = topPad - (rect.y - sy);
    el.style.inset = '0 auto auto 0';
    el.style.height = `${Math.round(height)}px`;
    el.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
  }

  private resetCrop(): void {
    const el = this.frameEl()?.nativeElement;
    if (!el) return;
    el.style.inset = '';
    el.style.height = '';
    el.style.transform = '';
  }

  /**
   * Hotkeys: Space/K — play-pause, ←/→ — seek 10s (Shift — 30s), ↑/↓ — volume,
   * M — mute, F — fullscreen, N — next episode.
   */
  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) {
      return;
    }
    // map the physical key on a Russian keyboard to its Latin twin (й→q, ф→a, …)
    const LAYOUT_RU_TO_LATIN: Record<string, string> = {
      й: 'q',
      ц: 'w',
      у: 'e',
      к: 'r',
      е: 't',
      н: 'y',
      г: 'u',
      ш: 'i',
      щ: 'o',
      з: 'p',
      х: '[',
      ъ: ']',
      ф: 'a',
      ы: 's',
      в: 'd',
      а: 'f',
      п: 'g',
      р: 'h',
      о: 'j',
      л: 'k',
      д: 'l',
      ж: ';',
      э: "'",
      я: 'z',
      ч: 'x',
      с: 'c',
      м: 'v',
      и: 'b',
      т: 'n',
      ь: 'm',
      б: ',',
      ю: '.',
    };
    const raw = event.key.toLowerCase();
    const key = LAYOUT_RU_TO_LATIN[raw] ?? raw;

    if (key === 'f') {
      event.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (key === 't') {
      event.preventDefault();
      this.toggleTheater();
      return;
    }
    // an embedded source player handles its own keys — the app's transport
    // takes over play/pause, seek and volume, pushing them into the
    // cross-origin stage frames via main
    if (this.iframeUrl()) {
      if (key === ' ' || key === 'k') {
        event.preventDefault();
        this.togglePlay();
      } else if (key === 'arrowleft' || key === 'arrowright') {
        event.preventDefault();
        const d = this.duration();
        if (d > 0) {
          const step = event.shiftKey ? 30 : 10;
          const delta = key === 'arrowright' ? step : -step;
          const target = Math.max(0, Math.min(d - 0.5, this.curTime() + delta));
          this.curTime.set(target);
          void this.stageSync('seek', target);
        }
      } else if (key === 'arrowup' || key === 'arrowdown') {
        event.preventDefault();
        const s = this.settings.get();
        const delta = key === 'arrowup' ? 0.05 : -0.05;
        this.settings.update({ volume: Math.min(1, Math.max(0, s.volume + delta)) });
        void this.stageSync();
      } else if (key === 'm') {
        event.preventDefault();
        this.settings.update({ muted: !this.settings.get().muted });
        void this.stageSync();
      } else if (key === 'n') {
        event.preventDefault();
        this.playNext(true);
      }
      return;
    }

    const video = this.videoEl()?.nativeElement;
    switch (key) {
      case ' ':
      case 'k':
        if (!video) return;
        event.preventDefault();
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
        break;
      case 'arrowleft':
      case 'arrowright': {
        if (!video) return;
        event.preventDefault();
        const step = event.shiftKey ? 30 : 10;
        const sought = video.currentTime + (key === 'arrowleft' ? -step : step);
        const limit = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
        video.currentTime = Math.max(0, Math.min(limit - 0.5, sought));
        break;
      }
      case 'arrowup':
      case 'arrowdown': {
        if (!video) return;
        event.preventDefault();
        // volume is persisted by the mount() onvolumechange handler
        const delta = key === 'arrowup' ? 0.05 : -0.05;
        video.volume = Math.min(1, Math.max(0, video.volume + delta));
        break;
      }
      case 'm':
        if (!video) return;
        event.preventDefault();
        video.muted = !video.muted;
        break;
      case 'n':
        event.preventDefault();
        this.playNext(true);
        break;
      case 'escape':
        if (this.eqOpen()) {
          event.preventDefault();
          this.eqOpen.set(false);
        }
        break;
    }
  }

  /** Play/pause — works for both the local <video> and the stage frames. */
  togglePlay(): void {
    const video = this.videoEl()?.nativeElement;
    if (video) {
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
      return;
    }
    this.playing.update((v) => !v); // optimistic; the state poll confirms
    void this.stageSync('toggle');
  }

  /** Seek slider of the transport bar (0..1000). */
  onSeekInput(event: Event): void {
    const frac = Number((event.target as HTMLInputElement).value) / 1000;
    if (!Number.isFinite(frac)) return;
    const d = this.duration();
    if (d <= 0) return;
    const target = Math.max(0, Math.min(d - 0.5, frac * d));
    this.curTime.set(target);
    if (this.iframeUrl()) {
      void this.stageSync('seek', target);
      return;
    }
    const video = this.videoEl()?.nativeElement;
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = target;
    }
  }

  /** Наведение на полоску: позиция курсора и время перемотки под ним. */
  onSeekHover(event: PointerEvent): void {
    if (this.duration() <= 0) return;
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    // повторяем геометрию range: thumb ездит между отступами по своей ширине
    const thumb = 12;
    const frac = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left - thumb / 2) / Math.max(1, rect.width - thumb)),
    );
    const half = 30; // полширины подсказки — прижимаем её к краям полоски
    const x = Math.min(Math.max(event.clientX - rect.left, half), rect.width - half);
    this.seekHover.set({ pct: frac * 100, x });
  }

  onSeekLeave(): void {
    this.seekHover.set(null);
  }

  /** Volume slider of the transport bar (0..100). */
  onVolumeInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value) / 100;
    if (!Number.isFinite(value)) return;
    const volume = Math.min(1, Math.max(0, value));
    this.settings.update({ volume, muted: false });
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.volume = volume;
      video.muted = false;
    }
    if (this.iframeUrl()) void this.stageSync(); // push now, don't wait for the tick
  }

  toggleMute(): void {
    const muted = !this.settings.get().muted;
    this.settings.update({ muted });
    const video = this.videoEl()?.nativeElement;
    if (video) video.muted = muted;
    if (this.iframeUrl()) void this.stageSync();
  }

  /** 65 → «1:05», 3725 → «1:02:05». */
  fmtTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  toggleFullscreen(): void {
    const stage = this.stageEl()?.nativeElement;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen?.().catch(() => undefined);
  }

  /** «Театр» — компактный альтернативный режим большой сцены без перехода в fullscreen. */
  toggleTheater(): void {
    this.theater.update((v) => !v);
  }

  /**
   * Picture-in-picture: отдельное OS-окно со сценой нативного плеера.
   * Кнопка показывается только для `<video>` (см. `stageNative`) — iframe-плееры
   * в отдельное окно не выводим.
   */
  togglePip(): void {
    if (this.pipActive()) {
      this.closePipWindow();
    } else {
      void this.openPipWindow();
    }
  }

  /** Закрыть PiP-окно (из него самого — крестиком в drag-плашке). */
  closePipWindow(): void {
    this.api.closePipWindow();
    this.pipActive.set(false);
  }

  /** OS-уровневое PiP-окно (отдельный always-on-top Spellbook). */
  private async openPipWindow(): Promise<void> {
    if (!this.pipAvailable()) return;
    const p = this.queryParam();
    const u = p?.get('u') ?? this.details()?.url;
    const t = p?.get('t');
    if (!u || !t) return;
    const tl = p.get('tl') ?? '';
    let frag = `/watch?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}&tl=${encodeURIComponent(tl)}`;
    if (p.get('s')) frag += `&s=${encodeURIComponent(p.get('s')!)}`;
    if (p.get('e')) frag += `&e=${encodeURIComponent(p.get('e')!)}`;
    frag += '&pip=1';
    // основной игрок ставим на паузу, чтобы звук не сошёлся в два потока
    const video = this.videoEl()?.nativeElement;
    if (video && !video.paused) video.pause();
    this.pipActive.set(true);
    await this.api.openPipWindow(frag);
  }

  backToDetails(): void {
    const url = this.details()?.url ?? this.queryParam().get('u');
    // назад — на реально открытый ранее экран (тот же раздел/фильтры/страница)
    this.nav.back(() => {
      if (url) void this.router.navigate(['/details'], { queryParams: { u: url } });
      else void this.router.navigate(['/']);
    });
  }

  openOnSite(): void {
    const url = this.details()?.url;
    if (url) void this.api.openExternal(url);
  }
}
