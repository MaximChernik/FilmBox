export type MediaKind = 'movie' | 'serial' | 'cartoon' | 'anime' | 'unknown';

export interface Category {
  id: string;
  title: string;
}

export interface MediaSummary {
  url: string;
  title: string;
  poster?: string;
  year?: string;
  originalTitle?: string;
  genres?: string[];
  quality?: string;
  ribbon?: string;
  rating?: number;
  /** Kinopoisk rating when the source reports it separately. */
  ratingKp?: number;
  /** IMDb rating when the source reports it separately. */
  ratingImdb?: number;
  votes?: number;
  kind?: MediaKind;
  /** When the source added/updated the page: `YYYY-MM-DD` or `YYYY-MM`. */
  siteDate?: string;
  seasonsCount?: string;
  lastEpisode?: string;
  /** Всего серий в объединённой карточке сериала (не последний номер). */
  episodesCount?: string;
}

export interface PagedResult {
  items: MediaSummary[];
  page: number;
  hasMore: boolean;
}

export interface PlayerTab {
  label: string;
  url: string;
  kind: 'embed' | 'trailer' | 'unknown';
}

export interface MediaDetails extends MediaSummary {
  description?: string;
  country?: string;
  director?: string;
  cast?: string;
  players: PlayerTab[];
  sourceId: string;
}

export interface Stream {
  type: 'hls' | 'dash' | 'mp4' | 'iframe';
  url: string;
  label: string;
}

export interface Subtitle {
  name: string;
  url: string;
}

export interface Episode {
  season: number;
  episode: string;
  label: string;
  duration?: number;
  streams: Stream[];
  subtitles: Subtitle[];
  /** Display names of HLS audio tracks; index aligns with hls.audioTrack. */
  audioNames?: string[];
}

export interface StreamCatalog {
  sourceId: string;
  tabLabel: string;
  episodes: Episode[];
  fallbackEmbedUrl?: string;
}

/** Player box on an embedded media page (page coordinates) — see player:frame-rect. */
export interface FrameRect {
  state: 'ok' | 'gate' | 'no-root' | 'too-small';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** scroll position the frame was put to while measuring */
  sx?: number;
  sy?: number;
  /** element height + padding that place the player inside the stage */
  height?: number;
  leftPad?: number;
  topPad?: number;
}

/** State of the <video> inside the (cross-origin) stage frames — see player:stage-ctl. */
export interface StageState {
  paused: boolean;
  /** currentTime, seconds */
  t: number;
  /** duration, seconds (0 when unknown) */
  d: number;
  /** конец буфера, сек — сколько контента уже подгружено (0 когда нет) */
  b?: number;
}

/** Одна группа меню embed-плеера («Качество», «Озвучка», …) для острова контролов. */
export interface EmbedMenuGroup {
  name: string;
  items: { label: string; active: boolean }[];
}

/** Ответ player:stage-ctl на действия menu/pick. */
export interface StageMenu {
  groups: EmbedMenuGroup[];
}

export type StageCtlResult = StageState | StageMenu;

export interface SourceInfo {
  id: string;
  name: string;
  categories: Category[];
}

/** Состояние фильтров каталога — уходит в источник для серверной фильтрации. */
export interface CatalogFilterState {
  kind: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  rating: string;
  quality: string;
}

export interface CatalogRequest {
  sourceId: string;
  page: number;
  categoryId?: string;
  /** Фильтры для серверной фильтрации на стороне источника. */
  filters?: CatalogFilterState;
}

export interface SearchRequest {
  sourceId: string;
  query: string;
}

export interface StreamsRequest {
  sourceId: string;
  tabUrl: string;
  tabLabel?: string;
  /** Origin of the media card page; used as Referer for embed hosts that require it. */
  refererUrl?: string;
}
