import { app, type IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/;

let filePath: string | null = null;
let cache: Record<string, string> | null = null;

function statePath(): string {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'filmbox-state.json');
  return filePath;
}

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    // strip a possible BOM (e.g. after manual edits) — JSON.parse rejects it
    const raw = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const store: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') store[key] = value;
    }
    cache = store;
  } catch {
    // Unreadable file: keep a backup — the next flush would overwrite it.
    try {
      const target = statePath();
      if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
    } catch {
      // ignore
    }
    cache = {};
  }
  return cache;
}

function flush(): void {
  if (!cache) return;
  try {
    const target = statePath();
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // disk issues are non-fatal — data still lives in memory
  }
}

/** Main-process read of a stored key. */
export function stateReadRaw(key: string): string | null {
  try {
    return typeof key === 'string' && KEY_RE.test(key) ? (load()[key] ?? null) : null;
  } catch {
    return null;
  }
}

/** Main-process write of a stored key (`null` removes it). */
export function stateWriteRaw(key: string, value: string | null): void {
  try {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return;
    const store = load();
    if (typeof value === 'string') store[key] = value;
    else delete store[key];
    flush();
  } catch {
    // ignore — same policy as flush()
  }
}

/**
 * Durable key-value storage for renderer state (settings, favorites, history…).
 * Values are plain strings (localStorage-style); everything is kept in
 * userData/filmbox-state.json so clearing site data never wipes the library.
 */
export function registerStateStore(ipcMain: IpcMain): void {
  // Synchronous read so services can hydrate signals during construction.
  ipcMain.on('state:getSync', (event, key: unknown) => {
    try {
      event.returnValue =
        typeof key === 'string' && KEY_RE.test(key) ? (load()[key] ?? null) : null;
    } catch {
      event.returnValue = null;
    }
  });

  ipcMain.handle('state:set', (_e, key: unknown, value: unknown): void => {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return;
    const store = load();
    if (typeof value === 'string') store[key] = value;
    else if (value === null || value === undefined) delete store[key];
    else return;
    flush();
  });
}
