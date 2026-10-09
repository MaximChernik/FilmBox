import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const allowedChannels = new Set([
  'sources:list',
  'catalog:list',
  'catalog:search',
  'catalog:suggest',
  'media:details',
  'media:streams',
  'player:frame-rect',
  'player:stage-ctl',
  'app:openExternal',
  'app:version',
  'app:check-update',
  'state:set',
  'state:getSync',
  'app:farewell',
  'window:minimize',
  'window:maximize-toggle',
  'window:close',
  'window:is-maximized',
  'window:maximized',
  'app:pickFolder',
  'app:pip-open',
  'app:pip-close',
  'app:pip-window-closed',
]);

contextBridge.exposeInMainWorld('api', {
  listSources: () => invoke('sources:list'),
  loadCatalog: (req: unknown) => invoke('catalog:list', req),
  search: (req: unknown) => invoke('catalog:search', req),
  suggest: (req: unknown) => invoke('catalog:suggest', req),
  loadDetails: (url: string) => invoke('media:details', url),
  loadStreams: (req: unknown) => invoke('media:streams', req),
  frameRect: (url: string, stageW: number, stageH: number) =>
    invoke('player:frame-rect', { url, stageW, stageH }),
  stageCtl: (
    action: string,
    opts?: {
      volume?: number;
      muted?: boolean;
      time?: number;
      group?: string;
      label?: string;
      series?: boolean;
    },
  ) => invoke('player:stage-ctl', { action, ...opts }),
  openExternal: (url: string) => invoke('app:openExternal', url),
  pickFolder: () => invoke('app:pickFolder') as Promise<string>,
  openPipWindow: (fragment: string) => invoke('app:pip-open', fragment) as Promise<void>,
  closePipWindow: () => ipcRenderer.send('app:pip-close'),
  onPipWindowClosed: (cb: () => void): void => {
    ipcRenderer.on('app:pip-window-closed', () => cb());
  },
  getVersion: () => invoke('app:version'),
  checkUpdate: () => invoke('app:check-update') as Promise<{ status: string; message: string }>,
  stateGetSync: (key: string): string | null => {
    try {
      return ipcRenderer.sendSync('state:getSync', key) as string | null;
    } catch {
      return null;
    }
  },
  stateSet: (key: string, value: string) =>
    ipcRenderer.invoke('state:set', key, value) as Promise<void>,
  onFarewell: (cb: () => void): void => {
    ipcRenderer.on('app:farewell', () => cb());
  },
  windowMinimize: (): void => {
    ipcRenderer.send('window:minimize');
  },
  windowToggleMaximize: (): void => {
    ipcRenderer.send('window:maximize-toggle');
  },
  windowClose: (): void => {
    ipcRenderer.send('window:close');
  },
  windowIsMaximized: () => invoke('window:is-maximized') as Promise<boolean>,
  onWindowMaximized: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('window:maximized', (_e, value) => cb(!!value));
  },
  isAllowedChannel: (channel: string) => allowedChannels.has(channel),
});
