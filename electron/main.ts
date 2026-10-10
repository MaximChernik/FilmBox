import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron';
import * as path from 'path';
import { shouldBlockAd } from './adblock';
import { createRegistry, getActiveEmbedReferer } from './registry';
import { USER_AGENT } from './fetcher';
import { initAutoUpdater } from './updater';

const isServe = process.argv.includes('--serve') || process.argv.includes('--dev');
const isSelfTest = process.argv.includes('--selftest');

// Плеер должен стартовать без жеста пользователя: в отдельном PiP-окне (и в
// основной сцене, когда открывали не кликом) Chromium держит <video> на паузе.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function resolveIndexHtml(): string {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'browser', 'index.html'),
    path.join(__dirname, '..', 'dist', 'index.html'),
    path.join(__dirname, '..', 'dist', 'film-agg', 'browser', 'index.html'),
  ];
  for (const candidate of candidates) {
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return candidates[0];
}

function createWindow(): void {
  // Некоторые embed-хосты (stravers, temptcdn) требуют Referer кинопортала,
  // иначе отдают страницу «контент не найден». Подставляем его для iframe-фолбэка.
  const embedRefererHosts = /(^|\.)(stravers\.live|temptcdn\.com)$/i;
  // YouTube отдаёт ошибку 153 (missing referrer), когда iframe загружен из
  // file:// — подставляем origin nocookie-плеера, с которым он и играет.
  const kinescopeHosts = /(^|\.)kinescopecdn\.net$/i;
  const youtubeHosts =
    /(^|\.)(youtube-nocookie\.com|youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    try {
      const hostname = new URL(details.url).hostname;
      if (youtubeHosts.test(hostname)) {
        headers['Referer'] = 'https://www.youtube-nocookie.com/';
      } else if (kinescopeHosts.test(hostname)) {
        // the rezka→kinescope player decides which content it's allowed to
        // show by the page that embedded it; from file:// that is empty, so
        // the embed reports «контент ещё не добавлен»
        headers['Referer'] = 'https://rezka.mov/';
      } else {
        const ref = getActiveEmbedReferer();
        if (ref && embedRefererHosts.test(hostname)) {
          headers['Referer'] = ref;
        }
      }
    } catch {
      // invalid URL - keep headers as-is
    }
    callback({ requestHeaders: headers });
  });

  const win = new BrowserWindow({
    width: 1680,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0f',
    title: 'FilmBox',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Видео-CDN не отдают CORS-заголовки, а приложение — локальное,
      // поэтому отключаем same-origin проверку для загрузки стримов.
      webSecurity: false,
      devTools: isServe,
    },
  });

  win.once('ready-to-show', () => win.show());

  const pushMaxState = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized', win.isMaximized());
    }
  };
  win.on('maximize', pushMaxState);
  win.on('unmaximize', pushMaxState);

  // Заставка с прощальным логотипом: она остаётся на экране до самого
  // закрытия — откладываем destroy чуть дольше её анимации (1.6s).
  // Звук выключения растянутый (~3.4s): даём ему почти догореть, иначе
  // хвост обрезается вместе с окном.
  let farewellSent = false;
  win.on('close', (e) => {
    if (isSelfTest || farewellSent) return;
    farewellSent = true;
    e.preventDefault();
    try {
      win.webContents.send('app:farewell');
    } catch {
      // renderer may already be gone
    }
    setTimeout(() => {
      try {
        win.destroy();
      } catch {
        // already closed
      }
    }, 2600);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`Failed to load ${url}: ${code} ${description}`);
  });

  if (isServe) {
    void win.loadURL('http://localhost:4200');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(resolveIndexHtml());
  }

  if (isSelfTest) {
    win.webContents.on('did-finish-load', () => {
      void (async () => {
        const run = async (script: string, waitMs = 0): Promise<any> => {
          if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
          return win.webContents.executeJavaScript(script, true);
        };
        try {
          await run(`(function () {
            window.__errs = [];
            window.addEventListener('error', function (e) {
              window.__errs.push(String((e.error && e.error.stack) || e.message));
            });
            window.addEventListener('unhandledrejection', function (e) {
              window.__errs.push('rejection: ' + String((e.reason && e.reason.stack) || e.reason));
            });
            return true;
          })()`);
          // Minimal startup check: the app rendered itself and nothing threw.
          const check = await run(
            `(function () {
              return {
                logo: !!document.querySelector('.logo'),
                splashGone: !document.querySelector('.splash'),
                cards: document.querySelectorAll('app-media-card').length,
                hash: location.hash,
                bodyLen: document.body.innerText.length,
                errs: window.__errs,
              };
            })()`,
            7000,
          );
          console.log('SELFTEST_STARTUP ' + JSON.stringify(check));
          const ok =
            !!check &&
            check.logo === true &&
            check.splashGone === true &&
            check.bodyLen > 100 &&
            Array.isArray(check.errs) &&
            check.errs.length === 0;
          console.log(ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL');
          app.exit(ok ? 0 : 1);
        } catch (err) {
          console.log('SELFTEST_ERROR ' + String(err));
          app.exit(1);
        }
      })();
    });
  }
}

