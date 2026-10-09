import { app, ipcMain } from 'electron';

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

    void autoUpdater.checkForUpdates().catch(() => undefined);
  });
}
