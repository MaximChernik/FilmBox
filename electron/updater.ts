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
      // checkForUpdates резолвится результатом — возвращаем конкретный итог,
      // а не «проверка запущена…» (иначе сообщение висит вечно)
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        return { status: 'none', message: `У вас последняя версия (${app.getVersion()}).` };
      }
      return { status: 'ok', message: 'Новая версия найдена — загружаю в фоне…' };
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

    // Итоги проверки тоже шлём в рендерер — сообщение в настройках
    // обновляется и не висит «Проверка запущена…» вечно
    const sendStatus = (message: string): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('update:status', message);
      }
    };
    autoUpdater.on('checking-for-update', () => sendStatus('Проверяем…'));
    autoUpdater.on('update-not-available', () =>
      sendStatus(`У вас последняя версия (${app.getVersion()}).`),
    );
    autoUpdater.on('update-available', (info: { version?: string }) =>
      sendStatus(`Новая версия ${info?.version ?? ''} — загружаю в фоне…`),
    );
    autoUpdater.on('update-cancelled', () => sendStatus('Загрузка обновления отменена.'));
    autoUpdater.on('update-downloaded', () =>
      sendStatus('Обновление загружено — установится при закрытии FilmBox.'),
    );
    autoUpdater.on('error', () => sendStatus('Не удалось проверить обновления — попробуйте позже.'));

    void autoUpdater.checkForUpdates().catch(() => undefined);
  });
}
