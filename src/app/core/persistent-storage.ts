/**
 * Durable key/value storage for app state (settings, favorites, history…).
 *
 * In Electron the source of truth is userData/filmbox-state.json via IPC —
 * clearing browser localStorage never loses the library. Existing localStorage
 * data is migrated to the file on first read. In a plain browser we fall back
 * to localStorage.
 */

const api = typeof window !== 'undefined' ? window.api : undefined;
const canPersist = !!api?.stateGetSync && !!api?.stateSet;

export function storageGet(key: string): string | null {
  if (canPersist) {
    try {
      const stored = api!.stateGetSync!(key);
      if (stored !== null && stored !== undefined) return stored;
      // migrate legacy localStorage data into the state file
      try {
        const legacy = localStorage.getItem(key);
        if (legacy !== null) {
          void api!.stateSet!(key, legacy);
          return legacy;
        }
      } catch {
        // localStorage unavailable — nothing to migrate
      }
      return null;
    } catch {
      // fall through to localStorage
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  if (canPersist) {
    try {
      void api!.stateSet!(key, value);
      return;
    } catch {
      // fall through to localStorage
    }
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — ignore
  }
}
