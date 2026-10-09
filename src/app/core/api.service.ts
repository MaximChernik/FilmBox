import { Injectable } from '@angular/core';
import type { FrameRect, StageCtlOptions, StageCtlResult } from './electron-api';
import type {
  CatalogRequest,
  MediaDetails,
  MediaSummary,
  PagedResult,
  SearchRequest,
  SourceInfo,
  StreamCatalog,
  StreamsRequest,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly api = typeof window !== 'undefined' ? window.api : undefined;
  private readonly detailsCache = new Map<string, { ts: number; value: MediaDetails }>();
  private readonly streamsCache = new Map<string, { ts: number; value: StreamCatalog }>();
  private static readonly CACHE_TTL = 60_000;

  get isElectron(): boolean {
    return !!this.api;
  }

  private bridge(): NonNullable<typeof window.api> {
    if (!this.api) {
      throw new Error(
        'Нет моста Electron. Запустите приложение через «npm start», а не в браузере.',
      );
    }
    return this.api;
  }

  listSources(): Promise<SourceInfo[]> {
    return this.bridge().listSources();
  }

  loadCatalog(req: CatalogRequest): Promise<PagedResult> {
    return this.bridge().loadCatalog(req);
  }

  search(req: SearchRequest): Promise<PagedResult> {
    return this.bridge().search(req);
  }

  suggest(query: string, sourceIds?: string[]): Promise<MediaSummary[]> {
    if (!this.api?.suggest) return Promise.resolve([]);
    return this.bridge().suggest({ query, sourceIds });
  }

  loadDetails(url: string): Promise<MediaDetails> {
    const hit = this.detailsCache.get(url);
    if (hit && Date.now() - hit.ts < ApiService.CACHE_TTL) return Promise.resolve(hit.value);
    return this.bridge()
      .loadDetails(url)
      .then((value) => (this.detailsCache.set(url, { ts: Date.now(), value }), value));
  }

  loadStreams(req: StreamsRequest): Promise<StreamCatalog> {
    const key = `${req.sourceId}|${req.tabUrl}`;
    const hit = this.streamsCache.get(key);
    if (hit && Date.now() - hit.ts < ApiService.CACHE_TTL) return Promise.resolve(hit.value);
    return this.bridge()
      .loadStreams(req)
      .then((value) => (this.streamsCache.set(key, { ts: Date.now(), value }), value));
  }

  /** Player box of the page embedded in the stage; null in a plain browser. */
  frameRect(url: string, stageW: number, stageH: number): Promise<FrameRect | null> {
    if (!this.api?.frameRect) return Promise.resolve(null);
    return this.api.frameRect(url, stageW, stageH);
  }

  /** Transport of the stage frames (volume, play/pause, seek, state) via main. */
  stageCtl(
    action: 'state' | 'toggle' | 'seek' | 'menu' | 'pick',
    opts?: StageCtlOptions,
  ): Promise<StageCtlResult | null> {
    if (!this.api?.stageCtl) return Promise.resolve(null);
    return this.api.stageCtl(action, opts);
  }

  openExternal(url: string): Promise<void> {
    return this.bridge().openExternal(url);
  }

  /** Нативное окно выбора папки (локальная видеотека). '' — отмена. */
  pickFolder(): Promise<string> {
    const fn = this.api?.pickFolder;
    return fn ? fn.call(this.api) : Promise.resolve('');
  }

  /** OS-уровневое PiP-окно (отдельный always-on-top браузер). */
  openPipWindow(fragment: string): Promise<void> {
    const fn = this.api?.openPipWindow;
    return fn ? fn.call(this.api, fragment) : Promise.resolve();
  }

  closePipWindow(): void {
    this.api?.closePipWindow?.();
  }

  onPipWindowClosed(cb: () => void): void {
    this.api?.onPipWindowClosed?.(cb);
  }

  getVersion(): Promise<string> {
    return this.bridge().getVersion();
  }

  checkUpdate(): Promise<{ status: string; message: string }> {
    if (!this.api?.checkUpdate)
      return Promise.resolve({ status: 'dev', message: 'Недоступно в браузере.' });
    return this.api.checkUpdate();
  }

  onUpdateProgress(cb: (pct: number) => void): void {
    this.api?.onUpdateProgress?.(cb);
  }

  /** Subscribe to the pre-close farewell event (no-op in a plain browser). */
  onFarewell(cb: () => void): void {
    this.api?.onFarewell?.(cb);
  }

  windowMinimize(): void {
    this.api?.windowMinimize?.();
  }

  windowToggleMaximize(): void {
    this.api?.windowToggleMaximize?.();
  }

  windowClose(): void {
    this.api?.windowClose?.();
  }

  windowIsMaximized(): Promise<boolean> {
    return this.api?.windowIsMaximized?.() ?? Promise.resolve(false);
  }

  onWindowMaximized(cb: (maximized: boolean) => void): void {
    this.api?.onWindowMaximized?.(cb);
  }
}
