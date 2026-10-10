import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { SettingsService } from './core/settings.service';
import { beginScrollReset, isScrollResetActive } from './core/scroll-reset';
import type { Category, MediaSummary } from './core/models';
import { installStyledSelects } from './core/styled-select';
import { NavIconComponent } from './shared/nav-icon.component';
import { PosterPhComponent } from './shared/poster-ph.component';

const DENSITY_MAP: Record<string, string> = {
  compact: '120px',
  normal: '160px',
  large: '210px',
};

type AudioCtor = typeof AudioContext;

function createAudio(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
}

/**
 * Звуки включения/выключения — «типа трейлерного ударного» референса
 * (zvukipro, измерен: 4 с, ровный саб 55 Гц без спада частоты, ~90% энергии
 * ниже 140 Гц, удар с пика в первые 50 мс, шумовой хвост с плато ~0.04
 * до ~1.7 с). Без «вдоха», мелодии и звонков — только удар и хвост.
 */

/** Шумовой слой: мгновенная атака, экспоненциальный спад; mid>0 задаёт
 *  уровень «плато» на 80% длительности — так набран хвост-реверберация. */
function noiseHit(
  ctx: AudioContext,
  start: number,
  dur: number,
  peak: number,
  lpFreq: number,
  mid = 0,
  attack = 0.004,
): void {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * (dur + 0.1)));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lpFreq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.002), start + attack);
  if (mid > 0) {
    g.gain.exponentialRampToValueAtTime(Math.max(mid, 0.002), start + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0006, start + dur);
  } else {
    g.gain.exponentialRampToValueAtTime(0.0006, start + dur);
  }
  src.connect(lp);
  lp.connect(g);
  g.connect(ctx.destination);
  src.start(start);
  src.stop(start + dur + 0.1);
}

/** Саб-слой: синус (в референсе — ровные 55 Гц, без дропа) с «ударным»
 *  профилем: первый 0.3 с спад медленнее, дальше — быстрый уход в тишину.
 *  attack — сколько секунд набирается пик: малое даёт резкий удар, большее
 *  мягко разворачивает дорожку. */
function subHit(
  ctx: AudioContext,
  start: number,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
  stage: { t: number; g: number },
  attack = 0.006,
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, start);
  osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.002), start + attack);
  // ступень спада обязана начаться строго после атаки: при attack === stage.t
  // две экспоненты накладываются в одну точку, кривая рвётся и в пике
  // слышится хрип (мгновенный скачок громкости)
  const stageEnd = start + Math.max(stage.t, attack + 0.02);
  const end = start + Math.max(dur, stageEnd - start + 0.05);
  g.gain.exponentialRampToValueAtTime(Math.max(stage.g, 0.002), stageEnd);
  g.gain.exponentialRampToValueAtTime(0.0006, end);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.1);
}

interface Boom {
  f0: number;
  f1: number;
  subDur: number;
  subPeak: number;
  subStage: { t: number; g: number };
  clickLp: number;
  clickPeak: number;
  tailLp: number;
  tailPeak: number;
  tailMid: number;
  tailDur: number;
  /** Атака саба: во сколько секунд достигается пик. Мало (<0.1) — резкий
   *  «ударный» клик; больше (0.3+) — мягкий разгон, как растянутая дорожка. */
  subAttack: number;
  /** Атака щелчка: растягивает вспышку атаки (0.004 = мгновенный клик). */
  clickAttack: number;
}

/** Полный удар: саб + щелчок + длинный хвост с плато + отражение на ~0.45 с.
 *  Параметры атаки смягчают переход — звук не «щёлкает», а разворачивается. */
function boom(ctx: AudioContext, start: number, p: Boom): void {
  subHit(ctx, start, p.f0, p.f1, p.subDur, p.subPeak, p.subStage, p.subAttack);
  if (p.clickPeak > 0) {
    noiseHit(ctx, start, Math.max(0.3, p.clickAttack * 3), p.clickPeak, p.clickLp, 0, p.clickAttack);
  }
  noiseHit(ctx, start, p.tailDur, p.tailPeak, p.tailLp, p.tailMid); // хвост
  // отражение: мягкая атака (~0.08 с), чтобы посреди хвоста не было щелчка
  noiseHit(ctx, start + 0.45, 0.7, p.tailPeak * 0.45, p.tailLp * 1.3, p.tailMid * 0.4, 0.08);
}

