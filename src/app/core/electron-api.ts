import type {
  CatalogRequest,
  DiagEntry,
  MediaDetails,
  MediaSummary,
  PagedResult,
  SearchRequest,
  SourceInfo,
  StreamCatalog,
  StreamsRequest,
} from './models';

export interface FrameRect {
  state: 'ok' | 'gate' | 'no-root' | 'too-small';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  sx?: number;
  sy?: number;
  height?: number;
  leftPad?: number;
  topPad?: number;
}

/** State of the <video> inside the (cross-origin) stage frames. */
export interface StageState {
  paused: boolean;
  /** currentTime, seconds */
  t: number;
  /** duration, seconds (0 when unknown) */
  d: number;
  /** конец буфера, сек — сколько контента уже подгружено */
  b?: number;
}

/** Одна группа меню embed-плеера, прочитанная через main. */
export interface EmbedMenuGroup {
  name: string;
  items: { label: string; active: boolean }[];
}

/** Ответ stage-ctl для действий menu/pick. */
export interface StageMenu {
  groups: EmbedMenuGroup[];
}

export type StageCtlResult = StageState | StageMenu;

export interface StageCtlOptions {
  /** applied to every media element of the stage frames */
  volume?: number;
  muted?: boolean;
  /** target position for action === 'seek' */
  time?: number;
  /** action === 'pick': menu group name */
  group?: string;
  /** action === 'pick': item label inside the group */
  label?: string;
  /** the app has its own episode playlist — hide the embed's season/episode UI */
  series?: boolean;
}

export interface ElectronApi {
  listSources(): Promise<SourceInfo[]>;
  loadCatalog(req: CatalogRequest): Promise<PagedResult>;
  search(req: SearchRequest): Promise<PagedResult>;
  suggest(req: { query: string; sourceIds?: string[] }): Promise<MediaSummary[]>;
  loadDetails(url: string): Promise<MediaDetails>;
  loadStreams(req: StreamsRequest): Promise<StreamCatalog>;
  /** Player box of the page embedded in the stage (null if not found). */
  frameRect?(url: string, stageW: number, stageH: number): Promise<FrameRect | null>;
  /**
   * Transport of the (cross-origin) stage frames run from main: pushes
   * volume/mute, hides the embed's own control bars, toggles/seeks playback,
   * returns the current <video> state — or, for 'menu'/'pick', the scraped
   * groups of the embed's settings menu (остров контролов под плеером).
   */
  stageCtl?(
    action: 'state' | 'toggle' | 'seek' | 'menu' | 'pick',
    opts?: StageCtlOptions,
  ): Promise<StageCtlResult | null>;
  openExternal(url: string): Promise<void>;
  /** Нативное окно выбора папки (локальная видеотека). '' — отмена. */
  pickFolder?(): Promise<string>;
  /** Отдельное маленькое всегда-поверх-окна PiP-окно movie-player (для iframe и т.п.) */
  openPipWindow?(fragment: string): Promise<void>;
  closePipWindow?(): void;
  onPipWindowClosed?(cb: () => void): void;
  getVersion(): Promise<string>;
  /** Системное уведомление Windows (слежение за новыми сериями). */
  notify?(text: string): Promise<void>;
  checkUpdate?(): Promise<{ status: string; message: string }>;
  /** Фоновая загрузка обновления: pct — проценты (100 = готово, -1 = отмена/ошибка). */
  onUpdateProgress?(cb: (pct: number) => void): void;
  /** Итоги проверки обновления («последняя версия», «ошибка» и т.п.). */
  onUpdateStatus?(cb: (message: string) => void): void;
  /** Последние сбои источников (кольцевой буфер главного процесса). */
  diagnosticsList?(): Promise<DiagEntry[]>;
  diagnosticsClear?(): Promise<void>;
  /** Sync read from the durable state file (userData/filmbox-state.json). */
  stateGetSync?(key: string): string | null;
  stateSet?(key: string, value: string): Promise<void>;
  /** Fired by main right before the window closes — play the farewell sound. */
  onFarewell?(cb: () => void): void;
  windowMinimize?(): void;
  windowToggleMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onWindowMaximized?(cb: (maximized: boolean) => void): void;
}

declare global {
  interface Window {
    api?: ElectronApi;
  }
}

export {};
