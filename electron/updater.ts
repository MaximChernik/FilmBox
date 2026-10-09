import { app, BrowserWindow, ipcMain } from 'electron';

/**
 * Автообновление установленной (NSIS) версии через electron-updater.
 *
 * Прод. лента: electron-builder генерирует app-update.yml из секции
 * `publish` в package.json (GitHub Releases — поменяйте owner/repo).
 * Portable-сборка не обновляется (так устроен electron-updater) — для
 * portable используйте ручной переустановок файла или NSIS-установщик.
 *
 * В dev-режиме (app.isPackaged === false) обновление не запускается.
 */
export function initAutoUpdater(notify: (text: string) => void): void {
  const load = async () => {
    const mod = await import('electron-updater');
    return mod.autoUpdater;
  };

  ipcMain.handle('app:check-update', async (): Promise<{ status: string; message: string }> => {
    try {
      const autoUpdater = await load();
      if (!app.isPackaged) {
        return { status: 'dev', message: 'Обновления доступны только в установленной сборке.' };
      }
      await autoUpdater.checkForUpdates();
      return { status: 'ok', message: 'Проверка обновлений запущена…' };
    } catch (err) {
      return {
        status: 'error',
        message: `Не удалось проверить: ${String((err as Error)?.message ?? err).slice(0, 180)}`,
      };
    }
  });

  if (!app.isPackaged) return;

  void load().then((autoUpdater) => {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on('update-available', () => {
      notify('Доступна новая версия — загружаю в фоне…');
    });
    autoUpdater.on('error', (err: Error) => {
      console.error('autoUpdater error:', err?.message ?? err);
    });
    autoUpdater.on('update-downloaded', () => {
      notify('Обновление готово — установится при закрытии FilmBox.');
    });

    // Прогресс загрузки шлём в рендерер (полоска обновления в настройках);
    // -1 = отмена/ошибка, 100 = готово к установке
    const sendProgress = (pct: number): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('update:progress', pct);
      }
    };
    autoUpdater.on('download-progress', (p) => sendProgress(Math.round(p.percent)));
    autoUpdater.on('update-cancelled', () => sendProgress(-1));
    autoUpdater.on('error', () => sendProgress(-1));
    autoUpdater.on('update-downloaded', () => sendProgress(100));

    void autoUpdater.checkForUpdates().catch(() => undefined);
  });
}