/** Startup impact (~2.9s): 55 Hz swell with a long plateau tail.
 *  Атака растянута (~0.3 с набора) и щелчок почти убран — звук не «ударяет»,
 *  а мягко разворачивается, как растянутая дорожка. */
function playGreeting(): void {
  try {
    const ctx = createAudio();
    if (!ctx) return;
    boom(ctx, ctx.currentTime + 0.01, {
      f0: 55,
      f1: 55,
      subDur: 0.95,
      subPeak: 0.46,
      subStage: { t: 0.5, g: 0.15 },
      clickLp: 900,
      clickPeak: 0.06,
      tailLp: 1200,
      tailPeak: 0.052,
      tailMid: 0.028,
      tailDur: 2.1,
      subAttack: 0.26,
      clickAttack: 0.12,
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 3200);
  } catch {
    // audio is cosmetic — never block startup
  }
}

/** Shutdown impact (~3.4s): the same swell, a bit lower and darker, fading out. */
function playFarewell(): void {
  try {
    const ctx = createAudio();
    if (!ctx) return;
    boom(ctx, ctx.currentTime + 0.01, {
      f0: 46,
      f1: 46,
      subDur: 1.1,
      subPeak: 0.4,
      subStage: { t: 0.56, g: 0.13 },
      clickLp: 700,
      clickPeak: 0.045,
      tailLp: 900,
      tailPeak: 0.046,
      tailMid: 0.025,
      tailDur: 2.3,
      subAttack: 0.3,
      clickAttack: 0.14,
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 3600);
  } catch {
    // audio is cosmetic — never block shutdown
  }
}

const HIDDEN_MENU_IDS = new Set(['cartoons', 'anime']);

/**
 * Animated wheel scrolling: accumulates wheel deltas into a target and eases
 * towards it, replacing the browser's notch-by-notch jumps.
 */
let lastWheelTs = 0;
/** Cancels the wheel animation so programmatic scrolls are not fought over. */
let stopSmoothWheel: (() => void) | undefined;

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

function installSmoothWheel(): void {
  let target = window.scrollY;
  let raf = 0;
  let lastStepTs = 0;
  let lastY = window.scrollY;
  let stall = 0;
  const maxY = (): number =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const finish = (): void => {
    raf = 0;
    lastStepTs = 0;
    stall = 0;
  };
  const step = (): void => {
    const now = performance.now();
    const dt = lastStepTs ? Math.min(now - lastStepTs, 120) : 16.7;
    lastStepTs = now;
    const current = window.scrollY;
    // content shrinks all the time (route change, images); an unreachable
    // target would keep this loop alive forever and it would cancel every
    // programmatic smooth scroll — the «Наверх» button and navigation reset
    target = Math.min(maxY(), Math.max(0, target));
    const diff = target - current;
    if (Math.abs(diff) < 0.6) {
      window.scrollTo({ top: target, behavior: 'instant' });
      finish();
      return;
    }
    // the viewport refuses to move (scroll ceiling reached) — stop instead of
    // spinning; a couple of residual pixels are invisible
    if (Math.abs(current - lastY) < 0.4) {
      stall++;
      if (stall > 10) {
        target = current;
        finish();
        return;
      }
    } else {
      stall = 0;
    }
    lastY = current;
    // behavior must be 'instant': html{scroll-behavior:smooth} would restart a
    // ~500ms CSS animation on every frame and the page would barely move.
    // Framerate-independent ease (same feel at 60/120 Hz) with a speed cap:
    // a large backlog would otherwise jump ~18% of the gap in a single frame.
    const k = 1 - Math.pow(1 - 0.1, dt / 16.667);
    const cap = 42 * (dt / 16.667);
    let delta = diff * k;
    if (delta > cap) delta = cap;
    else if (delta < -cap) delta = -cap;
    window.scrollTo({ top: current + delta, behavior: 'instant' });
    raf = requestAnimationFrame(step);
  };
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.defaultPrevented || e.deltaY === 0) return;
      const target0 = e.target as Element | null;
      // let native controls (inputs, selects) keep their own wheel behaviour
      if (
        target0 &&
        typeof target0.closest === 'function' &&
        target0.closest('input, select, textarea')
      ) {
        return;
      }
      e.preventDefault();
      lastWheelTs = Date.now();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      target = Math.min(maxY(), Math.max(0, target + e.deltaY * unit));
      if (!raf) {
        lastY = window.scrollY;
        stall = 0;
        raf = requestAnimationFrame(step);
      }
    },
    { passive: false },
  );
  // keyboard scrolling counts as deliberate too — the post-navigation guard
  // must not yank the page back to the top while the user pages through it
  window.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) lastWheelTs = Date.now();
  });
  // external scrolls (navigation, find-in-page) re-anchor the target
  window.addEventListener('scroll', () => {
    if (!raf) target = window.scrollY;
  });
  stopSmoothWheel = () => {
    if (raf) cancelAnimationFrame(raf);
    finish();
    target = window.scrollY;
    lastY = window.scrollY;
  };
}