app.whenReady().then(() => {
  // Токены сегментов видео-CDN привязаны к UA запроса embed (см. fetcher.ts):
  // рендер должен ходить в сеть с тем же User-Agent, что и main-процесс.
  app.userAgentFallback = USER_AGENT;
  session.defaultSession.setUserAgent(USER_AGENT);

  // Блокировка рекламы в плеерах: VAST/рекламные конфиги/трекеры embed-страниц
  // отменяются на уровне сессии — плеер сразу идёт к контенту.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: shouldBlockAd(details.url) });
  });

  const windowOf = (e: { sender: Electron.WebContents }): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender);

  ipcMain.on('window:minimize', (e) => windowOf(e)?.minimize());
  ipcMain.on('window:maximize-toggle', (e) => {
    const win = windowOf(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (e) => windowOf(e)?.close());
  ipcMain.handle('window:is-maximized', (e) => windowOf(e)?.isMaximized() ?? false);

  ipcMain.handle('app:pickFolder', async (e): Promise<string> => {
    const win = windowOf(e);
    if (!win) return '';
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return res.canceled || !res.filePaths.length ? '' : res.filePaths[0];
  });

  // OS-level mini window «всегда поверх всех» для iframe плееров и т.п.
  let pipWin: BrowserWindow | null = null;
  ipcMain.handle('app:pip-open', async (e, fragment: unknown): Promise<void> => {
    const win = windowOf(e);
    if (!win || typeof fragment !== 'string' || !fragment) return;
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.focus();
      return;
    }
    pipWin = new BrowserWindow({
      width: 560,
      height: 380,
      minWidth: 340,
      minHeight: 260,
      frame: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      // только плеер: окно не садится в таскбар — выглядит как оверлей,
      // а не как второй экземпляр приложения
      skipTaskbar: true,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
      },
    });
    pipWin.once('ready-to-show', () => pipWin?.show());
    pipWin.on('closed', () => {
      pipWin = null;
      try {
        win.webContents.send('app:pip-window-closed');
      } catch {
        // main window gone
      }
    });
    try {
      await pipWin.loadFile(resolveIndexHtml(), { hash: fragment });
    } catch {
      pipWin?.close();
    }
  });

  ipcMain.on('app:pip-close', () => {
    try {
      pipWin?.close();
    } catch {
      // already gone
    }
    pipWin = null;
  });

  createRegistry(ipcMain, shell);
  // windows Notification shows even when the app is minimized/background
  initAutoUpdater((text) => {
    try {
      new Notification({ title: 'FilmBox', body: text }).show();
    } catch {
      // notifications unsupported — ignore
    }
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