/**
 * Reset scroll after a route change. Runs directly on NavigationEnd (a rAF
 * wrapper can be throttled in occluded windows and the reset then never
 * happens); delayed snaps guarantee the final position even if the smooth
 * animation was interrupted — unless the user has scrolled in the meantime.
 */
function resetScrollOnNavigation(): void {
  const token = beginScrollReset();
  const navTs = Date.now();
  const w = window as unknown as DiagLog;
  (w.__scrollLog ??= []).push({ t: Date.now(), y: Math.round(window.scrollY), nav: 1 });
  // a wheel animation still in flight would drag the page back to the old
  // position and cancel this reset (the post-«назад» scroll bug)
  stopSmoothWheel?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // Some browser-internal action keeps jumping the page back down; poll for a
  // few seconds and snap to the top whenever that happens.
  const startedAt = Date.now();
  const poll = setInterval(() => {
    if (!isScrollResetActive(token)) {
      clearInterval(poll);
      return;
    }
    if (Date.now() - startedAt > 3600) {
      clearInterval(poll);
      return;
    }
    if (Date.now() - startedAt < 1200) return; // let the smooth scroll finish
    if (lastWheelTs > navTs) return; // the user scrolled deliberately
    const y = window.scrollY;
    (w.__scrollLog ??= []).push({ t: Date.now(), y: Math.round(y), guard: 1 });
    if (y > 2) window.scrollTo({ top: 0, behavior: 'instant' });
  }, 200);
}

type DiagLog = {
  __navLog?: unknown[];
  __scrollLog?: { t: number; y: number; nav?: number; guard?: number }[];
};

function installDiagLogs(): void {
  const w = window as unknown as DiagLog;
  w.__navLog = [];
  w.__scrollLog = [];
  window.addEventListener('scroll', () => {
    const log = (w.__scrollLog ??= []);
    log.push({ t: Date.now(), y: Math.round(window.scrollY) });
    if (log.length > 80) log.shift();
  });
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    FormsModule,
    NavIconComponent,
    PosterPhComponent,
  ],
})
export class App {
  private readonly router = inject(Router);
  readonly api = inject(ApiService);
  readonly settings = inject(SettingsService);

  readonly categories = signal<Category[]>([
    { id: 'home', title: 'Главная' },
    { id: 'new', title: 'Новинки' },
    { id: 'films', title: 'Фильмы' },
    { id: 'serials', title: 'Сериалы' },
  ]);

  readonly letters = ['F', 'I', 'L', 'M', 'B', 'O', 'X'];

  query = '';

  readonly suggestions = signal<MediaSummary[]>([]);
  readonly sugOpen = signal(false);
  readonly sugIndex = signal(-1);

  private sourceIds: string[] = [];
  private sugTimer: ReturnType<typeof setTimeout> | undefined;
  private sugToken = 0;

  settingsActive = false;
  private lastNonSettingsUrl = '/';

  readonly showToTop = signal(false);

  readonly splash = signal<'show' | 'closing' | 'exiting' | 'gone'>('show');

  /**
   * Отдельное PiP-окно: обвязка приложения (шапка, футер, «наверх»)
   * в нём не рендерится вовсе — только страница плеера.
   */
  readonly isPip = signal(false);

  readonly maximized = signal(false);

  constructor() {
    // отдельное PiP-окно: только сцена плеера — без сплэша, приветствия и обвязки
    let pipWindow = false;
    try {
      pipWindow = window.location.hash.includes('pip=1');
    } catch {
      // no-op
    }
    if (pipWindow) {
      this.isPip.set(true);
      document.documentElement.classList.add('pip-window');
      document.body.classList.add('pip-window');
      this.splash.set('gone');
    } else {
      // startup splash: pause the header entrance animations while it covers
      // the page, so they play exactly as the splash lifts
      document.documentElement.classList.add('splash-active');
      const splashTimers: Array<ReturnType<typeof setTimeout>> = [
        setTimeout(() => this.splash.set('closing'), 2100),
        setTimeout(() => {
          this.splash.set('gone');
          document.documentElement.classList.remove('splash-active');
        }, 2750),
      ];

      playGreeting();
      this.api.onFarewell(() => {
        playFarewell();
        // exit splash: hold the logo on screen until main destroys the window
        // (no fade-out) — cancel the startup timers so they cannot wipe it
        splashTimers.forEach(clearTimeout);
        document.documentElement.classList.remove('splash-active');
        this.splash.set('exiting');
      });
    }
    this.api.onWindowMaximized((max) => this.maximized.set(max));
    void this.api
      .windowIsMaximized()
      .then((max) => this.maximized.set(max))
      .catch(() => undefined);
    installSmoothWheel();
    installDiagLogs();
    installStyledSelects();
    window.addEventListener('scroll', () => this.showToTop.set(window.scrollY > 600), {
      passive: true,
    });
    // hash navigations are same-document — browser scroll restoration could
    // put an old position back after our own reset
    try {
      history.scrollRestoration = 'manual';
    } catch {
      // non-critical
    }

    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      resetScrollOnNavigation();
      this.syncHeaderHeight();
      const w = window as unknown as DiagLog;
      (w.__navLog ??= []).push({ t: Date.now(), url: event.urlAfterRedirects });
      if ((w.__navLog?.length ?? 0) > 20) w.__navLog!.shift();
      const path = this.router.url.split('?')[0];
      this.settingsActive = path === '/settings';
      if (!this.settingsActive) this.lastNonSettingsUrl = this.router.url;
      // на странице плеера зарезервированная полоска прокрутки справа
      // видна даже возле полноэкранной сцены — убираем её
      document.documentElement.classList.toggle('route-player', path.startsWith('/watch'));
      // PiP-окно живёт только на странице плеера: любой другой маршрут —
      // значит его увело на приложение, а не на сцену — закрываем окно
      if (this.isPip() && !path.startsWith('/watch')) this.api.closePipWindow();
    });
    window.addEventListener('resize', () => this.syncHeaderHeight());
    queueMicrotask(() => this.syncHeaderHeight());

    if (this.api.isElectron) {
      void this.refreshCategories();
      // папка локальных фильмов задана/сменена или источник «Локальный»
      // выключен в настройках — чип «Локальные» должен появиться (или
      // исчезнуть) без перезапуска
      let lastKey = this.categoriesKey();
      effect(() => {
        const key = this.categoriesKey();
        if (key === lastKey) return;
        lastKey = key;
        // state:write уезжает в main асинхронно — даём стейту доехать
        setTimeout(() => void this.refreshCategories(), 350);
      });
    }

    effect(() => {
      const density = this.settings.settings().density;
      document.documentElement.style.setProperty('--card-min', DENSITY_MAP[density] ?? '160px');
    });

    // стартовая вкладка — только в обычном окне; PiP остаётся на плеере
    if (!this.isPip()) this.applyHomeTab();
  }

  /** Папка локальных видео + выключенные источники — от этого зависят разделы. */
  private categoriesKey(): string {
    const s = this.settings.settings();
    return `${s.localVideosPath}|${[...s.disabledSources].sort().join(',')}`;
  }

  /** Разделы шапки/чипсов: обновляются, когда появляется «локальный» раздел. */
  private async refreshCategories(): Promise<void> {
    try {
      const sources = await this.api.listSources();
      this.sourceIds = sources.map((s) => s.id);
      // разделы выключенных источников не показываем (как и в фильтрации
      // запросов); «отключить все» = использовать все, как в подсказке
      const disabled = new Set(this.settings.get().disabledSources);
      const active = sources.filter((s) => !disabled.has(s.id));
      const usable = active.length ? active : sources;
      const cats = new Map<string, Category>();
      for (const source of usable) {
        for (const cat of source.categories) {
          if (HIDDEN_MENU_IDS.has(cat.id)) continue;
          if (!cats.has(cat.id)) cats.set(cat.id, cat);
        }
      }
      if (cats.size) this.categories.set([...cats.values()]);
    } catch {
      // список источников недоступен — оставляем базовые разделы
    }
  }

  /** Header height as a CSS var — sticky elements (filters) align under it. */
  private syncHeaderHeight(): void {
    const header = document.querySelector('.topbar');
    if (!header) return;
    const height = Math.round(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--header-h', `${height}px`);
  }

  private applyHomeTab(): void {
    const home = this.settings.get().homeTab;
    if (!home || home === 'home') return;
    queueMicrotask(() => {
      if (this.router.url !== '/') return;
      const target =
        home === 'favorites' ? '/favorites' : home === 'later' ? '/later' : `/category/${home}`;
      void this.router.navigateByUrl(target);
    });
  }

  search(): void {
    const q = this.query.trim();
    this.closeSuggestions();
    if (!q) return;
    void this.router.navigate(['/search'], { queryParams: { q } });
  }

  scrollTop(): void {
    stopSmoothWheel?.();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  toggleSettings(): void {
    if (this.settingsActive) {
      const target = this.lastNonSettingsUrl || '/';
      void this.router.navigateByUrl(target === '/settings' ? '/' : target);
    } else {
      void this.router.navigate(['/settings']);
    }
  }

  minimizeWindow(): void {
    this.api.windowMinimize();
  }

  toggleMaximizeWindow(): void {
    this.api.windowToggleMaximize();
  }

  closeWindow(): void {
    this.api.windowClose();
  }

  onQueryChange(value: string): void {
    this.query = value;
    clearTimeout(this.sugTimer);
    const q = value.trim();
    if (q.length < 2) {
      this.closeSuggestions();
      return;
    }
    this.sugTimer = setTimeout(() => void this.fetchSuggestions(q), 350);
  }

  private async fetchSuggestions(q: string): Promise<void> {
    const token = ++this.sugToken;
    try {
      const items = await this.api.suggest(q, this.activeSuggestIds());
      if (token !== this.sugToken) return;
      this.suggestions.set(items);
      this.sugIndex.set(-1);
      this.sugOpen.set(items.length > 0);
    } catch {
      if (token === this.sugToken) this.closeSuggestions();
    }
  }

  private activeSuggestIds(): string[] | undefined {
    const disabled = new Set(this.settings.get().disabledSources);
    const active = this.sourceIds.filter((id) => !disabled.has(id));
    return active.length ? this.settings.orderedSourceIds(active) : undefined;
  }

  onSugKeydown(event: KeyboardEvent): void {
    if (!this.sugOpen()) return;
    const items = this.suggestions();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.sugIndex.update((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.sugIndex.update((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter' && this.sugIndex() >= 0) {
      event.preventDefault();
      const item = items[this.sugIndex()];
      if (item) this.pickSuggestion(item);
    } else if (event.key === 'Escape') {
      this.closeSuggestions();
    }
  }

  pickSuggestion(item: MediaSummary): void {
    this.closeSuggestions();
    this.query = item.title;
    void this.router.navigate(['/details'], { queryParams: { u: item.url } });
  }

  closeSuggestions(): void {
    clearTimeout(this.sugTimer);
    this.sugToken++;
    this.sugOpen.set(false);
    this.sugIndex.set(-1);
    this.suggestions.set([]);
  }
}
